/**
 * yadozei-admin — 宿泊税CSV自動化のデバッグ/運用ツール (admin SDK 直叩き)
 *
 * 使い方 (scripts ディレクトリで):
 *   node yadozei-admin.mjs state                        listener heartbeat + 最近のジョブ概況
 *   node yadozei-admin.mjs jobs [n]                     最近 n 件(既定10)のジョブを表示
 *   node yadozei-admin.mjs job <docId>                  1ジョブの詳細(error 全文)
 *   node yadozei-admin.mjs enqueue <kind> <pid> <ym> [k=v ...]
 *        例: enqueue airbnb_csv_fetch <pid> 2026-05 listingId=12345678
 *            enqueue booking_csv_fetch <pid> 2026-05 bookingPropertyId=14868587
 *            enqueue yadozei_pdf_fetch <pid> 2026-05
 *   node yadozei-admin.mjs requeue <docId>              失敗ジョブを同じ内容で再投入(Discordの再実行ボタンの実体)
 *   node yadozei-admin.mjs prop <pid>                   物件の yadozei 設定を表示
 *   node yadozei-admin.mjs clean-pending               pending/processing の滞留ジョブを failed 化
 */
import admin from "firebase-admin";
import { google } from "googleapis";

if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

// listener と同じ OAuth 解決で Drive クライアントを得る
async function driveClient(senderGmail) {
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  const { clientId, clientSecret } = oauthDoc.data();
  const cols = [
    db.collection("settings").doc("gmailOAuth").collection("tokens"),
    db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
  ];
  let tok = null;
  if (senderGmail) for (const c of cols) { const s = await c.where("email", "==", senderGmail).limit(1).get(); if (!s.empty) { tok = s.docs[0].data(); break; } }
  if (!tok) for (const c of cols) { const s = await c.limit(1).get(); if (!s.empty) { tok = s.docs[0].data(); break; } }
  const oa = new google.auth.OAuth2(clientId, clientSecret);
  oa.setCredentials({ refresh_token: tok.refreshToken });
  return google.drive({ version: "v3", auth: oa });
}

const [, , cmd, ...args] = process.argv;
const ts = (t) => (t && t.toDate ? t.toDate().toISOString().replace("T", " ").slice(0, 19) : "-");

