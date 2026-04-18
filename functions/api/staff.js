/**
 * スタッフ管理 API
 * CRUD + 一覧取得
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function staffApi(db) {
  const router = Router();
  const collection = db.collection("staff");

  // スタッフ一覧取得
  router.get("/", async (req, res) => {
    try {
      const activeOnly = req.query.active !== "false";
      let query = collection.orderBy("displayOrder", "asc");
      if (activeOnly) {
        query = query.where("active", "==", true);
      }
      const snapshot = await query.get();
      const staff = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(staff);
    } catch (e) {
      console.error("スタッフ一覧取得エラー:", e);
      res.status(500).json({ error: "スタッフ一覧の取得に失敗しました" });
    }
  });

  // スタッフ詳細取得
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }
      res.json({ id: doc.id, ...doc.data() });
    } catch (e) {
      console.error("スタッフ取得エラー:", e);
      res.status(500).json({ error: "スタッフの取得に失敗しました" });
    }
  });

  // スタッフ登録
  router.post("/", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const data = validateStaffData(req.body);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }

      data.createdAt = FieldValue.serverTimestamp();
      data.updatedAt = FieldValue.serverTimestamp();

      const docRef = await collection.add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("スタッフ登録エラー:", e);
      res.status(500).json({ error: "スタッフの登録に失敗しました" });
    }
  });

  // スタッフ更新
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }

      const data = validateStaffData(req.body, true);
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }

      data.updatedAt = FieldValue.serverTimestamp();
      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("スタッフ更新エラー:", e);
      res.status(500).json({ error: "スタッフの更新に失敗しました" });
    }
  });

  // FCMトークン登録（本人のみ自分のスタッフdocにトークン追加）
  router.post("/:id/fcm-token", async (req, res) => {
    try {
      const targetStaffId = req.params.id;
      // オーナーは全員分更新可。スタッフは自分のみ
      if (req.user.role !== "owner" && req.user.staffId !== targetStaffId) {
        return res.status(403).json({ error: "自分のトークンのみ登録できます" });
      }

      const { token } = req.body;
      if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "tokenが必要です" });
      }

      const ref = collection.doc(targetStaffId);
      const doc = await ref.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }

      // fcmTokens配列に追加（重複しない）
      await ref.update({
        fcmTokens: FieldValue.arrayUnion(token),
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (e) {
      console.error("FCMトークン登録エラー:", e);
      res.status(500).json({ error: "FCMトークンの登録に失敗しました" });
    }
  });

  // FCMトークン削除（本人またはオーナー）
  router.delete("/:id/fcm-token", async (req, res) => {
    try {
      const targetStaffId = req.params.id;
      if (req.user.role !== "owner" && req.user.staffId !== targetStaffId) {
        return res.status(403).json({ error: "自分のトークンのみ削除できます" });
      }

      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: "tokenが必要です" });
      }

      await collection.doc(targetStaffId).update({
        fcmTokens: FieldValue.arrayRemove(token),
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (e) {
      console.error("FCMトークン削除エラー:", e);
      res.status(500).json({ error: "FCMトークンの削除に失敗しました" });
    }
  });

  // スタッフ 非アクティブ解除（active=true + pendingRecruitmentIds クリア）
  router.post("/:id/reactivate", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const ref = collection.doc(req.params.id);
      const d = await ref.get();
      if (!d.exists) return res.status(404).json({ error: "スタッフが見つかりません" });
      await ref.update({
        active: true,
        pendingRecruitmentIds: [],
        inactiveReason: "",
        inactivatedAt: null,
        reactivatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "スタッフを再アクティブ化しました" });
    } catch (e) {
      console.error("reactivate エラー:", e);
      res.status(500).json({ error: "再アクティブ化に失敗しました" });
    }
  });

  // スタッフ削除（論理削除: active=false）
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }

      // 論理削除
      await docRef.update({
        active: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "スタッフを無効化しました" });
    } catch (e) {
      console.error("スタッフ削除エラー:", e);
      res.status(500).json({ error: "スタッフの削除に失敗しました" });
    }
  });

  return router;
};

/**
 * スタッフデータのバリデーション
 */
function validateStaffData(body, isUpdate = false) {
  const data = {};

  if (!isUpdate && !body.name) {
    return { error: "名前は必須です" };
  }

  if (body.name !== undefined) data.name = String(body.name).trim();
  if (body.email !== undefined) data.email = String(body.email).trim();
  if (body.phone !== undefined) data.phone = String(body.phone).trim();
  if (body.skills !== undefined) {
    data.skills = Array.isArray(body.skills) ? body.skills : [];
  }
  if (body.availableDays !== undefined) {
    data.availableDays = Array.isArray(body.availableDays) ? body.availableDays : [];
  }
  if (body.ratePerJob !== undefined) data.ratePerJob = Number(body.ratePerJob) || 0;
  if (body.transportationFee !== undefined) data.transportationFee = Number(body.transportationFee) || 0;
  if (body.bankName !== undefined) data.bankName = String(body.bankName).trim();
  if (body.branchName !== undefined) data.branchName = String(body.branchName).trim();
  if (body.accountType !== undefined) data.accountType = String(body.accountType).trim();
  if (body.accountNumber !== undefined) data.accountNumber = String(body.accountNumber).trim();
  if (body.accountHolder !== undefined) data.accountHolder = String(body.accountHolder).trim();
  if (body.contractStartDate !== undefined) data.contractStartDate = body.contractStartDate;
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.displayOrder !== undefined) data.displayOrder = Number(body.displayOrder) || 0;
  if (body.memo !== undefined) data.memo = String(body.memo).trim();
  // fcmTokensは配列（複数デバイス対応）
  if (body.fcmTokens !== undefined) {
    data.fcmTokens = Array.isArray(body.fcmTokens) ? body.fcmTokens : [];
  }

  // 新規登録時のデフォルト値
  if (!isUpdate) {
    if (data.active === undefined) data.active = true;
    if (data.displayOrder === undefined) data.displayOrder = 0;
    if (data.skills === undefined) data.skills = [];
    if (data.availableDays === undefined) data.availableDays = [];
  }

  return data;
}
