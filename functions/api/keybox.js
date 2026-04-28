/**
 * キーボックス確認API
 *
 * GET /keybox-confirm/:guestId?token=...
 *   - オーナーがOKボタンを押した時の受口
 *   - token を検証し keyboxConfirmedAt をセット
 *   - 送信予定時刻が既に過ぎていれば即時送信
 *   - 完了画面HTMLを返す
 */
const { Router } = require("express");
const { computeScheduledSendAt, formatScheduledSendAt, sendKeyboxEmail } = require("../utils/keyboxSender");

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
      const admin = require("firebase-admin");
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

      // 既に確認済みの場合は送信予定時刻を表示して返す
      if (data.keyboxConfirmedAt) {
        const confirmedDate = data.keyboxConfirmedAt.toDate
          ? data.keyboxConfirmedAt.toDate().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
          : String(data.keyboxConfirmedAt);

        // 送信済みかどうかで文言を分ける
        if (data.keyboxSentAt) {
          const sentDate = data.keyboxSentAt.toDate
            ? data.keyboxSentAt.toDate().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
            : String(data.keyboxSentAt);
          return res.send(htmlPage(
            "確認済み",
            `✅ 既に確認済みです（${confirmedDate}）。<br>キーボックス情報は送信済みです（${sentDate}）。`
          ));
        }

        const prop = await getPropertyData(db, data.propertyId);
        const ks = prop ? (prop.keyboxSend || {}) : {};
        const scheduledAt = computeScheduledSendAt(data.checkIn, ks);
        const scheduledStr = formatScheduledSendAt(scheduledAt);

        return res.send(htmlPage(
          "確認済み",
          `✅ 既に確認済みです（${confirmedDate}）。<br>設定された日時にキーボックス情報を自動送信します（${scheduledStr}）。`
        ));
      }

      // keyboxConfirmedAt をセット
      await docRef.update({
        keyboxConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const guestName = data.guestName || "ゲスト";
      const checkIn   = data.checkIn   || "?";

      console.log(`キーボックス送信確認OK: guestId=${guestId} guestName=${guestName} checkIn=${checkIn}`);

      // 物件設定を取得して即時送信判定
      const prop = await getPropertyData(db, data.propertyId);
      const ks   = prop ? (prop.keyboxSend || {}) : {};
      const mode = ks.mode || "after_ok_click";

      if (mode === "after_ok_click" && ks.scheduleType && ks.sendTime && !data.keyboxSentAt) {
        const scheduledAt = computeScheduledSendAt(data.checkIn, ks);
        const now = new Date();

        if (scheduledAt && now >= scheduledAt) {
          // 送信予定時刻を過ぎている → 即時送信
          try {
            await sendKeyboxEmail(data, prop);
            await docRef.update({ keyboxSentAt: admin.firestore.FieldValue.serverTimestamp() });
            console.log(`キーボックス即時送信: guestId=${guestId} to=${data.email}`);

            return res.send(htmlPage(
              "確認完了（即時送信）",
              `✅ 確認完了。<strong>キーボックス情報を即時送信しました</strong>（送信予定時刻が経過していたため）。<br>${guestName} 様（チェックイン: ${checkIn}）`
            ));
          } catch (sendErr) {
            console.error(`キーボックス即時送信失敗 (${guestId}):`, sendErr.message);
            // 送信失敗でも確認完了は通知する (スケジュール送信に委ねる)
            return res.send(htmlPage(
              "確認完了",
              `✅ 確認完了。メール送信に失敗しました（${sendErr.message}）。<br>スケジュール送信で再試行します。`
            ));
          }
        }

        // まだ送信予定時刻前 → 予定時刻を表示
        const scheduledStr = formatScheduledSendAt(scheduledAt);
        return res.send(htmlPage(
          "確認完了",
          `✅ 確認完了。${guestName} 様（チェックイン: ${checkIn}）のキーボックス情報を<br>設定された日時に自動送信します（${scheduledStr}）。`
        ));
      }

      // mode が after_ok_click 以外、または sendTime 未設定の場合
      return res.send(htmlPage(
        "確認完了",
        `✅ 確認完了。${guestName} 様（チェックイン: ${checkIn}）のキーボックス情報を設定された日時に自動送信します。`
      ));
    } catch (e) {
      console.error("keybox-confirm エラー:", e.message);
      return res.status(500).send(htmlPage("エラー", `⚠️ 処理中にエラーが発生しました: ${e.message}`));
    }
  });

  return router;
};

/** 物件データを取得するヘルパー */
async function getPropertyData(db, propertyId) {
  if (!propertyId) return null;
  try {
    const snap = await db.collection("properties").doc(propertyId).get();
    return snap.exists ? snap.data() : null;
  } catch (_) { return null; }
}

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
