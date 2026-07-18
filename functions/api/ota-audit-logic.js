/**
 * OTA予約突合＋朝の点検 — 純粋関数モジュール (副作用なし)
 *
 * scheduled/morningOtaAudit.js から Firestore/通知に触れないロジックだけを切り出し、
 * ユニットテストで挙動を担保する。pnl-logic.js / ota-csv-logic.js と同じ方針。
 *
 * このファイルの関数はすべて引数のみで決定論的に動くこと。
 */

// OTA種別キー ⇔ v2 bookings.source の対応表
const OTA_TO_SOURCE = { airbnb: "Airbnb", booking: "Booking.com" };
const SOURCE_TO_OTA = { Airbnb: "airbnb", "Booking.com": "booking" };

/**
 * 大文字小文字を無視して haystack が code を含むか判定する。
 * @param {string|undefined|null} haystack
 * @param {string|undefined|null} code
 * @returns {boolean}
 */
function containsCodeCI(haystack, code) {
  if (!haystack || !code) return false;
  return String(haystack).toLowerCase().includes(String(code).toLowerCase());
}

/**
 * "YYYY-MM-DD" + N日 → "YYYY-MM-DD" (内製・utils/dateUtils には依存しない)
 * @param {string} dateStr
 * @param {number} n
 * @returns {string}
 */
