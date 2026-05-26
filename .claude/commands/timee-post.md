---
description: 既存予約 ID からタイミー求人を完全無人で投稿する (Dispatch 経由想定)
argument-hint: <bookingId> <group_limited|new_worker_for_client_limited>
allowed-tools: Bash, mcp__Claude_in_Chrome__*
---

# /timee-post

予約 ID とビジビリティを受け取り、タイミー求人作成画面で完全無人投稿する。
Claude Code Remote Control に PC 側で常時起動 + Claude in Chrome 拡張 + Tampermonkey で動かす想定。

## 入力

- 第1引数: `bookingId` — Firestore の bookings コレクションのドキュメント ID
- 第2引数: `visibility` — `group_limited` または `new_worker_for_client_limited`

例: `/timee-post ical_1418fb94e984-...@airbnb.com group_limited`

## 実行手順

### 1. 予約・物件情報を取得

```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
node migration/get-booking-for-timee.js '<bookingId>' '<visibility>'
```

stdout に1行 JSON が出る。`{ok:true, url, propertyName, checkOut, ...}` か `{ok:false, error}`。
`ok:false` なら、ユーザーに `error` を返して終了。

### 2. Claude in Chrome 準備 + URL を開く

- `mcp__Claude_in_Chrome__list_connected_browsers` → `select_browser` で対象 PC の Chrome を選ぶ
- `tabs_context_mcp({createIfEmpty: true})` → 新規タブを確保
- `navigate({url: <手順1のurl>, tabId})` でタイミー画面に遷移
- `wait(8)` でフォーム描画を待つ

### 3. フォーム自動入力

Tampermonkey が走っていれば既に自動入力されているはず。念のため、`javascript_tool` で下記スクリプトを直接実行して再保証する：

```js
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const params = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  function setNative(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  }
  const setById = (id, v) => { const el = document.getElementById(id); if (el) setNative(el, String(v)); };
  // 日付
  if (params.date) {
    const [y, m, d] = params.date.split('-').map(Number);
    const monthSel = document.querySelector('.react-datepicker__month-select');
    const yearSel = document.querySelector('.react-datepicker__year-select');
    if (monthSel && yearSel) {
      const target = y * 12 + (m - 1);
      let safety = 60;
      while (safety-- > 0) {
        const cur = Number(yearSel.value) * 12 + Number(monthSel.value);
        if (cur === target) break;
        const btn = cur < target
          ? document.querySelector('.react-datepicker__navigation--next')
          : document.querySelector('.react-datepicker__navigation--previous');
        if (!btn) break;
        btn.click();
        await sleep(100);
      }
      const dd = String(d).padStart(3, '0');
      for (const c of document.querySelectorAll('.react-datepicker__day--' + dd)) {
        if (c.classList.contains('react-datepicker__day--outside-month')) continue;
        if (c.classList.contains('react-datepicker__day--disabled')) continue;
        c.click();
        break;
      }
    }
  }
  // テキスト系
  if (params.start) setById('workTimeStart', params.start);
  if (params.end) setById('workTimeEnd', params.end);
  if (params.restStart) setById('restTimeStart', params.restStart);
  if (params.restMin != null) setById('restMinutes', params.restMin);
  if (params.workers) setById('matchingLimit', params.workers);
  if (params.wage) setById('hourlyWage', params.wage);
  if (params.transport != null) setById('transportationExpense', params.transport);
  // 公開設定
  if (params.visibility) {
    const r = document.getElementById(params.visibility);
    if (r && !r.checked) r.click();
    if (params.visibility === 'group_limited' && params.groupIds) {
      await sleep(300);
      for (const gid of params.groupIds.split(',').map(s => s.trim()).filter(Boolean)) {
        const cb = document.querySelector(`input[type="checkbox"][value="${gid}"]`);
        if (cb && !cb.checked) cb.click();
      }
    }
  }
  // 自動送信
  if (params.autoMsg) {
    const r = document.querySelector(`input[type="radio"][name="matchingAutoChatMessage.enabled"][value="${params.autoMsg}"]`);
    if (r && !r.checked) r.click();
  }
  if (params.autoMsgTarget) {
    const r = document.querySelector(`input[type="radio"][name="matchingAutoChatMessage.targetWorker"][value="${params.autoMsgTarget}"]`);
    if (r && !r.checked) r.click();
  }
  return 'autofilled';
})()
```

### 4. 「入力した求人内容を確認」ボタンをクリック

`javascript_tool`:
```js
(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('入力した求人内容を確認'));
  if (!b) return 'btn-not-found';
  b.click();
  return 'clicked';
})()
```

`wait(4)` で validate API 応答を待つ。

### 5. エラー判定

```js
(() => {
  const errs = Array.from(document.querySelectorAll('[role="alert"], .Toaster')).map(e => (e.textContent||'').trim()).filter(Boolean);
  return JSON.stringify({ url: location.pathname, errs });
})()
```

- `errs` が空でなく、「保存できませんでした」「すでに同一の」等が含まれていれば **失敗** → step 7 へ
- `errs` が空 で URL が `/offerings/new` 以外に遷移していれば確認画面 → step 6 へ
- URL が `/offerings/new` のまま + `errs` 空なら、まだ画面遷移中の可能性。`wait(3)` で再判定

### 6. 確認画面で最終ボタンクリック

確認画面に「求人を作成」「投稿する」「この内容で求人を作成する」等の文言ボタンがあるはず。下記で探してクリック：

```js
(() => {
  const cand = Array.from(document.querySelectorAll('button'))
    .filter(b => /求人を作成|投稿する|この内容で|確定|作成する/.test(b.textContent||''));
  if (cand.length === 0) return 'final-btn-not-found';
  // 一番下にあるものを優先 (通常最終投稿ボタンは下部に固定)
  cand.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  cand[0].click();
  return 'clicked: ' + (cand[0].textContent || '').trim().slice(0, 30);
})()
```

`wait(6)` で create API 応答を待つ。

### 7. 結果判定 + LINE 通知

成功判定: `location.pathname` が `/offerings` などのリスト画面 or 成功モーダルが出現。
失敗判定: 上記以外、または step 5 でエラー検出。

LINE 通知用ヘルパー:
```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
node -e "
const admin = require('firebase-admin');
admin.initializeApp({projectId: 'minpaku-v2'});
const { notifyByKey } = require('./utils/lineNotify');
(async () => {
  await notifyByKey(admin.firestore(), 'timee_posting', {
    title: 'タイミー自動投稿 結果',
    body: '<成功 or 失敗の本文>',
    vars: {},
    propertyId: null,
  });
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
"
```

## 安全策

- 1 回の呼び出しで複数物件・複数日に投稿しない (引数で明示された 1 件のみ)
- ステップ 6 のボタン文言が完全一致しない場合は誤クリック避けて停止 → LINE で「最終ボタン特定できず」報告
- ステップ 5 で「重複あり」エラー検知時はそこで終了 (重複投稿しない)
- やますけが Dispatch 経由でこのコマンドを発行する想定。自動発火はしない (ユーザー判断後の最終トリガー)
