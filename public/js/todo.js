// 할 일 페이지 로직 (todo.html 인라인에서 추출 — TODO_CSP script-src 'self' enforce 대응)
// 위젯 초기화와 refreshAfterAI는 원래 인라인 블록에 있던 것을 함께 옮겼다.
window.refreshAfterAI = function() { if (typeof loadTodos === "function") loadTodos(); else location.reload(); };
if (window.AssistantWidget) AssistantWidget.init({ personaId: "scheduler", personaName: "캘리", avatar: "/avatars/cali.webp" });

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

  async function api(path, method, body) {
    var res = await fetch('/api/todo' + path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    return res.json();
  }

  async function loadAll() {
    var p = await api('/list?status=pending');
    var d = await api('/list?status=done');
    cache.pending = (p.todos || []);
    cache.done = (d.todos || []);
    $('cntPending').textContent = cache.pending.length || '';
    $('cntDone').textContent = cache.done.length || '';
    var total = cache.pending.length + cache.done.length;
    $('headCount').textContent = total ? total + '개' : '';
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
    if (editingId) { await api('/' + editingId, 'PUT', body); }
    else { await api('/create', 'POST', body); }
    closeModal();
    await loadAll();
  }

  /* 삭제 확인은 인페이지 모달로 한다. 네이티브 confirm()은 셸 iframe·자동
   * 해제 환경에서 false로 조용히 떨어져 삭제가 무반응이 되는 결함이 있었다
   * (F2 스튜디오·일정과 같은 전례 — F4에서 할 일도 같은 방식으로 교체). */
  function confirmDelete(title) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'modal-back open';
      back.innerHTML =
        '<div class="modal">' +
          '<h3>삭제할까요?</h3>' +
          '<p class="confirm-msg"></p>' +
          '<div class="modal-acts">' +
            '<button type="button" class="m-btn ghost">취소</button>' +
            '<button type="button" class="m-btn danger">삭제</button>' +
          '</div>' +
        '</div>';
      back.querySelector('.confirm-msg').textContent = '"' + (title || '이 항목') + '"을(를) 삭제합니다.';
      document.body.appendChild(back);
      function done(v) {
        back.remove();
        resolve(v);
      }
      back.querySelector('.m-btn.ghost').addEventListener('click', function () { done(false); });
      back.querySelector('.m-btn.danger').addEventListener('click', function () { done(true); });
      back.addEventListener('click', function (e) { if (e.target === back) done(false); });
    });
  }

  async function quickAdd() {
    var v = $('quickInput').value.trim();
    if (!v) return;
    await api('/create', 'POST', { title: v });
    $('quickInput').value = '';
    await loadAll();
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
    api('/reorder', 'PUT', { ids: ids }).catch(function () { loadAll(); });
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
      await api('/' + id + '/toggle', 'POST');
      await loadAll();
      return;
    }
    var act = btn.dataset.act;
    e.stopPropagation();
    if (act === 'toggle') {
      await api('/' + id + '/toggle', 'POST');
      await loadAll();
    } else if (act === 'edit') {
      openModal(id);
    } else if (act === 'del') {
      var target = cache.pending.concat(cache.done).find(function (x) { return x.id === id; });
      if (await confirmDelete(target ? target.title : '')) {
        await api('/' + id, 'DELETE');
        await loadAll();
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

  refreshIcons();
  loadAll().catch(function (e) { if (e.message !== 'unauth') console.error(e); });
})();
  window.refreshAfterAI = function() { if (typeof loadTodos === "function") loadTodos(); else location.reload(); };
