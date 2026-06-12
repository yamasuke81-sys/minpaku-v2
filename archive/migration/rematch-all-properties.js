// 全 active 物件について unmatched emailVerifications を再評価
// (5/15 の ownerId 修正前は matcher が空で動いていたため過去メールが未マッチのまま残っている)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { reevaluateUnmatched } = require("../utils/reevaluateUnmatched");

(async () => {
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  console.log(`active 物件: ${propsSnap.size}件`);
  let totalRematched = 0;
  let totalScanned = 0;
  for (const pd of propsSnap.docs) {
    const name = pd.data().name || pd.id;
    try {
      const r = await reevaluateUnmatched(db, { propertyId: pd.id });
      console.log(`[${name}] scanned=${r.scanned} rematched=${r.rematched} errors=${r.errors.length}`);
      if (r.errors.length) console.log(`  errors: ${r.errors.slice(0, 3).join(" | ")}`);
      totalRematched += r.rematched;
      totalScanned += r.scanned;
    } catch (e) {
      console.error(`[${name}] FAILED: ${e.message}`);
    }
  }
  console.log(`\n=== 合計 scanned=${totalScanned} rematched=${totalRematched} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
