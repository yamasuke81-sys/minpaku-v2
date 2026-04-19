/**
 * LINE Messaging API 送信ユーティリティ
 * Push API で1対1メッセージ送信 + Flexメッセージ（GOサイン待ち）
 */
const https = require("https");
const crypto = require("crypto");

// エミュレータ環境では実送信をスキップしてコンソールに出力する
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";

// ========== 低レベル送信 ==========

/**
 * LINE Push APIで任意のメッセージを送信
 * @param {string} channelToken
 * @param {string} userId
 * @param {object[]} messages - LINE Messaging APIのメッセージオブジェクト配列
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function pushMessages_(channelToken, userId, messages) {
  if (IS_EMULATOR) {
    console.log("[EMULATOR] would send LINE push:", { to: userId, messages });
    return Promise.resolve({ ok: true, stub: true });
  }
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
 * オーナーLINE通知を送信する（ownerLineChannels 対応）
 * ownerLineChannels[] があれば戦略に従い複数 Bot でフォールバック送信。
 * なければ従来の単一チャネル（channelToken / ownerUserId）にフォールバック。
 *
 * @param {object} settings - settings/notifications ドキュメント
 * @param {string|null} fallbackToken - 後方互換用トークン
 * @param {string|null} fallbackUserId - 後方互換用 User ID
 * @param {string} text - 送信テキスト
 * @returns {Promise<{success: boolean, error?: string, usedChannel?: string}>}
 */
async function _sendOwnerLine_(settings, fallbackToken, fallbackUserId, text) {
  const ownerChannels = Array.isArray(settings.ownerLineChannels)
    ? settings.ownerLineChannels.filter(c => c.token && c.userId)
    : [];

  // ownerLineChannels が設定されている場合は複数 Bot 対応ロジックを使う
  if (ownerChannels.length > 0) {
    const strategy = settings.ownerLineChannelStrategy || "fallback";

    if (strategy === "roundrobin" && ownerChannels.length > 1) {
      // 日付 % チャネル数 でインデックス選択
      const idx = new Date().getDate() % ownerChannels.length;
      const primary = ownerChannels[idx];
      const secondary = ownerChannels[(idx + 1) % ownerChannels.length];
      let result = await sendLineMessage(primary.token, primary.userId, text);
      if (!result.success) {
        console.warn(`[LINE] ownerLine roundrobin 1番目(${primary.name || "Bot"})失敗、2番目を試みます:`, result.error);
        result = await sendLineMessage(secondary.token, secondary.userId, text);
        if (result.success) result.usedChannel = secondary.name || "Bot#2";
      } else {
        result.usedChannel = primary.name || "Bot#1";
      }
      return result;
    } else {
      // fallback: 残枠 > 0 のチャネルから順に試みる
      for (const ch of ownerChannels) {
        const quota = await getChannelQuota(ch.token);
        if (quota.remaining > 0) {
          const result = await sendLineMessage(ch.token, ch.userId, text);
          if (result.success) {
            return { ...result, usedChannel: ch.name || ch.userId };
          }
          console.warn(`[LINE] ownerLine fallback チャネル「${ch.name || ch.userId}」送信失敗:`, result.error);
        } else {
          console.warn(`[LINE] ownerLine チャネル「${ch.name || ch.userId}」無料枠枯渇 (used=${quota.used}/${quota.max})`);
        }
      }
      return { success: false, error: "ownerLineChannels: 全チャネルで無料枠枯渇または送信失敗" };
    }
  }

  // 後方互換: ownerLineChannels が空なら従来の単一チャネルを使う
  if (fallbackToken && fallbackUserId) {
    return sendLineMessage(fallbackToken, fallbackUserId, text);
  }
  return { success: false, error: "オーナーLINE User ID 未設定（lineOwnerUserId）" };
}

