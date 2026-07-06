/**
 * 認証不要の公開API
 * ゲストフォームが必要な物件設定のみを返す (whitelist方式)
 */
const express = require("express");
const admin = require("firebase-admin");
const { getAppUrl } = require("../utils/appUrl");
const {
  ymd: normalizeYmd,
  isValidYmd,
  enumerateBlockedDates,
  periodsOverlap,
  validateBookingRequest,
  isSpamSubmission,
  todayJst,
} = require("./booking-request-logic");
const { verifyTurnstileToken, getTurnstileSecret } = require("../utils/turnstile");
const { computeQuote } = require("./pricing-logic");

const router = express.Router();

// GET /public/guest-form-config/:propertyId
// ゲストフォーム表示に必要な公開可能フィールドのみ返す
router.get("/guest-form-config/:propertyId", async (req, res) => {
  try {
    const pid = req.params.propertyId;
    if (!pid) return res.status(400).json({ error: "propertyId 必須" });

    const doc = await admin.firestore().collection("properties").doc(pid).get();
    if (!doc.exists || doc.data().active === false) {
      return res.status(404).json({ error: "物件が見つかりません" });
    }

    const d = doc.data();

    // 公開可能フィールドのみ whitelist 方式で抽出
    // 機密フィールド (lineChannelToken, monthlyFixedCost, purchasePrice 等) は含めない
    // customFormFields を formFieldConfig に含める（フォーム画面側がここを参照する）
    const formFieldConfig = d.formFieldConfig && typeof d.formFieldConfig === "object"
      ? {
          overrides: d.formFieldConfig.overrides || {},
          customFormFields: Array.isArray(d.customFormFields) ? d.customFormFields : [],
        }
      : {
          overrides: {},
          customFormFields: Array.isArray(d.customFormFields) ? d.customFormFields : [],
        };

    res.json({
      propertyId: pid,
      name: d.name || "",
      miniGameEnabled: d.miniGameEnabled !== false,       // デフォルト true
      showNoiseAgreement: d.showNoiseAgreement !== false, // デフォルト true
      customFormEnabled: d.customFormEnabled === true,    // デフォルト false
      customFormFields: Array.isArray(d.customFormFields) ? d.customFormFields : [],
      customFormSections: Array.isArray(d.customFormSections) ? d.customFormSections : [],
      formFieldConfig,  // Phase 1 追加: 標準項目のオーバーライド設定
      formSectionConfig: (d.formSectionConfig && typeof d.formSectionConfig === "object") ? d.formSectionConfig : {},
      noiseRuleConfig: (d.noiseRuleConfig && typeof d.noiseRuleConfig === "object") ? d.noiseRuleConfig : {},
      guideUrl: d.guideUrl || "",
      guideUrlMode: d.guideUrlMode || "auto",
      guideShowOnSuccess: d.guideShowOnSuccess !== false,  // デフォルト true（送信完了画面でゲスト案内へ案内する）
      address: d.address || "",
      // パスポート写真アップロード失敗時の代替送信先
      // 優先順: notificationEmail (受信通知) > senderGmail (Gmail連携の物件代表メール)
      contactEmail: d.notificationEmail || d.senderGmail || "",
      contactEmailName: d.notificationEmailName || d.name || "",
    });
  } catch (e) {
    console.error("[public/guest-form-config] エラー:", e);
    res.status(500).json({ error: "取得失敗" });
  }
});

// GET /public/guest-allocation/:token
// 宿泊者ガイドページから読み出す、その宿泊者専用の駐車場割当など最小情報のみ返す
// (editToken で認証。個人情報は一切返さない)
router.get("/guest-allocation/:token", async (req, res) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 32) return res.status(400).json({ error: "token 必須" });

    const snap = await admin.firestore().collection("guestRegistrations")
      .where("editToken", "==", token).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: "該当データなし (token 期限切れ or 無効)" });

    const d = snap.docs[0].data();

    // 有効期限チェック
    const exp = d.editTokenExpiresAt;
    if (exp) {
      const expMs = exp.toMillis ? exp.toMillis() : (exp._seconds ? exp._seconds * 1000 : 0);
      if (expMs && expMs < Date.now()) return res.status(410).json({ error: "token 期限切れ" });
    }

    // 公開可能フィールドのみ (個人情報は一切含めない)
    res.json({
      propertyId: d.propertyId || null,
      propertyName: d.propertyName || null,
      checkIn: d.checkIn || null,
      checkOut: d.checkOut || null,
      guestCount: d.guestCount || null,
      transport: d.transport || null,
      carCount: d.carCount || null,
      vehicleTypes: d.vehicleTypes || [],
      parkingAllocation: d.parkingAllocation || null,
      paidParking: d.paidParking || null,
      // 有料駐車場の車種情報 (guestRegistration に保存されている場合のみ返す)
      // ※ フォームに車種入力がなければ空文字で返す (将来追加予定)
      paidParkingVehicleType: d.paidParkingVehicleType || "",
      paidParkingNote: d.paidParkingNote || "",
      bbq: d.bbq || null,
      bedChoice: d.bedChoice || null,
    });
  } catch (e) {
    console.error("[public/guest-allocation] エラー:", e);
    res.status(500).json({ error: "取得失敗" });
  }
});

