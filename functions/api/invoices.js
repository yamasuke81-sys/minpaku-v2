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
