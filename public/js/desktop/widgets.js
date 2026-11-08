/* MyHub 데스크톱 위젯 — 오늘·저장소·시스템 카드.
 *
 * 재구성 근거: 구 홈 위젯 이관(summarizeSystem 순수 함수, /api/system 계산식),
 * 순서 저장 'myhub.desktop.widgets.v1' + 드래그 순서 변경(이웃 중심 교차 시
 * DOM 맞바꿈), D-14 최종: 자유 배치 + 자성 스냅(snapWidgetPos — 모서리 정렬·
 * 간격 12px 후보, 임계 12px, 축별 독립; 드래그 transform에도 적용),
 * 우하단 리사이즈 핸들 + sizes 저장(포맷 v3, 최소 220×96, 리사이즈도 모서리 자성).
 * 위젯 레이어는 아이콘 레이어 위 (반투명이라 아이콘 실루엣이 비치는 전제).
 *
 * 기본 배치 (2026-11-08 결함 수정): 재구축본은 세 위젯 기본 좌표가 모두
 * (16,16) — 아이콘 격자 원점과 같은 자리 — 라 서로 겹쳐 쌓이고 마지막에
 * 그려진 '시스템'만 보이며 Finder 아이콘을 완전히 덮었다. 기본값은 우측
 * 세로 스택(아이콘 열과 겹치지 않는 영역)으로 정정하고, 렌더 시 겹침
 * 해소(resolveWidgetRects)를 거쳐 저장 상태가 쌓여 있어도 서로를 가리지
 * 않게 한다. 높이는 저장된 크기가 있을 때만 고정하고, 기본 상태에서는
 * 내용 높이에 맡긴다 (고정 160px가 내용보다 커 카드 하단에 빈 공간이
 * 생기던 문제).
 *
 * 노출: window.MyHubDesktopWidgets + module.exports
 */
