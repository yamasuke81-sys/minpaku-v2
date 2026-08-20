/**
 * チェックアウト後のお礼 + UGCキャンペーン案内メール — 純粋関数
 *
 * 設計SSOT: setouchi-stay-sites/marketing/UGC_CASHBACK_CAMPAIGN.md
 *
 * 「ご滞在のお礼」に続けて、Instagram に投稿してくれた方へ現金キャッシュバックする
 * キャンペーン(Phase1 = Instagram のみ 500円)を案内する。
 *
 * 法令まわりの整理:
 *   - 宿泊した本人＝取引関係にある者への案内なので、事前同意(オプトイン)は必須ではない。
 *     ただし特定電子メール法の表示義務があるため、本文に **送信者名・住所・配信停止導線** を必ず入れる。
 *   - 配信停止リンクは宛先ごとに違う (共通URLだと誰が押したか分からず停止できない)。
 *   - ステマ規制のため、応募条件として **#PR の明記** を案内文に含める。
 *
 * 判定・文面生成はここに閉じ込め、Firestore アクセスは scheduled/ugcFollowMail.js が持つ。
 */

// キャンペーン主体の表示 (特定電子メール法の表示義務)。
// 宿ごとに運営者は異なるが、キャッシュバックの支払い主体は八朔に一本化している。
const CAMPAIGN_SENDER = "合同会社八朔";
const CAMPAIGN_ADDRESS = "広島県安芸郡海田町上市4-23-12";

// 応募フォームの恒久URL (Firebase の redirect で Googleフォームへ繋いでいる)
const FORM_URL = "https://setouchi-stay.com/ugc";

// Phase1 の特典額 (Threads / TikTok はアカウント作成後に Phase2 で追加)
const INSTAGRAM_REWARD_YEN = 500;

// 共通ハッシュタグ
const COMMON_HASHTAGS = "#setouchistay #瀬戸内ステイ";

/**
 * 宿ごとのタグ付け先と写真の例。ハンドルの正典は
 * setouchi-stay-sites/marketing/SNS_ACCOUNTS.md。変更したら両方直すこと。
 *
 * ★ここに定義があっても送信対象になるとは限らない。実際に送るのは LIVE_PROPERTIES だけ。
 */
const UGC_PROPERTIES = {
  // the Terrace 長浜 … テラスBBQが看板なので写真の例に入れる
  tsZybhDMcPrxqgcRy7wp: {
    handle: "@the.terrace.nagahama",
    hashtags: "#theterracenagahama",
    photoExamples: "お部屋・景色・バーベキューの様子",
    photoExamplesEn: "the room, the view, your BBQ",
  },
  // YADO KOMACHI Hiroshima
  RZV9IwtQgMAsvrdM3j8J: {
    handle: "@yado.komachi.hiroshima",
    hashtags: "#yadokomachi #小町広島",
    photoExamples: "お部屋・館内・まちあるきの様子",
    photoExamplesEn: "the room, the interior, your day out",
  },
  // UJINA Pocket House … ハウスルールで前庭のBBQ・花火は禁止。写真の例にBBQを出さない
  ncUKeD4yQo0kfAoznITu: {
    handle: "@ujina.pocket.house",
    hashtags: "#ujinapockethouse #宇品",
    photoExamples: "お部屋・館内・まちあるきの様子",
    photoExamplesEn: "the room, the interior, your day out",
  },
  // Pocket House WAKA-KUSA … 宿別IG未作成のため当面ブランド垢をタグ付け先にする
  ZXW6wdpnBFk1azQ87KXQ: {
    handle: "@setouchistay.jp",
    hashtags: "#pockethousewakakusa #若草",
    photoExamples: "お部屋・館内・まちあるきの様子",
    photoExamplesEn: "the room, the interior, your day out",
  },
};

