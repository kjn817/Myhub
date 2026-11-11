// MyHub 확장 — rhwp-studio [파일] 메뉴에 보관함 열기·저장 배선
// (2026-11-03, embed 단축키 위임 확장 2026-11-05).
// 메뉴 행 호스팅 확장이 뒤에 붙는다 (2026-11-05, 대형 작업 2):
// 오피스 상단이 Studio 메뉴바의 타이틀을 대신 그릴 때 켜는
// __myhubMenuHost — 타이틀을 숨기고, 메뉴 목록·열린 메뉴를 부모에게
// 보고하며, 부모의 클릭을 실제 타이틀 mousedown으로 되돌려 진짜
 // 드롭다운을 연다.
// 셸 메뉴 모드 (2026-11-05 후속): 셸이 메뉴 보고의 shellMenu:true를
// 받으면 드롭다운까지 셸이 그린다 (메인바 아래에 붙는 .dt-ctx-menu).
// 이때 이 확장은 클릭 시점에 실제 메뉴를 열어 항목 트리를 수확해
// 돌려주고(myhub-hwp:menu-items-request → menu-items), 실행은 경로
// (자식 인덱스 배열)로 실제 항목을 눌러 수행한다(menu-exec). 진짜
 // 드롭다운 경로는 셸 무응답 시의 폴백으로 남는다.
// 셸(메인 상단바)이 메뉴를 채택하면 한 단계 더
// 나아가 메뉴바 띠 자체를 높이 0으로 접는다 — 도구모음 토글은 바
// 안에 그대로 두고, 셸 행 우측 끝 접기 버튼이 보내는 신호로 실제
 // 토글을 클릭해 구동한다 (토글을 바 밖으로 옮기면 Studio MenuBar의
// 컨테이너 위임이 끊길 수 있어 옮기지 않는다).
// Studio 앱과 함께 자체 호스팅되는 정적 스크립트다 (빌드:
// scripts/build-rhwp-studio.mjs가 public/rhwp-studio/로 복사하고
// index.html에 태그를 심는다 — 동적 주입이 아니라 Studio의 일부).
//
// automation 명세상 커맨드 등록은 Studio 문서 안에서만 가능하다.
// 그래서 등록 코드가 이 파일처럼 Studio 안에서 돌아야 하고, 실행
// 함수의 렐름도 Studio여야 클릭 시 postMessage의 source가 Studio
// 창과 일치한다 (호스트 렐름 함수는 source가 호스트가 된다).
//
// 접기 셰브론은 여기서 만들지 않는다 (사용자 확정 2026-11-03):
// Studio 탭 줄 우측 끝에는 Studio 자체 도구모음 토글이 이미 있고,
// 접기는 그 토글이 담당한다. 한때 같은 자리에 MyHub 접기 셰브론을
// 심었으나 중복이라 제거했다 — 이 확장의 일은 [파일] 메뉴 항목뿐이다.
//
// 등록은 호스트 뷰어가 enable()을 부를 때만 일어난다 — 파일 계약을
// 켠 호스트(오피스 minimalChrome·Finder studioEmbed)만 부르고,
// 계약이 없는 표면에서는 메뉴 항목이 생기지 않는다.
//
// embed 프로파일(?chrome=embed)에서는 Studio 자체 열기·저장·다른
// 이름으로 저장이 등록되지 않아, 단축키를 눌러도 브라우저 기본
// 동작만 막힐 뿐 아무 일도 일어나지 않는다. 그래서 이 확장이 파일
// 단축키(Ctrl/Cmd+S, Ctrl/Cmd+Shift+S, Ctrl/Cmd+O)를 캡처 단계에서
 // 가로채 같은 file-action 신호로 이어준다 — 단축키 경로까지 실제로
 // 호스트 저장이 실행되게 하는 배선이다. 편집 표면 자체(aria-label
