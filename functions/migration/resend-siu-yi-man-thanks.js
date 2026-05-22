#!/usr/bin/env node
// Siu Yi Man さんへサンクスメール再送 (お詫び付き 日英併記)
// + properties/{the Terrace 長浜}.formCompleteMail.{subjectEn,bodyEn} に英訳テンプレ保存
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { sendNotificationEmail_ } = require("../utils/lineNotify");

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

const PID = "tsZybhDMcPrxqgcRy7wp";
const GUEST_ID = "q4OcUOra3hqhppJ6Y154";

const SUBJECT_EN_TEMPLATE = "Thank you for completing your guest registration for {{propertyName}} / Mr./Ms. {{guestName}}";
const BODY_EN_TEMPLATE = [
  "Dear {{guestName}},",
  "",
  "Thank you very much for your reservation at {{propertyName}}.",
  "We have received your guest registration successfully.",
  "",
  "■ Stay Information",
  "Check-in: {{checkInFormatted}}",
  "Check-out: {{checkOutFormatted}}",
  "Number of guests: {{guestCount}}",
  "Address: {{propertyAddress}}",
  "Map: {{addressMapUrl}}",
  "",
  "If you need to update any information, please use the link below:",
  "{{editUrl}}",
  "",
  "We will send you another email with the keybox code and property access instructions one day before or on the day of your check-in.",
  "We look forward to welcoming you and wish you a pleasant stay.",
  "",
  "■ Guest Information Page",
  "{{guideUrl}}",
  "",
  "If you have any questions, please feel free to reply to this email.",
  "Thank you very much, and best regards.",
].join("\n");

