#!/usr/bin/env node
/**
 * 日本語の文字列配列を Gemini 2.5 Flash で韓国語・中国語(簡体) に一括翻訳する
 *
 * 使い方:
 *   node scripts/translate-via-gemini.js < input.json > output.json
 *
 * 入力:
 *   { "items": ["日本語文1", "日本語文2", ...] }
 * 出力:
 *   { "ko": ["...", ...], "zh": ["...", ...] }
 *
 * - 配列の長さ・順序は厳守
 * - {{var}} / {var} / HTML タグ / 絵文字 / 改行 / 行頭記号は維持
 */
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

async function geminiCall(apiKey, prompt) {
  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const j = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini 応答が空");
  return text;
}

function buildPrompt(items, targetLangName, targetLangCode) {
  return [
    `次の日本語テキスト配列を ${targetLangName} に翻訳してください。`,
    "出力は厳密に JSON 配列のみ。配列長と順序は入力と同一にする。",
    "厳守ルール:",
    "1. {{xxx}} / {xxx} の形のプレースホルダは絶対に翻訳せず、そのままの位置と形を保持",
    "2. HTML タグ (<span>, <br>, <strong>, <i>, バッジ class 等) は構造をそのまま保持し、内側のテキストだけを翻訳",
    "3. 絵文字・記号 (⚠️ 🔑 📶 ▶ 🚗 📌 🕐 ■ ・ - 等) はそのまま",
    "4. 改行・空行・スペースの構造を保持",
    "5. 民泊・宿泊施設のゲスト向け文書として、丁寧で自然な" + targetLangName + "にする (ホテル業界の標準トーン)",
    "6. 数字・時刻・金額・固有名詞 (Airbnb, Booking.com, PayPay, 楽天ペイ, the Terrace 長浜, YADO KOMACHI Hiroshima, Lawson, Serena, Alphard 等) はそのまま",
    "7. 説明・前置き・コードブロック・コメントは出力しない。配列のみ。",
    "",
    "入力 (JSON 配列):",
    JSON.stringify(items, null, 2),
    "",
    `${targetLangCode} 翻訳の JSON 配列のみを出力:`,
  ].join("\n");
}

async function main() {
  const inputText = fs.readFileSync(0, "utf8"); // stdin
  const input = JSON.parse(inputText);
  if (!Array.isArray(input.items)) throw new Error("input.items が配列でない");
  const items = input.items;
  console.error(`[translate] 件数: ${items.length}`);

  const apiKey = await getApiKey();
  const result = {};
  for (const [code, name] of [["ko", "韓国語"], ["zh", "中国語(簡体字)"]]) {
    console.error(`[translate] -> ${name} 翻訳中...`);
    const t0 = Date.now();
    const raw = await geminiCall(apiKey, buildPrompt(items, name, code));
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`${code}: 応答が配列でない`);
    if (arr.length !== items.length) {
      throw new Error(`${code}: 配列長不一致 expected=${items.length} got=${arr.length}`);
    }
    result[code] = arr;
    console.error(`[translate] -> ${name} 完了 (${Date.now() - t0}ms)`);
  }
  process.stdout.write(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
