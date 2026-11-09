// 오피스 탭 공통 셸 (office-tabs.js) — 작성 작업 2 (2026-11-05)
// 설계 확정 (2026-11-06, 캡처 H 후속 및 MS Office for Mac 정보):
// 탭과 메뉴를 구분한다. 리본 탭(파일·홈·삽입)은 이 상단바가 아니다
// 모든 모듈의 창 의 리본 영역 최상단 줄(#officeTabs)을 그리는 것이
// 본체고, 셸 상단바는 메뉴(kind 'menu')만 호스팅한다. 채택(adopt)
// 은 셸이 "셸이 메뉴를 호스팅한다"로 알려주는 신호다 adopt 이후에
// 리본 탭·파일 등 로컬 렌더가 계속 그린다.
// 오피스 앱(Excel·PowerPoint·한글·PDF)이 활성화되면 각 모듈의
// 모든 호스트의 탭 상태를 모아, 메뉴는 셸 상단바(windows.js)에
// 위임하고 각 셸 창 안에 직접. 그린다 셸의 메뉴 클릭 을
// 호스트의 명령 채널로 전달한다. 엔진 안의 자체 탭 행 을 엔진은
// 다른 옵션으로 가린다 (GridCraft chrome=notabs, DeckCraft
// chrome=notabs, PdfCraft chrome=nomodetabs, 한글 Studio 확장은
// 메뉴 컨트롤러 가린다). 도구 패널(셸 아래 도구들)은 엔진 창
// 안에 그대로 렌더한다.
//
// 셸 연동 계약 (셸 상단바 호스트 측 windows.js가 구현):
// 모듈 상태가 바뀌면 부모 셸 창에 로 postMessage
//   { type: 'myhub:office-tabs', app, tabs: [{id, label, kind}],
//     activeId, collapsed, canCollapse }
// 를 보내고, 부모가 보내온
//   { type: 'myhub:office-tabs-select', app, id, anchorX? }
//   { type: 'myhub:office-tabs-collapse', app }
// 를 같은 명령 경로로 받는다. 셸이 탭 행을 상단바에 그리기로 하면
//   { type: 'myhub:office-tabs-adopt', app }
// 를 게시한다 면 그때부터 로컬 렌더는 메뉴만 접고(이중 표시 방지)
// 리본 탭도 계속 그리면, 상태 통지는 메뉴부분만 계속 나간다. 셸이
// 없는 단독 실행에서는 adopt가 오지 않아 로컬 렌더가 전부 동작한다
// (대안). anchorX는 셸 뷰포트 기준 클릭
// 위치로, 한글 메뉴처럼 앵커 좌표가 필요한 모듈을 위해 오피스 문서
// 좌표계의 anchorEl로 환산해 명령을 실어 보낸다. office.js의 문서
// 제목 통지(myhub:doc-title)와 같은 패턴이다.
//
// 모듈 호스트 계약:
//   MyHubOfficeTabs.onCommand(appKey, fn) — fn({type:'select', id,
//     anchorEl} | {type:'toggle-collapse'}) 를 받는다. anchorEl은
//     클릭한 탭 버튼 요소로, 드롭다운 앵커 위치가 필요한 모듈
//     (한글 메뉴)의 좌표를 셸 창에 맞춘다.
//   MyHubOfficeTabs.setState(appKey, state|null) — state =
//     { tabs: [{id, label, kind?}], activeId, collapsed, canCollapse }
//     kind는 'tab'(기본)·'file'·'menu'. null이면 탭 행을 비운다.
// 셸 메뉴 계약 (v3, 한글 전용): state.menuShell이 true면 셸이 메뉴
// 드롭다운까지 직접 그린다. 셸이 {type:'myhub:office-tabs-menu-request',
// app, id, seq}를 보내면 명령 핸들러 {type:'menu-request', id, seq}를
// 받고, 호스트는 MyHubOfficeTabs.provideMenuItems(appKey, id, items,
// seq)로 항목 트리({label, shortcut?, disabled?, checked?, children?,
// path} | {separator:true, path})를 알려준다
// myhub:office-tabs-menu-items로 셸에 올린다. 실행은
// {type:'myhub:office-tabs-menu-exec', app, id, path} 가
// {type:'menu-exec', id, path}. menuShell이 없으면 셸 종전
// select 경로(Studio 실제 드롭다운)를 탄다.
// PDF 확장: state.menuLocal까지 true면(메뉴가 엔진 안에 없어 셸이
// 직접 그릴 수 없는 경우) 셸이 없는 단독 실행에서 탭 행이 같은
// request·rovide·xec 흐름으로 공용 렌더러(menu.js) 드롭다운을
// 직접 그린다. 한글처럼 셸이 자기 드롭다운 그리기 모듈을
// menuLocal로 켜지 않으므로 단독 실행 동작은 변하지 않는다.
// kind 'separator' 탭은 얇은 없는 구분 요소로 그린다 (메뉴 묶음과
// 모든 탭 묶음 사이 등 PDF).
// 렌더러는 현재 탭(appKey)의 상태만 그린다 은 office.html로드 때 한
// 번 마운트 초기 렌더한다.
(function () {
  'use strict';

  var states = {}; // appKey -> state|null
  var handlers = {}; // appKey -> fn(cmd)
  var mountCtx = null; // { doc, win, appKey, rootEl }
  var shellAdopted = false; // 셸이 탭 행을 상단바에 그리기로 채택했는가

  function normalizeTabs(tabs) {
    if (!Array.isArray(tabs)) return [];
    var out = [];
    tabs.forEach(function (t) {
      if (!t || typeof t.id !== 'string' || !t.id) return;
      var kind =
        t.kind === 'file' || t.kind === 'menu' || t.kind === 'separator'
          ? t.kind
          : 'tab';
      out.push({
        id: t.id,
        label:
          kind === 'separator'
            ? ''
            : typeof t.label === 'string' && t.label
              ? t.label
              : t.id,
        kind: kind,
      });
    });
    return out;
  }

  function normalizeState(state) {
    if (!state) return null;
    var tabs = normalizeTabs(state.tabs);
    if (!tabs.length) return null;
    return {
      tabs: tabs,
      activeId: typeof state.activeId === 'string' ? state.activeId : null,
      collapsed: !!state.collapsed,
      canCollapse: !!state.canCollapse,
      menuShell: !!state.menuShell,
      menuLocal: !!state.menuLocal,
    };
  }

  // 셸 연동: 부모 창에 현재 탭 상태를 알린다 (office가 단독 실행이면
  // 부모가 없어 셸도 없이 실행되지 않는다).
  // 설계 확정 (캡처 H 후속, MS Office for Mac 정보): 셸 상단바는
  // 메뉴(kind 'menu')만 호스팅한다. 리본 탭·파일 구분선은 창 의
  // 리본 영역 최상단 줄이 소유하도록 새로이 메뉴 탭만 올리고, 접기
  // 토글은 창 쪽이 담당한다(canCollapse/collapsed는 셸에 false).
  // ---------- 접기 컨트롤의 창 바 소유 (myhub:office-fold 채널) ----------
  // 교정 캡처 정보 (2026-11-06 확정, 캡처 image-142): 접기 컨트롤은
  // 리본 영역의 접기 셰브론(#officeTabs 오른쪽 끝 아이콘들)이 아니다
  // 셸 창 바의 좌측 빠른 실행 자리가 소유한다 상태는. 셸 이 채널로
  // 게시하고(available/folded), 클릭은 'myhub:office-fold-toggle'로
  // 보내는 기존 명령 계약으로 디스패치한다:
  //  - 탭 상태가 canCollapse를 주장하는 탭(한글 탭 Studio 도구모음
  //    의 접기는 자체): {type:'toggle-collapse'} 명령 그쪽으로.
  //  - 그 밖의 탭(시트·슬라이드·PDF): 뷰어 코어(finder-viewer)가
  //    publishCoreFold로 접힌 상태를 올리고 onCoreFoldRequest로
  //    토글을 받는다 그 코어 접기가 곧 단일 셸이(접으면 뷰어·펼치면
  //    에디터) 전환된다.
  // 탭 상태가 canCollapse를 주장하면 그쪽을 우선한다 (한글 코어 접기를
  // 셸이 전환 전용으로 폴백 버튼도 계속 담당한다).
  var coreFold = {}; // appKey -> { available, folded }
  var coreFoldHandlers = {}; // appKey -> [fn()]

  function effectiveFold(appKey) {
    var st = states[appKey] || null;
    if (st && st.canCollapse) {
      return { available: true, folded: !!st.collapsed, via: 'tabs' };
    }
    var cf = coreFold[appKey] || null;
    if (cf && cf.available) {
      return { available: true, folded: !!cf.folded, via: 'core' };
    }
    return { available: false, folded: false, via: null };
  }

  function postFold() {
    if (!mountCtx || !mountCtx.win) return;
    var win = mountCtx.win;
    if (!win.parent || win.parent === win) return;
    var f = effectiveFold(mountCtx.appKey);
    try {
      win.parent.postMessage(
        {
          type: 'myhub:office-fold',
          app: mountCtx.appKey,
          available: f.available,
          folded: f.folded,
        },
        win.location.origin,
      );
    } catch (e) {
      console.warn('오피스 접기 상태 게시 실패:', e);
    }
  }

  function dispatchFoldToggle() {
    if (!mountCtx) return;
    var f = effectiveFold(mountCtx.appKey);
    if (!f.available) return;
    if (f.via === 'tabs') {
      dispatch({ type: 'toggle-collapse' });
      return;
    }
    var list = coreFoldHandlers[mountCtx.appKey] || [];
    list.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        console.warn('오피스 접기 토글 처리 실패:', e);
      }
    });
  }

  // 뷰어 코어(finder-viewer)가 자기 접기 상태를 올릴 때 마운트된
  // 앱 기준으로 동작하도록 코어는 appKey를 모른다고 서술. null이면
  // 가용성은 내린다 (문서가 닫힌 경우).
  function publishCoreFold(state) {
    if (!mountCtx) return;
    var appKey = mountCtx.appKey;
    if (state === null || state === undefined) {
      delete coreFold[appKey];
    } else {
      coreFold[appKey] = {
        available: state.available !== false,
        folded: !!state.folded,
      };
    }
    postFold();
  }

  function onCoreFoldRequest(fn) {
    if (!mountCtx || typeof fn !== 'function') return;
    (coreFoldHandlers[mountCtx.appKey] =
      coreFoldHandlers[mountCtx.appKey] || []).push(fn);
  }

  function postToShell() {
    if (!mountCtx || !mountCtx.win) return;
    var win = mountCtx.win;
    if (!win.parent || win.parent === win) return;
    var state = states[mountCtx.appKey] || null;
    var menuTabs = state
      ? state.tabs.filter(function (t) {
          return t.kind === 'menu';
        })
      : [];
    try {
      win.parent.postMessage(
        {
          type: 'myhub:office-tabs',
          app: mountCtx.appKey,
          tabs: menuTabs,
          activeId: state ? state.activeId : null,
          collapsed: false,
          canCollapse: false,
          menuShell: state ? !!state.menuShell : false,
          menuLocal: state ? !!state.menuLocal : false,
        },
        win.location.origin,
      );
    } catch (e) {
      console.warn('오피스 탭 상태 게시 실패:', e);
    }
  }

  function dispatch(cmd) {
    if (!mountCtx) return;
    var fn = handlers[mountCtx.appKey];
    if (typeof fn === 'function') fn(cmd);
  }

  // 셸 상단바 버튼의 뷰포트 x를 오피스 문서 좌표계의 anchorEl로
  // 바꾼다. 한글 메뉴 호스트는 anchorEl.getBoundingClientRect().left만
  // 읽으므로 최소 형태의 객체면 된다. 계산할 값 없으면 null(종전 동작).
  function anchorFromShellX(win, x) {
    if (typeof x !== 'number' || !isFinite(x)) return null;
    try {
      var fe = win && win.frameElement;
      if (!fe || typeof fe.getBoundingClientRect !== 'function') return null;
      var left = x - fe.getBoundingClientRect().left;
      return {
        getBoundingClientRect: function () {
          return { left: left };
        },
      };
    } catch (e) {
      return null;
    }
  }

  function render() {
    if (!mountCtx) return;
    var doc = mountCtx.doc;
    var root = mountCtx.rootEl;
    if (!root) return;
    // 버튼을 교체하므로 아래 있던 로컬 메뉴는 먼저 닫는다.
    closeLocalMenu();
    var state = states[mountCtx.appKey] || null;
    root.innerHTML = '';
    if (!state) {
      root.hidden = true;
      return;
    }
    state.tabs.forEach(function (tab) {
      // 셸이 채택했으면 메뉴는 셸 상단바가 그리는 탭 창 의 행 리본
      // 탭·파일 만 그린다. 구분선도 셸 메뉴의 경계 표시인 메뉴가
      // 세로 막대 옆에 탭 행에 나란히 없어 함께 건너뛴다.
      if (shellAdopted && (tab.kind === 'menu' || tab.kind === 'separator')) {
        return;
      }
      if (tab.kind === 'separator') {
        var sep = doc.createElement('span');
        sep.className = 'office-tab-sep';
        sep.setAttribute('aria-hidden', 'true');
        root.appendChild(sep);
        return;
      }
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className =
        'office-tab' +
        (tab.kind === 'file' ? ' office-tab-file' : '') +
        (tab.kind === 'menu' ? ' office-tab-menu' : '');
      btn.textContent = tab.label;
      btn.setAttribute('data-tab-id', tab.id);
      btn.setAttribute('role', 'tab');
      var active = state.activeId === tab.id;
      if (active) btn.classList.add('is-active');
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      if (tab.kind === 'menu') {
        btn.setAttribute('aria-haspopup', 'menu');
        if (state.menuShell && state.menuLocal) {
          btn.setAttribute('aria-expanded', 'false');
        }
      }
      btn.addEventListener('click', function () {
        // menuLocal 메뉴는 셸이 없을 때 탭 행이 드롭다운을 그리는 것
        // select(셸이 드롭다운 전임)가 아니라 항목 요청으로 간다.
        if (tab.kind === 'menu' && state.menuShell && state.menuLocal) {
          requestLocalMenu(tab, btn);
          return;
        }
        dispatch({ type: 'select', id: tab.id, anchorEl: btn });
      });
      root.appendChild(btn);
    });
    // 셸이 채택한 뒤에 접기 컨트롤을 창 바 행에 그리지 않는 것
    // 창 바 빠른 실행 자리에 컨트롤이 이사한다 (접기 버튼 제거,
    // 캡처 image-142). 단독 실행(미채택)에서는 종전대로 행이 소유한다.
    if (state.canCollapse && !shellAdopted) {
      var fold = doc.createElement('button');
      fold.type = 'button';
      fold.className = 'office-tab-fold';
      fold.setAttribute(
        'aria-label',
        state.collapsed ? '도구 펼치기' : '도구 접기',
      );
      fold.title = state.collapsed ? '도구 펼치기' : '도구 접기';
      var chev = doc.createElement('span');
      chev.className =
        'office-tab-chevron ' +
        (state.collapsed ? 'office-tab-chevron-down' : 'office-tab-chevron-up');
      fold.appendChild(chev);
      fold.addEventListener('click', function () {
        dispatch({ type: 'toggle-collapse' });
      });
      root.appendChild(fold);
    }
    // 탭 채택 후 메뉴만 남은 상태처럼 그릴 것이 없으면 행을 가린다.
    root.hidden = root.childNodes.length === 0;
  }

  function setState(appKey, state) {
    states[appKey] = normalizeState(state);
    if (mountCtx && mountCtx.appKey === appKey) {
      render();
      postFold();
      postToShell();
    }
  }

  function onCommand(appKey, fn) {
    if (typeof fn === 'function') handlers[appKey] = fn;
    else delete handlers[appKey];
  }

  // ---------- 빠른 실행 (창 제목 줄 버튼 그룹) ----------
  // 설계 확정 (캡처 H 후속): 제목 줄 좌측 의 빠른 실행 버튼을
  // 셸 창 바가 호스팅한다. 탭은 "실제로 동작하는 동작"만 가용성으로
  // 올리고(setQuick 과 병합해), 셸이 버튼을 눌러 보내면 등록된
  // 핸들러들을 순서대로 처리한다(onQuick 이 true를 돌려준 첫 핸들러가
  // 소유). 동작 이름은 save/undo/redo/print/search만 허용한다.
  // search는 캡션 입력의 질의(value)를 함께 넣는다 그 핸들러는
  // fn(action, value)로 받는다. 접기(fold)는 빠른 실행 동작이 아니라
  // 전용 채널(myhub:office-fold, 위 절)이 맡는다 셸 버튼은 빠른 실행
  // 자리와 함께 표시만 상태(접힌 방향)를 가진 별도 계약이다
  // (2026-11-06 확정 교정 캡처 정보).
  var QUICK_ACTIONS = ['save', 'undo', 'redo', 'print', 'search'];
  var quickStates = {}; // appKey -> { save: true, 등 }
  var quickHandlers = {}; // appKey -> [fn(action) -> bool]

  function setQuick(appKey, quick) {
    if (!appKey) return;
    if (quick === null) {
      delete quickStates[appKey];
    } else if (typeof quick === 'object') {
      var cur = quickStates[appKey] || {};
      QUICK_ACTIONS.forEach(function (a) {
        if (a in quick) {
          if (quick[a]) cur[a] = true;
          else delete cur[a];
        }
      });
      if (Object.keys(cur).length) quickStates[appKey] = cur;
      else delete quickStates[appKey];
    }
    postQuick(appKey);
  }

  function postQuick(appKey) {
    if (!mountCtx || !mountCtx.win || mountCtx.appKey !== appKey) return;
    var win = mountCtx.win;
    if (!win.parent || win.parent === win) return;
    try {
      win.parent.postMessage(
        {
          type: 'myhub:office-quick',
          app: appKey,
          quick: quickStates[appKey] || null,
        },
        win.location.origin,
      );
    } catch (e) {
      console.warn('오피스 빠른 실행 상태 게시 실패:', e);
    }
  }

  function onQuick(appKey, fn) {
    if (typeof fn !== 'function') return;
    (quickHandlers[appKey] = quickHandlers[appKey] || []).push(fn);
  }

  function dispatchQuick(action, value) {
    if (!mountCtx || QUICK_ACTIONS.indexOf(action) < 0) {
      return;
    }
    var list = quickHandlers[mountCtx.appKey] || [];
    for (var i = 0; i < list.length; i++) {
      try {
        if (list[i](action, value) === true) return;
      } catch (e) {
        console.warn('오피스 빠른 실행 처리 실패:', e);
      }
    }
  }

  // 셸 메뉴 항목 트리를 셸로 올리기 전에 알려진 필드만 추리고
  // 깊이·개수를 제한한다 (호스트가 보낸 임의 데이터의 통과 방지).
  function cleanMenuNodes(nodes, depth, budget) {
    if (!Array.isArray(nodes) || depth > 3) return [];
    var out = [];
    for (var i = 0; i < nodes.length && budget.count > 0; i++) {
      var n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      budget.count--;
      if (n.separator) {
        out.push({ separator: true, path: n.path });
        continue;
      }
      if (typeof n.label !== 'string' || !n.label) continue;
      var node = { label: n.label, disabled: !!n.disabled, path: n.path };
      if (typeof n.shortcut === 'string' && n.shortcut) {
        node.shortcut = n.shortcut;
      }
      // 체크·라디오 상태 (PDF 보기 메뉴 등) 는 그대로 드롭다운에 함께 실린다.
      if (typeof n.checked === 'boolean') {
        node.checked = n.checked;
      }
      if (Array.isArray(n.children) && n.children.length) {
        node.children = cleanMenuNodes(n.children, depth + 1, budget);
      }
      out.push(node);
    }
    return out;
  }

  // ---- 로컬 메뉴 드롭다운 (단독 실행 대안, menuLocal 전용) ----
  // 셸이 채택하지 않은 실행에서는 탭 행이 메뉴와 같은 흐름으로 메뉴를
  // 그린다: 클릭 시 {type:'menu-request'} 를 호스트의 provideMenuItems
  // 회신 후 공용 렌더러(menu.js) 드롭다운 에서 선택 시
  // {type:'menu-exec', id, path}. 렌더러·표시 형태·실행 계약은 메뉴와
  // 동일하므로 셸이 바꿔치운 메뉴 거동과 같다.
  var localMenu = null; // createMenu 인스턴스 (지연 생성)
  var localMenuSeq = 0;
  var localMenuPending = null; // { id, seq, btn, timer }
  var localMenuCtl = null; // { id, btn } 현재 드롭다운이 열려 있는 메뉴

  function localMenuApi() {
    if (!mountCtx || !mountCtx.win) return null;
    var api = mountCtx.win.MyHubDesktopMenu;
    if (!api || typeof api.createMenu !== 'function') return null;
    if (!localMenu) {
      var win = mountCtx.win;
      localMenu = api.createMenu(mountCtx.doc, {
        refreshIcons: function () {
          try {
            if (win.lucide) win.lucide.createIcons();
          } catch (e) {
            // 아이콘 새로고침 실패는 메뉴를 막지 않지만 기록은 남긴다
            console.warn('오피스 메뉴 아이콘 새로고침 실패:', e);
          }
        },
      });
    }
    return localMenu;
  }

  function markLocalBtnClosed(btn) {
    if (!btn) return;
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
  }

  function closeLocalMenu() {
    if (localMenuPending) {
      if (localMenuPending.timer) clearTimeout(localMenuPending.timer);
      localMenuPending = null;
    }
    if (localMenu) localMenu.close();
    if (localMenuCtl) {
      markLocalBtnClosed(localMenuCtl.btn);
      localMenuCtl = null;
    }
  }

  function requestLocalMenu(tab, btn) {
    if (
      localMenuCtl &&
      localMenuCtl.id === tab.id &&
      localMenu &&
      localMenu.isOpen()
    ) {
      closeLocalMenu();
      return;
    }
    closeLocalMenu();
    var seq = ++localMenuSeq;
    var pending = { id: tab.id, seq: seq, btn: btn, timer: null };
    localMenuPending = pending;
    localMenuCtl = { id: tab.id, btn: btn };
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    // 호스트가 무응답이면 열린 표시만 남으므로 메뉴와 같은 시간을 되돌린다.
    pending.timer = setTimeout(function () {
      if (localMenuPending !== pending) return;
      localMenuPending = null;
      if (localMenuCtl && localMenuCtl.btn === btn) {
        markLocalBtnClosed(btn);
        localMenuCtl = null;
      }
    }, 700);
    dispatch({ type: 'menu-request', id: tab.id, seq: seq });
  }

  function mapLocalMenuItems(nodes, menuId) {
    var out = [];
    (Array.isArray(nodes) ? nodes : []).forEach(function (n) {
      if (!n || typeof n !== 'object') return;
      if (n.separator) {
        out.push({ separator: true });
        return;
      }
      if (typeof n.label !== 'string' || !n.label) return;
      var item = { label: n.label, disabled: !!n.disabled };
      if (typeof n.shortcut === 'string' && n.shortcut) {
        item.shortcut = n.shortcut;
      }
      if (typeof n.checked === 'boolean') item.checked = n.checked;
      if (Array.isArray(n.children) && n.children.length) {
        item.children = mapLocalMenuItems(n.children, menuId);
      } else if (Array.isArray(n.path)) {
        var p = n.path.slice();
        item.onSelect = function () {
          dispatch({ type: 'menu-exec', id: menuId, path: p });
        };
      }
      out.push(item);
    });
    return out;
  }

  function stepLocalMenu(dir) {
    if (!mountCtx || !localMenuCtl) return;
    var state = states[mountCtx.appKey] || null;
    if (!state) return;
    var menus = state.tabs.filter(function (t) {
      return t.kind === 'menu';
    });
    var idx = -1;
    menus.forEach(function (t, i) {
      if (t.id === localMenuCtl.id) idx = i;
    });
    if (idx < 0) return;
    var next = idx + dir;
    if (next < 0 || next >= menus.length) return;
    var btn = mountCtx.rootEl.querySelector(
      '[data-tab-id="' + menus[next].id + '"]',
    );
    if (btn) requestLocalMenu(menus[next], btn);
  }

  function openLocalMenu(pending, rawItems) {
    var menu = localMenuApi();
    if (!menu) {
      closeLocalMenu();
      return;
    }
    var items = mapLocalMenuItems(
      cleanMenuNodes(rawItems, 0, { count: 400 }),
      pending.id,
    );
    if (!items.length) {
      closeLocalMenu();
      return;
    }
    var btn = pending.btn;
    var rect =
      typeof btn.getBoundingClientRect === 'function'
        ? btn.getBoundingClientRect()
        : { left: 0, bottom: 0 };
    menu.open(Math.round(rect.left), Math.round(rect.bottom), items, {
      onSwitch: function (dir) {
        stepLocalMenu(dir);
      },
      onClose: function () {
        markLocalBtnClosed(btn);
        if (localMenuCtl && localMenuCtl.btn === btn) localMenuCtl = null;
      },
    });
  }

  /**
   * 셸 메뉴 요청에 대한 회신: 호스트가 허락한 항목 트리를 셸로 올린다.
   * 마운트된 앱과 appKey가 다르면 무시한다. 셸이 채택하지 않은 단독
   * 실행에서 menuLocal 호스트의 요청이면 탭 행이 직접 그린다.
   */
  function provideMenuItems(appKey, id, items, seq) {
    if (!mountCtx || mountCtx.appKey !== appKey) return;
    if (typeof id !== 'string' || !id) return;
    if (!shellAdopted) {
      var pending = localMenuPending;
      if (pending && pending.id === id && pending.seq === seq) {
        if (pending.timer) clearTimeout(pending.timer);
        localMenuPending = null;
        openLocalMenu(pending, items);
      }
      return;
    }
    var win = mountCtx.win;
    if (!win || !win.parent || typeof win.parent.postMessage !== 'function') {
      return;
    }
    try {
      win.parent.postMessage(
        {
          type: 'myhub:office-tabs-menu-items',
          app: appKey,
          id: id,
          seq: seq,
          items: cleanMenuNodes(items, 0, { count: 400 }),
        },
        win.location.origin,
      );
    } catch (e) {
      console.warn('오피스 셸 메뉴 항목 게시 실패:', e);
    }
  }

  /**
   * deps = { doc, win, appKey, rootEl }
   * office.js가 로딩 때 한 번. 부른다(부모)셸 로부터의 메시지를
   * 여기서 받는다.
   */
  function mount(deps) {
    deps = deps || {};
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || !deps.rootEl || !deps.appKey) return null;
    mountCtx = { doc: doc, win: win, appKey: deps.appKey, rootEl: deps.rootEl };
    win.addEventListener('message', function (e) {
      if (e.origin !== win.location.origin) return;
      var d = e.data || {};
      if (d.type === 'myhub:office-tabs-select' && typeof d.id === 'string') {
        dispatch({
          type: 'select',
          id: d.id,
          anchorEl: anchorFromShellX(win, d.anchorX),
        });
      } else if (
        d.type === 'myhub:office-tabs-menu-request' &&
        typeof d.id === 'string'
      ) {
        dispatch({ type: 'menu-request', id: d.id, seq: d.seq });
      } else if (
        d.type === 'myhub:office-tabs-menu-exec' &&
        typeof d.id === 'string' &&
        Array.isArray(d.path)
      ) {
        dispatch({ type: 'menu-exec', id: d.id, path: d.path });
      } else if (d.type === 'myhub:office-tabs-collapse') {
        dispatch({ type: 'toggle-collapse' });
      } else if (d.type === 'myhub:office-fold-toggle') {
        dispatchFoldToggle();
      } else if (
        d.type === 'myhub:office-quick-action' &&
        typeof d.action === 'string'
      ) {
        dispatchQuick(d.action, typeof d.value === 'string' ? d.value : undefined);
      } else if (d.type === 'myhub:request-doc-title') {
        // 문서 프레임 (셸)로드마다 제목을 다시 묻고 그 시점에 게시
        // 상태를 비우는 빈 런타임을 실행한 제목과 같은 자기치유 계약
        // 으로 현재 상태를 다시 알린다 (로드 순서 결합으로 게시가
        // 지워진 첫 것과 묶게).
        postToShell();
        postQuick(mountCtx.appKey);
        postFold();
      } else if (d.type === 'myhub:office-tabs-adopt') {
        // 셸 채택: 로컬 렌더를 접고 현재 상태를 한 번 다시 알린다.
        // 이미 채택한 셸의 중복 adopt는 무시한다 (통신 루프 방지).
        if (!shellAdopted) {
          shellAdopted = true;
          render();
          postToShell();
        }
      }
    });
    render();
    postToShell();
    postQuick(deps.appKey);
    postFold();
    return {
      refresh: render,
      getState: function () {
        return states[mountCtx.appKey] || null;
      },
    };
  }

  var api = {
    mount: mount,
    setState: setState,
    onCommand: onCommand,
    setQuick: setQuick,
    onQuick: onQuick,
    publishCoreFold: publishCoreFold,
    onCoreFoldRequest: onCoreFoldRequest,
    getEffectiveFold: function (appKey) {
      return effectiveFold(appKey);
    },
    provideMenuItems: provideMenuItems,
    getState: function (appKey) {
      return states[appKey] || null;
    },
    normalizeState: normalizeState,
  };
  if (typeof window !== 'undefined') window.MyHubOfficeTabs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
