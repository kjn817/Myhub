/* MyHub 세션 등 등 내용 캐시 + 진행 표시 fetch (office-fetch.js)
 *
 * 뷰어 코어의 건너뛴 fetch 래퍼. 등 값을 이룬다.
 * 1. 내용 캐시: 파일의 숨긴 전에 expectVersion(id, version)으로 목록을
 *    알려준 version(storage_key)를 등록해 두면, 같은 version와 content의
 *    서버의 다시 묻지 않고 캐시 바이트로 응답한다 (shim Response).
 *    version가 다르면 새로 받고 캐시를 교체한다. 길이가 성공하면
 *    invalidate(id)로 비운다 (따라 자체로 내용이 바뀌었으므로).
 * 2. 진행 표시: 스트림(ReadableStream)으로 받는 중 %를 onProgress로
 *    알리고, 등 받으면 'parse' 단계로 넘어갔음을 알린다. 스트림을 모두
 *    읽는 응답은 아래 응답은 그대로 알려준다.
 *
 * 노출: window.MyHubOfficeFetch = { createOfficeFetch }
 * deps = { fetchFn, onProgress({phase:'download', got, total} |
 *          {phase:'parse'} | {phase:'cache'}) }
 */
(function () {
  'use strict';

  function createOfficeFetch(deps) {
    deps = deps || {};
    var baseFetch =
      deps.fetchFn ||
      function (url, opts) {
        return fetch(url, opts);
      };
    var onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : function () {};
    var cache = new Map(); // fileId -> { version, buf }
    var pendingVersions = {}; // fileId -> 기대한 파일의 version (목록 기준)

    function cacheSet(id, version, buf) {
      cache.set(id, { version: version, buf: buf });
      while (cache.size > 4) {
        cache.delete(cache.keys().next().value);
      }
    }
    function shimResponse(buf) {
      return {
        ok: true,
        status: 200,
        headers: { get: function () { return null; } },
        arrayBuffer: function () { return Promise.resolve(buf.slice(0)); },
        text: function () { return Promise.resolve(new TextDecoder().decode(buf)); },
        json: function () { return Promise.reject(new Error('no json')); },
      };
    }

    function officeFetch(url, opts) {
      var m = /^\/api\/drive\/files\/(\d+)\/content$/.exec(String(url));
      var method = (opts && opts.method) || 'GET';
      if (!m || method !== 'GET') return baseFetch(url, opts);
      var id = Number(m[1]);
      var expected = pendingVersions[id] || null;
      var hit = cache.get(id);
      if (hit && expected && hit.version === expected) {
        // version가 같으면 서버의 다시 묻지 않고
        onProgress({ phase: 'cache' });
        return Promise.resolve(shimResponse(hit.buf));
      }
      return Promise.resolve()
        .then(function () { return baseFetch(url, opts); })
        .then(function (res) {
          if (!res || !res.ok || !res.body || typeof res.body.getReader !== 'function') {
            return res;
          }
          var total = 0;
          try {
            total = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
          } catch (e) {
            console.warn('Ignored error:', e);
            total = 0;
          }
          var reader = res.body.getReader();
          var chunks = [];
          var got = 0;
          onProgress({ phase: 'download', got: 0, total: total });
          function pump() {
            return reader.read().then(function (step) {
              if (step.done) {
                var buf = new ArrayBuffer(got);
                var view = new Uint8Array(buf);
                var off = 0;
                chunks.forEach(function (c) { view.set(c, off); off += c.byteLength; });
                if (expected) cacheSet(id, expected, buf);
                onProgress({ phase: 'parse' });
                return shimResponse(buf);
              }
              chunks.push(step.value);
              got += step.value.byteLength;
              onProgress({ phase: 'download', got: got, total: total });
              return pump();
            });
          }
          return pump();
        });
    }

    return {
      fetch: officeFetch,
      expectVersion: function (id, version) {
        pendingVersions[id] = version || null;
      },
      invalidate: function (id) {
        cache.delete(id);
      },
    };
  }

  var api = { createOfficeFetch: createOfficeFetch };
  if (typeof window !== 'undefined') window.MyHubOfficeFetch = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficeFetch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
