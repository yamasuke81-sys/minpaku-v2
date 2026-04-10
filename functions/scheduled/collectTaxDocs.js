/**
 * 税理士資料自動収集（定期実行）
 *
 * collectTaxDocs: 毎月3日 9:00 JST — Gmail APIで送金メール自動収集
 * processMfInbox: 毎週月曜 9:00 JST — MF受信BOXフォルダの新規ファイルを自動整理
 */
const { google } = require("googleapis");
const { notifyOwner } = require("../utils/lineNotify");

// ========================================
// メイン: Gmail送金メール自動収集（月次）
// ========================================
async function collectTaxDocs(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  // 設定チェック
  const gmailSettings = await db.collection("settings").doc("gmail").get();
  if (!gmailSettings.exists || !gmailSettings.data().enabled) {
    console.log("Gmail監視が無効です");
    return;
  }
  const userEmail = gmailSettings.data().userEmail;

  const taxSettings = await db.collection("settings").doc("taxDocs").get();
  const taxConf = taxSettings.exists ? taxSettings.data() : {};
  if (taxConf.enabled === false) {
    console.log("税理士資料収集が無効です");
    return;
  }

  // 複数メールアドレス対応
  const userEmails = settings.userEmails
    ? settings.userEmails.split(",").map((e) => e.trim()).filter(Boolean)
    : [userEmail];

  // Gemini APIキー取得
  const geminiDoc = await db.collection("settings").doc("scanSorter").get();
  const geminiApiKey = geminiDoc.exists ? geminiDoc.data().geminiApiKey : null;

  // Gmail API認証（OAuth2リフレッシュトークン方式）
  const gmailClients = {}; // email → gmail client
  try {
    const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
    const oauthData = oauthDoc.exists ? oauthDoc.data() : {};
    const { clientId, clientSecret } = oauthData;
    if (!clientId || !clientSecret) {
      console.log("OAuth2クライアント未設定（settings/gmailOAuth）");
      return;
    }

    const tokensSnap = await db.collection("settings").doc("gmailOAuth").collection("tokens").get();
    if (tokensSnap.empty) {
      console.log("Gmail認証済みアカウントなし");
      return;
    }

    for (const tokenDoc of tokensSnap.docs) {
      const tokenData = tokenDoc.data();
      if (!tokenData.refreshToken) continue;
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
      gmailClients[tokenData.email] = google.gmail({ version: "v1", auth: oauth2Client });
    }

    if (Object.keys(gmailClients).length === 0) {
      console.log("有効なGmailリフレッシュトークンなし");
      return;
    }
  } catch (e) {
    console.error("Gmail OAuth2認証エラー:", e.message);
    await logError_(db, "collectTaxDocs", e);
    return;
  }
  // デフォルトのGmailクライアント（最初のアカウント）
  const gmail = Object.values(gmailClients)[0];

  // Google Drive API
  const drive = await getDriveClient_();

  // 前月の年月を算出
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yearMonth = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}`;
  const afterDate = `${targetDate.getFullYear()}/${String(targetDate.getMonth() + 1).padStart(2, "0")}/01`;
  const beforeDate = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/01`;

  // 全名義を取得
  const entSnap = await db.collection("entities").orderBy("displayOrder").get();
  const summary = {}; // entityName → { collected: N, skipped: N, errors: N }

  for (const entDoc of entSnap.docs) {
    const ent = entDoc.data();
    const entityId = entDoc.id;
    const platforms = ent.platforms || [];
    summary[ent.name] = { collected: 0, skipped: 0, errors: 0 };

    if (!ent.taxFolderId) {
      summary[ent.name].errors++;
      continue;
    }

    for (const plat of platforms) {
      if (!plat.fromEmails || plat.fromEmails.length === 0) continue;

      try {
        // Gmail検索クエリ組み立て
        const fromQuery = plat.fromEmails.map((e) => `from:${e}`).join(" OR ");
        const additionalQuery = plat.gmailQuery || "";
        const query = `(${fromQuery}) ${additionalQuery} after:${afterDate} before:${beforeDate}`;

        const listRes = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: 10, // バッチ制限
        });

        const messages = listRes.data.messages || [];
        for (const msg of messages) {
          // 重複チェック
          const dupSnap = await db.collection("taxDocs")
            .where("gmailMessageId", "==", msg.id)
            .where("entityId", "==", entityId)
            .limit(1).get();
          if (!dupSnap.empty) {
            summary[ent.name].skipped++;
            continue;
          }

          // メール詳細取得
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "full",
          });

          const headers = detail.data.payload.headers || [];
          const subject = getHeader_(headers, "Subject") || "(件名なし)";
          const dateStr = getHeader_(headers, "Date") || "";

          // 添付ファイル処理
          const attachments = extractAttachments_(detail.data.payload);
          let savedFileName = "";
          let savedFileId = "";

          // フォルダ確保
          const yearStr = `${targetDate.getFullYear()}年`;
          const monthStr = `${targetDate.getMonth() + 1}月`;
          const yearFolder = await getOrCreateSubfolder_(drive, ent.taxFolderId, yearStr);
          const monthFolder = await getOrCreateSubfolder_(drive, yearFolder.id, monthStr);
          const platFolderName = plat.name.replace(/送金明細|手数料請求書/g, "").trim() || plat.name;
          const platFolder = await getOrCreateSubfolder_(drive, monthFolder.id, platFolderName);

          if (attachments.length > 0) {
            // 添付ファイルを保存
            for (const att of attachments) {
              const attData = await gmail.users.messages.attachments.get({
                userId: "me",
                messageId: msg.id,
                id: att.attachmentId,
              });
              const buf = Buffer.from(attData.data.data, "base64url");
              const created = await drive.files.create({
                requestBody: {
                  name: att.filename || `${plat.name}_${msg.id}.pdf`,
                  parents: [platFolder.id],
                },
                media: { mimeType: att.mimeType || "application/pdf", body: require("stream").Readable.from(buf) },
                supportsAllDrives: true,
                fields: "id,name",
              });
              savedFileName = created.data.name;
              savedFileId = created.data.id;
            }
          } else {
            // メール本文をHTML保存
            const bodyHtml = extractBody_(detail.data.payload);
            if (bodyHtml) {
              const buf = Buffer.from(bodyHtml, "utf-8");
              const htmlName = `${plat.name}_${yearMonth}_${msg.id.slice(0, 8)}.html`;
              const created = await drive.files.create({
                requestBody: { name: htmlName, parents: [platFolder.id] },
                media: { mimeType: "text/html", body: require("stream").Readable.from(buf) },
                supportsAllDrives: true,
                fields: "id,name",
              });
              savedFileName = created.data.name;
              savedFileId = created.data.id;
            }
          }

          // Gemini APIでメール解析（失敗しても続行）
          let analysis = { amount: null, transactionDate: null, description: "" };
          if (geminiApiKey) {
            try {
              const bodyText = extractBody_(detail.data.payload, true);
              analysis = await analyzeEmailWithGemini_(geminiApiKey, subject, bodyText || "");
            } catch (e) {
              console.warn("Gemini解析失敗（続行）:", e.message);
            }
          }

          // Firestoreに記録
          await db.collection("taxDocs").add({
            entityId,
            source: plat.name.toLowerCase().includes("airbnb") ? "airbnb" : "booking",
            sourceAccount: plat.name,
            yearMonth,
            fileName: savedFileName,
            driveFileId: savedFileId,
            driveFolderId: platFolder.id,
            gmailMessageId: msg.id,
            fileType: attachments.length > 0 ? "pdf" : "html",
            status: "collected",
            amount: analysis.amount,
            transactionDate: analysis.transactionDate,
            description: analysis.description || subject,
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
            collectedBy: "auto",
            memo: "",
          });

          // チェックリスト更新
          await updateChecklistItem_(db, yearMonth, entityId, plat.name);

          summary[ent.name].collected++;
        }
      } catch (e) {
        console.error(`メール収集エラー(${ent.name}/${plat.name}):`, e.message);
        summary[ent.name].errors++;
      }
    }
  }

  // LINE通知
  const lines = [`📋 税理士資料自動収集（${yearMonth}）\n`];
  for (const [name, s] of Object.entries(summary)) {
    if (s.collected > 0 || s.errors > 0) {
      lines.push(`${name}: ${s.collected}件収集${s.skipped > 0 ? ` (${s.skipped}件スキップ)` : ""}${s.errors > 0 ? ` ⚠️${s.errors}件エラー` : ""}`);
    }
  }
  if (lines.length > 1) {
    await notifyOwner(db, "tax_docs_collect", "税理士資料収集", lines.join("\n"));
  }
}

