/* MyHub 바탕화면 아이콘 — 격자 스냅 배치 (D-14 최종 계약).
 *
 * 재구성 근거: 아이콘은 왼쪽 위·행 우선 격자에 스냅한다 (2026-11-02 자유 배치
 * 폐기). 드롭 시 가장 가까운 셀, 차 있으면 가장 가까운 빈 셀(nearestFreeCell).
 * 저장 포맷 v8 — v<8 자유 좌표는 읽을 때 격자로 접힌다. 선택은 Set 모델,
 * 선택 중 하나를 끌면 그룹 전체 이동. 제거 영역(dt-remove-zone)은 최종
 * 상태에서 전면 제거됨 — 삭제는 우클릭 메뉴·독 휴지통 드롭으로만.
 * 휴지통 공유 키 'myhub.desktop.trash.v1' (독 배지·Finder 휴지통 보기가 함께 읽음).
 * 파일 타일은 file-icons htmlFor 사용, 모듈 부재 시 Lucide 폴백.
 *
 * 노출: window.MyHubDesktopIcons + module.exports
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'myhub.desktop.icons.v1';
  var TRASH_KEY = 'myhub.desktop.trash.v1';
  var FORMAT_VERSION = 8;
  var CELL_W = 96;
  var CELL_H = 108;
  var ORIGIN_X = 14;
  var ORIGIN_Y = 12;

  var DEFAULT_APPS = ['finder', 'browser', 'memo', 'schedule', 'todo', 'chat',
    'studio', 'excel', 'hangul', 'powerpoint', 'pdf'];

  function cellToXY(cell) {
    return { x: ORIGIN_X + cell.c * CELL_W, y: ORIGIN_Y + cell.r * CELL_H };
  }

  function xyToCell(x, y) {
    return {
      c: Math.max(0, Math.round((x - ORIGIN_X) / CELL_W)),
      r: Math.max(0, Math.round((y - ORIGIN_Y) / CELL_H)),
    };
  }

  function cellKey(c, r) { return c + ',' + r; }

  /** 셀이 정해지지 않은 항목의 기본 자리: 열이 차면 다음 열로 흐른다.
   * maxRows(화면에 닿는 행 수)가 있으면 열 우선 흐름 배치, 없으면
   * 구 계약(첫 열에 순서대로) — 2026-11-08 넘침 수정. */
  function indexCell(idx, maxRows) {
    if (typeof maxRows === 'number' && maxRows > 0) {
      return { c: Math.floor(idx / maxRows), r: idx % maxRows };
    }
    return { c: 0, r: idx };
  }

  /** 열 우선 순서로 첫 빈 셀 (r < maxRows 범위 안에서만). */
  function firstFlowFreeCell(occupied, maxRows) {
    for (var c = 0; c < 64; c++) {
      for (var r = 0; r < maxRows; r++) {
        if (!occupied[cellKey(c, r)]) return { c: c, r: r };
      }
    }
    return null;
  }

  /** 원하는 셀에서 가장 가까운 빈 셀 (동심 확장 탐색). */
  function nearestFreeCell(occupied, want) {
    if (!occupied[cellKey(want.c, want.r)]) return { c: want.c, r: want.r };
    for (var ring = 1; ring < 64; ring++) {
      var best = null, bestDist = Infinity;
      for (var dc = -ring; dc <= ring; dc++) {
        for (var dr = -ring; dr <= ring; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          var c = want.c + dc, r = want.r + dr;
          if (c < 0 || r < 0) continue;
          if (occupied[cellKey(c, r)]) continue;
          var d = dc * dc + dr * dr;
          if (d < bestDist) { bestDist = d; best = { c: c, r: r }; }
        }
      }
      if (best) return best;
    }
    return { c: want.c, r: want.r };
  }

  function loadTrash(storage) {
    try {
      var raw = JSON.parse(storage.getItem(TRASH_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }

  function saveTrash(storage, items) {
    storage.setItem(TRASH_KEY, JSON.stringify(items));
  }

  /** 저장값을 v8 격자 포맷으로 접는다.
   * opts.maxRows가 있으면 셀이 없는 항목을 열 우선 흐름으로 배치한다
   * (한 열에 다 쌓아 화면 아래로 넘치던 결함 수정). 명시 셀은 그대로
   * 존중한다 — 화면 밖 셀의 복구는 createIcons의 도달성 복구가 맡는다. */
  function migrateItems(raw, opts) {
    var maxRows = opts && typeof opts.maxRows === 'number' ? opts.maxRows : 0;
    var items = [];
    var occupied = {};
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.items)) list = raw.items;
    if (!list.length) {
      DEFAULT_APPS.forEach(function (id) { list.push({ kind: 'app', id: id }); });
    }
    list.forEach(function (it, idx) {
      if (!it || !it.id) return;
      var cell;
      if (it.cell && typeof it.cell.c === 'number') cell = { c: it.cell.c, r: it.cell.r };
      else if (typeof it.x === 'number' && typeof it.y === 'number') cell = xyToCell(it.x, it.y);
      else cell = indexCell(idx, maxRows);
      cell = nearestFreeCell(occupied, cell);
      occupied[cellKey(cell.c, cell.r)] = true;
      items.push({
        kind: it.kind === 'file' ? 'file' : 'app',
        id: it.id, name: it.name || null, mime: it.mime || null,
        cell: cell,
      });
    });
    return items;
  }

  function loadItems(storage, opts) {
    var raw = null;
    try { raw = JSON.parse(storage.getItem(STORAGE_KEY) || 'null'); }
    catch (e) { raw = null; }
    return migrateItems(raw, opts);
  }

  function saveItems(storage, items) {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: FORMAT_VERSION, items: items }));
  }

  function createIcons(deps) {
    var layer = deps.layer;
    var doc = layer.ownerDocument;
    var storage = deps.storage;
    var tiles = deps.tiles;

    /* 화면에 닿는 행 수: 레이어 높이에서 독 존(실측 높이, 최소 72 + 여유
     * 28)을 뺀 영역에 아이콘 실높이(약 80px)까지 들어가는 행 수.
     * 레이어 높이를 모르면 0 (무제한 — 구 계약). */
    function currentMaxRows() {
      var h = layer.clientHeight || 0;
      if (!h) return 0;
      var tb = doc.getElementById('dt-taskbar');
      var reserve = Math.max(tb ? tb.offsetHeight : 0, 72) + 28;
      var rows = Math.floor((h - reserve - ORIGIN_Y - 80) / CELL_H) + 1;
      return Math.max(1, rows);
    }

    var items = loadItems(storage, { maxRows: currentMaxRows() });
    var selected = {}; // id → true (Set 모델)
    var nodes = {};

    function keyOf(item) { return item.kind + ':' + item.id; }

    function persist() { saveItems(storage, items); }

    /* 도달성 복구: 구 상태 그대로 저장된 화면 밖 셀(r >= maxRows)을 열
     * 우선 첫 빈 셀로 끌어올린다. 닿는 셀은 사용자 배치라 그대로 둔다. */
    (function repairOutOfReach() {
      var mr = currentMaxRows();
      if (!mr) return;
      var occupied = {};
      items.forEach(function (it) {
        if (it.cell.r < mr) occupied[cellKey(it.cell.c, it.cell.r)] = true;
      });
      var changed = false;
      items.forEach(function (it) {
        if (it.cell.r < mr) return;
        var cell = firstFlowFreeCell(occupied, mr);
        if (!cell) return;
        occupied[cellKey(cell.c, cell.r)] = true;
        it.cell = cell;
        changed = true;
      });
      if (changed) persist();
    })();

    function el(tag, cls) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    function renderItem(item) {
      var node = el('div', 'dt-icon');
      node.dataset.key = keyOf(item);
      var pos = cellToXY(item.cell);
      node.style.left = pos.x + 'px';
      node.style.top = pos.y + 'px';
      var tileWrap = el('span', 'dt-icon-tile');
      if (item.kind === 'file') {
        tileWrap.classList.add('dt-tile-file');
        var fi = deps.fileIcons;
        if (fi) tileWrap.innerHTML = fi.htmlFor({ name: item.name, mime: item.mime });
        else tileWrap.innerHTML = '<i data-lucide="file"></i>';
      } else {
        var tile = tiles.createTile(item.id, { document: doc });
        if (tile) tileWrap.appendChild(tile);
      }
      node.appendChild(tileWrap);
      var label = el('span', 'dt-icon-label');
      label.textContent = item.kind === 'file' ? (item.name || item.id) : (deps.titleOf ? deps.titleOf(item.id) : item.id);
      node.appendChild(label);
      if (selected[keyOf(item)]) node.classList.add('is-selected');
      attachPointer(node, item);
      node.addEventListener('dblclick', function () { if (deps.onOpen) deps.onOpen(item); });
      node.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (deps.onContextMenu) deps.onContextMenu(item, ev, getSelectedItems());
      });
      nodes[keyOf(item)] = node;
      return node;
    }

    function render() {
      layer.innerHTML = '';
      nodes = {};
      items.forEach(function (item) { layer.appendChild(renderItem(item)); });
      tiles.refreshIcons(layer);
    }

    function getSelectedItems() {
      return items.filter(function (it) { return selected[keyOf(it)]; });
    }

    function getSelectedIds() {
      return getSelectedItems().map(function (it) { return it.id; });
    }

    function clearSelection() {
      selected = {};
      Object.keys(nodes).forEach(function (k) { nodes[k].classList.remove('is-selected'); });
    }

    function selectInRect(rect) {
      var changed = false;
      items.forEach(function (item) {
        var pos = cellToXY(item.cell);
        var hit = pos.x + CELL_W > rect.x && pos.x < rect.x + rect.w &&
          pos.y + CELL_H > rect.y && pos.y < rect.y + rect.h;
        var k = keyOf(item);
        if (hit && !selected[k]) { selected[k] = true; changed = true; }
        if (changed && nodes[k]) nodes[k].classList.toggle('is-selected', !!selected[k]);
      });
      return getSelectedItems();
    }

    /* 포인터 드래그: transform으로 1:1 추종, 놓으면 격자 스냅.
       선택된 것을 잡으면 그룹 전체가 함께 움직인다. */
    function attachPointer(node, item) {
      node.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        var k = keyOf(item);
        if (!ev.metaKey && !ev.ctrlKey) {
          if (!selected[k]) { clearSelection(); selected[k] = true; node.classList.add('is-selected'); }
        } else {
          selected[k] = !selected[k];
          node.classList.toggle('is-selected', !!selected[k]);
          if (!selected[k]) return;
        }
        var group = getSelectedItems();
        var startX = ev.clientX, startY = ev.clientY;
        var moved = false;
        var starts = group.map(function (it) {
          var p = cellToXY(it.cell);
          return { item: it, x: p.x, y: p.y, node: nodes[keyOf(it)] };
        });
        function onMove(e2) {
          var dx = e2.clientX - startX, dy = e2.clientY - startY;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          starts.forEach(function (s) {
            if (s.node) s.node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          });
          if (deps.onDragMove) deps.onDragMove(e2, group);
        }
        function onUp(e2) {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          starts.forEach(function (s) { if (s.node) s.node.style.transform = ''; });
          if (!moved) {
            // 안 끌고 놓으면 잡은 것만 선택
            clearSelection();
            selected[k] = true;
            node.classList.add('is-selected');
            return;
          }
          if (deps.onDropCheck && deps.onDropCheck(e2, group)) { render(); return; }
          var occupied = {};
          items.forEach(function (it) {
            if (group.indexOf(it) < 0) occupied[cellKey(it.cell.c, it.cell.r)] = true;
          });
          var mr = currentMaxRows();
          starts.forEach(function (s) {
            var want = xyToCell(s.x + (e2.clientX - startX), s.y + (e2.clientY - startY));
            if (mr) want.r = Math.min(want.r, mr - 1);
            var cell = nearestFreeCell(occupied, want);
            occupied[cellKey(cell.c, cell.r)] = true;
            s.item.cell = cell;
          });
          persist();
          render();
          if (deps.onChange) deps.onChange(items);
        }
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
      });
    }

    function addItem(item) {
      var occupied = {};
      items.forEach(function (it) { occupied[cellKey(it.cell.c, it.cell.r)] = true; });
      var mr = currentMaxRows();
      var want = item.cell || null;
      if (mr && want && want.r >= mr) want = null; // 화면 밖 셀은 흐름 배치로
      var cell = want ? nearestFreeCell(occupied, want)
        : (mr && firstFlowFreeCell(occupied, mr)) || nearestFreeCell(occupied, { c: 0, r: 0 });
      items.push({ kind: item.kind || 'app', id: item.id, name: item.name || null, mime: item.mime || null, cell: cell });
      persist(); render();
      if (deps.onChange) deps.onChange(items);
    }

    function removeItems(targets) {
      var keys = {};
      targets.forEach(function (it) { keys[keyOf(it)] = true; });
      items = items.filter(function (it) { return !keys[keyOf(it)]; });
      persist(); render();
      if (deps.onChange) deps.onChange(items);
    }

    /** 휴지통으로 이동: 공유 키에 쌓고 바탕화면에서 제거한다. */
    function trashItems(targets) {
      var trash = loadTrash(storage);
      targets.forEach(function (it) { trash.push(it); });
      saveTrash(storage, trash);
      removeItems(targets);
      return trash.length;
    }

    /** 휴지통 항목 조회 (Finder 휴지통 보기가 공유 키와 함께 읽는 공용 경로). */
    function getTrashItems() { return loadTrash(storage).slice(); }

    /** 휴지통 전체 영구 삭제. */
    function purgeAllTrash() { saveTrash(storage, []); }

    /** 휴지통 단건 영구 삭제 (Finder 휴지통 보기의 삭제 처리). */
    function purgeFromTrash(predicate) {
      saveTrash(storage, loadTrash(storage).filter(function (it) { return !predicate(it); }));
    }

    /** 휴지통에서 복원 (Finder 휴지통 보기·독 패널 공용 경로). */
    function restoreFromTrash(predicate) {
      var trash = loadTrash(storage);
      var restored = [];
      var kept = [];
      trash.forEach(function (it) {
        if (predicate(it)) restored.push(it); else kept.push(it);
      });
      saveTrash(storage, kept);
      restored.forEach(function (it) { addItem(it); });
      return restored.length;
    }

    return {
      render: render,
      getItems: function () { return items.slice(); },
      addItem: addItem,
      removeItems: removeItems,
      trashItems: trashItems,
      restoreFromTrash: restoreFromTrash,
      getTrashItems: getTrashItems,
      purgeAllTrash: purgeAllTrash,
      purgeFromTrash: purgeFromTrash,
      getSelectedItems: getSelectedItems,
      getSelectedIds: getSelectedIds,
      selectInRect: selectInRect,
      clearSelection: clearSelection,
      getTrashCount: function () { return loadTrash(storage).length; },
    };
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY, TRASH_KEY: TRASH_KEY,
    FORMAT_VERSION: FORMAT_VERSION,
    CELL_W: CELL_W, CELL_H: CELL_H,
    cellToXY: cellToXY, xyToCell: xyToCell, nearestFreeCell: nearestFreeCell,
    indexCell: indexCell, firstFlowFreeCell: firstFlowFreeCell,
    loadTrash: loadTrash, saveTrash: saveTrash,
    loadItems: loadItems, saveItems: saveItems, migrateItems: migrateItems,
    createIcons: createIcons,
  };

  if (typeof window !== 'undefined') window.MyHubDesktopIcons = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopIcons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
