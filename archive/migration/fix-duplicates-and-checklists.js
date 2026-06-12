/**
 * 重複シフト削除 + checklist 手動生成
 * - 同日×同物件のシフトが複数ある場合、最古1件残して削除
 * - 各シフトに対応する checklist が無ければ作成
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const DRY = process.argv.includes("--dry-run");

(async () => {
  const [shifts, templates, checklists] = await Promise.all([
    db.collection("shifts").get(),
    db.collection("checklistTemplates").get(),
    db.collection("checklists").get(),
  ]);

  // 同日×同物件の shifts を集約
  const groups = {};
  shifts.docs.forEach(d => {
    const x = d.data();
    const dt = x.date?.toDate ? x.date.toDate().toISOString().slice(0,10) : String(x.date);
    const k = `${dt}__${x.propertyId}`;
    (groups[k] = groups[k] || []).push({ ref: d.ref, id: d.id, data: x });
  });

  // 重複削除
  let dupDel = 0;
  const toKeep = [];
  for (const [k, arr] of Object.entries(groups)) {
    arr.sort((a, b) => {
      const ta = a.data.createdAt?.toMillis?.() || 0;
      const tb = b.data.createdAt?.toMillis?.() || 0;
      return ta - tb;
    });
    toKeep.push(arr[0]);
    for (let i = 1; i < arr.length; i++) {
      console.log(`重複削除 ${k}: ${arr[i].id} ${DRY ? "(DRY)" : ""}`);
      if (!DRY) await arr[i].ref.delete();
      dupDel++;
    }
  }

  // テンプレートマップ
  const tmplMap = {};
  templates.docs.forEach(d => { tmplMap[d.id] = d.data(); });

  // 既存 checklist を shiftId で map
  const clBy = {};
  checklists.docs.forEach(d => { const x = d.data(); if (x.shiftId) clBy[x.shiftId] = d.id; });

  // 各 shift に対応する checklist が無ければ作成
  let clCreated = 0, clSkipped = 0;
  for (const s of toKeep) {
    if (clBy[s.id]) { clSkipped++; continue; }
    const tmpl = tmplMap[s.data.propertyId];
    if (!tmpl) {
      console.log(`  テンプレート未設定 propertyId=${s.data.propertyId}, checklist作成スキップ`);
      continue;
    }
    console.log(`  checklist作成 shift=${s.id} ${DRY ? "(DRY)" : ""}`);
    if (!DRY) {
      await db.collection("checklists").add({
        shiftId: s.id,
        propertyId: s.data.propertyId,
        propertyName: s.data.propertyName || "",
        checkoutDate: s.data.date,
        staffIds: s.data.staffIds || (s.data.staffId ? [s.data.staffId] : []),
        templateVersion: tmpl.version || 1,
        templateSnapshot: tmpl.areas || [],
        itemStates: {},
        beforePhotos: [],
        afterPhotos: [],
        laundry: { putOut: null, collected: null, stored: null },
        status: "in_progress",
        completedAt: null,
        completedBy: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    clCreated++;
  }

  console.log("\n=== 完了 ===");
  console.log(`重複削除: ${dupDel}件`);
  console.log(`checklist 作成: ${clCreated}件 / スキップ(既存): ${clSkipped}件`);
  console.log(`残 shifts: ${toKeep.length}件`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
