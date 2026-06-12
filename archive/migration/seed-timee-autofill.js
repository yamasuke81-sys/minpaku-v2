#!/usr/bin/env node
// 物件マスタに timeeAutofill フィールドを投入する。
// userscripts/timee-autofill.user.js が hash params からフォーム自動入力する前提で、
// 物件ごとの「テンプレ複製 URL + 既定値」をここで定義。
//
// 使い方:
//   node functions/migration/seed-timee-autofill.js            # dry-run
//   node functions/migration/seed-timee-autofill.js --execute  # 本番反映
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

// 物件名 → timeeAutofill 設定 (部分一致で match)
// グループ ID はタイミー側で生成された数値 (現状 the Terrace 長浜 のみ判明)
const SEED = [
  {
    nameContains: "the Terrace 長浜",
    config: {
      baseUrl: "https://app-new.taimee.co.jp/clients/491738/offers/2073190/offerings/new",
      start: "10:00",
      end: "12:00",
      restMin: 0,
      workers: 1,
      wage: 1100,
      transport: 0,
      autoMsg: true,
      autoMsgTarget: "everyone",
      groupIds: "2147357", // "the Terrace 長浜(5人)" グループ
    },
  },
  {
    nameContains: "YADO KOMACHI",
    config: {
      baseUrl: "https://app-new.taimee.co.jp/clients/508795/offers/2249514/offerings/new",
      start: "10:00",
      end: "12:00",
      restMin: 0,
      workers: 1,
      wage: 1100,
      transport: 0,
      autoMsg: true,
      autoMsgTarget: "everyone",
      groupIds: "", // YADO KOMACHI のグループ ID は未取得。設定 UI から後追い登録可
    },
  },
];

(async () => {
  const snap = await db.collection("properties").where("active", "==", true).get();
  console.log(`active 物件: ${snap.size}件`);

  let updated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const p = doc.data() || {};
    const name = p.name || "";
    const seed = SEED.find((s) => name.includes(s.nameContains));
    if (!seed) {
      skipped++;
      continue;
    }
    console.log(`\n→ ${doc.id} : ${name}`);
    console.log(`   set timeeAutofill =`, JSON.stringify(seed.config, null, 2));
    if (isExecute) {
      await doc.ref.update({
        timeeAutofill: seed.config,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      updated++;
    }
  }

  console.log(`\n結果: ${isExecute ? `更新 ${updated} 件` : `対象 ${SEED.length - 0} 件 (dry-run)`}, 対象外 ${skipped} 件`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
