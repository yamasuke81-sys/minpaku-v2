/**
 * 川上 S1→S7 検証用データ一括取得 (readonly)
 *
 * the Terrace 長浜 (propertyId=tsZybhDMcPrxqgcRy7wp) を主対象に
 * S1 iCal同期 / S1 bookings / S2 recruitments / S2 shifts /
 * S5 checklists / S6 laundry / S7 invoices / S5 cleaningPhotos /
 * サブオーナー / 通知設定 を全部 console.log に出す。
 *
 * 書き込みは一切しない。
 *
 * 実行: node functions/migration/kawakami-snapshot.js
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

// 対象物件
const TARGET_PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜

// 日付ユーティリティ
const today = new Date();
today.setHours(0, 0, 0, 0);
const todayIso = today.toISOString().slice(0, 10); // YYYY-MM-DD
const thirtyDaysAgo = new Date(today);
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

// 件数サマリ
const summary = {};

// セクションヘッダ出力
function header(tag) {
  console.log(`\n==== ${tag} ====`);
}

// Timestamp/Date/string を ISO 文字列風に正規化
function toDateStr(v) {
  if (!v) return null;
  try {
    if (typeof v === "string") return v;
    if (v.toDate) return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object" && typeof v._seconds === "number") {
      return new Date(v._seconds * 1000).toISOString();
    }
  } catch (_) {}
  return String(v);
}

// date 型のフィルタ用 Timestamp
const todayTs = admin.firestore.Timestamp.fromDate(today);
const thirtyDaysAgoTs = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);

async function runSection(tag, fn) {
  header(tag);
  try {
    const count = await fn();
    summary[tag] = count;
  } catch (e) {
    console.log(`(collection missing or error: ${e.message})`);
    summary[tag] = "error";
  }
}

(async () => {
  // 1. S1 iCal同期設定
  await runSection("[S1] settings/syncConfig + settings/icalFeeds", async () => {
    let cnt = 0;

    // syncConfig ドキュメント
    const sc = await db.collection("settings").doc("syncConfig").get();
    if (sc.exists) {
      console.log("-- settings/syncConfig --");
      console.log(JSON.stringify(sc.data(), null, 2));
      cnt++;
    } else {
      console.log("(settings/syncConfig 不在)");
    }

    // icalFeeds: ドキュメント形式のケース
    const ic = await db.collection("settings").doc("icalFeeds").get();
    if (ic.exists) {
      console.log("\n-- settings/icalFeeds (document) --");
      const data = ic.data() || {};
      const feeds = Array.isArray(data.feeds) ? data.feeds : Object.values(data);
      console.log(`total feeds: ${feeds.length}`);
      for (const f of feeds) {
        console.log(JSON.stringify({
          url: f?.url,
          propertyId: f?.propertyId,
          lastSync: toDateStr(f?.lastSync),
          enabled: f?.enabled,
          source: f?.source,
        }));
      }
      cnt += feeds.length;
    } else {
      // icalFeeds: サブコレクション形式のケース
      const sub = await db.collection("settings").doc("syncConfig").collection("icalFeeds").get().catch(() => null);
      if (sub && !sub.empty) {
        console.log("\n-- settings/syncConfig/icalFeeds (subcollection) --");
        console.log(`total: ${sub.size}`);
        for (const d of sub.docs) {
          const f = d.data();
          console.log(JSON.stringify({
            id: d.id,
            url: f.url,
            propertyId: f.propertyId,
            lastSync: toDateStr(f.lastSync),
            enabled: f.enabled,
            source: f.source,
          }));
        }
        cnt += sub.size;
      } else {
        console.log("(icalFeeds 不在)");
      }
    }
    return cnt;
  });

  // 2. S1 bookings (未来分)
  await runSection("[S1] bookings (future, the Terrace 長浜)", async () => {
    // checkIn は string の可能性も timestamp の可能性もある → 両方試す
    let docs = [];
    try {
      const snap = await db.collection("bookings")
        .where("propertyId", "==", TARGET_PROPERTY_ID)
        .get();
      docs = snap.docs.filter(d => {
        const x = d.data();
        const ciStr = typeof x.checkIn === "string" ? x.checkIn : toDateStr(x.checkIn);
        if (!ciStr) return false;
        return ciStr.slice(0, 10) >= todayIso;
      });
    } catch (e) {
      throw e;
    }

    console.log(`total: ${docs.length}`);
    // checkIn 昇順でソート
    docs.sort((a, b) => {
      const ai = toDateStr(a.data().checkIn) || "";
      const bi = toDateStr(b.data().checkIn) || "";
      return ai.localeCompare(bi);
    });
    for (const d of docs) {
      const x = d.data();
      console.log(JSON.stringify({
        id: d.id,
        guestName: x.guestName,
        checkIn: toDateStr(x.checkIn),
        checkOut: toDateStr(x.checkOut),
        source: x.source,
        status: x.status,
        propertyId: x.propertyId,
      }));
    }
    return docs.length;
  });

  // 3. S2 recruitments (募集中 or スタッフ確定済み)
  await runSection("[S2] recruitments (募集中 or スタッフ確定済み)", async () => {
    const snap = await db.collection("recruitments").get();
    const docs = snap.docs.filter(d => {
      const s = d.data().status;
      return s === "募集中" || s === "スタッフ確定済み";
    });
    console.log(`total: ${docs.length}`);
    // checkoutDate 昇順でソート
    docs.sort((a, b) => String(a.data().checkoutDate || "").localeCompare(String(b.data().checkoutDate || "")));
    for (const d of docs) {
      const x = d.data();
      // responses サブコレクション件数
      let responsesCount = 0;
      try {
        const rs = await d.ref.collection("responses").get();
        responsesCount = rs.size;
      } catch (_) {}
      console.log(JSON.stringify({
        id: d.id,
        checkoutDate: x.checkoutDate,
        propertyId: x.propertyId,
        status: x.status,
        selectedStaff: x.selectedStaff,
        selectedStaffIds: x.selectedStaffIds,
        bookingId: x.bookingId,
        responsesCount,
      }));
    }
    return docs.length;
  });

  // 4. S2 shifts (未来分)
  await runSection("[S2] shifts (future, the Terrace 長浜)", async () => {
    const snap = await db.collection("shifts")
      .where("propertyId", "==", TARGET_PROPERTY_ID)
      .get();
    const docs = snap.docs.filter(d => {
      const x = d.data();
      const ds = toDateStr(x.date);
      if (!ds) return false;
      return ds.slice(0, 10) >= todayIso;
    });
    console.log(`total: ${docs.length}`);
    docs.sort((a, b) => String(toDateStr(a.data().date) || "").localeCompare(String(toDateStr(b.data().date) || "")));
    for (const d of docs) {
      const x = d.data();
      console.log(JSON.stringify({
        id: d.id,
        date: toDateStr(x.date),
        propertyId: x.propertyId,
        staffId: x.staffId,
        staffName: x.staffName,
        status: x.status,
        workType: x.workType,
        bookingId: x.bookingId,
      }));
    }
    return docs.length;
  });

  // 5. S5 checklists (未完了)
  await runSection("[S5] checklists (未完了)", async () => {
    const snap = await db.collection("checklists").get();
    const docs = snap.docs.filter(d => d.data().status !== "completed");
    console.log(`total: ${docs.length}`);
    for (const d of docs) {
      const x = d.data();
      const items = Array.isArray(x.items) ? x.items : [];
      const totalItems = items.length;
      const completedItems = items.filter(it => it && (it.checked === true || it.done === true || it.completed === true)).length;
      console.log(JSON.stringify({
        id: d.id,
        shiftId: x.shiftId,
        propertyId: x.propertyId,
        staffId: x.staffId,
        status: x.status,
        completedItems,
        totalItems,
      }));
    }
    return docs.length;
  });

  // 6. S6 laundry (直近30日)
  await runSection("[S6] laundry (直近30日)", async () => {
    const snap = await db.collection("laundry").get();
    const docs = snap.docs.filter(d => {
      const x = d.data();
      const ds = toDateStr(x.date);
      if (!ds) return false;
      return ds.slice(0, 10) >= thirtyDaysAgo.toISOString().slice(0, 10);
    });
    console.log(`total: ${docs.length}`);
    docs.sort((a, b) => String(toDateStr(a.data().date) || "").localeCompare(String(toDateStr(b.data().date) || "")));
    for (const d of docs) {
      const x = d.data();
      console.log(JSON.stringify({
        id: d.id,
        date: toDateStr(x.date),
        staffId: x.staffId,
        propertyId: x.propertyId,
        amount: x.amount,
        isReimbursable: x.isReimbursable,
      }));
    }
    return docs.length;
  });

  // 7. S7 invoices (全件)
  await runSection("[S7] invoices (all)", async () => {
    const snap = await db.collection("invoices").get();
    console.log(`total: ${snap.size}`);
    const docs = snap.docs.slice().sort((a, b) =>
      String(b.data().yearMonth || "").localeCompare(String(a.data().yearMonth || ""))
    );
    for (const d of docs) {
      const x = d.data();
      const items = Array.isArray(x.items) ? x.items
        : Array.isArray(x.manualItems) ? x.manualItems
        : Array.isArray(x?.details?.shifts) ? x.details.shifts
        : [];
      console.log(JSON.stringify({
        id: d.id,
        yearMonth: x.yearMonth,
        staffId: x.staffId,
        status: x.status,
        total: x.total,
        itemsCount: items.length,
        hasPdfUrl: !!x.pdfUrl,
      }));
    }
    return snap.size;
  });

  // 8. S5 cleaningPhotos (直近30日)
  await runSection("[S5] cleaningPhotos (直近30日)", async () => {
    let snap;
    try {
      snap = await db.collection("cleaningPhotos").get();
    } catch (e) {
      console.log(`(未実装 or 0件: ${e.message})`);
      return 0;
    }
    if (!snap || snap.empty) {
      console.log("(未実装 or 0件)");
      return 0;
    }
    const docs = snap.docs.filter(d => {
      const x = d.data();
      const cs = toDateStr(x.createdAt);
      if (!cs) return true; // createdAt なしも一応出す
      return cs.slice(0, 10) >= thirtyDaysAgo.toISOString().slice(0, 10);
    });
    console.log(`total: ${docs.length}`);
    for (const d of docs) {
      const x = d.data();
      console.log(JSON.stringify({
        id: d.id,
        shiftId: x.shiftId,
        propertyId: x.propertyId,
        staffId: x.staffId,
        phase: x.phase,
        createdAt: toDateStr(x.createdAt),
        storagePath: x.storagePath,
      }));
    }
    return docs.length;
  });

  // 9. サブオーナー
  await runSection("[SubOwner] staff where isSubOwner == true", async () => {
    const snap = await db.collection("staff").where("isSubOwner", "==", true).get();
    console.log(`total: ${snap.size}`);
    for (const d of snap.docs) {
      const x = d.data();
      console.log(JSON.stringify({
        id: d.id,
        name: x.name,
        ownedPropertyIds: x.ownedPropertyIds,
      }));
    }
    return snap.size;
  });

  // 10. 通知設定
  await runSection("[Notifications] settings/notifications.enabled", async () => {
    const d = await db.collection("settings").doc("notifications").get();
    if (!d.exists) {
      console.log("(settings/notifications 不在)");
      return 0;
    }
    const x = d.data() || {};
    console.log("enabled:");
    console.log(JSON.stringify(x.enabled || null, null, 2));
    return x.enabled ? Object.keys(x.enabled).length : 0;
  });

  // サマリ
  console.log("\n==== SUMMARY ====");
  for (const [k, v] of Object.entries(summary)) {
    console.log(`${k}: ${v}`);
  }

  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
