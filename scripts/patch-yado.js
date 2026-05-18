// yado-komachi-hiroshima.html を韓国語・中国語対応に拡張
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "public", "guides", "yado-komachi-hiroshima.html");
let src = fs.readFileSync(FILE, "utf8");

const { items, meta } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".tmp", "y-ja.json"), "utf8"));
const trans = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".tmp", "y-translated.json"), "utf8"));

// 各 .jp 要素を、その content を ko/zh に置き換えた兄弟要素 (ko-only / zh-only) を直後に挿入する
// 後ろから処理してオフセット崩れを防ぐ
const sorted = [...meta.map((m, i) => ({ ...m, ko: trans.ko[i], zh: trans.zh[i] }))].sort((a, b) => b.start - a.start);

for (const m of sorted) {
  // m.classAttr 内の "jp" を "ko-only" / "zh-only" に置換した attrs を作る
  const koClassAttr = m.classAttr.replace(/\bjp\b/, "ko-only");
  const zhClassAttr = m.classAttr.replace(/\bjp\b/, "zh-only");
  // m.full の class="..." を新しい class に差し替え、content も置換
  // m.full = <tag attrsBefore class="..." attrsAfter>content</tag>
  // 簡単に: m.full の class="..." 部分を新 classAttr に、content 部分を新 content に置換
  function rebuild(newClassAttr, newContent) {
    let out = m.full;
    out = out.replace(/class="[^"]*"/, `class="${newClassAttr}"`);
    // content を置換 (open tag の > と </ の間)
    out = out.replace(/(>)([^<]+)(<\/)/, `$1${newContent.replace(/\$/g, "$$$$")}$3`);
    return out;
  }
  const koEl = rebuild(koClassAttr, m.ko);
  const zhEl = rebuild(zhClassAttr, m.zh);
  // 元の m.full の直後に挿入
  const insertAt = m.end;
  src = src.slice(0, insertAt) + koEl + zhEl + src.slice(insertAt);
}

// CSS の書き換え:
// 既存:
//   body.lang-en .jp { display: none; }
//   body:not(.lang-en) .en-only { display: none; }
// 新:
//   .jp, .en-only, .ko-only, .zh-only { display: none; }
//   body.lang-ja .jp,
//   body.lang-en .en-only,
//   body.lang-ko .ko-only,
//   body.lang-zh .zh-only { display: revert; }
src = src.replace(
  /body\.lang-en \.jp \{ display: none; \}\s*body:not\(\.lang-en\) \.en-only \{ display: none; \}/,
  `.jp, .en-only, .ko-only, .zh-only { display: none; }
    body.lang-ja .jp,
    body.lang-en .en-only,
    body.lang-ko .ko-only,
    body.lang-zh .zh-only { display: revert; }`
);

// 言語ボタン追加
src = src.replace(
  /(<button data-lang="en">EN<\/button>)/,
  `$1
  <button data-lang="ko">한국어</button>
  <button data-lang="zh">中文</button>`
);

// body の初期 class に lang-ja を付与 (なければ追加)
if (/<body[^>]*class="[^"]*"/.test(src)) {
  src = src.replace(/<body([^>]*)class="([^"]*)"/, (_, before, cls) => {
    return `<body${before}class="${cls} lang-ja"`;
  });
} else {
  src = src.replace(/<body([^>]*)>/, `<body$1 class="lang-ja">`);
}

// JS の lang-switch ロジックを 4 言語対応に書き換え
// 既存ロジックを丸ごと置換
src = src.replace(
  /document\.querySelectorAll\('\.lang-switch button'\)\.forEach\(btn => \{[\s\S]*?\}\);[\s\S]*?\}\);/,
  `document.querySelectorAll('.lang-switch button').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      document.body.classList.remove('lang-ja','lang-en','lang-ko','lang-zh');
      document.body.classList.add('lang-' + lang);
      document.documentElement.lang = lang;
      document.querySelectorAll('.lang-switch button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });`
);

fs.writeFileSync(FILE, src);
console.log("yado-komachi-hiroshima.html パッチ完了");
