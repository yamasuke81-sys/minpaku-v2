/**
 * LINE Messaging API 送信ユーティリティ
 * Push API で1対1メッセージ送信 + Flexメッセージ（GOサイン待ち）
 */
const https = require("https");
const crypto = require("crypto");

// ========== 低レベル送信 ==========

/**
 * LINE Push APIで任意のメッセージを送信
 * @param {string} channelToken
 * @param {string} userId
 * @param {object[]} messages - LINE Messaging APIのメッセージオブジェクト配列
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function pushMessages_(channelToken, userId, messages) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ to: userId, messages });
    const options = {
      hostname: "api.line.me",
      path: "/v2/bot/message/push",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${channelToken}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve({ success: true });
        } else {
          console.error("LINE API エラー:", res.statusCode, data);
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
        }
      });
    });
    req.on("error", (e) => {
      console.error("LINE API 通信エラー:", e.message);
      resolve({ success: false, error: e.message });
    });
    req.write(body);
    req.end();
  });
}

/**
 * LINEにテキストメッセージを送信（既存互換）
 */
function sendLineMessage(channelToken, userId, text) {
  return pushMessages_(channelToken, userId, [
    { type: "text", text: text.slice(0, 5000) },
  ]);
}

// ========== Flexメッセージ（GOサイン待ち） ==========

/**
 * GOサイン待ちのFlexメッセージを生成
 * @param {string} approvalId - Firestore approvals/{approvalId}
 * @param {string} title - 承認依頼のタイトル
 * @param {string} summary - 概要テキスト
 * @param {object} options - { buttons: [{label, action, color}] }
 * @returns {object} LINE Flexメッセージオブジェクト
 */
