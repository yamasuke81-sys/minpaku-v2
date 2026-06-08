/**
 * Hosting 停止からの復活を検知して通知する一時的な scheduled function。
 *
 * 背景:
 *  - 2026-05-29 Google Cloud Trust & Safety がプロジェクトを利用規約違反 (phishing 疑い) と判定
 *  - minpaku-v2.web.app が suspended になり、Hosting 全 site が "Site Not Found" を返す状態
 *  - 異議申立て (appeal) を提出済。24-72h で審査結果が出る
 *
 * 【方針変更 2026-06-08】メインは v2-5-relay.web.app を恒久運用とする。
 *  - 凍結解除後も relay をメインとする (ユーザー決定)
 *  - そのため復活を検知しても appUrl は minpaku-v2 に戻さない (通知のみ)
 *
 * 動作:
 *  - 毎時 30分 に https://minpaku-v2.web.app/ を叩く
 *  - HTTP 200 が返り、レスポンスに "Site Not Found" 文字列が含まれなければ復活と判定
 *  - settings/hostingWatch/state.recovered=true を立てて以降の通知を抑止
 *  - 復活時のみ「復活したが relay 継続」を 1 回だけ通知 (appUrl は変更しない)
 */
const admin = require("firebase-admin");
const https = require("https");
const { notifyByKey } = require("../utils/lineNotify");

const TARGET_URL = "https://minpaku-v2.web.app/";

function fetchOnce(url) {
  return new Promise((resolve) => {
    const req = https.get(url + (url.includes("?") ? "&" : "?") + "cb=" + Date.now(), { timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c.toString("utf8", 0, Math.min(c.length, 2000)); });
      res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 2000) }));
    });
    req.on("error", (e) => resolve({ status: 0, body: `ERR: ${e.message}` }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "TIMEOUT" }); });
  });
}

module.exports = async function watchHostingRecovery() {
  const db = admin.firestore();
  const stateRef = db.collection("settings").doc("hostingWatch");
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? stateSnap.data() : {};

  if (state.recovered) {
    console.log("[watchHostingRecovery] 既に recovered フラグ立ち。スキップ");
    return;
  }

  const r = await fetchOnce(TARGET_URL);
  const isUp = r.status === 200 && !/Site Not Found/i.test(r.body || "");
  console.log(`[watchHostingRecovery] status=${r.status} up=${isUp}`);

  // ステータス履歴を残す (デバッグ用)
  await stateRef.set({
    lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastStatus: r.status,
    lastUp: isUp,
  }, { merge: true });

  if (!isUp) return;

  // 復活検知 → 通知のみ。relay を恒久メインとするため appUrl は minpaku-v2 に戻さない。
  try {
    await notifyByKey(db, "error_alert", {
      title: "✅ minpaku-v2.web.app 復活検知 (メインは relay 継続)",
      body: `Hosting (minpaku-v2.web.app) が復活しました。\n\nURL: ${TARGET_URL}\nHTTP: ${r.status}\n\n[方針] メインは v2-5-relay.web.app を恒久運用します。\n- appUrl は relay のまま (自動で minpaku-v2 に戻しません)\n- 凍結解除後も relay をメインとする (ユーザー決定 2026-06-08)`,
      vars: { url: TARGET_URL, status: String(r.status) },
      propertyId: null,
    });
    await stateRef.set({
      recovered: true,
      recoveredAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log("[watchHostingRecovery] 復活検知。relayメイン継続のため appUrl は変更せず通知のみ");
  } catch (e) {
    console.error("[watchHostingRecovery] 通知失敗:", e.message);
  }
};
