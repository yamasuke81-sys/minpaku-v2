/**
 * 宿泊者名簿 編集API（トークンベース・認証不要）
 * GET  /guest-edit/:token — 登録データ取得
 * PUT  /guest-edit/:token — 登録データ更新（diff生成→メール送信）
 */
const express = require("express");
const { sendNotificationEmail_, resolveSenderGmail_ } = require("../utils/lineNotify");
const { buildDiffText, buildGuestSummaryText } = require("../utils/emailTemplates");

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
        return res.status(410).json({ error: "修正リンクの有効期限(30日)が切れています。Webアプリ管理者にお問い合わせください。" });
      }
      if (result.data.status === "confirmed") {
        return res.status(403).json({ error: "この名簿はWebアプリ管理者により確認済みのため、修正できません。" });
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
        return res.status(410).json({ error: "修正リンクの有効期限(30日)が切れています。Webアプリ管理者にお問い合わせください。" });
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
      // propertyId を URL に含める → guest-form.html の <head> 早期テーマで青背景フラッシュ防止
      const editUrl = `${APP_URL}/guest-form.html?edit=${currentData.editToken}${currentData.propertyId ? `&propertyId=${encodeURIComponent(currentData.propertyId)}` : ""}`;
      const confirmUrl = `${APP_URL}/#/guests`;

      const vars = {
        guestName, checkIn, checkOut,
        guestCount: mergedData.guestCount || "?",
        checkInTime: mergedData.checkInTime || "",
        checkOutTime: mergedData.checkOutTime || "",
        changes: diffText,
        summary, editUrl, confirmUrl,
      };

      // 物件の senderGmail を解決（null の場合はフォールバック）
      const senderGmail = await resolveSenderGmail_(db, currentData.propertyId || null).catch(() => null);

      // 管理者向け通知は onGuestFormUpdate トリガーが notifyByKey("roster_updated") で発火するため
      // ここでは送信しない (旧実装はグローバル notifyEmails を直接 for ループしており、
      // 物件別 channelOverrides.roster_updated を無視するバグがあった)

      // 宿泊者にメール（修正受領サンクスメール）
      // 物件別 properties/{pid}.formUpdateMail.{subject,body,subjectEn,bodyEn} を最優先で参照
      // (グローバル settings/guestForm.emailTemplates.guestConfirmation は参照しない — 2026-05-27 廃止)
      // 物件別未設定なら、ビルトインデフォルト文言を {key} 形式でレンダリングする。
      const guestEmail = mergedData.email;
      if (guestEmail) {
        try {
          // 物件別 formUpdateMail を取得
          let propFormUpdateMail = null;
          if (currentData.propertyId) {
            try {
              const pDoc = await db.collection("properties").doc(currentData.propertyId).get();
              if (pDoc.exists) propFormUpdateMail = (pDoc.data() || {}).formUpdateMail || null;
            } catch (_) {}
          }

          // 物件側で送信OFFされていればスキップ (formCompleteMail と同じ規約)
          if (propFormUpdateMail && propFormUpdateMail.enabled === false) {
            console.log(`[guest-edit] formUpdateMail.enabled=false のため修正メール送信スキップ`);
          } else {
            // ビルトインデフォルト (グローバル設定は参照しない)
            const DEFAULT_SUBJECT = "【宿泊者名簿】修正を受け付けました - {guestName}様";
            const DEFAULT_BODY = [
              "{guestName} 様",
              "",
              "宿泊者名簿のご修正を受け付けました。",
              "以下の内容で承りました。",
              "",
              "■ 変更内容",
              "{changes}",
              "",
              "■ 最新内容",
              "{summary}",
              "",
              "再度ご修正の必要がございましたら、下記リンクよりお手続きください。",
              "{editUrl}",
              "",
              "※ Webアプリ管理者が確認済みにすると修正できなくなります。",
              "",
              "ご質問等ございましたら、本メールにご返信ください。",
              "何卒よろしくお願い申し上げます。",
            ].join("\n");

            const renderSingle = (tmpl) => String(tmpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
            const renderDouble = (tmpl) => String(tmpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
            const subjectTmpl = (propFormUpdateMail && propFormUpdateMail.subject) ? propFormUpdateMail.subject : "";
            const bodyTmpl    = (propFormUpdateMail && propFormUpdateMail.body)    ? propFormUpdateMail.body    : "";
            const guestSubject = subjectTmpl ? renderDouble(subjectTmpl) : renderSingle(DEFAULT_SUBJECT);
            const guestBody    = bodyTmpl    ? renderDouble(bodyTmpl)    : renderSingle(DEFAULT_BODY);
            // 英訳併記 (formUpdateMail.subjectEn / bodyEn)
            const subjectEnTmpl = (propFormUpdateMail && propFormUpdateMail.subjectEn) ? propFormUpdateMail.subjectEn : "";
            const bodyEnTmpl    = (propFormUpdateMail && propFormUpdateMail.bodyEn)    ? propFormUpdateMail.bodyEn    : "";
            const guestSubjectEn = subjectEnTmpl ? renderDouble(subjectEnTmpl) : "";
            const guestBodyEn    = bodyEnTmpl    ? renderDouble(bodyEnTmpl)    : "";
            const finalSubject = guestSubjectEn ? `${guestSubject} / ${guestSubjectEn}` : guestSubject;
            const finalBody    = guestBodyEn
              ? `${guestBody}\n\n--------------------------------\n--- English follows ---\n--------------------------------\n\n${guestBodyEn}`
              : guestBody;
            await sendNotificationEmail_(guestEmail, finalSubject, finalBody, senderGmail || null, { preferFromHeader: true });
          }
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
