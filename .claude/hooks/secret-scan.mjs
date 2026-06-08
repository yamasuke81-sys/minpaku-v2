#!/usr/bin/env node
// git push 前に、push予定の差分へ秘密情報が混入していないか検査するフック。
// 検出したら exit 2 で push をブロックする。スクリプト自身のエラーでは
// 作業を止めない（fail-open）。
import { execSync } from "node:child_process";

// --- stdin(JSON) を読む。git push 以外なら何もしない ---
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

let cmd = "";
try {
  cmd = JSON.parse(raw || "{}")?.tool_input?.command ?? "";
} catch {
  cmd = "";
}
// matcher/if でも絞るが、念のためここでも git push のみ対象にする
if (!/\bgit\b[\s\S]*\bpush\b/.test(cmd)) process.exit(0);

// --- push予定の差分を取得 ---
function sh(c) {
  return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
let diff = "";
try {
  let range = "";
  try {
    const up = sh("git rev-parse --abbrev-ref --symbolic-full-name @{u}").trim();
    if (up) range = `${up}..HEAD`;
  } catch {
    /* upstream 未設定なら全コミットを対象 */
  }
  diff = range ? sh(`git diff ${range}`) : sh("git log -p");
} catch {
  // git が使えない等は止めない
  process.exit(0);
}
if (!diff) process.exit(0);

// --- 秘密情報パターン ---
const patterns = [
  { name: "Anthropic APIキー", re: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: "Google APIキー", re: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: "GitHub トークン", re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "秘密鍵ブロック", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "サービスアカウント private_key", re: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: "Slack トークン", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  // 汎用: token/secret/password/apikey への長い文字列代入（プレースホルダは除外）
  {
    name: "トークンらしき代入",
    re: /(?:api[_-]?token|api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
  },
];
// プレースホルダ判定（誤検知除外）
const placeholder = /(your[_-]|example|dummy|placeholder|xxxx|<[^>]+>|changeme|\.\.\.|process\.env\.|functions\.config\()/i;

const hits = [];
// 追加行(+)のみ検査
for (const line of diff.split("\n")) {
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  const body = line.slice(1);
  for (const p of patterns) {
    if (p.re.test(body) && !placeholder.test(body)) {
      const masked = body.trim().replace(/[A-Za-z0-9_\-]{8,}/g, (m) => m.slice(0, 4) + "***");
      hits.push(`  - [${p.name}] ${masked.slice(0, 120)}`);
    }
  }
}

if (hits.length) {
  console.error(
    "🚫 秘密情報の混入の可能性を検出したため push をブロックしました。\n" +
      [...new Set(hits)].join("\n") +
      "\n\n対応: 値を .env / 環境変数 / functions.config() に移し、ソースにはプレースホルダのみ残してください。\n" +
      "誤検知の場合は該当行を確認のうえ、必要なら secret-scan.mjs のパターンを調整してください。"
  );
  process.exit(2); // push をブロック
}
process.exit(0);
