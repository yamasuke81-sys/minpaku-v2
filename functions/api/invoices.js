/**
 * 請求書 API
 * シフト実績 + ランドリー → 自動集計 → スタッフ確認 → PDF生成
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function invoicesApi(db) {
  const router = Router();
  const collection = db.collection("invoices");

  // 請求書一覧
  router.get("/", async (req, res) => {
    try {
      const { yearMonth, staffId } = req.query;
      let query = collection.orderBy("yearMonth", "desc");

      const snapshot = await query.get();
      let invoices = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      if (yearMonth) {
        invoices = invoices.filter((inv) => inv.yearMonth === yearMonth);
      }
      if (staffId) {
        invoices = invoices.filter((inv) => inv.staffId === staffId);
      }

      // スタッフは自分の請求書のみ
      if (req.user.role === "staff") {
        invoices = invoices.filter((inv) => inv.staffId === req.user.uid);
      }

      res.json(invoices);
    } catch (e) {
      console.error("請求書一覧取得エラー:", e);
      res.status(500).json({ error: "請求書一覧の取得に失敗しました" });
    }
  });

  // 請求書詳細
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }

      const data = { id: doc.id, ...doc.data() };

      // スタッフは自分の請求書のみ
      if (req.user.role === "staff" && data.staffId !== req.user.uid) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      res.json(data);
    } catch (e) {
      console.error("請求書取得エラー:", e);
      res.status(500).json({ error: "請求書の取得に失敗しました" });
    }
  });

  // 請求書生成（月次集計）— オーナーが手動実行 or 定期ジョブ
  router.post("/generate", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const { yearMonth } = req.body;
      if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ error: "yearMonth（YYYY-MM形式）は必須です" });
      }

      const [year, month] = yearMonth.split("-").map(Number);
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);

      // アクティブスタッフ取得
      const staffSnap = await db.collection("staff").where("active", "==", true).get();
      const staffList = staffSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // 対象月のシフト取得（completed のみ）
      const shiftsSnap = await db.collection("shifts")
        .where("date", ">=", startDate)
        .where("date", "<=", endDate)
        .where("status", "==", "completed")
        .get();
      const shifts = shiftsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // 対象月のランドリー記録取得
      const laundrySnap = await db.collection("laundry")
        .where("date", ">=", startDate)
        .where("date", "<=", endDate)
        .get();
      const laundryRecords = laundrySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      const generated = [];

      for (const staff of staffList) {
        const staffShifts = shifts.filter((s) => s.staffId === staff.id);
        const staffLaundry = laundryRecords.filter((l) => l.staffId === staff.id);

        if (staffShifts.length === 0 && staffLaundry.length === 0) continue;

        const basePayment = staffShifts.length * (staff.ratePerJob || 0);
        const laundryFee = staffLaundry.reduce((sum, l) => sum + (l.amount || 0), 0);
        const transportationFee = staffShifts.length * (staff.transportationFee || 0);
        const total = basePayment + laundryFee + transportationFee;

        const invoiceId = `INV-${yearMonth.replace("-", "")}-${staff.id.substring(0, 6)}`;

        const invoiceData = {
          yearMonth,
          staffId: staff.id,
          staffName: staff.name,
          basePayment,
          laundryFee,
          transportationFee,
          specialAllowance: 0,
          total,
          status: "draft",
          pdfUrl: null,
          confirmedAt: null,
          details: {
            shifts: staffShifts.map((s) => ({
              date: s.date,
              propertyId: s.propertyId,
              amount: staff.ratePerJob || 0,
            })),
            laundry: staffLaundry.map((l) => ({
              date: l.date,
              amount: l.amount || 0,
            })),
          },
          createdAt: FieldValue.serverTimestamp(),
        };

        await collection.doc(invoiceId).set(invoiceData);
        generated.push({ id: invoiceId, ...invoiceData });
      }

      res.status(201).json({
        message: `${generated.length}件の請求書を生成しました`,
        invoices: generated,
      });
    } catch (e) {
      console.error("請求書生成エラー:", e);
      res.status(500).json({ error: "請求書の生成に失敗しました" });
    }
  });

  // 手動明細項目を追加（オーナーのみ）
  router.post("/:id/items", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const { label, amount, memo } = req.body;
      if (!label || amount === undefined) {
        return res.status(400).json({ error: "label と amount は必須です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      const data = doc.data();
      const manualItems = data.details?.manualItems || [];
      manualItems.push({ label: String(label), amount: Number(amount), memo: memo || "" });

      // total再計算
      const manualTotal = manualItems.reduce((s, item) => s + (item.amount || 0), 0);
      const newTotal = (data.basePayment || 0) + (data.laundryFee || 0) + (data.transportationFee || 0) + (data.specialAllowance || 0) + manualTotal;

      await docRef.update({
        "details.manualItems": manualItems,
        total: newTotal,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.status(201).json({ message: "項目を追加しました", manualItems, total: newTotal });
    } catch (e) {
      console.error("手動項目追加エラー:", e);
      res.status(500).json({ error: "手動項目の追加に失敗しました" });
    }
  });

  // 手動明細項目を削除（オーナーのみ）
  router.delete("/:id/items/:index", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const index = parseInt(req.params.index, 10);
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      const data = doc.data();
      const manualItems = data.details?.manualItems || [];
      if (index < 0 || index >= manualItems.length) {
        return res.status(400).json({ error: "無効なインデックスです" });
      }
      manualItems.splice(index, 1);

      // total再計算
      const manualTotal = manualItems.reduce((s, item) => s + (item.amount || 0), 0);
      const newTotal = (data.basePayment || 0) + (data.laundryFee || 0) + (data.transportationFee || 0) + (data.specialAllowance || 0) + manualTotal;

      await docRef.update({
        "details.manualItems": manualItems,
        total: newTotal,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "項目を削除しました", manualItems, total: newTotal });
    } catch (e) {
      console.error("手動項目削除エラー:", e);
      res.status(500).json({ error: "手動項目の削除に失敗しました" });
    }
  });

  // 支払済みマーク（オーナーのみ）
  router.put("/:id/markPaid", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      await docRef.update({
        status: "paid",
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "支払済みにしました" });
    } catch (e) {
      console.error("支払済みマークエラー:", e);
      res.status(500).json({ error: "支払済みマークに失敗しました" });
    }
  });

  // 請求書削除（オーナーのみ・draftのみ）
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      if (doc.data().status !== "draft") {
        return res.status(400).json({ error: "下書き状態の請求書のみ削除できます" });
      }
      await docRef.delete();
      res.json({ message: "請求書を削除しました" });
    } catch (e) {
      console.error("請求書削除エラー:", e);
      res.status(500).json({ error: "請求書の削除に失敗しました" });
    }
  });

  // スタッフが請求書を確認・確定
  router.put("/:id/confirm", async (req, res) => {
    try {
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }

      const data = doc.data();
      if (req.user.role === "staff" && data.staffId !== req.user.uid) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      await docRef.update({
        status: "confirmed",
        confirmedAt: FieldValue.serverTimestamp(),
      });

      res.json({ message: "請求書を確定しました" });
    } catch (e) {
      console.error("請求書確定エラー:", e);
      res.status(500).json({ error: "請求書の確定に失敗しました" });
    }
  });

  return router;
};
