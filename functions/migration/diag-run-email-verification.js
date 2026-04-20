#!/usr/bin/env node
/**
 * emailVerificationCore を直接呼んで全フィールドを出力する診断スクリプト
 *   実行: node functions/migration/diag-run-email-verification.js
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const { emailVerificationCore } = require("../scheduled/emailVerification");

async function main() {
  console.log("emailVerificationCore を呼び出し中...");
  const result = await emailVerificationCore(admin.firestore(), {
    log: {
      info: (...args) => console.log("[INFO]", ...args),
      warn: (...args) => console.warn("[WARN]", ...args),
      error: (...args) => console.error("[ERROR]", ...args),
    },
  });
  console.log("\n===== 結果 =====");
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("EXCEPTION:", e);
  process.exit(1);
});
