/**
 * 収支管理 — 純粋関数モジュール (副作用なし)
 *
 * pnl.js から DB/API/Drive に触れないロジックだけを切り出し、
 * ユニットテストで挙動を担保する。
 *
 * このファイルの関数はすべて引数のみで決定論的に動くこと。
 */

/**
 * 数値を安全に整数化する。
 * - 文字列に "¥", ",", スペース等が含まれていても拾う
 * - マイナス記号があっても絶対値を返す(手数料を経費に積むときに符号が逆になるのを防ぐ)
 * - null/undefined/NaN は 0
 */
function toInt(v) {
  const cleaned = String(v == null ? 0 : v).replace(/[^0-9.-]/g, "");
  const n = Math.round(Number(cleaned));
  return isNaN(n) ? 0 : Math.abs(n);
}

/**
 * 表記揺れ吸収用の正規化。
 * - 全半角スペース除去
 * - 装飾記号(｜|・,，。.)を除去
 * - 小文字化
 * 物件名やリスティング名の曖昧一致に使う。
 */
function normLoose(s) {
  return String(s || "")
    .replace(/[\s　]+/g, "")
    .replace(/[｜|・,，。.]/g, "")
    .toLowerCase();
}

/**
 * 清掃スタッフ氏名の正規化。
 * - 法人格・敬称を除去
 * - カッコ書き(英字読み等)を除去
 * - 空白を除去
 */
function normalizeStaffName(raw) {
  if (!raw) return "";
  let v = String(raw);
  v = v.replace(/株式会社|有限会社|合同会社|御中|様|殿/g, "");
  v = v.replace(/[（(][^)）]*[)）]/g, "");
  v = v.replace(/[\s　]+/g, "");
  return v;
}

/**
 * Geminiパース結果から物件を解決する。
 *
 * 解決ロジック:
 * 1. Booking明細 → propertyFacilityId と properties.bookingPropertyId の完全一致
 * 2. Airbnb月次 → listingName を properties.airbnbListingName/airbnbListingAliases と曖昧一致
 * 3. それ以外(清掃請求書等) → propertyName を properties.name と曖昧一致
 * 4. 何も当たらなければ fallbackPropertyId
 *
 * @param {object} parsed Geminiパース結果
 * @param {Array<{id:string,name:string,bookingPropertyId?:string,airbnbListingName?:string,airbnbListingAliases?:string[]}>} properties
 * @param {string|null} fallbackPropertyId
 */
function resolvePropertyForDoc(parsed, properties, fallbackPropertyId) {
  if (!parsed || !Array.isArray(properties)) return fallbackPropertyId || null;

  if (parsed.docKind === "booking_detail" && parsed.booking) {
    const fid = String(parsed.booking.propertyFacilityId || "").trim();
    if (fid) {
      const hit = properties.find((p) => String(p.bookingPropertyId || "").trim() === fid);
      if (hit) return hit.id;
    }
  }

  if (parsed.docKind === "airbnb_monthly" && parsed.airbnb) {
    const ln = normLoose(parsed.airbnb.listingName);
    if (ln) {
      const hit = properties.find((p) => {
        const cands = [p.airbnbListingName, ...(p.airbnbListingAliases || [])].filter(Boolean);
        return cands.some((c) => {
          const cn = normLoose(c);
          return cn && (cn === ln || ln.includes(cn) || cn.includes(ln));
        });
      });
      if (hit) return hit.id;
    }
  }

  const pname = normLoose(parsed.propertyName || (parsed.cleaning && parsed.cleaning.propertyName));
  if (pname) {
    const hit = properties.find((p) => {
      const cn = normLoose(p.name);
      return cn && (cn === pname || pname.includes(cn) || cn.includes(pname));
    });
    if (hit) return hit.id;
  }

  return fallbackPropertyId || null;
}

/**
 * 費目マスタを当月実績に適用する(計算のみ・保存はしない)。
 *
 * - active===false の費目は除外
 * - appliesTo が "all" でも空でもなく、配列で当該物件を含まないなら除外
 * - 当月に値があればそれを使う(手入力/overridden尊重)
 * - 値がない fixed は defaultAmount を自動充当
 * - 値がない manual は 0
 *
 * @returns {{rows:Array, total:number}}
 */
function applyExpenses(data, categories, propertyId) {
  const expenses = (data && data.expenses) || {};
  const rows = [];
  let total = 0;
  if (!Array.isArray(categories)) return { rows, total };

  for (const cat of categories) {
    if (cat.active === false) continue;
    const applies = cat.appliesTo;
    const inScope = !applies || applies === "all" ||
      (Array.isArray(applies) && applies.includes(propertyId));
    if (!inScope) continue;

    const cur = expenses[cat.id];
    let amount;
    if (cur && typeof cur.amount === "number") {
      amount = cur.amount;
    } else if (cat.type === "fixed") {
      amount = toInt(cat.defaultAmount);
    } else {
      amount = 0;
    }
    total += amount;
    rows.push({
      catId: cat.id,
      name: cat.name,
      type: cat.type,
      amount,
      source: cur ? cur.source : cat.type,
      overridden: cur ? !!cur.overridden : false,
      note: cur ? (cur.note || "") : "",
    });
  }
  return { rows, total };
}

