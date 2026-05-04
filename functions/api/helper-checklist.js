/**
 * 臨時スタッフ向けチェックリスト API (認証不要、公開エンドポイント)
 *
 *  GET  /helper-checklist/active?propertyId=...
 *    → その物件の直近 active チェックリスト概要を返す
 *      { checklistId, propertyId, propertyName, checkoutDate (ISO yyyy-mm-dd) }
 *      なければ 404
 *
 *  POST /helper-checklist/toggle
 *    body: { checklistId, itemId, checked, restock }
 *    → checklists/{id}.itemStates[itemId] を更新
 *      checkedBy = { name: "ヘルパー", source: "helper" } を記録
 *
 * 安全策:
 *  - propertyId / checklistId / itemId はホワイトリスト検証 (Firestore に実在確認)
 *  - 同一 IP からの過剰リクエスト対策はホスティング前段 (Cloud Run) のレート制限に依存
 *  - 大量書き込み防止のためペイロードサイズを最小化
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function helperChecklistApi(db) {
  const router = Router();

  // ============================================================
  // GET /active?propertyId=...
  // 直近 active チェックリストを返す
  // ロジック: status != "completed" の中で、checkoutDate が今日以降に最も近いもの。
  //          なければ過去の未完了で checkoutDate が最も新しいもの。
  // ============================================================
  router.get("/active", async (req, res) => {
    try {
      const propertyId = String(req.query.propertyId || "").trim();
      if (!propertyId) return res.status(400).json({ error: "propertyId required" });

      // 物件存在確認 (任意の物件 ID を受け付けないため)
      const propSnap = await db.collection("properties").doc(propertyId).get();
      if (!propSnap.exists) return res.status(404).json({ error: "property not found" });
      const propData = propSnap.data();

      // active な checklists を取得 (status != "completed")
      // Firestore の != クエリは複合制約があるため、status を読み込み後にフィルタ
      const snap = await db.collection("checklists")
        .where("propertyId", "==", propertyId)
        .get();

      const now = Date.now();
      const candidates = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.status === "completed") return;
        const ms = data.checkoutDate?.toMillis ? data.checkoutDate.toMillis() : 0;
        candidates.push({ id: d.id, ms, data });
      });
      if (candidates.length === 0) {
        return res.status(404).json({ error: "no active checklist" });
      }

      // 今日以降を優先、なければ過去最新
      const future = candidates.filter((c) => c.ms >= now - 12 * 3600 * 1000); // 12h 余裕
      let chosen;
      if (future.length > 0) {
        future.sort((a, b) => a.ms - b.ms);
        chosen = future[0];
      } else {
        candidates.sort((a, b) => b.ms - a.ms);
        chosen = candidates[0];
      }

      const coDate = chosen.data.checkoutDate?.toDate
        ? chosen.data.checkoutDate.toDate().toISOString().slice(0, 10)
        : null;

      return res.json({
        checklistId: chosen.id,
        propertyId,
        propertyName: propData.name || "",
        checkoutDate: coDate,
      });
    } catch (e) {
      console.error("[helper-checklist active]", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // POST /toggle
  // body: { checklistId, itemId, checked (bool), restock (bool, optional) }
  // ============================================================
  router.post("/toggle", async (req, res) => {
    try {
      const { checklistId, itemId } = req.body || {};
      const checked = !!req.body?.checked;
      const restock = req.body?.restock; // undefined / true / false

      if (!checklistId || typeof checklistId !== "string") {
        return res.status(400).json({ error: "checklistId required" });
      }
      if (!itemId || typeof itemId !== "string") {
        return res.status(400).json({ error: "itemId required" });
      }
      if (checklistId.length > 64 || itemId.length > 128) {
        return res.status(400).json({ error: "id too long" });
      }

      const ref = db.collection("checklists").doc(checklistId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "checklist not found" });

      const data = snap.data();
      if (data.status === "completed") {
        return res.status(409).json({ error: "checklist already completed" });
      }

      // itemId が template に存在するか検証 (任意 key の埋め込み防止)
      const allItemIds = collectItemIds_(data.templateSnapshot || []);
      if (!allItemIds.has(itemId)) {
        return res.status(400).json({ error: "unknown itemId" });
      }

      const itemStates = data.itemStates || {};
      const cur = itemStates[itemId] || {};

      const newState = {
        ...cur,
        checked,
        checkedBy: checked
          ? { name: "ヘルパー", source: "helper", at: Date.now() }
          : null,
        checkedAt: checked ? FieldValue.serverTimestamp() : null,
      };
      if (typeof restock === "boolean") {
        newState.needsRestock = restock;
      }

      await ref.update({
        [`itemStates.${itemId}`]: newState,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error("[helper-checklist toggle]", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

// templateSnapshot ([{ areas... }]) から全 item.id を抽出
function collectItemIds_(snapshot) {
  const ids = new Set();
  const walk = (node) => {
    if (!node) return;
    [...(node.directItems || []), ...(node.items || [])].forEach((it) => {
      if (it && it.id) ids.add(it.id);
    });
    (node.taskTypes || []).forEach(walk);
    (node.subCategories || []).forEach(walk);
    (node.subSubCategories || []).forEach(walk);
  };
  // snapshot は areas 配列
  (Array.isArray(snapshot) ? snapshot : []).forEach(walk);
  return ids;
}
