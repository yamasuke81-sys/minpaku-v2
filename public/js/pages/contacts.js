/**
 * 連絡先マスタ — メール / LINE / Discord を一元管理
 *
 * データの実体は各ドキュメントに保存される（このタブはUIレイヤーのみで、相互同期問題は起きない）:
 *   - スタッフ: staff/{id} の email / lineUserId / subOwnerEmail / subOwnerLineUserId / subOwnerDiscordWebhookUrl
 *   - Webアプリ管理者: settings/notifications の ownerEmail (or notifyEmails) / lineOwnerUserId / lineGroupId / lineChannelToken / discordOwnerWebhookUrl / discordSubOwnerWebhookUrl
 *   - Gmail OAuth: settings/gmailOAuth/tokens の連携アカウント (読み取りのみ・連携は #/email-verification)
 *   - 物件別 LINE Bot: properties/{id}.lineChannels[] (読み取り+簡易編集、本格編集は物件編集モーダル)
 */

const LINE_CHANNELS_MAX_CONTACTS = 2;

const ContactsPage = {
  staff: [],
  properties: [],
  notifSettings: null,
  gmailTokens: [],

  async render(container) {
    container.innerHTML = `
      <div class="container-fluid py-3">
        <div class="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
          <h1 class="h4 mb-0"><i class="bi bi-person-rolodex me-2"></i>連絡先マスタ</h1>
          <div class="text-muted small">登録済みの LINE / メール / Discord 宛先を一元管理します</div>
        </div>

        <ul class="nav nav-tabs mb-3" id="contactsTabs" role="tablist">
          <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#tab-emails" type="button"><i class="bi bi-envelope"></i> メール</button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-lines" type="button"><i class="bi bi-chat-dots"></i> LINE</button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-discord" type="button"><i class="bi bi-discord"></i> Discord</button></li>
        </ul>

        <div class="tab-content">
          <div class="tab-pane fade show active" id="tab-emails"><div id="emailsArea">読み込み中…</div></div>
          <div class="tab-pane fade" id="tab-lines"><div id="linesArea">読み込み中…</div></div>
          <div class="tab-pane fade" id="tab-discord"><div id="discordArea">読み込み中…</div></div>
        </div>
      </div>
    `;
    await this.loadAll();
    this.renderEmails();
    this.renderLines();
    this.renderDiscord();
    this.bindEvents();
  },

  async loadAll() {
    try {
      const [staffSnap, propSnap, notifDoc, tokensSnap1, tokensSnap2] = await Promise.all([
        db.collection("staff").orderBy("displayOrder", "asc").get(),
        db.collection("properties").get(),
        db.collection("settings").doc("notifications").get(),
        db.collection("settings").doc("gmailOAuth").collection("tokens").get(),
        db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").get(),
      ]);
      this.staff = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.properties = propSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.propertyNumber ?? 999) - (b.propertyNumber ?? 999));
      this.notifSettings = notifDoc.exists ? notifDoc.data() : {};
      // 両コンテキスト統合 (context フィールド付与)
      this.gmailTokens = [
        ...tokensSnap1.docs.map(d => ({ id: d.id, context: "default", ...d.data() })),
        ...tokensSnap2.docs.map(d => ({ id: d.id, context: "emailVerification", ...d.data() })),
      ];
    } catch (e) {
      console.error("[contacts] 読み込み失敗:", e);
      showToast("エラー", "読み込み失敗: " + e.message, "error");
    }
  },

  // ============================================================
  // メールタブ
  // ============================================================
  renderEmails() {
    const linkedSet = new Set(this.gmailTokens.map(t => (t.email || "").toLowerCase()).filter(Boolean));
    const linkedBadge = (mail) => {
      if (!mail) return "";
      return linkedSet.has(mail.toLowerCase())
        ? `<span class="badge bg-success-subtle text-success border ms-1" title="Gmail連携済み"><i class="bi bi-check-circle"></i> 連携済</span>`
        : `<span class="badge bg-secondary-subtle text-secondary border ms-1" title="Gmail未連携">未連携</span>`;
    };

    // Web管理者: notifyEmails[] (複数) を主、最初の1件を ownerEmail として自動同期
    const webAdmin = this.notifSettings || {};
    const notifyEmails = Array.isArray(webAdmin.notifyEmails) ? webAdmin.notifyEmails.filter(Boolean) : [];
    // 旧 ownerEmail を notifyEmails の先頭に取り込む (重複は除去)
    if (webAdmin.ownerEmail && !notifyEmails.includes(webAdmin.ownerEmail)) {
      notifyEmails.unshift(webAdmin.ownerEmail);
    }
    if (notifyEmails.length === 0) notifyEmails.push("");

    const emailRows = notifyEmails.map((mail, idx) => `
      <tr data-email-idx="${idx}">
        <td class="small text-muted" style="width:90px;">
          ${idx === 0 ? '<span class="badge bg-primary">代表</span>' : `<span class="badge bg-secondary">追加 ${idx}</span>`}
        </td>
        <td><input class="form-control form-control-sm c-notify-email-input" data-idx="${idx}" value="${this._esc(mail)}" placeholder="example@gmail.com"></td>
        <td>${linkedBadge(mail)}</td>
        <td>
          ${idx > 0 ? `<button type="button" class="btn btn-sm btn-outline-danger c-notify-email-remove" data-idx="${idx}" title="この行を削除"><i class="bi bi-x-lg"></i></button>` : ""}
        </td>
      </tr>
    `).join("");

    let html = `
      <div class="alert alert-info py-2 small">
        <i class="bi bi-info-circle"></i> ここでの編集は元の場所（スタッフ管理 / 通知設定 / 物件管理）と<strong>相互同期</strong>します。
        <a href="#/email-verification" class="ms-2 text-decoration-none"><i class="bi bi-google"></i> Gmail 連携 →</a>
      </div>

      <h5 class="mt-3"><i class="bi bi-person-gear"></i> Webアプリ管理者の通知メール</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <p class="text-muted small mb-2">先頭のアドレスが「代表メール」として旧コードからも参照されます。複数登録すると同報送信されます。</p>
        <table class="table table-sm align-middle mb-2">
          <thead class="table-light"><tr><th style="width:90px;">区分</th><th>メールアドレス</th><th style="width:90px;">連携</th><th style="width:50px;"></th></tr></thead>
          <tbody id="notifyEmailsRows">${emailRows}</tbody>
        </table>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btnAddNotifyEmail"><i class="bi bi-plus"></i> 追加</button>
          <button type="button" class="btn btn-sm btn-primary ms-auto" id="btnSaveNotifyEmails"><i class="bi bi-check-lg"></i> 一括保存</button>
        </div>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-people"></i> スタッフ / 物件オーナー</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th style="width:140px;">名前</th><th style="width:90px;">区分</th><th>メール (送信元/通知用)</th><th>サブメール (物件オーナー用)</th><th style="width:80px;"></th></tr></thead>
          <tbody>
            ${this.staff.map(s => `
              <tr data-staff-id="${s.id}">
                <td class="small">${this._esc(s.name || "(無名)")}${s.active === false ? ' <span class="badge bg-secondary">無効</span>' : ""}</td>
                <td class="small">
                  ${s.isOwner ? '<span class="badge bg-warning-subtle text-warning border">オーナー</span>' : ""}
                  ${s.isSubOwner ? '<span class="badge bg-info-subtle text-info border">物件オーナー</span>' : ""}
                  ${!s.isOwner && !s.isSubOwner ? '<span class="badge bg-light text-muted border">スタッフ</span>' : ""}
                </td>
                <td>
                  <input class="form-control form-control-sm c-email-input mb-1" data-target="staff" data-staff-id="${s.id}" data-field="email" value="${this._esc(s.email || "")}">
                  ${linkedBadge(s.email)}
                </td>
                <td>
                  ${s.isSubOwner ? `
                    <input class="form-control form-control-sm c-email-input mb-1" data-target="staff" data-staff-id="${s.id}" data-field="subOwnerEmail" value="${this._esc(s.subOwnerEmail || "")}" placeholder="物件オーナー専用メール (任意)">
                    ${linkedBadge(s.subOwnerEmail)}
                  ` : '<span class="text-muted small">—</span>'}
                </td>
                <td><button class="btn btn-sm btn-primary c-save-row-btn" data-target="staff" data-staff-id="${s.id}">保存</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-google"></i> 連携済み Gmail (送信元として利用可能)</h5>
      <div class="card mb-3"><div class="card-body p-2">
        ${this.gmailTokens.length === 0
          ? '<div class="text-muted small">連携アカウントなし。<a href="#/email-verification">メール照合タブ</a>から Gmail 連携を追加できます。</div>'
          : `<table class="table table-sm mb-0 align-middle">
              <thead class="table-light"><tr><th>Gmail アドレス</th><th style="width:140px;">用途</th><th style="width:120px;">最終更新</th><th style="width:90px;">操作</th></tr></thead>
              <tbody>${this.gmailTokens.map(t => {
                const ctxLabel = t.context === "emailVerification"
                  ? '<span class="badge bg-info-subtle text-info border">メール照合用</span>'
                  : '<span class="badge bg-warning-subtle text-warning border">税理士資料用</span>';
                return `<tr>
                  <td><code>${this._esc(t.email || "(不明)")}</code> ${t.refreshToken ? '<span class="badge bg-success-subtle text-success border ms-1" title="リフレッシュトークン有効">有効</span>' : '<span class="badge bg-danger-subtle text-danger border ms-1">無効</span>'}</td>
                  <td>${ctxLabel}</td>
                  <td class="small text-muted">${this._fmtDate(t.savedAt || t.updatedAt)}</td>
                  <td><button class="btn btn-sm btn-outline-danger c-token-delete-btn" data-token-id="${this._esc(t.id)}" data-context="${this._esc(t.context)}" data-email="${this._esc(t.email || "")}"><i class="bi bi-x-circle"></i> 解除</button></td>
                </tr>`;
              }).join("")}</tbody>
            </table>`}
        <div class="mt-2 small"><a href="#/email-verification"><i class="bi bi-plus-circle"></i> Gmail 連携を追加</a></div>
      </div></div>
    `;

    document.getElementById("emailsArea").innerHTML = html;
  },

  // ============================================================
  // LINEタブ
  // ============================================================
  renderLines() {
    const s = this.notifSettings || {};
    const tokenSet = !!s.lineChannelToken;
    const ownerChannels = Array.isArray(s.ownerLineChannels) ? s.ownerLineChannels : [];

    const channelRows = ownerChannels.map((c, idx) => `
      <tr data-ch-idx="${idx}">
        <td><input class="form-control form-control-sm c-owner-ch-input" data-idx="${idx}" data-field="name" value="${this._esc(c?.name || "")}" placeholder="例: 清掃G通知"></td>
        <td>
          <div class="d-flex gap-1">
            <input class="form-control form-control-sm c-owner-ch-input" data-idx="${idx}" data-field="token" value="${this._esc(c?.token || "")}" placeholder="チャネルアクセストークン" type="password">
            <button type="button" class="btn btn-sm btn-outline-info c-owner-ch-verify" data-idx="${idx}" title="トークン検証"><i class="bi bi-shield-check"></i></button>
          </div>
          <div class="small text-muted owner-ch-verify-result" data-idx="${idx}"></div>
        </td>
        <td>
          <div class="d-flex gap-1">
            <input class="form-control form-control-sm c-owner-ch-input" data-idx="${idx}" data-field="userId" value="${this._esc(c?.userId || "")}" placeholder="Uxxxxxxxx (任意)">
            <button type="button" class="btn btn-sm btn-outline-info c-owner-ch-lookup-user" data-idx="${idx}" title="アカウント名取得"><i class="bi bi-search"></i></button>
          </div>
          <div class="small text-muted owner-ch-user-result" data-idx="${idx}"></div>
        </td>
        <td><button type="button" class="btn btn-sm btn-outline-danger c-owner-ch-remove" data-idx="${idx}" title="削除"><i class="bi bi-x-lg"></i></button></td>
      </tr>
    `).join("");

    let html = `
      <div class="alert alert-info py-2 small">
        <i class="bi bi-info-circle"></i> 物件別グループLINE は物件ごとに複数 Bot を登録可能です（物件編集→LINE連携）。
      </div>

      <details class="mb-3">
        <summary class="text-primary small" style="cursor:pointer;"><i class="bi bi-question-circle"></i> どの設定が何の通知に使われるか (用途マッピング)</summary>
        <div class="card mt-2"><div class="card-body p-2">
          <table class="table table-sm align-middle mb-0" style="font-size:12px;">
            <thead class="table-light">
              <tr><th style="width:30%;">設定欄</th><th style="width:35%;">使われる通知</th><th>備考</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>メイン Bot トークン</strong></td><td>管理者個人 LINE / スタッフ個人 LINE / 物件未指定の通知</td><td>大半の通知の送信元</td></tr>
              <tr><td><strong>管理者 LINE User ID</strong></td><td>notifyOwner (管理者宛 LINE)</td><td>メイン Bot から送信</td></tr>
              <tr><td><strong>グループ LINE ID (フォールバック)</strong></td><td>物件別 Bot 未設定時の通知の送信先</td><td>メイン Bot から送信</td></tr>
              <tr><td><strong>追加 Bot (複数チャネル)</strong></td><td>同じ管理者宛に別 Bot からも通知 (上級設定)</td><td>普段は空のまま</td></tr>
              <tr><td><strong>スタッフ用 lineUserId</strong></td><td>そのスタッフ個人宛 LINE (シフト確定など)</td><td>メイン Bot から送信</td></tr>
              <tr><td><strong>物件オーナー用 subOwnerLineUserId</strong></td><td>物件オーナー個人宛 LINE</td><td>物件別 Bot 優先、なければメイン Bot</td></tr>
              <tr><td><strong>物件別 LINE Bot</strong></td><td>その物件のグループ LINE 通知</td><td>各物件ごとに独立した Bot</td></tr>
              <tr><td><strong>管理者通知メール (notifyEmails)</strong></td><td>管理者宛通知のメール同報</td><td>先頭が代表 (ownerEmail)</td></tr>
              <tr><td><strong>スタッフ用 email</strong></td><td>スタッフ個人宛通知のメール</td><td>—</td></tr>
              <tr><td><strong>物件オーナー用 subOwnerEmail</strong></td><td>物件オーナー個人宛通知のメール</td><td>—</td></tr>
              <tr><td><strong>管理者 Discord Webhook</strong></td><td>管理者宛 Discord 通知</td><td>—</td></tr>
              <tr><td><strong>物件オーナー個別 Discord</strong></td><td>その物件オーナー宛 Discord 通知</td><td>—</td></tr>
            </tbody>
          </table>
          <p class="text-muted small mb-0 mt-1">通知ごとの ON/OFF や宛先指定は <a href="#/cleaning-flow">清掃フロー構成</a> / <a href="#/reservation-flow">予約フロー構成</a> の各通知行で変更します。</p>
        </div></div>
      </details>

      <h5 class="mt-3"><i class="bi bi-person-gear"></i> Webアプリ管理者 LINE (メイン Bot)</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <p class="text-muted small mb-2">主に管理者向け通知 (notifyOwner) で使うチャネル。検証ボタンで LINE API に問い合わせて Bot 名を取得します。</p>
        <table class="table table-sm align-middle mb-0">
          <tbody>
            <tr>
              <td class="small" style="width:200px;">チャネルアクセストークン</td>
              <td>
                <div class="d-flex gap-2">
                  <input class="form-control form-control-sm" id="lineMainToken" type="password" value="${this._esc(s.lineChannelToken || "")}" placeholder="${tokenSet ? "(設定済 — 上書きする場合のみ入力)" : "Long-lived channel access token"}">
                  <button type="button" class="btn btn-sm btn-outline-info" id="btnVerifyMainToken"><i class="bi bi-shield-check"></i> 検証</button>
                  <button type="button" class="btn btn-sm btn-primary" id="btnSaveMainToken"><i class="bi bi-check-lg"></i> 保存</button>
                </div>
                <div class="small mt-1" id="lineMainTokenResult"></div>
              </td>
            </tr>
            <tr>
              <td class="small">Webアプリ管理者 LINE User ID</td>
              <td>
                <div class="d-flex gap-2">
                  <input class="form-control form-control-sm c-line-input" id="lineOwnerUserIdInput" data-target="settings" data-field="lineOwnerUserId" value="${this._esc(s.lineOwnerUserId || "")}" placeholder="Uxxxxxxxxxx...">
                  <button type="button" class="btn btn-sm btn-outline-info c-line-lookup-btn" data-input="lineOwnerUserIdInput" data-result="lineOwnerUserIdResult" data-type="user" title="アカウント名取得"><i class="bi bi-search"></i></button>
                  <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="lineOwnerUserId">保存</button>
                </div>
                <div class="small mt-1" id="lineOwnerUserIdResult"></div>
              </td>
            </tr>
            <tr>
              <td class="small">グループ LINE ID (物件未指定時のフォールバック)</td>
              <td>
                <div class="d-flex gap-2">
                  <input class="form-control form-control-sm c-line-input" id="lineGroupIdInput" data-target="settings" data-field="lineGroupId" value="${this._esc(s.lineGroupId || "")}" placeholder="Cxxxxxxxxxx...">
                  <button type="button" class="btn btn-sm btn-outline-info c-line-lookup-btn" data-input="lineGroupIdInput" data-result="lineGroupIdResult" data-type="group" title="グループ名取得"><i class="bi bi-search"></i></button>
                  <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="lineGroupId">保存</button>
                </div>
                <div class="small mt-1" id="lineGroupIdResult"></div>
              </td>
            </tr>
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-collection"></i> 追加 Bot (複数チャネル)</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <p class="text-muted small mb-2">同じ管理者宛に異なる Bot からも通知したい場合に追加します。</p>
        <table class="table table-sm align-middle mb-2">
          <thead class="table-light"><tr><th style="width:160px;">Bot 名</th><th>チャネルアクセストークン</th><th style="width:200px;">送信先 User ID (任意)</th><th style="width:50px;"></th></tr></thead>
          <tbody id="ownerLineChannelsRows">${channelRows}</tbody>
        </table>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btnAddOwnerLineChannel"><i class="bi bi-plus"></i> 追加 Bot を追加</button>
          <button type="button" class="btn btn-sm btn-primary ms-auto" id="btnSaveOwnerLineChannels"><i class="bi bi-check-lg"></i> 一括保存</button>
        </div>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-people"></i> スタッフ / 物件オーナーの LINE User ID</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th style="width:140px;">名前</th><th>スタッフ用 lineUserId</th><th>物件オーナー用 subOwnerLineUserId</th><th style="width:80px;"></th></tr></thead>
          <tbody>
            ${this.staff.map(staff => `
              <tr data-staff-id="${staff.id}">
                <td class="small">${this._esc(staff.name || "(無名)")}</td>
                <td>
                  <div class="d-flex gap-1">
                    <input class="form-control form-control-sm c-line-input" id="staffLine_${staff.id}" data-target="staff" data-staff-id="${staff.id}" data-field="lineUserId" value="${this._esc(staff.lineUserId || "")}" placeholder="Uxxxxxxxxxx...">
                    <button type="button" class="btn btn-sm btn-outline-info c-staff-line-lookup" data-input="staffLine_${staff.id}" data-result="staffLineRes_${staff.id}" title="アカウント名取得"><i class="bi bi-search"></i></button>
                  </div>
                  <div class="small mt-1" id="staffLineRes_${staff.id}"></div>
                </td>
                <td>
                  ${staff.isSubOwner ? `
                    <div class="d-flex gap-1">
                      <input class="form-control form-control-sm c-line-input" id="subOwnLine_${staff.id}" data-target="staff" data-staff-id="${staff.id}" data-field="subOwnerLineUserId" value="${this._esc(staff.subOwnerLineUserId || "")}" placeholder="Uxxxxxxxxxx...">
                      <button type="button" class="btn btn-sm btn-outline-info c-staff-line-lookup" data-input="subOwnLine_${staff.id}" data-result="subOwnLineRes_${staff.id}" title="アカウント名取得"><i class="bi bi-search"></i></button>
                    </div>
                    <div class="small mt-1" id="subOwnLineRes_${staff.id}"></div>
                  ` : '<span class="text-muted small">—</span>'}
                </td>
                <td><button class="btn btn-sm btn-primary c-save-row-btn" data-target="staff" data-staff-id="${staff.id}">保存</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-buildings"></i> 物件別 LINE Bot (グループLINE 送信元)</h5>
      <p class="text-muted small mb-2">この画面の編集は物件編集 (LINE 連携) と同期します。各 Bot は最大 ${LINE_CHANNELS_MAX_CONTACTS} 件まで登録可能。民泊物件のみ表示。</p>
      ${(() => {
        const minpaku = this.properties.filter(p => p.type === "minpaku");
        return `<div class="card mb-3"><div class="card-body p-2">
        ${minpaku.length === 0
          ? '<div class="text-muted small">民泊物件なし</div>'
          : minpaku.map(p => {
              const channels = Array.isArray(p.lineChannels) ? p.lineChannels : [];
              const collapseId = `prop-line-${p.id}`;
              return `
                <div class="border rounded mb-2" data-prop-id="${p.id}">
                  <div class="d-flex align-items-center px-2 py-2 prop-line-header" style="cursor:pointer;" data-bs-toggle="collapse" data-bs-target="#${collapseId}">
                    <i class="bi bi-chevron-down me-2"></i>
                    <strong class="small">${this._esc(p.name || "(無名)")}</strong>
                    <span class="badge bg-secondary ms-2">${channels.length} Bot</span>
                    <span class="ms-2 small text-muted">${channels.map(c => this._esc(c.name || "(無名)")).join(" / ")}</span>
                  </div>
                  <div class="collapse" id="${collapseId}">
                    <div class="px-2 pb-2 border-top pt-2 prop-line-body" data-prop-id="${p.id}">
                      ${this._renderPropLineChannels(p.id, channels)}
                    </div>
                  </div>
                </div>`;
            }).join("")}
      </div></div>`;
      })()}
    `;
    document.getElementById("linesArea").innerHTML = html;
  },

  /** 物件別 LINE channels の編集行 HTML */
  _renderPropLineChannels(propId, channels) {
    const rows = (channels.length ? channels : []).map((c, i) => `
      <tr data-ch-idx="${i}">
        <td><input class="form-control form-control-sm c-prop-ch-input" data-prop-id="${propId}" data-idx="${i}" data-field="name" value="${this._esc(c?.name || "")}" placeholder="例: 長浜清掃G通知"></td>
        <td>
          <div class="d-flex gap-1">
            <input class="form-control form-control-sm c-prop-ch-input" data-prop-id="${propId}" data-idx="${i}" data-field="token" value="${this._esc(c?.token || "")}" placeholder="チャネルアクセストークン" type="password">
            <button type="button" class="btn btn-sm btn-outline-info c-prop-ch-verify-token" data-prop-id="${propId}" data-idx="${i}" title="トークン検証"><i class="bi bi-shield-check"></i></button>
          </div>
          <div class="small text-muted prop-ch-token-result" data-prop-id="${propId}" data-idx="${i}"></div>
        </td>
        <td>
          <div class="d-flex gap-1">
            <input class="form-control form-control-sm c-prop-ch-input" data-prop-id="${propId}" data-idx="${i}" data-field="groupId" value="${this._esc(c?.groupId || "")}" placeholder="Cxxxxxxxx (グループ ID)">
            <button type="button" class="btn btn-sm btn-outline-info c-prop-ch-lookup-group" data-prop-id="${propId}" data-idx="${i}" title="グループ名取得"><i class="bi bi-search"></i></button>
          </div>
          <div class="small text-muted prop-ch-group-result" data-prop-id="${propId}" data-idx="${i}"></div>
        </td>
        <td><button type="button" class="btn btn-sm btn-outline-danger c-prop-ch-remove" data-prop-id="${propId}" data-idx="${i}"><i class="bi bi-x-lg"></i></button></td>
      </tr>
    `).join("");
    return `
      <table class="table table-sm align-middle mb-2">
        <thead class="table-light"><tr><th style="width:140px;">Bot 名</th><th>チャネルアクセストークン</th><th>グループ ID</th><th style="width:50px;"></th></tr></thead>
        <tbody class="prop-ch-rows" data-prop-id="${propId}">${rows || `<tr><td colspan="4" class="text-muted small">未登録</td></tr>`}</tbody>
      </table>
      <div class="d-flex gap-2">
        <button type="button" class="btn btn-sm btn-outline-secondary c-prop-ch-add" data-prop-id="${propId}"><i class="bi bi-plus"></i> Bot 追加</button>
        <button type="button" class="btn btn-sm btn-primary ms-auto c-prop-ch-save" data-prop-id="${propId}"><i class="bi bi-check-lg"></i> この物件を保存</button>
      </div>
    `;
  },

  // ============================================================
  // Discordタブ
  // ============================================================
  renderDiscord() {
    const s = this.notifSettings || {};
    let html = `
      <div class="alert alert-info py-2 small">
        <i class="bi bi-info-circle"></i> Discord は Webhook URL を設定するだけで通知できます。
      </div>

      <h5 class="mt-3"><i class="bi bi-person-gear"></i> Webアプリ管理者 Discord</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <tbody>
            <tr>
              <td class="small" style="width:200px;">Webhook URL (Webアプリ管理者宛)</td>
              <td><div class="d-flex gap-2">
                <input class="form-control form-control-sm c-discord-input" data-target="settings" data-field="discordOwnerWebhookUrl" value="${this._esc(s.discordOwnerWebhookUrl || "")}" placeholder="https://discord.com/api/webhooks/...">
                <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="discordOwnerWebhookUrl">保存</button>
              </div></td>
            </tr>
            <tr>
              <td class="small">Webhook URL (物件オーナー全体宛・フォールバック)</td>
              <td><div class="d-flex gap-2">
                <input class="form-control form-control-sm c-discord-input" data-target="settings" data-field="discordSubOwnerWebhookUrl" value="${this._esc(s.discordSubOwnerWebhookUrl || "")}" placeholder="https://discord.com/api/webhooks/...">
                <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="discordSubOwnerWebhookUrl">保存</button>
              </div></td>
            </tr>
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-person-badge"></i> 物件オーナー個別 Discord Webhook</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th style="width:200px;">物件オーナー</th><th>Webhook URL</th><th style="width:80px;"></th></tr></thead>
          <tbody>
            ${this.staff.filter(s => s.isSubOwner).map(staff => `
              <tr data-staff-id="${staff.id}">
                <td class="small fw-semibold">${this._esc(staff.name || "(無名)")}</td>
                <td>
                  <input class="form-control form-control-sm c-discord-input" data-target="staff" data-staff-id="${staff.id}" data-field="subOwnerDiscordWebhookUrl" value="${this._esc(staff.subOwnerDiscordWebhookUrl || "")}" placeholder="https://discord.com/api/webhooks/...">
                </td>
                <td><button class="btn btn-sm btn-primary c-save-row-btn" data-target="staff" data-staff-id="${staff.id}">保存</button></td>
              </tr>
            `).join("") || '<tr><td colspan="3" class="text-muted small">物件オーナーがいません (スタッフ管理で isSubOwner=true を設定)</td></tr>'}
          </tbody>
        </table>
      </div></div>
    `;
    document.getElementById("discordArea").innerHTML = html;
  },

  // ============================================================
  // 保存ハンドラ
  // ============================================================
  bindEvents() {
    document.querySelectorAll(".c-save-btn").forEach(btn => {
      btn.addEventListener("click", () => this.saveSingle(btn));
    });
    document.querySelectorAll(".c-save-row-btn").forEach(btn => {
      btn.addEventListener("click", () => this.saveStaffRow(btn));
    });
    document.querySelectorAll(".c-token-delete-btn").forEach(btn => {
      btn.addEventListener("click", () => this.deleteToken(btn));
    });

    // notifyEmails 一括管理
    document.getElementById("btnAddNotifyEmail")?.addEventListener("click", () => this._addNotifyEmailRow());
    document.querySelectorAll(".c-notify-email-remove").forEach(b => {
      b.addEventListener("click", () => { b.closest("tr")?.remove(); this._reindexNotifyEmailRows(); });
    });
    document.getElementById("btnSaveNotifyEmails")?.addEventListener("click", () => this._saveNotifyEmails());

    // メイン Bot トークン
    document.getElementById("btnVerifyMainToken")?.addEventListener("click", () => this._verifyLineToken("lineMainToken", "lineMainTokenResult"));
    document.getElementById("btnSaveMainToken")?.addEventListener("click", () => this._saveMainLineToken());

    // LINE User ID / Group ID の名前取得
    document.querySelectorAll(".c-line-lookup-btn").forEach(b => {
      b.addEventListener("click", () => {
        const input = document.getElementById(b.dataset.input);
        const result = document.getElementById(b.dataset.result);
        this._lookupLineProfile(b.dataset.type, input?.value || "", result);
      });
    });
    // ページ表示時、ID 入力済みなら自動で名前取得 (起動時1回のみ)
    setTimeout(() => {
      const u = document.getElementById("lineOwnerUserIdInput");
      const ur = document.getElementById("lineOwnerUserIdResult");
      if (u && u.value.trim() && ur && !ur.textContent.trim()) this._lookupLineProfile("user", u.value, ur);
      const g = document.getElementById("lineGroupIdInput");
      const gr = document.getElementById("lineGroupIdResult");
      if (g && g.value.trim() && gr && !gr.textContent.trim()) this._lookupLineProfile("group", g.value, gr);
    }, 200);

    // 追加 Bot (ownerLineChannels)
    document.getElementById("btnAddOwnerLineChannel")?.addEventListener("click", () => this._addOwnerChannelRow());
    document.querySelectorAll(".c-owner-ch-remove").forEach(b => {
      b.addEventListener("click", () => { b.closest("tr")?.remove(); this._reindexOwnerChannelRows(); });
    });
    document.querySelectorAll(".c-owner-ch-verify").forEach(b => {
      b.addEventListener("click", () => {
        const idx = b.dataset.idx;
        const tokenInput = document.querySelector(`input.c-owner-ch-input[data-idx="${idx}"][data-field="token"]`);
        const resultEl = document.querySelector(`.owner-ch-verify-result[data-idx="${idx}"]`);
        this._verifyLineTokenValue(tokenInput?.value || "", resultEl);
      });
    });
    document.getElementById("btnSaveOwnerLineChannels")?.addEventListener("click", () => this._saveOwnerLineChannels());

    // 追加 Bot の userId 検索
    document.querySelectorAll(".c-owner-ch-lookup-user").forEach(b => {
      b.addEventListener("click", () => {
        const idx = b.dataset.idx;
        const userInput = document.querySelector(`.c-owner-ch-input[data-idx="${idx}"][data-field="userId"]`);
        const tokenInput = document.querySelector(`.c-owner-ch-input[data-idx="${idx}"][data-field="token"]`);
        const resultEl = document.querySelector(`.owner-ch-user-result[data-idx="${idx}"]`);
        this._lookupLineProfileWithToken("user", userInput?.value || "", tokenInput?.value || "", resultEl);
      });
    });

    // スタッフ / 物件オーナーの LINE User ID 検索
    document.querySelectorAll(".c-staff-line-lookup").forEach(b => {
      b.addEventListener("click", () => {
        const input = document.getElementById(b.dataset.input);
        const result = document.getElementById(b.dataset.result);
        this._lookupLineProfile("user", input?.value || "", result);
      });
    });

    // 物件別 LINE channels 編集
    this._bindPropChannelEvents();
  },

  _bindPropChannelEvents() {
    document.querySelectorAll(".c-prop-ch-add").forEach(b => {
      b.addEventListener("click", () => this._addPropChannelRow(b.dataset.propId));
    });
    document.querySelectorAll(".c-prop-ch-remove").forEach(b => {
      b.addEventListener("click", () => {
        const tbody = b.closest("tbody.prop-ch-rows");
        b.closest("tr")?.remove();
        this._reindexPropChannelRows(tbody);
      });
    });
    document.querySelectorAll(".c-prop-ch-verify-token").forEach(b => {
      b.addEventListener("click", () => {
        const propId = b.dataset.propId;
        const idx = b.dataset.idx;
        const tokenInput = document.querySelector(`.c-prop-ch-input[data-prop-id="${propId}"][data-idx="${idx}"][data-field="token"]`);
        const resultEl = document.querySelector(`.prop-ch-token-result[data-prop-id="${propId}"][data-idx="${idx}"]`);
        this._verifyLineTokenValue(tokenInput?.value || "", resultEl);
      });
    });
    document.querySelectorAll(".c-prop-ch-lookup-group").forEach(b => {
      b.addEventListener("click", () => {
        const propId = b.dataset.propId;
        const idx = b.dataset.idx;
        const groupInput = document.querySelector(`.c-prop-ch-input[data-prop-id="${propId}"][data-idx="${idx}"][data-field="groupId"]`);
        const resultEl = document.querySelector(`.prop-ch-group-result[data-prop-id="${propId}"][data-idx="${idx}"]`);
        // この物件 channel の token をフォールバックトークンとして使う (空ならメイン Bot トークン)
        const tokenInput = document.querySelector(`.c-prop-ch-input[data-prop-id="${propId}"][data-idx="${idx}"][data-field="token"]`);
        this._lookupLineProfileWithToken("group", groupInput?.value || "", tokenInput?.value || "", resultEl);
      });
    });
    document.querySelectorAll(".c-prop-ch-save").forEach(b => {
      b.addEventListener("click", () => this._savePropChannels(b.dataset.propId));
    });
  },

  _addPropChannelRow(propId) {
    const tbody = document.querySelector(`tbody.prop-ch-rows[data-prop-id="${propId}"]`);
    if (!tbody) return;
    const existing = tbody.querySelectorAll("tr[data-ch-idx]");
    if (existing.length >= LINE_CHANNELS_MAX_CONTACTS) {
      showToast("確認", `この物件は最大 ${LINE_CHANNELS_MAX_CONTACTS} 件まで`, "warning");
      return;
    }
    // プレースホルダー行 (未登録メッセージ) を消す
    const empty = tbody.querySelector("tr td[colspan]");
    if (empty) empty.parentElement.remove();
    const idx = existing.length;
    const tr = document.createElement("tr");
    tr.dataset.chIdx = idx;
    tr.innerHTML = `
      <td><input class="form-control form-control-sm c-prop-ch-input" data-prop-id="${propId}" data-idx="${idx}" data-field="name" value="" placeholder="例: 長浜清掃G通知"></td>
      <td>
        <div class="d-flex gap-1">
          <input class="form-control form-control-sm c-prop-ch-input" data-prop-id="${propId}" data-idx="${idx}" data-field="token" value="" placeholder="チャネルアクセストークン" type="password">
          <button type="button" class="btn btn-sm btn-outline-info c-prop-ch-verify-token" data-prop-id="${propId}" data-idx="${idx}"><i class="bi bi-shield-check"></i></button>
        </div>
        <div class="small text-muted prop-ch-token-result" data-prop-id="${propId}" data-idx="${idx}"></div>
      </td>
      <td>
        <div class="d-flex gap-1">
          <input class="form-control form-control-sm c-prop-ch-input" data-prop-id="${propId}" data-idx="${idx}" data-field="groupId" value="" placeholder="Cxxxxxxxx (グループ ID)">
          <button type="button" class="btn btn-sm btn-outline-info c-prop-ch-lookup-group" data-prop-id="${propId}" data-idx="${idx}"><i class="bi bi-search"></i></button>
        </div>
        <div class="small text-muted prop-ch-group-result" data-prop-id="${propId}" data-idx="${idx}"></div>
      </td>
      <td><button type="button" class="btn btn-sm btn-outline-danger c-prop-ch-remove" data-prop-id="${propId}" data-idx="${idx}"><i class="bi bi-x-lg"></i></button></td>
    `;
    tbody.appendChild(tr);
    // 新しい行のハンドラを再bind
    this._bindPropChannelEvents();
  },

  _reindexPropChannelRows(tbody) {
    if (!tbody) return;
    const propId = tbody.dataset.propId;
    const rows = tbody.querySelectorAll("tr[data-ch-idx]");
    rows.forEach((r, i) => {
      r.dataset.chIdx = i;
      r.querySelectorAll("[data-idx]").forEach(el => el.dataset.idx = i);
    });
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-muted small">未登録</td></tr>`;
    }
  },

  async _savePropChannels(propId) {
    const btn = document.querySelector(`.c-prop-ch-save[data-prop-id="${propId}"]`);
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const tbody = document.querySelector(`tbody.prop-ch-rows[data-prop-id="${propId}"]`);
      const rows = tbody.querySelectorAll("tr[data-ch-idx]");
      const channels = [];
      rows.forEach(r => {
        const name = r.querySelector('.c-prop-ch-input[data-field="name"]')?.value.trim() || "";
        const token = r.querySelector('.c-prop-ch-input[data-field="token"]')?.value.trim() || "";
        const groupId = r.querySelector('.c-prop-ch-input[data-field="groupId"]')?.value.trim() || "";
        if (token || groupId || name) channels.push({ name, token, groupId, enabled: true });
      });
      // properties/{id}.lineChannels に保存 (物件編集と同期)
      const updateData = { lineChannels: channels };
      // 後方互換: lineChannels[0] を旧単一フィールドに反映
      if (channels[0]) {
        updateData.lineChannelToken = channels[0].token || "";
        updateData.lineGroupId = channels[0].groupId || "";
      }
      await db.collection("properties").doc(propId).set(updateData, { merge: true });
      // ローカル状態も更新
      const local = this.properties.find(p => p.id === propId);
      if (local) local.lineChannels = channels;
      showToast("保存", `物件「${local?.name || propId}」の LINE Bot を ${channels.length} 件保存しました`, "success");
    } catch (e) {
      showToast("エラー", "保存失敗: " + e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  // トークン指定版の LINE プロフィール取得 (物件別 channel から)
  async _lookupLineProfileWithToken(type, id, token, resultEl) {
    if (!resultEl) return;
    const trimmed = (id || "").trim();
    if (!trimmed) { resultEl.innerHTML = '<span class="text-muted">ID 未入力</span>'; return; }
    resultEl.innerHTML = '<span class="text-muted"><span class="spinner-border spinner-border-sm"></span> 取得中...</span>';
    try {
      const body = { type, id: trimmed };
      if (token && token.trim()) body.token = token.trim();
      const res = await this._callApi("/api/notifications/lookup-line-profile", body);
      if (res.ok && res.profile) {
        const name = res.profile.displayName || "(名前なし)";
        const pic = res.profile.pictureUrl
          ? `<img src="${this._esc(res.profile.pictureUrl)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:4px;">`
          : "";
        const via = res.foundVia ? ` <span class="text-muted" style="font-size:10px;">(via ${this._esc(res.foundVia)})</span>` : "";
        resultEl.innerHTML = `<span class="text-success">${pic}<i class="bi bi-check-circle"></i> <strong>${this._esc(name)}</strong>${via}</span>`;
      } else {
        resultEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${this._esc(res.error || "取得失敗")}</span>`;
      }
    } catch (e) {
      resultEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${this._esc(e.message)}</span>`;
    }
  },

  // ===== notifyEmails =====
  _addNotifyEmailRow() {
    const tbody = document.getElementById("notifyEmailsRows");
    if (!tbody) return;
    const idx = tbody.querySelectorAll("tr").length;
    const tr = document.createElement("tr");
    tr.dataset.emailIdx = idx;
    tr.innerHTML = `
      <td class="small text-muted"><span class="badge bg-secondary">追加 ${idx}</span></td>
      <td><input class="form-control form-control-sm c-notify-email-input" data-idx="${idx}" value="" placeholder="example@gmail.com"></td>
      <td></td>
      <td><button type="button" class="btn btn-sm btn-outline-danger c-notify-email-remove" data-idx="${idx}"><i class="bi bi-x-lg"></i></button></td>
    `;
    tbody.appendChild(tr);
    tr.querySelector(".c-notify-email-remove").addEventListener("click", () => { tr.remove(); this._reindexNotifyEmailRows(); });
  },
  _reindexNotifyEmailRows() {
    const rows = document.querySelectorAll("#notifyEmailsRows tr");
    rows.forEach((r, i) => {
      r.dataset.emailIdx = i;
      const badge = r.querySelector("td:first-child");
      if (badge) badge.innerHTML = i === 0
        ? '<span class="badge bg-primary">代表</span>'
        : `<span class="badge bg-secondary">追加 ${i}</span>`;
      const input = r.querySelector(".c-notify-email-input");
      if (input) input.dataset.idx = i;
    });
  },
  async _saveNotifyEmails() {
    const btn = document.getElementById("btnSaveNotifyEmails");
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const inputs = document.querySelectorAll("#notifyEmailsRows .c-notify-email-input");
      const emails = Array.from(inputs).map(i => (i.value || "").trim()).filter(Boolean);
      // 重複除去 (順序維持)
      const uniq = [...new Set(emails)];
      const ownerEmail = uniq[0] || "";
      await db.collection("settings").doc("notifications").set({
        notifyEmails: uniq,
        ownerEmail: ownerEmail, // 旧コード互換のため自動同期
      }, { merge: true });
      this.notifSettings = { ...(this.notifSettings || {}), notifyEmails: uniq, ownerEmail };
      showToast("保存", `通知メール ${uniq.length} 件を保存しました (代表: ${ownerEmail || "なし"})`, "success");
      // 再描画して連携バッジ更新
      this.renderEmails();
      this.bindEvents();
    } catch (e) {
      showToast("エラー", "保存失敗: " + e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  // ===== LINE トークン検証 =====
  async _verifyLineToken(inputId, resultElId) {
    const input = document.getElementById(inputId);
    const resultEl = document.getElementById(resultElId);
    return this._verifyLineTokenValue(input?.value || "", resultEl);
  },
  async _verifyLineTokenValue(token, resultEl) {
    if (!resultEl) return;
    if (!token || !token.trim()) {
      resultEl.innerHTML = '<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> トークンが空です</span>';
      return;
    }
    resultEl.innerHTML = '<span class="text-muted"><span class="spinner-border spinner-border-sm"></span> 検証中...</span>';
    try {
      const res = await this._callApi("/api/notifications/verify-line-token", { token: token.trim() });
      if (res.ok && res.botInfo) {
        const pic = res.botInfo.pictureUrl
          ? `<img src="${this._esc(res.botInfo.pictureUrl)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:4px;">`
          : "";
        resultEl.innerHTML = `<span class="text-success">${pic}<i class="bi bi-check-circle"></i> OK: <strong>${this._esc(res.botInfo.displayName || "(Bot 名なし)")}</strong> (${this._esc(res.botInfo.basicId || res.botInfo.userId || "")})</span>`;
      } else {
        resultEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> 無効: ${this._esc(res.error || "不明なエラー")}</span>`;
      }
    } catch (e) {
      resultEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> 検証エラー: ${this._esc(e.message)}</span>`;
    }
  },
  async _saveMainLineToken() {
    const btn = document.getElementById("btnSaveMainToken");
    const input = document.getElementById("lineMainToken");
    const resultEl = document.getElementById("lineMainTokenResult");
    const token = (input?.value || "").trim();
    if (!token) {
      showToast("確認", "トークンが空です。空のまま保存するとメイン Bot 通知が無効化されます。", "warning");
    }
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      // 検証 (トークンが入力されている場合のみ)
      if (token) {
        const res = await this._callApi("/api/notifications/verify-line-token", { token });
        if (!res.ok) {
          resultEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> 検証失敗: ${this._esc(res.error || "")} — 保存を中止しました</span>`;
          throw new Error("検証失敗のため保存を中止");
        }
        resultEl.innerHTML = `<span class="text-success"><i class="bi bi-check-circle"></i> 検証成功 (${this._esc(res.botInfo?.displayName || "")})</span>`;
      }
      await db.collection("settings").doc("notifications").set({ lineChannelToken: token }, { merge: true });
      if (this.notifSettings) this.notifSettings.lineChannelToken = token;
      showToast("保存", "メイン Bot トークンを保存しました", "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  // 認証付き fetch (API ヘルパーが無いため直書き)
  async _callApi(path, body) {
    const token = await firebase.auth().currentUser.getIdToken();
    const res = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (_) {}
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  // ===== LINE プロフィール取得 (User ID / Group ID から名前を取得) =====
  async _lookupLineProfile(type, id, resultEl) {
    if (!resultEl) return;
    const trimmed = (id || "").trim();
    if (!trimmed) { resultEl.innerHTML = '<span class="text-muted">ID 未入力</span>'; return; }
    resultEl.innerHTML = '<span class="text-muted"><span class="spinner-border spinner-border-sm"></span> 取得中...</span>';
    try {
      const res = await this._callApi("/api/notifications/lookup-line-profile", { type, id: trimmed });
      if (res.ok && res.profile) {
        const name = res.profile.displayName || "(名前なし)";
        const pic = res.profile.pictureUrl
          ? `<img src="${this._esc(res.profile.pictureUrl)}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:4px;">`
          : "";
        const via = res.foundVia ? ` <span class="text-muted" style="font-size:10px;">(via ${this._esc(res.foundVia)})</span>` : "";
        resultEl.innerHTML = `<span class="text-success">${pic}<i class="bi bi-check-circle"></i> <strong>${this._esc(name)}</strong>${via}</span>`;
      } else {
        const triedTxt = Array.isArray(res.tried) && res.tried.length
          ? ` <span class="text-muted" style="font-size:10px;">(試行: ${res.tried.length} Bot)</span>`
          : "";
        resultEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${this._esc(res.error || "取得失敗")}${triedTxt}</span>`;
      }
    } catch (e) {
      resultEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${this._esc(e.message)}</span>`;
    }
  },

  // ===== ownerLineChannels =====
  _addOwnerChannelRow() {
    const tbody = document.getElementById("ownerLineChannelsRows");
    if (!tbody) return;
    const idx = tbody.querySelectorAll("tr").length;
    const tr = document.createElement("tr");
    tr.dataset.chIdx = idx;
    tr.innerHTML = `
      <td><input class="form-control form-control-sm c-owner-ch-input" data-idx="${idx}" data-field="name" value="" placeholder="例: 清掃G通知"></td>
      <td>
        <div class="d-flex gap-1">
          <input class="form-control form-control-sm c-owner-ch-input" data-idx="${idx}" data-field="token" value="" placeholder="チャネルアクセストークン" type="password">
          <button type="button" class="btn btn-sm btn-outline-info c-owner-ch-verify" data-idx="${idx}"><i class="bi bi-shield-check"></i></button>
        </div>
        <div class="small text-muted owner-ch-verify-result" data-idx="${idx}"></div>
      </td>
      <td><input class="form-control form-control-sm c-owner-ch-input" data-idx="${idx}" data-field="userId" value="" placeholder="Uxxxxxxxx (任意)"></td>
      <td><button type="button" class="btn btn-sm btn-outline-danger c-owner-ch-remove" data-idx="${idx}"><i class="bi bi-x-lg"></i></button></td>
    `;
    tbody.appendChild(tr);
    tr.querySelector(".c-owner-ch-remove").addEventListener("click", () => { tr.remove(); this._reindexOwnerChannelRows(); });
    tr.querySelector(".c-owner-ch-verify").addEventListener("click", () => {
      const tokenInput = tr.querySelector('.c-owner-ch-input[data-field="token"]');
      const resultEl = tr.querySelector(".owner-ch-verify-result");
      this._verifyLineTokenValue(tokenInput?.value || "", resultEl);
    });
  },
  _reindexOwnerChannelRows() {
    document.querySelectorAll("#ownerLineChannelsRows tr").forEach((r, i) => {
      r.dataset.chIdx = i;
      r.querySelectorAll(".c-owner-ch-input,.c-owner-ch-remove,.c-owner-ch-verify,.owner-ch-verify-result").forEach(el => el.dataset.idx = i);
    });
  },
  async _saveOwnerLineChannels() {
    const btn = document.getElementById("btnSaveOwnerLineChannels");
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const rows = document.querySelectorAll("#ownerLineChannelsRows tr");
      const channels = [];
      rows.forEach(r => {
        const name = r.querySelector('.c-owner-ch-input[data-field="name"]')?.value.trim() || "";
        const token = r.querySelector('.c-owner-ch-input[data-field="token"]')?.value.trim() || "";
        const userId = r.querySelector('.c-owner-ch-input[data-field="userId"]')?.value.trim() || "";
        if (token) channels.push({ name, token, userId });
      });
      await db.collection("settings").doc("notifications").set({ ownerLineChannels: channels }, { merge: true });
      if (this.notifSettings) this.notifSettings.ownerLineChannels = channels;
      showToast("保存", `追加 Bot ${channels.length} 件を保存しました`, "success");
    } catch (e) {
      showToast("エラー", "保存失敗: " + e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  async deleteToken(btn) {
    const tokenId = btn.dataset.tokenId;
    const context = btn.dataset.context;
    const email = btn.dataset.email;
    const ok = typeof window.showConfirm === "function"
      ? await window.showConfirm(`${email} の Gmail 連携を解除します。よろしいですか？`, "Gmail 連携解除")
      : window.confirm(`${email} の Gmail 連携を解除しますか？`);
    if (!ok) return;
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const parent = context === "emailVerification" ? "gmailOAuthEmailVerification" : "gmailOAuth";
      await db.collection("settings").doc(parent).collection("tokens").doc(tokenId).delete();
      this.gmailTokens = this.gmailTokens.filter(t => !(t.id === tokenId && t.context === context));
      this.renderEmails();
      this.bindEvents();
      showToast("解除完了", `${email} の連携を解除しました`, "success");
    } catch (e) {
      btn.disabled = false; btn.innerHTML = orig;
      showToast("エラー", "解除失敗: " + e.message, "error");
    }
  },

  async saveSingle(btn) {
    const target = btn.dataset.target;
    const field = btn.dataset.field;
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      if (target === "settings") {
        const input = document.querySelector(`input[data-target="settings"][data-field="${field}"]`);
        const val = (input?.value || "").trim();
        await db.collection("settings").doc("notifications").set({ [field]: val }, { merge: true });
        if (this.notifSettings) this.notifSettings[field] = val;
        showToast("保存", `${field} を保存しました`, "success");
      }
    } catch (e) {
      showToast("エラー", "保存失敗: " + e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  async saveStaffRow(btn) {
    const staffId = btn.dataset.staffId;
    const row = btn.closest("tr");
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const inputs = row.querySelectorAll('input[data-target="staff"]');
      const update = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      inputs.forEach(inp => {
        update[inp.dataset.field] = (inp.value || "").trim();
      });
      await db.collection("staff").doc(staffId).update(update);
      const local = this.staff.find(s => s.id === staffId);
      if (local) Object.assign(local, update);
      showToast("保存", "スタッフ情報を保存しました", "success");
    } catch (e) {
      showToast("エラー", "保存失敗: " + e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  // ============================================================
  // ユーティリティ
  // ============================================================
  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },
  _fmtDate(ts) {
    if (!ts) return "-";
    try {
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toISOString().slice(0, 10);
    } catch { return "-"; }
  },
};
