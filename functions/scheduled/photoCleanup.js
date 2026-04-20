/**
 * チェックリスト写真 30日超過自動削除
 * 毎日 JST 3:00 に実行
 * checklists コレクションの beforePhotos / afterPhotos を走査し、
 * uploadedAt から 30日以上経過した写真を Storage + Firestore から削除する
 */
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getStorage } = require("firebase-admin/storage");

/**
 * Firebase Storage の公開 URL / 署名付き URL からバケット内のパスを抽出する
 * 対応形式:
 *   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encoded_path}?...
 *   https://storage.googleapis.com/{bucket}/{path}
 */
function extractStoragePath(url) {
  if (!url) return null;
  try {
    // 形式1: firebasestorage.googleapis.com/v0/b/{bucket}/o/{encoded}
    const m1 = url.match(/\/o\/([^?#]+)/);
    if (m1) return decodeURIComponent(m1[1]);
    // 形式2: storage.googleapis.com/{bucket}/{path}
    const m2 = url.match(/storage\.googleapis\.com\/[^/]+\/(.+)/);
    if (m2) return decodeURIComponent(m2[1]);
  } catch (_) {}
  return null;
}

exports.photoCleanup = onSchedule({
  schedule: "0 3 * * *",
  timeZone: "Asia/Tokyo",
  region: "asia-northeast1",
  timeoutSeconds: 540,
}, async (_event) => {
  const db = admin.firestore();
  const bucket = getStorage().bucket();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  let total = 0;

  const snap = await db.collection("checklists").get();

  for (const d of snap.docs) {
    const c = d.data();
    const before = Array.isArray(c.beforePhotos) ? c.beforePhotos : [];
    const after = Array.isArray(c.afterPhotos) ? c.afterPhotos : [];

    const keepBefore = [];
    const keepAfter = [];

    for (const p of before) {
      const at = p.uploadedAt?.toDate
        ? p.uploadedAt.toDate().getTime()
        : (p.uploadedAt ? new Date(p.uploadedAt).getTime() : 0);
      if (at >= cutoff) {
        keepBefore.push(p);
        continue;
      }
      try {
        const path = extractStoragePath(p.url);
        if (path) await bucket.file(path).delete({ ignoreNotFound: true });
        total++;
      } catch (e) {
        console.warn(`[photoCleanup] before 削除失敗: ${e.message}`);
      }
    }

    for (const p of after) {
      const at = p.uploadedAt?.toDate
        ? p.uploadedAt.toDate().getTime()
        : (p.uploadedAt ? new Date(p.uploadedAt).getTime() : 0);
      if (at >= cutoff) {
        keepAfter.push(p);
        continue;
      }
      try {
        const path = extractStoragePath(p.url);
        if (path) await bucket.file(path).delete({ ignoreNotFound: true });
        total++;
      } catch (e) {
        console.warn(`[photoCleanup] after 削除失敗: ${e.message}`);
      }
    }

    // 削除対象があった場合のみ Firestore 更新
    if (keepBefore.length !== before.length || keepAfter.length !== after.length) {
      try {
        await d.ref.update({
          beforePhotos: keepBefore,
          afterPhotos: keepAfter,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn(`[photoCleanup] Firestore 更新失敗 (${d.id}): ${e.message}`);
      }
    }
  }

  console.log(`[photoCleanup] 完了: ${total} 枚の写真を削除しました`);
});
