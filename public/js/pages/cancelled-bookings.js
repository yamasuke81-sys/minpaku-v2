/**
 * キャンセル予約一覧
 * - bookings コレクションから status="cancelled" を表示
 * - 物件フィルタ・期間フィルタ
 * - 各行に「予約詳細」「キャンセル取消」ボタン
 *
 * キャンセル取消は `manualOverride=true` を立てて以後 iCal 同期から保護。
 */
const CancelledBookingsPage = {
  state: {
    bookings: [],
    properties: [],
    filterPropertyId: "",
    filterRange: "future", // future | past3m | all
    sortKey: "cancelledAt",
    sortDir: "desc",
  },
  _unsubs: [],

  async render(container) {
    container.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <h4 class="mb-0"><i class="bi bi-x-circle"></i> キャンセル予約一覧</h4>
        <span class="ms-3 text-muted small" id="cbSummary">読み込み中...</span>
      </div>
      <div class="card mb-3">
        <div class="card-body py-2">
          <div class="row g-2 align-items-center">
            <div class="col-md-4">
              <label class="form-label small mb-1">物件</label>
              <select class="form-select form-select-sm" id="cbFilterProperty">
                <option value="">すべて</option>
              </select>
            </div>
            <div class="col-md-4">
              <label class="form-label small mb-1">期間 (チェックイン基準)</label>
              <select class="form-select form-select-sm" id="cbFilterRange">
                <option value="future">今日以降</option>
                <option value="past3m">直近3か月</option>
                <option value="all">すべて</option>
              </select>
            </div>
            <div class="col-md-4 text-end">
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
    container.querySelector("#cbFilterProperty").addEventListener("change", (e) => {
      this.state.filterPropertyId = e.target.value;
      this._render();
    });
    container.querySelector("#cbFilterRange").addEventListener("change", (e) => {
      this.state.filterRange = e.target.value;
      this._render();
    });
    container.querySelector("#cbReload").addEventListener("click", () => this._load());
  },

  async _load() {
    const db = firebase.firestore();
    try {
      // 物件取得
      const propsSnap = await db.collection("properties").where("active", "==", true).get();
      this.state.properties = propsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const sel = document.getElementById("cbFilterProperty");
      if (sel) {
        sel.innerHTML = '<option value="">すべて</option>' +
          this.state.properties.map(p => `<option value="${this._esc(p.id)}">${this._esc(p.name || p.id)}</option>`).join("");
        sel.value = this.state.filterPropertyId;
      }

      // cancelled な bookings 取得
      const snap = await db.collection("bookings").where("status", "==", "cancelled").get();
      this.state.bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this._render();
    } catch (e) {
      console.error("[cancelled-bookings] load error:", e);
      const tbody = document.getElementById("cbTbody");
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-danger text-center py-4">読み込み失敗: ${this._esc(e.message || String(e))}</td></tr>`;
    }
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
    // 物件フィルタ
    if (this.state.filterPropertyId) {
      list = list.filter(b => b.propertyId === this.state.filterPropertyId);
    }
    // ソート (キャンセル日時 降順、未設定は最後尾)
    list.sort((a, b) => {
      const aMs = this._toMs(a.cancelledAt);
      const bMs = this._toMs(b.cancelledAt);
      return bMs - aMs;
    });

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

    // クリックハンドラ
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
          // ローカルから除外して再描画
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

  cleanup() {
    this._unsubs.forEach(u => { try { u(); } catch (_) {} });
    this._unsubs = [];
  },
};
