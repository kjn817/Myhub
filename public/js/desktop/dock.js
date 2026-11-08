/* MyHub 데스크톱 독 — macOS 독 계약.
 *
 * 재구성 근거: 타일 48px·간격 10px·독 존 96px, 피시아이 없음(사용자 지시로 제거),
 * loadDockIds/saveDockIds 버전 마이그레이션(v2 미션 1회 삽입·v3 Finder 선두·
 * v4 브라우저·v5 오피스 4종을 browser 뒤에 1회 삽입, 이후 사용자 제거 존중),
 * 독 안 드래그 순서 변경(reorderable + onReorder, 구분선도 함께 이동,
 * 독 밖 드래그 제거가 우선) — D-14, 최근 앱 최대 3개(우측 구역,
 * 'myhub.desktop.recents.v1'), 휴지통 우측 상주 + 개수 배지,
 * 우클릭 메뉴(열기·제거/고정, Finder 제거 불가).
 *
 * 노출: window.MyHubDesktopDock + module.exports
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'myhub.desktop.dock.v1';
  var RECENTS_KEY = 'myhub.desktop.recents.v1';
  var FORMAT_VERSION = 6;

  // 원본 독 구성: Finder·브라우저·메모·일정·할 일·AI 채팅·AI 스튜디오·
  // Excel·한글·PowerPoint·PDF (이후 구분선·설정·휴지통은 render가 붙인다)
  var DEFAULT_IDS = ['finder', 'browser', 'memo', 'schedule', 'todo', 'chat',
    'studio', 'excel', 'hangul', 'powerpoint', 'pdf'];

  function insertAfter(ids, anchor, additions) {
    var out = ids.slice();
    var pos = out.indexOf(anchor);
    pos = pos < 0 ? out.length : pos + 1;
    additions.forEach(function (id) {
      if (out.indexOf(id) < 0) { out.splice(pos, 0, id); pos++; }
    });
    return out;
  }

  /** 저장값을 현재 포맷으로 마이그레이션한다 (전부 1회성·additive). */
  function migrateDockIds(raw) {
    var ids;
    var version = 0;
    if (Array.isArray(raw)) { ids = raw.slice(); version = 1; }
    else if (raw && Array.isArray(raw.ids)) { ids = raw.ids.slice(); version = raw.version || 1; }
    else return { ids: DEFAULT_IDS.slice(), version: FORMAT_VERSION };
    ids = ids.filter(function (id) { return typeof id === 'string' && id; });
    // 고정 꼬리(settings·trash)는 render가 구분선 뒤에 항상 붙이는 쪽이
    // 정본이다. 저장 구성에 같은 id가 남아 있으면 아이콘이 중복 렌더되므로
    // 마이그레이션 단계에서 고정 앱 ids에서 제외한다.
    ids = ids.filter(function (id) { return id !== 'settings' && id !== 'trash'; });
    if (version < 2) ids = insertAfter(ids, 'chat', ['mission']);
    if (version < 3 && ids.indexOf('finder') < 0) ids.unshift('finder');
    if (version < 4) ids = insertAfter(ids, 'chat', ['browser']);
    if (version < 5) ids = insertAfter(ids, 'browser', ['excel', 'hangul', 'powerpoint', 'pdf']);
    if (version < 6) {
      // v6: 원본 구성으로 재정렬 — 백업·미션 항목 제거, 남은 항목은 기본 순서로,
      // 동적 모듈 등 낯선 항목은 뒤에 유지한다 (사용자 제거 항목은 되살리지 않음).
      ids = ids.filter(function (id) { return id !== 'backup' && id !== 'mission'; });
      var known = ids.filter(function (id) { return DEFAULT_IDS.indexOf(id) >= 0; });
      var extra = ids.filter(function (id) { return DEFAULT_IDS.indexOf(id) < 0; });
      known.sort(function (a, b) { return DEFAULT_IDS.indexOf(a) - DEFAULT_IDS.indexOf(b); });
      ids = known.concat(extra);
    }
    return { ids: ids, version: FORMAT_VERSION };
  }

  function loadDockIds(storage) {
    var raw = null;
    try { raw = JSON.parse(storage.getItem(STORAGE_KEY) || 'null'); }
    catch (e) { raw = null; }
    return migrateDockIds(raw).ids;
  }

  function saveDockIds(storage, ids) {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: FORMAT_VERSION, ids: ids.slice() }));
  }

  function loadRecents(storage) {
    try {
      var raw = JSON.parse(storage.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(function (x) { return typeof x === 'string'; }).slice(0, 3) : [];
    } catch (e) { return []; }
  }

  function saveRecents(storage, ids) {
    storage.setItem(RECENTS_KEY, JSON.stringify(ids.slice(0, 3)));
  }

  function createDock(deps) {
    var root = deps.root;
    var doc = root.ownerDocument;
    var tiles = deps.tiles;
    var ids = deps.ids.slice();
    var running = {};
    var trashCount = 0;

    function el(tag, cls) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    function makeItem(id, opts) {
      opts = opts || {};
      var btn = el('button', 'dt-dock-item');
      btn.type = 'button';
      btn.dataset.module = id;
      if (opts.recent) btn.classList.add('dt-dock-recent');
      var tile = tiles.createTile(id, { document: doc });
      if (tile) btn.appendChild(tile);
      var label = el('span', 'dt-dock-label');
      label.textContent = opts.title || id;
      btn.appendChild(label);
      if (running[id]) btn.appendChild(el('span', 'dt-dock-dot'));
      btn.setAttribute('aria-label', opts.title || id);
      btn.addEventListener('click', function () {
        if (btn.dataset.dragMoved === '1') { btn.dataset.dragMoved = ''; return; }
        if (deps.onOpen) deps.onOpen(id);
      });
      btn.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (deps.onContextMenu) deps.onContextMenu(id, ev, { pinned: !opts.recent });
      });
      if (opts.reorderable) attachDrag(btn, id);
      return btn;
    }

    /* 독 안 순서 변경 드래그: 삽입 위치를 실시간으로 보여주고,
       독 밖으로 나가 놓으면 제거가 우선한다. */
    function attachDrag(btn, id) {
      btn.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        var startX = ev.clientX, startY = ev.clientY;
        var active = false;
        var outside = false;
        function onMove(e2) {
          var dx = e2.clientX - startX, dy = e2.clientY - startY;
          if (!active && Math.hypot(dx, dy) > 6) {
            active = true;
            btn.classList.add('dt-dock-dragging');
            btn.dataset.dragMoved = '1';
          }
          if (!active) return;
          var r = root.getBoundingClientRect();
          outside = e2.clientY < r.top - 24 || e2.clientY > r.bottom + 24;
          btn.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          // 삽입 대상: 포인터 x가 중심을 지난 이웃과 자리 교체
          var siblings = Array.prototype.slice.call(root.querySelectorAll('.dt-dock-item[data-module]'));
          for (var i = 0; i < siblings.length; i++) {
            var sib = siblings[i];
            if (sib === btn) continue;
            var sr = sib.getBoundingClientRect();
            if (e2.clientX > sr.left && e2.clientX < sr.right) {
              var before = e2.clientX < sr.left + sr.width / 2;
              if (before && sib.previousSibling !== btn) root.insertBefore(btn, sib);
              if (!before && sib.nextSibling !== btn) root.insertBefore(btn, sib.nextSibling);
              break;
            }
          }
        }
        function onUp() {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          btn.classList.remove('dt-dock-dragging');
          btn.style.transform = '';
          if (!active) return;
          if (outside) {
            if (deps.onRemove && id !== 'finder') deps.onRemove(id);
            return;
          }
          var order = Array.prototype.map.call(
            root.querySelectorAll('.dt-dock-item[data-module]'),
            function (n) { return n.dataset.module; }
          );
          ids = order;
          if (deps.onReorder) deps.onReorder(order.slice());
        }
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
      });
    }

    function render(state) {
      if (state) {
        if (state.ids) ids = state.ids.slice();
        if (state.running) running = state.running;
        if (typeof state.trashCount === 'number') trashCount = state.trashCount;
      }
      root.innerHTML = '';
      var titles = deps.titles || {};
      ids.forEach(function (id) {
        root.appendChild(makeItem(id, { title: titles[id], reorderable: true }));
      });
      var recents = (deps.getRecents ? deps.getRecents() : []).filter(function (id) {
        return ids.indexOf(id) < 0;
      });
      if (recents.length) {
        var sep = el('div', 'dt-dock-sep');
        sep.dataset.sep = 'recents';
        root.appendChild(sep);
        recents.forEach(function (id) {
          root.appendChild(makeItem(id, { title: titles[id], recent: true }));
        });
      }
      var sep2 = el('div', 'dt-dock-sep');
      sep2.dataset.sep = 'trash';
      root.appendChild(sep2);
      var settings = el('button', 'dt-dock-item dt-dock-settings');
      settings.type = 'button';
      var stile = tiles.createTile('settings', { document: doc });
      if (stile) settings.appendChild(stile);
      var slabel = el('span', 'dt-dock-label');
      slabel.textContent = '설정';
      settings.appendChild(slabel);
      settings.setAttribute('aria-label', '설정');
      settings.addEventListener('click', function (ev) { if (deps.onOpenSettings) deps.onOpenSettings(ev); });
      root.appendChild(settings);
      var trash = el('button', 'dt-dock-item dt-dock-trash');
      trash.type = 'button';
      trash.dataset.trash = '1';
      var ttile = tiles.createTile('trash', { document: doc, trashFull: trashCount > 0 });
      if (ttile) trash.appendChild(ttile);
      var tlabel = el('span', 'dt-dock-label');
      tlabel.textContent = '휴지통';
      trash.appendChild(tlabel);
      if (trashCount > 0) {
        var badge = el('span', 'dt-dock-badge');
        badge.textContent = String(trashCount);
        trash.appendChild(badge);
      }
      trash.setAttribute('aria-label', '휴지통');
      trash.addEventListener('click', function () { if (deps.onOpenTrash) deps.onOpenTrash(); });
      trash.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (deps.onTrashContextMenu) deps.onTrashContextMenu(ev, trashCount);
      });
      // 아이콘 드롭 수신 (바탕화면 아이콘을 독 휴지통에 떨어뜨리면 휴지통행)
      trash.addEventListener('dragover', function (ev) { ev.preventDefault(); });
      root.appendChild(trash);
      tiles.refreshIcons(root);
    }

    return {
      render: render,
      getIds: function () { return ids.slice(); },
      setIds: function (next) { ids = next.slice(); },
      setTrashCount: function (n) { trashCount = n; },
    };
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY, RECENTS_KEY: RECENTS_KEY,
    FORMAT_VERSION: FORMAT_VERSION, DEFAULT_IDS: DEFAULT_IDS,
    migrateDockIds: migrateDockIds,
    loadDockIds: loadDockIds, saveDockIds: saveDockIds,
    loadRecents: loadRecents, saveRecents: saveRecents,
    createDock: createDock,
  };

  if (typeof window !== 'undefined') window.MyHubDesktopDock = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopDock = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
