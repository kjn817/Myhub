// Rhwp Studio 엔진 자산 프리패치 — public/js/rhwp-prefetch.js
//
// 한글 편집기를 열 때 가장 무거운 비용은 스튜디오 자산(21MB: JS 글루
// 2.1MB + canvaskit WASM 7.3MB + rhwp WASM 11.8MB) 전송이다. vendor SDK의
// createEditor는 iframe load를 기다린 뒤 _waitReady로 15초 안에 ready를
// 확인하는데, 느린 네트워크에서는 WASM이 그 안에 도착하지 않아 부팅이
// 실패한다. 그래서 부팅 전에 자산을 미리 받아 HTTP 캐시를 데워 둔다 —
// 데워 두면 createEditor는 캐시에서 받아 바로 뜬다.
//
// 자산 목록은 하드코딩하지 않는다: 스튜디오 index.html의 src/href에서
// JS·CSS를 읽고, JS 본문에서 중첩 참조(.wasm·청크 JS)를 2단계까지
// 따라간다. 해시 파일명이 바뀌어도 그대로 따라간다. HTML 자체는
// Worker가 no-store로 주므로 데울 수 없고 발견용으로만 쓴다.
//
// 얇은 래퍼다: 진행 추적·스톨 감지·재시도·추출은 공용 코어
// (craft-prefetch-core.js)가 맡고, 여기서는 Rhwp 설정(SHELL_URL·BASE·
// 플래그명·API 이름)과 2단계 발견만 남긴다. 코어는 이 파일보다 먼저
// 받아야 한다 (office.html 정적 순서·finder.js 동적 import 체인).
// 코어가 없으면 프리패치를 조용히 건너뛴다.
//
// prefetch: 백그라운드 최적화용 (한 번만, 실패 무시 — 기존 래퍼와 동일).
// prefetchForBoot: 부팅 게이트용 — 진행을 보고하고, 멈춘 파일이 남으면
// reject한다. once 플래그를 타지 않는다 (백그라운드 프리패치가
// 중간에 실패했어도 부팅 때는 다시 받아야 한다).
(function () {
  'use strict';

  var SHELL_URL = '/rhwp-studio/index.html';
  var BASE = '/rhwp-studio/';
  var FLAG = '__myhubRhwpPrefetched';
  var MAX_DEPTH = 2;
  var MAX_FILES = 30;

  var warnedMissingCore = false;
  function getCore() {
    var core =
      typeof window !== 'undefined' ? window.MyHubCraftPrefetchCore : null;
    if (!core && !warnedMissingCore) {
      warnedMissingCore = true;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          '[rhwp-prefetch] 코어(craft-prefetch-core.js)가 없어 프리패치를 건너뜁니다'
        );
      }
    }
    return core;
  }

  function getFetchFn(deps) {
    deps = deps || {};
    if (typeof deps.fetchFn === 'function') return deps.fetchFn;
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    return win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null;
  }

  function getOrigin(win) {
    var w =
      win && win.location && win.location.origin
        ? win
        : typeof window !== 'undefined'
          ? window
          : null;
    return (w && w.location && w.location.origin) || '';
  }

  // 2단계 발견: index.html → JS 본문 → 중첩 .js/.wasm. JS 본문은
  // fetchWithProgress로 받아 진행도 보고하고, 받은 본문은 캐시를
  // 데우므로 워밍 목록에서는 뺀다.
  // @returns {Promise<{assets: string[], warmed: string[], receivedBytes: number}>}
  function discoverTracked(fetchFn, opts) {
    var core = getCore();
    opts = opts || {};
    var seen = {};
    var assets = [];
    var warmed = [];
    var receivedBytes = 0;
    // 중첩 참조(`./chunk.js`)를 풀려면 기준이 절대 URL이어야 한다 —
    // 상대 경로만으로는 extractAssetRefs가 원본을 모른다.
    var origin = getOrigin(opts.win);
    var queue = [{ url: SHELL_URL, depth: 0 }];
    function step() {
      if (!queue.length || assets.length >= MAX_FILES) {
        return Promise.resolve({ assets: assets, warmed: warmed, receivedBytes: receivedBytes });
      }
      var item = queue.shift();
      if (seen[item.url]) return step();
      seen[item.url] = true;
      return core
        .fetchWithProgress(fetchFn, item.url, {
          stallTimeoutMs: opts.stallTimeoutMs,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          collectBody: true,
          onProgress: opts.onProgress,
          setTimeoutFn: opts.setTimeoutFn,
          clearTimeoutFn: opts.clearTimeoutFn,
        })
        .then(function (r) {
          receivedBytes += r.receivedBytes;
          if (item.url !== SHELL_URL) warmed.push(item.url);
          var text = '';
          if (r.body) {
            try {
              text = new TextDecoder().decode(r.body);
            } catch (e) {
              text = '';
            }
          }
          var absItemUrl = item.url;
          if (origin) {
            try {
              absItemUrl = new URL(item.url, origin).href;
            } catch (e) {
              absItemUrl = item.url;
            }
          }
          var refs = core.extractAssetRefs(text, absItemUrl);
          refs.forEach(function (u) {
            if (seen[u]) return;
            if (assets.indexOf(u) === -1) assets.push(u);
            if (item.depth < MAX_DEPTH && /\.js$/.test(u)) {
              queue.push({ url: u, depth: item.depth + 1 });
            }
          });
          return step();
        })
        .catch(function () {
          return step();
        });
    }
    return step();
  }

  // 백그라운드용 발견 (진행 보고 없음): 코어 createPrefetch이 쓴다.
  function discover(fetchFn) {
    return discoverTracked(fetchFn, {}).then(function (r) {
      return r.assets;
    });
  }

  var prefetchImpl = null;
  /**
   * 자산을 전부 받아 캐시를 데운다 (백그라운드 최적화용).
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

  /**
   * 부팅 게이트용 프리패치: 발견 + 워밍을 진행 보고와 함께 수행한다.
   * 멈춘 파일이 남으면 reject한다 (부팅은 에러 카드로 간다).
   * deps = { fetchFn, win, onProgress, stallTimeoutMs, maxAttempts,
   *          retryDelayMs, setTimeoutFn, clearTimeoutFn }.
   * onProgress({ url, receivedBytes, filesDone, filesTotal, currentUrl,
   *              attempt, phase }) — phase는 'discover' | 'warm'.
   * @returns {Promise<{done, failed, stalled, receivedBytes}>}
   */
  function prefetchForBoot(deps) {
    var core = getCore();
    if (!core) return Promise.resolve({ done: [], failed: [], stalled: [], receivedBytes: 0 });
    var fetchFn = getFetchFn(deps);
    if (!fetchFn) return Promise.resolve({ done: [], failed: [], stalled: [], receivedBytes: 0 });
    deps = deps || {};
    var onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : null;
    var receivedBase = 0;
    var report = function (p, phase) {
      if (onProgress) {
        onProgress({
          url: p.url,
          receivedBytes: receivedBase + p.receivedBytes,
          filesDone: p.filesDone !== undefined ? p.filesDone : 0,
          filesTotal: p.filesTotal !== undefined ? p.filesTotal : 0,
          currentUrl: p.currentUrl || p.url,
          attempt: p.attempt,
          phase: phase,
        });
      }
    };
    return discoverTracked(fetchFn, {
      win: deps.win,
      stallTimeoutMs: deps.stallTimeoutMs,
      maxAttempts: deps.maxAttempts,
      retryDelayMs: deps.retryDelayMs,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
      onProgress: function (p) {
        report(p, 'discover');
      },
    }).then(function (found) {
      var warmedSet = {};
      found.warmed.forEach(function (u) {
        warmedSet[u] = true;
      });
      var toWarm = found.assets.filter(function (u) {
        return !warmedSet[u];
      });
      // 발견 단계에서 받은 바이트를 기준선으로 삼는다.
      receivedBase = found.receivedBytes;
      return core
        .fetchSequentialTracked(fetchFn, toWarm, {
          stallTimeoutMs: deps.stallTimeoutMs,
          maxAttempts: deps.maxAttempts,
          retryDelayMs: deps.retryDelayMs,
          setTimeoutFn: deps.setTimeoutFn,
          clearTimeoutFn: deps.clearTimeoutFn,
          onProgress: function (p) {
            report(p, 'warm');
          },
        })
        .then(function (r) {
          if (r.stalled.length) {
            throw new Error(
              '엔진 자산을 받지 못했습니다 (멈춤: ' + r.stalled.join(', ') + ')'
            );
          }
          return r;
        });
    });
  }

  var api = {
    prefetch: prefetch,
    prefetchForBoot: prefetchForBoot,
    discoverTracked: discoverTracked,
    SHELL_URL: SHELL_URL,
    BASE: BASE,
  };
  if (typeof window !== 'undefined') window.MyHubRhwpPrefetch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 자동 프리패치: 두 모듈이 정적으로 로드하는 문서(finder.html·
  // office.html)에서만 알고, 문서는 한 번, 유효 시간은 있다. 데이터
  // 예약 모드에서는 건너뛴다. 오피스 표면에서는 앱 게이트로 건너뛴다 —
  // 게이트·예약은 코어가 맡는다.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    var core = getCore();
    if (core) core.scheduleAutoBoot(prefetch);
  }
})();
