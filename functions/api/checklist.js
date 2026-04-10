/**
 * チェックリスト API
 * テンプレート管理 + 清掃チェック記録
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function checklistApi(db) {
  const router = Router();

  // ===== テンプレート =====

  // テンプレート一覧
  router.get("/templates", async (req, res) => {
    try {
      const snapshot = await db.collection("checklistTemplates").get();
      const templates = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(templates);
    } catch (e) {
      console.error("テンプレート取得エラー:", e);
      res.status(500).json({ error: "テンプレートの取得に失敗しました" });
    }
  });

  // テンプレート作成/更新（オーナーのみ）
  router.post("/templates", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const { body } = req;
      if (!body.propertyId || !body.items || !Array.isArray(body.items)) {
        return res.status(400).json({ error: "物件IDとチェック項目は必須です" });
      }

      const data = {
        propertyId: body.propertyId,
        items: body.items.map((item) => ({
          name: String(item.name || ""),
          required: item.required !== false,
          photoRequired: item.photoRequired === true,
        })),
        updatedAt: FieldValue.serverTimestamp(),
      };

      let docRef;
      if (body.id) {
        docRef = db.collection("checklistTemplates").doc(body.id);
        await docRef.update(data);
      } else {
        docRef = await db.collection("checklistTemplates").add(data);
      }

      res.status(201).json({ id: docRef.id || body.id, ...data });
    } catch (e) {
      console.error("テンプレート保存エラー:", e);
      res.status(500).json({ error: "テンプレートの保存に失敗しました" });
    }
  });

  // ===== チェックリスト記録 =====

  // 記録取得（シフトID or スタッフID）
  router.get("/records", async (req, res) => {
    try {
      const { shiftId, staffId } = req.query;
      let query = db.collection("checklists");

      if (shiftId) {
        query = query.where("shiftId", "==", shiftId);
      } else if (staffId) {
        query = query.where("staffId", "==", staffId);
      }

      const snapshot = await query.get();
      const records = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(records);
    } catch (e) {
      console.error("チェックリスト記録取得エラー:", e);
      res.status(500).json({ error: "記録の取得に失敗しました" });
    }
  });

  // チェックリスト開始（テンプレートからコピー）
  router.post("/records", async (req, res) => {
    try {
      const { shiftId, propertyId } = req.body;
      if (!shiftId || !propertyId) {
        return res.status(400).json({ error: "シフトIDと物件IDは必須です" });
      }

      // テンプレート取得
      const templateSnap = await db.collection("checklistTemplates")
        .where("propertyId", "==", propertyId)
        .limit(1)
        .get();

      let items = [];
      if (!templateSnap.empty) {
        items = templateSnap.docs[0].data().items.map((item) => ({
          ...item,
          checked: false,
          note: "",
          photoUrl: null,
        }));
      }

      const data = {
        shiftId,
        propertyId,
        staffId: req.user.uid,
        items,
        status: "in_progress",
        completedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      };

      const docRef = await db.collection("checklists").add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("チェックリスト開始エラー:", e);
      res.status(500).json({ error: "チェックリストの開始に失敗しました" });
    }
  });

  // チェックリスト更新（項目チェック、写真URL追加等）
  router.put("/records/:id", async (req, res) => {
    try {
      const docRef = db.collection("checklists").doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "記録が見つかりません" });
      }

      const existing = doc.data();
      if (req.user.role === "staff" && existing.staffId !== req.user.uid) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      const { body } = req;
      const data = {};
      if (body.items !== undefined) data.items = body.items;
      if (body.status !== undefined) {
        data.status = body.status;
        if (body.status === "completed") {
          data.completedAt = FieldValue.serverTimestamp();
        }
      }
      data.updatedAt = FieldValue.serverTimestamp();

      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("チェックリスト更新エラー:", e);
      res.status(500).json({ error: "チェックリストの更新に失敗しました" });
    }
  });

  return router;
};
