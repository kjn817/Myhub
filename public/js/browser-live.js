/* MyHub 브라우저 등 원격 세션 상태 기계 (browser-live.js)
 *
 * 브라우저 탭의 실제 원격 브라우저(Browser Run Live View) 하나만 통합한다
 * (프록시 2026-11-04 리더). browser.js폐지가 createApp정본의
 * window.MyHubBrowserLive.createLive로 만들면 붙이면, browser.html의
 * 등 파일이 browser.js보다 먼저 불러오는 것이 전제다 (컴퓨터 없으면
 * createApp가 실패한다 등 조용히 죽인 채 방치하지 않게).
 * enterLive(url?)는 POST /api/browse/live-session로 세션(1개 2분
 * 동시 1개)를 받아 서명 URL를 #bwLiveFrame에 걸고, 서버가 세션을 등
 * 직후 url로 먼저 이동시킨다. 종료 페이지 종료 DELETE등로 세션을
 * 반환한다(best-effort). 서명 URL는 저장하지 않는다.
 * 상태: 'off' | 'starting' | 'on' | 'notice'
 * (notice = 503/409 등 시작 실패 안내 카드를 띄운 상태).
 * 자기 소유 요소(#bwLiveFrame/#bwPill/#bwNoticeCard/#bwStarting)를 표시와
 * syncChrome()로 맞추고, 상태 변경 직후에는 deps.onChange()로 주인에게
 * 알려 전체 너비를 다시 그리게 한다.
 * 노출: window.MyHubBrowserLive = { createLive }
 */
