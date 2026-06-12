#!/usr/bin/env node
// 直近の宿泊者名簿の editToken / editTokenExpiresAt / status を一覧
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const props = await db.collection("properties").where("name", "in", ["the Terrace 長浜", "YADO KOMACHI Hiroshima"]).get();
  for (const p of props.docs) {
    console.log(`\n===== ${p.data().name} (${p.id}) =====`);
    const snap = await db.collection("guestRegistrations").where("propertyId", "==", p.id).get();
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const am = a.createdAt?.toMillis?.() || 0;
        const bm = b.createdAt?.toMillis?.() || 0;
        return bm - am;
      })
      .slice(0, 5);
    for (const g of arr) {
      const exp = g.editTokenExpiresAt;
      const expStr = exp?.toDate?.() ? exp.toDate().toLocaleString("ja-JP") : (exp ? String(exp) : "(none)");
      const expired = exp?.toMillis?.() ? exp.toMillis() < Date.now() : false;
      console.log(`  ${g.id}`);
      console.log(`    guestName=${g.guestName} CI=${g.checkIn} status=${g.status} source=${g.source}`);
      console.log(`    nationality=${g.nationality} 国籍=${g.nationality}`);
      console.log(`    passportPhoto=${g.passportPhoto ? "あり" : "なし"} email=${g.email}`);
      console.log(`    editToken=${g.editToken ? `${g.editToken.slice(0, 8)}... (${g.editToken.length}文字)` : "(なし)"}`);
      console.log(`    editTokenExpiresAt=${expStr} ${expired ? "⚠️ 期限切れ" : ""}`);
      console.log(`    createdAt=${g.createdAt?.toDate?.()?.toLocaleString("ja-JP")} updatedAt=${g.updatedAt?.toDate?.()?.toLocaleString("ja-JP")}`);
    }
  }
})();
