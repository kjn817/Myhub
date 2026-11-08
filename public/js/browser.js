/* MyHub 브라우저 — Safari 미니멀 셸 (D-20 최종).
 *
 * 재구성 근거: 가운데 둥근 알약 주소창(높이 36px·너비는 창 폭의 50%,
 * 220~640px), 탭 스트립은 창 바 안으로 (파비콘+제목+닫기, 좁으면 오버플로),
 * 시작 동작은 '브라우저 시작' 버튼 하나로 단일화. 시작 페이지: 안내 카드 +
 * 즐겨찾기 타일 6개(콘텐츠 폭 768px·타일 64px), 최근 방문 저장
 * 'myhub.browser.recents.v1'. 세션 중에는 하단 알약 오버레이(남은 시간+종료).
 * browser-live.js가 없으면 fail-fast로 멈춘다 (반쪽 동작 금지).
 */
(function () {
  'use strict';

  function resolveLiveFactory() {
    return (window.MyHubBrowserLive && window.MyHubBrowserLive.createLive) || null;
  }

  var createLive = resolveLiveFactory();
  if (!createLive) {
    throw new Error('MyHubBrowserLive가 없어 브라우저를 시작할 수 없어요. (browser-live.js 로드 실패)');
  }

  var RECENTS_KEY = 'myhub.browser.recents.v1';
  var MAX_RECENTS = 8;

  var FAVORITES = [
    { name: 'NAVER', url: 'https://www.naver.com', color: '#03c75a' },
    { name: 'Google', url: 'https://www.google.com', color: '#4285f4' },
    { name: 'YouTube', url: 'https://www.youtube.com', color: '#ff0033' },
    { name: 'ChatGPT', url: 'https://chatgpt.com', color: '#10a37f' },
    { name: 'GitHub', word: 'Git', url: 'https://github.com', color: '#24292f' },
    { name: '위키백과', url: 'https://ko.wikipedia.org', color: '#3366cc' },
  ];

  var tabs = []; // {id, url, title}
  var activeTabId = null;
  var tabSeq = 0;
  var live = null;
  var els = {};

  function $(id) { return document.getElementById(id); }

  function loadRecents() {
    try {
      var raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(function (r) { return r && r.url; }).slice(0, MAX_RECENTS) : [];
    } catch (e) { return []; }
  }

  function pushRecent(entry) {
    var recents = loadRecents().filter(function (r) { return r.url !== entry.url; });
    recents.unshift({ url: entry.url, title: entry.title || entry.url, at: new Date().toISOString() });
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS))); }
    catch (e) { console.debug('최근 방문 저장 실패:', e); }
    renderRecents();
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return url; }
  }

  /* ---------- 탭 ---------- */

  function newTab(url) {
    var tab = { id: ++tabSeq, url: url || '', title: url ? hostOf(url) : '시작 페이지' };
    tabs.push(tab);
    activeTabId = tab.id;
    renderTabs();
    return tab;
  }

  function activeTab() {
    return tabs.filter(function (t) { return t.id === activeTabId; })[0] || null;
  }

  function closeTab(id) {
    var idx = tabs.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var wasActive = tabs[idx].id === activeTabId;
    tabs.splice(idx, 1);
    if (!tabs.length) { newTab(''); }
    else if (wasActive) {
      activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
      var t = activeTab();
      if (t && t.url) startSession(t.url);
      else showStart();
    }
    renderTabs();
  }

  function renderTabs() {
    els.tabStrip.innerHTML = '';
    tabs.forEach(function (tab) {
      var el = document.createElement('div');
      el.className = 'browser-tab' + (tab.id === activeTabId ? ' is-active' : '');
      var fav = document.createElement('img');
      fav.className = 'browser-tab-fav';
      fav.alt = '';
      fav.src = tab.url ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(hostOf(tab.url)) + '&sz=32' : '';
      fav.addEventListener('error', function () { fav.style.visibility = 'hidden'; });
      var title = document.createElement('span');
      title.className = 'browser-tab-title';
      title.textContent = tab.title;
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'browser-tab-close';
      close.setAttribute('aria-label', '탭 닫기');
      close.innerHTML = '<i data-lucide="x"></i>';
      close.addEventListener('click', function (ev) { ev.stopPropagation(); closeTab(tab.id); });
      el.appendChild(fav);
      el.appendChild(title);
      el.appendChild(close);
      el.addEventListener('click', function () {
        if (activeTabId === tab.id) return;
        activeTabId = tab.id;
        renderTabs();
        if (tab.url) startSession(tab.url);
        else showStart();
      });
      els.tabStrip.appendChild(el);
    });
    if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('탭 아이콘 실패:', e); } }
  }

  /* ---------- 시작 페이지 ---------- */

  function showStart() {
    els.start.style.display = '';
    els.frame.style.display = 'none';
    els.pill.style.display = 'none';
    els.address.value = '';
    renderRecents();
  }

  function renderRecents() {
    if (!els.recents) return;
    var recents = loadRecents();
    els.recents.innerHTML = '';
    if (!recents.length) {
      els.recents.innerHTML = '<div class="browser-recents-empty">아직 방문 기록이 없어요.</div>';
      return;
    }
    recents.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'browser-recent';
      b.innerHTML = '<span class="browser-recent-title"></span><span class="browser-recent-url"></span>';
      b.querySelector('.browser-recent-title').textContent = r.title || r.url;
      b.querySelector('.browser-recent-url').textContent = r.url;
      b.addEventListener('click', function () { go(r.url); });
      els.recents.appendChild(b);
    });
  }

  function renderFavorites() {
    els.favs.innerHTML = '';
    FAVORITES.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'browser-fav';
      var tile = document.createElement('span');
      tile.className = 'browser-fav-tile';
      tile.style.background = f.color;
      tile.textContent = f.word || f.name.charAt(0);
      var label = document.createElement('span');
      label.className = 'browser-fav-name';
      label.textContent = f.name;
      b.appendChild(tile);
      b.appendChild(label);
      b.addEventListener('click', function () { go(f.url); });
      els.favs.appendChild(b);
    });
  }

  /* ---------- 세션 ---------- */

  function fmtRemain(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function onLiveState(state, detail) {
    if (state === 'live') {
      els.start.style.display = 'none';
      els.frame.style.display = '';
      els.pill.style.display = '';
      els.pillTime.textContent = fmtRemain(detail.remainSec || 0);
      els.startBtn.disabled = false;
    } else if (state === 'starting') {
      els.startBtn.disabled = true;
      els.startBtn.textContent = '연결 중…';
    } else if (state === 'ended') {
      els.pill.style.display = 'none';
      els.frame.style.display = 'none';
      els.start.style.display = '';
      els.notice.textContent = '세션이 끝났어요. (1회 2분) 다시 시작할 수 있어요.';
      els.startBtn.disabled = false;
      els.startBtn.textContent = '브라우저 시작';
      renderRecents();
    } else if (state === 'error') {
      els.startBtn.disabled = false;
      els.startBtn.textContent = '브라우저 시작';
      els.notice.textContent = detail.message || '연결에 실패했어요.';
    } else if (state === 'idle') {
      els.startBtn.disabled = false;
      els.startBtn.textContent = '브라우저 시작';
    }
  }

  function startSession(url) {
    els.notice.textContent = '';
    return live.start(url).then(function (ok) {
      if (ok) {
        var tab = activeTab();
        if (tab) {
          tab.url = url;
          tab.title = hostOf(url);
          renderTabs();
        }
        els.address.value = url;
        pushRecent({ url: url, title: hostOf(url) });
      }
      return ok;
    });
  }

  function go(rawUrl) {
    var checked = window.MyHubBrowserLive.validateUrl(rawUrl);
    if (checked.error) {
      els.notice.textContent = checked.error;
      return;
    }
    var tab = activeTab();
    if (!tab) tab = newTab(checked.url);
    startSession(checked.url);
  }

  /* ---------- 초기화 ---------- */

  function init() {
    els = {
      tabStrip: $('browserTabs'),
      address: $('browserAddress'),
      startBtn: $('browserStartBtn'),
      start: $('browserStart'),
      favs: $('browserFavs'),
      recents: $('browserRecents'),
      frame: $('browserFrame'),
      pill: $('browserPill'),
      pillTime: $('browserPillTime'),
      pillEnd: $('browserPillEnd'),
      notice: $('browserNotice'),
      newTabBtn: $('browserNewTab'),
    };
    live = createLive({ frame: els.frame, onState: onLiveState });

    newTab('');
    renderFavorites();
    renderRecents();

    els.startBtn.addEventListener('click', function () {
      var url = els.address.value.trim();
      if (url) go(url);
      else {
        els.address.focus();
        els.notice.textContent = '열 주소를 입력한 뒤 시작하세요.';
      }
    });
    els.address.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (els.address.value.trim()) go(els.address.value);
      }
    });
    els.newTabBtn.addEventListener('click', function () {
      newTab('');
      showStart();
      els.address.focus();
    });
    els.pillEnd.addEventListener('click', function () {
      live.stop();
      showStart();
    });

    if (window.MyHubBridge) {
      window.MyHubBridge.setContextProvider(function () {
        var tab = activeTab();
        return { app: 'browser', url: tab ? tab.url : '', live: live.state() };
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
