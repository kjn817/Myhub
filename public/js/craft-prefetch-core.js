// 엔진 자산 프리패치 공용 코어 — public/js/craft-prefetch-core.js
//
// deck/grid standalone 래퍼·finder-deckcraft·finder-pdfcraft 내장·
// 데스크톱 office-prefetch 5곳이 공유하던 drain·체인·발견·once
// 플래그·자동 부팅 게이트를 한 곳으로 모은다 (F-L1, 5-1).
// 이 파일을 먼저 받은 서면에서만 래퍼가 동작한다 — office.html·
// desktop.html은 정적 순서로, finder.js는 동적 import 체인으로
// 코어 선행을 보장한다. 코어가 없으면 래퍼는 프리패치를 조용히
// 건너뛴다 (프리패치는 최적화일 뿐 — 못 데우면 앱이 그때 받는다).
//
// 보존하는 계약:
// - once 플래그 이름과 공유 관계: standalone deck 래퍼와 finder 내장
//   deck이 __myhubDeckcraftPrefetched를 공유한다 (한쪽이 데우면
//   다른 쪽이 건너뛴다).
// - 자동 부팅 게이트: 오피스 서면이면 자동 실행 안 함, 데이터 절약
//   모드면 건너뜀, idle(5000ms 타임아웃) / complete면 1500ms 후 /
//   아니면 load + 1500ms.
// - 발견 규칙: index 스캔은 href="./..." 중 .js/.wasm만, 선언 순서
//   유지, 중복 제거. manifest는 js·wasm(+wasmParts)·files 중
//   snippets/ (+pdf만 loader.js) — 호출부 옵션으로 고른다.
// - 체인 규칙: 순차 fetch → ok면 done에 추가 → drain → 개별 실패
//   무시. 전체 실패 시 [] 반환.
(function () {
  'use strict';

  // 본문은 끝까지 내려보내 HTTP 캐시만 데운다 (수십 MB를 통째로
  // 메모리에 올리지 않는다). 스트림이 없으면 arrayBuffer로 받아
  // 버린다. pump 실패도 삼킨다 (office본의 catch 포함 버전으로 통일 —
  // 체인 안에서는 바깥 catch가 덮으므로 관측이 같다).
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
    return pump().catch(function () { return undefined; });
  }

  // URL을 순서대로 받아 캐시를 데운다. 개별 실패는 무시하고,
  // 실제로 받은(ok) URL 목록만 돌려준다.
  function fetchSequential(fetchFn, urls) {
    var done = [];
    var chain = Promise.resolve();
    (urls || []).forEach(function (u) {
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
  }

  /**
   * 벤더 index.html에서 preload/modulepreload로 선언한 자산 상대
   * 경로를 뽑는다. .js/.wasm만, 선언 순서 유지, 중복 제거.
   * 아이콘(.ico) 같은 선언은 제외한다.
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
   * manifest.json에서 진입 자산 URL을 만든다.
   * opts = { wasm, wasmParts, snippets, loader } — 호출부가 명시한다.
   * 순서: js → wasm → wasmParts → files (files 안에서는 선언 순서).
   * pdfcraft는 단일 wasm(47MB)을 받지 않고 wasmParts만 받으므로
   * wasm 옵션을 켜지 않는다 — 옵션을 빼먹으면 47MB를 더 받는
   * 회귀이니 호출부 테스트가 고정한다.
   */
  function manifestAssetUrls(base, man, opts) {
    opts = opts || {};
    var urls = [];
    if (!man) return urls;
    if (man.js) urls.push(base + man.js);
    if (opts.wasm && man.wasm) urls.push(base + man.wasm);
    if (opts.wasmParts && Array.isArray(man.wasmParts)) {
      man.wasmParts.forEach(function (rel) {
        urls.push(base + rel);
      });
    }
    if (Array.isArray(man.files)) {
      man.files.forEach(function (rel) {
        if (
          (opts.loader && rel === 'loader.js') ||
          (opts.snippets && rel.indexOf('snippets/') === 0)
        ) {
          urls.push(base + rel);
        }
      });
    }
    return urls;
  }

  /**
   * once 플래그 + fetch 해석 + 전체 실패 [] 를 갖춘 prefetch를 만든다.
   * cfg = { flag, discover } — discover(fetchFn)은 자산 URL 목록을
   * 돌려주는 Promise다 (shell fetch·manifest fetch는 호출부가 맡는다).
   * 플래그는 발견 전에 세운다 — 동시 호출이 이중 다운로드를 못 하게.
   * fetchFn이 없으면 플래그를 세우지 않고 []를 돌려준다 (나중에
   * fetchFn이 생기면 다시 시도할 수 있게).
   * deps = { fetchFn, win } (테스트 주입용).
   * @returns {Promise<string[]>} 실제로 받은 URL 목록
   */
  function createPrefetch(cfg) {
    var flag = cfg.flag;
    var discover = cfg.discover;
    return function prefetch(deps) {
      deps = deps || {};
      var win = deps.win || (typeof window !== 'undefined' ? window : null);
      var fetchFn =
        deps.fetchFn ||
        (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
      if (!fetchFn) return Promise.resolve([]);
      if (win && win[flag]) return Promise.resolve([]);
      if (win) win[flag] = true;
      return discover(fetchFn)
        .then(function (urls) {
          return fetchSequential(fetchFn, urls);
        })
        .catch(function () {
          return [];
        });
    };
  }

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

  // 자동 프리패치 예약: 오피스 서면·데이터 절약 모드에서는 건너뛰고,
  // 아니면 idle(5000ms 타임아웃) / complete면 1500ms 후 / 아니면
  // load + 1500ms에 fn을 한 번 부른다. fn은 인자 없이 부른다
  // (idle deadline·load 이벤트가 prefetch의 deps로 새지 않게).
  function scheduleAutoBoot(fn) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    var conn = typeof navigator !== 'undefined' ? navigator.connection : null;
    if (isOfficeSurface() || (conn && conn.saveData)) return;
    var boot = function () {
      fn();
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

  var api = {
    drain: drain,
    fetchSequential: fetchSequential,
    extractAssetPaths: extractAssetPaths,
    manifestAssetUrls: manifestAssetUrls,
    createPrefetch: createPrefetch,
    isOfficeSurface: isOfficeSurface,
    scheduleAutoBoot: scheduleAutoBoot,
  };
  if (typeof window !== 'undefined') window.MyHubCraftPrefetchCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
