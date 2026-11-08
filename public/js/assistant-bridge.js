/* MyHub 비서 브리지 — 앱 페이지(iframe) 측 공용 연결 (D-18).
 *
 * 재구성 근거: 서브챗 패널이 셸 싱글턴이 되면서 앱 측은 이 브리지가 담당한다.
 * - 임베드 표식: html.myhub-embedded (nav.js 자체 판정과 이중 보장)
 * - 선언-로드 경합 해결: 로드 시 'myhub:bridge-ready'를 알리고,
 *   셸의 'myhub:bridge-hello'에는 현재 컨텍스트를 재선언으로 답한다.
 * - 내비 키 채널: Ctrl+←/→/↑를 셸에 'myhub:desktop-nav-key'로 전달한다.
 * - uiAction 수신: 셸이 재타기팅한 'myhub:ui-action'을 등록 핸들러에 배분.
 * - 문서명 채널: setTitle()이 'myhub:doc-title'을 셸 창 제목줄로 게시.
 * - 메일 승인 토큰은 결과 메시지로 받지 않는다 (핸들러에 토큰을 넘기지 않음).
 *
 * 노출: window.MyHubBridge
 */
(function () {
  'use strict';

  if (window.parent && window.parent !== window) {
    document.documentElement.classList.add('myhub-embedded');
  }

  var contextProvider = null;
  var uiActionHandlers = [];

  function post(msg) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, window.location.origin);
    }
  }

  function declareContext() {
    if (!contextProvider) return;
    var ctx = null;
    try { ctx = contextProvider(); } catch (e) { console.debug('컨텍스트 수집 실패:', e); }
    if (ctx) post({ type: 'myhub:subchat-context', context: ctx });
  }

  window.addEventListener('message', function (ev) {
    if (ev.origin !== window.location.origin) return;
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'myhub:bridge-hello') {
      declareContext();
    } else if (d.type === 'myhub:ui-action' && d.action) {
      var safe = {};
      Object.keys(d.action).forEach(function (k) {
        if (/token/i.test(k)) return; // 승인 토큰은 앱 핸들러로 넘기지 않는다
        safe[k] = d.action[k];
      });
      uiActionHandlers.forEach(function (fn) {
        try { fn(safe); } catch (e) { console.debug('uiAction 처리 실패:', e); }
      });
    }
  });

  var bridge = {
    /** 전경 앱 컨텍스트 제공자를 등록한다 (셸 서브챗이 hello 때 수집). */
    setContextProvider: function (fn) { contextProvider = fn; declareContext(); },
    /** 비서의 uiAction 핸들러를 등록한다. */
    onUiAction: function (fn) { uiActionHandlers.push(fn); },
    /** 창 제목줄에 문서·콘텐츠 이름을 게시한다. */
    setTitle: function (title) { post({ type: 'myhub:doc-title', title: String(title || '') }); },
    /** 셸에 임의 메시지를 보낸다 (핸드셰이크 등). */
    post: post,
    declareContext: declareContext,
  };

  window.MyHubBridge = bridge;
  post({ type: 'myhub:bridge-ready' });
})();
