/**
 * 物件管理 API
 * BEDS24の物件IDと紐付け可能な構造
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function propertiesApi(db) {
  const router = Router();
  const collection = db.collection("properties");

  // 物件一覧
  router.get("/", async (req, res) => {
    try {
      const activeOnly = req.query.active !== "false";
      let query = collection.orderBy("name", "asc");
      if (activeOnly) {
        query = query.where("active", "==", true);
      }
      const snapshot = await query.get();
      const properties = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(properties);
    } catch (e) {
      console.error("物件一覧取得エラー:", e);
      res.status(500).json({ error: "物件一覧の取得に失敗しました" });
    }
  });

  // 物件詳細
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "物件が見つかりません" });
      }
      res.json({ id: doc.id, ...doc.data() });
    } catch (e) {
      console.error("物件取得エラー:", e);
      res.status(500).json({ error: "物件の取得に失敗しました" });
    }
  });

  // 物件登録
  router.post("/", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const { body } = req;
      if (!body.name) {
        return res.status(400).json({ error: "物件名は必須です" });
      }

      const data = {
        name: String(body.name).trim(),
        type: ["minpaku", "rental", "other"].includes(body.type) ? body.type : "minpaku",
        beds24PropertyId: body.beds24PropertyId ? String(body.beds24PropertyId).trim() : "",
        address: body.address ? String(body.address).trim() : "",
        area: body.area ? String(body.area).trim() : "",
        capacity: Number(body.capacity) || 0,
        cleaningDuration: Number(body.cleaningDuration) || 90,
        cleaningFee: Number(body.cleaningFee) || 0,
        requiredSkills: Array.isArray(body.requiredSkills) ? body.requiredSkills : [],
        checklistTemplateId: body.checklistTemplateId || "",
        monthlyFixedCost: Number(body.monthlyFixedCost) || 0,
        purchasePrice: Number(body.purchasePrice) || 0,
        purchaseDate: body.purchaseDate || null,
        notes: body.notes ? String(body.notes).trim() : "",
        active: body.active !== false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      const docRef = await collection.add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("物件登録エラー:", e);
      res.status(500).json({ error: "物件の登録に失敗しました" });
    }
  });

  // 物件更新
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "物件が見つかりません" });
      }

      const { body } = req;
      const data = {};
      if (body.name !== undefined) data.name = String(body.name).trim();
      if (body.type !== undefined && ["minpaku", "rental", "other"].includes(body.type)) data.type = body.type;
      if (body.beds24PropertyId !== undefined) data.beds24PropertyId = String(body.beds24PropertyId).trim();
      if (body.address !== undefined) data.address = String(body.address).trim();
      if (body.area !== undefined) data.area = String(body.area).trim();
      if (body.capacity !== undefined) data.capacity = Number(body.capacity) || 0;
      if (body.cleaningDuration !== undefined) data.cleaningDuration = Number(body.cleaningDuration) || 90;
      if (body.cleaningFee !== undefined) data.cleaningFee = Number(body.cleaningFee) || 0;
      if (body.requiredSkills !== undefined) data.requiredSkills = Array.isArray(body.requiredSkills) ? body.requiredSkills : [];
      if (body.monthlyFixedCost !== undefined) data.monthlyFixedCost = Number(body.monthlyFixedCost) || 0;
      if (body.purchasePrice !== undefined) data.purchasePrice = Number(body.purchasePrice) || 0;
      if (body.purchaseDate !== undefined) data.purchaseDate = body.purchaseDate;
      if (body.checklistTemplateId !== undefined) data.checklistTemplateId = body.checklistTemplateId;
      if (body.notes !== undefined) data.notes = String(body.notes).trim();
      if (body.active !== undefined) data.active = Boolean(body.active);
      data.updatedAt = FieldValue.serverTimestamp();

      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("物件更新エラー:", e);
      res.status(500).json({ error: "物件の更新に失敗しました" });
    }
  });

  // 物件削除（論理削除）
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "物件が見つかりません" });
      }

      await docRef.update({
        active: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "物件を無効化しました" });
    } catch (e) {
      console.error("物件削除エラー:", e);
      res.status(500).json({ error: "物件の削除に失敗しました" });
    }
  });

  return router;
};
