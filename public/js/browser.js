/* MyHub 브라우저 (browser.js) — Safari처럼 미니멀한 원격 브라우저 화면
 *
 * 브라우저 앱은 실제 원격 브라우저(Oracle 상시 기동 서버, Selkies 화면)
 * 하나로 통일한다 (프록시·리더는 2026-11-04 사용자 지시로 폐지,
 * Browser Run 세션 발급은 2026-11-14 설계 변경으로 폐기). 이 파일은 호스트만
 * 맞는다: 탭 스트립 + 가운데 둥근 주소창(주소/검색 겸용), 시작 페이지
 * (안내 카드 + 즐겨찾기 타일 + 최근 방문), 원격 뷰 상태에 따른 접기 전환.
 * 원격 뷰 상태 기계 본체는 browser-live.js(window.MyHubBrowserLive.
 * createLive)가 이 browser.html과 그 파일을 이 파일보다 먼저 불러오며,
 * 합쳐지지 않으면 createApp이 실패한다(조용히 무력화 금지).
 * 주소·검색을 고르면 원격 뷰를 켜고 영구 탭을 그 주소로 이동시킨다.
 * 뷰가 켜져 있을 때 주소창에 새 주소를 넣으면 이동만 지시한다
 * (iframe을 껐다 켜지 않는다).
 * 탭 (트랙 H 귀속, Safari식): 탭의 기록 단위는 주소·방문 기록이다.
 * 원격 뷰는 한 번에 한 탭에만 보이므로 정확히 하나의 탭이 소유하고
 * (liveTabId), 다른 탭에서는 라이브 화면 대신 "다른 탭에서 실행 중"
 * 안내를 보여준다 — 소유하지 않은 탭이 실행 중인 것처럼 보이지 않게
 * 한다. 뒤로/앞으로는 탭의 방문 기록을 따른다. 원격 화면 안에서의
 * 이동은 라이브 화면 자체가 처리한다.
 * 탭 표면 (2026-11-06, image-147): 탭 행이 아닌 창 바(타이틀바)에
 * 두는 탭 상태는 myhub:browser-tabs 채널로 부모에 게시하고
 * (win-actions·finder-toolbar와 같은 계약: 게시 → 클릭 → 동작 전임),
 * 탭을 클릭하면 탭 행(#bwTabstrip)에 둔다. 단독 실행에서는 게시할
 * 부모가 없으므로 탭 행을 페이지 안에 둔다. 주소 캡슐과
 * (뒤로/앞으로/새로고침·공유·시작 페이지) 버튼은 본문 툴바에 둔다 —
 * Safari에서는 주소창과 툴바 행의 높이가 같고, 캡슐이 높으면 주소
 * 입력·이동 버튼이 자리를 잃는다.
 * '브라우저 시작' 버튼은 시작 페이지 카드의 것 하나로 둔다
 * (2026-11-06, image-147): 툴바 우측 버튼은 시작 카드 버튼과
 * 동시에 보여 중복이었고, 원격 뷰가 켜진 동안에는 시작 페이지 자체가 숨어
 * 카드 버튼을 볼 수 없게 되므로 그때는 시작이 아닌 종료 상태 토글이
 * [종료]가 맞는다.
 * 노출: window.MyHubBrowser = { normalizeInput, createApp }
 */