(async () => {
  // 1. properties に subjectEn / bodyEn を保存
  console.log("\n=== Step 1: properties.formCompleteMail.{subjectEn,bodyEn} を保存 ===");
  const propRef = db.collection("properties").doc(PID);
  if (isExecute) {
    await propRef.set({
      formCompleteMail: {
        subjectEn: SUBJECT_EN_TEMPLATE,
        bodyEn: BODY_EN_TEMPLATE,
      },
    }, { merge: true });
    console.log("  ✅ 保存完了");
  } else {
    console.log("  (dry-run) 以下を保存予定:");
    console.log("    subjectEn:", SUBJECT_EN_TEMPLATE);
    console.log("    bodyEn 行数:", BODY_EN_TEMPLATE.split("\n").length);
  }

  // 2. Siu Yi Man さん用メール本文を組み立てて送信
  console.log("\n=== Step 2: Siu Yi Man さんへ再送 ===");
  const gd = await db.collection("guestRegistrations").doc(GUEST_ID).get();
  const g = gd.data();
  const pd = await propRef.get();
  const p = pd.data();
  const propertyName = p.name || "";
  const propertyAddress = p.address || "";
  const addressMapUrl = `https://maps.google.com/?q=${encodeURIComponent(propertyAddress)}`;
  const editUrl = `https://minpaku-v2.web.app/guest-form.html?edit=${g.editToken}&openExternalBrowser=1`;
  const guideUrl = p.guideUrl || "https://minpaku-v2.web.app/guest-guide.html";

  const fmtDate = (ymd, t) => {
    const [y, m, d] = ymd.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const dow = ["日", "月", "火", "水", "木", "金", "土"][date.getUTCDay()];
    return t ? `${y}年${m}月${d}日(${dow}) ${t}` : `${y}年${m}月${d}日(${dow})`;
  };
  const fmtDateEn = (ymd, t) => {
    const [y, m, d] = ymd.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const dow = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
    const mon = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1];
    return t ? `${dow}, ${mon} ${d}, ${y}, ${t}` : `${dow}, ${mon} ${d}, ${y}`;
  };

  const checkInFormatted = fmtDate(g.checkIn, g.checkInTime || "");
  const checkOutFormatted = fmtDate(g.checkOut, g.checkOutTime || "");
  const checkInFormattedEn = fmtDateEn(g.checkIn, g.checkInTime || "");
  const checkOutFormattedEn = fmtDateEn(g.checkOut, g.checkOutTime || "");

  const apologyJa = [
    `${g.guestName} 様`,
    ``,
    `先日、宿泊者名簿ご登録の確認メールをお送りいたしましたが、`,
    `システムの不具合により、施設名・住所・地図情報が欠落した状態で送信されてしまいました。`,
    `ご不便をおかけし、誠に申し訳ございません。`,
    `改めて完全版を以下にてお送りいたしますので、ご確認のほどよろしくお願いいたします。`,
    ``,
    `──────────────────`,
    ``,
  ].join("\n");

  const mainJa = [
    `いつもお世話になっております。${propertyName} です。`,
    ``,
    `この度はご予約いただき、誠にありがとうございます。`,
    `宿泊者名簿のご登録を承りました。`,
    ``,
    `■ ご宿泊情報`,
    `チェックイン: ${checkInFormatted}`,
    `チェックアウト: ${checkOutFormatted}`,
    `ご人数: ${g.guestCount} 名`,
    `住所: ${propertyAddress}`,
    `地図: ${addressMapUrl}`,
    ``,
    `ご記入内容に修正が必要な場合は、下記リンクよりお手続きください。`,
    editUrl,
    ``,
    `チェックイン前日〜当日にかけて、キーボックス番号や施設のご案内に関するメールを別途お送りいたします。`,
    `楽しいご滞在となりますよう、心よりお待ちしております。`,
    ``,
    `■ ゲスト案内ページ`,
    guideUrl,
    ``,
    `ご質問等ございましたら、本メールにご返信ください。`,
    `何卒よろしくお願い申し上げます。`,
  ].join("\n");

  const apologyEn = [
    `Dear ${g.guestName},`,
    ``,
    `We previously sent you a confirmation email for your guest registration.`,
    `However, due to a system error, the property name, address, and map information were missing from that email.`,
    `We sincerely apologize for the inconvenience caused.`,
    `Please find the complete version below.`,
    ``,
    `──────────────────`,
    ``,
  ].join("\n");

  const mainEn = [
    `Thank you very much for your reservation at ${propertyName}.`,
    `We have received your guest registration successfully.`,
    ``,
    `■ Stay Information`,
    `Check-in: ${checkInFormattedEn}`,
    `Check-out: ${checkOutFormattedEn}`,
    `Number of guests: ${g.guestCount}`,
    `Address: 5-14-6 Hironagahama, Kure City, Hiroshima Prefecture, Japan`,
    `Map: ${addressMapUrl}`,
    ``,
    `If you need to update any information, please use the link below:`,
    editUrl,
    ``,
    `We will send you another email with the keybox code and property access instructions one day before or on the day of your check-in.`,
    `We look forward to welcoming you and wish you a pleasant stay.`,
    ``,
    `■ Guest Information Page`,
    guideUrl,
    ``,
    `If you have any questions, please feel free to reply to this email.`,
    `Thank you very much, and best regards.`,
  ].join("\n");

  const subject = `【${propertyName}】宿泊者名簿ご登録の確認メール 再送のお詫びと再送信／${g.guestName} 様 / Apology and Resend: Guest Registration Confirmation - ${propertyName} / Mr./Ms. ${g.guestName}`;
  const body = `${apologyJa}${mainJa}\n\n────────────────────────────────\n--- English follows ---\n────────────────────────────────\n\n${apologyEn}${mainEn}`;

  console.log(`  To: ${g.email}`);
  console.log(`  From: ${p.senderGmail}`);
  console.log(`  Subject: ${subject.slice(0, 80)}...`);
  console.log(`  Body 行数: ${body.split("\n").length}`);

  if (!isExecute) {
    console.log("\n(dry-run) 実際の送信は --execute で");
    process.exit(0);
  }
  const result = await sendNotificationEmail_(g.email, subject, body, p.senderGmail, { strictFrom: true });
  console.log("\n=== 送信結果 ===");
  console.log(JSON.stringify(result, null, 2));
  // 送信履歴も保存
  await db.collection("guestRegistrations").doc(GUEST_ID).update({
    formCompleteMailResentAt: new Date(),
    formCompleteMailResentNote: "管理者操作: 前回メールに物件情報欠落のため再送 (お詫び付き)",
  });
  console.log("\n✅ 完了");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
