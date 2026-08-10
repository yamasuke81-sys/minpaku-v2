/**
 * 事業実績報告（住宅宿泊事業法14条 定期報告）の自動化
 *
 * v2の /reports/portal-report で集計 → 民泊制度運営システム用CSVを作り、
 * Discordの「✅ 登録する」ワンタップで『事業実績アップロード』へ投入・登録まで行う。
 *
 * 使い方:
 *   node jisseki-report.mjs             … 報告期間(偶数月1〜15日)なら数字を提示。それ以外は無音
 *   node jisseki-report.mjs --upload    … CSVを投入して登録まで実行（ボタンから呼ばれる）
 *   node jisseki-report.mjs --check     … 期間外でも状況を表示（点検用）
 *   node jisseki-report.mjs --csv-only  … CSVを書き出すだけ（投入しない）
 *   オプション: --period YYYY-MM / --force（期間ゲート無視） / --dry
 *
 * 仕様の出典・実機で確認した挙動は minpaku-v2/.claude/rules/jisseki-report-automation-plan.md
 * ★登録は取り消せない。報告期間の翌月15日（＝報告期限と同日）までしか修正できないので、
 *   完全自動送信はしない。必ずやますけのボタン承認を挟む。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

const API = "https://api-5qrfx7ujcq-an.a.run.app"
const PORTAL_UPLOAD = "https://www.minpaku.mlit.go.jp/jigyo/jissekicsv"
const PORTAL_HOME = "https://www.minpaku.mlit.go.jp/jigyo/"
const CDP = "http://127.0.0.1:9222"
const STATE_DIR = join(homedir(), ".claude", "channels", "discord")
const STATE_FILE = join(STATE_DIR, "jisseki-report-state.json")
const SECRET_FILE = join(STATE_DIR, "v2-gas-secret.txt")
const OUT_DIR = join(tmpdir(), "claude", "jisseki-report")

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const DO_UPLOAD = has("--upload")
const CHECK = has("--check")
const CSV_ONLY = has("--csv-only")
const FORCE = has("--force")
const DRY = has("--dry")

const notify = (s) => console.log("NOTIFY: " + String(s).replace(/\n/g, " "))
const log = (s) => console.log(s)

// ===== Shift_JIS(cp932) エンコーダ =====
// ポータルは **Shift_JIS・BOMなし** しか受け付けない（UTF-8 BOM付きはヘッダー行が認識されず全滅）。
// 外部依存を増やさないため、TextDecoder('shift_jis') の逆引き表を起動時に1回だけ作る。
let cp932 = null
function cp932Map() {
  if (cp932) return cp932
  const dec = new TextDecoder("shift_jis", { fatal: false })
  const m = new Map()
  for (let b = 0x00; b <= 0x7f; b++) m.set(String.fromCharCode(b), [b])
  for (let b = 0xa1; b <= 0xdf; b++) { // 半角カナ
    const ch = dec.decode(Uint8Array.from([b]))
    if (ch.length === 1 && ch !== "\uFFFD" && !m.has(ch)) m.set(ch, [b])
  }
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead >= 0xa0 && lead <= 0xdf) continue
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue
      const ch = dec.decode(Uint8Array.from([lead, trail]))
      if (ch.length === 1 && ch !== "\uFFFD" && !m.has(ch)) m.set(ch, [lead, trail])
    }
  }
  cp932 = m
  return m
}

/** 文字列を cp932 のバイト列にする。変換できない文字があれば例外（黙って化けさせない） */
function toCp932(text) {
  const m = cp932Map()
  const out = []
  for (const ch of text) {
    const b = m.get(ch)
    if (!b) throw new Error(`Shift_JISに変換できない文字が含まれています: "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase()})`)
    out.push(...b)
  }
  return Uint8Array.from(out)
}

// ===== 状態 =====
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch { return {} } }
const saveState = (s) => {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)) }
  catch (e) { log(`state保存失敗: ${e.message}`) }
}
const todayYmd = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/**
 * 今日が報告すべき期間かを判定。
 * 施行規則第12条2項: 偶数月の15日までに、その前2ヶ月分を報告する。
 * → 偶数月の1〜15日が報告窓。periodId は「偶数月」側の YYYY-MM。
 */
