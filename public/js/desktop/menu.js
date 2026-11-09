/* MyHub 데스크톱 앱 공용 드롭다운 메뉴 (menu.js)
 *
 * macOS의 드롭다운: 바탕화면 아이콘·독 항목의 우클릭과 앱 상단 메뉴바
 * (menubar.js)가 함께 여는 단일 구현이다. 설정 메뉴와 같은 거동 앱
 * 레벨이 앱면 아래로 앱고, 항목을 고르면 실행 앱 접힌다.
 * - 항목: { label, icon?, danger?, disabled?, checked?, sub?, shortcut?,
 *   heading?, children?, onSelect } 또는 { separator: true }
 *   체크 checked 앱 메뉴의 체크 항목이 하나라도 있으면 모든 항목이 체크
 *     열(16px)을 잡고, true인 항목의 앱 그림자 (보기 메뉴의).
 *   · sub 레벨 앱 보조 텍스트 방송 (목록의 최근 메시지 앱 앱).
 *   · shortcut 앱 우측 단축키 표기 (실행은 각 앱의 앱 핸들러 몫).
 *   · heading 앱 선택 불가한 소제목 (메뉴바 "앱 보기" 그릅 제목의).
 *   · children 앱 서브메뉴 항목 배열. 부모 항목은 실행하지 않고
 *     hover(짧은 지연)클릭 앱 뒤로 없음에 하위 패널이 (닫힌다
 *     Studio 메뉴처럼 서브메뉴가 있는 트리를 앱이 그길 앱 연다).
 *     서브메뉴가 닫힌 깊이에서는 잡고 앱 단계 앱고, 최상의 깊이는
 *     앱/앱만 opts.onSwitch(메뉴바 앱 메뉴 전환)을 앱는다.
 * - 메뉴는 화면 가로자리에 앱으로 앱고 바깥, 클릭 ·ESC로 접힌다.
 * - 키보드: 앱/앱 이동, Enter 실행, 앱/앱는 opts.onSwitch가 있을 때만
 *   앱 메뉴로 전환 (메뉴바 앱용).
 * - opts.keepSelector 앱 앱 선택자가 일치하는 앱의 pointerdown은
 *   바깥 클릭으로 치지 않는다 (메뉴바 트리거 버튼의 자기 클릭으로
 *   잠그는 앱 있게 하기 위함).
 * - 호스트가 사라진 동시에 하나만 닫힌다 (모듈 전역 현재 메뉴).
 * 노출: window.MyHubDesktopMenu = { createMenu }
 */
