// yado-komachi-hiroshima.html の class="...jp..." 要素を全抽出
// 内部に他のタグを含まない (シンプルなテキストのみの) 要素を対象とする
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "public", "guides", "yado-komachi-hiroshima.html"), "utf8");

// パターン: <TAG ... class="...jp..." ...>CONTENT</TAG>  ※ CONTENT は <jp 子タグ含まない>
// ここでは tag 名 = h1|h2|h3|h4|p|span|div|a|li 等を許容、CONTENT は < を含まないものに限る
const re = /<(\w+)([^>]*\bclass="([^"]*\bjp\b[^"]*)"[^>]*)>([^<]+)<\/\1>/g;
const items = [];
let m;
while ((m = re.exec(src)) !== null) {
  items.push({
    tag: m[1],
    attrs: m[2], // class 属性含む全 attribute 文字列
    classAttr: m[3], // class の中身
    content: m[4],
    start: m.index,
    end: m.index + m[0].length,
    full: m[0],
  });
}

const itemsOnly = items.map(x => x.content);
process.stdout.write(JSON.stringify({ items: itemsOnly, meta: items.map(x => ({ tag: x.tag, classAttr: x.classAttr, start: x.start, end: x.end, full: x.full, content: x.content })) }, null, 2));
