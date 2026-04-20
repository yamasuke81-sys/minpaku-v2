/**
 * 物件別 iCal URL 管理パネル (共有モジュール)
 *
 * 物件詳細モーダル / 予約フロー構成画面の両方から使う。
 * syncSettings コレクションを参照し、両画面で自動的に双方向同期される。
 *
 * 使い方:
 *   window.propertyIcalPanel.render(containerEl, propertyId);
 *
 * 依存:
 *   - window.db (Firestore)
 *   - window.showConfirm / window.showToast
 *   - window.firebase.firestore.FieldValue
 */
(function (global) {
  "use strict";

  // HTML エスケープ
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // URL からプラットフォームを推定
  function detectPlatform(url) {
    const u = (url || "").trim().toLowerCase();
    if (!u) return "";
    if (u.includes("airbnb")) return "Airbnb";
    if (u.includes("booking.com")) return "Booking.com";
    if (u.includes("beds24")) return "Beds24";
    if (u.includes("vrbo") || u.includes("homeaway")) return "VRBO";
    if (u.includes("agoda")) return "Agoda";
    if (u.includes("expedia")) return "Expedia";
    return "other";
  }

  // パネル全体のHTMLを生成 (入力フォーム+リスト領域)
  function buildPanelHtml(instanceId) {
    return `
      <div class="ical-panel" data-instance="${instanceId}">
        <div class="ical-panel-list mb-2">
          <div class="text-center py-2 text-muted small"><div class="spinner-border spinner-border-sm"></div> 読み込み中...</div>
        </div>
        <div class="input-group input-group-sm ical-panel-addrow">
          <input type="url" class="form-control ical-panel-url" placeholder="https://www.airbnb.com/calendar/ical/xxxxx.ics">
          <input type="text" class="form-control ical-panel-platform" readonly placeholder="自動検出" style="max-width:120px">
          <button type="button" class="btn btn-outline-primary ical-panel-add">
            <i class="bi bi-plus-lg"></i> 追加
          </button>
        </div>
      </div>
    `;
  }

  // syncSettings を読み込んでリスト領域に描画
  async function loadList(container, propertyId) {
    const listEl = container.querySelector(".ical-panel-list");
    if (!listEl) return;

    try {
      const snap = await db.collection("syncSettings")
        .where("propertyId", "==", propertyId).get();

      if (snap.empty) {
        listEl.innerHTML = '<p class="text-muted small mb-1">iCal URLが未登録です。</p>';
        return;
      }

      let html = '<div class="list-group list-group-flush border rounded mb-2">';
      snap.forEach(doc => {
        const d = doc.data();
        const lastSync = d.lastSync
          ? new Date(d.lastSync.seconds * 1000).toLocaleString("ja-JP")
          : "未同期";
        const statusBadge = d.active === false
          ? '<span class="badge bg-secondary ms-1">無効</span>'
          : '<span class="badge bg-success ms-1">有効</span>';
        const urlStr = d.icalUrl || "";
        html += `
          <div class="list-group-item py-2 px-3">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1 me-2">
                <strong>${escapeHtml(d.platform || "unknown")}</strong>${statusBadge}
                <br><small class="text-muted font-monospace">${escapeHtml(urlStr.slice(0, 70))}${urlStr.length > 70 ? "…" : ""}</small>
                <br><small class="text-muted">最終同期: ${lastSync}</small>
                ${d.lastSyncResult ? `<br><small class="text-muted">結果: ${escapeHtml(d.lastSyncResult)}</small>` : ""}
              </div>
              <div class="btn-group btn-group-sm flex-shrink-0">
                <button class="btn btn-outline-${d.active === false ? "success" : "warning"} ical-panel-toggle"
                  data-id="${doc.id}" data-active="${d.active !== false}">
                  <i class="bi bi-${d.active === false ? "play" : "pause"}"></i>
                </button>
                <button class="btn btn-outline-danger ical-panel-delete" data-id="${doc.id}">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
            </div>
          </div>`;
      });
      html += "</div>";
      listEl.innerHTML = html;

    } catch (e) {
      listEl.innerHTML = `<div class="alert alert-danger py-1 small">読み込みエラー: ${escapeHtml(e.message)}</div>`;
    }
  }

  // コンテナ内のイベントをバインド (一度だけ)
  function bindEvents(container, propertyId) {
    if (container.dataset.icalBound === "1") {
      // 既にバインド済なら propertyId だけ更新
      container.dataset.icalPid = propertyId;
      return;
    }
    container.dataset.icalBound = "1";
    container.dataset.icalPid = propertyId;

    const urlInput = container.querySelector(".ical-panel-url");
    const platformInput = container.querySelector(".ical-panel-platform");
    const addBtn = container.querySelector(".ical-panel-add");

    // URL 入力でプラットフォーム自動検出
    if (urlInput) {
      urlInput.addEventListener("input", () => {
        if (platformInput) platformInput.value = detectPlatform(urlInput.value);
      });
    }

    // 追加ボタン
    if (addBtn) {
      addBtn.addEventListener("click", async () => {
        const url = urlInput?.value.trim() || "";
        const platform = platformInput?.value.trim() || "other";
        const pid = container.dataset.icalPid;
        if (!url || !url.startsWith("http")) {
          showToast("エラー", "正しいiCal URLを入力してください", "error");
          return;
        }
        try {
          await db.collection("syncSettings").add({
            icalUrl: url,
            platform: platform || "other",
            propertyId: pid,
            active: true,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          if (urlInput) urlInput.value = "";
          if (platformInput) platformInput.value = "";
          showToast("追加", `${platform || "iCal"} URLを登録しました`, "success");
          loadList(container, pid);
        } catch (e) {
          showToast("エラー", `登録失敗: ${e.message}`, "error");
        }
      });
    }

    // リスト領域内のトグル/削除はイベント委譲で捕捉
    container.addEventListener("click", async (e) => {
      const toggleBtn = e.target.closest(".ical-panel-toggle");
      const deleteBtn = e.target.closest(".ical-panel-delete");
      const pid = container.dataset.icalPid;

      if (toggleBtn) {
        const id = toggleBtn.dataset.id;
        const isActive = toggleBtn.dataset.active === "true";
        try {
          await db.collection("syncSettings").doc(id).update({ active: !isActive });
          showToast("更新", isActive ? "iCal同期を無効化しました" : "iCal同期を有効化しました", "info");
          loadList(container, pid);
        } catch (err) {
          showToast("エラー", `更新失敗: ${err.message}`, "error");
        }
        return;
      }

      if (deleteBtn) {
        const ok = await showConfirm("このiCal URLを削除しますか？", "iCal URL削除");
        if (!ok) return;
        try {
          await db.collection("syncSettings").doc(deleteBtn.dataset.id).delete();
          showToast("削除", "iCal URLを削除しました", "info");
          loadList(container, pid);
        } catch (err) {
          showToast("エラー", `削除失敗: ${err.message}`, "error");
        }
      }
    });
  }

  // 共有 API
  const propertyIcalPanel = {
    /**
     * container に iCal パネル UI を描画する
     * @param {HTMLElement} container - 表示先コンテナ
     * @param {string} propertyId - 物件ID
     */
    async render(container, propertyId) {
      if (!container || !propertyId) return;

      // 初回のみパネル骨格を注入
      if (!container.querySelector(".ical-panel")) {
        container.innerHTML = buildPanelHtml(container.id || "ical-panel");
      }

      bindEvents(container, propertyId);
      await loadList(container, propertyId);
    },

    /**
     * 既存 DOM 要素 (物件詳細モーダル側) へのバインド用
     * listEl / urlInput / platformInput / addBtn を受け取り、共有ロジックを適用する
     */
    async bindLegacy({ listEl, urlInput, platformInput, addBtn, propertyId }) {
      if (!listEl || !propertyId) return;

      const renderList = async () => {
        try {
          const snap = await db.collection("syncSettings")
            .where("propertyId", "==", propertyId).get();

          if (snap.empty) {
            listEl.innerHTML = '<p class="text-muted small mb-1">iCal URLが未登録です。</p>';
            return;
          }
          let html = '<div class="list-group list-group-flush border rounded mb-2">';
          snap.forEach(doc => {
            const d = doc.data();
            const lastSync = d.lastSync
              ? new Date(d.lastSync.seconds * 1000).toLocaleString("ja-JP")
              : "未同期";
            const statusBadge = d.active === false
              ? '<span class="badge bg-secondary ms-1">無効</span>'
              : '<span class="badge bg-success ms-1">有効</span>';
            const urlStr = d.icalUrl || "";
            html += `
              <div class="list-group-item py-2 px-3">
                <div class="d-flex justify-content-between align-items-start">
                  <div class="flex-grow-1 me-2">
                    <strong>${escapeHtml(d.platform || "unknown")}</strong>${statusBadge}
                    <br><small class="text-muted font-monospace">${escapeHtml(urlStr.slice(0, 70))}${urlStr.length > 70 ? "…" : ""}</small>
                    <br><small class="text-muted">最終同期: ${lastSync}</small>
                    ${d.lastSyncResult ? `<br><small class="text-muted">結果: ${escapeHtml(d.lastSyncResult)}</small>` : ""}
                  </div>
                  <div class="btn-group btn-group-sm flex-shrink-0">
                    <button class="btn btn-outline-${d.active === false ? "success" : "warning"} btnPropToggleIcal"
                      data-id="${doc.id}" data-pid="${propertyId}" data-active="${d.active !== false}">
                      <i class="bi bi-${d.active === false ? "play" : "pause"}"></i>
                    </button>
                    <button class="btn btn-outline-danger btnPropDeleteIcal" data-id="${doc.id}" data-pid="${propertyId}">
                      <i class="bi bi-trash"></i>
                    </button>
                  </div>
                </div>
              </div>`;
          });
          html += "</div>";
          listEl.innerHTML = html;

          // トグル
          listEl.querySelectorAll(".btnPropToggleIcal").forEach(btn => {
            btn.addEventListener("click", async () => {
              const id = btn.dataset.id;
              const isActive = btn.dataset.active === "true";
              await db.collection("syncSettings").doc(id).update({ active: !isActive });
              showToast("更新", isActive ? "iCal同期を無効化しました" : "iCal同期を有効化しました", "info");
              renderList();
            });
          });

          // 削除
          listEl.querySelectorAll(".btnPropDeleteIcal").forEach(btn => {
            btn.addEventListener("click", async () => {
              const ok = await showConfirm("このiCal URLを削除しますか？", "iCal URL削除");
              if (!ok) return;
              await db.collection("syncSettings").doc(btn.dataset.id).delete();
              showToast("削除", "iCal URLを削除しました", "info");
              renderList();
            });
          });

        } catch (e) {
          listEl.innerHTML = `<div class="alert alert-danger py-1 small">読み込みエラー: ${escapeHtml(e.message)}</div>`;
        }
      };

      // URL 入力でプラットフォーム自動検出
      if (urlInput && !urlInput.dataset.icalBound) {
        urlInput.dataset.icalBound = "1";
        urlInput.addEventListener("input", () => {
          if (platformInput) platformInput.value = detectPlatform(urlInput.value);
        });
      }

      // 追加ボタンはモーダル開くたびクローン差し替え (古いリスナ除去)
      if (addBtn) {
        const freshBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(freshBtn, addBtn);
        freshBtn.addEventListener("click", async () => {
          const url = urlInput?.value.trim() || "";
          const platform = platformInput?.value.trim() || "other";
          if (!url || !url.startsWith("http")) {
            showToast("エラー", "正しいiCal URLを入力してください", "error");
            return;
          }
          try {
            await db.collection("syncSettings").add({
              icalUrl: url,
              platform: platform || "other",
              propertyId,
              active: true,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            if (urlInput) urlInput.value = "";
            if (platformInput) platformInput.value = "";
            showToast("追加", `${platform || "iCal"} URLを登録しました`, "success");
            renderList();
          } catch (e) {
            showToast("エラー", `登録失敗: ${e.message}`, "error");
          }
        });
      }

      await renderList();
    },

    detectPlatform,
  };

  global.propertyIcalPanel = propertyIcalPanel;
})(window);
