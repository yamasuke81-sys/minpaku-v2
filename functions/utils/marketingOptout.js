/**
 * メール配信停止(オプトアウト)の共有ヘルパー
 *
 * 署名鍵とトークン発行を1箇所に集約する。
 * 呼び出し元:
 *   - api/public.js            … POST /public/marketing-optout (停止を受け付ける側)
 *   - scheduled/ugcFollowMail  … 案内メールに宛先ごとの停止リンクを差し込む側
 *
 * トークンの形式は api/marketing-optout-logic.js の純粋関数が持つ。
 * 発行側と検証側で食い違わないよう、どちらもここを経由する。
 */
const admin = require("firebase-admin");
const { buildOptoutToken, emailKey, normalizeEmail } = require("../api/marketing-optout-logic");

// 停止リンクの掲載先。宿サブドメインには置いていないので必ずトップを使う
const OPTOUT_PAGE = "https://setouchi-stay.com/ugc-optout";

/**
 * 配信停止リンクの署名鍵。無ければ初回に生成して settings/marketing に保存する
 * @returns {Promise<string>}
 */
async function getOptoutSecret_() {
  const db = admin.firestore();
  const ref = db.collection("settings").doc("marketing");
  const snap = await ref.get();
  const existing = snap.exists ? snap.data().optoutSecret : null;
  if (existing) return existing;
  const secret = require("crypto").randomBytes(32).toString("hex");
  await ref.set({ optoutSecret: secret }, { merge: true });
  return secret;
}

/**
 * 宛先ごとの配信停止URL (開いた時点で停止が完了する)
 * @param {string} email
 * @param {string} secret getOptoutSecret_() の戻り値
 * @returns {string}
 */
function buildOptoutUrl(email, secret) {
  return `${OPTOUT_PAGE}?t=${buildOptoutToken(email, secret)}`;
}

/**
 * 配信停止済みかどうか。停止していれば true (=送ってはいけない)
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function isSuppressed_(db, email) {
  const e = normalizeEmail(email);
  if (!e.includes("@")) return true; // 壊れたアドレスは送らない扱い
  const snap = await db.collection("marketingSuppressions").doc(emailKey(e)).get();
  return snap.exists && snap.data().optedOut === true;
}

module.exports = { getOptoutSecret_, buildOptoutUrl, isSuppressed_, OPTOUT_PAGE };
