// propertyId=null の unmatched emailVerifications を全 active 物件 bookings に対して再突合
// (共用 Gmail 受信で物件特定できなかったメール)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { findBookingMatch, decideBookingUpdate } = require("../utils/emailMatcher");

(async () => {
  // 1. active 物件の bookings を全件取得
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  const propIds = propsSnap.docs.map(d => d.id);
  let bookingsArr = [];
  for (let i = 0; i < propIds.length; i += 30) {
    const chunk = propIds.slice(i, i + 30);
    const bs = await db.collection("bookings").where("propertyId", "in", chunk).get();
    bookingsArr.push(...bs.docs.map(d => ({ id: d.id, data: d.data() })));
  }
  console.log(`bookings 候補: ${bookingsArr.length}件 (active 物件 ${propIds.length}件)`);

  // 2. propertyId=null かつ matchStatus=unmatched (or status=null) を取得
  const evSnap = await db.collection("emailVerifications")
    .where("propertyId", "==", null)
    .limit(200)
    .get();
  console.log(`emailVerifications (propertyId=null): ${evSnap.size}件`);
  let matched = 0, skipped = 0, errors = 0;
  for (const ed of evSnap.docs) {
    const ev = ed.data();
    if (ev.matchedBookingId) { skipped++; continue; }
    const ext = ev.extractedInfo;
    if (!ext) { skipped++; continue; }
    try {
      const m = findBookingMatch(bookingsArr, ext, null);
      if (!m || !m.id) { continue; }
      // booking 更新
      const recvMs = ev.receivedAt?.toMillis?.() || null;
      const decision = decideBookingUpdate(m.data, ext, ev.messageId || ed.id, recvMs, ev.threadId || null, ev.subject || null);
      if (!decision || !decision.updates) { skipped++; continue; }
      const patch = {};
      for (const k of Object.keys(decision.updates)) {
        const v = decision.updates[k];
        if (v && typeof v === "object" && v.__placeholder === "serverTimestamp") {
          patch[k] = admin.firestore.FieldValue.serverTimestamp();
        } else if (v && typeof v === "object" && v.__placeholder === "timestampFromMs") {
          patch[k] = admin.firestore.Timestamp.fromMillis(v.ms);
        } else if (v !== undefined) {
          patch[k] = v;
        }
      }
      patch.emailMatchedBy = "auto-rematch";
      await db.collection("bookings").doc(m.id).update(patch);
      await ed.ref.update({
        matchStatus: "matched",
        matchedBookingId: m.id,
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
        matchReason: m.matchReason || "rematch",
      });
      console.log(`[matched] ev=${ed.id} → booking=${m.id} (${m.matchReason}) subject="${ev.subject?.slice(0, 80)}"`);
      matched++;
    } catch (e) {
      console.error(`[ERROR] ev=${ed.id}: ${e.message}`);
      errors++;
    }
  }
  console.log(`\n=== 結果: matched=${matched} skipped=${skipped} errors=${errors} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
