/**
 * 宿泊者名簿 更新トリガー (onUpdate)
 * 宿泊者が修正リンクから再送信した場合 (source=guest_form, status=submitted のまま更新):
 *   1. 差分計算 (全フィールド比較)
 *   2. 宿泊者宛に修正完了サンクスメール (form_update_mail)
 *   3. Webアプリ管理者に更新通知 (roster_updated)
 */
const { notifyByKey, sendNotificationEmail_ } = require("../utils/lineNotify");

const APP_URL = "https://minpaku-v2.web.app";

// 全フィールドの日本語ラベルマッピング
const FIELD_LABELS = {
  guestName:       "代表者氏名",
  nationality:     "国籍",
  address:         "住所",
  age:             "代表者年齢",
  phone:           "電話番号",
  email:           "メールアドレス",
  passportNumber:  "旅券番号",
  purpose:         "旅の目的",
  checkIn:         "チェックイン日",
  checkOut:        "チェックアウト日",
  guestCount:      "宿泊人数",
  guestCountInfants: "乳幼児数",
  bookingSite:     "予約サイト",
  transport:       "交通手段",
  carCount:        "車台数",
  bbq:             "BBQ利用",
  bedChoice:       "ベッド選択",
  previousStay:    "前泊",
  nextStay:        "後泊",
  emergencyName:   "緊急連絡先氏名",
  emergencyPhone:  "緊急連絡先電話",
};

// スカラーフィールドの差分を計算してテキストで返す
function calcChanges(before, after) {
  const lines = [];

  // スカラーフィールド比較
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const bv = String(before[field] ?? "").trim();
    const av = String(after[field] ?? "").trim();
    if (bv !== av) {
      lines.push(`${label}: ${bv || "(空)"} → ${av || "(空)"}`);
    }
  }

  // 同行者 (guests[]) の差分
  const bg = Array.isArray(before.guests) ? before.guests : [];
  const ag = Array.isArray(after.guests)  ? after.guests  : [];
  const maxLen = Math.max(bg.length, ag.length);
  for (let i = 0; i < maxLen; i++) {
    const bGuest = bg[i] || {};
    const aGuest = ag[i] || {};
    const n = i + 2; // 宿泊者2〜
    const guestLabels = { name: "氏名", nationality: "国籍", address: "住所", age: "年齢", passportNumber: "旅券番号" };
    for (const [gf, gl] of Object.entries(guestLabels)) {
      const bv = String(bGuest[gf] ?? "").trim();
      const av = String(aGuest[gf] ?? "").trim();
      if (bv !== av) {
        lines.push(`宿泊者${n}の${gl}: ${bv || "(空)"} → ${av || "(空)"}`);
      }
    }
  }

  return lines.length ? lines.join("\n") : "(変更なし)";
}

