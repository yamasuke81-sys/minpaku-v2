#!/usr/bin/env node
/**
 * guestRegistrations に Gmail Message ID を遡及保存するマイグレーションスクリプト
 *
 * 対象フィールド:
 *   A. formCompleteMailGmailId  — 完了メール (送信ボックス検索)
 *   B. formResponseGmailId      — フォーム受信メール (受信ボックス検索)
 *   C. editHistory[].gmailId    — 修正完了メール (送信ボックス検索)
 *
 * 実行方法:
 *   # DRY RUN (書き込みなし、検索結果だけ確認)
 *   cd functions && DRY_RUN=1 node migration/backfillGuestGmailIds.js
 *
 *   # 本番実行
 *   cd functions && node migration/backfillGuestGmailIds.js
 *
 *   # 対象を最新 N 件に絞る場合
 *   cd functions && LIMIT=20 node migration/backfillGuestGmailIds.js
 */

const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

// ============================================================
// 設定
// ============================================================

/** DRY_RUN=1 の場合は Firestore への書き込みをしない */
const DRY_RUN = process.env.DRY_RUN === "1";

/** 1リクエスト後のスリープ (ms)。Gmail API 上限: 250 req/sec を超えないよう 250ms 待機 */
const DELAY_MS = parseInt(process.env.DELAY_MS || "250", 10);

/** 処理上限件数 (0 = 全件) */
const LIMIT = parseInt(process.env.LIMIT || "0", 10);

// ============================================================
// OAuth2 クライアント初期化
// ============================================================

/**
 * Gmail OAuth2 クライアントを生成する
 * @param {string} refreshToken
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {import('googleapis').gmail_v1.Gmail}
 */
function buildGmailClient(refreshToken, clientId, clientSecret) {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

/**
 * 全 Gmail OAuth トークンを Firestore から取得する
 * 送信用と受信用で同じコレクション構造を使うため両方まとめて返す
 * @returns {Promise<Array<{email: string, refreshToken: string, label: string}>>}
 */
async function loadAllTokens() {
  const TOKEN_PATHS = [
    // 物件担当者の送信用トークン (context=property / default)
    { path: "settings/gmailOAuth/tokens", label: "gmailOAuth" },
    // メール照合用トークン (context=emailVerification / property)
    { path: "settings/gmailOAuthEmailVerification/tokens", label: "gmailOAuthEmailVerification" },
  ];

  const results = [];
  for (const { path, label } of TOKEN_PATHS) {
    const [col, doc, sub] = path.split("/");
    const snap = await db.collection(col).doc(doc).collection(sub).get();
    for (const d of snap.docs) {
      const t = d.data();
      if (t.refreshToken) {
        results.push({ email: t.email || "", refreshToken: t.refreshToken, label });
      }
    }
  }
  return results;
}

// ============================================================
// Gmail 検索ユーティリティ
// ============================================================

/** sleep ヘルパー */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Gmail で検索を実行して最初にヒットしたメッセージ ID を返す
 * @param {import('googleapis').gmail_v1.Gmail} gmail
 * @param {string} query - Gmail 検索クエリ文字列
 * @returns {Promise<{messageId: string|null, count: number}>}
 */
async function searchGmail(gmail, query) {
  await sleep(DELAY_MS);
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 5, // 複数ヒット検知のため 5 件取得
  });
  const messages = res.data.messages || [];
  return {
    messageId: messages.length > 0 ? messages[0].id : null,
    count: messages.length,
  };
}

/**
 * Unix タイムスタンプ (Date) を Gmail API の after:/before: クエリ用に変換する
 * Gmail は YYYY/MM/DD 形式 (UTC)
 * @param {Date} date
 * @returns {string}  例: "2026/04/15"
 */
function toGmailDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/**
 * 指定日から N 日加算した Date を返す
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// ============================================================
// A. 完了メール / C. 修正完了メール — 送信ボックス検索
// ============================================================

/**
 * 完了メール (formCompleteMail) の Gmail ID を送信ボックスから検索する
 *
 * 検索クエリ:
 *   in:sent to:{guestEmail} subject:{物件名} after:{createdAt日} before:{createdAt+2日}
 *
 * @param {import('googleapis').gmail_v1.Gmail} gmail
 * @param {{guestEmail: string, propertyName: string, createdAt: Date}} params
 * @returns {Promise<{messageId: string|null, count: number}>}
 */
