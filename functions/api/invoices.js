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

/**
 * 請求書PDFを生成して Firebase Storage に保存、署名付きURL(7日間)を返す
 * (ルート /:id/pdf の実装を関数化したもの。my-submit からも呼ぶ)
 */
async function generateInvoicePdf_(db, invoiceId) {
  const doc = await db.collection("invoices").doc(invoiceId).get();
  if (!doc.exists) throw new Error("請求書が見つかりません");
  const invoice = { id: doc.id, ...doc.data() };

  const staffDoc = await db.collection("staff").doc(invoice.staffId).get();
  const staff = staffDoc.exists ? staffDoc.data() : {};

  // 宛先(請求先)情報: settings/clientInfo に保存されたメインオーナーの会社情報
  let client = {};
  try {
    const cDoc = await db.collection("settings").doc("clientInfo").get();
    if (cDoc.exists) client = cDoc.data();
  } catch (_) {}
  // デフォルト宛先 (合同会社八朔)
  if (!client.companyName) {
    client = {
      zipCode: "736-0061",
      address: "広島県安芸郡海田町上市4-23-12",
      companyName: "合同会社八朔",
      ...client,
    };
  }

  const propertyIds = [...new Set((invoice.details?.shifts || []).map((s) => s.propertyId).filter(Boolean))];
  const propertyMap = {};
  if (propertyIds.length > 0) {
    await Promise.all(propertyIds.map(async (pid) => {
      const pdoc = await db.collection("properties").doc(pid).get();
      propertyMap[pid] = pdoc.exists ? pdoc.data().name : pid;
    }));
  }

  const cjkFont = findCjkFont();
  const tmpPath = path.join(os.tmpdir(), `${invoice.id}.pdf`);

  await new Promise((resolve, reject) => {
    const pdfOpts = { margin: 40, size: "A4" };
    if (cjkFont) pdfOpts.font = cjkFont;
    const pdfDoc = new PDFDocument(pdfOpts);
    const stream = fs.createWriteStream(tmpPath);
    pdfDoc.pipe(stream);
    const setFont = (size = 10) => { if (cjkFont) pdfDoc.font(cjkFont).fontSize(size); else pdfDoc.font("Helvetica").fontSize(size); };

    const today = new Date();
    const issuedDate = `${today.getFullYear()}年${String(today.getMonth() + 1).padStart(2, "0")}月${String(today.getDate()).padStart(2, "0")}日`;
    const [yy, mm] = (invoice.yearMonth || "").split("-").map(Number);
    const firstDay = new Date(yy, mm - 1, 1);
    const lastDay = new Date(yy, mm, 0);
    const fmt = (d) => `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
    const periodLabel = `${yy}年${mm}月分`;
    const periodRange = `${fmt(firstDay)}〜${fmt(lastDay)}`;
    // 支払期限: 翌月5日
    const paymentDue = new Date(yy, mm, 5);

    const leftX = 40;
    const rightX = 340;
    const pageWidth = 515;

    // ── 上部: 宛先(左) + 請求元(右) ──
    let topY = pdfDoc.y;
    setFont(10);
    pdfDoc.text(`〒${client.zipCode || ""}`, leftX, topY);
    pdfDoc.text(client.address || "", leftX, topY + 14);
    setFont(12);
    pdfDoc.text(`${client.companyName || ""}  御中`, leftX, topY + 28, { underline: true });

    setFont(9);
    pdfDoc.text(staff.address || staff.memo || "", rightX, topY, { width: 210, align: "right" });
    pdfDoc.text(invoice.staffName || staff.name || "", rightX, topY + 14, { width: 210, align: "right" });

    // ── タイトル ──
    pdfDoc.moveDown(3);
    setFont(22);
    pdfDoc.text("請求書", leftX, pdfDoc.y, { width: pageWidth, align: "center" });
    pdfDoc.moveDown(0.5);

    setFont(10);
    pdfDoc.text(`請求日：${issuedDate}`, leftX, pdfDoc.y, { width: pageWidth, align: "right" });
    pdfDoc.moveDown(1);

    // ── 挨拶 ──
    setFont(10);
    pdfDoc.text("下記の通り、御請求申し上げます。", leftX, pdfDoc.y);
    pdfDoc.moveDown(0.8);

    // ── 請求対象年月 ──
    pdfDoc.text(`請求対象年月：${periodLabel}（${periodRange}）`, leftX, pdfDoc.y);
    pdfDoc.moveDown(0.8);

    // ── 合計金額 ──
    setFont(14);
    pdfDoc.text(`合計金額：  ¥${fmtYen(invoice.total)}（税込）`, leftX, pdfDoc.y, { underline: true });
    pdfDoc.moveDown(1);

    // ── 明細テーブル ──
    // 行を構築: 清掃明細 + ランドリー明細 + 追加項目
    const rows = [];
    const shifts = invoice.details?.shifts || [];
    shifts.forEach((s) => {
      const propName = propertyMap[s.propertyId] || s.propertyId || "";
      const memo = s.memo || "";
      rows.push({
        date: s.date ? fmtDate(s.date) : "",
        label: `清掃 ${propName}`,
        amount: s.amount || 0,
        memo,
      });
    });
    const laundry = invoice.details?.laundry || [];
    laundry.forEach((l) => {
      rows.push({
        date: l.date ? fmtDate(l.date) : "",
        label: l.label || "ランドリー",
        amount: l.amount || 0,
        memo: l.memo || l.note || "",
      });
    });
    const manualItems = invoice.manualItems || invoice.details?.manualItems || [];
    manualItems.forEach((item) => {
      rows.push({
        date: item.date ? fmtDate(item.date) : "",
        label: item.label || "",
        amount: item.amount || 0,
        memo: item.memo || "",
      });
    });

    // テーブル描画
    setFont(10);
    const col = { date: leftX, label: leftX + 90, amount: leftX + 400 };
    const colW = { date: 85, label: 300, amount: 110 };
    const tableStartY = pdfDoc.y;
    // ヘッダー
    pdfDoc.rect(leftX, tableStartY, pageWidth, 22).fillAndStroke("#f0f0f0", "#aaaaaa");
    pdfDoc.fillColor("#000");
    pdfDoc.text("日付", col.date + 4, tableStartY + 6, { width: colW.date - 4 });
    pdfDoc.text("作業内容", col.label + 4, tableStartY + 6, { width: colW.label - 4 });
    pdfDoc.text("金額", col.amount + 4, tableStartY + 6, { width: colW.amount - 8, align: "right" });
    let y = tableStartY + 22;
    rows.forEach((r) => {
      const memoH = r.memo ? 12 : 0;
      const rowH = 20 + memoH;
      // ページ末端が近づいたら改ページ
      if (y + rowH > 780) {
        pdfDoc.addPage();
        y = 40;
      }
      pdfDoc.rect(leftX, y, pageWidth, rowH).stroke("#cccccc");
      pdfDoc.fillColor("#000");
      setFont(10);
      pdfDoc.text(r.date, col.date + 4, y + 5, { width: colW.date - 4 });
      pdfDoc.text(r.label, col.label + 4, y + 5, { width: colW.label - 4 });
      pdfDoc.text(`¥${fmtYen(r.amount)}`, col.amount + 4, y + 5, { width: colW.amount - 8, align: "right" });
      if (r.memo) {
        setFont(8);
        pdfDoc.fillColor("#666");
        pdfDoc.text(`備考: ${r.memo}`, col.label + 4, y + 19, { width: colW.label + colW.amount - 4 });
        pdfDoc.fillColor("#000");
      }
      y += rowH;
    });
    pdfDoc.y = y + 16;

    // ── 支払期限 ──
    setFont(10);
    pdfDoc.text(`支払期限：   ${fmt(paymentDue)}`, leftX, pdfDoc.y);
    pdfDoc.moveDown(0.5);

    // ── 振込先 ──
    const bankLine = [
      staff.bankName || "-",
      staff.branchName ? `${staff.branchName}支店` : "",
      staff.accountType || "",
      staff.accountNumber || "",
      staff.accountHolder || "",
    ].filter(Boolean).join("  ");
    pdfDoc.text(`振込先：     ${bankLine}`, leftX, pdfDoc.y);
    pdfDoc.moveDown(0.5);

    // ── 備考 ──
    pdfDoc.text("備考：", leftX, pdfDoc.y);
    pdfDoc.text(invoice.remarks || "", leftX, pdfDoc.y + 14, { width: pageWidth });

    pdfDoc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  const bucket = getStorage().bucket("minpaku-v2.firebasestorage.app");
  const destPath = `invoices/${invoice.id}.pdf`;
  await bucket.upload(tmpPath, { destination: destPath, metadata: { contentType: "application/pdf" } });
  const [pdfUrl] = await bucket.file(destPath).getSignedUrl({ action: "read", expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });

  // Google Drive にも保存 (年月フォルダ自動作成) ※Drive API 有効時のみ
  try {
    await uploadInvoiceToDrive_(db, tmpPath, invoice, staff);
  } catch (e) {
    console.warn("Drive アップロード失敗(Firebase Storage は成功):", e.message);
  }

  try { fs.unlinkSync(tmpPath); } catch (_) {}
  return pdfUrl;
}

/**
 * Google Drive に請求書PDFを保存
 * settings/driveInvoice.parentFolderId = 親フォルダID (デフォルトあり)
 * その下に YYYY-MM フォルダを作成 (既存なら流用)
 * ファイル名: {invoiceId}_{staffName}_{yearMonth}.pdf
 *
 * Gmail OAuth と同じ refresh token を使うため、Drive scope が必要。
 * 既存の scope に drive.file が含まれている前提。不足時はスキップ。
 */
async function uploadInvoiceToDrive_(db, filePath, invoice, staff) {
  const admin = require("firebase-admin");
  const dbRef = admin.firestore();

  // 設定から親フォルダID取得 (デフォルト: ユーザー指定フォルダ)
  let parentFolderId = "1ucWQQtv8xYsblcWiSSg1gcpgC9dfa5kh";
  try {
    const s = await dbRef.collection("settings").doc("driveInvoice").get();
    if (s.exists && s.data().parentFolderId) parentFolderId = s.data().parentFolderId;
  } catch (_) {}

  const { google } = require("googleapis");
  const oauthDoc = await dbRef.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) throw new Error("Gmail/Drive OAuth 未設定");
  const { clientId, clientSecret } = oauthDoc.data();
  const tokensSnap = await dbRef.collection("settings").doc("gmailOAuth").collection("tokens").limit(1).get();
  if (tokensSnap.empty) throw new Error("OAuth tokens 未登録");
  const tokenData = tokensSnap.docs[0].data();
  if (!tokenData.refreshToken) throw new Error("refreshToken なし");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
  const drive = google.drive({ version: "v3", auth: oauth2Client });

  // 年月フォルダを検索or作成
  const yearMonth = invoice.yearMonth || "";
  const folderName = yearMonth;  // "YYYY-MM"
  let folderId = null;
  const search = await drive.files.list({
    q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });
  if (search.data.files && search.data.files.length) {
    folderId = search.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      },
      fields: "id",
    });
    folderId = created.data.id;
  }

  const fileName = `${invoice.id}_${invoice.staffName || "unknown"}_${yearMonth}.pdf`;
  await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: "application/pdf", body: fs.createReadStream(filePath) },
    fields: "id",
  });
  console.log(`Drive アップロード成功: ${fileName}`);
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

  // スタッフが自分の請求書を作成 or 更新（月次集計）
  // POST /invoices/my-submit  body: { yearMonth: "YYYY-MM", manualItems?: [...], asStaffId?: string (オーナー専用代理) }
  router.post("/my-submit", async (req, res) => {
    try {
      const { yearMonth, manualItems = [], asStaffId } = req.body || {};
      if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ error: "yearMonth(YYYY-MM)は必須です" });
      }
      const uid = req.user.uid;
      const reqStaffId = req.user.staffId;
      // オーナーが asStaffId を指定した場合: そのスタッフの請求書を代理作成 (テスト用)
      let staffDoc = null;
      if (asStaffId && req.user.role === "owner") {
        const d = await db.collection("staff").doc(asStaffId).get();
        if (d.exists) staffDoc = { id: d.id, ...d.data() };
      } else {
        if (reqStaffId) {
          const d = await db.collection("staff").doc(reqStaffId).get();
          if (d.exists) staffDoc = { id: d.id, ...d.data() };
        }
        if (!staffDoc) {
          const snap = await db.collection("staff").where("authUid", "==", uid).limit(1).get();
          if (!snap.empty) staffDoc = { id: snap.docs[0].id, ...snap.docs[0].data() };
        }
      }
      if (!staffDoc) return res.status(404).json({ error: "スタッフ情報が見つかりません" });

      // 必須フィールドのバリデーション (請求書PDFに必要な情報)
      const missing = [];
      if (!staffDoc.name) missing.push("氏名");
      if (!staffDoc.address && !staffDoc.memo) missing.push("住所");
      if (!staffDoc.email) missing.push("メールアドレス");
      if (!staffDoc.bankName) missing.push("金融機関名");
      if (!staffDoc.branchName) missing.push("支店名");
      if (!staffDoc.accountNumber) missing.push("口座番号");
      if (!staffDoc.accountHolder) missing.push("口座名義");
      if (missing.length) {
        return res.status(400).json({
          error: `請求書作成に必要な情報が不足しています: ${missing.join(", ")}。スタッフ管理画面で登録してください。`,
          missingFields: missing,
        });
      }

      const [y, m] = yearMonth.split("-").map(Number);
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0, 23, 59, 59);

      const shiftsSnap = await db.collection("shifts")
        .where("staffId", "==", staffDoc.id)
        .where("date", ">=", start)
        .where("date", "<=", end)
        .get();
      const shifts = shiftsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const laundrySnap = await db.collection("laundry")
        .where("staffId", "==", staffDoc.id)
        .where("date", ">=", start)
        .where("date", "<=", end)
        .get();
      // 全ランドリー記録を取得 (立替金フラグで分離)
      const laundryAll = laundrySnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // 立替金のみを集計に含める: isReimbursable=true or 旧データは paymentMethod=cash/credit
      const laundry = laundryAll.filter(l => {
        if (l.isReimbursable !== undefined) return l.isReimbursable === true;
        return l.paymentMethod === "cash" || l.paymentMethod === "credit" || !l.paymentMethod;
      });

      const basePayment = shifts.length * (staffDoc.ratePerJob || 0);
      const laundryFee = laundry.reduce((s, l) => s + (l.amount || 0), 0);
      const transportationFee = shifts.length * (staffDoc.transportationFee || 0);
      const manualTotal = (manualItems || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const total = basePayment + laundryFee + transportationFee + manualTotal;

      const invoiceId = `INV-${yearMonth.replace("-", "")}-${staffDoc.id.substring(0, 6)}`;
      const invoiceData = {
        yearMonth,
        staffId: staffDoc.id,
        staffName: staffDoc.name,
        basePayment, laundryFee, transportationFee,
        specialAllowance: manualTotal, total,
        status: "submitted",
        manualItems: (manualItems || []).map(i => ({
          label: String(i.label || ""), amount: Number(i.amount) || 0, memo: String(i.memo || ""),
        })),
        details: {
          shifts: shifts.map(s => ({ date: s.date, propertyId: s.propertyId, amount: staffDoc.ratePerJob || 0 })),
          laundry: laundry.map(l => ({ date: l.date, amount: l.amount || 0 })),
        },
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      // 初回作成時のみ createdAt
      const existing = await collection.doc(invoiceId).get();
      if (!existing.exists) invoiceData.createdAt = FieldValue.serverTimestamp();

      await collection.doc(invoiceId).set(invoiceData, { merge: true });

      // PDF生成 (invoiceId と同じ PDF を生成してStorageに保存、signed URLを取得)
      let pdfSignedUrl = "";
      try {
        pdfSignedUrl = await generateInvoicePdf_(db, invoiceId);
        // invoice に pdfUrl を記録
        await collection.doc(invoiceId).set({ pdfUrl: pdfSignedUrl, pdfGeneratedAt: FieldValue.serverTimestamp() }, { merge: true });
      } catch (e) {
        console.error("PDF生成エラー:", e);
      }

      // invoice_submitted 通知 + スタッフとオーナー両方にメールで PDF リンク送付
      try {
        const { settings } = await getNotificationSettings_(db);
        const appUrl = (settings && settings.appUrl) || "https://minpaku-v2.web.app";
        const confirmUrl = `${appUrl}/#/invoices`;
        const baseVars = {
          month: String(m),
          staff: staffDoc.name || "",
          property: "",
          total: `¥${Number(total).toLocaleString("ja-JP")}`,
          url: confirmUrl,
        };
        const linkLine = pdfSignedUrl ? `\nPDF: ${pdfSignedUrl}` : "";
        const ownerBody = `📨 請求書が提出されました\n\n${staffDoc.name} さんから ${m}月分の請求書が届きました。\n合計: ¥${Number(total).toLocaleString("ja-JP")}${linkLine}\n確認: ${confirmUrl}`;
        await notifyOwner(db, "invoice_submitted", `請求書提出: ${staffDoc.name} ${yearMonth}`, ownerBody, baseVars);

        // スタッフ本人にも PDF リンクをメール送付
        if (staffDoc.email && pdfSignedUrl) {
          try {
            const { sendNotificationEmail_ } = require("../utils/lineNotify");
            const staffBody = `${staffDoc.name} 様\n\n${yearMonth} 分の請求書が作成されました。\n合計: ¥${Number(total).toLocaleString("ja-JP")}\n\nPDFダウンロード (7日間有効):\n${pdfSignedUrl}\n\n何か相違がございましたらご連絡ください。`;
            await sendNotificationEmail_(staffDoc.email, `【請求書】${yearMonth} 分`, staffBody);
          } catch (mailErr) { console.error("スタッフへの請求書メール失敗:", mailErr.message); }
        }
      } catch (notifyErr) {
        console.error("invoice_submitted 通知エラー:", notifyErr);
      }

      res.status(201).json({ id: invoiceId, pdfUrl: pdfSignedUrl, ...invoiceData });
    } catch (e) {
      console.error("my-submit エラー:", e);
      res.status(500).json({ error: "請求書の提出に失敗しました: " + e.message });
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
