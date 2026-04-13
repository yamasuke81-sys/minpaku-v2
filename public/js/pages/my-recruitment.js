/**
 * スタッフ用募集回答ページ
 * 「募集中」の募集一覧を表示し、◎/△/×で回答
 */
const MyRecruitmentPage = {
  staffId: null,
  staffDoc: null,

  async render(container) {
    this.staffId = Auth.currentUser?.staffId;
    if (!this.staffId) {
      container.innerHTML = '<div class="alert alert-warning m-3">スタッフ情報が取得できません。</div>';
      return;
    }

    container.innerHTML = `
      <div class="container-fluid px-3 py-3">
        <h5 class="mb-3"><i class="bi bi-megaphone"></i> 募集回答</h5>
        <div id="recruitmentList">
          <div class="text-center py-4">
            <div class="spinner-border spinner-border-sm text-primary"></div>
          </div>
        </div>
      </div>
    `;

    try {
      // 自分のスタッフ情報を取得
      const staffSnap = await db.collection("staff").doc(this.staffId).get();
      this.staffDoc = staffSnap.exists ? staffSnap.data() : {};

      await this.loadRecruitments();
    } catch (e) {
      console.error("募集読み込みエラー:", e);
      document.getElementById("recruitmentList").innerHTML = `
        <div class="alert alert-danger">読み込みエラー: ${e.message}</div>
      `;
    }
  },

  async loadRecruitments() {
    const snap = await db.collection("recruitments")
      .where("status", "==", "募集中")
      .get();

    const recruitments = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.checkoutDate || "").localeCompare(b.checkoutDate || ""));

    const listEl = document.getElementById("recruitmentList");

    if (recruitments.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-5 text-muted">
          <i class="bi bi-check-circle" style="font-size:2rem;"></i>
          <p class="mt-2">現在、募集中の案件はありません</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = recruitments.map(r => this.renderRecruitmentCard(r)).join("");

    // 回答ボタンにイベントを設定
    listEl.querySelectorAll(".response-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const recruitId = e.currentTarget.dataset.recruitId;
        const response = e.currentTarget.dataset.response;
        this.submitResponse(recruitId, response);
      });
    });
  },

  renderRecruitmentCard(recruitment) {
    const responses = recruitment.responses || [];
    const myResponse = responses.find(r => r.staffId === this.staffId);
    const myAnswer = myResponse?.response || null;

    const date = recruitment.checkoutDate || "未定";
    const property = recruitment.propertyName || "";
    const memo = recruitment.memo || "";

    // 回答状況サマリー
    const okCount = responses.filter(r => r.response === "◎" || r.response === "△").length;
    const ngCount = responses.filter(r => r.response === "×").length;

    const buttons = ["◎", "△", "×"].map(resp => {
      const isSelected = myAnswer === resp;
      const colorMap = { "◎": "btn-success", "△": "btn-warning", "×": "btn-danger" };
      const outlineMap = { "◎": "btn-outline-success", "△": "btn-outline-warning", "×": "btn-outline-danger" };
      const labelMap = { "◎": "OK", "△": "微妙", "×": "NG" };
      const btnClass = isSelected ? colorMap[resp] : outlineMap[resp];

      return `
        <button class="btn ${btnClass} response-btn"
                data-recruit-id="${recruitment.id}"
                data-response="${resp}"
                ${isSelected ? 'style="font-weight:bold;box-shadow:0 0 0 3px rgba(0,0,0,0.15);"' : ""}>
          ${resp} ${labelMap[resp]}
        </button>
      `;
    }).join("");

    return `
      <div class="card staff-card mb-3" id="recruit-${recruitment.id}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <div>
              <div class="fw-bold">${date}</div>
              ${property ? `<div class="text-muted small"><i class="bi bi-geo-alt"></i> ${property}</div>` : ""}
            </div>
            <span class="badge bg-secondary small">回答 ${okCount + ngCount}件</span>
          </div>
          ${memo ? `<div class="text-muted small mb-2"><i class="bi bi-chat-left-text"></i> ${memo}</div>` : ""}
          ${myAnswer ? `<div class="small mb-2 text-primary"><i class="bi bi-check-circle"></i> 回答済み: ${myAnswer}</div>` : ""}
          <div class="response-btn-group d-flex gap-2">
            ${buttons}
          </div>
        </div>
      </div>
    `;
  },

  async submitResponse(recruitmentId, response) {
    try {
      const responseData = {
        staffId: this.staffId,
        staffName: this.staffDoc?.name || "不明",
        staffEmail: this.staffDoc?.email || "",
        response,
        memo: "",
      };

      // Firestore直接書き込み（既存のresponses配列にUpsert）
      const ref = db.collection("recruitments").doc(recruitmentId);
      const doc = await ref.get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const data = doc.data();
      const responses = data.responses || [];

      // 既存回答があれば上書き、なければ追加
      const idx = responses.findIndex(r => r.staffId === this.staffId);
      const entry = { ...responseData, respondedAt: new Date().toISOString() };
      if (idx >= 0) {
        responses[idx] = entry;
      } else {
        responses.push(entry);
      }

      await ref.update({
        responses,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      showToast("送信完了", `${response} で回答しました`, "success");

      // カードを再描画
      const cardEl = document.getElementById(`recruit-${recruitmentId}`);
      if (cardEl) {
        const updatedDoc = await ref.get();
        const updatedRecruitment = { id: recruitmentId, ...updatedDoc.data() };
        cardEl.outerHTML = this.renderRecruitmentCard(updatedRecruitment);

        // 再描画後のボタンにイベント再設定
        document.querySelectorAll(`#recruit-${recruitmentId} .response-btn`).forEach(btn => {
          btn.addEventListener("click", (e) => {
            const rid = e.currentTarget.dataset.recruitId;
            const resp = e.currentTarget.dataset.response;
            this.submitResponse(rid, resp);
          });
        });
      }
    } catch (e) {
      console.error("回答送信エラー:", e);
      showToast("エラー", `回答の送信に失敗しました: ${e.message}`, "error");
    }
  },
};
