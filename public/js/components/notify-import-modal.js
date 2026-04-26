/**
 * 通知設定 個別インポートモーダル — 他物件の通知設定をこの物件にコピー
 *
 * 使い方:
 *   NotifyImportModal.open({
 *     notifyKey: "double_booking",     // 通知種別キー
 *     targetPropertyId: "xxx",         // インポート先 propertyId
 *     onImported: () => { ... },       // 完了後コールバック (UI 再描画用)
 *   });
 *
 * 動作:
 *   1. 全物件から channelOverrides[notifyKey] を持つ物件を抽出
 *   2. 選択 → 確認モーダル表示 → properties/{targetPropertyId}.channelOverrides.{notifyKey} を完全上書き
 */
(function (global) {
  const MODAL_ID = "notifyImportModal";

  function ensureModal() {
    let el = document.getElementById(MODAL_ID);
    if (el) return el;
    const html = `
      <div class="modal fade" id="${MODAL_ID}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-box-arrow-in-down"></i> 他物件から通知設定をインポート</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2 small text-muted">対象通知: <code id="nimNotifyKey"></code></div>
              <div class="mb-2 small">インポート先: <strong id="nimTargetName"></strong></div>
              <div class="mb-3">
                <label class="form-label fw-semibold small">コピー元物件</label>
                <select id="nimSourceSelect" class="form-select form-select-sm"></select>
                <div class="form-text small text-muted">この通知設定を持つ物件のみリストされます</div>
              </div>
              <div class="alert alert-warning small mb-2">
                <i class="bi bi-exclamation-triangle"></i> インポートするとこの物件の現在の設定は<strong>完全に上書き</strong>されます。送信先・本文・タイミング・enabled を含めてコピーします。
              </div>
              <div id="nimPreview" class="border rounded p-2 small font-monospace bg-light" style="max-height:200px;overflow:auto;white-space:pre-wrap;"></div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button class="btn btn-primary btn-sm" id="nimExecBtn"><i class="bi bi-box-arrow-in-down"></i> インポートを実行</button>
            </div>
          </div>
        </div>
      </div>
    `;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    return document.getElementById(MODAL_ID);
  }

  async function open(opt = {}) {
    const { notifyKey, targetPropertyId, onImported } = opt;
    if (!notifyKey || !targetPropertyId) return;

    ensureModal();
    document.getElementById("nimNotifyKey").textContent = notifyKey;
    document.getElementById("nimPreview").textContent = "(コピー元を選択してください)";

    // 全物件取得
    let propsAll = [];
    try {
      const snap = await db.collection("properties").get();
      propsAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      if (typeof showAlert === "function") showAlert("物件取得失敗: " + e.message, "danger");
      return;
    }
    const target = propsAll.find(p => p.id === targetPropertyId);
    document.getElementById("nimTargetName").textContent = target ? `${target.name || "(無名)"}` : "(物件不明)";

    // この通知の channelOverrides を持つ物件のみ (自分自身は除外)
    const candidates = propsAll
      .filter(p => p.id !== targetPropertyId)
      .filter(p => p.channelOverrides && p.channelOverrides[notifyKey] && Object.keys(p.channelOverrides[notifyKey]).length > 0);

    const sel = document.getElementById("nimSourceSelect");
    if (candidates.length === 0) {
      sel.innerHTML = '<option value="">— この通知設定を持つ他物件はありません —</option>';
      sel.disabled = true;
      document.getElementById("nimExecBtn").disabled = true;
    } else {
      sel.disabled = false;
      document.getElementById("nimExecBtn").disabled = false;
      sel.innerHTML = candidates.map(p => `<option value="${p.id}">${esc(p.name || "(無名)")}</option>`).join("");
    }

    const updatePreview = () => {
      const pid = sel.value;
      const src = candidates.find(p => p.id === pid);
      const data = src && src.channelOverrides ? src.channelOverrides[notifyKey] : null;
      document.getElementById("nimPreview").textContent = data ? JSON.stringify(data, null, 2) : "(なし)";
    };
    sel.onchange = updatePreview;
    updatePreview();

    const execBtn = document.getElementById("nimExecBtn");
    execBtn.onclick = async () => {
      const pid = sel.value;
      const src = candidates.find(p => p.id === pid);
      if (!src || !src.channelOverrides || !src.channelOverrides[notifyKey]) return;
      const sourceData = src.channelOverrides[notifyKey];
      const orig = execBtn.innerHTML;
      execBtn.disabled = true;
      execBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 実行中...';
      try {
        await db.collection("properties").doc(targetPropertyId).set({
          channelOverrides: { [notifyKey]: sourceData },
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (typeof showToast === "function") showToast("完了", `「${src.name}」の${notifyKey}設定をインポートしました`, "success");
        bootstrap.Modal.getInstance(document.getElementById(MODAL_ID))?.hide();
        if (typeof onImported === "function") onImported();
      } catch (e) {
        if (typeof showAlert === "function") showAlert("インポート失敗: " + e.message, "danger");
      } finally {
        execBtn.disabled = false;
        execBtn.innerHTML = orig;
      }
    };

    new bootstrap.Modal(document.getElementById(MODAL_ID)).show();
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  global.NotifyImportModal = { open };
})(window);
