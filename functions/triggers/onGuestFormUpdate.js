/**
 * 宿泊者名簿 更新トリガー (onUpdate)
 * 宿泊者が修正リンクから再送信した場合 (source=guest_form, status=submitted のまま更新):
 *   1. 差分計算 (ゲスト入力フィールドのみ比較)
 *   2. 宿泊者宛に修正完了サンクスメール (form_update_mail)
 *   3. Webアプリ管理者に更新通知 (roster_updated)
 *
 * 重複発火防止:
 *   - ゲスト入力フィールドに変更がない場合はスキップ
 *   - formUpdateMailSentAt で1分以内の再発火を抑制
 */
const { notifyByKey, sendNotificationEmail_ } = require("../utils/lineNotify");
const { notifyPaidParking, parseCars } = require("../utils/paidParkingNotify");

// ゲストが実際に入力するフィールドのみ (システムフィールド変更では発火しない)
const GUEST_INPUT_FIELDS = [
  "guestName", "email", "phone", "address", "nationality", "purpose",
  "checkIn", "checkOut", "checkInTime", "checkOutTime", "guestCount",
  "guestCountInfants", "guests", "bbq", "parking", "memo",
  "bookingSite", "transport", "carCount", "paidParking",
  "passportNumber", "age", "bedChoice", "previousStay", "nextStay",
  "emergencyName", "emergencyPhone",
];

