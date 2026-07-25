/**
 * 宿泊者名簿「キーボックス送信予約」→ OTA(Airbnb/Booking)ゲストへ名簿確認メッセージを自動送信。
 *
 * 発火: guestRegistrations onDocumentUpdated で keyboxConfirmedAt が「無→有」に変わった瞬間。
 *   （フロントの「キーボックス送信予約」ボタン=guests.js、およびメールの「OKボタン」経路=api/keybox.js、
 *     いずれも同じ keyboxConfirmedAt を立てるので、この遷移を捉えれば両経路を一律に拾える）
 *
 * 動作（このトリガーは「キュー投入」まで。実送信は PC 常駐ワーカー yadozei-listener が拾って行う）:
 *   1. 冪等ガード: keyboxConfirmedAt 遷移でない / 既に投入・送信済みならスキップ
 *   2. マスタースイッチ settings/otaAutoReply.enabled が false の間は完全に不活性（既定OFF＝安全側）
 *   3. bookingId→bookings.source で権威ある OTA 種別を判定（direct はスキップ、判定不能は Discord 通知）
 *   4. Airbnb は確認コード(HM…)を予約ドキュメントから抽出
 *   5. 文面を組み立て yadozeiQueue に kind="ota_message" / status="pending" で投入 → guestRegistrations に冪等マーカー
 *     （既存の PC 常駐ワーカーの直列ドレインに相乗り＝Airbnb/Booking のログイン資産を再利用。
 *      ★フラグ有効化はワーカー側に ota_message 分岐を追加・再起動した後に行うこと。旧ワーカーは未知kindを failed にする）
 *
 * 注: 予約元の権威は bookings.source。名簿の bookingSite はゲスト自己申告で不確実なので使わない。
 */
const admin = require("firebase-admin");
const { buildOtaAckMessage } = require("../utils/otaAckMessage");
const {
  getNotificationSettings_,
  resolveDiscordOwnerWebhookUrl_,
  sendDiscord_,
} = require("../utils/lineNotify");

/** bookings.source → OTA 種別 */
function otaKindFromSource(source) {
  const s = String(source || "").toLowerCase();
  if (s.includes("airbnb")) return "airbnb";
  if (s.includes("booking")) return "booking";
  if (s.includes("direct")) return "direct";
  return null;
}

/** Airbnb 確認コード(HM…)を予約ドキュメントから抽出（iCal の予約URLや notes に埋め込まれている） */
function extractAirbnbCode(booking) {
  const hay = [booking.notes, booking.description, booking.summary, booking.icalUid, booking.icalUrl]
    .filter(Boolean)
    .join("\n");
  let m = hay.match(/reservations\/details\/([A-Z0-9]{6,})/i);
  if (m) return m[1].toUpperCase();
  m = hay.match(/\bHM[A-Z0-9]{6,}\b/);
  return m ? m[0].toUpperCase() : "";
}

/** Booking.com 予約番号(10桁前後)を予約ドキュメントから抽出。
 *  メール照合済みは emailSubject に「(6066243360, 2026年8月7日…)」の形で入る。notes にも「予約番号6066243360」の形。 */
function extractBookingResNo(booking) {
  const subj = booking.emailSubject || "";
  let m = subj.match(/\((\d{8,12})[,)]/);
  if (m) return m[1];
  const notes = booking.notes || "";
  m = notes.match(/予約番号\s*[:：]?\s*(\d{8,12})/);
  if (m) return m[1];
  return "";
}

/** owner 宛 Discord に1通（設定が無ければ黙ってスキップ） */
async function discordNotify_(db, text) {
  try {
    const { settings } = await getNotificationSettings_(db);
    const url = resolveDiscordOwnerWebhookUrl_(settings);
    if (url) await sendDiscord_(url, text);
    else console.warn("[onKeyboxConfirmed] Discord Webhook URL 未設定");
  } catch (e) {
    console.warn("[onKeyboxConfirmed] Discord通知失敗:", e.message);
  }
}