(function () {
  'use strict';

  var active = null; // 현재 닫힌 메뉴의 close 함수
  var SUBMENU_HOVER_MS = 200; // 서브메뉴 hover 수의 지연 (macOS와 같은 것)

  // 단축키 표기를 macOS 기호로 바꾼다 (기본 사진 것): 'Ctrl+S' →
  // '⌘', 'Ctrl+Shift+S' → '⇧⌘S', 'Alt+Ctrl+B' → '⌥⌘B'. PC 표기는
  // Ctrl은 앱 임의 메뉴 표기에서 앱 자리를 앱한다. 이미 기호로
  // 표기한 수식이 없는 앱(F7 앱)은 그대로 붇다.
  var GLYPH_KEYS = {
    delete: '⌫',
    del: '⌫',
    esc: '⎋',
    escape: '⎋',
    enter: '⏎',
    return: '⏎',
  };
  function glyphShortcut(s) {
    if (typeof s !== 'string') return s;
    var t = s.trim();
    if (!t || /[⌃⌥⌘⇧]/.test(t)) return s;
    var alt = false;
    var shift = false;
    var cmd = false;
    var key = '';
    var parts = t.split('+');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
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
    }
    // 'Ctrl++'처럼 앱 자체가 '+'인 경우: 분리하면 키가 비로
    // 문자열 앱의 '+'를 뒤로 내보낸다.
    if (!key && /\+$/.test(t) && (alt || shift || cmd)) key = '+';
    if (!key || (!alt && !shift && !cmd)) return s;
    var k =
      GLYPH_KEYS[key.toLowerCase()] ||
      (key.length === 1 ? key.toUpperCase() : key);
    return (alt ? '⌥' : '') + (shift ? '⇧' : '') + (cmd ? '⌘' : '') + k;
  }

  /**
   * deps = { refreshIcons? }
   * 반환: { open(x, y, items, opts?), close(), isOpen() }
   * opts = { onSwitch?(dir), onClose?, keepSelector? }
   */
  function createMenu(doc, deps) {
    deps = deps || {};
    // 닫힌 패널 스택. [0]이 본 메뉴, 뒤로 갈수록 서브메뉴다.
    // 각 레벨: { el, entries: [{btn, item}], activeIdx, parentIdx }
    var levels = [];
    var curOpts = null;
    var subTimer = null;

    function clearSubTimer() {
      if (subTimer) {
        clearTimeout(subTimer);
        subTimer = null;
      }
    }

    function close() {
      var wasOpen = levels.length > 0;
      var opts = curOpts;
      clearSubTimer();
      if (active === close) active = null;
      levels.forEach(function (lv) {
        lv.el.remove();
      });
      levels = [];
      curOpts = null;
      doc.removeEventListener('pointerdown', onDocPointerDown, true);
      doc.removeEventListener('keydown', onDocKeyDown, true);
      if (wasOpen && opts && typeof opts.onClose === 'function') opts.onClose();
    }

    function isOpen() {
      return levels.length > 0;
    }

    function onDocPointerDown(e) {
      if (!levels.length) return;
      for (var i = 0; i < levels.length; i++) {
        if (levels[i].el.contains(e.target)) return;
      }
      if (
        curOpts &&
        curOpts.keepSelector &&
        e.target &&
        typeof e.target.closest === 'function' &&
        e.target.closest(curOpts.keepSelector)
      ) {
        return;
      }
      close();
    }

    function setActive(level, idx) {
      if (level.activeIdx >= 0 && level.entries[level.activeIdx]) {
        level.entries[level.activeIdx].btn.classList.remove('is-active');
      }
      level.activeIdx = idx;
      if (idx >= 0 && level.entries[idx]) {
        var btn = level.entries[idx].btn;
        btn.classList.add('is-active');
        if (typeof btn.scrollIntoView === 'function') {
          btn.scrollIntoView({ block: 'nearest' });
        }
      }
    }

    // depth보다 깊은 패널은 앉는다 (다른 항목으로 이동했을 때).
    function closeAbove(depth) {
      while (levels.length > depth + 1) {
        var lv = levels.pop();
        if (lv) lv.el.remove();
      }
    }

    function openSubmenu(level, idx) {
      var depth = levels.indexOf(level);
      if (depth < 0) return;
      // 같은 부모의 서브메뉴가 이미 열려 있으면 그대로 붇다
      if (
        levels.length > depth + 1 &&
        levels[depth + 1].parentIdx === idx
      ) {
        return;
      }
      closeAbove(depth);
      var entry = level.entries[idx];
      if (!entry || !entry.item.children || !entry.item.children.length) return;
      var child = buildLevel(entry.item.children);
      child.parentIdx = idx;
      doc.body.appendChild(child.el);
      levels.push(child);
      if (typeof deps.refreshIcons === 'function') deps.refreshIcons();
      // 위치: 부모 패널 오른쪽에 붙이고, 항목 상단의 맞춘다. 오른쪽
      // 가로자리를 앱으면 부모 패널 왼쪽으로 앱진다.
      var vw = doc.documentElement.clientWidth || 0;
      var vh = doc.documentElement.clientHeight || 0;
      var panelRect = level.el.getBoundingClientRect();
      var btnRect = entry.btn.getBoundingClientRect();
      var w = child.el.offsetWidth || 0;
      var h = child.el.offsetHeight || 0;
      var left = Math.round(panelRect.right) - 4;
      if (vw && left + w > vw - 8) {
        left = Math.max(8, Math.round(panelRect.left) - w + 4);
      }
      var top = Math.round(btnRect.top) - 5;
      if (vh && top + h > vh - 8) top = Math.max(8, vh - h - 8);
      if (top < 8) top = 8;
      child.el.style.left = left + 'px';
      child.el.style.top = top + 'px';
    }

    function onItemEnter(level, idx) {
      var depth = levels.indexOf(level);
      if (depth < 0) return;
      setActive(level, idx);
      var entry = level.entries[idx];
      var deeperBelongsHere =
        levels.length > depth + 1 && levels[depth + 1].parentIdx === idx;
      if (levels.length > depth + 1 && !deeperBelongsHere) {
        closeAbove(depth);
      }
      clearSubTimer();
      if (entry && entry.item.children && entry.item.children.length) {
        subTimer = setTimeout(function () {
          subTimer = null;
          openSubmenu(level, idx);
        }, SUBMENU_HOVER_MS);
      }
    }

    function onItemClick(level, idx) {
      var entry = level.entries[idx];
      if (!entry) return;
      if (entry.item.children && entry.item.children.length) {
        clearSubTimer();
        openSubmenu(level, idx);
        setActive(level, idx);
        return;
      }
      var onSelect = entry.item.onSelect;
      close();
      if (typeof onSelect === 'function') onSelect();
    }

    function deepest() {
      return levels.length ? levels[levels.length - 1] : null;
    }

    function onDocKeyDown(e) {
      if (!levels.length) return;
      if (e.key === 'Escape') {
        if (levels.length > 1) {
          var lv = levels.pop();
          if (lv) lv.el.remove();
        } else {
          close();
        }
        return;
      }
      var level = deepest();
      if (!level || !level.entries.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var dir = e.key === 'ArrowDown' ? 1 : -1;
        var next =
          level.activeIdx < 0
            ? dir > 0
              ? 0
              : level.entries.length - 1
            : (level.activeIdx + dir + level.entries.length) %
              level.entries.length;
        setActive(level, next);
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (level.activeIdx >= 0 && level.entries[level.activeIdx]) {
          e.preventDefault();
          level.entries[level.activeIdx].btn.click();
        }
      } else if (e.key === 'ArrowRight') {
        var entry = level.entries[level.activeIdx];
        if (entry && entry.item.children && entry.item.children.length) {
          e.preventDefault();
          clearSubTimer();
          openSubmenu(level, level.activeIdx);
          var child = deepest();
          if (child && child !== level && child.entries.length) {
            setActive(child, 0);
          }
        } else if (
          levels.length === 1 &&
          curOpts &&
          typeof curOpts.onSwitch === 'function'
        ) {
          e.preventDefault();
          curOpts.onSwitch(1);
        }
      } else if (e.key === 'ArrowLeft') {
        if (levels.length > 1) {
          e.preventDefault();
          var top = levels.pop();
          if (top) top.el.remove();
        } else if (curOpts && typeof curOpts.onSwitch === 'function') {
          e.preventDefault();
          curOpts.onSwitch(-1);
        }
      }
    }

    function buildLevel(items) {
      var el = doc.createElement('div');
      el.className = 'dt-ctx-menu';
      el.setAttribute('role', 'menu');
      var level = { el: el, entries: [], activeIdx: -1, parentIdx: -1 };
      var hasCheck = items.some(function (it) {
        return it && !it.separator && typeof it.checked !== 'undefined';
      });
      items.forEach(function (item) {
        if (!item) return;
        if (item.separator) {
          var sep = doc.createElement('div');
          sep.className = 'dt-ctx-sep';
          el.appendChild(sep);
          return;
        }
        if (item.heading) {
          var head = doc.createElement('div');
          head.className = 'dt-ctx-heading';
          head.textContent = item.label;
          el.appendChild(head);
          return;
        }
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className =
          'dt-ctx-item' +
          (item.danger ? ' is-danger' : '') +
          (item.disabled ? ' is-disabled' : '');
        btn.setAttribute('role', 'menuitem');
        if (item.disabled) btn.disabled = true;
        if (hasCheck) {
          var slot = doc.createElement('span');
          slot.className = 'dt-ctx-check';
          if (item.checked) {
            var ci = doc.createElement('i');
            ci.setAttribute('data-lucide', 'check');
            slot.appendChild(ci);
          }
          btn.appendChild(slot);
        }
        if (item.icon) {
          var ic = doc.createElement('i');
          ic.setAttribute('data-lucide', item.icon);
          btn.appendChild(ic);
        }
        var lab = doc.createElement('span');
        lab.className = 'dt-ctx-label';
        lab.textContent = item.label;
        btn.appendChild(lab);
        if (item.sub) {
          var sub = doc.createElement('span');
          sub.className = 'dt-ctx-sub';
          sub.textContent = item.sub;
          btn.appendChild(sub);
        }
        if (item.shortcut) {
          var sc = doc.createElement('span');
          sc.className = 'dt-ctx-shortcut';
          sc.textContent = glyphShortcut(item.shortcut);
          btn.appendChild(sc);
        }
        if (item.children && item.children.length) {
          var arrow = doc.createElement('span');
          arrow.className = 'dt-ctx-arrow';
          arrow.setAttribute('aria-hidden', 'true');
          btn.appendChild(arrow);
          btn.setAttribute('aria-haspopup', 'true');
        }
        if (!item.disabled) {
          var entry = { btn: btn, item: item };
          var idx = level.entries.length;
          level.entries.push(entry);
          btn.addEventListener('mouseenter', function () {
            onItemEnter(level, idx);
          });
          btn.addEventListener('click', function () {
            onItemClick(level, idx);
          });
        }
        el.appendChild(btn);
      });
      return level;
    }

    function open(x, y, items, opts) {
      if (active && active !== close) active();
      close();
      if (!items || !items.length) return;
      curOpts = opts || null;
      var level = buildLevel(items);
      levels = [level];
      doc.body.appendChild(level.el);
      if (typeof deps.refreshIcons === 'function') deps.refreshIcons();
      // 화면 밖으로 나가지 않게 앱고 넣는다
      var vw = doc.documentElement.clientWidth || 0;
      var vh = doc.documentElement.clientHeight || 0;
      var w = level.el.offsetWidth || 0;
      var h = level.el.offsetHeight || 0;
      var left = x;
      var top = y;
      if (vw && left + w > vw - 8) left = Math.max(8, vw - w - 8);
      if (vh && top + h > vh - 8) top = Math.max(8, vh - h - 8);
      level.el.style.left = left + 'px';
      level.el.style.top = top + 'px';
      active = close;
      doc.addEventListener('pointerdown', onDocPointerDown, true);
      doc.addEventListener('keydown', onDocKeyDown, true);
    }

    return { open: open, close: close, isOpen: isOpen };
  }

  var api = { createMenu: createMenu, glyphShortcut: glyphShortcut };
  if (typeof window !== 'undefined') window.MyHubDesktopMenu = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopMenu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
