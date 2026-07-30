#!/usr/bin/env node
/**
 * OTA下書き機能（キーボックス送信予約 → Airbnb/Booking の下書き作成）のスイッチを確認・変更する。
 *
 * 使い方（NODE_PATH に firebase-admin 入りの node_modules を渡す）:
 *   NODE_PATH=../minpaku-v2-yadozei/scripts/node_modules node scripts/ota-reply-config.mjs           # 現在値を表示
 *   NODE_PATH=... node scripts/ota-reply-config.mjs on                                                # 両OTA有効
 *   NODE_PATH=... node scripts/ota-reply-config.mjs off                                               # 全停止
 *   NODE_PATH=... node scripts/ota-reply-config.mjs airbnb-only                                       # Airbnbだけ
 *
 * settings/otaAutoReply のフィールド:
 *   enabled … マスタースイッチ（false で完全に不活性）
 *   airbnb / booking … OTA別スイッチ（明示 false で停止）
 *   mode … ★廃止。2026-07-31 以降ワーカーは常に「下書きを作って残す」だけで、送信は人が押す。
 */
import admin from "firebase-admin";

admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const ref = db.collection("settings").doc("otaAutoReply");

const PRESETS = {
  on: { enabled: true, airbnb: true, booking: true },
  off: { enabled: false, airbnb: false, booking: false },
  "airbnb-only": { enabled: true, airbnb: true, booking: false },
  "booking-only": { enabled: true, airbnb: false, booking: true },
};

const arg = (process.argv[2] || "").toLowerCase();

const show = (d) => {
  const on = (v) => (v === false ? "停止" : v ? "有効" : "未設定");
  console.log(`  マスタースイッチ : ${d.enabled ? "有効" : "停止"}`);
  console.log(`  Airbnb           : ${on(d.airbnb)}`);
  console.log(`  Booking.com      : ${on(d.booking)}`);
  console.log(`  動作             : 下書きを作って残すのみ（送信は人が押す）`);
};

const before = (await ref.get()).data() || {};
console.log("現在の設定:");
show(before);

if (!arg) {
  console.log(`\n変更するには: ${Object.keys(PRESETS).join(" | ")} のいずれかを引数に渡してください`);
} else if (!PRESETS[arg]) {
  console.error(`\n未知の指定「${arg}」。使えるのは: ${Object.keys(PRESETS).join(" | ")}`);
  process.exitCode = 1;
} else {
  // mode は廃止フィールド。残っていると「テスト中/本番送信」と誤解されるので消す。
  await ref.set(
    { ...PRESETS[arg], mode: admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  console.log(`\n→「${arg}」に変更しました:`);
  show((await ref.get()).data() || {});
}