module.exports = async (event) => {
  const before = (event.data && event.data.before && event.data.before.data()) || {};
  const after = (event.data && event.data.after && event.data.after.data()) || {};
  const guestId = event.params.guestId;

  // 1) keyboxConfirmedAt が「無→有」の遷移だけを拾う
  if (before.keyboxConfirmedAt || !after.keyboxConfirmedAt) return;
  // 冪等: 既にキュー投入 or 送信済みなら何もしない
  if (after.otaAckQueuedAt || after.otaAckSentAt) return;

  const db = admin.firestore();

  // 2) マスタースイッチ（既定OFF。有効化するまで完全に不活性＝実装完成まで一切送信・投入しない）
  let cfg = {};
  try {
    const s = await db.collection("settings").doc("otaAutoReply").get();
    cfg = s.exists ? (s.data() || {}) : {};
  } catch (e) {
    console.warn("[onKeyboxConfirmed] settings/otaAutoReply 読取失敗:", e.message);
  }
  if (!cfg.enabled) return;

  const guestName = after.guestName || "(氏名未取得)";
  const checkIn = after.checkIn || "";

  // 3) 予約元(OTA種別)を bookings から権威判定
  const bookingId = after.bookingId || null;
  if (!bookingId) {
    await discordNotify_(
      db,
      `📮 OTA自動返信できませんでした（予約が名簿に紐付いていません）\nゲスト: ${guestName} / ${checkIn}\n→ 手動でOTAメッセージを送ってください。`
    );
    return;
  }

  let booking = null;
  try {
    const b = await db.collection("bookings").doc(bookingId).get();
    booking = b.exists ? b.data() : null;
  } catch (e) {
    console.warn("[onKeyboxConfirmed] bookings 読取失敗:", e.message);
  }
  if (!booking) {
    await discordNotify_(
      db,
      `📮 OTA自動返信できませんでした（予約データが見つかりません: ${bookingId}）\nゲスト: ${guestName} / ${checkIn}\n→ 手動でOTAメッセージを送ってください。`
    );
    return;
  }

  const ota = otaKindFromSource(booking.source);
  if (ota === "direct") return; // 直販はOTA無し（キーボックスメールでゲストに直接届く）
  if (!ota) {
    await discordNotify_(
      db,
      `📮 OTA自動返信できませんでした（予約元が判定できません: source=${booking.source || "空"}）\nゲスト: ${guestName} / ${checkIn}\n→ 手動でOTAメッセージを送ってください。`
    );
    return;
  }

  // 3.5) 段階投入のための per-OTA スイッチ（明示 false のときだけ止める。既定は投入する）
  if ((ota === "airbnb" && cfg.airbnb === false) || (ota === "booking" && cfg.booking === false)) {
    console.log(`[onKeyboxConfirmed] ${ota} は現在無効化中のためスキップ (guestId=${guestId})`);
    return;
  }

  // 4) 物件を読み、文面を組み立て（Booking のチェックイン方法URLは物件設定から解決）
  const propertyId = after.propertyId || booking.propertyId || "";
  let prop = { id: propertyId };
  try {
    const p = await db.collection("properties").doc(propertyId).get();
    if (p.exists) prop = { id: propertyId, ...p.data() };
  } catch (e) {
    console.warn("[onKeyboxConfirmed] properties 読取失敗:", e.message);
  }
  const source = booking.source; // "Airbnb" / "Booking.com"
  const { text: message, guideUrl } = buildOtaAckMessage({ ota: source, prop });
  const reservationCode =
    ota === "airbnb" ? extractAirbnbCode(booking) : ota === "booking" ? extractBookingResNo(booking) : "";

  // 5) yadozeiQueue に kind="ota_message" で投入 + guestRegistrations に冪等マーカー（同一トランザクションで）
  //    既存 PC 常駐ワーカー(yadozei-listener)の直列ドレインに相乗りする（ブラウザ競合回避・ログイン再利用）。
  const queueRef = db.collection("yadozeiQueue").doc();
  const guestRef = db.collection("guestRegistrations").doc(guestId);
  try {
    await db.runTransaction(async (tx) => {
      const g = await tx.get(guestRef);
      const gd = g.exists ? g.data() : {};
      // トランザクション内で冪等を再確認（同時発火・2回押し対策）
      if (gd.otaAckQueuedAt || gd.otaAckSentAt) return;
      tx.set(queueRef, {
        status: "pending",
        kind: "ota_message", // yadozei-listener の handleJob 分岐で処理される
        ota, // "airbnb" | "booking"
        source, // "Airbnb" | "Booking.com"
        guestId,
        bookingId,
        propertyId,
        propertyName: prop.name || "",
        reservationCode: reservationCode || null,
        guestName,
        checkIn,
        checkOut: after.checkOut || booking.checkOut || "",
        message,
        guideUrl,
        // mode!=="live" の間はテストモード＝ワーカーは実際のスレッドに入力してスクショを Discord に送るが送信しない。
        // 本番送信は settings/otaAutoReply.mode="live" にしてから。
        params: { fillOnly: cfg.mode !== "live" },
        attempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(guestRef, {
        otaAckQueuedAt: admin.firestore.FieldValue.serverTimestamp(),
        otaAckChannel: ota,
        otaAckQueueId: queueRef.id,
      });
    });
    console.log(
      `[onKeyboxConfirmed] enqueued ota=${ota} guestId=${guestId} code=${reservationCode || "-"} queueId=${queueRef.id}`
    );
  } catch (e) {
    console.error("[onKeyboxConfirmed] キュー投入失敗:", e);
    await discordNotify_(
      db,
      `🚨 OTA自動返信のキュー投入に失敗しました\nゲスト: ${guestName} / ${checkIn} (${ota})\n${e.message}`
    );
  }
};

// テスト用に純粋関数を公開
module.exports.otaKindFromSource = otaKindFromSource;
module.exports.extractAirbnbCode = extractAirbnbCode;
module.exports.extractBookingResNo = extractBookingResNo;
