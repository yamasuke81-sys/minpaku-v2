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

  // 新規登録 or CI日一致で上書き（Googleフォーム連携 or 手動）
  router.post("/", async (req, res) => {
    try {
      const data = validateGuestData(req.body);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }

      // CI日が同じ既存データがあれば上書き（重複防止）
      let docRef;
      if (data.checkIn) {
        const existing = await collection
          .where("checkIn", "==", data.checkIn)
          .limit(5)
          .get();

        if (!existing.empty) {
          // 実名の方を優先（プレースホルダ名は上書き対象）
          const isPlaceholder = (name) => {
            if (!name) return true;
            const n = name.trim().toLowerCase();
            return !n || n === "-" || n.includes("airbnb") || n.includes("booking") ||
              n.includes("reserved") || n.includes("not available");
          };

          // 上書き対象: プレースホルダ名 or 同名 or 同ソース
          const target = existing.docs.find(d => {
            const e = d.data();
            return isPlaceholder(e.guestName) ||
              e.guestName === data.guestName ||
              (e.source === data.source && e.source);
          });

          if (target) {
            data.updatedAt = FieldValue.serverTimestamp();
            await target.ref.update(data);
            return res.json({ id: target.id, updated: true, ...data });
          }
        }
      }

      // 新規作成
      data.createdAt = FieldValue.serverTimestamp();
      data.updatedAt = FieldValue.serverTimestamp();
      docRef = await collection.add(data);
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
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
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
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
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
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
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

  // 宿泊者名簿 確認（Webアプリ管理者が「確認済み」にする）
  router.put("/:id/confirm", async (req, res) => {
    try {
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "見つかりません" });

      const data = doc.data();
      if (data.status === "confirmed") {
        return res.json({ success: true, message: "既に確認済みです" });
      }

      await docRef.update({
        status: "confirmed",
        confirmedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // 宿泊者にメール送信
      const guestEmail = data.email;
      if (guestEmail) {
        try {
          const { sendNotificationEmail_ } = require("../utils/lineNotify");
          const { renderTemplate, getTemplates } = require("../utils/emailTemplates");
          const templates = await getTemplates(db);
          const vars = {
            guestName: data.guestName || "ゲスト",
            checkIn: data.checkIn || "?",
            checkOut: data.checkOut || "?",
            checkInTime: data.checkInTime || "",
            checkOutTime: data.checkOutTime || "",
          };
          const subject = renderTemplate(templates.ownerConfirmed.subject, vars);
          const body = renderTemplate(templates.ownerConfirmed.body, vars);
          await sendNotificationEmail_(guestEmail, subject, body);
        } catch (e) {
          console.error("確認メール送信失敗:", e.message);
        }
      }

      res.json({ success: true, message: "確認済みにしました。宿泊者にメールを送信しました。" });
    } catch (e) {
      console.error("confirm エラー:", e);
      res.status(500).json({ error: "確認に失敗しました" });
    }
  });

  // 駐車場料金 入金確認
  router.put("/:id/parking-paid", async (req, res) => {
    try {
      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "見つかりません" });

      await docRef.update({
        parkingPaymentConfirmed: true,
        parkingPaymentConfirmedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true, message: "入金確認済みにしました" });
    } catch (e) {
      console.error("parking-paid エラー:", e);
      res.status(500).json({ error: "入金確認に失敗しました" });
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
  if (body.bedChoice !== undefined) data.bedChoice = String(body.bedChoice).trim();
  if (body.bedCount !== undefined) data.bedCount = String(body.bedCount).trim();
  if (body.memo !== undefined) data.memo = String(body.memo).trim();
  // 時刻
  if (body.checkInTime !== undefined) data.checkInTime = String(body.checkInTime).trim();
  if (body.checkOutTime !== undefined) data.checkOutTime = String(body.checkOutTime).trim();
  // 交通・駐車場
  if (body.transport !== undefined) data.transport = String(body.transport).trim();
  if (body.carCount !== undefined) data.carCount = Number(body.carCount) || 0;
  if (body.vehicleTypes !== undefined) data.vehicleTypes = Array.isArray(body.vehicleTypes) ? body.vehicleTypes : [];
  if (body.paidParking !== undefined) data.paidParking = String(body.paidParking).trim();
  if (body.parkingAllocation !== undefined) data.parkingAllocation = body.parkingAllocation;
  // 前後泊・緊急連絡先
  if (body.previousStay !== undefined) data.previousStay = String(body.previousStay).trim();
  if (body.nextStay !== undefined) data.nextStay = String(body.nextStay).trim();
  if (body.emergencyName !== undefined) data.emergencyName = String(body.emergencyName).trim();
  if (body.emergencyPhone !== undefined) data.emergencyPhone = String(body.emergencyPhone).trim();
  // パスポート写真・同意
  if (body.passportPhotoUrl !== undefined) data.passportPhotoUrl = String(body.passportPhotoUrl).trim();
  if (body.noiseAgree !== undefined) data.noiseAgree = !!body.noiseAgree;
  if (body.houseRuleAgree !== undefined) data.houseRuleAgree = !!body.houseRuleAgree;
  // 全ゲスト（代表者+同行者、パスポート写真URL含む）
  if (body.allGuests !== undefined) {
    data.allGuests = Array.isArray(body.allGuests)
      ? body.allGuests.map((g) => ({
          name: String(g.name || "").trim(),
          age: String(g.age || "").trim(),
          nationality: String(g.nationality || "").trim(),
          address: String(g.address || "").trim(),
          passportNumber: String(g.passportNumber || "").trim(),
          passportPhotoUrl: String(g.passportPhotoUrl || "").trim(),
          phone: String(g.phone || "").trim(),
          email: String(g.email || "").trim(),
        }))
      : [];
  }
  // 同行者リスト（旅館業法: 全員の氏名・国籍・旅券番号が必要）
  if (body.guests !== undefined) {
    data.guests = Array.isArray(body.guests)
      ? body.guests.map((g) => ({
          name: String(g.name || "").trim(),
          age: String(g.age || "").trim(),
          nationality: String(g.nationality || "").trim(),
          address: String(g.address || "").trim(),
          passportNumber: String(g.passportNumber || "").trim(),
          passportPhotoUrl: String(g.passportPhotoUrl || "").trim(),
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
