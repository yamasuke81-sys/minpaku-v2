// the Terrace 長浜 の最近のゲスト名簿から TOKEN を取得し、ハウスルール URL を組み立てる
// 駐車場割当 (parkingAllocation) の台数別に分類して表示
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
  const BASE_URL = "https://minpaku-v2.web.app/guides/the-terrace-nagahama.html";

  const snap = await db.collection("guestRegistrations")
    .where("propertyId", "==", PROPERTY_ID)
    .get();

  const all = snap.docs
    .map(d => ({ doc: d, data: d.data() }))
    .sort((a, b) => {
      const ta = a.data.createdAt && a.data.createdAt.toMillis ? a.data.createdAt.toMillis() : 0;
      const tb = b.data.createdAt && b.data.createdAt.toMillis ? b.data.createdAt.toMillis() : 0;
      return tb - ta;
    });

  console.log(`総数: ${all.length}件\n`);

  // 駐車場割当の台数別に分類
  const groups = { 0: [], 1: [], 2: [], 3: [], more: [] };
  for (const { doc, data: g } of all) {
    const alloc = Array.isArray(g.parkingAllocation) ? g.parkingAllocation : [];
    const n = alloc.length;
    const key = n >= 3 && n !== 3 ? "more" : String(n);
    (groups[key] || groups.more).push({ doc, g, alloc });
  }

  // 各グループの先頭3件をサンプル表示
  for (const key of ["0", "1", "2", "3", "more"]) {
    const arr = groups[key];
    if (!arr || arr.length === 0) continue;
    console.log(`===== 駐車場 ${key}台 (${arr.length}件) =====`);
    arr.slice(0, 3).forEach(({ doc, g, alloc }) => {
      const token = g.editToken || g.guestToken || g.token || doc.id;
      const url = `${BASE_URL}?guest=${encodeURIComponent(token)}`;
      console.log(`  name: ${g.guestName || "(空)"}`);
      console.log(`  checkIn: ${g.checkIn || "(空)"} → ${g.checkOut || "(空)"}`);
      console.log(`  parkingAllocation: ${JSON.stringify(alloc)}`);
      console.log(`  URL: ${url}`);
      console.log("");
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
