// 既に ja/en/ko/zh 対応済みの 3 ファイルに 繁體中文 (台湾華語) を追加
// 言語コード: 'tw' (短縮形、CSS/data-lang 共通)
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "..", "public");
const TMP = path.join(__dirname, "..", ".tmp");

// ============================================================
// 1) guest-form.html
// ============================================================
{
  const FILE = path.join(PUB, "guest-form.html");
  let src = fs.readFileSync(FILE, "utf8");
  const { keys } = JSON.parse(fs.readFileSync(path.join(TMP, "gf-ja.json"), "utf8"));
  const tw = JSON.parse(fs.readFileSync(path.join(TMP, "gf-zhtw.json"), "utf8"))["zh-TW"];

  // tw object 構築
  const objLines = ["{"];
  for (let i = 0; i < keys.length; i++) {
    objLines.push(`        ${keys[i]}: ${JSON.stringify(tw[i])},`);
  }
  objLines.push("      }");
  const twObj = objLines.join("\n");

  // zh: {...}, の閉じ }( + comma) の後ろに tw を追加
  // zh ブロックの末尾を探す: i18n 内最後の `      }\n    };` の直前に `,\n      tw: {...}` 挿入
  src = src.replace(/( {6}\}\n {4}\};)/, (m) => `      },\n      tw: ${twObj}\n    };`);

  // ボタン追加
  src = src.replace(
    /(<button class="btn btn-sm btn-outline-light" data-lang="zh">中文<\/button>)/,
    `$1
        <button class="btn btn-sm btn-outline-light" data-lang="tw">繁體中文</button>`
  );

  fs.writeFileSync(FILE, src);
  console.log("guest-form.html: tw 追加完了");
}

