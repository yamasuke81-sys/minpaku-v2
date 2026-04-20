// S1: formFieldConfig.overrides を一時的に書き込み → 戻す
//   引数: "apply" / "reset"
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const PID = "tsZybhDMcPrxqgcRy7wp";
const action = process.argv[2] || "apply";

const TEST_OVERRIDES = {
  passportNumber: { hidden: true },
  guestName: { labelOverride: "ご予約代表者 (E2E)", requiredOverride: true },
  purpose: { hidden: true },
};

(async () => {
  const ref = db.collection("properties").doc(PID);
  const doc = await ref.get();
  if (!doc.exists) { console.error("物件未検出"); process.exit(1); }

  const cur = doc.data().formFieldConfig || {};
  console.log(`現在の formFieldConfig.overrides: ${JSON.stringify(cur.overrides || {})}`);

  if (action === "apply") {
    await ref.update({ "formFieldConfig.overrides": TEST_OVERRIDES });
    console.log("→ テスト用 overrides 書き込み完了");
    console.log(JSON.stringify(TEST_OVERRIDES, null, 2));
  } else if (action === "reset") {
    await ref.update({ "formFieldConfig.overrides": FV.delete() });
    console.log("→ overrides 削除 (元状態に復元)");
  } else {
    console.error(`unknown action: ${action}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