// POST /public/upload-failed
// ゲストフォームのパスポート写真アップロード失敗を記録 + 管理者へ通知
// body: { propertyId, propertyName, guestEmail, guestName, errorMessage, attemptCount }
router.post("/upload-failed", express.json(), async (req, res) => {
  try {
    const db = admin.firestore();
    const { propertyId, propertyName, guestEmail, guestName, errorMessage, attemptCount } = req.body || {};
    const safeMsg = String(errorMessage || "").slice(0, 500);
    const attempt = parseInt(attemptCount || 1, 10);

    // 1) error_logs に記録 (運用診断用)
    await db.collection("error_logs").add({
      type: "passport_upload_failed",
      functionName: "guest_form",
      message: `パスポート写真アップロード失敗 (試行 ${attempt}回目): ${safeMsg}`,
      propertyId: propertyId || null,
      propertyName: propertyName || "",
      guestName: guestName || "",
      guestEmail: guestEmail || "",
      attemptCount: attempt,
      severity: attempt >= 3 ? "high" : "warning",
      createdAt: new Date(),
    });

    // 2) 管理者へ通知 (3回目以降のみ通知 → 過剰通知を防ぐ)
    if (attempt >= 3) {
      try {
        const { notifyByKey } = require("../utils/lineNotify");
        await notifyByKey(db, "passport_upload_failed", {
          title: `パスポート写真 アップロード失敗 (3回目)`,
          body: `📷 パスポート写真のアップロードに繰り返し失敗しています\n\n物件: ${propertyName || "(不明)"}\nゲスト: ${guestName || "(不明)"} ${guestEmail ? "(" + guestEmail + ")" : ""}\nエラー: ${safeMsg}\n\nゲストにフォローアップしてください。`,
          vars: {
            property: propertyName || "",
            guest: guestName || "",
            email: guestEmail || "",
            error: safeMsg,
          },
          propertyId: propertyId || null,
        });
      } catch (notifyErr) {
        console.warn("[upload-failed] 管理者通知失敗:", notifyErr.message);
      }
    }

    res.json({ ok: true, attemptCount: attempt });
  } catch (e) {
    console.error("[public/upload-failed]", e);
    // ゲスト側のフォーム送信を妨げないよう 200 で返す
    res.status(200).json({ ok: false, error: e.message });
  }
});

// GET /public/upcoming-bookings/:propertyId
// 該当物件の未来 booking (status=confirmed, checkIn >= today JST) を返す
// 個人情報 (guestName) は除外、ゲストフォームの CI/CO デフォルト値補完用
router.get("/upcoming-bookings/:propertyId", async (req, res) => {
  try {
    const pid = req.params.propertyId;
    if (!pid) return res.status(400).json({ error: "propertyId 必須" });
    // 物件存在チェック
    const propDoc = await admin.firestore().collection("properties").doc(pid).get();
    if (!propDoc.exists || propDoc.data().active === false) {
      return res.status(404).json({ error: "物件が見つかりません" });
    }
    // 今日 (JST) 以降の未来 booking
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const snap = await admin.firestore().collection("bookings")
      .where("propertyId", "==", pid)
      .where("status", "==", "confirmed")
      .where("checkIn", ">=", today)
      .orderBy("checkIn", "asc")
      .limit(10)
      .get();
    const items = snap.docs.map(d => {
      const x = d.data();
      return {
        checkIn: x.checkIn,
        checkOut: x.checkOut,
        guestCount: x.guestCount || null,
        source: x.source || "",
      };
    });
    res.json({ propertyId: pid, items });
  } catch (e) {
    console.error("[public/upcoming-bookings]", e);
    res.status(500).json({ error: e.message });
  }
});

// GET /public/booking-prefill/:bookingId
// ゲストフォーム (/form/{bookingId}) の prefill 用に単一予約の CI/CO/人数/氏名を返す。
// bookingId は各ゲストに配られるランダムID (capability) 前提。物件全体は列挙しない。
// (匿名認証ユーザーの bookings 直読みを rules で禁止したため、この公開APIに移行)
router.get("/booking-prefill/:bookingId", async (req, res) => {
  try {
    const bid = String(req.params.bookingId || "");
    if (!bid) return res.status(400).json({ error: "bookingId 必須" });
    const doc = await admin.firestore().collection("bookings").doc(bid).get();
    if (!doc.exists) return res.status(404).json({ error: "予約が見つかりません" });
    const b = doc.data();
    // Timestamp/Date/文字列を JST の YYYY-MM-DD に正規化
    const toYmd = (v) => {
      if (!v) return "";
      const d = v.toDate ? v.toDate() : (v._seconds != null ? new Date(v._seconds * 1000) : new Date(v));
      if (isNaN(d.getTime())) return "";
      return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    };
    res.json({
      checkIn: toYmd(b.checkIn),
      checkOut: toYmd(b.checkOut),
      guestCount: b.guestCount || null,
      guestName: b.guestName || "",
    });
  } catch (e) {
    console.error("[public/booking-prefill]", e);
    res.status(500).json({ error: e.message });
  }
});

