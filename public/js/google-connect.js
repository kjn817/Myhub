/**
 * Google 연동 메뉴 등 설정 메뉴(nav.js) 안의 'Google 연동' 항목 + 서브 패널
 *
 * 연동은 안의 설정 메뉴에서 (2026-11-03: 일정 화면 등 등 등 상단바 '연동'
 * 버튼 등 설정 메뉴 하위 항목 으로, 이동 사용자 지시로 상단바가 비게).
 * 패널을 body 직접 만들고, 진입은 nav.js의 설정 항목 리스트
 * (window.MyHubNav.addSettingsItems)를 통해 항목으로 등록한다.
 * google-connect.js가 모든 페이지에서 nav.js보다 먼저 로드되므로,
 * 등록 시점에 MyHubNav가 없으면 DOMContentLoaded에 한 번 시도한다.
 * - 상태 표시: GET /api/google/status 응답(connected/configured/email)과 일치
 * - 연결 버튼: /api/google/oauth/start 로 이동. status의 writeEnabled가 true면
 *   ?mode=write를 붙여 쓰기 scope로 시작한다 (플래그 OFF면 읽기 전용 시작 그대로 —
 *   mode=write 없이 재연결하면 저장 토큰이 읽기 전용으로 교체되므로).
 *   콜백 복귀 안내(?google=connected)가 있는 등 연결된 클릭을 함께 보여준다.
 * - 해제 버튼: POST /api/google/disconnect 호출 후 상태를 다시 읽는다
 * - OAuth 콜백은 /schedule.html?google=... 로 복귀한다. 그래야 콜백
 *   쿼리가 있는 페이지에서는 메뉴가 한 번 자동으로 열어 결과를 보여준다.
 * - 데스크톱 창(iframe) 안에 마운트하지 않는 등 아래 프레임의
 *   상단바가 연동 메뉴를 만든다.
 * - 토큰 값은 다루지 않는다 (상태 요약만 사용)
 *
 * 순수 로직(describeGoogleStatus / googleCallbackNotice)은 Jest에서 직접 검증하고,
 * createConnectMenu()를 DOM등fetch를location주history입window받nav아 임
 * JSDOM로 검증한다.
 * 브라우저에서는 전역 GoogleConnect로 노출하고, 최상위 문서에서 자동 마운트한다.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GoogleConnect = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GOOGLE_OAUTH_START_URL = '/api/google/oauth/start';
  var GOOGLE_STATUS_URL = '/api/google/status';
  var GOOGLE_DISCONNECT_URL = '/api/google/disconnect';

  // Lucide "link" 아이콘 (ISC) 의 설정 메뉴 항목 아이콘. nav.js의 아이콘
  // 상수와 같은 이유로 인라인 SVG 문자열로 넣는다.
  var GOOGLE_CONNECT_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-link" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  /**
   * /api/google/status 응답을 화면 표시용으로 변환한다.
   * - connected: 연결됨 (이메일이 있으면 표시), 연결 버튼 숨김·해제 버튼 표시
   * - 미연결 + configured:false: OAuth 자체가 미설정이므로 연결 버튼 비활성화
   * - 미연결 + configured:true/미상: 연결 버튼 활성화
   * - null/비객체(조회 실패): 상태 확인 불가, 연결 버튼은 보여 재시도 가능하게 한다
   * email만이 렌더링이 콜백 안내를 함께 보여준 등 이다 (desc만 박으면
   * 안내가 desc를 덮어 이메일이 사라진다 — 2026-10-28 QA 결함 ②).
   */
  function describeGoogleStatus(status) {
    if (!status || typeof status !== 'object') {
      return {
        state: 'unknown',
        label: '상태 확인 불가',
        desc: '연동 상태를 불러오지 못했어요. 새로고침해 주세요.',
        connectVisible: true,
        disconnectVisible: false,
        connectDisabled: false,
      };
    }
    // J-01: revoked등 '연결 등 등과'구분 한다 연 동은 죽은 것이고
    // 사용자의 인증이 필요하다는 사실과 행동을 함께 보여준다.
    if (status.needsReauth || status.status === 'revoked') {
      return {
        state: 'revoked',
        label: '인증 필요',
        desc: 'Google 연동이 끊겼어요 (인증 만료거나 취소됨). 일정메일 동기화가 멈춰 있으니 다시 연결해 주세요.' +
          (status.email ? ' (' + status.email + ')' : ''),
        email: status.email || '',
        connectVisible: true,
        disconnectVisible: false,
        connectDisabled: status.configured === false,
        connectLabel: '다시 연결하기',
      };
    }
    if (!status.connected && status.status === 'error') {
      return {
        state: 'error',
        label: '연동 오류',
        desc: 'Google 연동 정보를 읽지 못했어요. 다시 연결해 주세요.',
        email: status.email || '',
        connectVisible: true,
        disconnectVisible: false,
        connectDisabled: status.configured === false,
        connectLabel: '다시 연결하기',
      };
    }
    if (status.connected) {
      return {
        state: 'connected',
        label: '연결됨',
        desc: status.email
          ? status.email + ' 계정으로 연결되어 있어요.'
          : 'Google 계정이 연결되어 있어요.',
        email: status.email || '',
        connectVisible: false,
        disconnectVisible: true,
        connectDisabled: false,
      };
    }
    if (status.configured === false) {
      return {
        state: 'disconnected',
        label: '연결 안 됨',
        desc: 'Google 연동 설정이 아직 안 되어 있어요.',
        connectVisible: true,
        disconnectVisible: false,
        connectDisabled: true,
      };
    }
    return {
      state: 'disconnected',
      label: '연결 안 됨',
      desc: 'Gmail·캘린더를 함께 보려면 Google 계정을 연결하세요.',
      connectVisible: true,
      disconnectVisible: false,
      connectDisabled: false,
    };
  }

  /** OAuth 콜백 복귀 쿼리(?google=...)에 대한 한 줄 안내. 모르면 null. */
  function googleCallbackNotice(param) {
    if (param === 'connected') return 'Google 계정이 연결됐어요.';
    if (param === 'denied') return 'Google 연결이 거부됐어요. 다시 시도해 주세요.';
    if (param === 'error') return 'Google 연결 중 오류가 발생했어요. 다시 시도해 주세요.';
    return null;
  }

  /**
   * Google 연동 패널을 만들고 설정 메뉴의 'Google 연동' 항목에 등록한다.
   * deps를 주입하지 않으면 브라우저 전역에 이다.
   * @param {Object} [deps] { doc, fetchFn, location, history, win, lucide, nav }
   *   nav는 window.MyHubNav 전체 주입(테스트용).
   * @returns {Element|null} 만든(또는 내부 있는) 패널 루트(#myhubConnectMenu).
   *   프레임 문서.g-nav 없음doc/win 없음에도 null숨기고 어떤것도 만들지 않는다.
   */
  function createConnectMenu(deps) {
    deps = deps || {};
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var loc = deps.location || (win ? win.location : null);
    var hist = deps.history || (win ? win.history : null);
    if (!doc || !win) return null;
    // 프레 임된(문서 데스크톱 창의 iframe)등 아래 프레임의 상단바가 만든다
    if (win.top !== win) return null;
    var nav = doc.querySelector('.g-nav');
    if (!nav) return null;
    var existingRoot = doc.getElementById('myhubConnectMenu');
    if (existingRoot) return existingRoot;

    // OAuth 콜백 복귀(?google=connected|denied|error) 등 안내를 한 번만
    // 보여 주고 쿼리를. 지운다 ASCII 값은 리터럴 없이 파싱한다.
    var notice = null;
    var callbackArrived = false;
    var search = loc && loc.search ? loc.search : '';
    var m = /[?&]google=([^&]*)/.exec(search);
    if (m) {
      notice = googleCallbackNotice(m[1]);
      callbackArrived = !!notice;
      if (hist && hist.replaceState) {
        hist.replaceState(null, '', loc.pathname || '/');
      }
    }

    // 쓰기 활성화 여부 — /api/google/status의 writeEnabled로만 판정한다.
    // true면 연결 버튼이 ?mode=write로 시작해 재연결해도 쓰기 scope가 유지된다
    // (2026-10-28 QA 결함 ①). 조회 전·실패 시 false(읽기 전용 시작)가 안전 기본값.
    var writeEnabled = false;

    // ---- 패널 (설정 메뉴와 같은 구조: 루트 > 배경 + 패널) ----
    var root = doc.createElement('div');
    root.id = 'myhubConnectMenu';
    root.className = 'myhub-connect-root';
    root.hidden = true;

    var backdrop = doc.createElement('div');
    backdrop.className = 'myhub-connect-backdrop';
    backdrop.addEventListener('click', function () { closeMenu(); });
    root.appendChild(backdrop);

    var panel = doc.createElement('div');
    panel.className = 'myhub-connect-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Google 연동');

    var head = doc.createElement('div');
    head.className = 'myhub-connect-head';
    var icon = doc.createElement('i');
    icon.setAttribute('data-lucide', 'link');
    icon.setAttribute('aria-hidden', 'true');
    head.appendChild(icon);
    var title = doc.createElement('span');
    title.className = 'myhub-connect-title';
    title.textContent = 'Google 연동';
    head.appendChild(title);
    var pill = doc.createElement('span');
    pill.className = 'myhub-connect-pill';
    pill.setAttribute('data-state', 'unknown');
    pill.textContent = '확인 중지';
    head.appendChild(pill);
    panel.appendChild(head);

    var desc = doc.createElement('p');
    desc.className = 'myhub-connect-desc';
    desc.textContent = 'Gmail연동 상태를 확인 하고 있어요.';
    panel.appendChild(desc);

    var meta = doc.createElement('p');
    meta.className = 'myhub-connect-meta';
    meta.hidden = true;
    panel.appendChild(meta);

    var actions = doc.createElement('div');
    actions.className = 'myhub-connect-actions';
    var connectBtn = doc.createElement('button');
    connectBtn.type = 'button';
    connectBtn.className = 'myhub-connect-action solid';
    connectBtn.textContent = '연결하기';
    connectBtn.style.display = 'none';
    actions.appendChild(connectBtn);
    var disconnectBtn = doc.createElement('button');
    disconnectBtn.type = 'button';
    disconnectBtn.className = 'myhub-connect-action ghost';
    disconnectBtn.textContent = '연결 해제';
    disconnectBtn.style.display = 'none';
    actions.appendChild(disconnectBtn);
    panel.appendChild(actions);

    var note = doc.createElement('p');
    note.className = 'myhub-connect-note';
    panel.appendChild(note);

    root.appendChild(panel);
    doc.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || root.hidden) return;
      closeMenu();
    });
    doc.body.appendChild(root);

    // 동적으로 넣은 Lucide 아이콘 만든 직후 변환해 보인다
    var lucideApi = deps.lucide || win.lucide ||
      (typeof lucide !== 'undefined' ? lucide : null);
    if (lucideApi && typeof lucideApi.createIcons === 'function') {
      try {
        lucideApi.createIcons();
      } catch (e) {
        console.warn('연동 메뉴 아이콘 생성 실패:', e);
      }
    }

    function renderLastSync(status) {
      var list = status && Array.isArray(status.lastSync) ? status.lastSync : null;
      var latest = list && list.length ? list[0] : null;
      if (!latest || typeof latest !== 'object') {
        meta.hidden = true;
        meta.textContent = '';
        return;
      }
      var kindLabel = latest.kind === 'calendar' ? '캘린더'
        : latest.kind === 'gmail' ? '硫붿씪' : '';
      var parts = [];
      if (kindLabel) parts.push(kindLabel);
      if (latest.created_at) parts.push(String(latest.created_at).trim());
      if (latest.detail) parts.push(String(latest.detail).trim());
      if (!parts.length) {
        meta.hidden = true;
        meta.textContent = '';
        return;
      }
      meta.textContent = '최근 동기화: ' + parts.join(' · ');
      meta.hidden = false;
    }

    function renderStatus(status) {
      var view = describeGoogleStatus(status);
      pill.textContent = view.label;
      pill.setAttribute('data-state', view.state);
      // 콜백 복귀 안내(notice)가 있어도 연결된 클릭을 함께 보여준다.
      // 안내만 띄워두면 클릭이 사라짐 (2026-10-28 QA 결과 고침건)
      // 안내 + 클릭 설명을 합친다. 안내는 첫 렌더링에서만 낸다.
      var descText = notice || view.desc;
      if (notice && view.state === 'connected' && view.email) {
        descText = notice + ' ' + view.desc;
      }
      desc.textContent = descText;
      notice = null;
      connectBtn.textContent = view.connectLabel || '연결하기';
      connectBtn.style.display = view.connectVisible ? '' : 'none';
      disconnectBtn.style.display = view.disconnectVisible ? '' : 'none';
      if (view.connectDisabled) {
        connectBtn.setAttribute('disabled', 'disabled');
        connectBtn.title = 'Google 연동 설정이 아직 등 남아 있어요';
      } else {
        connectBtn.removeAttribute('disabled');
        connectBtn.title = '';
      }
      note.textContent = writeEnabled ? '캘린더메일 쓰기 가능' : '읽기 전용';
      renderLastSync(status);
    }

    function loadStatus() {
      if (!fetchFn) {
        writeEnabled = false;
        renderStatus(null);
        return Promise.resolve(null);
      }
      return fetchFn(GOOGLE_STATUS_URL)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          writeEnabled = !!(data && data.writeEnabled);
          renderStatus(data);
          return data;
        })
        .catch(function (err) {
          writeEnabled = false;
          console.warn('Google 연동 상태 조회 실패:', err);
          renderStatus(null);
          return null;
        });
    }

    function openMenu() {
      root.hidden = false;
      return loadStatus();
    }
    function closeMenu() {
      root.hidden = true;
    }

    // ---- 진입점: 설정 메뉴 항목 등록 ----
    // google-connect.js가 nav.js보다 먼저 실행되므로 window.MyHubNav가
    // 아직 없을 수가 있다. 없으면 DOMContentLoaded에 한 번만 시도하고
    // (클래스 스크립트 등 등 그 위에 실행한다), 그래야 없으면 조용히
    // 여기서 등 패널 자체의 콜백 자동 숨김 기능으로 사전에 동작한다.
    // 항목 클 릭은 nav.js가 onSelect 에 설정 메뉴를 레으로, 여기로
    // 패 널만 연다.
    var settingsItemRegistered = false;
    function registerSettingsItem() {
      if (settingsItemRegistered) return;
      var navApi = deps.nav || win.MyHubNav;
      if (!navApi || typeof navApi.addSettingsItems !== 'function') return;
      navApi.addSettingsItems([{
        id: 'google-connect',
        label: 'Google 연동',
        iconSvg: GOOGLE_CONNECT_ICON_SVG,
        onSelect: function () { openMenu(); },
      }]);
      settingsItemRegistered = true;
    }
    registerSettingsItem();
    if (!settingsItemRegistered) {
      var onReady = function () {
        doc.removeEventListener('DOMContentLoaded', onReady);
        registerSettingsItem();
      };
      doc.addEventListener('DOMContentLoaded', onReady);
    }

    connectBtn.addEventListener('click', function () {
      if (connectBtn.hasAttribute('disabled')) return;
      if (loc) loc.href = writeEnabled ? GOOGLE_OAUTH_START_URL + '?mode=write' : GOOGLE_OAUTH_START_URL;
    });
    disconnectBtn.addEventListener('click', function () {
      if (!fetchFn) return;
      disconnectBtn.setAttribute('disabled', 'disabled');
      fetchFn(GOOGLE_DISCONNECT_URL, { method: 'POST' })
        .then(function () { return loadStatus(); })
        .catch(function (err) {
          console.warn('Google 연결 해제 실패:', err);
          renderStatus({ connected: false, configured: true });
        })
        .then(function () { disconnectBtn.removeAttribute('disabled'); });
    });

    // 콜백으로 복귀한 페이지(일정 화면)에서도 결과를 바로 보여준다
    if (callbackArrived) openMenu();

    return root;
  }

  /**
   * 일정 페이지 상단의 인라인 상태 행(#googleStatusLabel 등)을 배선한다.
   * 패널(#myhubConnectMenu)과 별개의 고정 요소라, 페이지 로드 시 상태를
   * 한 번 불러와 describeGoogleStatus로 그리고 버튼을 연결한다.
   * 요소가 없는 페이지에서는 아무 것도 하지 않는다.
   * 반환: 상태를 다시 그리는 loadInline 함수 (요소가 없으면 null).
   */
  function wireInlineStatusRow(doc, fetchFn, loc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.getElementById !== 'function') return null;
    var label = doc.getElementById('googleStatusLabel');
    if (!label) return null;
    var desc = doc.getElementById('googleStatusDesc');
    var connectBtn = doc.getElementById('googleConnectBtn');
    var disconnectBtn = doc.getElementById('googleDisconnectBtn');
    var writeEnabledInline = false;

    function paint(status) {
      var view = describeGoogleStatus(status);
      label.textContent = view.label;
      label.setAttribute('data-state', view.state);
      if (desc) desc.textContent = view.desc;
      if (connectBtn) {
        connectBtn.textContent = view.connectLabel || '연결하기';
        connectBtn.style.display = view.connectVisible ? '' : 'none';
        if (view.connectDisabled) connectBtn.setAttribute('disabled', 'disabled');
        else connectBtn.removeAttribute('disabled');
      }
      if (disconnectBtn) {
        disconnectBtn.style.display = view.disconnectVisible ? '' : 'none';
      }
    }

    function loadInline() {
      if (!fetchFn) { paint(null); return Promise.resolve(null); }
      return fetchFn(GOOGLE_STATUS_URL)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          writeEnabledInline = !!(data && data.writeEnabled);
          paint(data);
          return data;
        })
        .catch(function (err) {
          console.warn('Google 연동 상태 조회 실패(인라인):', err);
          paint(null);
          return null;
        });
    }

    if (connectBtn) {
      connectBtn.addEventListener('click', function () {
        if (connectBtn.hasAttribute('disabled')) return;
        if (loc) loc.href = writeEnabledInline ? GOOGLE_OAUTH_START_URL + '?mode=write' : GOOGLE_OAUTH_START_URL;
      });
    }
    if (disconnectBtn && fetchFn) {
      disconnectBtn.addEventListener('click', function () {
        disconnectBtn.setAttribute('disabled', 'disabled');
        fetchFn(GOOGLE_DISCONNECT_URL, { method: 'POST' })
          .then(function () { return loadInline(); })
          .catch(function (err) {
            console.warn('Google 연결 해제 실패(인라인):', err);
            paint({ connected: false, configured: true });
          })
          .then(function () { disconnectBtn.removeAttribute('disabled'); });
      });
    }

    loadInline();
    return loadInline;
  }

  // 브라우저 자동 마운트 (최상위 문서에서만 동작 등 프레임 판정과
  // createConnectMenu 안에 이다)
  if (typeof document !== 'undefined') {
    var autoMount = function () {
      createConnectMenu();
      wireInlineStatusRow(
        document,
        typeof fetch === 'function' ? function (u, o) { return fetch(u, o); } : null,
        typeof window !== 'undefined' ? window.location : null,
      );
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoMount);
    } else {
      autoMount();
    }
  }

  return {
    GOOGLE_OAUTH_START_URL: GOOGLE_OAUTH_START_URL,
    GOOGLE_STATUS_URL: GOOGLE_STATUS_URL,
    GOOGLE_DISCONNECT_URL: GOOGLE_DISCONNECT_URL,
    GOOGLE_CONNECT_ICON_SVG: GOOGLE_CONNECT_ICON_SVG,
    describeGoogleStatus: describeGoogleStatus,
    wireInlineStatusRow: wireInlineStatusRow,
    googleCallbackNotice: googleCallbackNotice,
    createConnectMenu: createConnectMenu,
  };
});
