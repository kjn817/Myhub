/* MyHub 데스크톱 워크스페이스 — 창 DOM 관리자 (windows.js)
 *
 * 설계: docs/desktop-workspace-design-20261030.md 3·7·8·10절
 * - 상태는 state.js(MyHubDesktopState) 함수를 통해서만 바꾼다. 직접 변형 금지.
 * - keep-alive: iframe은 창 생성 시 1회만 만들고 src를 그때만 설정한다.
 *   포커스·최소화·복원에서는 DOM 토글만 하고 절대 재설정하지 않는다.
 * - 드래그/리사이즈는 Pointer Events + 종료 시점에만 상태 확정·저장한다.
 * 노출: window.MyHubDesktopWindows = { createManager(deps) }
 * deps = { root, taskbar, stateApi, storage, getViewport, state? }
 */
(function () {
  'use strict';

  var MOBILE_MAX = 768;
  var RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  var MODULE_ICONS = {
    memo: 'notebook-pen',
    schedule: 'calendar',
    todo: 'list-checks',
    chat: 'message-circle',
  };

  function iconFor(moduleId) {
    return MODULE_ICONS[moduleId] || 'layout-grid';
  }

  function refreshIcons() {
    try {
      if (typeof window.myhubRefreshIcons === 'function') window.myhubRefreshIcons();
      else if (window.lucide) window.lucide.createIcons();
    } catch (e) { console.warn('데스크톱 아이콘 새로고침 실패:', e); }
  }

  function createManager(deps) {
    deps = deps || {};
    var root = deps.root;
    var taskbar = deps.taskbar;
    var stateApi = deps.stateApi;
    var storage = deps.storage;
    if (!root || !stateApi) throw new Error('createManager: root와 stateApi가 필요합니다');

    function getViewport() {
      if (typeof deps.getViewport === 'function') return deps.getViewport();
      return { w: window.innerWidth || 1024, h: window.innerHeight || 768 };
    }
    function isMobile() {
      return getViewport().w < MOBILE_MAX;
    }

    var state = deps.state || deps.initialState || stateApi.load(storage, getViewport());
    var entries = new Map(); // id -> { el, frame }
    var launchers = new Map(); // moduleId -> button
    var drag = null; // 진행 중 드래그/리사이즈 세션 (종료 전에는 상태에 닿지 않음)
    var destroyed = false;

    function findModule(moduleId) {
      var mods = stateApi.MODULES || [];
      for (var i = 0; i < mods.length; i++) if (mods[i].id === moduleId) return mods[i];
      return null;
    }
    function findWin(id) {
      for (var i = 0; i < state.windows.length; i++) if (state.windows[i].id === id) return state.windows[i];
      return null;
    }

    function persist() {
      if (storage && typeof stateApi.save === 'function') {
        try { stateApi.save(storage, state); } catch (e) { console.warn('데스크톱 상태 저장 실패:', e); }
      }
    }

    /** 전이 결과를 상태에 반영하고 저장 + 다시 맞춘다. */
    function commit(next) {
      if (next === state) return;
      state = next;
      persist();
      sync();
    }

    function focusById(id) {
      if (state.activeId === id) return;
      commit(stateApi.focusWindow(state, id));
    }

    function restoreById(win) {
      // focusWindow는 최소화를 해제하지 않으므로 복원은 openModule 전이를 쓴다.
      commit(stateApi.openModule(state, win.module, getViewport()));
    }

    // ---- 창 DOM 생성 (iframe은 여기서 딱 1회만 만든다) ----
    function createWindowEl(win) {
      var mod = findModule(win.module) || { title: win.module, url: 'about:blank' };
      var el = document.createElement('section');
      el.className = 'dt-window';
      el.dataset.id = win.id;
      el.dataset.module = win.module;

      var bar = document.createElement('div');
      bar.className = 'dt-titlebar';
      var icon = document.createElement('span');
      icon.className = 'dt-title-icon';
      icon.innerHTML = '<i data-lucide="' + iconFor(win.module) + '"></i>';
      var title = document.createElement('span');
      title.className = 'dt-title-text';
      title.textContent = mod.title;
      var minBtn = document.createElement('button');
      minBtn.type = 'button';
      minBtn.className = 'dt-title-btn dt-btn-min';
      minBtn.setAttribute('aria-label', '최소화');
      minBtn.innerHTML = '<i data-lucide="minus"></i>';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'dt-title-btn dt-btn-close';
      closeBtn.setAttribute('aria-label', '닫기');
      closeBtn.innerHTML = '<i data-lucide="x"></i>';
      bar.appendChild(icon);
      bar.appendChild(title);
      bar.appendChild(minBtn);
      bar.appendChild(closeBtn);
      el.appendChild(bar);

      var frame = document.createElement('iframe');
      frame.className = 'dt-frame';
      frame.title = mod.title;
      frame.setAttribute('src', mod.url); // keep-alive: 이 설정은 생성 시 1회뿐이다
      el.appendChild(frame);

      RESIZE_DIRS.forEach(function (dir) {
        var h = document.createElement('div');
        h.className = 'dt-rz dt-rz-' + dir;
        h.dataset.dir = dir;
        el.appendChild(h);
      });

      minBtn.addEventListener('click', function () {
        commit(stateApi.minimizeWindow(state, win.id));
      });
      closeBtn.addEventListener('click', function () {
        commit(stateApi.closeWindow(state, win.id));
      });
      bar.addEventListener('pointerdown', function (e) {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        if (isMobile()) return;
        focusById(win.id);
        var cur = findWin(win.id);
        if (!cur) return;
        startDrag({
          mode: 'move', id: win.id, el: el,
          startX: e.clientX, startY: e.clientY, dx: 0, dy: 0,
          origX: cur.x, origY: cur.y,
        });
      });
      el.querySelectorAll('.dt-rz').forEach(function (h) {
        h.addEventListener('pointerdown', function (e) {
          if (isMobile()) return;
          e.preventDefault();
          focusById(win.id);
          var cur = findWin(win.id);
          if (!cur) return;
          var rect = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
          startDrag({
            mode: 'resize', id: win.id, el: el, dir: h.dataset.dir,
            startX: e.clientX, startY: e.clientY, dx: 0, dy: 0,
            origRect: rect, lastRect: rect,
          });
        });
      });
      // 창 본문(제목줄·버튼 외) pointerdown → 포커스 (이미 active면 무동작)
      el.addEventListener('pointerdown', function (e) {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        focusById(win.id);
      });

      return { el: el, frame: frame };
    }

    // ---- 드래그/리사이즈 세션 ----
    function startDrag(session) {
      drag = session;
      root.classList.add('dt-dragging');
    }
    function computeResizeRect(s) {
      var o = s.origRect;
      var r = { x: o.x, y: o.y, w: o.w, h: o.h };
      if (s.dir.indexOf('e') >= 0) r.w = o.w + s.dx;
      if (s.dir.indexOf('w') >= 0) { r.w = o.w - s.dx; r.x = o.x + s.dx; }
      if (s.dir.indexOf('s') >= 0) r.h = o.h + s.dy;
      if (s.dir.indexOf('n') >= 0) { r.h = o.h - s.dy; r.y = o.y + s.dy; }
      return r;
    }
    function onPointerMove(e) {
      if (!drag) return;
      drag.dx = e.clientX - drag.startX;
      drag.dy = e.clientY - drag.startY;
      if (drag.mode === 'move') {
        drag.el.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px)';
      } else {
        drag.lastRect = computeResizeRect(drag);
        drag.el.style.left = drag.lastRect.x + 'px';
        drag.el.style.top = drag.lastRect.y + 'px';
        drag.el.style.width = drag.lastRect.w + 'px';
        drag.el.style.height = drag.lastRect.h + 'px';
      }
    }
    function onPointerUp() {
      if (!drag) return;
      var s = drag;
      drag = null;
      root.classList.remove('dt-dragging');
      if (s.mode === 'move') {
        s.el.style.transform = '';
        commit(stateApi.moveWindow(state, s.id, s.origX + s.dx, s.origY + s.dy, getViewport()));
      } else {
        commit(stateApi.resizeWindow(state, s.id, s.lastRect, getViewport()));
      }
      sync(); // transform·임시 rect를 확정 스타일로 되돌린다 (commit이 무변화여도)
    }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);

    // ---- 상태 ↔ DOM 동기화 ----
    function sync() {
      if (destroyed) return;
      var alive = {};
      state.windows.forEach(function (win) {
        alive[win.id] = true;
        var rec = entries.get(win.id);
        if (!rec) {
          rec = createWindowEl(win);
          entries.set(win.id, rec);
          root.appendChild(rec.el);
        }
        rec.el.style.left = win.x + 'px';
        rec.el.style.top = win.y + 'px';
        rec.el.style.width = win.w + 'px';
        rec.el.style.height = win.h + 'px';
        rec.el.style.zIndex = String(win.z);
        rec.el.style.display = win.minimized ? 'none' : '';
        rec.el.classList.toggle('is-active', win.id === state.activeId);
        rec.el.classList.toggle('dt-minimized', win.minimized === true);
      });
      entries.forEach(function (rec, id) {
        if (!alive[id]) {
          rec.el.remove();
          entries.delete(id);
        }
      });
      renderTaskbar();
      refreshIcons();
    }

    function renderTaskbar() {
      if (!taskbar) return;
      var launchArea = taskbar.querySelector('.dt-launchers') || taskbar;
      var winArea = taskbar.querySelector('.dt-task-windows');

      (stateApi.MODULES || []).forEach(function (mod) {
        var btn = launchers.get(mod.id);
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'dt-launcher';
          btn.dataset.module = mod.id;
          btn.setAttribute('aria-label', mod.title + ' 열기');
          btn.innerHTML = '<i data-lucide="' + iconFor(mod.id) + '"></i>' +
            '<span class="dt-launcher-lbl"></span>';
          btn.querySelector('.dt-launcher-lbl').textContent = mod.title;
          btn.addEventListener('click', function () { openModule(mod.id); });
          launchers.set(mod.id, btn);
          launchArea.appendChild(btn);
        }
        btn.classList.toggle('is-open', !!findWin(mod.id));
        btn.classList.toggle('is-active', state.activeId === mod.id);
      });

      if (winArea) {
        winArea.innerHTML = '';
        state.windows.forEach(function (win) {
          var mod = findModule(win.module);
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'dt-task-btn';
          b.dataset.id = win.id;
          b.classList.toggle('is-active', win.id === state.activeId);
          b.classList.toggle('is-minimized', win.minimized === true);
          b.innerHTML = '<i data-lucide="' + iconFor(win.module) + '"></i>' +
            '<span class="dt-task-lbl"></span>';
          b.querySelector('.dt-task-lbl').textContent = mod ? mod.title : win.module;
          b.addEventListener('click', function () {
            var cur = findWin(win.id);
            if (!cur) return;
            if (cur.minimized) restoreById(cur);
            else focusById(cur.id);
          });
          winArea.appendChild(b);
        });
      }
    }

    // ---- 뷰포트 변경: 전 창 clamp 재적용 + 모바일 클래스 ----
    function onResize() {
      var vp = getViewport();
      root.classList.toggle('dt-mobile', vp.w < MOBILE_MAX);
      var next = state;
      state.windows.map(function (w) { return w.id; }).forEach(function (id) {
        var cur = null;
        for (var i = 0; i < next.windows.length; i++) if (next.windows[i].id === id) cur = next.windows[i];
        if (!cur) return;
        next = stateApi.resizeWindow(next, id, { x: cur.x, y: cur.y, w: cur.w, h: cur.h }, vp);
        var cur2 = null;
        for (var j = 0; j < next.windows.length; j++) if (next.windows[j].id === id) cur2 = next.windows[j];
        if (cur2) next = stateApi.moveWindow(next, id, cur2.x, cur2.y, vp);
      });
      if (next !== state) {
        state = next;
        persist();
      }
      sync();
    }
    window.addEventListener('resize', onResize);
    root.classList.toggle('dt-mobile', isMobile());

    function openModule(id) {
      commit(stateApi.openModule(state, id, getViewport()));
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      drag = null;
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      entries.forEach(function (rec) { rec.el.remove(); });
      entries.clear();
      launchers.forEach(function (btn) { btn.remove(); });
      launchers.clear();
      if (taskbar) {
        var winArea = taskbar.querySelector('.dt-task-windows');
        if (winArea) winArea.innerHTML = '';
      }
    }

    sync();

    return {
      openModule: openModule,
      getState: function () { return state; },
      destroy: destroy,
    };
  }

  var api = { createManager: createManager };
  if (typeof window !== 'undefined') window.MyHubDesktopWindows = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopWindows = api;
})();
