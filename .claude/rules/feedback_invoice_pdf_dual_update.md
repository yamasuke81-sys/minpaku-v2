請求書 PDF の中身を変えるときは、`functions/api/invoices.js` の **2 つの描画関数を必ず両方**直す。

- `renderInvoicePdfBuffer()` … PDF プレビュー用 (Storage に保存せず Buffer を返す)。`POST /invoices/my-preview-pdf` から呼ばれる
- `generateInvoicePdf_()` … 本番の PDF 生成 (tmp 書込 → Storage → Drive 保存)。`my-submit` / `PUT /invoices/:id` / 月次バッチから呼ばれる

この 2 つは「共有するつもりだったが実際にはコピペで二重化されている」状態で、明細テーブル・メモ・支払期限・振込先・備考の描画が丸ごと重複している。**片方だけ直すと「プレビューでは出るのに送信した PDF には出ない」(逆も)** という、気づきにくい不整合になる。

**Why:** 2026-07-29 に手入力明細のレシート写真添付を実装した際、添付レシートページを両方に足す必要があった。関数の docstring には「描画ロジックを共有する」と書いてあるが実態は別実装なので、コメントを信じると片側を落とす。

**How to apply:**
- PDF に要素を足す/変える差分は、必ず両関数に同じものを入れる。差分を書いたら `grep -n "備考" functions/api/invoices.js` などで 2 箇所ヒットするか確認する。
- **非同期で取ってくるデータ (Storage の画像など) は、描画を始める前にバッファを揃えておく。** pdfkit の描画は同期処理で、`new Promise((resolve) => { ...描画... })` の中では await できない。両関数とも Promise の**手前**で fetch する構造にしてある (`fetchManualPhotoBuffers_`)。
- 除外行 (`excludedRows`) を考慮する必要がある要素は、`applyExclusionsToDetails_()` を通した後の配列を使う。`generateInvoicePdf_` 側は Promise 内で除外を適用しているので、事前 fetch では自分で同じ関数を呼ぶ必要がある。

関連: [[feedback_checklist_dual_update]] (同じ「複数面を揃え忘れる」系の事故)
