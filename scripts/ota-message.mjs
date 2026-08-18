/**
 * OTA(Airbnb / Booking.com)ゲストへの「名簿確認取れました」定型メッセージの【下書き作成】ハンドラ。
 *
 * ★2026-07-31 仕様変更（やますけ決定）: プログラムからの自動送信は廃止した。
 *   このワーカーがやるのは「実スレッドを開いて文面を入力し、下書きのまま残す」ところまで。
 *   そのうえで Discord に ①文面（コピー用）②スレッドを開くボタン ③入力後のスクショ を1本投稿し、
 *   やますけが開いて【送信ボタンを押すだけ】で完了する。送信ボタンを押すコードはこのファイルに存在しない。
 *
 * yadozei-listener の直列ドレインに相乗りする隔離モジュール（CSV系コードには一切触れない）。
 * handleJob が kind==="ota_message" のジョブでこの handleOtaMessage を呼ぶ。
 * ブラウザ context / ログイン資産（Airbnb・Booking extranet）は yadozei-listener のものを再利用。
 *
 * ジョブ形状（Cloud Function onKeyboxConfirmed が投入）:
 *   { kind:"ota_message", ota:"airbnb"|"booking", reservationCode(HM|予約番号|null),
 *     guestName, checkIn, checkOut, message(完成本文), guideUrl, guestId, propertyId, propertyName,
 *     params?: { dryRun?: boolean } }
 *
 * dryRun=true のときは「遷移＋メッセージ入力欄の検出＋スクショ」までで入力もしない（選択子検証用）。
 */

/** 下書きの自動保存（デバウンス）が効くのを待つ時間。 */
const DRAFT_SETTLE_MS = 4000;
/** Booking スレッド切替の待ち上限とやり直し回数（テストから短縮できるよう環境変数で上書き可能）。 */
const THREAD_MATCH_TIMEOUT_MS = Number(process.env.OTA_THREAD_MATCH_TIMEOUT_MS || 15_000);
const THREAD_MATCH_ROUNDS = Number(process.env.OTA_THREAD_MATCH_ROUNDS || 3);
/** 未送信の下書きページを開いたまま保持する上限。これを過ぎたら掃除して閉じる。 */
const DRAFT_PAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * メッセージ入力欄を探す（ElementHandle を返す）。
 * ★ホストの「メモ」欄（ご自身用にメモ…）を絶対に掴まないよう除外する。
 *   予約詳細カードにはメモ用 textarea があり、これに書くとゲストに届かず私的メモになる重大事故になる。
 */
async function findComposer(page) {
  const handle = await page.evaluateHandle(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    const attrs = (el) =>
      ((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
    const isMemo = (el) => {
      const s = attrs(el);
      return s.includes("メモ") || s.includes("ご自身用") || s.includes("note");
    };
    const cands = [...document.querySelectorAll('textarea, div[contenteditable="true"], [role="textbox"]')]
      .filter(vis)
      .filter((e) => !isMemo(e));
    // メッセージらしい（placeholder/aria-label に「メッセージ/message」）を優先
    const byMsg = cands.find((e) => /メッセージ|message/i.test(attrs(e)));
    return byMsg || cands[0] || null;
  });
  const el = handle.asElement ? handle.asElement() : null;
  if (!el) {
    try {
      await handle.dispose();
    } catch (_) {}
    return null;
  }
  return el;
}

/** コンポーザが描画されるまでポーリングで待つ（SPAのスレッド読み込み待ち） */
async function waitForComposer(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await findComposer(page);
    if (c) return c;
    await page.waitForTimeout(1000);
  }
  return null;
}

/**
 * 入力欄(ElementHandle)に本文をセットする。
 * ★Enter=送信のUIなので改行キーは絶対に押さない（誤送信になる）。fill で直接値を入れ、
 *   fill 不可な contenteditable のみ Shift+Enter で改行する。
 */
async function fillComposer(page, composer, message) {
  try {
    await composer.fill(message);
    return true;
  } catch (_) {
    await composer.click().catch(() => {});
    const parts = message.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await page.keyboard.press("Shift+Enter").catch(() => {});
      await page.keyboard.type(parts[i], { delay: 6 }).catch(() => {});
    }
    return true;
  }
}

