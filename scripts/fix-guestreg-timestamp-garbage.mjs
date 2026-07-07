// fix-guestreg-timestamp-garbage — guestRegistrations の createdAt/submittedAt ゴミ修復
//
// 背景 (audit gap #19):
//   guest-form.html が FieldValue.serverTimestamp() を含むデータを JSON 化して PUT し、
//   guest-edit.js の update() が createdAt/submittedAt を
//   {_delegate:{_methodName:"FieldValue.serverTimestamp"}} という「map 型のゴミ」で上書きしてしまった。
//   本来これらは Firestore Timestamp 型であるべきで、map 型になると createdAt ソート/フィルタが静かに壊れる。
//   (guest-edit.js の PUT 除外リストで新規発生は止めたが、既に汚染された doc は残る)
//
// このスクリプト:
//   guestRegistrations 全走査で createdAt / submittedAt が「Timestamp でない object (map型ゴミ)」の doc を検出し、
//   doc のメタデータ createTime (= ドキュメント作成時刻) から Timestamp を復元する。
//   ・既定は dry-run: 検出リストを表示するだけ (書き込みしない)
//   ・--apply 指定時のみ書き込む
//
// 実行 (レビュー担当が行う):
//   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\minpaku-v2-serviceAccount.json"
//   node scripts/fix-guestreg-timestamp-garbage.mjs           # dry-run (検出のみ)
//   node scripts/fix-guestreg-timestamp-garbage.mjs --apply    # 実際に修復
//
import admin from "firebase-admin";
if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const apply = process.argv.includes("--apply");

// 値が「正常な Timestamp」か判定する。
//   - Firestore Timestamp インスタンス (toDate 関数を持つ) → 正常
//   - null / undefined → 未設定 (ゴミではない・対象外)
//   - それ以外の object (プレーンな map / {_delegate:...} 等) → ゴミ
function classify(v) {
  if (v === null || v === undefined) return "empty";
  if (v instanceof admin.firestore.Timestamp) return "ok";
  if (typeof v === "object" && typeof v.toDate === "function") return "ok"; // 念のため duck-typing も許容
  if (typeof v === "object") return "garbage"; // map 型ゴミ (_delegate など)
  // 文字列や数値も本来ここには来ない想定だが、Timestamp でなければゴミ扱いにはしない (安全側)
  return "other";
}

async function main() {
  const snap = await db.collection("guestRegistrations").get();
  console.log(`guestRegistrations: 全 ${snap.size} 件を走査`);

  const targets = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const fixes = {};
    let hasGarbage = false;

    for (const field of ["createdAt", "submittedAt"]) {
      const kind = classify(data[field]);
      if (kind === "garbage") {
        hasGarbage = true;
        // doc.createTime (メタデータ) から復元。createTime は必ず Timestamp。
        fixes[field] = doc.createTime || admin.firestore.FieldValue.serverTimestamp();
      }
    }

    if (hasGarbage) {
      targets.push({ id: doc.id, guestName: data.guestName || "(名前なし)", checkIn: data.checkIn || "-", fixes, createTime: doc.createTime });
    }
  }

  if (targets.length === 0) {
    console.log("\n✅ map 型ゴミの createdAt/submittedAt を持つ doc は見つかりませんでした。");
    process.exit(0);
  }

  console.log(`\n=== 検出: ${targets.length} 件 (createdAt/submittedAt が map 型ゴミ) ===`);
  for (const t of targets) {
    const cols = Object.keys(t.fixes).join(", ");
    const restore = t.createTime ? t.createTime.toDate().toISOString() : "(serverTimestamp)";
    console.log(`  ${t.id}  ${t.guestName} / CI:${t.checkIn}  修復対象:[${cols}] → createTime=${restore}`);
  }

  if (!apply) {
    console.log(`\n(dry-run。実際に修復するには: node scripts/fix-guestreg-timestamp-garbage.mjs --apply)`);
    process.exit(0);
  }

  console.log(`\n--apply 指定 → 修復を実行します...`);
  let done = 0;
  for (const t of targets) {
    await db.collection("guestRegistrations").doc(t.id).update(t.fixes);
    done++;
  }
  console.log(`\n✅ ${done} 件の createdAt/submittedAt を createTime から復元しました。`);
  process.exit(0);
}

main().catch((e) => {
  console.error("エラー:", e);
  process.exit(1);
});