// GET /public/staff-ical/:token
// スタッフ専用 iCal フィード (Google カレンダーが定期取得して購読)
// recruitments の selectedStaffIds に staff.id が含まれる = 確定済みシフトをイベント化
router.get("/staff-ical/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token || token.length < 32) return res.status(400).send("invalid token");
    const db = admin.firestore();
    const sSnap = await db.collection("staff").where("googleCalendarToken", "==", token).limit(1).get();
    if (sSnap.empty) return res.status(404).send("not found");
    const sDoc = sSnap.docs[0];
    const staff = sDoc.data();
    if (staff.googleCalendarEnabled === false) {
      return res.status(403).send("calendar sync disabled");
    }
    // 確定済み recruitments を取得 (過去 30 日まで含む)
    // index 不要のため array-contains のみで取得、 日付フィルタはクライアント側
    const today = new Date();
    const past = new Date(today.getTime() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const recSnapAll = await db.collection("recruitments")
      .where("selectedStaffIds", "array-contains", sDoc.id)
      .get();
    const recSnap = { docs: recSnapAll.docs.filter(d => {
      const co = String(d.data().checkoutDate || "").slice(0, 10);
      return co && co >= past;
    }) };
    // 物件マスタを propertyId ごとに 1 回だけ取得 (キャッシュ)
    const propIds = [...new Set(recSnap.docs.map(d => d.data().propertyId).filter(Boolean))];
    const propCache = {};
    for (const pid of propIds) {
      try {
        const pd = await db.collection("properties").doc(pid).get();
        if (pd.exists) propCache[pid] = pd.data();
      } catch (_) {}
    }
    // 物件マスタから清掃/点検の開始・終了時刻を決定するヘルパー
    function resolveTimes(prop, workType) {
      if (!prop) return null;
      const baseStart = prop.baseWorkTime?.start || "";
      const baseEnd = prop.baseWorkTime?.end || "";
      let start, end;
      if (workType === "pre_inspection") {
        start = prop.inspectionStartTime || "10:00";
        const [h, m] = start.split(":").map(Number);
        const total = h * 60 + m + 60;
        end = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      } else {
        start = prop.cleaningStartTime || baseStart || "10:30";
        if (baseEnd) {
          end = baseEnd;
        } else {
          const dur = Number(prop.cleaningDuration) > 0 ? Number(prop.cleaningDuration) : 90;
          const [h, m] = start.split(":").map(Number);
          const total = h * 60 + m + dur;
          end = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
        }
      }
      return { start, end };
    }

    const events = [];
    for (const rd of recSnap.docs) {
      const r = rd.data();
      if (r.status !== "スタッフ確定済み") continue;
      const date = String(r.checkoutDate || "").slice(0, 10); // YYYY-MM-DD
      if (!date) continue;
      const propertyName = r.propertyName || "";
      const workLabel = r.workType === "pre_inspection" ? "直前点検" : "清掃";
      // 該当募集の詳細モーダルを直接開けるよう recruitmentId 付き
      const url = `${await getAppUrl(db)}/#/my-recruitment/${rd.id}`;
      const times = resolveTimes(propCache[r.propertyId], r.workType);
      events.push({
        uid: `${workLabel === "清掃" ? "cleaning" : "inspection"}-${rd.id}-${sDoc.id}@minpaku-v2`,
        date,
        startTime: times ? times.start : null,
        endTime: times ? times.end : null,
        summary: `${workLabel}: ${propertyName}`,
        description: `担当: ${r.selectedStaff || ""}\\n${times ? `時間: ${times.start}〜${times.end}\\n` : ""}物件: ${propertyName}\\n詳細: ${url}`,
        location: propertyName,
      });
    }
    // ICS 構築 (時間付き対応)
    const now = new Date();
    const dtstamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    function ymdC(ymd) { return String(ymd || "").replace(/-/g, ""); }
    function nextYmdC(ymd) {
      const d = new Date(String(ymd) + "T00:00:00.000Z");
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10).replace(/-/g, "");
    }
    function hms(hm) {
      const m = String(hm || "").match(/^(\d{1,2}):(\d{2})/);
      if (!m) return null;
      return `${String(parseInt(m[1], 10)).padStart(2, "0")}${String(parseInt(m[2], 10)).padStart(2, "0")}00`;
    }
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//minpaku-v2//Staff Calendar//JA",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:清掃シフト (${staff.name || "スタッフ"})`,
      "X-WR-TIMEZONE:Asia/Tokyo",
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      "X-PUBLISHED-TTL:PT1H",
    ];
    for (const ev of events) {
      const startHms = hms(ev.startTime);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${ev.uid}`,
        `DTSTAMP:${dtstamp}`,
      );
      if (startHms) {
        // endTime が startTime 以下なら翌日
        let endDate = ev.date;
        const sM = ev.startTime.split(":").map(Number);
        const eM = ev.endTime.split(":").map(Number);
        if (eM[0] * 60 + eM[1] <= sM[0] * 60 + sM[1]) {
          const d = new Date(ev.date + "T00:00:00.000Z");
          d.setUTCDate(d.getUTCDate() + 1);
          endDate = d.toISOString().slice(0, 10);
        }
        lines.push(
          `DTSTART;TZID=Asia/Tokyo:${ymdC(ev.date)}T${startHms}`,
          `DTEND;TZID=Asia/Tokyo:${ymdC(endDate)}T${hms(ev.endTime)}`,
        );
      } else {
        lines.push(
          `DTSTART;VALUE=DATE:${ymdC(ev.date)}`,
          `DTEND;VALUE=DATE:${nextYmdC(ev.date)}`,
        );
      }
      lines.push(
        `SUMMARY:${ev.summary}`,
        `DESCRIPTION:${ev.description}`,
        `LOCATION:${ev.location}`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300"); // 5 分キャッシュ
    res.send(lines.join("\r\n"));
  } catch (e) {
    console.error("[public/staff-ical]", e);
    res.status(500).send("server error");
  }
});

// GET /public/ical/:file
// 外部カレンダー (Airbnb / Booking.com) 向け 予約ブロック iCal フィード
// :file = "<token>.ics"。トークンは icalFeeds/{token} で解決 (物件×プラットフォーム毎に発行)
// - includeSources で含める予約種別を制御 (既定 ["direct"]=直販予約のみ → 取込ループ構造的に不可能)
// - SUMMARY にゲスト名等の個人情報は載せない
// - DTEND はチェックアウト日 (RFC5545 非包含 = CO日はブロックされない)
router.get("/ical/:file", async (req, res) => {
  try {
    const file = String(req.params.file || "");
    if (!/\.ics$/i.test(file)) return res.status(404).send("not found");
    const token = file.replace(/\.ics$/i, "");
    if (token.length < 32) return res.status(404).send("not found");
    const db = admin.firestore();
    const feedRef = db.collection("icalFeeds").doc(token);
    const feedDoc = await feedRef.get();
    if (!feedDoc.exists) return res.status(404).send("not found");
    const feed = feedDoc.data();
    if (feed.active === false) return res.status(403).send("feed disabled");
    const includeSources = (Array.isArray(feed.includeSources) && feed.includeSources.length > 0)
      ? feed.includeSources : ["direct"];

    // 予約の source を includeSources のキーに正規化
    function srcKey(b) {
      if (b.syncSource === "direct" || b.source === "direct") return "direct";
      const s = String(b.source || "");
      if (/airbnb/i.test(s)) return "airbnb";
      if (/booking/i.test(s)) return "booking";
      return "other";
    }
    // checkIn/checkOut の型混在 (文字列/Timestamp) を YYYY-MM-DD に正規化
    function ymd(v) {
      if (!v) return "";
      if (typeof v.toDate === "function") return v.toDate().toISOString().slice(0, 10);
      return String(v).slice(0, 10);
    }

    // where 1本 (propertyId) + JS フィルタで複合 index 不要
    const snap = await db.collection("bookings")
      .where("propertyId", "==", feed.propertyId)
      .get();
    const pastCut = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
    const events = [];
    for (const d of snap.docs) {
      const b = d.data();
      if (b.status !== "confirmed") continue;
      if (!includeSources.includes(srcKey(b))) continue;
      const ci = ymd(b.checkIn);
      let co = ymd(b.checkOut);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ci)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(co) || co <= ci) {
        // checkOut 欠落/同日 (syncIcal は checkOut||checkIn を入れる) → 1泊としてブロック
        const dt = new Date(ci + "T00:00:00.000Z");
        dt.setUTCDate(dt.getUTCDate() + 1);
        co = dt.toISOString().slice(0, 10);
      }
      if (co < pastCut) continue; // 過去分は直近7日まで
      events.push({ id: d.id, ci, co });
    }
    events.sort((a, b) => a.ci.localeCompare(b.ci));

    const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const c = (s) => s.replace(/-/g, "");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//minpaku-v2//Booking Blocks//JA",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${feed.propertyName || "予約ブロック"} (minpaku-v2)`,
      "X-WR-TIMEZONE:Asia/Tokyo",
    ];
    for (const ev of events) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:booking-${ev.id}@minpaku-v2`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${c(ev.ci)}`,
        `DTEND;VALUE=DATE:${c(ev.co)}`,
        "SUMMARY:Reserved",
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");

    // 鮮度記録 (同期死活監視用)。失敗しても配信は継続
    feedRef.set({
      lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastFetchUa: String(req.get("user-agent") || "").slice(0, 200),
      fetchCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true }).catch((e) => console.warn("[public/ical] 鮮度記録失敗:", e.message));

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300"); // 5分キャッシュ
    res.send(lines.join("\r\n") + "\r\n");
  } catch (e) {
    console.error("[public/ical]", e);
    res.status(500).send("server error");
  }
});

