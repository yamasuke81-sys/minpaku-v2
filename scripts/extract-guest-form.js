// guest-form.html から i18n.ja を抽出して JSON で出力
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "public", "guest-form.html"), "utf8");

// const i18n = { ja: { ... }, en: { ... } };  を抽出
const m = src.match(/const i18n\s*=\s*(\{[\s\S]*?\n\s*\};)/);
if (!m) { console.error("i18n 見つからず"); process.exit(1); }
const objText = m[1].replace(/;\s*$/, "");
// eval して取得
const i18n = eval("(" + objText + ")");
const keys = Object.keys(i18n.ja);
const items = keys.map(k => i18n.ja[k]);
process.stdout.write(JSON.stringify({ keys, items }, null, 2));
