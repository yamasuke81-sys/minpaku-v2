// S1 (iCal連携) 検証: syncSettings の lastSync / bookings 最新状況を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  // 1. syncSettings 各ドキュメントの lastSync を確認
  console.log("=== syncSettings 詳細 ===");
  const ss = await db.collection("syncSettings").get();
  ss.docs.forEach(d => {
    const x = d.data();
    const last = x.lastSyncAt?.toDate?.() || x.lastSync?.toDate?.() || null;
    console.log(`[${x.platform}] ${x.propertyName}`);
    console.log(`  active: ${x.active}`);
    console.log(`  lastSyncAt: ${last ? last.toISOString() : "(未同期)"}`);
    console.log(`  lastSyncStatus: ${x.lastSyncStatus || "(なし)"}`);
    console.log(`  lastSyncError: ${x.lastSyncError || "(なし)"}`);
  });

  // 2. 互換性: settings/syncConfig も確認 (古い仕様)
  console.log("\n=== settings/syncConfig (旧) ===");
  const sc = await db.collection("settings").doc("syncConfig").get();
  if (sc.exists) {
    const d = sc.data();
    Object.entries(d).forEach(([k, v]) => {
      if (v?.toDate) console.log(`  ${k}: ${v.toDate().toISOString()}`);
      else console.log(`  ${k}: ${JSON.stringify(v).substring(0, 100)}`);
    });
  } else {
    console.log("  (存在しない)");
  }

  // 3. bookings: the Terrace 長浜 全件取得→手元でソート (複合インデックス回避)
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const allBk = await db.collection("bookings").where("propertyId", "==", pid).get();
  console.log(`\n=== bookings: the Terrace 長浜 全件: ${allBk.size} ===`);

  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);
  const rows = allBk.docs.map(d => {
    const x = d.data();
    return {
      id: d.id,
      ci: toDate(x.checkIn),
      co: toDate(x.checkOut),
      created: toDate(x.createdAt),
      source: x.source,
      guestName: x.guestName,
      status: x.status,
    };
  });

  // created 降順、最新10件
  rows.sort((a, b) => (b.created?.getTime() || 0) - (a.created?.getTime() || 0));
  console.log("\n[直近 created 10件]");
  rows.slice(0, 10).forEach(r => {
    const ci = r.ci?.toISOString()?.substring(0, 10) || "?";
    const co = r.co?.toISOString()?.substring(0, 10) || "?";
    const cr = r.created?.toISOString()?.substring(0, 16) || "?";
    console.log(`  ${r.source?.padEnd(12)} ${ci}~${co}  ${(r.guestName||"").padEnd(20)} created=${cr}  status=${r.status}`);
  });

  // 未来予約
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const future = rows.filter(r => r.ci && r.ci >= today);
  future.sort((a, b) => a.ci - b.ci);
  console.log(`\n[未来チェックイン予約: ${future.length}件]`);
  future.slice(0, 10).forEach(r => {
    const ci = r.ci?.toISOString()?.substring(0, 10);
    const co = r.co?.toISOString()?.substring(0, 10);
    console.log(`  ${ci}~${co}  ${r.source?.padEnd(12)} ${(r.guestName||"").padEnd(20)} status=${r.status}`);
  });

  // source 別集計
  const bySource = {};
  rows.forEach(r => { bySource[r.source || "?"] = (bySource[r.source || "?"] || 0) + 1; });
  console.log(`\n[source 別]`);
  Object.entries(bySource).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
