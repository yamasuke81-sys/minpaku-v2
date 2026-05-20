/**
 * お知らせページ — スタッフ・オーナー共通
 * 清掃の指摘事項・手順変更などを随時投稿。スタッフも投稿可。
 *
 * Firestore: announcements/{id}
 *   - title, body, photos[{url, path}], createdAt, createdBy{uid, staffId, name, role}, updatedAt
 *
 * 並び順: createdAt desc (最新が上)
 * 検索: title/body にキーワードを含むものをクライアント側でフィルタ
 */
const AnnouncementsPage = {
  _unsub: null,
  _items: [],
  _filter: "",

  async render(container) {
    this.detach();
    const isOwner = Auth.isOwner();
    const me = Auth.currentUser || {};
    const myName = me.displayName || me.staffName || me.email || "匿名";

    container.innerHTML = `
      <div class="container-fluid px-3 py-3" style="max-width:900px;margin:0 auto;">
        <div class="d-flex align-items-center justify-content-between mb-3 gap-2 flex-wrap">
          <h4 class="mb-0"><i class="bi bi-megaphone"></i> お知らせ</h4>
          <button class="btn btn-primary" id="annBtnNew">
            <i class="bi bi-plus-lg"></i> 新規投稿
          </button>
        </div>

        <!-- 検索 -->
        <div class="input-group mb-3">
          <span class="input-group-text"><i class="bi bi-search"></i></span>
          <input type="search" class="form-control" id="annSearch"
            placeholder="タイトル・本文をキーワード検索">
          <button class="btn btn-outline-secondary d-none" id="annSearchClear" title="クリア">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>

        <div id="annList">
          <div class="text-center py-4">
            <div class="spinner-border spinner-border-sm text-primary"></div>
            <span class="ms-2 text-muted">読み込み中...</span>
          </div>
        </div>
      </div>

      <!-- 投稿/編集モーダル -->
      <div class="modal fade" id="annEditModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="annEditTitle">新規投稿</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <input type="hidden" id="annEditId">
              <div class="mb-2">
                <label class="form-label">タイトル <span class="text-danger">*</span></label>
                <input type="text" class="form-control" id="annEditTitleInput" maxlength="120" placeholder="例: 玄関のスリッパ補充ルール変更">
              </div>
              <div class="mb-2">
                <label class="form-label">本文 <span class="text-danger">*</span></label>
                <textarea class="form-control" id="annEditBody" rows="6" placeholder="詳細を記入してください"></textarea>
              </div>
              <div class="mb-2">
                <label class="form-label">写真 (複数可、各5MBまで)</label>
                <input type="file" class="form-control" id="annEditPhotos" accept="image/*" multiple>
                <div id="annEditPhotoPreview" class="d-flex flex-wrap gap-2 mt-2"></div>
              </div>
              <div class="alert alert-info small mb-0" id="annEditHint">
                投稿は <strong>スタッフ全員</strong> から見えます。個人情報は書かないでください。
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary" id="annEditSave">
                <i class="bi bi-check-lg"></i> 投稿
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 写真ライトボックス -->
      <div class="modal fade" id="annPhotoModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark">
            <div class="modal-body p-0 text-center">
              <img id="annPhotoModalImg" src="" style="max-width:100%;max-height:80vh;">
            </div>
            <div class="modal-footer border-0 py-1">
              <button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this._bindEvents(myName, isOwner);
    this._listen();
  },

  detach() {
    if (this._unsub) {
      try { this._unsub(); } catch (_) {}
      this._unsub = null;
    }
  },

  _bindEvents(myName, isOwner) {
    document.getElementById("annBtnNew").addEventListener("click", () => this._openEditModal(null));

    const searchEl = document.getElementById("annSearch");
    const clearEl = document.getElementById("annSearchClear");
    searchEl.addEventListener("input", () => {
      this._filter = searchEl.value.trim().toLowerCase();
      clearEl.classList.toggle("d-none", !this._filter);
      this._renderList();
    });
    clearEl.addEventListener("click", () => {
      searchEl.value = "";
      this._filter = "";
      clearEl.classList.add("d-none");
      this._renderList();
    });

    // 写真プレビュー
    const photosInput = document.getElementById("annEditPhotos");
    photosInput.addEventListener("change", () => this._renderPhotoPreview());

    // 投稿/編集モーダル保存
    document.getElementById("annEditSave").addEventListener("click", () => this._save(myName));
  },

  _listen() {
    const db = firebase.firestore();
    this._unsub = db.collection("announcements")
      .orderBy("createdAt", "desc")
      .limit(200)
      .onSnapshot(snap => {
        this._items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._renderList();
      }, err => {
        console.error("announcements listen error:", err);
        document.getElementById("annList").innerHTML =
          `<div class="alert alert-danger">読み込みエラー: ${this._esc(err.message)}</div>`;
      });
  },

  _renderList() {
    const list = document.getElementById("annList");
    if (!list) return;
    const filtered = this._filter
      ? this._items.filter(it => {
          const s = `${it.title || ""}\n${it.body || ""}`.toLowerCase();
          return s.includes(this._filter);
        })
      : this._items;

    if (!filtered.length) {
      list.innerHTML = this._filter
        ? `<div class="text-muted text-center py-4">「${this._esc(this._filter)}」に一致する投稿はありません</div>`
        : `<div class="text-muted text-center py-4">まだ投稿はありません。「新規投稿」から最初のお知らせを追加してください。</div>`;
      return;
    }

    const me = Auth.currentUser || {};
    const myUid = me.uid;
    const isOwner = Auth.isOwner();

    list.innerHTML = filtered.map(it => this._renderCard(it, myUid, isOwner)).join("");

    // 各カードのボタンハンドラ
    list.querySelectorAll("[data-act='edit']").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = this._items.find(x => x.id === btn.dataset.id);
        if (item) this._openEditModal(item);
      });
    });
    list.querySelectorAll("[data-act='delete']").forEach(btn => {
      btn.addEventListener("click", () => this._delete(btn.dataset.id));
    });
    list.querySelectorAll("[data-act='photo']").forEach(img => {
      img.addEventListener("click", () => this._openPhotoModal(img.dataset.url));
    });
  },

  _renderCard(it, myUid, isOwner) {
    const created = this._fmtDate(it.createdAt);
    const updated = it.updatedAt && it.createdAt && it.updatedAt.seconds !== it.createdAt.seconds
      ? `<span class="text-muted small ms-2">(編集: ${this._fmtDate(it.updatedAt)})</span>`
      : "";
    const photos = Array.isArray(it.photos) ? it.photos : [];
    const photoHtml = photos.length ? `
      <div class="d-flex flex-wrap gap-2 mt-2">
        ${photos.map(p => `
          <img src="${this._esc(p.url)}" data-act="photo" data-url="${this._esc(p.url)}"
            style="width:96px;height:96px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid #dee2e6;">
        `).join("")}
      </div>
    ` : "";
    const author = it.createdBy?.name || "匿名";
    const canEdit = isOwner || (it.createdBy?.uid && it.createdBy.uid === myUid);
    const actions = canEdit ? `
      <div class="dropdown">
        <button class="btn btn-sm btn-link text-secondary p-0" data-bs-toggle="dropdown">
          <i class="bi bi-three-dots-vertical"></i>
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><button class="dropdown-item" data-act="edit" data-id="${this._esc(it.id)}">
            <i class="bi bi-pencil"></i> 編集
          </button></li>
          <li><button class="dropdown-item text-danger" data-act="delete" data-id="${this._esc(it.id)}">
            <i class="bi bi-trash"></i> 削除
          </button></li>
        </ul>
      </div>
    ` : "";

    return `
      <div class="card mb-3 shadow-sm">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div class="flex-grow-1">
              <div class="small text-muted">
                <i class="bi bi-calendar3"></i> ${this._esc(created)}
                ${updated}
                <span class="ms-2"><i class="bi bi-person"></i> ${this._esc(author)}</span>
              </div>
              <h6 class="mt-1 mb-2 fw-bold">${this._esc(it.title || "(無題)")}</h6>
              <div style="white-space:pre-wrap;word-break:break-word;">${this._linkify(it.body || "")}</div>
              ${photoHtml}
            </div>
            ${actions}
          </div>
        </div>
      </div>
    `;
  },

  _openEditModal(item) {
    document.getElementById("annEditTitle").textContent = item ? "投稿を編集" : "新規投稿";
    document.getElementById("annEditId").value = item?.id || "";
    document.getElementById("annEditTitleInput").value = item?.title || "";
    document.getElementById("annEditBody").value = item?.body || "";
    document.getElementById("annEditPhotos").value = "";
    // 既存写真をプレビュー
    const prev = document.getElementById("annEditPhotoPreview");
    prev.dataset.existing = JSON.stringify(item?.photos || []);
    this._renderPhotoPreview();
    new bootstrap.Modal(document.getElementById("annEditModal")).show();
  },

  _renderPhotoPreview() {
    const prev = document.getElementById("annEditPhotoPreview");
    const existing = JSON.parse(prev.dataset.existing || "[]");
    const newFiles = Array.from(document.getElementById("annEditPhotos").files || []);
    const existHtml = existing.map((p, idx) => `
      <div class="position-relative" data-existing-idx="${idx}">
        <img src="${this._esc(p.url)}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid #dee2e6;">
        <button type="button" class="btn btn-sm btn-danger position-absolute top-0 end-0 p-0 px-1"
          style="font-size:10px;line-height:1.2;" data-act="remove-existing" data-idx="${idx}" title="削除">×</button>
      </div>
    `).join("");
    const newHtml = newFiles.map((f, idx) => `
      <div class="position-relative" data-new-idx="${idx}">
        <img src="${URL.createObjectURL(f)}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid #0d6efd;">
        <span class="badge bg-primary position-absolute bottom-0 start-0" style="font-size:9px;">新</span>
      </div>
    `).join("");
    prev.innerHTML = existHtml + newHtml;
    prev.querySelectorAll("[data-act='remove-existing']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const arr = JSON.parse(prev.dataset.existing || "[]");
        arr.splice(idx, 1);
        prev.dataset.existing = JSON.stringify(arr);
        this._renderPhotoPreview();
      });
    });
  },

  async _save(myName) {
    const id = document.getElementById("annEditId").value || null;
    const title = document.getElementById("annEditTitleInput").value.trim();
    const body = document.getElementById("annEditBody").value.trim();
    if (!title) { showToast("入力エラー", "タイトルを入力してください", "error"); return; }
    if (!body) { showToast("入力エラー", "本文を入力してください", "error"); return; }

    const saveBtn = document.getElementById("annEditSave");
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 保存中...';

    try {
      const db = firebase.firestore();
      const me = Auth.currentUser || {};
      const newFiles = Array.from(document.getElementById("annEditPhotos").files || []);
      const prev = document.getElementById("annEditPhotoPreview");
      const existing = JSON.parse(prev.dataset.existing || "[]");

      // 新規写真をアップロード
      const newPhotos = [];
      for (let i = 0; i < newFiles.length; i++) {
        const f = newFiles[i];
        if (f.size > 5 * 1024 * 1024) {
          showToast("ファイルサイズ", `${f.name} は5MBを超えています`, "warning");
          continue;
        }
        const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
        const path = `announcements/${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const ref = firebase.storage().ref(path);
        await ref.put(f, { contentType: f.type, customMetadata: { uploadedBy: me.uid || "" } });
        const url = await ref.getDownloadURL();
        newPhotos.push({ url, path });
      }

      const photos = [...existing, ...newPhotos];
      const now = firebase.firestore.FieldValue.serverTimestamp();
      const payload = {
        title, body, photos,
        updatedAt: now,
      };

      if (id) {
        await db.collection("announcements").doc(id).update(payload);
        showToast("更新しました", "", "success");
      } else {
        payload.createdAt = now;
        payload.createdBy = {
          uid: me.uid || null,
          staffId: me.staffId || null,
          name: myName,
          role: me.role || (Auth.isOwner() ? "owner" : "staff"),
        };
        await db.collection("announcements").add(payload);
        showToast("投稿しました", "", "success");
      }

      bootstrap.Modal.getInstance(document.getElementById("annEditModal"))?.hide();
    } catch (e) {
      console.error("save error:", e);
      showToast("保存失敗", e.message, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> 投稿';
    }
  },

  async _delete(id) {
    const ok = await showConfirm("このお知らせを削除しますか? 写真も削除されます。", { title: "削除確認" });
    if (!ok) return;
    try {
      const db = firebase.firestore();
      const snap = await db.collection("announcements").doc(id).get();
      const photos = (snap.data()?.photos) || [];
      // 写真を Storage から削除 (失敗しても続行)
      for (const p of photos) {
        if (!p.path) continue;
        try { await firebase.storage().ref(p.path).delete(); } catch (_) {}
      }
      await db.collection("announcements").doc(id).delete();
      showToast("削除しました", "", "success");
    } catch (e) {
      console.error("delete error:", e);
      showToast("削除失敗", e.message, "error");
    }
  },

  _openPhotoModal(url) {
    document.getElementById("annPhotoModalImg").src = url;
    new bootstrap.Modal(document.getElementById("annPhotoModal")).show();
  },

  _fmtDate(ts) {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}/${m}/${day} ${hh}:${mm}`;
  },

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  _linkify(text) {
    const escaped = this._esc(text);
    return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  },
};
