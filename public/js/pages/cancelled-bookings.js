/**
 * キャンセル予約一覧
 * - bookings コレクションから status="cancelled" を表示
 * - 物件フィルタ: 番号バッジ + 目アイコンで表示/非表示切替 (他タブと統一)
 * - サブオーナー権限: 自分の ownedPropertyIds の物件のみ閲覧可能
 * - 各行に「キャンセル取消」ボタン
 */
const CancelledBookingsPage = {
  state: {
    bookings: [],
    properties: [],
    propertyVisibility: {}, // { propertyId: true|false } true=表示
    filterRange: "future", // future | past3m | all
  },

  async render(container) {
    container.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <h4 class="mb-0"><i class="bi bi-x-circle"></i> キャンセル予約一覧</h4>
        <span class="ms-3 text-muted small" id="cbSummary">読み込み中...</span>
      </div>
      <div class="card mb-3">
        <div class="card-body py-2">
          <div class="mb-2">
            <small class="text-muted me-2"><i class="bi bi-building"></i> 物件:</small>
            <span id="cbPropertyFilter"></span>
            <small class="text-muted ms-2">(目アイコンで表示切替)</small>
          </div>
          <div class="row g-2 align-items-center">
            <div class="col-md-6">
              <label class="form-label small mb-1">期間 (チェックイン基準)</label>
              <select class="form-select form-select-sm" id="cbFilterRange">
                <option value="future">今日以降</option>
                <option value="past3m">直近3か月</option>
                <option value="all">すべて</option>
              </select>
            </div>
            <div class="col-md-6 text-end">
              <button class="btn btn-sm btn-outline-secondary" id="cbReload"><i class="bi bi-arrow-clockwise"></i> 再読込</button>
            </div>
          </div>
        </div>
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle">
          <thead class="table-light">
            <tr>
              <th>物件</th>
              <th>ゲスト名</th>
              <th>CI</th>
              <th>CO</th>
              <th>ソース</th>
              <th>キャンセル日時</th>
              <th>理由</th>
              <th class="text-end">操作</th>
            </tr>
          </thead>
          <tbody id="cbTbody">
            <tr><td colspan="8" class="text-muted text-center py-4">読み込み中...</td></tr>
          </tbody>
        </table>
      </div>
    `;
    this._bindUI(container);
    await this._load();
  },

  _bindUI(container) {
    container.querySelector("#cbFilterRange").addEventListener("change", (e) => {
      this.state.filterRange = e.target.value;
      this._render();
    });
    container.querySelector("#cbReload").addEventListener("click", () => this._load());
  },

  /**
   * サブオーナー impersonation 中なら自分の ownedPropertyIds に絞る
   * 通常オーナーなら全物件
   */
  _getAllowedPropertyIds() {
    // impersonation 中 (オーナーがサブオーナー視点で閲覧 or サブオーナー本人ログイン)
    if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
      const ids = App.impersonatingData.ownedPropertyIds || [];
      return new Set(ids);
    }
    // カスタムクレーム role=sub_owner なら staff doc から ownedPropertyIds を取得
    if (typeof Auth !== "undefined" && Auth.role && Auth.role() === "sub_owner") {
      const ids = (Auth.user && Auth.user.ownedPropertyIds) || [];
      return new Set(ids);
    }
    return null; // null = 全物件許可
  },

  async _load() {
    const db = firebase.firestore();
    try {
      // 物件取得 (active のみ)
      const propsSnap = await db.collection("properties").where("active", "==", true).get();
      let allProps = propsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      // サブオーナー権限チェック
      const allowed = this._getAllowedPropertyIds();
      if (allowed) {
        allProps = allProps.filter(p => allowed.has(p.id));
      }

      // propertyNumber 順 (1, 2, 3, 4...) でソート、未設定は末尾
      allProps.sort((a, b) => {
        const an = parseInt(a.propertyNumber, 10);
        const bn = parseInt(b.propertyNumber, 10);
        const av = isNaN(an) ? 9999 : an;
        const bv = isNaN(bn) ? 9999 : bn;
        return av - bv;
      });
      this.state.properties = allProps;

      // 初期表示状態: 全物件 visible (state がまだなければ)
      allProps.forEach(p => {
        if (this.state.propertyVisibility[p.id] === undefined) {
          this.state.propertyVisibility[p.id] = true;
        }
      });

      this._renderPropertyFilter();

      // cancelled な bookings 取得
      const snap = await db.collection("bookings").where("status", "==", "cancelled").get();
      let bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // サブオーナー権限で物件絞り込み (bookings 側)
      if (allowed) {
        bookings = bookings.filter(b => allowed.has(b.propertyId));
      }
      this.state.bookings = bookings;
      this._render();
    } catch (e) {
      console.error("[cancelled-bookings] load error:", e);
      const tbody = document.getElementById("cbTbody");
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-danger text-center py-4">読み込み失敗: ${this._esc(e.message || String(e))}</td></tr>`;
    }
  },

  _renderPropertyFilter() {
    const wrap = document.getElementById("cbPropertyFilter");
    if (!wrap) return;
    if (this.state.properties.length === 0) {
      wrap.innerHTML = '<small class="text-muted">対象物件なし</small>';
      return;
    }
    wrap.innerHTML = this.state.properties.map(p => {
      const num = p.propertyNumber || "";
      const color = p.color || "#6c757d";
      const visible = this.state.propertyVisibility[p.id] !== false;
      const eyeIcon = visible ? "bi-eye" : "bi-eye-slash";
      const opacity = visible ? "1" : "0.45";
      return `<button type="button" class="cb-prop-toggle ms-1" data-prop-id="${this._esc(p.id)}"
                title="${this._esc(p.name)} ${visible ? '(表示中 - クリックで非表示)' : '(非表示 - クリックで表示)'}"
                style="border:1px solid #ced4da;background:#fff;border-radius:4px;padding:2px 6px;font-size:12px;cursor:pointer;opacity:${opacity};">
                <span class="badge" style="background:${color};color:#fff;">${this._esc(num)}</span>
                <i class="bi ${eyeIcon} text-muted"></i>
              </button>`;
    }).join("");
    wrap.querySelectorAll(".cb-prop-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const pid = btn.dataset.propId;
        this.state.propertyVisibility[pid] = !(this.state.propertyVisibility[pid] !== false);
        this._renderPropertyFilter();
        this._render();
      });
    });
  },

  _render() {
    const tbody = document.getElementById("cbTbody");
    const summary = document.getElementById("cbSummary");
    if (!tbody) return;

    const today = this._toDateStr(new Date());
    const past3mDate = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - 3);
      return this._toDateStr(d);
    })();

    let list = this.state.bookings.slice();
    // 期間フィルタ (CI 基準)
    if (this.state.filterRange === "future") {
      list = list.filter(b => (b.checkIn || "") >= today);
    } else if (this.state.filterRange === "past3m") {
      list = list.filter(b => (b.checkIn || "") >= past3mDate);
    }
    // 物件フィルタ (visibility)
    list = list.filter(b => this.state.propertyVisibility[b.propertyId] !== false);
    // ソート (キャンセル日時 降順)
    list.sort((a, b) => this._toMs(b.cancelledAt) - this._toMs(a.cancelledAt));

    if (summary) summary.textContent = `${list.length} 件`;

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-muted text-center py-4">該当するキャンセル予約はありません</td></tr>`;
      return;
    }

    const propMap = {};
    this.state.properties.forEach(p => propMap[p.id] = p.name || p.id);

    tbody.innerHTML = list.map(b => {
      const propName = propMap[b.propertyId] || (b.propertyId || "-");
      const cancelledAt = this._fmtTs(b.cancelledAt);
      const reason = b.cancelReason || (b.cancelSource ? `(${b.cancelSource})` : "-");
      const sourceBadge = this._sourceBadge(b.source || b.bookingSite);
      return `<tr data-booking-id="${this._esc(b.id)}">
        <td>${this._esc(propName)}</td>
        <td>${this._esc(b.guestName || "(名前なし)")}</td>
        <td>${this._esc(b.checkIn || "-")}</td>
        <td>${this._esc(b.checkOut || "-")}</td>
        <td>${sourceBadge}</td>
        <td><small>${this._esc(cancelledAt)}</small></td>
        <td><small class="text-muted">${this._esc(reason)}</small></td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-success cb-restore" data-booking-id="${this._esc(b.id)}">
            <i class="bi bi-arrow-counterclockwise"></i> キャンセル取消
          </button>
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".cb-restore").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const bookingId = btn.dataset.bookingId;
        const b = list.find(x => x.id === bookingId);
        if (!b) return;
        const ok = await showConfirm(
          `この予約のキャンセルを取消します (status を confirmed に戻す):\n\nゲスト: ${b.guestName || "(名前なし)"}\nCI: ${b.checkIn} / CO: ${b.checkOut}\n物件: ${propMap[b.propertyId] || "-"}`,
          { title: "キャンセルを取消", okLabel: "取消", okClass: "btn-success" }
        );
        if (!ok) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        try {
          const db = firebase.firestore();
          await db.collection("bookings").doc(bookingId).update({
            status: "confirmed",
            cancelledAt: firebase.firestore.FieldValue.delete(),
            cancelSource: firebase.firestore.FieldValue.delete(),
            cancelReason: firebase.firestore.FieldValue.delete(),
            manualOverride: true,
            _emailVerificationNote: "キャンセル予約一覧から手動復元",
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          showToast("復元", `${b.guestName || "予約"} を復元しました`, "success");
          this.state.bookings = this.state.bookings.filter(x => x.id !== bookingId);
          this._render();
        } catch (err) {
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> キャンセル取消';
          await showAlert("復元失敗: " + (err.message || err));
        }
      });
    });
  },

  _sourceBadge(source) {
    const s = String(source || "").toLowerCase();
    if (s.includes("airbnb")) return '<span class="badge" style="background:#FF5A5F;color:#fff">Airbnb</span>';
    if (s.includes("booking")) return '<span class="badge" style="background:#003580;color:#fff">Booking.com</span>';
    if (s) return `<span class="badge bg-secondary">${this._esc(source)}</span>`;
    return '<span class="text-muted small">-</span>';
  },

  _toMs(v) {
    if (!v) return 0;
    if (v && typeof v.toMillis === "function") return v.toMillis();
    if (v && v._seconds) return v._seconds * 1000;
    if (v instanceof Date) return v.getTime();
    return 0;
  },

  _fmtTs(v) {
    const ms = this._toMs(v);
    if (!ms) return "-";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  _toDateStr(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  cleanup() {},
};
