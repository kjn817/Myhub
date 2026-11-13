/* MyHub 데스크톱 워크스페이스 앱 창 DOM 관리자 (windows.js)
 *
 * 설계: docs/desktop-workspace-design-20261030.md 3·7·8·10장
 *       docs/desktop-macos-redesign-20261101.md (신호등·타일·바닥·앱의 실측)
 * - 상태는 state.js(MyHubDesktopState) 함수를 통해서만 바꾼다. 직접 변경 금지.
 * - keep-alive: iframe은 창 생성 앱 1앱만 만들고 src를 그앱만 설정한다.
 *   사용·활성화·복원에서는 DOM 앱만 내고 앱 설명하지 않는다.
 * - 드래그/리사이즈는 Pointer Events(포인터 캡처로 iframe 앱에서도 추적) +
 *   종료 시점에서만 상태 확정·앱한것이다.
 * - 최대화/줌 모드의 복원 기억은 창 앱(mode/prev)가 정보이다
 *   (state.js). 매니저 메모리에만 두면 새로고침 앱 모드가 내린다 앱
 *   로드 시점의 저장된 모드를 현재 뷰포트 기억으로 다시 앱한다.
 * 노출: window.MyHubDesktopWindows = { createManager(deps) }
 * deps = { root, taskbar, stateApi, storage, getViewport, state?, activeTitleEl? }
 */
