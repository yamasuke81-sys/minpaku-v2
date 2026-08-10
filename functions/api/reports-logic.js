/**
 * 定期報告（住宅宿泊事業法14条 事業実績報告）の純粋関数
 *
 * 民泊制度運営システムの『事業実績報告登録』画面／CSVアップロードへ投入する値を作る。
 * Firestore・HTTP・Drive には一切触らない。仕様の出典と実機で確認した挙動は
 * `.claude/rules/jisseki-report-automation-plan.md` を参照。
 *
 * 報告事項の定義（定期報告に係る留意事項）:
 *   宿泊日数   = 人を宿泊させた日数（宿泊日のユニーク集合の要素数）
 *   宿泊者数   = 実人数の合計。国籍別内訳の合計と必ず一致する
 *   延べ人数   = 各日の全宿泊者数の合計 = Σ(人数 × 報告期間内の泊数)
 */

// ポータルの国籍22区分。**この順序がCSVの列順**（実機の『事業実績報告登録』画面で確認済み）
const NATIONALITY_GRID = [
  "日本", "韓国", "台湾", "香港", "中国", "タイ", "シンガポール",
  "マレーシア", "インドネシア", "フィリピン", "ベトナム", "インド", "英国", "ドイツ",
  "フランス", "イタリア", "スペイン", "ロシア", "米国", "カナダ", "オーストラリア",
  "その他",
];

// CSVのヘッダー行。システムは**文字列一致でヘッダー行を判定する**ので1文字も変えない
const CSV_HEADER = [
  "届出番号", "報告期間", "宿泊日数", "宿泊者数", "宿泊延べ人数",
  ...NATIONALITY_GRID,
  "宿泊日",
];

// ===== 日付ユーティリティ =====
// 日付は YYYY-MM-DD の文字列のまま扱う。Date を経由すると
// `new Date("2026-07-01")`(UTC) と `new Date(2026,6,1)`(ローカル) が混ざり、
// 月をまたぐ予約の泊数が1日ズレる（2026-08-10 に実データで確認したバグ）。

function isDateStr(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** YYYY-MM-DD を n 日進める（UTC固定なのでタイムゾーンの影響を受けない） */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** 宿泊日の配列。チェックイン日を含み、チェックアウト日は含まない（＝泊数と一致） */
function stayDatesOf(checkIn, checkOut) {
  if (!isDateStr(checkIn) || !isDateStr(checkOut) || checkOut <= checkIn) return [];
  const out = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 400) break; // 異常データの暴走止め
  }
  return out;
}

