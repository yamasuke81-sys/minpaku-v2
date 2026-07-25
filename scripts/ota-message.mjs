/**
 * OTA(Airbnb / Booking.com)ゲストへの「名簿確認取れました」定型メッセージ送信ハンドラ。
 *
 * yadozei-listener の直列ドレインに相乗りする隔離モジュール（CSV系コードには一切触れない）。
 * handleJob が kind==="ota_message" のジョブでこの handleOtaMessage を呼ぶ。
 * ブラウザ context / ログイン資産（Airbnb・Booking extranet）は yadozei-listener のものを再利用。
 *
 * ジョブ形状（Cloud Function onKeyboxConfirmed が投入）:
 *   { kind:"ota_message", ota:"airbnb"|"booking", reservationCode(HM|null),
 *     guestName, checkIn, checkOut, message(完成本文), guideUrl, guestId, propertyId, propertyName,
 *     params?: { dryRun?: boolean } }
 *
 * dryRun=true のときは「遷移＋メッセージ入力欄の検出＋スクショ」までで送信しない（実ゲストへ送らずに
 * 選択子・ナビを安全に検証するため）。本番投入前の live 検証で使う。
 *
 * ★live-tune: OTA の実UIはハッシュ化クラス名で不安定なため、テキスト/role/placeholder ベースの
 *   複数フォールバックで組んでいる。実ログイン画面での初回検証時にセレクタを詰める前提。
 */

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

/** 入力欄(ElementHandle)に本文をセットする。Enter=送信のUIが多く改行で誤送信しうるので fill で直接値を入れる */
async function fillComposer(page, composer, message) {
  try {
    await composer.fill(message);
    return true;
  } catch (_) {
    // contenteditable 等 fill 不可なら、改行を Shift+Enter でタイプ（Enter単独=送信を避ける）
    await composer.click().catch(() => {});
    const parts = message.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await page.keyboard.press("Shift+Enter").catch(() => {});
      await page.keyboard.type(parts[i], { delay: 6 }).catch(() => {});
    }
    return true;
  }
}

/** 入力欄を空にする（fillOnly 検証で下書きを残さないため） */
async function clearComposer(page, composer) {
  try {
    await composer.fill("");
  } catch (_) {}
  try {
    await composer.click().catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
  } catch (_) {}
}

/** 送信ボタンを押す。★Airbnb確認済み: 送信ボタンは aria-label が正確に「送信」
 *  （「クイック返信を送信」とは別物なので厳密一致で誤爆を防ぐ）。 */
async function clickSend(page) {
  const cands = [
    page.getByRole("button", { name: "送信", exact: true }), // Airbnb実UIで確定
    page.locator('button[aria-label="送信"]'),
    page.getByRole("button", { name: /^Send$|Send message/ }),
    page.locator('button[data-testid*="send"]'),
    page.locator('button[type="submit"]'),
  ];
  for (const c of cands) {
    const loc = c.first();
    if ((await loc.count().catch(() => 0)) && (await loc.isEnabled().catch(() => false))) {
      await loc.click().catch(() => {});
      return true;
    }
  }
  return false;
}

/** 送信後、本文の冒頭がスレッドに現れたかで成否を推定（確認できなくても失敗扱いにはしない） */
async function verifyMessageSent(page, message) {
  const head = (message.split("\n").find((l) => l.trim()) || "").slice(0, 12);
  if (!head) return false;
  try {
    await page.waitForTimeout(1500);
    const n = await page.getByText(head, { exact: false }).count().catch(() => 0);
    return n > 0;
  } catch (_) {
    return false;
  }
}

