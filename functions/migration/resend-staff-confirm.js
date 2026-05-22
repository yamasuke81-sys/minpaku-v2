#!/usr/bin/env node
// 指定 recruitment の staff_confirm 通知を再送する
// (バッチ機能デプロイ前に確定した recruitment が batch enqueue されずに通知が
//  飛んでいなかったケースの救済用)
//
// 使い方:
//   node functions/migration/resend-staff-confirm.js {recruitmentId}         # dry-run
//   node functions/migration/resend-staff-confirm.js {recruitmentId} --execute
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { notifyByKey } = require("../utils/lineNotify");
const { workLabel } = require("../utils/workType");

const args = process.argv.slice(2);
const recId = args.find(a => !a.startsWith("--"));
const isExecute = args.includes("--execute");
if (!recId) { console.error("usage: resend-staff-confirm.js {recruitmentId} [--execute]"); process.exit(1); }
console.log(`recruitmentId: ${recId} / mode: ${isExecute ? "EXECUTE" : "DRY-RUN"}`);

(async () => {
  const r = await db.collection("recruitments").doc(recId).get();
  if (!r.exists) { console.error("recruitment が見つかりません"); process.exit(1); }
  const data = r.data();
  console.log("== recruitment ==");
  console.log(`  propertyName: ${data.propertyName}`);
  console.log(`  checkoutDate: ${data.checkoutDate}`);
  console.log(`  workType: ${data.workType}`);
  console.log(`  selectedStaff: ${data.selectedStaff}`);
  console.log(`  status: ${data.status}`);
  if (data.status !== "スタッフ確定済み") {
    console.log("  (確定済みではないので再送しない)");
    process.exit(0);
  }
  if (!isExecute) {
    console.log("\nDRY-RUN: --execute で実際に notifyByKey('staff_confirm', ...) を発火します");
    process.exit(0);
  }

  // recruitment.js の通常の確定通知と同じ vars を組み立て
  const dashUrl = `https://minpaku-v2.web.app/#/recruitment`;
  const work = workLabel(data.workType);
  const text = `${work}担当確定\n${data.checkoutDate}\n\n担当: ${data.selectedStaff}\n\nよろしくお願いします🍊\n\n詳細を確認↓\n${dashUrl}`;
  const vars = {
    date: data.checkoutDate,
    property: data.propertyName || "",
    propertyName: data.propertyName || "",
    staff: data.selectedStaff || "",
    work,
    workType: data.workType || "cleaning",
    url: dashUrl,
  };
  const result = await notifyByKey(db, "staff_confirm", {
    title: `確定再送: ${data.checkoutDate}`,
    body: text,
    vars,
    propertyId: data.propertyId || null,
    staffIds: [],
  });
  console.log("\n=== 結果 ===");
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
