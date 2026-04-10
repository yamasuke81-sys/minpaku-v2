/**
 * スキャン自動仕分け API
 * Google Drive監視 + Gemini OCR + Firestore管理
 * v0402f — 旧PDFリネームツール全機能を統合（参照ファイル検索、フォルダブラウザ、学習フィードバック、バッチundo等）
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { google } = require("googleapis");

// 定数
const AUTO_APPROVE_THRESHOLD = 80;
const DOC_TYPES = ["領収書", "請求書", "契約書", "通帳", "納税通知", "保険", "物件資料", "その他"];

module.exports = function scanSorterApi(db) {
  const router = Router();
  const logsCol = db.collection("scanLogs");
  const learningCol = db.collection("scanLearning");
  const categoriesCol = db.collection("scanCategories");
  const feedbackCol = db.collection("scanFeedback");
  const renameLearningCol = db.collection("scanRenameLearning");
  const taxLearningCol = db.collection("scanTaxLearning");
  const execHistoryCol = db.collection("scanExecutionHistory");

  // ========================================
  // 設定取得
  // ========================================
  router.get("/settings", async (req, res) => {
    try {
      const doc = await db.collection("settings").doc("scanSorter").get();
      const settings = doc.exists ? doc.data() : {};
      res.json(settings);
    } catch (e) {
      console.error("設定取得エラー:", e);
      res.status(500).json({ error: "設定の取得に失敗しました" });
    }
  });

  // 設定保存
  router.put("/settings", async (req, res) => {
    try {
      await db.collection("settings").doc("scanSorter").set(req.body, { merge: true });
      res.json({ success: true });
    } catch (e) {
      console.error("設定保存エラー:", e);
      res.status(500).json({ error: "設定の保存に失敗しました" });
    }
  });

  // ========================================
  // デバッグ: 設定とサービスアカウント確認
  // ========================================
  router.get("/debug", async (req, res) => {
    try {
      const settings = await getSettings_(db);
      const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive"] });
      const client = await auth.getClient();
      // サービスアカウントのメールを複数の方法で取得
      let saEmail = client.email || "";
      if (!saEmail) {
        try {
          const credentials = await auth.getCredentials();
          saEmail = credentials.client_email || "";
        } catch (e) {}
      }
      if (!saEmail) {
        try {
          // メタデータサーバーから取得（Cloud Functions/Cloud Run環境）
          const metaRes = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", {
            headers: { "Metadata-Flavor": "Google" }
          });
          saEmail = await metaRes.text();
        } catch (e) {}
      }
      if (!saEmail) saEmail = "(取得失敗 — Cloud Consoleで確認してください)";

      // フォルダアクセステスト
      const drive = google.drive({ version: "v3", auth });

      // 指定フォルダのテスト（クエリパラメータで受け取り）
      const testFolderId = req.query.testFolder || "";
      let folderTest = "";
      if (testFolderId) {
        try {
          const meta = await drive.files.get({ fileId: testFolderId, fields: "id,name,owners", supportsAllDrives: true });
          const owners = (meta.data.owners || []).map(o => o.emailAddress).join(", ");
          folderTest = `OK: 「${meta.data.name}」(オーナー: ${owners})`;
        } catch (e) {
          folderTest = `エラー: ${e.message}`;
        }
      }

      let inboxTest = "未テスト";
      if (settings.folderInbox) {
        try {
          const r = await drive.files.list({
            q: `'${settings.folderInbox}' in parents and trashed=false`,
            fields: "files(id,name,mimeType)",
            pageSize: 5,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          inboxTest = `OK: ${(r.data.files || []).length}件（先頭5件: ${(r.data.files || []).map(f => f.name + " [" + f.mimeType + "]").join(", ")})`;
        } catch (e) {
          inboxTest = `エラー: ${e.message}`;
        }
      }

      res.json({
        serviceAccount: saEmail,
        folderInbox: settings.folderInbox || "(未設定)",
        folderProcessed: settings.folderProcessed || "(未設定)",
        folderTaxShare: settings.folderTaxShare || "(未設定)",
        inboxTest,
        folderTest: folderTest || "(testFolderパラメータ未指定)",
        note: "サービスアカウントにフォルダを共有する必要があります。上記メールアドレスをGoogleドライブのフォルダ共有に「編集者」として追加してください。",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 受信BOX一覧取得（Google Drive）
  // ========================================
  router.get("/inbox", async (req, res) => {
    try {
      const settings = await getSettings_(db);
      if (!settings.folderInbox) {
        return res.status(400).json({ error: "受信BOXフォルダが設定されていません" });
      }

      const drive = await getDriveClient_();

      // デバッグ: フォルダ自体にアクセスできるか確認
      let folderName = "(取得失敗)";
      try {
        const folderMeta = await drive.files.get({
          fileId: settings.folderInbox,
          fields: "id,name,mimeType",
          supportsAllDrives: true,
        });
        folderName = folderMeta.data.name;
      } catch (e) {
        return res.json({ files: [], total: 0, unprocessed: 0, debug: { error: "フォルダアクセス不可: " + e.message, folderId: settings.folderInbox } });
      }

      // デバッグ: まずPDF制限なしで全ファイルを取得
      const allFilesResponse = await drive.files.list({
        q: `'${settings.folderInbox}' in parents and trashed=false`,
        fields: "files(id,name,mimeType)",
        pageSize: 10,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const allFiles = allFilesResponse.data.files || [];

      // PDF のみ
      const response = await drive.files.list({
        q: `'${settings.folderInbox}' in parents and mimeType='application/pdf' and trashed=false`,
        fields: "files(id,name,createdTime,size)",
        orderBy: "createdTime desc",
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      // 処理済みファイルIDを取得して除外
      const processedSnap = await logsCol.where("status", "!=", "❌ エラー").select("fileId").get();
      const processedIds = new Set(processedSnap.docs.map((d) => d.data().fileId));

      const files = (response.data.files || []).map((f) => ({
        id: f.id,
        name: f.name,
        createdTime: f.createdTime,
        size: f.size,
        processed: processedIds.has(f.id),
      }));

      res.json({
        files,
        total: files.length,
        unprocessed: files.filter((f) => !f.processed).length,
        debug: {
          folderName,
          folderId: settings.folderInbox,
          allFilesInFolder: allFiles.map((f) => `${f.name} [${f.mimeType}]`),
          pdfCount: (response.data.files || []).length,
        },
      });
    } catch (e) {
      console.error("受信BOX取得エラー:", e);
      res.status(500).json({ error: "受信BOXの取得に失敗しました: " + e.message });
    }
  });

  // ========================================
  // ログ一覧取得（Firestoreから）
  // ========================================
  router.get("/logs", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const statusFilter = req.query.status; // "pending" | "completed" | "error" | all
      let query = logsCol.orderBy("processDate", "desc").limit(limit);
      if (statusFilter === "pending") {
        query = logsCol.where("needsReview", "==", true).where("status", "==", "⏳ 確認待ち").orderBy("processDate", "desc").limit(limit);
      }
      const snap = await query.get();
      const logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json(logs);
    } catch (e) {
      console.error("ログ取得エラー:", e);
      res.status(500).json({ error: "ログの取得に失敗しました" });
    }
  });

  // ========================================
  // 1ファイルを処理（OCR + 分類）
  // ========================================
  router.post("/process/:fileId", async (req, res) => {
    try {
      const { fileId } = req.params;

      // 既に処理済みかチェック
      const existing = await logsCol.where("fileId", "==", fileId).get();
      if (!existing.empty) {
        return res.status(409).json({ error: "このファイルは既に処理済みです" });
      }

      const settings = await getSettings_(db);
      const drive = await getDriveClient_();

      // ファイル情報取得
      const fileMeta = await drive.files.get({ fileId, fields: "name,createdTime,mimeType", supportsAllDrives: true });

      // PDFバイナリ取得
      const pdfResponse = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      const pdfBase64 = Buffer.from(pdfResponse.data).toString("base64");

      // フィードバック・リネーム学習データを取得（Geminiプロンプトに注入）
      const feedbackHistory = await getRecentFeedback_(feedbackCol);
      const renameHistory = await getRecentRenameLearning_(renameLearningCol);

      // Gemini APIで解析（リネームルール/前提条件を含む）
      const renameRules = settings.renameRules || "";
      const analysis = await analyzeWithGemini_(pdfBase64, settings.geminiApiKey, feedbackHistory, renameHistory, renameRules);

      // 学習データで科目を補正
      const learned = await getLearned_(learningCol, analysis.vendor);
      if (learned && analysis.confidence < 90) {
        analysis.category = learned;
        analysis.confidence = Math.min(analysis.confidence + 15, 95);
      }

      // 科目マスタから税理士共有フラグ取得
      const catSnap = await categoriesCol.where("name", "==", analysis.category).limit(1).get();
      const taxShare = catSnap.empty ? false : (catSnap.docs[0].data().taxShare || false);

      // リネーム名生成
      const newName = buildFileName_(analysis);

      // ログに保存
      const logData = {
        fileId,
        origName: fileMeta.data.name,
        newName,
        scanDate: fileMeta.data.createdTime,
        processDate: FieldValue.serverTimestamp(),
        docTitle: analysis.docTitle || analysis.docType || "その他",
        docDetail: analysis.docDetail || "",
        docType: analysis.docType || analysis.docTitle || "その他",
        vendor: analysis.vendor,
        amount: analysis.amount,
        docDate: analysis.docDate,
        // 物件マスタに存在しない物件名は無視
        propertyName: "",
        suggestedPropertyName: analysis.propertyName || "",
        category: analysis.category,
        summary: analysis.summary,
        confidence: analysis.confidence,
        entityType: analysis.entityType || "不明",
        taxFolders: analysis.taxFolders || [],
        taxShare,
        needsReview: true,
        status: "⏳ 確認待ち",
        refFileId: "",
        refFileName: "",
        refFolderId: "",
        destFolderId: "",
        destFolder2Id: "",
        taxShareFolders: [],
      };
      const logRef = await logsCol.add(logData);

      // 物件マスタから移動先・税理士フォルダを自動選定
      try {
        const propName = analysis.propertyName || "";
        if (propName && propName !== "その他" && !propName.includes("共通")) {
          // 曖昧マッチング（表記揺れ対応: スペース/大小文字/全半角を無視）
          const allPropsSnap = await db.collection("properties").get();
          let matchedProp = null;
          const normalize = (s) => String(s || "").toLowerCase().replace(/[\s\u3000　_\-・]/g, "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
          const normalizedInput = normalize(propName);

          for (const doc of allPropsSnap.docs) {
            const p = doc.data();
            const normalizedName = normalize(p.name);
            // 完全一致 or 部分一致 or 入力が物件名を含む or 物件名が入力を含む
            if (normalizedName === normalizedInput ||
                normalizedInput.includes(normalizedName) ||
                normalizedName.includes(normalizedInput)) {
              matchedProp = { id: doc.id, ...p };
              // propertyNameを正規化された物件名に更新
              if (p.name !== propName) {
                await logRef.update({ propertyName: p.name });
              }
              break;
            }
          }

          if (matchedProp) {
            const prop = matchedProp;
            const autoUpdate = {};

            // 移動先1: ルール→学習→最近→物件フォルダの優先順で決定
            if (prop.driveFolderId) {
              let destResolved = false;
              const docTitle = String(analysis.docTitle || analysis.docType || "").toLowerCase();
              const category = String(analysis.category || "").toLowerCase();

              // 1. ルールベース（destFolderRules）
              const rules = prop.destFolderRules || [];
              for (const rule of rules) {
                if (!rule.folderId) continue;
                const rDocType = (rule.docType || "").toLowerCase();
                const rCategory = (rule.category || "").toLowerCase();
                const docTitleMatch = !rDocType || docTitle.includes(rDocType) || rDocType.includes(docTitle);
                const catMatch = !rCategory || category.includes(rCategory) || rCategory.includes(category);
                if (docTitleMatch && catMatch && (rDocType || rCategory)) {
                  autoUpdate.destFolderId = rule.folderId;
                  autoUpdate.destFolderPath = rule.folderPath || rule.folderId;
                  destResolved = true;
                  break;
                }
              }

              // 2. Driveサブフォルダ動的マッチング
              if (!destResolved && prop.driveFolderId) {
                try {
                  const drive = await getDriveClient_();
                  const sfRes = await drive.files.list({
                    q: `'${prop.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                    fields: "files(id,name)", orderBy: "name", pageSize: 100,
                    supportsAllDrives: true, includeItemsFromAllDrives: true,
                  });
                  const subfolders = sfRes.data.files || [];
                  if (subfolders.length > 0) {
                    const newName = buildFileName_(analysis).toLowerCase();
                    const keywords = [docTitle, category, String(analysis.vendor || "").toLowerCase(), String(analysis.docDetail || "").toLowerCase()].filter(Boolean);
                    let bestMatch = null, bestScore = 0;
                    for (const sf of subfolders) {
                      const sfName = sf.name.replace(/^\d+\s*/, "").trim().toLowerCase();
                      let score = 0;
                      for (const kw of keywords) {
                        if (!kw) continue;
                        if (sfName === kw) score += 10;
                        else if (sfName.includes(kw) || kw.includes(sfName)) score += 5;
                        else if (sfName.length >= 2 && kw.length >= 2) {
                          for (let len = Math.min(sfName.length, kw.length); len >= 2; len--) {
                            if (kw.includes(sfName.substring(0, len)) || sfName.includes(kw.substring(0, len))) { score += 2; break; }
                          }
                        }
                      }
                      if (score === 0 && newName && sfName.length >= 2 && newName.includes(sfName)) score += 3;
                      if (score > bestScore) { bestScore = score; bestMatch = sf; }
                    }
                    if (bestMatch && bestScore >= 3) {
                      autoUpdate.destFolderId = bestMatch.id;
                      autoUpdate.destFolderPath = bestMatch.name;
                      destResolved = true;
                    }
                  }
                } catch (e) {}
              }

              // 3. 学習ベース（scanDestLearning）
              if (!destResolved && analysis.propertyName && (docTitle || category)) {
                try {
                  let learnSnap;
                  const learnDocType = analysis.docTitle || analysis.docType || "";
                  if (docTitle && category) {
                    learnSnap = await db.collection("scanDestLearning")
                      .where("propertyName", "==", analysis.propertyName)
                      .where("docType", "==", learnDocType)
                      .where("category", "==", analysis.category)
                      .orderBy("count", "desc").limit(1).get();
                  }
                  if (!learnSnap || learnSnap.empty) {
                    if (docTitle) {
                      learnSnap = await db.collection("scanDestLearning")
                        .where("propertyName", "==", analysis.propertyName)
                        .where("docType", "==", learnDocType)
                        .orderBy("count", "desc").limit(1).get();
                    }
                  }
                  if (learnSnap && !learnSnap.empty) {
                    const ld = learnSnap.docs[0].data();
                    autoUpdate.destFolderId = ld.destFolderId;
                    autoUpdate.destFolderPath = ld.destFolderPath;
                    destResolved = true;
                  }
                } catch (e) {
                  // インデックス未作成等は無視
                }
              }

              // 3. 最近の保存先
              if (!destResolved) {
                const recent = (prop.recentDestFolders || []);
                if (recent.length > 0) {
                  autoUpdate.destFolderId = recent[0].id;
                  autoUpdate.destFolderPath = recent[0].path || recent[0].id;
                } else {
                  autoUpdate.destFolderId = prop.driveFolderId;
                  autoUpdate.destFolderPath = prop.driveFolderPath || prop.driveFolderId;
                }
              }
            }

            // 名義から税理士フォルダを自動選定（entities対応）
            if (prop.entityId) {
              autoUpdate.taxShareFolders = [prop.entityId];
            } else if (prop.entityType) {
              // 後方互換: 旧entityType("法人"/"個人")からentitiesを検索
              const entitySnap = await db.collection("entities").get();
              for (const doc of entitySnap.docs) {
                const e = doc.data();
                if (e.type === prop.entityType || e.name === prop.entityType) {
                  autoUpdate.taxShareFolders = [doc.id];
                  break;
                }
              }
            }

            if (Object.keys(autoUpdate).length > 0) {
              await logRef.update(autoUpdate);
              console.log(`[process] 物件「${propName}」から自動選定:`, JSON.stringify(autoUpdate));
            }
          }
        }
      } catch (autoErr) {
        console.error("物件マスタ自動選定エラー:", autoErr.message);
      }

      res.json({ id: logRef.id, ...logData });
    } catch (e) {
      console.error("ファイル処理エラー:", e);
      res.status(500).json({ error: "ファイル処理に失敗しました: " + e.message });
    }
  });

  // ========================================
  // 受信BOX全件処理
  // ========================================
  router.post("/process-all", async (req, res) => {
    try {
      const settings = await getSettings_(db);
      if (!settings.folderInbox || !settings.geminiApiKey) {
        return res.status(400).json({ error: "受信BOXフォルダまたはGemini APIキーが設定されていません" });
      }

      const drive = await getDriveClient_();
      const response = await drive.files.list({
        q: `'${settings.folderInbox}' in parents and mimeType='application/pdf' and trashed=false`,
        fields: "files(id,name,createdTime)",
        orderBy: "createdTime asc",
        pageSize: 50,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      // 処理済みを除外
      const processedSnap = await logsCol.select("fileId").get();
      const processedIds = new Set(processedSnap.docs.map((d) => d.data().fileId));
      const unprocessed = (response.data.files || []).filter((f) => !processedIds.has(f.id));

      // レスポンスを先に返す（処理は非同期で続行しない — Cloud Functionsの制限）
      // フロントエンドが1件ずつ /process/:fileId を呼ぶ方式を推奨
      res.json({
        total: response.data.files?.length || 0,
        unprocessed: unprocessed.length,
        files: unprocessed.map((f) => ({ id: f.id, name: f.name })),
      });
    } catch (e) {
      console.error("全件処理エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 手動承認（確認待ち → 承認実行）
  // 実行履歴を保存し、destFolder2・税理士共有フォルダ複数対応
  // ========================================
  router.post("/approve/:logId", async (req, res) => {
    try {
      const { logId } = req.params;
      const { category, vendor, newName } = req.body;

      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      const settings = await getSettings_(db);
      const drive = await getDriveClient_();

      // 修正値があればマージ
      const finalCategory = category || logData.category;
      const finalVendor = vendor || logData.vendor;
      const finalName = newName || logData.newName;

      const catSnap = await categoriesCol.where("name", "==", finalCategory).limit(1).get();
      const taxShare = catSnap.empty ? false : (catSnap.docs[0].data().taxShare || false);

      const analysis = { docType: logData.docType, docTitle: logData.docTitle, docDetail: logData.docDetail, docDate: logData.docDate, category: finalCategory, vendor: finalVendor };

      // 実行前にファイルの現在位置を記録
      const fileMeta = await drive.files.get({ fileId: logData.fileId, fields: "name,parents", supportsAllDrives: true });
      const batchId = `batch-${Date.now()}`;

      // メインフォルダへ移動（移動先1が必須）
      let moveResult;
      const destFolderId = logData.destFolderId || "";
      if (!destFolderId) {
        return res.status(400).json({ error: "移動先1が未設定です。スキャン仕分け画面で移動先1を指定してください。" });
      }
      try {
        moveResult = await moveFileToFolder_(drive, logData.fileId, finalName, destFolderId);
        // コピー方式でfileIdが変わった場合はscanLogを更新
        if (moveResult.newFileId) {
          logData.fileId = moveResult.newFileId;
          await logsCol.doc(logId).update({ fileId: moveResult.newFileId });
        }
      } catch (moveErr) {
        console.error("ファイル移動エラー:", moveErr.message);
        return res.status(500).json({ error: "ファイル移動に失敗しました: " + moveErr.message });
      }

      // 実行履歴を保存
      await execHistoryCol.add({
        batchId,
        logId,
        fileId: logData.fileId,
        originalName: fileMeta.data.name,
        originalFolderId: (fileMeta.data.parents || [])[0] || "",
        newName: finalName,
        destFolderId: moveResult.folderId || "",
        destFolderName: moveResult.folderName,
        action: "move",
        executedAt: FieldValue.serverTimestamp(),
      });

      // destFolder2（セカンダリコピー先）がある場合 — ショートカットを作成
      if (logData.destFolder2Id) {
        try {
          const cleanName = finalName.replace(/[\\/:*?"<>|]/g, "").trim() + (finalName.toLowerCase().endsWith(".pdf") ? "" : ".pdf");
          await copyFileWithOwnerTransfer_(drive, logData.fileId, cleanName, logData.destFolder2Id);
          await execHistoryCol.add({
            batchId,
            logId,
            fileId: logData.fileId,
            originalName: fileMeta.data.name,
            originalFolderId: (fileMeta.data.parents || [])[0] || "",
            newName: finalName,
            destFolderId: logData.destFolder2Id,
            action: "copy-dest2",
            executedAt: FieldValue.serverTimestamp(),
          });
        } catch (copyErr) {
          console.error("destFolder2コピーエラー:", copyErr.message);
        }
      }

      // 税理士共有フォルダ（taxFolders設定から直接フォルダIDを取得してコピー）
      const taxShareFolders = logData.taxShareFolders || [];
      const taxCopyResults = {};
      console.log(`[approve ${logId}] taxShareFolders=${JSON.stringify(taxShareFolders)}`);
      if (taxShareFolders.length > 0) {
        // entities（名義マスタ）からフォルダID一覧を取得（旧taxFoldersとの後方互換あり）
        const entitySnap = await db.collection("entities").get();
        const taxFolderMap = {}; // { name: taxFolderId, id: taxFolderId }
        for (const doc of entitySnap.docs) {
          const e = doc.data();
          if (e.taxFolderId) {
            taxFolderMap[e.name || ""] = e.taxFolderId;
            taxFolderMap[doc.id] = e.taxFolderId;
          }
        }
        // 後方互換: 旧taxFoldersからも検索
        try {
          const oldTaxSnap = await db.collection("settings").doc("scanSorter").collection("taxFolders").get();
          for (const doc of oldTaxSnap.docs) {
            const d = doc.data();
            if (!taxFolderMap[doc.id] && d.folderId) {
              taxFolderMap[d.name || ""] = d.folderId;
              taxFolderMap[doc.id] = d.folderId;
            }
          }
        } catch (e) {}

        for (const folderNameOrId of taxShareFolders) {
          const taxParentFolderId = taxFolderMap[folderNameOrId];
          if (!taxParentFolderId) {
            console.error(`税理士フォルダ「${folderNameOrId}」のフォルダIDが設定に見つかりません`);
            taxCopyResults[folderNameOrId] = { error: "フォルダIDが設定に見つかりません" };
            continue;
          }

          // parentFolderIdだけ返す（サブフォルダ作成+コピーはフロントエンドで実行）
          taxCopyResults[folderNameOrId] = {
            parentFolderId: taxParentFolderId,
            needsCopy: true,
          };
        }
      }

      await logsCol.doc(logId).update({
        status: "✅ 完了（→ " + moveResult.folderName + "）",
        destFolder: moveResult.folderName,
        destFolderId: moveResult.folderId || "",
        destFolderPath: moveResult.folderName || "",
        category: finalCategory,
        vendor: finalVendor,
        newName: finalName,
        entityType: logData.entityType || "不明",
        taxShare,
        taxCopyResults,
        batchId,
        checked: false,
        needsReview: false,
        approvedAt: FieldValue.serverTimestamp(),
      });

      // 学習データに追加
      await saveLearning_(learningCol, finalVendor, finalCategory);

      // 物件マスタにrecentDestFoldersを蓄積
      if (logData.propertyName && logData.propertyName !== "その他" && moveResult.folderId) {
        try {
          const propSnap = await db.collection("properties").where("name", "==", logData.propertyName).limit(1).get();
          if (!propSnap.empty) {
            const prop = propSnap.docs[0];
            const recent = prop.data().recentDestFolders || [];
            // 重複排除して先頭に追加、最大5件
            const filtered = recent.filter(f => f.id !== moveResult.folderId);
            filtered.unshift({ id: moveResult.folderId, path: moveResult.folderName });
            await prop.ref.update({ recentDestFolders: filtered.slice(0, 5) });
          }
        } catch (e) {}
      }

      // 移動先学習データ（scanDestLearning）を保存/更新
      // 移動先学習データ: docTitle優先、後方互換でdocTypeフォールバック
      const learnDocType = logData.docTitle || logData.docType || "";
      if (logData.propertyName && learnDocType && moveResult.folderId) {
        try {
          const learnQuery = await db.collection("scanDestLearning")
            .where("propertyName", "==", logData.propertyName)
            .where("docType", "==", learnDocType)
            .where("category", "==", finalCategory || "")
            .where("destFolderId", "==", moveResult.folderId)
            .limit(1).get();

          if (!learnQuery.empty) {
            // 既存エントリを更新
            await learnQuery.docs[0].ref.update({
              count: FieldValue.increment(1),
              lastUsed: FieldValue.serverTimestamp(),
              destFolderPath: moveResult.folderName || "",
            });
          } else {
            // 新規エントリを作成
            await db.collection("scanDestLearning").add({
              propertyName: logData.propertyName,
              docType: learnDocType,
              category: finalCategory || "",
              destFolderId: moveResult.folderId,
              destFolderPath: moveResult.folderName || "",
              count: 1,
              lastUsed: FieldValue.serverTimestamp(),
            });
          }
        } catch (e) {
          console.warn("移動先学習データ保存エラー:", e.message);
        }
      }

      res.json({
        success: true,
        folderName: moveResult.folderName,
        batchId,
        taxCopyResults,
        debug: {
          taxShareFolders,
          folderTaxShare: settings.folderTaxShare || "(未設定)",
          finalName,
        },
      });
    } catch (e) {
      console.error("承認実行エラー:", e);
      res.status(500).json({ error: "承認実行に失敗しました: " + e.message });
    }
  });

  // ========================================
  // ログ更新（カテゴリ・取引先・ファイル名の手動修正）
  // ========================================
  router.patch("/logs/:logId", async (req, res) => {
    try {
      const allowed = ["category", "vendor", "newName", "docType", "docTitle", "docDetail", "amount", "docDate"];
      const update = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) update[key] = req.body[key];
      }
      // docTitle/docDetail変更時は後方互換用docTypeも更新
      if (update.docTitle !== undefined || update.docDetail !== undefined) {
        const logDoc2 = await logsCol.doc(req.params.logId).get();
        const existing = logDoc2.exists ? logDoc2.data() : {};
        const finalTitle = update.docTitle !== undefined ? update.docTitle : (existing.docTitle || existing.docType || "");
        const finalDetail = update.docDetail !== undefined ? update.docDetail : (existing.docDetail || "");
        update.docTitle = finalTitle;
        update.docDetail = finalDetail;
        update.docType = finalDetail ? `${finalTitle}(${finalDetail})` : finalTitle;
      }
      if (update.category || update.vendor || update.docDate || update.docType || update.docTitle || update.docDetail || update.amount !== undefined) {
        // リネーム名を再生成
        const logDoc = await logsCol.doc(req.params.logId).get();
        if (logDoc.exists) {
          const d = { ...logDoc.data(), ...update };
          update.newName = buildFileName_(d);
        }
      }
      await logsCol.doc(req.params.logId).update(update);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 科目マスタ CRUD
  // ========================================
  router.get("/categories", async (req, res) => {
    try {
      const snap = await categoriesCol.orderBy("code").get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/categories/init", async (req, res) => {
    try {
      const defaults = [
        // --- 1. 収益（売上）の部 ---
        { code: "010", name: "売上高（宿泊料）", group: "収益", keywords: "民泊収入,宿泊代金,キャンセル料,宿泊売上", taxRate: 10, taxShare: true },
        { code: "020", name: "賃貸料収入", group: "収益", keywords: "家賃収入,共益費,駐車場代,賃料収入", taxRate: 10, taxShare: true },
        { code: "030", name: "不動産売却高", group: "収益", keywords: "物件売却,出口戦略,譲渡対価,売却益", taxRate: 10, taxShare: true },
        { code: "040", name: "受取利息", group: "収益", keywords: "預金利息,事業用口座,銀行利息", taxRate: 0, taxShare: true },
        { code: "050", name: "雑収入", group: "収益", keywords: "自販機手数料,太陽光売電,補助金収入,還付金", taxRate: 10, taxShare: true },
        // --- 2. 費用（経費）の部 ---
        { code: "110", name: "消耗品費", group: "費用", keywords: "ヤマダ電機,ビックカメラ,Amazon,ニトリ,ホームセンター,洗剤,シーツ,日用品", taxRate: 10, taxShare: true },
        { code: "120", name: "水道光熱費", group: "費用", keywords: "電力,ガス,水道,東京電力,関西電力,中部電力,大阪ガス,東邦ガス,電気代,ガス代,上下水道", taxRate: 10, taxShare: true },
        { code: "130", name: "通信費", group: "費用", keywords: "NTT,ソフトバンク,au,KDDI,docomo,Wi-Fi,インターネット,ポケットWi-Fi,ゲスト用Wi-Fi,予約管理システム,切手代", taxRate: 10, taxShare: true },
        { code: "140", name: "地代家賃", group: "費用", keywords: "家賃,賃料,管理費,共益費,駐車場", taxRate: 10, taxShare: true },
        { code: "150", name: "損害保険料", group: "費用", keywords: "火災保険,地震保険,損害保険,あいおい,東京海上,損保ジャパン,施設賠償", taxRate: 0, taxShare: true },
        { code: "160", name: "租税公課", group: "費用", keywords: "固定資産税,都市計画税,不動産取得税,登録免許税,印紙税,印紙代,自動車税,事業税,住民税", taxRate: 0, taxShare: true },
        { code: "170", name: "修繕費", group: "費用", keywords: "修理,修繕,工事,リフォーム,メンテナンス,設備交換,塗装,原状回復,外壁塗装,設備修理", taxRate: 10, taxShare: true },
        { code: "180", name: "旅費交通費", group: "費用", keywords: "交通,タクシー,JR,電車,バス,飛行機,ETC,高速,ガソリン,出張,物件視察,現場移動,駐車料金", taxRate: 10, taxShare: true },
        { code: "190", name: "接待交際費", group: "費用", keywords: "飲食,会食,贈答,お歳暮,お中元,手土産,接待,ゴルフ,贈答品", taxRate: 10, taxShare: true },
        { code: "200", name: "雑費", group: "費用", keywords: "", taxRate: 10, taxShare: true },
        { code: "210", name: "外注費", group: "費用", keywords: "業務委託,清掃,クリーニング,ハウスキーピング,委託料,外注,清掃代行,運営委託,リネン交換", taxRate: 10, taxShare: true },
        { code: "220", name: "減価償却費", group: "費用", keywords: "減価償却,償却,建物,設備,器具備品,車両", taxRate: 0, taxShare: true },
        { code: "230", name: "支払利息", group: "費用", keywords: "利息,借入金,ローン,融資,金利,返済,ローン金利,融資利息,借入金利", taxRate: 0, taxShare: true },
        { code: "240", name: "広告宣伝費", group: "費用", keywords: "広告,宣伝,Airbnb,Booking.com,じゃらん,OTA,掲載料,PR,物件写真撮影,ポータル掲載,看板製作", taxRate: 10, taxShare: true },
        { code: "250", name: "支払手数料", group: "費用", keywords: "手数料,振込手数料,仲介手数料,決済手数料,クレジットカード,OTA手数料", taxRate: 10, taxShare: true },
        { code: "260", name: "管理費", group: "費用", keywords: "管理委託,マンション管理,管理組合,共益費", taxRate: 10, taxShare: true },
        { code: "270", name: "リネン費", group: "費用", keywords: "リネン,シーツ,タオル,クリーニング,洗濯,コインランドリー,アメニティ,タオル洗濯,衛生用品", taxRate: 10, taxShare: true },
        { code: "280", name: "新聞図書費", group: "費用", keywords: "新聞,書籍,雑誌,セミナー,研修,参考書,不動産実務書,経済新聞,有料メルマガ", taxRate: 10, taxShare: true },
        { code: "290", name: "車両費", group: "費用", keywords: "車検,自動車保険,ガソリン,駐車場,修理,タイヤ", taxRate: 10, taxShare: true },
        { code: "300", name: "福利厚生費", group: "費用", keywords: "福利厚生,健康診断,制服,作業着", taxRate: 10, taxShare: true },
        { code: "310", name: "会議費", group: "費用", keywords: "会議,打ち合わせ,カフェ,ミーティング", taxRate: 10, taxShare: true },
        { code: "320", name: "諸会費", group: "費用", keywords: "年会費,組合費,協会費,商工会,宅建協会費,管理組合費,商工会議所", taxRate: 10, taxShare: true },
        { code: "330", name: "事務用品費", group: "費用", keywords: "文房具,コピー用紙,プリンター,インク,トナー", taxRate: 10, taxShare: true },
        { code: "350", name: "給料賃金", group: "費用", keywords: "給料,賃金,アルバイト,パート,日当", taxRate: 0, taxShare: true },
        { code: "360", name: "専従者給与", group: "費用", keywords: "専従者,青色専従者", taxRate: 0, taxShare: true },
        // --- 3. 資産・負債の部（B/S項目） ---
        { code: "410", name: "建物", group: "資産", keywords: "上物価格,ガレージアパート,減価償却資産,建物取得", taxRate: 0, taxShare: true },
        { code: "420", name: "土地", group: "資産", keywords: "土地代金,非償却資産,敷地,土地取得", taxRate: 0, taxShare: true },
        { code: "430", name: "建設仮勘定", group: "資産", keywords: "建築中,着工金,中間金,建設中", taxRate: 0, taxShare: true },
        { code: "440", name: "長期借入金", group: "負債", keywords: "銀行融資,住宅金融公庫,設備資金,長期借入", taxRate: 0, taxShare: true },
        { code: "450", name: "預り金", group: "負債", keywords: "敷金預り,清掃保証金,源泉徴収税,預り保証金", taxRate: 0, taxShare: true },
      ];
      const batch = db.batch();
      let added = 0, updated = 0, deleted = 0;

      for (const cat of defaults) {
        const existing = await categoriesCol.where("code", "==", cat.code).limit(1).get();
        if (existing.empty) {
          batch.set(categoriesCol.doc(), cat);
          added++;
        } else {
          // 既存科目: name/group/keywordsが異なる場合は更新
          const doc = existing.docs[0];
          const d = doc.data();
          const needsUpdate = d.name !== cat.name || d.group !== cat.group || d.keywords !== cat.keywords;
          if (needsUpdate) {
            batch.update(doc.ref, { name: cat.name, group: cat.group, keywords: cat.keywords });
            updated++;
          }
        }
      }

      // 統合で不要になった旧科目を削除（ただしdefaultsで更新済みのコードは除外）
      const defaultCodes = new Set(defaults.map(d => d.code));
      const obsolete = [
        { name: "交際費" },  // → 接待交際費(190)に統合
        { name: "接待費" },  // → 接待交際費(190)に統合
      ];
      for (const obs of obsolete) {
        const snap = await categoriesCol.where("name", "==", obs.name).get();
        snap.docs.forEach(doc => {
          // defaultsで同じcodeを使って名前更新したドキュメントは削除しない
          if (defaultCodes.has(doc.data().code)) return;
          batch.delete(doc.ref); deleted++;
        });
      }

      await batch.commit();

      // 既存scanLogsの科目名も統合に合わせて更新
      let logsMigrated = 0;
      const renames = { "交際費": "接待交際費", "接待費": "接待交際費" };
      for (const [oldName, newName] of Object.entries(renames)) {
        const logSnap = await logsCol.where("category", "==", oldName).get();
        if (!logSnap.empty) {
          const b2 = db.batch();
          logSnap.docs.forEach(doc => { b2.update(doc.ref, { category: newName }); logsMigrated++; });
          await b2.commit();
        }
      }

      res.json({ success: true, added, updated, deleted, logsMigrated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 学習データ
  // ========================================
  router.get("/learning", async (req, res) => {
    try {
      const snap = await learningCol.orderBy("count", "desc").get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/learning/rebuild", async (req, res) => {
    try {
      // 完了ログから学習データを再構築
      const logSnap = await logsCol.get();
      const vendorMap = {}; // { normalizedVendor: { category: count } }

      for (const doc of logSnap.docs) {
        const d = doc.data();
        if (!d.status || !String(d.status).includes("完了")) continue;
        const v = normalizeVendor_(d.vendor);
        const c = d.category;
        if (!v || !c) continue;
        if (!vendorMap[v]) vendorMap[v] = {};
        vendorMap[v][c] = (vendorMap[v][c] || 0) + 1;
      }

      // 既存の学習データをクリア
      const oldSnap = await learningCol.get();
      const batch = db.batch();
      for (const doc of oldSnap.docs) batch.delete(doc.ref);

      // 最頻出科目で再構築
      for (const [vendor, cats] of Object.entries(vendorMap)) {
        let best = "", bestCount = 0;
        for (const [c, count] of Object.entries(cats)) {
          if (count > bestCount) { best = c; bestCount = count; }
        }
        batch.set(learningCol.doc(), { vendor, category: best, count: bestCount });
      }

      await batch.commit();
      res.json({ success: true, count: Object.keys(vendorMap).length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 1件取り消し（ファイルを元の場所に戻す）
  // ========================================
  router.post("/revert/:logId", async (req, res) => {
    try {
      const { logId } = req.params;
      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      const settings = await getSettings_(db);
      const drive = await getDriveClient_();

      if (!settings.folderInbox) {
        return res.status(400).json({ error: "受信BOXフォルダが設定されていません" });
      }

      // ファイルを元の名前に戻して受信BOXに移動
      const fileId = logData.fileId;
      try {
        const fileMeta = await drive.files.get({ fileId, fields: "id,name,parents", supportsAllDrives: true });
        const previousParents = (fileMeta.data.parents || []).join(",");

        await drive.files.update({
          fileId,
          addParents: settings.folderInbox,
          removeParents: previousParents,
          requestBody: { name: logData.origName || fileMeta.data.name },
          fields: "id,parents",
          supportsAllDrives: true,
        });
      } catch (driveErr) {
        // ファイルが見つからない場合もログは更新する
        console.error("Drive移動エラー:", driveErr.message);
      }

      // ログを「取り消し済み」に更新
      await logsCol.doc(logId).update({
        status: "🔄 取り消し済み（元の場所に復元）",
        revertedAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (e) {
      console.error("取り消しエラー:", e);
      res.status(500).json({ error: "取り消しに失敗しました: " + e.message });
    }
  });

  // ========================================
  // 全取り消し（処理済みファイルをすべて元の場所に戻す）
  // ========================================
  router.post("/revert-all", async (req, res) => {
    try {
      const settings = await getSettings_(db);
      if (!settings.folderInbox) {
        return res.status(400).json({ error: "受信BOXフォルダが設定されていません" });
      }

      const drive = await getDriveClient_();

      // 完了・自動完了・確認待ちのログを全取得
      const snap = await logsCol.get();
      const targets = snap.docs.filter((d) => {
        const s = String(d.data().status || "");
        return s.includes("完了") || s.includes("確認待ち") || s.includes("処理中");
      });

      let reverted = 0, failed = 0;
      for (const doc of targets) {
        const logData = doc.data();
        const fileId = logData.fileId;
        if (!fileId) { failed++; continue; }

        try {
          const fileMeta = await drive.files.get({ fileId, fields: "id,name,parents", supportsAllDrives: true });
          const previousParents = (fileMeta.data.parents || []).join(",");

          await drive.files.update({
            fileId,
            addParents: settings.folderInbox,
            removeParents: previousParents,
            requestBody: { name: logData.origName || fileMeta.data.name },
            fields: "id,parents",
            supportsAllDrives: true,
          });
          reverted++;
        } catch (driveErr) {
          console.error(`Drive移動エラー [${fileId}]:`, driveErr.message);
          failed++;
        }

        // ログを更新
        await doc.ref.update({
          status: "🔄 取り消し済み（元の場所に復元）",
          revertedAt: FieldValue.serverTimestamp(),
        });
      }

      res.json({ success: true, reverted, failed, total: targets.length });
    } catch (e) {
      console.error("全取り消しエラー:", e);
      res.status(500).json({ error: "全取り消しに失敗しました: " + e.message });
    }
  });

  // ========================================
  // ログ全削除（取り消し済みログをFirestoreから削除）
  // ========================================
  router.delete("/logs/all", async (req, res) => {
    try {
      const snap = await logsCol.get();
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      res.json({ success: true, deleted: snap.docs.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // スプレッドシートから直接インポート（旧PDFリネームアプリ等）
  // ========================================
  router.post("/import-spreadsheet", async (req, res) => {
    try {
      const { spreadsheetId } = req.body;
      if (!spreadsheetId) {
        return res.status(400).json({ error: "スプレッドシートIDを指定してください" });
      }

      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      });
      const sheets = google.sheets({ version: "v4", auth });

      // スプレッドシートのメタデータ取得
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetNames = meta.data.sheets.map((s) => s.properties.title);

      const result = {
        spreadsheetName: meta.data.properties.title,
        spreadsheetId,
        sheetsImported: [],
        totalRows: 0,
      };

      // 各シートを読み込んでFirestoreに保存
      for (const sheetName of sheetNames) {
        let values;
        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${sheetName}'`,
          });
          values = response.data.values;
        } catch (e) {
          continue;
        }

        if (!values || values.length < 2) continue;

        const headers = values[0].map((h) => String(h).trim());
        const rows = [];
        for (let i = 1; i < values.length; i++) {
          const row = values[i];
          if (!row || row.every((c) => !c && c !== 0)) continue;
          const obj = {};
          for (let j = 0; j < headers.length; j++) {
            const key = headers[j] || `col_${j + 1}`;
            obj[key] = j < row.length ? row[j] : "";
          }
          rows.push(obj);
        }

        if (rows.length === 0) continue;

        // Firestoreにバッチ書き込み（400件ずつ）
        for (let i = 0; i < rows.length; i += 400) {
          const batch = db.batch();
          const chunk = rows.slice(i, i + 400);
          for (const row of chunk) {
            batch.set(db.collection(sheetName).doc(), row);
          }
          await batch.commit();
        }

        result.sheetsImported.push({ name: sheetName, rows: rows.length, headers });
        result.totalRows += rows.length;
      }

      // 1枚目のシート（リネームルール/前提条件）を設定に保存
      if (result.sheetsImported.length > 0) {
        try {
          const firstSheet = result.sheetsImported[0];
          const rulesSnap = await db.collection(firstSheet.name).get();
          const rulesLines = [];
          for (const doc of rulesSnap.docs) {
            const d = doc.data();
            // 2列構成（ルール名: ルール定義）を結合
            const keys = Object.keys(d);
            if (keys.length >= 2) {
              rulesLines.push(d[keys[0]] + ": " + d[keys[1]]);
            } else if (keys.length === 1) {
              rulesLines.push(String(d[keys[0]]));
            }
          }
          if (rulesLines.length > 0) {
            const rulesText = rulesLines.join("\n");
            await db.collection("settings").doc("scanSorter").set({ renameRules: rulesText }, { merge: true });
            result.rulesImported = rulesLines.length;
          }
        } catch (e) { console.error("ルール保存エラー:", e.message); }
      }

      // インポート直後にデータ変換（フロントエンド側のタイミング問題を回避）
      const converted = { logs: 0, feedback: 0, renameLearning: 0, taxLearning: 0, execHistory: 0 };

      // 参照元比較 → scanLogs
      try {
        const srcSnap = await db.collection("参照元比較").get();
        for (const doc of srcSnap.docs) {
          const d = doc.data();
          const fileId = d["スキャンファイルID"] || "";
          const origName = d["スキャンファイル名"] || "";
          if (!fileId && !origName) continue;
          if (fileId) {
            const dup = await logsCol.where("fileId", "==", fileId).limit(1).get();
            if (!dup.empty) continue;
          }
          await logsCol.add({
            fileId, origName,
            newName: d["リネーム予定名"] || "",
            processDate: FieldValue.serverTimestamp(),
            docTitle: "その他",
            docDetail: "",
            docType: "その他",
            vendor: "",
            amount: 0,
            docDate: d["書類日付"] || "",
            category: "",
            summary: d["内容要約"] || "",
            confidence: 80,
            refFileId: d["参照元ファイルID"] || "",
            refFileName: d["参照元ファイル名"] || "",
            refFolderId: d["参照元フォルダID"] || "",
            destFolderId: d["移動先フォルダ1 ID"] || "",
            destFolderPath: d["移動先フォルダ1"] || "",
            destFolder2Id: d["移動先フォルダ2 ID"] || "",
            destFolder2Path: d["移動先フォルダ2"] || "",
            entityType: d["法人/個人"] || "",
            feedback: d["補足メモ"] || "",
            taxShareFolders: (() => { try { return JSON.parse(d["税理士共有"] || "[]"); } catch(e) { return []; } })(),
            needsReview: false,
            status: d["ステータス"] || "📦 旧アプリから移行",
            migratedFrom: "参照元比較",
          });
          converted.logs++;
        }
      } catch (e) { console.error("参照元比較→scanLogs変換エラー:", e.message); }

      // フィードバック履歴 → scanFeedback
      try {
        const fbSnap = await db.collection("フィードバック履歴").get();
        for (const doc of fbSnap.docs) {
          const d = doc.data();
          const scanName = d["スキャンファイル名"] || "";
          if (!scanName) continue;
          await db.collection("scanFeedback").add({
            scanName,
            summary: d["内容要約"] || "",
            renameTo: d["リネーム予定名"] || "",
            wrongRefName: d["誤った参照元ファイル名"] || "",
            wrongRefFileId: d["誤った参照元ID"] || "",
            feedback: d["補足メモ（正しい情報）"] || d["補足メモ"] || "",
            timestamp: FieldValue.serverTimestamp(),
            migratedFrom: "フィードバック履歴",
          });
          converted.feedback++;
        }
      } catch (e) { console.error("フィードバック履歴変換エラー:", e.message); }

      // リネーム学習 → scanRenameLearning
      try {
        const rlSnap = await db.collection("リネーム学習").get();
        for (const doc of rlSnap.docs) {
          const d = doc.data();
          const scanName = d["スキャンファイル名"] || "";
          if (!scanName) continue;
          await db.collection("scanRenameLearning").add({
            scanName,
            summary: d["内容要約"] || "",
            aiGeneratedName: d["AI生成名"] || "",
            userCorrectedName: d["ユーザー修正名"] || "",
            timestamp: FieldValue.serverTimestamp(),
            migratedFrom: "リネーム学習",
          });
          converted.renameLearning++;
        }
      } catch (e) { console.error("リネーム学習変換エラー:", e.message); }

      // 税理士振分学習 → scanTaxLearning
      try {
        const tlSnap = await db.collection("税理士振分学習").get();
        for (const doc of tlSnap.docs) {
          const d = doc.data();
          await db.collection("scanTaxLearning").add({
            summary: d["内容要約"] || "",
            entityType: d["法人/個人"] || "",
            aiSuggested: d["AI推薦"] || "",
            userSelected: d["ユーザー選択"] || "",
            timestamp: FieldValue.serverTimestamp(),
            migratedFrom: "税理士振分学習",
          });
          converted.taxLearning++;
        }
      } catch (e) { console.error("税理士振分学習変換エラー:", e.message); }

      // 実行履歴 → scanExecutionHistory
      try {
        const ehSnap = await db.collection("実行履歴").get();
        for (const doc of ehSnap.docs) {
          const d = doc.data();
          const fileId = d["ファイルID"] || "";
          if (!fileId) continue;
          await db.collection("scanExecutionHistory").add({
            batchId: d["バッチID"] || "",
            fileId,
            originalName: d["元のファイル名"] || "",
            originalFolderId: d["元のフォルダID"] || "",
            newName: d["新しいファイル名"] || "",
            newFolderId: d["新しいフォルダID"] || "",
            taxCopies: d["税理士コピー先"] || "[]",
            timestamp: FieldValue.serverTimestamp(),
            migratedFrom: "実行履歴",
          });
          converted.execHistory++;
        }
      } catch (e) { console.error("実行履歴変換エラー:", e.message); }

      // 税理士共有履歴からscanLogsのtaxShareFoldersを補完
      // （旧アプリで完了済みだが税理士共有列が空のログを修正）
      try {
        const taxHistSnap = await db.collection("税理士共有履歴").get();
        if (!taxHistSnap.empty) {
          // ファイル名→税理士フォルダ名のマップを構築
          const fileToTaxFolders = {}; // { fileName: Set(["法人用", "個人用"]) }
          for (const doc of taxHistSnap.docs) {
            const d = doc.data();
            const fileName = d["ファイル名"] || "";
            const folderName = d["フォルダ名"] || "";
            if (!fileName || !folderName) continue;
            if (!fileToTaxFolders[fileName]) fileToTaxFolders[fileName] = new Set();
            fileToTaxFolders[fileName].add(folderName);
          }

          // scanLogsでtaxShareFoldersが空の完了行を補完
          const logsSnap = await logsCol.get();
          let taxFixed = 0;
          for (const doc of logsSnap.docs) {
            const logData = doc.data();
            const s = String(logData.status || "");
            if (!s.includes("完了") && !s.includes("旧アプリ")) continue;

            const existing = logData.taxShareFolders || [];
            if (existing.length > 0) continue; // 既にある場合はスキップ

            // newName（リネーム後の名前）またはorigName（元の名前）で照合
            const names = [logData.newName, logData.origName].filter(Boolean);
            let matchedFolders = null;
            for (const name of names) {
              // 完全一致
              if (fileToTaxFolders[name]) { matchedFolders = fileToTaxFolders[name]; break; }
              // .pdf付き/なしの揺れ対応
              const withPdf = name.endsWith(".pdf") ? name : name + ".pdf";
              const withoutPdf = name.endsWith(".pdf") ? name.slice(0, -4) : name;
              if (fileToTaxFolders[withPdf]) { matchedFolders = fileToTaxFolders[withPdf]; break; }
              if (fileToTaxFolders[withoutPdf]) { matchedFolders = fileToTaxFolders[withoutPdf]; break; }
            }

            if (matchedFolders && matchedFolders.size > 0) {
              await doc.ref.update({ taxShareFolders: Array.from(matchedFolders) });
              taxFixed++;
            }
          }
          converted.taxShareFixed = taxFixed;
        }
      } catch (e) { console.error("税理士共有履歴→scanLogs補完エラー:", e.message); }

      // 科目が空のscanLogsに対し、summaryとキーワードで自動振り分け
      try {
        const catSnap = await categoriesCol.get();
        const catKeywords = []; // [{ name, keywords: string[] }]
        for (const doc of catSnap.docs) {
          const c = doc.data();
          if (c.name && c.keywords) {
            const kws = String(c.keywords).split(",").map(k => k.trim()).filter(Boolean);
            if (kws.length > 0) catKeywords.push({ name: c.name, keywords: kws });
          }
        }

        if (catKeywords.length > 0) {
          const logsSnap2 = await logsCol.get();
          let catFixed = 0;
          for (const doc of logsSnap2.docs) {
            const logData = doc.data();
            if (logData.category && logData.category !== "その他" && logData.category !== "雑費") continue;

            // summary + origName + newName を結合して検索対象にする
            const text = [logData.summary, logData.origName, logData.newName, logData.vendor].filter(Boolean).join(" ").toLowerCase();
            if (!text) continue;

            let bestMatch = null;
            let bestScore = 0;
            for (const cat of catKeywords) {
              let score = 0;
              for (const kw of cat.keywords) {
                if (text.includes(kw.toLowerCase())) score++;
              }
              if (score > bestScore) { bestScore = score; bestMatch = cat.name; }
            }

            if (bestMatch && bestScore > 0) {
              await doc.ref.update({ category: bestMatch });
              catFixed++;
            }
          }
          converted.categoryAutoAssigned = catFixed;
        }
      } catch (e) { console.error("科目自動振り分けエラー:", e.message); }

      result.converted = converted;
      res.json(result);
    } catch (e) {
      console.error("スプレッドシートインポートエラー:", e);
      if (e.code === 403 || e.code === 404) {
        res.status(400).json({
          error: "スプレッドシートにアクセスできません。サービスアカウントにスプレッドシートの閲覧権限を共有してください。",
          details: e.message,
        });
      } else {
        res.status(500).json({ error: "インポートに失敗しました: " + e.message });
      }
    }
  });

  // ========================================
  // 統計
  // ========================================
  router.get("/stats", async (req, res) => {
    try {
      const allSnap = await logsCol.get();
      let total = 0, approved = 0, pending = 0, errors = 0, reverted = 0;
      for (const doc of allSnap.docs) {
        total++;
        const s = String(doc.data().status || "");
        if (s.includes("取り消し")) reverted++;
        else if (s.includes("完了")) approved++;
        else if (s.includes("確認待ち")) pending++;
        else if (s.includes("エラー")) errors++;
      }
      res.json({ version: "v0402f", total, approved, pending, errors, reverted, completed: total - pending - errors - reverted });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 参照元ファイル検索（Geminiで類似PDFを検索）
  // ========================================
  router.post("/search-reference/:logId", async (req, res) => {
    try {
      const { logId } = req.params;
      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      const settings = await getSettings_(db);
      if (!settings.geminiApiKey) return res.status(400).json({ error: "Gemini APIキーが設定されていません" });

      const drive = await getDriveClient_();

      // Geminiで検索キーワードを抽出
      const keywords = await extractSearchKeywords_(logData.summary, logData.vendor, settings.geminiApiKey);

      // Google Driveで類似PDFを検索（受信BOXフォルダを除外）
      const candidates = await searchDriveForSimilar_(drive, keywords, settings.folderInbox);

      if (candidates.length === 0) {
        return res.json({ found: false, message: "類似ファイルが見つかりませんでした" });
      }

      // Geminiでベストマッチを選択
      const bestMatch = await selectBestMatch_(candidates, logData.summary, logData.vendor, settings.geminiApiKey);

      if (!bestMatch) {
        return res.json({ found: false, message: "適切な参照ファイルが見つかりませんでした", candidates: candidates.slice(0, 5) });
      }

      // scanLogを更新
      const updateData = {
        refFileId: bestMatch.id,
        refFileName: bestMatch.name,
        refFolderId: bestMatch.folderId || "",
        destFolderId: bestMatch.folderId || "",
      };
      await logsCol.doc(logId).update(updateData);

      res.json({ found: true, ...updateData, candidates: candidates.slice(0, 5) });
    } catch (e) {
      console.error("参照ファイル検索エラー:", e);
      res.status(500).json({ error: "参照ファイル検索に失敗しました: " + e.message });
    }
  });

  // ========================================
  // フォルダブラウザ（Driveフォルダ一覧）
  // ========================================
  router.get("/browse-folder", async (req, res) => {
    try {
      const folderId = req.query.folderId || "root";
      const drive = await getDriveClient_();

      // 特殊フォルダ: 共有アイテム
      if (folderId === "shared") {
        const sharedRes = await drive.files.list({
          q: "sharedWithMe=true and mimeType='application/vnd.google-apps.folder' and trashed=false",
          fields: "files(id,name)",
          orderBy: "name",
          pageSize: 50,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        return res.json({
          folderName: "共有アイテム",
          parentId: null,
          folders: (sharedRes.data.files || []).map(f => ({ id: f.id, name: f.name })),
          files: [],
        });
      }

      // 特殊フォルダ: 共有ドライブ一覧
      if (folderId === "team" || folderId === "sharedDrives") {
        try {
          const drivesRes = await drive.drives.list({ pageSize: 50 });
          return res.json({
            folderName: "共有ドライブ",
            parentId: null,
            folders: (drivesRes.data.drives || []).map(d => ({ id: d.id, name: d.name })),
            files: [],
          });
        } catch (e) {
          return res.json({ folderName: "共有ドライブ", parentId: null, folders: [], files: [], error: e.message });
        }
      }

      // 通常フォルダ
      let folderName = "マイドライブ";
      let parentId = null;
      if (folderId !== "root") {
        try {
          const meta = await drive.files.get({ fileId: folderId, fields: "name,parents", supportsAllDrives: true });
          folderName = meta.data.name;
          parentId = (meta.data.parents || [])[0] || null;
        } catch (e) {
          // デバッグ: サービスアカウント情報付きで返す
          const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive"] });
          const client = await auth.getClient();
          const saEmail = client.email || "(不明)";
          return res.status(404).json({
            error: "フォルダが見つかりません",
            debug: {
              folderId,
              serviceAccount: saEmail,
              driveError: e.message,
              hint: `サービスアカウント「${saEmail}」に対象フォルダの共有（編集者）が必要です。フォルダのオーナーアカウントから直接共有してください。`,
            },
          });
        }
      }

      // サブフォルダ一覧
      const foldersRes = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id,name)",
        orderBy: "name",
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      // PDF一覧
      const filesRes = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
        fields: "files(id,name)",
        orderBy: "name",
        pageSize: 50,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      // フルパスを取得
      let folderPath = folderName;
      if (folderId && folderId !== "root") {
        try { folderPath = await getFolderPath_(drive, folderId); } catch (e) {}
      }

      res.json({
        folderName,
        folderPath,
        parentId,
        folders: (foldersRes.data.files || []).map((f) => ({ id: f.id, name: f.name })),
        files: (filesRes.data.files || []).map((f) => ({ id: f.id, name: f.name })),
      });
    } catch (e) {
      console.error("フォルダブラウズエラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // ファイル検索（Drive内PDF検索）
  // ========================================
  router.get("/search-files", async (req, res) => {
    try {
      const q = req.query.q;
      if (!q) return res.status(400).json({ error: "検索クエリを指定してください" });

      const drive = await getDriveClient_();
      const searchRes = await drive.files.list({
        q: `name contains '${q.replace(/'/g, "\\'")}' and mimeType='application/pdf' and trashed=false`,
        fields: "files(id,name,parents)",
        orderBy: "modifiedTime desc",
        pageSize: 15,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = [];
      for (const f of searchRes.data.files || []) {
        let folderName = "";
        const folderId = (f.parents || [])[0] || "";
        if (folderId) {
          try {
            const folderMeta = await drive.files.get({ fileId: folderId, fields: "name", supportsAllDrives: true });
            folderName = folderMeta.data.name;
          } catch (_) { /* ignore */ }
        }
        files.push({ fileId: f.id, fileName: f.name, folderId, folderName });
      }

      res.json(files);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // フォルダ検索（Drive内フォルダ検索）
  // ========================================
  router.get("/search-folders", async (req, res) => {
    try {
      const q = req.query.q;
      if (!q) return res.status(400).json({ error: "検索クエリを指定してください" });

      const drive = await getDriveClient_();
      const searchRes = await drive.files.list({
        q: `name contains '${q.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id,name)",
        orderBy: "modifiedTime desc",
        pageSize: 8,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const folders = [];
      for (const f of searchRes.data.files || []) {
        const folderPath = await getFolderPath_(drive, f.id);
        folders.push({ folderId: f.id, folderPath });
      }

      res.json(folders);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 実行済みファイルの保管状態チェック
  // ========================================
  router.get("/logs/:logId/verify", async (req, res) => {
    try {
      const { logId } = req.params;
      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      const drive = await getDriveClient_();
      const expectedName = (logData.newName || "").endsWith(".pdf") ? logData.newName : (logData.newName || "") + ".pdf";
      const results = { mainFile: null, dest1: null, dest2: null, taxFolders: {} };

      // 1. メインファイル（fileId）の存在チェック
      if (logData.fileId) {
        try {
          const meta = await drive.files.get({ fileId: logData.fileId, fields: "id,name,parents,trashed", supportsAllDrives: true });
          results.mainFile = {
            exists: true,
            trashed: meta.data.trashed || false,
            currentName: meta.data.name,
            nameMatch: meta.data.name === expectedName,
            parentId: (meta.data.parents || [])[0] || "",
          };
        } catch (e) {
          results.mainFile = { exists: false, error: e.message };
        }
      }

      // 2. 移動先1フォルダ内にファイルがあるか
      if (logData.destFolderId) {
        try {
          const searchRes = await drive.files.list({
            q: `'${logData.destFolderId}' in parents and name='${expectedName}' and trashed=false`,
            fields: "files(id,name)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true,
          });
          results.dest1 = {
            folderId: logData.destFolderId,
            folderPath: logData.destFolderPath || "",
            found: (searchRes.data.files || []).length > 0,
          };
        } catch (e) {
          results.dest1 = { folderId: logData.destFolderId, found: false, error: e.message };
        }
      }

      // 3. 移動先2フォルダ内にファイルがあるか
      if (logData.destFolder2Id) {
        try {
          const searchRes = await drive.files.list({
            q: `'${logData.destFolder2Id}' in parents and name='${expectedName}' and trashed=false`,
            fields: "files(id,name)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true,
          });
          results.dest2 = {
            folderId: logData.destFolder2Id,
            folderPath: logData.destFolder2Path || "",
            found: (searchRes.data.files || []).length > 0,
          };
        } catch (e) {
          results.dest2 = { folderId: logData.destFolder2Id, found: false, error: e.message };
        }
      }

      // 4. 税理士共有フォルダ内にファイルがあるか
      const taxCopyResults = logData.taxCopyResults || {};
      for (const [folderName, copyInfo] of Object.entries(taxCopyResults)) {
        if (!copyInfo.subFolderId) continue;
        try {
          const searchRes = await drive.files.list({
            q: `'${copyInfo.subFolderId}' in parents and name='${expectedName}' and trashed=false`,
            fields: "files(id,name)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true,
          });
          results.taxFolders[folderName] = {
            subFolderId: copyInfo.subFolderId,
            found: (searchRes.data.files || []).length > 0,
          };
        } catch (e) {
          results.taxFolders[folderName] = { subFolderId: copyInfo.subFolderId, found: false, error: e.message };
        }
      }

      // 5. 不在のファイルをDrive全体から検索（名前検索）
      const hasAnyMissing = (!results.mainFile?.exists) ||
        (results.dest1 && !results.dest1.found) ||
        (results.dest2 && !results.dest2.found) ||
        Object.values(results.taxFolders || {}).some(t => !t.found);

      let foundElsewhere = [];
      if (hasAnyMissing && expectedName) {
        try {
          // ファイル名で全Drive検索
          const searchName = expectedName.replace(/'/g, "\\'");
          const globalSearch = await drive.files.list({
            q: `name='${searchName}' and trashed=false`,
            fields: "files(id,name,parents)",
            pageSize: 10,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          if (globalSearch.data.files && globalSearch.data.files.length > 0) {
            for (const f of globalSearch.data.files) {
              let parentPath = "";
              try { parentPath = await getFolderPath_(drive, (f.parents || [])[0]); } catch (e) {}
              foundElsewhere.push({
                fileId: f.id,
                name: f.name,
                parentId: (f.parents || [])[0] || "",
                parentPath,
              });
            }
          }
          // ゴミ箱内も検索
          const trashSearch = await drive.files.list({
            q: `name='${searchName}' and trashed=true`,
            fields: "files(id,name,parents)",
            pageSize: 5,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          if (trashSearch.data.files && trashSearch.data.files.length > 0) {
            for (const f of trashSearch.data.files) {
              foundElsewhere.push({
                fileId: f.id,
                name: f.name,
                parentId: "",
                parentPath: "ゴミ箱",
                trashed: true,
              });
            }
          }
        } catch (e) {}
      }

      res.json({ logId, expectedName, results, foundElsewhere });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // Driveファイル名変更（実行済みファイルのリネーム）
  // ========================================
  router.patch("/logs/:logId/rename-drive", async (req, res) => {
    try {
      const { logId } = req.params;
      const { newName } = req.body;
      if (!newName) return res.status(400).json({ error: "新しいファイル名を指定してください" });

      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      if (!logData.fileId) return res.status(400).json({ error: "ファイルIDがありません" });

      const drive = await getDriveClient_();
      // メインファイルをリネーム
      await drive.files.update({
        fileId: logData.fileId,
        requestBody: { name: newName },
        supportsAllDrives: true,
      });

      // 税理士コピー先もリネーム
      let taxRenamed = 0;
      const taxCopyResults = logData.taxCopyResults || {};
      const oldName = logData.newName || "";
      for (const [folderName, copyInfo] of Object.entries(taxCopyResults)) {
        if (!copyInfo.subFolderId) continue;
        try {
          const oldFileName = oldName.endsWith(".pdf") ? oldName : oldName + ".pdf";
          const searchRes = await drive.files.list({
            q: `'${copyInfo.subFolderId}' in parents and name='${oldFileName}' and trashed=false`,
            fields: "files(id)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true,
          });
          if (searchRes.data.files && searchRes.data.files.length > 0) {
            await drive.files.update({ fileId: searchRes.data.files[0].id, requestBody: { name: newName }, supportsAllDrives: true });
            taxRenamed++;
          }
        } catch (e) {}
      }

      await logsCol.doc(logId).update({ newName });
      res.json({ success: true, newName, taxRenamed });
    } catch (e) {
      console.error("Driveリネームエラー:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 移動先フォルダ更新
  // ========================================
  router.patch("/logs/:logId/dest-folder", async (req, res) => {
    try {
      const { logId } = req.params;
      const { folderId, slot, folderPath: clientFolderPath } = req.body;
      if (!folderId) return res.status(400).json({ error: "フォルダIDを指定してください" });

      // フロントエンドからフルパスが来ていればそれを使う、なければバックエンドで取得
      let folderPath = clientFolderPath || "";
      if (!folderPath || !folderPath.includes("/")) {
        const drive = await getDriveClient_();
        try { folderPath = await getFolderPath_(drive, folderId); } catch(e) {
          try { const m = await drive.files.get({ fileId: folderId, fields: "name", supportsAllDrives: true }); folderPath = m.data.name; } catch(e2) {}
        }
      }

      if (slot === 2) {
        await logsCol.doc(logId).update({ destFolder2Id: folderId, destFolder2Path: folderPath });
      } else {
        await logsCol.doc(logId).update({ destFolderId: folderId, destFolderPath: folderPath });
      }

      // フィードバック保存
      const logDoc = await logsCol.doc(logId).get();
      if (logDoc.exists) {
        await feedbackCol.add({
          logId,
          type: "destFolder",
          scanName: logDoc.data().origName || "",
          summary: logDoc.data().summary || "",
          selectedFolderId: folderId,
          selectedFolderName: folderPath,
          slot: slot || 1,
          timestamp: FieldValue.serverTimestamp(),
        });
      }

      res.json({ success: true, folderName: folderPath });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 参照ファイル更新
  // ========================================
  router.patch("/logs/:logId/reference", async (req, res) => {
    try {
      const { logId } = req.params;
      const { refFileId, clear } = req.body;

      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });
      const logData = logDoc.data();

      if (clear) {
        // 古い参照をフィードバックに保存
        if (logData.refFileId) {
          await feedbackCol.add({
            logId,
            type: "reference-clear",
            scanName: logData.origName || "",
            summary: logData.summary || "",
            wrongRefFileId: logData.refFileId,
            wrongRefFileName: logData.refFileName || "",
            timestamp: FieldValue.serverTimestamp(),
          });
        }
        await logsCol.doc(logId).update({ refFileId: "", refFileName: "", refFolderId: "", status: "新規" });
        return res.json({ success: true, status: "新規" });
      }

      if (!refFileId) return res.status(400).json({ error: "refFileIdまたはclear:trueを指定してください" });

      const drive = await getDriveClient_();
      const fileMeta = await drive.files.get({ fileId: refFileId, fields: "name,parents", supportsAllDrives: true });
      const refFileName = fileMeta.data.name;
      const refFolderId = (fileMeta.data.parents || [])[0] || "";

      // 古い参照をフィードバックに保存
      if (logData.refFileId && logData.refFileId !== refFileId) {
        await feedbackCol.add({
          logId,
          type: "reference-change",
          scanName: logData.origName || "",
          summary: logData.summary || "",
          oldRefFileId: logData.refFileId,
          oldRefFileName: logData.refFileName || "",
          newRefFileId: refFileId,
          newRefFileName: refFileName,
          timestamp: FieldValue.serverTimestamp(),
        });
      }

      // destFolderIdは未設定の場合のみ参照元フォルダで補完（既存の移動先を上書きしない）
      const updateFields = { refFileId, refFileName, refFolderId };
      if (!logData.destFolderId) {
        updateFields.destFolderId = refFolderId;
      }
      await logsCol.doc(logId).update(updateFields);
      res.json({ success: true, refFileName, refFolderId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 学習フィードバック（3タイプ: reference, rename, taxFolder）
  // ========================================
  router.post("/feedback", async (req, res) => {
    try {
      const { logId, type } = req.body;
      if (!logId || !type) return res.status(400).json({ error: "logIdとtypeが必要です" });

      const logDoc = await logsCol.doc(logId).get();
      const logData = logDoc.exists ? logDoc.data() : {};

      if (type === "reference") {
        const { wrongRefName, wrongRefFileId, feedback } = req.body;
        await feedbackCol.add({
          scanName: logData.origName || "",
          summary: logData.summary || "",
          renameTo: logData.newName || "",
          wrongRefName: wrongRefName || "",
          wrongRefFileId: wrongRefFileId || "",
          feedback: feedback || "",
          timestamp: FieldValue.serverTimestamp(),
        });
      } else if (type === "rename") {
        const { aiGeneratedName, userCorrectedName } = req.body;
        await renameLearningCol.add({
          scanName: logData.origName || "",
          summary: logData.summary || "",
          aiGeneratedName: aiGeneratedName || logData.newName || "",
          userCorrectedName: userCorrectedName || "",
          timestamp: FieldValue.serverTimestamp(),
        });
        // scanLogのnewNameも更新
        if (userCorrectedName) {
          await logsCol.doc(logId).update({ newName: userCorrectedName });
        }
      } else if (type === "taxFolder") {
        const { aiSuggested, userSelected } = req.body;
        await taxLearningCol.add({
          summary: logData.summary || "",
          entityType: logData.entityType || "不明",
          aiSuggested: aiSuggested || "",
          userSelected: userSelected || "",
          timestamp: FieldValue.serverTimestamp(),
        });
      } else {
        return res.status(400).json({ error: "typeは reference, rename, taxFolder のいずれかです" });
      }

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // フィードバック一覧取得
  router.get("/feedback", async (req, res) => {
    try {
      const snap = await feedbackCol.orderBy("timestamp", "desc").get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // リネーム学習一覧取得
  router.get("/rename-learning", async (req, res) => {
    try {
      const snap = await renameLearningCol.orderBy("timestamp", "desc").get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // バッチundo一覧
  // ========================================
  router.get("/undo-batches", async (req, res) => {
    try {
      const snap = await execHistoryCol.orderBy("executedAt", "desc").get();
      const batchMap = {};
      for (const doc of snap.docs) {
        const d = doc.data();
        if (!d.batchId) continue;
        if (!batchMap[d.batchId]) {
          batchMap[d.batchId] = { batchId: d.batchId, fileCount: 0, executedAt: d.executedAt, files: [] };
        }
        batchMap[d.batchId].fileCount++;
        if (batchMap[d.batchId].files.length < 5) {
          batchMap[d.batchId].files.push({ originalName: d.originalName, newName: d.newName, action: d.action });
        }
      }

      // 最新5バッチを返す
      const batches = Object.values(batchMap).slice(0, 5);
      res.json(batches);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // バッチundo実行
  // ========================================
  router.post("/undo/:batchId", async (req, res) => {
    try {
      const { batchId } = req.params;
      const snap = await execHistoryCol.where("batchId", "==", batchId).get();
      if (snap.empty) return res.status(404).json({ error: "バッチが見つかりません" });

      const drive = await getDriveClient_();
      let reverted = 0, failed = 0;

      for (const doc of snap.docs) {
        const d = doc.data();
        try {
          if (d.action === "move") {
            // 元のフォルダに移動し、元の名前に戻す
            const fileMeta = await drive.files.get({ fileId: d.fileId, fields: "parents", supportsAllDrives: true });
            const currentParents = (fileMeta.data.parents || []).join(",");
            if (d.originalFolderId) {
              await drive.files.update({
                fileId: d.fileId,
                addParents: d.originalFolderId,
                removeParents: currentParents,
                requestBody: { name: d.originalName },
                fields: "id,parents",
                supportsAllDrives: true,
              });
            } else {
              await drive.files.update({
                fileId: d.fileId,
                requestBody: { name: d.originalName },
                supportsAllDrives: true,
              });
            }
            reverted++;
          } else if (d.action === "copy-dest2" || d.action === "copy-tax") {
            // コピーは単に無視（削除するのは危険なので手動対応）
            reverted++;
          }

          // scanLogのステータスを更新
          if (d.logId) {
            await logsCol.doc(d.logId).update({ status: "↩ 元に戻し済み" });
          }

          // 履歴エントリを削除
          await doc.ref.delete();
        } catch (err) {
          console.error(`バッチundo失敗 [${d.fileId}]:`, err.message);
          failed++;
        }
      }

      res.json({ success: true, reverted, failed });
    } catch (e) {
      console.error("バッチundoエラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 失敗エントリ削除
  // ========================================
  router.post("/clear-failed", async (req, res) => {
    try {
      const snap = await logsCol.get();
      const batch = db.batch();
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const status = String(d.status || "");
        const summary = String(d.summary || "");
        if (status.includes("エラー") || summary.includes("解析失敗")) {
          batch.delete(doc.ref);
          count++;
        }
      }
      await batch.commit();
      res.json({ success: true, deleted: count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // チェック済みエントリ再キュー
  // ========================================
  router.post("/requeue-checked", async (req, res) => {
    try {
      const snap = await logsCol.where("checked", "==", true).get();
      const batch = db.batch();
      let count = 0;
      for (const doc of snap.docs) {
        const status = String(doc.data().status || "");
        if (!status.includes("完了")) {
          batch.delete(doc.ref);
          count++;
        }
      }
      await batch.commit();
      res.json({ success: true, deleted: count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 税理士共有フォルダ選択更新
  // ========================================
  router.patch("/logs/:logId/tax-share", async (req, res) => {
    try {
      const { logId } = req.params;
      const { selectedFolders, removedFolder, addFolder } = req.body;
      if (!Array.isArray(selectedFolders)) return res.status(400).json({ error: "selectedFoldersは配列で指定してください" });

      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });
      const logData = logDoc.data();

      // チェックを外したフォルダのコピーファイルを削除
      let deleted = false;
      if (removedFolder && logData.taxCopyResults) {
        const copyInfo = logData.taxCopyResults[removedFolder];
        if (copyInfo && copyInfo.subFolderId && logData.newName) {
          try {
            const drive = await getDriveClient_();
            const fileName = logData.newName.endsWith(".pdf") ? logData.newName : logData.newName + ".pdf";
            // 税理士年月フォルダ内で同名ファイルを検索して削除
            const searchRes = await drive.files.list({
              q: `'${copyInfo.subFolderId}' in parents and name='${fileName}' and trashed=false`,
              fields: "files(id,name)",
              pageSize: 1,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            });
            if (searchRes.data.files && searchRes.data.files.length > 0) {
              await drive.files.delete({ fileId: searchRes.data.files[0].id, supportsAllDrives: true });
              deleted = true;
            }
          } catch (delErr) {
            console.error(`税理士フォルダ[${removedFolder}]のファイル削除エラー:`, delErr.message);
          }
        }

        // taxCopyResultsからも削除
        const newTaxCopyResults = { ...logData.taxCopyResults };
        delete newTaxCopyResults[removedFolder];
        await logsCol.doc(logId).update({ taxShareFolders: selectedFolders, taxCopyResults: newTaxCopyResults });
      } else {
        await logsCol.doc(logId).update({ taxShareFolders: selectedFolders });
      }

      // 新たにチェックされたフォルダ: サブフォルダを作成してIDを返す（コピーはフロントエンドで実行）
      let copied = false;
      let destTaxFolderId = null;
      if (addFolder && logData.fileId) {
        try {
          const drive = await getDriveClient_();
          // entities（名義マスタ）からフォルダIDを取得
          let taxParentFolderId = "";
          const entityDoc = await db.collection("entities").doc(addFolder).get();
          if (entityDoc.exists && entityDoc.data().taxFolderId) {
            taxParentFolderId = entityDoc.data().taxFolderId;
          } else {
            // 後方互換: 旧taxFoldersから検索
            const oldTaxSnap = await db.collection("settings").doc("scanSorter").collection("taxFolders").get();
            for (const doc of oldTaxSnap.docs) {
              const d = doc.data();
              if (doc.id === addFolder || d.name === addFolder) { taxParentFolderId = d.folderId; break; }
            }
          }

          if (taxParentFolderId) {
            // 年月サブフォルダを作成（コピーはフロントエンドで実行）
            const dateTaxFolder = await getOrCreateTaxFolder_(drive, taxParentFolderId, logData.docDate);
            destTaxFolderId = dateTaxFolder.id;

            if (!req.body.skipCopy) {
              // skipCopyでない場合（approve内からの呼び出し等）はサーバー側でコピー
              const cleanName = (logData.newName || logData.origName || "file").replace(/[\\/:*?"<>|]/g, "").trim() + (logData.newName && logData.newName.toLowerCase().endsWith(".pdf") ? "" : ".pdf");
              await copyFileWithOwnerTransfer_(drive, logData.fileId, cleanName, dateTaxFolder.id);
              copied = true;
            }

            // taxCopyResultsを更新
            const newTaxCopyResults = { ...(logData.taxCopyResults || {}) };
            newTaxCopyResults[addFolder] = { parentFolderId: taxParentFolderId, subFolderId: dateTaxFolder.id };
            await logsCol.doc(logId).update({ taxCopyResults: newTaxCopyResults });
          }
        } catch (copyErr) {
          console.error(`税理士フォルダ[${addFolder}]エラー:`, copyErr.message);
        }
      }

      res.json({ success: true, deleted, copied, destTaxFolderId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // ========================================
  // 誤移動ファイルの修正（processedフォルダから正しい移動先に再移動）
  // ========================================
  // ========================================
  // 移動先パスを一括更新（IDだけのデータにフォルダ階層パスを追加）
  // ========================================
  router.post("/fix-folder-paths", async (req, res) => {
    try {
      const drive = await getDriveClient_();
      const snap = await logsCol.get();
      let fixed = 0, skipped = 0, errors = 0;

      for (const doc of snap.docs) {
        const d = doc.data();

        // destFolderIdがあるのにdestFolderPathがない or IDと同じ
        if (d.destFolderId && (!d.destFolderPath || d.destFolderPath === d.destFolderId)) {
          try {
            const path = await getFolderPath_(drive, d.destFolderId);
            await doc.ref.update({ destFolderPath: path });
            fixed++;
          } catch (e) {
            errors++;
          }
        } else {
          skipped++;
        }

        // destFolder2も同様
        if (d.destFolder2Id && (!d.destFolder2Path || d.destFolder2Path === d.destFolder2Id)) {
          try {
            const path = await getFolderPath_(drive, d.destFolder2Id);
            await doc.ref.update({ destFolder2Path: path });
            fixed++;
          } catch (e) {
            errors++;
          }
        }
      }

      res.json({ fixed, skipped, errors });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // サービスアカウント所有フォルダの権限修正
  // yamasuke81@gmail.com と nishiyamake61server@gmail.com に編集権限を付与
  // ========================================
  router.post("/fix-folder-permissions", async (req, res) => {
    try {
      const drive = await getDriveClient_();
      const snap = await logsCol.get();
      const processedFolderIds = new Set();

      // destFolderIdを全収集
      for (const doc of snap.docs) {
        const d = doc.data();
        if (d.destFolderId) processedFolderIds.add(d.destFolderId);
        if (d.destFolder2Id) processedFolderIds.add(d.destFolder2Id);
      }

      let fixed = 0, skipped = 0, errors = [];
      const emails = ["yamasuke81@gmail.com", "nishiyamake61server@gmail.com"];

      for (const folderId of processedFolderIds) {
        try {
          // フォルダの既存権限を確認
          const permRes = await drive.permissions.list({
            fileId: folderId,
            fields: "permissions(emailAddress,role)",
            supportsAllDrives: true,
          });
          const existingEmails = (permRes.data.permissions || []).map(p => p.emailAddress);

          for (const email of emails) {
            if (existingEmails.includes(email)) continue;
            try {
              await drive.permissions.create({
                fileId: folderId,
                requestBody: { type: "user", role: "writer", emailAddress: email },
                supportsAllDrives: true,
                sendNotificationEmail: false,
              });
              fixed++;
            } catch (permErr) {
              // 既に権限がある場合など
            }
          }
          skipped++;
        } catch (e) {
          errors.push(`${folderId}: ${e.message.substring(0, 50)}`);
        }
      }

      res.json({ folders: processedFolderIds.size, fixed, errors: errors.length, errorDetails: errors.slice(0, 10) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 処理済みフォルダの全ファイルを正しい場所に移動
  // destFolderIdあり→そこに移動、なし→受信BOXに戻す
  // ========================================
  router.post("/fix-misplaced", async (req, res) => {
    try {
      const settings = await getSettings_(db);
      const drive = await getDriveClient_();
      const processedFolderId = settings.folderProcessed;
      const inboxFolderId = settings.folderInbox;

      if (!processedFolderId) return res.status(400).json({ error: "処理済みフォルダが未設定です" });
      if (!inboxFolderId) return res.status(400).json({ error: "受信BOXフォルダが未設定です" });

      // 1. 処理済みフォルダ配下の全PDFを再帰的に取得
      const allFiles = await listAllPdfsRecursive_(drive, processedFolderId);
      console.log(`処理済みフォルダ内のPDF: ${allFiles.length}件`);

      // 2. scanLogsからfileId→destFolderIdのマップを構築
      const snap = await logsCol.get();
      const fileToDestMap = {}; // { fileId: destFolderId }
      for (const doc of snap.docs) {
        const d = doc.data();
        if (d.fileId && d.destFolderId) {
          fileToDestMap[d.fileId] = d.destFolderId;
        }
      }

      // 3. 各ファイルを移動
      let movedToDest = 0, movedToInbox = 0, errors = [];
      for (const file of allFiles) {
        const targetFolder = fileToDestMap[file.id] || inboxFolderId;
        const label = fileToDestMap[file.id] ? "移動先1" : "受信BOX";

        try {
          const fileMeta = await drive.files.get({ fileId: file.id, fields: "parents", supportsAllDrives: true });
          const currentParents = (fileMeta.data.parents || []).join(",");

          await drive.files.update({
            fileId: file.id,
            addParents: targetFolder,
            removeParents: currentParents,
            fields: "id,parents",
            supportsAllDrives: true,
          });

          if (fileToDestMap[file.id]) movedToDest++;
          else movedToInbox++;
        } catch (e) {
          errors.push(`${file.name}: ${e.message}`);
        }
      }

      res.json({
        totalFiles: allFiles.length,
        movedToDest,
        movedToInbox,
        errors: errors.length,
        errorDetails: errors.slice(0, 20),
      });
    } catch (e) {
      console.error("処理済みフォルダ修正エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 重複チェック
  // ========================================
  router.get("/duplicates", async (req, res) => {
    try {
      const snap = await logsCol.get();
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // 重複候補を検出: 金額+取引先+書類日付 or リネーム後ファイル名が類似
      const groups = {};
      for (const doc of docs) {
        // キー1: 金額+取引先+日付（完全一致）
        const vendor = String(doc.vendor || "").trim();
        const amount = Number(doc.amount) || 0;
        const docDate = String(doc.docDate || "").replace(/-/g, "");
        if (vendor && amount > 0 && docDate) {
          const key = `${docDate}_${vendor}_${amount}`;
          if (!groups[key]) groups[key] = [];
          groups[key].push(doc);
        }

        // キー2: 元ファイル名の先頭20文字（スキャン時のファイル名が似ている場合）
        const origName = String(doc.origName || "").substring(0, 20).trim();
        if (origName.length >= 8) {
          const nameKey = `name_${origName}`;
          if (!groups[nameKey]) groups[nameKey] = [];
          groups[nameKey].push(doc);
        }
      }

      // 2件以上のグループ = 重複候補
      const duplicates = [];
      for (const [key, items] of Object.entries(groups)) {
        if (items.length < 2) continue;
        // 同じドキュメントの重複を排除
        const uniqueIds = new Set(items.map(i => i.id));
        if (uniqueIds.size < 2) continue;

        duplicates.push({
          key,
          reason: key.startsWith("name_") ? "ファイル名類似" : "金額+取引先+日付一致",
          items: items.map(i => ({
            id: i.id,
            origName: i.origName || "",
            newName: i.newName || "",
            vendor: i.vendor || "",
            amount: Number(i.amount) || 0,
            docDate: i.docDate || "",
            category: i.category || "",
            summary: (i.summary || "").substring(0, 80),
            status: i.status || "",
            fileId: i.fileId || "",
          })),
        });
      }

      res.json({ total: duplicates.length, duplicates });
    } catch (e) {
      console.error("重複チェックエラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // 再リネーム（Driveファイルの実名を変更）
  // ========================================
  router.post("/rename/:logId", async (req, res) => {
    try {
      const { logId } = req.params;
      const { newName } = req.body;
      if (!newName) return res.status(400).json({ error: "新しいファイル名を指定してください" });

      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      if (!logData.fileId) return res.status(400).json({ error: "ファイルIDがありません" });

      const drive = await getDriveClient_();
      const cleanName = newName.replace(/[\\/:*?"<>|]/g, "").trim() + (newName.toLowerCase().endsWith(".pdf") ? "" : ".pdf");

      await drive.files.update({
        fileId: logData.fileId,
        requestBody: { name: cleanName },
        supportsAllDrives: true,
      });

      await logsCol.doc(logId).update({ newName: cleanName });

      res.json({ success: true, newName: cleanName });
    } catch (e) {
      console.error("再リネームエラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // AI再リネーム提案（Geminiで最新ルールに基づく名前を生成）
  // ========================================
  router.post("/ai-rename/:logId", async (req, res) => {
    try {
      const { logId } = req.params;
      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      const settings = await getSettings_(db);
      if (!settings.geminiApiKey) return res.status(400).json({ error: "Gemini APIキーが未設定です" });

      // 学習データを取得
      const feedbackHistory = await getRecentFeedback_(db.collection("scanFeedback"));
      const renameHistory = await getRecentRenameLearning_(db.collection("scanRenameLearning"));
      const renameRules = settings.renameRules || "";

      // Geminiに再リネームを依頼（PDFは再読み込みせず、既存の要約+メタデータから生成）
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${settings.geminiApiKey}`;

      const promptParts = [
        "以下の書類情報から、最適なファイル名を1つだけ生成してください。",
        "形式: YYMMDD_物件名_書類タイトル(詳細)_金額_取引先_科目（詳細が空なら括弧なし）",
        "書類タイトルはOCRで確認できる正式なタイトルをそのまま使用。詳細は汎用的な書類（領収書等）の内容を簡潔に補足。例: 領収書(麦茶), ﾚｼｰﾄ(消耗品), 水道使用水量等のお知らせ",
        "ファイル名のみ出力し、拡張子.pdfは不要です。",
        "",
        "【重要ルール】",
        "- 「恭介共通」「八朔共通」など「共通」を含む物件名は絶対に使わないこと",
        "- 特定の物件に紐づかない書類は、物件名の部分を省略し YYMMDD_書類種別_金額_取引先_科目 とすること",
        "- 金額が0の場合は金額も省略すること",
        "",
      ];

      if (renameRules) {
        promptParts.push("## リネームルール（必ず従ってください）:");
        promptParts.push(renameRules);
        promptParts.push("");
      }

      // 物件マスタ情報を注入
      try {
        const propSnap = await db.collection("properties").orderBy("displayOrder").get();
        if (!propSnap.empty) {
          promptParts.push("## 物件マスタ（ファイル名の物件名は以下から選んでください。表記揺れがあっても最も近いものを選んでください）:");
          for (const doc of propSnap.docs) {
            const p = doc.data();
            let info = `- ${p.name}`;
            if (p.address) info += `（${p.address}）`;
            if (p.relatedVendors && p.relatedVendors.length > 0) info += ` 関連取引先: ${p.relatedVendors.slice(0, 5).join(",")}`;
            promptParts.push(info);
          }
          promptParts.push("- 特定の物件に紐づかない場合は物件名を省略すること");
          promptParts.push("");
        }
      } catch (e) {}

      // 科目マスタ一覧を注入
      try {
        const catSnap = await db.collection("scanCategories").orderBy("code").get();
        if (!catSnap.empty) {
          const grouped = {};
          for (const doc of catSnap.docs) {
            const d = doc.data();
            const g = d.group || "費用";
            if (!grouped[g]) grouped[g] = [];
            grouped[g].push(d.name);
          }
          promptParts.push("## 科目マスタ（categoryは以下から選んでください）:");
          for (const g of ["収益", "費用", "資産", "負債"]) {
            if (grouped[g]) promptParts.push(`【${g}】${grouped[g].join(" / ")}`);
          }
          promptParts.push("");
        }
      } catch (e) {}

      // 名義マスタを注入
      try {
        const entitySnap = await db.collection("entities").orderBy("displayOrder").get();
        if (!entitySnap.empty) {
          promptParts.push("## 名義マスタ（書類の宛先から判定）:");
          for (const doc of entitySnap.docs) {
            const e = doc.data();
            promptParts.push(`- ${e.name}（${e.type}、正式: ${e.fullName || e.name}）`);
          }
          promptParts.push("");
        }
      } catch (e) {}

      promptParts.push("## 書類情報:");
      promptParts.push(`- 内容要約: ${logData.summary || "不明"}`);
      // 現在のファイル名から「共通」を含む物件名部分を除去してGeminiに送る
      let currentName = logData.newName || logData.origName || "不明";
      currentName = currentName.replace(/_(恭介共通|八朔共通|[^_]*共通)/g, "");
      promptParts.push(`- 現在のファイル名: ${currentName}`);
      promptParts.push(`- 元のファイル名: ${logData.origName || "不明"}`);
      // 後方互換: docTitle/docDetail対応（旧docTypeからのフォールバック）
      const aiDocTitle = logData.docTitle || logData.docType || "不明";
      const aiDocDetail = logData.docDetail || "";
      promptParts.push(`- 書類タイトル: ${aiDocTitle}`);
      if (aiDocDetail) promptParts.push(`- 書類詳細: ${aiDocDetail}`);
      promptParts.push(`- 取引先: ${logData.vendor || "不明"}`);
      promptParts.push(`- 金額: ${logData.amount || 0}`);
      promptParts.push(`- 書類日付: ${logData.docDate || "不明"}`);
      promptParts.push(`- 科目: ${logData.category || "不明"}`);
      promptParts.push(`- 物件名: ${logData.propertyName || "未選択"}`);
      promptParts.push(`- 法人/個人: ${logData.entityType || "不明"}`);

      // 科目学習データ（取引先→科目マッピング）を注入
      try {
        const vendor = String(logData.vendor || "").replace(/[\s\u3000]+/g, "").replace(/株式会社|有限会社|合同会社/g, "");
        if (vendor) {
          const learnSnap = await db.collection("scanLearning").where("vendor", "==", vendor).limit(1).get();
          if (!learnSnap.empty) {
            const learned = learnSnap.docs[0].data();
            promptParts.push(`- 学習済み科目: ${vendor}→${learned.category}（${learned.count}回）`);
          }
        }
      } catch (e) {}

      // 同じ取引先の過去の完了済みリネーム実績を注入 — 全件取得
      try {
        if (logData.vendor) {
          const pastSnap = await logsCol
            .where("vendor", "==", logData.vendor)
            .where("status", ">=", "✅")
            .orderBy("status")
            .orderBy("approvedAt", "desc")
            .get();
          const pastNames = pastSnap.docs.map(d => d.data().newName).filter(n => n && !n.includes("共通"));
          if (pastNames.length > 0) {
            promptParts.push("");
            promptParts.push("## 同じ取引先の過去の実績（新しい順。最新のパターンを優先）:");
            for (const n of pastNames) promptParts.push(`- ${n}`);
          }
        }
      } catch (e) {}

      if (feedbackHistory && feedbackHistory.length > 0) {
        promptParts.push("");
        promptParts.push("## 過去のフィードバック（新しい順。最新を優先）:");
        for (const fb of feedbackHistory) {
          if (fb.feedback) promptParts.push(`- ${fb.feedback}`);
        }
      }

      if (renameHistory && renameHistory.length > 0) {
        promptParts.push("");
        promptParts.push("## 過去のリネーム修正例（新しい順。最新を優先）:");
        for (const rl of renameHistory) {
          if (rl.aiGeneratedName && rl.userCorrectedName) {
            promptParts.push(`- AI「${rl.aiGeneratedName}」→ 正「${rl.userCorrectedName}」`);
          }
        }
      }

      const payload = {
        contents: [{ parts: [{ text: promptParts.join("\n") }] }],
        generationConfig: { temperature: 0.1 },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("Gemini API error: " + response.status);
      const result = await response.json();
      let suggestedName = "";
      if (result.candidates && result.candidates[0]?.content) {
        suggestedName = result.candidates[0].content.parts[0].text.trim();
        // マークダウン装飾を除去
        suggestedName = suggestedName.replace(/^[`*#\s]+|[`*#\s]+$/g, "").replace(/\.pdf$/i, "");
      }

      if (!suggestedName) throw new Error("AIからの提案名が空です");

      res.json({ suggestedName, currentName: logData.newName || logData.origName || "" });
    } catch (e) {
      console.error("AI再リネームエラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // AI再リネーム実行（提案を承認→全コピー先をリネーム）
  router.post("/ai-rename/:logId/apply", async (req, res) => {
    try {
      const { logId } = req.params;
      const { newName } = req.body;
      if (!newName) return res.status(400).json({ error: "新しいファイル名を指定してください" });

      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();
      const drive = await getDriveClient_();
      const cleanName = newName.replace(/[\\/:*?"<>|]/g, "").trim() + (newName.toLowerCase().endsWith(".pdf") ? "" : ".pdf");

      let renamed = 0;

      // 1. メインファイル（移動先1のファイル）をリネーム
      if (logData.fileId) {
        try {
          await drive.files.update({ fileId: logData.fileId, requestBody: { name: cleanName }, supportsAllDrives: true });
          renamed++;
        } catch (e) { console.error("メインファイルリネームエラー:", e.message); }
      }

      // 2. 税理士フォルダのコピー分もリネーム（ファイル名で検索）
      const taxCopyResults = logData.taxCopyResults || {};
      const oldName = logData.newName || "";
      for (const [folderName, copyInfo] of Object.entries(taxCopyResults)) {
        if (!copyInfo.subFolderId) continue;
        try {
          // サブフォルダ内で旧名前のファイルを検索
          const searchRes = await drive.files.list({
            q: `'${copyInfo.subFolderId}' in parents and name='${oldName.endsWith(".pdf") ? oldName : oldName + ".pdf"}' and trashed=false`,
            fields: "files(id,name)",
            pageSize: 1,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          if (searchRes.data.files && searchRes.data.files.length > 0) {
            await drive.files.update({ fileId: searchRes.data.files[0].id, requestBody: { name: cleanName }, supportsAllDrives: true });
            renamed++;
          }
        } catch (e) { console.error(`税理士フォルダ[${folderName}]リネームエラー:`, e.message); }
      }

      // scanLogを更新
      const oldNameForLearning = logData.newName || "";
      await logsCol.doc(logId).update({ newName: cleanName });

      // リネーム学習データに記録
      if (oldNameForLearning && oldNameForLearning !== cleanName) {
        await db.collection("scanRenameLearning").add({
          scanName: logData.origName || "",
          summary: logData.summary || "",
          aiGeneratedName: oldNameForLearning,
          userCorrectedName: cleanName,
          timestamp: FieldValue.serverTimestamp(),
          source: "ai-rename-apply",
        });
      }

      res.json({ success: true, newName: cleanName, renamed });
    } catch (e) {
      console.error("AI再リネーム実行エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // 重複ログの削除（指定IDのscanLogを削除 + Driveのファイルも任意で削除）
  router.delete("/duplicates/:logId", async (req, res) => {
    try {
      const { logId } = req.params;
      const deleteDriveFile = req.query.deleteDrive === "true";

      const logDoc = await logsCol.doc(logId).get();
      if (!logDoc.exists) return res.status(404).json({ error: "ログが見つかりません" });

      const logData = logDoc.data();

      // Driveファイルも削除する場合
      let driveDeleted = false;
      let driveError = "";
      if (deleteDriveFile && logData.fileId) {
        const drive = await getDriveClient_();
        try {
          // まず直接削除を試みる
          await drive.files.delete({ fileId: logData.fileId, supportsAllDrives: true });
          driveDeleted = true;
        } catch (delErr) {
          // 削除失敗→ゴミ箱に移動を試みる
          try {
            await drive.files.update({ fileId: logData.fileId, requestBody: { trashed: true }, supportsAllDrives: true });
            driveDeleted = true;
          } catch (trashErr) {
            driveError = `削除失敗: ${delErr.message} / ゴミ箱移動も失敗: ${trashErr.message}`;
            console.error("Driveファイル削除エラー:", driveError);
          }
        }
      }

      await logsCol.doc(logId).delete();
      res.json({ success: true, deletedDriveFile: driveDeleted, driveError });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

// ========================================
// 内部ヘルパー関数
// ========================================

async function getSettings_(db) {
  const doc = await db.collection("settings").doc("scanSorter").get();
  return doc.exists ? doc.data() : {};
}

/**
 * Google Drive APIクライアント取得
 * Cloud FunctionsではADC（Application Default Credentials）を使用
 */
async function getDriveClient_() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

/**
 * Gemini APIでPDF解析
 */
async function analyzeWithGemini_(pdfBase64, apiKey, feedbackHistory, renameHistory, renameRules) {
  if (!apiKey) throw new Error("Gemini APIキーが設定されていません");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const promptParts = [
    "あなたは不動産賃貸業および民泊運営の経理担当AIです。",
    "以下のPDFを分析して、JSON形式で出力してください。",
    "",
    "## ファイル命名規則（電子帳簿保存法準拠）",
    "YYMMDD_物件名_書類種別_金額_取引先名_勘定科目.pdf",
    "",
    "## 出力形式（JSONのみ、説明不要）:",
    "{",
    '  "docTitle": "書類のタイトル（OCRで確認できる正式なタイトルをそのまま使用。例: 領収書, 請求書, 水道使用水量等のお知らせ, 火災保険契約内容のお知らせ, 固定資産税・都市計画税 納税通知書）。買い物レシートは半角カタカナ「ﾚｼｰﾄ」",',
    '  "docDetail": "書類タイトルが汎用的な場合（領収書、請求書等）にその内容を簡潔に記載。例: 麦茶, 駐車場白線, 設備修繕。書類タイトルが具体的（水道使用水量等のお知らせ等）なら空文字",',
    '  "vendor": "取引先名（法人格・敬称は削除。株式会社→削除、○○事務所→○○、ひろしま農業協同組合→JAひろしま）",',
    '  "amount": 税込金額（整数、カンマなし、不明なら0）,',
    '  "docDate": "YYYYMMDD形式の日付（書類上の取引日）",',
    '  "propertyName": "物件名の短縮形（テラス長浜、福山市駅家等）。特定の物件に紐づかない書類は空文字にすること",',
    '  "category": "勘定科目（下記から選択。仕訳不要なら空文字）\\n【収益】売上高（宿泊料）/賃貸料収入/不動産売却高/受取利息/雑収入\\n【費用】消耗品費/水道光熱費/通信費/地代家賃/損害保険料/租税公課/修繕費/旅費交通費/接待交際費/外注費/減価償却費/支払利息/広告宣伝費/支払手数料/管理費/リネン費/新聞図書費/車両費/福利厚生費/会議費/諸会費/事務用品費/給料賃金/専従者給与/雑費\\n【資産・負債】建物/土地/建設仮勘定/長期借入金/預り金",',
    '  "summary": "内容の1行要約",',
    '  "confidence": 0〜100の信頼度（情報が明確なら高く、曖昧なら低く）,',
  ];

  // entityType と taxFolders を名義マスタ（entities）から動的生成
  try {
    const entitySnap = await db.collection("entities").orderBy("displayOrder").get();
    if (!entitySnap.empty) {
      const entityNames = entitySnap.docs.map(d => d.data().name).filter(Boolean);
      const entityExamples = entitySnap.docs.map(d => {
        const e = d.data();
        return `${e.fullName || e.name}宛て=${e.name}`;
      }).join("、");

      promptParts.push(`  "entityType": "${entityNames.join("|")}|不明（書類の宛先から最も該当する名義を選択。${entityExamples}）",`);
      promptParts.push(`  "taxFolders": [${entityNames.map(n => `"${n}"`).join(", ")}]のように、この書類を共有すべき名義名の配列`);
    } else {
      promptParts.push('  "entityType": "法人|個人|不明（書類の宛先が法人か個人か）",');
      promptParts.push('  "taxFolders": ["法人", "個人"]のように、この書類を共有すべき名義名の配列');
    }
  } catch (e) {
    promptParts.push('  "entityType": "法人|個人|不明",');
    promptParts.push('  "taxFolders": []');
  }

  promptParts.push(
    "}",
    ""
  );

  // 物件マスタを動的に注入（ハードコード廃止）
  try {
    const propSnap = await db.collection("properties").orderBy("displayOrder").get();
    if (!propSnap.empty) {
      promptParts.push("## 物件名マスタ（propertyNameは以下から選んでください）:");
      for (const doc of propSnap.docs) {
        const p = doc.data();
        let info = `- ${p.name}`;
        if (p.address) info += `（${p.address}）`;
        if (p.relatedVendors && p.relatedVendors.length > 0) info += ` 関連取引先: ${p.relatedVendors.slice(0, 5).join(",")}`;
        promptParts.push(info);
      }
      promptParts.push("- 特定の物件に紐づかない書類はpropertyNameを空文字にすること");
      promptParts.push("");
    }
  } catch (e) {}

  // リネームルール（前提条件）があればプロンプトに注入
  if (renameRules) {
    promptParts.push("");
    promptParts.push("## リネームルール（以下のルールに従ってファイル名を生成してください）:");
    promptParts.push(renameRules);
  }

  promptParts.push(
    "",
    "## 注意事項:",
    "- 日付が不明な場合は今日の日付を使用",
    "- 金額はカンマなしの税込整数。金額が無い書類（契約書等）は 0",
    "- confidence: 文字がはっきり読める=80以上、一部不鮮明=50〜79、ほぼ読めない=50未満",
    "- entityType: 名義マスタの名前（上記参照）を使用。不明なら不明",
    "- taxFolders: entityTypeと同じ名義名を配列で指定。複数名義に関係するなら複数、不明なら空配列",
    "- vendor: 「株式会社」「有限会社」「合同会社」「御中」等の法人格・敬称は全て削除。「○○司法書士事務所」→「○○」。人名は含めない。不明な場合は空文字",
    "- docTitle: 買い物のレシートは必ず半角カタカナ「ﾚｼｰﾄ」とすること",
    "- docDetail: 書類タイトルが具体的で内容が明確な場合（水道使用水量等のお知らせ、火災保険契約内容のお知らせ等）は空文字にすること",
    "- propertyName: 物件マスタに登録されている物件名のみ使用可。該当しない場合は空文字。「恭介共通」「八朔共通」等は使用禁止",
    "- category: 不明な場合は空文字（「不明」という文字列は使用禁止）",
    "- 金額が0の場合は省略可（ファイル名に含めなくてよい）",
    "- 「不明」という文字列はどのフィールドにも使用しないこと。不明な場合は空文字にすること"
  );

  // フィードバック履歴があればプロンプトに追加（学習用）
  if (feedbackHistory && feedbackHistory.length > 0) {
    promptParts.push("");
    promptParts.push("## 過去のフィードバック（新しい順。古いルールより新しいルールを優先すること）:");
    for (const fb of feedbackHistory) {
      if (fb.scanName && fb.feedback) {
        promptParts.push(`- ファイル「${fb.scanName}」: ${fb.feedback}`);
      }
    }
  }

  // リネーム学習データがあればプロンプトに追加
  if (renameHistory && renameHistory.length > 0) {
    promptParts.push("");
    promptParts.push("## 過去のリネーム修正例（新しい順。古いパターンより新しいパターンを優先すること）:");
    for (const rl of renameHistory) {
      if (rl.aiGeneratedName && rl.userCorrectedName) {
        promptParts.push(`- AI提案「${rl.aiGeneratedName}」→ ユーザー修正「${rl.userCorrectedName}」`);
      }
    }
  }

  // 過去の完了済みリネーム実績をプロンプトに追加（パターン学習用）— 全件取得
  try {
    const pastSnap = await db.collection("scanLogs")
      .where("status", ">=", "✅")
      .orderBy("status")
      .orderBy("approvedAt", "desc")
      .get();
    const pastNames = pastSnap.docs.map(d => {
      const data = d.data();
      // 「共通」を含むリネーム名は除外（Geminiが誤学習するため）
      if (data.newName && data.newName.includes("共通")) return null;
      return data.newName ? `${data.newName}${data.vendor ? ` (取引先:${data.vendor})` : ""}` : null;
    }).filter(Boolean);
    if (pastNames.length > 0) {
      promptParts.push("");
      promptParts.push("## 過去の完了済みリネーム実績（新しい順。最新のパターンを優先してください）:");
      for (const n of pastNames) promptParts.push(`- ${n}`);
    }
  } catch (e) {}

  const prompt = promptParts.join("\n");

  const payload = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
    ] }],
    generationConfig: { temperature: 0.1 },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("Gemini API error: " + response.status + " " + errText);
  }

  const result = await response.json();
  if (result.candidates && result.candidates[0]?.content) {
    const text = result.candidates[0].content.parts[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const today = new Date().toISOString().replace(/-/g, "").substring(0, 8);
      // docTitle/docDetail対応（後方互換: 旧docTypeからの変換も行う）
      let docTitle = parsed.docTitle || "";
      let docDetail = parsed.docDetail || "";
      if (!docTitle && parsed.docType) {
        // 旧形式「書類種別(内容)」→ docTitle + docDetail に分割
        const m = String(parsed.docType).match(/^([^(（]+)[(（]([^)）]*)[)）]$/);
        if (m) { docTitle = m[1]; docDetail = m[2]; }
        else { docTitle = parsed.docType; }
      }
      if (!docTitle) docTitle = "その他";
      // 後方互換用docType生成
      const docType = docDetail ? `${docTitle}(${docDetail})` : docTitle;
      return {
        docTitle,
        docDetail,
        docType,
        vendor: parsed.vendor || "不明",
        amount: Number(parsed.amount) || 0,
        docDate: parsed.docDate || today,
        propertyName: parsed.propertyName || "",
        category: parsed.category || "雑費",
        summary: parsed.summary || "",
        confidence: Number(parsed.confidence) || 50,
        entityType: parsed.entityType || "不明",
        taxFolders: Array.isArray(parsed.taxFolders) ? parsed.taxFolders : [],
      };
    }
  }

  return { docTitle: "その他", docDetail: "", docType: "その他", vendor: "不明", amount: 0, docDate: "", category: "雑費", summary: "（解析失敗）", confidence: 0, entityType: "不明", taxFolders: [] };
}

/**
 * ファイル移動実行: リネーム → フォルダ移動 → 税理士共有コピー
 */
/**
 * 指定フォルダにファイルを移動（リネーム付き）
 * 移動先1が指定されている場合に使用
 */
/**
 * ファイルコピー + オーナー移譲
 * サービスアカウントはストレージクォータがないため、
 * コピー後にコピー先フォルダのオーナーにファイル所有権を移譲する
 */
/**
 * ファイルコピー（ダウンロード→アップロード方式）
 * files.copyはサービスアカウントのストレージクォータエラーになるため、
 * PDFバイナリをダウンロードして新規ファイルとしてアップロードする。
 * アップロード先フォルダのオーナーがファイル所有者になるためクォータ問題なし。
 */
async function copyFileWithOwnerTransfer_(drive, sourceFileId, newName, destFolderId) {
  // 1. 元ファイルのバイナリをダウンロード
  const downloadRes = await drive.files.get(
    { fileId: sourceFileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );

  // streamをBufferに変換
  const chunks = [];
  await new Promise((resolve, reject) => {
    downloadRes.data.on("data", (chunk) => chunks.push(chunk));
    downloadRes.data.on("end", resolve);
    downloadRes.data.on("error", reject);
  });
  const fileBuffer = Buffer.concat(chunks);

  // 2. 元ファイルのmimeTypeを取得
  const metaRes = await drive.files.get({ fileId: sourceFileId, fields: "mimeType", supportsAllDrives: true });
  const mimeType = metaRes.data.mimeType || "application/pdf";

  // 3. 新規ファイルとしてアップロード（宛先フォルダのオーナーがファイル所有者になる）
  const { Readable } = require("stream");
  const uploadRes = await drive.files.create({
    requestBody: {
      name: newName,
      parents: [destFolderId],
    },
    media: {
      mimeType,
      body: Readable.from(fileBuffer),
    },
    supportsAllDrives: true,
    fields: "id",
  });

  return uploadRes.data.id;
}

async function moveFileToFolder_(drive, fileId, newName, destFolderId) {
  const cleanName = newName.replace(/[\\/:*?"<>|]/g, "").trim() + (newName.toLowerCase().endsWith(".pdf") ? "" : ".pdf");

  const fileMeta = await drive.files.get({ fileId, fields: "parents,name,ownedByMe", supportsAllDrives: true });
  const previousParents = (fileMeta.data.parents || []).join(",");

  try {
    // 通常の移動（addParents + removeParents）を試みる
    await drive.files.update({
      fileId,
      addParents: destFolderId,
      removeParents: previousParents,
      requestBody: { name: cleanName },
      fields: "id,parents",
      supportsAllDrives: true,
    });
  } catch (moveErr) {
    // removeParentsが権限不足で失敗した場合: addParentsのみ + リネームを別途実行
    console.warn(`移動(removeParents)失敗、コピー方式にフォールバック: ${moveErr.message}`);
    try {
      // 移動先にコピー + リネーム
      const copied = await drive.files.copy({
        fileId,
        requestBody: { name: cleanName, parents: [destFolderId] },
        supportsAllDrives: true,
      });
      // 元ファイルをゴミ箱に移動（削除は権限があれば）
      try {
        await drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
      } catch (trashErr) {
        console.warn(`元ファイルのゴミ箱移動失敗（手動で削除が必要）: ${trashErr.message}`);
      }
      // コピーしたファイルのIDを返す（以降このIDを使う）
      const folderName = await getFolderPath_(drive, destFolderId).catch(() => destFolderId);
      return { folderName, folderId: destFolderId, newFileId: copied.data.id };
    } catch (copyErr) {
      throw new Error(`ファイル移動に失敗しました: ${moveErr.message} / コピーも失敗: ${copyErr.message}`);
    }
  }

  // フォルダパスを取得
  let folderName = destFolderId;
  try {
    folderName = await getFolderPath_(drive, destFolderId);
  } catch (e) {}

  return { folderName, folderId: destFolderId };
}

async function executeFileMove_(drive, fileId, newName, analysis, taxShare, settings) {
  const cleanName = newName.replace(/[\\/:*?"<>|]/g, "").trim() + (newName.toLowerCase().endsWith(".pdf") ? "" : ".pdf");

  // 年月フォルダを取得 or 作成
  const destDocType = analysis.docTitle || analysis.docType || "その他";
  const destFolder = await getOrCreateDestFolder_(drive, settings.folderProcessed, destDocType, analysis.docDate);

  // リネーム + フォルダ移動
  // まず現在の親フォルダを取得
  const fileMeta = await drive.files.get({ fileId, fields: "parents", supportsAllDrives: true });
  const previousParents = (fileMeta.data.parents || []).join(",");

  await drive.files.update({
    fileId,
    addParents: destFolder.id,
    removeParents: previousParents,
    requestBody: { name: cleanName },
    fields: "id,parents",
    supportsAllDrives: true,
  });

  // 税理士共有フォルダにショートカット作成
  if (taxShare && settings.folderTaxShare) {
    try {
      const taxFolder = await getOrCreateTaxFolder_(drive, settings.folderTaxShare, analysis.docDate);
      await copyFileWithOwnerTransfer_(drive, fileId, cleanName, taxFolder.id);
    } catch (copyErr) {
      console.error("税理士共有エラー（ファイル移動自体は成功）:", copyErr.message);
    }
  }

  return { folderName: destFolder.name, folderId: destFolder.id };
}

/**
 * 処理済み/{年}/{月}/{書類種別}/ を取得 or 作成
 */
async function getOrCreateDestFolder_(drive, processedFolderId, docType, docDate) {
  if (!processedFolderId) throw new Error("処理済みフォルダが設定されていません");
  const date = parseDocDate_(docDate);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");

  const yearFolder = await getOrCreateSubfolder_(drive, processedFolderId, year);
  const monthFolder = await getOrCreateSubfolder_(drive, yearFolder.id, month);
  const typeFolder = await getOrCreateSubfolder_(drive, monthFolder.id, docType || "その他");
  return typeFolder;
}

/**
 * 税理士共有/{年}/{月}/ を取得 or 作成
 */
async function getOrCreateTaxFolder_(drive, taxShareFolderId, docDate) {
  const date = parseDocDate_(docDate);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");

  // 旧アプリ準拠: 「2026.03」形式の1フォルダ（年/月で分けない）
  const folderName = `${year}.${month}`;
  return getOrCreateSubfolder_(drive, taxShareFolderId, folderName);
}

/**
 * 処理済みフォルダ配下の全PDFを再帰的に取得
 */
async function listAllPdfsRecursive_(drive, folderId, depth = 0) {
  if (depth > 5) return []; // 無限再帰防止
  const results = [];

  // PDFファイル取得
  const pdfRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  for (const f of (pdfRes.data.files || [])) {
    results.push({ id: f.id, name: f.name });
  }

  // サブフォルダも再帰的に探索
  const folderRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  for (const f of (folderRes.data.files || [])) {
    const subFiles = await listAllPdfsRecursive_(drive, f.id, depth + 1);
    results.push(...subFiles);
  }

  return results;
}

async function getOrCreateSubfolder_(drive, parentId, name) {
  // 既存フォルダを検索
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0];
  }
  // 作成
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    supportsAllDrives: true,
    fields: "id,name",
  });

  // 親フォルダのオーナーを取得して、作成したフォルダのオーナーを移譲
  try {
    const parentMeta = await drive.files.get({ fileId: parentId, fields: "owners", supportsAllDrives: true });
    const parentOwner = (parentMeta.data.owners || [])[0];
    if (parentOwner && parentOwner.emailAddress) {
      await drive.permissions.create({
        fileId: created.data.id,
        transferOwnership: true,
        requestBody: { type: "user", role: "owner", emailAddress: parentOwner.emailAddress },
        supportsAllDrives: true,
      });
    }
  } catch (ownerErr) {
    // オーナー移譲に失敗しても、フォルダ自体は使える
    console.error("フォルダオーナー移譲エラー（無視可）:", ownerErr.message);
  }

  return created.data;
}

/**
 * 確定版命名規則: YYMMDD_物件名_書類種別_金額_取引先名_勘定科目.pdf
 * 電子帳簿保存法準拠・スプレッドシート索引簿自動転記対応
 */
function buildFileName_(analysis) {
  // 1. YYMMDD（西暦下2桁）
  const dateStr = String(analysis.docDate || "").replace(/[-/]/g, "");
  let yymmdd;
  if (dateStr.length === 8) {
    yymmdd = dateStr.substring(2); // YYYYMMDD → YYMMDD
  } else if (dateStr.length === 6) {
    yymmdd = dateStr; // 既にYYMMDD
  } else {
    const now = new Date();
    const y = String(now.getFullYear()).substring(2);
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    yymmdd = y + m + d;
  }

  // 2. 物件名（「共通」を含む場合はスキップ — 物件との関連性が低いため）
  let propertyName = analysis.propertyName || "";
  if (propertyName.includes("共通")) propertyName = "";
  // 物件名2がある場合は「+」で結合
  if (analysis.propertyName2 && analysis.propertyName2 !== analysis.propertyName) {
    const p2 = analysis.propertyName2.includes("共通") ? "" : analysis.propertyName2;
    if (propertyName && p2) propertyName = propertyName + "+" + p2;
    else if (p2) propertyName = p2;
  }

  // 3. 書類タイトル+詳細（後方互換: docTitle/docDetail → docType フォールバック）
  let docTitle = analysis.docTitle || analysis.docType || "その他";
  let docDetail = analysis.docDetail || "";
  // 後方互換: 旧docType形式「書類種別(内容)」からの分割
  if (!analysis.docTitle && analysis.docType) {
    const m = String(analysis.docType).match(/^([^(（]+)[(（]([^)）]*)[)）]$/);
    if (m) { docTitle = m[1]; docDetail = m[2]; }
  }
  // レシートは半角カタカナ ﾚｼｰﾄ
  if (/レシート|ﾚｼｰﾄ/.test(docTitle)) docTitle = "ﾚｼｰﾄ";
  // 詳細がある場合: 書類タイトル(詳細)、ない場合: 書類タイトルのみ
  const docTypePart = docDetail ? `${docTitle}(${docDetail})` : docTitle;

  // 4. 金額（税込整数、カンマなし。0は省略）
  const rawAmount = Math.round(Number(analysis.amount) || 0);
  const amount = rawAmount > 0 ? String(rawAmount) : "";

  // 5. 取引先名（正規化済み。「不明」は省略）
  let vendor = normalizeVendor_(analysis.vendor);
  if (vendor === "不明") vendor = "";

  // 6. 勘定科目（あれば。「不明」「雑費」は省略）
  let category = analysis.category || "";
  if (category === "不明") category = "";

  // 組み立て: YYMMDD_物件名_書類タイトル(詳細)_金額_取引先名_勘定科目
  const parts = [yymmdd, propertyName, docTypePart, amount, vendor];
  if (category && category !== "雑費") parts.push(category);
  return parts.filter(Boolean).join("_");
}

/**
 * 取引先名の正規化（確定版ルール厳守）
 * - 法人格・敬称を削除
 * - 事務所名を短縮
 * - JA置換
 * - 空白除去
 */
function normalizeVendor_(vendor) {
  if (!vendor) return "不明";
  let v = String(vendor);
  // 法人格・敬称削除
  v = v.replace(/株式会社|有限会社|合同会社|一般社団法人|一般財団法人|合資会社|合名会社|御中|様|殿/g, "");
  // 事務所名短縮
  v = v.replace(/司法書士事務所|行政書士事務所|税理士事務所|法律事務所|会計事務所|事務所/g, "");
  // JA置換
  v = v.replace(/ひろしま農業協同組合/g, "JAひろしま");
  // 括弧内削除
  v = v.replace(/[（(][^)）]*[)）]/g, "");
  // 全角・半角スペース除去
  v = v.replace(/[\s\u3000]+/g, "");
  return v || "不明";
}

function parseDocDate_(dateStr) {
  if (!dateStr) return new Date();
  const str = String(dateStr).replace(/[-/]/g, "");
  if (str.length === 8) {
    return new Date(Number(str.substring(0, 4)), Number(str.substring(4, 6)) - 1, Number(str.substring(6, 8)));
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

async function getLearned_(learningCol, vendor) {
  const normalized = normalizeVendor_(vendor);
  if (!normalized) return null;
  const snap = await learningCol.where("vendor", "==", normalized).limit(1).get();
  return snap.empty ? null : snap.docs[0].data().category;
}

async function saveLearning_(learningCol, vendor, category) {
  if (!vendor || vendor === "不明" || !category) return;
  const normalized = normalizeVendor_(vendor);
  const snap = await learningCol.where("vendor", "==", normalized).limit(1).get();
  if (snap.empty) {
    await learningCol.add({ vendor: normalized, category, count: 1 });
  } else {
    const doc = snap.docs[0];
    await doc.ref.update({ category, count: (doc.data().count || 0) + 1 });
  }
}

/**
 * 最近のフィードバック履歴を取得（Geminiプロンプト注入用）
 */
async function getRecentFeedback_(feedbackCol) {
  try {
    const snap = await feedbackCol.orderBy("timestamp", "desc").get();
    return snap.docs.map((d) => d.data());
  } catch (_) {
    return [];
  }
}

/**
 * 最近のリネーム学習データを取得（Geminiプロンプト注入用）
 */
async function getRecentRenameLearning_(renameLearningCol) {
  try {
    const snap = await renameLearningCol.orderBy("timestamp", "desc").get();
    return snap.docs.map((d) => d.data());
  } catch (_) {
    return [];
  }
}

/**
 * Geminiで検索キーワードを抽出
 */
async function extractSearchKeywords_(summary, vendor, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = [
    "以下の書類情報から、Google Driveで類似ファイルを検索するためのキーワードを3つ以内で生成してください。",
    "JSONの配列のみで出力（説明不要）。例: [\"キーワード1\", \"キーワード2\"]",
    "",
    `取引先: ${vendor || "不明"}`,
    `内容: ${summary || "不明"}`,
  ].join("\n");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    });
    if (!response.ok) return [vendor || ""].filter(Boolean);
    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]).filter(Boolean);
  } catch (_) { /* fall through */ }
  return [vendor || ""].filter(Boolean);
}

/**
 * Google Driveで類似PDFを検索
 */
async function searchDriveForSimilar_(drive, keywords, excludeFolderId) {
  const candidates = [];
  for (const kw of keywords) {
    if (!kw) continue;
    try {
      const q = `name contains '${kw.replace(/'/g, "\\'")}' and mimeType='application/pdf' and trashed=false`;
      const res = await drive.files.list({
        q,
        fields: "files(id,name,parents,modifiedTime)",
        orderBy: "modifiedTime desc",
        pageSize: 10,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        const folderId = (f.parents || [])[0] || "";
        if (folderId === excludeFolderId) continue;
        if (!candidates.find((c) => c.id === f.id)) {
          candidates.push({ id: f.id, name: f.name, folderId, modifiedTime: f.modifiedTime });
        }
      }
    } catch (_) { /* ignore search errors */ }
  }
  return candidates.slice(0, 20);
}

/**
 * Geminiでベストマッチの参照ファイルを選択
 */
async function selectBestMatch_(candidates, summary, vendor, apiKey) {
  if (candidates.length === 0) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const fileList = candidates.map((c, i) => `${i}: ${c.name}`).join("\n");
  const prompt = [
    "以下のスキャン書類に最も類似したファイルを候補から選んでください。",
    "番号のみ出力してください。該当なしなら -1 を出力。",
    "",
    `取引先: ${vendor || "不明"}`,
    `内容: ${summary || "不明"}`,
    "",
    "候補ファイル:",
    fileList,
  ].join("\n");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    });
    if (!response.ok) return candidates[0] || null;
    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "-1";
    const idx = parseInt(text.match(/-?\d+/)?.[0] || "-1", 10);
    if (idx >= 0 && idx < candidates.length) return candidates[idx];
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * フォルダパスを構築（親を最大5レベルまで辿る）
 */
async function getFolderPath_(drive, folderId) {
  const parts = [];
  let currentId = folderId;
  for (let i = 0; i < 5; i++) {
    try {
      const meta = await drive.files.get({ fileId: currentId, fields: "name,parents", supportsAllDrives: true });
      parts.unshift(meta.data.name);
      const parents = meta.data.parents || [];
      if (parents.length === 0) break;
      currentId = parents[0];
    } catch (_) {
      break;
    }
  }
  return parts.join(" / ");
}
