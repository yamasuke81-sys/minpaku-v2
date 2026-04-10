/**
 * 税理士資料管理 API
 * チェックリスト管理・Driveファイル存在確認・GAS連携エンドポイント
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { google } = require("googleapis");

module.exports = function taxDocsApi(db) {
  const router = Router();
  const entitiesCol = db.collection("entities");
  const taxDocsCol = db.collection("taxDocs");
  const checklistCol = db.collection("taxDocsChecklist");

  // ========================================
  // 名義一覧取得
  // ========================================
  router.get("/entities", async (req, res) => {
    try {
      const snap = await entitiesCol.orderBy("displayOrder").get();
      const entities = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json({ entities });
    } catch (e) {
      console.error("名義取得エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // チェックリスト取得（全名義）
  // ========================================
  router.get("/checklist/:yearMonth", async (req, res) => {
    try {
      const { yearMonth } = req.params;
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
        return res.status(400).json({ error: "yearMonthの形式はYYYY-MMです" });
      }

      // 既存チェックリストを取得
      const entSnap = await checklistCol.doc(yearMonth).collection("entities").get();
      let entityChecklists = {};
      entSnap.docs.forEach((d) => {
        entityChecklists[d.id] = d.data();
      });

      // 名義マスタと照合し、未初期化 or 空のチェックリストを(再)生成
      const allEntities = await entitiesCol.orderBy("displayOrder").get();
      const batch = db.batch();
      let batchNeeded = false;

      for (const entDoc of allEntities.docs) {
        const ent = entDoc.data();
        const items = buildChecklistItems_(ent);
        const existing = entityChecklists[entDoc.id];

        // 既存チェックリストがあり、項目数が一致している場合はスキップ
        if (existing && (existing.items || []).length > 0 && (existing.items || []).length === items.length) continue;
        // 項目が0件のままなら再生成不要（entitiesにデータがない）
        if (existing && items.length === 0) continue;
        // 既存のcollected状態を引き継ぎ
        if (existing && (existing.items || []).length > 0) {
          const oldItems = existing.items || [];
          for (const item of items) {
            const oldItem = oldItems.find((o) => o.name === item.name);
            if (oldItem && oldItem.collected) {
              item.collected = true;
              item.collectedAt = oldItem.collectedAt;
              item.docIds = oldItem.docIds || [];
              item.fileCount = oldItem.fileCount || 0;
            }
          }
        }
        const completedCount = items.filter((i) => i.collected).length;
        const data = {
          entityName: ent.name,
          entityType: ent.type,
          items,
          completedCount,
          totalCount: items.length,
          updatedAt: FieldValue.serverTimestamp(),
        };
        batch.set(checklistCol.doc(yearMonth).collection("entities").doc(entDoc.id), data);
        entityChecklists[entDoc.id] = { ...data, updatedAt: new Date() };
        batchNeeded = true;
      }

      // 親ドキュメントも作成（存在しない場合）
      if (batchNeeded) {
        batch.set(checklistCol.doc(yearMonth), { createdAt: FieldValue.serverTimestamp() }, { merge: true });
        await batch.commit();
      }

      res.json({ yearMonth, entities: entityChecklists });

      // バックグラウンドでDriveファイル自動チェック（レスポンスを待たせない）
      autoCheckDriveFiles_(db, entitiesCol, checklistCol, yearMonth, allEntities.docs).catch((e) =>
        console.error("Drive自動チェックエラー（非致命的）:", e.message)
      );
    } catch (e) {
      console.error("チェックリスト取得エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // チェックリスト項目更新（手動チェック）
  // ========================================
  router.put("/checklist/:yearMonth/:entityId/item", async (req, res) => {
    try {
      const { yearMonth, entityId } = req.params;
      const { itemName, collected, memo } = req.body;
      if (!itemName) return res.status(400).json({ error: "itemNameは必須です" });

      const docRef = checklistCol.doc(yearMonth).collection("entities").doc(entityId);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "チェックリストが見つかりません" });

      const data = doc.data();
      const items = data.items || [];
      const idx = items.findIndex((i) => i.name === itemName);
      if (idx === -1) return res.status(404).json({ error: `項目「${itemName}」が見つかりません` });

      items[idx].collected = !!collected;
      items[idx].collectedAt = collected ? new Date() : null;
      if (memo !== undefined) items[idx].memo = memo;

      const completedCount = items.filter((i) => i.collected).length;
      await docRef.update({ items, completedCount, updatedAt: FieldValue.serverTimestamp() });

      res.json({ success: true, completedCount, totalCount: items.length });
    } catch (e) {
      console.error("チェックリスト更新エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // Driveファイル存在確認
  // ========================================
  router.post("/check-drive-files/:yearMonth", async (req, res) => {
    try {
      const { yearMonth } = req.params;
      const entSnap = await entitiesCol.orderBy("displayOrder").get();
      const results = await autoCheckDriveFiles_(db, entitiesCol, checklistCol, yearMonth, entSnap.docs);
      res.json({ yearMonth, results });
    } catch (e) {
      console.error("Driveチェックエラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 収集済み資料一覧
  // ========================================
  router.get("/collected", async (req, res) => {
    try {
      const { yearMonth, entityId, source } = req.query;
      let query = taxDocsCol.orderBy("collectedAt", "desc").limit(100);
      if (yearMonth) query = taxDocsCol.where("yearMonth", "==", yearMonth).orderBy("collectedAt", "desc");

      const snap = await query.get();
      let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (entityId) docs = docs.filter((d) => d.entityId === entityId);
      if (source) docs = docs.filter((d) => d.source === source);

      res.json({ docs });
    } catch (e) {
      console.error("収集済み取得エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // GAS→CF連携: 収集結果を記録
  // ========================================
  router.post("/record-collection", async (req, res) => {
    try {
      const { entityId, source, sourceAccount, yearMonth, fileName, driveFileId,
              driveFolderId, gmailMessageId, fileType, amount, transactionDate,
              description } = req.body;

      if (!entityId || !source || !yearMonth || !fileName) {
        return res.status(400).json({ error: "entityId, source, yearMonth, fileNameは必須です" });
      }

      // 重複チェック（gmailMessageId）
      if (gmailMessageId) {
        const dup = await taxDocsCol
          .where("gmailMessageId", "==", gmailMessageId)
          .where("entityId", "==", entityId)
          .limit(1).get();
        if (!dup.empty) {
          return res.json({ success: true, skipped: true, reason: "重複メール" });
        }
      }

      const docRef = await taxDocsCol.add({
        entityId,
        source,
        sourceAccount: sourceAccount || "",
        yearMonth,
        fileName,
        driveFileId: driveFileId || "",
        driveFolderId: driveFolderId || "",
        gmailMessageId: gmailMessageId || null,
        fileType: fileType || "pdf",
        status: "collected",
        amount: amount || null,
        transactionDate: transactionDate || null,
        description: description || "",
        collectedAt: FieldValue.serverTimestamp(),
        collectedBy: req.user.uid === "gas-collector" ? "auto" : "manual",
        memo: "",
      });

      // チェックリスト更新
      if (sourceAccount) {
        await updateChecklistItem_(db, yearMonth, entityId, sourceAccount, {
          collected: true,
          docId: docRef.id,
        });
      }

      res.json({ success: true, docId: docRef.id });
    } catch (e) {
      console.error("収集結果記録エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // フォルダ構造初期化
  // ========================================
  router.post("/init-folders/:entityId", async (req, res) => {
    try {
      const { entityId } = req.params;
      const { yearMonth } = req.body; // "2026-03" or 省略で今月

      const entDoc = await entitiesCol.doc(entityId).get();
      if (!entDoc.exists) return res.status(404).json({ error: "名義が見つかりません" });

      const ent = entDoc.data();
      if (!ent.taxFolderId) {
        return res.status(400).json({ error: "税理士共有フォルダIDが未設定です" });
      }

      const drive = await getDriveClient_();

      // 権限テスト
      try {
        await drive.files.get({ fileId: ent.taxFolderId, fields: "id,name", supportsAllDrives: true });
      } catch (e) {
        return res.status(400).json({
          error: `フォルダにアクセスできません。サービスアカウントを「編集者」として共有してください。\nフォルダID: ${ent.taxFolderId}\nエラー: ${e.message}`,
        });
      }

      const now = new Date();
      const ym = yearMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const [year, month] = ym.split("-");
      const yearStr = `${year}年`;
      const monthStr = `${parseInt(month)}月`;

      // 年月フォルダ作成
      const yearFolder = await getOrCreateSubfolder_(drive, ent.taxFolderId, yearStr);
      const monthFolder = await getOrCreateSubfolder_(drive, yearFolder.id, monthStr);

      // 口座別サブフォルダ作成
      const createdFolders = [];
      const accounts = ent.accounts || [];
      const platforms = ent.platforms || [];

      // 銀行
      const bankAccounts = accounts.filter((a) => a.category === "bank");
      if (bankAccounts.length > 0) {
        const bankFolder = await getOrCreateSubfolder_(drive, monthFolder.id, "銀行口座明細");
        for (const acc of bankAccounts) {
          await getOrCreateSubfolder_(drive, bankFolder.id, acc.name);
          createdFolders.push(`銀行口座明細/${acc.name}`);
        }
      }

      // クレカ
      const creditAccounts = accounts.filter((a) => a.category === "credit");
      if (creditAccounts.length > 0) {
        const creditFolder = await getOrCreateSubfolder_(drive, monthFolder.id, "クレジットカード明細");
        for (const acc of creditAccounts) {
          await getOrCreateSubfolder_(drive, creditFolder.id, acc.name);
          createdFolders.push(`クレジットカード明細/${acc.name}`);
        }
      }

      // プラットフォーム
      for (const plat of platforms) {
        await getOrCreateSubfolder_(drive, monthFolder.id, plat.name.replace(/送金明細|手数料請求書/g, "").trim() || plat.name);
        createdFolders.push(plat.name);
      }

      // 手動項目
      for (const manual of (ent.manualItems || [])) {
        await getOrCreateSubfolder_(drive, monthFolder.id, manual.name);
        createdFolders.push(manual.name);
      }

      // その他フォルダ
      await getOrCreateSubfolder_(drive, monthFolder.id, "その他");
      createdFolders.push("その他");

      res.json({
        success: true,
        entityName: ent.name,
        rootFolder: `${yearStr}/${monthStr}`,
        createdFolders,
      });
    } catch (e) {
      console.error("フォルダ初期化エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 即時収集（手動トリガー）
  // ========================================
  router.post("/collect-now", async (req, res) => {
    try {
      // Gmail設定チェック
      const gmailSettings = await db.collection("settings").doc("gmail").get();
      if (!gmailSettings.exists || !gmailSettings.data().enabled) {
        return res.json({ success: true, skipped: true, reason: "Gmail監視が無効です（settings/gmail.enabled=trueが必要）" });
      }
      if (!gmailSettings.data().userEmail) {
        return res.json({ success: true, skipped: true, reason: "Gmail userEmailが未設定です" });
      }
      // Gmail収集実行
      const collectTaxDocs = require("../scheduled/collectTaxDocs");
      await collectTaxDocs({});
      res.json({ success: true, skipped: false, message: "Gmail収集完了" });
    } catch (e) {
      console.error("即時収集エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 設定ステータス（全設定の状態を一括返却）
  // ========================================
  router.get("/setup-status", async (req, res) => {
    try {
      const [gmailDoc, notifDoc, taxDoc, scanDoc, oauthDoc] = await Promise.all([
        db.collection("settings").doc("gmail").get(),
        db.collection("settings").doc("notifications").get(),
        db.collection("settings").doc("taxDocs").get(),
        db.collection("settings").doc("scanSorter").get(),
        db.collection("settings").doc("gmailOAuth").get(),
      ]);
      const gmail = gmailDoc.exists ? gmailDoc.data() : {};
      const notif = notifDoc.exists ? notifDoc.data() : {};
      const tax = taxDoc.exists ? taxDoc.data() : {};
      const scan = scanDoc.exists ? scanDoc.data() : {};
      const oauth = oauthDoc.exists ? oauthDoc.data() : {};

      res.json({
        gmail: {
          configured: !!(gmail.enabled && gmail.userEmail && gmail.authMethod === "oauth2"),
          firestoreOnly: gmail.authMethod !== "oauth2",
          enabled: !!gmail.enabled,
          userEmail: gmail.userEmail || "",
          userEmails: gmail.userEmails || gmail.userEmail || "",
          authMethod: gmail.authMethod || "none",
          hasOAuthClient: !!(oauth.clientId),
          oauthClientIdMask: oauth.clientId ? oauth.clientId.slice(0, 10) + "..." : "",
        },
        line: {
          configured: !!(notif.lineChannelToken && notif.lineOwnerUserId),
          hasToken: !!notif.lineChannelToken,
          hasUserId: !!notif.lineOwnerUserId,
          hasSecret: !!notif.lineChannelSecret,
          enableLine: notif.enableLine !== false,
        },
        email: {
          enableEmail: !!notif.enableEmail,
          notifyEmails: notif.notifyEmails || [],
        },
        drive: {
          configured: !!scan.geminiApiKey, // Driveはサービスアカウント自動（設定不要）
          serviceAccountAuto: true,
        },
        gemini: {
          configured: !!scan.geminiApiKey,
        },
        taxDocs: {
          enabled: tax.enabled !== false,
          mfInboxFolderId: tax.mfInboxFolderId || "",
          gasSecret: tax.gasSecret ? "設定済み" : "",
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 設定一括保存
  // ========================================
  router.put("/setup", async (req, res) => {
    try {
      const { gmail, line, taxDocs } = req.body;
      const batch = db.batch();

      if (gmail) {
        batch.set(db.collection("settings").doc("gmail"), {
          enabled: !!gmail.enabled,
          userEmail: gmail.userEmail || "",
        }, { merge: true });
      }
      if (line) {
        const lineData = {};
        if (line.lineChannelToken) lineData.lineChannelToken = line.lineChannelToken;
        if (line.lineChannelSecret) lineData.lineChannelSecret = line.lineChannelSecret;
        if (line.lineOwnerUserId) lineData.lineOwnerUserId = line.lineOwnerUserId;
        if (line.enableLine !== undefined) lineData.enableLine = !!line.enableLine;
        if (line.enableEmail !== undefined) lineData.enableEmail = !!line.enableEmail;
        if (line.notifyEmails !== undefined) lineData.notifyEmails = line.notifyEmails;
        batch.set(db.collection("settings").doc("notifications"), lineData, { merge: true });
      }
      if (taxDocs) {
        batch.set(db.collection("settings").doc("taxDocs"), taxDocs, { merge: true });
      }

      // OAuth2クライアント設定
      const { oauthClientId, oauthClientSecret } = req.body;
      if (oauthClientId || oauthClientSecret) {
        const oauthData = { redirectUri: "https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/callback" };
        if (oauthClientId) oauthData.clientId = oauthClientId;
        if (oauthClientSecret) oauthData.clientSecret = oauthClientSecret;
        batch.set(db.collection("settings").doc("gmailOAuth"), oauthData, { merge: true });
      }

      await batch.commit();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 設定取得/更新（後方互換）
  // ========================================
  router.get("/settings", async (req, res) => {
    try {
      const doc = await db.collection("settings").doc("taxDocs").get();
      res.json(doc.exists ? doc.data() : {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      await db.collection("settings").doc("taxDocs").set(req.body, { merge: true });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 全名義に初期データ投入
  // ========================================
  router.post("/seed-entity-items", async (req, res) => {
    try {
      const snap = await entitiesCol.orderBy("displayOrder").get();
      if (snap.empty) return res.status(404).json({ error: "名義が登録されていません" });

      const results = [];
      for (const doc of snap.docs) {
        const ent = doc.data();
        const existingAccounts = ent.accounts || [];
        const existingPlatforms = ent.platforms || [];
        const existingManuals = ent.manualItems || [];
        const existingNames = new Set([
          ...existingAccounts.map((a) => a.name),
          ...existingPlatforms.map((p) => p.name),
          ...existingManuals.map((m) => m.name),
        ]);

        const isHoujin = ent.type === "法人";
        const accounts = [...existingAccounts];
        const platforms = [...existingPlatforms];
        const manualItems = [...existingManuals];

        // 重複しない項目のみ追加するヘルパー
        const addIfNew = (arr, item) => { if (!existingNames.has(item.name)) arr.push(item); };

        if (isHoujin) {
          addIfNew(accounts, { name: "楽天銀行 法人口座", category: "bank", source: "moneyforward", keywords: ["楽天銀行", "rakuten"] });
          addIfNew(accounts, { name: "住信SBIネット銀行 法人口座", category: "bank", source: "moneyforward", keywords: ["住信SBI", "sbi"] });
          addIfNew(accounts, { name: "楽天カード 法人", category: "credit", source: "moneyforward", keywords: ["楽天カード"] });
          addIfNew(platforms, { name: "Airbnb送金明細", fromEmails: ["automated@airbnb.com"], gmailQuery: "subject:送金", propertyName: "" });
          addIfNew(platforms, { name: "Booking.com送金明細", fromEmails: ["noreply@booking.com"], gmailQuery: "subject:請求", propertyName: "" });
          addIfNew(manualItems, { name: "くらさぽコネクト", category: "platform", memo: "手動ダウンロード" });
        } else {
          addIfNew(accounts, { name: "楽天銀行 個人口座", category: "bank", source: "moneyforward", keywords: ["楽天銀行", "rakuten"] });
          addIfNew(accounts, { name: "ゆうちょ銀行", category: "bank", source: "moneyforward", keywords: ["ゆうちょ"] });
          addIfNew(accounts, { name: "楽天カード 個人", category: "credit", source: "moneyforward", keywords: ["楽天カード"] });
          addIfNew(platforms, { name: "Airbnb送金明細", fromEmails: ["automated@airbnb.com"], gmailQuery: "subject:送金", propertyName: "" });
          addIfNew(manualItems, { name: "くらさぽコネクト", category: "platform", memo: "手動ダウンロード" });
        }

        const added = accounts.length - existingAccounts.length + platforms.length - existingPlatforms.length + manualItems.length - existingManuals.length;
        if (added === 0) {
          results.push({ id: doc.id, name: ent.name, status: "up-to-date" });
          continue;
        }

        await entitiesCol.doc(doc.id).update({ accounts, platforms, manualItems });
        results.push({ id: doc.id, name: ent.name, status: "seeded", added, accounts: accounts.length, platforms: platforms.length, manualItems: manualItems.length });
      }

      res.json({ success: true, results });
    } catch (e) {
      console.error("初期データ投入エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

// ========== Drive自動チェック（共通関数） ==========

/**
 * 全名義のDriveフォルダをスキャンし、チェックリストを自動更新
 * - ファイルが存在する項目は自動で collected=true にする
 * - チェックリスト取得時＋手動ボタン＋日次スケジュールから呼ばれる
 */
