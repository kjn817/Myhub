/* MyHub 동적 로딩 에셋 버전 부착 (asset-url.js) 등 N-06 (2026-11-05)
 *
 * 배: 경 배포 시 버전(deploy_full.py부착 createVersioner)의 HTML은
 * 직접 참조 하는 정적 에셋에만. JS붙는다 가 실행 import()중에fetch와
 * 불러오는 자산(형식 모듈 벤더ASM라이브러리)은 버전 없는
 * URL로 나가고, Worker는 버전 없는 정적 응답에도 immutable 1년 캐시를
 * 붙이므로(src/index.ts) 배포 전에는 구버전이 고정될 수 있었다 등
 * 2026-11-01 "배포했는데 화면 그림" 사고의 잔존 경로다.
 *
 * 이 헬퍼가 그 경로를 닫는다. 동적 로딩 지점의 전부
 * window.MyHubAssetUrl(url)로 거쳐 URL를 만든다:
 * - 파일 집합은 scripts/static-assets.json(manifest)에 등록한 에셋 중
 *   동적 로딩되는 것들이다 (아래 DYNAMIC_ASSETS 는 테스트가 manifest와
 *   대조해 드리프트를 막는다). 집합에 없는 로컬 경로는 버전을 붙이지
 *   않고 경고를 남긴다 (미등록 에셋 값).
 * - 버전 값은 이 파일 자체의 <script> URL에서 읽는다. 호스트 HTML이
 *   배포 시 버전을 붙인 파일(versioned)이라 그 태그의 쿼리가 배포
 *   버전을 알려 온다. 못 찾으면(로컬 정적 서빙 등) 원본 URL를 그림으로
 *   알려주고 경고를 남긴 뒤 기능은 앞의 대관의 지 않는다.
 * - 이미 쿼리가 있는 URL는 & 로 이어 붙이고, 이미 버전이 있다면
 *   그대로 둔다 (멱등).
 *
 * 의도적으로 버전이 붙지 않는 것 (tests/asset-url-dynamic.test.ts가
 * 고정한다):
 * - HTML 문서 URL: Worker는 no-store로 서빙해 고정 경로가 없다.
 * - 벤더 엔 진의 다시 파(deckcraft일명gridcraft에셋pdfcraft 글루
 *   WASM): 파일명 자체가 콘텐츠 버전이고, 프리패치와 iframe이 실제로
 *   요 URL청한 과 바이트 단위로 URL같은 를 써야 쿼리를 붙이면
 *   캐시 파편이 숨긴다. 이 그 목록을 주는 manifest.json 자체의
 *   파일 명이 고정이라 헬퍼를 거친다.
 * - /api/* 등 에 URL: 셋이 아니다.
 *
 * 노출: window.MyHubAssetUrl (함수; .version/.DYNAMIC_ASSETS/
 * .createAssetUrl 속성 포함), Node 테스트용 module.exports.
 */