/**
 * 月ドキュメントから収支を計算する。
 *
 * 売上 = Airbnb総収入 + Booking総収入
 * OTA手数料 = Airbnbサービス料 + Bookingコミッション + Booking決済手数料
 * 清掃費 = 除外フラグなしの cleaningCosts 合計
 * 利益 = 売上 - OTA手数料 - 清掃費 - 費目合計
 * 利益率 = 利益 / 売上 (小数第一位、売上0なら0)
 */
function computePnl(data, categories) {
  const rev = (data && data.revenue) || {};
  const ab = rev.airbnb || {};
  const bk = rev.booking || {};
  const revenueAirbnb = toInt(ab.grossRevenue);
  const revenueBooking = toInt(bk.grossRevenue);
  const revenueGross = revenueAirbnb + revenueBooking;
  const otaFees = toInt(ab.serviceFee) + toInt(bk.commission) + toInt(bk.paymentFee);
  const cleaningRows = ((data && data.cleaningCosts) || []).filter((c) => !c.excluded);
  const cleaningTotal = cleaningRows.reduce((s, c) => s + toInt(c.amount), 0);
  const exp = applyExpenses(data, categories, data && data.propertyId);
  const profit = revenueGross - otaFees - cleaningTotal - exp.total;
  return {
    revenueAirbnb,
    revenueBooking,
    revenueGross,
    otaFees,
    cleaningTotal,
    expenses: exp.rows,
    expensesTotal: exp.total,
    profit,
    profitRate: revenueGross > 0 ? Math.round((profit / revenueGross) * 1000) / 10 : 0,
  };
}

/**
 * 清掃請求(invoice)から、指定物件に帰属する清掃費を算出する。
 * - 単一物件(or byProperty無し)の請求は total(基本給・交通費等の共通手当込み)を全額計上。
 * - 複数物件をまとめた請求は、当該物件の byProperty.total + 共通手当(基本給等)を shiftCount 比で按分。
 */
function cleaningAmountForProperty(inv, propertyId) {
  const bp = inv && inv.byProperty && typeof inv.byProperty === "object" ? inv.byProperty : null;
  const pids = bp ? Object.keys(bp) : [];
  if (pids.length <= 1) return toInt(inv && inv.total);
  const thisTotal = toInt(bp[propertyId] && bp[propertyId].total);
  const sumProps = pids.reduce((s, k) => s + toInt(bp[k].total), 0);
  const common = Math.max(0, toInt(inv.total) - sumProps); // 基本給・交通費等(物件横断)
  const thisShift = toInt(bp[propertyId] && bp[propertyId].shiftCount);
  const sumShift = pids.reduce((s, k) => s + toInt(bp[k].shiftCount), 0);
  const commonShare = sumShift > 0 ? Math.round(common * thisShift / sumShift) : 0;
  return thisTotal + commonShare;
}

/**
 * クレカ明細(Gemini抽出結果)から特定物件の電気料金だけを絞り込む(pure)。
 *
 * the Terrace はエネパル(収納代行アプラス/スマートビリング経由)がクレカ払いに切替(2026-06分〜)。
 * 一方、明細には別物件/自宅の「ソフトバンクでんき」等も混在するので、
 * ベンダー名/説明文でホワイトリスト方式で絞る。
 *
 * @param {Array<{date?:string,description:string,amount:number,vendor?:string}>} payments Geminiが抽出した電気料金候補
 * @param {{ vendorAllowlist?: RegExp[], vendorDenylist?: RegExp[] }} opts
 * @returns {{items:Array, totalAmount:number}}
 */
function filterElectricPaymentsForProperty(payments, opts = {}) {
  const allow = opts.vendorAllowlist || [/エネパル/, /収納代行アプラス/i, /アプラス/, /スマートビリング/i];
  const deny = opts.vendorDenylist || [/ソフトバンクでんき/, /ソフトバンク電気/, /東京電力/, /関西電力/, /中国電力/, /九州電力/, /北海道電力/];
  const items = [];
  let total = 0;
  for (const p of (payments || [])) {
    const desc = String((p && p.description) || "") + " " + String((p && p.vendor) || "");
    if (deny.some((re) => re.test(desc))) continue;
    if (!allow.some((re) => re.test(desc))) continue;
    const amt = toInt(p && p.amount);
    if (amt <= 0) continue;
    items.push({ ...p, amount: amt });
    total += amt;
  }
  return { items, totalAmount: total };
}

