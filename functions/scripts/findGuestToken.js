// the Terrace 長浜 の最近のゲスト名簿から TOKEN を取得し、ハウスルール URL を組み立てる
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
  const BASE_URL = "https://minpaku-v2.web.app/guides/the-terrace-nagahama.html";

  // guestRegistrations から the Terrace 長浜 の全件取得 → クライアント側で createdAt 降順ソート + 上位5件
  // (orderBy + where の複合インデックスを回避)
  const snap = await db.collection("guestRegistrations")
    .where("propertyId", "==", PROPERTY_ID)
    .get();

  const sorted = snap.docs
    .map(d => ({ doc: d, data: d.data() }))
    .sort((a, b) => {
      const ta = a.data.createdAt && a.data.createdAt.toMillis ? a.data.createdAt.toMillis() : 0;
      const tb = b.data.createdAt && b.data.createdAt.toMillis ? b.data.createdAt.toMillis() : 0;
      return tb - ta;
    })
    .slice(0, 5);

  console.log(`取得: ${snap.size}件 (うち上位5件を表示)`);

  for (const { doc, data: g } of sorted) {
    const g = doc.data();
    // TOKEN は editToken (onGuestFormSubmit.js で生成、サンクスメールに埋め込まれる)
    const token = g.editToken || g.guestToken || g.token || doc.id;
    const url = `${BASE_URL}?guest=${encodeURIComponent(token)}`;
    console.log("----");
    console.log(`name: ${g.guestName || "(空)"}`);
    console.log(`checkIn: ${g.checkIn || "(空)"} → checkOut: ${g.checkOut || "(空)"}`);
    console.log(`token候補: ${token}`);
    console.log(`URL: ${url}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
