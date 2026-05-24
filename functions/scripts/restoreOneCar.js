// Siu Yi Man の parkingAllocation を元の1台に戻す (swapToTwoCars.js の対)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const TOKEN = "73841fed5bab6a02288db06166daa1e7429836115b4c5b269c0108acd463314a";

  const snap = await db.collection("guestRegistrations")
    .where("editToken", "==", TOKEN)
    .limit(1).get();
  if (snap.empty) {
    console.log("対象ゲスト見つからず");
    return;
  }
  const doc = snap.docs[0];
  const g = doc.data();

  if (!g._parkingAllocationBackup) {
    console.log("バックアップが見つかりません。手動で確認が必要です。");
    console.log("現在の parkingAllocation:", JSON.stringify(g.parkingAllocation, null, 2));
    return;
  }

  console.log("【バックアップから復元】");
  console.log(JSON.stringify(g._parkingAllocationBackup, null, 2));

  await doc.ref.update({
    parkingAllocation: g._parkingAllocationBackup,
    _parkingAllocationBackup: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`\n✓ ${doc.id} を元の状態に復元しました`);
})().catch(e => { console.error(e); process.exit(1); });
