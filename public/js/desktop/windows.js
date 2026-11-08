/* MyHub 데스크톱 창 관리자 — 통합 창 크롬·Spaces·미션 컨트롤·프록시.
 *
 * 재구성 근거 (기록 계약의 합집합):
 * - 통합 바 단일 높이 40px (2026-11-06 14:57 정본: 52/40 2단계 폐지),
 *   신호등 14px·간격 9px·오프셋 17px, 창 반경 16px, 그라데이션·상시 헤어라인 폐지.
 * - 제목은 문서·콘텐츠 이름 — 앱이 'myhub:doc-title' 채널로 게시한다.
 * - 줌(제목줄 더블클릭·독 윗변에 밀착, taskbar rect 실측)과 전체화면 분리,
 *   modes 맵 {mode, prev}. rootTopOffset() 실측 보정.
 * - 줌 해제는 실제 드래그 임계(4px) 이동 시점으로 이연 (더블클릭 복원 결함 수정).
 * - 미션 컨트롤: JN 클릭 토글, Ctrl+←/→는 즉시 전환이 아니라 선택 모드 진입,
 *   Enter·빈 공간 클릭 확정, ESC 취소, 카드 클릭 즉시 확정, 타일 클릭 시
 *   그 창의 데스크톱으로 이동+포커스, 타일을 카드로 드래그해 창 이동(최대화 포함,
 *   드롭 후 패널 유지, 350ms 클릭 가드). 스프레드·winrect는 렌더 기하 기준
 *   (offset*), jsdom에서만 저장 기하 폴백, 모바일 winrect는 스테이지 전체.
 * - 칩 바: 전환 직후 1.4초·창 드래그 중·상단 핫 스트립 hover·.g-nav hover에서만.
 * - 앱 액션 프록시: 활성 창 iframe의 '.g-nav button' 전수 수확 (시스템 설정·
 *   비서 아바타만 제외), 검색 랩은 값+input 이벤트 전달. 비서 아바타는 우측
 *   슬롯(#dt-bar-assistant)에 프록시, 클릭은 실버튼으로 전달.
 * - 독 휴지통: 클릭 → openFinderTrash 핸드셰이크.
 * - iframe keep-alive: 데스크톱 전환 시 창을 숨길 뿐 파괴하지 않는다.
 *
 * 노출: window.MyHubDesktopWindows + module.exports
 */
