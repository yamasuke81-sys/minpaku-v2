/**
 * ota-message.mjs の Booking スレッド選択ロジックの回帰テスト（モックPlaywright）。
 * 2026-08-15 の誤スレッド事故（入江真紀様 6084082902 → 6507661176 が開いた）を再現し、
 * 修正後の挙動を検証する。
 *
 * ★2026-08-19: 実装が page.evaluate / evaluateHandle 主体に変わったため、モックも
 *   「渡された関数のソースで何を問い合わせているか」を判別して答える方式に更新した。
 *   受信箱タブの判定そのもの（aria-selected を持たないUIでも選択中タブを見分けられるか）は
 *   実DOMでないと意味が無いので ota-message.tabdetect.test.mjs（実ブラウザ）側で担保する。
 */
process.env.OTA_THREAD_MATCH_TIMEOUT_MS ||= "1500"; // テストを待たせない
process.env.OTA_THREAD_MATCH_ROUNDS ||= "2";
const { handleOtaMessage } = await import("./ota-message.mjs");

function makePage(state) {
  const log = state.log;
  const mkLoc = (kind) => {
    const matchCount = () => {
      switch (kind) {
        case "login": return 0;
        case "searchbox": return state.searchBox ? 1 : 0;
        case "dialog": return 0; // Booking の被せ物は role="dialog" を持たない(実測)
        case "guest-tab": return state.guestTabClickable ? 1 : 0;
        default: return 0;
      }
    };
    const obj = {
      first: () => obj,
      count: async () => matchCount(),
      isVisible: async () => matchCount() > 0,
      click: async () => {
        if (matchCount() === 0) throw new Error("not found");
        if (kind === "guest-tab") {
          if (state.modal) throw new Error("intercepted by overlay"); // 被せ物がクリックを飲む
          state.tab = "guest";
          log.push("tab:guest");
        }
      },
      fill: async () => {},
      getByRole: (role, o) => page.getByRole(role, o),
      locator: (sel) => page.locator(sel),
    };
    return obj;
  };

  // 開いているスレッドの予約番号。候補クリック後の SPA 描画遅延を readsLeft で再現する。
  const currentRes = () => {
    if (state.pendingRes != null) {
      if ((state.readsLeft ?? 0) <= 0) {
        state.openedRes = state.pendingRes;
        state.pendingRes = null;
      } else state.readsLeft--;
    }
    return state.openedRes || "";
  };

  const page = {
    url: () => "https://admin.booking.com/inbox",
    goto: async () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {}, type: async () => {} },
    close: async () => {},
    bringToFront: async () => {},
    title: async () => "inbox",
    isClosed: () => false,
    locator: (sel) => {
      if (/Sign in to manage|loginname/.test(sel)) return mkLoc("login");
      if (/placeholder\*="予約番号"/.test(sel)) return mkLoc("searchbox");
      if (/role="dialog"/.test(sel)) return mkLoc("dialog");
      return mkLoc("none");
    },
    getByRole: (role, o) => {
      const n = o && o.name ? String(o.name) : "";
      if (/ゲスト/.test(n)) return mkLoc("guest-tab");
      return mkLoc("none");
    },
    getByText: (t) => (/ゲスト/.test(String(t)) ? mkLoc("guest-tab") : mkLoc("none")),
    // 実装が page.evaluate に渡す関数のソースで用途を判別して答える
    evaluate: async (fn) => {
      const src = String(fn);
      if (/zIndex/.test(src)) {
        // dismissBookingOverlays: role を持たない被せ物を閉じる
        if (state.modal) { state.modal = false; log.push("modal:closed"); return true; }
        return false;
      }
      // readBookingInboxTab: 受信箱タブの実測結果
      if (/カスタマーサービス/.test(src)) return { active: state.tab, hasGuest: true, hasCs: true };
      if (/el\.click\(\)/.test(src)) {
        // selectBookingGuestTab の DOM 直叩き（最後の一押し）
        if (state.guestTabClickable && !state.modal) { state.tab = "guest"; log.push("tab:guest(dom)"); }
        return undefined;
      }
      if (/予約番号/.test(src)) return currentRes();
      return "";
    },
    evaluateHandle: async (fn, arg) => {
      const src = String(fn);
      if (/hits\.sort/.test(src)) {
        // 候補（予約番号を含む最小要素）の探索
        const list = state.threadsByTab[state.tab] || [];
        if (state.modal || !list.includes(arg)) return { asElement: () => null, dispose: async () => {} };
        return {
          asElement: () => ({
            click: async () => {
              log.push("thread:click " + arg);
              if (state.neverSwitch) return; // 押せてもスレッドが切り替わらないケース
              state.pendingRes = arg;
              state.readsLeft = state.switchReads ?? 0;
            },
            evaluate: async () => {},
            dispose: async () => {},
          }),
          dispose: async () => {},
        };
      }
      // findComposer
      return {
        asElement: () => ({
          fill: async () => { state.composerFilled = true; },
          click: async () => {},
          evaluate: async () => (state.composerFilled ? state.body : ""),
          dispose: async () => {},
        }),
        dispose: async () => {},
      };
    },
  };
  return page;
}