// POST /public/guest-register
// ゲストフォーム新規登録 (重複チェック付き)
// body: { ...guestData, force?: boolean }
//   force=true の場合は重複チェックをスキップして登録
router.post("/guest-register", express.json({ limit: "5mb" }), async (req, res) => {
  try {
    const db = admin.firestore();
    const body = req.body || {};
    const force = body.force === true;

    const propertyId = String(body.propertyId || "");
    if (!propertyId) return res.status(400).json({ error: "propertyId 必須" });

    // ===== 重複チェック =====
    if (!force) {
      // 同一物件の submitted/confirmed 名簿を取得
      const existingSnap = await db.collection("guestRegistrations")
        .where("propertyId", "==", propertyId)
        .where("status", "in", ["submitted", "confirmed"])
        .get();

      // 正規化ヘルパー
      const normName = (s) => String(s || "").replace(/\s+/g, " ").replace(/　/g, " ").trim().toLowerCase();
      const normEmail = (s) => String(s || "").toLowerCase().trim();
      const normPhone = (s) => String(s || "").replace(/-/g, "").replace(/\s/g, "").trim();

      const inputName  = normName(body.guestName);
      const inputEmail = normEmail(body.email);
      const inputPhone = normPhone(body.phone);

      let hit = null;
      for (const doc of existingSnap.docs) {
        const d = doc.data();
        const nameMatch  = inputName  && normName(d.guestName)  === inputName;
        const emailMatch = inputEmail && normEmail(d.email)      === inputEmail;
        const phoneMatch = inputPhone && normPhone(d.phone)      === inputPhone;
        if (nameMatch || emailMatch || phoneMatch) {
          hit = { id: doc.id, ...d };
          break;
        }
      }

      if (hit) {
        return res.status(409).json({
          error: "duplicate",
          existingId:        hit.id,
          existingEditToken: hit.editToken || null,
          existingCheckIn:   hit.checkIn   || null,
          existingGuestName: hit.guestName || null,
        });
      }
    }

    // ===== 新規登録 =====
    // force=true でスキップされた重複候補がある場合は status を "duplicate_override" でマーク
    const data = { ...body };
    delete data.force; // force フラグはDB保存しない
    // undefined を除去 (Firestoreが受け付けない)
    Object.keys(data).forEach(k => { if (data[k] === undefined) delete data[k]; });

    // サーバー側でタイムスタンプを上書き保証
    data.submittedAt  = admin.firestore.FieldValue.serverTimestamp();
    data.createdAt    = admin.firestore.FieldValue.serverTimestamp();
    data.updatedAt    = admin.firestore.FieldValue.serverTimestamp();

    const docRef = await db.collection("guestRegistrations").add(data);
    return res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    console.error("[public/guest-register]", e);
    return res.status(500).json({ error: e.message });
  }
});

