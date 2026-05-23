/**
 * 直前点検テンプレート seed スクリプト
 *
 * - The Terras 長浜（tsZybhDMcPrxqgcRy7wp）に 5エリアの直前点検テンプレを投入
 * - 全 active 物件に未作成なら areas=[] の空 _pre_inspection テンプレを作成
 *
 * 冪等性:
 *   - _pre_inspection が既存かつ areas が空でない場合は上書きスキップ
 *   - FORCE=1 で強制上書き
 *
 * 実行方法:
 *   cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
 *   node scripts/seedPreInspectionTemplate.js          # 通常実行
 *   FORCE=1 node scripts/seedPreInspectionTemplate.js  # 強制上書き
 */

const admin = require("firebase-admin");

const PROJECT_ID = "minpaku-v2";
const FORCE = process.env.FORCE === "1";

// The Terras 長浜の propertyId
const TERRACE_PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";

admin.initializeApp({
  projectId: PROJECT_ID,
  credential: admin.credential.applicationDefault()
});
const db = admin.firestore();

// ===== The Terras 長浜 直前点検テンプレートデータ =====
// スキーマ: area > taskTypes[] > subCategories[] > directItems[]
// L1=エリア、L2=タスクタイプ（「実施」）、L3=サブカテゴリ（「項目」）、L4=directItems（実項目）

const terracePreInspectionAreas = [
  {
    id: "pre-area-terrace",
    name: "テラス",
    taskTypes: [
      {
        id: "pre-task-terrace-exec",
        name: "実施",
        subCategories: [
          {
            id: "pre-sub-terrace-items",
            name: "項目",
            directItems: [
              { id: "pre-item-terrace-cobweb", name: "手すりのくもの巣・鳥のフンの除去", required: true, photoRequired: false },
              { id: "pre-item-terrace-furniture", name: "テーブル・イスの掃除", required: true, photoRequired: false }
            ]
          }
        ]
      }
    ]
  },
  {
    id: "pre-area-balcony2f",
    name: "2階ベランダ",
    taskTypes: [
      {
        id: "pre-task-balcony2f-exec",
        name: "実施",
        subCategories: [
          {
            id: "pre-sub-balcony2f-items",
            name: "項目",
            directItems: [
              { id: "pre-item-balcony2f-cobweb", name: "手すりのくもの巣・鳥のフンの除去", required: true, photoRequired: false },
              { id: "pre-item-balcony2f-furniture", name: "テーブル・イスの掃除", required: true, photoRequired: false }
            ]
          }
        ]
      }
    ]
  },
  {
    id: "pre-area-perimeter",
    name: "建物の周囲",
    taskTypes: [
      {
        id: "pre-task-perimeter-exec",
        name: "実施",
        subCategories: [
          {
            id: "pre-sub-perimeter-items",
            name: "項目",
            directItems: [
              { id: "pre-item-perimeter-leaves", name: "落ち葉などの掃き掃除", required: true, photoRequired: false },
              { id: "pre-item-perimeter-insects", name: "虫の死骸の除去", required: true, photoRequired: false }
            ]
          }
        ]
      }
    ]
  },
  {
    id: "pre-area-interior",
    name: "室内",
    taskTypes: [
      {
        id: "pre-task-interior-exec",
        name: "実施",
        subCategories: [
          {
            id: "pre-sub-interior-items",
            name: "項目",
            directItems: [
              { id: "pre-item-interior-floor", name: "掃除機 or クイックルワイパーで床の掃除", required: true, photoRequired: false },
              { id: "pre-item-interior-pest", name: "室内の害虫チェック（クッションの下なども確認）", required: true, photoRequired: false },
              { id: "pre-item-interior-amenity", name: "タオル・バスタオル・アメニティの確認", required: true, photoRequired: false }
            ]
          }
        ]
      }
    ]
  },
  {
    id: "pre-area-entrance",
    name: "玄関",
    taskTypes: [
      {
        id: "pre-task-entrance-exec",
        name: "実施",
        subCategories: [
          {
            id: "pre-sub-entrance-items",
            name: "項目",
            directItems: [
              { id: "pre-item-entrance-mat", name: "玄関マットをはたく", required: true, photoRequired: false },
              { id: "pre-item-entrance-groove", name: "玄関ドアの溝の掃き掃除", required: true, photoRequired: false }
            ]
          }
        ]
      }
    ]
  }
];

async function seedForProperty(propertyId, propertyName, areas) {
  const docId = `${propertyId}_pre_inspection`;
  const ref = db.collection("checklistTemplates").doc(docId);
  const existing = await ref.get();

  if (existing.exists) {
    const data = existing.data();
    const hasAreas = Array.isArray(data.areas) && data.areas.length > 0;
    if (hasAreas && !FORCE) {
      console.log(`[スキップ] ${propertyName}(${docId}) は既存かつ areas あり。FORCE=1 で上書き可能`);
      return;
    }
    if (FORCE) {
      console.log(`[強制上書き] ${propertyName}(${docId})`);
    } else {
      console.log(`[上書き] ${propertyName}(${docId}) は既存だが areas=[] のため投入`);
    }
  } else {
    console.log(`[作成] ${propertyName}(${docId})`);
  }

  await ref.set({
    propertyId,
    workType: "pre_inspection",
    areas,
    version: 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`  ✓ 完了`);
}

async function main() {
  console.log("=== 直前点検テンプレート seed スクリプト ===");
  console.log("プロジェクト:", PROJECT_ID);
  if (FORCE) console.log("※ FORCE モード（既存を強制上書き）");

  // The Terras 長浜に直前点検テンプレを投入
  console.log("\n--- The Terras 長浜 直前点検テンプレート投入 ---");
  await seedForProperty(TERRACE_PROPERTY_ID, "The Terras 長浜", terracePreInspectionAreas);

  // 全 active 物件に空テンプレを作成
  console.log("\n--- 全アクティブ物件への空テンプレ作成 ---");
  const propertiesSnap = await db.collection("properties").where("active", "==", true).get();
  console.log(`アクティブ物件数: ${propertiesSnap.size}`);

  for (const doc of propertiesSnap.docs) {
    const pid = doc.id;
    const pname = doc.data().name || pid;

    if (pid === TERRACE_PROPERTY_ID) {
      // The Terras 長浜は上で処理済み（実データあり）
      console.log(`[スキップ] ${pname}(${pid}) は上で投入済み`);
      continue;
    }

    // 空テンプレ（areas=[]）で作成
    await seedForProperty(pid, pname, []);
  }

  console.log("\n=== 完了 ===");
}

main().catch(e => {
  console.error("seed スクリプトエラー:", e);
  process.exit(1);
});
