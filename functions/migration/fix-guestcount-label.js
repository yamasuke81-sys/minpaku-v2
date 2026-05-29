// 全物件の宿泊者名簿フォームから「宿泊人数（大人）」「Number of Guests (Adults)」等の
// guestCount ラベル上書きを除去 (新ラベル「宿泊人数」/「Number of Guests」に統一)
//
// 対象パターン:
//   1) 旧形式: customFormFields[] 内の { id: "guestCount", label: "...大人..." } の label を更新
//   2) 新形式: formFieldConfig.overrides.guestCount.{labelOverride,labelEnOverride} を削除
//      (削除すれば STANDARD_FORM_FIELDS のデフォルト=新ラベルが使われる)
//
// 実行: node fix-guestcount-label.js          (dry-run)
//       node fix-guestcount-label.js --apply  (本適用)

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const LEGACY_LABEL_PATTERNS = [/大人/, /成人/, /성인/, /\(Adults\)/i];

const isLegacy = (s) => typeof s === "string" && LEGACY_LABEL_PATTERNS.some(re => re.test(s));

(async () => {
  const snap = await db.collection("properties").get();
  let touched = 0;

  for (const doc of snap.docs) {
    const p = doc.data();
    const updates = {};
    const reasons = [];

    // --- パターン1: 旧形式 customFormFields[] ---
    if (Array.isArray(p.customFormFields)) {
      let changed = false;
      const next = p.customFormFields.map(f => {
        if (f && f.id === "guestCount") {
          const nf = { ...f };
          if (isLegacy(f.label))   { nf.label = "宿泊人数"; changed = true; }
          if (isLegacy(f.labelEn)) { nf.labelEn = "Number of Guests"; changed = true; }
          return nf;
        }
        return f;
      });
      if (changed) {
        updates.customFormFields = next;
        reasons.push("customFormFields[guestCount].label");
      }
    }

    // --- パターン2: 新形式 formFieldConfig.overrides.guestCount ---
    const ov = p.formFieldConfig && p.formFieldConfig.overrides && p.formFieldConfig.overrides.guestCount;
    if (ov && (isLegacy(ov.labelOverride) || isLegacy(ov.labelEnOverride))) {
      const nextOv = { ...ov };
      if (isLegacy(nextOv.labelOverride))   delete nextOv.labelOverride;
      if (isLegacy(nextOv.labelEnOverride)) delete nextOv.labelEnOverride;
      // override が空オブジェクトになったらキーごと削除
      const isEmpty = Object.keys(nextOv).length === 0;
      const nextOverrides = { ...p.formFieldConfig.overrides };
      if (isEmpty) delete nextOverrides.guestCount;
      else nextOverrides.guestCount = nextOv;
      updates["formFieldConfig.overrides"] = nextOverrides;
      reasons.push("formFieldConfig.overrides.guestCount.labelOverride");
    }

    if (Object.keys(updates).length) {
      touched++;
      console.log(`[${APPLY ? "APPLY" : "DRY"}] ${doc.id} (${p.name || "-"}): ${reasons.join(", ")}`);
      if (APPLY) await doc.ref.update(updates);
    }
  }

  console.log(`\n対象物件: ${touched}件 ${APPLY ? "更新済" : "(dry-run。--apply で本適用)"}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
