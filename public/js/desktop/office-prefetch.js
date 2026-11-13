// 오피스 앱 호버 프리패치 — 데스크톱에서 오피스 아이콘에 마우스를 올리면
// 해당 앱의 WASM을 미리 받아 HTTP 캐시를 데운다 (2026-11-12 오피스 성능
// 점검 — 사용자가 "너무 느려 버벅이고 무겁다"고 지적). 클릭 전에 다운로드를
// 시작해 체감 로딩을 줄인다.
// Finder의 프리패치와 같은 규칙: 앱당 1회, 데이터 절약 모드에서는 건너뛰고,
// 실패는 조용히 무시한다 (프리패치는 최적화일 뿐 — 못 데우면 앱이 그때 받는다).
// 자산 목록은 하드코딩하지 않는다: pdfcraft/deckcraft는 manifest.json에서,
// gridcraft는 index.html의 preload·modulepreload 선언에서 읽는다.
// 한글(rhwp-studio)은 Vite 해시 자산이라 매니페스트·preload이 없어 제외한다.
(function () {
  'use strict';

  var APPS = {
    excel: { base: '/vendor/gridcraft/', manifest: null, index: '/vendor/gridcraft/index.html' },
    pdf: { base: '/vendor/pdfcraft/', manifest: '/vendor/pdfcraft/manifest.json', index: null },
    powerpoint: { base: '/vendor/deckcraft/', manifest: '/vendor/deckcraft/manifest.json', index: null },
  };

  var prefetched = {}; // appId -> true

  // 프리패치 공용 코어(craft-prefetch-core.js) — drain·체인·발견을
  // 맡는다. 코어는 이 파일보다 먼저 받아야 한다 (desktop.html 정적
  // 순서). 코어가 없으면 프리패치를 조용히 건너뛴다 (프리패치는
  // 최적화일 뿐).
  var warnedMissingCore = false;
  function getCore() {
    var core =
      typeof window !== 'undefined' ? window.MyHubCraftPrefetchCore : null;
    if (!core && !warnedMissingCore) {
      warnedMissingCore = true;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          '[office-prefetch] 코어(craft-prefetch-core.js)가 없어 프리패치를 건너뜁니다'
        );
      }
    }
    return core;
  }

  function prefetchFromManifest(appId) {
    var core = getCore();
    var cfg = APPS[appId];
    return fetch(cfg.manifest)
      .then(function (res) {
        if (!res || !res.ok) throw new Error('manifest http ' + (res && res.status));
        return res.json();
      })
      .then(function (man) {
        // 호버 프리패치는 js·wasm·wasmParts만 데운다 (finder 내장과
        // 달리 snippets/loader.js는 받지 않는다 — 기존 동작 유지).
        var urls = core.manifestAssetUrls(cfg.base, man, {
          wasm: true,
          wasmParts: true,
        });
        return core.fetchSequential(fetch, urls);
      })
      .catch(function () { return undefined; });
  }

  function prefetchFromIndex(appId) {
    var core = getCore();
    var cfg = APPS[appId];
    return fetch(cfg.index)
      .then(function (res) {
        if (!res || !res.ok) throw new Error('index http ' + (res && res.status));
        return res.text();
      })
      .then(function (html) {
        var urls = core.extractAssetPaths(html).map(function (rel) {
          return cfg.base + rel;
        });
        return core.fetchSequential(fetch, urls);
      })
      .catch(function () { return undefined; });
  }

  function prefetch(appId) {
    if (!APPS[appId] || prefetched[appId]) return;
    if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) return;
    if (!getCore()) return;
    prefetched[appId] = true;
    if (APPS[appId].manifest) prefetchFromManifest(appId);
    else prefetchFromIndex(appId);
  }

  if (typeof window !== 'undefined') {
    window.MyHubOfficePrefetch = { prefetch: prefetch };
  }
})();
