// 特別加算 (specialRates) 集計の再現テスト
// invoices.js の isDateInSpecialRate / 集計ループを純関数として再現し
// 複数 specialRates が同一日に該当した場合の挙動を確認する

// invoices.js line 671-690 から移植
function isDateInSpecialRate(dateStr, sr) {
  if (!dateStr) return false;
  if (sr.recurYearly) {
    const md = dateStr.slice(5);
    const s = sr.recurStart || "01-01";
    const e = sr.recurEnd || "12-31";
    if (s <= e) {
      return md >= s && md <= e;
    } else {
      return md >= s || md <= e;
    }
  } else {
    const start = sr.start || "";
    const end = sr.end || "";
    if (start && dateStr < start) return false;
    if (end && dateStr > end) return false;
    return !!(start || end);
  }
}

// invoices.js line 983-1000 集計ループ移植
function sumSpecial(dateStr, specialRates) {
  let specialAmount = 0;
  const details = [];
  for (const sr of specialRates) {
    if (isDateInSpecialRate(dateStr, sr)) {
      const addAmt = Number(sr.addAmount || 0);
      if (addAmt > 0) {
        specialAmount += addAmt;
        details.push({ name: sr.name, amount: addAmt });
      }
    }
  }
  return { specialAmount, details };
}

const cases = [
  {
    title: "ケース1: 1件のみ該当",
    dateStr: "2026-08-15",
    rates: [
      { name: "夏季加算", recurYearly: true, recurStart: "07-01", recurEnd: "08-31", addAmount: 1000 },
    ],
    expected: 1000,
  },
  {
    title: "ケース2: 2件とも該当 (期間重複)",
    dateStr: "2026-08-15",
    rates: [
      { name: "夏季加算", recurYearly: true, recurStart: "07-01", recurEnd: "08-31", addAmount: 1000 },
      { name: "お盆加算", recurYearly: true, recurStart: "08-10", recurEnd: "08-20", addAmount: 2000 },
    ],
    expected: 3000,
  },
  {
    title: "ケース3: 2件のうち1件のみ該当",
    dateStr: "2026-08-15",
    rates: [
      { name: "夏季加算", recurYearly: true, recurStart: "07-01", recurEnd: "08-31", addAmount: 1000 },
      { name: "年末加算", recurYearly: true, recurStart: "12-25", recurEnd: "12-31", addAmount: 3000 },
    ],
    expected: 1000,
  },
  {
    title: "ケース4a: 年跨ぎ recurYearly (12/31)",
    dateStr: "2026-12-31",
    rates: [
      { name: "年末年始加算", recurYearly: true, recurStart: "12-31", recurEnd: "01-02", addAmount: 5000 },
    ],
    expected: 5000,
  },
  {
    title: "ケース4b: 年跨ぎ recurYearly (1/1)",
    dateStr: "2027-01-01",
    rates: [
      { name: "年末年始加算", recurYearly: true, recurStart: "12-31", recurEnd: "01-02", addAmount: 5000 },
    ],
    expected: 5000,
  },
  {
    title: "ケース4c: 年跨ぎ recurYearly 範囲外",
    dateStr: "2027-01-05",
    rates: [
      { name: "年末年始加算", recurYearly: true, recurStart: "12-31", recurEnd: "01-02", addAmount: 5000 },
    ],
    expected: 0,
  },
  {
    title: "ケース5: 同名 specialRate 重複定義 (誤登録想定)",
    dateStr: "2026-08-15",
    rates: [
      { name: "夏季加算", recurYearly: true, recurStart: "07-01", recurEnd: "08-31", addAmount: 1000 },
      { name: "夏季加算", recurYearly: true, recurStart: "07-01", recurEnd: "08-31", addAmount: 1000 },
    ],
    expected: 2000,
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = sumSpecial(c.dateStr, c.rates);
  const ok = r.specialAmount === c.expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.title}`);
  console.log(`  date=${c.dateStr} 加算=${r.specialAmount}円 期待=${c.expected}円 件数=${r.details.length}`);
  console.log(`  内訳: ${JSON.stringify(r.details)}`);
  ok ? pass++ : fail++;
}
console.log(`\n結果: ${pass} pass / ${fail} fail`);
