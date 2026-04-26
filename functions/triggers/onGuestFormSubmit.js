/**
 * 宿泊者名簿受信トリガー
 * source=guest_form の場合:
 *   1. editToken生成・ステータス設定
 *   2. Webアプリ管理者にメール（入力内容全文）
 *   3. 宿泊者にメール（入力内容全文 + 修正リンク）
 *   4. LINE通知（既存）
 */
const crypto = require("crypto");
const { notifyOwner, notifyByKey, sendNotificationEmail_ } = require("../utils/lineNotify");
const { renderTemplate, buildGuestSummaryText, getTemplates } = require("../utils/emailTemplates");
// 注: 管理者宛/物件オーナー宛のメール送信は notifyOwner (roster_received) 1本に集約 (2026-04-26)
//   旧経路 (notifyEmails への直送、subOwners への直送) は重複送信(3通)の原因のため削除済み

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
  // 編集URLに propertyId を付与 (non-表示設定を適用させるため)
  const editUrl = `${APP_URL}/guest-form.html?edit=${editToken}${data.propertyId ? `&propertyId=${encodeURIComponent(data.propertyId)}` : ""}`;
  const confirmUrl = `${APP_URL}/#/guests?id=${encodeURIComponent(guestId)}`;

  const templates = await getTemplates(db);

  // 物件情報取得 (宿名/住所/ガイドURL/担当者メール)
  const { resolveGuideUrl } = require("../utils/guideMap");
  let propertyName = "";
  let propertyAddress = "";
  let guideUrlBase = "";
  if (data.propertyId) {
    try {
      const pDoc = await db.collection("properties").doc(data.propertyId).get();
      if (pDoc.exists) {
        const p = pDoc.data();
        propertyName = p.name || "";
        propertyAddress = p.address || "";
        guideUrlBase = resolveGuideUrl({ id: data.propertyId, guideUrl: p.guideUrl, guideUrlMode: p.guideUrlMode });
      }
    } catch (e) { console.error("物件情報取得エラー:", e.message); }
  }
  if (!propertyName) propertyName = data.propertyName || "";

  // ガイド URL に guest トークンを付加 (ガイドページ側で parkingAllocation 等を動的表示する用)
  // ガイド未設定なら空のまま (テンプレート側で空チェック想定)
  let guideUrl = "";
  if (guideUrlBase) {
    const sep = guideUrlBase.includes("?") ? "&" : "?";
    guideUrl = `${guideUrlBase}${sep}guest=${encodeURIComponent(editToken)}`;
  }

  // 送信者アドレス: 物件担当者 (物件オーナー最優先、なければ settings/notifications.ownerEmail)
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

  // 2a. 送信者 (sender) 解決 — 宿泊者宛メールの from に使う
  // 優先順位: 1) properties/{pid}.senderGmail (物件直結) > 2) 物件オーナー (staff.isSubOwner=true && ownedPropertyIds に pid 含む) > 3) staff.isOwner
  const pid = data.propertyId || "";
  let propertySenderGmail = "";
  if (pid) {
    try {
      const pDoc = await db.collection("properties").doc(pid).get();
      if (pDoc.exists) propertySenderGmail = (pDoc.data().senderGmail || "").trim();
    } catch (_) {}
  }
  let primarySubOwner = null;
  let staffOwnerEmail = "";
  let staffOwnerName = "";
  if (pid) {
    try {
      const staffSnap = await db.collection("staff").where("isSubOwner", "==", true).get();
      staffSnap.forEach((sDoc) => {
        if (primarySubOwner) return;
        const s = sDoc.data();
        const owned = Array.isArray(s.ownedPropertyIds) ? s.ownedPropertyIds : [];
        if (!owned.includes(pid)) return;
        if (s.email) primarySubOwner = { name: s.name || "(無名)", email: s.email };
      });
    } catch (e) {
      console.error("物件オーナー検索エラー:", e.message);
    }
  }
  try {
    const ownerSnap = await db.collection("staff").where("isOwner", "==", true).limit(1).get();
    if (!ownerSnap.empty) {
      const o = ownerSnap.docs[0].data();
      staffOwnerEmail = o.email || "";
      staffOwnerName = o.name || "";
    }
  } catch (_) {}

  const senderEmail = propertySenderGmail || (primarySubOwner && primarySubOwner.email) || staffOwnerEmail || "";
  const senderName = (primarySubOwner && primarySubOwner.name) || staffOwnerName || propertyName || "宿担当者";
  vars.senderEmail = senderEmail;
  vars.senderName = senderName;

  // 宿泊者宛メール件名を物件名入りで生成 (テンプレート変数 {propertyName} 経由)
  const guestSubjectOverride = propertyName
    ? `【${propertyName}】宿泊者名簿をお預かりしました／${guestName} 様`
    : null;
  const ownerSubjectOverride = propertyName
    ? `【${propertyName}】宿泊者名簿が届きました`
    : null;
  // 注: ownerSubjectOverride は廃止 (管理者宛メールは notifyOwner に集約)
  void ownerSubjectOverride;

  // 2b. 宿泊者へのメール (from = 物件担当者、アプリ管理者にはフォールバックしない)
  // 物件別 formCompleteMail.{enabled,subject,body} のみ参照 (グローバル設定は参照しない)
  // - enabled === false なら送信スキップ (default は送信)
  // - subject / body 未入力ならビルトインのデフォルト件名・本文を使用
  let propFormCompleteMail = null;
  if (data.propertyId) {
    try {
      const pDoc = await db.collection("properties").doc(data.propertyId).get();
      if (pDoc.exists) propFormCompleteMail = (pDoc.data() || {}).formCompleteMail || null;
    } catch (_) {}
  }
  // この物件は完了メール送信を OFF にしている
  if (propFormCompleteMail && propFormCompleteMail.enabled === false) {
    console.log(`[onGuestFormSubmit] formCompleteMail.enabled=false のため完了メール送信スキップ`);
  } else if (guestEmail) {
    if (!senderEmail) {
      const errMsg = "物件担当者 (staff.isSubOwner / isOwner) のメールが未設定のため宿泊者宛メールをスキップ";
      console.warn(errMsg);
      try {
        await db.collection("guestRegistrations").doc(guestId).update({
          formCompleteMailError: errMsg,
          formCompleteMailErrorAt: new Date(),
        });
        await notifyByKey(db, "form_complete_mail_failed", {
          title: `完了メール送信失敗: ${guestName}`,
          body: `物件: ${propertyName}\nゲスト: ${guestName} (${guestEmail})\nエラー: ${errMsg}`,
          vars: { property: propertyName, guest: guestName, email: guestEmail, error: errMsg },
          propertyId: data.propertyId || null,
        });
      } catch (e2) { console.error("失敗通知の保存/送信エラー:", e2.message); }
    } else {
      try {
        // ビルトインデフォルト (グローバル settings.notifications は参照しない)
        const DEFAULT_SUBJECT = `【{propertyName}】宿泊者名簿をお預かりしました／{guestName} 様`;
        const DEFAULT_BODY = [
          `{guestName} 様`,
          ``,
          `この度は{propertyName}にご予約いただきありがとうございます。`,
          `宿泊者名簿のご記入をお預かりしました。`,
          ``,
          `■ ご宿泊情報`,
          `チェックイン: {checkIn}`,
          `チェックアウト: {checkOut}`,
          `ご人数: {guestCount} 名`,
          ``,
          `名簿の編集が必要な場合は、下記リンクから修正してください。`,
          `{editUrl}`,
          ``,
          `ご質問等ございましたらこちらのメールに返信ください。`,
        ].join("\n");

        const renderSingle = (tmpl) => String(tmpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
        const renderDouble = (tmpl) => String(tmpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
        const subjectTmpl = (propFormCompleteMail && propFormCompleteMail.subject) ? propFormCompleteMail.subject : "";
        const bodyTmpl    = (propFormCompleteMail && propFormCompleteMail.body)    ? propFormCompleteMail.body    : "";
        const guestSubject = subjectTmpl ? renderDouble(subjectTmpl) : renderSingle(DEFAULT_SUBJECT);
        const guestBody    = bodyTmpl    ? renderDouble(bodyTmpl)    : renderSingle(DEFAULT_BODY);
        // strictFrom: 担当者 Gmail が連携されていなければ送信しない (アプリ管理者から送らない)
        await sendNotificationEmail_(guestEmail, guestSubject, guestBody, senderEmail, { strictFrom: true });
        console.log(`宿泊者メール送信成功: ${guestEmail} (from=${senderEmail})`);
        try {
          await db.collection("guestRegistrations").doc(guestId).update({
            formCompleteMailSentAt: new Date(),
            formCompleteMailError: admin.firestore.FieldValue.delete(),
          });
        } catch (_) {}
      } catch (e) {
        console.error(`宿泊者メール送信失敗 (${guestEmail}):`, e.message);
        try {
          await db.collection("guestRegistrations").doc(guestId).update({
            formCompleteMailError: e.message || "送信失敗",
            formCompleteMailErrorAt: new Date(),
          });
          await notifyByKey(db, "form_complete_mail_failed", {
            title: `完了メール送信失敗: ${guestName}`,
            body: `物件: ${propertyName}\nゲスト: ${guestName} (${guestEmail})\nエラー: ${e.message}`,
            vars: { property: propertyName, guest: guestName, email: guestEmail, error: e.message || "" },
            propertyId: data.propertyId || null,
          });
        } catch (e2) { console.error("失敗通知の保存/送信エラー:", e2.message); }
      }
    }
  } else {
    const errMsg = "宿泊者のメールアドレスが未入力のためメール送信スキップ";
    console.warn(errMsg);
    try {
      await db.collection("guestRegistrations").doc(guestId).update({
        formCompleteMailError: errMsg,
        formCompleteMailErrorAt: new Date(),
      });
      await notifyByKey(db, "form_complete_mail_failed", {
        title: `完了メール送信失敗: ${guestName}`,
        body: `物件: ${propertyName}\nゲスト: ${guestName}\nエラー: ${errMsg}`,
        vars: { property: propertyName, guest: guestName, email: "(未入力)", error: errMsg },
        propertyId: data.propertyId || null,
      });
    } catch (e2) { console.error("失敗通知の保存/送信エラー:", e2.message); }
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
  // notifyByKey でチャネル別 (ownerLine/groupLine/staffLine/ownerEmail/...) に発射
  await notifyByKey(db, "roster_received", {
    title: `名簿受信: ${guestName}`,
    body: lineText,
    vars: {
      checkin: checkIn,
      date: checkOut,
      property: data.propertyName || "",
      guest: guestName,
      nights: data.nights || "",
      site: data.bookingSite || "",
      url: `${APP_URL}/#/guests?id=${encodeURIComponent(guestId)}`,
    },
    propertyId: data.propertyId || null,
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
