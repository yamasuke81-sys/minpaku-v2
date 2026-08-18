/**
 * メール配信停止(オプトアウト)のトークン処理 — 純粋関数
 *
 * 配信停止は「リンクを開いた時点で完了」させる。受信者にアドレスを入力させない。
 * そのため宛先ごとに署名付きトークンを発行し、リンクに埋め込む。
 * 署名鍵は Firestore の settings/marketing.optoutSecret（呼び出し側が渡す）。
 *
 * メール本文を組み立てるスクリプトと Cloud Functions の両方から require して、
 * トークン形式が食い違わないようにする。
 */
const crypto = require("crypto");

const normalizeEmail = (s) => String(s || "").trim().toLowerCase();

// 停止リストのドキュメントID。メールアドレスをそのままIDにしないための固定長ハッシュ
const emailKey = (email) =>
  crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 40);

const signEmail = (email, secret) =>
  crypto.createHmac("sha256", secret).update(normalizeEmail(email)).digest("base64url").slice(0, 22);

// トークン = base64url(メールアドレス).署名
function buildOptoutToken(email, secret) {
  const e = normalizeEmail(email);
  if (!e.includes("@")) throw new Error("メールアドレスが不正です: " + email);
  if (!secret) throw new Error("署名鍵が空です");
  return `${Buffer.from(e, "utf8").toString("base64url")}.${signEmail(e, secret)}`;
}

// トークンを検証してメールアドレスを返す。改竄・破損していれば null
function parseOptoutToken(token, secret) {
  if (!secret) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  if (!b64 || !sig) return null;

  let email;
  try {
    email = normalizeEmail(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!email.includes("@")) return null;

  const expected = signEmail(email, secret);
  // 長さが違うと timingSafeEqual が例外を投げるので先に弾く
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return email;
}

module.exports = { normalizeEmail, emailKey, buildOptoutToken, parseOptoutToken };
