/**
 * 宿泊者名簿 作成時トリガー
 * guestRegistrations/{id} が作成された際、propertyId 未設定なら bookings から推論して補完する。
 *
 * 推論の優先順:
 *   レベル A: CI と CO が完全一致 (単一ヒット)
 *   レベル B: CI のみ一致 (単一ヒット)
 *   レベル C: 日程オーバーラップ (単一ヒット)
 *   複数ヒット時: guest.bookingSite / guest.source のヒントで source マッチ絞り込み
 *   それでも絞れない場合: 補完しない
 *
 * GAS 側 (syncGuestFormToV2.gs) は触れない方針のため、v2 側で救済する。
 */
const admin = require("firebase-admin");

// ==============================
// 日付正規化
// ==============================
function toDateStr(v) {
  if (!v) return null;
  if (typeof v === "string") {
    // "2026-04-22" 形式想定。Timestamp 文字列なら先頭10文字だけ取る
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  // Firestore Timestamp
  if (typeof v.toDate === "function") {
    const d = v.toDate();
    return formatDate_(d);
  }
  if (v instanceof Date) return formatDate_(v);
  // seconds プロパティを持つ Timestamp-like
  if (typeof v.seconds === "number") {
    return formatDate_(new Date(v.seconds * 1000));
  }
  return null;
}

function formatDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ==============================
// source ヒント正規化
// ==============================
function normalizeSource_(s) {
  if (!s) return "";
  const low = String(s).toLowerCase();
  if (low.includes("airbnb")) return "airbnb";
  if (low.includes("booking")) return "booking";
  if (low.includes("agoda")) return "agoda";
  if (low.includes("expedia")) return "expedia";
  if (low.includes("direct") || low.includes("直")) return "direct";
  return low;
}

// ==============================
// 推論ロジック (純粋関数)
// guest: { checkIn, checkOut, bookingSite, source }
// bookings: [{ id, checkIn, checkOut, source, propertyId }]
// returns: { propertyId, level, bookingId } or null
// ==============================
function inferPropertyId(guest, bookings) {
  const gCi = toDateStr(guest.checkIn);
  const gCo = toDateStr(guest.checkOut);
  if (!gCi) return null;

  const normalized = (bookings || [])
    .map((b) => ({
      id: b.id,
      propertyId: b.propertyId || (b.data && b.data.propertyId) || null,
      checkIn: toDateStr(b.checkIn != null ? b.checkIn : b.data && b.data.checkIn),
      checkOut: toDateStr(b.checkOut != null ? b.checkOut : b.data && b.data.checkOut),
      source: normalizeSource_(b.source || (b.data && b.data.source)),
    }))
    .filter((b) => b.propertyId && b.checkIn);

  const hint = normalizeSource_(guest.bookingSite || guest.source || "");

  function pickOrFilter(cands, level) {
    if (cands.length === 0) return null;
    if (cands.length === 1) {
      return { propertyId: cands[0].propertyId, level, bookingId: cands[0].id };
    }
    // 複数ヒット → source ヒントで絞る
    if (hint) {
      const filtered = cands.filter((b) => b.source === hint);
      if (filtered.length === 1) {
        return { propertyId: filtered[0].propertyId, level: level + "+source", bookingId: filtered[0].id };
      }
    }
    // 絞れない → 同一 propertyId に全て収まっていれば確定
    const uniqProps = [...new Set(cands.map((b) => b.propertyId))];
    if (uniqProps.length === 1) {
      return { propertyId: uniqProps[0], level: level + "+uniqProperty", bookingId: cands[0].id };
    }
    return null;
  }

  // レベル A: CI && CO 完全一致
  if (gCo) {
    const exact = normalized.filter((b) => b.checkIn === gCi && b.checkOut === gCo);
    const r = pickOrFilter(exact, "A");
    if (r) return r;
  }

  // レベル B: CI のみ一致
  const ciOnly = normalized.filter((b) => b.checkIn === gCi);
  const rB = pickOrFilter(ciOnly, "B");
  if (rB) return rB;

  // レベル C: オーバーラップ
  if (gCo) {
    const overlap = normalized.filter((b) => b.checkIn <= gCo && b.checkOut >= gCi);
    const rC = pickOrFilter(overlap, "C");
    if (rC) return rC;
  }

  return null;
}

// ==============================
// メール送信 (onGuestFormSubmit 側で行うためこの関数は廃止)
// ==============================
const DEFAULT_GUIDE_URL = "https://yado-komachi-guide.web.app/";
const APP_URL = "https://minpaku-v2.web.app";

// eslint-disable-next-line no-unused-vars
async function _sendRegistrationEmails_deprecated(db, guestData, guestId) {
  if (guestData.emailsSentAt) {
    console.log(`[onGuestRegistrationCreate] emailsSentAt 済 guest=${guestId}, skip`);
    return;
  }
  // guest_form 由来のみ送信 (手動登録は除外)
  if (guestData.source !== "guest_form") {
    console.log(`[onGuestRegistrationCreate] source=${guestData.source} 非対象 guest=${guestId}`);
    return;
  }

  // 物件情報取得
  const pid = guestData.propertyId || "";
  let propData = null;
  if (pid) {
    const pDoc = await db.collection("properties").doc(pid).get();
    if (pDoc.exists) propData = pDoc.data();
  }
  const propName = (propData && propData.name) || "(物件未特定)";
  const propAddress = (propData && propData.address) || "";
  const guideUrl = (propData && propData.guideUrl) || DEFAULT_GUIDE_URL;

  const guestName = guestData.guestName || "お客様";
  const guestEmail = guestData.email || "";
  const editToken = guestData.editToken || "";
  const editUrl = editToken ? `${APP_URL}/guest-form.html?edit=${encodeURIComponent(editToken)}` : "";
  const checkIn = typeof guestData.checkIn === "string" ? guestData.checkIn : toDateStr(guestData.checkIn) || "";
  const checkOut = typeof guestData.checkOut === "string" ? guestData.checkOut : toDateStr(guestData.checkOut) || "";

  const { sendNotificationEmail_ } = require("../utils/lineNotify");

  // --- 1. 宿泊者宛サンクスメール ---
  if (guestEmail) {
    const subject = `【${propName}】宿泊者名簿のご記入ありがとうございました`;
    const body = [
      `${guestName} 様`,
      ``,
      `宿泊者名簿のご記入、誠にありがとうございました。`,
      ``,
      `■ 宿情報`,
      `  宿名: ${propName}`,
      propAddress ? `  住所: ${propAddress}` : null,
      ``,
      `■ チェックイン / チェックアウト`,
      `  ${checkIn} 〜 ${checkOut}`,
      ``,
      `■ ご入力内容の確認・修正`,
      editUrl ? `  以下のリンクから、ご入力内容の確認・修正が可能です（30日間有効）:` : null,
      editUrl ? `  ${editUrl}` : null,
      ``,
      `■ 宿泊者向けガイドページ`,
      `  ${guideUrl}`,
      ``,
      `ご不明点がございましたらご連絡ください。`,
      `ご宿泊を心よりお待ちしております。`,
    ].filter(Boolean).join("\n");
    try {
      await sendNotificationEmail_(guestEmail, subject, body);
      console.log(`[onGuestRegistrationCreate] 宿泊者メール送信 ${guestEmail}`);
    } catch (e) {
      console.error(`[onGuestRegistrationCreate] 宿泊者メール失敗 ${guestEmail}:`, e.message);
    }
  } else {
    console.log(`[onGuestRegistrationCreate] 宿泊者メールアドレスなし guest=${guestId}`);
  }

  // --- 2. Webアプリ管理者/物件オーナー通知メール ---
  // Webアプリ管理者アドレス: settings/notifications の ownerEmail / notifyEmails
  let ownerEmail = "";
  try {
    const notifDoc = await db.collection("settings").doc("notifications").get();
    if (notifDoc.exists) {
      const nd = notifDoc.data();
      ownerEmail = nd.ownerEmail || (Array.isArray(nd.notifyEmails) ? nd.notifyEmails[0] : "") || "";
    }
  } catch (_) {}

  // 物件オーナー: staff コレクションから isSubOwner=true && ownedPropertyIds に pid 含むもの
  const subOwners = [];
  const subOwnersNoEmail = [];
  if (pid) {
    try {
      const staffSnap = await db.collection("staff")
        .where("isSubOwner", "==", true)
        .get();
      staffSnap.forEach((doc) => {
        const s = doc.data();
        const owned = Array.isArray(s.ownedPropertyIds) ? s.ownedPropertyIds : [];
        if (!owned.includes(pid)) return;
        if (s.email) subOwners.push({ name: s.name || "(無名)", email: s.email });
        else         subOwnersNoEmail.push(s.name || "(無名)");
      });
    } catch (e) {
      console.error("[onGuestRegistrationCreate] 物件オーナー検索エラー:", e.message);
    }
  }

  const guestDetailUrl = `${APP_URL}/#/guests`;
  const notifSubject = `【${propName}】宿泊者名簿が入力されました (${guestName})`;
  const notifBodyBase = [
    `宿泊者名簿が入力されました。`,
    ``,
    `■ 宿`,
    `  ${propName}`,
    propAddress ? `  ${propAddress}` : null,
    ``,
    `■ 宿泊者`,
    `  氏名: ${guestName}`,
    guestEmail ? `  メール: ${guestEmail}` : null,
    `  チェックイン: ${checkIn}`,
    `  チェックアウト: ${checkOut}`,
    `  宿泊人数: ${guestData.guestCount || "-"}名`,
    ``,
    `■ 宿泊者名簿 (管理画面)`,
    `  ${guestDetailUrl}`,
  ].filter(Boolean).join("\n");

  // 送信タスク
  const sendTasks = [];
  if (ownerEmail) {
    let ownerBody = notifBodyBase;
    if (subOwnersNoEmail.length > 0) {
      ownerBody += `\n\n※ 以下の物件オーナーにはメールアドレスが未設定のため通知されていません:\n` +
        subOwnersNoEmail.map((n) => `  - ${n}`).join("\n");
    }
    sendTasks.push(
      sendNotificationEmail_(ownerEmail, notifSubject, ownerBody)
        .then(() => console.log(`[onGuestRegistrationCreate] Webアプリ管理者メール送信 ${ownerEmail}`))
        .catch((e) => console.error(`[onGuestRegistrationCreate] Webアプリ管理者メール失敗 ${ownerEmail}:`, e.message))
    );
  } else {
    console.log(`[onGuestRegistrationCreate] ownerEmail 未設定`);
  }
  for (const so of subOwners) {
    sendTasks.push(
      sendNotificationEmail_(so.email, notifSubject, notifBodyBase)
        .then(() => console.log(`[onGuestRegistrationCreate] 物件オーナーメール送信 ${so.email}`))
        .catch((e) => console.error(`[onGuestRegistrationCreate] 物件オーナーメール失敗 ${so.email}:`, e.message))
    );
  }
  await Promise.allSettled(sendTasks);
}

// ==============================
// トリガー本体
// ==============================
async function handler(event) {
  const db = admin.firestore();
  const guest = event.data?.data();
  const guestId = event.params?.guestId;
  if (!guest) return;

  // propertyId 補完 (既に設定済みならスキップ)
  if (!guest.propertyId) {
    const gCi = toDateStr(guest.checkIn);
    const gCo = toDateStr(guest.checkOut);
    if (!gCi) {
      console.log(`[onGuestRegistrationCreate] checkIn 未設定 guest=${guestId}, 推論不可`);
    } else {
      const snap = await db.collection("bookings")
        .where("status", "in", ["confirmed", "completed", "active"])
        .get()
        .catch(async () => db.collection("bookings").get());
      const bookings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const result = inferPropertyId(guest, bookings);
      if (result) {
        await event.data.ref.update({
          propertyId: result.propertyId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        guest.propertyId = result.propertyId;
        console.log(
          `[onGuestRegistrationCreate] propertyId 補完成功 guest=${guestId} → ${result.propertyId} ` +
          `(level=${result.level}, fromBooking=${result.bookingId})`
        );
      } else {
        console.log(`[onGuestRegistrationCreate] 推論不可 guest=${guestId} ci=${gCi} co=${gCo} 候補数=${bookings.length}`);
      }
    }
  }

  // メール送信は onGuestFormSubmit トリガー側で行う (重複送信防止のため当トリガーからは撤去)
}

module.exports = handler;
module.exports.inferPropertyId = inferPropertyId;
module.exports._toDateStr = toDateStr;