(function () {
  'use strict';

  // 동적 로딩 지점이 실제로 부르는 manifest 등록 에셋 (정한
  // scripts/static-assets.json 의 여기에 그 부분집합의 고정인 나열이고,
  // tests/asset-url-dynamic.test.ts가 답으로 대조해 드리프트를 막는다).
  var DYNAMIC_ASSETS = [
    '/fonts/BIZUDPGothic-Regular.ttf',
    '/fonts/DancingScript.ttf',
    '/fonts/Inter-Bold.ttf',
    '/fonts/Inter-Italic.ttf',
    '/fonts/Inter-Medium.ttf',
    '/fonts/Inter-Regular.ttf',
    '/fonts/Inter-SemiBold.ttf',
    '/fonts/JetBrainsMono-Regular.ttf',
    '/fonts/NanumGothic-Bold.ttf',
    '/fonts/NanumGothic-Regular.ttf',
    '/js/deckcraft-prefetch.js',
    '/js/finder-deckcraft.js',
    '/js/finder-format-doc.js',
    '/js/finder-format-hwp.js',
    '/js/finder-format-pdf.js',
    '/js/finder-format-sheet.js',
    '/js/finder-format-slide.js',
    '/js/finder-format-text.js',
    '/js/finder-pdf-ops.js',
    '/js/finder-pdfcraft.js',
    '/js/gridcraft-prefetch.js',
    '/templates/blank.hwpx',
    '/templates/blank.pdf',
    '/vendor/deckcraft/manifest.json',
    '/vendor/jszip.min.js',
    '/vendor/kordoc/kordoc.js',
    '/vendor/mammoth.browser.min.js',
    '/vendor/pdf-lib/pdf-lib.esm.min.js',
    '/vendor/dompurify/3.4.17/purify.min.js',
    '/vendor/pdfcraft/manifest.json',
    '/vendor/rhwp-editor/index.js',
    '/vendor/rhwp/rhwp.js',
    '/vendor/rhwp/rhwp_bg.wasm',
    '/vendor/xlsx.full.min.js',
  ];
  var ASSET_SET = {};
  DYNAMIC_ASSETS.forEach(function (p) {
    ASSET_SET[p] = true;
  });

  /**
   * 버전 부착 함수를 만든다 (순수 함수 테스트 주요 지연).
   * opts = { version, warn? } 기본 warn설정의 없으면 console.warn로 이룬다.
   */
  function createAssetUrl(opts) {
    opts = opts || {};
    var version = typeof opts.version === 'string' ? opts.version : '';
    var warnFn =
      typeof opts.warn === 'function'
        ? opts.warn
        : function (msg) {
            if (typeof console !== 'undefined' && console.warn) console.warn(msg);
          };
    var warned = {};
    function warnOnce(key, msg) {
      if (warned[key]) return;
      warned[key] = true;
      warnFn(msg);
    }
    return function assetUrl(url) {
      if (typeof url !== 'string' || !url) return url;
      // 절대경로 로컬참조만 대상이다 상대 (프로토콜 상대 상대경로의 원본유지)
      if (url.charAt(0) !== '/' || url.charAt(1) === '/') return url;
      var hashIdx = url.indexOf('#');
      var hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
      var noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
      var qIdx = noHash.indexOf('?');
      var path = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
      var query = qIdx >= 0 ? noHash.slice(qIdx + 1) : '';
      if (path === '/api' || path.indexOf('/api/') === 0) return url;
      if (!ASSET_SET[path]) {
        warnOnce('unregistered:' + path, '[asset-url] manifest 미등록 에셋이라 버전을 붙이지 않습니다: ' + path);
        return url;
      }
      if (/(^|&)v=/.test(query)) return url; // 이미 버전이 있다 (멱등)
      if (!version) {
        warnOnce('noversion', '[asset-url] 배포 버전을 찾지 못해 버전을 붙이지 않습니다: ' + path);
        return url;
      }
      return path + (query ? '?' + query + '&' : '?') + 'v=' + version + hash;
    };
  }

  /** URL 문자열에서 배포 버전 쿼리 값을 뽑는다 (없으면 ''). */
  function versionFromUrl(u) {
    if (!u) return '';
    var s = String(u);
    var qIdx = s.indexOf('?');
    if (qIdx < 0) return '';
    var query = s.slice(qIdx + 1).split('#')[0];
    var parts = query.split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq > 0 && parts[i].slice(0, eq) === 'v') return parts[i].slice(eq + 1);
    }
    return '';
  }

  /**
   * 이 페이지의 배포 버전을 찾는다: 명시 전역 등 등 스크립트 자체의
   * URL 중 문서 등 다른 script/link URL 전부. 배포 등 같은 버 전을
   * 받으므로 어느 것에서 읽어와 같다.
   */
  function detectVersion(win, doc) {
    if (win && win.__MYHUB_ASSET_VER__) return String(win.__MYHUB_ASSET_VER__);
    if (doc) {
      if (doc.currentScript && doc.currentScript.src) {
        var own = versionFromUrl(doc.currentScript.src);
        if (own) return own;
      }
      if (typeof doc.querySelectorAll === 'function') {
        var nodes = doc.querySelectorAll('script[src], link[href]');
        for (var i = 0; i < nodes.length; i++) {
          var v = versionFromUrl(nodes[i].src || nodes[i].href || '');
          if (v) return v;
        }
      }
    }
    return '';
  }

  var api = null;
  if (typeof window !== 'undefined') {
    var doc = typeof document !== 'undefined' ? document : null;
    var version = detectVersion(window, doc);
    if (version && !window.__MYHUB_ASSET_VER__) window.__MYHUB_ASSET_VER__ = version;
    api = createAssetUrl({ version: version });
    api.version = version;
    api.DYNAMIC_ASSETS = DYNAMIC_ASSETS.slice();
    api.createAssetUrl = createAssetUrl;
    api.detectVersion = detectVersion;
    window.MyHubAssetUrl = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createAssetUrl: createAssetUrl,
      detectVersion: detectVersion,
      versionFromUrl: versionFromUrl,
      DYNAMIC_ASSETS: DYNAMIC_ASSETS.slice(),
    };
  }
})();
