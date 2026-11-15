// 파인더 뷰어 포맷 보조 모듈 — PdfCraft 호스트 브리지 (finder-pdfcraft.js)
// PdfCraft(storytold/pdfcraft, MIT/Apache-2.0)의 상류에 임베드용 호스트
// 브리지가 내장돼 있다: iframe은 ?host=parent로 열면(동일 출처일 때만
// 활성) pdfcraft:ready/open/save/dirty/failed 메시지로 부모와 말한다.
// 자체 열기는 호스트 위임(pdfcraft:request-open)이 다운스트림 패치로
// 해결한다 — 엔진은 OS 선택기를 여는 대신 부모가 보관함 다이얼로 연다.
// 이 모듈은 그 지(호스트 층)만 맡는다 — iframe 생성·출처 검증·ready
// 워치독·메시지 정규화. 표면 전환(접기/펼치기·폴백)과 저장은
// finder-format-pdf.js가 ctx 계약(putContent/saveAsContent)으로 맡는다.
//
// 무게 대책: WASM은 raw 47MB라 Finder를 열 때 유휴 시간은 매니페스트의
// 진입 에셋을 미리 받아 둔다 (아래 prefetch). WASM은 에셋 상한(25MB)을
// 넘어 raw 조각 둘(.part0/.part1)로 올라가 있고 벤더 편의 loader.js가
// 받아 이어 붙인다 — 프리패치 대상도 그 조각들과 로더다.
// HTTP 캐시는 23MB 조각을 안 잡는다 (2026-11-15 실측: 동일 문서에서
// 즉시 다시 받아도 transferSize가 전문 크기 — 캐시 미적용). 그래서
// 부팅 게이트는 조각 바이트를 직접 모아 Blob URL로 엔진 iframe에
// 넘기고(쿼리 wasmPart0/wasmPart1, 로더가 네트워크 대신 받는다),
// CacheStorage에도 저장해 다음 부팅은 네트워크를 안 탄다.
// 파트 파일명이 콘텐츠 해시를 포함하므로 엔진 버전이 바뀌면 캐시
// 키도 바뀌어 오래된 조각은 자동 무효화된다 (고아는 prune이 치운다).
(function () {
  'use strict';

  var APP_URL = '/vendor/pdfcraft/index.html?host=parent';
  // 창 바 흡수는 URL (교정 노트 두, 2026-11-06 정리 두 캡처 image-145;
  // 앱 스트림 흡수는 귀속 노트, docs/pdfcraft-tabstrip-absorb-prereg-
  // 20261106.md): 엔진 모드 바의 두룸찓대를 꺾고(nomodetabs·nomenubar)
  // 앱 자체를 없하고(nomodebar), 문서 두 스트림까지 있다(notabstrip 두
  // 제목 표기는 창 바 하나로 내린다). 앱 스트림이 갇혀고 있던
  // 이후·열기 전환/기린는 전부 호스트이다
  // 엔진 메뉴(pdfcraft:menus-state / menu-command)가 소유한 앱
  // 전달 가능성 조회는 사전 등록 문서는 한글 정보이다. 메뉴는 두
  // 상단바고, 모드 등 창 두 번 클릭(office-tabs)도 소유한. 전환은
  // pdfcraft:mode, 상태는 pdfcraft:mode-state, 메뉴 정의·상태는
  // pdfcraft:menus-state, 메뉴 선택 실행은 pdfcraft:menu-command 앱
  // 전부 앱 엔진(c966e689)의 다운스트림 패치가 제공하는 표면이다.
  var APP_URL_HOSTED =
    '/vendor/pdfcraft/index.html?host=parent&chrome=nomodetabs,nomenubar,nomodebar,notabstrip';
  var MANIFEST_URL = '/vendor/pdfcraft/manifest.json';

  // 동적 로딩 URL은 공용 핼퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 — 버전 없는 URL은 immutable 캐시가 고정할 수 있다).
  // 핼퍼가 없는 환경(테스트 등)에서는 원본 URL 그대로이다.
  // 매니페스트에서 뽑은 진입 에셋은 해시 파일명이은 파일명 자체가
  // 버전이고, iframe은 요청한 URL과 같아야 캐시 타입이 오므로
  // 그쪽에는 붙이지 않는다 — 파일명이 고정된 매니페스트 자체만
  // 두 핼퍼를 거친다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }

  // 테스트가 주입할 수 있는 다음만 (스탠다론 경로는 기본값 그대로)
  var internals = {
    // ready 워치독: 콜드 기동(Blob URL에서 이어 붙인 47MB 컴파일)에
    // 느린 기기까지 기다린다.
    // 이 안에 ready가 없으면 호스트가 pdf.js 표면으로 남는다.
    // 워치독은 iframe src를 붙인 시점부터 돈다 (부팅 프리패치 시간은
    // 안 잡힌다 — Blob URL은 메모리에서 바로 읽히므로 ready가 수 초
    // 안에 온다).
    readyTimeoutMs: 45000,
    // 부팅 게이트 프리패치 재시도: 한 번의 시도가 멈춰도 두 번 더
    // 시도한다. 파일별 재시도(코어 maxAttempts)와 별개로, 전체
    // 프리패치 자체를 다시 돌리는 횟수다.
    bootMaxAttempts: 3,
    bootRetryDelayMs: 1000,
  };

  // save/open 메시지는 bytes가 ArrayBuffer가 내도, 뷰(Uint8Array 등)가
  // 내도 있다 — 뷰면 자기 구간만 정확히 복사해 ArrayBuffer로 정규화한다.
  // 정규화 본문은 공용 코어(craft-clipboard.js)가 맡는다 — 코어는
  // 이 파일보다 먼저 받아야 한다 (office.html 정적 순서·finder.js
  // 동적 import 체인). 코어가 없으면 바이트는 null로 정규화된다.
  var clipboardCore =
    typeof window !== 'undefined' ? window.MyHubCraftClipboard : null;
  if (!clipboardCore && typeof console !== 'undefined' && console.warn) {
    console.warn('[finder-pdfcraft] 코어(craft-clipboard.js)가 없어 바이트 정규화가 동작하지 않습니다');
  }
  var normalizeBytes = clipboardCore
    ? clipboardCore.normalizeBytes
    : function () {
        return null;
      };

  /**
   * PdfCraft iframe 세션을 만든다.
   * deps = { doc, win, parentEl, name?, url?, readyTimeoutMs?,
   *          fetchFn?, caches?, prefetchForBoot?, bootMaxAttempts?,
   *          bootRetryDelayMs?, stallTimeoutMs?, prefetchMaxAttempts?,
   *          prefetchRetryDelayMs?, createObjectURL?, revokeObjectURL?,
   *          Blob?, onBootProgress(p),
   *          onReady(version), onDirty(dirty),
   *          onSave({ name, saveAs, bytes }), onRequestOpen(),
   *          onModeState(mode), onMenusState(menus), onFallback(reason) }
   * 부팅 게이트 (2026-11-15): iframe src는 엔진 자산 프리패치가 끝난
   * 뒤에 붙이고, ready 워치독은 그 시점부터 돈다. 프리패치가 실패하면
   * bootMaxAttempts까지 재시도하고 전부 실패하면 onFallback에
   * 'prefetch-failed'로 간다. onBootProgress는 { receivedBytes,
   * filesDone, filesTotal, currentUrl, attempt, maxAttempts }를 받는다.
   * prefetchForBoot는 테스트 주입용 (없으면 모듈 prefetchForBoot).
   * 게이트가 모은 WASM 조각 바이트는 Blob URL로 바꿔 src 쿼리
   * (wasmPart0/wasmPart1)로 넘긴다 — 23MB 조각은 HTTP 캐시에 안
   * 남아 로더가 다시 받는 것을 막기 위함이다. Blob URL은 ready가
   * 오면(엔진이 init을 마쳤으므로) 해제하고, 폴백·destroy 때도
   * 해제한다. Blob URL을 못 만들면 쿼리 없이 부팅한다 (로더가
   * 네트워크에서 받으므로 느리지만 동작한다).
   * onRequestOpen은 엔진이 자체 열기가 호스트로 위임한 것이다
   * (pdfcraft:request-open 앱 엔진 host_open 패치). 표면은 호스트
   * 열기 경로로 고른 파일을 open()으로 다시 내려보내면 하고,
   * 취소하면 아무것도 보내지 않는다.
   * onFallback은 ready 워치독 초과('timeout')와 pdfcraft:failed에서
   * 최대 두 번만 부른다 이 호스트는 그때 이 세션을 destroy하고 pdf.js
   * 표면으로 남으면 된다 (폴백 보존의 계약).
   * @returns {{ frame, open(name, buffer), sendMode(mode), sendMenuCommand(command, params?), destroy(), isReady() }}
   */
  function createHost(deps) {
    deps = deps || {};
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || !deps.parentEl) return null;
    var origin =
      deps.origin || (win.location && win.location.origin) || '';
    var readyTimeoutMs =
      typeof deps.readyTimeoutMs === 'number' ? deps.readyTimeoutMs : internals.readyTimeoutMs;

    // UI 언어는 한국어로 고정한다. 앱의 Auto 판정은 navigator.languages를
    // 따르는데, 브라우저·밸런스 보고 언어가 영어로 굳으면 카탈로그가
    // 97% 번역돼 있어도 표면 전체가 영어로 뜬다 (사용자 실측 2026-11-04).
    // 앱의 eframe 스토리지 두 'pdfcraft'도 JSON "language"를 맥 붙은
    // 적용하므로, 프레임을 만들기 전에 호스트(동일 출처)가 ko를 뜬다.
    // 기존 prefs는 다른 설정은 그대로 보존한다.
    seedKoreanLanguage(win);

    function seedKoreanLanguage(w) {
      var store = null;
      try {
        store = w.localStorage;
      } catch (storeErr) {
        // 스토리지를 못 두는 환경에서는 서도 없이 두 자동 판정을 맞바꾼
        store = null;
      }
      if (!store) return false;
      var prefsObj = {};
      var rawPrefs = null;
      try {
        rawPrefs = store.getItem('pdfcraft');
      } catch (readErr) {
        rawPrefs = null;
      }
      if (rawPrefs) {
        try {
          prefsObj = JSON.parse(rawPrefs) || {};
        } catch (parseErr) {
          prefsObj = {};
        }
      }
      if (prefsObj.language === 'ko') return true;
      prefsObj.language = 'ko';
      try {
        store.setItem('pdfcraft', JSON.stringify(prefsObj));
      } catch (writeErr) {
        // 쓰기 실패(합환·차단) 한 언어만 자동 판정으로 내고 넣기
        // 자체는 낸다 것이 계약이라 호스트는 계속 진행한다
        return false;
      }
      return true;
    }

    var fetchFn =
      deps.fetchFn ||
      (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);

    // Blob URL 핸드오프용 API (테스트 주입 가능 — 없으면 win에서 해결).
    var createObjectURL =
      typeof deps.createObjectURL === 'function'
        ? deps.createObjectURL
        : win.URL && typeof win.URL.createObjectURL === 'function'
          ? win.URL.createObjectURL.bind(win.URL)
          : null;
    var revokeObjectURL =
      typeof deps.revokeObjectURL === 'function'
        ? deps.revokeObjectURL
        : win.URL && typeof win.URL.revokeObjectURL === 'function'
          ? win.URL.revokeObjectURL.bind(win.URL)
          : null;
    var BlobCtor =
      deps.Blob || win.Blob || (typeof Blob !== 'undefined' ? Blob : null);

    var frame = doc.createElement('iframe');
    frame.className = 'fv-frame fv-pdfcraft-frame';
    if (deps.name) frame.title = deps.name;
    // 같은 출처의 자체 앱 페이지는 두 sheet.html·pdf.js 뷰어와 같은 최소
    // 조건(스크립트 실행 + 동일 출처 자산 로딩·origin 검증 통과) (gate-74).
    // allow-modals는 인쇄 정보를 필수 조건이다: 엔진의 브라우저 인쇄가
    // 자기 문서 두 합체 프레임을 window.print()를 부르는데, 이 조건이
    // 없으면 브라우저가 그 노출을 조용히 무시한다("Ignored call to
    // 'print()'. The document is sandboxed앱" 두 프로브 실측 2026-11-06).
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
    // src는 부팅 프리패치가 끝난 뒤에 붙인다 (아래 runBootPrefetch) —
    // iframe이 47MB를 직접 받으면 45초 워치독이 먼저 터진다. 요소는
    // 동기 생성해야 호출부가 host.frame을 즉시 쓸 수 있다.
    deps.parentEl.appendChild(frame);

    var ready = false;
    var dead = false;
    var fallbackFired = false;

    // 게이트가 모은 조각 바이트로 만든 Blob URL — ready·폴백·destroy
    // 때 해제한다 (엔진이 init을 마치면 로더의 fetch는 끝났으므로
    // ready 이후에는 메모리를 잡고 있을 이유가 없다).
    var partBlobUrls = [];
    function revokePartBlobs() {
      if (!partBlobUrls.length) return;
      var urls = partBlobUrls;
      partBlobUrls = [];
      if (!revokeObjectURL) return;
      urls.forEach(function (u) {
        try {
          revokeObjectURL(u);
        } catch (e) {
          // 해제 실패는 생명주기 버그의 신호이므로 기록한다
          // (관문 23: 빈 catch 금지).
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[finder-pdfcraft] Blob URL 해제 실패', e);
          }
        }
      });
    }

    // ready 워치독은 iframe src를 붙인 시점부터 돈다 — 프리패치
    // 시간은 워치독에 안 잡힌다 (Blob URL은 메모리에서 바로 읽히므로
    // ready가 수 초 안에 온다).
    var timer = null;
    function startWatchdog() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (!ready) fireFallback('timeout');
      }, readyTimeoutMs);
    }

    // 부팅 게이트 프리패치 (2026-11-15): 엔진 자산을 먼저 받아
    // CacheStorage를 데우고 조각 바이트를 모은 뒤 iframe을 띄운다.
    // 실패하면 재시도하고, 전부 실패하면 폴백('prefetch-failed')으로
    // 간다 — 단발 폴백 대신 재시도 후 최종 실패 시에만 폴백하는 것이
    // 계약이다. 게이트가 모은 조각 바이트는 Blob URL로 바꿔 src 쿼리로
    // 넘긴다 (HTTP 캐시는 23MB 조각을 안 잡는다 — 로더가 네트워크에서
    // 다시 받는 것을 막기 위함).
    var bootAttempts = 0;
    var bootMaxAttempts =
      typeof deps.bootMaxAttempts === 'number' ? deps.bootMaxAttempts : internals.bootMaxAttempts;
    var bootRetryDelayMs =
      typeof deps.bootRetryDelayMs === 'number' ? deps.bootRetryDelayMs : internals.bootRetryDelayMs;
    function runBootPrefetch() {
      if (dead) return;
      bootAttempts += 1;
      var bootFn =
        typeof deps.prefetchForBoot === 'function' ? deps.prefetchForBoot : prefetchForBoot;
      bootFn({
        fetchFn: fetchFn,
        win: win,
        caches: deps.caches,
        stallTimeoutMs: deps.stallTimeoutMs,
        maxAttempts: deps.prefetchMaxAttempts,
        retryDelayMs: deps.prefetchRetryDelayMs,
        onProgress: function (p) {
          if (typeof deps.onBootProgress === 'function') {
            deps.onBootProgress({
              receivedBytes: p.receivedBytes,
              filesDone: p.filesDone,
              filesTotal: p.filesTotal,
              currentUrl: p.currentUrl,
              attempt: bootAttempts,
              maxAttempts: bootMaxAttempts,
            });
          }
        },
      })
        .then(function (r) {
          if (dead) return;
          var src = deps.url || APP_URL;
          if (r && Array.isArray(r.partBytes) && r.partBytes.length && createObjectURL && BlobCtor) {
            try {
              partBlobUrls = r.partBytes.map(function (b) {
                return createObjectURL(new BlobCtor([b], { type: 'application/wasm' }));
              });
              var sep = src.indexOf('?') === -1 ? '?' : '&';
              src +=
                sep +
                partBlobUrls
                  .map(function (u, i) {
                    return 'wasmPart' + i + '=' + encodeURIComponent(u);
                  })
                  .join('&');
            } catch (e) {
              // Blob URL 생성 실패 시 쿼리 없이 기존 경로로 부팅한다 —
              // 로더가 네트워크에서 받으므로 느리지만 동작한다.
              revokePartBlobs();
            }
          }
          frame.src = src;
          startWatchdog();
        })
        .catch(function () {
          if (dead) return;
          if (bootAttempts < bootMaxAttempts) {
            setTimeout(runBootPrefetch, bootRetryDelayMs);
          } else {
            fireFallback('prefetch-failed');
          }
        });
    }
    runBootPrefetch();

    function fireFallback(reason) {
      if (dead || fallbackFired) return;
      fallbackFired = true;
      clearTimeout(timer);
      revokePartBlobs();
      if (typeof deps.onFallback === 'function') deps.onFallback(reason);
    }

    function onMessage(e) {
      if (!e || e.origin !== origin) return;
      if (frame.contentWindow && e.source && e.source !== frame.contentWindow) return;
      var d = e.data || {};
      if (typeof d.type !== 'string' || d.type.indexOf('pdfcraft:') !== 0) return;
      if (d.type === 'pdfcraft:ready') {
        ready = true;
        clearTimeout(timer);
        // 엔진이 init을 마쳤으므로 로더의 Blob fetch는 끝났다 —
        // 47MB Blob을 여기서 해제한다.
        revokePartBlobs();
        if (typeof deps.onReady === 'function') deps.onReady(d.version);
      } else if (d.type === 'pdfcraft:dirty') {
        if (typeof deps.onDirty === 'function') deps.onDirty(!!d.dirty);
      } else if (d.type === 'pdfcraft:request-open') {
        if (typeof deps.onRequestOpen === 'function') deps.onRequestOpen();
      } else if (d.type === 'pdfcraft:mode-state') {
        // 엔진의 현재 모드 두 오피스 상단 모드 두의 동기를 맞춘
        // (방송 작업 2).
        if (typeof deps.onModeState === 'function') {
          deps.onModeState(typeof d.mode === 'string' ? d.mode : '');
        }
      } else if (d.type === 'pdfcraft:menus-state') {
        // 엔진 메뉴 트리(항목·체크·비활성 상태 포함) 두 오피스 상단
        // 메뉴와 동기를 맞춘. 엔진의 바는 때만 보내므로 그대로
        // 넣으면 낸다.
        if (typeof deps.onMenusState === 'function') {
          deps.onMenusState(Array.isArray(d.menus) ? d.menus : []);
        }
      } else if (d.type === 'pdfcraft:save') {
        if (typeof deps.onSave === 'function') {
          deps.onSave({
            name: typeof d.name === 'string' ? d.name : '',
            saveAs: !!d.saveAs,
            bytes: normalizeBytes(d.bytes),
          });
        }
      } else if (d.type === 'pdfcraft:failed') {
        fireFallback('failed' + (d.error ? ': ' + String(d.error) : ''));
      }
    }
    win.addEventListener('message', onMessage);

    return {
      frame: frame,
      isReady: function () {
        return ready && !dead;
      },
      // ready 뒤에 문서를 연다. buffer는 소유권이 넘어가므로(detach)
      // 호출자가 다시 쓸 수 없는 복사본을 내게 낸다 (fetchContent 계약).
      open: function (name, buffer) {
        if (!ready || dead || !frame.contentWindow || !buffer) return false;
        frame.contentWindow.postMessage(
          { type: 'pdfcraft:open', name: name, bytes: buffer },
          origin,
          [buffer],
        );
        return true;
      },
      // 오피스 상단 모드 두의 클릭을 엔진으로 전달한다 (방송 작업 2).
      // 모르는 모드 id는 엔진은 무시한다.
      sendMode: function (mode) {
        if (!ready || dead || !frame.contentWindow || !mode) return false;
        frame.contentWindow.postMessage(
          { type: 'pdfcraft:mode', mode: String(mode) },
          origin,
        );
        return true;
      },
      // 오피스 상단 메뉴의 항목 선택을 엔진으로 전달한다. params는
      // 항목을 잡고 있는 매개변수 객체(최근 열기·문서 목록의 index,
      // 패널 이름 등) 두 없으면 보내지 않는다. 엔진은 자기 메뉴 클릭과
      // 같은 경로로 실행한다.
      sendMenuCommand: function (command, params) {
        if (!ready || dead || !frame.contentWindow || !command) return false;
        var msg = { type: 'pdfcraft:menu-command', command: String(command) };
        if (params && typeof params === 'object') msg.params = params;
        frame.contentWindow.postMessage(msg, origin);
        return true;
      },
      destroy: function () {
        if (dead) return;
        dead = true;
        clearTimeout(timer);
        revokePartBlobs();
        win.removeEventListener('message', onMessage);
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      },
    };
  }

  // 프리패치 공용 코어(craft-prefetch-core.js) — drain·체인·발견·
  // once·부팅 게이트를 맡는다. 코어는 이 파일보다 먼저 받아야 한다
  // (office.html 정적 순서·finder.js 동적 import 체인). 코어가
  // 없으면 프리패치를 조용히 건너뛴다 (프리패치는 최적화일 뿐).
  var warnedMissingCore = false;
  function getPrefetchCore() {
    var core =
      typeof window !== 'undefined' ? window.MyHubCraftPrefetchCore : null;
    if (!core && !warnedMissingCore) {
      warnedMissingCore = true;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          '[finder-pdfcraft] 코어(craft-prefetch-core.js)가 없어 프리패치를 건너뜁니다'
        );
      }
    }
    return core;
  }

  // WASM 조각 CacheStorage 이름 — HTTP 캐시는 23MB 조각을 안 잡지만
  // CacheStorage는 큰 엔트리에도 제한이 없다 (2026-11-15 실측 근거).
  var PART_CACHE_NAME = 'myhub-pdfcraft-parts';
  // 백그라운드 프리패치 once 플래그 (코어 createPrefetch와 같은 이름 —
  // 래퍼 테스트가 고정한다).
  var BG_PREFETCH_FLAG = '__myhubPdfcraftPrefetched';

  function getCaches(deps) {
    deps = deps || {};
    if (deps.caches) return deps.caches;
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    return win && win.caches ? win.caches : null;
  }

  // CacheStorage 키는 절대 URL로 통일한다 (상대 URL은 환경마다 해석이
  // 달라 match/put이 어긋날 수 있다).
  function absUrl(url, win) {
    try {
      var base = win && win.location && win.location.href;
      if (base && typeof URL !== 'undefined') return new URL(url, base).href;
    } catch (e) {
      // 해석 실패 시 원본 URL을 키로 쓴다 (폴백 값 반환).
      return url;
    }
    return url;
  }

  // 조각 바이트를 CacheStorage에 저장한다. 저장 실패(용량·차단)는
  // 부팅과 무관하므로 조용히 무시한다 — 다음 부팅은 네트워크로 간다.
  // 저장 완료를 기다리는 Promise를 돌려준다 (절대 거절하지 않는다) —
  // 게이트가 끝날 때 저장이 끝나 있어야 다음 부팅이 캐시를 탄다.
  function storePart(cachesObj, absolute, bytes) {
    try {
      var ResponseCtor = typeof Response !== 'undefined' ? Response : null;
      if (!ResponseCtor) return Promise.resolve();
      return cachesObj
        .open(PART_CACHE_NAME)
        .then(function (cache) {
          return cache.put(absolute, new ResponseCtor(bytes));
        })
        .catch(function () {
          // 저장 실패는 무시한다 (다음 부팅은 네트워크로 간다).
          return undefined;
        });
    } catch (e) {
      // 동기 실패(생성자 없음 등)도 무시한다.
      return Promise.resolve();
    }
  }

  // 현재 버전의 조각이 아닌 캐시 항목(오래된 버전의 고아)을 치운다.
  // 실패해도 게이트는 계속된다.
  function prunePartCache(cachesObj, keepAbsolutes) {
    return Promise.resolve()
      .then(function () {
        return cachesObj.open(PART_CACHE_NAME);
      })
      .then(function (cache) {
        return cache.keys().then(function (keys) {
          var dels = [];
          keys.forEach(function (req) {
            var u = typeof req === 'string' ? req : req && req.url;
            if (u && keepAbsolutes.indexOf(u) === -1) dels.push(cache.delete(req));
          });
          return Promise.all(dels);
        });
      })
      .catch(function () {
        // 정리 실패는 무시한다 (고아가 남는 것이 부팅을 막지는 않는다).
        return undefined;
      });
  }

  // 같은 조각을 동시에 받는 호출이 47MB를 두 번 받지 않게, 진행 중인
  // 로드를 URL별로 공유한다 (백그라운드 프리패치와 부팅 게이트가 같은
  // 문서에서 겹치는 경우). 완료·실패 후에는 항목을 지운다.
  var partInFlight = {};
  function loadPartBytes(core, fetchFn, cachesObj, url, win, opts, onFileProgress) {
    var absolute = absUrl(url, win);
    if (partInFlight[absolute]) {
      return partInFlight[absolute].then(function (bytes) {
        // 공유된 로드 — 완료 시 전체 크기로 한 번 보고한다 (호출부
        // 누적과 일치; 스트리밍 보고는 원본 로드가 맡았다).
        onFileProgress(bytes.byteLength);
        return bytes;
      });
    }
    var p = loadPartBytesOnce(core, fetchFn, cachesObj, url, absolute, opts, onFileProgress);
    partInFlight[absolute] = p;
    var cleanup = function () {
      if (partInFlight[absolute] === p) delete partInFlight[absolute];
    };
    p.then(cleanup, cleanup);
    return p;
  }

  function loadPartBytesOnce(core, fetchFn, cachesObj, url, absolute, opts, onFileProgress) {
    function fromNetwork() {
      return core
        .fetchWithProgress(fetchFn, url, {
          stallTimeoutMs: opts.stallTimeoutMs,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          setTimeoutFn: opts.setTimeoutFn,
          clearTimeoutFn: opts.clearTimeoutFn,
          collectBody: true,
          onProgress: function (p) {
            onFileProgress(p.receivedBytes);
          },
        })
        .then(function (r) {
          var bytes = r.body || new Uint8Array(0);
          if (!cachesObj) return bytes;
          // 저장이 끝나야 바이트를 넘긴다 — 그래야 게이트가 끝난
          // 직후의 다음 부팅도 캐시를 탄다.
          return storePart(cachesObj, absolute, bytes).then(function () {
            return bytes;
          });
        });
    }
    function fromCache() {
      // 캐시 조회 자체는 절대 거절하지 않는다 — 실패하면 null로
      // 네트워크 폴백한다 (fromNetwork의 거절은 그대로 전파돼야 한다).
      if (!cachesObj) return Promise.resolve(null);
      return Promise.resolve()
        .then(function () {
          return cachesObj.open(PART_CACHE_NAME);
        })
        .then(function (cache) {
          return cache.match(absolute);
        })
        .then(function (res) {
          return res ? res.arrayBuffer() : null;
        })
        .catch(function () {
          return null;
        });
    }
    return fromCache().then(function (buf) {
      if (buf) {
        var bytes = new Uint8Array(buf);
        onFileProgress(bytes.byteLength);
        return bytes;
      }
      return fromNetwork();
    });
  }

  /**
   * 백그라운드 프리패치: 매니페스트를 읽어 진입 에셋을 미리 받는다.
   * 부팅 게이트(prefetchForBoot)와 같은 경로로 받아 CacheStorage를
   * 채우므로, 유휴 시간에 데워 두면 첫 PDF 열기도 네트워크를 안 탄다
   * (구 경로는 HTTP 캐시를 데웠는데 23MB 조각은 거기 안 남아 47MB를
   * 버리는 다운로드였다). 실패는 조용히 무시한다 — 프리패치는
   * 최적화일 뿐이다. deps = { fetchFn, win, caches } (테스트 주입용).
   * 단일 wasm(47MB)은 받지 않고 wasmParts만 받는다 (로더가 파트를
   * 이어 붙인다 — 단일 wasm까지 받으면 47MB를 더 받는 회귀다).
   * @returns {Promise<string[]>} 실제로 받은 URL 목록 (매니페스트 제외)
   */
  function prefetch(deps) {
    var core = getPrefetchCore();
    if (!core) return Promise.resolve([]);
    deps = deps || {};
    var fetchFn = getFetchFn(deps);
    if (!fetchFn) return Promise.resolve([]);
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    // once 플래그는 시작 전에 세운다 — 동시 호출이 이중 다운로드를
    // 못 하게 한다 (코어 createPrefetch와 같은 계약).
    if (win && win[BG_PREFETCH_FLAG]) return Promise.resolve([]);
    if (win) win[BG_PREFETCH_FLAG] = true;
    return prefetchForBoot(deps)
      .then(function (r) {
        return r.done;
      })
      .catch(function () {
        return [];
      });
  }

  function getFetchFn(deps) {
    deps = deps || {};
    if (typeof deps.fetchFn === 'function') return deps.fetchFn;
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    return win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null;
  }

  // 부팅 게이트용 프리패치 (2026-11-15): 매니페스트를 읽어 진입 에셋을
  // 매니페스트 순서대로 진행 보고와 함께 받는다. WASM 조각은 바이트를
  // 모아 돌려준다 (createHost가 Blob URL로 바꿔 엔진에 넘긴다 — HTTP
  // 캐시는 23MB 조각을 안 잡는다). 조각은 CacheStorage에서 먼저 찾고
  // 없으면 네트워크로 받아 저장한다. 작은 파일(js·loader·snippets)은
  // 본문을 버리고 받기만 한다 (작은 파일은 HTTP 캐시가 잡는다).
  // 멈춘 파일이 남으면 reject한다. 백그라운드 프리패치와 달리 once
  // 플래그를 타지 않는다 — 백그라운드가 중간에 실패했어도 부팅 때는
  // 다시 받아야 한다.
  // deps = { fetchFn, win, caches, onProgress, stallTimeoutMs,
  //          maxAttempts, retryDelayMs, setTimeoutFn, clearTimeoutFn }.
  // @returns {Promise<{done, failed, stalled, receivedBytes, partBytes}>}
  //   done은 받은 URL 목록(매니페스트 순서), partBytes는 wasmParts
  //   순서의 Uint8Array 배열이다.
  function prefetchForBoot(deps) {
    var core = getPrefetchCore();
    var empty = { done: [], failed: [], stalled: [], receivedBytes: 0, partBytes: [] };
    if (!core) return Promise.resolve(empty);
    var fetchFn = getFetchFn(deps);
    if (!fetchFn) return Promise.resolve(empty);
    deps = deps || {};
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    var cachesObj = getCaches(deps);
    var opts = {
      stallTimeoutMs: deps.stallTimeoutMs,
      maxAttempts: deps.maxAttempts,
      retryDelayMs: deps.retryDelayMs,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    };
    return core
      .fetchWithProgress(fetchFn, versionedAssetUrl(MANIFEST_URL), {
        stallTimeoutMs: opts.stallTimeoutMs,
        maxAttempts: opts.maxAttempts,
        retryDelayMs: opts.retryDelayMs,
        setTimeoutFn: opts.setTimeoutFn,
        clearTimeoutFn: opts.clearTimeoutFn,
        collectBody: true,
      })
      .then(function (r) {
        var text = '';
        if (r.body) {
          try {
            text = new TextDecoder().decode(r.body);
          } catch (e) {
            text = '';
          }
        }
        var man = JSON.parse(text);
        // 단일 wasm(47MB)은 받지 않고 wasmParts만 받는다 (로더가
        // 파트를 이어 붙인다 — 단일 wasm까지 받으면 47MB를 더 받는
        // 회귀이니 호출부 테스트가 고정한다).
        var urls = core.manifestAssetUrls('/vendor/pdfcraft/', man, {
          wasmParts: true,
          snippets: true,
          loader: true,
        });
        var partNames = Array.isArray(man.wasmParts) ? man.wasmParts : [];
        var partUrls = partNames.map(function (n) {
          return '/vendor/pdfcraft/' + n;
        });
        var partSet = {};
        partUrls.forEach(function (u) {
          partSet[u] = true;
        });
        var onProgress = deps.onProgress;
        var filesTotal = urls.length;
        var receivedTotal = 0;
        var filesDone = 0;
        var done = [];
        var failed = [];
        var stalled = [];
        var partBytesByUrl = {};
        function report(currentUrl, fileReceived) {
          if (typeof onProgress !== 'function') return;
          onProgress({
            receivedBytes: receivedTotal + (fileReceived || 0),
            filesDone: filesDone,
            filesTotal: filesTotal,
            currentUrl: currentUrl,
          });
        }
        var chain = Promise.resolve();
        urls.forEach(function (u) {
          chain = chain.then(function () {
            if (partSet[u]) {
              return loadPartBytes(core, fetchFn, cachesObj, u, win, opts, function (fileReceived) {
                report(u, fileReceived);
              })
                .then(function (bytes) {
                  partBytesByUrl[u] = bytes;
                  done.push(u);
                  receivedTotal += bytes.byteLength;
                  filesDone += 1;
                  report(u, 0);
                })
                .catch(function (err) {
                  // 파트는 엔진 부팅에 필수 — 실패하면 게이트 전체가
                  // 실패한다 (재시도는 createHost의 부팅 루프가 맡는다).
                  var msg = err && err.message ? String(err.message) : String(err);
                  if (msg.indexOf('stall timeout') === 0) {
                    throw new Error('PdfCraft 자산을 받지 못했습니다 (멈춤: ' + u + ')');
                  }
                  throw err;
                });
            }
            return core
              .fetchWithProgress(fetchFn, u, {
                stallTimeoutMs: opts.stallTimeoutMs,
                maxAttempts: opts.maxAttempts,
                retryDelayMs: opts.retryDelayMs,
                setTimeoutFn: opts.setTimeoutFn,
                clearTimeoutFn: opts.clearTimeoutFn,
                onProgress: function (p) {
                  report(u, p.receivedBytes);
                },
              })
              .then(function (r) {
                done.push(u);
                receivedTotal += r.receivedBytes;
                filesDone += 1;
                report(u, 0);
              })
              .catch(function (err) {
                // 작은 파일은 실패해도 부팅을 막지 않는다 (기존 계약) —
                // 단, 멈춘 파일이 남으면 게이트가 최종 실패한다.
                var msg = err && err.message ? String(err.message) : String(err);
                if (msg.indexOf('http ') === 0) failed.push(u);
                else stalled.push(u);
                filesDone += 1;
                report(u, 0);
              });
          });
        });
        return chain.then(function () {
          if (stalled.length) {
            throw new Error('PdfCraft 자산을 받지 못했습니다 (멈춤: ' + stalled.join(', ') + ')');
          }
          var partBytes = partUrls
            .map(function (u) {
              return partBytesByUrl[u];
            })
            .filter(function (b) {
              return !!b;
            });
          // 오래된 버전의 파트를 CacheStorage에서 치운다 (버전마다
          // 47MB가 고아로 남지 않게). 정리 실패는 부팅과 무관하다.
          var pruned =
            cachesObj && partUrls.length
              ? prunePartCache(
                  cachesObj,
                  partUrls.map(function (u) {
                    return absUrl(u, win);
                  }),
                )
              : Promise.resolve();
          return pruned.then(function () {
            return {
              done: done,
              failed: failed,
              stalled: stalled,
              receivedBytes: receivedTotal,
              partBytes: partBytes,
            };
          });
        });
      });
  }

  var api = {
    createHost: createHost,
    prefetch: prefetch,
    prefetchForBoot: prefetchForBoot,
    normalizeBytes: normalizeBytes,
    internals: internals,
    APP_URL: APP_URL,
    APP_URL_HOSTED: APP_URL_HOSTED,
    MANIFEST_URL: MANIFEST_URL,
  };
  if (typeof window !== 'undefined') window.MyHubFinderPdfCraft = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 자동 프리패치: 두 모듈이 정적으로 로드하는 문서(finder.html·
  // office.html)에서만 알고, 문서는 한 번, 유효 시간은 있다. 데이터
  // 예약 모드에서는 건너뛴다 (36MB가 전송을 강요하지 않는다).
  // 오피스 표면에서는 앱 게이트로 건너뛴다 — 게이트·예약은 코어가 맡는다.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    var prefetchCore = getPrefetchCore();
    if (prefetchCore) prefetchCore.scheduleAutoBoot(prefetch);
  }
})();
