// Siu Yi Man (editToken=73841fed...) の parkingAllocation を一時的に 2台 に変更
// 動作確認後 restoreOneCar.js で元に戻す
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

  const original = g.parkingAllocation || [];
  console.log("【現在 (バックアップ用) parkingAllocation】");
  console.log(JSON.stringify(original, null, 2));

  // 2台版: 元の1台 + 軽自動車を spot1 に追加
  const twoCars = [
    ...original,
    { index: 2, vehicleType: "軽自動車", spot: "spot1" }
  ];
  console.log("\n【書き換え後 parkingAllocation】");
  console.log(JSON.stringify(twoCars, null, 2));

  await doc.ref.update({
    parkingAllocation: twoCars,
    _parkingAllocationBackup: original, // restoreOneCar.js で復元するために保存
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`\n✓ ${doc.id} を 2台に変更しました`);
  console.log(`\n確認 URL:`);
  console.log(`https://minpaku-v2.web.app/guides/the-terrace-nagahama.html?guest=${TOKEN}`);
  console.log(`\n動作確認後、必ず以下を実行して元に戻してください:`);
  console.log(`  node functions/scripts/restoreOneCar.js`);
})().catch(e => { console.error(e); process.exit(1); });
