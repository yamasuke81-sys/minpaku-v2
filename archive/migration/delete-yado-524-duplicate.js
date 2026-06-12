// YADO KOMACHI 5/24 の重複 (清掃日 5/25 に移動済) recruitment + shift + checklist を削除
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const REC_ID = "FfgB23hq4ayqF3L14KHA";
  const SHIFT_ID = "FFsd6Bcj8ZdSa1Uxq2sf";

  // shift に紐付く checklist を削除
  const cls = await db.collection("checklists").where("shiftId", "==", SHIFT_ID).get();
  for (const c of cls.docs) {
    console.log(`削除: checklists/${c.id}`);
    await c.ref.delete();
  }

  // shift 削除
  console.log(`削除: shifts/${SHIFT_ID}`);
  await db.collection("shifts").doc(SHIFT_ID).delete();

  // recruitment 削除
  console.log(`削除: recruitments/${REC_ID}`);
  await db.collection("recruitments").doc(REC_ID).delete();

  console.log("完了");
  process.exit(0);
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
