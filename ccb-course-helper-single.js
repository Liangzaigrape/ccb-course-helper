// ==UserScript==
// @name         建行专题班学习辅助-单线程版
// @namespace    local.ccb.course-helper
// @version      1.4.0
// @description  识别未完成课程，辅助进入课程并按设置播放；只读取平台真实进度，不模拟完成。
// @match        https://u.ccb.com/workshop/*
// @match        https://u.ccb.com/course/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'ccbCourseHelperSettingsV2';
  const defaults = { autoOpen: true, autoplay: true, muted: true, auto2x: true, forced3: false, minimized: false };
  const settings = { ...defaults, ...(typeof GM_getValue === 'function' ? GM_getValue(KEY, {}) : {}) };
  const autoClicked = new Set();
  const save = () => typeof GM_setValue === 'function' && GM_setValue(KEY, settings);
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const textOf = el => norm(el?.innerText || el?.textContent || '');
  const progressRe = /(\d{1,3}(?:\.\d+)?)\s*%/;

  const visibleVideo = () => [...document.querySelectorAll('video')].find(visible);
  const targetRate = () => (settings.forced3 ? 3 : (settings.auto2x ? 2 : 0));

  function applyPlaybackRate(video) {
    const v = video || visibleVideo();
    if (!v) return false;
    const rate = targetRate();
    if (!rate) return false;
    try {
      if (Math.abs(v.playbackRate - rate) > 1e-6) v.playbackRate = rate;
      return true;
    } catch {
      return false;
    }
  }

  // 站点可能主动把倍速改回去，这里持续纠正（仅在本脚本设定目标倍速时生效）。
  document.addEventListener('ratechange', event => {
    const video = event.target;
    if (video instanceof HTMLVideoElement && targetRate()) applyPlaybackRate(video);
  }, true);

  function findProgress(root = document) {
    // 播放页中评论评分也使用 aria-valuenow；只在播放器区域读取真正的进度条。
    const scope = root === document
      ? (document.querySelector('.player_area') || (isCourseDetailPage() ? document.querySelector('.progress-v') : null) || document)
      : root;
    const explicit = [...scope.querySelectorAll('[role="progressbar"],progress')]
      .filter(visible)
      .map(el => {
        const raw = el.getAttribute('aria-valuenow') ?? el.value ?? el.getAttribute('aria-valuetext') ?? '';
        const matched = String(raw).match(/\d+(?:\.\d+)?/);
        const n = matched ? Number(matched[0]) : NaN;
        if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
        const width = parseFloat(el.style.width || getComputedStyle(el).width);
        const parentWidth = el.parentElement?.getBoundingClientRect().width || 0;
        return parentWidth > 0 && Number.isFinite(width) ? Math.max(0, Math.min(100, width / parentWidth * 100)) : null;
      }).filter(n => n !== null);
    const textual = [...scope.querySelectorAll('*')]
      .filter(el => visible(el) && el.children.length === 0)
      .map(el => textOf(el).match(progressRe)?.[1])
      .filter(Boolean).map(Number).filter(n => n >= 0 && n <= 100);
    const values = [...explicit, ...textual];
    return values.length ? Math.max(...values) : null;
  }

  function getCourseCards() {
    // 建行“我的专题班”列表的实际入口：标题链接文字包含状态，href 指向专题班详情。
    const ccbLinks = [...document.querySelectorAll('a[href*="#/myworkshop/detail"]')]
      .filter(a => visible(a) && /未开始|未完成|进行中/.test(textOf(a)));
    if (ccbLinks.length) {
      const roots = new Map();
      for (const link of ccbLinks) {
        const root = link.closest('.mv10.ml20.content') || link.parentElement?.parentElement || link;
        if (!roots.has(root)) roots.set(root, { el: root, text: textOf(root), link });
      }
      return [...roots.values()];
    }
    if (!isClassListPage()) return [];

    // 通用兜底：页面结构变更时，识别带未完成状态和可点击入口的条目。
    const leaves = [...document.querySelectorAll('body *')].filter(el => {
      if (!visible(el) || el.children.length > 2) return false;
      const t = textOf(el);
      return t.includes('未开始') || t.includes('未完成') || t.includes('进行中');
    });
    const found = new Set();
    for (const leaf of leaves) {
      let el = leaf;
      for (let i = 0; i < 7 && el && el !== document.body; i++, el = el.parentElement) {
        const t = textOf(el);
        if (t.length > 30 && t.length < 1200 && /未开始|未完成|进行中/.test(t) && el.querySelector('a,button,[role="button"]')) {
          found.add(el);
          break;
        }
      }
    }
    return [...found].map(el => ({ el, text: textOf(el) }));
  }

  function isVideoPage() {
    return /^#\/play\/[^?]+/.test(location.hash) || !!document.querySelector('.player_area video');
  }

  function isCourseDetailPage() {
    return location.pathname.replace(/\/$/, '') === '/course' && /^#\/detail\/[^?]+/.test(location.hash);
  }

  function isClassListPage() {
    return /^#\/myworkshop(?:\?.*)?$/.test(location.hash);
  }

  function findAction(label) {
    return [...document.querySelectorAll('a,button,[role="button"],.edit-block')]
      .find(el => visible(el) && textOf(el).includes(label));
  }

  function autoClickOnce(el) {
    const key = `${location.pathname}${location.hash}:${textOf(el)}`;
    if (el && !autoClicked.has(key)) {
      autoClicked.add(key);
      el.click();
    }
  }

  function workshopDetailUrl() {
    const hashQuery = location.hash.split('?')[1] || '';
    const id = new URLSearchParams(hashQuery).get('workshopId');
    return id ? `https://u.ccb.com/workshop/#/myworkshop/detail?id=${encodeURIComponent(id)}` : null;
  }

  function autoNavigateOnce(key, url) {
    const token = `navigate:${key}`;
    if (url && !autoClicked.has(token)) {
      autoClicked.add(token);
      location.assign(url);
    }
  }

  // 进度未满 100% 时保持播放；视频播完但平台进度尚未达标，则等待片刻后从头重播。
  let endedSince = 0;
  const REPLAY_DELAY = 8000;   // 播完后先等平台更新进度，避免无谓重播
  let lastPlayAttempt = 0;

  function keepVideoPlaying(video) {
    const now = Date.now();
    if (video.ended) {
      if (!endedSince) { endedSince = now; return; }
      if (now - endedSince < REPLAY_DELAY) return;
      endedSince = 0;
      try { video.currentTime = 0; } catch { /* 忽略 */ }
      lastPlayAttempt = now;
      const p = video.play();
      p?.catch?.(() => { /* 稍后重试 */ });
      return;
    }
    endedSince = 0;
    if (video.paused) {
      if (now - lastPlayAttempt < 3000) return;
      lastPlayAttempt = now;
      const p = video.play();
      p?.catch?.(() => { /* 稍后重试 */ });
    }
  }

  function safePlayVideo(progress) {
    const video = [...document.querySelectorAll('video')].find(visible);
    if (!video) return '尚未检测到 HTML 视频播放器';
    video.muted = !!settings.muted;
    applyPlaybackRate(video);
    if (settings.autoplay && (progress === null || progress < 100)) {
      keepVideoPlaying(video);
    }
    const rateNote = Math.abs(video.playbackRate - 1) > 1e-6 ? `，${video.playbackRate}倍速` : '';
    const stateNote = video.paused ? '，当前暂停' : '，播放中';
    return `已应用播放设置（${settings.muted ? '静音' : '有声'}${rateNote}${stateNote}）`;
  }

  const panel = document.createElement('section');
  panel.id = 'ccb-helper-panel';
  panel.innerHTML = `
    <header><strong>学习辅助</strong><button data-act="min" title="最小化/展开">−</button></header>
    <div class="body">
      <label><input type="checkbox" data-setting="autoOpen"> 自动进入未完成课程并继续学习</label>
      <label><input type="checkbox" data-setting="autoplay"> 检测到视频后自动播放</label>
      <label><input type="checkbox" data-setting="muted"> 自动静音</label>
      <label><input type="checkbox" data-setting="auto2x"> 检测到视频后自动 2 倍速</label>
      <div class="rate-row">
        <button type="button" data-act="force3">强制 3 倍速</button>
        <span class="rate-status"></span>
      </div>
      <div class="status" aria-live="polite"></div>
      <div class="actions"></div>
      <small>进度仅从页面可见信息读取；不会刷新重播或修改完成状态。</small>
    </div>`;
  const style = document.createElement('style');
  style.textContent = `
    #ccb-helper-panel{position:fixed;z-index:2147483647;right:18px;top:110px;width:290px;background:#fff;color:#222;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 5px 22px #0003;font:14px/1.45 system-ui,sans-serif}
    #ccb-helper-panel header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#eff6ff;border-radius:10px 10px 0 0;cursor:move;user-select:none;touch-action:none}
    #ccb-helper-panel button{cursor:pointer;border:1px solid #cbd5e1;border-radius:6px;background:#fff;padding:4px 9px}
    #ccb-helper-panel .body{padding:10px 12px;display:grid;gap:8px}
    #ccb-helper-panel label{display:flex;gap:7px;align-items:center}
    #ccb-helper-panel .status{color:#334155;min-height:20px}
    #ccb-helper-panel .actions{display:grid;gap:6px;max-height:180px;overflow:auto}
    #ccb-helper-panel .course{display:flex;justify-content:space-between;gap:8px;align-items:center;border-top:1px solid #e2e8f0;padding-top:6px}
    #ccb-helper-panel .rate-row{display:flex;align-items:center;gap:8px}
    #ccb-helper-panel .rate-row button{flex:0 0 auto}
    #ccb-helper-panel .rate-row button.active{background:#fef3c7;border-color:#f59e0b;color:#92400e;font-weight:600}
    #ccb-helper-panel .rate-status{font-size:12px;color:#b45309}
    #ccb-helper-panel small{color:#64748b;font-size:11px}
    #ccb-helper-panel.min .body{display:none}#ccb-helper-panel.min{width:150px}`;
  document.documentElement.append(style, panel);

  for (const input of panel.querySelectorAll('[data-setting]')) {
    const name = input.dataset.setting;
    input.checked = !!settings[name];
    input.addEventListener('change', () => {
      settings[name] = input.checked;
      save();
      if (name === 'auto2x' && !input.checked && !settings.forced3) {
        const video = visibleVideo();
        if (video && Math.abs(video.playbackRate - 2) < 1e-6) {
          try { video.playbackRate = 1; } catch { /* 忽略 */ }
        }
      }
      update();
    });
  }
  panel.querySelector('[data-act="min"]').addEventListener('click', () => {
    settings.minimized = !settings.minimized;
    panel.classList.toggle('min', settings.minimized);
    save();
    setTimeout(clampPanel, 0);
  });
  panel.classList.toggle('min', settings.minimized);

  const force3Btn = panel.querySelector('[data-act="force3"]');
  const rateStatus = panel.querySelector('.rate-status');

  function refreshForce3UI() {
    force3Btn.textContent = settings.forced3 ? '取消强制 3 倍速' : '强制 3 倍速';
    force3Btn.classList.toggle('active', !!settings.forced3);
    rateStatus.textContent = settings.forced3 ? '已强制 3 倍速' : '';
  }

  force3Btn.addEventListener('click', () => {
    settings.forced3 = !settings.forced3;
    save();
    const video = visibleVideo();
    if (video) {
      if (!settings.forced3 && !settings.auto2x) {
        try { video.playbackRate = 1; } catch { /* 忽略 */ }
      } else {
        applyPlaybackRate(video);
      }
    }
    refreshForce3UI();
    update();
  });
  refreshForce3UI();

  // ---- 面板拖拽 ----
  const headerEl = panel.querySelector('header');
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  function clampPanel() {
    if (!panel.style.left) return;
    const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
    const x = Math.max(0, Math.min(maxX, parseFloat(panel.style.left) || 0));
    const y = Math.max(0, Math.min(maxY, parseFloat(panel.style.top) || 0));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  if (settings.panelPos
    && Number.isFinite(settings.panelPos.left)
    && Number.isFinite(settings.panelPos.top)) {
    panel.style.left = settings.panelPos.left + 'px';
    panel.style.top = settings.panelPos.top + 'px';
    panel.style.right = 'auto';
    clampPanel();
  }

  headerEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragging = true;
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    try { headerEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    e.preventDefault();
  });

  headerEl.addEventListener('pointermove', e => {
    if (!dragging) return;
    const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
    const x = Math.max(0, Math.min(maxX, e.clientX - dragOffsetX));
    const y = Math.max(0, Math.min(maxY, e.clientY - dragOffsetY));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { headerEl.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    const rect = panel.getBoundingClientRect();
    settings.panelPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
    save();
  }

  headerEl.addEventListener('pointerup', endDrag);
  headerEl.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', clampPanel);

  function addButton(actions, label, fn) {
    const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', fn); actions.append(b);
  }

  function update() {
    const status = panel.querySelector('.status');
    const actions = panel.querySelector('.actions');
    actions.replaceChildren();
    if (isVideoPage()) {
      const p = findProgress();
      const playResult = safePlayVideo(p);
      status.textContent = `视频页面：${p === null ? '未识别到进度' : `页面进度 ${p}%`}；${playResult}`;
      if (p === 100) {
        status.textContent += '。该视频显示已完成，可返回专题班详情核对其余课程。';
        addButton(actions, '返回详情', () => {
          const back = document.querySelector('.player_area .return-btn');
          if (back) back.click(); else history.back();
        });
        if (settings.autoOpen) {
          const target = workshopDetailUrl();
          if (target) autoNavigateOnce(location.hash, target);
        }
      } else if (settings.autoplay) {
        status.textContent += '；进度未满 100%，已保持自动播放。';
      }
      return;
    }
    const cards = getCourseCards();
    if (cards.length) {
      status.textContent = settings.autoOpen
        ? `识别到 ${cards.length} 个未完成专题班；正在进入首个条目。`
        : `识别到 ${cards.length} 个未完成专题班；可在下方选择进入。`;
      cards.slice(0, 8).forEach(({ el, text }, i) => {
        const row = document.createElement('div'); row.className = 'course';
        const title = document.createElement('span'); title.textContent = text.slice(0, 48) || `课程条目 ${i + 1}`;
        const btn = document.createElement('button'); btn.textContent = '进入';
        btn.addEventListener('click', () => {
          const link = el.matches?.('a[href]') ? el : el.querySelector('a[href]');
          const action = [...el.querySelectorAll('button,[role="button"]')].find(x => /进入|学习|查看|详情/.test(textOf(x)));
          if (link) location.href = link.href; else if (action) action.click(); else el.click();
        });
        row.append(title, btn); actions.append(row);
      });
      if (settings.autoOpen && cards[0]) {
        const firstLink = cards[0].link || (cards[0].el.matches?.('a[href]') ? cards[0].el : cards[0].el.querySelector('a[href]'));
        autoClickOnce(firstLink);
      }
      return;
    }
    const detailRows = [...document.querySelectorAll('tr')]
      .filter(row => visible(row) && row.querySelector('.edit-block') && row.querySelector('.percent-text'));
    if (detailRows.length) {
      const parsed = detailRows.map(row => {
        const title = textOf(row.cells?.[1]) || textOf(row);
        const value = row.querySelector('.percent-text')?.textContent?.match(progressRe)?.[1];
        const progress = value === undefined ? null : Number(value);
        return { row, title, progress, action: row.querySelector('.edit-block') };
      });
      const incomplete = parsed.filter(item => item.progress !== 100 && item.action);
      status.textContent = `课程班内识别到 ${parsed.length} 门课程；按每行平台进度展示。`;
      parsed.forEach(({ title, progress, action }) => {
        const row = document.createElement('div'); row.className = 'course';
        const label = document.createElement('span');
        label.textContent = `${title.slice(0, 34)} · ${progress === null ? '进度未识别' : `${progress}%`}`;
        row.append(label);
        if (progress === 100 || !action) {
          const done = document.createElement('span'); done.textContent = progress === 100 ? '已完成' : '无入口'; row.append(done);
        } else {
          const btn = document.createElement('button'); btn.textContent = textOf(action) || '学习';
          btn.addEventListener('click', () => action.click()); row.append(btn);
        }
        actions.append(row);
      });
      if (settings.autoOpen && incomplete.length) autoClickOnce(incomplete[0].action);
      else if (settings.autoOpen && parsed.length && parsed.every(item => item.progress === 100)) {
        status.textContent = '专题班内课程均显示 100%；返回专题班列表查找下一班。';
        autoNavigateOnce(location.hash, 'https://u.ccb.com/workshop/#/myworkshop');
      }
      return;
    }
    if (isCourseDetailPage()) {
      const continueButton = document.querySelector('button.to-learn') || findAction('继续学习');
      const p = findProgress();
      status.textContent = `课程详情页：${p === null ? '未识别到课程进度' : `平台进度 ${p}%`}${continueButton ? '；可继续学习' : ''}`;
      if (p === 100) {
        status.textContent = '课程进度已达 100%；返回专题班详情核对其他课程。';
        addButton(actions, '返回上一页核对其他课程', () => history.back());
        if (settings.autoOpen) {
          const target = workshopDetailUrl();
          if (target) autoNavigateOnce(location.hash, target);
        }
      } else if (continueButton && visible(continueButton)) {
        addButton(actions, '继续学习', () => continueButton.click());
        if (settings.autoOpen) autoClickOnce(continueButton);
      }
      return;
    }
    const immediate = findAction('立即学习');
    if (immediate) {
      status.textContent = '检测到“立即学习”入口。';
      addButton(actions, '立即学习', () => immediate.click());
      if (settings.autoOpen) autoClickOnce(immediate);
      return;
    }
    if (isClassListPage()) {
      status.textContent = '已在“我的专题班”页面；未识别到带未完成状态的课程条目，请检查页面是否加载完成。';
      if (settings.autoOpen) {
        const start = findAction('立即学习');
        if (start) autoClickOnce(start);
      }
      return;
    }
    const start = findAction('我要学习');
    if (start) {
      status.textContent = '检测到课程确认页。';
      addButton(actions, '我要学习', () => start.click());
      if (settings.autoOpen) autoClickOnce(start);
      return;
    }
    status.textContent = '等待课程列表或视频页面…';
  }

  update();
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; update(); }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(update, 5000);
})();