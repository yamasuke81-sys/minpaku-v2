/**
 * 設定ページ（全GASアプリからの一括データ移行機能付き）
 */
const SettingsPage = {
  async render(container) {
    const currentUser = firebase.auth().currentUser;
    const currentEmail = currentUser?.email || "";
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-gear"></i> 設定</h2>
      </div>

      <!-- アカウント設定 -->
      <div class="card mb-4">
        <div class="card-header"><h5 class="mb-0"><i class="bi bi-person-circle"></i> アカウント設定</h5></div>
        <div class="card-body">
          <div class="row g-3 align-items-end">
            <div class="col-md-6">
              <label class="form-label">現在のログインメールアドレス</label>
              <input type="email" class="form-control" id="accountCurrentEmail" value="${currentEmail}" readonly style="background:#f8f9fa;">
            </div>
            <div class="col-md-6">
              <label class="form-label">新しいメールアドレス</label>
              <input type="email" class="form-control" id="accountNewEmail" placeholder="new@example.com">
            </div>
            <div class="col-md-6">
              <label class="form-label">現在のパスワード <small class="text-muted">(メール変更時に必要)</small></label>
              <input type="password" class="form-control" id="accountCurrentPw">
            </div>
            <div class="col-md-6">
              <button class="btn btn-primary" id="btnChangeEmail"><i class="bi bi-envelope"></i> メールアドレスを変更</button>
              <button class="btn btn-outline-warning" id="btnSendPwReset"><i class="bi bi-key"></i> パスワードリセットメールを送信</button>
            </div>
            <div id="accountResult" class="col-12"></div>
          </div>
        </div>
      </div>

      <!-- データ移行セクション -->
      <div class="card mb-4">
        <div class="card-header bg-warning text-dark">
          <h5 class="mb-0"><i class="bi bi-arrow-repeat"></i> データ移行（全GASアプリ → 新アプリ）</h5>
        </div>
        <div class="card-body">
          <p class="text-muted">
            各GASアプリのスプレッドシートからデータを一括インポートします。
          </p>

          <div class="alert alert-info">
            <strong>ボタン1つで全データ取込!</strong><br>
            スプレッドシートのデータを自動で読み取り、Firestoreにインポートします。
          </div>

          <div class="alert alert-warning small">
            <strong>事前準備（1回だけ）:</strong> 各スプレッドシートの共有設定を「リンクを知っている全員 → 閲覧者」にしてください。<br>
            インポート完了後に共有を戻してOKです。
          </div>

          <!-- プリセットURL表示 -->
          <table class="table table-sm mb-3">
            <thead><tr><th>アプリ</th><th>スプレッドシート</th><th>状態</th></tr></thead>
            <tbody>
              <tr>
                <td><i class="bi bi-house-door"></i> 民泊メイン<br><small class="text-muted">予約・スタッフ・募集・報酬・チェックリスト</small></td>
                <td><small class="font-monospace">1Kk8VZ...HnHgCs</small></td>
                <td><span class="badge bg-secondary" id="statusMain">待機中</span></td>
              </tr>
              <tr>
                <td><i class="bi bi-file-earmark-pdf"></i> PDFリネーム<br><small class="text-muted">リネームルール・処理履歴</small></td>
                <td><small class="font-monospace">17oV_2...liAy0</small></td>
                <td><span class="badge bg-secondary" id="statusPdf">待機中</span></td>
              </tr>
            </tbody>
          </table>

          <button class="btn btn-warning btn-lg w-100" id="btnAutoImport">
            <i class="bi bi-cloud-download"></i> 全データ一括取込
          </button>

          <div class="mt-3 d-none" id="migrationResult">
            <div class="alert" id="migrationAlert"></div>
          </div>

          <hr>
          <details>
            <summary class="text-muted small">手動インポート（JSON貼り付け）</summary>
            <div class="mt-2">
              <textarea class="form-control font-monospace mb-2" id="migrationJson" rows="4" placeholder="JSON"></textarea>
              <button class="btn btn-outline-warning btn-sm" id="btnMigrate"><i class="bi bi-upload"></i> JSONインポート</button>
            </div>
          </details>
        </div>
      </div>

      <!-- データ整形セクション -->
      <div class="card mb-4">
        <div class="card-header bg-success text-white">
          <h5 class="mb-0"><i class="bi bi-magic"></i> データ整形（インポート済みデータ → 新アプリ用に変換）</h5>
        </div>
        <div class="card-body">
          <p class="text-muted">
            インポート済みのスプレッドシート生データを、新アプリの正式コレクション（スタッフ・予約・シフト等）に自動変換します。
          </p>
          <ul class="text-muted small">
            <li>清掃スタッフ → <code>staff/</code></li>
            <li>フォームの回答 → <code>bookings/</code></li>
            <li>募集 → <code>shifts/</code>（清掃スケジュール）</li>
            <li>スタッフ報酬 → <code>rewards/</code> + <code>laundry/</code></li>
            <li>チェックリストマスタ → <code>checklistTemplates/</code></li>
            <li>デフォルト物件を自動作成 → <code>properties/</code></li>
            <li>フォームの回答 → <code>guestRegistrations/</code>（宿泊者名簿）</li>
          </ul>
          <button class="btn btn-success btn-lg w-100" id="btnTransform">
            <i class="bi bi-magic"></i> データ整形を実行
          </button>
          <div class="mt-3 d-none" id="transformResult">
            <div class="alert" id="transformAlert"></div>
          </div>
          <hr>
          <button class="btn btn-outline-info w-100 mb-2" id="btnMigrateResponses">
            <i class="bi bi-arrow-repeat"></i> 募集回答データを高速化形式に移行
          </button>
          <div class="mt-1 d-none" id="migrateRespResult">
            <div class="alert" id="migrateRespAlert"></div>
          </div>
          <button class="btn btn-outline-warning w-100 mb-2" id="btnFixGuestCounts">
            <i class="bi bi-people"></i> 宿泊人数を元データから再取り込み
          </button>
          <div class="mt-1 d-none" id="fixGuestResult">
            <div class="alert" id="fixGuestAlert"></div>
          </div>
          <button class="btn btn-outline-danger w-100" id="btnDedup">
            <i class="bi bi-trash3"></i> 全コレクションの重複データを削除
          </button>
          <div class="mt-2 d-none" id="dedupResult">
            <div class="alert" id="dedupAlert"></div>
          </div>
        </div>
      </div>

      <!-- Gemini API設定 -->
      <div class="card mb-4">
        <div class="card-header bg-info text-white">
          <h5 class="mb-0"><i class="bi bi-stars"></i> Gemini API（指示整理AI）</h5>
        </div>
        <div class="card-body">
          <p class="text-muted">
            司令塔の「社長指示」を自動整理するためのGemini APIキーを設定します。
            <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>で無料発行できます。
          </p>
          <div class="row g-3 align-items-end">
            <div class="col-md-8">
              <label class="form-label">Gemini APIキー</label>
              <div class="input-group">
                <input type="password" class="form-control" id="geminiApiKey" placeholder="AIza...">
                <button class="btn btn-outline-secondary" type="button" id="btnToggleApiKey" title="表示/非表示">
                  <i class="bi bi-eye"></i>
                </button>
              </div>
            </div>
            <div class="col-md-4">
              <button class="btn btn-info w-100" id="btnSaveGeminiKey">
                <i class="bi bi-save"></i> 保存
              </button>
            </div>
          </div>
          <div class="mt-2">
            <label class="form-label">モデル</label>
            <input type="text" class="form-control" id="geminiModel" value="gemini-2.5-flash"
              placeholder="例: gemini-2.5-flash, gemini-1.5-flash">
            <small class="text-muted">
              <a href="https://ai.google.dev/gemini-api/docs/models" target="_blank">利用可能なモデル一覧</a>
            </small>
          </div>
          <div class="mt-2" id="geminiSaveResult">
            <div class="alert alert-info py-1 small" id="geminiStatus">未確認</div>
          </div>
        </div>
      </div>

      <!-- BEDS24設定 -->
      <div class="card mb-4">
        <div class="card-header">
          <h5 class="mb-0"><i class="bi bi-link-45deg"></i> BEDS24連携</h5>
        </div>
        <div class="card-body">
          <p class="text-muted">BEDS24のアカウント登録後に設定します。</p>
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label">API Token</label>
              <input type="password" class="form-control" placeholder="BEDS24管理画面から取得" disabled>
            </div>
            <div class="col-md-6">
              <label class="form-label">同期間隔（分）</label>
              <input type="number" class="form-control" value="5" disabled>
            </div>
          </div>
        </div>
      </div>

      <!-- iCal同期 (全体) -->
      <div class="card mb-4">
        <div class="card-header bg-primary text-white">
          <h5 class="mb-0"><i class="bi bi-calendar2-event"></i> iCal同期 (全体)</h5>
        </div>
        <div class="card-body">
          <p class="text-muted small mb-3">
            URL登録は物件詳細画面から行えます。このセクションでは全物件共通の同期頻度と手動同期のみ設定します。
          </p>

          <!-- iCal同期頻度設定 -->
          <div class="card border-light bg-light mb-3">
            <div class="card-body py-2">
              <div class="row g-2 align-items-end">
                <div class="col-md-5">
                  <label class="form-label small mb-1"><i class="bi bi-clock"></i> 同期頻度</label>
                  <select class="form-select form-select-sm" id="icalSyncInterval">
                    <option value="5" selected>5分おき</option>
                    <option value="10">10分おき</option>
                    <option value="15">15分おき</option>
                    <option value="30">30分おき</option>
                    <option value="60">1時間おき</option>
                    <option value="0">手動のみ</option>
                  </select>
                  <div class="form-text">
                    60分以上に設定すると、起動時に前回からの経過時間でスキップします。
                  </div>
                </div>
                <div class="col-md-3">
                  <button class="btn btn-outline-secondary btn-sm w-100" id="btnSaveIcalInterval">
                    <i class="bi bi-save"></i> 頻度を保存
                  </button>
                </div>
              </div>
            </div>
          </div>

          <button class="btn btn-outline-primary btn-sm" id="btnSyncIcalNow">
            <i class="bi bi-arrow-repeat"></i> 今すぐ同期
          </button>
          <div class="mt-2 d-none" id="icalSyncResult">
            <div class="alert py-1 small" id="icalSyncAlert"></div>
          </div>
        </div>
      </div>

      <!-- 宿泊者名簿フォーム設定は #/guests タブの「設定」ボタンに移動しました -->
      <div class="alert alert-light border small mb-4">
        <i class="bi bi-info-circle text-muted"></i>
        宿泊者名簿のフォーム項目管理・フォームURL設定は
        <a href="#/guests" class="fw-semibold">宿泊者名簿タブ</a> の「設定」ボタンから操作できます。
      </div>
    `;

    this.bindEvents();
    this.loadGeminiSettings();
  },

  SHEETS_API_KEY: firebaseConfig.apiKey, // Firebase APIキーでSheets APIも使える

  // プリセットのスプレッドシートID
  presetSheets: [
    { id: "1Kk8VZrMQoJwmNk4OZKVQ9riufiCEcVPi_xmYHHnHgCs", label: "民泊メイン", statusId: "statusMain" },
    { id: "17oV_2vPj33aZf7fl8A-NDgS0l4aYvsRrSJBw2JliAy0", label: "PDFリネーム", statusId: "statusPdf" },
  ],

  bindEvents() {
    // アカウント設定: メール変更
    document.getElementById("btnChangeEmail")?.addEventListener("click", async () => {
      const newEmail = document.getElementById("accountNewEmail").value.trim();
      const currentPw = document.getElementById("accountCurrentPw").value;
      const result = document.getElementById("accountResult");
      if (!newEmail) { result.innerHTML = `<div class="alert alert-danger">新しいメールアドレスを入力してください</div>`; return; }
      if (!currentPw) { result.innerHTML = `<div class="alert alert-danger">現在のパスワードを入力してください</div>`; return; }
      const ok = await showConfirm(`ログインメールを ${newEmail} に変更します。変更後は新しいメールで再ログインしてください。続行しますか？`, "メール変更確認");
      if (!ok) return;
      try {
        const user = firebase.auth().currentUser;
        const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPw);
        await user.reauthenticateWithCredential(cred);
        await user.updateEmail(newEmail);
        // 念のためメール確認送信
        try { await user.sendEmailVerification(); } catch (_) {}
        result.innerHTML = `<div class="alert alert-success">メールアドレスを変更しました。確認メールを ${newEmail} に送信しました。一度ログアウトして新しいメールでログインしてください。</div>`;
      } catch (e) {
        const m = {
          "auth/wrong-password": "現在のパスワードが違います",
          "auth/email-already-in-use": "このメールアドレスは既に使われています",
          "auth/requires-recent-login": "再ログインが必要です。一度ログアウトして再度ログインしてからお試しください",
          "auth/invalid-email": "メールアドレスの形式が正しくありません",
        };
        result.innerHTML = `<div class="alert alert-danger">変更失敗: ${m[e.code] || e.message}</div>`;
      }
    });
    // アカウント設定: パスワードリセットメール送信
    document.getElementById("btnSendPwReset")?.addEventListener("click", async () => {
      const email = firebase.auth().currentUser?.email;
      const result = document.getElementById("accountResult");
      if (!email) { result.innerHTML = `<div class="alert alert-danger">ログイン中のメールアドレスが取得できません</div>`; return; }
      try {
        await firebase.auth().sendPasswordResetEmail(email);
        result.innerHTML = `<div class="alert alert-success">${email} にパスワードリセットメールを送信しました。メールのリンクから新しいパスワードを設定してください。</div>`;
      } catch (e) {
        result.innerHTML = `<div class="alert alert-danger">送信失敗: ${e.message}</div>`;
      }
    });

    // 自動取込ボタン
    document.getElementById("btnAutoImport").addEventListener("click", () => this.autoImportAll());

    // データ整形ボタン
    document.getElementById("btnTransform").addEventListener("click", async () => {
      const resultEl = document.getElementById("transformResult");
      const alertEl = document.getElementById("transformAlert");
      resultEl.classList.remove("d-none");
      alertEl.className = "alert alert-info";
      alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>データ整形中...';

      try {
        const results = await DataTransformer.transformAll();
        const lines = Object.entries(results)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `<li>${k}: <strong>${v}件</strong></li>`);

        if (lines.length === 0) {
          alertEl.className = "alert alert-warning";
          alertEl.textContent = "変換対象のデータが見つかりませんでした。先に「全データ一括取込」を実行してください。";
        } else {
          alertEl.className = "alert alert-success";
          alertEl.innerHTML = `<strong>データ整形完了!</strong><ul class="mb-0 mt-2">${lines.join("")}</ul>
            <br><small>スタッフ管理・物件管理ページで確認できます。</small>`;
          showToast("完了", "データ整形が完了しました", "success");
        }
      } catch (e) {
        alertEl.className = "alert alert-danger";
        alertEl.textContent = `エラー: ${e.message}`;
        console.error("Transform error:", e);
      }
    });

    // 回答データ移行ボタン
    document.getElementById("btnMigrateResponses").addEventListener("click", async () => {
      const resultEl = document.getElementById("migrateRespResult");
      const alertEl = document.getElementById("migrateRespAlert");
      resultEl.classList.remove("d-none");
      alertEl.className = "alert alert-info";
      alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>移行中...';
      try {
        const count = await API.recruitments.migrateResponsesToEmbedded();
        alertEl.className = "alert alert-success";
        alertEl.textContent = count > 0
          ? `${count}件の募集の回答データを移行しました。読み込みが高速化されます。`
          : "移行対象はありませんでした（既に移行済み）。";
        if (count > 0) showToast("完了", "回答データを移行しました", "success");
      } catch (e) {
        alertEl.className = "alert alert-danger";
        alertEl.textContent = `エラー: ${e.message}`;
      }
    });

    // 宿泊人数修正ボタン
    document.getElementById("btnFixGuestCounts").addEventListener("click", async () => {
      const resultEl = document.getElementById("fixGuestResult");
      const alertEl = document.getElementById("fixGuestAlert");
      resultEl.classList.remove("d-none");
      alertEl.className = "alert alert-info";
      alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>元データから宿泊人数を再取り込み中...';
      try {
        const ts = firebase.firestore.FieldValue.serverTimestamp();
        const count = await DataTransformer.fixGuestCounts(ts);
        alertEl.className = "alert alert-success";
        alertEl.textContent = count > 0
          ? `${count}件の宿泊人数を修正しました`
          : "修正が必要なデータはありませんでした（既に正しい値が入っています）";
        if (count > 0) showToast("完了", `${count}件の宿泊人数を修正`, "success");
      } catch (e) {
        alertEl.className = "alert alert-danger";
        alertEl.textContent = `エラー: ${e.message}`;
      }
    });

    // 重複削除ボタン
    document.getElementById("btnDedup").addEventListener("click", async () => {
      if (!confirm("重複データを削除しますか？同名スタッフの2件目以降を削除します。")) return;
      const resultEl = document.getElementById("dedupResult");
      const alertEl = document.getElementById("dedupAlert");
      resultEl.classList.remove("d-none");
      alertEl.className = "alert alert-info";
      alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>重複チェック中...';
      try {
        const results = await this.deduplicateAll();
        const lines = Object.entries(results)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `<li>${k}: <strong>${v}件削除</strong></li>`);
        if (lines.length === 0) {
          alertEl.className = "alert alert-success";
          alertEl.textContent = "重複はありませんでした。";
        } else {
          alertEl.className = "alert alert-warning";
          alertEl.innerHTML = `<strong>重複を削除しました</strong><ul class="mb-0 mt-2">${lines.join("")}</ul>`;
          showToast("完了", "重複データを削除しました", "success");
        }
      } catch (e) {
        alertEl.className = "alert alert-danger";
        alertEl.textContent = `エラー: ${e.message}`;
      }
    });

    // Gemini APIキー表示トグル
    document.getElementById("btnToggleApiKey").addEventListener("click", () => {
      const input = document.getElementById("geminiApiKey");
      const icon = document.getElementById("btnToggleApiKey").querySelector("i");
      if (input.type === "password") { input.type = "text"; icon.className = "bi bi-eye-slash"; }
      else { input.type = "password"; icon.className = "bi bi-eye"; }
    });

    // Gemini APIキー保存
    document.getElementById("btnSaveGeminiKey").addEventListener("click", () => this.saveGeminiSettings());

    // 手動JSONインポート
    document.getElementById("btnMigrate").addEventListener("click", () => this.importJson());

    // iCal同期 (全体) — 同期頻度と手動同期のみ。URL登録は物件詳細画面側
    document.getElementById("btnSyncIcalNow").addEventListener("click", () => this.syncIcalNow());
    document.getElementById("btnSaveIcalInterval").addEventListener("click", () => this.saveIcalInterval());
    this.loadIcalSettings();

    // フォーム項目管理は #/guests タブに移動済み。settings 側の要素は存在しないのでバインドしない
  },

  async loadGeminiSettings() {
    const statusEl = document.getElementById("geminiStatus");
    try {
      const doc = await db.collection("settings").doc("gemini").get();
      if (doc.exists) {
        const data = doc.data();
        if (data.apiKey) document.getElementById("geminiApiKey").value = data.apiKey;
        if (data.model) document.getElementById("geminiModel").value = data.model;
        statusEl.className = "alert alert-success py-1 small";
        statusEl.textContent = `保存済み（モデル: ${data.model || "未設定"}、キー: ${data.apiKey ? data.apiKey.slice(0, 8) + "..." : "未設定"}）`;
      } else {
        statusEl.className = "alert alert-warning py-1 small";
        statusEl.textContent = "未設定 — APIキーとモデルを入力して保存してください";
      }
    } catch (e) {
      console.error("Gemini設定読み込みエラー:", e);
      statusEl.className = "alert alert-danger py-1 small";
      statusEl.textContent = `読み込みエラー: ${e.message}`;
    }
  },

  async saveGeminiSettings() {
    const apiKey = document.getElementById("geminiApiKey").value.trim();
    const model = document.getElementById("geminiModel").value.trim();
    const statusEl = document.getElementById("geminiStatus");
    if (!apiKey) { showToast("エラー", "APIキーを入力してください", "error"); return; }
    if (!model) { showToast("エラー", "モデル名を入力してください", "error"); return; }

    // Firestore に保存
    try {
      await db.collection("settings").doc("gemini").set({ apiKey, model, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
      showToast("エラー", `保存失敗: ${e.message}`, "error");
      return;
    }

    // API接続テスト
    statusEl.className = "alert alert-info py-1 small";
    statusEl.textContent = "テスト中...";
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "テスト。「OK」とだけ返して" }] }], generationConfig: { maxOutputTokens: 10 } }),
      });
      if (res.ok) {
        statusEl.className = "alert alert-success py-1 small";
        statusEl.textContent = `接続OK（モデル: ${model}、キー: ${apiKey.slice(0, 8)}...）`;
        showToast("完了", "Gemini API設定を保存＆接続テスト成功", "success");
      } else {
        const err = await res.json();
        statusEl.className = "alert alert-danger py-1 small";
        statusEl.textContent = `接続エラー: ${err.error?.message || res.statusText}`;
        showToast("エラー", `保存済みですがAPI接続に失敗: ${err.error?.message}`, "error");
      }
    } catch (e) {
      statusEl.className = "alert alert-danger py-1 small";
      statusEl.textContent = `接続エラー: ${e.message}`;
    }
  },

  /**
   * スプレッドシートURLからIDを抽出
   */
  extractSheetId(url) {
    if (!url) return null;
    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : url.trim(); // URLじゃなければIDそのままとして扱う
  },

  /**
   * Google Sheets API v4 でスプレッドシートの全データを取得
   */
  async fetchSpreadsheet(sheetId) {
    // まずシート名一覧を取得
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${this.SHEETS_API_KEY}`;
    const metaRes = await fetch(metaUrl);
    if (!metaRes.ok) {
      const err = await metaRes.json();
      throw new Error(`Sheets API: ${err.error?.message || metaRes.statusText}`);
    }
    const meta = await metaRes.json();
    const sheetNames = meta.sheets.map(s => s.properties.title);

    // 全シートのデータを一括取得（batchGet）
    const ranges = sheetNames.map(n => encodeURIComponent(n));
    const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?key=${this.SHEETS_API_KEY}&${ranges.map(r => `ranges=${r}`).join("&")}`;
    const dataRes = await fetch(dataUrl);
    if (!dataRes.ok) {
      const err = await dataRes.json();
      throw new Error(`Sheets API batchGet: ${err.error?.message || dataRes.statusText}`);
    }
    const batchData = await dataRes.json();

    // シートごとにヘッダー+データ行に変換
    const result = {};
    for (let i = 0; i < sheetNames.length; i++) {
      const sheetName = sheetNames[i];
      const values = batchData.valueRanges?.[i]?.values || [];
      if (values.length === 0) {
        result[sheetName] = [];
        continue;
      }

      const headers = values[0];
      const rows = [];
      for (let r = 1; r < values.length; r++) {
        const row = values[r];
        // 全空行スキップ
        if (!row || row.every(v => v === "" || v === undefined || v === null)) continue;
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
          obj[headers[c] || `col_${c + 1}`] = (row[c] !== undefined ? row[c] : "");
        }
        rows.push(obj);
      }
      result[sheetName] = rows;
    }

    return { title: meta.properties.title, sheets: result };
  },

  /**
   * 全アプリの一括自動取込
   * スプレッドシートURLからGoogle Sheets APIで直接データ取得→Firestoreに投入
   */
  async autoImportAll() {
    const resultEl = document.getElementById("migrationResult");
    const alertEl = document.getElementById("migrationAlert");
    resultEl.classList.remove("d-none");
    alertEl.className = "alert alert-info";
    alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>取込中...';

    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const totalCounts = {};
    let appsDone = 0;

    try {
      for (const preset of this.presetSheets) {
        const statusEl = document.getElementById(preset.statusId);
        if (statusEl) { statusEl.className = "badge bg-info"; statusEl.textContent = "取得中..."; }

        alertEl.innerHTML = `<div class="spinner-border spinner-border-sm me-2"></div>${preset.label}を取得中...`;

        let data;
        try {
          data = await this.fetchSpreadsheet(preset.id);
        } catch (e) {
          if (statusEl) { statusEl.className = "badge bg-danger"; statusEl.textContent = "エラー"; }
          console.error(`${preset.label} fetch error:`, e);
          totalCounts[`${preset.label} (エラー)`] = e.message;
          continue;
        }

        if (statusEl) { statusEl.className = "badge bg-primary"; statusEl.textContent = "保存中..."; }
        alertEl.innerHTML = `<div class="spinner-border spinner-border-sm me-2"></div>${preset.label}をFirestoreに保存中...`;

        let sheetsDone = 0;
        for (const [sheetName, rows] of Object.entries(data.sheets)) {
          if (!rows || rows.length === 0) continue;

          const collectionName = this.resolveCollectionName(preset.label, sheetName);
          let count = 0;

          // バッチ書き込み（高速化）
          const batchSize = 500;
          for (let i = 0; i < rows.length; i += batchSize) {
            const batch = db.batch();
            const chunk = rows.slice(i, i + batchSize);
            for (const row of chunk) {
              const ref = db.collection(collectionName).doc();
              // フィールド名を正規化（日本語→英語）
              const normalized = this.normalizeFields(collectionName, row);
              batch.set(ref, {
                ...normalized,
                _appSource: preset.label,
                _sheetSource: sheetName,
                _migratedAt: ts,
              });
              count++;
            }
            await batch.commit();
          }

          if (count > 0) {
            totalCounts[`${preset.label} / ${sheetName}`] = count;
            sheetsDone++;
          }
        }

        if (statusEl) { statusEl.className = "badge bg-success"; statusEl.textContent = `完了 (${sheetsDone}シート)`; }
        appsDone++;
      }

      const lines = Object.entries(totalCounts)
        .map(([k, v]) => typeof v === "number" ? `<li>${k}: <strong>${v}件</strong></li>` : `<li class="text-danger">${k}: ${v}</li>`);

      alertEl.className = "alert alert-success";
      alertEl.innerHTML = `<strong>${appsDone}アプリのインポート完了!</strong><ul class="mb-0 mt-2">${lines.join("")}</ul>`;
      showToast("完了", `${appsDone}アプリのデータをインポートしました`, "success");
    } catch (e) {
      alertEl.className = "alert alert-danger";
      alertEl.textContent = `エラー: ${e.message}`;
      console.error("Auto import error:", e);
    }
  },

  /**
   * アプリ名+シート名からFirestoreのコレクション名を決定
   */
  resolveCollectionName(appName, sheetName) {
    // 民泊メインの主要シート → 専用コレクションにマッピング
    const mainMapping = {
      "清掃スタッフ": "staff",
      "フォームの回答 1": "bookings",
      "募集": "recruitments",
      "募集_立候補": "volunteers",
      "スタッフ報酬": "rewards",
      "仕事内容マスタ": "jobTypes",
      "特別料金": "specialRates",
      "募集設定": "settings_recruit",
      "設定_Webアプリ管理者": "settings_owner",
      "設定_連携": "syncSettings",
      "通知履歴": "notifications",
      "キャンセル申請": "cancelRequests",
      "スタッフ共有用": "staffShare",
      "ベッド数マスタ": "bedCounts",
      "物件オーナー": "subOwners",
    };

    // チェックリストの主要シート
    const checklistMapping = {
      "チェックリストマスタ": "checklistTemplates",
      "撮影箇所マスタ": "photoSpots",
      "チェックリスト記録": "checklistRecords",
      "チェックリスト写真": "checklistPhotos",
      "要補充記録": "supplyRecords",
    };

    if ((appName === "minpaku-main" || appName === "民泊メイン") && mainMapping[sheetName]) {
      return mainMapping[sheetName];
    }
    if ((appName === "checklist" || appName === "チェックリスト") && checklistMapping[sheetName]) {
      return checklistMapping[sheetName];
    }
    // 民泊メインにもチェックリスト系シートがある
    if (checklistMapping[sheetName]) {
      return checklistMapping[sheetName];
    }
    if (mainMapping[sheetName]) {
      return mainMapping[sheetName];
    }

    // その他: appName_sheetName形式でコレクションを作成
    const safeName = sheetName.replace(/[\/\s]/g, "_").replace(/[^a-zA-Z0-9_\u3000-\u9FFF]/g, "");
    return `migrated_${appName}_${safeName}`;
  },

  /**
   * フィールド名を日本語→英語に正規化
   */
  // 部分一致でフィールド値を検索（スプレッドシートの長いヘッダー名に対応）
  _findVal(row, keys) {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== "") return row[k];
      for (const dk of Object.keys(row)) {
        if (dk.includes(k) && row[dk] !== undefined && row[dk] !== "") return row[dk];
      }
    }
    return "";
  },

  // 文字列から数値抽出（「4人」→4）
  _extractNum(val) {
    if (!val) return 0;
    if (typeof val === "number") return val;
    const m = String(val).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  },

  normalizeFields(collectionName, row) {
    if (collectionName === "staff") {
      return {
        name: (row["名前"] || row["name"] || "").trim(),
        email: (row["メール"] || row["email"] || "").trim(),
        phone: (row["電話"] || row["phone"] || "").trim(),
        bankName: (row["金融機関名"] || row["bankName"] || "").trim(),
        branchName: (row["支店名"] || row["branchName"] || "").trim(),
        accountType: (row["口座種類"] || row["accountType"] || "普通").trim(),
        accountNumber: String(row["口座番号"] || row["accountNumber"] || "").trim(),
        accountHolder: (row["口座名義"] || row["accountHolder"] || "").trim(),
        memo: (row["住所"] || row["memo"] || "").trim(),
        active: (row["有効"] || row["active"] || "Y") !== "N",
        skills: [],
        availableDays: [],
        ratePerJob: 0,
        transportationFee: 0,
        displayOrder: 0,
      };
    }
    if (collectionName === "bookings") {
      return {
        propertyId: "",
        beds24BookingId: "",
        guestName: (this._findVal(row, ["氏名", "お名前", "guestName", "Full Name"]) || "").trim(),
        guestCount: this._extractNum(this._findVal(row, ["宿泊人数", "人数", "guestCount"])),
        guestCountInfants: this._extractNum(this._findVal(row, ["3才以下", "乳幼児", "guestCountInfants"])),
        checkIn: this._findVal(row, ["チェックイン", "Check-in", "checkIn"]) || "",
        checkOut: this._findVal(row, ["チェックアウト", "Check-out", "checkOut"]) || "",
        nationality: (this._findVal(row, ["国籍", "Nationality", "nationality"]) || "").trim(),
        phone: (this._findVal(row, ["電話", "TEL", "phone"]) || "").trim(),
        email: (this._findVal(row, ["メール", "mail", "email"]) || "").trim(),
        bbq: (this._findVal(row, ["バーベキュー", "BBQ", "bbq"]) || "").trim(),
        parking: (this._findVal(row, ["有料駐車場", "parking"]) || "").trim(),
        cleaningStaff: (this._findVal(row, ["清掃担当", "cleaningStaff"]) || "").trim(),
        purpose: (this._findVal(row, ["旅の目的", "目的", "purpose"]) || "").trim(),
        source: "migrated",
        status: "completed",
        bbq: String(row["BBQ"] || "").includes("あり"),
        parking: String(row["駐車場"] || "").includes("あり"),
        notes: (row["メモ"] || row["notes"] || "").trim(),
        cleaningStaff: (row["清掃担当"] || "").trim(),
        nationality: (row["国籍"] || "").trim(),
      };
    }
    if (collectionName === "recruitments") {
      return {
        checkOutDate: row["チェックアウト日"] || "",
        bookingRowNum: Number(row["予約行番号"] || 0),
        status: (row["ステータス"] || "").trim(),
        selectedStaff: (row["選定スタッフ"] || "").trim(),
        notifyDate: row["告知日"] || "",
        createdDate: row["作成日"] || "",
        memo: (row["メモ"] || "").trim(),
      };
    }
    if (collectionName === "rewards") {
      return {
        staffName: (row["スタッフ名"] || "").trim(),
        jobType: (row["仕事内容名"] || "").trim(),
        amount: Number(row["報酬額"] || 0),
        memo: (row["備考"] || "").trim(),
      };
    }
    // その他のコレクションはそのまま
    return row;
  },

  /**
   * 全コレクションの重複データを削除
   * 同名（name/guestName）の2件目以降を削除
   */
  async deduplicateAll() {
    const results = {};

    // スタッフ: name で重複チェック
    results.staff = await this._dedupCollection("staff", "name");

    // 予約: checkIn + guestName で重複チェック
    results.bookings = await this._dedupCollectionComposite("bookings", ["checkIn", "guestName"]);

    // 宿泊者名簿: checkIn + guestName の完全一致重複
    results.guestRegistrations = await this._dedupCollectionComposite("guestRegistrations", ["checkIn", "guestName"]);

    // 宿泊者名簿: 同一チェックイン日のプレースホルダ名を削除（実名が存在する場合）
    results["guestRegistrations（プレースホルダ）"] = await this._dedupGuestPlaceholders();

    return results;
  },

  async _dedupCollection(collectionName, keyField) {
    const snap = await db.collection(collectionName).get();
    if (snap.empty) return 0;

    const seen = {};
    let deleted = 0;

    for (const doc of snap.docs) {
      const d = doc.data();
      const key = (d[keyField] || "").toString().trim().toLowerCase();
      if (!key) continue;

      if (seen[key]) {
        // 2件目以降 → 削除（情報が多い方を残す）
        const existingDoc = seen[key];
        const existingData = existingDoc.data();
        // emailやphoneがある方を優先して残す
        const existingScore = (existingData.email ? 1 : 0) + (existingData.phone ? 1 : 0);
        const currentScore = (d.email ? 1 : 0) + (d.phone ? 1 : 0);
        if (currentScore > existingScore) {
          // 新しい方が情報が多い → 古い方を削除
          await db.collection(collectionName).doc(existingDoc.id).delete();
          seen[key] = doc;
        } else {
          await db.collection(collectionName).doc(doc.id).delete();
        }
        deleted++;
      } else {
        seen[key] = doc;
      }
    }
    return deleted;
  },

  /**
   * 宿泊者名簿: 同一チェックイン日にプレースホルダ名と実名が共存する場合、
   * プレースホルダ（Airbnb予約, Booking.com予約等）を削除
   */
  async _dedupGuestPlaceholders() {
    const snap = await db.collection("guestRegistrations").get();
    if (snap.empty) return 0;

    function isPlaceholder(name) {
      if (!name) return true;
      const n = name.trim().toLowerCase();
      return !n || n === "-" ||
        n.includes("airbnb") || n.includes("booking.com") ||
        n.includes("not available") || n.includes("closed") ||
        n.includes("予約") || n.includes("blocked");
    }

    // チェックイン日ごとにグループ化
    const byCheckIn = {};
    for (const doc of snap.docs) {
      const d = doc.data();
      const ci = d.checkIn || "";
      if (!ci) continue;
      if (!byCheckIn[ci]) byCheckIn[ci] = [];
      byCheckIn[ci].push({ doc, data: d, placeholder: isPlaceholder(d.guestName) });
    }

    let deleted = 0;
    for (const [ci, entries] of Object.entries(byCheckIn)) {
      if (entries.length < 2) continue;
      const hasReal = entries.some(e => !e.placeholder);
      if (!hasReal) continue; // 実名がなければ削除しない

      // プレースホルダを削除
      for (const entry of entries) {
        if (entry.placeholder) {
          await db.collection("guestRegistrations").doc(entry.doc.id).delete();
          deleted++;
        }
      }
    }
    return deleted;
  },

  async _dedupCollectionComposite(collectionName, keyFields) {
    const snap = await db.collection(collectionName).get();
    if (snap.empty) return 0;

    const seen = {};
    let deleted = 0;

    for (const doc of snap.docs) {
      const d = doc.data();
      const keyParts = keyFields.map(f => {
        const val = d[f];
        if (!val) return "";
        if (val.toDate) return val.toDate().toISOString().slice(0, 10);
        return String(val).trim().toLowerCase();
      });
      const key = keyParts.join("|");
      if (!key || key === "|") continue;

      if (seen[key]) {
        await db.collection(collectionName).doc(doc.id).delete();
        deleted++;
      } else {
        seen[key] = doc;
      }
    }
    return deleted;
  },

  async importJson() {
    const resultEl = document.getElementById("migrationResult");
    const alertEl = document.getElementById("migrationAlert");
    resultEl.classList.remove("d-none");
    alertEl.className = "alert alert-info";
    alertEl.textContent = "インポート中...";

    try {
      const json = document.getElementById("migrationJson").value.trim();
      if (!json) {
        alertEl.className = "alert alert-danger";
        alertEl.textContent = "JSONデータを貼り付けてください";
        return;
      }

      const data = JSON.parse(json);
      const ts = firebase.firestore.FieldValue.serverTimestamp();
      const counts = {};

      // ===== 1. スタッフ =====
      if (data.staff && data.staff.length > 0) {
        counts.staff = 0;
        for (const s of data.staff) {
          if (!s.name) continue;
          await db.collection("staff").add({
            name: s.name || "",
            email: s.email || "",
            phone: "",
            skills: [],
            availableDays: [],
            ratePerJob: 0,
            transportationFee: 0,
            bankName: s.bankName || "",
            branchName: s.branchName || s.bankBranch || "",
            accountType: s.accountType || "普通",
            accountNumber: s.accountNumber || "",
            accountHolder: s.accountHolder || "",
            memo: s.address || "",
            active: s.active === "N" ? false : s.active !== false,
            displayOrder: counts.staff,
            createdAt: ts, updatedAt: ts,
          });
          counts.staff++;
        }
      }

      // ===== 2. 予約 =====
      if (data.bookings && data.bookings.length > 0) {
        counts.bookings = 0;
        for (const b of data.bookings) {
          // 動的ヘッダーの場合のフィールドマッピング
          const checkIn = b.checkIn || b['チェックイン'] || null;
          const checkOut = b.checkOut || b['チェックアウト'] || null;
          if (!checkIn && !checkOut) continue;
          await db.collection("bookings").add({
            propertyId: "",
            beds24BookingId: "",
            guestName: b.guestName || b['氏名'] || b['お名前'] || "",
            guestCount: Number(b.guestCount || b['宿泊人数'] || b['人数']) || 0,
            checkIn: checkIn ? new Date(checkIn) : null,
            checkOut: checkOut ? new Date(checkOut) : null,
            source: "migrated",
            status: "completed",
            bbq: !!(b.bbq || String(b['BBQ'] || '').indexOf('あり') >= 0),
            parking: !!(b.parking || String(b['駐車場'] || '').indexOf('あり') >= 0),
            notes: b.notes || b['メモ'] || "",
            cleaningStaff: b.cleaningStaff || b['清掃担当'] || "",
            nationality: b['国籍'] || "",
            syncedAt: null,
            createdAt: ts,
          });
          counts.bookings++;
        }
      }

      // ===== 3. 募集 =====
      if (data.recruitments && data.recruitments.length > 0) {
        counts.recruitments = 0;
        for (const r of data.recruitments) {
          if (!r.checkOutDate && !r.status) continue;
          await db.collection("recruitments").add({
            checkOutDate: r.checkOutDate ? new Date(r.checkOutDate) : null,
            bookingRowNum: Number(r.bookingRowNum) || 0,
            notifyDate: r.notifyDate ? new Date(r.notifyDate) : null,
            status: String(r.status || ""),
            selectedStaff: String(r.selectedStaff || ""),
            reminderLastDate: r.reminderLastDate ? new Date(r.reminderLastDate) : null,
            createdDate: r.createdDate ? new Date(r.createdDate) : null,
            notifyMethod: String(r.notifyMethod || ""),
            memo: String(r.memo || ""),
            source: "migrated",
            createdAt: ts,
          });
          counts.recruitments++;
        }
      }

      // ===== 4. 立候補 =====
      if (data.volunteers && data.volunteers.length > 0) {
        counts.volunteers = 0;
        for (const v of data.volunteers) {
          if (!v.recruitId && !v.staffName) continue;
          await db.collection("volunteers").add({
            recruitId: String(v.recruitId || ""),
            staffName: String(v.staffName || ""),
            email: String(v.email || ""),
            volunteerDate: v.volunteerDate ? new Date(v.volunteerDate) : null,
            availability: String(v.availability || ""),
            status: String(v.status || ""),
            holdReason: String(v.holdReason || ""),
            source: "migrated",
            createdAt: ts,
          });
          counts.volunteers++;
        }
      }

      // ===== 5. スタッフ報酬 =====
      if (data.rewards && data.rewards.length > 0) {
        counts.rewards = 0;
        for (const r of data.rewards) {
          if (!r.staffName && !r.amount) continue;
          await db.collection("rewards").add({
            staffName: String(r.staffName || ""),
            jobType: String(r.jobType || ""),
            amount: Number(r.amount) || 0,
            memo: String(r.memo || ""),
            source: "migrated",
            createdAt: ts,
          });
          counts.rewards++;
        }
      }

      // ===== 6. 仕事内容マスタ =====
      if (data.jobTypes && data.jobTypes.length > 0) {
        counts.jobTypes = 0;
        for (const j of data.jobTypes) {
          if (!j.jobName) continue;
          await db.collection("jobTypes").add({
            jobName: String(j.jobName || ""),
            displayOrder: Number(j.displayOrder) || 0,
            active: j.active === "N" ? false : j.active !== false,
            createdAt: ts,
          });
          counts.jobTypes++;
        }
      }

      // ===== 7. 特別料金 =====
      if (data.specialRates && data.specialRates.length > 0) {
        counts.specialRates = 0;
        for (const s of data.specialRates) {
          if (!s.jobName && !s.itemName) continue;
          await db.collection("specialRates").add({
            jobName: String(s.jobName || ""),
            startDate: s.startDate ? new Date(s.startDate) : null,
            endDate: s.endDate ? new Date(s.endDate) : null,
            itemName: String(s.itemName || ""),
            additionalAmount: Number(s.additionalAmount) || 0,
            createdAt: ts,
          });
          counts.specialRates++;
        }
      }

      // ===== 8. 設定系 =====
      if (data.recruitSettings && Object.keys(data.recruitSettings).length > 0) {
        await db.collection("settings").doc("recruit").set({
          ...data.recruitSettings, migratedAt: ts,
        });
        counts.recruitSettings = Object.keys(data.recruitSettings).length;
      }
      if (data.ownerSettings && Object.keys(data.ownerSettings).length > 0) {
        await db.collection("settings").doc("owner").set({
          ...data.ownerSettings, migratedAt: ts,
        });
        counts.ownerSettings = Object.keys(data.ownerSettings).length;
      }

      // ===== 9. 連携設定 =====
      if (data.syncSettings && data.syncSettings.length > 0) {
        counts.syncSettings = 0;
        for (const s of data.syncSettings) {
          if (!s.platform) continue;
          await db.collection("syncSettings").add({
            platform: String(s.platform || ""),
            icalUrl: String(s.icalUrl || ""),
            active: s.active === "N" ? false : s.active !== false,
            lastSync: s.lastSync || null,
            createdAt: ts,
          });
          counts.syncSettings++;
        }
      }

      // ===== 10. 通知履歴 =====
      if (data.notifications && data.notifications.length > 0) {
        counts.notifications = 0;
        for (const n of data.notifications) {
          if (!n.datetime && !n.content) continue;
          await db.collection("notifications").add({
            datetime: n.datetime ? new Date(n.datetime) : null,
            type: String(n.type || ""),
            content: String(n.content || ""),
            read: !!n.read,
            source: "migrated",
            createdAt: ts,
          });
          counts.notifications++;
        }
      }

      // ===== 11. キャンセル申請 =====
      if (data.cancelRequests && data.cancelRequests.length > 0) {
        counts.cancelRequests = 0;
        for (const c of data.cancelRequests) {
          if (!c.recruitId && !c.staffName) continue;
          await db.collection("cancelRequests").add({
            recruitId: String(c.recruitId || ""),
            staffName: String(c.staffName || ""),
            email: String(c.email || ""),
            requestDate: c.requestDate ? new Date(c.requestDate) : null,
            source: "migrated",
            createdAt: ts,
          });
          counts.cancelRequests++;
        }
      }

      // ===== 12. チェックリスト関連 =====
      const checklistCollections = [
        { key: "checklistMaster", collection: "checklistTemplates_migrated" },
        { key: "photoSpots", collection: "photoSpots" },
        { key: "checklistRecords", collection: "checklistRecords_migrated" },
        { key: "checklistPhotos", collection: "checklistPhotos_migrated" },
        { key: "supplyRecords", collection: "supplyRecords" },
        { key: "staffShare", collection: "staffShare" },
        { key: "bedCounts", collection: "bedCounts" },
      ];
      for (const { key, collection } of checklistCollections) {
        if (data[key] && data[key].length > 0) {
          counts[key] = 0;
          for (const item of data[key]) {
            await db.collection(collection).add({ ...item, source: "migrated", createdAt: ts });
            counts[key]++;
          }
        }
      }

      // 結果表示
      const lines = Object.entries(counts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}: ${v}件`);

      alertEl.className = "alert alert-success";
      alertEl.innerHTML = `<strong>インポート完了!</strong><br>${lines.join("<br>")}`;
      showToast("完了", `全${lines.length}カテゴリのデータをインポートしました`, "success");
    } catch (e) {
      alertEl.className = "alert alert-danger";
      alertEl.textContent = `エラー: ${e.message}`;
      console.error("Migration error:", e);
    }
  },

  async importTsv() {
    const resultEl = document.getElementById("tsvResult");
    const alertEl = document.getElementById("tsvAlert");
    resultEl.classList.remove("d-none");

    try {
      const tsv = document.getElementById("tsvStaffData").value.trim();
      if (!tsv) {
        alertEl.className = "alert alert-danger";
        alertEl.textContent = "データを貼り付けてください";
        return;
      }

      const lines = tsv.split("\n").filter(l => l.trim());
      let count = 0;

      for (const line of lines) {
        const cols = line.split("\t");
        const name = (cols[0] || "").trim();
        if (!name) continue;

        await API.staff.create({
          name: name,
          email: (cols[2] || "").trim(),
          phone: "",
          skills: [],
          availableDays: [],
          ratePerJob: 0,
          transportationFee: 0,
          bankName: (cols[3] || "").trim(),
          branchName: (cols[4] || "").trim(),
          accountType: (cols[5] || "普通").trim(),
          accountNumber: (cols[6] || "").trim(),
          accountHolder: (cols[7] || "").trim(),
          memo: (cols[1] || "").trim(), // 住所をメモに
          active: (cols[8] || "Y").trim() !== "N",
          displayOrder: count,
        });
        count++;
      }

      alertEl.className = "alert alert-success";
      alertEl.textContent = `${count}件のスタッフをインポートしました`;

      // スタッフ一覧にデータが反映されたか表示
      showToast("完了", `${count}件のスタッフをインポートしました`, "success");
    } catch (e) {
      alertEl.className = "alert alert-danger";
      alertEl.textContent = `エラー: ${e.message}`;
    }
  },

  // ===== 宿泊者名簿フォーム管理（Googleフォーム風カードエディタ） =====

  // デフォルトフォーム定義（guest-form.htmlのDEFAULT_FIELDSと完全同期）
  DEFAULT_FORM_FIELDS: [
    // 宿泊情報
    { id: "checkIn", label: "チェックイン日", labelEn: "Check-in Date", type: "date", required: true, section: "stay", mapping: "checkIn" },
    { id: "checkOut", label: "チェックアウト日", labelEn: "Check-out Date", type: "date", required: true, section: "stay", mapping: "checkOut" },
    { id: "guestCount", label: "宿泊人数（大人）", labelEn: "Number of Guests (Adults)", type: "number", required: true, section: "stay", mapping: "guestCount", defaultValue: "1" },
    { id: "guestCountInfants", label: "3才以下の乳幼児", labelEn: "Infants (under 3)", type: "number", required: false, section: "stay", mapping: "guestCountInfants", defaultValue: "0" },
    { id: "bookingSite", label: "どこでこのホテルを予約しましたか？", labelEn: "Where did you book this accommodation?", type: "select", required: true, section: "stay", mapping: "bookingSite", options: ["Airbnb", "Booking.com", "じゃらん", "楽天トラベル", "直接予約", "その他"], optionsEn: ["Airbnb", "Booking.com", "Jalan", "Rakuten Travel", "Direct booking", "Other"] },
    // 代表者情報
    { id: "guestName", label: "代表者 氏名（フルネーム）", labelEn: "Primary Guest Full Name", type: "text", required: true, section: "representative", mapping: "guestName", placeholder: "山田 太郎 / Yamada Taro" },
    { id: "nationality", label: "国籍", labelEn: "Nationality", type: "text", required: true, section: "representative", mapping: "nationality", defaultValue: "日本" },
    { id: "address", label: "住所（現住所）", labelEn: "Address", type: "text", required: true, section: "representative", mapping: "address", placeholder: "〒000-0000 ○○県○○市..." },
    { id: "phone", label: "電話番号", labelEn: "Phone Number", type: "tel", required: true, section: "representative", mapping: "phone" },
    { id: "phone2", label: "電話番号（第2）", labelEn: "Phone (2nd)", type: "tel", required: true, section: "representative", mapping: "phone2" },
    { id: "email", label: "メールアドレス", labelEn: "Email Address", type: "email", required: false, section: "representative", mapping: "email" },
    { id: "email2", label: "メールアドレス（第2・任意）", labelEn: "Email (2nd, optional)", type: "email", required: false, section: "representative", mapping: "email2" },
    { id: "passportNumber", label: "旅券番号（外国籍の方のみ）", labelEn: "Passport No. (Foreign nationals only)", type: "text", required: false, section: "representative", mapping: "passportNumber" },
    { id: "passportPhoto", label: "パスポート写真（外国籍の方のみ）", labelEn: "Passport Photo URL (Foreign nationals only)", type: "text", required: false, section: "representative", mapping: "passportPhoto", placeholder: "URLまたはファイル名 / URL or filename" },
    { id: "purpose", label: "旅の目的", labelEn: "Purpose of Visit", type: "select", required: false, section: "representative", mapping: "purpose", options: ["観光", "仕事", "帰省", "イベント", "その他"], optionsEn: ["Tourism", "Business", "Homecoming", "Event", "Other"] },
    // 施設利用情報
    { id: "arrivalTime", label: "到着予定時刻", labelEn: "Estimated Arrival Time", type: "select", required: false, section: "facility", mapping: "arrivalTime", options: ["", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:00以降"], optionsEn: ["", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "After 20:00"] },
    { id: "departureTime", label: "出発予定時刻", labelEn: "Estimated Departure Time", type: "select", required: false, section: "facility", mapping: "departureTime", options: ["", "7:00", "7:30", "8:00", "8:30", "9:00", "9:30", "10:00", "10:00以降"], optionsEn: ["", "7:00", "7:30", "8:00", "8:30", "9:00", "9:30", "10:00", "After 10:00"] },
    { id: "cars", label: "お車は何台でお越しになりますか？\n※施設には駐車場がございません。徒歩15分の場所に有料駐車場があります。", labelEn: "How many cars will you bring?\n*No parking at facility. Paid parking available (15 min walk).", type: "select", required: false, section: "facility", mapping: "cars", options: ["0台（車なし）", "1台", "2台", "3台以上"], optionsEn: ["0 (No car)", "1 car", "2 cars", "3+ cars"] },
    { id: "bbq", label: "バーベキューセットをご利用されますか？", labelEn: "Would you like to use the BBQ set?", type: "select", required: false, section: "facility", mapping: "bbq", options: ["利用しない", "利用する（1セット）", "利用する（2セット）"], optionsEn: ["No", "Yes (1 set)", "Yes (2 sets)"] },
    { id: "bedChoice", label: "宿泊人数2名のお客様のみお答えください（ベッドの希望）", labelEn: "For 2 guests only: Bed preference", type: "select", required: false, section: "facility", mapping: "bedChoice", options: ["", "シングルベッド×2", "ダブルベッド×1", "布団"], optionsEn: ["", "2 Single Beds", "1 Double Bed", "Futon"] },
    { id: "bedCount", label: "ベッド数（希望）", labelEn: "Number of Beds (preferred)", type: "number", required: false, section: "facility", mapping: "bedCount" },
    // その他連絡事項
    { id: "memo", label: "ご要望・備考", labelEn: "Notes / Special Requests", type: "textarea", required: false, section: "other", mapping: "memo" },
    { id: "allergy", label: "アレルギー・特記事項", labelEn: "Allergies / Special Notes", type: "textarea", required: false, section: "other", mapping: "allergy", placeholder: "食物アレルギー、持病、車椅子利用等 / Food allergies, medical conditions, wheelchair use, etc." },
    { id: "emergencyContact", label: "緊急連絡先（代表者以外）", labelEn: "Emergency Contact (other than primary guest)", type: "text", required: false, section: "other", mapping: "emergencyContact", placeholder: "氏名・電話番号 / Name & Phone" },
    // ハウスルール同意
    { id: "houseRuleAgree", label: "利用規約・ハウスルールに同意します", labelEn: "I agree to the Terms of Use and House Rules", type: "checkbox-single", required: true, section: "agreement", mapping: "houseRuleAgree" },
  ],

  DEFAULT_SECTIONS: [
    { id: "stay", label: "宿泊情報", labelEn: "Stay Details", order: 1 },
    { id: "representative", label: "代表者情報（旅館業法に基づく記入事項）", labelEn: "Primary Guest (Required by Japanese Law)", order: 2 },
    { id: "facility", label: "施設利用情報", labelEn: "Facility Usage", order: 3 },
    { id: "other", label: "その他連絡事項", labelEn: "Other / Notes", order: 4 },
    { id: "agreement", label: "同意事項", labelEn: "Agreement", order: 5 },
    { id: "companions", label: "同行者情報", labelEn: "Companions", order: 6, isCompanion: true },
  ],

  TYPE_LABELS: {
    text: "テキスト", textarea: "テキスト(複数行)", date: "日付", number: "数値",
    tel: "電話番号", email: "メール", select: "プルダウン", radio: "ラジオボタン",
    checkbox: "チェックボックス(複数)", "checkbox-single": "チェックボックス(単一)",
    image: "画像",
  },

  formFields: [],
  expandedCards: new Set(),
  dragSourceIdx: null,

  async loadFormConfig() {
    // まずデフォルトで即座に表示（スピナー解消）
    this.formFields = JSON.parse(JSON.stringify(this.DEFAULT_FORM_FIELDS));
    this.renderFormFields();

    // Firestoreに保存済み設定があれば上書き
    try {
      const doc = await db.collection("settings").doc("guestForm").get();
      if (doc.exists && doc.data().fields?.length > 0) {
        this.formFields = doc.data().fields;
        this.renderFormFields();
      }
    } catch (e) {
      console.warn("フォーム設定読み込みエラー（デフォルトを使用）:", e);
    }
  },

  loadFormDefaults() {
    if (!confirm("デフォルト項目を読み込みます。現在の設定は上書きされます。よろしいですか？")) return;
    this.formFields = JSON.parse(JSON.stringify(this.DEFAULT_FORM_FIELDS));
    this.expandedCards.clear();
    this.renderFormFields();
    showToast("完了", "デフォルト項目を読み込みました。「保存」を押して反映してください。", "success");
  },

  getSectionLabel(secId) {
    const s = this.DEFAULT_SECTIONS.find(s => s.id === secId);
    return s ? s.label : secId;
  },

  hasOptions(type) {
    return ["select", "radio", "checkbox"].includes(type);
  },

  renderFormFields() {
    const container = document.getElementById("formFieldList");
    if (!this.formFields.length) {
      container.innerHTML = '<div class="text-center text-muted py-3">項目がありません。「デフォルト読み込み」または「項目追加」で開始してください。</div>';
      return;
    }

    let html = '';
    let lastSection = '';

    this.formFields.forEach((f, i) => {
      // セクション区切り
      if (f.section !== lastSection) {
        lastSection = f.section;
        html += `<div class="ff-section-sep"><i class="bi bi-folder2-open"></i> ${this.esc(this.getSectionLabel(f.section))}</div>`;
      }

      const isExpanded = this.expandedCards.has(i);
      const typeBadge = this.TYPE_LABELS[f.type] || f.type;
      const shortLabel = (f.label || "").split("\n")[0].substring(0, 40);

      html += `
        <div class="ff-card${isExpanded ? " expanded" : ""}" data-idx="${i}" draggable="true">
          <div class="ff-card-header" data-action="toggle" data-idx="${i}">
            <span class="ff-drag-handle" title="ドラッグで並び替え"><i class="bi bi-grip-vertical"></i></span>
            <span class="ff-card-num">${i + 1}</span>
            <div class="ff-card-title">
              <div class="ff-card-label">${this.esc(shortLabel) || '<span class="text-muted">(未入力)</span>'}</div>
              ${f.labelEn ? `<div class="ff-card-label-en">${this.esc(f.labelEn)}</div>` : ""}
            </div>
            <span class="badge bg-secondary ff-badge-type">${typeBadge}</span>
            ${f.required ? '<span class="badge bg-danger ff-badge-req">必須</span>' : ""}
            <span class="badge bg-light text-dark ff-badge-sec">${this.esc(this.getSectionLabel(f.section))}</span>
            <i class="bi bi-chevron-${isExpanded ? "up" : "down"} ff-chevron"></i>
          </div>
          ${isExpanded ? this.renderFieldCardBody(f, i) : ""}
        </div>`;
    });

    container.innerHTML = html;
    this.bindCardEvents(container);
  },

  renderFieldCardBody(f, idx) {
    const secOpts = this.DEFAULT_SECTIONS.filter(s => !s.isCompanion).map(s =>
      `<option value="${s.id}" ${f.section === s.id ? "selected" : ""}>${this.esc(s.label)}</option>`
    ).join("");

    const typeOpts = Object.entries(this.TYPE_LABELS).map(([v, l]) =>
      `<option value="${v}" ${f.type === v ? "selected" : ""}>${l}</option>`
    ).join("");

    let optionsHtml = "";
    if (this.hasOptions(f.type)) {
      const opts = f.options || [];
      const optsEn = f.optionsEn || [];
      optionsHtml = `
        <div class="ff-options-section mt-3">
          <label class="form-label fw-semibold small"><i class="bi bi-list-ul"></i> 選択肢</label>
          <div class="ff-options-list" data-idx="${idx}">
            ${opts.map((o, oi) => `
              <div class="ff-opt-row" data-oi="${oi}">
                <span class="ff-opt-num">${oi + 1}.</span>
                <input type="text" class="form-control form-control-sm ff-opt-jp" value="${this.esc(o)}" placeholder="日本語">
                <input type="text" class="form-control form-control-sm ff-opt-en" value="${this.esc(optsEn[oi] || "")}" placeholder="English">
                <button class="btn btn-sm btn-outline-secondary ff-opt-up" data-idx="${idx}" data-oi="${oi}" title="上へ"><i class="bi bi-arrow-up"></i></button>
                <button class="btn btn-sm btn-outline-secondary ff-opt-down" data-idx="${idx}" data-oi="${oi}" title="下へ"><i class="bi bi-arrow-down"></i></button>
                <button class="btn btn-sm btn-outline-danger ff-opt-del" data-idx="${idx}" data-oi="${oi}" title="削除"><i class="bi bi-x"></i></button>
              </div>
            `).join("")}
          </div>
          <button class="btn btn-sm btn-outline-primary mt-1 ff-opt-add" data-idx="${idx}">
            <i class="bi bi-plus"></i> 選択肢を追加
          </button>
        </div>`;
    }

    // 画像タイプ用フィールド
    let imageHtml = "";
    if (f.type === "image") {
      imageHtml = `
        <div class="row g-2 mb-2">
          <div class="col-md-6">
            <label class="form-label small">画像URL</label>
            <input type="url" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="imageUrl" value="${this.esc(f.imageUrl || "")}" placeholder="https://...">
          </div>
          <div class="col-md-3">
            <label class="form-label small">幅（%）</label>
            <input type="number" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="imageWidth" value="${f.imageWidth || 100}" min="10" max="100">
          </div>
          <div class="col-md-3">
            <label class="form-label small">アップロード</label>
            <div class="position-relative">
              <input type="file" class="form-control form-control-sm ff-image-upload" data-idx="${idx}" accept="image/*" style="font-size:0.75rem;">
            </div>
          </div>
        </div>
        <div class="ff-upload-progress d-none mb-2" data-idx="${idx}">
          <div class="progress" style="height:6px;">
            <div class="progress-bar progress-bar-striped progress-bar-animated" style="width:0%"></div>
          </div>
          <small class="text-muted">アップロード中...</small>
        </div>
        ${f.imageUrl ? `<div class="mb-2"><img src="${this.esc(f.imageUrl)}" style="max-width:300px;max-height:200px;border-radius:4px;border:1px solid #ddd;"></div>` : ""}`;
    }

    return `
      <div class="ff-card-body">
        <div class="row g-2 mb-2">
          <div class="col-md-5">
            <label class="form-label small">ラベル（日本語）</label>
            <textarea class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="label" rows="2">${this.esc(f.label || "")}</textarea>
          </div>
          <div class="col-md-5">
            <label class="form-label small">ラベル（英語）</label>
            <textarea class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="labelEn" rows="2">${this.esc(f.labelEn || "")}</textarea>
          </div>
          <div class="col-md-2 d-flex align-items-end">
            <button class="btn btn-sm btn-outline-warning w-100 ff-translate-one" data-idx="${idx}" title="この項目をGeminiで翻訳"><i class="bi bi-translate"></i></button>
          </div>
        </div>
        <div class="row g-2 mb-2">
          <div class="col-md-3">
            <label class="form-label small">種類</label>
            <select class="form-select form-select-sm ff-edit" data-idx="${idx}" data-key="type">${typeOpts}</select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">セクション</label>
            <select class="form-select form-select-sm ff-edit" data-idx="${idx}" data-key="section">${secOpts}</select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">マッピングID</label>
            <input type="text" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="mapping" value="${this.esc(f.mapping || "")}">
          </div>
          <div class="col-md-3 d-flex align-items-end">
            <div class="form-check">
              <input type="checkbox" class="form-check-input ff-edit" data-idx="${idx}" data-key="required" id="ff_req_${idx}" ${f.required ? "checked" : ""}>
              <label class="form-check-label small" for="ff_req_${idx}">必須</label>
            </div>
          </div>
        </div>
        ${imageHtml}
        ${f.type !== "image" ? `<div class="row g-2 mb-2">
          <div class="col-md-6">
            <label class="form-label small">デフォルト値</label>
            <input type="text" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="defaultValue" value="${this.esc(f.defaultValue || "")}">
          </div>
          <div class="col-md-6">
            <label class="form-label small">プレースホルダ</label>
            <input type="text" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="placeholder" value="${this.esc(f.placeholder || "")}">
          </div>
        </div>` : ""}
        ${optionsHtml}
        <div class="d-flex gap-2 mt-3 pt-2 border-top">
          <button class="btn btn-sm btn-outline-primary ff-action-dup" data-idx="${idx}"><i class="bi bi-copy"></i> 複製</button>
          <button class="btn btn-sm btn-outline-danger ff-action-del" data-idx="${idx}"><i class="bi bi-trash"></i> 削除</button>
        </div>
      </div>`;
  },

  bindCardEvents(container) {
    // カードヘッダー展開/折り畳みトグル
    container.querySelectorAll(".ff-card-header").forEach(hdr => {
      hdr.addEventListener("click", (e) => {
        if (e.target.closest(".ff-drag-handle")) return;
        const idx = Number(hdr.dataset.idx);
        if (this.expandedCards.has(idx)) this.expandedCards.delete(idx);
        else this.expandedCards.add(idx);
        this.renderFormFields();
      });
    });

    // フィールド値の編集（リアルタイム更新）
    container.querySelectorAll(".ff-edit").forEach(el => {
      const handler = () => {
        const idx = Number(el.dataset.idx);
        const key = el.dataset.key;
        if (key === "required") {
          this.formFields[idx][key] = el.checked;
        } else if (el.tagName === "TEXTAREA") {
          this.formFields[idx][key] = el.value;
        } else {
          this.formFields[idx][key] = el.value;
        }
        // type変更時は選択肢セクションの表示/非表示を切り替える
        if (key === "type") {
          this.renderFormFields();
        }
        // セクション変更時は再描画（区切り線の更新）
        if (key === "section") {
          this.renderFormFields();
        }
      };
      el.addEventListener("change", handler);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.addEventListener("input", handler);
      }
    });

    // 選択肢の編集
    container.querySelectorAll(".ff-opt-jp, .ff-opt-en").forEach(el => {
      el.addEventListener("input", () => {
        const row = el.closest(".ff-opt-row");
        const list = el.closest(".ff-options-list");
        const idx = Number(list.dataset.idx);
        const oi = Number(row.dataset.oi);
        if (el.classList.contains("ff-opt-jp")) {
          if (!this.formFields[idx].options) this.formFields[idx].options = [];
          this.formFields[idx].options[oi] = el.value;
        } else {
          if (!this.formFields[idx].optionsEn) this.formFields[idx].optionsEn = [];
          this.formFields[idx].optionsEn[oi] = el.value;
        }
      });
    });

    // 選択肢追加
    container.querySelectorAll(".ff-opt-add").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        if (!this.formFields[idx].options) this.formFields[idx].options = [];
        if (!this.formFields[idx].optionsEn) this.formFields[idx].optionsEn = [];
        this.formFields[idx].options.push("");
        this.formFields[idx].optionsEn.push("");
        this.renderFormFields();
      });
    });

    // 選択肢削除
    container.querySelectorAll(".ff-opt-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const oi = Number(btn.dataset.oi);
        this.formFields[idx].options.splice(oi, 1);
        (this.formFields[idx].optionsEn || []).splice(oi, 1);
        this.renderFormFields();
      });
    });

    // 選択肢上下移動
    container.querySelectorAll(".ff-opt-up, .ff-opt-down").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const oi = Number(btn.dataset.oi);
        const dir = btn.classList.contains("ff-opt-up") ? -1 : 1;
        const opts = this.formFields[idx].options || [];
        const optsEn = this.formFields[idx].optionsEn || [];
        const newOi = oi + dir;
        if (newOi < 0 || newOi >= opts.length) return;
        [opts[oi], opts[newOi]] = [opts[newOi], opts[oi]];
        if (optsEn.length > Math.max(oi, newOi)) {
          [optsEn[oi], optsEn[newOi]] = [optsEn[newOi], optsEn[oi]];
        }
        this.renderFormFields();
      });
    });

    // 画像アップロード
    container.querySelectorAll(".ff-image-upload").forEach(input => {
      input.addEventListener("change", (e) => this.uploadFormImage(Number(input.dataset.idx), e.target.files[0]));
    });

    // 個別翻訳ボタン
    container.querySelectorAll(".ff-translate-one").forEach(btn => {
      btn.addEventListener("click", () => this.translateOneWithGemini(Number(btn.dataset.idx)));
    });

    // フィールド複製
    container.querySelectorAll(".ff-action-dup").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const clone = JSON.parse(JSON.stringify(this.formFields[idx]));
        clone.id = "field_" + Date.now();
        clone.label = (clone.label || "") + "（コピー）";
        this.formFields.splice(idx + 1, 0, clone);
        this.expandedCards.clear();
        this.expandedCards.add(idx + 1);
        this.renderFormFields();
      });
    });

    // フィールド削除
    container.querySelectorAll(".ff-action-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        if (!confirm(`「${this.formFields[idx].label || ""}」を削除しますか？`)) return;
        this.formFields.splice(idx, 1);
        this.expandedCards.clear();
        this.renderFormFields();
      });
    });

    // ドラッグ&ドロップ
    this.initDragDrop(container);
  },

  initDragDrop(container) {
    const cards = container.querySelectorAll(".ff-card");
    cards.forEach(card => {
      card.addEventListener("dragstart", (e) => {
        this.dragSourceIdx = Number(card.dataset.idx);
        card.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.dragSourceIdx);
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        container.querySelectorAll(".ff-card").forEach(c => c.classList.remove("drag-over"));
        this.dragSourceIdx = null;
      });
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        container.querySelectorAll(".ff-card").forEach(c => c.classList.remove("drag-over"));
        card.classList.add("drag-over");
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("drag-over");
      });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drag-over");
        const fromIdx = this.dragSourceIdx;
        const toIdx = Number(card.dataset.idx);
        if (fromIdx === null || fromIdx === toIdx) return;
        const [moved] = this.formFields.splice(fromIdx, 1);
        this.formFields.splice(toIdx, 0, moved);
        // 展開状態をリセット
        this.expandedCards.clear();
        this.renderFormFields();
      });
    });
  },

  addFormFieldRow() {
    const newField = {
      id: "field_" + Date.now(),
      label: "",
      labelEn: "",
      type: "text",
      required: false,
      section: "other",
      mapping: "",
      options: [],
      optionsEn: [],
      defaultValue: "",
      placeholder: "",
    };
    this.formFields.push(newField);
    this.expandedCards.clear();
    this.expandedCards.add(this.formFields.length - 1);
    this.renderFormFields();
    // 最後のカードにスクロール
    const lastCard = document.querySelector("#formFieldList .ff-card:last-child");
    if (lastCard) lastCard.scrollIntoView({ behavior: "smooth", block: "center" });
  },

  async saveFormConfig() {
    const fields = this.formFields.map((f, i) => ({ ...f, order: i + 1 }));

    const resultEl = document.getElementById("formSaveResult");
    const alertEl = document.getElementById("formSaveAlert");
    resultEl.classList.remove("d-none");
    alertEl.className = "alert alert-info py-2";
    alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>保存中...';

    try {
      await db.collection("settings").doc("guestForm").set({
        fields,
        sections: this.DEFAULT_SECTIONS,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      this.formFields = fields;
      alertEl.className = "alert alert-success py-2";
      alertEl.textContent = `${fields.length}件のフォーム項目を保存しました。ゲストフォームに即時反映されます。`;
      showToast("完了", "フォーム設定を保存しました", "success");
    } catch (e) {
      alertEl.className = "alert alert-danger py-2";
      alertEl.textContent = `保存失敗: ${e.message}`;
    }
  },

  showFormPreview() {
    const body = document.getElementById("formPreviewBody");
    if (!body) return;

    const sectionLabels = {};
    this.DEFAULT_SECTIONS.forEach(s => { sectionLabels[s.id] = s.label; });

    let html = '<form class="preview-form">';
    let lastSec = "";

    this.formFields.forEach(f => {
      if (f.section !== lastSec) {
        lastSec = f.section;
        html += `<h6 class="mt-3 mb-2 fw-bold text-primary border-bottom pb-1">${this.esc(sectionLabels[f.section] || f.section)}</h6>`;
      }

      const reqMark = f.required ? ' <span class="text-danger">*</span>' : "";
      const label = (f.label || "").replace(/\n/g, "<br>");
      html += `<div class="mb-3"><label class="form-label">${label}${reqMark}</label>`;

      switch (f.type) {
        case "image":
          html += f.imageUrl ? `<div class="text-center"><img src="${this.esc(f.imageUrl)}" style="width:${f.imageWidth || 100}%;max-width:100%;border-radius:8px;"></div>` : '<span class="text-muted">（画像URL未設定）</span>';
          break;
        case "textarea":
          html += `<textarea class="form-control" rows="2" placeholder="${this.esc(f.placeholder || "")}" disabled></textarea>`;
          break;
        case "select":
          html += `<select class="form-select" disabled><option>--</option>${(f.options || []).map(o => `<option>${this.esc(o)}</option>`).join("")}</select>`;
          break;
        case "radio":
          (f.options || []).forEach((o, oi) => {
            html += `<div class="form-check"><input class="form-check-input" type="radio" disabled><label class="form-check-label">${this.esc(o)}</label></div>`;
          });
          break;
        case "checkbox":
          (f.options || []).forEach(o => {
            html += `<div class="form-check"><input class="form-check-input" type="checkbox" disabled><label class="form-check-label">${this.esc(o)}</label></div>`;
          });
          break;
        case "checkbox-single":
          html += `<div class="form-check"><input class="form-check-input" type="checkbox" disabled><label class="form-check-label">${this.esc(f.label)}</label></div>`;
          break;
        case "date":
          html += `<input type="date" class="form-control" disabled>`;
          break;
        case "number":
          html += `<input type="number" class="form-control" value="${this.esc(f.defaultValue || "")}" disabled>`;
          break;
        default:
          html += `<input type="${f.type || "text"}" class="form-control" placeholder="${this.esc(f.placeholder || "")}" value="${this.esc(f.defaultValue || "")}" disabled>`;
      }
      html += "</div>";
    });
    html += "</form>";
    body.innerHTML = html;

    const modal = new bootstrap.Modal(document.getElementById("formPreviewModal"));
    modal.show();
  },

  // --- 画像アップロード ---

  async uploadFormImage(idx, file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("エラー", "画像ファイルを選択してください", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast("エラー", "5MB以下の画像を選択してください", "error");
      return;
    }

    const progressEl = document.querySelector(`.ff-upload-progress[data-idx="${idx}"]`);
    const progressBar = progressEl?.querySelector(".progress-bar");
    if (progressEl) progressEl.classList.remove("d-none");

    try {
      const storage = firebase.storage();
      const ext = file.name.split(".").pop() || "jpg";
      const path = `form-images/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const ref = storage.ref(path);
      const task = ref.put(file);

      task.on("state_changed",
        (snap) => {
          const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
          if (progressBar) progressBar.style.width = pct + "%";
        },
        (err) => {
          if (progressEl) progressEl.classList.add("d-none");
          showToast("エラー", `アップロード失敗: ${err.message}`, "error");
        },
        async () => {
          const url = await ref.getDownloadURL();
          this.formFields[idx].imageUrl = url;
          if (progressEl) progressEl.classList.add("d-none");
          this.renderFormFields();
          showToast("完了", "画像をアップロードしました", "success");
        }
      );
    } catch (e) {
      if (progressEl) progressEl.classList.add("d-none");
      showToast("エラー", `アップロード失敗: ${e.message}`, "error");
    }
  },

  // --- Gemini翻訳 ---

  async getGeminiConfig() {
    try {
      const doc = await db.collection("settings").doc("gemini").get();
      if (doc.exists) {
        const d = doc.data();
        if (d.apiKey && d.model) return { apiKey: d.apiKey, model: d.model };
      }
    } catch (e) { /* ignore */ }
    showToast("エラー", "Gemini APIキーが未設定です。上の「Gemini API」セクションで設定してください。", "error");
    return null;
  },

  async callGeminiTranslate(apiKey, model, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || res.statusText);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  },

  async translateOneWithGemini(idx) {
    const f = this.formFields[idx];
    if (!f.label) { showToast("エラー", "日本語ラベルが空です", "error"); return; }

    const cfg = await this.getGeminiConfig();
    if (!cfg) return;

    const btn = document.querySelector(`.ff-translate-one[data-idx="${idx}"]`);
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    btn.disabled = true;

    try {
      // ラベル + 選択肢を一括翻訳
      let prompt = `以下の日本語を自然な英語に翻訳してください。JSONで返してください。\n\n`;
      const reqObj = { label: f.label };
      if (f.options?.length) reqObj.options = f.options;
      if (f.placeholder) reqObj.placeholder = f.placeholder;
      prompt += JSON.stringify(reqObj, null, 2);
      prompt += `\n\n返答はJSON形式のみ（コードブロックなし）。キー名はそのまま: {"label":"...","options":["..."],"placeholder":"..."}`;

      const raw = await this.callGeminiTranslate(cfg.apiKey, cfg.model, prompt);
      const json = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

      if (json.label) f.labelEn = json.label;
      if (json.options?.length) f.optionsEn = json.options;
      if (json.placeholder) f.placeholderEn = json.placeholder;

      this.renderFormFields();
      showToast("完了", `「${f.label.split("\n")[0].substring(0, 20)}」を翻訳しました`, "success");
    } catch (e) {
      showToast("エラー", `翻訳失敗: ${e.message}`, "error");
    } finally {
      // ボタンはrenderFormFieldsで再描画されるので復元不要
    }
  },

  async translateAllWithGemini() {
    const cfg = await this.getGeminiConfig();
    if (!cfg) return;

    // 翻訳が必要な項目を抽出（日本語ラベルがあるのに英語が空）
    const targets = this.formFields
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.label && !f.labelEn);

    if (!targets.length) {
      showToast("情報", "全項目に英語ラベルが設定済みです。空の項目のみ翻訳対象です。", "info");
      return;
    }

    const btn = document.getElementById("btnTranslateAll");
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> 翻訳中...';
    btn.disabled = true;

    try {
      // バッチで翻訳（全項目を1回のAPI呼び出しで）
      const reqArray = targets.map(({ f, i }) => {
        const obj = { idx: i, label: f.label };
        if (f.options?.length) obj.options = f.options;
        if (f.placeholder) obj.placeholder = f.placeholder;
        return obj;
      });

      const prompt = `以下のフォーム項目を自然な英語に翻訳してください。宿泊者名簿（Guest Registration Form）の文脈です。
JSON配列で返してください。コードブロックは不要です。

入力:
${JSON.stringify(reqArray, null, 2)}

出力形式: [{"idx":0,"label":"...","options":["..."],"placeholder":"..."}, ...]
idxはそのまま返してください。optionsとplaceholderは入力にある場合のみ返してください。`;

      const raw = await this.callGeminiTranslate(cfg.apiKey, cfg.model, prompt);
      const results = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

      let count = 0;
      for (const r of results) {
        const f = this.formFields[r.idx];
        if (!f) continue;
        if (r.label) { f.labelEn = r.label; count++; }
        if (r.options?.length) f.optionsEn = r.options;
        if (r.placeholder) f.placeholderEn = r.placeholder;
      }

      this.renderFormFields();
      showToast("完了", `${count}件の項目を英語翻訳しました。「保存」を押して反映してください。`, "success");
    } catch (e) {
      showToast("エラー", `一括翻訳失敗: ${e.message}`, "error");
    } finally {
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  },

  // ========== iCal同期設定 ==========

  async saveIcalInterval() {
    const interval = parseInt(document.getElementById("icalSyncInterval").value, 10);
    try {
      await db.collection("settings").doc("syncConfig").set(
        { icalSyncInterval: interval, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      const label = { 5: "5分おき", 10: "10分おき", 15: "15分おき", 30: "30分おき", 60: "1時間おき", 0: "手動のみ" }[interval] || `${interval}分おき`;
      showToast("保存", `iCal同期頻度を「${label}」に設定しました`, "success");
    } catch (e) {
      showToast("エラー", `保存失敗: ${e.message}`, "error");
    }
  },

  async loadIcalSettings() {
    // 同期頻度のみ読み込み (URL一覧は物件詳細画面で管理)
    try {
      const configDoc = await db.collection("settings").doc("syncConfig").get();
      if (configDoc.exists) {
        const cfg = configDoc.data();
        if (cfg.icalSyncInterval !== undefined) {
          const sel = document.getElementById("icalSyncInterval");
          if (sel) sel.value = String(cfg.icalSyncInterval);
        }
      }
    } catch (e) {
      console.warn("syncConfig読み込みエラー:", e);
    }
  },

  async syncIcalNow() {
    const resultEl = document.getElementById("icalSyncResult");
    const alertEl = document.getElementById("icalSyncAlert");
    resultEl.classList.remove("d-none");
    alertEl.className = "alert alert-info py-1 small";
    alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>同期チェック中...';

    try {
      // 同期頻度設定を取得
      let syncInterval = 30; // デフォルト30分
      try {
        const configDoc = await db.collection("settings").doc("syncConfig").get();
        if (configDoc.exists && configDoc.data().icalSyncInterval !== undefined) {
          syncInterval = configDoc.data().icalSyncInterval;
        }
      } catch (_) {}

      // 手動のみ設定（interval=0）でも「今すぐ同期」は実行可
      const snap = await db.collection("syncSettings").get();
      if (snap.empty) {
        alertEl.className = "alert alert-warning py-1 small";
        alertEl.textContent = "iCal URLが未登録です。先にURLを追加してください。";
        return;
      }

      const now = Date.now();
      const active = [];
      const skipped = [];
      snap.forEach(doc => {
        const d = doc.data();
        if (d.active === false) return;
        const lastSyncMs = d.lastSync ? d.lastSync.seconds * 1000 : 0;
        const elapsedMin = (now - lastSyncMs) / 60000;
        // syncInterval=0は手動のみ→常にスキップしない（今すぐボタンは実行）
        if (syncInterval > 0 && elapsedMin < syncInterval) {
          skipped.push({ platform: d.platform, elapsedMin: Math.round(elapsedMin), interval: syncInterval });
        } else {
          active.push({ platform: d.platform, lastSync: d.lastSync, result: d.lastSyncResult });
        }
      });

      if (active.length === 0 && skipped.length === 0) {
        alertEl.className = "alert alert-warning py-1 small";
        alertEl.textContent = "有効なiCal URLがありません。";
        return;
      }

      let html = "";
      if (active.length > 0) {
        html += `<strong>同期対象（${active.length}件）:</strong><ul class="mb-1 mt-1">`;
        active.forEach(s => {
          const lastSync = s.lastSync ? new Date(s.lastSync.seconds * 1000).toLocaleString("ja-JP") : "未同期";
          html += `<li>${this.esc(s.platform)}: 最終同期 ${lastSync}${s.result ? ` (${this.esc(s.result)})` : ""}</li>`;
        });
        html += "</ul>";
      }
      if (skipped.length > 0) {
        html += `<span class="text-muted">スキップ（設定間隔${syncInterval}分未満）: `;
        html += skipped.map(s => `${this.esc(s.platform)}（${s.elapsedMin}分前に同期済）`).join(", ");
        html += "</span><br>";
      }
      html += `<small class="text-muted">※ 自動同期は5分おきに実行されます。</small>`;
      alertEl.className = "alert alert-info py-1 small";
      alertEl.innerHTML = html;
    } catch (e) {
      alertEl.className = "alert alert-danger py-1 small";
      alertEl.textContent = `エラー: ${e.message}`;
    }
  },

  esc(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
