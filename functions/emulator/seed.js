/**
 * Firebase Emulator シードスクリプト
 * Firestore Emulator にテスト用の初期データを投入する
 * 実行: npm run emu:seed (別ターミナルで emu:start 起動後に実行)
 */

// Emulator ホストを設定してから admin を初期化する
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "minpaku-v2",
});

const db = admin.firestore();

// ========== 定数 ==========

// 物件ID（本番と同じIDを使用）
const PROPERTY_IDS = {
  terrace: "tsZybhDMcPrxqgcRy7wp",  // the Terrace 長浜 #4
  waka: "wakakusaPropertyId001",      // Pocket House WAKA-KUSA #2
  komachi: "komachiPropertyId001",    // YADO KOMACHI Hiroshima #1
  ujina: "ujinaPropertyId001",        // UJINA Pocket House #3
};

// スタッフID
const STAFF_IDS = {
  normal: "seedStaff001",
  timee: "seedTimeeStaff001",
};

// 予約ID
const BOOKING_IDS = ["seedBooking001", "seedBooking002", "seedBooking003"];

// ========== ヘルパー ==========

/** 今月の日付文字列を生成 (2026-04-XX) */
function thisMonthDate(day) {
  return `2026-04-${String(day).padStart(2, "0")}`;
}

/** 文字列日付を Date に変換 */
function toDate(str) {
  return new Date(str + "T00:00:00+09:00");
}

// ========== データ定義 ==========

async function seedStaff() {
  const batch = db.batch();

  // 通常スタッフ
  batch.set(db.collection("staff").doc(STAFF_IDS.normal), {
    name: "テスト清掃員",
    email: "cleaner@example.com",
    phone: "090-0000-0001",
    ratePerJob: 5000,
    isTimee: false,
    isOwner: false,
    active: true,
    displayOrder: 1,
    assignedPropertyIds: [PROPERTY_IDS.terrace],
    lineUserId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // タイミースタッフ
  batch.set(db.collection("staff").doc(STAFF_IDS.timee), {
    name: "タイミー太郎",
    email: "timee@example.com",
    phone: "090-0000-0002",
    ratePerJob: 0,
    isTimee: true,
    isOwner: false,
    active: true,
    displayOrder: 2,
    assignedPropertyIds: [PROPERTY_IDS.terrace],
    lineUserId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  console.log("  staff: 2件");
}

async function seedProperties() {
  const batch = db.batch();

  const commonBase = {
    active: true,
    baseWorkTime: { start: "10:30", end: "14:30" },
    type: "minpaku",
    capacity: 4,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  batch.set(db.collection("properties").doc(PROPERTY_IDS.terrace), {
    ...commonBase,
    name: "the Terrace 長浜",
    propertyNumber: 4,
    color: "#2196F3",
  });

  batch.set(db.collection("properties").doc(PROPERTY_IDS.waka), {
    ...commonBase,
    name: "Pocket House WAKA-KUSA",
    propertyNumber: 2,
    color: "#4CAF50",
  });

  batch.set(db.collection("properties").doc(PROPERTY_IDS.komachi), {
    ...commonBase,
    name: "YADO KOMACHI Hiroshima",
    propertyNumber: 1,
    color: "#FF9800",
  });

  batch.set(db.collection("properties").doc(PROPERTY_IDS.ujina), {
    ...commonBase,
    name: "UJINA Pocket House",
    propertyNumber: 3,
    color: "#9C27B0",
  });

  await batch.commit();
  console.log("  properties: 4件");
}

async function seedPropertyWorkItems() {
  await db.collection("propertyWorkItems").doc(PROPERTY_IDS.terrace).set({
    items: [
      {
        type: "cleaning_by_count",
        rateMode: "common",
        commonRates: { 1: 5000, 2: 6000, 3: 7000 },
        timeeHourlyRate: 1500,
        specialRates: [
          {
            name: "年末年始",
            addAmount: 2000,
            recurYearly: true,
            recurStart: "12-28",
            recurEnd: "01-03",
          },
        ],
      },
    ],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("  propertyWorkItems: 1件");
}

async function seedBookings() {
  const batch = db.batch();

  const bookings = [
    { id: BOOKING_IDS[0], checkIn: "2026-04-10", checkOut: "2026-04-12", guestCount: 1 },
    { id: BOOKING_IDS[1], checkIn: "2026-04-15", checkOut: "2026-04-17", guestCount: 2 },
    { id: BOOKING_IDS[2], checkIn: "2026-04-20", checkOut: "2026-04-22", guestCount: 4 },
  ];

  for (const b of bookings) {
    batch.set(db.collection("bookings").doc(b.id), {
      propertyId: PROPERTY_IDS.terrace,
      guestName: `テストゲスト (${b.guestCount}名)`,
      guestCount: b.guestCount,
      checkIn: toDate(b.checkIn),
      checkOut: toDate(b.checkOut),
      source: "Airbnb",
      status: "confirmed",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  console.log("  bookings: 3件");
}

async function seedShifts() {
  const batch = db.batch();

  // 各予約のチェックアウト日にシフトを作成
  const shiftDates = ["2026-04-12", "2026-04-17", "2026-04-22"];

  for (let i = 0; i < shiftDates.length; i++) {
    batch.set(db.collection("shifts").doc(`seedShift00${i + 1}`), {
      date: toDate(shiftDates[i]),
      propertyId: PROPERTY_IDS.terrace,
      bookingId: BOOKING_IDS[i],
      staffId: STAFF_IDS.normal,
      staffName: "テスト清掃員",
      startTime: "10:30",
      endTime: null,
      workType: "cleaning_by_count",
      status: "assigned",
      assignMethod: "manual",
      checklistId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  console.log("  shifts: 3件");
}

async function seedLaundry() {
  const batch = db.batch();

  // isReimbursable=true × 2件 (計3000円)、isReimbursable=false × 1件 (1500円)
  const records = [
    { id: "seedLaundry001", date: "2026-04-12", amount: 1500, isReimbursable: true },
    { id: "seedLaundry002", date: "2026-04-17", amount: 1500, isReimbursable: true },
    { id: "seedLaundry003", date: "2026-04-22", amount: 1500, isReimbursable: false },
  ];

  for (const r of records) {
    batch.set(db.collection("laundry").doc(r.id), {
      date: toDate(r.date),
      staffId: STAFF_IDS.normal,
      propertyId: PROPERTY_IDS.terrace,
      amount: r.amount,
      isReimbursable: r.isReimbursable,
      sheets: 2,
      memo: "シードデータ",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  console.log("  laundry: 3件 (reimbursable×2=3000円, non-reimbursable×1=1500円)");
}

async function seedSettings() {
  await db.collection("settings").doc("notifications").set({
    channels: {},
    enableLine: false,
    enableEmail: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("  settings/notifications: 1件");
}

// ========== メイン ==========

async function main() {
  console.log("=== Firestore Emulator シード開始 ===");
  console.log(`  接続先: ${process.env.FIRESTORE_EMULATOR_HOST}`);

  try {
    await seedStaff();
    await seedProperties();
    await seedPropertyWorkItems();
    await seedBookings();
    await seedShifts();
    await seedLaundry();
    await seedSettings();

    console.log("=== シード完了 ===");
    console.log("  合計: staff×2, properties×4, propertyWorkItems×1, bookings×3, shifts×3, laundry×3, settings×1");
  } catch (err) {
    console.error("シードエラー:", err);
    process.exit(1);
  }

  process.exit(0);
}

main();
