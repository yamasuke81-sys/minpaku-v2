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
// 予約ステータスがキャンセル系か (OTA/iCal 由来で表記ゆれがある)
function isCancelledStatus_(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

function scheduleUrl_(appUrl) {
  return appUrl ? `${appUrl}/#/schedule` : null;
}

/**
 * properties(マスタ)から「物件ID → 表示名」の Map を作る。
 *
 * ★finding.propertyName は properties マスタを第一根拠にする(2026-08-19)。
 *   bookings のうち iCal 取込分(Airbnb/Booking.com)は propertyName を持たないため、
 *   予約側の値だけを見ていると生の物件ID("RZV9IwtQ…")がそのまま宿名として保存され、
 *   夜間監査の指摘文が「どの宿の話か分からない」状態になっていた。
 *
 * @param {Array} properties
 * @returns {Map<string,string>}
 */
function propertyNameMap_(properties) {
  return new Map(
    (properties || [])
      .filter((p) => p && p.id)
      .map((p) => [p.id, p.name || ""])
  );
}

/**
 * 物件名を「マスタ → 予約に非正規化保存された名前 → 物件ID」の順で解決する。
 * 予約側の値が物件IDそのものだった場合は名前として採用しない(生IDの再流出を防ぐ)。
 *
 * @param {Map<string,string>} nameMap
 * @param {string} propertyId
 * @param {string} [denormalized]
 * @returns {string}
 */
function resolvePropertyName_(nameMap, propertyId, denormalized) {
  const fromMaster = nameMap && nameMap.get(propertyId);
  if (fromMaster) return fromMaster;
  if (denormalized && denormalized !== propertyId) return denormalized;
  return propertyId || "";
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
 * @param {Array} [params.properties] - properties マスタ。finding.propertyName の名前解決に使う
 *   (未指定なら 予約側の非正規化名 → 物件ID の順でフォールバック)。
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
function reconcileOtaSnapshot({ reservations = [], bookings = [], registrations = [], properties = [], auditedTargets, todayStr, appUrl } = {}) {
  const nameMap = propertyNameMap_(properties);
  const findings = [];
  const guestCountChecked = []; // 人数を実照合できた bookingId (一致・不一致どちらも)
  const guestCountClassDiffs = []; // 乳幼児の区分違い (総数は一致。通知はせず記録だけ残す)

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
    const propertyName = resolvePropertyName_(
      nameMap,
      propertyId,
      (resList[0] && resList[0].propertyName) || (bookList[0] && bookList[0].propertyName) || ""
    );

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
      if (r.guests != null && b.id) {
        const reg = regByBookingId.get(b.id);
        if (reg) {
          const ev = evaluateGuestCount({ ota: r, reg });
          // 「今朝この予約の人数を実際に照合できた」記録。持ち越し課題(otaGuestCountIssues)の
          // 解決判定に使う — 照合できたのに finding が出ていなければ解消済みと判断できる
          guestCountChecked.push(b.id);
          if (ev.mismatch && ev.classificationOnly) {
            // 乳幼児の区分違い (総数は一致)。通知すると「要確認N件」が滞在終了まで毎朝出続けるので
            // findings には入れず、記録だけ残す (otaAuditResults.guestCountClassDiffs)
            guestCountClassDiffs.push({
              propertyId, propertyName, ota,
              bookingId: b.id, guestId: reg.id, guestName: r.guestName || "",
              checkIn: r.checkIn, checkOut: r.checkOut,
              otaGuests: ev.otaGuests, otaTotal: ev.otaTotal,
              rosterGuests: ev.rosterGuests, rosterInfants: ev.rosterInfants, rosterTotal: ev.rosterTotal,
              note: `OTA${ev.otaGuests}名/名簿${ev.rosterGuests}名だが乳幼児込みの総数はどちらも${ev.rosterTotal}名`,
            });
          } else if (ev.mismatch) {
            findings.push({
              type: "guest_count_mismatch",
              propertyId, propertyName, ota,
              detail: {
                guestName: r.guestName, bookingId: b.id, guestId: reg.id,
                checkIn: r.checkIn, checkOut: r.checkOut,
                otaGuests: ev.otaGuests, rosterGuests: ev.rosterGuests, rosterInfants: ev.rosterInfants,
              },
              message: `⚠️ ${r.guestName || "ゲスト"}様: OTA人数${ev.otaGuests}名に対し、名簿は${ev.rosterGuests}名(乳幼児除く${ev.rosterInfants > 0 ? `・ほか乳幼児${ev.rosterInfants}名` : ""})です。`,
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

  return { findings, guestCountChecked, guestCountClassDiffs };
}

/**
 * OTA行と名簿の人数を比較する (guest_count_mismatch の判定 SSOT)。
 *
 * 名簿フォームの guestCount は入力時点で「3才以下の乳幼児を除く人数」(guest-form.html の仕様)。
 * 乳幼児は guestCountInfants に別建てなので、ここで再度引くと二重控除になる。
 *
 * 検知と、持ち越し課題の解決判定 (selectGuestCountIssueActions) の両方から呼ぶ。
 * 判定を1箇所に閉じておかないと「検知はするが解決とはみなせない」ズレが起きる。
 *
 * @param {object} o
 * @param {{guests?:number}} o.ota - OTA行 (スナップショット、または保存済み課題から復元したもの)
 * @param {{guestCount?:number, guestCountInfants?:number}} o.reg - 名簿
 * @returns {{mismatch:boolean, otaGuests:number, rosterGuests:number, rosterInfants:number}}
 */
function evaluateGuestCount({ ota = {}, reg = {} } = {}) {
  const otaGuests = Number(ota.guests || 0);
  const rosterGuests = Number(reg.guestCount || 0);
  const rosterInfants = Number(reg.guestCountInfants || 0);
  const mismatch = rosterGuests !== otaGuests;

  // 乳幼児の数え方は OTA とゲスト申告で食い違う (2026-08-17 実例: Booking 6084082902 入江様は
  // OTA が 大人4+子ども3+乳幼児2 で guests=7 (乳幼児を除く)、名簿は乳幼児2名を含めて9名と申告)。
  // 数字だけ見ると 7≠9 だが、乳幼児込みの総数はどちらも9名で頭数は合っている。
  // これは精算にも宿泊税にも影響しない「区分違い」なので、人数不一致として扱わない。
  const hasBreakdown = [ota.adults, ota.children, ota.infants].some((v) => v != null && v !== "");
  const otaTotal = hasBreakdown
    ? Number(ota.adults || 0) + Number(ota.children || 0) + Number(ota.infants || 0)
    : otaGuests;
  const rosterTotal = rosterGuests + rosterInfants;
  // OTA側は「guests が乳幼児込み/除く」のどちらの流儀もあるため、両方を総数の候補にする
  const classificationOnly = mismatch && rosterTotal > 0
    && (otaTotal === rosterTotal || otaGuests === rosterTotal);

  return { mismatch, classificationOnly, otaGuests, otaTotal, rosterGuests, rosterInfants, rosterTotal };
}

/**
 * 人数不一致 (guest_count_mismatch) の持ち越し課題をどう更新するかを決める。
 *
 * 背景 (2026-08-17 実例): 人数不一致は毎朝ゼロから作り直していたため、滞在が終わって
 * OTAスナップショットの窓から予約が外れると、誰も直していないのに findings から消えていた
 * (木谷様 8/15〜8/16 が翌朝には totalCount:0)。人数は清掃費の精算と宿泊税の申告に直結するので
 * 「見えなくなった＝解決」にしてはいけない。
 *
 * そこで otaGuestCountIssues/{bookingId} に resolved フラグ付きで永続化し、
 *   ・今朝も検出された             → 内容を更新 (upserts)
 *   ・今朝は照合できたのに出ない   → 解消された (closes: matched)
 *   ・予約が消えた/キャンセルされた → 追う意味が無い (closes: booking_missing / cancelled)
 *   ・名簿が保存済みOTA人数と一致   → 人が直した (closes: matched)
 *   ・それ以外                     → 未解消のまま findings に残す (carryOver)
 * とする。滞在が終わっている未解消分は「要精算・要申告訂正」として文面で明示する。
 *
 * @param {object} o
 * @param {Array} o.issues - otaGuestCountIssues の resolved=false ドキュメント ({id, ...data})
 * @param {Array} o.todayFindings - 今朝の突合 findings
 * @param {Array<string>} [o.guestCountChecked] - 今朝、人数を実照合できた bookingId 一覧
 * @param {Map<string,object>} [o.bookingsById] - bookingId → 予約 (解決判定用に実データで引いたもの)
 * @param {Map<string,object>} [o.registrationsByBookingId] - bookingId → 名簿(最新)
 * @param {string} o.todayStr
 * @param {string} [o.appUrl]
 * @returns {{upserts:Array<{id:string,data:object}>, closes:Array<{id:string,reason:string}>, carryOver:Array}}
 */
function selectGuestCountIssueActions({
  issues = [], todayFindings = [], guestCountChecked = [],
  bookingsById = new Map(), registrationsByBookingId = new Map(), todayStr, appUrl,
} = {}) {
  const upserts = [];
  const detected = new Set();
  for (const f of todayFindings || []) {
    if (!f || f.type !== "guest_count_mismatch") continue;
    const d = f.detail || {};
    if (!d.bookingId) continue;
    detected.add(d.bookingId);
    upserts.push({
      id: d.bookingId,
      data: {
        bookingId: d.bookingId,
        guestId: d.guestId || null,
        propertyId: f.propertyId || "",
        propertyName: f.propertyName || "",
        ota: f.ota || null,
        guestName: d.guestName || "",
        checkIn: d.checkIn || "",
        checkOut: d.checkOut || "",
        otaGuests: d.otaGuests != null ? d.otaGuests : null,
        rosterGuests: d.rosterGuests != null ? d.rosterGuests : null,
        rosterInfants: d.rosterInfants != null ? d.rosterInfants : 0,
        lastDetectedDate: todayStr || "",
        resolved: false,
      },
    });
  }

  const checkedSet = new Set(guestCountChecked || []);
  const closes = [];
  const carryOver = [];

  for (const it of issues || []) {
    const id = it.id || it.bookingId;
    const bookingId = it.bookingId || it.id;
    if (!id || detected.has(bookingId)) continue; // 今朝も出ている分は upserts が更新する

    // 今朝この予約の人数を照合できたのに finding が出ていない = OTA側/名簿側どちらの修正でも解消済み
    if (checkedSet.has(bookingId)) { closes.push({ id, reason: "matched" }); continue; }

    const b = bookingsById.get(bookingId);
    if (!b) { closes.push({ id, reason: "booking_missing" }); continue; }
    if (isCancelledStatus_(b.status)) { closes.push({ id, reason: "cancelled" }); continue; }

    // スナップショットに載らなくなった後は、保存してあるOTA人数と最新の名簿で判定する
    const reg = registrationsByBookingId.get(bookingId);
    const ev = evaluateGuestCount({ ota: { guests: it.otaGuests }, reg: reg || {} });
    if (reg && it.otaGuests != null && !ev.mismatch) { closes.push({ id, reason: "matched" }); continue; }

    const checkIn = b.checkIn || it.checkIn || "";
    const checkOut = b.checkOut || it.checkOut || "";
    const stayEnded = !!todayStr && !!checkOut && String(checkOut) < todayStr;
    const guestName = it.guestName || b.guestName || "ゲスト";
    const rosterNow = reg ? ev.rosterGuests : (it.rosterGuests != null ? it.rosterGuests : "?");
    carryOver.push({
      type: "guest_count_unresolved",
      propertyId: it.propertyId || b.propertyId || "",
      propertyName: it.propertyName || b.propertyName || "",
      ota: it.ota || null,
      detail: {
        bookingId, guestId: it.guestId || null, checkIn, checkOut,
        otaGuests: it.otaGuests != null ? it.otaGuests : null,
        rosterGuests: rosterNow, stayEnded,
        firstDetectedDate: it.firstDetectedDate || it.lastDetectedDate || null,
      },
      message: stayEnded
        ? `⚠️ (未解消) ${guestName}様(${checkIn}〜${checkOut}): OTA人数${it.otaGuests}名に対し名簿${rosterNow}名のまま滞在が終了しました。清掃費の精算・宿泊税の申告訂正が必要か確認してください。`
        : `⚠️ (未解消) ${guestName}様(${checkIn}〜${checkOut}): 人数不一致が解消されていません(OTA${it.otaGuests}名 / 名簿${rosterNow}名)。`,
      url: guestUrl_(appUrl, it.guestId) || bookingUrl_(appUrl, bookingId),
    });
  }

  return { upserts, closes, carryOver };
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
  const nameMap = propertyNameMap_(properties);
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
      // ★iCal取込の予約は b.propertyName を持たないため、properties マスタから解決する
      propertyName: resolvePropertyName_(nameMap, b.propertyId, b.propertyName),
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
const WARNING_TYPES = new Set([
  "missing_in_ota", "guest_count_mismatch", "guest_count_unresolved", "keybox_unsent", "roster_missing",
]);

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

/**
 * 未解決のダブルブッキング (bookingConflicts.resolved=false) のうち、
 * もう対応しようがないものを選び出す。
 *
 * onBookingChange はキャンセル時にしか conflict を閉じないため、
 *   ・滞在が過ぎただけ (誰も何もしなかった)
 *   ・キャンセル連動 (resolveConflictsOnCancel) が届かなかった
 *   ・予約そのものが削除された
 * のケースが resolved=false のまま残り続ける。夜間監査が毎晩「過去日程の残骸」として
 * 拾い上げてしまうので、朝点検の後処理で機械的に閉じる。
 *
 * 「まだ現行」の判定は監査側 (minpaku-ops-context.mjs の C_doubleBooking) と揃える:
 * ペアのうち1件でも「キャンセルでなく checkOut >= 今日」なら現行 → 触らない。
 *
 * @param {object} o
 * @param {Array<{id:string,bookingIds?:string[]}>} o.conflicts - resolved=false の conflict ドキュメント
 * @param {Map<string,object>} o.bookingsById - bookingId → 予約データ (存在しないIDは未登録)
 * @param {string} o.todayStr - JSTの今日 "YYYY-MM-DD"
 * @returns {{resolvable: Array<{id:string, reason:string}>}}
 */
function selectResolvableConflicts({ conflicts, bookingsById, todayStr }) {
  const isCancelledStatus = isCancelledStatus_;

  const resolvable = [];
  for (const c of conflicts || []) {
    const ids = Array.isArray(c.bookingIds) ? c.bookingIds.filter(Boolean) : [];
    // bookingIds が壊れている/空のドキュメントは判断材料が無いので触らない
    if (ids.length === 0) continue;

    const found = ids.map((id) => bookingsById.get(id)).filter(Boolean);
    if (found.length === 0) {
      resolvable.push({ id: c.id, reason: "bookings_missing" });
      continue;
    }

    const alive = found.filter((b) => !isCancelledStatus(b.status));
    // 予約が消えた/キャンセルされて「重なる相手」が居なくなったら衝突は成立しない
    if (alive.length < 2) {
      resolvable.push({ id: c.id, reason: found.length < ids.length ? "bookings_missing" : "cancelled" });
      continue;
    }

    // 生きている予約が2件以上あっても、滞在が全て過去なら今さら対応できない
    const stillCurrent = alive.some((b) => String(b.checkOut || "") >= todayStr);
    if (!stillCurrent) resolvable.push({ id: c.id, reason: "expired" });
  }
  return { resolvable };
}

/**
 * 「取得できているはずのOTA」がスナップショットから丸ごと欠けていないかを判定する。
 *
 * 背景 (2026-08-17 実障害): listener が Booking.com を取得できなかったのに
 * status="done" / errors=[] でスナップショットを書いたため、Booking の予約が
 * 1件も突合されないまま朝点検が「異常なし0件」と通知していた。
 * counts が 0 なのは「本当に予約が無い」場合もあるので、判定は
 * auditedTargets (listener が実際に取得できた (物件, OTA) ペア) への収載有無で行う。
 *
 * 期待ターゲットは物件マスタの yadozei 設定から導出する:
 *   airbnb  … yadozei.airbnb.enabled かつ listingName または auditListingNames がある
 *   booking … yadozei.booking.enabled かつ propertyId (Booking施設ID) がある
 * (設定が空のものは listener 側も取得対象にできないので期待しない)
 *
 * @param {object} o
 * @param {Array<{id:string,name?:string,yadozei?:object}>} o.properties - 朝点検の対象物件 (active かつ owner_manual 以外)
 * @param {Array<{propertyId:string, ota:string}>} [o.auditedTargets] - スナップショットの auditedTargets。
 *   配列でない (古い形式のスナップショット) 場合は判定材料が無いので missing は空で返す。
 * @returns {{expected: Array, missing: Array<{propertyId:string, propertyName:string, ota:string, otaLabel:string}>}}
 */
function detectMissingOtaSources({ properties = [], auditedTargets } = {}) {
  if (!Array.isArray(auditedTargets)) return { expected: [], missing: [] };

  const expected = [];
  for (const p of properties || []) {
    if (!p || !p.id) continue;
    const y = p.yadozei || {};
    const propertyName = p.name || p.id;

    const ab = y.airbnb || {};
    const hasAirbnbListing = !!String(ab.listingName || "").trim() ||
      (Array.isArray(ab.auditListingNames) && ab.auditListingNames.some((n) => String(n || "").trim()));
    if (ab.enabled === true && hasAirbnbListing) {
      expected.push({ propertyId: p.id, propertyName, ota: "airbnb" });
    }

    const bk = y.booking || {};
    if (bk.enabled === true && String(bk.propertyId || "").trim()) {
      expected.push({ propertyId: p.id, propertyName, ota: "booking" });
    }
  }

  const auditedKeys = new Set(
    auditedTargets.filter((t) => t && t.propertyId && t.ota).map((t) => `${t.propertyId}|${t.ota}`)
  );
  const missing = expected
    .filter((e) => !auditedKeys.has(`${e.propertyId}|${e.ota}`))
    .map((e) => ({ ...e, otaLabel: OTA_TO_SOURCE[e.ota] || e.ota }));

  return { expected, missing };
}

/**
 * スナップショット欠損日の持ち越し (otaSnapshotBacklog) をどう扱うか決める。
 *
 * 背景 (2026-08-01/02 実障害): スナップショットが取れなかった日は突合(①)をスキップして
 * Discordに流すだけだったため、翌日の実行は当日分しか見ず、その日の突合は永久に行われなかった。
 * 欠損日を持ち越し、後からスナップショットが書かれていれば遡って突合する。
 * 取得はPC常駐リスナーの仕事なので、ここでできるのは「諦めずに拾い直す」ことだけ。
 *
 * @param {object} o
 * @param {Array<{date:string}>} o.entries - otaSnapshotBacklog の未解決ドキュメント
 * @param {string} o.todayStr - JSTの今日 "YYYY-MM-DD" (当日分はこの実行で扱うので対象外)
 * @param {number} [o.maxAgeDays=7] - これより古い欠損日は諦めて破棄する
 * @returns {{retry: Array<{date:string}>, expired: Array<{date:string}>}} 日付昇順
 */
function selectSnapshotBacklogActions({ entries = [], todayStr, maxAgeDays = 7 } = {}) {
  const retry = [];
  const expired = [];
  const seen = new Set();
  for (const e of entries || []) {
    const date = e && e.date ? String(e.date) : "";
    if (!date || date >= todayStr) continue; // 当日分は本編で扱う (未来日は異常データなので無視)
    if (seen.has(date)) continue;
    seen.add(date);
    if (daysBetween_(date, todayStr) > maxAgeDays) expired.push({ date });
    else retry.push({ date });
  }
  const byDate = (a, b) => a.date.localeCompare(b.date);
  return { retry: retry.sort(byDate), expired: expired.sort(byDate) };
}

/**
 * finding の同一性キー。遡り突合の結果を当日分と突き合わせて重複を落とすために使う。
 * (同じ予約の同じ指摘を「当日分」と「遡り分」で二重に通知しないため)
 * @param {object} f
 * @returns {string}
 */
function findingKey(f) {
  const d = (f && f.detail) || {};
  return [
    f && f.type, f && f.propertyId, (f && f.ota) || "",
    d.bookingId || "", d.guestId || "", d.code || "",
    d.checkIn || d.otaCheckIn || "", d.guestName || "",
  ].join("|");
}

/**
 * 遡り突合(欠損日の持ち越し)の findings から「今日の突合では拾えないもの」だけを残す。
 *
 * 遡り分は過去日のスナップショットと現在の予約台帳を突き合わせるため、
 * その日以降に入った予約が missing_in_ota として誤検知されうる。
 * 一方でチェックインが今日以降の滞在は当日分の突合が見ているので、遡り分で出す必要がない。
 * → チェックインが今日より前の指摘(＝今日の突合からは落ちるもの)だけを採用する。
 *
 * @param {object} o
 * @param {Array} o.findings - reconcileOtaSnapshot の結果
 * @param {string} o.todayStr - JSTの今日 "YYYY-MM-DD"
 * @returns {Array}
 */
function filterBackfillFindings({ findings = [], todayStr } = {}) {
  return (findings || []).filter((f) => {
    const d = (f && f.detail) || {};
    const ci = d.checkIn || d.otaCheckIn || d.v2CheckIn || "";
    return !!ci && ci < todayStr;
  });
}

/**
 * incoming のうち existing に無いものだけ返す (findingKey で判定)。
 * @param {Array} existing
 * @param {Array} incoming
 * @returns {Array}
 */
function dedupeNewFindings(existing = [], incoming = []) {
  const keys = new Set((existing || []).map(findingKey));
  const out = [];
  for (const f of incoming || []) {
    const k = findingKey(f);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(f);
  }
  return out;
}

/**
 * 「朝点検(7:00)のあとにスナップショットが完成した日」を補完再走すべきかを判定する。
 *
 * 背景 (2026-08-20 実障害): Booking.com はオンデマンド運用で毎晩セッションが失効するため、
 * 2:30 の calendar_audit は Booking を飛ばし partial のままスナップショットを保存する。
 * 朝の再ログイン(7:00ちょうど)で復帰すると listener が calendar_audit を強制再投入し、
 * 7:02 に status=done へ上書きする。ところが morningOtaAudit は 7:00:06 に partial を
 * 読み終えているので、Booking 予約の人数・氏名突合が毎日まるごと抜けていた
 * (実測: 8/20 は Booking 4件が未突合。8/18 も同じ形で partial)。
 *
 * この関数は Firestore に触れず、判断材料だけを受け取って可否を返す
 * (実際の再走は triggers/onOtaSnapshotComplete.js が行う)。
 *
 * @param {object} o
 * @param {string} o.date - 書き込まれたスナップショットの日付 "YYYY-MM-DD"
 * @param {string} o.todayStr - JSTの今日 "YYYY-MM-DD"
 * @param {object|null} o.snapshot - otaCalendarSnapshots/{date} の中身
 * @param {object|null} o.auditResult - otaAuditResults/{date} の中身 (朝点検の結果)
 * @param {Array} [o.missingSources] - detectMissingOtaSources の missing (物件マスタ由来の脱落検知)
 * @param {number} [o.maxRechecks] - 1日あたりの補完再走の上限 (暴走時の保険)
 * @returns {{recheck: boolean, reason: string}}
 */
function shouldRecheckOtaAudit({
  date, todayStr, snapshot, auditResult, missingSources = [], maxRechecks = 3,
} = {}) {
  if (!date || date !== todayStr) return { recheck: false, reason: "not_today" };
  if (!snapshot) return { recheck: false, reason: "no_snapshot" };
  if (snapshot.status !== "done") return { recheck: false, reason: "snapshot_incomplete" };
  // 物件マスタから見て取得漏れが残っているなら、まだ突合し直しても不完全なまま
  if ((missingSources || []).length > 0) return { recheck: false, reason: "still_missing_sources" };
  // 朝点検がまだ走っていない日は何もしない (7:00 の本編が完全なスナップショットで走る)
  if (!auditResult) return { recheck: false, reason: "audit_not_run_yet" };
  // 朝点検が完全なスナップショットで走れていたなら再走は不要
  if (auditResult.snapshotStatus === "done") return { recheck: false, reason: "already_complete" };
  if ((auditResult.recheckCount || 0) >= maxRechecks) return { recheck: false, reason: "max_rechecks" };
  return { recheck: true, reason: "snapshot_completed_after_audit" };
}

module.exports = {
  containsCodeCI,
  propertyNameMap_,
  resolvePropertyName_,
  addDaysStr_,
  daysBetween_,
  reconcileOtaSnapshot,
  detectMissingOtaSources,
  selectSnapshotBacklogActions,
  filterBackfillFindings,
  findingKey,
  dedupeNewFindings,
  collectKeyboxFindings,
  collectRosterFindings,
  buildPropertyReport,
  selectResolvableConflicts,
  evaluateGuestCount,
  selectGuestCountIssueActions,
  shouldRecheckOtaAudit,
};
