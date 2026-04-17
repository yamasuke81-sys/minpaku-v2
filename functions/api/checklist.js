/**
 * チェックリスト API
 * テンプレート管理 + 清掃チェック記録
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");

module.exports = function checklistApi(db) {
  const router = Router();

  // ===== ツリー構造テンプレート (新UI用) =====

  // マスタツリー取得
  router.get("/master", async (req, res) => {
    try {
      const doc = await db.collection("checklistMaster").doc("main").get();
      if (!doc.exists) return res.status(404).json({ error: "マスタ未投入" });
      res.json(doc.data());
    } catch (e) {
      console.error("マスタ取得エラー:", e);
      res.status(500).json({ error: "マスタの取得に失敗しました" });
    }
  });

  // 物件テンプレート(ツリー)取得
  router.get("/templates/:propertyId/tree", async (req, res) => {
    try {
      const { propertyId } = req.params;
      const doc = await db.collection("checklistTemplates").doc(propertyId).get();
      if (!doc.exists) return res.status(404).json({ error: "テンプレート未作成", propertyId });
      res.json({ id: doc.id, ...doc.data() });
    } catch (e) {
      console.error("テンプレート取得エラー:", e);
      res.status(500).json({ error: "テンプレートの取得に失敗しました" });
    }
  });

  // 物件テンプレート(ツリー)保存 ※オーナーのみ、areas全体を差し替える想定
  router.put("/templates/:propertyId/tree", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const { propertyId } = req.params;
      const { areas, _meta } = req.body;
      if (!Array.isArray(areas)) {
        return res.status(400).json({ error: "areas配列が必要です" });
      }
      const data = {
        propertyId,
        areas,
        _meta: _meta || null,
        updatedAt: FieldValue.serverTimestamp(),
        version: (req.body.version || 1)
      };
      await db.collection("checklistTemplates").doc(propertyId).set(data, { merge: true });
      res.json({ id: propertyId, ...data });
    } catch (e) {
      console.error("テンプレート保存エラー:", e);
      res.status(500).json({ error: "テンプレートの保存に失敗しました" });
    }
  });

  // 未完了チェックリストを原紙の最新版で再生成 ※オーナーのみ (方針C)
  // - 対象: 該当物件の status !== "completed" の checklist
  // - 完了済みは保護、進行中は itemStates を smart merge (ID 一致のみ保持)
  // - body: { alsoInProgress?: boolean } — デフォルト false (進行中は触らない)
  router.post("/templates/:propertyId/regenerate", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const { propertyId } = req.params;
      const alsoInProgress = !!req.body.alsoInProgress;

      const tmplDoc = await db.collection("checklistTemplates").doc(propertyId).get();
      if (!tmplDoc.exists) return res.status(404).json({ error: "原紙(テンプレート)が見つかりません" });
      const tmpl = tmplDoc.data();
      const newAreas = tmpl.areas || [];
      const newVersion = tmpl.version || 1;

      // 新 areas の項目ID 集合
      const newIds = new Set();
      const walk = (node) => {
        (node.items || node.directItems || []).forEach(it => { if (it && it.id) newIds.add(it.id); });
        (node.taskTypes || []).forEach(walk);
        (node.subCategories || []).forEach(walk);
        (node.subSubCategories || []).forEach(walk);
      };
      newAreas.forEach(walk);

      const snap = await db.collection("checklists")
        .where("propertyId", "==", propertyId)
        .get();

      let updated = 0;
      let skippedCompleted = 0;
      let skippedInProgress = 0;
      const mergedItems = [];

      for (const doc of snap.docs) {
        const c = doc.data();
        if (c.status === "completed") { skippedCompleted++; continue; }
        const states = c.itemStates || {};
        const hasWork = Object.values(states).some(s => s && (s.checked || s.needsRestock));

        if (hasWork && !alsoInProgress) { skippedInProgress++; continue; }

        // smart merge: 新 areas に残る ID の state だけ維持
        const newStates = {};
        Object.keys(states).forEach(id => {
          if (newIds.has(id)) newStates[id] = states[id];
        });

        await doc.ref.update({
          templateSnapshot: newAreas,
          templateVersion: newVersion,
          itemStates: newStates,
          templateSyncedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        updated++;
        if (hasWork) mergedItems.push({ id: doc.id, checkoutDate: c.checkoutDate });
      }

      res.json({
        ok: true,
        propertyId,
        summary: { updated, skippedCompleted, skippedInProgress },
        mergedWithWork: mergedItems,
      });
    } catch (e) {
      console.error("再生成エラー:", e);
      res.status(500).json({ error: e.message || "再生成に失敗しました" });
    }
  });

  // 別物件 or マスタからコピー ※オーナーのみ
  // body: { sourceType: "master" | "template", sourcePropertyId?: string }
  router.post("/templates/:propertyId/copyFrom", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }
      const { propertyId } = req.params;
      const { sourceType, sourcePropertyId } = req.body;

      let sourceData;
      if (sourceType === "master") {
        const doc = await db.collection("checklistMaster").doc("main").get();
        if (!doc.exists) return res.status(404).json({ error: "マスタが存在しません" });
        sourceData = doc.data();
      } else if (sourceType === "template" && sourcePropertyId) {
        const doc = await db.collection("checklistTemplates").doc(sourcePropertyId).get();
        if (!doc.exists) return res.status(404).json({ error: "コピー元テンプレートが存在しません" });
        sourceData = doc.data();
      } else {
        return res.status(400).json({ error: "sourceType(master/template) と sourcePropertyId(template時) が必要です" });
      }

      const data = {
        propertyId,
        sourcePropertyId: sourceType === "template" ? sourcePropertyId : null,
        copiedFrom: sourceType,
        copiedAt: FieldValue.serverTimestamp(),
        _meta: sourceData._meta || null,
        areas: sourceData.areas || [],
        updatedAt: FieldValue.serverTimestamp(),
        version: 1
      };
      await db.collection("checklistTemplates").doc(propertyId).set(data);
      res.json({ id: propertyId, ...data });
    } catch (e) {
      console.error("テンプレートコピーエラー:", e);
      res.status(500).json({ error: "テンプレートのコピーに失敗しました" });
    }
  });

  // ===== レガシー: フラット構造テンプレート (旧UI用、当面残す) =====

  // テンプレート一覧
  router.get("/templates", async (req, res) => {
    try {
      const snapshot = await db.collection("checklistTemplates").get();
      const templates = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(templates);
    } catch (e) {
      console.error("テンプレート取得エラー:", e);
      res.status(500).json({ error: "テンプレートの取得に失敗しました" });
    }
  });

  // テンプレート作成/更新（オーナーのみ）
  router.post("/templates", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const { body } = req;
      if (!body.propertyId || !body.items || !Array.isArray(body.items)) {
        return res.status(400).json({ error: "物件IDとチェック項目は必須です" });
      }

      const data = {
        propertyId: body.propertyId,
        items: body.items.map((item) => ({
          name: String(item.name || ""),
          required: item.required !== false,
          photoRequired: item.photoRequired === true,
        })),
        updatedAt: FieldValue.serverTimestamp(),
      };

      let docRef;
      if (body.id) {
        docRef = db.collection("checklistTemplates").doc(body.id);
        await docRef.update(data);
      } else {
        docRef = await db.collection("checklistTemplates").add(data);
      }

      res.status(201).json({ id: docRef.id || body.id, ...data });
    } catch (e) {
      console.error("テンプレート保存エラー:", e);
      res.status(500).json({ error: "テンプレートの保存に失敗しました" });
    }
  });

  // ===== チェックリスト記録 =====

  // 記録取得（シフトID or スタッフID）
  router.get("/records", async (req, res) => {
    try {
      const { shiftId, staffId } = req.query;
      let query = db.collection("checklists");

      if (shiftId) {
        query = query.where("shiftId", "==", shiftId);
      } else if (staffId) {
        query = query.where("staffId", "==", staffId);
      }

      const snapshot = await query.get();
      const records = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(records);
    } catch (e) {
      console.error("チェックリスト記録取得エラー:", e);
      res.status(500).json({ error: "記録の取得に失敗しました" });
    }
  });

  // チェックリスト開始（テンプレートからコピー）
  router.post("/records", async (req, res) => {
    try {
      const { shiftId, propertyId } = req.body;
      if (!shiftId || !propertyId) {
        return res.status(400).json({ error: "シフトIDと物件IDは必須です" });
      }

      // テンプレート取得
      const templateSnap = await db.collection("checklistTemplates")
        .where("propertyId", "==", propertyId)
        .limit(1)
        .get();

      let items = [];
      if (!templateSnap.empty) {
        items = templateSnap.docs[0].data().items.map((item) => ({
          ...item,
          checked: false,
          note: "",
          photoUrl: null,
        }));
      }

      const data = {
        shiftId,
        propertyId,
        staffId: req.user.uid,
        items,
        status: "in_progress",
        completedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      };

      const docRef = await db.collection("checklists").add(data);
      res.status(201).json({ id: docRef.id, ...data });
    } catch (e) {
      console.error("チェックリスト開始エラー:", e);
      res.status(500).json({ error: "チェックリストの開始に失敗しました" });
    }
  });

  // チェックリスト更新（項目チェック、写真URL追加等）
  router.put("/records/:id", async (req, res) => {
    try {
      const docRef = db.collection("checklists").doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "記録が見つかりません" });
      }

      const existing = doc.data();
      if (req.user.role === "staff" && existing.staffId !== req.user.uid) {
        return res.status(403).json({ error: "アクセス権限がありません" });
      }

      const { body } = req;
      const data = {};
      if (body.items !== undefined) data.items = body.items;
      if (body.status !== undefined) {
        data.status = body.status;
        if (body.status === "completed") {
          data.completedAt = FieldValue.serverTimestamp();
        }
      }
      data.updatedAt = FieldValue.serverTimestamp();

      await docRef.update(data);
      res.json({ id: req.params.id, ...data });
    } catch (e) {
      console.error("チェックリスト更新エラー:", e);
      res.status(500).json({ error: "チェックリストの更新に失敗しました" });
    }
  });

  return router;
};
