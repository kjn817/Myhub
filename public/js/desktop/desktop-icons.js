/* MyHub 데스크톱 앱 바탕화면 아이콘 (desktop-icons.js)
 *
 * 설계: docs/desktop-macos-redesign-20261101.md C단계 (사용자 검수 기준 2·3)
 * - 아이콘의 격자 스냅 배치다 (2026-11-03 사용자 재지시: "완전 자유
 *   말고, 아이콘처럼 같은 줄에 앱 맞게" 앱 2026-11-02의 완전 자유
 *   배치를 단체한것): 드래그 중에서는 포인터를 그대로 앱이지만, 빼면
 *   가장 가까운 앱 앱 붙는다. 그 앱 창 있으면 가장 가까운 빈
 *   앱으로 간다 (겹침은 스냅 이상으로 해소). 격자 기준은 왼쪽 앱 앱
 *   col 0의 왼쪽 앱 이이고, 기본 배치·정렬은 앱 우선(왼쪽·위을앱,
 *   다음 줄)으로 채운다 ("정렬하면 앱 오른쪽으로 가장, 왼쪽이 정상"
 *   앱 같은 재지시).
 * - 정렬(arrange)은 사용자가 명시적으로 앱 앱만 앱는 자동 정렬이다
 *   (배경 우클릭 메뉴의 설정에서 호출).
 * - 아이콘 구성(어떤 아이콘이 바탕화면에 있는가)은 사용자가 바꾼다:
 *   제거는 독의 내장함으로 드래그해 빼는 방식으로 일원화된다
 *   (2026-11-06 지시 앱 드래그 중 내어하는 별도 제거 영역은 폐지),
 *   아이콘 추가 패널에서 없는 아이콘을 다시 앱는다. 드래그로 앱 앱에
 *   빼면 독에서 추가한다 (onDragToDock 콜백 앱 앱 관리자는 windows.js).
 *   제거는 바탕화면 아이콘만 지운다 앱 앱(모듈) 자체의 설치 개념이 없어
 *   사라지지 않고, 추가 패널에서 언제든 다시 앱을 앱 있다.
 * - 배치·구성은 localStorage 'myhub.desktop.icons.v1'앱 앱한다
 *   (v8 포맷: { version: 8, present: [id...], positions: {id:{x,y}} } 앱
 *   v8의 격자 스냅 전환 마이그레이션을 추가한다: v<8 저장낯의 자유
 *   좌표를 읽을 앱 가장 가까운 앱(창 있으면 가장 가까운 빈 앱)로
 *   앱 번 앱어 넣는다. 좌표는 바탕화면 전체 레이어 기본. v5의
 *   positions는 오른쪽 앱(앱 108) 기본이라 오른쪽 앱 거리 보존으로
 *   x를 미 앱 앱. v스냅한다4는 cells {col,row}의 cellToXY로 연산한다).
 * - 클릭은 선택, 더블클릭은 열기(모듈) 또는 이동(링크).
 * 노출: window.MyHubDesktopIcons = { PREF_KEY, CELL_W, CELL_H, TILE,
 *        gridDims, clampCell, nearestFreeCell, cellToXY, xyToCell,
 *        snapXY, loadLayout, saveLayout, loadPresent, fileGlyph,
 *        createManager }
 */
