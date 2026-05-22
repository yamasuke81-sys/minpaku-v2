/**
 * 認証不要の公開API
 * ゲストフォームが必要な物件設定のみを返す (whitelist方式)
 */
const express = require("express");
const admin = require("firebase-admin");

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
    const today = new Date();
    const past = new Date(today.getTime() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const recSnap = await db.collection("recruitments")
      .where("selectedStaffIds", "array-contains", sDoc.id)
      .where("checkoutDate", ">=", past)
      .get();
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
      const url = `https://minpaku-v2.web.app/#/my-recruitment`;
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

module.exports = router;
