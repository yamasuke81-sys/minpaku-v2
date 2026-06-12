// double_booking 通知を一時的に無効化 (LINE 枯渇 + カスケードエラーログ抑止)
// バックアップを settings/notifications_backup_double_booking_20260419 に保存
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const ref = db.collection("settings").doc("notifications");
  const doc = await ref.get();
  if (!doc.exists) { console.error("settings/notifications 未存在"); process.exit(1); }
  const s = doc.data();
  const before = s.channels?.double_booking;
  console.log("変更前 channels.double_booking:", JSON.stringify(before || {}));

  // バックアップ
  await db.collection("settings").doc("notifications_backup_double_booking_20260419").set({
    channels: { double_booking: before || {} },
    note: "2026-04-19 E2E で LINE 枯渇後、カスケード時の 429 ログ抑止のため一時無効化 (復元用)",
    savedAt: new Date(),
  });

  // 無効化
  await ref.set({
    channels: { double_booking: { ...before, enabled: false } },
  }, { merge: true });

  const after = (await ref.get()).data().channels.double_booking;
  console.log("変更後 channels.double_booking:", JSON.stringify(after));
  console.log("→ バックアップ: settings/notifications_backup_double_booking_20260419");
  console.log("→ 復元手順: enabled: true に戻すだけ");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