/**
 * ファイル名から経費費目と、その費目を扱う取込ルート(scope)を決定する(pure)。
 *
 * scope:
 *   "receipts"  → import-receipts が担当(店舗レシート・領収書・単発請求書。ごみ/清掃/消耗品/修繕/害虫/広告)
 *   "utilities" → import-utilities が担当(公共料金・通信の月次請求書。光熱/通信/固定電話)
 *   null        → 経費対象外(通帳・出資金/配当・カード明細・契約金など、費目に紐付かないもの)
 *
 * 判定はファイル名内の「(タグ_日本語)」括弧内タグを優先し、括弧なしなら全体名で判定する。
 * ルールは上から順に適用(先勝ち)。
 *
 * 使う側:
 *   - listReceiptPdfs_ で scope==="receipts" のPDFのみを import-receipts に流す
 *   - import-utilities は driveUtilitiesFolder 配下のサブフォルダ名で光熱/通信を判定するので直接は使わないが、
 *     将来「Drive一箇所にすべて入れて自動仕分け」する場合の共通判定として活用可能。
 *
 * @param {string} name ファイル名(拡張子含んでよい)
 * @returns {{scope:"receipts"|"utilities"|null, category:string|null}}
 */
function classifyExpenseByName_(name) {
  const paren = String(name).match(/[(（]([^)）]+)[)）]/);
  const tag = paren ? paren[1] : String(name);
  // 明確に「経費対象外」の書類キーワード(通帳・配当・契約金・カード明細等)
  if (/通帳|配当金|残高通知|振込明細|カードご利用明細|契約金|地震保険|届出|通知書\b/.test(tag)) {
    return { scope: null, category: null };
  }
  const rules = [
    // utilities系(公共料金・通信の月次請求書は import-utilities で拾う)
    [/光熱|電気|水道|ガス|プロパンガス/, "utilities", "水道光熱費"],
    [/通信費|wi-?fi|ネット|インターネット/i, "utilities", "Wi-Fi・通信費"],
    [/固定電話|電話料金/, "utilities", "固定電話"],
    // receipts系(店舗レシート・領収書・単発請求書)
    [/クリーニング|リネン|洗濯/, "receipts", "リネン・クリーニング"],
    [/ごみ|ゴミ|廃棄/, "receipts", "ゴミ処理費"],
    [/害虫|駆除|防虫/, "receipts", "害虫駆除費"],
    [/修繕|電球|工具|金物|部品|DIY/, "receipts", "小修繕費"],
    [/広告|宣伝|撮影/, "receipts", "広告宣伝費"],
    [/消耗品|日用品|雑貨|備品|アメニティ|文具/, "receipts", "消耗品費"],
  ];
  for (const [re, scope, category] of rules) if (re.test(tag)) return { scope, category };
  return { scope: null, category: null };
}

/**
 * 広島県宿泊税(呉市・広島市共通)の1人1泊あたり税額。
 * 素泊まり相当の宿泊料金(1人1泊)で判定:
 *   - < 10,000円 = 非課税(0円)
 *   - 10,000円 以上 20,000円未満 = 200円
 *   - 20,000円 以上 = 500円
 * 課税基準は「宿泊料金(税抜)」だがAirbnb/Bookingは税込表示のケースがあり、閾値をまたぐ稀例外は
 *  導入運用でユーザーが確認する。
 */
function hiroshimaTaxPerPersonPerNight(perPersonPerNightYen) {
  const v = Number(perPersonPerNightYen) || 0;
  if (v < 10000) return 0;
  if (v < 20000) return 200;
  return 500;
}

/**
 * 予約リストから宿泊税額を集計する(pure関数)。
 * 乳幼児(infants)は課税対象外として「大人+子ども」で人数を数える。
 * キャンセル済みは reservations 側で除外して渡す(この関数はステータス判定しない)。
 *
 * @param {Array<{nights:number, adult:number, child?:number, infant?:number, income:number}>} reservations
 * @param {(perPPN:number)=>number} taxFn 税額関数(既定=広島県)
 * @returns {{totalTax:number, totalPersonNights:number, taxablePersonNights:number, details:Array}}
 */
function computeAccommodationTax(reservations, taxFn) {
  const fn = typeof taxFn === "function" ? taxFn : hiroshimaTaxPerPersonPerNight;
  let totalTax = 0, totalPN = 0, taxablePN = 0;
  const details = [];
  for (const r of (reservations || [])) {
    const nights = toInt(r && r.nights);
    const adult = toInt(r && r.adult);
    const child = toInt(r && r.child);
    const infant = toInt(r && r.infant);
    const guests = adult + child;
    const income = toInt(r && r.income);
    if (nights <= 0 || guests <= 0) {
      details.push({ ...r, personNights: 0, perPPN: 0, tax: 0, subTotal: 0, skipped: "泊数or人数0" });
      continue;
    }
    const perPPN = income / nights / guests;
    const tax = fn(perPPN);
    const pn = nights * guests;
    totalPN += pn;
    if (tax > 0) taxablePN += pn;
    const subTotal = tax * pn;
    totalTax += subTotal;
    details.push({ ...r, personNights: pn, perPPN: Math.round(perPPN), tax, subTotal, infant });
  }
  return { totalTax, totalPersonNights: totalPN, taxablePersonNights: taxablePN, details };
}

module.exports = {
  toInt,
  normLoose,
  normalizeStaffName,
  resolvePropertyForDoc,
  applyExpenses,
  computePnl,
  cleaningAmountForProperty,
  classifyExpenseByName_,
  filterElectricPaymentsForProperty,
  hiroshimaTaxPerPersonPerNight,
  computeAccommodationTax,
};
