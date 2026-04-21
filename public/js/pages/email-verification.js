/**
 * メール照合機能 画面 (#/email-verification)
 *
 * 機能:
 *   - emailVerifications コレクションの一覧表示 (最新順、matchStatus フィルタ)
 *   - 「今すぐ巡回」ボタンで Gmail 巡回を手動実行
 *   - unmatched: 手動で予約に紐付け / 無視
 *   - cancelled-unmatched: 手動キャンセル確定 / 無視
 *   - matched / cancelled / changed: 参照のみ (Gmail 深層リンクで元メール確認)
 *
 * 前提: 旧セッション (main commit f534e46) で実装済の bookings 情報履歴 UI と連携し、
 *       bookings 側の emailVerifiedAt + emailMessageId で Gmail リンクが自動表示される。
 */
const EmailVerificationPage = {
  items: [],
  filter: "all", // all | unmatched | matched | cancelled | cancelled-unmatched | changed | ignored | pending
  properties: [], // { id, name, color? } 手動紐付けの候補物件絞り込み用
  gmailAccounts: [], // 連携済 Gmail アカウント一覧

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-envelope-check"></i> メール照合</h2>
        <div class="d-flex gap-2">
          <button class="btn btn-outline-secondary" id="btnEvRefresh"><i class="bi bi-arrow-clockwise"></i> 再読込</button>
          <button class="btn btn-primary" id="btnEvRunNow"><i class="bi bi-play-fill"></i> 今すぐ巡回</button>
        </div>
      </div>

      <!-- Gmail 連携パネル -->
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <span><i class="bi bi-google"></i> Gmail 連携</span>
          <button class="btn btn-sm btn-outline-primary" id="btnEvConnectGmail">
            <i class="bi bi-plus-lg"></i> 新しいアカウントを連携
          </button>
        </div>
        <div class="card-body">
          <div id="evAccountsList" class="small">
            <div class="text-muted">読み込み中...</div>
          </div>
          <div class="small text-muted mt-2">
            OTA (Airbnb / Booking.com) からのホスト向け通知メールが届く事業用 Gmail を連携してください。
            連携後は 10 分おきに自動巡回し、物件の <strong>検証用メールアドレス</strong>
            (物件詳細モーダルで登録) 宛てに届いた予約関連メールを自動で予約と突合します。
          </div>
        </div>
      </div>

      <!-- ステータスフィルタ -->
      <div class="btn-group mb-3" role="group" aria-label="matchStatus フィルタ" id="evFilterBar">
        <button type="button" class="btn btn-outline-primary active" data-filter="all">すべて</button>
        <button type="button" class="btn btn-outline-warning" data-filter="unmatched">未突合</button>
        <button type="button" class="btn btn-outline-danger" data-filter="cancelled-unmatched">キャンセル未突合</button>
        <button type="button" class="btn btn-outline-success" data-filter="matched">突合済</button>
        <button type="button" class="btn btn-outline-dark" data-filter="cancelled">キャンセル済</button>
        <button type="button" class="btn btn-outline-info" data-filter="changed">変更通知</button>
        <button type="button" class="btn btn-outline-secondary" data-filter="ignored">無視</button>
      </div>

      <!-- 統計サマリ -->
      <div id="evStatsBar" class="small text-muted mb-2"></div>

      <!-- 一覧テーブル -->
      <div class="card">
        <div class="table-responsive">
          <table class="table table-sm table-hover mb-0 align-middle">
            <thead class="table-light">
              <tr>
                <th style="min-width:120px">受信</th>
                <th>プラットフォーム</th>
                <th style="min-width:220px">件名</th>
                <th style="min-width:110px">確認コード</th>
                <th>チェックイン</th>
                <th>ゲスト</th>
                <th>状態</th>
                <th style="min-width:160px">操作</th>
              </tr>
            </thead>
            <tbody id="evListBody">
              <tr><td colspan="8" class="text-center text-muted py-4">読み込み中...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 詳細モーダル -->
      <div class="modal fade" id="evDetailModal" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">メール詳細</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="evDetailBody"></div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 手動紐付けモーダル -->
      <div class="modal fade" id="evLinkModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">予約に紐付け</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="evLinkBody"></div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // URL ハッシュから ?id=xxx を取り出してフォーカス対象に保持
    // 例: #/email-verification?id=19da902504d3956d
    //     ルータ側では ? 以降をそのまま hash に残している想定
    try {
      const hash = window.location.hash || "";
      const qIdx = hash.indexOf("?");
      if (qIdx >= 0) {
        const params = new URLSearchParams(hash.slice(qIdx + 1));
        const fid = params.get("id");
        if (fid) this._focusId = fid;
      }
    } catch (e) { /* noop */ }

    this.bindHandlers_();
    await Promise.all([this.load_(), this.loadAccounts_()]);
  },

  bindHandlers_() {
    document.getElementById("btnEvRefresh").addEventListener("click", () => {
      this.load_();
      this.loadAccounts_();
    });
    document.getElementById("btnEvRunNow").addEventListener("click", () => this.runNow_());
    document.getElementById("btnEvConnectGmail").addEventListener("click", () => this.connectGmail_());
    document.querySelectorAll("#evFilterBar button").forEach((b) => {
      b.addEventListener("click", (e) => {
        document.querySelectorAll("#evFilterBar button").forEach((x) => x.classList.remove("active"));
        e.currentTarget.classList.add("active");
        this.filter = e.currentTarget.dataset.filter;
        this.renderTable_();
      });
    });
  },

  async load_() {
    try {
      const data = await this.cfApi_("GET", "/email-verification/list?limit=200");
      this.items = data.items || [];
      this.renderTable_();
    } catch (e) {
      document.getElementById("evListBody").innerHTML =
        `<tr><td colspan="8" class="text-center text-danger py-4">読み込み失敗: ${this.escape_(e.message)}</td></tr>`;
    }
  },

  // ====== Gmail アカウント管理 ======

  async loadAccounts_() {
    const listEl = document.getElementById("evAccountsList");
    try {
      const data = await this.cfApi_("GET", "/gmail-auth/accounts?context=emailVerification");
      this.gmailAccounts = data.accounts || [];
      this.renderAccounts_();
    } catch (e) {
      listEl.innerHTML = `<div class="text-danger">アカウント一覧取得失敗: ${this.escape_(e.message)}</div>`;
    }
  },

  renderAccounts_() {
    const listEl = document.getElementById("evAccountsList");
    if (!this.gmailAccounts.length) {
      listEl.innerHTML = `
        <div class="alert alert-warning mb-0 py-2">
          連携済みアカウントがありません。右上の「新しいアカウントを連携」から Gmail を連携してください。
        </div>
      `;
      return;
    }
    listEl.innerHTML = `
      <div class="d-flex flex-column gap-1">
        ${this.gmailAccounts.map((a) => {
          const email = this.escape_(a.email || "");
          const savedAt = a.savedAt ? this.formatTs_(a.savedAt) : "";
          const ok = a.hasRefreshToken
            ? `<span class="badge bg-success">有効</span>`
            : `<span class="badge bg-danger">リフレッシュトークン無し</span>`;
          return `
            <div class="d-flex align-items-center justify-content-between border rounded p-2">
              <div>
                <i class="bi bi-envelope-fill text-primary"></i>
                <strong>${email}</strong>
                ${ok}
                ${savedAt ? `<span class="text-muted small ms-2">連携日: ${savedAt}</span>` : ""}
              </div>
              <button class="btn btn-sm btn-outline-danger" data-account="${email}">
                <i class="bi bi-x-circle"></i> 解除
              </button>
            </div>
          `;
        }).join("")}
      </div>
    `;
    listEl.querySelectorAll("button[data-account]").forEach((btn) => {
      btn.addEventListener("click", () => this.removeAccount_(btn.dataset.account));
    });
  },

  async connectGmail_() {
    const email = window.showPrompt
      ? await window.showPrompt("連携する Gmail アドレスを入力してください (例: 81hassac@gmail.com)", "", "Gmail 連携")
      : window.prompt("連携する Gmail アドレス (例: 81hassac@gmail.com):");
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (window.showAlert) await window.showAlert("メールアドレスの形式が正しくありません", "エラー");
      return;
    }
    const url = `https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/start?context=emailVerification&email=${encodeURIComponent(email)}`;
    window.open(url, "_blank", "noopener");
    if (window.showAlert) {
      await window.showAlert(
        "新しいタブで Google 認証画面が開きます。完了後、このページの「再読込」ボタンを押してください。",
        "Gmail 連携"
      );
    }
  },

  async removeAccount_(email) {
    if (!email) return;
    const ok = window.showConfirm
      ? await window.showConfirm(`${email} の Gmail 連携を解除しますか？ 以降のメール巡回は対象外になります。`, "連携解除")
      : window.confirm(`${email} の Gmail 連携を解除しますか？`);
    if (!ok) return;
    try {
      await this.cfApi_("DELETE", `/gmail-auth/accounts/${encodeURIComponent(email)}?context=emailVerification`);
      await this.loadAccounts_();
    } catch (e) {
      if (window.showAlert) await window.showAlert(`解除失敗: ${e.message}`, "エラー");
    }
  },

  renderTable_() {
    const all = this.items;
    const filtered = this.filter === "all" ? all : all.filter((x) => x.matchStatus === this.filter);

    // 統計バー
    const counts = all.reduce((acc, x) => {
      acc[x.matchStatus || "pending"] = (acc[x.matchStatus || "pending"] || 0) + 1;
      return acc;
    }, {});
    const statsParts = Object.entries(counts).map(
      ([k, v]) => `<span class="me-3"><strong>${v}</strong> ${this.statusLabel_(k)}</span>`
    );
    statsParts.unshift(`<strong class="me-3">合計 ${all.length} 件</strong>`);
    document.getElementById("evStatsBar").innerHTML = statsParts.join("");

    const body = document.getElementById("evListBody");
    if (filtered.length === 0) {
      body.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">該当するメールはありません</td></tr>`;
      return;
    }

    body.innerHTML = filtered.map((it) => this.rowHtml_(it)).join("");

    // 操作ボタンのハンドラ (委譲)
    body.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const item = this.items.find((x) => x.id === id);
        if (!item) return;
        if (action === "detail") this.showDetail_(item);
        else if (action === "link") this.showLinkModal_(item);
        else if (action === "ignore") this.ignoreItem_(item);
        else if (action === "confirm-cancel") this.showLinkModal_(item, true);
      });
    });

    // 予約詳細から飛んできた時のフォーカス対象 (messageId or bookingId) をスクロール + ハイライト
    if (this._focusId) {
      const targetId = this._focusId;
      this._focusId = null;
      // items から一致する行を検索 (messageId 直接 or matchedBookingId で絞り込み)
      const hit = this.items.find((x) => x.id === targetId || x.matchedBookingId === targetId);
      if (hit) {
        // 現在のフィルタで hit が filtered に含まれなければ「すべて」に切替
        const inFiltered = filtered.some((x) => x.id === hit.id);
        if (!inFiltered) {
          this.filter = "all";
          document.querySelectorAll("#evFilterBar button").forEach((b) => {
            b.classList.toggle("active", b.dataset.filter === "all");
          });
          this.renderTable_();
          this._focusId = hit.id;
          // 再帰的に再フォーカス (renderTable_ 後に再度呼ばれる)
          return;
        }
        const row = body.querySelector(`tr[data-ev-id="${hit.id}"]`);
        if (row) {
          row.style.transition = "background-color 0.5s";
          row.style.backgroundColor = "#fff3cd"; // ハイライト
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => { row.style.backgroundColor = ""; }, 3000);
        }
      }
    }
  },

  rowHtml_(it) {
    const kind = (it.extractedInfo && it.extractedInfo.kind) || "unknown";
    const code = it.extractedInfo && it.extractedInfo.reservationCode;
    const ci = it.extractedInfo && it.extractedInfo.checkIn && it.extractedInfo.checkIn.date;
    const co = it.extractedInfo && it.extractedInfo.checkOut && it.extractedInfo.checkOut.date;
    const guestName =
      (it.extractedInfo && (it.extractedInfo.guestName || it.extractedInfo.guestFirstName)) || "—";
    const receivedAt = it.receivedAt
      ? this.formatTs_(it.receivedAt)
      : (it.createdAt ? this.formatTs_(it.createdAt) : "—");
    const platform = it.platform || "—";
    const subjectShort = (it.subject || "").length > 50
      ? (it.subject || "").slice(0, 50) + "…"
      : (it.subject || "");

    const statusBadge = this.statusBadge_(it.matchStatus, kind);
    const actions = this.actionsHtml_(it);

    return `
      <tr data-ev-id="${this.escape_(it.id)}">
        <td class="small">${this.escape_(receivedAt)}</td>
        <td>${this.platformBadge_(platform)}</td>
        <td class="small">
          <div>${this.escape_(subjectShort)}</div>
          <div class="text-muted" style="font-size:0.75rem">${this.kindLabel_(kind)}</div>
        </td>
        <td class="small"><code>${this.escape_(code || "—")}</code></td>
        <td class="small">${ci ? this.escape_(ci) : "—"}${co ? " 〜 " + this.escape_(co) : ""}</td>
        <td class="small">${this.escape_(guestName)}</td>
        <td>${statusBadge}</td>
        <td>${actions}</td>
      </tr>
    `;
  },

  actionsHtml_(it) {
    const id = this.escape_(it.id);
    const parts = [
      `<button class="btn btn-sm btn-outline-secondary" data-action="detail" data-id="${id}" title="詳細"><i class="bi bi-info-circle"></i></button>`,
    ];
    if (it.matchStatus === "unmatched") {
      parts.push(
        `<button class="btn btn-sm btn-outline-primary" data-action="link" data-id="${id}" title="予約に紐付け"><i class="bi bi-link-45deg"></i> 紐付け</button>`,
        `<button class="btn btn-sm btn-outline-secondary" data-action="ignore" data-id="${id}" title="無視"><i class="bi bi-x-circle"></i></button>`
      );
    } else if (it.matchStatus === "cancelled-unmatched") {
      parts.push(
        `<button class="btn btn-sm btn-outline-danger" data-action="confirm-cancel" data-id="${id}" title="キャンセル確定"><i class="bi bi-trash"></i> キャンセル</button>`,
        `<button class="btn btn-sm btn-outline-secondary" data-action="ignore" data-id="${id}" title="無視"><i class="bi bi-x-circle"></i></button>`
      );
    } else if (it.matchStatus === "pending") {
      parts.push(
        `<button class="btn btn-sm btn-outline-secondary" data-action="ignore" data-id="${id}"><i class="bi bi-x-circle"></i> 無視</button>`
      );
    }
    return `<div class="btn-group">${parts.join("")}</div>`;
  },

  showDetail_(it) {
    const bodyEl = document.getElementById("evDetailBody");
    const gmailUrl = it.messageId
      ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(it.messageId)}`
      : null;
    const info = it.extractedInfo || {};
    const kvRows = [
      ["件名", it.subject],
      ["差出人", it.fromHeader],
      ["宛先", it.toHeader],
      ["受信", it.receivedAt ? this.formatTs_(it.receivedAt) : ""],
      ["プラットフォーム", it.platform],
      ["種別", this.kindLabel_(info.kind)],
      ["確認コード", info.reservationCode],
      ["チェックイン", info.checkIn && info.checkIn.date],
      ["チェックアウト", info.checkOut && info.checkOut.date],
      ["ゲスト名", info.guestName || info.guestFirstName],
      ["人数", info.guestCount && info.guestCount.total],
      ["物件 (メール宛先判定)", it.propertyId],
      ["matchStatus", it.matchStatus],
      ["matchedBookingId", it.matchedBookingId],
      ["bookingUpdates (書込済)", Array.isArray(it.bookingUpdates) ? it.bookingUpdates.join(", ") : ""],
    ];
    const rowsHtml = kvRows
      .filter(([_, v]) => v != null && v !== "" && v !== false)
      .map(
        ([k, v]) => `<tr><th class="small" style="width:180px">${this.escape_(k)}</th><td class="small">${this.escape_(String(v))}</td></tr>`
      )
      .join("");

    const gmailLinkHtml = gmailUrl
      ? `<a class="btn btn-outline-primary btn-sm" href="${gmailUrl}" target="_blank" rel="noopener"><i class="bi bi-envelope-open"></i> Gmail で開く</a>`
      : "";

    const rawHtml = it.rawBodyText
      ? `<details class="mt-3"><summary class="small text-muted">本文 (プレーンテキスト)</summary>
         <pre class="small bg-light p-2" style="max-height:400px; overflow:auto; white-space:pre-wrap">${this.escape_(it.rawBodyText)}</pre></details>`
      : "";

    bodyEl.innerHTML = `
      <div class="mb-2">${gmailLinkHtml}</div>
      <table class="table table-sm mb-0"><tbody>${rowsHtml}</tbody></table>
      ${rawHtml}
    `;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("evDetailModal"));
    modal.show();
  },

  async showLinkModal_(it, isCancelConfirm = false) {
    const bodyEl = document.getElementById("evLinkBody");
    bodyEl.innerHTML = `<div class="text-muted">候補予約を読み込み中...</div>`;
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("evLinkModal"));
    modal.show();

    const info = it.extractedInfo || {};
    const qs = new URLSearchParams();
    if (it.propertyId) qs.set("propertyId", it.propertyId);
    if (info.checkIn && info.checkIn.date) qs.set("checkIn", info.checkIn.date);
    if (it.platform) qs.set("platform", it.platform);

    let candidates = [];
    try {
      const data = await this.cfApi_("GET", `/email-verification/candidates?${qs.toString()}`);
      candidates = data.items || [];
    } catch (e) {
      bodyEl.innerHTML = `<div class="alert alert-danger">候補取得失敗: ${this.escape_(e.message)}</div>`;
      return;
    }

    const summaryHtml = `
      <div class="alert alert-info small mb-2">
        <div>確認コード: <code>${this.escape_(info.reservationCode || "—")}</code></div>
        <div>チェックイン: ${this.escape_((info.checkIn && info.checkIn.date) || "—")}</div>
        <div>プラットフォーム: ${this.escape_(it.platform || "—")}</div>
        <div>候補: ${candidates.length} 件 (propertyId=${this.escape_(it.propertyId || "指定なし")}, checkIn ±3 日)</div>
      </div>
    `;

    if (candidates.length === 0) {
      bodyEl.innerHTML = summaryHtml +
        `<div class="alert alert-warning small">候補予約が見つかりません。<br>
          iCal 同期後に再度試すか、フィルタ条件 (propertyId 等) を変更してください。</div>`;
      return;
    }

    const rows = candidates.map((b) => {
      const ci = this.formatDate_(b.checkIn);
      const co = this.formatDate_(b.checkOut);
      const actionLabel = isCancelConfirm ? "キャンセル確定" : "この予約に紐付け";
      const btnClass = isCancelConfirm ? "btn-danger" : "btn-primary";
      return `
        <tr>
          <td class="small">${this.escape_(b.source || "—")}</td>
          <td class="small">${this.escape_(ci)} 〜 ${this.escape_(co)}</td>
          <td class="small">${this.escape_(b.guestName || "")}</td>
          <td class="small"><code>${this.escape_((b.icalUid || "").slice(0, 40))}</code></td>
          <td class="small">${this.escape_(b.status || "")}</td>
          <td><button class="btn btn-sm ${btnClass}" data-booking="${this.escape_(b.id)}" data-ev="${this.escape_(it.id)}" data-mode="${isCancelConfirm ? "cancel" : "link"}">${actionLabel}</button></td>
        </tr>
      `;
    });

    bodyEl.innerHTML = summaryHtml + `
      <div class="table-responsive" style="max-height:400px">
        <table class="table table-sm table-hover">
          <thead class="table-light">
            <tr><th>source</th><th>CI 〜 CO</th><th>ゲスト</th><th>icalUid</th><th>status</th><th></th></tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;

    bodyEl.querySelectorAll("button[data-booking]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const bid = btn.dataset.booking;
        const evId = btn.dataset.ev;
        const mode = btn.dataset.mode;
        btn.disabled = true;
        try {
          if (mode === "cancel") {
            await this.cfApi_("PUT", `/email-verification/${encodeURIComponent(evId)}/confirm-cancel`, { bookingId: bid });
            if (window.showAlert) await window.showAlert("キャンセル確定を bookings に反映しました", "完了");
          } else {
            await this.cfApi_("PUT", `/email-verification/${encodeURIComponent(evId)}/link`, { bookingId: bid });
            if (window.showAlert) await window.showAlert("予約に紐付けました", "完了");
          }
          modal.hide();
          await this.load_();
        } catch (er) {
          btn.disabled = false;
          if (window.showAlert) await window.showAlert(`失敗: ${er.message}`, "エラー");
        }
      });
    });
  },

  async ignoreItem_(it) {
    const ok = window.showConfirm
      ? await window.showConfirm("このメールを無視 (除外) しますか？ 再突合は手動でのみ可能になります。", "無視")
      : true;
    if (!ok) return;
    try {
      await this.cfApi_("PUT", `/email-verification/${encodeURIComponent(it.id)}/ignore`, {});
      await this.load_();
    } catch (e) {
      if (window.showAlert) await window.showAlert(`失敗: ${e.message}`, "エラー");
    }
  },

  async runNow_() {
    const btn = document.getElementById("btnEvRunNow");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> 巡回中...`;
    try {
      const r = await this.cfApi_("POST", "/email-verification/run", {});
      if (window.showAlert) {
        await window.showAlert(
          `完了: 処理 ${r.processedCount} 件 / 新規 ${r.newlySaved} 件 / 突合成功 ${r.matchedCount || 0} 件 / スキップ ${r.skipped} 件`,
          "巡回結果"
        );
      }
      await this.load_();
    } catch (e) {
      if (window.showAlert) await window.showAlert(`失敗: ${e.message}`, "エラー");
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  },

  // ========== ヘルパ ==========

  platformBadge_(p) {
    if (p === "Airbnb") return `<span class="badge bg-danger">Airbnb</span>`;
    if (p === "Booking.com") return `<span class="badge bg-primary">Booking.com</span>`;
    return `<span class="badge bg-secondary">${this.escape_(p || "—")}</span>`;
  },

  statusBadge_(status, kind) {
    const label = this.statusLabel_(status);
    const cls =
      status === "matched" ? "bg-success" :
      status === "cancelled" ? "bg-dark" :
      status === "cancelled-unmatched" ? "bg-danger" :
      status === "unmatched" ? "bg-warning text-dark" :
      status === "changed" ? "bg-info text-dark" :
      status === "ignored" ? "bg-secondary" :
      "bg-light text-dark";
    return `<span class="badge ${cls}">${this.escape_(label)}</span>`;
  },

  statusLabel_(s) {
    return {
      matched: "突合済",
      unmatched: "未突合",
      cancelled: "キャンセル済",
      "cancelled-unmatched": "キャンセル未突合",
      changed: "変更",
      pending: "処理中",
      ignored: "無視",
    }[s] || (s || "不明");
  },

  kindLabel_(k) {
    return {
      confirmed: "予約確定",
      cancelled: "キャンセル",
      "change-approved": "変更承認",
      "change-request": "変更リクエスト",
      request: "予約リクエスト",
      unknown: "",
    }[k] || (k || "");
  },

  formatTs_(v) {
    if (!v) return "";
    try {
      let d;
      if (typeof v === "string") d = new Date(v);
      else if (v.toDate) d = v.toDate();
      else if (v._seconds) d = new Date(v._seconds * 1000);
      else d = new Date(v);
      if (isNaN(d.getTime())) return "";
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch (_e) {
      return "";
    }
  },

  formatDate_(v) {
    if (!v) return "";
    try {
      let d;
      if (typeof v === "string") {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
        if (m) return `${m[1]}-${m[2]}-${m[3]}`;
        d = new Date(v);
      } else if (v.toDate) d = v.toDate();
      else if (v._seconds) d = new Date(v._seconds * 1000);
      else d = new Date(v);
      if (isNaN(d.getTime())) return "";
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } catch (_e) {
      return "";
    }
  },

  escape_(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  async cfApi_(method, path, body) {
    let token = "test-token";
    if (!Auth.testMode && Auth.currentUser && Auth.currentUser.getIdToken) {
      token = await Auth.currentUser.getIdToken();
    }
    const opts = {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    const cfBase = "https://api-5qrfx7ujcq-an.a.run.app";
    const res = await fetch(`${cfBase}${path}`, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let errMsg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); errMsg += ": " + (j.error || text); } catch (_) { errMsg += ": " + text.substring(0, 200); }
      throw new Error(errMsg);
    }
    return res.json();
  },
};

// グローバル公開 (app.js が参照)
if (typeof window !== "undefined") {
  window.EmailVerificationPage = EmailVerificationPage;
}