// ============================================================
// 2) terrace-nagahama.html
// ============================================================
{
  const FILE = path.join(PUB, "guides", "the-terrace-nagahama.html");
  let src = fs.readFileSync(FILE, "utf8");
  const tw = JSON.parse(fs.readFileSync(path.join(TMP, "t-zhtw.json"), "utf8"))["zh-TW"];

  // translations 配列を読み、6 列目に tw を追加
  const m = src.match(/(  const translations\s*=\s*)(\[[\s\S]*?\n\s*\]);/);
  if (!m) throw new Error("terrace: translations 見つからず");
  const arr = eval(m[2]);
  if (arr.length !== tw.length) throw new Error(`terrace: 長さ不一致 ${arr.length} vs ${tw.length}`);
  const lines = ["  const translations = ["];
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i];
    lines.push(`    [${JSON.stringify(row[0])}, ${JSON.stringify(row[1])}, ${JSON.stringify(row[2])}, ${JSON.stringify(row[3])}, ${JSON.stringify(row[4])}, ${JSON.stringify(tw[i])}],`);
  }
  lines.push("  ];");
  src = src.replace(/  const translations\s*=\s*\[[\s\S]*?\n\s*\];/, lines.join("\n"));

  // langIdx に tw: 5 追加
  src = src.replace(
    /const langIdx = \{ ja: 1, en: 2, ko: 3, zh: 4 \};/,
    "const langIdx = { ja: 1, en: 2, ko: 3, zh: 4, tw: 5 };"
  );

  // ボタン追加
  src = src.replace(
    /(<button class="btn btn-sm btn-outline-light" data-lang="zh" onclick="setLang\('zh'\)">中文<\/button>)/,
    `$1
      <button class="btn btn-sm btn-outline-light" data-lang="tw" onclick="setLang('tw')">繁體中文</button>`
  );

  // SPOT_NAMES に tw 追加
  src = src.replace(
    /spot1:  \{ ja: '1番',\s+en: 'Spot 1',\s+ko: '1번',\s+zh: '1号' \},/,
    "spot1:  { ja: '1番',             en: 'Spot 1',           ko: '1번',           zh: '1号',           tw: '1號' },"
  );
  src = src.replace(
    /spot5:  \{ ja: '5番',\s+en: 'Spot 5',\s+ko: '5번',\s+zh: '5号' \},/,
    "spot5:  { ja: '5番',             en: 'Spot 5',           ko: '5번',           zh: '5号',           tw: '5號' },"
  );
  src = src.replace(
    /unpaved:\{ ja: '未舗装駐車場',\s+en: 'Unpaved lot',\s+ko: '비포장 주차장', zh: '未铺装停车场' \},/,
    "unpaved:{ ja: '未舗装駐車場',    en: 'Unpaved lot',      ko: '비포장 주차장', zh: '未铺装停车场', tw: '未鋪裝停車場' },"
  );
  src = src.replace(
    /paid:   \{ ja: '有料駐車場（カフェ）', en: 'Paid parking \(Cafe\)', ko: '유료 주차장 \(카페\)', zh: '收费停车场（咖啡馆）' \}/,
    "paid:   { ja: '有料駐車場（カフェ）', en: 'Paid parking (Cafe)', ko: '유료 주차장 (카페)', zh: '收费停车场（咖啡馆）', tw: '收費停車場（咖啡廳）' }"
  );

  // ALLOC_I18N に tw 追加
  src = src.replace(
    /(title:\s+\{ ja: '🅿️ あなた専用の駐車場割当', en: '🅿️ Your Assigned Parking',\s+ko: '🅿️ 전용 주차장 배정',\s+zh: '🅿️ 您的专属停车位' \},)/,
    `title:       { ja: '🅿️ あなた専用の駐車場割当', en: '🅿️ Your Assigned Parking',
                   ko: '🅿️ 전용 주차장 배정',           zh: '🅿️ 您的专属停车位',
                   tw: '🅿️ 您的專屬停車位' },`
  );
  src = src.replace(
    /(noCar:\s+\{ ja: '駐車場のご利用予定はありません（車以外でお越しの場合）',\s+en: 'No parking reserved \(if arriving without a car\)',\s+ko: '주차장 이용 예정 없음 \(차량 외 수단으로 오시는 경우\)',\s+zh: '无停车场使用计划（不开车前往的情况）' \},)/,
    `noCar:       { ja: '駐車場のご利用予定はありません（車以外でお越しの場合）',
                   en: 'No parking reserved (if arriving without a car)',
                   ko: '주차장 이용 예정 없음 (차량 외 수단으로 오시는 경우)',
                   zh: '无停车场使用计划（不开车前往的情况）',
                   tw: '無停車場使用計畫（搭乘非車輛交通工具前來時）' },`
  );
  src = src.replace(
    /(guestsUnit:\s+\{ ja: \(n\) => `\$\{n\}名様`,\s+en: \(n\) => `\$\{n\} guest\$\{n===1\?'':'s'\}`,\s+ko: \(n\) => `\$\{n\}명`,\s+zh: \(n\) => `\$\{n\}位` \},)/,
    `guestsUnit:  { ja: (n) => \`\${n}名様\`,
                   en: (n) => \`\${n} guest\${n===1?'':'s'}\`,
                   ko: (n) => \`\${n}명\`,
                   zh: (n) => \`\${n}位\`,
                   tw: (n) => \`\${n}位\` },`
  );
  src = src.replace(
    /(bbq:\s+\{ ja: '✅ BBQ ご予約済み',\s+en: '✅ BBQ reserved',\s+ko: '✅ BBQ 예약 완료',\s+zh: '✅ 已预订 BBQ' \},)/,
    `bbq:         { ja: '✅ BBQ ご予約済み',  en: '✅ BBQ reserved',
                   ko: '✅ BBQ 예약 완료',  zh: '✅ 已预订 BBQ',
                   tw: '✅ 已預訂 BBQ' },`
  );
  src = src.replace(
    /(paidParking:\s+\{ ja: '✅ 有料駐車場（カフェ）利用予定',\s+en: '✅ Paid parking \(Cafe\) reserved',\s+ko: '✅ 유료 주차장 \(카페\) 이용 예정',\s+zh: '✅ 计划使用收费停车场（咖啡馆）' \},)/,
    `paidParking: { ja: '✅ 有料駐車場（カフェ）利用予定',
                   en: '✅ Paid parking (Cafe) reserved',
                   ko: '✅ 유료 주차장 (카페) 이용 예정',
                   zh: '✅ 计划使用收费停车场（咖啡馆）',
                   tw: '✅ 預計使用收費停車場（咖啡廳）' },`
  );
  src = src.replace(
    /(bedChoice:\s+\{ ja: \(c\) => `✅ ベッド希望: \$\{c\}`,\s+en: \(c\) => `✅ Bed preference: \$\{c\}`,\s+ko: \(c\) => `✅ 침대 선호: \$\{c\}`,\s+zh: \(c\) => `✅ 床位偏好: \$\{c\}` \})/,
    `bedChoice:   { ja: (c) => \`✅ ベッド希望: \${c}\`,
                   en: (c) => \`✅ Bed preference: \${c}\`,
                   ko: (c) => \`✅ 침대 선호: \${c}\`,
                   zh: (c) => \`✅ 床位偏好: \${c}\`,
                   tw: (c) => \`✅ 床位偏好: \${c}\` }`
  );

  // renderAllocationCard 内の lang 判定
  src = src.replace(
    /\['en','ko','zh'\]\.includes\(currentLang\)/g,
    "['en','ko','zh','tw'].includes(currentLang)"
  );

  // pwLabelMap に tw 追加
  src = src.replace(
    /const pwLabelMap = \{ ja: 'パスワード', en: 'Password', ko: '비밀번호', zh: '密码' \};/,
    "const pwLabelMap = { ja: 'パスワード', en: 'Password', ko: '비밀번호', zh: '密码', tw: '密碼' };"
  );

  // clipboard msgMap に tw 追加
  src = src.replace(
    /zh: '无法复制。请手动复制。'\s*\};/,
    `zh: '无法复制。请手动复制。',
          tw: '無法複製。請手動複製。'
        };`
  );

  fs.writeFileSync(FILE, src);
  console.log("the-terrace-nagahama.html: tw 追加完了");
}