(function () {
  'use strict';

  var RECENTS_KEY = 'myhub.browser.recents.v1';
  var RECENTS_MAX = 6;

  /* 주소창 입력 → 실제 URL. 전체 URL은 그대로, 도메인만 보면 https를
     붙이고, 그 밖의 단어들은 Google 검색으로 보낸다. IPv4 주소와
     localhost(포트 포함)는 도메인 패턴에 안 걸려 검색으로 빠지는 것을
     주소로 판정한다. 그 이하는 https가 아닌 http로 연다. */
  function normalizeInput(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(text)) return 'http://' + text;
    if (/^localhost(:\d+)?([/?#].*)?$/i.test(text)) return 'http://' + text;
    if (!/\s/.test(text) && /^[^\s]+\.[a-z]{2,}([/?#].*)?$/i.test(text)) {
      return 'https://' + text;
    }
    return 'https://www.google.com/search?q=' + encodeURIComponent(text);
  }

  function loadRecents(storage) {
    try {
      var raw = storage.getItem(RECENTS_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return list.filter(function (r) {
        return r && typeof r.url === 'string';
      });
    } catch (err) {
      // 저장소가 막힌 환경(프라이빗 등)에서는 최근 방문 없이 동작한다
      return [];
    }
  }

  function saveRecent(storage, url) {
    try {
      var list = loadRecents(storage).filter(function (r) {
        return r.url !== url;
      });
      list.unshift({ url: url, at: Date.now() });
      storage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
    } catch (err) {
      // 저장 실패는 무시한다 (최근 방문은 부가 기능이다)
      console.debug('최근 방문 저장 생략:', err);
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (err) {
      return url;
    }
  }

  /**
   * deps = { doc, liveDeps, storage, win }
   * liveDeps는 browser-live.js createLive의 주입 인자(navigate 등).
   * storage는 localStorage 래퍼, win은 창 바 채널을 받는 창
   * (부모·프레임)이며 테스트 주입 인자이다.
   */
  function createApp(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var storage =
      deps.storage ||
      (typeof window !== 'undefined' && window.localStorage) ||
      (typeof localStorage !== 'undefined' ? localStorage : null);
    var liveFactory =
      (typeof window !== 'undefined' && window.MyHubBrowserLive) ||
      (typeof globalThis !== 'undefined' && globalThis.MyHubBrowserLive);
    if (!liveFactory || typeof liveFactory.createLive !== 'function') {
      throw new Error('MyHubBrowserLive 라이브러리가 없습니다. browser-live.js를 먼저 불러오십시오');
    }

    var urlInput = doc.getElementById('bwUrl');
    var home = doc.getElementById('bwHome');
    var homeBtn = doc.getElementById('bwHomeBtn');
    // 시작 버튼은 카드의 것 하나로 둔다 (헤더 참조 — 툴바 중복 제거)
    var startBtns = doc.querySelectorAll('.bw-start-btn');
    var tabstripEl = doc.getElementById('bwTabstrip');
    // 창 바 채널을 받는 창 (테스트 주입 인자 — office-tabs mount와 같은 방식)
    var appWin =
      deps.win ||
      (doc && doc.defaultView) ||
      (typeof window !== 'undefined' ? window : null);
    var favBtns = doc.querySelectorAll('.bw-fav');
    var recentsWrap = doc.getElementById('bwRecents');
    var recentsList = doc.getElementById('bwRecentsList');
    // 앱이 접기 (없으면 단일 앱으로만 동작 앱 옛 요청 환호)
    var tabsEl = doc.getElementById('bwTabs');
    var tabsOverflowBtn = doc.getElementById('bwTabsOverflow');
    var tabsMenuEl = doc.getElementById('bwTabsMenu');
    var newTabBtn = doc.getElementById('bwNewTabBtn');
    var backBtn = doc.getElementById('bwBackBtn');
    var fwdBtn = doc.getElementById('bwFwdBtn');
    var reloadBtn = doc.getElementById('bwReloadBtn');
    var shareBtn = doc.getElementById('bwShareBtn');
    var liveFrame = doc.getElementById('bwLiveFrame');
    var pillEl = doc.getElementById('bwPill');
    var noticeEl = doc.getElementById('bwNoticeCard');
    var elsewhereEl = doc.getElementById('bwElsewhere');
    var elsewhereMsg = doc.getElementById('bwElsewhereMsg');
    var elsewhereGoBtn = doc.getElementById('bwElsewhereGo');
    var elsewhereHereBtn = doc.getElementById('bwElsewhereHere');

    // ---------- 탭 모델 ----------
    var TABS_KEY = 'myhub.browser.tabs.v1';
    var tabs = [];
    var activeTabId = null;
    var liveTabId = null; // 원격 뷰를 소유한 탭 (한 번에 한 탭에만 보임)
    var tabSeq = 0;
    function makeTab(url) {
      tabSeq += 1;
      return {
        id: 't' + tabSeq + '-' + Date.now(),
        url: url || null,
        history: url ? [url] : [],
        hIndex: url ? 0 : -1,
      };
    }
    function activeTab() {
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].id === activeTabId) return tabs[i];
      }
      return null;
    }
    function tabTitle(tab) {
      return tab && tab.url ? hostOf(tab.url) : '새 탭';
    }
    function saveTabs() {
      if (!storage) return;
      try {
        storage.setItem(
          TABS_KEY,
          JSON.stringify({ tabs: tabs, activeTabId: activeTabId }),
        );
      } catch (err) {
        // 저장 실패는 무시한다 (탭 복원은 부가 기능이다)
        console.warn('[browser] 탭 상태 저장 실패 (무시):', err);
      }
    }
    function loadTabs() {
      if (!storage) return false;
      try {
        var raw = storage.getItem(TABS_KEY);
        if (!raw) return false;
        var data = JSON.parse(raw);
        if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
        var ok = data.tabs.filter(function (t) {
          return (
            t &&
            typeof t.id === 'string' &&
            Array.isArray(t.history) &&
            typeof t.hIndex === 'number'
          );
        });
        if (!ok.length) return false;
        tabs = ok.map(function (t) {
          return {
            id: t.id,
            url: typeof t.url === 'string' ? t.url : null,
            history: t.history.filter(function (u) {
              return typeof u === 'string';
            }),
            hIndex: Math.max(-1, Math.min(t.hIndex, t.history.length - 1)),
          };
        });
        activeTabId =
          typeof data.activeTabId === 'string' &&
          tabs.some(function (t) {
            return t.id === data.activeTabId;
          })
            ? data.activeTabId
            : tabs[0].id;
        tabSeq = tabs.length;
        return true;
      } catch (err) {
        return false;
      }
    }
    if (!loadTabs()) {
      tabs = [makeTab(null)];
      activeTabId = tabs[0].id;
    }

    var live = liveFactory.createLive(
      Object.assign({}, deps.liveDeps || {}, {
        doc: doc,
        onChange: function () {
          if (live.state() === 'off') liveTabId = null;
          syncChrome();
        },
      }),
    );

    function renderRecents() {
      if (!recentsWrap || !recentsList) return;
      var list = storage ? loadRecents(storage) : [];
      recentsList.textContent = '';
      list.forEach(function (r) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'bw-recent';
        btn.setAttribute('data-url', r.url);
        var host = doc.createElement('span');
        host.className = 'bw-recent-host';
        host.textContent = hostOf(r.url);
        var urlEl = doc.createElement('span');
        urlEl.className = 'bw-recent-url';
        urlEl.textContent = r.url;
        btn.appendChild(host);
        btn.appendChild(urlEl);
        btn.addEventListener('click', function () {
          go(r.url);
        });
        recentsList.appendChild(btn);
      });
      recentsWrap.hidden = list.length === 0;
    }

    var lastDocTitle; // undefined = 아직 게시 전 값
    function notifyDocTitle() {
      var w =
        (doc && doc.defaultView) ||
        (typeof window !== 'undefined' ? window : null);
      if (!w || !w.parent || w.parent === w) return;
      var tab = activeTab();
      var name = tab && tab.url ? hostOf(tab.url) : null;
      if (name === lastDocTitle) return;
      lastDocTitle = name;
      try {
        w.parent.postMessage(
          { type: 'myhub:doc-title', name: name, dirty: false },
          w.location.origin,
        );
      } catch (err) {
        // 부모 통신 실패는 무시한다 (탭 표시는 다음 게시 때 갱신된다)
        console.warn('[browser] 부모 통신 실패 (무시):', err);
      }
    }

    // ---------- 창 바 탭 게시 (myhub:browser-tabs 채널) ----------
    // 상태 서명이 바뀔 때만 게시한다 (notifyDocTitle와 같은 방식).
    // 탭을 클릭하면 탭 행을 남기고, 탭 클릭·닫기·새 탭은
    // myhub:browser-tabs-action으로 알려준 아래 실제 함수들을 연다.
    var tabsHosted = false;
    var lastTabsSig; // undefined = 아직 게시 전 값
    function browserTabsPayload() {
      return tabs.map(function (t) {
        return {
          id: t.id,
          label: tabTitle(t),
          live: t.id === liveTabId && live.isActive(),
        };
      });
    }
    function postBrowserTabs(force) {
      if (!appWin || !appWin.parent || appWin.parent === appWin) return;
      var payload = browserTabsPayload();
      var sig = JSON.stringify({ tabs: payload, activeId: activeTabId });
      if (!force && sig === lastTabsSig) return;
      lastTabsSig = sig;
      try {
        appWin.parent.postMessage(
          { type: 'myhub:browser-tabs', tabs: payload, activeId: activeTabId },
          appWin.location.origin,
        );
      } catch (err) {
        // 부모 통신 실패는 무시한다 (탭 표시는 다음 게시 때 갱신된다)
        console.warn('[browser] 창 바 탭 게시 실패 (무시):', err);
      }
    }
    function applyTabsHosting() {
      if (tabstripEl) tabstripEl.hidden = tabsHosted;
    }

    function refreshIcons() {
      try {
        var w =
          (doc && doc.defaultView) ||
          (typeof window !== 'undefined' ? window : null);
        if (w && w.lucide) w.lucide.createIcons();
      } catch (err) {
        // 아이콘 새로고침 실패는 기능과 무관하다
        console.warn('[browser] 아이콘 새로고침 실패 (무시):', err);
      }
    }

    function renderTabs() {
      if (!tabsEl) return;
      tabsEl.innerHTML = '';
      tabs.forEach(function (tab) {
        var el = doc.createElement('button');
        el.type = 'button';
        el.className = 'bw-tab' + (tab.id === activeTabId ? ' is-active' : '');
        el.setAttribute('role', 'tab');
        el.setAttribute(
          'aria-selected',
          tab.id === activeTabId ? 'true' : 'false',
        );
        var fav = doc.createElement('span');
        fav.className = 'bw-tab-fav';
        if (tab.url) fav.textContent = hostOf(tab.url).charAt(0).toUpperCase();
        else fav.innerHTML = '<i data-lucide="globe"></i>';
        var name = doc.createElement('span');
        name.className = 'bw-tab-name';
        name.textContent = tabTitle(tab);
        el.appendChild(fav);
        el.appendChild(name);
        if (tab.id === liveTabId && live.isActive()) {
          var dot = doc.createElement('span');
          dot.className = 'bw-tab-live';
          dot.title = '원격 브라우저 실행 중';
          el.appendChild(dot);
        }
        var close = doc.createElement('span');
        close.className = 'bw-tab-close';
        close.setAttribute('aria-hidden', 'true');
        close.textContent = '×';
        close.addEventListener('click', function (ev) {
          ev.stopPropagation();
          closeTab(tab.id);
        });
        el.appendChild(close);
        el.addEventListener('click', function () {
          activateTab(tab.id);
        });
        tabsEl.appendChild(el);
      });
      // 오버플로 규칙: 탭이 스트립 너비를 넘으면 목록 버튼을 보인다
      if (tabsOverflowBtn) {
        tabsOverflowBtn.hidden = !(tabsEl.scrollWidth > tabsEl.clientWidth + 1);
      }
      refreshIcons();
      // 창 바에서도 같은 상태를 게시한다 (클릭 접힘이 무관하게 앱
      // 앱이 없으면 앱 않고, 있으면 창 바가 정보 표면을 연다)
      postBrowserTabs(false);
    }

    function syncNavButtons() {
      var tab = activeTab();
      if (backBtn) backBtn.disabled = !(tab && tab.hIndex > 0);
      if (fwdBtn) {
        fwdBtn.disabled = !(tab && tab.hIndex < tab.history.length - 1);
      }
      if (reloadBtn) {
        reloadBtn.disabled = !(tab && tab.url);
      }
      if (shareBtn) shareBtn.disabled = !(tab && tab.url);
    }

    function syncChrome() {
      var state = live.state();
      var on = state === 'on';
      var busy = on || state === 'notice';
      var mine = liveTabId !== null && liveTabId === activeTabId;
      live.syncChrome();
      // 라이브 소유 요소(화면·토글…)는 뷰를 소유한 탭에서만
      // 보인다 — 다른 탭에서는 실행 중인 것처럼 보이지 않게 가린다.
      // 단, iframe은 display:none(hidden)이 아니라 visibility:hidden
      // 으로 숨긴다. display:none은 iframe 문서를 hidden으로 만들어
      // Selkies 클라이언트가 스트림을 멈추고, 돌아올 때 재연결·
      // 재동기화 갭이 생긴다 (2026-11-14 전환 시 끊김 보고).
      // visibility:hidden은 문서를 살려 둬 복귀가 즉시 된다.
      if (!mine && busy) {
        if (liveFrame) liveFrame.classList.add('bw-frame-parked');
        if (pillEl) pillEl.hidden = true;
        if (noticeEl) noticeEl.hidden = true;
      } else if (liveFrame) {
        liveFrame.classList.remove('bw-frame-parked');
      }
      if (home) home.hidden = mine && on;
      if (elsewhereEl) {
        var showElse = !mine && liveTabId !== null && on;
        elsewhereEl.hidden = !showElse;
        if (showElse && elsewhereMsg) {
          var owner = null;
          tabs.forEach(function (t) {
            if (t.id === liveTabId) owner = t;
          });
          elsewhereMsg.textContent =
            '브라우저 \'' +
            tabTitle(owner) +
            '\' 탭에서 실행 중이에요. 원격 브라우저는 한 번에 한 탭에서만 열려요.';
        }
      }
      if (urlInput) {
        // 입력 중이 아니면 활성 앱의 주소를 보여준다
        if (doc.activeElement !== urlInput) {
          var tab = activeTab();
          var v = tab && tab.url ? tab.url : '';
          if (urlInput.value !== v) urlInput.value = v;
        }
      }
      for (var i = 0; i < startBtns.length; i++) {
        startBtns[i].hidden = mine && on;
      }
      renderTabs();
      syncNavButtons();
      notifyDocTitle();
    }

    function activateTab(id) {
      if (id === activeTabId) {
        if (tabsMenuEl) tabsMenuEl.hidden = true;
        return;
      }
      var exists = tabs.some(function (t) {
        return t.id === id;
      });
      if (!exists) return;
      activeTabId = id;
      if (tabsMenuEl) tabsMenuEl.hidden = true;
      saveTabs();
      syncChrome();
    }

    function newTab() {
      var tab = makeTab(null);
      tabs.push(tab);
      activeTabId = tab.id;
      saveTabs();
      syncChrome();
      if (urlInput) urlInput.focus();
    }

    function closeTab(id) {
      var idx = -1;
      tabs.forEach(function (t, i) {
        if (t.id === id) idx = i;
      });
      if (idx < 0) return;
      // 뷰를 소유한 탭을 접으면 뷰도 꺼진다
      if (id === liveTabId && live.isActive()) live.endLive();
      tabs.splice(idx, 1);
      if (!tabs.length) tabs.push(makeTab(null));
      if (activeTabId === id) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
      }
      saveTabs();
      syncChrome();
    }

    /* 이 탭에서 원격 뷰 시작: 소유권을 활성 탭으로 먼저 못 박는다.
       다른 탭이 실행 중일 때의 시작 시도도 여기에 걸리도록
       소유권을 가로채지 않는다 (안내 버튼들의 시작을 방지). */
    function enterLiveHere(url) {
      if (!live.isActive() || liveTabId === activeTabId) {
        liveTabId = activeTabId;
      }
      return live.enterLive(url);
    }

    /* 주소로 이동: 영구 브라우저라 켜져 있으면 이동만 지시하고, 꺼져
       있으면 켜서 이동한다 (iframe을 껐다 켜지 않는다).
       최근 방문은 실제로 이동한 앱에만 기록한다 앱 시작의 실패한
       주소를 방문한 것으로 남기지 않기 위해서다. */
    function go(url, viaHist) {
      if (!url) return;
      var tab = activeTab();
      if (tab && !viaHist) {
        // 주소창 이동은 앱 기록에 쌓는다 (앞으로 기록은 버린다)
        tab.history = tab.history.slice(0, tab.hIndex + 1);
        if (tab.history[tab.hIndex] !== url) {
          tab.history.push(url);
          tab.hIndex = tab.history.length - 1;
        }
        tab.url = url;
        saveTabs();
      }
      startAndRecord(url);
    }

    function goBack() {
      var tab = activeTab();
      if (!tab || tab.hIndex <= 0) return;
      tab.hIndex -= 1;
      tab.url = tab.history[tab.hIndex];
      saveTabs();
      go(tab.url, true);
    }

    function goFwd() {
      var tab = activeTab();
      if (!tab || tab.hIndex >= tab.history.length - 1) return;
      tab.hIndex += 1;
      tab.url = tab.history[tab.hIndex];
      saveTabs();
      go(tab.url, true);
    }

    function startAndRecord(url) {
      Promise.resolve(enterLiveHere(url)).then(function (started) {
        if (!started) return;
        if (url && storage) saveRecent(storage, url);
        renderRecents();
      });
    }

    function submitInput() {
      var url = normalizeInput(urlInput ? urlInput.value : '');
      if (!url) return;
      go(url);
      if (urlInput) urlInput.blur();
    }

    if (urlInput) {
      urlInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          submitInput();
        }
      });
      urlInput.addEventListener('focus', function () {
        urlInput.select();
      });
    }
    for (var i = 0; i < startBtns.length; i++) {
      startBtns[i].addEventListener('click', function () {
        enterLiveHere(null);
      });
    }
    if (backBtn) backBtn.addEventListener('click', goBack);
    if (fwdBtn) fwdBtn.addEventListener('click', goFwd);
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function () {
        var tab = activeTab();
        if (tab && tab.url) go(tab.url, true);
      });
    }
    if (shareBtn) {
      shareBtn.addEventListener('click', function () {
        var tab = activeTab();
        if (!tab || !tab.url) return;
        var nav =
          (doc.defaultView && doc.defaultView.navigator) ||
          (typeof navigator !== 'undefined' ? navigator : null);
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          nav.clipboard.writeText(tab.url).catch(function () {
            if (urlInput) {
              urlInput.focus();
              urlInput.select();
            }
          });
        } else if (urlInput) {
          urlInput.focus();
          urlInput.select();
        }
      });
    }
    if (newTabBtn) newTabBtn.addEventListener('click', newTab);
    if (tabsOverflowBtn && tabsMenuEl) {
      tabsOverflowBtn.addEventListener('click', function () {
        if (!tabsMenuEl.hidden) {
          tabsMenuEl.hidden = true;
          return;
        }
        tabsMenuEl.innerHTML = '';
        tabs.forEach(function (tab) {
          var item = doc.createElement('button');
          item.type = 'button';
          item.className =
            'bw-tabs-menu-item' + (tab.id === activeTabId ? ' is-active' : '');
          item.textContent = tabTitle(tab);
          item.addEventListener('click', function () {
            activateTab(tab.id);
          });
          tabsMenuEl.appendChild(item);
        });
        tabsMenuEl.hidden = false;
      });
      doc.addEventListener('click', function (ev) {
        if (tabsMenuEl.hidden) return;
        var t = ev && ev.target;
        if (t && (tabsMenuEl.contains(t) || (tabsOverflowBtn && tabsOverflowBtn.contains(t)))) return;
        tabsMenuEl.hidden = true;
      });
    }
    if (elsewhereGoBtn) {
      elsewhereGoBtn.addEventListener('click', function () {
        if (liveTabId) activateTab(liveTabId);
      });
    }
    if (elsewhereHereBtn) {
      elsewhereHereBtn.addEventListener('click', function () {
        var tab = activeTab();
        if (tab && tab.url) go(tab.url, true);
        else if (live.isActive()) {
          // 소유권만 이 탭으로 옮긴다 — 영구 브라우저라 iframe을
          // 껐다 켤 필요가 없다.
          liveTabId = activeTabId;
          saveTabs();
          syncChrome();
        } else {
          startAndRecord(null);
        }
      });
    }
    for (var j = 0; j < favBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          go(btn.getAttribute('data-url'));
        });
      })(favBtns[j]);
    }
    if (homeBtn) {
      homeBtn.addEventListener('click', function () {
        // 시작 페이지 버튼은 활성 탭이 뷰를 소유한 때만 종료하고,
        // 다른 탭의 뷰는 건드리지 않는다
        if (liveTabId !== activeTabId) return;
        if (live.isActive()) live.endLive();
        else if (live.state() === 'notice') live.dismissNotice();
      });
    }

    // 창 바 탭 채널의 수신부: 채택(adopt)·탭 목록 요청·동작(선택·
    // 닫기·새 탭). 출처는 부모 창으로 판정한다
    // (e.source === appWin.parent).
    if (appWin && typeof appWin.addEventListener === 'function') {
      appWin.addEventListener('message', function (e) {
        if (!e || !e.data || e.source !== appWin.parent) return;
        var d = e.data;
        if (d.type === 'myhub:browser-tabs-adopt') {
          if (!tabsHosted) {
            tabsHosted = true;
            applyTabsHosting();
          }
        } else if (d.type === 'myhub:request-browser-tabs') {
          postBrowserTabs(true);
        } else if (d.type === 'myhub:browser-tabs-action') {
          if (d.action === 'select' && typeof d.id === 'string') {
            activateTab(d.id);
          } else if (d.action === 'close' && typeof d.id === 'string') {
            closeTab(d.id);
          } else if (d.action === 'new') {
            newTab();
          }
        }
      });
    }

    // 앱 상단 메뉴바 정의 (계약: js/desktop/windows.js 상단 주석).
    // 즐겨찾기·최근 방문은 목록 항목으로 열어 보여준다. 툴바 버튼
    // (뒤로·앞으로·새로고침·공유 등)은 메뉴바에도 같은 명령이 있어야
    // 한다는 HIG 규칙으로 함께 둔다. 새로고침은 같은 주소로 다시 이동해
    // 다시 여는 것이 실제 이동 방식이다.
    var menuWin =
      (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (menuWin && typeof menuWin.addEventListener === 'function') {
      // 앱 창 제목은 닫기치유 채널 (다른 앱과 같은 계약)
      menuWin.addEventListener('message', function (e) {
        if (!e || !e.data || e.data.type !== 'myhub:request-doc-title') return;
        if (e.source !== menuWin.parent) return;
        lastDocTitle = undefined;
        notifyDocTitle();
      });
    }
    if (menuWin) {
      menuWin.MyHubMenus = [
        {
          label: '이동',
          items: function () {
            var st = live.state();
            var tab = activeTab();
            return [
              {
                label: '뒤로',
                disabled: !(tab && tab.hIndex > 0),
                run: goBack,
              },
              {
                label: '앞으로',
                disabled: !(tab && tab.hIndex < tab.history.length - 1),
                run: goFwd,
              },
              {
                label: '새로고침',
                disabled: !(tab && tab.url),
                run: function () {
                  if (tab && tab.url) go(tab.url, true);
                },
              },
              {
                label: '시작 페이지로',
                run: function () {
                  if (homeBtn) homeBtn.click();
                },
              },
              {
                label: '브라우저 시작',
                disabled: st === 'on',
                run: function () {
                  if (startBtns[0]) startBtns[0].click();
                },
              },
            ];
          },
        },
        {
          label: '탭',
          items: function () {
            var items = [
              {
                label: '새 탭',
                run: newTab,
              },
              {
                label: '탭 닫기',
                run: function () {
                  closeTab(activeTabId);
                },
              },
            ];
            if (tabs.length > 1) {
              items.push({ separator: true });
              tabs.forEach(function (t) {
                items.push({
                  label: tabTitle(t) + (t.id === liveTabId && live.isActive() ? ' (실행 중)' : ''),
                  checked: t.id === activeTabId,
                  run: function () {
                    activateTab(t.id);
                  },
                });
              });
            }
            return items;
          },
        },
        {
          label: '즐겨찾기',
          items: function () {
            var items = [];
            Array.prototype.forEach.call(favBtns, function (btn) {
              var name = btn.querySelector('.bw-fav-name');
              items.push({
                label: name ? name.textContent : btn.getAttribute('data-url'),
                run: function () {
                  btn.click();
                },
              });
            });
            return items.length
              ? items
              : [{ label: '즐겨찾기 없음', disabled: true }];
          },
        },
        {
          label: '최근 방문',
          items: function () {
            var list = storage ? loadRecents(storage) : [];
            if (!list.length) return [{ label: '최근 방문 없음', disabled: true }];
            return list.map(function (r) {
              return {
                label: hostOf(r.url),
                sub: r.url,
                run: function () {
                  go(r.url);
                },
              };
            });
          },
        },
      ];
    }

    renderRecents();
    syncChrome();
    return {
      go: go,
      live: live,
      syncChrome: syncChrome,
      isTabsHosted: function () {
        return tabsHosted;
      },
      newTab: newTab,
      closeTab: closeTab,
      activateTab: activateTab,
      getTabs: function () {
        return tabs.map(function (t) {
          return {
            id: t.id,
            url: t.url,
            history: t.history.slice(),
            hIndex: t.hIndex,
            active: t.id === activeTabId,
            live: t.id === liveTabId,
          };
        });
      },
    };
  }

  var api = { normalizeInput: normalizeInput, createApp: createApp };
  if (typeof window !== 'undefined') window.MyHubBrowser = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubBrowser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (
    typeof document !== 'undefined' &&
    document.getElementById &&
    document.getElementById('bwUrl')
  ) {
    createApp();
  }
})();
