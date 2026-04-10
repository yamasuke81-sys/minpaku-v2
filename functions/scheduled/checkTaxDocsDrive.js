/**
 * Driveフォルダ日次監視（毎朝7:00 JST）
 * 全名義の税理士共有フォルダをスキャンし、チェックリストを自動更新
 * ファイルが見つかった項目は自動でcollected=trueにする
 */
const { google } = require("googleapis");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = async function checkTaxDocsDrive(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const taxSettings = await db.collection("settings").doc("taxDocs").get();
  const taxConf = taxSettings.exists ? taxSettings.data() : {};
  if (taxConf.enabled === false) {
    console.log("税理士資料監視が無効です");
    return;
  }

  // 今月の年月
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [year, month] = yearMonth.split("-");
  const yearStr = `${year}年`;
  const monthStr = `${parseInt(month)}月`;

  let drive;
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    drive = google.drive({ version: "v3", auth });
  } catch (e) {
    console.error("Drive APIクライアント初期化エラー:", e.message);
    return;
  }

  const entSnap = await db.collection("entities").orderBy("displayOrder").get();
  const checklistCol = db.collection("taxDocsChecklist");
  let totalFound = 0;
  let totalMissing = 0;
  const newlyCollected = [];

  for (const entDoc of entSnap.docs) {
    const ent = entDoc.data();
    if (!ent.taxFolderId) continue;

    // 年/月フォルダを探す
    let monthFolderId = null;
    try {
      const yearFolder = await findSubfolder_(drive, ent.taxFolderId, yearStr);
      if (yearFolder) {
        const mFolder = await findSubfolder_(drive, yearFolder.id, monthStr);
        if (mFolder) monthFolderId = mFolder.id;
      }
    } catch (e) {
      console.error(`Drive監視エラー(${ent.name}):`, e.message);
      continue;
    }

    if (!monthFolderId) continue;

    // フォルダ内の全ファイルをスキャン
    const driveFiles = await listAllFilesRecursive_(drive, monthFolderId);

    // チェックリスト更新
    const clRef = checklistCol.doc(yearMonth).collection("entities").doc(entDoc.id);
    const clDoc = await clRef.get();
    if (!clDoc.exists) continue;

    const clData = clDoc.data();
    const items = clData.items || [];
    if (items.length === 0) continue;

    let changed = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const keywords = getItemKeywords_(item, ent);
      const matchedFile = driveFiles.find((f) =>
        keywords.some((kw) => f.name.toLowerCase().includes(kw.toLowerCase()))
      );

      items[i].driveFileExists = !!matchedFile;
      items[i].driveCheckedAt = new Date();

      if (matchedFile) {
        totalFound++;
        if (!items[i].collected) {
          items[i].collected = true;
          items[i].collectedAt = new Date();
          items[i].autoCollected = true;
          items[i].driveFileName = matchedFile.name;
          changed = true;
          newlyCollected.push(`${ent.name}: ${item.name}`);
        }
      } else {
        totalMissing++;
      }
    }

    if (changed) {
      const completedCount = items.filter((i) => i.collected).length;
      await clRef.update({ items, completedCount, updatedAt: FieldValue.serverTimestamp() });
    }
  }

  // 新たに収集されたものがあればLINE通知
  if (newlyCollected.length > 0) {
    try {
      const { notifyOwner } = require("../utils/lineNotify");
      const lines = [`📁 税理士資料 自動検出（${yearMonth}）\n`];
      newlyCollected.forEach((c) => lines.push(`✅ ${c}`));
      await notifyOwner(db, "tax_docs_drive_check", "税理士資料 自動検出", lines.join("\n"));
    } catch (e) {
      console.warn("LINE通知エラー（続行）:", e.message);
    }
  }

  console.log(`Drive監視完了: ${totalFound}件検出, ${totalMissing}件不足, ${newlyCollected.length}件新規チェック`);
};

// ========== ヘルパー ==========

async function findSubfolder_(drive, parentId, name) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files && res.data.files.length > 0) ? res.data.files[0] : null;
}

async function listAllFilesRecursive_(drive, folderId) {
  const files = [];
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id,name,mimeType)",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  for (const f of (res.data.files || [])) {
    files.push(f);
    if (f.mimeType === "application/vnd.google-apps.folder") {
      const subFiles = await listAllFilesRecursive_(drive, f.id);
      files.push(...subFiles);
    }
  }
  return files;
}

function getItemKeywords_(item, entity) {
  const acc = (entity.accounts || []).find((a) => a.name === item.name);
  if (acc && acc.keywords && acc.keywords.length > 0) return acc.keywords;
  const plat = (entity.platforms || []).find((p) => p.name === item.name);
  if (plat) {
    const keywords = [plat.name.split("送金")[0], plat.name.split("手数料")[0]].filter(Boolean);
    if (plat.propertyName) keywords.push(plat.propertyName);
    return keywords.length > 0 ? keywords : [item.name];
  }
  return [item.name];
}
