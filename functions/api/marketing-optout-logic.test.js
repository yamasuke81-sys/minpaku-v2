/**
 * marketing-optout-logic 純粋関数の単体テスト
 * 実行: node --test functions/api/marketing-optout-logic.test.js
 *
 * 配信停止リンクのトークンは「他人を勝手に停止させられない」ことが要点なので、
 * 改竄パターンを重点的に検証する。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  normalizeEmail,
  emailKey,
  buildOptoutToken,
  parseOptoutToken,
} = require("./marketing-optout-logic");

// 検証用の鍵は実行ごとに生成する（特定の鍵に依存しないことの確認も兼ねる）
const SECRET = require("node:crypto").randomBytes(32).toString("hex");

describe("marketing-optout-logic", () => {
  test("正しいトークンはメールアドレスに戻る", () => {
    const t = buildOptoutToken("guest@example.com", SECRET);
    assert.strictEqual(parseOptoutToken(t, SECRET), "guest@example.com");
  });

  test("大文字・前後の空白は正規化され同じトークンになる", () => {
    const a = buildOptoutToken("  Guest@Example.COM ", SECRET);
    const b = buildOptoutToken("guest@example.com", SECRET);
    assert.strictEqual(a, b);
    assert.strictEqual(parseOptoutToken(a, SECRET), "guest@example.com");
  });

  test("署名を改竄したトークンは通らない", () => {
    const [b64] = buildOptoutToken("guest@example.com", SECRET).split(".");
    assert.strictEqual(parseOptoutToken(`${b64}.xxxxxxxxxxxxxxxxxxxxxx`, SECRET), null);
  });

  test("★他人のアドレスに差し替えたトークンは通らない", () => {
    const [, sig] = buildOptoutToken("guest@example.com", SECRET).split(".");
    const victim = Buffer.from("victim@example.com", "utf8").toString("base64url");
    assert.strictEqual(parseOptoutToken(`${victim}.${sig}`, SECRET), null);
  });

  test("鍵が違えば通らない", () => {
    const t = buildOptoutToken("guest@example.com", SECRET);
    assert.strictEqual(parseOptoutToken(t, "別の鍵"), null);
  });

  test("壊れた入力でも例外を投げず null を返す", () => {
    for (const bad of [null, undefined, "", "....", "abc", "a.b.c", "@@@.xxx"]) {
      assert.strictEqual(parseOptoutToken(bad, SECRET), null);
    }
  });

  test("署名長が違っても例外にならない (timingSafeEqual のガード)", () => {
    const [b64] = buildOptoutToken("guest@example.com", SECRET).split(".");
    assert.strictEqual(parseOptoutToken(`${b64}.short`, SECRET), null);
  });

  test("鍵が空ならトークンを作らない/通さない", () => {
    assert.throws(() => buildOptoutToken("guest@example.com", ""));
    assert.strictEqual(parseOptoutToken("x.y", ""), null);
  });

  test("メールアドレスとして成立しないものは拒否", () => {
    assert.throws(() => buildOptoutToken("noatmark", SECRET));
  });

  test("停止リストのIDは正規化後のアドレスで一意・固定長", () => {
    assert.strictEqual(emailKey(" Guest@Example.com "), emailKey("guest@example.com"));
    assert.strictEqual(emailKey("guest@example.com").length, 40);
    assert.notStrictEqual(emailKey("a@example.com"), emailKey("b@example.com"));
  });

  test("normalizeEmail は null/undefined でも落ちない", () => {
    assert.strictEqual(normalizeEmail(null), "");
    assert.strictEqual(normalizeEmail(undefined), "");
  });

  test("日本語を含むアドレスでも往復できる", () => {
    const e = "ゲスト@example.com";
    assert.strictEqual(parseOptoutToken(buildOptoutToken(e, SECRET), SECRET), e);
  });

  test("トークンにURLで壊れる文字が入らない (base64url)", () => {
    const t = buildOptoutToken("guest+tag@example.com", SECRET);
    assert.ok(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t), `URL非安全な文字が含まれる: ${t}`);
    assert.strictEqual(parseOptoutToken(t, SECRET), "guest+tag@example.com");
  });
});