// GET /public/terrace-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// the Terrace 長浜 専用 公開カレンダー (近隣住民向け / ログイン不要)
// 確定予約 (status=confirmed) のみ返す。
// PII は一切返さない: 氏名・住所・電話番号・メール・旅券番号・パスポート写真・緊急連絡先 は除外。
// 近隣が知りたい非個人情報 (滞在期間・人数・予約サイト・車/駐車・BBQ・騒音同意・目的等) のみ返す。
const TERRACE_NAGAHAMA_ID = "tsZybhDMcPrxqgcRy7wp";

router.get("/terrace-calendar", async (req, res) => {
  try {
    const db = admin.firestore();
    const pid = TERRACE_NAGAHAMA_ID;

    // 期間決定 (未指定なら当月 1日〜月末 / JST基準)
    const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    let from = String(req.query.from || "").slice(0, 10);
    let to = String(req.query.to || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) from = `${todayJst.slice(0, 7)}-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const [y, m] = from.split("-").map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // from の月末日
      to = `${from.slice(0, 7)}-${String(last).padStart(2, "0")}`;
    }
    // 連泊が窓の前から続くケースを拾うため、取得下限を 31 日前まで広げる
    const fromBuf = (() => {
      const d = new Date(`${from}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 31);
      return d.toISOString().slice(0, 10);
    })();

    // 物件名
    let propertyName = "the Terrace 長浜";
    try {
      const propDoc = await db.collection("properties").doc(pid).get();
      if (propDoc.exists && propDoc.data().name) propertyName = propDoc.data().name;
    } catch (_) {}

    // 予約取得 (propertyId + checkIn の既存インデックスを使用、status はメモリ側で絞る)
    const bSnap = await db.collection("bookings")
      .where("propertyId", "==", pid)
      .where("checkIn", ">=", fromBuf)
      .where("checkIn", "<=", to)
      .orderBy("checkIn", "asc")
      .get();

    // guestRegistrations を物件分まとめて取得 (propertyId 単一フィールドのみ → 自動インデックス)
    // 複合キー (`pid_checkIn`) と bookingId でマップ化
    const gSnap = await db.collection("guestRegistrations").where("propertyId", "==", pid).get();
    const gByKey = new Map();
    const gById = new Map();
    gSnap.forEach((doc) => {
      const d = doc.data();
      if (!["submitted", "confirmed"].includes(d.status || "")) return; // 提出済/確定のみ
      const ci = String(d.checkIn || "").slice(0, 10);
      if (ci) {
        const k = `${pid}_${ci}`;
        if (!gByKey.has(k)) gByKey.set(k, d);
      }
      if (d.bookingId) gById.set(d.bookingId, d);
    });

    const spotLabel = (k) => ({ unpaved: "未舗装駐車場", spot1: "1番", spot5: "5番", paid: "有料駐車場" }[k] || k || "");

    const bookings = [];
    bSnap.forEach((doc) => {
      const b = doc.data();
      if ((b.status || "") !== "confirmed") return; // 確定予約のみ
      const ci = String(b.checkIn || "").slice(0, 10);
      const co = String(b.checkOut || "").slice(0, 10);
      if (!ci || !co) return;
      if (co <= from) return; // 窓より前に終了する連泊は除外

      // 名簿データ解決: bookingId 優先 → 複合キー
      const g = gById.get(doc.id) || gByKey.get(`${pid}_${ci}`) || {};

      // 同行者は 年齢・国籍 のみ (氏名・住所・旅券番号は返さない)
      const companions = Array.isArray(g.guests)
        ? g.guests.map((c) => ({ age: c.age || "", nationality: c.nationality || "日本" }))
        : [];
      const parkingAllocation = Array.isArray(g.parkingAllocation)
        ? g.parkingAllocation.map((a) => ({
            index: a.index,
            vehicleType: a.vehicleType || "",
            spotLabel: spotLabel(a.spot),
          }))
        : [];

      bookings.push({
        id: doc.id,
        checkIn: ci,
        checkOut: co,
        checkInTime: g.checkInTime || "",
        checkOutTime: g.checkOutTime || "",
        source: b.source || b.bookingSite || "",
        guestCount: b.guestCount || g.guestCount || null,
        guestCountInfants: g.guestCountInfants || null,
        nationality: g.nationality || b.nationality || "",
        repAge: (g.allGuests && g.allGuests[0] && g.allGuests[0].age) || "",
        purpose: g.purpose || "",
        bbq: g.bbq === undefined ? null : g.bbq,
        bedChoice: g.bedChoice || "",
        transport: g.transport || "",
        carCount: g.carCount || null,
        vehicleTypes: Array.isArray(g.vehicleTypes) ? g.vehicleTypes : [],
        paidParking: g.paidParking || "",
        parkingAllocation,
        noiseAgree: g.noiseAgree === true,
        previousStay: g.previousStay || "",
        nextStay: g.nextStay || "",
        companions,
        hasRoster: Object.keys(g).length > 0,
      });
    });

    res.set("Cache-Control", "public, max-age=300"); // 5分キャッシュ
    res.json({ propertyId: pid, propertyName, from, to, bookings });
  } catch (e) {
    console.error("[public/terrace-calendar]", e);
    res.status(500).json({ error: e.message });
  }
});

