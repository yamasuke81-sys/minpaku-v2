/**
 * GAS版との予約データ差分比較・通知
 * 毎時0分に実行し、設定の dailyTime / beforeTime と一致した場合のみ処理する
 */
const https = require("https");
const { sendNotificationEmail_ } = require("../utils/lineNotify");

/**
 * Firestore から GAS比較設定を読み取る
 * @returns {Promise<object|null>}
 */
async function loadConfig_(db) {
  const snap = await db.collection("settings").doc("gasComparison").get();
  if (!snap.exists) return null;
  return snap.data();
}

/**
 * JST の現在時刻を "HH:MM" 形式で返す
 */
function getJstHHMM_() {
  const now = new Date();
  // JST = UTC+9
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 今日から N 日後の日付を "YYYY-MM-DD" で返す
 */
function jstDateStr_(offsetDays = 0) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 86400000);
  return jst.toISOString().slice(0, 10);
}

/**
 * GAS版 bookings_range API を fetch で取得
 * @returns {Promise<Array>} bookings 配列
 */
async function fetchGasBookings_(gasUrl, gasToken, from, to) {
  const url = `${gasUrl}?type=bookings_range&token=${encodeURIComponent(gasToken)}&from=${from}&to=${to}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) return reject(new Error(`GAS API エラー: ${json.error || "unknown"}`));
          resolve(json.bookings || []);
        } catch (e) {
          reject(new Error(`GAS APIレスポンス解析エラー: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("GAS API タイムアウト")); });
  });
}

/**
 * Firestore から対象期間の予約を取得（status != cancelled）
 * @returns {Promise<Array>}
 */
async function fetchV2Bookings_(db, propertiesMap, from, to) {
  const snap = await db.collection("bookings")
    .where("checkOut", ">=", from)
    .where("checkOut", "<=", to)
    .get();

  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => b.status !== "cancelled")
    .map(b => ({
      bookingId: b.id,
      propertyName: propertiesMap[b.propertyId] || b.propertyId || "不明",
      checkIn: typeof b.checkIn === "string" ? b.checkIn : (b.checkIn?.toDate?.()?.toISOString?.()?.slice(0, 10) || ""),
      checkOut: typeof b.checkOut === "string" ? b.checkOut : (b.checkOut?.toDate?.()?.toISOString?.()?.slice(0, 10) || ""),
      guestName: b.guestName || "",
      source: b.source || "",
    }));
}

/**
 * 物件名+checkIn+checkOut をキーに差分を抽出
 * @returns {{ gasOnly: Array, v2Only: Array, mismatches: Array }}
 */
function diffBookings_(gasBookings, v2Bookings) {
  // キー生成（物件名+CI+CO の組み合わせ）
  const makeKey = (b) => `${(b.propertyName || "").trim()}|${b.checkIn}|${b.checkOut}`;

  const gasMap = new Map();
  gasBookings.forEach(b => gasMap.set(makeKey(b), b));

  const v2Map = new Map();
  v2Bookings.forEach(b => v2Map.set(makeKey(b), b));

  const gasOnly = [];
  const v2Only = [];
  const mismatches = [];

  // GASにあって v2 にない
  gasMap.forEach((b, key) => {
    if (!v2Map.has(key)) {
      gasOnly.push(b);
    }
  });

  // v2にあって GAS にない
  v2Map.forEach((b, key) => {
    if (!gasMap.has(key)) {
      v2Only.push(b);
    }
  });

  // ゲスト名・物件名不一致（CI/CO一致でゲスト名が異なる場合）
  const ciCoKey = (b) => `${b.checkIn}|${b.checkOut}`;
  const gasByCiCo = new Map();
  gasBookings.forEach(b => gasByCiCo.set(ciCoKey(b), b));
  v2Bookings.forEach(b => {
    const k = ciCoKey(b);
    if (gasByCiCo.has(k)) {
      const gasB = gasByCiCo.get(k);
      if (gasB.guestName && b.guestName && gasB.guestName !== b.guestName) {
        mismatches.push({ gas: gasB, v2: b, type: "guestName" });
      }
    }
  });

  return { gasOnly, v2Only, mismatches };
}

/**
 * 差分メール本文を生成
 */
function buildEmailBody_(diff, from, to) {
  const { gasOnly, v2Only, mismatches } = diff;
  const total = gasOnly.length + v2Only.length + mismatches.length;
  const lines = [
    `【民泊v2】GAS版との予約データ差分検出 (${total}件)`,
    `対象期間: ${from} 〜 ${to}`,
    "",
  ];

  if (gasOnly.length > 0) {
    lines.push(`■ GAS版のみに存在 (${gasOnly.length}件) — v2への登録漏れの可能性`);
    lines.push("物件名 | チェックイン | チェックアウト | ゲスト名 | 予約サイト");
    gasOnly.forEach(b => {
      lines.push(`${b.propertyName} | ${b.checkIn} | ${b.checkOut} | ${b.guestName || "(不明)"} | ${b.source || ""}`);
    });
    lines.push("");
  }

  if (v2Only.length > 0) {
    lines.push(`■ v2のみに存在 (${v2Only.length}件) — GAS版への登録漏れ or v2独自予約`);
    lines.push("物件名 | チェックイン | チェックアウト | ゲスト名 | 予約サイト");
    v2Only.forEach(b => {
      lines.push(`${b.propertyName} | ${b.checkIn} | ${b.checkOut} | ${b.guestName || "(不明)"} | ${b.source || ""}`);
    });
    lines.push("");
  }

  if (mismatches.length > 0) {
    lines.push(`■ ゲスト名不一致 (${mismatches.length}件)`);
    lines.push("チェックイン | チェックアウト | GAS版ゲスト名 | v2ゲスト名");
    mismatches.forEach(m => {
      lines.push(`${m.gas.checkIn} | ${m.gas.checkOut} | ${m.gas.guestName} | ${m.v2.guestName}`);
    });
    lines.push("");
  }

  lines.push("---");
  lines.push("このメールは民泊v2 差分チェック機能により自動送信されました。");
  lines.push("設定変更: https://minpaku-v2.web.app/#/notifications");

  return lines.join("\n");
}

