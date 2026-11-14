// 일정 페이지 로직 등 파일 길이 규칙(500줄를)위해 의 schedule.html인라인 를 IIFE동등 처럼 순간 (2026-11-01)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var viewY, viewM, selDate;
  var viewMode = 'month'; // 'month' | 'week' | 'day'
  var monthCache = {};

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function parseDate(s) { return new Date(s + 'T12:00:00'); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return ymd(d); }
  function weekStartOf(s) { var d = parseDate(s); d.setDate(d.getDate() - d.getDay()); return ymd(d); }
  // esc·friendlyError는 공용 코어(common/text-utils.js)가 맡는다 (F-L3, 5-4).
  // 코어는 이 파일보다 먼저 받아야 한다 (schedule.html 정적 태그 순서).
  var textUtils = typeof window !== 'undefined' ? window.MyHubTextUtils : null;
  if (!textUtils) throw new Error('[schedule.js] text-utils.js가 먼저 로드되어야 합니다');
  var esc = textUtils.esc;
  var friendlyError = textUtils.friendlyError;
  function fmtTime(iso) { return iso ? (iso.slice(11, 16) || '') : ''; }

  async function api(path, opts) {
    var res = await fetch(path, opts);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('http_' + res.status));
    return data;
  }

  async function loadMonth(y, m) {
    var key = y + '-' + pad(m + 1);
    var lastDay = new Date(y, m + 1, 0).getDate();
    var data = await api('/api/schedule/list?from=' + key + '-01&to=' + key + '-' + pad(lastDay) + '&status=active&limit=500');
    monthCache[key] = data.schedules || [];
    return monthCache[key];
  }

  // 현재 보 기를 보여 주는 날짜 범위 등 등 보는 42그리드 전체(먼저 등 포함)
  function visibleRange() {
    if (viewMode === 'week') { var ws = weekStartOf(selDate); return [ws, addDays(ws, 6)]; }
    if (viewMode === 'day') return [selDate, selDate];
    var firstDow = new Date(viewY, viewM, 1).getDay();
    var start = new Date(viewY, viewM, 1 - firstDow);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 41);
    return [ymd(start), ymd(end)];
  }

  async function loadRange(fromStr, toStr) {
    var d = parseDate(fromStr);
    var end = parseDate(toStr);
    var guard = 0;
    while (d <= end && guard++ < 5) {
      var key = d.getFullYear() + '-' + pad(d.getMonth() + 1);
      if (!monthCache[key]) await loadMonth(d.getFullYear(), d.getMonth());
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
  }

  async function ensureVisibleLoaded() { var r = visibleRange(); await loadRange(r[0], r[1]); }

  async function reloadVisible() {
    monthCache = {};
    await ensureVisibleLoaded();
  }

  function eventsOn(dateStr) {
    var list = monthCache[dateStr.slice(0, 7)] || [];
    return list.filter(function (s) { return (s.start_at || '').slice(0, 10) === dateStr; });
  }

  function render() {
    // 주/일 보기에서는 viewY/viewM의 선택일의 주로 동기화 등 등 보기로 파악한 같은 등
    if (viewMode !== 'month') { var sd = parseDate(selDate); viewY = sd.getFullYear(); viewM = sd.getMonth(); }
    $('calGrid').style.display = viewMode === 'month' ? '' : 'none';
    $('weekGrid').style.display = viewMode === 'week' ? '' : 'none';
    $('dayView').style.display = viewMode === 'day' ? '' : 'none';
    document.querySelector('.cal-layout').classList.toggle('mode-day', viewMode === 'day');
    document.querySelectorAll('.vs-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.view === viewMode); });
    $('prevM').setAttribute('aria-label', viewMode === 'month' ? '이전 달' : viewMode === 'week' ? '이전 주' : '이전 일');
    $('nextM').setAttribute('aria-label', viewMode === 'month' ? '다음 달' : viewMode === 'week' ? '다음 주' : '다음 일');
    if (viewMode === 'month') renderMonth();
    else if (viewMode === 'week') renderWeek();
    else renderDayView();
    renderDay();
    refreshIcons();
  }

  function renderMonth() {
    $('calTitle').textContent = viewY + '년 ' + (viewM + 1) + '월';
    var grid = $('calGrid');
    grid.innerHTML = '';
    var dows = ['일', '월', '화', '수', '목', '금', '토'];
    var isMobile = window.innerWidth <= 640;
    dows.forEach(function (d, i) {
      var el = document.createElement('div');
      el.className = 'cal-dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
      el.textContent = d;
      grid.appendChild(el);
    });
    var firstDow = new Date(viewY, viewM, 1).getDay();
    var daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    var tStr = todayStr();
    for (var i = 0; i < 42; i++) {
      var dayN = i - firstDow + 1;
      var dt = new Date(viewY, viewM, dayN);
      var dateStr = ymd(dt);
      var other = dayN < 1 || dayN > daysInMonth;
      var isSun = dt.getDay() === 0;
      var isSat = dt.getDay() === 6;
      var cell = document.createElement('div');
      cell.className = 'cal-cell' + (other ? ' other' : '') + (dateStr === tStr ? ' today' : '') + (isSun ? ' sun' : '') + (isSat ? ' sat' : '') + (dateStr === selDate ? ' selected' : '');
      var num = document.createElement('div');
      num.className = 'dnum';
      num.textContent = dt.getDate();
      cell.appendChild(num);
      var evs = eventsOn(dateStr);
      if (evs.length) {
        if (isMobile) {
          var dots = document.createElement('div');
          dots.className = 'dots';
          evs.slice(0, 4).forEach(function (s) {
            var d = document.createElement('span');
            d.className = 'dot' + (s.status === 'done' ? ' done' : '');
            dots.appendChild(d);
          });
          cell.appendChild(dots);
        } else {
          evs.slice(0, 2).forEach(function (s) {
            var lb = document.createElement('div');
            lb.className = 'ev-label';
            lb.textContent = (fmtTime(s.start_at) ? fmtTime(s.start_at) + ' ' : '') + s.title;
            lb.title = s.title;
            (function (ev) { lb.addEventListener('click', function (e) { e.stopPropagation(); openModal(ev); }); })(s);
            cell.appendChild(lb);
          });
          if (evs.length > 2) {
            var more = document.createElement('div');
            more.className = 'ev-label';
            more.style.color = 'var(--faint)';
            more.textContent = '+' + (evs.length - 2);
            cell.appendChild(more);
          }
        }
      }
      // 먼저 등 날짜 클릭하면 그 날짜로 주로 이동해 선택한다 (일반 캘린더 거동).
      // 안전한대 viewY/viewM는 그대로 패널이 빈 채널로 남는 것뿐 이었다.
      (function (ds, isOther) {
        cell.addEventListener('click', async function () {
          selDate = ds;
          if (isOther) {
            var dd = parseDate(ds);
            viewY = dd.getFullYear(); viewM = dd.getMonth();
            await ensureVisibleLoaded();
          }
          render();
        });
      })(dateStr, other);
      grid.appendChild(cell);
    }
  }

  function weekTitle(ws) {
    var a = parseDate(ws), b = parseDate(addDays(ws, 6));
    var head = a.getFullYear() + '년 ' + (a.getMonth() + 1) + '월 ' + a.getDate() + '일';
    var tail;
    if (b.getFullYear() !== a.getFullYear()) tail = b.getFullYear() + '년 ' + (b.getMonth() + 1) + '월 ' + b.getDate() + '일';
    else if (b.getMonth() !== a.getMonth()) tail = (b.getMonth() + 1) + '월 ' + b.getDate() + '일';
    else tail = b.getDate() + '일';
    return head + ' – ' + tail;
  }

  function selectDate(ds) {
    selDate = ds;
    render();
  }

  function renderWeek() {
    var ws = weekStartOf(selDate);
    $('calTitle').textContent = weekTitle(ws);
    var box = $('weekGrid');
    box.innerHTML = '';
    var dows = ['일', '월', '화', '수', '목', '금', '토'];
    var tStr = todayStr();
    for (var i = 0; i < 7; i++) {
      var ds = addDays(ws, i);
      var dt = parseDate(ds);
      var col = document.createElement('div');
      col.className = 'wk-col' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + (ds === tStr ? ' today' : '') + (ds === selDate ? ' selected' : '');
      col.dataset.date = ds;
      var head = document.createElement('div');
      head.className = 'wk-head';
      var dowEl = document.createElement('div');
      dowEl.className = 'wk-dow';
      dowEl.textContent = dows[i];
      var numEl = document.createElement('div');
      numEl.className = 'dnum';
      numEl.textContent = dt.getDate();
      head.appendChild(dowEl);
      head.appendChild(numEl);
      col.appendChild(head);
      var evs = eventsOn(ds);
      evs.slice(0, 4).forEach(function (s) {
        var chip = document.createElement('div');
        chip.className = 'wk-ev';
        if (fmtTime(s.start_at)) {
          var tm = document.createElement('span');
          tm.className = 'wk-time';
          tm.textContent = fmtTime(s.start_at);
          chip.appendChild(tm);
        }
        var tt = document.createElement('span');
        tt.className = 'wk-title';
        tt.textContent = s.title;
        chip.appendChild(tt);
        chip.title = s.title;
        (function (ev) { chip.addEventListener('click', function (e) { e.stopPropagation(); openModal(ev); }); })(s);
        col.appendChild(chip);
      });
      if (evs.length > 4) {
        var more = document.createElement('div');
        more.className = 'wk-more';
        more.textContent = '+' + (evs.length - 4) + '개 더';
        col.appendChild(more);
      }
      (function (d2) { col.addEventListener('click', function () { selectDate(d2); }); })(ds);
      box.appendChild(col);
    }
  }

  function renderDayView() {
    var d = parseDate(selDate);
    var week = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    $('calTitle').textContent = (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + week + ')';
    var box = $('dayView');
    var evs = eventsOn(selDate);
    if (!evs.length) {
      box.innerHTML = '<div class="empty"><i data-lucide="calendar"></i><br>일정이 없어요</div>';
      return;
    }
    box.innerHTML = evs.map(function (s) { return schedRowHtml(s, true); }).join('');
  }

  function schedRowHtml(s, withDesc) {
    return '<div class="sched-row" data-id="' + s.id + '">' +
      '<div class="s-time">' + esc(fmtTime(s.start_at)) + (s.end_at ? ' – ' + esc(fmtTime(s.end_at)) : '') + '</div>' +
      '<div class="s-body"><div class="s-title">' + esc(s.title) + '</div>' +
      (s.location ? '<div class="s-meta"><i data-lucide="map-pin"></i>' + esc(s.location) + '</div>' : '') +
      (withDesc && s.description ? '<div class="s-desc">' + esc(s.description) + '</div>' : '') +
      '</div>' +
      '<div class="s-act"><button data-act="edit">편집</button><button data-act="del">삭제</button></div>' +
    '</div>';
  }

  function renderDay() {
    var d = new Date(selDate + 'T12:00:00');
    var week = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    $('dayTitle').textContent = (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + week + ')';
    var box = $('dayItems');
    var evs = eventsOn(selDate);
    if (!evs.length) {
      box.innerHTML = '<div class="empty"><i data-lucide="calendar"></i><br>일정이 없어요</div>';
      return;
    }
    box.innerHTML = evs.map(function (s) { return schedRowHtml(s, false); }).join('');
  }

  function openModal(s) {
    $('modalTitle').textContent = s ? '일정 편집' : '일정 추가';
    $('fId').value = s ? s.id : '';
    $('fTitle').value = s ? s.title : '';
    $('fStart').value = s ? (s.start_at || '').slice(0, 16) : (selDate ? selDate + 'T09:00' : '');
    $('fEnd').value = s && s.end_at ? s.end_at.slice(0, 16) : '';
    $('fLocation').value = s ? (s.location || '') : '';
    $('fDesc').value = s ? (s.description || '') : '';
    (function(){ var r = s ? (s.recurrence_rule || '') : '';
      var sel = $('fRrule');
      var opts = Array.prototype.map.call(sel.options, function(o){ return o.value; });
      sel.value = opts.indexOf(r) >= 0 ? r : '';
    })();
    $('delBtn').style.display = s ? '' : 'none';
    var mn = $('modalNotice'); if (mn) { mn.hidden = true; mn.textContent = ''; }
    $('modalBack').classList.add('open');
    setTimeout(function () { $('fTitle').focus(); }, 50);
  }
  function closeModal() { $('modalBack').classList.remove('open'); }

  // 구글 캘린더 연결-오른쪽 안내 (I-05 개정):
  // - 성공(synced): 확인 표시 등 질의문 슬라이진다.
  // - skipped(off): 사유를 고정한다 (조용히 스킵 금지).
  // - 실패(failed): 슬라이지 않는 배너 + '다시 시도'(반짝 다시) 버튼.
  // 스타일은 schedule.css가 등 작업과 결과를 인라인으로 넣는다.
  var noticeTimer = null;
  function showSchedNotice(text, opts) {
    opts = opts || {};
    var el = $('schedNotice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'schedNotice';
      el.className = 'sched-notice';
    }
    el.style.cssText = 'margin:0 0 10px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.45;' +
      (opts.tone === 'ok' ? 'background:#E7F6EC;color:#1E6B34;' : 'background:#FFF4E5;color:#8A5A00;');
    // 등 보기에서는 day-sec(패널)를 껴지므로 dayView 앞에 붙인다 등 많은 현재 보기를 기준으로 날짜가
    var anchor = document.querySelector('.cal-layout').classList.contains('mode-day') ? $('dayView') : $('dayItems');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor);
    else if (!el.parentNode) document.body.appendChild(el);
    el.textContent = text;
    if (opts.retry) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sched-notice-retry';
      btn.textContent = '다시 시도';
      btn.style.cssText = 'margin-left:10px;padding:4px 10px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;font-size:12px;cursor:pointer;';
      btn.addEventListener('click', function () { retryGoogleSync(); });
      el.appendChild(btn);
    }
    el.style.display = '';
    if (noticeTimer) clearTimeout(noticeTimer);
    if (!opts.persistent) {
      noticeTimer = setTimeout(function () { el.style.display = 'none'; }, opts.tone === 'ok' ? 3000 : 6000);
    }
  }

  // I-14: 모달 등 방식 고정 (브라우저 alert 대체 등 모달이 내부 동안도 보인다)
  function showModalNotice(text) {
    var el = $('modalNotice');
    if (!el) { showSchedNotice(text); return; }
    el.textContent = text;
    el.hidden = false;
  }

  function googleOffNotice(reason) {
    if (reason === 'revoked') {
      return '구글 연동이 꺼져 있어요(인증 필요) MyHub에만 저장했어요. 설정 메뉴의 Google 연동에서 다시 연결하면 자동으로 동기화돼요.';
    }
    return '구글 캘린더 연동이 끊겨 있어요 MyHub에만 저장했어요. 연동하면 그때 자동으로 동기화돼요.';
  }

  // 응답의 상태를 google 사용 자에게 고정한다 (I-05 피드백 비슷한 해소)
  function reportGoogleResult(res, kind) {
    var g = res && res.google;
    if (!g) return;
    if (g.state === 'failed') {
      showSchedNotice(
        kind === 'delete'
          ? '구글 캘린더 삭제에 실패해 삭제 보호로 숨겨 뒀어요. 다시 시도 해 보세요.'
          : 'MyHub에는 저장했어요. 구글 캘린더 등록에 실패해서 동기화 실패로 숨겨 뒀어요. 다시 시도 해 보세요.',
        { persistent: true, retry: true },
      );
    } else if (g.state === 'off') {
      showSchedNotice(googleOffNotice(g.reason));
    } else if (g.state === 'synced') {
      showSchedNotice(kind === 'delete' ? '구글 캘린더에도 삭제했어요.' : '구글 캘린더에도 등록했어요.', { tone: 'ok' });
    }
  }

  // 반짝 다시등 미등록 동기화 보호분을 서버가 다시 위임한다
  async function retryGoogleSync() {
    try {
      var res = await api('/api/google/backfill', { method: 'POST' });
      var b = (res && res.backfill) || {};
      await reloadVisible();
      render();
      if (b.ran && (b.failed || 0) === 0) {
        showSchedNotice('구글 캘린더 동기화를 다시 시도했어요.', { tone: 'ok' });
      } else if (b.ran) {
        showSchedNotice('다시 시도했지만 일부 일정이 실패 상태로 남아 있어요.', { persistent: true, retry: true });
      } else {
        showSchedNotice(googleOffNotice(b.reason));
      }
    } catch (e) {
      showSchedNotice('동기화 자체에 실패했어요. 잠시 후 다시 시도해 주세요.', { persistent: true, retry: true });
    }
  }

  async function saveModal() {
    var id = $('fId').value;
    var payload = {
      title: $('fTitle').value.trim(),
      start_at: $('fStart').value ? $('fStart').value.slice(0, 16) : '',
      end_at: $('fEnd').value ? $('fEnd').value.slice(0, 16) : null,
      location: $('fLocation').value.trim(),
      description: $('fDesc').value.trim(),
      recurrence_rule: $('fRrule').value.trim() || null
    };
    if (!payload.title || !payload.start_at) {
      showModalNotice('제목과 시작 일시를 입력하세요.');
      return;
    }
    try {
      var res;
      if (id) { res = await api('/api/schedule/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
      else { res = await api('/api/schedule/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
      closeModal();
      await reloadVisible();
      render();
      reportGoogleResult(res, 'save');
    } catch (e) {
      showModalNotice('저장 실패: ' + friendlyError(e, '잠시 후 다시 시도해 주세요.'));
    }
  }

  // 커스텀 확인 모달 (네이티브 confirm 대체 - 자동화 테스트 가능)
  function confirmDelete(msg) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'sched-confirm-overlay';
      overlay.innerHTML = `
        <div class="sched-confirm-modal">
          <p>${msg}</p>
          <div class="sched-confirm-btns">
            <button class="sched-confirm-no">취소</button>
            <button class="sched-confirm-yes danger">삭제</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') { cleanup(); resolve(false); }
      };
      document.addEventListener('keydown', onKeydown);
      overlay.querySelector('.sched-confirm-no').onclick = () => { cleanup(); resolve(false); };
      overlay.querySelector('.sched-confirm-yes').onclick = () => { cleanup(); resolve(true); };
      overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); resolve(false); } };
    });
  }

  async function delSchedule(id) {
    if (!await confirmDelete('삭제할까요?')) return;
    try {
      var res = await api('/api/schedule/' + id, { method: 'DELETE' });
      await reloadVisible();
      render();
      // J-01: 구글 삭제가 성공하지 않으면 서버가 로컬 삭제를 보호한다 등
      // 일정이 목록에 남아 있는 것이 정상이며, 그 사실을 지정 배너로 알린다.
      if (res && res.localDeleted === false) {
        showSchedNotice('구글 캘린더 삭제가 성공하지 않아 등 일정이 아직 지정이 아니에요. 다시 연결한 등 다시 시도하면 함께 삭제해요.', { persistent: true, retry: true });
          } else {
        reportGoogleResult(res, 'delete');
      }
    } catch (e) {
      showSchedNotice('삭제 실패: ' + friendlyError(e, '잠시 후 다시 시도해 주세요.'), { persistent: true });
    }
  }

  function refreshIcons() { if (window.lucide) lucide.createIcons(); }
  window.refreshAfterAI = function() { return reloadVisible(); };

  // 패널(선택된 목록)과 등 보는 같은 등 공유를 공유한다
  function onRowListClick(e) {
    var btn = e.target.closest('[data-act]');
    var row = e.target.closest('.sched-row');
    if (!row) return;
    var id = Number(row.dataset.id);
    if (!btn) {
      var s = eventsOn(selDate).find(function (x) { return x.id === id; });
      if (s) openModal(s);
      return;
    }
    e.stopPropagation();
    if (btn.dataset.act === 'edit') {
      var ev = eventsOn(selDate).find(function (x) { return x.id === id; });
      if (ev) openModal(ev);
    } else if (btn.dataset.act === 'del') {
      delSchedule(id);
    }
  }
  $('dayItems').addEventListener('click', onRowListClick);
  $('dayView').addEventListener('click', onRowListClick);

  async function navigate(dir) {
    if (viewMode === 'month') {
      viewM += dir;
      if (viewM < 0) { viewM = 11; viewY--; }
      if (viewM > 11) { viewM = 0; viewY++; }
    } else if (viewMode === 'week') {
      selDate = addDays(selDate, dir * 7);
    } else {
      selDate = addDays(selDate, dir);
    }
    await ensureVisibleLoaded();
    render();
  }
  $('prevM').addEventListener('click', function () { navigate(-1); });
  $('nextM').addEventListener('click', function () { navigate(1); });
  $('todayBtn').addEventListener('click', async function () { var n = new Date(); viewY = n.getFullYear(); viewM = n.getMonth(); selDate = todayStr(); await ensureVisibleLoaded(); render(); });

  async function setView(mode) {
    if (viewMode === mode) return;
    viewMode = mode;
    await ensureVisibleLoaded();
    render();
  }
  document.querySelectorAll('.vs-btn').forEach(function (b) {
    b.addEventListener('click', function () { setView(b.dataset.view); });
  });
  $('addBtn').addEventListener('click', function () { openModal(null); });
  $('cancelBtn').addEventListener('click', closeModal);
  $('saveBtn').addEventListener('click', saveModal);
  $('delBtn').addEventListener('click', function () { var id = $('fId').value; if (!id) return; closeModal(); delSchedule(Number(id)); });
  $('modalBack').addEventListener('click', function (e) { if (e.target === $('modalBack')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  window.addEventListener('resize', function () { render(); });

  /* ---------- Web Push (일정 알림) ---------- */
  function urlB64ToU8(s) {
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    var pad = (4 - (b64.length % 4)) % 4;
    var bin = atob(b64 + '===='.slice(0, pad));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function setPushUI(on) {
    var btn = $('pushBtn');
    btn.classList.toggle('active', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    postWinActions();
  }
  async function initPush() {
    var btn = $('pushBtn');
    // 브라우저 미지원 → 버튼 숨김
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      btn.style.display = 'none';
      postWinActions();
      return;
    }
    // 서버 VAPID 설정 확인
    var vapidKey = null;
    try {
      var r = await fetch('/api/push/vapid-key');
      var d = await r.json();
      if (d.ok && d.publicKey) vapidKey = d.publicKey;
    } catch (e) { console.warn('푸시 공개키 조회 실패:', e); }
    if (!vapidKey) {
      btn.disabled = true;
      btn.title = '서버에 알림 키가 설정되지 않았어요';
      postWinActions();
      return;
    }
    var reg;
    try {
      reg = await navigator.serviceWorker.register('/sw.js');
    } catch (e) {
      btn.disabled = true;
      btn.title = '알림을 등록할 수 없어요';
      postWinActions();
      return;
    }
    var sub = null;
    try { sub = await reg.pushManager.getSubscription(); } catch (e) { console.warn('푸시 구독 조회 실패:', e); }
    setPushUI(!!sub);
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      try {
        var cur = await reg.pushManager.getSubscription();
        if (cur) {
          await cur.unsubscribe();
          await fetch('/api/push/unsubscribe', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: cur.endpoint })
          });
          setPushUI(false);
        } else {
          if (Notification.permission === 'denied') {
            btn.title = '브라우저 설정에서 알림을 허용해 주세요';
            return;
          }
          var perm = await Notification.requestPermission();
          if (perm !== 'granted') return;
          var created = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToU8(vapidKey)
          });
          var sr = await fetch('/api/push/subscribe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(created.toJSON())
          });
          var sd = await sr.json();
          if (sd.ok) {
            setPushUI(true);
          } else {
            await created.unsubscribe();
            btn.title = '구독 저장에 실패했어요';
          }
        }
      } catch (e) {
        btn.title = '알림 설정 중 오류가 발생했어요';
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ---------- 창 바 상태 동작 게시 (myhub:win-actions 채널) ---------- */
  // 창 모드에서는 페이지 상단바가 화면 알림 종이 핵심으로 슬라이진다
  // (2026-11-06 image-131). 종이 켜짐/꺼짐 상태가 상시 보여야 하는
  // 컨트롤러인 메뉴로 선택할 등없는 등 상태 켜짐(비활성)동기 를등
  // 창 바 trailing에 게시하고, 클릭은 몸이 알려주면 실제 #pushBtn
  // 클릭으로 실행이 기존 핸들러 그대로 복사. 제한 일정(+)추가
  // 순환된 명령이라 등 메뉴(일정 등 등 일정)가 받는 것으로 호출한다.
  function postWinActions() {
    if (window.parent === window) return;
    var btn = $('pushBtn');
    if (!btn) return;
    window.parent.postMessage({
      type: 'myhub:win-actions',
      actions: [{
        id: 'push',
        icon: 'bell',
        label: '일정 알림 설정',
        active: btn.classList.contains('active'),
        disabled: !!btn.disabled,
        hidden: btn.style.display === 'none',
      }],
    }, window.location.origin);
  }
  window.addEventListener('message', function (e) {
    if (!e || e.origin !== window.location.origin || e.source !== window.parent) return;
    var d = e.data;
    if (!d) return;
    if (d.type === 'myhub:request-win-actions') {
      postWinActions();
    } else if (d.type === 'myhub:win-action-click' && d.id === 'push') {
      var btn = $('pushBtn');
      if (btn && btn.style.display !== 'none' && !btn.disabled) btn.click();
    }
  });

  /* 창 상단 메뉴바 정의 (공유: js/desktop/windows.js 상단 주석).
     보기 전환을 선택 checked표시로 현재 보기를 표시하고, 이동
     레벨의 등 주의 보기를 맞추 월/주/새로 바꾼다. 실행은 전부
     실제 버튼 클릭 위임(target)이다. */
  window.MyHubMenus = [
    {
      label: '일정',
      items: [
        { label: '새 일정', target: '#addBtn' },
        { separator: true },
        { label: '일정 알림 설정', target: '#pushBtn' },
      ],
    },
    {
      label: '보기',
      items: [
        { label: '월', checked: function () { return viewMode === 'month'; }, target: '.vs-btn[data-view="month"]' },
        { label: '주', checked: function () { return viewMode === 'week'; }, target: '.vs-btn[data-view="week"]' },
        { label: '일', checked: function () { return viewMode === 'day'; }, target: '.vs-btn[data-view="day"]' },
        { separator: true },
        { label: '오늘', target: '#todayBtn' },
      ],
    },
    {
      label: '이동',
      items: function () {
        var unit = viewMode === 'month' ? '달' : viewMode === 'week' ? '주' : '일';
        return [
          { label: '이전 ' + unit, target: '#prevM' },
          { label: '다음 ' + unit, target: '#nextM' },
        ];
      },
    },
  ];

  (async function init() {
    var n = new Date();
    viewY = n.getFullYear(); viewM = n.getMonth(); selDate = todayStr();
    try { await ensureVisibleLoaded(); }
    catch (e) { $('dayItems').innerHTML = '<div class="empty">불러오지 못했어요</div>'; }
    render();
    initPush();
  })();
})();
