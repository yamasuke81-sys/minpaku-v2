/**
 * yadozei-admin — 宿泊税CSV自動化のデバッグ/運用ツール (admin SDK 直叩き)
 *
 * 使い方 (scripts ディレクトリで):
 *   node yadozei-admin.mjs state                        listener heartbeat + 最近のジョブ概況
 *   node yadozei-admin.mjs jobs [n]                     最近 n 件(既定10)のジョブを表示
 *   node yadozei-admin.mjs job <docId>                  1ジョブの詳細(error 全文)
 *   node yadozei-admin.mjs enqueue <kind> <pid> <ym> [k=v ...]
 *        例: enqueue airbnb_csv_fetch <pid> 2026-05 listingId=12345678
 *            enqueue booking_csv_fetch <pid> 2026-05 bookingPropertyId=14868587
 *            enqueue yadozei_pdf_fetch <pid> 2026-05
 *   node yadozei-admin.mjs prop <pid>                   物件の yadozei 設定を表示
 *   node yadozei-admin.mjs clean-pending               pending/processing の滞留ジョブを failed 化
 */
import admin from "firebase-admin";

if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const [, , cmd, ...args] = process.argv;
const ts = (t) => (t && t.toDate ? t.toDate().toISOString().replace("T", " ").slice(0, 19) : "-");

async function main() {
  if (cmd === "state") {
    const s = await db.collection("settings").doc("yadozeiListener").get();
    if (!s.exists) {
      console.log("listener heartbeat: 未記録 (settings/yadozeiListener なし)");
    } else {
      const d = s.data();
      const last = d.lastSeenAt?.toDate?.();
      const ageSec = last ? Math.round((Date.now() - last.getTime()) / 1000) : null;
      console.log(`listener: host=${d.hostName} v${d.version} lastSeen=${ts(d.lastSeenAt)} (${ageSec}秒前) alive=${ageSec != null && ageSec < 120}`);
    }
    const snap = await db.collection("yadozeiQueue").orderBy("createdAt", "desc").limit(8).get();
    console.log(`\n最近のジョブ (${snap.size}):`);
    snap.forEach((doc) => {
      const j = doc.data();
      console.log(`  [${j.status}] ${doc.id} ${j.kind} ${j.propertyName || ""} ${j.yearMonth || ""}${j.error ? " ERR=" + j.error.slice(0, 80) : ""}`);
    });
    return;
  }

  if (cmd === "jobs") {
    const n = parseInt(args[0] || "10", 10);
    const snap = await db.collection("yadozeiQueue").orderBy("createdAt", "desc").limit(n).get();
    snap.forEach((doc) => {
      const j = doc.data();
      console.log(`[${j.status}] ${doc.id} ${j.kind} ${j.propertyName || ""} ${j.yearMonth || ""} createdAt=${ts(j.createdAt)}${j.error ? "\n    ERR=" + j.error : ""}`);
    });
    return;
  }

  if (cmd === "job") {
    const doc = await db.collection("yadozeiQueue").doc(args[0]).get();
    if (!doc.exists) return console.log("ジョブが見つかりません");
    console.log(JSON.stringify(doc.data(), null, 2));
    return;
  }

  if (cmd === "prop") {
    const doc = await db.collection("properties").doc(args[0]).get();
    if (!doc.exists) return console.log("物件が見つかりません");
    const d = doc.data();
    console.log(`物件: ${d.name} (${args[0]})`);
    console.log(`senderGmail: ${d.senderGmail || "(なし)"}`);
    console.log("yadozei:", JSON.stringify(d.yadozei || null, null, 2));
    return;
  }

  if (cmd === "enqueue") {
    const [kind, pid, ym, ...kvs] = args;
    if (!kind || !pid || !ym) return console.log("usage: enqueue <kind> <pid> <ym> [k=v ...]");
    const params = {};
    for (const kv of kvs) {
      const i = kv.indexOf("=");
      if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const propDoc = await db.collection("properties").doc(pid).get();
    const propName = propDoc.exists ? propDoc.data().name || pid : pid;
    const ref = await db.collection("yadozeiQueue").add({
      kind, propertyId: pid, propertyName: propName, yearMonth: ym, params,
      status: "pending", result: null, createdBy: "admin-tool",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt: null, completedAt: null, error: null, retries: 0,
    });
    console.log(`投入: ${ref.id} kind=${kind} property=${propName} ym=${ym} params=${JSON.stringify(params)}`);
    return;
  }

  if (cmd === "clean-pending") {
    const snap = await db.collection("yadozeiQueue").where("status", "in", ["pending", "processing"]).get();
    const batch = db.batch();
    snap.forEach((doc) => batch.update(doc.ref, { status: "failed", error: "admin: 手動クリーンアップ", completedAt: admin.firestore.FieldValue.serverTimestamp() }));
    if (snap.size) await batch.commit();
    console.log(`${snap.size} 件を failed 化`);
    return;
  }

  console.log("unknown cmd. state|jobs|job|prop|enqueue|clean-pending");
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
