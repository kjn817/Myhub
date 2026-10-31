/**
 * MyHub 데스크톱 워크스페이스 — 상태 모델 (순수 로직, DOM 무접근)
 *
 * 설계: docs/desktop-workspace-design-20261030.md 4·5절
 *
 * - 모든 전이 함수는 불변이다: 입력 state와 windows 배열·항목을 변형하지
 *   않고 새 객체를 반환한다.
 * - 복원·이동·리사이즈 세 경로 모두 clampRect 한 곳을 거친다 (5.4).
 * - parse는 어떤 입력에도 throw하지 않는다: 깨진 항목은 버리고,
 *   복구 불가능하면 빈 상태로 시작한다 (5.2).
 *
 * 노출: window.MyHubDesktopState (브라우저) + module.exports (Node/테스트)
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'myhub.desktop.v1';
  var VERSION = 1;
  var MIN_W = 300;
  var MIN_H = 220;
  var TITLE_GRIP = 48;
  var CASCADE_STEP = 28;

  var MODULES = [
    { id: 'memo', title: '메모', url: '/memo.html', defW: 880, defH: 620 },
    { id: 'schedule', title: '일정', url: '/schedule.html', defW: 880, defH: 620 },
    { id: 'todo', title: '할 일', url: '/todo.html', defW: 640, defH: 560 },
    { id: 'chat', title: 'AI 채팅', url: '/chat.html', defW: 720, defH: 620 },
  ];

  function findModule(moduleId) {
    for (var i = 0; i < MODULES.length; i++) {
      if (MODULES[i].id === moduleId) return MODULES[i];
    }
    return null;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function emptyState() {
    return { version: VERSION, windows: [], activeId: null, zCounter: 0 };
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
    };
  }

  function cloneWindows(windows) {
    return windows.map(cloneWindow);
  }

  /** 남은 비최소화 창 중 z가 가장 큰 창의 id, 없으면 null. */
  function pickActiveId(windows) {
    var best = null;
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (w.minimized) continue;
      if (best === null || w.z > best.z) best = w;
    }
    return best === null ? null : best.id;
  }

  /**
   * clamp 규칙 (설계 5.4):
   * - 크기: w ∈ [MIN_W, viewport.w], h ∈ [MIN_H, viewport.h]
   *   (뷰포트가 최소 크기보다 작으면 뷰포트 크기가 우선한다)
   * - 위치: 제목줄 최소 TITLE_GRIP px이 뷰포트 안에 남도록
   *   x ∈ [-(w-TITLE_GRIP), viewport.w-TITLE_GRIP], y ∈ [0, viewport.h-TITLE_GRIP]
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

    return { x: x, y: y, w: w, h: h };
  }

  function findWindowIndex(state, id) {
    for (var i = 0; i < state.windows.length; i++) {
      if (state.windows[i].id === id) return i;
    }
    return -1;
  }

  /**
   * 포커스 전이의 공통 부분: 대상 창에 새 z를 발급하고 activeId로 삼는다.
   * 호출 전에 windows는 이미 복제된 배열이어야 한다.
   */
  function applyFocus(state, windows, idx) {
    var zCounter = state.zCounter + 1;
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].z = zCounter;
    return {
      version: VERSION,
      windows: windows,
      activeId: windows[idx].id,
      zCounter: zCounter,
    };
  }

  function openModule(state, moduleId, viewport) {
    var mod = findModule(moduleId);
    if (!mod) return state;

    var idx = findWindowIndex(state, moduleId);
    if (idx >= 0) {
      // 싱글턴: 새 창을 만들지 않고 복원(최소화 해제) + 포커스만 이동한다.
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
    };
    return {
      version: VERSION,
      windows: cloneWindows(state.windows).concat([win]),
      activeId: win.id,
      zCounter: zCounter,
    };
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
    if (activeId === id) activeId = pickActiveId(windows);
    return { version: VERSION, windows: windows, activeId: activeId, zCounter: state.zCounter };
  }

  function closeWindow(state, id) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows).filter(function (w) {
      return w.id !== id;
    });
    var activeId = state.activeId;
    if (activeId === id) activeId = pickActiveId(windows);
    return { version: VERSION, windows: windows, activeId: activeId, zCounter: state.zCounter };
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
    return {
      version: VERSION,
      windows: windows,
      activeId: state.activeId,
      zCounter: state.zCounter,
    };
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
    return {
      version: VERSION,
      windows: windows,
      activeId: state.activeId,
      zCounter: state.zCounter,
    };
  }

  function serialize(state) {
    return JSON.stringify(state);
  }

  /**
   * 저장 문자열을 검증·복구해 state로 되돌린다. 어떤 입력에도 throw 금지.
   * - JSON 파싱 실패·version 불일치 → 빈 상태
   * - windows가 배열이 아니면 빈 배열 취급
   * - 항목별: 모르는 module이거나 숫자 필드가 유한수가 아니면 제거,
   *   중복 module은 첫 항목만 유지
   * - 복구 후 전 항목 clamp, zCounter 보정, activeId 재계산
   */
  function parse(json, viewport) {
    var raw;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      return emptyState();
    }
    if (!raw || typeof raw !== 'object' || raw.version !== VERSION) {
      return emptyState();
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
      });
      if (item.z > maxZ) maxZ = item.z;
    }

    var zCounter = isFiniteNumber(raw.zCounter) ? raw.zCounter : 0;
    if (zCounter < maxZ) zCounter = maxZ;

    var activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
    var activeExists = false;
    for (var j = 0; j < windows.length; j++) {
      if (windows[j].id === activeId) {
        activeExists = true;
        break;
      }
    }
    if (!activeExists) activeId = pickActiveId(windows);

    return { version: VERSION, windows: windows, activeId: activeId, zCounter: zCounter };
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
    emptyState: emptyState,
    openModule: openModule,
    focusWindow: focusWindow,
    minimizeWindow: minimizeWindow,
    closeWindow: closeWindow,
    moveWindow: moveWindow,
    resizeWindow: resizeWindow,
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