async function autoCheckDriveFiles_(db, entitiesCol, checklistCol, yearMonth, entityDocs) {
  const [year, month] = yearMonth.split("-");
  const yearStr = `${year}年`;
  const monthStr = `${parseInt(month)}月`;
  const results = {};

  let drive;
  try {
    drive = await getDriveClient_();
  } catch (e) {
    console.error("Drive APIクライアント初期化エラー:", e.message);
    return results;
  }

  for (const entDoc of entityDocs) {
    const ent = entDoc.data();
    if (!ent.taxFolderId) {
      results[entDoc.id] = { error: "税理士フォルダ未設定", found: 0, total: 0, missing: [] };
      continue;
    }

    // 年/月フォルダを探す
    let monthFolderId = null;
    try {
      const yearFolder = await findSubfolder_(drive, ent.taxFolderId, yearStr);
      if (yearFolder) {
        const mFolder = await findSubfolder_(drive, yearFolder.id, monthStr);
        if (mFolder) monthFolderId = mFolder.id;
      }
    } catch (e) {
      results[entDoc.id] = { error: `Driveアクセスエラー: ${e.message}`, found: 0, total: 0, missing: [] };
      continue;
    }

    if (!monthFolderId) {
      results[entDoc.id] = { error: "月フォルダなし", found: 0, total: 0, missing: [] };
      continue;
    }

    // フォルダ内の全ファイルをスキャン
    const driveFiles = await listAllFilesRecursive_(drive, monthFolderId);

    // チェックリスト更新
    const clRef = checklistCol.doc(yearMonth).collection("entities").doc(entDoc.id);
    const clDoc = await clRef.get();
    if (!clDoc.exists) continue;

    const clData = clDoc.data();
    const items = clData.items || [];
    if (items.length === 0) continue;

    let found = 0;
    const missing = [];
    let changed = false;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const keywords = getItemKeywords_(item, ent);
      const matchedFile = driveFiles.find((f) =>
        keywords.some((kw) => f.name.toLowerCase().includes(kw.toLowerCase()))
      );

      items[i].driveFileExists = !!matchedFile;
      items[i].driveCheckedAt = new Date();

      if (matchedFile) {
        found++;
        // ファイルが見つかったら自動でチェック入れる
        if (!items[i].collected) {
          items[i].collected = true;
          items[i].collectedAt = new Date();
          items[i].autoCollected = true; // 自動収集フラグ
          items[i].driveFileName = matchedFile.name;
          changed = true;
        }
      } else {
        missing.push(item.name);
      }
    }

    if (changed || items.some((i) => i.driveCheckedAt)) {
      const completedCount = items.filter((i) => i.collected).length;
      await clRef.update({ items, completedCount, updatedAt: FieldValue.serverTimestamp() });
    }

    results[entDoc.id] = { found, total: items.length, missing };
  }
  return results;
}

