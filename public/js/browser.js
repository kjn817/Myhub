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
 * 한다. 뒤로/앞으로는 원격 기록을 먼저 쓴다: 원격이 켜져 있으면
 * CDP 상태 폴링이 본 실제 URL·뒤로/앞으로 가능 여부가 주소창·버튼의
 * 기준이 되고, 뒤로/앞으로 버튼은 원격 기록에 먼저 지시한다
 * (2026-11-15: 원격 내 링크 이동은 셸 로컬 기록에 없어 주소가
 * 고정되고 뒤로가기가 안 됐다). 원격 이동이 실패하면 로컬 기록으로
 * 폴백한다.
 * 탭 표면 (2026-11-06, image-147; 2026-11-14 타이틀바 한 줄 통일로
 * 변경): 탭 줄은 iframe 안의 #bwTabstrip이 창 모드·단독 모드 모두
 * 담당한다. 창 모드에서는 내비게이션을 셸 제목 바가 호스팅한다 —
 * iframe이 내비 상태(myhub:browser-nav)를 게시하면 셸이 제목 바에
 * 사이드바·뒤로/앞으로·주소 캡슐·공유·새 탭·탭 개요를 그리고,
 * 명령은 myhub:browser-nav-action으로 iframe에 돌려보낸다
 * (win-actions·finder-toolbar와 같은 계약: 게시 → 클릭 → 동작 전임).
 * 창 모드에서는 iframe 툴바(.bw-toolbar) 자체를 숨긴다. 단독 실행에서는
 * 게시할 부모가 없으므로 툴바를 페이지 안에 둔다.
 * 사이드바(즐겨찾기·최근 방문·열린 탭)와 탭 개요(파비콘+제목 카드
 * 그리드)는 iframe 안의 스테이지 오버레이로, 셸·단독 버튼 둘 다
 * 같은 토글을 연다. 원격 탭 썸네일은 없으므로 개요에 썸네일은 없다.
 * 북마크·방문 기록 (2026-11-20 1단계): D1이 유일한 원천이다.
 * 시작 페이지 타일은 pinned 북마크만, 사이드바는 전체를 보여준다.
 * 방문 기록은 이동 성공·원격 URL 변경 때 fire-and-forget으로
 * POST한다 (기록 실패가 탐색을 막지 않는다).
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
    // 시작 버튼은 카드의 것 하나로 둔다 (헤더 참조 — 툴바 중복 제거)
    var startBtns = doc.querySelectorAll('.bw-start-btn');
    var toolbarEl = doc.getElementById('bwToolbar');
    var tabstripEl = doc.getElementById('bwTabstrip');
    // 창 바 채널을 받는 창 (테스트 주입 인자 — office-tabs mount와 같은 방식)
    var appWin =
      deps.win ||
      (doc && doc.defaultView) ||
      (typeof window !== 'undefined' ? window : null);
    var favsEl = doc.getElementById('bwFavs');
    var favsEditBtn = doc.getElementById('bwFavsEdit');
    var favFormEl = doc.getElementById('bwFavForm');
    var favUrlInput = doc.getElementById('bwFavUrl');
    var favTitleInput = doc.getElementById('bwFavTitle');
    var favFormMsg = doc.getElementById('bwFavFormMsg');
    var favSaveBtn = doc.getElementById('bwFavSave');
    var favCancelBtn = doc.getElementById('bwFavCancel');
    var sidebarHistoryEl = doc.getElementById('bwSidebarHistory');
    var historySearchInput = doc.getElementById('bwHistorySearch');
    var historyClearBtn = doc.getElementById('bwHistoryClear');
    var sidebarDownloadsEl = doc.getElementById('bwSidebarDownloads');
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
    var sidebarBtn = doc.getElementById('bwSidebarBtn');
    var overviewBtn = doc.getElementById('bwOverviewBtn');
    var sidebarEl = doc.getElementById('bwSidebar');
    var sidebarBackdrop = doc.getElementById('bwSidebarBackdrop');
    var sidebarCloseBtn = doc.getElementById('bwSidebarClose');
    var sidebarFavsEl = doc.getElementById('bwSidebarFavs');
    var sidebarTabsEl = doc.getElementById('bwSidebarTabs');
    var overviewEl = doc.getElementById('bwOverview');
    var overviewGridEl = doc.getElementById('bwOverviewGrid');
    var overviewCloseBtn = doc.getElementById('bwOverviewClose');
    var overviewSearchInput = doc.getElementById('bwOverviewSearch');
    var liveFrame = doc.getElementById('bwLiveFrame');
    var noticeEl = doc.getElementById('bwNoticeCard');
    var lockEl = doc.getElementById('bwLockCard');
    var elsewhereEl = doc.getElementById('bwElsewhere');
    var elsewhereMsg = doc.getElementById('bwElsewhereMsg');
    var elsewhereGoBtn = doc.getElementById('bwElsewhereGo');
    var elsewhereHereBtn = doc.getElementById('bwElsewhereHere');

    // ---------- 탭 모델 ----------
    var TABS_KEY = 'myhub.browser.tabs.v1';
    var tabs = [];
    var activeTabId = null;
    var liveTabId = null; // 원격 뷰를 소유한 탭 (한 번에 한 탭에만 보임)
    var mainTargetId = null; // 원격 메인 타깃 id (상태 폴링이 알려준다)
    // 원격 재시작 감지 플래그 (2026-11-21 셸 주도 탭 복원): 원격이
    // 새 탭뿐인 상태로 돌아오면 syncRemoteTabs가 세우고,
    // applyRemoteState가 라이브 탭 URL로 한 번 이동한 뒤 내린다.
    // 네이티브 세션 복원은 이 빌드에서 동작하지 않는다 (Session
    // 파일이 절대 안 써짐 — 3회 실험으로 확정). 셸이 탭을 지우지
    // 않고 다시 이동시키는 것이 복원 메커니즘이다.
    var remoteRestarted = false;
    var tabSeq = 0;
    function makeTab(url) {
      tabSeq += 1;
      return {
        id: 't' + tabSeq + '-' + Date.now(),
        url: url || null,
        history: url ? [url] : [],
        hIndex: url ? 0 : -1,
        // 원격 상태 폴링이 본 뒤로/앞으로 가능 여부 (null = 아직 모름).
        // 원격이 켜져 있으면 이 값이 로컬 기록보다 우선한다 (2026-11-15).
        remote: null,
        // 원격 페이지 타깃 id (2026-11-19 새 창→새 탭): 팝업 탭은 생성
        // 시, 라이브 탭은 메인 타깃에 묶인다. null이면 로컬 전용 탭.
        remoteTargetId: null,
        // 실제 페이지 제목 (2026-11-20 3단계): /state 폴링이 채운다.
        // URL이 바뀌면 지운다 — 낡은 제목이 새 페이지에 남으면 안 된다.
        title: null,
        // 고정 탭 (2026-11-20 3단계): 탭 줄 맨 앞에 작게 모인다.
        pinned: false,
      };
    }
    function activeTab() {
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].id === activeTabId) return tabs[i];
      }
      return null;
    }
    function tabTitle(tab) {
      if (!tab) return '새 탭';
      var t = (tab.title || '').trim();
      if (t) return t;
      return tab.url ? hostOf(tab.url) : '새 탭';
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
            remote: null, // 원격 상태는 런타임 값이라 복원하지 않는다
            // 원격 타깃은 영구 크로뮴에 살아 있으므로 복원한다 — 사라진
            // 타깃은 다음 상태 폴링에서 연결만 끊긴다 (탭은 안 지운다).
            remoteTargetId: typeof t.remoteTargetId === 'string' ? t.remoteTargetId : null,
            title: typeof t.title === 'string' && t.title.trim() ? t.title : null,
            pinned: t.pinned === true,
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
        onState: function (state) {
          applyRemoteState(state);
        },
      }),
    );

    /* 뒤로/앞으로 가능 여부: 라이브가 켜져 있고 이 탭이 뷰 소유 탭이면
       원격 caps만 쓴다. 원격 내 링크 이동은 로컬 기록에 없으므로
       로컬 기록만 보면 뒤로가기가 비활성으로 보인다 (2026-11-15).
       원격 상태를 아직 모르면(remote null) 둘 다 false로 버튼을 끈다
       — 상태를 모르면 버튼을 끄는 것이 낡은 기록으로 엉뚱한 곳에
       가는 것보다 옳다 (2026-11-16 QA 1차). 라이브가 꺼져 있을
       때만 로컬 기록 caps를 쓴다. */
    function navCaps(tab) {
      if (tab && tab.id === liveTabId && live.isActive()) {
        return {
          canBack: !!(tab.remote && tab.remote.canBack),
          canFwd: !!(tab.remote && tab.remote.canFwd),
        };
      }
      return {
        canBack: !!(tab && tab.hIndex > 0),
        canFwd: !!(tab && tab.hIndex < tab.history.length - 1),
      };
    }

    /* 원격 상태 폴링 결과를 소유 탭에 반영한다 (2026-11-15). 원격 내
       링크 이동은 로컬 기록에 없으므로, 폴링이 본 실제 URL이 주소창·
       탭 제목의 기준이 된다. 로컬 기록은 건드리지 않는다 — 원격
       이동을 로컬 기록에 섞으면 뒤로가기 폴백이 엉킨다. */
    function applyRemoteState(state) {
      if (!state || typeof state.url !== 'string') return;
      // 동기화부터: 팝업이 생겼으면 그 탭이 라이브 탭이 되고, 팝업이
      // 사라졌으면 메인 탭으로 뷰가 돌아간다. URL 반영은 그 뒤에 해야
      // 팝업 URL이 예전 라이브 탭에 찍히는 일이 없다.
      syncRemoteTabs(state);
      // 재시작 복원 (2026-11-21): 원격이 새 탭뿐으로 돌아왔으면
      // 라이브 탭 URL로 한 번 이동한다. 플래그는 여기서 소비한다 —
      // 이동 실패 시 재시도하지 않는다 (매 폴링마다 재시도하면
      // 내비게이션이 스팸이 된다). 탭 자체는 보존돼 있어 수동
      // 이동으로도 복구할 수 있다.
      if (remoteRestarted && live.isActive()) {
        remoteRestarted = false;
        var restoreTab = null;
        tabs.forEach(function (t) {
          if (t.id === liveTabId) restoreTab = t;
        });
        if (!restoreTab) restoreTab = activeTab();
        if (restoreTab && restoreTab.url) {
          live.enterLive(restoreTab.url, restoreTab.remoteTargetId || null);
        }
      }
      // URL·탐색 상태는 원격 활성 타깃을 가진 탭에 반영한다. tabs가 없는
      // 폴백에서는 라이브 탭에 반영한다. 활성 타깃 소유자가 없으면
      // (비서 임시 탭이 활성) 이번 폴링은 반영하지 않는다.
      var owner = null;
      if (Array.isArray(state.tabs)) {
        if (state.activeTargetId) {
          tabs.forEach(function (t) {
            if (t.remoteTargetId === state.activeTargetId) owner = t;
          });
        }
      } else {
        tabs.forEach(function (t) {
          if (t.id === liveTabId) owner = t;
        });
      }
      if (!owner) return;
      var changed = false;
      if (owner.url !== state.url) {
        // chrome:// URL은 '페이지 없음'이라 기존 http(s) URL을 덮지
        // 않는다 — 재시작 직후 재이동 전에 폴링이 먼저 오면 라이브
        // 탭 URL이 새 탭 주소로 날아가고 기록에도 남는다 (2026-11-21).
        var isChromeUrl = state.url.indexOf('chrome://') === 0;
        var ownerHasPage =
          typeof owner.url === 'string' && owner.url.indexOf('http') === 0;
        if (!isChromeUrl || !ownerHasPage) {
          owner.url = state.url;
          changed = true;
          // 원격 내 링크 이동도 방문 기록에 남긴다 (upsert라 중복 행 없음).
          recordHistory(state.url);
        }
      }
      // 실제 페이지 제목을 탭에 반영한다 (없으면 호스트 폴백 — tabTitle).
      var newTitle =
        typeof state.title === 'string' && state.title.trim() ? state.title.trim() : null;
      if (owner.title !== newTitle) {
        owner.title = newTitle;
        changed = true;
      }
      var remote = {
        canBack: !!state.canGoBack,
        canFwd: !!state.canGoForward,
      };
      if (
        !owner.remote ||
        owner.remote.canBack !== remote.canBack ||
        owner.remote.canFwd !== remote.canFwd
      ) {
        owner.remote = remote;
        changed = true;
      }
      if (changed) {
        saveTabs();
        syncChrome();
      }
    }

    /* 원격 탭 앞으로 불러오기·닫기 (2026-11-19 새 창→새 탭). fetch가
       없거나 실패해도 false로 resolve될 뿐 던지지 않는다 — 상태 폴링이
       2초 뒤에 바로잡는다. */
    function postTabAction(action, targetId) {
      var f =
        (appWin && typeof appWin.fetch === 'function' && appWin.fetch) ||
        (typeof fetch === 'function' && fetch);
      if (!f) return Promise.resolve(false);
      return f('/api/browse/tab/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: targetId }),
      })
        .then(function (res) {
          return !!(res && res.ok);
        })
        .catch(function () {
          return false;
        });
    }
    function activateRemoteTab(targetId) {
      return postTabAction('activate', targetId);
    }
    function closeRemoteTab(targetId) {
      postTabAction('close', targetId);
    }

    /* 원격 탭 목록을 셸 탭과 맞춘다 (2026-11-19 새 창→새 탭, 상태 폴링
       2초마다). 키오스크 팝업은 전체 화면 창이라 셸이 모르면 돌아올
       방법이 없었는데, 이제 팝업이 셸 탭이 된다.
       - tabs가 없으면(직접 CDP 폴백) 건드리지 않는다 — 없는 목록으로
         팝업 탭을 지워버리면 안 된다.
       - openerId가 있는 타깃만 새 탭으로 만든다 (메인·비서 임시 탭 제외).
       - 사라진 원격 탭의 셸 탭은 지운다. 단, 활성 타깃 소유자가
         없으면(크로뮴 재시작 — 원격이 새 탭뿐이라 어떤 셸 탭도
         활성 타깃을 안 가짐) 모든 탭의 연결만 끊고 지우지 않는다.
         옛 가드(isLive && !activeOwner)는 라이브 탭만 살리고
         나머지 탭을 전부 지워버렸다 — 재시작 때마다 저장된 탭이
         날아가는 데이터 손실이었다 (2026-11-21). 원격이 새 탭
         하나뿐이면 재시작 플래그를 세워 라이브 탭 URL로 다시
         이동한다 (셸 주도 복원). 마지막 탭도 연결만 끊는다.
         라이브 팝업이 닫혀 활성 타깃 소유자(메인 탭)가 있으면
         팝업 탭을 지우고 뷰를 넘긴다.
       - 팝업이 열리면 그 탭으로 전환하고 뷰 소유권도 옮긴다 — 원격
         화면이 이미 팝업이므로 주소창·탭 줄이 화면과 맞아야 한다.
       - 재시작 재바인딩 (2026-11-20 5단계, 0c): 크로뮴 재시작 후에는
         원격 타깃 id가 전부 바뀌지만, 원격에 URL이 같은 탭이
         있으면(비서가 다시 열었거나 내비게이션으로 복원된 경우)
         낡은 id에 묶인 셸 탭을 URL이 같은 아직 안 묶인 원격 탭에
         다시 묶는다 — 1번(새 팝업 생성)보다 먼저 해야 복원된
         팝업이 중복 탭으로 생기지 않는다. URL이 같은 원격 탭이
         없으면(진짜 닫힘) 그대로 두고 2번이 처리한다. 네이티브
         세션 복원은 이 빌드에서 동작하지 않는다 (Session 파일이
         절대 안 써짐 — 2026-11-21 3회 실험 확정). 재시작 복원은
         연결 해제 + 라이브 탭 재이동이 맡는다. */
    function syncRemoteTabs(state) {
      if (!state || !Array.isArray(state.tabs)) return;
      if (typeof state.mainTargetId === 'string' || state.mainTargetId === null) {
        mainTargetId = state.mainTargetId;
      }
      var byRemote = {};
      state.tabs.forEach(function (t) {
        byRemote[t.targetId] = t;
      });
      var changed = false;
      // 0. 라이브 탭 바인딩: 아직 안 묶였으면 메인 타깃에 묶는다.
      var liveTab = null;
      tabs.forEach(function (t) {
        if (t.id === liveTabId) liveTab = t;
      });
      if (liveTab && !liveTab.remoteTargetId && mainTargetId) {
        liveTab.remoteTargetId = mainTargetId;
        changed = true;
      }
      // 0b. 원격 탭 제목 반영: 타깃이 묶인 셸 탭은 목록의 title을 쓴다
      // (활성 탭이 아닌 팝업 탭의 제목도 여기서 채워진다).
      state.tabs.forEach(function (rt) {
        if (!rt.targetId) return;
        var t = null;
        tabs.forEach(function (x) {
          if (x.remoteTargetId === rt.targetId) t = x;
        });
        if (!t) return;
        var rtTitle =
          typeof rt.title === 'string' && rt.title.trim() ? rt.title.trim() : null;
        if (t.title !== rtTitle) {
          t.title = rtTitle;
          changed = true;
        }
      });
      // 0c. 재시작 재바인딩 (2026-11-20 5단계): 낡은 타깃 id에 묶인
      // 셸 탭을 URL이 같은 아직 안 묶인 원격 탭에 다시 묶는다. 재시작
      // 후 타깃 id는 전부 바뀌지만 복원된 탭의 URL은 같으므로, id로만
      // 비교하면 2번이 팝업 탭을 전부 지워버린다. 1번보다 먼저 해야
      // 복원된 팝업이 새 셸 탭으로 중복 생성되지 않는다. 같은 URL의
      // 원격 탭이 여러 개면 아직 안 묶인 첫 번째에 묶는다 (1:1 —
      // 이미 묶인 타깃은 건너뛰어 한 타깃에 두 탭이 안 묶인다).
      tabs.forEach(function (t) {
        if (!t.remoteTargetId || byRemote[t.remoteTargetId] || !t.url) return;
        var candidate = null;
        state.tabs.forEach(function (rt) {
          if (candidate || !rt.targetId || !sameUrl(rt.url, t.url)) return;
          var owned = false;
          tabs.forEach(function (x) {
            if (x.remoteTargetId === rt.targetId) owned = true;
          });
          if (!owned) candidate = rt;
        });
        if (!candidate) return;
        t.remoteTargetId = candidate.targetId;
        var rtTitle =
          typeof candidate.title === 'string' && candidate.title.trim()
            ? candidate.title.trim()
            : null;
        if (t.title !== rtTitle) t.title = rtTitle;
        changed = true;
      });
      // 1. 새 팝업 → 셸 탭 생성 + 전환.
      state.tabs.forEach(function (rt) {
        if (!rt.openerId) return;
        var exists = tabs.some(function (t) {
          return t.remoteTargetId === rt.targetId;
        });
        if (exists) return;
        var tab = makeTab(rt.url || null);
        tab.remoteTargetId = rt.targetId;
        tab.title =
          typeof rt.title === 'string' && rt.title.trim() ? rt.title.trim() : null;
        tabs.push(tab);
        activeTabId = tab.id;
        liveTabId = tab.id;
        changed = true;
      });
      // 2. 사라진 원격 탭 → 셸 탭 제거.
      var removedActive = false;
      for (var i = tabs.length - 1; i >= 0; i--) {
        var t = tabs[i];
        if (!t.remoteTargetId || byRemote[t.remoteTargetId]) continue;
        var isLive = t.id === liveTabId;
        // 활성 타깃을 가진 다른 탭이 있으면 뷰가 그쪽으로 넘어가므로
        // 사라진 탭은 제거해도 된다. 없으면(재시작) 연결만 끊는다.
        var activeOwner = null;
        if (state.activeTargetId) {
          tabs.forEach(function (x) {
            if (x.id !== t.id && x.remoteTargetId === state.activeTargetId) activeOwner = x;
          });
        }
        if (tabs.length <= 1 || !activeOwner) {
          t.remoteTargetId = null;
          changed = true;
          // 원격이 새 탭 하나뿐이면 재시작이다 — 플래그를 세워
          // applyRemoteState가 라이브 탭 URL로 다시 이동하게 한다.
          // 비서 임시 탭이 활성일 때는 원격 탭이 여러 개라 안 선다.
          if (!activeOwner && state.tabs.length <= 1) remoteRestarted = true;
          continue;
        }
        if (t.id === activeTabId) removedActive = true;
        if (isLive) liveTabId = activeOwner.id;
        tabs.splice(i, 1);
        changed = true;
      }
      // 3. 활성 탭이 사라졌으면 활성 타깃 소유 탭으로 따라간다.
      if (removedActive) {
        var follow = null;
        if (state.activeTargetId) {
          tabs.forEach(function (t) {
            if (t.remoteTargetId === state.activeTargetId) follow = t;
          });
        }
        if (!follow) {
          tabs.forEach(function (t) {
            if (t.id === liveTabId) follow = t;
          });
        }
        if (!follow && tabs.length) follow = tabs[0];
        if (follow) {
          activeTabId = follow.id;
          liveTabId = follow.id;
        }
      }
      if (changed) {
        saveTabs();
        syncChrome();
      }
    }

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

    // ---------- 북마크·방문 기록 (D1, 2026-11-20 1단계) ----------
    // 북마크는 API가 유일한 원천이다. 시작 페이지 타일은 pinned만,
    // 사이드바는 전체를 보여준다. 기록은 fire-and-forget — 실패해도
    // 탐색을 막지 않는다.
    var bookmarks = [];
    var favEditMode = false;
    var favEditId = null; // null이면 추가, 숫자면 해당 북마크 이름 편집
    var historyItems = [];
    var historyQuery = '';
    var historySearchTimer = null;

    function apiFetch(path, opts) {
      var f =
        (appWin && typeof appWin.fetch === 'function' && appWin.fetch) ||
        (typeof fetch === 'function' && fetch);
      if (!f) return Promise.resolve(null);
      return f(path, opts).catch(function () {
        return null;
      });
    }

    // URL 동등 판정: Worker가 new URL().toString()으로 정규화해 저장하므로
    // 비교도 정규화해서 한다 ('https://www.naver.com'과 '.../는 같은 곳).
    function sameUrl(a, b) {
      if (a === b) return true;
      try {
        return new URL(a).toString() === new URL(b).toString();
      } catch (err) {
        return false;
      }
    }

    function bookmarkForUrl(url) {
      for (var i = 0; i < bookmarks.length; i++) {
        if (sameUrl(bookmarks[i].url, url)) return bookmarks[i];
      }
      return null;
    }

    function loadBookmarks() {
      return apiFetch('/api/browse/bookmarks')
        .then(function (res) {
          if (!res || !res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.bookmarks)) return;
          bookmarks = data.bookmarks;
          renderFavs();
          if (sidebarOpen()) renderSidebar();
        })
        .catch(function (err) {
          // 북마크 로딩 실패는 타일만 비어 보이지만, 조용한 실패는 안 된다 (관문 23)
          console.warn('[browser] bookmarks load failed', err);
        });
    }

    function recordHistory(url) {
      if (!url) return;
      apiFetch('/api/browse/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url, title: hostOf(url) }),
      });
    }

    function loadHistory(query) {
      var q = typeof query === 'string' ? query : historyQuery;
      var path =
        '/api/browse/history?limit=100' + (q ? '&q=' + encodeURIComponent(q) : '');
      return apiFetch(path)
        .then(function (res) {
          if (!res || !res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.history)) return;
          historyItems = data.history;
          renderSidebarHistory();
        })
        .catch(function (err) {
          console.warn('[browser] history load failed', err);
        });
    }

    function deleteBookmark(id) {
      apiFetch('/api/browse/bookmarks/' + id, { method: 'DELETE' }).then(function () {
        loadBookmarks();
      });
    }

    function toggleCurrentBookmark() {
      var tab = activeTab();
      if (!tab || !tab.url) return;
      var existing = bookmarkForUrl(tab.url);
      if (existing) {
        deleteBookmark(existing.id);
      } else {
        apiFetch('/api/browse/bookmarks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: tab.url, title: hostOf(tab.url), pinned: true }),
        }).then(function () {
          loadBookmarks();
        });
      }
    }

    // ---------- 다운로드 목록 (2026-11-20 브라우저 2단계) ----------
    // 완료된 다운로드만 본다 (진행 중 표시는 사이드카 변경이 필요해
    // 이번 범위 밖). 데이터는 Drive '다운로드' 폴더(folder_id 4)의
    // 기존 목록 API — 새 테이블·새 Worker 엔드포인트 없이 가져온다.
    // API가 id DESC(최신순)로 주므로 그대로 최대 20개만 쓴다.
    var DOWNLOADS_FOLDER_ID = 4;
    var DOWNLOADS_MAX = 20;
    var downloadItems = [];

    function loadDownloads() {
      return apiFetch('/api/drive/list?folder=' + DOWNLOADS_FOLDER_ID)
        .then(function (res) {
          if (!res || !res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.files)) return;
          downloadItems = data.files.slice(0, DOWNLOADS_MAX);
          renderSidebarDownloads();
        })
        .catch(function (err) {
          console.warn('[browser] 다운로드 목록 로딩 실패:', err);
        });
    }

    /* 파일 크기 표시 (B/KB/MB/GB — Finder의 표기와 같은 모양). */
    function formatFileSize(n) {
      if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
      if (n < 1024) return n + 'B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, '') + 'KB';
      if (n < 1024 * 1024 * 1024)
        return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'MB';
      return (n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'GB';
    }

    /* 다운로드 시간 표시: 오늘은 시:분만, 그 전은 월/일 시:분.
       created_at은 UTC 문자열(ISO 또는 'YYYY-MM-DD HH:MM:SS')이다. */
    function formatDownloadTime(value) {
      if (!value) return '';
      var text = String(value);
      var iso = /T/.test(text) ? text : text.replace(' ', 'T') + 'Z';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var now = new Date();
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      var sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (sameDay) return hh + ':' + mm;
      return d.getMonth() + 1 + '/' + d.getDate() + ' ' + hh + ':' + mm;
    }

    /* 오피스 확장자 → 셸이 해당 앱으로 직접 연다 (Finder 더블클릭과
       같은 매핑 — finder.js OFFICE_APP_BY_EXT와 함께 고칠 것). */
    var DOWNLOAD_OFFICE_APP_BY_EXT = {
      xlsx: 'excel',
      xls: 'excel',
      csv: 'excel',
      hwp: 'hangul',
      hwpx: 'hangul',
      pptx: 'powerpoint',
      ppt: 'powerpoint',
      pdf: 'pdf',
    };

    function downloadOfficeApp(name) {
      var dot = String(name || '').lastIndexOf('.');
      if (dot < 0) return null;
      return DOWNLOAD_OFFICE_APP_BY_EXT[String(name).slice(dot + 1).toLowerCase()] || null;
    }

    /* 부모(데스크톱 셸)에 메시지 1건을 보낸다. 셸 안에 있을 때만
       성공(true) — 단독 실행이면 false를 돌려 호출자가 폴백한다. */
    function postToParentMsg(msg) {
      var w = appWin;
      if (!w || !w.parent || w.parent === w) return false;
      try {
        w.parent.postMessage(msg, w.location.origin);
        return true;
      } catch (err) {
        console.warn('[browser] 부모 통신 실패 (무시):', err);
        return false;
      }
    }

    /* 다운로드 클릭: 오피스 파일은 해당 앱으로 직접 열고, 그 밖은
       Finder 창을 연다 (셸에 myhub:open-in-app / myhub:open-module —
       Finder 더블클릭·앱 열기와 같은 계약). 단독 실행(부모 없음)에서는
       콘텐츠 URL로 내려받는다. */
    function openDownload(f) {
      if (!f || typeof f.id !== 'number') return;
      var app = downloadOfficeApp(f.filename);
      if (
        app &&
        postToParentMsg({
          type: 'myhub:open-in-app',
          app: app,
          fileId: f.id,
          name: f.filename || '',
          mime: f.mime || '',
          version: f.version || null,
          folderId: DOWNLOADS_FOLDER_ID,
          folderName: '다운로드',
        })
      ) {
        return;
      }
      // 비오피스 파일은 파인더에서 해당 파일까지 이동해 연다 (셸이
      // myhub:open-file-in-finder를 받아 파인더에 open-file을 중계한다).
      if (
        postToParentMsg({
          type: 'myhub:open-file-in-finder',
          fileId: f.id,
          name: f.filename || '',
          mime: f.mime || '',
          folderId: DOWNLOADS_FOLDER_ID,
          folderName: '다운로드',
        })
      ) {
        return;
      }
      var w = appWin;
      if (w && typeof w.open === 'function') {
        try {
          w.open('/api/drive/files/' + f.id + '/content', '_blank');
        } catch (err) {
          console.warn('[browser] 다운로드 열기 실패:', err);
        }
      }
    }

    function renderSidebarDownloads() {
      if (!sidebarDownloadsEl) return;
      sidebarDownloadsEl.textContent = '';
      downloadItems.forEach(function (f) {
        var item = doc.createElement('button');
        item.type = 'button';
        item.className = 'bw-side-item';
        var fav = doc.createElement('span');
        fav.className = 'bw-side-fav bw-fav-default';
        fav.textContent = (f.filename || '?').charAt(0).toUpperCase();
        item.appendChild(fav);
        var name = doc.createElement('span');
        name.className = 'bw-side-name';
        name.textContent = f.filename || '이름 없음';
        item.appendChild(name);
        var meta = doc.createElement('span');
        meta.className = 'bw-side-meta';
        var size = formatFileSize(f.size);
        var when = formatDownloadTime(f.created_at);
        meta.textContent = [size, when].filter(Boolean).join(' · ');
        item.appendChild(meta);
        item.addEventListener('click', function () {
          setSidebar(false);
          openDownload(f);
        });
        sidebarDownloadsEl.appendChild(item);
      });
      if (!sidebarDownloadsEl.hasChildNodes()) {
        var empty = doc.createElement('div');
        empty.className = 'bw-sidebar-empty';
        empty.textContent = '아직 다운로드한 파일이 없어요';
        sidebarDownloadsEl.appendChild(empty);
      }
      refreshIcons();
    }

    /* 알려진 호스트는 예전 하드코딩 타일 색을 그대로 쓴다 (그 외는 중립 회색). */
    var FAV_TILE_CLASS = {
      'naver.com': 'bw-fav-naver',
      'google.com': 'bw-fav-google',
      'youtube.com': 'bw-fav-youtube',
      'chatgpt.com': 'bw-fav-gpt',
      'github.com': 'bw-fav-github',
      'ko.wikipedia.org': 'bw-fav-wiki',
    };

    function favTileClass(url) {
      return FAV_TILE_CLASS[hostOf(url || '')] || 'bw-fav-default';
    }

    function favLetter(b) {
      var name = (b.title || '').trim() || hostOf(b.url);
      return name.charAt(0).toUpperCase();
    }

    function favDisplayName(b) {
      return (b.title || '').trim() || hostOf(b.url);
    }

    /* 시작 페이지 타일: pinned 북마크만. 편집 모드에서는 삭제 배지·
       추가 타일이 보이고, 타일 클릭은 이름 편집 폼을 연다. 평소에는
       지금과 동일하게 깔끔하게 (편집 UI 없음). */
    function renderFavs() {
      if (!favsEl) return;
      favsEl.textContent = '';
      bookmarks
        .filter(function (b) {
          return b.pinned;
        })
        .forEach(function (b) {
          var btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'bw-fav' + (favEditMode ? ' is-editing' : '');
          btn.setAttribute('data-url', b.url);
          btn.setAttribute('data-bookmark-id', String(b.id));
          var tile = doc.createElement('span');
          tile.className = 'bw-fav-tile ' + favTileClass(b.url);
          tile.textContent = favLetter(b);
          btn.appendChild(tile);
          var name = doc.createElement('span');
          name.className = 'bw-fav-name';
          name.textContent = favDisplayName(b);
          btn.appendChild(name);
          if (favEditMode) {
            var del = doc.createElement('span');
            del.className = 'bw-fav-del';
            del.setAttribute('role', 'button');
            del.setAttribute('aria-label', '북마크 삭제');
            del.innerHTML = '<i data-lucide="x"></i>';
            del.addEventListener('click', function (ev) {
              ev.stopPropagation();
              deleteBookmark(b.id);
            });
            btn.appendChild(del);
          }
          btn.addEventListener('click', function () {
            if (favEditMode) {
              openFavForm(b);
            } else {
              go(b.url);
            }
          });
          favsEl.appendChild(btn);
        });
      if (favEditMode) {
        var add = doc.createElement('button');
        add.type = 'button';
        add.className = 'bw-fav bw-fav-add';
        add.setAttribute('aria-label', '북마크 추가');
        var addTile = doc.createElement('span');
        addTile.className = 'bw-fav-tile bw-fav-add-tile';
        addTile.innerHTML = '<i data-lucide="plus"></i>';
        add.appendChild(addTile);
        var addName = doc.createElement('span');
        addName.className = 'bw-fav-name';
        addName.textContent = '추가';
        add.appendChild(addName);
        add.addEventListener('click', function () {
          openFavForm(null);
        });
        favsEl.appendChild(add);
      }
      if (favsEditBtn) favsEditBtn.textContent = favEditMode ? '완료' : '편집';
      refreshIcons();
    }

    function setFavEditMode(on) {
      favEditMode = !!on;
      if (!favEditMode) closeFavForm();
      renderFavs();
    }

    function openFavForm(b) {
      if (!favFormEl) return;
      favEditId = b ? b.id : null;
      if (favUrlInput) {
        favUrlInput.value = b ? b.url : '';
        // 편집은 이름만 바꾼다 — URL은 북마크의 식별자라 PATCH 대상이 아니다.
        favUrlInput.disabled = !!b;
      }
      if (favTitleInput) favTitleInput.value = b && b.title ? b.title : '';
      if (favFormMsg) favFormMsg.hidden = true;
      if (favSaveBtn) favSaveBtn.textContent = b ? '저장' : '추가';
      favFormEl.hidden = false;
      if (favUrlInput && !b) favUrlInput.focus();
      else if (favTitleInput) favTitleInput.focus();
    }

    function closeFavForm() {
      if (!favFormEl) return;
      favFormEl.hidden = true;
      favEditId = null;
      if (favFormMsg) favFormMsg.hidden = true;
    }

    function favFormError(msg) {
      if (!favFormMsg) return;
      favFormMsg.textContent = msg;
      favFormMsg.hidden = false;
    }

    function saveFavForm() {
      var urlRaw = favUrlInput ? favUrlInput.value.trim() : '';
      var title = favTitleInput ? favTitleInput.value.trim() : '';
      var done = function (res) {
        if (!res || !res.ok) {
          favFormError('저장하지 못했어요. 주소를 확인하세요.');
          return;
        }
        closeFavForm();
        loadBookmarks();
      };
      if (favEditId) {
        apiFetch('/api/browse/bookmarks/' + favEditId, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: title || null }),
        }).then(done);
        return;
      }
      if (!urlRaw) {
        favFormError('주소를 입력하세요.');
        return;
      }
      var url = urlRaw;
      if (!/^https?:\/\//i.test(url)) {
        // 도메인만 치면 https를 붙인다 (주소창 normalizeInput과 같은 판정).
        if (!/\s/.test(url) && /^[^\s]+\.[a-z]{2,}([/?#].*)?$/i.test(url)) {
          url = 'https://' + url;
        } else {
          favFormError('올바른 주소를 입력하세요 (예: https://example.com).');
          return;
        }
      }
      apiFetch('/api/browse/bookmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 시작 페이지에서 추가하는 건 타일이므로 pinned으로 넣는다.
        body: JSON.stringify({ url: url, title: title || null, pinned: true }),
      }).then(done);
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

    // ---------- 창 바 내비 게시 (myhub:browser-nav 채널) ----------
    // 상태 서명이 바뀔 때만 게시한다 (notifyDocTitle와 같은 방식).
    // 셸은 이 상태로 제목 바에 사이드바·뒤로/앞으로·주소 캡슐·공유·
    // 새 탭·탭 개요를 그리고, 명령은 myhub:browser-nav-action으로
    // 돌려보낸다. 탭 줄은 iframe 안에 남으므로 탭 목록은 게시하지 않는다.
    var toolbarHosted = false;
    var navLoading = false;
    var lastNavSig; // undefined = 아직 게시 전 값
    function browserNavPayload() {
      var tab = activeTab();
      var caps = navCaps(tab);
      return {
        url: tab && tab.url ? tab.url : '',
        title: tabTitle(tab),
        fav: tab && tab.url ? hostOf(tab.url).charAt(0).toUpperCase() : '',
        canBack: caps.canBack,
        canFwd: caps.canFwd,
        loading: navLoading,
      };
    }
    function postBrowserNav(force) {
      if (!appWin || !appWin.parent || appWin.parent === appWin) return;
      var payload = browserNavPayload();
      var sig = JSON.stringify(payload);
      if (!force && sig === lastNavSig) return;
      lastNavSig = sig;
      try {
        appWin.parent.postMessage(
          Object.assign({ type: 'myhub:browser-nav' }, payload),
          appWin.location.origin,
        );
      } catch (err) {
        // 부모 통신 실패는 무시한다 (내비 표시는 다음 게시 때 갱신된다)
        console.warn('[browser] 창 바 내비 게시 실패 (무시):', err);
      }
    }
    // 빈 탭 포커스 요청 (2026-11-20 QA 결함: 새 탭 직후 키 입력이
    // 주소창에 안 들어감). 셸 + 버튼의 일회성 플래그 방식은 ① 연속
    // 빈 탭이면 상태 서명이 같아 게시 자체가 안 되고 ② 메뉴 등 +
    // 버튼이 아닌 경로에는 플래그가 없어서 포커스가 안 됐다. 상태
    // 게시와 별도 메시지라 서명 중복에 안 걸리고, 모든 newTab·
    // 빈 탭 전환 경로에서 나간다. 호스팅 모드에서만 보낸다 — 단독
    // 모드에서는 iframe 주소창이 보이고 newTab이 직접 포커스한다.
    // syncChrome 뒤에 보내므로 상태 게시가 먼저 도착하고, 상태가
    // 중복돼 게시가 안 된 경우에도 셸 상태는 이미 빈 탭과 같다.
    function postNavFocus() {
      if (!toolbarHosted) return;
      if (!appWin || !appWin.parent || appWin.parent === appWin) return;
      try {
        appWin.parent.postMessage(
          { type: 'myhub:browser-nav-focus' },
          appWin.location.origin,
        );
      } catch (err) {
        // 부모 통신 실패는 무시한다 (다음 탭 전환 때 다시 요청된다)
        console.warn('[browser] 창 바 포커스 요청 실패 (무시):', err);
      }
    }
    function setNavLoading(value) {
      if (navLoading === value) return;
      navLoading = value;
      postBrowserNav(false);
    }
    // 창 모드(호스팅)에서는 셸 제목 바가 내비를 대신하므로 iframe
    // 툴바를 숨긴다. 탭 줄은 양쪽 모드 모두 iframe이 담당한다.
    function applyToolbarHosting() {
      if (toolbarEl) toolbarEl.hidden = toolbarHosted;
    }
    // 탭이 1개 이하일 때 탭 줄을 숨긴다. 사파리는 탭이 하나면 탭 줄
    // 자체가 없고 주소 캡슐만 있다 (2026-11-14 실제 맥 캡처 image-46 대조).
    function applyTabstripVisibility() {
      if (tabstripEl) {
        tabstripEl.hidden = tabs.length <= 1 && pinnedCount() === 0;
      }
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

    // 파비콘 이미지 + 첫 글자 폴백 (2026-11-20 3단계). <img>가 로딩에
    // 실패하면(404·차단) 기존 첫 글자 타일로 바꾼다 — 빈 타일이 남지
    // 않는다. URL이 없으면 지구본 아이콘이다.
    function makeFavEl(url, favClass, fallbackLetter) {
      var fav = doc.createElement('span');
      fav.className = favClass;
      if (!url) {
        fav.innerHTML = '<i data-lucide="globe"></i>';
        return fav;
      }
      var img = doc.createElement('img');
      img.src = '/api/browse/favicon?url=' + encodeURIComponent(url);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        // 폴백 글자: 북마크는 제목 첫 글자(예: '네'), 그 외는 호스트 첫 글자.
        var letter = fallbackLetter || hostOf(url);
        fav.textContent = letter.charAt(0).toUpperCase();
      });
      fav.appendChild(img);
      return fav;
    }

    function pinnedCount() {
      var n = 0;
      tabs.forEach(function (t) {
        if (t.pinned) n++;
      });
      return n;
    }

    // 탭 순서 변경 (드래그 확정). toIndex는 드래그 중인 탭을 뺀 나머지
    // 탭들 기준의 삽입 위치다. 고정 탭은 고정 구역 안에서만, 일반
    // 탭은 일반 구역 안에서만 움직인다 — 구역이 섞이면 고정 의미가 없다.
    function moveTab(id, toIndex) {
      var from = -1;
      tabs.forEach(function (t, i) {
        if (t.id === id) from = i;
      });
      if (from < 0) return;
      var tab = tabs[from];
      var count = pinnedCount();
      var min = tab.pinned ? 0 : count;
      var max = tab.pinned ? count - 1 : tabs.length - 1;
      var to = Math.max(min, Math.min(max, toIndex));
      if (to === from) return;
      tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
      saveTabs();
      syncChrome();
    }

    function setPinned(id, pinned) {
      var idx = -1;
      tabs.forEach(function (t, i) {
        if (t.id === id) idx = i;
      });
      if (idx < 0) return;
      var tab = tabs[idx];
      if (!!tab.pinned === !!pinned) return;
      tab.pinned = !!pinned;
      tabs.splice(idx, 1);
      // 고정하면 고정 구역 끝, 해제하면 일반 구역 맨 앞(고정 구역 바로 뒤).
      tabs.splice(pinnedCount(), 0, tab);
      saveTabs();
      syncChrome();
    }

    function duplicateTab(id) {
      var idx = -1;
      tabs.forEach(function (t, i) {
        if (t.id === id) idx = i;
      });
      if (idx < 0) return;
      var src = tabs[idx];
      var tab = makeTab(src.url);
      tab.history = src.history.slice();
      tab.hIndex = src.hIndex;
      tab.title = src.title;
      // 복제본은 고정하지 않는다 — 고정 탭을 복제하면 고정 구역이 늘어난다.
      tabs.splice(idx + 1, 0, tab);
      activeTabId = tab.id;
      saveTabs();
      syncChrome();
    }

    // ---- 탭 우클릭 메뉴 (Finder openCtxMenu와 같은 모양) ----
    var tabCtxEl = null;
    function closeTabCtxMenu() {
      if (tabCtxEl && tabCtxEl.parentNode) tabCtxEl.parentNode.removeChild(tabCtxEl);
      tabCtxEl = null;
    }
    function openTabCtxMenu(tab, x, y) {
      closeTabCtxMenu();
      var menu = doc.createElement('div');
      menu.className = 'bw-tab-ctx';
      menu.setAttribute('role', 'menu');
      var items = [
        {
          label: tab.pinned ? '고정 해제' : '고정',
          run: function () {
            setPinned(tab.id, !tab.pinned);
          },
        },
        {
          label: '탭 복제',
          run: function () {
            duplicateTab(tab.id);
          },
        },
        {
          label: '탭 닫기',
          run: function () {
            closeTab(tab.id);
          },
        },
      ];
      items.forEach(function (it) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'bw-tab-ctx-item';
        b.textContent = it.label;
        b.addEventListener('click', function () {
          closeTabCtxMenu();
          it.run();
        });
        menu.appendChild(b);
      });
      doc.body.appendChild(menu);
      var mw = menu.offsetWidth || 180;
      var mh = menu.offsetHeight || 120;
      var vw = doc.documentElement.clientWidth || 1024;
      var vh = doc.documentElement.clientHeight || 768;
      menu.style.left = Math.max(4, Math.min(x, vw - mw - 6)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, vh - mh - 6)) + 'px';
      tabCtxEl = menu;
    }

    // 탭 드래그 임계값 (독의 drag-out 26px보다 작다 — 탭 줄에서는
    // 가벼운 움직임에도 순서 변경이 시작돼야 한다).
    var TAB_DRAG_THRESHOLD = 6;
    // 드래그 직후 따라오는 클릭 1회 억제 플래그. 탭 요소별 클로저가
    // 아니라 모듈 수준이어야 한다 — moveTab이 renderTabs를 다시 돌려
    // 요소를 전부 갈아버리므로, 요소별 플래그는 드롭과 함께 사라져
    // 억제가 안 먹힌다 (2026-11-20 테스트가 잡은 결함). 다음
    // pointerdown에서 소멸하므로 클릭이 안 왔어도 낡은 플래그가
    // 다음 진짜 클릭을 삼키지 않는다.
    var suppressTabClick = false;

    function renderTabs() {
      if (!tabsEl) return;
      tabsEl.innerHTML = '';
      tabs.forEach(function (tab) {
        var el = doc.createElement('button');
        el.type = 'button';
        el.className =
          'bw-tab' +
          (tab.id === activeTabId ? ' is-active' : '') +
          (tab.pinned ? ' is-pinned' : '');
        el.setAttribute('role', 'tab');
        el.setAttribute(
          'aria-selected',
          tab.id === activeTabId ? 'true' : 'false',
        );
        if (tab.pinned) el.setAttribute('title', tabTitle(tab));
        el.appendChild(makeFavEl(tab.url, 'bw-tab-fav'));
        if (!tab.pinned) {
          var name = doc.createElement('span');
          name.className = 'bw-tab-name';
          name.textContent = tabTitle(tab);
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
        }
        // ---- 드래그 순서 변경 (독 dock.js와 같은 포인터 패턴) ----
        // move 중에는 잡은 탭만 transform으로 따라오고, 형제 탭은
        // 건드리지 않는다 (줄이 어지럽지 않게). 순서는 pointerup 때
        // 한 번에 확정한다.
        var drag = null;
        function tabInsertionIndex(clientX) {
          var els = Array.prototype.slice.call(tabsEl.querySelectorAll('.bw-tab'));
          var others = els.filter(function (b) {
            return b !== el;
          });
          var n = 0;
          others.forEach(function (b) {
            var r = b.getBoundingClientRect();
            if (r && clientX > r.left + r.width / 2) n++;
          });
          return n;
        }
        function endTabDrag(commit) {
          if (!drag) return;
          var wasActive = drag.active;
          var lastX = drag.lastX;
          drag = null;
          el.style.transform = '';
          el.classList.remove('is-dragging');
          if (wasActive) {
            suppressTabClick = true;
            if (commit) moveTab(tab.id, tabInsertionIndex(lastX));
          }
        }
        el.addEventListener('pointerdown', function (e) {
          if (e.button !== undefined && e.button !== 0) return;
          // 새 누름이 오면 이전 드래그의 억제 플래그는 소멸한다 —
          // 따라오는 클릭이 없었다는 뜻이므로, 다음 진짜 클릭을
          // 삼키면 안 된다.
          suppressTabClick = false;
          // 닫기 버튼을 누른 건 드래그가 아니다 — 여기서 캡처를 걸면
          // pointerup이 탭 버튼으로 다시 겨냥돼 click 타깃이 닫기
          // span이 아니라 탭 버튼이 되고, 닫기 리스너가 안 뜬 채 탭만
          // 활성화된다 (사용자 보고 2026-11-20, 실브라우저 재현).
          // 드래그 추적·캡처를 건너뛰면 click이 span에 그대로 닿는다.
          if (e.target && e.target.closest && e.target.closest('.bw-tab-close')) {
            return;
          }
          drag = {
            pointerId: e.pointerId,
            startX: e.clientX,
            dx: 0,
            active: false,
            lastX: e.clientX,
          };
          try {
            if (typeof el.setPointerCapture === 'function' && e.pointerId !== undefined) {
              el.setPointerCapture(e.pointerId);
            }
          } catch (err) {
            console.warn('[browser] 탭 포인터 캡처 실패:', err);
          }
        });
        el.addEventListener('pointermove', function (e) {
          if (
            !drag ||
            (drag.pointerId !== undefined &&
              e.pointerId !== undefined &&
              e.pointerId !== drag.pointerId)
          ) {
            return;
          }
          drag.dx = e.clientX - drag.startX;
          drag.lastX = e.clientX;
          if (!drag.active && Math.abs(drag.dx) > TAB_DRAG_THRESHOLD) {
            drag.active = true;
            el.classList.add('is-dragging');
          }
          if (drag.active) el.style.transform = 'translateX(' + drag.dx + 'px)';
        });
        el.addEventListener('pointerup', function () {
          endTabDrag(true);
        });
        el.addEventListener('pointercancel', function () {
          endTabDrag(false);
        });
        el.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          openTabCtxMenu(tab, e.clientX, e.clientY);
        });
        el.addEventListener('click', function () {
          if (suppressTabClick) {
            suppressTabClick = false;
            return;
          }
          activateTab(tab.id);
        });
        tabsEl.appendChild(el);
      });
      // 오버플로 규칙: 탭이 스트립 너비를 넘으면 목록 버튼을 보인다
      if (tabsOverflowBtn) {
        tabsOverflowBtn.hidden = !(tabsEl.scrollWidth > tabsEl.clientWidth + 1);
      }
      refreshIcons();
      // 탭 개수가 바뀌면 탭 줄 표시도 다시 정한다 (1개면 숨김 — 단,
      // 고정 탭이 있으면 1개여도 보인다. 안 그러면 고정 탭에 닿을
      // 방법이 탭 줄에서 사라진다).
      applyTabstripVisibility();
    }

    function syncNavButtons() {
      var tab = activeTab();
      var caps = navCaps(tab);
      if (backBtn) backBtn.disabled = !caps.canBack;
      if (fwdBtn) {
        fwdBtn.disabled = !caps.canFwd;
      }
      if (reloadBtn) {
        reloadBtn.disabled = !(tab && tab.url);
      }
      if (shareBtn) shareBtn.disabled = !(tab && tab.url);
    }

    function syncChrome() {
      var state = live.state();
      var on = state === 'on';
      var busy = on || state === 'notice' || state === 'locked';
      var mine = liveTabId !== null && liveTabId === activeTabId;
      live.syncChrome();
      // 라이브 소유 요소(화면·안내 카드·잠금 카드)는 뷰를 소유한 탭에서만
      // 보인다 — 다른 탭에서는 실행 중인 것처럼 보이지 않게 가린다.
      // 단, iframe은 display:none(hidden)이 아니라 visibility:hidden
      // 으로 숨긴다. display:none은 iframe 문서를 hidden으로 만들어
      // Selkies 클라이언트가 스트림을 멈추고, 돌아올 때 재연결·
      // 재동기화 갭이 생긴다 (2026-11-14 전환 시 끊김 보고).
      // visibility:hidden은 문서를 살려 둬 복귀가 즉시 된다.
      if (!mine && busy) {
        if (liveFrame) liveFrame.classList.add('bw-frame-parked');
        if (noticeEl) noticeEl.hidden = true;
        if (lockEl) lockEl.hidden = true;
      } else if (liveFrame) {
        liveFrame.classList.remove('bw-frame-parked');
      }
      if (home) home.hidden = mine && (on || state === 'locked');
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
      postBrowserNav(false);
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
      // 원격 탭이면 뷰 소유권을 옮기고 원격을 앞으로 불러온다 — 로컬
      // 탭은 기존처럼 뷰를 두지 않는다 (다른 탭 실행 중 안내).
      var tab = activeTab();
      if (tab && tab.remoteTargetId && live.isActive()) {
        liveTabId = id;
        activateRemoteTab(tab.remoteTargetId);
      }
      saveTabs();
      syncChrome();
      // 빈 탭으로 전환되면 셸 주소창에 포커스를 요청한다 — 빈 탭
      // 선택 직후 타이핑이 주소창에 안 들어가던 QA 결함 (activateTab
      // 은 어떤 경로로도 포커스를 요청하지 않았다). URL 탭은 요청
      // 하지 않는다 (페이지와 상호작용하는 쪽이 자연스럽다).
      if (tab && !tab.url) postNavFocus();
    }

    function newTab() {
      var tab = makeTab(null);
      tabs.push(tab);
      activeTabId = tab.id;
      saveTabs();
      syncChrome();
      if (urlInput) {
        // 새 탭은 빈 주소창부터 시작한다 (사파리 동작). syncChrome이
        // 값을 비우긴 하지만, 주소창에 이미 포커스가 있으면(메뉴·
        // 단축키로 새 탭을 열 때) 값을 건드리지 않으므로 여기서
        // 명시적으로 비운다 — 이전 탭 URL이 남아 있으면 안 된다.
        urlInput.value = '';
        urlInput.focus();
        urlInput.select();
      }
      // 호스팅 모드에서는 셸 주소창이 진짜 주소창이다 — iframe
      // 주소창 포커스는 툴바가 숨겨져 있어 안 먹히므로 셸에
      // 명시적으로 요청한다 (메뉴·셸 + 버튼 모든 경로).
      postNavFocus();
    }

    function closeTab(id) {
      var idx = -1;
      tabs.forEach(function (t, i) {
        if (t.id === id) idx = i;
      });
      if (idx < 0) return;
      var tab = tabs[idx];
      // 원격 팝업 탭이면 원격도 닫는다 (메인 타깃은 닫지 않는다 — 영구 브라우저).
      var isPopup = !!(tab.remoteTargetId && tab.remoteTargetId !== mainTargetId);
      if (isPopup && live.isActive()) closeRemoteTab(tab.remoteTargetId);
      // 뷰를 소유한 탭을 접으면 뷰를 이웃 탭으로 옮긴다 — 팝업 탭이면
      // 메인 탭으로, 메인 탭이면 원격에 묶인 이웃 탭으로 (팝업을 닫고
      // 원래 페이지로 돌아가는 것이 자연스럽다). 이웃이 없을 때만
      // 뷰를 끈다. 옛 코드는 팝업 탭 닫기에만 폴백이 있어, 라이브인
      // 메인 탭을 닫으면 뉴스 탭이 남아 있어도 화면이 통째로 꺼졌다
      // (2026-11-21 사용자 보고 — jsdom 시퀀스 3 재현).
      if (id === liveTabId && live.isActive()) {
        var fallback = null;
        tabs.forEach(function (t) {
          // remoteTargetId가 null인 탭은 제외한다 — mainTargetId도
          // 아직 null(상태 폴링 전)이면 null === null이 되어 묶이지
          // 않은 빈 탭을 폴백으로 잡아버린다 (2026-11-21 jest 1건
          // 실패로 발견: 빈 탭 포커스 요청이 안 나갔다).
          if (t.id !== id && t.remoteTargetId && t.remoteTargetId === mainTargetId) fallback = t;
        });
        if (!fallback) {
          tabs.forEach(function (t) {
            if (t.id !== id && t.remoteTargetId) fallback = t;
          });
        }
        if (fallback) {
          liveTabId = fallback.id;
          activeTabId = fallback.id;
          activateRemoteTab(fallback.remoteTargetId);
        } else {
          live.endLive();
        }
      }
      tabs.splice(idx, 1);
      if (!tabs.length) tabs.push(makeTab(null));
      var wasActive = activeTabId === id;
      if (wasActive) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
      }
      saveTabs();
      syncChrome();
      // 닫힌 탭이 활성 탭이었고 이웃이 빈 탭이면 셸 주소창에 포커스를
      // 요청한다 — closeTab은 activateTab을 거치지 않아 빈 탭으로
      // 넘어가도 포커스 요청이 없었다 (새 탭 포커스 결함과 같은 구멍).
      if (wasActive) {
        var next = null;
        tabs.forEach(function (t) {
          if (t.id === activeTabId) next = t;
        });
        if (next && !next.url) postNavFocus();
      }
    }

    /* 이 탭에서 원격 뷰 시작: 소유권을 활성 탭으로 먼저 못 박는다.
       다른 탭이 실행 중일 때의 시작 시도도 여기에 걸리도록
       소유권을 가로채지 않는다 (안내 버튼들의 시작을 방지). */
    function enterLiveHere(url) {
      if (!live.isActive() || liveTabId === activeTabId) {
        liveTabId = activeTabId;
      }
      // 원격 탭에서 다시 켤 때는 그 타깃을 먼저 앞으로 불러온 뒤 이동한다
      // (안 그러면 이동이 지금 보이는 다른 탭에 가버린다).
      var tab = activeTab();
      // 이동 대상은 조작 중인 활성 탭의 타깃으로 명시한다 — 서버가
      // 활성 탭으로만 가면 뉴스 팝업이 떠 있을 때 엉뚱한 탭을
      // 덮어버린다 (2026-11-21 사용자 보고: 뉴스 탭이 naver.com으로
      // 재이동됨, CDP 내역으로 확정).
      var targetId = tab && tab.remoteTargetId ? tab.remoteTargetId : null;
      if (tab && tab.remoteTargetId && !live.isActive()) {
        return activateRemoteTab(tab.remoteTargetId).then(function () {
          return live.enterLive(url, targetId);
        });
      }
      return live.enterLive(url, targetId);
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
        if (tab.url !== url) {
          tab.url = url;
          // 새 페이지의 제목은 폴링이 채울 때까지 모른다 — 낡은 제목을 지운다.
          tab.title = null;
        }
        saveTabs();
      }
      startAndRecord(url);
      // 이동 즉시 탭 줄·내비 버튼·창 바 내비 상태를 맞춘다.
      // live가 이미 켜져 있으면 enterLive가 onChange를 부르지 않아
      // 이 호출 없이는 탭 제목이 이전 주소로 남는다.
      syncChrome();
    }

    /* 로컬 기록 뒤로/앞으로 (라이브가 꺼져 있을 때만 쓴다). 원격 내
       이동은 이 기록에 없으므로, 라이브가 켜져 있을 때는 이 폴백을
       쓰지 않는다 — 낡은 URL로 이동하고 go()→navigate가 다른 탭을
       닫아버린다 (2026-11-16 QA 1차). */
    function goBackLocal() {
      var tab = activeTab();
      if (!tab || tab.hIndex <= 0) return;
      tab.hIndex -= 1;
      tab.url = tab.history[tab.hIndex];
      tab.title = null;
      saveTabs();
      go(tab.url, true);
    }

    function goFwdLocal() {
      var tab = activeTab();
      if (!tab || tab.hIndex >= tab.history.length - 1) return;
      tab.hIndex += 1;
      tab.url = tab.history[tab.hIndex];
      tab.title = null;
      saveTabs();
      go(tab.url, true);
    }

    /* 뒤로: 라이브가 켜져 있고 이 탭이 뷰 소유 탭이면 원격 이동만
       시도한다 (원격 내 링크 이동은 로컬 기록에 없다). 원격 상태를
       모르거나 뒤로 갈 수 없으면 아무것도 하지 않는다 — 로컬 폴백은
       낡은 URL로 가고 go()→navigate가 다른 탭을 닫아버린다
       (2026-11-16 QA 1차). 원격 이동이 성공하면 상태를 즉시 다시 물어
       주소창을 빨리 맞춘다. 실패해도 폴백하지 않는다. 로컬 폴백은
       라이브가 꺼져 있을 때만.
       로딩 표시 (2026-11-17 N2): 원격 뒤로/앞으로 이동은 스트림
       프레임 전달까지 10초 안팎이 걸리는데 그동안 피드백이 전혀 없어
       버튼이 안 먹힌 것으로 보였다. 이동 시작 시 로딩을 켜고, 상태
       재조회가 끝날 때 끈다 (실패해도 끈다 — 로딩이 영영 남지 않게). */
    function goBack() {
      var tab = activeTab();
      if (!tab) return;
      if (tab.id === liveTabId && live.isActive()) {
        if (tab.remote && tab.remote.canBack) {
          setNavLoading(true);
          live.goBack().then(function (ok) {
            if (ok) return live.refreshState();
            return null;
          }).then(
            function () { setNavLoading(false); },
            function () { setNavLoading(false); },
          );
        }
        return;
      }
      goBackLocal();
    }

    function goFwd() {
      var tab = activeTab();
      if (!tab) return;
      if (tab.id === liveTabId && live.isActive()) {
        if (tab.remote && tab.remote.canFwd) {
          setNavLoading(true);
          live.goForward().then(function (ok) {
            if (ok) return live.refreshState();
            return null;
          }).then(
            function () { setNavLoading(false); },
            function () { setNavLoading(false); },
          );
        }
        return;
      }
      goFwdLocal();
    }

    /* 새로고침 (2026-11-20 4단계): 라이브가 켜져 있으면 CDP
       Page.reload로 진짜 새로고침한다. 같은 URL로 다시 이동하는 옛
       방식은 스크롤을 맨 위로 되돌린다 (실측). reload가 실패하면
       재이동으로 조용히 폴백하지 않고 안내 카드로 알린다. 라이브가
       꺼져 있을 때는 시작하면서 이동하는 수밖에 없어 go()로 간다. */
    function reloadPage() {
      var tab = activeTab();
      if (!tab || !tab.url) return;
      if (tab.id === liveTabId && live.isActive()) {
        setNavLoading(true);
        live.reload().then(function (ok) {
          if (ok) return live.refreshState();
          console.warn('[browser] 새로고침 실패: 원격 페이지 reload가 안 됐다');
          live.showNotice('페이지를 새로고침하지 못했어요. 잠시 후 다시 시도해 주세요.');
          return null;
        }).then(
          function () { setNavLoading(false); },
          function () { setNavLoading(false); },
        );
        return;
      }
      go(tab.url, true);
    }

    /* 화질 선택 (2026-11-20 4단계): 메뉴에서 고른 값을 live에
       넘긴다. live가 POST 성공 시 localStorage에 저장하고, 다음
       시작 때 다시 적용한다. 실패하면 안내 카드로 알린다 (조용한
       실패 금지). 라이브가 꺼져 있어도 선택은 저장된다 — 시작 시
       재적용된다. */
    function applyQuality(mode) {
      live.setQuality(mode).then(function (ok) {
        if (ok) return;
        console.warn('[browser] 화질 전환 실패:', mode);
        live.showNotice('화질을 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
      });
    }

    /* 페이지 내 찾기 (2026-11-20 5단계): Worker /find가 사이드카에
       중계하고, 사이드카가 활성 화면 WS 연결에 Selkies 키 메시지
       Ctrl+F를 주입해 원격 Chromium의 네이티브 찾기 막대를 연다.
       CDP 키 이벤트로는 브라우저 단축키가 안 열린다 (실브라우저 3방
       실측 — 2단계 CDP 구현을 되돌린 이유). 셸 단축키(Ctrl+F)는
       라이브 iframe에 포커스가 있을 때 셸까지 안 오므로 메뉴 클릭이
       정본 경로다. 실패하면 안내 카드로 알린다 (조용한 실패 금지). */
    function openFind() {
      if (!live.isActive()) return;
      apiFetch('/api/browse/find', { method: 'POST' })
        .then(function (res) {
          if (!res || !res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (data && data.ok) return;
          console.warn(
            '[browser] 페이지 찾기 실패:',
            data && data.error ? data.error : 'no response',
          );
          live.showNotice('페이지 내 찾기를 열 수 없어요. 잠시 후 다시 시도해 주세요.');
        })
        .catch(function (err) {
          console.warn('[browser] 페이지 찾기 요청 실패:', err);
          live.showNotice('페이지 내 찾기를 열 수 없어요. 잠시 후 다시 시도해 주세요.');
        });
    }

    function startAndRecord(url) {
      setNavLoading(true);
      Promise.resolve(enterLiveHere(url)).then(
        function (started) {
          if (started) {
            if (url && storage) saveRecent(storage, url);
            if (url) recordHistory(url);
            renderRecents();
          }
          setNavLoading(false);
        },
        function (err) {
          setNavLoading(false);
          throw err;
        },
      );
    }

    function submitInput() {
      var url = normalizeInput(urlInput ? urlInput.value : '');
      if (!url) return;
      go(url);
      if (urlInput) urlInput.blur();
    }

    // ---------- 시작 페이지로 (예전 홈 버튼 동작) ----------
    // 툴바 홈 버튼은 2026-11-14 타이틀바 한 줄 통일로 빠졌으나
    // (새 탭이 시작 페이지 역할을 한다), 메뉴 명령으로는 남긴다.
    function goHome() {
      // 활성 탭이 뷰를 소유한 때만 종료하고, 다른 탭의 뷰는 건드리지 않는다
      if (liveTabId !== activeTabId) return;
      if (live.isActive()) live.endLive();
      else if (live.state() === 'notice') live.dismissNotice();
    }

    // ---------- 사이드바 (즐겨찾기·최근 방문·열린 탭) ----------
    // 열 때 렌더링한다 (즐겨찾기는 시작 페이지와 같은 버튼 데이터,
    // 최근 방문은 renderRecents와 같은 저장소 데이터).
    function sidebarOpen() {
      return !!(sidebarEl && !sidebarEl.hidden);
    }
    function makeSideFav(url) {
      return makeFavEl(url, 'bw-side-fav');
    }
    function renderSidebar() {
      if (sidebarFavsEl) {
        sidebarFavsEl.textContent = '';
        bookmarks.forEach(function (b) {
          var item = doc.createElement('button');
          item.type = 'button';
          item.className = 'bw-side-item';
          // 북마크도 진짜 파비콘을 쓴다 (타일 색·폴백 글자는 그대로).
          item.appendChild(
            makeFavEl(b.url, 'bw-side-fav ' + favTileClass(b.url), favLetter(b)),
          );
          var name = doc.createElement('span');
          name.className = 'bw-side-name';
          name.textContent = favDisplayName(b);
          item.appendChild(name);
          var del = doc.createElement('span');
          del.className = 'bw-side-del';
          del.setAttribute('role', 'button');
          del.setAttribute('aria-label', '북마크 삭제');
          del.innerHTML = '<i data-lucide="x"></i>';
          del.addEventListener('click', function (ev) {
            ev.stopPropagation();
            deleteBookmark(b.id);
          });
          item.appendChild(del);
          item.addEventListener('click', function () {
            setSidebar(false);
            go(b.url);
          });
          sidebarFavsEl.appendChild(item);
        });
        if (!sidebarFavsEl.hasChildNodes()) {
          var empty = doc.createElement('div');
          empty.className = 'bw-sidebar-empty';
          empty.textContent = '즐겨찾기가 없어요';
          sidebarFavsEl.appendChild(empty);
        }
      }
      // 사이드바의 "최근 방문"(localStorage 6개)은 "방문 기록"(D1, 검색 가능)과
      // 겹치므로 두지 않는다. 빠른 최근 방문은 시작 페이지·메뉴에 남아 있다.
      renderSidebarHistory();
      renderSidebarDownloads();
      if (sidebarTabsEl) {
        sidebarTabsEl.textContent = '';
        tabs.forEach(function (tab) {
          var item = doc.createElement('button');
          item.type = 'button';
          item.className =
            'bw-side-item' + (tab.id === activeTabId ? ' is-active' : '');
          item.appendChild(makeSideFav(tab.url));
          var name = doc.createElement('span');
          name.className = 'bw-side-name';
          name.textContent = tabTitle(tab);
          item.appendChild(name);
          if (tab.id === liveTabId && live.isActive()) {
            var dot = doc.createElement('span');
            dot.className = 'bw-side-live';
            item.appendChild(dot);
          }
          item.addEventListener('click', function () {
            setSidebar(false);
            activateTab(tab.id);
          });
          sidebarTabsEl.appendChild(item);
        });
      }
      refreshIcons();
    }
    function renderSidebarHistory() {
      if (!sidebarHistoryEl) return;
      sidebarHistoryEl.textContent = '';
      historyItems.forEach(function (h) {
        var item = doc.createElement('button');
        item.type = 'button';
        item.className = 'bw-side-item';
        item.appendChild(makeSideFav(h.url));
        var name = doc.createElement('span');
        name.className = 'bw-side-name';
        name.textContent = (h.title || '').trim() || hostOf(h.url);
        item.appendChild(name);
        item.addEventListener('click', function () {
          setSidebar(false);
          go(h.url);
        });
        sidebarHistoryEl.appendChild(item);
      });
      if (!sidebarHistoryEl.hasChildNodes()) {
        var empty = doc.createElement('div');
        empty.className = 'bw-sidebar-empty';
        empty.textContent = historyQuery ? '검색 결과가 없어요' : '방문 기록이 없어요';
        sidebarHistoryEl.appendChild(empty);
      }
      refreshIcons();
    }

    function setSidebar(open) {
      if (!sidebarEl || !sidebarBackdrop) return;
      if (open) {
        renderSidebar();
        // 열 때마다 기록·다운로드를 새로 가져온다 (다른 기기·탭에서
        // 쌓인 기록과 새로 받은 파일 반영).
        loadHistory();
        loadDownloads();
        setOverview(false);
      }
      sidebarEl.hidden = !open;
      sidebarBackdrop.hidden = !open;
    }
    function toggleSidebar() {
      setSidebar(!sidebarOpen());
    }

    // ---------- 탭 개요 (파비콘+제목 카드 그리드) ----------
    function overviewOpen() {
      return !!(overviewEl && !overviewEl.hidden);
    }
    // 개요 검색어 (2026-11-20 3단계): 제목·URL 부분 일치, 로컬 필터라
    // 디바운스 없이 입력 즉시 반영한다.
    var overviewQuery = '';
    function renderOverview() {
      if (!overviewGridEl) return;
      overviewGridEl.textContent = '';
      var q = overviewQuery.trim().toLowerCase();
      var shown = tabs.filter(function (tab) {
        if (!q) return true;
        var hay = (tabTitle(tab) + ' ' + (tab.url || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      });
      shown.forEach(function (tab) {
        var card = doc.createElement('button');
        card.type = 'button';
        card.className =
          'bw-ov-card' + (tab.id === activeTabId ? ' is-active' : '');
        card.appendChild(makeFavEl(tab.url, 'bw-ov-fav'));
        var name = doc.createElement('span');
        name.className = 'bw-ov-name';
        name.textContent = tabTitle(tab);
        card.appendChild(name);
        var urlEl = doc.createElement('span');
        urlEl.className = 'bw-ov-url';
        urlEl.textContent = tab.url ? hostOf(tab.url) : '새 탭';
        card.appendChild(urlEl);
        if (tab.id === liveTabId && live.isActive()) {
          var liveRow = doc.createElement('span');
          liveRow.className = 'bw-ov-live';
          liveRow.textContent = '실행 중';
          card.appendChild(liveRow);
        }
        var close = doc.createElement('span');
        close.className = 'bw-ov-close';
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', '탭 닫기');
        close.innerHTML = '<i data-lucide="x"></i>';
        close.addEventListener('click', function (ev) {
          ev.stopPropagation();
          closeTab(tab.id);
          // 개요는 열어 두고 남은 탭으로 다시 그린다.
          if (overviewOpen()) renderOverview();
        });
        card.appendChild(close);
        card.addEventListener('click', function () {
          setOverview(false);
          activateTab(tab.id);
        });
        overviewGridEl.appendChild(card);
      });
      if (!shown.length) {
        var empty = doc.createElement('div');
        empty.className = 'bw-overview-empty';
        empty.textContent = q ? '검색 결과가 없어요' : '열린 탭이 없어요';
        overviewGridEl.appendChild(empty);
      }
      refreshIcons();
    }
    function setOverview(open) {
      if (!overviewEl) return;
      if (open) {
        renderOverview();
        setSidebar(false);
      } else if (overviewQuery) {
        // 닫을 때 검색어를 비운다 — 다음에 열면 전체가 보인다.
        overviewQuery = '';
        if (overviewSearchInput) overviewSearchInput.value = '';
      }
      overviewEl.hidden = !open;
    }
    function toggleOverview() {
      setOverview(!overviewOpen());
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
      reloadBtn.addEventListener('click', reloadPage);
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
    if (favsEditBtn) {
      favsEditBtn.addEventListener('click', function () {
        setFavEditMode(!favEditMode);
      });
    }
    if (favSaveBtn) favSaveBtn.addEventListener('click', saveFavForm);
    if (favCancelBtn) favCancelBtn.addEventListener('click', closeFavForm);
    if (favFormEl) {
      favFormEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          saveFavForm();
        } else if (ev.key === 'Escape') {
          closeFavForm();
        }
      });
    }
    if (historySearchInput) {
      historySearchInput.addEventListener('input', function () {
        historyQuery = historySearchInput.value.trim();
        if (historySearchTimer) clearTimeout(historySearchTimer);
        // 키 입력마다 API를 부르지 않는다 — 200ms 멈추면 검색한다.
        historySearchTimer = setTimeout(function () {
          loadHistory(historyQuery);
        }, 200);
      });
    }
    if (historyClearBtn) {
      historyClearBtn.addEventListener('click', function () {
        apiFetch('/api/browse/history', { method: 'DELETE' }).then(function () {
          loadHistory();
        });
      });
    }
    if (sidebarBtn) sidebarBtn.addEventListener('click', toggleSidebar);
    if (overviewBtn) overviewBtn.addEventListener('click', toggleOverview);
    if (sidebarCloseBtn) {
      sidebarCloseBtn.addEventListener('click', function () {
        setSidebar(false);
      });
    }
    if (sidebarBackdrop) {
      sidebarBackdrop.addEventListener('click', function () {
        setSidebar(false);
      });
    }
    if (overviewCloseBtn) {
      overviewCloseBtn.addEventListener('click', function () {
        setOverview(false);
      });
    }
    if (overviewSearchInput) {
      overviewSearchInput.addEventListener('input', function () {
        overviewQuery = overviewSearchInput.value;
        renderOverview();
      });
    }
    if (overviewEl) {
      overviewEl.addEventListener('click', function (ev) {
        // 카드 사이 빈 곳을 누르면 닫는다 (카드 클릭은 전환이다).
        if (ev.target === overviewEl) setOverview(false);
      });
    }
    doc.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (tabCtxEl) closeTabCtxMenu();
      else if (overviewOpen()) setOverview(false);
      else if (sidebarOpen()) setSidebar(false);
    });
    doc.addEventListener('pointerdown', function (e) {
      if (tabCtxEl && e.target !== tabCtxEl && !tabCtxEl.contains(e.target)) {
        closeTabCtxMenu();
      }
    });

    // 창 바 내비 채널의 수신부: 채택(adopt)·내비 상태 요청·동작(뒤로·
    // 앞으로·새로고침·이동·새 탭·탭 개요·사이드바). 출처는 부모 창으로
    // 판정한다 (e.source === appWin.parent).
    if (appWin && typeof appWin.addEventListener === 'function') {
      appWin.addEventListener('message', function (e) {
        if (!e || !e.data || e.source !== appWin.parent) return;
        var d = e.data;
        if (d.type === 'myhub:browser-nav-adopt') {
          if (!toolbarHosted) {
            toolbarHosted = true;
            applyToolbarHosting();
          }
        } else if (d.type === 'myhub:request-browser-nav') {
          postBrowserNav(true);
        } else if (d.type === 'myhub:browser-nav-action') {
          if (d.action === 'back') {
            goBack();
          } else if (d.action === 'forward') {
            goFwd();
          } else if (d.action === 'reload') {
            reloadPage();
          } else if (d.action === 'navigate' && typeof d.url === 'string') {
            var url = normalizeInput(d.url);
            if (url) go(url);
          } else if (d.action === 'newtab') {
            newTab();
          } else if (d.action === 'overview') {
            toggleOverview();
          } else if (d.action === 'sidebar') {
            toggleSidebar();
          }
        }
      });
    }

    // 앱 상단 메뉴바 정의 (계약: js/desktop/windows.js 상단 주석).
    // 즐겨찾기·최근 방문은 목록 항목으로 열어 보여준다. 툴바 버튼
    // (뒤로·앞으로·새로고침·공유 등)은 메뉴바에도 같은 명령이 있어야
    // 한다는 HIG 규칙으로 함께 둔다. 새로고침은 CDP Page.reload다
    // (2026-11-20 4단계 — 같은 주소 재이동이 아니다).
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
                disabled: !navCaps(tab).canBack,
                run: goBack,
              },
              {
                label: '앞으로',
                disabled: !navCaps(tab).canFwd,
                run: goFwd,
              },
              {
                label: '새로고침',
                disabled: !(tab && tab.url),
                run: reloadPage,
              },
              {
                label: '시작 페이지로',
                run: goHome,
              },
              {
                // 시작/종료 토글 (2026-11-21 QA 발견): 옛 코드는 켜진
                // 상태에서 항목을 비활성화만 해서 라이브를 끄려면 앱
                // 창을 닫아야만 했다. 켜진 동안 시작 페이지는 숨어
                // 카드 버튼이 안 보이므로 메뉴가 유일한 종료 경로다.
                label: st === 'on' ? '브라우저 종료' : '브라우저 시작',
                run: function () {
                  if (st === 'on') {
                    live.endLive();
                  } else if (startBtns[0]) {
                    startBtns[0].click();
                  }
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
          label: '보기',
          items: function () {
            // 화질 (2026-11-20 4단계): 자동은 Selkies 혼잡 제어,
            // 수동은 고정 비트레이트. 고화질 12000이 현행 기본값과
            // 같다 — 저장값이 없으면 자동이 체크되고 시작 시 아무것도
            // 보내지 않아 기본값이 그대로 유지된다. 선택은 live가
            // localStorage에 저장하고 다음 시작 때 다시 적용한다.
            var q = live.getQuality ? live.getQuality() : { mode: 'auto' };
            var qualityItems = [
              { label: '화질: 자동', mode: 'auto' },
              // 최고화질 15000 (2026-11-20 5단계): 사이드카
              // SIDECAR_BITRATE_MAX를 15000으로 올려야 실제로 적용된다
              // (기본값 12000은 그대로 — 상한만 올린 것이다).
              { label: '화질: 최고화질', mode: 15000 },
              { label: '화질: 고화질', mode: 12000 },
              { label: '화질: 중화질', mode: 8000 },
              { label: '화질: 저화질', mode: 6000 },
            ].map(function (opt) {
              var isChecked =
                opt.mode === 'auto'
                  ? q.mode === 'auto'
                  : q.mode === 'manual' && q.bitrate === opt.mode;
              return {
                label: opt.label,
                checked: isChecked,
                run: (function (mode) {
                  return function () {
                    applyQuality(mode);
                  };
                })(opt.mode),
              };
            });
            return [
              {
                label: '사이드바',
                checked: sidebarOpen(),
                run: toggleSidebar,
              },
              {
                label: '탭 개요',
                checked: overviewOpen(),
                run: toggleOverview,
              },
              {
                label: '페이지에서 찾기',
                disabled: !live.isActive(),
                run: openFind,
              },
              { separator: true },
            ].concat(qualityItems);
          },
        },
        {
          label: '즐겨찾기',
          items: function () {
            var items = [];
            var tab = activeTab();
            if (tab && tab.url) {
              var existing = bookmarkForUrl(tab.url);
              items.push({
                label: existing
                  ? '현재 페이지 북마크에서 제거'
                  : '현재 페이지 북마크에 추가',
                run: function () {
                  toggleCurrentBookmark();
                },
              });
              items.push({ separator: true });
            }
            bookmarks.forEach(function (b) {
              items.push({
                label: favDisplayName(b),
                run: function () {
                  go(b.url);
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
    loadBookmarks();
    syncChrome();
    return {
      go: go,
      live: live,
      syncChrome: syncChrome,
      getBookmarks: function () {
        return bookmarks.map(function (b) {
          return {
            id: b.id,
            url: b.url,
            title: b.title,
            pinned: b.pinned,
            position: b.position,
          };
        });
      },
      isToolbarHosted: function () {
        return toolbarHosted;
      },
      newTab: newTab,
      closeTab: closeTab,
      activateTab: activateTab,
      getTabs: function () {
        return tabs.map(function (t) {
          return {
            id: t.id,
            url: t.url,
            title: t.title,
            pinned: !!t.pinned,
            history: t.history.slice(),
            hIndex: t.hIndex,
            active: t.id === activeTabId,
            live: t.id === liveTabId,
            remoteTargetId: t.remoteTargetId || null,
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