/**
 * 通知種別ごとの送信先を判定
 * settings.channels[notifyType] の ownerLine / groupLine / ownerEmail / fcmStaff / fcmOwner で制御
 * @param {object} settings - settings/notifications ドキュメント
 * @param {string} notifyType - 通知種別キー（例: "recruit_start"）
 * @returns {{ enabled: boolean, ownerLine: boolean, groupLine: boolean, staffLine: boolean, ownerEmail: boolean, fcmStaff: boolean, fcmOwner: boolean, sendToGroup: boolean, sendToIndividual: boolean }}
 */
function resolveNotifyTargets(settings, notifyType) {
  const defaults = { enabled: true, ownerLine: true, groupLine: false, staffLine: false, ownerEmail: false, discordOwner: false, discordSubOwner: false, fcmStaff: false, fcmOwner: false, sendToGroup: false, sendToIndividual: true };
  if (!settings || !settings.channels) return defaults;
  const ch = settings.channels[notifyType];
  if (!ch) return defaults;
  if (ch.enabled === false) {
    return { enabled: false, ownerLine: false, groupLine: false, staffLine: false, ownerEmail: false, discordOwner: false, discordSubOwner: false, fcmStaff: false, fcmOwner: false, sendToGroup: false, sendToIndividual: false };
  }

  // 新形式: ownerLine / groupLine / staffLine / ownerEmail / discordOwner / discordSubOwner / fcmStaff / fcmOwner
  if (ch.ownerLine !== undefined || ch.groupLine !== undefined || ch.staffLine !== undefined || ch.ownerEmail !== undefined || ch.discordOwner !== undefined || ch.discordSubOwner !== undefined || ch.fcmStaff !== undefined || ch.fcmOwner !== undefined) {
    const ownerLine = ch.ownerLine !== false;
    const groupLine = !!ch.groupLine;
    const staffLine = !!ch.staffLine;
    const ownerEmail = !!ch.ownerEmail;
    const discordOwner = !!ch.discordOwner;
    const discordSubOwner = !!ch.discordSubOwner;
    // FCMチャネル（Web Push）
    const fcmStaff = !!ch.fcmStaff;
    const fcmOwner = !!ch.fcmOwner;
    return {
      enabled: true,
      ownerLine,
      groupLine,
      staffLine,
      ownerEmail,
      discordOwner,
      discordSubOwner,
      fcmStaff,
      fcmOwner,
      // 後方互換
      sendToGroup: groupLine,
      sendToIndividual: staffLine,
    };
  }

  // 旧形式互換: targets ("both"/"group"/"individual")
  const targets = ch.targets || "both";
  return {
    enabled: true,
    ownerLine: targets === "both" || targets === "individual",
    groupLine: targets === "both" || targets === "group",
    staffLine: targets === "both" || targets === "individual",
    ownerEmail: !!(ch.channel === "email" || ch.channel === "both"),
    fcmStaff: false,
    fcmOwner: false,
    sendToGroup: targets === "both" || targets === "group",
    sendToIndividual: targets === "both" || targets === "individual",
  };
}

// ========== スタッフ・グループ通知 ==========

/**
 * settings/notifications の channels[type].customMessage を読んで
 * {変数名} を vars オブジェクトで置換した文字列を返す。カスタムなしなら fallback を返す。
 */
async function resolveMessage_(db, type, fallback, vars) {
  try {
    if (typeof fallback !== "string") return fallback; // Flex等はカスタム対象外
    const doc = await db.collection("settings").doc("notifications").get();
    if (!doc.exists) return fallback;
    const ch = (doc.data().channels || {})[type];
    if (!ch || !ch.customMessage || !String(ch.customMessage).trim()) return fallback;
    let msg = String(ch.customMessage);
    if (vars && typeof vars === "object") {
      Object.keys(vars).forEach(k => {
        msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k] ?? ""));
      });
    }
    return msg;
  } catch (e) {
    console.warn("customMessage 解決失敗、fallback 使用:", e.message);
    return fallback;
  }
}

