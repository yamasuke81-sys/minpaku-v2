/**
 * スタッフ向け PII 除外済みデータ API
 *
 * スタッフ (role=staff) は Firestore の bookings / guestRegistrations を直読みできない
 * (firestore.rules で遮断)。清掃スケジュール表示に必要な最小フィールドだけを
 * このAPIがサマリ化して返す。個人情報 (guestName/住所/連絡先/パスポート/メモ等) は
 * ホワイトリスト方式で一切返さない (ブラックリスト方式だと新フィールド追加時に漏れる)。
 *
 * 担当物件はサーバー側で staff ドキュメントから確定し、クライアントが送る
 * propertyId を信用しない (改ざん対策)。
 */
const { Router } = require("express");

// Firestore Timestamp を ISO 文字列化 (素の JSON 化だと {_seconds} になりクライアントが壊れる)
function toIso_(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (v.toDate) { try { return v.toDate().toISOString(); } catch (_) { return null; } }
  if (v._seconds != null) return new Date(v._seconds * 1000).toISOString();
  return null;
}

// Timestamp/Date/文字列を JST の YYYY-MM-DD に正規化 (日付型混在に対応)
function normDate_(v) {
  if (!v) return "";
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  const d = v.toDate ? v.toDate() : (v._seconds != null ? new Date(v._seconds * 1000) : new Date(v));
  if (isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// Timestamp/Date/文字列から JST の HH:MM を導出 (00:00 は「終日」)
function toHhmm_(v) {
  if (!v) return "";
  const d = v.toDate ? v.toDate() : (v._seconds != null ? new Date(v._seconds * 1000) : new Date(v));
  if (isNaN(d.getTime())) return "";
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return (hh === "00" && mm === "00") ? "終日" : `${hh}:${mm}`;
}

function isCancelledStatus_(s) {
  const t = String(s || "").toLowerCase();
  return t.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

// ゲスト名を PII マスクする。実名は返さず、
//  - プレースホルダー(OTA ブロック等)や空 → "" (名簿未提出/ブロック扱い)
//  - 実ゲスト名 → "予約" (実予約あり、を表す非PIIの目印)
// スタッフ画面はバー描画で実名を "予約" に置換済み、名簿ドット判定は
// プレースホルダーか否かだけを見るため、このマスクで表示は完全に等価になる。
function maskGuestName_(name) {
  if (!name) return "";
  const n = String(name).trim().toLowerCase();
  if (!n || n === "-" || n.includes("airbnb") || n.includes("booking.com") ||
      n.includes("not available") || n.includes("blocked") ||
      n.includes("closed") || n.includes("reserved") || n.includes("no name")) {
    return "";
  }
  return "予約";
}

// bookings サマリ (ホワイトリスト。PII を絶対に含めない)
function toBookingSummary_(id, b) {
  return {
    id,
    propertyId: b.propertyId || "",
    propertyName: b.propertyName || "",
    // 名簿ドット判定・マージ優先度用の非PIIマスク名 (実名は返さない)
    guestName: maskGuestName_(b.guestName),
    checkIn: normDate_(b.checkIn),
    checkOut: normDate_(b.checkOut),
    checkInTime: b.checkInTime || "",
    checkOutTime: b.checkOutTime || "",
    guestCount: b.guestCount || 0,
    source: b.source || "",
    bookingSite: b.bookingSite || "",
    status: b.status || "",
    pendingApproval: b.pendingApproval === true,
  };
}

// guestRegistrations サマリ (ホワイトリスト。PII を絶対に含めない)
// keyboxSendError はエラー文にゲストのメール等が混入しうるため除外。
// keyboxSentAt/ConfirmedAt はタイムスタンプのみで無害なので guestMap の形を保つため残す。
function toGuestSummary_(id, g) {
  return {
    id,
    bookingId: g.bookingId || "",
    propertyId: g.propertyId || "",
    // 名簿ドット判定用の非PIIマスク名 (実名は返さない)
    guestName: maskGuestName_(g.guestName),
    checkIn: normDate_(g.checkIn),
    checkOut: normDate_(g.checkOut),
    checkInTime: g.checkInTime || "",
    checkOutTime: g.checkOutTime || "",
    guestCount: g.guestCount || 0,
    guestCountInfants: g.guestCountInfants || 0,
    bbq: g.bbq || "",
    carCount: g.carCount || 0,
    paidParking: g.paidParking || "",
    bedChoice: g.bedChoice || "",
    nationality: g.nationality || "",
    parking: g.parking || "",
    transport: g.transport || "",
    vehicleTypes: Array.isArray(g.vehicleTypes) ? g.vehicleTypes : [],
    bookingSite: g.bookingSite || "",
    source: g.source || "",
    keyboxSentAt: toIso_(g.keyboxSentAt),
    keyboxConfirmedAt: toIso_(g.keyboxConfirmedAt),
  };
}

module.exports = function staffDataApi(db) {
  const router = Router();

  // スタッフ本人の担当物件をサーバー側で確定 (クライアント申告を信用しない)。
  // owner/sub_owner は Firestore 直読み権限があるためこのAPIを使わない → 403。
  async function getStaffContext_(req, res) {
    const u = req.user || {};
    if (u.role !== "staff") {
      res.status(403).json({ error: "スタッフ専用APIです" });
      return null;
    }
    const staffId = u.staffId;
    if (!staffId) {
      res.status(403).json({ error: "staffId がありません" });
      return null;
    }
    const doc = await db.collection("staff").doc(staffId).get();
    if (!doc.exists) {
      res.status(403).json({ error: "スタッフ情報が見つかりません" });
      return null;
    }
    const s = doc.data();
    if (s.active === false) {
      res.status(403).json({ error: "無効なスタッフです" });
      return null;
    }
    const assignedIds = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
    return { staffId, assignedIds };
  }

  // propertyId "in" クエリを 10 件毎に分割して並列取得 (11物件以上に対応)
  async function chunkedByProperty_(coll, ids) {
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
    const snaps = await Promise.all(
      chunks.map((c) => db.collection(coll).where("propertyId", "in", c).get())
    );
    const out = [];
    snaps.forEach((snap) => snap.forEach((d) => out.push([d.id, d.data()])));
    return out;
  }

  async function readVersion_() {
    try {
      const v = await db.doc("meta/staffDataVersion").get();
      const d = v.exists ? v.data() : {};
      return { bookingsV: d.bookingsV || 0, guestsV: d.guestsV || 0 };
    } catch (_) {
      return { bookingsV: 0, guestsV: 0 };
    }
  }

  // GET /staff-data/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
  // 担当物件の bookings / guestRegistrations を PII 除外して返す。
  // from/to は任意 (未指定なら全期間 = 現行 onSnapshot と同じ挙動)。
  router.get("/schedule", async (req, res) => {
    try {
      const ctx = await getStaffContext_(req, res);
      if (!ctx) return;
      const v = await readVersion_();
      if (ctx.assignedIds.length === 0) {
        return res.json({ v, assignedPropertyIds: [], bookings: [], guests: [] });
      }
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      // 予約期間 [checkIn, checkOut] が [from, to] と重なるものを残す
      const inRange = (ci, co) => {
        const ciS = normDate_(ci);
        const coS = normDate_(co) || ciS;
        if (from && coS && coS < from) return false;
        if (to && ciS && ciS > to) return false;
        return true;
      };

      const [bkPairs, grPairs] = await Promise.all([
        chunkedByProperty_("bookings", ctx.assignedIds),
        chunkedByProperty_("guestRegistrations", ctx.assignedIds),
      ]);

      const bookings = bkPairs
        .filter(([, b]) => inRange(b.checkIn, b.checkOut))
        .map(([id, b]) => toBookingSummary_(id, b));
      const guests = grPairs
        .filter(([, g]) => inRange(g.checkIn, g.checkOut))
        .map(([id, g]) => toGuestSummary_(id, g));

      res.json({ v, assignedPropertyIds: ctx.assignedIds, bookings, guests });
    } catch (e) {
      console.error("[staff-data/schedule]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /staff-data/next-booking?propertyId=&checkoutDate=&excludeBookingId=&bookingId=
  // 募集詳細モーダル / my-checklist の「次の予約」用。PII 除外済み。
  //   current    : bookingId 指定時のみ。現募集予約の CO時刻/タイミー状況
  //   nextBooking: 同物件・未キャンセル・CI>=checkoutDate の最早1件
  //   nextGuest  : nextBooking に対応する名簿の設備情報 (氏名等は含まない)
  router.get("/next-booking", async (req, res) => {
    try {
      const ctx = await getStaffContext_(req, res);
      if (!ctx) return;
      const propertyId = String(req.query.propertyId || "");
      const checkoutDate = normDate_(String(req.query.checkoutDate || ""));
      const excludeBookingId = String(req.query.excludeBookingId || "");
      const bookingId = String(req.query.bookingId || "");
      if (!propertyId) return res.status(400).json({ error: "propertyId 必須" });
      if (!ctx.assignedIds.includes(propertyId)) {
        return res.status(403).json({ error: "担当外の物件です" });
      }

      // 現募集予約の CO時刻 / タイミー状況 (bookingId 指定時のみ)
      let current = null;
      if (bookingId) {
        const cdoc = await db.collection("bookings").doc(bookingId).get();
        if (cdoc.exists) {
          const b = cdoc.data();
          if (b.propertyId === propertyId) {
            current = {
              checkOutHhmm: toHhmm_(b.checkOut),
              timeeStatus: b.timeeStatus || "",
              timeePostedUrl: b.timeePostedUrl || "",
            };
          }
        }
      }

      // 同物件の全予約から「次の予約」を決定
      const bkSnap = await db.collection("bookings").where("propertyId", "==", propertyId).get();
      let next = null;
      bkSnap.forEach((d) => {
        if (d.id === excludeBookingId) return;
        const b = d.data();
        if (isCancelledStatus_(b.status)) return;
        const ci = normDate_(b.checkIn);
        if (!ci || (checkoutDate && ci < checkoutDate)) return;
        if (!next || ci < next._ci) next = { id: d.id, data: b, _ci: ci };
      });
      if (!next) return res.json({ current, nextBooking: null, nextGuest: null });

      // 名簿マッチ (propertyId + checkIn 日一致)
      let nextGuest = null;
      const grSnap = await db.collection("guestRegistrations")
        .where("propertyId", "==", propertyId).limit(60).get();
      grSnap.forEach((d) => {
        const g = d.data();
        if (normDate_(g.checkIn) === next._ci) {
          nextGuest = {
            checkInTime: g.checkInTime || "",
            guestCount: g.guestCount || 0,
            guestCountInfants: g.guestCountInfants || 0,
            bbq: g.bbq || "",
            bedChoice: g.bedChoice || "",
            transport: g.transport || "",
            carCount: g.carCount || 0,
            paidParking: g.paidParking || "",
          };
        }
      });

      const nb = next.data;
      res.json({
        current,
        nextBooking: {
          id: next.id,
          checkIn: next._ci,
          checkOut: normDate_(nb.checkOut),
          guestCount: nb.guestCount || 0,
          source: nb.source || "",
          bookingSite: nb.bookingSite || "",
          propertyId: nb.propertyId || "",
        },
        nextGuest,
      });
    } catch (e) {
      console.error("[staff-data/next-booking]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
