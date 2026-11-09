/* MyHub 데스크톱 셸 전용 상단 메뉴바 컨트롤러 (menubar.js)
 *
 * macOS의 메뉴바를 흉내 낸 단일 구현. 드롭다운 렌더링 자체는 menu.js의
 * createMenu가 담고, 이 컨트롤러는 트리거(일반 버튼) 관리만 한다:
 * - 트리거 3종: JN(시스템 메뉴) · 활성 앱 이름(앱 메뉴) · 앱 메뉴들.
 * - 트리거를 누르면 바로 아래에 드롭다운이 열리고(설정 메뉴와 같은
 *   거동), 열린 채로 다른 트리거를 hover하면 그 메뉴로 전환한다.
 * - 항목은 메뉴를 열 때마다 새로 해석한다 — 목록의 기능(동적으로 바뀌는
 *   목록 등)의 최신 상태를 그대로 드롭다운 안에 렌더링하기 위함이다.
 * - compact(좁은 폭)에서는 첫 메뉴만 남기고 나머지를 "더 보기"로 접는다.
 *
 * 앱 메뉴의 인수 계약 (windows.js가 의존하고, 오피스 메뉴와 같은
 * 형태로 넣을 수 있다):
 *   setMenus([{ label, items }, ...])
 *   items: 배열 또는 () => 배열. 항목은 앱 공용 드롭다운 항목 형태:
 *   { label, sub?, shortcut?, icon?, danger?, disabled?: boolean|fn,
 *     checked?: boolean|fn, onSelect?: fn } 또는 { separator: true }.
 *   disabled/checked는 함수면 열 때 평가한다.
 *
 * deps = { doc, menuApi: { createMenu }, refreshIcons?,
 *          jnEl?, appEl?, menusEl }
 * 반환: { setChrome, setMenus, close, isOpen, destroy }
 *   setChrome({ jnItems, appItems }) — JN/앱 메뉴 항목(배열|함수|null).
 *     null이면 해당 트리거는 메뉴로 동작하지 않는다.
 *   setMenus(defs|null, { compact }) — null이면 앱 메뉴 영역을 비운다
 *     (종전 버튼 호환 콜백이 컨테이너를 직접 쓰는 경우).
 * 노출: window.MyHubDesktopMenuBar = { createMenuBar }
 */
