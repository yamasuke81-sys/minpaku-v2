/**
 * 共有フォームスキーマ
 * guest-form.html の実フォーム項目を標準定義として保持する。
 * guests.js（管理画面）と guest-form.html（公開フォーム）の両方から参照可。
 *
 * 使い方:
 *   <script src="/js/shared/form-schema.js"></script>
 *   → window.STANDARD_FORM_FIELDS / window.STANDARD_FORM_SECTIONS が使用可能
 */

(function (global) {
  "use strict";

  /**
   * 標準フォーム項目定義
   * - core: true  → guest-form.html にハードコードされているコア項目
   * - id         → f_ プレフィックスなし
   * - mapping    → Firestore guestRegistrations に保存するフィールド名
   * - section    → STANDARD_FORM_SECTIONS の id に対応
   */
  var STANDARD_FORM_FIELDS = [

    // ======================================================
    // セクション: 宿泊情報 (stay)
    // ======================================================
    {
      id: "checkIn",
      label: "チェックイン日",
      labelEn: "Check-in Date",
      type: "date",
      required: true,
      section: "stay",
      mapping: "checkIn",
      core: true,
    },
    {
      id: "checkInTime",
      label: "チェックイン時間",
      labelEn: "Check-in Time",
      type: "select",
      required: true,
      section: "stay",
      mapping: "checkInTime",
      options: ["15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:00以降"],
      optionsEn: ["15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","After 20:00"],
      core: true,
    },
    {
      id: "checkOut",
      label: "チェックアウト日",
      labelEn: "Check-out Date",
      type: "date",
      required: true,
      section: "stay",
      mapping: "checkOut",
      core: true,
    },
    {
      id: "checkOutTime",
      label: "チェックアウト時間",
      labelEn: "Check-out Time",
      type: "select",
      required: true,
      section: "stay",
      mapping: "checkOutTime",
      options: ["7:00","7:30","8:00","8:30","9:00","9:30","10:00"],
      optionsEn: ["7:00","7:30","8:00","8:30","9:00","9:30","10:00"],
      core: true,
    },
    {
      id: "guestCount",
      label: "宿泊人数（大人）",
      labelEn: "Number of Guests (Adults)",
      type: "number",
      required: true,
      section: "stay",
      mapping: "guestCount",
      placeholder: "",
      defaultValue: "1",
      core: true,
    },
    {
      id: "guestCountInfants",
      label: "3才以下の乳幼児",
      labelEn: "Infants (under 3)",
      type: "number",
      required: false,
      section: "stay",
      mapping: "guestCountInfants",
      defaultValue: "0",
      core: true,
    },
    {
      id: "bookingSite",
      label: "どこのサイトから予約しましたか？",
      labelEn: "Where did you book?",
      type: "select",
      required: true,
      section: "stay",
      mapping: "bookingSite",
      options: ["Airbnb","Booking.com","楽天トラベル","じゃらん","Agoda","VRBO","Trip.com","自社公式ウェブサイト","直接予約","その他"],
      optionsEn: ["Airbnb","Booking.com","Rakuten Travel","Jalan","Agoda","VRBO","Trip.com","Official Website","Direct Booking","Other"],
      core: true,
    },

    // ======================================================
    // セクション: 宿泊者情報（旅館業法）(companions)
    // 実フォームでは guestInputList に動的生成されるブロック
    // 代表者+同行者を含む全員分のフィールド群
    // ======================================================
    {
      id: "guests",
      label: "宿泊者情報（全員）",
      labelEn: "Guest Information (All)",
      type: "guests-block",
      required: true,
      section: "companions",
      mapping: "allGuests",
      core: true,
    },

    // ======================================================
    // セクション: 施設利用情報 (facility)
    // ======================================================
    {
      id: "transport",
      label: "交通手段",
      labelEn: "Transportation",
      type: "select",
      required: false,
      section: "facility",
      mapping: "transport",
      options: ["車","公共交通機関","タクシー","徒歩","その他"],
      optionsEn: ["Car","Public transport","Taxi","Walking","Other"],
      core: true,
    },
    {
      id: "taxiAgree",
      label: "タクシー注意事項への同意",
      labelEn: "Taxi warning agreement",
      type: "checkbox-single",
      required: false,
      section: "facility",
      mapping: "taxiAgree",
      core: true,
    },
    {
      id: "carCount",
      label: "車は何台でお越しになりますか？",
      labelEn: "How many cars will you bring?",
      type: "select",
      required: false,
      section: "facility",
      mapping: "carCount",
      options: ["1台","2台","3台","4台","5台","6台","7台以上"],
      optionsEn: ["1 car","2 cars","3 cars","4 cars","5 cars","6 cars","7+ cars"],
      core: true,
    },
    {
      id: "vehicleTypes",
      label: "車種（台数分）",
      labelEn: "Vehicle types",
      type: "vehicle-types-block",
      required: false,
      section: "facility",
      mapping: "vehicleTypes",
      core: true,
    },
    {
      id: "neighborAgree",
      label: "近隣駐車場への侵入禁止への同意",
      labelEn: "Neighbor parking agreement",
      type: "checkbox-single",
      required: false,
      section: "facility",
      mapping: "neighborAgree",
      core: true,
    },
    {
      id: "paidParking",
      label: "有料駐車場の利用",
      labelEn: "Paid parking",
      type: "select",
      required: false,
      section: "facility",
      mapping: "paidParking",
      options: ["利用しない","1台利用","2台利用"],
      optionsEn: ["No","1 car","2 cars"],
      core: true,
    },
    {
      id: "bbq",
      label: "バーベキューセットをご利用されますか？",
      labelEn: "Would you like to use the BBQ set?",
      type: "select",
      required: true,
      section: "facility",
      mapping: "bbq",
      options: ["利用しない","利用する"],
      optionsEn: ["No","Yes"],
      core: true,
    },
    {
      id: "bbqRules",
      label: "BBQルール同意（5項目）",
      labelEn: "BBQ rules agreement (5 items)",
      type: "bbq-rules-block",
      required: false,
      section: "facility",
      mapping: "bbqRules",
      core: true,
    },
    {
      id: "bedChoice",
      label: "ベッドの希望（2名のみ）",
      labelEn: "Bed preference (2 guests only)",
      type: "select",
      required: false,
      section: "facility",
      mapping: "bedChoice",
      options: ["2人で1台のベッドを利用（2階リビング）","1人1台ずつベッドを利用（1階和室）"],
      optionsEn: ["Share 1 bed for 2 (2F living room)","1 bed each (1F Japanese room)"],
      core: true,
    },

    // ======================================================
    // セクション: アンケート (survey)
    // ======================================================
    {
      id: "purpose",
      label: "旅の目的は何でしょうか",
      labelEn: "What is the purpose of your trip?",
      type: "select",
      required: false,
      section: "survey",
      mapping: "purpose",
      options: ["出張","宮島","原爆ドーム","広島市内観光","呉観光","大和ミュージアム","中国地方観光","中四国観光","その他"],
      optionsEn: ["Business","Miyajima","Atomic Bomb Dome","Hiroshima City Sightseeing","Kure Sightseeing","Yamato Museum","Chugoku Region","Chugoku-Shikoku Region","Other"],
      core: true,
    },
    {
      id: "previousStay",
      label: "前泊地",
      labelEn: "Previous night's accommodation",
      type: "text",
      required: false,
      section: "survey",
      mapping: "previousStay",
      placeholder: "",
      core: true,
    },
    {
      id: "nextStay",
      label: "後泊地",
      labelEn: "Next night's accommodation",
      type: "text",
      required: false,
      section: "survey",
      mapping: "nextStay",
      placeholder: "",
      core: true,
    },

    // ======================================================
    // セクション: 緊急連絡先 (emergency)
    // ======================================================
    {
      id: "emergencyName",
      label: "緊急連絡先 氏名",
      labelEn: "Emergency Contact Name",
      type: "text",
      required: true,
      section: "emergency",
      mapping: "emergencyName",
      core: true,
    },
    {
      id: "emergencyPhone",
      label: "緊急連絡先 電話番号",
      labelEn: "Emergency Contact Phone",
      type: "tel",
      required: true,
      section: "emergency",
      mapping: "emergencyPhone",
      core: true,
    },

    // ======================================================
    // セクション: 同意事項（システム用）(agreement)
    // 実フォームでは hidden input または騒音同意セクションで処理
    // ======================================================
    {
      id: "noiseAgree",
      label: "騒音ルール同意",
      labelEn: "Noise rule agreement",
      type: "checkbox-single",
      required: true,
      section: "agreement",
      mapping: "noiseAgree",
      core: true,
    },
    {
      id: "houseRuleAgree",
      label: "ハウスルール同意",
      labelEn: "House rule agreement",
      type: "checkbox-single",
      required: true,
      section: "agreement",
      mapping: "houseRuleAgree",
      core: true,
    },

  ];

  /**
   * 標準セクション定義
   * guests.js の DEFAULT_SECTIONS と同一内容
   */
  var STANDARD_FORM_SECTIONS = [
    { id: "stay",        label: "宿泊情報",              labelEn: "Stay Details",                            order: 1 },
    { id: "companions",  label: "宿泊者情報（旅館業法）", labelEn: "Guests (Required by Japanese Law)",       order: 2, isCompanion: true },
    { id: "facility",    label: "施設利用情報",           labelEn: "Facility Usage",                          order: 3 },
    { id: "survey",      label: "アンケート",             labelEn: "Survey",                                  order: 4 },
    { id: "emergency",   label: "緊急連絡先",             labelEn: "Emergency Contact",                       order: 5 },
    { id: "agreement",   label: "同意事項（システム用）", labelEn: "Agreement (system)",                      order: 6 },
  ];

  // グローバルに公開
  global.STANDARD_FORM_FIELDS = STANDARD_FORM_FIELDS;
  global.STANDARD_FORM_SECTIONS = STANDARD_FORM_SECTIONS;

})(typeof window !== "undefined" ? window : global);
