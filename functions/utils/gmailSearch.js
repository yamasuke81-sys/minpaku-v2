/**
 * 物件 Gmail の読み取り検索 (メタデータのみ)
 *
 * 予約詳細の履歴タイムラインで「ゲストとの実際のメール往復」を出すために使う。
 * 送信に使っている OAuth トークン (settings/gmailOAuth[EmailVerification]/tokens) を
 * そのまま読み取りに再利用する。messages.get は format=metadata なので**既読状態は変わらない**。
 */
const { google } = require("googleapis");

/** fromEmail に対応する Gmail クライアントを作る。トークンが無ければ null */
async function getGmailClientForAddress_(db, address) {
  if (!address) return null;
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) return null;
  const { clientId, clientSecret } = oauthDoc.data() || {};
  if (!clientId || !clientSecret) return null;

  const cols = [
    db.collection("settings").doc("gmailOAuth").collection("tokens"),
    db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
  ];
  let tokenData = null;
  for (const col of cols) {
    const snap = await col.where("email", "==", address).limit(1).get();
    if (!snap.empty) { tokenData = snap.docs[0].data(); break; }
  }
  if (!tokenData || !tokenData.refreshToken) return null;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
  return { gmail: google.gmail({ version: "v1", auth: oauth2Client }), account: tokenData.email || address };
}

function header_(headers, name) {
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

/**
 * 物件メールボックスから、指定アドレスとの送受信メールを新しい順に取得する。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} mailboxAddress 検索するメールボックス (物件の senderGmail)
 * @param {string} counterpartEmail 相手のメールアドレス
 * @param {number} [limit=15]
 * @returns {Promise<Array<{id,threadId,subject,from,to,date,snippet,outgoing,account}>>}
 *   トークンが無い/失敗した場合は空配列 (履歴表示は他のイベントで続行させる)
 */
async function searchMailWithGuest_(db, mailboxAddress, counterpartEmail, limit = 15) {
  if (!counterpartEmail) return [];
  try {
    const client = await getGmailClientForAddress_(db, mailboxAddress);
    if (!client) return [];
    const { gmail, account } = client;

    // 送信済み・受信の両方。in:anywhere で アーカイブ/迷惑メールも拾う
    const q = `in:anywhere {from:${counterpartEmail} to:${counterpartEmail}}`;
    const listRes = await gmail.users.messages.list({ userId: "me", q, maxResults: limit });
    const ids = (listRes.data.messages || []).map((m) => m.id);
    if (!ids.length) return [];

    const metas = await Promise.all(ids.map((id) =>
      gmail.users.messages.get({
        userId: "me", id, format: "metadata",
        metadataHeaders: ["Subject", "From", "To", "Date"],
      }).then((r) => r.data).catch(() => null),
    ));

    return metas.filter(Boolean).map((m) => {
      const headers = (m.payload && m.payload.headers) || [];
      const from = header_(headers, "From");
      const labels = m.labelIds || [];
      return {
        id: m.id,
        threadId: m.threadId,
        subject: header_(headers, "Subject"),
        from,
        to: header_(headers, "To"),
        date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
        snippet: m.snippet || "",
        // SENT ラベル or From が自分のアドレス → こちらから送ったメール
        outgoing: labels.includes("SENT") || String(from).includes(account),
        account,
      };
    });
  } catch (e) {
    console.warn("[gmailSearch] 取得失敗 (履歴は他のイベントで続行):", e.message);
    return [];
  }
}

module.exports = { searchMailWithGuest_, getGmailClientForAddress_ };
