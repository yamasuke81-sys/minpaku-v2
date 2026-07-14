/**
 * OTA予約CSV 集計 — 純粋関数モジュール (副作用なし)
 *
 * yadozei-listener が Drive に保存した Airbnb / Booking.com の予約CSVを
 * パースして「月間入金額・OTA手数料・泊数」を集計する。
 * pnl.js から import され、月次収支(propertyMonthlyPnL)の revenue を作る。
 *
 * このファイルの関数はすべて引数のみで決定論的に動くこと(ota-csv-logic.test.js でテスト)。
 */

/**
 * RFC4180 準拠の簡易CSVパーサ。
 * - ダブルクォート内のカンマ・改行を保持
 * - "" は文字リテラルの " にデコード
 * - 行区切りは \r\n / \n の両対応
 * @returns {string[][]} 行の配列(各行はセル文字列の配列)。先頭行はヘッダ。
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // エスケープされた "
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // \r\n の \r は無視(次の \n で行確定)。単独 \r も行区切り扱い
      if (s[i + 1] !== "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    } else if (c === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // 末尾フィールド/行の取りこぼし防止(空の最終行は捨てる)
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * 金額文字列を整数(円)に変換する。
 * "¥18,100" / "36125 JPY" / "28,500" / "" → 18100 / 36125 / 28500 / 0
 */
function parseYen(v) {
  if (v == null) return 0;
  const cleaned = String(v).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  const n = Math.round(Number(cleaned));
  return isNaN(n) ? 0 : n;
}

/**
 * 表記揺れ吸収(物件名/リスティング名の曖昧一致用)。
 */
function normLoose(s) {
  return String(s || "")
    .replace(/[\s　]+/g, "")
    .replace(/[｜|・,，。.]/g, "")
    .toLowerCase();
}

// ヘッダ名→列indexのマップを作る(前後空白/BOM除去)
function headerIndex(header) {
  const map = {};
  header.forEach((h, i) => { map[String(h).replace(/^﻿/, "").trim()] = i; });
  return map;
}

/**
 * Airbnb 予約CSV(yadozei保存形式)を集計する。
 * 列: 確認コード,ステータス,ゲスト名,...,開始日,終了日,宿泊日数,予約済み,リスティング,収入
 * - ステータスに「キャンセル」を含む行は除外(収入も¥0)
 * - listingName 指定時はリスティング列を曖昧一致で絞る(保存CSVは既に絞り込み済だが二重の安全弁)
 * - 収入(入金額=ホスト受取)を合算 → grossRevenue
 *
 * @returns {{grossRevenue:number, nights:number, reservationCount:number, canceledCount:number}}
 */
function sumAirbnbCsv(text, opts = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { grossRevenue: 0, nights: 0, reservationCount: 0, canceledCount: 0 };
  const h = headerIndex(rows[0]);
  const iStatus = h["ステータス"];
  const iIncome = h["収入"];
  const iNights = h["宿泊日数"];
  const iListing = h["リスティング"];
  const wantListing = opts.listingName ? normLoose(opts.listingName) : "";

  let grossRevenue = 0, nights = 0, reservationCount = 0, canceledCount = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const status = String(row[iStatus] || "");
    if (status.includes("キャンセル")) { canceledCount++; continue; }
    if (wantListing && iListing != null) {
      const ln = normLoose(row[iListing]);
      if (ln && !(ln === wantListing || ln.includes(wantListing) || wantListing.includes(ln))) continue;
    }
    const income = parseYen(row[iIncome]);
    if (income <= 0) continue; // 収入0(未確定/キャンセル相当)は売上に含めない
    grossRevenue += income;
    nights += parseYen(row[iNights]);
    reservationCount++;
  }
  return { grossRevenue, nights, reservationCount, canceledCount };
}

