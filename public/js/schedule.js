/* MyHub 일정 앱 — 캘린더 렌더·일정 CRUD·Web Push (schedule.html에서 분리).
 * 분리 사유: /schedule.html은 SCHEDULE_CSP(script-src 'self') enforce 대상이라
 * 인라인 <script>는 운영에서 차단된다. 위젯 초기화와 본체 모두 이 파일이 맡는다. */
if (window.AssistantWidget) AssistantWidget.init({ personaId: 'scheduler', personaName: '캘리', avatar: '/avatars/cali.webp' });
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var viewY, viewM, selDate;
  var monthCache = {};

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
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

  function eventsOn(dateStr) {
    var list = monthCache[dateStr.slice(0, 7)] || [];
    return list.filter(function (s) { return (s.start_at || '').slice(0, 10) === dateStr; });
  }

  function render() {
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
      if (!other) {
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
      }
      (function (ds) { cell.addEventListener('click', function () { selDate = ds; render(); }); })(dateStr);
      grid.appendChild(cell);
    }
    renderDay();
    refreshIcons();
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
    box.innerHTML = evs.map(function (s) {
      return '<div class="sched-row" data-id="' + s.id + '">' +
        '<div class="s-time">' + esc(fmtTime(s.start_at)) + (s.end_at ? ' – ' + esc(fmtTime(s.end_at)) : '') + '</div>' +
        '<div class="s-body"><div class="s-title">' + esc(s.title) + '</div>' +
        (s.location ? '<div class="s-meta"><i data-lucide="map-pin"></i>' + esc(s.location) + '</div>' : '') +
        '</div>' +
        '<div class="s-act"><button data-act="edit">편집</button><button data-act="del">삭제</button></div>' +
      '</div>';
    }).join('');
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
    $('modalBack').classList.add('open');
    setTimeout(function () { $('fTitle').focus(); }, 50);
  }
  function closeModal() { $('modalBack').classList.remove('open'); }

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
      alert('제목과 시작 일시를 입력하세요.');
      return;
    }
    try {
      if (id) { await api('/api/schedule/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
      else { await api('/api/schedule/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
      closeModal();
      monthCache = {};
      await loadMonth(viewY, viewM);
      render();
    } catch (e) {
      alert('저장 실패: ' + (e.message || '알 수 없는 오류'));
    }
  }

  // 커스텀 확인 모달 (네이티브 confirm 대체 - 자동화 테스트 가능)
  function confirmDelete(msg) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-modal">
          <p>${msg}</p>
          <div class="confirm-btns">
            <button class="confirm-no">취소</button>
            <button class="confirm-yes danger">삭제</button>
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
      overlay.querySelector('.confirm-no').onclick = () => { cleanup(); resolve(false); };
      overlay.querySelector('.confirm-yes').onclick = () => { cleanup(); resolve(true); };
      overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); resolve(false); } };
    });
  }

  async function delSchedule(id) {
    if (!await confirmDelete('삭제할까요?')) return;
    try {
      await api('/api/schedule/' + id, { method: 'DELETE' });
      monthCache = {};
      await loadMonth(viewY, viewM);
      render();
    } catch (e) {
      alert('삭제 실패: ' + (e.message || '알 수 없는 오류'));
    }
  }

  function refreshIcons() { if (window.lucide) lucide.createIcons(); }
  window.refreshAfterAI = function() { loadMonth(viewY, viewM); };

  $('dayItems').addEventListener('click', function (e) {
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
  });

  $('prevM').addEventListener('click', async function () { viewM--; if (viewM < 0) { viewM = 11; viewY--; } await loadMonth(viewY, viewM); render(); });
  $('nextM').addEventListener('click', async function () { viewM++; if (viewM > 11) { viewM = 0; viewY++; } await loadMonth(viewY, viewM); render(); });
  $('todayBtn').addEventListener('click', async function () { var n = new Date(); viewY = n.getFullYear(); viewM = n.getMonth(); selDate = todayStr(); await loadMonth(viewY, viewM); render(); });
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
  }
  async function initPush() {
    var btn = $('pushBtn');
    // 브라우저 미지원 → 버튼 숨김
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      btn.style.display = 'none';
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
      return;
    }
    var reg;
    try {
      reg = await navigator.serviceWorker.register('/sw.js');
    } catch (e) {
      btn.disabled = true;
      btn.title = '알림을 등록할 수 없어요';
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

  (async function init() {
    var n = new Date();
    viewY = n.getFullYear(); viewM = n.getMonth(); selDate = todayStr();
    try { await loadMonth(viewY, viewM); }
    catch (e) { $('dayItems').innerHTML = '<div class="empty">불러오지 못했어요</div>'; }
    render();
    initPush();
  })();
})();
