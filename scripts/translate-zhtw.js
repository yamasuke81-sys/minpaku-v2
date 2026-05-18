#!/usr/bin/env node
// items を日本語から繁体字中国語 (台湾華語) に翻訳
// 入力: { items: [...] } stdin
// 出力: { "zh-TW": [...] } stdout
const path = require("path");
const fs = require("fs");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function getApiKey() {
  const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
  if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
  const doc = await admin.firestore().collection("settings").doc("scanSorter").get();
  const k = doc.data()?.geminiApiKey;
  if (!k) throw new Error("settings/scanSorter.geminiApiKey が未設定");
  return k;
}

function buildPrompt(items) {
  return [
    "次の日本語テキスト配列を 台湾華語 (繁體中文 / 台湾で使われる中国語) に翻訳してください。",
    "出力は厳密に JSON 配列のみ。配列長と順序は入力と同一にする。",
    "厳守ルール:",
    "1. 文字は 繁體字 を使用 (簡体字は使わない)",
    "2. 用語は 台湾の標準的な語彙 を使う (大陸用語は避ける)",
    "   例: 信息→資訊 / 软件→軟體 / 网络→網路 / 出租→出租(同) / 优惠→優惠",
    "3. {{xxx}} / {xxx} の形のプレースホルダは絶対に翻訳せず、そのまま保持",
    "4. HTML タグ (<span>, <br>, <strong>, バッジ class 等) は構造を保持し、内側のテキストだけを翻訳",
    "5. 絵文字・記号 (⚠️ 🔑 📶 ▶ 🚗 📌 🕐 ■ ・ - 等) はそのまま",
    "6. 改行・空行・スペースの構造を保持",
    "7. 民泊・宿泊施設のゲスト向け文書として、丁寧で自然な台湾華語にする",
    "8. 数字・時刻・金額・固有名詞 (Airbnb, Booking.com, PayPay, 楽天ペイ, the Terrace 長浜, YADO KOMACHI Hiroshima, Lawson, Serena, Alphard 等) はそのまま",
    "9. 説明・前置きは出力しない。配列のみ。",
    "",
    "入力 (JSON 配列):",
    JSON.stringify(items, null, 2),
    "",
    "繁體中文 (台湾華語) 翻訳の JSON 配列のみを出力:",
  ].join("\n");
}

async function main() {
  const inputText = fs.readFileSync(0, "utf8");
  const input = JSON.parse(inputText);
  const items = input.items;
  console.error(`[translate-zhtw] 件数: ${items.length}`);

  const apiKey = await getApiKey();
  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(items) }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,500)}`);
  const j = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || arr.length !== items.length) {
    throw new Error(`配列長不一致 ${arr.length}/${items.length}`);
  }
  console.error(`[translate-zhtw] 完了 (${Date.now() - t0}ms)`);
  process.stdout.write(JSON.stringify({ "zh-TW": arr }, null, 2));
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e); process.exit(1); });
