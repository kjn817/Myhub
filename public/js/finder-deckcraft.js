// 파인더 뷰어 포맷 보조 모듈 — DeckCraft 호스트 브리지 (finder-deckcraft.js)
// DeckCraft(storytold/deckcraft, MIT/Apache-2.0)의 앱 빌드를 MyHub
// 다운스트림 패치(Stage C)로 임베드용 호스트 브리지를 갖는다: iframe은
// ?host=parent&chrome=notitlebar&lang=ko 로 열면 deckcraft:ready/open/
// save/dirty/failed/fonts/request-save/exec 메시지로 부모와 말한다
// (이론 apps/deckcraft-web/src/host.rs가 정본). 이 모듈은 그 지(호스트
// 층)만 맡는다 — iframe 생성·출처 검증·ready 워치독·exec 태그 관리·
// 폰트 전달·메시지 정규화. 표면 전환(접기/펼치기·폴백)과 저장은
// finder-format-slide.js가 ctx 계약(putContent/saveAsContent)으로 맡는다.
//
// 무게 대책: WASM은 수십 MB라 Finder를 열 때 유휴 시간은 매니페스트의
// 진입 에셋을 미리 받아 둔다 (아래 prefetch — PdfCraft와 같은 방식).
// DeckCraft WASM은 raw 21.5MB로 에셋 상한(25MB) 미만이라 단일본을
// 그대로 서빙한다. 상한을 넘는 경우는 이법이 PdfCraft처럼 raw를 조각
// 내는 것이다 — Worker가 Content-Encoding을 직접 찍는 흡수는 CF
// 넣는 이중 인코더으로 깨짐이 실측 정정된 적도 않는다.
(function () {
  'use strict';

  // Drive 파일 API 베이스 경로 (S5-4, 5-9) — constants.js 선행 로드.
  var constants =
    (typeof window !== 'undefined' && window.MyHubConstants) ||
    (typeof globalThis !== 'undefined' && globalThis.MyHubConstants) ||
    null;
  if (!constants) throw new Error('[finder-deckcraft.js] constants.js가 먼저 로드되어야 합니다');

  var APP_URL = '/vendor/deckcraft/index.html?host=parent&chrome=notitlebar&lang=ko';
  // 엔진 내장 탭 복원 (2026-11-06 오후 정합): 엔진 리본 탭 행은
  // 호스트가 그리고, 기본 URL은 엔진 탭을 유지한다.
  var MANIFEST_URL = '/vendor/deckcraft/manifest.json';

  // 동적 로딩 URL은 공용 핼퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 — 버전 없는 URL은 immutable 캐시가 고정할 수 있다).
  // 핼퍼가 없는 환경(테스트 등)에서는 원본 URL 그대로이다.
  // 매니페스트에서 뽑은 진입 에셋은 해시 파일명이은 파일명 자체가
  // 버전이고, iframe은 요청한 URL과 같아야 캐시 타입이 오므로
  // 그쪽에는 붙이지 않는다 — 파일명이 고정된 매니페스트 자체는
  // 번호붙 폰트 fetch만 두 핼퍼를 거친다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }

  // 발표 전체를 알려주는 두값만 문서 주소으로 취급한다 — 그 두 이름
  // (PDF·PNG 같은 내보내기)는 사용자가 앱 안에서 요청한 다운로드가
  // 호스트가 브라우저 다운로드로 내린다 (host.rs의 PRESENTATION_EXTS의
  // 같은 집합의 정합).
  function isPresentationName(name) {
    return /\.(pptx|deckcraft)$/i.test(String(name || ''));
  }

  // DeckCraft 다이얼로그 저장 형식의 MIME (ODF의 mimetype 엔트리에 상주).
  var DECKCRAFT_NATIVE_MIME = 'application/vnd.storyteller.deckcraft+zip';

  function bytesToLatin1(u8, start, end) {
    var s = '';
    for (var i = start; i < end; i += 8192) {
      s += String.fromCharCode.apply(
        null,
        u8.subarray(i, Math.min(end, i + 8192)),
      );
    }
    return s;
  }

  // 두값 바이트의 실제 형식은 이름이 아닌 ZIP 구조로 판정한다 (E-5).
  // 엔진 exec의 file.save/file.saveBytes는 다이얼로그 형식을 현재 파일
  // 이름(.pptx)으로 발송하므로, 이름만 미우면 python-pptx로 열 수 없는
  // 다이얼로그 zip을 .pptx로 저장된. 형식 경로(request-save)는 진짜
  // PPTX를 대로 앱 판정을 통과한다.
  // 반환: 'pptx' | 'deckcraft' | 'unknown'
  // - 다이얼로그: 첫 엔트리 mimetype(무압축 상주)가 DECKCRAFT_NATIVE_MIME,
  //   또는 presentation.json 엔트리 (ppt/ 트리가 없을 때)
  // - PPTX(OOXML): ppt/ 트리 엔트리 (ppt/presentation.xml 등)
  function sniffDeckFormat(bytes) {
    var buf = normalizeBytes(bytes);
    if (!buf) return 'unknown';
    var u8 = new Uint8Array(buf);
    if (u8.length < 4 || u8[0] !== 0x50 || u8[1] !== 0x4b) return 'unknown';
    var view = new DataView(buf);
    var names = [];
    var storedMime = null;
    var off = 0;
    while (off + 30 <= u8.length && names.length < 256) {
      if (view.getUint32(off, true) !== 0x04034b50) break;
      var flags = view.getUint16(off + 6, true);
      var method = view.getUint16(off + 8, true);
      var compSize = view.getUint32(off + 18, true);
      var nameLen = view.getUint16(off + 26, true);
      var extraLen = view.getUint16(off + 28, true);
      var nameStart = off + 30;
      if (nameStart + nameLen > u8.length) break;
      var name = bytesToLatin1(u8, nameStart, nameStart + nameLen);
      names.push(name);
      var dataStart = nameStart + nameLen + extraLen;
      if (name === 'mimetype' && method === 0 && dataStart + compSize <= u8.length) {
        storedMime = bytesToLatin1(u8, dataStart, dataStart + compSize).replace(/\s+$/, '');
      }
      // 데이터 디스크립터가 있으면 두 엔트리의 데이터 길이를 헤더만으로
      // 두 수 없어 거르기를 멈춘다 (아래 자산 스캔의 나머지를 멈춘다).
      if ((flags & 0x08) !== 0 && compSize === 0) break;
      off = dataStart + compSize;
    }
    var hasPptTree = names.some(function (n) {
      return n.indexOf('ppt/') === 0;
    });
    var hasPresentationJson = names.indexOf('presentation.json') >= 0;
    if (storedMime === DECKCRAFT_NATIVE_MIME) return 'deckcraft';
    if (hasPptTree) return 'pptx';
    if (hasPresentationJson) return 'deckcraft';
    // 거르기가 발생 생략 경우도 보안: 파일명과 mimetype 문자열의 중앙
    // 디렉토리로도 행로로 합하면 전체에서 찾는다.
    var raw = bytesToLatin1(u8, 0, u8.length);
    if (raw.indexOf(DECKCRAFT_NATIVE_MIME) >= 0) return 'deckcraft';
    if (raw.indexOf('ppt/presentation.xml') >= 0) return 'pptx';
    if (raw.indexOf('presentation.json') >= 0) return 'deckcraft';
    return 'unknown';
  }

  // 테스트가 주입할 수 있는 다음만 (스탠다론 경로는 기본값 그대로)
  var internals = {
    // ready 워치독: 수십 MB 전송+컴파일과 WebGPU/WebGL 초기화가 겹친
    // 콜드 기동까지 기다린다. 이 안에 ready가 없으면 호스트는 최소
    // 리더 표면이 남는다 (폴백 보존의 계약).
    readyTimeoutMs: 60000,
    execTimeoutMs: 20000,
  };

  // 번호붙 한글 폴백 폰트 (나눔고딕, SIL OFL 1.1 앱 public/fonts/
  // NanumGothic-OFL.txt). 엔진(FontDb)은 wasm 페이지 집합는 한글
  // 글리프가 없어(내장 Ubuntu Light뿐, craft-fonts 미포함 빌드), Drive
  // '폰트' 폴더가 비었거나 로드에 실패하면 슬라이드 한글 텍스트가
  // 영원히 .notdef 영어로 낸다 — UI는 OS 폰트를 빌려 그릴만 슬라이드
  // 렌더링는 그렇 뿐 없다 (2026-11-05 실측). 그래서 Drive 페이지도
  // 별개로 두 폴백을 항상 함께 넣는다 가: cascade불러올 "수 페이지 중
  // 그 클러스터를 그리는 것"을 찾으므로, 요청 폰트가 그리는 길이는
  // 그대로 요청 폰트가 열고 한글만 폴백을 멈춘다. 순서는 Drive
  // 페이지 앱(사용자 폰트 우선), 바이트는 google/fonts 공식 저장소의
  // 미수 원본이다 (Reserved Font Name이라 수정·서브텀 금지).
  var FALLBACK_FONTS = [
    { family: 'NanumGothic', weight: 400, style: 'normal', url: '/fonts/NanumGothic-Regular.ttf' },
    { family: 'NanumGothic', weight: 700, style: 'normal', url: '/fonts/NanumGothic-Bold.ttf' },
  ];
  internals.fallbackFonts = FALLBACK_FONTS;

  // 두 넣을 번호붙 폰트 목록: MyHubFonts가 있으면 공용 앱
  // (POOL_FACES 앱 오피스 프로그램 내장 폰트 모음, fonts.js가 정합)앱
  // 연고, 없을 때만 앱 한글 폴백 텍스트로 최소 보장한다. 두 안에는
  // NanumGothic 획이 같은 순서(맥 앱)는 들어 있어 한글 보장이 같다.
  function poolSpecs(fontsDep) {
    var pool = fontsDep && fontsDep.POOL_FACES;
    if (Array.isArray(pool) && pool.length) return pool;
    return FALLBACK_FONTS;
  }
  internals.poolSpecs = poolSpecs;

  // fetchFn+목록 단위로 한 번만 받는 폴백 바이트 캐시 (Uint8Array로
  // 잡고 있는가 보낸 때만 복사한다 — postMessage transfer가 원본을
  // detach하므로 캐시를 그대로 남기면 두 번째 전송이 빈 껍데기가 낸다).
  var fallbackCache = new WeakMap();
  var fontBytesWarned = false;
  function loadFallbackFonts(fetchFn, specs) {
    if (!fetchFn) return Promise.resolve([]);
    var list = Array.isArray(specs) && specs.length ? specs : FALLBACK_FONTS;
    var key = list
      .map(function (s) {
        return s.url;
      })
      .join('|');
    var byKey = fallbackCache.get(fetchFn);
    if (!byKey) {
      byKey = new Map();
      fallbackCache.set(fetchFn, byKey);
    }
    var hit = byKey.get(key);
    if (hit) return hit;
    // fetch 본문은 fonts.js의 loadFontBytes 공용본문(F-L10)을 쓴다 —
    // fonts.js는 정적 태그라 이 모듈보다 항상 먼저 뜬다.
    var loader =
      (typeof window !== 'undefined' &&
        window.MyHubFonts &&
        window.MyHubFonts.loadFontBytes) ||
      (typeof globalThis !== 'undefined' &&
        globalThis.MyHubFonts &&
        globalThis.MyHubFonts.loadFontBytes) ||
      null;
    var p;
    if (typeof loader === 'function') {
      p = loader(fetchFn, list, 'fallback').then(function (loaded) {
        return loaded.filter(Boolean);
      });
    } else {
      if (!fontBytesWarned) {
        fontBytesWarned = true;
        console.warn('[finder-deckcraft] fonts.js(loadFontBytes)가 없어 폴백 폰트를 받지 않습니다');
      }
      p = Promise.resolve([]);
    }
    byKey.set(key, p);
    return p;
  }

  // ---------- 클립보드 붙여넣기 (순수 핼퍼) ----------
  // 엔진(egui 앱)은 붙여넣기 이미지를 생길까지 전달하지 않는다
  // (2026-11-05 실측 앱 PasteImage 이벤트가 앱 빌드에서는 삽입으로
  // 이어지지 않음). 호스트가 붙여넣기 이벤트에서 이미지 파일을
  // 가로채어 exec의 insert.picture 명령으로 삽입한다 (시트 브리지와
  // 같은 대조). 시트는 올린 앱(table) 작업이 없다 — 슬라이드
  // 붙여넣기에서 그림 파일을 곧 그림 삽입의 본래 동작이다.
  // 붙여넣기 헬퍼·바이트 정규화는 공용 코어(craft-clipboard.js)가
  // 맡는다 — 코어는 이 파일보다 먼저 받아야 한다 (office.html 정적
  // 순서·finder.js 동적 import 체인). 코어가 없으면 붙여넣기는
  // 조용히 건너뛴다 (파일이 없으면 null, 읽기는 실패로).
  var clipboardCore =
    typeof window !== 'undefined' ? window.MyHubCraftClipboard : null;
  if (!clipboardCore && typeof console !== 'undefined' && console.warn) {
    console.warn('[finder-deckcraft] 코어(craft-clipboard.js)가 없어 붙여넣기가 동작하지 않습니다');
  }
  var PASTE_MAX_BYTES =
    (clipboardCore && clipboardCore.PASTE_MAX_BYTES) || 32 * 1024 * 1024;
  var isFormFieldTarget = clipboardCore
    ? clipboardCore.isFormFieldTarget
    : function () {
        return false;
      };
  var pasteImageFile = clipboardCore
    ? clipboardCore.pasteImageFile
    : function () {
        return null;
      };
  var fileToBase64 = clipboardCore
    ? clipboardCore.fileToBase64
    : function () {
        return Promise.reject(new Error('파일을 읽지 못했습니다'));
      };
  var normalizeBytes = clipboardCore
    ? clipboardCore.normalizeBytes
    : function () {
        return null;
      };

  /**
   * DeckCraft iframe 세션을 만든다.
   * deps = { doc, win, parentEl, name?, url?, readyTimeoutMs?,
   *          fonts?, fetchFn?,
   *          onReady(version), onDirty(dirty),
   *          onPrint({ name, bytes }),
   *          onSave({ name, presentation, format, bytes }),
   *          onSaveFailed(error), onFontsApplied(faces),
   *          onPasteImageError(message),
   *          onRequestOpen(purpose, request),
   *          onRibbonState({ tab, collapsed, tabs }),
   *          onFallback(reason) }
   * onRequestOpen은 엔진의 파일 선택이 호스트에 위임한 것이다
   * (deckcraft:request-open 앱 파일열기는 찾아보기 그림/오디오/비디오
   * 삽입·테마 찾아보기). 표면은 보관함 피커로 고른 파일을
   * answerPick(request, name, buffer)으로 알려주고, 취소는 무응답이
   * 기본 계약이라 답을 보내지 않으면 된다 (명시 취소는 cancelPick).
   * onFallback은 ready 워치독 초과('timeout')와 deckcraft:failed에서
   * 최대 두 번만 불린다 이 호스트는 그때 이 세션을 destroy하고 최소
   * 리더 표면으로 남으면 된다 (폴백 보존의 계약).
   * @returns {{ frame, open(name, buffer), requestSave(),
   *   answerPick(request, name, buffer), cancelPick(request),
   *   exec(commands), pushFonts(), destroy(), isReady() } | null}
   */
  function createHost(deps) {
    deps = deps || {};
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    var win = deps.win || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || !deps.parentEl) return null;
    var origin = deps.origin || (win.location && win.location.origin) || '';
    var readyTimeoutMs =
      typeof deps.readyTimeoutMs === 'number' ? deps.readyTimeoutMs : internals.readyTimeoutMs;
    var execTimeoutMs =
      typeof deps.execTimeoutMs === 'number' ? deps.execTimeoutMs : internals.execTimeoutMs;

    var fetchFn =
      deps.fetchFn ||
      (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
    var fonts = deps.fonts !== undefined ? deps.fonts : typeof window !== 'undefined' ? window.MyHubFonts || null : null;
    // 폴백 폰트 풀(11MB)은 문서 load 이후에 받기 시작한다 (성능 5라운드,
    // 2026-11-13). 브릿지 생성 즉시 받으면 느린 네트워크에서 문서 자체의
    // 로딩을 가로막는다 (실측: Fast 3G에서 PowerPoint 로딩 23.2s — 폰트
    // 11MB + WASM 22MB가 1.6Mbps 회선을 포화). load 이후에 시작해도 엔진
    // 부팅(수십 MB 전송·컴파일)보다 먼저 도착하므로, ready 직후 pushFonts가
    // 기다리지 않고 바로 넣을 수 있다. load가 이미 끝난 상태면 즉시 받는다.
    function prefetchPoolFonts() {
      loadFallbackFonts(fetchFn, poolSpecs(fonts));
    }
    if (doc.readyState === 'complete') {
      prefetchPoolFonts();
    } else if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('load', prefetchPoolFonts, { once: true });
    } else {
      prefetchPoolFonts();
    }

    var frame = doc.createElement('iframe');
    frame.className = 'fv-frame fv-deckcraft-frame';
    if (deps.name) frame.title = deps.name;
    // 같은 출처의 자체 앱 페이지는 두 sheet.html·PdfCraft뷰어와 같은 최소
    // 조건(스크립트 실행 + 동일 출처 자산 로딩·origin 검증 통과) (gate-74).
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = deps.url || APP_URL;
    deps.parentEl.appendChild(frame);

    var ready = false;
    var dead = false;
    var fallbackFired = false;
    var execSeq = 0;
    var execWaiters = {}; // tag -> {resolve}

    var timer = setTimeout(function () {
      if (!ready) fireFallback('timeout');
    }, readyTimeoutMs);

    function fireFallback(reason) {
      if (dead || fallbackFired) return;
      fallbackFired = true;
      clearTimeout(timer);
      if (typeof deps.onFallback === 'function') deps.onFallback(reason);
    }

    function post(msg, transfer) {
      if (dead || !frame.contentWindow) return false;
      frame.contentWindow.postMessage(msg, origin, transfer || []);
      return true;
    }

    // 비서 연산 채널은 내부 실행부 (반환 객체의 exec의 붙여넣기 삽입을
    // 공유한다): deck 명령 [{id, params}]을 한 번에 실행하고
    // [{ok, result|error}] 배열로 알려준다.
    function runExec(commands) {
      if (!ready || dead) return Promise.reject(new Error('넣기가 아직 준비되지 않았습니다'));
      execSeq += 1;
      var tag = 'myhub-' + execSeq;
      return new Promise(function (resolve, reject) {
        var settled = false;
        var to = setTimeout(function () {
          if (settled) return;
          settled = true;
          delete execWaiters[tag];
          reject(new Error('넣기가 응답이 없습니다'));
        }, execTimeoutMs);
        execWaiters[tag] = function (results) {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          resolve(results);
        };
        if (!post({ type: 'deckcraft:exec', tag: tag, commands: commands || [] })) {
          clearTimeout(to);
          delete execWaiters[tag];
          reject(new Error('넣기가 아직 준비되지 않았습니다'));
        }
      });
    }

    // ---------- 클립보드 이미지 붙여넣기 ----------
    // 붙여넣기가 포커스 있는 문서에서만 발생한다. 엔진 iframe 문서
    // (캔버스 포커스)는 여기에 넣고, 표면 문서(뷰어 크롬)는 표면
    // 모듈(finder-format-slide)과 같은 exec로 직접 삽입한다.
    var pasteDoc = null;
    var pasteTimers = [];

    function reportPasteError(message) {
      if (typeof deps.onPasteImageError === 'function') deps.onPasteImageError(message);
    }

    function insertPastedFile(file) {
      if (!file || !ready || dead) return;
      if (file.size > PASTE_MAX_BYTES) {
        reportPasteError('이미지가 너무 큽니다 (32MB 초과)');
        return;
      }
      var ReaderCtor =
        (win && win.FileReader) || (typeof FileReader !== 'undefined' ? FileReader : null);
      if (!ReaderCtor) {
        reportPasteError('이미지를 읽지 못했습니다');
        return;
      }
      fileToBase64(file, ReaderCtor)
        .then(function (b64) {
          if (dead) return null;
          if (!b64) throw new Error('이미지를 읽지 못했습니다');
          return runExec([
            {
              id: 'insert.picture',
              params: { name: file.name || 'clipboard.png', data: b64 },
            },
          ]);
        })
        .then(function (results) {
          if (!results) return;
          var r = results[0];
          if (!r || !r.ok) reportPasteError((r && r.error) || '이미지 삽입에 실패했습니다');
        })
        .catch(function (err) {
          reportPasteError((err && err.message) || '이미지 삽입에 실패했습니다');
        });
    }

    function onPasteEvent(e) {
      if (isFormFieldTarget(e && e.target)) return;
      var file = pasteImageFile(e && e.clipboardData);
      if (!file) return;
      // 그림 파일은 본래 삽입물이면 두 엔진과 같은 붙여넣기를 다시
      // 처리하지 않게 여기서 막는다.
      e.preventDefault();
      e.stopPropagation();
      insertPastedFile(file);
    }

    // 엔진 iframe 문서는 캡처 리스너 낸다. 문서가 교체되면(다시
    // 로드) 전원이 확인한 앱 문서를 다시 낸다.
    function tryAttachPaste() {
      if (dead) return;
      var fdoc = null;
      try {
        fdoc = frame.contentDocument;
      } catch (err) {
        fdoc = null;
      }
      if (!fdoc || pasteDoc === fdoc) return;
      pasteDoc = fdoc;
      fdoc.addEventListener('paste', onPasteEvent, true);
    }
    frame.addEventListener('load', tryAttachPaste);
    [300, 900, 2000, 4500].forEach(function (ms) {
      pasteTimers.push(setTimeout(tryAttachPaste, ms));
    });

    // 폰트 적용 직후 플래이아의 신뢰: 폰트 도착 전에 배치한 위형은 벤더가
    // 레이아웃을 무효화하지 않아 .notdef 영어로 낸다 (2026-11-04 실측 앱
    // 창 리사이즈·넣기 진입 같은 플래이아가 고체가 있어도 한글 글리프가
    // 나타난다). iframe 앱을 느낀 화면이 앱이 리사이즈 경로(플래이아를)를
    // 서면한. 길이를 앱이 두 프레임을 실제로 번역 해야 하므로 원복을
    // 정교게 부른다 (rAF 한 번으로 내리면 앱이 중간 길이를 못 보고
    // 합게한 버퍼인 것을 실측으로 확인). 원복 두 플래이아껏이 한 번 두
    // 일어난 최종 크기+적용된 폰트로 배치가 확정된다.
    // 폰트 적용 직후 세션당 1회: exec로 줌을 한 단계 올렸다가 별도
    // exec로 곧바로 창 맞춤(fit)으로 되돌려, 엔진이 텍스트를 현재
    // 폰트로 다시 shaping하게 한다. 폰트 도착 전에 배치된 텍스트
    // (새 문서의 플레이스홀더 등)는 .notdef로 고정돼 있어 위의 재배치
    // 넛지(리사이즈)로는 풀리지 않지만, 줌 배율이 실제로 바뀌는
    // 프레임에서는 엔진이 다시 그리는 것을 실측으로 확인했다
    // (2026-11-10, ppt-korean-fix 프로브). 두 명령을 한 exec 배치로
    // 묶으면 최종 줌이 원래 값과 같아져 엔진이 무효화를 건너뛰므로
    // 반드시 별도 exec로 나눠 보내야 한다. 최종 상태는 처음과 같은
    // 창 맞춤이고 문서·dirty·선택·포커스는 건드리지 않는다.
    var zoomNudgeDone = false;
    function nudgeZoomReshape() {
      if (dead || zoomNudgeDone || !ready) return;
      zoomNudgeDone = true;
      runExec([{ id: 'view.zoomIn', params: {} }])
        .catch(function () {
          return null;
        })
        .then(function () {
          if (dead) return null;
          return runExec([{ id: 'view.fit', params: {} }]).catch(function () {
            return null;
          });
        });
    }

    var nudgePending = false;
    function nudgeRelayout() {
      if (dead || nudgePending || !frame) return;
      nudgePending = true;
      // width/height가 아닌 max-width/max-height로 캡을 건다 — 프레임
      // flex 아이템이 너비·높이에 드러난 width/height가 적용하는 것을
      // 실측으로 확인한다 (캡은 flex는 못 서는것).
      frame.style.maxWidth = 'calc(100% - 8px)';
      frame.style.maxHeight = 'calc(100% - 8px)';
      setTimeout(function () {
        nudgePending = false;
        if (dead) return;
        frame.style.maxWidth = '';
        frame.style.maxHeight = '';
      }, 300);
    }

    // Drive '폰트' 폴더의 페이지도 deckcraft:fonts로 받에 넣는다
    // (sheet-gridcraft.js의 GridCraft 폰트 흐름과 같은 배선 앱 페이지
    // 목록은 window.MyHubFonts가 만들고, 바이트는 Drive 콘텥츠 API로
    // 받는다). 번호붙 폰트(poolSpecs 앱 공용 앱, MyHubFonts가 없으면 한글
    // 폴백 앱)도 Drive 페이지가 없어도 항상 뒤에 붙여 보낸다 — 폴더가
    // 비었거나 Drive가 실패한 전에도 슬라이드 한글이 .notdef로 한
    // 않게 하는 최소 보장이다. 폰트 실패는 넣기를 막지 않는다.
    function driveFaces() {
      if (!fonts || typeof fonts.whenReady !== 'function' || !fetchFn) {
        return Promise.resolve([]);
      }
      return fonts
        .whenReady(4000)
        .then(function () {
          var faces = typeof fonts.faces === 'function' ? fonts.faces() : [];
          return Promise.all(
            faces.map(function (face) {
              return fetchFn(constants.DRIVE_FILES_API + '/' + face.fileId + '/content')
                .then(function (res) {
                  if (!res || !res.ok) throw new Error('font fetch failed');
                  return res.arrayBuffer();
                })
                .then(function (bytes) {
                  return {
                    family: face.family,
                    weight: face.weight,
                    style: face.style,
                    bytes: bytes,
                  };
                })
                .catch(function () {
                  return null;
                });
            }),
          ).then(function (list) {
            return list.filter(Boolean);
          });
        })
        .catch(function () {
          return []; // Drive 실패가 폴백까지 막지 않는다
        });
    }

    function pushFonts() {
      if (!ready || dead) return Promise.resolve(0);
      if (!fetchFn) return Promise.resolve(0);
      return Promise.all([driveFaces(), loadFallbackFonts(fetchFn, poolSpecs(fonts))])
        .then(function (both) {
          var usable = both[0].concat(
            both[1].map(function (f) {
              return {
                family: f.family,
                weight: f.weight,
                style: f.style,
                bytes: f.u8.slice().buffer, // 캐시 복사에서 보낸다 (transfer detach)
              };
            }),
          );
          if (!usable.length) return 0;
          var transfer = usable.map(function (f) {
            return f.bytes;
          });
          return post({ type: 'deckcraft:fonts', fonts: usable }, transfer) ? usable.length : 0;
        })
        .catch(function () {
          return 0; // 폰트 실패는 넣기를 막지 않는다
        });
    }

    function onMessage(e) {
      if (!e || e.origin !== origin) return;
      if (frame.contentWindow && e.source && e.source !== frame.contentWindow) return;
      var d = e.data || {};
      if (typeof d.type !== 'string' || d.type.indexOf('deckcraft:') !== 0) return;
      if (d.type === 'deckcraft:ready') {
        ready = true;
        clearTimeout(timer);
        tryAttachPaste();
        if (typeof deps.onReady === 'function') deps.onReady(d.version);
        // 폰트는 ready 직후 한 번 받에 넣는다 — 문서가 열린 뒤에
        // 도착해도 앱이 UI 폰트를 새로 빌리고 본문을 즉시 다시 그린다.
        pushFonts();
      } else if (d.type === 'deckcraft:print') {
        // 인쇄 전용 채널 (인쇄 정본): backstage 인쇄·app.print가 만든
        // 인쇄는 PDF는 앱 저장도 다운로드는 아니라, 표면은 남은 프레임
        // 으로 시스템 인쇄 대화상자를 여는 것이 유일한 때비 방식이다.
        if (typeof deps.onPrint === 'function') {
          deps.onPrint({
            name: typeof d.name === 'string' ? d.name : '',
            bytes: normalizeBytes(d.bytes),
          });
        }
      } else if (d.type === 'deckcraft:dirty') {
        if (typeof deps.onDirty === 'function') deps.onDirty(!!d.dirty);
      } else if (d.type === 'deckcraft:save') {
        if (typeof deps.onSave === 'function') {
          var saveBytes = normalizeBytes(d.bytes);
          deps.onSave({
            name: typeof d.name === 'string' ? d.name : '',
            presentation: isPresentationName(d.name),
            // E-5: 이름(확장자)과 별개로 실제 바이트 형식을 함께 내린다 한
            // 때문에 동기한 저장을 막을 수 있게.
            format: sniffDeckFormat(saveBytes),
            bytes: saveBytes,
          });
        }
      } else if (d.type === 'deckcraft:save-failed') {
        if (typeof deps.onSaveFailed === 'function') {
          deps.onSaveFailed(d.error ? String(d.error) : '');
        }
      } else if (d.type === 'deckcraft:request-open') {
        if (typeof deps.onRequestOpen === 'function') {
          deps.onRequestOpen(
            typeof d.purpose === 'string' ? d.purpose : '',
            typeof d.request === 'number' ? d.request : 0,
          );
        }
      } else if (d.type === 'deckcraft:ribbon-state') {
        // 엔진 리본 상태(선택 앱·접수·보는 앱 목록) 두 오피스 상단
        // 앱 행의 동기를 맞춘 (방송 작업 2).
        if (typeof deps.onRibbonState === 'function') {
          deps.onRibbonState({
            tab: typeof d.tab === 'string' ? d.tab : '',
            collapsed: !!d.collapsed,
            tabs: Array.isArray(d.tabs) ? d.tabs : [],
          });
        }
      } else if (d.type === 'deckcraft:fonts-applied') {
        nudgeRelayout();
        nudgeZoomReshape();
        if (typeof deps.onFontsApplied === 'function') {
          deps.onFontsApplied(typeof d.faces === 'number' ? d.faces : 0);
        }
      } else if (d.type === 'deckcraft:exec-result') {
        var waiter = typeof d.tag === 'string' ? execWaiters[d.tag] : null;
        if (waiter) {
          delete execWaiters[d.tag];
          waiter(Array.isArray(d.results) ? d.results : []);
        }
      } else if (d.type === 'deckcraft:failed') {
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
        if (!ready || dead || !buffer) return false;
        return post({ type: 'deckcraft:open', name: name, bytes: buffer }, [buffer]);
      },
      // 호스트 저장 버튼의 경로: 답 deckcraft:save(발표) 또는
      // deckcraft:save-failed로 낸다.
      requestSave: function () {
        if (!ready || dead) return false;
        return post({ type: 'deckcraft:request-save' });
      },
      // deckcraft:request-open의 저장 두: 고른 파일 바이트를 기다리는
      // 엔진 요청(request id)은 그대로 꽂는다. buffer는 소유권이
      // 넘어가므로(detach) 호출자가 다시 쓸 수 없는 복사본을 내게 낸다 (open과 같은 계약).
      answerPick: function (request, name, buffer) {
        if (!ready || dead || !buffer) return false;
        return post(
          { type: 'deckcraft:picked', request: request, name: name || '', bytes: buffer },
          [buffer],
        );
      },
      // 명시한 취소 답 두 엔진의 남기 요청을 정리한다. 표면은 무응답
      // 취소를 생해와 계약의 문제는 없다 (엔진에 답 없는 요청은
      // 그냥 남겨 두며, id는 재사용되지 않는다).
      cancelPick: function (request) {
        if (!ready || dead) return false;
        return post({ type: 'deckcraft:pick-cancelled', request: request });
      },
      // 비서 연산 채널: deck 명령 [{id, params}]을 한 번에 실행하고
      // [{ok, result|error}] 배열로 알려준다. 응답이 없으면 빈 배열은
      // 아닌 명시적으로 reject한다 (호출자가 무응답을 구분하게).
      exec: function (commands) {
        return runExec(commands);
      },
      pushFonts: pushFonts,
      destroy: function () {
        if (dead) return;
        dead = true;
        clearTimeout(timer);
        pasteTimers.forEach(function (t) {
          clearTimeout(t);
        });
        pasteTimers = [];
        frame.removeEventListener('load', tryAttachPaste);
        if (pasteDoc) {
          pasteDoc.removeEventListener('paste', onPasteEvent, true);
          pasteDoc = null;
        }
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
          '[finder-deckcraft] 코어(craft-prefetch-core.js)가 없어 프리패치를 건너뜁니다'
        );
      }
    }
    return core;
  }

  var prefetchImpl = null;
  /**
   * 매니페스트를 읽어 진입 에셋(JS 글루·ASM·온라인)을 미리 받는다.
   * HTML은 Worker가 no-store로 주므로 데울 수 없이 상체에서는 제외.
   * 실패는 조용히 무시한다 — 프리패치는 최적화일 뿐.
   * deps = { fetchFn, win } (테스트 주입용).
   * standalone deck 래퍼와 __myhubDeckcraftPrefetched 플래그를 공유한다.
   * @returns {Promise<string[]>} 실제로 받은 URL 목록
   */
  function prefetch(deps) {
    var core = getPrefetchCore();
    if (!core) return Promise.resolve([]);
    if (!prefetchImpl) {
      prefetchImpl = core.createPrefetch({
        flag: '__myhubDeckcraftPrefetched',
        discover: function (fetchFn) {
          return fetchFn(versionedAssetUrl(MANIFEST_URL))
            .then(function (res) {
              if (!res || !res.ok) throw new Error('manifest http ' + (res && res.status));
              return res.json();
            })
            .then(function (man) {
              return core.manifestAssetUrls('/vendor/deckcraft/', man, {
                wasm: true,
                snippets: true,
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
    isPresentationName: isPresentationName,
    sniffDeckFormat: sniffDeckFormat,
    DECKCRAFT_NATIVE_MIME: DECKCRAFT_NATIVE_MIME,
    pasteImageFile: pasteImageFile,
    isFormFieldTarget: isFormFieldTarget,
    internals: internals,
    APP_URL: APP_URL,
    MANIFEST_URL: MANIFEST_URL,
  };
  if (typeof window !== 'undefined') window.MyHubFinderDeckCraft = api;
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
