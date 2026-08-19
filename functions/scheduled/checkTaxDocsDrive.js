/**
 * Driveフォルダ日次監視（毎朝7:00 JST）
 * 全名義の税理士共有フォルダをスキャンし、チェックリストを自動更新
 * ファイルが見つかった項目は自動でcollected=trueにする
 *
 * 通知方針(2026-08-19 やますけ決定・同日第2版):
 *   日々の「検出しました」は通知しない。検出＝システムが勝手にチェックを付けるだけで
 *   人が動く必要がなく、項目名だけの事後報告は読み取れず価値がなかった。
 *   不足分の通知はPC常駐秘書側(tax-docs-missing-check.mjs → 1件=1メッセージ+解決ボタン)が担う。
 *   この関数はスキャンとチェックリスト更新に専念する(Discordへは何も送らない)。
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

  // 対象は「前月」と「今月」の2ヶ月分。書類は翌月に届くものが多く(例: 7月分の明細が8月に
  // 2026.07 フォルダへ入る)、今月だけ見ていると前月分の到着を検出できない
  // JST基準(ランタイムはUTC。毎朝7時JST=前日22時UTCなので素のgetMonth()だと月初に当月がずれる)
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const ymOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const yearMonths = [ymOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), ymOf(now)];

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
  const { buildChecklistItems } = require("../api/tax-docs");
  let totalFound = 0;
  let totalMissing = 0;
  let newlyCollectedCount = 0;
  // 月次「不足リスト」用: yearMonth → [{ entityName, missing[], collected数, total数 }]
  const statusByYm = {};

  for (const yearMonth of yearMonths) {
  const [year, month] = yearMonth.split("-");

  for (const entDoc of entSnap.docs) {
    const ent = entDoc.data();
    if (!ent.taxFolderId) continue;

    // 月フォルダを探す — 実運用は「YYYY.MM」直下(例: IU_八朔/2026.07)。旧「YYYY年/M月」も後方互換で見る
    let monthFolderId = null;
    try {
      const dotFolder = await findSubfolder_(drive, ent.taxFolderId, `${year}.${month}`);
      if (dotFolder) {
        monthFolderId = dotFolder.id;
      } else {
        const yearFolder = await findSubfolder_(drive, ent.taxFolderId, `${year}年`);
        if (yearFolder) {
          const mFolder = await findSubfolder_(drive, yearFolder.id, `${parseInt(month)}月`);
          if (mFolder) monthFolderId = mFolder.id;
        }
      }
    } catch (e) {
      console.error(`Drive監視エラー(${ent.name}/${yearMonth}):`, e.message);
      continue;
    }

    if (!monthFolderId) continue;

    // フォルダ内の全ファイルをスキャン
    const driveFiles = await listAllFilesRecursive_(drive, monthFolderId);

    // チェックリスト更新(未生成なら entities マスタから自動初期化 — 従来はUIを開くまで
    // ドキュメントが無く、この監視が黙って continue し続けて一度も機能していなかった)
    const clRef = checklistCol.doc(yearMonth).collection("entities").doc(entDoc.id);
    const clDoc = await clRef.get();
    let clData;
    if (clDoc.exists) {
      clData = clDoc.data();
    } else {
      const initItems = buildChecklistItems(ent);
      if (initItems.length === 0) continue;
      clData = {
        entityName: ent.name,
        entityType: ent.type,
        items: initItems,
        completedCount: 0,
        totalCount: initItems.length,
        updatedAt: FieldValue.serverTimestamp(),
      };
      await checklistCol.doc(yearMonth).set({ createdAt: FieldValue.serverTimestamp() }, { merge: true });
      try {
        await clRef.create(clData); // 既存があれば失敗させて上書きを防ぐ(UI/API側と競合しうる)
      } catch (e) {
        const cur = await clRef.get();
        if (!cur.exists) throw e;
        clData = cur.data();
      }
    }

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
          newlyCollectedCount++;
        }
      } else {
        totalMissing++;
      }
    }

    if (changed) {
      const completedCount = items.filter((i) => i.collected).length;
      await clRef.update({ items, completedCount, updatedAt: FieldValue.serverTimestamp() });
    }

    // 月次「不足リスト」の材料。手で✅を付けた分(collected=true)も揃った扱いにする
    const missing = items.filter((i) => !i.collected).map((i) => i.name);
    (statusByYm[yearMonth] = statusByYm[yearMonth] || []).push({
      entityName: ent.name,
      missing,
      collectedCount: items.length - missing.length,
      totalCount: items.length,
    });
  }
  } // yearMonths ループ終わり

  // 不足分の通知はPC常駐秘書側(tax-docs-missing-check.mjs)が1件=1メッセージ+解決ボタンで担う。
  // ここからDiscordへは何も送らない(2026-08-19 やますけ決定)。
  console.log(`Drive監視完了: ${totalFound}件検出, ${totalMissing}件不足, ${newlyCollectedCount}件新規チェック`);
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
