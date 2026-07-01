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
const { reevaluateUnmatched } = require("../utils/reevaluateUnmatched");
const { updateSyncHealth } = require("../utils/syncHealth");

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
 * 今日の JST 日付を YYYY-MM-DD で返す
 */
function toJSTDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
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
  // P1: 新規 confirmed 作成 / pendingApproval 降下した物件を記録 → ループ後に再評価
  const reevaluatePropertyIds = new Set();

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
      // 物件のメール照合接続状況を取得 (senderGmail があれば接続済み)
      // 未接続なら Reserved 予約も pendingApproval=true を立てない (= 即カレンダー表示)
      let hasEmailVerification = false;
      if (setting.propertyId) {
        const propSnap = await db.collection("properties").doc(setting.propertyId).get();
        hasEmailVerification = !!(propSnap.exists && propSnap.data()?.senderGmail);
      }

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

        // ゲスト名が空 + CLOSED/Not available/Blocked/Reserved → 通常はブロック扱い
        // 例外: Booking.com の CLOSED は **常に** 匿名予約として取り込む
        // (公開 iCal は実名を出さず "CLOSED - Not available" になるため、
        //  メール照合の有無に関わらず取り込まないと予約が永久に非表示になる)
        // メール照合接続済み物件は unverified=true フラグを立て、後でメール受信時に
        // 実名・人数で更新 + フラグ降下する (emailVerification.js の confirmed 処理)
        if (!guestName && /not available|closed|blocked|reserved/i.test(summaryLower)) {
          if (platform === "Booking.com") {
            // Booking.com は取り込み続行 (unverified 判定は下で実施)
            console.log(`[syncIcal] Booking.com匿名予約として取り込み (照合${hasEmailVerification ? "接続済→未照合フラグ" : "未接続"}): ${checkIn}〜${checkOut}`);
          } else {
            console.log(`[syncIcal] スキップ(ブロック): ${platform} ${checkIn}〜${checkOut} "${summary}"`);
            skipped++;
            continue;
          }
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
        // CLOSED/Not available のような匿名予約も曖昧扱い (Booking.com匿名取込分含む)
        const isAmbiguousName = !guestName
          || /^(airbnb|booking|予約)$/i.test(guestName.trim())
          || /not available|closed|blocked|reserved/i.test(summaryLower);
        if (isAmbiguousName) {
          const dupSnap = await db.collection("bookings")
            .where("checkIn", "==", checkIn)
            .where("status", "==", "confirmed")
            .get();
          // 別プラットフォームの実予約（ゲスト名あり）が「同一物件内」に存在する → この曖昧な予約はスキップ
          // ※ propertyId を JS 側で照合する。1物理物件=1物件ではなく複数物件が iCal を持つため、
          //   propertyId で絞らないと「別物件で同じ日に予約がある」だけで実予約を誤スキップしてしまう
          //   (例: the Terrace の Booking 実予約が、別物件の同日 Airbnb 予約により取り込まれない)。
          const realDup = dupSnap.docs.find(d => {
            const dd = d.data();
            return dd.propertyId === setting.propertyId
              && dd.source !== platform
              && dd.guestName
              && !/^(reserved|airbnb|booking|予約)/i.test(dd.guestName);
          });
          if (realDup) {
            const dupData = realDup.data();
            console.log(`[syncIcal] スキップ(クロス重複): ${platform} ${checkIn}〜${checkOut} (同物件に${dupData.source}の実予約あり)`);
            skipped++;
            continue;
          }
        }

        // bookingsコレクションに upsert（iCalのUIDをドキュメントIDに使用）
        const docId = `ical_${uid.replace(/[/\\]/g, "_").slice(0, 100)}`;
        const docRef = db.collection("bookings").doc(docId);
        const existing = await docRef.get();

        // ゴースト重複ガード: Booking.com 匿名 CLOSED は、同物件で日付がオーバーラップする
        // 別の非キャンセル予約があれば取り込まない (Booking.com iCal は同じ予約に対し
        // 別 UID で CLOSED エントリを重ねて配信することがあり、これがゴースト予約を生む)。
        // 既存ゴースト (= 過去に取り込まれた重複) も同条件で削除する (cleanup)。
        if (platform === "Booking.com"
            && !guestName
            && /not available|closed|blocked|reserved/i.test(summaryLower)
            && setting.propertyId) {
          // 同物件で CI <= checkOut かつ CO >= checkIn の非キャンセル予約があるか
          const overlapSnap = await db.collection("bookings")
            .where("propertyId", "==", setting.propertyId)
            .where("checkIn", "<=", checkOut)
            .get();
          const hasOverlap = overlapSnap.docs.some(od => {
            const ob = od.data();
            const oCi = String(ob.checkIn || "");
            const oCo = String(ob.checkOut || "");
            const s = String(ob.status || "").toLowerCase();
            const isCancel = s.includes("cancel") || ob.status === "キャンセル" || ob.status === "キャンセル済み";
            if (isCancel) return false;
            // 同UIDは除外 (再同期時の自分自身)
            if (ob.icalUid === uid) return false;
            // オーバーラップ判定: oCi < checkOut && oCo > checkIn (隣接=連泊は重複扱いしない)
            return oCi < checkOut && oCo > checkIn;
          });
          if (hasOverlap) {
            console.log(`[syncIcal] スキップ(ゴースト重複疑い): Booking.com匿名CLOSED ${checkIn}〜${checkOut} (同物件に重複予約あり propertyId=${setting.propertyId})`);
            // 既に過去取り込みでゴーストが残っていれば削除 (cleanup)
            // ただしメール照合済み・手動確定・実名が付いた予約は「ゴースト」ではないので削除しない
            // (実予約を誤削除しないための安全ガード)
            if (existing.exists) {
              const ex = existing.data() || {};
              const isRealBooking = ex.emailVerifiedAt || ex.manualOverride
                || (ex.guestName && ex.guestName !== "Booking.com予約");
              if (isRealBooking) {
                console.log(`[syncIcal] ゴースト削除スキップ(実予約): ${docId} (${ex.guestName || ""})`);
              } else {
                try {
                  await docRef.delete();
                  console.log(`[syncIcal] 既存ゴースト削除: ${docId}`);
                } catch (e) {
                  console.warn(`[syncIcal] ゴースト削除失敗: ${e.message}`);
                }
              }
            }
            // 後段のキャンセル検知 phase で「未同期 = キャンセル」扱いされて
            // onBookingChange が偽キャンセル通知を送るのを防ぐため、UID を「同期済み」に登録
            syncedIcalUids.add(uid);
            skipped++;
            continue;
          }
        }

        // Booking.comのCLOSEDイベントはゲスト名を空にする（SUMMARYを使わない）
        // 表示用プレースホルダ「Booking.com予約」を入れる (メール照合の有無問わず)
        // → メール照合で実名取得後に最新勝ちロジックで実名へ上書き
        let resolvedGuestName;
        if (!guestName && platform === "Booking.com") {
          resolvedGuestName = "Booking.com予約";
        } else {
          resolvedGuestName = guestName || event.summary || "";
        }

        // 未照合判定: Booking.com 匿名取込 + メール照合接続済み = 未照合 (true)
        // メール照合未接続なら iCal 単独運用なので unverified を立てない (=false)
        const isAnonymousBookingCom = platform === "Booking.com"
          && !guestName
          && /not available|closed|blocked|reserved/i.test(summaryLower);
        const shouldSetUnverified = isAnonymousBookingCom && hasEmailVerification;

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
          // フィードで再確認できたので「消失猶予」フラグをクリア
          // (Booking.com iCal は一時的にイベントを落とすため、消失=即キャンセルにしない)
          firstMissedAt: admin.firestore.FieldValue.delete(),
        };

        // Airbnb で guestName が "Reserved" のまま (=保留中の可能性) は pendingApproval=true で取り込む
        // → onBookingChange は pendingApproval=true なら募集生成・通知をスキップする
        // → メール照合(emailVerificationCore)で確定メールが見つかった瞬間に false に降ろされ、再発火で募集が走る
        const isReservedPlaceholder = platform === "Airbnb"
          && /^reserved$/i.test(String(resolvedGuestName || "").trim());

        if (!existing.exists) {
          bookingData.createdAt = admin.firestore.FieldValue.serverTimestamp();
          bookingData.guestCount = 0;
          bookingData.propertyId = setting.propertyId || "";
          bookingData.bbq = false;
          bookingData.parking = false;
          bookingData.nationality = "";
          bookingData.notes = event.description || "";
          // メール照合未接続の物件は pendingApproval=true を立てない
          // (照合で確定降下できないため、Reserved のまま永久に非表示になるのを防ぐ)
          if (isReservedPlaceholder && hasEmailVerification) {
            bookingData.pendingApproval = true;
            console.log(`[syncIcal] 保留扱いで取り込み (pendingApproval=true): ${platform} ${checkIn}〜${checkOut} (Reservedのまま)`);
          } else if (isReservedPlaceholder && !hasEmailVerification) {
            console.log(`[syncIcal] メール照合未接続のため即表示で取り込み: ${platform} ${checkIn}〜${checkOut} (propertyId=${setting.propertyId})`);
          }
          // Booking.com 匿名予約をメール照合接続物件で取り込む場合は未照合フラグ
          // → メール受信時に emailVerification.js が unverified=false に降下
          if (shouldSetUnverified) {
            bookingData.unverified = true;
            console.log(`[syncIcal] 未照合扱いで取り込み (unverified=true): ${platform} ${checkIn}〜${checkOut}`);
          }
        } else {
          // 既存データの手動編集を上書きしない（guestNameが実名なら保持）
          const existData = existing.data();
          if (existData.guestName && existData.guestName !== existData._icalOriginalName) {
            // 手動で変更された名前は保持
            bookingData.guestName = existData.guestName;
          }
          // メール照合未接続の物件で過去に pendingApproval=true で書き込まれていたら降ろす
          // (本変更投入前に取り込まれた Reserved 予約を可視化)
          if (isReservedPlaceholder && !hasEmailVerification && existData.pendingApproval === true) {
            bookingData.pendingApproval = false;
            console.log(`[syncIcal] 既存 pendingApproval=true を降下 (メール照合未接続): ${platform} ${checkIn}〜${checkOut}`);
          }
        }
        // iCalの元の名前を保存（手動変更検知用）
        bookingData._icalOriginalName = resolvedGuestName;

        await docRef.set(bookingData, { merge: true });
        syncedIcalUids.add(uid); // A-1: icalUid → uid バグ修正（キャンセル検出用に記録）
        synced++;

        // P1: 新規 confirmed 作成 or pendingApproval=true→false 降下時のみ再評価対象に追加
        const isNewlyCreated = !existing.exists;
        const isJustResolved = existing.exists
          && existing.data().pendingApproval === true
          && bookingData.pendingApproval === false;
        if ((isNewlyCreated || isJustResolved) && setting.propertyId) {
          reevaluatePropertyIds.add(setting.propertyId);
        }
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
      // メール照合で確定メールが紐付いている予約は iCal キャンセル検知から保護
      // (Booking.com の iCal フィードは一時的にイベントが消えることがあり誤キャンセルの原因。
      //  確定メールがある=実在する予約なので、キャンセルメール経由でしか cancelled にしない。
      //  emailMatcher.js が cancelled メール検知時に正しく cancelled 化する。)
      if (data.emailVerifiedAt && data.emailMessageId) {
        console.log(`[syncIcal] キャンセル検知スキップ(メール照合済): ${data.source} ${data.checkIn}〜${data.checkOut} (${data.guestName || ""})`);
        continue;
      }

      // iCalに存在しない → ただし Booking.com iCal は一時的にイベントを落とすため、
      // 単発の消失で即キャンセルにしない。初回消失時刻(firstMissedAt)を記録し、
      // GRACE_MS を超えて連続で消え続けている場合のみキャンセルする。
      // (メール照合済みは上でスキップ済み。ここに来るのは主に匿名 Booking.com 予約)
      const MISS_GRACE_MS = 24 * 60 * 60 * 1000; // 24時間
      const firstMissed = data.firstMissedAt
        ? (data.firstMissedAt.toDate ? data.firstMissedAt.toDate() : new Date(data.firstMissedAt))
        : null;
      if (!firstMissed) {
        // 初回消失 → 猶予開始（まだキャンセルしない）
        await doc.ref.update({
          firstMissedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[syncIcal] フィード消失(猶予開始): ${data.guestName || "不明"} ${data.checkIn}〜${data.checkOut} — 24hフィード復帰しなければキャンセル`);
        continue;
      }
      if (Date.now() - firstMissed.getTime() < MISS_GRACE_MS) {
        // 猶予期間中 → キャンセルしない
        console.log(`[syncIcal] フィード消失(猶予中): ${data.guestName || "不明"} ${data.checkIn}〜${data.checkOut}`);
        continue;
      }

      // 猶予を超えて消え続けている → キャンセル扱い
      await doc.ref.update({
        status: "cancelled",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelReason: "iCal同期: フィードから24h以上削除されたため自動キャンセル",
      });
      cancelled++;
      console.log(`[syncIcal] キャンセル(24h猶予超過): ${data.guestName || "不明"} ${data.checkIn}〜${data.checkOut}`);
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

  // ===== 案C: 保留中メールの自動アーカイブ =====
  // iCal同期後、pending_request の emailVerifications を対応する bookings と照合し、
  // 予約が confirmed 済 → resolved_to_confirmed、予約なし(キャンセル済) → archived に更新
  try {
    await autoArchivePendingRequests(db);
  } catch (archErr) {
    console.error("[syncIcal] autoArchive エラー:", archErr.message);
  }

  // ===== P1: unmatched emailVerifications の再評価 =====
  // 新規 confirmed 作成 or pendingApproval 降下があった物件についてのみ実行
  // (bookings 側変化が無ければ再評価しても matched 化しないので無駄)
  for (const pid of reevaluatePropertyIds) {
    try {
      const r = await reevaluateUnmatched(db, { propertyId: pid, log: console });
      if (r.rematched > 0) {
        console.log(`[syncIcal] 再評価で ${r.rematched} 件 matched 化 (property=${pid})`);
      }
    } catch (e) {
      console.error(`[syncIcal] 再評価エラー (property=${pid}):`, e.message);
    }
  }

  // ===== P1: syncHealth 更新 =====
  await updateSyncHealth(db, "syncIcal", {
    ok: erroredPlatforms.size === 0,
    error: erroredPlatforms.size > 0 ? `feed errors: ${[...erroredPlatforms].join(",")}` : undefined,
  });
}

/**
 * 案C: pending_request のメールを自動アーカイブする
 * - 対応予約が bookings に confirmed で存在 → resolved_to_confirmed
 * - 対応予約が存在しない or キャンセル → archived
 */
async function autoArchivePendingRequests(db) {
  const snap = await db.collection("emailVerifications")
    .where("matchStatus", "==", "pending_request")
    .get();
  if (snap.empty) return;

  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const doc of snap.docs) {
    const data = doc.data();
    const propertyId = data.propertyId;
    const checkInDate = data.extractedInfo && data.extractedInfo.checkIn && data.extractedInfo.checkIn.date;
    if (!propertyId || !checkInDate) continue;

    // 同じ物件+チェックイン日の確定予約を検索
    const bookSnap = await db.collection("bookings")
      .where("propertyId", "==", propertyId)
      .where("status", "==", "confirmed")
      .get();

    let hasConfirmedBooking = false;
    for (const bDoc of bookSnap.docs) {
      const bData = bDoc.data();
      let ci = "";
      try {
        const ciRaw = bData.checkIn;
        if (ciRaw) {
          const d = (ciRaw && typeof ciRaw.toDate === "function") ? ciRaw.toDate() : new Date(ciRaw);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const da = String(d.getDate()).padStart(2, "0");
          ci = `${y}-${m}-${da}`;
        }
      } catch (_) { /* noop */ }
      if (ci === checkInDate) { hasConfirmedBooking = true; break; }
    }

    if (hasConfirmedBooking) {
      await doc.ref.update({ matchStatus: "resolved_to_confirmed", resolvedAt: now });
      console.log(`[autoArchive] resolved_to_confirmed: ${doc.id}`);
    } else {
      // 予約が見つからない場合はアーカイブ (30日以上前の保留中メールのみ対象)
      const receivedMs = data.receivedAt
        ? (data.receivedAt._seconds ? data.receivedAt._seconds * 1000 : 0)
        : 0;
      const ageMs = Date.now() - receivedMs;
      if (ageMs > 30 * 24 * 60 * 60 * 1000) {
        await doc.ref.update({ matchStatus: "archived", archivedAt: now, archiveReason: "no_confirmed_booking_after_30d" });
        console.log(`[autoArchive] archived: ${doc.id}`);
      }
    }
  }
}

module.exports = syncIcal;
