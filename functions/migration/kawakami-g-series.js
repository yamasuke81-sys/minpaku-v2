// G系 (宿泊者目線) 検証: 各物件のフォーム設定と公開API状態
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log("=== G 系 (宿泊者目線) 検証 ===\n");

  const pSnap = await db.collection("properties").where("active", "==", true).get();
  const minpaku = pSnap.docs.filter(d => (d.data().type || "minpaku") === "minpaku");
  console.log(`民泊物件 (active): ${minpaku.length}件\n`);

  const report = [];
  for (const d of minpaku) {
    const p = d.data();
    const r = {
      pid: d.id,
      name: p.name,
      number: p.propertyNumber,
      showNoiseAgreement: p.showNoiseAgreement !== false,
      miniGameEnabled: p.miniGameEnabled !== false,
      customFormEnabled: p.customFormEnabled !== false,
      formFieldConfig: Boolean(p.formFieldConfig),
      customFormFields: (p.customFormFields || []).length,
      channelOverrides: Object.keys(p.channelOverrides || {}).length,
      icalUrls: (p.icalUrls || []).length,
      icalUrl: Boolean(p.icalUrl),
    };
    report.push(r);
  }

  // テーブル出力
  console.log("物件名                            | Noise | Game | Form | Fields | Overrides");
  console.log("-".repeat(95));
  for (const r of report) {
    const name = r.name.padEnd(32);
    const noise = r.showNoiseAgreement ? "✓" : "✗";
    const game = r.miniGameEnabled ? "✓" : "✗";
    const form = r.customFormEnabled ? "✓" : "✗";
    console.log(`${name} | ${noise.padEnd(5)} | ${game.padEnd(4)} | ${form.padEnd(4)} | ${String(r.customFormFields).padEnd(6)} | ${r.channelOverrides}件`);
  }

  // guestRegistrations 最近の投稿状況
  console.log("\n\n=== 最近の guestRegistrations (直近 5件) ===");
  const gSnap = await db.collection("guestRegistrations").orderBy("createdAt", "desc").limit(5).get();
  for (const d of gSnap.docs) {
    const g = d.data();
    const ct = g.createdAt?.toDate ? g.createdAt.toDate().toISOString() : g.createdAt;
    const hasToken = g.editToken ? `✓${g.editToken.length}文字` : "✗";
    console.log(`  ${g.checkIn}→${g.checkOut} ${g.guestName || "?"} src=${g.source} status=${g.status} editToken=${hasToken}`);
    console.log(`    propertyId=${g.propertyId || "?"} createdAt=${ct}`);
  }

  // 公開 API response (1物件サンプル)
  console.log("\n\n=== 公開 API サンプル (the Terrace 長浜) ===");
  const fetch = require("node-fetch") || global.fetch;
  try {
    const res = await fetch("https://minpaku-v2.web.app/api/public/guest-form-config/tsZybhDMcPrxqgcRy7wp");
    const data = await res.json();
    console.log(`  HTTP ${res.status}`);
    console.log(`  name: ${data.name}`);
    console.log(`  customFormEnabled: ${data.customFormEnabled}`);
    console.log(`  showNoiseAgreement: ${data.showNoiseAgreement}`);
    console.log(`  miniGameEnabled: ${data.miniGameEnabled}`);
    console.log(`  customFormFields: ${(data.customFormFields || []).length}件`);
    console.log(`  formFieldConfig: ${data.formFieldConfig ? `overrides(${Object.keys(data.formFieldConfig.overrides || {}).length})` : "なし"}`);
  } catch (e) {
    console.log(`  API エラー: ${e.message}`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
