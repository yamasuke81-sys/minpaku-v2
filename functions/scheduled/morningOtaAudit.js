/**
 * OTA予約突合＋朝の点検通知（毎朝7:00 JST）
 *
 * PC常駐リスナーが毎晩2:30に書き込む otaCalendarSnapshots/{today}(JST) と
 * v2 の予約台帳(bookings)を突合し、以下を物件ごとに通知する:
 *   ① OTA予約とv2予約の突合差分 (missing_in_v2 / cancelled_in_ota / date_mismatch /
 *      missing_in_ota / guest_count_mismatch)
 *   ② 当日チェックインでキーボックス未送信 (keybox_unsent)
 *   ③ チェックイン3日以内で名簿未提出 (roster_missing)
 *
 * 突合ロジックは api/ota-audit-logic.js の純粋関数群に委譲する(このファイルは
 * Firestore読み書き・通知呼び出しのみ担当)。
 *
 * 通知キーは NOTIFY_KEY で定数化。channelOverrides.morning_ota_audit は
 * 物件データ側で別途設定する(このコードはキー名のみ知っていればよい)。
 */
const admin = require("firebase-admin");
const { nowJst, addDays } = require("../utils/dateUtils");
const { getAppUrl } = require("../utils/appUrl");
const {
  notifyByKey,
  sendDiscord_,
  resolveDiscordOwnerWebhookUrl_,
  getNotificationSettings_,
} = require("../utils/lineNotify");
const {
  reconcileOtaSnapshot,
  collectKeyboxFindings,
  collectRosterFindings,
  buildPropertyReport,
} = require("../api/ota-audit-logic");

const NOTIFY_KEY = "morning_ota_audit";
const ROSTER_WARN_DAYS = 3;

// finding.type → 全体サマリの日本語ラベル
const TYPE_LABELS = {
  missing_in_v2: "OTAにあるがv2に無い",
  cancelled_in_ota: "OTA側キャンセル済みだがv2確定のまま",
  date_mismatch: "日付不一致",
  missing_in_ota: "v2にあるがOTAに無い",
  guest_count_mismatch: "人数不一致",
  keybox_unsent: "キーボックス未送信",
  roster_missing: "名簿未提出",
  parse_error: "日付解析エラー",
};

