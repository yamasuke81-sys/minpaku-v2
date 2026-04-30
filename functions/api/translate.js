/**
 * 英訳 API — Gemini 2.5 Flash でメールテンプレを日本語→英語に翻訳
 *
 * POST /api/translate/email
 *   body: { subject?: string, body?: string }
 *   res:  { subjectEn: string, bodyEn: string }
 *
 * 仕様:
 *   - プレースホルダ {{xxx}} および {xxx} は変更せずそのまま保持
 *   - 改行・空行構造もできる限り保持
 *   - settings/scanSorter.geminiApiKey を流用
 */
const express = require("express");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function getGeminiApiKey_(db) {
  const doc = await db.collection("settings").doc("scanSorter").get();
  if (!doc.exists) return null;
  const data = doc.data() || {};
  return data.geminiApiKey || null;
}

async function translateOne_(text, apiKey) {
  if (!text || !text.trim()) return "";
  const prompt = [
    "次の日本語テキストをネイティブな自然な英語に翻訳してください。",
    "厳守ルール:",
    "1. {{xxx}} および {xxx} の形のプレースホルダは絶対に翻訳せず、そのままの位置・形で保持する",
    "2. 改行・空行・行頭の記号(■, ・, - など)は元の構造をできる限り保持する",
    "3. 説明・補足・前置きは一切付けず、英訳本文のみを出力する",
    "4. 民泊宿泊者(ゲスト)向けの丁寧で明瞭な英語にする (ホテル業界の標準的トーン)",
    "5. 日付や時刻のフォーマットは置換しない (テンプレ変数で展開されるため)",
    "",
    "【日本語原文】",
    text,
  ].join("\n");

  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini APIエラー (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error("Gemini応答が空です");
  return out.trim();
}

module.exports = (db) => {
  const router = express.Router();

  router.post("/email", async (req, res) => {
    try {
      const { subject = "", body = "" } = req.body || {};
      if (!subject && !body) {
        return res.status(400).json({ error: "subject または body のいずれかが必要です" });
      }
      const apiKey = await getGeminiApiKey_(db);
      if (!apiKey) {
        return res.status(400).json({
          error: "Gemini APIキーが未設定です (scan-sorter 設定画面で登録してください)",
        });
      }

      // 並列翻訳 (subject/body 両方)
      const [subjectEn, bodyEn] = await Promise.all([
        translateOne_(subject, apiKey),
        translateOne_(body, apiKey),
      ]);

      res.json({ subjectEn, bodyEn });
    } catch (e) {
      console.error("[translate/email] エラー:", e);
      res.status(500).json({ error: e.message || "翻訳に失敗しました" });
    }
  });

  return router;
};
