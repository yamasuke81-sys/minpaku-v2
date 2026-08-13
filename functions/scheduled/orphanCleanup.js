// 毎日深夜 2時 (JST) に走らせて孤児データを掃除
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { archiveAndDelete } = require("../utils/recruitmentArchive");

exports.orphanCleanup = onSchedule({
  schedule: "0 2 * * *",  // JST 2:00
  timeZone: "Asia/Tokyo",
  region: "asia-northeast1",
  timeoutSeconds: 540,
  memory: "512MiB",  // OOM対策: 全 shifts/checklists を読むため
}, async (event) => {
  const db = admin.firestore();
  const stats = { orphanChecklists: 0, orphanShifts: 0, orphanRecs: 0, fixedPending: 0, archiveFailed: 0 };

  // 1. 孤児 checklist 削除
  const shSnap = await db.collection("shifts").get();
  const shIds = new Set(shSnap.docs.map(d => d.id));
  const clSnap = await db.collection("checklists").get();
  for (const d of clSnap.docs) {
    const shId = d.data().shiftId;
    if (!shId || !shIds.has(shId)) {
      await d.ref.delete();
      stats.orphanChecklists++;
    }
  }

  // 2. ghost shift (booking 不在 or cancelled) 削除
  const bSnap = await db.collection("bookings").get();
  const bMap = new Map(bSnap.docs.map(d => [d.id, d.data()]));
  const isCancelled = (s) => String(s || "").toLowerCase().includes("cancel");
  for (const d of shSnap.docs) {
    const s = d.data();
    if (!s.bookingId) continue;
    const b = bMap.get(s.bookingId);
    if (!b || isCancelled(b.status)) {
      // 対応 checklist も削除
      const cls = await db.collection("checklists").where("shiftId", "==", d.id).get();
      for (const c of cls.docs) await c.ref.delete();
      // ★スタッフが入っているシフトは退避してから消す。
      //   ここを素の delete にしていると、onBookingChange 側の退避をすり抜けたもの
      //   (および退避失敗で意図的に残したもの) を毎晩2時に無言で失う。
      if (await archiveAndDelete(db, d, "shift", { reason: "orphan_cleanup", bookingId: s.bookingId, propertyId: s.propertyId })) {
        stats.orphanShifts++;
      } else {
        stats.archiveFailed++;
        console.error(`[orphanCleanup] シフト ${d.id} を退避できず削除を見送りました`);
      }
    }
  }

  // 3. ghost recruitment 削除
  const recSnap = await db.collection("recruitments").get();
  for (const d of recSnap.docs) {
    const r = d.data();
    if (!r.bookingId) continue;
    const b = bMap.get(r.bookingId);
    if (!b || isCancelled(b.status)) {
      // ★回答(responses)が入っている募集は退避してから消す (同上)
      if (await archiveAndDelete(db, d, "recruitment", { reason: "orphan_cleanup", bookingId: r.bookingId, propertyId: r.propertyId })) {
        stats.orphanRecs++;
      } else {
        stats.archiveFailed++;
        console.error(`[orphanCleanup] 募集 ${d.id} を退避できず削除を見送りました`);
      }
    }
  }

  // 4. 孤児 pendingRecruitmentIds 除去 + 必要なら再アクティブ化
  const realRecIds = new Set(recSnap.docs.map(d => d.id));
  const staffSnap = await db.collection("staff").get();
  for (const d of staffSnap.docs) {
    const s = d.data();
    const pending = Array.isArray(s.pendingRecruitmentIds) ? s.pendingRecruitmentIds : [];
    const valid = pending.filter(id => realRecIds.has(id));
    if (valid.length === pending.length && s.active !== false) continue;
    const update = {
      pendingRecruitmentIds: valid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (s.active === false && valid.length < 15) {
      update.active = true;
      update.inactiveReason = admin.firestore.FieldValue.delete();
      update.inactivatedAt = admin.firestore.FieldValue.delete();
    }
    await d.ref.update(update);
    stats.fixedPending++;
  }

  console.log(`[orphanCleanup] 完了:`, stats);
});
