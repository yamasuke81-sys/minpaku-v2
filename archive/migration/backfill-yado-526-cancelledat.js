#!/usr/bin/env node
// YADO 5/26 booking の cancelledAt + cancelReason をバックフィル
// emailMatcher が cancelledAt をセットしないバグで undefined になっていたため
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const docId = "ical_1418fb94e984-9ace522714195c3b7bb1b642b639831a@airbnb.com";
  const ref = db.collection("bookings").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) { console.error("doc not found"); process.exit(1); }
  const b = snap.data();
  console.log(`status=${b.status} cancelSource=${b.cancelSource} cancelledAt=${b.cancelledAt} emailVerifiedAt=${b.emailVerifiedAt?.toDate?.()}`);
  if (b.cancelledAt) { console.log("cancelledAt 既に設定済み"); return; }
  if (!b.emailVerifiedAt) { console.error("emailVerifiedAt なし"); return; }

  console.log(`バックフィル: cancelledAt = emailVerifiedAt (${b.emailVerifiedAt.toDate()}) ${DRY_RUN ? "(DRY_RUN)" : ""}`);
  if (!DRY_RUN) {
    await ref.update({
      cancelledAt: b.emailVerifiedAt,
      cancelReason: "メール照合: キャンセル通知メール検知",
    });
    console.log("更新完了");
  }
})().catch(e => { console.error(e); process.exit(1); });