async function searchCompleteMailSent(gmail, { guestEmail, propertyName, createdAt }) {
  if (!guestEmail) return { messageId: null, count: 0 };

  const afterDate = toGmailDate(createdAt);
  // +2日: createdAt の翌々日 00:00 UTC まで (前後24時間余裕を見て before +2日)
  const beforeDate = toGmailDate(addDays(createdAt, 2));

  // 件名の中心部分だけを検索 (テンプレート変数展開後の形)
  // 「【物件名】」で検索しやすい部分を使う。空のときは to+日付だけで検索
  const subjectFragment = propertyName ? `"【${propertyName}】"` : `"宿泊者名簿"`;
  const query = `in:sent to:${guestEmail} ${subjectFragment} after:${afterDate} before:${beforeDate}`;

  return searchGmail(gmail, query);
}

/**
 * 修正完了メール (formUpdateMail / editHistory[].gmailId) の Gmail ID を検索する
 * 件名テンプレート: 「【物件名】宿泊者名簿の修正を受け付けました」
 *
 * @param {import('googleapis').gmail_v1.Gmail} gmail
 * @param {{guestEmail: string, propertyName: string, editedAt: Date}} params
 * @returns {Promise<{messageId: string|null, count: number}>}
 */
async function searchUpdateMailSent(gmail, { guestEmail, propertyName, editedAt }) {
  if (!guestEmail) return { messageId: null, count: 0 };

  // editedAt の ±30分 を検索範囲にする (修正メールは即時送信)
  const afterDate = toGmailDate(addDays(editedAt, -1));
  const beforeDate = toGmailDate(addDays(editedAt, 1));

  const subjectFragment = propertyName ? `"【${propertyName}】" "修正"` : `"宿泊者名簿の修正"`;
  const query = `in:sent to:${guestEmail} ${subjectFragment} after:${afterDate} before:${beforeDate}`;

  return searchGmail(gmail, query);
}

// ============================================================
// B. フォーム受信メール — 受信ボックス検索
// ============================================================

/**
 * Google フォーム受信メールの Gmail ID を受信ボックスから検索する
 *
 * 検索クエリ:
 *   from:forms-receipts-noreply@google.com after:{createdAt-1日} before:{createdAt+1日}
 *   (件名でのゲスト名/物件名フィルタは Googleフォームの設定次第なので外す)
 *
 * @param {import('googleapis').gmail_v1.Gmail} gmail
 * @param {{createdAt: Date, guestName: string}} params
 * @returns {Promise<{messageId: string|null, count: number}>}
 */
async function searchFormResponseReceived(gmail, { createdAt, guestName }) {
  const afterDate = toGmailDate(addDays(createdAt, -1));
  const beforeDate = toGmailDate(addDays(createdAt, 1));

  // ゲスト名が入っていれば件名にも含めて絞り込む
  const guestFilter = guestName ? ` "${guestName}"` : "";
  const query = `from:forms-receipts-noreply@google.com${guestFilter} after:${afterDate} before:${beforeDate}`;

  return searchGmail(gmail, query);
}

// ============================================================
// Gmail クライアント選択ロジック
// ============================================================

/**
 * senderGmail に対応する Gmail クライアントを選択する
 * ない場合は最初に見つかったクライアントを返す
 *
 * @param {Map<string, import('googleapis').gmail_v1.Gmail>} gmailByEmail
 * @param {string|null} senderGmail
 * @returns {import('googleapis').gmail_v1.Gmail|null}
 */
function pickSenderGmailClient(gmailByEmail, senderGmail) {
  if (senderGmail && gmailByEmail.has(senderGmail)) {
    return gmailByEmail.get(senderGmail);
  }
  // フォールバック: 連携済みの最初のクライアント
  const first = gmailByEmail.values().next().value;
  return first || null;
}

// ============================================================
// メイン処理
// ============================================================