// Booking決済手数料率(Payments by Booking)。2025-10〜2026-06 の全滞在で
// round(gross×2.3%) が銀行入金(楽天第三)×公式財務明細と1円単位で一致することを実証済(2026-07-14)。
const BOOKING_PAYMENT_FEE_RATE = 0.023;

/**
 * Booking.com 予約CSV(yadozei保存形式)を集計する。
 * 列: 予約番号,...,ステータス,...,料金,コミッション率,コミッション額,...,滞在期間（泊数）,...
 * - ステータス "ok" = 宿泊売上。加えて cancelled でも「コミッション額>0」の行は
 *   キャンセル料徴収あり=売上として計上(財務明細では通常の予約行として支払われる。
 *   実例: 2026-04 ¥46,800 guest cancel → net38,704 が銀行入金と一致)。泊数は実宿泊なしのため加算しない。
 * - paymentFee = round(料金×2.3%)(滞在ごと) — Payments by Booking の決済サービス手数料
 * - netRevenue = 料金 − コミッション額 − paymentFee (=実際の銀行入金額)
 *
 * @returns {{grossRevenue:number, commission:number, paymentFee:number, netRevenue:number, reservationCount:number, nights:number, canceledCount:number, chargedCancelCount:number}}
 */
function sumBookingCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { grossRevenue: 0, commission: 0, paymentFee: 0, netRevenue: 0, reservationCount: 0, nights: 0, canceledCount: 0, chargedCancelCount: 0 };
  const h = headerIndex(rows[0]);
  const iStatus = h["ステータス"];
  const iAmount = h["料金"];
  const iComm = h["コミッション額"];
  // 泊数列は「滞在期間（泊数）」。全半角括弧の揺れに対応
  let iNights = h["滞在期間（泊数）"];
  if (iNights == null) iNights = h["滞在期間(泊数)"];

  let grossRevenue = 0, commission = 0, paymentFee = 0, reservationCount = 0, nights = 0, canceledCount = 0, chargedCancelCount = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const status = String(row[iStatus] || "").trim().toLowerCase();
    const gross = parseYen(row[iAmount]);
    const comm = parseYen(row[iComm]);
    if (status !== "ok") {
      if (comm > 0 && gross > 0) {
        // キャンセル料徴収(100%等)。売上計上・泊数は加算しない
        grossRevenue += gross;
        commission += comm;
        paymentFee += Math.round(gross * BOOKING_PAYMENT_FEE_RATE);
        chargedCancelCount++;
      } else {
        canceledCount++;
      }
      continue;
    }
    grossRevenue += gross;
    commission += comm;
    paymentFee += Math.round(gross * BOOKING_PAYMENT_FEE_RATE);
    if (iNights != null) nights += parseYen(row[iNights]);
    reservationCount++;
  }
  return { grossRevenue, commission, paymentFee, netRevenue: grossRevenue - commission - paymentFee, reservationCount, nights, canceledCount, chargedCancelCount };
}

/**
 * 精算(運営代行手数料)を計算する。
 *
 * ★2026-07-14 ユーザー決定: 手数料は「利益ベース」で算定する。
 *   算定基礎(feeBase) = 運営利益 = 売上 − OTA手数料 − 清掃費 − 諸経費
 *   (宿泊税は預り金なので基礎に含めない)
 *   手数料(税抜) = 運営利益 × 料率%（運営利益が0以下なら0でフロア）
 *   消費税 = 手数料(税抜) × 消費税率%
 *   手数料(税込) = 手数料(税抜) + 消費税  ← これが乙(八朔)への請求額
 *
 * 呼び出し側は `feeBase`(運営利益 = computePnl().profit) を渡す。
 * 後方互換: `feeBase` 未指定時は旧・売上ベース(入金額A − 宿泊税預りB)で算定する
 *   (既存テスト/旧データ経路のため残置)。
 *
 * 端数は各段で四捨五入(円未満)。※必要なら feeRounding で切替可能。
 * @returns {{basis, feeBase, salesBase, depositAmount, taxWithholding, feeRatePct, feeExclTax, consumptionTaxPct, consumptionTax, feeInclTax}}
 */
