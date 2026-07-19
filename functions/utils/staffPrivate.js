/**
 * スタッフ機微情報 (staff/{staffId}/private/details) のマージ取得ヘルパー
 *
 * 背景: staff 本体 doc は firestore.rules で「active スタッフなら他スタッフの
 * full doc を読める」(清掃カレンダーのスタッフ一覧表示に必要) ため、
 * 電話・住所・銀行口座・請求名義などの機微フィールドが同僚全員から
 * 読める状態だった。これらをサブコレクション private/details へ分離し、
 * read/write を owner / 本人 / 担当sub_owner に限定する。
 *
 * 本体 doc には name / active / displayOrder / assignedPropertyIds / isTimee /
 * isOwner / isSubOwner / email / lineUserId 等の業務フィールドを残す
 * (email・lineUserId は通知送信の宛先として多数のバックエンドが参照するため
 *  本体残し。→ 残課題として監査メモに記録)。
 *
 * 請求書PDF生成など機微フィールドの読み手は必ずこのヘルパー経由で取得すること。
 */

// 本体 doc から private/details へ移動する機微フィールドの一覧 (移行スクリプトと共有)
const STAFF_PRIVATE_FIELDS = [
  "phone",
  "address",
  "zipCode",
  "bankName",
  "branchName",
  "accountType",
  "accountNumber",
  "accountHolder",
  "billingProfiles",
  "contractUrl",
  "contractMemo",
];

function privateRef(db, staffId) {
  return db.collection("staff").doc(staffId).collection("private").doc("details");
}

/**
 * 本体 doc + private/details をマージしたスタッフデータを返す。
 * @returns {Promise<object|null>} マージ済みデータ (本体が存在しなければ null)
 */
async function getStaffWithPrivate(db, staffId) {
  if (!staffId) return null;
  const [mainSnap, privSnap] = await Promise.all([
    db.collection("staff").doc(staffId).get(),
    privateRef(db, staffId).get(),
  ]);
  if (!mainSnap.exists) return null;
  const main = mainSnap.data();
  const priv = privSnap.exists ? privSnap.data() : null;
  return priv ? { ...main, ...priv } : main;
}

/**
 * 既に取得済みの本体データに private をマージする (一覧走査時用)
 */
async function mergePrivateInto(db, staffId, mainData) {
  try {
    const privSnap = await privateRef(db, staffId).get();
    if (privSnap.exists) return { ...mainData, ...privSnap.data() };
  } catch (_) { /* 読めない場合は本体のみ */ }
  return mainData;
}

module.exports = { STAFF_PRIVATE_FIELDS, privateRef, getStaffWithPrivate, mergePrivateInto };
