/**
 * 請求書 API
 * シフト実績 + ランドリー → 自動集計 → スタッフ確認 → PDF生成
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { notifyOwner, notifyGroup, getNotificationSettings_, sendLineMessage, sendNotificationEmail_, resolveNotifyTargets } = require("../utils/lineNotify");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const os = require("os");

// バンドルフォント（第一候補）
const BUNDLED_CJK_FONT = path.join(__dirname, "../fonts/NotoSansJP-Regular.ttf");

// CJKフォントのパス候補（Cloud Functions 環境フォールバック）
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJKjp-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
];

function findCjkFont() {
  // バンドルフォントを最優先で使う
  if (fs.existsSync(BUNDLED_CJK_FONT)) return BUNDLED_CJK_FONT;
  // フォールバック: OS インストールフォント
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
 * 請求書宛名を解決する
 * 物件 (ownerStaffId) に紐付いたWebアプリ管理者 staff 情報を優先、無ければ settings/clientInfo、
 * さらに無ければ合同会社八朔 (既定) を使用する。
 *
 * @param {Firestore} db
 * @param {string|null} propertyId
 * @param {Object} client - 既に取得済みの settings/clientInfo (fallback 用)
 * @returns {Promise<{companyName:string, address:string, zipCode:string, name:string, isPersonal:boolean, source:string}>}
 *
 * isPersonal: 法人 (会社名あり) は false、個人名義 (屋号/会社名なし) は true。
 * PDF 宛先で「御中」/「様」を切替するために使用する。
 */
async function resolveInvoiceRecipient_(db, propertyId, client) {
  // fallback: settings/clientInfo → 既定 (合同会社八朔)
  const fallback = {
    companyName: client?.companyName || "合同会社八朔",
    address: client?.address || "広島県安芸郡海田町上市4-23-12",
    zipCode: client?.zipCode || "736-0061",
    name: client?.name || "",
    isPersonal: !(client?.companyName && client.companyName.trim()),
    source: "settings",
  };
  if (!propertyId) return fallback;
  try {
    const pDoc = await db.collection("properties").doc(propertyId).get();
    if (!pDoc.exists) return fallback;
    const pData = pDoc.data();
    const ownerStaffId = pData.ownerStaffId;
    const ownerBillingProfileId = pData.ownerBillingProfileId || null;
    if (!ownerStaffId) return fallback;
    const sDoc = await db.collection("staff").doc(ownerStaffId).get();
    if (!sDoc.exists) return fallback;
    const s = sDoc.data();

    // 1. 物件に紐付けられた billingProfile を優先して解決
    const profiles = Array.isArray(s.billingProfiles) ? s.billingProfiles : [];
    let picked = null;
    if (ownerBillingProfileId) {
      picked = profiles.find(p => p && p.id === ownerBillingProfileId) || null;
    }
    // 2. 未指定 or 不一致で profiles が 1 件ならそれを使う
    if (!picked && profiles.length === 1) {
      picked = profiles[0];
    }

    if (picked) {
      const hasCompany = !!(picked.companyName && String(picked.companyName).trim());
      return {
        companyName: picked.companyName || s.name || "",
        address: picked.address || "",
        zipCode: picked.zipCode || "",
        name: s.name || "",
        isPersonal: !hasCompany,
        source: "ownerStaffBillingProfile",
      };
    }

    // 3. 旧データ互換: profiles が無い / 選択不能なら staff 直下の旧フィールドを使う
    if (s.companyName || s.address || s.zipCode) {
      const hasCompanyLegacy = !!(s.companyName && String(s.companyName).trim());
      return {
        companyName: s.companyName || s.name || "",
        address: s.address || "",
        zipCode: s.zipCode || "",
        name: s.name || "",
        isPersonal: !hasCompanyLegacy,
        source: "ownerStaffLegacy",
      };
    }

    // 4. それも無ければ fallback (settings/clientInfo)
    return fallback;
  } catch (e) {
    console.warn("[resolveInvoiceRecipient_] 失敗:", e.message);
    return fallback;
  }
}

/**
 * invoice.details (shifts/special/laundry/prepaid) および transportationFee を
 * excludedRows に基づいてフィルタする。PDF描画前に呼ぶことで除外行が PDF に出ないようにする。
 *
 * @param {Object} details - { shifts, special, laundry, prepaid, manualItems, manual }
 * @param {Array} excludedRows - [{type, refId, ...}]
 * @param {string} yearMonth - "YYYY-MM" (交通費除外判定用)
 * @returns {Object} フィルタ済み details + transportationExcluded フラグ
 */
function applyExclusionsToDetails_(details, excludedRows, yearMonth) {
  const excludedKeys = new Set((excludedRows || []).map(r => `${r.type}:${r.refId}`));
  const shifts = (details?.shifts || []).filter(s => !excludedKeys.has(`shift:${s.shiftId || s.id || ""}`));
  const special = (details?.special || []).filter(sp => !excludedKeys.has(`special:${(sp.shiftId || "")}_${sp.name || ""}`));
  const laundry = (details?.laundry || []).filter(l => !excludedKeys.has(`laundry:${l.id || ""}`));
  const prepaid = (details?.prepaid || []).filter(p => !excludedKeys.has(`prepaid:${p.cardId || p.cardNumber || ""}`));
  const transportationExcluded = excludedKeys.has(`transportation:${yearMonth || ""}`);
  return {
    shifts,
    special,
    laundry,
    prepaid,
    manualItems: details?.manualItems || details?.manual || [],
    transportationExcluded,
  };
}

/**
 * 請求書データから PDF Buffer を生成する (Storage に保存しない)
 * プレビュー用途。generateInvoicePdf_ の描画ロジックを共有するが、tmp 書込・
 * Storage アップロード・Drive 保存は行わず、生 Buffer を返す。
 *
 * @param {Object} invoice - { id, yearMonth, staffId, staffName, propertyId, propertyName,
 *                             total, details: {shifts, special, laundry, manualItems, prepaid}, remarks }
 * @param {Object} staff - staff ドキュメントのデータ (name, address, bankName 等)
 * @param {Object} client - settings/clientInfo (宛先情報)
 * @param {Object} propertyMap - { propertyId: propertyName }
 * @returns {Promise<Buffer>}
 */
