/**
 * OTA(Airbnb/Booking.com)ログイン点検 — Discord秘書の command型ルーチン（毎朝4:00）。
 *
 * 1. yadozeiQueue に session_check を1件投入し(最新状態＋キープアライブ)、完了を待って結果を読む。
 * 2. Airbnb / Booking.com が失効(logged_out)していたら:
 *    - 再ログイン待ちの pending ファイルを書く（handleOne が「はい/いいえ」で拾う）。
 *    - NOTIFY: 行を出力 → 秘書が #民泊管理 へ「再ログインしますか？(はい/いいえ)」を投稿(Chromeリモートデスクトップ URL 付き)。
 * 3. 全てログイン中なら無音(pending は掃除)。
 *
 * firebase-admin は使わない(常駐スクリプトの libuv assert 回避)。gcloud ADC + Firestore REST のみ。
 * process.exit() も使わない(自然終了。exitCode のみ)。
 */
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT = "minpaku-v2";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PENDING_FILE = join(homedir(), ".claude", "channels", "discord", "ota-relogin-pending.json");
const MINPAKU_CHANNEL_ID = "1518754802572722306"; // channels.json: minpaku=民泊管理
const CRD_URL = "https://remotedesktop.google.com/access";
const WATCH = ["Airbnb", "Booking.com"]; // 点検対象(やどぜいは対象外)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 失効を検知したら pending を書く。message はボタン付き投稿の本文(常駐bunが使う)。
// posted=true は「この経路が NOTIFY で本文を出すので、常駐bunの pending 監視は投稿しない」の意。
function writePending(sites, message) {
  try {
    writeFileSync(
      PENDING_FILE,
      JSON.stringify(
        { pending: true, ts: new Date().toISOString(), sites, channelId: MINPAKU_CHANNEL_ID, message, posted: true },
        null, 2
      )
    );
  } catch (e) {
    console.error("pending ファイル書き込み失敗:", e.message);
  }
}
// listener(yadozei-listener)が同じ失効をすでにボタン付きで通知していれば、朝の点検は無音にする。
// 同じ用件が1日に何度も届くのを防ぐ(通知はボタン方式で常に1本)。
// 窓は常駐bun側の pending TTL(12時間)と揃える = ボタンがまだ生きている間は再掲しない。
const PENDING_TTL_MS = 12 * 3600 * 1000;
function alreadyPrompted(sites) {
  try {
    const p = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
    if (!p || !p.pending || !p.ts) return false;
    if (Date.now() - new Date(p.ts).getTime() > PENDING_TTL_MS) return false;
    const a = [...(p.sites || [])].sort().join("|");
    return a === [...sites].sort().join("|");
  } catch { return false; }
}
function token() {
  return execSync("gcloud auth application-default print-access-token", { encoding: "utf8", windowsHide: true }).trim();
}
async function fsGet(path, tok) {
  const r = await fetch(`${FS_BASE}/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
// logged_out 配列を Firestore REST の doc から取り出す（session_check ジョブ result or settings）
function extractLoggedOut(fields) {
  try {
    const sc = fields.result?.mapValue?.fields || fields.sessionCheck?.mapValue?.fields;
    const arr = sc?.loggedOut?.arrayValue?.values || [];
    return arr.map((v) => v.stringValue).filter(Boolean);
  } catch (_) {
    return null;
  }
}

const TEST = process.argv.includes("--test"); // 実際の失効を待たずに NOTIFY+pending 経路を検証する
// --dry-run: 実データで「今日 Booking を催促するか」の判定だけ確認する(session_check を投入せず
//   =ブラウザを起こさず、pending も書かず、NOTIFY も出さない)。判定条件を足したときの検証用。
const DRY = process.argv.includes("--dry-run");
// --assume-expired=Booking.com[,Airbnb]: 失効判定を差し替えて「催促するかどうか」の判定だけを実データで確かめる。
//   Booking は実際に切れている日でないとオンデマンド判定(bookingNeedExists)を通せず、
//   --test は判定を飛ばして通知経路だけ見る作りなので、この2つの間が検証できなかった。
//   --dry-run と併用する前提(単体で使っても pending/NOTIFY までは進むので、検証時は必ず併用する)。
const ASSUME_EXPIRED = (() => {
  const a = process.argv.find((x) => x.startsWith("--assume-expired="));
  return a ? a.slice("--assume-expired=".length).split(",").map((s) => s.trim()).filter(Boolean) : null;
})();

// ★オンデマンド方式(2026-08-16 やますけ決定「無理して取得しない」):
//   Booking のセッションは実測で「約24時間の固定寿命」= 毎日必ず切れる。毎日催促しても
//   ログインの価値は24時間しか持たないので、催促は「本当に必要な時」だけに絞る:
//     (a) 月次CSV取得の窓(毎月1〜3日。宿泊税申告+売上取込の元データ=絶対に必要)
//     (b) yadozeiQueue に Booking を要する未処理ジョブ(ota_message / booking_csv_fetch)が滞留している時
//   それ以外の日は Booking 失効でも無音(仕様どおりの状態なので異常ではない)。
//   日付レベルの予約監視は iCal 同期が常時カバーし、夜間カレンダー監査の Booking 部は
//   ログイン後24時間の窓で自動実行される(recovery 機構)。Airbnb は長寿命なので従来どおり毎回促す。
const BOOKING_CSV_WINDOW_DAYS = [1, 2, 3]; // dispatcher は毎月2日。前日+リトライ余地で1〜3日
// ★2026-08-19 追加(実障害の根治): オンデマンド判定に「失敗ジョブの再実行待ち」と「夜間突合の停止」を足す。
//   実障害: 2026-08-15 19:32 に Booking が失効してから 8/19 まで4日間、月次CSVの窓でもなく
//   pending ジョブも0件だったため一度も催促されず、the Terrace 長浜 の Booking 予約の
//   人数・氏名の突合(calendar_audit)が 2026-08-16 を最後に止まっていた。
//   iCal は氏名も人数も運ばない(guestName="Booking.com予約" / guestCount=0)ので、
//   突合が止まると名簿点検は Booking 分を素通りする = 朝の「⚠️0件」が片肺の偽グリーンになる。
//   ログインすれば当夜の突合で 0 に戻るので、この2条件を足しても催促は最短3日に1回まで。
const BOOKING_RECONCILE_MAX_STALE_DAYS = 3; // 突合がこの日数止まったら催促する
const BOOKING_NEAR_CI_DAYS = 3;             // Booking予約のCIがこの日数以内なら突合1日停止でも催促する
const BOOKING_RETRY_WINDOW_DAYS = 7;        // listener の復帰リトライ対象(7日以内の失敗)と条件を揃える

// Firestore REST の値を素のJSに戻す(最小限)
function decV(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decV(x)]));
  if (v.arrayValue) return (v.arrayValue.values || []).map(decV);
  return null;
}
const decFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decV(v)]));
const jstYmd = (ms = Date.now()) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const addDaysYmd = (ymd, n) => jstYmd(Date.parse(ymd + "T00:00:00Z") + n * 86400000);

async function fsQuery(tok, structuredQuery) {
  const r = await fetch(`${FS_BASE}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!r.ok) throw new Error(`runQuery ${r.status}`);
  const rows = await r.json();
  return (Array.isArray(rows) ? rows : [])
    .filter((x) => x.document)
    .map((x) => ({ _id: x.document.name.split("/").pop(), ...decFields(x.document.fields) }));
}

