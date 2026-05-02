/**
 * 通知チャンネル編集 — 共有コンポーネント (Phase A)
 *
 * 通知設定タブと「予約フロー構成 / 清掃フロー構成」の物件カードの双方から
 * 同じ通知タイプ単位の編集UIを描画するための共通モジュール。
 *
 * 提供API:
 *   NotifyChannelEditor.NOTIFICATIONS              … 全通知定義(25種 ※scan_pending削除後)
 *   NotifyChannelEditor.SYSTEM_VARIABLES           … 通知種別ごとの利用可能変数
 *   NotifyChannelEditor.findNotification(key)      … key で通知定義を引く
 *   NotifyChannelEditor.groupNotifications()       … group ごとに分類
 *   NotifyChannelEditor.renderNotificationCard(notification, channelData, opt)
 *   NotifyChannelEditor.renderTimingRow(key, t, idx, opt)
 *   NotifyChannelEditor.updatePreview(key, opt)
 *   NotifyChannelEditor.readChannelValue(container, key, opt)  ← 1通知ぶん
 *   NotifyChannelEditor.bindCardEvents(container, opt)         ← 全通知共通バインド
 *
 * opt の主要パラメータ:
 *   idPrefix      … カード内 input の data-key と組み合わせるプレフィックス
 *                   (1ページ内に同じ通知 key が複数ある場合の衝突回避用)
 *   onChange()    … 値が変更された時のコールバック (debounced 保存等で使用)
 *   onTestSend(key, channelData, varGroup) … テスト送信ボタンのハンドラ
 *
 * 互換性:
 *   既存の通知設定タブは idPrefix なしの素直な data-key 検索で動作中。
 *   shared 側は idPrefix が空の場合も従来と同じ data 属性を出力する。
 */
