/**
 * 既存プリカ 9 件の meta 補完 (DRY_RUN=1 で事前確認)
 *
 * 背景:
 *   古いバージョン / 中間実装版で作られたカードに chargeAmount / purchasedBy が
 *   入っておらず、請求書集計で対象外になっている。
 *
 * 補完方針:
 *   - purchasedBy: 全て西山管理者 (ziTig6tefnj5NvkgN4fG / "西山管理者") で統一
 *     (他スタッフが購入した可能性があれば手動編集を想定)
 *   - purchasedAt: 既存あれば保持。無ければ "2026-04-18T00:00:00+09:00" で統一
 *     (4月計上対象にするため) — DRY_RUN 結果を見て必要なら admin script を書き直す
 *   - chargeAmount: chargeRules から depotId + balance 逆引きで推定
 *     見つからなければ balance と同額で仮置き (DRY_RUN で確認)
 */
const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const DRY_RUN = process.env.DRY_RUN === "1";
const OWNER = { staffId: "ziTig6tefnj5NvkgN4fG", staffName: "西山管理者" };
const FALLBACK_DATE = new Date("2026-04-18T00:00:00+09:00");

(async () => {
  console.log(`==== プリカ meta 補完 ${DRY_RUN ? "(DRY RUN)" : "(本番実行)"} ====\n`);

  const doc = await db.collection("settings").doc("prepaidCards").get();
  if (!doc.exists) { console.log("prepaidCards 未存在"); process.exit(0); }
  const items = doc.data().items || [];
  const chargeRules = doc.data().chargeRules || [];
  const depotPrefixes = doc.data().depotPrefixes || {};

  // chargeRules から balance → chargeAmount 逆引き
  const reverseLookup = (balance, depotId) => {
    // 1. depotId 完全一致 + balance 完全一致
    let rule = chargeRules.find(r => Number(r.balance) === balance && (r.depotId || "") === (depotId || ""));
    if (rule) return Number(rule.chargeAmount);
    // 2. 全店共通 (depotId 空) + balance 完全一致
    rule = chargeRules.find(r => Number(r.balance) === balance && !r.depotId);
    if (rule) return Number(rule.chargeAmount);
    // 3. balance == 0 (使い切り) は逆引き不可。fallback で典型値 2000 を使う (要手動確認)
    if (balance === 0) return null; // 後でユーザー確認
    // 4. それ以外はそのまま (bonus 無し想定)
    return balance;
  };

  const updated = [];
  items.forEach((c, i) => {
    const newCard = { ...c };
    const changes = [];

    if (!c.purchasedBy || !c.purchasedBy.staffId) {
      newCard.purchasedBy = OWNER;
      changes.push(`purchasedBy += ${OWNER.staffName}`);
    }

    if (!c.purchasedAt) {
      newCard.purchasedAt = admin.firestore.Timestamp.fromDate(FALLBACK_DATE);
      changes.push(`purchasedAt := ${FALLBACK_DATE.toISOString()} (fallback)`);
    }

    if (c.chargeAmount === undefined || c.chargeAmount === null) {
      const est = reverseLookup(Number(c.balance) || 0, c.depotId);
      if (est !== null) {
        newCard.chargeAmount = est;
        changes.push(`chargeAmount := ${est} (推定)`);
      } else {
        changes.push(`chargeAmount := (推定不可, balance=0)`);
      }
    }

    console.log(`[${i}] ${c.cardNumber} depotId=${c.depotId} balance=${c.balance}`);
    if (changes.length) console.log(`    ${changes.join(" | ")}`);
    else console.log(`    (変更なし)`);

    updated.push(newCard);
  });

  if (DRY_RUN) {
    console.log("\n[DRY RUN] 本番実行時は上記を prepaidCards.items に上書き保存");
    process.exit(0);
  }

  console.log("\n==== 本番書き込み ====");
  await db.collection("settings").doc("prepaidCards").set({
    items: updated,
    depotPrefixes,
    chargeRules,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`${updated.length} 件のカードを更新`);
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
