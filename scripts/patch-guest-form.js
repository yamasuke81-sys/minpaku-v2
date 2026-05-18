// guest-form.html を韓国語・中国語対応に拡張
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "public", "guest-form.html");
let src = fs.readFileSync(FILE, "utf8");

const { keys } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".tmp", "gf-ja.json"), "utf8"));
const trans = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".tmp", "gf-translated.json"), "utf8"));

function buildObj(items) {
  const lines = ["      {"];
  for (let i = 0; i < keys.length; i++) {
    const v = JSON.stringify(items[i]);
    lines.push(`        ${keys[i]}: ${v},`);
  }
  lines.push("      }");
  return lines.join("\n");
}

const koObj = buildObj(trans.ko);
const zhObj = buildObj(trans.zh);

// i18n.en 終わり (`      }` の閉じ括弧) の直後に ko/zh を追加
// 構造: const i18n = { ja: {...}, en: {...} };
// → 末尾の `      }\n    };` を探して `      },\n      ko: {...},\n      zh: {...}\n    };` に差し替える
const tail = src.match(/( {6}\},?\r?\n {4}\};)/);
if (!tail) { console.error("i18n の終端見つからず"); process.exit(1); }

// en の閉じ `      }` の前にカンマがない場合がある。en の閉じだけ補正してから ko/zh 追加
const tailIdx = tail.index;
const before = src.slice(0, tailIdx);
const after  = src.slice(tailIdx + tail[1].length);

// 末尾を組み立て直す: en の閉じ`      },` + ko + , + zh + `    };`
const newTail = `      },\n      ko: ${koObj.trimStart()},\n      zh: ${zhObj.trimStart()}\n    };`;

src = before + newTail + after;

// 言語ボタン追加 (en の直後に ko / zh ボタンを追加)
src = src.replace(
  /(<button class="btn btn-sm btn-outline-light" data-lang="en">English<\/button>)/,
  `$1
        <button class="btn btn-sm btn-outline-light" data-lang="ko">한국어</button>
        <button class="btn btn-sm btn-outline-light" data-lang="zh">中文</button>`
);

// 言語別インライン分岐 (currentLang === "en" ? X : Y) のパターンを 4 言語対応に置換
//   - ja の文言は Y、en の文言は X、ko/zh は en 同等にフォールバック
// 該当するインライン箇所はあらかじめ手で更新するため、自動置換は最小限にとどめる
// → applyLang() 内の言語決定だけ正規化する追加処理は不要 (currentLang は既に 4 値 OK)

// `currentLang === "en"` のままだと ko/zh で「ja扱い」になるので、`currentLang !== "ja"` (非日本語) 判定に統一
// インライン文言は別途 i18n に取り込み、currentLang での三項分岐は撤去するのが理想だが、
// 当面は「非日本語 = 英語フォールバック」で動作を保つため、`currentLang === "en"` → `currentLang !== "ja"` に置換
src = src.replace(/currentLang === "en"/g, 'currentLang !== "ja"');
src = src.replace(/currentLang === 'en'/g, "currentLang !== 'ja'");

fs.writeFileSync(FILE, src);
console.log("guest-form.html パッチ完了");
