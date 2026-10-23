// ==UserScript==
// @name         建行专题班学习辅助
// @namespace    local.ccb.course-helper
// @version      1.3.0
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

  const MAX_REPLAY = 3;             // 单个视频最多补播次数
  const PROGRESS_WAIT_MS = 3500;    // 播放结束后等待平台回写进度的时间
  const OPENED_TTL = 30 * 60 * 1000; // 多开去重有效期

  const defaults = {
    autoOpen: true,
    autoplay: true,
    muted: true,
    minimized: false,
    force3x: false,   // 强制 3 倍速
    auto2x: false,    // 自动 2 倍速
    multiCount: 2,    // 多线程数量 1-5
  };

  const settings = {
    ...defaults,
    ...(typeof GM_getValue === 'function' ? GM_getValue(KEY, {}) : {}),
  };
  settings.multiCount = Math.max(1, Math.min(5, Number(settings.multiCount) || 2));

  let isRunning = typeof GM_getValue === 'function' ? GM_getValue(RUN_KEY, true) !== false : true;

  const autoClicked = new Set();
  const startedVideos = new WeakSet();

  // 播放完成后的进度校验状态
  const verify = { video: null, active: false, since: 0, attempts: 0, cooldownUntil: 0 };
  let lastAppliedRate = null;

  const save = () => typeof GM_setValue === 'function' && GM_setValue(KEY, settings);
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const textOf = el => norm(el?.innerText || el?.textContent || '');
  const progressRe = /(\d{1,3}(?:\.\d+)?)\s*%/;
  const fmtProgress = p => (p === null || p === undefined ? '未识别' : `${p}%`);

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

  /* ==================== 进度读取（保持原有逻辑） ==================== */
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

  /* ==================== 课程条目识别（保持原有逻辑） ==================== */
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

  /* ==================== 倍速控制（新增） ==================== */
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
    } catch (_) { /* 某些播放器禁止改速，忽略 */ }
  }

  // 反复下发倍速，防止播放器自己把 playbackRate 改回去
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

  // 播放器内部改速时立刻纠正
  document.addEventListener('ratechange', e => {
    if (e.target && e.target.tagName === 'VIDEO') applyRate(e.target);
  }, true);

  /* ==================== 播放完成后的进度校验 + 补播（新增） ==================== */
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

  /**
   * 播放结束后核对进度条：
   *  - 进度为 100%  -> { state:'done' }
   *  - 未满 100%    -> 自动从头重播，最多 MAX_REPLAY 次
   *  - 重播次数用尽 -> { state:'limit' }
   */
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
    if (p !== null && p >= 100) {
      return { state: 'done', progress: p };
    }
    if (verify.attempts >= MAX_REPLAY) {
      return { state: 'limit', progress: p };
    }

    // 进度没跑满，重播该视频
    verify.attempts += 1;
    verify.active = false;
    verify.cooldownUntil = Date.now() + 2000;
    try { v.currentTime = 0; } catch (_) {}
    try { v.muted = !!settings.muted; } catch (_) {}
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
    video.muted = !!settings.muted;
    applyRate(video);
    if (settings.autoplay && !startedVideos.has(video)) {
      const p = video.play();
      if (p?.then) {
        p.then(() => startedVideos.add(video)).catch(() => {
          // 浏览器可能在媒体尚未就绪时拒绝播放；后续页面更新时再尝试。
        });
      } else {
        startedVideos.add(video);
      }
    }
    return `已应用播放设置（${settings.muted ? '静音' : '有声'}${targetRate() ? `，${targetRate()}×` : ''}）`;
  }

  /* ==================== 多线程播放（新增） ==================== */
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

  // 收集当前页面可多开的未完成课程/专题班链接
  function collectPlayableUrls() {
    const urls = new Set();

    // 1）“我的专题班”列表里的未完成专题班
    for (const a of document.querySelectorAll('a[href*="#/myworkshop/detail"]')) {
      if (!visible(a)) continue;
      const card = a.closest('.mv10.ml20.content') || a.parentElement || a;
      const t = `${textOf(a)} ${textOf(card)}`;
      if (!/未开始|未完成|进行中/.test(t)) continue;
      if (a.href) urls.add(a.href);
    }

    // 2）专题班详情表格里带链接且未满 100% 的课程行
    for (const row of document.querySelectorAll('tr')) {
      if (!visible(row) || !row.querySelector('.percent-text')) continue;
      const value = row.querySelector('.percent-text')?.textContent?.match(progressRe)?.[1];
      if (value !== undefined && Number(value) >= 100) continue;
      const link = [...row.querySelectorAll('a[href]')].find(visible);
      if (link && /^https?:/i.test(link.href)) urls.add(link.href);
    }

    return [...urls];
  }

  function runMulti() {
    const status = panel.querySelector('.status');
    const n = Math.max(1, Math.min(5, Number(settings.multiCount) || 1));
    const all = collectPlayableUrls();
    const fresh = all.filter(u => !openedRecently(u));
    const picked = fresh.slice(0, n);

    if (!picked.length) {
      status.textContent = all.length
        ? '这些课程已在其他标签页打开过，请稍后或回到“我的专题班”列表再试。'
        : '当前页面没有可多开的未完成课程链接，请回到“我的专题班”列表后重试。';
      return;
    }

    let opened = 0;
    for (const url of picked) {
      try {
        const w = window.open(url, '_blank');
        if (w) {
          opened += 1;
          markOpened([url]);
        }
      } catch (_) {}
    }

    if (!opened) {
      status.textContent = '浏览器拦截了新标签页，请允许本站点弹出窗口后重试。';
      return;
    }
    status.textContent = `已开启 ${opened} 个播放标签页（目标 ${n} 个）；每个标签页会自动进入课程并按当前倍速设置播放。`;
  }

  /* ==================== 控制面板 ==================== */
  const panel = document.createElement('section');
  panel.id = 'ccb-helper-panel';
  panel.innerHTML = `
    <header><strong>学习辅助</strong><span class="controls"><button data-act="stop">强制停止</button><button data-act="resume" hidden>继续执行</button><button data-act="min" title="最小化/展开">−</button></span></header>
    <div class="body">
      <label><input type="checkbox" data-setting="autoOpen"> 自动进入未完成课程并继续学习</label>
      <label><input type="checkbox" data-setting="autoplay"> 检测到视频后自动播放</label>
      <label><input type="checkbox" data-setting="muted"> 自动静音</label>
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
      <small>停止会暂停当前视频并同步停用其他建行标签中的自动操作。进度只读取平台数据。</small>
    </div>`;

  const style = document.createElement('style');
  style.textContent = `
    #ccb-helper-panel{position:fixed;z-index:2147483647;right:18px;top:110px;width:300px;background:#fff;color:#222;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 5px 22px #0003;font:14px/1.45 system-ui,sans-serif}
    #ccb-helper-panel header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#eff6ff;border-radius:10px 10px 0 0}
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
        // 3 倍速与 2 倍速互斥
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

  /* ==================== 面板小工具 ==================== */
  function addButton(actions, label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.append(b);
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

    if (isVideoPage()) {
      applyRateAll();
      const check = ensureFullProgress();

      if (check && check.state === 'replaying') {
        status.textContent = `播放结束但进度未记录满（${fmtProgress(check.progress)}），已第 ${check.attempts} 次重播该视频…`;
        return;
      }
      if (check && check.state === 'limit') {
        status.textContent = `已重播 ${MAX_REPLAY} 次，进度仍未满 100%（${fmtProgress(check.progress)}），请手动确认该视频。`;
        addButton(actions, '再重播一次', () => {
          resetVerify();
          const v = currentVideo();
          if (v) {
            try { v.currentTime = 0; v.play(); } catch (_) {}
          }
        });
        return;
      }

      const p = (check && check.state === 'done') ? check.progress : findProgress();
      const playResult = safePlayVideo();
      const rateTag = targetRate() ? `；当前 ${targetRate()}×` : '';
      status.textContent = `视频页面：${p === null ? '未识别到进度' : `页面进度 ${p}%`}${rateTag}；${playResult}`;

      if (p !== null && p >= 100) {
        status.textContent += '。该视频已记录为 100%，准备进入下一个未完成视频。';
        addButton(actions, '返回详情', () => {
          const back = document.querySelector('.player_area .return-btn');
          if (back) back.click(); else history.back();
        });
        if (settings.autoOpen) {
          const target = workshopDetailUrl();
          if (target) autoNavigateOnce(location.hash, target);
        }
      }
      return;
    }

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

  // 倍速保持 + 进度校验的高频轮询
  let lastCheckState = '';
  setInterval(() => {
    if (!isRunning || !isVideoPage()) return;
    applyRateAll();
    const r = ensureFullProgress();
    const token = r ? `${r.state}:${r.attempts ?? ''}` : '';
    if (token && token !== lastCheckState && r.state !== 'waiting' && r.state !== 'cooldown') {
      lastCheckState = token;
      update();
    }
  }, 800);
})();