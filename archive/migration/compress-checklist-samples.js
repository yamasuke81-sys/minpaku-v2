#!/usr/bin/env node
// 既存のチェックリスト見本写真を一括圧縮 (長辺 1280px / JPEG q=78)
// Storage の checklist-samples/** を巡回し、未圧縮 (customMetadata.compressed != v1) のものを再エンコード。
// 圧縮後ファイルは元と同じパスに上書き、Firestore checklistTemplates/* の url/path は変更不要 (path 同じ)。
//
// 使い方:
//   node migration/compress-checklist-samples.js --dry-run  (試行のみ)
//   node migration/compress-checklist-samples.js            (実行)
const admin = require("firebase-admin");
const sharp = require("sharp");

admin.initializeApp({
  projectId: "minpaku-v2",
  storageBucket: "minpaku-v2.firebasestorage.app",
});
const bucket = admin.storage().bucket();

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_PX = 1280;
const QUALITY = 78;

(async () => {
  const [files] = await bucket.getFiles({ prefix: "checklist-samples/" });
  console.log(`対象 ${files.length} ファイル (DRY_RUN=${DRY_RUN})\n`);

  let okCount = 0, skipCount = 0, failCount = 0;
  let totalOrigKB = 0, totalNewKB = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const meta = (f.metadata.metadata || {});
    if (meta.compressed === "v1") { skipCount++; continue; }
    const origSize = parseInt(f.metadata.size || "0", 10);
    if (!origSize) { skipCount++; continue; }

    try {
      const [buf] = await f.download();
      // sharp で長辺 MAX_PX に縮小 + JPEG エンコード
      const out = await sharp(buf, { failOn: "none" })
        .rotate() // EXIF 回転を反映
        .resize({ width: MAX_PX, height: MAX_PX, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: QUALITY, mozjpeg: true })
        .toBuffer();

      // 元より大きくなった場合はスキップ
      if (out.length >= origSize) {
        console.log(`  ${i + 1}/${files.length} ${f.name} → 元と同等以上のため未上書き (orig=${(origSize/1024).toFixed(0)}KB, new=${(out.length/1024).toFixed(0)}KB)`);
        skipCount++;
        // メタデータだけ compressed=v1 を付けて再処理を防ぐ
        if (!DRY_RUN) {
          await f.setMetadata({ metadata: { ...meta, compressed: "v1", reasonSkip: "no-gain" } });
        }
        continue;
      }

      if (!DRY_RUN) {
        // 同じ path に上書き保存 (URL を変えない)
        await f.save(out, {
          contentType: "image/jpeg",
          metadata: {
            metadata: {
              ...meta,
              compressed: "v1",
              compressedAt: new Date().toISOString(),
              originalSize: String(origSize),
              compressionMaxPx: String(MAX_PX),
              compressionQuality: String(QUALITY),
            },
          },
          resumable: false,
        });
      }

      totalOrigKB += origSize / 1024;
      totalNewKB += out.length / 1024;
      okCount++;
      const reduction = ((1 - out.length / origSize) * 100).toFixed(0);
      console.log(`  ${i + 1}/${files.length} ${f.name} → ${(origSize/1024).toFixed(0)}KB → ${(out.length/1024).toFixed(0)}KB (${reduction}% 削減) ${DRY_RUN ? "[DRY]" : ""}`);
    } catch (e) {
      failCount++;
      console.warn(`  ${i + 1}/${files.length} ${f.name} → 失敗: ${e.message}`);
    }
  }

  console.log(`\n=== 完了 ===`);
  console.log(`成功: ${okCount}`);
  console.log(`スキップ: ${skipCount}`);
  console.log(`失敗: ${failCount}`);
  console.log(`合計サイズ: ${totalOrigKB.toFixed(0)} KB → ${totalNewKB.toFixed(0)} KB (削減 ${(totalOrigKB - totalNewKB).toFixed(0)} KB / ${totalOrigKB > 0 ? ((1 - totalNewKB / totalOrigKB) * 100).toFixed(0) : 0}%)`);
})().catch(e => { console.error(e); process.exit(1); });