/**
 * ★実際に案内を送る宿 (2026-08-20 やますけ決定=テラス先行)
 *
 * 特典は現在 Amazon.co.jp ギフトコードだが、これは Amazon.co.jp でしか使えない。
 * 小町広島は名簿41件のうち31件(76%)が海外ゲストのため、いま案内すると
 * 「受け取れない特典」を送ることになる。そこで海外21%のテラスだけ先に走らせ、
 * 残り3宿は Tremendous(受取人が自国のギフトを選べる)が通ってから開ける。
 *
 * → Tremendous 開通時にこの配列へ3宿を戻す。手順は
 *   setouchi-stay-sites/marketing/ugc/TREMENDOUS_APPLICATION.md
 */
const LIVE_PROPERTIES = [
  "tsZybhDMcPrxqgcRy7wp", // the Terrace 長浜
  // "RZV9IwtQgMAsvrdM3j8J", // YADO KOMACHI Hiroshima … 海外76%。Tremendous 開通まで待機
  // "ncUKeD4yQo0kfAoznITu", // UJINA Pocket House    … 同上
  // "ZXW6wdpnBFk1azQ87KXQ", // Pocket House WAKA-KUSA … 同上(宿別IGも未作成)
];

// 文面を組み立てられる宿か (タグ付け先が定義されているか)
const isUgcProperty = (propertyId) =>
  Object.prototype.hasOwnProperty.call(UGC_PROPERTIES, String(propertyId || ""));

// いま実際に案内を送る宿か
const isLiveProperty = (propertyId) => LIVE_PROPERTIES.includes(String(propertyId || ""));

/**
 * 予約が案内メールの対象かどうか (Firestore を見ない判定だけ)。
 * 配信停止済みかどうかは呼び出し側が marketingSuppressions で別途照合する。
 *
 * @param {object} b bookings ドキュメントのデータ
 * @returns {{ ok: boolean, reason?: string }}
 */
function isEligibleBooking(b) {
  const d = b || {};
  if (!isUgcProperty(d.propertyId)) return { ok: false, reason: "対象外物件" };
  if (!isLiveProperty(d.propertyId)) return { ok: false, reason: "配信待機中の宿" };
  if (d.status !== "confirmed") return { ok: false, reason: `status=${d.status}` };
  // 保留中(Airbnb 承認待ち) / 未照合(Booking.com 匿名取込) は実予約でない可能性がある
  if (d.pendingApproval === true) return { ok: false, reason: "承認待ち" };
  if (d.unverified === true) return { ok: false, reason: "未照合" };
  const email = String(d.email || "").trim();
  if (!email.includes("@")) return { ok: false, reason: "メールアドレスなし" };
  // 同じ予約に二度送らない
  if (d.ugcFollowMailSentAt) return { ok: false, reason: "送信済み" };
  return { ok: true };
}

/**
 * 案内メールの件名と本文 (日英併記)
 *
 * @param {object} p
 * @param {string} p.guestName    ゲスト名
 * @param {string} p.propertyId   物件ID (UGC_PROPERTIES のキー)
 * @param {string} p.propertyName 宿名 (表示用)
 * @param {string} p.checkIn      "YYYY-MM-DD"
 * @param {string} p.checkOut     "YYYY-MM-DD"
 * @param {string} p.optoutUrl    宛先ごとの配信停止URL
 * @returns {{ subject: string, body: string }}
 */