function computeSettlement(input = {}) {
  const depositAmount = Math.max(0, Math.round(Number(input.depositAmount) || 0));
  const taxWithholding = Math.max(0, Math.round(Number(input.taxWithholding) || 0));
  const feeRatePct = Number(input.feeRatePct != null ? input.feeRatePct : 50);
  const consumptionTaxPct = Number(input.consumptionTaxPct != null ? input.consumptionTaxPct : 10);
  const round = input.feeRounding === "floor" ? Math.floor
    : input.feeRounding === "ceil" ? Math.ceil : Math.round;

  // 手数料算定基礎: 利益ベース(feeBase)を優先、無ければ旧・売上ベース(A − B)
  const usingProfitBase = input.feeBase != null;
  const feeBase = usingProfitBase
    ? Math.max(0, Math.round(Number(input.feeBase) || 0))
    : Math.max(0, depositAmount - taxWithholding);

  const feeExclTax = round(feeBase * feeRatePct / 100);
  const consumptionTax = round(feeExclTax * consumptionTaxPct / 100);
  const feeInclTax = feeExclTax + consumptionTax;
  return {
    basis: usingProfitBase ? "profit" : "revenue",
    // feeBase = 手数料算定基礎(利益ベースなら運営利益、旧経路なら売上高)
    // salesBase は後方互換の別名(旧テスト/精算書PDFの参照名)
    feeBase, salesBase: feeBase,
    depositAmount, taxWithholding,
    feeRatePct, feeExclTax, consumptionTaxPct, consumptionTax, feeInclTax,
  };
}

// ================= 運営形態(operationMode) / 実効料率 =================
// operationMode: "agency_hassac"(八朔代行) | "agency_other"(その他代行) | "self"(自社運営/代行なし)
// 後方互換: 旧 settlementMode "self"→self, "daiko"/未設定→agency_hassac
const OPERATION_MODES = ["agency_hassac", "agency_other", "self"];

/** 物件docから運営形態を決定的に解決する(後方互換込み) */
function resolveOperationMode(prop) {
  const m = prop && prop.operationMode;
  if (OPERATION_MODES.includes(m)) return m;
  // 旧 settlementMode からの推定
  if (prop && prop.settlementMode === "self") return "self";
  return "agency_hassac";
}

/** 代行(運営代行手数料が発生する)モードか */
function isAgencyMode(mode) {
  return mode === "agency_hassac" || mode === "agency_other";
}

