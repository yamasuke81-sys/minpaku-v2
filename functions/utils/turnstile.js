/**
 * Cloudflare Turnstile 検証ユーティリティ
 *
 * settings/directBooking.turnstileSecret が未設定の場合は検証をスキップする
 * (宿サイト側にウィジェット未導入の間も /public/booking-request を動かせるようにするため)。
 *
 * 参考: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
const https = require("https");

/**
 * siteverify エンドポイントを呼び出してトークンを検証する
 * @param {string} secret - settings/directBooking.turnstileSecret
 * @param {string} token - フロントから送られてきた turnstileToken
 * @param {string} [remoteIp]
 * @returns {Promise<{success:boolean, errorCodes?:string[]}>}
 */
function verifyTurnstileToken(secret, token, remoteIp) {
  return new Promise((resolve) => {
    if (!secret || !token) return resolve({ success: false, errorCodes: ["missing-input"] });
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const payload = body.toString();
    const req = https.request({
      method: "POST",
      hostname: "challenges.cloudflare.com",
      path: "/turnstile/v0/siteverify",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve({ success: j.success === true, errorCodes: j["error-codes"] || [] });
        } catch (e) {
          console.warn("[turnstile] レスポンス解析失敗:", e.message);
          resolve({ success: false, errorCodes: ["parse-error"] });
        }
      });
    });
    req.on("error", (e) => {
      console.warn("[turnstile] リクエストエラー:", e.message);
      resolve({ success: false, errorCodes: ["request-error"] });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * settings/directBooking から turnstileSecret を取得する。未設定なら null。
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<string|null>}
 */
async function getTurnstileSecret(db) {
  try {
    const doc = await db.collection("settings").doc("directBooking").get();
    return doc.exists ? (doc.data().turnstileSecret || null) : null;
  } catch (e) {
    console.warn("[turnstile] settings/directBooking 取得失敗:", e.message);
    return null;
  }
}

module.exports = { verifyTurnstileToken, getTurnstileSecret };
