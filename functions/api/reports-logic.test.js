/**
 * reports-logic 純粋関数の単体テスト
 * 実行: node --test functions/api/reports-logic.test.js
 *
 * 中心は「2026年6・7月分の実データで、ポータルへ実提出した値を再現できること」。
 * 実提出値: 宿泊日数27 / 宿泊者数85 / 延べ人数136
 * 国籍: 日本58 韓国7 香港3 中国1 ドイツ4 イタリア1 米国7 その他4
 * （2026-08-10 に国籍内訳を是正済み。詳細は .claude/rules/jisseki-report-automation-plan.md）
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  NATIONALITY_GRID,
  CSV_HEADER,
  addDays,
  stayDatesOf,
  lastDayOfMonth,
  resolveNationality,
  fiscalYearOf,
  portalPeriodLabel,
  getReportPeriods,
  buildJissekiReport,
  toCsvRow,
  toPortalCsv,
} = require("./reports-logic");

const jp = (n) => new Array(n).fill({ nationality: "日本" });

// the Terrace 長浜 2026年6・7月の実データ（本番Firestoreの guestRegistrations より）
const ROWS_2026_06_07 = [
  { checkIn: "2026-06-01", checkOut: "2026-06-02", guestCount: 4, guestName: "Thaler Margret", nationality: "German",
    companions: [{ nationality: "german" }, { nationality: "German" }, { nationality: "German" }] },
  { checkIn: "2026-06-02", checkOut: "2026-06-03", guestCount: 3, guestName: "Siu Yi Man", nationality: "Hong Kong",
    companions: [{ nationality: "Hong Kong" }, { nationality: "Hong Kong" }] },
  { checkIn: "2026-06-06", checkOut: "2026-06-07", guestCount: 4, guestName: "KIM JUNGJIN", nationality: "KOREA",
    companions: [{ nationality: "KOREA" }, { nationality: "KOREA" }, { nationality: "KOREA" }] },
  { checkIn: "2026-06-07", checkOut: "2026-06-08", guestCount: 2, guestName: "Aidan Braun Freck", nationality: "American",
    companions: [{ nationality: "Italian" }] },
  { checkIn: "2026-06-13", checkOut: "2026-06-15", guestCount: 7, guestName: "濵田薫平", nationality: "日本", companions: jp(6) },
  { checkIn: "2026-06-19", checkOut: "2026-06-20", guestCount: 4, guestName: "Han舞子", nationality: "日本",
    companions: [{ nationality: "USA" }, { nationality: "日本" }, { nationality: "日本" }] },
  { checkIn: "2026-06-20", checkOut: "2026-06-21", guestCount: 4, guestName: "金田優", nationality: "日本", companions: jp(3) },
  { checkIn: "2026-06-21", checkOut: "2026-06-22", guestCount: 4, guestName: "湊 似子", nationality: "日本", companions: jp(3) },
  // 月をまたぐ予約。4泊であって5泊ではない（タイムゾーン混在バグの回帰テスト）
  { checkIn: "2026-06-27", checkOut: "2026-07-01", guestCount: 5, guestName: "ZHANG JINGYU", nationality: "中国",
    companions: [{ nationality: "SWEDEN" }, { nationality: "SWEDEN" }, { nationality: "SWEDEN" }, { nationality: "SWEDEN" }] },
  { checkIn: "2026-07-01", checkOut: "2026-07-02", guestCount: 5, guestName: "Rintaro hashimoto", nationality: "日本", companions: [] },
  { checkIn: "2026-07-04", checkOut: "2026-07-06", guestCount: 10, guestName: "住田隆真", nationality: "日本", companions: [] },
  { checkIn: "2026-07-06", checkOut: "2026-07-10", guestCount: 3, guestName: "Kim hyungeun", nationality: "KOREA", companions: [] },
  { checkIn: "2026-07-10", checkOut: "2026-07-12", guestCount: 5, guestName: "タカナシクンペイ", nationality: "日本", companions: [] },
  { checkIn: "2026-07-18", checkOut: "2026-07-19", guestCount: 6, guestName: "松崎奏", nationality: "日本", companions: [] },
  { checkIn: "2026-07-19", checkOut: "2026-07-20", guestCount: 9, guestName: "入谷　夢香", nationality: "日本", companions: [] },
  { checkIn: "2026-07-21", checkOut: "2026-07-23", guestCount: 5, guestName: "Christopher", nationality: "American", companions: [] },
  { checkIn: "2026-07-25", checkOut: "2026-07-26", guestCount: 5, guestName: "錦織朱里", nationality: "日本", companions: [] },
];

describe("日付ユーティリティ（タイムゾーン非依存）", () => {
  test("addDays は月・年をまたいでも正しい", () => {
    assert.strictEqual(addDays("2026-06-30", 1), "2026-07-01");
    assert.strictEqual(addDays("2026-12-31", 1), "2027-01-01");
    assert.strictEqual(addDays("2026-03-01", -1), "2026-02-28");
  });

  test("stayDatesOf はCIを含みCOを含まない＝泊数と一致", () => {
    assert.deepStrictEqual(stayDatesOf("2026-06-01", "2026-06-02"), ["2026-06-01"]);
    assert.deepStrictEqual(stayDatesOf("2026-06-13", "2026-06-15"), ["2026-06-13", "2026-06-14"]);
  });

  test("★月をまたぐ予約が1泊多くならない（旧 calcNightsInMonth のTZバグ回帰）", () => {
    // 6/27 17時IN → 7/1 10時OUT は「4日」（定期報告に係る留意事項の例と同じ数え方）
    const d = stayDatesOf("2026-06-27", "2026-07-01");
    assert.strictEqual(d.length, 4);
    assert.deepStrictEqual(d, ["2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30"]);
  });

  test("不正な日付は空配列", () => {
    assert.deepStrictEqual(stayDatesOf("2026-06-05", "2026-06-05"), []);
    assert.deepStrictEqual(stayDatesOf("2026-06-05", "2026-06-01"), []);
    assert.deepStrictEqual(stayDatesOf(null, "2026-06-01"), []);
  });

  test("lastDayOfMonth", () => {
    assert.strictEqual(lastDayOfMonth(2026, 7), "2026-07-31");
    assert.strictEqual(lastDayOfMonth(2026, 2), "2026-02-28");
    assert.strictEqual(lastDayOfMonth(2028, 2), "2028-02-29");
  });
});

describe("国籍の22区分マッピング", () => {
  test("表記ゆれを吸収する", () => {
    for (const [raw, want] of [
      ["KOREA", "韓国"], ["korean", "韓国"], ["Republic of Korea", "韓国"],
      ["german", "ドイツ"], ["German", "ドイツ"], ["Germany", "ドイツ"],
      ["Hong Kong", "香港"], ["hongkong", "香港"],
      ["Italian", "イタリア"], ["USA", "米国"], ["American", "米国"], ["United States", "米国"],
      ["日本", "日本"], ["", "日本"], [null, "日本"], ["日本国", "日本"],
      ["イギリス", "英国"], ["アメリカ合衆国", "米国"], ["大韓民国", "韓国"],
    ]) {
      assert.strictEqual(resolveNationality(raw).label, want, `${raw} → ${want}`);
    }
  });

  test("★22区分に無い国は「その他」。主要国へ寄せない", () => {
    const r = resolveNationality("SWEDEN");
    assert.strictEqual(r.label, "その他");
    assert.strictEqual(r.matched, false, "変換表に無かったことを呼び出し側へ伝える");
    assert.strictEqual(resolveNationality("Brazil").label, "その他");
    assert.strictEqual(resolveNationality("Norway").label, "その他");
  });

  test("明示的な「その他」は未知扱いにしない", () => {
    assert.deepStrictEqual(resolveNationality("その他"), { label: "その他", matched: true });
  });
});

describe("報告期間", () => {
  test("★期限は偶数月の15日（翌月15日ではない）", () => {
    const ps = getReportPeriods(2026);
    const aug = ps.find((p) => p.id === "2026-08");
    assert.strictEqual(aug.deadline, "2026-08-15", "6・7月分の期限は8/15");
    assert.deepStrictEqual(aug.targetMonths, [{ year: 2026, month: 6 }, { year: 2026, month: 7 }]);
    assert.strictEqual(aug.periodStart, "2026-06-01");
    assert.strictEqual(aug.periodEnd, "2026-07-31");

    const oct = ps.find((p) => p.id === "2026-10");
    assert.strictEqual(oct.deadline, "2026-10-15", "8・9月分の期限は10/15");
  });

  test("2月報告は前年12月・当年1月が対象", () => {
    const feb = getReportPeriods(2026).find((p) => p.id === "2026-02");
    assert.deepStrictEqual(feb.targetMonths, [{ year: 2025, month: 12 }, { year: 2026, month: 1 }]);
    assert.strictEqual(feb.deadline, "2026-02-15");
  });

  test("★ポータルの報告期間表記（年度・ゼロ埋め・全角波ダッシュ）", () => {
    assert.strictEqual(portalPeriodLabel(2026, 6, 2026, 7), "2026年度06月～07月");
    assert.strictEqual(portalPeriodLabel(2026, 8, 2026, 9), "2026年度08月～09月");
    // 実機の一覧に「2025年度02月～03月」があった＝2026年2・3月は2025年度
    assert.strictEqual(portalPeriodLabel(2026, 2, 2026, 3), "2025年度02月～03月");
    assert.strictEqual(portalPeriodLabel(2026, 12, 2027, 1), "2026年度12月～01月");
    assert.strictEqual(fiscalYearOf(2026, 3), 2025);
    assert.strictEqual(fiscalYearOf(2026, 4), 2026);
  });
});

describe("★2026年6・7月の実データでポータル提出値を再現する", () => {
  const r = buildJissekiReport(ROWS_2026_06_07, "2026-06-01", "2026-07-31");

  test("宿泊日数 = 27", () => {
    assert.strictEqual(r.nissuu, 27);
    assert.strictEqual(r.stayDates.length, 27);
    assert.strictEqual(r.stayDates[0], "2026-06-01");
    assert.strictEqual(r.stayDates[r.stayDates.length - 1], "2026-07-25");
  });

  test("宿泊者数 = 85", () => {
    assert.strictEqual(r.guests, 85);
  });

  test("延べ人数 = 136", () => {
    assert.strictEqual(r.nobe, 136);
  });

  test("国籍別内訳が実提出値と一致し、合計が宿泊者数と一致する", () => {
    const want = { 日本: 58, 韓国: 7, 香港: 3, 中国: 1, ドイツ: 4, イタリア: 1, 米国: 7, その他: 4 };
    for (const n of NATIONALITY_GRID) {
      assert.strictEqual(r.byNationality[n], want[n] || 0, `${n} が不一致`);
    }
    const sum = NATIONALITY_GRID.reduce((a, n) => a + r.byNationality[n], 0);
    assert.strictEqual(sum, r.guests);
  });

  test("★「その他」の内訳に国名が残る（通知で人間が確認できるように）", () => {
    assert.deepStrictEqual(r.unknownNationalities, { SWEDEN: 4 });
  });

  test("人数と国籍の食い違いが無いので警告は出ない", () => {
    assert.deepStrictEqual(r.warnings, []);
  });
});

describe("報告期間でのクリップ", () => {
  test("期間をまたぐ予約は期間内の泊だけを数える", () => {
    const rows = [
      // 5/30→6/2 の宿泊日は 5/30・5/31・6/1（COは含まない）→ 期間内は 6/1 の1泊のみ
      { checkIn: "2026-05-30", checkOut: "2026-06-02", guestCount: 2, nationality: "日本", companions: [] },
      // 7/30→8/2 の宿泊日は 7/30・7/31・8/1 → 期間内は 7/30・7/31 の2泊
      { checkIn: "2026-07-30", checkOut: "2026-08-02", guestCount: 3, nationality: "日本", companions: [] },
    ];
    const r = buildJissekiReport(rows, "2026-06-01", "2026-07-31");
    assert.strictEqual(r.nissuu, 3, "6/1,7/30,7/31");
    assert.strictEqual(r.guests, 5, "期間内に宿泊した実人数は両方カウント");
    assert.strictEqual(r.nobe, 2 * 1 + 3 * 2);
  });

  test("期間外の予約は完全に無視される", () => {
    const r = buildJissekiReport(
      [{ checkIn: "2026-05-01", checkOut: "2026-05-03", guestCount: 2, nationality: "日本", companions: [] }],
      "2026-06-01", "2026-07-31"
    );
    assert.strictEqual(r.nissuu, 0);
    assert.strictEqual(r.guests, 0);
    assert.strictEqual(r.nobe, 0);
  });

  test("実績ゼロでも0の報告を作れる（届出済みは実績0でも報告義務がある）", () => {
    const r = buildJissekiReport([], "2026-08-01", "2026-09-30");
    assert.strictEqual(r.nissuu, 0);
    assert.strictEqual(r.guests, 0);
    assert.strictEqual(r.nobe, 0);
    assert.strictEqual(r.byNationality["日本"], 0);
    assert.deepStrictEqual(r.warnings, []);
  });

  test("同じ日に重なる予約でも宿泊日数は重複しない", () => {
    const rows = [
      { checkIn: "2026-06-01", checkOut: "2026-06-03", guestCount: 2, nationality: "日本", companions: [] },
      { checkIn: "2026-06-02", checkOut: "2026-06-04", guestCount: 1, nationality: "日本", companions: [] },
    ];
    const r = buildJissekiReport(rows, "2026-06-01", "2026-07-31");
    assert.strictEqual(r.nissuu, 3, "6/1,6/2,6/3 の3日");
    assert.strictEqual(r.nobe, 2 * 2 + 1 * 2);
  });

  test("宿泊人数と同行者の数が食い違うと警告を出す", () => {
    const r = buildJissekiReport(
      [{ checkIn: "2026-06-01", checkOut: "2026-06-02", guestCount: 5, nationality: "日本", companions: jp(1) }],
      "2026-06-01", "2026-07-31"
    );
    assert.strictEqual(r.guests, 2, "国籍の実データを正とする");
    assert.strictEqual(r.warnings.length, 1);
    assert.match(r.warnings[0], /宿泊人数5名に対し国籍が2名分/);
  });
});

describe("ポータル用CSV", () => {
  const r = buildJissekiReport(ROWS_2026_06_07, "2026-06-01", "2026-07-31");

  test("ヘッダーは28列。システムが文字列一致で判定するので変えない", () => {
    assert.strictEqual(CSV_HEADER.length, 28);
    assert.strictEqual(
      CSV_HEADER.join(","),
      "届出番号,報告期間,宿泊日数,宿泊者数,宿泊延べ人数,日本,韓国,台湾,香港,中国,タイ,シンガポール,マレーシア,インドネシア,フィリピン,ベトナム,インド,英国,ドイツ,フランス,イタリア,スペイン,ロシア,米国,カナダ,オーストラリア,その他,宿泊日"
    );
  });

  test("データ行はヘッダーと同じ列数で、宿泊日はセミコロン区切り", () => {
    const row = toCsvRow("第M340055098号", "2026年度06月～07月", r);
    assert.strictEqual(row.length, CSV_HEADER.length);
    assert.strictEqual(row[0], "第M340055098号");
    assert.strictEqual(row[1], "2026年度06月～07月");
    assert.deepStrictEqual(row.slice(2, 5), ["27", "85", "136"]);
    assert.strictEqual(row[5], "58", "日本");
    assert.strictEqual(row[26], "4", "その他");
    assert.match(row[27], /^2026-06-01;2026-06-02;2026-06-06;/);
    assert.strictEqual(row[27].split(";").length, 27);
  });

  test("値にカンマが混入しない（クォート不要を保証）", () => {
    const row = toCsvRow("第M340055098号", "2026年度06月～07月", r);
    row.forEach((v, i) => assert.ok(!String(v).includes(","), `${CSV_HEADER[i]} にカンマ`));
  });

  test("CRLF区切り・複数届出を1ファイルにまとめられる", () => {
    const csv = toPortalCsv([
      toCsvRow("第M340055098号", "2026年度06月～07月", r),
      toCsvRow("第M999999999号", "2026年度06月～07月", buildJissekiReport([], "2026-06-01", "2026-07-31")),
    ]);
    const lines = csv.split("\r\n");
    assert.strictEqual(lines[0], CSV_HEADER.join(","));
    assert.strictEqual(lines.length, 4, "ヘッダー + 2行 + 末尾の空文字");
    assert.ok(lines[2].startsWith("第M999999999号,2026年度06月～07月,0,0,0,"), "実績0の行も出せる");
  });
});
