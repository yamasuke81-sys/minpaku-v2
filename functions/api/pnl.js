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
} = require("./pnl-logic");

// OTA原本フォルダ(既定の取込元。settings/pnlImport.sourceFolderId で上書き可)
const DEFAULT_SOURCE_FOLDER_ID = "10N_wTI-cftdJvVxYGXftXJoxNpsRDRux";

module.exports = function pnlApi(db) {
  const router = Router();
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
      "- cleaning_invoice : 清掃スタッフ個人や清掃業者からの『請求書』(請求対象年月と合計金額がある)。",
      "- other : 上記以外。",
      "",
      "## 出力JSON:",
      "{",
      '  "docKind": "airbnb_monthly|booking_detail|cleaning_invoice|other",',
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
      let q = pnlCol.where("propertyId", "==", propertyId);
      const snap = await q.get();
      let months = snap.docs.map((d) => d.data())
        .filter((d) => (!from || d.yearMonth >= from) && (!to || d.yearMonth <= to))
        .sort((a, b) => (a.yearMonth < b.yearMonth ? -1 : 1));
      const result = months.map((d) => ({
        yearMonth: d.yearMonth,
        nights: d.nights || 0,
        cleaningCount: d.cleaningCount || 0,
        ...computePnl(d, categories),
      }));
      res.json({ propertyId, months: result, categories: categories.filter((c) => c.active !== false) });
    } catch (e) {
      console.error("収支サマリー取得エラー:", e);
      res.status(500).json({ error: "収支サマリーの取得に失敗しました" });
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
      base["revenue.airbnb"] = {
        grossRevenue: toInt(a.grossRevenue),
        serviceFee: toInt(a.serviceFee),
        withholdingTax: toInt(a.withholdingTax),
        netRevenue: toInt(a.netRevenue),
        nights: toInt(a.nights),
        avgStayDays: Number(a.avgStayDays) || 0,
        sourceFileIds: Array.from(srcIds),
        parsedAt: FieldValue.serverTimestamp(),
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
      base["revenue.booking"] = {
        grossRevenue: gAll, commission: cAll, paymentFee: pAll, netRevenue: nAll,
        reservationCount: cntAll, sourceFileIds: Array.from(srcIds),
        parsedAt: FieldValue.serverTimestamp(),
      };
      batch.set(ref, base, { merge: true });
      await batch.commit();
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
      const update = { propertyId, yearMonth, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user.email || "" };
      if (revenue && revenue.airbnb) {
        update["revenue.airbnb"] = { ...revenue.airbnb };
        update["manualOverrides.revenue.airbnb"] = true; // 手修正→自動上書き禁止
      }
      if (revenue && revenue.booking) {
        update["revenue.booking"] = { ...revenue.booking };
        update["manualOverrides.revenue.booking"] = true;
      }
      if (protect && typeof protect === "object") {
        for (const k of Object.keys(protect)) update[`manualOverrides.${k}`] = !!protect[k];
      }
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
