#!/usr/bin/env node
// アセット版数トークン(vMMDDx)を1つ生成し、配信に関わる3箇所を必ず同じ値に揃える:
//   (1) public/index.html の全 ?v= クエリ
//   (2) public/index.html の版数バッジ <small>
//   (3) public/version.json の version
// index.html と version.json が不一致だとアプリが新版検知→無限リロードを起こす(過去に複数回再発)。
// デプロイ前に必ず実行する。/deploy-v2 スキルの手順1で自動実行される。
//
// 使い方: minpaku-v2 直下で `node scripts/bump-version.mjs`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const idxPath = resolve(root, "public/index.html");
const verPath = resolve(root, "public/version.json");

if (!existsSync(idxPath)) {
  console.error("public/index.html が見つかりません。minpaku-v2 直下で実行してください。");
  process.exit(1);
}

let idx = readFileSync(idxPath, "utf8");

// 現行トークン検出(最頻出を現行とみなす)
const TOKEN_RE = /v\d{4}[a-z]/g;
const found = idx.match(TOKEN_RE) || [];
if (found.length === 0) {
  console.error("版数トークン(vMMDDx)が index.html に見つかりません。");
  process.exit(1);
}
const counts = {};
for (const t of found) counts[t] = (counts[t] || 0) + 1;
const current = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

// 今日の MMDD
const d = new Date();
const mmdd = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");

// 新トークン: 同日なら現行letterの次、別日なら 'a'
let nextToken;
const cur = current.match(/^v(\d{4})([a-z])$/);
if (cur && cur[1] === mmdd) {
  let code = cur[2].charCodeAt(0) + 1;
  if (code > "z".charCodeAt(0)) {
    console.error(`本日(${mmdd})の版数が z を超えました(${current})。手動で命名規則を見直してください。`);
    process.exit(1);
  }
  nextToken = `v${mmdd}${String.fromCharCode(code)}`;
} else {
  nextToken = `v${mmdd}a`;
}

// 全トークンを新トークンに統一(?v=・バッジ・万一の不統一を一括解消)
const replaced = found.length;
idx = idx.replace(TOKEN_RE, nextToken);
writeFileSync(idxPath, idx, "utf8");
writeFileSync(verPath, JSON.stringify({ version: nextToken }) + "\n", "utf8");

console.log(`版数更新: ${current} → ${nextToken}`);
console.log(`  index.html: ${replaced}箇所を統一 / version.json: 同期完了`);