(function () {
  'use strict';

  /* 원격 세션 시작: Promise<{ status, body }> 테 스트 주입 지난과 같은 모양 */
  function defaultLiveStart(url, viewport) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, body: null });
    var init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    var payload = {};
    if (url) payload.url = url;
    // iframe 크기를 보내 원격 뷰포트를 맞춘다 (2026-11-12: 기본
    // 1280x720이 창보다 넓으면 Live View가 짤린다).
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      payload.viewport = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
    }
    if (Object.keys(payload).length) init.body = JSON.stringify(payload);
    return fetch('/api/browse/live-session', init)
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

  /* 원 격 세션 (best-effort 종료 시작 UI페이 지로 복귀 한다) */
  function defaultLiveStop() {
    if (typeof fetch !== 'function') return Promise.resolve();
    return fetch('/api/browse/live-session', { method: 'DELETE', keepalive: true })
      .then(function () {
        return undefined;
      })
      .catch(function () {
        return undefined;
      });
  }

  /**
   * deps = { doc, liveStart, liveStop, onChange }
   * doc에서 #bwLiveFrame/#bwPill/#bwLiveMsg/#bwLiveTime/#bwLiveEnd/
   * #bwNoticeCard/#bwNoticeMsg/#bwNoticeClose/#bwStarting를 찾는다
   * (없으면 해당 요소만 비활성). liveStart(url?)는 Promise<{status, body}>,
   * liveStop()는 Promise 등 테스트 주입 지난. onChange()는 상태 변경 등
   * 주인의 너비를 다시 그리며 알림 콜백.
   */
  function createLive(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var liveStart = typeof deps.liveStart === 'function' ? deps.liveStart : defaultLiveStart;
    var liveStop = typeof deps.liveStop === 'function' ? deps.liveStop : defaultLiveStop;
    var onChange =
      typeof deps.onChange === 'function'
        ? deps.onChange
        : function () {
            return undefined;
          };
    var liveFrame = doc.getElementById('bwLiveFrame');
    var pill = doc.getElementById('bwPill');
    var liveMsg = doc.getElementById('bwLiveMsg');
    var liveTime = doc.getElementById('bwLiveTime');
    var liveEndBtn = doc.getElementById('bwLiveEnd');
    var noticeCard = doc.getElementById('bwNoticeCard');
    var noticeMsg = doc.getElementById('bwNoticeMsg');
    var noticeClose = doc.getElementById('bwNoticeClose');
    var startingCard = doc.getElementById('bwStarting');
    /* 원격 상태: 'off' | 'starting' | 'on' | 'notice' */
    var liveState = 'off';
    var liveExpiresAt = 0;
    var liveTimer = null;
    var liveGen = 0; // 시작 응답이 늦게 도착해 종료 후에 세션이 붙인지 않기 위한 지난 번호

    function setLiveTime(text) {
      if (liveTime) liveTime.textContent = text;
    }

    function setNotice(text) {
      if (noticeMsg) noticeMsg.textContent = text;
    }

    /* 자기 소유 요소만 갱신한다 등 나머지 너비 주인과 syncChrome 모양 */
    function syncChrome() {
      var liveOn = liveState === 'on';
      if (liveFrame) liveFrame.hidden = !liveOn;
      if (pill) pill.hidden = !liveOn;
      if (noticeCard) noticeCard.hidden = liveState !== 'notice';
      // 시작 중에는 로딩표시 배너가 모두화면 단계가 공백으로 남아
      // 연결 중 표시를 띄운다 (세션 생성이 등 첫 걸리는 등 있다)
      if (startingCard) startingCard.hidden = liveState !== 'starting';
    }

    function tickLive() {
      var remainMs = liveExpiresAt - Date.now();
      if (remainMs <= 0) {
        // 세션을 서버 쪽에서 내부 복사한 등 UI만 시작 페이지로 되돌린다
        endLive(false);
        return;
      }
      var sec = Math.ceil(remainMs / 1000);
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      setLiveTime('연결 시간 ' + m + ':' + (s < 10 ? '0' : '') + s);
    }

    function startLiveTimer() {
      if (liveTimer !== null) clearInterval(liveTimer);
      tickLive();
      liveTimer = setInterval(tickLive, 1000);
    }

    /* 시작 결과를 Promise<boolean>로 알려주는 등 세션을 실제로 켜졌다
       때만 true. 주인(browser.js)의 최근 방문 기록처럼 "성공한 이동"만
       붙는 위 젯인 등 값으로 (가른다 실패한 주소를 방문 기록에
       않기 위해서다). 내부 켜짐/시작 중이면 false. */
    function enterLive(url) {
      if (liveState === 'on' || liveState === 'starting') return Promise.resolve(false);
      liveState = 'starting';
      var gen = ++liveGen;
      onChange();
      // iframe 크기를 재서 원격 뷰포트를 맞춘다 (기본 1280x720이
      // 창보다 넓으면 Live View가 짤린다 — 2026-11-12 사용자 지적).
      var viewport = null;
      if (liveFrame && typeof liveFrame.getBoundingClientRect === 'function') {
        var r = liveFrame.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) viewport = { width: r.width, height: r.height };
      }
      return liveStart(url || null, viewport).then(function (res) {
        if (gen !== liveGen) {
          // 시작 응답이 늦은 후에 내부 종료하면 등 반환 메모 세션을 반환한다
          if (res && res.status === 200 && res.body && res.body.ok) liveStop();
          return false;
        }
        var body = res && res.body;
        var started = false;
        if (res && res.status === 200 && body && body.ok && body.viewUrl) {
          liveState = 'on';
          liveExpiresAt =
            typeof body.expiresAt === 'number' ? body.expiresAt : Date.now() + 120000;
          if (liveFrame) liveFrame.src = body.viewUrl;
          if (liveMsg) liveMsg.textContent = '원격 브라우저';
          startLiveTimer();
          started = true;
        } else if (res && res.status === 503) {
          liveState = 'notice';
          setNotice('원격 브라우저가 아직 설정되지 않았어요.');
        } else if (res && res.status === 429) {
          liveState = 'notice';
          setNotice('오늘은 무료 원격 시간(남은 10분)이 모두 떨어졌어요. 내일 오전 9시에 다시 열려요. 급하면 데스크톱에서 열어 볼 수 있어요.');
        } else if (res && res.status === 409) {
          liveState = 'notice';
          setNotice(
            '대기 사용 중이에요.' +
              (body && typeof body.retryAfterSec === 'number'
                ? ' ' + body.retryAfterSec + '초 후에 다시 시도해 볼수 있어요.'
                : ''),
          );
        } else if (res && res.status === 400) {
          liveState = 'notice';
          setNotice('주소가 올바르지 않아요.');
        } else {
          liveState = 'notice';
          setNotice('원격 브라우저를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.');
        }
        onChange();
        return started;
      });
    }

    /* callStop=true면 서버 세션을 반환한다. 반환 Promise를 알려줘서
       "종료 직후 등 세션 시작"(주소 이동)의 409거 리지 않게 한다. */
    function endLive(callStop) {
      var had = liveState === 'on' || liveState === 'starting';
      liveGen += 1;
      if (liveTimer !== null) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
      liveState = 'off';
      liveExpiresAt = 0;
      if (liveFrame) liveFrame.removeAttribute('src');
      setLiveTime('');
      onChange();
      if (callStop && had) return liveStop();
      return Promise.resolve();
    }

    /* 안내 카드를 닫는다 (세션이 유지된 내부 등 상태) */
    function dismissNotice() {
      if (liveState !== 'notice') return;
      liveState = 'off';
      onChange();
    }

    if (liveEndBtn) {
      liveEndBtn.addEventListener('click', function () {
        endLive(true);
      });
    }
    if (noticeClose) {
      noticeClose.addEventListener('click', function () {
        dismissNotice();
      });
    }
    // 등 종료(페이지가 사라진 등)자동 세션을 반환한다 (best-effort)
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', function () {
        if (liveState === 'on' || liveState === 'starting') liveStop();
      });
    }

    return {
      state: function () {
        return liveState;
      },
      isActive: function () {
        return liveState === 'on' || liveState === 'starting';
      },
      enterLive: enterLive,
      endLive: endLive,
      dismissNotice: dismissNotice,
      syncChrome: syncChrome,
    };
  }

  var api = { createLive: createLive };
  if (typeof window !== 'undefined') window.MyHubBrowserLive = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubBrowserLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