(function () {
  'use strict';

  var MOBILE_MAX = 768;
  var DOCK_ZONE = 96; // css/desktop.css의 --dt-dock-zone과 일치
  var RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  var UNIFIED_CHROME_MODULES = {
    finder: true, memo: true, studio: true,
  };
  var OFFICE_MODULES = {
    excel: true, hangul: true, powerpoint: true, pdf: true,
  };
  function chromeKind(moduleId) {
    return UNIFIED_CHROME_MODULES[moduleId] ? 'unified' : 'compact';
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
    var drag = null;
    var docTitles = new Map(); // id -> { name, dirty }
    var destroyed = false;

    (function reconcileModeRects() {
      var vp = getViewport();
      var changed = false;
      state.windows.forEach(function (w) {
        if (w.mode !== 'full' && w.mode !== 'zoom') return;
        var target = w.mode === 'full' ? fullRect(vp) : zoomRect(vp);
        if (w.x !== target.x || w.y !== target.y || w.w !== target.w || w.h !== target.h) {
          state = stateApi.resizeWindow(state, w.id, target, vp);
          changed = true;
        }
      });
      if (changed) persist();
    })();

    function raf(fn) {
      if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(fn);
      return setTimeout(fn, 0);
    }
    function cancelRaf(id) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id);
      else clearTimeout(id);
    }

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

    var SEAM_MODULES = { finder: true, studio: true };
    function snapSeamWindows(next) {
      var top = rootTopOffset();
      var residue = (4 - ((top + 41) % 4)) % 4;
      var vp = getViewport();
      for (var i = 0; i < next.windows.length; i++) {
        var w = next.windows[i];
        if (!SEAM_MODULES[w.module] || w.mode) continue;
        var d = (residue - (w.y % 4) + 4) % 4;
        if (d > 2) d -= 4;
        if (d === 0) continue;
        next = stateApi.resizeWindow(next, w.id, { x: w.x, y: w.y + d, w: w.w, h: w.h }, vp);
      }
      return next;
    }

    function commit(next) {
      if (next === state) return;
      state = snapSeamWindows(next);
      persist();
      sync();
    }

    function focusById(id) {
      if (state.activeId === id) return;
      commit(stateApi.focusWindow(state, id));
    }

    function paintDocTitle(el, id) {
      var info = docTitles.get(id);
      var mod = findModule(el.dataset.module);
      var titleEl = el.querySelector('.dt-title-text');
      var dotEl = el.querySelector('.dt-title-dot');
      if (titleEl) titleEl.textContent = info && info.name ? info.name : mod ? mod.title : '';
      if (dotEl) dotEl.hidden = !(info && info.dirty);
    }
    function applyDocTitle(id) {
      var rec = entries.get(id);
      if (rec) paintDocTitle(rec.el, id);
    }
    function setDocTitle(id, info) {
      if (!info || !info.name) docTitles.delete(id);
      else docTitles.set(id, { name: info.name, dirty: !!info.dirty });
      applyDocTitle(id);
    }
    function onDocTitleMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:doc-title') return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (rec.frame && rec.frame.contentWindow && rec.frame.contentWindow === e.source) found = id;
      });
      if (!found) return;
      setDocTitle(found, {
        name: typeof d.name === 'string' && d.name ? d.name : null,
        dirty: !!d.dirty,
      });
    }
    window.addEventListener('message', onDocTitleMessage);

    function onNavKeyMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:desktop-nav-key') return;
      if (d.key !== 'ArrowLeft' && d.key !== 'ArrowRight' && d.key !== 'ArrowUp') return;
      var found = false;
      entries.forEach(function (rec) {
        if (rec.frame && rec.frame.contentWindow && rec.frame.contentWindow === e.source) found = true;
      });
      if (!found) return;
      onKeydown({ key: d.key, ctrlKey: true, preventDefault: function () {} });
    }
    window.addEventListener('message', onNavKeyMessage);

    // ---- 창 DOM 생성 (iframe의 크기는 앱 1앱만 만든다) ----
    function createWindowEl(win) {
      var mod = findModule(win.module) || { title: win.module, url: 'about:blank' };
      var el = document.createElement('section');
      el.className = 'dt-window dt-win-enter';
      el.addEventListener('animationend', function () { el.classList.remove('dt-win-enter'); }, { once: true });
      el.dataset.id = win.id;
      el.dataset.module = win.module;
      var kind = chromeKind(win.module);
      el.dataset.chrome = kind;
      el.classList.add(kind === 'unified' ? 'dt-win-unified' : 'dt-win-compact');
      if (win.module === 'finder') el.classList.add('dt-win-finder');
      if (win.module === 'studio') el.classList.add('dt-win-studio');
      if (OFFICE_MODULES[win.module]) el.classList.add('dt-win-office');

      var bar = document.createElement('div');
      bar.className = 'dt-titlebar';

      var traffic = document.createElement('div');
      traffic.className = 'dt-traffic';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'dt-light dt-btn-close';
      closeBtn.setAttribute('aria-label', '닫기');
      closeBtn.innerHTML = '<i data-lucide="x"></i>';
      var minBtn = document.createElement('button');
      minBtn.type = 'button';
      minBtn.className = 'dt-light dt-btn-min';
      minBtn.setAttribute('aria-label', '최소화');
      minBtn.innerHTML = '<i data-lucide="minus"></i>';
      var maxBtn = document.createElement('button');
      maxBtn.type = 'button';
      maxBtn.className = 'dt-light dt-btn-max';
      maxBtn.setAttribute('aria-label', '확대');
      maxBtn.innerHTML = '<i data-lucide="plus"></i>';
      traffic.appendChild(closeBtn);
      traffic.appendChild(minBtn);
      traffic.appendChild(maxBtn);
      bar.appendChild(traffic);

      var center = document.createElement('div');
      center.className =
        'dt-title-flow' +
        (OFFICE_MODULES[win.module] ? ' dt-title-centered' : '');
      var title = document.createElement('span');
      title.className = 'dt-title-text';
      title.textContent = mod.title;
      var dot = document.createElement('span');
      dot.className = 'dt-title-dot';
      dot.hidden = true;
      dot.setAttribute('aria-hidden', 'true');
      center.appendChild(title);
      center.appendChild(dot);
      bar.appendChild(center);
      if (win.module === 'finder') {
        var tools = document.createElement('div');
        tools.className = 'myhub-win-tools';
        tools.hidden = true;
        bar.appendChild(tools);
      }
      if (OFFICE_MODULES[win.module]) {
        var quick = document.createElement('div');
        quick.className = 'myhub-win-quick';
        quick.hidden = true;
        bar.appendChild(quick);
        var searchBox = document.createElement('div');
        searchBox.className = 'myhub-win-search';
        searchBox.hidden = true;
        bar.appendChild(searchBox);
      }
      if (win.module === 'browser') {
        var btabs = document.createElement('div');
        btabs.className = 'myhub-win-btabs';
        btabs.hidden = true;
        bar.appendChild(btabs);
      }
      var winActions = document.createElement('div');
      winActions.className = 'myhub-win-actions';
      winActions.hidden = true;
      bar.appendChild(winActions);
      el.appendChild(bar);

      var frame = document.createElement('iframe');
      frame.className = 'dt-frame';
      frame.title = mod.title;
      if (mod.sandbox) frame.setAttribute('sandbox', 'allow-scripts');
      frame.addEventListener('load', function () {
        var innerDoc = null;
        try {
          innerDoc = frame.contentDocument;
        } catch (e) {
          innerDoc = null;
        }
        if (innerDoc && innerDoc.documentElement) {
          innerDoc.documentElement.classList.add('myhub-embedded');
        }
        docTitles.delete(win.id);
        applyDocTitle(win.id);
        try {
          if (frame.contentWindow) {
            frame.contentWindow.postMessage(
              { type: 'myhub:request-doc-title' },
              window.location.origin,
            );
            frame.contentWindow.postMessage(
              { type: 'myhub:request-win-actions' },
              window.location.origin,
            );
            frame.contentWindow.postMessage(
              { type: 'myhub:request-browser-tabs' },
              window.location.origin,
            );
            frame.contentWindow.postMessage(
              { type: 'myhub:assistant-hello' },
              window.location.origin,
            );
          }
        } catch (e) { console.warn('[desktop] :', e); }
        officeTabsByWin.delete(win.id);
        finderToolbarByWin.delete(win.id);
        renderFinderTools(win.id);
        officeQuickByWin.delete(win.id);
        officeFoldByWin.delete(win.id);
        renderOfficeQuick(win.id);
        winActionsByWin.delete(win.id);
        renderWinActions(win.id);
        browserTabsByWin.delete(win.id);
        browserTabsSig.delete(win.id);
        renderBrowserTabs(win.id);
        assistantByWin.delete(win.id);
        if (state.activeId === mod.id) {
          barDoc = null;
          syncAppActions();
          syncAssistantAvatar();
          renderOfficeTabs();
        }
      });
      frame.setAttribute('src', mod.url);
      el.appendChild(frame);

      RESIZE_DIRS.forEach(function (dir) {
        var h = document.createElement('div');
        h.className = 'dt-rz dt-rz-' + dir;
        h.dataset.dir = dir;
        el.appendChild(h);
      });

      minBtn.addEventListener('click', function () {
        if (missionBusy()) return;
        commit(stateApi.minimizeWindow(state, win.id));
      });
      closeBtn.addEventListener('click', function () {
        if (missionBusy()) return;
        commit(stateApi.closeWindow(state, win.id));
      });
      maxBtn.addEventListener('click', function () {
        if (missionBusy()) return;
        toggleMaximize(win.id);
      });
      bar.addEventListener('dblclick', function (e) {
        if (missionBusy()) return;
        if (e.target && e.target.closest && e.target.closest('button, [data-nodrag]')) return;
        if (isMobile()) return;
        toggleZoom(win.id);
      });
      bar.addEventListener('pointerdown', function (e) {
        if (missionBusy()) return;
        if (e.target && e.target.closest && e.target.closest('button, [data-nodrag]')) return;
        if (isMobile()) return;
        focusById(win.id);
        var dragKind = modeKind(win.id);
        if (dragKind === 'full') return;
        var cur = findWin(win.id);
        if (!cur) return;
        capturePointer(bar, e);
        startDrag({
          mode: 'move', id: win.id, el: el, pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY, dx: 0, dy: 0,
          origX: cur.x, origY: cur.y,
          unzoomPrev: dragKind === 'zoom' ? modePrev(win.id) || fallbackRestoreRect(getViewport()) : null,
        });
      });
      el.querySelectorAll('.dt-rz').forEach(function (h) {
        h.addEventListener('pointerdown', function (e) {
          if (missionBusy()) return;
          if (isMobile()) return;
          var rzKind = modeKind(win.id);
          if (rzKind === 'full') return;
          if (rzKind === 'zoom') commit(stateApi.setWindowMode(state, win.id, null, null));
          e.preventDefault();
          focusById(win.id);
          var cur = findWin(win.id);
          if (!cur) return;
          var rect = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
          capturePointer(h, e);
          startDrag({
            mode: 'resize', id: win.id, el: el, dir: h.dataset.dir, pointerId: e.pointerId,
            startX: e.clientX, startY: e.clientY, dx: 0, dy: 0,
            origRect: rect, lastRect: rect,
          });
        });
      });
      el.addEventListener('pointerdown', function (e) {
        if (missionOpen) {
          if (e.target && e.target.closest && e.target.closest('button')) return;
          // preventDefault가 없으면 드래그 이동 중 브라우저 텍스트
          // 선택이 시작돼 창·라벨이 선택 틴트로 덮인다 (실브라우저 실측).
          e.preventDefault();
          // 카드·+ 버튼의 hit rect를 드래그 시작 시 한 번만 읽어 둔다.
          // 미션 카드·버튼은 드래그 중 움직이지 않으므로 캐시가 유효하고,
          // move마다 getBoundingClientRect를 부르면 스타일 변경
          // (is-drop-hot 토글) 뒤 강제 동기 레이아웃이 매번 돈다.
          var cardRects = missionCardsArr.map(function (c) {
            var r = c.el.getBoundingClientRect();
            return { spaceId: c.spaceId, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          });
          var addRect = null;
          if (missionAddEl) {
            var ar = missionAddEl.getBoundingClientRect();
            addRect = { left: ar.left, right: ar.right, top: ar.top, bottom: ar.bottom, width: ar.width, height: ar.height };
          }
          missionDrag = {
            id: win.id, pointerId: e.pointerId,
            startX: e.clientX, startY: e.clientY,
            moved: false, hotSpace: null, hotAdd: false,
            cardRects: cardRects, addRect: addRect,
            lastX: e.clientX, lastY: e.clientY, mdx: 0, mdy: 0, rafId: null,
          };
          return;
        }
        if (missionClosing) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;
        focusById(win.id);
      });

      paintDocTitle(el, win.id);
      return { el: el, frame: frame };
    }

    function modeKind(id) {
      var w = findWin(id);
      return w ? w.mode || null : null;
    }
    function modePrev(id) {
      var w = findWin(id);
      return w && w.prev ? w.prev : null;
    }
    function fallbackRestoreRect(vp) {
      return {
        x: Math.round(vp.w * 0.14),
        y: Math.round(vp.h * 0.08),
        w: Math.round(vp.w * 0.72),
        h: Math.round(vp.h * 0.78),
      };
    }
    function rootTopOffset() {
      if (root && typeof root.getBoundingClientRect === 'function') {
        var t = root.getBoundingClientRect().top;
        if (typeof t === 'number' && t > 0) return t;
      }
      return 0;
    }
    function fullRect(vp) {
      return { x: 0, y: 0, w: vp.w, h: Math.max(160, vp.h - rootTopOffset()) };
    }
    function zoomRect(vp) {
      var top = rootTopOffset();
      var h = vp.h - DOCK_ZONE - top;
      if (taskbar && typeof taskbar.getBoundingClientRect === 'function') {
        var r = taskbar.getBoundingClientRect();
        if (r && typeof r.top === 'number' && r.top > top + 40 && r.top < vp.h) {
          h = r.top - top;
        }
      }
      return { x: 0, y: 0, w: vp.w, h: Math.max(160, Math.round(h)) };
    }
    function toggleMaximize(id) {
      var cur = findWin(id);
      if (!cur) return;
      focusById(id);
      cur = findWin(id);
      if (!cur) return;
      var vp = getViewport();
      var kind = modeKind(id);
      var prev = modePrev(id);
      if (kind === 'full') {
        commit(stateApi.resizeWindow(
          stateApi.setWindowMode(state, id, null, null),
          id, prev || fallbackRestoreRect(vp), vp));
      } else if (kind === 'zoom') {
        commit(stateApi.resizeWindow(
          stateApi.setWindowMode(state, id, 'full', prev),
          id, fullRect(vp), vp));
      } else {
        commit(stateApi.resizeWindow(
          stateApi.setWindowMode(state, id, 'full', { x: cur.x, y: cur.y, w: cur.w, h: cur.h }),
          id, fullRect(vp), vp));
      }
      sync();
    }
    function toggleZoom(id) {
      var cur = findWin(id);
      if (!cur) return;
      focusById(id);
      cur = findWin(id);
      if (!cur) return;
      var vp = getViewport();
      var kind = modeKind(id);
      var prev = modePrev(id);
      if (kind === 'zoom') {
        commit(stateApi.resizeWindow(
          stateApi.setWindowMode(state, id, null, null),
          id, prev || fallbackRestoreRect(vp), vp));
      } else if (kind === 'full') {
        commit(stateApi.resizeWindow(
          stateApi.setWindowMode(state, id, 'zoom', prev),
          id, zoomRect(vp), vp));
      } else {
        commit(stateApi.resizeWindow(
          stateApi.setWindowMode(state, id, 'zoom', { x: cur.x, y: cur.y, w: cur.w, h: cur.h }),
          id, zoomRect(vp), vp));
      }
      sync();
    }

    function capturePointer(el, e) {
      try {
        if (el && typeof el.setPointerCapture === 'function' && e && e.pointerId !== undefined) {
          el.setPointerCapture(e.pointerId);
        }
      } catch (err) { console.warn(':', err); }
    }
    function setDragPerf(on) {
      void on;
    }
    var missionAnimTimer = null;
    function pulseMissionAnim() {
      var b = root.ownerDocument && root.ownerDocument.body;
      if (!b) return;
      b.classList.add('dt-mission-anim');
      if (missionAnimTimer !== null) clearTimeout(missionAnimTimer);
      missionAnimTimer = setTimeout(function () {
        missionAnimTimer = null;
        b.classList.remove('dt-mission-anim');
      }, 320);
    }
    function clearMissionAnim() {
      if (missionAnimTimer !== null) {
        clearTimeout(missionAnimTimer);
        missionAnimTimer = null;
      }
      setDragPerf(false);
      var b = root.ownerDocument && root.ownerDocument.body;
      if (b) b.classList.remove('dt-mission-anim');
    }
    function startDrag(session) {
      drag = session;
      root.classList.add('dt-dragging');
      // 드래그 중인 창은 들어올림(lift) — 흰 창이 흰 창 위에 겹칠 때 경계가
      // 묻혀 "흰 패널"로 보이는 문제(2026-11-12 할 일 창 지적)를 막는다.
      if (session.el) session.el.classList.add('dt-win-dragging');
      setDragPerf(true);
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
    function applyDragFrame() {
      if (!drag) return;
      drag.rafId = null;
      if (drag.mode !== 'resize') return;
      drag.lastRect = computeResizeRect(drag);
      drag.el.style.left = drag.lastRect.x + 'px';
      drag.el.style.top = drag.lastRect.y + 'px';
      drag.el.style.width = drag.lastRect.w + 'px';
      drag.el.style.height = drag.lastRect.h + 'px';
    }
    // 창 이동은 pointermove마다 transform을 직접 쓰지 않고 rAF로 합친다.
    // 고주파 마우스(125Hz~)에서는 한 프레임에 여러 move 이벤트가 와서
    // 매번 스타일 재계산·컴포지터 커밋이 돌았고, 그려지는 건 마지막 한 번뿐이다.
    // dx/dy·최종 좌표는 동기 갱신해 pointerup 커밋이 최신 값을 쓰게 하고,
    // 그리기만 다음 프레임으로 미룬다 — 보이는 움직임은 동일하다.
    function applyMoveFrame() {
      if (!drag) return;
      drag.rafId = null;
      if (drag.mode !== 'move') return;
      if (drag.unzoomPrev && (Math.abs(drag.dx) > 4 || Math.abs(drag.dy) > 4)) {
        var prevRect = drag.unzoomPrev;
        drag.unzoomPrev = null;
        commit(stateApi.resizeWindow(
          stateApi.setWindowMode(state, drag.id, null, null),
          drag.id, prevRect, getViewport()));
        drag.origX = prevRect.x;
        drag.origY = prevRect.y;
      }
      drag.el.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px)';
      var vp = getViewport();
      var edgeX = drag.lastClientX !== undefined ? drag.lastClientX : drag.startX + drag.dx;
      var dir = edgeX <= 1 ? -1 : edgeX >= vp.w - 1 ? 1 : 0;
      if (dir === 0) {
        drag.edgeDir = 0;
        drag.edgeSince = 0;
      } else if (drag.edgeDir !== dir) {
        drag.edgeDir = dir;
        drag.edgeSince = Date.now();
      } else if (Date.now() - drag.edgeSince > 550) {
        drag.edgeDir = 0;
        drag.edgeSince = 0;
        var idx = state.spaces.indexOf(state.activeSpace);
        var target = state.spaces[idx + dir];
        if (target !== undefined) {
          commit(stateApi.moveWindowToSpace(state, drag.id, target));
          commit(stateApi.setActiveSpace(state, target));
          commit(stateApi.focusWindow(state, drag.id));
        }
      }
    }
    function onPointerMove(e) {
      if (missionDrag) { onMissionMove(e); return; }
      if (!drag) return;
      if (drag.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
      drag.dx = e.clientX - drag.startX;
      drag.dy = e.clientY - drag.startY;
      if (drag.mode === 'move') {
        drag.lastClientX = e.clientX;
        if (drag.rafId === null || drag.rafId === undefined) {
          drag.rafId = raf(applyMoveFrame);
        }
      } else if (drag.rafId === null || drag.rafId === undefined) {
        drag.rafId = raf(applyDragFrame);
      }
    }
    function onPointerUp(e) {
      if (missionDrag) { finishMissionDrag(e); return; }
      if (!drag) return;
      if (drag.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
      var s = drag;
      drag = null;
      if (s.el) s.el.classList.remove('dt-win-dragging');
      if (s.rafId !== null && s.rafId !== undefined) cancelRaf(s.rafId);
      root.classList.remove('dt-dragging');
      setDragPerf(false);
      if (s.mode === 'move') {
        s.el.style.transform = '';
        commit(stateApi.moveWindow(state, s.id, s.origX + s.dx, s.origY + s.dy, getViewport()));
      } else {
        s.lastRect = computeResizeRect(s);
        commit(stateApi.resizeWindow(state, s.id, s.lastRect, getViewport()));
      }
      sync();
    }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);

    var SPACE_SLIDE_MS = 380;
    var lastSyncedSpace = null;
    var spaceSlide = null;
    var spaceSlideTimer = null;
    function finalizeSpaceSlide() {
      if (spaceSlideTimer !== null) { clearTimeout(spaceSlideTimer); spaceSlideTimer = null; }
      if (!spaceSlide) return;
      spaceSlide.els.forEach(function (el) {
        el.style.transition = '';
        el.style.transform = '';
        el.style.animation = '';
      });
      spaceSlide = null;
      var b = root.ownerDocument && root.ownerDocument.body;
      if (b) b.classList.remove('dt-space-anim');
      sync();
    }
    function startSpaceSlide(fromId, toId) {
      var view = (root.ownerDocument && root.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
      var reduceMotion = false;
      try {
        reduceMotion = !!(view && view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) {
        reduceMotion = false;
      }
      if (reduceMotion) return;
      var dir = state.spaces.indexOf(toId) > state.spaces.indexOf(fromId) ? 1 : -1;
      var vw = (root.ownerDocument && root.ownerDocument.documentElement && root.ownerDocument.documentElement.clientWidth) || 1024;
      var parts = [];
      state.windows.forEach(function (win) {
        if (win.minimized) return;
        if (win.space !== fromId && win.space !== toId) return;
        var rec = entries.get(win.id);
        if (rec) parts.push({ id: win.id, el: rec.el, out: win.space === fromId });
      });
      if (!parts.length) return;
      var winIds = {};
      var els = [];
      parts.forEach(function (p) {
        winIds[p.id] = true;
        els.push(p.el);
        p.el.style.display = '';
        p.el.classList.remove('dt-win-enter');
        p.el.style.animation = 'none';
        p.el.style.transition = 'none';
        p.el.style.transform = p.out ? 'translateX(0px)' : 'translateX(' + dir * vw + 'px)';
      });
      spaceSlide = { winIds: winIds, els: els };
      void root.offsetWidth;
      parts.forEach(function (p) {
        p.el.style.transition = 'transform ' + SPACE_SLIDE_MS + 'ms cubic-bezier(0.32, 0.72, 0.24, 1)';
        p.el.style.transform = 'translateX(' + (p.out ? -dir * vw : 0) + 'px)';
      });
      var b = root.ownerDocument && root.ownerDocument.body;
      if (b) b.classList.add('dt-space-anim');
      spaceSlideTimer = setTimeout(finalizeSpaceSlide, SPACE_SLIDE_MS + 60);
    }

    function sync() {
      if (destroyed) return;
      var spaceChanged = lastSyncedSpace !== null && state.activeSpace !== lastSyncedSpace;
      var fromSpace = lastSyncedSpace;
      lastSyncedSpace = state.activeSpace;
      if (spaceChanged && !missionOpen && missionCloseTimer === null) {
        if (spaceSlide) finalizeSpaceSlide();
        startSpaceSlide(fromSpace, state.activeSpace);
      }
      var anyFull = false;
      state.windows.forEach(function (w) {
        if (w.space === state.activeSpace && !w.minimized && modeKind(w.id) === 'full') anyFull = true;
      });
      var bodyEl = root.ownerDocument && root.ownerDocument.body;
      if (bodyEl) bodyEl.classList.toggle('dt-fullscreen', anyFull);
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
        var showWin = !win.minimized && (missionOpen ? win.space === missionSel : win.space === state.activeSpace);
        if (spaceSlide && spaceSlide.winIds[win.id] && !win.minimized) showWin = true;
        rec.el.style.display = showWin ? '' : 'none';
        rec.el.classList.toggle('is-active', win.id === state.activeId);
        rec.el.classList.toggle('dt-minimized', win.minimized === true);
        rec.el.classList.toggle('dt-maximized', modeKind(win.id) === 'full');
        var maxBtn = rec.el.querySelector('.dt-btn-max');
        if (maxBtn) maxBtn.setAttribute('aria-label', modeKind(win.id) === 'full' ? '원래 크기로' : '확대');
      });
      entries.forEach(function (rec, id) {
        if (!alive[id]) {
          rec.el.remove();
          entries.delete(id);
          docTitles.delete(id);
          officeTabsByWin.delete(id);
          finderToolbarByWin.delete(id);
          officeQuickByWin.delete(id);
          officeQuickSig.delete(id);
          officeFoldByWin.delete(id);
          winActionsByWin.delete(id);
          winActionsSig.delete(id);
          browserTabsByWin.delete(id);
          browserTabsSig.delete(id);
          assistantByWin.delete(id);
        }
      });
      if (deps.activeTitleEl) {
        var activeWin = state.activeId ? findWin(state.activeId) : null;
        var activeMod = activeWin ? findModule(activeWin.module) : null;
        deps.activeTitleEl.textContent = activeMod ? activeMod.title : '데스크톱';
      }
      renderDock();
      syncDockAutohide();
      syncAppActions();
      syncAssistantAvatar();
      renderOfficeTabs();
      finderToolbarByWin.forEach(function (_st, id) { renderFinderTools(id); });
      if (missionOpen) layoutMissionSpread();
      refreshIcons();
    }

    var hotZone = null;
    var peekTimer = null;
    function syncDockAutohide() {
      if (!taskbar) return;
      var anyMax = false;
      var anyOpen = false;
      state.windows.forEach(function (w) {
        if (w.space !== state.activeSpace || w.minimized) return;
        anyOpen = true;
        if (modeKind(w.id) === 'full') anyMax = true;
      });
      var hide = !missionOpen && !missionClosing && (isMobile() ? anyOpen : anyMax);
      taskbar.classList.toggle('dt-autohide', hide);
      if (!hide) taskbar.classList.remove('dt-dock-peek');
    }
    var barWin = undefined;
    var barDoc = null;
    var barSig = '';
    var barMode = '';
    var menuBar = null;
    var menuBarTried = false;
    var jnFallbackBound = false;
    function currentActiveDoc() {
      if (!state.activeId || !entries.has(state.activeId)) return null;
      var frame = entries.get(state.activeId).frame;
      try {
        return frame ? frame.contentDocument : null;
      } catch (e) {
        return null;
      }
    }
    function shellDocument() {
      return root && root.ownerDocument ? root.ownerDocument : document;
    }
    function getMenuBar() {
      if (menuBar || menuBarTried) return menuBar;
      menuBarTried = true;
      var api =
        deps.menuBarApi ||
        (typeof window !== 'undefined' ? window.MyHubDesktopMenuBar : null);
      if (!api || typeof api.createMenuBar !== 'function') return null;
      var sdoc = shellDocument();
      menuBar = api.createMenuBar({
        doc: sdoc,
        menuApi:
          deps.menuApi ||
          (typeof window !== 'undefined' ? window.MyHubDesktopMenu : null),
        refreshIcons: refreshIcons,
        jnEl: sdoc.querySelector('.g-nav .brand-logo'),
        appEl: deps.activeTitleEl || null,
        menusEl: deps.appActionsEl || null,
      });
      return menuBar;
    }
    function bindJnFallback() {
      if (jnFallbackBound) return;
      jnFallbackBound = true;
      var brand = shellDocument().querySelector('.g-nav .brand-logo');
      if (!brand) return;
      brand.addEventListener('click', function (e) {
        e.preventDefault();
        toggleMission();
      });
    }
    function openShellSettings() {
      var btn = shellDocument().querySelector('.g-nav .settings-btn');
      if (btn) btn.click();
    }
    function jnMenuItems() {
      var items = [
        {
          label: '미션 컨트롤',
          onSelect: function () {
            toggleMission();
          },
        },
        { separator: true },
      ];
      var hasSettings = !!shellDocument().querySelector('.g-nav .settings-btn');
      items.push({
        label: '시스템 설정',
        disabled: !hasSettings,
        onSelect: openShellSettings,
      });
      items.push({
        label: '백업',
        disabled: !hasSettings,
        onSelect: openShellSettings,
      });
      var nav =
        deps.navApi || (typeof window !== 'undefined' ? window.MyHubNav : null);
      if (nav && typeof nav.handleLogout === 'function') {
        items.push({ separator: true });
        items.push({
          label: '로그아웃',
          danger: true,
          onSelect: function () {
            nav.handleLogout();
          },
        });
      }
      return items;
    }
    function appMenuItems() {
      var id = state.activeId;
      if (!id) return [];
      return [
        {
          label: '최소화',
          onSelect: function () {
            commit(stateApi.minimizeWindow(state, id));
          },
        },
        { separator: true },
        {
          label: '창 닫기',
          onSelect: function () {
            commit(stateApi.closeWindow(state, id));
          },
        },
      ];
    }
    function syncMenuChrome() {
      var bar = getMenuBar();
      if (!bar) {
        bindJnFallback();
        return;
      }
      bar.setChrome({ jnItems: jnMenuItems, appItems: appMenuItems });
    }
    function adaptMenuItem(doc, item) {
      if (!item) return null;
      if (item.separator) return { separator: true };
      if (typeof item.label !== 'string' || !item.label) return null;
      var out = {
        label: item.label,
        sub: item.sub,
        shortcut: item.shortcut,
        icon: item.icon,
        danger: !!item.danger,
        heading: !!item.heading,
        disabled: item.disabled,
        checked: item.checked,
      };
      out.onSelect = function () {
        if (typeof item.run === 'function') {
          item.run();
          return;
        }
        if (item.target) {
          var t = null;
          try {
            t = doc.querySelector(item.target);
          } catch (e) {
            console.warn(':', e);
          }
          if (t) t.click();
          else console.warn(':', item.target);
        }
      };
      return out;
    }
    function adaptMenuItems(doc, items) {
      if (typeof items === 'function') {
        return function () {
          return adaptMenuItems(doc, items());
        };
      }
      if (!Array.isArray(items)) return [];
      var out = [];
      items.forEach(function (item) {
        var adapted = adaptMenuItem(doc, item);
        if (adapted) out.push(adapted);
      });
      return out;
    }
    function readAppMenus(doc) {
      if (!doc) return null;
      var raw = null;
      try {
        raw =
          (doc.defaultView && doc.defaultView.MyHubMenus) ||
          doc.MyHubMenus ||
          null;
        if (typeof raw === 'function') raw = raw();
      } catch (e) {
        console.warn(':', e);
        return null;
      }
      if (!Array.isArray(raw)) return null;
      var defs = [];
      raw.forEach(function (def) {
        if (!def || typeof def.label !== 'string' || !def.label) return;
        if (!Array.isArray(def.items) && typeof def.items !== 'function') return;
        defs.push({ label: def.label, items: adaptMenuItems(doc, def.items) });
      });
      return defs.length ? defs : null;
    }
    function syncAppActions() {
      syncMenuChrome();
      var doc = currentActiveDoc();
      var bar = getMenuBar();
      var defs = bar && doc ? readAppMenus(doc) : null;
      if (defs) {
        var sig = defs
          .map(function (d) {
            return d.label;
          })
          .join('\n');
        barMode = 'menu';
        if (state.activeId === barWin && doc === barDoc && sig === barSig) return;
        barWin = state.activeId;
        barDoc = doc;
        barSig = sig;
        bar.setMenus(defs, { compact: isMobile() });
        return;
      }
      // 메뉴가 없는 앱: 상단바 메뉴를 비운다. 2026-11-12에 옛 프록시 수집
      // (.g-nav 버튼·검색창을 상단바로 복사하던 분기 + buildButtonProxy·
      // buildSearchProxy)을 제거했다 — 모든 현행 앱은 MyHubMenus를 갖거나
      // data-app-actions="none"이라 수집할 것이 없었고, 2026-11-04 결정대로
      // 상단바 프록시는 원하지 않는다.
      if (barMode === 'menu') {
        barMode = 'none';
        barWin = undefined;
        barDoc = null;
        barSig = '';
        if (bar) bar.setMenus(null);
      }
    }

    var officeTabsByWin = new Map();
    var officeTabsSig = null;
    var officeTabsClickLog = [];
    var officeTabsActiveWin = null;
    function normalizeOfficeTabState(d) {
      if (!d || !Array.isArray(d.tabs)) return null;
      var tabs = [];
      d.tabs.forEach(function (t) {
        if (!t || typeof t.id !== 'string' || !t.id) return;
        tabs.push({
          id: t.id,
          label: typeof t.label === 'string' && t.label ? t.label : t.id,
          kind:
            t.kind === 'file' || t.kind === 'menu' || t.kind === 'separator'
              ? t.kind
              : 'tab',
        });
      });
      if (!tabs.length) return null;
      return {
        app: typeof d.app === 'string' ? d.app : null,
        tabs: tabs,
        activeId: typeof d.activeId === 'string' ? d.activeId : null,
        collapsed: false,
        canCollapse: false,
        menuShell: !!d.menuShell,
      };
    }
    function officeTabsSignature(winId, st) {
      if (!st) return winId + '||none';
      return [
        winId,
        st.app || '',
        st.activeId || '',
        st.collapsed ? '1' : '0',
        st.canCollapse ? '1' : '0',
        st.menuShell ? '1' : '0',
        st.tabs
          .map(function (t) {
            return t.id + ':' + t.label + ':' + t.kind;
          })
          .join(','),
      ].join('|');
    }
    function renderOfficeTabs() {
      var box = deps.officeTabsEl;
      if (!box) return;
      var winId = state.activeId || null;
      var win = findWin(winId);
      var st = officeTabsByWin.get(winId) || (win && win.officeTabs ? normalizeOfficeTabState(win.officeTabs) : null);
      var sig = officeTabsSignature(winId, st);
      if (sig === officeTabsSig) return;
      officeTabsSig = sig;
      var show = st && st.tabs && st.tabs.length > 1;
      if (st) {
        var tabs = st.tabs;
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i].kind === 'separator') continue;
          if (officeTabsClickLog.indexOf(tabs[i].id) === -1) officeTabsClickLog.push(tabs[i].id);
        }
      }
      if (st) officeTabsByWin.set(winId, st);
      if (!box) return;
      box.innerHTML = '';
      if (!show) {
        box.style.display = 'none';
        return;
      }
      box.style.display = '';
      box.className = 'dt-office-tabs' + (st.collapsed ? ' collapsed' : '');
      var menu = officeMenuBuild(st, winId);
      menu.forEach(function (tab) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'dt-office-tab' + (tab.id === st.activeId ? ' is-active' : '');
        b.setAttribute('data-tab', tab.id);
        var inner = tab.kind === 'separator' ? '' : '<span class="dt-office-tab-label">' + (tab.label || tab.id) + '</span>';
        if (tab.kind === 'menu') {
          b.classList.add('has-menu');
          // 메뉴 라벨 뒤 꺽쇠 아이콘 없음 (2026-11-12 사용자 지적):
          // macOS 메뉴 막대 항목과 MyHubMenus 버튼(.myhub-menubar-btn)
          // 에는 꺽쇠가 없다. 오피스 메뉴에만 꺽쇠가 붙어 상단바에서
          // 튀어 디자인을 해쳤다. 클릭하면 드롭다운이 열리는 동작은
          // 그대로다.
        }
        b.innerHTML = inner;
        if (tab.kind !== 'menu') {
          b.addEventListener('click', function () {
            var patch = {
              type: 'myhub:office-tabs-select',
              app: st.app,
              id: tab.id,
            };
            postToModule(winId, patch);
          });
        } else {
          b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            requestOfficeMenu(winId, st, menu, b);
          });
        }
        box.appendChild(b);
      });
      if (st.canCollapse) {
        var live = false;
        var hide = false;
        var ttl = 0;
        box.addEventListener('click', function () {
          if (hide) return;
        });
        box.addEventListener('animationstart', function () {
        });
        box.addEventListener('animationend', function () {
        });
        box.removeEventListener('click', function () {
        });
      }
      if (deps.officeTabsEl) {
        if (officeTabsActiveWin === winId) return;
        officeTabsActiveWin = winId;
      }
      if (st && st.menuShell) {
        var shell = officeMenuSetTargets(st, winId);
        shell.forEach(function (item) {
          if (!item || !item.el) return;
          item.el.addEventListener('click', function () {
            officeMenuExec(winId, item);
          });
        });
      }
    }

    var officeMenuCtl = null;
    function getOfficeMenu() {
      if (officeMenuCtl && officeMenuCtl.menu) return officeMenuCtl.menu;
      if (!deps.menuApi || typeof deps.menuApi.createMenu !== 'function') return null;
      var menu = deps.menuApi.createMenu(document, {});
      officeMenuCtl = { menu: menu, show: false, seq: 0, btn: null, winId: null };
      return menu;
    }
    function markOfficeMenuBtnClosed(btn) {
      if (btn) btn.classList.remove('dt-office-tab');
    }
    function closeOfficeMenu() {
      if (officeMenuCtl && officeMenuCtl.menu) officeMenuCtl.menu.close();
      if (officeMenuCtl) officeMenuCtl.show = false;
    }
    function isOfficeMenuExternal(t) {
      return !!t && t.kind === 'menu';
    }

    function officeMenuBuild(st, winId) {
      var out = st && st.tabs ? st.tabs.slice() : [];
      var byWin = officeTabsByWin.get(winId);
      if (byWin && byWin !== st && Array.isArray(byWin.tabs)) {
        var seen = {};
        out.forEach(function (t) {
          seen[t.id] = true;
        });
        byWin.tabs.forEach(function (t) {
          if (!seen[t.id]) out.push(t);
        });
      }
      return out;
    }

    function officeMenuSetTargets(st, winId) {
      /* 메뉴 탭 버튼의 클릭 배선은 renderOfficeTabs의 렌더 루프가
         버튼을 만들 때 함께 건다. 여기서 같은 버튼에 실행 배선을
         또 걸면 한 번의 클릭이 열기+닫기로 겹쳐 실행되므로,
         별도 대상은 두지 않는다. */
      return [];
    }

    function officeMenuExec(winId, item) {
      var st = officeTabsByWin.get(winId) || null;
      if (!st || !item || !item.el) return;
      requestOfficeMenu(winId, st, officeMenuBuild(st, winId), item.el);
    }

    function stepOfficeMenu(dir) {
      var ctl = officeMenuCtl;
      if (!ctl || !ctl.winId) return;
      var st = officeTabsByWin.get(ctl.winId) || null;
      if (!st) return;
      var menus = officeMenuBuild(st, ctl.winId).filter(
        isOfficeMenuExternal,
      );
      if (menus.length < 2) return;
      var idx = -1;
      menus.forEach(function (t, i) {
        if (t.id === ctl.tabId) idx = i;
      });
      if (idx < 0) return;
      var next =
        menus[(idx + (dir < 0 ? -1 : 1) + menus.length) % menus.length];
      var box = deps.officeTabsEl;
      var btn = box
        ? box.querySelector('button[data-tab="' + next.id + '"]')
        : null;
      if (btn) requestOfficeMenu(ctl.winId, st, officeMenuBuild(st, ctl.winId), btn);
    }

    function requestOfficeMenu(winId, st, menuTabs, btn) {
      var menu = getOfficeMenu();
      if (!menu || !btn) return;
      var tabId = btn.getAttribute ? btn.getAttribute('data-tab') : null;
      if (!tabId) return;
      if (
        officeMenuCtl &&
        officeMenuCtl.show &&
        officeMenuCtl.winId === winId &&
        officeMenuCtl.tabId === tabId
      ) {
        closeOfficeMenu();
        officeMenuCtl = null;
        return;
      }
      var seq =
        (officeMenuCtl && officeMenuCtl.seq ? officeMenuCtl.seq : 0) + 1;
      if (officeMenuCtl && officeMenuCtl.timer) {
        clearTimeout(officeMenuCtl.timer);
      }
      officeMenuCtl = {
        menu: menu,
        show: true,
        seq: seq,
        btn: btn,
        winId: winId,
        app: st ? st.app || null : null,
        tabId: tabId,
        pending: true,
        timer: null,
      };
      officeMenuCtl.timer = setTimeout(function () {
        if (officeMenuCtl && officeMenuCtl.seq === seq) {
          officeMenuCtl.pending = false;
        }
      }, 4000);
      postToModule(winId, {
        type: 'myhub:office-tabs-menu-request',
        app: officeMenuCtl.app,
        id: tabId,
        seq: seq,
      });
    }
    function mapOfficeMenuItems(nodes, exec) {
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
        if (typeof n.checked === 'boolean') {
          item.checked = n.checked;
        }
        if (Array.isArray(n.children) && n.children.length) {
          item.children = mapOfficeMenuItems(n.children, exec);
        } else if (Array.isArray(n.path)) {
          var p = n.path.slice();
          item.onSelect = function () {
            exec(p);
          };
        }
        out.push(item);
      });
      return out;
    }
    function openOfficeMenuDropdown(ctl, rawItems) {
      var menu = getOfficeMenu();
      if (!menu) {
        closeOfficeMenu();
        return;
      }
      var winId = ctl.winId;
      var app = ctl.app;
      var tabId = ctl.tabId;
      var btn = ctl.btn;
      var items = mapOfficeMenuItems(rawItems, function (path) {
        postToModule(winId, {
          type: 'myhub:office-tabs-menu-exec',
          app: app,
          id: tabId,
          path: path,
        });
      });
      if (!items.length) {
        closeOfficeMenu();
        return;
      }
      var rect =
        typeof btn.getBoundingClientRect === 'function'
          ? btn.getBoundingClientRect()
          : { left: 0, bottom: 0 };
      menu.open(Math.round(rect.left), Math.round(rect.bottom), items, {
        keepSelector: '.dt-office-tab',
        onSwitch: function (dir) {
          stepOfficeMenu(dir);
        },
        onClose: function () {
          markOfficeMenuBtnClosed(btn);
          if (officeMenuCtl && officeMenuCtl.seq === ctl.seq) {
            officeMenuCtl = null;
          }
        },
      });
    }
    function onOfficeMenuItemsMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:office-tabs-menu-items') return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (
          rec.frame &&
          rec.frame.contentWindow &&
          rec.frame.contentWindow === e.source
        )
          found = id;
      });
      if (!found) return;
      var ctl = officeMenuCtl;
      if (!ctl || !ctl.pending) return;
      if (ctl.winId !== found || ctl.tabId !== d.id || ctl.seq !== d.seq) {
        return;
      }
      if (ctl.timer) {
        clearTimeout(ctl.timer);
        ctl.timer = null;
      }
      ctl.pending = false;
      openOfficeMenuDropdown(ctl, d.items);
    }
    window.addEventListener('message', onOfficeMenuItemsMessage);

    function onOfficeTabsMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:office-tabs') return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (
          rec.frame &&
          rec.frame.contentWindow &&
          rec.frame.contentWindow === e.source
        )
          found = id;
      });
      if (!found) return;
      var st = normalizeOfficeTabState(d);
      if (st) officeTabsByWin.set(found, st);
      else officeTabsByWin.delete(found);
      var stateRec = findWin(found);
      if (stateRec) {
        if (st) stateRec.officeTabs = d;
        else delete stateRec.officeTabs;
      }
      if (deps.officeTabsEl && st && st.menuShell) {
        postToModule(found, {
          type: 'myhub:office-tabs-adopt',
          app: st.app,
        });
      }
      if (found === state.activeId) renderOfficeTabs();
    }
    window.addEventListener('message', onOfficeTabsMessage);

    var finderToolbarByWin = new Map();
    var finderToolsSig = new Map();
    var finderSearchOpen = new Set();
    function normalizeFinderToolbarState(d) {
      if (!d || typeof d !== 'object') return null;
      return {
        canBack: !!d.canBack,
        canFwd: !!d.canFwd,
        mode: d.mode === 'grid' ? 'grid' : 'list',
        sortKey: ['name', 'date', 'size', 'kind'].indexOf(d.sortKey) >= 0 ? d.sortKey : 'name',
        sortDir: d.sortDir === -1 ? -1 : 1,
        drive: !!d.drive,
        query: typeof d.query === 'string' ? d.query : '',
      };
    }
    function finderToolsSignature(winId, st, compact) {
      if (!st) return winId + '|none';
      return [
        winId, compact ? 'c' : 'f',
        st.canBack ? 1 : 0, st.canFwd ? 1 : 0, st.mode, st.sortKey, st.sortDir,
        st.drive ? 1 : 0, st.query, finderSearchOpen.has(winId) ? 1 : 0,
      ].join('|');
    }
    function finderToolsCompact(winId) {
      if (isMobile()) return true;
      var w = findWin(winId);
      return !!w && w.w - 209 < 620;
    }
    function postFinderAction(winId, action, extra) {
      var msg = { type: 'myhub:finder-toolbar-action', action: action };
      if (extra) {
        Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
      }
      postToModule(winId, msg);
    }
    function finderSortAnchor(winId, btn) {
      var rec = entries.get(winId);
      if (!rec || !rec.frame || !btn || typeof btn.getBoundingClientRect !== 'function') return null;
      var fr = rec.frame.getBoundingClientRect();
      var br = btn.getBoundingClientRect();
      return {
        anchorX: Math.round(br.left - fr.left),
        anchorY: Math.round(br.bottom - fr.top + 4),
      };
    }
    function buildFinderTools(winId, box) {
      var doc = box.ownerDocument || document;
      function el(tag, cls, label) {
        var n = doc.createElement(tag);
        if (cls) n.className = cls;
        if (label) {
          n.title = label;
          n.setAttribute('aria-label', label);
        }
        return n;
      }
      function iconBtn(action, icon, label) {
        var b = el('button', 'myhub-ft-btn', label);
        b.type = 'button';
        b.setAttribute('data-ft-action', action);
        b.innerHTML = '<i data-lucide="' + icon + '"></i>';
        b.addEventListener('click', function () {
          if (action === 'sort') {
            var st = finderToolbarByWin.get(winId);
            postFinderAction(winId, 'sort', finderSortAnchor(winId, b) || undefined);
            return;
          }
          postFinderAction(winId, action);
        });
        return b;
      }
      var nav = el('div', 'myhub-ft-nav');
      var back = el('button', 'myhub-ft-navbtn', '');
      back.type = 'button';
      back.setAttribute('data-ft-action', 'back');
      back.innerHTML = '<i data-lucide="chevron-left"></i>';
      back.addEventListener('click', function () { postFinderAction(winId, 'back'); });
      var fwd = el('button', 'myhub-ft-navbtn', '');
      fwd.type = 'button';
      fwd.setAttribute('data-ft-action', 'fwd');
      fwd.innerHTML = '<i data-lucide="chevron-right"></i>';
      fwd.addEventListener('click', function () { postFinderAction(winId, 'fwd'); });
      nav.appendChild(back);
      nav.appendChild(fwd);
      box.appendChild(nav);
      var spacer = el('div', 'myhub-ft-spacer');
      box.appendChild(spacer);
      var center = el('div', 'myhub-ft-center');
      var seg = el('div', 'myhub-ft-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', '');
      var segList = el('button', '', '');
      segList.type = 'button';
      segList.setAttribute('data-ft-action', 'mode-list');
      segList.innerHTML = '<i data-lucide="list"></i>';
      segList.addEventListener('click', function () { postFinderAction(winId, 'mode-list'); });
      var segGrid = el('button', '', '');
      segGrid.type = 'button';
      segGrid.setAttribute('data-ft-action', 'mode-grid');
      segGrid.innerHTML = '<i data-lucide="layout-grid"></i>';
      segGrid.addEventListener('click', function () { postFinderAction(winId, 'mode-grid'); });
      seg.appendChild(segList);
      seg.appendChild(segGrid);
      center.appendChild(seg);
      var sort = el('button', 'myhub-ft-btn myhub-ft-sort', '');
      sort.type = 'button';
      sort.setAttribute('data-ft-action', 'sort');
      sort.innerHTML = '<i data-lucide="arrow-down-wide-narrow"></i><span>정렬</span>';
      sort.addEventListener('click', function () {
        postFinderAction(winId, 'sort', finderSortAnchor(winId, sort) || undefined);
      });
      center.appendChild(sort);
      box.appendChild(center);
      var spacer2 = el('div', 'myhub-ft-spacer');
      box.appendChild(spacer2);
      var more = el('button', 'myhub-ft-btn myhub-ft-more', '');
      more.type = 'button';
      more.setAttribute('data-ft-action', 'more');
      more.innerHTML = '<i data-lucide="ellipsis"></i>';
      more.addEventListener('click', function () {
        openFinderMoreMenu(winId, more);
      });
      box.appendChild(more);
      var trail = el('div', 'myhub-ft-trail');
      trail.appendChild(iconBtn('new-folder', 'folder-plus', ''));
      trail.appendChild(iconBtn('upload', 'upload', ''));
      var searchBtn = el('button', 'myhub-ft-btn myhub-ft-searchbtn', '');
      searchBtn.type = 'button';
      searchBtn.setAttribute('data-ft-action', 'search-open');
      searchBtn.innerHTML = '<i data-lucide="search"></i>';
      searchBtn.addEventListener('click', function () {
        finderSearchOpen.add(winId);
        finderToolsSig.delete(winId);
        renderFinderTools(winId);
        var inp = box.querySelector('.myhub-ft-search input');
        if (inp) inp.focus();
      });
      trail.appendChild(searchBtn);
      var search = el('label', 'myhub-ft-search');
      search.setAttribute('data-nodrag', '');
      search.innerHTML = '<i data-lucide="search"></i>';
      var input = doc.createElement('input');
      input.type = 'text';
      input.placeholder = '검색';
      input.setAttribute('aria-label', '');
      input.addEventListener('input', function () {
        postFinderAction(winId, 'search', { value: input.value });
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          input.value = '';
          postFinderAction(winId, 'search', { value: '' });
          finderSearchOpen.delete(winId);
          finderToolsSig.delete(winId);
          renderFinderTools(winId);
        }
        e.stopPropagation();
      });
      input.addEventListener('blur', function () {
        if (!input.value) {
          finderSearchOpen.delete(winId);
          finderToolsSig.delete(winId);
          renderFinderTools(winId);
        }
      });
      search.appendChild(input);
      trail.appendChild(search);
      box.appendChild(trail);
      refreshIcons();
    }
    function renderFinderTools(winId) {
      var rec = entries.get(winId);
      if (!rec) return;
      var box = rec.el.querySelector('.myhub-win-tools');
      if (!box) return;
      var st = finderToolbarByWin.get(winId) || null;
      var compact = !!st && finderToolsCompact(winId);
      var sig = finderToolsSignature(winId, st, compact);
      if (sig === finderToolsSig.get(winId)) return;
      finderToolsSig.set(winId, sig);
      if (!st) {
        box.hidden = true;
        return;
      }
      if (!box.hasChildNodes()) buildFinderTools(winId, box);
      box.hidden = false;
      box.classList.toggle('is-compact', compact);
      var open = finderSearchOpen.has(winId) || !!st.query;
      box.classList.toggle('is-search-open', open);
      var q = function (sel) { return box.querySelector(sel); };
      var back = q('[data-ft-action="back"]');
      var fwd = q('[data-ft-action="fwd"]');
      if (back) back.disabled = !st.canBack;
      if (fwd) fwd.disabled = !st.canFwd;
      var segList = q('[data-ft-action="mode-list"]');
      var segGrid = q('[data-ft-action="mode-grid"]');
      if (segList) segList.classList.toggle('is-active', st.mode === 'list');
      if (segGrid) segGrid.classList.toggle('is-active', st.mode === 'grid');
      ['new-folder', 'upload'].forEach(function (a) {
        var b = q('[data-ft-action="' + a + '"]');
        if (b) b.hidden = !st.drive;
      });
      var input = q('.myhub-ft-search input');
      if (input && box.ownerDocument.activeElement !== input && input.value !== st.query) {
        input.value = st.query;
      }
    }
    var finderMenu = null;
    function openFinderMoreMenu(winId, btn) {
      var api = getMenuApi();
      if (!api) return;
      if (!finderMenu) {
        finderMenu = api.createMenu(document, { refreshIcons: refreshIcons });
      }
      var st = finderToolbarByWin.get(winId);
      if (!st) return;
      var items = [
        {
          label: '목록으로 보기',
          checked: st.mode === 'list',
          onSelect: function () { postFinderAction(winId, 'mode-list'); },
        },
        {
          label: '아이콘으로 보기',
          checked: st.mode === 'grid',
          onSelect: function () { postFinderAction(winId, 'mode-grid'); },
        },
        { separator: true },
      ];
      [['name', '이름'], ['date', '수정일'], ['size', '크기'], ['kind', '종류']].forEach(function (pair) {
        items.push({
          label: '정렬: ' + pair[1],
          checked: st.sortKey === pair[0],
          onSelect: function () { postFinderAction(winId, 'sort-by', { key: pair[0] }); },
        });
      });
      var r = btn.getBoundingClientRect();
      finderMenu.open(r.left, r.bottom + 4, items);
    }
    function onFinderToolbarMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d) return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (rec.frame && rec.frame.contentWindow && rec.frame.contentWindow === e.source) found = id;
      });
      if (!found) return;
      if (d.type === 'myhub:finder-toolbar') {
        var rec = entries.get(found);
        if (!rec || !rec.el.querySelector('.myhub-win-tools')) return;
        var st = normalizeFinderToolbarState(d.state);
        if (st) finderToolbarByWin.set(found, st);
        else finderToolbarByWin.delete(found);
        postToModule(found, { type: 'myhub:finder-toolbar-adopt' });
        renderFinderTools(found);
      } else if (d.type === 'myhub:finder-toolbar-focus-search') {
        finderSearchOpen.add(found);
        finderToolsSig.delete(found);
        renderFinderTools(found);
        var rec2 = entries.get(found);
        var inp = rec2 ? rec2.el.querySelector('.myhub-win-tools .myhub-ft-search input') : null;
        if (inp) inp.focus();
      }
    }
    window.addEventListener('message', onFinderToolbarMessage);

    var officeQuickByWin = new Map();
    var officeQuickSig = new Map();
    var officeFoldByWin = new Map();
    var OFFICE_QUICK_DEFS = [
      { action: 'save', icon: 'save', label: '저장' },
      { action: 'print', icon: 'printer', label: '인쇄' },
      { action: 'undo', icon: 'undo-2', label: '실행 취소' },
      { action: 'redo', icon: 'redo-2', label: '다시 실행' },
    ];
    function normalizeOfficeQuickState(q) {
      if (!q || typeof q !== 'object') return null;
      var st = { search: !!q.search };
      var any = st.search;
      OFFICE_QUICK_DEFS.forEach(function (def) {
        st[def.action] = !!q[def.action];
        if (st[def.action]) any = true;
      });
      return any ? st : null;
    }
    function postOfficeQuickAction(winId, action, value) {
      var msg = { type: 'myhub:office-quick-action', action: action };
      if (typeof value === 'string') msg.value = value;
      postToModule(winId, msg);
    }
    var officePrintPreByWin = new Map();
    function closeOfficePrintPre(winId) {
      var slot = officePrintPreByWin.get(winId);
      if (!slot) return;
      officePrintPreByWin.delete(winId);
      if (slot.timer) clearTimeout(slot.timer);
      var rec = entries.get(winId);
      var frameWin = rec && rec.frame && rec.frame.contentWindow;
      var pending = null;
      try {
        pending = frameWin ? frameWin.__myhubPreopenedPrintWindow : null;
      } catch (e) {
        pending = null;
      }
      if (pending === slot.win) {
        try {
          frameWin.__myhubPreopenedPrintWindow = null;
        } catch (e) {
          console.warn(':', e);
        }
        try {
          if (!slot.win.closed) slot.win.close();
        } catch (e) {
          console.warn(':', e);
        }
      }
    }
    function preopenOfficePrintWindow(winId) {
      var rec = entries.get(winId);
      if (!rec || !rec.el || rec.el.dataset.module !== 'hangul') return;
      closeOfficePrintPre(winId);
      var w = null;
      try {
        w = window.open('/rhwp-studio/print.html', '_blank');
      } catch (e) {
        w = null;
      }
      if (!w) return;
      var frameWin = rec.frame && rec.frame.contentWindow;
      if (frameWin) {
        try {
          frameWin.__myhubPreopenedPrintWindow = w;
        } catch (e) {
          try {
            w.close();
          } catch (e2) {
            console.warn(':', e2);
          }
          return;
        }
      }
      var timer = setTimeout(function () {
        closeOfficePrintPre(winId);
      }, 12000);
      officePrintPreByWin.set(winId, { win: w, timer: timer });
    }
    function officeQuickSignature(winId, st) {
      var fold = officeFoldByWin.get(winId) || null;
      var foldBit = fold && fold.available ? (fold.folded ? 'F1' : 'F0') : 'F-';
      if (!st) return winId + '|none|' + foldBit;
      var bits = OFFICE_QUICK_DEFS.map(function (def) {
        return st[def.action] ? '1' : '0';
      }).join('');
      return winId + '|' + bits + '|' + (st.search ? '1' : '0') + '|' + foldBit;
    }
    function renderOfficeQuick(winId) {
      var rec = entries.get(winId);
      if (!rec) return;
      var box = rec.el.querySelector('.myhub-win-quick');
      if (!box) return;
      var st = officeQuickByWin.get(winId) || null;
      var sig = officeQuickSignature(winId, st);
      if (sig === officeQuickSig.get(winId)) return;
      officeQuickSig.set(winId, sig);
      box.innerHTML = '';
      var foldSt = officeFoldByWin.get(winId) || null;
      if (foldSt && foldSt.available) {
        var fb = document.createElement('button');
        fb.type = 'button';
        fb.className = 'myhub-oq-btn myhub-win-fold';
        fb.title = foldSt.folded ? '펼치기' : '접기';
        fb.setAttribute('aria-label', fb.title);
        fb.setAttribute('aria-expanded', foldSt.folded ? 'false' : 'true');
        fb.setAttribute('data-fold-state', foldSt.folded ? 'folded' : 'open');
        // 접기 아이콘은 Lucide 셰브론으로 (2026-11-12 사용자 지적):
        // CSS 테두리로 그린 7px 꺽쇠는 옆의 Lucide 빠른 실행 아이콘들과
        // 결이 달라 제목줄에서 튀었다. 상태별 방향은
        // 그대로(펼침=위, 접힘=아래)이며, renderOfficeQuick 말미의
        // refreshIcons()가 <i>를 SVG로 바꾼다.
        fb.innerHTML =
          '<i data-lucide="' +
          (foldSt.folded ? 'chevron-down' : 'chevron-up') +
          '"></i>';
        fb.addEventListener('click', function () {
          postToModule(winId, {
            type: 'myhub:office-fold-toggle',
            app: foldSt.app,
          });
        });
        box.appendChild(fb);
      }
      if (st) {
        OFFICE_QUICK_DEFS.forEach(function (def) {
          if (!st[def.action]) return;
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'myhub-oq-btn';
          b.title = def.label;
          b.setAttribute('aria-label', def.label);
          b.setAttribute('data-oq-action', def.action);
          b.innerHTML = '<i data-lucide="' + def.icon + '"></i>';
          b.addEventListener('click', function () {
            if (def.action === 'print') preopenOfficePrintWindow(winId);
            postOfficeQuickAction(winId, def.action);
          });
          box.appendChild(b);
        });
      }
      box.hidden = box.childNodes.length === 0;
      var searchBox = rec.el.querySelector('.myhub-win-search');
      if (searchBox) {
        if (st && st.search) {
          if (!searchBox.hasChildNodes()) buildOfficeSearch(winId, searchBox);
          searchBox.hidden = false;
        } else {
          searchBox.hidden = true;
        }
      }
      refreshIcons();
    }
    function buildOfficeSearch(winId, searchBox) {
      var label = document.createElement('label');
      label.className = 'myhub-oq-search';
      label.setAttribute('data-nodrag', '');
      label.innerHTML = '<i data-lucide="search"></i>';
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '문서 내 검색';
      input.setAttribute('aria-label', '문서 내 검색');
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          postOfficeQuickAction(winId, 'search', input.value);
        } else if (e.key === 'Escape') {
          input.value = '';
          input.blur();
        }
        e.stopPropagation();
      });
      input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      label.appendChild(input);
      searchBox.appendChild(label);
    }
    function onOfficeQuickMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:office-quick') return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (rec.frame && rec.frame.contentWindow && rec.frame.contentWindow === e.source) found = id;
      });
      if (!found) return;
      var rec = entries.get(found);
      if (!rec || !rec.el.querySelector('.myhub-win-quick')) return;
      var st = normalizeOfficeQuickState(d.quick);
      if (st) officeQuickByWin.set(found, st);
      else officeQuickByWin.delete(found);
      renderOfficeQuick(found);
    }
    window.addEventListener('message', onOfficeQuickMessage);

    function onOfficeFoldMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:office-fold') return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (rec.frame && rec.frame.contentWindow && rec.frame.contentWindow === e.source) found = id;
      });
      if (!found) return;
      var rec = entries.get(found);
      if (!rec || !rec.el.querySelector('.myhub-win-quick')) return;
      if (d.available) {
        officeFoldByWin.set(found, {
          app: typeof d.app === 'string' ? d.app : null,
          available: true,
          folded: !!d.folded,
        });
      } else {
        officeFoldByWin.delete(found);
      }
      renderOfficeQuick(found);
    }
    window.addEventListener('message', onOfficeFoldMessage);

    var winActionsByWin = new Map();
    var winActionsSig = new Map();
    function normalizeWinActions(d) {
      if (!d || !Array.isArray(d.actions)) return null;
      var out = [];
      d.actions.forEach(function (a) {
        if (!a || typeof a.id !== 'string' || !a.id || a.hidden) return;
        out.push({
          id: a.id,
          icon: typeof a.icon === 'string' && a.icon ? a.icon : 'circle',
          label: typeof a.label === 'string' ? a.label : '',
          active: !!a.active,
          disabled: !!a.disabled,
        });
      });
      return out.length ? out : null;
    }
    function winActionsSignature(winId, st) {
      if (!st) return winId + '|none';
      return winId + '|' + st.map(function (a) {
        return a.id + ':' + a.icon + ':' + (a.active ? 1 : 0) + (a.disabled ? 1 : 0);
      }).join(',');
    }
    function renderWinActions(winId) {
      var rec = entries.get(winId);
      if (!rec) return;
      var box = rec.el.querySelector('.myhub-win-actions');
      if (!box) return;
      var st = winActionsByWin.get(winId) || null;
      if (rec.el.classList.contains('dt-win-studio')) {
        var sbFolded = false;
        if (st) st.forEach(function (a) { if (a.id === 'studio-sidebar') sbFolded = !!a.active; });
        rec.el.classList.toggle('dt-side-collapsed', sbFolded);
      }
      var sig = winActionsSignature(winId, st);
      if (sig === winActionsSig.get(winId)) return;
      winActionsSig.set(winId, sig);
      box.innerHTML = '';
      if (st) {
        st.forEach(function (a) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'myhub-wa-btn' + (a.active ? ' active' : '');
          b.title = a.label;
          b.setAttribute('aria-label', a.label);
          b.setAttribute('aria-pressed', a.active ? 'true' : 'false');
          b.setAttribute('data-wa-id', a.id);
          b.disabled = a.disabled;
          b.innerHTML = '<i data-lucide="' + a.icon + '"></i>';
          b.addEventListener('click', function () {
            postToModule(winId, { type: 'myhub:win-action-click', id: a.id });
          });
          box.appendChild(b);
        });
      }
      box.hidden = box.childNodes.length === 0;
      refreshIcons();
    }
    function onWinActionsMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:win-actions') return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (rec.frame && rec.frame.contentWindow && rec.frame.contentWindow === e.source) found = id;
      });
      if (!found) return;
      var rec = entries.get(found);
      if (!rec || !rec.el.querySelector('.myhub-win-actions')) return;
      var st = normalizeWinActions(d);
      if (st) winActionsByWin.set(found, st);
      else winActionsByWin.delete(found);
      renderWinActions(found);
    }
    window.addEventListener('message', onWinActionsMessage);

    var browserTabsByWin = new Map();
    var browserTabsSig = new Map();
    function normalizeBrowserTabs(d) {
      if (!d || !Array.isArray(d.tabs)) return null;
      var tabs = [];
      d.tabs.forEach(function (t) {
        if (!t || typeof t.id !== 'string' || !t.id) return;
        tabs.push({
          id: t.id,
          label: typeof t.label === 'string' && t.label ? t.label : t.id,
          live: !!t.live,
        });
      });
      if (!tabs.length) return null;
      return {
        tabs: tabs,
        activeId:
          typeof d.activeId === 'string' ? d.activeId : tabs[0].id,
      };
    }
    function browserTabsSignature(winId, st) {
      if (!st) return winId + '|none';
      return [
        winId,
        st.activeId || '',
        st.tabs
          .map(function (t) {
            return t.id + ':' + t.label + ':' + (t.live ? 1 : 0);
          })
          .join(','),
      ].join('|');
    }
    function renderBrowserTabs(winId) {
      var rec = entries.get(winId);
      if (!rec) return;
      var box = rec.el.querySelector('.myhub-win-btabs');
      if (!box) return;
      var st = browserTabsByWin.get(winId) || null;
      rec.el.classList.toggle('dt-win-btabs-on', !!st);
      var sig = browserTabsSignature(winId, st);
      if (sig === browserTabsSig.get(winId)) return;
      browserTabsSig.set(winId, sig);
      box.innerHTML = '';
      if (st) {
        st.tabs.forEach(function (t) {
          var wrap = document.createElement('div');
          wrap.className =
            'myhub-btab' + (t.id === st.activeId ? ' is-active' : '');
          var main = document.createElement('button');
          main.type = 'button';
          main.className = 'myhub-btab-main';
          main.setAttribute('role', 'tab');
          main.setAttribute(
            'aria-selected',
            t.id === st.activeId ? 'true' : 'false',
          );
          main.setAttribute('data-btab-id', t.id);
          var name = document.createElement('span');
          name.className = 'myhub-btab-name';
          name.textContent = t.label;
          main.appendChild(name);
          if (t.live) {
            var dot = document.createElement('span');
            dot.className = 'myhub-btab-live';
            dot.title = '';
            main.appendChild(dot);
          }
          main.addEventListener('click', function () {
            postToModule(winId, {
              type: 'myhub:browser-tabs-action',
              action: 'select',
              id: t.id,
            });
          });
          wrap.appendChild(main);
          var close = document.createElement('button');
          close.type = 'button';
          close.className = 'myhub-btab-close';
          close.setAttribute('aria-label', '');
          close.innerHTML = '<i data-lucide="x"></i>';
          close.addEventListener('click', function () {
            postToModule(winId, {
              type: 'myhub:browser-tabs-action',
              action: 'close',
              id: t.id,
            });
          });
          wrap.appendChild(close);
          box.appendChild(wrap);
        });
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'myhub-btab-new';
        add.setAttribute('aria-label', '');
        add.innerHTML = '<i data-lucide="plus"></i>';
        add.addEventListener('click', function () {
          postToModule(winId, {
            type: 'myhub:browser-tabs-action',
            action: 'new',
          });
        });
        box.appendChild(add);
      }
      box.hidden = box.childNodes.length === 0;
      refreshIcons();
    }
    function onBrowserTabsMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:browser-tabs') return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (
          rec.frame &&
          rec.frame.contentWindow &&
          rec.frame.contentWindow === e.source
        )
          found = id;
      });
      if (!found) return;
      var rec = entries.get(found);
      if (!rec || !rec.el.querySelector('.myhub-win-btabs')) return;
      var st = normalizeBrowserTabs(d);
      if (st) browserTabsByWin.set(found, st);
      else browserTabsByWin.delete(found);
      renderBrowserTabs(found);
      if (st) postToModule(found, { type: 'myhub:browser-tabs-adopt' });
    }
    window.addEventListener('message', onBrowserTabsMessage);

    var assistantByWin = new Map();
    var assistantListeners = new Set();
    var assistantSig = '';
    function getActiveAssistant() {
      var id = state.activeId;
      if (!id) return null;
      var decl = assistantByWin.get(id);
      if (!decl) return null;
      return {
        winId: id,
        personaId: decl.personaId,
        personaName: decl.personaName,
        avatar: decl.avatar,
        flavor: decl.flavor,
      };
    }
    function syncAssistantAvatar() {
      var active = getActiveAssistant();
      var sig = active
        ? active.winId + '|' + active.personaId + '|' + active.avatar + '|' + active.flavor
        : state.activeId + '|none';
      if (sig === assistantSig) return;
      assistantSig = sig;
      assistantListeners.forEach(function (fn) {
        try {
          fn(active);
        } catch (e) {
          console.warn('', e);
        }
      });
    }
    function onAssistantDeclareMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'myhub:assistant-declare') return;
      if (typeof d.personaId !== 'string' || !d.personaId) return;
      var found = null;
      entries.forEach(function (rec, id) {
        if (rec.frame && rec.frame.contentWindow && rec.frame.contentWindow === e.source) found = id;
      });
      if (!found) return;
      assistantByWin.set(found, {
        personaId: d.personaId,
        personaName: typeof d.personaName === 'string' ? d.personaName : '',
        avatar: typeof d.avatar === 'string' ? d.avatar : '',
        flavor: d.flavor === 'office' ? 'office' : 'chat',
      });
      if (found === state.activeId) syncAssistantAvatar();
    }
    window.addEventListener('message', onAssistantDeclareMessage);
    function ensureHotZone() {
      if (hotZone || !taskbar || !taskbar.parentNode) return;
      hotZone = document.createElement('div');
      hotZone.className = 'dt-dock-hotzone';
      hotZone.setAttribute('aria-hidden', 'true');
      taskbar.parentNode.appendChild(hotZone);
      function peekOn() {
        if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
        if (taskbar) taskbar.classList.add('dt-dock-peek');
      }
      function peekOffSoon() {
        if (peekTimer) clearTimeout(peekTimer);
        peekTimer = setTimeout(function () {
          if (taskbar) taskbar.classList.remove('dt-dock-peek');
        }, 300);
      }
      hotZone.addEventListener('pointerenter', peekOn);
      hotZone.addEventListener('pointerleave', peekOffSoon);
      taskbar.addEventListener('pointerenter', peekOn);
      taskbar.addEventListener('pointerleave', peekOffSoon);
    }

    var dock = null;
    var dockIds = null;
    function getDockApi() {
      return (typeof deps.dockApi === 'function' ? deps.dockApi() : null) || (typeof window !== 'undefined' ? window.MyHubDesktopDock : null);
    }
    function dockCatalog() {
      var catalog = {};
      (stateApi.MODULES || []).forEach(function (mod) {
        catalog[mod.id] = { id: mod.id, label: mod.title };
      });
      delete catalog.backup;
      catalog.settings = {
        id: 'settings',
        label: '설정',
        onSelect: function () {
          var doc = (root && root.ownerDocument) || document;
          var btn = doc.querySelector('.g-nav .settings-btn');
          if (btn) btn.click();
        },
      };
      return catalog;
    }
    function ensureDockIds() {
      if (dockIds !== null) return dockIds;
      var dockApi = getDockApi();
      var catalog = dockCatalog();
      dockIds = dockApi && typeof dockApi.loadDockIds === 'function'
        ? dockApi.loadDockIds(storage, Object.keys(catalog))
        : Object.keys(catalog);
      return dockIds;
    }
    function persistDockIds() {
      var dockApi = getDockApi();
      if (dockApi && typeof dockApi.saveDockIds === 'function') {
        try { dockApi.saveDockIds(storage, dockIds); } catch (e) { console.warn('', e); }
      }
    }
    function ensureDock() {
      if (dock || !taskbar) return dock;
      var dockApi = getDockApi();
      var tilesApi = deps.tilesApi || (typeof window !== 'undefined' ? window.MyHubDesktopTiles : null);
      if (!dockApi || !tilesApi) return null;
      var catalog = dockCatalog();
      var moduleIds = {};
      (stateApi.MODULES || []).forEach(function (m) { moduleIds[m.id] = true; });
      var items = [];
      ensureDockIds().forEach(function (id) {
        var def = catalog[id];
        if (!def) return;
        var item = { id: def.id, label: def.label, reorderable: true };
        if (def.href) item.href = def.href;
        if (def.onSelect) item.onSelect = def.onSelect;
        items.push(item);
      });
      for (var i = 1; i < items.length; i++) {
        if (!moduleIds[items[i].id]) {
          items[i].separatorBefore = true;
          break;
        }
      }
      var extraSep = true;
      visibleRecents().forEach(function (id) {
        var def = catalog[id];
        if (!def) return;
        var item = { id: def.id, label: def.label };
        if (extraSep) { item.separatorBefore = true; extraSep = false; }
        items.push(item);
      });
      var trashItem = {
        id: 'trash',
        label: '휴지통',
        onSelect: function () { openFinderTrash(); },
      };
      if (extraSep) trashItem.separatorBefore = true;
      items.push(trashItem);
      dock = dockApi.createDock({
        container: taskbar,
        tilesApi: tilesApi,
        items: items,
        onActivate: function (id) { openModule(id); },
        onRemoveItem: function (id) {
          if (id === 'trash') return;
          if (ensureDockIds().indexOf(id) >= 0) removeFromDock(id);
          else removeRecent(id);
        },
        onReorder: function (ids) {
          dockIds = ids.slice();
          persistDockIds();
        },
        onContextMenu: function (item, x, y) {
          var menuItems = [];
          if (item.id === 'trash') {
            menuItems.push({
              label: 'Finder에서 휴지통 열기', icon: 'trash-2',
              onSelect: function () { openFinderTrash(); },
            });
            if (loadTrash().length || (driveTrashCount || 0) > 0) {
              menuItems.push({
                label: '휴지통 비우기', icon: 'trash-2', danger: true,
                onSelect: function () { emptyTrash(); },
              });
            }
          } else if (item.id === 'mission' || item.id === 'settings') {
            return;
          } else if (findModule(item.id)) {
            menuItems.push({
              label: '열기', icon: 'arrow-up-right',
              onSelect: function () { openModule(item.id); },
            });
            menuItems.push({ separator: true });
            if (ensureDockIds().indexOf(item.id) >= 0) {
              if (item.id !== 'finder') {
                menuItems.push({
                  label: '독에서 제거', icon: 'x', danger: true,
                  onSelect: function () { removeFromDock(item.id); },
                });
              }
            } else {
              menuItems.push({
                label: '독에 고정', icon: 'pin',
                onSelect: function () { addToDock(item.id); },
              });
            }
          }
          if (menuItems.length) openCtxMenu(x, y, menuItems);
        },
      });
      return dock;
    }
    function rebuildDock() {
      if (dock) {
        dock.destroy();
        dock = null;
      }
      renderDock();
    }
    function addToDock(id) {
      var catalog = dockCatalog();
      if (!catalog[id]) return;
      ensureDockIds();
      if (dockIds.indexOf(id) >= 0) return;
      dockIds.push(id);
      persistDockIds();
      rebuildDock();
    }
    function removeFromDock(id) {
      if (id === 'finder') return;
      ensureDockIds();
      var idx = dockIds.indexOf(id);
      if (idx < 0) return;
      dockIds.splice(idx, 1);
      persistDockIds();
      rebuildDock();
    }
    var RECENTS_KEY = 'myhub.desktop.recents.v1';
    var recents = null;
    function loadRecents() {
      if (recents) return recents;
      var out = [];
      try {
        var parsed = JSON.parse(storage ? storage.getItem(RECENTS_KEY) || 'null' : 'null');
        if (Array.isArray(parsed)) {
          parsed.forEach(function (id) {
            if (findModule(id) && out.indexOf(id) < 0) out.push(id);
          });
        }
      } catch (e) { console.warn('', e); }
      recents = out;
      return recents;
    }
    function saveRecents() {
      try {
        if (storage) storage.setItem(RECENTS_KEY, JSON.stringify(loadRecents()));
      } catch (e) { console.warn('', e); }
    }
    function visibleRecents() {
      var pinned = ensureDockIds();
      return loadRecents().filter(function (id) { return id !== 'backup' && pinned.indexOf(id) < 0; }).slice(0, 3);
    }
    function noteRecent(id) {
      if (!findModule(id)) return;
      var before = visibleRecents().join(',');
      var list = loadRecents().filter(function (x) { return x !== id; });
      list.unshift(id);
      recents = list.slice(0, 5);
      saveRecents();
      if (visibleRecents().join(',') !== before) rebuildDock();
    }
    function removeRecent(id) {
      recents = loadRecents().filter(function (x) { return x !== id; });
      saveRecents();
      rebuildDock();
    }

    var TRASH_KEY = 'myhub.desktop.trash.v1';
    var trashItems = null;
    var trashRestorer = null;
    function loadTrash() {
      if (trashItems) return trashItems;
      var out = [];
      try {
        var parsed = JSON.parse(storage ? storage.getItem(TRASH_KEY) || 'null' : 'null');
        if (Array.isArray(parsed)) {
          parsed.forEach(function (en) {
            if (en && en.id) out.push({ kind: en.kind || 'icon', id: en.id, label: en.label || en.id, at: en.at || 0 });
          });
        }
      } catch (e) { console.warn(':', e); }
      trashItems = out;
      return trashItems;
    }
    function saveTrash() {
      try {
        if (storage) storage.setItem(TRASH_KEY, JSON.stringify(loadTrash()));
      } catch (e) { console.warn(':', e); }
    }
    function addToTrash(entries) {
      var list = loadTrash();
      (entries || []).forEach(function (en) {
        if (!en || !en.id) return;
        var exists = list.some(function (t) { return t.kind === (en.kind || 'icon') && t.id === en.id; });
        if (!exists) list.push({ kind: en.kind || 'icon', id: en.id, label: en.label || en.id, at: Date.now() });
      });
      trashItems = list;
      saveTrash();
      decorateTrash();
    }
    var driveTrashCount = null;
    var driveTrashFetchedAt = 0;
    function refreshDriveTrash(force) {
      var now = Date.now();
      if (!force && driveTrashFetchedAt && now - driveTrashFetchedAt < 30000) return;
      driveTrashFetchedAt = now;
      if (typeof fetch !== 'function') return;
      fetch('/api/drive/trash', { headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (json) {
          if (!json || !json.ok) return;
          var n =
            (Array.isArray(json.files) ? json.files.length : 0) +
            (Array.isArray(json.folders) ? json.folders.length : 0);
          driveTrashCount = n;
          decorateTrash();
        })
        .catch(function (e) { console.warn(':', e); });
    }
    function decorateTrash() {
      if (!taskbar) return;
      var btn = taskbar.querySelector('[data-module="trash"]');
      if (!btn) return;
      var n = loadTrash().length;
      btn.classList.toggle('dt-trash-full', n > 0 || (driveTrashCount || 0) > 0);
      var badge = btn.querySelector('.dt-trash-count');
      if (n > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'dt-trash-count';
          btn.appendChild(badge);
        }
        badge.textContent = String(n);
      } else if (badge) {
        badge.remove();
      }
    }
    function restoreTrashEntry(entry) {
      trashItems = loadTrash().filter(function (t) {
        return !(t.kind === entry.kind && t.id === entry.id);
      });
      saveTrash();
      decorateTrash();
      broadcastIconTrashChanged();
      if (trashRestorer) trashRestorer(entry);
    }
    function purgeIconTrashEntry(entry) {
      trashItems = loadTrash().filter(function (t) {
        return !(t.kind === entry.kind && t.id === entry.id);
      });
      saveTrash();
      decorateTrash();
      broadcastIconTrashChanged();
    }
    function emptyIconTrash() {
      trashItems = [];
      saveTrash();
      decorateTrash();
      broadcastIconTrashChanged();
    }
    function broadcastIconTrashChanged() {
      postToModule('finder', { type: 'myhub:icon-trash-changed' });
    }
    function emptyTrash() {
      var localCount = loadTrash().length;
      var driveCount = driveTrashCount || 0;
      if (!localCount && !driveCount) return Promise.resolve(false);
      if (
        typeof window !== 'undefined' &&
        typeof window.confirm === 'function' &&
        !window.confirm(
          '' + (localCount + driveCount) + '',
        )
      ) {
        return Promise.resolve(false);
      }
      var purgeDrive =
        typeof fetch === 'function'
          ? fetch('/api/drive/trash', { headers: { Accept: 'application/json' } })
              .then(function (res) {
                return res && res.ok ? res.json() : null;
              })
              .then(function (json) {
                if (!json || !json.ok) return null;
                var urls = [];
                (json.folders || []).forEach(function (f) {
                  urls.push('/api/drive/folders/' + f.id);
                });
                (json.files || []).forEach(function (f) {
                  if (!f.via_folder) urls.push('/api/drive/files/' + f.id);
                });
                var chain = Promise.resolve();
                urls.forEach(function (url) {
                  chain = chain.then(function () {
                    return fetch(url, { method: 'DELETE' }).catch(function () {
                      return null;
                    });
                  });
                });
                return chain;
              })
              .catch(function (e) {
                console.warn(':', e);
                return null;
              })
          : Promise.resolve(null);
      return purgeDrive.then(function () {
        driveTrashCount = 0;
        emptyIconTrash();
        refreshDriveTrash(true);
        return true;
      });
    }

    var finderViewPending = null;
    var finderViewReady = false;
    function deliverFinderView() {
      if (!finderViewPending || !finderViewReady) return;
      postToModule('finder', { type: 'myhub:open-view', view: finderViewPending });
    }
    function openFinderTrash() {
      finderViewPending = 'trash';
      openModule('finder');
      deliverFinderView();
    }
    var officeOpenPending = {};
    var officeReady = {};
    function deliverOfficeOpen(app) {
      var msg = officeOpenPending[app];
      if (!msg || !officeReady[app]) return;
      postToModule(app, {
        type: 'myhub:open-file',
        fileId: msg.fileId,
        name: msg.name,
        mime: msg.mime,
        version: msg.version || null,
        folderId: msg.folderId === undefined ? null : msg.folderId,
        folderName: msg.folderName || '',
      });
    }
    function openInApp(d) {
      if (!d.app || !findModule(d.app)) return;
      officeOpenPending[d.app] = d;
      openModule(d.app);
      deliverOfficeOpen(d.app);
    }

    function onFinderMessage(e) {
      if (!e || e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d) return;
      if (d.type === 'myhub:open-in-app') {
        openInApp(d);
      } else if (d.type === 'myhub:open-module') {
        if (d.module && findModule(d.module)) openModule(d.module);
      } else if (d.type === 'myhub:request-apps') {
        postToModule('finder', {
          type: 'myhub:apps',
          apps: stateApi.MODULES.filter(function (m) {
            return m.id !== 'finder';
          }).map(function (m) {
            return { id: m.id, title: m.title, url: m.url, glyph: m.glyph || null };
          }),
        });
      } else if (d.type === 'myhub:office-ready') {
        if (d.app) {
          officeReady[d.app] = true;
          deliverOfficeOpen(d.app);
        }
      } else if (d.type === 'myhub:open-file-ack') {
        var pending = d.app ? officeOpenPending[d.app] : null;
        if (pending && pending.fileId === d.fileId) delete officeOpenPending[d.app];
      } else if (d.type === 'myhub:finder-ready') {
        finderViewReady = true;
        deliverFinderView();
      } else if (d.type === 'myhub:open-view-ack') {
        if (d.view === finderViewPending) finderViewPending = null;
      } else if (d.type === 'myhub:icon-trash-restore') {
        if (d.entry) restoreTrashEntry(d.entry);
      } else if (d.type === 'myhub:icon-trash-purge') {
        if (d.entry) purgeIconTrashEntry(d.entry);
      } else if (d.type === 'myhub:icon-trash-purge-all') {
        emptyIconTrash();
      }
    }
    window.addEventListener('message', onFinderMessage);

    function getMenuApi() {
      return deps.menuApi || (typeof window !== 'undefined' ? window.MyHubDesktopMenu : null);
    }
    var ctxMenu = null;
    function openCtxMenu(x, y, items) {
      var api = getMenuApi();
      if (!api || !items.length) return;
      if (!ctxMenu) {
        var tiles = deps.tilesApi || (typeof window !== 'undefined' ? window.MyHubDesktopTiles : null);
        ctxMenu = api.createMenu(document, {
          refreshIcons: tiles && tiles.refreshIcons ? tiles.refreshIcons : undefined,
        });
      }
      ctxMenu.open(x, y, items);
    }

    function renderDock() {
      var d = ensureDock();
      if (!d) return;
      var openIds = [];
      var minimizedIds = [];
      state.windows.forEach(function (win) {
        openIds.push(win.module);
        if (win.minimized) minimizedIds.push(win.module);
      });
      d.update({ openIds: openIds, activeId: state.activeId, minimizedIds: minimizedIds });
      decorateTrash();
      refreshDriveTrash(false);
    }

    function switchSpace(spaceId) {
      commit(stateApi.setActiveSpace(state, spaceId));
    }
    function switchAdjacentSpace(dir) {
      var idx = state.spaces.indexOf(state.activeSpace);
      if (idx < 0) return;
      var next = state.spaces[idx + dir];
      if (next === undefined) return;
      switchSpace(next);
    }
    function addSpace() {
      commit(stateApi.addSpace(state));
    }
    function removeSpace(spaceId) {
      commit(stateApi.removeSpace(state, spaceId));
    }
    function spaceSettingsItems() {
      var children = state.spaces.map(function (spaceId, i) {
        return {
          id: 'desktop-space-' + spaceId,
          label: '데스크톱 ' + (i + 1),
          checked: function () { return state.activeSpace === spaceId; },
          onSelect: function () { switchSpace(spaceId); },
        };
      });
      children.push({
        id: 'desktop-space-add',
        label: '데스크톱 추가',
        onSelect: function () { addSpace(); },
      });
      return [{ id: 'desktop-space-group', group: '데스크톱', children: children }];
    }
    function onKeydown(e) {
      if (missionOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMission();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmMission();
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          moveMissionSel(e.key === 'ArrowRight' ? 1 : -1);
          return;
        }
        if (e.ctrlKey && e.key === 'ArrowUp') {
          e.preventDefault();
          closeMission();
          return;
        }
        return;
      }
      if (!e.ctrlKey) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        toggleMission();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        switchAdjacentSpace(e.key === 'ArrowRight' ? 1 : -1);
      }
    }
    document.addEventListener('keydown', onKeydown);

    var missionOpen = false;
    var missionSel = null;
    var lastMissionDrop = 0;
    var missionBg = null;
    var missionCardsArr = [];
    var missionAddEl = null;
    var missionLayout = new Map();
    var missionDrag = null;
    var missionWired = false;
    var MISSION_ANIM_MS = 280;
    var missionBlurTimer = null;
    var missionClosing = false;
    var missionCloseTimer = null;
    function missionBusy() { return missionOpen || missionClosing; }
    function toggleMission() {
      if (missionOpen) closeMission();
      else openMission();
    }
    function ensureMissionBg() {
      if (missionBg) return missionBg;
      var anchor = deps.missionEl;
      if (!anchor || !anchor.parentNode) return null;
      missionBg = document.createElement('div');
      missionBg.className = 'dt-mission-bg';
      missionBg.hidden = true;
      anchor.parentNode.insertBefore(missionBg, anchor);
      missionBg.addEventListener('pointerdown', function () {
        if (missionOpen) confirmMission();
      });
      return missionBg;
    }
    function closeMission() {
      if (missionCloseTimer !== null) finalizeMissionClose();
      var wasOpen = missionOpen;
      missionOpen = false;
      missionSel = null;
      missionDrag = null;
      // 드래그 중 닫히면 finishMissionDrag가 안 불려 클래스가 남는다 — 여기서도 끈다.
      root.classList.remove('dt-mission-dragging');
      clearMissionSpread();
      if (!wasOpen) { sync(); return; }
      pulseMissionAnim();
      var el = deps.missionEl;
      if (el) {
        el.classList.remove('is-entering');
        el.classList.add('is-leaving');
      }
      if (missionBg) {
        missionBg.classList.remove('is-entering');
        missionBg.classList.add('is-leaving');
      }
      missionClosing = true;
      missionCloseTimer = setTimeout(finalizeMissionClose, MISSION_ANIM_MS);
    }
    function finalizeMissionClose() {
      if (missionCloseTimer !== null) {
        clearTimeout(missionCloseTimer);
        missionCloseTimer = null;
      }
      if (!missionClosing) return;
      missionClosing = false;
      root.classList.remove('dt-mission-mode');
      var el = deps.missionEl;
      if (el) {
        el.hidden = true;
        el.innerHTML = '';
        el.classList.remove('is-entering');
        el.classList.remove('is-leaving');
      }
      if (missionBg) {
        missionBg.hidden = true;
        missionBg.classList.remove('is-entering');
        missionBg.classList.remove('is-leaving');
      }
      missionCardsArr = [];
      missionAddEl = null;
      sync();
    }
    function applyMissionWallpaper(el) {
      try {
        var wp = deps.wallpaperEl || null;
        if (!wp) { el.style.removeProperty('--dt-mission-wp'); return; }
        var bg = '';
        try {
          if (typeof window !== 'undefined' && window.getComputedStyle) {
            bg = window.getComputedStyle(wp).backgroundImage || '';
          }
        } catch (e) { bg = ''; }
        if (!bg || bg === 'none') {
          if (wp.style && wp.style.backgroundImage) bg = wp.style.backgroundImage;
        }
        if (bg && bg !== 'none') {
          el.style.setProperty('--dt-mission-wp', bg);
          return;
        }
        var img = wp.querySelector ? wp.querySelector('img') : null;
        var src = img ? (img.currentSrc || img.src || '') : '';
        if (src) {
          el.style.setProperty('--dt-mission-wp', 'url("' + src + '")');
          return;
        }
        el.style.removeProperty('--dt-mission-wp');
      } catch (e) {
        void e;
      }
    }
    function moveMissionSel(dir) {
      if (!missionOpen) return;
      var idx = state.spaces.indexOf(missionSel);
      if (idx < 0) idx = state.spaces.indexOf(state.activeSpace);
      var next = state.spaces[idx + dir];
      if (next === undefined) return;
      missionSel = next;
      openMission();
    }
    function confirmMission() {
      var target = missionSel;
      closeMission();
      if (target !== null && target !== state.activeSpace) switchSpace(target);
    }
    var MISSION_AREA_X = 56;
    var MISSION_AREA_TOP = 176;
    var MISSION_GAP = 28;
    var MISSION_CAPTION_H = 30;
    function clearMissionSpread() {
      entries.forEach(function (rec) {
        rec.el.style.transform = '';
        rec.el.classList.remove('dt-mission-win');
        rec.el.classList.remove('dt-mission-drag');
      });
      missionLayout.clear();
      var el = deps.missionEl;
      if (el) {
        el.querySelectorAll('.dt-mission-caption').forEach(function (n) { n.remove(); });
        el.querySelectorAll('.dt-mission-empty').forEach(function (n) { n.remove(); });
      }
    }
    function layoutMissionSpread() {
      if (!missionOpen) return;
      var el = deps.missionEl;
      if (!el) return;
      el.querySelectorAll('.dt-mission-caption').forEach(function (n) { n.remove(); });
      el.querySelectorAll('.dt-mission-empty').forEach(function (n) { n.remove(); });
      var wins = state.windows.filter(function (w) {
        return w.space === missionSel && !w.minimized;
      });
      entries.forEach(function (rec, id) {
        var w = findWin(id);
        if (!w || w.space !== missionSel || w.minimized) {
          rec.el.style.transform = '';
          rec.el.classList.remove('dt-mission-win');
        }
      });
      missionLayout.clear();
      if (!wins.length) {
        var empty = document.createElement('p');
        empty.className = 'dt-mission-empty';
        empty.textContent = '이 데스크톱에는 열린 창이 없어요';
        el.appendChild(empty);
        return;
      }
      var vp = getViewport();
      var topOff = rootTopOffset();
      var areaW = Math.max(120, vp.w - MISSION_AREA_X * 2);
      var areaH = Math.max(120, vp.h - topOff - DOCK_ZONE - 16 - MISSION_AREA_TOP);
      var rows = wins.length <= 3 ? 1 : 2;
      var cols = Math.ceil(wins.length / rows);
      var cellW = areaW / cols;
      var cellH = areaH / rows;
      wins.forEach(function (w, i) {
        var rec = entries.get(w.id);
        if (!rec) return;
        var col = i % cols;
        var row = Math.floor(i / cols);
        var availW = Math.max(40, cellW - MISSION_GAP);
        var availH = Math.max(40, cellH - MISSION_GAP - MISSION_CAPTION_H);
        var baseX = w.x, baseY = w.y, baseW = w.w, baseH = w.h;
        if (rec.el.offsetWidth > 0 && rec.el.offsetHeight > 0) {
          baseX = rec.el.offsetLeft;
          baseY = rec.el.offsetTop;
          baseW = rec.el.offsetWidth;
          baseH = rec.el.offsetHeight;
        }
        var s = Math.min(1, availW / baseW, availH / baseH);
        var tw = baseW * s;
        var th = baseH * s;
        var tx = MISSION_AREA_X + col * cellW + (cellW - tw) / 2;
        var ty = MISSION_AREA_TOP + row * cellH + (cellH - MISSION_CAPTION_H - th) / 2;
        var dx = tx - baseX;
        var dy = ty - baseY;
        rec.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')';
        rec.el.classList.add('dt-mission-win');
        missionLayout.set(w.id, { dx: dx, dy: dy, scale: s, target: { x: tx, y: ty, w: tw, h: th } });
        var mod = findModule(w.module) || { title: w.module };
        var cap = document.createElement('div');
        cap.className = 'dt-mission-caption';
        cap.textContent = mod.title;
        cap.style.left = tx + 'px';
        cap.style.top = (topOff + ty + th + 8) + 'px';
        cap.style.width = tw + 'px';
        el.appendChild(cap);
      });
    }
    // 미션 드래그의 hit 판정은 드래그 시작 시 캐시한 rect로만 한다
    // (onMissionMove에서 레이아웃을 읽지 않는다 — 위 missionDrag 생성처 참조).
    function pointInCachedRect(x, y, r) {
      return !!r && r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    function missionCardAtCached(d) {
      var found = null;
      var rects = d.cardRects || [];
      for (var i = 0; i < rects.length; i++) {
        var c = rects[i];
        if (pointInCachedRect(d.lastX, d.lastY, c)) found = c.spaceId;
      }
      return found;
    }
    function isOverMissionAddCached(d) {
      return pointInCachedRect(d.lastX, d.lastY, d.addRect);
    }
    // 미션 드래그도 창 이동과 같은 이유로 rAF로 합친다: move 이벤트마다
    // transform 쓰기 + hot 클래스 토글이 돌면 한 프레임에 여러 번
    // 스타일 재계산이 일어나고, 그려지는 건 마지막 한 번뿐이다.
    function applyMissionFrame() {
      var d = missionDrag;
      if (!d) return;
      d.rafId = null;
      var rec = entries.get(d.id);
      var base = missionLayout.get(d.id);
      if (rec && base) {
        rec.el.classList.add('dt-mission-drag');
        rec.el.style.transform = 'translate(' + (base.dx + d.mdx) + 'px,' + (base.dy + d.mdy) + 'px) scale(' + base.scale + ')';
      }
      // 미션 드래그 중에는 배경 블러를 끈다 (2026-11-12 성능 점검:
      // .dt-mission-bg 전폭 블러 14px이 미션 드래그 프레임을 지배한다.
      // 주의: 1라운드 당시 CSS 선택자가 자손 선택자라 형제인 배경에
      // 매칭되지 않아 실제로는 꺼지지 않았다 — 2026-11-13 3라운드에서
      // 형제 선택자(#dt-root.dt-mission-dragging ~ .dt-mission-bg)로
      // 고친 뒤에야 느린 프레임 80건→3건으로 줄었다. 드래그 중에만
      // 끄고 끝나면 복원하므로 정적 외관은 원본과 동일하다. 사용자가
      // "버벅임은 없는지, 빠릿빠릿한 게 생명"이라고 직접 제기해 적용).
      if (d.moved) root.classList.add('dt-mission-dragging');
      var over = missionCardAtCached(d);
      if (over !== d.hotSpace) {
        d.hotSpace = over;
        missionCardsArr.forEach(function (c) {
          c.el.classList.toggle('is-drop-hot', c.spaceId === over);
        });
      }
      var overAdd = isOverMissionAddCached(d);
      if (overAdd !== d.hotAdd) {
        d.hotAdd = overAdd;
        if (missionAddEl) missionAddEl.classList.toggle('is-drop-hot', overAdd);
      }
    }
    function onMissionMove(e) {
      var d = missionDrag;
      if (!d) return;
      if (d.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== d.pointerId) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      d.mdx = e.clientX - d.startX;
      d.mdy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(d.mdx, d.mdy) < 6) return;
      d.moved = true;
      if (d.rafId === null || d.rafId === undefined) {
        d.rafId = raf(applyMissionFrame);
      }
    }
    function finishMissionDrag(e) {
      var d = missionDrag;
      if (!d) return;
      if (e && d.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== d.pointerId) return;
      if (d.rafId !== null && d.rafId !== undefined) {
        cancelRaf(d.rafId);
        d.rafId = null;
        // 대기 중이던 마지막 move 프레임을 동기 반영해 드롭 판정
        // (hotSpace/hotAdd)이 pointerup 직전 최신 좌표를 쓰게 한다.
        applyMissionFrame();
      }
      missionDrag = null;
      var rec = entries.get(d.id);
      if (rec) rec.el.classList.remove('dt-mission-drag');
      // 블러 복원은 스프레드 정착(0.28s 트랜지션) 뒤로 미룬다: 드롭 직후
      // 창들이 새 자리로 미끄러지는 동안 블러가 켜져 있으면 매 프레임
      // 전폭 블러를 다시 샘플링해 드롭 구간이 버벅인다 (하네스 실측:
      // 드롭 p95 83ms·느린 프레임 7건). 280ms 뒤에 끄고, 그 사이 새
      // 드래그가 시작됐으면 건드리지 않는다 (새 드래그의 finish가 처리).
      if (missionBlurTimer !== null) clearTimeout(missionBlurTimer);
      missionBlurTimer = setTimeout(function () {
        missionBlurTimer = null;
        if (!missionDrag) root.classList.remove('dt-mission-dragging');
      }, MISSION_ANIM_MS);
      missionCardsArr.forEach(function (c) { c.el.classList.remove('is-drop-hot'); });
      if (missionAddEl) missionAddEl.classList.remove('is-drop-hot');
      var w = findWin(d.id);
      if (!w) return;
      if (!d.moved) {
        var targetSpace = w.space;
        var targetId = w.id;
        closeMission();
        if (targetSpace !== state.activeSpace) switchSpace(targetSpace);
        commit(stateApi.focusWindow(state, targetId));
        return;
      }
      if (d.hotAdd) {
        lastMissionDrop = Date.now();
        var prevActive = state.activeSpace;
        var beforeIds = state.spaces.slice();
        commit(stateApi.addSpace(state));
        var newId = state.spaces.filter(function (s) { return beforeIds.indexOf(s) < 0; })[0];
        if (newId !== undefined) {
          commit(stateApi.moveWindowToSpace(state, w.id, newId));
          if (state.activeSpace !== prevActive && state.spaces.indexOf(prevActive) >= 0) {
            commit(stateApi.setActiveSpace(state, prevActive));
          }
        }
        openMission();
        return;
      }
      if (d.hotSpace !== null && d.hotSpace !== w.space) {
        lastMissionDrop = Date.now();
        commit(stateApi.moveWindowToSpace(state, w.id, d.hotSpace));
        refreshMissionCards();
        return;
      }
      var base = missionLayout.get(d.id);
      if (rec && base) {
        rec.el.style.transform = 'translate(' + base.dx + 'px,' + base.dy + 'px) scale(' + base.scale + ')';
      }
    }

    function wireMissionEmptyClick() {
      if (missionWired) return;
      var el = deps.missionEl;
      if (!el) return;
      missionWired = true;
      el.addEventListener('pointerdown', function (e) {
        if (!missionOpen) return;
        var t = e.target;
        var onEmpty = t === el || (t.classList && t.classList.contains('dt-mission-spaces'));
        if (onEmpty) confirmMission();
      });
    }

    // 카드 썸네일 안의 창 위치(winrect)를 채운다 — openMission과
    // refreshMissionCards가 같은 기하를 쓴다 (한 곳만 고치면 양쪽이 바뀐다).
    function appendMissionWinrects(stage, spaceId, vp) {
      state.windows.forEach(function (w) {
        if (w.space !== spaceId || w.minimized) return;
        var rect = document.createElement('div');
        rect.className = 'dt-mission-winrect';
        if (isMobile()) {
          rect.style.left = '0%';
          rect.style.top = '0%';
          rect.style.width = '100%';
          rect.style.height = '100%';
        } else {
          rect.style.left = (w.x / vp.w) * 100 + '%';
          rect.style.top = (w.y / vp.h) * 100 + '%';
          rect.style.width = (w.w / vp.w) * 100 + '%';
          rect.style.height = (w.h / vp.h) * 100 + '%';
        }
        stage.appendChild(rect);
      });
    }
    // 드롭 후 미션 전체를 다시 만들지 않고 카드 썸네일의 winrect만 갱신한다.
    // openMission()은 카드·이름·닫기 버튼·+ 버튼을 전부 재생성하고 진입
    // 애니메이션·아이콘 새로고침·sync까지 다시 돌려 드롭 정착이 끊겼다.
    // 스페이스 수가 그대로인 드롭(다른 데스크톱으로 이동)에서는 카드 DOM을
    // 유지한 채 winrect만 바꾸고, 스프레드는 직전 commit의 sync가 이미
    // layoutMissionSpread로 갱신했다. + 버튼으로 스페이스가 늘어나는
    // 드롭은 카드 자체가 늘어나 openMission()을 그대로 쓴다.
    function refreshMissionCards() {
      var el = deps.missionEl;
      if (!el || !missionOpen) return;
      var vp = getViewport();
      missionCardsArr.forEach(function (c) {
        var stage = c.el.querySelector('.dt-mission-stage');
        if (!stage) return;
        stage.querySelectorAll('.dt-mission-winrect').forEach(function (n) { n.remove(); });
        appendMissionWinrects(stage, c.spaceId, vp);
      });
    }

    function openMission() {
      var el = deps.missionEl;
      if (!el) return;
      if (spaceSlide) finalizeSpaceSlide();
      if (missionCloseTimer !== null) {
        clearTimeout(missionCloseTimer);
        missionCloseTimer = null;
      }
      missionClosing = false;
      el.classList.remove('is-leaving');
      if (missionBg) missionBg.classList.remove('is-leaving');
      if (!missionOpen || missionSel === null) missionSel = state.activeSpace;
      if (state.spaces.indexOf(missionSel) < 0) missionSel = state.activeSpace;
      missionOpen = true;
      pulseMissionAnim();
      var bg = ensureMissionBg();
      if (bg) applyMissionWallpaper(bg);
      el.innerHTML = '';
      var vp = getViewport();
      var viewSpace = missionSel;
      var strip = document.createElement('div');
      strip.className = 'dt-mission-spaces';
      missionCardsArr = [];
      var missionCards = missionCardsArr;
      state.spaces.forEach(function (spaceId, i) {
        var card = document.createElement('div');
        card.className = 'dt-mission-card' + (spaceId === state.activeSpace ? ' is-active' : '') + (spaceId === viewSpace ? ' is-selected' : '');
        card.dataset.spaceId = String(spaceId);
        missionCards.push({ spaceId: spaceId, el: card });
        var stage = document.createElement('div');
        stage.className = 'dt-mission-stage';
        appendMissionWinrects(stage, spaceId, vp);
        var name = document.createElement('div');
        name.className = 'dt-mission-name';
        name.textContent = '데스크톱 ' + (i + 1);
        card.appendChild(stage);
        card.appendChild(name);
        if (state.spaces.length > 1) {
          var closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.className = 'dt-mission-close';
          closeBtn.setAttribute('aria-label', '데스크톱 ' + (i + 1) + ' 닫기');
          closeBtn.innerHTML = '<i data-lucide="x"></i>';
          closeBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            commit(stateApi.removeSpace(state, spaceId));
            if (missionSel === spaceId) missionSel = state.activeSpace;
            openMission();
          });
          card.appendChild(closeBtn);
        }
        card.addEventListener('click', function () {
          if (Date.now() - lastMissionDrop < 350) return;
          missionSel = spaceId;
          confirmMission();
        });
        strip.appendChild(card);
      });
      var addCard = document.createElement('button');
      addCard.type = 'button';
      addCard.className = 'dt-mission-add';
      addCard.setAttribute('aria-label', '데스크톱 추가');
      addCard.innerHTML = '<i data-lucide="plus"></i>';
      addCard.addEventListener('click', function () {
        addSpace();
        openMission();
      });
      strip.appendChild(addCard);
      el.appendChild(strip);
      missionAddEl = addCard;
      wireMissionEmptyClick();
      refreshIcons();
      el.hidden = false;
      if (bg) bg.hidden = false;
      root.classList.add('dt-mission-mode');
      void root.offsetWidth;
      el.classList.remove('is-entering');
      if (bg) bg.classList.remove('is-entering');
      el.classList.add('is-entering');
      if (bg) bg.classList.add('is-entering');
      sync();
    }

    function onResize() {
      var vp = getViewport();
      root.classList.toggle('dt-mobile', vp.w < MOBILE_MAX);
      var next = state;
      state.windows.map(function (w) { return w.id; }).forEach(function (id) {
        var cur = null;
        for (var i = 0; i < next.windows.length; i++) if (next.windows[i].id === id) cur = next.windows[i];
        if (!cur) return;
        var kind = modeKind(id);
        if (kind === 'full') {
          next = stateApi.resizeWindow(next, id, fullRect(vp), vp);
          return;
        }
        if (kind === 'zoom') {
          next = stateApi.resizeWindow(next, id, zoomRect(vp), vp);
          return;
        }
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
      if (missionOpen) closeMission();
      noteRecent(id);
      var before = findWin(id);
      if (before && before.space !== state.activeSpace) {
        commit(stateApi.setActiveSpace(state, before.space));
      }
      var isNew = !before;
      commit(stateApi.openModule(state, id, getViewport()));
      // 기본 전체화면 모듈(브라우저)은 새로 열 때 바로 최대화한다
      // (2026-11-12 사용자 지적: 브라우저가 작게 열려 원격 화면이 짤림).
      // 이미 열려 있는 창을 다시 여는 경우(복원)는 건드리지 않는다.
      if (isNew) {
        var mod = findModule(id);
        if (mod && mod.defMode === 'full') {
          var vp = getViewport();
          var cur = findWin(id);
          if (cur) {
            commit(stateApi.resizeWindow(
              stateApi.setWindowMode(state, id, 'full', { x: cur.x, y: cur.y, w: cur.w, h: cur.h }),
              id, fullRect(vp), vp));
          }
        }
      }
    }

    /**
     * 저장된 창 목록에서 아직 열리지 않은 창을 저장된 rect 그대로 복원한다.
     * 성능 5라운드(2026-11-13): 부팅 init 비차단화의 늦은 복원 경로 —
     * main.js가 /api/artifact 응답 뒤에 스튜디오 모듈을 등록하고, init 시
     * 버려진 스튜디오 창을 이 메서드로 되살린다. 복원할 창이 없으면
     * restoreWindows가 같은 state를 반환해 commit이 no-op이 된다.
     */
    function restoreWindows(windows, savedActiveId) {
      if (typeof stateApi.restoreWindows !== 'function') return;
      commit(stateApi.restoreWindows(state, windows, getViewport(), savedActiveId));
    }

    function postToModule(id, message) {
      var rec = entries.get(id);
      var frame = rec && rec.frame;
      if (!frame || !frame.contentWindow) return false;
      try {
        frame.contentWindow.postMessage(message, window.location.origin);
        return true;
      } catch (e) {
        return false;
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (menuBar) {
        menuBar.destroy();
        menuBar = null;
      }
      if (drag && drag.el) drag.el.classList.remove('dt-win-dragging');
      drag = null;
      window.removeEventListener('message', onDocTitleMessage);
      window.removeEventListener('message', onBrowserTabsMessage);
      window.removeEventListener('message', onAssistantDeclareMessage);
      window.removeEventListener('message', onNavKeyMessage);
      window.removeEventListener('message', onOfficeTabsMessage);
      window.removeEventListener('message', onOfficeMenuItemsMessage);
      closeOfficeMenu();
      officeTabsByWin.clear();
      window.removeEventListener('message', onFinderMessage);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('keydown', onKeydown);
      closeMission();
      finalizeMissionClose();
      clearMissionAnim();
      if (hotZone) {
        hotZone.remove();
        hotZone = null;
      }
      if (peekTimer) {
        clearTimeout(peekTimer);
        peekTimer = null;
      }
      entries.forEach(function (rec) { rec.el.remove(); });
      entries.clear();
      if (dock) {
        dock.destroy();
        dock = null;
      }
    }

    var navApi = deps.navApi || (typeof window !== 'undefined' ? window.MyHubNav : null);
    if (navApi && typeof navApi.addSettingsItemsProvider === 'function') {
      navApi.addSettingsItemsProvider(spaceSettingsItems);
    }

    ensureHotZone();
    state = snapSeamWindows(state);
    sync();

    return {
      openModule: openModule,
      restoreWindows: restoreWindows,
      postToModule: postToModule,
      getActiveAssistant: getActiveAssistant,
      onAssistantChange: function (fn) {
        if (typeof fn !== 'function') return function () {};
        assistantListeners.add(fn);
        return function () { assistantListeners.delete(fn); };
      },
      setDocTitle: setDocTitle,
      toggleMaximize: toggleMaximize,
      toggleZoom: toggleZoom,
      isMaximized: function (id) { return modeKind(id) === 'full'; },
      addToDock: addToDock,
      removeFromDock: removeFromDock,
      getDockIds: function () { return ensureDockIds().slice(); },
      switchSpace: switchSpace,
      settleSpaceSlide: finalizeSpaceSlide,
      addSpace: addSpace,
      removeSpace: removeSpace,
      toggleMission: toggleMission,
      isMissionOpen: function () { return missionOpen; },
      addToTrash: addToTrash,
      getTrashItems: function () { return loadTrash().slice(); },
      setTrashRestorer: function (fn) { trashRestorer = typeof fn === 'function' ? fn : null; },
      openFinderTrash: openFinderTrash,
      emptyTrash: emptyTrash,
      getRecents: function () { return loadRecents().slice(); },
      moveWindowToSpace: function (id, spaceId) { commit(stateApi.moveWindowToSpace(state, id, spaceId)); },
      getState: function () { return state; },
      destroy: destroy,
    };
  }

  var api = { createManager: createManager };
  if (typeof window !== 'undefined') window.MyHubDesktopWindows = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopWindows = api;
})();