async function main() {
  if (cmd === "state") {
    const s = await db.collection("settings").doc("yadozeiListener").get();
    if (!s.exists) {
      console.log("listener heartbeat: 未記録 (settings/yadozeiListener なし)");
    } else {
      const d = s.data();
      const last = d.lastSeenAt?.toDate?.();
      const ageSec = last ? Math.round((Date.now() - last.getTime()) / 1000) : null;
      console.log(`listener: host=${d.hostName} v${d.version} lastSeen=${ts(d.lastSeenAt)} (${ageSec}秒前) alive=${ageSec != null && ageSec < 120}`);
    }
    const snap = await db.collection("yadozeiQueue").orderBy("createdAt", "desc").limit(8).get();
    console.log(`\n最近のジョブ (${snap.size}):`);
    snap.forEach((doc) => {
      const j = doc.data();
      console.log(`  [${j.status}] ${doc.id} ${j.kind} ${j.propertyName || ""} ${j.yearMonth || ""}${j.error ? " ERR=" + j.error.slice(0, 80) : ""}`);
    });
    return;
  }

  if (cmd === "jobs") {
    const n = parseInt(args[0] || "10", 10);
    const snap = await db.collection("yadozeiQueue").orderBy("createdAt", "desc").limit(n).get();
    snap.forEach((doc) => {
      const j = doc.data();
      console.log(`[${j.status}] ${doc.id} ${j.kind} ${j.propertyName || ""} ${j.yearMonth || ""} createdAt=${ts(j.createdAt)}${j.error ? "\n    ERR=" + j.error : ""}`);
    });
    return;
  }

  if (cmd === "job") {
    const doc = await db.collection("yadozeiQueue").doc(args[0]).get();
    if (!doc.exists) return console.log("ジョブが見つかりません");
    console.log(JSON.stringify(doc.data(), null, 2));
    return;
  }

  if (cmd === "prop") {
    const doc = await db.collection("properties").doc(args[0]).get();
    if (!doc.exists) return console.log("物件が見つかりません");
    const d = doc.data();
    console.log(`物件: ${d.name} (${args[0]})`);
    console.log(`senderGmail: ${d.senderGmail || "(なし)"}`);
    console.log("yadozei:", JSON.stringify(d.yadozei || null, null, 2));
    return;
  }

  if (cmd === "enqueue") {
    const [kind, pid, ym, ...kvs] = args;
    if (!kind || !pid || !ym) return console.log("usage: enqueue <kind> <pid> <ym> [k=v ...]");
    const params = {};
    for (const kv of kvs) {
      const i = kv.indexOf("=");
      if (i > 0) {
        const k = kv.slice(0, i);
        let v = kv.slice(i + 1);
        if (v === "true") v = true;
        else if (v === "false") v = false;
        params[k] = v;
      }
    }
    const propDoc = await db.collection("properties").doc(pid).get();
    const propName = propDoc.exists ? propDoc.data().name || pid : pid;
    const ref = await db.collection("yadozeiQueue").add({
      kind, propertyId: pid, propertyName: propName, yearMonth: ym, params,
      status: "pending", result: null, createdBy: "admin-tool",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt: null, completedAt: null, error: null, retries: 0,
    });
    console.log(`投入: ${ref.id} kind=${kind} property=${propName} ym=${ym} params=${JSON.stringify(params)}`);
    return;
  }

  if (cmd === "pricing-sync") {
    // pricing-sync [pid|all] [dryRun=true] [force=true]
    //   直販サイトの料金を Airbnb に追随させるジョブを即時投入する(通常は毎晩3:00に自動実行)。
    //   dryRun=true は計算とプレビュー通知だけで Firestore を書き換えない。
    //   force=true は「前回から±40%超の変動」ガードを突破する(意図した大幅改定のとき)。
    const [pidArg, ...kvs] = args;
    const params = {};
    for (const kv of kvs) {
      const i = kv.indexOf("=");
      if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1) === "false" ? false : kv.slice(i + 1) === "true" ? true : kv.slice(i + 1);
    }
    const pid = pidArg && pidArg !== "all" ? pidArg : null;
    let propName = null;
    if (pid) {
      const p = await db.collection("properties").doc(pid).get();
      if (!p.exists) { console.log("物件が見つかりません"); process.exitCode = 1; return; }
      propName = p.data().name || pid;
    }
    const ref = await db.collection("yadozeiQueue").add({
      kind: "pricing_sync", propertyId: pid, propertyName: propName,
      yearMonth: null, params, status: "pending", result: null, createdBy: "admin-tool",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt: null, completedAt: null, error: null, retries: 0,
    });
    console.log(`投入: ${ref.id} kind=pricing_sync 対象=${propName || "全宿"} params=${JSON.stringify(params)}`);
    return;
  }

  if (cmd === "pricing-roster") {
    // pricing-roster                          現在のロスター(料金同期の対象)を一覧
    // pricing-roster <pid> <listingId> [on|off]   対象を登録/更新する
    const [pid, listingId, onoff] = args;
    if (!pid) {
      const snap = await db.collection("properties").where("active", "==", true).get();
      console.log("直販料金 Airbnb同期のロスター:");
      snap.forEach((doc) => {
        const p = doc.data() || {};
        const ps = p.yadozei?.airbnb?.pricingSync;
        if (!ps) return;
        console.log(`  [${ps.enabled ? "ON " : "off"}] ${p.name} (${doc.id}) listing=${ps.listingId || "-"}`);
      });
      return;
    }
    if (!listingId) { console.log("usage: pricing-roster <pid> <listingId> [on|off]"); process.exitCode = 1; return; }
    const enabled = onoff !== "off";
    await db.collection("properties").doc(pid).set(
      { yadozei: { airbnb: { pricingSync: { enabled, listingId: String(listingId) } } } },
      { merge: true }
    );
    const p = await db.collection("properties").doc(pid).get();
    console.log(`設定: ${p.data()?.name || pid} → listing=${listingId} enabled=${enabled}`);
    return;
  }

  if (cmd === "rates") {
    // rates <pid> [n]  — 直販料金マスタと日別上書きの先頭n件を表示(同期結果の検算用)
    const [pid, nArg] = args;
    const d = await db.collection("propertyRates").doc(pid).get();
    if (!d.exists) { console.log("propertyRates が存在しません"); return; }
    console.log(JSON.stringify(d.data(), null, 2));
    const n = parseInt(nArg || "10", 10);
    const ov = await db.collection("propertyRates").doc(pid).collection("overrides").orderBy(admin.firestore.FieldPath.documentId()).limit(n).get();
    console.log(`\n日別上書き (先頭${ov.size}件 / 全${(await db.collection("propertyRates").doc(pid).collection("overrides").count().get()).data().count}件):`);
    ov.forEach((o) => console.log(`  ${o.id}: ${JSON.stringify(o.data())}`));
    return;
  }

  if (cmd === "requeue") {
    // requeue <docId> — 失敗ジョブを同じ内容でもう一度投入する。
    // Discord の「🔁 もう一度やる」ボタン(常駐bunが叩く)の実体。出先からワンタップで再実行できるようにするため。
    const src = await db.collection("yadozeiQueue").doc(args[0]).get();
    if (!src.exists) {
      console.log("ジョブが見つかりません");
      process.exitCode = 1;
      return;
    }
    const j = src.data();
    // ★2026-08-15修正: 従来は kind/propertyId/propertyName/yearMonth/params しか引き継がず、
    //   ota_message ジョブ(message/ota/guestName/guestId/bookingId/reservationCode 等が必須)を
    //   再投入すると即座に「message(本文) が空です」で落ちるバグがあった(the Terrace 長浜で実発生)。
    //   CSV/PDF系はこれらのフィールドを持たないため無害。ジョブ種別に関わらず元の内容を丸ごと引き継ぐ。
    const { status, error, retriedAt, completedAt, startedAt, retries, attempts, ...rest } = j;
    const ref = await db.collection("yadozeiQueue").add({
      ...rest,
      status: "pending", result: null, createdBy: "discord-retry", retriedFrom: args[0],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt: null, completedAt: null, error: null, retries: 0, attempts: 0,
    });
    console.log(`再投入: ${ref.id} kind=${j.kind} property=${j.propertyName || "-"} ym=${j.yearMonth || "-"}`);
    return;
  }

  if (cmd === "clean-pending") {
    const snap = await db.collection("yadozeiQueue").where("status", "in", ["pending", "processing"]).get();
    const batch = db.batch();
    snap.forEach((doc) => batch.update(doc.ref, { status: "failed", error: "admin: 手動クリーンアップ", completedAt: admin.firestore.FieldValue.serverTimestamp() }));
    if (snap.size) await batch.commit();
    console.log(`${snap.size} 件を failed 化`);
    return;
  }

  if (cmd === "lsfolder") {
    // lsfolder <folderId> [senderGmail]  — フォルダ内ファイルを名前+リンクで一覧
    const [folderId, sender] = args;
    const drive = await driveClient(sender || "yamasuke81@gmail.com");
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id, name, mimeType, webViewLink, createdTime)",
      orderBy: "createdTime desc",
      pageSize: 50,
    });
    const files = res.data.files || [];
    console.log(`フォルダ ${folderId}: ${files.length} 件`);
    for (const f of files) {
      console.log(`  ${f.name}\n    ${f.webViewLink}`);
    }
    return;
  }

  if (cmd === "catfile") {
    // catfile <driveFileId> [senderGmail] [maxLines]  — Drive の CSV を先頭 N 行表示
    const [fileId, sender, maxLines] = args;
    const drive = await driveClient(sender || "the.terrace.nagahama01@gmail.com");
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const text = Buffer.from(res.data).toString("utf8");
    const lines = text.split(/\r?\n/);
    const n = parseInt(maxLines || "12", 10);
    console.log(`総行数: ${lines.length}`);
    console.log(lines.slice(0, n).join("\n"));
    return;
  }

  console.log("unknown cmd. state|jobs|job|prop|enqueue|requeue|clean-pending|catfile");
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
