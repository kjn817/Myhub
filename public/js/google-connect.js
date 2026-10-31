/**
 * Google 연동 버튼 — 일정 화면(schedule.html) 상단 행
 *
 * OAuth 콜백이 /schedule.html?google=... 로 복귀하므로 이 화면이 연동의 홈이다.
 * - 상태 표시: GET /api/google/status 응답(connected/configured/email)과 일치
 * - 연결 버튼: /api/google/oauth/start 로 이동. status의 writeEnabled가 true면
 *   ?mode=write를 붙여 쓰기 scope로 시작한다 (플래그 OFF면 읽기 전용 시작 그대로 —
 *   mode=write 없이 재연결하면 저장 토큰이 읽기 전용으로 교체되므로).
 *   콜백 복귀 안내(?google=connected)가 있어도 연결된 이메일은 함께 보여준다.
 * - 해제 버튼: POST /api/google/disconnect 호출 후 상태를 다시 읽는다
 * - 토큰 값은 다루지 않는다 (상태 요약만 사용)
 *
 * 순수 로직(describeGoogleStatus / googleCallbackNotice)은 Jest에서 직접 검증하고,
 * init()은 DOM·fetch·location을 주입받아 JSDOM으로 검증한다.
 * 브라우저에서는 전역 GoogleConnect로 노출되고, 행이 있는 페이지에서 자동 초기화된다.
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

  /**
   * /api/google/status 응답을 화면 표시용으로 변환한다.
   * - connected: 연결됨 (이메일이 있으면 표시), 연결 버튼 숨김·해제 버튼 표시
   * - 미연결 + configured:false: OAuth 자체가 미설정이므로 연결 버튼 비활성화
   * - 미연결 + configured:true/미상: 연결 버튼 활성화
   * - null/비객체(조회 실패): 상태 확인 불가, 연결 버튼은 보여 재시도 가능하게 한다
   * email은 render()가 콜백 안내와 함께 보여줄 때 쓴다 (desc에만 박으면
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

  function render(doc, view, overrideDesc) {
    var labelEl = doc.getElementById('googleStatusLabel');
    var descEl = doc.getElementById('googleStatusDesc');
    var connectBtn = doc.getElementById('googleConnectBtn');
    var disconnectBtn = doc.getElementById('googleDisconnectBtn');
    if (!labelEl || !connectBtn || !disconnectBtn) return;
    labelEl.textContent = view.label;
    labelEl.setAttribute('data-state', view.state);
    // 콜백 복귀 안내(overrideDesc)가 있어도 연결된 이메일은 함께 보여준다.
    // 안내만 덮어씌우면 이메일이 사라져 (2026-10-28 QA 결함 ②) 안내 + 이메일 설명을 합친다.
    var descText = overrideDesc || view.desc;
    if (overrideDesc && view.state === 'connected' && view.email) {
      descText = overrideDesc + ' ' + view.desc;
    }
    if (descEl) descEl.textContent = descText;
    connectBtn.style.display = view.connectVisible ? '' : 'none';
    disconnectBtn.style.display = view.disconnectVisible ? '' : 'none';
    if (view.connectDisabled) {
      connectBtn.setAttribute('disabled', 'disabled');
      connectBtn.title = 'Google 연동 설정이 아직 안 되어 있어요';
    } else {
      connectBtn.removeAttribute('disabled');
      connectBtn.title = '';
    }
  }

  /**
   * 행을 초기화한다. deps를 주입하지 않으면 브라우저 전역을 쓴다.
   * @param {Object} [deps] { doc, fetchFn, location, history }
   * @returns {Promise} 상태 조회가 끝난 뒤 resolve (행이 없으면 null로 resolve)
   */
  function init(deps) {
    deps = deps || {};
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var loc = deps.location || (typeof window !== 'undefined' ? window.location : null);
    var hist = deps.history || (typeof window !== 'undefined' ? window.history : null);
    if (!doc) return Promise.resolve(null);
    if (!doc.getElementById('googleStatusLabel') || !doc.getElementById('googleConnectBtn')) {
      return Promise.resolve(null);
    }

    // OAuth 콜백 복귀(?google=connected|denied|error) — 안내를 한 번만 보여주고 쿼리를 지운다
    // 값은 ASCII 토큰(connected/denied/error)이라 디코딩이 필요 없어 try/catch 없이 파싱한다
    var notice = null;
    var search = loc && loc.search ? loc.search : '';
    var m = /[?&]google=([^&]*)/.exec(search);
    if (m) {
      notice = googleCallbackNotice(m[1]);
      if (hist && hist.replaceState) hist.replaceState(null, '', loc.pathname || '/schedule.html');
    }

    // 쓰기 활성화 여부 — /api/google/status의 writeEnabled로만 판정한다.
    // true면 연결 버튼이 ?mode=write로 시작해 재연결해도 쓰기 scope가 유지된다
    // (2026-10-28 QA 결함 ①). 조회 전·실패 시 false(읽기 전용 시작)가 안전 기본값.
    var writeEnabled = false

    function loadStatus() {
      if (!fetchFn) {
        render(doc, describeGoogleStatus(null), notice);
        notice = null;
        return Promise.resolve(null);
      }
      return fetchFn(GOOGLE_STATUS_URL)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          writeEnabled = !!(data && data.writeEnabled);
          render(doc, describeGoogleStatus(data), notice);
          notice = null;
          return data;
        })
        .catch(function () {
          writeEnabled = false;
          render(doc, describeGoogleStatus(null), notice);
          notice = null;
          return null;
        });
    }

    var connectBtn = doc.getElementById('googleConnectBtn');
    var disconnectBtn = doc.getElementById('googleDisconnectBtn');
    connectBtn.addEventListener('click', function () {
      if (connectBtn.hasAttribute('disabled')) return;
      if (loc) loc.href = writeEnabled ? GOOGLE_OAUTH_START_URL + '?mode=write' : GOOGLE_OAUTH_START_URL;
    });
    disconnectBtn.addEventListener('click', function () {
      if (!fetchFn) return;
      disconnectBtn.setAttribute('disabled', 'disabled');
      fetchFn(GOOGLE_DISCONNECT_URL, { method: 'POST' })
        .then(function () { return loadStatus(); })
        .catch(function () {
          render(doc, describeGoogleStatus({ connected: false, configured: true }));
        })
        .then(function () { disconnectBtn.removeAttribute('disabled'); });
    });

    return loadStatus();
  }

  // 브라우저 자동 초기화 (행이 있는 페이지에서만 동작)
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
      init();
    }
  }

  return {
    GOOGLE_OAUTH_START_URL: GOOGLE_OAUTH_START_URL,
    GOOGLE_STATUS_URL: GOOGLE_STATUS_URL,
    GOOGLE_DISCONNECT_URL: GOOGLE_DISCONNECT_URL,
    describeGoogleStatus: describeGoogleStatus,
    googleCallbackNotice: googleCallbackNotice,
    init: init,
  };
});