function currentPeriodId(now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate()
  if (m % 2 === 0 && d <= 15) return `${y}-${String(m).padStart(2, "0")}`
  return null
}
/** 直近で報告を終えているべき期間（点検・--force 用） */
function latestPeriodId(now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth() + 1
  const even = m % 2 === 0 ? m : m - 1
  return even >= 2 ? `${y}-${String(even).padStart(2, "0")}` : `${y - 1}-12`
}

// ===== API =====
function gasSecret() {
  const s = readFileSync(SECRET_FILE, "utf8").trim()
  if (!s) throw new Error("v2-gas-secret.txt が空です")
  return s
}
async function fetchReport(periodId) {
  const res = await fetch(`${API}/reports/portal-report?periodId=${encodeURIComponent(periodId)}`, {
    headers: { Authorization: `Bearer gas-${gasSecret()}` },
  })
  if (!res.ok) throw new Error(`portal-report ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}
async function markSubmitted(periodId, propertyId, portalResult) {
  const res = await fetch(`${API}/reports/submit`, {
    method: "POST",
    headers: { Authorization: `Bearer gas-${gasSecret()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ periodId, propertyId, portalResult, memo: "民泊制度運営システムへCSVで自動登録" }),
  })
  if (!res.ok) throw new Error(`submit ${res.status}`)
}

// ===== 表示 =====
function summarize(data) {
  const lines = []
  const p = data.period
  lines.push(`## 🏠 事業実績報告 ${p.label}（期限 ${p.deadline}）`)
  const targets = data.properties.filter((r) => r.reportable)
  if (!targets.length) return { lines, targets }
  lines.push("")
  for (const r of targets) {
    lines.push(`### ${r.name}　${r.todokideNumber}`)
    lines.push(`宿泊日数 **${r.nissuu}日** ／ 宿泊者数 **${r.guests}人** ／ 延べ人数 **${r.nobe}人**`)
    const nz = Object.entries(r.byNationality).filter(([, v]) => v > 0).map(([k, v]) => `${k}${v}`)
    lines.push(`国籍: ${nz.length ? nz.join("・") : "なし"}`)
    const others = Object.entries(r.unknownNationalities || {})
    if (others.length) {
      // 22区分に無い国は「その他」が正しいが、寄せ間違いを見逃さないよう国名を必ず出す
      lines.push(`⚠ 「その他」の内訳: ${others.map(([k, v]) => `${k}${v}名`).join("・")}（22区分に無い国はこれで正しい）`)
    }
    for (const w of r.warnings || []) lines.push(`⚠ ${w}`)
    lines.push("")
  }
  const skipped = (data.skipped || []).filter((s) => s.reason)
  if (skipped.length) lines.push(`（届出番号が未登録のため対象外: ${skipped.map((s) => s.name).join("・")}）`)
  return { lines, targets }
}

// ===== CSV =====
function writeCsv(data) {
  mkdirSync(OUT_DIR, { recursive: true })
  const path = join(OUT_DIR, `jisseki_${data.period.id}.csv`)
  const bytes = toCp932(data.csv)
  writeFileSync(path, bytes)
  return { path, bytes: bytes.length }
}