(function(global) {
  "use strict";

  // ========== システム定義変数 ==========
  const SYSTEM_VARIABLES = {
    recruit: [
      { name: "date",     label: "作業日",        sample: "2026/04/20",  source: "recruitment.checkoutDate" },
      { name: "property", label: "物件名",        sample: "長浜民泊A",    source: "recruitment.propertyName" },
      { name: "work",     label: "作業内容",      sample: "清掃",         source: "recruitment.workType (清掃 / 直前点検)" },
      { name: "url",      label: "回答ページURL", sample: "https://minpaku-v2.web.app/#/my-recruitment", source: "自動生成" },
      { name: "count",    label: "回答数",        sample: "3",           source: "recruitment.responses.length" },
      { name: "staff",    label: "確定スタッフ名", sample: "山田太郎",    source: "recruitment.selectedStaff" },
      { name: "memo",     label: "メモ",          sample: "BBQ後の片付けあり", source: "recruitment.memo" },
      { name: "response", label: "回答内容",      sample: "◎",           source: "response.response (◎/△/×)" },
    ],
    booking: [
      { name: "date",     label: "チェックアウト日", sample: "2026/04/20", source: "booking.checkOut" },
      { name: "checkin",  label: "チェックイン日",   sample: "2026/04/18", source: "booking.checkIn" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",   source: "booking.propertyName" },
      { name: "guest",    label: "ゲスト名",        sample: "John Smith", source: "booking.guestName" },
      { name: "nights",   label: "宿泊数",          sample: "2",          source: "自動計算" },
      { name: "site",     label: "予約サイト",       sample: "Airbnb",     source: "booking.source" },
      { name: "url",      label: "名簿ページURL",   sample: "https://minpaku-v2.web.app/#/guests", source: "自動生成" },
    ],
    staff: [
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎",      source: "staff.name" },
      { name: "date",     label: "対象日",      sample: "2026/04/20",   source: "shift.date" },
      { name: "property", label: "物件名",      sample: "長浜民泊A",     source: "shift.propertyName" },
      { name: "url",      label: "マイページURL", sample: "https://minpaku-v2.web.app/#/my-dashboard", source: "自動生成" },
      { name: "reason",   label: "理由",        sample: "直近15回の募集に無回答", source: "staff.inactiveReason" },
    ],
    invoice: [
      { name: "month",    label: "対象月",      sample: "4",            source: "invoice.yearMonth" },
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎",      source: "invoice.staffName" },
      { name: "property", label: "物件名",      sample: "長浜民泊A",     source: "invoice.propertyName" },
      { name: "total",    label: "合計金額",    sample: "¥45,000",      source: "invoice.total" },
      { name: "url",      label: "確認/作成ページURL", sample: "https://minpaku-v2.web.app/#/my-invoice-create", source: "請求書要請: /#/my-invoice-create、提出通知: /#/invoices" },
    ],
    cleaning: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20",   source: "checklist.date" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",     source: "checklist.propertyName" },
      { name: "staff",    label: "スタッフ名",       sample: "山田太郎",      source: "checklist.staffName" },
      { name: "time",     label: "完了時刻",        sample: "14:30",        source: "checklist.completedAt" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx", source: "自動生成 (該当シフトのチェックリストページ)" },
    ],
    laundry: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20",   source: "checklist.checkoutDate" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",     source: "checklist.propertyName" },
      { name: "staff",    label: "担当スタッフ",     sample: "山田太郎",     source: "checklist.laundry.*.by.name" },
      { name: "time",     label: "実施時刻",         sample: "19:30",       source: "checklist.laundry.*.at" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx", source: "自動生成 (該当シフトのチェックリストページ)" },
    ],
    inspection: [
      { name: "date",     label: "チェックイン日",   sample: "2026/04/20",   source: "booking.checkIn" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",     source: "booking.propertyName" },
      { name: "guest",    label: "ゲスト名",         sample: "John Smith",  source: "booking.guestName" },
      { name: "checkin",  label: "チェックイン日",   sample: "2026/04/20",   source: "booking.checkIn" },
      { name: "checkout", label: "チェックアウト日",  sample: "2026/04/22",  source: "booking.checkOut" },
    ],
  };

  // ========== 通知定義 ==========
  const NOTIFICATIONS = [
    { key: "recruit_response", label: "スタッフ回答通知", desc: "スタッフが募集に回答(◎/△/×)した時にWebアプリ管理者へ通知", icon: "bi-reply", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "📋 募集に回答がありました\n\n日付: {date} ({property})\n{staff}: {response}\n候補: {count}名" },
    { key: "recruit_start", label: "作業スタッフ募集", desc: "新しい清掃/直前点検に対してスタッフへ募集通知を送信", icon: "bi-megaphone", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🧹 {work}スタッフ募集\n\n{date} {property}\n{work}スタッフを募集しています。\n回答をお願いします（◎OK / △微妙 / ×NG）\n\n回答: {url}" },
    { key: "recruit_remind", label: "募集リマインド", desc: "回答が集まらない場合にリマインド送信", icon: "bi-alarm", group: "recruit", varGroup: "recruit", defaultTiming: "evening",
      defaultMsg: "📋 {work}募集 回答のお願い\n\n{date} {property}\nまだ回答が届いていません（現在{count}件）。\n回答: {url}" },
    { key: "staff_confirm", label: "スタッフ確定通知", desc: "スタッフ確定時に本人とWebアプリ管理者に通知", icon: "bi-person-check", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "✅ {work}担当が確定しました\n\n{date} {property}\n担当: {staff}\nよろしくお願いします。" },
    { key: "staff_undecided", label: "スタッフ未決定リマインド", desc: "作業日が近いのにスタッフ未確定の場合にWebアプリ管理者へ通知", icon: "bi-exclamation-triangle", group: "recruit", varGroup: "recruit", defaultTiming: "morning",
      defaultMsg: "⚠️ {work}スタッフ未確定\n\n{date} {property}\n作業日が近づいていますが、まだスタッフが確定していません。\n回答状況: {count}件" },
    { key: "urgent_remind", label: "直前予約リマインド", desc: "直前予約に対する緊急リマインド", icon: "bi-lightning", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🔴 緊急: 直前予約の{work}手配\n\n{date} {property}\n直前予約が入りました。至急スタッフの手配をお願いします。" },
    { key: "booking_cancel", label: "予約キャンセル通知", desc: "予約がキャンセルされた場合に通知", icon: "bi-x-circle", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "❌ 予約キャンセル\n\n{checkin}〜{date} {property}\nゲスト: {guest}（{site}）\n予約がキャンセルされました。" },
    { key: "booking_change", label: "予約変更通知", desc: "予約日程が変更された場合に通知", icon: "bi-arrow-repeat", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "🔄 予約変更\n\n{property}\n新しい日程: {checkin}〜{date}（{nights}泊）\nゲスト: {guest}" },
    { key: "cancel_request", label: "出勤キャンセル要望", desc: "スタッフからの出勤キャンセル要望をWebアプリ管理者に通知", icon: "bi-person-dash", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "🙋 出勤キャンセル要望\n\n{staff}さんから{date} {property}の出勤キャンセル要望がありました。" },
    { key: "cancel_approve", label: "キャンセル承認通知", desc: "出勤キャンセルを承認した場合にスタッフに通知", icon: "bi-check-circle", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "✅ キャンセル承認\n\n{date} {property}の出勤キャンセルが承認されました。" },
    { key: "cancel_reject", label: "キャンセル却下通知", desc: "出勤キャンセルを却下した場合にスタッフに通知", icon: "bi-dash-circle", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "❌ キャンセル不可\n\n{date} {property}の出勤キャンセルは対応できませんでした。出勤をお願いします。" },
    { key: "staff_inactive", label: "スタッフ非アクティブ化通知", desc: "直近15回の募集に無回答のスタッフを非アクティブ化した時にWebアプリ管理者へ通知", icon: "bi-person-slash", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "⚠️ スタッフ非アクティブ化\n\n{staff} さんを非アクティブに変更しました。\n理由: {reason}\n解除はスタッフ管理から行えます。" },
    { key: "roster_remind", label: "名簿未入力リマインド", desc: "宿泊者名簿が未入力の予約についてリマインド", icon: "bi-person-vcard", group: "booking", varGroup: "booking", defaultTiming: "morning",
      defaultMsg: "📝 名簿入力のお願い\n\n{checkin} {property}\nゲスト: {guest}\n宿泊者名簿がまだ届いていません。" },
    { key: "roster_received", label: "宿泊者名簿 受信通知", desc: "宿泊者名簿のフォーム回答が届いた時にWebアプリ管理者等へ通知", icon: "bi-envelope-check", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "📨 宿泊者名簿が届きました\n\n{checkin} {property}\nゲスト: {guest}\n詳細: {url}" },
    { key: "roster_updated", label: "名簿更新通知 (修正受信)", desc: "宿泊者が修正リンクから名簿を再送信した時にWebアプリ管理者へ通知", icon: "bi-arrow-repeat", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "🔄 宿泊者名簿が更新されました\n\n{checkin} {property}\nゲスト: {guest}\n\n変更内容:\n{changes}\n\n確認: {url}" },
    { key: "form_complete_mail_failed", label: "名簿入力サンクスメール 送信失敗", desc: "宿泊者へ送るサンクスメールが送信エラーになった時、Webアプリ管理者等へ通知", icon: "bi-envelope-exclamation", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: true, defaultOwnerLine: true, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: true,
      defaultMsg: "⚠️ 完了メール送信失敗\n\n物件: {property}\nゲスト: {guest} ({email})\nエラー: {error}\n\n手動で連絡してください。" },
    { key: "invoice_request", label: "請求書要請", desc: "月末にスタッフへ請求書の提出を依頼（URLは請求書作成ページ）", icon: "bi-receipt", group: "invoice", varGroup: "invoice", defaultTiming: "morning",
      defaultMsg: "💰 {month}月分の請求書作成をお願いします\n\n作業明細をご確認の上、請求書の送信をお願いします。\n作成ページ: {url}" },
    { key: "invoice_submitted", label: "請求書提出通知", desc: "スタッフが請求書を送信した時にWebアプリ管理者へ通知", icon: "bi-send-check", group: "invoice", varGroup: "invoice", defaultTiming: "immediate",
      defaultMsg: "📨 請求書が提出されました\n\n{staff} さんから {month}月分の請求書が届きました。\n合計: {total}\n確認: {url}" },
    { key: "cleaning_done", label: "清掃完了通知", desc: "清掃チェックリスト完了時にWebアプリ管理者に通知", icon: "bi-clipboard-check", group: "cleaning", varGroup: "cleaning", defaultTiming: "immediate",
      defaultMsg: "✨ 清掃完了\n\n{date} {property}\n{staff}さんが{time}に清掃を完了しました。\n詳細: {url}" },
    { key: "laundry_put_out", label: "ランドリー 出した", desc: "スタッフが「洗濯物を出した」ボタンを押した時にWebアプリ管理者等へ通知", icon: "bi-arrow-up-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 出した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を出しました。\n詳細: {url}" },
    { key: "laundry_collected", label: "ランドリー 回収した", desc: "スタッフが「洗濯物を回収した」ボタンを押した時にWebアプリ管理者等へ通知", icon: "bi-arrow-down-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 回収した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を回収しました。\n詳細: {url}" },
    { key: "laundry_stored", label: "ランドリー 収納した", desc: "スタッフが「洗濯物を収納した」ボタンを押した時にWebアプリ管理者等へ通知", icon: "bi-check2-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 収納した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を収納しました。\n詳細: {url}" },
    { key: "double_booking", label: "ダブルブッキング検知", desc: "同物件・同日程に複数予約が重複した際にWebアプリ管理者へ緊急通知", icon: "bi-exclamation-triangle-fill", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: true, defaultOwnerLine: true, defaultGroupLine: true, defaultStaffLine: false, defaultEmail: false,
      defaultMsg: "【⚠️ ダブルブッキング警告】\n物件: {property}\n日程: {checkin} 〜 {date}\n\n衝突予約が検出されました。至急確認してください。\n確認: {url}" },
    // ----- 追加: バックエンドで使用されていたが未登録の通知種別 -----
    { key: "roster_mismatch", label: "名簿照合エラー", desc: "宿泊者名簿の内容が既存予約と一致しない場合にWebアプリ管理者へ通知（予約なし・人数不一致・CO日不一致）", icon: "bi-exclamation-diamond", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: true, defaultOwnerLine: true, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: true,
      defaultMsg: "⚠️ 名簿照合エラー\n\nゲスト: {guest}\nCI: {checkin}\n詳細: {error}\n\n名簿確認: {url}" },
    // タスク6: タイミング基準を清掃日に変更 (after_cleaning_hours / after_cleaning_days / after_checklist_complete)
    { key: "laundry_reminder", label: "ランドリー入力リマインド", desc: "清掃完了後、スタッフへランドリー記録の入力を促す通知（タイミング基準: 清掃日）", icon: "bi-basket", group: "cleaning", varGroup: "cleaning", defaultTiming: "after_cleaning_hours",
      defaultEnabled: true, defaultOwnerLine: false, defaultGroupLine: false, defaultStaffLine: true, defaultEmail: false,
      laundryReminderTiming: true,
      defaultMsg: "🧺 ランドリーを使用した場合は記録をお願いします\n\n{date} {property}\n入力: {url}" },
    { key: "error_alert", label: "エラーアラート", desc: "Cloud Functions でシステムエラーが発生した際にWebアプリ管理者へ通知", icon: "bi-bug", group: "system", varGroup: "system", defaultTiming: "immediate",
      defaultEnabled: true, defaultOwnerLine: true, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: false,
      defaultMsg: "🚨 システムエラー\n\n{error}\n\n管理画面: {url}" },
    // タスク5: scan_pending は民泊v2に不要なため削除 (scan-sorter プロジェクトのみで使用)
    // ----- キーボックス送信通知 (タスク2) -----
    { key: "keybox_send", label: "キーボックス情報送信", desc: "ゲストへキーボックス暗証番号・施設案内メールを自動送信", icon: "bi-key", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: false, defaultOwnerLine: false, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: false,
      defaultMsg: "" },
    { key: "keybox_remind", label: "キーボックス送信リマインド (OKボタン未押下)", desc: "OKボタン未押下のためキーボックス情報が未送信の場合にWebアプリ管理者へ警告", icon: "bi-key-fill", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: true, defaultOwnerLine: true, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: false,
      defaultMsg: "⚠️ キーボックス情報未送信\n\nゲスト: {guest}\nCI: {checkin}\nOKボタンが未押下のため送信がスケジュールされていません。\n確認: {url}" },
    // 直前点検リマインド
    { key: "inspection_reminder", label: "直前点検リマインド", desc: "チェックイン前日(デフォルト)に物件オーナー/管理者に直前点検を通知", icon: "bi-search", group: "cleaning", varGroup: "inspection", defaultTiming: "beforeEvent",
      defaultEnabled: false, defaultOwnerLine: true, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: false,
      defaultMsg: "🔍 直前点検リマインド\n\n{date} チェックイン前の点検をお忘れなく\n物件: {property}\nゲスト: {guest}" },
    // タイミー募集依頼 (新規確定予約検知時に物件オーナー宛に通知)
    { key: "timee_posting", label: "タイミー募集依頼", desc: "新規予約確定時に物件オーナーへタイミーでの求人募集を依頼する通知", icon: "bi-clock-history", group: "recruit", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: false, defaultOwnerLine: true, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: true,
      defaultMsg: "🕐 タイミー募集依頼\n\nタイミー募集が必要な予約が入りました。\nチェックアウト日時: {date}\n物件: {property}\n\nこの日の求人募集をタイミーでお願いします。\n\nタイミー: https://app-new.taimee.co.jp/account" },
  ];

  function findNotification(key) {
    return NOTIFICATIONS.find(n => n.key === key) || null;
  }

  function groupNotifications() {
    const groups = {};
    NOTIFICATIONS.forEach(n => {
      if (!groups[n.group]) groups[n.group] = [];
      groups[n.group].push(n);
    });
    return groups;
  }

  // data-key 属性に埋める文字列。idPrefix を渡すと "<prefix>::<key>" 形式にする
  function dataKey(key, idPrefix) {
    return idPrefix ? `${idPrefix}::${key}` : key;
  }

  // ========== 1通知ぶんの編集カード描画 ==========
  /**
   * @param {object} n            通知定義 (NOTIFICATIONS の1要素)
   * @param {object} channelData  現在の値 (settings.channels[key] / overrides[key]) — 空なら defaultXxx 適用
   * @param {object} opt
   *   - idPrefix: string  data-key プレフィックス (省略時 = "")
   *   - collapsed: bool   true なら折り畳み状態で出力 (default: true)
   *   - showTestButton: bool  テスト送信ボタン表示 (default: true)
   *   - extraBadgeHtml: string  ヘッダー右に追加バッジ (例: "(物件別上書き中)")
   *   - extraActionsHtml: string  テスト送信ボタンの隣に追加ボタン (例: "共通デフォルトに戻す")
   * @returns {string} HTML
   */
  function renderNotificationCard(n, channelData, opt = {}) {
    const ch = channelData || {};
    const idPrefix = opt.idPrefix || "";
    const dk = dataKey(n.key, idPrefix);
    const collapsed = opt.collapsed !== false;

    // 既定値 (Firestore 未設定時) の解決
    const enabled = ch.enabled !== undefined ? ch.enabled !== false : (n.defaultEnabled !== false);
    const ownerLine = ch.ownerLine !== undefined ? ch.ownerLine !== false : (n.defaultOwnerLine !== false);
    const groupLine = ch.groupLine !== undefined ? !!ch.groupLine : (!!n.defaultGroupLine);
    const staffLine = ch.staffLine !== undefined ? !!ch.staffLine : (!!n.defaultStaffLine);
    const ownerEmail = ch.ownerEmail !== undefined ? !!ch.ownerEmail : (!!n.defaultEmail);
    const propertyEmail = !!ch.propertyEmail;
    const subOwnerLine = !!ch.subOwnerLine;
    const subOwnerEmail = !!ch.subOwnerEmail;
    const staffEmail = !!ch.staffEmail;
    const discordOwner = !!ch.discordOwner;
    const discordSubOwner = !!ch.discordSubOwner;
    const fcmStaff = !!ch.fcmStaff;
    const fcmOwner = !!ch.fcmOwner;
    const customMessage = ch.customMessage || "";
    const msgValue = customMessage || n.defaultMsg || n.desc;
    const vars = SYSTEM_VARIABLES[n.varGroup] || [];

    // タイミング配列化 (旧データは単一フィールドから復元)
    const timings = Array.isArray(ch.timings) && ch.timings.length
      ? ch.timings
      : [{
          mode: ch.mode || "event",
          timing: ch.timing || n.defaultTiming || "immediate",
          timingMinutes: ch.timingMinutes || "",
          beforeDays: ch.beforeDays || 3,
          beforeTime: ch.beforeTime || "09:00",
          schedulePattern: ch.schedulePattern || "monthEnd",
          scheduleDay: ch.scheduleDay || 1,
          scheduleDow: ch.scheduleDow || 0,
          scheduleTime: ch.scheduleTime || "09:00",
        }];

    const varTags = vars.map(v =>
      `<span class="badge bg-light text-dark border me-1 mb-1 var-insert-tag" role="button" data-var="{${v.name}}" data-target="${dk}" title="${v.label}（${v.source}）">{${v.name}} <small class="text-muted">${v.label}</small></span>`
    ).join("");

    // プレビュー用サンプル置換
    let preview = msgValue;
    vars.forEach(v => {
      preview = preview.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });

    const showTestButton = opt.showTestButton !== false;
    const extraBadgeHtml = opt.extraBadgeHtml || "";
    const extraActionsHtml = opt.extraActionsHtml || "";
    const hideHeader = opt.hideHeader === true; // 親カードでヘッダーを表示している場合は二重表示を抑止

    const headerHtml = hideHeader ? "" : `
            <div class="d-flex align-items-center gap-2 mb-1" style="cursor:pointer;" data-notify-toggle="${dk}">
              <i class="bi bi-chevron-right notify-chevron" data-key="${dk}" style="transition:transform 0.2s; transform:${collapsed ? "rotate(0deg)" : "rotate(90deg)"};"></i>
              <i class="bi ${n.icon} text-primary"></i>
              <strong>${n.label}</strong>
              ${extraBadgeHtml}
            </div>`;
    const collapseInlineStyle = hideHeader ? "" : `style="display:${collapsed ? "none" : ""};"`;

    return `
      <div class="notify-channel-card" data-card-key="${dk}">
        <div class="d-flex justify-content-between align-items-start">
          <div class="flex-grow-1">
            ${headerHtml}
            <div class="notify-collapse" data-key="${dk}" ${collapseInlineStyle}>
            ${hideHeader ? "" : `<div class="text-muted small mb-2">${n.desc}</div>`}

            <!-- 送信先チェックボックス (歯車廃止 → インライン値表示 + ✏️ 編集ボタン) -->
            <div class="notify-target-rows mb-2" data-dk="${dk}">
              <!-- ① Webアプリ管理者 -->
              <div class="notify-target-group-title small fw-bold text-secondary border-bottom pb-1 mb-1 mt-1"><i class="bi bi-person-circle"></i> Webアプリ管理者</div>
              ${_renderTargetRow(dk, "ownerLine",      ownerLine,      "bi-line text-success",               "LINE",     "(送信元: LINE Bot)")}
              ${_renderTargetRow(dk, "ownerEmail",     ownerEmail,     "bi-envelope text-warning",           "メール",    "(送信元: 連携済み Gmail)")}
              ${_renderTargetRow(dk, "discordOwner",   discordOwner,   "bi-discord",                         "Discord",  "(送信元: Discord Bot)", "color:#5865F2")}
              <!-- ② 物件オーナー個別 -->
              <div class="notify-target-group-title small fw-bold text-secondary border-bottom pb-1 mb-1 mt-3"><i class="bi bi-person-badge"></i> 物件オーナー</div>
              ${_renderTargetRow(dk, "subOwnerLine",   subOwnerLine,   "bi-line text-success",               "LINE",     "(送信元: LINE Bot)")}
              ${_renderTargetRow(dk, "subOwnerEmail",  subOwnerEmail,  "bi-envelope-at text-success",        "メール",    "(送信元: 物件オーナーの Gmail)")}
              ${_renderTargetRow(dk, "discordSubOwner",discordSubOwner,"bi-discord",                         "Discord",  "(送信元: Discord Bot)", "color:#8da0f8")}
              <!-- ③ スタッフ個別 -->
              <div class="notify-target-group-title small fw-bold text-secondary border-bottom pb-1 mb-1 mt-3"><i class="bi bi-person-lines-fill"></i> スタッフ個別</div>
              ${_renderTargetRow(dk, "staffLine",      staffLine,      "bi-line text-info",                  "LINE",     "(送信元: LINE Bot)")}
              ${_renderTargetRow(dk, "staffEmail",     staffEmail,     "bi-envelope-fill text-info",         "メール",    "(送信元: 連携済み Gmail)")}
              <!-- ④ 物件 (物件単位の宛先) -->
              <div class="notify-target-group-title small fw-bold text-secondary border-bottom pb-1 mb-1 mt-3"><i class="bi bi-building"></i> 物件</div>
              ${_renderTargetRow(dk, "propertyEmail",  propertyEmail,  "bi-envelope-at text-primary",        "メール",    "(送信元: 物件単位の Gmail / 受信先: 同アドレス)")}
              <!-- ⑤ グループ -->
              <div class="notify-target-group-title small fw-bold text-secondary border-bottom pb-1 mb-1 mt-3"><i class="bi bi-people-fill"></i> グループ</div>
              ${_renderTargetRow(dk, "groupLine",      groupLine,      "bi-line text-primary",               "LINE",     "(送信元: 物件別 LINE Bot)")}
              <!-- FCM (Web Push) は将来再検討。iOS 制約により導入保留 -->
              <label class="form-check form-check-inline mb-0 d-none">
                <input class="form-check-input" type="checkbox" data-key="${dk}" data-field="fcmStaff" ${fcmStaff ? "checked" : ""}>
                <span class="form-check-label small"><i class="bi bi-bell-fill text-primary"></i> Web Push(スタッフ)</span>
              </label>
              <label class="form-check form-check-inline mb-0 d-none">
                <input class="form-check-input" type="checkbox" data-key="${dk}" data-field="fcmOwner" ${fcmOwner ? "checked" : ""}>
                <span class="form-check-label small"><i class="bi bi-bell text-success"></i> Web Push(Webアプリ管理者)</span>
              </label>
            </div>

            <!-- タスク6: ランドリーリマインド専用タイミングUI (清掃日基準) -->
            ${n.laundryReminderTiming ? _renderLaundryReminderTimingUI(dk, ch) : `
            <!-- 通知タイミング (複数追加可能) -->
            <div class="mb-2 notify-timings-wrap" data-key="${dk}">
              <div class="small text-muted mb-1"><i class="bi bi-clock"></i> 通知タイミング (複数追加可能)</div>
              <div class="notify-timings" data-key="${dk}">
                ${timings.map((t, idx) => renderTimingRow(dk, t, idx)).join("")}
              </div>
              <button type="button" class="btn btn-sm btn-outline-primary mt-1 notify-add-timing" data-key="${dk}">
                <i class="bi bi-plus"></i> タイミングを追加
              </button>
            </div>
            `}

            <!-- 利用可能な変数 -->
            <div class="mb-2">
              <span class="small text-muted">変数（クリックで挿入）:</span>
              <div class="d-flex flex-wrap mt-1">${varTags}</div>
            </div>

            <!-- メッセージ + プレビュー -->
            <div class="row g-2 mb-2">
              <div class="col-md-6">
                <label class="form-label small text-muted mb-1"><i class="bi bi-pencil"></i> メッセージ</label>
                <textarea class="form-control form-control-sm notify-msg-input"
                          rows="5"
                          data-key="${dk}"
                          data-var-group="${n.varGroup}"
                          data-field="customMessage">${escapeText(msgValue)}</textarea>
              </div>
              <div class="col-md-6">
                <label class="form-label small text-muted mb-1"><i class="bi bi-eye"></i> プレビュー</label>
                <div class="notify-preview border rounded p-2 bg-light small" data-preview="${dk}" style="white-space:pre-wrap;min-height:130px;font-size:0.85rem;">${escapeText(preview)}</div>
              </div>
            </div>

            <div class="d-flex flex-wrap align-items-center gap-2">
              ${showTestButton ? `<button class="btn btn-sm btn-outline-primary btn-test-send" type="button" data-key="${dk}" data-var-group="${n.varGroup}"><i class="bi bi-send"></i> テスト送信</button>` : ""}
              ${extraActionsHtml}
            </div>
            </div><!-- /notify-collapse -->
          </div>

          ${hideHeader ? `
          <!-- 親カード(rf-card-header)のトグルを使うため、内側 notify-toggle は隠す。値は同期するため input は残す(非表示) -->
          <input type="checkbox" class="d-none" data-key="${dk}" data-field="enabled" ${enabled ? "checked" : ""}>
          ` : `
          <div class="form-check form-switch notify-toggle ms-3">
            <input class="form-check-input" type="checkbox" data-key="${dk}" data-field="enabled" ${enabled ? "checked" : ""}>
          </div>
          `}
        </div>
      </div>`;
  }

  // ========== 通知先1行レンダリング (歯車廃止 → インライン値バッジ付き) ==========
  /**
   * チェックボックス1行を生成する内部ヘルパー
   * 値バッジのプレースホルダーを埋め込み、hydrateBadges() で非同期に差し込む
   * @param {string} dk       data-key 属性値
   * @param {string} field    フィールド名 ("ownerLine" 等)
   * @param {boolean} checked チェック状態
   * @param {string} icon     Bootstrap icon クラス
   * @param {string} label    表示ラベル
   * @param {string} subLabel 薄字の補足テキスト
   * @param {string} iconStyle アイコンの style 属性 (省略可)
   * @returns {string} <label> HTML
   */
  function _renderTargetRow(dk, field, checked, icon, label, subLabel, iconStyle) {
    // プレースホルダー (hydrateBadges で非同期差し込み)
    // - actions: 1行目右端の ✏️ + ↗ ボタン
    // - value:   3行目の値バッジ + フォールバックバッジ
    const actionsPlaceholder = `<span class="notify-target-actions notify-target-placeholder d-inline-flex align-items-center gap-1" data-field="${field}" data-slot="actions"></span>`;
    const valuePlaceholder = `<span class="notify-target-value notify-target-placeholder d-inline-flex align-items-center gap-1 flex-wrap" data-field="${field}" data-slot="value"></span>`;
    const iconEl = iconStyle
      ? `<i class="bi ${icon}" style="${iconStyle}"></i>`
      : `<i class="bi ${icon}"></i>`;
    // 3行構成:
    //   1行目: チェックボックス + アイコン+見出し + (右端) ✏️↗
    //   2行目: 送信元注記 (薄字)
    //   3行目: 値バッジ + フォールバックバッジ
    return `
      <div class="notify-target-block mb-2" data-field="${field}">
        <div class="d-flex align-items-center gap-2">
          <label class="d-inline-flex align-items-center gap-1 mb-0 flex-grow-1" style="cursor:pointer;">
            <input class="form-check-input mt-0 flex-shrink-0" type="checkbox" data-key="${dk}" data-field="${field}" ${checked ? "checked" : ""}>
            <span class="small d-inline-flex align-items-center gap-1">
              ${iconEl}<span>${label}</span>
            </span>
          </label>
          ${actionsPlaceholder}
        </div>
        ${subLabel ? `<div class="text-muted ps-4" style="font-size:0.72em;line-height:1.2;">${subLabel}</div>` : ""}
        <div class="ps-4 mt-1">${valuePlaceholder}</div>
      </div>`;
  }

  // ========== タスク6: ランドリーリマインド 専用タイミングUI (清掃日基準) ==========
  function _renderLaundryReminderTimingUI(dk, ch) {
    const mode = ch.laundryTimingMode || "after_cleaning_hours";
    const hours = ch.laundryTimingHours !== undefined ? ch.laundryTimingHours : 2;
    const days = ch.laundryTimingDays !== undefined ? ch.laundryTimingDays : 0;
    // 翌朝指定時刻モード: laundryTimingTime に "HH:MM" を保存
    const nextMorningTime = ch.laundryTimingTime || "06:00";
    const isHours = mode === "after_cleaning_hours" || mode === "after_checklist_complete";
    const isDays  = mode === "after_cleaning_days";
    const isTime  = mode === "next_morning_time";
    return `
      <div class="mb-2 laundry-timing-wrap" data-key="${dk}">
        <div class="small text-muted mb-1"><i class="bi bi-clock"></i> 通知タイミング（清掃日基準）</div>
        <div class="d-flex flex-wrap align-items-center gap-2">
          <select class="form-select form-select-sm laundry-timing-mode" style="width:auto;" data-key="${dk}" data-field="laundryTimingMode">
            <option value="after_cleaning_hours"     ${mode==="after_cleaning_hours"?"selected":""}>清掃日の N時間後</option>
            <option value="after_cleaning_days"      ${mode==="after_cleaning_days"?"selected":""}>清掃日の N日後</option>
            <option value="after_checklist_complete" ${mode==="after_checklist_complete"?"selected":""}>清掃完了報告から N時間後</option>
            <option value="next_morning_time"        ${mode==="next_morning_time"?"selected":""}>翌朝 指定時刻に送信</option>
          </select>
          <input type="number" class="form-control form-control-sm laundry-timing-hours ${!isHours?"d-none":""}"
            style="width:75px;" data-key="${dk}" data-field="laundryTimingHours"
            value="${hours}" min="0" max="72" placeholder="時間">
          <span class="small laundry-timing-hours-suffix ${!isHours?"d-none":""}">時間後</span>
          <input type="number" class="form-control form-control-sm laundry-timing-days ${!isDays?"d-none":""}"
            style="width:75px;" data-key="${dk}" data-field="laundryTimingDays"
            value="${days}" min="0" max="7" placeholder="日">
          <span class="small laundry-timing-days-suffix ${!isDays?"d-none":""}">日後</span>
          <!-- 翌朝指定時刻入力 -->
          <input type="time" class="form-control form-control-sm laundry-timing-time ${!isTime?"d-none":""}"
            style="width:120px;" data-key="${dk}" data-field="laundryTimingTime"
            value="${nextMorningTime}">
          <span class="small laundry-timing-time-suffix ${!isTime?"d-none":""}">に送信</span>
        </div>
        <div class="small text-muted mt-1" style="font-size:0.72rem;"><i class="bi bi-info-circle"></i> バックエンドが清掃日 (shifts.date) を基準に計算して条件を満たす予約に送信します。</div>
      </div>
    `;
  }

  // ========== 1タイミングぶんの行 ==========
  function renderTimingRow(dk, t, idx) {
    const mode = t.mode || "event";
    const timing = t.timing || "immediate";
    const showEventBlock = mode === "event";
    const showDateBlock = mode === "date";
    const showMinutes = showEventBlock && timing === "custom";
    const showBeforeEvent = showEventBlock && timing === "beforeEvent";
    const pat = t.schedulePattern || "monthEnd";
    // name 属性でラジオを排他にするため、衝突しない一意なIDを作る
    const radioName = `mode-${dk.replace(/[^a-zA-Z0-9_-]/g, "_")}-${idx}`;
    return `
      <div class="notify-timing-row d-flex flex-wrap align-items-center gap-1 p-2 mb-1 border rounded" data-key="${dk}" data-idx="${idx}">
        <div class="btn-group btn-group-sm" role="group">
          <input type="radio" class="btn-check notify-mode-radio" name="${radioName}" id="${radioName}-event" value="event" ${mode==="event"?"checked":""} data-key="${dk}" data-idx="${idx}">
          <label class="btn btn-outline-secondary" for="${radioName}-event">都度</label>
          <input type="radio" class="btn-check notify-mode-radio" name="${radioName}" id="${radioName}-date" value="date" ${mode==="date"?"checked":""} data-key="${dk}" data-idx="${idx}">
          <label class="btn btn-outline-secondary" for="${radioName}-date">日付</label>
        </div>

        <div class="notify-mode-event align-items-center gap-1 ${showEventBlock?"d-flex":"d-none"}" data-key="${dk}" data-idx="${idx}">
          <select class="form-select form-select-sm notify-timing-select" style="width:auto;" data-key="${dk}" data-idx="${idx}" data-field="timing">
            ${[["immediate","即時"],["5min","5分後"],["15min","15分後"],["30min","30分後"],["1hour","1時間後"],["morning","翌朝6時"],["evening","当日18時"],["custom","カスタム（分）"],["beforeEvent","N日前のHH:MM"]].map(([v,l]) => `<option value="${v}" ${timing===v?"selected":""}>${l}</option>`).join("")}
          </select>
          <input type="number" class="form-control form-control-sm notify-timing-minutes ${showMinutes?"":"d-none"}"
            style="width:90px;" data-key="${dk}" data-idx="${idx}" data-field="timingMinutes"
            value="${t.timingMinutes||""}" min="1" placeholder="分数">
          <input type="number" class="form-control form-control-sm notify-before-days ${showBeforeEvent?"":"d-none"}"
            style="width:72px;" data-key="${dk}" data-idx="${idx}" data-field="beforeDays"
            value="${t.beforeDays||3}" min="0" placeholder="日">
          <span class="small notify-before-suffix ${showBeforeEvent?"":"d-none"}" data-key="${dk}" data-idx="${idx}">日前の</span>
          <input type="time" class="form-control form-control-sm notify-before-time ${showBeforeEvent?"":"d-none"}"
            style="width:110px;" data-key="${dk}" data-idx="${idx}" data-field="beforeTime"
            value="${t.beforeTime||"09:00"}">
        </div>

        <div class="notify-mode-date align-items-center gap-1 ${showDateBlock?"d-flex":"d-none"}" data-key="${dk}" data-idx="${idx}">
          <select class="form-select form-select-sm notify-schedule-pattern" style="width:auto;" data-key="${dk}" data-idx="${idx}" data-field="schedulePattern">
            <option value="monthEnd" ${pat==="monthEnd"?"selected":""}>毎月 月末</option>
            <option value="monthlyDay" ${pat==="monthlyDay"?"selected":""}>毎月 N日</option>
            <option value="weekly" ${pat==="weekly"?"selected":""}>毎週 曜日</option>
            <option value="daily" ${pat==="daily"?"selected":""}>毎日</option>
          </select>
          <input type="number" class="form-control form-control-sm notify-schedule-day ${pat==="monthlyDay"?"":"d-none"}"
            style="width:70px;" data-key="${dk}" data-idx="${idx}" data-field="scheduleDay"
            value="${t.scheduleDay||1}" min="1" max="31" placeholder="日">
          <select class="form-select form-select-sm notify-schedule-dow ${pat==="weekly"?"":"d-none"}"
            style="width:auto;" data-key="${dk}" data-idx="${idx}" data-field="scheduleDow">
            ${["日","月","火","水","木","金","土"].map((d,i)=>`<option value="${i}" ${(t.scheduleDow||0)==i?"selected":""}>${d}</option>`).join("")}
          </select>
          <input type="time" class="form-control form-control-sm notify-schedule-time"
            style="width:110px;" data-key="${dk}" data-idx="${idx}" data-field="scheduleTime"
            value="${t.scheduleTime||"09:00"}">
        </div>

        <button type="button" class="btn btn-sm btn-link text-danger ms-auto notify-remove-timing" data-key="${dk}" data-idx="${idx}" title="このタイミングを削除">
          <i class="bi bi-x-circle"></i>
        </button>
      </div>
    `;
  }

  // ========== プレビュー再描画 ==========
  function updatePreview(dk, scope) {
    const root = scope || document;
    const ta = root.querySelector(`textarea[data-key="${cssEsc(dk)}"][data-field="customMessage"]`);
    const el = root.querySelector(`[data-preview="${cssEsc(dk)}"]`);
    if (!ta || !el) return;
    const varGroup = ta.dataset.varGroup;
    const vars = SYSTEM_VARIABLES[varGroup] || [];
    let msg = ta.value || "";
    vars.forEach(v => {
      msg = msg.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });
    el.textContent = msg;
  }

  // ========== DOM から1通知ぶんの値を読み取る ==========
  function readChannelValue(scope, key, opt = {}) {
    const idPrefix = opt.idPrefix || "";
    const dk = dataKey(key, idPrefix);
    const get = (field) => {
      const el = scope.querySelector(`[data-key="${cssEsc(dk)}"][data-field="${field}"]`);
      return el ? el.checked : false;
    };
    const ta = scope.querySelector(`textarea[data-key="${cssEsc(dk)}"][data-field="customMessage"]`);
    const rows = scope.querySelectorAll(`.notify-timings[data-key="${cssEsc(dk)}"] .notify-timing-row`);
    const timings = [];
    rows.forEach((row) => {
      const modeChecked = row.querySelector(`input[type="radio"]:checked`);
      const mode = modeChecked ? modeChecked.value : "event";
      const q = (sel) => row.querySelector(sel);
      const t = { mode };
      if (mode === "event") {
        const timing = q(`select[data-field="timing"]`)?.value || "immediate";
        t.timing = timing;
        if (timing === "custom") {
          t.timingMinutes = parseInt(q(`input[data-field="timingMinutes"]`)?.value, 10) || 0;
        } else if (timing === "beforeEvent") {
          t.beforeDays = parseInt(q(`input[data-field="beforeDays"]`)?.value, 10) || 0;
          t.beforeTime = q(`input[data-field="beforeTime"]`)?.value || "09:00";
        }
      } else {
        t.schedulePattern = q(`select[data-field="schedulePattern"]`)?.value || "monthEnd";
        t.scheduleTime = q(`input[data-field="scheduleTime"]`)?.value || "09:00";
        if (t.schedulePattern === "monthlyDay") {
          t.scheduleDay = parseInt(q(`input[data-field="scheduleDay"]`)?.value, 10) || 1;
        } else if (t.schedulePattern === "weekly") {
          t.scheduleDow = parseInt(q(`select[data-field="scheduleDow"]`)?.value, 10) || 0;
        }
      }
      timings.push(t);
    });
    // タスク6: ランドリーリマインド専用タイミング値を読み取る
    const laundryWrap = scope.querySelector(`.laundry-timing-wrap[data-key="${cssEsc(dk)}"]`);
    const laundryTimingMode = laundryWrap
      ? (laundryWrap.querySelector(`select[data-field="laundryTimingMode"]`)?.value || "after_cleaning_hours")
      : undefined;
    const laundryTimingHours = laundryWrap
      ? (parseInt(laundryWrap.querySelector(`input[data-field="laundryTimingHours"]`)?.value, 10) || 2)
      : undefined;
    const laundryTimingDays = laundryWrap
      ? (parseInt(laundryWrap.querySelector(`input[data-field="laundryTimingDays"]`)?.value, 10) || 0)
      : undefined;
    // 翌朝指定時刻モード用フィールド
    const laundryTimingTime = laundryWrap
      ? (laundryWrap.querySelector(`input[data-field="laundryTimingTime"]`)?.value || "06:00")
      : undefined;

    const entry = {
      enabled: get("enabled"),
      ownerLine: get("ownerLine"),
      groupLine: get("groupLine"),
      staffLine: get("staffLine"),
      staffEmail: get("staffEmail"),
      ownerEmail: get("ownerEmail"),
      propertyEmail: get("propertyEmail"),
      subOwnerLine: get("subOwnerLine"),
      subOwnerEmail: get("subOwnerEmail"),
      discordOwner: get("discordOwner"),
      discordSubOwner: get("discordSubOwner"),
      fcmStaff: get("fcmStaff"),
      fcmOwner: get("fcmOwner"),
      customMessage: ta ? ta.value : "",
      timings,
      ...(laundryTimingMode !== undefined ? { laundryTimingMode, laundryTimingHours, laundryTimingDays, laundryTimingTime } : {}),
    };
    // 後方互換: 旧UIの単一フィールドにも代表値を埋める
    if (timings[0]) {
      const t0 = timings[0];
      if (t0.mode) entry.mode = t0.mode;
      if (t0.timing) entry.timing = t0.timing;
      if (t0.timingMinutes !== undefined) entry.timingMinutes = t0.timingMinutes;
      if (t0.beforeDays !== undefined) entry.beforeDays = t0.beforeDays;
      if (t0.beforeTime) entry.beforeTime = t0.beforeTime;
      if (t0.schedulePattern) entry.schedulePattern = t0.schedulePattern;
      if (t0.scheduleDay !== undefined) entry.scheduleDay = t0.scheduleDay;
      if (t0.scheduleDow !== undefined) entry.scheduleDow = t0.scheduleDow;
      if (t0.scheduleTime) entry.scheduleTime = t0.scheduleTime;
    }
    Object.keys(entry).forEach(k => { if (entry[k] === undefined) delete entry[k]; });
    return entry;
  }

  // ========== イベントバインド (クリック・入力・タイミング追加削除・モード切替) ==========
  /**
   * @param {HTMLElement} container 1つ以上のカードを含むコンテナ要素
   * @param {object} opt
   *   - onChange()  値変更時に呼ばれる (debounce/保存等は呼び出し側で実装)
   *   - onTestSend(key, channelData, varGroup) テスト送信時に呼ばれる
   *   - idPrefix
   */
  function bindCardEvents(container, opt = {}) {
    if (container.__notifyEditorBound) return;
    container.__notifyEditorBound = true;

    // 値バッジを非同期で差し込む（NotifyTargetEditor が読み込まれている場合）
    const NTE = window.NotifyTargetEditor;
    if (NTE && typeof NTE.hydrateBadges === "function") {
      NTE.hydrateBadges(container, typeof opt.onChange === "function" ? opt.onChange : null);
    }

    container.addEventListener("click", (e) => {
      // 設定リンクは label 内に置いてあるため、ブラウザ標準のチェックトグル動作を抑止し、手動でハッシュ遷移
      const cfgLink = e.target.closest(".notify-config-link");
      if (cfgLink) {
        e.preventDefault();
        e.stopPropagation();
        const href = cfgLink.getAttribute("href") || "";
        if (href.startsWith("#")) window.location.hash = href.slice(1);
        else if (href) window.open(href, "_blank", "noopener");
        return;
      }
      // 折り畳みトグル
      const toggler = e.target.closest("[data-notify-toggle]");
      if (toggler && !e.target.closest("input") && !e.target.closest("button")) {
        const dk = toggler.dataset.notifyToggle;
        const body = container.querySelector(`.notify-collapse[data-key="${cssEsc(dk)}"]`);
        const chev = container.querySelector(`.notify-chevron[data-key="${cssEsc(dk)}"]`);
        if (body) {
          const isOpen = body.style.display !== "none";
          body.style.display = isOpen ? "none" : "";
          if (chev) chev.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";
        }
        return;
      }
      // テスト送信
      const tbtn = e.target.closest(".btn-test-send");
      if (tbtn) {
        if (typeof opt.onTestSend === "function") {
          const dk = tbtn.dataset.key;
          const realKey = stripPrefix(dk, opt.idPrefix);
          const value = readChannelValue(container, realKey, { idPrefix: opt.idPrefix || "" });
          opt.onTestSend(realKey, value, tbtn.dataset.varGroup, tbtn);
        }
        return;
      }
      // 変数タグクリック → textarea に挿入
      const tag = e.target.closest(".var-insert-tag");
      if (tag) {
        const targetDk = tag.dataset.target;
        const ta = container.querySelector(`textarea[data-key="${cssEsc(targetDk)}"][data-field="customMessage"]`);
        if (ta) {
          const pos = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, pos) + tag.dataset.var + ta.value.slice(pos);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos + tag.dataset.var.length;
          updatePreview(targetDk, container);
          if (typeof opt.onChange === "function") opt.onChange();
        }
        return;
      }
      // タイミング追加
      const addBtn = e.target.closest(".notify-add-timing");
      if (addBtn) {
        const dk = addBtn.dataset.key;
        const list = container.querySelector(`.notify-timings[data-key="${cssEsc(dk)}"]`);
        if (list) {
          const idx = list.querySelectorAll(".notify-timing-row").length;
          const emptyT = { mode: "event", timing: "immediate", timingMinutes: "", beforeDays: 3, beforeTime: "09:00", schedulePattern: "monthEnd", scheduleDay: 1, scheduleDow: 0, scheduleTime: "09:00" };
          list.insertAdjacentHTML("beforeend", renderTimingRow(dk, emptyT, idx));
          if (typeof opt.onChange === "function") opt.onChange();
        }
        return;
      }
      // タイミング削除
      const rmBtn = e.target.closest(".notify-remove-timing");
      if (rmBtn) {
        const row = rmBtn.closest(".notify-timing-row");
        const list = row?.parentElement;
        row?.remove();
        list?.querySelectorAll(".notify-timing-row").forEach((r, i) => {
          r.dataset.idx = i;
          r.querySelectorAll("[data-idx]").forEach(el => el.dataset.idx = i);
        });
        if (typeof opt.onChange === "function") opt.onChange();
        return;
      }
    });

    // textarea 入力 → プレビュー更新 + onChange
    container.addEventListener("input", (e) => {
      const t = e.target;
      if (!t) return;
      if (t.classList && t.classList.contains("notify-msg-input")) {
        updatePreview(t.dataset.key, container);
      }
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") {
        if (typeof opt.onChange === "function") opt.onChange();
      }
    });

    // change: モード切替・タイミング種別切替・チェックボックス
    container.addEventListener("change", (e) => {
      const t = e.target;
      if (!t) return;

      // タイミング行のモード/種別切替
      const dkAttr = t.dataset.key;
      const idx = t.dataset.idx;
      if (dkAttr && idx !== undefined) {
        const row = container.querySelector(`.notify-timing-row[data-key="${cssEsc(dkAttr)}"][data-idx="${idx}"]`);
        if (row) {
          if (t.classList.contains("notify-mode-radio")) {
            const mode = t.value;
            row.querySelector(".notify-mode-event")?.classList.toggle("d-flex", mode === "event");
            row.querySelector(".notify-mode-event")?.classList.toggle("d-none", mode !== "event");
            row.querySelector(".notify-mode-date")?.classList.toggle("d-flex", mode === "date");
            row.querySelector(".notify-mode-date")?.classList.toggle("d-none", mode !== "date");
          }
          if (t.classList.contains("notify-timing-select")) {
            const val = t.value;
            row.querySelector(".notify-timing-minutes")?.classList.toggle("d-none", val !== "custom");
            row.querySelector(".notify-before-days")?.classList.toggle("d-none", val !== "beforeEvent");
            row.querySelector(".notify-before-suffix")?.classList.toggle("d-none", val !== "beforeEvent");
            row.querySelector(".notify-before-time")?.classList.toggle("d-none", val !== "beforeEvent");
          }
          if (t.classList.contains("notify-schedule-pattern")) {
            const val = t.value;
            row.querySelector(".notify-schedule-day")?.classList.toggle("d-none", val !== "monthlyDay");
            row.querySelector(".notify-schedule-dow")?.classList.toggle("d-none", val !== "weekly");
          }
        }
      }

      // タスク6: ランドリーリマインド タイミングモード切替
      if (t.classList.contains("laundry-timing-mode")) {
        const dk2 = t.dataset.key;
        const wrap = container.querySelector(`.laundry-timing-wrap[data-key="${cssEsc(dk2)}"]`);
        if (wrap) {
          const val = t.value;
          const isDays = val === "after_cleaning_days";
          const isTime = val === "next_morning_time";
          const isHours = val === "after_cleaning_hours" || val === "after_checklist_complete";
          wrap.querySelector(".laundry-timing-hours")?.classList.toggle("d-none", !isHours);
          wrap.querySelector(".laundry-timing-hours-suffix")?.classList.toggle("d-none", !isHours);
          wrap.querySelector(".laundry-timing-days")?.classList.toggle("d-none", !isDays);
          wrap.querySelector(".laundry-timing-days-suffix")?.classList.toggle("d-none", !isDays);
          wrap.querySelector(".laundry-timing-time")?.classList.toggle("d-none", !isTime);
          wrap.querySelector(".laundry-timing-time-suffix")?.classList.toggle("d-none", !isTime);
        }
      }

      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") {
        if (typeof opt.onChange === "function") opt.onChange();
      }
    });
  }

  // ========== ユーティリティ ==========
  function escapeText(s) {
    // textarea / preview に入れるテキスト用 (HTMLとしては解釈されないが、属性切れ等の事故を避ける)
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function cssEsc(s) {
    // querySelector でリテラル文字列を扱うときの記号エスケープ
    return String(s).replace(/(["\\\]\[:.])/g, "\\$1");
  }

  function stripPrefix(dk, idPrefix) {
    if (!idPrefix) return dk;
    const sep = `${idPrefix}::`;
    return dk.startsWith(sep) ? dk.slice(sep.length) : dk;
  }

  // ========== 公開 ==========
  global.NotifyChannelEditor = {
    NOTIFICATIONS,
    SYSTEM_VARIABLES,
    findNotification,
    groupNotifications,
    renderNotificationCard,
    renderTimingRow,
    updatePreview,
    readChannelValue,
    bindCardEvents,
    dataKey,
    stripPrefix,
  };
})(window);