async function main() {
  console.log(`=== backfillGuestGmailIds 開始 ===`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`DELAY_MS: ${DELAY_MS}`);
  console.log(`LIMIT: ${LIMIT === 0 ? "全件" : LIMIT}`);
  console.log("");

  // --- 1. OAuth2 クライアント情報を Firestore から取得 ---
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists || !oauthDoc.data().clientId) {
    console.error("[ERROR] settings/gmailOAuth に clientId/clientSecret が設定されていません");
    process.exit(1);
  }
  const { clientId, clientSecret } = oauthDoc.data();

  const allTokens = await loadAllTokens();
  if (allTokens.length === 0) {
    console.error("[ERROR] 連携済み Gmail トークンが 1 件も見つかりません");
    process.exit(1);
  }
  console.log(`[init] 連携済み Gmail アカウント: ${allTokens.length} 件`);
  allTokens.forEach((t) => console.log(`  - ${t.email} (${t.label})`));
  console.log("");

  // email → Gmail クライアントの Map を構築
  /** @type {Map<string, import('googleapis').gmail_v1.Gmail>} */
  const gmailByEmail = new Map();
  for (const t of allTokens) {
    try {
      const client = buildGmailClient(t.refreshToken, clientId, clientSecret);
      gmailByEmail.set(t.email, client);
    } catch (e) {
      console.warn(`[warn] ${t.email}: クライアント生成失敗 — ${e.message}`);
    }
  }

  // --- 2. guestRegistrations を全件取得 ---
  let query = db.collection("guestRegistrations").orderBy("createdAt", "desc");
  if (LIMIT > 0) query = query.limit(LIMIT);

  const snap = await query.get();
  console.log(`[init] guestRegistrations 取得: ${snap.size} 件`);
  console.log("");

  // --- 3. 物件情報を事前取得 (propertyId → {name, senderGmail}) ---
  const propsSnap = await db.collection("properties").get();
  /** @type {Map<string, {name: string, senderGmail: string}>} */
  const propMap = new Map();
  propsSnap.forEach((d) => {
    const p = d.data();
    propMap.set(d.id, { name: p.name || "", senderGmail: p.senderGmail || "" });
  });

  // --- 4. 各ドキュメントを処理 ---
  let countA_ok = 0, countA_zero = 0, countA_multi = 0, countA_skip = 0;
  let countB_ok = 0, countB_zero = 0, countB_multi = 0, countB_skip = 0;
  let countC_ok = 0, countC_zero = 0, countC_multi = 0, countC_skip = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const guestId = doc.id;

    // createdAt を Date に変換
    const createdAt = data.createdAt
      ? (data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt))
      : null;

    if (!createdAt) {
      console.warn(`[skip] ${guestId}: createdAt なし`);
      continue;
    }

    const guestEmail = data.email || "";
    const guestName = data.guestName || "";
    const propertyId = data.propertyId || "";
    const prop = propMap.get(propertyId) || { name: data.propertyName || "", senderGmail: "" };
    const propertyName = prop.name;
    const senderGmail = prop.senderGmail;

    // 送信用 Gmail クライアント (物件担当者のアカウント)
    const senderGmailClient = pickSenderGmailClient(gmailByEmail, senderGmail || null);

    // 受信用 Gmail クライアント (メール照合アカウント。なければ送信と同じ)
    // settings/gmailOAuthEmailVerification/tokens にあるアカウントを優先
    const receiverTokens = allTokens.filter((t) => t.label === "gmailOAuthEmailVerification");
    const receiverGmailClient =
      receiverTokens.length > 0
        ? gmailByEmail.get(receiverTokens[0].email) || senderGmailClient
        : senderGmailClient;

    /** Firestore への更新内容を蓄積する */
    const updates = {};

    // ========================================================
    // A. formCompleteMailGmailId (完了メール送信ID)
    // ========================================================
    if (!data.formCompleteMailGmailId) {
      if (!senderGmailClient) {
        console.warn(`[A skip] ${guestId} ${guestName}: Gmail クライアントなし`);
        countA_skip++;
      } else {
        try {
          const result = await searchCompleteMailSent(senderGmailClient, {
            guestEmail,
            propertyName,
            createdAt,
          });

          if (result.count === 0) {
            console.log(`[A:0件] ${guestId} ${guestName} (${guestEmail}) ${propertyName}`);
            countA_zero++;
          } else if (result.count > 1) {
            console.warn(`[A:複数(${result.count}件)] ${guestId} ${guestName} → 先頭 ${result.messageId} を採用`);
            updates.formCompleteMailGmailId = result.messageId;
            countA_multi++;
          } else {
            console.log(`[A:OK] ${guestId} ${guestName} → ${result.messageId}`);
            updates.formCompleteMailGmailId = result.messageId;
            countA_ok++;
          }
        } catch (e) {
          console.error(`[A:ERR] ${guestId} ${guestName}: ${e.message}`);
          errors++;
        }
      }
    } else {
      countA_skip++;
    }

    // ========================================================
    // B. formResponseGmailId (Googleフォーム受信メール)
    // ========================================================
    if (!data.formResponseGmailId) {
      if (!receiverGmailClient) {
        console.warn(`[B skip] ${guestId} ${guestName}: 受信用 Gmail クライアントなし`);
        countB_skip++;
      } else {
        try {
          const result = await searchFormResponseReceived(receiverGmailClient, {
            createdAt,
            guestName,
          });

          if (result.count === 0) {
            console.log(`[B:0件] ${guestId} ${guestName}`);
            countB_zero++;
          } else if (result.count > 1) {
            console.warn(`[B:複数(${result.count}件)] ${guestId} ${guestName} → 先頭 ${result.messageId} を採用`);
            updates.formResponseGmailId = result.messageId;
            countB_multi++;
          } else {
            console.log(`[B:OK] ${guestId} ${guestName} → ${result.messageId}`);
            updates.formResponseGmailId = result.messageId;
            countB_ok++;
          }
        } catch (e) {
          console.error(`[B:ERR] ${guestId} ${guestName}: ${e.message}`);
          errors++;
        }
      }
    } else {
      countB_skip++;
    }

    // ========================================================
    // C. editHistory[].gmailId (修正完了メール)
    // ========================================================
    const editHistory = Array.isArray(data.editHistory) ? data.editHistory : [];
    const updatedHistory = [...editHistory];
    let historyChanged = false;

    for (let i = 0; i < updatedHistory.length; i++) {
      const entry = updatedHistory[i];
      if (entry.gmailId) {
        // 既にある → スキップ
        countC_skip++;
        continue;
      }

      // editedAt を Date に変換
      const editedAt = entry.editedAt
        ? (entry.editedAt.toDate ? entry.editedAt.toDate() : new Date(entry.editedAt))
        : null;

      if (!editedAt) {
        console.warn(`[C skip] ${guestId} history[${i}]: editedAt なし`);
        countC_skip++;
        continue;
      }

      if (!senderGmailClient) {
        countC_skip++;
        continue;
      }

      try {
        const result = await searchUpdateMailSent(senderGmailClient, {
          guestEmail,
          propertyName,
          editedAt,
        });

        if (result.count === 0) {
          console.log(`[C:0件] ${guestId} history[${i}] ${new Date(editedAt).toISOString().slice(0, 10)}`);
          countC_zero++;
        } else if (result.count > 1) {
          console.warn(`[C:複数(${result.count}件)] ${guestId} history[${i}] → 先頭 ${result.messageId} を採用`);
          updatedHistory[i] = { ...entry, gmailId: result.messageId };
          historyChanged = true;
          countC_multi++;
        } else {
          console.log(`[C:OK] ${guestId} history[${i}] → ${result.messageId}`);
          updatedHistory[i] = { ...entry, gmailId: result.messageId };
          historyChanged = true;
          countC_ok++;
        }
      } catch (e) {
        console.error(`[C:ERR] ${guestId} history[${i}]: ${e.message}`);
        errors++;
      }
    }

    // editHistory に変更があれば updates に追加
    if (historyChanged) {
      updates.editHistory = updatedHistory;
    }

    // ========================================================
    // Firestore 書き込み
    // ========================================================
    if (Object.keys(updates).length > 0) {
      if (DRY_RUN) {
        console.log(`[DRY] ${guestId} 更新予定フィールド: ${Object.keys(updates).join(", ")}`);
      } else {
        try {
          await db.collection("guestRegistrations").doc(guestId).update(updates);
        } catch (e) {
          console.error(`[write ERR] ${guestId}: ${e.message}`);
          errors++;
        }
      }
    }
  }

  // --- 5. サマリ出力 ---
  console.log("");
  console.log("=== 結果サマリ ===");
  console.log(`A (完了メール送信ID):   成功 ${countA_ok} / 複数ヒット採用 ${countA_multi} / 0件 ${countA_zero} / スキップ ${countA_skip}`);
  console.log(`B (フォーム受信メール): 成功 ${countB_ok} / 複数ヒット採用 ${countB_multi} / 0件 ${countB_zero} / スキップ ${countB_skip}`);
  console.log(`C (修正完了メール):     成功 ${countC_ok} / 複数ヒット採用 ${countC_multi} / 0件 ${countC_zero} / スキップ ${countC_skip}`);
  console.log(`エラー: ${errors}`);
  if (DRY_RUN) {
    console.log("");
    console.log("*** DRY_RUN=1 のため Firestore への書き込みはしていません ***");
    console.log("*** 本番実行: DRY_RUN=1 を外してください ***");
  }
  console.log("=== backfillGuestGmailIds 完了 ===");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[FATAL]", e);
    process.exit(1);
  });