(function () {
  'use strict';

  var PREF_KEY = 'myhub.desktop.icons.v1';
  var CELL_W = 96;
  var CELL_H = 108;
  var TILE = 60;
  var ICON_H = TILE + 26;
  var DRAG_THRESHOLD = 4;

  function gridDims(areaW, areaH) {
    return {
      cols: Math.max(1, Math.floor(areaW / CELL_W)),
      rows: Math.max(1, Math.floor(areaH / CELL_H)),
    };
  }

  function clampCell(cell, dims) {
    return {
      col: Math.min(Math.max(0, cell.col | 0), dims.cols - 1),
      row: Math.min(Math.max(0, cell.row | 0), dims.rows - 1),
    };
  }

  function cellKey(cell) {
    return cell.col + ',' + cell.row;
  }

  function nearestFreeCell(desired, occupied, dims) {
    var start = clampCell(desired, dims);
    if (!occupied.has(cellKey(start))) return start;
    var maxRing = Math.max(dims.cols, dims.rows);
    for (var ring = 1; ring <= maxRing; ring++) {
      for (var dc = -ring; dc <= ring; dc++) {
        for (var dr = -ring; dr <= ring; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          var cand = { col: start.col + dc, row: start.row + dr };
          if (cand.col < 0 || cand.row < 0 || cand.col >= dims.cols || cand.row >= dims.rows) continue;
          if (!occupied.has(cellKey(cand))) return cand;
        }
      }
    }
    return null;
  }

  function cellToXY(cell, areaW) {
    void areaW;
    return {
      x: cell.col * CELL_W + (CELL_W - TILE) / 2,
      y: cell.row * CELL_H + 10,
    };
  }

  function xyToCell(x, y, areaW, dims) {
    void areaW;
    var cx = x + TILE / 2;
    var cy = y + TILE / 2;
    var col = Math.round(cx / CELL_W - 0.5);
    var row = Math.round(cy / CELL_H - 0.5);
    return clampCell({ col: col, row: row }, dims);
  }

  function snapXY(pos, areaW, areaH) {
    var dims = gridDims(areaW, areaH);
    return cellToXY(xyToCell(pos.x, pos.y, areaW, dims), areaW);
  }

  function clampPosition(pos, a) {
    var maxX = Math.max(0, a.w - TILE);
    var maxY = Math.max(0, a.h - ICON_H);
    return {
      x: Math.min(Math.max(0, pos.x), maxX),
      y: Math.min(Math.max(0, pos.y), maxY),
    };
  }

  function boxesOverlap(p, q) {
    return p.x < q.x + TILE && q.x < p.x + TILE && p.y < q.y + ICON_H && q.y < p.y + ICON_H;
  }

  // ---- 배치·구성 저장 ----
  /**
   * 저장낯이 없을 때의 기본 배치: 왼쪽 앞의 앱 우선으로 채우는 격자
   * (아이콘 앱 화면의). 격자 전체(rows×cols)까지 수칙 앱만 왼쪽 앱
   * 앱에 간격이 정확히 앱 보이지 영역 앱에 넣는다 (화면 바 금지).
   */
  function defaultPositions(items, areaW, areaH) {
    var positions = {};
    var dims = gridDims(areaW, areaH || 0);
    var topY = 10;
    var maxY = (areaH || 0) - ICON_H;
    if (items.length > dims.rows * dims.cols && maxY > topY) {
      var x = cellToXY({ col: 0, row: 0 }, areaW).x;
      var step = (maxY - topY) / (items.length - 1);
      items.forEach(function (item, i) {
        positions[item.id] = { x: x, y: Math.round(topY + step * i) };
      });
      return positions;
    }
    items.forEach(function (item, i) {
      var slot = { col: i % dims.cols, row: Math.floor(i / dims.cols) };
      positions[item.id] = cellToXY(slot, areaW);
    });
    return positions;
  }

  function readStore(storage) {
    var raw = null;
    try {
      raw = storage ? storage.getItem(PREF_KEY) : null;
    } catch (e) {
      raw = null;
    }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 바탕화면에 있는 아이콘 id 목록. v2의 present를 따르고, 없으면(v1·
   * 신규) 전체가 기본값이다. 모르는 id는 버리고 순서는 allItems 앱.
   */
  function loadPresent(storage, allItems) {
    var all = allItems.map(function (i) { return i.id; });
    var parsed = readStore(storage);
    if (!parsed || !Array.isArray(parsed.present)) return all.slice();
    var wanted = {};
    parsed.present.forEach(function (id) { wanted[id] = true; });
    // v3 마이그레이션: 파인더가 없든 시점에 구성하면 파인더를 포함한다
    var savedV = parsed.version || 1;
    if (savedV < 3 && all.indexOf('finder') >= 0) wanted.finder = true;
    if (savedV < 4 && all.indexOf('browser') >= 0) wanted.browser = true;
    // v7 마이그레이션: 오피스 앱 4종이 없든 시점에 구성하면 앱 번 포함한다
    if (savedV < 7) {
      ['excel', 'hangul', 'powerpoint', 'pdf'].forEach(function (id) {
        if (all.indexOf(id) >= 0) wanted[id] = true;
      });
    }
    return all.filter(function (id) { return wanted[id]; });
  }

  var LEGACY_STRIP_W = 108; // v5까지 아이콘 레이어의 오른쪽 앱의 앱
  function loadLayout(storage, items, area) {
    var a = area || { w: 0, h: 0 };
    var positions = defaultPositions(items, a.w, a.h);
    var parsed = readStore(storage);
    var savedV = parsed ? (parsed.version || 0) : 0;
    if (parsed && parsed.positions) {
      var shiftX = savedV < 6 ? Math.max(0, a.w - LEGACY_STRIP_W) : 0;
      items.forEach(function (item) {
        var p = parsed.positions[item.id];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          positions[item.id] = clampPosition({ x: p.x + shiftX, y: p.y }, a);
        }
      });
    } else if (parsed && parsed.cells) {
      items.forEach(function (item) {
        var c = parsed.cells[item.id];
        if (c && Number.isFinite(c.col) && Number.isFinite(c.row)) {
          positions[item.id] = clampPosition(cellToXY({ col: c.col, row: c.row }, a.w), a);
        }
      });
    }
    if (parsed && savedV < 8) {
      var dims = gridDims(a.w, a.h);
      var occupied = new Set();
      items.forEach(function (item) {
        var pos = positions[item.id];
        if (!pos) return;
        var want = xyToCell(pos.x, pos.y, a.w, dims);
        var cell = occupied.has(cellKey(want)) ? nearestFreeCell(want, occupied, dims) : want;
        if (!cell) cell = want;
        occupied.add(cellKey(cell));
        positions[item.id] = clampPosition(cellToXY(cell, a.w), a);
      });
    }
    return positions;
  }

  function saveStore(storage, positions, present) {
    if (!storage) return;
    try {
      storage.setItem(PREF_KEY, JSON.stringify({ version: 8, present: present.slice(), positions: positions }));
    } catch (e) {
      console.warn('데스크톱 아이콘 저장 실패:', e);
    }
  }

  function saveLayout(storage, positions) {
    if (!storage) return;
    try {
      var parsed = readStore(storage);
      var present = parsed && Array.isArray(parsed.present) ? parsed.present : Object.keys(positions);
      storage.setItem(PREF_KEY, JSON.stringify({ version: 8, present: present, positions: positions }));
    } catch (e) {
      console.warn('데스크톱 아이콘 배치 저장 실패:', e);
    }
  }

  // ---- 파일 아이콘 (Drive '바탕화면' 폴더의 파일) ----
  function fileGlyph(item) {
    var mime = String((item && item.mime) || '');
    if (mime.indexOf('image/') === 0) return 'image';
    if (mime.indexOf('audio/') === 0) return 'file-audio';
    if (mime.indexOf('video/') === 0) return 'file-video';
    if (mime === 'application/pdf') return 'file-text';
    if (mime.indexOf('spreadsheet') >= 0 || mime.indexOf('ms-excel') >= 0) return 'file-spreadsheet';
    var name = String((item && item.label) || '').toLowerCase();
    var dot = name.lastIndexOf('.');
    var ext = dot >= 0 ? name.slice(dot + 1) : '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].indexOf(ext) >= 0) return 'image';
    if (['xls', 'xlsx', 'csv'].indexOf(ext) >= 0) return 'file-spreadsheet';
    if (['pdf', 'hwp', 'hwpx', 'ppt', 'pptx', 'doc', 'docx', 'txt', 'md'].indexOf(ext) >= 0) return 'file-text';
    if (['mp3', 'wav', 'm4a', 'flac'].indexOf(ext) >= 0) return 'file-audio';
    if (['mp4', 'mov', 'webm', 'mkv'].indexOf(ext) >= 0) return 'file-video';
    return 'file';
  }

  function fileIconsApi() {
    if (typeof window !== 'undefined' && window.MyHubFileIcons) return window.MyHubFileIcons;
    if (typeof globalThis !== 'undefined' && globalThis.MyHubFileIcons) return globalThis.MyHubFileIcons;
    return null;
  }

  function createFileTile(doc, item) {
    var tile = doc.createElement('span');
    tile.className = 'dt-tile dt-tile-file';
    tile.setAttribute('aria-hidden', 'true');
    var icons = fileIconsApi();
    if (icons) {
      tile.classList.add('dt-tile-svg');
      tile.innerHTML = icons.htmlFor({ name: item.label, mime: item.mime });
    } else {
      tile.innerHTML = '<i data-lucide="' + fileGlyph(item) + '"></i>';
    }
    return tile;
  }

  // ---- DOM 매니저 ----
  function createManager(deps) {
    deps = deps || {};
    var layer = deps.layer;
    if (!layer) throw new Error('createDesktopIcons: layer가 필요합니다');
    var tilesApi = deps.tilesApi;
    if (!tilesApi) throw new Error('createDesktopIcons: tilesApi가 필요합니다');
    var doc = layer.ownerDocument || document;
    var allItems = (deps.items || []).slice();
    var storage = deps.storage || null;
    var onOpen = typeof deps.onOpen === 'function' ? deps.onOpen : function () {};
    var dockEl = deps.dockEl || null;
    var onDragToDock = typeof deps.onDragToDock === 'function' ? deps.onDragToDock : null;
    var surface = deps.surface || null;

    function area() {
      if (typeof deps.getArea === 'function') return deps.getArea();
      return { w: layer.clientWidth || 0, h: layer.clientHeight || 0 };
    }
    function itemById(id) {
      for (var i = 0; i < allItems.length; i++) if (allItems[i].id === id) return allItems[i];
      return null;
    }
    function isFileItem(item) {
      return !!item && item.kind === 'file';
    }
    function presentItems() {
      return allItems.filter(function (i) { return present.indexOf(i.id) >= 0; });
    }

    var present = loadPresent(storage, allItems);
    allItems.forEach(function (item) {
      if (isFileItem(item) && present.indexOf(item.id) < 0) present.push(item.id);
    });
    var positions = loadLayout(storage, presentItems(), area());
    var savedStore = readStore(storage);
    var savedPositions = (savedStore && savedStore.positions) || {};
    presentItems().forEach(function (item) {
      if (isFileItem(item) && !savedPositions[item.id]) {
        positions[item.id] = firstFreePosition();
      }
    });
    var records = new Map(); // id -> { item, el }
    var selection = new Set();
    var selectedId = null;
    var drag = null;
    var band = null;

    // rAF·위치 공용 코어 (anim.js, F-L13) — 호출 시점에 해석한다.
    function animCore() {
      return (
        (typeof window !== 'undefined' && window.MyHubAnim) ||
        (typeof globalThis !== 'undefined' && globalThis.MyHubAnim) ||
        null
      );
    }
    function raf(fn) {
      var core = animCore();
      if (!core) throw new Error('[desktop-icons.js] anim.js가 먼저 로드되어야 합니다');
      return core.raf(fn);
    }
    function cancelRaf(id) {
      var core = animCore();
      if (!core) throw new Error('[desktop-icons.js] anim.js가 먼저 로드되어야 합니다');
      return core.cancelRaf(id);
    }
    function copyPositions(map) {
      var core = animCore();
      if (!core) throw new Error('[desktop-icons.js] anim.js가 먼저 로드되어야 합니다');
      return core.copyPositions(map);
    }
    var destroyed = false;
    var lastTap = null; // 더블탭 열기 추적 { id, time }
    var lastFired = {}; // id -> 400ms 중복 가능

    function fireOpen(item) {
      if (!item) return;
      var now = Date.now();
      if (lastFired[item.id] && now - lastFired[item.id] < 400) return;
      lastFired[item.id] = now;
      if (item.href) window.location.assign(item.href);
      else onOpen(item.id);
    }

    function persist() {
      saveStore(storage, positions, present);
    }

    function positionIcon(id) {
      var rec = records.get(id);
      if (!rec || !positions[id]) return;
      rec.el.style.left = positions[id].x + 'px';
      rec.el.style.top = positions[id].y + 'px';
    }

    function firstFreePosition() {
      var a = area();
      var d = gridDims(a.w, a.h);
      var taken = [];
      present.forEach(function (id) { if (positions[id]) taken.push(positions[id]); });
      for (var row = 0; row < d.rows; row++) {
        for (var col = 0; col < d.cols; col++) {
          var cand = clampPosition(cellToXY({ col: col, row: row }, a.w), a);
          if (!taken.some(function (p) { return boxesOverlap(cand, p); })) return cand;
        }
      }
      for (var n = 0; n < 40; n++) {
        var c2 = clampPosition({ x: 10 + n * 28, y: 10 + n * 28 }, a);
        if (!taken.some(function (p) { return boxesOverlap(c2, p); })) return c2;
      }
      return clampPosition({ x: cellToXY({ col: 0, row: 0 }, a.w).x, y: Math.max(10, a.h - ICON_H) }, a);
    }

    function buildIcon(item) {
      var el = doc.createElement('button');
      el.type = 'button';
      el.className = 'dt-desk-icon';
      el.dataset.module = item.id;
      el.setAttribute('aria-label', item.label);
      if (isFileItem(item)) {
        el.classList.add('is-file');
        el.dataset.fileId = String(item.fileId);
        el.appendChild(createFileTile(doc, item));
      } else {
        el.appendChild(tilesApi.createTile(doc, item.id));
      }
      var label = doc.createElement('span');
      label.className = 'dt-desk-label';
      label.textContent = item.label;
      el.appendChild(label);

      el.addEventListener('pointerdown', function (e) {
        if (e.preventDefault) e.preventDefault();
        if (band) finishBand();
        var inGroup = selection.has(item.id) && selection.size > 1;
        if (!inGroup) select(item.id);
        var ids = inGroup ? Array.from(selection) : [item.id];
        var starts = {};
        var els = {};
        ids.forEach(function (id) {
          var rec = records.get(id);
          if (!rec || !positions[id]) return;
          starts[id] = { x: positions[id].x, y: positions[id].y };
          els[id] = rec.el;
          rec.el.classList.add('is-dragging');
        });
        drag = {
          id: item.id, ids: Object.keys(starts), starts: starts, els: els,
          group: inGroup, pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY, dx: 0, dy: 0,
          moved: false, overRemove: false, overDock: false,
          rafId: null, lastX: e.clientX, lastY: e.clientY,
          // 드롭 타깃 판정용 rect를 드래그 시작 시 캐시한다 — move마다
          // getBoundingClientRect를 읽으면 레이아웃 스래싱이 일어난다.
          trashRect: rectOf(typeof deps.getTrashEl === 'function' ? deps.getTrashEl() : deps.trashEl),
          dockRect: onDragToDock ? rectOf(dockEl) : null,
        };
      });
      el.addEventListener('dblclick', function () {
        fireOpen(item);
      });
      // 오피스 앱 호버 프리패치 (2026-11-12 오피스 성능 점검): 바탕화면
      // 아이콘에 마우스를 올리면 해당 앱의 WASM을 미리 받아 둔다.
      el.addEventListener('mouseenter', function () {
        var pre = typeof window !== 'undefined' ? window.MyHubOfficePrefetch : null;
        if (pre && typeof pre.prefetch === 'function') pre.prefetch(item.id);
      });
      el.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openIconMenu(item, e.clientX, e.clientY);
      });
      layer.appendChild(el);
      records.set(item.id, { item: item, el: el });
      positionIcon(item.id);
      if (tilesApi.refreshIcons) tilesApi.refreshIcons();
    }

    presentItems().forEach(buildIcon);

    function applySelection() {
      records.forEach(function (rec, rid) {
        rec.el.classList.toggle('is-selected', selection.has(rid));
      });
    }

    function select(id) {
      selection = new Set([id]);
      selectedId = id;
      applySelection();
    }

    function setSelection(ids, primaryId) {
      selection = new Set(ids);
      selectedId = primaryId || (ids.length ? ids[ids.length - 1] : null);
      applySelection();
    }

    function clearSelection() {
      selection = new Set();
      selectedId = null;
      applySelection();
    }

    function arrange() {
      var a = area();
      var d = gridDims(a.w, a.h);
      var orderedIds = present.slice().sort(function (p, q) {
        var pp = positions[p] || { x: 0, y: 0 };
        var qp = positions[q] || { x: 0, y: 0 };
        var pc = xyToCell(pp.x, pp.y, a.w, d);
        var qc = xyToCell(qp.x, qp.y, a.w, d);
        if (pc.row !== qc.row) return pc.row - qc.row;
        if (pc.col !== qc.col) return pc.col - qc.col;
        if (pp.y !== qp.y) return pp.y - qp.y;
        return pp.x - qp.x;
      });
      var changed = false;
      var overflow = orderedIds.length > d.rows * d.cols;
      var colX = clampPosition(cellToXY({ col: 0, row: 0 }, a.w), a).x;
      var topY = 10;
      var maxY = Math.max(topY, a.h - (TILE + 26));
      var stepY = orderedIds.length > 1 ? (maxY - topY) / (orderedIds.length - 1) : 0;
      orderedIds.forEach(function (id, i) {
        var np;
        if (overflow) {
          np = clampPosition({ x: colX, y: Math.round(topY + stepY * i) }, a);
        } else {
          var slot = { col: i % d.cols, row: Math.floor(i / d.cols) };
          np = clampPosition(cellToXY(slot, a.w), a);
        }
        if (!positions[id] || positions[id].x !== np.x || positions[id].y !== np.y) changed = true;
        positions[id] = np;
        positionIcon(id);
      });
      if (changed) persist();
    }

    function addItem(id) {
      var item = itemById(id);
      if (!item || present.indexOf(id) >= 0) return;
      present.push(id);
      positions[id] = firstFreePosition();
      buildIcon(item);
      persist();
    }

    function registerItems(newItems) {
      var added = [];
      (newItems || []).forEach(function (item) {
        if (!item || !item.id || itemById(item.id)) return;
        allItems.push(item);
        added.push(item.id);
      });
      return added;
    }

    function removeItem(id) {
      var idx = present.indexOf(id);
      if (idx < 0) return;
      present.splice(idx, 1);
      var rec = records.get(id);
      if (rec) {
        rec.el.remove();
        records.delete(id);
      }
      delete positions[id];
      selection.delete(id);
      if (selectedId === id) selectedId = null;
      persist();
    }

    function trashRemove(ids) {
      var entries = [];
      ids.slice().forEach(function (id) {
        var item = itemById(id);
        entries.push({ kind: 'icon', id: id, label: item ? item.label : id });
        removeItem(id);
      });
      if (typeof deps.onTrashed === 'function') deps.onTrashed(entries);
    }

    // ---- 우클릭 메뉴 ----
    var iconMenu = null;
    function openIconMenu(item, x, y) {
      var api = deps.menuApi || (typeof window !== 'undefined' ? window.MyHubDesktopMenu : null);
      if (!api) return;
      if (!iconMenu) {
        iconMenu = api.createMenu(doc, {
          refreshIcons: tilesApi.refreshIcons ? tilesApi.refreshIcons : undefined,
        });
      }
      if (isFileItem(item)) {
        iconMenu.open(x, y, [
          {
            label: '열기', icon: 'arrow-up-right',
            onSelect: function () { fireOpen(item); },
          },
          { separator: true },
          {
            label: '내장함으로 이동', icon: 'trash-2', danger: true,
            onSelect: function () {
              if (typeof deps.onFileTrash === 'function') deps.onFileTrash(item);
            },
          },
        ]);
        return;
      }
      var targetIds = selection.has(item.id) && selection.size > 1
        ? Array.from(selection)
        : [item.id];
      var menuItems = [
        {
          label: '열기', icon: 'arrow-up-right',
          onSelect: function () { fireOpen(item); },
        },
      ];
      if (onDragToDock) {
        menuItems.push({
          label: '독에 추가', icon: 'dock',
          onSelect: function () {
            targetIds.forEach(function (id) { onDragToDock(id); });
          },
        });
      }
      menuItems.push({ separator: true });
      menuItems.push({
        label: targetIds.length > 1 ? '내장함으로 이동 (' + targetIds.length + '개)' : '내장함으로 이동',
        icon: 'trash-2', danger: true,
        onSelect: function () { trashRemove(targetIds); },
      });
      iconMenu.open(x, y, menuItems);
    }

    // ---- 드래그 (이동/제거/독 추가) ----
    function hitTest(el, x, y) {
      if (!el || el.hidden) return false;
      var r = el.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return false;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    // rect를 한 번 읽어 캐시용 plain 객체로 만든다 (드래그 시작 시 사용).
    function rectOf(el) {
      if (!el || el.hidden) return null;
      var r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (!r || (r.width === 0 && r.height === 0)) return null;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    function hitRect(r, x, y) {
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    function setDragTargets(s, x, y) {
      var trashEl = typeof deps.getTrashEl === 'function' ? deps.getTrashEl() : deps.trashEl;
      // 캐시한 rect가 있으면 그걸 쓰고, 없으면(구 경로) live로 읽는다.
      s.overTrash = s.trashRect !== undefined ? hitRect(s.trashRect, x, y) : hitTest(trashEl, x, y);
      s.trashEl = trashEl || null;
      s.overDock = onDragToDock ? (s.dockRect !== undefined ? hitRect(s.dockRect, x, y) : hitTest(dockEl, x, y)) : false;
      if (dockEl) dockEl.classList.toggle('dt-dock-drop-hot', s.overDock && !s.overTrash);
      if (s.trashEl) s.trashEl.classList.toggle('dt-trash-hot', s.overTrash);
    }

    function clearDragTargets() {
      if (dockEl) dockEl.classList.remove('dt-dock-drop-hot');
      var trashEl = typeof deps.getTrashEl === 'function' ? deps.getTrashEl() : deps.trashEl;
      if (trashEl) trashEl.classList.remove('dt-trash-hot');
    }

    function setDragPerf(on) {
      void on;
    }

    // 아이콘 이동·영역 선택도 창 이동과 같은 이유로 rAF로 합친다:
    // move 이벤트마다 transform을 직접 쓰고 휴지통·독 rect를 읽으면
    // 한 프레임에 여러 번 스타일 재계산·레이아웃이 일어난다.
    // 영역 선택은 아이콘마다 getBoundingClientRect를 읽던 것을 밴드
    // 시작 시 한 번 캐시한 rect로 바꾼다 (선택 중 아이콘은 안 움직인다).
    // (2026-11-12 성능 점검에서 발견한 어설픈 코드)
    function applyIconFrame() {
      var s = drag;
      if (!s) return;
      s.rafId = null;
      if (!s.moved) return;
      s.ids.forEach(function (id) {
        s.els[id].style.transform = 'translate(' + s.dx + 'px,' + s.dy + 'px)';
      });
      setDragTargets(s, s.lastX, s.lastY);
    }
    function applyBandFrame() {
      var b = band;
      if (!b) return;
      b.rafId = null;
      updateBand(b.lastX, b.lastY);
    }
    function onPointerMove(e) {
      if (band) {
        if (band.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== band.pointerId) return;
        band.lastX = e.clientX;
        band.lastY = e.clientY;
        if (band.rafId === null || band.rafId === undefined) {
          band.rafId = raf(applyBandFrame);
        }
        return;
      }
      if (!drag) return;
      if (drag.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
      drag.dx = e.clientX - drag.startX;
      drag.dy = e.clientY - drag.startY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (Math.abs(drag.dx) > DRAG_THRESHOLD || Math.abs(drag.dy) > DRAG_THRESHOLD) drag.moved = true;
      if (drag.moved) {
        setDragPerf(true);
        if (drag.rafId === null || drag.rafId === undefined) {
          drag.rafId = raf(applyIconFrame);
        }
      }
    }

    function onPointerUp(e) {
      if (band) {
        if (band.rafId !== null && band.rafId !== undefined) {
          cancelRaf(band.rafId);
          band.rafId = null;
          applyBandFrame();
        }
        finishBand();
        return;
      }
      if (!drag) return;
      if (drag.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
      var s = drag;
      if (s.rafId !== null && s.rafId !== undefined) {
        cancelRaf(s.rafId);
        s.rafId = null;
        // 대기 중이던 마지막 move 프레임을 동기 반영해 드롭 판정이
        // pointerup 직전 최신 좌표를 쓰게 한다 (drag를 null로 하기 전).
        applyIconFrame();
      }
      drag = null;
      setDragPerf(false);
      s.ids.forEach(function (id) {
        s.els[id].classList.remove('is-dragging');
        s.els[id].style.transform = '';
      });
      var toTrash = s.moved && s.overTrash;
      var toDock = s.moved && s.overDock && !toTrash;
      clearDragTargets();
      if (toTrash) {
        var appIds = s.ids.filter(function (id) {
          var it = itemById(id);
          return it && !isFileItem(it);
        });
        if (appIds.length) trashRemove(appIds);
        if (appIds.length === s.ids.length) return;
        toDock = false;
      }
      if (s.moved) {
        var a = area();
        var dims = gridDims(a.w, a.h);
        var occupied = new Set();
        present.forEach(function (id) {
          if (s.ids.indexOf(id) >= 0 || !positions[id]) return;
          occupied.add(cellKey(xyToCell(positions[id].x, positions[id].y, a.w, dims)));
        });
        s.ids.forEach(function (id) {
          if (present.indexOf(id) < 0) return;
          if (!s.starts[id]) return;
          var raw = { x: s.starts[id].x + s.dx, y: s.starts[id].y + s.dy };
          var want = xyToCell(raw.x, raw.y, a.w, dims);
          var cell = occupied.has(cellKey(want)) ? nearestFreeCell(want, occupied, dims) : want;
          if (!cell) cell = want;
          occupied.add(cellKey(cell));
          positions[id] = clampPosition(cellToXY(cell, a.w), a);
        });
        persist();
      } else {
        if (s.group) {
          select(s.id);
        }
        var tapNow = Date.now();
        if (lastTap && lastTap.id === s.id && tapNow - lastTap.time <= 350) {
          lastTap = null;
          fireOpen(itemById(s.id));
        } else {
          lastTap = { id: s.id, time: tapNow };
        }
      }
      s.ids.forEach(function (id) { positionIcon(id); });
      if (toDock && onDragToDock) {
        s.ids.forEach(function (id) {
          var it = itemById(id);
          if (it && !isFileItem(it)) onDragToDock(id);
        });
      }
    }

    // ---- 영역 선택 (오버밴드) ----
    function iconClientRect(id) {
      var rec = records.get(id);
      if (!rec) return null;
      var r = typeof rec.el.getBoundingClientRect === 'function' ? rec.el.getBoundingClientRect() : null;
      if (r && (r.width > 0 || r.height > 0)) {
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
      var lr = layer.getBoundingClientRect ? layer.getBoundingClientRect() : { left: 0, top: 0 };
      var pos = positions[id] || { x: 0, y: 0 };
      return {
        left: (lr.left || 0) + pos.x, top: (lr.top || 0) + pos.y,
        right: (lr.left || 0) + pos.x + TILE, bottom: (lr.top || 0) + pos.y + ICON_H,
      };
    }

    function startBand(e) {
      if (e.button !== undefined && e.button !== 0) return;
      var additive = !!e.shiftKey;
      // 아이콘 rect를 밴드 시작 시 한 번 캐시한다 — move마다 아이콘
      // 전부에 getBoundingClientRect를 호출하면 레이아웃 스래싱이다.
      // 선택 중에는 아이콘이 움직이지 않으므로 캐시가 유효하다.
      var iconRects = new Map();
      records.forEach(function (rec, id) {
        var r = iconClientRect(id);
        if (r) iconRects.set(id, r);
      });
      band = {
        pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        base: additive ? new Set(selection) : new Set(),
        el: null,
        lastX: e.clientX, lastY: e.clientY, rafId: null,
        iconRects: iconRects,
      };
      if (!additive) clearSelection();
    }

    function updateBand(x, y) {
      if (!band) return;
      if (!band.el) {
        if (Math.abs(x - band.startX) < 3 && Math.abs(y - band.startY) < 3) return;
        band.el = doc.createElement('div');
        band.el.className = 'dt-select-band';
        doc.body.appendChild(band.el);
      }
      var left = Math.min(band.startX, x);
      var top = Math.min(band.startY, y);
      var w = Math.abs(x - band.startX);
      var h = Math.abs(y - band.startY);
      band.el.style.left = left + 'px';
      band.el.style.top = top + 'px';
      band.el.style.width = w + 'px';
      band.el.style.height = h + 'px';
      var hits = [];
      var rects = band.iconRects || null;
      records.forEach(function (rec, id) {
        var r = rects ? rects.get(id) : iconClientRect(id);
        if (r && r.left < left + w && r.right > left && r.top < top + h && r.bottom > top) {
          hits.push(id);
        }
      });
      var merged = Array.from(band.base);
      hits.forEach(function (id) { if (merged.indexOf(id) < 0) merged.push(id); });
      setSelection(merged, hits.length ? hits[hits.length - 1] : null);
    }

    function finishBand() {
      if (band && band.rafId !== null && band.rafId !== undefined) {
        cancelRaf(band.rafId);
        band.rafId = null;
      }
      if (band && band.el) band.el.remove();
      band = null;
    }

    function onSurfacePointerDown(e) {
      if (destroyed) return;
      if (e.target !== surface) return;
      startBand(e);
    }
    if (surface) surface.addEventListener('pointerdown', onSurfacePointerDown);

    function onWindowBlur() {
      finishBand();
    }
    if (typeof window !== 'undefined') window.addEventListener('blur', onWindowBlur);

    doc.addEventListener('pointermove', onPointerMove);
    doc.addEventListener('pointerup', onPointerUp);
    doc.addEventListener('pointercancel', onPointerUp);

    function onResize() {
      if (destroyed) return;
      var a = area();
      var changed = false;
      present.forEach(function (id) {
        if (!positions[id]) return;
        var clamped = clampPosition(positions[id], a);
        if (clamped.x !== positions[id].x || clamped.y !== positions[id].y) changed = true;
        positions[id] = clamped;
        positionIcon(id);
      });
      if (changed) persist();
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

    if (tilesApi.refreshIcons) tilesApi.refreshIcons();

    function destroy() {
      destroyed = true;
      setDragPerf(false);
      finishBand();
      if (surface) surface.removeEventListener('pointerdown', onSurfacePointerDown);
      doc.removeEventListener('pointermove', onPointerMove);
      doc.removeEventListener('pointerup', onPointerUp);
      doc.removeEventListener('pointercancel', onPointerUp);
      if (typeof window !== 'undefined') window.removeEventListener('blur', onWindowBlur);
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      records.forEach(function (rec) { rec.el.remove(); });
      records.clear();
    }

    return {
      getPositions: function () {
        return copyPositions(positions);
      },
      getPresentIds: function () { return present.slice(); },
      addItem: addItem,
      registerItems: registerItems,
      removeItem: removeItem,
      arrange: arrange,
      clearSelection: clearSelection,
      getSelectedId: function () { return selectedId; },
      getSelectedIds: function () { return Array.from(selection); },
      relayout: onResize,
      destroy: destroy,
    };
  }

  var api = {
    PREF_KEY: PREF_KEY,
    CELL_W: CELL_W,
    CELL_H: CELL_H,
    TILE: TILE,
    gridDims: gridDims,
    clampCell: clampCell,
    nearestFreeCell: nearestFreeCell,
    cellToXY: cellToXY,
    xyToCell: xyToCell,
    snapXY: snapXY,
    loadLayout: loadLayout,
    saveLayout: saveLayout,
    loadPresent: loadPresent,
    fileGlyph: fileGlyph,
    createManager: createManager,
  };
  if (typeof window !== 'undefined') window.MyHubDesktopIcons = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopIcons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
