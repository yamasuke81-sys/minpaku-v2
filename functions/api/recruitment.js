/**
 * 募集管理 API
 * 募集CRUD + スタッフ回答 + 選定・確定 + LINE通知
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const {
  notifyStaff, notifyGroup, notifyOwner,
  buildRecruitmentFlex, resolveNotifyTargets, getNotificationSettings_,
} = require("../utils/lineNotify");

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
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const data = validateRecruitmentData(req.body);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
      data.createdAt = FieldValue.serverTimestamp();
      data.updatedAt = FieldValue.serverTimestamp();
      const docRef = await collection.add(data);

      // LINE通知送信（非同期、エラーでもAPIは成功とする）
      try {
        const { settings } = await getNotificationSettings_(db);
        const targets = resolveNotifyTargets(settings, "recruit_start");
        if (targets.enabled) {
          const baseUrl = process.env.APP_BASE_URL || "https://minpaku-v2.web.app/";
          const flex = buildRecruitmentFlex(data, baseUrl);
          const title = `募集: ${data.checkoutDate}`;

          // オーナーLINEに送信
          if (targets.ownerLine) {
            await notifyOwner(db, "recruit_start", title, `🧹 清掃スタッフ募集\n${data.checkoutDate} ${data.propertyName || ""}`);
          }
          // グループLINEに送信
          if (targets.groupLine) {
            await notifyGroup(db, "recruit_start", title, flex);
          }
          // スタッフ個別LINEに送信
          if (targets.staffLine) {
            const staffSnap = await db.collection("staff").where("active", "==", true).get();
            const sends = staffSnap.docs
              .filter(d => d.data().lineUserId)
              .map(d => notifyStaff(db, d.id, "recruit_start", title, flex));
            await Promise.allSettled(sends);
          }
        }
      } catch (notifyErr) {
        console.error("募集通知エラー（無視）:", notifyErr);
      }

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
        return res.status(403).json({ error: "オーナー権限が必要です" });
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
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
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
        res.json({ id: existingDoc.id, updated: true, ...responseData });
      } else {
        const ref = await respColl.add(responseData);
        res.status(201).json({ id: ref.id, ...responseData });
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

  // スタッフ選定（オーナーのみ）
  router.put("/:id/select", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
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

  // 募集確定（オーナーのみ）
  router.put("/:id/confirm", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "募集が見つかりません" });
      }
      const data = doc.data();
      if (!data.selectedStaff) {
        return res.status(400).json({ error: "スタッフが選定されていません" });
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
          const staffSnap = await db.collection("staff").where("active", "==", true).get();
          const text = `✅ 清掃確定のお知らせ\n\n${data.checkoutDate} ${data.propertyName || ""}\nあなたが清掃担当に確定されました。`;
          for (const staffDoc of staffSnap.docs) {
            const sd = staffDoc.data();
            // IDリストがあればID照合優先、なければ名前照合にフォールバック
            const isSelected = hasIdList
              ? selectedIds.includes(staffDoc.id)
              : selectedNames.includes(sd.name);
            if (isSelected && sd.lineUserId) {
              await notifyStaff(db, staffDoc.id, "staff_confirm", `確定: ${data.checkoutDate}`, text);
            }
          }
        }
      } catch (notifyErr) {
        console.error("確定通知エラー（無視）:", notifyErr);
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
        return res.status(403).json({ error: "オーナー権限が必要です" });
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
