/**
 * コインランドリー記録 API
 * スタッフが入力、請求書に自動連携
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function laundryApi(db) {
  const router = Router();
  const collection = db.collection("laundry");

  // 記録一覧（月指定 or スタッフ指定）
  router.get("/", async (req, res) => {
    try {
      const { yearMonth, staffId } = req.query;
      let query = collection.orderBy("date", "desc");

      if (staffId) {
        query = collection.where("staffId", "==", staffId).orderBy("date", "desc");
      }

      const snapshot = await query.get();
      let records = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // 月フィルタ（クライアント側）
      if (yearMonth) {
        records = records.filter((r) => {
          const d = r.date.toDate ? r.date.toDate() : new Date(r.date);
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          return ym === yearMonth;
        });
      }

      res.json(records);
    } catch (e) {
      console.error("ランドリー一覧取得エラー:", e);
      res.status(500).json({ error: "記録の取得に失敗しました" });
    }
  });

  // 記録追加（スタッフ自身が入力可能）
  router.post("/", async (req, res) => {
    try {
      const { body } = req;
      if (!body.date || !body.amount) {
        return res.status(400).json({ error: "日付と金額は必須です" });
      }

      const data = {
        date: new Date(body.date),
        staffId: req.user.uid,
        propertyId: body.propertyId || "",
        amount: Number(body.amount) || 0,
        sheets: Number(body.sheets) || 0,
        memo: body.memo ? String(body.memo).trim() : "",
        // 立替フラグ: true の場合のみ請求書に計上される (デフォルト false)
        isReimbursable: body.isReimbursable === true || body.isReimbursable === "true" ? true : false,
        createdAt: FieldValue.serverTimestamp(),
      };

      const docRef = await collection.add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("ランドリー記録追加エラー:", e);
      res.status(500).json({ error: "記録の追加に失敗しました" });
    }
  });

  // 記録削除（Webアプリ管理者のみ）
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      await collection.doc(req.params.id).delete();
      res.json({ message: "記録を削除しました" });
    } catch (e) {
      console.error("ランドリー記録削除エラー:", e);
      res.status(500).json({ error: "記録の削除に失敗しました" });
    }
  });

  return router;
};
