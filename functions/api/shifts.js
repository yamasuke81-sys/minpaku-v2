/**
 * シフト管理 API
 * 清掃スケジュールの管理・自動割当
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function shiftsApi(db) {
  const router = Router();
  const collection = db.collection("shifts");

  // シフト一覧（日付範囲指定）
  router.get("/", async (req, res) => {
    try {
      const { from, to, staffId, propertyId } = req.query;
      let query = collection.orderBy("date", "asc");

      if (from) {
        query = query.where("date", ">=", new Date(from));
      }
      if (to) {
        query = query.where("date", "<=", new Date(to));
      }

      const snapshot = await query.get();
      let shifts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // Firestoreの複合クエリ制限があるためクライアントフィルタ
      if (staffId) {
        shifts = shifts.filter((s) => s.staffId === staffId);
      }
      if (propertyId) {
        shifts = shifts.filter((s) => s.propertyId === propertyId);
      }

      res.json(shifts);
    } catch (e) {
      console.error("シフト一覧取得エラー:", e);
      res.status(500).json({ error: "シフト一覧の取得に失敗しました" });
    }
  });

  // シフト登録
  router.post("/", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const { body } = req;
      if (!body.date || !body.propertyId) {
        return res.status(400).json({ error: "日付と物件IDは必須です" });
      }

      const data = {
        date: new Date(body.date),
        propertyId: String(body.propertyId),
        bookingId: body.bookingId || "",
        staffId: body.staffId || null,
        staffName: body.staffName || null,
        startTime: body.startTime || null,
        endTime: body.endTime || null,
        status: body.staffId ? "assigned" : "unassigned",
        assignMethod: body.assignMethod || "manual",
        checklistId: null,
        createdAt: FieldValue.serverTimestamp(),
      };

      const docRef = await collection.add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("シフト登録エラー:", e);
      res.status(500).json({ error: "シフトの登録に失敗しました" });
    }
  });

  // シフト更新（スタッフ割当、ステータス変更等）
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "シフトが見つかりません" });
      }

      const { body } = req;
      const data = {};
      if (body.date !== undefined) data.date = new Date(body.date);
      if (body.propertyId !== undefined) data.propertyId = body.propertyId;
      if (body.staffId !== undefined) {
        data.staffId = body.staffId;
        data.staffName = body.staffName || null;
        data.status = body.staffId ? "assigned" : "unassigned";
      }
      if (body.startTime !== undefined) data.startTime = body.startTime;
      if (body.endTime !== undefined) data.endTime = body.endTime;
      if (body.status !== undefined) data.status = body.status;
      if (body.assignMethod !== undefined) data.assignMethod = body.assignMethod;
      data.updatedAt = FieldValue.serverTimestamp();

      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("シフト更新エラー:", e);
      res.status(500).json({ error: "シフトの更新に失敗しました" });
    }
  });

  // シフト削除
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      await collection.doc(req.params.id).delete();
      res.json({ message: "シフトを削除しました" });
    } catch (e) {
      console.error("シフト削除エラー:", e);
      res.status(500).json({ error: "シフトの削除に失敗しました" });
    }
  });

  return router;
};
