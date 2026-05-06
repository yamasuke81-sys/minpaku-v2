/**
 * 募集管理 API
 * 募集CRUD + スタッフ回答 + 選定・確定 + LINE通知
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const {
  notifyStaff, notifyGroup, notifyOwner,
  notifyByKey, buildRecruitmentFlex, resolveNotifyTargets, getNotificationSettings_,
} = require("../utils/lineNotify");
const { addRecruitmentToActiveStaff, removeRecruitmentFromStaff, removeRecruitmentFromAllStaff } = require("../utils/inactiveStaff");

module.exports = function recruitmentApi(db) {
  const router = Router();
  const collection = db.collection("recruitments");

  // 募集一覧取得（回答データ含む）
  router.get("/", async (req, res) => {
    try {
      const statusFilter = req.query.status;
      let query = collection.orderBy("checkoutDate", "desc");
      if (statusFilter) {
        query = query.where("status", "==", statusFilter);
      }
      const snapshot = await query.get();
      const list = [];
      for (const doc of snapshot.docs) {
        const data = { id: doc.id, ...doc.data() };
        // サブコレクションから回答取得
        const respSnap = await collection.doc(doc.id).collection("responses").get();
        data.responses = respSnap.docs.map((r) => ({ id: r.id, ...r.data() }));
        list.push(data);
      }
      res.json(list);
    } catch (e) {
      console.error("募集一覧取得エラー:", e);
      res.status(500).json({ error: "募集一覧の取得に失敗しました" });
    }
  });

  // 募集詳細取得
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const data = { id: doc.id, ...doc.data() };
      const respSnap = await collection.doc(doc.id).collection("responses").get();
      data.responses = respSnap.docs.map((r) => ({ id: r.id, ...r.data() }));
      res.json(data);
    } catch (e) {
      console.error("募集取得エラー:", e);
      res.status(500).json({ error: "募集の取得に失敗しました" });
    }
  });

  // 募集作成
  router.post("/", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const data = validateRecruitmentData(req.body);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
      data.createdAt = FieldValue.serverTimestamp();
      data.updatedAt = FieldValue.serverTimestamp();
      const docRef = await collection.add(data);

      // LINE通知送信（非同期、エラーでもAPIは成功とする）
      // 注: bookingId が紐付く募集は onBookingChange トリガー側で recruit_start を送るため
      //     ここでは bookingId が無い手動作成のケースのみ通知する（二重送信防止）
      try {
        const shouldNotify = !data.bookingId;
        const { settings } = await getNotificationSettings_(db);
        // 物件別オーバーライドを取得
        let propertyOverrides = {};
        if (data.propertyId) {
          const propDoc = await db.collection("properties").doc(data.propertyId).get();
          if (propDoc.exists) propertyOverrides = propDoc.data().channelOverrides || {};
        }
        if (shouldNotify) {
          const appUrl = (settings && settings.appUrl) || process.env.APP_BASE_URL || "https://minpaku-v2.web.app";
          const recruitUrl = `${appUrl.replace(/\/$/, "")}/#/my-recruitment`;
          const work = data.workType === "pre_inspection" ? "直前点検" : "清掃";
          const baseVars = {
            date: data.checkoutDate,
            checkoutDate: data.checkoutDate,
            property: data.propertyName || "",
            propertyName: data.propertyName || "",
            work,
            url: recruitUrl,
            memo: data.memo || "",
          };
          // notifyByKey で ownerLine/groupLine/staffLine を一括送信 (recruit_start)
          await notifyByKey(db, "recruit_start", {
            title: `募集: ${data.checkoutDate}`,
            body: `🧹 ${work}スタッフ募集\n${data.checkoutDate} ${data.propertyName || ""}\n回答: ${recruitUrl}`,
            vars: baseVars,
            propertyId: data.propertyId || null,
          });
        }
      } catch (notifyErr) {
        console.error("募集通知エラー（無視）:", notifyErr);
      }

      // E: pendingRecruitmentIds 更新
      try { await addRecruitmentToActiveStaff(db, docRef.id); } catch (e) { console.error("addRecruitmentToActiveStaff エラー:", e); }

      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("募集作成エラー:", e);
      res.status(500).json({ error: "募集の作成に失敗しました" });
    }
  });

  // 募集更新
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const data = validateRecruitmentData(req.body, true);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
      data.updatedAt = FieldValue.serverTimestamp();
      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("募集更新エラー:", e);
      res.status(500).json({ error: "募集の更新に失敗しました" });
    }
  });

  // 募集削除
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      // staff の pendingRecruitmentIds から除去してから削除
      await removeRecruitmentFromAllStaff(db, req.params.id);
      // サブコレクションの回答も削除
      const respSnap = await docRef.collection("responses").get();
      const batch = db.batch();
      respSnap.docs.forEach((r) => batch.delete(r.ref));
      batch.delete(docRef);
      await batch.commit();
      res.json({ message: "募集を削除しました" });
    } catch (e) {
      console.error("募集削除エラー:", e);
      res.status(500).json({ error: "募集の削除に失敗しました" });
    }
  });

  // スタッフ回答（◎/△/×）— Upsert
  router.post("/:id/respond", async (req, res) => {
    try {
      const recruitRef = collection.doc(req.params.id);
      const recruitDoc = await recruitRef.get();
      if (!recruitDoc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const recruitData = recruitDoc.data();
      if (recruitData.status === "スタッフ確定済み") {
        return res.status(400).json({ error: "この募集はスタッフ確定済みです" });
      }
      const { staffId, staffName, staffEmail, response, memo } = req.body;
      if (!staffName) {
        return res.status(400).json({ error: "スタッフ名は必須です" });
      }
      if (!["◎", "△", "×"].includes(response)) {
        return res.status(400).json({ error: "無効な回答です。◎/△/×で回答してください" });
      }
      // E: 非アクティブスタッフは回答不可
      if (staffId) {
        try {
          const sDoc = await db.collection("staff").doc(staffId).get();
          if (sDoc.exists && sDoc.data().active === false) {
            return res.status(403).json({
              error: sDoc.data().inactiveReason ||
                "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はWebアプリ管理者までご連絡ください。",
              inactive: true,
            });
          }
        } catch (_) {}
      }
      // Upsert: staffIdまたはstaffEmailで既存回答を検索
      const respColl = recruitRef.collection("responses");
      let existingDoc = null;
      if (staffId) {
        const byId = await respColl.where("staffId", "==", staffId).get();
        if (!byId.empty) existingDoc = byId.docs[0];
      }
      if (!existingDoc && staffEmail) {
        const byEmail = await respColl.where("staffEmail", "==", staffEmail).get();
        if (!byEmail.empty) existingDoc = byEmail.docs[0];
      }
      const responseData = {
        staffId: staffId || "",
        staffName: staffName,
        staffEmail: staffEmail || "",
        response: response,
        memo: memo || "",
        respondedAt: FieldValue.serverTimestamp(),
      };
      if (existingDoc) {
        await existingDoc.ref.update(responseData);
      } else {
        await respColl.add(responseData);
      }
      // E: pendingRecruitmentIds から除去
      try {
        if (staffId) await removeRecruitmentFromStaff(db, staffId, req.params.id);
      } catch (e) { console.error("removeRecruitmentFromStaff エラー:", e); }
      if (existingDoc) {
        res.json({ id: existingDoc.id, updated: true, ...responseData });
      } else {
        res.status(201).json({ ok: true, ...responseData });
      }
    } catch (e) {
      console.error("回答エラー:", e);
      res.status(500).json({ error: "回答の送信に失敗しました" });
    }
  });

  // 回答取消
  router.delete("/:id/respond/:responseId", async (req, res) => {
    try {
      const respRef = collection.doc(req.params.id).collection("responses").doc(req.params.responseId);
      const respDoc = await respRef.get();
      if (!respDoc.exists) {
        return res.status(404).json({ error: "回答が見つかりません" });
      }
      await respRef.delete();
      res.json({ message: "回答を取り消しました" });
    } catch (e) {
      console.error("回答取消エラー:", e);
      res.status(500).json({ error: "回答の取り消しに失敗しました" });
    }
  });

  // スタッフ選定（Webアプリ管理者のみ）
  router.put("/:id/select", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const { selectedStaff, selectedStaffIds } = req.body;
      await docRef.update({
        selectedStaff: selectedStaff || "",
        selectedStaffIds: selectedStaffIds || [],
        status: selectedStaff ? "選定済" : "募集中",
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "スタッフを選定しました" });
    } catch (e) {
      console.error("スタッフ選定エラー:", e);
      res.status(500).json({ error: "スタッフの選定に失敗しました" });
    }
  });

  // 募集確定（Webアプリ管理者のみ）
  router.put("/:id/confirm", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const data = doc.data();
      // selectedStaffIds が空配列または未定義なら確定不可
      const ids = data.selectedStaffIds;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "スタッフが選択されていません" });
      }
      await docRef.update({
        status: "スタッフ確定済み",
        confirmedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // 確定スタッフにLINE通知
      try {
        const selectedIds = data.selectedStaffIds || [];
        const selectedNames = (data.selectedStaff || "").split(",").map(s => s.trim()).filter(Boolean);
        const hasIdList = selectedIds.length > 0;

        if (hasIdList || selectedNames.length > 0) {
          // 確定通知用の appUrl + dashboard URL
          let appUrl = "https://minpaku-v2.web.app";
          try {
            const { settings } = await getNotificationSettings_(db);
            appUrl = settings?.appUrl || appUrl;
          } catch (_) { /* デフォルトで続行 */ }
          const dashUrl = `${appUrl.replace(/\/$/, "")}/#/my-dashboard`;
          const staffSnap = await db.collection("staff").where("active", "==", true).get();
          // 確定スタッフ全員の表示名を ID 順で組み立て (テンプレ {staff} 用)
          const idToName = new Map();
          staffSnap.docs.forEach(d => idToName.set(d.id, d.data().name || ""));
          const allConfirmedNames = hasIdList
            ? selectedIds.map(id => idToName.get(id) || "").filter(Boolean).join("、")
            : selectedNames.join("、");
          const text = `✅ 清掃確定のお知らせ\n\n${data.checkoutDate} ${data.propertyName || ""}\n担当: ${allConfirmedNames}\nよろしくお願いします。\n詳細: ${dashUrl}`;
          const confirmVars = {
            date: data.checkoutDate,
            checkoutDate: data.checkoutDate,
            property: data.propertyName || "",
            propertyName: data.propertyName || "",
            staff: allConfirmedNames,
            url: dashUrl,
          };

          // ownerLine/groupLine/ownerEmail/subOwner系 は notifyByKey で一括 (staffLine は除外)
          // staffLine は確定者本人のみに個別送信するため現行ロジックを維持
          await notifyByKey(db, "staff_confirm", {
            title: `確定: ${data.checkoutDate}`,
            body: text,
            vars: confirmVars,
            propertyId: data.propertyId || null,
            staffIds: [], // staffLine を notifyByKey に送らせない（空配列で全スタッフ送信を抑止）
          });

          // 確定スタッフ本人のみに staffLine 個別送信
          for (const staffDoc of staffSnap.docs) {
            const sd = staffDoc.data();
            const isSelected = hasIdList
              ? selectedIds.includes(staffDoc.id)
              : selectedNames.includes(sd.name);
            if (isSelected && sd.lineUserId) {
              await notifyStaff(db, staffDoc.id, "staff_confirm",
                `確定: ${data.checkoutDate}`, text,
                {
                  ...confirmVars,
                  staffName: sd.name, // 受信者本人の名前（個別呼びかけ用）
                });
            }
          }
        }
      } catch (notifyErr) {
        console.error("確定通知エラー（無視）:", notifyErr);
      }

      // shift upsert: propertyId + checkoutDate + workType で検索し、なければ作成・あれば更新
      // 【修正3】workType 条件を追加 — 同日に清掃と直前点検が両方ある場合に互いを上書きしないようにする
      // 変更前: propertyId + date のみで検索 → 異なる workType の shift を誤って上書きしていた
      // 変更後: workType も条件に加えて正しい shift のみ更新する
      try {
        const targetWorkType = data.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count";
        const shiftSnap = await db.collection("shifts")
          .where("propertyId", "==", data.propertyId)
          .where("date", "==", new Date(data.checkoutDate))
          .where("workType", "==", targetWorkType)
          .limit(1)
          .get();

        // property から cleaningStartTime を取得
        let cleaningStartTime = "10:30";
        if (data.propertyId) {
          try {
            const propDoc = await db.collection("properties").doc(data.propertyId).get();
            if (propDoc.exists) cleaningStartTime = propDoc.data().cleaningStartTime || "10:30";
          } catch (_) { /* デフォルトで続行 */ }
        }

        const firstStaffId = (data.selectedStaffIds || [])[0] || null;
        const firstStaffName = (data.selectedStaff || "").split(",")[0]?.trim() || null;

        if (shiftSnap.empty) {
          // 新規作成 → onShiftCreated トリガーが発火して checklist 自動生成
          await db.collection("shifts").add({
            date: new Date(data.checkoutDate),
            propertyId: data.propertyId,
            propertyName: data.propertyName || "",
            bookingId: data.bookingId || null,
            workType: data.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count",
            staffId: firstStaffId,
            staffName: firstStaffName,
            staffIds: data.selectedStaffIds || [],
            startTime: cleaningStartTime,
            status: "assigned",
            assignMethod: "manual_confirm",
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          console.log(`shift 新規作成: propertyId=${data.propertyId}, date=${data.checkoutDate}`);
        } else {
          // 既存を更新
          await shiftSnap.docs[0].ref.update({
            staffId: firstStaffId,
            staffName: firstStaffName,
            staffIds: data.selectedStaffIds || [],
            status: "assigned",
            assignMethod: "manual_confirm",
            updatedAt: FieldValue.serverTimestamp(),
          });
          console.log(`shift 更新: ${shiftSnap.docs[0].id}`);
        }
      } catch (shiftErr) {
        console.error("shift upsert エラー（確定は継続）:", shiftErr);
      }

      res.json({ message: "スタッフを確定しました" });
    } catch (e) {
      console.error("募集確定エラー:", e);
      res.status(500).json({ error: "募集の確定に失敗しました" });
    }
  });

  // 募集再開（確定解除）
  router.put("/:id/reopen", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      await docRef.update({
        status: "募集中",
        confirmedAt: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "募集を再開しました" });
    } catch (e) {
      console.error("募集再開エラー:", e);
      res.status(500).json({ error: "募集の再開に失敗しました" });
    }
  });

  /**
   * 清掃日変更通知 (UI から呼ばれる、recruitment.checkoutDate は UI 側で既に更新済み)
   * - 既回答スタッフに recruit_date_change 通知 (新日付・旧日付を変数で渡す)
   * - 全スタッフに recruit_start 通知 (変更後の日付について再募集)
   * Body: { recruitmentId, oldDate, newDate }
   */
  router.post("/notify-date-change", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const { recruitmentId, oldDate, newDate } = req.body || {};
      if (!recruitmentId || !oldDate || !newDate) {
        return res.status(400).json({ error: "recruitmentId / oldDate / newDate 必須" });
      }
      const docRef = collection.doc(recruitmentId);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "募集が見つかりません" });
      const r = doc.data();

      const { settings } = await getNotificationSettings_(db);
      const appUrl = settings?.appUrl || "https://minpaku-v2.web.app";
      const recruitUrl = `${appUrl}/#/my-recruitment`;
      const propertyName = r.propertyName || "";
      const responses = Array.isArray(r.responses) ? r.responses : [];

      // 1) 既回答スタッフに日付変更通知 (個別 LINE)
      const respondedStaffIds = [...new Set(responses.map(rr => rr.staffId).filter(Boolean))];
      let staffNotified = 0;
      for (const sid of respondedStaffIds) {
        try {
          await notifyStaff(db, sid, "recruit_date_change",
            `清掃日が変更されました: ${oldDate} → ${newDate}`,
            `【清掃日変更】\n${propertyName}\n旧: ${oldDate}\n新: ${newDate}\n\n回答内容は新しい日付の募集に引き継がれます。\n変更を確認: ${recruitUrl}`,
            { date: newDate, oldDate, property: propertyName, url: recruitUrl, work: "清掃" },
            {} // propertyOverrides
          );
          staffNotified++;
        } catch (e) {
          console.warn(`日付変更通知 staff=${sid} 失敗:`, e.message);
        }
      }

      // 2) recruit_start 通知 (変更後の日付について再募集)
      try {
        const memo = r.memo || "";
        await notifyByKey(db, "recruit_start", {
          title: `清掃スタッフ募集: ${newDate} (日程変更)`,
          body: `【清掃スタッフ募集 (日程変更)】\n${newDate} ${propertyName}\n${memo}\n※ ${oldDate} → ${newDate} に変更されました。\n回答: ${recruitUrl}`,
          vars: {
            date: newDate, property: propertyName, work: "清掃",
            url: recruitUrl, memo, note: `※ ${oldDate} → ${newDate} に変更されました。`,
          },
          propertyId: r.propertyId || null,
        });
      } catch (e) {
        console.warn("recruit_start 通知失敗:", e.message);
      }

      res.json({
        message: `日付変更通知を送信しました (既回答 ${staffNotified}名 + 全スタッフ募集通知)`,
        respondedStaffNotified: staffNotified,
      });
    } catch (e) {
      console.error("日付変更通知エラー:", e);
      res.status(500).json({ error: e.message || "日付変更通知に失敗しました" });
    }
  });

  return router;
};

