/**
 * Firestore checklistMaster 投入スクリプト（1回限りのシード）
 *
 * 事前準備:
 *   1. gcloud auth application-default login
 *      (または GOOGLE_APPLICATION_CREDENTIALS にサービスアカウントJSONのパスを設定)
 *
 * 実行:
 *   cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
 *   node migration/seed-checklist-master.js --dry-run       # まず確認
 *   node migration/seed-checklist-master.js                 # 本番: マスタ投入
 *   node migration/seed-checklist-master.js --copyTo=<propertyId>  # 物件テンプレートもコピー
 *
 * 動作:
 *   - ../temp/checklist-master-seed.json を読み込み
 *   - Firestore: checklistMaster/main に set() (既存は上書き)
 *   - --copyTo 指定時: checklistTemplates/{propertyId} にもコピー
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const PROJECT_ID = 'minpaku-v2';
const SEED_FILE = path.resolve(__dirname, '..', '..', 'temp', 'checklist-master-seed.json');

// コマンドライン引数
const args = process.argv.slice(2);
const copyToArg = args.find(a => a.startsWith('--copyTo='));
const copyToPropertyId = copyToArg ? copyToArg.split('=')[1] : null;
const dryRun = args.includes('--dry-run');

// 初期化
admin.initializeApp({
  projectId: PROJECT_ID,
  credential: admin.credential.applicationDefault()
});
const db = admin.firestore();

async function main() {
  console.log('=== checklistMaster シード投入 ===');
  console.log('プロジェクト:', PROJECT_ID);
  console.log('ソース:', SEED_FILE);
  if (dryRun) console.log('※ DRY RUN モード（書き込みしない）');

  if (!fs.existsSync(SEED_FILE)) {
    throw new Error('シードファイルが存在しない: ' + SEED_FILE);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

  const masterData = {
    _meta: seed._meta,
    areas: seed.areas,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    version: 1
  };

  const sizeKB = Math.round(Buffer.byteLength(JSON.stringify(masterData)) / 1024);
  console.log('投入サイズ:', sizeKB, 'KB (Firestore上限 1024KB)');
  console.log('エリア数:', seed.areas.length);

  if (dryRun) {
    console.log('DRY RUN: マスタ書き込みスキップ');
  } else {
    await db.collection('checklistMaster').doc('main').set(masterData);
    console.log('✓ checklistMaster/main に書き込み完了');
  }

  // 物件テンプレートへのコピー
  if (copyToPropertyId) {
    console.log('\n--- 物件テンプレートへコピー ---');
    console.log('propertyId:', copyToPropertyId);

    // 物件が存在するか確認
    const propDoc = await db.collection('properties').doc(copyToPropertyId).get();
    if (!propDoc.exists) {
      throw new Error('物件が見つからない: ' + copyToPropertyId);
    }
    const prop = propDoc.data();
    console.log('物件名:', prop.name, '/ type:', prop.type);

    const templateData = {
      propertyId: copyToPropertyId,
      sourcePropertyId: null,
      copiedFrom: 'master',
      copiedAt: admin.firestore.FieldValue.serverTimestamp(),
      _meta: seed._meta,
      areas: seed.areas,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      version: 1
    };

    if (dryRun) {
      console.log('DRY RUN: テンプレート書き込みスキップ');
    } else {
      await db.collection('checklistTemplates').doc(copyToPropertyId).set(templateData);
      console.log('✓ checklistTemplates/' + copyToPropertyId + ' に書き込み完了');
    }
  }

  console.log('\n完了');
}

main().then(() => process.exit(0)).catch(e => {
  console.error('エラー:', e);
  process.exit(1);
});
