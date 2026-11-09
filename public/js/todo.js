// 할일 페이지 로직 등 파일 길이 규칙 줄(500를)위해 의 todo.html인라인 를 IIFE동등 처럼 순간 (2026-11-01)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var curStatus = 'pending';
  var editingId = null;
  var cache = { pending: [], done: [] };
  var searchQuery = '';
  var PRI_LABEL = { 2: '높음', 1: '보통', 0: '낮음' };

  function refreshIcons() { if (window.lucide) lucide.createIcons(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function fmtDue(due) {
    if (!due) return '';
    var d = new Date(due.length === 16 ? due + ':00' : due);
    if (isNaN(d.getTime())) return esc(due);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var s = d.toLocaleString('ko-KR', sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    var overdue = d < now;
    return '<span class="due' + (overdue ? ' over' : '') + '">' + esc(s) + '</span>';
  }

  // I-09 배선 서버 (2026-11-05): 오 류의 공통 오류 문구 맵
  // (public/js/common/error-messages.js의 friendlyErrorMessage)를 거쳐
  // 표시 한다 등 자체(decrypt_failed코드"서버 오류 (500)" 등)화 면에
  // 내지 않고 코드로만 남긴다. 맵 스크립트가 없을 때도 자체 코드 패턴을
  // 읽고 대관 문구를 낸다 (chat.js와 같은 fail-safe). 'unauth' 표시
  // 표시 변환 전에 노출된 원본 message로 확정하므로 여기다 넣지 않는다.
  function friendlyError(input, fallback) {
    var fn = (typeof window !== 'undefined') ? window.friendlyErrorMessage : undefined;
    if (typeof fn === 'function') {
      try { return fn(input, fallback); } catch (e) { console.warn('오류 문구 변환 실패:', e); }
    }
    var raw = '';
    if (typeof input === 'string') raw = input;
    else if (input && typeof input === 'object') {
      raw = (input.error && typeof input.error === 'object' ? (input.error.code || input.error.message || '') : '')
        || (typeof input.error === 'string' ? input.error : '')
        || input.code || input.message || '';
    }
    if (typeof raw === 'string' && raw) {
      var t = raw.trim();
      if (/^http_\d{3}$/i.test(t) || /^서버 오류\s*\(\d{3}\)$/.test(t)
        || /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(t)
        || /^[A-Z]{2,}$/.test(t)) {
        console.warn('[MyHub] 오류 코드:', t);
        return fallback;
      }
      return raw;
    }
    return fallback;
  }

  async function api(path, method, body) {
    var res = await fetch('/api/todo' + path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    var data = null;
    try { data = await res.json(); } catch (e) { console.warn('일시 응답 파싱 실패:', e); data = null; }
    // HTTP 오류{ok:false}성공 으로 취급하지 않는다 (일정 등 api와 동일 규칙).
    // 실패를 실패면 입력소실 상태 차이로 남기므로 노출된 그대로 throw고정한다.
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || ('서버 오류 (' + res.status + ')'));
    }
    return data;
  }

  // 커스텀 확인 모달 (브라우저 confirm 대체 - 자동 테스트 값은, 일정 성공과 동일 패턴)
  function confirmDelete(msg) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'todo-confirm-overlay';
      overlay.innerHTML =
        '<div class="todo-confirm-modal">' +
          '<p>' + esc(msg) + '</p>' +
          '<div class="todo-confirm-btns">' +
            '<button class="todo-confirm-no">취소</button>' +
            '<button class="todo-confirm-yes danger">삭제</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      var cleanup = function () {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
      };
      var onKeydown = function (e) {
        if (e.key === 'Escape') { cleanup(); resolve(false); }
      };
      document.addEventListener('keydown', onKeydown);
      overlay.querySelector('.todo-confirm-no').onclick = function () { cleanup(); resolve(false); };
      overlay.querySelector('.todo-confirm-yes').onclick = function () { cleanup(); resolve(true); };
      overlay.onclick = function (e) { if (e.target === overlay) { cleanup(); resolve(false); } };
    });
  }

  // 할 일 고정 (브라우저 alert 대체 등 일정 등 showSchedNotice와 같은 패턴)
  var noticeTimer = null;
  function showNotice(text) {
    var el = $('todoNotice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'todoNotice';
      el.className = 'todo-notice';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
    }
    el.textContent = text;
    // 처음 프레임에 .show를 붙여도 등장 너비(transition)가 걸린다
    requestAnimationFrame(function () { el.classList.add('show'); });
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { el.classList.remove('show'); }, 6000);
  }

  async function loadAll() {
    var p = await api('/list?status=pending');
    var d = await api('/list?status=done');
    cache.pending = (p.todos || []);
    cache.done = (d.todos || []);
    $('cntPending').textContent = cache.pending.length || '';
    $('cntDone').textContent = cache.done.length || '';
    render();
  }

  function items() {
    var base = curStatus === 'pending' ? cache.pending
      : curStatus === 'done' ? cache.done
      : cache.pending.concat(cache.done);
    if (!searchQuery) return base;
    return base.filter(function (t) {
      return ((t.title || '') + '\n' + (t.description || '')).toLowerCase().indexOf(searchQuery) !== -1;
    });
  }

  // 드래그 정렬 가능 조건: 검색 중이 아니고, 단일 상태 탭일 때
  function canReorder() {
    return !searchQuery && (curStatus === 'pending' || curStatus === 'done');
  }

  // 검색어 하이라이트 (XSS 안전: 이스케이프 후 마킹)
  function hi(text) {
    var e = esc(text);
    if (!searchQuery) return e;
    var q = esc(searchQuery).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return e.replace(new RegExp('(' + q + ')', 'gi'), '<mark>$1</mark>');
  }

  function render() {
    var list = items();
    var el = $('todoList');
    if (!list.length) {
      var msg = searchQuery ? '검색 결과가 없어요'
        : curStatus === 'done' ? '완료된 할일이 없어요' : '할일을 입력해 보세요';
      el.innerHTML = '<div class="empty"><i data-lucide="check"></i><br>' + msg + '</div>';
      refreshIcons();
      return;
    }
    var reorder = canReorder();
    el.innerHTML = list.map(function (t) {
      var done = t.status === 'done';
      return '<div class="todo-row' + (done ? ' done' : '') + (reorder ? '' : ' no-drag') + '" data-id="' + t.id + '"' +
        (reorder ? ' draggable="true"' : '') + '>' +
        '<span class="drag-handle" data-act="drag" aria-label="순서 변경"><i data-lucide="grip-vertical"></i></span>' +
        '<button class="check' + (done ? ' on' : '') + '" data-act="toggle" aria-label="완료 토글">' +
          (done ? '<i data-lucide="check"></i>' : '') + '</button>' +
        '<div class="t-body">' +
          '<div class="t-title">' + hi(t.title) + '</div>' +
          ((t.due_at || t.priority !== 1) ?
            '<div class="t-meta">' +
              (t.priority !== 1 ? '<span class="pri p' + t.priority + '">' + PRI_LABEL[t.priority] + '</span>' : '') +
              (t.due_at ? fmtDue(t.due_at) : '') +
            '</div>' : '') +
        '</div>' +
        '<div class="t-act">' +
          '<button data-act="edit">편집</button>' +
          '<button data-act="del">삭제</button>' +
        '</div>' +
      '</div>';
    }).join('');
    refreshIcons();
  }

  function openModal(id) {
    editingId = id || null;
    $('modalTitle').textContent = id ? '할일 편집' : '할일 추가';
    if (id) {
      var t = cache.pending.concat(cache.done).find(function (x) { return x.id === id; });
      $('fTitle').value = t ? t.title : '';
      $('fDesc').value = t ? (t.description || '') : '';
      $('fDue').value = t && t.due_at ? t.due_at.slice(0, 16) : '';
      $('fPri').value = t ? String(t.priority) : '1';
    } else {
      $('fTitle').value = ''; $('fDesc').value = ''; $('fDue').value = ''; $('fPri').value = '1';
    }
    $('modalBack').classList.add('open');
    setTimeout(function () { $('fTitle').focus(); }, 50);
  }
  function closeModal() { $('modalBack').classList.remove('open'); editingId = null; }

  async function saveModal() {
    var title = $('fTitle').value.trim();
    if (!title) { return; }
    var body = {
      title: title,
      description: $('fDesc').value.trim(),
      due_at: $('fDue').value || null,
      priority: Number($('fPri').value),
    };
    try {
      if (editingId) { await api('/' + editingId, 'PUT', body); }
      else { await api('/create', 'POST', body); }
    } catch (e) {
      // 실패 등 모달을 다시 닫고 입력은 유지한다
      if (e.message !== 'unauth') showNotice('저장 실패: ' + friendlyError(e, '잠시 후 다시 시도해 주세요.'));
      return;
    }
    closeModal();
    await loadAll().catch(function (e) { if (e.message !== 'unauth') console.error(e); });
  }

  async function quickAdd() {
    var v = $('quickInput').value.trim();
    if (!v) return;
    try {
      await api('/create', 'POST', { title: v });
    } catch (e) {
      // 실패 등 입력창을 비우지 않는다 (예고 소실 방지)
      if (e.message !== 'unauth') showNotice('저장 실패: ' + friendlyError(e, '잠시 후 다시 시도해 주세요.'));
      return;
    }
    $('quickInput').value = '';
    await loadAll().catch(function (e) { if (e.message !== 'unauth') console.error(e); });
  }

  // ---------- 드래그 정렬 ----------
  var dragId = null;        // HTML5 DnD 중인 id
  var dragJustEnded = false; // 터치 드래그 직후 클릭 무시 플래그

  function clearDropHints() {
    document.querySelectorAll('.todo-row.drop-before, .todo-row.drop-after').forEach(function (r) {
      r.classList.remove('drop-before', 'drop-after');
    });
  }

  function dropPos(row, clientY) {
    var rect = row.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  }

  // 낙관적 재정렬 + 서버 저장
  function commitReorder(draggedId, targetId, pos) {
    var list = items();
    var ids = list.map(function (t) { return t.id; });
    var from = ids.indexOf(draggedId);
    if (from < 0) return;
    ids.splice(from, 1);
    var to = ids.indexOf(targetId);
    if (to < 0) return;
    if (pos === 'after') to += 1;
    ids.splice(to, 0, draggedId);
    var arr = curStatus === 'pending' ? cache.pending : cache.done;
    var order = {};
    ids.forEach(function (id, i) { order[id] = i; });
    arr.sort(function (a, b) { return (order[a.id] == null ? 9999 : order[a.id]) - (order[b.id] == null ? 9999 : order[b.id]); });
    render();
    api('/reorder', 'PUT', { ids: ids }).catch(function (err) {
      var msg = '순서 저장 실패: ' + friendlyError(err, '잠시 후 다시 시도해 주세요.');
      // 실패를 알리고, 화면 순서를 서버 상태로 되돌 린다
      loadAll().then(function () {
        showNotice(msg + ' 등 원래 순서로 되돌렸어요');
      }).catch(function (e) {
        console.warn('수정 실패 등 목록 갱신 실패:', e);
        showNotice(msg);
      });
    });
  }

  // --- 데스크톱: HTML5 DnD ---
  $('todoList').addEventListener('dragstart', function (e) {
    if (!canReorder()) { e.preventDefault(); return; }
    if (e.target.closest('.t-act, .check')) { e.preventDefault(); return; }
    var row = e.target.closest('.todo-row');
    if (!row) { e.preventDefault(); return; }
    dragId = Number(row.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (err) { console.warn('드래그 데이터 설정 실패:', err); }
    setTimeout(function () { row.classList.add('dragging'); }, 0);
  });

  $('todoList').addEventListener('dragover', function (e) {
    if (dragId == null || !canReorder()) return;
    var row = e.target.closest('.todo-row');
    if (!row || row.classList.contains('dragging')) { clearDropHints(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropHints();
    row.classList.add('drop-' + dropPos(row, e.clientY));
  });

  $('todoList').addEventListener('dragleave', function (e) {
    var row = e.target.closest('.todo-row');
    if (row && !(e.relatedTarget && row.contains(e.relatedTarget))) {
      row.classList.remove('drop-before', 'drop-after');
    }
  });

  $('todoList').addEventListener('drop', function (e) {
    if (dragId == null || !canReorder()) return;
    var row = e.target.closest('.todo-row');
    e.preventDefault();
    clearDropHints();
    if (!row) return;
    var targetId = Number(row.dataset.id);
    var pos = dropPos(row, e.clientY);
    var id = dragId;
    dragId = null;
    if (id !== targetId) commitReorder(id, targetId, pos);
  });

  $('todoList').addEventListener('dragend', function () {
    dragId = null;
    clearDropHints();
    document.querySelectorAll('.todo-row.dragging').forEach(function (r) { r.classList.remove('dragging'); });
  });

  // --- 모바일: 핸들 길게 누르기 → 터치 드래그 ---
  var lpTimer = null;
  var lpStart = null;
  var touchDrag = null;

  $('todoList').addEventListener('touchstart', function (e) {
    if (!canReorder()) return;
    var handle = e.target.closest('.drag-handle');
    if (!handle) return;
    var row = handle.closest('.todo-row');
    var t = e.touches[0];
    lpStart = { x: t.clientX, y: t.clientY };
    var id = Number(row.dataset.id);
    lpTimer = setTimeout(function () {
      lpTimer = null;
      startTouchDrag(id, row, t.clientX, t.clientY);
    }, 450);
  }, { passive: true });

  function cancelLongPress() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    lpStart = null;
  }

  function startTouchDrag(id, row, x, y) {
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { console.warn('진동 실패:', e); } }
    var rect = row.getBoundingClientRect();
    var floatEl = row.cloneNode(true);
    floatEl.classList.add('drag-float');
    floatEl.classList.remove('drop-before', 'drop-after', 'dragging');
    floatEl.style.width = rect.width + 'px';
    floatEl.style.left = rect.left + 'px';
    floatEl.style.top = rect.top + 'px';
    document.body.appendChild(floatEl);
    row.classList.add('dragging');
    touchDrag = { id: id, row: row, floatEl: floatEl, dx: x - rect.left, dy: y - rect.top, targetId: null, pos: null };
  }

  function endTouchDrag(commit) {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    lpStart = null;
    if (!touchDrag) return;
    var td = touchDrag;
    touchDrag = null;
    td.floatEl.remove();
    td.row.classList.remove('dragging');
    clearDropHints();
    // 드래그 직후 합성 클릭 무시
    dragJustEnded = true;
    setTimeout(function () { dragJustEnded = false; }, 150);
    if (commit && td.targetId != null && td.targetId !== td.id) {
      commitReorder(td.id, td.targetId, td.pos);
    }
  }

  document.addEventListener('touchmove', function (e) {
    if (lpTimer && lpStart) {
      var s = e.touches[0];
      if (Math.hypot(s.clientX - lpStart.x, s.clientY - lpStart.y) > 10) cancelLongPress();
      return;
    }
    if (!touchDrag) return;
    e.preventDefault(); // 드래그 중 스크롤 방지
    var t = e.touches[0];
    touchDrag.floatEl.style.left = (t.clientX - touchDrag.dx) + 'px';
    touchDrag.floatEl.style.top = (t.clientY - touchDrag.dy) + 'px';
    clearDropHints();
    var el = document.elementFromPoint(t.clientX, t.clientY);
    var row = el && el.closest ? el.closest('.todo-row') : null;
    if (row && !row.classList.contains('dragging')) {
      var pos = dropPos(row, t.clientY);
      row.classList.add('drop-' + pos);
      touchDrag.targetId = Number(row.dataset.id);
      touchDrag.pos = pos;
    } else {
      touchDrag.targetId = null;
      touchDrag.pos = null;
    }
  }, { passive: false });

  document.addEventListener('touchend', function () { endTouchDrag(true); });
  document.addEventListener('touchcancel', function () { endTouchDrag(false); });

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (!b) return;
    curStatus = b.dataset.status;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t === b); });
    render();
  });

  $('todoList').addEventListener('click', async function (e) {
    if (dragJustEnded) return;
    var btn = e.target.closest('[data-act]');
    var row = e.target.closest('.todo-row');
    if (!row) return;
    var id = Number(row.dataset.id);
    // 행 클릭 = 토글 (버튼이 아닌 경우)
    if (!btn) {
      try {
        await api('/' + id + '/toggle', 'POST');
        await loadAll();
      } catch (err) {
        if (err.message !== 'unauth') showNotice('변경 실패: ' + friendlyError(err, '잠시 후 다시 시도해 주세요.'));
      }
      return;
    }
    var act = btn.dataset.act;
    e.stopPropagation();
    if (act === 'toggle') {
      try {
        await api('/' + id + '/toggle', 'POST');
        await loadAll();
      } catch (err) {
        if (err.message !== 'unauth') showNotice('변경 실패: ' + friendlyError(err, '잠시 후 다시 시도해 주세요.'));
      }
    } else if (act === 'edit') {
      openModal(id);
    } else if (act === 'del') {
      if (await confirmDelete('삭제할까요?')) {
        try {
          await api('/' + id, 'DELETE');
          await loadAll();
        } catch (err) {
          if (err.message !== 'unauth') showNotice('삭제 실패: ' + friendlyError(err, '잠시 후 다시 시도해 주세요.'));
        }
      }
    }
  });

  $('addBtn').addEventListener('click', function () { openModal(null); });
  $('cancelBtn').addEventListener('click', closeModal);
  $('saveBtn').addEventListener('click', saveModal);
  $('modalBack').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  $('quickInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') quickAdd(); });
  $('searchInput').addEventListener('input', function (e) {
    searchQuery = e.target.value.trim().toLowerCase();
    render();
  });
  // 네이티브 검색 취소(x) 버튼 대응
  $('searchInput').addEventListener('search', function (e) {
    if (!e.target.value) { searchQuery = ''; render(); }
  });
  $('fTitle').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveModal(); });

  // AI가 등 일을 바꿔 등 노출된 등 전체 새로고침 없이 목록만 다시 불러온다
  window.refreshAfterAI = function () {
    loadAll().catch(function (e) { if (e.message !== 'unauth') console.error(e); });
  };

  /* 창 상단 메뉴바 정의 (공유: js/desktop/windows.js 상단 주석).
     상태 탭 선택 checked표시로 현재 필터를 표시한다. 정렬된
     등 칸에 없는 기능(드래그 수정만 있다)이라 넣지 않는다. */
  window.MyHubMenus = [
    {
      label: '할 일',
      items: [{ label: '새 할 일', target: '#addBtn' }],
    },
    {
      label: '보기',
      items: [
        { label: '진행중', checked: function () { return curStatus === 'pending'; }, target: '.tab[data-status="pending"]' },
        { label: '완료', checked: function () { return curStatus === 'done'; }, target: '.tab[data-status="done"]' },
        { label: '전체', checked: function () { return curStatus === 'all'; }, target: '.tab[data-status="all"]' },
      ],
    },
  ];

  refreshIcons();
  loadAll().catch(function (e) { if (e.message !== 'unauth') console.error(e); });
})();
