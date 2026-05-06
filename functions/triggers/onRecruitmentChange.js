/**
 * 募集変更トリガー
 * - 回答が追加された → Webアプリ管理者にLINE通知 (通知タイプ: recruit_response)
 * - 物件の selectionMethod が "firstCome" で新規◎回答 → 即自動確定
 */
const { notifyByKey, resolveNotifyTargets, getNotificationSettings_ } = require("../utils/lineNotify");
const { workLabel } = require("../utils/workType");

module.exports = async function onRecruitmentChange(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const before = event.data.before?.data();
  const after = event.data.after?.data();
  if (!after) return;

  // ========= 手動募集の新規作成 → 即 shift も作成 (チェックリスト自動生成のため) =========
  // 通常フロー (予約由来) は onBookingChange が shift を生成するが、
  // 手動募集 (manualCreated=true, bookingId=null) は shift 未生成 → onShiftCreated 不発火
  // → checklists 永久に未生成。 ここで shift を補う。
  if (!before && after && after.manualCreated === true && after.propertyId && after.checkoutDate) {
    try {
      const targetWorkType = after.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count";
      const dt = new Date(after.checkoutDate);
      const dup = await db.collection("shifts")
        .where("propertyId", "==", after.propertyId)
        .where("date", "==", dt)
        .where("workType", "==", targetWorkType)
        .limit(1).get();
      if (dup.empty) {
        await db.collection("shifts").add({
          date: dt,
          propertyId: after.propertyId,
          propertyName: after.propertyName || "",
          bookingId: null,
          staffId: null,
          staffName: null,
          staffIds: [],
          startTime: "10:30",
          endTime: null,
          status: "unassigned",
          assignMethod: "manual",
          workType: targetWorkType,
          recruitmentId: event.params.recruitmentId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[onRecruitmentChange] 手動募集 → shift 新規作成 ${after.propertyId} ${after.checkoutDate} (${targetWorkType})`);
      }
    } catch (e) {
      console.error("[onRecruitmentChange] 手動募集 shift 新規作成エラー:", e);
    }
  }

  // ===== status 遷移: → "スタッフ確定済み" になったら対応 shift を同期 =====
  // (UI から Firestore SDK 直接更新でも、API 経由でも、ここで保証)
  if (before?.status !== "スタッフ確定済み" && after.status === "スタッフ確定済み") {
    try {
      const ids = Array.isArray(after.selectedStaffIds) ? after.selectedStaffIds : [];
      if (ids.length && after.propertyId && after.checkoutDate) {
        const targetWorkType = after.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count";
        const dt = new Date(after.checkoutDate);
        const shiftSnap = await db.collection("shifts")
          .where("propertyId", "==", after.propertyId)
          .where("date", "==", dt)
          .where("workType", "==", targetWorkType)
          .limit(1).get();
        const firstName = (after.selectedStaff || "").split(",")[0]?.trim() || null;
        if (!shiftSnap.empty) {
          const sd = shiftSnap.docs[0];
          const cur = sd.data();
          const curIds = Array.isArray(cur.staffIds) ? cur.staffIds : [];
          const same = cur.staffId === ids[0]
            && curIds.length === ids.length
            && curIds.every((x, i) => x === ids[i]);
          if (!same) {
            await sd.ref.update({
              staffId: ids[0],
              staffName: firstName,
              staffIds: ids,
              status: cur.status === "completed" ? "completed" : "assigned",
              assignMethod: cur.assignMethod || "trigger_sync",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`[onRecruitmentChange] shift同期 ${sd.id} staffIds=${JSON.stringify(ids)}`);
          }
        } else {
          // 既存 shift なし → 新規作成 (手動募集 + 後発確定 / 何らかの理由で shift が漏れたケース)
          // 作成後 onShiftCreated が発火 → checklist も自動生成される
          await db.collection("shifts").add({
            date: dt,
            propertyId: after.propertyId,
            propertyName: after.propertyName || "",
            bookingId: after.bookingId || null,
            staffId: ids[0],
            staffName: firstName,
            staffIds: ids,
            startTime: "10:30",
            endTime: null,
            status: "assigned",
            assignMethod: "trigger_create",
            workType: targetWorkType,
            recruitmentId: event.params.recruitmentId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[onRecruitmentChange] 確定時 shift 新規作成 ${after.propertyId} ${after.checkoutDate} staffIds=${JSON.stringify(ids)}`);
        }
      }
    } catch (e) {
      console.error("[onRecruitmentChange] shift同期エラー:", e);
    }
  }

  // ===== status 遷移: "スタッフ確定済み" → 解除 (reopen) → 対応 shift の staffIds をクリア =====
  // クリアしないと my-checklist が「本日の清掃担当」に旧スタッフ名を表示し続ける
  if (before?.status === "スタッフ確定済み" && after.status !== "スタッフ確定済み") {
    try {
      if (after.propertyId && after.checkoutDate) {
        const targetWorkType = after.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count";
        const dt = new Date(after.checkoutDate);
        // recruitmentId 紐付け優先 + フォールバックで date+pid+workType
        let shiftDocs = [];
        const byRid = await db.collection("shifts")
          .where("recruitmentId", "==", event.params.recruitmentId)
          .get();
        if (!byRid.empty) {
          shiftDocs = byRid.docs;
        } else {
          const byKey = await db.collection("shifts")
            .where("propertyId", "==", after.propertyId)
            .where("date", "==", dt)
            .where("workType", "==", targetWorkType)
            .limit(1).get();
          shiftDocs = byKey.docs;
        }
        for (const sd of shiftDocs) {
          const cur = sd.data();
          if (cur.status === "completed") continue; // 完了済みは触らない
          await sd.ref.update({
            staffId: null,
            staffName: null,
            staffIds: [],
            status: "unassigned",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[onRecruitmentChange] reopen → shift staffIds クリア ${sd.id}`);
        }
      }
    } catch (e) {
      console.error("[onRecruitmentChange] reopen 時 shift クリアエラー:", e);
    }
  }

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

      // フロー画面設定を尊重するため notifyByKey を使用
      await notifyByKey(db, "recruit_response", {
        title: `自動確定: ${checkoutDate}`,
        body: `⚡ 早い者勝ちルールにより自動確定\n\n` +
          `日付: ${checkoutDate}${propertyName ? ` (${propertyName})` : ""}\n` +
          `担当: ${staffName}\n`,
        vars: { date: checkoutDate, property: propertyName, staff: staffName, response, count: afterResponses.length, work: workLabel(after.workType), workType: after.workType || "cleaning" },
        propertyId: propertyId || null,
      });
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
    vars: { date: checkoutDate, property: propertyName, staff: staffName, response, count: available.length, work: workLabel(after.workType), workType: after.workType || "cleaning" },
    propertyId: propertyId || null,
  });
};
