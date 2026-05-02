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
 * 2. LINE FlexメッセージをWebアプリ管理者にPush
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
 * Webアプリ管理者LINE通知を送信する（ownerLineChannels 対応）
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
  return { success: false, error: "Webアプリ管理者LINE User ID 未設定（lineOwnerUserId）" };
}

/**
 * 通知種別ごとの送信先を判定
 * settings.channels[notifyType] の ownerLine / groupLine / ownerEmail / fcmStaff / fcmOwner で制御
 * propertyOverrides がある場合は物件別設定を優先（存在するフィールドのみ上書き）
 *
 * @param {object} settings - settings/notifications ドキュメント
 * @param {string} notifyType - 通知種別キー（例: "recruit_start"）
 * @param {object} [propertyOverrides={}] - properties/{pid}.channelOverrides の値。省略時は全物件共通設定のみ使用
 * @returns {{ enabled: boolean, ownerLine: boolean, groupLine: boolean, staffLine: boolean, ownerEmail: boolean, fcmStaff: boolean, fcmOwner: boolean, sendToGroup: boolean, sendToIndividual: boolean }}
 */
function resolveNotifyTargets(settings, notifyType, propertyOverrides = {}) {
  // 「物件別のみ参照」ポリシー (2026-04-26 〜)
  // - settings/notifications.channels (グローバル設定) は参照しない
  // - properties/{pid}.channelOverrides[notifyType] のみで判定
  // - 物件別に設定がない / enabled=false の場合は全チャネル OFF (送信しない)
  const allOff = {
    enabled: false,
    ownerLine: false, groupLine: false, staffLine: false, staffEmail: false, ownerEmail: false,
    propertyEmail: false,
    subOwnerLine: false, subOwnerEmail: false, discordOwner: false, discordSubOwner: false,
    fcmStaff: false, fcmOwner: false,
    sendToGroup: false, sendToIndividual: false,
  };

  const ov = (propertyOverrides && typeof propertyOverrides === "object")
    ? propertyOverrides[notifyType]
    : null;
  if (!ov || typeof ov !== "object") return allOff;
  if (ov.enabled === false) return allOff;

  const ownerLine       = !!ov.ownerLine;
  const groupLine       = !!ov.groupLine;
  const staffLine       = !!ov.staffLine;
  const staffEmail      = !!ov.staffEmail;
  const ownerEmail      = !!ov.ownerEmail;
  const propertyEmail   = !!ov.propertyEmail;
  const subOwnerLine    = !!ov.subOwnerLine;
  const subOwnerEmail   = !!ov.subOwnerEmail;
  const discordOwner    = !!ov.discordOwner;
  const discordSubOwner = !!ov.discordSubOwner;
  const fcmStaff        = !!ov.fcmStaff;
  const fcmOwner        = !!ov.fcmOwner;

  return {
    enabled: true,
    ownerLine, groupLine, staffLine, staffEmail, ownerEmail, propertyEmail,
    subOwnerLine, subOwnerEmail, discordOwner, discordSubOwner,
    fcmStaff, fcmOwner,
    sendToGroup: groupLine,
    sendToIndividual: staffLine,
  };
}

// ========== スタッフ・グループ通知 ==========

/**
 * settings/notifications の channels[type].customMessage を読んで
 * {変数名} を vars オブジェクトで置換した文字列を返す。カスタムなしなら fallback を返す。
 * propertyOverrides が渡された場合は物件別 customMessage を優先する。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} type 通知種別キー
 * @param {string|object} fallback デフォルトメッセージ (Flex等のオブジェクトはカスタム対象外)
 * @param {object} [vars] {変数名} 置換用マップ
 * @param {object} [propertyOverrides] properties/{pid}.channelOverrides の値
 */
