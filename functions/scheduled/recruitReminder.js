/**
 * 募集リマインド（毎日18:00 JST）
 * 「募集中」の募集で未回答のスタッフに個別LINEリマインド
 */
const admin = require("firebase-admin");
const { notifyStaff, getNotificationSettings_, resolveNotifyTargets } = require("../utils/lineNotify");

module.exports = async function recruitReminder(event) {
  const db = admin.firestore();

  try {
    // 通知設定確認
    const { settings } = await getNotificationSettings_(db);
    const targets = resolveNotifyTargets(settings, "recruit_remind");
    if (!targets.enabled || !targets.sendToIndividual) {
      console.log("募集リマインドは無効化されています");
      return;
    }

    // 「募集中」の募集を取得
    const recruitSnap = await db.collection("recruitments")
      .where("status", "==", "募集中")
      .get();

    if (recruitSnap.empty) {
      console.log("募集中の案件なし — リマインド不要");
      return;
    }

    // アクティブなスタッフ（LINE連携済み）を取得
    const staffSnap = await db.collection("staff")
      .where("active", "==", true)
      .get();
    const lineStaff = staffSnap.docs
      .filter(d => d.data().lineUserId)
      .map(d => ({ id: d.id, ...d.data() }));

    if (lineStaff.length === 0) {
      console.log("LINE連携済みスタッフなし — リマインド不要");
      return;
    }

    let sentCount = 0;

    for (const recruitDoc of recruitSnap.docs) {
      const recruitment = recruitDoc.data();
      const responses = recruitment.responses || [];
      const respondedStaffIds = new Set(responses.map(r => r.staffId).filter(Boolean));

      // 未回答スタッフを特定
      const unreplied = lineStaff.filter(s => !respondedStaffIds.has(s.id));

      if (unreplied.length === 0) continue;

      // 重複防止: 今日既にこの募集のリマインドを送信済みか確認
      const todayStr = new Date().toISOString().slice(0, 10);
      const notifSnap = await db.collection("notifications")
        .where("type", "==", "recruit_remind")
        .where("title", "==", `リマインド: ${recruitment.checkoutDate}`)
        .get();

      const todayNotified = notifSnap.docs.some(d => {
        const sentAt = d.data().sentAt;
        if (!sentAt) return false;
        const sentDate = sentAt.toDate ? sentAt.toDate() : new Date(sentAt);
        return sentDate.toISOString().slice(0, 10) === todayStr;
      });

      if (todayNotified) {
        console.log(`${recruitment.checkoutDate} のリマインドは今日送信済み — スキップ`);
        continue;
      }

      // リマインドメッセージ
      const baseUrl = process.env.APP_BASE_URL || "https://minpaku-v2.web.app/";
      const text = [
        `📋 募集回答のお願い`,
        ``,
        `${recruitment.checkoutDate} ${recruitment.propertyName || ""}`,
        `清掃スタッフ募集にまだ回答がありません。`,
        ``,
        `回答はこちら: ${baseUrl}#/my-recruitment`,
      ].join("\n");

      // 未回答スタッフに個別送信
      const sends = unreplied.map(s =>
        notifyStaff(db, s.id, "recruit_remind", `リマインド: ${recruitment.checkoutDate}`, text)
      );
      const results = await Promise.allSettled(sends);
      sentCount += results.filter(r => r.status === "fulfilled" && r.value?.success).length;
    }

    console.log(`募集リマインド完了: ${sentCount}件送信`);
  } catch (e) {
    console.error("募集リマインドエラー:", e);
    // エラーログに記録
    try {
      await db.collection("error_logs").add({
        functionName: "recruitReminder",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (logErr) { /* 無視 */ }
  }
};
