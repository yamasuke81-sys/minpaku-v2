#!/usr/bin/env node
// public/js・public/css を編集したら、index.html の ?v= 更新と
// 両系統デプロイ(relay+本番)を忘れないよう Claude にリマインドするフック。
// PostToolUse(Edit|Write) で発火。additionalContext を返すだけで、何もブロックしない。

let raw = "";
try {
  raw = await new Promise((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
} catch {
  process.exit(0);
}

let fp = "";
try {
  fp = JSON.parse(raw || "{}")?.tool_input?.file_path ?? "";
} catch {
  fp = "";
}
const norm = fp.replace(/\\/g, "/");

// 対象: public/js または public/css 配下。index.html 自体は除外。
const isAsset = /\/public\/(js|css)\//.test(norm);
if (!isAsset) process.exit(0);

const msg =
  "【アセット更新リマインド】" +
  norm.split("/public/")[1] +
  " を変更しました。配信前に `node scripts/bump-version.mjs` を実行すれば、" +
  "index.html の全 ?v=・版数バッジ・version.json が1トークンに自動同期されます" +
  "（手動で揃えるとversion.json漏れ→無限リロードを起こすため、必ずスクリプト経由で）。" +
  "デプロイは /deploy-v2 推奨（bump→relay必須→本番git push を一括）。" +
  "版数不整合のまま push/firebase deploy するとガードフックがブロックします。";

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: msg,
    },
  })
);
process.exit(0);
