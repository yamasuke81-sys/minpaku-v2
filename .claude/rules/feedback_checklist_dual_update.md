---
name: チェックリスト画面の改善は両方に反映
description: minpaku-v2 でチェックリスト関連 UI の改善を行う時は、スタッフ用 (my-checklist.js)・物件管理用 (property-checklist.js)・公開ヘルパー用 (guest-checklist.html) の**3面すべて**に同じ変更を入れる。片方だけで終わらせない。
type: feedback
originSessionId: e43653b9-a405-4974-b12b-371226fe20dd
---
minpaku-v2 のチェックリスト画面は **3 つ**ある:

- **スタッフ用チェック実施画面**: `public/js/pages/my-checklist.js`（ルート `#/my-checklist/:shiftId`、ログイン要）
- **物件マスタ編集画面**: `public/js/pages/property-checklist.js`（ルート `#/property-checklist/:propertyId`）
- **公開ヘルパー画面**: `public/guest-checklist.html`（認証不要・QR/トークン、タイミー等の臨時スタッフ向け。standalone HTML で inline script。helper-checklist API 使用）

3 面とも「部屋名タブ + アコーディオン構造」で、ほぼ同じ UI。オーナーは複数を頻繁に使うため、**1面だけ改善すると不整合に気付いて指摘が来る**。実例: 2026-06-07、大カテゴリ/中カテゴリのメモ(黄色カード `gc-memo`/`alert-warning`)が my-checklist.js には実装済みだったが guest-checklist.html では項目メモのみ描画で大/中カテゴリメモが抜けていた。

**Why:** やますけが 2026-04-17 に「物件タブ内のチェックリストにも反映させて。**これ毎回忘れないで**」と明示的に指示。過去にも「物件側も揃えて」「食い違いを洗い出して」というフィードバックあり。

**How to apply:** タブ見た目、スクロール挙動、全展開/折りたたみ、タブクリック時の動作、タブ上部固定などの UI 改善を実装する時は、**両方のファイルに同じ仕様を入れる**。物件側は「マスタ編集」なので以下は**意図的に非搭載**だが、それ以外は揃える:

**property-checklist に入れないもの（マスタ側なので不要）:**
- 全チェック/全チェック外しボタン
- 完了マーク（done/total バッジの代わりに項目数のみ表示）
- ランドリー・清掃完了ブロック

**両方に入れるもの:**
- タブ上部固定（常時 fixed 方式）
- タブクリック時にタブを左端へ scrollTo
- タブ見た目（非active は灰色背景+枠、active は Bootstrap 青ピル）
- 全展開/全折りたたみボタン
- タブクリック時に body 全体を再構築せず差分更新（横スクロール位置維持）

実装時のチェックリスト: スタッフ側を変えたら **必ず property-checklist.js も開いて同じ変更を入れる**。
