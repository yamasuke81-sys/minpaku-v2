/**
 * 各宿のゲスト向け宿泊料金マスタ(propertyRates)を投入する冪等 seed。
 * 値は各Airbnb公開リスティング(2026-07取得)に準拠。
 *
 * ※ propertyRates は「ゲストが1泊いくらで泊まるか」。propertyWorkItems(スタッフ報酬)とは別物。
 *
 * 実行: cd functions && node scripts/seedPropertyRates.js [propertyId|all]
 *   引数省略時は 'all'（未投入の宿のみ作成）。既存を上書きするには FORCE=1。
 *   認証: gcloud ADC もしくは GOOGLE_APPLICATION_CREDENTIALS(サービスアカウントJSON)
 *
 * 新しい宿を足すときは RATES にAirbnb取得値で1エントリ追加して実行するだけ(コード変更不要)。
 */
const admin = require("firebase-admin");

const PROJECT_ID = "minpaku-v2";
const FORCE = process.env.FORCE === "1";

admin.initializeApp({ projectId: PROJECT_ID, credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const RATES = {
  // 小町 (YADO KOMACHI Hiroshima) — Airbnb listing 1662812097638356214
  RZV9IwtQgMAsvrdM3j8J: {
    currency: "JPY",
    basePrice: 15000,
    weekendPrice: 20000,
    weekendDays: [5, 6],
    seasons: [],
    lengthOfStayDiscounts: [
      { minNights: 7, discountPercent: 25 },
      { minNights: 28, discountPercent: 26 },
    ],
    guestSurcharge: { includedGuests: 2, perExtraGuest: 4000 },
    planModifiers: { standard: 0, nonrefundable: -10 },
    minNights: 1,
    maxNights: 365,
    source: "airbnb:1662812097638356214",
  },
  // the Terrace 長浜 — Airbnb listing 1496523336810635360
  tsZybhDMcPrxqgcRy7wp: {
    currency: "JPY",
    basePrice: 40000,
    weekendPrice: 50000,
    weekendDays: [5, 6],
    seasons: [],
    lengthOfStayDiscounts: [
      { minNights: 7, discountPercent: 22 }, // 週割のみ(月割は0%=なし)
    ],
    guestSurcharge: { includedGuests: 4, perExtraGuest: 8000 }, // 5人目以降 +8,000/泊
    planModifiers: { standard: 0, nonrefundable: -10 },
    minNights: 1,
    maxNights: 50,
    source: "airbnb:1496523336810635360",
  },
};

(async () => {
  const arg = process.argv[2] || "all";
  const targets = arg === "all" ? Object.keys(RATES) : [arg];
  for (const pid of targets) {
    const data = RATES[pid];
    if (!data) {
      console.log(`[seed] 未定義のpropertyId: ${pid} — skip`);
      continue;
    }
    const ref = db.collection("propertyRates").doc(pid);
    const existing = await ref.get();
    if (existing.exists && !FORCE) {
      console.log(`[seed] ${pid} は既に存在します(FORCE=1 で上書き) — skip`);
      continue;
    }
    await ref.set({ ...data, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: false });
    console.log(`[seed] ${pid} を${existing.exists ? "上書き" : "新規作成"}: 平日¥${data.basePrice} / 週末¥${data.weekendPrice}`);
  }
  console.log("[seed] 完了");
  process.exit(0);
})().catch((e) => {
  console.error("[seed] 失敗:", e);
  process.exit(1);
});
