// terrace-nagahama.html を韓国語・中国語対応に拡張
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "public", "guides", "the-terrace-nagahama.html");
let src = fs.readFileSync(FILE, "utf8");

const { items, meta } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".tmp", "t-ja.json"), "utf8"));
const trans = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".tmp", "t-translated.json"), "utf8"));

// 新しい translations 配列を構築 [selector, ja, en, ko, zh]
const lines = ["  const translations = ["];
for (let i = 0; i < items.length; i++) {
  const sel = JSON.stringify(meta[i].selector);
  const ja = JSON.stringify(items[i]);
  const en = JSON.stringify(meta[i].en);
  const ko = JSON.stringify(trans.ko[i]);
  const zh = JSON.stringify(trans.zh[i]);
  lines.push(`    [${sel}, ${ja}, ${en}, ${ko}, ${zh}],`);
}
lines.push("  ];");
const newArr = lines.join("\n");

// 既存の translations 配列を置換
src = src.replace(/  const translations\s*=\s*\[[\s\S]*?\n\s*\];/, newArr);

// 言語ボタン追加: en の右に ko, zh を追加
src = src.replace(
  /(<button class="btn btn-sm btn-outline-light" data-lang="en" onclick="setLang\('en'\)">English<\/button>)/,
  `$1
      <button class="btn btn-sm btn-outline-light" data-lang="ko" onclick="setLang('ko')">한국어</button>
      <button class="btn btn-sm btn-outline-light" data-lang="zh" onclick="setLang('zh')">中文</button>`
);

// applyLang 関数を 4 言語対応に書き換え
// 既存:
//   document.documentElement.lang = currentLang === 'en' ? 'en' : 'ja';
//   const idx = currentLang === 'en' ? 2 : 1;
// 新:
//   const langIdx = { ja: 1, en: 2, ko: 3, zh: 4 };
//   document.documentElement.lang = currentLang;
//   const idx = langIdx[currentLang] || 1;
src = src.replace(
  /document\.documentElement\.lang = currentLang === 'en' \? 'en' : 'ja';\s*\/\* テキスト差し替え \*\/\s*const idx = currentLang === 'en' \? 2 : 1;/,
  `const langIdx = { ja: 1, en: 2, ko: 3, zh: 4 };
    document.documentElement.lang = currentLang;
    /* テキスト差し替え */
    const idx = langIdx[currentLang] || 1;`
);

// Wi-Fi password ラベル (フォールバック)
// pwLabel[1].textContent = currentLang === 'en' ? 'Password' : 'パスワード';
src = src.replace(
  /if \(pwLabel\.length >= 2\) pwLabel\[1\]\.textContent = currentLang === 'en' \? 'Password' : 'パスワード';/,
  `if (pwLabel.length >= 2) {
      const pwLabelMap = { ja: 'パスワード', en: 'Password', ko: '비밀번호', zh: '密码' };
      pwLabel[1].textContent = pwLabelMap[currentLang] || 'パスワード';
    }`
);

// クリップボードエラー
// alert(currentLang === 'en' ? 'Could not copy. Please copy manually.' : 'コピーできませんでした。手動でコピーしてください。');
src = src.replace(
  /alert\(currentLang === 'en' \? 'Could not copy\. Please copy manually\.' : 'コピーできませんでした。手動でコピーしてください。'\);/,
  `{
        const msgMap = {
          ja: 'コピーできませんでした。手動でコピーしてください。',
          en: 'Could not copy. Please copy manually.',
          ko: '복사할 수 없습니다. 수동으로 복사해 주세요.',
          zh: '无法复制。请手动复制。'
        };
        alert(msgMap[currentLang] || msgMap.ja);
      }`
);

// SPOT_NAMES / ALLOC_I18N を 4 言語対応に拡張 (ja/en に加え ko/zh を追加)
src = src.replace(
  /const SPOT_NAMES = \{[\s\S]*?\n\s*\};/,
  `const SPOT_NAMES = {
    spot1:  { ja: '1番',             en: 'Spot 1',           ko: '1번',           zh: '1号' },
    spot5:  { ja: '5番',             en: 'Spot 5',           ko: '5번',           zh: '5号' },
    unpaved:{ ja: '未舗装駐車場',    en: 'Unpaved lot',      ko: '비포장 주차장', zh: '未铺装停车场' },
    paid:   { ja: '有料駐車場（カフェ）', en: 'Paid parking (Cafe)', ko: '유료 주차장 (카페)', zh: '收费停车场（咖啡馆）' }
  };`
);

src = src.replace(
  /const ALLOC_I18N = \{[\s\S]*?\n\s*\};/,
  `const ALLOC_I18N = {
    title:       { ja: '🅿️ あなた専用の駐車場割当', en: '🅿️ Your Assigned Parking',
                   ko: '🅿️ 전용 주차장 배정',           zh: '🅿️ 您的专属停车位' },
    noCar:       { ja: '駐車場のご利用予定はありません（車以外でお越しの場合）',
                   en: 'No parking reserved (if arriving without a car)',
                   ko: '주차장 이용 예정 없음 (차량 외 수단으로 오시는 경우)',
                   zh: '无停车场使用计划（不开车前往的情况）' },
    guestsUnit:  { ja: (n) => \`\${n}名様\`,
                   en: (n) => \`\${n} guest\${n===1?'':'s'}\`,
                   ko: (n) => \`\${n}명\`,
                   zh: (n) => \`\${n}位\` },
    bbq:         { ja: '✅ BBQ ご予約済み',  en: '✅ BBQ reserved',
                   ko: '✅ BBQ 예약 완료',  zh: '✅ 已预订 BBQ' },
    paidParking: { ja: '✅ 有料駐車場（カフェ）利用予定',
                   en: '✅ Paid parking (Cafe) reserved',
                   ko: '✅ 유료 주차장 (카페) 이용 예정',
                   zh: '✅ 计划使用收费停车场（咖啡馆）' },
    bedChoice:   { ja: (c) => \`✅ ベッド希望: \${c}\`,
                   en: (c) => \`✅ Bed preference: \${c}\`,
                   ko: (c) => \`✅ 침대 선호: \${c}\`,
                   zh: (c) => \`✅ 床位偏好: \${c}\` }
  };`
);

// renderAllocationCard 内の lang 判定
// const lang = (typeof currentLang !== 'undefined' && currentLang === 'en') ? 'en' : 'ja';
// → 4言語対応:
src = src.replace(
  /const lang = \(typeof currentLang !== 'undefined' && currentLang === 'en'\) \? 'en' : 'ja';/g,
  `const lang = (typeof currentLang !== 'undefined' && ['en','ko','zh'].includes(currentLang)) ? currentLang : 'ja';`
);

fs.writeFileSync(FILE, src);
console.log("terrace-nagahama.html パッチ完了");
