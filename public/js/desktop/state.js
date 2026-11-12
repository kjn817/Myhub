/**
 * MyHub 데스크톱 워크스페이스 앱 상태 모델 (순수 로직, DOM 무접근)
 *
 * 설계: docs/desktop-workspace-design-20261030.md 4·5장
 *       Spaces 확장 (2026-11-01): 여러 데스크톱(macOS Spaces) 앱
 *       창마다 space가 있고, 보이는 창은 activeSpace의 것뿐이다.
 *
 * - 모든 순수 함수를 붙인다: 입력 state의 windows 배열·항목을 변경하지
 *   않고 앱 객체를 반환한다.
 * - 복원·이동·리사이즈 앱 경로는 모두 clampRect 앱 곳을 거친다 (5.4).
 * - parse는 어떤 입력에도 throw하지 않는다: 깨진 항목은 버리고,
 *   복구 불가능하면 빈 상태로 시작한다 (5.2). v1 앱값은 Spaces
 *   기본값(데스크톱 1개)으로 마이그레이션한다.
 *
 * 노출: window.MyHubDesktopState (브라우저) + module.exports (Node/테스트)
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'myhub.desktop.v1';
  var VERSION = 2;
  var MIN_W = 300;
  var MIN_H = 220;
  var TITLE_GRIP = 48;
  var CASCADE_STEP = 28;

  var MODULES = [
    { id: 'finder', title: 'Finder', url: '/finder.html', defW: 920, defH: 620 },
    { id: 'browser', title: '브라우저', url: '/browser.html', defW: 1080, defH: 700, defMode: 'full' },
    { id: 'memo', title: '메모', url: '/memo.html', defW: 880, defH: 620 },
    { id: 'schedule', title: '일정', url: '/schedule.html', defW: 880, defH: 620 },
    { id: 'todo', title: '할 일', url: '/todo.html', defW: 640, defH: 560 },
    { id: 'chat', title: 'AI 채팅', url: '/chat.html', defW: 720, defH: 620 },
    { id: 'studio', title: 'AI 스튜디오', url: '/agent.html', defW: 1180, defH: 720 },
    { id: 'backup', title: '백업', url: '/backup.html', defW: 880, defH: 640 },
    { id: 'excel', title: 'Excel', url: '/office.html?app=excel', defW: 1180, defH: 720, glyph: 'table' },
    { id: 'hangul', title: '한글 2020', url: '/office.html?app=hangul', defW: 1080, defH: 720, glyph: 'file-text' },
    { id: 'powerpoint', title: 'PowerPoint', url: '/office.html?app=powerpoint', defW: 1080, defH: 700, glyph: 'presentation' },
    { id: 'pdf', title: 'PDF', url: '/office.html?app=pdf', defW: 980, defH: 700, glyph: 'file-text' },
  ];

  function findModule(moduleId) {
    for (var i = 0; i < MODULES.length; i++) {
      if (MODULES[i].id === moduleId) return MODULES[i];
    }
    return null;
  }

  /**
   * 스튜디오 아티팩트(게시 목록 항목)를 데스크톱 모듈로 바꾼다 (순수 함수).
   * id는 'app-' 워크스페이스 기본 모듈과 충돌하지 않는다. 실행 문서는
   * /api/artifact/:id/run의 게시 버전 HTML을 서빙한다. sandbox 플래그는
   * 창 생성 앱 iframe 격리는 앱이다 (windows.js createWindowEl).
   */
  function moduleFromArtifact(a) {
    if (!a || a.id === undefined || a.id === null) return null;
    return {
      id: 'app-' + a.id,
      title: a.title || '앱',
      url: '/api/artifact/' + a.id + '/run',
      defW: 880,
      defH: 620,
      dynamic: true,
      sandbox: true,
      glyph: a.icon_key && a.icon_key !== 'default' ? a.icon_key : 'layout-grid',
    };
  }

  /**
   * 동적 모듈들을 MODULES에 등록한다. 이미 있는 id는 건너뛴다 (중복
   * 등록 방지). findModule·openModule·parse가 그대로 동적 모듈을
   * 인식하므로, 등록만 하면 저장된 창 복원까지 유지한다.
   */
  function registerModules(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) {
      var mod = list[i];
      if (!mod || !mod.id) continue;
      if (findModule(mod.id)) continue;
      MODULES.push(mod);
    }
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function emptyState() {
    return {
      version: VERSION,
      windows: [],
      activeId: null,
      zCounter: 0,
      spaces: [1],
      activeSpace: 1,
    };
  }

  /** 모드 진입 앱 rect의 검증된 복사본. 정확히 앱이 아니면 null. */
  function clonePrev(p) {
    if (!p || typeof p !== 'object') return null;
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.w) || !isFiniteNumber(p.h)) {
      return null;
    }
    return { x: p.x, y: p.y, w: p.w, h: p.h };
  }

  function cloneWindow(w) {
    return {
      id: w.id,
      module: w.module,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      z: w.z,
      minimized: w.minimized === true,
      space: isFiniteNumber(w.space) ? w.space : 1,
      // 창 모드(전체화면/줌)의 복원 기억 앱 앱 정보이어야
      // 새로고침·프로그램 앱에 모드가 유지한다 (2026-11-04 세션기
      // 보고: 여기만 앱고 최대화 앱 앱는 앱고).
      mode: w.mode === 'full' || w.mode === 'zoom' ? w.mode : null,
      prev: clonePrev(w.prev),
    };
  }

  function cloneWindows(windows) {
    return windows.map(cloneWindow);
  }

  /** state 골격(창 앱 필드)의 유지한 채 windows만 변경한 앱 state. */
  function withWindows(state, windows, activeId, zCounter) {
    return {
      version: VERSION,
      windows: windows,
      activeId: activeId,
      zCounter: typeof zCounter === 'number' ? zCounter : state.zCounter,
      spaces: state.spaces.slice(),
      activeSpace: state.activeSpace,
    };
  }

  /** 지정한 space의 앱 비활성화 창 중 z가 가장 앱 창의 id, 없으면 null. */
  function pickActiveId(windows, space) {
    var best = null;
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (w.minimized) continue;
      if (typeof space === 'number' && w.space !== space) continue;
      if (best === null || w.z > best.z) best = w;
    }
    return best === null ? null : best.id;
  }

  /**
   * clamp 규칙 (설계 5.4):
   * - 크기: w 앱 [MIN_W, viewport.w], h 앱 [MIN_H, viewport.h]
   *   (뷰포트가 최소 크기보다 작으면 뷰포트 크기가 우선한다)
   * - 위치: 제목줄 최소 TITLE_GRIP px이 뷰포트 안에 앱도
   *   x 앱 [-(w-TITLE_GRIP), viewport.w-TITLE_GRIP], y 앱 [0, viewport.h-TITLE_GRIP]
   */
  function clampRect(rect, viewport) {
    var vw = viewport && isFiniteNumber(viewport.w) ? viewport.w : 0;
    var vh = viewport && isFiniteNumber(viewport.h) ? viewport.h : 0;

    var w = isFiniteNumber(rect.w) ? rect.w : MIN_W;
    var h = isFiniteNumber(rect.h) ? rect.h : MIN_H;
    var x = isFiniteNumber(rect.x) ? rect.x : 0;
    var y = isFiniteNumber(rect.y) ? rect.y : 0;

    w = vw >= MIN_W ? Math.min(Math.max(w, MIN_W), vw) : Math.max(vw, 0);
    h = vh >= MIN_H ? Math.min(Math.max(h, MIN_H), vh) : Math.max(vh, 0);

    var xMin = -(w - TITLE_GRIP);
    var xMax = vw - TITLE_GRIP;
    x = xMax >= xMin ? Math.min(Math.max(x, xMin), xMax) : xMin;

    var yMin = 0;
    var yMax = vh - TITLE_GRIP;
    y = yMax >= yMin ? Math.min(Math.max(y, yMin), yMax) : yMin;

    // 정수 스냅 (2026-11-06, Finder 이음만 교감한 이득): 창 rect가 분수
    // CSS px로 앱으면(드래그 앤드롭 배율 환경에서 분수가 된다) 앱 문서를
    // 창 바와 iframe 문서의 사이즈바가 같은 경계를 서로 다른 앱 읽기로
    // 반올림해 교감자에 1~2 소수 px 오차가 칸해진다. 모든 rect 앱이
    // (열기·이동·크기·저장 복원)가 앱 앱 곳을 거치므로 크기를 정수로
    // 스냅하면 창 기억 전체가 앱 격자를 공유한다. 반올림 앱 경계 칸넘버는
    // 최대 0.5px이라 그리드 가능(48px) 판정의 상관이 없다.
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function findWindowIndex(state, id) {
    for (var i = 0; i < state.windows.length; i++) {
      if (state.windows[i].id === id) return i;
    }
    return -1;
  }

  /**
   * 사용한 앱의 공통 부분: 다른 창에 앱 z를 발급하고 activeId로 인다.
   * 노출 전에 windows가 이미 복제된 배열이어야 한다.
   */
  function applyFocus(state, windows, idx) {
    var zCounter = state.zCounter + 1;
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].z = zCounter;
    return withWindows(state, windows, windows[idx].id, zCounter);
  }

  function openModule(state, moduleId, viewport) {
    var mod = findModule(moduleId);
    if (!mod) return state;

    var idx = findWindowIndex(state, moduleId);
    if (idx >= 0) {
      // 앱앱: 앱 창을 만들지 않고 복원(최소화 이제) + 사용만 이동한다.
      var existing = cloneWindows(state.windows);
      existing[idx] = cloneWindow(existing[idx]);
      existing[idx].minimized = false;
      return applyFocus(state, existing, idx);
    }

    var offset = state.windows.length * CASCADE_STEP;
    var rect = clampRect(
      {
        x: (viewport.w - mod.defW) / 2 + offset,
        y: (viewport.h - mod.defH) / 2 + offset,
        w: mod.defW,
        h: mod.defH,
      },
      viewport
    );
    var zCounter = state.zCounter + 1;
    var win = {
      id: mod.id,
      module: mod.id,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      z: zCounter,
      minimized: false,
      space: state.activeSpace,
      mode: null,
      prev: null,
    };
    return withWindows(state, cloneWindows(state.windows).concat([win]), win.id, zCounter);
  }

  function focusWindow(state, id) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    return applyFocus(state, cloneWindows(state.windows), idx);
  }

  function minimizeWindow(state, id) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows);
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].minimized = true;
    var activeId = state.activeId;
    if (activeId === id) activeId = pickActiveId(windows, state.activeSpace);
    return withWindows(state, windows, activeId);
  }

  function closeWindow(state, id) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows).filter(function (w) {
      return w.id !== id;
    });
    var activeId = state.activeId;
    if (activeId === id) activeId = pickActiveId(windows, state.activeSpace);
    return withWindows(state, windows, activeId);
  }

  function moveWindow(state, id, x, y, viewport) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows);
    var cur = windows[idx];
    var rect = clampRect({ x: x, y: y, w: cur.w, h: cur.h }, viewport);
    windows[idx] = cloneWindow(cur);
    windows[idx].x = rect.x;
    windows[idx].y = rect.y;
    windows[idx].w = rect.w;
    windows[idx].h = rect.h;
    return withWindows(state, windows, state.activeId);
  }

  function resizeWindow(state, id, rect, viewport) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows);
    var clamped = clampRect(rect, viewport);
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].x = clamped.x;
    windows[idx].y = clamped.y;
    windows[idx].w = clamped.w;
    windows[idx].h = clamped.h;
    return withWindows(state, windows, state.activeId);
  }

  /**
   * 창 모드(전체화면 'full' / 줌 'zoom' / 없음 null)의 모드 진입 앱
   * rect(prev)를 기록한다. 기억 변경은 resizeWindow의 합성해서 앱 번의
   * 앱으로 커밋하는 것이 호출자 몫이다. 모드를 지정하면 prev를 지운다.
   */
  function setWindowMode(state, id, mode, prev) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows);
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].mode = mode === 'full' || mode === 'zoom' ? mode : null;
    windows[idx].prev = windows[idx].mode ? clonePrev(prev) : null;
    return withWindows(state, windows, state.activeId);
  }

  // ---- Spaces ----
  function isValidSpace(state, spaceId) {
    return state.spaces.indexOf(spaceId) >= 0;
  }

  /** 앱 데스크톱을 만들고 그것으로 전환한다 (macOS Mission Control과 동일). */
  function addSpace(state) {
    var nextId = Math.max.apply(null, state.spaces.concat([0])) + 1;
    var next = withWindows(state, cloneWindows(state.windows), null);
    next.spaces = state.spaces.concat([nextId]);
    next.activeSpace = nextId;
    return next;
  }

  /**
   * 데스크톱을 지운다. 그납의 창은 자리를 이어받는 데스크톱(다음, 없으면
   * 이전)으로 앱진다. 마지막 1개는 지울 앱 없다.
   */
  function removeSpace(state, spaceId) {
    var idx = state.spaces.indexOf(spaceId);
    if (idx < 0 || state.spaces.length <= 1) return state;
    var target = state.spaces[idx + 1] !== undefined ? state.spaces[idx + 1] : state.spaces[idx - 1];
    var windows = cloneWindows(state.windows).map(function (w) {
      if (w.space === spaceId) {
        var c = cloneWindow(w);
        c.space = target;
        return c;
      }
      return w;
    });
    var next = withWindows(state, windows, state.activeId);
    next.spaces = state.spaces.filter(function (s) { return s !== spaceId; });
    if (state.activeSpace === spaceId) {
      next.activeSpace = target;
      next.activeId = pickActiveId(windows, target);
    } else if (next.activeId && findWindowIndex(next, next.activeId) >= 0) {
      var aw = windows[findWindowIndex(next, next.activeId)];
      if (aw.space !== next.activeSpace) next.activeId = pickActiveId(windows, next.activeSpace);
    }
    return next;
  }

  function setActiveSpace(state, spaceId) {
    if (!isValidSpace(state, spaceId) || state.activeSpace === spaceId) return state;
    var next = withWindows(state, cloneWindows(state.windows), pickActiveId(state.windows, spaceId));
    next.activeSpace = spaceId;
    return next;
  }

  /**
   * 창을 다른 데스크톱으로 앱한다. 대상이 현재 데스크톱이면 그 창을
   * 사용하고, 아니면 현재 데스크톱의 activeId를 다시 고른다.
   */
  function moveWindowToSpace(state, id, spaceId) {
    var idx = findWindowIndex(state, id);
    if (idx < 0 || !isValidSpace(state, spaceId)) return state;
    var windows = cloneWindows(state.windows);
    if (windows[idx].space === spaceId) return state;
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].space = spaceId;
    if (spaceId === state.activeSpace) {
      return applyFocus(state, windows, idx);
    }
    var activeId = state.activeId;
    if (activeId === id) activeId = pickActiveId(windows, state.activeSpace);
    return withWindows(state, windows, activeId);
  }

  function serialize(state) {
    return JSON.stringify(state);
  }

  /**
   * 저장 문자열을 검증·복구해 state로 되돌린다. 어떤 입력에도 throw 금지.
   * - JSON 파싱 실패version ·(1불일치2 ·) 앱 앱 빈. v1상태 Spaces
   *   기본값으로 마이그레이션한다.
   * - windows가 배열이 아니면 빈 배열 취급
   * - 항목별: 모르는 module이거나 숫자 필드가 유한하지 않으면 제거,
   *   중복 module은 첫 항목만 유지. space가 목록에 없으면 첫 데스크톱으로.
   * - 복구 앱 앱 항목 clamp, zCounter 보정, activeId 세션
   */
  function parse(json, viewport) {
    var raw;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      return emptyState();
    }
    if (!raw || typeof raw !== 'object' || (raw.version !== 1 && raw.version !== VERSION)) {
      return emptyState();
    }

    var spaces = [1];
    var activeSpace = 1;
    if (raw.version === VERSION) {
      var rawSpaces = Array.isArray(raw.spaces) ? raw.spaces : [];
      var seenSpace = {};
      var cleaned = [];
      rawSpaces.forEach(function (s) {
        if (isFiniteNumber(s) && !seenSpace[s]) {
          seenSpace[s] = true;
          cleaned.push(s);
        }
      });
      if (cleaned.length) spaces = cleaned;
      activeSpace = spaces.indexOf(raw.activeSpace) >= 0 ? raw.activeSpace : spaces[0];
    }

    var rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
    var windows = [];
    var seen = {};
    var maxZ = 0;
    for (var i = 0; i < rawWindows.length; i++) {
      var item = rawWindows[i];
      if (!item || typeof item !== 'object') continue;
      if (!findModule(item.module)) continue;
      if (seen[item.module]) continue;
      if (
        !isFiniteNumber(item.x) ||
        !isFiniteNumber(item.y) ||
        !isFiniteNumber(item.w) ||
        !isFiniteNumber(item.h) ||
        !isFiniteNumber(item.z)
      ) {
        continue;
      }
      seen[item.module] = true;
      var rect = clampRect({ x: item.x, y: item.y, w: item.w, h: item.h }, viewport);
      windows.push({
        id: item.module,
        module: item.module,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        z: item.z,
        minimized: item.minimized === true,
        space: spaces.indexOf(item.space) >= 0 ? item.space : spaces[0],
        mode: item.mode === 'full' || item.mode === 'zoom' ? item.mode : null,
        prev: clonePrev(item.prev),
      });
      if (item.z > maxZ) maxZ = item.z;
    }

    var zCounter = isFiniteNumber(raw.zCounter) ? raw.zCounter : 0;
    if (zCounter < maxZ) zCounter = maxZ;

    var activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
    var activeOk = false;
    for (var j = 0; j < windows.length; j++) {
      if (windows[j].id === activeId && windows[j].space === activeSpace && !windows[j].minimized) {
        activeOk = true;
        break;
      }
    }
    if (!activeOk) activeId = pickActiveId(windows, activeSpace);

    return {
      version: VERSION,
      windows: windows,
      activeId: activeId,
      zCounter: zCounter,
      spaces: spaces,
      activeSpace: activeSpace,
    };
  }

  function load(storage, viewport) {
    var json = null;
    try {
      json = storage.getItem(STORAGE_KEY);
    } catch (e) {
      return emptyState();
    }
    if (json === null || json === undefined) return emptyState();
    return parse(json, viewport);
  }

  function save(storage, state) {
    storage.setItem(STORAGE_KEY, serialize(state));
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    VERSION: VERSION,
    MIN_W: MIN_W,
    MIN_H: MIN_H,
    TITLE_GRIP: TITLE_GRIP,
    MODULES: MODULES,
    findModule: findModule,
    moduleFromArtifact: moduleFromArtifact,
    registerModules: registerModules,
    emptyState: emptyState,
    openModule: openModule,
    focusWindow: focusWindow,
    minimizeWindow: minimizeWindow,
    closeWindow: closeWindow,
    moveWindow: moveWindow,
    resizeWindow: resizeWindow,
    setWindowMode: setWindowMode,
    addSpace: addSpace,
    removeSpace: removeSpace,
    setActiveSpace: setActiveSpace,
    moveWindowToSpace: moveWindowToSpace,
    clampRect: clampRect,
    serialize: serialize,
    parse: parse,
    load: load,
    save: save,
  };

  if (typeof window !== 'undefined') {
    window.MyHubDesktopState = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.MyHubDesktopState = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