// ========== ヘルパー関数 ==========

/**
 * 名義データからチェックリスト項目を生成
 */
function buildChecklistItems_(entity) {
  const items = [];
  for (const acc of (entity.accounts || [])) {
    items.push({
      name: acc.name,
      category: acc.category,
      source: acc.source,
      required: true,
      collected: false,
      collectedAt: null,
      docIds: [],
      fileCount: 0,
      driveFileExists: false,
      driveCheckedAt: null,
    });
  }
  for (const plat of (entity.platforms || [])) {
    items.push({
      name: plat.name,
      category: "platform",
      source: "gmail",
      required: true,
      collected: false,
      collectedAt: null,
      docIds: [],
      fileCount: 0,
      driveFileExists: false,
      driveCheckedAt: null,
    });
  }
  for (const manual of (entity.manualItems || [])) {
    items.push({
      name: manual.name,
      category: manual.category || "other",
      source: "manual",
      required: true,
      collected: false,
      collectedAt: null,
      docIds: [],
      fileCount: 0,
      driveFileExists: false,
      driveCheckedAt: null,
    });
  }
  return items;
}

/**
 * チェックリスト項目のキーワード取得（Driveファイルマッチ用）
 */
function getItemKeywords_(item, entity) {
  // accounts からキーワードを検索
  const acc = (entity.accounts || []).find((a) => a.name === item.name);
  if (acc && acc.keywords && acc.keywords.length > 0) return acc.keywords;

  // プラットフォーム名の一部
  const plat = (entity.platforms || []).find((p) => p.name === item.name);
  if (plat) {
    const keywords = [plat.name.split("送金")[0], plat.name.split("手数料")[0]].filter(Boolean);
    if (plat.propertyName) keywords.push(plat.propertyName);
    return keywords.length > 0 ? keywords : [item.name];
  }

  // デフォルト: 項目名そのまま
  return [item.name];
}