function addDaysStr_(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * "YYYY-MM-DD" 同士の日数差 (b - a)
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function daysBetween_(a, b) {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db_ = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.round((db_ - da) / 86400000);
}

// 通知に添付するアプリ内URL (appUrl 未指定なら null → URL行は出さない)
// - 予約詳細: 予約・清掃スケジュールのディープリンク (#/schedule?bookingId=) で詳細モーダルを直接開く
// - 名簿詳細: 既存の #/guests?id= (guests.js が id クエリで該当名簿を開く)
// - openExternalBrowser=1 は lineNotify 側の appendOpenExternalBrowser が自動付与する
function bookingUrl_(appUrl, bookingId) {
  return appUrl && bookingId ? `${appUrl}/#/schedule?bookingId=${encodeURIComponent(bookingId)}` : null;
}
function guestUrl_(appUrl, guestId) {
  return appUrl && guestId ? `${appUrl}/#/guests?id=${encodeURIComponent(guestId)}` : null;
}
function scheduleUrl_(appUrl) {
  return appUrl ? `${appUrl}/#/schedule` : null;
}

/**
 * OTAスナップショットとv2予約台帳を突合する。
 *
 * マッチング手順 (1つのbookingは1つのOTA行にのみ対応させる):
 *   1. コード一致パス (最優先・全ペアを先に確定)
 *   2. 日付完全一致パス (checkIn+checkOut両方一致)
 *   3. 弱一致パス (checkInのみ一致)
 *
 * @param {object} params
 * @param {Array} params.reservations - otaCalendarSnapshots/{date}.reservations
 * @param {Array} params.bookings - v2 bookings (全ステータス。matchingプールとして使う)
 * @param {Array} params.registrations - guestRegistrations (人数不一致チェック用)
 * @param {Array<{propertyId:string, ota:string}>} [params.auditedTargets] - スナップショットが実際に
 *   取得できた (propertyId, ota) のペア一覧 (listenerが書く)。missing_in_ota (v2→OTA逆方向チェック) は
 *   このペアに含まれる予約のみを対象にする。
 *   省略時 (後方互換) は reservations に登場する propertyId×ota のペアへフォールバックする。
 *   これにより、おのみちホテル/Hotel Zen のようにスナップショットの対象外運用の物件で
 *   (v2にはiCal予約があるがOTA側からは一度も取得されない) 誤検知が出ないようにする。
 * @param {string} [params.todayStr] - 実行日 "YYYY-MM-DD"。指定時、checkIn が todayStr より前の行/予約は
 *   missing_in_v2 / missing_in_ota の片方向チェックから除外する (マッチング・cancelled_in_ota・
 *   guest_count_mismatch には使う)。
 *   背景: Airbnb の期間フィルタは「滞在が期間に重なる予約」を返すため、チェックインが今日より前の
 *   滞在中予約 (ステータス「現在ホスティング中」) もスナップショットに含まれる。呼び出し側の bookings
 *   クエリ範囲(today−7日〜)に入らない長期滞在などで誤検知にならないよう、片方向チェックは
 *   「checkIn が今日以降」の行に限定する。
 * @param {string} [params.appUrl] - v2 アプリのベースURL。指定時、各 finding に該当予約/名簿への
 *   ディープリンク (finding.url) を付与する (通知本文で 🔗 行として出力される)。
 * @returns {{findings: Array}}
 */
function reconcileOtaSnapshot({ reservations = [], bookings = [], registrations = [], auditedTargets, todayStr, appUrl } = {}) {
  const findings = [];

  // ---- 1) 日付解析エラー行(checkIn=="")を除外し、物件ごとにまとめて1件のfindingに ----
  const validRes = [];
  const parseErrByProp = new Map();
  for (const r of (reservations || [])) {
    if (!r) continue;
    if (!r.checkIn) {
      const key = r.propertyId || "";
      if (!parseErrByProp.has(key)) {
        parseErrByProp.set(key, { propertyId: r.propertyId || "", propertyName: r.propertyName || "", count: 0, samples: [] });
      }
      const g = parseErrByProp.get(key);
      g.count++;
      if (g.samples.length < 3) g.samples.push(`${r.ota || "?"}:${r.guestName || "?"}`);
      continue;
    }
    validRes.push(r);
  }
  for (const g of parseErrByProp.values()) {
    findings.push({
      type: "parse_error",
      propertyId: g.propertyId,
      propertyName: g.propertyName,
      ota: null,
      detail: { count: g.count, samples: g.samples },
      message: `ℹ️ OTA予約${g.count}件で日付が読み取れませんでした(${g.samples.join(", ")})。目視で確認してください。`,
    });
  }

  // ---- 2) 物件×プラットフォームでグループ化 ----
  const groupKey_ = (pid, ota) => `${pid}::${ota}`;
  const resByGroup = new Map();
  for (const r of validRes) {
    const k = groupKey_(r.propertyId, r.ota);
    if (!resByGroup.has(k)) resByGroup.set(k, []);
    resByGroup.get(k).push(r);
  }
  const bookByGroup = new Map();
  for (const b of (bookings || [])) {
    if (!b) continue;
    const ota = SOURCE_TO_OTA[b.source];
    if (!ota) continue; // direct等はOTA突合の対象外
    const k = groupKey_(b.propertyId, ota);
    if (!bookByGroup.has(k)) bookByGroup.set(k, []);
    bookByGroup.get(k).push(b);
  }

  // missing_in_ota (v2→OTA逆方向チェック) の対象ペア。
  // auditedTargets が明示指定されていればそれに厳密に従う (空配列=全滅なら逆方向チェックなし)。
  // 未指定 (undefined) のときのみ、reservations に登場した propertyId×ota のペアへフォールバックする。
  const auditedSet = new Set();
  if (Array.isArray(auditedTargets)) {
    for (const t of auditedTargets) {
      if (!t || !t.propertyId || !t.ota) continue;
      auditedSet.add(groupKey_(t.propertyId, t.ota));
    }
  } else {
    for (const r of (reservations || [])) {
      if (r && r.propertyId && r.ota) auditedSet.add(groupKey_(r.propertyId, r.ota));
    }
  }

  // 名簿: bookingId → registration (submitted/confirmed のみ)
  const regByBookingId = new Map();
  for (const g of (registrations || [])) {
    if (!g || !g.bookingId) continue;
    if (g.status !== "submitted" && g.status !== "confirmed") continue;
    regByBookingId.set(g.bookingId, g);
  }

  const allGroupKeys = new Set([...resByGroup.keys(), ...bookByGroup.keys()]);

  for (const key of allGroupKeys) {
    const sep = key.indexOf("::");
    const propertyId = key.slice(0, sep);
    const ota = key.slice(sep + 2);
    const resList = resByGroup.get(key) || [];
    const bookList = bookByGroup.get(key) || [];
    const propertyName = (resList[0] && resList[0].propertyName) || (bookList[0] && bookList[0].propertyName) || "";

    const otaUsed = new Set();
    const bookUsed = new Set();
    const pairs = []; // { resIdx, bookIdx, matchType }

    // --- コード一致パス (最優先で全部確定) ---
    for (let ri = 0; ri < resList.length; ri++) {
      const r = resList[ri];
      const code = String(r.code || "").trim();
      if (!code) continue;
      for (let bi = 0; bi < bookList.length; bi++) {
        if (bookUsed.has(bi)) continue;
        const b = bookList[bi];
        if (containsCodeCI(b.notes, code) || containsCodeCI(b.icalUid, code)) {
          otaUsed.add(ri); bookUsed.add(bi);
          pairs.push({ resIdx: ri, bookIdx: bi, matchType: "code" });
          break;
        }
      }
    }

    // --- 日付完全一致パス ---
    for (let ri = 0; ri < resList.length; ri++) {
      if (otaUsed.has(ri)) continue;
      const r = resList[ri];
      for (let bi = 0; bi < bookList.length; bi++) {
        if (bookUsed.has(bi)) continue;
        const b = bookList[bi];
        if (r.checkIn && r.checkOut && r.checkIn === b.checkIn && r.checkOut === b.checkOut) {
          otaUsed.add(ri); bookUsed.add(bi);
          pairs.push({ resIdx: ri, bookIdx: bi, matchType: "date" });
          break;
        }
      }
    }

    // --- 弱一致パス (checkInのみ) ---
    for (let ri = 0; ri < resList.length; ri++) {
      if (otaUsed.has(ri)) continue;
      const r = resList[ri];
      for (let bi = 0; bi < bookList.length; bi++) {
        if (bookUsed.has(bi)) continue;
        const b = bookList[bi];
        if (r.checkIn && r.checkIn === b.checkIn) {
          otaUsed.add(ri); bookUsed.add(bi);
          pairs.push({ resIdx: ri, bookIdx: bi, matchType: "weak" });
          break;
        }
      }
    }

    // --- ペアからfinding生成 (cancelled_in_ota / date_mismatch / guest_count_mismatch) ---
    for (const p of pairs) {
      const r = resList[p.resIdx];
      const b = bookList[p.bookIdx];

      // cancelled_in_ota: コード一致 かつ OTA側cancelled かつ v2がconfirmedのまま
      if (p.matchType === "code" && r.cancelled === true && b.status === "confirmed") {
        findings.push({
          type: "cancelled_in_ota",
          propertyId, propertyName, ota,
          detail: { code: r.code, guestName: r.guestName, checkIn: r.checkIn, checkOut: r.checkOut, bookingId: b.id },
          message: `🚨 ${r.guestName || "ゲスト"}様(${r.checkIn}〜${r.checkOut})はOTA側でキャンセル済みですが、v2では確定(confirmed)のままです。`,
          url: bookingUrl_(appUrl, b.id),
        });
      }

      // date_mismatch: コード一致だが日付のどちらかが不一致
      if (p.matchType === "code" && (r.checkIn !== b.checkIn || r.checkOut !== b.checkOut)) {
        findings.push({
          type: "date_mismatch",
          propertyId, propertyName, ota,
          detail: {
            code: r.code, guestName: r.guestName, bookingId: b.id,
            otaCheckIn: r.checkIn, otaCheckOut: r.checkOut,
            v2CheckIn: b.checkIn, v2CheckOut: b.checkOut,
          },
          message: `🚨 ${r.guestName || "ゲスト"}様: OTA(${r.checkIn}〜${r.checkOut}) と v2(${b.checkIn}〜${b.checkOut}) で日付が食い違っています。`,
          url: bookingUrl_(appUrl, b.id),
        });
      }

      // guest_count_mismatch: 対応付いたペアで、OTA人数と名簿人数(乳幼児除く)が食い違う
      // 名簿フォームの guestCount は入力時点で「3才以下の乳幼児を除く人数」(guest-form.html の仕様)。
      // 乳幼児は guestCountInfants に別建てなので、ここで再度引くと二重控除になる。
      if (r.guests != null && b.id) {
        const reg = regByBookingId.get(b.id);
        if (reg) {
          const rosterGuests = Number(reg.guestCount || 0);
          const infants = Number(reg.guestCountInfants || 0);
          if (rosterGuests !== r.guests) {
            findings.push({
              type: "guest_count_mismatch",
              propertyId, propertyName, ota,
              detail: { guestName: r.guestName, bookingId: b.id, guestId: reg.id, otaGuests: r.guests, rosterGuests, rosterInfants: infants },
              message: `⚠️ ${r.guestName || "ゲスト"}様: OTA人数${r.guests}名に対し、名簿は${rosterGuests}名(乳幼児除く${infants > 0 ? `・ほか乳幼児${infants}名` : ""})です。`,
              url: guestUrl_(appUrl, reg.id) || bookingUrl_(appUrl, b.id),
            });
          }
        }
      }
    }

    // --- missing_in_v2: cancelled=false で未マッチのOTA行 ---
    for (let ri = 0; ri < resList.length; ri++) {
      if (otaUsed.has(ri)) continue;
      const r = resList[ri];
      if (r.cancelled === true) continue; // OTA側で既にキャンセル済み→v2に無くて正常
      // 滞在中予約 (checkIn が今日より前、Airbnbステータス「現在ホスティング中」等) は
      // 呼び出し側の bookings クエリ範囲 (today−7日〜) に入らない長期滞在があり得るため、
      // 片方向チェックの対象外にする (マッチングには上で使用済み)
      if (todayStr && r.checkIn < todayStr) continue;
      findings.push({
        type: "missing_in_v2",
        propertyId, propertyName, ota,
        detail: { code: r.code, guestName: r.guestName, checkIn: r.checkIn, checkOut: r.checkOut },
        message: `🚨 ${r.guestName || "ゲスト"}様(${r.checkIn}〜${r.checkOut})はOTAに予約がありますが、v2に見当たりません。`,
        url: scheduleUrl_(appUrl), // v2側に実体が無いため該当日のカレンダー確認へ誘導
      });
    }

    // --- missing_in_ota: auditedTargets対象外はスキップ (逆方向チェックのみ)。confirmed・承認待ち/未照合を除外 ---
    if (auditedSet.has(key)) {
      for (let bi = 0; bi < bookList.length; bi++) {
        if (bookUsed.has(bi)) continue;
        const b = bookList[bi];
        if (b.status !== "confirmed") continue;
        if (b.pendingApproval === true) continue;
        if (b.unverified === true) continue;
        // checkIn が今日より前のv2予約 (滞在中/終了済み) は対象外。
        // bookings クエリ拡大 (today−7日〜) はマッチング用であり、終了済み滞在は
        // OTAスナップショット窓 (today〜+30日) に重ならず載らないため誤検知になる
        if (todayStr && b.checkIn < todayStr) continue;
        findings.push({
          type: "missing_in_ota",
          propertyId, propertyName, ota,
          detail: { bookingId: b.id, guestName: b.guestName, checkIn: b.checkIn, checkOut: b.checkOut },
          message: `⚠️ ${b.guestName || "ゲスト"}様(${b.checkIn}〜${b.checkOut})はv2にありますが、OTA一覧に見当たりません(OTA側でキャンセルされた可能性)。`,
          url: bookingUrl_(appUrl, b.id),
        });
      }
    }
  }

  return { findings };
}

/**
 * 当日チェックインでキーボックス未送信の名簿を検出する。
 *
 * @param {object} params
 * @param {Array} params.registrations - guestRegistrations
 * @param {Array} params.bookings - v2 bookings (孤児名簿ガード用)
 * @param {Array} params.properties - properties (keyboxSend.enabled 判定用)
 * @param {string} params.todayStr - "YYYY-MM-DD"
 * @param {string} [params.appUrl] - v2 アプリのベースURL (finding.url 付与用)
 * @returns {{findings: Array}}
 */
function collectKeyboxFindings({ registrations = [], bookings = [], properties = [], todayStr, appUrl } = {}) {
  const findings = [];
  const propById = new Map((properties || []).filter(Boolean).map((p) => [p.id, p]));
  const bookById = new Map((bookings || []).filter(Boolean).map((b) => [b.id, b]));

  for (const g of (registrations || [])) {
    if (!g) continue;
    if (g.checkIn !== todayStr) continue;
    if (g.status !== "submitted" && g.status !== "confirmed") continue;
    if (g.keyboxSentAt) continue; // 送信済み

    const prop = propById.get(g.propertyId);
    if (!prop || !prop.keyboxSend || prop.keyboxSend.enabled !== true) continue; // キーボックス送信が無効な物件

    // 孤児名簿ガード: bookingId が紐付いていて bookings に存在しない/cancelled ならスキップ
    if (g.bookingId) {
      const b = bookById.get(g.bookingId);
      if (!b || b.status === "cancelled") continue;
    }

    const confirmed = !!g.keyboxConfirmedAt;
    findings.push({
      type: "keybox_unsent",
      propertyId: g.propertyId,
      propertyName: prop.name || g.propertyId,
      ota: null,
      detail: { guestId: g.id, guestName: g.guestName, checkIn: g.checkIn, keyboxConfirmed: confirmed },
      message: confirmed
        ? `⚠️ ${g.guestName || "ゲスト"}様(本日CI)はOKボタン押下済みですが、キーボックス情報がまだ送信されていません。`
        : `⚠️ ${g.guestName || "ゲスト"}様(本日CI)はOKボタン未押下のため、キーボックス情報が送信されていません。`,
      url: guestUrl_(appUrl, g.id),
    });
  }

  return { findings };
}

/**
 * チェックイン3日以内(既定)で名簿未提出の予約を検出する。
 * 物件の channelOverrides.roster_remind.enabled === true の物件のみを対象にする
 * (おのみちホテル/Hotel Zen 等、名簿運用をしていない物件のノイズ化を防ぐ)。
 *
 * @param {object} params
 * @param {Array} params.bookings - v2 bookings
 * @param {Array} [params.properties] - properties (channelOverrides.roster_remind.enabled 判定用)
 * @param {string} params.todayStr - "YYYY-MM-DD"
 * @param {number} [params.warnDays=3]
 * @param {string} [params.appUrl] - v2 アプリのベースURL (finding.url 付与用)
 * @returns {{findings: Array}}
 */
function collectRosterFindings({ bookings = [], properties = [], todayStr, warnDays = 3, appUrl } = {}) {
  const findings = [];
  const limitStr = addDaysStr_(todayStr, warnDays);
  const rosterEnabledIds = new Set(
    (properties || [])
      .filter((p) => p && p.channelOverrides && p.channelOverrides.roster_remind && p.channelOverrides.roster_remind.enabled === true)
      .map((p) => p.id)
  );

  for (const b of (bookings || [])) {
    if (!b) continue;
    if (!rosterEnabledIds.has(b.propertyId)) continue; // roster_remind無効の物件はノイズ防止のためスキップ
    if (!b.checkIn || b.checkIn < todayStr || b.checkIn > limitStr) continue;
    if (b.status !== "confirmed") continue;
    if (b.rosterStatus === "submitted") continue;
    if (b.pendingApproval === true) continue; // Airbnb承認待ち
    if (b.unverified === true) continue; // Booking.com匿名未照合

    const daysUntil = daysBetween_(todayStr, b.checkIn);
    findings.push({
      type: "roster_missing",
      propertyId: b.propertyId,
      propertyName: b.propertyName || b.propertyId,
      ota: null,
      detail: { bookingId: b.id, guestName: b.guestName, checkIn: b.checkIn, daysUntil },
      message: `⚠️ ${b.guestName || "ゲスト"}様: CIまであと${daysUntil}日(${b.checkIn})ですが、名簿が未提出です。`,
      url: bookingUrl_(appUrl, b.id),
    });
  }

  return { findings };
}

// 種別ごとの重大度アイコン割当 (buildPropertyReport のグルーピング順)
const CRITICAL_TYPES = new Set(["missing_in_v2", "cancelled_in_ota", "date_mismatch"]);
const WARNING_TYPES = new Set(["missing_in_ota", "guest_count_mismatch", "keybox_unsent", "roster_missing"]);

/**
 * 1物件分の findings から通知本文 (Discord/LINE/メール共用のプレーンテキスト) を組み立てる。
 * 🚨(突合差分の重大項目) → ⚠️(要確認項目) → その他 の順にグループ化する。
 *
 * @param {string} propertyName
 * @param {Array} findings
 * @param {string} todayStr - "YYYY-MM-DD"
 * @returns {string}
 */
function buildPropertyReport(propertyName, findings, todayStr) {
  const list = findings || [];
  const critical = list.filter((f) => CRITICAL_TYPES.has(f.type));
  const warning = list.filter((f) => WARNING_TYPES.has(f.type));
  const other = list.filter((f) => !CRITICAL_TYPES.has(f.type) && !WARNING_TYPES.has(f.type));

  const lines = [`📋 ${propertyName} — ${todayStr} 朝点検`, ""];

  // 各項目の直下に該当予約/名簿へのディープリンクを 🔗 行として添付する (url が無い項目は本文のみ)
  const pushItem = (f) => {
    lines.push(`・${f.message}`);
    if (f.url) lines.push(`　🔗 ${f.url}`);
  };

  if (critical.length > 0) {
    lines.push(`🚨 突合差分・要緊急確認 (${critical.length}件)`);
    for (const f of critical) pushItem(f);
    lines.push("");
  }
  if (warning.length > 0) {
    lines.push(`⚠️ 要確認 (${warning.length}件)`);
    for (const f of warning) pushItem(f);
    lines.push("");
  }
  if (other.length > 0) {
    lines.push(`ℹ️ その他 (${other.length}件)`);
    for (const f of other) pushItem(f);
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "");
}

module.exports = {
  containsCodeCI,
  addDaysStr_,
  daysBetween_,
  reconcileOtaSnapshot,
  collectKeyboxFindings,
  collectRosterFindings,
  buildPropertyReport,
};
