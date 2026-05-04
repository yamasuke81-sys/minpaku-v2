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

module.exports = router;
