/**
 * ゲスト向け宿泊料金の見積 — 純粋関数モジュール (副作用なし)
 *
 * propertyRates/{propertyId} マスタ + 日別 overrides から、
 * 日程・人数・プランの見積を決定論的に算出する。DB/APIには触れない。
 * booking-request-logic.js / pnl-logic.js と同じ方針でユニットテスト可能にする。
 *
 * 適用の優先順位 (高→低): overrides[date] > season(該当期間) > 週末(該当曜日) > 基準料金
 * 課金は半開区間 [checkIn, checkOut)(チェックアウト日は非課金) — enumerateBlockedDates と整合。
 *
 * ※ この料金は「ゲストが1泊いくらで泊まるか」であって、
 *   propertyWorkItems (スタッフ報酬単価) とは別物。混同しないこと。
 */
const { isValidYmd, nightsBetween } = require("./booking-request-logic");

/** YYYY-MM-DD の曜日 (0=日..6=土)。UTC 基準で日付だけを見る。 */
function dowUtc(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/** [checkIn, checkOut) の宿泊夜を YYYY-MM-DD 配列で返す (CO日は含まない)。 */
function eachNight(checkIn, checkOut) {
  const out = [];
  if (!isValidYmd(checkIn) || !isValidYmd(checkOut)) return out;
  const cur = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  let guard = 0;
  while (cur < end && guard < 400) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return out;
}

/** その日付に該当するシーズン(最初に一致したもの)を返す。無ければ null。 */
function seasonForDate(rates, ymd) {
  const seasons = Array.isArray(rates.seasons) ? rates.seasons : [];
  for (const s of seasons) {
    if (isValidYmd(s.start) && isValidYmd(s.end) && ymd >= s.start && ymd <= s.end) return s;
  }
  return null;
}

/**
 * 1泊の単価と、その根拠(kind)を決定する。
 * @param {object} rates - propertyRates ドキュメント
 * @param {string} ymd - 対象の宿泊夜
 * @param {object} [overrides] - { "YYYY-MM-DD": { price } }
 * @returns {{price:number, kind:string}}
 */
function nightlyRate(rates, ymd, overrides = {}) {
  const ov = overrides && overrides[ymd];
  if (ov && Number.isFinite(Number(ov.price))) {
    return { price: Math.round(Number(ov.price)), kind: "override" };
  }
  const weekendDays = (Array.isArray(rates.weekendDays) && rates.weekendDays.length)
    ? rates.weekendDays : [5, 6];
  const isWeekend = weekendDays.includes(dowUtc(ymd));

  const season = seasonForDate(rates, ymd);
  if (season) {
    const sp = (isWeekend && Number.isFinite(Number(season.weekendPrice)))
      ? Number(season.weekendPrice) : Number(season.price);
    if (Number.isFinite(sp)) {
      return { price: Math.round(sp), kind: isWeekend ? "season-weekend" : "season" };
    }
  }
  if (isWeekend && Number.isFinite(Number(rates.weekendPrice))) {
    return { price: Math.round(Number(rates.weekendPrice)), kind: "weekend" };
  }
  return { price: Math.round(Number(rates.basePrice) || 0), kind: "base" };
}

/** 連泊割引率(%)。閾値(minNights)を満たす中で最大の割引率を返す。 */
function losDiscountPercent(rates, nights) {
  const list = Array.isArray(rates.lengthOfStayDiscounts) ? rates.lengthOfStayDiscounts : [];
  let pct = 0;
  for (const d of list) {
    const mn = Number(d.minNights);
    const p = Number(d.discountPercent);
    if (Number.isFinite(mn) && Number.isFinite(p) && nights >= mn && p > pct) pct = p;
  }
  return pct;
}

/**
 * 見積を算出する。
 * 合成順: 1泊ごと単価を確定 → 合算(subtotal) → 連泊割引% → 人数加算 → 最後にプラン(%)。
 * @param {object} args
 * @param {object} args.rates - propertyRates ドキュメント
 * @param {string} args.checkIn
 * @param {string} args.checkOut
 * @param {number|string} args.guests
 * @param {string} args.plan - "standard" | "nonrefundable"
 * @param {object} [args.overrides] - 日別上書き { "YYYY-MM-DD": { price } }
 * @returns {{ok:true, quote:object}|{ok:false, error:string}}
 */
function computeQuote({ rates, checkIn, checkOut, guests, plan, overrides }) {
  if (!rates || typeof rates !== "object") {
    return { ok: false, error: "料金が設定されていません" };
  }
  if (!isValidYmd(checkIn) || !isValidYmd(checkOut)) {
    return { ok: false, error: "日付の形式が不正です" };
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (nights <= 0) {
    return { ok: false, error: "チェックアウト日はチェックイン日より後にしてください" };
  }
  // 最低泊数 (propertyRates.minNights)。1 以下は制約なし。見積段階で弾く。
  const minNights = (Number.isFinite(Number(rates.minNights)) && Number(rates.minNights) > 1)
    ? Math.floor(Number(rates.minNights)) : 1;
  if (minNights > 1 && nights < minNights) {
    return { ok: false, error: `この宿は${minNights}泊以上のご予約が必要です` };
  }
  const g = Math.max(1, parseInt(guests, 10) || 1);
  const planKey = ["standard", "nonrefundable"].includes(String(plan)) ? String(plan) : "standard";

  const nightlyBreakdown = eachNight(checkIn, checkOut).map((date) => {
    const r = nightlyRate(rates, date, overrides || {});
    return { date, price: r.price, kind: r.kind };
  });
  const subtotal = nightlyBreakdown.reduce((sum, n) => sum + n.price, 0);

  // 連泊割引 (総額に対して%)
  const losPct = losDiscountPercent(rates, nights);
  const lengthOfStayDiscountAmount = Math.round((subtotal * losPct) / 100);

  // 人数加算 (含む人数を超えた分 × 単価 × 泊数)
  const gs = (rates.guestSurcharge && typeof rates.guestSurcharge === "object") ? rates.guestSurcharge : {};
  const includedGuests = Number.isFinite(Number(gs.includedGuests)) ? Number(gs.includedGuests) : g;
  const perExtraGuest = Number(gs.perExtraGuest) || 0;
  const extraGuests = Math.max(0, g - includedGuests);
  const guestSurcharge = extraGuests * perExtraGuest * nights;

  // プラン調整 (返金不可は -10% 等)。連泊割引・人数加算を反映した後に掛ける。
  const planModifiers = (rates.planModifiers && typeof rates.planModifiers === "object") ? rates.planModifiers : {};
  const planModifierPercent = Number(planModifiers[planKey]) || 0;
  const beforePlan = subtotal - lengthOfStayDiscountAmount + guestSurcharge;
  const planModifierAmount = Math.round((beforePlan * planModifierPercent) / 100);
  const total = beforePlan + planModifierAmount;

  return {
    ok: true,
    quote: {
      currency: rates.currency || "JPY",
      checkIn,
      checkOut,
      nights,
      guests: g,
      plan: planKey,
      nightlyBreakdown,
      subtotal,
      lengthOfStayDiscountPercent: losPct,
      lengthOfStayDiscountAmount,
      includedGuests,
      extraGuests,
      perExtraGuest,
      guestSurcharge,
      planModifierPercent,
      planModifierAmount,
      total,
    },
  };
}

module.exports = {
  dowUtc,
  eachNight,
  seasonForDate,
  nightlyRate,
  losDiscountPercent,
  computeQuote,
};
