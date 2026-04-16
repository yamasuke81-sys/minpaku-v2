/**
 * minpaku 物件一覧表示（propertyId 確認用）
 *
 * 実行:
 *   cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
 *   node migration/list-minpaku-properties.js
 */
const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'minpaku-v2',
  credential: admin.credential.applicationDefault()
});
const db = admin.firestore();

(async () => {
  const snap = await db.collection('properties').get();
  const rows = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.displayOrder || 999) - (b.displayOrder || 999));

  console.log('=== 全物件 (' + rows.length + '件) ===');
  rows.forEach(p => {
    const mark = p.type === 'minpaku' ? '[民泊]' : '     ';
    console.log(`${mark} ${p.id.padEnd(28)} ${p.name || '(名称なし)'} (type=${p.type || 'unknown'}, active=${p.active})`);
  });

  const minpaku = rows.filter(p => p.type === 'minpaku');
  console.log('\n=== 民泊物件のみ (' + minpaku.length + '件) ===');
  minpaku.forEach(p => {
    console.log(`  ${p.id}  ${p.name}`);
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
