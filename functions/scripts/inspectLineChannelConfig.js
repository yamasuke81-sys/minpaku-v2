// LINE チャネル設定確認スクリプト
// 使い方: node functions/scripts/inspectLineChannelConfig.js
// (GOOGLE_APPLICATION_CREDENTIALS またはサービスアカウントキーが必要)

const admin = require("firebase-admin");
admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

// トークンを一部マスク (先頭10文字 + ... + 末尾4文字)
function maskToken(token) {
  if (!token) return "(未設定)";
  if (token.length <= 16) return token.slice(0, 4) + "...";
  return token.slice(0, 10) + "..." + token.slice(-4);
}

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";
  const doc = await db.collection("properties").doc(PROPERTY_ID).get();

  if (!doc.exists) {
    console.error("物件ドキュメントが見つかりません:", PROPERTY_ID);
    process.exit(1);
  }

  const d = doc.data();
  console.log("=== 物件基本情報 ===");
  console.log("  name:", d.name);
  console.log("  propertyId:", PROPERTY_ID);

  // lineChannels 配列の全要素を出力
  const channels = Array.isArray(d.lineChannels) ? d.lineChannels : [];
  console.log(`\n=== lineChannels (${channels.length} 件) ===`);

  if (channels.length === 0) {
    console.log("  ※ lineChannels が未設定です（空配列または未定義）");
  }

  channels.forEach((ch, i) => {
    console.log(`\n  [${i}] ${ch.name || "(name未設定)"}`);
    console.log(`    token         : ${maskToken(ch.token)}`);
    console.log(`    groupId       : ${ch.groupId || "(未設定)"}`);
    console.log(`    ownerLineUserId: ${ch.ownerLineUserId !== undefined ? JSON.stringify(ch.ownerLineUserId) : "(フィールド自体なし)"}`);
    console.log(`    basicId       : ${ch.basicId || "(未設定)"}`);
    console.log(`    enabled       : ${ch.enabled !== undefined ? ch.enabled : "(未設定=trueとみなす)"}`);
    console.log(`    botInfo       : ${ch.botInfo ? JSON.stringify(ch.botInfo) : "(未設定)"}`);

    // ownerLineUserId の状態診断
    if (ch.ownerLineUserId === undefined) {
      console.log(`    ⚠  ownerLineUserId: フィールド自体が存在しません → propOwnerUserId = null → グローバルUserIDにフォールバック`);
    } else if (ch.ownerLineUserId === "") {
      console.log(`    ⚠  ownerLineUserId: 空文字で保存されています → || null で null になりグローバルUserIDにフォールバック`);
    } else if (ch.ownerLineUserId && !ch.ownerLineUserId.startsWith("U")) {
      console.log(`    ⚠  ownerLineUserId: "U" で始まっていません。LINE User ID の形式を確認してください`);
    } else {
      console.log(`    ✓  ownerLineUserId: 正常 (${ch.ownerLineUserId.slice(0, 10)}...)`);
    }
  });

  // グローバル通知設定も確認
  console.log("\n=== グローバル通知設定 (settings/notifications) ===");
  const settingsDoc = await db.collection("settings").doc("notifications").get();
  if (!settingsDoc.exists) {
    console.log("  (未設定)");
  } else {
    const s = settingsDoc.data();
    console.log("  lineOwnerUserId:", s.lineOwnerUserId ? s.lineOwnerUserId.slice(0, 10) + "..." : "(未設定)");
    console.log("  lineChannelToken:", maskToken(s.lineChannelToken));

    // ownerLineChannels があれば表示
    const ownerChs = Array.isArray(s.ownerLineChannels) ? s.ownerLineChannels : [];
    if (ownerChs.length > 0) {
      console.log(`  ownerLineChannels (${ownerChs.length} 件):`);
      ownerChs.forEach((oc, i) => {
        console.log(`    [${i}] token=${maskToken(oc.token)}, userId=${oc.userId ? oc.userId.slice(0, 10) + "..." : "(未設定)"}`);
      });
    }
  }

  // channelOverrides の pre_inspection_done を確認
  // 主要通知キーの channelOverrides を全て出力
  const checkKeys = ["recruit_start", "cleaning_done", "pre_inspection_done", "booking_change", "booking_cancel", "keybox_send"];
  for (const key of checkKeys) {
    console.log(`\n=== channelOverrides.${key} ===`);
    const o = d.channelOverrides && d.channelOverrides[key];
    if (!o) {
      console.log("  (未設定 → デフォルト全 OFF 動作)");
    } else {
      console.log("  ", JSON.stringify(o, null, 2).replace(/\n/g, "\n  "));
    }
  }
  console.log("\n=== channelOverrides.pre_inspection_done (再表示) ===");
  const ov = d.channelOverrides && d.channelOverrides.pre_inspection_done;
  if (!ov) {
    console.log("  (未設定)");
  } else {
    console.log(JSON.stringify(ov, null, 2));
  }

  // 診断サマリー
  console.log("\n=== 診断サマリー ===");
  const ch0 = channels.find(c => c && c.enabled !== false && c.token);
  if (!ch0) {
    console.log("  [問題] 有効な lineChannels エントリがありません。ownerLine は常にグローバルBotにフォールバックします。");
  } else {
    const hasOwnerUserId = ch0.ownerLineUserId && ch0.ownerLineUserId.trim().length > 0;
    if (!hasOwnerUserId) {
      console.log("  [問題] lineChannels[0].ownerLineUserId が未設定/空文字です。");
      console.log("  → notifyByKey の ownerLine 分岐で targetUserId がグローバルUserIDになり、");
      console.log("    物件別Bot(長浜清掃G通知)でグローバルUserIDに送信 → 失敗 → グローバルBot(民泊V2管理者)にフォールバック");
      console.log("  → 修正: 物件設定で「オーナー LINE User ID」に西山オーナーの UserID を入力して保存してください。");
      console.log("    西山オーナーの UserID: U57b8226bfaa... (Firestore staff/ziTig6tefnj5NvkgN4fG の lineUserId フィールドを確認)");
    } else {
      console.log("  [OK] lineChannels[0].ownerLineUserId が設定されています:", ch0.ownerLineUserId.slice(0, 14) + "...");
      console.log("  → 「長浜清掃G通知」BotがこのUserIDに送信を試みます。");
      console.log("    失敗する場合は、オーナーが「長浜清掃G通知」Botを友達追加しているか確認してください。");
    }
  }

  // staff ドキュメントから西山オーナーの lineUserId を確認
  console.log("\n=== 西山オーナーの lineUserId (staff/ziTig6tefnj5NvkgN4fG) ===");
  try {
    const staffDoc = await db.collection("staff").doc("ziTig6tefnj5NvkgN4fG").get();
    if (staffDoc.exists) {
      const st = staffDoc.data();
      console.log("  lineUserId:", st.lineUserId ? st.lineUserId.slice(0, 14) + "..." : "(未設定)");
      console.log("  name:", st.name);
      console.log("  isOwner:", st.isOwner);
    } else {
      console.log("  (スタッフドキュメントが見つかりません)");
    }
  } catch (e) {
    console.log("  取得エラー:", e.message);
  }

  process.exit(0);
})().catch(e => {
  console.error("スクリプトエラー:", e);
  process.exit(1);
});
