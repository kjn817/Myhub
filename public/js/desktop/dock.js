/* MyHub 데스크톱 앱 독 (dock.js)
 *
 * 설계: docs/desktop-macos-redesign-20261101.md B단계 + 핫팁데스크 앱용앱
 * - 하단 중앙 플로팅 독. 모듈 타일 1개 = 창 1개(앱의 모델)와 앱한다.
 * - 앱 크기를 고정한다 앱 마우스오버 확대(일시아이)를 넣었기가 사용자
 *   지시로 제거한다 (2026-11-01: "앱에서 마우스오버하면 커서이 앱과
 *   필요 없어"). 호버 일드 백이 해당한다.
 * - 실행 중이면 앱 아래 점, 최소화한 창도 앱으로 표시(열려 있음).
 * - 클릭: 모듈의 onActivate(열기/복원/사용하는 창 관리자가 판단),
 *   링크 항목은 href로 이동, 동작 항목은 onSelect를 부른다. 아직 없는
 *   창을 앱 때는 바운스 애니메이션.
 * - 독 구성은 사용자가 바꾼다 (2026-11-01 지시): 항목을 독 밖으로
 *   드래그해 빼면 제거(onRemoveItem), 바탕화면 아이콘을 앱에
 *   드래그하면 추가(windows.js의 addToDock). 구성은 localStorage
 *   'myhub.desktop.dock.v1'의 순서 있는 id 목록으로 저장된다.
 * - 독 안 순서 변경 (2026-11-03 사용자 지시 "앱내에서 위치변경이
 *   안되며, 앱 고정되여 있어"): reorderable 항목은 독 안에서
 *   좌우로 드래그해 빼면 그 자리에 삽입한다 앱 DOM의 실제로
 *   앱고 onReorder(고정 항목들의 앱 순서)로 소유자에게 알린다.
 *   독 밖으로 나간 드래그는 종전대로 제거가 우선한다.
 * 노출: window.MyHubDesktopDock = { BASE, DOCK_KEY,
 *        loadDockIds, saveDockIds, createDock }
 */
