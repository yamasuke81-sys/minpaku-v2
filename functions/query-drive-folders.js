const { google } = require("googleapis");

async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

async function querySubfolders() {
  const drive = await getDriveClient();

  const folders = [
    { name: "012_両城", id: "1XKPQpCH9vUMPu-QezO8p0Zl4AjDVrqie" },
    { name: "011_仁方西神町", id: "1lQhTwbDr1dDGrZjLnP1nDSIVn-VC6PdA" },
    { name: "010_広白石", id: "1ly2ov9pad1lQ1NSSXma1jwC_r99-bOdO" },
    { name: "008_府中町城ヶ丘", id: "10XIBM1JlN2uzOMGhgyyOfijfkhchS5Cc" },
    { name: "006_長束", id: "1LSUKhb_Bf4TlRlzmlhXvnYYvqzli0hH_" },
    { name: "004_福田", id: "1dUvU7NOzGgc7zoEwRD0ner3A6MXFiwhZ" },
    { name: "002_畑賀", id: "1tYusFCZiwQMGt7nlT4TPrDMX0D67Mucv" }
  ];

  const results = {};

  for (const folder of folders) {
    try {
      console.log(`\n${folder.name} を取得中...`);
      
      const response = await drive.files.list({
        q: `'${folder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        spaces: "drive",
        pageSize: 100,
        fields: "files(id, name)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const subfolders = response.data.files || [];
      results[folder.name] = {
        id: folder.id,
        count: subfolders.length,
        subfolders: subfolders.map(f => ({ name: f.name, id: f.id }))
      };
      
      console.log(`✓ ${folder.name}: ${subfolders.length} 個のサブフォルダ`);
      subfolders.forEach(f => console.log(`  - ${f.name}`));
        
    } catch (err) {
      console.error(`✗ ${folder.name}: ${err.message}`);
      results[folder.name] = { error: err.message };
    }
  }
  
  console.log('\n\n=== 結果 ===');
  console.log(JSON.stringify(results, null, 2));
  return results;
}

querySubfolders().catch(err => {
  console.error("エラー:", err);
  process.exit(1);
});