(function () {
  'use strict';

  var TRIGGER_SEL = '[data-menubar-trigger]';

  function createMenuBar(deps) {
    deps = deps || {};
    var doc = deps.doc;
    var menu =
      deps.menuApi && typeof deps.menuApi.createMenu === 'function'
        ? deps.menuApi.createMenu(doc, { refreshIcons: deps.refreshIcons })
        : null;
    var triggers = []; // { el, kind, getItems }
    var openTrigger = null;
    var destroyed = false;

    function warn(msg, e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(msg, e || '');
      }
    }

    function evalFlag(v) {
      if (typeof v === 'function') {
        try {
          return !!v();
        } catch (e) {
          warn('메뉴 항목 상태 평가 실패:', e);
          return false;
        }
      }
      return !!v;
    }

    // 항목 해석: 함수면 호출하고, disabled/checked를 값으로 굳힌다.
    function resolveItems(getItems) {
      var raw = null;
      try {
        raw = typeof getItems === 'function' ? getItems() : getItems;
      } catch (e) {
        warn('메뉴 항목 해석 실패:', e);
        return [];
      }
      if (!Array.isArray(raw)) return [];
      var out = [];
      raw.forEach(function (item) {
        if (!item) return;
        if (item.separator) {
          out.push({ separator: true });
          return;
        }
        if (typeof item.label !== 'string') return;
        out.push({
          label: item.label,
          sub: item.sub,
          shortcut: item.shortcut,
          icon: item.icon,
          danger: !!item.danger,
          heading: !!item.heading,
          disabled: evalFlag(item.disabled),
          checked:
            typeof item.checked === 'undefined'
              ? undefined
              : evalFlag(item.checked),
          onSelect: item.onSelect,
        });
      });
      // 앞뒤 구분선 정리 (해석 결과 앞/뒤에 붙은 구분선은 의미가 없다)
      while (out.length && out[0].separator) out.shift();
      while (out.length && out[out.length - 1].separator) out.pop();
      return out;
    }

    function markClosed(tr) {
      tr.el.classList.remove('is-open');
      tr.el.setAttribute('aria-expanded', 'false');
      if (openTrigger === tr) openTrigger = null;
    }

    function close() {
      if (menu) menu.close();
      if (openTrigger) markClosed(openTrigger);
    }

    function openTr(tr) {
      if (!menu || destroyed) return;
      var items = resolveItems(tr.getItems);
      if (!items.length) {
        close();
        return;
      }
      var rect =
        typeof tr.el.getBoundingClientRect === 'function'
          ? tr.el.getBoundingClientRect()
          : { left: 0, bottom: 0 };
      var prev = openTrigger;
      openTrigger = tr;
      tr.el.classList.add('is-open');
      tr.el.setAttribute('aria-expanded', 'true');
      menu.open(rect.left, rect.bottom, items, {
        keepSelector: TRIGGER_SEL,
        onSwitch: function (dir) {
          step(dir);
        },
        onClose: function () {
          markClosed(tr);
        },
      });
      // open() 내부에서 직전 메뉴가 닫히면 onClose가 발화해 openTrigger가
      // 지워졌을 수 있다 — 방금 연 트리거로 다시 고정한다.
      openTrigger = tr;
      if (prev && prev !== tr) {
        prev.el.classList.remove('is-open');
        prev.el.setAttribute('aria-expanded', 'false');
      }
    }

    function step(dir) {
      if (!openTrigger) return;
      var idx = triggers.indexOf(openTrigger);
      if (idx < 0) return;
      var next = idx + dir;
      if (next < 0 || next >= triggers.length) return;
      openTr(triggers[next]);
    }

    function menuOpen() {
      return !!(menu && typeof menu.isOpen === 'function' && menu.isOpen());
    }

    function toggleTr(tr) {
      if (openTrigger === tr && menuOpen()) {
        close();
        return;
      }
      openTr(tr);
    }

    function bindTrigger(el, kind, getItems) {
      var tr = { el: el, kind: kind, getItems: getItems };
      el.setAttribute('data-menubar-trigger', '');
      el.setAttribute('aria-haspopup', 'true');
      el.setAttribute('aria-expanded', 'false');
      tr.onClick = function (e) {
        if (kind === 'jn') e.preventDefault(); // JN 링크의 페이지 이동 방지
        toggleTr(tr);
      };
      tr.onEnter = function () {
        if (openTrigger && openTrigger !== tr && menuOpen()) {
          openTr(tr);
        }
      };
      el.addEventListener('click', tr.onClick);
      el.addEventListener('pointerenter', tr.onEnter);
      triggers.push(tr);
      return tr;
    }

    function unbindAll() {
      close();
      triggers.forEach(function (tr) {
        tr.el.removeEventListener('click', tr.onClick);
        tr.el.removeEventListener('pointerenter', tr.onEnter);
        tr.el.classList.remove('is-open');
        tr.el.removeAttribute('aria-expanded');
      });
      triggers = triggers.filter(function (tr) {
        return tr.kind === 'jn' || tr.kind === 'app';
      });
    }

    function setChrome(chrome) {
      chrome = chrome || {};
      // JN/앱 트리거는 한 번만 바인딩하고 항목만 갈아 끼운다.
      [
        { el: deps.jnEl, kind: 'jn', items: chrome.jnItems },
        { el: deps.appEl, kind: 'app', items: chrome.appItems },
      ].forEach(function (spec) {
        if (!spec.el) return;
        var existing = null;
        triggers.forEach(function (tr) {
          if (tr.kind === spec.kind) existing = tr;
        });
        if (spec.items == null) {
          if (existing) {
            existing.getItems = null;
            existing.el.removeAttribute('data-menubar-trigger');
          }
          return;
        }
        if (existing) {
          existing.getItems = spec.items;
          existing.el.setAttribute('data-menubar-trigger', '');
        } else {
          bindTrigger(spec.el, spec.kind, spec.items);
        }
      });
    }

    function setMenus(defs, opts) {
      // 앱 메뉴 버튼만 다시 만든다 (JN/앱 트리거는 setChrome이 소유).
      triggers
        .filter(function (tr) {
          return tr.kind === 'menu' || tr.kind === 'overflow';
        })
        .forEach(function (tr) {
          tr.el.removeEventListener('click', tr.onClick);
          tr.el.removeEventListener('pointerenter', tr.onEnter);
        });
      triggers = triggers.filter(function (tr) {
        return tr.kind === 'jn' || tr.kind === 'app';
      });
      close();
      var box = deps.menusEl;
      if (box) box.textContent = '';
      if (!defs || !defs.length || !box) return;
      var compact = !!(opts && opts.compact);
      var visible = defs;
      var folded = [];
      if (compact && defs.length > 1) {
        visible = defs.slice(0, 1);
        folded = defs.slice(1);
      }
      visible.forEach(function (def) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'myhub-menubar-btn';
        btn.textContent = def.label;
        box.appendChild(btn);
        bindTrigger(btn, 'menu', def.items);
      });
      if (folded.length) {
        var more = doc.createElement('button');
        more.type = 'button';
        more.className = 'myhub-menubar-btn myhub-menubar-more';
        more.textContent = '···';
        more.setAttribute('aria-label', '더 보기');
        box.appendChild(more);
        bindTrigger(more, 'overflow', function () {
          var items = [];
          folded.forEach(function (def, i) {
            if (i > 0) items.push({ separator: true });
            items.push({ label: def.label, heading: true });
            resolveItems(def.items).forEach(function (it) {
              items.push(it);
            });
          });
          return items;
        });
      }
    }

    function isOpen() {
      return menuOpen();
    }

    function destroy() {
      destroyed = true;
      unbindAll();
      if (deps.menusEl) deps.menusEl.textContent = '';
    }

    return {
      setChrome: setChrome,
      setMenus: setMenus,
      close: close,
      isOpen: isOpen,
      destroy: destroy,
    };
  }

  var api = { createMenuBar: createMenuBar };
  if (typeof window !== 'undefined') window.MyHubDesktopMenuBar = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopMenuBar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
