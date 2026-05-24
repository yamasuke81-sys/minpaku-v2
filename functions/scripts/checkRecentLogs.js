// 直近の onRecruitmentChange / lineNotify 系のエラーログを Cloud Logging から取得
// (ローカル実行不可、Firebase Console で確認するための案内のみ出す)
console.log("=== Cloud Functions ログ確認方法 ===");
console.log("");
console.log("1. Firebase Console を開く:");
console.log("   https://console.firebase.google.com/project/minpaku-v2/functions/logs");
console.log("");
console.log("2. フィルタを入力:");
console.log("   resource.type=\"cloud_run_revision\"");
console.log("   severity>=WARNING");
console.log("   timestamp>=\"" + new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() + "\"");
console.log("");
console.log("3. 探す文字列:");
console.log("   - [ownerLine]");
console.log("   - [groupLine]");
console.log("   - [notifyStaff]");
console.log("   - LINE API エラー");
console.log("   - 429 / 400 / 401");
console.log("");
console.log("4. または gcloud CLI:");
console.log("   gcloud logging read 'resource.type=\"cloud_run_revision\" AND severity>=WARNING' --project=minpaku-v2 --limit=50");
