/* MyHub 공용 스크립트 — 모든 페이지에서 로드됨 */
/* 담당: 상단바 시계, Lucide 아이콘 새로고침 헬퍼, 설정 메뉴(기어 전용·애플 메뉴식
 * 드롭다운, myhub- 접두사), 임베드 판정·데스크톱 내비 키 포워딩.
 * 재구성 근거: 2026-11-01 상단바 정돈(설정 버튼+메뉴로 교체), 2026-11-03 D-33
 * (Google 연동은 설정 메뉴 안, 설정 버튼은 기어 아이콘 전용), 2026-11-03
 * 내비 키 포워더(임베드 Ctrl+←/→/↑ → 부모 postMessage). */
(function () {
  'use strict';

  var isEmbedded = false;
  try { isEmbedded = window.self !== window.top; } catch (e) { isEmbedded = true; }
  if (isEmbedded) document.documentElement.classList.add('myhub-embedded');

  // 상단바 시계: 10월 8일(목) 오전 9:10
  function tickClock() {
    var el = document.getElementById('clock');
    if (!el) return;
    var d = new Date();
    var days = ['일', '월', '화', '수', '목', '금', '토'];
    var h = d.getHours();
    var ap = h < 12 ? '오전' : '오후';
    h = h % 12 || 12;
    var m = String(d.getMinutes()).padStart(2, '0');
    el.textContent = (d.getMonth() + 1) + '월 ' + d.getDate() + '일(' + days[d.getDay()] + ') ' + ap + ' ' + h + ':' + m;
  }
  tickClock();
  setInterval(tickClock, 30000);

  // Lucide 아이콘 새로고침 (동적 DOM용)
  function refreshIcons() {
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { console.warn('아이콘 새로고침 실패:', e); } }
  }
  window.myhubRefreshIcons = refreshIcons;

  // ---- 로그아웃 ----
  var LOGOUT_URL = '/api/auth/logout';
  var LOGIN_URL = '/login.html';
  var LOGOUT_ERROR_MESSAGE = '로그아웃에 실패했어요. 네트워크를 확인하고 다시 시도해 주세요.';

  function handleLogout(deps) {
    deps = deps || {};
    var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var loc = deps.location || window.location;
    var alertFn = deps.alertFn || function (msg) { window.alert(msg); };
    if (!fetchFn) {
      alertFn(LOGOUT_ERROR_MESSAGE);
      return Promise.resolve(false);
    }
    return fetchFn(LOGOUT_URL, { method: 'POST' })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('logout failed: ' + (res && res.status));
        loc.href = LOGIN_URL;
        return true;
      })
      .catch(function () {
        alertFn(LOGOUT_ERROR_MESSAGE);
        return false;
      });
  }

  // ---- 설정 메뉴 ----
  // 페이지가 등록하는 항목 레지스트리. 메뉴를 열 때마다 checked를 현재값으로
  // 다시 그린다 (2026-11-01 배경 항목 이관 때 확정된 방식).
  var pageSettingsItems = [];

  function addSettingsItems(items) {
    if (!Array.isArray(items)) return;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.id) continue;
      var replaced = false;
      for (var j = 0; j < pageSettingsItems.length; j++) {
        if (pageSettingsItems[j].id === it.id) { pageSettingsItems[j] = it; replaced = true; break; }
      }
      if (!replaced) pageSettingsItems.push(it);
    }
  }

  var GEAR_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';

  function baseSettingsItems() {
    return [
      { id: 'desktop', label: '데스크톱 열기', onSelect: function () { window.location.href = '/desktop.html'; } },
      { id: 'backup', label: '데이터 백업', onSelect: function () { window.location.href = '/backup.html'; } },
      { id: 'key-rotation', label: '암호화 키 교체', onSelect: function () { window.location.href = '/key-rotation.html'; } },
      { id: 'google', label: 'Google 연동', onSelect: function () {
          if (window.MyHubGoogleConnect && typeof window.MyHubGoogleConnect.open === 'function') {
            window.MyHubGoogleConnect.open();
          } else {
            window.location.href = '/schedule.html';
          }
        } },
      { id: 'logout', label: '로그아웃', danger: true, onSelect: function () { handleLogout(); } },
    ];
  }

  function closeSettingsMenu() {
    var menu = document.querySelector('.myhub-settings-menu');
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
  }

  function onDocPointerDown(ev) {
    var menu = document.querySelector('.myhub-settings-menu');
    if (menu && !menu.contains(ev.target)) closeSettingsMenu();
  }

  function openSettingsMenu(anchorBtn) {
    var existing = document.querySelector('.myhub-settings-menu');
    if (existing) { closeSettingsMenu(); return; }
    var menu = document.createElement('div');
    menu.className = 'myhub-settings-menu';
    menu.setAttribute('role', 'menu');
    var items = baseSettingsItems().concat(pageSettingsItems);
    items.forEach(function (it) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'myhub-settings-item' + (it.danger ? ' myhub-settings-item-danger' : '');
      btn.setAttribute('role', 'menuitem');
      var checked = typeof it.checked === 'function' ? !!it.checked() : it.checked === true;
      btn.innerHTML = '<span class="myhub-settings-check">' + (checked ? '✓' : '') + '</span><span>' + it.label + '</span>';
      btn.addEventListener('click', function () {
        closeSettingsMenu();
        if (typeof it.onSelect === 'function') it.onSelect();
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    var r = anchorBtn.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    document.addEventListener('pointerdown', onDocPointerDown, true);
  }

  // 설정 버튼은 기어 아이콘 전용 (D-33). .g-nav의 시계 앞에 1개만 마운트한다.
  function mountSettingsButton(doc) {
    doc = doc || document;
    var nav = doc.querySelector('.g-nav');
    if (!nav) return null;
    var existing = doc.getElementById('settingsBtn');
    if (existing) return existing;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.id = 'settingsBtn';
    btn.className = 'settings-btn';
    btn.setAttribute('aria-label', '설정');
    btn.title = '설정';
    btn.innerHTML = GEAR_ICON_SVG;
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openSettingsMenu(btn);
    });
    var clock = nav.querySelector('#clock');
    if (clock) nav.insertBefore(btn, clock);
    else nav.appendChild(btn);
    return btn;
  }

  mountSettingsButton(document);

  // ---- 데스크톱 내비 키 포워더 ----
  // 임베드 상태일 때만 Ctrl+←/→/↑를 가로채 부모(데스크톱)로 전달한다.
  // 중첩 임베드(오피스 안 시트 등)를 위해 한 단계 위 중계도 둔다.
  if (isEmbedded) {
    document.addEventListener('keydown', function (ev) {
      if (!ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      try {
        window.parent.postMessage({ type: 'myhub:desktop-nav-key', key: ev.key }, window.location.origin);
      } catch (e) { console.debug('내비 키 전달 실패:', e); }
    });
    window.addEventListener('message', function (ev) {
      if (ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || d.type !== 'myhub:desktop-nav-key') return;
      try {
        window.parent.postMessage(d, window.location.origin);
      } catch (e) { console.debug('내비 키 중계 실패:', e); }
    });
  }

  window.MyHubNav = {
    LOGOUT_URL: LOGOUT_URL,
    LOGIN_URL: LOGIN_URL,
    LOGOUT_ERROR_MESSAGE: LOGOUT_ERROR_MESSAGE,
    handleLogout: handleLogout,
    mountSettingsButton: mountSettingsButton,
    addSettingsItems: addSettingsItems,
    openSettingsMenu: openSettingsMenu,
    closeSettingsMenu: closeSettingsMenu,
    isEmbedded: isEmbedded,
  };
})();