module.exports = async function morningOtaAudit() {
  const db = admin.firestore();
  const { date: todayStr } = nowJst();

  console.log(`[morningOtaAudit] 起動 JST=${todayStr}`);

  try {
    // 通知に添付するディープリンクの基点URL (v2-5-relay固定運用。openExternalBrowser=1 は送信側で自動付与)
    const appUrl = await getAppUrl(db);
    // ---- 1) スナップショット取得 ----
    const snapDoc = await db.collection("otaCalendarSnapshots").doc(todayStr).get();
    const snapshot = snapDoc.exists ? snapDoc.data() : null;
    const snapshotMissing = !snapshot || snapshot.status === "failed";
    const snapshotPartial = !!snapshot && snapshot.status === "partial";
    const windowTo = (snapshot && snapshot.to) || addDays(todayStr, 30);

    if (snapshotMissing) {
      console.warn(`[morningOtaAudit] otaCalendarSnapshots/${todayStr} が無い/failed — 突合はスキップ、②③は継続`);
    }

    // ---- 2) bookings (checkIn単一フィールドの範囲。複合インデックス不要) ----
    // 範囲は today−7日 〜 スナップショットの to。
    // Airbnbの期間フィルタは「滞在が期間に重なる予約」を返すため、CIが今日より前の滞在中予約
    // (ステータス「現在ホスティング中」) もスナップショットに含まれる。それらをマッチングできるよう
    // 過去7日ぶんも取得する (missing_in_v2/missing_in_ota の判定自体は checkIn >= today に限定)
    const bookingsFrom = addDays(todayStr, -7);
    const bookingsSnap = await db.collection("bookings")
      .where("checkIn", ">=", bookingsFrom)
      .where("checkIn", "<=", windowTo)
      .get();
    const allBookings = bookingsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // ---- 3) guestRegistrations (当日キーボックス用+名簿3日用+人数突合用を兼ねる。単一フィールド範囲) ----
    // guest_count_mismatch は30日窓全体の名簿と比較する必要があるため範囲は today−7日 〜 to。
    // 当日キーボックスチェックは collectKeyboxFindings 内で checkIn === today に、
    // 名簿3日チェックは collectRosterFindings 内で bookings 側の checkIn today〜+3 にフィルタされる
    const regSnap = await db.collection("guestRegistrations")
      .where("checkIn", ">=", bookingsFrom)
      .where("checkIn", "<=", windowTo)
      .get();
    const allRegistrations = regSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // ---- 4) properties (active のみ対象) ----
    // ★他オーナー物件(managedBy="owner_manual")は八朔の朝点検・通知の対象外(未設定/hassaku_autoのみ)。
    const propsSnap = await db.collection("properties").get();
    const activeProps = propsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.active !== false && p.managedBy !== "owner_manual");
    const activePropertyIds = new Set(activeProps.map((p) => p.id));
    const propNameById = new Map(activeProps.map((p) => [p.id, p.name || p.id]));

    const bookings = allBookings.filter((b) => activePropertyIds.has(b.propertyId));
    const registrations = allRegistrations.filter((g) => activePropertyIds.has(g.propertyId));

    // ---- 5) findings 集約 (純粋関数へ委譲) ----
    let reconcileFindings = [];
    if (!snapshotMissing) {
      const reservations = Array.isArray(snapshot.reservations)
        ? snapshot.reservations.filter((r) => r && activePropertyIds.has(r.propertyId))
        : [];
      // auditedTargets: listener が書く「実際に取得できた (propertyId, ota) ペア」一覧。
      // missing_in_ota (v2→OTA逆方向チェック) をこのペアだけに限定し、おのみちホテル/Hotel Zen のような
      // スナップショット対象外運用の物件 (v2にiCal予約はあるがOTA側から一度も取得されない) の誤検知を防ぐ。
      // snapshot に無い (古い形式) 場合は reconcileOtaSnapshot 側で reservations からのフォールバックに任せる。
      const auditedTargets = Array.isArray(snapshot.auditedTargets)
        ? snapshot.auditedTargets.filter((t) => t && activePropertyIds.has(t.propertyId))
        : undefined;
      reconcileFindings = reconcileOtaSnapshot({ reservations, bookings, registrations, auditedTargets, todayStr, appUrl }).findings;
    }
    const keyboxFindings = collectKeyboxFindings({ registrations, bookings, properties: activeProps, todayStr, appUrl }).findings;
    const rosterFindings = collectRosterFindings({ bookings, properties: activeProps, todayStr, warnDays: ROSTER_WARN_DAYS, appUrl }).findings;

    const allFindings = [...reconcileFindings, ...keyboxFindings, ...rosterFindings];

    // 物件ごとにグループ化
    const findingsByProperty = new Map();
    for (const f of allFindings) {
      const pid = f.propertyId || "";
      if (!pid) continue;
      if (!findingsByProperty.has(pid)) findingsByProperty.set(pid, []);
      findingsByProperty.get(pid).push(f);
    }

    // ---- 6) 結果を保存 ----
    const countsByType = {};
    for (const f of allFindings) countsByType[f.type] = (countsByType[f.type] || 0) + 1;
    await db.collection("otaAuditResults").doc(todayStr).set({
      date: todayStr,
      findings: allFindings,
      countsByType,
      totalCount: allFindings.length,
      snapshotStatus: snapshot ? snapshot.status : "missing",
      unassignedCount: (snapshot && snapshot.unassignedCount) || 0,
      createdAt: new Date(),
    });

    // ---- 7) 物件ごと通知 ----
    const noSendProperties = [];
    for (const [pid, findings] of findingsByProperty.entries()) {
      const propertyName = propNameById.get(pid) || pid;
      const body = buildPropertyReport(propertyName, findings, todayStr);
      const title = `🌅 OTA朝点検: ${propertyName} で要確認${findings.length}件`;

      const result = await notifyByKey(db, NOTIFY_KEY, {
        title,
        body,
        vars: { property: propertyName, date: todayStr },
        propertyId: pid,
        _fromBatchQueue: true, // バッチ迂回で即時送信 (feedback_notifybykey_batch_bypass 参照)
      });

      const anySent = Object.values(result.sent || {}).some(Boolean);
      if (!anySent) {
        // 9) channelOverrides 未設定等で全チャネル未達だった物件は最終防衛線として全体サマリに詳細を回す
        noSendProperties.push({ propertyName, body });
      }
    }

    // ---- 8) 全体サマリを Discord に必ず1通 ----
    const { settings } = await getNotificationSettings_(db);
    const discordUrl = resolveDiscordOwnerWebhookUrl_(settings);

    if (!discordUrl) {
      console.warn("[morningOtaAudit] Discord Webhook URL 未設定のため全体サマリは送信していません");
    } else {
      const lines = [];

      if (snapshotMissing) {
        lines.push(`🚨 本日のOTAスナップショットが取得できていません(otaCalendarSnapshots/${todayStr})。突合(①)はスキップしました。`);
      } else if (snapshotPartial) {
        const errText = (snapshot.errors || []).map((e) => `${e.ota}: ${e.message}`).join(" / ");
        lines.push(`⚠️ OTA取得が一部失敗しています(${errText})。失敗分は逆方向チェック対象外です。`);
      }

      if (allFindings.length === 0) {
        lines.unshift(`🌅 OTA朝点検: 全物件異常なし(OTA予約突合OK / キーボックス・名簿OK)`);
      } else {
        lines.unshift(`🌅 OTA朝点検: 要確認${allFindings.length}件(物件別の詳細は各通知参照)`);
        for (const [type, count] of Object.entries(countsByType)) {
          lines.push(`・${TYPE_LABELS[type] || type}: ${count}件`);
        }
      }

      // 9) 個別通知が全チャネル未達だった物件の詳細を追記
      if (noSendProperties.length > 0) {
        lines.push("");
        lines.push(`⚠️ 以下の物件は個別通知が届いていません(channelOverrides.${NOTIFY_KEY} 未設定の可能性):`);
        for (const np of noSendProperties) {
          lines.push(`--- ${np.propertyName} ---`);
          lines.push(np.body);
        }
      }

      // 10) unassignedCount
      if (snapshot && snapshot.unassignedCount > 0) {
        lines.push(`ℹ️ Airbnb予約 ${snapshot.unassignedCount}件がどの物件にも紐づきませんでした(要確認)。`);
      }

      // 11) 「人数・氏名が古い可能性」が付いたままの予約 (差し替え検知の積み残し)
      //     差し替え時にリアルタイム通知も出すが、通知は落ちることがある。
      //     フラグは booking に永続化されるので、消されるまで毎朝ここで催促する。
      try {
        const staleSnap = await db.collection("bookings")
          .where("guestInfoStale", "==", true)
          .get();
        const staleRows = staleSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((b) => String(b.status || "").toLowerCase() !== "cancelled")
          .filter((b) => String(b.checkIn || "") >= todayStr)   // 未来の滞在のみ
          .sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)));
        if (staleRows.length > 0) {
          lines.push("");
          lines.push(`⚠️ 人数・氏名が古い可能性のある予約 ${staleRows.length}件(OTAで実数を確認して修正してください)`);
          for (const b of staleRows) {
            lines.push(`・${b.propertyName || b.propertyId} ${b.checkIn}〜${b.checkOut} ` +
              `${b.guestName || "(不明)"} ${b.guestCount != null ? `${b.guestCount}名` : "人数未設定"}` +
              `${b.guestInfoStaleReason ? ` — ${b.guestInfoStaleReason}` : ""}`);
          }
          lines.push("→ 予約詳細で人数を直し「確認済みにする」を押すとこの催促は消えます。");
        }
      } catch (e) {
        console.warn("[morningOtaAudit] guestInfoStale 集計エラー:", e.message);
      }

      const r = await sendDiscord_(discordUrl, lines.join("\n"));
      if (!r.success) console.warn("[morningOtaAudit] 全体サマリDiscord送信失敗:", r.error);
    }

    console.log(`[morningOtaAudit] 完了: findings=${allFindings.length}件, 物件数=${findingsByProperty.size}`);
  } catch (e) {
    console.error("[morningOtaAudit] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "morningOtaAudit",
        error: e.message,
        stack: e.stack ? e.stack.slice(0, 500) : "",
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
};
