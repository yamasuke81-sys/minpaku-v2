// LINE 消費状況と bot 割当確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

async function getQuota(token) {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/quota/consumption", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const consumption = await res.json();
    const maxRes = await fetch("https://api.line.me/v2/bot/message/quota", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const max = await maxRes.json();
    return { used: consumption.totalUsage, max: max.value, error: consumption.message || max.message };
  } catch (e) {
    return { error: e.message };
  }
}

(async () => {
  const notif = await db.collection("settings").doc("notifications").get();
  const s = notif.data() || {};
  console.log("ownerLineChannels[]:");
  for (const ch of s.ownerLineChannels || []) {
    console.log(`  ${ch.name || "(no name)"}: token=${ch.token ? ch.token.slice(0, 8) + "..." : "✗"} userId=${ch.userId || "✗"}`);
    if (ch.token) {
      const q = await getQuota(ch.token);
      console.log(`    quota: used=${q.used} max=${q.max} remaining=${q.max - q.used}`);
    }
  }
  console.log("groupLineChannels[]:");
  for (const ch of s.groupLineChannels || []) {
    console.log(`  ${ch.name || "(no name)"}: token=${ch.token ? ch.token.slice(0, 8) + "..." : "✗"} groupId=${ch.groupId || "✗"}`);
    if (ch.token) {
      const q = await getQuota(ch.token);
      console.log(`    quota: used=${q.used} max=${q.max} remaining=${q.max - q.used}`);
    }
  }
  console.log(`\n旧 lineChannelToken: ${s.lineChannelToken ? s.lineChannelToken.slice(0, 8) + "..." : "(未設定)"}`);
  console.log(`旧 lineToken: ${s.lineToken ? s.lineToken.slice(0, 8) + "..." : "(未設定)"}`);
  if (s.lineChannelToken) {
    const q = await getQuota(s.lineChannelToken);
    console.log(`  lineChannelToken quota: used=${q.used} max=${q.max} remaining=${q.max - q.used}`);
  }

  console.log("\n=== settings/notifications 全キー (prefix) ===");
  const keys = Object.keys(s).sort();
  console.log(keys.filter(k => k.toLowerCase().includes("line") || k.toLowerCase().includes("channel") || k.toLowerCase().includes("owner") || k.toLowerCase().includes("group")).join("\n  "));

  // backup doc
  const bk = await db.collection("settings").doc("notifications_backup_20260419").get();
  if (bk.exists) {
    console.log("\n=== backup doc 存在 ===");
    const bs = bk.data();
    console.log(`  lineChannelToken: ${bs.lineChannelToken ? bs.lineChannelToken.slice(0, 8) + "..." : "(未設定)"}`);
    if (bs.lineChannelToken && bs.lineChannelToken !== s.lineChannelToken) {
      console.log("  (現行と異なる) backup 側の quota:");
      const q = await getQuota(bs.lineChannelToken);
      console.log(`    used=${q.used} max=${q.max} remaining=${q.max - q.used}`);
    }
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
