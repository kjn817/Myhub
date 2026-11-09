// GridCraft 엔진 자산 프리패치 — public/js/gridcraft-prefetch.js
//
// 시트를 열 때 가장 무거운 단일 비용은 GridCraft WASM(17MB)를 전송한다.
// · 에서 finder.html유효office.html시간은 벤더 쪽이 선언한 진입 자산
// 글루 ·런타임(JS 을ASM미리)받아 캐시를 데워 HTTP 둔다 자산은 캐시.
// 자산은 캐시 파일명 + immutable 캐시며, 데운 뒤 바이트는 실제로 앱 네트워크
// 를 다시 건드리지 않는다.
//
// 자산 목록은 하드코딩하지 않는다: 벤더 앱(index.html)의 preload·
// modulepreload 선언에서 상대 경로를 읽으므로, 규칙으로 캐시 파일명이
// 바뀌어도 그대로 따라간다. HTML 자체는 Worker가 no-store로 주므로
// 데울 수 없고 상대도 아니다.
//
// 규칙은 finder-pdfcraft의 프리패치와 같다: 문서는 한 번, 유효 시간은,
// 데이터 예약 모드에서는 건너뛰고, 실패는 조용히 무시한다 (프리패치는
// 최적화일 뿐 — 못 데우면 앱 그때 그대로 받으면 된다).
(function () {
  'use strict';

  var SHELL_URL = '/vendor/gridcraft/index.html';
  var BASE = '/vendor/gridcraft/';

  // 본문은 끝까지 내려보내 HTTP 캐시만 데운다 (17MB를 통째로 메모리에
  // 올리지 않는다). 스트림이 없으면 arrayBuffer로 받아 버린다.
  function drain(res) {
    if (!res || !res.body || typeof res.body.getReader !== 'function') {
      return res && typeof res.arrayBuffer === 'function'
        ? res.arrayBuffer().then(function () { return undefined; })
        : Promise.resolve();
    }
    var reader = res.body.getReader();
    function pump() {
      return reader.read().then(function (step) {
        return step.done ? undefined : pump();
      });
    }
    return pump();
  }

  /**
   * 두 HTML에서 preload/modulepreload로 선언한 자산 상대 경로를 뽑는다.
   * .js/.wasm만, 선언 순서 유지, 중복 제거. 아이콘(.ico) 같은 선언은 제외.
   */
  function extractAssetPaths(html) {
    var out = [];
    var seen = {};
    var re = /href="\.\/([^"]+)"/g;
    var m;
    while ((m = re.exec(String(html || '')))) {
      var rel = m[1];
      if (!/\.(js|wasm)$/.test(rel)) continue;
      if (seen[rel]) continue;
      seen[rel] = true;
      out.push(rel);
    }
    return out;
  }

  /**
   * 줄을 읽어 선언한 자산은 전부 받아 캐시를 데운다.
   * deps = { fetchFn, win } (테스트 주입용).
   * @returns {Promise<string[]>} 실제로 받은 URL 목록
   */
  function prefetch(deps) {
    deps = deps || {};
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    var fetchFn =
      deps.fetchFn ||
      (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
    if (!fetchFn) return Promise.resolve([]);
    if (win && win.__myhubGridcraftPrefetched) return Promise.resolve([]);
    if (win) win.__myhubGridcraftPrefetched = true;
    return fetchFn(SHELL_URL)
      .then(function (res) {
        if (!res || !res.ok) throw new Error('shell http ' + (res && res.status));
        return res.text();
      })
      .then(function (html) {
        var urls = extractAssetPaths(html).map(function (rel) {
          return BASE + rel;
        });
        var done = [];
        var chain = Promise.resolve();
        urls.forEach(function (u) {
          chain = chain
            .then(function () {
              return fetchFn(u);
            })
            .then(function (res) {
              if (res && res.ok) done.push(u);
              return drain(res);
            })
            .catch(function () {
              return undefined; // 개별 실패는 무시한다 (프리패치는 최적화일 뿐)
            });
        });
        return chain.then(function () {
          return done;
        });
      })
      .catch(function () {
        return [];
      });
  }

  var api = {
    prefetch: prefetch,
    extractAssetPaths: extractAssetPaths,
    SHELL_URL: SHELL_URL,
  };
  if (typeof window !== 'undefined') window.MyHubGridcraftPrefetch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 오피스 서면 판정: office.html은 한 번에 두 형식(?app=)만 열고 그
  // 엔진 문서를 두 번 iframe이 직접 받으므로, 진입 시점의 두 엔진
  // 데우는 자동 프리패치를 오피스에서는 하지 않는다 (지연 로드 두 엔진
  // 한 때만 로드). Finder에서는 종전대로 데운다.
  function isOfficeSurface() {
    return (
      typeof window !== 'undefined' &&
      !!window.location &&
      typeof window.location.pathname === 'string' &&
      /(^|\/)office\.html$/.test(window.location.pathname)
    );
  }

  // 자동 프리패치: 두 모듈이 정적으로 로드하는 문서(finder.html·
  // office.html)에서만 알고, 문서는 한 번, 유효 시간은 있다. 데이터
  // 예약 모드에서는 건너뛴다 (17MB 전송을 강요하지 않는다). 오피스
  // 서면에서는 앱 게이트로 건너뛴다.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    var conn = typeof navigator !== 'undefined' ? navigator.connection : null;
    if (!isOfficeSurface() && !(conn && conn.saveData)) {
      var boot = function () {
        prefetch();
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(boot, { timeout: 5000 });
      } else if (document.readyState === 'complete') {
        setTimeout(boot, 1500);
      } else {
        window.addEventListener('load', function () {
          setTimeout(boot, 1500);
        });
      }
    }
  }
})();
