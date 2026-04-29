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
const { notifyByKey } = require("../utils/lineNotify");

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
 * Airbnb ホストブロック等のブロック予約かどうかを判定
 * 実予約ではない場合は true を返す
 */
function isBlockEvent(summary) {
  const s = String(summary || "").toLowerCase().trim();
  if (!s) return false;
  return (
    /not available/i.test(s) ||
    /^reserved$/i.test(s) ||
    /^blocked$/i.test(s) ||
    /^closed$/i.test(s) ||
    /^unavailable/i.test(s)
  );
}

/**
 * 保留中・予約リクエスト状態かどうかを判定
 * 確定していない予約はスキップ (確定後に再取得されたタイミングで登録)
 */
function isPendingEvent(summary, status) {
  // STATUS フィールドが TENTATIVE なら保留
  if (status && /tentative/i.test(String(status))) return true;
  const s = String(summary || "").toLowerCase().trim();
  return (
    /保留中/i.test(s) ||
    /予約リクエスト/i.test(s) ||
    /^request$/i.test(s) ||
    /^pending$/i.test(s) ||
    /reservation request/i.test(s)
  );
}

/**
 * iCalイベントからゲスト名を抽出（SUMMARYから推定）
 */
function extractGuestName(event, platform) {
  const summary = (event.summary || "").trim();
  if (!summary) return "";

  // Airbnb: "予約済み - ゲスト名" or "Reserved - Guest Name" or "Not available" or "Airbnb (Not available)"
  if (platform === "Airbnb") {
    // ブロック・非公開（"Airbnb (Not available)" 形式や括弧付きにも対応）
    if (/not available|closed|blocked/i.test(summary)) return "";
    // 単独の "Reserved" → DESCRIPTION に Reservation URL があれば実予約扱いで "Reserved" を返す
    // (後段の救済ロジックで実予約として処理される)
    if (/^reserved$/i.test(summary)) {
      const desc = event.description || "";
      if (/reservation url:/i.test(desc)) {
        return "Reserved";
      }
      return ""; // Reservation URL なし → ブロック扱い (従来通り)
    }
    // その他の単独ブロックイベント ("Blocked" / "Closed" / "Unavailable" など) はブロック
    if (isBlockEvent(summary)) return "";
    // "予約済み - XXX" → XXX
    const m = summary.match(/^(?:予約済み|Reserved|Booked)\s*[-–—]\s*(.+)/i);
    if (m) return m[1].trim();
    return summary;
  }

  // Booking.com: "ゲスト名" or "CLOSED"
  if (platform === "Booking.com") {
    if (/closed|not available/i.test(summary)) return "";
    return summary;
  }

  return summary;
}

/**
 * 日付をYYYY-MM-DD形式に変換（A-5: 3分岐→2分岐に整理）
 * - dateOnly フラグあり、または UTC 00:00 → UTCの日付をそのまま使用
 * - それ以外 → JST変換して日付を返す
 */
