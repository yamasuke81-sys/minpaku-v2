/**
 * 収支管理 API (物件×月の売上・利益)
 *
 * - OTAレポートPDF(Airbnb収入レポート/Booking.com支払明細)と
 *   清掃スタッフ請求書PDFを Gemini でパースして取り込む
 * - 集計粒度は「月×物件サマリー」。Booking のみ予約明細も保持
 * - 売上=総収入、OTA手数料は経費として控除、利益=運営利益
 * - 費目(家賃/光熱/消耗品等)は fixed(毎月定額)/manual(毎月手入力) で自由追加
 *
 * Drive アクセスは scan-sorter と同じ ADC + drive scope。
 * 取込元フォルダにサービスアカウントを閲覧者として共有しておくこと。
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const crypto = require("crypto");
// 純粋関数はテスト済みモジュールから取り込む(pnl-logic.test.js でユニットテスト済)
const {
  toInt,
  normLoose,
  normalizeStaffName,
  resolvePropertyForDoc,
  applyExpenses,
  computePnl,
  cleaningAmountForProperty,
  classifyExpenseByName_,
} = require("./pnl-logic");
// OTA予約CSV(yadozei保存物)の集計 + 運営形態/実効料率(テスト済モジュール)
const {
  sumAirbnbCsv, sumBookingCsv,
  computeSettlement, computeDepositAmount, effectiveFeeRatePct, resolveOperationMode,
} = require("./ota-csv-logic");

// OTA原本フォルダ(既定の取込元。settings/pnlImport.sourceFolderId で上書き可)
const DEFAULT_SOURCE_FOLDER_ID = "10N_wTI-cftdJvVxYGXftXJoxNpsRDRux";

module.exports = function pnlApi(db) {
  const router = Router();
  router.cores = {}; // 各取込ハンドラを保持(月次バッチから fake req/res で呼ぶ)
  const pnlCol = db.collection("propertyMonthlyPnL");
  const catCol = db.collection("expenseCategories");
  const logsCol = db.collection("pnlImportLogs");

  // 収支はオーナー/サブオーナーのみ
  router.use((req, res, next) => {
    const role = req.user && req.user.role;
    if (role !== "owner" && role !== "sub_owner") {
      return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
    }
    next();
  });

  // ========================================================
  // 内部ヘルパ
  // ========================================================

  async function getPnlSettings_() {
    const doc = await db.collection("settings").doc("pnlImport").get();
    return doc.exists ? doc.data() : {};
  }

  async function getGeminiApiKey_() {
    // Gemini キーは scan-sorter 設定を流用
    const doc = await db.collection("settings").doc("scanSorter").get();
    return doc.exists ? (doc.data().geminiApiKey || "") : "";
  }

  function docId_(propertyId, yearMonth) {
    return `${propertyId}_${yearMonth}`;
  }

  // Drive fileId → 閲覧リンク(出典確認用)。fileIdから決定的に組める
  function driveLink_(fileId) {
    return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
  }

  // 物件マスタ取得(OTAマッピング用)
  async function loadProperties_() {
    const snap = await db.collection("properties").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // normLoose / normalizeStaffName / resolvePropertyForDoc は pnl-logic から require 済み

  /**
   * Gemini でPDFを分類+抽出 (1コールで docKind 判定と内容抽出)
   */
  async function analyzePnlPdf_(pdfBase64, apiKey) {
    if (!apiKey) throw new Error("Gemini APIキーが設定されていません");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const prompt = [
      "あなたは民泊運営の経理AIです。以下のPDFを分類し、数値を抽出してJSONのみ出力してください(説明文なし)。",
      "金額はすべてカンマなしの整数(円)。マイナス記号があっても絶対値の正の整数で返すこと。日付は YYYY-MM-DD。",
      "",
      "## 分類 docKind:",
      "- airbnb_monthly : Airbnbの『収入レポート』。月次合計のみで予約明細は無い。",
      "- booking_detail : Booking.comの『お支払い明細』。予約ごとの明細表がある。",
      "- booking_invoice : Booking.comの『請求書』。コミッション・決済サービスの手数料・未払い額合計のサマリで、予約明細表は無い。",
      "- cleaning_invoice : 清掃スタッフ個人や清掃業者からの『請求書』(請求対象年月と合計金額がある)。",
      "- other : 上記以外。",
      "",
      "## 出力JSON:",
      "{",
      '  "docKind": "airbnb_monthly|booking_detail|booking_invoice|cleaning_invoice|other",',
      '  "yearMonth": "対象年月 YYYY-MM (レポート対象期間/請求対象年月から判定。支払日や生成日ではない)",',
      '  "propertyName": "PDF中に出る物件名/施設名(例: the Terrace 長浜, 広長浜)。無ければ空文字",',
      '  "airbnb": {  // docKind=airbnb_monthly のときのみ',
      '    "listingName": "リスティング名",',
      '    "grossRevenue": 総収入,',
      '    "serviceFee": Airbnbサービス料(手数料),',
      '    "withholdingTax": 税金の源泉徴収,',
      '    "netRevenue": 合計金額(純収益),',
      '    "nights": 予約泊数,',
      '    "avgStayDays": 平均宿泊日数(小数可)',
      "  },",
      '  "booking": {  // docKind=booking_detail のときのみ',
      '    "propertyFacilityId": "宿泊施設ID/宿泊施設番号(数字)",',
      '    "reservations": [',
      '      { "reservationNumber": "照会番号", "checkIn": "YYYY-MM-DD", "checkOut": "YYYY-MM-DD", "guestName": "宿泊者氏名", "amount": 金額, "commission": コミッション, "paymentFee": 決済サービスの手数料, "netRevenue": 純収益 }',
      "    ]",
      "  },",
      '  "bookingInvoice": {  // docKind=booking_invoice のときのみ(請求書サマリ)',
      '    "grossRevenue": 客室売上(予約の合計金額),',
      '    "commission": コミッション合計,',
      '    "paymentFee": 決済サービスの手数料合計,',
      '    "totalPayable": 未払い額合計',
      "  },",
      '  "cleaning": {  // docKind=cleaning_invoice のときのみ',
      '    "staffName": "請求者(スタッフ/業者)氏名",',
      '    "propertyName": "対象物件名(あれば)",',
      '    "billingYearMonth": "請求対象年月 YYYY-MM",',
      '    "totalAmount": 請求合計金額(税込),',
      '    "count": 作業回数(明細から数えられれば。不明なら0)',
      "  },",
      '  "confidence": 0-100',
      "}",
      "",
      "該当しないブロックは省略してよい。確実に読めない数値は0にする。",
    ].join("\n");

    const payload = {
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
      ] }],
      generationConfig: { temperature: 0.1 },
    };

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          lastErr = new Error("Gemini API error: " + response.status + " " + (await response.text()));
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const result = await response.json();
        const text = result.candidates && result.candidates[0] && result.candidates[0].content
          ? result.candidates[0].content.parts[0].text.trim() : "";
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) { lastErr = new Error("Gemini応答にJSONがありません"); continue; }
        return JSON.parse(m[0]);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastErr || new Error("Geminiパースに失敗しました");
  }

  // Drive クライアント(ADC + drive scope)
  async function getDriveClient_() {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    return google.drive({ version: "v3", auth });
  }

  /**
   * OTA CSV読取用の Drive クライアント。
   * OTAcsvフォルダ(008_民泊運用配下)は yamasuke81 のマイドライブ体系なので、
   * yadozei-listener と同じく yamasuke81 の OAuth トークンで開く(ADCでは権限不足)。
   */
  async function resolveOtaDrive_() {
    const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
    if (!oauthDoc.exists) throw new Error("Gmail/Drive OAuth 未設定 (settings/gmailOAuth)");
    const { clientId, clientSecret } = oauthDoc.data();
    if (!clientId || !clientSecret) throw new Error("OAuth clientId/clientSecret 未設定");
    const cols = [
      db.collection("settings").doc("gmailOAuth").collection("tokens"),
      db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
    ];
    async function findByEmail(email) {
      for (const col of cols) {
        const snap = await col.where("email", "==", email).limit(1).get();
        if (!snap.empty) return snap.docs[0].data();
      }
      return null;
    }
    let tok = await findByEmail("yamasuke81@gmail.com");
    if (!tok) {
      for (const col of cols) {
        const snap = await col.limit(1).get();
        if (!snap.empty) { tok = snap.docs[0].data(); break; }
      }
    }
    if (!tok || !tok.refreshToken) throw new Error("Drive OAuth トークン未登録 (yamasuke81 の Drive 再認可が必要)");
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: tok.refreshToken });
    return google.drive({ version: "v3", auth: oauth2Client });
  }

  // フォルダ直下から「{ota}_reservations_{ym}_*.csv」の最新1件を探す
  async function findLatestOtaCsv_(drive, folderId, ota, yearMonth) {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and name contains '${ota}_reservations_${yearMonth}'`,
      fields: "files(id,name,createdTime)",
      orderBy: "createdTime desc",
      pageSize: 20,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = (res.data.files || []).filter((f) => /\.csv$/i.test(f.name));
    return files[0] || null;
  }

  async function downloadDriveText_(drive, fileId) {
    const bin = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return Buffer.from(bin.data).toString("utf8");
  }

  // toInt / applyExpenses / computePnl は pnl-logic から require 済み

  async function loadCategories_() {
    const snap = await catCol.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  }

  // ========================================================
  // サマリー取得
  // ========================================================

  // 月レンジのサマリー(テーブル描画用)
  router.get("/summary", async (req, res) => {
    try {
      const { propertyId, from, to } = req.query;
      if (!propertyId) return res.status(400).json({ error: "propertyId は必須です" });
      const categories = await loadCategories_();
      // 物件マスタ(運営形態/既定料率)と精算設定(消費税/丸め)を1回だけ読む
      const propSnap = await db.collection("properties").doc(propertyId).get();
      const prop = propSnap.exists ? propSnap.data() : {};
      const cfgSnap = await db.collection("settings").doc("settlementConfig").get();
      const cfg = cfgSnap.exists ? cfgSnap.data() : {};
      const consumptionTaxPct = cfg.consumptionTaxPct != null ? Number(cfg.consumptionTaxPct) : 10;
      const feeRounding = cfg.feeRounding || "round";
      const operationMode = resolveOperationMode(prop);

      let q = pnlCol.where("propertyId", "==", propertyId);
      const snap = await q.get();
      let months = snap.docs.map((d) => d.data())
        .filter((d) => (!from || d.yearMonth >= from) && (!to || d.yearMonth <= to))
        .sort((a, b) => (a.yearMonth < b.yearMonth ? -1 : 1));
      const result = months.map((d) => {
        const base = computePnl(d, categories);
        // 代行手数料は精算書(computeSettlement)と同一式で算出 → テーブル=実請求額と一致
        const { depositAmount } = computeDepositAmount(d.revenue);
        const feeRatePct = effectiveFeeRatePct(d, prop);
        const settlement = computeSettlement({
          depositAmount,
          taxWithholding: Number(d.taxWithholding || 0),
          feeRatePct, consumptionTaxPct, feeRounding,
        });
        return {
          yearMonth: d.yearMonth,
          nights: d.nights || 0,
          cleaningCount: d.cleaningCount || 0,
          ...base,
          // 実効料率(自社=0/月固定>物件既定)と手数料(税抜/税込・実請求準拠)
          feeRatePct,
          feeRateIsMonthOverride: d.feeRatePct != null,
          mgmtFeeBase: settlement.salesBase,
          mgmtFeeExclTax: settlement.feeExclTax,
          mgmtFeeInclTax: settlement.feeInclTax,
        };
      });
      res.json({
        propertyId,
        operationMode,
        managementFeeRate: prop.managementFeeRate != null ? Number(prop.managementFeeRate) : 50,
        consumptionTaxPct,
        months: result,
        categories: categories.filter((c) => c.active !== false),
      });
    } catch (e) {
      console.error("収支サマリー取得エラー:", e);
      res.status(500).json({ error: "収支サマリーの取得に失敗しました" });
    }
  });

  // 月の代行手数料率を上書き/解除(月固定スナップショット)。owner/sub_owner のみ(router.use で担保)
  // body.feeRatePct: 0-100 の数値で固定、null / "" で解除(物件既定に戻す)
  router.patch("/:propertyId/:yearMonth/fee-rate", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: "yearMonth は YYYY-MM 形式" });
      const raw = req.body ? req.body.feeRatePct : undefined;
      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      if (raw === null || raw === "") {
        await ref.set(
          { propertyId, yearMonth, feeRatePct: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
          { merge: true });
        return res.json({ ok: true, feeRatePct: null });
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: "feeRatePct は 0〜100 の数値、または解除は null" });
      }
      await ref.set(
        { propertyId, yearMonth, feeRatePct: n, updatedAt: FieldValue.serverTimestamp() },
        { merge: true });
      res.json({ ok: true, feeRatePct: n });
    } catch (e) {
      console.error("月料率更新エラー:", e);
      res.status(400).json({ error: "月料率の更新に失敗しました: " + e.message });
    }
  });

  // ========================================================
  // バッチ結果の承認/却下(下書きPDF→送付前の人間承認ゲート)
  // ※ /:propertyId/:yearMonth より前に定義する(そちらが "batch-runs" propertyIdとして誤マッチするため)
  // ========================================================

  // GET /batch-runs/:runId — 承認画面で表示するため runId の内容を返す
  router.get("/batch-runs/:runId", async (req, res) => {
    try {
      const { runId } = req.params;
      if (!/^[\w-]+$/.test(runId)) return res.status(400).json({ error: "runId 不正" });
      const doc = await db.collection("pnlBatchRuns").doc(runId).get();
      if (!doc.exists) return res.status(404).json({ error: "runId が見つかりません" });
      res.json({ runId, ...doc.data() });
    } catch (e) {
      console.error("batch-run 取得エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /batch-runs/:runId/approve — 承認(送付準備完了)。任意で comment
  router.post("/batch-runs/:runId/approve", async (req, res) => {
    try {
      const { runId } = req.params;
      const { comment } = req.body || {};
      const ref = db.collection("pnlBatchRuns").doc(runId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "runId が見つかりません" });
      const cur = snap.data();
      if (cur.approvedAt) return res.status(400).json({ error: "既に承認済みです", approvedAt: cur.approvedAt });
      if (cur.rejectedAt) return res.status(400).json({ error: "却下済みのため承認できません" });
      await ref.set({
        approvedAt: FieldValue.serverTimestamp(),
        approvedBy: req.user?.email || req.user?.uid || "unknown",
        approvalComment: comment || null,
      }, { merge: true });
      res.json({ ok: true, runId, status: "approved" });
    } catch (e) {
      console.error("承認エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /batch-runs/:runId/reject — 却下(reason 必須)
  router.post("/batch-runs/:runId/reject", async (req, res) => {
    try {
      const { runId } = req.params;
      const { reason } = req.body || {};
      if (!reason || !String(reason).trim()) return res.status(400).json({ error: "reason(却下理由)は必須です" });
      const ref = db.collection("pnlBatchRuns").doc(runId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "runId が見つかりません" });
      const cur = snap.data();
      if (cur.approvedAt) return res.status(400).json({ error: "承認済みのため却下できません" });
      await ref.set({
        rejectedAt: FieldValue.serverTimestamp(),
        rejectedBy: req.user?.email || req.user?.uid || "unknown",
        rejectReason: String(reason).slice(0, 500),
      }, { merge: true });
      res.json({ ok: true, runId, status: "rejected" });
    } catch (e) {
      console.error("却下エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // 単月詳細(清掃費行・費目・Booking明細)
  router.get("/:propertyId/:yearMonth", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const categories = await loadCategories_();
      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const doc = await ref.get();
      const data = doc.exists ? doc.data() : { propertyId, yearMonth, revenue: {}, cleaningCosts: [], expenses: {} };
      const detailSnap = await ref.collection("bookingDetails").get();
      const bookingDetails = detailSnap.docs.map((d) => d.data())
        .sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
      res.json({
        ...data,
        computed: computePnl(data, categories),
        bookingDetails,
      });
    } catch (e) {
      console.error("収支単月取得エラー:", e);
      res.status(500).json({ error: "収支の取得に失敗しました" });
    }
  });

  // ========================================================
  // Drive取り込み
  // ========================================================

  // POST /import { folderId?, dryRun? }
  router.post("/import", async (req, res) => {
    try {
      const { folderId, dryRun } = req.body || {};
      const settings = await getPnlSettings_();
      const srcFolder = folderId || settings.sourceFolderId || DEFAULT_SOURCE_FOLDER_ID;
      const apiKey = await getGeminiApiKey_();
      if (!apiKey) return res.status(400).json({ error: "Gemini APIキー(settings/scanSorter)が未設定です" });

      const drive = await getDriveClient_();
      const properties = await loadProperties_();
      const fallbackPropertyId = settings.fallbackPropertyId || null;

      // フォルダ直下のPDFを列挙(誤日付対策でフォルダ名は信用しない)
      const listRes = await drive.files.list({
        q: `'${srcFolder}' in parents and mimeType='application/pdf' and trashed=false`,
        fields: "files(id,name,createdTime)",
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const files = listRes.data.files || [];

      const summary = { scanned: files.length, parsed: 0, applied: 0, skippedDup: 0, errors: 0, items: [] };

      for (const f of files) {
        try {
          // 既処理(fileId)はスキップ(再取込はフェーズ2)
          const dup = await logsCol.where("fileId", "==", f.id).limit(1).get();
          if (!dup.empty) {
            summary.skippedDup++;
            summary.items.push({ fileId: f.id, fileName: f.name, status: "skipped_dup" });
            continue;
          }
          const bin = await drive.files.get({ fileId: f.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
          const pdfBase64 = Buffer.from(bin.data).toString("base64");
          const parsed = await analyzePnlPdf_(pdfBase64, apiKey);
          summary.parsed++;

          if (parsed.docKind === "other") {
            summary.items.push({ fileId: f.id, fileName: f.name, status: "skipped_other", docKind: "other" });
            if (!dryRun) {
              await logsCol.add({ fileId: f.id, fileName: f.name, folderId: srcFolder, docKind: "other",
                status: "skipped_other", parsed, processedAt: FieldValue.serverTimestamp() });
            }
            continue;
          }

          const propertyId = resolvePropertyForDoc(parsed, properties, fallbackPropertyId);
          const yearMonth = parsed.yearMonth ||
            (parsed.cleaning && parsed.cleaning.billingYearMonth) || null;

          const item = { fileId: f.id, fileName: f.name, docKind: parsed.docKind, propertyId, yearMonth, parsed };

          if (!propertyId || !yearMonth) {
            item.status = "unresolved";
            summary.items.push(item);
            if (!dryRun) {
              await logsCol.add({ fileId: f.id, fileName: f.name, folderId: srcFolder, docKind: parsed.docKind,
                propertyId: propertyId || null, yearMonth: yearMonth || null, status: "unresolved", parsed,
                processedAt: FieldValue.serverTimestamp() });
            }
            continue;
          }

          if (dryRun) {
            item.status = "preview";
            summary.items.push(item);
            continue;
          }

          await applyParsedToPnl_({ parsed, propertyId, yearMonth, fileId: f.id });
          await logsCol.add({ fileId: f.id, fileName: f.name, folderId: srcFolder, docKind: parsed.docKind,
            propertyId, yearMonth, status: "applied", parsed, processedAt: FieldValue.serverTimestamp() });
          item.status = "applied";
          summary.applied++;
          summary.items.push(item);
        } catch (e) {
          summary.errors++;
          summary.items.push({ fileId: f.id, fileName: f.name, status: "error", error: e.message });
          if (!dryRun) {
            await logsCol.add({ fileId: f.id, fileName: f.name, folderId: srcFolder, status: "error",
              error: e.message, processedAt: FieldValue.serverTimestamp() }).catch(() => {});
          }
        }
      }

      res.json(summary);
    } catch (e) {
      console.error("Drive取込エラー:", e);
      res.status(500).json({ error: "Drive取り込みに失敗しました: " + e.message });
    }
  });

  // ========================================================
  // OTA予約CSV(yadozei)取り込み → 月次収支の売上
  // ========================================================

  // POST /:propertyId/:yearMonth/import-ota-csv { folderId?, airbnbFileId?, bookingFileId? }
  // yadozei-listener が Drive に保存した Airbnb/Booking の予約CSVを集計して revenue に反映する。
  // 手動修正(manualOverrides)された OTA は上書きしない。
  router.post("/:propertyId/:yearMonth/import-ota-csv", router.cores.importOtaCsv = async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const { folderId, airbnbFileId, bookingFileId } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: "yearMonth は YYYY-MM 形式" });

      const propSnap = await db.collection("properties").doc(propertyId).get();
      if (!propSnap.exists) return res.status(404).json({ error: "物件が見つかりません" });
      const prop = propSnap.data();
      const yz = prop.yadozei || {};
      const listingName = (yz.airbnb && yz.airbnb.listingName) || prop.airbnbListingName || "";
      const srcFolder = folderId || prop.driveOtaCsvFolderId || "";

      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const cur = await ref.get();
      const overrides = (cur.exists && cur.data().manualOverrides) || {};

      const drive = await resolveOtaDrive_();
      // ※ set(merge) はドット記法キーをネストパスと解釈しない(リテラル field 化する)ため、
      //   revenue は必ずネストオブジェクトで組む(merge は入れ子マップを深くマージする)。
      const patch = { propertyId, yearMonth, revenue: {}, updatedAt: FieldValue.serverTimestamp(), lastOtaCsvSyncAt: FieldValue.serverTimestamp() };
      const result = { propertyId, yearMonth, airbnb: null, booking: null, skipped: [] };
      let nightsTotal = 0, gotAny = false;

      // --- Airbnb ---
      if (overrides["revenue.airbnb"]) {
        result.skipped.push("airbnb(手動修正保護)");
      } else {
        let file = null;
        if (airbnbFileId) file = { id: airbnbFileId, name: `airbnb(${airbnbFileId})` };
        else if (srcFolder) file = await findLatestOtaCsv_(drive, srcFolder, "airbnb", yearMonth);
        if (file) {
          const text = await downloadDriveText_(drive, file.id);
          const a = sumAirbnbCsv(text, { listingName });
          patch.revenue.airbnb = {
            grossRevenue: a.grossRevenue, serviceFee: 0, netRevenue: a.grossRevenue,
            nights: a.nights, reservationCount: a.reservationCount,
            source: "ota_csv", sourceFileId: file.id, sourceFileName: file.name,
            parsedAt: FieldValue.serverTimestamp(),
          };
          nightsTotal += a.nights; gotAny = true;
          result.airbnb = { ...a, fileName: file.name };
        } else {
          result.skipped.push("airbnb(CSV見つからず)");
        }
      }

      // --- Booking ---
      const bookingEnabled = (yz.booking && yz.booking.enabled) || prop.bookingPropertyId || bookingFileId;
      if (overrides["revenue.booking"]) {
        result.skipped.push("booking(手動修正保護)");
      } else if (bookingEnabled) {
        let file = null;
        if (bookingFileId) file = { id: bookingFileId, name: `booking(${bookingFileId})` };
        else if (srcFolder) file = await findLatestOtaCsv_(drive, srcFolder, "booking", yearMonth);
        if (file) {
          const text = await downloadDriveText_(drive, file.id);
          const b = sumBookingCsv(text);
          patch.revenue.booking = {
            grossRevenue: b.grossRevenue, commission: b.commission, paymentFee: 0,
            netRevenue: b.netRevenue, reservationCount: b.reservationCount, nights: b.nights,
            source: "ota_csv", sourceFileId: file.id, sourceFileName: file.name,
            parsedAt: FieldValue.serverTimestamp(),
          };
          nightsTotal += b.nights; gotAny = true;
          result.booking = { ...b, fileName: file.name };
        } else {
          result.skipped.push("booking(CSV見つからず)");
        }
      }

      if (!gotAny) {
        return res.status(404).json({ error: "対象月のOTA CSVが見つかりませんでした", ...result });
      }
      // 泊数は手動上書きが無ければ CSV 合計で更新
      if (!overrides["nights"]) patch.nights = nightsTotal;
      await ref.set(patch, { merge: true });

      const categories = await loadCategories_();
      const after = (await ref.get()).data();
      res.json({ ok: true, ...result, computed: computePnl(after, categories) });
    } catch (e) {
      console.error("OTA CSV取込エラー:", e);
      res.status(500).json({ error: "OTA CSV取り込みに失敗しました: " + e.message });
    }
  });

  // ========================================================
  // 領収書PDF(修繕費/消耗品等)取込 → 月×費目に自動計上
  // ========================================================

  // ファイル名から費目名を推定(scope=receipts限定。utilities系や対象外はnull)。
  // 実体は pnl-logic の classifyExpenseByName_ に委譲 → scope フィルタで receipts のみ返す。
  function guessCategoryFromName_(name) {
    const c = classifyExpenseByName_(name);
    return c.scope === "receipts" ? c.category : null;
  }

  // ファイル名先頭の YYMMDD → "YYYY-MM"(20YY想定)。取れなければ null
  function ymFromName_(name) {
    const m = String(name).match(/(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    return `20${m[1]}-${m[2]}`;
  }

  // レシート/請求書PDFから税込金額を抽出(金額のみ。日付/費目はファイル名を使う)
  async function geminiExtractReceiptAmount_(pdfBase64, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const prompt = [
      "これは店舗のレシート/領収書、または公共料金・通信費の請求書/お知らせです。",
      "支払う税込金額(レシートなら「合計/お会計」、請求書なら「ご請求金額/請求額/合計/口座振替額」)を1つだけ抽出してください。カンマなし整数(円)。読めなければ0。",
      "isEstimate の判定は厳密に: 請求額・料金・口座振替額など『支払う金額』が明記されていれば、たとえ書類名が『お知らせ』でも確定した請求書とみなし isEstimate=false。",
      "isEstimate=true にするのは『請求予定額の事前通知』『検針票(使用量のみで請求額なし)』『概算・見積』など、まだ確定した請求でない場合だけ。",
      'JSONのみ出力: {"amount": 整数, "isEstimate": true/false, "store": "店名/事業者(あれば)", "confidence": 0-100}',
    ].join("\n");
    const payload = { contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }], generationConfig: { temperature: 0.1 } };
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error("Gemini API error: " + r.status);
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini応答にJSONがありません");
    return JSON.parse(m[0]);
  }

  // 指定フォルダ(+直下サブフォルダ1階層)から「経費レシート系」PDFを集める。
  // 対象: レシート/領収書/請求書/合計請求書 (「合計請求書(...ごみ処理...)」のような書類名も含む)
  // 除外: 光熱/通信/固定電話 の請求書(scope=utilities は import-utilities 側で処理される)
  //       通帳・配当・カード明細・契約金・届出などの費目対象外書類(scope=null)
  async function listReceiptPdfs_(drive, folderId) {
    const out = [];
    const rootRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType)", pageSize: 500, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const rootFiles = rootRes.data.files || [];
    // 名前パターン: レシート/領収書/請求書(合計請求書含む)/納品書。拡張子.pdf。
    const looksLikeExpense = (n) => /レシート|ﾚｼｰﾄ|領収書|領収証|請求書|納品書/.test(n) && /\.pdf$/i.test(n);
    // classify で scope==="receipts" のみ採用(光熱/通信の請求書は除外)
    const belongsToReceipts = (n) => classifyExpenseByName_(n).scope === "receipts";
    const pick = (f) => f.mimeType === "application/pdf" && looksLikeExpense(f.name) && belongsToReceipts(f.name);
    for (const f of rootFiles) if (pick(f)) out.push(f);
    const subs = rootFiles.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
    for (const sub of subs) {
      const r = await drive.files.list({
        q: `'${sub.id}' in parents and trashed=false and mimeType='application/pdf'`,
        fields: "files(id,name,mimeType)", pageSize: 500, supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      for (const f of (r.data.files || [])) if (pick(f)) out.push(f);
    }
    return out;
  }

  // POST /:propertyId/:yearMonth/import-receipts { folderId?, dryRun? }
  // 物件の領収書フォルダから対象月のレシートを集計し、費目(expenses)に自動計上する。
  // 手動上書き(overridden)済の費目はスキップ。冪等: 取込済fileIdを receiptsIndex に記録。
  router.post("/:propertyId/:yearMonth/import-receipts", router.cores.importReceipts = async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const { folderId, dryRun } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: "yearMonth は YYYY-MM 形式" });

      const propSnap = await db.collection("properties").doc(propertyId).get();
      if (!propSnap.exists) return res.status(404).json({ error: "物件が見つかりません" });
      const srcFolder = folderId || propSnap.data().driveReceiptsFolderId;
      if (!srcFolder) return res.status(400).json({ error: "領収書フォルダ(driveReceiptsFolderId)が未設定です" });

      const apiKey = await getGeminiApiKey_();
      if (!apiKey) return res.status(400).json({ error: "Gemini APIキー(settings/scanSorter)が未設定です" });

      const categories = await loadCategories_();
      const catByName = {};
      categories.forEach((c) => { catByName[(c.name || "").trim()] = c.id; });

      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const cur = await ref.get();
      const curData = cur.exists ? cur.data() : {};
      const overrides = curData.manualOverrides || {};
      const already = new Set((curData.receiptsIndex || []).map((r) => r.fileId));

      const drive = await resolveOtaDrive_();
      const all = await listReceiptPdfs_(drive, srcFolder);
      // 対象月のレシートに絞る(ファイル名の日付)
      const target = all.filter((f) => ymFromName_(f.name) === yearMonth);

      const items = [];
      const sumByCat = {}; // catId -> amount
      let processed = 0, skippedDup = 0, unmatchedCat = 0, errors = 0;

      for (const f of target) {
        if (already.has(f.id)) { skippedDup++; continue; }
        try {
          const bin = await drive.files.get({ fileId: f.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
          const parsed = await geminiExtractReceiptAmount_(Buffer.from(bin.data).toString("base64"), apiKey);
          const amount = Math.max(0, Math.round(Number(parsed.amount) || 0));
          const catName = guessCategoryFromName_(f.name) || "消耗品費";
          const catId = catByName[catName] || null;
          if (!catId) unmatchedCat++;
          else sumByCat[catId] = (sumByCat[catId] || 0) + amount;
          processed++;
          items.push({ fileId: f.id, fileName: f.name, link: driveLink_(f.id), amount, category: catName, catId, store: parsed.store || "" });
        } catch (e) {
          errors++;
          items.push({ fileId: f.id, fileName: f.name, error: e.message });
        }
      }

      if (dryRun) {
        return res.json({ dryRun: true, yearMonth, scanned: target.length, processed, skippedDup, unmatchedCat, errors, items, sumByCat });
      }

      // 費目へ加算反映(既存の当月値に足す。overridden 済はスキップ)。receiptsIndex に記録
      const expensesPatch = {};
      const applied = [];
      for (const [catId, add] of Object.entries(sumByCat)) {
        const existing = (curData.expenses && curData.expenses[catId]) || null;
        if (existing && existing.overridden) { applied.push({ catId, skipped: "手動上書き保護" }); continue; }
        // 既存額に「今回の新規レシート分のみ」を加算(処理済fileIdは receiptsIndex で除外済=二重計上しない)
        const newAmount = toInt(existing?.amount) + add;
        expensesPatch[catId] = { amount: newAmount, source: "receipts", overridden: false, note: "領収書自動計上", updatedAt: Date.now() };
        applied.push({ catId, amount: newAmount });
      }
      const patch = { propertyId, yearMonth, updatedAt: FieldValue.serverTimestamp() };
      if (Object.keys(expensesPatch).length) patch.expenses = expensesPatch;
      const newIndex = items.filter((it) => !it.error).map((it) => ({ fileId: it.fileId, fileName: it.fileName, amount: it.amount, catId: it.catId, ym: yearMonth }));
      if (newIndex.length) patch.receiptsIndex = FieldValue.arrayUnion(...newIndex);
      await ref.set(patch, { merge: true });

      const after = (await ref.get()).data();
      res.json({ ok: true, yearMonth, scanned: target.length, processed, skippedDup, unmatchedCat, errors, applied, items, computed: computePnl(after, categories) });
    } catch (e) {
      console.error("領収書取込エラー:", e);
      res.status(500).json({ error: "領収書の取込に失敗しました: " + e.message });
    }
  });

  // ========================================================
  // 光熱費・通信費(007_光熱・インフラ の請求書)取込 → 月×費目
  // ========================================================

  // 光熱/通信フォルダ名 → 費目名(番号は物件でバラバラなので名前で判定)
  function mapUtilityCategory_(folderName) {
    const n = String(folderName || "");
    if (/ガス|電気|水道/.test(n)) return "水道光熱費";
    if (/固定電話/.test(n)) return "固定電話";
    if (/インターネット|wi-?fi|ネット|通信|電話/i.test(n)) return "Wi-Fi・通信費";
    return null;
  }

  // 請求書ファイル名から対象年月(複数可)を推定 → "YYYY-MM"配列
  // 例: "260521 …5月分"→[2026-05] / "260611 …4-6月分"→[2026-04,05,06] / 月分表記無し→ファイル名日付の月
  function parseBillMonths_(name) {
    const m6 = String(name).match(/(\d{2})(\d{2})(\d{2})/);
    const fy = m6 ? 2000 + Number(m6[1]) : null;
    const fm = m6 ? Number(m6[2]) : null;
    const ym = (y, mo) => `${y}-${String(mo).padStart(2, "0")}`;
    const rg = String(name).match(/(\d{1,2})\s*[-~〜]\s*(\d{1,2})\s*月分/);
    if (rg && fy) {
      const s = Number(rg[1]), e = Number(rg[2]);
      if (e >= s && e - s <= 6) { const out = []; for (let mo = s; mo <= e; mo++) out.push(ym(fy, mo)); return out; }
    }
    const sg = String(name).match(/(\d{1,2})\s*月分/);
    if (sg && fy) { const mo = Number(sg[1]); return [ym(mo > fm ? fy - 1 : fy, mo)]; } // 記載月>ファイル月なら前年扱い
    if (fy) return [ym(fy, fm)];
    return [];
  }

  // POST /:propertyId/:yearMonth/import-utilities { folderId?, dryRun? }
  // 物件の 007_光熱・インフラ 配下(ガス/電気/水道/ネット/固定電話)の請求書から、
  // 対象月の光熱費・通信費を費目に自動計上する。範囲月(4-6月分等)は月割。
  router.post("/:propertyId/:yearMonth/import-utilities", router.cores.importUtilities = async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const { folderId, dryRun } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: "yearMonth は YYYY-MM 形式" });

      const propSnap = await db.collection("properties").doc(propertyId).get();
      if (!propSnap.exists) return res.status(404).json({ error: "物件が見つかりません" });
      const srcFolder = folderId || propSnap.data().driveUtilitiesFolderId;
      if (!srcFolder) return res.status(400).json({ error: "光熱インフラフォルダ(driveUtilitiesFolderId)が未設定です" });

      const apiKey = await getGeminiApiKey_();
      if (!apiKey) return res.status(400).json({ error: "Gemini APIキー(settings/scanSorter)が未設定です" });

      const categories = await loadCategories_();
      const catByName = {}; categories.forEach((c) => { catByName[(c.name || "").trim()] = c.id; });

      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const cur = await ref.get();
      const curData = cur.exists ? cur.data() : {};
      const already = new Set((curData.utilitiesIndex || []).map((r) => `${r.fileId}|${r.ym}`));
      // 重複スキャン排除: 先頭の日付(YYMMDD)を除いた名前で照合(例「260507 …5月分…」と「260605 …5月分…」は同一請求)
      const normName = (n) => String(n || "").replace(/^[\s　]*\d{6}[\s　_-]*/, "").replace(/[\s　]+/g, "").toLowerCase();
      const seenNorm = new Set((curData.utilitiesIndex || [])
        .filter((r) => (r.ym || yearMonth) === yearMonth && r.fileName)
        .map((r) => normName(r.fileName)));

      const drive = await resolveOtaDrive_();
      // 007配下のサブフォルダ(ガス/電気/水道/ネット/電話)を費目にマップ
      const subs = (await drive.files.list({
        q: `'${srcFolder}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`,
        fields: "files(id,name)", pageSize: 50, supportsAllDrives: true, includeItemsFromAllDrives: true,
      })).data.files || [];

      const items = [];
      const sumByCat = {};
      const keptByNorm = {}; // normName → 採用した明細(重複時の比較用)
      const dups = [];       // 除外した重複(捨てず記録。出典で表示・金額差は要確認)
      let processed = 0, skippedDup = 0, errors = 0, unmatchedCat = 0;

      for (const sub of subs) {
        const catName = mapUtilityCategory_(sub.name);
        if (!catName) { unmatchedCat++; continue; }
        const catId = catByName[catName] || null;
        const pdfs = ((await drive.files.list({
          q: `'${sub.id}' in parents and trashed=false and mimeType='application/pdf'`,
          fields: "files(id,name)", pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
        })).data.files || []).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))); // 日付(YYMMDD)昇順=重複時は早い方を残す
        for (const f of pdfs) {
          const months = parseBillMonths_(f.name);
          if (!months.includes(yearMonth)) continue; // 対象月に該当しない
          if (already.has(`${f.id}|${yearMonth}`)) { skippedDup++; continue; }
          const nn = normName(f.name);
          const isDup = seenNorm.has(nn);
          try {
            const bin = await drive.files.get({ fileId: f.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
            const parsed = await geminiExtractReceiptAmount_(Buffer.from(bin.data).toString("base64"), apiKey);
            // 事前通知・見積・検針のみ(確定した支払書類でない)は計上しない
            if (parsed.isEstimate === true) { items.push({ fileId: f.id, fileName: f.name, category: catName, skipped: "事前通知/見積" }); continue; }
            const full = Math.max(0, Math.round(Number(parsed.amount) || 0));
            if (isDup) {
              // 同一請求の重複(日付違いの同名)。採用済との金額差が大きければ要確認(訂正版の可能性)
              const kept = keptByNorm[nn] || {};
              const diff = Math.abs(full - (kept.amount || 0));
              const needsReview = diff > Math.max(100, (kept.amount || 0) * 0.02);
              skippedDup++;
              const dup = { fileId: f.id, fileName: f.name, link: driveLink_(f.id), category: catName, catId, amount: full,
                keptFileName: kept.fileName || "", keptAmount: kept.amount || 0, needsReview };
              dups.push(dup);
              items.push({ ...dup, skipped: needsReview ? "重複除外(⚠️金額差あり・要確認)" : "重複除外" });
              continue;
            }
            seenNorm.add(nn);
            const share = Math.round(full / months.length); // 範囲月は月割
            if (catId) sumByCat[catId] = (sumByCat[catId] || 0) + share;
            keptByNorm[nn] = { fileName: f.name, amount: full, fileId: f.id, link: driveLink_(f.id) };
            processed++;
            items.push({ fileId: f.id, fileName: f.name, link: driveLink_(f.id), category: catName, catId, fullAmount: full, monthShare: share, months });
          } catch (e) {
            errors++;
            items.push({ fileId: f.id, fileName: f.name, error: e.message });
          }
        }
      }

      if (dryRun) return res.json({ dryRun: true, yearMonth, processed, skippedDup, errors, items, sumByCat });

      const applied = [];
      const expensesPatch = {};
      for (const [catId, add] of Object.entries(sumByCat)) {
        const existing = (curData.expenses && curData.expenses[catId]) || null;
        if (existing && existing.overridden) { applied.push({ catId, skipped: "手動上書き保護" }); continue; }
        const newAmount = toInt(existing?.amount) + add;
        expensesPatch[catId] = { amount: newAmount, source: "utilities", overridden: false, note: "光熱・通信 自動計上", updatedAt: Date.now() };
        applied.push({ catId, amount: newAmount });
      }
      const patch = { propertyId, yearMonth, updatedAt: FieldValue.serverTimestamp() };
      if (Object.keys(expensesPatch).length) patch.expenses = expensesPatch;
      const newIndex = items.filter((it) => !it.error && !it.skipped).map((it) => ({ fileId: it.fileId, fileName: it.fileName, ym: yearMonth, amount: it.monthShare, catId: it.catId }));
      if (newIndex.length) patch.utilitiesIndex = FieldValue.arrayUnion(...newIndex);
      // 除外した重複を出典表示用に保存(捨てない。どちらを採用/除外したか確認可能)
      if (dups.length) patch.utilitiesDuplicates = FieldValue.arrayUnion(...dups.map((d) => ({ ...d, ym: yearMonth })));
      await ref.set(patch, { merge: true });

      const after = (await ref.get()).data();
      res.json({ ok: true, yearMonth, processed, skippedDup, errors, unmatchedCat, applied, items, computed: computePnl(after, categories) });
    } catch (e) {
      console.error("光熱費取込エラー:", e);
      res.status(500).json({ error: "光熱費・通信費の取込に失敗しました: " + e.message });
    }
  });

  // ========================================================
  // 清掃費取込 → アプリ生成の清掃スタッフ請求書(invoices)から cleaningCosts へ
  // ========================================================

  // POST /:propertyId/:yearMonth/import-cleaning
  // invoices(propertyId,yearMonth) を集計して cleaningCosts に反映。
  // 同一スタッフ×月は最上位ステータス(paid>confirmed>submitted)を採用(下書き重複防止)。draftは除外。
  router.post("/:propertyId/:yearMonth/import-cleaning", router.cores.importCleaning = async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: "yearMonth は YYYY-MM 形式" });

      const invSnap = await db.collection("invoices").where("propertyId", "==", propertyId).get();
      const rank = { paid: 4, confirmed: 3, submitted: 2, draft: 1 };
      const pick = {}; // key(staffId|staffName) -> invoice
      invSnap.forEach((d) => {
        const inv = { id: d.id, ...d.data() };
        if (inv.yearMonth !== yearMonth) return;
        if ((inv.status || "") === "draft") return;
        if (inv.voided === true) return; // 取消済み(無効化)請求は計上しない
        const key = inv.staffId || inv.staffName || d.id;
        const cur = pick[key];
        const r = rank[inv.status] || 0;
        if (!cur || r > (rank[cur.status] || 0) || (r === (rank[cur.status] || 0) && toInt(inv.total) > toInt(cur.total))) pick[key] = inv;
      });
      const chosen = Object.values(pick);
      const chosenIds = new Set(chosen.map((i) => i.id));

      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const cur = await ref.get();
      let costs = (cur.exists && Array.isArray(cur.data().cleaningCosts)) ? cur.data().cleaningCosts.slice() : [];
      // 取消済み/消滅した請求(invoice由来)の既存行を除去(手動追加行 source≠invoice は保持)
      const removedRows = costs.filter((c) => c.source === "invoice" && !chosenIds.has(c.sourceInvoiceId)).length;
      costs = costs.filter((c) => c.source !== "invoice" || chosenIds.has(c.sourceInvoiceId));
      let added = 0, updated = 0;
      for (const inv of chosen) {
        const idx = costs.findIndex((c) => c.source === "invoice" && c.sourceInvoiceId === inv.id);
        const row = {
          id: idx >= 0 ? costs[idx].id : crypto.randomUUID(),
          source: "invoice",
          staffName: inv.staffName || "",
          staffNameRaw: inv.staffName || "",
          amount: cleaningAmountForProperty(inv, propertyId),
          count: null,
          excluded: idx >= 0 ? !!costs[idx].excluded : false, // 既存の除外状態は保持
          sourceInvoiceId: inv.id,
          sourceFileId: null,
          billingYearMonth: yearMonth,
          note: `請求書 ${inv.status || ""}`,
          updatedAt: Date.now(),
        };
        if (idx >= 0) { costs[idx] = { ...costs[idx], ...row }; updated++; }
        else { costs.push({ ...row, createdAt: Date.now() }); added++; }
      }
      await ref.set({ propertyId, yearMonth, cleaningCosts: costs, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      const categories = await loadCategories_();
      const after = (await ref.get()).data();
      res.json({ ok: true, yearMonth, invoices: chosen.length, added, updated, removed: removedRows,
        rows: chosen.map((i) => ({ staffName: i.staffName, amount: cleaningAmountForProperty(i, propertyId), status: i.status })),
        computed: computePnl(after, categories) });
    } catch (e) {
      console.error("清掃費取込エラー:", e);
      res.status(500).json({ error: "清掃費の取込に失敗しました: " + e.message });
    }
  });

  // ========================================================
  // 出典一覧(取込元ファイルのリンク・金額を確認)
  // ========================================================

  // GET /:propertyId/:yearMonth/sources — 取込元(CSV/PDF/請求書)を金額・リンク付きで返す
  router.get("/:propertyId/:yearMonth/sources", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const doc = await pnlCol.doc(docId_(propertyId, yearMonth)).get();
      if (!doc.exists) return res.json({ propertyId, yearMonth, revenue: [], tax: null, expenses: [], cleaning: [] });
      const d = doc.data();
      const cats = await loadCategories_();
      const catName = {}; cats.forEach((c) => { catName[c.id] = c.name; });

      // 売上(OTA CSV)
      const revenue = [];
      const ab = d.revenue?.airbnb, bk = d.revenue?.booking;
      if (ab && ab.sourceFileId) revenue.push({ label: "Airbnb 予約CSV", fileName: ab.sourceFileName || "", link: driveLink_(ab.sourceFileId), amount: ab.grossRevenue || 0, count: ab.reservationCount || 0 });
      if (bk && bk.sourceFileId) revenue.push({ label: "Booking.com 予約CSV", fileName: bk.sourceFileName || "", link: driveLink_(bk.sourceFileId), amount: bk.grossRevenue || 0, count: bk.reservationCount || 0 });

      // 宿泊税(やどぜい申告書)
      const tax = (d.taxWithholding != null) ? {
        amount: d.taxWithholding || 0,
        fileName: d.taxWithholdingSource || "",
        link: driveLink_(d.taxWithholdingFileId),
      } : null;

      // 経費(領収書 + 光熱費)= 費目別の取込元1件ずつ
      const expenses = [];
      for (const it of (d.receiptsIndex || [])) {
        if (it.ym && it.ym !== yearMonth) continue;
        expenses.push({ kind: "領収書", category: catName[it.catId] || "", fileName: it.fileName || "", link: driveLink_(it.fileId), amount: it.amount || 0 });
      }
      for (const it of (d.utilitiesIndex || [])) {
        if (it.ym && it.ym !== yearMonth) continue;
        expenses.push({ kind: "光熱・通信", category: catName[it.catId] || "", fileName: it.fileName || "", link: driveLink_(it.fileId), amount: it.amount || 0 });
      }
      // 除外した重複(捨てず表示。金額差があれば要確認)
      const duplicates = (d.utilitiesDuplicates || [])
        .filter((x) => !x.ym || x.ym === yearMonth)
        .map((x) => ({ category: catName[x.catId] || "", fileName: x.fileName || "", link: x.link || driveLink_(x.fileId), amount: x.amount || 0,
          keptFileName: x.keptFileName || "", keptAmount: x.keptAmount || 0, needsReview: !!x.needsReview }));

      // 清掃費(アプリ生成請求書)。invoice に Drive/保存リンクがあれば付与
      const cleaning = [];
      const invRows = (d.cleaningCosts || []).filter((c) => c.source === "invoice" && c.sourceInvoiceId);
      for (const c of invRows) {
        let link = null;
        try {
          const inv = await db.collection("invoices").doc(c.sourceInvoiceId).get();
          if (inv.exists) { const iv = inv.data(); link = driveLink_(iv.driveFileId) || iv.driveLink || null; }
        } catch (_) {}
        cleaning.push({ staffName: c.staffName || "", amount: c.amount || 0, excluded: !!c.excluded, invoiceId: c.sourceInvoiceId, link });
      }

      res.json({ propertyId, yearMonth, revenue, tax, expenses, cleaning, duplicates });
    } catch (e) {
      console.error("出典取得エラー:", e);
      res.status(500).json({ error: "出典の取得に失敗しました: " + e.message });
    }
  });

  // 月次自動取込バッチを手動実行(指定月 or 前月)。全取込＋帳票下書きを生成
  router.post("/run-monthly-import", async (req, res) => {
    try {
      const mod = require("../scheduled/pnlMonthlyImport"); // 遅延require(循環回避)
      const ym = req.body && /^\d{4}-\d{2}$/.test(req.body.yearMonth || "") ? req.body.yearMonth : mod.prevYearMonthJst(new Date());
      const out = await mod.run(db, ym);
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error("月次取込バッチ手動実行エラー:", e);
      res.status(500).json({ error: "バッチ実行に失敗しました: " + e.message });
    }
  });

  // パース結果を月ドキュメントへ反映(手動編集を上書きしない)
  async function applyParsedToPnl_({ parsed, propertyId, yearMonth, fileId }) {
    const ref = pnlCol.doc(docId_(propertyId, yearMonth));
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : null;
    const overrides = (data && data.manualOverrides) || {};
    const base = {
      propertyId, yearMonth,
      updatedAt: FieldValue.serverTimestamp(),
      lastDriveSyncAt: FieldValue.serverTimestamp(),
    };

    if (parsed.docKind === "airbnb_monthly" && parsed.airbnb) {
      if (overrides["revenue.airbnb"]) return; // 手動保護
      const a = parsed.airbnb;
      const existing = (data && data.revenue && data.revenue.airbnb) || {};
      const srcIds = new Set(existing.sourceFileIds || []);
      srcIds.add(fileId);
      // set(merge) はドット記法キーをネストパスにしない(リテラル field 化)ため必ずネストで書く
      base.revenue = {
        airbnb: {
          grossRevenue: toInt(a.grossRevenue),
          serviceFee: toInt(a.serviceFee),
          withholdingTax: toInt(a.withholdingTax),
          netRevenue: toInt(a.netRevenue),
          nights: toInt(a.nights),
          avgStayDays: Number(a.avgStayDays) || 0,
          sourceFileIds: Array.from(srcIds),
          parsedAt: FieldValue.serverTimestamp(),
        },
      };
      await ref.set(base, { merge: true });
      return;
    }

    if (parsed.docKind === "booking_detail" && parsed.booking) {
      if (overrides["revenue.booking"]) return; // 手動保護
      const reservations = parsed.booking.reservations || [];
      // 予約明細を upsert
      let gross = 0, commission = 0, paymentFee = 0, net = 0, count = 0;
      const batch = db.batch();
      for (const r of reservations) {
        const key = r.reservationNumber
          ? String(r.reservationNumber)
          : crypto.createHash("md5").update(`${r.checkIn}|${r.checkOut}|${r.guestName}|${r.amount}`).digest("hex");
        const drow = {
          reservationNumber: r.reservationNumber ? String(r.reservationNumber) : "",
          checkIn: r.checkIn || "", checkOut: r.checkOut || "",
          guestName: r.guestName || "",
          amount: toInt(r.amount), commission: toInt(r.commission),
          paymentFee: toInt(r.paymentFee), netRevenue: toInt(r.netRevenue),
          sourceFileId: fileId, parsedAt: FieldValue.serverTimestamp(),
        };
        batch.set(ref.collection("bookingDetails").doc(key), drow, { merge: true });
        gross += drow.amount; commission += drow.commission;
        paymentFee += drow.paymentFee; net += drow.netRevenue; count++;
      }
      // 月サマリーは「その月の全明細」を再集計して整合させる
      const existingDetails = await ref.collection("bookingDetails").get();
      let gAll = gross, cAll = commission, pAll = paymentFee, nAll = net, cntAll = count;
      const newKeys = new Set(reservations.map((r) => r.reservationNumber ? String(r.reservationNumber)
        : crypto.createHash("md5").update(`${r.checkIn}|${r.checkOut}|${r.guestName}|${r.amount}`).digest("hex")));
      existingDetails.docs.forEach((d) => {
        if (newKeys.has(d.id)) return; // 今回分は上で計上済み
        const x = d.data();
        gAll += toInt(x.amount); cAll += toInt(x.commission);
        pAll += toInt(x.paymentFee); nAll += toInt(x.netRevenue); cntAll++;
      });
      const existing = (data && data.revenue && data.revenue.booking) || {};
      const srcIds = new Set(existing.sourceFileIds || []);
      srcIds.add(fileId);
      base.revenue = {
        booking: {
          grossRevenue: gAll, commission: cAll, paymentFee: pAll, netRevenue: nAll,
          reservationCount: cntAll, sourceFileIds: Array.from(srcIds),
          parsedAt: FieldValue.serverTimestamp(),
        },
      };
      batch.set(ref, base, { merge: true });
      await batch.commit();
      return;
    }

    if (parsed.docKind === "booking_invoice" && parsed.bookingInvoice) {
      if (overrides["revenue.booking"]) return; // 手動保護
      const bi = parsed.bookingInvoice;
      const existing = (data && data.revenue && data.revenue.booking) || {};
      // CSV由来の売上/コミッションは保持し、決済手数料を補完する(予約CSVに列が無く取れないため請求書から)。
      const gross = toInt(existing.grossRevenue) || toInt(bi.grossRevenue);
      const commission = toInt(existing.commission) || toInt(bi.commission);
      const paymentFee = toInt(bi.paymentFee);
      const srcIds = new Set(existing.sourceFileIds || []);
      srcIds.add(fileId);
      base.revenue = {
        booking: {
          ...existing,
          grossRevenue: gross,
          commission,
          paymentFee,
          netRevenue: gross - commission - paymentFee, // Booking送金時に手数料も差引く実手取り
          paymentFeeSourceId: fileId,
          sourceFileIds: Array.from(srcIds),
          parsedAt: FieldValue.serverTimestamp(),
        },
      };
      await ref.set(base, { merge: true });
      return;
    }

    if (parsed.docKind === "cleaning_invoice" && parsed.cleaning) {
      const c = parsed.cleaning;
      const costs = (data && Array.isArray(data.cleaningCosts)) ? data.cleaningCosts.slice() : [];
      const idx = costs.findIndex((x) => x.source === "drive" && x.sourceFileId === fileId);
      const row = {
        id: idx >= 0 ? costs[idx].id : crypto.randomUUID(),
        source: "drive",
        staffName: normalizeStaffName(c.staffName),
        staffNameRaw: c.staffName || "",
        amount: toInt(c.totalAmount),
        count: toInt(c.count) || null,
        excluded: idx >= 0 ? !!costs[idx].excluded : false, // 既存の除外状態は保持
        sourceFileId: fileId,
        billingYearMonth: c.billingYearMonth || yearMonth,
        note: "",
        updatedAt: Date.now(),
      };
      if (idx >= 0) costs[idx] = { ...costs[idx], ...row };
      else costs.push({ ...row, createdAt: Date.now() });
      base.cleaningCosts = costs;
      await ref.set(base, { merge: true });
      return;
    }
  }

  // ========================================================
  // 手動編集
  // ========================================================

  // 売上手修正 + manualOverrides
  router.patch("/:propertyId/:yearMonth", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const { revenue, nights, cleaningCount, protect } = req.body || {};
      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      // set(merge) はドット記法キーをネストパスにしないため、revenue/manualOverrides はネストで組む
      // (manualOverrides のキーは "revenue.airbnb" のようなドット入り文字列を"リテラルなmapキー"として保持)
      const update = { propertyId, yearMonth, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user.email || "" };
      const overrideKeys = {};
      if (revenue && revenue.airbnb) {
        update.revenue = { ...(update.revenue || {}), airbnb: { ...revenue.airbnb } };
        overrideKeys["revenue.airbnb"] = true; // 手修正→自動上書き禁止
      }
      if (revenue && revenue.booking) {
        update.revenue = { ...(update.revenue || {}), booking: { ...revenue.booking } };
        overrideKeys["revenue.booking"] = true;
      }
      if (protect && typeof protect === "object") {
        for (const k of Object.keys(protect)) overrideKeys[k] = !!protect[k];
      }
      if (Object.keys(overrideKeys).length) update.manualOverrides = overrideKeys;
      if (typeof nights === "number") update.nights = nights;
      if (typeof cleaningCount === "number") update.cleaningCount = cleaningCount;
      await ref.set(update, { merge: true });
      res.json({ ok: true });
    } catch (e) {
      console.error("収支手修正エラー:", e);
      res.status(500).json({ error: "更新に失敗しました" });
    }
  });

  // 清掃費 手動行追加
  router.post("/:propertyId/:yearMonth/cleaning", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const { staffName, amount, count, note } = req.body || {};
      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const row = {
        id: crypto.randomUUID(), source: "manual",
        staffName: staffName || "", staffNameRaw: staffName || "",
        amount: toInt(amount), count: count != null ? toInt(count) : null,
        excluded: false, sourceFileId: null, billingYearMonth: yearMonth,
        note: note || "", createdAt: Date.now(), updatedAt: Date.now(),
      };
      await ref.set({ propertyId, yearMonth, cleaningCosts: FieldValue.arrayUnion(row),
        updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      res.json({ ok: true, row });
    } catch (e) {
      console.error("清掃費追加エラー:", e);
      res.status(500).json({ error: "清掃費の追加に失敗しました" });
    }
  });

  // 清掃費 行編集(除外トグル/金額)
  router.patch("/:propertyId/:yearMonth/cleaning/:rowId", async (req, res) => {
    try {
      const { propertyId, yearMonth, rowId } = req.params;
      const { excluded, amount, staffName, note } = req.body || {};
      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: "対象月が存在しません" });
      const costs = (doc.data().cleaningCosts || []).map((c) => {
        if (c.id !== rowId) return c;
        const n = { ...c, updatedAt: Date.now() };
        if (typeof excluded === "boolean") n.excluded = excluded;
        if (amount != null) n.amount = toInt(amount);
        if (staffName != null) n.staffName = staffName;
        if (note != null) n.note = note;
        return n;
      });
      await ref.update({ cleaningCosts: costs, updatedAt: FieldValue.serverTimestamp() });
      res.json({ ok: true });
    } catch (e) {
      console.error("清掃費編集エラー:", e);
      res.status(500).json({ error: "清掃費の編集に失敗しました" });
    }
  });

  // 清掃費 行削除(手動行のみ。drive行は除外推奨)
  router.delete("/:propertyId/:yearMonth/cleaning/:rowId", async (req, res) => {
    try {
      const { propertyId, yearMonth, rowId } = req.params;
      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: "対象月が存在しません" });
      const costs = (doc.data().cleaningCosts || []).filter((c) => c.id !== rowId);
      await ref.update({ cleaningCosts: costs, updatedAt: FieldValue.serverTimestamp() });
      res.json({ ok: true });
    } catch (e) {
      console.error("清掃費削除エラー:", e);
      res.status(500).json({ error: "清掃費の削除に失敗しました" });
    }
  });

  // 費目の当月実績値(手入力)
  router.put("/:propertyId/:yearMonth/expense/:catId", async (req, res) => {
    try {
      const { propertyId, yearMonth, catId } = req.params;
      const { amount, note } = req.body || {};
      const ref = pnlCol.doc(docId_(propertyId, yearMonth));
      const catDoc = await catCol.doc(catId).get();
      const catType = catDoc.exists ? catDoc.data().type : "manual";
      const entry = {
        amount: toInt(amount),
        source: catType,
        overridden: true, // 当月値を明示設定したらマスタ変更を波及させない
        note: note || "",
        updatedAt: Date.now(),
      };
      await ref.set({ propertyId, yearMonth, expenses: { [catId]: entry },
        updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      res.json({ ok: true });
    } catch (e) {
      console.error("費目更新エラー:", e);
      res.status(500).json({ error: "費目の更新に失敗しました" });
    }
  });

  // 再集計(nights/cleaningCount を bookings/shifts から)
  router.post("/recalc/:propertyId/:yearMonth", async (req, res) => {
    try {
      const { propertyId, yearMonth } = req.params;
      const [y, m] = yearMonth.split("-").map(Number);
      const monthStart = `${yearMonth}-01`;
      const monthEnd = new Date(y, m, 1).toISOString().slice(0, 10);

      // 宿泊日数: 当月に重なる泊数を合算(キャンセル除外)
      const bkSnap = await db.collection("bookings").where("propertyId", "==", propertyId).get();
      let nights = 0;
      bkSnap.docs.forEach((d) => {
        const b = d.data();
        if (b.status === "cancelled") return;
        const ci = typeof b.checkIn === "string" ? b.checkIn : (b.checkIn && b.checkIn.toDate ? b.checkIn.toDate().toISOString().slice(0, 10) : null);
        const co = typeof b.checkOut === "string" ? b.checkOut : (b.checkOut && b.checkOut.toDate ? b.checkOut.toDate().toISOString().slice(0, 10) : null);
        if (!ci || !co) return;
        const ciD = new Date(ci), coD = new Date(co);
        const ms = new Date(y, m - 1, 1), me = new Date(y, m, 1);
        const os = ciD > ms ? ciD : ms, oe = coD < me ? coD : me;
        const n = Math.ceil((oe - os) / 86400000);
        if (n > 0) nights += n;
      });

      // 清掃回数: 当月の cleaning_by_count シフト
      const shSnap = await db.collection("shifts").where("propertyId", "==", propertyId).get();
      let cleaningCount = 0;
      shSnap.docs.forEach((d) => {
        const s = d.data();
        if (s.workType && s.workType !== "cleaning_by_count") return;
        const dt = s.date && s.date.toDate ? s.date.toDate().toISOString().slice(0, 10) : (typeof s.date === "string" ? s.date.slice(0, 10) : null);
        if (!dt) return;
        if (dt >= monthStart && dt < monthEnd) cleaningCount++;
      });

      await pnlCol.doc(docId_(propertyId, yearMonth)).set(
        { propertyId, yearMonth, nights, cleaningCount, updatedAt: FieldValue.serverTimestamp() },
        { merge: true });
      res.json({ ok: true, nights, cleaningCount });
    } catch (e) {
      console.error("再集計エラー:", e);
      res.status(500).json({ error: "再集計に失敗しました" });
    }
  });

  // ========================================================
  // 費目マスタ CRUD
  // ========================================================

  router.get("/expense-categories", async (req, res) => {
    try {
      const cats = await loadCategories_();
      res.json(cats);
    } catch (e) {
      res.status(500).json({ error: "費目の取得に失敗しました" });
    }
  });

  router.post("/expense-categories", async (req, res) => {
    try {
      const { name, type, defaultAmount, appliesTo, displayOrder } = req.body || {};
      if (!name || !type) return res.status(400).json({ error: "name と type は必須です" });
      if (type !== "fixed" && type !== "manual") return res.status(400).json({ error: "type は fixed か manual" });
      const ref = await catCol.add({
        name, type, defaultAmount: toInt(defaultAmount),
        appliesTo: appliesTo || "all", displayOrder: displayOrder || 0, active: true,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ ok: true, id: ref.id });
    } catch (e) {
      res.status(500).json({ error: "費目の追加に失敗しました" });
    }
  });

  // 推奨費目を一括作成(運営代行契約の費用負担区分ベース)。既存同名はスキップ(冪等)
  router.post("/expense-categories/seed-defaults", async (req, res) => {
    try {
      const DEFAULTS = [
        { name: "家賃", type: "fixed" },
        { name: "水道光熱費", type: "manual" },
        { name: "消耗品費", type: "manual" },
        { name: "リネン・クリーニング", type: "manual" },
        { name: "Wi-Fi・通信費", type: "fixed" },
        { name: "システム利用料", type: "fixed" },
        { name: "広告宣伝費", type: "manual" },
        { name: "小修繕費", type: "manual" },
        { name: "ゴミ処理費", type: "manual" },
        { name: "害虫駆除費", type: "manual" },
        { name: "固定電話", type: "fixed" },
      ];
      const existing = await catCol.get();
      const names = new Set(existing.docs.map((d) => (d.data().name || "").trim()));
      const created = [];
      let order = existing.size;
      for (const c of DEFAULTS) {
        if (names.has(c.name)) continue;
        const ref = await catCol.add({
          name: c.name, type: c.type, defaultAmount: 0,
          appliesTo: "all", displayOrder: ++order, active: true,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
        created.push({ id: ref.id, name: c.name });
      }
      res.json({ ok: true, created, skipped: DEFAULTS.length - created.length });
    } catch (e) {
      console.error("推奨費目作成エラー:", e);
      res.status(500).json({ error: "推奨費目の作成に失敗しました" });
    }
  });

  router.put("/expense-categories/:catId", async (req, res) => {
    try {
      const { catId } = req.params;
      const { name, type, defaultAmount, appliesTo, displayOrder, active } = req.body || {};
      const update = { updatedAt: FieldValue.serverTimestamp() };
      if (name != null) update.name = name;
      if (type != null) update.type = type;
      if (defaultAmount != null) update.defaultAmount = toInt(defaultAmount);
      if (appliesTo != null) update.appliesTo = appliesTo;
      if (displayOrder != null) update.displayOrder = displayOrder;
      if (active != null) update.active = !!active;
      await catCol.doc(catId).set(update, { merge: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "費目の更新に失敗しました" });
    }
  });

  router.delete("/expense-categories/:catId", async (req, res) => {
    try {
      // 過去月の値は残すため、論理削除(active=false)
      await catCol.doc(req.params.catId).set(
        { active: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "費目の削除に失敗しました" });
    }
  });

  return router;
};
