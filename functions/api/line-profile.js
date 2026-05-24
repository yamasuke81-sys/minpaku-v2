/**
 * LINE プロフィール取得 API
 *
 * フロントから LINE Messaging API を直接呼べないため、
 * このエンドポイント経由でユーザー表示名・グループ名を取得する。
 *
 * エンドポイント:
 *   GET /line-profile/user?userId=Uxxx&propertyId=xxx
 *     → { displayName, pictureUrl, userId }
 *   GET /line-profile/group?groupId=Cxxx&propertyId=xxx
 *     → { groupName, groupId }
 *
 * 認証: Firebase ID トークン必須（authenticate ミドルウェアで処理済み）
 * キャッシュ: properties/{pid}.lineChannels[].cachedProfiles に 24時間保存
 */
const express = require("express");
const https = require("https");

module.exports = function lineProfileApi(db) {
  const router = express.Router();

  // ========== キャッシュ有効期限 (24時間 = ms) ==========
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * LINE Messaging API に GET リクエストを送る汎用ヘルパー
   * @param {string} token - チャネルアクセストークン
   * @param {string} path  - "/v2/bot/profile/Uxxx" など
   * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
   */
  function lineGet(token, path) {
    return new Promise((resolve) => {
      const options = {
        hostname: "api.line.me",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      };
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve({ ok: true, data: JSON.parse(body) });
            } catch (e) {
              resolve({ ok: false, error: "JSON parse error" });
            }
          } else {
            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${body}` });
          }
        });
      });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.end();
    });
  }

  /**
   * 物件の lineChannels から有効なトークンを取得する。
   * botIndex 指定があればその Bot、なければ最初の有効トークン。
   * フォールバックとして settings/notifications.lineChannelToken を使用。
   *
   * @param {string} propertyId
   * @param {number|null} botIndex
   * @returns {Promise<string|null>}
   */
  async function resolveToken(propertyId, botIndex) {
    // 物件の lineChannels を確認
    if (propertyId) {
      try {
        const propSnap = await db.collection("properties").doc(propertyId).get();
        if (propSnap.exists) {
          const propData = propSnap.data();
          const channels = Array.isArray(propData.lineChannels) ? propData.lineChannels : [];
          if (botIndex != null && channels[botIndex] && channels[botIndex].token) {
            return channels[botIndex].token;
          }
          // botIndex 未指定時は最初の有効トークン
          const firstValid = channels.find(c => c.token);
          if (firstValid) return firstValid.token;
        }
      } catch (e) {
        console.warn("[line-profile] 物件データ取得失敗:", e.message);
      }
    }
    // settings/notifications のグローバルトークンをフォールバック
    try {
      const settingsSnap = await db.collection("settings").doc("notifications").get();
      if (settingsSnap.exists) {
        const s = settingsSnap.data();
        return s.lineChannelToken || s.lineToken || null;
      }
    } catch (e) {
      console.warn("[line-profile] settings/notifications 取得失敗:", e.message);
    }
    return null;
  }

  /**
   * Firestore キャッシュからプロフィールを取得する。
   * 期限切れ (24h超) の場合は null を返す。
   *
   * キャッシュパス:
   *   properties/{pid}.cachedLineProfiles.{userId|groupId}
   */
  async function getCached(propertyId, id) {
    if (!propertyId || !id) return null;
    try {
      const propSnap = await db.collection("properties").doc(propertyId).get();
      if (!propSnap.exists) return null;
      const cache = propSnap.data().cachedLineProfiles || {};
      const entry = cache[id];
      if (!entry || !entry.cachedAt) return null;
      const age = Date.now() - entry.cachedAt.toMillis();
      if (age > CACHE_TTL_MS) return null;
      return entry;
    } catch (e) {
      console.warn("[line-profile] キャッシュ読み込み失敗:", e.message);
      return null;
    }
  }

  /**
   * Firestore にプロフィールをキャッシュ保存する。
   */
  async function saveCache(propertyId, id, data) {
    if (!propertyId || !id) return;
    try {
      await db.collection("properties").doc(propertyId).update({
        [`cachedLineProfiles.${id}`]: {
          ...data,
          cachedAt: new Date(),
        },
      });
    } catch (e) {
      // キャッシュ保存失敗はエラーにしない
      console.warn("[line-profile] キャッシュ保存失敗:", e.message);
    }
  }

  // ========== GET /user ==========
  /**
   * LINE ユーザー表示名を取得する
   * Query:
   *   userId     - LINE User ID (Uxxxxxxxx...)
   *   propertyId - キャッシュ先物件ID（省略可）
   *   botIndex   - 使用する Bot のインデックス（省略可、0始まり）
   */
  router.get("/user", async (req, res) => {
    const { userId, propertyId, botIndex } = req.query;
    if (!userId) {
      return res.status(400).json({ error: "userId が必要です" });
    }

    // キャッシュ確認
    const cached = await getCached(propertyId, userId);
    if (cached) {
      return res.json({
        userId,
        displayName: cached.displayName || userId,
        pictureUrl: cached.pictureUrl || null,
        fromCache: true,
      });
    }

    // トークン解決
    const token = await resolveToken(propertyId, botIndex != null ? parseInt(botIndex, 10) : null);
    if (!token) {
      return res.status(200).json({
        userId,
        displayName: userId, // トークン未設定時は ID をそのまま返す
        pictureUrl: null,
        error: "LINE トークン未設定",
      });
    }

    // LINE API 呼び出し
    const result = await lineGet(token, `/v2/bot/profile/${encodeURIComponent(userId)}`);
    if (!result.ok) {
      return res.status(200).json({
        userId,
        displayName: userId,
        pictureUrl: null,
        error: result.error,
      });
    }

    const profile = {
      userId,
      displayName: result.data.displayName || userId,
      pictureUrl: result.data.pictureUrl || null,
    };

    // キャッシュ保存（非同期、エラーは無視）
    saveCache(propertyId, userId, {
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
    });

    return res.json(profile);
  });

  // ========== GET /group ==========
  /**
   * LINE グループ名を取得する
   * Query:
   *   groupId    - LINE Group ID (Cxxxxxxxx...)
   *   propertyId - キャッシュ先物件ID（省略可）
   *   botIndex   - 使用する Bot のインデックス（省略可）
   */
  router.get("/group", async (req, res) => {
    const { groupId, propertyId, botIndex } = req.query;
    if (!groupId) {
      return res.status(400).json({ error: "groupId が必要です" });
    }

    // キャッシュ確認
    const cached = await getCached(propertyId, groupId);
    if (cached) {
      return res.json({
        groupId,
        groupName: cached.groupName || groupId,
        fromCache: true,
      });
    }

    // トークン解決
    const token = await resolveToken(propertyId, botIndex != null ? parseInt(botIndex, 10) : null);
    if (!token) {
      return res.status(200).json({
        groupId,
        groupName: groupId,
        error: "LINE トークン未設定",
      });
    }

    // LINE API 呼び出し
    const result = await lineGet(token, `/v2/bot/group/${encodeURIComponent(groupId)}/summary`);
    if (!result.ok) {
      return res.status(200).json({
        groupId,
        groupName: groupId,
        error: result.error,
      });
    }

    const info = {
      groupId,
      groupName: result.data.groupName || groupId,
    };

    // キャッシュ保存
    saveCache(propertyId, groupId, { groupName: info.groupName });

    return res.json(info);
  });

  return router;
};
