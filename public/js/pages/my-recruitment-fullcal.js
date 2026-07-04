/**
 * 清掃スケジュール【月表示】ページ
 * MyRecruitmentPage を継承し renderCalendar() のみオーバーライドする。
 *
 * 横カレンダーの折りたたみ内にあった FullCalendar (月表示) を独立ビューとして表示する:
 *  - 横スクロールカレンダー本体・凡例・ヘッダの月ナビは非表示
 *    (月移動は FullCalendar 自前の prev/next/today ツールバーを使う)
 *  - #myRecFullCalendar の collapse を常時展開し、折りたたみトグルボタンを隠す
 *  - FullCalendar の初期化/更新・物件フィルタ・イベントクリック時のモーダル
 *    (予約詳細/募集詳細、viewMode 付き) は親の実装をそのまま再利用
 *
 * detach はオーバーライド不要: 親の detach() が _fc.destroy() と
 * _fcInitialized のリセットを行い、render() 冒頭の this.detach() で再入時に必ず走る。
 */
const MyRecruitmentPageFullCal = Object.assign(Object.create(MyRecruitmentPage), {

  renderCalendar() {
    const container = document.getElementById("myCalContainer");
    if (!container) return;

    // 横カレンダー関連 UI を非表示 (全て自ページの DOM 内。render() ごとに再構築されるため復元不要)
    const calWrap = container.parentElement; // position:relative の wrapper (フローティング月バッジ・端ボタン含む)
    if (calWrap) calWrap.style.display = "none";
    ["btnMyCalPrev", "myCalMonth", "btnMyCalNext", "btnMyCalToday"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
    const legend = document.getElementById("myCalLegend");
    if (legend && legend.parentElement) legend.parentElement.style.display = "none"; // 横版凡例ブロック

    // FullCalendar 節を常時展開し、折りたたみトグルボタンを隠す
    const fcCollapse = document.getElementById("myRecFullCalendar");
    if (fcCollapse) {
      fcCollapse.classList.add("show");
      const toggleBtn = document.querySelector('button[data-bs-target="#myRecFullCalendar"]');
      if (toggleBtn) toggleBtn.style.display = "none";
      const fcWrap = fcCollapse.parentElement; // .mt-4 ブロック
      if (fcWrap) { fcWrap.classList.remove("mt-4"); fcWrap.classList.add("mt-2"); }
    }

    // キャンセル・保留中トグル (横版 renderCalendar と同一実装。_bound ガードで多重配線防止)
    const togC = document.getElementById("toggleShowCancelled");
    const togP = document.getElementById("toggleShowPending");
    if (togC && !togC._bound) {
      togC.checked = this._showCancelled !== false;
      togC._bound = true;
      togC.addEventListener("change", () => {
        this._showCancelled = togC.checked;
        this._saveSettings();
        this._refilterBookings();
      });
    } else if (togC) {
      togC.checked = this._showCancelled !== false;
    }
    if (togP && !togP._bound) {
      togP.checked = this._showPending !== false;
      togP._bound = true;
      togP.addEventListener("change", () => {
        this._showPending = togP.checked;
        this._saveSettings();
        this._refilterBookings();
      });
    } else if (togP) {
      togP.checked = this._showPending !== false;
    }

    // FullCalendar 初期化 (初回) / イベント更新 (onSnapshot データ変化時)
    if (this._fcInitialized) {
      this._refreshFullCalendar();
    } else {
      this._initFullCalendar();
    }

    // 要対応 / お知らせ描画 (親メソッドを流用)
    if (typeof this.renderToActions_ === "function") this.renderToActions_();
  },
});
