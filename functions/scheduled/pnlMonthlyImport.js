/**
 * 月次収支 自動取込バッチ
 *
 * 前月分について、対象物件(driveOtaCsvFolderId 設定済)ごとに
 *   売上(OTA CSV) / 宿泊税 / 光熱費・通信費 / 領収書 / 清掃費 を自動取込し、
 *   月次業務報告書・精算書兼請求書の「下書きPDF」を生成する。
 *
 * - 冪等: 各取込は receiptsIndex/utilitiesIndex/sourceFileId 等で二重計上を防ぐため再実行可能。
 * - 取込は既存の API ハンドラ(router.cores)を fake req/res で呼び出す(ロジック二重化を避ける)。
 * - 対外送信はしない(下書き生成のみ)。結果は pnlBatchRuns に記録。
 */
const admin = require("firebase-admin");
const { resolveOperationMode } = require("../api/ota-csv-logic");

// API ハンドラを req/res 無しで呼ぶ
function invoke(handler, params, body) {
  return new Promise((resolve) => {
    let payload = null, code = 200;
    const res = {
      status(c) { code = c; return this; },
      json(j) { payload = j; resolve({ code, payload }); },
    };
    Promise.resolve(handler({ params, body: body || {}, query: {}, user: { role: "owner" } }, res))
      .catch((err) => resolve({ code: 500, payload: { error: err.message } }));
  });
}

// JST基準の前月 "YYYY-MM"
function prevYearMonthJst(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  let py = jst.getUTCFullYear(), pm = jst.getUTCMonth() - 1; // getUTCMonth:0-11、-1で前月
  if (pm < 0) { pm = 11; py -= 1; }
  return `${py}-${String(pm + 1).padStart(2, "0")}`;
}

