/**
 * 募集変更トリガー
 * - 回答が追加された → オーナーにLINE通知 (通知タイプ: recruit_response)
 * - 物件の selectionMethod が "firstCome" で新規◎回答 → 即自動確定
 */
const { notifyOwner, resolveNotifyTargets, getNotificationSettings_ } = require("../utils/lineNotify");

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

  // 物件の selectionMethod を取得
  let selectionMethod = "ownerConfirm";
  if (propertyId) {
    const pd = await db.collection("properties").doc(propertyId).get();
    if (pd.exists) selectionMethod = pd.data().selectionMethod || "ownerConfirm";
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

      const shiftSnap = await db.collection("shifts")
        .where("propertyId", "==", propertyId)
        .where("date", "==", new Date(checkoutDate))
        .limit(1).get();
      if (!shiftSnap.empty) {
        await shiftSnap.docs[0].ref.update({
          staffId: staffId || null,
          staffName,
          staffIds: staffId ? [staffId] : [],
          status: "assigned",
          assignMethod: "firstCome",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
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

  // recruit_response が無効化されていれば送信しない
  const { settings } = await getNotificationSettings_(db);
  const targets = resolveNotifyTargets(settings, "recruit_response");
  if (!targets.enabled) return;

  // 通常通知
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

  await notifyOwner(db, "recruit_response", `募集回答: ${checkoutDate}`, text,
    { date: checkoutDate, property: propertyName, staff: staffName, response, count: available.length });
};
