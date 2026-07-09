/**
 * 月次帳票 API — 月次業務報告書 / 精算書兼請求書 の自動生成
 *
 * データ源: propertyMonthlyPnL/{propertyId}_{yearMonth}(OTA CSV取込済) + 物件マスタ。
 * - 月次業務報告書(八朔→委託者): 当月の稼働・費用サマリ。全物件が対象。
 * - 精算書兼請求書(八朔→委託者): 運営代行手数料の請求。settlementMode="daiko" の物件のみ。
 *   月間売上高 = 入金額A − 宿泊税預りB / 手数料 = 売上高 × 料率 + 消費税。
 *   八朔はインボイス未登録のため登録番号欄は出さない。
 *
 * PDF は pdfkit。invoices.js と同じ CJK フォント方針・Storage署名URL方式。
 * 純粋な描画関数(render 系)はテスト用に module.exports で公開する。
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { google } = require("googleapis");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { computePnl } = require("./pnl-logic");
const { computeSettlement } = require("./ota-csv-logic");

// ---- フォント(invoices.js と同方針) ----
const BUNDLED_CJK_FONT = path.join(__dirname, "../fonts/NotoSansJP-Regular.ttf");
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJKjp-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
];
function findCjkFont() {
  if (fs.existsSync(BUNDLED_CJK_FONT)) return BUNDLED_CJK_FONT;
  for (const p of CJK_FONT_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}
function fmtYen(n) { return "¥" + Number(n || 0).toLocaleString("ja-JP"); }
function daysInMonth(ym) { const [y, m] = ym.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function ymJp(ym) { const [y, m] = ym.split("-"); return `${y}年${Number(m)}月`; }
function fmtDateJp(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}

// ---- 発行者(乙=八朔) / 振込先 の既定値。settings/settlementConfig で上書き可 ----
const DEFAULT_ISSUER = {
  companyName: "合同会社八朔",
  repName: "代表社員　西山　恭介",
  zipCode: "736-0061",
  address: "広島県安芸郡海田町上市4-23-12",
  invoiceRegNo: "", // 八朔はインボイス未登録 → 空(欄を出さない)
};
const DEFAULT_BANK = {
  bankName: "楽天銀行",
  branchName: "第三営業支店",
  accountType: "普通",
  accountNumber: "7044309",
  accountHolder: "ド）ハッサク",
};
// 委託者(甲=個人)の既定。物件 settlementRecipient で上書き可
const DEFAULT_RECIPIENT = {
  name: "西山　恭介",
  honorific: "様",
  zipCode: "736-0061",
  address: "広島県安芸郡海田町上市4-23-12",
};

// ================= PDF 共通描画部品 =================
function newDoc(font) {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  if (font) doc.font(font);
  return doc;
}
// 発行者ブロック(右上)
function drawIssuer(doc, ctx, x) {
  const { issuer } = ctx.config;
  const top = doc.y;
  doc.fontSize(10).fillColor("#000000").text(issuer.companyName, x, top, { width: 240, align: "left" });
  doc.fontSize(8.5);
  if (issuer.repName) doc.text(issuer.repName, x, doc.y, { width: 240 });
  doc.text(`〒${issuer.zipCode}`, x, doc.y, { width: 240 });
  doc.text(issuer.address, x, doc.y, { width: 240 });
  if (issuer.invoiceRegNo) doc.text(`登録番号：${issuer.invoiceRegNo}`, x, doc.y, { width: 240 });
  return doc.y;
}
// 明細テーブル(2列: 項目/金額)
function drawKvTable(doc, rows, opts = {}) {
  const x = opts.x || 50;
  const w = opts.width || 495;
  const labelW = opts.labelW || 340;
  const rowH = opts.rowH || 24;
  rows.forEach((r) => {
    const y = doc.y;
    const emph = r.emph;
    doc.rect(x, y, w, rowH).fillAndStroke(r.bg || (emph ? "#f4f7fb" : "#ffffff"), "#cccccc");
    doc.fillColor("#000000").fontSize(emph ? 11 : 10);
    doc.text(r.label, x + 10, y + (rowH - (emph ? 11 : 10)) / 2 - 1, { width: labelW - 20 });
    doc.text(r.value, x + labelW, y + (rowH - (emph ? 11 : 10)) / 2 - 1, { width: w - labelW - 10, align: "right" });
    doc.y = y + rowH;
  });
}

// ================= 月次業務報告書 =================
function renderReportPdf(ctx, font) {
  const doc = newDoc(font);
  const X = 50, W = 495;
  doc.fontSize(16).text("月次業務報告書", { align: "center" });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#555555")
    .text(`対象施設：${ctx.propertyName}　／　対象期間：${ymJp(ctx.yearMonth)}`, { align: "center" });
  doc.fillColor("#000000").moveDown(1);

  const headTop = doc.y;
  doc.fontSize(11).text(`${ctx.recipient.name}　${ctx.recipient.honorific}`, X, headTop, { width: 260 });
  doc.fontSize(8.5).fillColor("#555555").text("(委託者)", X, doc.y, { width: 260 });
  doc.fillColor("#000000");
  doc.y = headTop;
  drawIssuer(doc, ctx, 320);
  doc.y = Math.max(doc.y, headTop) + 16;

  doc.fontSize(10).text(
    `下記のとおり、${ymJp(ctx.yearMonth)}分の運営業務の実績をご報告いたします。`,
    X, doc.y, { width: W });
  doc.moveDown(0.8);

  doc.fontSize(12).text("■ 稼働概況", X, doc.y); doc.moveDown(0.3);
  drawKvTable(doc, [
    { label: "予約件数（Airbnb / Booking.com）", value: `${ctx.revenue.airbnbReservations} 件 / ${ctx.revenue.bookingReservations} 件` },
    { label: "宿泊日数", value: `${ctx.nights} 泊` },
    { label: "稼働率（宿泊日数 ÷ 当月日数）", value: `${ctx.occupancyRate} %` },
  ]);
  doc.moveDown(0.6);

  doc.fontSize(12).text("■ 売上・費用", X, doc.y); doc.moveDown(0.3);
  const c = ctx.computed;
  const rows = [{ label: "売上（Airbnb 受取）", value: fmtYen(ctx.revenue.airbnbGross) }];
  if (ctx.revenue.bookingGross) {
    rows.push({ label: "売上（Booking.com 料金）", value: fmtYen(ctx.revenue.bookingGross) });
    rows.push({ label: "OTA手数料（Booking.com コミッション）", value: "▲ " + fmtYen(ctx.revenue.bookingCommission) });
  }
  rows.push({ label: "売上合計", value: fmtYen(c.revenueGross), emph: true });
  rows.push({ label: "清掃費", value: "▲ " + fmtYen(c.cleaningTotal) });
  (c.expenses || []).forEach((e) => rows.push({ label: `経費：${e.name}`, value: "▲ " + fmtYen(e.amount) }));
  rows.push({ label: "運営利益（総合収支）", value: fmtYen(c.profit), emph: true });
  drawKvTable(doc, rows);
  doc.moveDown(0.8);

  doc.fontSize(12).text("■ 特記事項", X, doc.y); doc.moveDown(0.3);
  const boxY = doc.y;
  doc.rect(X, boxY, W, 70).stroke("#cccccc");
  doc.fontSize(9.5).fillColor("#333333").text(ctx.note || "（特記事項なし）", X + 10, boxY + 8, { width: W - 20 });
  doc.fillColor("#000000");

  doc.fontSize(8.5).fillColor("#888888")
    .text(`発行日：${fmtDateJp(ctx.generatedAt)}　／　発行：${ctx.config.issuer.companyName}`, X, 760, { width: W, align: "right" });
  return doc;
}

// ================= 精算書兼請求書 =================
function renderSettlementPdf(ctx, font) {
  const doc = newDoc(font);
  const X = 50, W = 495;
  const s = ctx.settlement;

  doc.fontSize(16).text("精算書兼請求書", { align: "center" });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#555555")
    .text(`対象施設：${ctx.propertyName}　／　対象期間：${ymJp(ctx.yearMonth)}`, { align: "center" });
  doc.fillColor("#000000").moveDown(1);

  const headTop = doc.y;
  doc.fontSize(11).text(`${ctx.recipient.name}　${ctx.recipient.honorific}`, X, headTop, { width: 260 });
  doc.fontSize(8.5).fillColor("#555555").text("(委託者)", X, doc.y, { width: 260 });
  doc.fillColor("#000000");
  doc.y = headTop;
  drawIssuer(doc, ctx, 320);
  doc.y = Math.max(doc.y, headTop) + 16;

  const boxY = doc.y;
  doc.rect(X, boxY, W, 40).fillAndStroke("#eef4ff", "#4a7fd0");
  doc.fillColor("#000000").fontSize(12).text("ご請求金額（税込）", X + 14, boxY + 13, { width: 220 });
  doc.fontSize(16).text(fmtYen(s.feeInclTax), X + 240, boxY + 10, { width: W - 254, align: "right" });
  doc.y = boxY + 40;
  doc.moveDown(0.6);

  doc.fontSize(10).text(
    `${ymJp(ctx.yearMonth)}分の運営代行業務について、下記のとおり精算し、ご請求申し上げます。`,
    X, doc.y, { width: W });
  doc.moveDown(0.6);

  const rows = [
    { label: `月間入金額 (A)　Airbnb受取${ctx.revenue.bookingNet ? " + Booking手取り" : ""}`, value: fmtYen(s.depositAmount) },
    { label: "宿泊税預り (B)", value: "▲ " + fmtYen(s.taxWithholding) },
    { label: "月間売上高 (A − B)", value: fmtYen(s.salesBase), emph: true },
    { label: `運営代行手数料（売上高 × ${s.feeRatePct}%）`, value: fmtYen(s.feeExclTax) },
    { label: `消費税（${s.consumptionTaxPct}%）`, value: fmtYen(s.consumptionTax) },
    { label: "ご請求金額（税込）", value: fmtYen(s.feeInclTax), emph: true },
  ];
  drawKvTable(doc, rows);
  doc.moveDown(0.8);

  doc.fontSize(12).text("■ お振込先", X, doc.y); doc.moveDown(0.3);
  const b = ctx.config.bank;
  const bankLine = `${b.bankName}　${b.branchName}　${b.accountType}　${b.accountNumber}　${b.accountHolder}`;
  const bY = doc.y;
  doc.rect(X, bY, W, 30).stroke("#cccccc");
  doc.fontSize(10.5).fillColor("#000000").text(bankLine, X + 10, bY + 9, { width: W - 20 });
  doc.y = bY + 30;
  doc.moveDown(0.4);
  doc.fontSize(10).text(`お支払期限：${ctx.paymentDueText}`, X, doc.y, { width: W });
  doc.moveDown(0.5);
  if (ctx.note) {
    doc.fontSize(9.5).fillColor("#333333").text(`備考：${ctx.note}`, X, doc.y, { width: W });
    doc.fillColor("#000000");
  }

  doc.fontSize(8.5).fillColor("#888888")
    .text(`発行日：${fmtDateJp(ctx.generatedAt)}　／　発行：${ctx.config.issuer.companyName}`, X, 760, { width: W, align: "right" });
  return doc;
}

module.exports = function settlementApi(db) {
  const router = Router();
  const pnlCol = db.collection("propertyMonthlyPnL");

  // 収支・帳票はオーナー/サブオーナーのみ
  router.use((req, res, next) => {
    const role = req.user && req.user.role;
    if (role !== "owner" && role !== "sub_owner") {
      return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
    }
    next();
  });

  async function loadConfig_() {
    const doc = await db.collection("settings").doc("settlementConfig").get();
    const c = doc.exists ? doc.data() : {};
    return {
      issuer: { ...DEFAULT_ISSUER, ...(c.issuer || {}) },
      bank: { ...DEFAULT_BANK, ...(c.bank || {}) },
      consumptionTaxPct: c.consumptionTaxPct != null ? Number(c.consumptionTaxPct) : 10,
      feeRounding: c.feeRounding || "round",
    };
  }

  async function loadCategories_() {
    const snap = await db.collection("expenseCategories").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  }

  // 帳票の計算コンテキストを組み立てる
  async function buildContext_(propertyId, yearMonth, opts = {}) {
    const propSnap = await db.collection("properties").doc(propertyId).get();
    if (!propSnap.exists) throw new Error("物件が見つかりません");
    const prop = propSnap.data();

    const ref = pnlCol.doc(`${propertyId}_${yearMonth}`);
    const pnlSnap = await ref.get();
    if (!pnlSnap.exists) throw new Error("対象月の収支データがありません。先にOTA CSVを取り込んでください");
    const data = pnlSnap.data();

    const cats = await loadCategories_();
    const computed = computePnl(data, cats);

    const rev = data.revenue || {};
    const ab = rev.airbnb || {};
    const bk = rev.booking || {};
    const depositAirbnb = Number(ab.grossRevenue || 0);
    const depositBooking = Number(bk.netRevenue != null ? bk.netRevenue : (Number(bk.grossRevenue || 0) - Number(bk.commission || 0)));
    const depositAmount = depositAirbnb + depositBooking;

    const taxWithholding = opts.taxWithholding != null ? Number(opts.taxWithholding)
      : Number(data.taxWithholding || 0);

    const config = await loadConfig_();
    const feeRatePct = prop.managementFeeRate != null ? Number(prop.managementFeeRate) : 50;
    const settlement = computeSettlement({
      depositAmount, taxWithholding, feeRatePct,
      consumptionTaxPct: config.consumptionTaxPct, feeRounding: config.feeRounding,
    });

    const recipient = { ...DEFAULT_RECIPIENT, ...(prop.settlementRecipient || {}) };
    const dim = daysInMonth(yearMonth);
    const occupancyRate = dim > 0 ? Math.round((Number(data.nights || 0) / dim) * 1000) / 10 : 0;

    return {
      propertyId, yearMonth, propertyName: prop.name || propertyId,
      settlementMode: prop.settlementMode || "daiko",
      data, computed, config, recipient,
      revenue: {
        airbnbGross: depositAirbnb, bookingGross: Number(bk.grossRevenue || 0),
        bookingCommission: Number(bk.commission || 0), bookingNet: depositBooking,
        airbnbReservations: Number(ab.reservationCount || 0),
        bookingReservations: Number(bk.reservationCount || 0),
      },
      nights: Number(data.nights || 0), occupancyRate,
      settlement,
      generatedAt: opts.now || new Date(),
      note: opts.note || "",
      paymentDueText: opts.paymentDueText || "翌月末日",
    };
  }

  // PDF doc を tmp に書き出して Storage へ保存 → 署名URL
  async function savePdfToStorage_(doc, destPath) {
    const tmpPath = path.join(os.tmpdir(), `settle_${Date.now()}_${Math.round(Math.random() * 1e6)}.pdf`);
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(tmpPath);
      doc.pipe(stream);
      doc.end();
      stream.on("finish", resolve);
      stream.on("error", reject);
    });
    const bucket = getStorage().bucket("minpaku-v2.firebasestorage.app");
    await bucket.upload(tmpPath, { destination: destPath, metadata: { contentType: "application/pdf" } });
    const [url] = await bucket.file(destPath).getSignedUrl({ action: "read", expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return url;
  }

  // ── 宿泊税B: やどぜい月計表PDFから自動取込 ──
  // OTAcsvフォルダは yamasuke81 のマイドライブ体系なので OAuth トークンで開く(pnl.js と同方式)
  async function resolveOtaDrive_() {
    const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
    if (!oauthDoc.exists) throw new Error("Gmail/Drive OAuth 未設定");
    const { clientId, clientSecret } = oauthDoc.data();
    const cols = [
      db.collection("settings").doc("gmailOAuth").collection("tokens"),
      db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
    ];
    async function findByEmail(email) {
      for (const col of cols) { const s = await col.where("email", "==", email).limit(1).get(); if (!s.empty) return s.docs[0].data(); }
      return null;
    }
    let tok = await findByEmail("yamasuke81@gmail.com");
    if (!tok) for (const col of cols) { const s = await col.limit(1).get(); if (!s.empty) { tok = s.docs[0].data(); break; } }
    if (!tok || !tok.refreshToken) throw new Error("Drive OAuth トークン未登録 (yamasuke81 の Drive 再認可が必要)");
    const oa = new google.auth.OAuth2(clientId, clientSecret);
    oa.setCredentials({ refresh_token: tok.refreshToken });
    return google.drive({ version: "v3", auth: oa });
  }

  async function getGeminiApiKey_() {
    const doc = await db.collection("settings").doc("scanSorter").get();
    return doc.exists ? (doc.data().geminiApiKey || "") : "";
  }

  // 月計表PDF(base64)から当月の宿泊税額を抽出
  async function geminiExtractTax_(pdfBase64, apiKey, yearMonth) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const prompt = [
      "これは「やどぜい」(宿泊税)の月次集計表(月計表)または申告書のPDFです。",
      `対象年月は ${yearMonth} です。この月に宿泊者から預かった/納付すべき宿泊税の合計額(円)を抽出してください。`,
      "金額はカンマなしの整数。確実に読めなければ0。JSONのみ出力(説明文なし):",
      '{"taxAmount": 整数, "confidence": 0-100}',
    ].join("\n");
    const payload = {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }],
      generationConfig: { temperature: 0.1 },
    };
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error("Gemini API error: " + r.status + " " + (await r.text()).slice(0, 200));
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini応答にJSONがありません");
    return JSON.parse(m[0]);
  }

  // POST /:propertyId/:yearMonth/import-tax — 月計表PDFから宿泊税額Bを取込 → pnl.taxWithholding
  router.post("/:propertyId/:yearMonth/import-tax", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const propSnap = await db.collection("properties").doc(propertyId).get();
      if (!propSnap.exists) return res.status(404).json({ error: "物件が見つかりません" });
      const folderId = req.body?.folderId || propSnap.data().driveOtaCsvFolderId;
      if (!folderId) return res.status(400).json({ error: "OTAcsvフォルダ(driveOtaCsvFolderId)が未設定です" });

      const apiKey = await getGeminiApiKey_();
      if (!apiKey) return res.status(400).json({ error: "Gemini APIキー(settings/scanSorter)が未設定です" });

      const drive = await resolveOtaDrive_();
      // 申告書を優先(税額が明記される)。月計表は課税対象泊数のみで税額が無いことがある
      let file = null;
      for (const kw of ["yadozei_申告書", "申告書", "yadozei_月計表", "月計表"]) {
        const r = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false and name contains '${kw}' and name contains '${yearMonth}'`,
          fields: "files(id,name)", orderBy: "createdTime desc", pageSize: 5,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
        });
        const pdfs = (r.data.files || []).filter((f) => /\.pdf$/i.test(f.name));
        if (pdfs.length) { file = pdfs[0]; break; }
      }
      if (!file) return res.status(404).json({ error: `${yearMonth} のやどぜい月計表/申告書PDFが見つかりません` });

      const bin = await drive.files.get({ fileId: file.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      const pdfBase64 = Buffer.from(bin.data).toString("base64");
      const parsed = await geminiExtractTax_(pdfBase64, apiKey, yearMonth);
      const taxAmount = Math.max(0, Math.round(Number(parsed.taxAmount) || 0));

      await pnlCol.doc(`${propertyId}_${yearMonth}`).set(
        { propertyId, yearMonth, taxWithholding: taxAmount, taxWithholdingSource: file.name, taxWithholdingFileId: file.id, updatedAt: FieldValue.serverTimestamp() },
        { merge: true });

      res.json({ ok: true, taxWithholding: taxAmount, confidence: parsed.confidence, sourceFile: file.name, link: `https://drive.google.com/file/d/${file.id}/view` });
    } catch (e) {
      console.error("宿泊税取込エラー:", e);
      res.status(400).json({ error: "宿泊税の取込に失敗しました: " + e.message });
    }
  });

  // 計算コンテキストのプレビュー(数値確認用・PDF生成なし)
  router.get("/:propertyId/:yearMonth/context", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const ctx = await buildContext_(propertyId, yearMonth, {
        taxWithholding: req.query.taxWithholding != null ? Number(req.query.taxWithholding) : undefined,
      });
      res.json({
        propertyName: ctx.propertyName, yearMonth: ctx.yearMonth, settlementMode: ctx.settlementMode,
        revenue: ctx.revenue, nights: ctx.nights, occupancyRate: ctx.occupancyRate,
        computed: ctx.computed, settlement: ctx.settlement, recipient: ctx.recipient,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 帳票生成 kind=report|settlement → Storage保存 → 署名URL
  router.post("/:propertyId/:yearMonth/generate", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const { kind, taxWithholding, note, paymentDueText } = req.body || {};
      if (kind !== "report" && kind !== "settlement") {
        return res.status(400).json({ error: "kind は report か settlement" });
      }
      const font = findCjkFont();
      if (!font) return res.status(500).json({ error: "日本語フォントが見つかりません" });

      const ctx = await buildContext_(propertyId, yearMonth, { taxWithholding, note, paymentDueText });
      if (kind === "settlement" && ctx.settlementMode === "self") {
        return res.status(400).json({ error: "この物件は自社名義運営のため精算書兼請求書は発行しません" });
      }

      if (taxWithholding != null) {
        await pnlCol.doc(`${propertyId}_${yearMonth}`).set(
          { taxWithholding: Number(taxWithholding), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }

      const doc = kind === "report" ? renderReportPdf(ctx, font) : renderSettlementPdf(ctx, font);
      const destPath = `settlements/${propertyId}/${yearMonth}_${kind}.pdf`;
      const url = await savePdfToStorage_(doc, destPath);

      res.json({ ok: true, kind, url, settlement: ctx.settlement, computed: ctx.computed });
    } catch (e) {
      console.error("帳票生成エラー:", e);
      res.status(400).json({ error: e.message });
    }
  });

  return router;
};

// テスト用に純粋描画関数を公開
module.exports.renderReportPdf = renderReportPdf;
module.exports.renderSettlementPdf = renderSettlementPdf;
module.exports._defaults = { DEFAULT_ISSUER, DEFAULT_BANK, DEFAULT_RECIPIENT };