// ===== ポータルへ投入 =====
async function uploadToPortal(csvPath, guardLabel) {
  const pw = await import("file:///C:/Users/yamas/.claude/scripts/node_modules/playwright-core/index.js")
  const { chromium } = pw.default || pw
  const browser = await chromium.connectOverCDP(CDP, { timeout: 20000 })
  try {
    const ctx = browser.contexts()[0]
    const page = ctx.pages().find((p) => p.url().includes("minpaku.mlit.go.jp")) || ctx.pages()[0]

    // 「登録しますか？※登録後は修正する事はできません。」の confirm を承認する。
    // ここに到達するのは、やますけがボタンを押したときだけ。
    page.on("dialog", async (d) => { log(`DIALOG: ${d.message().replace(/\n/g, " ")}`); await d.accept() })

    // ★二重登録の防止（最後の砦）。ポータルの『事業実績一覧』に同じ報告期間が既にあれば投入しない。
    //   登録は取り消せないので、v2側の記録だけに頼らずポータルの実体で確認する。
    if (guardLabel) {
      await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: 45000 })
      await page.waitForTimeout(2000)
      const link = page.locator('a:has-text("事業実績一覧")')
      if (await link.count()) {
        await link.first().click({ timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(3000)
        const listText = await page.evaluate(() => document.body.innerText)
        // 全角波ダッシュの字種ゆれ(U+FF5E / U+301C)を吸収して比較する
        const norm = (s) => s.replace(/[～〜]/g, "~")
        if (norm(listText).includes(norm(guardLabel))) {
          return { alreadyReported: true, label: guardLabel }
        }
      }
    }

    await page.goto(PORTAL_UPLOAD, { waitUntil: "domcontentloaded", timeout: 45000 })
    await page.waitForTimeout(2000)
    if (!(await page.locator('input[name="attFile"]').count())) {
      // 直URLで開けないときはホームからクリックで辿る（Salesforce の ViewState 方式のため）
      await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: 45000 })
      await page.waitForTimeout(2000)
      const body = await page.evaluate(() => document.body.innerText)
      if (/ログイン|サインアップ/.test(body) && !/事業実績/.test(body)) {
        return { loggedOut: true }
      }
      await page.locator('a:has-text("事業実績アップロード")').first().click({ timeout: 15000 })
      await page.waitForTimeout(3000)
    }
    if (!(await page.locator('input[name="attFile"]').count())) return { loggedOut: true }

    await page.locator('input[name="attFile"]').setInputFiles(csvPath)
    await page.waitForTimeout(1500)

    const btn = page.locator('input[type=submit][value="登録"]:visible').first()
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {}),
      btn.click({ timeout: 20000 }),
    ])
    for (let i = 0; i < 20; i++) {
      if (/正常件数/.test(await page.evaluate(() => document.body.innerText))) break
      await page.waitForTimeout(2000)
    }

    const text = await page.evaluate(() => document.body.innerText)
    const ok = Number((text.match(/正常件数[：:]\s*(\d+)/) || [])[1] ?? -1)
    const ng = Number((text.match(/異常件数[：:]\s*(\d+)/) || [])[1] ?? -1)
    const idx = text.indexOf("異常理由")
    const reason = idx >= 0 ? text.slice(idx, idx + 700).trim() : ""

    mkdirSync(OUT_DIR, { recursive: true })
    const shot = join(OUT_DIR, `result_${todayYmd()}.png`)
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
    return { ok, ng, reason, shot }
  } finally {
    await browser.close().catch(() => {})
  }
}

/** debug Chrome に民泊制度運営システムを開いて前面に出す（ログインはやますけが行う） */
async function openLogin() {
  const pw = await import("file:///C:/Users/yamas/.claude/scripts/node_modules/playwright-core/index.js")
  const { chromium } = pw.default || pw
  const browser = await chromium.connectOverCDP(CDP, { timeout: 20000 })
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes("minpaku.mlit.go.jp")) || await ctx.newPage()
  await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: 45000 })
  await page.bringToFront().catch(() => {})
  // CDPは切るがタブは残す（やますけがそのまま操作できるように）
  await browser.close().catch(() => {})
  notify("🔑 PCに民泊制度運営システムを開きました。ログインしたら「⚡ ログインしたので登録する」を押してください")
}