module.exports = async function onGuestFormUpdate(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const before = event.data?.before?.data();
  const after  = event.data?.after?.data();
  if (!before || !after) return;

  // source=guest_form、status=submitted の更新のみ処理
  if (after.source !== "guest_form") return;
  if (after.status !== "submitted")  return;

  // 初回 onCreate の直後 (editToken がなかった→今付いた) は更新通知をスキップ
  // (onCreate で editToken を付与する update があるため)
  if (!before.editToken && after.editToken) return;

  const docRef = event.data.after.ref;
  const guestId = event.params?.guestId || docRef.id;

  const guestName  = after.guestName  || "名前不明";
  const checkIn    = after.checkIn    || "?";
  const checkOut   = after.checkOut   || "?";
  const guestCount = after.guestCount || "?";
  const guestEmail = after.email || "";

  // 差分計算
  const changes = calcChanges(before, after);
  const confirmUrl = `${APP_URL}/#/guests?id=${encodeURIComponent(guestId)}`;
  const editUrl = after.editToken
    ? `${APP_URL}/guest-form.html?edit=${after.editToken}${after.propertyId ? `&propertyId=${encodeURIComponent(after.propertyId)}` : ""}`
    : "";

  // 物件情報取得
  let propertyName    = after.propertyName || "";
  let propertyAddress = "";
  if (after.propertyId) {
    try {
      const pDoc = await db.collection("properties").doc(after.propertyId).get();
      if (pDoc.exists) {
        const p = pDoc.data();
        if (!propertyName) propertyName = p.name || "";
        propertyAddress = p.address || "";
      }
    } catch (e) { console.error("物件情報取得エラー:", e.message); }
  }

  const addressMapUrl = propertyAddress
    ? "https://maps.google.com/?q=" + encodeURIComponent(propertyAddress)
    : "";

  // 送信者 (owner/sub-owner) 解決
  const pid = after.propertyId || "";
  let senderEmail = "";
  let senderName  = "宿担当者";
  if (pid) {
    try {
      const pDoc = await db.collection("properties").doc(pid).get();
      if (pDoc.exists) senderEmail = (pDoc.data().senderGmail || "").trim();
    } catch (_) {}
    if (!senderEmail) {
      try {
        const staffSnap = await db.collection("staff").where("isSubOwner", "==", true).get();
        staffSnap.forEach(sDoc => {
          if (senderEmail) return;
          const s = sDoc.data();
          if ((s.ownedPropertyIds || []).includes(pid) && s.email) {
            senderEmail = s.email;
            senderName  = s.name || senderName;
          }
        });
      } catch (_) {}
    }
  }
  if (!senderEmail) {
    try {
      const ownerSnap = await db.collection("staff").where("isOwner", "==", true).limit(1).get();
      if (!ownerSnap.empty) {
        const o = ownerSnap.docs[0].data();
        senderEmail = o.email || "";
        senderName  = o.name  || senderName;
      }
    } catch (_) {}
  }

  // 曜日+時刻付きフォーマット (例: 2026年4月29日(火) 15:00)
  function formatDateWithDay(dateStr, timeStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const DOW = ["日", "月", "火", "水", "木", "金", "土"];
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const dow = DOW[d.getUTCDay()];
    const base = `${y}年${m}月${day}日(${dow})`;
    return timeStr ? `${base} ${timeStr}` : base;
  }

  const vars = {
    guestName, checkIn, checkOut, guestCount,
    checkInFormatted: formatDateWithDay(checkIn, after.checkInTime || ""),
    checkOutFormatted: formatDateWithDay(checkOut, after.checkOutTime || ""),
    propertyName, propertyAddress, addressMapUrl,
    changes, confirmUrl, editUrl,
  };

  const renderDouble = (tmpl) =>
    String(tmpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));

  // === 1. 宿泊者宛 修正完了サンクスメール ===
  if (guestEmail) {
    let propUpdateMail = null;
    if (after.propertyId) {
      try {
        const pDoc = await db.collection("properties").doc(after.propertyId).get();
        if (pDoc.exists) propUpdateMail = (pDoc.data() || {}).formUpdateMail || null;
      } catch (_) {}
    }

    // enabled === false の場合はスキップ
    const updateMailEnabled = propUpdateMail ? propUpdateMail.enabled !== false : true;
    if (updateMailEnabled && senderEmail) {
      try {
        const DEFAULT_SUBJECT = `【{propertyName}】宿泊者名簿の修正を受け付けました／{guestName} 様`;
        const DEFAULT_BODY = [
          `{guestName} 様`,
          ``,
          `いつもお世話になっております。{propertyName} です。`,
          ``,
          `宿泊者名簿のご修正、誠にありがとうございます。`,
          `ご登録内容を承りました。`,
          ``,
          `■ ご宿泊情報`,
          `チェックイン: {checkInFormatted}`,
          `チェックアウト: {checkOutFormatted}`,
          `ご人数: {guestCount} 名`,
          `住所: {propertyAddress}`,
          `地図: {addressMapUrl}`,
          ``,
          `■ 変更内容`,
          `{changes}`,
          ``,
          `再度ご修正の必要がございましたら、下記リンクよりお手続きください。`,
          `{editUrl}`,
          ``,
          `ご質問等ございましたら、本メールにご返信ください。`,
          `何卒よろしくお願い申し上げます。`,
        ].join("\n");

        const renderSingle = (tmpl) => String(tmpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));

        const subjectTmpl = (propUpdateMail && propUpdateMail.subject) ? propUpdateMail.subject : "";
        const bodyTmpl    = (propUpdateMail && propUpdateMail.body)    ? propUpdateMail.body    : "";
        const subject = subjectTmpl ? renderDouble(subjectTmpl) : renderSingle(DEFAULT_SUBJECT);
        const body    = bodyTmpl    ? renderDouble(bodyTmpl)    : renderSingle(DEFAULT_BODY);

        await sendNotificationEmail_(guestEmail, subject, body, senderEmail, { strictFrom: true });
        console.log(`名簿更新 宿泊者メール送信成功: ${guestEmail}`);
      } catch (e) {
        console.error(`名簿更新 宿泊者メール送信失敗 (${guestEmail}):`, e.message);
      }
    }
  }

  // === 2. Webアプリ管理者宛 更新通知 (roster_updated) ===
  try {
    await notifyByKey(db, "roster_updated", {
      title: `名簿更新: ${guestName}`,
      body: `📝 宿泊者名簿が更新されました\n\n代表者: ${guestName}\nCI: ${checkIn}\n\n変更内容:\n${changes}\n\n確認: ${confirmUrl}`,
      vars: {
        checkin:  checkIn,
        property: propertyName,
        guest:    guestName,
        changes,
        url:      confirmUrl,
      },
      propertyId: after.propertyId || null,
    });
  } catch (e) {
    console.error("roster_updated 通知送信エラー:", e.message);
  }
};
