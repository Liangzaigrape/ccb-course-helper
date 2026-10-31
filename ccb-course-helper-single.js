// ==UserScript==
// @name         建行专题班学习辅助-单线程版
// @namespace    local.ccb.course-helper
// @version      1.8.7
// @description  支持专题班、门户课程、有声书和培训课程的单任务及四路后台队列。
// @match        https://u.ccb.com/workshop/*
// @match        https://u.ccb.com/course/*
// @match        https://u.ccb.com/portal/*
// @match        https://u.ccb.com/sys/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'ccbCourseHelperSettingsV2';
  const RUN_KEY = 'ccbCourseHelperSingleRunning';
  const AUTO_CHILD_KEY = 'ccbCourseHelperSingleAutoChild';
  const WORKSHOP_RETURN_KEY = 'ccbCourseHelperSingleWorkshopReturn';
  const BATCH_DONE_PREFIX = 'ccbCourseHelperSingleBatchDone';
  const ACTIVE_WORKSHOP_KEY = 'ccbCourseHelperActiveWorkshop';
  const SUPPRESSED_TAB_KEY = 'ccbCourseHelperSuppressedAfterClose';
  const DETAIL_TAB_PREFIX = 'ccbCourseHelperDetailTab:';
  const DETAIL_TAB_ID_KEY = 'ccbCourseHelperDetailTabId';
  const DETAIL_TAB_ORIGIN_KEY = 'ccbCourseHelperDetailTabOrigin';
  const PORTAL_QUEUE_KEY = 'ccbCourseHelperPortalQueue';
  const PORTAL_SELECTION_KEY = 'ccbCourseHelperPortalSelection';
  const COURSE_RETURN_KEY = 'ccbCourseHelperCourseReturn';
  const SYS_QUEUE_KEY = 'ccbCourseHelperSysChannelQueue';
  const SYS_SELECTION_PREFIX = 'ccbCourseHelperSysChannelSelection:';
  const SYS_RESTART_KEY = 'ccbCourseHelperSysChannelRestart';
  const SYS_WORKER_SESSION_KEY = 'ccbCourseHelperSysWorker';
  const SYS_WORKER_STATE_PREFIX = 'ccbCourseHelperSysWorkerState:';
  const defaults = { autoOpen: true, autoplay: true, muted: true, auto2x: true, forced3: false, minimized: false };
  const settings = { ...defaults, ...(typeof GM_getValue === 'function' ? GM_getValue(KEY, {}) : {}) };
  let isRunning = typeof GM_getValue === 'function' ? GM_getValue(RUN_KEY, true) !== false : true;
  let managedTabs = [];
  let batchActive = false;
  let batchReloadScheduled = false;
  let batchStartedAt = 0;
  let allDoneSince = 0;
  let childBatchId = '';
  let childWorkerId = '';
  let childDoneReported = false;
  let activeBatchId = '';
  let paginationScan = null;
  const pageLoadTime = Date.now();
  let wakeLockSentinel = null;
  let wakeLockPending = false;
  let wakeLockFailed = false;
  const autoClicked = new Set();
  let detailTabId = '';
  let detailTabCourseId = '';
  let detailTabOpenedAt = 0;
  let detailTabLastWrite = 0;
  let portalCourseDoneSince = 0;
  let multiLessonPauseProbe = { key: '', since: 0 };
  let lastRewoundPlaybackKey = '';
  const attemptedNativeAutoplay = new WeakSet();
  let sysChannelScan = null;
  const sysWorkerTabs = new Map();
  const sysWorkerListeners = new Map();
  const save = () => typeof GM_setValue === 'function' && GM_setValue(KEY, settings);
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const textOf = el => norm(el?.innerText || el?.textContent || '');
  const progressRe = /(\d{1,3}(?:\.\d+)?)\s*%/;
  const incompleteStatusRe = /未开始|未完成|进行中/;
  const completedStatusRe = /已完成|已结课|已结束/;

  function refreshWakeLockUI() {
    const note = panel?.querySelector('.wake-status');
    if (!note) return;
    if (!navigator.wakeLock?.request) note.textContent = '此浏览器不支持屏幕唤醒锁，系统仍可能自动休眠。';
    else if (!isRunning) note.textContent = '脚本已停止，屏幕唤醒锁已释放。';
    else if (wakeLockSentinel) note.textContent = '屏幕唤醒锁已启用；请保持此浏览器窗口打开。';
    else if (document.visibilityState !== 'visible') note.textContent = '页面在后台时浏览器会释放唤醒锁，切回页面后会重新申请。';
    else if (wakeLockFailed) note.textContent = '浏览器未能启用屏幕唤醒锁，系统仍可能自动休眠。';
    else note.textContent = '正在申请屏幕唤醒锁…';
  }

  async function requestScreenWakeLock() {
    if (!isRunning || document.visibilityState !== 'visible' || !navigator.wakeLock?.request
      || wakeLockSentinel || wakeLockPending) {
      refreshWakeLockUI();
      return;
    }
    wakeLockPending = true;
    wakeLockFailed = false;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!isRunning || document.visibilityState !== 'visible') {
        await sentinel.release();
        return;
      }
      wakeLockSentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
        refreshWakeLockUI();
      }, { once: true });
    } catch {
      wakeLockFailed = true;
    } finally {
      wakeLockPending = false;
      refreshWakeLockUI();
    }
  }

  function releaseScreenWakeLock() {
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    if (sentinel) sentinel.release().catch(() => {});
    refreshWakeLockUI();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestScreenWakeLock();
    else refreshWakeLockUI();
  });
  window.addEventListener('pagehide', releaseScreenWakeLock);

  const isManagedChild = () => {
    try { return sessionStorage.getItem(AUTO_CHILD_KEY) === '1'; } catch { return false; }
  };
  try {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (params.has('ccbAuto')) {
      sessionStorage.setItem(AUTO_CHILD_KEY, '1');
      childBatchId = params.get('ccbBatch') || '';
      childWorkerId = params.get('ccbWorker') || '';
    }
    if (location.pathname.includes('/workshop') && /^#\/myworkshop\/detail/.test(location.hash)) {
      params.delete('ccbAuto');
      const route = location.hash.split('?')[0];
      const query = params.toString();
      sessionStorage.setItem(WORKSHOP_RETURN_KEY, `${location.origin}${location.pathname}${route}${query ? `?${query}` : ''}`);
    }
  } catch { /* 忽略 */ }

  const visibleVideo = () => [...document.querySelectorAll('video,audio')].find(visible);
  const targetRate = () => (settings.forced3 ? 3 : (settings.auto2x ? 2 : 0));
  const videoRecoveryStates = new WeakMap();

  function getVideoRecoveryState(video) {
    let state = videoRecoveryStates.get(video);
    if (state) return state;
    state = { retries: 0, nextRetryAt: 0, lastError: '', waitingSince: 0 };
    videoRecoveryStates.set(video, state);
    video.addEventListener('playing', () => {
      state.retries = 0;
      state.nextRetryAt = 0;
      state.lastError = '';
      state.waitingSince = 0;
      claimActiveWorkshop(true);
    });
    video.addEventListener('waiting', () => {
      if (!state.waitingSince) state.waitingSince = Date.now();
    });
    video.addEventListener('canplay', () => { state.waitingSince = 0; });
    video.addEventListener('error', () => {
      const code = video.error?.code;
      state.lastError = code ? `媒体错误 ${code}` : '播放器媒体错误';
    });
    video.addEventListener('pause', () => {
      if (!isRunning || !settings.autoplay || video.ended || !visible(video) || state.pauseRecoveryTimer) return;
      state.nextRetryAt = 0;
      state.pauseRecoveryTimer = setTimeout(() => {
        state.pauseRecoveryTimer = null;
        if (!isRunning || !settings.autoplay || !video.paused || video.ended || video.error || !visible(video)) return;
        const progress = findProgress();
        if (progress === 100) return;
        keepVideoPlaying(video);
      }, 1200);
    });
    return state;
  }

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
    if (video instanceof HTMLMediaElement && targetRate()) applyPlaybackRate(video);
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
      .filter(a => {
        if (!visible(a)) return false;
        const root = a.closest('.mv10.ml20.content') || a.parentElement?.parentElement || a;
        const cardText = `${textOf(a)} ${textOf(root)}`;
        return incompleteStatusRe.test(cardText) && !completedStatusRe.test(cardText);
      });
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
      return incompleteStatusRe.test(t) && !completedStatusRe.test(t);
    });
    const found = new Set();
    for (const leaf of leaves) {
      let el = leaf;
      for (let i = 0; i < 7 && el && el !== document.body; i++, el = el.parentElement) {
        const t = textOf(el);
        if (t.length > 30 && t.length < 1200 && incompleteStatusRe.test(t) && !completedStatusRe.test(t)
          && el.querySelector('a[href*="#/myworkshop/detail"],button,[role="button"]')) {
          found.add(el);
          break;
        }
      }
    }
    return [...found].map(el => ({ el, text: textOf(el) }));
  }

  function findPaginationNext() {
    const pageInfo = document.querySelector('.pageinfo');
    if (pageInfo) {
      // 当前站点的“下一页”是绑定 Vue 点击事件的 span。不同浏览器/用户脚本管理器
      // 下对该 span 的 click() 兼容性不一致；优先点击实际的下一页数字链接。
      const current = Number(textOf(pageInfo.querySelector('.current')));
      if (Number.isInteger(current) && current > 0) {
        const numericNext = [...pageInfo.querySelectorAll('a,button,[role="button"]')]
          .find(el => visible(el) && Number(textOf(el)) === current + 1 && !el.disabled
            && el.getAttribute('aria-disabled') !== 'true');
        if (numericNext) return numericNext;
      }
      const next = [...pageInfo.querySelectorAll('.pagetext,span,a,button')]
        .find(el => visible(el) && /^下一页$/.test(textOf(el)));
      if (next) return /disable|disabled/.test(String(next.className || '').toLowerCase()) ? null : next;
    }
    const clickable = [...document.querySelectorAll('a,button,[role="button"]')].filter(visible);
    const next = clickable.find(el => {
      const label = textOf(el).replace(/[›»>]+$/g, '').trim();
      const cls = String(el.className || '').toLowerCase();
      return /^(下一页|下页|next)$/i.test(label) || /(^|\s)(next|btn-next)(\s|$)/.test(cls);
    });
    if (!next) return null;
    const disabled = next.disabled || next.getAttribute('aria-disabled') === 'true'
      || /disabled/.test(String(next.className || '').toLowerCase())
      || /disabled/.test(String(next.parentElement?.className || '').toLowerCase());
    return disabled ? null : next;
  }

  function getPaginationPageToken() {
    const pageInfo = document.querySelector('.pageinfo');
    const pageNumber = pageInfo?.querySelector('.current');
    if (pageNumber && visible(pageNumber)) return textOf(pageNumber);
    const pager = [...document.querySelectorAll('[class*="pagination"],[class*="Pagination"],[aria-label*="分页"], [role="navigation"]')]
      .find(visible);
    const active = pager?.querySelector('[aria-current="page"],.active,.current,[class*="active"]');
    return active && visible(active) ? textOf(active) : '';
  }

  function listPageFingerprint() {
    // 分页器的页码常先更新，课程卡片则由异步请求稍后替换。用所有课程入口
    // （包括已完成课程）作为列表指纹，避免只看页码就把过渡状态计为新页面。
    const entries = [...document.querySelectorAll('a[href*="#/myworkshop/detail"]')]
      .filter(visible)
      .map(link => `${link.href}:${textOf(link.closest('.mv10.ml20.content') || link.parentElement?.parentElement || link).slice(0, 120)}`)
      .sort().join('|');
    return entries || textOf(document.querySelector('.contentlist,.content-list,main') || document.body).slice(0, 500);
  }

  function scanAllListPages() {
    const cards = getCourseCards();
    const currentPage = getPaginationPageToken();
    // 若用户或站点已经切到其他页，清除旧的“扫描完成”状态；否则旧的 1 页结果
    // 会一直压住新页面上的课程识别结果。
    if (paginationScan?.done && currentPage && paginationScan.finalPageToken !== currentPage) paginationScan = null;
    if (!paginationScan) {
      paginationScan = { urls: new Set(), seenPages: new Set(), waitingFor: '', waitingPage: '', waitingContent: '', waitStartedAt: 0, resetting: false, done: false };
      if (currentPage && currentPage !== '1') {
        const pager = document.querySelector('.pageinfo')
          || [...document.querySelectorAll('[class*="pagination"],[class*="Pagination"],[aria-label*="分页"], [role="navigation"]')].find(visible);
        const firstPage = [...(pager?.querySelectorAll('a,button,[role="button"]') || [])]
          .find(el => visible(el) && textOf(el) === '1' && !el.disabled);
        if (firstPage) {
          paginationScan.waitingFor = 'page-change';
          paginationScan.waitingPage = currentPage;
          paginationScan.waitingContent = listPageFingerprint();
          paginationScan.waitStartedAt = Date.now();
          paginationScan.resetting = true;
          firstPage.click();
          return { state: 'scanning', urls: [], pages: 0 };
        }
      }
    }
    if (paginationScan.done) return { state: 'done', urls: [...paginationScan.urls], pages: paginationScan.seenPages.size };

    const pageToken = getPaginationPageToken();
    const contentFingerprint = listPageFingerprint();
    const fingerprint = `${pageToken}::${contentFingerprint}`;
    if (paginationScan.waitingFor) {
      const pageChanged = pageToken && pageToken !== paginationScan.waitingPage;
      const contentChanged = contentFingerprint !== paginationScan.waitingContent;
      if (!pageChanged || !contentChanged) {
        // 列表切页会触发异步请求；给较慢页面留出渲染时间，避免把仍在加载的页
        // 误判成“只有 1 页”。
        if (Date.now() - paginationScan.waitStartedAt < 30000) return { state: 'scanning', urls: [] };
        paginationScan.waitStartedAt = Date.now();
        const retry = paginationScan.resetting
          ? [...(document.querySelector('.pageinfo')?.querySelectorAll('a,button,[role="button"]') || [])]
            .find(el => visible(el) && textOf(el) === '1' && !el.disabled)
          : findPaginationNext();
        if (retry) retry.click();
        return { state: 'scanning', urls: [], pages: paginationScan.seenPages.size };
      }
      paginationScan.waitingFor = '';
      paginationScan.waitingPage = '';
      paginationScan.waitingContent = '';
      paginationScan.resetting = false;
    }
    if (paginationScan.seenPages.has(fingerprint)) {
      paginationScan.done = true;
      paginationScan.finalPageToken = pageToken;
      return { state: 'done', urls: [...paginationScan.urls], pages: paginationScan.seenPages.size };
    }
    paginationScan.seenPages.add(fingerprint);

    for (const card of cards) {
      const link = card.link || (card.el.matches?.('a[href]') ? card.el : card.el.querySelector('a[href*="#/myworkshop/detail"]'));
      const cardText = `${textOf(link)} ${textOf(card.el)}`;
      if (!link?.href || !incompleteStatusRe.test(cardText) || completedStatusRe.test(cardText)) continue;
      paginationScan.urls.add(link.href);
    }

    const next = findPaginationNext();
    if (next && paginationScan.seenPages.size < 100) {
      paginationScan.waitingFor = 'page-change';
      paginationScan.waitingPage = pageToken;
      paginationScan.waitingContent = contentFingerprint;
      paginationScan.waitStartedAt = Date.now();
      next.click();
      return { state: 'scanning', urls: [], pages: paginationScan.seenPages.size };
    }
    paginationScan.done = true;
    paginationScan.finalPageToken = pageToken;
    return { state: 'done', urls: [...paginationScan.urls], pages: paginationScan.seenPages.size };
  }

  function isVideoPage() {
    return /^#\/play\/[^?]+/.test(location.hash)
      || [...document.querySelectorAll('video,audio')].some(visible);
  }

  function isCourseDetailPage() {
    return location.pathname.replace(/\/$/, '') === '/course' && /^#\/detail\/[^?]+/.test(location.hash);
  }

  function portalQueue() {
    return typeof GM_getValue === 'function' ? GM_getValue(PORTAL_QUEUE_KEY, null) : null;
  }

  function savePortalQueue(queue) {
    if (typeof GM_setValue === 'function') GM_setValue(PORTAL_QUEUE_KEY, queue);
  }

  function activePortalQueue() {
    const queue = portalQueue();
    return queue?.active && Array.isArray(queue.items) && queue.index < queue.items.length ? queue : null;
  }

  function advancePortalQueue(queue) {
    const nextQueue = { ...queue, index: queue.index + 1, stalledSince: 0, currentLesson: '' };
    if (nextQueue.index >= nextQueue.items.length) {
      savePortalQueue({ ...nextQueue, active: false, completed: true });
      return null;
    }
    savePortalQueue(nextQueue);
    return nextQueue.items[nextQueue.index];
  }

  function portalStallDuration(queue) {
    const video = visibleVideo();
    if (video && !video.paused && !video.ended && !video.error) {
      if (queue.stalledSince) savePortalQueue({ ...queue, stalledSince: 0 });
      return 0;
    }
    const since = Number(queue.stalledSince) || Date.now();
    if (!queue.stalledSince) savePortalQueue({ ...queue, stalledSince: since });
    return Date.now() - since;
  }

  function skipStalledPortalCourse(queue, status) {
    const item = queue.items[queue.index];
    const next = advancePortalQueue(queue);
    if (next) {
      status.textContent = `“${item.title}”连续 15 秒没有播放视频，已超时跳过；正在进入下一门“${next.title}”。`;
      location.href = next.url;
    } else {
      status.textContent = `“${item.title}”连续 15 秒没有播放视频，已超时跳过；队列中没有其他课程。`;
    }
  }

  function markPortalLessonComplete(queue) {
    const current = queue?.currentLesson;
    const item = queue?.items?.[queue.index];
    if (!current || !item) return;
    const finishedLessons = { ...(queue.finishedLessons || {}) };
    const names = new Set(finishedLessons[item.id] || []);
    names.add(current);
    finishedLessons[item.id] = [...names];
    savePortalQueue({ ...queue, finishedLessons, currentLesson: '' });
  }

  function portalCourseIsComplete(course) {
    return course.progress === 100 || course.completed === true;
  }

  function portalCourseTotalProgress() {
    const progressRoot = document.querySelector('.progress-v');
    if (!progressRoot) return null;
    const nested = findProgress(progressRoot);
    if (nested !== null) return nested;
    const match = textOf(progressRoot).match(progressRe);
    return match ? Number(match[1]) : null;
  }

  function courseDetailId(url = location.href) {
    const match = String(url).match(/\/course\/#\/detail\/([^?&#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function rememberCourseDetailReturnUrl() {
    if (!isCourseDetailPage()) return;
    try { sessionStorage.setItem(COURSE_RETURN_KEY, location.href.split('&ccb')[0]); } catch { /* 忽略 */ }
  }

  function courseDetailReturnUrl() {
    try {
      const saved = sessionStorage.getItem(COURSE_RETURN_KEY);
      if (saved) return saved;
    } catch { /* 忽略 */ }
    const queue = activePortalQueue();
    return queue?.items?.[queue.index]?.url || null;
  }

  function portalQueueForCurrentVideo() {
    const queue = activePortalQueue();
    if (!queue || !isVideoPage()) return null;
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const knowledgeId = params.get('pKnowledgeId') || courseDetailId(courseDetailReturnUrl() || '');
    return knowledgeId && knowledgeId === queue.items[queue.index]?.id ? queue : null;
  }

  function hasWorkshopTaskReturn() {
    try { return !!sessionStorage.getItem(WORKSHOP_RETURN_KEY); } catch { return false; }
  }

  function portalCourseSections() {
    const wanted = ['党的理论教育', '党性教育', '履职能力'];
    const sections = [];
    for (const module of document.querySelectorAll('.cuWeb-linkModule')) {
      const heading = textOf(module.querySelector('.cuWeb-listheader-web-title'));
      const section = wanted.find(name => heading.includes(name));
      if (!section) continue;
      const courses = [];
      const seen = new Set();
      for (const card of module.querySelectorAll('.cuWeb-linkModule-style2[data-link]')) {
        const title = textOf(card.querySelector('h3'));
        const raw = card.getAttribute('data-link') || '';
        let url;
        try { url = new URL(raw, location.origin).href; } catch { continue; }
        if (!title || !/^https:\/\/u\.ccb\.com\/course\/#\/detail\/[^?&#]+/.test(url) || seen.has(url)) continue;
        seen.add(url);
        const progress = findProgress(card);
        courses.push({ section, title, url, id: courseDetailId(url), progress,
          completed: completedStatusRe.test(textOf(card)) });
      }
      if (courses.length) sections.push({ name: section, courses });
    }
    return sections;
  }

  function portalCourseLessons() {
    return [...document.querySelectorAll('.catalog-sec-item')].map(row => {
      const title = textOf(row.querySelector('.lesson-index')) || textOf(row);
      const progressText = row.querySelector('.lesson-rate')?.textContent || textOf(row);
      const progressMatch = progressText.match(progressRe);
      const progress = progressMatch ? Number(progressMatch[1]) : null;
      const labels = [...row.querySelectorAll('[aria-label],[title]')]
        .map(el => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`).join(' ');
      const explicitCheck = /[✔✓√]/.test(textOf(row)) || /已完成|已学完/.test(labels);
      // 课时行有明确百分比时，以该课时自身进度为准；不能被同一行的图标样式误判。
      const checked = progress === null ? explicitCheck : progress >= 100;
      return { row, title, progress, locked: row.classList.contains('disable'), checked };
    }).filter(item => item.title);
  }

  function startPortalLesson(queue, lesson) {
    savePortalQueue({ ...queue, currentLesson: lesson.title });
    const action = lesson.row.querySelector('a,button,[role="button"]');
    if (action) action.click(); else lesson.row.click();
  }

  function isClassListPage() {
    return /^#\/myworkshop(?:\?.*)?$/.test(location.hash);
  }

  function isPortalStudyPage() {
    return location.pathname.replace(/\/$/, '') === '/portal' && /^#\/study(?:\?.*)?$/.test(location.hash);
  }

  function isSysChannelMorePage() {
    return location.pathname.replace(/\/$/, '') === '/sys' && /^#\/channel\/more(?:\?.*)?$/.test(location.hash);
  }

  function sysChannelInfo() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const mid = params.get('mid') || '';
    const kinds = {
      '2b483b4d-2d27-4f5a-9366-6efe50dfc32f': '有声书',
      '45defce4-c0b2-4a34-bf40-dd2caf8b477e': '培训课程',
    };
    return { mid, name: kinds[mid] || '课程频道' };
  }

  function sysItemIdentity(url) {
    const direct = courseDetailId(url);
    if (direct) return direct;
    try {
      const parsed = new URL(url, location.origin);
      const params = new URLSearchParams(parsed.hash.split('?')[1] || '');
      for (const key of ['courseId', 'contentId', 'bookId', 'audioId', 'id', 'knowledgeId']) {
        if (params.has(key)) return `${parsed.pathname}:${params.get(key)}`;
      }
      return `${parsed.pathname}:${parsed.hash.split('?')[0]}`;
    } catch { return url; }
  }

  function normalizeSysContentUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return '';
      const route = url.hash.split('?')[0].toLowerCase();
      if (/channel\/more|channel\/index|\/login|\/home|\/search|\/list/.test(route)) return '';
      if (/\/play(?:\/|$)/.test(route)) return '';
      if (!/(detail|course|audio|book|video|lesson|play|content)/.test(route)) return '';
      const params = new URLSearchParams(url.hash.split('?')[1] || '');
      for (const key of [...params.keys()]) if (/^ccbSys/.test(key)) params.delete(key);
      const hashRoute = url.hash.split('?')[0];
      url.hash = `${hashRoute}${params.size ? `?${params}` : ''}`;
      return url.href;
    } catch { return ''; }
  }

  function sysElementTitle(el) {
    const card = el.closest('li,article,[class*="item" i],[class*="card" i]') || el.parentElement || el;
    const heading = card.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
    let title = textOf(heading) || textOf(el) || textOf(card);
    title = title.split(/\n/).map(norm).find(line => line && !/^(播放|学习|查看|详情|未开始|未完成|进行中|已完成)$/.test(line)) || title;
    return { card, title: title.slice(0, 140) };
  }

  function collectSysChannelCourses() {
    const { mid, name } = sysChannelInfo();
    const found = new Map();
    const sources = [...document.querySelectorAll('a[href],[data-link],[data-url],[data-href]')];
    for (const el of sources) {
      if (!visible(el)) continue;
      const raws = [el.href, el.getAttribute('data-link'), el.getAttribute('data-url'), el.getAttribute('data-href')]
        .filter(Boolean);
      for (const raw of raws) {
        const url = normalizeSysContentUrl(raw);
        const identity = url ? sysItemIdentity(url) : '';
        if (!url || found.has(identity)) continue;
        const { card, title } = sysElementTitle(el);
        if (!title || title.length < 2 || /^(更多|全部|上一页|下一页|返回)$/.test(title)) continue;
        const progress = findProgress(card);
        found.set(identity, {
          section: name, channelId: mid, title, url,
          id: courseDetailId(url) || url,
          progress,
          completed: progress === 100
            || [...card.querySelectorAll('*')].some(node => visible(node) && /^(已完成|已学完)$/.test(textOf(node))),
        });
      }
    }
    return [...found.values()];
  }

  function scanSysChannelPages() {
    const { mid } = sysChannelInfo();
    if (!sysChannelScan || sysChannelScan.mid !== mid) {
      sysChannelScan = { mid, courses: new Map(), pages: new Set(), waitingPage: '', waitingContent: '', waitingAt: 0, done: false };
    }
    const token = getPaginationPageToken();
    const pageCourses = collectSysChannelCourses();
    const content = pageCourses.map(course => course.url).sort().join('|');
    if (sysChannelScan.waitingAt) {
      const changed = (token && token !== sysChannelScan.waitingPage) || content !== sysChannelScan.waitingContent;
      if (!changed && Date.now() - sysChannelScan.waitingAt < 20000) {
        return { state: 'scanning', pages: sysChannelScan.pages.size, courses: [...sysChannelScan.courses.values()] };
      }
      sysChannelScan.waitingAt = 0;
    }
    const fingerprint = `${token}:${content}`;
    if (!sysChannelScan.pages.has(fingerprint)) {
      sysChannelScan.pages.add(fingerprint);
      for (const course of pageCourses) sysChannelScan.courses.set(course.id || course.url, course);
    }
    if (sysChannelScan.done) return { state: 'done', pages: sysChannelScan.pages.size, courses: [...sysChannelScan.courses.values()] };
    const next = findPaginationNext();
    if (next && sysChannelScan.pages.size < 100) {
      sysChannelScan.waitingPage = token;
      sysChannelScan.waitingContent = content;
      sysChannelScan.waitingAt = Date.now();
      next.click();
      return { state: 'scanning', pages: sysChannelScan.pages.size, courses: [...sysChannelScan.courses.values()] };
    }
    sysChannelScan.done = true;
    return { state: 'done', pages: sysChannelScan.pages.size, courses: [...sysChannelScan.courses.values()] };
  }

  function sysQueue() {
    return typeof GM_getValue === 'function' ? GM_getValue(SYS_QUEUE_KEY, null) : null;
  }

  function sysChannelPageUrl(mid) {
    const params = new URLSearchParams({
      sId: '34b0775a-0aea-4d3a-b68f-719b152b027d',
      mid: mid || '2b483b4d-2d27-4f5a-9366-6efe50dfc32f',
      cid: 'd2fd30b0-61ac-400e-9a8f-5786b5607e43',
      themeStyle: '1',
    });
    return `https://u.ccb.com/sys/#/channel/more?${params}`;
  }

  function resumeSysQueue() {
    if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, true);
    setRunning(true);
  }

  function restartSysQueue(queue) {
    const mid = queue?.items?.[0]?.channelId || sysChannelInfo().mid;
    const mode = queue?.mode === 'single' ? 'single' : 'parallel';
    saveSysQueue({ ...queue, active: false, cancelled: true, cancelledAt: Date.now() });
    for (const tab of sysWorkerTabs.values()) {
      try { tab?.close?.(); } catch { /* 忽略 */ }
    }
    sysWorkerTabs.clear();
    if (typeof GM_setValue === 'function') {
      GM_setValue(`${SYS_SELECTION_PREFIX}${mid}`, []);
      GM_setValue(SYS_RESTART_KEY, { mid, mode, requestedAt: Date.now() });
      GM_setValue(RUN_KEY, true);
    }
    sysChannelScan = null;
    setRunning(true);
    location.assign(sysChannelPageUrl(mid));
  }

  function saveSysQueue(queue) {
    if (typeof GM_setValue === 'function') GM_setValue(SYS_QUEUE_KEY, queue);
  }

  function sysWorkerStateKey(queueId, workerId) {
    return `${SYS_WORKER_STATE_PREFIX}${queueId}:${workerId}`;
  }

  function sysWorkerContext() {
    try {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      if (params.has('ccbSysQueue')) {
        const previous = JSON.parse(sessionStorage.getItem(SYS_WORKER_SESSION_KEY) || 'null');
        const context = {
          ...(previous?.queueId === params.get('ccbSysQueue') ? previous : {}),
          queueId: params.get('ccbSysQueue'),
          workerId: params.get('ccbSysWorker') || 'single',
          itemIndex: Number(params.get('ccbSysItem') || 0),
        };
        sessionStorage.setItem(SYS_WORKER_SESSION_KEY, JSON.stringify(context));
        return context;
      }
      return JSON.parse(sessionStorage.getItem(SYS_WORKER_SESSION_KEY) || 'null');
    } catch { return null; }
  }

  function saveSysWorkerContext(context) {
    try { sessionStorage.setItem(SYS_WORKER_SESSION_KEY, JSON.stringify(context)); } catch { /* 忽略 */ }
  }

  function addSysWorkerFlags(url, queueId, workerId, itemIndex) {
    const hashAt = url.indexOf('#');
    const prefix = hashAt < 0 ? url : url.slice(0, hashAt);
    const hash = hashAt < 0 ? '' : url.slice(hashAt + 1);
    const queryAt = hash.indexOf('?');
    const route = queryAt < 0 ? hash : hash.slice(0, queryAt);
    const params = new URLSearchParams(queryAt < 0 ? '' : hash.slice(queryAt + 1));
    params.set('ccbSysQueue', queueId);
    params.set('ccbSysWorker', workerId);
    params.set('ccbSysItem', String(itemIndex));
    return `${prefix}#${route}?${params}`;
  }

  function workerQueueItem(context) {
    const queue = sysQueue();
    if (!queue?.active || queue.id !== context?.queueId) return null;
    const itemIndex = queue.mode === 'single' ? queue.index : context.itemIndex;
    const item = queue.items?.[itemIndex];
    if (!item) return null;
    if (queue.mode === 'parallel' && queue.assignments?.[context.workerId]?.itemIndex !== itemIndex) return null;
    return { queue, item, itemIndex };
  }

  function listenSysWorker(queueId, workerId) {
    const listenerKey = `${queueId}:${workerId}`;
    if (typeof GM_addValueChangeListener !== 'function' || sysWorkerListeners.has(listenerKey)) return;
    const key = sysWorkerStateKey(queueId, workerId);
    const listenerId = GM_addValueChangeListener(key, (_name, _oldValue, value) => {
      if (value?.status === 'done' && value.queueId === queueId) handleSysWorkerDone(queueId, workerId, value);
    });
    sysWorkerListeners.set(listenerKey, listenerId);
  }

  function readCurrentCourseProgress() {
    const portalTotal = portalCourseTotalProgress();
    if (portalTotal !== null) return portalTotal;
    const totalLabel = [...document.querySelectorAll('body *')]
      .filter(el => visible(el) && el.children.length === 0 && /总进度/.test(textOf(el)))
      .map(el => {
        const own = textOf(el).match(/总进度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/);
        const nearby = textOf(el.parentElement).match(/总进度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/);
        return own || nearby;
      })
      .find(Boolean);
    if (totalLabel) return Number(totalLabel[1]);
    const standalone = [...document.querySelectorAll('[role="progressbar"],progress')]
      .filter(el => visible(el) && /总进度/.test(textOf(el.parentElement)));
    if (standalone.length) return findProgress(standalone[0].parentElement);
    return null;
  }

  function isSysWorkerDetailPage(context) {
    if (isCourseDetailPage()) return true;
    if (location.pathname.replace(/\/$/, '') !== '/sys' || isSysChannelMorePage() || isVideoPage()) return false;
    const currentRoute = location.hash.split('?')[0];
    const found = workerQueueItem(context);
    if (!found) return false;
    let assignedRoute = '';
    try { assignedRoute = new URL(found.item.url, location.origin).hash.split('?')[0]; } catch { /* 忽略 */ }
    return currentRoute === assignedRoute || /detail|course|audio|book|video|content/i.test(currentRoute);
  }

  function markSysLessonComplete(context) {
    if (!context?.currentLesson) return;
    const finished = new Set(context.finishedLessons || []);
    finished.add(context.currentLesson);
    saveSysWorkerContext({ ...context, finishedLessons: [...finished], currentLesson: '' });
  }

  function startSysLesson(context, lesson, retry = false) {
    const previousAttempts = context.currentLesson === lesson.title ? Number(context.lessonClickAttempts || 0) : 0;
    const attempts = previousAttempts + 1;
    const nextContext = {
      ...context, currentLesson: lesson.title,
      currentLessonStartedAt: Date.now(), lessonClickAttempts: attempts,
    };
    saveSysWorkerContext(nextContext);
    const playLink = [...lesson.row.querySelectorAll('a[href]')]
      .find(anchor => visible(anchor) && /#\/play\//.test(anchor.href));
    if (playLink) {
      const target = addSysWorkerFlags(playLink.href, context.queueId, context.workerId, context.itemIndex);
      location.assign(target);
      return;
    }
    const controls = [...lesson.row.querySelectorAll('a,button,[role="button"]')].filter(visible);
    const action = controls.find(el => /播放|继续学习|开始学习/.test(textOf(el))
      || /play|video|study/i.test(`${el.className || ''} ${el.getAttribute('aria-label') || ''}`))
      || controls[retry ? controls.length - 1 : 0];
    if (retry) lesson.row.click();
    else if (action) action.click();
    else lesson.row.click();
  }

  function finishSysItem(context, itemIndex) {
    const found = workerQueueItem(context);
    if (!found) return false;
    const { queue, item } = found;
    if (queue.mode === 'single') {
      const nextIndex = itemIndex + 1;
      queue.completedItems = [...new Set([...(queue.completedItems || []), item.url])];
      if (nextIndex >= queue.items.length) {
        saveSysQueue({ ...queue, active: false, completed: true, index: nextIndex, completedAt: Date.now() });
        try { sessionStorage.removeItem(SYS_WORKER_SESSION_KEY); } catch { /* 忽略 */ }
        return true;
      }
      saveSysQueue({ ...queue, index: nextIndex });
      saveSysWorkerContext({
        ...context, itemIndex: nextIndex, currentLesson: '', finishedLessons: [],
        doneSentIndex: null, lessonClickAttempts: 0, currentLessonStartedAt: 0,
      });
      location.assign(addSysWorkerFlags(queue.items[nextIndex].url, queue.id, 'single', nextIndex));
      return true;
    }
    if (context.doneSentIndex === itemIndex) return true;
    saveSysWorkerContext({ ...context, doneSentIndex: itemIndex });
    const key = sysWorkerStateKey(queue.id, context.workerId);
    if (typeof GM_setValue === 'function') GM_setValue(key, {
      queueId: queue.id, workerId: context.workerId, itemIndex,
      itemUrl: item.url, status: 'done', completedAt: Date.now(),
    });
    setTimeout(() => { try { window.close(); } catch { /* manager normally closes this tab */ } }, 15000);
    return true;
  }

  function processSysWorkerDetail(context, status, actions) {
    const found = workerQueueItem(context);
    if (!found) { status.textContent = '该后台课程任务已失效，等待关闭。'; return; }
    const { queue, item, itemIndex } = found;
    const progress = readCurrentCourseProgress();
    if (progress === 100) {
      status.textContent = `“${item.title}”课程总进度为 100%，任务完成，正在关闭此后台并领取下一门…`;
      finishSysItem(context, itemIndex);
      return;
    }
    const finished = new Set(context.finishedLessons || []);
    const lessons = portalCourseLessons().map(lesson => ({
      ...lesson,
      complete: lesson.progress === null ? (lesson.checked || finished.has(lesson.title)) : lesson.progress >= 100,
    }));
    context = { ...context, multiLesson: lessons.length > 1 };
    saveSysWorkerContext(context);
    const nextLesson = lessons.find(lesson => !lesson.complete);
    if (lessons.length) {
      const completed = lessons.filter(lesson => lesson.complete).length;
      status.textContent = `后台课程“${item.title}”：${completed}/${lessons.length} 个课时完成；总进度 ${progress === null ? '未识别' : `${progress}%`}${nextLesson ? `；继续${nextLesson.title}` : ''}。`;
      if (!nextLesson) {
        status.textContent = `“${item.title}”目录共 ${lessons.length} 个课时，均显示完成；课程总进度为 ${progress === null ? '未识别' : `${progress}%`}。必须确认总进度100%才会进入下一门，正在等待平台更新。`;
      }
      if (nextLesson && context.currentLesson === nextLesson.title) {
        const clickAttempts = Number(context.lessonClickAttempts || 0);
        const waitingFor = Date.now() - Number(context.currentLessonStartedAt || Date.now());
        if (waitingFor >= 6000 && clickAttempts < 3) {
          status.textContent = `课时“${nextLesson.title}”点击后没有打开播放器，正在重新尝试（${clickAttempts + 1}/3）…`;
          startSysLesson(context, nextLesson, true);
        } else if (clickAttempts >= 3 && waitingFor >= 6000) {
          status.textContent = `课时“${nextLesson.title}”尝试启动${clickAttempts}次仍未打开播放器；任务保留在本课程，不会跳过。`;
          addButton(actions, `重试播放${nextLesson.title}`, () => startSysLesson({ ...context, lessonClickAttempts: 0 }, nextLesson, true));
        } else {
          status.textContent = `后台课程“${item.title}”：正在加载课时“${nextLesson.title}”，等待播放器打开（${Math.max(0, 6 - Math.floor(waitingFor / 1000))} 秒后重试）。`;
        }
      } else if (nextLesson) startSysLesson(context, nextLesson);
      return;
    }
    const start = document.querySelector('button.to-learn')
      || findAction('继续学习') || findAction('我要学习') || findAction('开始学习') || findAction('播放');
    if (start && visible(start) && context.lastStartKey !== `${location.href}:${textOf(start)}`) {
      status.textContent = `后台单视频课程“${item.title}”：总进度 ${progress === null ? '未识别' : `${progress}%`}；正在启动。`;
      saveSysWorkerContext({ ...context, lastStartKey: `${location.href}:${textOf(start)}` });
      autoClickOnce(start);
    } else {
      status.textContent = `后台课程“${item.title}”：总进度 ${progress === null ? '未识别' : `${progress}%`}；等待课程进度更新。`;
      if (start && visible(start)) addButton(actions, '继续播放课程', () => start.click());
    }
  }

  function startSysQueue(items, mode) {
    if (!items.length || typeof GM_setValue !== 'function') return false;
    const queue = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      active: true, mode, items, index: 0, nextIndex: 0,
      assignments: {}, startedAt: Date.now(), completedItems: [],
    };
    if (mode === 'single') {
      saveSysQueue(queue);
      saveSysWorkerContext({ queueId: queue.id, workerId: 'single', itemIndex: 0, finishedLessons: [] });
      location.href = addSysWorkerFlags(items[0].url, queue.id, 'single', 0);
      return true;
    }
    const workerCount = Math.min(4, items.length);
    for (let i = 0; i < workerCount; i++) queue.assignments[`worker-${i + 1}`] = { itemIndex: i, status: 'working' };
    queue.nextIndex = workerCount;
    saveSysQueue(queue);
    for (let i = 0; i < workerCount; i++) openSysWorker(queue, `worker-${i + 1}`, i);
    return true;
  }

  function openSysWorker(queue, workerId, itemIndex) {
    const key = sysWorkerStateKey(queue.id, workerId);
    listenSysWorker(queue.id, workerId);
    if (typeof GM_setValue === 'function') GM_setValue(key, {
      queueId: queue.id, workerId, itemIndex, itemUrl: queue.items[itemIndex].url,
      status: 'working', startedAt: Date.now(),
    });
    const target = addSysWorkerFlags(queue.items[itemIndex].url, queue.id, workerId, itemIndex);
    try {
      const tab = typeof GM_openInTab === 'function'
        ? GM_openInTab(target, { active: false, insert: true, setParent: true })
        : window.open(target, '_blank');
      if (tab) sysWorkerTabs.set(workerId, tab);
    } catch { /* manager会显示未能打开的工作标签 */ }
  }

  function handleSysWorkerDone(queueId, workerId, value) {
    const queue = sysQueue();
    if (!queue?.active || queue.id !== queueId) return;
    const assignment = queue.assignments?.[workerId];
    if (!assignment || assignment.itemIndex !== value.itemIndex || assignment.status !== 'working') return;
    queue.completedItems = [...new Set([...(queue.completedItems || []), value.itemUrl])];
    try { sysWorkerTabs.get(workerId)?.close?.(); } catch { /* 忽略 */ }
    sysWorkerTabs.delete(workerId);
    if (queue.nextIndex < queue.items.length) {
      const nextIndex = queue.nextIndex;
      queue.assignments[workerId] = { itemIndex: nextIndex, status: 'working' };
      queue.nextIndex++;
      saveSysQueue(queue);
      openSysWorker(queue, workerId, nextIndex);
      return;
    }
    queue.assignments[workerId] = { ...assignment, status: 'done' };
    const allDone = Object.values(queue.assignments).every(worker => worker.status === 'done');
    if (allDone) { queue.active = false; queue.completed = true; queue.completedAt = Date.now(); }
    saveSysQueue(queue);
  }

  function isWorkshopDetailPage() {
    return location.pathname.replace(/\/$/, '') === '/workshop'
      && /^#\/myworkshop\/detail(?:\?.*)?$/.test(location.hash);
  }

  function rememberWorkshopReturnUrl() {
    if (!isWorkshopDetailPage()) return;
    try {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      params.delete('ccbAuto');
      const route = location.hash.split('?')[0];
      const query = params.toString();
      sessionStorage.setItem(WORKSHOP_RETURN_KEY, `${location.origin}${location.pathname}${route}${query ? `?${query}` : ''}`);
    } catch { /* 忽略 */ }
  }
  window.addEventListener('hashchange', rememberWorkshopReturnUrl);

  function getWorkshopCourseId() {
    let source = location.href;
    if (!isWorkshopDetailPage() && isVideoPage()) {
      try { source = sessionStorage.getItem(WORKSHOP_RETURN_KEY) || source; } catch { /* 忽略 */ }
    }
    const query = source.split('#')[1]?.split('?')[1] || '';
    const params = new URLSearchParams(query);
    return params.get('id') || params.get('workshopId') || '';
  }

  function registerCurrentDetailTab(newVideoStarted = false) {
    const courseId = getWorkshopCourseId();
    if (!courseId || (!isWorkshopDetailPage() && !isVideoPage())) return null;
    try {
      const originId = String(performance.timeOrigin || 0);
      let savedId = sessionStorage.getItem(DETAIL_TAB_ID_KEY) || '';
      const savedOrigin = sessionStorage.getItem(DETAIL_TAB_ORIGIN_KEY) || '';
      if (!savedId || savedOrigin !== originId) {
        savedId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        sessionStorage.setItem(DETAIL_TAB_ID_KEY, savedId);
        sessionStorage.setItem(DETAIL_TAB_ORIGIN_KEY, originId);
        detailTabOpenedAt = Date.now();
      }
      if (detailTabId !== savedId || detailTabCourseId !== courseId) {
        detailTabId = savedId;
        detailTabCourseId = courseId;
        detailTabOpenedAt = Date.now();
        detailTabLastWrite = 0;
      }
      if (newVideoStarted) detailTabOpenedAt = Date.now();
      const now = Date.now();
      if (newVideoStarted || now - detailTabLastWrite >= 10000) {
        localStorage.setItem(`${DETAIL_TAB_PREFIX}${detailTabId}`, JSON.stringify({
          tabId: detailTabId, courseId, openedAt: detailTabOpenedAt, lastSeen: now,
        }));
        detailTabLastWrite = now;
      }
      return { tabId: detailTabId, courseId, openedAt: detailTabOpenedAt };
    } catch {
      return null;
    }
  }

  function countCourseDetailTabs(courseId) {
    const tabs = [];
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key?.startsWith(DETAIL_TAB_PREFIX)) continue;
        let record;
        try { record = JSON.parse(localStorage.getItem(key) || 'null'); } catch { record = null; }
        if (!record?.tabId || !record.courseId) continue;
        if (Date.now() - Number(record.lastSeen || 0) > 120000) {
          localStorage.removeItem(key);
          continue;
        }
        if (record.courseId === courseId) tabs.push(record);
      }
    } catch { /* 浏览器禁用站点存储时不做同课程标签清理 */ }
    return tabs;
  }

  function unregisterCurrentDetailTab() {
    if (!detailTabId) return;
    try { localStorage.removeItem(`${DETAIL_TAB_PREFIX}${detailTabId}`); } catch { /* 忽略 */ }
    detailTabId = '';
    detailTabCourseId = '';
    detailTabOpenedAt = 0;
    detailTabLastWrite = 0;
  }

  window.addEventListener('pagehide', unregisterCurrentDetailTab);

  function claimActiveWorkshop(newVideoStarted = false) {
    if (!isRunning || !settings.autoplay || document.visibilityState !== 'visible' || !document.hasFocus()
      || typeof GM_setValue !== 'function') return;
    const currentTab = registerCurrentDetailTab(newVideoStarted);
    if (!currentTab) return;
    const courseTabs = countCourseDetailTabs(currentTab.courseId);
    const closeOlderCourseTabs = courseTabs.length > 3;
    const active = typeof GM_getValue === 'function' ? GM_getValue(ACTIVE_WORKSHOP_KEY, null) : null;
    if (newVideoStarted || active?.courseId !== currentTab.courseId || active?.tabId !== currentTab.tabId
      || !!active?.closeOlderCourseTabs !== closeOlderCourseTabs) {
      GM_setValue(ACTIVE_WORKSHOP_KEY, {
        courseId: currentTab.courseId,
        tabId: currentTab.tabId,
        startedAt: Date.now(),
        closeOlderCourseTabs,
        keepTabId: closeOlderCourseTabs ? currentTab.tabId : '',
      });
    }
  }

  function yieldToActiveWorkshop() {
    if ((!isWorkshopDetailPage() && !isVideoPage()) || !getWorkshopCourseId()) return;
    unregisterCurrentDetailTab();
    try { window.close(); } catch { /* 浏览器可能禁止关闭非脚本创建的标签 */ }
    setTimeout(() => {
      if (window.closed || isClassListPage()) return;
      try { sessionStorage.setItem(SUPPRESSED_TAB_KEY, '1'); } catch { /* 忽略 */ }
      location.assign('https://u.ccb.com/workshop/#/myworkshop');
    }, 400);
  }

  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(ACTIVE_WORKSHOP_KEY, (_name, _oldValue, value) => {
      if (!value?.courseId || isClassListPage()) return;
      const thisCourseId = getWorkshopCourseId();
      if (!thisCourseId) return;
      const thisTab = registerCurrentDetailTab();
      const otherCourse = thisCourseId !== value.courseId;
      const olderTabOfSameCourse = thisCourseId === value.courseId && value.closeOlderCourseTabs
        && thisTab?.tabId !== value.keepTabId;
      if (otherCourse || olderTabOfSameCourse) yieldToActiveWorkshop();
    });
  }

  function findAction(label) {
    return [...document.querySelectorAll('a,button,[role="button"],.edit-block')]
      .find(el => visible(el) && textOf(el).includes(label));
  }

  function nativeAutoplayState() {
    const labels = [...document.querySelectorAll('label,button,[role="switch"],[aria-label],span,div')]
      .filter(el => visible(el) && /自动播放/.test(textOf(el) || el.getAttribute('aria-label') || '')
        && textOf(el).length < 50 && !el.closest('#ccb-helper-panel'))
      .sort((a, b) => textOf(a).length - textOf(b).length);
    for (const label of labels) {
      let scope = label;
      for (let depth = 0; depth < 4 && scope; depth++, scope = scope.parentElement) {
        const controls = [scope, ...scope.querySelectorAll('input[type="checkbox"],[role="switch"],[aria-checked],button,[class*="switch" i]')]
          .filter(control => visible(control));
        for (const control of controls) {
          const checked = control.matches('input[type="checkbox"]') ? control.checked : null;
          const aria = control.getAttribute('aria-checked');
          const classes = String(control.className?.baseVal || control.className || '').toLowerCase();
          const state = checked !== null ? checked
            : aria === 'true' ? true : aria === 'false' ? false
              : /(?:is-checked|checked|switch-on|active|enabled)/.test(classes) ? true
                : /(?:is-unchecked|unchecked|switch-off|disabled)/.test(classes) ? false : null;
          if (state !== null && (/自动播放/.test(textOf(scope) || scope.getAttribute?.('aria-label') || '')
            || /(?:switch|toggle|checkbox)/i.test(`${control.tagName} ${classes} ${control.getAttribute('role') || ''}`))) {
            return { control, enabled: state };
          }
        }
      }
    }
    return null;
  }

  function enableNativeAutoplay() {
    const result = nativeAutoplayState();
    if (!result) return { enabled: null, message: '未识别网页自动播放开关' };
    if (result.enabled) return { enabled: true, message: '网页自动播放已开启' };
    if (attemptedNativeAutoplay.has(result.control)) return { enabled: false, message: '等待网页自动播放开关确认开启' };
    attemptedNativeAutoplay.add(result.control);
    result.control.click();
    const after = nativeAutoplayState();
    return after?.enabled === true
      ? { enabled: true, message: '已开启网页自动播放' }
      : { enabled: after?.enabled ?? null, message: '已尝试开启网页自动播放，等待状态确认' };
  }

  function currentPlaybackKey() {
    const media = visibleVideo();
    return `${location.pathname}${location.hash}|${media?.currentSrc || media?.src || ''}`;
  }

  function formatMediaTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function rewindCompletedLessonTwoSeconds(media, progress) {
    if (!media || progress !== 100 || !Number.isFinite(media.duration) || media.duration <= 0) return false;
    const key = currentPlaybackKey();
    if (lastRewoundPlaybackKey === key) return false;
    try {
      const targetTime = Math.max(0, media.duration - 2);
      if (media.duration <= 2) return false;
      media.currentTime = targetTime;
      lastRewoundPlaybackKey = key;
      if (media.paused || media.ended) {
        const attempt = media.play();
        attempt?.catch?.(() => { /* 页面自动播放策略可能拒绝脚本播放 */ });
      }
      return true;
    } catch { return false; }
  }

  function autoClickOnce(el) {
    const key = `${location.pathname}${location.hash}:${textOf(el)}`;
    if (el && !autoClicked.has(key)) {
      autoClicked.add(key);
      el.click();
    }
  }

  function workshopDetailUrl() {
    try {
      const saved = sessionStorage.getItem(WORKSHOP_RETURN_KEY);
      if (saved) return saved;
    } catch { /* 忽略 */ }
    const hashQuery = location.hash.split('?')[1] || '';
    const params = new URLSearchParams(hashQuery);
    const id = params.get('id') || params.get('workshopId');
    return id ? `https://u.ccb.com/workshop/#/myworkshop/detail?id=${encodeURIComponent(id)}` : null;
  }

  function withAutoChildFlag(url, batchId, workerId) {
    const hashAt = url.indexOf('#');
    if (hashAt < 0) return `${url}#/?ccbAuto=1`;
    const prefix = url.slice(0, hashAt);
    const hash = url.slice(hashAt + 1);
    const qAt = hash.indexOf('?');
    const route = qAt < 0 ? hash : hash.slice(0, qAt);
    const params = new URLSearchParams(qAt < 0 ? '' : hash.slice(qAt + 1));
    params.set('ccbAuto', '1');
    params.set('ccbBatch', batchId);
    params.set('ccbWorker', workerId);
    return `${prefix}#${route}?${params}`;
  }

  function openManagedDetail(url, batchId, workerId) {
    const target = withAutoChildFlag(url, batchId, workerId);
    try {
      if (typeof GM_openInTab === 'function') {
        const tab = GM_openInTab(target, { active: false, insert: true, setParent: true });
        const record = { tab, workerId, doneKey: `${BATCH_DONE_PREFIX}:${batchId}:${workerId}`, closed: false };
        if (tab) tab.onclose = () => { record.closed = true; };
        managedTabs.push(record);
        if (typeof GM_addValueChangeListener === 'function') {
          record.doneListenerId = GM_addValueChangeListener(record.doneKey, (_name, _oldValue, value) => {
            if (value === true && isClassListPage()) scheduleBatchReturn();
          });
        }
        return true;
      }
      const tab = window.open(target, '_blank');
      if (!tab) return false;
      managedTabs.push({ tab, workerId, doneKey: `${BATCH_DONE_PREFIX}:${batchId}:${workerId}`, closed: false });
      return true;
    } catch {
      return false;
    }
  }

  function isManagedTabAlive(record) {
    if (record.closed) return false;
    try { return record.tab?.closed !== true; } catch { return false; }
  }

  function scheduleBatchReturn() {
    if (batchReloadScheduled) return;
    batchReloadScheduled = true;
    const status = panel?.querySelector('.status');
    if (status) status.textContent = '已确认一个专题班内的视频全部完成；5 秒后返回列表重新检索未完成课程…';
    setTimeout(() => {
      if (!isRunning) {
        batchReloadScheduled = false;
        return;
      }
      for (const record of managedTabs) {
        if (!isManagedTabAlive(record)) continue;
        try {
          if (typeof record.tab?.close === 'function') record.tab.close();
          else record.tab?.close?.();
        } catch { /* 忽略 */ }
      }
      location.assign('https://u.ccb.com/workshop/#/myworkshop');
    }, 5000);
  }

  function openDetailBatch(cards) {
    const urls = [];
    for (const card of cards) {
      const link = typeof card === 'string' ? null
        : card.link || (card.el.matches?.('a[href]') ? card.el : card.el.querySelector('a[href*="#/myworkshop/detail"]'));
      const url = typeof card === 'string' ? card : link?.href;
      if (url && !urls.includes(url)) urls.push(url);
    }
    if (!urls.length) return 0;
    batchActive = true;
    batchStartedAt = Date.now();
    // 单标签顺序执行：直接在当前标签打开课程，避免依赖跨标签完成信号。
    location.assign(urls[0]);
    return 1;
  }

  function returnToWorkshopListAfterDelay() {
    if (batchReloadScheduled) return;
    batchReloadScheduled = true;
    setTimeout(() => {
      if (!isRunning) {
        batchReloadScheduled = false;
        return;
      }
      batchActive = false;
      batchReloadScheduled = false;
      managedTabs = [];
      paginationScan = null;
      allDoneSince = 0;
      activeBatchId = '';
      childDoneReported = false;
      childBatchId = '';
      childWorkerId = '';
      autoClicked.clear();
      try { sessionStorage.removeItem(AUTO_CHILD_KEY); } catch { /* 忽略 */ }
      location.assign('https://u.ccb.com/workshop/#/myworkshop');
    }, 5000);
  }

  function reportManagedChildDone() {
    if (childDoneReported || !childBatchId || !childWorkerId || typeof GM_setValue !== 'function') return;
    childDoneReported = true;
    GM_setValue(`${BATCH_DONE_PREFIX}:${childBatchId}:${childWorkerId}`, true);
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
    const recovery = getVideoRecoveryState(video);
    if (video.ended) {
      if (!endedSince) { endedSince = now; return; }
      if (now - endedSince < REPLAY_DELAY) return;
      endedSince = 0;
      try { video.currentTime = 0; } catch { /* 忽略 */ }
      lastPlayAttempt = now;
      try {
        const p = video.play();
        p?.catch?.(error => { recovery.lastError = `重播失败：${error?.name || '播放被拒绝'}`; });
      } catch (error) {
        recovery.lastError = `重播失败：${error?.name || '播放被拒绝'}`;
      }
      return;
    }
    endedSince = 0;
    if (video.paused && !video.error && now >= recovery.nextRetryAt) {
      if (now - lastPlayAttempt < 1000) return;
      lastPlayAttempt = now;
      const retryDelay = Math.min(3000 * (2 ** recovery.retries), 30000);
      recovery.retries += 1;
      recovery.nextRetryAt = now + retryDelay;
      try {
        const p = video.play();
        p?.catch?.(error => { recovery.lastError = `自动恢复失败：${error?.name || '播放被拒绝'}`; });
      } catch (error) {
        recovery.lastError = `自动恢复失败：${error?.name || '播放被拒绝'}`;
      }
    }
  }

  function safePlayVideo(progress, allowPausedRecovery = true) {
    const video = [...document.querySelectorAll('video,audio')].find(visible);
    if (!video) return '尚未检测到 HTML 视频播放器';
    video.muted = !!settings.muted;
    applyPlaybackRate(video);
    if (!video.paused && (progress === null || progress < 100)) claimActiveWorkshop(false);
    const initialStart = video.paused && video.currentTime < 1 && video.played.length === 0;
    if (settings.autoplay && (progress === null || progress < 100) && (allowPausedRecovery || initialStart)) {
      keepVideoPlaying(video);
    }
    const rateNote = Math.abs(video.playbackRate - 1) > 1e-6 ? `，${video.playbackRate}倍速` : '';
    const recovery = getVideoRecoveryState(video);
    const stateNote = video.error
      ? `，${recovery.lastError || '播放器媒体错误，需刷新播放页'}`
      : video.paused
        ? `，已暂停，自动恢复尝试 ${recovery.retries} 次`
        : recovery.waitingSince && Date.now() - recovery.waitingSince > 10000
          ? '，视频正在缓冲，等待播放器恢复'
          : '，播放中';
    return `已应用播放设置（${settings.muted ? '静音' : '有声'}${rateNote}${stateNote}）`;
  }

  const panel = document.createElement('section');
  panel.id = 'ccb-helper-panel';
  panel.innerHTML = `
    <header><strong>学习辅助</strong><span><button data-act="run-toggle" type="button">${isRunning ? '停止执行' : '继续执行'}</button> <button data-act="min" title="最小化/展开">−</button></span></header>
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
      <small class="wake-status" aria-live="polite"></small>
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

  function setRunning(next) {
    isRunning = !!next;
    const toggle = panel.querySelector('[data-act="run-toggle"]');
    const pausedQueue = !isRunning && (!!activePortalQueue() || !!sysQueue()?.active);
    toggle.textContent = isRunning ? '停止执行' : pausedQueue ? '选择恢复方式' : '继续执行';
    toggle.title = isRunning ? '停止所有脚本标签页的自动处理'
      : pausedQueue ? '选择继续上次课程任务或重新选择课程' : '继续所有脚本标签页的自动处理';
    if (!isRunning) {
      multiLessonPauseProbe = { key: '', since: 0 };
      releaseScreenWakeLock();
      const queue = activePortalQueue();
      if (queue?.stalledSince) savePortalQueue({ ...queue, stalledSince: 0 });
      for (const video of document.querySelectorAll('video,audio')) video.pause();
    } else {
      requestScreenWakeLock();
    }
    update();
  }
  panel.querySelector('[data-act="run-toggle"]').addEventListener('click', () => {
    if (!isRunning && (activePortalQueue() || sysQueue()?.active)) { update(); return; }
    const next = !isRunning;
    if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, next);
    setRunning(next);
  });
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(RUN_KEY, (_name, _oldValue, value) => setRunning(value !== false));
  }

  function update() {
    rememberWorkshopReturnUrl();
    rememberCourseDetailReturnUrl();
    registerCurrentDetailTab();
    const status = panel.querySelector('.status');
    const actions = panel.querySelector('.actions');
    actions.replaceChildren();
    if (!isRunning) {
      const queue = activePortalQueue();
      const sysPaused = sysQueue();
      const toggle = panel.querySelector('[data-act="run-toggle"]');
      if (queue) {
        status.textContent = `课程任务已暂停，当前为第 ${queue.index + 1}/${queue.items.length} 门：${queue.items[queue.index]?.title || '课程'}。请选择如何继续。`;
        toggle.textContent = '选择恢复方式';
        toggle.title = '在下方选择继续上次任务或重新选择课程';
        addButton(actions, '继续上次课程任务', () => {
          if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, true);
          setRunning(true);
        });
        addButton(actions, '重新选择课程', () => {
          savePortalQueue({ ...queue, active: false, completed: false, currentLesson: '' });
          if (typeof GM_setValue === 'function') {
            GM_setValue(PORTAL_SELECTION_KEY, []);
            GM_setValue(RUN_KEY, true);
          }
          setRunning(true);
          location.assign('https://u.ccb.com/portal/#/study?microPageId=1565348618942312449');
        });
      } else if (sysPaused?.active) {
        const channelName = sysPaused.items?.[0]?.section || '频道课程';
        status.textContent = `${channelName}任务已停止：已完成 ${sysPaused.completedItems?.length || 0}/${sysPaused.items?.length || 0} 门。可继续上次选中的队列，或重新扫描该频道的未完成课程。`;
        toggle.textContent = '选择继续方式';
        toggle.title = '选择继续上次选择课程任务，或重新检测未完成课程并开启新一轮';
        addButton(actions, '继续上次选择课程任务', resumeSysQueue);
        addButton(actions, '重新检测未完成课程并开启新一轮', () => restartSysQueue(sysPaused));
      } else {
        status.textContent = '脚本已停止；点击“继续执行”恢复。';
        toggle.textContent = '继续执行';
      }
      return;
    }
    const priorSysContext = sysWorkerContext();
    if (priorSysContext?.queueId && !workerQueueItem(priorSysContext)) {
      status.textContent = '此后台课程任务已停止或已重新分配，正在关闭旧工作标签。';
      setTimeout(() => { try { window.close(); } catch { /* 仅关闭脚本创建的后台标签 */ } }, 300);
      return;
    }
    if (isClassListPage()) {
      let suppressed = false;
      try { suppressed = sessionStorage.getItem(SUPPRESSED_TAB_KEY) === '1'; } catch { /* 忽略 */ }
      if (suppressed) {
        status.textContent = '此标签已让位给当前播放课程；需要时可恢复自动学习。';
        addButton(actions, '恢复此标签自动学习', () => {
          try { sessionStorage.removeItem(SUPPRESSED_TAB_KEY); } catch { /* 忽略 */ }
          update();
        });
        return;
      }
    }
    if (isVideoPage()) {
      const p = findProgress();
      const sysContext = sysWorkerContext();
      const sysFound = workerQueueItem(sysContext);
      const portalQueue = portalQueueForCurrentVideo();
      const multiLesson = !!(sysFound && sysContext.multiLesson || portalQueue?.multiLesson);
      const nativeAutoplay = multiLesson ? enableNativeAutoplay() : null;
      const media = visibleVideo();
      const rewoundToEndBuffer = multiLesson && rewindCompletedLessonTwoSeconds(media, p);
      const playResult = safePlayVideo(p, !multiLesson);
      if (multiLesson && p !== 100 && media && settings.autoplay) keepVideoPlaying(media);
      status.textContent = `视频页面：${p === null ? '未识别到进度' : `页面进度 ${p}%`}；${playResult}${nativeAutoplay ? `；${nativeAutoplay.message}` : ''}${rewoundToEndBuffer ? `；已定位到课时结束前2秒（${formatMediaTime(media.duration - 2)}），等待网页自动切换下一课时` : ''}`;
      if (multiLesson) {
        if (media?.paused) {
          const key = currentPlaybackKey();
          if (multiLessonPauseProbe.key !== key) multiLessonPauseProbe = { key, since: Date.now() };
          const pausedFor = Date.now() - multiLessonPauseProbe.since;
          if (pausedFor >= 30000) {
            if (sysFound) {
              if (p === 100) markSysLessonComplete(sysContext);
              else saveSysWorkerContext({ ...sysContext, currentLesson: '' });
            } else if (portalQueue) {
              if (p === 100) markPortalLessonComplete(portalQueue);
              else savePortalQueue({ ...portalQueue, currentLesson: '' });
            }
            const target = sysFound
              ? addSysWorkerFlags(sysFound.item.url, sysFound.queue.id, sysContext.workerId, sysFound.itemIndex)
              : courseDetailReturnUrl() || portalQueue?.items?.[portalQueue.index]?.url;
            status.textContent = `同一课时在播放页暂停超过30秒（当前进度 ${p === null ? '未识别' : `${p}%`}）；返回课程详情核对总进度和剩余课时。`;
            multiLessonPauseProbe = { key: '', since: 0 };
            if (target) autoNavigateOnce(`multi-course-paused:${key}`, target);
          } else {
            status.textContent = `网页自动播放已开启；当前课时未切换且播放器已暂停，等待30秒确认（${Math.ceil((30000 - pausedFor) / 1000)} 秒）。`;
          }
          return;
        }
        multiLessonPauseProbe = { key: '', since: 0 };
        status.textContent = `多课时课程留在播放页，由网页自动播放切换课时；${nativeAutoplay?.message || '正在监测播放器状态'}。`;
        return;
      }
      if (p === 100) {
        if (sysFound) {
          markSysLessonComplete(sysContext);
          const target = addSysWorkerFlags(sysFound.item.url, sysFound.queue.id, sysContext.workerId, sysFound.itemIndex);
          status.textContent = '当前视频完成，返回本后台对应课程目录核对剩余课时…';
          autoNavigateOnce(`sys-course:${sysFound.queue.id}:${sysFound.itemIndex}:${location.hash}`, target);
        } else if (portalQueue) {
          markPortalLessonComplete(portalQueue);
          const target = courseDetailReturnUrl() || portalQueue.items[portalQueue.index]?.url;
          status.textContent = '当前课时已完成，正在返回课程目录核对并开始下一课时…';
          if (target) autoNavigateOnce(`portal-course:${portalQueue.index}:${location.hash}`, target);
        } else if (hasWorkshopTaskReturn()) {
          status.textContent = '当前视频已完成，正在返回“我的专题班”重新检索未完成课程…';
          returnToWorkshopListAfterDelay();
        } else {
          const target = courseDetailReturnUrl();
          if (target) {
            status.textContent = '当前视频已完成，正在返回上一级课程详情检查未完成课时…';
            autoNavigateOnce(`course-detail:${location.hash}`, target);
          } else {
            status.textContent += '。该视频已完成；返回上一级检查课程进度。';
            addButton(actions, '返回上一级检查课程', () => history.back());
          }
        }
      } else if (portalQueue) {
        const stalledFor = portalStallDuration(portalQueue);
        if (stalledFor >= 15000) {
          if (portalQueue.multiLesson) {
            const target = courseDetailReturnUrl() || portalQueue.items[portalQueue.index]?.url;
            savePortalQueue({ ...portalQueue, stalledSince: 0 });
            status.textContent = '多课时课程的视频 15 秒未播放，返回目录重新核对当前课时；不会跳过整门课程。';
            if (target) location.assign(target);
          } else {
            skipStalledPortalCourse(queue, status);
          }
        } else {
          status.textContent += `；未检测到正在播放的视频，等待恢复中（${Math.floor(stalledFor / 1000)}/15 秒）`;
        }
      } else if (settings.autoplay) {
        status.textContent += '；进度未满 100%，已保持自动播放。';
      }
      return;
    }
    const sysContext = sysWorkerContext();
    const sysFound = workerQueueItem(sysContext);
    if (sysFound && isSysWorkerDetailPage(sysContext)) {
      processSysWorkerDetail(sysContext, status, actions);
      return;
    }
    if (isSysChannelMorePage()) {
      const queue = sysQueue();
      if (queue?.active && queue.mode === 'parallel') {
        for (const [workerId, assignment] of Object.entries(queue.assignments || {})) {
          if (assignment.status === 'working') listenSysWorker(queue.id, workerId);
        }
        const running = Object.values(queue.assignments || {}).filter(worker => worker.status === 'working').length;
        status.textContent = `四窗口任务进行中：已完成 ${queue.completedItems?.length || 0}/${queue.items.length} 门；当前 ${running} 个后台课程标签，待领取 ${Math.max(0, queue.items.length - queue.nextIndex)} 门。`;
        addButton(actions, '停止执行', () => {
          if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, false);
          setRunning(false);
        });
        return;
      }
      const scan = scanSysChannelPages();
      const { mid, name } = sysChannelInfo();
      const selectionKey = `${SYS_SELECTION_PREFIX}${mid}`;
      const selected = new Set(typeof GM_getValue === 'function' ? GM_getValue(selectionKey, []) : []);
      const available = scan.courses.filter(course => !portalCourseIsComplete(course));
      status.textContent = scan.state === 'scanning'
        ? `正在扫描“${name}”：已检查 ${scan.pages} 页，读取到 ${scan.courses.length} 门课程…`
        : `“${name}”扫描完成：共检查 ${scan.pages} 页，读取到 ${scan.courses.length} 门课程；勾选后选择执行方式。`;
      if (scan.state === 'scanning') return;
      const restart = typeof GM_getValue === 'function' ? GM_getValue(SYS_RESTART_KEY, null) : null;
      if (restart?.mid === mid) {
        GM_setValue(SYS_RESTART_KEY, null);
        GM_setValue(selectionKey, available.map(course => course.url));
        if (!available.length) {
          status.textContent = `重新检测完成：“${name}”频道当前没有未完成课程。`;
        } else {
          status.textContent = `重新检测到 ${available.length} 门未完成课程，按上次的${restart.mode === 'single' ? '单窗口' : '四窗口'}模式开始新一轮。`;
          startSysQueue(available, restart.mode === 'single' ? 'single' : 'parallel');
        }
        return;
      }
      for (const course of scan.courses) {
        const row = document.createElement('label'); row.className = 'course';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        const completed = portalCourseIsComplete(course);
        checkbox.checked = selected.has(course.url) && !completed;
        checkbox.disabled = completed;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.add(course.url); else selected.delete(course.url);
          GM_setValue(selectionKey, [...selected]);
        });
        const title = document.createElement('span');
        title.textContent = `${course.title} · ${completed ? '已完成' : course.progress === null ? '进度未识别' : `总进度 ${course.progress}%`}`;
        row.append(checkbox, title); actions.append(row);
      }
      const selectAll = document.createElement('button'); selectAll.textContent = '全选未完成课程';
      selectAll.addEventListener('click', () => {
        for (const course of available) selected.add(course.url);
        GM_setValue(selectionKey, [...selected]); update();
      });
      const clearSelection = document.createElement('button'); clearSelection.textContent = '清空选择';
      clearSelection.addEventListener('click', () => { GM_setValue(selectionKey, []); update(); });
      actions.prepend(selectAll, clearSelection);
      const chosen = scan.courses.filter(course => selected.has(course.url) && !portalCourseIsComplete(course));
      for (const [label, mode] of [['开始单个执行选中视频', 'single'], ['开始4个窗口分别执行选中视频', 'parallel']]) {
        const button = document.createElement('button'); button.textContent = label; button.disabled = chosen.length === 0;
        button.addEventListener('click', () => {
          if (!startSysQueue(chosen, mode)) status.textContent = '无法创建课程队列，请确认脚本管理器已启用 GM 存储权限。';
          else if (mode === 'parallel') update();
        });
        actions.append(button);
      }
      return;
    }
    if (isPortalStudyPage()) {
      const sections = portalCourseSections();
      const queued = activePortalQueue();
      if (queued) {
        const item = queued.items[queued.index];
        status.textContent = `已选择 ${queued.items.length} 门课程；正在进入第 ${queued.index + 1} 门：${item.title}`;
        if (settings.autoOpen) location.href = item.url;
        else addButton(actions, '进入当前课程', () => { location.href = item.url; });
        return;
      }
      status.textContent = sections.length
        ? `读取到 ${sections.reduce((n, s) => n + s.courses.length, 0)} 门视频课程；勾选课程后点击“开始执行选中课程”。`
        : '正在读取“党的理论教育”“党性教育”“履职能力”中的课程…';
      const selected = new Set(typeof GM_getValue === 'function' ? GM_getValue(PORTAL_SELECTION_KEY, []) : []);
      for (const section of sections) {
        const heading = document.createElement('div');
        heading.className = 'course';
        const label = document.createElement('strong'); label.textContent = section.name;
        const all = document.createElement('button'); all.textContent = '全选';
        all.addEventListener('click', () => {
          for (const course of section.courses) selected.add(course.url);
          GM_setValue(PORTAL_SELECTION_KEY, [...selected]); update();
        });
        const none = document.createElement('button'); none.textContent = '全不选';
        none.addEventListener('click', () => {
          for (const course of section.courses) selected.delete(course.url);
          GM_setValue(PORTAL_SELECTION_KEY, [...selected]); update();
        });
        heading.append(label, all, none); actions.append(heading);
        for (const course of section.courses) {
          const row = document.createElement('label'); row.className = 'course';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
          const completed = portalCourseIsComplete(course);
          checkbox.checked = selected.has(course.url) && !completed;
          checkbox.disabled = completed;
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.add(course.url); else selected.delete(course.url);
            GM_setValue(PORTAL_SELECTION_KEY, [...selected]);
          });
          const title = document.createElement('span');
          const progressLabel = completed ? (course.progress === 100 ? '已完成 100%' : '已完成') : course.progress === null
            ? '总进度未显示' : `总进度 ${course.progress}%`;
          title.textContent = `${course.title} · ${progressLabel}`;
          row.append(checkbox, title); actions.append(row);
        }
      }
      const start = document.createElement('button'); start.textContent = '开始执行选中课程';
      start.disabled = !sections.some(section => section.courses.some(course => selected.has(course.url) && !portalCourseIsComplete(course)));
      start.addEventListener('click', () => {
        const items = sections.flatMap(section => section.courses).filter(course => selected.has(course.url) && !portalCourseIsComplete(course));
        if (!items.length) {
          status.textContent = '勾选的课程均已完成或总进度显示 100%，没有需要处理的课程。';
          return;
        }
        try { sessionStorage.removeItem(WORKSHOP_RETURN_KEY); } catch { /* 忽略 */ }
        savePortalQueue({ active: true, items, index: 0, startedAt: Date.now() });
        if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, true);
        setRunning(true);
        location.href = items[0].url;
      });
      actions.append(start);
      return;
    }
    const cards = getCourseCards();
    if (cards.length || isClassListPage()) {
      if (isClassListPage() && batchActive) {
        const anyFinished = managedTabs.some(record =>
          typeof GM_getValue === 'function' && GM_getValue(record.doneKey, false) === true);
        if (anyFinished && Date.now() - batchStartedAt > 1500) {
          scheduleBatchReturn();
          return;
        }
      }
      status.textContent = cards.length
        ? `当前页识别到 ${cards.length} 个未完成专题班${settings.autoOpen ? '；将逐个完成，每次只打开 1 个详情页。' : '；可在下方选择进入。'}`
        : '已在“我的专题班”页面；正在检查课程列表…';
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
      if (settings.autoOpen && !batchActive) {
        const scan = scanAllListPages();
        if (scan.state === 'scanning') {
          status.textContent = `正在检查列表分页…已检查 ${scan.pages} 页，已收集 ${paginationScan.urls.size} 门未完成课程。`;
        } else if (!scan.urls.length) {
          status.textContent = `已检查 ${scan.pages} 页；没有找到“未开始”“未完成”或“进行中”的课程。`;
        } else {
          const opened = openDetailBatch(scan.urls);
          status.textContent = opened
            ? `已扫描 ${scan.pages} 页，找到 ${scan.urls.length} 门未完成课程；当前仅打开 1 个详情页。该课程完成后会返回列表并处理下一门。`
            : `已扫描 ${scan.pages} 页，找到 ${scan.urls.length} 门未完成课程，但浏览器未允许新建标签页。`;
          if (!opened) addButton(actions, '打开下一个未完成课程', () => {
            const count = openDetailBatch(scan.urls);
            status.textContent = count ? '已打开 1 个详情页；完成后会处理下一门。' : '浏览器仍未允许新建标签页。';
          });
        }
      } else if (settings.autoOpen && batchActive) {
        const doneCount = managedTabs.filter(record =>
          typeof GM_getValue === 'function' && GM_getValue(record.doneKey, false) === true).length;
        status.textContent += ` 当前批次 ${doneCount}/${managedTabs.length} 个详情页已完成。`;
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
      const allDone = parsed.length > 0 && parsed.every(item => item.progress === 100);
      if (!allDone) allDoneSince = 0;
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
      else if (settings.autoOpen && allDone) {
        if (!allDoneSince) allDoneSince = Date.now();
        const stableFor = Date.now() - allDoneSince;
        const pageSettled = Date.now() - pageLoadTime >= 10000;
        if (!pageSettled || stableFor < 10000) {
          status.textContent = '表格暂时显示全部完成，正在等待页面加载稳定后再次核对…';
        } else if (isManagedChild()) {
          reportManagedChildDone();
          status.textContent = '本专题班已确认全部视频完成；5 秒后返回列表重新检索。';
          returnToWorkshopListAfterDelay();
        } else {
          status.textContent = '专题班内课程均显示 100%；5 秒后返回列表重新检索下一门。';
          returnToWorkshopListAfterDelay();
        }
      }
      return;
    }
    if (isCourseDetailPage()) {
      const savedQueue = portalQueue();
      if (savedQueue?.completed && savedQueue.items?.[savedQueue.items.length - 1]?.id === courseDetailId()) {
        status.textContent = '已选课程队列全部完成。';
        return;
      }
      let queue = activePortalQueue();
      if (queue) {
        const item = queue.items[queue.index];
        if (courseDetailId() !== item.id) {
          status.textContent = `课程队列正在处理“${item.title}”；正在打开该课程详情。`;
          if (settings.autoOpen) location.href = item.url;
          return;
        }
        const finished = new Set(queue.finishedLessons?.[item.id] || []);
        const rawLessons = portalCourseLessons();
        if (rawLessons.length && !queue.multiLesson) {
          queue = { ...queue, multiLesson: true, stalledSince: 0 };
          savePortalQueue(queue);
        } else if (!rawLessons.length && queue.multiLesson) {
          queue = { ...queue, multiLesson: false, stalledSince: 0 };
          savePortalQueue(queue);
        }
      if (rawLessons.length && portalCourseTotalProgress() === 100) {
        const next = advancePortalQueue(queue);
        if (next) {
          status.textContent = `课程“${item.title}”总进度已达100%；正在进入下一门“${next.title}”。`;
          location.href = next.url;
        } else {
          status.textContent = `课程“${item.title}”总进度已达100%；已选课程全部完成。`;
        }
        return;
      }
        const lessons = rawLessons.map(lesson => ({
          ...lesson,
          complete: lesson.checked || finished.has(lesson.title),
        }));
        if (!lessons.length) {
          const totalProgress = portalCourseTotalProgress();
          if (totalProgress === 100) {
            const next = advancePortalQueue(queue);
            if (next) {
              status.textContent = `单视频课程“${item.title}”总进度为 100%，已完成；正在进入下一门“${next.title}”。`;
              location.href = next.url;
            } else {
              savePortalQueue({ ...queue, active: false, completed: true, index: queue.index + 1 });
              status.textContent = `单视频课程“${item.title}”总进度为 100%；已选课程全部完成。`;
            }
            return;
          }
          const start = document.querySelector('button.to-learn')
            || findAction('继续学习') || findAction('我要学习') || findAction('开始学习');
          const stalledFor = portalStallDuration(queue);
          if (stalledFor >= 15000) {
            skipStalledPortalCourse(queue, status);
          } else if (start && visible(start)) {
            status.textContent = `单视频课程“${item.title}”：总进度 ${totalProgress === null ? '暂不可读' : `${totalProgress}%`}；正在启动视频。`;
            autoClickOnce(start);
          } else {
            status.textContent = `单视频课程“${item.title}”：总进度 ${totalProgress === null ? '暂不可读' : `${totalProgress}%`}；未检测到课时目录或播放入口，等待最多 15 秒后继续队列（${Math.floor(stalledFor / 1000)}/15 秒）。`;
          }
          return;
        }
        const allLessonRowsComplete = lessons.length > 0 && lessons.every(lesson => lesson.complete);
        const totalProgress = portalCourseTotalProgress();
        const allDone = allLessonRowsComplete && totalProgress === 100;
        const nextLesson = lessons.find(lesson => !lesson.locked && !lesson.complete);
        const checkedCount = lessons.filter(lesson => lesson.complete).length;
        status.textContent = `课程“${item.title}”：目录识别到 ${lessons.length} 个课时，${checkedCount} 个已确认完成${nextLesson ? `；准备学习${nextLesson.title}` : ''}。`;
        if (allLessonRowsComplete && totalProgress !== 100) {
          portalCourseDoneSince = 0;
          status.textContent = `课程“${item.title}”的 ${lessons.length} 个课时均显示完成，但总进度为 ${totalProgress === null ? '未识别' : `${totalProgress}%`}；只有总进度达到100%才切换课程，正在等待平台更新。`;
          return;
        }
        if (allDone) {
          if (!portalCourseDoneSince) portalCourseDoneSince = Date.now();
          const remain = Math.max(0, 5000 - (Date.now() - portalCourseDoneSince));
          status.textContent = `课程“${item.title}”目录中的全部课时均已出现完成勾号；${Math.ceil(remain / 1000)} 秒后切换到下一门。`;
          if (!remain) {
            portalCourseDoneSince = 0;
            const next = advancePortalQueue(queue);
            if (!next) {
              status.textContent = '已选课程全部完成。';
            } else {
              location.href = next.url;
            }
          }
        } else {
          portalCourseDoneSince = 0;
          const stalledFor = portalStallDuration(queue);
          if (stalledFor >= 15000) {
            savePortalQueue({ ...queue, stalledSince: 0 });
            if (nextLesson) {
              const clickKey = `${location.pathname}${location.hash}:${nextLesson.title}`;
              autoClicked.delete(clickKey);
              status.textContent = `“${item.title}”仍有未完成课时；15 秒未播放，正在重试${nextLesson.title}，不会跳过整门课程。`;
              startPortalLesson(queue, nextLesson);
            } else {
              status.textContent = `“${item.title}”仍有 ${lessons.length - checkedCount} 个课时未确认完成，但暂时没有可播放课时；继续等待平台解锁，不跳过课程。`;
            }
            return;
          }
          if (nextLesson) {
            addButton(actions, `学习${nextLesson.title}`, () => {
              startPortalLesson(queue, nextLesson);
            });
            if (settings.autoOpen) {
              const clickKey = `${location.pathname}${location.hash}:${nextLesson.title}`;
              if (!autoClicked.has(clickKey)) {
                autoClicked.add(clickKey);
                startPortalLesson(queue, nextLesson);
              }
            }
          } else {
            status.textContent += `；当前没有可学习的未完成课时，等待平台更新（${Math.floor(stalledFor / 1000)}/15 秒）。`;
          }
        }
        return;
      }
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
  requestScreenWakeLock();
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; update(); }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(update, 5000);
})();
