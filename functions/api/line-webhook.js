/**
 * LINE Bot Webhook 受信エンドポイント
 * - postbackイベント: GOサイン承認/却下の処理
 * - messageイベント: 自然言語でのタスク追加・質問
 *
 * LINE Developers Console で Webhook URL を設定:
 *   https://asia-northeast1-minpaku-v2.cloudfunctions.net/lineWebhook
 */
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { verifySignature, notifyOwner } = require("../utils/lineNotify");

/**
 * LINE Webhookハンドラ（Express不使用、直接onRequest）
 * LINE側は200を即時返却しないとリトライしてくるため、
 * 非同期処理はバックグラウンドで行い即座に200を返す
 */
async function handleLineWebhook(req, res) {
  // GETはLINE Console接続確認用
  if (req.method === "GET") {
    return res.status(200).send("OK");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const db = admin.firestore();

  // 1. 署名検証
  const settingsDoc = await db.collection("settings").doc("notifications").get();
  const channelSecret = settingsDoc.exists ? settingsDoc.data().lineChannelSecret : null;

  if (channelSecret) {
    const signature = req.headers["x-line-signature"];
    const rawBody = typeof req.rawBody === "string" ? req.rawBody : (req.rawBody || JSON.stringify(req.body));
    if (!signature || !verifySignature(channelSecret, signature, rawBody)) {
      console.warn("LINE Webhook 署名検証失敗");
      return res.status(403).send("Invalid signature");
    }
  }

  // 2. 即座に200返却（LINEのリトライ防止）
  res.status(200).send("OK");

  // 3. イベント処理（バックグラウンド）
  const events = (req.body && req.body.events) || [];
  for (const event of events) {
    try {
      await processEvent_(db, event);
    } catch (e) {
      console.error("LINE Webhookイベント処理エラー:", e);
      // エラーログをFirestoreに記録
      try {
        await db.collection("error_logs").add({
          functionName: "lineWebhook",
          errorMessage: e.message,
          stackTrace: e.stack || "",
          eventType: event.type,
          severity: "warning",
          notified: false,
          createdAt: new Date(),
        });
      } catch (logErr) { /* ログ記録失敗は無視 */ }
    }
  }
}

/**
 * 個別イベント処理のディスパッチャー
 */
async function processEvent_(db, event) {
  switch (event.type) {
    case "postback":
      await handlePostback_(db, event);
      break;
    case "message":
      if (event.message && event.message.type === "text") {
        await handleTextMessage_(db, event);
      }
      break;
    case "follow":
      // Bot友達追加 → オーナーUserIDを自動記録
      await handleFollow_(db, event);
      break;
    default:
      console.log("未処理のLINEイベント:", event.type);
  }
}

// ========== Postback処理（GOサイン） ==========

/**
 * Postbackイベント処理 — FlexメッセージのボタンタップをFirestoreに反映
 * postback.data 形式: "approval={approvalId}&action={approve|reject|modify}"
 */
async function handlePostback_(db, event) {
  const data = event.postback.data;
  const params = new URLSearchParams(data);
  const approvalId = params.get("approval");
  const action = params.get("action");

  if (!approvalId || !action) {
    console.warn("不正なpostbackデータ:", data);
    return;
  }

  // 承認レコードを取得
  const approvalRef = db.collection("secretary").doc("approvals")
    .collection("items").doc(approvalId);
  const doc = await approvalRef.get();

  if (!doc.exists) {
    console.warn("承認レコードが見つかりません:", approvalId);
    return;
  }

  const approval = doc.data();

  // 既に処理済みの場合
  if (approval.status !== "waiting") {
    console.log("既に処理済みの承認:", approvalId, approval.status);
    return;
  }

  // ステータス更新
  const newStatus = action === "approve" ? "approved" : "rejected";
  await approvalRef.update({
    status: newStatus,
    respondedAt: new Date(),
    respondedAction: action,
  });

  // 後続処理を実行
  if (action === "approve") {
    await executeApprovedAction_(db, approval, approvalId);
  }

  // 応答テキストを送信
  const emoji = action === "approve" ? "✅" : "⏭️";
  const label = action === "approve" ? "承認しました" : "スキップしました";
  await notifyOwner(db, "approval_response", label, `${emoji} ${approval.title}: ${label}`);

  console.log(`承認処理完了: ${approvalId} → ${newStatus}`);
}

/**
 * 承認後のアクション実行ディスパッチャー
 * approval.type に応じて後続処理を呼び分ける
 */
async function executeApprovedAction_(db, approval, approvalId) {
  switch (approval.type) {
    case "timee_recruit":
      // タイミー募集の実行（将来実装）
      console.log("タイミー募集承認:", approvalId);
      break;

    case "calendar_add":
      // Googleカレンダーへの予定追加（Phase 2で実装）
      console.log("カレンダー追加承認:", approvalId);
      break;

    case "shift_assign":
      // シフト自動割当の確定
      await executeShiftAssign_(db, approval);
      break;

    case "scan_approve":
      // 経理スキャンの一括承認
      console.log("スキャン一括承認:", approvalId);
      break;

    default:
      console.log("未定義の承認タイプ:", approval.type);
  }
}

/**
 * シフト自動割当の確定処理
 */
async function executeShiftAssign_(db, approval) {
  const { shiftId, staffId, staffName } = approval.details || {};
  if (!shiftId || !staffId) return;

  await db.collection("shifts").doc(shiftId).update({
    staffId,
    staffName,
    status: "assigned",
    assignMethod: "auto",
    updatedAt: new Date(),
  });
  console.log(`シフト割当確定: ${shiftId} → ${staffName}`);
}

// ========== テキストメッセージ処理 ==========

/**
 * テキストメッセージ処理
 * 特定のキーワードでTODO追加やステータス確認を実行
 */
async function handleTextMessage_(db, event) {
  const text = event.message.text.trim();
  const userId = event.source.userId;

  // オーナーのUserIDか確認
  const settingsDoc = await db.collection("settings").doc("notifications").get();
  const ownerUserId = settingsDoc.exists ? settingsDoc.data().lineOwnerUserId : null;
  if (userId !== ownerUserId) {
    console.log("オーナー以外からのメッセージを無視:", userId);
    return;
  }

  // コマンド判定
  if (text.startsWith("タスク:") || text.startsWith("タスク：") || text.startsWith("TODO:")) {
    await handleAddTodo_(db, text);
  } else if (text === "状況" || text === "ステータス" || text === "今日") {
    await handleStatusRequest_(db);
  } else if (text === "承認待ち" || text === "待ち") {
    await handlePendingApprovals_(db);
  } else {
    // 未知のメッセージ → Firestoreにログ保存（将来AI解析用）
    await db.collection("secretary").doc("inbox").collection("messages").add({
      text,
      userId,
      receivedAt: new Date(),
      processed: false,
    });
  }
}

/**
 * LINEからのTODO追加
 * 例: "タスク: 明日までに銀行振込"
 */
async function handleAddTodo_(db, text) {
  const content = text.replace(/^(タスク[:：]|TODO:)\s*/, "").trim();
  if (!content) return;

  await db.collection("todos").add({
    title: content,
    source: "line",
    priority: "medium",
    status: "open",
    createdAt: new Date(),
  });

  await notifyOwner(db, "todo_added", "TODO追加", `📝 TODO追加: ${content}`);
}

/**
 * 今日のステータスを簡易返答
 */
async function handleStatusRequest_(db) {
  const today = getJSTDateString_(new Date());

  // 今日のCO/CI件数
  const [coSnap, ciSnap] = await Promise.all([
    db.collection("guestRegistrations").where("checkOut", "==", today).get(),
    db.collection("guestRegistrations").where("checkIn", "==", today).get(),
  ]);

  // 承認待ち件数
  const pendingSnap = await db.collection("secretary").doc("approvals")
    .collection("items").where("status", "==", "waiting").get();

  // 未処理スキャン件数
  const scanSnap = await db.collection("scanLogs")
    .where("status", "==", "⏳ 確認待ち").get();

  let text = `📋 ${today} のステータス\n`;
  text += `・チェックアウト: ${coSnap.size}件\n`;
  text += `・チェックイン: ${ciSnap.size}件\n`;
  text += `・承認待ち: ${pendingSnap.size}件\n`;
  text += `・スキャン確認待ち: ${scanSnap.size}件`;

  await notifyOwner(db, "status_reply", "ステータス応答", text);
}

/**
 * 承認待ち一覧を返答
 */
async function handlePendingApprovals_(db) {
  const snap = await db.collection("secretary").doc("approvals")
    .collection("items").where("status", "==", "waiting")
    .orderBy("createdAt", "desc").limit(10).get();

  if (snap.empty) {
    await notifyOwner(db, "approval_list", "承認待ち", "✅ 承認待ちはありません");
    return;
  }

  let text = "⏳ 承認待ち一覧\n\n";
  snap.docs.forEach((doc, i) => {
    const d = doc.data();
    text += `${i + 1}. ${d.title}\n`;
    if (d.summary) text += `   ${d.summary.slice(0, 50)}\n`;
  });

  await notifyOwner(db, "approval_list", "承認待ち一覧", text);
}

// ========== Bot友達追加 ==========

/**
 * 友達追加時にUserIDを自動記録
 */
async function handleFollow_(db, event) {
  const userId = event.source.userId;
  console.log("LINE Bot友達追加:", userId);

  // 設定にUserIDが未登録なら自動登録
  const settingsDoc = await db.collection("settings").doc("notifications").get();
  if (settingsDoc.exists && !settingsDoc.data().lineOwnerUserId) {
    await db.collection("settings").doc("notifications").update({
      lineOwnerUserId: userId,
    });
    console.log("オーナーUserIDを自動登録:", userId);
  }
}

// ========== ユーティリティ ==========

function getJSTDateString_(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

module.exports = { handleLineWebhook };
