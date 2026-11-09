/* rhwp 스튜디오 × MyHub 메뉴 호스트 브리지.
 *
 * 스튜디오의 메뉴바(#menu-bar)를 부모(office.html 의 finder-format-hwp)가
 * 셸 상단바에 호스팅할 수 있게 잇는 어댑터. 호스트 계약:
 *   스튜디오 → 부모
 *     { type: 'myhub-hwp:menus', menus: [{id, label}], open,
 *       toolbox: { expanded }, shellMenu }
 *     { type: 'myhub-hwp:menu-items', id, seq, items }
 *       items: { label, shortcut?, disabled?, checked?, children?, path }
 *              | { separator: true, path }
 *     { type: 'myhub-hwp:file-action', action: 'open' | 'save' | 'save-as' }
 *     { type: 'myhub-hwp:find-result', ok: false, reason: 'not-found' }
 *   부모 → 스튜디오
 *     { type: 'myhub-hwp:menu-shell', adopted: true } (또는 전역
 *       __myhubMenuHost.setShellAdopted() 직접 호출)
 *     { type: 'myhub-hwp:menu-items-request', id, seq }
 *     { type: 'myhub-hwp:menu-exec', id, path }
 *     { type: 'myhub-hwp:menu-open', id, x }
 *     { type: 'myhub-hwp:menu-toggle-toolbox' }
 *     { type: 'myhub-hwp:find', query } (또는 전역 __myhubFind.search())
 *
 * 메뉴 항목의 실행은 실제 포인터 이벤트 시퀀스를 항목 요소에 보내는
 * 방식으로 한다 — 스튜디오가 합성 click 만으로는 반응하지 않는 것을
 * 실측으로 확인했다. 서브메뉴 항목도 같은 방식으로 실행한다.
 */
