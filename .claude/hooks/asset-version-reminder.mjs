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
  " を変更しました。配信反映のため次を忘れずに: " +
  "(1) public/index.html の該当 ?v= を全置換で更新＋バージョンバッジ更新" +
  "（忘れるとキャッシュで旧版配信）。" +
  "(2) デプロイは relay 必須＋本番 git push の両系統（/deploy-v2 参照）。";

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: msg,
    },
  })
);
process.exit(0);