/**
 * 個別スタッフにLINE通知送信
 * @param {string} staffId
 * @param {string} type - 通知種別（settings.channels のキー）
 * @param {string} title - ログ用タイトル
 * @param {string|object} body - デフォルトテキスト or Flex（customMessageがあれば置換）
 * @param {object} [vars] - customMessage 内の {変数名} に差し込む値
 */
async function notifyStaff(db, staffId, type, title, body, vars) {
  body = await resolveMessage_(db, type, body, vars);
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
 * @param {string} type 通知種別キー
 * @param {string|object} body デフォルト or Flex
 * @param {object} [vars] customMessage 置換用変数
 */
async function notifyGroup(db, type, title, body, vars) {
  body = await resolveMessage_(db, type, body, vars);
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
async function notifyOwner(db, type, title, body, vars) {
  body = await resolveMessage_(db, type, body, vars);
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

  // LINE送信
  if (enableLine) {
    const lineResult = await _sendOwnerLine_(settings, channelToken, ownerUserId, body);
    results.push({ channel: "line", ...lineResult });
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
 * Discord Webhook に通知を送信
 * @param {string} webhookUrl Discord Webhook URL
 * @param {string} content テキスト (最大2000文字)
 */
function sendDiscord_(webhookUrl, content) {
  if (IS_EMULATOR) {
    console.log("[EMULATOR] would send Discord webhook:", { webhookUrl, content });
    return Promise.resolve({ ok: true, stub: true });
  }
  return new Promise((resolve) => {
    try {
      const u = new URL(webhookUrl);
      const body = JSON.stringify({ content: String(content || "").slice(0, 1900) });
      const options = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "minpaku-v2-bot",
        },
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ success: true });
          else resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
        });
      });
      req.on("error", (e) => resolve({ success: false, error: e.message }));
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ success: false, error: "不正なDiscord Webhook URL: " + e.message });
    }
  });
}

/**
 * Gmail APIでメール通知送信（OAuth2リフレッシュトークン方式）
 */
