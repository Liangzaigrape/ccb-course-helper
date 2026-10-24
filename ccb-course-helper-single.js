// ==UserScript==
// @name         建行专题班学习辅助-单线程版
// @namespace    local.ccb.course-helper
// @version      1.6.9
// @description  扫描全部分页并逐个学习；清理其他课程及同课程中过多的旧详情页。
// @match        https://u.ccb.com/workshop/*
// @match        https://u.ccb.com/course/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
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

  const visibleVideo = () => [...document.querySelectorAll('video')].find(visible);
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
    return /^#\/play\/[^?]+/.test(location.hash) || !!document.querySelector('.player_area video');
  }

  function isCourseDetailPage() {
    return location.pathname.replace(/\/$/, '') === '/course' && /^#\/detail\/[^?]+/.test(location.hash);
  }

  function isClassListPage() {
    return /^#\/myworkshop(?:\?.*)?$/.test(location.hash);
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

  function safePlayVideo(progress) {
    const video = [...document.querySelectorAll('video')].find(visible);
    if (!video) return '尚未检测到 HTML 视频播放器';
    video.muted = !!settings.muted;
    applyPlaybackRate(video);
    if (!video.paused && (progress === null || progress < 100)) claimActiveWorkshop(false);
    if (settings.autoplay && (progress === null || progress < 100)) {
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
    toggle.textContent = isRunning ? '停止执行' : '继续执行';
    toggle.title = isRunning ? '停止所有脚本标签页的自动处理' : '继续所有脚本标签页的自动处理';
    if (!isRunning) {
      releaseScreenWakeLock();
      for (const video of document.querySelectorAll('video')) video.pause();
    } else {
      requestScreenWakeLock();
    }
    update();
  }
  panel.querySelector('[data-act="run-toggle"]').addEventListener('click', () => {
    const next = !isRunning;
    if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, next);
    setRunning(next);
  });
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(RUN_KEY, (_name, _oldValue, value) => setRunning(value !== false));
  }

  function update() {
    rememberWorkshopReturnUrl();
    registerCurrentDetailTab();
    const status = panel.querySelector('.status');
    const actions = panel.querySelector('.actions');
    actions.replaceChildren();
    if (!isRunning) {
      status.textContent = '脚本已停止；点击“继续执行”恢复。';
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