(function () {
  'use strict';

  function createManager(deps) {
    var root = deps.root;
    var doc = root.ownerDocument;
    var win = doc.defaultView || window;
    var stateApi = deps.stateApi;
    var storage = deps.storage;
    var getViewport = deps.getViewport;
    var state = deps.state;
    var modes = {}; // id → {mode:'zoom'|'full', prev:{x,y,w,h}}
    var nodes = {}; // id → window element
    var frames = {}; // id → iframe element
    var winTitles = {}; // id → doc-title로 게시된 제목
    var mission = null; // {sel, origin, guardUntil}
    var chipsTimer = null;
    var pendingFinderView = null;
    var pendingOpenFile = null;
    var pendingAppFiles = {}; // frameId → file (오피스 open-in-app 핸드셰이크)

    function moduleOf(id) { return stateApi.findModule(id); }
    function titleOf(id) {
      if (winTitles[id]) return winTitles[id];
      var m = moduleOf(id);
      return m ? m.title : id;
    }
    function persist() { stateApi.save(storage, state); }
    function rootTopOffset() {
      var r = root.getBoundingClientRect();
      return r ? r.top : 0;
    }
    function isMobile() { return getViewport().w <= 767; }
    function viewportOfRoot() {
      return { w: root.clientWidth || getViewport().w, h: root.clientHeight || getViewport().h };
    }

    /* ---------- 창 요소 ---------- */

    function buildWindow(w) {
      var mod = moduleOf(w.module);
      var el = doc.createElement('section');
      el.className = 'dt-window';
      el.dataset.id = w.id;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', titleOf(w.id));

      var bar = doc.createElement('header');
      bar.className = 'dt-win-bar';
      var lights = doc.createElement('div');
      lights.className = 'dt-lights';
      [['close', '닫기'], ['min', '최소화'], ['zoom', '줌']].forEach(function (pair) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'dt-light dt-light-' + pair[0];
        b.dataset.act = pair[0];
        b.setAttribute('aria-label', pair[1]);
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (pair[0] === 'close') closeWindow(w.id);
          else if (pair[0] === 'min') minimizeWindow(w.id);
          else toggleZoom(w.id);
        });
        lights.appendChild(b);
      });
      bar.appendChild(lights);
      var chev = doc.createElement('span');
      chev.className = 'dt-win-chevron';
      chev.dataset.slot = 'chevron';
      bar.appendChild(chev);
      var toolsLeft = doc.createElement('div');
      toolsLeft.className = 'dt-win-tools dt-win-tools-left';
      toolsLeft.dataset.slot = 'tools-left';
      bar.appendChild(toolsLeft);
      var title = doc.createElement('div');
      title.className = 'dt-win-title';
      title.textContent = titleOf(w.id);
      bar.appendChild(title);
      var tools = doc.createElement('div');
      tools.className = 'dt-win-tools';
      tools.dataset.slot = 'tools';
      bar.appendChild(tools);
      el.appendChild(bar);

      var frame = doc.createElement('iframe');
      frame.className = 'dt-frame';
      frame.title = titleOf(w.id);
      frame.src = mod ? mod.url : 'about:blank';
      frame.addEventListener('load', function () {
        try {
          if (frame.contentDocument) {
            frame.contentDocument.documentElement.classList.add('myhub-embedded');
          }
        } catch (e) { console.debug('임베드 표시 실패:', e); }
        if (state.activeId === w.id) syncProxies();
        if (w.module === 'finder') flushFinderPending();
      });
      el.appendChild(frame);
      var handle = doc.createElement('div');
      handle.className = 'dt-win-resize';
      el.appendChild(handle);

      el.addEventListener('pointerdown', function () { focusWindow(w.id); }, true);
      attachBarDrag(el, bar, w.id);
      attachResize(el, handle, w.id);
      nodes[w.id] = el;
      frames[w.id] = frame;
      return el;
    }

    function zoomRect() {
      var vp = viewportOfRoot();
      var bottom = vp.h;
      if (deps.taskbar && deps.taskbar.getBoundingClientRect) {
        var tr = deps.taskbar.getBoundingClientRect();
        if (tr && tr.height > 0) {
          var topInRoot = tr.top - rootTopOffset();
          // 독이 자동 숨김(화면 아래로 이동)인 상태에서는 그 위치를 기준으로 삼으면
          // 창이 하단 핫존까지 덮어 독을 다시 꺼낼 수 없게 된다 — 독 높이만큼만 비운다.
          bottom = topInRoot < vp.h
            ? Math.max(0, topInRoot)
            : Math.max(0, vp.h - tr.height - 8);
        }
      }
      return { x: 0, y: 0, w: vp.w, h: bottom };
    }

    function applyRect(el, w) {
      var mode = modes[w.id];
      var vp = viewportOfRoot();
      if (mode && mode.mode === 'full') {
        el.style.left = '0px'; el.style.top = '0px';
        el.style.width = vp.w + 'px'; el.style.height = vp.h + 'px';
      } else if (mode && mode.mode === 'zoom') {
        var z = zoomRect();
        el.style.left = z.x + 'px'; el.style.top = z.y + 'px';
        el.style.width = z.w + 'px'; el.style.height = z.h + 'px';
      } else {
        el.style.left = w.x + 'px'; el.style.top = w.y + 'px';
        el.style.width = w.w + 'px'; el.style.height = w.h + 'px';
      }
      el.style.zIndex = String(10 + w.z);
    }

    function sync() {
      var seen = {};
      state.windows.forEach(function (w) {
        seen[w.id] = true;
        var el = nodes[w.id];
        if (!el) { el = buildWindow(w); root.appendChild(el); el.classList.add('dt-win-in'); }
        var visible = w.space === state.activeSpaceId && !w.minimized;
        el.style.display = visible ? '' : 'none';
        el.classList.toggle('is-active', state.activeId === w.id && visible);
        applyRect(el, w);
        var titleEl = el.querySelector('.dt-win-title');
        if (titleEl) titleEl.textContent = titleOf(w.id);
      });
      Object.keys(nodes).forEach(function (id) {
        if (!seen[id]) {
          nodes[id].remove();
          delete nodes[id]; delete frames[id]; delete modes[id]; delete winTitles[id];
        }
      });
      syncDock();
      syncFullscreenClass();
      syncTopbarMode();
      syncProxies();
    }

    /* 상단바 모드: 활성 앱이 있으면 검은 앱 바 + 앱 이름, 없으면 데스크톱. */
    function syncTopbarMode() {
      var active = null;
      state.windows.forEach(function (w) {
        if (w.id === state.activeId && w.space === state.activeSpaceId && !w.minimized) active = w;
      });
      doc.body.classList.toggle('dt-app-active', !!active);
      if (deps.appTitleEl) {
        var mod = active ? moduleOf(active.module) : null;
        deps.appTitleEl.textContent = mod ? mod.title : '데스크톱';
      }
    }

    function syncFullscreenClass() {
      var anyFull = state.windows.some(function (w) {
        return w.space === state.activeSpaceId && modes[w.id] && modes[w.id].mode === 'full';
      });
      doc.body.classList.toggle('dt-fullscreen', anyFull);
      if (deps.taskbar) {
        var anyMax = state.windows.some(function (w) {
          return w.space === state.activeSpaceId && !w.minimized && modes[w.id];
        });
        var anyOpenMobile = isMobile() && state.windows.some(function (w) {
          return w.space === state.activeSpaceId && !w.minimized;
        });
        deps.taskbar.classList.toggle('dt-autohide', !!(anyMax || anyOpenMobile));
      }
    }

    /* ---------- 상태 전이 ---------- */

    function setState(next) { state = next; persist(); sync(); }

    function openModule(id) {
      setState(stateApi.openModule(state, id, viewportOfRoot()));
      var w = state.windows.filter(function (x) { return x.id === id; })[0] || null;
      if (w && deps.dockApi && deps.getDockIds && deps.getDockIds().indexOf(id) < 0) {
        var recents = deps.dockApi.loadRecents(storage);
        recents = [id].concat(recents.filter(function (x) { return x !== id; })).slice(0, 3);
        deps.dockApi.saveRecents(storage, recents);
      }
      return w;
    }

    function focusWindow(id) {
      if (state.activeId === id) { syncProxies(); return; }
      setState(stateApi.focusWindow(state, id));
    }
    function minimizeWindow(id) { setState(stateApi.minimizeWindow(state, id)); }
    function closeWindow(id) { setState(stateApi.closeWindow(state, id)); }

    function toggleZoom(id) {
      var w = state.windows.filter(function (x) { return x.id === id; })[0];
      if (!w) return;
      if (modes[id]) delete modes[id];
      else modes[id] = { mode: 'zoom', prev: { x: w.x, y: w.y, w: w.w, h: w.h } };
      sync();
    }

    function toggleFullscreen(id) {
      var w = state.windows.filter(function (x) { return x.id === id; })[0];
      if (!w) return;
      if (modes[id] && modes[id].mode === 'full') delete modes[id];
      else modes[id] = { mode: 'full', prev: modes[id] ? modes[id].prev : { x: w.x, y: w.y, w: w.w, h: w.h } };
      sync();
    }

    /* ---------- 바 드래그·리사이즈 ---------- */

    function attachBarDrag(el, bar, id) {
      bar.addEventListener('dblclick', function (ev) {
        if (ev.target.closest('.dt-lights') || ev.target.closest('button')) return;
        toggleZoom(id);
      });
      bar.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0 || ev.target.closest('button')) return;
        var w = state.windows.filter(function (x) { return x.id === id; })[0];
        if (!w) return;
        var startX = ev.clientX, startY = ev.clientY;
        var orig = { x: w.x, y: w.y };
        var moved = false;
        function onMove(e2) {
          var dx = e2.clientX - startX, dy = e2.clientY - startY;
          if (!moved && Math.hypot(dx, dy) < 4) return; // 임계 전에는 줌을 유지한다
          if (!moved && modes[id]) {
            // 실제 드래그가 시작되는 이 시점에 줌 해제 (더블클릭 복원 결함 수정)
            var prev = modes[id].prev;
            delete modes[id];
            orig = { x: prev.x, y: prev.y };
            setState(stateApi.moveWindow(state, id, orig.x, orig.y, viewportOfRoot()));
          }
          moved = true;
          el.style.left = (orig.x + dx) + 'px';
          el.style.top = (orig.y + dy) + 'px';
          showChips();
        }
        function onUp(e2) {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          if (!moved) return;
          setState(stateApi.moveWindow(state, id, orig.x + (e2.clientX - startX), orig.y + (e2.clientY - startY), viewportOfRoot()));
          hideChipsSoon();
        }
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
      });
    }

    function attachResize(el, handle, id) {
      handle.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        var w = state.windows.filter(function (x) { return x.id === id; })[0];
        if (!w) return;
        if (modes[id]) delete modes[id]; // 손으로 늘이면 줌 해제
        var startX = ev.clientX, startY = ev.clientY;
        var orig = { x: w.x, y: w.y, w: w.w, h: w.h };
        function onMove(e2) {
          el.style.width = Math.max(stateApi.MIN_W, orig.w + (e2.clientX - startX)) + 'px';
          el.style.height = Math.max(stateApi.MIN_H, orig.h + (e2.clientY - startY)) + 'px';
        }
        function onUp(e2) {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          setState(stateApi.resizeWindow(state, id, {
            x: orig.x, y: orig.y,
            w: orig.w + (e2.clientX - startX), h: orig.h + (e2.clientY - startY),
          }, viewportOfRoot()));
        }
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
      });
    }

    /* ---------- Spaces·미션 컨트롤 ---------- */

    function setActiveSpace(spaceId) {
      setState(stateApi.setActiveSpace(state, spaceId));
      flashChips();
    }
    function addSpace() { setState(stateApi.addSpace(state)); flashChips(); }
    function removeSpace(spaceId) { setState(stateApi.removeSpace(state, spaceId)); }

    function enterMission(preselectId) {
      mission = { sel: preselectId || state.activeSpaceId, origin: state.activeSpaceId, guardUntil: 0 };
      renderMission();
      if (deps.missionEl) deps.missionEl.classList.add('is-open');
    }
    function exitMission() {
      mission = null;
      if (deps.missionEl) deps.missionEl.classList.remove('is-open');
    }
    function confirmMission() {
      if (!mission) return;
      var target = mission.sel;
      exitMission();
      if (target !== state.activeSpaceId) setActiveSpace(target);
    }
    function cancelMission() { exitMission(); }
    function toggleMission() {
      if (mission) confirmMission();
      else enterMission(state.activeSpaceId);
    }

    function renderRectOf(w, vp) {
      var el = nodes[w.id];
      if (isMobile()) return { x: 0, y: 0, w: vp.w, h: vp.h };
      if (el && el.offsetWidth > 0) {
        return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      }
      return { x: w.x, y: w.y, w: w.w, h: w.h }; // 저장 기하 폴백 (jsdom 등)
    }

    function renderMission() {
      var host = deps.missionEl;
      if (!host || !mission) return;
      host.innerHTML = '';
      var strip = doc.createElement('div');
      strip.className = 'dt-mission-strip';
      var vp = viewportOfRoot();
      state.spaces.forEach(function (space) {
        var card = doc.createElement('div');
        card.className = 'dt-mission-card' + (mission.sel === space.id ? ' is-selected' : '');
        card.dataset.space = space.id;
        var name = doc.createElement('div');
        name.className = 'dt-mission-name';
        name.textContent = space.name;
        card.appendChild(name);
        var stage = doc.createElement('div');
        stage.className = 'dt-mission-stage';
        state.windows.filter(function (w) { return w.space === space.id && !w.minimized; })
          .forEach(function (w) {
            var rect = renderRectOf(w, vp);
            var tile = doc.createElement('button');
            tile.type = 'button';
            tile.className = 'dt-mission-win';
            tile.dataset.id = w.id;
            tile.style.left = (rect.x / vp.w * 100) + '%';
            tile.style.top = (rect.y / vp.h * 100) + '%';
            tile.style.width = (rect.w / vp.w * 100) + '%';
            tile.style.height = (rect.h / vp.h * 100) + '%';
            tile.textContent = titleOf(w.id);
            tile.addEventListener('click', function () {
              if (!mission || Date.now() < mission.guardUntil) return;
              exitMission();
              setState(stateApi.focusWindow(state, w.id));
            });
            attachTileDrag(tile, w);
            stage.appendChild(tile);
          });
        card.appendChild(stage);
        card.addEventListener('click', function (ev) {
          if (ev.target !== card && ev.target !== stage && ev.target !== name) return;
          if (!mission || Date.now() < mission.guardUntil) return;
          mission.sel = space.id;
          confirmMission();
        });
        strip.appendChild(card);
      });
      host.appendChild(strip);
    }

    function attachTileDrag(tile, w) {
      tile.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        var downX = ev.clientX, downY = ev.clientY;
        function onMove(e2) {
          var over = doc.elementFromPoint(e2.clientX, e2.clientY);
          var card = over && over.closest ? over.closest('.dt-mission-card') : null;
          if (card && mission) {
            mission.sel = card.dataset.space;
            renderMissionSelection();
          }
        }
        function onUp(e2) {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          if (!mission) return;
          if (Math.hypot(e2.clientX - downX, e2.clientY - downY) < 6) return; // 클릭은 별도 처리
          var over = doc.elementFromPoint(e2.clientX, e2.clientY);
          var card = over && over.closest ? over.closest('.dt-mission-card') : null;
          var target = card ? card.dataset.space : mission.sel;
          if (target && target !== w.space) {
            setState(stateApi.moveWindowToSpace(state, w.id, target));
            mission.sel = target;
            mission.guardUntil = Date.now() + 350; // 드롭 직후 카드 클릭 오인 방지
            renderMission();
          }
        }
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
      });
    }

    function renderMissionSelection() {
      if (!deps.missionEl || !mission) return;
      deps.missionEl.querySelectorAll('.dt-mission-card').forEach(function (card) {
        card.classList.toggle('is-selected', card.dataset.space === mission.sel);
      });
    }

    function onMissionKey(ev) {
      if (!mission) return false;
      if (ev.key === 'Enter') { confirmMission(); return true; }
      if (ev.key === 'Escape') { cancelMission(); return true; }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        var idx = state.spaces.findIndex(function (s) { return s.id === mission.sel; });
        var next = ev.key === 'ArrowLeft' ? idx - 1 : idx + 1;
        if (next >= 0 && next < state.spaces.length) {
          mission.sel = state.spaces[next].id;
          renderMission();
        }
        return true;
      }
      return false;
    }

    /* ---------- 칩 바 ---------- */

    function showChips() {
      if (!deps.chipsEl) return;
      renderChips();
      deps.chipsEl.classList.add('is-visible');
    }
    function hideChipsSoon() {
      if (!deps.chipsEl) return;
      if (chipsTimer) clearTimeout(chipsTimer);
      chipsTimer = setTimeout(function () {
        if (deps.chipsEl) deps.chipsEl.classList.remove('is-visible');
      }, 1400);
    }
    function flashChips() { showChips(); hideChipsSoon(); }

    function renderChips() {
      var host = deps.chipsEl;
      if (!host) return;
      host.innerHTML = '';
      state.spaces.forEach(function (space) {
        var chip = doc.createElement('button');
        chip.type = 'button';
        chip.className = 'dt-chip' + (space.id === state.activeSpaceId ? ' is-active' : '');
        chip.textContent = space.name;
        chip.addEventListener('click', function () { setActiveSpace(space.id); });
        host.appendChild(chip);
      });
      var add = doc.createElement('button');
      add.type = 'button';
      add.className = 'dt-chip dt-chip-add';
      add.textContent = '+';
      add.setAttribute('aria-label', '데스크톱 추가');
      add.addEventListener('click', addSpace);
      host.appendChild(add);
    }

    /* ---------- 프록시 (앱 액션·비서 아바타) ---------- */

    var proxyDocKey = null;

    function syncProxies() {
      var actionsEl = deps.appActionsEl;
      var assistantEl = deps.assistantEl;
      if (!actionsEl && !assistantEl) return;
      var activeId = state.activeId;
      var frame = activeId ? frames[activeId] : null;
      var fdoc = null;
      try { fdoc = frame && frame.contentDocument; } catch (e) { fdoc = null; }
      if (!fdoc || !frame) {
        if (actionsEl) actionsEl.innerHTML = '';
        if (assistantEl) assistantEl.innerHTML = '';
        proxyDocKey = null;
        return;
      }
      var key = activeId + ':' + (fdoc.URL || frame.src || '');
      if (key === proxyDocKey) return; // 같은 문서면 재구축 생략 (검색 포커스 유지)
      proxyDocKey = key;
      if (actionsEl) {
        actionsEl.innerHTML = '';
        var nav = fdoc.querySelector('.g-nav');
        if (nav) {
          var proxyBtn = function (real) {
            if (real.id === 'settingsBtn' || real.classList.contains('settings-btn')) return;
            if (real.id === 'awAvatarBtn') return;
            // 오피스 전용 비서 버튼은 일반 액션이 아니라 비서 슬롯 전용 프록시 대상이다.
            // 여기서 함께 복사하면 내부 아바타 img가 크기 제약 없이 상단바에 붙어
            // 화면 전체를 덮는 오버레이가 된다 (F5 결함 ①).
            if (real.id === 'officeAssistantBtn') return;
            var proxy = doc.createElement('button');
            proxy.type = 'button';
            proxy.className = 'dt-app-action';
            proxy.innerHTML = real.innerHTML;
            proxy.title = real.title || real.textContent.trim();
            proxy.addEventListener('click', function () { real.click(); });
            actionsEl.appendChild(proxy);
          };
          nav.querySelectorAll('button').forEach(proxyBtn);
          // 오피스 호스트: 파일·편집 메뉴는 임베드 시 셸 상단바가 정본
          fdoc.querySelectorAll('.office-menubar .office-menu-btn').forEach(proxyBtn);
          var realInput = nav.querySelector('.nav-search-wrap input');
          if (realInput) {
            var wrap = doc.createElement('span');
            wrap.className = 'dt-app-action-search';
            var input = doc.createElement('input');
            input.type = 'search';
            input.placeholder = realInput.placeholder || '검색';
            input.value = realInput.value;
            input.addEventListener('input', function () {
              realInput.value = input.value;
              var EventCtor = frame.contentWindow ? frame.contentWindow.Event : win.Event;
              realInput.dispatchEvent(new EventCtor('input', { bubbles: true }));
            });
            wrap.appendChild(input);
            actionsEl.appendChild(wrap);
          }
        }
      }
      if (assistantEl) {
        assistantEl.innerHTML = '';
        var avatar = fdoc.querySelector('#awAvatarBtn, #officeAssistantBtn');
        if (avatar && avatar.dataset.awTitlebar) avatar = null; // 제목줄 게시 페이지(메모)는 중복 방지
        if (avatar) {
          var btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'dt-bar-assistant-btn';
          btn.innerHTML = avatar.innerHTML;
          var askLabel = avatar.getAttribute('aria-label') || '비서';
          btn.setAttribute('aria-label', askLabel);
          var askSpan = doc.createElement('span');
          askSpan.textContent = askLabel;
          btn.appendChild(askSpan);
          btn.addEventListener('click', function () { avatar.click(); });
          assistantEl.appendChild(btn);
        }
      }
      if (win.lucide) { try { win.lucide.createIcons(); } catch (e) { console.debug('프록시 아이콘 실패:', e); } }
    }

    /* ---------- 독 연동 ---------- */

    function syncDock() {
      if (!deps.renderDock) return;
      var running = {};
      state.windows.forEach(function (w) { running[w.module] = true; });
      deps.renderDock({ running: running });
    }

    /* ---------- Finder 핸드셰이크 ---------- */

    function postToFrame(id, msg) {
      var frame = frames[id];
      if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, win.location.origin);
    }

    function flushFinderPending() {
      if (pendingFinderView) postToFrame('finder', { type: 'myhub:open-view', view: pendingFinderView });
      if (pendingOpenFile) postToFrame('finder', { type: 'myhub:open-file', file: pendingOpenFile });
    }

    function openFinderTrash() {
      pendingFinderView = 'trash';
      openModule('finder');
      flushFinderPending();
    }

    function openFileInFinder(file) {
      pendingOpenFile = file;
      openModule('finder');
      flushFinderPending();
    }

    function broadcastIconTrashChanged() {
      Object.keys(frames).forEach(function (id) {
        postToFrame(id, { type: 'myhub:icon-trash-changed' });
      });
    }

    /* ---------- 창 제목줄 도구 슬롯 (D-21: 앱 도구는 제목줄 안으로) ---------- */

    function renderWinTools(winId, tools, slotName) {
      var el = nodes[winId];
      if (!el) return;
      var slot = el.querySelector('[data-slot="' + (slotName || 'tools') + '"]');
      if (!slot) return;
      slot.innerHTML = '';
      (tools || []).forEach(function (t) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.dataset.tool = t.id;
        if (t.avatar) {
          var av = doc.createElement('img');
          av.className = 'dt-win-tool-avatar';
          av.src = t.avatar;
          av.alt = '';
          b.appendChild(av);
        }
        if (t.icon) b.innerHTML = '<i data-lucide="' + t.icon + '"></i>';
        if (t.label) {
          var s = doc.createElement('span');
          s.textContent = t.label;
          b.appendChild(s);
        }
        b.title = t.title || t.label || '';
        b.disabled = !!t.disabled;
        if (t.active) b.classList.add('is-active');
        b.addEventListener('click', function () {
          postToFrame(winId, { type: 'myhub:win-tool', id: t.id });
        });
        slot.appendChild(b);
      });
      if (win.lucide) { try { win.lucide.createIcons(); } catch (e) { console.debug('창 도구 아이콘 실패:', e); } }
    }

    function renderWinChevron(winId, label) {
      var el = nodes[winId];
      if (!el) return;
      var slot = el.querySelector('[data-slot="chevron"]');
      if (!slot) return;
      slot.innerHTML = '';
      if (!label) return;
      var b = doc.createElement('button');
      b.type = 'button';
      var ls = doc.createElement('span');
      ls.textContent = label;
      b.appendChild(ls);
      var ci = doc.createElement('i');
      ci.setAttribute('data-lucide', 'chevron-up');
      b.appendChild(ci);
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', function () {
        postToFrame(winId, { type: 'myhub:win-chevron-click' });
      });
      slot.appendChild(b);
      if (win.lucide) { try { win.lucide.createIcons(); } catch (e) { console.debug('셰브론 아이콘 실패:', e); } }
    }

    /* ---------- 메시지 수신 ---------- */

    function frameIdOf(source) {
      var found = null;
      Object.keys(frames).forEach(function (id) {
        if (frames[id] && frames[id].contentWindow === source) found = id;
      });
      return found;
    }

    win.addEventListener('message', function (ev) {
      if (ev.origin !== win.location.origin) return;
      var fromId = frameIdOf(ev.source);
      if (!fromId) return;
      var d = ev.data;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'myhub:doc-title') {
        winTitles[fromId] = String(d.title || '');
        var el = nodes[fromId];
        if (el) {
          var t = el.querySelector('.dt-win-title');
          if (t) t.textContent = winTitles[fromId];
          el.classList.toggle('is-dirty', !!d.dirty); // 수정 시 주황 점 (CSS)
        }
      } else if (d.type === 'myhub:bridge-ready' && pendingAppFiles[fromId]) {
        // 선언-로드 경합: 앱이 준비를 알리면 대기 중이던 파일을 다시 보낸다
        postToFrame(fromId, { type: 'myhub:open-file', file: pendingAppFiles[fromId] });
      } else if (d.type === 'myhub:open-file-ack' && fromId !== 'finder') {
        delete pendingAppFiles[fromId];
      } else if (d.type === 'myhub:finder-ready' && fromId === 'finder') {
        flushFinderPending();
      } else if (d.type === 'myhub:open-view-ack') {
        pendingFinderView = null;
      } else if (d.type === 'myhub:open-file-ack') {
        pendingOpenFile = null;
      } else if (d.type === 'myhub:open-in-app' && d.app) {
        var opened = openModule(String(d.app));
        if (opened && d.file) {
          pendingAppFiles[opened.id] = d.file;
          postToFrame(opened.id, { type: 'myhub:open-file', file: d.file });
        }
      } else if ((d.type === 'myhub:icon-trash-restore' || d.type === 'myhub:icon-trash-purge') && deps.iconsApi) {
        if (d.type === 'myhub:icon-trash-restore') {
          deps.iconsApi.restoreFromTrash(function (it) { return it.id === d.id; });
        } else if (deps.purgeIconTrash) {
          deps.purgeIconTrash(d.id);
        }
        broadcastIconTrashChanged();
        syncDock();
      } else if (d.type === 'myhub:subchat-context' && deps.subchat) {
        deps.subchat.setContext(fromId, d.context || null);
      } else if (d.type === 'myhub:win-tools') {
        renderWinTools(fromId, d.tools, 'tools');
      } else if (d.type === 'myhub:win-tools-left') {
        renderWinTools(fromId, d.tools, 'tools-left');
      } else if (d.type === 'myhub:win-chevron') {
        renderWinChevron(fromId, d.label || null);
      }
    });

    /* 데스크톱 전환은 설정 메뉴의 '데스크톱 ▸' 하위메뉴가 담당한다.
       별도 개요 화면(미션 컨트롤)·칩 바·Ctrl+방향키 진입점은 원본에 없어 제거했다. */

    sync();

    return {
      openModule: openModule,
      focusWindow: focusWindow,
      minimizeWindow: minimizeWindow,
      closeWindow: closeWindow,
      toggleZoom: toggleZoom,
      toggleFullscreen: toggleFullscreen,
      setActiveSpace: setActiveSpace,
      addSpace: addSpace,
      removeSpace: removeSpace,
      enterMission: enterMission,
      toggleMission: toggleMission,
      confirmMission: confirmMission,
      cancelMission: cancelMission,
      openFinderTrash: openFinderTrash,
      openFileInFinder: openFileInFinder,
      broadcastIconTrashChanged: broadcastIconTrashChanged,
      showChips: showChips,
      sync: sync,
      getState: function () { return state; },
      titleOf: titleOf,
    };
  }

  var api = { createManager: createManager };

  if (typeof window !== 'undefined') window.MyHubDesktopWindows = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopWindows = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