// 対象月の全取込＋帳票下書き生成を実行して結果を返す
// opts.notify=true でオーナーに下書き完成を通知(スケジュール実行時)
async function run(db, yearMonth, opts = {}) {
  const pnl = require("../api/pnl")(db);
  const settlement = require("../api/settlement")(db);

  // 対象: pnlBatchEnabled=true の物件(開業済みの収支対象。宿小町/the Terrace 等)
  const snap = await db.collection("properties").where("pnlBatchEnabled", "==", true).get();
  const targets = snap.docs.map((d) => ({
    id: d.id, name: d.data().name || d.id,
    mode: resolveOperationMode(d.data()),
    pnlStartMonth: d.data().pnlStartMonth || null, // 開業月 "YYYY-MM"(これより前はスキップ)
  }));

  const results = [];
  for (const p of targets) {
    const params = { propertyId: p.id, yearMonth };
    const r = { propertyId: p.id, property: p.name, steps: {} };

    // 開業前月はスキップ(会計方針: 開業月以降のみ pnl 対象。2026-07-12 ユーザー確定)
    if (p.pnlStartMonth && yearMonth < p.pnlStartMonth) {
      r.skipped = `開業前(${p.pnlStartMonth}開業)のためスキップ`;
      results.push(r);
      continue;
    }

    try {
      const ota = await invoke(pnl.cores.importOtaCsv, params, {});
      r.steps.ota = ota.payload?.ok ? { 売上: ota.payload.computed?.revenueGross ?? null } : { error: ota.payload?.error || `HTTP${ota.code}` };
      // 売上取得の成否を明示フラグに(通知の警告判定に使う)
      r.otaFailed = !ota.payload?.ok;

      const tax = await invoke(settlement.cores.importTax, params, {});
      r.steps.tax = tax.payload?.ok ? { 宿泊税: tax.payload.taxWithholding } : { error: tax.payload?.error || `HTTP${tax.code}` };

      const util = await invoke(pnl.cores.importUtilities, params, {});
      r.steps.utilities = util.payload?.ok ? { 件数: util.payload.processed } : { error: util.payload?.error || `HTTP${util.code}` };

      // クレカ払い電気代(the Terrace エネパル等)。driveSaisonFolderId 未設定物件は 400 → skipped 表示
      const cc = await invoke(pnl.cores.importCreditCardElectric, params, {});
      r.steps.creditCardElectric = cc.payload?.ok
        ? (cc.payload.skipped ? { skipped: cc.payload.skipped } : { 計上額: cc.payload.adoptedTotal ?? 0, stmt: cc.payload.stmtYm })
        : { error: cc.payload?.error || `HTTP${cc.code}` };

      const rcpt = await invoke(pnl.cores.importReceipts, params, {});
      r.steps.receipts = rcpt.payload?.ok ? { 件数: rcpt.payload.processed } : { error: rcpt.payload?.error || `HTTP${rcpt.code}` };

      const clean = await invoke(pnl.cores.importCleaning, params, {});
      r.steps.cleaning = clean.payload?.ok ? { 請求書: clean.payload.invoices } : { error: clean.payload?.error || `HTTP${clean.code}` };

      // 売上取得に失敗した月は帳票下書きを生成しない(売上¥0の帳票が黙って送られる事故を防ぐ)。
      // 既存の pnl.revenue があれば売上は保持されるので、その場合は otaFailed でも生成してよい。
      // → computed.revenueGross が 0 かどうかで最終判定する。
      const revNow = ota.payload?.computed?.revenueGross;
      const revenueMissing = r.otaFailed && (revNow == null || revNow === 0);
      if (revenueMissing) {
        r.steps.report = { skipped: "売上未取得のため下書き生成せず(要人手対応)" };
        r.revenueMissing = true;
      } else {
        // 帳票下書き(報告書は全物件=内部用含む、精算書は八朔代行のみ。自社/その他会社は精算書を出さない)
        // storagePath も同時保存: 都度再署名で7日失効問題を根絶(署名URLは15分有効)
        const rep = await invoke(settlement.cores.generate, params, { kind: "report" });
        r.steps.report = rep.payload?.ok
          ? { url: rep.payload.url, storagePath: rep.payload.storagePath }
          : { error: rep.payload?.error || `HTTP${rep.code}` };
        if (p.mode === "agency_hassac") {
          const setl = await invoke(settlement.cores.generate, params, { kind: "settlement" });
          r.steps.settlement = setl.payload?.ok
            ? { url: setl.payload.url, storagePath: setl.payload.storagePath, 請求額: setl.payload.settlement?.feeInclTax }
            : { error: setl.payload?.error || `HTTP${setl.code}` };
        }
      }
    } catch (e) {
      r.error = e.message;
    }
    results.push(r);
  }

  const runId = `${yearMonth}_${admin.firestore.Timestamp.now().seconds}`;
  await db.collection("pnlBatchRuns").doc(runId).set({
    yearMonth, ranAt: admin.firestore.FieldValue.serverTimestamp(), count: results.length, results,
  });
  console.log(`[pnlMonthlyImport] ${yearMonth} 完了 ${results.length}物件`, JSON.stringify(results).slice(0, 800));

  // オーナーへ「下書き完成→承認」の通知(スケジュール実行時のみ)
  if (opts.notify) {
    try {
      const { notifyOwner } = require("../utils/lineNotify");
      const yen = (n) => (n != null ? "¥" + Number(n).toLocaleString("ja-JP") : "-");

      // 要対応判定: 売上未取得 or 帳票エラー or 実行例外 のいずれかがあれば警告
      const attention = results.filter((r) =>
        r.revenueMissing || r.error ||
        Object.values(r.steps || {}).some((v) => v && v.error && v !== (r.steps || {}).ota));
      // ↑ ota の error 単体は「CSV未取得だが既存revenueで帳票OK」のケースがあるので revenueMissing で別途拾う

      const blocks = results.map((r) => {
        if (r.skipped) return `【${r.property}】${r.skipped}`;
        const s = r.steps || {};
        const links = [];
        if (s.report && s.report.url) links.push(`　月次業務報告書: ${s.report.url}`);
        if (s.settlement && s.settlement.url) links.push(`　精算書兼請求書(税込${yen(s.settlement.請求額)}): ${s.settlement.url}`);
        const errs = Object.entries(s).filter(([, v]) => v && v.error).map(([k]) => k);
        const head = r.revenueMissing
          ? `【${r.property}】🚨売上未取得(下書き未生成・要人手対応)`
          : `【${r.property}】売上${yen(s.ota && s.ota.売上)}`;
        const warns = [];
        if (r.error) warns.push(`実行エラー: ${r.error}`);
        if (errs.length) warns.push(`未取得: ${errs.join("/")}`);
        return `${head}\n${links.join("\n") || "　（下書きなし）"}${warns.length ? `\n　⚠️${warns.join(" / ")}` : ""}`;
      }).join("\n\n");

      const approvalUrl = await resolveApprovalUrl_(db, runId);
      const banner = attention.length
        ? `🚨【要確認】${attention.length}物件で売上未取得/エラーがあります。承認前に必ず内容をご確認ください。\n\n`
        : "";
      const body = `📊 ${yearMonth}分 月次収支の下書きが完成しました。\n\n${banner}${blocks}\n\n▼承認ページ(内容確認→承認/却下)\n${approvalUrl}\n\n収支画面の「出典・内訳を確認」でも金額と出典を検算できます。`;
      await notifyOwner(db, "pnl_batch", `月次収支 下書き完成${attention.length ? "（要確認）" : ""}`, body);
    } catch (e) {
      console.warn("[pnlMonthlyImport] 通知失敗:", e.message);
    }
  }
  return { yearMonth, runId, results };
}

/** settings/notifications.appUrl を元に承認画面URLを組み立てる(LINE内蔵ブラウザ回避付き) */
async function resolveApprovalUrl_(db, runId) {
  let base = "https://v2-5-relay.web.app";
  try {
    const s = await db.collection("settings").doc("notifications").get();
    if (s.exists && s.data().appUrl) base = String(s.data().appUrl).replace(/\/+$/, "");
  } catch (_) { /* 既定を使う */ }
  return `${base}/pnl-approval.html?openExternalBrowser=1#runId=${encodeURIComponent(runId)}`;
}

// Cloud Scheduler 用ハンドラ(前月分・オーナー通知あり)
module.exports = async function pnlMonthlyImportScheduled() {
  const db = admin.firestore();
  return run(db, prevYearMonthJst(new Date()), { notify: true });
};
module.exports.run = run;
module.exports.prevYearMonthJst = prevYearMonthJst;