async function renderInvoicePdfBuffer(invoice, staff, client, propertyMap) {
  const cjkFont = findCjkFont();

  return await new Promise((resolve, reject) => {
    const pdfOpts = { margin: 40, size: "A4" };
    if (cjkFont) pdfOpts.font = cjkFont;
    const pdfDoc = new PDFDocument(pdfOpts);
    const buffers = [];
    pdfDoc.on("data", (chunk) => buffers.push(chunk));
    pdfDoc.on("end", () => resolve(Buffer.concat(buffers)));
    pdfDoc.on("error", reject);

    const setFont = (size = 10) => { if (cjkFont) pdfDoc.font(cjkFont).fontSize(size); else pdfDoc.font("Helvetica").fontSize(size); };

    // Cloud Functions は UTC で動作するため JST +9h シフトで今日の日付を取得
    const nowUtc = new Date();
    const jstNow = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
    const issuedDate = `${jstNow.getUTCFullYear()}年${String(jstNow.getUTCMonth() + 1).padStart(2, "0")}月${String(jstNow.getUTCDate()).padStart(2, "0")}日`;
    const [yy, mm] = (invoice.yearMonth || "").split("-").map(Number);
    const firstDay = new Date(yy, mm - 1, 1);
    const lastDay = new Date(yy, mm, 0);
    const fmt = (d) => `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
    const periodLabel = `${yy}年${mm}月分`;
    const periodRange = `${fmt(firstDay)}〜${fmt(lastDay)}`;
    const paymentDue = new Date(yy, mm, 5);

    const leftX = 40;
    const rightX = 340;
    const pageWidth = 515;

    // 宛先(左) + 請求元(右)
    let topY = pdfDoc.y;
    setFont(10);
    pdfDoc.text(`〒${client.zipCode || ""}`, leftX, topY);
    pdfDoc.text(client.address || "", leftX, topY + 14);
    setFont(12);
    pdfDoc.text(`${client.companyName || ""}  ${client.isPersonal ? "様" : "御中"}`, leftX, topY + 28, { underline: true });

    setFont(9);
    pdfDoc.text(staff.address || staff.memo || "", rightX, topY, { width: 210, align: "right" });
    pdfDoc.text(invoice.staffName || staff.name || "", rightX, topY + 14, { width: 210, align: "right" });

    // タイトル
    pdfDoc.moveDown(3);
    setFont(22);
    pdfDoc.text("請求書", leftX, pdfDoc.y, { width: pageWidth, align: "center" });
    pdfDoc.moveDown(0.5);
    setFont(10);
    pdfDoc.text(`請求日:${issuedDate}`, leftX, pdfDoc.y, { width: pageWidth, align: "right" });
    pdfDoc.moveDown(1);
    pdfDoc.text("下記の通り、御請求申し上げます。", leftX, pdfDoc.y);
    pdfDoc.moveDown(0.8);
    pdfDoc.text(`請求対象年月:${periodLabel}(${periodRange})`, leftX, pdfDoc.y);
    if (invoice.propertyName) {
      pdfDoc.moveDown(0.3);
      pdfDoc.text(`対象物件:${invoice.propertyName}`, leftX, pdfDoc.y);
    }
    pdfDoc.moveDown(0.8);

    // 合計
    setFont(14);
    pdfDoc.text(`合計金額: ¥${fmtYen(invoice.total)}(税込)`, leftX, pdfDoc.y, { underline: true });
    pdfDoc.moveDown(1);

    // 明細行構築
    const rows = [];
    const shifts = invoice.details?.shifts || [];
    shifts.forEach((s) => {
      const propName = propertyMap[s.propertyId] || s.propertyId || "";
      let label = `清掃 ${propName}`;
      if (s.workType === "pre_inspection") label = `直前点検 ${propName}`;
      else if (s.workType === "laundry_put_out") label = s.workItemName || `ランドリー出し`;
      else if (s.workType === "laundry_collected") label = s.workItemName || `ランドリー受取`;
      else if (s.workType === "laundry_expense") label = s.workItemName || `ランドリー立替`;
      else if (s.workType === "other") label = `その他作業 ${propName}`;
      let memo = s.memo || "";
      if (s.isTimee && s.timeeDetail) {
        const td = s.timeeDetail;
        memo = `タイミー ${td.start}〜${td.end}(${td.durationH}h) × ¥${td.hourlyRate}/h`;
      } else {
        const parts = [];
        if (s.workType === "cleaning_by_count" && s.staffCountOnDay) {
          parts.push(`担当${s.staffCountOnDay}名作業`);
        }
        if (s.guestCount > 1) parts.push(`ゲスト${s.guestCount}名`);
        if (parts.length) memo = parts.join(" / ");
      }
      rows.push({ date: s.date ? fmtDate(s.date) : "", label, amount: s.amount || 0, memo });
    });
    (invoice.details?.special || []).forEach((sp) => {
      const propName = propertyMap[sp.propertyId] || sp.propertyId || "";
      rows.push({
        date: sp.date ? fmtDate(sp.date) : (sp.dateStr || ""),
        label: `特別加算: ${sp.name || ""}${propName ? " (" + propName + ")" : ""}`,
        amount: sp.amount || 0, memo: "",
      });
    });
    (invoice.details?.laundry || []).forEach((l) => {
      rows.push({
        date: l.date ? fmtDate(l.date) : "",
        label: l.label || "ランドリー立替",
        amount: l.amount || 0,
        memo: l.memo || l.note || "",
      });
    });
    (invoice.details?.prepaid || []).forEach((p) => {
      rows.push({
        date: p.purchasedAt ? fmtDate(p.purchasedAt) : "",
        label: `プリカ購入 ${p.cardNumber || ""}${p.depotName ? " (" + p.depotName + ")" : ""}`,
        amount: p.amount || 0, memo: "",
      });
    });
    const manualItems = invoice.details?.manualItems || invoice.manualItems || invoice.details?.manual || [];
    manualItems.forEach((item) => {
      rows.push({
        date: item.date ? fmtDate(item.date) : "",
        label: item.label || "",
        amount: item.amount || 0,
        memo: item.memo || "",
      });
    });

    // テーブル
    setFont(10);
    const col = { date: leftX, label: leftX + 90, amount: leftX + 400 };
    const colW = { date: 85, label: 300, amount: 110 };
    const tableStartY = pdfDoc.y;
    pdfDoc.rect(leftX, tableStartY, pageWidth, 22).fillAndStroke("#f0f0f0", "#aaaaaa");
    pdfDoc.fillColor("#000");
    pdfDoc.text("日付", col.date + 4, tableStartY + 6, { width: colW.date - 4 });
    pdfDoc.text("作業内容", col.label + 4, tableStartY + 6, { width: colW.label - 4 });
    pdfDoc.text("金額", col.amount + 4, tableStartY + 6, { width: colW.amount - 8, align: "right" });
    let y = tableStartY + 22;
    rows.forEach((r) => {
      const memoH = r.memo ? 12 : 0;
      const rowH = 20 + memoH;
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
    pdfDoc.text("", pdfDoc.page.margins.left, y);
    pdfDoc.moveDown(0.8);

    // 請求書メモ (支払期限の上) — invoice.invoiceMemo 優先 (毎月内容可変)
    const memoText = invoice.invoiceMemo || "";
    if (memoText) {
      setFont(9);
      pdfDoc.fillColor("#333");
      pdfDoc.text("メモ:", leftX, pdfDoc.y);
      pdfDoc.text(String(memoText), leftX + 12, pdfDoc.y, { width: pageWidth - 12 });
      pdfDoc.fillColor("#000");
      pdfDoc.moveDown(0.4);
    }

    setFont(10);
    pdfDoc.text(`支払期限: ${fmt(paymentDue)}`, leftX, pdfDoc.y);
    pdfDoc.moveDown(0.5);
    const bankLine = [
      staff.bankName || "-",
      staff.branchName ? `${staff.branchName}支店` : "",
      staff.accountType || "",
      staff.accountNumber || "",
      staff.accountHolder || "",
    ].filter(Boolean).join("  ");
    pdfDoc.text(`振込先: ${bankLine}`, leftX, pdfDoc.y);
    pdfDoc.moveDown(0.5);
    pdfDoc.text("備考:", leftX, pdfDoc.y);
    pdfDoc.text(invoice.remarks || "", leftX, pdfDoc.y + 14, { width: pageWidth });

    pdfDoc.end();
  });
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

  // 宛先(請求先)情報: まず settings/clientInfo を取得
  let clientBase = {};
  try {
    const cDoc = await db.collection("settings").doc("clientInfo").get();
    if (cDoc.exists) clientBase = cDoc.data();
  } catch (_) {}
  // 物件のWebアプリ管理者 (ownerStaffId) → staff 情報を優先し、なければ clientInfo/既定
  const client = await resolveInvoiceRecipient_(db, invoice.propertyId || null, clientBase);

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

    // Cloud Functions は UTC で動作するため JST +9h シフトで今日の日付を取得
    const nowUtc = new Date();
    const jstNow = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
    const issuedDate = `${jstNow.getUTCFullYear()}年${String(jstNow.getUTCMonth() + 1).padStart(2, "0")}月${String(jstNow.getUTCDate()).padStart(2, "0")}日`;
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
    pdfDoc.text(`${client.companyName || ""}  ${client.isPersonal ? "様" : "御中"}`, leftX, topY + 28, { underline: true });

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
    // 除外行 (invoice.excludedRows) を詳細配列からフィルタしてから描画
    const _filtered = applyExclusionsToDetails_(invoice.details || {}, invoice.excludedRows || [], invoice.yearMonth);
    // 行を構築: 清掃明細 + 特別加算 + ランドリー明細 + 追加項目
    const rows = [];
    const shifts = _filtered.shifts;
    shifts.forEach((s) => {
      const propName = propertyMap[s.propertyId] || s.propertyId || "";
      let label = `清掃 ${propName}`;
      if (s.workType === "pre_inspection") label = `直前点検 ${propName}`;
      else if (s.workType === "laundry_put_out") label = s.workItemName || `ランドリー出し`;
      else if (s.workType === "laundry_collected") label = s.workItemName || `ランドリー受取`;
      else if (s.workType === "laundry_expense") label = s.workItemName || `ランドリー立替`;
      else if (s.workType === "other") label = `その他作業 ${propName}`;
      let memo = s.memo || "";
      if (s.isTimee && s.timeeDetail) {
        const td = s.timeeDetail;
        memo = `タイミー ${td.start}〜${td.end}(${td.durationH}h) × ¥${td.hourlyRate}/h`;
      } else {
        const parts = [];
        if (s.workType === "cleaning_by_count" && s.staffCountOnDay) {
          parts.push(`担当${s.staffCountOnDay}名作業`);
        }
        if (s.guestCount > 1) parts.push(`ゲスト${s.guestCount}名`);
        if (parts.length) memo = parts.join(" / ");
      }
      rows.push({
        date: s.date ? fmtDate(s.date) : "",
        label,
        amount: s.amount || 0,
        memo,
        section: "shift",
      });
    });
    const specialItems = _filtered.special;
    specialItems.forEach((sp) => {
      const propName = propertyMap[sp.propertyId] || sp.propertyId || "";
      rows.push({
        date: sp.date ? fmtDate(sp.date) : (sp.dateStr || ""),
        label: `特別加算: ${sp.name || ""}${propName ? " (" + propName + ")" : ""}`,
        amount: sp.amount || 0,
        memo: "",
        section: "special",
      });
    });
    const laundry = _filtered.laundry;
    laundry.forEach((l) => {
      rows.push({
        date: l.date ? fmtDate(l.date) : "",
        label: l.label || "ランドリー立替",
        amount: l.amount || 0,
        memo: l.memo || l.note || "",
        section: "laundry",
      });
    });
    const manualItems = _filtered.manualItems || invoice.manualItems || [];
    manualItems.forEach((item) => {
      rows.push({
        date: item.date ? fmtDate(item.date) : "",
        label: item.label || "",
        amount: item.amount || 0,
        memo: item.memo || "",
        section: "manual",
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
    // pdfkit では .y 直接代入は非推奨のため text("") で位置を更新してから moveDown で余白確保
    pdfDoc.text("", pdfDoc.page.margins.left, y);
    pdfDoc.moveDown(0.8);

    // ── 請求書メモ (支払期限の上) ── invoice.invoiceMemo 優先 (毎月可変)
    const memoText = invoice.invoiceMemo || "";
    if (memoText) {
      setFont(9);
      pdfDoc.fillColor("#333");
      pdfDoc.text("メモ：", leftX, pdfDoc.y);
      pdfDoc.text(String(memoText), leftX + 12, pdfDoc.y, { width: pageWidth - 12 });
      pdfDoc.fillColor("#000");
      pdfDoc.moveDown(0.4);
    }

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

/**
 * 特別加算期間判定 (rates.js の recurYearly対応ロジックをバックエンドに移植)
 * dateStr: "YYYY-MM-DD"
 * sr: { recurYearly, recurStart, recurEnd, start, end, addAmount }
 */
function isDateInSpecialRate(dateStr, sr) {
  if (!dateStr) return false;
  if (sr.recurYearly) {
    const md = dateStr.slice(5); // "MM-DD"
    const s = sr.recurStart || "01-01";
    const e = sr.recurEnd || "12-31";
    if (s <= e) {
      return md >= s && md <= e;
    } else {
      // 年跨ぎ (例: 11-01〜02-28)
      return md >= s || md <= e;
    }
  } else {
    const start = sr.start || "";
    const end = sr.end || "";
    if (start && dateStr < start) return false;
    if (end && dateStr > end) return false;
    return !!(start || end);
  }
}

/**
 * 請求書の共通集計関数
 * my-submit と generate の重複ロジックを統合
 * 戻り値: { shifts, laundry, special, manual, shiftAmount, laundryAmount, specialAmount, transportationFee, total, byProperty }
 *
 * @param {object} db - Firestore インスタンス
 * @param {string} staffId - スタッフID
 * @param {string} yearMonth - "YYYY-MM"
 * @param {Array} manualItems - 手動追加項目 (オプション)
 * @param {string|null} propertyId - 物件フィルタ (null=全物件合算)
 */
async function computeInvoiceDetails(db, staffId, yearMonth, manualItems = [], propertyId = null) {
  const [y, m] = yearMonth.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0, 23, 59, 59);

  // スタッフ情報
  const staffDoc = await db.collection("staff").doc(staffId).get();
  if (!staffDoc.exists) throw new Error("スタッフが見つかりません");
  const staff = { id: staffDoc.id, ...staffDoc.data() };

  // --- 除外設定 (invoiceExclusions/{yearMonth}_{staffId}_{propertyId}) の読み込み ---
  // 各 row に {type, refId} を付けておき、"type:refId" が excludedSet に含まれる場合はスキップ
  // 物件別化: propertyId がある場合のみ除外ドキュメントを読む
  const excludedSet = new Set();
  const excludedMetaMap = {}; // "type:refId" -> {excludedAt, excludedBy, note}
  try {
    const exclusionDocId = propertyId
      ? `${yearMonth}_${staffId}_${propertyId}`
      : `${yearMonth}_${staffId}`; // 後方互換 (物件未指定時)
    const exDoc = await db.collection("invoiceExclusions").doc(exclusionDocId).get();
    if (exDoc.exists) {
      const arr = Array.isArray(exDoc.data().exclusions) ? exDoc.data().exclusions : [];
      for (const ex of arr) {
        if (!ex || !ex.type || !ex.refId) continue;
        const key = `${ex.type}:${ex.refId}`;
        excludedSet.add(key);
        excludedMetaMap[key] = {
          excludedAt: ex.excludedAt || null,
          excludedBy: ex.excludedBy || null,
          note: ex.note || "",
        };
      }
    }
  } catch (e) {
    console.warn("invoiceExclusions 読み込みエラー (無視):", e.message);
  }

  // シフト取得 (propertyId 指定時はフィルタ)
  let shiftsQuery = db.collection("shifts")
    .where("staffId", "==", staffId)
    .where("date", ">=", start)
    .where("date", "<=", end);
  if (propertyId) shiftsQuery = shiftsQuery.where("propertyId", "==", propertyId);
  const shiftsSnap = await shiftsQuery.get();
  const rawShifts = shiftsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // ランドリー取得 (isReimbursable === true のみ計上。propertyId フィルタ適用)
  let laundryQuery = db.collection("laundry")
    .where("staffId", "==", staffId)
    .where("date", ">=", start)
    .where("date", "<=", end);
  if (propertyId) laundryQuery = laundryQuery.where("propertyId", "==", propertyId);
  const laundrySnap = await laundryQuery.get();
  const laundryAll = laundrySnap.docs.map(d => ({ id: d.id, ...d.data() }));
  // ランドリー立替の請求書計上対象:
  //   - 現金 (cash) のみ対象 (スタッフが自分のお金で立替)
  //   - クレジットカード (credit): 削除 (Webアプリ管理者支払い or 個人カード、立替対象外)
  //   - プリペイドカード (prepaid): 別途 prepaidDetails (新規購入) で計上
  //   - 店舗請求 (shop_bill): Webアプリ管理者が後で直接店舗に払うため立替対象外
  const reimbursableLaundry = laundryAll.filter(l => {
    const pm = l.paymentMethod || (l.isReimbursable ? "cash" : null);
    return pm === "cash";
  });

  // 提出先(depot)マスター settings/laundryDepots.items: [{id,kind,name,rates}]
  // depotId / depot フィールドから提出先名を解決するために利用
  let depotMasterItems = [];
  try {
    const depotDoc = await db.collection("settings").doc("laundryDepots").get();
    if (depotDoc.exists && Array.isArray(depotDoc.data().items)) {
      depotMasterItems = depotDoc.data().items;
    }
  } catch (_) { /* ignore */ }
  const depotById = {};
  for (const d of depotMasterItems) {
    if (d && d.id) depotById[d.id] = d;
  }
  // laundry ドキュメント (または同等オブジェクト) から depot 表示名を解決
  const resolveDepotName = (l) => {
    if (!l) return "";
    if (l.depotId) {
      const m = depotById[l.depotId];
      if (m && m.name) return m.name;
    }
    if (l.depot) {
      if (depotById[l.depot] && depotById[l.depot].name) return depotById[l.depot].name;
      return String(l.depot);
    }
    if (l.depotOther) return String(l.depotOther);
    return "";
  };
  // shift と laundry の紐付け用マップ (sourceChecklistId 経由)
  const laundryByChecklistId = {};
  for (const l of laundryAll) {
    if (l.sourceChecklistId) laundryByChecklistId[l.sourceChecklistId] = l;
  }

  // propertyWorkItems のキャッシュ (propertyId → workItems)
  const workItemsCache = {};
  const getWorkItems = async (propertyId) => {
    if (!propertyId) return null;
    if (workItemsCache[propertyId] !== undefined) return workItemsCache[propertyId];
    try {
      const doc = await db.collection("propertyWorkItems").doc(propertyId).get();
      workItemsCache[propertyId] = doc.exists ? (doc.data().items || []) : [];
    } catch (_) {
      workItemsCache[propertyId] = [];
    }
    return workItemsCache[propertyId];
  };

  // properties のキャッシュ
  const propertyCache = {};
  const getProperty = async (propertyId) => {
    if (!propertyId) return null;
    if (propertyCache[propertyId] !== undefined) return propertyCache[propertyId];
    try {
      const doc = await db.collection("properties").doc(propertyId).get();
      propertyCache[propertyId] = doc.exists ? { id: doc.id, ...doc.data() } : null;
    } catch (_) {
      propertyCache[propertyId] = null;
    }
    return propertyCache[propertyId];
  };

  // bookings のキャッシュ
  const bookingCache = {};
  const getBooking = async (bookingId) => {
    if (!bookingId) return null;
    if (bookingCache[bookingId] !== undefined) return bookingCache[bookingId];
    try {
      const doc = await db.collection("bookings").doc(bookingId).get();
      bookingCache[bookingId] = doc.exists ? { id: doc.id, ...doc.data() } : null;
    } catch (_) {
      bookingCache[bookingId] = null;
    }
    return bookingCache[bookingId];
  };

  // 同日同物件で active 状態のスタッフ数を取得 (階段制単価の段位選択に使用)
  // active = status が assigned / confirmed / completed のいずれか
  // workType も同じ cleaning_by_count に限定 (清掃と直前点検は別カウント)
  const ACTIVE_SHIFT_STATUSES = ["assigned", "confirmed", "completed"];
  const staffCountCache = {};
  const getStaffCountForDateProperty = async (dateStr, pid, workType) => {
    if (!dateStr || !pid) return 1;
    const cacheKey = `${dateStr}|${pid}|${workType}`;
    if (staffCountCache[cacheKey] !== undefined) return staffCountCache[cacheKey];
    try {
      // date は Timestamp で保存されているため、その日の 00:00 〜 翌日 00:00 で範囲検索
      const dayStart = new Date(`${dateStr}T00:00:00+09:00`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const snap = await db.collection("shifts")
        .where("propertyId", "==", pid)
        .where("date", ">=", dayStart)
        .where("date", "<", dayEnd)
        .get();
      const staffIds = new Set();
      snap.docs.forEach(d => {
        const s = d.data();
        if (!ACTIVE_SHIFT_STATUSES.includes(s.status)) return;
        if (workType && s.workType && s.workType !== workType) return;
        if (s.staffId) staffIds.add(s.staffId);
      });
      const count = Math.max(staffIds.size, 1);
      staffCountCache[cacheKey] = count;
      return count;
    } catch (e) {
      console.warn("getStaffCountForDateProperty 失敗:", e.message);
      return 1;
    }
  };

  // シフト単価計算
  const shiftDetails = [];
  const specialDetails = [];
  let shiftAmount = 0;
  let specialAmount = 0;

  for (const shift of rawShifts) {
    const propertyId = shift.propertyId || "";
    const workType = shift.workType || "cleaning_by_count";
    // laundry_expense は shift 側では計上せず、laundry ドキュメント側に一本化
    // (shift と laundry で同じ金額が二重計上されるのを防ぐ)
    if (workType === "laundry_expense") continue;
    const dateStr = shift.date
      ? (shift.date.toDate ? shift.date.toDate() : new Date(shift.date)).toISOString().slice(0, 10)
      : "";

    // booking から guestCount 取得 (備考表示用のみに使用)
    const booking = await getBooking(shift.bookingId);
    const guestCountRaw = booking?.guestCount || 1;

    // 階段制単価の段位選択は「同日同物件で active シフトを持つスタッフ人数」基準
    // (ゲスト数ではない)
    const staffCountOnDay = await getStaffCountForDateProperty(dateStr, propertyId, workType);
    const rateKey = Math.min(Math.max(staffCountOnDay, 1), 3);

    // propertyWorkItems から作業項目を検索
    // laundry_* は workItemName (名前) で一致検索、それ以外は type で一致検索
    const workItems = await getWorkItems(propertyId);
    let workItem;
    if (shift.workItemName) {
      // shift に workItemName が記録されている場合は名前で優先マッチ
      workItem = (workItems || []).find(wi => wi.name === shift.workItemName);
    }
    if (!workItem) {
      workItem = (workItems || []).find(wi => (wi.type || "other") === workType);
    }

    let amount = 0;

    if (workItem) {
      if (staff.isTimee === true) {
        // タイミースタッフ: property.baseWorkTime から duration × timeeHourlyRate
        const property = await getProperty(propertyId);
        const baseWorkTime = property?.baseWorkTime || {};
        const startT = baseWorkTime.start || "10:30";
        const endT = baseWorkTime.end || "14:30";
        const [sh, sm] = startT.split(":").map(Number);
        const [eh, em] = endT.split(":").map(Number);
        const durationH = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
        amount = Math.round(durationH * (workItem.timeeHourlyRate || 0));
      } else if (workItem.rateMode === "perStaff") {
        const rates = workItem.staffRates?.[staffId] || {};
        amount = typeof rates === "object" ? (rates[rateKey] || rates[3] || 0) : Number(rates || 0);
      } else {
        // common モード (デフォルト)
        const rates = workItem.commonRates || {};
        amount = typeof rates === "object" ? (rates[rateKey] || rates[3] || 0) : Number(workItem.commonRate || 0);
      }
    } else {
      // workItem 未設定時のフォールバック
      // laundry_expense は shift.amount が立替実費なのでそのまま使用
      if (workType === "laundry_expense") {
        amount = Number(shift.amount) || 0;
      } else if (workType === "laundry_put_out" || workType === "laundry_collected") {
        // 報酬設定未登録の場合は 0 円（請求書には行として表示されるが 0 円）
        amount = 0;
      } else {
        amount = staff.ratePerJob || 0;
      }
    }

    shiftAmount += amount;
    shiftDetails.push({
      shiftId: shift.id,
      date: shift.date,
      propertyId,
      propertyName: shift.propertyName || "",
      workType,
      guestCount: guestCountRaw,
      staffCountOnDay,
      amount,
      sourceChecklistId: shift.sourceChecklistId || "",
      isTimee: staff.isTimee || false,
      timeeDetail: staff.isTimee ? (() => {
        const property = propertyCache[propertyId];
        const bwt = property?.baseWorkTime || {};
        const s = bwt.start || "10:30"; const e = bwt.end || "14:30";
        const [sh, sm2] = s.split(":").map(Number);
        const [eh, em2] = e.split(":").map(Number);
        const dh = ((eh * 60 + em2) - (sh * 60 + sm2)) / 60;
        return { start: s, end: e, durationH: dh, hourlyRate: workItem?.timeeHourlyRate || 0 };
      })() : null,
    });

    // 特別加算の判定
    if (workItem && Array.isArray(workItem.specialRates)) {
      for (const sr of workItem.specialRates) {
        if (isDateInSpecialRate(dateStr, sr)) {
          const addAmt = Number(sr.addAmount || 0);
          if (addAmt > 0) {
            specialAmount += addAmt;
            specialDetails.push({
              shiftId: shift.id,
              date: shift.date,
              dateStr,
              name: sr.name || "(特別加算)",
              propertyId,
              amount: addAmt,
            });
          }
        }
      }
    }
  }

  // ランドリー集計
  // sourceShiftId が設定されている場合は shift 経由で計上済みのためスキップ (二重カウント防止)
  // id は除外キー (laundry:{id}) とのマッチ用
  const laundryDetails = reimbursableLaundry
    .filter(l => !l.sourceShiftId)
    .map(l => ({
      id: l.id,  // 除外マッチ用
      date: l.date,
      amount: l.amount || 0,
      memo: l.memo || "",
      label: "ランドリー立替",
    }));
  const laundryAmount = laundryDetails.reduce((s, l) => s + l.amount, 0);

  // 交通費
  const transportationFee = rawShifts.length * (staff.transportationFee || 0);

  // --- プリカ購入の立替集計 ---
  // settings/prepaidCards から、指定スタッフが該当月に購入したカードを抽出
  let prepaidExpense = 0;
  const prepaidDetails = [];
  try {
    const pcDoc = await db.collection("settings").doc("prepaidCards").get();
    const items = (pcDoc.exists && Array.isArray(pcDoc.data().items)) ? pcDoc.data().items : [];
    // depotId → depotName マップ (備考用)
    let depotMap = {};
    try {
      const depotDoc = await db.collection("settings").doc("laundryDepots").get();
      const dItems = (depotDoc.exists && Array.isArray(depotDoc.data().items)) ? depotDoc.data().items : [];
      dItems.forEach(d => { depotMap[d.id || d.name] = d.name || d.id; });
    } catch (_) {}

    // 月範囲は start/end (JST 月初〜月末 23:59:59) を流用
    const startMs = start.getTime();
    const endMs = end.getTime();

    for (const card of items) {
      // メタデータが無い旧データはスキップ
      if (!card.purchasedBy || !card.purchasedBy.staffId || !card.purchasedAt) continue;
      if (card.purchasedBy.staffId !== staffId) continue;

      // purchasedAt を Date に変換
      const paRaw = card.purchasedAt;
      const paDate = paRaw.toDate ? paRaw.toDate()
        : (paRaw._seconds ? new Date(paRaw._seconds * 1000) : new Date(paRaw));
      if (isNaN(paDate.getTime())) continue;
      const paMs = paDate.getTime();
      if (paMs < startMs || paMs > endMs) continue;

      // propertyId 指定時は所属物件に含まれるカードのみ
      if (propertyId) {
        const pids = Array.isArray(card.propertyIds) ? card.propertyIds : [];
        if (!pids.includes(propertyId)) continue;
      }

      const amount = Number(card.chargeAmount) || 0;
      if (amount <= 0) continue;

      // 物件名カンマ区切り (物件別請求書では省略)
      const propNames = [];
      if (!propertyId) {
        for (const pid of (card.propertyIds || [])) {
          const p = await getProperty(pid);
          propNames.push(p?.name || pid);
        }
      }
      const depotName = depotMap[card.depotId] || card.depotId || "";
      const note = `${card.cardNumber || ""}${depotName ? ` (${depotName})` : ""}${propNames.length ? ` ${propNames.join(",")}` : ""}`.trim();

      prepaidExpense += amount;
      prepaidDetails.push({
        cardId: card.id || card.cardId || "",
        purchasedAt: paDate,
        cardNumber: card.cardNumber || "",
        depotId: card.depotId || "",
        depotName,
        propertyIds: card.propertyIds || [],
        amount,
        note,
      });
    }
  } catch (e) {
    console.warn("プリカ集計エラー (無視):", e.message);
  }

  // 手動追加項目 (date フィールド対応 — 旧データは date 無しでも読める)
  const manual = (manualItems || []).map(i => ({
    date: i.date ? String(i.date) : "",
    label: String(i.label || ""),
    amount: Number(i.amount) || 0,
    memo: String(i.memo || ""),
  }));
  const manualAmount = manual.reduce((s, i) => s + i.amount, 0);

  const total = shiftAmount + laundryAmount + specialAmount + transportationFee + manualAmount + prepaidExpense;

  // --- 物件別内訳 (byProperty) ---
  // shiftDetails と laundryDetails を propertyId でグループ化
  const byProperty = {};

  for (const s of shiftDetails) {
    const pid = s.propertyId || "_unknown";
    if (!byProperty[pid]) {
      // 物件名を取得
      let pName = s.propertyName || "";
      if (!pName && pid !== "_unknown") {
        const prop = await getProperty(pid);
        pName = prop?.name || pid;
      }
      byProperty[pid] = { propertyName: pName, shiftCount: 0, shiftAmount: 0, laundryAmount: 0, total: 0 };
    }
    byProperty[pid].shiftCount += 1;
    byProperty[pid].shiftAmount += s.amount || 0;
    byProperty[pid].total += s.amount || 0;
  }

  for (const l of laundryDetails) {
    // laundry はコレクションに propertyId が保存されている場合にグループ化
    // reimbursableLaundry から元データの propertyId を引く
    const origDoc = reimbursableLaundry.find(r => !r.sourceShiftId &&
      (l.date === r.date || JSON.stringify(l.date) === JSON.stringify(r.date)) &&
      (l.amount === r.amount || l.amount === (r.amount || 0)));
    const pid = origDoc?.propertyId || "_unknown";

    if (!byProperty[pid]) {
      let pName = "";
      if (pid !== "_unknown") {
        const prop = await getProperty(pid);
        pName = prop?.name || pid;
      }
      byProperty[pid] = { propertyName: pName, shiftCount: 0, shiftAmount: 0, laundryAmount: 0, total: 0 };
    }
    byProperty[pid].laundryAmount += l.amount || 0;
    byProperty[pid].total += l.amount || 0;
  }

  // --- 縦テーブル用の行データ (rows) ---
  // 日付 | 項目 | 単価 | 備考 の4列で、日付昇順に並べる
  // 日付表示は YYYY/MM/DD (ユーザー仕様)
  const toDateStr = (v) => {
    if (!v) return "";
    const d = v.toDate ? v.toDate() : new Date(v);
    if (isNaN(d.getTime())) return "";
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  };
  const rows = [];

  // プロパティ cleaningRequiredCount のキャッシュ (清掃1人/2人作業の判定用)
  const reqCountCache = {};
  const getReqCount = async (pid) => {
    if (!pid) return 1;
    if (reqCountCache[pid] !== undefined) return reqCountCache[pid];
    const p = await getProperty(pid);
    reqCountCache[pid] = Number(p?.cleaningRequiredCount || 1);
    return reqCountCache[pid];
  };

  // 除外された rows を分けて格納 (UI 表示用)
  const excludedRows = [];
  // row を push する前に除外判定するヘルパー
  // - excludedSet に含まれる場合は excludedRows に入れて rows には入れない
  // - 同時に再計算用の差し引き情報を返す (subtract: {shift, special, laundryCash, prepaid, transport})
  const subtract = { shift: 0, special: 0, laundryCash: 0, prepaid: 0, transport: 0 };
  const pushRow = (row, subtractKey) => {
    const key = `${row.type}:${row.refId}`;
    if (excludedSet.has(key)) {
      const meta = excludedMetaMap[key] || {};
      excludedRows.push({
        ...row,
        excludedAt: meta.excludedAt || null,
        excludedBy: meta.excludedBy || null,
        excludedNote: meta.note || "",
      });
      if (subtractKey && subtract.hasOwnProperty(subtractKey)) {
        subtract[subtractKey] += Number(row.unitPrice) || 0;
      }
      return;
    }
    rows.push(row);
  };

  // シフトから行を生成
  for (const s of shiftDetails) {
    const dateStr = toDateStr(s.date);
    let category = "";
    if (s.workType === "cleaning_by_count") {
      const reqCount = await getReqCount(s.propertyId);
      category = reqCount >= 2 ? "清掃2人作業" : "清掃1人作業";
    } else if (s.workType === "pre_inspection") {
      category = "直前点検";
    } else if (s.workType === "laundry_put_out") {
      category = "ランドリー出し";
    } else if (s.workType === "laundry_collected") {
      category = "ランドリー受取";
    } else if (s.workType === "laundry_expense") {
      category = "ランドリー";
    } else if (s.workType === "other") {
      category = "その他";
    } else {
      category = s.workType || "作業";
    }
    // 物件別請求書では物件名は note 不要 (propertyId で一意)
    // propertyId 未指定時のみ物件名を含める (後方互換)
    let note = propertyId ? "" : (s.propertyName || "");
    if (s.isTimee && s.timeeDetail) {
      const td = s.timeeDetail;
      const timeePart = `タイミー ${td.start}〜${td.end}(${td.durationH}h) × ¥${td.hourlyRate}/h`;
      note = note ? `${note} / ${timeePart}` : timeePart;
    } else {
      // 階段制単価の根拠を明示: 担当スタッフ人数 (+ ゲスト数)
      const parts = [];
      if (s.workType === "cleaning_by_count" && s.staffCountOnDay) {
        parts.push(`担当${s.staffCountOnDay}名作業`);
      }
      if (s.guestCount > 1) parts.push(`ゲスト${s.guestCount}名`);
      if (parts.length) {
        const extra = parts.join(" / ");
        note = note ? `${note} / ${extra}` : extra;
      }
    }
    // ランドリー系シフト(出し/受取/立替)は提出先(depot/リネン屋)名を note に追記
    if (s.workType === "laundry_put_out" || s.workType === "laundry_collected" || s.workType === "laundry_expense") {
      const lrec = s.sourceChecklistId ? laundryByChecklistId[s.sourceChecklistId] : null;
      const depotName = resolveDepotName(lrec);
      if (depotName) {
        note = note ? `${note} / ${depotName}` : depotName;
      }
    }
    pushRow({
      type: "shift",
      refId: s.shiftId || s.id || "",
      date: dateStr,
      category,
      unitPrice: s.amount || 0,
      note: note.replace(/^ \/ /, ""),
    }, "shift");
  }

  // 特別加算行
  for (const sp of specialDetails) {
    pushRow({
      type: "special",
      refId: `${sp.shiftId || ""}_${sp.name || ""}`,
      date: sp.dateStr || toDateStr(sp.date),
      category: `特別加算: ${sp.name || ""}`,
      unitPrice: sp.amount || 0,
      note: "",
    }, "special");
  }

  // ランドリー (paymentMethod 別に分岐)
  //   cash    → category="ランドリー" / note="物件名 / 提出先 / 立替" / unitPrice=金額
  //   credit  → 行を出さない (立替対象外)
  //   prepaid → プリカ新規購入が同日・同 depot にある場合のみ行を出す
  //             note="物件名 / 提出先 / プリカ新規購入" / unitPrice=0
  //             (実費は別途プリカ購入行で計上されるため二重計上回避)
  //   shop_bill → 行を出さない (Webアプリ管理者が店舗直接支払)
  for (const l of laundryAll.filter(x => !x.sourceShiftId)) {
    const pm = l.paymentMethod || (l.isReimbursable ? "cash" : null);
    if (pm !== "cash" && pm !== "prepaid") continue;

    const depotName = resolveDepotName(l);
    const memo = l.memo || "";
    const ldate = toDateStr(l.date);
    // 物件別請求書では物件名は note 不要 (propertyId で一意)
    // propertyId 未指定時のみ物件名を含める (後方互換)
    let propertyName = "";
    if (!propertyId && l.propertyId) {
      const p = await getProperty(l.propertyId);
      propertyName = p?.name || "";
    }

    let unitPrice = 0;
    let suffix = "";

    if (pm === "cash") {
      unitPrice = l.amount || 0;
      suffix = "立替";
    } else if (pm === "prepaid") {
      // 同日・同 depot の新規購入があるか
      const hasPurchase = prepaidDetails.some(p =>
        toDateStr(p.purchasedAt) === ldate && (p.depotId || "") === (l.depotId || "")
      );
      if (!hasPurchase) continue; // 既存プリカ使用は行なし
      suffix = "プリカ新規購入";
    }

    // note 組立: (物件名) / メモ / 提出先 / 立替(or プリカ新規購入)
    // 物件別化時は物件名を省略
    const parts = [];
    if (propertyName) parts.push(propertyName);
    if (memo) parts.push(memo);
    if (depotName) parts.push(depotName);
    parts.push(suffix);

    pushRow({
      type: "laundry",
      refId: l.id || "",
      date: ldate,
      category: "ランドリー",
      unitPrice,
      note: parts.filter(Boolean).join(" / "),
    }, "laundryCash");
  }
  // 非立替のランドリー (作業報酬としてシフトに入らない純粋な出し/受取記録がある場合)
  // ※ 既存 shift から来る laundry_put_out/collected は shiftDetails 側で計上済みなので重複させない

  // プリカ購入行 (購入日ごとに1行)
  for (const p of prepaidDetails) {
    pushRow({
      type: "prepaid",
      refId: p.cardId || p.cardNumber || toDateStr(p.purchasedAt),
      date: toDateStr(p.purchasedAt),
      category: "プリカ購入",
      unitPrice: p.amount || 0,
      note: p.note || "",
    }, "prepaid");
  }

  // 交通費 (月末にまとめて1行)
  if (transportationFee > 0) {
    const eomDate = new Date(y, m, 0);
    const eomStr = `${eomDate.getFullYear()}/${String(eomDate.getMonth() + 1).padStart(2, "0")}/${String(eomDate.getDate()).padStart(2, "0")}`;
    pushRow({
      type: "transportation",
      refId: yearMonth,
      date: eomStr,
      category: "交通費",
      unitPrice: transportationFee,
      note: `${rawShifts.length}回 × ¥${staff.transportationFee || 0}`,
    }, "transport");
  }

  // 日付昇順ソート (空の date は末尾)
  rows.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });

  // 除外分を各合計から差し引く (再計算ベース)
  const adjShiftAmount = Math.max(0, shiftAmount - (subtract.shift || 0));
  const adjSpecialAmount = Math.max(0, specialAmount - (subtract.special || 0));
  const adjLaundryAmount = Math.max(0, laundryAmount - (subtract.laundryCash || 0));
  const adjPrepaidExpense = Math.max(0, prepaidExpense - (subtract.prepaid || 0));
  const adjTransportationFee = Math.max(0, transportationFee - (subtract.transport || 0));
  const adjTotal = adjShiftAmount + adjLaundryAmount + adjSpecialAmount
    + adjTransportationFee + manualAmount + adjPrepaidExpense;

  return {
    shifts: shiftDetails,
    laundry: laundryDetails,
    special: specialDetails,
    manual,
    prepaid: prepaidDetails,
    shiftAmount: adjShiftAmount,
    laundryAmount: adjLaundryAmount,
    specialAmount: adjSpecialAmount,
    transportationFee: adjTransportationFee,
    manualAmount,
    prepaidExpense: adjPrepaidExpense,
    total: adjTotal,
    shiftCount: rawShifts.length,
    byProperty,
    rows,
    excludedRows,
  };
}

module.exports = function invoicesApi(db) {
  const router = Router();
  const collection = db.collection("invoices");

  // ドライラン: Firestoreに書き込まずプレビュー金額を返す
  // POST /invoices/compute-preview  body: { staffId?, yearMonth }
  // スタッフは自分のみ可、Webアプリ管理者は任意スタッフ可
  router.post("/compute-preview", async (req, res) => {
    try {
      const { yearMonth, staffId: reqStaffId } = req.body || {};
      if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ error: "yearMonth(YYYY-MM)は必須です" });
      }

      // 対象 staffId の決定
      let targetStaffId = null;
      if (req.user.role === "owner") {
        // Webアプリ管理者は任意スタッフを指定可
        targetStaffId = reqStaffId || req.user.staffId;
        if (!targetStaffId) {
          // Webアプリ管理者自身の staffId をフォールバック検索
          const snap = await db.collection("staff").where("authUid", "==", req.user.uid).limit(1).get();
          if (!snap.empty) targetStaffId = snap.docs[0].id;
        }
      } else {
        // スタッフは自分のみ
        targetStaffId = req.user.staffId;
        if (!targetStaffId) {
          const snap = await db.collection("staff").where("authUid", "==", req.user.uid).limit(1).get();
          if (!snap.empty) targetStaffId = snap.docs[0].id;
        }
        // 他人の preview は不可
        if (reqStaffId && reqStaffId !== targetStaffId) {
          return res.status(403).json({ error: "他のスタッフのプレビューは参照できません" });
        }
      }

      if (!targetStaffId) {
        return res.status(404).json({ error: "スタッフ情報が見つかりません" });
      }

      // propertyId オプション (物件別プレビュー)
      const { propertyId: reqPropertyId } = req.body || {};

      // computeInvoiceDetails で計算 (Firestoreへの書き込みなし)
      let computed;
      try {
        computed = await computeInvoiceDetails(db, targetStaffId, yearMonth, [], reqPropertyId || null);
      } catch (compErr) {
        return res.status(500).json({ error: "集計処理に失敗しました: " + compErr.message });
      }

      res.json({
        staffId: targetStaffId,
        yearMonth,
        propertyId: reqPropertyId || null,
        shiftCount: computed.shiftCount,
        shiftAmount: computed.shiftAmount,
        laundryAmount: computed.laundryAmount,
        specialAmount: computed.specialAmount,
        transportationFee: computed.transportationFee,
        prepaidExpense: computed.prepaidExpense || 0,
        manualAmount: 0,
        total: computed.total,
        shifts: computed.shifts,
        laundry: computed.laundry,
        special: computed.special,
        prepaid: computed.prepaid || [],
        byProperty: computed.byProperty,
        rows: computed.rows || [],
        excludedRows: computed.excludedRows || [],
      });
    } catch (e) {
      console.error("compute-preview エラー:", e);
      res.status(500).json({ error: "プレビュー計算に失敗しました: " + e.message });
    }
  });

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

      // スタッフは自分の請求書のみ (staffId と req.user.staffId で照合)
      if (req.user.role === "staff") {
        invoices = invoices.filter((inv) => inv.staffId === req.user.staffId);
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

      // スタッフは自分の請求書のみ (staffId と req.user.staffId で照合)
      if (req.user.role === "staff" && data.staffId !== req.user.staffId) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      res.json(data);
    } catch (e) {
      console.error("請求書取得エラー:", e);
      res.status(500).json({ error: "請求書の取得に失敗しました" });
    }
  });

  // 請求書プレビュー PDF を生成して Buffer で返す (Storage 保存なし)
  // POST /invoices/my-preview-pdf  body: { yearMonth, propertyId, manualItems?, invoiceMemo?, asStaffId? (Webアプリ管理者専用代理) }
  router.post("/my-preview-pdf", async (req, res) => {
    try {
      const { yearMonth, propertyId, manualItems = [], invoiceMemo = "", asStaffId } = req.body || {};
      if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ error: "yearMonth(YYYY-MM)は必須です" });
      }
      if (!propertyId || typeof propertyId !== "string") {
        return res.status(400).json({ error: "propertyId は必須です" });
      }

      // 対象 staffId 決定 (/my-submit と同じロジック)
      const uid = req.user.uid;
      const reqStaffId = req.user.staffId;
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
      if (!staffDoc) return res.status(404).json({ error: "スタッフが見つかりません" });

      // 集計 (invoiceExclusions も既に適用される)
      const details = await computeInvoiceDetails(db, staffDoc.id, yearMonth, manualItems, propertyId);

      // 宛先(client)情報: まず settings/clientInfo を取得し、
      // 物件のWebアプリ管理者 (ownerStaffId) があれば staff 情報で上書きする
      let clientBase = {};
      try {
        const cDoc = await db.collection("settings").doc("clientInfo").get();
        if (cDoc.exists) clientBase = cDoc.data();
      } catch (_) {}
      const client = await resolveInvoiceRecipient_(db, propertyId, clientBase);

      // propertyMap (1物件のみ)
      const propertyMap = {};
      const pDoc = await db.collection("properties").doc(propertyId).get();
      const propertyName = pDoc.exists ? pDoc.data().name : propertyId;
      propertyMap[propertyId] = propertyName;

      // 除外行を詳細配列からもフィルタ (PDF に除外項目が出ないように)
      const filtered = applyExclusionsToDetails_(
        {
          shifts: details.shifts,
          special: details.special,
          laundry: details.laundry,
          prepaid: details.prepaid,
          manualItems: details.manual,
        },
        details.excludedRows || [],
        yearMonth,
      );

      // invoice-like オブジェクト (除外済み詳細を使用)
      const invoice = {
        id: "preview",
        yearMonth,
        staffId: staffDoc.id,
        staffName: staffDoc.name || "",
        propertyId,
        propertyName,
        total: details.total,
        invoiceMemo: invoiceMemo || "",
        details: {
          shifts: filtered.shifts,
          special: filtered.special,
          laundry: filtered.laundry,
          manualItems: filtered.manualItems,
          prepaid: filtered.prepaid,
        },
        remarks: "(プレビュー)",
      };

      const buf = await renderInvoicePdfBuffer(invoice, staffDoc, client, propertyMap);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="preview_${yearMonth}_${staffDoc.id}.pdf"`);
      res.send(buf);
    } catch (e) {
      console.error("my-preview-pdf エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // スタッフが自分の請求書を作成 or 更新（月次集計）
  // POST /invoices/my-submit  body: { yearMonth, propertyId, manualItems?, invoiceMemo?, asStaffId? }
  router.post("/my-submit", async (req, res) => {
    try {
      const { yearMonth, propertyId, manualItems = [], invoiceMemo = "", asStaffId } = req.body || {};
      if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ error: "yearMonth(YYYY-MM)は必須です" });
      }
      if (!propertyId || typeof propertyId !== "string") {
        return res.status(400).json({ error: "propertyId は必須です (物件を選択してください)" });
      }
      const uid = req.user.uid;
      const reqStaffId = req.user.staffId;
      // Webアプリ管理者が asStaffId を指定した場合: そのスタッフの請求書を代理作成 (テスト用)
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

      // computeInvoiceDetails で統合集計 (物件別)
      let computed;
      try {
        computed = await computeInvoiceDetails(db, staffDoc.id, yearMonth, manualItems, propertyId);
      } catch (compErr) {
        return res.status(500).json({ error: "集計処理に失敗しました: " + compErr.message });
      }

      // 物件名取得 (invoice ドキュメントへの propertyName 保存用)
      let propertyName = "";
      try {
        const pDoc = await db.collection("properties").doc(propertyId).get();
        if (pDoc.exists) propertyName = pDoc.data().name || "";
      } catch (_) { /* ignore */ }

      // invoiceId: 物件別化のため propertyId 短縮形を末尾に付与
      const invoiceId = `INV-${yearMonth.replace("-", "")}-${staffDoc.id.substring(0, 6)}-${propertyId.substring(0, 6)}`;
      const [, m] = yearMonth.split("-").map(Number);
      const invoiceData = {
        yearMonth,
        staffId: staffDoc.id,
        staffName: staffDoc.name,
        propertyId,
        propertyName,
        basePayment: computed.shiftAmount,
        laundryFee: computed.laundryAmount,
        transportationFee: computed.transportationFee,
        specialAllowance: computed.specialAmount,
        prepaidExpense: computed.prepaidExpense || 0,
        total: computed.total,
        status: "submitted",
        byProperty: computed.byProperty || {},
        details: {
          shifts: computed.shifts,
          laundry: computed.laundry,
          special: computed.special,
          prepaid: computed.prepaid || [],
          manualItems: computed.manual,
        },
        // 除外行 (PDF 再生成でも除外が維持されるよう invoice ドキュメントに保存)
        excludedRows: computed.excludedRows || [],
        // Webアプリ管理者へのメッセージ (毎月可変、staff へは保存しない)
        invoiceMemo: String(invoiceMemo || ""),
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      // 既存ドキュメントの status 確認
      const existing = await collection.doc(invoiceId).get();
      if (existing.exists) {
        const existingStatus = existing.data().status;
        // submitted / paid は再送信不可 (409 Conflict)
        if (existingStatus === "submitted" || existingStatus === "paid") {
          return res.status(409).json({
            error: "この月の請求書は既に送信済みです。修正はWebアプリ管理者に連絡してください",
          });
        }
      } else {
        // 初回作成時のみ createdAt をセット
        invoiceData.createdAt = FieldValue.serverTimestamp();
      }

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

      // invoice_submitted 通知: resolveNotifyTargets で送信先を判定
      try {
        const { settings, channelToken, ownerUserId } = await getNotificationSettings_(db);
        const targets = resolveNotifyTargets(settings, "invoice_submitted");
        if (targets.enabled) {
          const appUrl = (settings && settings.appUrl) || "https://minpaku-v2.web.app";
          const confirmUrl = `${appUrl}/#/invoices`;
          const linkLine = pdfSignedUrl ? `\nPDF: ${pdfSignedUrl}` : "";
          const title = `請求書提出: ${staffDoc.name} ${yearMonth}`;
          const ownerBody = `📨 請求書が提出されました\n\n${staffDoc.name} さんから ${m}月分の請求書が届きました。\n合計: ¥${Number(computed.total).toLocaleString("ja-JP")}${linkLine}\n確認: ${confirmUrl}`;

          // Webアプリ管理者LINE
          if (targets.ownerLine) {
            await notifyOwner(db, "invoice_submitted", title, ownerBody).catch((e) => console.error("Webアプリ管理者LINE送信失敗:", e.message));
          }
          // グループLINE
          if (targets.groupLine) {
            await notifyGroup(db, "invoice_submitted", title, ownerBody).catch((e) => console.error("グループLINE送信失敗:", e.message));
          }
          // Webアプリ管理者メール
          if (targets.ownerEmail) {
            const ownerEmail = settings && (settings.ownerEmail || (settings.notifyEmails && settings.notifyEmails[0]));
            if (ownerEmail) {
              sendNotificationEmail_(ownerEmail, `【請求書提出】${staffDoc.name} ${yearMonth}`, ownerBody)
                .catch((e) => console.error("Webアプリ管理者への請求書通知メール失敗:", e.message));
            }
          }
        }

        // スタッフ本人にも PDF リンクをメール送付（通知設定に依存しない固定送信）
        if (staffDoc.email && pdfSignedUrl) {
          const staffBody = `${staffDoc.name} 様\n\n${yearMonth} 分の請求書が作成されました。\n合計: ¥${Number(computed.total).toLocaleString("ja-JP")}\n\nPDFダウンロード (7日間有効):\n${pdfSignedUrl}\n\n何か相違がございましたらご連絡ください。`;
          sendNotificationEmail_(staffDoc.email, `【請求書】${yearMonth} 分`, staffBody)
            .catch((e) => console.error("スタッフへの請求書メール失敗:", e.message));
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

  // 請求書生成（月次集計）— Webアプリ管理者が手動実行 or 定期ジョブ
  router.post("/generate", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const { yearMonth, propertyId: genPropertyId } = req.body;
      if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ error: "yearMonth（YYYY-MM形式）は必須です" });
      }

      const [year, month] = yearMonth.split("-").map(Number);
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);

      // アクティブスタッフ取得
      const staffSnap = await db.collection("staff").where("active", "==", true).get();
      const staffList = staffSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      const generated = [];
      const skipped = [];

      for (const staff of staffList) {
        // invoiceId: 物件別発行時は propertyId の短縮形を付与
        const propSuffix = genPropertyId ? `-${genPropertyId.substring(0, 6)}` : "";
        const invoiceId = `INV-${yearMonth.replace("-", "")}-${staff.id.substring(0, 6)}${propSuffix}`;
        const existing = await collection.doc(invoiceId).get();
        if (existing.exists && existing.data().status !== "draft") {
          skipped.push(invoiceId);
          continue;
        }

        // computeInvoiceDetails で統合集計 (propertyId フィルタ対応)
        let computed;
        try {
          computed = await computeInvoiceDetails(db, staff.id, yearMonth, [], genPropertyId || null);
        } catch (compErr) {
          console.error(`${staff.id} 集計エラー:`, compErr.message);
          continue;
        }

        if (computed.shiftCount === 0 && computed.laundryAmount === 0) continue;

        const invoiceData = {
          yearMonth,
          staffId: staff.id,
          staffName: staff.name,
          basePayment: computed.shiftAmount,
          laundryFee: computed.laundryAmount,
          transportationFee: computed.transportationFee,
          specialAllowance: computed.specialAmount,
          prepaidExpense: computed.prepaidExpense || 0,
          total: computed.total,
          status: "draft",
          pdfUrl: null,
          confirmedAt: null,
          propertyId: genPropertyId || null,
          byProperty: computed.byProperty || {},
          details: {
            shifts: computed.shifts,
            laundry: computed.laundry,
            special: computed.special,
            prepaid: computed.prepaid || [],
            manualItems: [],
          },
          createdAt: FieldValue.serverTimestamp(),
        };

        await collection.doc(invoiceId).set(invoiceData);
        generated.push({ id: invoiceId, ...invoiceData });
      }

      res.status(201).json({
        message: `${generated.length}件の請求書を生成しました`,
        created: generated.length,
        skipped: skipped.length,
        invoices: generated,
      });
    } catch (e) {
      console.error("請求書生成エラー:", e);
      res.status(500).json({ error: "請求書の生成に失敗しました" });
    }
  });

  // 手動明細項目を追加（Webアプリ管理者のみ）
  router.post("/:id/items", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
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
      const newTotal = (data.basePayment || 0) + (data.laundryFee || 0) + (data.transportationFee || 0) + (data.specialAllowance || 0) + (data.prepaidExpense || 0) + manualTotal;

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

  // 手動明細項目を削除（Webアプリ管理者のみ）
  router.delete("/:id/items/:index", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
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
      const newTotal = (data.basePayment || 0) + (data.laundryFee || 0) + (data.transportationFee || 0) + (data.specialAllowance || 0) + (data.prepaidExpense || 0) + manualTotal;

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

  // 記録情報更新（Webアプリ管理者のみ・draft/submitted のみ）
  // PUT /invoices/:id  body: { remarks?, memo?, transportationFee?, manualItems? }
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      const current = doc.data();
      if (!["draft", "submitted"].includes(current.status)) {
        return res.status(400).json({ error: "draft または submitted 状態の請求書のみ編集できます" });
      }

      // 許可フィールドのみ更新
      const ALLOWED = ["remarks", "memo", "transportationFee", "manualItems"];
      const updates = { updatedAt: FieldValue.serverTimestamp() };
      for (const key of ALLOWED) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      // transportationFee が更新された場合は合計を再計算
      if (updates.transportationFee !== undefined) {
        const manualItems = updates.manualItems ?? current.details?.manualItems ?? [];
        const manualTotal = manualItems.reduce((s, item) => s + (item.amount || 0), 0);
        updates.total = (current.basePayment || 0) + (current.laundryFee || 0) +
          Number(updates.transportationFee) + (current.specialAllowance || 0) + (current.prepaidExpense || 0) + manualTotal;
      }

      // manualItems が更新された場合も合計再計算（transportationFee 未更新時）
      if (updates.manualItems !== undefined && updates.transportationFee === undefined) {
        const manualTotal = updates.manualItems.reduce((s, item) => s + (item.amount || 0), 0);
        updates.total = (current.basePayment || 0) + (current.laundryFee || 0) +
          (current.transportationFee || 0) + (current.specialAllowance || 0) + (current.prepaidExpense || 0) + manualTotal;
        // details.manualItems も同期
        updates["details.manualItems"] = updates.manualItems;
        delete updates.manualItems;
      }

      await docRef.update(updates);
      const updated = await docRef.get();
      res.json({ id: req.params.id, ...updated.data() });
    } catch (e) {
      console.error("請求書更新エラー:", e);
      res.status(500).json({ error: "請求書の更新に失敗しました" });
    }
  });

  // 支払済みマーク（Webアプリ管理者のみ）
  router.put("/:id/markPaid", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
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

  // 請求書削除（Webアプリ管理者のみ・draftのみ）
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
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

  // 請求書再計算 (Webアプリ管理者限定・draft/submitted のみ)
  router.post("/:id/recalculate", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      const invoice = doc.data();
      if (!["draft", "submitted"].includes(invoice.status)) {
        return res.status(400).json({ error: "draft または submitted 状態の請求書のみ再計算できます" });
      }

      // 既存の手動追加項目を引き継ぐ
      const existingManual = invoice.details?.manualItems || [];

      let computed;
      try {
        computed = await computeInvoiceDetails(db, invoice.staffId, invoice.yearMonth, existingManual);
      } catch (compErr) {
        return res.status(500).json({ error: "集計処理に失敗しました: " + compErr.message });
      }

      await docRef.update({
        basePayment: computed.shiftAmount,
        laundryFee: computed.laundryAmount,
        transportationFee: computed.transportationFee,
        specialAllowance: computed.specialAmount,
        prepaidExpense: computed.prepaidExpense || 0,
        total: computed.total,
        byProperty: computed.byProperty || {},
        details: {
          shifts: computed.shifts,
          laundry: computed.laundry,
          special: computed.special,
          prepaid: computed.prepaid || [],
          manualItems: computed.manual,
        },
        recalculatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({
        message: "再計算しました",
        total: computed.total,
        shiftAmount: computed.shiftAmount,
        laundryAmount: computed.laundryAmount,
        specialAmount: computed.specialAmount,
        transportationFee: computed.transportationFee,
      });
    } catch (e) {
      console.error("再計算エラー:", e);
      res.status(500).json({ error: "再計算に失敗しました: " + e.message });
    }
  });

  // 請求書PDF生成 — generateInvoicePdf_ を共通関数として呼び出す（コード重複排除）
  router.get("/:id/pdf", async (req, res) => {
    try {
      // アクセス制御: スタッフは自分の請求書のみ
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "請求書が見つかりません" });
      }
      const invoice = { id: doc.id, ...doc.data() };
      if (req.user.role === "staff" && invoice.staffId !== req.user.staffId) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      // 共通PDF生成関数を使用（宛先+振込先+明細テーブルの正式レイアウト）
      const pdfUrl = await generateInvoicePdf_(db, req.params.id);

      // Firestore の pdfUrl を更新
      await docRef.update({
        pdfUrl,
        updatedAt: FieldValue.serverTimestamp(),
      });

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
      // スタッフは自分の請求書のみ確定可能 (staffId と req.user.staffId で照合)
      if (req.user.role === "staff" && data.staffId !== req.user.staffId) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      await docRef.update({
        status: "confirmed",
        confirmedAt: FieldValue.serverTimestamp(),
      });

      // Webアプリ管理者通知: LINE はWebアプリ管理者本人のみ、メールは ownerEmail 1件
      try {
        const [, m] = String(data.yearMonth || "").split("-");
        const total = Number(data.total || 0);
        const { settings, channelToken, ownerUserId } = await getNotificationSettings_(db);
        const appUrl = (settings && settings.appUrl) || "https://minpaku-v2.web.app";
        const invoiceUrl = `${appUrl.replace(/\/$/, "")}/#/invoices`;
        const body = `📨 請求書が確定されました\n\n` +
          `${data.staffName || "スタッフ"} さんの ${m || data.yearMonth}月分の請求書が確定しました。\n` +
          `合計: ¥${total.toLocaleString()}\n` +
          `確認: ${invoiceUrl}`;

        // LINE: Webアプリ管理者 UserID にのみ送信
        if (channelToken && ownerUserId) {
          sendLineMessage(channelToken, ownerUserId, body).catch((e) => console.error("LINE送信失敗:", e.message));
        }

        // メール: ownerEmail 1件のみ
        const ownerEmail = settings && (settings.ownerEmail || (settings.notifyEmails && settings.notifyEmails[0]));
        if (ownerEmail) {
          sendNotificationEmail_(ownerEmail, `【請求書確定】${data.staffName || ""} ${data.yearMonth}`, body)
            .catch((e) => console.error("Webアプリ管理者への確定通知メール失敗:", e.message));
        }
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

// テスト/検証スクリプト用: 内部計算関数をエクスポート
module.exports.computeInvoiceDetails = computeInvoiceDetails;
// migration スクリプト用: PDF 生成関数をエクスポート
module.exports.generateInvoicePdf_ = generateInvoicePdf_;
