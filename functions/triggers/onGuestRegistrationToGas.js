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
 * GAS Web アプリは POST 成功時に必ず 302 で script.googleusercontent.com へ
 * リダイレクトする仕様のため、302/301/303 は Location へ GET で追従して
 * 実際の実行結果を取得する（追従しないと常に「失敗」扱いになる）
 * @param {string} url
 * @param {object} payload
 * @returns {Promise<{ status: number, body: string, redirectedTo: string|null }>}
 */
function postJson_(url, payload) {
  const jsonStr = JSON.stringify(payload);
  const request = (targetUrl, method, redirectsLeft, redirectedTo) => new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: method === "POST" ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonStr),
      } : {},
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        const loc = res.headers.location;
        if ([301, 302, 303].includes(res.statusCode) && loc && redirectsLeft > 0) {
          resolve(request(loc, "GET", redirectsLeft - 1, loc));
        } else {
          resolve({ status: res.statusCode, body, redirectedTo: redirectedTo || null });
        }
      });
    });
    req.on("error", reject);
    if (method === "POST") req.write(jsonStr);
    req.end();
  });
  return request(url, "POST", 3, null);
}

const sleep_ = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * リダイレクト先の一過性 404 のみ、少し待って GET を1回だけ再試行する。
 * 302→GET の echo URL が Google 側の伝播遅延で「ページが見つかりません」を返すことがあり、
 * その場合 doPost 自体は実行済み＝転記は成功していることが多い。
 * @param {string} echoUrl 302で返ってきたリダイレクト先URL
 * @returns {Promise<{ status: number, body: string }>}
 */
async function retryGetOnce_(echoUrl) {
  await sleep_(3000);
  return new Promise((resolve, reject) => {
    const parsed = new URL(echoUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
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
    let result = await postJson_(config.gasUrl, payload);

    // 一過性 404: echo URL の伝播遅延で「ページが見つかりません」が返ることがある。
    // 3秒待って GET を1回だけ再試行。成功すれば通知抑制、失敗なら通常のエラー扱い。
    if (result.status === 404 && result.redirectedTo) {
      console.warn(`[onGuestRegistrationToGas] 404を検知→3秒待って再試行: guestId=${guestId}`);
      const retry = await retryGetOnce_(result.redirectedTo);
      if (retry.status === 200) {
        console.log(`[onGuestRegistrationToGas] GAS転記成功(retry): guestId=${guestId} name=${guest.guestName}`);
        return;
      }
      // リトライも失敗した場合は元エラーで通知（body は元の 404 のままにする）
    }

    if (result.status === 200) {
      console.log(`[onGuestRegistrationToGas] GAS転記成功: guestId=${guestId} name=${guest.guestName}`);
    } else {
      console.error(`[onGuestRegistrationToGas] GAS転記失敗: status=${result.status} body=${result.body}`);
      await db.collection("error_logs").add({
        type:         "gas_mirror_failed",
        functionName: "onGuestRegistrationToGas",
        errorMessage: `GAS転記失敗 HTTP ${result.status}（guestId=${guestId} name=${guest.guestName || "?"}）— 先にスプシで該当行の有無を確認してください（一過性エラーで実は転記済みの可能性あり）`,
        severity:     "warning",
        guestId,
        status:       result.status,
        body:         (result.body || "").substring(0, 500),
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (e) {
    console.error(`[onGuestRegistrationToGas] 通信エラー: ${e.message}`);
    await db.collection("error_logs").add({
      type:         "gas_mirror_error",
      functionName: "onGuestRegistrationToGas",
      errorMessage: `GAS転記 通信エラー: ${e.message}（guestId=${guestId}）`,
      severity:     "warning",
      guestId,
      message:      e.message,
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    });
  }
};
