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
 * iframe을 다시 띄우지 않고 이동만 지시한다.
 * 상태: 'off' | 'on' | 'notice'
 * (notice = 503 등 시작 실패 안내 카드를 띄운 상태).
 * 자기 소유 요소(#bwLiveFrame/#bwNoticeCard)를 표시와
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

  /**
   * deps = { doc, navigate, onChange }
   * doc에서 #bwLiveFrame/#bwNoticeCard/#bwNoticeMsg/#bwNoticeClose를
   * 찾는다 (없으면 해당 요소만 비활성). navigate(url, viewport)는
   * Promise<{status, body}> 테스트 주입 지난. onChange()는 상태 변경 등
   * 주인의 너비를 다시 그리며 알림 콜백.
   */
  function createLive(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var navigate =
      typeof deps.navigate === 'function' ? deps.navigate : defaultNavigate;
    var onChange =
      typeof deps.onChange === 'function'
        ? deps.onChange
        : function () {
            return undefined;
          };
    var liveFrame = doc.getElementById('bwLiveFrame');
    var noticeCard = doc.getElementById('bwNoticeCard');
    var noticeMsg = doc.getElementById('bwNoticeMsg');
    var noticeClose = doc.getElementById('bwNoticeClose');
    /* 원격 상태: 'off' | 'on' | 'notice' */
    var liveState = 'off';
    var liveGen = 0; // 이동 응답이 늦게 도착해 종료 후에 상태를 건드리지 않기 위한 지난 번호

    function setNotice(text) {
      if (noticeMsg) noticeMsg.textContent = text;
    }

    /* 자기 소유 요소만 갱신한다 등 나머지 너비 주인과 syncChrome 모양 */
    function syncChrome() {
      var liveOn = liveState === 'on';
      if (liveFrame) liveFrame.hidden = !liveOn;
      if (noticeCard) noticeCard.hidden = liveState !== 'notice';
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

    /* 시작 결과를 Promise<boolean>로 알려주는 등 원격 뷰가 실제로 켜졌다
       (url이 있으면 이동까지 성공했다) 때만 true. 주인(browser.js)의
       최근 방문 기록처럼 "성공한 이동"만 붙는 위젯인 등 값으로
       (가른다 실패한 주소를 방문 기록에 않기 위해서다). */
    function enterLive(url) {
      var alreadyOn = liveState === 'on';
      var gen = ++liveGen;
      var viewport = measureViewport();
      if (!alreadyOn) {
        liveState = 'on';
        if (liveFrame) liveFrame.src = VIEW_URL;
        onChange();
      }
      if (!url) return Promise.resolve(true);
      return navigate(url, viewport).then(function (res) {
        if (gen !== liveGen) return false;
        var body = res && res.body;
        if (res && res.status === 200 && body && body.ok) {
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
          if (liveFrame) liveFrame.removeAttribute('src');
          setNotice('원격 브라우저가 아직 설정되지 않았어요.');
          onChange();
        }
        // 400·502 등 이동 실패는 뷰를 건드리지 않는다 (이미 켜진 화면은
        // 그대로 두고, 시작 직후면 Selkies 바탕 화면이 보인다). 방문
        // 기록에만 남기지 않기 위해 false를 돌려준다.
        return false;
      });
    }

    function endLive() {
      liveGen += 1;
      liveState = 'off';
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
      syncChrome: syncChrome,
    };
  }

  var api = { createLive: createLive };
  if (typeof window !== 'undefined') window.MyHubBrowserLive = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubBrowserLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
