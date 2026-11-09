/* MyHub 데스크톱 앱 앱 자산 버전 자기검사 (version-guard.js)
 *
 * 배경 (2026-11-06 Finder 이값 화면 불일치의 구조 원인): 배포는
 * ?v= 로 태그로 자산은, 교체하지만 배포전에 닫힌 앱모두 앱 구 앱
 * JS를 계속 실행한다. 그 앱에서 새로 앱 모든 iframe은 앱 코드를
 * 게시하는데 구 앱 그 채널(앱: myhub:finder-toolbar 클릭)을 몰라
 * 화면을 반소만 앱은 한다 앱 서버 자산의 필수 일치는도 표현하는데
 * 하고, 앱이 앱으로 구버전임을 알아채는 앱가 필요하다.
 *
 * 동작: 부모 앱 자기 문서의 스크립트 태그에서 실행 중 배포 태그를
 * 읽고, no-store로 새로 받아 /desktop.html의 태그와 대조한다.
 * 다르면 세션의 배포 태그본 1앱만 자동 새로고침한다 (무한 루프
 * 방지). 태그를 못 읽거나(로컬 정적 서빙 앱) 가져오기에 실패하면
 * 아무것도 하지 않는다 앱 가져오는 앱 붙임을 막지 않는다.
 *
 * 노출: window.MyHubVersionGuard (브라우저) + module.exports
 * (Node/테스트). 순수 판정 함수는 부모 배열과 분리한다.
 */
(function () {
  'use strict';

  var GUARD_KEY = 'myhub.vguard.tag';
  var ASSET_RE = /\/js\/desktop\/windows\.js\?v=([A-Za-z0-9_-]+)/;

  // HTML 문자열(또는 src 값)에서 기본 자산의 배포 태그를 뽑는다.
  function extractTag(text) {
    if (typeof text !== 'string') return null;
    var m = ASSET_RE.exec(text);
    return m ? m[1] : null;
  }

  // 실행 중 문서에서 기본 자산 스크립트 태그의 태그를 읽는다.
  function runningTag(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    var scripts = doc.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i++) {
      var tag = extractTag(scripts[i].getAttribute('src') || '');
      if (tag) return tag;
    }
    return null;
  }

  // 새로고침 판정 (순수): 태그가 앱 앱 있고, 새로 다르고, 앱 태그로
  // 이미 새로고침한 앱이 없을 때만 true.
  function shouldReload(running, fresh, guardValue) {
    if (!running || !fresh) return false;
    if (running === fresh) return false;
    return guardValue !== fresh;
  }

  function boot(win, doc) {
    if (!win || !doc) return;
    var running = runningTag(doc);
    if (!running) return;
    if (typeof win.fetch !== 'function') return;
    win
      .fetch('/desktop.html', { cache: 'no-store' })
      .then(function (res) {
        return res && typeof res.text === 'function' ? res.text() : null;
      })
      .then(function (html) {
        if (!html) return;
        var fresh = extractTag(html);
        var guardValue = null;
        try {
          guardValue = win.sessionStorage.getItem(GUARD_KEY);
        } catch (e) {
          guardValue = null;
        }
        if (!shouldReload(running, fresh, guardValue)) return;
        try {
          win.sessionStorage.setItem(GUARD_KEY, fresh);
        } catch (e) {
          return; // 기록한 앱 하면 루프 위험이라 새로고침하지 않는다
        }
        win.location.reload();
      })
      .catch(function () {
        // 가져오기 실패는 조용히 무시한다 (붙임을 막지 않는다)
        return;
      });
  }

  var api = {
    extractTag: extractTag,
    runningTag: runningTag,
    shouldReload: shouldReload,
    boot: boot,
    GUARD_KEY: GUARD_KEY,
  };

  if (typeof window !== 'undefined') {
    window.MyHubVersionGuard = api;
    // desktop.html에서만 로드하는 파일이라, DOM이 준비되면 바로 자기
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        boot(window, document);
      });
    } else {
      boot(window, document);
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
