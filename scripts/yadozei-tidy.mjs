// OTAcsv フォルダの整理: 種別(airbnb/booking/申告書/月計表)×月 ごとに最新1件だけ残し、古い/失敗分をゴミ箱へ
import admin from "firebase-admin";
import { google } from "googleapis";
if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

async function driveClient(sender) {
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  const { clientId, clientSecret } = oauthDoc.data();
  const cols = [
    db.collection("settings").doc("gmailOAuth").collection("tokens"),
    db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
  ];
  let tok = null;
  if (sender) for (const c of cols) { const s = await c.where("email", "==", sender).limit(1).get(); if (!s.empty) { tok = s.docs[0].data(); break; } }
  if (!tok) for (const c of cols) { const s = await c.limit(1).get(); if (!s.empty) { tok = s.docs[0].data(); break; } }
  const oa = new google.auth.OAuth2(clientId, clientSecret);
  oa.setCredentials({ refresh_token: tok.refreshToken });
  return google.drive({ version: "v3", auth: oa });
}

const [, , cmd, arg, flag] = process.argv;
const drive = await driveClient("yamasuke81@gmail.com");

if (cmd === "parent") {
  const f = await drive.files.get({ fileId: arg, fields: "id,name,parents" });
  console.log(`${f.data.name} → parents=${JSON.stringify(f.data.parents)}`);
  process.exit(0);
}

if (cmd === "tidy") {
  const folderId = arg;
  const apply = flag === "--apply";
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id,name,size,createdTime,mimeType)",
    orderBy: "createdTime desc",
    pageSize: 1000,
  });
  const files = res.data.files || [];
  const re = /^(airbnb_reservations|booking_reservations|yadozei_申告書|yadozei_月計表)_(\d{4}-\d{2})_(\d+)\.(csv|pdf)$/;
  const groups = {};
  const other = [];
  for (const f of files) {
    const m = f.name.match(re);
    if (!m) { other.push(f); continue; }
    const key = `${m[1]}|${m[2]}`;
    (groups[key] = groups[key] || []).push({ ...f, ts: Number(m[3]) });
  }
  const keep = [];
  const trash = [];
  for (const key of Object.keys(groups).sort()) {
    const arr = groups[key].sort((a, b) => b.ts - a.ts); // 新しい順
    keep.push({ key, f: arr[0] });
    trash.push(...arr.slice(1));
  }
  console.log(`フォルダ ${folderId}: 全 ${files.length} 件`);
  console.log(`\n=== 残す (種別×月の最新) ${keep.length}件 ===`);
  for (const { key, f } of keep) console.log(`  [${key}] ${f.name}  ${f.size || "?"}B`);
  console.log(`\n=== ゴミ箱へ ${trash.length}件 ===`);
  for (const f of trash) console.log(`  ${f.name}  ${f.size || "?"}B`);
  if (other.length) {
    console.log(`\n=== 対象外(触らない) ${other.length}件 ===`);
    for (const f of other) console.log(`  ${f.name}`);
  }
  if (apply) {
    for (const f of trash) await drive.files.update({ fileId: f.id, requestBody: { trashed: true } });
    console.log(`\n✅ ${trash.length}件をゴミ箱へ移動しました`);
  } else {
    console.log(`\n(dry-run。実行は: node yadozei-tidy.mjs tidy ${folderId} --apply)`);
  }
  process.exit(0);
}

console.log("usage: parent <fileId> | tidy <folderId> [--apply]");
process.exit(0);
