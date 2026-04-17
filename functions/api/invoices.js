/**
 * 請求書 API
 * シフト実績 + ランドリー → 自動集計 → スタッフ確認 → PDF生成
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { notifyOwner, getNotificationSettings_ } = require("../utils/lineNotify");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const os = require("os");

// CJKフォントのパス候補（Cloud Functions 環境）
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJKjp-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
];

function findCjkFont() {
  for (const p of CJK_FONT_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 金額を日本円フォーマット（例: 12,000） */
function fmtYen(n) {
  return Number(n || 0).toLocaleString("ja-JP");
}

/** Timestamp or Date → "YYYY/MM/DD" */
function fmtDate(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : new Date(val);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

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

  // 請求書PDF生成
  router.get("/:id/pdf", async (req, res) => {
    try {
      // アクセス制御
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      const invoice = { id: doc.id, ...doc.data() };
      if (req.user.role === "staff" && invoice.staffId !== req.user.uid) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      // スタッフの銀行情報取得
      const staffDoc = await db.collection("staff").doc(invoice.staffId).get();
      const staff = staffDoc.exists ? staffDoc.data() : {};

      // 物件名マップを作成（シフト明細で使用）
      const propertyIds = [...new Set(
        (invoice.details?.shifts || []).map((s) => s.propertyId).filter(Boolean)
      )];
      const propertyMap = {};
      if (propertyIds.length > 0) {
        await Promise.all(
          propertyIds.map(async (pid) => {
            const pdoc = await db.collection("properties").doc(pid).get();
            propertyMap[pid] = pdoc.exists ? pdoc.data().name : pid;
          })
        );
      }

      // PDF生成
      const cjkFont = findCjkFont();
      const tmpPath = path.join(os.tmpdir(), `${invoice.id}.pdf`);

      await new Promise((resolve, reject) => {
        const pdfOpts = { margin: 50, size: "A4" };
        if (cjkFont) pdfOpts.font = cjkFont;
        const doc = new PDFDocument(pdfOpts);
        const stream = fs.createWriteStream(tmpPath);
        doc.pipe(stream);

        const setFont = (size = 12) => {
          if (cjkFont) {
            doc.font(cjkFont).fontSize(size);
          } else {
            doc.font("Helvetica").fontSize(size);
          }
        };

        const today = new Date();
        const issuedDate = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;

        // ── ヘッダー ──
        setFont(22);
        doc.text(cjkFont ? "請求書" : "Invoice", { align: "center" });
        doc.moveDown(0.5);

        setFont(10);
        doc.text(`${cjkFont ? "発行日" : "Issued"}: ${issuedDate}`, { align: "right" });
        doc.text(`${cjkFont ? "請求書番号" : "Invoice No"}: ${invoice.id}`, { align: "right" });
        doc.moveDown(1);

        // ── スタッフ情報 ──
        setFont(11);
        doc.text(cjkFont ? "【スタッフ情報】" : "--- Staff ---");
        setFont(10);
        doc.text(`${cjkFont ? "氏名" : "Name"}: ${invoice.staffName || staff.name || "-"}`);
        doc.moveDown(0.8);

        // ── 対象期間 ──
        setFont(11);
        doc.text(cjkFont ? "【対象期間】" : "--- Period ---");
        setFont(10);
        doc.text(`${cjkFont ? "対象月" : "Period"}: ${invoice.yearMonth}`);
        doc.moveDown(0.8);

        // ── 清掃明細 ──
        const shifts = invoice.details?.shifts || [];
        if (shifts.length > 0) {
          setFont(11);
          doc.text(cjkFont ? "【清掃明細】" : "--- Cleaning ---");
          setFont(10);
          shifts.forEach((s, i) => {
            const propName = propertyMap[s.propertyId] || s.propertyId || "-";
            const dateStr = s.date ? fmtDate(s.date) : "-";
            doc.text(`  ${i + 1}. ${dateStr}  ${propName}  ${fmtYen(s.amount)}${cjkFont ? "円" : "JPY"}`);
          });
          doc.moveDown(0.8);
        }

        // ── ランドリー明細 ──
        const laundry = invoice.details?.laundry || [];
        if (laundry.length > 0) {
          setFont(11);
          doc.text(cjkFont ? "【ランドリー明細】" : "--- Laundry ---");
          setFont(10);
          laundry.forEach((l, i) => {
            const dateStr = l.date ? fmtDate(l.date) : "-";
            doc.text(`  ${i + 1}. ${dateStr}  ${fmtYen(l.amount)}${cjkFont ? "円" : "JPY"}`);
          });
          doc.moveDown(0.8);
        }

        // ── 手動追加項目 ──
        const manualItems = invoice.details?.manualItems || [];
        if (manualItems.length > 0) {
          setFont(11);
          doc.text(cjkFont ? "【追加項目】" : "--- Additional ---");
          setFont(10);
          manualItems.forEach((item, i) => {
            doc.text(`  ${i + 1}. ${item.label}  ${fmtYen(item.amount)}${cjkFont ? "円" : "JPY"}${item.memo ? "  (" + item.memo + ")" : ""}`);
          });
          doc.moveDown(0.8);
        }

        // ── 集計 ──
        setFont(11);
        doc.text(cjkFont ? "【集計】" : "--- Summary ---");
        setFont(10);
        const manualTotal = manualItems.reduce((s, item) => s + (item.amount || 0), 0);
        doc.text(`  ${cjkFont ? "基本報酬（清掃回数×単価）" : "Base Pay"}: ${fmtYen(invoice.basePayment)}${cjkFont ? "円" : "JPY"}`);
        doc.text(`  ${cjkFont ? "ランドリー費" : "Laundry"}: ${fmtYen(invoice.laundryFee)}${cjkFont ? "円" : "JPY"}`);
        doc.text(`  ${cjkFont ? "交通費" : "Transportation"}: ${fmtYen(invoice.transportationFee)}${cjkFont ? "円" : "JPY"}`);
        if (invoice.specialAllowance) {
          doc.text(`  ${cjkFont ? "特別手当" : "Special Allowance"}: ${fmtYen(invoice.specialAllowance)}${cjkFont ? "円" : "JPY"}`);
        }
        if (manualItems.length > 0) {
          doc.text(`  ${cjkFont ? "追加項目合計" : "Additional Total"}: ${fmtYen(manualTotal)}${cjkFont ? "円" : "JPY"}`);
        }
        doc.moveDown(0.3);
        doc.lineCap("butt").moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.3);
        setFont(13);
        doc.text(`  ${cjkFont ? "合計金額" : "Total"}: ${fmtYen(invoice.total)}${cjkFont ? "円" : "JPY"}`);
        doc.moveDown(1.2);

        // ── 振込先 ──
        const hasBankInfo = staff.bankName || staff.accountNumber;
        if (hasBankInfo) {
          setFont(11);
          doc.text(cjkFont ? "【振込先】" : "--- Bank Info ---");
          setFont(10);
          if (staff.bankName) doc.text(`  ${cjkFont ? "銀行名" : "Bank"}: ${staff.bankName}`);
          if (staff.branchName) doc.text(`  ${cjkFont ? "支店名" : "Branch"}: ${staff.branchName}`);
          if (staff.accountType) doc.text(`  ${cjkFont ? "口座種別" : "Type"}: ${staff.accountType}`);
          if (staff.accountNumber) doc.text(`  ${cjkFont ? "口座番号" : "Account"}: ${staff.accountNumber}`);
          if (staff.accountHolder) doc.text(`  ${cjkFont ? "口座名義" : "Holder"}: ${staff.accountHolder}`);
        }

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);
      });

      // Cloud Storage にアップロード
      const bucket = getStorage().bucket("minpaku-v2.firebasestorage.app");
      const destPath = `invoices/${invoice.id}.pdf`;
      await bucket.upload(tmpPath, {
        destination: destPath,
        metadata: { contentType: "application/pdf" },
      });

      // 署名付きダウンロードURL（7日間有効）
      const [pdfUrl] = await bucket.file(destPath).getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      // Firestore の pdfUrl を更新
      await docRef.update({
        pdfUrl,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // 一時ファイル削除
      fs.unlinkSync(tmpPath);

      res.json({ pdfUrl });
    } catch (e) {
      console.error("PDF生成エラー:", e);
      res.status(500).json({ error: "PDFの生成に失敗しました" });
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

      // オーナー通知
      try {
        const [y, m] = String(data.yearMonth || "").split("-");
        const total = Number(data.total || 0);
        // appUrl を settings から取得 (ハードコード回避)
        let appUrl = "https://minpaku-v2.web.app";
        try {
          const { settings } = await getNotificationSettings_(db);
          appUrl = settings?.appUrl || appUrl;
        } catch (_) { /* デフォルト */ }
        const invoiceUrl = `${appUrl.replace(/\/$/, "")}/#/invoices`;
        const body = `📨 請求書が提出されました\n\n` +
          `${data.staffName || "スタッフ"} さんから ${m || data.yearMonth}月分の請求書が届きました。\n` +
          `合計: ¥${total.toLocaleString()}\n` +
          `確認: ${invoiceUrl}`;
        await notifyOwner(db, "invoice_submitted",
          `請求書提出: ${data.staffName || ""} (${data.yearMonth})`,
          body,
          {
            month: m || data.yearMonth,
            staff: data.staffName || "",
            property: "",
            total: `¥${total.toLocaleString()}`,
            url: invoiceUrl,
          });
      } catch (notifyErr) {
        console.error("請求書提出通知エラー（無視）:", notifyErr);
      }

      res.json({ message: "請求書を確定しました" });
    } catch (e) {
      console.error("請求書確定エラー:", e);
      res.status(500).json({ error: "請求書の確定に失敗しました" });
    }
  });

  return router;
};