/**
 * 差分比較の本処理（callable と scheduled 両方から呼ばれる共有ロジック）
 * @param {object} db Firestore インスタンス
 * @param {object|null} configOverride null の場合は Firestore から読み込む
 * @returns {Promise<{ total: number, gasOnly: number, v2Only: number, mismatches: number, sent: boolean }>}
 */
async function runComparison(db, configOverride = null) {
  const config = configOverride || await loadConfig_(db);
  if (!config || !config.enabled) {
    console.log("[gasComparison] 無効または設定なし — スキップ");
    return { total: 0, gasOnly: 0, v2Only: 0, mismatches: 0, sent: false };
  }

  const { gasUrl, gasToken, recipients, mode, daysAhead, daysBefore } = config;
  if (!gasUrl || !gasToken) {
    console.warn("[gasComparison] gasUrl または gasToken が未設定");
    return { total: 0, gasOnly: 0, v2Only: 0, mismatches: 0, sent: false };
  }

  const today = jstDateStr_(0);
  let from, to;

  if (mode === "before_checkout") {
    // チェックアウト N日前 モード: その日が対象日
    const targetDay = jstDateStr_(daysBefore || 1);
    from = targetDay;
    to = targetDay;
  } else {
    // daily モード: 今日〜N日先
    from = today;
    to = jstDateStr_(daysAhead || 30);
  }

  // 物件マスタを取得（propertyId→propertyName マッピング）
  const propsSnap = await db.collection("properties").get();
  const propertiesMap = {};
  propsSnap.forEach(d => { propertiesMap[d.id] = d.data().name || d.id; });

  // 両方のデータ取得
  const [gasBookings, v2Bookings] = await Promise.all([
    fetchGasBookings_(gasUrl, gasToken, from, to),
    fetchV2Bookings_(db, propertiesMap, from, to),
  ]);

  console.log(`[gasComparison] GAS: ${gasBookings.length}件, v2: ${v2Bookings.length}件 (${from}〜${to})`);

  const diff = diffBookings_(gasBookings, v2Bookings);
  const total = diff.gasOnly.length + diff.v2Only.length + diff.mismatches.length;

  if (total === 0) {
    console.log("[gasComparison] 差分なし");
    return { total: 0, gasOnly: 0, v2Only: 0, mismatches: 0, sent: false };
  }

  // メール送信
  const subject = `【民泊v2】GAS版との予約データ差分検出 (${total}件)`;
  const body = buildEmailBody_(diff, from, to);

  const recipientList = Array.isArray(recipients) ? recipients : (recipients ? [recipients] : []);
  if (recipientList.length === 0) {
    console.warn("[gasComparison] 送信先が未設定のためメール送信スキップ");
    return { total, gasOnly: diff.gasOnly.length, v2Only: diff.v2Only.length, mismatches: diff.mismatches.length, sent: false };
  }

  for (const to_ of recipientList) {
    try {
      await sendNotificationEmail_(to_, subject, body);
      console.log(`[gasComparison] メール送信完了 → ${to_}`);
    } catch (e) {
      console.error(`[gasComparison] メール送信エラー (${to_}):`, e.message);
    }
  }

  return {
    total,
    gasOnly: diff.gasOnly.length,
    v2Only: diff.v2Only.length,
    mismatches: diff.mismatches.length,
    sent: true,
  };
}

/**
 * Cloud Scheduler エントリポイント（毎時0分）
 * 設定の dailyTime / beforeTime と現在時刻を比較して実行判断
 */
module.exports = async function runGasComparisonHourly(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const config = await loadConfig_(db);
  if (!config || !config.enabled) {
    console.log("[gasComparison] 無効または設定なし — スキップ");
    return;
  }

  const now = getJstHHMM_();
  // 時刻を "HH:00" に丸めて比較（毎時0分実行のため分は00）
  const nowHour = now.slice(0, 3) + "00";

  let shouldRun = false;

  if (config.mode === "daily") {
    const target = String(config.dailyTime || "09:00").slice(0, 5);
    if (nowHour === target || now === target) shouldRun = true;
  } else if (config.mode === "before_checkout") {
    const target = String(config.beforeTime || "18:00").slice(0, 5);
    if (nowHour === target || now === target) shouldRun = true;
  }

  if (!shouldRun) {
    console.log(`[gasComparison] 現在 ${now} は実行時刻に該当しない (mode=${config.mode}) — スキップ`);
    return;
  }

  console.log(`[gasComparison] 実行開始 (mode=${config.mode}, time=${now})`);
  const result = await runComparison(db, config);
  console.log("[gasComparison] 完了:", result);
};

// callable 関数からも共有ロジックを呼び出せるようエクスポート
module.exports.runComparison = runComparison;
