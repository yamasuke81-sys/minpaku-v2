/**
 * 朝ブリーフィング（毎朝6:00 JST）
 * 全部門の情報を統合してLINE送信
 * - 民泊: 今日のCO/CI、未確定募集
 * - 経理: スキャン確認待ち件数
 * - TODO: 未完了タスク
 * - 承認待ち: GOサイン待ち件数
 * - エラー: 直近24h以内の未処理エラー
 */
const { notifyOwner } = require("../utils/lineNotify");

module.exports = async function morningBriefing(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const today = getJSTDateString(new Date());
  const threeDaysLater = getJSTDateString(addDays(new Date(), 3));
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // 今月の年月（税理士資料用）
  const currentYM = today.slice(0, 7);

  // ========== 並行データ取得（高速化） ==========
  const [
    coSnap, ciSnap, recruitSnap, selectedSnap, monthSnap,
    scanPendingSnap, todosSnap, approvalsSnap, errorsSnap,
    taxDocsEntitiesSnap,
  ] = await Promise.all([
    // 民泊
    db.collection("guestRegistrations").where("checkOut", "==", today).get(),
    db.collection("guestRegistrations").where("checkIn", "==", today).get(),
    db.collection("recruitments").where("status", "==", "募集中").get(),
    db.collection("recruitments").where("status", "==", "選定済").get(),
    db.collection("guestRegistrations")
      .where("checkIn", ">=", today.slice(0, 7) + "-01")
      .where("checkIn", "<=", today.slice(0, 7) + "-31").get(),
    // 経理（scan-sorter連携）
    db.collection("scanLogs").where("status", "==", "⏳ 確認待ち").get(),
    // TODO
    db.collection("todos").where("status", "==", "open").get(),
    // 承認待ち（GOサイン）
    db.collection("secretary").doc("approvals")
      .collection("items").where("status", "==", "waiting").get(),
    // エラー（24h以内の未処理）
    db.collection("error_logs")
      .where("createdAt", ">=", yesterday)
      .limit(10).get(),
    // 税理士資料チェックリスト（今月分・全名義）
    db.collection("taxDocsChecklist").doc(currentYM).collection("entities").get(),
  ]);

  const checkouts = coSnap.docs.map((d) => d.data());
  const checkins = ciSnap.docs.map((d) => d.data());
  const unconfirmed = recruitSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.checkoutDate && r.checkoutDate <= threeDaysLater);
  const pendingConfirm = selectedSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.checkoutDate && r.checkoutDate <= threeDaysLater);
  const recentErrors = errorsSnap.docs
    .map((d) => d.data())
    .filter((e) => !e.notified);

  // ========== ブリーフィングテキスト生成 ==========
  let text = "━━━ 朝のブリーフィング ━━━\n\n";

  // ■ 民泊（今日）
  text += "■ 民泊（今日）\n";
  if (checkouts.length > 0) {
    text += `- CO: ${checkouts.length}件\n`;
    for (const co of checkouts) {
      text += `  ${co.guestName || "名前不明"} (${co.guestCount || "?"}名)\n`;
    }
  } else {
    text += "- CO: なし\n";
  }
  if (checkins.length > 0) {
    text += `- CI: ${checkins.length}件\n`;
    for (const ci of checkins) {
      text += `  ${ci.guestName || "名前不明"} (${ci.guestCount || "?"}名)\n`;
    }
  } else {
    text += "- CI: なし\n";
  }

  // ■ アラート（未確定）
  if (unconfirmed.length > 0 || pendingConfirm.length > 0) {
    text += "\n■ アラート\n";
    for (const r of unconfirmed) {
      const daysUntil = daysDiff(today, r.checkoutDate);
      const icon = daysUntil <= 1 ? "🔴" : "🟡";
      text += `${icon} ${r.checkoutDate} 清掃スタッフ未確定`;
      if (r.propertyName) text += `（${r.propertyName}）`;
      const responseCount = (r.responses || []).filter((x) => x.response === "◎" || x.response === "△").length;
      text += ` 回答${responseCount}件\n`;
    }
    for (const r of pendingConfirm) {
      text += `🟡 ${r.checkoutDate} 選定済み・未確定（${r.selectedStaff || "?"}）\n`;
    }
  }

  // ■ 経理（scan-sorter連携）
  if (scanPendingSnap.size > 0) {
    text += `\n■ 経理\n`;
    text += `- スキャン確認待ち: ${scanPendingSnap.size}件\n`;
  }

  // ■ TODO
  if (todosSnap.size > 0) {
    text += `\n■ TODO（未完了: ${todosSnap.size}件）\n`;
    const todos = todosSnap.docs.map((d) => d.data()).slice(0, 5);
    for (const todo of todos) {
      const due = todo.dueDate ? ` (期限: ${todo.dueDate})` : "";
      text += `- ${todo.title}${due}\n`;
    }
    if (todosSnap.size > 5) {
      text += `  ...他${todosSnap.size - 5}件\n`;
    }
  }

  // ■ 承認待ち
  if (approvalsSnap.size > 0) {
    text += `\n■ 承認待ち: ${approvalsSnap.size}件\n`;
    const approvals = approvalsSnap.docs.map((d) => d.data()).slice(0, 3);
    for (const a of approvals) {
      text += `- ${a.title}\n`;
    }
  }

  // ■ エラー
  if (recentErrors.length > 0) {
    text += `\n■ エラー（24h以内）: ${recentErrors.length}件\n`;
    for (const e of recentErrors.slice(0, 3)) {
      text += `🟡 ${e.functionName}: ${(e.errorMessage || "").slice(0, 50)}\n`;
    }
  }

  // ■ 税理士資料
  if (taxDocsEntitiesSnap.size > 0) {
    text += `\n■ 税理士資料（${parseInt(currentYM.split("-")[1])}月分）\n`;
    const dayOfMonth = new Date().getDate();
    const mfReminders = [];

    for (const doc of taxDocsEntitiesSnap.docs) {
      const cl = doc.data();
      const items = cl.items || [];
      const collected = cl.completedCount || items.filter((i) => i.collected).length;
      const total = cl.totalCount || items.length;

      const icon = cl.entityType === "法人" ? "🏢" : "👤";
      const status = collected === total ? "✅" : collected >= total / 2 ? "⚠️" : "❌";
      text += `${icon} ${cl.entityName}: ${collected}/${total}件 ${status}\n`;

      if (total === 0) {
        text += `${icon} ${cl.entityName}: 項目未登録\n`;
        continue;
      }

      const uncollected = items.filter((i) => !i.collected);
      if (uncollected.length > 0) {
        text += `  🟡 未収集: ${uncollected.map((i) => i.name).join(", ")}\n`;
      }

      if (dayOfMonth <= 7) {
        const mfItems = items.filter((i) => !i.collected && i.source === "moneyforward");
        mfItems.forEach((i) => mfReminders.push(`${i.name} → ${cl.entityName}`));
      }
    }

    if (mfReminders.length > 0) {
      text += `\n📋 MFエクスポートリマインド:\n`;
      mfReminders.forEach((r) => { text += `  □ ${r}\n`; });
    }
  }

  // ■ 今月の実績
  text += `\n■ 今月の実績\n`;
  text += `- 宿泊: ${monthSnap.size}件\n`;

  text += "\n━━━━━━━━━━━━━━━━━";

  console.log("朝ブリーフィング生成完了:", text.length, "文字");
  await notifyOwner(db, "briefing", "朝のブリーフィング", text);
};

// ユーティリティ
function getJSTDateString(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysDiff(dateStr1, dateStr2) {
  return Math.ceil((new Date(dateStr2) - new Date(dateStr1)) / (1000 * 60 * 60 * 24));
}