/** ---- Airbnb: 予約詳細ページ(HMコード)からメッセージを送る ---- */
async function sendAirbnb(page, { reservationCode, message, jobId, dryRun, fillOnly, saveScreenshot }) {
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
    // 送信ボタンの候補をログに出す（入力欄が空なので送信ボタンは disabled のはずだが、
    // aria-label/テキストで選択子を特定できる＝clickSend を go-live 前に確定するため）
    try {
      const btns = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((b) => ({ al: b.getAttribute("aria-label"), t: (b.textContent || "").trim().slice(0, 12), dis: b.disabled }))
          .filter((x) => x.al || x.t)
          .slice(-18)
      );
      console.log("[ota_message] Airbnb dryRun 下部ボタン群 =", JSON.stringify(btns));
    } catch (_) {}
    return { sent: false, verified: false };
  }

  await fillComposer(page, composer, message);
  await page.waitForTimeout(800);

  if (fillOnly) {
    // 送信直前まで（入力済み・送信ボタン診断）を検証し、送信しない。下書きは必ず消す。
    const shotPath = await saveScreenshot(page, jobId, "airbnb_msg_filled_nosend");
    try {
      const btns = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((b) => ({ al: b.getAttribute("aria-label"), t: (b.textContent || "").trim().slice(0, 12), dis: b.disabled }))
          .filter((x) => x.al || x.t)
          .slice(-16)
      );
      console.log("[ota_message] Airbnb 下部ボタン群 =", JSON.stringify(btns));
    } catch (_) {}
    await clearComposer(page, composer);
    return { sent: false, verified: false, filledOnly: true, shotPath };
  }

  await page.waitForTimeout(300);
  const clicked = await clickSend(page);
  const verified = await verifyMessageSent(page, message);
  await saveScreenshot(page, jobId, "airbnb_msg_after_send");
  return { sent: clicked, verified };
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

/** ---- Booking.com: extranet で該当予約のメッセージスレッドを開いて送る ---- */
async function sendBooking(page, { message, guestName, reservationCode, checkIn, jobId, dryRun, fillOnly, saveScreenshot }) {
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

  // ★安全検証: 開いたスレッドの右パネル「予約番号」が目標と一致するか。不一致/不明なら誤送信防止で中止。
  const openedNo = await readBookingReservationNo(page);
  console.log(`[ota_message] Booking 開いたスレッドの予約番号=${openedNo || "不明"} 目標=${reservationCode || "なし"}`);
  if (!reservationCode) {
    await saveScreenshot(page, jobId, "booking_msg_no_resno");
    throw new Error("Booking 予約番号が取得できずスレッドを安全に特定できないため中止（手動送信してください）");
  }
  if (openedNo !== reservationCode) {
    await saveScreenshot(page, jobId, "booking_msg_wrong_thread");
    throw new Error(`Booking スレッド不一致（開いた予約番号「${openedNo || "不明"}」／目標「${reservationCode}」）— 誤送信防止で中止`);
  }

  let composer = await findComposer(page);
  if (!composer) {
    await saveScreenshot(page, jobId, "booking_msg_no_composer");
    throw new Error("Booking メッセージ入力欄が見つかりません（該当スレッド未特定/UI変更・要live-tune）");
  }
  if (dryRun) {
    await saveScreenshot(page, jobId, "booking_msg_dryrun_composer");
    return { sent: false, verified: false };
  }
  await fillComposer(page, composer, message);
  await page.waitForTimeout(800);
  if (fillOnly) {
    const shotPath = await saveScreenshot(page, jobId, "booking_msg_filled_nosend");
    await clearComposer(page, composer);
    return { sent: false, verified: false, filledOnly: true, shotPath };
  }
  await page.waitForTimeout(300);
  const clicked = await clickSend(page);
  const verified = await verifyMessageSent(page, message);
  await saveScreenshot(page, jobId, "booking_msg_after_send");
  return { sent: clicked, verified };
}

/**
 * OTA メッセージ送信ジョブの本体。
 * @param {object} job    yadozeiQueue の ota_message ジョブ
 * @param {object} ctx    Playwright BrowserContext（yadozei-listener が用意・ログイン済み）
 * @param {string} jobId  queue docId
 * @param {object} deps   { db, admin, notifyDiscord_, LOG_PREFIX, saveScreenshot }
 */
