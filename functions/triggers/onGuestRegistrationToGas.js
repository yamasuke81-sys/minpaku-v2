/**
 * 宿泊者名簿 新規作成 → GAS版スプシへの自動転記
 * トリガー: guestRegistrations/{guestId} の onCreate
 * 対象: source === "guest_form" かつ propertyId === "tsZybhDMcPrxqgcRy7wp" (the Terrace 長浜) のみ
 *       他物件は対象外 (GAS版は the Terrace 長浜専用のため)
 */
const https = require("https");

/**
 * Firestore から gasComparison 設定を読み込み、gasUrl と gasToken を取得
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<{ gasUrl: string, gasToken: string } | null>}
 */
async function loadGasConfig_(db) {
  const snap = await db.collection("settings").doc("gasComparison").get();
  if (!snap.exists) return null;
  const { gasUrl, gasToken } = snap.data();
  if (!gasUrl || !gasToken) return null;
  return { gasUrl, gasToken };
}

/**
 * HTTPS POST (JSON) を送信する簡易ラッパー
 * @param {string} url
 * @param {object} payload
 * @returns {Promise<{ status: number, body: string }>}
 */
function postJson_(url, payload) {
  return new Promise((resolve, reject) => {
    const jsonStr = JSON.stringify(payload);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonStr),
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.write(jsonStr);
    req.end();
  });
}

module.exports = async function onGuestRegistrationToGas(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const data = event.data?.data();
  if (!data) return;

  // guest_form 以外はスキップ
  if (data.source !== "guest_form") return;

  // the Terrace 長浜 以外の物件はスキップ（GAS版は the Terrace 長浜専用）
  const TERRACE_NAGAHAMA_ID = "tsZybhDMcPrxqgcRy7wp";
  if (data.propertyId !== TERRACE_NAGAHAMA_ID) {
    console.log(`[onGuestRegistrationToGas] propertyId=${data.propertyId} は対象外 (the Terrace 長浜のみ転記)`);
    return;
  }

  const guestId = event.params?.guestId || event.data.ref.id;

  // GAS 設定取得
  const config = await loadGasConfig_(db);
  if (!config) {
    console.warn("[onGuestRegistrationToGas] gasComparison 設定が未設定 — スキップ");
    return;
  }

  // v2フィールド → GAS転記用ペイロード変換
  const guest = {
    checkIn:            data.checkIn      || "",
    checkOut:           data.checkOut     || "",
    guestName:          data.guestName    || "",
    nationality:        data.nationality  || "",
    address:            data.address      || "",
    phone:              data.phone        || "",
    email:              data.email        || "",
    passportNumber:     (data.guests && data.guests[0]?.passportNumber) ? data.guests[0].passportNumber : "",
    purpose:            data.purpose      || "",
    guestCount:         data.guestCount   || "",
    guestCountInfants:  data.guestCountInfants || 0,
    bookingSite:        data.bookingSite  || "",
    bbq:                data.bbq          || "",
    parking:            data.parking      || data.paidParking || "",
    memo:               data.memo         || "",
    // 同行者（guests[0] は代表者扱いのため [1] 以降を渡す）
    // ただし v2 の guests[] は同行者リストなので全員を渡す
    guests: (data.guests || []).map((g) => ({
      name:           g.name           || "",
      age:            g.age            || "",
      address:        g.address        || "",
      nationality:    g.nationality    || "",
      passportNumber: g.passportNumber || "",
    })),
  };

  const payload = {
    action: "appendGuestFromV2",
    token:  config.gasToken,
    guest,
  };

  try {
    const result = await postJson_(config.gasUrl, payload);
    if (result.status === 200) {
      console.log(`[onGuestRegistrationToGas] GAS転記成功: guestId=${guestId} name=${guest.guestName}`);
    } else {
      console.error(`[onGuestRegistrationToGas] GAS転記失敗: status=${result.status} body=${result.body}`);
      // 失敗時は error_logs に記録（シンプル1回試行）
      await db.collection("error_logs").add({
        type:    "gas_mirror_failed",
        guestId,
        status:  result.status,
        body:    result.body.substring(0, 500),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (e) {
    console.error(`[onGuestRegistrationToGas] 通信エラー: ${e.message}`);
    await db.collection("error_logs").add({
      type:     "gas_mirror_error",
      guestId,
      message:  e.message,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
};