// ゲスト入力フィールドに変更があるか判定
function hasGuestChanges(before, after) {
  return GUEST_INPUT_FIELDS.some(f => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

const APP_URL = "https://v2-5-relay.web.app";

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

// 全フィールドの英語ラベルマッピング (英語メールの差分表示用)
const FIELD_LABELS_EN = {
  guestName:       "Representative name",
  nationality:     "Nationality",
  address:         "Address",
  age:             "Representative age",
  phone:           "Phone",
  email:           "Email",
  passportNumber:  "Passport number",
  purpose:         "Purpose of trip",
  checkIn:         "Check-in date",
  checkOut:        "Check-out date",
  guestCount:      "Number of guests",
  guestCountInfants: "Infants",
  bookingSite:     "Booking site",
  transport:       "Transportation",
  carCount:        "Number of cars",
  bbq:             "BBQ",
  bedChoice:       "Bed choice",
  previousStay:    "Previous stay",
  nextStay:        "Next stay",
  emergencyName:   "Emergency contact name",
  emergencyPhone:  "Emergency contact phone",
};

// スカラーフィールドの差分を計算してテキストで返す。
// opts で言語別ラベル/空表記/見出しを差し替えられる(既定=日本語)。
function calcChanges(before, after, opts = {}) {
  const labels      = opts.labels      || FIELD_LABELS;
  const guestLabels = opts.guestLabels || { name: "氏名", nationality: "国籍", address: "住所", age: "年齢", passportNumber: "旅券番号" };
  const emptyVal    = opts.emptyVal    || "(空)";
  const noChange    = opts.noChange    || "(変更なし)";
  const guestHead   = opts.guestHead   || ((n, gl) => `宿泊者${n}の${gl}`);
  const lines = [];

  // スカラーフィールド比較
  for (const [field, label] of Object.entries(labels)) {
    const bv = String(before[field] ?? "").trim();
    const av = String(after[field] ?? "").trim();
    if (bv !== av) {
      lines.push(`${label}: ${bv || emptyVal} → ${av || emptyVal}`);
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
    for (const [gf, gl] of Object.entries(guestLabels)) {
      const bv = String(bGuest[gf] ?? "").trim();
      const av = String(aGuest[gf] ?? "").trim();
      if (bv !== av) {
        lines.push(`${guestHead(n, gl)}: ${bv || emptyVal} → ${av || emptyVal}`);
      }
    }
  }

  return lines.length ? lines.join("\n") : noChange;
}

// 英語差分テキスト
function calcChangesEn(before, after) {
  return calcChanges(before, after, {
    labels: FIELD_LABELS_EN,
    guestLabels: { name: "Name", nationality: "Nationality", address: "Address", age: "Age", passportNumber: "Passport number" },
    emptyVal: "(empty)",
    noChange: "(no changes)",
    guestHead: (n, gl) => `Guest ${n} - ${gl}`,
  });
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
  if (!before.editToken && after.editToken) return;

  // 管理者操作で書き換えた場合の通知抑止 (after に _skipNotifyUpdate=true があれば skip)
  // 抑止フラグはこの判定後にトリガー側で削除しない (再発火対策で1回限り)
  if (after._skipNotifyUpdate === true) {
    console.log("[onGuestFormUpdate] _skipNotifyUpdate=true のため通知スキップ");
    return;
  }

  // ゲスト入力フィールドに変更がなければシステムフィールド更新 → スキップ
  if (!hasGuestChanges(before, after)) {
    console.log("[onGuestFormUpdate] ゲスト入力フィールドに変更なし — スキップ");
    return;
  }

  // 1分以内に既に送信済みなら重複発火防止 (formCompleteMailSentAt 等の連続 update 対策)
  if (after.formUpdateMailSentAt) {
    const sentAt = after.formUpdateMailSentAt.toDate
      ? after.formUpdateMailSentAt.toDate()
      : new Date(after.formUpdateMailSentAt);
    if (Date.now() - sentAt.getTime() < 60 * 1000) {
      console.log("[onGuestFormUpdate] 1分以内に送信済み — 重複発火スキップ");
      return;
    }
  }

  const docRef = event.data.after.ref;
  const guestId = event.params?.guestId || docRef.id;

  const guestName  = after.guestName  || "名前不明";
  const checkIn    = after.checkIn    || "?";
  const checkOut   = after.checkOut   || "?";
  const guestCount = after.guestCount || "?";
  const guestEmail = after.email || "";

  // 差分計算
  const changes = calcChanges(before, after);

  // editHistory[] 追記用の変更行を先に計算 (gmailId は後工程で付加)
  const changeLines = String(changes || "").split("\n").map((s) => s.trim()).filter(Boolean);

  const confirmUrl = `${APP_URL}/#/guests?id=${encodeURIComponent(guestId)}`;
  const editUrl = after.editToken
    ? `${APP_URL}/guest-form.html?edit=${after.editToken}${after.propertyId ? `&propertyId=${encodeURIComponent(after.propertyId)}` : ""}`
    : "";

  // 物件情報取得
  const { resolveGuideUrl, buildGuideUrlBlock } = require("../utils/guideMap");
  let propertyName    = after.propertyName || "";
  let propertyAddress = "";
  let guideUrlBase    = "";
  if (after.propertyId) {
    try {
      const pDoc = await db.collection("properties").doc(after.propertyId).get();
      if (pDoc.exists) {
        const p = pDoc.data();
        if (!propertyName) propertyName = p.name || "";
        propertyAddress = p.address || "";
        guideUrlBase = resolveGuideUrl({ id: after.propertyId, guideUrl: p.guideUrl, guideUrlMode: p.guideUrlMode });
      }
    } catch (e) { console.error("物件情報取得エラー:", e.message); }
  }

  // ガイドURLにeditTokenを付加
  let guideUrlWithToken = "";
  if (guideUrlBase) {
    const sep = guideUrlBase.includes("?") ? "&" : "?";
    guideUrlWithToken = `${guideUrlBase}${sep}guest=${encodeURIComponent(after.editToken || "")}`;
  }
  // 現行URLの下に退避用(リレーアプリ)URLのフォールバックを併記。日本語/英語でラベルを出し分ける。
  const guideUrl   = buildGuideUrlBlock(guideUrlWithToken);
  const guideUrlEn = buildGuideUrlBlock(guideUrlWithToken, "en");

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

  // 英訳用フォーマット (例: Mon, Jun 29, 2026 15:00)
  function formatDateWithDayEn(dateStr, timeStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const base = `${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
    return timeStr ? `${base} ${timeStr}` : base;
  }

  const vars = {
    guestName, checkIn, checkOut, guestCount,
    checkInFormatted: formatDateWithDay(checkIn, after.checkInTime || ""),
    checkOutFormatted: formatDateWithDay(checkOut, after.checkOutTime || ""),
    propertyName, propertyAddress, addressMapUrl, guideUrl,
    changes, confirmUrl, editUrl,
  };

  // 英語本文(subjectEn/bodyEn)描画用。和式日付・日本語ガイドラベル・日本語差分を英語版に差し替える。
  const varsEn = {
    ...vars,
    checkInFormatted:  formatDateWithDayEn(checkIn, after.checkInTime || ""),
    checkOutFormatted: formatDateWithDayEn(checkOut, after.checkOutTime || ""),
    guideUrl:          guideUrlEn,
    changes:           calcChangesEn(before, after),
  };

  const renderDouble = (tmpl) =>
    String(tmpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  // 英語本文は varsEn で描画する
  const renderDoubleEn = (tmpl) =>
    String(tmpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (varsEn[k] != null ? String(varsEn[k]) : ""));

  // editHistory 追記済みフラグ (メール送信の成否・スキップ問わず必ず1回だけ追記する)
  let editHistoryWritten = false;

  // editHistory エントリ生成ヘルパー (gmailId はオプション)
  function buildHistoryEntry(gmailId) {
    const entry = {
      editedAt: admin.firestore.Timestamp.now(),
      changes: changeLines.slice(0, 20), // 1 回あたり最大 20 件
      summary: changeLines.length > 20 ? `${changeLines.length}件の変更` : "",
    };
    if (gmailId) {
      // 修正完了メールの Gmail messageId → 「Gmailで開く」リンクに使用
      entry.gmailId = gmailId;
    }
    return entry;
  }

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
          `■ ゲスト案内ページ`,
          `{guideUrl}`,
          ``,
          `ご質問等ございましたら、本メールにご返信ください。`,
          `何卒よろしくお願い申し上げます。`,
        ].join("\n");

        const renderSingle = (tmpl) => String(tmpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));

        const subjectTmpl = (propUpdateMail && propUpdateMail.subject) ? propUpdateMail.subject : "";
        const bodyTmpl    = (propUpdateMail && propUpdateMail.body)    ? propUpdateMail.body    : "";
        const subject = subjectTmpl ? renderDouble(subjectTmpl) : renderSingle(DEFAULT_SUBJECT);
        const body    = bodyTmpl    ? renderDouble(bodyTmpl)    : renderSingle(DEFAULT_BODY);
        // 英訳併記 (formUpdateMail.subjectEn / bodyEn)
        const subjectEnTmpl = (propUpdateMail && propUpdateMail.subjectEn) ? propUpdateMail.subjectEn : "";
        const bodyEnTmpl    = (propUpdateMail && propUpdateMail.bodyEn)    ? propUpdateMail.bodyEn    : "";
        const subjectEn = subjectEnTmpl ? renderDoubleEn(subjectEnTmpl) : "";
        const bodyEn    = bodyEnTmpl    ? renderDoubleEn(bodyEnTmpl)    : "";
        const finalSubject = subjectEn ? `${subject} / ${subjectEn}` : subject;
        const finalBody    = bodyEn
          ? `${body}\n\n--------------------------------\n--- English follows ---\n--------------------------------\n\n${bodyEn}`
          : body;

        const updateSendResult = await sendNotificationEmail_(guestEmail, finalSubject, finalBody, senderEmail, { strictFrom: true });
        console.log(`名簿更新 宿泊者メール送信成功: ${guestEmail}`);
        // 送信済み記録 + editHistory 追記 (重複発火防止 + Gmailリンク用gmailId保存)
        try {
          const gmailId = updateSendResult && updateSendResult.messageId ? updateSendResult.messageId : null;
          await event.data.after.ref.update({
            formUpdateMailSentAt: new Date(),
            editHistory: admin.firestore.FieldValue.arrayUnion(buildHistoryEntry(gmailId)),
          });
          editHistoryWritten = true;
        } catch (_) {}
      } catch (e) {
        console.error(`名簿更新 宿泊者メール送信失敗 (${guestEmail}):`, e.message);
        // メール送信失敗時も editHistory は追記する (gmailId なし)
        try {
          await event.data.after.ref.update({
            editHistory: admin.firestore.FieldValue.arrayUnion(buildHistoryEntry(null)),
          });
          editHistoryWritten = true;
        } catch (_) {}
      }
    }
  }

  // メール未送信ケース (guestEmail なし / updateMailEnabled=false / senderEmail 未設定) は
  // 上のブロックで editHistory が追記されないため、ここで追記する
  if (!editHistoryWritten) {
    try {
      await event.data.after.ref.update({
        editHistory: admin.firestore.FieldValue.arrayUnion(buildHistoryEntry(null)),
      });
    } catch (e) {
      console.warn("[onGuestFormUpdate] editHistory 追記失敗 (メール未送信ケース):", e.message);
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

  // === 3. 有料駐車場 利用通知 (修正で 1台/2台 に変わった場合のみ。submit と二重送信しない) ===
  try {
    const carsBefore = parseCars(before && before.paidParking);
    const carsAfter  = parseCars(after && after.paidParking);
    if (carsAfter > 0 && carsAfter !== carsBefore) {
      const ppResult = await notifyPaidParking(db, after, after.propertyId);
      if (ppResult) {
        console.log(`[paid_parking_notify] (更新) sent=${JSON.stringify(ppResult.sent || {})}`);
      }
    }
  } catch (e) {
    console.warn("[paid_parking_notify] (更新) 送信失敗:", e.message);
  }
};