function toDateStr(d) {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "";
  // YYYYMMDDフォーマット（8文字文字列）の場合
  if (typeof d === "string" && d.length === 8) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  // dateOnly フラグあり、または UTC 00:00 → UTCの日付をそのまま使用
  // （iCal DATE型はUTC 00:00で届くことが多く、JSTに変換すると翌日になる問題を回避）
  if (d.dateOnly || (date.getUTCHours() === 0 && date.getUTCMinutes() === 0)) {
    return date.toISOString().slice(0, 10);
  }
  // 時刻付き（DATETIME型）→ JSTで日付を取得
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
  const icalSyncInterval = syncConfig.icalSyncInterval ?? 5; // デフォルト5分
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
  const syncedIcalUids = new Set(); // キャンセル検出用
  let totalSkipped = 0;
  // A-2: フィードエラーが発生したプラットフォームを記録（キャンセル検知スキップ用）
  const erroredPlatforms = new Set();

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

        // ブロック/非公開/売り止めイベントは全プラットフォームでスキップ
        const summary = (event.summary || "").trim();
        const summaryLower = summary.toLowerCase();

        // 保留中・予約リクエストはスキップ (確定後に再登録される)
        if (isPendingEvent(summary, event.status)) {
          console.log(`[syncIcal] 保留中スキップ: ${platform} ${checkIn}〜${checkOut} "${summary}"`);
          skipped++;
          continue;
        }

        // ゲスト名が空 + CLOSED/Not available/Blocked/Reserved → ブロック
        if (!guestName && /not available|closed|blocked|reserved/i.test(summaryLower)) {
          console.log(`[syncIcal] スキップ(ブロック): ${platform} ${checkIn}〜${checkOut} "${summary}"`);
          skipped++;
          continue;
        }
        // ゲスト名が空でsummaryもない → スキップ
        if (!guestName && !summary) {
          skipped++;
          continue;
        }
        // A-3: ゲスト名が"Reserved"のみの場合、Airbnbは DESCRIPTION に Reservation URL があれば実予約として扱う
        if (guestName && /^reserved$/i.test(guestName.trim())) {
          // Airbnb の場合: DESCRIPTION に "Reservation URL:" があれば実予約
          const isRealAirbnbReservation = platform === "Airbnb"
            && /reservation url:/i.test(event.description || "");
          if (!isRealAirbnbReservation) {
            console.log(`[syncIcal] スキップ(Reserved): ${platform} ${checkIn}〜${checkOut}`);
            skipped++;
            continue;
          }
          console.log(`[syncIcal] Airbnb実予約(Reserved+URL): ${checkIn}〜${checkOut}`);
        }

        // クロスプラットフォーム重複検出: 同じCI+COに別ソースの確定済み予約が既にある場合スキップ
        // 例: Booking.com実予約 + Airbnb売り止め → Airbnb側をスキップ
        if (!guestName || /^(airbnb|booking|予約)$/i.test(guestName.trim())) {
          const dupSnap = await db.collection("bookings")
            .where("checkIn", "==", checkIn)
            .where("status", "==", "confirmed")
            .limit(1)
            .get();
          if (!dupSnap.empty) {
            const dupData = dupSnap.docs[0].data();
            // 別プラットフォームの実予約（ゲスト名あり）が存在する → この曖昧な予約はスキップ
            if (dupData.source !== platform && dupData.guestName && !/^(reserved|airbnb|booking|予約)/i.test(dupData.guestName)) {
              console.log(`[syncIcal] スキップ(クロス重複): ${platform} ${checkIn}〜${checkOut} (${dupData.source}の実予約あり)`);
              skipped++;
              continue;
            }
          }
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
        syncedIcalUids.add(uid); // A-1: icalUid → uid バグ修正（キャンセル検出用に記録）
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
      // A-2: フィード取得エラーが発生したプラットフォームを記録
      // → キャンセル検知フェーズでこのプラットフォームの予約はスキップする
      erroredPlatforms.add(platform);
      await settingDoc.ref.update({
        lastSync: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncResult: `エラー: ${e.message}`,
      });
    }
  }

  // ===== iCalに存在しない予約をキャンセル =====
  // 同期済みicalUidのセットと、Firestoreにある予約を照合
  try {
    const today = toJSTDate(new Date());
    // 未来の予約（checkOut >= 今日）のうち、syncSource="ical" のものを取得
    const futureBookingsSnap = await db.collection("bookings")
      .where("syncSource", "==", "ical")
      .where("status", "==", "confirmed")
      .get();

    let cancelled = 0;
    for (const doc of futureBookingsSnap.docs) {
      const data = doc.data();
      // 過去の予約はスキップ
      if (data.checkOut && data.checkOut < today) continue;
      // A-2: フィードエラーが発生したプラットフォームの予約はキャンセル検知をスキップ
      // （一時的なネットワーク障害で誤キャンセルされるのを防ぐ）
      if (data.source && erroredPlatforms.has(data.source)) {
        console.log(`[syncIcal] キャンセル検知スキップ(フィードエラー): ${data.source} ${data.checkIn}〜${data.checkOut}`);
        continue;
      }
      // icalUidが同期で見つかったものはスキップ
      if (syncedIcalUids.has(data.icalUid)) continue;
      // icalUidがないものはスキップ（手動作成の予約）
      if (!data.icalUid) continue;
      // 手動で confirmed に戻された予約はキャンセル検知の対象外
      // (Booking.com iCal は実予約でも CLOSED しか出さないため、ユーザーが
      // 手動で確認して confirmed に復元した予約を保護する)
      if (data.manualOverride) continue;

      // iCalに存在しない → キャンセル扱い
      await doc.ref.update({
        status: "cancelled",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelReason: "iCal同期: フィードから削除されたため自動キャンセル",
      });
      cancelled++;
      console.log(`[syncIcal] キャンセル: ${data.guestName || "不明"} ${data.checkIn}〜${data.checkOut}`);
    }
    if (cancelled > 0) {
      console.log(`[syncIcal] ${cancelled}件の予約を自動キャンセル（iCalから削除済み）`);
    }

    // ===== クリーンアップ: 同じCI+COで確定済みと重複するキャンセル済みを削除 =====
    // キャンセル→再予約のケースで古いドキュメントがゴミとして残るのを防ぐ
    let cleaned = 0;
    const cancelledSnap = await db.collection("bookings")
      .where("syncSource", "==", "ical")
      .where("status", "==", "cancelled")
      .get();

    for (const cDoc of cancelledSnap.docs) {
      const cData = cDoc.data();
      if (!cData.checkIn || !cData.checkOut) continue;
      // 同じCI+COの確定済み予約があれば、このキャンセル済みは不要
      const dupSnap = await db.collection("bookings")
        .where("checkIn", "==", cData.checkIn)
        .where("checkOut", "==", cData.checkOut)
        .where("status", "==", "confirmed")
        .limit(1)
        .get();
      if (!dupSnap.empty) {
        await cDoc.ref.delete();
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[syncIcal] ${cleaned}件のキャンセル済み重複を削除`);
    }

    // ===== 既存の Reserved ブロック予約を cancelled に修正 =====
    // 以前のバージョンで ingest されてしまった guestName="Reserved" のブロック予約を修正する
    let fixedBlock = 0;
    const reservedSnap = await db.collection("bookings")
      .where("syncSource", "==", "ical")
      .where("status", "==", "confirmed")
      .where("guestName", "==", "Reserved")
      .get();
    for (const doc of reservedSnap.docs) {
      const data = doc.data();
      // DESCRIPTION に Reservation URL がある場合は実予約なので触らない
      if (data.notes && /reservation url:/i.test(data.notes)) continue;
      // 手動で confirmed に戻された予約は保護
      if (data.manualOverride) continue;
      await doc.ref.update({
        status: "cancelled",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelReason: "iCal同期: Reservedブロック予約のため自動キャンセル",
      });
      fixedBlock++;
      console.log(`[syncIcal] Reserved修正(cancelled): ${data.checkIn}〜${data.checkOut} (${doc.id})`);
    }
    if (fixedBlock > 0) {
      console.log(`[syncIcal] ${fixedBlock}件のReservedブロック予約をcancelledに修正`);
    }
  } catch (e) {
    console.error("[syncIcal] キャンセル/クリーンアップエラー:", e.message);
  }

  console.log(`[syncIcal] 完了: 合計 ${totalSynced}件同期, ${totalSkipped}件スキップ`);

  // ical_sync 通知: 新規予約があった場合のみ送信
  if (totalSynced > 0) {
    try {
      // 複数物件対応: 最初の syncSettings の propertyName を代表として使用
      let firstPropertyName = "";
      if (!settingsSnap.empty) {
        const firstSetting = settingsSnap.docs[0].data();
        if (firstSetting.propertyId) {
          const propDoc = await db.collection("properties").doc(firstSetting.propertyId).get();
          if (propDoc.exists) firstPropertyName = propDoc.data().name || "";
        }
      }
      const propertyLabel = settingsSnap.size > 1 ? "複数物件" : (firstPropertyName || "不明");
      const syncDateStr = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      await notifyByKey(db, "ical_sync", {
        title: `iCal同期完了: ${totalSynced}件の新規予約`,
        body: `📅 iCal同期完了\n\n新規予約: ${totalSynced}件\n物件: ${propertyLabel}\n同期日時: ${syncDateStr}`,
        vars: {
          count: String(totalSynced),
          property: propertyLabel,
          date: syncDateStr,
        },
      });
    } catch (notifyErr) {
      console.error("[syncIcal] ical_sync 通知エラー:", notifyErr.message);
    }
  }

  // lastIcalSync を現在時刻で更新
  await syncConfigRef.set(
    { lastIcalSync: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

module.exports = syncIcal;
