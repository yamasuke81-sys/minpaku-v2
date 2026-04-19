/**
 * 宿泊者名簿 編集API（トークンベース・認証不要）
 * GET  /guest-edit/:token — 登録データ取得
 * PUT  /guest-edit/:token — 登録データ更新（diff生成→メール送信）
 */
const express = require("express");
const { sendNotificationEmail_ } = require("../utils/lineNotify");
const { renderTemplate, buildDiffText, buildGuestSummaryText, getTemplates } = require("../utils/emailTemplates");

const APP_URL = "https://minpaku-v2.web.app";

module.exports = function guestEditApi(db) {
  const router = express.Router();

  // editTokenでドキュメントを検索
  async function findByToken(token) {
    if (!token || token.length < 32) return null;
    const snap = await db.collection("guestRegistrations")
      .where("editToken", "==", token)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ref: doc.ref, data: doc.data() };
  }

  // editToken 有効期限チェック (期限切れなら 410 Gone)
  function isExpired(data) {
    const exp = data.editTokenExpiresAt;
    if (!exp) return false;  // 未設定は旧データ扱いで有効
    const expDate = exp.toDate ? exp.toDate() : new Date(exp);
    return expDate.getTime() < Date.now();
  }

  // GET /guest-edit/:token — 登録データ取得
  router.get("/:token", async (req, res) => {
    try {
      const result = await findByToken(req.params.token);
      if (!result) {
        return res.status(404).json({ error: "登録が見つかりません。リンクが無効か、期限切れの可能性があります。" });
      }
      if (isExpired(result.data)) {
        return res.status(410).json({ error: "修正リンクの有効期限(30日)が切れています。オーナーにお問い合わせください。" });
      }
      if (result.data.status === "confirmed") {
        return res.status(403).json({ error: "この名簿はオーナーにより確認済みのため、修正できません。" });
      }
      // editTokenは返さない
      const { editToken, previousData, ...safeData } = result.data;
      // タイムスタンプをシリアライズ
      const serialized = JSON.parse(JSON.stringify(safeData, (key, val) => {
        if (val && val._seconds !== undefined) return new Date(val._seconds * 1000).toISOString();
        return val;
      }));
      res.json({ id: result.id, ...serialized });
    } catch (e) {
      console.error("guest-edit GET エラー:", e);
      res.status(500).json({ error: "サーバーエラーが発生しました" });
    }
  });

  // PUT /guest-edit/:token — 登録データ更新
  router.put("/:token", async (req, res) => {
    try {
      const result = await findByToken(req.params.token);
      if (!result) {
        return res.status(404).json({ error: "登録が見つかりません。" });
      }
      if (isExpired(result.data)) {
        return res.status(410).json({ error: "修正リンクの有効期限(30日)が切れています。オーナーにお問い合わせください。" });
      }
      if (result.data.status === "confirmed") {
        return res.status(403).json({ error: "確認済みのため修正できません。" });
      }

      const currentData = result.data;
      const newData = req.body;

      // 更新不可フィールドを除外
      delete newData.editToken;
      delete newData.status;
      delete newData.confirmedAt;
      delete newData.previousData;
      delete newData.keyboxEmailSentAt;
      delete newData.source;

      // 前回データを保存（diff生成用）
      const previousSnapshot = {};
      const fieldsToSnapshot = [
        "guestName", "nationality", "address", "phone", "email", "passportNumber",
        "checkIn", "checkOut", "checkInTime", "checkOutTime",
        "guestCount", "guestCountInfants", "bookingSite",
        "transport", "carCount", "vehicleTypes", "paidParking",
        "bbq", "bedChoice", "purpose", "previousStay", "nextStay",
        "emergencyName", "emergencyPhone", "guests",
      ];
      for (const f of fieldsToSnapshot) {
        if (currentData[f] !== undefined) previousSnapshot[f] = currentData[f];
      }

      // 更新実行
      const admin = require("firebase-admin");
      await result.ref.update({
        ...newData,
        previousData: previousSnapshot,
        lastEditedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // diff生成
      const diffText = buildDiffText(previousSnapshot, newData);
      const mergedData = { ...currentData, ...newData };
      const summary = buildGuestSummaryText(mergedData);

      const guestName = mergedData.guestName || "名前不明";
      const checkIn = mergedData.checkIn || "?";
      const checkOut = mergedData.checkOut || "?";
      const editUrl = `${APP_URL}/guest-form.html?edit=${currentData.editToken}`;
      const confirmUrl = `${APP_URL}/#/guests`;

      const templates = await getTemplates(db);
      const vars = {
        guestName, checkIn, checkOut,
        guestCount: mergedData.guestCount || "?",
        checkInTime: mergedData.checkInTime || "",
        checkOutTime: mergedData.checkOutTime || "",
        changes: diffText,
        summary, editUrl, confirmUrl,
      };

      // オーナーにメール（変更点付き）
      try {
        const notifDoc = await db.collection("settings").doc("notifications").get();
        const notifyEmails = notifDoc.exists ? (notifDoc.data().notifyEmails || []) : [];
        const ownerSubject = renderTemplate(templates.editNotification.subject, vars);
        const ownerBody = renderTemplate(templates.editNotification.body, vars);
        for (const email of notifyEmails) {
          try {
            await sendNotificationEmail_(email, ownerSubject, ownerBody);
          } catch (e) {
            console.error(`オーナーメール送信失敗 (${email}):`, e.message);
          }
        }
      } catch (e) {
        console.error("オーナーメール処理エラー:", e.message);
      }

      // 宿泊者にメール（修正確認）
      const guestEmail = mergedData.email;
      if (guestEmail) {
        try {
          const guestSubject = renderTemplate(templates.guestConfirmation.subject, vars);
          const guestBody = renderTemplate(templates.guestConfirmation.body, vars);
          await sendNotificationEmail_(guestEmail, guestSubject, guestBody);
        } catch (e) {
          console.error(`宿泊者メール送信失敗:`, e.message);
        }
      }

      res.json({ success: true, message: "修正が保存されました" });
    } catch (e) {
      console.error("guest-edit PUT エラー:", e);
      res.status(500).json({ error: "サーバーエラーが発生しました" });
    }
  });

  return router;
};
