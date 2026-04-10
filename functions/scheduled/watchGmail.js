/**
 * Gmail受信監視（定期実行 — 有効化時は5分おき）
 * 未読メールをチェックし、内容を分類してTODO/予定を自動抽出
 *
 * 処理フロー:
 *   1. Gmail API で未読メールの一覧を取得（前回チェック以降）
 *   2. 各メールの件名+本文を解析
 *   3. ルールベース分類 → "schedule" | "todo" | "info" | "ignore"
 *   4. schedule → Firestore calendar_events/ に記録（将来: Google Calendar API連携）
 *   5. todo → Firestore todos/ に記録
 *
 * 前提条件:
 *   - Google Cloud Console でGmail APIを有効化
 *   - サービスアカウントにドメイン全体委任（Domain-wide Delegation）を設定
 *   - settings/gmail に設定値を保存（userEmail, enabled）
 */
const { google } = require("googleapis");
const { notifyOwner } = require("../utils/lineNotify");

module.exports = async function watchGmail(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  // Gmail監視設定を取得
  const settingsDoc = await db.collection("settings").doc("gmail").get();
  if (!settingsDoc.exists || !settingsDoc.data().enabled) {
    console.log("Gmail監視が無効です（settings/gmail.enabled=false）");
    return;
  }
  const settings = settingsDoc.data();
  const userEmail = settings.userEmail;
  if (!userEmail) {
    console.log("Gmail監視: userEmailが未設定です");
    return;
  }

  // 認証（サービスアカウント + ドメイン全体委任）
  let gmail;
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    // Domain-wide Delegationでユーザーに成り代わる
    const client = await auth.getClient();
    if (client.subject !== userEmail) {
      client.subject = userEmail;
    }
    gmail = google.gmail({ version: "v1", auth: client });
  } catch (e) {
    console.error("Gmail API認証エラー:", e.message);
    await logError_(db, "watchGmail", e);
    return;
  }

  // 前回チェック時刻を取得（Firestore）
  const stateDoc = await db.collection("secretary").doc("gmail_state").get();
  const lastCheckEpoch = stateDoc.exists ? (stateDoc.data().lastCheckEpoch || 0) : 0;
  const afterEpoch = lastCheckEpoch > 0 ? lastCheckEpoch : Math.floor(Date.now() / 1000) - 300; // 初回は5分前

  try {
    // 未読メール検索（after:で前回以降に限定）
    const query = `is:unread after:${afterEpoch}`;
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 20,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      console.log("新着未読メールなし");
      await updateLastCheck_(db);
      return;
    }

    console.log(`新着未読メール: ${messages.length}件`);

    let todosAdded = 0;
    let schedulesAdded = 0;

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });

      const headers = detail.data.payload.headers || [];
      const subject = getHeader_(headers, "Subject") || "(件名なし)";
      const from = getHeader_(headers, "From") || "";
      const dateStr = getHeader_(headers, "Date") || "";
      const snippet = detail.data.snippet || "";

      // メール分類
      const classification = classifyEmail_(subject, snippet, from);

      if (classification.type === "todo") {
        await db.collection("todos").add({
          title: classification.title || subject,
          source: "gmail",
          sourceId: msg.id,
          sourceFrom: from,
          priority: classification.priority || "medium",
          dueDate: classification.dueDate || null,
          status: "open",
          createdAt: new Date(),
        });
        todosAdded++;
      } else if (classification.type === "schedule") {
        await db.collection("calendar_events").add({
          title: classification.title || subject,
          date: classification.date || null,
          time: classification.time || null,
          source: "gmail",
          sourceId: msg.id,
          sourceFrom: from,
          googleCalendarEventId: null, // Phase 2で Google Calendar API連携
          createdAt: new Date(),
        });
        schedulesAdded++;
      }
      // "info" と "ignore" はログのみ
    }

    // 状態更新
    await updateLastCheck_(db);

    // 結果をサマリ通知（追加があった場合のみ）
    if (todosAdded > 0 || schedulesAdded > 0) {
      let text = "📧 メール監視結果\n";
      if (todosAdded > 0) text += `- TODO追加: ${todosAdded}件\n`;
      if (schedulesAdded > 0) text += `- 予定追加: ${schedulesAdded}件\n`;
      await notifyOwner(db, "gmail_watch", "メール監視", text);
    }

  } catch (e) {
    console.error("Gmail API処理エラー:", e.message);
    await logError_(db, "watchGmail", e);
  }
};

