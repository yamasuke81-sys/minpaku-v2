/**
 * OTAスナップショット完成 → 朝点検の補完再走 (2026-08-20 新設)
 *
 * 【直した問題】
 * Booking.com はオンデマンド運用で毎晩セッションが失効するため、PC常駐リスナーの
 * 2:30 calendar_audit は Booking を飛ばし status="partial" でスナップショットを保存する。
 * 朝の再ログイン(7:00ちょうど)で復帰するとリスナーが calendar_audit を強制再投入し、
 * 7:02 に status="done" で上書きする。ところが morningOtaAudit は 7:00:06 に partial を
 * 読み終えているため、Booking 予約の人数・氏名突合が毎日まるごと抜けていた。
 *   実測 2026-08-20: 朝点検 createdAt 07:00:06 / snapshotStatus=partial / 検出0件
 *                    スナップショット fetchedAt 07:02:20 / status=done / Booking 4件
 *   同型が 8/18・8/13 にも発生 (8/13 は朝点検が missing のまま終了)。
 *
 * 【直し方】
 * スナップショットが書かれるたびにこのトリガーが走り、「その日の朝点検はもう終わっているのに
 * 突合が不完全なまま」で、かつ「今はスナップショットが完全」なら morningOtaAudit を
 * mode="recheck" で呼び直す。再走は結果ドキュメントを完全な状態へ上書きし、
 * 通知は朝に出していない新規の指摘だけに絞る (同じ指摘の二重通知をしない)。
 *
 * 再入防止はトランザクションで recheckCount を先取りして行う (同時に2本走らせない)。
 * 判定そのものは純粋関数 shouldRecheckOtaAudit に委譲する (テスト可能にするため)。
 *
 * 朝点検の実行中(7:00:06〜07)にスナップショットが完成した場合はまだ結果ドキュメントが
 * 無く「audit_not_run_yet」でスキップされうるので、保険として otaAuditRecheck
 * (毎朝7:20 JST) が同じ判定をもう一度行う。
 */
const admin = require("firebase-admin");
const { nowJst } = require("../utils/dateUtils");
const { detectMissingOtaSources, shouldRecheckOtaAudit } = require("../api/ota-audit-logic");
const morningOtaAudit = require("../scheduled/morningOtaAudit");

// 1日あたりの補完再走の上限 (通常は1回。暴走時の保険)
const MAX_RECHECKS_PER_DAY = 3;

/**
 * 条件を満たしていれば朝点検を補完再走する。トリガーと保険スケジュールの共通本体。
 * @param {string} reason - ログ・通知に残す起動理由
 * @returns {Promise<{ran:boolean, reason:string}>}
 */
async function maybeRecheckOtaAudit(reason) {
  const db = admin.firestore();
  const { date: todayStr } = nowJst();

  const snapDoc = await db.collection("otaCalendarSnapshots").doc(todayStr).get();
  const snapshot = snapDoc.exists ? snapDoc.data() : null;

  // 物件マスタ由来の脱落検知 (status=done でも Booking が丸ごと抜けている実障害があるため)
  let missingSources = [];
  if (snapshot) {
    const propsSnap = await db.collection("properties").get();
    const activeProps = propsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.active !== false && p.managedBy !== "owner_manual");
    missingSources = detectMissingOtaSources({
      properties: activeProps, auditedTargets: snapshot.auditedTargets,
    }).missing;
  }

  const auditRef = db.collection("otaAuditResults").doc(todayStr);

  // 判定と「再走権の先取り」を1トランザクションで行う (同時発火の二重通知を防ぐ)
  const decision = await db.runTransaction(async (tx) => {
    const auditDoc = await tx.get(auditRef);
    const auditResult = auditDoc.exists ? auditDoc.data() : null;
    const d = shouldRecheckOtaAudit({
      date: todayStr, todayStr, snapshot, auditResult,
      missingSources, maxRechecks: MAX_RECHECKS_PER_DAY,
    });
    if (!d.recheck) return d;
    // 権利を先取り (この時点で recheckCount を進めておけば、後続の発火は max か
    // snapshotStatus=done で弾かれる)
    tx.set(auditRef, {
      recheckClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
      recheckCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
    return d;
  });

  if (!decision.recheck) {
    console.log(`[otaAuditRecheck] スキップ (${reason}): ${decision.reason}`);
    return { ran: false, reason: decision.reason };
  }

  console.log(`[otaAuditRecheck] 補完再走を実行 (${reason}) date=${todayStr}`);
  await morningOtaAudit({ mode: "recheck", reason });
  return { ran: true, reason: decision.reason };
}

/** Firestore トリガー本体: otaCalendarSnapshots/{date} の書き込み */
async function onOtaSnapshotComplete(event) {
  const date = event.params && event.params.date;
  const after = event.data && event.data.after;
  if (!after || !after.exists) return;              // 削除は対象外
  const status = after.data() && after.data().status;
  if (status !== "done") return;                    // 完成した時だけ動く (無駄な読み取りを避ける)
  const { date: todayStr } = nowJst();
  if (date !== todayStr) return;                    // 当日分だけ (過去日は遡り突合の担当)

  try {
    await maybeRecheckOtaAudit(`snapshot_write:${date}`);
  } catch (e) {
    console.error("[otaAuditRecheck] トリガー処理エラー:", e);
    try {
      await admin.firestore().collection("error_logs").add({
        functionName: "onOtaSnapshotComplete",
        error: e.message,
        stack: e.stack ? e.stack.slice(0, 500) : "",
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
}

/** 保険のスケジュール本体 (毎朝7:20 JST)。トリガーが取りこぼした日を拾う */
async function otaAuditRecheckScheduled() {
  try {
    await maybeRecheckOtaAudit("scheduled_0720");
  } catch (e) {
    console.error("[otaAuditRecheck] 定期チェックエラー:", e);
  }
}

module.exports = onOtaSnapshotComplete;
module.exports.maybeRecheckOtaAudit = maybeRecheckOtaAudit;
module.exports.otaAuditRecheckScheduled = otaAuditRecheckScheduled;
