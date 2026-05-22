/**
 * LINE Channel Access Token 変更検知トリガー
 *
 * 監視対象:
 * 1. properties/{pid}: lineChannels[*].token / lineChannelToken (旧)
 * 2. settings/notifications: lineChannelToken / ownerLineChannels[*].token
 *
 * 変更検知時、LINE Bot Info API (/v2/bot/info) を呼んで displayName/basicId を取得し、
 * 同ドキュメント内の botInfo フィールドにキャッシュ書き戻す。
 *
 * 無限ループ防止: token 値そのものは触らないので、再トリガー時には同 token → fetch 結果同一 → 書き戻しても変化なし
 * (実際は before/after で token 配列が同一なら早期 return で fetch 自体スキップ)
 */
const admin = require("firebase-admin");
const { fetchLineBotInfo } = require("../utils/lineBotInfo");

function tokensOf(data) {
  if (!data) return [];
  const out = [];
  const channels = Array.isArray(data.lineChannels) ? data.lineChannels : [];
  channels.forEach((c, idx) => {
    if (c && c.token) out.push({ source: "lineChannels", idx, token: c.token });
  });
  if (data.lineChannelToken) out.push({ source: "lineChannelToken", idx: 0, token: data.lineChannelToken });
  const owner = Array.isArray(data.ownerLineChannels) ? data.ownerLineChannels : [];
  owner.forEach((c, idx) => {
    if (c && c.token) out.push({ source: "ownerLineChannels", idx, token: c.token });
  });
  return out;
}

function sameTokenList(a, b) {
  if (a.length !== b.length) return false;
  const aKeys = a.map(t => `${t.source}#${t.idx}:${t.token}`).sort();
  const bKeys = b.map(t => `${t.source}#${t.idx}:${t.token}`).sort();
  return aKeys.every((k, i) => k === bKeys[i]);
}

async function refreshBotInfoForDoc(ref, after) {
  const tokens = tokensOf(after);
  if (tokens.length === 0) return;
  const update = {};
  for (const t of tokens) {
    const info = await fetchLineBotInfo(t.token);
    if (!info) continue;
    if (t.source === "lineChannels") {
      update[`lineChannels.${t.idx}.botInfo`] = info;
    } else if (t.source === "ownerLineChannels") {
      update[`ownerLineChannels.${t.idx}.botInfo`] = info;
    } else if (t.source === "lineChannelToken") {
      update["lineBotInfo"] = info;
    }
  }
  if (Object.keys(update).length === 0) return;
  try {
    await ref.update(update);
    console.log(`[onLineTokenChange] botInfo 更新: ${ref.path} (${Object.keys(update).length}件)`);
  } catch (e) {
    console.error(`[onLineTokenChange] botInfo 書き戻し失敗: ${ref.path}`, e);
  }
}

// properties/{pid} 用
async function onPropertyChange(event) {
  const before = event.data.before?.data() || null;
  const after = event.data.after?.data() || null;
  if (!after) return; // 削除
  if (before && sameTokenList(tokensOf(before), tokensOf(after))) return;
  await refreshBotInfoForDoc(event.data.after.ref, after);
}

// settings/notifications 用 (固定 docId なので個別ハンドラ)
async function onNotificationsSettingsChange(event) {
  const before = event.data.before?.data() || null;
  const after = event.data.after?.data() || null;
  if (!after) return;
  if (before && sameTokenList(tokensOf(before), tokensOf(after))) return;
  await refreshBotInfoForDoc(event.data.after.ref, after);
}

module.exports = { onPropertyChange, onNotificationsSettingsChange };
