# v2 サブオーナー機能 実装方針 (2026-04-18 決定)

## 前提 (ユーザー確認済み)
- **v3 のマルチオーナー案 (ownerId 全面導入) は保留** — 単体オーナー前提の v2 のまま
- **v2 にサブオーナー機能を実装** — staff 扱いで isSubOwner + ownedPropertyIds
- 想定サブオーナー数: **2人**
- スタッフは各オーナーに別々の staffId を持つ前提OK (同一LINE UID 紐付け) — これは v3 Phase 3 の話なので v2 実装では未使用
- **impersonation 機能は必要** — やますけ(メインオーナー)が他サブオーナーのデータを代行アクセス

## v2 サブオーナー実装ルール (前エージェント設計準拠)
1. staff コレクションに `isSubOwner: boolean`, `ownedPropertyIds: string[]` 追加
2. カスタムクレーム `role: "sub_owner"` 追加 (owner / sub_owner / staff の3値)
3. Firestore Rules: `isMyProperty(pid)` で所有物件チェック
4. サブオーナー専用ページ or 既存ページを物件フィルタ適用
5. サブオーナー個別通知先 (LINE/Discord/メール) を staff ドキュメントに持つ
6. staff 管理モーダルで CRUD
7. impersonation: メインオーナーが「代理ログイン」的にサブオーナー視点でアプリを閲覧できる仕組み

## 保留中
- v3 マルチオーナー化は、サブオーナー2人で需要が大きくなったら再検討

## 関連ファイル
- エージェント設計: /Users/yamas/AppData/Local/Temp/claude/... (サブオーナー Phase 1)
- エージェント設計 (v3 マルチオーナー): /Users/yamas/AppData/Local/Temp/claude/... (Phase 1-3)
