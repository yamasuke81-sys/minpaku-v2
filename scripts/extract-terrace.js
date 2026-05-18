// terrace-nagahama.html の translations 配列を抽出
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "public", "guides", "the-terrace-nagahama.html"), "utf8");
const m = src.match(/const translations\s*=\s*(\[[\s\S]*?\n\s*\]);/);
if (!m) { console.error("translations 見つからず"); process.exit(1); }
const arr = eval(m[1]);
const items = arr.map(row => row[1]); // [selector, ja, en] の ja
const meta = arr.map(row => ({ selector: row[0], en: row[2] }));
process.stdout.write(JSON.stringify({ items, meta }, null, 2));
