/* MyHub 브라우저 원격 뷰 상태 기계 (browser-live.js)
 *
 * 브라우저 탭의 실제 원격 브라우저(Oracle 상시 기동 서버, Selkies 화면)
 * 하나만 통합한다 (프록시·리더 폐지 2026-11-04, Browser Run 세션 발급
 * 폐기 2026-11-14). browser.js가 createApp 정본의
 * window.MyHubBrowserLive.createLive로 만들면 붙이며, browser.html의
 * 이 파일이 browser.js보다 먼저 불러오는 것이 전제다.
 * enterLive(url?)는 #bwLiveFrame에 /api/browse/view/를 걸고, url이
 * 있으면 POST /api/browse/navigate로 영구 탭을 이동시킨다. 세션이
 * 없어 만료·동시 사용 제한이 없다 — 켜져 있을 때의 enterLive는
 * iframe을 다시 띄우지 않고 이동만 지시한다. url이 없을 때도 측정
 * 뷰포트를 POST /api/browse/viewport로 맞추고 (2026-11-15: 세션 복원
 * 뒤 navigate가 없으면 override가 적용되지 않아 화면이 절반 크기로
 * 보였던 구멍), stage 크기 변화는 ResizeObserver로 다시 맞춘다.
 * 켜져 있는 동안은 GET /api/browse/state를 2초마다 폴링해 원격의
 * 실제 URL·뒤로/앞으로 가능 여부를 onState로 주인에게 알린다
 * (2026-11-15: 셸 로컬 기록만 보던 주소창·뒤로가기는 원격 내 링크
 * 이동을 몰랐다). 뒤로/앞으로 이동은 goBack()/goForward()가
 * POST /api/browse/back|forward로 원격 기록에 지시한다.
 * 핀치 줌 차단 (2026-11-16): 트랙패드 핀치는 브라우저에서 Ctrl+휠로
 * 들어오고, Selkies 클라이언트가 Ctrl 키 + 휠을 원격에 그대로 전달해
 * Chromium이 페이지 줌을 바꾼다 (네이버 90% 사고). iframe이 동일
 * 출처(/api/browse/view/)라 contentWindow에 캡처 단계 wheel 리스너를
 * 걸어 Ctrl+휠만 막는다 — 일반 휠은 그대로 통과한다.
 * nav 키 중계 (2026-11-20): 같은 자리에서 Ctrl+←/→/↑를 캡처 단계로
 * 가로채 셸에 myhub:desktop-nav-key로 올려보낸다 (미션컨트롤 전환).
 * 무조건 전달한다 (사용자 선택 — 단어 이동 손실 감수). Selkies의
 * 캡처 리스너가 먼저 등록되므로 원격이 키를 보는 것까지 막지는
 * 못한다 — 그 차단은 서버 재시작 후 적용되는 사이드카 주입
 * 스크립트가 맡고, 그쪽이 우선하면 이 리스너는 돌지 않는다.
 * 상태: 'off' | 'on' | 'notice' | 'locked'
 * (notice = 503 등 시작 실패 안내 카드를 띄운 상태,
 *  locked = LUKS 볼륨이 잠겨 암호 입력 카드를 띄운 상태).
 * 자기 소유 요소(#bwLiveFrame/#bwNoticeCard/#bwLockCard)를 표시와
 * syncChrome()로 맞추고, 상태 변경 직후에는 deps.onChange()로 주인에게
 * 알려 전체 너비를 다시 그리게 한다.
 * (2026-11-14: 하단 "원격 브라우저" 필(라벨·경과 시간·종료 버튼)
 * 제거 — 시간 제한 세션 시절의 잔재. 오라클 서버는 상시 가동이라
 * 종료 버튼이 서버의 뭘 끄는 게 아니고 화면만 닫는 동작이라 새 탭으로
 * 대체 가능하고, 사파리에도 없는 UI다. 종료는 endLive() API로만.)
 * 노출: window.MyHubBrowserLive = { createLive }
 */