const deps = {
  db: { collection: () => ({ doc: () => ({ set: async () => {} }) }) },
  admin: { firestore: { FieldValue: { serverTimestamp: () => "TS" } } },
  notifyDiscord_: async () => {},
  queueButtonedNotice_: async () => {},
  saveScreenshot: async (_p, _j, tag) => { SHOTS.push(tag); return "shot_" + tag + ".png"; },
  draftPages: new Set(),
  LOG_PREFIX: "[test]",
};

let SHOTS = [];
const JOB = {
  kind: "ota_message", ota: "booking", reservationCode: "6084082902",
  guestName: "入江真紀", checkIn: "2026-08-22", checkOut: "2026-08-24",
  message: "チェックイン案内です", guestId: "g1", propertyName: "the Terrace 長浜",
};

async function run(name, state, expect) {
  SHOTS = [];
  state.log = [];
  const ctx = { newPage: async () => makePage(state) };
  let err = null, res = null;
  try {
    res = await handleOtaMessage(JOB, ctx, "testjob", deps);
  } catch (e) {
    err = e;
  }
  const ok = expect(res, err, state);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      err=${err && err.message} res=${JSON.stringify(res)} log=${state.log.join("|")} shots=${SHOTS.join(",")}`);
  else console.log(`      → ${err ? "中止: " + err.message : "下書き作成: " + JSON.stringify(res)}`);
  return ok;
}

const results = [];

// ① 事故再現: CSタブ着地・被せ物あり・ゲストタブにも該当スレッド無し
//    → 別スレッド(6507661176)に下書きを書かず、明確な理由で中止すること
results.push(await run(
  "事故再現: 該当スレッドが存在しない → 誤爆せず中止",
  { tab: "cs", modal: true, searchBox: true, guestTabClickable: true,
    openedRes: "6507661176", threadsByTab: { cs: ["6507661176"], guest: ["9999999999"] } },
  (res, err, st) =>
    !!err && /候補が出なかった/.test(err.message) && st.openedRes === "6507661176" && !st.composerFilled
));

// ② 修正の本命: CSタブ着地＋被せ物ありでも、被せ物を閉じ→ゲストタブへ切替→正しいスレッドで下書き
results.push(await run(
  "修正後: 被せ物を閉じ CSタブ→ゲストタブへ切替して正しいスレッドで下書き",
  { tab: "cs", modal: true, searchBox: true, guestTabClickable: true,
    openedRes: "6507661176", body: "チェックイン案内です",
    threadsByTab: { cs: ["6507661176"], guest: ["6084082902"] } },
  (res, err, st) =>
    !err && res && res.drafted && st.openedRes === "6084082902" && st.tab === "guest" && st.composerFilled
));

// ③ ゲストタブに切り替えられない（UI変更）→ 中止し、理由をエラー本文に残すこと
results.push(await run(
  "ゲストタブへ切替不能 → 中止(理由がエラー本文に残る)",
  { tab: "cs", modal: false, searchBox: true, guestTabClickable: false,
    openedRes: "6507661176", threadsByTab: { cs: ["6507661176"], guest: [] } },
  (res, err, st) => !!err && /ゲストタブに切替できず/.test(err.message) && !st.composerFilled
));

// ④ 既にゲストタブ・該当スレッドあり → 正常に下書き
results.push(await run(
  "正常系: ゲストタブ・該当スレッドあり",
  { tab: "guest", modal: false, searchBox: true, guestTabClickable: true,
    openedRes: "", body: "チェックイン案内です",
    threadsByTab: { guest: ["6084082902"] } },
  (res, err, st) => !err && res && res.drafted && st.openedRes === "6084082902"
));

// ⑤ 候補は押せたのにスレッドが切り替わらない → 旧スレッドに書かず中止すること
results.push(await run(
  "候補は押せたがスレッドが切り替わらない → 誤爆せず中止",
  { tab: "guest", modal: false, searchBox: true, guestTabClickable: true, neverSwitch: true,
    openedRes: "6507661176", threadsByTab: { guest: ["6084082902"] } },
  (res, err, st) =>
    !!err && /スレッドが切り替わらなかった/.test(err.message) && st.openedRes === "6507661176" && !st.composerFilled
));

// ⑥ 根治の核心: 右パネルの描画が遅れても「不一致」と誤判定せず、待ってから下書きすること
//    （旧実装は固定2.8秒後の一発読みで、描画待ちを不一致と取り違えていた）
results.push(await run(
  "スレッド描画が遅れてもポーリングで待って下書き",
  { tab: "guest", modal: false, searchBox: true, guestTabClickable: true, switchReads: 5,
    openedRes: "6507661176", body: "チェックイン案内です",
    threadsByTab: { guest: ["6084082902"] } },
  (res, err, st) => !err && res && res.drafted && st.openedRes === "6084082902" && st.composerFilled
));

console.log("\n" + (results.every(Boolean) ? "ALL PASS (" + results.length + "/" + results.length + ")" : "SOME FAILED"));
process.exit(results.every(Boolean) ? 0 : 1);