/** 入力欄に本文が残っているか（＝下書きが成立しているか）を確認する */
async function readComposerText(composer) {
  try {
    return await composer.evaluate((el) =>
      el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value || "" : el.innerText || el.textContent || ""
    );
  } catch (_) {
    return "";
  }
}

/** ---- Airbnb: 予約詳細ページ(HMコード)のスレッドに下書きを入れる ---- */
async function sendAirbnb(page, { reservationCode, message, jobId, dryRun, saveScreenshot }) {
  if (!reservationCode) throw new Error("Airbnb: 確認コード(HM…)が無く予約を特定できません");
  await page.goto(`https://www.airbnb.com/hosting/reservations/details/${reservationCode}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  // details/{HM} の着地は不安定（メッセージスレッド / 予約詳細カード / 今日一覧 のいずれか）。
  // 明確なシグナル（コンポーザ / 「メッセージを送信」ボタン / ログインフォーム）が出るまで待って分岐する。
  // ★ログイン判定は URL 文字列だと redirect バウンスで誤検知するため、パスワード欄の可視で判定する。
  let composer = null;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
      await saveScreenshot(page, jobId, "airbnb_msg_not_logged_in");
      throw new Error("Airbnb 未ログイン（再ログインが必要）");
    }
    // スレッドに着地済みなら入力欄がある（メモ欄は findComposer が除外）
    composer = await findComposer(page);
    if (composer) break;
    // 予約カード着地なら「メッセージを送信」でスレッドを開く
    const openBtn = page.getByRole("button", { name: /メッセージを送信|ゲストにメッセージ|Message guest/ }).first();
    if (await openBtn.count().catch(() => 0)) {
      await openBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
      composer = await waitForComposer(page, 12_000);
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!composer) {
    await saveScreenshot(page, jobId, "airbnb_msg_no_composer");
    throw new Error("Airbnb メッセージ入力欄が見つかりません（着地不安定/UI変更・要live-tune）");
  }

  // 検出した入力欄の素性をログに出す（メモ欄を掴んでいないかの検証用）
  try {
    const info = await composer.evaluate((el) => ({
      tag: el.tagName,
      role: el.getAttribute("role"),
      ph: el.getAttribute("placeholder"),
      al: el.getAttribute("aria-label"),
    }));
    console.log(`[ota_message] Airbnb composer =`, JSON.stringify(info));
  } catch (_) {}

  if (dryRun) {
    await saveScreenshot(page, jobId, "airbnb_msg_dryrun_composer");
    return { drafted: false, threadUrl: page.url() };
  }

  await fillComposer(page, composer, message);
  // 下書きの自動保存（デバウンス）が走るのを待ってから閉じる
  await page.waitForTimeout(DRAFT_SETTLE_MS);
  const left = await readComposerText(composer);
  const shotPath = await saveScreenshot(page, jobId, "airbnb_msg_drafted");
  return {
    drafted: true,
    // 入力済みスレッドの実URL（Discordの「開く」ボタンはこれを使う。着地パターンによって details/… とは限らない）
    threadUrl: page.url(),
    composerHasText: left.trim().length > 0,
    shotPath,
  };
}

/** 開いている Booking スレッドの右パネル「予約番号」を読む（誤送信防止の検証用） */
async function readBookingReservationNo(page) {
  try {
    return await page.evaluate(() => {
      const leaves = [...document.querySelectorAll("*")].filter(
        (e) => e.children.length === 0 && /予約番号/.test(e.textContent || "")
      );
      for (const label of leaves) {
        let node = label;
        for (let up = 0; up < 3 && node; up++) {
          const m = (node.textContent || "").match(/予約番号[:：\s]*?(\d{8,12})/);
          if (m) return m[1];
          node = node.parentElement;
        }
      }
      const m2 = (document.body.textContent || "").match(/予約番号[:：\s]*(\d{8,12})/);
      return m2 ? m2[1] : "";
    });
  } catch (_) {
    return "";
  }
}

/**
 * Booking extranet に出る被せ物（モーダル／案内バナー）を閉じる。
 * ★2026-08-18: 「予約に関するサポート関連メッセージ」モーダルが受信箱の上に出ており、
 *   タブ切替や候補クリックを飲み込んでいた（誤スレッド事故 fQMWeAVI91Kj81XfLeMc の一因）。
 * ★2026-08-19 根治: そのモーダルは role="dialog" も aria-modal も持たない実装で、
 *   旧コードの `[role="dialog"], [aria-modal="true"]` では1枚も掴めていなかった
 *   （失敗スクショ fQMWeAVI91Kj81XfLeMc_booking_msg_wrong_thread で実測）。
 *   role に頼らず「画面に固定表示された高z-indexの被せ物」を実測で拾い、その中の
 *   OK/閉じるを押す方式に変える。
 */
async function dismissBookingOverlays(page) {
  for (let i = 0; i < 4; i++) {
    let closed = false;
    // ① role を持つ正統なダイアログ
    const dialog = page.locator('[role="dialog"], [aria-modal="true"]').first();
    if (await dialog.count().catch(() => 0)) {
      for (const btn of [
        dialog.getByRole("button", { name: /^\s*OK\s*$/i }),
        dialog.getByRole("button", { name: /閉じる|close|了解|同意/i }),
        dialog.locator('[aria-label*="閉じる"], [aria-label*="lose"]'),
      ]) {
        const b = btn.first();
        if (await b.count().catch(() => 0)) {
          await b.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(800);
          closed = true;
          break;
        }
      }
    }
    // ② role を持たない被せ物（Booking の「予約に関するサポート関連メッセージ」等）を実測で閉じる
    if (!closed) {
      closed = await page
        .evaluate(() => {
          const vis = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 40 && r.height > 40;
          };
          const overlays = [...document.querySelectorAll("div, section, aside")].filter((el) => {
            if (!vis(el)) return false;
            const cs = getComputedStyle(el);
            if (cs.position !== "fixed" && cs.position !== "absolute") return false;
            return (parseInt(cs.zIndex, 10) || 0) >= 10;
          });
          for (const ov of overlays) {
            const btn = [...ov.querySelectorAll('button, [role="button"], a')].find((b) => {
              const t = (b.textContent || "").replace(/\s+/g, " ").trim();
              const al = (b.getAttribute("aria-label") || "").trim();
              return /^(OK|了解|閉じる|同意する|Close|Got it)$/i.test(t) || /閉じる|close/i.test(al);
            });
            if (btn) {
              btn.click();
              return true;
            }
          }
          return false;
        })
        .catch(() => false);
      if (closed) await page.waitForTimeout(800);
    }
    if (!closed) break;
  }
  // 残っていれば Escape で最後の一押し（掴めない被せ物への保険）
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * 受信箱のタブ（ゲスト / カスタマーサービス）のうち、いま選択されているのはどれかを実測で読む。
 * ★aria-selected を持たない実装（Booking の現行UI）でも判定できるよう、
 *   aria-selected / aria-current / class名 / 下線 / 太さ を「2つのタブの差」として比較する。
 *   タブ帯そのものに付く下線のような共通スタイルは両方に加点されて相殺されるため誤判定しない。
 * @returns {Promise<{active:"guest"|"cs"|null, hasGuest:boolean, hasCs:boolean}>}
 */
async function readBookingInboxTab(page) {
  try {
    return await page.evaluate(() => {
      const labelOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
      const cands = [...document.querySelectorAll('[role="tab"], a, button, li, span, div')].filter((el) => {
        if (el.children.length > 2) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10 || r.top > 700) return false;
        // 末尾に未読バッジの数字が付くことがある（例: 「カスタマーサービス 1」）
        return /^(ゲスト|カスタマーサービス)(\s*\d+)?$/.test(labelOf(el));
      });
      const score = (el) => {
        let s = 0;
        for (let n = el, up = 0; n && up < 3; n = n.parentElement, up++) {
          const sel = n.getAttribute?.("aria-selected");
          if (sel === "true") s += 100;
          if (sel === "false") s -= 40;
          if (n.getAttribute?.("aria-current")) s += 90;
          if (/(^|[\s_-])(active|selected|current)([\s_-]|$)/i.test(String(n.className || ""))) s += 80;
        }
        const cs = getComputedStyle(el);
        const par = el.parentElement ? getComputedStyle(el.parentElement) : null;
        const bw = Math.max(parseFloat(cs.borderBottomWidth) || 0, par ? parseFloat(par.borderBottomWidth) || 0 : 0);
        if (bw >= 2) s += 30;
        s += (parseInt(cs.fontWeight, 10) || 400) / 100; // 太字は弱いシグナル（同点崩し）
        return s;
      };
      const best = { guest: null, cs: null };
      for (const el of cands) {
        const k = labelOf(el).startsWith("ゲスト") ? "guest" : "cs";
        const v = score(el);
        if (best[k] === null || v > best[k]) best[k] = v;
      }
      const res = { active: null, hasGuest: best.guest !== null, hasCs: best.cs !== null };
      if (best.guest !== null && best.cs !== null) {
        if (best.guest > best.cs) res.active = "guest";
        else if (best.cs > best.guest) res.active = "cs";
      } else if (best.guest !== null) res.active = "guest";
      return res;
    });
  } catch (_) {
    return { active: null, hasGuest: false, hasCs: false };
  }
}

/**
 * 受信箱の「ゲスト」タブを選択する。
 * ★2026-08-18 判明: 受信箱は「ゲスト」「カスタマーサービス」の2タブ構成で、着地時に
 *   【カスタマーサービス】タブが開いていることがある。ゲスト宛の予約スレッドはここには
 *   存在しないため、予約番号で検索しても該当スレッドは開けず、既定選択された最上位の
 *   サポートスレッド（別客・別予約番号）が開いたままになる。
 * ★2026-08-19 根治: 旧実装は「カスタマーサービスが aria-selected=true でなければ成功」と
 *   みなしていたが、Booking のタブは aria-selected を持たない（ローカル再現で count=0 を確認）。
 *   そのため常に成功と誤判定し、カスタマーサービスタブのまま検索していた
 *   ＝入江真紀様 8/22CI の下書きが2回とも作れなかった実障害の本体。
 *   いまは「ゲストタブが実際に選択された」ことを実測して判定する。
 * @returns {Promise<boolean>} ゲストタブを選択できた（またはタブUIが無い）か
 */
async function selectBookingGuestTab(page) {
  let st = await readBookingInboxTab(page);
  // タブUIが見当たらない（単一受信箱UI）ときは素通し。誤爆は後段の予約番号一致検証が止める
  if (!st.hasGuest && !st.hasCs) return true;
  if (st.active === "guest") return true;

  for (let attempt = 0; attempt < 4; attempt++) {
    await dismissBookingOverlays(page);
    let clicked = false;
    for (const tab of [
      page.getByRole("tab", { name: /^\s*ゲスト\s*$/ }),
      page.getByRole("link", { name: /^\s*ゲスト\s*$/ }),
      page.getByText(/^\s*ゲスト\s*$/),
    ]) {
      const t = tab.first();
      if (!(await t.count().catch(() => 0))) continue;
      try {
        await t.click({ timeout: 4000 });
        clicked = true;
      } catch (_) {
        /* 被せ物にクリックを飲まれた等。次の候補・次の周回で拾い直す */
      }
      if (clicked) break;
    }
    // Playwright のクリックが通らない場合の最後の一押し（DOM直叩き）
    if (!clicked) {
      await page
        .evaluate(() => {
          const el = [...document.querySelectorAll('[role="tab"], a, button, li, span, div')].find(
            (e) => e.children.length <= 2 && /^ゲスト(\s*\d+)?$/.test((e.textContent || "").replace(/\s+/g, " ").trim())
          );
          if (el) el.click();
        })
        .catch(() => {});
    }
    await page.waitForTimeout(2000);
    st = await readBookingInboxTab(page);
    if (st.active === "guest") return true;
  }
  return false;
}

/** 右パネルの「予約番号」が目標に切り替わるまでポーリングし、最後に読めた値を返す。
 *  ★固定待ち(2.8秒)の一発読みだと「まだ前のスレッドが描画されている」だけの状態を
 *    不一致と誤判定しうるため、待ちを取り違えないようポーリングにする。 */
async function waitBookingReservationNo(page, want, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await readBookingReservationNo(page);
    if (last === want) return last;
    await page.waitForTimeout(1000);
  }
  return last;
}

// 受信箱タブ判定と被せ物処理は実DOMでしか検証できないため、回帰テスト
// (ota-message.tabdetect.test.mjs) から直接叩けるように公開する。
export { readBookingInboxTab, selectBookingGuestTab, dismissBookingOverlays };

/** ---- Booking.com: extranet で該当予約のメッセージスレッドを開いて下書きを入れる ---- */
async function sendBooking(page, { message, guestName, reservationCode, checkIn, jobId, dryRun, saveScreenshot }) {
  // lang=ja を明示（アカウント言語が英語だと日本語セレクタが一致しないため。CSV取得と同方針）
  await page.goto("https://admin.booking.com/?lang=ja", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  const loggedOut =
    /account\.booking\.com|\/(login|signin|sign-in|sign_in)/i.test(page.url()) ||
    (await page
      .locator(':text("Sign in to manage"), :text("パートナーアカウント"), input[name="username"], input[name="loginname"]')
      .first()
      .count()
      .catch(() => 0)) > 0;
  if (loggedOut) {
    await saveScreenshot(page, jobId, "booking_msg_not_logged_in");
    throw new Error("Booking.com extranet 未ログイン（再ログインが必要）");
  }

  // 受信箱=上部ナビ「メールボックス」ドロップダウン →「予約に関するメッセージ」。
  // 着地が不安定なので、検索ボックスが出る(=受信箱到達)まで最大3回リトライする。
  const inboxReached = async () =>
    (await page.locator('input[placeholder*="予約番号"], input[placeholder*="名前"]').first().count().catch(() => 0)) > 0;
  let onInbox = await inboxReached();
  for (let attempt = 0; attempt < 3 && !onInbox; attempt++) {
    for (const mail of [
      page.getByRole("button", { name: /メールボックス/ }),
      page.getByRole("link", { name: /メールボックス/ }),
      page.getByText("メールボックス", { exact: true }),
    ]) {
      const m = mail.first();
      if (await m.count().catch(() => 0)) {
        await m.click().catch(() => {});
        await page.waitForTimeout(1500);
        break;
      }
    }
    const resMsg = page.getByRole("link", { name: /予約に関するメッセージ/ }).first();
    if (await resMsg.count().catch(() => 0)) {
      await resMsg.click().catch(() => {});
      await page.waitForTimeout(3000);
    }
    onInbox = await inboxReached();
    if (!onInbox) await page.waitForTimeout(1500);
  }
  if (!onInbox) {
    await saveScreenshot(page, jobId, "booking_msg_no_inbox");
    throw new Error("Booking メッセージ受信箱に到達できません（メールボックス→予約に関するメッセージ・要調整）");
  }
  // ★被せ物を先に片付ける（モーダルがタブ切替・候補クリックを飲み込むため）
  await dismissBookingOverlays(page);

  // 予約番号でスレッドを特定する（最も確実。extranet の名前はローマ字表記で名簿の漢字と一致しないため使わない）。
  // 検索ボックスは「オートコンプリート」で、予約番号を打つと候補「(ローマ字名) - (予約番号)」が出る。
  // ★Enterではなくこの候補をクリックするとスレッドが開く。
  //
  // ★2026-08-19 根治（入江真紀様 6084082902・8/22CI が2回とも下書きできなかった実障害）:
  //   旧実装の穴は3つあった。
  //   ① ゲストタブ切替の成否を誤判定し、カスタマーサービスタブのまま検索していた
  //      （タブ判定は selectBookingGuestTab / readBookingInboxTab 側で根治）。
  //   ② 候補クリックの例外を握り潰したうえで無条件に picked=true にしていたため、
  //      被せ物にクリックを飲まれても「候補を開けた」ことにしていた。
  //   ③ 右パネルの予約番号を固定2.8秒後に一度だけ読んでいた。
  //   いまは「タブを押し直す→候補を最小要素で掴む→クリック成否を見る→予約番号が
  //   目標に変わるまでポーリング」を最大3周する。3周しても一致しなければ従来どおり中止する。
  if (!reservationCode) {
    await saveScreenshot(page, jobId, "booking_msg_no_resno");
    throw new Error("Booking 予約番号が取得できずスレッドを安全に特定できないため中止（手動で送ってください）");
  }

  let openedNo = "";
  let tabState = await readBookingInboxTab(page);
  let suggestionSeen = false;
  for (let round = 0; round < THREAD_MATCH_ROUNDS && openedNo !== reservationCode; round++) {
    await dismissBookingOverlays(page);
    tabState = await readBookingInboxTab(page);
    if (tabState.active !== "guest") {
      const ok = await selectBookingGuestTab(page);
      tabState = await readBookingInboxTab(page);
      console.log(`[ota_message] Booking 受信箱タブ切替(${round + 1}周目): ${ok ? "成功" : "失敗"} → active=${tabState.active || "判別不能"}`);
      await dismissBookingOverlays(page);
    }

    const search = page.locator('input[placeholder*="予約番号"], input[placeholder*="名前"]').first();
    if (!(await search.count().catch(() => 0))) {
      await saveScreenshot(page, jobId, "booking_msg_no_search_box");
      throw new Error("Booking 受信箱の検索ボックスが見つかりません（UI変更・要live-tune）");
    }
    await search.click().catch(() => {});
    await search.fill("").catch(() => {});
    await page.waitForTimeout(600);
    await search.fill(reservationCode).catch(() => {});
    await page.waitForTimeout(2500); // オートコンプリート候補が出るのを待つ

    if (dryRun && round === 0) await saveScreenshot(page, jobId, "booking_msg_after_search");

    // ★候補は「予約番号を含む可視要素のうち最も内側(=文字数最小)」に限定して掴む。
    //   旧実装の素の getByText はページ全体が対象で、候補リスト以外を掴む余地があった。
    const handle = await page.evaluateHandle((code) => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8;
      };
      const hits = [...document.querySelectorAll('li, [role="option"], [role="listitem"], a, div, span, td, p')].filter(
        (el) => vis(el) && (el.textContent || "").includes(code)
      );
      if (!hits.length) return null;
      hits.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      return hits[0];
    }, reservationCode);
    const suggestion = handle.asElement ? handle.asElement() : null;

    let clicked = false;
    if (suggestion) {
      suggestionSeen = true;
      try {
        await suggestion.click({ timeout: 5000 });
        clicked = true;
      } catch (_) {
        // 被せ物に飲まれたときの保険（DOM直叩き）
        try {
          await suggestion.evaluate((e) => e.click());
          clicked = true;
        } catch (_) {}
      }
    }
    try {
      await handle.dispose();
    } catch (_) {}

    if (!clicked) {
      await page.waitForTimeout(1500);
      continue;
    }
    // 右パネルの予約番号が目標に切り替わるまで待つ（描画待ちと不一致を取り違えない）
    openedNo = await waitBookingReservationNo(page, reservationCode, THREAD_MATCH_TIMEOUT_MS);
  }

  // ★安全検証: 開いたスレッドの右パネル「予約番号」が目標と一致するか。不一致/不明なら誤爆防止で中止。
  console.log(`[ota_message] Booking 開いたスレッドの予約番号=${openedNo || "不明"} 目標=${reservationCode} タブ=${tabState.active || "判別不能"}`);
  if (openedNo !== reservationCode) {
    await saveScreenshot(page, jobId, "booking_msg_wrong_thread");
    // 原因が次回すぐ分かるよう、受信箱タブと候補の有無を必ずエラー本文に残す
    const why =
      tabState.active === "cs"
        ? "受信箱が「カスタマーサービス」タブのまま(ゲストタブに切替できず)"
        : !suggestionSeen
          ? "検索しても予約番号を含む候補が出なかった(該当スレッドが受信箱に無い可能性)"
          : tabState.active === "guest"
            ? "ゲストタブで候補は押せたがスレッドが切り替わらなかった"
            : "受信箱のタブ状態が判別できなかった";
    throw new Error(
      `Booking スレッド不一致（開いた予約番号「${openedNo || "不明"}」／目標「${reservationCode}」／${why}）— 誤爆防止で中止`
    );
  }

  let composer = await findComposer(page);
  if (!composer) {
    await saveScreenshot(page, jobId, "booking_msg_no_composer");
    throw new Error("Booking メッセージ入力欄が見つかりません（該当スレッド未特定/UI変更・要live-tune）");
  }
  if (dryRun) {
    await saveScreenshot(page, jobId, "booking_msg_dryrun_composer");
    return { drafted: false, threadUrl: page.url() };
  }
  await fillComposer(page, composer, message);
  await page.waitForTimeout(DRAFT_SETTLE_MS);
  const left = await readComposerText(composer);
  const shotPath = await saveScreenshot(page, jobId, "booking_msg_drafted");
  return { drafted: true, threadUrl: page.url(), composerHasText: left.trim().length > 0, shotPath };
}

/** OTA表示名 */
function otaLabelOf(ota) {
  return ota === "airbnb" ? "Airbnb" : "Booking.com";
}

/**
 * 開いたまま保持している下書きページを掃除する。
 * ★スマホのブラウザで開いても下書きは同期されない（2026-07-31 実機で確認）ため、
 *   やますけは Chrome リモートデスクトップでこの PC の画面に繋いで送信ボタンを押す。
 *   そのため下書きページは「送信されるまで開いたまま」にしておく必要がある。
 * 閉じる条件: ①ページが既に閉じている ②入力欄が空＝送信済み/破棄済み ③保持上限を超えた。
 * @param {Set} draftPages  {page, jobId, guestName, ota, at} の集合（listener が保持）
 */
export async function pruneDraftPages(draftPages, { LOG_PREFIX = "[yadozei]" } = {}) {
  for (const d of [...draftPages]) {
    let reason = null;
    if (!d.page || d.page.isClosed()) {
      reason = "既に閉じられている";
    } else if (Date.now() - d.at > DRAFT_PAGE_MAX_AGE_MS) {
      reason = "24時間経過";
    } else {
      // 入力欄が空になっていれば送信済み（または手で消した）とみなす
      const composer = await findComposer(d.page).catch(() => null);
      if (!composer) {
        reason = "入力欄が見つからない(画面が変わった)";
      } else {
        const text = await readComposerText(composer);
        if (!text.trim()) reason = "送信済み(入力欄が空)";
      }
    }
    if (!reason) continue;
    draftPages.delete(d);
    if (d.page && !d.page.isClosed()) await d.page.close().catch(() => {});
    console.log(`${LOG_PREFIX} [ota_message] 下書きページを閉じました（${d.guestName || "?"} / ${reason}）`);
  }
  return draftPages.size;
}

/**
 * OTA メッセージ「下書き作成」ジョブの本体。
 * @param {object} job    yadozeiQueue の ota_message ジョブ
 * @param {object} ctx    Playwright BrowserContext（yadozei-listener が用意・ログイン済み）
 * @param {string} jobId  queue docId
 * @param {object} deps   { db, admin, notifyDiscord_, queueButtonedNotice_, LOG_PREFIX, saveScreenshot }
 */
export async function handleOtaMessage(job, ctx, jobId, deps) {
  const { db, admin, notifyDiscord_, queueButtonedNotice_, LOG_PREFIX = "[yadozei]", saveScreenshot, draftPages } = deps;
  const dryRun = !!(job.params && job.params.dryRun);
  const { ota, reservationCode, guestName, checkIn, message, guestId, propertyName } = job;
  if (!message) throw new Error("ota_message: message(本文) が空です");
  if (!ota) throw new Error("ota_message: ota が未指定です");

  const otaLabel = otaLabelOf(ota);
  console.log(
    `${LOG_PREFIX} [ota_message] ${otaLabel} 下書き作成 → ${guestName || "?"} (${propertyName || ""} / ${checkIn || ""})${
      dryRun ? " ドライラン" : ""
    }`
  );

  const page = await ctx.newPage();
  let keepPageOpen = false; // 下書きが出来たら true（送信されるまで画面を残す）
  try {
    let outcome;
    if (ota === "airbnb") {
      outcome = await sendAirbnb(page, { reservationCode, message, jobId, dryRun, saveScreenshot });
    } else if (ota === "booking") {
      outcome = await sendBooking(page, { message, guestName, reservationCode, checkIn, jobId, dryRun, saveScreenshot });
    } else {
      throw new Error(`ota_message: 未知の ota=${ota}`);
    }

    if (dryRun) {
      await notifyDiscord_(`🧪 OTA下書き ドライラン（${otaLabel} / ${guestName || "?"}）— 入力欄の検出まで確認`);
      return { drafted: false, ota, dryRun: true };
    }

    // 下書き作成を名簿に記録（冪等・再実行検知用。実送信はしていないので otaAckSentAt は書かない）
    if (guestId) {
      await db
        .collection("guestRegistrations")
        .doc(guestId)
        .set(
          {
            otaAckDraftedAt: admin.firestore.FieldValue.serverTimestamp(),
            otaAckDraft: {
              ota,
              threadUrl: outcome.threadUrl || "",
              composerHasText: !!outcome.composerHasText,
            },
          },
          { merge: true }
        );
    }

    // Discord へ「文面＋開くボタン＋スクショ」を1本投稿（ボタンは webhook で出せないので秘書bot経由）
    // ★導線の主役はリモートデスクトップ。スマホのブラウザで OTA を開いても下書きは同期されない
    //   （2026-07-31 実機確認）が、この PC には下書きが入った画面が開いたまま残っている。
    const head =
      `📝 **${otaLabel} の下書きを用意しました** — ${guestName || "?"} 様` +
      `（${propertyName || ""}${checkIn ? " / " + checkIn + " IN" : ""}）\n` +
      `**🖥️ PCの画面を開く** を押すと、この下書きが入った画面がそのまま出ます。**送信ボタンを押すだけ**です。\n` +
      `※スマホのブラウザで「${otaLabel} を開く」から入ると下書きは表示されません（文面をコピーして貼ってください）。\n` +
      "```\n" +
      String(message).slice(0, 1200) +
      "\n```";
    if (typeof queueButtonedNotice_ === "function") {
      queueButtonedNotice_({
        message: head,
        channelPersona: "minpaku",
        links: [
          { label: "🖥️ PCの画面を開く", url: "https://remotedesktop.google.com/access" },
          { label: `📱 ${otaLabel} を開く`, url: outcome.threadUrl },
        ],
        files: outcome.shotPath ? [outcome.shotPath] : [],
      });
    } else {
      await notifyDiscord_(`${head}\n${outcome.threadUrl || ""}`);
    }

    // ★このページは閉じない。リモートデスクトップで繋いだときに「送信を押すだけ」の状態で見せるため、
    //   下書きが入った画面を前面に出したまま保持する（掃除は pruneDraftPages）。
    keepPageOpen = true;
    await page.bringToFront().catch(() => {});
    if (draftPages) draftPages.add({ page, jobId, guestName, ota, at: Date.now() });

    console.log(
      `${LOG_PREFIX} [ota_message] 下書き完了 url=${outcome.threadUrl} 入力欄に残存=${outcome.composerHasText} — 画面は開いたまま保持`
    );
    return { drafted: true, ota, threadUrl: outcome.threadUrl, composerHasText: !!outcome.composerHasText };
  } catch (e) {
    try {
      await saveScreenshot(page, jobId, `ota_message_${ota}_error`);
    } catch (_) {}
    const msg = String(e.message || e);
    // ★未ログインで落ちた場合だけは「今まさにやりたい作業が止まっている」ので、
    //   1日1回の定時促し(朝4:00)を待たずにその場で再ログインを促す(2026-07-31)。
    //   直せば失効中に失敗したこのジョブも復帰時に自動でやり直される。
    if (/未ログイン|logged.?out|再ログイン/i.test(msg) && typeof deps.promptReloginNow_ === "function") {
      deps.promptReloginNow_(
        [otaLabel],
        [
          `🔑 **${otaLabel} のログインが切れていて、下書きを作れませんでした**`,
          `${guestName || "?"} 様（${propertyName || ""}${checkIn ? " / " + checkIn + " IN" : ""}）に送る予定のメッセージです。`,
          `ログインし直すと**この下書きは自動でやり直します**（手で送らなくて大丈夫です）。`,
        ].join("\n")
      );
    } else {
      await notifyDiscord_(
        `🚨 OTA下書き 失敗（${otaLabel}）→ ${guestName || "?"}（${propertyName || ""} / ${checkIn || ""}）\n${msg.slice(
          0,
          300
        )}\n→ 手動でOTAメッセージを送ってください。`
      );
    }
    throw e; // handleJob が queue を failed にする
  } finally {
    if (!keepPageOpen) await page.close().catch(() => {});
  }
}
