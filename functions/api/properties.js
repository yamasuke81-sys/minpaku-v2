/**
 * 物件管理 API
 * BEDS24の物件IDと紐付け可能な構造
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

/**
 * lineChannels 配列のバリデーションとサニタイズ
 * 最大5件まで受け付け、各フィールドを文字列に正規化する
 * @param {any} raw - リクエストボディの lineChannels 値
 * @returns {Array}
 */
function _sanitizeLineChannels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).map(ch => ({
    token: ch.token ? String(ch.token).trim() : "",
    groupId: ch.groupId ? String(ch.groupId).trim() : "",
    name: ch.name ? String(ch.name).trim() : "",
    enabled: ch.enabled !== false,
  }));
}

module.exports = function propertiesApi(db) {
  const router = Router();
  const collection = db.collection("properties");

  // 物件一覧
  router.get("/", async (req, res) => {
    try {
      const activeOnly = req.query.active !== "false";
      let query = collection.orderBy("name", "asc");
      if (activeOnly) {
        query = query.where("active", "==", true);
      }
      const snapshot = await query.get();
      const properties = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(properties);
    } catch (e) {
      console.error("物件一覧取得エラー:", e);
      res.status(500).json({ error: "物件一覧の取得に失敗しました" });
    }
  });

  // 物件詳細
  router.get("/:id", async (req, res) => {
    try {
      const doc = await collection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: "物件が見つかりません" });
      }
      res.json({ id: doc.id, ...doc.data() });
    } catch (e) {
      console.error("物件取得エラー:", e);
      res.status(500).json({ error: "物件の取得に失敗しました" });
    }
  });

  // 物件登録
  router.post("/", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const { body } = req;
      if (!body.name) {
        return res.status(400).json({ error: "物件名は必須です" });
      }

      const data = {
        name: String(body.name).trim(),
        // ownerId: 物件オーナーの staff doc id (サブオーナー対応)
        // 未指定時は req.user.staffId (作成者) にフォールバック
        ownerId: body.ownerId ? String(body.ownerId).trim() : (req.user.staffId || ""),
        type: ["minpaku", "rental", "other"].includes(body.type) ? body.type : "minpaku",
        beds24PropertyId: body.beds24PropertyId ? String(body.beds24PropertyId).trim() : "",
        address: body.address ? String(body.address).trim() : "",
        area: body.area ? String(body.area).trim() : "",
        capacity: Number(body.capacity) || 0,
        cleaningDuration: Number(body.cleaningDuration) || 90,
        cleaningFee: Number(body.cleaningFee) || 0,
        requiredSkills: Array.isArray(body.requiredSkills) ? body.requiredSkills : [],
        checklistTemplateId: body.checklistTemplateId || "",
        monthlyFixedCost: Number(body.monthlyFixedCost) || 0,
        purchasePrice: Number(body.purchasePrice) || 0,
        purchaseDate: body.purchaseDate || null,
        notes: body.notes ? String(body.notes).trim() : "",
        active: body.active !== false,
        // タイミー作業時間 (タイミー時給計算用)
        baseWorkTime: (body.baseWorkTime && typeof body.baseWorkTime === "object")
          ? { start: String(body.baseWorkTime.start || "10:30"), end: String(body.baseWorkTime.end || "14:30") }
          : { start: "10:30", end: "14:30" },
        // 物件別 LINE 連携設定（後方互換フィールド）
        lineEnabled: body.lineEnabled === true,
        lineChannelToken: body.lineChannelToken ? String(body.lineChannelToken).trim() : "",
        lineChannelSecret: body.lineChannelSecret ? String(body.lineChannelSecret).trim() : "",
        lineGroupId: body.lineGroupId ? String(body.lineGroupId).trim() : "",
        lineChannelName: body.lineChannelName ? String(body.lineChannelName).trim() : "",
        // 複数チャネル設定 (lineChannels[])
        lineChannels: _sanitizeLineChannels(body.lineChannels),
        lineChannelStrategy: ["fallback", "roundrobin"].includes(body.lineChannelStrategy)
          ? body.lineChannelStrategy : "fallback",
        // 物件ごとの騒音ルール黄色カードの表示ON/OFF (default: true)
        showNoiseAgreement: body.showNoiseAgreement !== false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      const docRef = await collection.add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("物件登録エラー:", e);
      res.status(500).json({ error: "物件の登録に失敗しました" });
    }
  });

  // 物件更新
  router.put("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "物件が見つかりません" });
      }

      const { body } = req;
      const data = {};
      if (body.name !== undefined) data.name = String(body.name).trim();
      // ownerId は メインオーナーのみ変更可 (サブオーナーが他人に付け替えるのを防ぐ)
      if (body.ownerId !== undefined && req.user.role === "owner") {
        data.ownerId = String(body.ownerId).trim();
      }
      if (body.type !== undefined && ["minpaku", "rental", "other"].includes(body.type)) data.type = body.type;
      if (body.beds24PropertyId !== undefined) data.beds24PropertyId = String(body.beds24PropertyId).trim();
      if (body.address !== undefined) data.address = String(body.address).trim();
      if (body.area !== undefined) data.area = String(body.area).trim();
      if (body.capacity !== undefined) data.capacity = Number(body.capacity) || 0;
      if (body.cleaningDuration !== undefined) data.cleaningDuration = Number(body.cleaningDuration) || 90;
      if (body.cleaningFee !== undefined) data.cleaningFee = Number(body.cleaningFee) || 0;
      if (body.requiredSkills !== undefined) data.requiredSkills = Array.isArray(body.requiredSkills) ? body.requiredSkills : [];
      if (body.monthlyFixedCost !== undefined) data.monthlyFixedCost = Number(body.monthlyFixedCost) || 0;
      if (body.purchasePrice !== undefined) data.purchasePrice = Number(body.purchasePrice) || 0;
      if (body.purchaseDate !== undefined) data.purchaseDate = body.purchaseDate;
      if (body.checklistTemplateId !== undefined) data.checklistTemplateId = body.checklistTemplateId;
      if (body.notes !== undefined) data.notes = String(body.notes).trim();
      if (body.active !== undefined) data.active = Boolean(body.active);
      if (body.baseWorkTime !== undefined && typeof body.baseWorkTime === "object") {
        data.baseWorkTime = {
          start: String(body.baseWorkTime.start || "10:30"),
          end: String(body.baseWorkTime.end || "14:30"),
        };
      }
      // 物件別 LINE 連携設定（後方互換フィールド）
      if (body.lineEnabled !== undefined) data.lineEnabled = Boolean(body.lineEnabled);
      if (body.lineChannelToken !== undefined) data.lineChannelToken = String(body.lineChannelToken).trim();
      if (body.lineChannelSecret !== undefined) data.lineChannelSecret = String(body.lineChannelSecret).trim();
      if (body.lineGroupId !== undefined) data.lineGroupId = String(body.lineGroupId).trim();
      if (body.lineChannelName !== undefined) data.lineChannelName = String(body.lineChannelName).trim();
      // 複数チャネル設定
      if (body.lineChannels !== undefined) data.lineChannels = _sanitizeLineChannels(body.lineChannels);
      if (body.lineChannelStrategy !== undefined) {
        data.lineChannelStrategy = ["fallback", "roundrobin"].includes(body.lineChannelStrategy)
          ? body.lineChannelStrategy : "fallback";
      }
      // 物件ごとの騒音ルール黄色カードの表示ON/OFF
      if (body.showNoiseAgreement !== undefined) data.showNoiseAgreement = Boolean(body.showNoiseAgreement);
      data.updatedAt = FieldValue.serverTimestamp();

      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("物件更新エラー:", e);
      res.status(500).json({ error: "物件の更新に失敗しました" });
    }
  });

  // 物件削除（論理削除）
  router.delete("/:id", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }

      const docRef = collection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "物件が見つかりません" });
      }

      await docRef.update({
        active: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ message: "物件を無効化しました" });
    } catch (e) {
      console.error("物件削除エラー:", e);
      res.status(500).json({ error: "物件の削除に失敗しました" });
    }
  });

  // 物件の関連データ件数を返す (完全削除前の確認用)
  router.get("/:id/related-count", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const pid = req.params.id;
      const db = collection.firestore;
      const counts = {};
      const cols = ["bookings", "shifts", "recruitments", "checklists", "guestRegistrations", "laundry", "invoices"];
      for (const c of cols) {
        const snap = await db.collection(c).where("propertyId", "==", pid).get();
        counts[c] = snap.size;
      }
      // checklistTemplates は doc id が propertyId
      const tmplDoc = await db.collection("checklistTemplates").doc(pid).get();
      counts.checklistTemplates = tmplDoc.exists ? 1 : 0;
      res.json({ counts });
    } catch (e) {
      console.error("related-count エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // 物件の完全削除 (ドキュメント自体を Firestore から削除)
  // 関連データ (bookings/shifts/...) は残す (データ整合性維持・履歴保持のため)
  router.delete("/:id/force", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const pid = req.params.id;
      const docRef = collection.doc(pid);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "物件が見つかりません" });
      }
      // 念のため無効化済みでないと削除させない (誤操作防止)
      if (doc.data().active !== false) {
        return res.status(400).json({ error: "先に物件を無効化してください" });
      }

      // スタッフの assignedPropertyIds / ownedPropertyIds から当該 ID を除去
      // (残しておくとスタッフ一覧の物件フィルタからスタッフが見えなくなる等の副作用あり)
      const db = collection.firestore;
      const staffSnap = await db.collection("staff").get();
      const batch = db.batch();
      let cleanupCount = 0;
      for (const sDoc of staffSnap.docs) {
        const s = sDoc.data();
        const updates = {};
        const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
        const owned = Array.isArray(s.ownedPropertyIds) ? s.ownedPropertyIds : [];
        if (assigned.includes(pid)) updates.assignedPropertyIds = assigned.filter(x => x !== pid);
        if (owned.includes(pid))    updates.ownedPropertyIds    = owned.filter(x => x !== pid);
        if (Object.keys(updates).length > 0) {
          batch.update(sDoc.ref, { ...updates, updatedAt: FieldValue.serverTimestamp() });
          cleanupCount++;
        }
      }
      if (cleanupCount > 0) await batch.commit();

      await docRef.delete();
      res.json({ message: `物件を完全に削除しました (関連スタッフ ${cleanupCount}件を更新)` });
    } catch (e) {
      console.error("物件完全削除エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // GET /properties/:id/line-recent-users
  // 物件に紐づく LINE Bot (lineChannels[].groupId) で
  // 直近受信した line_webhook_logs から userId 一覧を抽出 + LINE 表示名解決
  //  ?days=7 (デフォルト 14)
  // 返却: [{ userId, displayName, pictureUrl, lastMessage, lastReceivedAt, source }]
  // ============================================================
  router.get("/:id/line-recent-users", async (req, res) => {
    try {
      if (req.user.role !== "owner" && req.user.role !== "sub_owner") {
        return res.status(403).json({ error: "権限がありません" });
      }
      const pid = req.params.id;
      const days = Math.min(60, parseInt(req.query.days || "14", 10));
      const dbRef = collection.firestore;

      // 1. 物件情報を取得 → groupIds + bot tokens を集める
      const propDoc = await dbRef.collection("properties").doc(pid).get();
      if (!propDoc.exists) return res.status(404).json({ error: "物件が見つかりません" });

      // sub_owner は所有物件のみ
      if (req.user.role === "sub_owner") {
        const owned = req.user.ownedPropertyIds || [];
        if (!owned.includes(pid)) return res.status(403).json({ error: "この物件のアクセス権がありません" });
      }

      const data = propDoc.data();
      const channels = Array.isArray(data.lineChannels) ? data.lineChannels : [];
      const groupIds = channels.map(c => c.groupId).filter(Boolean);
      const tokens = channels.map(c => c.token).filter(Boolean);

      if (groupIds.length === 0) {
        return res.json({ users: [], note: "この物件には Group ID が登録されていません" });
      }

      // 2. line_webhook_logs から該当 groupId の userId を抽出 (直近 N 日)
      const sinceMs = Date.now() - days * 86400 * 1000;
      const logs = [];
      for (const gid of groupIds) {
        const snap = await dbRef.collection("line_webhook_logs")
          .where("groupId", "==", gid)
          .get();
        snap.forEach(d => {
          const x = d.data();
          const t = x.receivedAt?.toMillis ? x.receivedAt.toMillis() : (x.receivedAt?.toDate?.().getTime?.() || 0);
          if (t < sinceMs) return;
          if (!x.userId) return;
          logs.push({ userId: x.userId, groupId: gid, messageText: x.messageText || "", receivedAt: t });
        });
      }

      // 3. userId ごとに最新メッセージを抽出
      const byUser = new Map();
      for (const l of logs) {
        const cur = byUser.get(l.userId);
        if (!cur || cur.receivedAt < l.receivedAt) byUser.set(l.userId, l);
      }

      // 4. LINE Bot Profile API で displayName 解決 (各 token を順次トライ)
      // Node 22 の built-in fetch を使用
      const users = [];
      for (const [userId, info] of byUser.entries()) {
        let displayName = "";
        let pictureUrl = "";
        for (const token of tokens) {
          try {
            const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) continue;
            const resp = await r.json();
            if (resp && resp.displayName) {
              displayName = resp.displayName;
              pictureUrl = resp.pictureUrl || "";
              break;
            }
          } catch (e) { /* 次の token を試す */ }
        }
        // group 内 profile も試す (1on1 friend ではない場合)
        if (!displayName) {
          for (const token of tokens) {
            try {
              const r = await fetch(`https://api.line.me/v2/bot/group/${info.groupId}/member/${userId}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!r.ok) continue;
              const resp = await r.json();
              if (resp && resp.displayName) {
                displayName = resp.displayName;
                pictureUrl = resp.pictureUrl || "";
                break;
              }
            } catch (e) { /* skip */ }
          }
        }
        users.push({
          userId,
          displayName: displayName || "(取得不可)",
          pictureUrl,
          lastMessage: info.messageText.slice(0, 100),
          lastReceivedAt: info.receivedAt,
          groupId: info.groupId,
        });
      }
      // 最新順
      users.sort((a, b) => b.lastReceivedAt - a.lastReceivedAt);

      // 既に staff に紐付いてる userId はマーク
      const staffSnap = await dbRef.collection("staff").get();
      const linkedMap = new Map();
      staffSnap.forEach(d => {
        const s = d.data();
        if (s.lineUserId) linkedMap.set(s.lineUserId, { staffId: d.id, staffName: s.name || "" });
      });
      users.forEach(u => {
        const linked = linkedMap.get(u.userId);
        if (linked) {
          u.linkedStaffId = linked.staffId;
          u.linkedStaffName = linked.staffName;
        }
      });

      res.json({ users });
    } catch (e) {
      console.error("[line-recent-users] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