// ========================================
// MF受信BOX監視（週次）
// ========================================
async function processMfInbox(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const taxSettings = await db.collection("settings").doc("taxDocs").get();
  const taxConf = taxSettings.exists ? taxSettings.data() : {};
  if (taxConf.enabled === false) return;

  // Gemini APIキー取得
  const geminiDoc = await db.collection("settings").doc("scanSorter").get();
  const geminiApiKey = geminiDoc.exists ? geminiDoc.data().geminiApiKey : null;

  const drive = await getDriveClient_();
  const entSnap = await db.collection("entities").orderBy("displayOrder").get();
  const allEntities = entSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // MF受信BOXフォルダIDを収集（名義ごと or 共通）
  const folderIds = new Set();
  for (const ent of allEntities) {
    if (ent.mfInboxFolderId) folderIds.add(ent.mfInboxFolderId);
  }
  // 共通MF受信BOX（settings/taxDocs.mfInboxFolderId）
  if (taxConf.mfInboxFolderId) folderIds.add(taxConf.mfInboxFolderId);

  if (folderIds.size === 0) {
    console.log("MF受信BOXフォルダが未設定です");
    return;
  }

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const results = [];

  for (const folderId of folderIds) {
    let files;
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
        fields: "files(id,name,mimeType,createdTime)",
        pageSize: 50,
        orderBy: "createdTime desc",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      files = res.data.files || [];
    } catch (e) {
      console.error(`MF受信BOXアクセスエラー(${folderId}):`, e.message);
      continue;
    }

    for (const file of files) {
      // 既に処理済みかチェック
      const dupSnap = await db.collection("taxDocs")
        .where("driveFileId", "==", file.id)
        .limit(1).get();
      if (!dupSnap.empty) continue;

      // ファイル名から口座をキーワードマッチ
      let matchedEntity = null;
      let matchedAccount = null;
      for (const ent of allEntities) {
        for (const acc of (ent.accounts || [])) {
          const keywords = acc.keywords || [];
          if (keywords.some((kw) => file.name.toLowerCase().includes(kw.toLowerCase()))) {
            matchedEntity = ent;
            matchedAccount = acc;
            break;
          }
        }
        if (matchedEntity) break;
      }

      // マッチしない場合 → Gemini推定 or 未整理
      if (!matchedEntity && geminiApiKey) {
        try {
          // CSVの場合は中身を読んで推定
          if (file.mimeType === "text/csv" || file.name.endsWith(".csv")) {
            const content = await drive.files.get({ fileId: file.id, alt: "media", supportsAllDrives: true });
            const csvText = typeof content.data === "string" ? content.data : content.data.toString("utf-8").slice(0, 2000);
            const result = await estimateAccountWithGemini_(geminiApiKey, file.name, csvText, allEntities);
            if (result.entityId && result.accountName) {
              matchedEntity = allEntities.find((e) => e.id === result.entityId);
              matchedAccount = matchedEntity ? (matchedEntity.accounts || []).find((a) => a.name === result.accountName) : null;
            }
          }
        } catch (e) {
          console.warn("Gemini口座推定失敗:", e.message);
        }
      }

      if (!matchedEntity) {
        // 未整理フォルダに移動（あれば）
        console.log(`口座判定失敗: ${file.name}`);
        results.push({ file: file.name, status: "unmatched" });
        continue;
      }

      // 税理士フォルダにコピー
      const yearStr = `${now.getFullYear()}年`;
      const monthStr = `${now.getMonth() + 1}月`;
      const yearFolder = await getOrCreateSubfolder_(drive, matchedEntity.taxFolderId, yearStr);
      const monthFolder = await getOrCreateSubfolder_(drive, yearFolder.id, monthStr);
      const categoryFolder = matchedAccount.category === "credit" ? "クレジットカード明細" : "銀行口座明細";
      const catFolder = await getOrCreateSubfolder_(drive, monthFolder.id, categoryFolder);
      const accFolder = await getOrCreateSubfolder_(drive, catFolder.id, matchedAccount.name);

      // リネーム
      const ym = yearMonth.replace("-", "");
      const newName = `${ym}_${matchedAccount.name}_明細${file.name.endsWith(".csv") ? ".csv" : ".pdf"}`;

      const copied = await drive.files.copy({
        fileId: file.id,
        requestBody: { name: newName, parents: [accFolder.id] },
        supportsAllDrives: true,
        fields: "id,name",
      });

      // Firestoreに記録
      await db.collection("taxDocs").add({
        entityId: matchedEntity.id,
        source: "moneyforward",
        sourceAccount: matchedAccount.name,
        yearMonth,
        fileName: copied.data.name,
        driveFileId: copied.data.id,
        driveFolderId: accFolder.id,
        gmailMessageId: null,
        fileType: file.name.endsWith(".csv") ? "csv" : "pdf",
        status: "collected",
        amount: null,
        transactionDate: null,
        description: `MF受信BOXから自動整理: ${file.name}`,
        collectedAt: admin.firestore.FieldValue.serverTimestamp(),
        collectedBy: "auto",
        memo: "",
      });

      // チェックリスト更新
      await updateChecklistItem_(db, yearMonth, matchedEntity.id, matchedAccount.name);

      results.push({ file: file.name, status: "processed", entity: matchedEntity.name, account: matchedAccount.name });
    }
  }

  // LINE通知
  const processed = results.filter((r) => r.status === "processed");
  if (processed.length > 0) {
    const lines = [`📁 MF受信BOX処理: ${processed.length}件\n`];
    processed.forEach((r) => lines.push(`- ${r.account}(${r.entity})`));
    await notifyOwner(db, "tax_docs_mf", "MF受信BOX処理", lines.join("\n"));
  }
}

