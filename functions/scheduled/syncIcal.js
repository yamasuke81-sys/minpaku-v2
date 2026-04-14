/**
 * iCal同期 — 定期実行Cloud Function
 * syncSettingsコレクションに登録されたiCal URLからイベントを取得し、
 * bookingsコレクションに同期する。
 *
 * 設計方針:
 * - Beds24導入後はiCal同期を無効化し、Beds24 API同期に切り替え可能
 * - bookingsの各ドキュメントにsyncSource（"ical" | "beds24" | "manual"）を付与
 * - iCal同期データはicalUrlのドメインからAirbnb/Booking.com等を自動判定
 */
const admin = require("firebase-admin");
const ical = require("node-ical");

/**
 * iCal URLのドメインからプラットフォームを判定
 */
function detectPlatform(url) {
  if (!url) return "unknown";
  const u = url.toLowerCase();
  if (u.includes("airbnb")) return "Airbnb";
  if (u.includes("booking.com")) return "Booking.com";
  if (u.includes("beds24")) return "Beds24";
  if (u.includes("vrbo") || u.includes("homeaway")) return "VRBO";
  if (u.includes("agoda")) return "Agoda";
  if (u.includes("expedia")) return "Expedia";
  return "other";
}

/**
 * iCalイベントからゲスト名を抽出（SUMMARYから推定）
 */
function extractGuestName(event, platform) {
  const summary = (event.summary || "").trim();
  if (!summary) return "";

  // Airbnb: "予約済み - ゲスト名" or "Reserved - Guest Name" or "Not available"
  if (platform === "Airbnb") {
    // ブロック・非公開
    if (/^(not available|closed|blocked)/i.test(summary)) return "";
    // "予約済み - XXX" → XXX
    const m = summary.match(/^(?:予約済み|Reserved|Booked)\s*[-–—]\s*(.+)/i);
    if (m) return m[1].trim();
    return summary;
  }

  // Booking.com: "ゲスト名" or "CLOSED"
  if (platform === "Booking.com") {
    if (/^(closed|not available)/i.test(summary)) return "";
    return summary;
  }

  return summary;
}

/**
 * 日付をYYYY-MM-DD形式に変換（JSTで丸め）
 */
