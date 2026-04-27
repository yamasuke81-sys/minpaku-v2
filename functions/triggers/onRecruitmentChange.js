/**
 * 募集変更トリガー
 * - 回答が追加された → Webアプリ管理者にLINE通知 (通知タイプ: recruit_response)
 * - 物件の selectionMethod が "firstCome" で新規◎回答 → 即自動確定
 */
const { notifyByKey, resolveNotifyTargets, getNotificationSettings_ } = require("../utils/lineNotify");

module.exports = async function onRecruitmentChange(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const before = event.data.before?.data();
  const after = event.data.after?.data();
  if (!after) return;

  const beforeResponses = before?.responses || [];
  const afterResponses = after.responses || [];
  if (afterResponses.length <= beforeResponses.length) return;

  const newResponse = afterResponses[afterResponses.length - 1];
  if (!newResponse) return;

  const staffName = newResponse.staffName || "不明";
  const response = newResponse.response || "?";
  const checkoutDate = after.checkoutDate || "?";
  const propertyName = after.propertyName || "";
  const propertyId = after.propertyId || "";
  const recruitmentId = event.params.recruitmentId;

  // 物件データを取得（selectionMethod と channelOverrides を共通取得）
  let selectionMethod = "ownerConfirm";
  let propertyOverrides = {};
  if (propertyId) {
    const pd = await db.collection("properties").doc(propertyId).get();
    if (pd.exists) {
      selectionMethod = pd.data().selectionMethod || "ownerConfirm";
      propertyOverrides = pd.data().channelOverrides || {};
    }
  }

  // firstCome: ◎回答で即自動確定
  if (selectionMethod === "firstCome" && response === "◎" && after.status !== "スタッフ確定済み") {
    const staffId = newResponse.staffId || "";
    try {
      await db.collection("recruitments").doc(recruitmentId).update({
        status: "スタッフ確定済み",
        selectedStaff: staffName,
        selectedStaffIds: staffId ? [staffId] : [],
        confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // bookingId で絞り込んでから JS 側で日付文字列比較 (Timestamp 精度問題を回避)
      const bookingId = after.bookingId || "";
      console.log(`[firstCome] checkoutDate=${checkoutDate} propertyId=${propertyId} bookingId=${bookingId} staffId=${staffId}`);
      let shiftQuery = db.collection("shifts").where("propertyId", "==", propertyId);
      if (bookingId) shiftQuery = shiftQuery.where("bookingId", "==", bookingId);
      const shiftSnap = await shiftQuery.limit(5).get();
      console.log(`[firstCome] shift候補数=${shiftSnap.size}`);
      const targetShift = shiftSnap.docs.find((d) => {
        const sd = d.data();
        const dstr = sd.date?.toDate ? sd.date.toDate().toISOString().slice(0, 10) : String(sd.date).slice(0, 10);
        console.log(`[firstCome] shift=${d.id} date=${dstr}`);
        return dstr === checkoutDate;
      });
      if (targetShift) {
        await targetShift.ref.update({
          staffId: staffId || null,
          staffName,
          staffIds: staffId ? [staffId] : [],
          status: "assigned",
          assignMethod: "firstCome",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[firstCome] shift更新完了: ${targetShift.id}`);
      } else {
        console.warn(`[firstCome] 対象shiftが見つからず: checkoutDate=${checkoutDate} propertyId=${propertyId} bookingId=${bookingId}`);
      }

      await notifyOwner(
        db, "recruit_response",
        `自動確定: ${checkoutDate}`,
        `⚡ 早い者勝ちルールにより自動確定\n\n` +
        `日付: ${checkoutDate}${propertyName ? ` (${propertyName})` : ""}\n` +
        `担当: ${staffName}\n`,
        { date: checkoutDate, property: propertyName, staff: staffName, response, count: afterResponses.length }
      );
      return;
    } catch (e) {
      console.error("firstCome 自動確定失敗:", e);
    }
  }

  // recruit_response: notifyByKey で送信 (設定 ON/OFF は内部で判定)
  const available = afterResponses.filter((r) => r.response === "◎" || r.response === "△");
  const declined = afterResponses.filter((r) => r.response === "×");

  let text = `📋 募集に回答がありました\n\n`;
  text += `日付: ${checkoutDate}`;
  if (propertyName) text += ` (${propertyName})`;
  text += `\n`;
  text += `${staffName}: ${response}\n`;
  text += `\n現在の回答状況: ◎△ ${available.length}名 / × ${declined.length}名\n`;

  if (available.length > 0) {
    text += `\n候補: ${available.map((r) => `${r.staffName}(${r.response})`).join(", ")}\n`;
    text += "→ スタッフを選定・確定してください";
  }

  await notifyByKey(db, "recruit_response", {
    title: `募集回答: ${checkoutDate}`,
    body: text,
    vars: { date: checkoutDate, property: propertyName, staff: staffName, response, count: available.length },
    propertyId: propertyId || null,
  });
};