// ========== メール分類ロジック ==========

/**
 * メールの件名+本文スニペットからルールベースで分類
 * 将来的にはClaude/Gemini APIで高精度分類に置き換え可能
 */
function classifyEmail_(subject, snippet, from) {
  const text = `${subject} ${snippet}`.toLowerCase();

  // スケジュール・打合せ系
  const scheduleKeywords = [
    "打合せ", "打ち合わせ", "ミーティング", "会議", "面談",
    "内見", "立会い", "訪問", "来訪", "アポ",
    "予定", "日程", "スケジュール",
    "○月", "○日", "何時",
  ];
  for (const kw of scheduleKeywords) {
    if (text.includes(kw)) {
      // 日付抽出を試みる
      const dateMatch = extractDate_(text);
      return {
        type: "schedule",
        title: subject,
        date: dateMatch ? dateMatch.date : null,
        time: dateMatch ? dateMatch.time : null,
      };
    }
  }

  // TODO・依頼系
  const todoKeywords = [
    "お願い", "ご確認", "確認してください", "ご対応", "対応してください",
    "至急", "急ぎ", "期限", "締切", "〆切",
    "提出", "送付", "返信", "回答",
    "見積", "請求", "契約", "署名", "捺印",
  ];
  for (const kw of todoKeywords) {
    if (text.includes(kw)) {
      const priority = (text.includes("至急") || text.includes("急ぎ")) ? "high" : "medium";
      const dateMatch = extractDate_(text);
      return {
        type: "todo",
        title: subject,
        priority,
        dueDate: dateMatch ? dateMatch.date : null,
      };
    }
  }

  // 無視系（広告・通知メール）
  const ignoreKeywords = [
    "配信停止", "unsubscribe", "newsletter", "メルマガ",
    "noreply", "no-reply", "マーケティング",
  ];
  for (const kw of ignoreKeywords) {
    if (text.includes(kw) || from.toLowerCase().includes(kw)) {
      return { type: "ignore" };
    }
  }

  // デフォルト: 情報として記録のみ
  return { type: "info" };
}

/**
 * テキストから日付を簡易抽出
 * "4/5" "4月5日" "2026-04-05" "2026/04/05" 等
 */
function extractDate_(text) {
  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (isoMatch) {
    const m = isoMatch[2].padStart(2, "0");
    const d = isoMatch[3].padStart(2, "0");
    return { date: `${isoMatch[1]}-${m}-${d}`, time: extractTime_(text) };
  }

  // M月D日
  const jpMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (jpMatch) {
    const year = new Date().getFullYear();
    const m = jpMatch[1].padStart(2, "0");
    const d = jpMatch[2].padStart(2, "0");
    return { date: `${year}-${m}-${d}`, time: extractTime_(text) };
  }

  // M/D
  const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch && parseInt(slashMatch[1]) <= 12) {
    const year = new Date().getFullYear();
    const m = slashMatch[1].padStart(2, "0");
    const d = slashMatch[2].padStart(2, "0");
    return { date: `${year}-${m}-${d}`, time: extractTime_(text) };
  }

  return null;
}

function extractTime_(text) {
  // HH:MM
  const match = text.match(/(\d{1,2})[：:](\d{2})/);
  if (match) return `${match[1].padStart(2, "0")}:${match[2]}`;
  // H時
  const hourMatch = text.match(/(\d{1,2})時/);
  if (hourMatch) return `${hourMatch[1].padStart(2, "0")}:00`;
  return null;
}

// ========== ユーティリティ ==========

function getHeader_(headers, name) {
  const h = headers.find((h) => h.name === name);
  return h ? h.value : null;
}

async function updateLastCheck_(db) {
  await db.collection("secretary").doc("gmail_state").set({
    lastCheckEpoch: Math.floor(Date.now() / 1000),
    updatedAt: new Date(),
  }, { merge: true });
}

async function logError_(db, functionName, error) {
  try {
    await db.collection("error_logs").add({
      functionName,
      errorMessage: error.message,
      stackTrace: error.stack || "",
      severity: "warning",
      notified: false,
      createdAt: new Date(),
    });
  } catch (e) { /* ログ記録失敗は無視 */ }
}
