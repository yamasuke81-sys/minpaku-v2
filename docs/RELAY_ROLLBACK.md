# v2-5-relay 緊急回避からの復旧手順

## 状況
2026-05-29 Google Cloud Trust & Safety による suspension で `minpaku-v2.web.app` 配信不可となり、
緊急回避として `v2-5-relay.web.app` を立てて URL を切替。

## 自動復旧 (watchHostingRecovery が走る)
- 毎時 :30 に `https://minpaku-v2.web.app/` を ping
- HTTP 200 + Site Not Found 不在で「復活」と判定
- 自動で実行されること:
  1. `settings/notifications.appUrl` を `https://minpaku-v2.web.app` に書き換え
  2. LINE / Discord に「✅ minpaku-v2.web.app 復活検知」通知 (1回のみ)
  3. `settings/hostingWatch.recovered = true` フラグ ON

## 手動ロールバック (復活通知が届いたら)

### Step 1: コードを revert
```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2

# emergency relay 一括置換コミットのみ revert
# (それ以後の通常修正コミットは維持される — revert は対象 commit の差分だけを打ち消す動作)
git revert 2f4e067    # emergency relay: 全 hardcoded URL を v2-5-relay.web.app に一括置換
git push              # main push → GitHub Actions が minpaku-v2 hosting に自動デプロイ
```

**revert 対象でないコミット (これらは残す):**
- `36bae83` feat(relay): v2-5-relay 緊急回避サイト 設定追加 (api-relay.js, firebase.relay.json)
  - 本番では no-op なので残しても害なし、緊急時の予備として温存
- `49ad92a` fix(recruitment): タイミー実名 手動編集保持 (URL とは無関係の機能改善)
- それ以後の通常修正コミット全般 (URL に触れていない変更は全て維持される)

### Step 2: 関連 commit も revert (必要に応じて)
- `feat(relay): v2-5-relay 緊急回避サイト 設定追加` — api-relay.js, firebase.relay.json
  - これは残しておいても本番では no-op なので revert は任意
- `feat(hosting): 古い versions 自動削除 + ...` — cleanupHostingVersions, watchHostingRecovery
  - watchHostingRecovery は不要になったら index.js から削除して別途 commit
  - cleanupHostingVersions は再発防止のため残す

### Step 3: 再デプロイ
```bash
firebase deploy --only functions,hosting --project minpaku-v2
```

### Step 4: settings 整理
```bash
cd functions
node -e "
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'minpaku-v2' });
const db = admin.firestore();
(async () => {
  await db.collection('settings').doc('notifications').update({
    appUrl: admin.firestore.FieldValue.delete(),
    appUrlOriginal: admin.firestore.FieldValue.delete(),
    appUrlSwitchedAt: admin.firestore.FieldValue.delete(),
    appUrlSwitchReason: admin.firestore.FieldValue.delete(),
    appUrlRestoredAt: admin.firestore.FieldValue.delete(),
  });
  console.log('appUrl 関連設定をクリア完了');
  process.exit(0);
})();
"
```

### Step 5: スタッフ / ゲスト周知
- LINE グループに「アプリ復旧、元 URL に戻りました」案内
- 既存ブックマークを `https://minpaku-v2.web.app/` に戻すよう依頼
- ゲストへの追送は不要 (v2-5-relay でも継続アクセス可能、グレースフル)

### Step 6: タイミー Tampermonkey userscript
- 再インストールが必要 (@updateURL も書き換わっているため自動更新されない)
- 開発者画面 → 再ダウンロード → 古い版を削除

### Step 7 (任意): v2-5-relay プロジェクト整理
- 当面残しておいて緊急時の予備として活用も可
- 完全クリーンアップする場合: Firebase Console → v2-5-relay → プロジェクト設定 → プロジェクトの削除

## 関連ファイル
- `firebase.relay.json` — relay 専用 hosting config
- `public/js/api-relay.js` — fetch 経由 /api/** → Cloud Run 直 URL リダイレクト
- `functions/scheduled/watchHostingRecovery.js` — 復活検知
- `functions/scheduled/cleanupHostingVersions.js` — 古い versions 自動削除 (再発防止)

## 参考
- Appeal Ticket: `46O7YFU64HSSUQYR76MGA2XTBY`
- Appeal 受領日時: 2026-05-29 18:53 JST
- 想定回答期日: 2026-06-02 (火) まで
