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

  // 본문은 끝까지 내려보내 HTTP 캐시만 데운다 (17~36MB를 통째로 메모리에
  // 올리지 않는다). 스트림이 없으면 arrayBuffer로 받아 버린다.
  function drain(res) {
    if (!res || !res.body || typeof res.body.getReader !== 'function') {
      return res && typeof res.arrayBuffer === 'function'
        ? res.arrayBuffer().then(function () { return undefined; })
        : Promise.resolve();
    }
    var reader = res.body.getReader();
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return undefined;
        return pump();
      });
    }
    return pump().catch(function () { return undefined; });
  }

  function fetchAll(urls) {
    var chain = Promise.resolve();
    urls.forEach(function (u) {
      chain = chain
        .then(function () { return fetch(u); })
        .then(function (res) { return drain(res); })
        .catch(function () { return undefined; });
    });
    return chain;
  }

  function prefetchFromManifest(appId) {
    var cfg = APPS[appId];
    return fetch(cfg.manifest)
      .then(function (res) {
        if (!res || !res.ok) throw new Error('manifest http ' + (res && res.status));
        return res.json();
      })
      .then(function (man) {
        var urls = [];
        if (man && man.js) urls.push(cfg.base + man.js);
        if (man && man.wasm) urls.push(cfg.base + man.wasm);
        if (man && Array.isArray(man.wasmParts)) {
          man.wasmParts.forEach(function (rel) { urls.push(cfg.base + rel); });
        }
        return fetchAll(urls);
      })
      .catch(function () { return undefined; });
  }

  function prefetchFromIndex(appId) {
    var cfg = APPS[appId];
    return fetch(cfg.index)
      .then(function (res) {
        if (!res || !res.ok) throw new Error('index http ' + (res && res.status));
        return res.text();
      })
      .then(function (html) {
        var urls = [];
        // preload·modulepreload 링크의 href를 모은다 (상대 경로는 base로 푼다).
        var re = /<link[^>]+rel=["'](?:module)?preload["'][^>]*href=["']([^"']+)["']/gi;
        var m;
        while ((m = re.exec(html)) !== null) {
          var href = m[1];
          if (href.indexOf('./') === 0) href = href.slice(2);
          if (href.charAt(0) !== '/') href = cfg.base + href;
          if (urls.indexOf(href) < 0) urls.push(href);
        }
        return fetchAll(urls);
      })
      .catch(function () { return undefined; });
  }

  function prefetch(appId) {
    if (!APPS[appId] || prefetched[appId]) return;
    if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) return;
    prefetched[appId] = true;
    if (APPS[appId].manifest) prefetchFromManifest(appId);
    else prefetchFromIndex(appId);
  }

  if (typeof window !== 'undefined') {
    window.MyHubOfficePrefetch = { prefetch: prefetch };
  }
})();