// ===== main =====
;(async () => {
  if (has("--open-login")) { await openLogin(); return }

  const periodId = opt("--period") || (DO_UPLOAD || CHECK || FORCE ? latestPeriodId() : currentPeriodId())
  if (!periodId) { log("報告期間外（偶数月の1〜15日のみ）。無音で終了"); return }

  const state = loadState()
  state.done = state.done || {}
  if (!DO_UPLOAD && !CHECK && !FORCE && state.done[periodId]) {
    log(`${periodId} は登録済み。無音で終了`); return
  }

  const data = await fetchReport(periodId)
  const { lines, targets } = summarize(data)

  if (!targets.length) {
    if (CHECK) notify(`事業実績報告 ${data.period.label}: 届出番号が登録された物件がありません（対象なし）`)
    else log("報告対象の物件なし。無音で終了")
    return
  }

  // ★二重登録の防止（1段目）。v2側に報告済みの記録があれば促さない。
  //   2段目はポータルの『事業実績一覧』を実際に見て確認する（uploadToPortal 内）。
  const pending = targets.filter((t) => !t.submitted)
  if (!pending.length && !FORCE) {
    const msg = `事業実績報告 ${data.period.label} は報告済みです（${targets.map((t) => t.name).join("・")}）`
    if (CHECK) notify(msg); else log(msg + " → 無音で終了")
    return
  }

  // CSVは常に作る（中身の目視確認と、投入直前の再生成を同じ経路にする）
  const csv = writeCsv(data)
  log(`CSV: ${csv.path} (${csv.bytes} bytes, Shift_JIS)`)
  if (CSV_ONLY) { notify(`事業実績報告のCSVを書き出しました: ${csv.path}`); return }

  if (!DO_UPLOAD) {
    // 提示のみ。1日1回だけ促す（通知疲れ防止）
    const ymd = todayYmd()
    if (!CHECK && state.promptedYmd === ymd && state.promptedPeriod === periodId) {
      log("本日は提示済み。無音で終了"); return
    }
    state.promptedYmd = ymd; state.promptedPeriod = periodId; saveState(state)
    const body = lines.join("\n")
    // 複数行はブロック形式で渡す（1行NOTIFYだと先頭行しか届かない）
    console.log("NOTIFY_BEGIN")
    console.log(body)
    console.log(`\n下の **✅ 登録する** を押すと、このままCSVで民泊制度運営システムへ登録します。`)
    console.log(`※ 登録は取り消せません。修正できるのは ${data.period.deadline} までです。`)
    console.log(`BUTTONS: jisseki_report ${periodId}`)
    console.log("NOTIFY_END")
    return
  }

  // --- 投入 ---
  if (DRY) { notify(`[dry] ${data.period.label} のCSVを作成しました（投入なし）: ${csv.path}`); return }

  const r = await uploadToPortal(csv.path, data.period.portalLabel)
  if (r.alreadyReported) {
    // ポータルに同じ報告期間が既にある。登録は取り消せないので絶対に上書きしない。
    for (const t of targets) {
      try { await markSubmitted(periodId, t.propertyId, "ポータルに登録済みを検知（自動登録は行わず）") } catch {}
    }
    state.done[periodId] = { at: new Date().toISOString(), note: "ポータルに登録済みを検知" }
    saveState(state)
    notify(`🛑 ${r.label} は民泊制度運営システムに既に登録済みです。二重登録になるため投入しませんでした（v2側にも報告済みとして記録しました）`)
    return
  }
  if (r.loggedOut) {
    notify(`🔑 民泊制度運営システムのログインが切れています。ログインしてから、もう一度「登録する」を押してください`)
    console.log("BUTTONS: jisseki_login " + periodId)
    return
  }
  if (r.ok > 0 && r.ng === 0) {
    for (const t of targets) {
      try { await markSubmitted(periodId, t.propertyId, `正常件数:${r.ok} 異常件数:${r.ng}`) }
      catch (e) { log(`submit記録失敗 ${t.propertyId}: ${e.message}`) }
    }
    state.done[periodId] = { at: new Date().toISOString(), ok: r.ok, shot: r.shot }
    saveState(state)
    notify(`✅ 事業実績報告 ${data.period.label} を登録しました（正常件数 ${r.ok} / 異常 ${r.ng}）。証跡: ${r.shot}`)
    return
  }
  // エラー時は1件も登録されない（安全側に倒れる設計）
  notify(`🚨 事業実績報告の登録に失敗しました（正常${r.ok} / 異常${r.ng}）。実績は登録されていません`)
  if (r.reason) console.log("NOTIFY: " + r.reason.replace(/\n/g, " ").slice(0, 400))
  process.exitCode = 1
})().catch((e) => {
  notify(`🚨 事業実績報告スクリプトでエラー: ${e.message}`)
  process.exitCode = 1
})