/** 料率(%)を 0-100 にクランプ。null/空/数値でなければ null(=未設定扱い)。0 は有効値 */
function clampRate(v) {
  if (v == null || v === "") return null; // Number(null)===0 の誤判定を防ぐ
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * その月に適用する運営代行手数料率(%)を解決する(唯一の決定ロジック)。
 * - 自社運営(代行なし) → 常に 0(誤って料率が入っていても無視)
 * - 月の feeRatePct が数値(0含む) → その値(月固定・スナップショット)
 * - なければ物件既定 managementFeeRate(0含む)
 * - どちらも無ければ 50
 */
function effectiveFeeRatePct(monthData, prop) {
  if (!isAgencyMode(resolveOperationMode(prop))) return 0;
  const month = clampRate(monthData && monthData.feeRatePct);
  if (month != null) return month;
  const base = clampRate(prop && prop.managementFeeRate);
  if (base != null) return base;
  return 50;
}

/**
 * 精算の月間入金額(A)を revenue から算出する。
 * Airbnb=総額(grossRevenue)、Booking=手取り(netRevenue、無ければ gross - commission)。
 * settlement.js の精算と summary の手数料列で同一定義を使うため共通化。端数は computeSettlement 側で丸める。
 */
function computeDepositAmount(revenue) {
  const rev = revenue || {};
  const ab = rev.airbnb || {};
  const bk = rev.booking || {};
  const depositAirbnb = Number(ab.grossRevenue || 0);
  const depositBooking = Number(
    bk.netRevenue != null ? bk.netRevenue : (Number(bk.grossRevenue || 0) - Number(bk.commission || 0)),
  );
  return { depositAirbnb, depositBooking, depositAmount: depositAirbnb + depositBooking };
}

/**
 * Airbnb 予約CSVを予約単位で抽出する(宿泊税計算などのため)。
 * 各予約: { nights, adult, child, infant, income, name }
 * キャンセルは除外。listingName 指定時は絞り込み。
 */
function extractAirbnbReservations(text, opts = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const h = headerIndex(rows[0]);
  const iStatus = h["ステータス"], iName = h["ゲスト名"];
  const iAdult = h["大人の人数"], iChild = h["子どもの人数"], iInfant = h["乳幼児の人数"];
  const iNights = h["宿泊日数"], iIncome = h["収入"], iListing = h["リスティング"];
  const wantListing = opts.listingName ? normLoose(opts.listingName) : "";
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const status = String(row[iStatus] || "");
    if (status.includes("キャンセル")) continue;
    if (wantListing && iListing != null) {
      const ln = normLoose(row[iListing]);
      if (ln && !(ln === wantListing || ln.includes(wantListing) || wantListing.includes(ln))) continue;
    }
    const income = parseYen(row[iIncome]);
    if (income <= 0) continue;
    out.push({
      name: String(row[iName] || ""),
      nights: parseYen(row[iNights]),
      adult: parseYen(row[iAdult]),
      child: parseYen(row[iChild]),
      infant: parseYen(row[iInfant]),
      income,
    });
  }
  return out;
}

/**
 * Booking.com 予約CSVを予約単位で抽出する(宿泊税計算などのため)。
 * 各予約: { nights, adult, child, infant, income, name }
 * 「子供の年齢」から乳幼児(0-5歳)を判別して child/infant に分ける(6歳以上は子ども扱い、0-5歳は乳幼児扱い)。
 * status "ok" 以外は除外。
 */
function extractBookingReservations(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const h = headerIndex(rows[0]);
  const iStatus = h["ステータス"], iName = h["宿泊者氏名"] != null ? h["宿泊者氏名"] : h["予約者名"];
  const iAdult = h["大人"], iChild = h["子供"], iChildAges = h["子供の年齢"];
  const iAmount = h["料金"];
  let iNights = h["滞在期間（泊数）"];
  if (iNights == null) iNights = h["滞在期間(泊数)"];

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const status = String(row[iStatus] || "").trim().toLowerCase();
    if (status !== "ok") continue;
    const income = parseYen(row[iAmount]);
    if (income <= 0) continue;
    const adult = parseYen(row[iAdult]);
    const childRaw = parseYen(row[iChild]);
    // 子供の年齢 (例 "10, 12") から 0-5歳を infant、6歳以上を child に分割
    let infant = 0, child = childRaw;
    if (iChildAges != null && childRaw > 0) {
      const ages = String(row[iChildAges] || "")
        .split(/[,、\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      if (ages.length) {
        infant = ages.filter((a) => a <= 5).length;
        child = Math.max(0, childRaw - infant);
      }
    }
    out.push({
      name: String(row[iName] || ""),
      nights: iNights != null ? parseYen(row[iNights]) : 1,
      adult, child, infant, income,
    });
  }
  return out;
}

module.exports = {
  parseCsv,
  parseYen,
  normLoose,
  sumAirbnbCsv,
  sumBookingCsv,
  BOOKING_PAYMENT_FEE_RATE,
  extractAirbnbReservations,
  extractBookingReservations,
  computeSettlement,
  OPERATION_MODES,
  resolveOperationMode,
  isAgencyMode,
  effectiveFeeRatePct,
  computeDepositAmount,
};
