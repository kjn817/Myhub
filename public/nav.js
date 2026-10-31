/* MyHub 공용 스크립트 — 모든 페이지에서 로드됨 */
/* 담당: 상단바 시계, Lucide 아이콘 새로고침 헬퍼, 로그아웃 버튼 */
(function () {
  'use strict';

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
  // 로그아웃 API(POST /api/auth/logout)는 쿠키 삭제 + 서버 측 세션 버전 무효화를
  // 수행하지만, 그동안 어떤 화면에서도 호출하는 진입점이 없었다.
  // 공용 상단바(.g-nav)의 시계 앞에 버튼을 넣어 nav.js를 로드하는 모든 주요
  // 화면(홈·메모·일정·할 일·AI)에서 일관되게 닿을 수 있게 한다.
  // assistant-widget가 아바타 버튼을 같은 위치에 넣는 패턴과 동일하다.
  var LOGOUT_URL = '/api/auth/logout';
  var LOGIN_URL = '/login.html';
  var LOGOUT_ERROR_MESSAGE = '로그아웃에 실패했어요. 네트워크를 확인하고 다시 시도해 주세요.';
  // Lucide "log-out" 아이콘 (ISC) — lucide 스크립트 로딩 여부와 무관하게
  // 항상 보이도록 인라인 SVG로 넣는다 (index.html 위젯 토글 버튼과 같은 방식).
  var LOGOUT_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-log-out" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>';

  // deps 주입 가능 (테스트용): { fetchFn, location, alertFn }
  // 성공하면 true, 실패하면 사용자에게 알리고 false를 반환한다.
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

  // 상단바에 로그아웃 버튼을 1개만 마운트한다. .g-nav가 없는 화면에서는 아무것도 하지 않는다.
  function mountLogoutButton(doc, deps) {
    doc = doc || document;
    var nav = doc.querySelector('.g-nav');
    if (!nav) return null;
    var existing = doc.getElementById('logoutBtn');
    if (existing) return existing;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.id = 'logoutBtn';
    btn.className = 'logout-btn';
    btn.setAttribute('aria-label', '로그아웃');
    btn.title = '로그아웃';
    btn.innerHTML = LOGOUT_ICON_SVG + '<span class="logout-lbl">로그아웃</span>';
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      btn.disabled = true;
      handleLogout(deps).then(function (ok) {
        if (!ok) btn.disabled = false;
      });
    });
    var clock = nav.querySelector('#clock');
    if (clock) nav.insertBefore(btn, clock);
    else nav.appendChild(btn);
    return btn;
  }

  // ---- 데스크톱 워크스페이스 진입 링크 ----
  // 로그아웃 버튼과 같은 마운트 패턴: .g-nav의 시계 앞에 링크 1개를 넣는다.
  var DESKTOP_URL = '/desktop.html';
  // Lucide "layout-grid" 아이콘 (ISC) — 로그아웃과 같은 이유로 인라인 SVG 사용.
  var DESKTOP_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-layout-grid" aria-hidden="true"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>';

  // 상단바에 데스크톱 링크를 1개만 마운트한다. .g-nav가 없으면 아무것도 하지 않는다.
  function mountDesktopLink(doc) {
    doc = doc || document;
    var nav = doc.querySelector('.g-nav');
    if (!nav) return null;
    var existing = doc.getElementById('desktopLink');
    if (existing) return existing;
    var link = doc.createElement('a');
    link.id = 'desktopLink';
    link.className = 'desktop-link';
    link.href = DESKTOP_URL;
    link.setAttribute('aria-label', '데스크톱');
    link.title = '데스크톱';
    link.innerHTML = DESKTOP_ICON_SVG + '<span class="desktop-lbl">데스크톱</span>';
    var clock = nav.querySelector('#clock');
    if (clock) nav.insertBefore(link, clock);
    else nav.appendChild(link);
    return link;
  }

  mountDesktopLink(document);
  mountLogoutButton(document);

  // 테스트·디버깅용 노출 (google-connect.js의 모듈 노출 패턴)
  window.MyHubNav = {
    LOGOUT_URL: LOGOUT_URL,
    LOGIN_URL: LOGIN_URL,
    LOGOUT_ERROR_MESSAGE: LOGOUT_ERROR_MESSAGE,
    DESKTOP_URL: DESKTOP_URL,
    handleLogout: handleLogout,
    mountLogoutButton: mountLogoutButton,
    mountDesktopLink: mountDesktopLink,
  };
})();