/** 報告期間の末日（YYYY-MM-DD）。month は 1-12 */
function lastDayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month, 0));
  return `${year}-${String(month).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ===== 国籍 =====
// 22区分に無い国（スウェーデン等）は「その他」が正しい。主要国へ寄せてはいけない。
// 2026-08-10: 同行者4名の SWEDEN を「中国」に寄せた誤報告が実際に発生している。
const NATIONALITY_MAP = {
  japan: "日本", japanese: "日本", jpn: "日本", jp: "日本",
  korea: "韓国", korean: "韓国", "south korea": "韓国", "republic of korea": "韓国", kor: "韓国",
  taiwan: "台湾", taiwanese: "台湾", twn: "台湾",
  "hong kong": "香港", hongkong: "香港", hkg: "香港",
  china: "中国", chinese: "中国", chn: "中国", "p.r. china": "中国",
  thailand: "タイ", thai: "タイ", tha: "タイ",
  singapore: "シンガポール", singaporean: "シンガポール", sgp: "シンガポール",
  malaysia: "マレーシア", malaysian: "マレーシア", mys: "マレーシア",
  indonesia: "インドネシア", indonesian: "インドネシア", idn: "インドネシア",
  philippines: "フィリピン", philippine: "フィリピン", filipino: "フィリピン", phl: "フィリピン",
  vietnam: "ベトナム", vietnamese: "ベトナム", "viet nam": "ベトナム", vnm: "ベトナム",
  india: "インド", indian: "インド", ind: "インド",
  uk: "英国", "united kingdom": "英国", british: "英国", england: "英国", english: "英国",
  scotland: "英国", wales: "英国", gbr: "英国", "great britain": "英国",
  germany: "ドイツ", german: "ドイツ", deutschland: "ドイツ", deu: "ドイツ", ger: "ドイツ",
  france: "フランス", french: "フランス", fra: "フランス",
  italy: "イタリア", italian: "イタリア", italia: "イタリア", ita: "イタリア",
  spain: "スペイン", spanish: "スペイン", espana: "スペイン", esp: "スペイン",
  russia: "ロシア", russian: "ロシア", rus: "ロシア", "russian federation": "ロシア",
  usa: "米国", "u.s.a.": "米国", "united states": "米国", "united states of america": "米国",
  america: "米国", american: "米国", us: "米国", "u.s.": "米国",
  canada: "カナダ", canadian: "カナダ", can: "カナダ",
  australia: "オーストラリア", australian: "オーストラリア", aus: "オーストラリア",
};

// 日本語表記のゆれ（22区分の正式名以外の書かれ方）
const NATIONALITY_JA_ALIAS = {
  "大韓民国": "韓国", "韓国人": "韓国", "中華民国": "台湾", "台湾（中華民国）": "台湾",
  "中華人民共和国": "中国", "中国人": "中国", "ホンコン": "香港", "香港特別行政区": "香港",
  "アメリカ": "米国", "アメリカ合衆国": "米国", "米国（アメリカ）": "米国",
  "イギリス": "英国", "英国（イギリス）": "英国", "連合王国": "英国",
  "独逸": "ドイツ", "豪州": "オーストラリア", "オーストラリア連邦": "オーストラリア",
  "日本国": "日本",
};

/**
 * 国籍の生値を22区分へ寄せる。
 * @returns {{label: string, matched: boolean}} matched=false は「変換表に無く『その他』に落ちた」
 *   （22区分に無い国なら false でも正しい。通知で国名を明示するために使う）
 */
function resolveNationality(raw) {
  const n = String(raw == null ? "" : raw).trim();
  if (!n) return { label: "日本", matched: true }; // 未入力は日本人扱い（既存挙動）
  if (NATIONALITY_GRID.includes(n)) return { label: n, matched: true };
  if (NATIONALITY_JA_ALIAS[n]) return { label: NATIONALITY_JA_ALIAS[n], matched: true };
  if (n.includes("日本")) return { label: "日本", matched: true };

  const lower = n.toLowerCase().replace(/[.　]/g, (c) => (c === "　" ? " " : ".")).trim();
  if (NATIONALITY_MAP[lower]) return { label: NATIONALITY_MAP[lower], matched: true };

  // 部分一致（"Republic of Korea" 等）。短いキーは誤爆するので4文字以上に限る
  for (const [eng, jpn] of Object.entries(NATIONALITY_MAP)) {
    if (eng.length >= 4 && lower.includes(eng)) return { label: jpn, matched: true };
  }
  return { label: "その他", matched: false };
}

/** 後方互換の薄いラッパ（ラベルだけ欲しい場合） */
function mapNationality(raw) {
  return resolveNationality(raw).label;
}

// ===== 報告期間 =====

/** 会計年度（4月開始）。2027年2月 → 2026年度 */
function fiscalYearOf(year, month) {
  return month >= 4 ? year : year - 1;
}

/**
 * ポータルの報告期間表記。実機の実データと一致させる。
 * 例) (2026,8,2026,9) → "2026年度08月～09月"（波ダッシュは U+FF5E）
 */
function portalPeriodLabel(year1, month1, year2, month2) {
  const fy = fiscalYearOf(year1, month1);
  return `${fy}年度${String(month1).padStart(2, "0")}月～${String(month2).padStart(2, "0")}月`;
}

/**
 * 報告期間の一覧。施行規則第12条2項:
 * 「毎年2,4,6,8,10,12月の15日までに、それぞれの月の前2月における事項を報告」
 * → 通知月 m（偶数）の対象は m-2 月・m-1 月、**期限は m 月15日**（翌月15日ではない）
 */
function getReportPeriods(year) {
  const periods = [];
  for (let m = 2; m <= 12; m += 2) {
    const month1 = m - 2 || 12;
    const month2 = m - 1 || 1;
    const year1 = m === 2 ? year - 1 : year;
    const year2 = m === 2 ? year : year;
    periods.push({
      id: `${year}-${String(m).padStart(2, "0")}`,
      targetMonths: [{ year: year1, month: month1 }, { year: year2, month: month2 }],
      periodStart: `${year1}-${String(month1).padStart(2, "0")}-01`,
      periodEnd: lastDayOfMonth(year2, month2),
      // 報告期限。**修正可能期限も同じ日**（報告期間の翌月15日 = この日）
      deadline: `${year}-${String(m).padStart(2, "0")}-15`,
      label: `${year1}年${month1}月・${year2}年${month2}月`,
      portalLabel: portalPeriodLabel(year1, month1, year2, month2),
    });
  }
  return periods;
}

// ===== 集計 =====

/**
 * 1予約の宿泊者の国籍リストを作る。
 * 同行者情報があれば1人ずつ、無ければ代表者の国籍 × 人数。
 */
function peopleOf(row) {
  const rep = row.nationality;
  const companions = Array.isArray(row.companions) ? row.companions : [];
  if (companions.length > 0) {
    return [rep, ...companions.map((c) => (c && c.nationality) || "")];
  }
  const n = Math.max(1, Number(row.guestCount) || 1);
  return new Array(n).fill(rep);
}

/**
 * 報告期間の集計を作る。
 * @param {Array} rows 予約明細 {checkIn, checkOut, guestCount, nationality, companions[], guestName}
 * @param {string} periodStart YYYY-MM-DD
 * @param {string} periodEnd   YYYY-MM-DD（当日を含む）
 */
function buildJissekiReport(rows, periodStart, periodEnd) {
  const byNationality = {};
  NATIONALITY_GRID.forEach((n) => (byNationality[n] = 0));

  const stayDateSet = new Set();
  const unknownNationalities = {}; // 「その他」に落ちた生の国名 → 人数
  const warnings = [];
  let guests = 0;
  let nobe = 0;
  const used = [];

  for (const row of rows || []) {
    const dates = stayDatesOf(row.checkIn, row.checkOut)
      .filter((d) => d >= periodStart && d <= periodEnd); // 報告期間でクリップ
    if (dates.length === 0) continue;

    const people = peopleOf(row);
    const declared = Number(row.guestCount) || people.length;
    if (people.length !== declared) {
      warnings.push(
        `${row.checkIn}〜${row.checkOut}（${row.guestName || "-"}）: 宿泊人数${declared}名に対し国籍が${people.length}名分。名簿の同行者情報を確認してください`
      );
    }

    for (const raw of people) {
      const { label, matched } = resolveNationality(raw);
      byNationality[label] += 1;
      if (!matched) {
        const key = String(raw || "").trim() || "(空欄)";
        unknownNationalities[key] = (unknownNationalities[key] || 0) + 1;
      }
    }

    guests += people.length;
    nobe += people.length * dates.length;
    dates.forEach((d) => stayDateSet.add(d));
    used.push({ ...row, nightsInPeriod: dates.length, personCount: people.length });
  }

  const stayDates = Array.from(stayDateSet).sort();
  const natSum = NATIONALITY_GRID.reduce((a, n) => a + byNationality[n], 0);
  if (natSum !== guests) {
    warnings.push(`国籍別の合計(${natSum})が宿泊者数(${guests})と一致しません`);
  }

  return {
    periodStart,
    periodEnd,
    nissuu: stayDates.length, // 宿泊日数
    guests,                   // 宿泊者数
    nobe,                     // 延べ人数
    byNationality,
    stayDates,
    unknownNationalities,     // {"SWEDEN": 4} のように「その他」の内訳
    warnings,
    details: used,
  };
}

/** CSVの1行分を組み立てる（届出番号・報告期間 + 集計結果） */
function toCsvRow(todokideNumber, portalLabel, report) {
  return [
    todokideNumber,
    portalLabel,
    String(report.nissuu),
    String(report.guests),
    String(report.nobe),
    ...NATIONALITY_GRID.map((n) => String(report.byNationality[n] || 0)),
    report.stayDates.join(";"),
  ];
}

/**
 * ポータルにアップロードするCSV本文を作る。
 * **Shift_JIS(cp932)・BOMなし・CRLF** で保存すること（UTF-8 BOM付きはヘッダーが認識されない）。
 * 複数の届出を1ファイルにまとめて同時報告できる。
 */
function toPortalCsv(rows) {
  const lines = [CSV_HEADER.join(","), ...rows.map((r) => r.join(","))];
  return lines.join("\r\n") + "\r\n";
}

module.exports = {
  NATIONALITY_GRID,
  CSV_HEADER,
  addDays,
  stayDatesOf,
  lastDayOfMonth,
  resolveNationality,
  mapNationality,
  fiscalYearOf,
  portalPeriodLabel,
  getReportPeriods,
  peopleOf,
  buildJissekiReport,
  toCsvRow,
  toPortalCsv,
};
