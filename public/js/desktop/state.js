/**
 * MyHub 데스크톱 워크스페이스 — 상태 모델 (순수 로직, DOM 무접근)
 *
 * 재구성 근거: 2026-11-01~02 기록 — v2 Spaces 모델(창별 space 필드,
 * addSpace/removeSpace/setActiveSpace/moveWindowToSpace, v1 마이그레이션,
 * parse에서 목록에 없는 space는 첫 데스크톱으로 수리), MODULES 12종
 * (finder 선두 920×620, studio 1180×720, backup 880×640, office 4종은
 * /office.html?app= 진입), 동적 모듈 등록(app-<id>, 스튜디오 게시 앱).
 * 모든 전이 함수는 불변이고, parse는 어떤 입력에도 throw하지 않는다.
 *
 * 노출: window.MyHubDesktopState + module.exports
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
    { id: 'finder', title: 'Finder', url: '/finder.html', defW: 920, defH: 620, glyph: 'folder' },
    { id: 'memo', title: '메모', url: '/memo.html', defW: 880, defH: 620, glyph: 'notebook-pen' },
    { id: 'schedule', title: '일정', url: '/schedule.html', defW: 880, defH: 620, glyph: 'calendar' },
    { id: 'todo', title: '할 일', url: '/todo.html', defW: 640, defH: 560, glyph: 'list-checks' },
    { id: 'chat', title: 'AI 채팅', url: '/chat.html', defW: 720, defH: 620, glyph: 'messages-square' },
    { id: 'browser', title: '브라우저', url: '/browser.html', defW: 1080, defH: 700, glyph: 'compass' },
    { id: 'excel', title: 'Excel', url: '/office.html?app=excel', defW: 1180, defH: 720, glyph: 'table' },
    { id: 'hangul', title: '한글 2020', url: '/office.html?app=hangul', defW: 1080, defH: 720, glyph: 'file-text' },
    { id: 'powerpoint', title: 'PowerPoint', url: '/office.html?app=powerpoint', defW: 1080, defH: 700, glyph: 'presentation' },
    { id: 'pdf', title: 'PDF', url: '/office.html?app=pdf', defW: 980, defH: 700, glyph: 'file' },
    { id: 'studio', title: 'AI 스튜디오', url: '/agent.html', defW: 1180, defH: 720, glyph: 'sparkles' },
    { id: 'backup', title: '백업', url: '/backup.html', defW: 880, defH: 640, glyph: 'archive' },
  ];

  function findModule(moduleId) {
    for (var i = 0; i < MODULES.length; i++) {
      if (MODULES[i].id === moduleId) return MODULES[i];
    }
    return null;
  }

  /** 동적 모듈 등록 (스튜디오 게시 앱 등). 이미 있으면 교체한다. */
  function registerModule(def) {
    if (!def || !def.id || !def.url) return null;
    var existing = findModule(def.id);
    var normalized = {
      id: def.id,
      title: def.title || def.id,
      url: def.url,
      defW: def.defW || 880,
      defH: def.defH || 620,
      glyph: def.glyph || 'layout-grid',
      dynamic: true,
    };
    if (existing) {
      var idx = MODULES.indexOf(existing);
      MODULES[idx] = normalized;
    } else {
      MODULES.push(normalized);
    }
    return normalized;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function firstSpace() {
    return { id: 'space-1', name: '데스크톱 1' };
  }

  function emptyState() {
    return {
      version: VERSION,
      windows: [],
      activeId: null,
      zCounter: 0,
      spaces: [firstSpace()],
      activeSpaceId: 'space-1',
      spaceCounter: 1,
    };
  }

  function cloneWindow(w) {
    return {
      id: w.id, module: w.module,
      x: w.x, y: w.y, w: w.w, h: w.h, z: w.z,
      minimized: w.minimized === true,
      space: w.space,
    };
  }

  function cloneWindows(windows) { return windows.map(cloneWindow); }

  function cloneSpaces(spaces) {
    return spaces.map(function (s) { return { id: s.id, name: s.name }; });
  }

  function pickActiveId(windows, spaceId) {
    var best = null;
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (w.minimized) continue;
      if (spaceId && w.space !== spaceId) continue;
      if (best === null || w.z > best.z) best = w;
    }
    return best === null ? null : best.id;
  }

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

  function findSpaceIndex(state, spaceId) {
    for (var i = 0; i < state.spaces.length; i++) {
      if (state.spaces[i].id === spaceId) return i;
    }
    return -1;
  }

  function withMeta(state, windows, activeId, zCounter) {
    return {
      version: VERSION,
      windows: windows,
      activeId: activeId,
      zCounter: zCounter,
      spaces: cloneSpaces(state.spaces),
      activeSpaceId: state.activeSpaceId,
      spaceCounter: state.spaceCounter,
    };
  }

  function applyFocus(state, windows, idx) {
    var zCounter = state.zCounter + 1;
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].z = zCounter;
    var next = withMeta(state, windows, windows[idx].id, zCounter);
    next.activeSpaceId = windows[idx].space || state.activeSpaceId;
    return next;
  }

  function openModule(state, moduleId, viewport) {
    var mod = findModule(moduleId);
    if (!mod) return state;
    var idx = findWindowIndex(state, moduleId);
    if (idx >= 0) {
      var existing = cloneWindows(state.windows);
      existing[idx] = cloneWindow(existing[idx]);
      existing[idx].minimized = false;
      return applyFocus(state, existing, idx);
    }
    var offset = state.windows.length * CASCADE_STEP;
    var rect = clampRect({
      x: (viewport.w - mod.defW) / 2 + offset,
      y: (viewport.h - mod.defH) / 2 + offset,
      w: mod.defW, h: mod.defH,
    }, viewport);
    var zCounter = state.zCounter + 1;
    var win = {
      id: mod.id, module: mod.id,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      z: zCounter, minimized: false,
      space: state.activeSpaceId,
    };
    return withMeta(state, cloneWindows(state.windows).concat([win]), win.id, zCounter);
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
    var activeId = state.activeId === id ? pickActiveId(windows, state.activeSpaceId) : state.activeId;
    return withMeta(state, windows, activeId, state.zCounter);
  }

  function closeWindow(state, id) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows).filter(function (w) { return w.id !== id; });
    var activeId = state.activeId === id ? pickActiveId(windows, state.activeSpaceId) : state.activeId;
    return withMeta(state, windows, activeId, state.zCounter);
  }

  function moveWindow(state, id, x, y, viewport) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows);
    var cur = windows[idx];
    var rect = clampRect({ x: x, y: y, w: cur.w, h: cur.h }, viewport);
    windows[idx] = cloneWindow(cur);
    windows[idx].x = rect.x; windows[idx].y = rect.y;
    windows[idx].w = rect.w; windows[idx].h = rect.h;
    return withMeta(state, windows, state.activeId, state.zCounter);
  }

  function resizeWindow(state, id, rect, viewport) {
    var idx = findWindowIndex(state, id);
    if (idx < 0) return state;
    var windows = cloneWindows(state.windows);
    var clamped = clampRect(rect, viewport);
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].x = clamped.x; windows[idx].y = clamped.y;
    windows[idx].w = clamped.w; windows[idx].h = clamped.h;
    return withMeta(state, windows, state.activeId, state.zCounter);
  }

  /* ---- Spaces ---- */

  function addSpace(state) {
    var counter = (state.spaceCounter || state.spaces.length) + 1;
    var space = { id: 'space-' + counter, name: '데스크톱 ' + counter };
    var next = withMeta(state, cloneWindows(state.windows), state.activeId, state.zCounter);
    next.spaces = cloneSpaces(state.spaces).concat([space]);
    next.activeSpaceId = space.id;
    next.spaceCounter = counter;
    return next;
  }

  function removeSpace(state, spaceId) {
    if (state.spaces.length <= 1) return state; // 마지막 1개는 삭제 불가
    var idx = findSpaceIndex(state, spaceId);
    if (idx < 0) return state;
    var neighbor = state.spaces[idx > 0 ? idx - 1 : idx + 1];
    var windows = cloneWindows(state.windows).map(function (w) {
      if (w.space === spaceId) { var c = cloneWindow(w); c.space = neighbor.id; return c; }
      return w;
    });
    var next = withMeta(state, windows, state.activeId, state.zCounter);
    next.spaces = cloneSpaces(state.spaces).filter(function (s) { return s.id !== spaceId; });
    if (next.activeSpaceId === spaceId) {
      next.activeSpaceId = neighbor.id;
      next.activeId = pickActiveId(windows, neighbor.id);
    }
    return next;
  }

  function setActiveSpace(state, spaceId) {
    if (findSpaceIndex(state, spaceId) < 0) return state;
    var next = withMeta(state, cloneWindows(state.windows), state.activeId, state.zCounter);
    next.activeSpaceId = spaceId;
    next.activeId = pickActiveId(next.windows, spaceId) || state.activeId;
    var activeWin = null;
    for (var i = 0; i < next.windows.length; i++) {
      if (next.windows[i].id === next.activeId) activeWin = next.windows[i];
    }
    if (!activeWin || activeWin.space !== spaceId) next.activeId = pickActiveId(next.windows, spaceId);
    return next;
  }

  function moveWindowToSpace(state, id, spaceId) {
    var idx = findWindowIndex(state, id);
    if (idx < 0 || findSpaceIndex(state, spaceId) < 0) return state;
    var windows = cloneWindows(state.windows);
    windows[idx] = cloneWindow(windows[idx]);
    windows[idx].space = spaceId;
    return withMeta(state, windows, state.activeId, state.zCounter);
  }

  /* ---- 직렬화 ---- */

  function serialize(state) { return JSON.stringify(state); }

  function parse(json, viewport) {
    var raw;
    try { raw = JSON.parse(json); } catch (e) { return emptyState(); }
    if (!raw || typeof raw !== 'object') return emptyState();
    if (raw.version !== 1 && raw.version !== VERSION) return emptyState();

    var spaces = [];
    var rawSpaces = Array.isArray(raw.spaces) ? raw.spaces : [];
    for (var s = 0; s < rawSpaces.length; s++) {
      var rs = rawSpaces[s];
      if (rs && typeof rs.id === 'string' && typeof rs.name === 'string') {
        spaces.push({ id: rs.id, name: rs.name });
      }
    }
    if (!spaces.length) spaces = [firstSpace()];
    var spaceIds = {};
    spaces.forEach(function (sp) { spaceIds[sp.id] = true; });
    var activeSpaceId = typeof raw.activeSpaceId === 'string' && spaceIds[raw.activeSpaceId]
      ? raw.activeSpaceId : spaces[0].id;

    var rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
    var windows = [];
    var seen = {};
    var maxZ = 0;
    for (var i = 0; i < rawWindows.length; i++) {
      var item = rawWindows[i];
      if (!item || typeof item !== 'object') continue;
      if (!findModule(item.module)) continue;
      if (seen[item.module]) continue;
      if (!isFiniteNumber(item.x) || !isFiniteNumber(item.y) ||
          !isFiniteNumber(item.w) || !isFiniteNumber(item.h) || !isFiniteNumber(item.z)) continue;
      seen[item.module] = true;
      var rect = clampRect({ x: item.x, y: item.y, w: item.w, h: item.h }, viewport);
      windows.push({
        id: item.module, module: item.module,
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        z: item.z, minimized: item.minimized === true,
        space: typeof item.space === 'string' && spaceIds[item.space] ? item.space : spaces[0].id,
      });
      if (item.z > maxZ) maxZ = item.z;
    }

    var zCounter = isFiniteNumber(raw.zCounter) ? raw.zCounter : 0;
    if (zCounter < maxZ) zCounter = maxZ;
    var spaceCounter = isFiniteNumber(raw.spaceCounter) ? raw.spaceCounter : spaces.length;

    var base = {
      version: VERSION, windows: windows, activeId: null,
      zCounter: zCounter, spaces: spaces, activeSpaceId: activeSpaceId,
      spaceCounter: spaceCounter,
    };
    var activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
    var activeExists = windows.some(function (w) { return w.id === activeId; });
    base.activeId = activeExists ? activeId : pickActiveId(windows, activeSpaceId);
    return base;
  }

  function load(storage, viewport) {
    var json = null;
    try { json = storage.getItem(STORAGE_KEY); } catch (e) { return emptyState(); }
    if (json === null || json === undefined) return emptyState();
    return parse(json, viewport);
  }

  function save(storage, state) { storage.setItem(STORAGE_KEY, serialize(state)); }

  var api = {
    STORAGE_KEY: STORAGE_KEY, VERSION: VERSION,
    MIN_W: MIN_W, MIN_H: MIN_H, TITLE_GRIP: TITLE_GRIP,
    MODULES: MODULES,
    findModule: findModule, registerModule: registerModule,
    emptyState: emptyState,
    openModule: openModule, focusWindow: focusWindow,
    minimizeWindow: minimizeWindow, closeWindow: closeWindow,
    moveWindow: moveWindow, resizeWindow: resizeWindow,
    addSpace: addSpace, removeSpace: removeSpace,
    setActiveSpace: setActiveSpace, moveWindowToSpace: moveWindowToSpace,
    clampRect: clampRect, serialize: serialize, parse: parse,
    load: load, save: save,
  };

  if (typeof window !== 'undefined') window.MyHubDesktopState = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
