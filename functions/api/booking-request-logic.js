/**
 * 直接予約リクエスト — 純粋関数モジュール (副作用なし)
 *
 * public.js / booking-requests.js から DB/API に触れないロジックだけを切り出し、
 * ユニットテストで挙動を担保する。pnl-logic.js と同じ方針。
 *
 * このファイルの関数はすべて引数のみで決定論的に動くこと。
 */

/**
 * checkIn/checkOut の型混在 (文字列/Timestamp) を YYYY-MM-DD に正規化する。
 * public.js の /ical/:file ルートの ymd() と同一ロジック。
 * @param {any} v
 * @returns {string} YYYY-MM-DD、不正な場合は空文字
 */
function ymd(v) {
  if (!v) return "";
  if (typeof v.toDate === "function") return v.toDate().toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * YYYY-MM-DD 形式かどうかを検証する
 * @param {string} s
 * @returns {boolean}
 */
function isValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

/**
 * 今日 (JST) を YYYY-MM-DD で返す
 * @returns {string}
 */
function todayJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * [checkIn, checkOut) の期間内の日付を YYYY-MM-DD の配列で列挙する。
 * 過去日 (todayStr より前) は含めない。上限は maxMonths ヶ月後まで。
 * @param {string} checkIn - YYYY-MM-DD
 * @param {string} checkOut - YYYY-MM-DD (非包含)
 * @param {object} [opts]
 * @param {string} [opts.todayStr] - 基準日 (省略時は実行時の JST 今日)
 * @param {number} [opts.maxMonths=12] - 基準日から何ヶ月先まで含めるか
 * @returns {string[]}
 */
function enumerateBlockedDates(checkIn, checkOut, opts = {}) {
  if (!isValidYmd(checkIn) || !isValidYmd(checkOut)) return [];
  const todayStr = opts.todayStr || todayJst();
  const maxMonths = Number.isFinite(opts.maxMonths) ? opts.maxMonths : 12;

  const limitDate = new Date(`${todayStr}T00:00:00Z`);
  limitDate.setUTCMonth(limitDate.getUTCMonth() + maxMonths);
  const limitStr = limitDate.toISOString().slice(0, 10);

  const dates = [];
  const cur = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  // 異常な範囲 (checkOut <= checkIn や極端に長い期間) は空を返す
  if (end <= cur) return [];
  let guard = 0;
  while (cur < end && guard < 400) {
    const d = cur.toISOString().slice(0, 10);
    if (d >= todayStr && d <= limitStr) dates.push(d);
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return dates;
}

/**
 * 2つの宿泊期間が重複するか判定する ([checkIn, checkOut) の半開区間)
 * @param {string} aCheckIn
 * @param {string} aCheckOut
 * @param {string} bCheckIn
 * @param {string} bCheckOut
 * @returns {boolean}
 */
function periodsOverlap(aCheckIn, aCheckOut, bCheckIn, bCheckOut) {
  if (!isValidYmd(aCheckIn) || !isValidYmd(aCheckOut)) return false;
  if (!isValidYmd(bCheckIn) || !isValidYmd(bCheckOut)) return false;
  return aCheckIn < bCheckOut && bCheckIn < aCheckOut;
}

/**
 * 宿泊日数 (泊数) を計算する
 * @param {string} checkIn
 * @param {string} checkOut
 * @returns {number} 不正な場合は 0
 */
function nightsBetween(checkIn, checkOut) {
  if (!isValidYmd(checkIn) || !isValidYmd(checkOut)) return 0;
  const ci = new Date(`${checkIn}T00:00:00Z`).getTime();
  const co = new Date(`${checkOut}T00:00:00Z`).getTime();
  const diff = Math.round((co - ci) / 86400000);
  return diff > 0 ? diff : 0;
}

/**
 * 有料駐車場の追加料金を計算する (単価 × 泊数 × 台数)。
 * 物件 properties/{pid}.paidParking = { enabled, pricePerNightPerCar, maxCars } を参照。
 * 設定なし/無効/単価不正/台数0/泊数0 は必ず { cars: 0, fee: 0 } を返す (課金なし)。
 * 台数は 0〜maxCars にクランプ (不正値・過大値をサイレントに丸める。サーバー側が正)。
 * @param {object|null} paidParking - 物件の paidParking 設定
 * @param {string} checkIn
 * @param {string} checkOut
 * @param {*} requestedCars - リクエストされた台数 (文字列/数値)
 * @returns {{cars:number, fee:number, nights:number, pricePerNightPerCar:number}}
 */
function computeParkingCharge(paidParking, checkIn, checkOut, requestedCars) {
  const none = { cars: 0, fee: 0, nights: 0, pricePerNightPerCar: 0 };
  const cfg = paidParking || {};
  if (cfg.enabled !== true) return none;
  const price = Number(cfg.pricePerNightPerCar);
  if (!Number.isFinite(price) || price <= 0) return none;
  const maxCarsRaw = Number(cfg.maxCars);
  const maxCars = (Number.isFinite(maxCarsRaw) && maxCarsRaw > 0) ? Math.floor(maxCarsRaw) : 2;
  let cars = parseInt(requestedCars, 10);
  if (!Number.isFinite(cars) || cars < 0) cars = 0;
  cars = Math.min(cars, maxCars);
  const nights = nightsBetween(checkIn, checkOut);
  if (cars === 0 || nights === 0) return none;
  return { cars, fee: price * nights * cars, nights, pricePerNightPerCar: price };
}

/**
 * メールアドレスの簡易形式チェック (厳密な RFC 準拠ではない実用チェック)
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

/**
 * 予約リクエストのフォーム入力を検証する。
 * @param {object} body - リクエストボディ
 * @param {object} property - properties/{id} のデータ (存在 + active 済み前提)
 * @param {object} [opts]
 * @param {string} [opts.todayStr]
 * @param {number} [opts.maxNights=30]
 * @param {number} [opts.minNights=1] - propertyRates.minNights (最低泊数)。未設定は 1 (実質無制限)。
 * @returns {{ok:true}|{ok:false, error:string}}
 */
function validateBookingRequest(body, property, opts = {}) {
  const todayStr = opts.todayStr || todayJst();
  const maxNights = Number.isFinite(opts.maxNights) ? opts.maxNights : 30;
  // 最低泊数 (propertyRates.minNights)。1 以下は制約なしとして扱う。
  const minNights = (Number.isFinite(opts.minNights) && opts.minNights > 1) ? Math.floor(opts.minNights) : 1;

  const checkIn = String(body.checkIn || "").slice(0, 10);
  const checkOut = String(body.checkOut || "").slice(0, 10);
  if (!isValidYmd(checkIn) || !isValidYmd(checkOut)) {
    return { ok: false, error: "checkIn/checkOut の形式が不正です" };
  }
  if (checkIn < todayStr) {
    return { ok: false, error: "チェックイン日は本日以降を指定してください" };
  }
  if (checkOut <= checkIn) {
    return { ok: false, error: "チェックアウト日はチェックイン日より後にしてください" };
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (nights > maxNights) {
    return { ok: false, error: `宿泊日数は${maxNights}泊までです` };
  }
  if (minNights > 1 && nights < minNights) {
    return { ok: false, error: `この宿は${minNights}泊以上のご予約が必要です` };
  }

  const guests = parseInt(body.guests, 10);
  const capacity = Number(property && property.capacity) || 0;
  if (!Number.isFinite(guests) || guests < 1) {
    return { ok: false, error: "宿泊人数を指定してください" };
  }
  if (capacity > 0 && guests > capacity) {
    return { ok: false, error: `宿泊人数は定員(${capacity}名)以内にしてください` };
  }

  // ===== 人数内訳 (adults/children/infants, 2026-07 追加) =====
  // 後方互換: adults/children が未送信の場合は guests から「大人=guests, 子ども=0」に
  // フォールアックする (整合チェックは自動的に成立する)。infants 未送信は 0 扱い。
  const adultsRaw = body.adults;
  const childrenRaw = body.children;
  const hasBreakdown = adultsRaw !== undefined || childrenRaw !== undefined;
  const adults = adultsRaw !== undefined ? parseInt(adultsRaw, 10) : guests;
  const children = childrenRaw !== undefined ? parseInt(childrenRaw, 10) : 0;
  const infants = body.infants !== undefined ? parseInt(body.infants, 10) : 0;
  if (!Number.isFinite(adults) || adults < 1) {
    return { ok: false, error: "大人の人数を指定してください" };
  }
  if (!Number.isFinite(children) || children < 0) {
    return { ok: false, error: "子どもの人数が不正です" };
  }
  if (!Number.isFinite(infants) || infants < 0) {
    return { ok: false, error: "乳幼児の人数が不正です" };
  }
  if (hasBreakdown && adults + children !== guests) {
    return { ok: false, error: "人数の内訳(大人+子ども)が合計人数と一致しません" };
  }
  if (capacity > 0 && (adults + children) > capacity) {
    return { ok: false, error: `宿泊人数は定員(${capacity}名)以内にしてください` };
  }

  // ===== 国籍・メンバー構成 (2026-07 追加・必須) =====
  const nationality = String(body.nationality || "").trim();
  if (nationality.length < 1) {
    return { ok: false, error: "国籍を入力してください" };
  }
  if (nationality.length > 60) {
    return { ok: false, error: "国籍は60文字以内で入力してください" };
  }
  const memberComposition = String(body.memberComposition || "").trim();
  if (memberComposition.length < 1) {
    return { ok: false, error: "メンバー構成を入力してください" };
  }
  if (memberComposition.length > 100) {
    return { ok: false, error: "メンバー構成は100文字以内で入力してください" };
  }

  // ===== 代表者の年代・性別 (2026-07 追加・任意) =====
  // 未送信でも既存動作を壊さない (空文字許容・ハードエラーにしない)。文字数超過のみ弾く。
  const age = String(body.age || "").trim();
  if (age.length > 60) {
    return { ok: false, error: "年代は60文字以内で入力してください" };
  }
  const gender = String(body.gender || "").trim();
  if (gender.length > 20) {
    return { ok: false, error: "性別は20文字以内で入力してください" };
  }

  const name = String(body.name || "").trim();
  if (name.length < 1 || name.length > 100) {
    return { ok: false, error: "お名前を1〜100文字で入力してください" };
  }

  if (!isValidEmail(body.email)) {
    return { ok: false, error: "メールアドレスの形式が正しくありません" };
  }

  const notes = String(body.notes || "");
  if (notes.length > 1000) {
    return { ok: false, error: "備考は1000文字以内で入力してください" };
  }

  const plan = String(body.plan || "standard");
  if (!["standard", "nonrefundable"].includes(plan)) {
    return { ok: false, error: "プランの指定が不正です" };
  }

  return { ok: true };
}

/**
 * スパム判定: ハニーポット入力あり、または表示からの経過時間が短すぎる場合は
 * 「成功したように見せて実際は保存しない」扱いにする。
 * @param {object} body
 * @param {number} [minElapsedMs=1500]
 * @returns {boolean} true = スパムとみなして保存をスキップすべき
 */
function isSpamSubmission(body, minElapsedMs = 1500) {
  const honeypot = String((body && body.website) || "").trim();
  if (honeypot.length > 0) return true;
  const elapsed = Number(body && body.elapsedMs);
  if (Number.isFinite(elapsed) && elapsed < minElapsedMs) return true;
  return false;
}

module.exports = {
  ymd,
  isValidYmd,
  todayJst,
  enumerateBlockedDates,
  periodsOverlap,
  nightsBetween,
  computeParkingCharge,
  isValidEmail,
  validateBookingRequest,
  isSpamSubmission,
};