export async function handleOtaMessage(job, ctx, jobId, deps) {
  const { db, admin, notifyDiscord_, notifyDiscordImage_, LOG_PREFIX = "[yadozei]", saveScreenshot } = deps;
  const dryRun = !!(job.params && job.params.dryRun);
  const fillOnly = !!(job.params && job.params.fillOnly);
  const { ota, reservationCode, guestName, checkIn, message, guestId, propertyName } = job;
  if (!message) throw new Error("ota_message: message(本文) が空です");
  if (!ota) throw new Error("ota_message: ota が未指定です");

  const modeLabel = dryRun ? " ドライラン" : fillOnly ? " 入力のみ(送信なし)" : "";
  console.log(
    `${LOG_PREFIX} [ota_message] ${ota} → ${guestName || "?"} (${propertyName || ""} / ${checkIn || ""})${modeLabel}`
  );

  const page = await ctx.newPage();
  try {
    let outcome;
    if (ota === "airbnb") {
      outcome = await sendAirbnb(page, { reservationCode, message, jobId, dryRun, fillOnly, saveScreenshot });
    } else if (ota === "booking") {
      outcome = await sendBooking(page, { message, guestName, reservationCode, checkIn, jobId, dryRun, fillOnly, saveScreenshot });
    } else {
      throw new Error(`ota_message: 未知の ota=${ota}`);
    }

    // 成功時: 名簿に送信済みマーカー（dryRun / fillOnly は実送信していないので書き戻さない）
    if (!dryRun && !fillOnly && guestId) {
      await db
        .collection("guestRegistrations")
        .doc(guestId)
        .set(
          {
            otaAckSentAt: admin.firestore.FieldValue.serverTimestamp(),
            otaAckResult: { ota, sent: !!outcome.sent, verified: !!outcome.verified },
          },
          { merge: true }
        );
    }

    // Discord 監査
    const otaLabel = ota === "airbnb" ? "Airbnb" : "Booking";
    // テストモード(fillOnly)は「実際に入力された文面」のスクショを添付して owner が確認できるようにする
    if (fillOnly && outcome.shotPath && typeof notifyDiscordImage_ === "function") {
      const caption =
        `🧪 【OTA自動返信テスト】${otaLabel} → ${guestName || "?"}（${propertyName || ""} / ${checkIn || ""}）\n` +
        `実際のスレッドに下記の文面を入力しました（送信はしていません／下書きも消去済み）。\n` +
        `内容が良ければ、本番の自動送信をオンにします。`;
      await notifyDiscordImage_(outcome.shotPath, caption);
      return { sent: false, verified: false, ota, dryRun, fillOnly };
    }
    const status = dryRun
      ? "🧪 ドライラン（送信せず・入力欄検出OK）"
      : fillOnly
      ? "🧪 入力のみ検証（送信せず・下書きは消去）"
      : outcome.verified
      ? "✅ 送信・確認OK"
      : outcome.sent
      ? "✅ 送信（スレッド反映は未確認）"
      : "⚠️ 送信ボタン未検出";
    await notifyDiscord_(
      `📩 OTA自動返信 ${otaLabel} → ${guestName || "?"}（${propertyName || ""} / ${checkIn || ""}）\n${status}`
    );

    return { sent: !!outcome.sent, verified: !!outcome.verified, ota, dryRun, fillOnly };
  } catch (e) {
    try {
      await saveScreenshot(page, jobId, `ota_message_${ota}_error`);
    } catch (_) {}
    await notifyDiscord_(
      `🚨 OTA自動返信 失敗（${ota}）→ ${guestName || "?"}（${propertyName || ""} / ${checkIn || ""}）\n${String(
        e.message || e
      ).slice(0, 300)}\n→ 手動でOTAメッセージを送ってください。`
    );
    throw e; // handleJob が queue を failed にする
  } finally {
    await page.close().catch(() => {});
  }
}
