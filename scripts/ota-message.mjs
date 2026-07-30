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
  // 予約番号でスレッドを特定する（最も確実。extranet の名前はローマ字表記で名簿の漢字と一致しないため使わない）。
  // 検索ボックスは「オートコンプリート」で、予約番号を打つと候補「(ローマ字名) - (予約番号)」が出る。
  // ★Enterではなくこの候補をクリックするとスレッドが開く。
  if (reservationCode) {
    const search = page.locator('input[placeholder*="予約番号"], input[placeholder*="名前"]').first();
    if (await search.count().catch(() => 0)) {
      await search.click().catch(() => {});
      await search.fill(reservationCode).catch(() => {});
      await page.waitForTimeout(1500); // オートコンプリート候補が出るのを待つ
    }
    if (dryRun) await saveScreenshot(page, jobId, "booking_msg_after_search");
    // 予約番号を含むオートコンプリート候補（入力欄の値はテキストに含まれないので候補だけがヒットする）をクリック
    const suggestion = page.getByText(new RegExp(reservationCode)).first();
    if (await suggestion.count().catch(() => 0)) {
      await suggestion.click().catch(() => {});
      await page.waitForTimeout(2800);
    }
  }

  // ★安全検証: 開いたスレッドの右パネル「予約番号」が目標と一致するか。不一致/不明なら誤爆防止で中止。
  const openedNo = await readBookingReservationNo(page);
  console.log(`[ota_message] Booking 開いたスレッドの予約番号=${openedNo || "不明"} 目標=${reservationCode || "なし"}`);
  if (!reservationCode) {
    await saveScreenshot(page, jobId, "booking_msg_no_resno");
    throw new Error("Booking 予約番号が取得できずスレッドを安全に特定できないため中止（手動で送ってください）");
  }
  if (openedNo !== reservationCode) {
    await saveScreenshot(page, jobId, "booking_msg_wrong_thread");
    throw new Error(`Booking スレッド不一致（開いた予約番号「${openedNo || "不明"}」／目標「${reservationCode}」）— 誤爆防止で中止`);
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
    await notifyDiscord_(
      `🚨 OTA下書き 失敗（${otaLabel}）→ ${guestName || "?"}（${propertyName || ""} / ${checkIn || ""}）\n${String(
        e.message || e
      ).slice(0, 300)}\n→ 手動でOTAメッセージを送ってください。`
    );
    throw e; // handleJob が queue を failed にする
  } finally {
    if (!keepPageOpen) await page.close().catch(() => {});
  }
}