async function resolveMessage_(db, type, fallback, vars, propertyOverrides) {
  try {
    if (typeof fallback !== "string") return fallback; // Flex等はカスタム対象外
    // 「物件別のみ参照」ポリシー: グローバル settings.channels の customMessage は参照しない
    const propOv = (propertyOverrides && typeof propertyOverrides === "object")
      ? (propertyOverrides[type] || {})
      : {};
    const customMessage = propOv.customMessage;

    if (!customMessage || !String(customMessage).trim()) return fallback;
    let msg = String(customMessage);
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
 * @param {object} [propertyOverrides] - properties/{pid}.channelOverrides (物件別上書き)
 */
async function notifyStaff(db, staffId, type, title, body, vars, propertyOverrides) {
  body = await resolveMessage_(db, type, body, vars, propertyOverrides);
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
 * @param {object} [propertyOverrides] properties/{pid}.channelOverrides (物件別上書き)
 */
async function notifyGroup(db, type, title, body, vars, propertyOverrides, propertyId) {
  body = await resolveMessage_(db, type, body, vars, propertyOverrides);

  // propertyId があれば該当物件の LINE チャネル (lineChannels[]) へ送信
  // (「グループLINE（該当の物件のグループLINEのみ）」仕様)
  if (propertyId) {
    const bodyStr = typeof body === "string" ? body : `[Flex] ${title}`;
    const result = await sendLineMessageForProperty(db, propertyId, bodyStr, { type, title });
    // 物件 LINE が未設定の場合 (usedChannel='global' のフォールバックになった場合) は
    // 該当物件には送らない仕様にしたいので、グローバル送信は抑止しエラー扱い
    if (result.usedChannel === "global" && !result.success) {
      return { success: false, error: "該当物件の LINE が未設定のため送信されません", propertyId };
    }
    if (result.usedChannel === "global") {
      // 物件に LINE が未登録だが getNotificationSettings_ のグローバルで成功してしまった場合
      // 仕様上これは望ましくないため、ログに記録して成功扱い (既存互換)
      console.warn(`[notifyGroup] 物件 ${propertyId} に LINE チャネル未登録のためグローバル送信`);
    }
    return result;
  }

  // 物件特定できない通知はグローバル設定へ (従来互換)
  const { channelToken, groupId } = await getNotificationSettings_(db);
  if (!channelToken) return { success: false, error: "LINEチャネルトークン未設定" };
  if (!groupId) return { success: false, error: "LINEグループID未設定" };

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
 * @param {object} [propertyOverrides] properties/{pid}.channelOverrides (物件別上書き)
 */
async function notifyOwner(db, type, title, body, vars, propertyOverrides) {
  body = await resolveMessage_(db, type, body, vars, propertyOverrides);
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
 * 指定物件の物件オーナーに個別通知を送信する
 * notifyOwner の補助として呼び出す（既存の notifyOwner 経路に追加する形）
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} propertyId - 対象物件ID
 * @param {string} title - 通知タイトル（ログ用）
 * @param {string} body - 送信テキスト
 * @returns {Promise<{success: boolean, sent: number}>}
 */
async function notifySubOwners(db, propertyId, title, body) {
  if (!propertyId) return { success: false, sent: 0 };
  let sentCount = 0;
  try {
    const { channelToken } = await getNotificationSettings_(db);
    const staffSnap = await db.collection("staff")
      .where("isSubOwner", "==", true)
      .where("ownedPropertyIds", "array-contains", propertyId)
      .get();

    for (const s of staffSnap.docs) {
      const sData = s.data();
      if (!sData.active) continue;

      // 物件オーナー専用 LINE User ID → 未設定なら staff.lineUserId にフォールバック
      const subOwnerLineId = sData.subOwnerLineUserId || sData.lineUserId;
      if (subOwnerLineId && channelToken) {
        const result = await sendLineMessage(channelToken, subOwnerLineId, body);
        if (result.success) sentCount++;
        console.log(`物件オーナー(${sData.name}) LINE送信: ${result.success ? "成功" : "失敗"} (id=${subOwnerLineId.slice(0,8)}..., fallback=${!sData.subOwnerLineUserId})`);
        try {
          await db.collection("notifications").add({
            type: "sub_owner_notify",
            title,
            body: body.slice(0, 1000),
            staffId: s.id,
            staffName: sData.name,
            propertyId,
            sentAt: new Date(),
            channel: "line",
            target: "sub_owner",
            success: result.success,
            error: result.error || null,
          });
        } catch (e) { console.error("通知ログ記録エラー:", e); }
      }

      // 物件オーナー専用メール → 未設定なら staff.email にフォールバック
      const subOwnerMail = sData.subOwnerEmail || sData.email;
      if (subOwnerMail) {
        try {
          await sendNotificationEmail_(subOwnerMail, title, body);
          sentCount++;
          console.log(`物件オーナー(${sData.name}) メール送信成功: ${subOwnerMail} (fallback=${!sData.subOwnerEmail})`);
        } catch (e) {
          console.error(`物件オーナー(${sData.name}) メール通知エラー:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error("物件オーナー通知エラー:", e.message);
    return { success: false, sent: sentCount };
  }
  return { success: sentCount > 0, sent: sentCount };
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
 * @param {string} to 宛先
 * @param {string} subject 件名
 * @param {string} body 本文
 * @param {string} [fromEmail] 送信者として使いたい Gmail アドレス (OAuth 連携済みならそのトークンで送信、未連携なら先頭アカウントにフォールバック)
 */
async function sendNotificationEmail_(to, subject, body, fromEmail, opts) {
  if (IS_EMULATOR) {
    console.log("[EMULATOR] would send email:", { to, subject, body, fromEmail });
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

  // fromEmail 指定があれば対応トークンを優先探索、なければ先頭トークン
  let tokenData = null;
  if (fromEmail) {
    // 両コンテキスト(税理士資料用 / メール照合用)を統合検索
    try {
      const cols = [
        db.collection("settings").doc("gmailOAuth").collection("tokens"),
        db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
      ];
      for (const col of cols) {
        const byEmail = await col.where("email", "==", fromEmail).limit(1).get();
        if (!byEmail.empty) { tokenData = byEmail.docs[0].data(); break; }
      }
    } catch (_) {}
  }
  if (!tokenData) {
    // strictFrom: fromEmail の Gmail 連携が必須 (アプリ管理者等にフォールバックしない)
    if (fromEmail && opts && opts.strictFrom) {
      throw new Error(`fromEmail=${fromEmail} の Gmail 連携が未登録のため送信をスキップ`);
    }
    // フォールバック: 両コンテキストから先頭の有効トークンを取得
    let tokensSnap = await db.collection("settings").doc("gmailOAuth").collection("tokens").limit(1).get();
    if (tokensSnap.empty) {
      tokensSnap = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").limit(1).get();
    }
    if (tokensSnap.empty) throw new Error("Gmail認証済みアカウントなし（設定画面でGmail連携してください）");
    tokenData = tokensSnap.docs[0].data();
    if (fromEmail && tokenData.email !== fromEmail) {
      console.log(`[sendNotificationEmail_] fromEmail=${fromEmail} の Gmail 連携が未登録のため ${tokenData.email} で送信`);
    }
  }
  if (!tokenData.refreshToken) throw new Error("リフレッシュトークンなし");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // RFC 2822形式のメール本文を作成
  // fromEmail が指定され、かつ tokenData.email と違う場合は Gmail が Send As 設定済みなら
  // 本物の from アドレスで届く (未設定なら Gmail が tokenData.email に書き換える)
  const fromHeader = (fromEmail && (tokenData.email === fromEmail || (opts && opts.preferFromHeader)))
    ? fromEmail
    : (tokenData.email || "me");
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const messageParts = [
    `From: ${fromHeader}`,
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

        // lineDeliveryMode (single/rotate/fallback) を優先、未設定時は lineChannelStrategy に後方互換フォールバック
        // 旧値 "roundrobin" は新値 "rotate" にマップ
        if (activeChannels.length > 0) {
          const rawMode = pd.lineDeliveryMode || pd.lineChannelStrategy || "fallback";
          const mode = rawMode === "roundrobin" ? "rotate" : rawMode;

          if (mode === "single") {
            // single: 1番目のチャネルのみ使用、失敗しても他へフォールバックしない
            const ch = activeChannels[0];
            if (!ch.token) {
              console.warn(`[LINE][single] チャネル「${ch.name || ch.groupId}」の残枠がゼロです`);
            }
            result = await _trySendOne_(ch, text);
            usedChannelName = ch.name;

          } else if (mode === "rotate") {
            // rotate: 前回使ったインデックスの次を使う（インデックス記録ベース）
            const lastIdx = typeof pd.lineLastChannelIdx === "number" ? pd.lineLastChannelIdx : -1;
            const startIdx = (lastIdx + 1) % activeChannels.length;

            // startIdx から順に試みる（全チャネルを一周）
            for (let i = 0; i < activeChannels.length; i++) {
              const idx = (startIdx + i) % activeChannels.length;
              const ch = activeChannels[idx];
              result = await _trySendOne_(ch, text);
              if (result.success) {
                usedChannelName = ch.name;
                // 成功したインデックスを記録（失敗しても本処理に影響させない）
                try {
                  await db.collection("properties").doc(propertyId).update({ lineLastChannelIdx: idx });
                } catch (e) {
                  console.warn("[LINE][rotate] lineLastChannelIdx 保存失敗:", e.message);
                }
                break;
              }
              console.warn(`[LINE][rotate] チャネル「${ch.name || ch.groupId}」失敗、次を試みます:`, result.error);
            }
            if (!result || !result.success) {
              result = { success: false, error: "全チャネルで送信失敗 (rotate)" };
            }

          } else {
            // fallback: 残枠が多い順に試みる（デフォルト動作）
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

/**
 * 通知種別ごとのチャネル設定 (settings.channels[notifyKey] と
 * properties/{id}.channelOverrides[notifyKey]) に従って各チャネルへ送信する統合関数。
 *
 * 各チャネル (ownerLine / groupLine / staffLine / subOwnerLine /
 * ownerEmail / subOwnerEmail / staffEmail / discordOwner / discordSubOwner)
 * の ON/OFF を resolveNotifyTargets の結果で厳密に判定し、true のものだけ発射する。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} notifyKey - 通知種別キー (例: "roster_received")
 * @param {object} options
 * @param {string} options.title - ログ用タイトル
 * @param {string} options.body - デフォルト本文 (customMessage が無い時の fallback)
 * @param {object} [options.vars] - {変数名} 置換用
 * @param {string|null} [options.propertyId] - 物件 ID (group/subOwner 系の宛先解決に使用)
 * @param {string[]} [options.staffIds] - 個別 staff 限定送信したい場合 (省略時は active 全員)
 * @returns {Promise<{sent: object, errors: object[]}>}
 */
async function notifyByKey(db, notifyKey, options = {}) {
  const {
    title = "", body = "", vars = {}, propertyId = null, staffIds = null,
    // ownerEmail / subOwnerEmail のみに必ず追記される文字列 (LINEには含めない)
    // 用途: customMessage で消えても残したい OK ボタン等の操作リンク
    extraEmailFooter = "",
  } = options;

  // 1. settings + propertyOverrides 取得
  const { settings } = await getNotificationSettings_(db);
  if (!settings) return { sent: {}, errors: [{ error: "通知設定未登録" }] };

  let propertyOverrides = {};
  if (propertyId) {
    try {
      const pDoc = await db.collection("properties").doc(propertyId).get();
      if (pDoc.exists) propertyOverrides = pDoc.data().channelOverrides || {};
    } catch (e) {
      console.warn(`[notifyByKey] property fetch error: ${e.message}`);
    }
  }

  // 2. ターゲット判定
  const targets = resolveNotifyTargets(settings, notifyKey, propertyOverrides);
  if (!targets.enabled) {
    return { sent: {}, errors: [] };
  }

  // 3. customMessage で本文置換 (string body のみ対象)
  // 「物件別のみ参照」ポリシー: グローバル settings.channels.customMessage は参照しない
  let resolvedBody = body;
  if (typeof body === "string") {
    const ovCh = (propertyOverrides && propertyOverrides[notifyKey]) || {};
    const customMessage = ovCh.customMessage;
    if (customMessage && String(customMessage).trim()) {
      let msg = String(customMessage);
      Object.keys(vars || {}).forEach(k => {
        msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k] ?? ""));
      });
      resolvedBody = msg;
    }
  }

  const sent = {};
  const errors = [];

  // 4. 各チャネルへ並列送信
  const tasks = [];

  // (a) Webアプリ管理者 LINE
  // 案A: propertyId 指定があれば、まず物件別 Bot (lineChannels[0].token) でプッシュ試行
  //       → やますけ側で Bot 名を見て物件を識別できるようにする
  //       失敗時はグローバル Bot にフォールバック
  if (targets.ownerLine) {
    tasks.push((async () => {
      try {
        const { channelToken, ownerUserId } = await getNotificationSettings_(db);
        const text = typeof resolvedBody === "string" ? resolvedBody : title;

        // 物件別 Bot 優先 (propertyId 指定 + lineChannels[0].token があれば)
        let propBotToken = null;
        let propBotName = null;
        if (propertyId) {
          try {
            const pd = await db.collection("properties").doc(propertyId).get();
            if (pd.exists) {
              const pData = pd.data() || {};
              const ch0 = Array.isArray(pData.lineChannels)
                ? pData.lineChannels.find(c => c && c.enabled !== false && c.token)
                : null;
              if (ch0) {
                propBotToken = ch0.token;
                propBotName = ch0.name || "";
              }
            }
          } catch (_) { /* 取得失敗時は無視してグローバルへ */ }
        }

        // 物件別 Bot 試行 (ownerUserId はグローバル設定を流用 — Bot 単位で userId が違う場合は失敗するので fallback)
        if (propBotToken && ownerUserId) {
          const r1 = await sendLineMessage(propBotToken, ownerUserId, text);
          if (r1.success) {
            sent.ownerLine = true;
            console.log(`[ownerLine] 物件別 Bot で送信成功: ${propBotName || "(name未設定)"} → ${ownerUserId.slice(0,10)}...`);
            return;
          }
          console.warn(`[ownerLine] 物件別 Bot 失敗 (${propBotName}) → グローバル Bot にフォールバック:`, r1.error);
        }

        // グローバル ownerLine (ownerLineChannels[] 戦略 / 後方互換単一チャネル)
        const r = await _sendOwnerLine_(settings, channelToken, ownerUserId, text);
        sent.ownerLine = r.success;
        if (!r.success) errors.push({ channel: "ownerLine", error: r.error });
      } catch (e) { errors.push({ channel: "ownerLine", error: e.message }); }
    })());
  }

  // (b) グループ LINE (物件別)
  if (targets.groupLine && propertyId) {
    tasks.push((async () => {
      try {
        const text = typeof resolvedBody === "string" ? resolvedBody : `[Flex] ${title}`;
        const r = await sendLineMessageForProperty(db, propertyId, text, { type: notifyKey, title });
        sent.groupLine = r.success;
        if (!r.success) errors.push({ channel: "groupLine", error: r.error });
      } catch (e) { errors.push({ channel: "groupLine", error: e.message }); }
    })());
  }

  // (c) スタッフ個別 LINE
  if (targets.staffLine) {
    tasks.push((async () => {
      try {
        let ids = staffIds;
        if (!ids) {
          const snap = await db.collection("staff").where("active", "==", true).get();
          ids = snap.docs.map(d => d.id);
        }
        let okCount = 0;
        for (const sid of ids) {
          try {
            const r = await notifyStaff(db, sid, notifyKey, title, resolvedBody, vars, propertyOverrides);
            if (r && r.success) okCount++;
          } catch (e) { errors.push({ channel: "staffLine", staffId: sid, error: e.message }); }
        }
        sent.staffLine = okCount;
      } catch (e) { errors.push({ channel: "staffLine", error: e.message }); }
    })());
  }

  // (d) サブオーナー LINE / メール (notifySubOwners が両方束ねている)
  if ((targets.subOwnerLine || targets.subOwnerEmail) && propertyId) {
    tasks.push((async () => {
      try {
        const text = typeof resolvedBody === "string" ? resolvedBody : `[Flex] ${title}`;
        const r = await notifySubOwners(db, propertyId, title, text);
        sent.subOwner = r.sent;
      } catch (e) { errors.push({ channel: "subOwner", error: e.message }); }
    })());
  }

  // (e) Webアプリ管理者メール
  if (targets.ownerEmail) {
    tasks.push((async () => {
      try {
        const emails = settings.notifyEmails || [];
        const baseText = typeof resolvedBody === "string" ? resolvedBody : `[Flex] ${title}`;
        // customMessage で削られても OK ボタン等は必ず付ける
        const text = extraEmailFooter && !baseText.includes(extraEmailFooter)
          ? baseText + extraEmailFooter
          : baseText;
        let okCount = 0;
        for (const to of emails) {
          try {
            await sendNotificationEmail_(to, title, text);
            okCount++;
          } catch (e) { errors.push({ channel: "ownerEmail", to, error: e.message }); }
        }
        sent.ownerEmail = okCount;
      } catch (e) { errors.push({ channel: "ownerEmail", error: e.message }); }
    })());
  }

  // (e2) 物件 Gmail (cc): 物件単位で Gmail 連携した送信元アドレス自身に cc
  if (targets.propertyEmail && propertyId) {
    tasks.push((async () => {
      try {
        const pDoc = await db.collection("properties").doc(propertyId).get();
        const propertyGmail = pDoc.exists ? (pDoc.data().senderGmail || "") : "";
        if (!propertyGmail) {
          errors.push({ channel: "propertyEmail", error: "物件に Gmail 連携が未設定" });
          return;
        }
        const baseText = typeof resolvedBody === "string" ? resolvedBody : `[Flex] ${title}`;
        const text = extraEmailFooter && !baseText.includes(extraEmailFooter)
          ? baseText + extraEmailFooter
          : baseText;
        // 物件 Gmail を送信元 (fromEmail) に指定すると、その同じアドレス宛に届くと
        // 同一受信箱になるが、Gmail OAuth は自分自身宛にも送れるため問題なし
        await sendNotificationEmail_(propertyGmail, title, text, propertyGmail);
        sent.propertyEmail = 1;
      } catch (e) { errors.push({ channel: "propertyEmail", error: e.message }); }
    })());
  }

  // (f) スタッフメール (active 全員 or staffIds 指定者)
  if (targets.staffEmail) {
    tasks.push((async () => {
      try {
        const text = typeof resolvedBody === "string" ? resolvedBody : `[Flex] ${title}`;
        let snap;
        if (staffIds && staffIds.length) {
          // 個別取得
          const docs = await Promise.all(staffIds.map(id => db.collection("staff").doc(id).get()));
          snap = { docs: docs.filter(d => d.exists) };
        } else {
          snap = await db.collection("staff").where("active", "==", true).get();
        }
        let okCount = 0;
        for (const d of snap.docs) {
          const sd = d.data();
          if (!sd.email) continue;
          try {
            await sendNotificationEmail_(sd.email, title, text);
            okCount++;
          } catch (e) { errors.push({ channel: "staffEmail", staffId: d.id, error: e.message }); }
        }
        sent.staffEmail = okCount;
      } catch (e) { errors.push({ channel: "staffEmail", error: e.message }); }
    })());
  }

  // (g) Discord (オーナー)
  if (targets.discordOwner) {
    tasks.push((async () => {
      try {
        const url = settings.discordOwnerWebhookUrl || settings.discordWebhookUrl;
        if (!url) {
          errors.push({ channel: "discordOwner", error: "Webhook URL 未設定" });
          return;
        }
        const text = typeof resolvedBody === "string" ? resolvedBody : `[Flex] ${title}`;
        const r = await sendDiscord_(url, `**${title}**\n${text}`);
        sent.discordOwner = !!r.success;
        if (!r.success) errors.push({ channel: "discordOwner", error: r.error });
      } catch (e) { errors.push({ channel: "discordOwner", error: e.message }); }
    })());
  }

  // (h) Discord (サブオーナー)
  if (targets.discordSubOwner && propertyId) {
    tasks.push((async () => {
      try {
        const text = typeof resolvedBody === "string" ? resolvedBody : `[Flex] ${title}`;
        const staffSnap = await db.collection("staff")
          .where("isSubOwner", "==", true)
          .where("ownedPropertyIds", "array-contains", propertyId)
          .get();
        let okCount = 0;
        for (const s of staffSnap.docs) {
          const sd = s.data();
          if (!sd.active) continue;
          const url = sd.subOwnerDiscordWebhookUrl || sd.discordWebhookUrl;
          if (!url) continue;
          const r = await sendDiscord_(url, `**${title}**\n${text}`);
          if (r.success) okCount++;
        }
        sent.discordSubOwner = okCount;
      } catch (e) { errors.push({ channel: "discordSubOwner", error: e.message }); }
    })());
  }

  await Promise.allSettled(tasks);

  // 通知ログ (集約版)
  try {
    await db.collection("notifications").add({
      type: notifyKey,
      title,
      body: typeof resolvedBody === "string" ? resolvedBody.slice(0, 1000) : `[Flex] ${title}`,
      propertyId: propertyId || null,
      sentAt: new Date(),
      channel: "multi",
      sent,
      errorCount: errors.length,
    });
  } catch (_) { /* ignore log error */ }

  return { sent, errors };
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
  notifySubOwners,
  notifyByKey,
  buildRecruitmentFlex,
  resolveNotifyTargets,
  getNotificationSettings_,
  sendNotificationEmail_,
  sendDiscord_,
};
