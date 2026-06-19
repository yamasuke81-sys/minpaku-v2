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

module.exports = {
  toInt,
  normLoose,
  normalizeStaffName,
  resolvePropertyForDoc,
  applyExpenses,
  computePnl,
};
