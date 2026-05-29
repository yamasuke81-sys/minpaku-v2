// ==UserScript==
// @name         タイミー 民泊清掃募集 自動入力
// @namespace    https://v2-5-relay.web.app/
// @version      0.2.0
// @description  v2 通知から開かれた募集作成フォームを、URL ハッシュパラメータで自動入力する
// @author       minpaku-v2
// @match        https://app-new.taimee.co.jp/clients/*/offers/*/offerings/new*
// @run-at       document-idle
// @grant        none
// @updateURL    https://v2-5-relay.web.app/userscripts/timee-autofill.user.js
// @downloadURL  https://v2-5-relay.web.app/userscripts/timee-autofill.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- ユーティリティ ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // React 制御 input/textarea に値を反映する
  function setNative(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setById(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;
    setNative(el, String(value));
    return true;
  }

  function clickById(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    if (el.type === 'radio' || el.type === 'checkbox') {
      if (!el.checked) el.click();
    } else {
      el.click();
    }
    return true;
  }

  // URL ハッシュ → パラメータ object
  function getParams() {
    const h = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!h) return null;
    return Object.fromEntries(new URLSearchParams(h));
  }

  // 日付選択 (YYYY-MM-DD)
  // 月/年セレクトを setNative する方式は react-datepicker の React state を更新できない場合があるため、
  // 「前月へ/次月へ」ナビゲーションボタンを必要回数クリックして移動する方式を採用。
  async function pickDate(dateStr) {
    const [y, m, d] = (dateStr || '').split('-').map(Number);
    if (!y || !m || !d) return false;
    const monthSel = document.querySelector('.react-datepicker__month-select');
    const yearSel = document.querySelector('.react-datepicker__year-select');
    if (!monthSel || !yearSel) return false;

    const targetTotal = y * 12 + (m - 1);
    let safety = 60; // 最大 5 年分のクリック
    while (safety-- > 0) {
      const curTotal = Number(yearSel.value) * 12 + Number(monthSel.value);
      if (curTotal === targetTotal) break;
      const btn = curTotal < targetTotal
        ? document.querySelector('.react-datepicker__navigation--next')
        : document.querySelector('.react-datepicker__navigation--previous');
      if (!btn) return false;
      btn.click();
      await sleep(120);
    }

    const dd = String(d).padStart(3, '0');
    const cells = document.querySelectorAll(`.react-datepicker__day--${dd}`);
    for (const c of cells) {
      if (c.classList.contains('react-datepicker__day--outside-month')) continue;
      if (c.classList.contains('react-datepicker__day--disabled')) continue;
      c.click();
      return true;
    }
    return false;
  }

  // フォーム描画待ち
  async function waitForForm(timeoutMs = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (document.getElementById('hourlyWage')) return true;
      await sleep(200);
    }
    return false;
  }

  // 画面通知
  function showBanner(text, isError = false) {
    document.querySelectorAll('.__minpaku-timee-banner').forEach((n) => n.remove());
    const div = document.createElement('div');
    div.className = '__minpaku-timee-banner';
    div.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:99999',
      `background:${isError ? '#dc3545' : '#0d6efd'}`, 'color:#fff',
      'padding:10px 14px', 'border-radius:8px', 'font-size:13px',
      'box-shadow:0 4px 12px rgba(0,0,0,.2)', 'max-width:360px', 'line-height:1.5',
      'font-family:system-ui,-apple-system,sans-serif',
    ].join(';');
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 10000);
  }

  // ---------- 本体 ----------
  async function autofill() {
    const params = getParams();
    if (!params || Object.keys(params).length === 0) return;

    const ok = await waitForForm();
    if (!ok) { showBanner('フォームが見つかりませんでした', true); return; }

    // 日付
    if (params.date) await pickDate(params.date);

    // 時刻系
    if (params.start) setById('workTimeStart', params.start);
    if (params.end) setById('workTimeEnd', params.end);
    if (params.restStart) setById('restTimeStart', params.restStart);
    if (params.restMin != null && params.restMin !== '') setById('restMinutes', params.restMin);

    // 募集人数
    if (params.workers) setById('matchingLimit', params.workers);

    // 公開設定 (published / group_limited / new_worker_for_client_limited / url_limited)
    if (params.visibility) {
      clickById(params.visibility);
      if (params.visibility === 'group_limited' && params.groupIds) {
        await sleep(350);
        for (const gid of params.groupIds.split(',')) {
          const v = gid.trim();
          if (!v) continue;
          const cb = document.querySelector(`input[type="checkbox"][value="${v}"]`);
          if (cb && !cb.checked) cb.click();
        }
      }
    }

    // 時給・交通費
    if (params.wage) setById('hourlyWage', params.wage);
    if (params.transport != null && params.transport !== '') setById('transportationExpense', params.transport);

    // 自動送信メッセージ
    if (params.autoMsg === 'true' || params.autoMsg === 'false') {
      const r = document.querySelector(
        `input[type="radio"][name="matchingAutoChatMessage.enabled"][value="${params.autoMsg}"]`
      );
      if (r && !r.checked) r.click();
    }
    if (params.autoMsgTarget) {
      const r = document.querySelector(
        `input[type="radio"][name="matchingAutoChatMessage.targetWorker"][value="${params.autoMsgTarget}"]`
      );
      if (r && !r.checked) r.click();
    }

    showBanner('民泊v2: 募集項目を自動入力しました。内容を確認のうえ「求人を作成」を押してください。');
  }

  // 初回 + ハッシュ変更
  autofill();
  window.addEventListener('hashchange', autofill);
})();