// GET /public/availability/:propertyId
// 宿公式サイト (setouchi-stay.com 群) のカレンダーウィジェットが埋まっている日付を取得する
// 認証不要。個人情報は一切含めない (ブロック日付の配列のみ)
router.get("/availability/:propertyId", async (req, res) => {
  try {
    const pid = req.params.propertyId;
    if (!pid) return res.status(400).json({ error: "propertyId 必須" });

    // where 1本 (propertyId) + JS フィルタで複合 index 不要 (既存 /ical/:file と同方針)
    const snap = await admin.firestore().collection("bookings")
      .where("propertyId", "==", pid)
      .get();

    const blockedSet = new Set();
    snap.docs.forEach((d) => {
      const b = d.data();
      if (b.status !== "confirmed") return;
      const ci = normalizeYmd(b.checkIn);
      const co = normalizeYmd(b.checkOut);
      if (!isValidYmd(ci) || !isValidYmd(co)) return;
      enumerateBlockedDates(ci, co).forEach((day) => blockedSet.add(day));
    });

    const blocked = Array.from(blockedSet).sort();

    // 料金ルール(あれば)も同梱 → 宿サイトのカレンダーが基準料金/曜日料金を表示できる。
    // 存在しない物件は pricing:null (サイト側は料金非表示でフォールバック)。
    let pricing = null;
    try {
      const ratesDoc = await admin.firestore().collection("propertyRates").doc(pid).get();
      if (ratesDoc.exists) {
        const r = ratesDoc.data();
        pricing = {
          currency: r.currency || "JPY",
          basePrice: Number.isFinite(Number(r.basePrice)) ? Number(r.basePrice) : null,
          weekendPrice: Number.isFinite(Number(r.weekendPrice)) ? Number(r.weekendPrice) : null,
          weekendDays: Array.isArray(r.weekendDays) ? r.weekendDays : [5, 6],
          seasons: Array.isArray(r.seasons)
            ? r.seasons.map((s) => ({
                start: s.start,
                end: s.end,
                price: Number.isFinite(Number(s.price)) ? Number(s.price) : null,
                weekendPrice: Number.isFinite(Number(s.weekendPrice)) ? Number(s.weekendPrice) : null,
              }))
            : [],
          lengthOfStayDiscounts: Array.isArray(r.lengthOfStayDiscounts) ? r.lengthOfStayDiscounts : [],
          guestSurcharge: (r.guestSurcharge && typeof r.guestSurcharge === "object") ? r.guestSurcharge : null,
          minNights: Number.isFinite(Number(r.minNights)) ? Number(r.minNights) : 1,
        };
      }
    } catch (rErr) {
      console.warn("[public/availability] pricing 取得失敗:", rErr.message);
    }

    res.set("Cache-Control", "public, max-age=300"); // 5分キャッシュ
    res.json({ blocked, pricing });
  } catch (e) {
    console.error("[public/availability]", e);
    res.status(500).json({ error: e.message });
  }
});

