/**
 * キーボックス確認API
 *
 * GET /keybox-confirm/:guestId?token=...
 *   - オーナーがOKボタンを押した時の受口
 *   - token を検証し keyboxConfirmedAt をセット
 *   - 完了画面HTMLを返す
 */
const { Router } = require("express");

module.exports = function keyboxApi(db) {
  const router = Router();

  // OKボタン確認エンドポイント (認証不要、token で代替)
  router.get("/confirm/:guestId", async (req, res) => {
    const { guestId } = req.params;
    const { token } = req.query;

    if (!guestId || !token) {
      return res.status(400).send(htmlPage("エラー", "❌ パラメータが不足しています。"));
    }

    try {
      const docRef = db.collection("guestRegistrations").doc(guestId);
      const doc = await docRef.get();

      if (!doc.exists) {
        return res.status(404).send(htmlPage("エラー", "❌ 名簿データが見つかりません。"));
      }

      const data = doc.data();

      // token 検証
      if (!data.keyboxConfirmToken || data.keyboxConfirmToken !== token) {
        return res.status(403).send(htmlPage("エラー", "❌ 無効なトークンです。URLを確認してください。"));
      }

      // 既に確認済みの場合はそのまま成功を返す
      if (data.keyboxConfirmedAt) {
        const confirmedDate = data.keyboxConfirmedAt.toDate
          ? data.keyboxConfirmedAt.toDate().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
          : String(data.keyboxConfirmedAt);
        return res.send(htmlPage(
          "確認済み",
          `✅ 既に確認済みです（${confirmedDate}）。<br>設定された日時にキーボックス情報を自動送信します。`
        ));
      }

      // keyboxConfirmedAt をセット
      const admin = require("firebase-admin");
      await docRef.update({
        keyboxConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const guestName = data.guestName || "ゲスト";
      const checkIn = data.checkIn || "?";

      console.log(`キーボックス送信確認OK: guestId=${guestId} guestName=${guestName} checkIn=${checkIn}`);

      return res.send(htmlPage(
        "確認完了",
        `✅ 確認完了。<br>${guestName} 様（チェックイン: ${checkIn}）の<br>キーボックス情報を設定された日時に自動送信します。`
      ));
    } catch (e) {
      console.error("keybox-confirm エラー:", e.message);
      return res.status(500).send(htmlPage("エラー", `⚠️ 処理中にエラーが発生しました: ${e.message}`));
    }
  });

  return router;
};

/** シンプルなHTML完了画面を生成 */
function htmlPage(title, message) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — 民泊管理</title>
<style>
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8f9fa; }
  .box { background: #fff; border-radius: 12px; padding: 2rem 2.5rem; text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,.08); max-width: 480px; width: 90%; }
  h2 { margin-bottom: .75rem; }
  p  { color: #555; line-height: 1.6; }
</style>
</head>
<body>
<div class="box">
  <h2>${title}</h2>
  <p>${message}</p>
</div>
</body>
</html>`;
}