(function () {
  'use strict';

  var VIEW_URL = '/api/browse/view/';

  /* 화질 설정 저장 키 (localStorage). 값은 'auto' 또는 kbps 숫자 문자열.
     수동 값이면 시작 시 POST /api/browse/quality로 다시 적용한다
     (applyStoredQuality — 사이드카가 ?vb= 쿼리를 떼어 버리므로 쿼리만으
     로는 재적용이 안 된다, 2026-11-20 4단계). 자동이면 아무것도 보내지
     않아 Selkies 혼잡 제어가 맡는다. 범위는 사이드카
     BITRATE_FLOOR/CEILING(500~15000)과 동일 — 8000 상한은 현행
     기본값 12000조차 막아 2026-11-20 4단계에서 정정했다. */
  var QUALITY_KEY = 'myhub-bw-quality';
  var QUALITY_MIN_KBPS = 500;
  var QUALITY_MAX_KBPS = 15000;

  /* 상태 폴링·뒤로/앞으로·뷰포트 적용 fetch의 타임아웃 (ms). 서버가
     응답 없이 걸리면 이 시간 뒤에 중단해 호출자가 {status: 0}으로
     정리하게 한다 (2026-11-16 QA 1차: 폴링 fetch가 영원히 걸리면
     statePolling이 안 풀려 주소가 안 바뀌었다. QA 4차: 뷰포트 fetch도
     마찬가지 — 타임아웃이 없으면 한 번의 정체로 적용이 영원히 멈춘다). */
  var FETCH_TIMEOUT_MS = 10000;

  /* fetch에 AbortController 타임아웃을 건다. 요청이 끝나면 타이머를
     지우고, 제한 안에 안 끝나면 abort해 fetch가 reject되게 한다
     (호출자의 catch가 {status: 0, body: null}으로 정리한다).
     AbortController가 없는 환경이면 타임아웃 없이 그대로 보낸다. */
  function fetchWithTimeout(url, init, timeoutMs) {
    if (typeof AbortController !== 'function') return fetch(url, init);
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    var timedInit = init || {};
    timedInit.signal = controller.signal;
    return fetch(url, timedInit).then(
      function (r) {
        clearTimeout(timer);
        return r;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      },
    );
  }

  function readQualityPreference() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return { mode: 'auto' };
      var raw = localStorage.getItem(QUALITY_KEY);
      if (raw === null || raw === '' || raw === 'auto') return { mode: 'auto' };
      var n = parseInt(raw, 10);
      if (!isFinite(n) || n < QUALITY_MIN_KBPS || n > QUALITY_MAX_KBPS) return { mode: 'auto' };
      return { mode: 'manual', bitrate: n };
    } catch (err) {
      return { mode: 'auto' };
    }
  }

  function writeQualityPreference(pref) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      if (pref && pref.mode === 'manual') localStorage.setItem(QUALITY_KEY, String(pref.bitrate));
      else localStorage.setItem(QUALITY_KEY, 'auto');
    } catch (err) {
      // 저장 실패는 무시한다 (다음 시작은 자동 모드로 간다) — 단 조용히는
      // 넘기지 않고 경고를 남긴다 (gate-23: 빈 catch 금지).
      if (typeof console !== 'undefined' && console.warn) console.warn('[browser-live] 화질 설정 저장 실패 (무시):', err);
    }
  }

  /* 화질 전환: Promise<{ status, body }> (테스트 주입 지난과 같은 모양) */
  function defaultSetQuality(payload) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    return fetch('/api/browse/quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 언록 상태 조회: Promise<{ status, body }> (navigate와 같은 모양) */
  function defaultCheckUnlock() {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    return fetch('/api/browse/unlock/status')
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 언록/셋업 제출: mode 'unlock' | 'setup'.
     Promise<{ status, body }> — 암호는 본문으로만 보내고 로그에 남기지 않는다. */
  function defaultSubmitUnlock(mode, password) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    return fetch('/api/browse/unlock/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password }),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 영구 탭 이동: Promise<{ status, body }> (테스트 주입 지난과 같은 모양) */
  function defaultNavigate(url, viewport, targetId) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    var init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    var payload = { url: url };
    // 이동시킬 탭 — 셸이 조작 중인 라이브 탭의 원격 타깃 id. 없으면
    // 서버가 활성 탭으로 간다 (뉴스 팝업이 떠 있을 때 복원 이동이
    // 활성 탭으로 가서 뉴스 탭을 덮어버린 사고의 수정, 2026-11-21).
    if (typeof targetId === 'string' && targetId) payload.targetId = targetId;
    // stage 크기를 보내 원격 뷰포트를 맞춘다 (2026-11-12: 기본
    // 1280x720이 창보다 넓으면 원격 화면이 짤린다).
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      payload.viewport = {
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        dpr: viewport.dpr || 1,
      };
    }
    init.body = JSON.stringify(payload);
    return fetch('/api/browse/navigate', init)
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 이동 없이 원격 뷰포트만 맞춘다 (2026-11-15): 라이브 진입·리사이즈
     때 호출한다. Promise<{ status, body }> — navigate와 같은 모양.
     10초 타임아웃 (2026-11-16 QA 4차): 안 끝나면 {status: 0}으로 돌려
     호출자가 정리하게 한다 — 타임아웃이 없으면 한 번의 정체로 적용이
     영원히 멈춘다 (plain fetch 시절의 결함). */
  function defaultApplyViewport(viewport) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
      return Promise.resolve({ status: 0, body: null });
    }
    return fetchWithTimeout(
      '/api/browse/viewport',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          viewport: {
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
            dpr: viewport.dpr || 1,
          },
        }),
      },
      FETCH_TIMEOUT_MS,
    )
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 마우스 오프셋 보고 (2026-11-18): iframe의 화면상 위치 {x, y}를
     사이드카에 알려 클라이언트가 더해 보낸 창 위치를 빼게 한다.
     Promise<{ status, body }> — applyViewport와 같은 모양. 10초 타임아웃. */
  function defaultReportMouseOffset(offset) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    if (!offset || typeof offset.x !== 'number' || typeof offset.y !== 'number') {
      return Promise.resolve({ status: 0, body: null });
    }
    return fetchWithTimeout(
      '/api/browse/mouse-offset',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x: Math.round(offset.x),
          y: Math.round(offset.y),
          dpr: offset.dpr || 1,
        }),
      },
      FETCH_TIMEOUT_MS,
    )
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 원격 현재 상태 조회: Promise<{ status, body }> (navigate와 같은 모양).
     body는 { ok, url, title, canGoBack, canGoForward }. 10초 타임아웃 —
     안 끝나면 {status: 0}으로 돌려 statePolling이 풀리게 한다. */
  function defaultFetchState() {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    return fetchWithTimeout('/api/browse/state', null, FETCH_TIMEOUT_MS)
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 원격 새로고침: POST /api/browse/reload (CDP Page.reload).
     Promise<{ status, body }> — history와 같은 모양. 10초 타임아웃. */
  function defaultReload() {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    return fetchWithTimeout('/api/browse/reload', { method: 'POST' }, FETCH_TIMEOUT_MS)
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /* 원격 뒤로/앞으로 이동: direction 'back' | 'forward'.
     Promise<{ status, body }> — navigate와 같은 모양. 10초 타임아웃. */
  function defaultHistory(direction) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    var path = direction === 'forward' ? '/api/browse/forward' : '/api/browse/back';
    return fetchWithTimeout(path, { method: 'POST' }, FETCH_TIMEOUT_MS)
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null };
      });
  }

  /**
   * deps = { doc, navigate, applyViewport, onChange, checkUnlock, submitUnlock, setQuality, pollDelayMs, fetchState, history, reload, onState, statePollMs, reportMouseOffset, mouseOffsetPollMs }
   * doc에서 #bwLiveFrame/#bwNoticeCard/#bwNoticeMsg/#bwNoticeClose와
   * #bwLockCard/#bwLockForm/#bwLockPassword/#bwLockConfirm/#bwLockMsg/
   * #bwLockSubmit/#bwLockClose/#bwLockTitle/#bwLockDesc를 찾는다 (없으면
   * 해당 요소만 비활성). navigate(url, viewport, targetId?)는
   * Promise<{status, body}> 테스트 주입 지난 — targetId는 이동시킬
   * 원격 타깃 id (없으면 서버가 활성 탭으로 간다).
   * applyViewport(viewport)는 이동 없는 뷰포트 적용
   * (2026-11-15, 같은 모양의 테스트 주입 지난). checkUnlock()·
   * submitUnlock(mode, password)·setQuality(payload)도 같은 모양의
   * 테스트 주입 지난. pollDelayMs는 제출 후 상태 폴링 간격(기본 5초).
   * fetchState()·history(direction)·reload()도 같은 모양의 테스트 주입
   * 지난 (2026-11-15 원격 상태 폴링·뒤로/앞으로, 2026-11-20 4단계
   * 새로고침). onState(body)는 폴링이
   * 받은 원격 상태를 주인에게 알리는 콜백, statePollMs는 폴링 간격
   * (기본 2000ms). reportMouseOffset(offset)은 iframe 화면 위치 보고
   * (2026-11-18, 같은 모양의 테스트 주입 지난), mouseOffsetPollMs는
   * 그 폴링 간격(기본 500ms — 창 드래그는 ResizeObserver에 안 잡혀
   * 폴링으로만 따라간다). onChange()는 상태 변경 등 주인의 너비를 다시
   * 그리며 알림 콜백. 뷰포트 주기 재적용(2026-11-16 QA 2차, 10초)은
   * 2026-11-17 P1에 폐지했다 — 사이드카 영구 CDP 세션이 새 탭에도
   * 현재 뷰포트를 즉시 적용하므로 클라이언트 재적용이 불필요하다
   * (사이드카 Target.setDiscoverTargets). 뷰포트는 진입·navigate·
   * 리사이즈 때만 맞춘다. 마우스 오프셋 폴링은 뷰포트 재적용이 아니라
   * 창 위치 추적이라 별개다 (setInterval 2개 허용 — viewport 테스트 참조).
   */
  function createLive(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var navigate =
      typeof deps.navigate === 'function' ? deps.navigate : defaultNavigate;
    var applyViewport =
      typeof deps.applyViewport === 'function' ? deps.applyViewport : defaultApplyViewport;
    var checkUnlock =
      typeof deps.checkUnlock === 'function' ? deps.checkUnlock : defaultCheckUnlock;
    var submitUnlock =
      typeof deps.submitUnlock === 'function' ? deps.submitUnlock : defaultSubmitUnlock;
    var setQualityFetch =
      typeof deps.setQuality === 'function' ? deps.setQuality : defaultSetQuality;
    var fetchState =
      typeof deps.fetchState === 'function' ? deps.fetchState : defaultFetchState;
    var historyFetch =
      typeof deps.history === 'function' ? deps.history : defaultHistory;
    var reloadFetch = typeof deps.reload === 'function' ? deps.reload : defaultReload;
    var reportMouseOffsetFetch =
      typeof deps.reportMouseOffset === 'function'
        ? deps.reportMouseOffset
        : defaultReportMouseOffset;
    var pollDelayMs = typeof deps.pollDelayMs === 'number' ? deps.pollDelayMs : 5000;
    var statePollMs = typeof deps.statePollMs === 'number' ? deps.statePollMs : 2000;
    var mouseOffsetPollMs =
      typeof deps.mouseOffsetPollMs === 'number' ? deps.mouseOffsetPollMs : 500;
    var onChange =
      typeof deps.onChange === 'function'
        ? deps.onChange
        : function () {
            return undefined;
          };
    var onState =
      typeof deps.onState === 'function'
        ? deps.onState
        : function () {
            return undefined;
          };
    var liveFrame = doc.getElementById('bwLiveFrame');
    var noticeCard = doc.getElementById('bwNoticeCard');
    var noticeMsg = doc.getElementById('bwNoticeMsg');
    var noticeClose = doc.getElementById('bwNoticeClose');
    var lockCard = doc.getElementById('bwLockCard');
    var lockTitle = doc.getElementById('bwLockTitle');
    var lockDesc = doc.getElementById('bwLockDesc');
    var lockForm = doc.getElementById('bwLockForm');
    var lockPassword = doc.getElementById('bwLockPassword');
    var lockConfirm = doc.getElementById('bwLockConfirm');
    var lockMsg = doc.getElementById('bwLockMsg');
    var lockSubmit = doc.getElementById('bwLockSubmit');
    var lockClose = doc.getElementById('bwLockClose');
    /* 원격 상태: 'off' | 'on' | 'notice' | 'locked' */
    var liveState = 'off';
    var liveGen = 0; // 이동 응답이 늦게 도착해 종료 후에 상태를 건드리지 않기 위한 지난 번호
    var lockMode = 'unlock'; // 'unlock' | 'setup' — 카드가 보여주는 모드
    var pendingUrl = null; // 잠금 때문에 못 간 주소 (풀리면 이동한다)
    var pendingTargetId = null; // pendingUrl과 함께 갈 이동 대상 타깃 id
    var lockBusy = false; // 제출 진행 중 (중복 제출 방지)
    /* 뷰포트 적용 상태 (2026-11-15): 마지막으로 적용된 크기·리사이즈
       디바운스 타이머·백오프 재시도 타이머·stage 관찰자. */
    var lastAppliedViewport = null;
    var viewportTimer = null;
    var viewportRetryTimer = null;
    var viewportRetryCount = 0;
    var lastFailedViewport = null;
    var stageObserver = null;
    /* 마우스 오프셋 보고 상태 (2026-11-18): 마지막으로 보고한 iframe
       화면 위치·폴링 타이머. */
    var lastReportedMouseOffset = null;
    var mouseOffsetTimer = null;
    var frameChainWarned = false;
    /* 원격 상태 폴링 상태 (2026-11-15): 주기 타이머·진행 중 플래그·
       진행 중 폴링의 Promise (2026-11-17 N2: 뒤로/앞으로 이동이 상태
       재조회 완료를 기다려 로딩 표시를 끌 수 있게 한다). */
    var statePollTimer = null;
    var statePolling = false;
    var statePollPromise = null;
    var statePollFailed = false; // 직전 폴링 실패 여부 — 복구 시 마우스 오프셋 재전송 트리거
    /* 일시 안내 (2026-11-20 4단계): 새로고침 실패 같은 일시 알림을
       안내 카드에 띄운다. liveState를 'notice'로 바꾸면 iframe이
       숨겨지므로 상태 기계는 건드리지 않고 별도 플래그로만 표시한다.
       6초 뒤 자동으로 사라지고, 닫기 버튼으로도 닫힌다. */
    var transientNotice = false;
    var transientNoticeTimer = null;
    var TRANSIENT_NOTICE_MS = 6000;
    /* 저장된 화질 재적용 (2026-11-20 4단계): 시작 시 저장된 수동
       비트레이트를 POST로 다시 적용한다. 화면 WS가 아직 안 붙었으면
       connections: 0이라 적용이 안 되므로 다음 폴링 때 다시 시도한다
       (최대 10회 ≈ 20초). 자동 저장값이면 null이라 아무것도 안 보낸다. */
    var qualityPending = null;
    var qualityAttempts = 0;
    var qualityApplying = false;
    var QUALITY_REAPPLY_MAX_ATTEMPTS = 10;
    function sameViewport(a, b) {
      if (!a || !b) return false;
      return (
        Math.round(a.width) === Math.round(b.width) &&
        Math.round(a.height) === Math.round(b.height) &&
        Math.round((a.dpr || 1) * 1000) === Math.round((b.dpr || 1) * 1000)
      );
    }

    /* 뷰포트 재시도 간격 (2026-11-18 백오프): 2초 단발 재시도로는
       1078×658 축소 적용이 유실된 전례가 있다 — 실패가 두 번 겹치면
       그 크기는 다시 안 간다. 2초·5초·15초 세 번까지 다시 시도하고,
       새 크기가 오면 횟수를 리셋한다. */
    var VIEWPORT_RETRY_DELAYS_MS = [2000, 5000, 15000];

    /* 뷰포트를 서버에 적용하고 성공하면 기록한다. 실패하면 기록하지
       않고 백오프 간격으로 최대 3번 다시 시도한다 (서버 일시 장애
       대비 — 새 크기가 오면 횟수를 리셋한다). 같은 크기는 다시 보내지
       않는다 (2026-11-17 P1: 10초 주기 재적용 폐지 — 새 탭 적용은
       사이드카 영구 CDP가 맡으므로 클라이언트가 같은 크기를 되풀이할
       이유가 없다). 늦게 도착한 응답은 liveGen으로 버린다 — endLive
       뒤에 lastAppliedViewport를 채우면 다음 시작 때 같은 크기의
       적용을 건너뛰어 버린다. */
    function applyViewportNow(viewport) {
      if (!viewport || viewport.width <= 0 || viewport.height <= 0) return Promise.resolve(false);
      if (sameViewport(viewport, lastAppliedViewport)) return Promise.resolve(true);
      if (!sameViewport(viewport, lastFailedViewport)) viewportRetryCount = 0;
      var gen = liveGen;
      return applyViewport(viewport).then(function (res) {
        if (gen !== liveGen || liveState !== 'on') return false;
        if (res && res.status === 200 && res.body && res.body.ok) {
          lastAppliedViewport = {
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
            dpr: viewport.dpr || 1,
          };
          lastFailedViewport = null;
          viewportRetryCount = 0;
          return true;
        }
        lastFailedViewport = {
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          dpr: viewport.dpr || 1,
        };
        if (viewportRetryCount < VIEWPORT_RETRY_DELAYS_MS.length && viewportRetryTimer === null && liveState === 'on') {
          var delay = VIEWPORT_RETRY_DELAYS_MS[viewportRetryCount];
          viewportRetryCount += 1;
          viewportRetryTimer = setTimeout(function () {
            viewportRetryTimer = null;
            if (liveState !== 'on') return;
            var current = measureViewport();
            if (current && !sameViewport(current, lastAppliedViewport)) applyViewportNow(current);
          }, delay);
        }
        return false;
      });
    }

    /* iframe의 화면상 위치를 잰다 (2026-11-18 호버 캘리브레이션).
       Selkies 클라이언트가 iframe 좌표에 이 위치를 더해 보내므로,
       사이드카가 같은 값을 빼서 되돌린다. iframe이 없거나 숨겨져
       있으면(0 크기) null — 그때는 마지막 보고 값을 유지한다.
       주의: 브라우저 앱은 데스크톱 창 iframe 안에서 돈다 (중첩
       iframe). 직접 잰 rect는 앱 iframe 기준이라 임베드 시 (0,0)이
       나온다 (g-nav·툴바가 숨혀져 스테이지가 앱 최상단부터 시작).
       보정에 필요한 건 최상위 뷰포트 기준 위치이므로 frameElement
       체인을 따라 부모 iframe들의 위치를 더한다. 단독 실행이면
       frameElement가 null이라 그대로 쓰고, 크로스오리진으로 접근이
       막히면(예외) 가진 값으로 폴백한다 (경고는 한 번만). */
    function measureMouseOffset() {
      if (!liveFrame || typeof liveFrame.getBoundingClientRect !== 'function') return null;
      var r = liveFrame.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      var x = r.left;
      var y = r.top;
      try {
        var view = doc.defaultView;
        while (view && view.frameElement) {
          var fr = view.frameElement.getBoundingClientRect();
          if (!fr) break;
          x += fr.left;
          y += fr.top;
          if (view === view.parent) break;
          view = view.parent;
        }
      } catch (e) {
        if (!frameChainWarned && typeof console !== 'undefined' && typeof console.warn === 'function') {
          frameChainWarned = true;
          console.warn('[browser-live] frameElement 체인 접근 불가, 직접 잰 오프셋 사용');
        }
      }
      // 디바이스 px로 바꿔 보낸다 (2026-11-19): 서버 디스플레이·마우스
      // 좌표계가 디바이스 px이라 CSS px 그대로 보내면 레티나에서 절반만
      // 보정된다. dpr도 함께 보내 사이드카가 이미 디바이스 px임을 안다.
      var dpr = readDevicePixelRatio();
      return { x: Math.round(x * dpr), y: Math.round(y * dpr), dpr: dpr };
    }

    function sameMouseOffset(a, b) {
      if (!a || !b) return false;
      return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
    }

    /* 바뀐 위치만 보고한다. 실패하면 기록하지 않아 다음 폴링·리사이즈
       때 다시 시도한다. 보고 자체가 실패해도 화면 동작은 막지 않는다. */
    function reportMouseOffsetNow() {
      if (liveState !== 'on') return Promise.resolve(false);
      var current = measureMouseOffset();
      if (!current || sameMouseOffset(current, lastReportedMouseOffset)) {
        return Promise.resolve(true);
      }
      var gen = liveGen;
      return reportMouseOffsetFetch(current).then(function (res) {
        if (gen !== liveGen || liveState !== 'on') return false;
        if (res && res.status === 200 && res.body && res.body.ok) {
          lastReportedMouseOffset = {
            x: Math.round(current.x),
            y: Math.round(current.y),
            dpr: current.dpr || 1,
          };
          return true;
        }
        return false;
      });
    }

    /* 마우스 오프셋 폴링: 즉시 한 번 보고하고 이후 주기적으로 잰다.
       창 드래그(이동)는 ResizeObserver에 안 잡히므로 폴링으로만
       따라간다. 위치가 안 바뀌면 보고를 안 보내 트래픽이 없다. */
    function startMouseOffsetPolling() {
      stopMouseOffsetPolling();
      reportMouseOffsetNow();
      mouseOffsetTimer = setInterval(reportMouseOffsetNow, mouseOffsetPollMs);
    }

    function stopMouseOffsetPolling() {
      if (mouseOffsetTimer !== null) {
        clearInterval(mouseOffsetTimer);
        mouseOffsetTimer = null;
      }
    }

    /* stage 크기 변화를 감지해 뷰포트를 다시 맞춘다. 창을 최대화·복원
       하거나 크기를 바꾸면 override가 옛 크기에 머물러 화면이 다시
       절반·두 배로 보이기 때문이다. 관찰자는 라이브가 켜질 때만 건다. */
    function resizeObserverCtor() {
      var view = doc.defaultView;
      if (view && typeof view.ResizeObserver === 'function') return view.ResizeObserver;
      if (typeof ResizeObserver === 'function') return ResizeObserver;
      return null;
    }

    function startStageObserver() {
      stopStageObserver();
      var Ctor = resizeObserverCtor();
      var stage = liveFrame && liveFrame.parentElement;
      if (!Ctor || !stage) return;
      stageObserver = new Ctor(function () {
        if (liveState !== 'on') return;
        if (viewportTimer !== null) clearTimeout(viewportTimer);
        viewportTimer = setTimeout(function () {
          viewportTimer = null;
          if (liveState !== 'on') return;
          var current = measureViewport();
          if (current) applyViewportNow(current);
          reportMouseOffsetNow();
        }, 300);
      });
      stageObserver.observe(stage);
    }

    function stopStageObserver() {
      if (stageObserver) {
        try {
          stageObserver.disconnect();
        } catch (err) {
          // 관찰자 해제는 실패해도 무시한다 (이미 끊긴 경우) — 단 조용히는
          // 넘기지 않고 경고를 남긴다 (gate-23: 빈 catch 금지).
          if (typeof console !== 'undefined' && console.warn) console.warn('[browser-live] stage 관찰자 해제 실패 (무시):', err);
        }
        stageObserver = null;
      }
      if (viewportTimer !== null) {
        clearTimeout(viewportTimer);
        viewportTimer = null;
      }
      if (viewportRetryTimer !== null) {
        clearTimeout(viewportRetryTimer);
        viewportRetryTimer = null;
      }
    }

    /* 원격 상태를 한 번 묻고 받으면 onState로 주인에게 알린다.
       탭이 hidden이면 쉬고 (백그라운드 폴링 낭비 방지), 요청이
       진행 중이면 겹치지 않는다. 늦게 도착한 응답은 liveGen으로
       걸러 종료 뒤에 상태를 건드리지 않는다.
       완료 시점에 resolve되는 Promise를 돌려준다 — 뒤로/앞으로
       이동이 상태 재조회 완료를 기다려 로딩 표시를 끌 수 있게 한다
       (2026-11-17 N2). 진행 중 폴링이 있으면 그 Promise를 공유하고,
       건너뛰면 즉시 resolve되는 Promise를 돌려준다. resolve 값은
       상태 반영 여부(true/false)이며, fetch 실패도 false로 resolve돼
       reject되지 않는다 (호출자가 로딩을 끄는 데만 쓴다). */
    /* 뷰포트 정합 (2026-11-19): 리사이즈 보고가 유실되면 override가 옛
       크기에 머물러 화면이 절반만 보인다 (새로고침 직후 최대화 때
       1018×765에 머문 실화면 전례 — 보고가 한 번 빠지면 되돌리는
       경로가 없었다). 상태 폴링(2초)에 실어 매번 재고, 적용된 크기가
       있고 측정값과 다를 때만 다시 보낸다. 초기 적용 전에는 시작
       경로(navigate·applyViewportNow)가 맡으므로 그때는 건드리지
       않는다 — 안 그러면 시작할 때 같은 크기를 두 번 보내게 된다.
       정상이면 측정만 하고 요청은 나가지 않는다 (같은 크기를 되풀이
       보내는 주기 재적용이 아니다 — P1 폐지 취지 유지). */
    function reconcileViewport() {
      if (!lastAppliedViewport) return;
      var current = measureViewport();
      if (current && !sameViewport(current, lastAppliedViewport)) applyViewportNow(current);
    }

    function pollStateOnce() {
      if (liveState !== 'on') return Promise.resolve(false);
      if (doc.hidden) return Promise.resolve(false);
      reconcileViewport();
      if (statePolling) return statePollPromise || Promise.resolve(false);
      var gen = liveGen;
      statePolling = true;
      statePollPromise = fetchState().then(
        function (res) {
          statePolling = false;
          statePollPromise = null;
          if (gen !== liveGen || liveState !== 'on') return false;
          var body = res && res.body;
          if (res && res.status === 200 && body && body.ok) {
            // 폴링 실패 뒤 복구됐다면 사이드카가 재시작됐을 수 있다 —
            // 재시작은 메모리 속 마우스 오프셋을 지우는데 프론트는
            // lastReported와 같다고 보고를 건너뛰어 버린다. 보고 기록을
            // 비워 다음 오프셋 폴링(500ms)이 다시 보내게 한다.
            if (statePollFailed) {
              statePollFailed = false;
              lastReportedMouseOffset = null;
            }
            onState(body);
            // 저장된 수동 화질이 아직 적용 전이면 여기서 다시 시도한다
            // (첫 폴링 때는 화면 WS가 안 붙어 connections: 0일 수 있다).
            if (qualityPending !== null) applyStoredQuality();
            return true;
          }
          statePollFailed = true;
          return false;
        },
        function () {
          statePolling = false;
          statePollPromise = null;
          statePollFailed = true;
          return false;
        },
      );
      return statePollPromise;
    }

    /* 상태 폴링 시작: 즉시 한 번 묻고 이후 주기적으로 묻는다 (주소창이
       간격만큼 늦게 바뀌지 않게 한다). */
    function startStatePolling() {
      stopStatePolling();
      pollStateOnce();
      statePollTimer = setInterval(pollStateOnce, statePollMs);
    }

    function stopStatePolling() {
      if (statePollTimer !== null) {
        clearInterval(statePollTimer);
        statePollTimer = null;
      }
    }

    /* 원격 뒤로/앞으로 이동: 성공 여부를 돌려준다. 꺼져 있으면 false
       (주인은 라이브가 꺼져 있을 때만 로컬 기록으로 폴백한다 —
       켜져 있을 때의 폴백은 낡은 기록으로 엉뚱한 곳에 간다, 2026-11-16). */
    function goHistory(direction) {
      if (liveState !== 'on') return Promise.resolve(false);
      return historyFetch(direction).then(
        function (res) {
          var body = res && res.body;
          return !!(res && res.status === 200 && body && body.ok);
        },
        function () {
          return false;
        },
      );
    }

    /* 원격 새로고침 (2026-11-20 4단계): live가 켜져 있을 때만
       /reload를 부르고 성공 여부를 boolean으로 돌려준다. 실패하면
       호출자가 안내한다 — 재이동으로 조용히 폴백하지 않는다. */
    function reload() {
      if (liveState !== 'on') return Promise.resolve(false);
      return reloadFetch().then(
        function (res) {
          var body = res && res.body;
          return !!(res && res.status === 200 && body && body.ok);
        },
        function () {
          return false;
        },
      );
    }

    /* 현재 화질 설정 (메뉴 체크 표시용): {mode:'auto'} 또는
       {mode:'manual', bitrate}. 저장값이 없으면 'auto'다 — 시작 시
       아무것도 보내지 않아 현행 기본값이 그대로 유지된다. */
    function getQuality() {
      return readQualityPreference();
    }

    function setNotice(text) {
      if (noticeMsg) noticeMsg.textContent = text;
    }

    /* 일시 안내를 띄운다 (2026-11-20 4단계): 새로고침 실패 같은
       일시 알림. 상태 기계는 건드리지 않으므로 라이브 화면은 그대로
       보이고, 카드는 6초 뒤 자동으로 사라진다. */
    function showNotice(text) {
      setNotice(text);
      transientNotice = true;
      if (transientNoticeTimer) clearTimeout(transientNoticeTimer);
      transientNoticeTimer = setTimeout(function () {
        hideTransientNotice();
      }, TRANSIENT_NOTICE_MS);
      syncChrome();
    }

    function hideTransientNotice() {
      if (!transientNotice) return;
      transientNotice = false;
      if (transientNoticeTimer) {
        clearTimeout(transientNoticeTimer);
        transientNoticeTimer = null;
      }
      syncChrome();
    }

    function setLockMsg(text) {
      if (!lockMsg) return;
      if (text) {
        lockMsg.textContent = text;
        lockMsg.hidden = false;
      } else {
        lockMsg.textContent = '';
        lockMsg.hidden = true;
      }
    }

    function setLockBusy(busy, label) {
      lockBusy = busy;
      if (lockSubmit) {
        lockSubmit.disabled = busy;
        if (label) lockSubmit.textContent = label;
        else lockSubmit.textContent = lockMode === 'setup' ? '설정하기' : '풀기';
      }
      if (lockPassword) lockPassword.disabled = busy;
      if (lockConfirm) lockConfirm.disabled = busy;
    }

    function clearLockInputs() {
      if (lockPassword) lockPassword.value = '';
      if (lockConfirm) lockConfirm.value = '';
    }

    /* 자기 소유 요소만 갱신한다 등 나머지 너비 주인과 syncChrome 모양 */
    function syncChrome() {
      var liveOn = liveState === 'on';
      if (liveFrame) liveFrame.hidden = !liveOn;
      if (noticeCard) noticeCard.hidden = liveState !== 'notice' && !transientNotice;
      if (lockCard) lockCard.hidden = liveState !== 'locked';
    }

    /* 기기 픽셀 비율 (2026-11-19 맥 레티나 결함): Selkies 디스플레이는
       스테이지 CSS px × DPR(디바이스 px) 크기다 — 맥은 1470×847 CSS에
       디스플레이 2940×1694. 그래서 오버라이드 크기는 CSS px 그대로 두고
       DSF를 이 DPR로 걸어야 레이아웃은 네이티브와 같고 래스터만
       디스플레이를 꽉 채운다 (DSF 1.0이면 페이지가 절반 크기로 보인다).
       마우스 오프셋도 같은 DPR로 디바이스 px로 바꿔 보낸다. window에
       없거나 비정상이면 1. 소수점 셋째 자리까지만 (비교 안정성). */
    function readDevicePixelRatio() {
      var view = doc.defaultView;
      var dpr = view && typeof view.devicePixelRatio === 'number' ? view.devicePixelRatio : 1;
      if (typeof dpr !== 'number' || !isFinite(dpr) || dpr < 1 || dpr > 4) return 1;
      return Math.round(dpr * 1000) / 1000;
    }

    // 뷰포트 측정: iframe은 시작 중 hidden(display:none)이라 자기
    // rect가 항상 0x0이다 — iframe이 꽉 채우는 .bw-stage(부모, 항상
    // 보임) 크기를 잰다 (2026-11-12: hidden iframe을 재서 뷰포트가
    // 서버에 한 번도 전달되지 않았고, 원격이 기본 1280x720으로 뜬
    // 채 최대화 창에서 1.5배 확대돼 보였다 — 사용자 실화면 지적).
    // 부모를 못 재면 iframe 자기 rect로 폴백한다. 크기는 CSS px,
    // dpr은 오버라이드 DSF로 쓴다 (위 readDevicePixelRatio 참조).
    function measureViewport() {
      var measureTargets = [];
      if (liveFrame && liveFrame.parentElement) measureTargets.push(liveFrame.parentElement);
      if (liveFrame) measureTargets.push(liveFrame);
      for (var mi = 0; mi < measureTargets.length; mi++) {
        var target = measureTargets[mi];
        if (typeof target.getBoundingClientRect !== 'function') continue;
        var r = target.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          return { width: r.width, height: r.height, dpr: readDevicePixelRatio() };
        }
      }
      return null;
    }

    function lockoutText(remaining) {
      var secs = typeof remaining === 'number' && remaining > 0 ? remaining : 0;
      var mins = Math.max(1, Math.ceil(secs / 60));
      return '암호를 여러 번 틀려 ' + mins + '분간 잠겼어요. 잠시 후에 다시 시도해주세요.';
    }

    /* 잠금 카드를 띄운다. mode 'unlock' | 'setup'. */
    function showLock(mode, statusBody) {
      lockMode = mode;
      if (lockTitle) {
        lockTitle.textContent =
          mode === 'setup' ? '보관함 암호를 정해주세요' : '브라우저가 잠겨 있어요';
      }
      if (lockDesc) {
        lockDesc.textContent =
          mode === 'setup'
            ? '프로필 보관함을 처음 암호화합니다. 이 암호가 열쇠예요 — 잊으면 프로필을 복구할 수 없으니 꼭 기억해두세요.'
            : '서버가 다시 시작돼 프로필 보관함이 잠겼어요. 암호를 입력하면 열립니다.';
      }
      if (lockConfirm) lockConfirm.hidden = mode !== 'setup';
      if (lockSubmit) lockSubmit.textContent = mode === 'setup' ? '설정하기' : '풀기';
      setLockMsg(
        statusBody && statusBody.locked_out ? lockoutText(statusBody.lockout_remaining) : '',
      );
      clearLockInputs();
      setLockBusy(false);
      liveState = 'locked';
      stopStatePolling();
      stopMouseOffsetPolling();
      onChange();
    }

    /* 제출 후 네트워크가 끊겼을 때: 서버 쪽에서 진행 중일 수 있으니
       상태를 폴링한다 (셋업의 rsync 마이그레이션은 오래 걸린다).
       최대 60회(약 5분)까지 보고, 풀리면 다시 시작한다. */
    function pollUnlocked(gen, tries) {
      if (gen !== liveGen || liveState !== 'locked') return;
      if (tries >= 60) {
        setLockBusy(false);
        setLockMsg('아직 열리지 않았어요. 잠시 후에 다시 시도해주세요.');
        return;
      }
      setTimeout(function () {
        if (gen !== liveGen || liveState !== 'locked') return;
        checkUnlock().then(function (res) {
          if (gen !== liveGen || liveState !== 'locked') return;
          var body = res && res.body;
          if (res && res.status === 200 && body && body.configured && body.unlocked) {
            setLockBusy(false);
            var url = pendingUrl;
            var tid = pendingTargetId;
            pendingUrl = null;
            pendingTargetId = null;
            enterLive(url, tid);
            return;
          }
          pollUnlocked(gen, tries + 1);
        });
      }, pollDelayMs);
    }

    function onLockSubmit(ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (lockBusy || liveState !== 'locked') return;
      var password = lockPassword ? lockPassword.value : '';
      if (!password || password.length < 8) {
        setLockMsg('암호는 8자 이상 입력해주세요.');
        return;
      }
      if (lockMode === 'setup') {
        var confirm = lockConfirm ? lockConfirm.value : '';
        if (password !== confirm) {
          setLockMsg('두 암호가 달라요. 다시 입력해주세요.');
          return;
        }
      }
      var gen = liveGen;
      setLockMsg('');
      setLockBusy(true, lockMode === 'setup' ? '설정 중…' : '푸는 중…');
      submitUnlock(lockMode, password).then(function (res) {
        if (gen !== liveGen) return;
        clearLockInputs();
        var body = res && res.body;
        if (res && res.status === 200 && body && body.ok) {
          // 풀렸다 — 다시 시작한다 (상태 조회가 언록됨을 확인하고
          // iframe을 킨다).
          setLockBusy(false);
          var url = pendingUrl;
          var tid = pendingTargetId;
          pendingUrl = null;
          pendingTargetId = null;
          enterLive(url, tid);
          return;
        }
        if (res && res.status === 423) {
          setLockBusy(false);
          setLockMsg(lockoutText(body && body.lockout_remaining));
          return;
        }
        if (res && res.status === 401) {
          setLockBusy(false);
          var attempts =
            body && typeof body.failed_attempts === 'number' ? body.failed_attempts : null;
          setLockMsg('암호가 맞지 않습니다.' + (attempts !== null ? ' (' + attempts + '/5)' : ''));
          return;
        }
        if (res && res.status === 0) {
          pollUnlocked(gen, 0);
          return;
        }
        setLockBusy(false);
        setLockMsg('풀지 못했어요. 잠시 후에 다시 시도해주세요.');
      });
    }

    /* 잠금 카드를 닫는다 (시작 화면으로 돌아간다) */
    function dismissLock() {
      if (liveState !== 'locked') return;
      liveGen += 1; // 진행 중인 폴링·제출 응답을 무효화한다
      liveState = 'off';
      pendingUrl = null;
      pendingTargetId = null;
      clearLockInputs();
      setLockBusy(false);
      onChange();
    }

    /* 시작 결과를 Promise<boolean>로 알려주는 등 원격 뷰가 실제로 켜졌다
       (url이 있으면 이동까지 성공했다) 때만 true. 주인(browser.js)의
       최근 방문 기록처럼 "성공한 이동"만 붙는 위젯인 등 값으로
       (가른다 실패한 주소를 방문 기록에 않기 위해서다). */
    function enterLive(url, targetId) {
      var alreadyOn = liveState === 'on';
      if (alreadyOn) {
        if (!url) return Promise.resolve(true);
        var viewport = measureViewport();
        var gen = liveGen;
        return navigate(url, viewport, targetId).then(function (res) {
          if (gen !== liveGen) return false;
          return handleNavigateResult(res, viewport, gen);
        });
      }
      pendingUrl = url || null;
      pendingTargetId = typeof targetId === 'string' && targetId ? targetId : null;
      var startGen = ++liveGen;
      // LUKS 잠금 확인 (2026-11-15): 볼륨이 잠겨 있으면 iframe을 켜지
      // 않고 암호 카드를 띄운다. 언록됨·미구성(503)·조회 실패는 기존
      // 흐름으로 진행한다 (fail-open: 서비스가 죽었는데 chromium이 떠
      // 있으면 브라우저는 쓸 수 있다).
      return checkUnlock().then(function (res) {
        if (startGen !== liveGen) return false;
        var body = res && res.body;
        if (res && res.status === 200 && body && typeof body.configured === 'boolean') {
          if (!body.configured) {
            showLock('setup', body);
            return false;
          }
          if (!body.unlocked) {
            showLock('unlock', body);
            return false;
          }
        }
        return startLive(url, startGen, pendingTargetId);
      });
    }

    /* 화질 설정에 맞는 뷰 URL: 수동 값이면 ?vb= 쿼리를 붙인다
       (옛 경로 — 사이드카는 WS URL에서 이 쿼리를 떼어 버리므로
       재적용은 applyStoredQuality의 POST가 맡는다. 쿼리는 해가
       없어 그대로 둔다). 자동이면 쿼리 없이 시작한다. */
    function viewUrlForQuality() {
      var pref = readQualityPreference();
      if (pref.mode === 'manual') return VIEW_URL + '?vb=' + pref.bitrate;
      return VIEW_URL;
    }

    /* 저장된 화질을 다시 적용한다 (2026-11-20 4단계): 시작 시 저장된
       수동 비트레이트를 POST한다. 화면 WS가 아직 안 붙었으면
       connections: 0이라 적용이 안 되므로 보류하고 다음 폴링 때 다시
       시도한다 (최대 10회). 저장값을 다시 쓰지는 않는다 — 이미 저장된
       값이다. */
    function applyStoredQuality() {
      if (qualityPending === null || qualityApplying) return;
      qualityApplying = true;
      var kbps = qualityPending;
      setQualityFetch({ bitrate: kbps }).then(
        function (res) {
          qualityApplying = false;
          var body = res && res.body;
          if (res && res.status === 200 && body && body.ok && (body.connections | 0) > 0) {
            qualityPending = null;
            return;
          }
          qualityAttempts += 1;
          if (qualityAttempts >= QUALITY_REAPPLY_MAX_ATTEMPTS) {
            qualityPending = null;
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[browser-live] 저장된 화질 재적용 실패 (10회 시도) — 메뉴에서 다시 선택해 주세요.');
            }
          }
        },
        function () {
          qualityApplying = false;
          qualityAttempts += 1;
          if (qualityAttempts >= QUALITY_REAPPLY_MAX_ATTEMPTS) {
            qualityPending = null;
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[browser-live] 저장된 화질 재적용 실패 (10회 시도) — 메뉴에서 다시 선택해 주세요.');
            }
          }
        },
      );
    }

    /* 화질 전환: mode 'auto' 또는 kbps 숫자. 성공하면 설정을 저장해
       다음 시작부터 적용하고 true를, 실패·무효 입력이면 false를
       돌려준다 (무효 입력은 요청을 보내지 않는다). */
    function setQuality(mode) {
      var payload = null;
      var pref = null;
      if (mode === 'auto') {
        payload = { mode: 'auto' };
        pref = { mode: 'auto' };
      } else if (typeof mode === 'number' && isFinite(mode)) {
        var kbps = Math.round(mode);
        if (kbps < QUALITY_MIN_KBPS || kbps > QUALITY_MAX_KBPS) return Promise.resolve(false);
        payload = { bitrate: kbps };
        pref = { mode: 'manual', bitrate: kbps };
      } else {
        return Promise.resolve(false);
      }
      return setQualityFetch(payload).then(function (res) {
        var body = res && res.body;
        if (res && res.status === 200 && body && body.ok) {
          writeQualityPreference(pref);
          return true;
        }
        return false;
      });
    }

    /* 핀치 줌 차단 핸들러: Ctrl+휠만 막는다. 캡처 단계라 Selkies
       클라이언트의 버블 리스너보다 먼저 돌고, stopPropagation으로
       클라이언트에 닿지 않게 한다. 일반 휠(ctrlKey 없음)은 손대지
       않는다. */
    function onFrameWheel(ev) {
      if (ev && ev.ctrlKey) {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
      }
    }

    /* iframe 로드마다 contentWindow에 핀치 가드를 건다. src가 바뀔
       때마다 contentWindow가 새 객체가 되므로 load 때마다 다시
       걸어야 한다. 동일 출처 접근이 실패하면 가드 없이 진행한다
       (화면은 그대로 뜬다 — 가드 실패가 브라우저를 막지 않는다). */
    function attachPinchGuard() {
      try {
        var win = liveFrame && liveFrame.contentWindow;
        if (!win || typeof win.addEventListener !== 'function') return;
        win.addEventListener('wheel', onFrameWheel, { passive: false, capture: true });
      } catch (e) {
        // 접근 불가 — 가드 없이 진행한다 (화면은 그대로 뜬다).
        // 실패 원인은 콘솔에 남긴다 (관문 23: 빈 catch 금지).
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[browser-live] 핀치 가드 부착 실패', e);
        }
      }
    }

    /* 라이브 프레임 Ctrl+←/→/↑ 중계 (2026-11-20, 사용자 보고:
       브라우저 최대화 시 미션컨트롤 전환이 안 먹힘). 셸 단축키
       (windows.js onKeydown)는 셸 문서에만 걸려 있고, 라이브
       프레임(Selkies 화면, 별도 문서)에 포커스가 있으면 키가 원격
       크롬으로만 간다. 핀치 가드와 같은 자리에서 캡처 단계로
       가로채 셸에 myhub:desktop-nav-key로 올려보낸다 (nav.js 중계와
       같은 메시지, 셸은 출처 프레임을 검증한다). 무조건 전달한다 —
       원격 화면은 영상 스트림이라 텍스트 필드 포커스 여부를 알 수
       없어 조건부 전달이 안 되고, 사용자가 macOS 시스템 단축키
       우선(단어 이동 손실 감수)을 선택했다.
       등록 순서 한계: Selkies 클라이언트의 캡처 리스너(모듈 실행
       시 등록)가 load 때 거는 이 리스너보다 먼저 돌므로, 이
       리스너는 원격이 키를 보는 것을 막지 못한다 — 셸 전환만
       보장한다. 사이드카 주입 스크립트(서버 재시작 후 적용)가
       <head>에서 먼저 등록돼 stopImmediatePropagation으로 끊으면
       그쪽이 우선하고 이 리스너는 돌지 않으므로 중복 전달이
       생기지 않는다. */
    function onFrameNavKey(ev) {
      if (!ev || !ev.ctrlKey) return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'ArrowUp') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
      try {
        window.parent.postMessage(
          { type: 'myhub:desktop-nav-key', key: ev.key },
          window.location.origin,
        );
      } catch (e) {
        // 중계 실패가 브라우저를 막지 않는다 — 원인을 콘솔에 남긴다
        // (관문 23: 빈 catch 금지).
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[browser-live] nav 키 중계 실패', e);
        }
      }
    }

    /* iframe 로드마다 contentWindow에 nav 키 중계를 건다 (핀치 가드와
       같은 이유 — src가 바뀔 때마다 contentWindow가 새 객체가 된다).
       동일 리스너 재등록은 브라우저가 중복 제거하므로 load가 다시
       와도 중계가 두 번 나가지 않는다. */
    function attachNavKeyRelay() {
      try {
        var win = liveFrame && liveFrame.contentWindow;
        if (!win || typeof win.addEventListener !== 'function') return;
        win.addEventListener('keydown', onFrameNavKey, { capture: true });
      } catch (e) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[browser-live] nav 키 중계 부착 실패', e);
        }
      }
    }

    /* iframe을 켜고 url이 있으면 이동한다. enterLive의 잠금 검사 통과 후.
       url이 없어도 뷰포트는 맞춘다 (2026-11-15: 세션 복원 뒤 navigate가
       없으면 override가 적용되지 않아 원격이 절반 크기로 보였다). */
    function startLive(url, gen, targetId) {
      var viewport = measureViewport();
      liveState = 'on';
      // 저장된 수동 화질이 있으면 폴링 성공 시 POST로 다시 적용한다
      // (?vb= 쿼리는 사이드카가 떼어 버려 재적용이 안 된다). 자동이면
      // 아무것도 보내지 않아 현행 기본값이 그대로 유지된다.
      var storedPref = readQualityPreference();
      qualityPending = storedPref.mode === 'manual' ? storedPref.bitrate : null;
      qualityAttempts = 0;
      if (liveFrame) liveFrame.src = viewUrlForQuality();
      onChange();
      startStageObserver();
      startStatePolling();
      startMouseOffsetPolling();
      if (!url) {
        // 뷰포트 적용 실패는 시작을 막지 않는다 (화면은 뜨고, 다음
        // 진입·리사이즈 때 다시 시도한다).
        if (viewport) applyViewportNow(viewport);
        return Promise.resolve(true);
      }
      return navigate(url, viewport, targetId).then(function (res) {
        if (gen !== liveGen) return false;
        return handleNavigateResult(res, viewport, gen);
      });
    }

    /* navigate 응답을 상태에 반영하고 성공 여부를 돌려준다. */
    function handleNavigateResult(res, viewport, gen) {
      var body = res && res.body;
      if (res && res.status === 200 && body && body.ok) {
        // navigate의 뷰포트는 임시 CDP 세션에 걸린 것이라 세션을 닫으면
        // 5초 안에 풀리고 사이드카 영구 세션의 낡은 값(다른 기기 크기)이
        // 다시 드러난다 — navigate 성공을 기록으로 삼으면 정합이 영원히
        // 안 돌아간다 (2026-11-21 맥 쏠림: 1918 override가 1470 창에
        // 남아 네이버가 216px 오른쪽으로 쏠렸다). 성공을 믿고 기록하지
        // 않고 /viewport POST(영구 세션)로 다시 적용한다 — POST가
        // 성공해야 lastApplied가 채워지고, 실패면 백오프 재시도가 돈다.
        if (viewport && viewport.width > 0 && viewport.height > 0) {
          applyViewportNow(viewport);
        }
        // 진단: 보낸 뷰포트와 서버의 CDP 이동 결과(nav/navStage)를
        // 남겨 원격 뷰포트 적용 여부를 콘솔에서 확인할 수 있게 한다.
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info(
            '[browser-live] navigate viewport=',
            viewport,
            'nav=',
            body.nav,
            body.navStage,
          );
        }
        return true;
      }
      if (res && res.status === 503) {
        // 시크릿 미설정 — 화면 프록시도 못 뜨므로 뷰를 끄고 안내한다.
        liveState = 'notice';
        stopStatePolling();
        stopMouseOffsetPolling();
        if (liveFrame) liveFrame.removeAttribute('src');
        setNotice('원격 브라우저가 아직 설정되지 않았어요.');
        onChange();
      }
      if (res && res.status === 423) {
        // 잠금 검사와 이동 사이에 서버가 재시작돼 잠긴 경우 — 카드를 띄운다.
        if (liveFrame) liveFrame.removeAttribute('src');
        showLock('unlock', null);
      }
      // 400·502 등 이동 실패는 뷰를 건드리지 않는다 (이미 켜진 화면은
      // 그대로 두고, 시작 직후면 Selkies 바탕 화면이 보인다). 방문
      // 기록에만 남기지 않기 위해 false를 돌려준다.
      return false;
    }

    function endLive() {
      liveGen += 1;
      liveState = 'off';
      stopStageObserver();
      stopStatePolling();
      stopMouseOffsetPolling();
      qualityPending = null;
      qualityApplying = false;
      if (transientNoticeTimer) {
        clearTimeout(transientNoticeTimer);
        transientNoticeTimer = null;
      }
      transientNotice = false;
      lastAppliedViewport = null;
      lastFailedViewport = null;
      viewportRetryCount = 0;
      lastReportedMouseOffset = null;
      if (liveFrame) liveFrame.removeAttribute('src');
      onChange();
      return Promise.resolve();
    }

    /* 안내 카드를 닫는다. 일시 안내면 플래그만 끄고 라이브는 그대로
       두고, 시작 실패 안내면 상태를 끈다. */
    function dismissNotice() {
      if (transientNotice) {
        hideTransientNotice();
        return;
      }
      if (liveState !== 'notice') return;
      liveState = 'off';
      onChange();
    }

    if (noticeClose) {
      noticeClose.addEventListener('click', function () {
        dismissNotice();
      });
    }
    if (lockForm) {
      // 폼 태그를 쓰지 않는다: CSP 인벤토리가 public 전체의 폼 태그
      // 부재를 단언하므로, 폼 없이 Enter 키로 제출한다.
      if (lockSubmit) {
        lockSubmit.addEventListener('click', onLockSubmit);
      }
      var lockInputs = [lockPassword, lockConfirm];
      for (var li = 0; li < lockInputs.length; li++) {
        (function (input) {
          if (!input) return;
          input.addEventListener('keydown', function (ev) {
            if (ev && ev.key === 'Enter') onLockSubmit(ev);
          });
        })(lockInputs[li]);
      }
    }
    if (lockClose) {
      lockClose.addEventListener('click', function () {
        dismissLock();
      });
    }
    if (liveFrame) {
      liveFrame.addEventListener('load', attachPinchGuard);
      liveFrame.addEventListener('load', attachNavKeyRelay);
    }

    return {
      state: function () {
        return liveState;
      },
      isActive: function () {
        return liveState === 'on';
      },
      enterLive: enterLive,
      endLive: endLive,
      dismissNotice: dismissNotice,
      dismissLock: dismissLock,
      setQuality: setQuality,
      getQuality: getQuality,
      showNotice: showNotice,
      syncChrome: syncChrome,
      goBack: function () {
        return goHistory('back');
      },
      goForward: function () {
        return goHistory('forward');
      },
      reload: reload,
      refreshState: pollStateOnce,
    };
  }

  var api = { createLive: createLive };
  if (typeof window !== 'undefined') window.MyHubBrowserLive = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubBrowserLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