// ============================================================
// 3) yado-komachi-hiroshima.html
// ============================================================
{
  const FILE = path.join(PUB, "guides", "yado-komachi-hiroshima.html");
  let src = fs.readFileSync(FILE, "utf8");
  const { meta } = JSON.parse(fs.readFileSync(path.join(TMP, "y-ja.json"), "utf8"));
  const tw = JSON.parse(fs.readFileSync(path.join(TMP, "y-zhtw.json"), "utf8"))["zh-TW"];
  if (meta.length !== tw.length) throw new Error(`yado: 長さ不一致 ${meta.length} vs ${tw.length}`);

  // ヒューリスティック: 各 ko-only 要素の content を tw のものに置換した tw-only を挿入
  // → 既存の zh-only 要素 (簡体字) の直後に tw-only を挿入する方が確実
  // 既存 zh-only の位置から、対応する index を逆引きするのは難しいので、jp content をキーにする

  // jp content から index を引くマップ
  const jpToIdx = new Map();
  meta.forEach((m, i) => {
    if (!jpToIdx.has(m.content)) jpToIdx.set(m.content, i);
  });

  // 既存パッチで挿入されたパターン: <TAG class="ko-only">ko</TAG><TAG class="zh-only">zh</TAG>
  // → これらの zh-only の直後に <TAG class="tw-only">tw</TAG> を挿入する
  // 戦略: 既存 ko-only 要素を見つけ、その content を ja text に逆引きするのは難しいので、
  //       「全 jp 要素 (class="jp") を順序通り走査し、それぞれの直後の zh-only を見つけて
  //        その直後に tw-only を挿入する」アプローチを取る

  // よりシンプル: 各 jp 要素の直後にすでにある {ko-only}{zh-only} の塊を見つけて、その後ろに tw-only 追加
  // 正規表現で `<(TAG)([^>]*class="[^"]*\bjp\b[^"]*)"([^>]*)>([^<]+)</\1><(\w+)([^>]*\bko-only\b[^>]*)>([^<]+)</\5><(\w+)([^>]*\bzh-only\b[^>]*)>([^<]+)</\8>` を探す

  // 後ろから処理
  const re = /<(\w+)([^>]*\bjp\b[^>]*)>([^<]+)<\/\1><(\w+)([^>]*\bko-only\b[^>]*)>([^<]+)<\/\4><(\w+)([^>]*\bzh-only\b[^>]*)>([^<]+)<\/\7>/g;
  const matches = [];
  let mm;
  while ((mm = re.exec(src)) !== null) matches.push(mm);

  // 後ろから挿入
  for (let i = matches.length - 1; i >= 0; i--) {
    const mm2 = matches[i];
    const jpContent = mm2[3];
    const idx = jpToIdx.get(jpContent);
    if (idx === undefined) continue; // 対応する翻訳がない
    const twText = tw[idx];
    // zh-only と同じタグ・属性を使い、class の zh-only を tw-only に置換
    const zhTag = mm2[7];
    const zhAttrs = mm2[8];
    const twAttrs = zhAttrs.replace(/\bzh-only\b/, "tw-only");
    const twEl = `<${zhTag}${twAttrs}>${twText}</${zhTag}>`;
    const insertAt = mm2.index + mm2[0].length;
    src = src.slice(0, insertAt) + twEl + src.slice(insertAt);
  }

  // CSS: tw-only を表示制御に追加
  src = src.replace(
    /\.jp, \.en-only, \.ko-only, \.zh-only \{ display: none; \}\s*body\.lang-ja \.jp,\s*body\.lang-en \.en-only,\s*body\.lang-ko \.ko-only,\s*body\.lang-zh \.zh-only \{ display: revert; \}/,
    `.jp, .en-only, .ko-only, .zh-only, .tw-only { display: none; }
    body.lang-ja .jp,
    body.lang-en .en-only,
    body.lang-ko .ko-only,
    body.lang-zh .zh-only,
    body.lang-tw .tw-only { display: revert; }`
  );

  // ボタン追加
  src = src.replace(
    /(<button data-lang="zh">中文<\/button>)/,
    `$1
  <button data-lang="tw">繁體中文</button>`
  );

  // JS の classList.remove に lang-tw 追加
  src = src.replace(
    /document\.body\.classList\.remove\('lang-ja','lang-en','lang-ko','lang-zh'\);/,
    "document.body.classList.remove('lang-ja','lang-en','lang-ko','lang-zh','lang-tw');"
  );

  fs.writeFileSync(FILE, src);
  console.log("yado-komachi-hiroshima.html: tw 追加完了");
}