// GET /public/quote/:propertyId?checkIn&checkOut&guests&plan
// 宿公式サイトの予約フォーム見積用。propertyRates マスタ + 日別 overrides から料金を計算して返す。
// 認証不要・個人情報なし。料金未設定の物件は hasRates:false を返す(サイト側でフォールバック)。
router.get("/quote/:propertyId", async (req, res) => {
  try {
    const pid = req.params.propertyId;
    if (!pid) return res.status(400).json({ error: "propertyId 必須" });
    const checkIn = String(req.query.checkIn || "").slice(0, 10);
    const checkOut = String(req.query.checkOut || "").slice(0, 10);
    const guests = parseInt(req.query.guests, 10) || 1;
    const plan = String(req.query.plan || "standard");
    if (!isValidYmd(checkIn) || !isValidYmd(checkOut)) {
      return res.status(400).json({ error: "checkIn/checkOut の形式が不正です" });
    }

    const db = admin.firestore();
    const ratesDoc = await db.collection("propertyRates").doc(pid).get();
    if (!ratesDoc.exists) {
      res.set("Cache-Control", "public, max-age=300");
      return res.json({ propertyId: pid, hasRates: false });
    }
    const rates = ratesDoc.data();

    // 期間内の日別上書き(overrides)を取得。documentId(YYYY-MM-DD)の範囲取得で複合index不要。
    const overrides = {};
    try {
      const ovSnap = await db.collection("propertyRates").doc(pid).collection("overrides")
        .where(admin.firestore.FieldPath.documentId(), ">=", checkIn)
        .where(admin.firestore.FieldPath.documentId(), "<", checkOut)
        .get();
      ovSnap.forEach((d) => { overrides[d.id] = d.data(); });
    } catch (ovErr) {
      console.warn("[public/quote] overrides 取得失敗:", ovErr.message);
    }

    const result = computeQuote({ rates, checkIn, checkOut, guests, plan, overrides });
    if (!result.ok) return res.status(400).json({ error: result.error });

    res.set("Cache-Control", "public, max-age=300"); // 5分キャッシュ
    res.json({ propertyId: pid, hasRates: true, ...result.quote });
  } catch (e) {
    console.error("[public/quote]", e);
    res.status(500).json({ error: e.message });
  }
});