/**
 * 募集データのバリデーション
 */
function validateRecruitmentData(body, isUpdate = false) {
  const data = {};
  if (!isUpdate && !body.checkoutDate) {
    return { error: "チェックアウト日は必須です" };
  }
  if (!isUpdate && !body.propertyId) {
    return { error: "propertyIdは必須です" };
  }
  if (body.checkoutDate !== undefined) data.checkoutDate = String(body.checkoutDate).trim();
  if (body.propertyId !== undefined) data.propertyId = String(body.propertyId).trim();
  if (body.propertyName !== undefined) data.propertyName = String(body.propertyName).trim();
  if (body.bookingId !== undefined) data.bookingId = String(body.bookingId).trim();
  if (body.status !== undefined) data.status = String(body.status).trim();
  if (body.selectedStaff !== undefined) data.selectedStaff = String(body.selectedStaff).trim();
  if (body.notifyMethod !== undefined) data.notifyMethod = String(body.notifyMethod).trim();
  if (body.memo !== undefined) data.memo = String(body.memo).trim();
  // 次回予約情報
  if (body.nextReservation !== undefined) data.nextReservation = body.nextReservation;
  // 新規登録時デフォルト値
  if (!isUpdate) {
    if (!data.status) data.status = "募集中";
    if (!data.notifyMethod) data.notifyMethod = "メール";
    if (!data.selectedStaff) data.selectedStaff = "";
  }
  return data;
}
