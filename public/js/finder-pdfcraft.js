// 파인더 뷰어 형식 보조 모듈 — PdfCraft 호스트 브리지 (finder-pdfcraft.js)
// PdfCraft(storytold/pdfcraft, MIT/Apache-2.0)의 상류에 임베드용 호스트
// 브리지가 내장돼 있다: iframe은 ?host=parent로 열면(동일 출처일 때만
// 활성) pdfcraft:ready/open/save/dirty/failed 메시지로 부모와 말한다.
// 자체 열기는 호스트 귀결(pdfcraft:request-open)이 다운스트림 합치로
// 해결한다 — 엔진은 OS 선택기를 여는 대신 부모가 보관함 다이얼로 연다.
// 이 모듈은 그 판(호스트 층)만 맡는다 — iframe 생성·출처 검증·eady
// 위치끈·찓서 정규화. 서면 전환(삽기/삽치기·덮밥)과 저장
// finder-format-pdf.js가 ctx 계약(putContent/saveAsContent)으로 맡는다.
//
// 무겁게 문제: WASM은 raw 36MB를 Finder열 때 유효 시간은 매니 호스트의
// 진입 자산을 미리 받아 둔다 (아래 prefetch). WASM은 자산 상한(25MB)을
// 넘어 raw 조각 둘(.part0/.part1)로 올라가 있고 벤더 쪽이 loader.js가
// 받아 이어 붙인다 — 프리패치 상대도 그 조각들과 로더이다.
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
  // 전부 앱 엔진(c966e689)의 다운스트림 합치가 제공하는 서면이다.
  var APP_URL_HOSTED =
    '/vendor/pdfcraft/index.html?host=parent&chrome=nomodetabs,nomenubar,nomodebar,notabstrip';
  var MANIFEST_URL = '/vendor/pdfcraft/manifest.json';

  // 동적 로딩 URL은 공용 핼퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 — 버전 없는 URL은 immutable 캐시가 고정할 수 있다).
  // 핼퍼가 없는 환경(테스트 등)에서는 원본 URL 그대로이다.
  // 매니호스트에서 뽑은 진입 자산은 캐시 파일명이은 파일명 자체가
  // 버전이고, iframe은 요청한 URL과 같아야 캐시 타입이 오므로
  // 그밖에는 붙이지 않는다 — 파일명이 고정된 매니호스트 자체만
  // 두 핼퍼를 거친다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }

  // 테스트가 주입할 수 있는 다음만 (스탠다론 경로는 기본값 그대로)
  var internals = {
    // ready 위치끈: 코드 기동(전송+36MB 컴파일)이 마른 기계까지 기다린다.
    // 한 안에 ready가 없으면 호스트가 pdf.js 서면으로 낸다.
    readyTimeoutMs: 45000,
  };

  // save/open 메시지는 bytes가 ArrayBuffer가 내도, 뷰(Uint8Array 등)가
  // 내도 있다 — 뷰면 자기 구간만 정확히 복사해 ArrayBuffer로 정규화한다.
  function normalizeBytes(bytes) {
    if (!bytes) return null;
    if (bytes instanceof ArrayBuffer) return bytes;
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(bytes)) {
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice().buffer;
    }
    return null;
  }

  /**
   * PdfCraft iframe 세션을 만든다.
   * deps = { doc, win, parentEl, name?, url?, readyTimeoutMs?,
   *          onReady(version), onDirty(dirty),
   *          onSave({ name, saveAs, bytes }), onRequestOpen(),
   *          onModeState(mode), onMenusState(menus), onFallback(reason) }
   * onRequestOpen은 엔진이 자체 열기가 호스트로 귀결한 것이다
   * (pdfcraft:request-open 앱 엔진 host_open 합치). 서면은 호스트
   * 열기 경로로 고른 파일을 open()으로 다시 내려보내면 하고,
   * 취소하면 아무것도 보내지 않는다.
   * onFallback은 ready 위치끈 초과('timeout')와 pdfcraft:failed에서
   * 최대 두 번만 부른다 이 호스트는 그때 이 세션을 destroy하고 pdf.js
   * 서면으로 합치며 낸다 (폴백 보존의 계약).
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
    // 97% 번역돼 있어도 서면 전체가 영어로 뜬다 (사용자 실측 2026-11-04).
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
    frame.src = deps.url || APP_URL;
    deps.parentEl.appendChild(frame);

    var ready = false;
    var dead = false;
    var fallbackFired = false;

    var timer = setTimeout(function () {
      if (!ready) fireFallback('timeout');
    }, readyTimeoutMs);

    function fireFallback(reason) {
      if (dead || fallbackFired) return;
      fallbackFired = true;
      clearTimeout(timer);
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

  var prefetchImpl = null;

  /**
   * 매니호스트를 읽어 진입 자산(JS 글루·ASM·온라인)을 미리 받는다.
   * HTML은 Worker가 no-store로 주므로 데울 수 없이 상체에서는 제외.
   * 실패는 조용히 무시한다 — 프리패치는 최적화일 뿐, 못 데우면 넣기가
   * 두 두 그대로 넣으면 낸다. deps = { fetchFn, win } (테스트 주입용).
   * 단일 wasm(47MB)은 받지 않고 wasmParts만 받는다 (로더가 파트를
   * 이어 붙인다 — 단일 wasm까지 받으면 47MB를 더 받는 회귀다).
   * @returns {Promise<string[]>} 실제로 받은 URL 목록
   */
  function prefetch(deps) {
    var core = getPrefetchCore();
    if (!core) return Promise.resolve([]);
    if (!prefetchImpl) {
      prefetchImpl = core.createPrefetch({
        flag: '__myhubPdfcraftPrefetched',
        discover: function (fetchFn) {
          return fetchFn(versionedAssetUrl(MANIFEST_URL))
            .then(function (res) {
              if (!res || !res.ok) throw new Error('manifest http ' + (res && res.status));
              return res.json();
            })
            .then(function (man) {
              return core.manifestAssetUrls('/vendor/pdfcraft/', man, {
                wasmParts: true,
                snippets: true,
                loader: true,
              });
            });
        },
      });
    }
    return prefetchImpl(deps);
  }

  var api = {
    createHost: createHost,
    prefetch: prefetch,
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
  // 오피스 서면에서는 앱 게이트로 건너뛴다 — 게이트·예약은 코어가 맡는다.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    var prefetchCore = getPrefetchCore();
    if (prefetchCore) prefetchCore.scheduleAutoBoot(prefetch);
  }
})();
