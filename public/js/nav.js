/* MyHub 공용 스크립트 — 모든 페이지에서 로드됨 */
/* 담당: 상단바 시계, Lucide 아이콘 새로고침 포함, 설정 버튼·모달 */
(function () {
  'use strict';

  // 데스크톱 창(iframe) 안에서 열리면 시스템 상단바 하나로 합쳐 보이게
  // 한다: html.myhub-embedded가 붙으면 shell.css가 이 페이지 자체의
  // 상단바를 숨기고 --topnav-h 스페이서를 0으로 만든다 (macOS처럼 활성
  // 창 이름이 바깥 시스템 상단바에 표시되도록).
  if (window.self !== window.top) {
    document.documentElement.classList.add('myhub-embedded');
  }

  // WCO(설치형 PWA) 타이틀바 톤 동기화: 브라우저의 네이티브 버튼 톤을
  // 페이지의 meta theme-color로 칠하고, shell.css의 상단바 배경을
  // var(--titlebar-tone)로 칠한다. 데스크톱에서는 wallpaper.js가 산을
  // 함께 맞추지만, 그 스크립트가 없는 단독 페이지(백업 등)에서는 네이
  // 비어 있는 fallback(데스크톱 베이지)을 칠해 흰(밝은)톤 바(베이지)가
  // 충돌하는 일을 방지했다 (2026-11-06 사용자 캡처). 정본은 theme-color
  // 하나이므로, 이를 인라인으로 정해진 네이 없을 때만 그 값으로 맞춘다.
  (function syncTitlebarTone() {
    var root = document.documentElement;
    if (!root || !root.style) return;
    if (root.style.getPropertyValue('--titlebar-tone')) return;
    var meta = document.querySelector ? document.querySelector('meta[name="theme-color"]') : null;
    var color = meta ? meta.getAttribute('content') : null;
    if (color) root.style.setProperty('--titlebar-tone', color);
  })();

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

  // ---- 로그아웃 동작 ----
  // 로그아웃 API(POST /api/auth/logout)로 쿠키 삭제 + 서버 측 세션 버전 무효화를 수행한다.
  // 진입점은 상단바에 직접 넣지 않고 설정 모달 안에 모은다 (아래 설정 모달 참고).
  var LOGOUT_URL = '/api/auth/logout';
  var LOGIN_URL = '/login.html';
  var LOGOUT_ERROR_MESSAGE = '로그아웃에 실패했어요. 네트워크를 확인하고 다시 시도해 주세요.';
  // Lucide "log-out" 아이콘 (ISC) — lucide 스크립트 로딩 순서와 무관하게
  // 항상 보이도록 인라인 SVG로 넣는다 (index.html 설정 토글 버튼과 같은 방식).
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

  // ---- 설정 버튼 + 드롭다운 메뉴 ----
  // 상단바에서는 설정(기어) 버튼 1개만 갖고, 데스크톱·백업·키 로테이션·로그아웃 같은
  // 유틸리티 진입점은 버튼 아래로 펼쳐지는 메뉴 안에 모은다
  // (사용자 지시 2026-11-01: 상단바 정돈 + 앱 메뉴는 드롭다운).
  // 클래스·ID는 반드시 myhub- 접두사를 단다: chat.css 등 페이지별 CSS에 일반
  // .settings-overlay 같은 일반 이름이 있어, 접두사 없는 이름은 스타일이
  // 충돌해 메뉴가 화면에 나타나지 않는 사고가 실제로 있었다 (2026-11-01).
  var DESKTOP_URL = '/desktop.html';
  var BACKUP_URL = '/backup.html';
  var KEY_ROTATION_URL = '/key-rotation.html';
  // Lucide 아이콘 (ISC) — 로그아웃과 같은 이유로 인라인 SVG 사용.
  var DESKTOP_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-layout-grid" aria-hidden="true"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>';
  var BACKUP_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-archive" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
  var KEY_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-key" aria-hidden="true"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
  var SETTINGS_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
  var CHECK_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var CHEVRON_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  // 페이지별 설정 항목 레지스트리 — 특정 화면 전용 설정(예: 데스크톱
  // 배경화면)은 그 화면의 스크립트가 설정 메뉴에 등록한다. 항목은
  // { id, label, iconSvg?, checked?: () => boolean, onSelect: () => void }.
  // 메뉴를 열 때마다 다시 그리며 checked 상태가 항상 현재값과 일치한다.
  // 그룹 항목을 받을 수 있다: { id, group: '배경', iconSvg?,
  // children: [평면 항목, …] } — 그룹 행을 누르거나 호버하면 자식이
  // 서브메뉴로 펼쳐진다 (사용자 지시 2026-11-02: 배경은 배경끼리,
  // 데스크톱은 데스크톱끼리 묶는 구조).
  var pageSettingsItems = [];

  // 평면 항목 검증 — 레이블과 onSelect가 있으면 그릴 수 있다.
  function isSettingsLeaf(item) {
    return !!item && typeof item.label === 'string' && !!item.label &&
      typeof item.onSelect === 'function';
  }

  // 그룹 항목이면 유효한 자식만 골라 알려주고, 그룹이 아니거나 자식이
  // 하나도 없으면 null. 잘못된 형태는 조용히 무시한다 (제공 코드와 같은 것).
  function settingsGroupChildren(item) {
    if (!item || typeof item.group !== 'string' || !item.group) return null;
    if (!Array.isArray(item.children)) return null;
    var kids = item.children.filter(isSettingsLeaf);
    return kids.length ? kids : null;
  }

  function isSettingsEntry(item) {
    return isSettingsLeaf(item) || !!settingsGroupChildren(item);
  }

  // 동적 항목 제공자 — 항목 집합 자체가 상태에 따라 넣고 주는 화면
  // (예: 데스크톱 Spaces 목록)은 등록한다. 정적 등록(addSettingsItems)은
  // 항목 지정 방법이 없어 개수 변동에 따라가지 못하므로, 메뉴를 열
  // 때마다 제공자를 다시 불러 현재 항목을 새로 받는다.
  var pageSettingsProviders = [];

  function addSettingsItemsProvider(provider) {
    if (typeof provider !== 'function') return;
    if (pageSettingsProviders.indexOf(provider) >= 0) return;
    pageSettingsProviders.push(provider);
    var root = document.getElementById('myhubSettingsMenu');
    if (root) renderPageSettingsItems(document);
  }

  function collectPageSettingsItems() {
    var all = pageSettingsItems.slice();
    pageSettingsProviders.forEach(function (provider) {
      var provided = provider();
      if (!Array.isArray(provided)) return;
      provided.forEach(function (item) {
        if (!isSettingsEntry(item)) return;
        var kids = settingsGroupChildren(item);
        if (kids) {
          // 그룹의 자식은 유효한 것만으로 정규화해서 넣는다
          all.push({ id: item.id, group: item.group, iconSvg: item.iconSvg, children: kids });
        } else {
          all.push(item);
        }
      });
    });
    return all;
  }

  function addSettingsItems(items) {
    if (!Array.isArray(items)) return;
    items.forEach(function (item) {
      if (!isSettingsEntry(item)) return;
      if (item.id != null) {
        for (var i = 0; i < pageSettingsItems.length; i++) {
          if (pageSettingsItems[i].id === item.id) {
            pageSettingsItems[i] = item;
            return;
          }
        }
      }
      pageSettingsItems.push(item);
    });
    var root = document.getElementById('myhubSettingsMenu');
    if (root) renderPageSettingsItems(document);
  }

  // ---- 서브메뉴 상태 (동시에 하나만 열린다) ----
  // 호버로 연 직후의 클릭은 "열려 있는 서브메뉴"를 누른것으로 보고 닫지
  // 않는다(openedByHover) — 마우스 사용자가 의도적으로 클릭해도 메뉴가
  // 꺼지지 않게. 두 번째 클릭부터는 토글로 접힌다.
  var submenuState = null; // { wrap, row, sub, openedByHover }
  var submenuOpenTimer = null;
  var submenuCloseTimer = null;
  var SUBMENU_OPEN_DELAY = 120;
  var SUBMENU_CLOSE_DELAY = 300;

  function clearSubmenuTimers() {
    if (submenuOpenTimer) { clearTimeout(submenuOpenTimer); submenuOpenTimer = null; }
    if (submenuCloseTimer) { clearTimeout(submenuCloseTimer); submenuCloseTimer = null; }
  }

  function applyCloseSubmenu() {
    if (!submenuState) return;
    submenuState.sub.hidden = true;
    submenuState.row.setAttribute('aria-expanded', 'false');
    submenuState = null;
  }

  // 열려 있는 서브메뉴가 있으면 닫고 true를 반환한다 (ESC 단계 처리용).
  function closeOpenSubmenu() {
    clearSubmenuTimers();
    if (!submenuState) return false;
    applyCloseSubmenu();
    return true;
  }

  function openSubmenu(wrap, row, sub, byHover) {
    clearSubmenuTimers();
    if (submenuState && submenuState.sub !== sub) applyCloseSubmenu();
    sub.hidden = false;
    row.setAttribute('aria-expanded', 'true');
    submenuState = { wrap: wrap, row: row, sub: sub, openedByHover: !!byHover };
  }

  function toggleSubmenu(wrap, row, sub) {
    clearSubmenuTimers();
    if (submenuState && submenuState.sub === sub) {
      if (submenuState.openedByHover) {
        submenuState.openedByHover = false;
        return;
      }
      applyCloseSubmenu();
      return;
    }
    openSubmenu(wrap, row, sub, false);
  }

  function buildLeafButton(doc, item, inSubmenu) {
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'myhub-settings-item';
    btn.setAttribute('role', 'menuitemradio');
    var checked = typeof item.checked === 'function' ? !!item.checked() : false;
    btn.setAttribute('aria-checked', checked ? 'true' : 'false');
    btn.innerHTML =
      (item.iconSvg || '') +
      '<span>' + item.label + '</span>' +
      (checked ? '<span class="myhub-settings-check">' + CHECK_ICON_SVG + '</span>' : '');
    btn.addEventListener('click', function () {
      item.onSelect();
      renderPageSettingsItems(doc);
      closeSettingsMenu(doc);
    });
    if (!inSubmenu) {
      // 최상위 항목으로 포인터가 가면 열려 있는 서브메뉴를 바로 접는다
      btn.addEventListener('mouseenter', function () { closeOpenSubmenu(); });
    }
    return btn;
  }

  function buildGroupEntry(doc, item, kids) {
    var wrap = doc.createElement('div');
    wrap.className = 'myhub-settings-group-wrap';

    var row = doc.createElement('button');
    row.type = 'button';
    row.className = 'myhub-settings-item myhub-settings-group';
    row.setAttribute('aria-haspopup', 'true');
    row.setAttribute('aria-expanded', 'false');
    row.innerHTML =
      (item.iconSvg || '') +
      '<span>' + item.group + '</span>' +
      '<span class="myhub-settings-chevron">' + CHEVRON_ICON_SVG + '</span>';

    var sub = doc.createElement('div');
    sub.className = 'myhub-settings-submenu';
    sub.setAttribute('role', 'menu');
    sub.setAttribute('aria-label', item.group);
    sub.hidden = true;
    kids.forEach(function (kid) { sub.appendChild(buildLeafButton(doc, kid, true)); });

    wrap.appendChild(row);
    wrap.appendChild(sub);

    // 그룹 행은 button이라 Enter/Space가 click으로 이어진다 — 토글로 충분.
    row.addEventListener('click', function () { toggleSubmenu(wrap, row, sub); });
    wrap.addEventListener('mouseenter', function () {
      if (submenuCloseTimer) { clearTimeout(submenuCloseTimer); submenuCloseTimer = null; }
      if (submenuState && submenuState.sub === sub) return;
      if (submenuOpenTimer) clearTimeout(submenuOpenTimer);
      submenuOpenTimer = setTimeout(function () {
        submenuOpenTimer = null;
        openSubmenu(wrap, row, sub, true);
      }, SUBMENU_OPEN_DELAY);
    });
    wrap.addEventListener('mouseleave', function () {
      if (submenuOpenTimer) { clearTimeout(submenuOpenTimer); submenuOpenTimer = null; }
      if (!submenuState || submenuState.sub !== sub) return;
      submenuState.openedByHover = false;
      if (submenuCloseTimer) clearTimeout(submenuCloseTimer);
      submenuCloseTimer = setTimeout(function () {
        submenuCloseTimer = null;
        applyCloseSubmenu();
      }, SUBMENU_CLOSE_DELAY);
    });
    return wrap;
  }

  function renderPageSettingsItems(doc) {
    var container = doc.getElementById('myhubSettingsPageItems');
    if (!container) return;
    clearSubmenuTimers();
    submenuState = null;
    container.innerHTML = '';
    var allItems = collectPageSettingsItems();
    if (!allItems.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    var divider = doc.createElement('div');
    divider.className = 'myhub-settings-divider';
    container.appendChild(divider);
    allItems.forEach(function (item) {
      var kids = settingsGroupChildren(item);
      if (kids) container.appendChild(buildGroupEntry(doc, item, kids));
      else container.appendChild(buildLeafButton(doc, item, false));
    });
  }

  // 백업 열기 — 백업은 데스크톱 모듈(state.js MODULES)인데도 설정 메뉴
  // 링크가 일반 <a href> 페이지 이동이라, 데스크톱에서 누르면 몸을
  // 통째로 비워 단독 페이지로 열리는 결함 (2026-11-06 사용자 캡처).
  // 데스크톱 창 자신이면 창 매니저로 창을 열고, 데스크톱 창(iframe)
  // 안이면 부모 몸에 모듈 열기를 위임하며(파인더 앱 실행과 같은
  // myhub:open-module 계약), 데스크톱이 없는 단독 페이지에서만 종전
  // 페이지 이동으로 폴백한다. 처리했으면 true.
  function openBackupInDesktop(win) {
    win = win || window;
    if (win.self === win.top) {
      var mgr = win.MyHubDesktop;
      if (mgr && typeof mgr.openModule === 'function') {
        mgr.openModule('backup');
        return true;
      }
      return false;
    }
    if (win.parent && typeof win.parent.postMessage === 'function') {
      win.parent.postMessage(
        { type: 'myhub:open-module', module: 'backup' },
        win.location.origin
      );
      return true;
    }
    return false;
  }

  // 메뉴는 문서에 1개만 만든다 (body 직속, .g-nav 안쪽은 무관하게 동작).
  // 구조: 루트(톱니 토글) > 투명 배경(바깥 클릭 닫기) + 패널(상단바 아래 오른쪽 고정)
  function buildSettingsMenu(doc, deps) {
    doc = doc || document;
    var existing = doc.getElementById('myhubSettingsMenu');
    if (existing) return existing;
    var root = doc.createElement('div');
    root.id = 'myhubSettingsMenu';
    root.className = 'myhub-settings-root';
    root.hidden = true;

    var backdrop = doc.createElement('div');
    backdrop.className = 'myhub-settings-backdrop';
    backdrop.addEventListener('click', function () { closeSettingsMenu(doc); });
    root.appendChild(backdrop);

    var panel = doc.createElement('div');
    panel.className = 'myhub-settings-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', '설정');

    function addLink(iconSvg, label, href) {
      var a = doc.createElement('a');
      a.className = 'myhub-settings-item';
      a.setAttribute('role', 'menuitem');
      a.href = href;
      a.innerHTML = iconSvg + '<span>' + label + '</span>';
      panel.appendChild(a);
      return a;
    }
    addLink(DESKTOP_ICON_SVG, '데스크톱 열기', DESKTOP_URL);
    var backupLink = addLink(BACKUP_ICON_SVG, '데이터 백업', BACKUP_URL);
    backupLink.addEventListener('click', function (ev) {
      // 데스크톱 문맥에서는 창 열기로 가로채고, 아니면 기본 이동 유지
      if (openBackupInDesktop(window)) {
        ev.preventDefault();
        closeSettingsMenu(doc);
      }
    });
    addLink(KEY_ICON_SVG, '암호화 키 교체', KEY_ROTATION_URL);

    // 페이지별 항목(예: 배경화면) 자리 — 등록된 항목이 있을 때만 채워진다
    var pageItems = doc.createElement('div');
    pageItems.id = 'myhubSettingsPageItems';
    pageItems.hidden = true;
    panel.appendChild(pageItems);

    var divider = doc.createElement('div');
    divider.className = 'myhub-settings-divider';
    panel.appendChild(divider);

    var logoutItem = doc.createElement('button');
    logoutItem.type = 'button';
    logoutItem.id = 'myhubSettingsLogoutBtn';
    logoutItem.className = 'myhub-settings-item danger';
    logoutItem.setAttribute('role', 'menuitem');
    logoutItem.innerHTML = LOGOUT_ICON_SVG + '<span>로그아웃</span>';
    logoutItem.addEventListener('click', function () {
      if (logoutItem.disabled) return;
      logoutItem.disabled = true;
      handleLogout(deps).then(function (ok) {
        if (!ok) logoutItem.disabled = false;
      });
    });
    panel.appendChild(logoutItem);

    root.appendChild(panel);
    // ESC로 닫힌 뒤 리스너는 메뉴를 1개만 단다. 서브메뉴가 열려 있으면
    // 메뉴 전체가 아니라 서브메뉴부터 닫는다.
    doc.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || root.hidden) return;
      if (closeOpenSubmenu()) return;
      closeSettingsMenu(doc);
    });
    doc.body.appendChild(root);
    return root;
  }

  // 설정 버튼의 노출 상태 — 앱 메뉴 트리거와 같은 캡처 페이즈이며
  // aria-expanded를 따라 붙는다 (shell.css).
  function markSettingsBtn(doc, expanded) {
    var btn = doc.getElementById('settingsBtn');
    if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function openSettingsMenu(doc, deps) {
    doc = doc || document;
    var root = buildSettingsMenu(doc, deps);
    renderPageSettingsItems(doc);
    root.hidden = false;
    markSettingsBtn(doc, true);
    return root;
  }

  function closeSettingsMenu(doc) {
    doc = doc || document;
    clearSubmenuTimers();
    submenuState = null;
    var root = doc.getElementById('myhubSettingsMenu');
    if (root) root.hidden = true;
    markSettingsBtn(doc, false);
    return root;
  }

  // 상단바에 설정 버튼을 1개만 마운트한다. .g-nav가 없는 화면에서는 아무것도 하지 않는다.
  function mountSettingsButton(doc, deps) {
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
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.title = '설정';
    // 기어 아이콘만 — macOS 상단바 오른쪽 아이콘 방식 (사용자 지시 2026-11-03,
    // 2026-11-01의 '설정' 글자 버튼 결정을 번복). 이름은 aria-label/title로 유지.
    btn.innerHTML = SETTINGS_ICON_SVG;
    btn.addEventListener('click', function () {
      var root = doc.getElementById('myhubSettingsMenu');
      if (root && !root.hidden) closeSettingsMenu(doc);
      else openSettingsMenu(doc, deps);
    });
    var clock = nav.querySelector('#clock');
    if (clock) nav.insertBefore(btn, clock);
    else nav.appendChild(btn);
    return btn;
  }

  mountSettingsButton(document);

  // 데스크톱 창(iframe) 안에서는 Ctrl+←/→/↑ 키 입력이 문서에만 머물러
  // 부모(데스크톱)의 전환 단축키가 먹지 않는다 (사용자 보고 2026-11-03:
  // 데스크톱 2에서 메모를 최대화해 작업하고 돌아오면 Ctrl+← 무반응인
  // 전환 모드를 한 번 거치면 그때부터 먹게 된다는 한 부모의 클릭·단축키
  // 부모로 돌아가기 때문). 임베드된 경우에만 부모로 다시 보내 같은
  // 단축키 경로(windows.js onKeydown)를 타게 한다. 단독 페이지에서는
  // 아무것도 하지 않는다.
  if (window.top !== window) {
    document.addEventListener('keydown', function (ev) {
      if (!ev.ctrlKey) return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      window.parent.postMessage(
        { type: 'myhub:desktop-nav-key', key: ev.key },
        window.location.origin
      );
    });
    // 중첩 임베드(예: 오피스 안의 시트)는 중계 중 자식 프레임이 넣은
    // 전환 키를 두 단계 위로 그대로 올려보낸다. 최상위(데스크톱)는
    // windows.js가 출처 프레임을 검증해 최종 수신한다.
    window.addEventListener('message', function (ev) {
      if (ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || d.type !== 'myhub:desktop-nav-key') return;
      if (d.key !== 'ArrowLeft' && d.key !== 'ArrowRight' && d.key !== 'ArrowUp') return;
      window.parent.postMessage(
        { type: 'myhub:desktop-nav-key', key: d.key },
        window.location.origin
      );
    });
  }

  // 테스트·디버깅 노출 (google-connect.js의 모듈 노출 패턴)
  window.MyHubNav = {
    LOGOUT_URL: LOGOUT_URL,
    LOGIN_URL: LOGIN_URL,
    LOGOUT_ERROR_MESSAGE: LOGOUT_ERROR_MESSAGE,
    DESKTOP_URL: DESKTOP_URL,
    BACKUP_URL: BACKUP_URL,
    openBackupInDesktop: openBackupInDesktop,
    KEY_ROTATION_URL: KEY_ROTATION_URL,
    handleLogout: handleLogout,
    mountSettingsButton: mountSettingsButton,
    buildSettingsMenu: buildSettingsMenu,
    openSettingsMenu: openSettingsMenu,
    closeSettingsMenu: closeSettingsMenu,
    addSettingsItems: addSettingsItems,
    addSettingsItemsProvider: addSettingsItemsProvider,
  };
})();