// ========== ヘルパー関数 ==========

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

function getHeader_(headers, name) {
  const h = headers.find((h) => h.name === name);
  return h ? h.value : null;
}

function extractAttachments_(payload) {
  const attachments = [];
  function walk(part) {
    if (part.filename && part.body && part.body.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return attachments;
}

function extractBody_(payload, textOnly) {
  let body = "";
  function walk(part) {
    if (textOnly && part.mimeType === "text/plain" && part.body && part.body.data) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
    } else if (!textOnly && part.mimeType === "text/html" && part.body && part.body.data) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return body;
}

async function analyzeEmailWithGemini_(apiKey, subject, bodyText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = `以下のメールの件名と本文から送金/請求情報を抽出してJSON出力してください。
JSONのみ出力。

件名: ${subject}
本文: ${bodyText.slice(0, 3000)}

出力形式:
{"amount": 金額(数値またはnull), "transactionDate": "YYYY-MM-DD"またはnull, "description": "概要テキスト"}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API: ${res.status}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { amount: null, transactionDate: null, description: "" };
  return JSON.parse(jsonMatch[0]);
}

async function estimateAccountWithGemini_(apiKey, fileName, csvContent, entities) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const entityList = entities.map((e) =>
    `${e.id}: ${e.name} — 口座: ${(e.accounts || []).map((a) => a.name).join(", ")}`
  ).join("\n");

  const prompt = `以下のCSVファイルがどの口座のデータか推定してJSON出力してください。
JSONのみ出力。

ファイル名: ${fileName}
CSV冒頭: ${csvContent.slice(0, 1500)}

名義・口座一覧:
${entityList}

出力形式: {"entityId": "...", "accountName": "..."}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 128 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API: ${res.status}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  return JSON.parse(jsonMatch[0]);
}

async function updateChecklistItem_(db, yearMonth, entityId, itemName) {
  const docRef = db.collection("taxDocsChecklist").doc(yearMonth).collection("entities").doc(entityId);
  const doc = await docRef.get();
  if (!doc.exists) return;

  const data = doc.data();
  const items = data.items || [];
  const idx = items.findIndex((i) => i.name === itemName);
  if (idx === -1) return;

  items[idx].collected = true;
  items[idx].collectedAt = new Date();
  items[idx].fileCount = (items[idx].fileCount || 0) + 1;

  const completedCount = items.filter((i) => i.collected).length;
  const { FieldValue } = require("firebase-admin/firestore");
  await docRef.update({ items, completedCount, updatedAt: FieldValue.serverTimestamp() });
}

async function logError_(db, functionName, error) {
  try {
    await db.collection("error_logs").add({
      functionName,
      errorMessage: error.message,
      stackTrace: error.stack || "",
      severity: "warning",
      notified: false,
      createdAt: new Date(),
    });
  } catch (e) { /* ログ記録失敗は無視 */ }
}

// エクスポート
module.exports = collectTaxDocs;
module.exports.processMfInbox = processMfInbox;