// Booking の突合(夜間 calendar_audit)が何日止まっているか。
// otaCalendarSnapshots.auditedTargets に booking が入っていた最後の日から数える。
async function bookingReconcileStale(tok) {
  const today = jstYmd();
  for (let i = 0; i <= 10; i++) {
    const ymd = addDaysYmd(today, -i);
    let doc = null;
    try { doc = await fsGet(`otaCalendarSnapshots/${ymd}`, tok); } catch (_) { continue; }
    if (!doc || !doc.fields) continue;
    const targets = decV(doc.fields.auditedTargets) || [];
    if (targets.some((t) => t && t.ota === "booking")) return { days: i, lastDate: ymd };
  }
  return { days: 99, lastDate: null }; // 10日さかのぼっても突合実績なし
}

// 監査対象(yadozei.booking.enabled=true の物件)にある今後の Booking 予約。
// calendar_audit の対象物件の決め方と揃える(他オーナー自主管理のBooking予約で催促しない)。
async function upcomingBookingStays(tok) {
  const props = new Map();
  try {
    const r = await fetch(`${FS_BASE}/properties?pageSize=100&mask.fieldPaths=name&mask.fieldPaths=yadozei`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!r.ok) return [];
    for (const d of (await r.json()).documents || []) {
      const f = decFields(d.fields);
      if (f.yadozei && f.yadozei.booking && f.yadozei.booking.enabled === true) {
        props.set(d.name.split("/").pop(), f.name || "物件");
      }
    }
  } catch (_) { return []; }
  if (!props.size) return [];
  const today = jstYmd();
  let rows = [];
  try {
    rows = await fsQuery(tok, {
      from: [{ collectionId: "bookings" }],
      where: { fieldFilter: { field: { fieldPath: "checkIn" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: today } } },
      limit: 500,
    });
  } catch (_) { return []; }
  return rows
    .filter((b) => props.has(b.propertyId) && /booking/i.test(String(b.source || "")))
    .filter((b) => !/cancel|キャンセル/i.test(String(b.status || "")))
    .map((b) => {
      const ci = String(b.checkIn || "").slice(0, 10);
      return {
        property: props.get(b.propertyId),
        guestName: b.guestName || "",
        checkIn: ci,
        daysToCI: Math.round((Date.parse(ci) - Date.parse(today)) / 86400000),
      };
    })
    .filter((x) => Number.isFinite(x.daysToCI))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
}
async function bookingNeedExists(tok) {
  const dom = new Date(Date.now() + 9 * 3600 * 1000).getUTCDate(); // JSTの日
  if (BOOKING_CSV_WINDOW_DAYS.includes(dom)) return `月次CSV取得の窓(毎月${dom}日)`;
  // yadozeiQueue の pending に Booking を要するジョブが滞留していないか(runQuery)
  try {
    const r = await fetch(`${FS_BASE.replace(/\/documents$/, "")}/documents:runQuery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "yadozeiQueue" }],
          where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
          limit: 50,
        },
      }),
    });
    if (!r.ok) return null; // 判定不能は「必要なし」に倒す(誤って毎朝催促しない)
    const rows = await r.json();
    for (const row of rows || []) {
      const f = row.document?.fields;
      if (!f) continue;
      const kind = f.kind?.stringValue || "";
      const ota = f.ota?.stringValue || "";
      if (kind === "booking_csv_fetch") return "Booking CSV取得ジョブが待機中";
      if (kind === "ota_message" && ota === "booking") return "Booking ゲストへの下書きジョブが待機中";
    }
  } catch (_) {}

  // (c) 未ログインで落ちて「再ログインしたらやり直す」列に並んでいる失敗ジョブ。
  //     listener の復帰リトライ(session_check の retryKinds)と同じ条件で数える。
  //     pending しか見ていなかったため、三山様の下書き(8/13 未ログインで失敗)が7日近く放置されていた。
  try {
    const failed = await fsQuery(tok, {
      from: [{ collectionId: "yadozeiQueue" }],
      where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "failed" } } },
      limit: 500,
    });
    const since = Date.now() - BOOKING_RETRY_WINDOW_DAYS * 86400000;
    const stuck = failed.filter((j) => {
      if (j.retriedAt) return false; // 再投入済み(listener は1回だけやり直す)
      const needsBooking = j.kind === "booking_csv_fetch"
        || (j.kind === "ota_message" && /booking/i.test(String(j.ota || j.source || "")));
      if (!needsBooking) return false;
      if (!/未ログイン|logged.?out|再ログイン/i.test(String(j.error || ""))) return false;
      const created = j.createdAt ? Date.parse(j.createdAt) : 0;
      return created >= since; // 古い失敗は蒸し返さない
    });
    if (stuck.length) {
      const who = stuck.map((j) => j.guestName || j.propertyName).filter(Boolean).slice(0, 2).join("・");
      return `未ログインで落ちた Booking の処理 ${stuck.length}件が再実行待ち${who ? `(${who})` : ""}`;
    }
  } catch (_) {}

  // (d)(e) 夜間の突合(calendar_audit)が止まっている。
  //     Booking は iCal に氏名も人数も乗らないので、突合が止まると名簿点検が Booking を素通りする。
  try {
    const stays = await upcomingBookingStays(tok);
    if (DRY) console.log(`[ota-login-check] 判定材料: 今後のBooking予約 ${stays.length}件` +
      (stays.length ? ` (最短CI ${stays[0].checkIn}・あと${stays[0].daysToCI}日)` : ""));
    if (stays.length) {
      const stale = await bookingReconcileStale(tok);
      if (DRY) console.log(`[ota-login-check] 判定材料: Booking突合の停止日数=${stale.days === 99 ? "10日以上" : stale.days + "日"}` +
        `(最後の突合 ${stale.lastDate || "10日以上前"}) / 催促する閾値=${BOOKING_RECONCILE_MAX_STALE_DAYS}日`);
      const near = stays.filter((s) => s.daysToCI >= 0 && s.daysToCI <= BOOKING_NEAR_CI_DAYS);
      if (near.length && stale.days >= 1) {
        const list = near.map((s) => `${s.checkIn} ${s.guestName || "氏名不明"}`).join("・");
        return `まもなくCIの Booking 予約(${list})の人数・氏名が未突合(突合停止${stale.days}日)`;
      }
      if (stale.days >= BOOKING_RECONCILE_MAX_STALE_DAYS) {
        const span = stale.days === 99 ? "10日以上" : `${stale.days}日`;
        return `Booking予約の突合が${span}止まっている(最後の突合 ${stale.lastDate || "10日以上前"}／今後の予約${stays.length}件が未検査)`;
      }
    }
  } catch (_) {}

  return null;
}

// 促しの本文。オンデマンド方式でも、促すと決めた日は「今日やらないと何が落ちるか」を全部載せる。
function buildPromptBody(expired) {
  const dom = new Date(Date.now() + 9 * 3600 * 1000).getUTCDate(); // JSTの日
  return [
    // 行頭は必ず警報記号(⚠️)で始める。健康監査は見出し行の記号で警報を拾うため、🔑始まりだと検知から漏れる
    `⚠️ **OTAのログインが切れています（${expired.join(" / ")}）** 🔑`,
    // 月次CSV取得は毎月2日(dispatcher)。宿泊税の申告と売上取込の元データなので当日・前日は強調する
    ...(dom === 2
      ? [`🚨 **今日は月次CSV取得日です**（宿泊税の申告と売上取込の元データ）。今日中に直してください。`]
      : dom === 1
        ? [`⚠️ **明日は月次CSV取得日です**（宿泊税・売上の元データ）。`]
        : []),
    `直すと、失効中に失敗していた処理（月次CSV・予約突合・OTA下書き）も自動でやり直します。`,
    `下の**「🔑 ログイン画面を開く」**を押すとメインPCにログイン画面を開きます（不要なら「🆗 あとで」）。`,
    `📱 外出先からは「リモートデスクトップ」ボタンでメインPCに接続して操作できます。`,
  ];
}

(async () => {
  // --test: session_check をスキップし、Booking 失効を強制して通知経路だけ確認する
  // ★本文は本番と同じ buildPromptBody() を使う(別文面だと検証の意味がない)
  if (TEST) {
    const expired = ["Booking.com"];
    const body = buildPromptBody(expired);
    writePending(expired, body.join("\n"));
    for (const l of body) console.log(`NOTIFY: ${l}`);
    console.log("BUTTONS: ota_relogin"); // 常駐bunがボタンを添える(この行は本文から除かれる)
    console.log("[ota-login-check] --test: pending を書き NOTIFY を出力しました(実際のログイン状態は未確認)。");
    process.exitCode = 0;
    return;
  }

  let tok;
  try {
    tok = token();
  } catch (e) {
    console.error("gcloud ADC token 取得失敗:", e.message);
    process.exitCode = 1;
    return;
  }

  // 1) session_check を新規投入(ユニークID=常に実行される)
  const jobId = `session_check_otalogincheck_${Date.now()}`;
  let loggedOut = ASSUME_EXPIRED;
  if (ASSUME_EXPIRED) console.log(`[ota-login-check] --assume-expired: 失効を ${ASSUME_EXPIRED.join("/")} とみなして判定します(実際のログイン状態は見ません)`);
  if (DRY && !ASSUME_EXPIRED) console.log("[ota-login-check] --dry-run: session_check は投入しません(settings の最新状態で判定)");
  if (!DRY && !ASSUME_EXPIRED) try {
    const body = {
      fields: {
        kind: { stringValue: "session_check" },
        status: { stringValue: "pending" },
        source: { stringValue: "ota_login_check" },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    };
    const r = await fetch(`${FS_BASE}/yadozeiQueue?documentId=${jobId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok && r.status !== 409) console.error("session_check 投入失敗:", r.status, (await r.text()).slice(0, 160));

    // 2) 完了までポーリング(最大 ~150s。4時は queue が空いているので通常30-60s)
    for (let i = 0; i < 50; i++) {
      await sleep(3000);
      const doc = await fsGet(`yadozeiQueue/${jobId}`, tok);
      const st = doc?.fields?.status?.stringValue;
      if (st === "done" || st === "failed") {
        loggedOut = extractLoggedOut(doc.fields);
        break;
      }
    }
  } catch (e) {
    console.error("session_check 実行中エラー:", e.message);
  }

  // フォールバック: session_check の結果が読めなければ settings/yadozeiListener の最新状態を使う
  if (loggedOut === null) {
    try {
      const s = await fsGet("settings/yadozeiListener", tok);
      if (s?.fields) loggedOut = extractLoggedOut(s.fields);
    } catch (_) {}
  }
  if (loggedOut === null) loggedOut = []; // 判定不能なら「切れていない」扱い(誤って毎朝催促しない)

  let expired = WATCH.filter((name) => loggedOut.includes(name));

  // ★オンデマンド方式: Booking の失効は毎日必ず起きる(24h固定寿命)ので、
  //   「今日 Booking が必要」な時だけ催促対象に含める。Airbnb は常に対象。
  let bookingNeed = null;
  if (expired.includes("Booking.com")) {
    bookingNeed = await bookingNeedExists(tok);
    if (!bookingNeed) {
      console.log("[ota-login-check] Booking.com は失効中だが今日必要な処理が無いため催促しない(オンデマンド方式)");
      expired = expired.filter((n) => n !== "Booking.com");
    } else {
      console.log(`[ota-login-check] Booking.com 催促理由: ${bookingNeed}`);
    }
  }

  if (expired.length === 0) {
    // 全てログイン中 → pending を掃除して無音終了
    try {
      if (!DRY && existsSync(PENDING_FILE)) rmSync(PENDING_FILE);
    } catch (_) {}
    console.log(`[ota-login-check] 催促対象なし (loggedOut=${JSON.stringify(loggedOut)})`);
    process.exitCode = 0;
    return;
  }

  // 3) 失効あり → 直前に同じ失効をボタンで通知済みなら無音、そうでなければ pending 更新＋NOTIFY 出力
  if (alreadyPrompted(expired)) {
    console.log(`[ota-login-check] ${expired.join("/")} は通知済み(20時間以内・ボタン待ち)のため無音`);
    process.exitCode = 0;
    return;
  }
  const body = buildPromptBody(expired);
  if (bookingNeed && !/月次CSV/.test(bookingNeed)) body.splice(1, 0, `📌 理由: ${bookingNeed}`);
  if (DRY) {
    console.log(`[ota-login-check] --dry-run: 催促する判定です (${expired.join("/")})。pending は書かず NOTIFY も出しません`);
    for (const l of body) console.log(`  | ${l}`);
    process.exitCode = 0;
    return;
  }
  writePending(expired, body.join("\n"));
  for (const l of body) console.log(`NOTIFY: ${l}`);
  console.log("BUTTONS: ota_relogin"); // 常駐bunがボタン(ログイン画面を開く/リモートデスクトップ/あとで)を添える
  process.exitCode = 0;
})().catch((e) => {
  console.error("ota-login-check 例外:", e.message);
  process.exitCode = 1;
});
