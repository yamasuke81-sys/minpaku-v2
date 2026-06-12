/**
 * 過去日付のまま残った「募集中」の自動クローズ (毎日 JST 08:10)
 *
 * checkoutDate が昨日以前の status="募集中" を status="期限切れ" に更新する。
 * 当日分は清掃当日のため触らない。データは削除せず履歴として残す。
 * (2026-06-13 一括クリーンアップ migration/cleanup-stale-recruitments.js の定常化)
 */
const admin = require("firebase-admin");
const { removeRecruitmentFromAllStaff } = require("../utils/inactiveStaff");

const toDateStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  if (v.toDate) return v.toDate().toISOString().slice(0, 10);
  return "";
};

module.exports = async function expireStaleRecruitments() {
  const db = admin.firestore();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
  console.log(`[expireStaleRecruitments] 起動 本日(JST)=${today}`);

  try {
    const snap = await db.collection("recruitments").where("status", "==", "募集中").get();
    let expired = 0;
    for (const docSnap of snap.docs) {
      const r = docSnap.data();
      const co = toDateStr(r.checkoutDate || r.checkOutDate);
      if (!co || co >= today) continue;
      await docSnap.ref.update({
        status: "期限切れ",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        expiredBy: "expireStaleRecruitments",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await removeRecruitmentFromAllStaff(db, docSnap.id);
      expired++;
      console.log(`[expireStaleRecruitments] 期限切れ化 ${docSnap.id} (${co}, ${r.propertyName || "-"})`);
    }
    console.log(`[expireStaleRecruitments] 完了 expired=${expired} / 募集中=${snap.size}`);
  } catch (e) {
    console.error("[expireStaleRecruitments] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "expireStaleRecruitments",
        error: e.message, stack: (e.stack || "").slice(0, 500),
        severity: "error", createdAt: new Date(),
      });
    } catch (_) { /* ignore */ }
  }
};