function buildUgcFollowMail({ guestName, propertyId, propertyName, checkIn, checkOut, optoutUrl }) {
  const sns = UGC_PROPERTIES[propertyId];
  if (!sns) throw new Error(`UGC対象外の物件です: ${propertyId}`);
  if (!optoutUrl) throw new Error("optoutUrl は必須です (配信停止導線が無いと送れません)");

  const name = String(guestName || "").trim() || "ゲスト";
  const stay = propertyName || "当宿";
  const yen = INSTAGRAM_REWARD_YEN;

  const subject = `【${stay}】ご滞在ありがとうございました｜Instagram投稿で${yen}円キャッシュバック`;

  const body = [
    `${name} 様`,
    ``,
    `先日は ${stay} にご宿泊いただき、誠にありがとうございました。`,
    ``,
    `ご滞在の思い出を Instagram にシェアしてくださった方へ、`,
    `現金キャッシュバックをお贈りするキャンペーンを実施しています。`,
    ``,
    `  ■ Instagram に投稿 …… ${yen}円キャッシュバック`,
    `　（Threads・TikTok も近日対象に追加予定です）`,
    ``,
    `【参加方法】`,
    `① ${sns.photoExamples}など、宿が分かるお写真を投稿`,
    `② 投稿に ${sns.handle} をタグ付け`,
    `③ 本文に ${COMMON_HASHTAGS} ${sns.hashtags} のハッシュタグを記載`,
    `④ あわせて #PR を明記（広告表示のルール上、必ずお願いします）`,
    `⑤ 下記フォームに投稿URLと Amazonギフトコードの送付先メールアドレス をご入力`,
    ``,
    `  ▶ 応募フォーム: ${FORM_URL}`,
    ``,
    `※ 条件を満たしているかの判定は当宿が行います。基準を満たさないと判断した投稿は`,
    `　 キャッシュバックの対象外となります（判定結果に関するお問い合わせにはお答えできません）。`,
    ``,
    `Googleマップのクチコミもいただけたら嬉しいです（こちらは特典対象外・無償のお願いです）。`,
    ``,
    `■ご滞在`,
    `宿泊施設: ${stay}`,
    `チェックイン: ${checkIn || ""}`,
    `チェックアウト: ${checkOut || ""}`,
    ``,
    `────────────────────`,
    ``,
    `Dear ${name},`,
    ``,
    `Thank you very much for staying at ${stay}.`,
    ``,
    `Share a photo of your stay on Instagram and receive a ${yen} JPY Amazon.co.jp gift code.`,
    `(Please note: the code can only be used on Amazon.co.jp.)`,
    ``,
    `1. Post a photo that shows the property (${sns.photoExamplesEn}, etc.)`,
    `2. Tag ${sns.handle} in the post`,
    `3. Add the hashtags ${COMMON_HASHTAGS} ${sns.hashtags}`,
    `4. Add #PR as well (required for promotional posts)`,
    `5. Submit the post URL and the email address for your gift code here:`,
    ``,
    `  ${FORM_URL}`,
    ``,
    `* We review each submission. Posts that do not meet the conditions are not eligible,`,
    `  and we are unable to respond to inquiries about the result.`,
    ``,
    `A Google Maps review is also very welcome (not part of the reward program).`,
    ``,
    `────────────────────`,
    `【本メールの配信について / Unsubscribe】`,
    `今後この種のご案内が不要な場合は、下記より配信停止いただけます。`,
    `リンクを開くだけで停止が完了します（入力は必要ありません）。`,
    `To stop receiving these emails, just open the link below.`,
    ``,
    `  ▶ 配信停止 / Unsubscribe: ${optoutUrl}`,
    ``,
    `送信元: ${CAMPAIGN_SENDER} / ${CAMPAIGN_ADDRESS}`,
    `────────────────────`,
  ].join("\n");

  return { subject, body };
}

/**
 * 過去ゲスト向けの案内メール (名簿全体+オプトアウト方式・ローリング配信用)
 *
 * チェックアウト直後のフォローと違い、名簿の連絡先を「宿泊者管理」以外の目的で
 * 初めて使うため、**利用目的追加の通知**を本文に必ず入れる(個人情報保護法)。
 * この一文を外すと目的外利用にあたるので、文面をいじるときも削らないこと。
 *
 * @param {object} p
 * @param {string} p.guestName    ゲスト名
 * @param {string} p.propertyId   物件ID (UGC_PROPERTIES のキー)
 * @param {string} p.propertyName 宿名 (表示用)
 * @param {string} p.optoutUrl    宛先ごとの配信停止URL
 * @returns {{ subject: string, body: string }}
 */