function buildApprovalFlex(approvalId, title, summary, options = {}) {
  const buttons = options.buttons || [
    { label: "GO", action: "approve", color: "#06C755" },
    { label: "スキップ", action: "reject", color: "#AAAAAA" },
  ];

  return {
    type: "flex",
    altText: `【承認待ち】${title}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1a1a2e",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "🤵 黒子からの確認",
            color: "#FFFFFF",
            size: "xs",
          },
          {
            type: "text",
            text: title,
            color: "#FFFFFF",
            size: "lg",
            weight: "bold",
            wrap: true,
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: summary,
            wrap: true,
            size: "sm",
            color: "#333333",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: buttons.map((btn) => ({
          type: "button",
          action: {
            type: "postback",
            label: btn.label,
            data: `approval=${approvalId}&action=${btn.action}`,
          },
          style: btn.action === "approve" ? "primary" : "secondary",
          color: btn.action === "approve" ? btn.color : undefined,
          height: "sm",
        })),
      },
    },
  };
}

/**
 * GOサイン待ちの承認依頼を送信
 * 1. Firestore secretary/approvals に記録
 * 2. LINE FlexメッセージをオーナーにPush
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} params - { type, title, summary, details, buttons }
 * @returns {Promise<{success: boolean, approvalId?: string, error?: string}>}
 */
async function sendApprovalRequest(db, params) {
  const { type, title, summary, details = {}, buttons } = params;

  // 1. Firestoreに承認待ちレコード作成
  const approvalRef = await db.collection("secretary").doc("approvals")
    .collection("items").add({
      type,
      title,
      summary,
      details,
      status: "waiting",
      createdAt: new Date(),
    });
  const approvalId = approvalRef.id;

  // 2. LINE設定取得
  const settingsDoc = await db.collection("settings").doc("notifications").get();
  if (!settingsDoc.exists) {
    return { success: false, approvalId, error: "LINE設定未登録" };
  }
  const settings = settingsDoc.data();
  const channelToken = settings.lineChannelToken;
  const userId = settings.lineOwnerUserId;
  if (!channelToken || !userId) {
    return { success: false, approvalId, error: "LINE設定不完全" };
  }

  // 3. Flexメッセージ送信
  const flex = buildApprovalFlex(approvalId, title, summary, { buttons });
  const result = await pushMessages_(channelToken, userId, [flex]);

  // 4. 通知ログ記録
  try {
    await db.collection("notifications").add({
      type: "approval_request",
      title,
      body: summary.slice(0, 1000),
      approvalId,
      sentAt: new Date(),
      channel: "line",
      success: result.success,
      error: result.error || null,
    });
  } catch (e) {
    console.error("通知ログ記録エラー:", e);
  }

  return { ...result, approvalId };
}

// ========== Webhook署名検証 ==========

/**
 * LINE Webhook署名を検証
 * @param {string} channelSecret - チャネルシークレット
 * @param {string} signature - X-Line-Signature ヘッダー
 * @param {string|Buffer} body - リクエストボディ
 * @returns {boolean}
 */
function verifySignature(channelSecret, signature, body) {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// ========== 高レベルユーティリティ ==========

/**
 * Firestoreから通知設定を読み取り、LINE/メールで送信+通知ログ記録
 * settings/notifications の enableLine / enableEmail / notifyEmails で制御
 */
async function notifyOwner(db, type, title, body) {
  const settingsDoc = await db.collection("settings").doc("notifications").get();
  if (!settingsDoc.exists) {
    console.warn("通知設定が未登録です（settings/notifications）");
    return { success: false, error: "通知設定未登録" };
  }
  const settings = settingsDoc.data();

  // デフォルト: LINE有効、メール無効（後方互換）
  const enableLine = settings.enableLine !== false;
  const enableEmail = !!settings.enableEmail;
  const notifyEmails = settings.notifyEmails || [];

  const results = [];

  // LINE送信
  if (enableLine) {
    const channelToken = settings.lineChannelToken;
    const userId = settings.lineOwnerUserId;
    if (channelToken && userId) {
      const lineResult = await sendLineMessage(channelToken, userId, body);
      results.push({ channel: "line", ...lineResult });
    } else {
      results.push({ channel: "line", success: false, error: "LINE設定不完全" });
    }
  }

  // メール送信
  if (enableEmail && notifyEmails.length > 0) {
    for (const email of notifyEmails) {
      try {
        await sendNotificationEmail_(email, title, body);
        results.push({ channel: "email", success: true, to: email });
      } catch (e) {
        results.push({ channel: "email", success: false, to: email, error: e.message });
      }
    }
  }

  // 通知ログ記録
  try {
    for (const r of results) {
      await db.collection("notifications").add({
        type,
        title,
        body: body.slice(0, 1000),
        sentAt: new Date(),
        channel: r.channel,
        to: r.to || null,
        success: r.success,
        error: r.error || null,
      });
    }
  } catch (e) {
    console.error("通知ログ記録エラー:", e);
  }

  const anySuccess = results.some((r) => r.success);
  return { success: anySuccess, results };
}

/**
 * Gmail APIでメール通知送信（OAuth2リフレッシュトークン方式）
 */
async function sendNotificationEmail_(to, subject, body) {
  const { google } = require("googleapis");
  const admin = require("firebase-admin");
  const db = admin.firestore();

  // OAuth2設定取得
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) throw new Error("Gmail OAuth2未設定（settings/gmailOAuth）");
  const { clientId, clientSecret } = oauthDoc.data();
  if (!clientId || !clientSecret) throw new Error("OAuth2クライアントID/シークレット未設定");

  // 最初の認証済みアカウントのトークンを使用
  const tokensSnap = await db.collection("settings").doc("gmailOAuth").collection("tokens").limit(1).get();
  if (tokensSnap.empty) throw new Error("Gmail認証済みアカウントなし（設定画面でGmail連携してください）");
  const tokenData = tokensSnap.docs[0].data();
  if (!tokenData.refreshToken) throw new Error("リフレッシュトークンなし");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // RFC 2822形式のメール本文を作成
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const messageParts = [
    `From: ${senderEmail}`,
    `To: ${to}`,
    `Subject: ${utf8Subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  const message = messageParts.join("\n");
  const encodedMessage = Buffer.from(message).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodedMessage },
  });
}

module.exports = {
  sendLineMessage,
  pushMessages_,
  buildApprovalFlex,
  sendApprovalRequest,
  verifySignature,
  notifyOwner,
};