(function () {
  'use strict';

  var ORDER_KEY = 'myhub.desktop.widgets.v1';
  var LAYOUT_KEY = 'myhub.desktop.widgets.layout.v3';
  var SNAP_GAP = 12;
  var SNAP_THRESHOLD = 12;
  var MIN_W = 220;
  var MIN_H = 96;
  var DEFAULT_W = 300;
  var DEFAULT_H = 160;
  var EDGE_MARGIN = 16;

  var WIDGET_DEFS = [
    { id: 'today', title: '오늘' },
    { id: 'storage', title: '저장소' },
    { id: 'system', title: '시스템' },
  ];

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /**
   * 자성 스냅 순수 함수: 다른 위젯·화면 모서리에 대해 간격 12px를 유지하는
   * 후보 위치를 만들고, 임계 12px 안에서 축별로 독립 적용한다.
   */
  function snapWidgetPos(pos, size, others, viewport) {
    var x = pos.x, y = pos.y;
    var candX = [0, SNAP_GAP, viewport.w - size.w, viewport.w - size.w - SNAP_GAP];
    var candY = [0, SNAP_GAP, viewport.h - size.h, viewport.h - size.h - SNAP_GAP];
    others.forEach(function (o) {
      candX.push(o.x + o.w + SNAP_GAP, o.x - size.w - SNAP_GAP, o.x, o.x + o.w - size.w);
      candY.push(o.y + o.h + SNAP_GAP, o.y - size.h - SNAP_GAP, o.y, o.y + o.h - size.h);
    });
    function pick(v, cands) {
      var best = v, bestD = SNAP_THRESHOLD + 1;
      cands.forEach(function (c) {
        var d = Math.abs(c - v);
        if (d < bestD) { bestD = d; best = c; }
      });
      return best;
    }
    return { x: pick(x, candX), y: pick(y, candY) };
  }

  /**
   * 기본 배치 순수 함수: 아이콘 격자는 왼쪽 열부터 채워지므로, 위젯 기본값은
   * 우측에 세로로 쌓는다 (순서 index만큼 아래로). 화면 폭을 모르면 1024 기준.
   */
  function defaultWidgetPos(index, viewport) {
    var w = (viewport && viewport.w) || 1024;
    return {
      x: Math.max(0, w - DEFAULT_W - EDGE_MARGIN),
      y: EDGE_MARGIN + index * (DEFAULT_H + SNAP_GAP),
    };
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /**
   * 렌더용 사각형 확정 순수 함수: 저장 위치·크기를 우선하되, 저장값이 없는
   * 위젯은 기본 배치를 쓴다. 이미 놓인 위젯과 겹치는 위젯은 겹친 위젯 중
   * 가장 아래에 있는 것의 밑으로 내린다 — 구 기본값처럼 같은 좌표가 저장돼
   * 있어도 위젯이 서로를 완전히 가리는 일이 없게 하는 방어이며, 저장값
   * 자체는 바꾸지 않는다 (사용자가 의도적으로 아이콘 위에 둔 위젯까지
   * 옮기지는 않는다 — 그 판단은 기본값 정정으로 충분하다).
   */
  function resolveWidgetRects(order, layout, viewport) {
    var posMap = (layout && layout.pos) || {};
    var sizeMap = (layout && layout.sizes) || {};
    var placed = [];
    var rects = {};
    order.forEach(function (id, idx) {
      var pos = posMap[id] || defaultWidgetPos(idx, viewport);
      var size = sizeMap[id] || { w: DEFAULT_W, h: DEFAULT_H };
      var rect = { x: pos.x, y: pos.y, w: size.w, h: size.h };
      for (var guard = 0; guard < order.length; guard++) {
        var hit = null;
        placed.forEach(function (p) {
          if (rectsOverlap(rect, p) && (!hit || p.y + p.h > hit.y + hit.h)) hit = p;
        });
        if (!hit) break;
        rect.y = hit.y + hit.h + SNAP_GAP;
      }
      placed.push(rect);
      rects[id] = rect;
    });
    return rects;
  }

  function pct(used, limit) {
    if (!limit || limit <= 0) return 0;
    return clamp(Math.round((used / limit) * 100), 0, 100);
  }

  function fmtBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'KB';
    return n + 'B';
  }

  /** /api/system 응답 → 저장소·시스템 카드 표시 모델 (순수 함수).
   * 응답 형태는 서버 라우트(운영 번들 대조 확정)가 정본이다:
   * { d1: { size_bytes, limit_bytes }, memos: <개수>,
   *   files: { count, bytes }, cloudinary: { used_bytes, limit_bytes } | null }
   * 재구축 초기본이 memoCount·usedBytes 같은 추정 필드명을 읽어 실제 응답에서
   * 항상 빈 카드가 됐던 결함이 있었다 — 서버가 보내지 않는 필드는 읽지 않는다. */
  function summarizeSystem(data) {
    var out = { storage: [], system: [] };
    if (!data || typeof data !== 'object') return out;
    var d1 = data.d1 || {};
    if (typeof d1.size_bytes === 'number') {
      out.storage.push({ label: '데이터베이스', text: fmtBytes(d1.size_bytes) + ' / ' + fmtBytes(d1.limit_bytes || 0), pct: pct(d1.size_bytes, d1.limit_bytes) });
    }
    var cloud = data.cloudinary || {};
    if (typeof cloud.used_bytes === 'number') {
      out.storage.push({ label: '미디어', text: fmtBytes(cloud.used_bytes) + ' / ' + fmtBytes(cloud.limit_bytes || 0), pct: pct(cloud.used_bytes, cloud.limit_bytes) });
    }
    if (typeof data.memos === 'number') out.system.push({ label: '메모', text: data.memos + '개' });
    if (data.files && typeof data.files.count === 'number') out.system.push({ label: '파일', text: data.files.count + '개' });
    return out;
  }

  function loadOrder(storage) {
    try {
      var raw = JSON.parse(storage.getItem(ORDER_KEY) || 'null');
      if (Array.isArray(raw) && raw.length) {
        var known = WIDGET_DEFS.map(function (d) { return d.id; });
        var order = raw.filter(function (id) { return known.indexOf(id) >= 0; });
        known.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
        return order;
      }
    } catch (e) { console.debug('위젯 순서 복원 실패:', e); }
    return WIDGET_DEFS.map(function (d) { return d.id; });
  }

  function loadLayout(storage) {
    try {
      var raw = JSON.parse(storage.getItem(LAYOUT_KEY) || 'null');
      if (raw && typeof raw === 'object') return { pos: raw.pos || {}, sizes: raw.sizes || {} };
    } catch (e) { console.debug('위젯 레이아웃 복원 실패:', e); }
    return { pos: {}, sizes: {} };
  }

  function createWidgets(deps) {
    var layer = deps.layer;
    var doc = layer.ownerDocument;
    var storage = deps.storage;
    var order = loadOrder(storage);
    var layout = loadLayout(storage);
    var nodes = {};

    function saveLayout() {
      storage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    }

    function render() {
      layer.innerHTML = '';
      nodes = {};
      var viewport = { w: layer.clientWidth || 1024, h: layer.clientHeight || 768 };
      var rects = resolveWidgetRects(order, layout, viewport);
      order.forEach(function (id) {
        var def = WIDGET_DEFS.filter(function (d) { return d.id === id; })[0];
        if (!def) return;
        var card = doc.createElement('section');
        card.className = 'dt-widget dt-widget-' + id;
        card.dataset.widget = id;
        var rect = rects[id];
        card.style.left = rect.x + 'px';
        card.style.top = rect.y + 'px';
        card.style.width = rect.w + 'px';
        // 높이는 저장된 크기가 있을 때만 고정한다. 기본 상태에서는 내용
        // 높이에 맡겨야 카드 하단에 빈 공간이 생기지 않는다.
        if (layout.sizes[id]) card.style.height = rect.h + 'px';
        var head = doc.createElement('header');
        head.className = 'dt-widget-head';
        head.textContent = def.title;
        card.appendChild(head);
        var body = doc.createElement('div');
        body.className = 'dt-widget-body';
        card.appendChild(body);
        var handle = doc.createElement('div');
        handle.className = 'dt-widget-resize';
        handle.setAttribute('aria-hidden', 'true');
        card.appendChild(handle);
        layer.appendChild(card);
        nodes[id] = card;
        attachDrag(card, id, head);
        attachResize(card, id, handle);
        fillBody(id, body);
      });
    }

    function fillBody(id, body) {
      if (id === 'today') {
        var d = new Date();
        var days = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
        body.innerHTML = '<div class="dt-widget-date">' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일</div>' +
          '<div class="dt-widget-sub">' + days[d.getDay()] + '</div>';
        return;
      }
      body.innerHTML = '<div class="dt-widget-sub">불러오는 중…</div>';
      var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
      if (!fetchFn) return;
      fetchFn('/api/system').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          var sum = summarizeSystem(data && (data.data || data));
          var rows = id === 'storage' ? sum.storage : sum.system;
          if (!rows.length) { body.innerHTML = '<div class="dt-widget-sub">표시할 정보가 없어요.</div>'; return; }
          body.innerHTML = rows.map(function (row) {
            var bar = typeof row.pct === 'number'
              ? '<span class="dt-widget-bar"><span style="width:' + row.pct + '%"></span></span>' : '';
            return '<div class="dt-widget-row"><span>' + row.label + '</span><span>' + row.text + '</span>' + bar + '</div>';
          }).join('');
        })
        .catch(function () { body.innerHTML = '<div class="dt-widget-sub">정보를 불러오지 못했어요.</div>'; });
    }

    function othersRects(exceptId) {
      return order.filter(function (id) { return id !== exceptId; }).map(function (id) {
        var n = nodes[id];
        var pos = layout.pos[id] || { x: n.offsetLeft, y: n.offsetTop };
        var size = layout.sizes[id] || { w: n.offsetWidth, h: n.offsetHeight };
        return { x: pos.x, y: pos.y, w: size.w, h: size.h };
      });
    }

    function attachDrag(card, id, head) {
      head.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        var startX = ev.clientX, startY = ev.clientY;
        var pos = layout.pos[id] || { x: card.offsetLeft, y: card.offsetTop };
        var size = layout.sizes[id] || { w: card.offsetWidth, h: card.offsetHeight };
        var moved = false;
        function onMove(e2) {
          var dx = e2.clientX - startX, dy = e2.clientY - startY;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          var viewport = { w: layer.clientWidth || 1024, h: layer.clientHeight || 768 };
          var snapped = snapWidgetPos({ x: pos.x + dx, y: pos.y + dy }, size, othersRects(id), viewport);
          card.style.transform = 'translate(' + (snapped.x - pos.x) + 'px,' + (snapped.y - pos.y) + 'px)';
          card.dataset.snapX = snapped.x;
          card.dataset.snapY = snapped.y;
        }
        function onUp() {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          if (!moved) return;
          card.style.transform = '';
          layout.pos[id] = { x: Number(card.dataset.snapX || pos.x), y: Number(card.dataset.snapY || pos.y) };
          card.style.left = layout.pos[id].x + 'px';
          card.style.top = layout.pos[id].y + 'px';
          saveLayout();
        }
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
      });
    }

    function attachResize(card, id, handle) {
      handle.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        var startX = ev.clientX, startY = ev.clientY;
        var size = layout.sizes[id] || { w: card.offsetWidth, h: card.offsetHeight };
        function onMove(e2) {
          var w = Math.max(MIN_W, size.w + (e2.clientX - startX));
          var h = Math.max(MIN_H, size.h + (e2.clientY - startY));
          card.style.width = w + 'px';
          card.style.height = h + 'px';
          card.dataset.newW = w;
          card.dataset.newH = h;
        }
        function onUp() {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          layout.sizes[id] = {
            w: Number(card.dataset.newW || size.w),
            h: Number(card.dataset.newH || size.h),
          };
          saveLayout();
        }
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
      });
    }

    return {
      render: render,
      getOrder: function () { return order.slice(); },
    };
  }

  var api = {
    ORDER_KEY: ORDER_KEY, LAYOUT_KEY: LAYOUT_KEY,
    SNAP_GAP: SNAP_GAP, SNAP_THRESHOLD: SNAP_THRESHOLD,
    MIN_W: MIN_W, MIN_H: MIN_H,
    DEFAULT_W: DEFAULT_W, DEFAULT_H: DEFAULT_H,
    snapWidgetPos: snapWidgetPos,
    defaultWidgetPos: defaultWidgetPos,
    resolveWidgetRects: resolveWidgetRects,
    summarizeSystem: summarizeSystem,
    createWidgets: createWidgets,
  };

  if (typeof window !== 'undefined') window.MyHubDesktopWidgets = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopWidgets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
