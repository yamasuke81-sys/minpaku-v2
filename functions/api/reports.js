/**
 * 定期報告 API
 * 住宅宿泊事業法14条 — 2ヶ月ごとの定期報告データ集計・記録
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function reportsApi(db) {
  const router = Router();

  /**
   * 報告期間の定義
   * 偶数月1日にメール受信 → 翌月15日が期限
   * 例: 4月1日受信 → 2月・3月分を → 5月15日までに報告
   */
  function getReportPeriods() {
    const now = new Date();
    const year = now.getFullYear();
    const periods = [];

    for (let m = 2; m <= 12; m += 2) {
      const targetMonth1 = m - 2 || 12;
      const targetMonth2 = m - 1 || 1;
      const targetYear1 = m === 2 ? year - 1 : year;
      const targetYear2 = m === 2 ? year : year;
      const deadlineMonth = m + 1 > 12 ? 1 : m + 1;
      const deadlineYear = m + 1 > 12 ? year + 1 : year;

      periods.push({
        id: `${year}-${String(m).padStart(2, "0")}`,
        notifyMonth: m,
        notifyYear: year,
        targetMonths: [
          { year: targetYear1, month: targetMonth1 },
          { year: targetYear2, month: targetMonth2 },
        ],
        deadline: `${deadlineYear}-${String(deadlineMonth).padStart(2, "0")}-15`,
        label: `${targetYear1}年${targetMonth1}月・${targetYear2}年${targetMonth2}月`,
      });
    }
    return periods;
  }

  /**
   * 日本人判定: "日本", "Japan", "日本 / Japan", "日本/Japan" 等すべて日本人
   */
  function isJapanese(nat) {
    const n = (nat || "日本").trim().toLowerCase();
    return n === "日本" || n === "japan" || n.includes("日本") || /^japan\b/i.test(n);
  }

  /**
   * プレースホルダ名判定（iCal同期で自動生成された仮名）
   */
  function isPlaceholderName(name) {
    if (!name) return true;
    const n = name.trim().toLowerCase();
    return !n || n === "-" ||
      n.includes("airbnb") || n.includes("booking.com") ||
      n.includes("not available") || n.includes("closed") ||
      n.includes("予約") || n.includes("blocked");
  }

  /**
   * 指定月に滞在日数が重なる泊数を計算
   */
  function calcNightsInMonth(checkIn, checkOut, year, month) {
    if (!checkIn || !checkOut) return 0;
    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    if (isNaN(ci) || isNaN(co) || co <= ci) return 0;

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 1);
    const overlapStart = ci > monthStart ? ci : monthStart;
    const overlapEnd = co < monthEnd ? co : monthEnd;
    const nights = Math.ceil((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24));
    return nights > 0 ? nights : 0;
  }

  function calcStayNights(checkIn, checkOut) {
    if (!checkIn || !checkOut) return 0;
    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    if (isNaN(ci) || isNaN(co)) return 0;
    const diff = Math.ceil((co - ci) / (1000 * 60 * 60 * 24));
    return diff > 0 ? diff : 0;
  }

  // === 報告期間一覧取得 ===
  router.get("/periods", async (req, res) => {
    try {
      const periods = getReportPeriods();
      const reportsSnap = await db.collection("reports").get();
      const reportMap = {};
      reportsSnap.docs.forEach((doc) => {
        reportMap[doc.id] = doc.data();
      });

      const result = periods.map((p) => ({
        ...p,
        submitted: !!reportMap[p.id]?.submittedAt,
        submittedAt: reportMap[p.id]?.submittedAt || null,
        memo: reportMap[p.id]?.memo || "",
      }));

      res.json(result);
    } catch (e) {
      console.error("報告期間一覧取得エラー:", e);
      res.status(500).json({ error: "報告期間の取得に失敗しました" });
    }
  });

  // === 指定期間の集計データ取得 ===
  router.get("/aggregate", async (req, res) => {
    try {
      const { year1, month1, year2, month2 } = req.query;
      if (!year1 || !month1 || !year2 || !month2) {
        return res.status(400).json({ error: "year1, month1, year2, month2 は必須です" });
      }

      const y1 = Number(year1), m1 = Number(month1);
      const y2 = Number(year2), m2 = Number(month2);

      const periodStart = `${y1}-${String(m1).padStart(2, "0")}-01`;
      const periodEndDate = new Date(y2, m2, 0);
      const periodEnd = `${y2}-${String(m2).padStart(2, "0")}-${String(periodEndDate.getDate()).padStart(2, "0")}`;

      // guestRegistrations 取得
      const guestSnap = await db.collection("guestRegistrations").get();
      const rawGuests = guestSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // bookings 取得
      const bookingSnap = await db.collection("bookings").get();
      const bookings = bookingSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // guestRegistrations 内の重複排除（同一CI+COで実名優先）
      const ciCoMap = new Map();
      for (const g of rawGuests) {
        const ci = g.checkIn, co = g.checkOut;
        if (!ci || !co) continue;
        const key = `${ci}|${co}`;
        const existing = ciCoMap.get(key);
        if (!existing) {
          ciCoMap.set(key, g);
        } else {
          const existingIsPlaceholder = isPlaceholderName(existing.guestName);
          const newIsPlaceholder = isPlaceholderName(g.guestName);
          if (existingIsPlaceholder && !newIsPlaceholder) {
            ciCoMap.set(key, g);
          }
        }
      }
      const guests = Array.from(ciCoMap.values());

      // 集計結果
      const month1Data = { year: y1, month: m1, totalNights: 0, japanese: 0, foreign: 0, byNationality: {} };
      const month2Data = { year: y2, month: m2, totalNights: 0, japanese: 0, foreign: 0, byNationality: {} };
      const details = [];

      // guestRegistrations 集計
      // 人数: 名簿のguestCount（宿泊人数）を採用
      // 国籍別: 同行者情報があればそこから、なければ代表者の国籍×人数で計算
      for (const g of guests) {
        const ci = g.checkIn;
        const co = g.checkOut;
        if (!ci || !co) continue;
        if (co < periodStart || ci > periodEnd) continue;

        const guestCount = g.guestCount || 1;
        const nationality = (g.nationality || "日本").trim();
        const companions = g.guests || [];

        // 国籍別人数の計算
        let jpCount = 0, foreignCount = 0;
        const foreignByNat = {};

        if (companions.length > 0) {
          // 同行者情報あり → 代表者 + 同行者それぞれの国籍で集計
          const allPeople = [
            { nationality },
            ...companions.map((c) => ({ nationality: (c.nationality || "日本").trim() })),
          ];
          for (const p of allPeople) {
            if (isJapanese(p.nationality)) { jpCount++; }
            else { foreignCount++; foreignByNat[p.nationality] = (foreignByNat[p.nationality] || 0) + 1; }
          }
        } else {
          // 同行者情報なし → 代表者の国籍で全員カウント
          if (isJapanese(nationality)) { jpCount = guestCount; }
          else { foreignCount = guestCount; foreignByNat[nationality] = guestCount; }
        }

        const nights1 = calcNightsInMonth(ci, co, y1, m1);
        if (nights1 > 0) {
          month1Data.totalNights += nights1;
          month1Data.japanese += jpCount;
          month1Data.foreign += foreignCount;
          for (const [nat, cnt] of Object.entries(foreignByNat)) {
            month1Data.byNationality[nat] = (month1Data.byNationality[nat] || 0) + cnt;
          }
        }

        const nights2 = calcNightsInMonth(ci, co, y2, m2);
        if (nights2 > 0) {
          month2Data.totalNights += nights2;
          month2Data.japanese += jpCount;
          month2Data.foreign += foreignCount;
          for (const [nat, cnt] of Object.entries(foreignByNat)) {
            month2Data.byNationality[nat] = (month2Data.byNationality[nat] || 0) + cnt;
          }
        }

        if (nights1 > 0 || nights2 > 0) {
          details.push({
            id: g.id,
            source: "guestRegistrations",
            guestName: g.guestName || "-",
            nationality,
            checkIn: ci,
            checkOut: co,
            guestCount,
            nights1,
            nights2,
            totalNights: calcStayNights(ci, co),
          });
        }
      }

      // 重複チェック用: guestRegistrationsに存在するCI日のセット
      const guestCiSet = new Set(details.map((d) => d.checkIn));

      // bookings 補完（guestRegistrationsにCI一致するものは除外）
      for (const b of bookings) {
        const ci = b.checkIn;
        const co = b.checkOut;
        if (!ci || !co) continue;

        const ciStr = ci.toDate ? ci.toDate().toISOString().slice(0, 10) : String(ci).slice(0, 10);
        const coStr = co.toDate ? co.toDate().toISOString().slice(0, 10) : String(co).slice(0, 10);
        if (coStr < periodStart || ciStr > periodEnd) continue;
        if (guestCiSet.has(ciStr)) continue;

        const guestCount = b.guestCount || 1;
        const nights1 = calcNightsInMonth(ciStr, coStr, y1, m1);
        const nights2 = calcNightsInMonth(ciStr, coStr, y2, m2);

        if (nights1 > 0) {
          month1Data.totalNights += nights1;
          month1Data.japanese += guestCount;
        }
        if (nights2 > 0) {
          month2Data.totalNights += nights2;
          month2Data.japanese += guestCount;
        }

        if (nights1 > 0 || nights2 > 0) {
          details.push({
            id: b.id,
            source: "bookings",
            guestName: b.guestName || "-",
            nationality: "（名簿未登録）",
            checkIn: ciStr,
            checkOut: coStr,
            guestCount,
            nights1,
            nights2,
            totalNights: calcStayNights(ciStr, coStr),
          });
        }
      }

      details.sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""));

      res.json({
        period: { start: periodStart, end: periodEnd },
        month1: month1Data,
        month2: month2Data,
        details,
        totalNights: month1Data.totalNights + month2Data.totalNights,
        totalJapanese: month1Data.japanese + month2Data.japanese,
        totalForeign: month1Data.foreign + month2Data.foreign,
      });
    } catch (e) {
      console.error("定期報告集計エラー:", e);
      res.status(500).json({ error: "集計に失敗しました" });
    }
  });

  // === 報告済みとして記録 ===
  router.post("/submit", async (req, res) => {
    try {
      const { periodId, memo } = req.body;
      if (!periodId) {
        return res.status(400).json({ error: "periodId は必須です" });
      }

      await db.collection("reports").doc(periodId).set(
        {
          periodId,
          submittedAt: FieldValue.serverTimestamp(),
          submittedBy: req.user.email || req.user.uid,
          memo: memo || "",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      res.json({ message: "報告済みとして記録しました", periodId });
    } catch (e) {
      console.error("報告記録エラー:", e);
      res.status(500).json({ error: "報告記録に失敗しました" });
    }
  });

  // === 報告済みを取消 ===
  router.post("/unsubmit", async (req, res) => {
    try {
      const { periodId } = req.body;
      if (!periodId) {
        return res.status(400).json({ error: "periodId は必須です" });
      }

      await db.collection("reports").doc(periodId).set(
        {
          periodId,
          submittedAt: null,
          submittedBy: null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      res.json({ message: "報告済みを取消しました", periodId });
    } catch (e) {
      console.error("報告取消エラー:", e);
      res.status(500).json({ error: "報告取消に失敗しました" });
    }
  });

  return router;
};
