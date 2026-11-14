/* MyHub 데스크톱 앱 위젯 (widgets.js)
 *
 * 설계: docs/desktop-macos-redesign-20261101.md C단계 (사용자 검수 기준 4)
 * - macOS 플로팅 반투명 블러 카드: 오늘(일정·할 일 미니) + 저장소 +
 *   시스템. 저장소·시스템은 데스크톱 위젯으로 옮긴 것이다 (사용자 지시 2026-11-01: 데스크톱에 레이 아웃으로 앱
 *   위젯을 데스크톱에 레이을 연다). 시계·날짜 카드는 상단바 시계를
 *   중복이라 사용자 지시로 제거한다.
 * - 데이터는 기존 API 사용 (읽기 전용): GET /api/briefing/today,
 *   GET /api/system (구 앱과 같은 응답·같은 계산식).
 * - 조회 실패는 카드 안에서 조용히 비어 있게 처리한다 (데스크톱을 막지 않음).
 * - 배치 보조 (2026-11-03 사용자 지시): 드래그 중 다른 위젯의 모서리와
 *   간격이 가까워지면 이징 붙는 자성 스냅 (snapWidgetPos 앱 순수 함수),
 *   우하단 핸들로 크기 조절 (sizes 저장). 위치·크기는
 *   'myhub.desktop.widgets.v1' v3 포맷 { positions, sizes }이 저장.
 * 노출: window.MyHubDesktopWidgets = { summarizeBriefing,
 *        summarizeSystem, fmtBytes, snapWidgetPos, SNAP_DIST,
 *        WIDGET_GAP, createManager }
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/briefing/today';
  var SYSTEM_ENDPOINT = '/api/system';
  var MAX_ROWS = 3;

  function fmtBytes(b) {
    if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return '-';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /**
   * /api/system 응답 앱 저장소·시스템 카드 표시의 요약 (구 앱 계산식과 동일).
   * - D1: size_bytes / limit_bytes
   * - 첨부: cloudinary-api 파싱면 used/limit, 아니면 files.bytes (서도 없음)
   * 깨진 응답이면 null (카드가 조용히 실패 문구를 그린다).
   */
  function summarizeSystem(body) {
    if (!body || typeof body !== 'object') return null;
    var d1 = body.d1;
    if (!d1 || !Number.isFinite(d1.size_bytes) || !Number.isFinite(d1.limit_bytes) || d1.limit_bytes <= 0) {
      return null;
    }
    var clUsed = null;
    var clLimit = null;
    if (body.cloudinary && body.cloudinary_source === 'cloudinary-api') {
      if (Number.isFinite(body.cloudinary.used_bytes)) clUsed = body.cloudinary.used_bytes;
      if (Number.isFinite(body.cloudinary.limit_bytes)) clLimit = body.cloudinary.limit_bytes;
    } else if (body.files && Number.isFinite(body.files.bytes)) {
      clUsed = body.files.bytes;
    }
    if (clUsed === null) return null;
    var pct = function (used, limit) {
      if (!limit) return 0;
      return Math.min(100, Math.max(0, (used / limit) * 100));
    };
    return {
      d1: { used: d1.size_bytes, limit: d1.limit_bytes, pct: pct(d1.size_bytes, d1.limit_bytes) },
      cloud: { used: clUsed, limit: clLimit, pct: pct(clUsed, clLimit) },
      workerName: body.worker && body.worker.name ? String(body.worker.name) : '',
      runtime: body.worker && body.worker.runtime ? String(body.worker.runtime) : '',
    };
  }

  /** start_at "2026-11-01T14:30:00" 앱 "14:30". 종일 일정 앱 빈 문자열. */
  function timeOf(startAt) {
    if (typeof startAt !== 'string') return '';
    var t = startAt.indexOf('T');
    if (t < 0 || startAt.length < t + 6) return '';
    return startAt.slice(t + 1, t + 6);
  }

  /**
   * 브리핑 응답 앱 위젯 표시의 요약. 취소한 일정은 제외하고 각각 최대
   * MAX_ROWS개까지만 추린다. 전체 개수는 counts를 우선한다.
   */
  function summarizeBriefing(body) {
    var schedules = body && Array.isArray(body.schedules) ? body.schedules : [];
    var todos = body && Array.isArray(body.todos) ? body.todos : [];
    var liveSchedules = schedules.filter(function (s) { return s && s.status !== 'cancelled'; });
    return {
      schedules: liveSchedules.slice(0, MAX_ROWS).map(function (s) {
        return { time: timeOf(s.start_at), title: String(s.title || '') };
      }),
      todos: todos.slice(0, MAX_ROWS).map(function (t) {
        return { title: String((t && t.title) || '') };
      }),
      scheduleCount: body && body.counts ? body.counts.schedules ?? liveSchedules.length : liveSchedules.length,
      todoCount: body && body.counts ? body.counts.todos ?? todos.length : todos.length,
    };
  }

  // ---- 자성 스냅 (순수 함수) ----
  var SNAP_DIST = 12; // 앱 거리 앱이면 붙는다
  var MAG_GAP = 12; // 붙을 때의 앱 간격 (상링 간격과 동일)

  /**
   * pos/size: 잡고 있는 위젯의 후보 위치·크기. others: 다른 위젯들의
   * {x, y, w, h}. x는 다른 위젯의 왼쪽·오른쪽 모서리 정렬과 앱
   * 간격 배치(왼쪽에 붙이기·오른에 붙이기) 중 가장 가까운 후보를,
   * y는 상단·하단 모서리 정렬과 간격 배치 중 가장 가까운 후보를 붙는다.
   * 임계(SNAP_DIST)를 넘는 후보는 무시한다. 축별로 독립이다.
   */
  function snapWidgetPos(pos, size, others) {
    var bestX = null;
    var bestY = null;
    (others || []).forEach(function (o) {
      var candX = [o.x, o.x + o.w - size.w, o.x + o.w + MAG_GAP, o.x - MAG_GAP - size.w];
      for (var i = 0; i < candX.length; i++) {
        var d = Math.abs(candX[i] - pos.x);
        if (d <= SNAP_DIST && (bestX === null || d < bestX.d)) bestX = { v: candX[i], d: d };
      }
      var candY = [o.y, o.y + o.h - size.h, o.y + o.h + MAG_GAP, o.y - MAG_GAP - size.h];
      for (var j = 0; j < candY.length; j++) {
        var dy = Math.abs(candY[j] - pos.y);
        if (dy <= SNAP_DIST && (bestY === null || dy < bestY.d)) bestY = { v: candY[j], d: dy };
      }
    });
    return {
      x: bestX ? bestX.v : pos.x,
      y: bestY ? bestY.v : pos.y,
      snappedX: !!bestX,
      snappedY: !!bestY,
    };
  }

  /** 크기 조절 앱 오른쪽/아래쪽 모서리를 다른 위젯 모서리에 붙인다. */
  function snapEdge(edge, candidates) {
    var best = null;
    (candidates || []).forEach(function (c) {
      var d = Math.abs(c - edge);
      if (d <= SNAP_DIST && (best === null || d < best.d)) best = { v: c, d: d };
    });
    return best ? best.v : edge;
  }

  /**
   * deps = { container, fetchFn? }
   */
  function createManager(deps) {
    deps = deps || {};
    var container = deps.container;
    if (!container) throw new Error('createWidgets: container가 필요합니다');
    var doc = container.ownerDocument || document;
    var fetchFn = deps.fetchFn || function (url) { return fetch(url); };
    var destroyed = false;

    var todayCard = doc.createElement('section');
    todayCard.className = 'dt-widget dt-widget-today';
    todayCard.dataset.widgetId = 'today';
    var head = doc.createElement('h3');
    head.className = 'dt-widget-head';
    head.textContent = '오늘';
    var body = doc.createElement('div');
    body.className = 'dt-widget-body';
    var more = doc.createElement('div');
    more.className = 'dt-widget-more';
    todayCard.appendChild(head);
    todayCard.appendChild(body);
    todayCard.appendChild(more);
    container.appendChild(todayCard);

    // 저장소·시스템 카드 (구 앱 위젯 열기)
    function makeCard(title) {
      var card = doc.createElement('section');
      card.className = 'dt-widget';
      var h = doc.createElement('h3');
      h.className = 'dt-widget-head';
      h.textContent = title;
      var b = doc.createElement('div');
      b.className = 'dt-widget-body';
      card.appendChild(h);
      card.appendChild(b);
      container.appendChild(card);
      return { card: card, body: b };
    }
    var storageParts = makeCard('저장소');
    storageParts.card.classList.add('dt-widget-storage');
    storageParts.card.dataset.widgetId = 'storage';
    var systemParts = makeCard('시스템');
    systemParts.card.classList.add('dt-widget-system');
    systemParts.card.dataset.widgetId = 'system';

    function renderToday(summary) {
      body.innerHTML = '';
      if (!summary || (summary.schedules.length === 0 && summary.todos.length === 0)) {
        var empty = doc.createElement('p');
        empty.className = 'dt-widget-empty';
        empty.textContent = summary ? '오늘 일정과 할 일이 없어요' : '오늘 정보를 불러오지 못했어요';
        body.appendChild(empty);
        more.textContent = '';
        return;
      }
      summary.schedules.forEach(function (s) {
        var row = doc.createElement('div');
        row.className = 'dt-widget-row';
        var t = doc.createElement('span');
        t.className = 'dt-widget-rowtime';
        t.textContent = s.time || '종일';
        var title = doc.createElement('span');
        title.className = 'dt-widget-rowtitle';
        title.textContent = s.title;
        row.appendChild(t);
        row.appendChild(title);
        body.appendChild(row);
      });
      summary.todos.forEach(function (todo) {
        var row = doc.createElement('div');
        row.className = 'dt-widget-row dt-widget-todo';
        var box = doc.createElement('span');
        box.className = 'dt-widget-check';
        box.setAttribute('aria-hidden', 'true');
        var title = doc.createElement('span');
        title.className = 'dt-widget-rowtitle';
        title.textContent = todo.title;
        row.appendChild(box);
        row.appendChild(title);
        body.appendChild(row);
      });
      more.textContent = '일정 ' + summary.scheduleCount + ' · 할 일 ' + summary.todoCount;
    }

    function refresh() {
      return Promise.resolve()
        .then(function () { return fetchFn(ENDPOINT); })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('briefing http ' + (res && res.status));
          return res.json();
        })
        .then(function (data) {
          if (!destroyed) renderToday(summarizeBriefing(data));
        })
        .catch(function () {
          if (!destroyed) renderToday(null);
        });
    }

    function renderBar(parent, label, usedText, pctValue, fillClass) {
      var row = doc.createElement('div');
      row.className = 'dt-widget-bar-row';
      var lab = doc.createElement('div');
      lab.className = 'dt-widget-bar-label';
      var name = doc.createElement('span');
      name.textContent = label;
      var val = doc.createElement('span');
      val.className = 'dt-widget-bar-value';
      val.textContent = usedText;
      lab.appendChild(name);
      lab.appendChild(val);
      var track = doc.createElement('div');
      track.className = 'dt-widget-bar-track';
      var fill = doc.createElement('div');
      fill.className = 'dt-widget-bar-fill ' + fillClass;
      fill.style.width = pctValue + '%';
      track.appendChild(fill);
      row.appendChild(lab);
      row.appendChild(track);
      parent.appendChild(row);
    }

    function renderSystem(summary) {
      storageParts.body.innerHTML = '';
      systemParts.body.innerHTML = '';
      if (!summary) {
        [storageParts, systemParts].forEach(function (parts) {
          var empty = doc.createElement('p');
          empty.className = 'dt-widget-empty';
          empty.textContent = '정보를 불러오지 못했어요';
          parts.body.appendChild(empty);
        });
        return;
      }
      renderBar(
        storageParts.body,
        '메모·자료 저장 공간',
        fmtBytes(summary.d1.used) + ' / ' + fmtBytes(summary.d1.limit),
        summary.d1.pct,
        'is-d1',
      );
      renderBar(
        storageParts.body,
        '첨부파일 저장 공간',
        fmtBytes(summary.cloud.used) + (summary.cloud.limit ? ' / ' + fmtBytes(summary.cloud.limit) : ''),
        summary.cloud.pct,
        'is-cloud',
      );
      // I-07: 첫 화면의 시스템 카드는 기술 합어(Workers·D1·KV·앱을) 저장
      // 사용자 용어로 상태를 보여 준다 (값도 기술 식별자가 아닌 상태 문구).
      [
        ['서비스', '정상 작동 중'],
        ['내 자료', 'MyHub 안에 저장됨'],
        ['동기화', '자동으로 이어짐'],
      ].forEach(function (pair) {
        var row = doc.createElement('div');
        row.className = 'dt-widget-sysrow';
        var b = doc.createElement('b');
        b.textContent = pair[0];
        row.appendChild(b);
        row.appendChild(doc.createTextNode(' · ' + pair[1]));
        systemParts.body.appendChild(row);
      });
    }

    function refreshSystem() {
      return Promise.resolve()
        .then(function () { return fetchFn(SYSTEM_ENDPOINT); })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('system http ' + (res && res.status));
          return res.json();
        })
        .then(function (data) {
          if (!destroyed) renderSystem(summarizeSystem(data));
        })
        .catch(function () {
          if (!destroyed) renderSystem(null);
        });
    }

    // ---- 배치 (positions) + 크기 (sizes) ----
    // 위젯은 아이콘처럼 사용자가 원하는 위치를 앱는다 (사용자 지시
    // 2026-11-02). 위치는 레이어 기본 px 좌표 {x, y}. 2026-11-03
    // 사용으로 앱 가지가 앱해진다: 앱 드래그 중 다른 위젯의 가까워지면
    // 모서리·간격이 이징 붙는 자성 스냅, 앱 우하단 핸들로 크기 조절.
    // 겹침 허용, 레이어 안으로만 clamp한다.
    // 저장: 'myhub.desktop.widgets.v1'앱 { version: 3, positions,
    // sizes }. 구 포맷(순서 배열·v2 positions)을 읽을 때 마이그레이션.
    var POS_KEY = 'myhub.desktop.widgets.v1';
    var CARD_W = 304;
    // 기본 레이아웃 종전 위젯 앱의 화면 위치 그대로다: 오른쪽 앱에
    // 132px 앱의 앱 304 앱 앱 레이어 기본 x = areaW - 132 - 304.
    var COL_RIGHT_INSET = 132;
    var STACK_GAP = MAG_GAP;
    var DRAG_THRESHOLD = 4;
    var MIN_W = 220;
    var MIN_H = 96;
    var WIDGET_IDS = ['today', 'storage', 'system'];
    var storage = deps.storage || null;
    var cardsById = { today: todayCard, storage: storageParts.card, system: systemParts.card };

    function area() {
      if (typeof deps.getArea === 'function') return deps.getArea();
      return { w: container.clientWidth || 0, h: container.clientHeight || 0 };
    }
    function cardSize(card) {
      var r = card && typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
      return { w: (r && r.width) || CARD_W, h: (r && r.height) || 0 };
    }
    /** 위젯의 실효 크기: 사용자가 조절한 크기가 있으면 그것, 없으면 앱. */
    function sizeOf(id) {
      if (sizes[id]) return { w: sizes[id].w, h: sizes[id].h };
      return cardSize(cardsById[id]);
    }
    function applySize(id) {
      var card = cardsById[id];
      if (!card) return;
      if (sizes[id]) {
        card.style.width = sizes[id].w + 'px';
        card.style.height = sizes[id].h + 'px';
      } else {
        card.style.width = '';
        card.style.height = '';
      }
    }
    /** 다른 위젯들의 현재 rect 목록 (자성 스냅·모서리 스냅의 기준). */
    function otherRects(exceptId) {
      var out = [];
      WIDGET_IDS.forEach(function (id) {
        if (id === exceptId || !positions[id]) return;
        var s = sizeOf(id);
        out.push({ x: positions[id].x, y: positions[id].y, w: s.w, h: s.h });
      });
      return out;
    }
    function clampPos(pos, size, a) {
      return {
        x: Math.min(Math.max(0, pos.x), Math.max(0, a.w - size.w)),
        y: Math.min(Math.max(0, pos.y), Math.max(0, a.h - size.h)),
      };
    }

    var positions = {}; // id -> {x, y}
    var sizes = {}; // id -> {w, h} (사용자가 조절한 위젯만)
    // 사용자가 위젯을 실제로 앱한 앱이 있으면, 데이터 위갑 앱의
    // 기본 자격측이 그 배치를 앱 않는다.
    var interacted = false;

    function positionCard(id) {
      var card = cardsById[id];
      if (!card || !positions[id]) return;
      card.style.left = positions[id].x + 'px';
      card.style.top = positions[id].y + 'px';
      applySize(id);
    }
    function applyPositions() {
      WIDGET_IDS.forEach(positionCard);
    }

    function persist() {
      if (!storage) return;
      try {
        storage.setItem(POS_KEY, JSON.stringify({ version: 3, positions: positions, sizes: sizes }));
      } catch (e) {
        console.warn('위젯 배치 저장 실패:', e);
      }
    }

    function readSaved() {
      if (!storage) return null;
      var parsed = null;
      try {
        parsed = JSON.parse(storage.getItem(POS_KEY) || 'null');
      } catch (e) {
        parsed = null;
      }
      if (Array.isArray(parsed)) {
        // 구 포맷: 순서 배열 앱 순서를 유지하고 없는 카드는 앱에 붙인다
        var order = parsed.filter(function (id) { return WIDGET_IDS.indexOf(id) >= 0; });
        WIDGET_IDS.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
        return { legacyOrder: order };
      }
      if (parsed && parsed.positions && typeof parsed.positions === 'object') {
        var savedSizes = {};
        if (parsed.sizes && typeof parsed.sizes === 'object') {
          WIDGET_IDS.forEach(function (id) {
            var s = parsed.sizes[id];
            if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
              savedSizes[id] = {
                w: Math.min(1200, Math.max(MIN_W, Math.round(s.w))),
                h: Math.min(1200, Math.max(MIN_H, Math.round(s.h))),
              };
            }
          });
        }
        return { saved: parsed.positions, sizes: savedSizes };
      }
      return null;
    }

    // 기본 상링은 시작 높이: 바탕화면 아이콘 왼쪽 앞에서 앱 우선으로
    // 채워고, 위젯 앱(오른쪽)과 수평으로 겹칠 앱 있는 아이콘 첫 앱
    // 껍질이다. 기본 상링은 그 첫 앱 아래에서 시작해야 신규 프로필에서
    // 위젯과 아이콘을 가리지 않는다 (2026-11-04 실측 감사 앱 이득:
    // 1280x800에서 '오늘'이 PowerPoint·PDF 아이콘을 앱음). 아이콘 앱
    // 높이는 desktop-icons의 노출 상수를 읽고, 없으면 같은 값으로
    // 대체한다. 저장된 사용자 배치가 있는 경우에는 앱 함수를 앱지
    // 않으므로 기존 배치를 그대로다.
    var ICON_TOP = 10; // desktop-icons cellToXY의 상단 앱과 동일
    function defaultTopInset() {
      var icons = typeof window !== 'undefined' ? window.MyHubDesktopIcons : null;
      var cellH = icons && Number.isFinite(icons.CELL_H) ? icons.CELL_H : 108;
      return ICON_TOP + cellH;
    }

    // 기본 상링: 오른쪽 앱에 앱에서 실제 카드 높이 + 간격으로 앱는다
    function stackDefaults(order) {
      var a = area();
      var x = Math.max(0, a.w - COL_RIGHT_INSET - CARD_W);
      var y = defaultTopInset();
      order.forEach(function (id) {
        var card = cardsById[id];
        if (!card) return;
        positions[id] = { x: x, y: y };
        y += sizeOf(id).h + STACK_GAP;
      });
      applyPositions();
    }

    var savedInfo = readSaved();
    var defaultRegime = !(savedInfo && savedInfo.saved);
    var defaultOrder = savedInfo && savedInfo.legacyOrder ? savedInfo.legacyOrder : WIDGET_IDS;
    if (!defaultRegime) {
      if (savedInfo.sizes) sizes = savedInfo.sizes;
      var a0 = area();
      WIDGET_IDS.forEach(function (id) {
        var p = savedInfo.saved[id];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          positions[id] = clampPos({ x: p.x, y: p.y }, sizeOf(id), a0);
        }
      });
      // 저장낯이 없는 카드는 기본 레이아웃 맨 아래에 붙인다
      var missing = WIDGET_IDS.filter(function (id) { return !positions[id]; });
      if (missing.length) {
        var nextY = 0;
        WIDGET_IDS.forEach(function (id) {
          if (positions[id]) nextY = Math.max(nextY, positions[id].y + sizeOf(id).h + STACK_GAP);
        });
        var mx = Math.max(0, a0.w - COL_RIGHT_INSET - CARD_W);
        missing.forEach(function (id) {
          positions[id] = { x: mx, y: nextY };
          nextY += cardSize(cardsById[id]).h + STACK_GAP;
        });
      }
      applyPositions();
    } else {
      stackDefaults(defaultOrder);
      persist(); // 최초 배치·구 순서 마이그레이션을 v2 포맷으로 굳힌다
    }

    // ---- 크기 조절 핸들 ----
    WIDGET_IDS.forEach(function (id) {
      var handle = doc.createElement('div');
      handle.className = 'dt-widget-resize';
      handle.setAttribute('aria-hidden', 'true');
      handle.dataset.resizeFor = id;
      cardsById[id].appendChild(handle);
    });

    // ---- 드래그 (이동: 자성 스냅 / 크기 조절) ----
    // 아이콘 드래그와 같은 세션 원리: 포인터 캡처를 의존하지 않고
    // doc 레벨 리스너 + pointerId 추적, blur에서는 세션을 버린다.
    var wdrag = null;
    var wrz = null;

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
      if (!core) throw new Error('[widgets.js] anim.js가 먼저 로드되어야 합니다');
      return core.raf(fn);
    }
    function cancelRaf(id) {
      var core = animCore();
      if (!core) throw new Error('[widgets.js] anim.js가 먼저 로드되어야 합니다');
      return core.cancelRaf(id);
    }
    function copyPositions(map) {
      var core = animCore();
      if (!core) throw new Error('[widgets.js] anim.js가 먼저 로드되어야 합니다');
      return core.copyPositions(map);
    }

    // 드래그 중 블러 정확히 2026-11-06 지시로 자의이다 (머티리얼
    // 일관성). 노출 지시만 빈 몸체로 남긴다.
    function setDragPerf(on) {
      void on;
    }

    function onWidgetPointerDown(e) {
      if (destroyed || wdrag || wrz) return;
      if (e.button !== undefined && e.button !== 0) return;
      var card = e.target && e.target.closest ? e.target.closest('.dt-widget') : null;
      if (!card || !container.contains(card)) return;
      var id = card.dataset.widgetId;
      if (!id || !positions[id]) return;
      // 기존 선택(블록) 시작 차단 앱 CSS user-select가 본질, 열고 보조는
      if (e.preventDefault) e.preventDefault();
      // 우하단 핸들에서 시작하면 크기 조절 세션이다 (이동보다 우선)
      if (e.target && e.target.closest && e.target.closest('.dt-widget-resize')) {
        var s0 = sizeOf(id);
        wrz = {
          card: card, id: id, pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY,
          startW: s0.w, startH: s0.h,
          pos: { x: positions[id].x, y: positions[id].y },
          others: otherRects(id),
          cur: { w: s0.w, h: s0.h }, changed: false,
          lastX: e.clientX, lastY: e.clientY, rafId: null,
        };
        card.classList.add('is-resizing');
        setDragPerf(true);
        return;
      }
      // 카드 앱 인터랙티브 요소에서 시작은 조작은 이동이 아니다 (기존 규칙)
      if (e.target && e.target.closest && e.target.closest('input, button, a, textarea, select')) return;
      var size = sizeOf(id);
      wdrag = {
        card: card, id: id, pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        startPos: { x: positions[id].x, y: positions[id].y },
        w: size.w, h: size.h, dx: 0, dy: 0, moved: false,
        others: otherRects(id), snapped: null, rafId: null,
      };
    }
    // 위젯 이동·크기 조절도 창 이동과 같은 이유로 rAF로 합친다:
    // move 이벤트마다 transform/width·height를 직접 쓰면 한 프레임에
    // 여러 번 스타일 재계산·레이아웃이 일어나고, 그려지는 건 마지막
    // 한 번뿐이다 (2026-11-12 성능 점검에서 발견한 어설픈 코드).
    function applyWidgetFrame() {
      var d = wdrag;
      if (!d) return;
      d.rafId = null;
      // 자성 스냅: 다른 위젯의 가까우면 모서리·간격이 붙는 위치로 보인다
      var raw = { x: d.startPos.x + d.dx, y: d.startPos.y + d.dy };
      var snapped = snapWidgetPos(raw, { w: d.w, h: d.h }, d.others);
      d.snapped = snapped;
      d.card.style.transform =
        'translate(' + (snapped.x - d.startPos.x) + 'px,' + (snapped.y - d.startPos.y) + 'px)';
    }
    function applyResizeFrame() {
      var r = wrz;
      if (!r) return;
      r.rafId = null;
      var a = area();
      var nw = Math.min(Math.max(MIN_W, r.startW + (r.lastX - r.startX)), Math.max(MIN_W, a.w - r.pos.x));
      var nh = Math.min(Math.max(MIN_H, r.startH + (r.lastY - r.startY)), Math.max(MIN_H, a.h - r.pos.y));
      // 오른쪽·하단 모서리도 자성: 다른 위젯 모서리·간격이 위치를 붙인다
      var rxCands = [];
      var byCands = [];
      r.others.forEach(function (o) {
        rxCands.push(o.x - MAG_GAP, o.x, o.x + o.w, o.x + o.w + MAG_GAP);
        byCands.push(o.y - MAG_GAP, o.y, o.y + o.h, o.y + o.h + MAG_GAP);
      });
      nw = Math.max(MIN_W, snapEdge(r.pos.x + nw, rxCands) - r.pos.x);
      nh = Math.max(MIN_H, snapEdge(r.pos.y + nh, byCands) - r.pos.y);
      r.cur = { w: Math.round(nw), h: Math.round(nh) };
      r.changed = r.cur.w !== r.startW || r.cur.h !== r.startH;
      r.card.style.width = r.cur.w + 'px';
      r.card.style.height = r.cur.h + 'px';
    }
    function onWidgetPointerMove(e) {
      if (wrz) {
        if (wrz.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== wrz.pointerId) return;
        wrz.lastX = e.clientX;
        wrz.lastY = e.clientY;
        if (wrz.rafId === null || wrz.rafId === undefined) {
          wrz.rafId = raf(applyResizeFrame);
        }
        return;
      }
      if (!wdrag) return;
      if (wdrag.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== wdrag.pointerId) return;
      wdrag.dx = e.clientX - wdrag.startX;
      wdrag.dy = e.clientY - wdrag.startY;
      if (!wdrag.moved) {
        if (Math.abs(wdrag.dx) <= DRAG_THRESHOLD && Math.abs(wdrag.dy) <= DRAG_THRESHOLD) return;
        wdrag.moved = true;
        wdrag.card.classList.add('is-dragging');
        setDragPerf(true);
      }
      if (wdrag.rafId === null || wdrag.rafId === undefined) {
        wdrag.rafId = raf(applyWidgetFrame);
      }
    }

    function finishWidgetDrag(commit) {
      if (!wdrag) return;
      var d = wdrag;
      if (d.rafId !== null && d.rafId !== undefined) {
        cancelRaf(d.rafId);
        d.rafId = null;
        // 대기 중이던 마지막 move 프레임을 동기 반영해 드롭 위치가
        // pointerup 직전 최신 좌표를 쓰게 한다 (wdrag를 null로 하기 전).
        applyWidgetFrame();
      }
      wdrag = null;
      setDragPerf(false);
      d.card.classList.remove('is-dragging');
      d.card.style.transform = '';
      if (commit && d.moved) {
        interacted = true;
        // 드롭 확정 위치도 스냅한 위치 (레이어 안으로만 clamp)
        var target = d.snapped || { x: d.startPos.x + d.dx, y: d.startPos.y + d.dy };
        positions[d.id] = clampPos(target, { w: d.w, h: d.h }, area());
        positionCard(d.id);
        persist();
      }
    }
    function finishResize(commit) {
      if (!wrz) return;
      var r = wrz;
      if (r.rafId !== null && r.rafId !== undefined) {
        cancelRaf(r.rafId);
        r.rafId = null;
        // 대기 중이던 마지막 move 프레임을 동기 반영해 최종 크기가
        // pointerup 직전 최신 좌표를 쓰게 한다 (wrz를 null로 하기 전).
        applyResizeFrame();
      }
      wrz = null;
      setDragPerf(false);
      r.card.classList.remove('is-resizing');
      if (commit && r.changed) {
        interacted = true;
        sizes[r.id] = { w: r.cur.w, h: r.cur.h };
        persist();
      }
      applySize(r.id);
      // 크기가 바를면 레이어 밖으로 나건 분이 앱으로 돌아인다
      var clamped = clampPos(positions[r.id], sizeOf(r.id), area());
      if (clamped.x !== positions[r.id].x || clamped.y !== positions[r.id].y) {
        positions[r.id] = clamped;
        if (commit && r.changed) persist();
      }
      positionCard(r.id);
    }
    function onWidgetPointerUp(e) {
      if (wrz) {
        if (wrz.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== wrz.pointerId) return;
        finishResize(true);
        return;
      }
      if (!wdrag) return;
      if (wdrag.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== wdrag.pointerId) return;
      finishWidgetDrag(true);
    }
    // 창 사용 중 멈추면 진행 중인 드래그를 (버린다 앱방지)
    function onWindowBlur() {
      finishWidgetDrag(false);
      finishResize(false);
    }
    container.addEventListener('pointerdown', onWidgetPointerDown);
    doc.addEventListener('pointermove', onWidgetPointerMove);
    doc.addEventListener('pointerup', onWidgetPointerUp);
    doc.addEventListener('pointercancel', onWidgetPointerUp);
    if (typeof window !== 'undefined') window.addEventListener('blur', onWindowBlur);

    function onResize() {
      if (destroyed) return;
      // 자유 좌표는 그대로 남되, 영역이 줄어 밖에 나간 카드만 앱으로
      var a = area();
      var changed = false;
      WIDGET_IDS.forEach(function (id) {
        if (!positions[id]) return;
        var clamped = clampPos(positions[id], sizeOf(id), a);
        if (clamped.x !== positions[id].x || clamped.y !== positions[id].y) changed = true;
        positions[id] = clamped;
        positionCard(id);
      });
      if (changed) persist();
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

    var ready = refresh();
    var systemReady = refreshSystem();
    // 카드 높이는 최초 데이터가 그려진 앱에서 확정한다. 저장된 배치값
    // 없는 경우(기본 상링 전체)는 제외, 사용자가 아직 앱하지 않으면
    // 앱 높이로 앱 번 다시 상링이 겹침을 막는다.
    if (defaultRegime) {
      Promise.all([ready, systemReady]).then(function () {
        if (destroyed || interacted) return;
        stackDefaults(defaultOrder);
        persist();
      });
    }

    return {
      refresh: refresh,
      refreshSystem: refreshSystem,
      ready: ready,
      getPositions: function () {
        return copyPositions(positions);
      },
      getSizes: function () {
        var out = {};
        Object.keys(sizes).forEach(function (k) { out[k] = { w: sizes[k].w, h: sizes[k].h }; });
        return out;
      },
      destroy: function () {
        destroyed = true;
        finishWidgetDrag(false);
        finishResize(false);
        container.removeEventListener('pointerdown', onWidgetPointerDown);
        doc.removeEventListener('pointermove', onWidgetPointerMove);
        doc.removeEventListener('pointerup', onWidgetPointerUp);
        doc.removeEventListener('pointercancel', onWidgetPointerUp);
        if (typeof window !== 'undefined') window.removeEventListener('blur', onWindowBlur);
        if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
        todayCard.remove();
        storageParts.card.remove();
        systemParts.card.remove();
      },
    };
  }

  var api = {
    ENDPOINT: ENDPOINT,
    SYSTEM_ENDPOINT: SYSTEM_ENDPOINT,
    fmtBytes: fmtBytes,
    summarizeBriefing: summarizeBriefing,
    summarizeSystem: summarizeSystem,
    snapWidgetPos: snapWidgetPos,
    SNAP_DIST: SNAP_DIST,
    WIDGET_GAP: MAG_GAP,
    createManager: createManager,
  };
  if (typeof window !== 'undefined') window.MyHubDesktopWidgets = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopWidgets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
