#!/usr/bin/env node
// PreToolUse(Bash) ブロッキングフック。
// minpaku-v2 で `git push` / `firebase deploy` する直前に、配信版数の整合をチェックし、
// 不整合(index.html の ?v= と version.json が不一致 / index.html 内で版数不統一)なら
// デプロイ自体を deny で止める。
// 目的: index.html と version.json の版数不一致による「無限リロード」事故の機械的再発防止。
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

let raw = "";
try {
  raw = await new Promise((res) => {
    let b = "";
    process.stdin.on("data", (c) => (b += c));
    process.stdin.on("end", () => res(b));
    process.stdin.on("error", () => res(b));
  });
} catch {
  process.exit(0);
}

let input = {};
try { input = JSON.parse(raw || "{}"); } catch { process.exit(0); }
const cmd = input?.tool_input?.command || "";

// 対象: git push もしくは firebase deploy (hosting を含む配信)
const isDeploy = /\bgit\s+push\b/.test(cmd) || /\bfirebase\s+deploy\b/.test(cmd);
if (!isDeploy) process.exit(0);

const root = process.cwd();
const idxPath = resolve(root, "public/index.html");
const verPath = resolve(root, "public/version.json");
// minpaku-v2(public/index.html + version.json を持つ) 以外は対象外
if (!existsSync(idxPath) || !existsSync(verPath)) process.exit(0);

let idx = "", verRaw = "";
try {
  idx = readFileSync(idxPath, "utf8");
  verRaw = readFileSync(verPath, "utf8");
} catch {
  process.exit(0);
}

const idxTokens = [...new Set(idx.match(/v\d{4}[a-z]/g) || [])];
let verToken = "";
try { verToken = String(JSON.parse(verRaw).version || "").trim(); } catch {}

const problems = [];
if (idxTokens.length === 0) {
  // 版数トークンが無いページは対象外
  process.exit(0);
}
if (idxTokens.length > 1) {
  problems.push(`index.html 内で版数が不統一: ${idxTokens.join(", ")}`);
}
const idxToken = idxTokens[0];
if (!verToken) {
  problems.push("version.json の version が読み取れません");
} else if (idxToken !== verToken) {
  problems.push(`index.html(${idxToken}) と version.json(${verToken}) が不一致 → 無限リロードの原因`);
}

if (problems.length === 0) process.exit(0);

const reason =
  "【デプロイ阻止: アセット版数の不整合】\n" +
  problems.map((p) => " - " + p).join("\n") +
  "\n\n修正手順: `node scripts/bump-version.mjs` を実行して " +
  "index.html(全 ?v= + バッジ) と version.json を1トークンに揃えてから、デプロイし直してください。";

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })
);
process.exit(0);
