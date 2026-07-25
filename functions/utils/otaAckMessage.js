/**
 * OTA（Airbnb / Booking.com）ゲスト宛「名簿確認取れました」定型メッセージの組み立て。
 *
 * 「キーボックス送信予約」押下を発火点に、その予約の OTA ゲストへブラウザ操作で送る本文を
 * サーバ側で完成させ、キューに載せる。PC 常駐ワーカーは受け取った文字列を打つだけ。
 *
 * 本文は両 OTA 共通で、末尾の「チェックイン方法」URL だけ物件で差し替える:
 *  - 両OTAとも中立ドメイン入口 guest-checkin-link.web.app/{slug}/guide を使う。
 *    （Airbnb/Booking はメッセージ内で予約サイト風ドメイン(setouchi-stay.com)を弾くことがあるため。
 *     入口 app = setouchi-stay-sites/entry、そこから独自ドメインの案内ページ
 *     app.setouchi-stay.com/guides/{slug}.html へ自動転送する＝ゲストが見る先は正典ガイドで同じ）
 */

// propertyId → guest-checkin-link 入口スラッグ。entry/index.html の PROP マップと一致させること。
const ENTRY_SLUG = {
  tsZybhDMcPrxqgcRy7wp: "terrace",  // the Terrace 長浜
  RZV9IwtQgMAsvrdM3j8J: "komachi",  // YADO KOMACHI Hiroshima
  ZXW6wdpnBFk1azQ87KXQ: "wakakusa", // Pocket House WAKA-KUSA
  ncUKeD4yQo0kfAoznITu: "ujina",    // UJINA Pocket House
};
const ENTRY_BASE = "https://guest-checkin-link.web.app";

/** 中立ドメイン入口のチェックイン方法 URL（Airbnb/Booking 共通） */
function neutralGuideUrl(propertyId) {
  const slug = ENTRY_SLUG[propertyId];
  return slug ? `${ENTRY_BASE}/${slug}/guide` : "";
}

/** 定型文本文（両 OTA 共通。guideUrl があれば末尾に「▶チェックイン方法」ブロックを付ける） */
function ackBody(guideUrl) {
  const lines = [
    "こんにちは！",
    "名簿の確認が取れました😊",
    "ご協力ありがとうございます。",
    "",
    "それでは当日、キーボックスの解錠番号などをお送り致します。",
    "",
    "たのしい滞在になることを願っています😊",
  ];
  if (guideUrl) {
    lines.push("", "▶チェックイン方法", guideUrl);
  }
  return lines.join("\n");
}

/**
 * OTA 種別と物件から送信メッセージを組み立てる。
 * @param {Object} params
 * @param {string} params.ota  bookings.source の値（"Airbnb" / "Booking.com"）※現状 URL は両OTA共通
 * @param {Object} params.prop properties/{id} データ + { id }
 * @returns {{ text: string, guideUrl: string }}
 */
function buildOtaAckMessage({ ota, prop }) {
  const propertyId = prop && prop.id;
  const guideUrl = neutralGuideUrl(propertyId); // 両OTAとも中立ドメイン
  return { text: ackBody(guideUrl), guideUrl };
}

module.exports = {
  buildOtaAckMessage,
  neutralGuideUrl,
  ackBody,
  ENTRY_SLUG,
  ENTRY_BASE,
};
