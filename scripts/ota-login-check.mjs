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

// 促しの本文。★Booking は数時間で切れるのが常態なので、促しはこの朝4:00 の1本だけに集約している
//   (listener 側は失効を見つけても通知せず記録のみ。2026-07-31 やますけ決定)。
//   そのぶん、この1本に「今日やらないと何が落ちるか」を全部載せる。
function buildPromptBody(expired) {
  const dom = new Date(Date.now() + 9 * 3600 * 1000).getUTCDate(); // JSTの日
  return [
    `🔑 OTAのログインが切れています（${expired.join(" / ")}）。`,
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
  let loggedOut = null;
  try {
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

  const expired = WATCH.filter((name) => loggedOut.includes(name));

  if (expired.length === 0) {
    // 全てログイン中 → pending を掃除して無音終了
    try {
      if (existsSync(PENDING_FILE)) rmSync(PENDING_FILE);
    } catch (_) {}
    console.log(`[ota-login-check] 全てログイン中 (loggedOut=${JSON.stringify(loggedOut)})`);
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
  writePending(expired, body.join("\n"));
  for (const l of body) console.log(`NOTIFY: ${l}`);
  console.log("BUTTONS: ota_relogin"); // 常駐bunがボタン(ログイン画面を開く/リモートデスクトップ/あとで)を添える
  process.exitCode = 0;
})().catch((e) => {
  console.error("ota-login-check 例外:", e.message);
  process.exitCode = 1;
});
