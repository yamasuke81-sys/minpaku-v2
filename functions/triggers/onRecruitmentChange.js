/**
 * 募集変更トリガー
 * 回答が追加された → オーナーにLINE通知
 * 全員回答済み → 「選定してください」通知
 */
const { notifyOwner } = require("../utils/lineNotify");

module.exports = async function onRecruitmentChange(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const before = event.data.before?.data();
  const after = event.data.after?.data();

  // 削除の場合はスキップ
  if (!after) return;

  const beforeResponses = before?.responses || [];
  const afterResponses = after.responses || [];

  // 回答数が増えた場合のみ通知
  if (afterResponses.length <= beforeResponses.length) return;

  // 新しい回答を特定
  const newResponse = afterResponses[afterResponses.length - 1];
  if (!newResponse) return;

  const staffName = newResponse.staffName || "不明";
  const response = newResponse.response || "?";
  const checkoutDate = after.checkoutDate || "?";
  const propertyName = after.propertyName || "";

  let text = `📋 募集に回答がありました\n\n`;
  text += `日付: ${checkoutDate}`;
  if (propertyName) text += ` (${propertyName})`;
  text += `\n`;
  text += `${staffName}: ${response}\n`;

  // 回答状況サマリー
  const available = afterResponses.filter((r) => r.response === "◎" || r.response === "△");
  const declined = afterResponses.filter((r) => r.response === "×");
  text += `\n現在の回答状況: ◎△ ${available.length}名 / × ${declined.length}名\n`;

  if (available.length > 0) {
    text += `\n候補: ${available.map((r) => `${r.staffName}(${r.response})`).join(", ")}\n`;
    text += "→ スタッフを選定・確定してください";
  }

  await notifyOwner(db, "response", `募集回答: ${checkoutDate}`, text);
};
