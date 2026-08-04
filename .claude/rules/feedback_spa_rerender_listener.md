SPA のページは**ルート遷移のたびに `render(container)` が `container.innerHTML` を丸ごと置き換える**（app.js:686）。そのため、ページオブジェクトのプロパティで「1度だけ初期化」をガードすると、**2回目以降の描画では新しいDOM要素にリスナーが付かず、押しても何も起きない UI** が出来上がる。エラーも出ないので気付けない。

**Why:** 2026-07-29 に請求書の手入力明細へレシート写真添付を実装したが、`_initPhotoModal()` が `if (this._photoModalReady) return;` でガードしていた。写真選択モーダルの `<input type="file">` は render のテンプレート内にあるため毎回作り直され、一度でも別画面へ移動して戻ると change リスナーが消えた。結果「添付ボタン→写真選択→無反応」。スタッフは添付できないと思って同じレシートを4回撮り直し、最後は写真なしで送信していた（2026-08-04 に本番 Storage の実ファイルで確認）。

**How to apply:**
- 「1度だけ」のガードは**要素自身に持たせる**。ページのフラグにしない。
  ```js
  const inp = document.getElementById("photoInputCamera");
  if (!inp || inp.dataset.bound === "1") return;
  inp.dataset.bound = "1";
  inp.addEventListener("change", ...);
  ```
- render の最後で、モーダル等「テンプレート内にあるが後から使う要素」のバインドを必ず呼び直す。
- `document.body` や `document` に付けるリスナーは逆に**毎回増える**（重複登録）。ページ内要素へのバインドと混同しない。

**あわせて: ユーザーの入力を DOM 上だけに置かない。**
同じ実装で、添付済み写真を行の DOM プロパティ (`tr._photos`) にだけ保持していたため、画面を離れると入力ごと消える一方、Storage にはアップロード済みの実体が残った（＝「アップロードしたのに請求書に載らない」孤児ファイル）。アップロード済みファイルを含む入力は localStorage へ自動保存し、戻ったときに復元する（`_saveLocalDraft` / `_restoreLocalDraft`、キーは `invDraft:{staffId}:{ym}:{propertyId}:{editingId|new}`、30日で失効）。

関連: [[feedback_checklist_dual_update]] [[feedback_minpaku_v2_asset_version_bump]]