function toDateStr(d) {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "";
  // iCalのDTSTART/DTENDがDATE型の場合、UTCの00:00:00で来る
  // JSTに変換すると翌日になる問題を回避するため、
  // 時刻なし（DATE型）の場合はUTCのままの日付を使う
  if (typeof d === "string" && d.length === 8) {
    // YYYYMMDDフォーマット
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  // DATE型（時刻なし）の場合
  // node-icalはDATE型をローカルTZ 00:00で解釈するため、
  // Cloud Functions(UTC)では正しいが、JST環境では15:00 UTCになる場合がある
  if (d.dateOnly) {
    // JSTで日付を取得（15:00 UTC = 翌日 00:00 JST のケースを正しく処理）
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
  }
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0) {
    return date.toISOString().slice(0, 10);
  }
  // JSTで日付を取得
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * メイン同期処理
 */
async function syncIcal() {
  const db = admin.firestore();

  // ===== 同期頻度チェック =====
  const syncConfigRef = db.collection("settings").doc("syncConfig");
  const syncConfigSnap = await syncConfigRef.get();
  const syncConfig = syncConfigSnap.exists ? syncConfigSnap.data() : {};

  // icalSyncInterval が 0 → 手動のみモード
  const icalSyncInterval = syncConfig.icalSyncInterval ?? 30; // デフォルト30分
  if (icalSyncInterval === 0) {
    console.log("[syncIcal] icalSyncInterval=0（手動のみ）。スキップ。");
    return;
  }

  // 前回同期からの経過時間チェック
  if (syncConfig.lastIcalSync) {
    const lastSync = syncConfig.lastIcalSync.toDate
      ? syncConfig.lastIcalSync.toDate()
      : new Date(syncConfig.lastIcalSync);
    const elapsedMinutes = (Date.now() - lastSync.getTime()) / (1000 * 60);
    if (elapsedMinutes < icalSyncInterval) {
      console.log(
        `[syncIcal] 前回同期から ${elapsedMinutes.toFixed(1)} 分経過。` +
        `設定間隔 ${icalSyncInterval} 分未満のためスキップ。`
      );
      return;
    }
  }
  // ===== 同期頻度チェック終わり =====

  const settingsSnap = await db.collection("syncSettings").get();

  if (settingsSnap.empty) {
    console.log("[syncIcal] syncSettings が空です。スキップ。");
    return;
  }

  let totalSynced = 0;
  let totalSkipped = 0;

  for (const settingDoc of settingsSnap.docs) {
    const setting = settingDoc.data();
    // 無効 or URLなし → スキップ
    if (setting.active === false || !setting.icalUrl) {
      console.log(`[syncIcal] ${settingDoc.id}: 無効またはURL未設定。スキップ。`);
      continue;
    }

    const icalUrl = setting.icalUrl;
    const platform = setting.platform || detectPlatform(icalUrl);
    console.log(`[syncIcal] 同期開始: ${platform} (${icalUrl.slice(0, 60)}...)`);

    try {
      // iCalフィードを取得・パース
      const events = await ical.async.fromURL(icalUrl);
      let synced = 0;
      let skipped = 0;

      for (const [uid, event] of Object.entries(events)) {
        // VEVENTのみ処理
        if (event.type !== "VEVENT") continue;

        const checkIn = toDateStr(event.start);
        const checkOut = toDateStr(event.end);
        if (!checkIn) {
          skipped++;
          continue;
        }

        const guestName = extractGuestName(event, platform);

        // Airbnbのブロック/非公開イベントはスキップ（予約は別イベントで来るため）
        // Booking.comはCLOSEDイベントに予約情報が含まれるため取り込む
        if (!guestName && /not available|closed|blocked/i.test(event.summary || "")) {
          if (platform !== "Booking.com") {
            skipped++;
            continue;
          }
          // Booking.com: 長期ブロック（21日超）はシーズンクローズ等なのでスキップ
          const ciDate = new Date(checkIn);
          const coDate = new Date(checkOut || checkIn);
          const days = (coDate - ciDate) / (1000 * 60 * 60 * 24);
          if (days > 21) {
            console.log(`[syncIcal] スキップ(長期${days}日): ${checkIn}〜${checkOut}`);
            skipped++;
            continue;
          }
          // Booking.com: Airbnb予約と期間が完全一致するブロックはスキップ（クロスチャネル重複）
          // 完全一致のみスキップ: CLOSEDのcheckIn==AirbnbのcheckIn && CLOSEDのcheckOut==AirbnbのcheckOut
          // 理由: 期間重複判定だとBooking.com独自予約まで誤スキップされる
          const co = checkOut || checkIn;
          const airbnbOverlap = await db.collection("bookings")
            .where("source", "==", "Airbnb")
            .where("checkIn", "==", checkIn)
            .get();
          const hasExactMatch = airbnbOverlap.docs.some(doc => {
            const ab = doc.data();
            return ab.checkOut === co;
          });
          if (hasExactMatch) {
            console.log(`[syncIcal] スキップ(Airbnb完全一致): ${checkIn}〜${co}`);
            skipped++;
            continue;
          }
          console.log(`[syncIcal] Booking.com CLOSED取込: ${checkIn}〜${co} (${days}日間)`);
          // Booking.com: CLOSEDイベントを予約として取り込む（ゲスト名は空）
        }

        // bookingsコレクションに upsert（iCalのUIDをドキュメントIDに使用）
        const docId = `ical_${uid.replace(/[/\\]/g, "_").slice(0, 100)}`;
        const docRef = db.collection("bookings").doc(docId);
        const existing = await docRef.get();

        // Booking.comのCLOSEDイベントはゲスト名を空にする（SUMMARYを使わない）
        const resolvedGuestName = (!guestName && platform === "Booking.com")
          ? "" : (guestName || event.summary || "");

        const bookingData = {
          guestName: resolvedGuestName,
          checkIn,
          checkOut: checkOut || checkIn,
          source: platform,
          syncSource: "ical",
          icalUrl: icalUrl,
          icalUid: uid,
          status: "confirmed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (!existing.exists) {
          bookingData.createdAt = admin.firestore.FieldValue.serverTimestamp();
          bookingData.guestCount = 0;
          bookingData.propertyId = setting.propertyId || "";
          bookingData.bbq = false;
          bookingData.parking = false;
          bookingData.nationality = "";
          bookingData.notes = event.description || "";
        } else {
          // 既存データの手動編集を上書きしない（guestNameが実名なら保持）
          const existData = existing.data();
          if (existData.guestName && existData.guestName !== existData._icalOriginalName) {
            // 手動で変更された名前は保持
            bookingData.guestName = existData.guestName;
          }
        }
        // iCalの元の名前を保存（手動変更検知用）
        bookingData._icalOriginalName = resolvedGuestName;

        await docRef.set(bookingData, { merge: true });
        synced++;
      }

      // 最終同期時刻を更新
      await settingDoc.ref.update({
        lastSync: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncResult: `${synced}件同期, ${skipped}件スキップ`,
      });

      console.log(`[syncIcal] ${platform}: ${synced}件同期, ${skipped}件スキップ`);
      totalSynced += synced;
      totalSkipped += skipped;
    } catch (e) {
      console.error(`[syncIcal] ${platform} エラー:`, e.message);
      await settingDoc.ref.update({
        lastSync: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncResult: `エラー: ${e.message}`,
      });
    }
  }

  console.log(`[syncIcal] 完了: 合計 ${totalSynced}件同期, ${totalSkipped}件スキップ`);

  // lastIcalSync を現在時刻で更新
  await syncConfigRef.set(
    { lastIcalSync: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

module.exports = syncIcal;
