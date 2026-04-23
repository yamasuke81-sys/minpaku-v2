/**
 * 宿泊者名簿受信トリガー
 * source=guest_form の場合:
 *   1. editToken生成・ステータス設定
 *   2. オーナーにメール（入力内容全文）
 *   3. 宿泊者にメール（入力内容全文 + 修正リンク）
 *   4. LINE通知（既存）
 */
const crypto = require("crypto");
const { notifyOwner, sendNotificationEmail_ } = require("../utils/lineNotify");
const { renderTemplate, buildGuestSummaryText, getTemplates } = require("../utils/emailTemplates");

const APP_URL = "https://minpaku-v2.web.app";

module.exports = async function onGuestFormSubmit(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const data = event.data?.data();
  if (!data) return;

  // 公開フォームからの投稿のみ処理
  if (data.source !== "guest_form") return;

  const docRef = event.data.ref;
  const guestId = event.params?.guestId || docRef.id;

  // === 1. editToken生成・ステータス設定 (有効期限30日) ===
  const editToken = crypto.randomBytes(32).toString("hex");
  const editTokenExpiresAt = admin.firestore.Timestamp.fromMillis(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  );
  await docRef.update({
    editToken,
    editTokenExpiresAt,
    status: "submitted",
  });

  const guestName = data.guestName || "名前不明";
  const checkIn = data.checkIn || "?";
  const checkOut = data.checkOut || "?";
  const guestCount = data.guestCount || "?";
  const guestEmail = data.email || "";

  // === 2. メール送信 ===
  const summary = buildGuestSummaryText(data);
  const editUrl = `${APP_URL}/guest-form.html?edit=${editToken}`;
  const confirmUrl = `${APP_URL}/#/guests`;

  const templates = await getTemplates(db);

  // 物件情報取得 (宿名/住所/ガイドURL/担当者メール)
  let propertyName = "";
  let propertyAddress = "";
  let guideUrl = `${APP_URL}/guest-guide.html`;
  if (data.propertyId) {
    try {
      const pDoc = await db.collection("properties").doc(data.propertyId).get();
      if (pDoc.exists) {
        const p = pDoc.data();
        propertyName = p.name || "";
        propertyAddress = p.address || "";
        if (p.guideUrl) guideUrl = p.guideUrl;
      }
    } catch (e) { console.error("物件情報取得エラー:", e.message); }
  }
  if (!propertyName) propertyName = data.propertyName || "";

  // 送信者アドレス: 物件担当者 (サブオーナー最優先、なければ settings/notifications.ownerEmail)
  // onGuestFormSubmit は先に notifyEmails/subOwners を解決してから使うため、ここでは後続で決定する
  const vars = {
    guestName, checkIn, checkOut, guestCount,
    checkInTime: data.checkInTime || "",
    checkOutTime: data.checkOutTime || "",
    nationality: data.nationality || "日本",
    propertyName,
    propertyAddress,
    summary, editUrl, confirmUrl, guideUrl,
  };

  // 2a. オーナー + サブオーナーへのメール
  // 通知先 + 送信者 (sender) 解決
  const notifDoc = await db.collection("settings").doc("notifications").get();
  const notifyEmails = notifDoc.exists ? (notifDoc.data().notifyEmails || []) : [];
  const ownerEmail = notifDoc.exists ? (notifDoc.data().ownerEmail || notifyEmails[0] || "") : (notifyEmails[0] || "");

  // サブオーナー: staff コレクションから isSubOwner=true && ownedPropertyIds に pid 含むもの
  const pid = data.propertyId || "";
  const subOwners = [];
  const subOwnersNoEmail = [];
  if (pid) {
    try {
      const staffSnap = await db.collection("staff").where("isSubOwner", "==", true).get();
      staffSnap.forEach((sDoc) => {
        const s = sDoc.data();
        const owned = Array.isArray(s.ownedPropertyIds) ? s.ownedPropertyIds : [];
        if (!owned.includes(pid)) return;
        if (s.email) subOwners.push({ name: s.name || "(無名)", email: s.email });
        else         subOwnersNoEmail.push(s.name || "(無名)");
      });
    } catch (e) {
      console.error("サブオーナー検索エラー:", e.message);
    }
  }

  // 物件担当者 (送信者) — サブオーナー最優先、なければオーナー
  const senderEmail = (subOwners[0] && subOwners[0].email) || ownerEmail || "";
  vars.senderEmail = senderEmail;
  vars.senderName = (subOwners[0] && subOwners[0].name) || propertyName || "宿担当者";

  // 宿泊者宛メール件名を物件名入りで生成 (テンプレート変数 {propertyName} 経由)
  const guestSubjectOverride = propertyName
    ? `【${propertyName}】宿泊者名簿をお預かりしました／${guestName} 様`
    : null;
  const ownerSubjectOverride = propertyName
    ? `【${propertyName}】宿泊者名簿が届きました（${guestName} / ${checkIn}〜${checkOut}）`
    : null;

  try {
    const ownerSubject = ownerSubjectOverride || renderTemplate(templates.ownerNotification.subject, vars);
    const ownerBody = renderTemplate(templates.ownerNotification.body, vars);

    // オーナー本文: サブオーナーでメール未設定者がいれば末尾に注記
    let ownerBodyExtra = ownerBody;
    if (subOwnersNoEmail.length > 0) {
      ownerBodyExtra += `\n\n※ 以下のサブオーナーはメールアドレス未設定のため通知されていません:\n` +
        subOwnersNoEmail.map((n) => `  - ${n}`).join("\n");
    }

    for (const email of notifyEmails) {
      try {
        await sendNotificationEmail_(email, ownerSubject, ownerBodyExtra, senderEmail);
        console.log(`オーナーメール送信成功: ${email} (from=${senderEmail || "default"})`);
      } catch (e) {
        console.error(`オーナーメール送信失敗 (${email}):`, e.message);
      }
    }
    for (const so of subOwners) {
      try {
        await sendNotificationEmail_(so.email, ownerSubject, ownerBody, senderEmail);
        console.log(`サブオーナーメール送信成功: ${so.email}`);
      } catch (e) {
        console.error(`サブオーナーメール送信失敗 (${so.email}):`, e.message);
      }
    }
  } catch (e) {
    console.error("オーナーメール処理エラー:", e.message);
  }

  // 2b. 宿泊者へのメール (from = 物件担当者)
  if (guestEmail) {
    try {
      const guestSubject = guestSubjectOverride || renderTemplate(templates.guestConfirmation.subject, vars);
      const guestBody = renderTemplate(templates.guestConfirmation.body, vars);
      await sendNotificationEmail_(guestEmail, guestSubject, guestBody, senderEmail);
      console.log(`宿泊者メール送信成功: ${guestEmail} (from=${senderEmail || "default"})`);
    } catch (e) {
      console.error(`宿泊者メール送信失敗 (${guestEmail}):`, e.message);
    }
  } else {
    console.warn("宿泊者のメールアドレスが未入力のためメール送信スキップ");
  }

  // === 3. LINE通知（既存） ===
  let lineText = `📝 宿泊者名簿が届きました\n\n`;
  lineText += `代表者: ${guestName}\n`;
  lineText += `国籍: ${data.nationality || "日本"}\n`;
  lineText += `CI: ${checkIn} → CO: ${checkOut}\n`;
  lineText += `人数: ${guestCount}名\n`;

  if (data.bbq && data.bbq !== "No" && data.bbq !== "なし" && data.bbq !== "利用しない") {
    lineText += `BBQ: ${data.bbq}\n`;
  }
  if (data.transport === "車" || data.transport === "Car") {
    lineText += `車: ${data.carCount || "?"}台\n`;
    if (data.paidParking && data.paidParking !== "利用しない") {
      lineText += `有料駐車場: ${data.paidParking}\n`;
    }
  }

  // roster_received 通知 (通知設定タブで編集可能)
  await notifyOwner(db, "roster_received", `名簿受信: ${guestName}`, lineText, {
    checkin: checkIn,
    date: checkOut,
    property: data.propertyName || "",
    guest: guestName,
    nights: data.nights || "",
    site: data.bookingSite || "",
    url: `${APP_URL}/#/guests`,
  });

  // === 4. bookingsコレクションとの照合・情報補完 ===
  try {
    const rosterCheckIn = data.checkIn;
    const rosterCheckOut = data.checkOut;

    if (!rosterCheckIn) {
      console.warn("名簿にcheckInが未設定のため照合をスキップ");
      return;
    }

    // A-4: checkIn一致 + status == "confirmed" + propertyId一致（複数物件の誤照合防止）
    let bookingsQuery = db.collection("bookings")
      .where("checkIn", "==", rosterCheckIn)
      .where("status", "==", "confirmed");
    if (data.propertyId) {
      bookingsQuery = bookingsQuery.where("propertyId", "==", data.propertyId);
    }
    const bookingsSnap = await bookingsQuery.limit(1).get();

    // 処理B-3: マッチなし
    if (bookingsSnap.empty) {
      const warnMsg = `⚠️ 名簿照合: 該当する予約が見つかりません\n\nCI: ${rosterCheckIn}\n代表者: ${guestName}`;
      await db.collection("notifications").add({
        type: "roster_mismatch",
        title: `名簿照合エラー: ${guestName}`,
        body: `該当する予約が見つかりません（checkIn: ${rosterCheckIn}）`,
        guestId,
        checkIn: rosterCheckIn,
        severity: "warning",
        createdAt: new Date(),
      });
      await notifyOwner(db, "roster_mismatch", `名簿照合エラー: ${guestName}`, warnMsg);
      console.warn("名簿照合: 一致するbookingなし", rosterCheckIn);
      return;
    }

    const bookingDoc = bookingsSnap.docs[0];
    const bookingId = bookingDoc.id;
    const booking = bookingDoc.data();

    // 処理B-1: 人数不一致チェック
    const rosterGuestCount = Number(data.guestCount) || 0;
    const bookingGuestCount = Number(booking.guestCount) || 0;
    if (bookingGuestCount > 0 && rosterGuestCount !== bookingGuestCount) {
      const warnMsg = `⚠️ 名簿照合: 人数が異なります（予約: ${bookingGuestCount}名、名簿: ${rosterGuestCount}名）\n\nCI: ${rosterCheckIn}\n代表者: ${guestName}`;
      await db.collection("notifications").add({
        type: "roster_mismatch",
        title: `名簿照合警告: 人数不一致`,
        body: `人数が異なります（予約: ${bookingGuestCount}名、名簿: ${rosterGuestCount}名）`,
        guestId,
        bookingId,
        checkIn: rosterCheckIn,
        severity: "warning",
        createdAt: new Date(),
      });
      await notifyOwner(db, "roster_mismatch", "名簿照合警告: 人数不一致", warnMsg);
    }

    // 処理B-2: チェックアウト日不一致チェック
    if (rosterCheckOut && booking.checkOut && booking.checkOut !== rosterCheckOut) {
      const warnMsg = `⚠️ 名簿照合: チェックアウト日が異なります\n\n予約CO: ${booking.checkOut}\n名簿CO: ${rosterCheckOut}\n代表者: ${guestName}`;
      await db.collection("notifications").add({
        type: "roster_mismatch",
        title: `名簿照合警告: CO日不一致`,
        body: `チェックアウト日が異なります（予約: ${booking.checkOut}、名簿: ${rosterCheckOut}）`,
        guestId,
        bookingId,
        checkIn: rosterCheckIn,
        severity: "warning",
        createdAt: new Date(),
      });
      await notifyOwner(db, "roster_mismatch", "名簿照合警告: CO日不一致", warnMsg);
    }

    // 処理A: bookingへの情報補完（上書き）
    const bookingUpdate = {
      guestName: guestName,
      guestCount: rosterGuestCount || booking.guestCount,
      guestFormId: guestId,
      rosterStatus: "submitted",
    };
    if (data.nationality) bookingUpdate.nationality = data.nationality;
    if (data.phone) bookingUpdate.phone = data.phone;
    if (data.email) bookingUpdate.email = data.email;

    await db.collection("bookings").doc(bookingId).update(bookingUpdate);
    console.log(`booking補完完了: ${bookingId}`);

    // 処理C: guestRegistrationsにbookingIdを紐付け
    await docRef.update({ bookingId });
    console.log(`guestRegistrations bookingId記録完了: ${bookingId}`);

  } catch (e) {
    console.error("bookings照合処理エラー（名簿受信は成功済み）:", e.message);
  }
};
