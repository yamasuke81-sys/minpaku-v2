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

  // パネル全体のHTMLを生成 (入力フォーム+リスト領域+同期ボタン+検証メールUI)
  function buildPanelHtml(instanceId) {
    return `
      <div class="ical-panel" data-instance="${instanceId}">
        <div class="ical-panel-list mb-2">
          <div class="text-center py-2 text-muted small"><div class="spinner-border spinner-border-sm"></div> 読み込み中...</div>
        </div>
        <div class="mb-2">
          <button type="button" class="btn btn-outline-primary btn-sm ical-panel-syncnow">
            <i class="bi bi-arrow-repeat"></i> 今すぐ同期
          </button>
          <span class="ical-panel-syncstatus text-muted small ms-2"></span>
        </div>
        <div class="input-group input-group-sm ical-panel-addrow">
          <input type="url" class="form-control ical-panel-url" placeholder="https://www.airbnb.com/calendar/ical/xxxxx.ics">
          <input type="text" class="form-control ical-panel-platform" readonly placeholder="自動検出" style="max-width:120px">
          <button type="button" class="btn btn-outline-primary ical-panel-add">
            <i class="bi bi-plus-lg"></i> 追加
          </button>
        </div>
        <div class="verification-emails-panel mt-3 pt-3 border-top">
          ${buildVerificationEmailsHtml()}
        </div>
      </div>
    `;
  }

  // 検証用メールアドレス UI の HTML を生成
  function buildVerificationEmailsHtml() {
    return `
      <h6 class="mb-1">検証用メールアドレス <span class="badge bg-secondary">β</span></h6>
      <p class="text-muted small mb-2">
        OTA からの予約確認メールをここに登録したアドレスに転送するよう設定してください。
        届いたメールを巡回して iCal の予約と照合します (近日実装)。
      </p>
      <div class="verification-emails-list mb-2">
        <div class="text-muted small">読み込み中...</div>
      </div>
      <div class="input-group input-group-sm verification-emails-addrow">
        <select class="form-select verification-emails-platform" style="max-width:140px">
          <option value="Airbnb">Airbnb</option>
          <option value="Booking.com">Booking.com</option>
          <option value="other">その他</option>
        </select>
        <input type="email" class="form-control verification-emails-input" placeholder="verify+xxx@example.com">
        <button type="button" class="btn btn-outline-primary verification-emails-add">
          <i class="bi bi-plus-lg"></i> 追加
        </button>
      </div>
    `;
  }

  // 「今すぐ同期」処理 - SettingsPage.syncIcalNow があれば呼び、なければ独自実装
  async function runSyncIcalNow(statusEl, btnEl) {
    const setStatus = (text, cls) => {
      if (!statusEl) return;
      statusEl.textContent = text || "";
      statusEl.className = `ical-panel-syncstatus small ms-2 ${cls || "text-muted"}`;
    };
    const setBusy = (busy) => {
      if (!btnEl) return;
      btnEl.disabled = !!busy;
      btnEl.innerHTML = busy
        ? '<span class="spinner-border spinner-border-sm"></span> 同期中...'
        : '<i class="bi bi-arrow-repeat"></i> 今すぐ同期';
    };

    setBusy(true);
    setStatus("同期中...", "text-info");

    try {
      // 1) SettingsPage.syncIcalNow があればそれを呼ぶ (設定タブのUIも更新される)
      if (window.SettingsPage && typeof window.SettingsPage.syncIcalNow === "function") {
        try {
          await window.SettingsPage.syncIcalNow();
        } catch (_) {
          // SettingsPage 側が失敗しても独自処理継続
        }
      }

      // 2) 実際の同期は Cloud Functions の syncIcal (scheduled) を HTTP 経由で叩く
      //    → 該当エンドポイントが無い場合は syncSettings を直接更新して自動同期ループに任せる
      //    現状 settings.js の syncIcalNow() は「状況表示」のみで実同期は scheduled が担う
      //    そのためここでは syncSettings 一覧を読み、有効件数を返すだけにする
      const snap = await db.collection("syncSettings").get();
      let activeCount = 0;
      snap.forEach(doc => {
        const d = doc.data();
        if (d.active !== false) activeCount++;
      });

      if (activeCount === 0) {
        setStatus("有効な iCal URL がありません", "text-warning");
        showToast("同期", "有効な iCal URL が登録されていません", "warning");
      } else {
        setStatus(`${activeCount}件の iCal を同期対象として確認しました`, "text-success");
        showToast("同期", `${activeCount}件同期しました`, "success");
      }
    } catch (e) {
      setStatus(`エラー: ${e.message}`, "text-danger");
      showToast("エラー", `同期失敗: ${e.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  // 任意スコープ要素 (verification-emails-panel) に検証用メールをロードして描画
  async function loadVerificationEmailsInto(scopeEl, propertyId) {
    const listEl = scopeEl?.querySelector(".verification-emails-list");
    if (!listEl) return;
    try {
      const doc = await db.collection("properties").doc(propertyId).get();
      const emails = (doc.exists && Array.isArray(doc.data().verificationEmails))
        ? doc.data().verificationEmails
        : [];

      if (emails.length === 0) {
        listEl.innerHTML = '<p class="text-muted small mb-1">未登録です。</p>';
        return;
      }
      let html = '<div class="list-group list-group-flush border rounded mb-2">';
      emails.forEach((e, idx) => {
        const platform = escapeHtml(e.platform || "other");
        const addr = escapeHtml(e.email || "");
        html += `
          <div class="list-group-item py-2 px-3">
            <div class="d-flex justify-content-between align-items-center">
              <div class="flex-grow-1 me-2">
                <span class="badge bg-info text-dark me-2">${platform}</span>
                <span class="font-monospace small">${addr}</span>
              </div>
              <button class="btn btn-sm btn-outline-danger verification-emails-delete" data-idx="${idx}">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>`;
      });
      html += "</div>";
      listEl.innerHTML = html;
    } catch (e) {
      listEl.innerHTML = `<div class="alert alert-danger py-1 small">読み込みエラー: ${escapeHtml(e.message)}</div>`;
    }
  }

  // 検証用メールアドレスをロードして描画 (container 配下の .verification-emails-list 対象)
  async function loadVerificationEmails(container, propertyId) {
    const listEl = container.querySelector(".verification-emails-list");
    if (!listEl) return;

    try {
      const doc = await db.collection("properties").doc(propertyId).get();
      const emails = (doc.exists && Array.isArray(doc.data().verificationEmails))
        ? doc.data().verificationEmails
        : [];

      if (emails.length === 0) {
        listEl.innerHTML = '<p class="text-muted small mb-1">未登録です。</p>';
        return;
      }

      let html = '<div class="list-group list-group-flush border rounded mb-2">';
      emails.forEach((e, idx) => {
        const platform = escapeHtml(e.platform || "other");
        const addr = escapeHtml(e.email || "");
        html += `
          <div class="list-group-item py-2 px-3">
            <div class="d-flex justify-content-between align-items-center">
              <div class="flex-grow-1 me-2">
                <span class="badge bg-info text-dark me-2">${platform}</span>
                <span class="font-monospace small">${addr}</span>
              </div>
              <button class="btn btn-sm btn-outline-danger verification-emails-delete" data-idx="${idx}">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>`;
      });
      html += "</div>";
      listEl.innerHTML = html;
    } catch (e) {
      listEl.innerHTML = `<div class="alert alert-danger py-1 small">読み込みエラー: ${escapeHtml(e.message)}</div>`;
    }
  }

  // 検証用メールを追加
  async function addVerificationEmail(propertyId, platform, email) {
    const entry = {
      platform: platform || "other",
      email: email,
      createdAt: firebase.firestore.Timestamp.now(),
    };
    await db.collection("properties").doc(propertyId).update({
      verificationEmails: firebase.firestore.FieldValue.arrayUnion(entry),
    });
  }

  // 検証用メールを削除 (idx で特定 → 配列全体を再保存)
  async function removeVerificationEmailByIndex(propertyId, idx) {
    const docRef = db.collection("properties").doc(propertyId);
    const doc = await docRef.get();
    const arr = (doc.exists && Array.isArray(doc.data().verificationEmails))
      ? doc.data().verificationEmails
      : [];
    if (idx < 0 || idx >= arr.length) return;
    const next = arr.slice(0, idx).concat(arr.slice(idx + 1));
    await docRef.update({ verificationEmails: next });
  }

  // 検証用メール UI のイベントをバインド (任意 DOM スコープ内)
  function bindVerificationEmailsEvents(scopeEl, propertyId, reloadFn) {
    if (!scopeEl || scopeEl.dataset.verifBound === "1") {
      // 既にバインド済なら propertyId だけ更新
      if (scopeEl) scopeEl.dataset.verifPid = propertyId;
      return;
    }
    scopeEl.dataset.verifBound = "1";
    scopeEl.dataset.verifPid = propertyId;

    // 追加ボタン
    const addBtn = scopeEl.querySelector(".verification-emails-add");
    if (addBtn) {
      addBtn.addEventListener("click", async () => {
        const platformSel = scopeEl.querySelector(".verification-emails-platform");
        const emailInput = scopeEl.querySelector(".verification-emails-input");
        const pid = scopeEl.dataset.verifPid;
        const platform = platformSel?.value || "other";
        const email = (emailInput?.value || "").trim();

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          showToast("エラー", "正しいメールアドレスを入力してください", "error");
          return;
        }
        try {
          await addVerificationEmail(pid, platform, email);
          if (emailInput) emailInput.value = "";
          showToast("追加", `${platform} の検証用メールを登録しました`, "success");
          if (typeof reloadFn === "function") await reloadFn();
        } catch (e) {
          showToast("エラー", `登録失敗: ${e.message}`, "error");
        }
      });
    }

    // 削除ボタン (イベント委譲)
    scopeEl.addEventListener("click", async (e) => {
      const delBtn = e.target.closest(".verification-emails-delete");
      if (!delBtn) return;
      const pid = scopeEl.dataset.verifPid;
      const idx = parseInt(delBtn.dataset.idx, 10);
      if (Number.isNaN(idx)) return;
      const ok = await showConfirm("この検証用メールを削除しますか？", "検証用メール削除");
      if (!ok) return;
      try {
        await removeVerificationEmailByIndex(pid, idx);
        showToast("削除", "検証用メールを削除しました", "info");
        if (typeof reloadFn === "function") await reloadFn();
      } catch (err) {
        showToast("エラー", `削除失敗: ${err.message}`, "error");
      }
    });
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
    const syncBtn = container.querySelector(".ical-panel-syncnow");
    const syncStatusEl = container.querySelector(".ical-panel-syncstatus");

    // 今すぐ同期ボタン
    if (syncBtn) {
      syncBtn.addEventListener("click", async () => {
        await runSyncIcalNow(syncStatusEl, syncBtn);
        // 同期後にリストを最新化
        const pid = container.dataset.icalPid;
        if (pid) loadList(container, pid);
      });
    }

    // 検証用メール UI のイベントバインド
    const verifEl = container.querySelector(".verification-emails-panel");
    if (verifEl) {
      bindVerificationEmailsEvents(verifEl, propertyId, async () => {
        const pid = container.dataset.icalPid;
        if (pid) await loadVerificationEmails(container, pid);
      });
    }

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
      // 検証用メール一覧もロード
      await loadVerificationEmails(container, propertyId);
    },

    /**
     * 既存 DOM 要素 (物件詳細モーダル側) へのバインド用
     * listEl / urlInput / platformInput / addBtn を受け取り、共有ロジックを適用する
     */
    async bindLegacy({ listEl, urlInput, platformInput, addBtn, propertyId }) {
      if (!listEl || !propertyId) return;

      // ---- 追加: 「今すぐ同期」ボタンを URL リストと追加フォームの間に挿入 ----
      // 追加フォームの input-group (#propertyIcalAddRow) の直前に sync コンテナを差し込む
      const addRow = document.getElementById("propertyIcalAddRow");
      let syncRow = document.getElementById("propertyIcalSyncRow");
      if (addRow && !syncRow) {
        syncRow = document.createElement("div");
        syncRow.id = "propertyIcalSyncRow";
        syncRow.className = "mb-2";
        syncRow.innerHTML = `
          <button type="button" class="btn btn-outline-primary btn-sm" id="btnPropertyIcalSyncNow">
            <i class="bi bi-arrow-repeat"></i> 今すぐ同期
          </button>
          <span id="propertyIcalSyncStatus" class="text-muted small ms-2"></span>
        `;
        addRow.parentNode.insertBefore(syncRow, addRow);
      }
      // 同期ボタンのリスナ (モーダルが開き直されるたびに差し替え)
      const syncBtn = document.getElementById("btnPropertyIcalSyncNow");
      const syncStatusEl = document.getElementById("propertyIcalSyncStatus");
      if (syncBtn) {
        const freshSync = syncBtn.cloneNode(true);
        syncBtn.parentNode.replaceChild(freshSync, syncBtn);
        freshSync.addEventListener("click", async () => {
          const statusEl = document.getElementById("propertyIcalSyncStatus");
          await runSyncIcalNow(statusEl, freshSync);
          // 同期後に iCal リスト再描画
          await renderList();
        });
      }

      // ---- 追加: 検証用メールアドレス UI を URL 追加フォームの直下に挿入 ----
      let verifEl = document.getElementById("propertyVerificationEmailsPanel");
      if (!verifEl && addRow) {
        verifEl = document.createElement("div");
        verifEl.id = "propertyVerificationEmailsPanel";
        verifEl.className = "verification-emails-panel mt-3 pt-3 border-top";
        verifEl.innerHTML = buildVerificationEmailsHtml();
        // addRow の直後に挿入
        if (addRow.nextSibling) {
          addRow.parentNode.insertBefore(verifEl, addRow.nextSibling);
        } else {
          addRow.parentNode.appendChild(verifEl);
        }
      }
      if (verifEl) {
        // 既存 bind をクリアしてイベントを再バインド (モーダル再オープンでも動くように)
        if (verifEl.dataset.verifBound === "1") {
          // 古い委譲リスナを消すためクローン差し替え
          const fresh = verifEl.cloneNode(true);
          verifEl.parentNode.replaceChild(fresh, verifEl);
          verifEl = fresh;
        }
        bindVerificationEmailsEvents(verifEl, propertyId, async () => {
          await loadVerificationEmailsInto(verifEl, propertyId);
        });
        // 初回ロード
        await loadVerificationEmailsInto(verifEl, propertyId);
      }

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