/**
 * チェックリスト項目を更新
 */
async function updateChecklistItem_(db, yearMonth, entityId, itemName, updates) {
  const docRef = db.collection("taxDocsChecklist").doc(yearMonth).collection("entities").doc(entityId);
  const doc = await docRef.get();
  if (!doc.exists) return;

  const data = doc.data();
  const items = data.items || [];
  const idx = items.findIndex((i) => i.name === itemName);
  if (idx === -1) return;

  if (updates.collected !== undefined) items[idx].collected = updates.collected;
  if (updates.collected) items[idx].collectedAt = new Date();
  if (updates.docId) {
    if (!items[idx].docIds) items[idx].docIds = [];
    items[idx].docIds.push(updates.docId);
    items[idx].fileCount = items[idx].docIds.length;
  }

  const completedCount = items.filter((i) => i.collected).length;
  await docRef.update({ items, completedCount, updatedAt: require("firebase-admin/firestore").FieldValue.serverTimestamp() });
}

// ========== Google Drive ヘルパー ==========

async function getDriveClient_() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

async function getOrCreateSubfolder_(drive, parentId, name) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files && res.data.files.length > 0) return res.data.files[0];

  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    supportsAllDrives: true,
    fields: "id,name",
  });
  return created.data;
}

async function findSubfolder_(drive, parentId, name) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files && res.data.files.length > 0) ? res.data.files[0] : null;
}

async function listAllFilesRecursive_(drive, folderId) {
  const files = [];
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id,name,mimeType)",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  for (const f of (res.data.files || [])) {
    files.push(f);
    if (f.mimeType === "application/vnd.google-apps.folder") {
      const subFiles = await listAllFilesRecursive_(drive, f.id);
      files.push(...subFiles);
    }
  }
  return files;
}
