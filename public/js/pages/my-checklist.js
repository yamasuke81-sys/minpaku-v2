/**
 * スタッフ用チェックリスト入力ページ
 * 一覧表示 + 個別チェックリスト入力
 */
const MyChecklistPage = {
  staffId: null,

  async render(container, params) {
    const isOwner = Auth.isOwner();
    this.staffId = Auth.currentUser?.staffId;
    // オーナーの場合: Auth UIDをstaffId代わりに使う
    if (isOwner && !this.staffId) {
      this.staffId = Auth.currentUser.uid;
    }
    if (!this.staffId) {
      container.innerHTML = '<div class="alert alert-warning m-3">スタッフ情報が取得できません。</div>';
      return;
    }
    this._isOwner = isOwner;

    // パラメータにシフトIDがあれば個別入力画面
    const checklistId = params?.[0];
    if (checklistId) {
      await this.renderInput(container, checklistId);
    } else {
      await this.renderList(container);
    }
  },

  // ========== 一覧表示 ==========

  async renderList(container) {
    container.innerHTML = `
      <div class="container-fluid px-3 py-3">
        <h5 class="mb-3"><i class="bi bi-clipboard-check"></i> チェックリスト</h5>
        <div id="checklistList">
          <div class="text-center py-4">
            <div class="spinner-border spinner-border-sm text-primary"></div>
          </div>
        </div>
      </div>
    `;

    try {
      // 今日のシフトを取得
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      let shiftQuery = db.collection("shifts").where("date", ">=", today).where("date", "<", tomorrow);
      if (!this._isOwner) shiftQuery = shiftQuery.where("staffId", "==", this.staffId);
      const shiftSnap = await shiftQuery.get();

      const shifts = shiftSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      // 既存のチェックリスト記録を取得
      let clQuery = db.collection("checklists");
      if (!this._isOwner) clQuery = clQuery.where("staffId", "==", this.staffId);
      const clSnap = await clQuery.get();
      const existingChecklists = clSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      // 進行中のチェックリスト
      const inProgress = existingChecklists.filter(cl => cl.status === "in_progress");

      const listEl = document.getElementById("checklistList");
      let html = "";

      // 進行中のチェックリスト
      if (inProgress.length > 0) {
        html += '<div class="staff-section-title">進行中</div>';
        for (const cl of inProgress) {
          const checked = (cl.items || []).filter(i => i.checked).length;
          const total = (cl.items || []).length;
          const pct = total > 0 ? Math.round(checked / total * 100) : 0;
          html += `
            <a href="#/my-checklist/${cl.id}" class="card staff-card mb-2 text-decoration-none text-dark">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <div class="fw-bold">${cl.propertyName || cl.propertyId || "物件"}</div>
                    <div class="text-muted small">${checked}/${total} 完了</div>
                  </div>
                  <div class="text-end">
                    <div class="progress" style="width:80px;height:8px;">
                      <div class="progress-bar bg-success" style="width:${pct}%"></div>
                    </div>
                    <i class="bi bi-chevron-right text-muted mt-1"></i>
                  </div>
                </div>
              </div>
            </a>
          `;
        }
      }

      // 今日のシフト（チェックリスト未開始）
      const shiftsWithoutChecklist = shifts.filter(s =>
        !existingChecklists.some(cl => cl.shiftId === s.id && cl.status !== "completed")
      );

      if (shiftsWithoutChecklist.length > 0) {
        html += '<div class="staff-section-title">今日のシフト</div>';
        for (const s of shiftsWithoutChecklist) {
          html += `
            <div class="card staff-card mb-2">
              <div class="card-body d-flex justify-content-between align-items-center">
                <div>
                  <div class="fw-bold">${s.propertyName || s.propertyId || "物件"}</div>
                  <div class="text-muted small"><i class="bi bi-clock"></i> ${s.startTime || "未定"}</div>
                </div>
                <button class="btn btn-primary btn-sm start-checklist-btn" data-shift-id="${s.id}" data-property-id="${s.propertyId || ""}">
                  <i class="bi bi-play-fill"></i> 開始
                </button>
              </div>
            </div>
          `;
        }
      }

      if (!html) {
        html = `
          <div class="text-center py-5 text-muted">
            <i class="bi bi-clipboard-check" style="font-size:2rem;"></i>
            <p class="mt-2">今日のチェックリストはありません</p>
          </div>
        `;
      }

      listEl.innerHTML = html;

      // チェックリスト開始ボタン
      listEl.querySelectorAll(".start-checklist-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const shiftId = e.currentTarget.dataset.shiftId;
          const propertyId = e.currentTarget.dataset.propertyId;
          await this.startChecklist(shiftId, propertyId);
        });
      });
    } catch (e) {
      console.error("チェックリスト一覧エラー:", e);
      document.getElementById("checklistList").innerHTML = `
        <div class="alert alert-danger">読み込みエラー: ${e.message}</div>
      `;
    }
  },

  async startChecklist(shiftId, propertyId) {
    try {
      // テンプレート取得（物件に紐付くもの）
      let template = null;
      if (propertyId) {
        const tSnap = await db.collection("checklistTemplates")
          .where("propertyId", "==", propertyId)
          .limit(1)
          .get();
        if (!tSnap.empty) template = tSnap.docs[0].data();
      }

      // テンプレートがなければデフォルト
      const items = template?.items?.map(i => ({
        name: i.name,
        required: i.required || false,
        photoRequired: i.photoRequired || false,
        checked: false,
        note: "",
        photoUrl: null,
      })) || [
        { name: "ゴミ回収", checked: false, note: "", photoUrl: null },
        { name: "掃除機", checked: false, note: "", photoUrl: null },
        { name: "水回り清掃", checked: false, note: "", photoUrl: null },
        { name: "ベッドメイキング", checked: false, note: "", photoUrl: null },
        { name: "アメニティ補充", checked: false, note: "", photoUrl: null },
        { name: "最終確認", checked: false, note: "", photoUrl: null },
      ];

      // シフトの物件名を取得
      const shiftDoc = await db.collection("shifts").doc(shiftId).get();
      const shiftData = shiftDoc.exists ? shiftDoc.data() : {};

      const clRef = await db.collection("checklists").add({
        shiftId,
        propertyId,
        propertyName: shiftData.propertyName || propertyId || "",
        staffId: this.staffId,
        items,
        status: "in_progress",
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        completedAt: null,
      });

      location.hash = `/my-checklist/${clRef.id}`;
    } catch (e) {
      console.error("チェックリスト開始エラー:", e);
      showToast("エラー", `チェックリスト開始に失敗: ${e.message}`, "error");
    }
  },

  // ========== 個別入力画面 ==========

  async renderInput(container, checklistId) {
    container.innerHTML = `
      <div class="container-fluid px-3 py-3">
        <div class="d-flex align-items-center mb-3">
          <a href="#/my-checklist" class="btn btn-sm btn-outline-secondary me-2">
            <i class="bi bi-arrow-left"></i>
          </a>
          <h5 class="mb-0"><i class="bi bi-clipboard-check"></i> チェックリスト</h5>
        </div>
        <div id="checklistInput">
          <div class="text-center py-4">
            <div class="spinner-border spinner-border-sm text-primary"></div>
          </div>
        </div>
      </div>
    `;

    try {
      const doc = await db.collection("checklists").doc(checklistId).get();
      if (!doc.exists) {
        document.getElementById("checklistInput").innerHTML = '<div class="alert alert-warning">チェックリストが見つかりません</div>';
        return;
      }

      const checklist = { id: doc.id, ...doc.data() };
      this.renderChecklistItems(checklist);
    } catch (e) {
      console.error("チェックリスト読み込みエラー:", e);
      document.getElementById("checklistInput").innerHTML = `
        <div class="alert alert-danger">読み込みエラー: ${e.message}</div>
      `;
    }
  },

  renderChecklistItems(checklist) {
    const items = checklist.items || [];
    const checked = items.filter(i => i.checked).length;
    const total = items.length;
    const pct = total > 0 ? Math.round(checked / total * 100) : 0;
    const isCompleted = checklist.status === "completed";

    let html = `
      <div class="card mb-3">
        <div class="card-body">
          <div class="fw-bold">${checklist.propertyName || "物件"}</div>
          <div class="progress mt-2" style="height:10px;">
            <div class="progress-bar bg-success" style="width:${pct}%"></div>
          </div>
          <div class="text-muted small mt-1">${checked}/${total} 完了 (${pct}%)</div>
        </div>
      </div>
    `;

    // チェック項目
    items.forEach((item, idx) => {
      html += `
        <div class="checklist-item card mb-2">
          <div class="card-body py-2 px-3">
            <div class="d-flex align-items-start">
              <input type="checkbox" class="form-check-input me-3 mt-1 checklist-check"
                     data-idx="${idx}" ${item.checked ? "checked" : ""} ${isCompleted ? "disabled" : ""}
                     style="transform:scale(1.4);min-width:20px;">
              <div class="flex-grow-1">
                <div class="${item.checked ? "text-decoration-line-through text-muted" : "fw-medium"}">${item.name}</div>
                <input type="text" class="form-control form-control-sm mt-1 checklist-note"
                       data-idx="${idx}" placeholder="メモ（任意）"
                       value="${item.note || ""}" ${isCompleted ? "disabled" : ""}>
                ${item.photoUrl ? `<img src="${item.photoUrl}" class="mt-1 rounded" style="max-width:100px;max-height:80px;">` : ""}
                ${!isCompleted ? `
                  <label class="btn btn-sm btn-outline-secondary mt-1">
                    <i class="bi bi-camera"></i> 写真
                    <input type="file" accept="image/*" capture="environment" class="d-none checklist-photo" data-idx="${idx}">
                  </label>
                ` : ""}
              </div>
            </div>
          </div>
        </div>
      `;
    });

    // 完了報告ボタン
    if (!isCompleted) {
      html += `
        <button class="btn btn-success btn-lg w-100 mt-3" id="btnComplete" ${checked < total ? "disabled" : ""}>
          <i class="bi bi-check-circle"></i> 清掃完了報告
        </button>
        <p class="text-muted small text-center mt-1">
          ${checked < total ? "全項目をチェックすると完了報告できます" : ""}
        </p>
      `;
    } else {
      html += `
        <div class="alert alert-success text-center mt-3">
          <i class="bi bi-check-circle-fill"></i> 清掃完了済み
        </div>
      `;
    }

    const inputEl = document.getElementById("checklistInput");
    inputEl.innerHTML = html;

    if (isCompleted) return;

    // チェックボックスイベント
    inputEl.querySelectorAll(".checklist-check").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const idx = parseInt(e.target.dataset.idx);
        checklist.items[idx].checked = e.target.checked;
        this.saveChecklist(checklist);
        // 画面を再描画（進捗バー・完了ボタン更新）
        this.renderChecklistItems(checklist);
      });
    });

    // メモ入力（デバウンス付き自動保存）
    let saveTimer = null;
    inputEl.querySelectorAll(".checklist-note").forEach(input => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(e.target.dataset.idx);
        checklist.items[idx].note = e.target.value;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => this.saveChecklist(checklist), 1000);
      });
    });

    // 写真アップロード
    inputEl.querySelectorAll(".checklist-photo").forEach(input => {
      input.addEventListener("change", async (e) => {
        const idx = parseInt(e.target.dataset.idx);
        const file = e.target.files[0];
        if (!file) return;

        try {
          const storageRef = firebase.storage().ref();
          const path = `checklist-photos/${checklist.id}/${idx}_${Date.now()}.jpg`;
          const ref = storageRef.child(path);
          await ref.put(file);
          const url = await ref.getDownloadURL();
          checklist.items[idx].photoUrl = url;
          await this.saveChecklist(checklist);
          this.renderChecklistItems(checklist);
          showToast("成功", "写真をアップロードしました", "success");
        } catch (err) {
          console.error("写真アップロードエラー:", err);
          showToast("エラー", "写真のアップロードに失敗しました", "error");
        }
      });
    });

    // 完了報告ボタン
    const btnComplete = document.getElementById("btnComplete");
    if (btnComplete) {
      btnComplete.addEventListener("click", async () => {
        if (!confirm("清掃完了を報告しますか？")) return;
        try {
          checklist.status = "completed";
          checklist.completedAt = new Date();
          await db.collection("checklists").doc(checklist.id).update({
            items: checklist.items,
            status: "completed",
            completedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          showToast("完了", "清掃完了を報告しました", "success");
          this.renderChecklistItems(checklist);
        } catch (err) {
          console.error("完了報告エラー:", err);
          showToast("エラー", "完了報告に失敗しました", "error");
        }
      });
    }
  },

  async saveChecklist(checklist) {
    try {
      await db.collection("checklists").doc(checklist.id).update({
        items: checklist.items,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error("チェックリスト保存エラー:", e);
    }
  },
};
