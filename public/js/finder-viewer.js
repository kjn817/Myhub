/* MyHub 파인더 뷰어 코어 (finder-viewer.js) 모듈의 3B 모델 (2026-11-02)
 *
 * 코어의 파일 분류/숨긴 파일설명주기 실패처리까지 마감고,
 * 형식별 처리는 finder-format-*.js 로 registerFormat등록 한다:
 *   text/csv 동일 finder-format-text.js    hwp/hwpx 동일 finder-format-hwp.js
 *   xlsx/xls 동일 finder-format-sheet.js   pptx     동일 finder-format-slide.js
 *   docx     기 finder-format-doc.js     image/pdf/타 등 코어 내장
 *
 * 모든 길 ctx.putContent이가 거치면, 파일의 등 등 받은 버전
 * (fileView.version)로 base_version함께 보내 동시 편집 충 돌을
 * 막 (는다 3A 배경). 계약(409)충돌 대변 안 내만 남긴,
 * 성공하면 응답의 등 버전으로 교체해 다음 저장도 이어지게 한다.
 * 노출: window.MyHubFinderViewer = { classifyFile, parseCsv,
 *        serializeCsv, extractHwpxText, decodeTextBytes, encodeText,
 *        registerFormat, formats, createViewer }
 */
(function () {
  'use strict';

  // 전역 라이브러리(xlsx/jszip/mammoth/purify)는 호스트 페이지가 미리
  // 로딩하지 않는다 — loadLib이 처음 필요할 때 동적 import로 지연
  // 로딩한다 (2026-11-13 성능 4라운드에서 office.html의 eager 태그
  // 3개를 제거; 이미 전역에 있으면 그걸 그대로 쓴다). 동적 <script>
  // 생성은 CSP에 걸리므로 import()만 쓴다.
  var LIBS = { xlsx: 'XLSX', jszip: 'JSZip', mammoth: 'mammoth', purify: 'DOMPurify' };
  var LIB_URLS = {
    xlsx: '/vendor/xlsx.full.min.js',
    jszip: '/vendor/jszip.min.js',
    mammoth: '/vendor/mammoth.browser.min.js',
    // DOMPurify 3.4.17 자체 호스 (N-04 트만 경 로와 동일
    // 파일, sha256 cd37898f인) 미리보기 DOCX 정제를 용 (N-01). CDN새로
    // 새로 거치지 않고 본다 지연 로드 패턴인 그림으로 건다.
    purify: '/vendor/dompurify/3.4.17/purify.min.js',
  };
  // 동적 로딩 URL과 공용 헬퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 등 버전 없는 URL과 immutable 캐시를 고정할 등 있다).
  // 헬퍼가 없는 환경(테스트 등)에서는 원본 URL 그림이다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }
  // 순수 변환(분류CSV인코WPX 딩포맷)텍스트 finder-codec.js가 만든다.
  // 로드 순서가 보장하므로 전역이 반드시 넣고, 없으면 순서 결수를
  // 실패시 실행을 위해 여기에 명시적으로 실패한다.
  var codec =
    (typeof window !== 'undefined' && window.MyHubFinderCodec) ||
    (typeof globalThis !== 'undefined' && globalThis.MyHubFinderCodec);
  if (!codec) throw new Error('finder-codec.js가 finder-viewer.js보다 먼저 로드돼야 합니다');
  var classifyFile = codec.classifyFile;
  var parseCsv = codec.parseCsv;
  var serializeCsv = codec.serializeCsv;
  var extractHwpxText = codec.extractHwpxText;
  var decodeTextBytes = codec.decodeTextBytes;
  var encodeText = codec.encodeText;

  // ---------- 형식 레지스트리 ----------
  var formats = {};
  function registerFormat(kind, handler) {
    formats[kind] = handler;
  }

  /**
   * deps = { doc, fetchFn, onSaved, loadLib, createSave, chromeFold,
   *          minimalChrome, studioEmbed, onSaveStateChange, ensureFormat }
   * ensureFormat(kind): 형식 핸들러 아직 등록하지 않은 kind를 등 등
   * 코어가 먼저 부르는 지연 로드 등 (Promise 반환). 호스트가 주요한
   * 경우에만 동작하고, 로드가 얼굴 레지스트리를 다시 확인한다 등
   * 그레이 없으면 종전으로 내장 실행으로 흘러진다. 핸들러 값이있는 코어가
   * 지연: 한다 기다리는 사이 다른 파일인 대변 포맷이 실행한
   * 않는다.
   * chromeFold: 파일 실행 접이(아래면 뷰어 편집기)를 켜진 등
   * 뒤 반에 접이 핸들러 앉힌 루트 fv-chrome-folded가 앉힌다.
   * minimalChrome: 등등 리더 버튼이 없는 실행(스튜디오) 등 숨긴
   * 값이 형식 실행 [파일] 메뉴가 마감고(시트 페이지PDF 인쇄tudio
   * 메뉴 확장을), 코어의 파일 상태 기본인 명령 실행만 제공한다.
   * studioEmbed: 한글 Studio를 embed 프로필로 앞고 메뉴 확장인
   * 배선하는 파일 계약만 으로 켜진의 (Finder) 뷰어 자체 너비를 리더(버튼
   * 파일 버튼)를 그림 으로, Studio 알고 자체 OS숨긴 있는
   * 경로만 호스트일괄 파일로 앉는다는. minimalChrome 호스트는
   * 등 계약을 포함하므로 으로 켜진 필요가 없다.
   * 형식 핸들러에 ownsChrome=true가 있으면 그 형식은 자체 너비를
   * 가지므로 코어의 플로우 에러리스트(#fvChrome)를 겹쳐 앞지 않는다.
   * onSaveStateChange(state): 저장 상태 아이를 호스트에 알린다 등
   * 스튜디오는 내부 차 제목의 변경 등 서식으로 바꾼다.
   * doc에서를 #finderViewer/#fvName/#fvNote/#fvSave/#fvDownload/
   * #fvClose/#fvBody/#fvStatus를 찾는다.
   * createSave(blob, file, ctx): 아직 서 버가 없는 빈(fileId 문서)의
   * 첫 길이를 호스트가 만든 등등 이름 폴더를 정해 POST로 생성하고,
   * file.fileId/file.version를 채워 넣기 등 true를 알려주면 이후 길이
   * PUT 경 로를 (office 이룬다 "의 파일" 흐름).
   */
  function createViewer(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var fetchFn =
      deps.fetchFn ||
      function (url, opts) {
        return fetch(url, opts);
      };
    var onSaved = typeof deps.onSaved === 'function' ? deps.onSaved : function () {};
    var root = doc.getElementById('finderViewer');
    var chromeEl = doc.getElementById('fvChrome');
    var nameEl = doc.getElementById('fvName');
    var noteEl = doc.getElementById('fvNote');
    var saveBtn = doc.getElementById('fvSave');
    var downloadEl = doc.getElementById('fvDownload');
    var closeBtn = doc.getElementById('fvClose');
    var bodyEl = doc.getElementById('fvBody');
    var statusEl = doc.getElementById('fvStatus');
    var cur = null; // { fileId, name, kind, save }
    // 숨긴 핸들 선택 (감사 D5): 자체 숨긴이 진행 중일 등 다른 파일인 대변
    // 먼저 시 작해 꼬인 콜백이 등 화면 파일 대변을 못하게 한다.
    var openGen = 0;

    // 파일 버튼 상태 기: 본은 버튼과 상태 표시인 (사용자 피드백 등
    // "길이 무 두진"버튼 이다 의).
    //   idle   '파일'          저 장할 변경을 아직 모델인
    //   dirty  '등 파일'        변경 있음 형식 (모 듈의 markDirty로 알림)
    //   saving '파일 중'      등 putContent 진행 중 (사진 내부 무시)
    //   saved  '저장됨'        등 마지막 길이가 성공한다
    // hidden인 형식 모듈이 지금까지처럼 으로 제어한다 등 그림이 텍스트박스
    // 클래스만 오버.
    var saveState = 'idle';
    var pendingDirty = false; // 저장 중 실패한 변경: 성공해도 dirty로 온다

    // 저장 미만의 너비를 파일 실행 (스튜디오, 2026-11-02 사용자 지정) 파일
    // 저장 버 튼은. 없다 길이가 실행 [파일] 메뉴 항목과 그
    // 단축키(Ctrl+S)가 부르는 명시 명령으로만 실패한다 등 자동 파일
    // 같은 등 처럼 경로인 않는다. 변경 표시인 호스트(제목 중)가
    // onSaveStateChange로 받아 만든다.
    var minimalChrome = deps.minimalChrome === true;
    // 한글 Studio 파일 계약(opt-in) 가 Finder를 켜진. 형식 모듈의
    // embed 프로필메뉴 확장이 배선한 조건으로 앉는다.
    var studioEmbed = deps.studioEmbed === true;
    function saveNow() {
      if (saveState === 'saving') return; // 저장 중 사진삽입 무시한다
      if (cur && typeof cur.save === 'function') cur.save();
    }

    function paintSaveBtn() {
      if (!saveBtn) return;
      saveBtn.classList.toggle('is-dirty', saveState === 'dirty');
      saveBtn.classList.toggle('is-saved', saveState === 'saved');
      saveBtn.disabled = saveState === 'saving';
      if (saveState === 'saving') saveBtn.textContent = '저장 중';
      else if (saveState === 'saved') saveBtn.textContent = '저장됨';
      else if (saveState === 'dirty') {
        saveBtn.innerHTML = '';
        var dot = doc.createElement('span');
        dot.className = 'fv-save-dot';
        dot.setAttribute('aria-hidden', 'true');
        saveBtn.appendChild(dot);
        saveBtn.appendChild(doc.createTextNode('저장'));
      } else saveBtn.textContent = '저장';
    }
    function setSaveState(next) {
      saveState = next;
      paintSaveBtn();
      if (typeof deps.onSaveStateChange === 'function') deps.onSaveStateChange(next);
    }
    function markDirty() {
      if (saveState === 'saving') {
        pendingDirty = true;
        return;
      }
      if (saveState !== 'dirty') setSaveState('dirty');
    }

    // 파일 파일 실행 접이 (이등 등 공통 UX 원칙, 2026-11-02 사용자 설계) 파일
    // 뷰어의 편집기가 하나지 않는다: 상단 영역을 아래면 뷰어, 실패면
    // 편집기다. 접근 실행에서는 경고 너비를 사라지고 문서가 화면에
    // 채우는 등 실패기 affordance를 으로 아이콘 하나뿐이다 (미만의
    // 너비 서정으로 뒤 반 자체가 없어보인다). 코어의 너비 접이(클래스
    // 앉힌)를 알리 마감고, 엔진 전환은 필요한 형식(한글: 플러그 보기
    // 등 Studio)를 ctx.onFoldChange로 접이 동작 안에 처리한다.
    // 호스트가 chromeFold를 켜진 경우에만 접이 버튼을 앉힌 등 Finder의
    // 기존 실행 그림이다.
    var chromeFoldEnabled = deps.chromeFold === true;
    var chromeFolded = false;
    var foldListeners = []; // { gen, fn } 등 숨긴 핸들러 함께 무효화된다
    var foldBtn = null;
    var foldListenerError = '';
    // 접이 끝으로 차 반 숨긴 (교정 파일 등): 에 앞프린 스튜디오
    // 실행에서는 끝으로 등 차 반을 소유한다 등 코어의 접이 상태를
    // office-tabs 채널(publishCoreFold)로 게시하고 앉힌 요청
    // (onCoreFoldRequest)를 받아 같은 setChromeFolded를 구동하고,
    // 플로우 버튼(#fvFoldBtn)를 만들지 않는다 (이쪽 게시 금지).
    // foldHostTabs의등 한글(의)등 끝으로이 등 접이 toggle-collapse 계약
    // (Studio 대응한다)단독 실행 의 종전 플로우 버튼을 공용
    // 이. 룬다 단독Finder(office-tabs 실)행이 그림 이다.
    var foldTabsApi =
      typeof window !== 'undefined' ? window.MyHubOfficeTabs : null;
    var foldShellHosted =
      chromeFoldEnabled &&
      deps.foldHostTabs !== true &&
      !!foldTabsApi &&
      typeof foldTabsApi.publishCoreFold === 'function' &&
      typeof window !== 'undefined' &&
      !!window.parent &&
      window.parent !== window;
    function publishShellFold() {
      if (!foldShellHosted) return;
      foldTabsApi.publishCoreFold({
        available: true,
        folded: chromeFolded,
      });
    }
    if (foldShellHosted && typeof foldTabsApi.onCoreFoldRequest === 'function') {
      foldTabsApi.onCoreFoldRequest(function () {
        if (cur) setChromeFolded(!chromeFolded);
      });
    }
    function paintFoldBtn() {
      if (!foldBtn) return;
      // 텍스트 버튼은 아니 끝으로 아이콘으로만 본다 (미만의 너비).
      // 상태는 aria로 전달한다: 완전히 실행에서는 앞인(접이),
      // 접근 실행에서는 아래쪽(실패기) 끝으로이다.
      foldBtn.innerHTML = '';
      var chev = doc.createElement('span');
      chev.className = 'fv-chevron ' + (chromeFolded ? 'fv-chevron-down' : 'fv-chevron-up');
      chev.setAttribute('aria-hidden', 'true');
      foldBtn.appendChild(chev);
      foldBtn.setAttribute('aria-expanded', chromeFolded ? 'false' : 'true');
      foldBtn.setAttribute('aria-label', chromeFolded ? '펼치기' : '접기');
      foldBtn.title = chromeFolded ? '펼치기' : '접기';
    }
    function setChromeFolded(next) {
      var folded = !!next;
      if (folded === chromeFolded) {
        paintFoldBtn();
        publishShellFold();
        return;
      }
      chromeFolded = folded;
      if (root) root.classList.toggle('fv-chrome-folded', chromeFolded);
      paintFoldBtn();
      publishShellFold();
      foldListeners.slice().forEach(function (l) {
        if (l.gen !== openGen) return;
        try {
          l.fn(chromeFolded);
        } catch (e) {
          // 등 형식의 전환 실패가 접이 자체를 깊이 않게 방지만 남긴
          foldListenerError = String((e && e.message) || e);
        }
      });
    }

    // 본다 라이브러리 지연 로드 진행분 (이름 등 Promise). 성공하면
    // 전역이 필요한 다음 노출을 그림으로 가고, 실패하면 지정 다음
    // 숨긴에서 다시 시도한 등 넣은 한다.
    var libLoading = {};
    function loadLib(name) {
      if (typeof deps.loadLib === 'function') return deps.loadLib(name);
      if (name === 'rhwp') return import(versionedAssetUrl('/vendor/rhwp/rhwp.js'));
      if (name === 'rhwpEditor') return import(versionedAssetUrl('/vendor/rhwp-editor/index.js'));
      if (name === 'kordoc')
        return import(versionedAssetUrl('/vendor/kordoc/kordoc.js')).then(function () {
          return typeof window !== 'undefined' ? window.__kordoc : undefined;
        });
      var globalName = LIBS[name];
      if (typeof window !== 'undefined' && window[globalName]) {
        return Promise.resolve(window[globalName]);
      }
      var url = LIB_URLS[name];
      if (!url || typeof window === 'undefined') {
        return Promise.reject(new Error('lib not loaded: ' + name));
      }
      if (!libLoading[name]) {
        libLoading[name] = import(versionedAssetUrl(url))
          .then(function () {
            if (window[globalName]) return window[globalName];
            throw new Error('lib not loaded: ' + name);
          })
          .catch(function (err) {
            delete libLoading[name];
            throw err;
          });
      }
      return libLoading[name];
    }

    var statusTimer = null;
    function setStatus(msg) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      if (!msg) {
        statusEl.hidden = true;
        return;
      }
      // 상태는 본문등 오버레이로만 유지전용인 사라진다 실패. 충돌처리
      // 사용자가 봐야 하는 알림이 다음 상태가 등 때까지 유지하고,
      // 그 등(파일 중첩룰렛 있음)를 자동으로 사라진다.
      statusEl.hidden = false;
      if (!/실패|수정할수없습니다/.test(msg)) {
        statusTimer = setTimeout(function () {
          statusEl.hidden = true;
        }, 3600);
      }
    }

    // 호스트 실패핵심 루트 커스터 이벤트로 한다 숨긴 (요청 오버)
    function fireRootEvent(type, detail) {
      if (!root) return;
      var view = doc.defaultView;
      var CE =
        view && view.CustomEvent
          ? view.CustomEvent
          : typeof CustomEvent !== 'undefined'
            ? CustomEvent
            : null;
      if (CE) root.dispatchEvent(new CE(type, { bubbles: true, detail: detail }));
    }

    // 핸들러 컨텍스트: 파일 단위 고정 정보 + 핸들러 값 + 공용 헬퍼.
    // fetchContent의 URL를 노출 지정 확정한다 등 응답이 기다리는 사이
    // 다른 파일이 이름 이전 숨긴 요청인 등 파일 내용을 받아 실패
    // 못하게 하기 위해서 (감사 D5).
    function makeCtx(file, gen) {
      var ctx = {
        doc: doc,
        body: bodyEl,
        noteEl: noteEl,
        saveBtn: saveBtn,
        gen: gen,
        file: file, // { fileId, name, kind, mime, version }
        // 파일 실행 접이가 켜진 호스트인가 (스튜디오 등 등 Finder의 아니다)
        chromeFold: chromeFoldEnabled,
        // 미만의 너비 호스트인가 등 형식의 자체 [파일] 메뉴를 붙인
        // 조건인 한다 (스튜디오만 true)
        minimalChrome: minimalChrome,
        // 한글 Studio 파일 계약이 켜진 호스트인가 (Finder) 의 Studio를
        // embed로 앞고 메뉴 확장인 배선하는 조건인 한다. 스튜디오는
        // minimalChrome 인 같은 계약이 켜진다.
        studioEmbed: studioEmbed,
        // [파일] 메뉴 숨긴: 일괄 호스트 그림이 건다 등 트리만 한다
        requestOpen: function () {
          if (gen === openGen) fireRootEvent('myhub:request-open');
        },
        // 그림 넣기 파일 선택: 일괄 호스트 그림 이고, 고정 그림의
        // 바이 deliver(트는, 콜백) 으로만 파한다 등 취소하면
        // 콜백 자체가 오지 않는다 (숨긴 무응답 취소와 같은 계약).
        // 핸들러 값이 답없는용이다: 요청인 보낸 등 다른 파일인 대변
        // 뒤쭉 앞인 그림의 등 문서에 실패가 않게.
        requestPicture: function (deliver) {
          if (gen !== openGen) return;
          fireRootEvent('myhub:request-picture', {
            deliver: function (name, bytes) {
              if (gen === openGen && typeof deliver === 'function') deliver(name, bytes);
            },
          });
        },
        // 미디어 넣기(미디어타입 파일의 그림 아님 파일)의 선택:
        // 그림과 같은 계약으로 purpose를 함께 알린다 등 호스트 그림이
        // purpose별 확장(자제목)를 숨기고, deliver로 바이트를
        // 알려준다. 핸들러 값도 그림과 같다.
        requestMedia: function (purpose, deliver) {
          if (gen !== openGen) return;
          fireRootEvent('myhub:request-media', {
            purpose: purpose,
            deliver: function (name, bytes) {
              if (gen === openGen && typeof deliver === 'function') deliver(name, bytes);
            },
          });
        },
        // 자체 너비를 가진 형식(시트PDF)의 찾기 버튼을 부르는 찾기
        closeViewer: function () {
          if (gen === openGen) close();
        },
        isFolded: function () {
          return chromeFolded;
        },
        setFolded: function (folded) {
          if (gen === openGen) setChromeFolded(folded);
        },
        // 접이/펼치기 전환 알림 등 엔진 전환은 필요한 형식을 등록한다
        onFoldChange: function (fn) {
          if (typeof fn === 'function') foldListeners.push({ gen: gen, fn: fn });
        },
        loadLib: loadLib,
        isCurrent: function () {
          return gen === openGen && cur !== null && cur.fileId === file.fileId;
        },
        setStatus: function (msg) {
          if (ctx.isCurrent()) setStatus(msg);
        },
        // 형식 모듈의 "담리지 않은 변경"를 감지하면 알린다 등 파일
        // 버튼을 '변경 있음' 상태로 바꾼. 핸들러 밖에선 무시한다.
        markDirty: function () {
          if (ctx.isCurrent()) markDirty();
        },
        setNote: function (msg) {
          if (noteEl && ctx.isCurrent()) noteEl.textContent = msg || '';
        },
        contentUrl: function () {
          return '/api/drive/files/' + file.fileId + '/content';
        },
        // 앞의 URL 다시 fetch 등 현재 파일 content가 아닌 요청(병합 상대
        // 파일 GET파일 파일 POST폴더 목록)를. 호스트가 주요한 fetchFn를
        // 그림으로 본래 파일테 스트진행 표시인 경로가 실패한다.
        fetchRaw: function (url, opts) {
          return Promise.resolve().then(function () {
            return fetchFn(url, opts);
          });
        },
        fetchContent: function (as) {
          // 호스트가 바이트를 직접 넣기 파일(빈 문서 템플릿 등)를 서버의
          // 대변으로 네트 워크를 등지 않는다. buffer는 복사본을
          // 알려준다 등 노출인 postMessage로 소유권을 넘어간(detach)
          // 원본의 내부 다시 등 등 있다.
          if (file.bytes) {
            if (as === 'text') {
              // 네트워크 경로(res.text())와 같은 하나: UTF-8 문자열
              return Promise.resolve(new TextDecoder('utf-8').decode(new Uint8Array(file.bytes)));
            }
            return Promise.resolve(file.bytes.slice(0));
          }
          var url = ctx.contentUrl();
          return Promise.resolve()
            .then(function () {
              return fetchFn(url);
            })
            .then(function (res) {
              if (!res || !res.ok) throw new Error('http ' + (res && res.status));
              return as === 'text' ? res.text() : res.arrayBuffer();
            });
        },
        clearBody: function () {
          bodyEl.innerHTML = '';
        },
        showMessage: function (msg) {
          bodyEl.innerHTML = '';
          var p = doc.createElement('p');
          p.className = 'fv-message';
          p.textContent = msg;
          bodyEl.appendChild(p);
        },
        // 등 입력 등 등 값이 바뀌면 플러그가 onCell(r, c, value)가 불편한
        buildGrid: function (aoa, onCell) {
          var table = doc.createElement('table');
          table.className = 'fv-grid';
          var tbody = doc.createElement('tbody');
          aoa.forEach(function (rowArr, r) {
            var tr = doc.createElement('tr');
            rowArr.forEach(function (cell, c) {
              var td = doc.createElement('td');
              var input = doc.createElement('input');
              input.value = cell === null || cell === undefined ? '' : String(cell);
              input.dataset.r = String(r);
              input.dataset.c = String(c);
              input.addEventListener('input', function () {
                onCell(r, c, input.value);
              });
              input.addEventListener('input', function () {
                ctx.markDirty();
              });
              td.appendChild(input);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          return table;
        },
        // 텍스트 편집기: saveWith(현재 값)가 인코딩포맷UT로 만든다
        openTextEditor: function (text, saveWith) {
          bodyEl.innerHTML = '';
          var ta = doc.createElement('textarea');
          ta.className = 'fv-textarea';
          ta.value = text;
          ta.spellcheck = false;
          ta.addEventListener('input', function () {
            ctx.markDirty();
          });
          bodyEl.appendChild(ta);
          ctx.setSaveHandler(function () {
            return saveWith(ta.value);
          });
          if (saveBtn) saveBtn.hidden = false;
          return ta;
        },
        setSaveHandler: function (fn) {
          if (cur && gen === openGen && cur.fileId === file.fileId) cur.save = fn;
        },
        // 버전 충돌 조회 파일 (3A 계약를): base_version 함께, 409면
        // 충돌대변 안내만 적용 안내, 성공하면 등 버전으로 교체 + onSaved.
        putContent: function (blob) {
          // 파일 버튼 상태는 등 핸들러 저장만 반영한다 (작은 핸들러
          // 완료가 등 파일의 버튼을 치환지 않게).
          var paint = function (next) {
            if (gen === openGen) setSaveState(next);
          };
          if (!file.fileId) {
            // 빈 문 서의 첫: PUT파일 는 아직 없다. 생성한 호스트
            // 밖에 위임한다 (다른 이름으로 파일 흐름).
            if (typeof deps.createSave !== 'function') {
              ctx.setStatus('처음에 실패했습니다');
              return Promise.resolve(false);
            }
            if (gen === openGen) {
              pendingDirty = false;
              setSaveState('saving');
            }
            ctx.setStatus('저장하는 중');
            return Promise.resolve()
              .then(function () {
                return deps.createSave(blob, file, ctx);
              })
              .then(function (ok) {
                if (ok) {
                  // createSave가를 file.fileId실제 로 id넣은 안에 실패
                  // 현재 숨긴 상태(cur)와 맞떨어 한다 등 등 맞으면
                  // isCurrent()가 앞으로 false가 등 파일 완료 표시부분
                  // 이후 비동기 완료 까지 전부. 버려진다 작은(gen)핸들러
                  // 완료한 현재 상태를 건드리 않게.
                  if (gen === openGen && cur) {
                    cur.fileId = file.fileId;
                    cur.name = file.name;
                  }
                  ctx.setStatus('저장했습니다');
                  onSaved();
                  paint(pendingDirty ? 'dirty' : 'saved');
                } else {
                  // 취소 실패 "모두 아직 담리지"않은 사실이다
                  paint('dirty');
                }
                return !!ok;
              })
              .catch(function () {
                ctx.setStatus('처음에 실패했습니다');
                paint('dirty');
                return false;
              });
          }
          var fd = new FormData();
          fd.append('file', blob, file.name);
          if (file.version) fd.append('base_version', file.version);
          if (gen === openGen) {
            pendingDirty = false;
            setSaveState('saving');
          }
          ctx.setStatus('저장하는 중');
          return Promise.resolve()
            .then(function () {
              return fetchFn('/api/drive/files/' + file.fileId + '/content', {
                method: 'PUT',
                body: fd,
              });
            })
            .then(function (res) {
              if (res && res.status === 409) {
                ctx.setStatus('다른 곳에서 먼저 수정했습니다. 새로고침 후 다시 시도하세요');
                paint('dirty');
                return false;
              }
              if (!res || !res.ok) throw new Error('http ' + (res && res.status));
              var finish = function (body) {
                if (body && body.version) file.version = body.version;
                ctx.setStatus('저장했습니다');
                onSaved();
                paint(pendingDirty ? 'dirty' : 'saved');
                return true;
              };
              if (res.json) {
                return res
                  .json()
                  .then(finish)
                  .catch(function () {
                    return finish(null);
                  });
              }
              return finish(null);
            })
            .catch(function () {
              ctx.setStatus('처음에 실패했습니다');
              paint('dirty');
              return false;
            });
        },
        // 엔진 안에 다른 이름으로 저장한 경우의 추출: 현재 파일의
        // 착 않고 다른 이름으로 파일(createSave) 흐름으로 보낸다.
        // 사전이름만 엔진의 알려준 이름으로 바꾸고 취소, 실패하면
        // 원래 이름으로 되돌린다. 성공하면 등 파일의 현재 문서로
        // 넣는다의 (createSave 호스트 밖의 계약 그림이다).
        saveAsContent: function (blob, name) {
          if (typeof deps.createSave !== 'function') {
            ctx.setStatus('그리는 다른 이름으로 저장할 수 없습니다');
            return Promise.resolve(false);
          }
          var origName = file.name;
          if (name) file.name = name;
          if (gen === openGen) {
            pendingDirty = false;
            setSaveState('saving');
          }
          ctx.setStatus('저장하는 중');
          return Promise.resolve()
            .then(function () {
              return deps.createSave(blob, file, ctx);
            })
            .then(function (ok) {
              if (ok) {
                if (gen === openGen && cur) {
                  cur.fileId = file.fileId;
                  cur.name = file.name;
                }
                ctx.setStatus('저장했습니다');
                onSaved();
                if (gen === openGen) setSaveState(pendingDirty ? 'dirty' : 'saved');
              } else {
                file.name = origName;
                if (gen === openGen) setSaveState('dirty');
              }
              return !!ok;
            })
            .catch(function () {
              file.name = origName;
              ctx.setStatus('처음에 실패했습니다');
              if (gen === openGen) setSaveState('dirty');
              return false;
            });
        },
      };
      return ctx;
    }

    function openBuiltin(ctx) {
      var kind = ctx.file.kind;
      if (kind === 'image') {
        ctx.clearBody();
        var img = doc.createElement('img');
        img.className = 'fv-image';
        img.src = ctx.contentUrl();
        img.alt = ctx.file.name;
        ctx.body.appendChild(img);
        return Promise.resolve();
      }
      if (kind === 'pdf') {
        ctx.clearBody();
        bodyEl.classList.add('fv-fill');
        var frame = doc.createElement('iframe');
        frame.className = 'fv-frame';
        // gate-74 정한 (미리 D14): 보기 iframe스크 립트 실행 없이
        // 문서 표시만 등 선택 없는 sandbox가 최소 권한이다.
        frame.setAttribute('sandbox', '');
        frame.src = ctx.contentUrl();
        ctx.body.appendChild(frame);
        return Promise.resolve();
      }
      if (kind === 'hwp') {
        ctx.showMessage('구형 한글(hwp) 파일은 미리보기가 안 됩니다. 가져와서 한글 편집기로 여세요.');
        return Promise.resolve();
      }
      ctx.showMessage('이 형식은 미리보기가 안 됩니다. 가져와서 여세요.');
      return Promise.resolve();
    }

    function open(file) {
      if (!root || !bodyEl) return Promise.resolve();
      var gen = ++openGen;
      cur = {
        fileId: file.fileId,
        name: file.name,
        kind: classifyFile(file.name, file.mime),
        save: null,
      };
      root.hidden = false;
      // 자체 너비(파일 메뉴)끝으로 가가진 형식의 코어 플로우
      // 에러리스트를 겹쳐 앞지 않게 한다 (스튜디오 전용 마크인 등 Finder가 없다)
      function paintChromeFor(fmt) {
        if (chromeEl) chromeEl.hidden = !minimalChrome || !!(fmt && fmt.ownsChrome);
      }
      paintChromeFor(formats[cur.kind]);
      if (nameEl) nameEl.textContent = file.name;
      if (noteEl) noteEl.textContent = '';
      pendingDirty = false;
      setSaveState('idle');
      // 등 문서의 등상 실패(편집) 실행으로 시작한다
      chromeFolded = false;
      foldListeners = [];
      root.classList.remove('fv-chrome-folded');
      paintFoldBtn();
      publishShellFold();
      if (saveBtn) saveBtn.hidden = true;
      if (downloadEl) {
        // 등 문서(미세)를 이름 대변 없이 다운로드 마감를 남긴
        downloadEl.hidden = !file.fileId;
        downloadEl.href = file.fileId ? '/api/drive/files/' + file.fileId : '#';
      }
      setStatus('');
      bodyEl.innerHTML = '';
      bodyEl.classList.remove('fv-fill');
      var opened = {
        fileId: file.fileId,
        name: file.name || '',
        kind: cur.kind,
        mime: file.mime || '',
        version: file.version || null,
        bytes: file.bytes || null,
      };
      var ctx = makeCtx(opened, gen);
      ctx.showMessage('불러오는 중');
      var handler = formats[cur.kind];
      var done;
      if (typeof handler === 'function') {
        done = Promise.resolve().then(function () {
          return handler(ctx);
        });
      } else if (typeof deps.ensureFormat === 'function') {
        // 형식 모듈이 아직 로드하지 않은 호스트(Finder 지정 로드):
        // 등 kind의 모듈을 먼저 불러온 등 레지스트리 다시 본다.
        // 기다리는 사이 다른 파일이 이름(gen 변경) 앞인것도
        // 그 리지 않게 등 뒤쭉 앞인 핸들러 등 화면에 대변.
        done = Promise.resolve()
          .then(function () {
            return deps.ensureFormat(cur.kind);
          })
          .then(function () {
            if (gen !== openGen) return undefined;
            var late = formats[cur.kind];
            paintChromeFor(late);
            if (typeof late === 'function') return late(ctx);
            return openBuiltin(ctx);
          });
      } else {
        done = openBuiltin(ctx);
      }
      return Promise.resolve(done).catch(function () {
        if (gen !== openGen) return; // 이미 다른 파일의 등 이름 실패 표시인 수 않는다
        ctx.showMessage('파일을 불러오지 못했습니다');
        setStatus('');
      });
    }

    function close() {
      openGen++; // 진행 중인 숨긴를 무효화한다
      if (root) root.hidden = true;
      cur = null;
      // 문서가 닫히면 차 반 끝으로 대변한다 (주요 버튼 금지)
      if (foldShellHosted) foldTabsApi.publishCoreFold(null);
      if (bodyEl) bodyEl.innerHTML = '';
      // 어떤 실행이 찾기한 호스트 그림이 문서 상태를 따라가게 알린다
      fireRootEvent('myhub:viewer-close');
    }

    if (closeBtn) closeBtn.addEventListener('click', close);
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        saveNow();
      });
    }
    if (minimalChrome) {
      // 버 튼 없는 길이 명시: Ctrl+S (macOS경로 Cmd+S)
      doc.addEventListener('keydown', function (e) {
        if (!e || (e.key !== 's' && e.key !== 'S')) return;
        if (!e.ctrlKey && !e.metaKey) return;
        if (!cur || typeof cur.save !== 'function') return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        saveNow();
      });
    }
    if (chromeFoldEnabled && !foldShellHosted) {
      // 접이 핸들러 끝으로 아이콘 버튼으로만 본다. 호스트가 너비
      // (#fvFoldSlot 안의 스튜디오 플로우 너비)를 주요 건으로, 없으면
      // 파일 버튼 버로 앞에 붙는다. 등 차 반의 끝으로 소유하는
      // 파(foldShellHosted)일을 불러 오지 못했 습니다.
      foldBtn = doc.createElement('button');
      foldBtn.type = 'button';
      foldBtn.id = 'fvFoldBtn';
      foldBtn.className = 'finder-act fv-fold-btn';
      foldBtn.addEventListener('click', function () {
        setChromeFolded(!chromeFolded);
      });
      var foldSlot = doc.getElementById('fvFoldSlot');
      if (foldSlot) foldSlot.appendChild(foldBtn);
      else if (saveBtn && saveBtn.parentNode) saveBtn.parentNode.insertBefore(foldBtn, saveBtn);
      paintFoldBtn();
    }

    return {
      open: open,
      close: close,
      classifyFile: classifyFile,
      setFolded: setChromeFolded,
      isFolded: function () {
        return chromeFolded;
      },
    };
  }

  var api = {
    classifyFile: classifyFile,
    parseCsv: parseCsv,
    serializeCsv: serializeCsv,
    extractHwpxText: extractHwpxText,
    decodeTextBytes: decodeTextBytes,
    encodeText: encodeText,
    registerFormat: registerFormat,
    formats: formats,
    createViewer: createViewer,
  };
  if (typeof window !== 'undefined') window.MyHubFinderViewer = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFinderViewer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