(function () {
  'use strict';

  var ORIGIN = window.location.origin;
  var embedded = window.parent && window.parent !== window;
  var adopted = false;
  var hostSeen = false;
  var postTimer = null;

  function post(msg) {
    if (!embedded) return;
    try {
      window.parent.postMessage(msg, ORIGIN);
    } catch (e) {
      /* 부모가 없거나 닫힌 경우 무시 */
    }
  }

  function menuBar() {
    return document.querySelector('#menu-bar');
  }

  function toolboxToggle() {
    return document.querySelector('.menu-toolbox-toggle');
  }

  function toolboxExpanded() {
    var tog = toolboxToggle();
    if (!tog) return true;
    return tog.classList.contains('active');
  }

  function menusModel() {
    var bar = menuBar();
    if (!bar) return { menus: [], open: null };
    var menus = [];
    var open = null;
    var items = bar.querySelectorAll(':scope > .menu-item');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var title = it.querySelector(':scope > .menu-title');
      menus.push({
        id: it.getAttribute('data-menu') || '',
        label: title ? title.textContent.trim() : '',
      });
      if (it.classList.contains('open')) open = it.getAttribute('data-menu');
    }
    return { menus: menus, open: open };
  }

  function postMenus() {
    var model = menusModel();
    post({
      type: 'myhub-hwp:menus',
      menus: model.menus,
      open: model.open,
      toolbox: { expanded: toolboxExpanded() },
      shellMenu: !!embedded,
    });
  }

  function schedulePostMenus() {
    if (postTimer) return;
    postTimer = setTimeout(function () {
      postTimer = null;
      postMenus();
    }, 180);
  }

  /* ── 메뉴 항목 트리 ─────────────────────────────── */

  function labelOf(el) {
    var lab = el.querySelector(':scope > .md-label');
    return lab ? lab.textContent.trim() : '';
  }

  function entriesOf(container) {
    var out = [];
    if (!container) return out;
    var subCount = 0;
    var kids = container.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.classList.contains('md-sep')) {
        out.push({ kind: 'sep', el: el, token: 'sep:' + i });
      } else if (el.classList.contains('md-item')) {
        out.push({
          kind: 'item',
          el: el,
          token: el.getAttribute('data-cmd') || 'item:' + i,
        });
      } else if (el.classList.contains('md-sub')) {
        out.push({ kind: 'sub', el: el, token: 'sub:' + subCount++ });
      }
    }
    return out;
  }

  function panelOf(subEl) {
    return subEl.querySelector('.md-sub-panel');
  }

  function buildItems(container, basePath) {
    var items = [];
    var entries = entriesOf(container);
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      var path = basePath.concat([en.token]);
      if (en.kind === 'sep') {
        items.push({ separator: true, path: path });
      } else if (en.kind === 'item') {
        var item = { label: labelOf(en.el), path: path };
        var sc = en.el.querySelector(':scope > .md-shortcut');
        if (sc && sc.textContent.trim()) item.shortcut = sc.textContent.trim();
        if (en.el.classList.contains('disabled')) item.disabled = true;
        if (en.el.classList.contains('active')) item.checked = true;
        items.push(item);
      } else {
        items.push({
          label: labelOf(en.el),
          path: path,
          children: buildItems(panelOf(en.el), path),
        });
      }
    }
    return items;
  }

  function dropdownOf(menuId) {
    var bar = menuBar();
    if (!bar) return null;
    var menu = bar.querySelector('.menu-item[data-menu="' + menuId + '"]');
    return menu ? menu.querySelector(':scope > .menu-dropdown') : null;
  }

  function itemsFor(menuId) {
    return buildItems(dropdownOf(menuId), []);
  }

  /* 항목 회신: 채택 상태에서는 메뉴를 보이지 않게 한 번 열었다가
     긁는다 — 스튜디오는 메뉴를 열 때 항목 상태를 현재 문서 상태로
     갱신하므로, 열지 않고 긁으면 disabled가 낡은 값으로 나간다
     (실행 취소 직후 '다시 실행'이 꺼진 채로 보이는 문제). */
  function replyItems(menuId, seq) {
    function send() {
      post({
        type: 'myhub-hwp:menu-items',
        id: menuId,
        seq: seq,
        items: itemsFor(menuId),
      });
    }
    var bar = menuBar();
    if (!adopted || !bar) {
      send();
      return;
    }
    var menu = bar.querySelector('.menu-item[data-menu="' + menuId + '"]');
    var title = menu ? menu.querySelector(':scope > .menu-title') : null;
    if (!menu || !title) {
      send();
      return;
    }
    var wasOpen = menu.classList.contains('open');
    bar.style.visibility = 'hidden';
    bar.style.display = '';
    if (!wasOpen) fireSeq(title);
    setTimeout(function () {
      send();
      if (!wasOpen) fireSeq(title);
      bar.style.display = 'none';
      bar.style.visibility = '';
    }, 130);
  }

  function resolveEl(menuId, path) {
    var container = dropdownOf(menuId);
    var current = null;
    for (var depth = 0; depth < (path || []).length; depth++) {
      var entries = entriesOf(container);
      current = null;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].token === path[depth]) {
          current = entries[i];
          break;
        }
      }
      if (!current) return null;
      if (current.kind === 'sub') container = panelOf(current.el);
    }
    return current ? current.el : null;
  }

  /* ── 실행 ─────────────────────────────────────── */

  function fireSeq(el) {
    if (!el) return;
    var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      var ev;
      if (t.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
        ev = new PointerEvent(t, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          view: window,
        });
      } else {
        ev = new MouseEvent(t, {
          bubbles: true,
          cancelable: true,
          view: window,
        });
      }
      el.dispatchEvent(ev);
    }
  }

  function execMenuItem(menuId, path) {
    if (!resolveEl(menuId, path)) return;
    var bar = menuBar();
    if (!bar) return;
    /* 스튜디오는 메뉴가 실제로 렌더된(열린) 상태에서만 항목 명령을
       실행한다 — display:none 서브트리로 보낸 이벤트는 무시됨을 실측.
       채택 상태에서는 바를 보이지 않게(visibility) 잠시 되돌려
       메뉴를 열고 실행한 뒤 다시 숨긴다. */
    var restore = null;
    if (adopted) {
      bar.style.visibility = 'hidden';
      bar.style.display = '';
      restore = function () {
        bar.style.display = 'none';
        bar.style.visibility = '';
      };
    }
    var menu = bar.querySelector('.menu-item[data-menu="' + menuId + '"]');
    var title = menu ? menu.querySelector(':scope > .menu-title') : null;
    if (menu && !menu.classList.contains('open') && title) fireSeq(title);
    setTimeout(function () {
      /* 메뉴가 열린 뒤 항목을 다시 찾는다 — 스튜디오는 메뉴를 열 때
         항목의 disabled 상태를 현재 문서 상태로 갱신하므로, 열기 전의
         노드·상태로 판정하면 방금 활성화된 항목(예: 실행 취소 직후의
         다시 실행)을 놓친다. */
      var el = resolveEl(menuId, path);
      if (!el || el.classList.contains('disabled')) {
        if (restore) restore();
        schedulePostMenus();
        return;
      }
      // 서브메뉴 항목이면 조상 서브를 먼저 연다
      var chain = [];
      var node = el.parentElement;
      while (node && node !== bar) {
        if (node.classList && node.classList.contains('md-sub')) chain.unshift(node);
        node = node.parentElement;
      }
      for (var i = 0; i < chain.length; i++) {
        var sub = chain[i];
        sub.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
        );
        sub.dispatchEvent(
          new MouseEvent('mouseenter', { bubbles: true, cancelable: true }),
        );
      }
      setTimeout(function () {
        fireSeq(el);
        setTimeout(function () {
          if (restore) restore();
          schedulePostMenus();
        }, 80);
      }, chain.length ? 140 : 30);
    }, 130);
  }

  function openMenu(menuId) {
    var bar = menuBar();
    if (!bar) return;
    var menu = bar.querySelector('.menu-item[data-menu="' + menuId + '"]');
    if (!menu || menu.classList.contains('open')) return;
    var title = menu.querySelector(':scope > .menu-title');
    fireSeq(title || menu);
    schedulePostMenus();
  }

  /* ── 셸 채택 ──────────────────────────────────── */

  function adopt() {
    if (adopted) return;
    adopted = true;
    document.documentElement.classList.add('myhub-hwp-adopted');
    var bar = menuBar();
    if (bar) bar.style.display = 'none';
    postMenus();
  }

  /* ── 파일 동작 위임 ───────────────────────────── */

  var FILE_ACTIONS = {
    'file:open': 'open',
    'file:save': 'save',
    'file:save-as': 'save-as',
  };

  document.addEventListener(
    'click',
    function (e) {
      if (!embedded) return;
      var t = e.target;
      var item =
        t && typeof t.closest === 'function' ? t.closest('.md-item') : null;
      if (!item) return;
      var action = FILE_ACTIONS[item.getAttribute('data-cmd') || ''];
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'myhub-hwp:file-action', action: action });
    },
    true,
  );

  /* ── 찾기 ─────────────────────────────────────── */

  function findInput() {
    return document.querySelector(
      '#find-bar input, .find-bar input, [class*="find-panel"] input, ' +
        '[class*="findbar"] input, input[placeholder*="찾기"]',
    );
  }

  function setInputValue(input, value) {
    var proto =
      window.HTMLInputElement && window.HTMLInputElement.prototype;
    var setter =
      proto && Object.getOwnPropertyDescriptor(proto, 'value')
        ? Object.getOwnPropertyDescriptor(proto, 'value').set
        : null;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(input) {
    var opts = {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
    };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function runFind(query) {
    var input = findInput();
    if (!input) {
      var findItem = document.querySelector(
        '#menu-bar .md-item[data-cmd="edit:find"]',
      );
      if (!findItem) return { ok: false, reason: 'unavailable' };
      execMenuItem('edit', ['edit:find']);
    }
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var el = findInput();
      if (el) {
        clearInterval(timer);
        el.focus();
        setInputValue(el, query);
        pressEnter(el);
        setTimeout(reportNotFound, 600);
      } else if (tries >= 14) {
        clearInterval(timer);
      }
    }, 100);
    return { ok: true };
  }

  function reportNotFound() {
    var text = document.body ? document.body.textContent || '' : '';
    var bar = document.querySelector(
      '#find-bar, .find-bar, [class*="find-panel"], [class*="findbar"]',
    );
    var scope = bar ? bar.textContent || '' : '';
    if (
      /0\s*\/\s*0/.test(scope) ||
      scope.indexOf('찾을 수 없') >= 0 ||
      scope.indexOf('없습니다') >= 0 ||
      (scope === '' && text.indexOf('찾을 수 없습니다') >= 0)
    ) {
      post({ type: 'myhub-hwp:find-result', ok: false, reason: 'not-found' });
    }
  }

  /* ── 부모 메시지 ──────────────────────────────── */

  window.addEventListener('message', function (e) {
    if (!embedded) return;
    if (e.origin !== ORIGIN || e.source !== window.parent) return;
    hostSeen = true;
    var d = e.data || {};
    if (d.type === 'myhub-hwp:menu-shell') {
      if (d.adopted) adopt();
    } else if (d.type === 'myhub-hwp:menu-items-request') {
      replyItems(d.id, d.seq);
    } else if (d.type === 'myhub-hwp:menu-exec') {
      execMenuItem(d.id, d.path);
    } else if (d.type === 'myhub-hwp:menu-open') {
      openMenu(d.id);
    } else if (d.type === 'myhub-hwp:menu-toggle-toolbox') {
      var tog = toolboxToggle();
      if (tog) {
        tog.click();
        setTimeout(postMenus, 60);
      }
    } else if (d.type === 'myhub-hwp:find') {
      if (typeof d.query === 'string' && d.query) runFind(d.query);
    }
  });

  window.__myhubMenuHost = {
    setShellAdopted: adopt,
    postMenus: postMenus,
  };
  window.__myhubFind = {
    search: function (query) {
      if (typeof query !== 'string' || !query) {
        return { ok: false, reason: 'unavailable' };
      }
      return runFind(query);
    },
  };

  /* ── 시작 ─────────────────────────────────────── */

  function init() {
    var bar = menuBar();
    if (!bar) return false;
    postMenus();
    var observer = new MutationObserver(schedulePostMenus);
    observer.observe(bar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    var tog = toolboxToggle();
    if (tog) {
      observer.observe(tog, {
        attributes: true,
        attributeFilter: ['class', 'aria-label'],
      });
      tog.addEventListener('click', function () {
        setTimeout(postMenus, 60);
      });
    }
    window.addEventListener('load', function () {
      setTimeout(postMenus, 300);
      setTimeout(postMenus, 1800);
    });
    /* 채택되기 전까지는 주기적으로 메뉴를 다시 알린다 — 호스트의
       청취 등록·셸 협상 순서와 무관하게 닿게 하기 위함. */
    var beat = 0;
    var heartbeat = setInterval(function () {
      beat++;
      if (adopted || beat > 40) {
        clearInterval(heartbeat);
        return;
      }
      postMenus();
    }, 1500);
    return true;
  }

  if (!init()) {
    var bootObserver = new MutationObserver(function () {
      if (init()) bootObserver.disconnect();
    });
    bootObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
    });
    setTimeout(function () {
      bootObserver.disconnect();
    }, 30000);
  }
})();
