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
  selectResolvableConflicts,
  detectMissingOtaSources,
  selectSnapshotBacklogActions,
  filterBackfillFindings,
  dedupeNewFindings,
  selectGuestCountIssueActions,
} = require("../api/ota-audit-logic");

const NOTIFY_KEY = "morning_ota_audit";
const ROSTER_WARN_DAYS = 3;
// 1回の朝点検で走査する未解決コンフリクトの上限 (実運用は常時1桁。暴走時の保険)
const CONFLICT_SCAN_LIMIT = 300;
// 1回の朝点検で走査する未解決の人数不一致の上限 (実運用は常時1桁。暴走時の保険)
const GUEST_COUNT_ISSUE_SCAN_LIMIT = 200;
// スナップショット欠損日を持ち越して遡り突合を試みる期間 (これを過ぎたら諦めて破棄)
const SNAPSHOT_BACKLOG_MAX_AGE_DAYS = 7;

// finding.type → 全体サマリの日本語ラベル
const TYPE_LABELS = {
  missing_in_v2: "OTAにあるがv2に無い",
  cancelled_in_ota: "OTA側キャンセル済みだがv2確定のまま",
  date_mismatch: "日付不一致",
  missing_in_ota: "v2にあるがOTAに無い",
  guest_count_mismatch: "人数不一致",
  guest_count_unresolved: "人数不一致(未解消・要精算/申告訂正)",
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

    // ---- 4.5) 「取得できているはずのOTA」の脱落検知 ----
    // listener が Booking.com を取れなかったのに status="done"/errors=[] で書くことがある
    // (2026-08-17 実障害)。その場合 auditedTargets から (物件, booking) ペアが丸ごと落ちるので、
    // 物件マスタの期待ターゲットと突き合わせて「未取得ソースあり」として扱う。
    const missingSources = snapshotMissing
      ? []
      : detectMissingOtaSources({ properties: activeProps, auditedTargets: snapshot.auditedTargets }).missing;
    if (missingSources.length > 0) {
      console.warn("[morningOtaAudit] 未取得OTAあり:",
        missingSources.map((m) => `${m.propertyName}/${m.ota}`).join(", "));
    }

    // ---- 5) findings 集約 (純粋関数へ委譲) ----
    let reconcileFindings = [];
    let guestCountChecked = [];
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
      const rec = reconcileOtaSnapshot({ reservations, bookings, registrations, auditedTargets, todayStr, appUrl });
      reconcileFindings = rec.findings;
      guestCountChecked = rec.guestCountChecked || [];
    }
    const keyboxFindings = collectKeyboxFindings({ registrations, bookings, properties: activeProps, todayStr, appUrl }).findings;
    const rosterFindings = collectRosterFindings({ bookings, properties: activeProps, todayStr, warnDays: ROSTER_WARN_DAYS, appUrl }).findings;

    // ---- 5.5) スナップショット欠損日の遡り突合 (持ち越し) ----
    // 欠損した日をその場で捨てず otaSnapshotBacklog に残し、後からスナップショットが
    // 書かれていれば遡って突合する。当日分が欠損していれば持ち越しに積む。
    let backfill = { findings: [], done: [], pending: [], expired: [] };
    try {
      backfill = await processSnapshotBacklog(db, {
        todayStr, snapshotMissing,
        bookings, registrations, activePropertyIds, appUrl,
        todayFindings: reconcileFindings,
      });
    } catch (e) {
      console.warn("[morningOtaAudit] スナップショット持ち越し処理エラー:", e.message);
    }

    // ---- 5.6) 人数不一致の持ち越し (滞在が終わっても未解消なら残す) ----
    // 人数は清掃費の精算と宿泊税の申告に直結するので「OTAの窓から外れて見えなくなった＝解決」に
    // してはいけない。otaGuestCountIssues に永続化し、解消を確認できるまで毎朝出し続ける。
    let guestCountCarryOver = [];
    try {
      guestCountCarryOver = await processGuestCountIssues(db, {
        todayStr, appUrl, guestCountChecked,
        todayFindings: [...reconcileFindings, ...backfill.findings],
      });
    } catch (e) {
      console.warn("[morningOtaAudit] 人数不一致の持ち越し処理エラー:", e.message);
    }

    const allFindings = [
      ...reconcileFindings, ...backfill.findings, ...guestCountCarryOver,
      ...keyboxFindings, ...rosterFindings,
    ];

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
      // 未取得ソースがある日は突合が不完全なので、listener が done と書いていても partial 扱いにする
      snapshotStatus: snapshotMissing ? (snapshot ? snapshot.status : "missing")
        : (missingSources.length > 0 ? "partial" : snapshot.status),
      snapshotStatusRaw: snapshot ? snapshot.status : "missing",
      missingOtaSources: missingSources,
      // 欠損日の持ち越し状況 (遡って突合できた日 / まだ取れていない日 / 諦めた日)
      snapshotBacklog: {
        backfilled: backfill.done, pending: backfill.pending, expired: backfill.expired,
      },
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
        lines.push(`🚨 本日のOTAスナップショットが取得できていません(otaCalendarSnapshots/${todayStr})。突合(①)は持ち越しました(後日スナップショットが書かれ次第、遡って突合します)。`);
      } else if (snapshotPartial) {
        const errText = (snapshot.errors || []).map((e) => `${e.ota}: ${e.message}`).join(" / ");
        lines.push(`⚠️ OTA取得が一部失敗しています(${errText})。失敗分は逆方向チェック対象外です。`);
      }

      // 遡り突合の結果 (欠損日の持ち越し)
      if (backfill.done.length > 0) {
        for (const d of backfill.done) {
          lines.push(`🕒 未突合だった ${d.date} 分を遡って突合しました(新規${d.newCount}件)。`);
        }
      }
      if (backfill.pending.length > 0) {
        lines.push(`⏳ ${backfill.pending.map((p) => p.date).join(", ")} 分のスナップショットはまだ取得できていません(取得され次第、遡って突合します)。`);
      }
      for (const d of backfill.expired) {
        lines.push(`⚠️ ${d.date} 分のスナップショットは${SNAPSHOT_BACKLOG_MAX_AGE_DAYS}日経っても取得できなかったため、この日の突合は諦めました(未突合のまま)。`);
      }

      if (missingSources.length > 0) {
        const srcText = missingSources.map((m) => `${m.propertyName}/${m.otaLabel}`).join(", ");
        lines.push(`⚠️ 未取得のOTAがあります(${srcText})。このOTAの予約は今朝の突合(①)に含まれていません — 「0件」は正常の意味になりません。`);
        lines.push("→ OTAのログイン状態(セッション失効)を確認し、必要なら再ログインしてください。");
      }

      if (allFindings.length === 0) {
        lines.unshift(missingSources.length > 0
          ? `🌅 OTA朝点検: 検出0件 — ただし未取得のOTAがあり突合は不完全です`
          : `🌅 OTA朝点検: 全物件異常なし(OTA予約突合OK / キーボックス・名簿OK)`);
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

    // ---- 12) ダブルブッキングの残骸を閉じる (後処理) ----
    // onBookingChange はキャンセル時にしか conflict を閉じないため、滞在が過ぎただけの
    // bookingConflicts が resolved=false のまま残り、夜間監査が毎晩「過去日程の残骸」として拾う。
    // 判定は純粋関数に委譲し、ここは Firestore の読み書きだけ行う。失敗しても朝点検は落とさない。
    try {
      await closeStaleBookingConflicts(db, todayStr);
    } catch (e) {
      console.warn("[morningOtaAudit] bookingConflicts 後処理エラー:", e.message);
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

/**
 * スナップショット欠損日の持ち越し (otaSnapshotBacklog) を処理する。
 *
 * - 当日分が欠損していれば otaSnapshotBacklog/{today} に積む (捨てない)
 * - 未解決の過去日について、スナップショットが後から書かれていれば遡って突合する
 * - 7日経っても取得できなければ諦めて閉じる (通知で明示する)
 *
 * 遡り突合には当日の bookings/registrations をそのまま使う。持ち越しは最大7日で、
 * 朝点検本体の取得範囲が today−7日〜 なので、対象日のスナップショットに載る予約
 * (チェックインが対象日以降) は全てこの範囲に含まれる。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} ctx
 * @returns {Promise<{findings:Array, done:Array, pending:Array, expired:Array}>}
 */
async function processSnapshotBacklog(db, ctx) {
  const { todayStr, snapshotMissing, bookings, registrations, activePropertyIds, appUrl, todayFindings } = ctx;
  const col = db.collection("otaSnapshotBacklog");
  const ts = () => admin.firestore.FieldValue.serverTimestamp();
  const out = { findings: [], done: [], pending: [], expired: [] };

  // 当日分の欠損を持ち越しに積む
  if (snapshotMissing) {
    const cur = await col.doc(todayStr).get();
    if (!cur.exists) {
      await col.doc(todayStr).set({ date: todayStr, resolved: false, firstMissedAt: ts(), attempts: 0 });
    } else if (cur.data().resolved !== false) {
      // 一度閉じた日が再び欠損扱いになることは通常ないが、状態は最新に合わせる
      await col.doc(todayStr).set({ resolved: false, lastMissedAt: ts() }, { merge: true });
    }
  }

  const snap = await col.where("resolved", "==", false).limit(30).get();
  const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const { retry, expired } = selectSnapshotBacklogActions({
    entries, todayStr, maxAgeDays: SNAPSHOT_BACKLOG_MAX_AGE_DAYS,
  });

  for (const e of expired) {
    await col.doc(e.date).set({
      resolved: true, resolvedReason: "expired", resolvedAt: ts(),
    }, { merge: true });
    out.expired.push({ date: e.date });
  }

  for (const e of retry) {
    const sdoc = await db.collection("otaCalendarSnapshots").doc(e.date).get();
    const s = sdoc.exists ? sdoc.data() : null;
    if (!s || s.status === "failed") {
      await col.doc(e.date).set({
        attempts: admin.firestore.FieldValue.increment(1), lastAttemptAt: ts(),
      }, { merge: true });
      out.pending.push({ date: e.date });
      continue;
    }

    const reservations = Array.isArray(s.reservations)
      ? s.reservations.filter((r) => r && activePropertyIds.has(r.propertyId)) : [];
    const auditedTargets = Array.isArray(s.auditedTargets)
      ? s.auditedTargets.filter((t) => t && activePropertyIds.has(t.propertyId)) : undefined;

    // todayStr には対象日を渡す (その日として突合する)
    const raw = reconcileOtaSnapshot({
      reservations, bookings, registrations, auditedTargets, todayStr: e.date, appUrl,
    }).findings;
    // 当日分の突合で見えるもの(CIが今日以降)は遡り分から落とし、当日分・既出の遡り分とも重複排除する
    const fresh = dedupeNewFindings(
      [...(todayFindings || []), ...out.findings],
      filterBackfillFindings({ findings: raw, todayStr })
    ).map((f) => ({ ...f, backfillDate: e.date, message: `🕒(${e.date}分の遡り) ${f.message}` }));

    out.findings.push(...fresh);
    out.done.push({ date: e.date, newCount: fresh.length });
    await col.doc(e.date).set({
      resolved: true, resolvedReason: "backfilled", resolvedAt: ts(), newFindingCount: fresh.length,
    }, { merge: true });
    console.log(`[morningOtaAudit] 遡り突合 ${e.date}: 新規${fresh.length}件`);
  }

  return out;
}

/**
 * 人数不一致 (guest_count_mismatch) を otaGuestCountIssues に永続化し、
 * 未解消のまま滞在が終わったものを findings に残す。
 *
 * 判断は純粋関数 selectGuestCountIssueActions に委譲し、ここは Firestore の読み書きだけ行う。
 * 解決判定に使う予約・名簿は朝点検本体の取得範囲 (checkIn today−7日〜) の外にあるので、
 * 対象の bookingId で実データを引き直す。
 *
 * @returns {Promise<Array>} findings に足す持ち越し分
 */
async function processGuestCountIssues(db, { todayStr, appUrl, todayFindings, guestCountChecked }) {
  const col = db.collection("otaGuestCountIssues");
  const ts = () => admin.firestore.FieldValue.serverTimestamp();

  const openSnap = await col.where("resolved", "==", false).limit(GUEST_COUNT_ISSUE_SCAN_LIMIT).get();
  const issues = openSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // 今朝の finding に出ていない未解決分だけ、解決判定のために予約と名簿を引き直す
  const detectedIds = new Set((todayFindings || [])
    .filter((f) => f && f.type === "guest_count_mismatch" && f.detail && f.detail.bookingId)
    .map((f) => f.detail.bookingId));
  const lookupIds = issues
    .map((i) => i.bookingId || i.id)
    .filter((id) => id && !detectedIds.has(id) && !(guestCountChecked || []).includes(id));

  const bookingsById = new Map();
  const registrationsByBookingId = new Map();
  if (lookupIds.length > 0) {
    const refs = lookupIds.map((id) => db.collection("bookings").doc(id));
    const docs = await db.getAll(...refs);
    for (const d of docs) if (d.exists) bookingsById.set(d.id, d.data());

    // 名簿は bookingId 単一条件で引く (複合インデックス不要)。in は10件ずつ
    for (let i = 0; i < lookupIds.length; i += 10) {
      const chunk = lookupIds.slice(i, i + 10);
      const rs = await db.collection("guestRegistrations").where("bookingId", "in", chunk).get();
      for (const d of rs.docs) {
        const g = { id: d.id, ...d.data() };
        if (g.status !== "submitted" && g.status !== "confirmed") continue;
        registrationsByBookingId.set(g.bookingId, g);
      }
    }
  }

  const { upserts, closes, carryOver } = selectGuestCountIssueActions({
    issues, todayFindings, guestCountChecked, bookingsById, registrationsByBookingId, todayStr, appUrl,
  });

  const existingIds = new Set(issues.map((i) => i.id));
  for (const u of upserts) {
    try {
      await col.doc(u.id).set({
        ...u.data,
        ...(existingIds.has(u.id) ? {} : { firstDetectedDate: todayStr, firstDetectedAt: ts() }),
        lastDetectedAt: ts(),
      }, { merge: true });
    } catch (e) {
      console.warn(`[morningOtaAudit] otaGuestCountIssues/${u.id} 保存失敗:`, e.message);
    }
  }
  for (const c of closes) {
    try {
      await col.doc(c.id).set({
        resolved: true, resolvedReason: c.reason, resolvedAt: ts(), resolvedBy: "morningOtaAudit",
      }, { merge: true });
    } catch (e) {
      console.warn(`[morningOtaAudit] otaGuestCountIssues/${c.id} クローズ失敗:`, e.message);
    }
  }
  if (upserts.length || closes.length || carryOver.length) {
    console.log(`[morningOtaAudit] 人数不一致: 記録${upserts.length}件 / 解消${closes.length}件 / 未解消の持ち越し${carryOver.length}件`);
  }
  return carryOver;
}

/**
 * 未解決のまま残った bookingConflicts を閉じる (朝点検の後処理)。
 *
 * 対象は selectResolvableConflicts の判定に従う:
 *   expired          … ペアの滞在が全て過去 (今さら対応できない)
 *   cancelled        … 片方以上がキャンセル済み (キャンセル連動が届かなかった分の回収)
 *   bookings_missing … 予約ドキュメントが消えている
 * 「キャンセルでなく checkOut >= 今日」の予約が残っているペアは現行なので触らない。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} todayStr JSTの今日 "YYYY-MM-DD"
 */
async function closeStaleBookingConflicts(db, todayStr) {
  const snap = await db.collection("bookingConflicts")
    .where("resolved", "==", false)
    .limit(CONFLICT_SCAN_LIMIT)
    .get();
  if (snap.empty) return;

  const conflicts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // ペアの予約を実データで引く (過去日程なので朝点検本体の bookings 取得範囲には入っていない)
  const bookingIds = Array.from(new Set(
    conflicts.flatMap((c) => (Array.isArray(c.bookingIds) ? c.bookingIds.filter(Boolean) : []))
  ));
  const bookingsById = new Map();
  const CHUNK = 100; // getAll の一括取得上限に配慮して分割
  for (let i = 0; i < bookingIds.length; i += CHUNK) {
    const refs = bookingIds.slice(i, i + CHUNK).map((id) => db.collection("bookings").doc(id));
    if (refs.length === 0) continue;
    const docs = await db.getAll(...refs);
    for (const d of docs) if (d.exists) bookingsById.set(d.id, d.data());
  }

  const { resolvable } = selectResolvableConflicts({ conflicts, bookingsById, todayStr });
  if (resolvable.length === 0) {
    console.log(`[morningOtaAudit] 未解決ダブルブッキング ${conflicts.length}件 — 全て現行のため据え置き`);
    return;
  }

  for (const r of resolvable) {
    try {
      await db.collection("bookingConflicts").doc(r.id).update({
        resolved: true,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        resolvedReason: r.reason,
        resolvedBy: "morningOtaAudit",
      });
    } catch (e) {
      console.warn(`[morningOtaAudit] bookingConflicts/${r.id} クローズ失敗:`, e.message);
    }
  }
  console.log(`[morningOtaAudit] 残骸クローズ: ${resolvable.length}/${conflicts.length}件 ` +
    `(${resolvable.map((r) => `${r.id}=${r.reason}`).join(", ")})`);
}
