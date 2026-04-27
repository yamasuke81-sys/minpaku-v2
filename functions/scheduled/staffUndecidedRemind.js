/**
 * スタッフ未決定リマインド（毎朝11:00 JST）
 * 今日から3日以内に実施予定の recruitment で status="募集中"（スタッフ未確定）のものを通知
 */
const admin = require("firebase-admin");
const {
  notifyByKey,
  getNotificationSettings_,
} = require("../utils/lineNotify");

const APP_URL = "https://minpaku-v2.web.app";
const NOTIFY_TYPE = "staff_undecided";

module.exports = async function staffUndecidedRemind(event) {
  const db = admin.firestore();

  try {
    // 今日〜3日後の日付文字列を算出
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const limitDate = new Date(now);
    limitDate.setDate(limitDate.getDate() + 3);
    const limitStr = limitDate.toISOString().slice(0, 10);

    // status="募集中" の募集を全件取得（Firestoreインデックス不要のため全件取得後フィルタ）
    const recruitSnap = await db.collection("recruitments")
      .where("status", "==", "募集中")
      .get();

    if (recruitSnap.empty) {
      console.log("スタッフ未決定リマインド: 募集中の案件なし");
      return;
    }

    // checkoutDate が今日〜3日以内のものに絞る
    const targets = recruitSnap.docs.filter(d => {
      const date = d.data().checkoutDate || "";
      return date >= todayStr && date <= limitStr;
    });

    if (targets.length === 0) {
      console.log(`スタッフ未決定リマインド: ${todayStr}〜${limitStr} の対象なし`);
      return;
    }

    console.log(`スタッフ未決定リマインド: ${targets.length}件対象`);

    // 今日すでに送信済みの募集IDセットを取得（重複防止）
    const sentTodaySnap = await db.collection("notifications")
      .where("type", "==", NOTIFY_TYPE)
      .where("sentDate", "==", todayStr)
      .get();
    const sentTodayIds = new Set(sentTodaySnap.docs.map(d => d.data().recruitmentId).filter(Boolean));

    let sentCount = 0;

    for (const doc of targets) {
      const r = doc.data();

      // 今日すでに通知済みの募集はスキップ
      if (sentTodayIds.has(doc.id)) {
        console.log(`スタッフ未決定リマインド: ${doc.id} は今日送信済み — スキップ`);
        continue;
      }

      const propertyName = r.propertyName || r.propertyId || "";
      const date = r.checkoutDate || "";
      const recruitUrl = `${APP_URL}/#/recruitment`;

      const defaultMsg = [
        `⚠️ スタッフ未確定 警告`,
        ``,
        `物件: ${propertyName}`,
        `清掃日: ${date}`,
        ``,
        `3日以内にスタッフが確定していません。`,
        `募集画面: ${recruitUrl}`,
      ].join("\n");

      const title = `スタッフ未確定: ${propertyName} (${date})`;

      // notifyByKey で設定 ON/OFF と物件別オーバーライドを自動適用
      const result = await notifyByKey(db, NOTIFY_TYPE, {
        title,
        body: defaultMsg,
        vars: { date, property: propertyName, url: recruitUrl, staff: "", count: String((r.responses || []).length) },
        propertyId: r.propertyId || null,
      });

      const anySuccess = Object.values(result.sent || {}).some(v => v);
      if (anySuccess) {
        sentCount++;
        // 送信日と募集IDを記録（次回実行時の重複防止用）
        try {
          await db.collection("notifications").add({
            type: NOTIFY_TYPE,
            recruitmentId: doc.id,
            sentDate: todayStr,
            title,
            body: "",
            sentAt: new Date(),
            channel: "dedup_guard",
            success: true,
          });
        } catch (logErr) { /* 無視 */ }
      }
    }

    console.log(`スタッフ未決定リマインド完了: ${sentCount}/${targets.length}件送信`);
  } catch (e) {
    console.error("スタッフ未決定リマインドエラー:", e);
    try {
      const db2 = admin.firestore();
      await db2.collection("error_logs").add({
        functionName: "staffUndecidedRemind",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (logErr) { /* 無視 */ }
  }
};
