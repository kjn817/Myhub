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
     수동 값이면 iframe 시작 시 ?vb=<kbps>로 초기 비트레이트를 정하고,
     자동이면 사이드카 적응 제어가 알아서 조절한다 (2026-11-15). */
  var QUALITY_KEY = 'myhub-bw-quality';
  var QUALITY_MIN_KBPS = 500;
  var QUALITY_MAX_KBPS = 8000;

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
  function defaultNavigate(url, viewport) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    var init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    var payload = { url: url };
    // stage 크기를 보내 원격 뷰포트를 맞춘다 (2026-11-12: 기본
    // 1280x720이 창보다 넓으면 원격 화면이 짤린다).
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      payload.viewport = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
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
          viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
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
   * deps = { doc, navigate, applyViewport, onChange, checkUnlock, submitUnlock, setQuality, pollDelayMs, fetchState, history, onState, statePollMs }
   * doc에서 #bwLiveFrame/#bwNoticeCard/#bwNoticeMsg/#bwNoticeClose와
   * #bwLockCard/#bwLockForm/#bwLockPassword/#bwLockConfirm/#bwLockMsg/
   * #bwLockSubmit/#bwLockClose/#bwLockTitle/#bwLockDesc를 찾는다 (없으면
   * 해당 요소만 비활성). navigate(url, viewport)는 Promise<{status, body}>
   * 테스트 주입 지난. applyViewport(viewport)는 이동 없는 뷰포트 적용
   * (2026-11-15, 같은 모양의 테스트 주입 지난). checkUnlock()·
   * submitUnlock(mode, password)·setQuality(payload)도 같은 모양의
   * 테스트 주입 지난. pollDelayMs는 제출 후 상태 폴링 간격(기본 5초).
   * fetchState()·history(direction)도 같은 모양의 테스트 주입 지난
   * (2026-11-15 원격 상태 폴링·뒤로/앞으로). onState(body)는 폴링이
   * 받은 원격 상태를 주인에게 알리는 콜백, statePollMs는 폴링 간격
   * (기본 2000ms). onChange()는 상태 변경 등 주인의 너비를 다시
   * 그리며 알림 콜백. 뷰포트 주기 재적용(2026-11-16 QA 2차, 10초)은
   * 2026-11-17 P1에 폐지했다 — 사이드카 영구 CDP 세션이 새 탭에도
   * 현재 뷰포트를 즉시 적용하므로 클라이언트 재적용이 불필요하다
   * (사이드카 Target.setDiscoverTargets). 뷰포트는 진입·navigate·
   * 리사이즈 때만 맞춘다.
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
    var pollDelayMs = typeof deps.pollDelayMs === 'number' ? deps.pollDelayMs : 5000;
    var statePollMs = typeof deps.statePollMs === 'number' ? deps.statePollMs : 2000;
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
    var lockBusy = false; // 제출 진행 중 (중복 제출 방지)
    /* 뷰포트 적용 상태 (2026-11-15): 마지막으로 적용된 크기·리사이즈
       디바운스 타이머·단발 재시도 타이머·stage 관찰자. */
    var lastAppliedViewport = null;
    var viewportTimer = null;
    var viewportRetryTimer = null;
    var viewportRetryUsed = false;
    var lastFailedViewport = null;
    var stageObserver = null;
    /* 원격 상태 폴링 상태 (2026-11-15): 주기 타이머·진행 중 플래그·
       진행 중 폴링의 Promise (2026-11-17 N2: 뒤로/앞으로 이동이 상태
       재조회 완료를 기다려 로딩 표시를 끌 수 있게 한다). */
    var statePollTimer = null;
    var statePolling = false;
    var statePollPromise = null;
    function sameViewport(a, b) {
      if (!a || !b) return false;
      return Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
    }

    /* 뷰포트를 서버에 적용하고 성공하면 기록한다. 실패하면 기록하지
       않고 2초 뒤 한 번만 다시 시도한다 (서버 일시 장애 대비 — 같은
       크기에 대한 재시도는 한 번으로 끝내고, 새 크기가 오면 다시
       한 번의 재시도를 얻는다). 같은 크기는 다시 보내지 않는다
       (2026-11-17 P1: 10초 주기 재적용 폐지 — 새 탭 적용은 사이드카
       영구 CDP가 맡으므로 클라이언트가 같은 크기를 되풀이할 이유가
       없다). 늦게 도착한 응답은 liveGen으로 버린다 — endLive 뒤에
       lastAppliedViewport를 채우면 다음 시작 때 같은 크기의 적용을
       건너뛰어 버린다. */
    function applyViewportNow(viewport) {
      if (!viewport || viewport.width <= 0 || viewport.height <= 0) return Promise.resolve(false);
      if (sameViewport(viewport, lastAppliedViewport)) return Promise.resolve(true);
      if (!sameViewport(viewport, lastFailedViewport)) viewportRetryUsed = false;
      var gen = liveGen;
      return applyViewport(viewport).then(function (res) {
        if (gen !== liveGen || liveState !== 'on') return false;
        if (res && res.status === 200 && res.body && res.body.ok) {
          lastAppliedViewport = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
          lastFailedViewport = null;
          viewportRetryUsed = false;
          return true;
        }
        lastFailedViewport = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
        if (!viewportRetryUsed && viewportRetryTimer === null && liveState === 'on') {
          viewportRetryUsed = true;
          viewportRetryTimer = setTimeout(function () {
            viewportRetryTimer = null;
            if (liveState !== 'on') return;
            var current = measureViewport();
            if (current && !sameViewport(current, lastAppliedViewport)) applyViewportNow(current);
          }, 2000);
        }
        return false;
      });
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
    function pollStateOnce() {
      if (liveState !== 'on') return Promise.resolve(false);
      if (doc.hidden) return Promise.resolve(false);
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
            onState(body);
            return true;
          }
          return false;
        },
        function () {
          statePolling = false;
          statePollPromise = null;
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

    function setNotice(text) {
      if (noticeMsg) noticeMsg.textContent = text;
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
      if (noticeCard) noticeCard.hidden = liveState !== 'notice';
      if (lockCard) lockCard.hidden = liveState !== 'locked';
    }

    // 뷰포트 측정: iframe은 시작 중 hidden(display:none)이라 자기
    // rect가 항상 0x0이다 — iframe이 꽉 채우는 .bw-stage(부모, 항상
    // 보임) 크기를 잰다 (2026-11-12: hidden iframe을 재서 뷰포트가
    // 서버에 한 번도 전달되지 않았고, 원격이 기본 1280x720으로 뜬
    // 채 최대화 창에서 1.5배 확대돼 보였다 — 사용자 실화면 지적).
    // 부모를 못 재면 iframe 자기 rect로 폴백한다.
    function measureViewport() {
      var measureTargets = [];
      if (liveFrame && liveFrame.parentElement) measureTargets.push(liveFrame.parentElement);
      if (liveFrame) measureTargets.push(liveFrame);
      for (var mi = 0; mi < measureTargets.length; mi++) {
        var target = measureTargets[mi];
        if (typeof target.getBoundingClientRect !== 'function') continue;
        var r = target.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          return { width: r.width, height: r.height };
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
            pendingUrl = null;
            enterLive(url);
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
          pendingUrl = null;
          enterLive(url);
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
      clearLockInputs();
      setLockBusy(false);
      onChange();
    }

    /* 시작 결과를 Promise<boolean>로 알려주는 등 원격 뷰가 실제로 켜졌다
       (url이 있으면 이동까지 성공했다) 때만 true. 주인(browser.js)의
       최근 방문 기록처럼 "성공한 이동"만 붙는 위젯인 등 값으로
       (가른다 실패한 주소를 방문 기록에 않기 위해서다). */
    function enterLive(url) {
      var alreadyOn = liveState === 'on';
      if (alreadyOn) {
        if (!url) return Promise.resolve(true);
        var viewport = measureViewport();
        var gen = liveGen;
        return navigate(url, viewport).then(function (res) {
          if (gen !== liveGen) return false;
          return handleNavigateResult(res, viewport, gen);
        });
      }
      pendingUrl = url || null;
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
        return startLive(url, startGen);
      });
    }

    /* 화질 설정에 맞는 뷰 URL: 수동 값이면 초기 비트레이트를 쿼리로
       실어 사이드카가 연결 직후 주입하게 하고, 자동이면 쿼리 없이
       사이드카 적응 제어에 맡긴다. */
    function viewUrlForQuality() {
      var pref = readQualityPreference();
      if (pref.mode === 'manual') return VIEW_URL + '?vb=' + pref.bitrate;
      return VIEW_URL;
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

    /* 호버 오프셋 진단용 오버레이 (2026-11-18, 임시 — 원인 확정 후 제거).
       iframe 안의 실제 마우스 위치와 Selkies 클라이언트가 보는 기하를
       스테이지 모서리에 표시한다. 동일 출처라 contentWindow/Document를
       읽을 수 있다. 부착·갱신 실패는 브라우저 동작을 막지 않는다. */
    var mouseDbgOverlay = null;
    var mouseDbgPos = null;
    var mouseDbgTimer = null;
    var mouseDbgWin = null;

    function mouseDbgOnMove(ev) {
      if (ev) mouseDbgPos = { x: Math.round(ev.clientX), y: Math.round(ev.clientY) };
    }

    /* contentWindow가 바뀌면(페이지 이동·재연결) 리스너가 죽은 창에
       남는다 — refresh 때마다 창이 바뀌었는지 보고 다시 건다. */
    function mouseDbgEnsureListener(win) {
      if (!win || typeof win.addEventListener !== 'function') return;
      if (mouseDbgWin === win) return;
      try {
        win.addEventListener('mousemove', mouseDbgOnMove, { passive: true, capture: true });
        mouseDbgWin = win;
      } catch (e) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[browser-live] 마우스 디버그 리스너 재부착 실패', e);
        }
      }
    }

    function mouseDbgRect(el) {
      if (!el || typeof el.getBoundingClientRect !== 'function') return null;
      try {
        var r = el.getBoundingClientRect();
        return {
          l: Math.round(r.left),
          t: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          ow: el.offsetWidth || 0,
          oh: el.offsetHeight || 0,
        };
      } catch (e) {
        return null;
      }
    }

    function mouseDbgFmtRect(name, r, extra) {
      if (!r) return name + ': -';
      return (
        name +
        ': ' +
        r.l +
        ',' +
        r.t +
        ' ' +
        r.w +
        'x' +
        r.h +
        ' ow:' +
        r.ow +
        'x' +
        r.oh +
        (extra || '')
      );
    }

    /* _windowMath를 그대로 재계산한다 (selkies-core.js의 this.m과 같은 식). */
    function mouseDbgWindowMath(r) {
      if (!r || r.w <= 0 || r.h <= 0 || r.ow <= 0 || r.oh <= 0) return null;
      var a = r.w / r.ow,
        o = r.h / r.oh,
        s = Math.min(a, o);
      var c = r.ow * s,
        l = r.oh * s;
      return {
        mx: c > 0 ? r.ow / c : 1,
        my: l > 0 ? r.oh / l : 1,
        ox: (r.w - c) / 2,
        oy: (r.h - l) / 2,
        ex: r.l,
        ey: r.t,
      };
    }

    function mouseDbgRefresh() {
      if (!mouseDbgOverlay) return;
      var win = liveFrame && liveFrame.contentWindow;
      if (!win) {
        mouseDbgOverlay.textContent = 'mouse-dbg: no frame';
        return;
      }
      try {
        var d = win.document;
        mouseDbgEnsureListener(win);
        var lines = [];
        lines.push('mouse: ' + (mouseDbgPos ? mouseDbgPos.x + ',' + mouseDbgPos.y : '-'));
        lines.push(
          'dpr:' +
            (win.devicePixelRatio || 1) +
            ' srd:' +
            !!win.streamResolutionDiverged +
            ' man:' +
            !!win.manualResolution +
            '/' +
            !!win.manual_resolution +
            ' win:' +
            (win.innerWidth || 0) +
            'x' +
            (win.innerHeight || 0),
        );
        var stream = d.getElementById('stream');
        var sr = mouseDbgRect(stream);
        var sextra =
          stream && stream.videoWidth ? ' vw:' + stream.videoWidth + 'x' + stream.videoHeight : '';
        lines.push(mouseDbgFmtRect('stream', sr, sextra));
        var canvas =
          d.getElementById('videoCanvas') ||
          d.getElementById('videoStream') ||
          d.getElementById('videoWorkerCanvas');
        var cr = mouseDbgRect(canvas);
        var cextra = canvas ? ' w:' + (canvas.width || 0) + 'x' + (canvas.height || 0) : '';
        lines.push(mouseDbgFmtRect('canvas', cr, cextra));
        var app = d.getElementById('app');
        lines.push(mouseDbgFmtRect('app', mouseDbgRect(app), ''));
        var root = d.getElementById('root');
        var rr = mouseDbgRect(root);
        lines.push(mouseDbgFmtRect('root', rr, ''));
        /* 모든 video/canvas 원소 (id 무관) — 실제 화면을 그리는 원소 찾기. */
        var media = d.querySelectorAll('video,canvas');
        for (var mi = 0; mi < media.length && mi < 6; mi++) {
          var mel = media[mi];
          var mr = mouseDbgRect(mel);
          var mextra = '';
          if (mel.tagName === 'VIDEO' && mel.videoWidth) {
            mextra = ' vw:' + mel.videoWidth + 'x' + mel.videoHeight;
          } else if (mel.tagName === 'CANVAS') {
            mextra = ' w:' + (mel.width || 0) + 'x' + (mel.height || 0);
          }
          lines.push(
            mouseDbgFmtRect(
              (mel.tagName === 'VIDEO' ? 'vid' : 'cv') + '#' + (mel.id || '(noid)'),
              mr,
              mextra,
            ),
          );
        }
        /* rect와 offset이 안 맞는 원소 (transform·스케일) — this.element의
           _windowMath를 틀어지게 하는 후보. 최대 4개만 표시한다. */
        var all = d.querySelectorAll('*');
        var shown = 0;
        for (var ai = 0; ai < all.length && shown < 4; ai++) {
          var ael = all[ai];
          if (!ael.offsetWidth || !ael.offsetHeight) continue;
          var ar2 = mouseDbgRect(ael);
          if (!ar2) continue;
          var dw = Math.abs(ar2.w - ar2.ow);
          var dh = Math.abs(ar2.h - ar2.oh);
          if (dw < 2 && dh < 2) continue;
          lines.push(
            mouseDbgFmtRect(
              'X:' + ael.tagName.toLowerCase() + '#' + (ael.id || '(noid)'),
              ar2,
              '',
            ),
          );
          shown++;
        }
        if (mouseDbgPos && sr) {
          /* 싱크 경로 계산 (_sinkBox와 같은 식: VIDEO+contain이면
             letterbox를 보정한 콘텐츠 박스 기준). */
          var sinkW = (stream && stream.videoWidth) || sr.w;
          var sinkH = (stream && stream.videoHeight) || sr.h;
          var bl = sr.l,
            bt = sr.t,
            bw = sr.w,
            bh = sr.h;
          if (stream && stream.tagName === 'VIDEO' && sinkW > 0 && sinkH > 0) {
            var fit = (stream.style && stream.style.objectFit) || 'contain';
            if (fit !== 'fill') {
              var sc = Math.min(sr.w / sinkW, sr.h / sinkH);
              bw = Math.round(sinkW * sc);
              bh = Math.round(sinkH * sc);
              bl = sr.l + Math.round((sr.w - bw) / 2);
              bt = sr.t + Math.round((sr.h - bh) / 2);
            }
          }
          var sx = bw > 0 ? Math.round(((mouseDbgPos.x - bl) * sinkW) / bw) : 0;
          var sy = bh > 0 ? Math.round(((mouseDbgPos.y - bt) * sinkH) / bh) : 0;
          lines.push('sink-> ' + sx + ',' + sy);
        }
        if (mouseDbgPos) {
          /* windowMath 경로: app·root를 각각 this.element로 가정한 재계산. */
          var dpr = win.devicePixelRatio || 1;
          var cands = [
            ['app', mouseDbgRect(app)],
            ['root', rr],
          ];
          for (var ci = 0; ci < cands.length; ci++) {
            var m = mouseDbgWindowMath(cands[ci][1]);
            if (!m) continue;
            var wx = Math.round((mouseDbgPos.x - m.ex - m.ox) * m.mx * dpr);
            var wy = Math.round((mouseDbgPos.y - m.ey - m.oy) * m.my * dpr);
            lines.push(
              'wmath[' +
                cands[ci][0] +
                ']-> ' +
                wx +
                ',' +
                wy +
                ' multi:' +
                m.mx.toFixed(3) +
                '/' +
                m.my.toFixed(3) +
                ' off:' +
                Math.round(m.ox) +
                '/' +
                Math.round(m.oy) +
                ' e:' +
                m.ex +
                '/' +
                m.ey,
            );
          }
        }
        mouseDbgOverlay.textContent = lines.join('\n');
      } catch (e) {
        mouseDbgOverlay.textContent = 'mouse-dbg: blocked';
      }
    }

    function attachMouseDebug() {
      try {
        var win = liveFrame && liveFrame.contentWindow;
        if (!win || typeof win.addEventListener !== 'function') return;
        if (!mouseDbgOverlay && liveFrame && liveFrame.parentElement) {
          var el = doc.createElement('div');
          el.style.cssText =
            'position:absolute;left:8px;top:8px;z-index:50;' +
            'pointer-events:none;background:rgba(0,0,0,0.72);color:#7ef0a8;' +
            'font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre;' +
            'padding:6px 8px;border-radius:8px;max-width:560px;';
          el.textContent = 'mouse-dbg: ...';
          liveFrame.parentElement.appendChild(el);
          mouseDbgOverlay = el;
        }
        mouseDbgEnsureListener(win);
        if (!mouseDbgTimer) mouseDbgTimer = setInterval(mouseDbgRefresh, 250);
        mouseDbgRefresh();
      } catch (e) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[browser-live] 마우스 디버그 부착 실패', e);
        }
      }
    }

    /* iframe을 켜고 url이 있으면 이동한다. enterLive의 잠금 검사 통과 후.
       url이 없어도 뷰포트는 맞춘다 (2026-11-15: 세션 복원 뒤 navigate가
       없으면 override가 적용되지 않아 원격이 절반 크기로 보였다). */
    function startLive(url, gen) {
      var viewport = measureViewport();
      liveState = 'on';
      if (liveFrame) liveFrame.src = viewUrlForQuality();
      onChange();
      startStageObserver();
      startStatePolling();
      if (!url) {
        // 뷰포트 적용 실패는 시작을 막지 않는다 (화면은 뜨고, 다음
        // 진입·리사이즈 때 다시 시도한다).
        if (viewport) applyViewportNow(viewport);
        return Promise.resolve(true);
      }
      return navigate(url, viewport).then(function (res) {
        if (gen !== liveGen) return false;
        return handleNavigateResult(res, viewport, gen);
      });
    }

    /* navigate 응답을 상태에 반영하고 성공 여부를 돌려준다. */
    function handleNavigateResult(res, viewport, gen) {
      var body = res && res.body;
      if (res && res.status === 200 && body && body.ok) {
        // navigate도 뷰포트를 적용했으므로 기록해 둔다 (리사이즈 관찰자가
        // 같은 크기를 다시 보내지 않게 한다).
        if (viewport && viewport.width > 0 && viewport.height > 0) {
          lastAppliedViewport = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
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
      lastAppliedViewport = null;
      lastFailedViewport = null;
      viewportRetryUsed = false;
      if (liveFrame) liveFrame.removeAttribute('src');
      onChange();
      return Promise.resolve();
    }

    /* 안내 카드를 닫는다 */
    function dismissNotice() {
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
      liveFrame.addEventListener('load', attachMouseDebug);
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
      syncChrome: syncChrome,
      goBack: function () {
        return goHistory('back');
      },
      goForward: function () {
        return goHistory('forward');
      },
      refreshState: pollStateOnce,
    };
  }

  var api = { createLive: createLive };
  if (typeof window !== 'undefined') window.MyHubBrowserLive = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubBrowserLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
