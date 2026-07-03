const admin = require("firebase-admin");

/**
 * 報酬単価マスタ (propertyWorkItems) の「月別解決」ユーティリティ
 *
 * 締め済み月の請求書が、翌月以降の単価変更で変わってしまう問題への恒久対策。
 * - propertyWorkItems/{propertyId}/history/{YYYY-MM} = 「その月末時点の items スナップショット」
 * - history は onPropertyWorkItemsWrite トリガーが「月をまたいだ最初の変更」の直前状態を自動保存する
 * - 過去月の請求書計算は getWorkItemsForMonth() で当該月のスナップショットを参照する
 */

const JST_OFFSET = 9 * 60 * 60 * 1000;

/** JST基準の "YYYY-MM" を返す */
function jstYm(d = new Date()) {
  const t = new Date(d.getTime() + JST_OFFSET);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" の前月を返す */
function prevYmOf(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 指定月に適用すべき作業項目リスト (items) を返す
 * - 当月・未来月・月指定なし → 現行マスタ
 * - 過去月 → history から「対象月以降で最も古いスナップショット」(= 対象月末時点の状態)。
 *   スナップショットが無ければ現行マスタ (その月以降単価変更が無かったということ)
 * @param {object} db - Firestore
 * @param {string} propertyId
 * @param {string|null} yearMonth - "YYYY-MM"
 * @returns {Promise<Array>} items
 */
async function getWorkItemsForMonth(db, propertyId, yearMonth) {
  if (!propertyId) return [];
  const readCurrent = async () => {
    const doc = await db.collection("propertyWorkItems").doc(propertyId).get();
    return doc.exists ? (doc.data().items || []) : [];
  };
  if (!yearMonth || yearMonth >= jstYm()) return readCurrent();
  try {
    const snap = await db.collection("propertyWorkItems").doc(propertyId)
      .collection("history")
      .where(admin.firestore.FieldPath.documentId(), ">=", yearMonth)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].data().items || [];
  } catch (e) {
    console.warn(`[workItemsMonth] history 参照失敗 property=${propertyId} ym=${yearMonth}:`, e.message);
  }
  return readCurrent();
}

module.exports = { jstYm, prevYmOf, getWorkItemsForMonth };
