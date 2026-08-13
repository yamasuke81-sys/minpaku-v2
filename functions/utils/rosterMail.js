/**
 * 宿泊者名簿の記入をゲストへ依頼するメール (日英併記)
 *
 * 呼び出し元:
 *   - stripeWebhook.handleCheckoutCompleted … 支払完了時点で未提出なら1回
 *   - scheduled/rosterRemind                … 物件の督促タイミング (既定 6/4/2/1日前) ごとに1回
 *
 * 送信対象の実態 (2026-08-13 本番実測):
 *   bookings.email は「名簿が提出されたとき」に onGuestFormSubmit がセットするため、
 *   OTA 予約は名簿未提出のうちはメールアドレスを持たない。したがってこのメールが実際に
 *   飛ぶのは事実上 **直販予約のみ**。source では絞らず email の有無で判定する
 *   (将来 OTA 側でも予約時にアドレスが取れるようになったら自動的に対象へ入る)。
 *
 * 重複送信は bookings.rosterGuestMailSentAt{キー: 送信時刻} で防ぐ。
 * 時刻を値に持たせているのは、予約詳細の履歴タイムラインに送信イベントを出すため。
 */
const admin = require("firebase-admin");
const { sendNotificationEmail_, resolveSenderGmail_ } = require("./lineNotify");
const { getAppUrl } = require("./appUrl");

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} bookingId
 * @param {object} b bookings ドキュメントのデータ
 * @param {{key: string, lead?: string, leadEn?: string}} opts
 *   key   … 重複防止キー ("payment_paid" / "d6" など)
 *   lead  … 冒頭の1文 (状況に応じた文言。省略時は汎用文)
 * @returns {Promise<boolean>} 送信したら true (未送信・スキップは false)
 */
async function sendRosterRequestMail_(db, bookingId, b, opts = {}) {
  const key = String(opts.key || "").trim();
  if (!key) throw new Error("rosterMail: key は必須です");

  // 提出済みなら送らない
  if (b.rosterStatus === "submitted") return false;
  // 保留中 (Airbnb 承認待ち) / 未照合 (Booking.com 匿名取込) は実予約でない可能性があるため送らない
  if (b.pendingApproval === true) return false;
  if (b.unverified === true) return false;
  if (b.status === "cancelled") return false;

  const to = b.email;
  if (!to) return false;

  // 同じキーで送信済みならスキップ。値は送信時刻 (予約詳細の履歴タイムラインで使う)
  const sent = (b.rosterGuestMailSentAt && typeof b.rosterGuestMailSentAt === "object") ? b.rosterGuestMailSentAt : {};
  if (sent[key]) return false;

  const propertyId = b.propertyId || "";
  const propertyName = b.propertyName || "";
  const guestName = b.guestName || "ゲスト";
  const appUrl = await getAppUrl(db);
  const formUrl = `${appUrl}/form/?propertyId=${encodeURIComponent(propertyId)}`;

  const lead = opts.lead || "チェックインまでに、宿泊者名簿のご記入をお願いいたします。";
  const leadEn = opts.leadEn || "Please complete the guest registration form before check-in.";

  const subject = `【${propertyName || "ご予約"}】宿泊者名簿のご記入をお願いします / Guest registration required`;
  const bodyText = [
    `${guestName} 様`,
    ``,
    lead,
    ``,
    `■ご予約内容`,
    `宿泊施設: ${propertyName}`,
    `チェックイン: ${b.checkIn || ""}`,
    `チェックアウト: ${b.checkOut || ""}`,
    ``,
    `■宿泊者名簿のご記入`,
    `${formUrl}`,
    ``,
    `※ 法令により、ご宿泊されるすべての方の氏名・住所・連絡先のご記入が必要です。`,
    `※ チェックイン前のご案内 (お部屋の解錠方法など) は、名簿のご記入後にお送りしております。`,
    ``,
    `────────────────────`,
    ``,
    `Dear ${guestName},`,
    ``,
    leadEn,
    ``,
    `- Booking details`,
    `Property: ${propertyName}`,
    `Check-in: ${b.checkIn || ""}`,
    `Check-out: ${b.checkOut || ""}`,
    ``,
    `- Guest registration form`,
    `${formUrl}`,
    ``,
    `* Japanese law requires the name, address and contact details of every guest staying.`,
    `* Check-in information (such as how to unlock the room) is sent after the form is completed.`,
  ].join("\n");

  const senderGmail = await resolveSenderGmail_(db, propertyId);
  await sendNotificationEmail_(to, subject, bodyText, senderGmail || null);

  // 送信成功時のみ記録 (失敗時は次回の実行で再試行される)。
  // ドット記法の update でネストのキーだけを追記する (既存キーは保持される)
  await db.collection("bookings").doc(bookingId).update({
    [`rosterGuestMailSentAt.${key}`]: admin.firestore.FieldValue.serverTimestamp(),
  });
  return true;
}

module.exports = { sendRosterRequestMail_ };
