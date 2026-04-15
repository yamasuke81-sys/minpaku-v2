/**
 * スタッフ用チェックリストページ
 * - 新規開始（シフト不要）
 * - 進行中一覧
 * - 過去の清掃記録（月フィルタ）
 * - 個別入力画面
 */
const MyChecklistPage = {
  staffId: null,
  _isOwner: false,
  // 入力画面の自動保存タイマー
  _saveTimer: null,

  async render(container, params) {
    const isOwner = Auth.isOwner();
    this.staffId = Auth.currentUser?.staffId;
    // オーナーはUIDをstaffId代わりに使う
    if (isOwner && !this.staffId) {
      this.staffId = Auth.currentUser.uid;
    }
    if (!this.staffId) {
      container.innerHTML = '<div class="alert alert-warning m-3">スタッフ情報が取得できません。再ログインしてください。</div>';
      return;
    }
    this._isOwner = isOwner;

    // params[0] があれば個別入力画面
    const checklistId = params?.[0];
    if (checklistId) {
      await this._renderInput(container, checklistId);
    } else {
      await this._renderList(container);
    }
  },

  // =====================================================
  // 一覧画面
  // =====================================================

  async _renderList(container) {
    container.innerHTML = `
      <div class="container-fluid px-3 py-3">
        <h5 class="mb-3"><i class="bi bi-clipboard-check"></i> チェックリスト</h5>

        <!-- 新規開始セクション -->
        <div class="card mb-3 border-primary">
          <div class="card-header bg-primary text-white py-2">
            <i class="bi bi-plus-circle"></i> 新規チェックリスト開始
          </div>
          <div class="card-body">
            <div class="mb-2">
              <select id="newChecklistProperty" class="form-select">
                <option value="">-- 物件を選択 --</option>
              </select>
            </div>
            <button id="btnStartChecklist" class="btn btn-primary w-100" disabled>
              <i class="bi bi-play-fill"></i> チェックリスト開始
            </button>
          </div>
        </div>

        <!-- 進行中 -->
        <div class="staff-section-title">進行中のチェックリスト</div>
        <div id="inProgressList">
          <div class="text-center py-3"><div class="spinner-border spinner-border-sm text-primary"></div></div>
        </div>

        <!-- 過去の記録 -->
        <div class="d-flex align-items-center justify-content-between mt-3 mb-1">
          <span class="staff-section-title mb-0">過去の清掃記録</span>
          <select id="historyMonthFilter" class="form-select form-select-sm" style="width:auto;">
          </select>
        </div>
        <div id="historyList">
          <div class="text-center py-3"><div class="spinner-border spinner-border-sm text-secondary"></div></div>
        </div>
      </div>
    `;

    // 物件セレクタ・チェックリスト同時読み込み
    await Promise.all([
      this._loadProperties(),
      this._loadChecklists(),
    ]);
  },

  async _loadProperties() {
    try {
      const snap = await db.collection("properties").where("active", "==", true).get();
      const select = document.getElementById("newChecklistProperty");
      if (!select) return;

      snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"))
        .forEach(p => {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.name || p.id;
          select.appendChild(opt);
        });

      select.addEventListener("change", () => {
        const btn = document.getElementById("btnStartChecklist");
        if (btn) btn.disabled = !select.value;
      });

      const btn = document.getElementById("btnStartChecklist");
      if (btn) {
        btn.addEventListener("click", async () => {
          const propertyId = select.value;
          const propertyName = select.options[select.selectedIndex]?.textContent || propertyId;
          if (!propertyId) return;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 開始中...';
          await this._startChecklist(propertyId, propertyName);
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-play-fill"></i> チェックリスト開始';
        });
      }
    } catch (e) {
      console.error("物件取得エラー:", e);
    }
  },

  async _loadChecklists() {
    try {
      let query = db.collection("checklists").orderBy("startedAt", "desc").limit(100);
      if (!this._isOwner) {
        query = db.collection("checklists")
          .where("staffId", "==", this.staffId)
          .orderBy("startedAt", "desc")
          .limit(100);
      }

      const snap = await query.get();
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // 進行中
      const inProgress = all.filter(cl => cl.status === "in_progress");
      this._renderInProgress(inProgress);

      // 月フィルタ生成 & 過去記録
      const completed = all.filter(cl => cl.status === "completed");
      this._initMonthFilter(completed);
    } catch (e) {
      console.error("チェックリスト取得エラー:", e);
      const inEl = document.getElementById("inProgressList");
      if (inEl) inEl.innerHTML = `<div class="alert alert-danger">読み込みエラー: ${e.message}</div>`;
    }
  },

  _renderInProgress(list) {
    const el = document.getElementById("inProgressList");
    if (!el) return;

    if (list.length === 0) {
      el.innerHTML = '<p class="text-muted small px-1 py-2">進行中のチェックリストはありません</p>';
      return;
    }

    el.innerHTML = list.map(cl => {
      const items = cl.items || [];
      const checked = items.filter(i => i.checked).length;
      const total = items.length;
      const pct = total > 0 ? Math.round(checked / total * 100) : 0;
      const dateStr = cl.startedAt ? formatDate(cl.startedAt) : "-";
      return `
        <a href="#/my-checklist/${cl.id}" class="card staff-card mb-2 text-decoration-none text-dark">
          <div class="card-body py-2 px-3">
            <div class="d-flex justify-content-between align-items-center">
              <div>
                <div class="fw-bold">${cl.propertyName || cl.propertyId || "物件"}</div>
                <div class="text-muted small">${dateStr} &nbsp;${checked}/${total} 完了</div>
              </div>
              <div class="text-end" style="min-width:90px;">
                <div class="progress mb-1" style="height:6px;">
                  <div class="progress-bar bg-primary" style="width:${pct}%"></div>
                </div>
                <small class="text-primary fw-bold">${pct}%</small>
                <i class="bi bi-chevron-right text-muted ms-2"></i>
              </div>
            </div>
          </div>
        </a>
      `;
    }).join("");
  },

  _initMonthFilter(completed) {
    const select = document.getElementById("historyMonthFilter");
    if (!select) return;

    // 月一覧を生成（重複なし、降順）
    const months = [...new Set(
      completed
        .map(cl => {
          const d = cl.completedAt
            ? (cl.completedAt.toDate ? cl.completedAt.toDate() : new Date(cl.completedAt))
            : null;
          if (!d || isNaN(d)) return null;
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        })
        .filter(Boolean)
    )].sort().reverse();

    if (months.length === 0) {
      // 今月を追加
      const now = new Date();
      months.push(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
    }

    months.forEach((m, i) => {
      const opt = document.createElement("option");
      opt.value = m;
      const [y, mo] = m.split("-");
      opt.textContent = `${y}年${parseInt(mo)}月`;
      if (i === 0) opt.selected = true;
      select.appendChild(opt);
    });

    this._renderHistory(completed, months[0]);

    select.addEventListener("change", () => {
      this._renderHistory(completed, select.value);
    });
  },

  _renderHistory(completed, month) {
    const el = document.getElementById("historyList");
    if (!el) return;

    const filtered = completed.filter(cl => {
      const d = cl.completedAt
        ? (cl.completedAt.toDate ? cl.completedAt.toDate() : new Date(cl.completedAt))
        : null;
      if (!d || isNaN(d)) return false;
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      return m === month;
    });

    if (filtered.length === 0) {
      el.innerHTML = '<p class="text-muted small px-1 py-2">この月の記録はありません</p>';
      return;
    }

    // 降順
    filtered.sort((a, b) => {
      const ta = a.completedAt?.toDate ? a.completedAt.toDate() : new Date(a.completedAt || 0);
      const tb = b.completedAt?.toDate ? b.completedAt.toDate() : new Date(b.completedAt || 0);
      return tb - ta;
    });

    el.innerHTML = filtered.map(cl => {
      const items = cl.items || [];
      const checked = items.filter(i => i.checked).length;
      const total = items.length;
      const pct = total > 0 ? Math.round(checked / total * 100) : 0;
      const dateStr = cl.completedAt ? formatDate(cl.completedAt) : "-";
      const statusBadge = cl.status === "completed"
        ? '<span class="badge bg-success">完了</span>'
        : '<span class="badge bg-warning text-dark">進行中</span>';
      return `
        <a href="#/my-checklist/${cl.id}" class="card staff-card mb-2 text-decoration-none text-dark">
          <div class="card-body py-2 px-3">
            <div class="d-flex justify-content-between align-items-start">
              <div>
                <div class="fw-bold">${cl.propertyName || cl.propertyId || "物件"}</div>
                <div class="text-muted small">${dateStr}</div>
                ${cl.staffName ? `<div class="text-muted small"><i class="bi bi-person"></i> ${cl.staffName}</div>` : ""}
              </div>
              <div class="text-end">
                ${statusBadge}
                <div class="text-muted small mt-1">${checked}/${total}</div>
              </div>
            </div>
          </div>
        </a>
      `;
    }).join("");
  },

  // =====================================================
  // チェックリスト開始
  // =====================================================

  async _startChecklist(propertyId, propertyName) {
    try {
      // テンプレート取得
      const tSnap = await db.collection("checklistTemplates")
        .where("propertyId", "==", propertyId)
        .limit(1)
        .get();

      let items;
      if (!tSnap.empty) {
        const tpl = tSnap.docs[0].data();
        items = (tpl.items || []).map(i => ({
          name: i.name || "",
          required: i.required || false,
          photoRequired: i.photoRequired || false,
          checked: false,
          note: "",
          photoUrl: null,
        }));
      } else {
        // デフォルト6項目
        items = [
          { name: "ゴミ回収", required: true, photoRequired: false, checked: false, note: "", photoUrl: null },
          { name: "掃除機", required: true, photoRequired: false, checked: false, note: "", photoUrl: null },
          { name: "水回り清掃", required: true, photoRequired: true, checked: false, note: "", photoUrl: null },
          { name: "ベッドメイキング", required: true, photoRequired: true, checked: false, note: "", photoUrl: null },
          { name: "アメニティ補充", required: false, photoRequired: false, checked: false, note: "", photoUrl: null },
          { name: "最終確認", required: true, photoRequired: false, checked: false, note: "", photoUrl: null },
        ];
      }

      // スタッフ名を取得（オーナーの場合はfallback）
      let staffName = "オーナー";
      if (!this._isOwner) {
        try {
          const sDoc = await db.collection("staff").doc(this.staffId).get();
          staffName = sDoc.exists ? (sDoc.data().name || this.staffId) : this.staffId;
        } catch (_) {}
      } else {
        staffName = Auth.currentUser?.displayName || Auth.currentUser?.email || "オーナー";
      }

      const clRef = await db.collection("checklists").add({
        shiftId: "",
        propertyId,
        propertyName,
        staffId: this.staffId,
        staffName,
        items,
        status: "in_progress",
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        completedAt: null,
      });

      location.hash = `/my-checklist/${clRef.id}`;
    } catch (e) {
      console.error("チェックリスト開始エラー:", e);
      showToast("エラー", `チェックリスト開始に失敗しました: ${e.message}`, "error");
    }
  },

  // =====================================================
  // 個別入力画面
  // =====================================================

  async _renderInput(container, checklistId) {
    container.innerHTML = `
      <div class="container-fluid px-3 py-3">
        <div class="d-flex align-items-center mb-3">
          <a href="#/my-checklist" class="btn btn-sm btn-outline-secondary me-2">
            <i class="bi bi-arrow-left"></i>
          </a>
          <h5 class="mb-0"><i class="bi bi-clipboard-check"></i> チェックリスト</h5>
        </div>
        <div id="checklistInputArea">
          <div class="text-center py-5">
            <div class="spinner-border text-primary"></div>
          </div>
        </div>
      </div>
    `;

    try {
      const doc = await db.collection("checklists").doc(checklistId).get();
      if (!doc.exists) {
        document.getElementById("checklistInputArea").innerHTML =
          '<div class="alert alert-warning">チェックリストが見つかりません</div>';
        return;
      }
      const checklist = { id: doc.id, ...doc.data() };
      this._renderItems(checklist);
    } catch (e) {
      console.error("チェックリスト読み込みエラー:", e);
      const el = document.getElementById("checklistInputArea");
      if (el) el.innerHTML = `<div class="alert alert-danger">読み込みエラー: ${e.message}</div>`;
    }
  },

  _renderItems(checklist) {
    const items = checklist.items || [];
    const checkedCount = items.filter(i => i.checked).length;
    const total = items.length;
    const pct = total > 0 ? Math.round(checkedCount / total * 100) : 0;
    const isCompleted = checklist.status === "completed";

    // 写真必須で写真未添付のチェック済み項目があるか
    const photoBlockers = items.filter(i => i.photoRequired && !i.photoUrl && !isCompleted);
    const canComplete = checkedCount === total && photoBlockers.length === 0;

    let html = `
      <!-- ヘッダー情報 -->
      <div class="card mb-3">
        <div class="card-body py-2">
          <div class="fw-bold fs-6">${checklist.propertyName || "物件"}</div>
          <div class="text-muted small">
            ${checklist.startedAt ? formatDate(checklist.startedAt) : ""}
            ${checklist.staffName ? ` &nbsp;<i class="bi bi-person"></i> ${checklist.staffName}` : ""}
          </div>
          <div class="progress mt-2" style="height:10px;">
            <div class="progress-bar ${pct === 100 ? "bg-success" : "bg-primary"}" style="width:${pct}%;transition:width 0.3s;"></div>
          </div>
          <div class="d-flex justify-content-between mt-1">
            <small class="text-muted">${checkedCount}/${total} 完了</small>
            <small class="fw-bold ${pct === 100 ? "text-success" : "text-primary"}">${pct}%</small>
          </div>
        </div>
      </div>
    `;

    // チェック項目
    items.forEach((item, idx) => {
      const badgeHtml = item.required
        ? '<span class="badge bg-danger ms-1" style="font-size:0.65rem;">必須</span>'
        : "";
      const photoBadge = item.photoRequired
        ? '<span class="badge bg-warning text-dark ms-1" style="font-size:0.65rem;"><i class="bi bi-camera"></i> 写真必須</span>'
        : "";
      const nameClass = item.checked ? "text-decoration-line-through text-muted" : "fw-medium";
      const photoPreview = item.photoUrl
        ? `<div class="mt-1">
             <img src="${item.photoUrl}" class="rounded border" style="max-width:120px;max-height:90px;object-fit:cover;" loading="lazy">
           </div>`
        : "";
      const photoBtn = !isCompleted
        ? `<label class="btn btn-sm btn-outline-secondary mt-1">
             <i class="bi bi-camera"></i> 写真${item.photoRequired && !item.photoUrl ? '<span class="text-danger">*</span>' : ""}
             <input type="file" accept="image/*" capture="environment" class="d-none cl-photo" data-idx="${idx}">
           </label>`
        : "";

      html += `
        <div class="card mb-2 ${item.checked ? "border-success" : ""}">
          <div class="card-body py-2 px-3">
            <div class="d-flex align-items-start gap-2">
              <input type="checkbox" class="form-check-input mt-1 cl-check"
                     data-idx="${idx}"
                     ${item.checked ? "checked" : ""}
                     ${isCompleted ? "disabled" : ""}
                     style="transform:scale(1.5);min-width:20px;cursor:pointer;">
              <div class="flex-grow-1">
                <div class="d-flex flex-wrap align-items-center gap-1 mb-1">
                  <span class="${nameClass}">${item.name}</span>
                  ${badgeHtml}${photoBadge}
                </div>
                <input type="text" class="form-control form-control-sm cl-note"
                       data-idx="${idx}"
                       placeholder="メモ（任意）"
                       value="${this._escapeAttr(item.note || "")}"
                       ${isCompleted ? "disabled" : ""}>
                ${photoPreview}
                ${photoBtn}
              </div>
            </div>
          </div>
        </div>
      `;
    });

    // 完了報告 or 完了済み表示
    if (!isCompleted) {
      const completeDisabledAttr = canComplete ? "" : "disabled";
      let hintText = "";
      if (checkedCount < total) {
        hintText = "全項目をチェックすると完了報告できます";
      } else if (photoBlockers.length > 0) {
        hintText = `写真必須の項目（${photoBlockers.map(i => i.name).join("、")}）に写真を追加してください`;
      }
      html += `
        <button class="btn btn-success btn-lg w-100 mt-3" id="btnComplete" ${completeDisabledAttr}>
          <i class="bi bi-check-circle"></i> 清掃完了報告
        </button>
        ${hintText ? `<p class="text-muted small text-center mt-1">${hintText}</p>` : ""}
      `;
    } else {
      html += `
        <div class="alert alert-success text-center mt-3">
          <i class="bi bi-check-circle-fill"></i> 清掃完了済み
          ${checklist.completedAt ? `<div class="small">${formatDate(checklist.completedAt)}</div>` : ""}
        </div>
      `;
    }

    const area = document.getElementById("checklistInputArea");
    area.innerHTML = html;

    if (isCompleted) return;

    // チェックボックスイベント
    area.querySelectorAll(".cl-check").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const idx = parseInt(e.target.dataset.idx);
        checklist.items[idx].checked = e.target.checked;
        this._saveChecklist(checklist);
        this._renderItems(checklist);
      });
    });

    // メモ（デバウンス自動保存）
    area.querySelectorAll(".cl-note").forEach(input => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(e.target.dataset.idx);
        checklist.items[idx].note = e.target.value;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._saveChecklist(checklist), 1000);
      });
    });

    // 写真アップロード
    area.querySelectorAll(".cl-photo").forEach(input => {
      input.addEventListener("change", async (e) => {
        const idx = parseInt(e.target.dataset.idx);
        const file = e.target.files[0];
        if (!file) return;

        // ラベルをアップロード中表示
        const label = e.target.closest("label");
        if (label) label.innerHTML = '<span class="spinner-border spinner-border-sm"></span> アップロード中...';

        try {
          const path = `checklist-photos/${checklist.id}/${idx}_${Date.now()}.jpg`;
          const ref = firebase.storage().ref().child(path);
          await ref.put(file);
          const url = await ref.getDownloadURL();
          checklist.items[idx].photoUrl = url;
          await this._saveChecklist(checklist);
          this._renderItems(checklist);
          showToast("成功", "写真をアップロードしました", "success");
        } catch (err) {
          console.error("写真アップロードエラー:", err);
          showToast("エラー", "写真のアップロードに失敗しました", "error");
          this._renderItems(checklist);
        }
      });
    });

    // 完了報告ボタン
    const btnComplete = document.getElementById("btnComplete");
    if (btnComplete) {
      btnComplete.addEventListener("click", async () => {
        if (!confirm("清掃完了を報告しますか？")) return;
        btnComplete.disabled = true;
        btnComplete.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...';
        try {
          await db.collection("checklists").doc(checklist.id).update({
            items: checklist.items,
            status: "completed",
            completedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          checklist.status = "completed";
          checklist.completedAt = new Date();
          showToast("完了", "清掃完了を報告しました", "success");
          this._renderItems(checklist);
        } catch (err) {
          console.error("完了報告エラー:", err);
          showToast("エラー", "完了報告に失敗しました", "error");
          btnComplete.disabled = false;
          btnComplete.innerHTML = '<i class="bi bi-check-circle"></i> 清掃完了報告';
        }
      });
    }
  },

  // =====================================================
  // Firestore保存
  // =====================================================

  async _saveChecklist(checklist) {
    try {
      await db.collection("checklists").doc(checklist.id).update({
        items: checklist.items,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error("チェックリスト保存エラー:", e);
    }
  },

  // =====================================================
  // ユーティリティ
  // =====================================================

  _escapeAttr(str) {
    return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },
};
