/**
 * Dispatch Listener — 常時起動 PC で動かす Firestore queue 監視デーモン
 *
 * 動作:
 *   1. dispatchQueue.where("status","==","pending") を onSnapshot で監視
 *   2. 新規 pending を検知 → status="processing" にロック
 *   3. command の種別 (kind) に応じて処理を実行
 *      - timee_post: Tampermonkey 自動入力 URL を構築 → 既定ブラウザで開く
 *   4. 完了したら status="done" (or "failed") + completedAt 記録
 *
 * 前提:
 *   - Firebase Admin SDK で認証
 *     → 環境変数 GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント JSON のパスをセット
 *       例 (PowerShell): $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
 *     または Firebase CLI ログイン状態 (firebase login:ci で取得した認証情報) でも可
 *   - Chrome / 既定ブラウザに Tampermonkey + timee-autofill.user.js が導入済
 *
 * 起動:
 *   cd C:\Users\yamas\AI_Workspace\minpaku-v2
 *   node scripts/dispatch-listener.js
 *   (バックグラウンド化: pm2 start scripts/dispatch-listener.js --name dispatch-listener)
 */

const admin = require("firebase-admin");
const { spawn } = require("child_process");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "minpaku-v2" });
}
const db = admin.firestore();

// ================== タイミー URL 構築 (Cloud Functions の buildTimeeAutofillUrl_ と同等) ==================
function buildTimeeAutofillUrl(tf, checkOut, visibility) {
  if (!tf || !tf.baseUrl || !checkOut) return null;
  const url = new URL(tf.baseUrl);
  url.searchParams.set("openExternalBrowser", "1");
  const params = new URLSearchParams();
  params.set("date", checkOut);
  if (tf.start) params.set("start", tf.start);
  if (tf.end) params.set("end", tf.end);
  if (tf.restMin != null) params.set("restMin", String(tf.restMin));
  if (tf.workers) params.set("workers", String(tf.workers));
  params.set("visibility", visibility);
  if (visibility === "group_limited" && tf.groupIds) params.set("groupIds", tf.groupIds);
  if (tf.wage) params.set("wage", String(tf.wage));
  if (tf.transport != null) params.set("transport", String(tf.transport));
  if (tf.autoMsg != null) params.set("autoMsg", tf.autoMsg ? "true" : "false");
  if (tf.autoMsgTarget) params.set("autoMsgTarget", tf.autoMsgTarget);
  return `${url.toString()}#${params.toString()}`;
}

// ================== 既定ブラウザで URL を開く ==================
function openInBrowser(url) {
  // shell:true で OS デフォルトシェル経由 (Windows: cmd.exe, *nix: sh)
  // URL を直接シェルに渡すので簡単。引用符のエスケープは Windows の "" + 二重引用符で対応
  let cmdline;
  if (process.platform === "win32") {
    // start の第1引数 "" はタイトル指定 (省略不可)。URL は引用符で囲む
    cmdline = `start "" "${url}"`;
  } else if (process.platform === "darwin") {
    cmdline = `open "${url}"`;
  } else {
    cmdline = `xdg-open "${url}"`;
  }
  const child = spawn(cmdline, [], { detached: true, stdio: "ignore", shell: true });
  child.unref();
}

// ================== ジョブ処理 ==================
async function handleJob(docId, data) {
  const ref = db.collection("dispatchQueue").doc(docId);
  console.log(`[listener] processing ${docId} kind=${data.kind} command=${data.command}`);

  // ロック (already-locked なら何もせず終了)
  try {
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) throw new Error("doc disappeared");
      if (cur.data().status !== "pending") throw new Error("not pending");
      tx.update(ref, {
        status: "processing",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.log(`[listener] skip ${docId}: ${e.message}`);
    return;
  }

  try {
    if (data.kind === "timee_post") {
      await handleTimeePost(data);
    } else {
      throw new Error(`unknown kind: ${data.kind}`);
    }
    await ref.update({
      status: "done",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[listener] done ${docId}`);
  } catch (e) {
    console.error(`[listener] failed ${docId}:`, e.message);
    await ref.update({
      status: "failed",
      error: String(e.message || e).slice(0, 500),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function handleTimeePost(data) {
  const { bookingId, params } = data;
  const visibility = params?.visibility;
  const checkoutDate = params?.checkoutDate;
  if (!bookingId || !visibility || !checkoutDate) {
    throw new Error("missing required params (bookingId/visibility/checkoutDate)");
  }
  // 物件マスタから timeeAutofill 設定を取得
  const bDoc = await db.collection("bookings").doc(bookingId).get();
  if (!bDoc.exists) throw new Error(`booking not found: ${bookingId}`);
  const propertyId = bDoc.data().propertyId;
  if (!propertyId) throw new Error("booking has no propertyId");
  const pDoc = await db.collection("properties").doc(propertyId).get();
  if (!pDoc.exists) throw new Error(`property not found: ${propertyId}`);
  const tf = pDoc.data().timeeAutofill;
  if (!tf || !tf.baseUrl) {
    throw new Error("property.timeeAutofill 未設定 (タイミー求人テンプレ URL がない)");
  }

  const url = buildTimeeAutofillUrl(tf, checkoutDate, visibility);
  if (!url) throw new Error("buildTimeeAutofillUrl が null を返した");
  console.log(`[listener] opening: ${url.slice(0, 80)}...`);
  openInBrowser(url);

  // bookings に「タイミー募集中」状態をセット
  try {
    await db.collection("bookings").doc(bookingId).update({
      timeeStatus: "posted",
      timeePostedAt: admin.firestore.FieldValue.serverTimestamp(),
      timeePostedVisibility: visibility,
    });
  } catch (e) {
    console.warn(`[listener] timeeStatus 更新失敗 (${bookingId}):`, e.message);
  }
}

// ================== onSnapshot 監視 ==================
console.log("[listener] starting — watching dispatchQueue (status=pending)");
db.collection("dispatchQueue")
  .where("status", "==", "pending")
  .onSnapshot(
    async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        await handleJob(change.doc.id, change.doc.data());
      }
    },
    (err) => {
      console.error("[listener] snapshot error:", err.message);
    }
  );

// graceful shutdown
process.on("SIGINT", () => {
  console.log("[listener] SIGINT — shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[listener] SIGTERM — shutting down");
  process.exit(0);
});
