/**
 * LINE Bot Info 取得ヘルパー
 *
 * Channel Access Token から GET /v2/bot/info を呼んで
 * Bot の displayName / basicId / userId / pictureUrl を取得する。
 *
 * 参考: https://developers.line.biz/ja/reference/messaging-api/#get-bot-info
 */
const https = require("https");

function fetchLineBotInfo(token) {
  return new Promise((resolve) => {
    if (!token || typeof token !== "string") return resolve(null);
    const req = https.request({
      method: "GET",
      hostname: "api.line.me",
      path: "/v2/bot/info",
      headers: { "Authorization": `Bearer ${token}` },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.warn(`[fetchLineBotInfo] HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          return resolve(null);
        }
        try {
          const j = JSON.parse(data);
          resolve({
            userId: j.userId || null,
            basicId: j.basicId || null,         // "@xxx" 形式
            premiumId: j.premiumId || null,
            displayName: j.displayName || null,
            pictureUrl: j.pictureUrl || null,
            fetchedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.warn(`[fetchLineBotInfo] JSON parse error`, e);
          resolve(null);
        }
      });
    });
    req.on("error", (e) => {
      console.warn(`[fetchLineBotInfo] request error`, e);
      resolve(null);
    });
    req.end();
  });
}

module.exports = { fetchLineBotInfo };
