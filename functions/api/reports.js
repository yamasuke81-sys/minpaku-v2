/**
 * 定期報告 API
 * 住宅宿泊事業法14条 — 2ヶ月ごとの事業実績報告
 *
 * 集計の実体は reports-logic.js（純粋関数・テスト済み）に置く。
 * 民泊制度運営システムへ投入する値をサーバ側で作るのが目的で、
 * PC常駐ルーチンがブラウザ無しで叩けるようにしてある（gas- Bearer 認証）。
 *
 * 旧 `/aggregate` は誰からも呼ばれておらず、期限計算にも誤りがあったため
 * `/portal-report` に置き換えた（2026-08-10）。
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const {
  getReportPeriods,
  buildJissekiReport,
  toCsvRow,
  toPortalCsv,
} = require("./reports-logic");

// the Terrace 長浜。propertyId 未設定の旧データはこの物件とみなす
const TERRACE_PID = "tsZybhDMcPrxqgcRy7wp";
// the Terrace 専用の旧GASデータ（名簿に無い予約の補完に使う）
const MIGRATED_COLLECTION = "migrated_民泊メイン_フォームの回答_1";

module.exports = function reportsApi(db) {
  const router = Router();

  /** iCal同期で自動生成された仮名かどうか */
  function isPlaceholderName(name) {
    if (!name) return true;
    const n = String(name).trim().toLowerCase();
    return !n || n === "-" ||
      n.includes("airbnb") || n.includes("booking.com") ||
      n.includes("not available") || n.includes("closed") ||
      n.includes("予約") || n.includes("blocked");
  }

  /** Firestore の日付値を YYYY-MM-DD に正規化（先頭10文字ルール） */
  function toDateStr(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") {
      const d = v.toDate();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    const s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  function reportDocId(periodId, propertyId) {
    return propertyId ? `${periodId}__${propertyId}` : periodId;
  }

  /** 物件別レポートドキュメント。the Terrace は旧 bare ID からフォールバック */
  async function getReportDoc(periodId, propertyId) {
    const scoped = await db.collection("reports").doc(reportDocId(periodId, propertyId)).get();
    if (scoped.exists) return scoped.data();
    if (propertyId === TERRACE_PID) {
      const legacy = await db.collection("reports").doc(periodId).get();
      if (legacy.exists) return legacy.data();
    }
    return null;
  }

  /**
   * 報告対象の物件を返す。
   * 「届出番号が登録されている民泊新法の物件」＝報告義務がある物件。
   * 宿泊実績が0でも報告が必要なので、実績の有無では絞らない。
   */
  async function listReportableProperties(filterIds) {
    const [propSnap, ownerDoc] = await Promise.all([
      db.collection("properties").get(),
      db.collection("settings").doc("owner").get(),
    ]);
    const ownerData = ownerDoc.exists ? ownerDoc.data() : {};
    const numbers = ownerData.todokideNumbers || {};

    const out = [];
    for (const doc of propSnap.docs) {
      const p = doc.data();
      // 宿泊事業の物件だけを見る（賃貸物件などを除外）
      if (p.type !== "minpaku") continue;
      // 旅館業の物件は住宅宿泊事業法14条の定期報告の対象外
      if (p.businessLicense === "hotel_business") continue;
      if (filterIds && filterIds.length && !filterIds.includes(doc.id)) continue;
      let todokideNumber = numbers[doc.id] || "";
      if (!todokideNumber && doc.id === TERRACE_PID) todokideNumber = ownerData.todokideNumber || "";
      out.push({ propertyId: doc.id, name: p.name || "", todokideNumber: String(todokideNumber).trim() });
    }
    return out;
  }

  /**
   * 全物件分の予約明細を**コレクション1回読み**で集めて物件ごとに束ねる。
   * 物件ごとに guestRegistrations を読み直すと物件数だけフルスキャンが走るので必ずここでまとめる。
   */
  async function loadRowsByProperty(periodStart, periodEnd, needMigrated) {
    const guestSnap = await db.collection("guestRegistrations").get();

    // 物件ごとに 同一 CI|CO を1件へ寄せる。実名をプレースホルダ名より優先
    // （例: 同じ日程に iCal 由来の「Booking.com予約」ダミーが並ぶことがある）
    const dedup = new Map(); // propertyId → Map("CI|CO" → row)
    for (const doc of guestSnap.docs) {
      const g = doc.data();
      const ci = toDateStr(g.checkIn), co = toDateStr(g.checkOut);
      if (!ci || !co) continue;
      if (co < periodStart || ci > periodEnd) continue;
      // propertyId 未設定の旧データは the Terrace とみなす
      const pid = g.propertyId || TERRACE_PID;
      if (!dedup.has(pid)) dedup.set(pid, new Map());
      const m = dedup.get(pid);
      const key = `${ci}|${co}`;
      const ex = m.get(key);
      const row = {
        source: "guestRegistrations",
        guestName: g.guestName || "-",
        checkIn: ci, checkOut: co,
        guestCount: Number(g.guestCount) || 1,
        nationality: (g.nationality || "日本").toString().trim(),
        companions: Array.isArray(g.guests) ? g.guests : [],
      };
      if (!ex) m.set(key, row);
      else if (isPlaceholderName(ex.guestName) && !isPlaceholderName(row.guestName)) m.set(key, row);
    }

    const byProperty = new Map();
    for (const [pid, m] of dedup) byProperty.set(pid, Array.from(m.values()));

    // 名簿に無い予約を旧GASデータで補完（the Terrace のみ）
    if (needMigrated) {
      const rows = byProperty.get(TERRACE_PID) || [];
      const ciSet = new Set(rows.map((r) => r.checkIn));
      try {
        const mSnap = await db.collection(MIGRATED_COLLECTION).get();
        for (const doc of mSnap.docs) {
          const d = doc.data();
          const ci = toDateStr(d["チェックイン"] || d["チェックイン / Check-in"] || d.checkIn);
          const co = toDateStr(d["チェックアウト"] || d["チェックアウト / Check-out"] || d.checkOut);
          if (!ci || !co) continue;
          if (co < periodStart || ci > periodEnd) continue;
          if (ciSet.has(ci)) continue;
          rows.push({ source: "migrated", guestName: "-（名簿未登録）",
            checkIn: ci, checkOut: co, guestCount: 1, nationality: "日本", companions: [] });
          ciSet.add(ci);
        }
      } catch (e) { /* コレクションが無ければ無視 */ }
      byProperty.set(TERRACE_PID, rows);
    }
    return byProperty;
  }

  /** レポート専用の手動補正（キー = checkIn）を当てる */
  function applyOverrides(rows, overrides) {
    for (const r of rows) {
      const ov = overrides[r.checkIn];
      if (!ov) continue;
      if (ov.guestCount !== undefined) r.guestCount = Number(ov.guestCount) || 1;
      if (ov.nationality !== undefined) {
        r.nationality = String(ov.nationality).trim();
        r.companions = []; // 補正した国籍を全員に適用する
      }
      if (ov.guestName !== undefined) r.guestName = ov.guestName;
      r.overridden = true;
    }
    rows.sort((a, b) => a.checkIn.localeCompare(b.checkIn));
    return rows;
  }

  // === 報告期間一覧 ===
  router.get("/periods", async (req, res) => {
    try {
      const propertyId = req.query.propertyId || null;
      const periods = getReportPeriods(new Date().getFullYear());
      const recs = await Promise.all(periods.map((p) => getReportDoc(p.id, propertyId)));
      res.json(periods.map((p, i) => ({
        ...p,
        submitted: !!(recs[i] && recs[i].submittedAt),
        submittedAt: (recs[i] && recs[i].submittedAt) || null,
        memo: (recs[i] && recs[i].memo) || "",
      })));
    } catch (e) {
      console.error("報告期間一覧取得エラー:", e);
      res.status(500).json({ error: "報告期間の取得に失敗しました" });
    }
  });

  /**
   * === 民泊制度運営システムへ投入する報告データ ===
   * GET /reports/portal-report?periodId=2026-10[&propertyIds=a,b]
   *
   * 届出番号が登録されている民泊新法の全物件分をまとめて返す。
   * csv はそのままアップロードできる本文（保存時に **Shift_JIS・BOMなし** にすること）。
   */
  router.get("/portal-report", async (req, res) => {
    try {
      const periods = getReportPeriods(new Date().getFullYear());
      const periodId = req.query.periodId;
      const period = periodId
        ? periods.find((p) => p.id === periodId)
        : null;
      if (!period) {
        return res.status(400).json({
          error: "periodId が不正です",
          available: periods.map((p) => ({ id: p.id, label: p.label, deadline: p.deadline })),
        });
      }

      const filterIds = req.query.propertyIds
        ? String(req.query.propertyIds).split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      const props = await listReportableProperties(filterIds);
      const needMigrated = props.some((p) => p.propertyId === TERRACE_PID);
      const [rowsByProperty, reportDocs] = await Promise.all([
        loadRowsByProperty(period.periodStart, period.periodEnd, needMigrated),
        Promise.all(props.map((p) => getReportDoc(period.id, p.propertyId))),
      ]);

      const results = [];
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        const rec = reportDocs[i];
        const rows = applyOverrides(rowsByProperty.get(p.propertyId) || [], (rec && rec.overrides) || {});
        const submitted = !!(rec && rec.submittedAt);
        const report = buildJissekiReport(rows, period.periodStart, period.periodEnd);
        results.push({
          propertyId: p.propertyId,
          name: p.name,
          todokideNumber: p.todokideNumber,
          // 届出番号が無い＝まだ届出が受理されていない物件。報告対象から外す
          reportable: !!p.todokideNumber,
          submitted,
          ...report,
          csvRow: p.todokideNumber ? toCsvRow(p.todokideNumber, period.portalLabel, report) : null,
        });
      }

      const csvRows = results.filter((r) => r.csvRow).map((r) => r.csvRow);
      res.json({
        period: {
          id: period.id, label: period.label, portalLabel: period.portalLabel,
          periodStart: period.periodStart, periodEnd: period.periodEnd, deadline: period.deadline,
        },
        properties: results,
        skipped: results.filter((r) => !r.reportable).map((r) => ({ propertyId: r.propertyId, name: r.name, reason: "届出番号が未登録" })),
        csv: csvRows.length ? toPortalCsv(csvRows) : null,
      });
    } catch (e) {
      console.error("定期報告データ生成エラー:", e);
      res.status(500).json({ error: "定期報告データの生成に失敗しました" });
    }
  });

  // === 報告済みとして記録 ===
  router.post("/submit", async (req, res) => {
    try {
      const { periodId, propertyId, memo, portalResult } = req.body;
      if (!periodId) return res.status(400).json({ error: "periodId は必須です" });

      await db.collection("reports").doc(reportDocId(periodId, propertyId)).set({
        periodId,
        propertyId: propertyId || null,
        submittedAt: FieldValue.serverTimestamp(),
        submittedBy: req.user.email || req.user.uid,
        memo: memo || "",
        portalResult: portalResult || null, // 「正常件数：N」等の登録結果を証跡として残す
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      res.json({ message: "報告済みとして記録しました", periodId, propertyId: propertyId || null });
    } catch (e) {
      console.error("報告記録エラー:", e);
      res.status(500).json({ error: "報告記録に失敗しました" });
    }
  });

  // === 報告済みを取消 ===
  router.post("/unsubmit", async (req, res) => {
    try {
      const { periodId, propertyId } = req.body;
      if (!periodId) return res.status(400).json({ error: "periodId は必須です" });

      await db.collection("reports").doc(reportDocId(periodId, propertyId)).set({
        periodId,
        submittedAt: null,
        submittedBy: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      res.json({ message: "報告済みを取消しました", periodId });
    } catch (e) {
      console.error("報告取消エラー:", e);
      res.status(500).json({ error: "報告取消に失敗しました" });
    }
  });

  return router;
};