function buildUgcPastGuestMail({ guestName, propertyId, propertyName, optoutUrl }) {
  const sns = UGC_PROPERTIES[propertyId];
  if (!sns) throw new Error(`UGC対象外の物件です: ${propertyId}`);
  if (!optoutUrl) throw new Error("optoutUrl は必須です (配信停止導線が無いと送れません)");

  const name = String(guestName || "").trim() || "ゲスト";
  const stay = propertyName || "当宿";
  const yen = INSTAGRAM_REWARD_YEN;

  const subject = `【${stay}】Instagram投稿で${yen}円キャッシュバックのお知らせ`;

  const body = [
    `${name} 様`,
    ``,
    `先日は ${stay} にご宿泊いただき、誠にありがとうございました。`,
    ``,
    `このたび、ご滞在の思い出を Instagram にシェアしてくださった方へ`,
    `現金キャッシュバックをお贈りするキャンペーンを始めました。`,
    ``,
    `  ■ Instagram に投稿 …… ${yen}円キャッシュバック`,
    `　（Threads・TikTok も近日対象に追加予定です）`,
    ``,
    `【参加方法】`,
    `① ${sns.photoExamples}など、宿が分かるお写真を投稿`,
    `② 投稿に ${sns.handle} をタグ付け`,
    `③ 本文に ${COMMON_HASHTAGS} ${sns.hashtags} のハッシュタグを記載`,
    `④ あわせて #PR を明記（広告表示のルール上、必ずお願いします）`,
    `⑤ 下記フォームに投稿URLと Amazonギフトコードの送付先メールアドレス をご入力`,
    ``,
    `  ▶ 応募フォーム: ${FORM_URL}`,
    ``,
    `※ 条件を満たしているかの判定は当宿が行います。基準を満たさないと判断した投稿は`,
    `　 キャッシュバックの対象外となります（判定結果に関するお問い合わせにはお答えできません）。`,
    ``,
    `Googleマップのクチコミもいただけたら嬉しいです（こちらは特典対象外・無償のお願いです）。`,
    ``,
    `────────────────────`,
    ``,
    `Dear ${name},`,
    ``,
    `Thank you again for staying at ${stay}.`,
    ``,
    `Share a photo of your stay on Instagram and receive a ${yen} JPY Amazon.co.jp gift code.`,
    `(Please note: the code can only be used on Amazon.co.jp.)`,
    ``,
    `1. Post a photo that shows the property (${sns.photoExamplesEn}, etc.)`,
    `2. Tag ${sns.handle} in the post`,
    `3. Add the hashtags ${COMMON_HASHTAGS} ${sns.hashtags}`,
    `4. Add #PR as well (required for promotional posts)`,
    `5. Submit the post URL and the email address for your gift code here:`,
    ``,
    `  ${FORM_URL}`,
    ``,
    `* We review each submission. Posts that do not meet the conditions are not eligible,`,
    `  and we are unable to respond to inquiries about the result.`,
    ``,
    `A Google Maps review is also very welcome (not part of the reward program).`,
    ``,
    `────────────────────`,
    `【ご案内】本メールの配信について / About this email`,
    `これまで宿泊者管理の目的で頂戴していたご連絡先を、今回よりキャンペーン等の`,
    `ご案内にも利用させていただきます。今後この種のご案内を希望されない場合は、`,
    `下記より配信停止いただけます（リンクを開くだけで完了します。以後お送りしません）。`,
    `We previously received your contact details for guest registration; we will now`,
    `also use them for occasional campaign announcements. To stop receiving these,`,
    `just open the link below.`,
    ``,
    `  ▶ 配信停止 / Unsubscribe: ${optoutUrl}`,
    ``,
    `送信元: ${CAMPAIGN_SENDER} / ${CAMPAIGN_ADDRESS}`,
    `────────────────────`,
  ].join("\n");

  return { subject, body };
}

module.exports = {
  UGC_PROPERTIES,
  LIVE_PROPERTIES,
  isLiveProperty,
  FORM_URL,
  INSTAGRAM_REWARD_YEN,
  isUgcProperty,
  isEligibleBooking,
  buildUgcFollowMail,
  buildUgcPastGuestMail,
};
