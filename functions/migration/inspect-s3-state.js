// S3 (スタッフ回答) 検証: responses の有無, 通知設定, スタッフの LINE 紐付け状況
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);

  // 1. recruitments の responses を確認
  console.log("=== recruitments.responses (the Terrace 長浜) ===");
  const recSnap = await db.collection("recruitments").where("propertyId", "==", pid).get();
  console.log(`total: ${recSnap.size}`);
  let withResponses = 0;
  recSnap.docs.forEach(d => {
    const x = d.data();
    const responses = x.responses || [];
    if (responses.length > 0) {
      withResponses++;
      console.log(`  ${d.id} co=${x.checkoutDate} status=${x.status} responses=${responses.length}`);
      responses.forEach(r => {
        console.log(`    ${r.staffId} ${r.staffName} : ${r.response} @ ${toDate(r.respondedAt)?.toISOString()}`);
      });
    }
  });
  console.log(`  responses付き: ${withResponses}/${recSnap.size}件\n`);

  // 2. responses サブコレクション版も確認 (古い仕様の可能性)
  console.log("=== recruitments/*/responses サブコレクション ===");
  let subCount = 0;
  for (const d of recSnap.docs) {
    const subSnap = await d.ref.collection("responses").get();
    if (subSnap.size > 0) {
      subCount += subSnap.size;
      console.log(`  ${d.id}: ${subSnap.size}件のサブドキュメント`);
      subSnap.docs.slice(0, 3).forEach(sd => {
        const s = sd.data();
        console.log(`    ${sd.id}: ${s.staffId} ${s.staffName} : ${s.response}`);
      });
    }
  }
  console.log(`  サブコレクションtotal: ${subCount}\n`);

  // 3. 通知設定 (recruit_response, recruit_start)
  console.log("=== settings/notifications ===");
  const notif = await db.collection("settings").doc("notifications").get();
  if (notif.exists) {
    const n = notif.data();
    console.log(`  ownerLineChannels: ${JSON.stringify(n.ownerLineChannels || [])}`);
    console.log(`  lineChannelStrategy: ${n.lineChannelStrategy}`);
    console.log(`  appUrl: ${n.appUrl}`);
    console.log(`  alertChannels: ${JSON.stringify(n.alertChannels||[])}`);
    const events = n.events || {};
    ["recruit_start", "recruit_response", "staff_confirm", "checklist_complete", "invoice_submitted"].forEach(k => {
      const e = events[k];
      if (e) {
        console.log(`  events.${k}:`);
        console.log(`    enabled: ${e.enabled}`);
        console.log(`    ownerLine: ${e.ownerLine}, groupLine: ${e.groupLine}, staffLine: ${e.staffLine}, email: ${e.email}`);
      } else {
        console.log(`  events.${k}: 未定義`);
      }
    });
  } else {
    console.log("  (未設定)");
  }

  // 4. スタッフの LINE 紐付け (lineUserId)
  console.log("\n=== staff: LINE 紐付け (active) ===");
  const staffSnap = await db.collection("staff").where("active", "==", true).get();
  staffSnap.docs.forEach(d => {
    const x = d.data();
    console.log(`  ${d.id} ${x.name}  email=${x.email || "(未設定)"}  lineUserId=${x.lineUserId ? "✅" : "❌ 未紐付け"}  isOwner=${x.isOwner || false}`);
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