(function () {
  'use strict';

  var BASE = 48;
  var DOCK_KEY = 'myhub.desktop.dock.v1';
  var DRAG_OUT_THRESHOLD = 26;

  /**
   * 앱에 고정한 항목 id 목록. 앱값이 없으면 카탈로그 전체가 기본값.
   * 모르는 id는 버리고 순서는 카탈로그 순서이 아니라 저장 순을 따른다.
   */
  function loadDockIds(storage, catalogIds) {
    var catalog = catalogIds || [];
    if (!storage) return catalog.slice();
    var raw = null;
    try { raw = storage.getItem(DOCK_KEY); } catch (e) { raw = null; }
    if (!raw) return catalog.slice();
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.ids)) return catalog.slice();
      var known = {};
      catalog.forEach(function (id) { known[id] = true; });
      var out = [];
      parsed.ids.forEach(function (id) {
        if (known[id] && out.indexOf(id) < 0) out.push(id);
      });
      // v1 앱값 마이그레이션: 미션 컨트롤 항목이 없든 시점에 구성하면
      // 설정 앞에 앱 번 넣어준다. v2 이상으로 저장된 앱에서는 사용자의
      // 제거를 존중해 다시 넣지 않는다.
      var savedVersion = parsed.version || 1;
      if (savedVersion < 2 && known['mission'] && out.indexOf('mission') < 0) {
        var sIdx = out.indexOf('settings');
        if (sIdx >= 0) out.splice(sIdx, 0, 'mission');
        else out.push('mission');
      }

      // v3 마이그레이션: 파인더가 없든 시점에 구성하면 맨 앞에 앱 번
      // 넣어준다 (맨의 앱에서 파인더는 항상 첫 자리로). v3로 저장된
      // 앱에서는 다시 넣지 않는다.
      if (savedVersion < 3 && known['finder'] && out.indexOf('finder') < 0) {
        out.unshift('finder');
      }
      // v4 마이그레이션: 브라우저가 없든 시점에 구성하면 파인 앱에
      // 앱 번 넣어준다 (사파리 자리). v4로 저장된 앱에서는 다시 앱 않음.
      if (savedVersion < 4 && known['browser'] && out.indexOf('browser') < 0) {
        var fIdx = out.indexOf('finder');
        if (fIdx >= 0) out.splice(fIdx + 1, 0, 'browser');
        else out.unshift('browser');
      }
      // v5 마이그레이션: 오피스 앱 4종(Excel·한글 2020·PowerPoint·PDF)의
      // 없든 시점에 구성하면 Finder(브라우저가 있으면 그 앱) 앱에 앱 번
      // 넣어준다 (사용자 지시 2026-11-02: "앱에서 추가해줘 4개 모두").
      // v5로 저장된 앱에서는 사용자의 제거를 존중해 다시 넣지 않는다.
      if (savedVersion < 5) {
        var office = ['excel', 'hangul', 'powerpoint', 'pdf'].filter(function (id) {
          return known[id] && out.indexOf(id) < 0;
        });
        if (office.length) {
          var anchor = out.indexOf('browser');
          if (anchor < 0) anchor = out.indexOf('finder');
          if (anchor >= 0) out.splice.apply(out, [anchor + 1, 0].concat(office));
          else out.unshift.apply(out, office);
        }
      }
      return out;
    } catch (e) {
      return catalog.slice();
    }
  }

  function saveDockIds(storage, ids) {
    if (!storage) return;
    try {
      storage.setItem(DOCK_KEY, JSON.stringify({ version: 5, ids: ids.slice() }));
    } catch (e) {
      console.warn('독 구성 저장 실패:', e);
    }
  }

  /**
   * deps = {
   *   container,                 // 독을 렌더링할 nav 요소
   *   tilesApi,                  // MyHubDesktopTiles
   *   items: [{ id, label, href?, onSelect?, reorderable? }],
   *                              // href면 링크, onSelect면 동작 항목,
   *                              // reorderable이면 독 안 순서 변경 가능
   *   onActivate(id),            // 모듈 항목 클릭
   *   onRemoveItem?(id),         // 항목을 독 밖으로 드래그해 빼낸 앱
   *   onReorder?(ids),           // 순서 변경 확정 앱 reorderable 항목들의 앱 순서
   *   onContextMenu?(item, x, y), // 우클릭 메뉴 요청
   * }
   * 반환: { update(view), destroy() }
   * view = { openIds: string[], activeId: string|null, minimizedIds: string[] }
   */
  function createDock(deps) {
    deps = deps || {};
    var container = deps.container;
    if (!container) throw new Error('createDock: container가 필요합니다');
    var tilesApi = deps.tilesApi;
    if (!tilesApi) throw new Error('createDock: tilesApi가 필요합니다');
    var doc = container.ownerDocument || document;
    var items = deps.items || [];

    function raf(fn) {
      var w = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      if (w && typeof w.requestAnimationFrame === 'function') return w.requestAnimationFrame(fn);
      return setTimeout(fn, 0);
    }
    function cancelRaf(id) {
      var w = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      if (w && typeof w.cancelAnimationFrame === 'function') w.cancelAnimationFrame(id);
      else clearTimeout(id);
    }
    var onActivate = typeof deps.onActivate === 'function' ? deps.onActivate : function () {};

    var inner = doc.createElement('div');
    inner.className = 'dt-dock-inner';
    container.appendChild(inner);

    var records = new Map(); // id -> { item, btn, tile, dot }
    var view = { openIds: [], activeId: null, minimizedIds: [] };
    var destroyed = false;

    items.forEach(function (item, idx) {
      var sepEl = null;
      if (item.separatorBefore) {
        sepEl = doc.createElement('div');
        sepEl.className = 'dt-dock-sep';
        sepEl.setAttribute('aria-hidden', 'true');
        inner.appendChild(sepEl);
      }
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'dt-dock-item';
      btn.dataset.module = item.id;
      btn.setAttribute('aria-label', item.label);

      var tip = doc.createElement('span');
      tip.className = 'dt-dock-tip';
      tip.textContent = item.label;
      btn.appendChild(tip);

      var tile = tilesApi.createTile(doc, item.id);
      tile.classList.add('dt-dock-tile');
      tile.style.width = BASE + 'px';
      tile.style.height = BASE + 'px';
      btn.appendChild(tile);

      var dot = doc.createElement('span');
      dot.className = 'dt-dock-dot';
      btn.appendChild(dot);

      // ---- 드래그: 독 밖이면 제거, 독 안이면 순서 변경 ----
      var dragOut = null;
      var suppressClick = false;
      btn.addEventListener('pointerdown', function (e) {
        // 독 컨테이너 rect를 드래그 시작 시 캐시한다 — move마다
        // getBoundingClientRect를 읽으면 레이아웃 스래싱이다.
        var cr = container.getBoundingClientRect();
        dragOut = {
          pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
          dx: 0, dy: 0, active: false, removeReady: false, lastX: e.clientX,
          lastY: e.clientY, rafId: null,
          containerRect: cr ? { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom, width: cr.width } : null,
        };
        try {
          if (typeof btn.setPointerCapture === 'function' && e.pointerId !== undefined) {
            btn.setPointerCapture(e.pointerId);
          }
        } catch (err) { console.warn('독 포인터 캡처 실패:', err); }
      });
      // 포인터 x가 가로킨의 삽입 위치 (잡고 있는 버튼의 칸 버튼 목록 기준)
      function insertionIndex(clientX) {
        var btns = Array.prototype.slice.call(inner.querySelectorAll('.dt-dock-item'));
        var others = btns.filter(function (b) { return b !== btn; });
        var n = 0;
        others.forEach(function (b) {
          var r = b.getBoundingClientRect();
          if (r && clientX > r.left + r.width / 2) n++;
        });
        return n;
      }
      function currentIndex() {
        var btns = Array.prototype.slice.call(inner.querySelectorAll('.dt-dock-item'));
        return btns.indexOf(btn);
      }
      function commitReorder(clientX) {
        var from = currentIndex();
        var to = insertionIndex(clientX);
        if (from < 0 || to === from) return;
        // 구분자가 붙은 항목은 구분자도 함께 앱한다
        var btns = Array.prototype.slice.call(inner.querySelectorAll('.dt-dock-item'));
        var others = btns.filter(function (b) { return b !== btn; });
        var ref = to < others.length ? others[to] : null;
        if (sepEl) inner.insertBefore(sepEl, ref);
        inner.insertBefore(btn, ref);
        if (typeof deps.onReorder === 'function') {
          var order = [];
          inner.querySelectorAll('.dt-dock-item').forEach(function (b) {
            var rec = records.get(b.dataset.module);
            if (rec && rec.item.reorderable) order.push(rec.item.id);
          });
          deps.onReorder(order);
        }
      }
      // 독 밖 드래그도 rAF로 합친다 (2026-11-12 성능 점검 — move마다
      // transform 직접 쓰기 + 컨테이너 rect 읽기가 어설픈 코드였다).
      function applyDockDragFrame() {
        if (!dragOut) return;
        dragOut.rafId = null;
        if (!dragOut.active) return;
        btn.style.transform = 'translate(' + dragOut.dx + 'px,' + dragOut.dy + 'px)';
        var r = dragOut.containerRect;
        var outside = r && r.width > 0 &&
          (dragOut.lastX < r.left - 48 || dragOut.lastX > r.right + 48 ||
           dragOut.lastY < r.top - 48 || dragOut.lastY > r.bottom + 48);
        dragOut.removeReady = !!outside;
        btn.classList.toggle('is-remove-ready', dragOut.removeReady);
      }
      btn.addEventListener('pointermove', function (e) {
        if (!dragOut || (dragOut.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== dragOut.pointerId)) return;
        dragOut.dx = e.clientX - dragOut.startX;
        dragOut.dy = e.clientY - dragOut.startY;
        dragOut.lastX = e.clientX;
        dragOut.lastY = e.clientY;
        if (!dragOut.active && Math.hypot(dragOut.dx, dragOut.dy) > DRAG_OUT_THRESHOLD) {
          dragOut.active = true;
          btn.classList.add('is-dragging-out');
        }
        if (dragOut.active) {
          if (dragOut.rafId === null || dragOut.rafId === undefined) {
            dragOut.rafId = raf(applyDockDragFrame);
          }
        }
      });

      function endDragOut(commit) {
        if (!dragOut) return;
        var wasActive = dragOut.active;
        var removeReady = dragOut.removeReady;
        var lastX = dragOut.lastX;
        if (dragOut.rafId !== null && dragOut.rafId !== undefined) {
          cancelRaf(dragOut.rafId);
          dragOut.rafId = null;
          // 대기 중이던 마지막 move 프레임을 동기 반영해 드롭 판정이
          // pointerup 직전 최신 좌표를 쓰게 한다 (dragOut을 null로 하기 전).
          applyDockDragFrame();
          removeReady = dragOut.removeReady;
        }
        dragOut = null;
        btn.style.transform = '';
        btn.classList.remove('is-dragging-out');
        btn.classList.remove('is-remove-ready');
        if (wasActive) {
          suppressClick = true;
          if (commit && removeReady) {
            if (typeof deps.onRemoveItem === 'function') deps.onRemoveItem(item.id);
          } else if (commit && item.reorderable) {
            commitReorder(lastX);
          }
        }
      }
      btn.addEventListener('pointerup', function () { endDragOut(true); });
      btn.addEventListener('pointercancel', function () { endDragOut(false); });

      btn.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        if (typeof deps.onContextMenu === 'function') {
          deps.onContextMenu(item, e.clientX, e.clientY);
        }
      });
      btn.addEventListener('click', function () {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (typeof item.onSelect === 'function') {
          item.onSelect();
          return;
        }
        if (item.href) {
          window.location.assign(item.href);
          return;
        }
        if (view.openIds.indexOf(item.id) < 0) {
          btn.classList.remove('is-bouncing');
          // 강제 리플로우 없이 클래스 접기로 애니메이션을 재시작한다
          void btn.offsetWidth;
          btn.classList.add('is-bouncing');
          setTimeout(function () { btn.classList.remove('is-bouncing'); }, 700);
        }
        onActivate(item.id);
      });
      inner.appendChild(btn);
      records.set(item.id, { item: item, btn: btn, tile: tile, dot: dot });
      void idx;
    });

    function update(next) {
      view = {
        openIds: next && next.openIds ? next.openIds.slice() : [],
        activeId: next && next.activeId ? next.activeId : null,
        minimizedIds: next && next.minimizedIds ? next.minimizedIds.slice() : [],
      };
      records.forEach(function (rec, id) {
        var open = view.openIds.indexOf(id) >= 0;
        rec.btn.classList.toggle('is-open', open);
        rec.btn.classList.toggle('is-active', view.activeId === id);
        rec.btn.classList.toggle('is-min', view.minimizedIds.indexOf(id) >= 0);
        rec.dot.style.opacity = open ? '1' : '0';
      });
    }

    function destroy() {
      destroyed = true;
      records.clear();
      inner.remove();
    }

    // 초기 렌더가 끝난다 글리프를 실제 SVG로 바꾼다 (빈 타일 방지)
    if (tilesApi.refreshIcons) tilesApi.refreshIcons();

    return { update: update, destroy: destroy };
  }

  var api = {
    BASE: BASE,
    DOCK_KEY: DOCK_KEY,
    loadDockIds: loadDockIds,
    saveDockIds: saveDockIds,
    createDock: createDock,
  };
  if (typeof window !== 'undefined') window.MyHubDesktopDock = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopDock = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
