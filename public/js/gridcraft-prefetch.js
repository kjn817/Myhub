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
// 얇은 래퍼다: drain·체인·발견·once·부팅 게이트는 공용 코어
// (craft-prefetch-core.js)가 맡고, 여기서는 GridCraft 설정(SHELL_URL·
// BASE·플래그명·API 이름)만 남긴다. 코어는 이 파일보다 먼저 받아야
// 한다 (office.html 정적 순서·finder.js 동적 import 체인). 코어가
// 없으면 프리패치를 조용히 건너뛴다.
//
// 규칙은 finder-pdfcraft의 프리패치와 같다: 문서는 한 번, 유효 시간은,
// 데이터 예약 모드에서는 건너뛰고, 실패는 조용히 무시한다 (프리패치는
// 최적화일 뿐 — 못 데우면 앱 그때 그대로 받으면 된다).
(function () {
  'use strict';

  var SHELL_URL = '/vendor/gridcraft/index.html';
  var BASE = '/vendor/gridcraft/';
  var FLAG = '__myhubGridcraftPrefetched';

  var warnedMissingCore = false;
  function getCore() {
    var core =
      typeof window !== 'undefined' ? window.MyHubCraftPrefetchCore : null;
    if (!core && !warnedMissingCore) {
      warnedMissingCore = true;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          '[gridcraft-prefetch] 코어(craft-prefetch-core.js)가 없어 프리패치를 건너뜁니다'
        );
      }
    }
    return core;
  }

  function discover(fetchFn) {
    var core = getCore();
    return fetchFn(SHELL_URL)
      .then(function (res) {
        if (!res || !res.ok) throw new Error('shell http ' + (res && res.status));
        return res.text();
      })
      .then(function (html) {
        return core.extractAssetPaths(html).map(function (rel) {
          return BASE + rel;
        });
      });
  }

  var prefetchImpl = null;
  /**
   * 줄을 읽어 선언한 자산은 전부 받아 캐시를 데운다.
   * deps = { fetchFn, win } (테스트 주입용).
   * @returns {Promise<string[]>} 실제로 받은 URL 목록
   */
  function prefetch(deps) {
    var core = getCore();
    if (!core) return Promise.resolve([]);
    if (!prefetchImpl) {
      prefetchImpl = core.createPrefetch({ flag: FLAG, discover: discover });
    }
    return prefetchImpl(deps);
  }

  function extractAssetPaths(html) {
    var core = getCore();
    if (!core) return [];
    return core.extractAssetPaths(html);
  }

  var api = {
    prefetch: prefetch,
    extractAssetPaths: extractAssetPaths,
    SHELL_URL: SHELL_URL,
  };
  if (typeof window !== 'undefined') window.MyHubGridcraftPrefetch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 자동 프리패치: 두 모듈이 정적으로 로드하는 문서(finder.html·
  // office.html)에서만 알고, 문서는 한 번, 유효 시간은 있다. 데이터
  // 예약 모드에서는 건너뛴다 (17MB 전송을 강요하지 않는다). 오피스
  // 서면에서는 앱 게이트로 건너뛴다 — 게이트·예약은 코어가 맡는다.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    var core = getCore();
    if (core) core.scheduleAutoBoot(prefetch);
  }
})();
