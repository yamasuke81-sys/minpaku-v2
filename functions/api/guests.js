/**
 * 宿泊者名簿 API
 * Googleフォーム由来のゲスト情報 CRUD + 検索
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function guestsApi(db) {
  const router = Router();
  const collection = db.collection("guestRegistrations");

  // 宿泊者名簿一覧（チェックイン日降順）
  router.get("/", async (req, res) => {
    try {
      let query = collection.orderBy("checkIn", "desc");
      if (req.query.from) {
        query = query.where("checkIn", ">=", req.query.from);
      }
      if (req.query.to) {
        query = query.where("checkIn", "<=", req.query.to);
      }
      const snapshot = await query.get();
      let list = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      // 検索フィルタ
      if (req.query.search) {
        const s = req.query.search.toLowerCase();
        list = list.filter((g) =>
          (g.guestName || "").toLowerCase().includes(s) ||
          (g.guests || []).some((m) => (m.name || "").toLowerCase().includes(s)) ||
          (g.nationality || "").toLowerCase().includes(s)
        );
      }
      res.json(list);
    } catch (e) {
      console.error("宿泊者名簿一覧取得エラー:", e);
      res.status(500).json({ error: "宿泊者名簿の取得に失敗しました" });
    }
  });

  // 詳細取得
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "宿泊者情報が見つかりません" });
      }
      res.json({ id: doc.id, ...doc.data() });
    } catch (e) {
      console.error("宿泊者名簿取得エラー:", e);
      res.status(500).json({ error: "宿泊者情報の取得に失敗しました" });
    }
  });

  // 新規登録（Googleフォーム連携 or 手動）
  router.post("/", async (req, res) => {
    try {
      const data = validateGuestData(req.body);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
      data.createdAt = FieldValue.serverTimestamp();
      data.updatedAt = FieldValue.serverTimestamp();
      const docRef = await collection.add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("宿泊者名簿登録エラー:", e);
      res.status(500).json({ error: "宿泊者情報の登録に失敗しました" });
    }
  });

  // 更新
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "宿泊者情報が見つかりません" });
      }
      const data = validateGuestData(req.body, true);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
      data.updatedAt = FieldValue.serverTimestamp();
      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("宿泊者名簿更新エラー:", e);
      res.status(500).json({ error: "宿泊者情報の更新に失敗しました" });
    }
  });

  // 削除
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      await collection.doc(req.params.id).delete();
      res.json({ message: "宿泊者情報を削除しました" });
    } catch (e) {
      console.error("宿泊者名簿削除エラー:", e);
      res.status(500).json({ error: "宿泊者情報の削除に失敗しました" });
    }
  });

  // 一括インポート（Googleスプレッドシートから）
  router.post("/import", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const { records } = req.body;
      if (!Array.isArray(records) || !records.length) {
        return res.status(400).json({ error: "インポートデータがありません" });
      }
      const batch = db.batch();
      let count = 0;
      for (const record of records) {
        const data = validateGuestData(record);
        if (data.error) continue;
        data.source = data.source || "google_form";
        data.createdAt = FieldValue.serverTimestamp();
        data.updatedAt = FieldValue.serverTimestamp();
        batch.set(collection.doc(), data);
        count++;
        // Firestoreバッチは500件制限
        if (count % 400 === 0) {
          await batch.commit();
        }
      }
      if (count % 400 !== 0) {
        await batch.commit();
      }
      res.json({ message: `${count}件インポートしました`, count });
    } catch (e) {
      console.error("一括インポートエラー:", e);
      res.status(500).json({ error: "インポートに失敗しました" });
    }
  });

  return router;
};

/**
 * 宿泊者データのバリデーション
 */
function validateGuestData(body, isUpdate = false) {
  const data = {};
  if (!isUpdate && !body.guestName) {
    return { error: "代表者氏名は必須です" };
  }
  // 代表者情報
  if (body.guestName !== undefined) data.guestName = String(body.guestName).trim();
  if (body.nationality !== undefined) data.nationality = String(body.nationality).trim();
  if (body.address !== undefined) data.address = String(body.address).trim();
  if (body.phone !== undefined) data.phone = String(body.phone).trim();
  if (body.phone2 !== undefined) data.phone2 = String(body.phone2).trim();
  if (body.email !== undefined) data.email = String(body.email).trim();
  if (body.passportNumber !== undefined) data.passportNumber = String(body.passportNumber).trim();
  if (body.purpose !== undefined) data.purpose = String(body.purpose).trim();
  // 宿泊情報
  if (body.checkIn !== undefined) data.checkIn = String(body.checkIn).trim();
  if (body.checkOut !== undefined) data.checkOut = String(body.checkOut).trim();
  if (body.guestCount !== undefined) data.guestCount = Number(body.guestCount) || 0;
  if (body.guestCountInfants !== undefined) data.guestCountInfants = Number(body.guestCountInfants) || 0;
  if (body.bookingSite !== undefined) data.bookingSite = String(body.bookingSite).trim();
  if (body.bbq !== undefined) data.bbq = String(body.bbq).trim();
  if (body.parking !== undefined) data.parking = String(body.parking).trim();
  if (body.bedCount !== undefined) data.bedCount = String(body.bedCount).trim();
  if (body.memo !== undefined) data.memo = String(body.memo).trim();
  // 同行者リスト（旅館業法: 全員の氏名・国籍・旅券番号が必要）
  if (body.guests !== undefined) {
    data.guests = Array.isArray(body.guests)
      ? body.guests.map((g) => ({
          name: String(g.name || "").trim(),
          age: String(g.age || "").trim(),
          nationality: String(g.nationality || "").trim(),
          address: String(g.address || "").trim(),
          passportNumber: String(g.passportNumber || "").trim(),
        }))
      : [];
  }
  // 物件・予約紐付け
  if (body.propertyId !== undefined) data.propertyId = String(body.propertyId).trim();
  if (body.propertyName !== undefined) data.propertyName = String(body.propertyName).trim();
  if (body.bookingId !== undefined) data.bookingId = String(body.bookingId).trim();
  if (body.beds24BookingId !== undefined) data.beds24BookingId = String(body.beds24BookingId).trim();
  // データソース
  if (body.source !== undefined) data.source = String(body.source).trim();
  if (body.formResponseRow !== undefined) data.formResponseRow = Number(body.formResponseRow) || 0;
  // デフォルト値
  if (!isUpdate) {
    if (!data.source) data.source = "manual";
    if (!data.nationality) data.nationality = "日本";
    if (!data.guests) data.guests = [];
  }
  return data;
}