// POST /public/booking-request
// 宿公式サイトからの直接予約リクエストを受け付ける (承認制)
// bookingRequests コレクションに保存するのみで bookings には一切書き込まない
// (detectDoubleBooking の誤警報 / syncIcal のゴーストガード誤スキップを防ぐため)
// body: { propertyId, checkIn, checkOut, guests, name, email, plan, notes, website, elapsedMs, turnstileToken }
router.post("/booking-request", express.json(), async (req, res) => {
  try {
    const db = admin.firestore();
    const body = req.body || {};
    const propertyId = String(body.propertyId || "");
    if (!propertyId) return res.status(400).json({ error: "propertyId 必須" });

    // ===== 受付ゲート =====
    // settings/directBooking.enabled が true のときだけ受け付ける (既定は無効)。
    // 公開前・準備中は API 自体を閉じ、認証不要エンドポイントへの空リクエスト大量投入や
    // 物件 Gmail を踏み台にしたメール送信の悪用を防ぐ。
    // Turnstile 設定 (turnstileSecret) + enabled:true をセットにして受付を開始する運用。
    const directCfgSnap = await db.collection("settings").doc("directBooking").get();
    const directCfg = directCfgSnap.exists ? directCfgSnap.data() : {};
    if (directCfg.enabled !== true) {
      return res.status(403).json({ error: "現在、直接予約の受付を停止しています。" });
    }

    // 物件存在チェック
    const propDoc = await db.collection("properties").doc(propertyId).get();
    if (!propDoc.exists || propDoc.data().active === false) {
      return res.status(404).json({ error: "物件が見つかりません" });
    }
    const property = propDoc.data();

    // ===== スパム対策 =====
    // ハニーポット入力あり or 表示から1.5秒未満での送信 → 200 を返すが実際は保存しない (bot に成功と見せる)
    if (isSpamSubmission(body)) {
      console.warn(`[public/booking-request] スパム疑いのため保存スキップ (propertyId=${propertyId})`);
      return res.status(200).json({ ok: true });
    }

    // ===== 入力検証 =====
    const validation = validateBookingRequest(body, property);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const checkIn = String(body.checkIn).slice(0, 10);
    const checkOut = String(body.checkOut).slice(0, 10);
    const guests = parseInt(body.guests, 10);
    const name = String(body.name).trim();
    const email = String(body.email).trim();
    const plan = String(body.plan || "standard");
    const notes = String(body.notes || "").slice(0, 1000);

    // ===== Cloudflare Turnstile 検証 =====
    // settings/directBooking.turnstileSecret が未設定の場合は検証をスキップする (段階導入対応)
    const turnstileSecret = await getTurnstileSecret(db);
    if (turnstileSecret) {
      const remoteIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
      const verify = await verifyTurnstileToken(turnstileSecret, body.turnstileToken, remoteIp);
      if (!verify.success) {
        console.warn(`[public/booking-request] Turnstile 検証失敗:`, verify.errorCodes);
        return res.status(400).json({ error: "ロボット確認に失敗しました。もう一度お試しください。" });
      }
    }

    // where 1本 (propertyId) + JS フィルタで複合 index 不要 (既存 /ical/:file 等と同方針)
    // 日次上限チェックと email 重複チェックの両方をこの1回の取得で賄う
    const propRequestsSnap = await db.collection("bookingRequests")
      .where("propertyId", "==", propertyId)
      .get();

    // ===== 物件ごと日次上限 (10件/日) =====
    const today = todayJst();
    const todayCount = propRequestsSnap.docs.filter((d) => {
      const x = d.data();
      const createdAtDate = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : null;
      const createdStr = createdAtDate ? createdAtDate.toISOString().slice(0, 10) : "";
      return createdStr === today;
    }).length;
    if (todayCount >= 10) {
      return res.status(429).json({ error: "本日のリクエスト受付上限に達しました。しばらくしてから再度お試しください。" });
    }

    // ===== 同一 email の pending が同物件に既にあれば 409 =====
    const normEmail = email.toLowerCase();
    const dupPending = propRequestsSnap.docs.some((d) => {
      const x = d.data();
      return x.status === "pending" && String(x.email || "").toLowerCase() === normEmail;
    });
    if (dupPending) {
      return res.status(409).json({ error: "同じメールアドレスで受付中のリクエストが既にあります" });
    }

    // ===== 重複チェック: 確定済み予約との日程重複 =====
    const bookingsSnap = await db.collection("bookings")
      .where("propertyId", "==", propertyId)
      .get();
    const overlap = bookingsSnap.docs.some((d) => {
      const b = d.data();
      if (b.status !== "confirmed") return false;
      const bCi = normalizeYmd(b.checkIn);
      const bCo = normalizeYmd(b.checkOut);
      return periodsOverlap(checkIn, checkOut, bCi, bCo);
    });
    if (overlap) {
      return res.status(409).json({ error: "selected_dates_unavailable" });
    }

    // ===== 保存 =====
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
    const ua = String(req.get("user-agent") || "").slice(0, 300);
    const docRef = await db.collection("bookingRequests").add({
      propertyId,
      propertyName: property.name || "",
      checkIn,
      checkOut,
      guestCount: guests,
      guestName: name,
      email,
      plan,
      notes,
      status: "pending",
      ip,
      ua,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ===== オーナー通知 (手動即時送信の既存流儀: _fromBatchQueue で即時送信) =====
    try {
      const { notifyByKey } = require("../utils/lineNotify");
      const appUrl = await getAppUrl(db);
      await notifyByKey(db, "direct_request", {
        title: "直接予約リクエスト受信",
        body: `📩 直接予約のリクエストが届きました\n\n宿: ${property.name || propertyId}\n日程: ${checkIn} 〜 ${checkOut}\n人数: ${guests}名\nプラン: ${plan === "nonrefundable" ? "返金不可割引" : "スタンダード"}\nお名前: ${name}\n\n確認・承認: ${appUrl}/#/booking-requests`,
        vars: {
          // booking varGroup 準拠: date=チェックアウト日, checkin=チェックイン日, guest=ゲスト名
          property: property.name || "",
          checkin: checkIn,
          date: checkOut,
          guest: `${name} (${guests}名)`,
          url: `${appUrl}/#/booking-requests`,
        },
        propertyId,
        _fromBatchQueue: true,
      });
    } catch (notifyErr) {
      console.warn("[public/booking-request] オーナー通知失敗:", notifyErr.message);
    }

    // ===== ゲスト受付メール (失敗しても 200 は返す) =====
    try {
      const { sendNotificationEmail_, resolveSenderGmail_ } = require("../utils/lineNotify");
      const senderGmail = await resolveSenderGmail_(db, propertyId);
      const subject = `【${property.name || "ご予約"}】予約リクエストを受け付けました`;
      const bodyText = [
        `${name} 様`,
        ``,
        `この度は${property.name || "当施設"}へのご予約リクエストをありがとうございます。`,
        `以下の内容で承りました。`,
        ``,
        `■リクエスト内容`,
        `チェックイン: ${checkIn}`,
        `チェックアウト: ${checkOut}`,
        `人数: ${guests}名`,
        `プラン: ${plan === "nonrefundable" ? "返金不可割引" : "スタンダード"}`,
        ``,
        `オーナーが内容を確認のうえ、24時間以内に承認可否をご連絡いたします。`,
        `今しばらくお待ちください。`,
      ].join("\n");
      await sendNotificationEmail_(email, subject, bodyText, senderGmail || null);
    } catch (mailErr) {
      console.warn("[public/booking-request] ゲスト受付メール送信失敗:", mailErr.message);
    }

    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    console.error("[public/booking-request]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
