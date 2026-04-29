/**
 * 予約フロー構成画面 (v2 再実装 2026-04-20)
 *
 * 3レーンスイムレーン (ゲスト / Webアプリ管理者 / スタッフ) + 全30ステップ + 全22通知統合
 *
 * データ格納先:
 *   - propertyField 系  : properties/{pid}.*
 *   - globalChannel 系  : settings/notifications.channels.{key}.*
 *   - それ以外          : properties/{pid}.reservationFlow.{key}.{enabled,memo}
 *
 * ルート: #/reservation-flow
 */

// TODO: notifications.js から通知編集UIを抽出・共通化 (Option A)
//       現在は reservation-flow.js 内に直接実装 (Option B)

const ReservationFlowPage = {
  properties: [],
  selectedPropertyIds: [],
  notifChannels: {}, // settings/notifications.channels スナップショット

  // ========== 変数グループ定義 (notifications.js の systemVariables と同内容) ==========
  systemVariables: {
    recruit: [
      { name: "date",     label: "作業日",        sample: "2026/04/20" },
      { name: "property", label: "物件名",        sample: "長浜民泊A" },
      { name: "work",     label: "作業内容",      sample: "清掃" },
      { name: "url",      label: "回答ページURL", sample: "https://minpaku-v2.web.app/#/my-recruitment" },
      { name: "count",    label: "回答数",        sample: "3" },
      { name: "staff",    label: "確定スタッフ名", sample: "山田太郎" },
      { name: "memo",     label: "メモ",          sample: "BBQ後の片付けあり" },
      { name: "response", label: "回答内容",      sample: "◎" },
    ],
    booking: [
      { name: "date",     label: "チェックアウト日", sample: "2026/04/20" },
      { name: "checkin",  label: "チェックイン日",   sample: "2026/04/18" },
      { name: "property", label: "物件名",          sample: "長浜民泊A" },
      { name: "guest",    label: "ゲスト名",        sample: "John Smith" },
      { name: "nights",   label: "宿泊数",          sample: "2" },
      { name: "site",     label: "予約サイト",       sample: "Airbnb" },
      { name: "url",      label: "名簿ページURL",   sample: "https://minpaku-v2.web.app/#/guests" },
    ],
    staff: [
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎" },
      { name: "date",     label: "対象日",      sample: "2026/04/20" },
      { name: "property", label: "物件名",      sample: "長浜民泊A" },
      { name: "url",      label: "マイページURL", sample: "https://minpaku-v2.web.app/#/my-dashboard" },
      { name: "reason",   label: "理由",        sample: "直近15回の募集に無回答" },
    ],
    invoice: [
      { name: "month",    label: "対象月",      sample: "4" },
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎" },
      { name: "property", label: "物件名",      sample: "長浜民泊A" },
      { name: "total",    label: "合計金額",    sample: "¥45,000" },
      { name: "url",      label: "確認/作成ページURL", sample: "https://minpaku-v2.web.app/#/my-invoice-create" },
    ],
    cleaning: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20" },
      { name: "property", label: "物件名",          sample: "長浜民泊A" },
      { name: "staff",    label: "スタッフ名",       sample: "山田太郎" },
      { name: "time",     label: "完了時刻",        sample: "14:30" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx" },
    ],
    laundry: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20" },
      { name: "property", label: "物件名",          sample: "長浜民泊A" },
      { name: "staff",    label: "担当スタッフ",     sample: "山田太郎" },
      { name: "time",     label: "実施時刻",         sample: "19:30" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx" },
    ],
    guestUpdate: [
      { name: "guestName",     label: "ゲスト名",        sample: "John Smith" },
      { name: "propertyName",  label: "物件名",          sample: "長浜民泊A" },
      { name: "checkin",       label: "チェックイン日",   sample: "2026/04/20" },
      { name: "changes",       label: "変更内容",        sample: "代表者の年齢: 30 → 35" },
      { name: "confirmUrl",    label: "確認URL",         sample: "https://minpaku-v2.web.app/#/guests?id=xxx" },
    ],
  },

  // ========== 通知デフォルト値 (notifications.js の notifications 配列から参照) ==========
  _notifDefaults: {
    recruit_start:      { defaultMsg: "🧹 {work}スタッフ募集\n\n{date} {property}\n{work}スタッフを募集しています。\n回答をお願いします（◎OK / △微妙 / ×NG）\n\n回答: {url}", defaultTiming: "immediate", varGroup: "recruit" },
    double_booking:     { defaultMsg: "【⚠️ ダブルブッキング警告】\n物件: {property}\n日程: {checkin} 〜 {date}\n\n衝突予約が検出されました。至急確認してください。\n確認: {url}", defaultTiming: "immediate", varGroup: "booking" },
    roster_received:    { defaultMsg: "📨 宿泊者名簿が届きました\n\n{checkin} {property}\nゲスト: {guest}\n詳細: {url}", defaultTiming: "immediate", varGroup: "booking" },
    form_complete_mail_failed: { defaultMsg: "⚠️ 完了メール送信失敗\n\n物件: {property}\nゲスト: {guest} ({email})\nエラー: {error}\n\n手動で連絡してください。", defaultTiming: "immediate", varGroup: "booking" },
    roster_updated:    { defaultMsg: "🔄 宿泊者名簿が更新されました\n\n{checkin} {property}\nゲスト: {guest}\n\n変更内容:\n{changes}\n\n確認: {url}", defaultTiming: "immediate", varGroup: "guestUpdate" },
    roster_remind:      { defaultMsg: "📝 名簿入力のお願い\n\n{checkin} {property}\nゲスト: {guest}\n宿泊者名簿がまだ届いていません。", defaultTiming: "morning", varGroup: "booking" },
    urgent_remind:      { defaultMsg: "🔴 緊急: 直前予約の{work}手配\n\n{date} {property}\n直前予約が入りました。至急スタッフの手配をお願いします。", defaultTiming: "immediate", varGroup: "recruit" },
    recruit_response:   { defaultMsg: "📋 募集に回答がありました\n\n日付: {date} ({property})\n{staff}: {response}\n候補: {count}名", defaultTiming: "immediate", varGroup: "recruit" },
    recruit_remind:     { defaultMsg: "📋 {work}募集 回答のお願い\n\n{date} {property}\nまだ回答が届いていません（現在{count}件）。\n回答: {url}", defaultTiming: "evening", varGroup: "recruit" },
    staff_undecided:    { defaultMsg: "⚠️ {work}スタッフ未確定\n\n{date} {property}\n作業日が近づいていますが、まだスタッフが確定していません。\n回答状況: {count}件", defaultTiming: "morning", varGroup: "recruit" },
    staff_confirm:      { defaultMsg: "✅ {work}担当が確定しました\n\n{date} {property}\n担当: {staff}\nよろしくお願いします。", defaultTiming: "immediate", varGroup: "recruit" },
    laundry_put_out:    { defaultMsg: "🧺 ランドリー 出した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を出しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "laundry" },
    laundry_collected:  { defaultMsg: "🧺 ランドリー 回収した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を回収しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "laundry" },
    laundry_stored:     { defaultMsg: "🧺 ランドリー 収納した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を収納しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "laundry" },
    cleaning_done:      { defaultMsg: "✨ 清掃完了\n\n{date} {property}\n{staff}さんが{time}に清掃を完了しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "cleaning" },
    checklist_complete: { defaultMsg: "☑️ チェックリスト完了\n\n{date} {property}\n{staff}さんがチェックリストを完了しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "cleaning" },
    invoice_request:    { defaultMsg: "💰 {month}月分の請求書作成をお願いします\n\n作業明細をご確認の上、請求書の送信をお願いします。\n作成ページ: {url}", defaultTiming: "morning", varGroup: "invoice" },
    invoice_submitted:  { defaultMsg: "📨 請求書が提出されました\n\n{staff} さんから {month}月分の請求書が届きました。\n合計: {total}\n確認: {url}", defaultTiming: "immediate", varGroup: "invoice" },
    booking_cancel:     { defaultMsg: "❌ 予約キャンセル\n\n{checkin}〜{date} {property}\nゲスト: {guest}（{site}）\n予約がキャンセルされました。", defaultTiming: "immediate", varGroup: "booking" },
    booking_change:     { defaultMsg: "🔄 予約変更\n\n{property}\n新しい日程: {checkin}〜{date}（{nights}泊）\nゲスト: {guest}", defaultTiming: "immediate", varGroup: "booking" },
    cancel_request:     { defaultMsg: "🙋 出勤キャンセル要望\n\n{staff}さんから{date} {property}の出勤キャンセル要望がありました。", defaultTiming: "immediate", varGroup: "staff" },
    cancel_approve:     { defaultMsg: "✅ キャンセル承認\n\n{date} {property}の出勤キャンセルが承認されました。", defaultTiming: "immediate", varGroup: "staff" },
    cancel_reject:      { defaultMsg: "❌ キャンセル不可\n\n{date} {property}の出勤キャンセルは対応できませんでした。出勤をお願いします。", defaultTiming: "immediate", varGroup: "staff" },
    staff_inactive:     { defaultMsg: "⚠️ スタッフ非アクティブ化\n\n{staff} さんを非アクティブに変更しました。\n理由: {reason}\n解除はスタッフ管理から行えます。", defaultTiming: "immediate", varGroup: "staff" },
    roster_mismatch:    { defaultMsg: "⚠️ 名簿照合エラー\n\nゲスト: {guest}\nCI: {checkin}\n詳細: {error}\n\n名簿確認: {url}", defaultTiming: "immediate", varGroup: "booking" },
    laundry_reminder:   { defaultMsg: "🧺 ランドリーを使用した場合は記録をお願いします\n\n{date} {property}\n入力: {url}", defaultTiming: "immediate", varGroup: "cleaning" },
    error_alert:        { defaultMsg: "🚨 システムエラー\n\n{error}\n\n管理画面: {url}", defaultTiming: "immediate", varGroup: "system" },
    // scan_pending: タスク5で削除 (民泊v2に不要)
    keybox_send:        { defaultMsg: "", defaultTiming: "scheduled", varGroup: "booking" },
    keybox_remind:      { defaultMsg: "⚠️ キーボックス情報未送信\n\nゲスト: {guest}\nCI: {checkin}\nOKボタンが未押下のため送信がスケジュールされていません。\n確認: {url}", defaultTiming: "immediate", varGroup: "booking" },
  },

  // ========== STEPS 定義 (30項目) ==========
  STEPS: [
    // ---- Phase 1: 予約受付 ----
    {
      key: "ical_sync",
      label: "予約受付 (iCal同期)",
      icon: "bi-calendar-check",
      lane: "owner",
      phase: 1,
      linkHash: "#/properties",
      linkLabel: "物件編集→iCal設定",
      icalPanel: true,  // カード展開時に iCal URL 管理パネルを表示
    },
    {
      key: "double_booking",
      label: "ダブルブッキング検知",
      icon: "bi-exclamation-triangle-fill",
      lane: "owner",
      phase: 1,
      globalChannel: "double_booking",
      varGroup: "booking",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "booking_confirm_mail",
      label: "予約確認メール送信 (宿泊者宛)",
      icon: "bi-envelope",
      lane: "owner",
      phase: 1,
      status: "未実装",
      arrowTo: "guest",
      hint: "注意事項ページURLを本文に記載し、同意後に宿泊者名簿フォームへ誘導",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
      // 詳細設定 (物件別保存: properties/{pid}.bookingConfirmMail.*)
      detailFields: [
        { field: "bookingConfirmMail.enabled", label: "メール送信", type: "switch", default: false },
        { field: "bookingConfirmMail.subject", label: "メール件名", type: "text",
          placeholder: "例: ご予約ありがとうございます（{{propertyName}}）", default: "" },
        { field: "bookingConfirmMail.body",    label: "メール本文", type: "textarea", rows: 6,
          placeholder: "例:\n{{guestName}} 様\n\nこの度はご予約ありがとうございます。\n{{propertyName}}（{{checkIn}} 〜 {{checkOut}}）にてお待ちしております。\n宿泊者名簿ご入力: {{formUrl}}",
          default: "" },
      ],
      detailVarsHint: [
        "{{guestName}}", "{{propertyName}}", "{{checkIn}}", "{{checkOut}}",
        "{{guestCount}}", "{{formUrl}}",
      ],
      detailNote: "実際のメール送信は Gmail API 連携が必要です (実装中)",
    },
    {
      key: "recruit_start",
      label: "スタッフ募集開始",
      icon: "bi-megaphone",
      lane: "owner",
      phase: 1,
      globalChannel: "recruit_start",
      varGroup: "recruit",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- Phase 2: ゲストトラック ----
    {
      key: "noise_rules",
      label: "[ゲスト] 宴会・騒音規約 (黄色カード)",
      icon: "bi-exclamation-triangle",
      lane: "guest",
      phase: 2,
      track: "guest",
      propertyField: "showNoiseAgreement",
      guestUrlFn: (pid) => `/form/?propertyId=${encodeURIComponent(pid)}`,
      linkHash: "#/guests",
      linkLabel: "宿泊者名簿→設定",
    },
    {
      key: "mini_game",
      label: "[ゲスト] ミニゲーム操作",
      icon: "bi-controller",
      lane: "guest",
      phase: 2,
      track: "guest",
      propertyField: "miniGameEnabled",
      guestUrlFn: (pid) => `/form/?propertyId=${encodeURIComponent(pid)}`,
      linkHash: "#/guests",
      linkLabel: "宿泊者名簿→設定",
    },
    {
      key: "form_input",
      label: "[ゲスト] 宿泊者名簿入力",
      icon: "bi-pencil-square",
      lane: "guest",
      phase: 2,
      track: "guest",
      propertyField: "customFormEnabled",
      guestUrlFn: (pid) => `/form/?propertyId=${encodeURIComponent(pid)}`,
      arrowTo: "owner",
      linkHash: "#/guests",
      linkLabel: "宿泊者名簿→設定",
    },
    {
      key: "guide_page",
      label: "[ゲスト] ゲスト案内ページ",
      icon: "bi-book",
      lane: "guest",
      phase: 2,
      track: "guest",
      propertyField: "guideShowOnSuccess",
      defaultEnabled: true,
      hint: "宿泊者名簿の送信完了画面で「ゲストガイドを見る」ボタンを表示するか（オフ＝いざなわない）。URL設定は「宿泊者名簿→設定」内の①-Bと同期します。",
      linkHash: "#/guest-guides",
      linkLabel: "ゲスト案内タブを開く",
      // ゲスト案内URLの表示・開くボタン用フラグ（_renderDetailFields 内で特別レンダリング）
      _renderGuideUrlInfo: true,
    },
    {
      key: "roster_received",
      label: "宿泊者名簿 受信通知",
      icon: "bi-envelope-check",
      lane: "owner",
      phase: 2,
      track: "guest",
      globalChannel: "roster_received",
      varGroup: "booking",
      arrowFrom: "guest",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    // タスク7: roster_mismatch を roster_received 直後に移動 (Phase2 owner レーン)
    {
      key: "roster_mismatch",
      label: "名簿照合エラー通知",
      icon: "bi-exclamation-diamond",
      lane: "owner",
      phase: 2,
      track: "guest",
      globalChannel: "roster_mismatch",
      varGroup: "booking",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
      hint: "名簿の内容が予約データと一致しない場合（予約なし・人数不一致・CO日不一致）に発火",
    },
    // 名簿更新通知 (宿泊者が修正リンクから再送信した場合)
    {
      key: "roster_updated",
      label: "名簿更新通知 (修正受信)",
      icon: "bi-arrow-repeat",
      lane: "owner",
      phase: 2,
      track: "guest",
      globalChannel: "roster_updated",
      varGroup: "guestUpdate",
      arrowFrom: "guest",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
      hint: "宿泊者が修正リンクから名簿を再送信した時にWebアプリ管理者へ通知",
    },
    {
      key: "form_complete_mail",
      label: "名簿入力サンクスメール (宿泊者宛)",
      icon: "bi-envelope-check",
      lane: "owner",
      phase: 2,
      track: "guest",
      arrowTo: "guest",
      // ヘッダー右のトグルでメール送信ON/OFF (物件別: formCompleteMail.enabled)
      propertyField: "formCompleteMail.enabled",
      defaultEnabled: true,
      // 左:editFields / 右:プレビュー の2カラムレイアウト
      detailTwoCol: true,
      // 詳細設定 (物件別保存: properties/{pid}.formCompleteMail.*)
      // デフォルト値を初期表示に入力済みにし、空保存でデフォルトに戻る仕様
      detailFields: [
        { field: "formCompleteMail.subject", label: "メール件名", type: "text",
          placeholder: "例: 宿泊者情報のご登録ありがとうございました",
          default: "【{{propertyName}}】宿泊者名簿をご登録いただきありがとうございました／{{guestName}} 様" },
        { field: "formCompleteMail.body",    label: "メール本文", type: "textarea", rows: 10,
          placeholder: "空欄にするとデフォルト本文に戻ります",
          default: "{{guestName}} 様\n\nいつもお世話になっております。{{propertyName}} です。\n\nこの度はご予約いただき、誠にありがとうございます。\n宿泊者名簿のご登録を承りました。\n\n■ ご宿泊情報\nチェックイン: {{checkInFormatted}}\nチェックアウト: {{checkOutFormatted}}\nご人数: {{guestCount}} 名\n住所: {{propertyAddress}}\n地図: {{addressMapUrl}}\n\nご記入内容に修正が必要な場合は、下記リンクよりお手続きください。\n{{editUrl}}\n\nチェックイン前日〜当日にかけて、キーボックス番号や施設のご案内に関するメールを別途お送りいたします。\n楽しいご滞在となりますよう、心よりお待ちしております。\n\nご質問等ございましたら、本メールにご返信ください。\n何卒よろしくお願い申し上げます。" },
      ],
      detailVarsHint: [
        "{{guestName}}", "{{propertyName}}", "{{checkIn}}", "{{checkOut}}",
        "{{checkInFormatted}}", "{{checkOutFormatted}}",
        "{{guestCount}}", "{{propertyAddress}}", "{{addressMapUrl}}", "{{editUrl}}", "{{guideUrl}}",
      ],
      detailNoteHtml: `
        <!-- 本文プレビュー（物件実データで展開） -->
        <div class="small fw-semibold mb-1"><i class="bi bi-eye"></i> 本文プレビュー（物件実データで展開）</div>
        <div id="form_complete_mail_preview" class="border rounded p-2 bg-light"
          style="white-space:pre-wrap;min-height:200px;font-size:0.78rem;font-family:monospace;"></div>
        <!-- 送信先・送信元 Gmail 表示エリア（詳細設定の下に配置） -->
        <div class="mt-3 border rounded p-2" style="background:#f0f4ff;">
          <div class="small fw-semibold mb-2"><i class="bi bi-send"></i> 送信先 / 送信元</div>
          <div id="flowGmailSenderInfo" class="small"></div>
          <div class="d-flex flex-wrap gap-2 align-items-center mt-2">
            <span class="small"><i class="bi bi-info-circle text-warning"></i> 送信には <strong>Gmail API 連携</strong>が必要です。送信失敗時は「サンクスメール送信失敗」通知が飛びます。</span>
          </div>
          <details class="small mt-1">
            <summary class="text-primary" style="cursor:pointer;"><i class="bi bi-question-circle"></i> Gmail 連携の設定方法</summary>
            <ol class="mt-2 mb-0 ps-3">
              <li>サイドバー「<a href="#/properties">物件管理</a>」を開く</li>
              <li>該当物件の編集モーダルを開き「Gmail 連携」セクションで連携ボタンを押す</li>
              <li>Google の認可画面で当該アカウントにログイン → 権限を許可</li>
              <li>連携が解除されている場合は「サンクスメール送信失敗」通知が飛びます</li>
            </ol>
          </details>
        </div>
      `,
    },
    // 名簿修正完了サンクスメール (宿泊者宛)
    {
      key: "form_update_mail",
      label: "名簿修正完了メール (宿泊者宛)",
      icon: "bi-envelope-arrow-up",
      lane: "owner",
      phase: 2,
      track: "guest",
      arrowTo: "guest",
      propertyField: "formUpdateMail.enabled",
      defaultEnabled: true,
      detailTwoCol: true,
      detailFields: [
        { field: "formUpdateMail.subject", label: "メール件名", type: "text",
          placeholder: "例: 宿泊者名簿の修正を受け付けました",
          default: "【{{propertyName}}】宿泊者名簿の修正を受け付けました／{{guestName}} 様" },
        { field: "formUpdateMail.body",    label: "メール本文", type: "textarea", rows: 10,
          placeholder: "空欄にするとデフォルト本文に戻ります",
          default: "{{guestName}} 様\n\nいつもお世話になっております。{{propertyName}} です。\n\n宿泊者名簿のご修正、誠にありがとうございます。\nご登録内容を承りました。\n\n■ ご宿泊情報\nチェックイン: {{checkInFormatted}}\nチェックアウト: {{checkOutFormatted}}\nご人数: {{guestCount}} 名\n住所: {{propertyAddress}}\n地図: {{addressMapUrl}}\n\n■ 変更内容\n{{changes}}\n\n再度ご修正の必要がございましたら、下記リンクよりお手続きください。\n{{editUrl}}\n\nご質問等ございましたら、本メールにご返信ください。\n何卒よろしくお願い申し上げます。" },
      ],
      detailVarsHint: [
        "{{guestName}}", "{{propertyName}}", "{{checkIn}}", "{{checkOut}}",
        "{{checkInFormatted}}", "{{checkOutFormatted}}",
        "{{guestCount}}", "{{propertyAddress}}", "{{addressMapUrl}}", "{{editUrl}}", "{{changes}}", "{{guideUrl}}",
      ],
      detailNoteHtml: `
        <div class="small fw-semibold mb-1"><i class="bi bi-eye"></i> 本文プレビュー（物件実データで展開）</div>
        <div id="form_update_mail_preview" class="border rounded p-2 bg-light"
          style="white-space:pre-wrap;min-height:200px;font-size:0.78rem;font-family:monospace;"></div>
        <!-- 送信先・送信元 Gmail 表示エリア（詳細設定の下に配置） -->
        <div class="mt-3 border rounded p-2" style="background:#f0f4ff;">
          <div class="small fw-semibold mb-2"><i class="bi bi-send"></i> 送信先 / 送信元</div>
          <div id="flowUpdateGmailSenderInfo" class="small"></div>
          <div class="d-flex flex-wrap gap-2 align-items-center mt-2">
            <span class="small"><i class="bi bi-info-circle text-warning"></i> 送信には <strong>Gmail API 連携</strong>が必要です。</span>
          </div>
        </div>
      `,
    },
    {
      key: "form_complete_mail_failed",
      label: "サンクスメール送信失敗 通知",
      icon: "bi-envelope-exclamation",
      lane: "owner",
      phase: 2,
      track: "guest",
      globalChannel: "form_complete_mail_failed",
      varGroup: "booking",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "roster_remind",
      label: "名簿未入力催促リマインド",
      icon: "bi-person-vcard",
      lane: "owner",
      phase: 2,
      track: "guest",
      globalChannel: "roster_remind",
      varGroup: "booking",
      arrowTo: "guest",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "urgent_remind",
      label: "直前予約リマインド",
      icon: "bi-lightning",
      lane: "owner",
      phase: 2,
      track: "guest",
      globalChannel: "urgent_remind",
      varGroup: "recruit",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "keybox_send",
      label: "キーボックス情報送信 + 施設案内",
      icon: "bi-key",
      lane: "owner",
      phase: 2,
      track: "guest",
      arrowTo: "guest",
      guestUrlFn: (pid) => `/guide/?propertyId=${encodeURIComponent(pid)}`,
      linkHash: "#/properties",
      linkLabel: "物件設定",
      propertyField: "keyboxSend.enabled",
      // タスク1: 「自動送信」スイッチ廃止 (カード右上 ON/OFF トグルで完結)
      // タスク2: 送信先・送信元をdetailNoteHtmlで表示 (_renderGmailSenderInfo 流用)
      // タスク8: Wi-Fi分割 / ポスト情報 / guideUrl / addressMapUrl 追加
      detailFields: [
        // 送信タイミング
        { field: "keyboxSend.mode",         label: "送信タイミング", type: "select",
          options: [
            { value: "after_ok_click",  label: "OKボタンを押したタイミングでスケジュール開始" },
            { value: "scheduled_date",  label: "指定した日時に自動送信" },
          ],
          default: "after_ok_click",
          hint: "「OKボタン」モード: 名簿受信メールのリンクをクリックするとスケジュールが有効化されます" },
        // タスク3: scheduleType 変更時 customDaysBefore を disabled にする (renderDetailFields 拡張で対応)
        { field: "keyboxSend.scheduleType", label: "送信日", type: "select",
          options: [
            { value: "day_of",        label: "チェックイン当日" },
            { value: "day_before",    label: "前日" },
            { value: "2_days_before", label: "2日前" },
            { value: "custom",        label: "カスタム (N日前)" },
          ],
          default: "day_before" },
        { field: "keyboxSend.customDaysBefore", label: "何日前に送信", type: "number",
          placeholder: "例: 3", default: 3, min: 0,
          hint: "送信日が「カスタム」の場合のみ有効。0 = チェックイン当日",
          // scheduleType が custom でないときに disabled (renderDetailFields でハンドリング)
          conditionalDisable: { field: "keyboxSend.scheduleType", notValue: "custom" } },
        { field: "keyboxSend.sendTime",     label: "送信時刻 (HH:MM)", type: "text",
          placeholder: "例: 15:00", default: "15:00" },
        // メールテンプレ
        { field: "keyboxSend.subject",      label: "メール件名", type: "text",
          placeholder: "例: 【{{propertyName}}】チェックイン情報のご案内",
          default: "【{{propertyName}}】チェックイン情報のご案内" },
        { field: "keyboxSend.body",         label: "メール本文", type: "textarea", rows: 14,
          placeholder: "{{guestName}} 様\n\nご予約ありがとうございます。{{propertyName}} のキーボックス情報をお送りします。\n\n■ チェックイン情報\n日時: {{checkIn}}\nご案内ページ: {{guideUrl}}\n\n■ キーボックス\n暗証番号: {{keyboxCode}}\n場所: {{keyboxLocation}}\n\n■ 施設のご案内\n住所: {{propertyAddress}}\n地図: {{addressMapUrl}}\nWi-Fi SSID: {{wifiSSID}}\nWi-Fi パスワード: {{wifiPassword}}\n\nご不明な点がございましたら、本メールにご返信ください。\nどうぞよろしくお願いいたします。",
          default: "{{guestName}} 様\n\nご予約ありがとうございます。{{propertyName}} のキーボックス情報をお送りします。\n\n■ チェックイン情報\n日時: {{checkIn}}\nご案内ページ: {{guideUrl}}\n\n■ キーボックス\n暗証番号: {{keyboxCode}}\n場所: {{keyboxLocation}}\n\n■ 施設のご案内\n住所: {{propertyAddress}}\n地図: {{addressMapUrl}}\nWi-Fi SSID: {{wifiSSID}}\nWi-Fi パスワード: {{wifiPassword}}\n\nご不明な点がございましたら、本メールにご返信ください。\nどうぞよろしくお願いいたします。" },
        // 物件固有情報
        { field: "keyboxCode",              label: "キーボックス暗証番号", type: "text",
          placeholder: "例: 1234", default: "" },
        { field: "keyboxLocation",          label: "キーボックス場所", type: "text",
          placeholder: "例: 玄関ドア横の金属ボックス内", default: "" },
        // タスク8-2: Wi-Fi を SSID / パスワードに分割 (旧 wifiInfo は後方互換で読む)
        { field: "wifiSSID",                label: "Wi-Fi SSID", type: "text",
          placeholder: "例: MyWifi", default: "" },
        { field: "wifiPassword",            label: "Wi-Fi パスワード", type: "text",
          placeholder: "例: xxxx1234", default: "" },
        // タスク8-3: ポスト情報
        { field: "post.enabled",            label: "ポスト情報を含める", type: "checkbox", default: false },
        { field: "post.code",               label: "ポスト暗証番号", type: "text",
          placeholder: "例: 5678", default: "",
          conditionalDisable: { field: "post.enabled", notValue: true } },
      ],
      detailVarsHint: [
        "{{guestName}}", "{{propertyName}}", "{{keyboxCode}}", "{{keyboxLocation}}",
        "{{checkIn}}", "{{guideUrl}}", "{{propertyAddress}}", "{{addressMapUrl}}",
        "{{wifiSSID}}", "{{wifiPassword}}", "{{postCode}}",
      ],
      detailNoteHtml: `
        <!-- 送信先・送信元表示エリア -->
        <div id="flowKeyboxSenderInfo" class="mb-2 small"></div>
        <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
          <span class="small"><i class="bi bi-info-circle text-warning"></i> 送信には <strong>Gmail API 連携</strong>が必要です。名簿入力完了メールと同じ送信元 Gmail を使用します。</span>
        </div>
        <div class="small text-muted mb-1" style="font-size:0.72rem;"><i class="bi bi-info-circle"></i> カード右上 ON/OFF = この物件のキーボックスメール自動送信を有効/無効にします。</div>
        <!-- メール本文プレビュー -->
        <div class="mt-2">
          <div class="small fw-semibold mb-1"><i class="bi bi-eye"></i> 本文プレビュー（サンプル値で展開）</div>
          <div class="row g-2 small" style="font-size:0.8rem;">
            <div class="col-12">
              <div id="keyboxSendPreview" class="border rounded p-2 bg-light"
                style="white-space:pre-wrap;min-height:100px;font-size:0.78rem;font-family:monospace;"></div>
            </div>
          </div>
          <div class="small text-muted mt-1" style="font-size:0.7rem;">
            <i class="bi bi-info-circle"></i> ポスト情報ON/OFFにより <code>{{#if postEnabled}}...{{/if}}</code> の表示が切り替わります
          </div>
        </div>
      `,
    },
    {
      key: "keybox_remind",
      label: "キーボックス送信リマインド (OKボタン未押下)",
      icon: "bi-key-fill",
      lane: "owner",
      phase: 2,
      track: "guest",
      globalChannel: "keybox_remind",
      varGroup: "booking",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
      hint: "条件: 名簿入力済 + 受信通知済 + OKボタン未押下のとき自動通知",
      // 「キーボックス送信予定時刻」基準の相対タイミング設定
      keyboxRemindTiming: true,
    },
    {
      key: "checkin_app",
      label: "チェックインApp連携",
      icon: "bi-door-open-fill",
      lane: "guest",
      phase: 2,
      track: "guest",
      status: "未実装",
      hint: "チェックインappは別で開発済み。連携部分は未実装",
      // 詳細設定 (物件別保存: properties/{pid}.checkinApp.*)
      detailFields: [
        { field: "checkinApp.enabled",      label: "アプリ連携", type: "switch", default: false },
        { field: "checkinApp.url",          label: "連携先URL",  type: "text",
          placeholder: "https://xxx.app/checkin?propertyId=xxx", default: "" },
        { field: "checkinApp.guideMessage", label: "案内メッセージ", type: "textarea", rows: 3,
          placeholder: "チェックインアプリで本人確認をお願いします: {{checkinAppUrl}}",
          default: "" },
      ],
      detailNote: "ここの設定はプレースホルダーです。実際のアプリ連携は今後実装",
    },

    // ---- Phase 2: スタッフトラック ----
    {
      key: "recruit_response",
      label: "スタッフ回答通知",
      icon: "bi-reply",
      lane: "staff",
      phase: 2,
      track: "staff",
      globalChannel: "recruit_response",
      varGroup: "recruit",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "recruit_remind",
      label: "募集リマインド",
      icon: "bi-alarm",
      lane: "owner",
      phase: 2,
      track: "staff",
      globalChannel: "recruit_remind",
      varGroup: "recruit",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "staff_undecided",
      label: "スタッフ未決定リマインド",
      icon: "bi-exclamation-triangle",
      lane: "owner",
      phase: 2,
      track: "staff",
      globalChannel: "staff_undecided",
      varGroup: "recruit",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "staff_confirm",
      label: "スタッフ確定通知",
      icon: "bi-person-check",
      lane: "owner",
      phase: 2,
      track: "staff",
      globalChannel: "staff_confirm",
      varGroup: "recruit",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- 分岐A: 予約キャンセル/変更 ----
    {
      key: "booking_cancel",
      label: "予約キャンセル通知",
      icon: "bi-x-circle",
      lane: "owner",
      branch: "cancel",
      globalChannel: "booking_cancel",
      varGroup: "booking",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "booking_change",
      label: "予約変更通知",
      icon: "bi-arrow-repeat",
      lane: "owner",
      branch: "cancel",
      globalChannel: "booking_change",
      varGroup: "booking",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- 分岐B: スタッフ出勤キャンセル (バックエンド未実装) ----
    {
      key: "cancel_request",
      label: "出勤キャンセル要望",
      icon: "bi-person-dash",
      lane: "staff",
      branch: "staff_cancel",
      unimplemented: true,
      globalChannel: "cancel_request",
      varGroup: "staff",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "cancel_approve",
      label: "キャンセル承認通知",
      icon: "bi-check-circle",
      lane: "owner",
      branch: "staff_cancel",
      unimplemented: true,
      globalChannel: "cancel_approve",
      varGroup: "staff",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "cancel_reject",
      label: "キャンセル却下通知",
      icon: "bi-dash-circle",
      lane: "owner",
      branch: "staff_cancel",
      unimplemented: true,
      globalChannel: "cancel_reject",
      varGroup: "staff",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- 分岐C: 監視 ----
    {
      key: "staff_inactive",
      label: "スタッフ非アクティブ化通知",
      icon: "bi-person-slash",
      lane: "owner",
      branch: "monitor",
      globalChannel: "staff_inactive",
      varGroup: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // タスク5: scan_pending は民泊v2に不要なため削除
    // タスク7: roster_mismatch は roster_received の直後 (Phase2 ゲストトラック) へ移動済み
    {
      key: "laundry_reminder",
      label: "ランドリー入力リマインド (スタッフ宛)",
      icon: "bi-basket",
      lane: "staff",
      branch: "monitor",
      globalChannel: "laundry_reminder",
      varGroup: "cleaning",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
      // タスク6: ランドリーリマインドのタイミング基準を清掃日に変更
      hint: "清掃完了後にスタッフへランドリー記録の入力を促す通知（タイミング基準: 清掃日）",
    },
    {
      key: "error_alert",
      label: "システムエラーアラート",
      icon: "bi-bug",
      lane: "owner",
      branch: "monitor",
      globalChannel: "error_alert",
      varGroup: "system",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
      hint: "Cloud Functions で予期しないエラーが発生した場合に通知",
    },
  ],

  // ========== ユーティリティ ==========
  _esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s || "");
    return d.innerHTML;
  },

  // form_complete_mail カード内の「送信先」「送信元」欄を非同期で更新する (タスク1/3)
  async _renderGmailSenderInfo(bodyEl, pid) {
    const infoEl = bodyEl.querySelector("#flowGmailSenderInfo");
    if (!infoEl) return;

    infoEl.innerHTML = `<div class="text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>読込中...</div>`;

    // 物件データと Gmail 連携状態を並行取得
    let senderGmail = "";
    let accounts = [];
    try {
      const [propDoc, accountRes] = await Promise.all([
        db.collection("properties").doc(pid).get(),
        (async () => {
          const token = await firebase.auth().currentUser.getIdToken();
          const res = await fetch(
            "https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/accounts?context=emailVerification",
            { headers: { Authorization: `Bearer ${token}` } }
          );
          return res.ok ? res.json() : { accounts: [] };
        })(),
      ]);
      senderGmail = (propDoc.exists && propDoc.data().senderGmail) || "";
      accounts = accountRes.accounts || [];
    } catch (e) {
      infoEl.innerHTML = `<div class="text-danger small">情報取得失敗: ${this._esc(e.message)}</div>`;
      return;
    }

    // 送信先ブロック (宿泊者本人、固定)
    const destBlock = `
      <div class="d-flex align-items-center gap-1 mb-1">
        <span class="small">📧 <strong>送信先:</strong> 宿泊者本人（フォーム入力時のメールアドレス）</span>
      </div>
      <div class="text-muted small mb-2" style="font-size:0.73rem;">
        <i class="bi bi-info-circle"></i> 他通知のような送信先選択UIがないのは仕様です（宿泊者宛の単一メールのため）
      </div>
    `;

    // 送信元ブロック: OAuth 状態に応じて3パターン
    let srcBlock = "";
    const pidEsc = this._esc(pid);
    const openProps = `sessionStorage.setItem('openPropertyEdit','${pidEsc}'); location.hash='#/properties';`;

    if (senderGmail) {
      const linked = accounts.find(a => a.email === senderGmail);
      if (linked && linked.hasRefreshToken) {
        // 連携中・有効
        srcBlock = `
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="small">📤 <strong>送信元:</strong> 🟢 ${this._esc(senderGmail)} <span class="badge bg-success-subtle text-success border" style="font-size:0.7rem;">連携中</span></span>
            <button class="btn btn-sm btn-outline-danger py-0 px-2" onclick="${openProps}">
              <i class="bi bi-x-circle"></i> 解除
            </button>
          </div>
        `;
      } else if (linked && !linked.hasRefreshToken) {
        // 連携中・トークン失効
        srcBlock = `
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="small">📤 <strong>送信元:</strong> 🔴 ${this._esc(senderGmail)} ⚠️ <span class="text-danger">トークン失効中。再連携が必要です</span></span>
            <button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="${openProps}">
              <i class="bi bi-arrow-repeat"></i> 再連携
            </button>
          </div>
        `;
      } else {
        // senderGmail あるがトークン未登録
        srcBlock = `
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="small">📤 <strong>送信元:</strong> 🔴 ${this._esc(senderGmail)} ⚠️ <span class="text-danger">トークン失効中。再連携が必要です</span></span>
            <button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="${openProps}">
              <i class="bi bi-arrow-repeat"></i> 再連携
            </button>
          </div>
        `;
      }
    } else {
      // 未連携
      srcBlock = `
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="small">📤 <strong>送信元:</strong> ⚪ <span class="text-muted">送信元 Gmail が未連携です</span></span>
          <button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="${openProps}">
            <i class="bi bi-box-arrow-up-right"></i> 物件管理で連携
          </button>
        </div>
      `;
    }

    infoEl.innerHTML = `
      <div class="border rounded p-2 mb-2" style="background:#f8fafc;">
        ${destBlock}
        ${srcBlock}
        <div class="text-muted mt-2" style="font-size:0.71rem;">
          <i class="bi bi-info-circle"></i> Gmail連携は1回で半永久的に有効です。失効した場合のみ再連携してください。
        </div>
      </div>
    `;
  },

  // タスク2: keybox_send カード内「送信先」「送信元」を表示 (_renderGmailSenderInfo と同ロジック)
  async _renderKeyboxSenderInfo(bodyEl, pid) {
    const infoEl = bodyEl.querySelector("#flowKeyboxSenderInfo");
    if (!infoEl) return;

    infoEl.innerHTML = `<div class="text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>読込中...</div>`;

    let senderGmail = "";
    let accounts = [];
    try {
      const [propDoc, accountRes] = await Promise.all([
        db.collection("properties").doc(pid).get(),
        (async () => {
          const token = await firebase.auth().currentUser.getIdToken();
          const res = await fetch(
            "https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/accounts?context=emailVerification",
            { headers: { Authorization: `Bearer ${token}` } }
          );
          return res.ok ? res.json() : { accounts: [] };
        })(),
      ]);
      senderGmail = (propDoc.exists && propDoc.data().senderGmail) || "";
      accounts = accountRes.accounts || [];
    } catch (e) {
      infoEl.innerHTML = `<div class="text-danger small">情報取得失敗: ${this._esc(e.message)}</div>`;
      return;
    }

    const destBlock = `
      <div class="d-flex align-items-center gap-1 mb-1">
        <span class="small">📧 <strong>送信先:</strong> 宿泊者本人（フォーム入力時のメールアドレス）</span>
      </div>
      <div class="text-muted small mb-2" style="font-size:0.73rem;">
        <i class="bi bi-info-circle"></i> 名簿入力完了メールと同じ送信先設定です
      </div>
    `;

    const pidEsc = this._esc(pid);
    const openProps = `sessionStorage.setItem('openPropertyEdit','${pidEsc}'); location.hash='#/properties';`;
    let srcBlock = "";

    if (senderGmail) {
      const linked = accounts.find(a => a.email === senderGmail);
      if (linked && linked.hasRefreshToken) {
        srcBlock = `
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="small">📤 <strong>送信元:</strong> 🟢 ${this._esc(senderGmail)} <span class="badge bg-success-subtle text-success border" style="font-size:0.7rem;">連携中</span></span>
            <button class="btn btn-sm btn-outline-danger py-0 px-2" onclick="${openProps}"><i class="bi bi-x-circle"></i> 解除</button>
          </div>
        `;
      } else {
        srcBlock = `
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="small">📤 <strong>送信元:</strong> 🔴 ${this._esc(senderGmail)} ⚠️ <span class="text-danger">トークン失効中。再連携が必要です</span></span>
            <button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="${openProps}"><i class="bi bi-arrow-repeat"></i> 再連携</button>
          </div>
        `;
      }
    } else {
      srcBlock = `
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="small">📤 <strong>送信元:</strong> ⚪ <span class="text-muted">送信元 Gmail が未連携です</span></span>
          <button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="${openProps}"><i class="bi bi-box-arrow-up-right"></i> 物件管理で連携</button>
        </div>
      `;
    }

    infoEl.innerHTML = `
      <div class="border rounded p-2 mb-2" style="background:#f8fafc;">
        ${destBlock}
        ${srcBlock}
        <div class="text-muted mt-2" style="font-size:0.71rem;">
          <i class="bi bi-info-circle"></i> ※ 名簿入力完了メールと同じ送信元です。
        </div>
      </div>
    `;
  },

  // keybox_remind: キーボックス送信予定時刻基準のタイミング設定UIをレンダリング
  // データ: properties.{pid}.channelOverrides.keybox_remind.reminderOffset
  _renderKeyboxRemindTiming(stepKey, property) {
    const pid = property.id;
    const offset = property.channelOverrides?.keybox_remind?.reminderOffset || {};
    const mode = offset.mode || "same";
    const hours = offset.hours ?? 2;

    const radioName = `kbr-mode-${pid}`;
    return `
      <div class="rf-detail-panel mt-2 mb-2 p-2 border rounded" style="background:#f0f8ff;" id="kbr-timing-${pid}">
        <div class="small fw-semibold mb-2"><i class="bi bi-clock"></i> 通知タイミング（送信予定時刻基準）</div>
        <div class="d-flex flex-column gap-1">
          <div class="form-check">
            <input class="form-check-input kbr-mode-radio" type="radio"
              name="${radioName}" id="kbr-same-${pid}" value="same"
              data-pid="${pid}" ${mode === "same" ? "checked" : ""}>
            <label class="form-check-label small" for="kbr-same-${pid}">送信予定時刻と同時（デフォルト）</label>
          </div>
          <div class="form-check d-flex align-items-center gap-2">
            <input class="form-check-input kbr-mode-radio" type="radio"
              name="${radioName}" id="kbr-before-${pid}" value="before_hours"
              data-pid="${pid}" ${mode === "before_hours" ? "checked" : ""}>
            <label class="form-check-label small" for="kbr-before-${pid}">送信予定時刻の</label>
            <input type="number" class="form-control form-control-sm kbr-hours-input" min="1" max="72"
              style="width:65px;font-size:0.85rem;" value="${mode === "before_hours" ? hours : 2}"
              data-pid="${pid}" data-offset-mode="before_hours"
              ${mode !== "before_hours" ? "disabled" : ""}>
            <span class="small">時間前</span>
          </div>
          <div class="form-check d-flex align-items-center gap-2">
            <input class="form-check-input kbr-mode-radio" type="radio"
              name="${radioName}" id="kbr-after-${pid}" value="after_hours"
              data-pid="${pid}" ${mode === "after_hours" ? "checked" : ""}>
            <label class="form-check-label small" for="kbr-after-${pid}">送信予定時刻の</label>
            <input type="number" class="form-control form-control-sm kbr-hours-input" min="1" max="72"
              style="width:65px;font-size:0.85rem;" value="${mode === "after_hours" ? hours : 2}"
              data-pid="${pid}" data-offset-mode="after_hours"
              ${mode !== "after_hours" ? "disabled" : ""}>
            <span class="small">時間後</span>
          </div>
        </div>
        <div class="small text-muted mt-2" style="font-size:0.72rem;">
          <i class="bi bi-info-circle"></i> 条件: 名簿入力済 + 受信通知済 + OKボタン未押下のとき発火
        </div>
      </div>
    `;
  },

  // keybox_remind タイミング変更をFirestoreに保存
  async _saveKeyboxRemindOffset(pid, bodyEl) {
    const checkedRadio = bodyEl.querySelector(`.kbr-mode-radio:checked`);
    if (!checkedRadio) return;
    const mode = checkedRadio.value;
    const hoursInput = bodyEl.querySelector(`.kbr-hours-input[data-offset-mode="${mode}"]`);
    const hours = hoursInput ? (parseInt(hoursInput.value, 10) || 2) : 2;

    const reminderOffset = mode === "same" ? { mode } : { mode, hours };
    try {
      await db.collection("properties").doc(pid).update({
        "channelOverrides.keybox_remind.reminderOffset": reminderOffset,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      const prop = this.properties.find(p => p.id === pid);
      if (prop) {
        if (!prop.channelOverrides) prop.channelOverrides = {};
        if (!prop.channelOverrides.keybox_remind) prop.channelOverrides.keybox_remind = {};
        prop.channelOverrides.keybox_remind.reminderOffset = reminderOffset;
      }
      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
    }
  },

  // タスク3: scheduleType ラジオ変更時に customDaysBefore の disabled を切り替え
  _bindScheduleTypeConditional(bodyEl, pid) {
    const schedSel = bodyEl.querySelector(
      `.rf-detail-input[data-field="keyboxSend.scheduleType"]`
    );
    const customInput = bodyEl.querySelector(
      `.rf-detail-input[data-field="keyboxSend.customDaysBefore"]`
    );
    if (!schedSel || !customInput) return;

    const update = () => {
      const isCustom = schedSel.value === "custom";
      customInput.disabled = !isCustom;
      customInput.closest(".mb-2").style.opacity = isCustom ? "" : "0.5";
    };
    update();
    schedSel.addEventListener("change", update);
  },

  // タスク8: ポスト情報チェックボックス変更時に post.code の disabled を切り替え
  _bindPostConditional(bodyEl, pid) {
    const postChk = bodyEl.querySelector(
      `.rf-detail-input[data-field="post.enabled"]`
    );
    const codeInput = bodyEl.querySelector(
      `.rf-detail-input[data-field="post.code"]`
    );
    if (!postChk || !codeInput) return;

    const update = () => {
      const enabled = postChk.checked;
      codeInput.disabled = !enabled;
      codeInput.closest(".mb-2").style.opacity = enabled ? "" : "0.5";
    };
    update();
    postChk.addEventListener("change", update);
  },

  // keybox_remind タイミングUIのラジオ/時間入力イベントをバインド
  _bindKeyboxRemindTiming(bodyEl, pid) {
    const radios = bodyEl.querySelectorAll(".kbr-mode-radio");
    const hoursInputs = bodyEl.querySelectorAll(".kbr-hours-input");

    radios.forEach(radio => {
      radio.addEventListener("change", () => {
        const selectedMode = radio.value;
        // 時間入力の disabled 制御
        hoursInputs.forEach(inp => {
          inp.disabled = (inp.dataset.offsetMode !== selectedMode);
        });
        this._saveKeyboxRemindOffset(pid, bodyEl);
      });
    });

    hoursInputs.forEach(inp => {
      inp.addEventListener("input", () => {
        const checkedRadio = bodyEl.querySelector(".kbr-mode-radio:checked");
        if (checkedRadio && checkedRadio.value === inp.dataset.offsetMode) {
          clearTimeout(this._kbrTimer);
          this._kbrTimer = setTimeout(() => this._saveKeyboxRemindOffset(pid, bodyEl), 800);
        }
      });
    });
  },

  // keybox_send プレビューUIをバインド（物件実データ優先、サンプル値フォールバック）
  async _bindKeyboxSendPreview(bodyEl, pid) {
    const bodyTextarea = bodyEl.querySelector(`.rf-detail-input[data-field="keyboxSend.body"]`);
    const previewEl = bodyEl.querySelector("#keyboxSendPreview");
    if (!bodyTextarea || !previewEl) return;

    const postEnabledChk = bodyEl.querySelector(`.rf-detail-input[data-field="post.enabled"]`);

    // 基本サンプル値（ゲスト情報等は仮値）
    let sampleVars = {
      guestName:       "山田 太郎",
      checkIn:         "2026年4月30日(木) 15:00",
      checkOut:        "2026年5月2日(土) 10:00",
      // 物件実データで上書き (以下は Firestore 取得前フォールバック)
      propertyName:    "（物件名読込中）",
      propertyAddress: "",
      addressMapUrl:   "",
      keyboxCode:      "（暗証番号未設定）",
      keyboxLocation:  "（場所未設定）",
      wifiSSID:        "（SSID未設定）",
      wifiPassword:    "（PW未設定）",
      guideUrl:        "（ゲスト案内URL未設定）",
      postCode:        "（ポスト番号未設定）",
    };

    // 物件実データ取得して上書き
    try {
      const pDoc = await db.collection("properties").doc(pid).get();
      if (pDoc.exists) {
        const p = pDoc.data();
        sampleVars.propertyName    = p.name    || "（物件名未設定）";
        sampleVars.propertyAddress = p.address || "（住所未設定）";
        sampleVars.addressMapUrl   = p.address
          ? "https://maps.google.com/?q=" + encodeURIComponent(p.address) : "";
        // フォーム内の入力値があればそちらを優先
        const kbCode = bodyEl.querySelector(`.rf-detail-input[data-field="keyboxCode"]`);
        const kbLoc  = bodyEl.querySelector(`.rf-detail-input[data-field="keyboxLocation"]`);
        const wSSID  = bodyEl.querySelector(`.rf-detail-input[data-field="wifiSSID"]`);
        const wPW    = bodyEl.querySelector(`.rf-detail-input[data-field="wifiPassword"]`);
        const postCd = bodyEl.querySelector(`.rf-detail-input[data-field="post.code"]`);
        sampleVars.keyboxCode     = (kbCode && kbCode.value) || p.keyboxCode     || "（暗証番号未設定）";
        sampleVars.keyboxLocation = (kbLoc  && kbLoc.value)  || p.keyboxLocation || "（場所未設定）";
        sampleVars.wifiSSID       = (wSSID  && wSSID.value)  || p.wifiSSID       || "（SSID未設定）";
        sampleVars.wifiPassword   = (wPW    && wPW.value)    || p.wifiPassword   || "（PW未設定）";
        sampleVars.postCode       = (postCd && postCd.value)
          || (p.post && p.post.code) || "（ポスト番号未設定）";
        const guideBase = (window.GuideMap && window.GuideMap.resolveGuideUrl({
          id: pid, guideUrl: p.guideUrl, guideUrlMode: p.guideUrlMode,
        })) || "";
        sampleVars.guideUrl = guideBase
          ? guideBase + (guideBase.includes("?") ? "&" : "?") + "guest=sample-token"
          : "（ゲスト案内URL未設定）";
      }
    } catch (_) {
      sampleVars.propertyName = "the Terrace 長浜";
    }

    const updatePreview = () => {
      let text = bodyTextarea.value || "";
      const postEnabled = postEnabledChk ? postEnabledChk.checked : false;

      // {{#if postEnabled}}...{{/if}} の展開/非表示
      text = text.replace(/\{\{#if postEnabled\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, inner) => {
        return postEnabled ? inner : "";
      });

      // 変数置換
      Object.entries(sampleVars).forEach(([k, v]) => {
        text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
      });

      previewEl.textContent = text;
    };

    bodyTextarea.addEventListener("input", updatePreview);
    if (postEnabledChk) postEnabledChk.addEventListener("change", updatePreview);
    updatePreview();
  },

  // メールテンプレートのプレビューUIをバインド（物件実データ優先、サンプル値フォールバック）
  async _bindMailPreview(bodyEl, pid, bodyField, previewId) {
    const bodyTextarea = bodyEl.querySelector(`.rf-detail-input[data-field="${bodyField}"]`);
    const previewEl = bodyEl.querySelector(`#${previewId}`);
    if (!bodyTextarea || !previewEl) return;

    // 基本サンプル値（ゲスト情報等は仮値）
    const baseVars = {
      guestName:    "山田 太郎",
      checkIn:      "2026/04/30",
      checkOut:     "2026/05/02",
      checkInFormatted:  "2026年4月30日(木) 15:00",
      checkOutFormatted: "2026年5月2日(土) 10:00",
      guestCount:   "4",
      editUrl:      "https://minpaku-v2.web.app/guest-form.html?edit=sample-token",
      changes:      "代表者の年齢: 30 → 35",
    };

    // 物件実データを取得して sampleVars を上書き
    let sampleVars = { ...baseVars };
    try {
      const pDoc = await db.collection("properties").doc(pid).get();
      if (pDoc.exists) {
        const p = pDoc.data();
        sampleVars.propertyName    = p.name    || "（物件名未設定）";
        sampleVars.propertyAddress = p.address || "（住所未設定）";
        sampleVars.addressMapUrl   = p.address
          ? "https://maps.google.com/?q=" + encodeURIComponent(p.address) : "";
        sampleVars.keyboxCode      = p.keyboxCode      || "（暗証番号未設定）";
        sampleVars.keyboxLocation  = p.keyboxLocation  || "（場所未設定）";
        sampleVars.wifiSSID        = p.wifiSSID        || "（SSID未設定）";
        sampleVars.wifiPassword    = p.wifiPassword    || "（PW未設定）";
        sampleVars.wifiInfo        = (p.wifiSSID && p.wifiPassword)
          ? `SSID: ${p.wifiSSID} / PW: ${p.wifiPassword}` : "（Wi-Fi未設定）";
        sampleVars.postCode        = (p.post && p.post.code) ? p.post.code : "（ポスト番号未設定）";
        // guideUrl: GuideMap で解決
        const guideBase = (window.GuideMap && window.GuideMap.resolveGuideUrl({
          id: pid, guideUrl: p.guideUrl, guideUrlMode: p.guideUrlMode,
        })) || "";
        sampleVars.guideUrl = guideBase
          ? guideBase + (guideBase.includes("?") ? "&" : "?") + "guest=sample-token"
          : "（ゲスト案内URL未設定）";
      }
    } catch (_) {
      sampleVars.propertyName    = "the Terrace 長浜";
      sampleVars.propertyAddress = "滋賀県長浜市○○町1-2-3";
      sampleVars.addressMapUrl   = "https://maps.google.com/?q=...";
      sampleVars.keyboxCode      = "1234";
      sampleVars.keyboxLocation  = "玄関ドア横の金属ボックス";
      sampleVars.wifiSSID        = "MyWifi";
      sampleVars.wifiPassword    = "xxxx1234";
      sampleVars.wifiInfo        = "SSID: MyWifi / PW: xxxx1234";
      sampleVars.postCode        = "5678";
      sampleVars.guideUrl        = "https://minpaku-v2.web.app/guide/?propertyId=xxx";
    }

    const updatePreview = () => {
      let text = bodyTextarea.value || "";
      Object.entries(sampleVars).forEach(([k, v]) => {
        text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
      });
      previewEl.textContent = text;
    };

    bodyTextarea.addEventListener("input", updatePreview);
    updatePreview();
  },

  // ドット記法でネストフィールドから値を取得
  _getNested(obj, path) {
    if (!obj || !path) return undefined;
    const parts = path.split(".");
    let v = obj;
    for (const p of parts) { v = v?.[p]; if (v === undefined) return undefined; }
    return v;
  },

  // ゲスト案内URL情報（URL表示＋開くボタン）
  _renderGuideUrlInfoBlock(step, property) {
    if (!step._renderGuideUrlInfo) return "";
    const propForResolve = {
      id: property.id,
      guideUrl: property.guideUrl,
      guideUrlMode: property.guideUrlMode,
    };
    const url = (window.GuideMap && window.GuideMap.resolveGuideUrl(propForResolve)) || "";
    const mode = property.guideUrlMode || "auto";
    const modeLabel = mode === "manual" ? "手動設定" : "自動同期";
    const urlDisplay = url
      ? `<code class="text-break small">${this._esc(url)}</code>`
      : `<span class="text-warning small"><i class="bi bi-exclamation-triangle"></i> 未設定（ゲスト案内タブで作成してください）</span>`;
    const openBtn = url
      ? `<a href="${this._esc(url)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-primary">
           <i class="bi bi-box-arrow-up-right me-1"></i>ページを開く
         </a>`
      : "";
    return `
      <div class="rf-detail-panel mt-2 p-2 border rounded" style="background:#f8fafc;">
        <div class="small fw-semibold mb-2">
          <i class="bi bi-link-45deg"></i> ゲスト案内URL（${this._esc(property.name)}）
          <span class="badge bg-secondary-subtle text-secondary border ms-1" style="font-size:9px;">${this._esc(modeLabel)}</span>
        </div>
        <div class="mb-2">${urlDisplay}</div>
        ${openBtn}
      </div>`;
  },

  // detailFields (ネスト対応の型別入力UI) をレンダリング
  _renderDetailFields(step, property) {
    const guideInfoHtml = this._renderGuideUrlInfoBlock(step, property);
    if (!Array.isArray(step.detailFields) || !step.detailFields.length) return guideInfoHtml;
    const pid = property.id;
    const fieldsHtml = step.detailFields.map(fd => {
      const cur = this._getNested(property, fd.field);
      // 未保存(undefined/null)または空文字の場合はデフォルト値を初期表示する
      const val = (cur === undefined || cur === null || cur === "") ? (fd.default ?? "") : cur;
      const hintHtml = fd.hint
        ? `<div class="form-text small" style="font-size:0.7rem;">${this._esc(fd.hint)}</div>`
        : "";
      const inputId = `rf-det-${step.key}-${pid}-${fd.field.replace(/\./g, "_")}`;
      const commonAttrs =
        `class="form-control form-control-sm rf-detail-input" ` +
        `id="${inputId}" ` +
        `data-step="${step.key}" data-pid="${pid}" data-field="${this._esc(fd.field)}" data-type="${fd.type}"`;

      let inputHtml = "";
      if (fd.type === "textarea") {
        inputHtml = `<textarea ${commonAttrs} rows="${fd.rows || 4}" placeholder="${this._esc(fd.placeholder || "")}">${this._esc(val)}</textarea>`;
      } else if (fd.type === "select") {
        const opts = (fd.options || []).map(o =>
          `<option value="${this._esc(o.value)}" ${String(val) === String(o.value) ? "selected" : ""}>${this._esc(o.label)}</option>`
        ).join("");
        inputHtml = `<select ${commonAttrs}>${opts}</select>`;
      } else if (fd.type === "number") {
        const minAttr = fd.min !== undefined ? `min="${fd.min}"` : "";
        const maxAttr = fd.max !== undefined ? `max="${fd.max}"` : "";
        inputHtml = `<input type="number" ${commonAttrs} ${minAttr} ${maxAttr} value="${this._esc(val === "" ? "" : val)}">`;
      } else if (fd.type === "date") {
        inputHtml = `<input type="date" ${commonAttrs} value="${this._esc(val || "")}">`;
      } else if (fd.type === "time") {
        inputHtml = `<input type="time" ${commonAttrs} value="${this._esc(val || "")}">`;
      } else if (fd.type === "switch" || fd.type === "checkbox") {
        const switchCls = fd.type === "switch" ? "form-switch" : "";
        inputHtml = `
          <div class="form-check ${switchCls} mb-0">
            <input type="checkbox" class="form-check-input rf-detail-input"
              id="${inputId}"
              data-step="${step.key}" data-pid="${pid}" data-field="${this._esc(fd.field)}" data-type="${fd.type}"
              ${val ? "checked" : ""}>
            <label class="form-check-label small" for="${inputId}">${this._esc(fd.label)}</label>
          </div>`;
        // switch/checkbox はラベルを input 内に含めたので外側のラベルは不要
        return `<div class="mb-2">${inputHtml}${hintHtml}</div>`;
      } else {
        // text
        inputHtml = `<input type="text" ${commonAttrs} placeholder="${this._esc(fd.placeholder || "")}" value="${this._esc(val)}">`;
      }
      return `
        <div class="mb-2">
          <label class="form-label small mb-1" for="${inputId}">${this._esc(fd.label)}</label>
          ${inputHtml}
          ${hintHtml}
        </div>`;
    }).join("");

    // 利用可能変数ヒント
    const varsHint = (Array.isArray(step.detailVarsHint) && step.detailVarsHint.length)
      ? `<div class="small text-muted mb-2" style="font-size:0.72rem;">
           <i class="bi bi-braces"></i> 利用可変数: ${step.detailVarsHint.map(v => `<code>${this._esc(v)}</code>`).join(" ")}
         </div>`
      : "";
    // 注意文 (detailNoteHtml は HTML をそのまま埋め込み可、detailNote は文字列のみ)
    const noteHtml = step.detailNoteHtml
      ? `<div class="alert alert-warning py-2 px-2 mb-2" style="font-size:0.78rem;">${step.detailNoteHtml}</div>`
      : step.detailNote
      ? `<div class="alert alert-warning py-1 px-2 mb-2 small" style="font-size:0.72rem;">
           <i class="bi bi-info-circle"></i> ${this._esc(step.detailNote)}
         </div>`
      : "";

    // detailTwoCol: true の場合は左:fieldsHtml / 右:noteHtml の2カラムレイアウト
    const innerHtml = step.detailTwoCol
      ? `<div class="row g-2"><div class="col-md-6">${fieldsHtml}</div><div class="col-md-6">${step.detailNoteHtml || ""}</div></div>`
      : `${noteHtml}${fieldsHtml}`;

    return `
      <div class="rf-detail-panel mt-2 p-2 border rounded" style="background:#f8fafc;">
        <div class="small fw-semibold mb-2">
          <i class="bi bi-sliders2"></i> 詳細設定（${this._esc(property.name)}）
        </div>
        ${varsHint}
        ${innerHtml}
      </div>
    `;
  },

  // 有効状態を返す (propertyField > 物件別 channelOverrides.enabled > 通知定義 defaultEnabled)
  _isEnabled(property, step) {
    if (step.propertyField) {
      const parts = step.propertyField.split(".");
      let v = property;
      for (const p of parts) { v = v?.[p]; }
      return typeof v === "boolean" ? v : true;
    }
    if (step.globalChannel) {
      const ov = property.channelOverrides?.[step.globalChannel];
      if (ov && ov.enabled !== undefined) return ov.enabled !== false;
      const n = window.NotifyChannelEditor?.findNotification(step.globalChannel);
      return n ? n.defaultEnabled !== false : true;
    }
    const flow = property.reservationFlow || {};
    return flow[step.key]?.enabled !== false;
  },

  // ========== render / load ==========
  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-arrow-right-circle"></i> 予約フロー構成</h2>
        <span id="rfSaveStatus" class="small text-muted"></span>
      </div>
      <p class="text-muted small mb-3">
        ゲスト / Webアプリ管理者 / スタッフの3レーンで予約〜月末請求までのフローを管理します。
        各カードを展開すると通知設定（文言・タイミング・送信先）を直接編集できます。
      </p>
      ${this._renderStyles()}
      <!-- 物件セレクタ (sticky固定: スクロール時も対象物件が常に見える) -->
      <div id="rfPropertySelector" class="rf-property-bar mb-2"></div>
      <!-- モバイルタブ -->
      <div class="rf-mobile-tabs d-md-none mb-2">
        <ul class="nav nav-pills nav-fill rf-lane-tabs">
          <li class="nav-item"><a class="nav-link active" href="#" data-lane="all">すべて</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="guest">👤 ゲスト</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="owner">🏠 Webアプリ管理者</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="staff">🧹 スタッフ</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="branch">🔴 分岐</a></li>
        </ul>
      </div>
      <!-- メインスイムレーン -->
      <div id="rfSwimLane"></div>
    `;

    // モバイルタブのイベント
    container.querySelectorAll(".rf-lane-tabs .nav-link").forEach(a => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        container.querySelectorAll(".rf-lane-tabs .nav-link").forEach(x => x.classList.remove("active"));
        a.classList.add("active");
        this._currentMobileLane = a.dataset.lane;
        this._renderSwimLane();
      });
    });
    this._currentMobileLane = "all";

    await this.load();
  },

  async load() {
    try {
      if (API.properties && typeof API.properties.listMinpakuNumbered === "function") {
        this.properties = await API.properties.listMinpakuNumbered();
      } else {
        const snap = await db.collection("properties").get();
        this.properties = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(p => p.active !== false)
          .filter(p => (p.type || "minpaku") === "minpaku");
      }
    } catch (e) {
      console.warn("properties 取得失敗:", e.message);
      this.properties = [];
    }

    try {
      const nDoc = await db.collection("settings").doc("notifications").get();
      this.notifChannels = nDoc.exists ? (nDoc.data().channels || {}) : {};
    } catch (e) {
      console.warn("notifications 取得失敗:", e.message);
      this.notifChannels = {};
    }

    // 目アイコン型の母集合フィルタは廃止 (1物件ずつ編集する性質のため、
    // 既存の _renderPropertySelector の 1 物件選択 UI だけで運用)
    this.selectedPropertyIds = this.properties.map(p => p.id);

    this._renderPropertySelector();
    this._renderSwimLane();
  },

  // 物件ドロップダウン (スイムレーン内の物件別メモ用)
  _renderPropertySelector() {
    const wrap = document.getElementById("rfPropertySelector");
    if (!wrap) return;
    const visible = this._visibleProperties();
    if (visible.length === 0) { wrap.innerHTML = ""; return; }

    // 現在選択中物件
    if (!this._selectedPid || !visible.find(p => p.id === this._selectedPid)) {
      this._selectedPid = visible[0].id;
    }

    wrap.innerHTML = `
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <label class="form-label mb-0 small fw-semibold">対象物件:</label>
        ${visible.map(p => `
          <button class="btn btn-sm ${p.id === this._selectedPid ? "btn-primary" : "btn-outline-secondary"} rf-prop-btn"
            data-pid="${p.id}" style="font-size:0.78rem;">
            <span class="badge me-1" style="background:${p.color || "#6c757d"}">${p.propertyNumber || "-"}</span>
            ${this._esc(p.name)}
          </button>
        `).join("")}
        <button class="btn btn-sm btn-outline-info ms-2 rf-import-btn" style="font-size:0.78rem;">
          <i class="bi bi-box-arrow-in-down"></i> 他物件からインポート
        </button>
        <span class="text-muted small ms-1">※ ON/OFF・通知設定・メモはすべてこの物件のみに保存されます。テスト送信もこの物件のスタッフ・オーナーが対象です。</span>
      </div>
    `;

    wrap.querySelectorAll(".rf-prop-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._selectedPid = btn.dataset.pid;
        this._renderPropertySelector();
        this._renderSwimLane();
      });
    });

    const importBtn = wrap.querySelector(".rf-import-btn");
    if (importBtn) {
      importBtn.addEventListener("click", () => {
        this._showImportModal("reservation");
      });
    }
  },

  _visibleProperties() {
    return this.properties.filter(p =>
      !this.selectedPropertyIds || this.selectedPropertyIds.length === 0 ||
      this.selectedPropertyIds.includes(p.id)
    );
  },

  // ========== スイムレーン描画 ==========
  _renderSwimLane() {
    const wrap = document.getElementById("rfSwimLane");
    if (!wrap) return;

    const visible = this._visibleProperties();
    if (!visible.length) {
      wrap.innerHTML = `<div class="text-muted">民泊物件がありません</div>`;
      return;
    }

    const property = visible.find(p => p.id === this._selectedPid) || visible[0];
    this._selectedPid = property.id;

    // メインフロー (branch なし)
    const mainSteps = this.STEPS.filter(s => !s.branch);
    // 分岐
    const branchASteps = this.STEPS.filter(s => s.branch === "cancel");
    const branchBSteps = this.STEPS.filter(s => s.branch === "staff_cancel");
    const branchCSteps = this.STEPS.filter(s => s.branch === "monitor");

    const phases = [1, 2];
    const phaseLabels = {
      1: "Phase 1: 予約受付",
      2: "Phase 2: ゲスト対応 & スタッフ手配",
    };

    // デスクトップ: 3レーングリッド
    // rf-swimlane-root の外側に overflow-x: auto スクロールラッパーを置く
    // (overflow-x: auto が親にあると position: sticky が効かなくなるため分離)
    let html = `<div class="rf-swimlane-scroll"><div class="rf-swimlane-root">`;

    // --- ヘッダー行 ---
    html += `
      <div class="rf-swimlane-grid rf-swimlane-header">
        <div class="rf-lane-header rf-lane-guest">👤 ゲスト</div>
        <div class="rf-lane-header rf-lane-owner">🏠 Webアプリ管理者</div>
        <div class="rf-lane-header rf-lane-staff">🧹 スタッフ</div>
      </div>
    `;

    // --- フェーズごとにレーンへ振り分け ---
    phases.forEach(phase => {
      const phaseSteps = mainSteps.filter(s => s.phase === phase);
      if (!phaseSteps.length) return;

      html += `
        <div class="rf-phase-divider">
          <span>━━━ ${this._esc(phaseLabels[phase])} ━━━</span>
        </div>
      `;

      // Phase 2 はサブトラックごとに分けて表示
      if (phase === 2) {
        const guestTrack = phaseSteps.filter(s => s.track === "guest");
        const staffTrack = phaseSteps.filter(s => s.track === "staff");

        html += `
          <div class="rf-track-label">
            <span class="rf-track-badge rf-track-guest">👤 ゲストトラック</span>
          </div>
        `;
        html += this._renderStepRows(guestTrack, property, "guest");

        html += `
          <div class="rf-track-label">
            <span class="rf-track-badge rf-track-staff">🧹 スタッフトラック</span>
          </div>
        `;
        html += this._renderStepRows(staffTrack, property, "staff");
      } else {
        html += this._renderStepRows(phaseSteps, property, null);
      }
    });

    // --- 分岐セクション ---
    html += `
      <div class="rf-phase-divider rf-branch-divider">
        <span>━━━ 分岐 A: 予約キャンセル / 変更 ━━━</span>
      </div>
    `;
    html += this._renderStepRows(branchASteps, property, null);

    html += `
      <div class="rf-phase-divider rf-branch-divider">
        <span>━━━ 分岐 B: スタッフ出勤キャンセル ━━━</span>
      </div>
    `;
    html += this._renderStepRows(branchBSteps, property, null);

    html += `
      <div class="rf-phase-divider rf-branch-divider">
        <span>━━━ 分岐 C: 監視 ━━━</span>
      </div>
    `;
    html += this._renderStepRows(branchCSteps, property, null);

    html += `</div></div>`;

    wrap.innerHTML = html;

    // イベント登録 (DOM 単位で1回だけ。delegation するので再登録不要)
    if (!wrap.dataset.eventsAttached) {
      this._attachEvents(wrap, property);
      wrap.dataset.eventsAttached = "1";
    }
    // NotifyChannelEditor は再描画の度に bindCardEvents が必要 (新しい block にバインド)
    const NCE = window.NotifyChannelEditor;
    if (NCE) {
      wrap.querySelectorAll(".rf-shared-notify").forEach(block => {
        const idPrefix = block.dataset.idPrefix;
        const pid = block.dataset.pid;
        const notifKey = block.dataset.notifKey;
        NCE.bindCardEvents(block, {
          idPrefix,
          onChange: () => this._queueSaveOverride(notifKey, pid),
          onTestSend: (key, channelData, varGroup, btn) => this._sendTestNotification(key, channelData, varGroup, btn, pid),
        });
      });
    }
  },

  // ステップ配列からグリッド行HTMLを生成
  _renderStepRows(steps, property, trackHint) {
    if (!steps.length) return "";
    let html = "";
    steps.forEach((step, idx) => {
      const enabled = this._isEnabled(property, step);
      const flow = property.reservationFlow || {};
      const memo = flow[step.key]?.memo || "";

      // モバイルフィルタ用 data-lane 属性
      const laneClass = `rf-lane-${step.lane}`;
      const branchAttr = step.branch ? `data-branch="${step.branch}"` : "";

      // 3列グリッド配置: lane に応じて列を決める
      const colClass = step.lane === "guest" ? "rf-col-guest" :
                       step.lane === "staff" ? "rf-col-staff" : "rf-col-owner";

      html += `
        <div class="rf-swimlane-grid rf-step-row" data-step-key="${step.key}" data-lane="${step.lane}" ${branchAttr}>
          <div class="rf-lane-cell rf-col-guest ${step.lane === "guest" ? "rf-cell-active" : "rf-cell-empty"}">
            ${step.lane === "guest" ? this._renderCard(step, property, enabled, memo) : ""}
          </div>
          <div class="rf-lane-cell rf-col-owner ${step.lane === "owner" ? "rf-cell-active" : "rf-cell-empty"}">
            ${step.lane === "owner" ? this._renderCard(step, property, enabled, memo) : ""}
          </div>
          <div class="rf-lane-cell rf-col-staff ${step.lane === "staff" ? "rf-cell-active" : "rf-cell-empty"}">
            ${step.lane === "staff" ? this._renderCard(step, property, enabled, memo) : ""}
          </div>
        </div>
      `;

      // 矢印行
      if (step.arrowTo || step.arrowFrom) {
        html += this._renderArrowRow(step);
      }
    });
    return html;
  },

  // 矢印行
  _renderArrowRow(step) {
    const laneOrder = { guest: 0, owner: 1, staff: 2 };
    const fromLane = step.arrowFrom || step.lane;
    const toLane = step.arrowTo;
    if (!toLane) return "";

    const fromIdx = laneOrder[fromLane];
    const toIdx = laneOrder[toLane];
    const goRight = toIdx > fromIdx;
    const icon = goRight ? "bi-arrow-right" : "bi-arrow-left";
    const label = toLane === "guest" ? "👤" : toLane === "owner" ? "🏠" : "🧹";

    // 矢印をフロム列に配置
    const cols = ["", "", ""];
    cols[fromIdx] = `<span class="rf-arrow-badge rf-arrow-${toLane}"><i class="bi ${icon}"></i> ${label}</span>`;

    return `
      <div class="rf-swimlane-grid rf-arrow-row">
        <div class="rf-lane-cell">${cols[0]}</div>
        <div class="rf-lane-cell">${cols[1]}</div>
        <div class="rf-lane-cell">${cols[2]}</div>
      </div>
    `;
  },

  // カード1枚のHTML
  _renderCard(step, property, enabled, memo) {
    // バッジ類: status="未実装" または unimplemented:true の両方に対応
    const statusBadge = (step.status === "未実装" || step.unimplemented)
      ? `<span class="badge bg-secondary ms-1" style="font-size:10px;">未実装</span>`
      : "";
    let syncBadge = "";
    if (step.propertyField) {
      syncBadge = `<span class="badge bg-success-subtle text-success border border-success-subtle ms-1 rf-sync-badge" style="font-size:9px;" title="properties.${step.propertyField} に保存 (物件ごと・他タブと同期)"><i class="bi bi-arrow-left-right"></i> 同期</span>`;
    }
    const arrowBadge = step.arrowTo
      ? `<span class="badge bg-light text-dark border ms-1" style="font-size:9px;"><i class="bi bi-arrow-right"></i> ${step.arrowTo === "guest" ? "👤" : step.arrowTo === "owner" ? "🏠" : "🧹"}</span>`
      : (step.arrowFrom ? `<span class="badge bg-light text-dark border ms-1" style="font-size:9px;"><i class="bi bi-arrow-left"></i> ${step.arrowFrom === "guest" ? "👤" : step.arrowFrom === "owner" ? "🏠" : "🧹"}</span>` : "");

    // フォールドID
    const foldId = `rfc-${step.key}-${property.id}`;

    const notifEditorHtml = step.globalChannel
      ? this._renderSharedNotifyCard(step, property)
      : "";
    const showHeaderToggle = true;
    const toggleChecked = enabled ? "checked" : "";
    const toggleId = `rf-tog-${step.key}-${property.id}`;
    const headerToggleHtml = showHeaderToggle
      ? `<div class="form-check form-switch mb-0">
          <input class="form-check-input rf-toggle" type="checkbox" id="${toggleId}"
            data-step="${step.key}" data-pid="${property.id}" ${toggleChecked}
            title="${step.propertyField ? "この物件のON/OFF" : "このフローのON/OFF"}">
        </div>`
      : "";

    // ゲスト画面リンク
    const guestBtn = (typeof step.guestUrlFn === "function")
      ? `<a href="${this._esc(step.guestUrlFn(property.id))}" target="_blank" rel="noopener" class="btn btn-outline-info btn-sm py-0 px-2 me-1" style="font-size:0.72rem;" title="新規タブでゲスト画面を開く"><i class="bi bi-box-arrow-up-right"></i> ゲスト画面</a>`
      : "";
    const linkBtn = step.linkHash
      ? `<a href="${this._esc(step.linkHash)}" class="btn btn-outline-secondary btn-sm py-0 px-2" style="font-size:0.72rem;">${this._esc(step.linkLabel || "設定")} <i class="bi bi-arrow-right"></i></a>`
      : "";
    const hintHtml = step.hint
      ? `<div class="small text-muted mt-1" style="font-size:11px;"><i class="bi bi-info-circle"></i> ${this._esc(step.hint)}</div>`
      : "";

    // iCal URL 管理パネル埋込用コンテナ (展開時に propertyIcalPanel.render で注入)
    const icalPanelHtml = step.icalPanel
      ? `
        <div class="mt-2 p-2 border rounded" style="background:#f8fafc;">
          <div class="small fw-semibold mb-2"><i class="bi bi-calendar2-event text-primary"></i> iCal URL 管理（${this._esc(property.name)}）</div>
          <div class="rf-ical-container" data-pid="${property.id}"></div>
          <div class="small text-muted mt-1" style="font-size:11px;">
            <i class="bi bi-arrow-left-right"></i> 物件詳細モーダルと同一データ (syncSettings) を共有します。
          </div>
        </div>
      `
      : "";

    return `
      <div class="rf-card ${enabled ? "rf-card-enabled" : "rf-card-disabled"}" data-step="${step.key}" data-pid="${property.id}">
        <!-- ヘッダー (常時表示) -->
        <div class="rf-card-header" data-fold="${foldId}" style="cursor:pointer;">
          <i class="bi ${step.icon} rf-card-icon"></i>
          <span class="rf-card-title" title="${this._esc(step.label)}">${this._esc(step.label)}</span>
          ${statusBadge}${syncBadge}${arrowBadge}
          <div class="ms-auto d-flex align-items-center gap-1">
            ${headerToggleHtml}
            <i class="bi bi-chevron-down rf-chevron" data-fold="${foldId}" style="font-size:0.75rem;transition:transform 0.2s;"></i>
          </div>
        </div>
        <!-- 展開コンテンツ (デフォルト非表示) -->
        <div class="rf-card-body" id="${foldId}" style="display:none;" data-step-key="${step.key}" data-pid="${property.id}">
          ${hintHtml}
          ${this._renderDetailFields(step, property)}
          ${notifEditorHtml}
          ${icalPanelHtml}
          <!-- リンクボタン -->
          ${(guestBtn || linkBtn) ? `<div class="mt-2 d-flex flex-wrap gap-1">${guestBtn}${linkBtn}</div>` : ""}
          <!-- 物件固有メモ -->
          <div class="mt-2">
            <label class="form-label small text-muted mb-1"><i class="bi bi-pencil"></i> 物件メモ（${this._esc(property.name)}用）</label>
            <input type="text" class="form-control form-control-sm rf-memo"
              data-step="${step.key}" data-pid="${property.id}"
              placeholder="物件固有のメモ（任意）"
              value="${this._esc(memo)}">
          </div>
        </div>
      </div>
    `;
  },

  // 物件別通知カード (共有コンポーネント経由)
  _renderSharedNotifyCard(step, property) {
    const NCE = window.NotifyChannelEditor;
    if (!NCE) return "";
    const n = NCE.findNotification(step.globalChannel);
    if (!n) {
      return `<div class="mt-2 small text-muted"><i class="bi bi-info-circle"></i> この通知 (${this._esc(step.globalChannel)}) は通知設定タブで未定義です。</div>`;
    }
    const channelData = (property.channelOverrides || {})[step.globalChannel] || {};
    const idPrefix = `prop_${property.id}_${step.globalChannel}`;
    const importBtnHtml = `<button class="btn btn-sm btn-outline-info rf-notify-import-btn" type="button" data-pid="${property.id}" data-notif-key="${step.globalChannel}"><i class="bi bi-box-arrow-in-down"></i> 他物件から</button>`;

    // keybox_remind: キーボックス送信予定時刻基準のタイミング設定UIを追加
    const keyboxRemindTimingHtml = step.keyboxRemindTiming
      ? this._renderKeyboxRemindTiming(step.key, property)
      : "";

    return `<div class="rf-shared-notify mt-2" data-pid="${property.id}" data-notif-key="${step.globalChannel}" data-id-prefix="${idPrefix}">
      ${keyboxRemindTimingHtml}${NCE.renderNotificationCard(n, channelData, { idPrefix, collapsed: false, hideHeader: true, extraActionsHtml: importBtnHtml })}
    </div>`;
  },

  // _legacy_renderOverridePanel_unused_ (共有コンポーネント移行で削除)
  _legacy_renderOverridePanel_unused_(step, property, globalCh, ov) {
    const key = step.globalChannel;
    const pid = property.id;
    const panelId = `rf-ovpanel-${key}-${pid}`;
    const hasAny = Object.keys(ov).some(k => ov[k] !== undefined);

    // ---- ブール型フィールド (enabled / 送信先) ----
    const boolFields = [
      { field: "enabled",    label: "有効/無効",        icon: "bi-power",             globalVal: globalCh.enabled !== false },
      { field: "ownerLine",  label: "Webアプリ管理者LINE",     icon: "bi-person-circle",     globalVal: globalCh.ownerLine !== false },
      { field: "groupLine",  label: "グループLINE",     icon: "bi-people-fill",       globalVal: !!globalCh.groupLine },
      { field: "staffLine",  label: "スタッフLINE",     icon: "bi-person-lines-fill", globalVal: !!globalCh.staffLine },
      { field: "ownerEmail", label: "Webアプリ管理者メール",   icon: "bi-envelope",          globalVal: !!globalCh.ownerEmail },
    ];

    const boolRows = boolFields.map(({ field, label, icon, globalVal }) => {
      const isOverriding = ov[field] !== undefined;
      const ovVal = isOverriding ? ov[field] : globalVal;
      return `
        <div class="d-flex align-items-center gap-2 py-1 border-bottom" style="font-size:0.8rem;">
          <div class="form-check mb-0" style="min-width:130px;">
            <input class="form-check-input rf-ov-check" type="checkbox" id="rf-ovc-${key}-${pid}-${field}"
              data-notif-key="${key}" data-pid="${pid}" data-field="${field}"
              ${isOverriding ? "checked" : ""}>
            <label class="form-check-label small" for="rf-ovc-${key}-${pid}-${field}">
              <i class="bi ${icon}"></i> ${label}
            </label>
          </div>
          <div class="rf-ov-val-wrap ${isOverriding ? "" : "opacity-50 pe-none"}" id="rf-ovwrap-${key}-${pid}-${field}">
            <div class="form-check form-switch mb-0">
              <input class="form-check-input rf-ov-val" type="checkbox" id="rf-ovv-${key}-${pid}-${field}"
                data-notif-key="${key}" data-pid="${pid}" data-field="${field}"
                ${ovVal ? "checked" : ""}
                title="上書き値 (チェック=ON)">
            </div>
          </div>
          <span class="text-muted ms-1" style="font-size:0.72rem;">${isOverriding ? `上書き: <b>${ovVal ? "ON" : "OFF"}</b>` : `全共通: ${globalVal ? "ON" : "OFF"}`}</span>
        </div>`;
    }).join("");

    // ---- customMessage オーバーライド ----
    const isMsgOv = ov.customMessage !== undefined;
    const msgGlobal = this._esc(globalCh.customMessage || "");
    const msgOvVal = this._esc(isMsgOv ? (ov.customMessage || "") : "");
    const msgRow = `
      <div class="py-1 border-bottom" style="font-size:0.8rem;" id="rf-ov-msgrow-${key}-${pid}">
        <div class="d-flex align-items-center gap-2 mb-1">
          <div class="form-check mb-0" style="min-width:130px;">
            <input class="form-check-input rf-ov-check" type="checkbox" id="rf-ovc-${key}-${pid}-customMessage"
              data-notif-key="${key}" data-pid="${pid}" data-field="customMessage"
              ${isMsgOv ? "checked" : ""}>
            <label class="form-check-label small" for="rf-ovc-${key}-${pid}-customMessage">
              <i class="bi bi-pencil-square"></i> メッセージ上書き
            </label>
          </div>
          <span class="text-muted small" style="font-size:0.7rem;">${isMsgOv ? "物件別メッセージ" : `全共通: ${msgGlobal ? msgGlobal.slice(0,30) + "…" : "(未設定)"}`}</span>
        </div>
        <div class="rf-ov-txt-wrap ${isMsgOv ? "" : "d-none"}" id="rf-ovwrap-${key}-${pid}-customMessage">
          <textarea class="form-control form-control-sm rf-ov-msg-ta" rows="3"
            style="font-size:0.78rem;font-family:monospace;"
            data-notif-key="${key}" data-pid="${pid}" data-field="customMessage"
            placeholder="全共通メッセージを上書き（空欄=継承）">${msgOvVal}</textarea>
          <div class="mt-1">
            <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2 rf-ov-push-global"
              data-notif-key="${key}" data-pid="${pid}" style="font-size:0.7rem;" title="この物件の設定を全共通へ反映">
              <i class="bi bi-arrow-up-circle"></i> 全共通に反映
            </button>
          </div>
        </div>
      </div>`;

    // ---- timings オーバーライド ----
    const isTmOv = Array.isArray(ov.timings);
    const tmOvTimings = isTmOv ? ov.timings : [];
    const globalTimingsStr = Array.isArray(globalCh.timings) && globalCh.timings.length
      ? `${globalCh.timings.length}件設定済み`
      : `(未設定)`;
    // タイミングオーバーライド用のキー: 物件別タイミング行をグローバルと区別するため suffix を付与
    const ovTimingKey = `${key}--ov--${pid}`;
    const tmRows = tmOvTimings.map((t, idx) => this._renderTimingRow(ovTimingKey, t, idx)).join("");
    const timingsRow = `
      <div class="py-1" style="font-size:0.8rem;" id="rf-ov-tmrow-${key}-${pid}">
        <div class="d-flex align-items-center gap-2 mb-1">
          <div class="form-check mb-0" style="min-width:130px;">
            <input class="form-check-input rf-ov-check" type="checkbox" id="rf-ovc-${key}-${pid}-timings"
              data-notif-key="${key}" data-pid="${pid}" data-field="timings"
              ${isTmOv ? "checked" : ""}>
            <label class="form-check-label small" for="rf-ovc-${key}-${pid}-timings">
              <i class="bi bi-clock"></i> タイミング上書き
            </label>
          </div>
          <span class="text-muted small" style="font-size:0.7rem;">${isTmOv ? `物件別 ${tmOvTimings.length}件` : `全共通: ${globalTimingsStr}`}</span>
        </div>
        <div class="rf-ov-tm-wrap ${isTmOv ? "" : "d-none"}" id="rf-ovwrap-${key}-${pid}-timings">
          <div class="rf-ov-timings" data-notif-key="${key}" data-pid="${pid}" data-ov-timing-key="${ovTimingKey}">
            ${tmRows}
          </div>
          <button type="button" class="btn btn-sm btn-outline-primary mt-1 rf-ov-add-timing"
            data-notif-key="${key}" data-pid="${pid}" data-ov-timing-key="${ovTimingKey}" style="font-size:0.75rem;">
            <i class="bi bi-plus"></i> タイミング追加
          </button>
        </div>
      </div>`;

    return `
      <div class="rf-override-panel mt-2 border rounded p-2" data-notif-key="${key}" data-pid="${pid}" style="background:#fff8e1;">
        <div class="d-flex align-items-center mb-2">
          <span class="small fw-semibold me-auto"><i class="bi bi-shuffle"></i> ${this._esc(property.name)} — 物件別設定上書き</span>
          ${hasAny ? `<button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2 rf-ov-clear" data-notif-key="${key}" data-pid="${pid}" style="font-size:0.72rem;" title="全フィールドの上書きを解除"><i class="bi bi-x-circle"></i> 全解除</button>` : ""}
        </div>
        <div id="${panelId}">
          ${boolRows}
          ${msgRow}
          ${timingsRow}
        </div>
        <div class="small text-muted mt-1" style="font-size:0.7rem;">
          <i class="bi bi-info-circle"></i> チェックした項目のみ上書き。未チェックは「全共通」の値を継承。
        </div>
      </div>
    `;
  },

  // _legacy_renderNotifEditor_unused_ (共有コンポーネント移行で削除)
  _legacy_renderNotifEditor_unused_(step, ch, nd) {
    const varGroup = step.varGroup || nd.varGroup || "booking";
    const vars = this.systemVariables[varGroup] || [];
    const customMessage = ch.customMessage || "";
    const msgValue = customMessage || nd.defaultMsg || "";

    // プレビュー
    let preview = msgValue;
    vars.forEach(v => {
      preview = preview.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });

    // タイミング
    let timings = Array.isArray(ch.timings) && ch.timings.length
      ? ch.timings
      : [{ mode: ch.mode || "event", timing: ch.timing || nd.defaultTiming || "immediate", timingMinutes: ch.timingMinutes || "", beforeDays: ch.beforeDays || 3, beforeTime: ch.beforeTime || "09:00", schedulePattern: ch.schedulePattern || "monthEnd", scheduleDay: ch.scheduleDay || 1, scheduleDow: ch.scheduleDow || 0, scheduleTime: ch.scheduleTime || "09:00" }];

    // 送信先チェックボックス
    const ownerLine  = ch.ownerLine  !== undefined ? ch.ownerLine  !== false : true;
    const groupLine  = ch.groupLine  !== undefined ? !!ch.groupLine  : false;
    const staffLine  = ch.staffLine  !== undefined ? !!ch.staffLine  : false;
    const ownerEmail = ch.ownerEmail !== undefined ? !!ch.ownerEmail : false;
    const discordOwner = !!ch.discordOwner;
    const discordSubOwner = !!ch.discordSubOwner;

    // 変数タグ
    const varTags = vars.map(v =>
      `<span class="badge bg-light text-dark border me-1 mb-1 rf-var-tag" role="button"
        data-var="{${v.name}}" data-notif-key="${step.globalChannel}"
        title="${v.label}">{${v.name}} <small class="text-muted">${v.label}</small></span>`
    ).join("");

    const key = step.globalChannel;
    return `
      <div class="rf-notif-editor mt-2" data-notif-key="${key}">
        <div class="small text-muted mb-2"><i class="bi bi-bell"></i> 通知設定（この物件のみ）</div>

        <!-- 📩 送信先 -->
        <div class="mb-2">
          <div class="small text-muted mb-1"><i class="bi bi-send"></i> 送信先</div>
          <div class="d-flex flex-wrap gap-2">
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="ownerLine" ${ownerLine ? "checked" : ""}>
              <span><i class="bi bi-person-circle text-success"></i> Webアプリ管理者LINE</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="groupLine" ${groupLine ? "checked" : ""}>
              <span><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="staffLine" ${staffLine ? "checked" : ""}>
              <span><i class="bi bi-person-lines-fill text-info"></i> スタッフLINE</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="ownerEmail" ${ownerEmail ? "checked" : ""}>
              <span><i class="bi bi-envelope text-warning"></i> Webアプリ管理者メール</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="discordOwner" ${discordOwner ? "checked" : ""}>
              <span><i class="bi bi-discord" style="color:#5865F2"></i> Discord(Webアプリ管理者)</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="discordSubOwner" ${discordSubOwner ? "checked" : ""}>
              <span><i class="bi bi-discord" style="color:#8da0f8"></i> Discord(サブ)</span>
            </label>
          </div>
        </div>

        <!-- ⏰ タイミング -->
        <div class="mb-2">
          <div class="small text-muted mb-1"><i class="bi bi-clock"></i> 通知タイミング</div>
          <div class="rf-notif-timings" data-notif-key="${key}">
            ${timings.map((t, idx) => this._renderTimingRow(key, t, idx)).join("")}
          </div>
          <button type="button" class="btn btn-sm btn-outline-primary mt-1 rf-add-timing" data-notif-key="${key}" style="font-size:0.75rem;">
            <i class="bi bi-plus"></i> タイミングを追加
          </button>
        </div>

        <!-- 📝 変数ヒント + メッセージ -->
        <div class="mb-1">
          <div class="small text-muted mb-1"><i class="bi bi-pencil"></i> メッセージテンプレート
            <small class="text-muted ms-1">💡 利用可変数 (クリックで挿入):</small>
          </div>
          <div class="d-flex flex-wrap mb-1">${varTags}</div>
          <div class="row g-2">
            <div class="col-md-6">
              <textarea class="form-control form-control-sm rf-notif-msg"
                data-notif-key="${key}" data-var-group="${varGroup}" data-field="customMessage"
                rows="4" style="font-size:0.8rem;">${this._esc(msgValue)}</textarea>
            </div>
            <div class="col-md-6">
              <div class="border rounded p-2 bg-light small rf-notif-preview" data-preview="${key}"
                style="white-space:pre-wrap;min-height:90px;font-size:0.78rem;">${this._esc(preview)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // _legacy_renderTimingRow_unused_ (共有コンポーネント移行で未使用)
  _legacy_renderTimingRow_unused_(key, t, idx) {
    const mode = t.mode || "event";
    const timing = t.timing || "immediate";
    const showEventBlock = mode === "event";
    const showDateBlock  = mode === "date";
    const showMinutes    = showEventBlock && timing === "custom";
    const showBefore     = showEventBlock && timing === "beforeEvent";
    const pat = t.schedulePattern || "monthEnd";
    return `
      <div class="notify-timing-row d-flex flex-wrap align-items-center gap-1 p-2 mb-1 border rounded" data-notif-key="${key}" data-idx="${idx}">
        <div class="btn-group btn-group-sm">
          <input type="radio" class="btn-check rf-mode-radio" name="rfmode-${key}-${idx}" id="rfmode-ev-${key}-${idx}" value="event" ${mode==="event"?"checked":""} data-notif-key="${key}" data-idx="${idx}">
          <label class="btn btn-outline-secondary btn-sm" for="rfmode-ev-${key}-${idx}" style="font-size:0.75rem;">都度</label>
          <input type="radio" class="btn-check rf-mode-radio" name="rfmode-${key}-${idx}" id="rfmode-dt-${key}-${idx}" value="date" ${mode==="date"?"checked":""} data-notif-key="${key}" data-idx="${idx}">
          <label class="btn btn-outline-secondary btn-sm" for="rfmode-dt-${key}-${idx}" style="font-size:0.75rem;">日付</label>
        </div>
        <div class="rf-mode-event align-items-center gap-1 ${showEventBlock?"d-flex":"d-none"}" data-notif-key="${key}" data-idx="${idx}">
          <select class="form-select form-select-sm rf-timing-select" style="width:auto;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="timing">
            ${[["immediate","即時"],["5min","5分後"],["15min","15分後"],["30min","30分後"],["1hour","1時間後"],["morning","翌朝6時"],["evening","当日18時"],["custom","カスタム（分）"],["beforeEvent","N日前のHH:MM"]].map(([v,l])=>`<option value="${v}" ${timing===v?"selected":""}>${l}</option>`).join("")}
          </select>
          <input type="number" class="form-control form-control-sm rf-timing-minutes ${showMinutes?"":"d-none"}" style="width:80px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="timingMinutes" value="${t.timingMinutes||""}" min="1" placeholder="分数">
          <input type="number" class="form-control form-control-sm rf-before-days ${showBefore?"":"d-none"}" style="width:65px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="beforeDays" value="${t.beforeDays||3}" min="0" placeholder="日">
          <span class="small rf-before-suffix ${showBefore?"":"d-none"}" data-notif-key="${key}" data-idx="${idx}">日前の</span>
          <input type="time" class="form-control form-control-sm rf-before-time ${showBefore?"":"d-none"}" style="width:105px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="beforeTime" value="${t.beforeTime||"09:00"}">
        </div>
        <div class="rf-mode-date align-items-center gap-1 ${showDateBlock?"d-flex":"d-none"}" data-notif-key="${key}" data-idx="${idx}">
          <select class="form-select form-select-sm rf-schedule-pattern" style="width:auto;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="schedulePattern">
            <option value="monthEnd" ${pat==="monthEnd"?"selected":""}>毎月 月末</option>
            <option value="monthlyDay" ${pat==="monthlyDay"?"selected":""}>毎月 N日</option>
            <option value="weekly" ${pat==="weekly"?"selected":""}>毎週 曜日</option>
            <option value="daily" ${pat==="daily"?"selected":""}>毎日</option>
          </select>
          <input type="number" class="form-control form-control-sm rf-schedule-day ${pat==="monthlyDay"?"":"d-none"}" style="width:65px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="scheduleDay" value="${t.scheduleDay||1}" min="1" max="31">
          <select class="form-select form-select-sm rf-schedule-dow ${pat==="weekly"?"":"d-none"}" style="width:auto;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="scheduleDow">
            ${["日","月","火","水","木","金","土"].map((d,i)=>`<option value="${i}" ${(t.scheduleDow||0)==i?"selected":""}>${d}</option>`).join("")}
          </select>
          <input type="time" class="form-control form-control-sm rf-schedule-time" style="width:105px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="scheduleTime" value="${t.scheduleTime||"09:00"}">
        </div>
        <button type="button" class="btn btn-sm btn-link text-danger ms-auto rf-remove-timing p-0" data-notif-key="${key}" data-idx="${idx}" title="このタイミングを削除"><i class="bi bi-x-circle"></i></button>
      </div>
    `;
  },

  // ========== イベント登録 ==========
  _attachEvents(wrap, property) {
    // カード折りたたみ + 詳細 + memo + rf-toggle のみ。通知カードは共有コンポーネントで処理。
    wrap.addEventListener("click", (e) => {
      // 通知カード「他物件から」ボタン
      const importBtn = e.target.closest(".rf-notify-import-btn");
      if (importBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (window.NotifyImportModal) {
          window.NotifyImportModal.open({
            notifyKey: importBtn.dataset.notifKey,
            targetPropertyId: importBtn.dataset.pid,
            onImported: () => this._renderSwimLane(),
          });
        }
        return;
      }
      const header = e.target.closest(".rf-card-header[data-fold]");
      if (header && !e.target.closest("input") && !e.target.closest("button") && !e.target.closest("a") && !e.target.closest("[data-notify-toggle]")) {
        const foldId = header.dataset.fold;
        const body = document.getElementById(foldId);
        const chev = header.querySelector(".rf-chevron");
        if (body) {
          const isOpen = body.style.display !== "none";
          body.style.display = isOpen ? "none" : "";
          if (chev) chev.style.transform = isOpen ? "" : "rotate(180deg)";
          if (!isOpen) {
            const icalEl = body.querySelector(".rf-ical-container");
            if (icalEl && window.propertyIcalPanel && !icalEl.dataset.rendered) {
              icalEl.dataset.rendered = "1";
              window.propertyIcalPanel.render(icalEl, icalEl.dataset.pid);
            }
            // タスク2: form_complete_mail / keybox_send カード展開時に送信先・送信元 Gmail を表示
            const stepKey = body.dataset.stepKey;
            const pid = body.dataset.pid;
            if (stepKey === "form_complete_mail" && pid) {
              this._renderGmailSenderInfo(body, pid);
            }
            if (stepKey === "keybox_send" && pid) {
              this._renderKeyboxSenderInfo(body, pid);
            }
            // タスク3: scheduleType 変更時に customDaysBefore を disabled 制御
            // タスク8-3: post.enabled 変更時に post.code を disabled 制御
            if (stepKey === "keybox_send") {
              this._bindScheduleTypeConditional(body, pid);
              this._bindPostConditional(body, pid);
              this._bindKeyboxSendPreview(body, pid);
            }
            // keybox_remind: タイミングUIイベントをバインド
            if (stepKey === "keybox_remind") {
              this._bindKeyboxRemindTiming(body, pid);
            }
            // form_complete_mail: プレビューUIをバインド
            if (stepKey === "form_complete_mail") {
              this._bindMailPreview(body, pid, "formCompleteMail.body", "form_complete_mail_preview");
            }
            // form_update_mail: プレビューUIをバインド
            if (stepKey === "form_update_mail") {
              this._bindMailPreview(body, pid, "formUpdateMail.body", "form_update_mail_preview");
            }
          }
        }
      }
    });

    wrap.addEventListener("change", (e) => {
      if (e.target.classList.contains("rf-detail-input")) {
        this._queueSave(e.target.dataset.pid, e.target.dataset.step);
        return;
      }
      if (e.target.classList.contains("rf-toggle")) {
        const stepKey = e.target.dataset.step;
        const pid = e.target.dataset.pid;
        const card = wrap.querySelector(`.rf-card[data-step="${stepKey}"][data-pid="${pid}"]`);
        if (card) {
          card.classList.toggle("rf-card-enabled", e.target.checked);
          card.classList.toggle("rf-card-disabled", !e.target.checked);
        }
        const step = this.STEPS.find(s => s.key === stepKey);
        // globalChannel の場合は内側 NotifyChannelEditor の enabled トグルへ同期
        if (step && step.globalChannel) {
          const NCE = window.NotifyChannelEditor;
          const idPrefix = `prop_${pid}_${step.globalChannel}`;
          const dk = NCE ? NCE.dataKey(step.globalChannel, idPrefix) : null;
          const innerToggle = dk
            ? card?.querySelector(`input[type="checkbox"][data-field="enabled"][data-key="${CSS.escape(dk)}"]`)
            : null;
          if (innerToggle && innerToggle.checked !== e.target.checked) {
            innerToggle.checked = e.target.checked;
            innerToggle.dispatchEvent(new Event("change", { bubbles: true }));
          }
          // dispatchEvent の後も確実に保存をキューに積む (NCE.onChange 依存を排除)
          this._queueSaveOverride(step.globalChannel, pid);
        } else {
          this._queueSave(pid, stepKey);
        }
        return;
      }

      // 内側 NotifyChannelEditor の enabled トグル → ヘッダートグルへ同期
      if (e.target.matches('input[type="checkbox"][data-field="enabled"]') &&
          !e.target.classList.contains("rf-toggle")) {
        const card = e.target.closest(".rf-card");
        if (card) {
          const headerToggle = card.querySelector(":scope > .rf-card-header .rf-toggle");
          if (headerToggle && headerToggle.checked !== e.target.checked) {
            headerToggle.checked = e.target.checked;
            card.classList.toggle("rf-card-enabled", e.target.checked);
            card.classList.toggle("rf-card-disabled", !e.target.checked);
          }
        }
        // 保存は NCE.bindCardEvents の onChange に任せる
      }
    });

    wrap.addEventListener("input", (e) => {
      if (e.target.classList.contains("rf-memo")) {
        this._queueSave(e.target.dataset.pid, e.target.dataset.step);
      }
      if (e.target.classList.contains("rf-detail-input")) {
        this._queueSave(e.target.dataset.pid, e.target.dataset.step);
      }
    });

    // 共有通知エディタのイベントは _renderSwimLane 内で再描画毎にバインド (block が毎回新規)
  },

  // ========== テスト送信 (通知設定タブと同等、物件スコープ) ==========
  async _sendTestNotification(key, channelData, varGroup, btn, propertyId) {
    const TEST_API_URL = "https://api-5qrfx7ujcq-an.a.run.app/notifications/test";
    const NCE = window.NotifyChannelEditor;
    const sampleVars = {};
    (NCE?.SYSTEM_VARIABLES?.[varGroup] || []).forEach(v => { sampleVars[v.name] = v.sample; });
    const targets = {
      ownerLine:       !!channelData.ownerLine,
      groupLine:       !!channelData.groupLine,
      staffLine:       !!channelData.staffLine,
      staffEmail:      !!channelData.staffEmail,
      ownerEmail:      !!channelData.ownerEmail,
      subOwnerLine:    !!channelData.subOwnerLine,
      subOwnerEmail:   !!channelData.subOwnerEmail,
      discordOwner:    !!channelData.discordOwner,
      discordSubOwner: !!channelData.discordSubOwner,
      fcmStaff:        !!channelData.fcmStaff,
      fcmOwner:        !!channelData.fcmOwner,
    };
    if (!Object.values(targets).some(v => v)) {
      if (typeof showAlert === "function") showAlert("送信先を1つ以上チェックしてください", "warning");
      return;
    }
    const message = channelData.customMessage || "";
    let origHtml;
    if (btn) { btn.disabled = true; origHtml = btn.innerHTML; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...'; }
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(TEST_API_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: key, message: `【テスト】${message}`, targets, vars: sampleVars, propertyId: propertyId || this._selectedPid || null }),
      });
      const data = await res.json();
      if (res.ok) {
        if (typeof showAlert === "function") showAlert("テスト送信を実行しました", "success");
      } else {
        if (typeof showAlert === "function") showAlert("送信失敗: " + (data.error || res.status), "danger");
      }
    } catch (e) {
      if (typeof showAlert === "function") showAlert("送信失敗: " + e.message, "danger");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    }
  },

  // _legacy_attachEvents_extra_unused_ (旧通知系イベント; 共有コンポーネント移行で削除)
  _legacy_attachEvents_extra_unused_(wrap) {
    wrap.addEventListener("click", (e) => {
      const addBtn = e.target.closest(".rf-add-timing");
      if (addBtn) {
        const notifKey = addBtn.dataset.notifKey;
        const list = wrap.querySelector(`.rf-notif-timings[data-notif-key="${notifKey}"]`);
        if (!list) return;
        const idx = list.querySelectorAll(".notify-timing-row").length;
        const emptyT = { mode: "event", timing: "immediate", timingMinutes: "", beforeDays: 3, beforeTime: "09:00", schedulePattern: "monthEnd", scheduleDay: 1, scheduleDow: 0, scheduleTime: "09:00" };
        list.insertAdjacentHTML("beforeend", this._renderTimingRow(notifKey, emptyT, idx));
      }

      // 物件別オーバーライド タイミング追加
      const ovAddBtn = e.target.closest(".rf-ov-add-timing");
      if (ovAddBtn) {
        const notifKey = ovAddBtn.dataset.notifKey;
        const pid = ovAddBtn.dataset.pid;
        const ovTimingKey = ovAddBtn.dataset.ovTimingKey || `${notifKey}--ov--${pid}`;
        const list = wrap.querySelector(`.rf-ov-timings[data-notif-key="${notifKey}"][data-pid="${pid}"]`);
        if (!list) return;
        const idx = list.querySelectorAll(".notify-timing-row").length;
        const emptyT = { mode: "event", timing: "immediate", timingMinutes: "", beforeDays: 3, beforeTime: "09:00", schedulePattern: "monthEnd", scheduleDay: 1, scheduleDow: 0, scheduleTime: "09:00" };
        list.insertAdjacentHTML("beforeend", this._renderTimingRow(ovTimingKey, emptyT, idx));
        this._queueSaveOverride(notifKey, pid);
        return;
      }

      // 全共通に反映ボタン
      const pushBtn = e.target.closest(".rf-ov-push-global");
      if (pushBtn) {
        const notifKey = pushBtn.dataset.notifKey;
        const pid = pushBtn.dataset.pid;
        this._pushOverrideToGlobal(notifKey, pid, wrap);
        return;
      }

      // タイミング削除
      const rmBtn = e.target.closest(".rf-remove-timing");
      if (rmBtn) {
        const row = rmBtn.closest(".notify-timing-row");
        const list = row?.parentElement;
        row?.remove();
        list?.querySelectorAll(".notify-timing-row").forEach((r, i) => {
          r.dataset.idx = i;
          r.querySelectorAll("[data-idx]").forEach(el => el.dataset.idx = i);
        });
        const rawKey = rmBtn.dataset.notifKey;
        if (rawKey) {
          if (rawKey.includes("--ov--")) {
            const [baseKey, , pidRm] = rawKey.split("--ov--");
            this._queueSaveOverride(baseKey, pidRm);
          } else {
            this._queueSaveNotif(rawKey);
          }
        }
      }

      // 変数タグクリック → textarea に挿入
      const tag = e.target.closest(".rf-var-tag");
      if (tag) {
        const notifKey = tag.dataset.notifKey;
        const ta = wrap.querySelector(`textarea.rf-notif-msg[data-notif-key="${notifKey}"]`);
        if (ta) {
          const pos = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, pos) + tag.dataset.var + ta.value.slice(pos);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos + tag.dataset.var.length;
          this._updatePreview(notifKey, wrap);
        }
      }
    });

    // change イベント: rf-toggle / タイミング表示切替 / オーバーライド
    wrap.addEventListener("change", (e) => {
      // rf-toggle: ON/OFF (globalChannel では物件別 enabled オーバーライドとして保存)
      if (e.target.classList.contains("rf-toggle")) {
        const stepKey = e.target.dataset.step;
        const pid = e.target.dataset.pid;
        const card = wrap.querySelector(`.rf-card[data-step="${stepKey}"][data-pid="${pid}"]`);
        if (card) {
          card.classList.toggle("rf-card-enabled", e.target.checked);
          card.classList.toggle("rf-card-disabled", !e.target.checked);
        }
        const step = this.STEPS.find(s => s.key === stepKey);
        // globalChannel の場合は内側 NotifyChannelEditor の enabled トグルへ同期
        if (step && step.globalChannel) {
          const NCE = window.NotifyChannelEditor;
          const idPrefix = `prop_${pid}_${step.globalChannel}`;
          const dk = NCE ? NCE.dataKey(step.globalChannel, idPrefix) : null;
          const innerToggle = dk
            ? card?.querySelector(`input[type="checkbox"][data-field="enabled"][data-key="${CSS.escape(dk)}"]`)
            : null;
          if (innerToggle && innerToggle.checked !== e.target.checked) {
            innerToggle.checked = e.target.checked;
            innerToggle.dispatchEvent(new Event("change", { bubbles: true }));
          }
          // dispatchEvent の後も確実に保存をキューに積む (NCE.onChange 依存を排除)
          this._queueSaveOverride(step.globalChannel, pid);
        } else {
          this._queueSave(pid, stepKey);
        }
        return;
      }

      // 内側 NotifyChannelEditor の enabled トグル → ヘッダートグルへ同期
      if (e.target.matches('input[type="checkbox"][data-field="enabled"]') &&
          !e.target.classList.contains("rf-toggle")) {
        const card = e.target.closest(".rf-card");
        if (card) {
          const headerToggle = card.querySelector(":scope > .rf-card-header .rf-toggle");
          if (headerToggle && headerToggle.checked !== e.target.checked) {
            headerToggle.checked = e.target.checked;
            card.classList.toggle("rf-card-enabled", e.target.checked);
            card.classList.toggle("rf-card-disabled", !e.target.checked);
          }
        }
        // 保存は NotifyChannelEditor.bindCardEvents の onChange に任せる
      }

      // 詳細設定 (detailFields) change: select / checkbox / switch / date / time / number
      if (e.target.classList.contains("rf-detail-input")) {
        this._queueSave(e.target.dataset.pid, e.target.dataset.step);
        return;
      }

      // 物件別オーバーライド チェックボックス (上書きするか)
      if (e.target.classList.contains("rf-ov-check")) {
        const notifKey = e.target.dataset.notifKey;
        const pid = e.target.dataset.pid;
        const field = e.target.dataset.field;
        // bool フィールドは opacity+pe-none、テキスト/タイミングは d-none で制御
        const wrap2 = document.getElementById(`rf-ovwrap-${notifKey}-${pid}-${field}`);
        if (wrap2) {
          if (field === "customMessage") {
            wrap2.classList.toggle("d-none", !e.target.checked);
          } else if (field === "timings") {
            wrap2.classList.toggle("d-none", !e.target.checked);
          } else {
            wrap2.classList.toggle("opacity-50", !e.target.checked);
            wrap2.classList.toggle("pe-none", !e.target.checked);
          }
        }
        this._queueSaveOverride(notifKey, pid);
        return;
      }

      // 物件別オーバーライド 値トグル
      if (e.target.classList.contains("rf-ov-val")) {
        const notifKey = e.target.dataset.notifKey;
        const pid = e.target.dataset.pid;
        this._queueSaveOverride(notifKey, pid);
        return;
      }

      // タイミング行: モード切替
      const rawKey = e.target.dataset.notifKey;
      const idx = e.target.dataset.idx;
      if (rawKey && idx !== undefined) {
        const row = wrap.querySelector(`.notify-timing-row[data-notif-key="${rawKey}"][data-idx="${idx}"]`);
        if (row) {
          if (e.target.classList.contains("rf-mode-radio")) {
            const mode = e.target.value;
            row.querySelector(".rf-mode-event")?.classList.toggle("d-flex", mode === "event");
            row.querySelector(".rf-mode-event")?.classList.toggle("d-none", mode !== "event");
            row.querySelector(".rf-mode-date")?.classList.toggle("d-flex", mode === "date");
            row.querySelector(".rf-mode-date")?.classList.toggle("d-none", mode !== "date");
          }
          if (e.target.classList.contains("rf-timing-select")) {
            const val = e.target.value;
            row.querySelector(".rf-timing-minutes")?.classList.toggle("d-none", val !== "custom");
            row.querySelector(".rf-before-days")?.classList.toggle("d-none", val !== "beforeEvent");
            row.querySelector(".rf-before-suffix")?.classList.toggle("d-none", val !== "beforeEvent");
            row.querySelector(".rf-before-time")?.classList.toggle("d-none", val !== "beforeEvent");
          }
          if (e.target.classList.contains("rf-schedule-pattern")) {
            const val = e.target.value;
            row.querySelector(".rf-schedule-day")?.classList.toggle("d-none", val !== "monthlyDay");
            row.querySelector(".rf-schedule-dow")?.classList.toggle("d-none", val !== "weekly");
          }
        }
        // ovTimingKey (globalNotifKey--ov--pid) の場合はオーバーライド保存
        if (rawKey.includes("--ov--")) {
          const [baseKey, , pid] = rawKey.split("--ov--");
          this._queueSaveOverride(baseKey, pid);
        } else {
          this._queueSaveNotif(rawKey);
        }
      }

      // 送信先チェックボックス (全共通)
      if (e.target.classList.contains("rf-notif-field")) {
        this._queueSaveNotif(e.target.dataset.notifKey);
      }
    });

    // 物件別オーバーライド 全解除ボタン
    wrap.addEventListener("click", (e) => {
      const clearBtn = e.target.closest(".rf-ov-clear");
      if (clearBtn) {
        const notifKey = clearBtn.dataset.notifKey;
        const pid = clearBtn.dataset.pid;
        // 全チェックボックスを外す
        wrap.querySelectorAll(`.rf-ov-check[data-notif-key="${notifKey}"][data-pid="${pid}"]`).forEach(cb => {
          if (cb.checked) {
            cb.checked = false;
            const field = cb.dataset.field;
            const w = document.getElementById(`rf-ovwrap-${notifKey}-${pid}-${field}`);
            if (w) {
              if (field === "customMessage" || field === "timings") {
                w.classList.add("d-none");
              } else {
                w.classList.add("opacity-50", "pe-none");
              }
            }
          }
        });
        this._queueSaveOverride(notifKey, pid);
      }
    });

    // input イベント: textarea/input
    wrap.addEventListener("input", (e) => {
      if (e.target.classList.contains("rf-notif-msg")) {
        this._updatePreview(e.target.dataset.notifKey, wrap);
        this._queueSaveNotif(e.target.dataset.notifKey);
      }
      if (e.target.classList.contains("rf-memo")) {
        this._queueSave(e.target.dataset.pid, e.target.dataset.step);
      }
      // 詳細設定 (detailFields) 入力変更
      if (e.target.classList.contains("rf-detail-input")) {
        this._queueSave(e.target.dataset.pid, e.target.dataset.step);
      }
      // 物件別メッセージ上書きtextarea
      if (e.target.classList.contains("rf-ov-msg-ta")) {
        this._queueSaveOverride(e.target.dataset.notifKey, e.target.dataset.pid);
      }
      // タイミング数値入力
      if (e.target.dataset.notifKey && e.target.dataset.idx !== undefined) {
        const rawKey = e.target.dataset.notifKey;
        if (rawKey.includes("--ov--")) {
          const [baseKey, , pid] = rawKey.split("--ov--");
          this._queueSaveOverride(baseKey, pid);
        } else {
          this._queueSaveNotif(rawKey);
        }
      }
    });
  },

  // _legacy_updatePreview_unused_ (共有コンポーネントが内部処理)
  _legacy_updatePreview_unused_(notifKey, wrap) {
    const ta = wrap.querySelector(`textarea.rf-notif-msg[data-notif-key="${notifKey}"]`);
    const el = wrap.querySelector(`[data-preview="${notifKey}"]`);
    if (!ta || !el) return;
    const varGroup = ta.dataset.varGroup;
    const vars = this.systemVariables[varGroup] || [];
    let msg = ta.value || "";
    vars.forEach(v => {
      msg = msg.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });
    el.textContent = msg;
  },

  // ========== 保存キュー ==========
  _queueSave(pid, stepKey) {
    if (!this._saveTimers) this._saveTimers = {};
    const timerKey = `prop-${pid}`;
    if (this._saveTimers[timerKey]) clearTimeout(this._saveTimers[timerKey]);
    this._showStatus("saving");
    this._saveTimers[timerKey] = setTimeout(() => this._saveProperty(pid), 800);
  },

  _legacy_queueSaveNotif_unused_(notifKey) {
    if (!this._saveTimers) this._saveTimers = {};
    const timerKey = `notif-${notifKey}`;
    if (this._saveTimers[timerKey]) clearTimeout(this._saveTimers[timerKey]);
    this._showStatus("saving");
    this._saveTimers[timerKey] = setTimeout(() => this._legacy_saveNotifChannel_unused_(notifKey), 800);
  },

  _queueSaveOverride(notifKey, pid) {
    if (!this._saveTimers) this._saveTimers = {};
    const timerKey = `override-${notifKey}-${pid}`;
    if (this._saveTimers[timerKey]) clearTimeout(this._saveTimers[timerKey]);
    this._showStatus("saving");
    this._saveTimers[timerKey] = setTimeout(() => this._saveOverride(notifKey, pid), 800);
  },

  // ========== 物件別設定を全共通へ反映 ==========
  async _legacy_pushOverrideToGlobal_unused_(notifKey, pid, wrap) {
    const prop = this.properties.find(p => p.id === pid);
    const ov = (prop?.channelOverrides || {})[notifKey] || {};
    if (!Object.keys(ov).length) {
      showAlert("物件別設定がありません。", "info");
      return;
    }
    const confirmed = await showConfirm(
      `この物件の「${notifKey}」設定を全共通へ反映しますか？\n全物件に影響します。`,
      "全共通に反映"
    );
    if (!confirmed) return;
    try {
      // 物件別設定を全共通に上書き
      const globalEntry = {};
      if (ov.customMessage !== undefined) globalEntry.customMessage = ov.customMessage;
      if (Array.isArray(ov.timings))       globalEntry.timings = ov.timings;
      if (!Object.keys(globalEntry).length) {
        showAlert("反映できる値（customMessage / timings）がありません。", "warning");
        return;
      }
      await db.collection("settings").doc("notifications").set({
        channels: { [notifKey]: globalEntry },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      // ローカルキャッシュ更新
      this.notifChannels[notifKey] = { ...(this.notifChannels[notifKey] || {}), ...globalEntry };
      showAlert("全共通に反映しました。", "success");
    } catch (e) {
      showAlert("反映失敗: " + e.message, "danger");
    }
  },

  // ========== 他物件からインポートモーダル ==========
  _showImportModal(pageType) {
    const targetPid = this._selectedPid;
    const targetProp = this.properties.find(p => p.id === targetPid);
    if (!targetProp) { showAlert("インポート先物件が選択されていません。", "warning"); return; }

    // インポート元候補 (現物件以外)
    const sources = this.properties.filter(p => p.id !== targetPid);
    if (!sources.length) { showAlert("他の物件がありません。", "info"); return; }

    const modalId = "rfImportModal";
    // 既存モーダルを削除
    document.getElementById(modalId)?.remove();

    const optionsHtml = sources.map(p => `
      <div class="form-check">
        <input class="form-check-input" type="radio" name="rfImportSrc" id="rfImportSrc-${p.id}" value="${p.id}">
        <label class="form-check-label" for="rfImportSrc-${p.id}">
          <span class="badge me-1" style="background:${p.color || "#6c757d"}">${p.propertyNumber || "-"}</span>
          ${this._esc(p.name)}
        </label>
      </div>
    `).join("");

    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-box-arrow-in-down"></i> 他物件からインポート</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p class="small text-muted mb-2">コピー元の物件を選択してください。現在の設定は上書きされます。</p>
              <div class="mb-3 border rounded p-2">${optionsHtml}</div>
              <div class="mb-2 fw-semibold small">コピー対象:</div>
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="rfImportChkOverrides" checked>
                <label class="form-check-label small" for="rfImportChkOverrides">channelOverrides (通知の物件別設定)</label>
              </div>
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="rfImportChkFlow">
                <label class="form-check-label small" for="rfImportChkFlow">${pageType === "reservation" ? "reservationFlow (フロー memo)" : "cleaningFlow (フロー memo)"}</label>
              </div>
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="rfImportChkFields">
                <label class="form-check-label small" for="rfImportChkFields">showNoiseAgreement / miniGameEnabled / customFormEnabled</label>
              </div>
              <p class="text-warning small mt-2 mb-0"><i class="bi bi-exclamation-triangle"></i> コピー先「${this._esc(targetProp.name)}」の対象フィールドが上書きされます。</p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary" id="rfImportExecBtn"><i class="bi bi-check-circle"></i> インポート実行</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", html);
    const modal = new bootstrap.Modal(document.getElementById(modalId));
    modal.show();

    document.getElementById("rfImportExecBtn").addEventListener("click", async () => {
      const srcId = document.querySelector(`input[name="rfImportSrc"]:checked`)?.value;
      if (!srcId) { showAlert("コピー元物件を選択してください。", "warning"); return; }

      const copyOverrides = document.getElementById("rfImportChkOverrides")?.checked;
      const copyFlow      = document.getElementById("rfImportChkFlow")?.checked;
      const copyFields    = document.getElementById("rfImportChkFields")?.checked;

      try {
        // コピー元ドキュメント取得
        const srcDoc = await db.collection("properties").doc(srcId).get();
        if (!srcDoc.exists) { showAlert("コピー元物件が見つかりません。", "danger"); return; }
        const srcData = srcDoc.data();
        const updatePayload = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };

        if (copyOverrides && srcData.channelOverrides) {
          updatePayload.channelOverrides = srcData.channelOverrides;
        }
        if (copyFlow) {
          const flowKey = pageType === "reservation" ? "reservationFlow" : "cleaningFlow";
          if (srcData[flowKey]) updatePayload[flowKey] = srcData[flowKey];
        }
        if (copyFields) {
          if (srcData.showNoiseAgreement !== undefined) updatePayload.showNoiseAgreement = srcData.showNoiseAgreement;
          if (srcData.miniGameEnabled    !== undefined) updatePayload.miniGameEnabled    = srcData.miniGameEnabled;
          if (srcData.customFormEnabled  !== undefined) updatePayload.customFormEnabled  = srcData.customFormEnabled;
        }

        await db.collection("properties").doc(targetPid).set(updatePayload, { merge: true });

        // ローカルキャッシュ更新
        const prop = this.properties.find(p => p.id === targetPid);
        if (prop) Object.assign(prop, updatePayload);

        modal.hide();
        // 画面再描画
        this._renderSwimLane();
        showAlert("インポートが完了しました。", "success");
      } catch (e) {
        showAlert("インポート失敗: " + e.message, "danger");
      }
    });

    document.getElementById(modalId).addEventListener("hidden.bs.modal", () => {
      document.getElementById(modalId)?.remove();
    });
  },

  // ========== 保存: 物件ドキュメント ==========
  async _saveProperty(pid) {
    const wrap = document.getElementById("rfSwimLane");
    if (!wrap) return;

    const reservationFlow = {};
    const propertyFields = {};

    // ドット記法で propertyFields にネスト値をセット
    const setNested = (obj, path, value) => {
      const parts = path.split(".");
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    };

    this.STEPS.forEach(step => {
      const toggleEl = wrap.querySelector(`.rf-toggle[data-step="${step.key}"][data-pid="${pid}"]`);
      const memoEl   = wrap.querySelector(`.rf-memo[data-step="${step.key}"][data-pid="${pid}"]`);
      const enabled  = toggleEl ? !!toggleEl.checked : true;
      const memo     = memoEl   ? (memoEl.value || "") : "";

      if (step.propertyField) {
        // ドット記法対応: "inspection.enabled" → inspection オブジェクトに merge
        setNested(propertyFields, step.propertyField, enabled);
        reservationFlow[step.key] = { memo };
      } else if (step.globalChannel) {
        // ON/OFFは globalChannel 側で保存するため、ここではメモのみ
        reservationFlow[step.key] = { memo };
      } else {
        reservationFlow[step.key] = { enabled, memo };
      }

      // detailFields の値を収集
      if (Array.isArray(step.detailFields)) {
        step.detailFields.forEach(fd => {
          const el = wrap.querySelector(
            `.rf-detail-input[data-step="${step.key}"][data-pid="${pid}"][data-field="${fd.field}"]`
          );
          if (!el) return;
          let val;
          if (fd.type === "switch" || fd.type === "checkbox") {
            val = !!el.checked;
          } else if (fd.type === "number") {
            const n = parseInt(el.value, 10);
            val = Number.isFinite(n) ? n : (fd.default ?? null);
          } else {
            val = el.value || "";
          }
          setNested(propertyFields, fd.field, val);
        });
      }
    });

    try {
      await db.collection("properties").doc(pid).set({
        ...propertyFields,
        reservationFlow,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // 注: 以前ここで settings/notifications へグローバル同期していたが、
      // 「最後に保存した物件のテンプレが他物件に上書きされる」問題があったため廃止。
      // フロー画面は物件別保存のみに限定し、各物件は独立したテンプレを持つ。
      // 通知設定タブは物件未設定時のフォールバック用 (グローバル既定値) として残す。

      // ローカルキャッシュ更新
      const prop = this.properties.find(p => p.id === pid);
      if (prop) {
        prop.reservationFlow = reservationFlow;
        Object.assign(prop, propertyFields);
      }
      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
    }
  },

  // ========== 保存: 物件別オーバーライド (properties/{pid}.channelOverrides.{notifKey}) ==========
  async _saveOverride(notifKey, pid) {
    const wrap = document.getElementById("rfSwimLane");
    if (!wrap) { this._showStatus("error", "UI要素が見つかりません"); return; }
    const NCE = window.NotifyChannelEditor;
    if (!NCE) { this._showStatus("error", "NotifyChannelEditor が未ロード"); return; }
    const idPrefix = `prop_${pid}_${notifKey}`;
    const block = wrap.querySelector(`.rf-shared-notify[data-pid="${pid}"][data-notif-key="${notifKey}"]`);
    if (!block) {
      // ブロックが見つからない場合: enabled フラグだけ enabled 判定から読んで最小保存
      console.warn(`[rf _saveOverride] block not found for ${notifKey} / ${pid} — enabled-only fallback`);
      const prop = this.properties.find(p => p.id === pid);
      const step = this.STEPS.find(s => s.globalChannel === notifKey);
      const enabled = step ? this._isEnabled(prop, step) : undefined;
      try {
        const patch = {};
        if (enabled !== undefined) patch[`channelOverrides.${notifKey}.enabled`] = enabled;
        patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection("properties").doc(pid).update(patch);
        this._showStatus("saved");
      } catch (e) {
        this._showStatus("error", e.message);
      }
      return;
    }
    const overrideEntry = NCE.readChannelValue(block, notifKey, { idPrefix });
    try {
      await db.collection("properties").doc(pid).update({
        [`channelOverrides.${notifKey}`]: overrideEntry,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      const prop = this.properties.find(p => p.id === pid);
      if (prop) {
        if (!prop.channelOverrides) prop.channelOverrides = {};
        prop.channelOverrides[notifKey] = overrideEntry;
      }
      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
      console.error("[rf saveOverride] エラー:", e);
    }
  },

  // _legacy_saveOverride_unused_ (旧 rf-ov-* 直接読取り版)
  async _legacy_saveOverride_unused_(notifKey, pid) {
    const wrap = document.getElementById("rfSwimLane");
    if (!wrap) return;

    const overrideEntry = {};

    // ---- ブール型フィールド ----
    for (const field of ["enabled", "ownerLine", "groupLine", "staffLine", "ownerEmail"]) {
      const checkEl = wrap.querySelector(`.rf-ov-check[data-notif-key="${notifKey}"][data-pid="${pid}"][data-field="${field}"]`);
      const valEl   = wrap.querySelector(`.rf-ov-val[data-notif-key="${notifKey}"][data-pid="${pid}"][data-field="${field}"]`);
      if (checkEl && checkEl.checked && valEl) {
        overrideEntry[field] = !!valEl.checked;
      }
    }

    // ---- customMessage オーバーライド ----
    const msgCheck = wrap.querySelector(`.rf-ov-check[data-notif-key="${notifKey}"][data-pid="${pid}"][data-field="customMessage"]`);
    const msgTa    = wrap.querySelector(`.rf-ov-msg-ta[data-notif-key="${notifKey}"][data-pid="${pid}"]`);
    if (msgCheck && msgCheck.checked && msgTa) {
      overrideEntry.customMessage = msgTa.value;
    }

    // ---- timings オーバーライド ----
    const tmCheck = wrap.querySelector(`.rf-ov-check[data-notif-key="${notifKey}"][data-pid="${pid}"][data-field="timings"]`);
    if (tmCheck && tmCheck.checked) {
      const ovTimingKey = `${notifKey}--ov--${pid}`;
      const tmContainer = wrap.querySelector(`.rf-ov-timings[data-notif-key="${notifKey}"][data-pid="${pid}"]`);
      const timings = [];
      if (tmContainer) {
        tmContainer.querySelectorAll(".notify-timing-row").forEach((row) => {
          const modeChecked = row.querySelector("input.rf-mode-radio:checked");
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
      }
      overrideEntry.timings = timings;
    }

    try {
      // channelOverrides.{notifKey} に上書き (merge)
      // 全フィールド未チェックの場合は FieldValue.delete() でキーを削除
      const hasAny = Object.keys(overrideEntry).length > 0;
      const updateData = hasAny
        ? { [`channelOverrides.${notifKey}`]: overrideEntry }
        : { [`channelOverrides.${notifKey}`]: firebase.firestore.FieldValue.delete() };

      await db.collection("properties").doc(pid).update({
        ...updateData,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      // ローカルキャッシュ更新
      const prop = this.properties.find(p => p.id === pid);
      if (prop) {
        if (!prop.channelOverrides) prop.channelOverrides = {};
        if (hasAny) {
          prop.channelOverrides[notifKey] = overrideEntry;
        } else {
          delete prop.channelOverrides[notifKey];
        }
      }

      // バッジ更新
      const badge = wrap.querySelector(`.rf-override-badge[data-step="${this.STEPS.find(s => s.globalChannel === notifKey)?.key}"][data-pid="${pid}"]`);
      if (badge) {
        if (hasAny) {
          badge.className = "badge bg-danger-subtle text-danger border border-danger-subtle ms-1 rf-sync-badge rf-override-badge";
          badge.innerHTML = `<i class="bi bi-shuffle"></i> 物件別`;
          badge.title = "この物件は個別設定で上書き中";
        } else {
          badge.className = "badge bg-secondary-subtle text-secondary border border-secondary-subtle ms-1 rf-sync-badge rf-override-badge";
          badge.innerHTML = `<i class="bi bi-dash-circle"></i> 未設定`;
          badge.title = `この物件はまだ通知設定が空です。送信されません。`;
        }
      }

      // 全解除ボタンの表示/非表示
      const clearBtn = wrap.querySelector(`.rf-ov-clear[data-notif-key="${notifKey}"][data-pid="${pid}"]`);
      if (clearBtn) {
        clearBtn.style.display = hasAny ? "" : "none";
      } else if (hasAny) {
        // ボタンが無ければパネルヘッダに追加
        const panelHeader = wrap.querySelector(`.rf-override-panel[data-notif-key="${notifKey}"][data-pid="${pid}"] .d-flex`);
        if (panelHeader && !panelHeader.querySelector(".rf-ov-clear")) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-sm btn-outline-secondary py-0 px-2 rf-ov-clear";
          btn.dataset.notifKey = notifKey;
          btn.dataset.pid = pid;
          btn.style.fontSize = "0.72rem";
          btn.title = "全フィールドの上書きを解除";
          btn.innerHTML = `<i class="bi bi-x-circle"></i> 全解除`;
          panelHeader.appendChild(btn);
        }
      }

      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
      console.error("[saveOverride] エラー:", e);
    }
  },

  // ========== 保存: globalChannel (settings/notifications.channels.{key}) ==========
  async _legacy_saveNotifChannel_unused_(notifKey) {
    const wrap = document.getElementById("rfSwimLane");
    if (!wrap) return;

    const editor = wrap.querySelector(`.rf-notif-editor[data-notif-key="${notifKey}"]`);
    if (!editor) return;

    const get = (field) => {
      const el = editor.querySelector(`[data-notif-key="${notifKey}"][data-field="${field}"]`);
      return el ? !!el.checked : false;
    };
    const ta = editor.querySelector(`textarea.rf-notif-msg[data-notif-key="${notifKey}"]`);

    // タイミング収集
    const timingRows = editor.querySelectorAll(`.rf-notif-timings[data-notif-key="${notifKey}"] .notify-timing-row`);
    const timings = [];
    timingRows.forEach((row) => {
      const modeChecked = row.querySelector(`input.rf-mode-radio:checked`);
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

    // enabled はトグルから取得
    const toggleEl = wrap.querySelector(`.rf-toggle[data-step="${this.STEPS.find(s => s.globalChannel === notifKey)?.key}"]`);
    const enabled = toggleEl ? !!toggleEl.checked : true;

    const entry = {
      enabled,
      ownerLine:      get("ownerLine"),
      groupLine:      get("groupLine"),
      staffLine:      get("staffLine"),
      ownerEmail:     get("ownerEmail"),
      discordOwner:   get("discordOwner"),
      discordSubOwner: get("discordSubOwner"),
      customMessage:  ta ? ta.value : "",
      timings,
    };

    // 後方互換: 代表値
    if (timings[0]) {
      const t0 = timings[0];
      if (t0.timing)            entry.timing          = t0.timing;
      if (t0.mode)              entry.mode            = t0.mode;
      if (t0.timingMinutes !== undefined) entry.timingMinutes = t0.timingMinutes;
      if (t0.beforeDays    !== undefined) entry.beforeDays    = t0.beforeDays;
      if (t0.beforeTime)        entry.beforeTime      = t0.beforeTime;
      if (t0.schedulePattern)   entry.schedulePattern = t0.schedulePattern;
      if (t0.scheduleDay   !== undefined) entry.scheduleDay   = t0.scheduleDay;
      if (t0.scheduleDow   !== undefined) entry.scheduleDow   = t0.scheduleDow;
      if (t0.scheduleTime)      entry.scheduleTime    = t0.scheduleTime;
    }

    try {
      await db.collection("settings").doc("notifications").set({
        channels: { [notifKey]: entry },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // ローカルキャッシュ更新
      this.notifChannels[notifKey] = { ...(this.notifChannels[notifKey] || {}), ...entry };

      // 同一 notifKey を持つ他の物件表示のトグルを同期
      document.querySelectorAll(`.rf-toggle[data-step="${this.STEPS.find(s => s.globalChannel === notifKey)?.key}"]`).forEach(el => {
        if (el !== toggleEl) {
          el.checked = enabled;
          const card = el.closest(".rf-card");
          if (card) {
            card.classList.toggle("rf-card-enabled", enabled);
            card.classList.toggle("rf-card-disabled", !enabled);
          }
        }
      });

      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
    }
  },

  // ========== ステータス表示 ==========
  // 画面右上の固定インジケーター + ヘッダー内のインライン表示を同時更新
  _showStatus(kind, msg) {
    // ① ヘッダー内インライン表示 (既存)
    const el = document.getElementById("rfSaveStatus");
    // ② 固定インジケーター (常時表示エリア)
    const indicator = this._getOrCreateSaveIndicator("rf");
    const setText = (html) => {
      if (el) el.innerHTML = html;
      if (indicator) indicator.innerHTML = html;
    };
    if (kind === "saving") {
      setText(`🟡 保存中…`);
    } else if (kind === "saved") {
      setText(`🟢 保存しました`);
      setTimeout(() => {
        if (el && el.innerHTML.includes("保存しました")) el.innerHTML = "";
        if (indicator && indicator.innerHTML.includes("保存しました")) indicator.innerHTML = "";
      }, 3000);
      // 直前のトーストから3秒以内なら抑制
      const now = Date.now();
      if (!this._lastToastAt || now - this._lastToastAt > 3000) {
        this._lastToastAt = now;
        if (typeof showToast === "function") showToast("保存しました", "", "success");
      }
    } else if (kind === "error") {
      setText(`🔴 保存できませんでした: ${this._esc(msg || "")}`);
      if (typeof showToast === "function") showToast("保存できませんでした", msg || "", "error");
    }
  },

  // 固定インジケーター要素を取得または生成
  _getOrCreateSaveIndicator(prefix) {
    const id = `${prefix}-save-indicator`;
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.cssText = "position:fixed;top:10px;right:20px;z-index:9999;background:rgba(255,255,255,0.95);border:1px solid #dee2e6;border-radius:6px;padding:4px 10px;font-size:0.82rem;box-shadow:0 2px 8px rgba(0,0,0,0.12);pointer-events:none;";
      document.body.appendChild(el);
    }
    return el;
  },

  // ========== CSS ==========
  _renderStyles() {
    return `
    <style>
    /* ===== スイムレーン全体 ===== */
    /* overflow-x:auto を親に置くと sticky が壊れるため使用しない。
       min-width で狭い画面でも崩れないようにし、
       ページ全体の横スクロールに委ねる */
    .rf-swimlane-root {
      width: 100%;
      min-width: 600px;
    }
    .rf-swimlane-scroll {
      /* overflow は設定しない (sticky を維持するため) */
    }

    /* 3列グリッド */
    .rf-swimlane-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 0;
    }

    /* 対象物件バー: ナビバー(56px)直下に sticky 固定 */
    .rf-property-bar {
      position: sticky;
      top: 56px;
      z-index: 11;
      background: #fff;
      padding: 6px 0 6px;
      border-bottom: 1px solid #e2e8f0;
    }

    /* ヘッダー行: 物件バー(56px+48px=104px)直下に sticky 固定 */
    .rf-swimlane-header {
      position: sticky;
      top: 104px; /* ナビバー56px + 物件バー約48px */
      z-index: 10;
      background: #fff; /* sticky 下に内容が透けないよう */
    }
    .rf-lane-header {
      padding: 8px 12px;
      font-weight: 700;
      font-size: 0.9rem;
      text-align: center;
      border: 1px solid #dee2e6;
    }
    .rf-lane-header.rf-lane-guest  { background: #dbeafe; color: #1d4ed8; border-color: #93c5fd; }
    .rf-lane-header.rf-lane-owner  { background: #dcfce7; color: #166534; border-color: #86efac; }
    .rf-lane-header.rf-lane-staff  { background: #ffedd5; color: #9a3412; border-color: #fdba74; }

    /* Phase区切り: 3列横断 */
    .rf-phase-divider {
      grid-column: 1 / -1;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-left: 4px solid #64748b;
      padding: 6px 14px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #475569;
      margin: 4px 0;
    }
    .rf-branch-divider {
      background: #fef9c3;
      border-color: #fcd34d;
      border-left-color: #f59e0b;
      color: #92400e;
    }

    /* トラックラベル */
    .rf-track-label {
      grid-column: 1 / -1;
      padding: 4px 12px;
    }
    .rf-track-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .rf-track-guest { background: #bfdbfe; color: #1e40af; }
    .rf-track-staff { background: #fed7aa; color: #7c2d12; }

    /* セル */
    .rf-lane-cell {
      padding: 4px 6px;
      min-height: 36px;
      border-right: 1px dashed #e2e8f0;
    }
    .rf-cell-empty { background: #fafafa; }
    .rf-cell-active { background: transparent; }

    /* ステップ行 */
    .rf-step-row { align-items: start; }

    /* 矢印行 */
    .rf-arrow-row {
      height: 20px;
    }
    .rf-arrow-row .rf-lane-cell {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
    }
    .rf-arrow-badge {
      font-size: 0.7rem;
      padding: 1px 6px;
      border-radius: 10px;
    }
    .rf-arrow-guest  { background: #bfdbfe; color: #1e40af; }
    .rf-arrow-owner  { background: #bbf7d0; color: #14532d; }
    .rf-arrow-staff  { background: #fed7aa; color: #7c2d12; }

    /* カード */
    .rf-card {
      border-radius: 8px;
      border: 1px solid #dee2e6;
      background: #fff;
      margin: 3px 2px;
      font-size: 0.82rem;
      transition: box-shadow 0.15s;
    }
    .rf-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .rf-card-enabled { border-color: #94a3b8; }
    .rf-card-disabled { opacity: 0.45; background: #f8fafc; }

    .rf-card-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 10px;
      flex-wrap: nowrap; /* 折り返し禁止 */
      min-width: 0;      /* flex child の縮小を許可 */
    }
    .rf-card-icon { font-size: 1rem; color: #3b82f6; flex-shrink: 0; }
    .rf-card-title {
      font-weight: 600;
      font-size: 0.8rem;
      flex: 1 1 auto;
      min-width: 0;          /* overflow を有効にするため必須 */
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* バッジ群は縮小しない */
    .rf-card-header .badge { flex-shrink: 0; }
    .rf-card-header .ms-auto { flex-shrink: 0; }

    .rf-card-body {
      padding: 6px 10px 10px;
      border-top: 1px dashed #e2e8f0;
      background: #f8fafc;
      border-radius: 0 0 8px 8px;
    }
    .rf-chevron { color: #94a3b8; }

    /* 通知エディタ */
    .rf-notif-editor {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 10px;
    }

    /* モバイル対応 */
    @media (max-width: 767px) {
      .rf-swimlane-grid {
        display: block;
      }
      .rf-lane-cell.rf-cell-empty {
        display: none;
      }
      .rf-swimlane-header { display: none; }
      .rf-phase-divider { margin: 6px 0; }

      /* モバイルタブフィルタ */
      .rf-step-row[data-lane] { display: block; }

      /* モバイルではタイトル折り返しOK */
      .rf-card-title {
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
      }
    }

    /* モバイルタブ */
    .rf-lane-tabs .nav-link { font-size: 0.75rem; padding: 4px 6px; }

    /* フォームスイッチ小型化 */
    .rf-card .form-check-input { width: 2rem; height: 1rem; }

    /* 物件選択ボタン */
    .rf-prop-btn { border-radius: 20px; }
    </style>
    `;
  },
};