async function sendNotificationEmail_(to, subject, body) {
  if (IS_EMULATOR) {
    console.log("[EMULATOR] would send email:", { to, subject, body });
    return { ok: true, stub: true };
  }
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

// ========== 物件別 LINE 送信 ==========

/**
 * LINE Messaging API の残通数を取得する
 * @param {string} token - チャネルアクセストークン
 * @returns {Promise<{max: number, used: number, remaining: number}>}
 */
async function getChannelQuota(token) {
  if (IS_EMULATOR) {
    // エミュレータ環境では常に残枠ありとして扱う
    return { max: 200, used: 0, remaining: 200 };
  }
  try {
    const [quotaRes, consumRes] = await Promise.all([
      _httpsGet_("https://api.line.me/v2/bot/message/quota", token),
      _httpsGet_("https://api.line.me/v2/bot/message/quota/consumption", token),
    ]);
    // quota.value: "limited" プランは 200、"unlimited" は -1
    const max = (quotaRes.type === "limited" ? quotaRes.value : 999999) || 200;
    const used = consumRes.totalUsage || 0;
    return { max, used, remaining: max - used };
  } catch (e) {
    console.error("[LINE] quota取得失敗:", e.message);
    // エラー時は「残枠あり」として送信を試みる（保守的な対応）
    return { max: 200, used: 0, remaining: 200 };
  }
}

/**
 * HTTPS GET を Promise でラップ（LINE API 用）
 * @param {string} url
 * @param {string} token
 * @returns {Promise<object>}
 */
function _httpsGet_(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSONパースエラー: " + data.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * 1チャネルで送信を試みる（内部ヘルパー）
 * @param {{token: string, groupId: string}} ch
 * @param {string} text
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function _trySendOne_(ch, text) {
  return sendLineMessage(ch.token, ch.groupId, text);
}

/**
 * 物件ごとの LINE チャネルでメッセージを送信する。
 * 複数チャネル (lineChannels[]) があれば lineChannelStrategy に従い送信先を選択。
 * なければ旧単一フィールド → settings/notifications の共通設定へフォールバック。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} propertyId
 * @param {string} text
 * @param {object} [logExtra] - notifications コレクションに追記するフィールド
 * @returns {Promise<{success: boolean, usedChannel: "property_multi"|"property"|"global", channelName?: string, error?: string}>}
 */
async function sendLineMessageForProperty(db, propertyId, text, logExtra = {}) {
  let result = null;
  let usedChannel = "global";
  let usedChannelName = null;

  // ---- 物件ドキュメントから LINE 設定を取得 ----
  if (propertyId) {
    try {
      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (propDoc.exists) {
        const pd = propDoc.data();

        // 複数チャネル設定がある場合
        let channels = Array.isArray(pd.lineChannels) ? pd.lineChannels : [];

        // 旧単一フィールドを lineChannels が空の場合の互換として追加
        if (channels.length === 0 && pd.lineEnabled && pd.lineChannelToken && pd.lineGroupId) {
          channels = [{
            token: pd.lineChannelToken,
            groupId: pd.lineGroupId,
            name: pd.lineChannelName || "",
            enabled: true,
          }];
        }

        // enabled=true かつ token/groupId が揃っているチャネルのみ対象
        const activeChannels = channels.filter(c => c.enabled && c.token && c.groupId);

        if (activeChannels.length > 0) {
          const strategy = pd.lineChannelStrategy || "fallback";

          if (strategy === "roundrobin" && activeChannels.length > 1) {
            // 日付 % チャネル数 でインデックス選択
            const idx = new Date().getDate() % activeChannels.length;
            const primary = activeChannels[idx];
            const secondary = activeChannels[(idx + 1) % activeChannels.length];
            result = await _trySendOne_(primary, text);
            if (!result.success) {
              console.warn("[LINE] roundrobin 1番目失敗、2番目を試みます:", result.error);
              result = await _trySendOne_(secondary, text);
              usedChannelName = result.success ? secondary.name : null;
            } else {
              usedChannelName = primary.name;
            }
          } else {
            // fallback: 残枠が多い順に試みる
            for (const ch of activeChannels) {
              const quota = await getChannelQuota(ch.token);
              if (quota.remaining > 0) {
                result = await _trySendOne_(ch, text);
                if (result.success) {
                  usedChannelName = ch.name;
                  break;
                }
              } else {
                console.warn(`[LINE] チャネル「${ch.name || ch.groupId}」の無料枠が枯渇しています (used=${quota.used}/${quota.max})`);
              }
            }
            // 全チャネル枯渇 or 失敗時
            if (!result || !result.success) {
              result = { success: false, error: "全チャネルで無料枠枯渇または送信失敗" };
            }
          }

          usedChannel = activeChannels.length > 1 ? "property_multi" : "property";
        }
      }
    } catch (e) {
      console.warn(`物件 LINE 設定取得エラー (${propertyId}):`, e.message);
    }
  }

  // ---- 物件設定がなければ共通設定へフォールバック ----
  if (!result) {
    const { channelToken: gt, groupId: gid } = await getNotificationSettings_(db);
    if (gt && gid) {
      result = await sendLineMessage(gt, gid, text);
      usedChannel = "global";
    } else {
      result = { success: false, error: "LINE送信先が設定されていません" };
    }
  }

  // ---- 通知ログ記録 ----
  try {
    await db.collection("notifications").add({
      type: logExtra.type || "line_message",
      title: logExtra.title || text.slice(0, 50),
      body: text.slice(0, 1000),
      propertyId: propertyId || null,
      sentAt: new Date(),
      channel: "line",
      usedChannel,
      usedChannelName: usedChannelName || null,
      success: result.success,
      error: result.error || null,
      ...logExtra,
    });
  } catch (e) {
    console.error("通知ログ記録エラー:", e);
  }

  return { ...result, usedChannel, channelName: usedChannelName };
}

module.exports = {
  sendLineMessage,
  sendLineMessageForProperty,
  getChannelQuota,
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
  sendDiscord_,
};
