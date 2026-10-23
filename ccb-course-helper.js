// ==UserScript==
// @name         建行专题班学习辅助
// @namespace    local.ccb.course-helper
// @version      1.4.1
// @description  识别未完成课程，辅助进入课程并按设置播放；只读取平台真实进度，不模拟完成。
// @match        https://u.ccb.com/workshop/*
// @match        https://u.ccb.com/course/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(() => {
  'use strict';

  /* ==================== 常量与设置 ==================== */
  const KEY = 'ccbCourseHelperSettingsV2';
  const RUN_KEY = 'ccbCourseHelperRunning';
  const OPENED_KEY = 'ccbCourseHelperOpenedTabs';
  const RETURN_KEY = 'ccbReturnUrl';
  const MULTI_PARENT_KEY = 'ccbMultiParent';
  const MULTI_TAB_KEY = 'ccbIsMultiTab';
  const POOL_KEY = 'ccbMultiPoolV1';
  const CURRENT_TASK_KEY = 'ccbCurrentTask';
  const TAB_ID_KEY = 'ccbMultiTabId';

  const MAX_REPLAY = 3;
  const PROGRESS_WAIT_MS = 3500;
  const OPENED_TTL = 5 * 60 * 1000;   // 去重时间缩短到 5 分钟
  const CLAIM_TTL = 30 * 60 * 1000;
  const PAGE_LOAD_COOLDOWN = 2000;     // 页面加载后 2 秒内不自动点击
  const CLICK_COOLDOWN = 1500;         // 同一动作最小间隔

  const defaults = {
    autoOpen: true,
    autoplay: true,
    muted: true,
    minimized: false,
    force3x: false,
    auto2x: false,
    multiCount: 2,
    panelX: null,
    panelY: null,
  };

  const settings = {
    ...defaults,
    ...(typeof GM_getValue === 'function' ? GM_getValue(KEY, {}) : {}),
  };
  settings.multiCount = Math.max(1, Math.min(5, Number(settings.multiCount) || 2));

  let isRunning = typeof GM_getValue === 'function' ? GM_getValue(RUN_KEY, true) !== false : true;

  const pageLoadTime = Date.now();
  const autoClicked = new Set();
  const startedVideos = new WeakSet();
  const clickedCourses = new Set();
  let lastAutoActionTime = 0;
  let multiRunning = false;

  // 子线程身份：以 URL 为准，并持久化到 sessionStorage，保证视频页也能识别
  let _multiChildCache = null;
  function isMultiChild() {
    if (_multiChildCache !== null) return _multiChildCache;
    const hash = location.hash;
    const q = hash.indexOf('?');
    if (q >= 0) {
      const params = new URLSearchParams(hash.slice(q + 1));
      if (params.has('ccbMulti')) {
        try { sessionStorage.setItem(MULTI_TAB_KEY, '1'); } catch (_) {}
        _multiChildCache = true;
        return true;
      }
      if (params.has('ccbAuto')) {
        try { sessionStorage.removeItem(MULTI_TAB_KEY); } catch (_) {}
        _multiChildCache = false;
        return false;
      }
    }
    try {
      if (sessionStorage.getItem(MULTI_TAB_KEY) === '1') {
        _multiChildCache = true;
        return true;
      }
    } catch (_) {}
    _multiChildCache = false;
    return false;
  }

  // 父页身份（列表页/详情页发起多线程后不再自动点击）
  let multiParent = (() => {
    try { return sessionStorage.getItem(MULTI_PARENT_KEY) === '1'; } catch (_) { return false; }
  })();
  const setMultiParent = (v) => {
    multiParent = !!v;
    try { sessionStorage.setItem(MULTI_PARENT_KEY, v ? '1' : '0'); } catch (_) {}
  };

  // 详情页带 ccbAuto=1 时强制单线程模式（用于列表页打开的子专题班页）
  try {
    const q = location.hash.split('?')[1];
    if (q) {
      const params = new URLSearchParams(q);
      if (params.has('ccbAuto')) {
        sessionStorage.setItem(MULTI_PARENT_KEY, '0');
        sessionStorage.removeItem(MULTI_TAB_KEY);
        multiParent = false;
      }
    }
  } catch (_) {}

  const verify = { video: null, active: false, since: 0, attempts: 0, cooldownUntil: 0 };
  let lastAppliedRate = null;

  const save = () => typeof GM_setValue === 'function' && GM_setValue(KEY, settings);
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const textOf = el => norm(el?.innerText || el?.textContent || '');
  const progressRe = /(\d{1,3}(?:\.\d+)?)\s*%/;
  const fmtProgress = p => (p === null || p === undefined ? '未识别' : `${p}%`);

  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(); saveTimer = null; }, 300);
  };

  /* ==================== 页面识别 ==================== */
  function isVideoPage() {
    return /^#\/play\/[^?]+/.test(location.hash) || !!document.querySelector('.player_area video');
  }
  function isCourseDetailPage() {
    return location.pathname.replace(/\/$/, '') === '/course' && /^#\/detail\/[^?]+/.test(location.hash);
  }
  function isClassListPage() {
    return /^#\/myworkshop(?:\?.*)?$/.test(location.hash);
  }
  function isWorkshopDetailPage() {
    return /#\/myworkshop\/detail/.test(location.hash) || !!workshopDetailUrl();
  }

  /* ==================== 进度读取 ==================== */
  function findProgress(root = document) {
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

  /* ==================== 课程条目识别 ==================== */
  function getCourseCards() {
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

  function findAction(label) {
    return [...document.querySelectorAll('a,button,[role="button"],.edit-block')]
      .find(el => visible(el) && textOf(el).includes(label));
  }

  function autoClickOnce(el) {
    const key = `${location.pathname}${location.hash}:${textOf(el)}`;
    if (el && !autoClicked.has(key)) {
      autoClicked.add(key);
      lastAutoActionTime = Date.now();
      el.click();
    }
  }

  function workshopDetailUrl() {
    const hashQuery = location.hash.split('?')[1] || '';
    const id = new URLSearchParams(hashQuery).get('id') || new URLSearchParams(hashQuery).get('workshopId');
    return id ? `https://u.ccb.com/workshop/#/myworkshop/detail?id=${encodeURIComponent(id)}` : null;
  }

  function autoNavigateOnce(key, url) {
    const token = `navigate:${key}`;
    if (url && !autoClicked.has(token)) {
      autoClicked.add(token);
      location.assign(url);
    }
  }

  /* ==================== 返回地址 ==================== */
  function setReturnUrl() {
    try { sessionStorage.setItem(RETURN_KEY, location.href); } catch (_) {}
  }

  function goBackOrReturn() {
    let target = null;
    try { target = sessionStorage.getItem(RETURN_KEY); } catch (_) {}
    if (!target || target === location.href) {
      target = workshopDetailUrl();
      if (target && isMultiChild()) {
        const sep = target.includes('?') ? '&' : '?';
        target = `${target}${sep}ccbMulti=1`;
      }
    }
    if (target && target !== location.href) {
      const key = `return:${location.hash}`;
      if (!autoClicked.has(key)) {
        autoClicked.add(key);
        location.assign(target);
        return true;
      }
    }
    const back = document.querySelector('.player_area .return-btn') || document.querySelector('.return-btn');
    const key = `back:${location.hash}`;
    if (autoClicked.has(key)) return false;
    autoClicked.add(key);
    if (back) { back.click(); return true; }
    if (history.length > 1) { history.back(); return true; }
    return false;
  }

  /* ==================== 多线程任务池 ==================== */
  function getTabId() {
    try {
      let id = sessionStorage.getItem(TAB_ID_KEY);
      if (!id) {
        id = 'tab_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
        sessionStorage.setItem(TAB_ID_KEY, id);
      }
      return id;
    } catch (_) {
      return 'tab_' + Math.random().toString(36).slice(2);
    }
  }

  function getPoolId() {
    const hash = location.hash;
    const q = hash.indexOf('?');
    if (q < 0) return null;
    const params = new URLSearchParams(hash.slice(q + 1));
    const id = params.get('id') || params.get('workshopId');
    return id ? `ws:${id}` : null;
  }

  const readPools = () => (typeof GM_getValue === 'function' ? GM_getValue(POOL_KEY, {}) || {} : {});
  const writePools = (all) => { if (typeof GM_setValue === 'function') GM_setValue(POOL_KEY, all); };

  function initPool(tasks) {
    const poolId = getPoolId();
    if (!poolId) return null;
    const all = readPools();
    all[poolId] = { createdAt: Date.now(), tasks };
    writePools(all);
    return poolId;
  }

  function computeRowTaskIds(rows) {
    const counts = {};
    return rows.map(row => {
      const title = textOf(row.cells?.[1] || row).slice(0, 60);
      counts[title] = (counts[title] || 0) + 1;
      return `${title}#${counts[title]}`;
    });
  }

  function claimTask() {
    const poolId = getPoolId();
    if (!poolId) return null;
    const tabId = getTabId();
    for (let attempt = 0; attempt < 3; attempt++) {
      const all = readPools();
      const pool = all[poolId];
      if (!pool) return null;
      const now = Date.now();
      for (const t of pool.tasks) {
        if (t.claimedBy && !t.done && now - t.claimTime > CLAIM_TTL) {
          t.claimedBy = null;
          t.claimTime = null;
        }
      }
      const task = pool.tasks.find(t => !t.done && !t.claimedBy);
      if (!task) { writePools(all); return null; }
      task.claimedBy = tabId;
      task.claimTime = now;
      writePools(all);
      const check = readPools()[poolId]?.tasks.find(t => t.id === task.id);
      if (check && check.claimedBy === tabId) return task;
    }
    return null;
  }

  function markTaskDone(taskId) {
    const poolId = getPoolId();
    if (!poolId) return;
    const all = readPools();
    const pool = all[poolId];
    if (!pool) return;
    const task = pool.tasks.find(t => t.id === taskId);
    if (task) {
      task.done = true;
      task.claimedBy = null;
      task.claimTime = null;
      writePools(all);
    }
  }

  function readCurrentTask() {
    try {
      const raw = sessionStorage.getItem(CURRENT_TASK_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function writeCurrentTask(v) {
    try {
      if (v) sessionStorage.setItem(CURRENT_TASK_KEY, JSON.stringify(v));
      else sessionStorage.removeItem(CURRENT_TASK_KEY);
    } catch (_) {}
  }

  function getPoolProgress(poolId) {
    const pool = readPools()[poolId];
    if (!pool) return null;
    const total = pool.tasks.length;
    const done = pool.tasks.filter(t => t.done).length;
    const claimed = pool.tasks.filter(t => t.claimedBy && !t.done).length;
    return { total, done, claimed };
  }

  /* ==================== 倍速控制 ==================== */
  function targetRate() {
    if (settings.force3x) return 3;
    if (settings.auto2x) return 2;
    return null;
  }

  function applyRate(video) {
    const rate = targetRate();
    if (!video || !rate) return;
    try {
      if (video.playbackRate !== rate) video.playbackRate = rate;
      if (video.defaultPlaybackRate !== rate) video.defaultPlaybackRate = rate;
    } catch (_) {}
  }

  function applyRateAll() {
    const rate = targetRate();
    const vids = [...document.querySelectorAll('video')];
    if (rate === null) {
      if (lastAppliedRate !== null) {
        for (const v of vids) {
          try { if (v.playbackRate === lastAppliedRate) v.playbackRate = 1; } catch (_) {}
        }
        lastAppliedRate = null;
      }
      return;
    }
    lastAppliedRate = rate;
    for (const v of vids) applyRate(v);
  }

  document.addEventListener('ratechange', e => {
    if (e.target && e.target.tagName === 'VIDEO') applyRate(e.target);
  }, true);

  /* ==================== 播放完成后的进度校验 ==================== */
  function currentVideo() {
    const vids = [...document.querySelectorAll('video')].filter(visible);
    return vids.find(v => Number.isFinite(v.duration) && v.duration > 0) || vids[0] || null;
  }
  function isVideoFinished(v) {
    if (!v) return false;
    if (v.ended) return true;
    return Number.isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.25;
  }
  function resetVerify() {
    verify.video = null;
    verify.active = false;
    verify.since = 0;
    verify.attempts = 0;
    verify.cooldownUntil = 0;
  }

  function ensureFullProgress() {
    if (!isVideoPage()) return null;
    if (Date.now() < verify.cooldownUntil) return { state: 'cooldown' };
    const v = currentVideo();
    if (!v) return null;
    if (v !== verify.video) {
      verify.video = v;
      verify.active = false;
      verify.since = 0;
      verify.attempts = 0;
    }
    if (!isVideoFinished(v)) {
      verify.active = false;
      return null;
    }
    if (!verify.active) {
      verify.active = true;
      verify.since = Date.now();
      return { state: 'waiting' };
    }
    if (Date.now() - verify.since < PROGRESS_WAIT_MS) return { state: 'waiting' };
    const p = findProgress();
    if (p !== null && p >= 100) return { state: 'done', progress: p };
    if (verify.attempts >= MAX_REPLAY) return { state: 'limit', progress: p };
    verify.attempts += 1;
    verify.active = false;
    verify.cooldownUntil = Date.now() + 2000;
    try { v.currentTime = 0; } catch (_) {}
    try { v.muted = isMultiChild() ? true : !!settings.muted; } catch (_) {}
    startedVideos.delete(v);
    try {
      const pr = v.play();
      if (pr?.catch) pr.catch(() => {});
    } catch (_) {}
    return { state: 'replaying', attempts: verify.attempts, progress: p };
  }

  /* ==================== 播放 ==================== */
  function safePlayVideo() {
    const video = [...document.querySelectorAll('video')].find(visible);
    if (!video) return '尚未检测到 HTML 视频播放器';
    const multi = isMultiChild();
    const wantMuted = multi ? true : !!settings.muted;
    try { video.muted = wantMuted; } catch (_) {}
    applyRate(video);
    if (settings.autoplay && video.paused && !video.ended) {
      const p = video.play();
      if (p?.then) p.then(() => startedVideos.add(video)).catch(() => {});
      else startedVideos.add(video);
    }
    const rateTag = targetRate() ? `，${targetRate()}×` : '';
    const muteTag = wantMuted ? '静音' : '有声';
    return `已应用播放设置（${muteTag}${rateTag}${multi ? '，多线程强制静音' : ''}）`;
  }

  /* ==================== 多线程 ==================== */
  function openedRecently(url) {
    if (typeof GM_getValue !== 'function') return false;
    const map = GM_getValue(OPENED_KEY, {}) || {};
    const t = map[url];
    return !!t && Date.now() - t < OPENED_TTL;
  }

  function markOpened(urls) {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
    const map = GM_getValue(OPENED_KEY, {}) || {};
    const now = Date.now();
    for (const k of Object.keys(map)) if (now - map[k] > OPENED_TTL) delete map[k];
    for (const u of urls) map[u] = now;
    GM_setValue(OPENED_KEY, map);
  }

  function collectListUrls() {
    const urls = [];
    const seen = new Set();
    const add = (href) => {
      if (!href || !/^https?:/i.test(href)) return;
      const clean = href.replace(/[?&]ccbMulti=[^&]*/g, '').replace(/[?&]ccbAuto=[^&]*/g, '');
      if (seen.has(clean)) return;
      seen.add(clean);
      urls.push(clean);
    };
    for (const a of document.querySelectorAll('a[href*="#/myworkshop/detail"]')) {
      if (!visible(a)) continue;
      const card = a.closest('.mv10.ml20.content') || a.parentElement || a;
      const t = `${textOf(a)} ${textOf(card)}`;
      if (!/未开始|未完成|进行中/.test(t)) continue;
      add(a.href);
    }
    if (!urls.length) {
      for (const c of getCourseCards()) {
        const a = c.link || (c.el.matches?.('a[href]') ? c.el : c.el.querySelector?.('a[href]'));
        if (a && a.href) add(a.href);
      }
    }
    return urls;
  }

  function runMulti() {
    const status = panel.querySelector('.status');

    if (isMultiChild()) {
      status.textContent = '当前是多线程子标签页，不能再次执行多线程。';
      return;
    }
    if (multiRunning) {
      status.textContent = '多线程正在启动中，请稍候…';
      return;
    }
    multiRunning = true;
    setTimeout(() => { multiRunning = false; }, 3000);

    const n = Math.max(1, Math.min(5, Number(settings.multiCount) || 1));

    /* ---------- 情况 A：专题班详情页 -> 创建任务池 + 打开子标签 ---------- */
    if (isWorkshopDetailPage()) {
      const detailRows = [...document.querySelectorAll('tr')]
        .filter(row => visible(row) && row.querySelector('.edit-block') && row.querySelector('.percent-text'));
      if (!detailRows.length) {
        status.textContent = '详情页课程表格尚未加载，请稍后重试。';
        return;
      }
      const incomplete = detailRows.filter(row => {
        const v = row.querySelector('.percent-text')?.textContent?.match(progressRe)?.[1];
        return v === undefined || Number(v) < 100;
      });
      if (!incomplete.length) {
        status.textContent = '该专题班内课程均已完成，无需多开。';
        return;
      }
      const ids = computeRowTaskIds(incomplete);
      const tasks = incomplete.map((row, idx) => ({
        id: ids[idx],
        title: textOf(row.cells?.[1] || row).slice(0, 40),
        claimedBy: null,
        claimTime: null,
        done: false,
      }));
      if (!initPool(tasks)) {
        status.textContent = '无法创建任务池（当前页面 URL 无法识别）。';
        return;
      }
      const count = Math.min(n, incomplete.length);
      let baseUrl = location.href.replace(/[?&]ccbMulti=[^&]*/g, '');
      const sep = baseUrl.includes('?') ? '&' : '?';
      let opened = 0;
      for (let i = 0; i < count; i++) {
        const url = `${baseUrl}${sep}ccbMulti=1`;
        try {
          const w = window.open(url, '_blank');
          if (w) opened++;
        } catch (_) {}
      }
      if (!opened) {
        status.textContent = '浏览器拦截了新标签页，请允许本站点弹出窗口后重试。';
        return;
      }
      setMultiParent(true);
      status.textContent = `已创建任务池（共 ${incomplete.length} 门课程），打开 ${opened} 个线程标签页。每个线程完成当前视频后会自动领取下一门未完成课程，任务池空后自动停止。`;
      update();
      return;
    }

    /* ---------- 情况 B：我的专题班列表页 -> 打开多个专题班详情页 ---------- */
    const listUrls = collectListUrls();
    if (!listUrls.length) {
      status.textContent = '当前页面未识别到可打开的未完成专题班。请确认列表已加载完成后重试。';
      return;
    }
    const fresh = listUrls.filter(u => !openedRecently(u));
    const toOpen = (fresh.length ? fresh : listUrls).slice(0, n);
    let opened = 0;
    for (const url of toOpen) {
      try {
        const sep = url.includes('?') ? '&' : '?';
        const w = window.open(`${url}${sep}ccbAuto=1`, '_blank');
        if (w) { opened++; markOpened([url]); }
      } catch (_) {}
    }
    if (!opened) {
      status.textContent = '浏览器拦截了新标签页，请允许本站点弹出窗口后重试。';
      return;
    }
    setMultiParent(true);
    status.textContent = fresh.length
      ? `已打开 ${opened} 个专题班详情页，每个标签页会自动进入该专题班的第一个未完成课程并依次刷完。`
      : `这些专题班最近已打开过，已重新打开 ${opened} 个。`;
    update();
  }

  /* ==================== 控制面板 ==================== */
  const panel = document.createElement('section');
  panel.id = 'ccb-helper-panel';
  panel.innerHTML = `
    <header><strong>学习辅助</strong><span class="controls"><button data-act="stop">强制停止</button><button data-act="resume" hidden>继续执行</button><button data-act="min" title="最小化/展开">−</button></span></header>
    <div class="body">
      <label><input type="checkbox" data-setting="autoOpen"> 自动进入未完成课程并继续学习</label>
      <label><input type="checkbox" data-setting="autoplay"> 检测到视频后自动播放</label>
      <label><input type="checkbox" data-setting="muted"> 自动静音（多线程时强制静音）</label>
      <div class="rate-row">
        <button data-act="rate3" class="rate-btn">强制开启 3 倍速</button>
        <span class="tip" data-tip="开启后视频强制以 3 倍速播放。3 倍速下平台有概率记录不满进度，脚本会在视频播放结束后自动核对进度条：未到 100% 会自动从头重播该视频（最多 ${MAX_REPLAY} 次），确认读取到 100% 后才会进入下一个未完成视频。">?</span>
      </div>
      <label><input type="checkbox" data-setting="auto2x"> 自动开启 2 倍速</label>
      <div class="multi-row">
        <span>多线程数量</span>
        <input type="number" data-setting="multiCount" min="1" max="5" step="1">
        <button data-act="multi">一键执行</button>
      </div>
      <div class="status" aria-live="polite"></div>
      <div class="actions"></div>
      <small>停止会暂停当前视频并同步停用其他建行标签中的自动操作。进度只读取平台数据。面板可拖动。</small>
    </div>`;

  const style = document.createElement('style');
  style.textContent = `
    #ccb-helper-panel{position:fixed;z-index:2147483647;right:18px;top:110px;width:300px;background:#fff;color:#222;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 5px 22px #0003;font:14px/1.45 system-ui,sans-serif}
    #ccb-helper-panel header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#eff6ff;border-radius:10px 10px 0 0;cursor:move;user-select:none}
    #ccb-helper-panel .controls{display:flex;gap:5px;align-items:center}
    #ccb-helper-panel button{cursor:pointer;border:1px solid #cbd5e1;border-radius:6px;background:#fff;padding:4px 9px}
    #ccb-helper-panel .body{padding:10px 12px;display:grid;gap:8px}
    #ccb-helper-panel label{display:flex;gap:7px;align-items:center}
    #ccb-helper-panel .status{color:#334155;min-height:20px}
    #ccb-helper-panel .actions{display:grid;gap:6px;max-height:180px;overflow:auto}
    #ccb-helper-panel .course{display:flex;justify-content:space-between;gap:8px;align-items:center;border-top:1px solid #e2e8f0;padding-top:6px}
    #ccb-helper-panel small{color:#64748b;font-size:11px}
    #ccb-helper-panel.min .body{display:none}#ccb-helper-panel.min{width:150px}
    #ccb-helper-panel .rate-row{display:flex;gap:6px;align-items:center}
    #ccb-helper-panel .rate-btn{flex:1;padding:5px 8px;transition:.15s}
    #ccb-helper-panel .rate-btn.on{background:#2563eb;border-color:#2563eb;color:#fff}
    #ccb-helper-panel .tip{position:relative;flex:none;width:18px;height:18px;border-radius:50%;background:#e2e8f0;color:#475569;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;cursor:help}
    #ccb-helper-panel .tip::after{content:attr(data-tip);position:absolute;right:-6px;top:24px;width:238px;background:#0f172a;color:#fff;font-size:11px;line-height:1.5;padding:8px 10px;border-radius:6px;opacity:0;visibility:hidden;transition:opacity .15s;z-index:20;pointer-events:none;white-space:normal;text-align:left}
    #ccb-helper-panel .tip:hover::after{opacity:1;visibility:visible}
    #ccb-helper-panel .multi-row{display:flex;gap:6px;align-items:center}
    #ccb-helper-panel .multi-row input{width:56px;padding:3px 6px;border:1px solid #cbd5e1;border-radius:6px}`;
  document.documentElement.append(style, panel);

  if (typeof settings.panelX === 'number' && typeof settings.panelY === 'number') {
    panel.style.right = 'auto';
    panel.style.left = Math.max(0, settings.panelX) + 'px';
    panel.style.top = Math.max(0, settings.panelY) + 'px';
  }

  (() => {
    const header = panel.querySelector('header');
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      dragging = true;
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const left = Math.max(0, Math.min(window.innerWidth - Math.min(w, 80), e.clientX - offX));
      const top = Math.max(0, Math.min(window.innerHeight - Math.min(h, 30), e.clientY - offY));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      settings.panelX = panel.offsetLeft;
      settings.panelY = panel.offsetTop;
      scheduleSave();
    });
  })();

  function syncUI() {
    for (const input of panel.querySelectorAll('[data-setting]')) {
      const name = input.dataset.setting;
      if (input.type === 'checkbox') input.checked = !!settings[name];
      else input.value = settings[name];
    }
    panel.querySelector('[data-act="rate3"]').classList.toggle('on', !!settings.force3x);
  }

  for (const input of panel.querySelectorAll('[data-setting]')) {
    const name = input.dataset.setting;
    input.addEventListener('change', () => {
      if (input.type === 'checkbox') {
        settings[name] = input.checked;
        if (name === 'force3x' && input.checked) settings.auto2x = false;
        if (name === 'auto2x' && input.checked) settings.force3x = false;
      } else {
        settings[name] = Math.max(1, Math.min(5, Number(input.value) || 1));
      }
      save();
      syncUI();
      resetVerify();
      applyRateAll();
      update();
    });
  }

  panel.querySelector('[data-act="rate3"]').addEventListener('click', () => {
    settings.force3x = !settings.force3x;
    if (settings.force3x) settings.auto2x = false;
    save();
    syncUI();
    resetVerify();
    applyRateAll();
    update();
  });

  panel.querySelector('[data-act="multi"]').addEventListener('click', runMulti);

  panel.querySelector('[data-act="min"]').addEventListener('click', () => {
    settings.minimized = !settings.minimized;
    panel.classList.toggle('min', settings.minimized);
    save();
  });

  function applyRunningState(next) {
    isRunning = !!next;
    panel.querySelector('[data-act="stop"]').hidden = !isRunning;
    panel.querySelector('[data-act="resume"]').hidden = isRunning;
    panel.classList.toggle('stopped', !isRunning);
    if (!isRunning) {
      for (const video of document.querySelectorAll('video')) {
        video.pause();
        startedVideos.delete(video);
      }
    }
    update();
  }

  panel.querySelector('[data-act="stop"]').addEventListener('click', () => {
    if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, false);
    applyRunningState(false);
  });
  panel.querySelector('[data-act="resume"]').addEventListener('click', () => {
    if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, true);
    applyRunningState(true);
  });
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(RUN_KEY, (_name, _oldValue, newValue) => applyRunningState(newValue !== false));
  }
  applyRunningState(isRunning);
  panel.classList.toggle('min', settings.minimized);
  syncUI();

  function addButton(actions, label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.append(b);
  }

  function onVideoComplete() {
    const cur = readCurrentTask();
    if (cur) {
      markTaskDone(cur.taskId);
      writeCurrentTask(null);
    }
    goBackOrReturn();
  }

  /* ==================== 主流程 ==================== */
  function update() {
    const status = panel.querySelector('.status');
    const actions = panel.querySelector('.actions');
    actions.replaceChildren();
    if (!isRunning) {
      status.textContent = '脚本已停止；点击“继续执行”恢复。';
      return;
    }

    /* ---------- 视频页 ---------- */
    if (isVideoPage()) {
      applyRateAll();
      const check = ensureFullProgress();

      if (check) {
        if (check.state === 'waiting') {
          status.textContent = `视频已播放完，正在等待平台回写进度… 当前 ${fmtProgress(findProgress())}`;
          return;
        }
        if (check.state === 'cooldown') {
          status.textContent = '正在重播视频，等待进度更新…';
          return;
        }
        if (check.state === 'replaying') {
          status.textContent = `播放结束但进度未记录满（${fmtProgress(check.progress)}），已第 ${check.attempts} 次重播该视频…`;
          return;
        }
        if (check.state === 'limit') {
          status.textContent = `已重播 ${MAX_REPLAY} 次，进度仍未满 100%（${fmtProgress(check.progress)}），请手动确认该视频。`;
          addButton(actions, '再重播一次', () => {
            resetVerify();
            const v = currentVideo();
            if (v) { try { v.currentTime = 0; v.play(); } catch (_) {} }
          });
          return;
        }
        if (check.state === 'done') {
          status.textContent = `视频进度 ${check.progress}%。已记录为 100%，准备进入下一个未完成视频。`;
          addButton(actions, '返回详情', () => onVideoComplete());
          if (settings.autoOpen) {
            const navKey = `done:${location.hash}`;
            if (!autoClicked.has(navKey)) {
              autoClicked.add(navKey);
              setTimeout(() => { if (isRunning) onVideoComplete(); }, 800);
            }
          }
          return;
        }
      }

      const p = findProgress();
      const playResult = safePlayVideo();
      const rateTag = targetRate() ? `；当前 ${targetRate()}×` : '';
      status.textContent = `视频页面：${p === null ? '未识别到进度' : `页面进度 ${p}%`}${rateTag}；${playResult}`;
      if (p !== null && p >= 100) {
        status.textContent += '。该视频已记录为 100%，准备进入下一个未完成视频。';
        addButton(actions, '返回详情', () => onVideoComplete());
        if (settings.autoOpen) {
          const navKey = `done:${location.hash}`;
          if (!autoClicked.has(navKey)) {
            autoClicked.add(navKey);
            setTimeout(() => { if (isRunning) onVideoComplete(); }, 800);
          }
        }
      }
      return;
    }

    /* ---------- 我的专题班列表页 ---------- */
    const cards = getCourseCards();
    if (cards.length) {
      status.textContent = settings.autoOpen
        ? `识别到 ${cards.length} 个未完成专题班；正在进入首个条目。`
        : `识别到 ${cards.length} 个未完成专题班；可在下方选择进入。`;
      cards.slice(0, 8).forEach(({ el, text }, i) => {
        const row = document.createElement('div');
        row.className = 'course';
        const title = document.createElement('span');
        title.textContent = text.slice(0, 48) || `课程条目 ${i + 1}`;
        const btn = document.createElement('button');
        btn.textContent = '进入';
        btn.addEventListener('click', () => {
          const link = el.matches?.('a[href]') ? el : el.querySelector('a[href]');
          const action = [...el.querySelectorAll('button,[role="button"]')].find(x => /进入|学习|查看|详情/.test(textOf(x)));
          if (link) location.href = link.href; else if (action) action.click(); else el.click();
        });
        row.append(title, btn);
        actions.append(row);
      });
      if (settings.autoOpen && cards[0] && !multiParent && (Date.now() - pageLoadTime > PAGE_LOAD_COOLDOWN)) {
        const firstLink = cards[0].link || (cards[0].el.matches?.('a[href]') ? cards[0].el : cards[0].el.querySelector('a[href]'));
        autoClickOnce(firstLink);
      }
      return;
    }

    /* ---------- 专题班详情页 ---------- */
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
      const ids = computeRowTaskIds(parsed.map(p => p.row));

      /* 父标签页：只显示任务池进度，不再自动动作 */
      if (multiParent && !isMultiChild()) {
        const prog = getPoolProgress(getPoolId());
        status.textContent = prog
          ? `多线程父页：任务池 ${prog.done}/${prog.total} 完成，${prog.claimed} 个正在处理中。`
          : '多线程父页：任务池已结束。可关闭本标签页。';
        return;
      }

      /* 子标签页：按任务池领取下一门 */
      if (isMultiChild()) {
        const poolId = getPoolId();
        if (!poolId) {
          status.textContent = '子标签页无法识别任务池，已停止。';
          return;
        }

        const cur = readCurrentTask();
        if (cur) {
          const task = readPools()[cur.poolId]?.tasks.find(t => t.id === cur.taskId);
          if (task && !task.done) {
            if (Date.now() - lastAutoActionTime < CLICK_COOLDOWN) return;
            const idx = ids.indexOf(task.id);
            if (idx >= 0 && parsed[idx].action) {
              lastAutoActionTime = Date.now();
              setReturnUrl();
              status.textContent = `继续任务：${task.title}，准备进入。`;
              parsed[idx].action.click();
              return;
            }
          }
          writeCurrentTask(null);
        }

        if (Date.now() - lastAutoActionTime < CLICK_COOLDOWN) return;
        const task = claimTask();
        if (!task) {
          const prog = getPoolProgress(poolId);
          status.textContent = prog
            ? `任务池已全部领取（${prog.done}/${prog.total} 完成，${prog.claimed} 处理中）。本线程任务完成，可关闭本标签页。`
            : '任务池为空，本线程工作完成，可关闭。';
          return;
        }
        const idx = ids.indexOf(task.id);
        if (idx < 0 || !parsed[idx].action) {
          markTaskDone(task.id);
          status.textContent = `任务 ${task.title} 未找到对应行，已跳过。`;
          return;
        }
        lastAutoActionTime = Date.now();
        setReturnUrl();
        writeCurrentTask({ poolId, taskId: task.id });
        status.textContent = `已领取任务：${task.title}，准备进入。`;
        parsed[idx].action.click();
        return;
      }

      /* 普通详情页（单线程） */
      status.textContent = `课程班内识别到 ${parsed.length} 门课程；按每行平台进度展示。`;
      parsed.forEach(({ title, progress, action }) => {
        const row = document.createElement('div');
        row.className = 'course';
        const label = document.createElement('span');
        label.textContent = `${title.slice(0, 34)} · ${progress === null ? '进度未识别' : `${progress}%`}`;
        row.append(label);
        if (progress === 100 || !action) {
          const done = document.createElement('span');
          done.textContent = progress === 100 ? '已完成' : '无入口';
          row.append(done);
        } else {
          const btn = document.createElement('button');
          btn.textContent = textOf(action) || '学习';
          btn.addEventListener('click', () => action.click());
          row.append(btn);
        }
        actions.append(row);
      });

      if (settings.autoOpen && incomplete.length) {
        if (Date.now() - pageLoadTime < PAGE_LOAD_COOLDOWN) return;
        if (Date.now() - lastAutoActionTime < CLICK_COOLDOWN) return;
        setReturnUrl();
        const key = `first:${incomplete[0].title}`;
        if (!clickedCourses.has(key)) {
          clickedCourses.add(key);
          lastAutoActionTime = Date.now();
          incomplete[0].action.click();
        }
      } else if (settings.autoOpen && parsed.length && parsed.every(item => item.progress === 100)) {
        status.textContent = '专题班内课程均显示 100%；返回专题班列表查找下一班。';
        autoNavigateOnce(location.hash, 'https://u.ccb.com/workshop/#/myworkshop');
      }
      return;
    }

    /* ---------- 课程详情页 ---------- */
    if (isCourseDetailPage()) {
      const continueButton = document.querySelector('button.to-learn') || findAction('继续学习');
      const p = findProgress();
      status.textContent = `课程详情页：${p === null ? '未识别到课程进度' : `平台进度 ${p}%`}${continueButton ? '；可继续学习' : ''}`;
      if (p === 100) {
        status.textContent = '课程进度已达 100%；返回专题班详情核对其他课程。';
        addButton(actions, '返回上一页核对其他课程', () => onVideoComplete());
        if (settings.autoOpen) {
          const navKey = `detail-done:${location.hash}`;
          if (!autoClicked.has(navKey)) {
            autoClicked.add(navKey);
            setTimeout(() => { if (isRunning) onVideoComplete(); }, 800);
          }
        }
      } else if (continueButton && visible(continueButton)) {
        addButton(actions, '继续学习', () => continueButton.click());
        if (settings.autoOpen && Date.now() - pageLoadTime > PAGE_LOAD_COOLDOWN) autoClickOnce(continueButton);
      }
      return;
    }

    const immediate = findAction('立即学习');
    if (immediate) {
      status.textContent = '检测到“立即学习”入口。';
      addButton(actions, '立即学习', () => immediate.click());
      if (settings.autoOpen && Date.now() - pageLoadTime > PAGE_LOAD_COOLDOWN) autoClickOnce(immediate);
      return;
    }

    if (isClassListPage()) {
      status.textContent = '已在“我的专题班”页面；未识别到带未完成状态的课程条目，请检查页面是否加载完成。';
      if (settings.autoOpen && !multiParent && Date.now() - pageLoadTime > PAGE_LOAD_COOLDOWN) {
        const start = findAction('立即学习');
        if (start) autoClickOnce(start);
      }
      return;
    }

    const start = findAction('我要学习');
    if (start) {
      status.textContent = '检测到课程确认页。';
      addButton(actions, '我要学习', () => start.click());
      if (settings.autoOpen && Date.now() - pageLoadTime > PAGE_LOAD_COOLDOWN) autoClickOnce(start);
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

  let lastCheckState = '';
  setInterval(() => {
    if (!isRunning || !isVideoPage()) return;
    applyRateAll();
    const v = currentVideo();
    if (v && settings.autoplay && v.paused && !v.ended && !verify.active) {
      try { v.play().catch(() => {}); } catch (_) {}
    }
    const r = ensureFullProgress();
    const token = r ? `${r.state}:${r.attempts ?? ''}` : '';
    if (token && token !== lastCheckState && r.state !== 'waiting' && r.state !== 'cooldown') {
      lastCheckState = token;
      update();
    }
  }, 800);
})();