// "문서 편집 입력"인 InputHandler의 입력 요소)가 대상일 때가 정작
// 단축키가 살아야 하는 자리이고, 대화상자의 텍스트 입력 칸이 대상인
// 키만 그 요소에 양보한다 (Studio 전역 핸들러의 판정과 같은 결).
(function () {
  'use strict';
  if (window.__myhubFileMenu) return;
  var wired = false;
  var keysWired = false;
  // 신호 전송 실패(예: 불투명 origin)가 등록 자체를 깨지 않게 한곳에서
  // 감싼다 — 실패는 플래그로만 남긴다.
  function postToParent(msg) {
    try {
      window.parent.postMessage(msg, window.location.origin);
    } catch (e) {
      window.__myhubPostError = String((e && e.message) || e);
    }
  }
  function post(action) {
    postToParent({ type: 'myhub-hwp:file-action', action: action });
  }
  function wireKeys() {
    if (keysWired) return;
    keysWired = true;
    document.addEventListener('keydown', function (e) {
      if (!e || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      // 대상에서 위로 훑어 편집 표면인지 텍스트 칸인지 가른다 — 편집
      // 표면이 텍스트 칸 형태(textarea)라 이름표로 먼저 판정한다.
      var node = e.target;
      var onEditorSurface = false;
      var onTextField = false;
      while (node && node !== document) {
        if (
          node.getAttribute &&
          node.getAttribute('aria-label') === '문서 편집 입력'
        ) {
          onEditorSurface = true;
          break;
        }
        if (
          node.tagName === 'INPUT' ||
          node.tagName === 'TEXTAREA' ||
          node.isContentEditable
        ) {
          onTextField = true;
        }
        node = node.parentElement;
      }
      if (onTextField && !onEditorSurface) return;
      var k = String(e.key || '').toLowerCase();
      if (k === 's' || k === 'ㄴ') {
        // 한글 IME에서 Shift+S의 key는 'ㄴ'이다 (Studio shortcut-map과
        // 같은 판정 — 'ㄴ'은 다른 이름으로 저장 쪽으로만 매핑된다).
        e.preventDefault();
        e.stopPropagation();
        post(e.shiftKey || k === 'ㄴ' ? 'save-as' : 'save');
      } else if (k === 'o' || k === 'ㅐ') {
        e.preventDefault();
        e.stopPropagation();
        post('open');
      }
    }, true);
  }
  function wire() {
    if (wired) return true;
    var auto = window.rhwpStudio && window.rhwpStudio.automation;
    if (!auto || typeof auto.registerCommand !== 'function') return false;
    auto.registerCommand({
      id: 'ext:myhub-open',
      label: '보관함에서 열기',
      execute: function () {
        post('open');
      },
    });
    auto.registerCommand({
      id: 'ext:myhub-save',
      label: '보관함에 저장',
      execute: function () {
        post('save');
      },
    });
    auto.registerCommand({
      id: 'ext:myhub-save-as',
      label: '다른 이름으로 보관함에 저장',
      execute: function () {
        post('save-as');
      },
    });
    auto.addMenuItem({ menuId: 'file', commandId: 'ext:myhub-open', position: 'top' });
    auto.addMenuItem({ menuId: 'file', commandId: 'ext:myhub-save', position: 'top' });
    auto.addMenuItem({ menuId: 'file', commandId: 'ext:myhub-save-as', position: 'top' });
    wireKeys();
    wired = true;
    window.__myhubFileMenuOk = 1;
    return true;
  }
  window.__myhubFileMenu = {
    enable: function () {
      if (wire()) return;
      var tries = 0;
      var timer = setInterval(function () {
        if (wire() || ++tries > 40) clearInterval(timer);
      }, 250);
    },
  };

  // ── 메뉴 행 호스팅 (대형 작업 2) ──
  // 호스트(오피스)가 enable()을 부를 때만 켜진다. 켜지면:
  // - 메뉴바의 타이틀 글자만 숨긴다. 이 단계에서는 메뉴바의 높이와
  //   우측 끝의 도구모음 토글 위치가 그대로다 (셸 없이 오피스만
  //   열었을 때의 폴백 — 토글이 직접 눌러야 할 자리로 남는다).
  // - 메뉴 목록·열린 메뉴·도구모음 펼침 상태를 myhub-hwp:menus로
  //   부모에게 보고한다.
  // - 부모가 myhub-hwp:menu-open {id, x}를 보내면 실제 타이틀에
  //   mousedown을 보내 Studio 자체 MenuBar 핸들러로 드롭다운을
  //   열고, 드롭다운을 x(부모 상단 버튼의 왼쪽, iframe 좌표계)
  //   아래에 건다. 항목 클릭·Esc·토글 닫기는 전부 Studio 동작
  //   그대로이고, 닫힘은 클래스 관찰로 부모에게 보고된다.
  // - 셸이 메뉴를 채택하면(호스트가 setShellAdopted를 부르거나
  //   myhub-hwp:menu-shell {adopted:true}) 메뉴바 띠를 높이 0으로
  //   접는다 — 타이틀바 아래에 빈 자리가 남지 않게 하기 위해서다.
  //   도구모음 토글 버튼 자체는 바 안에 그대로 둔다: Studio의
  //   MenuBar 클래스가 #menu-bar 컨테이너에 클릭 위임을 걸고 있어
  //   버튼을 바 밖으로 옮기면 클릭 경로와 상태 동기화(aria-expanded·
  //   active 클래스)가 끊길 수 있다. 대신 부모의
  //   myhub-hwp:menu-toggle-toolbox가 실제 토글을 .click()으로 눌러
  //   셸 행 우측 끝 접기 버튼이 토글의 자리를 대신한다. 드롭다운은
  //   항목(.menu-item) 하단에 absolute로 걸리므로, 띠를 접을 때
  //   항목의 세로 위치가 흔들리면 드롭다운도 따라 어긋난다 — 그래서
  //   접힘 스타일이 align-items:flex-start로 항목 상단을 바 상단에
  //   고정해 드롭다운이 종전과 같은 높이에 열리게 한다 (A/B 실측:
  //   고정 없으면 항목이 flex 중앙 정렬로 -15px 올라가 드롭다운이
  //   28.5px→15px로 어긋나고, 고정하면 30px로 종전과 일치).
  var menuHostWired = false;
  function menuItems() {
    return Array.prototype.slice.call(
      document.querySelectorAll('#menu-bar .menu-item[data-menu]'),
    );
  }
  // 도구모음(기본 도구 상자) 펼침 상태 — 토글 버튼의 aria-expanded가
  // 정본이고, 없을 때만 도구 상자 자체의 표시 높이로 판정한다.
  // 판정할 재료가 없으면 null (호스트는 "모름"으로 취급한다).
  function toolboxExpanded() {
    var toggle = document.getElementById('toolbox-basic-toggle');
    if (toggle) {
      var exp = toggle.getAttribute('aria-expanded');
      if (exp === 'true') return true;
      if (exp === 'false') return false;
    }
    var bar = document.getElementById('icon-toolbar');
    if (!bar) return null;
    return bar.getBoundingClientRect().height > 0;
  }
  // 단축키 텍스트를 macOS 기호로 바꾼다 — 네이티브 드롭다운(Finder
  // 표면·단독 실행)에서도 'Ctrl+S'가 아니라 '⌘S'로 보이게 (셸 렌더
  // 경로의 menu.js glyphShortcut과 같은 규칙). 수확은 변환된 텍스트를
  // 읽으므로 셸 쪽 표기와도 자동으로 일치한다.
  function shortcutGlyphs(t) {
    var s = String(t || '').trim();
    if (!s || /[⌘⌥⇧⌃]/.test(s)) return s;
    var alt = false;
    var shift = false;
    var cmd = false;
    var key = '';
    s.split('+').forEach(function (p0) {
      var p = p0.trim();
      if (!p) return;
      var lp = p.toLowerCase();
      if (
        lp === 'ctrl' ||
        lp === 'control' ||
        lp === 'cmd' ||
        lp === 'command' ||
        lp === 'meta'
      ) {
        cmd = true;
      } else if (lp === 'alt' || lp === 'option') {
        alt = true;
      } else if (lp === 'shift') {
        shift = true;
      } else {
        key = p;
      }
    });
    if (!key && /\+$/.test(s) && (alt || shift || cmd)) key = '+';
    if (!key || (!alt && !shift && !cmd)) return s;
    var k = key.length === 1 ? key.toUpperCase() : key;
    return (alt ? '⌥' : '') + (shift ? '⇧' : '') + (cmd ? '⌘' : '') + k;
  }
  function glyphifyShortcuts() {
    Array.prototype.forEach.call(
      document.querySelectorAll('#menu-bar .md-shortcut'),
      function (el) {
        var next = shortcutGlyphs(el.textContent);
        if (next && next !== el.textContent) el.textContent = next;
      },
    );
  }
  function reportMenus() {
    glyphifyShortcuts();
    var menus = menuItems().map(function (item) {
      var title = item.querySelector('.menu-title');
      return {
        id: item.getAttribute('data-menu'),
        label: title ? String(title.textContent || '').trim() : '',
      };
    });
    var openItem = document.querySelector('#menu-bar .menu-item.open');
    postToParent({
      type: 'myhub-hwp:menus',
      menus: menus,
      open: openItem ? openItem.getAttribute('data-menu') : null,
      toolbox: { expanded: toolboxExpanded() },
      // 셸 메뉴 능력 선언: 셸이 메뉴 트리 수확(myhub-hwp:menu-items-
      // request)과 경로 실행(myhub-hwp:menu-exec)을 보낼 수 있다.
      shellMenu: true,
    });
  }
  // 셸 채택 모드: 메뉴바 띠를 높이 0으로 접는다. 도구모음 토글은
  // 띠와 함께 보이지 않게 되지만 DOM·위임은 그대로라
  // menu-toggle-toolbox의 .click()으로 계속 구동된다.
  // 주의 — 띠를 overflow:hidden으로 자르면 안 된다: 드롭다운은
  // .menu-item(relative)을 포함 블록으로 삼는 absolute라, 바의
  // overflow가 드롭다운까지 잘라내 열린 메뉴가 화면에 그려지지
  // 않는다 (실측: elementFromPoint가 드롭다운 대신 아래쪽 서식
  // 바를 가리킴). 그래서 숨김은 visibility로 한다 — 항목과 토글은
  // 숨기되 드롭다운만 visibility:visible로 되살리는, visibility
  // 특유의 자손 재표시를 쓴다.
  var shellStyleApplied = false;
  function applyShellMode() {
    if (shellStyleApplied) return true;
    var bar = document.getElementById('menu-bar');
    if (!bar) return false;
    var style = document.createElement('style');
    style.id = 'myhub-menu-shell-style';
    style.textContent =
      '#menu-bar{height:0!important;min-height:0!important;' +
      'padding-top:0!important;padding-bottom:0!important;' +
      'border-bottom:0!important;align-items:flex-start!important}' +
      '#menu-bar .menu-item{visibility:hidden!important}' +
      '#menu-bar .menu-dropdown{visibility:visible!important}' +
      '#toolbox-basic-toggle{visibility:hidden!important}';
    document.head.appendChild(style);
    document.documentElement.classList.add('myhub-menu-shell');
    shellStyleApplied = true;
    window.__myhubMenuShellOk = 1;
    return true;
  }
  function setShellAdopted() {
    if (applyShellMode()) return;
    var tries = 0;
    var timer = setInterval(function () {
      if (applyShellMode() || ++tries > 40) clearInterval(timer);
    }, 250);
  }
  function toggleToolbox() {
    var toggle = document.getElementById('toolbox-basic-toggle');
    if (toggle) toggle.click();
  }
  function openMenu(id, x) {
    if (!/^[a-z][a-z-]*$/.test(String(id || ''))) return;
    var item = document.querySelector(
      '#menu-bar .menu-item[data-menu="' + id + '"]',
    );
    if (!item) return;
    var title = item.querySelector('.menu-title');
    if (!title) return;
    title.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    if (item.classList.contains('open') && typeof x === 'number') {
      var dd = item.querySelector('.menu-dropdown');
      if (dd) {
        var itemLeft = item.getBoundingClientRect().left;
        dd.style.left = Math.max(0, Math.round(x - itemLeft)) + 'px';
      }
    }
  }
  // ── 셸 메뉴 (2026-11-05 후속) ──
  // 셸이 드롭다운을 직접 그리는 모드에서는, 클릭 시점에 Studio 실제
  // 메뉴를 열어(활성화 상태 갱신·최근 문서 같은 동적 렌더를 실제
  // 경로로 태워) DOM에서 항목 트리를 수확해 셸로 보내고 바로 닫는다.
  // 수확 중 드롭다운은 html.myhub-harvest 규칙으로 보이지 않는다.
  // 실행은 트리를 되짚는 경로(자식 인덱스 배열)로 실제 항목을
  // .click() 해 Studio 컨테이너 위임이 커맨드·파라미터·자체
  // 핸들러까지 종전과 똑같이 처리하게 한다 — cmd를 셸로 내보내
  // 재구현하지 않으므로 Studio 거동과 어긋날 수 없다.
  function menuNodeLabel(el) {
    var lab = el.querySelector('.md-label');
    if (lab) return String(lab.textContent || '').trim();
    var t = '';
    Array.prototype.forEach.call(el.childNodes, function (n) {
      if (n.nodeType === 3) {
        t += n.textContent;
      } else if (
        n.nodeType === 1 &&
        !n.classList.contains('md-shortcut') &&
        !n.classList.contains('md-arrow') &&
        !n.classList.contains('md-icon')
      ) {
        t += n.textContent;
      }
    });
    return t.trim();
  }
  function menuNodeDisabled(el, cmd) {
    if (el.classList.contains('disabled')) return true;
    var auto = window.rhwpStudio && window.rhwpStudio.automation;
    if (cmd && auto && typeof auto.isEnabled === 'function') {
      try {
        return !auto.isEnabled(cmd);
      } catch (e) {
        return false;
      }
    }
    return false;
  }
  // container의 자식을 순서대로 걸어 노드 배열을 만든다. path는
  // 드롭다운 루트부터의 자식 인덱스 배열(구분선·서브 포함 전 자식
  // 기준)로, 실행 시 resolveMenuPath가 같은 규칙으로 되짚는다.
  function walkMenuItems(container, basePath) {
    var nodes = [];
    if (!container) return nodes;
    var children = container.children;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      var p = basePath.concat(i);
      if (el.classList.contains('md-sep')) {
        nodes.push({ separator: true, path: p });
        continue;
      }
      if (el.classList.contains('md-sub')) {
        var kids = walkMenuItems(el.querySelector('.md-sub-panel'), p);
        var anyEnabled = kids.some(function (k) {
          return !k.separator && !k.disabled;
        });
        nodes.push({
          label: menuNodeLabel(el),
          disabled: el.classList.contains('disabled') || !anyEnabled,
          children: kids,
          path: p,
        });
        continue;
      }
      if (el.classList.contains('md-item')) {
        var cmd = el.getAttribute('data-cmd');
        var node = {
          label: menuNodeLabel(el),
          disabled: menuNodeDisabled(el, cmd),
          path: p,
        };
        var sc = el.querySelector('.md-shortcut');
        var sct = sc ? String(sc.textContent || '').trim() : '';
        if (sct) node.shortcut = sct;
        nodes.push(node);
      }
      // 그 밖의 자식은 노드로 만들지 않지만 인덱슔는 소비한다 —
      // path 정합은 인덱스 기준이라 그대로 유지된다.
    }
    return nodes;
  }
  function resolveMenuPath(menuItem, path) {
    var container = menuItem.querySelector('.menu-dropdown');
    var el = null;
    for (var depth = 0; depth < path.length; depth++) {
      if (!container) return null;
      el = container.children[path[depth]];
      if (!el) return null;
      if (depth < path.length - 1) {
        container =
          el.classList && el.classList.contains('md-sub')
            ? el.querySelector('.md-sub-panel')
            : null;
      }
    }
    return el;
  }
  function execMenuItem(id, path) {
    if (!/^[a-z][a-z-]*$/.test(String(id || ''))) return;
    if (!Array.isArray(path) || !path.length || path.length > 4) return;
    for (var i = 0; i < path.length; i++) {
      if (!Number.isInteger(path[i]) || path[i] < 0 || path[i] > 500) return;
    }
    var item = document.querySelector(
      '#menu-bar .menu-item[data-menu="' + id + '"]',
    );
    if (!item) return;
    var el = resolveMenuPath(item, path);
    if (!el || el.classList.contains('disabled')) return;
    // 수확 때의 비활성 판정과 같은 기준으로 한 번 더 막는다
    if (menuNodeDisabled(el, el.getAttribute('data-cmd'))) return;
    el.click();
  }
  var harvestChain = Promise.resolve();
  function harvestAndReply(id, seq) {
    return new Promise(function (resolve) {
      var finish = function (items) {
        postToParent({
          type: 'myhub-hwp:menu-items',
          id: id,
          seq: seq,
          items: items || [],
        });
        resolve();
      };
      var item = document.querySelector(
        '#menu-bar .menu-item[data-menu="' + id + '"]',
      );
      if (!item) {
        finish([]);
        return;
      }
      var title = item.querySelector('.menu-title');
      if (!title) {
        finish([]);
        return;
      }
      document.documentElement.classList.add('myhub-harvest');
      title.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
      var started = Date.now();
      var lastSig = null;
      var stable = 0;
      var poll = function () {
        // 파일 메뉴의 최근 문서 서브메뉴는 비동기로 채워진다 — 패널
        // 서명이 두 번 연속 같아질 때까지 기다린다 (상한 ~300ms).
        var panel = document.getElementById('recent-docs-panel');
        var sig = panel
          ? panel.childElementCount + ':' + panel.innerHTML.length
          : '';
        if (sig === lastSig) stable++;
        else {
          stable = 0;
          lastSig = sig;
        }
        var elapsed = Date.now() - started;
        var done =
          id === 'file' ? stable >= 2 || elapsed >= 300 : elapsed >= 40;
        if (!done) {
          setTimeout(poll, 30);
          return;
        }
        var items = [];
        try {
          items = walkMenuItems(item.querySelector('.menu-dropdown'), []);
        } catch (e) {
          items = [];
        }
        if (item.classList.contains('open')) {
          title.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
          );
        }
        document.documentElement.classList.remove('myhub-harvest');
        finish(items);
      };
      setTimeout(poll, 30);
    });
  }
  function requestMenuItems(id, seq) {
    if (!/^[a-z][a-z-]*$/.test(String(id || ''))) return;
    // 동시 요청은 직렬화한다 — 수확은 실제 메뉴를 여닫는 작업이라
    // 겹치면 서로의 DOM 상태를 어지럽힌다.
    harvestChain = harvestChain.then(function () {
      return harvestAndReply(id, seq);
    });
    harvestChain = harvestChain.catch(function () {});
  }
  function wireMenuHost() {
    if (menuHostWired) return true;
    var bar = document.getElementById('menu-bar');
    if (!bar) return false;
    var style = document.createElement('style');
    style.id = 'myhub-menu-host-style';
    style.textContent =
      '#menu-bar .menu-title{visibility:hidden}' +
      '#menu-bar{background:transparent;border-bottom-color:transparent}' +
      // 셸 메뉴 수확 중에는 실제 드롭다운이 보이면 안 된다. 특이도는
      // 셸 모드 스타일(#menu-bar .menu-dropdown visibility:visible)보다
      // 높게 잡아 수확 클래스가 이기게 한다.
      'html.myhub-harvest #menu-bar .menu-dropdown{visibility:hidden!important}' +
      // 네이티브 드롭다운(Finder 표면·폴백)의 결을 셸 드롭다운
      // (.dt-ctx-menu)과 같은 토큰으로 맞춘다 — 프로스티드 글래스·
      // 12px 라운드·헤어라인·파란 hover (기준: 실제 macOS 메뉴).
      '#menu-bar .menu-dropdown,#menu-bar .md-sub-panel{' +
      'background:rgba(250,250,252,.88)!important;' +
      'backdrop-filter:blur(24px) saturate(1.6)!important;' +
      '-webkit-backdrop-filter:blur(24px) saturate(1.6)!important;' +
      'border:1px solid rgba(15,23,42,.1)!important;border-radius:12px!important;' +
      'box-shadow:0 14px 38px rgba(15,23,42,.28)!important;padding:5px!important}' +
      '#menu-bar .md-item{border-radius:6px!important;' +
      'padding-top:6px!important;padding-bottom:6px!important;font-size:13.5px!important}' +
      '#menu-bar .md-item:hover{background:#0a84ff!important;color:#fff!important}' +
      '#menu-bar .md-item:hover .md-shortcut{color:rgba(255,255,255,.85)!important}' +
      '#menu-bar .md-shortcut{color:#9ca3af!important}' +
      '#menu-bar .md-item.disabled{color:#9ca3af!important}' +
      '#menu-bar .md-sep{margin:5px 10px!important;' +
      'border-top:1px solid rgba(15,23,42,.1)!important}';
    document.head.appendChild(style);
    document.documentElement.classList.add('myhub-menu-host');
    var observer = new MutationObserver(function () {
      reportMenus();
    });
    observer.observe(bar, {
      attributes: true,
      // 도구모음 토글의 펼침 상태는 aria-expanded로도 오가므로 함께
      // 관찰한다 (클래스만 보면 토글 보고가 늦게 따라간다).
      attributeFilter: ['class', 'aria-expanded'],
      subtree: true,
    });
    window.addEventListener('message', function (e) {
      if (e.origin !== window.location.origin) return;
      if (e.source !== window.parent) return;
      var d = e.data || {};
      if (d.type === 'myhub-hwp:menu-open') openMenu(d.id, d.x);
      else if (d.type === 'myhub-hwp:menu-shell' && d.adopted) {
        setShellAdopted();
      } else if (d.type === 'myhub-hwp:menu-toggle-toolbox') {
        toggleToolbox();
      } else if (d.type === 'myhub-hwp:menu-items-request') {
        requestMenuItems(d.id, d.seq);
      } else if (d.type === 'myhub-hwp:menu-exec') {
        execMenuItem(d.id, d.path);
      }
    });
    menuHostWired = true;
    window.__myhubMenuHostOk = 1;
    reportMenus();
    return true;
  }
  window.__myhubMenuHost = {
    enable: function () {
      if (wireMenuHost()) return;
      var tries = 0;
      var timer = setInterval(function () {
        if (wireMenuHost() || ++tries > 40) clearInterval(timer);
      }, 250);
    },
    // 셸(메인 상단바)이 한글 메뉴를 채택했을 때 호스트가 부른다 —
    // 메뉴바 띠를 높이 0으로 접는다 (멱등).
    setShellAdopted: function () {
      setShellAdopted();
    },
  };

  // ── 찾기 주입 (오피스 제목 줄 검색 캡슐, 2026-11-06 트랙 2) ──
  // Studio에는 찾기 상태가 실재한다: 편집 메뉴의 찾기(edit:find,
  // Ctrl+F)가 여는 모달리스 FindDialog다 (src/ui/find-dialog.ts).
  // 대화상자는 wasm.searchText로 일치를 세어 개수 라벨
  // (.find-dialog-match-count)에 표시하고, navigateToSearchHit가
  // 히트를 선택 영역으로 하이라이트하며 커서를 이동시킨다 — 캡슐이
  // 구동해야 할 "찾기 상태"는 바로 이것이다.
  // 주입 통로는 둘뿐이고 이 확장이 그 다리다:
  //  1) 대화상자 열기 — automation.execute('edit:find', …,
  //     { allowDialog: true }). edit:find는 opensDialog 커맨드라
  //     allowDialog 없이는 자동화가 거절(needs-dialog)하고, 질의를
  //     받는 파라미터는 커맨드 정의에 없다 (execute가 params를
  //     무시한다). 그래서 질의는 대화상자가 열린 뒤 그 입력 칸
  //     (.find-dialog-input)에 넣어 대화상자 자신의 검색을 태운다.
  //  2) 검색 실행 — 대화상자의 [다음 찾기] 버튼 클릭이 doSearch를
  //     그대로 부른다 (사용자가 누르는 것과 같은 경로). 값을 넣을
  //     때 input 이벤트를 함께 보내 대화상자 자체의 무효화(이전
  //     히트·개수 지우기)를 태운다 — 타이핑과 동등한 취급이다.
  // 결과는 대화상자의 개수 라벨이 정본 신호다: 읽으면 found/count를
  // myhub-hwp:find-result로 부모에게 보고한다. 라벨을 못 읽으면
  // 선택 하이라이트(.selection-highlight)의 실재로만 판정하고,
  // 어느 신호도 없으면 unavailable로 보고한다 (찾은 척 금지).
  // 호스트(finder-format-hwp.js)는 __myhubFind.search() 직접 호출이
  // 1차 경로이고, 닿지 않으면 myhub-hwp:find postMessage가 같은
  // 함수를 부른다 (forwardShellAdopted와 같은 이중 경로).
  function findDialogEl() {
    return document.querySelector('.find-dialog');
  }
  function reportFind(result) {
    postToParent({
      type: 'myhub-hwp:find-result',
      ok: !!result.ok,
      count: typeof result.count === 'number' ? result.count : null,
      query: result.query,
      reason: result.reason || null,
    });
  }
  function searchStudio(rawQuery) {
    var query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (!query) return { ok: false, reason: 'empty', count: null, query: query };
    var fail = function (reason) {
      var r = { ok: false, reason: reason, count: null, query: query };
      reportFind(r);
      return r;
    };
    var auto = window.rhwpStudio && window.rhwpStudio.automation;
    if (!auto || typeof auto.execute !== 'function') return fail('unavailable');
    var dlg = findDialogEl();
    if (!dlg) {
      var res = null;
      try {
        res = auto.execute('edit:find', undefined, { allowDialog: true });
      } catch (e) {
        res = null;
      }
      if (res && res.ok === false) return fail('unavailable');
      dlg = findDialogEl();
      if (!dlg) return fail('unavailable');
    }
    var input = dlg.querySelector('.find-dialog-input');
    if (!input) return fail('unavailable');
    if (input.value !== query) {
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var rows = dlg.querySelectorAll('.find-dialog-buttons');
    var btns = rows.length ? rows[0].querySelectorAll('.dialog-btn') : [];
    var nextBtn = btns.length >= 2 ? btns[1] : btns.length === 1 ? btns[0] : null;
    if (!nextBtn) return fail('unavailable');
    nextBtn.click();
    var count = null;
    var countEl = dlg.querySelector('.find-dialog-match-count');
    if (countEl && !countEl.hidden) {
      var m = String(countEl.textContent || '').match(/(\d+)/);
      if (m) count = parseInt(m[1], 10);
    }
    if (count !== null) {
      var byCount = {
        ok: count > 0,
        reason: count > 0 ? null : 'not-found',
        count: count,
        query: query,
      };
      reportFind(byCount);
      return byCount;
    }
    // 개수 라벨이 없으면 선택 하이라이트의 실재로만 판정한다.
    var hl = document.querySelectorAll('.selection-highlight');
    for (var i = 0; i < hl.length; i++) {
      var rect = hl[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        var byHl = { ok: true, reason: null, count: null, query: query };
        reportFind(byHl);
        return byHl;
      }
    }
    return fail('unavailable');
  }
  window.__myhubFind = { search: searchStudio };
  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin) return;
    if (e.source !== window.parent) return;
    var d = e.data || {};
    if (d.type === 'myhub-hwp:find' && typeof d.query === 'string') {
      searchStudio(d.query);
    }
  });
})();