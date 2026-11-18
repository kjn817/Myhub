// 엔진 자산 프리패치 공용 코어 — public/js/craft-prefetch-core.js
//
// deck/grid standalone 래퍼·finder-deckcraft·finder-pdfcraft 내장·
// 데스크톱 office-prefetch 5곳이 공유하던 drain·체인·발견·once
// 플래그·자동 부팅 게이트를 한 곳으로 모은다 (F-L1, 5-1).
// 이 파일을 먼저 받은 페이지에서만 래퍼가 동작한다 — office.html·
// desktop.html은 정적 순서로, finder.js는 동적 import 체인으로
// 코어 선행을 보장한다. 코어가 없으면 래퍼는 프리패치를 조용히
// 건너뛴다 (프리패치는 최적화일 뿐 — 못 데우면 앱이 그때 받는다).
//
// 보존하는 계약:
// - once 플래그 이름과 공유 관계: standalone deck 래퍼와 finder 내장
//   deck이 __myhubDeckcraftPrefetched를 공유한다 (한쪽이 데우면
//   다른 쪽이 건너뛴다).
// - 자동 부팅 게이트: 오피스 표면이면 자동 실행 안 함, 데이터 절약
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
  //
  // 참고 (2026-11-18): 청크마다 setTimeout(0)으로 양보하는 안을
  // 시도했으나 longtask가 줄지 않았다 — LoAF 실측에서 drain 중
  // longtask은 스크립트 귀속이 없는 GC성 블록(blocking 50~100ms,
  // scripts 비어 있음)이었다. 18MB 단발성 ArrayBuffer 할당이 원인이라
  // 양보로는 안 줄고, 근본 해법은 JS를 거치지 않는
  // <link rel="prefetch"> 방식의 전환이다 (별도 작업으로 남긴다).
  // 호버 프리패치의 longtask은 합성 mouseenter 게이트
  // (office-prefetch.js)가 막으므로, drain 자체는 그대로 둔다.
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

  // 진행 추적 fetch (2026-11-15 부팅 강건화): 바이트가 계속 들어오면
  // 기다리고, 멈추면 중단·재시도한다. 고정 벽시계 타임아웃은 느린
  // 네트워크의 정상 부팅을 죽이므로 쓰지 않는다 — 카페 실측 55KB/s에서
  // 33MB는 10분이 걸리는데 30초·60초 타임아웃은 절대 안 끝난다.
  // opts = { stallTimeoutMs(기본 30000), maxAttempts(기본 3),
  //          retryDelayMs(기본 1000), collectBody, onProgress,
  //          setTimeoutFn, clearTimeoutFn }.
  // onProgress({ url, receivedBytes, totalBytes, attempt }).
  // HTTP 오류(404 등)는 재시도하지 않고 즉시 reject한다.
  // @returns {Promise<{url, receivedBytes, totalBytes, body?}>}
  function fetchWithProgress(fetchFn, url, opts) {
    opts = opts || {};
    var stallTimeoutMs =
      typeof opts.stallTimeoutMs === 'number' ? opts.stallTimeoutMs : 30000;
    var maxAttempts = typeof opts.maxAttempts === 'number' ? opts.maxAttempts : 3;
    var retryDelayMs = typeof opts.retryDelayMs === 'number' ? opts.retryDelayMs : 1000;
    var collectBody = !!opts.collectBody;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var setTimeoutFn = opts.setTimeoutFn || setTimeout;
    var clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;

    function report(received, total, attempt) {
      if (!onProgress) return;
      try {
        onProgress({
          url: url,
          receivedBytes: received,
          totalBytes: total,
          attempt: attempt,
        });
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[prefetch] onProgress 실패', e);
        }
      }
    }

    function attemptOnce(attempt) {
      return new Promise(function (resolve, reject) {
        var controller = null;
        if (typeof AbortController !== 'undefined') {
          try {
            controller = new AbortController();
          } catch (e) {
            controller = null;
          }
        }
        var received = 0;
        var total = null;
        var chunks = collectBody ? [] : null;
        var settled = false;
        var stallTimer = null;
        var clearStall = function () {
          if (stallTimer) {
            clearTimeoutFn(stallTimer);
            stallTimer = null;
          }
        };
        var finish = function (err, result) {
          if (settled) return;
          settled = true;
          clearStall();
          if (err) reject(err);
          else resolve(result);
        };
        var armStall = function () {
          clearStall();
          stallTimer = setTimeoutFn(function () {
            if (settled) return;
            if (controller) {
              try {
                controller.abort();
              } catch (e) {
                // 중단 실패는 무시 — 아래 finish가 거절을 맡는다.
                if (typeof console !== 'undefined' && console.warn) {
                  console.warn('[prefetch] 중단 실패', e);
                }
              }
            }
            finish(new Error('stall timeout: ' + url));
          }, stallTimeoutMs);
        };
        var fetchPromise;
        try {
          fetchPromise =
            controller && controller.signal !== undefined
              ? fetchFn(url, { signal: controller.signal })
              : fetchFn(url);
        } catch (e) {
          finish(e);
          return;
        }
        Promise.resolve(fetchPromise)
          .then(function (res) {
            if (settled) return;
            if (!res || !res.ok) {
              finish(new Error('http ' + (res && res.status) + ': ' + url));
              return;
            }
            var len =
              res.headers && typeof res.headers.get === 'function'
                ? res.headers.get('content-length')
                : null;
            total = len !== null && len !== undefined ? parseInt(len, 10) : null;
            if (typeof total !== 'number' || isNaN(total)) total = null;
            report(0, total, attempt);
            if (!res.body || typeof res.body.getReader !== 'function') {
              armStall();
              Promise.resolve(
                res.arrayBuffer ? res.arrayBuffer() : Promise.resolve(null),
              )
                .then(function (buf) {
                  if (settled) return;
                  received = buf ? buf.byteLength : 0;
                  report(received, total, attempt);
                  finish(null, {
                    url: url,
                    receivedBytes: received,
                    totalBytes: total,
                    body: collectBody && buf ? new Uint8Array(buf) : undefined,
                  });
                })
                .catch(function (e) {
                  finish(e);
                });
              return;
            }
            var reader = res.body.getReader();
            armStall();
            var pump = function () {
              if (settled) return;
              reader
                .read()
                .then(function (step) {
                  if (settled) return;
                  if (step.done) {
                    var body = undefined;
                    if (collectBody) {
                      var size = 0;
                      chunks.forEach(function (c) {
                        size += c.byteLength || c.length || 0;
                      });
                      body = new Uint8Array(size);
                      var off = 0;
                      chunks.forEach(function (c) {
                        var u8 = c instanceof Uint8Array ? c : new Uint8Array(c);
                        body.set(u8, off);
                        off += u8.byteLength;
                      });
                    }
                    finish(null, {
                      url: url,
                      receivedBytes: received,
                      totalBytes: total,
                      body: body,
                    });
                    return;
                  }
                  var chunk = step.value;
                  var n = chunk ? chunk.byteLength || chunk.length || 0 : 0;
                  received += n;
                  if (collectBody && chunk) chunks.push(chunk);
                  report(received, total, attempt);
                  armStall();
                  pump();
                })
                .catch(function (e) {
                  finish(e);
                });
            };
            pump();
          })
          .catch(function (e) {
            finish(e);
          });
      });
    }

    function run(attempt) {
      return attemptOnce(attempt).catch(function (err) {
        var isHttp =
          err && typeof err.message === 'string' && err.message.indexOf('http ') === 0;
        if (isHttp || attempt >= maxAttempts) throw err;
        return new Promise(function (resolve) {
          setTimeoutFn(resolve, retryDelayMs);
        }).then(function () {
          return run(attempt + 1);
        });
      });
    }
    return run(1);
  }

  // 진행 추적 순차 fetch: URL을 순서대로 받으며 바이트 진행을 보고한다.
  // HTTP 오류는 failed에, 재시도 후에도 멈춘 것은 stalled에 담고 나머지를
  // 계속 받는다. 부팅 게이트는 stalled가 비었을 때만 진행한다.
  // onProgress({ url, receivedBytes, filesDone, filesTotal, currentUrl, attempt }).
  // @returns {Promise<{done, failed, stalled, receivedBytes}>}
  function fetchSequentialTracked(fetchFn, urls, opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var list = urls || [];
    var done = [];
    var failed = [];
    var stalled = [];
    var receivedTotal = 0;
    var chain = Promise.resolve();
    list.forEach(function (u, idx) {
      chain = chain.then(function () {
        return fetchWithProgress(fetchFn, u, {
          stallTimeoutMs: opts.stallTimeoutMs,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          setTimeoutFn: opts.setTimeoutFn,
          clearTimeoutFn: opts.clearTimeoutFn,
          onProgress: function (p) {
            if (onProgress) {
              onProgress({
                url: u,
                receivedBytes: receivedTotal + p.receivedBytes,
                filesDone: idx,
                filesTotal: list.length,
                currentUrl: u,
                attempt: p.attempt,
              });
            }
          },
        })
          .then(function (r) {
            done.push(u);
            receivedTotal += r.receivedBytes;
          })
          .catch(function (err) {
            var isHttp =
              err && typeof err.message === 'string' && err.message.indexOf('http ') === 0;
            if (isHttp) failed.push(u);
            else stalled.push(u);
          });
      });
    });
    return chain.then(function () {
      return {
        done: done,
        failed: failed,
        stalled: stalled,
        receivedBytes: receivedTotal,
      };
    });
  }

  // 텍스트에서 같은 출처의 .js/.wasm/.css 자산 URL을 뽑는다.
  // HTML의 src/href 절대 경로와 JS 안의 상대 경로 문자열(`./x.js`,
  // `assets/x.wasm`)을 모두 잡는다. 해시 파일명이 바뀌어도 따라간다.
  // 쿼리·해시는 떼고(캐시 키는 경로 기준), 중복을 제거한다.
  function extractAssetRefs(text, baseUrl) {
    var out = [];
    var seen = {};
    var src = String(text || '');
    var base = null;
    try {
      base = new URL(baseUrl);
    } catch (e) {
      base = null;
    }
    var push = function (rel) {
      if (!rel) return;
      var abs = null;
      try {
        abs = base ? new URL(rel, base).href : rel;
      } catch (e) {
        return;
      }
      if (base) {
        try {
          if (new URL(abs).origin !== base.origin) return;
        } catch (e) {
          return;
        }
      }
      var clean = abs.split('#')[0].split('?')[0];
      if (!/\.(js|wasm|css)$/.test(clean)) return;
      if (seen[clean]) return;
      seen[clean] = true;
      out.push(clean);
    };
    var reAttr = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    var m;
    while ((m = reAttr.exec(src))) push(m[1]);
    // JS 문자열 리터럴 안의 경로: 슬래시를 포함하고 .js/.wasm으로 끝나며
    // (쿼리·해시 접미사 허용), 백틱 템플릿 리터럴도 잡는다.
    var reStr = /["'`]([^"'`\s]*\/[^"'`\s]*?\.(?:js|wasm)(?:[?#][^"'`\s]*)?)["'`]/g;
    while ((m = reStr.exec(src))) push(m[1]);
    return out;
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
   * manifest.json에서 진입 에셋 URL을 만든다.
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

  // 오피스 표면 판정: office.html은 한 번에 두 포맷(?app=)만 열고 그
  // 엔진의 문서를 두 대 iframe이 직접 받으므로, 진입 시점의 두 엔진을
  // 데우는 자동 프리페치는 오피스에서 하지 않는다 (지연 로드 두 엔진을
  // 한 때만 로드). Finder에서는 종전대로 데운다.
  function isOfficeSurface() {
    return (
      typeof window !== 'undefined' &&
      !!window.location &&
      typeof window.location.pathname === 'string' &&
      /(^|\/)office\.html$/.test(window.location.pathname)
    );
  }

  // 자동 프리패치 예약: 오피스 표면·데이터 절약 모드에서는 건너뛰고,
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
    fetchWithProgress: fetchWithProgress,
    fetchSequentialTracked: fetchSequentialTracked,
    extractAssetPaths: extractAssetPaths,
    extractAssetRefs: extractAssetRefs,
    manifestAssetUrls: manifestAssetUrls,
    createPrefetch: createPrefetch,
    isOfficeSurface: isOfficeSurface,
    scheduleAutoBoot: scheduleAutoBoot,
  };
  if (typeof window !== 'undefined') window.MyHubCraftPrefetchCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
