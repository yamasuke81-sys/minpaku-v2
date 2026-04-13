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

// ========== 通知設定ヘルパー ==========

/**
 * 通知設定を取得（フィールド名の互換性対応付き）
 * @returns {{ settings: object|null, channelToken: string|null, ownerUserId: string|null, groupId: string|null }}
 */
async function getNotificationSettings_(db) {
  const settingsDoc = await db.collection("settings").doc("notifications").get();
  if (!settingsDoc.exists) return { settings: null };
  const s = settingsDoc.data();
  return {
    settings: s,
    // フィールド名の互換性対応（フロント lineToken / バック lineChannelToken）
    channelToken: s.lineChannelToken || s.lineToken || null,
    ownerUserId: s.lineOwnerUserId || s.lineOwnerId || null,
    groupId: s.lineGroupId || null,
  };
}

/**
 * 通知種別ごとの送信先を判定
 * settings.channels[notifyType].targets で制御（デフォルト: "both"）
 * @param {object} settings - settings/notifications ドキュメント
 * @param {string} notifyType - 通知種別キー（例: "recruit_start"）
 * @returns {{ enabled: boolean, sendToGroup: boolean, sendToIndividual: boolean }}
 */
function resolveNotifyTargets(settings, notifyType) {
  if (!settings || !settings.channels) {
    return { enabled: true, sendToGroup: true, sendToIndividual: true };
  }
  const ch = settings.channels[notifyType];
  if (!ch) {
    return { enabled: true, sendToGroup: true, sendToIndividual: true };
  }
  if (ch.enabled === false) {
    return { enabled: false, sendToGroup: false, sendToIndividual: false };
  }
  const targets = ch.targets || "both";
  return {
    enabled: true,
    sendToGroup: targets === "both" || targets === "group",
    sendToIndividual: targets === "both" || targets === "individual",
  };
}

// ========== スタッフ・グループ通知 ==========

/**
 * 個別スタッフにLINE通知送信
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} staffId - Firestoreのstaff/{staffId}
 * @param {string} type - 通知種別
 * @param {string} title - タイトル（ログ用）
 * @param {string|object} body - テキスト文字列 or Flexメッセージオブジェクト
 */
async function notifyStaff(db, staffId, type, title, body) {
  // スタッフのlineUserId取得
  const staffDoc = await db.collection("staff").doc(staffId).get();
  if (!staffDoc.exists) {
    return { success: false, error: "スタッフが見つかりません" };
  }
  const staffData = staffDoc.data();
  const lineUserId = staffData.lineUserId;
  if (!lineUserId) {
    return { success: false, error: "LINE未連携", staffName: staffData.name };
  }

  // 通知設定取得
  const { channelToken } = await getNotificationSettings_(db);
  if (!channelToken) {
    return { success: false, error: "LINEチャネルトークン未設定" };
  }

  // メッセージ構築
  const messages = typeof body === "string"
    ? [{ type: "text", text: body.slice(0, 5000) }]
    : [body]; // Flexメッセージ等のオブジェクト

  const result = await pushMessages_(channelToken, lineUserId, messages);

  // 通知ログ
  try {
    await db.collection("notifications").add({
      type,
      title,
      body: typeof body === "string" ? body.slice(0, 1000) : `[Flex] ${title}`,
      staffId,
      staffName: staffData.name,
      sentAt: new Date(),
      channel: "line",
      target: "individual",
      success: result.success,
      error: result.error || null,
    });
  } catch (e) {
    console.error("通知ログ記録エラー:", e);
  }

  return { ...result, staffName: staffData.name };
}

/**
 * LINEグループに通知送信
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} type - 通知種別
 * @param {string} title - タイトル（ログ用）
 * @param {string|object} body - テキスト文字列 or Flexメッセージオブジェクト
 */
async function notifyGroup(db, type, title, body) {
  const { channelToken, groupId } = await getNotificationSettings_(db);
  if (!channelToken) {
    return { success: false, error: "LINEチャネルトークン未設定" };
  }
  if (!groupId) {
    return { success: false, error: "LINEグループID未設定" };
  }

  const messages = typeof body === "string"
    ? [{ type: "text", text: body.slice(0, 5000) }]
    : [body];

  const result = await pushMessages_(channelToken, groupId, messages);

  try {
    await db.collection("notifications").add({
      type,
      title,
      body: typeof body === "string" ? body.slice(0, 1000) : `[Flex] ${title}`,
      sentAt: new Date(),
      channel: "line",
      target: "group",
      success: result.success,
      error: result.error || null,
    });
  } catch (e) {
    console.error("通知ログ記録エラー:", e);
  }

  return result;
}

// ========== 募集通知用Flexメッセージ ==========

/**
 * 清掃スタッフ募集のFlexメッセージを生成
 * @param {object} recruitment - { checkoutDate, propertyName, memo }
 * @param {string} baseUrl - アプリのベースURL
 * @returns {object} LINE Flexメッセージオブジェクト
 */
function buildRecruitmentFlex(recruitment, baseUrl) {
  const { checkoutDate, propertyName, memo } = recruitment;
  const title = `${checkoutDate} 清掃スタッフ募集`;
  const bodyText = [
    `📅 日付: ${checkoutDate}`,
    propertyName ? `🏠 物件: ${propertyName}` : "",
    memo ? `📝 ${memo}` : "",
    "",
    "回答をお願いします（◎OK / △微妙 / ×NG）",
  ].filter(Boolean).join("\n");

  return {
    type: "flex",
    altText: `【募集】${title}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#2196F3",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "🧹 清掃スタッフ募集",
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
            text: bodyText,
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
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "回答する",
              uri: `${baseUrl}#/my-recruitment`,
            },
            style: "primary",
            color: "#2196F3",
            height: "sm",
          },
        ],
      },
    },
  };
}

// ========== 高レベルユーティリティ ==========

/**
 * Firestoreから通知設定を読み取り、LINE/メールで送信+通知ログ記録
 * settings/notifications の enableLine / enableEmail / notifyEmails で制御
 */
async function notifyOwner(db, type, title, body) {
  const { settings, channelToken, ownerUserId } = await getNotificationSettings_(db);
  if (!settings) {
    console.warn("通知設定が未登録です（settings/notifications）");
    return { success: false, error: "通知設定未登録" };
  }

  // デフォルト: LINE有効、メール無効（後方互換）
  const enableLine = settings.enableLine !== false;
  const enableEmail = !!settings.enableEmail;
  const notifyEmails = settings.notifyEmails || [];

  const results = [];

  // LINE送信（フォールバック対応済みのchannelToken/ownerUserIdを使用）
  if (enableLine) {
    if (channelToken && ownerUserId) {
      const lineResult = await sendLineMessage(channelToken, ownerUserId, body);
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
    `From: ${tokenData.email || "me"}`,
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
  notifyStaff,
  notifyGroup,
  buildRecruitmentFlex,
  resolveNotifyTargets,
  getNotificationSettings_,
  sendNotificationEmail_,
};
