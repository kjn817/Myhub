/* MyHub 오피스 호스트 (office.js) — Excel·한글 2020·PowerPoint·PDF
 *
 * ?app=로 종류를 정한다. 앱을 지정하면 시작 화면 없이 빈 문서로 바로 연다
 * 진입한다(autoNew 도 사용자 지시 2026-11-03: PPT·PDF는 한글·한글처럼
 * 마감). 에서는 [파일 열기] 를 Finder로 경로 탐색 패널로 파일을 골라
 * 열고, 기존 3B 뷰어 코어(finder-viewer.js + finder-format-*.js)를
 * 그대로 사용하므로 같은 문서 DOM 계약(#finderViewer/#fv*)를
 * office.html에 복제돼있으므로 base_version·409 안내·충돌본 편집기와
 * 동일하게 동작한다. 이 호스트 모두가 편집 호스트 앱이다.
 *
 * 새로 만들기: Excel는 빈 워크북으로 열고, 한글은 엔진이 검증한 빈
 * hwpx 서식(public/templates/blank.hwpx 파일로 hwpxlib BlankFileMaker 구조,
 * rhwp 코어 로드 + Studio 정품 게이트 통과분)를 바이트로 넣어 편집기로
 * 연다. PDF는 빈 1페이지 서식(public/templates/blank.pdf 파일 pdf-lib로
 * 생성한 A4 빈 페이지를)바이트로 넣는다 는. PowerPoint서식 파일 없이
 * DeckCraft 호스트의 새 문서 모드로 시작한다 (finder-format-slide의
 * isNew 경로). 첫 호스트 모두가 코어의 createSave 이 "다른 이름으로
 * 저장"(폴더 선택 + 이름 입력 뒤 POST 생성 뒤 폴더 참조로 version
 * 올리기)로 처리한다.
 *
 * 파일 열기 핸드셰이크: Finder로 부모 창이 연 파일을 뷰어가 아니라
 * 이 앱으로 실행하게 한다 (부모 창 공유로 postMessage 'myhub:open-file',
 * 단독 실행하면 ?file= 쿼리). 준비 알림 'myhub:office-ready'를 확인
 * 'myhub:open-file-ack'로 전달 중이라는 뜻이다 (Finder 핸드셰이크 중독).
 *
 * 앱 메모리 (전임 localStorage, 서버 정합 없음):
 * - 최근 파일 최대 8개 (까지) 폴더 시작 화면에서 다시 열기
 * - 마지막 폴더 열기 저장/패널의 시작 위치 유지
 * - 이어서 열기 때 마지막 파일을 시작 화면에 제안만 한다 (자동 실행 X)
 * - 내용 캐시 키 version(storage_key)가 같은 파일을 content 요구 없이
 *   캐시 바이트로 연다 (목록 응답의 version과 대조)
 *
 * 노출: window.MyHubOffice = { APPS, parseAppKey, createApp }
 */
(function () {
  'use strict';

  // 동적 로딩 URL는 공용 헬퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 버전 없는 는 URL그대로 immutable 캐시에 고정될 수 있다).
  // 헬퍼가 없는 환경(테스트 등)에서는 원본 URL 그대로다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }

  var XLSX_MIME =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var PPTX_MIME =
    'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  var PDF_MIME = 'application/pdf';

  var APPS = {
    excel: {
      title: 'Excel', iconKind: 'excel', exts: ['xlsx', 'xls', 'csv'],
      canSave: true, canCreate: true, newExt: '.xlsx', newMime: XLSX_MIME,
      newTitle: '제목 없음.xlsx',
      // 시작 화면 없이 빈 워크북으로 바로 진입한다 (실제 작업
      // 동작 뒤 사용자 지시 2026-11-03, 와 같은 스위치).
      autoNew: true,
      desc: '본체의 스프레드시트를 열고 편집합니다. 수식은 수식 그대로 계산됩니다.',
    },
    hangul: {
      title: '한글 2020', iconKind: 'hangul', exts: ['hwp', 'hwpx'],
      canSave: true, canCreate: true, newExt: '.hwpx',
      newMime: 'application/hwp+zip', newTitle: '제목 없음.hwpx',
      templateUrl: '/templates/blank.hwpx',
      // 시작 화면 없이 빈 문서로 바로 진입한다 (실제 한글 동작 뒤
      // 사용자 지시 2026-11-02). 보기/편집은 단일 표면 접기 모델과 맞는다.
      autoNew: true,
      desc: '본체의 한글 문서를 보고 편집합니다.',
    },
    powerpoint: {
      title: 'PowerPoint', iconKind: 'powerpoint', exts: ['pptx', 'ppt'],
      canSave: true, canCreate: true, newExt: '.pptx', newMime: PPTX_MIME,
      newTitle: '제목 없음.pptx',
      // 한글·한글과 같은 마감 (사용자 지시 2026-11-03): 시작 화면 없이
      // 빈 프레젠테이션으로 바로 진입한다. 빈 문서 시작은 DeckCraft
      // 호스트의 새 문서 모드가 맞는다 (서식 파일 없음).
      autoNew: true,
      desc: '본체의 프레젠테이션을 전용 편집기로 보고 편집합니다.',
    },
    pdf: {
      title: 'PDF', iconKind: 'pdf', exts: ['pdf'],
      canSave: true, canCreate: true, newExt: '.pdf', newMime: PDF_MIME,
      newTitle: '제목 없음.pdf',
      templateUrl: '/templates/blank.pdf',
      // 한글·한글과 같은 마감 (사용자 지시 2026-11-03): 시작 화면 없이
      // 빈 1페이지 PDF로 바로 진입한다.
      autoNew: true,
      desc: '본체의 PDF를 전용 편집기로 봅니다. 주석·양식 입력 도구와 페이지 조작(회전·삭제·추출·병합)을 합니다.',
    },
  };

  function parseAppKey(search) {
    var key = '';
    try {
      key = new URLSearchParams(String(search || '')).get('app') || '';
    } catch (e) {
      key = '';
    }
    return APPS[key] ? key : 'excel';
  }

  /**
   * deps = { doc, fetchFn, storage, search, viewerFactory?, iconsApi? }
   * doc에서 office.html의 요소들을 id로 찾는다 (없는 요소는 건너뜀).
   */
  function createApp(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var baseFetch =
      deps.fetchFn ||
      function (url, opts) {
        return fetch(url, opts);
      };
    var storage = deps.storage || null;
    var icons = deps.iconsApi ||
      (typeof window !== 'undefined' ? window.MyHubFileIcons : null);
    var appKey = parseAppKey(deps.search !== undefined ? deps.search : (typeof window !== 'undefined' ? window.location.search : ''));
    var app = APPS[appKey];
    // 자동 새 문서 진입은 실제 부모가 APPS 플래그를 보고 명시적으로
    // 켤 때만 일어나도록 (한다 createApp테스트가 를 직접 불러도 꺾임)
    var autoNew = deps.autoNew === true;

    var el = function (id) { return doc.getElementById(id); };
    var startEl = el('officeStart');
    var openBtn = el('officeOpenBtn');
    var newBtn = el('officeNewBtn');
    var closeBtn = el('officeCloseBtn');
    var progressEl = el('officeProgress');
    var progressFill = el('officeProgressFill');
    var progressLabel = el('officeProgressLabel');

    var viewer = null;
    var current = null; // { fileId, name, mime, version, folderId, folderName, isNew }
    var autoNewTimer = null; // 자동 새 문서 진입 지연 타이머 (파일 열기가 오면 취소)
    var opening = false;
    var openingFile = null; // 지금 열고 있는 파일 (같은 파일 중복 열기 판정)
    var queuedOpen = null; // 열기 진행 중에 도착한 파일 열기 요청 (유실 방지)
    var queuedOpenWaiters = [];
    var saveState = 'idle'; // 코어 저장 상태 기계의 마지막 상태 (제목 줄 표시용)

    // ---------- 문서 제목 동기 (창 제목줄이 정보) ----------
    // 파일명이 앱 이름이 아닌 데스크톱 창의 제목줄 신호등이(있는 바
    // 바)에 오른다. iframe들은 postMessage가 기존 통신 패턴이고, 창 바
    // 독립 실행에서는 문서 제목(브라우저 탭)을 최소 읽기로 고른다.
    // 변경 있음은 제목 앞의 점으로만 앱으로 알린다.
    function notifyDocTitle() {
      var payload = {
        name: current ? current.name || null : null,
        dirty: saveState === 'dirty',
      };
      if (typeof deps.onDocTitle === 'function') {
        try {
          deps.onDocTitle(payload);
        } catch (e) {
          console.warn('문서 제목 동기 실패:', e);
        }
      }
      if (typeof window !== 'undefined') {
        if (window.parent && window.parent !== window) {
          try {
            window.parent.postMessage(
              { type: 'myhub:doc-title', name: payload.name, dirty: payload.dirty },
              window.location.origin,
            );
          } catch (e) {
            console.warn('창 제목 동기 실패:', e);
          }
        }
        // I-11: 단독 실행에서는 브라우저 탭이 제목줄을 고르므로, 같은
        // 계약(파일명 + 미저장 점)을 탭 제목에도 반영한다.
        doc.title = payload.name
          ? (payload.dirty ? '● ' : '') + payload.name + ' · ' + app.title
          : app.title + ' · MyHub';
      }
    }

    // ---------- 저장소 (앱 메모리) ----------
    function storeGet(key, fallback) {
      if (!storage) return fallback;
      try {
        var raw = storage.getItem(key);
        if (!raw) return fallback;
        var parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch (e) {
        console.warn('오피스 앱 메모리 읽기 실패:', e);
        return fallback;
      }
    }
    function storeSet(key, value) {
      if (!storage) return;
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('오피스 앱 메모리 쓰기 실패:', e);
      }
    }
    // ---------- 내용 캐시 + 진행 표시 fetch (office-fetch.js가 전임) ----------
    var fetchApi = null;
    function getFetchApi() {
      if (fetchApi) return fetchApi;
      var factory = deps.fetchFactory ||
        (typeof window !== 'undefined' && window.MyHubOfficeFetch
          ? window.MyHubOfficeFetch.createOfficeFetch
          : null);
      if (!factory) {
        // 모듈이 없으면 진행·캐시 없이 기본 fetch로 동작한다
        return {
          fetch: baseFetch,
          expectVersion: function () {},
          invalidate: function () {},
        };
      }
      fetchApi = factory({
        fetchFn: baseFetch,
        onProgress: function (p) {
          if (p.phase === 'download') {
            if (p.total) showProgress('받는 중 ' + Math.round((p.got / p.total) * 100) + '%', (p.got / p.total) * 100);
            else showProgress('받는 중…', null);
          } else if (p.phase === 'parse') {
            // 다운로드가 끝나면 막대는 치운다 — 이후는 뷰어의 로딩 화면이
            // 이어받는다. 막대를 계속 두면 막대형+원형 로딩이 겹쳐 보인다
            // (2026-11-13 사용자 지적: 로딩 페이지 전에 뭐가 있다).
            hideProgress();
          }
        },
      });
      return fetchApi;
    }

    function showProgress(label, pct) {
      if (!progressEl) return;
      progressEl.hidden = false;
      if (progressLabel) progressLabel.textContent = label || '';
      if (progressFill) {
        if (pct === null || pct === undefined) {
          progressFill.classList.add('is-indeterminate');
          progressFill.style.width = '';
        } else {
          progressFill.classList.remove('is-indeterminate');
          progressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
        }
      }
    }
    function hideProgress() {
      if (progressEl) progressEl.hidden = true;
    }

    // ---------- 뷰어 (3B 코어 재사용) ----------
    function getViewer() {
      if (viewer) return viewer;
      var factory = deps.viewerFactory ||
        (typeof window !== 'undefined' && window.MyHubFinderViewer
          ? window.MyHubFinderViewer.createViewer
          : null);
      if (!factory) throw new Error('뷰어 코어가 없습니다');
      viewer = factory({
        doc: doc,
        fetchFn: getFetchApi().fetch,
        // 오피스 앱 공통: 단일 표면 접기 (열면 뷰어·접으면 에디터)
        chromeFold: true,
        // 한글은 앱 창 바 더블로이 가 toggle-collapse(Studio 아니라)
        // 계약이라 코어 접기(표면 전환)를 플로팅 버튼과 계속 맞는다.
        // 페이지 앱 코어 접기가 창 바 더블로이으로 연다.
        foldHostTabs: appKey === 'hangul',
        // 미니멀 접기: 앱 자체 헤더·접기 버튼이 없다 앱 열기·뷰어 가
        // 표면을 [파일] 메뉴가 맡고, 접힌 상태는 제목줄 앱으로만
        // 표시한다.
        minimalChrome: true,
        onSaveStateChange: function (state) {
          saveState = state;
          notifyDocTitle();
        },
        onSaved: function () {
          // 우리 호스트으로 내용을 받아뒀으니 캐시를 버린다 (전역 리로드 X)
          if (current && current.fileId) getFetchApi().invalidate(current.fileId);
        },
        createSave: createSaveFlow,
      });
      return viewer;
    }

    function updateChrome() {
      // 파일명은 창 제목줄 이 곳에만 오른다 (notifyDocTitle) 가 이 안에
      // 같은 이름의 앱 화면 제목 영역과 나란히 겹친다 (사용자 피드백).
      if (closeBtn) closeBtn.hidden = !current;
      if (startEl) startEl.hidden = !!current;
      // 닫힌 문서가 없으면 오피스 앱 도 빈손이다 (방송 작업 2) 앱
      // 뷰어 호스트가 문서가 닫힐 때 엔진 상태로 다시 채운다.
      if (!current && typeof window !== 'undefined' && window.MyHubOfficeTabs) {
        window.MyHubOfficeTabs.setState(appKey, null);
      }
      // 빠른 실행 가능성: 문서를 열면 호스트를 올리고, 접으면 닫힌
      // (뷰어 호스트 몫 앱 undo/redo/print/search 앱 앱 별도).
      // 접기는 빠른 실행 동작이 아니라 전용 채널(myhub:office-fold)로
      // 맞는다 (2026-11-06 방송 교정 트랙): 앱 앞에서는 창 바
      // 더블로이, 단독 실행에서는 표면 자체 접기 버튼(#fvFoldBtn)가
      // 같은 코어 접기를 구동한다. 한글만 앱 toggle-collapse 계약.
      if (
        typeof window !== 'undefined' &&
        window.MyHubOfficeTabs &&
        typeof window.MyHubOfficeTabs.setQuick === 'function'
      ) {
        if (current) {
          window.MyHubOfficeTabs.setQuick(appKey, { save: true });
        } else {
          // 문서가 접히면 앱 앱의 빠른 실행 패널을 닫힌다 (뷰어
          // 호스트가 접힌 undo/redo/print/search 포함 앱 주요 버튼을
          // 제목 줄에 합칠 때).
          window.MyHubOfficeTabs.setQuick(appKey, {
            save: false,
            undo: false,
            redo: false,
            print: false,
            search: false,
          });
        }
      }
      notifyDocTitle();
    }

    function openFile(file) {
      if (!file || !file.fileId) return Promise.resolve(false);
      // 파일 열기가 오면 보류 중인 자동 새 문서 진입을 취소한다 —
      // 빈 문서가 먼저 뜨면 파일이 그 뒤에 줄을 서게 된다 (2026-11-13).
      if (autoNewTimer) {
        clearTimeout(autoNewTimer);
        autoNewTimer = null;
      }
      if (opening) {
        // 진행 중이거나 대기 중인 것과 같은 파일이면 중복 실행만
        // 막는다 (열기 패널 연속 확정 뒤).
        if (openingFile && openingFile.fileId === file.fileId) return Promise.resolve(false);
        if (queuedOpen && queuedOpen.fileId === file.fileId) return Promise.resolve(false);
        // 다른 열기(자동 새 문서가 붙은 뒤)가 진행 중이면 요청을
        // 버리지 않고 대기열에 넣는다. Finder가 파일을 내기
        // 핸드셰이크는 앱 붙임 직후에 도착하는데, autoNew는 빈 문서
        // 열기와 겹치면 종전에는 요청이 조용히 사라져 "가끔만 남고
        // 빈 문서"가 맞다 (2026-11-04 세션 보고의 근본 원인).
        var superseded = queuedOpenWaiters;
        queuedOpenWaiters = [];
        superseded.forEach(function (w) {
          w(false);
        });
        queuedOpen = file;
        return new Promise(function (resolve) {
          queuedOpenWaiters.push(resolve);
        });
      }
      return runOpenFile(file);
    }

    /* 열기가 끝날 때까지 대기열을 확인해 이어 연다 */
    function finishOpening() {
      opening = false;
      openingFile = null;
      if (!queuedOpen) return;
      var file = queuedOpen;
      queuedOpen = null;
      var waiters = queuedOpenWaiters;
      queuedOpenWaiters = [];
      openFile(file).then(function (r) {
        waiters.forEach(function (w) {
          w(r);
        });
      });
    }

    function runOpenFile(file) {
      opening = true;
      openingFile = file;
      if (openBtn) openBtn.disabled = true;
      getFetchApi().expectVersion(file.fileId, file.version);
      showProgress('받는 중…', null);
      var v;
      try {
        v = getViewer();
      } catch (e) {
        finishOpening();
        if (openBtn) openBtn.disabled = false;
        hideProgress();
        return Promise.resolve(false);
      }
      // v.open의 동기 throw가 있으면 opening을 영원히 고정한다 앱
      // 호출 자체를 then 안에 넣어 걸로 바꾼다.
      return Promise.resolve()
        .then(function () {
          return v.open({ fileId: file.fileId, name: file.name, mime: file.mime, version: file.version });
        })
        .then(
        function () {
          finishOpening();
          if (openBtn) openBtn.disabled = false;
          hideProgress();
          current = {
            fileId: file.fileId, name: file.name, mime: file.mime || '',
            version: file.version || null,
            folderId: file.folderId === undefined ? null : file.folderId,
            folderName: file.folderName || '', isNew: false,
          };
          closedHandled = false;
          updateChrome();
          getMemory().record(current);
          return true;
        },
        function () {
          finishOpening();
          if (openBtn) openBtn.disabled = false;
          hideProgress();
          return false;
        },
      );
    }

    function newDocument() {
      if (!app.canCreate || opening) return Promise.resolve(false);
      opening = true;
      showProgress('여는 중…', null);
      // 서식 파일(앱)한글 의 빈문서 바이트를 먼저 받아서 넣는다. 서식파일을
      // 못 받으면 문서를 열지 않는 앱 빈 껍데기만 첫 창하지 않는다.
      var bytesReady = app.templateUrl
        ? Promise.resolve()
            .then(function () {
              return baseFetch(versionedAssetUrl(app.templateUrl));
            })
            .then(function (res) {
              if (!res || !res.ok) throw new Error('template http ' + (res && res.status));
              return res.arrayBuffer();
            })
        : Promise.resolve(null);
      return bytesReady
        .then(function (bytes) {
          // getViewer/open의 동기 throw가 있으면 opening를 고정하므로
          // 호출을 then 안에 넣어 걸로 바꾼다 (openFile과 같은 이유).
          return getViewer().open({
            fileId: 0, name: app.newTitle, mime: app.newMime, version: null,
            bytes: bytes || undefined,
          });
        })
        .then(
          function () {
            finishOpening();
            hideProgress();
            current = {
              fileId: 0, name: app.newTitle, mime: app.newMime, version: null,
              folderId: null, folderName: '', isNew: true,
            };
            closedHandled = false;
            updateChrome();
            return true;
          },
          function () {
            finishOpening();
            hideProgress();
            // 자동 진입이 실패했으면 시작 화면을 내보내거나 한다
            // (문서가 열려 있으면 updateChrome가 그대로 감춘 화면)
            updateChrome();
            return false;
          },
        );
    }

    // 문서를 접은 뒤의 화면: 자동 새 문서 앱(한글·한글)의 시작 화면으로
    // 돌아가지 않고 빈 문서를 새로 연다. 그 앱 앱 시작 화면으로.
    function handleClosed() {
      current = null;
      if (autoNew && app.canCreate) {
        newDocument();
        return;
      }
      updateChrome();
      getMemory().render();
    }

    // 닫힘 처리 단 한번만: 코어 close()의 루트 이벤트(myhub:viewer-close)를
    // 아래 closeCurrent를 직접 호출해 겹쳐서 중복 실행하지 않는다.
    // 문서를 새로 열 때마다 다시 무장한다.
    var closedHandled = true;
    function onViewerClosed() {
      if (closedHandled) return;
      closedHandled = true;
      handleClosed();
    }

    function closeCurrent() {
      if (viewer) viewer.close();
      onViewerClosed();
    }

    // ---------- 다른 이름으로 저장 (새 문서의 첫 저장) ----------
    function createSaveFlow(blob, file, ctx) {
      return openPicker('save', { initialName: file.name }).then(function (sel) {
        if (!sel) {
          ctx.setStatus('문서를 취소했습니다');
          return false;
        }
        var fd = new FormData();
        fd.append('files', blob, sel.name);
        if (sel.folderId) fd.append('folder_id', String(sel.folderId));
        return Promise.resolve()
          .then(function () {
            return baseFetch('/api/drive/files', { method: 'POST', body: fd });
          })
          .then(function (res) {
            if (!res || !res.ok) throw new Error('create http ' + (res && res.status));
            return res.json();
          })
          .then(function (body) {
            var saved = body && body.files && body.files[0];
            if (!body || !body.ok || !saved) throw new Error('create shape');
            // 파일을 열어 서버가 생성한다 앱 id·이름이 즉시 확정한다.
            // 여기서 실패로 보고하면 사용자가 재시도해 중복 파일이
            // 생긴다. 생성 응답에는 version이 없어 폴더 참조로
            // storage_key를 올리는데, 그건 최선 노력이다: 실패하면
            // version을 빈 채로 갖고(다음 호스트 base_version 없는
            // 재저장 PUT) 저장 자체를 성공으로 보고한다.
            file.fileId = saved.id;
            file.name = sel.name;
            file.version = null;
            return listFolder(sel.folderId)
              .then(function (listing) {
                var row = (listing.files || []).filter(function (f) { return f.id === saved.id; })[0];
                if (row) file.version = row.version || null;
              })
              .catch(function (err) {
                // 올리기 실패는 저장 성공을 삼키지 않는다 앱 오직 조용히
                // 삼키지 않고 진단 흔적을 남긴다 (다음 호스트
                // base_version 없는 재저장 PUT를 낸다).
                file.adoptError = String((err && err.message) || err);
              })
              .then(function () {
                current = {
                  fileId: saved.id, name: sel.name, mime: file.mime || '',
                  version: file.version,
                  folderId: sel.folderId, folderName: sel.folderName || '', isNew: false,
                };
                // 올리기에 이름이 쓸 수 없기가 아니라 창 제목줄로 간다
                updateChrome();
                getMemory().record(current);
                return true;
              });
          })
          .catch(function () {
            ctx.setStatus('저장에 실패했습니다');
            return false;
          });
      });
    }

    // ---------- 열기/저장 패널 (office-picker.js가 전임) ----------
    var K_FOLDER = 'myhub.office.' + appKey + '.lastFolder.v1';
    function listFolder(id) {
      return Promise.resolve()
        .then(function () {
          return baseFetch('/api/drive/list' + (id ? '?folder=' + id : ''));
        })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('list http ' + (res && res.status));
          return res.json();
        });
    }
    var pickerInstance = null;
    function openPicker(mode, opts) {
      if (!pickerInstance) {
        var factory = deps.pickerFactory ||
          (typeof window !== 'undefined' && window.MyHubOfficePicker
            ? window.MyHubOfficePicker.createPicker
            : null);
        if (!factory) return Promise.resolve(null);
        pickerInstance = factory({
          doc: doc,
          listFolder: listFolder,
          icons: icons,
          exts: app.exts,
          appKey: appKey,
          newTitle: app.newTitle,
          newExt: app.newExt || '',
          loadLastFolder: function () { return storeGet(K_FOLDER, null); },
          saveLastFolder: function (v) { storeSet(K_FOLDER, v); },
          importFile: importDriveFile,
        });
      }
      return pickerInstance.open(mode, opts);
    }

    // 일명 "이 기계에서 가져오기": 기계 파일을 보관함 폴더로 올린다.
    // 파일 생성 POST는 createSaveFlow와 같은 계약(files 파트 + folder_id).
    function importDriveFile(file, folderId) {
      var fd = new FormData();
      fd.append('files', file, file.name);
      if (folderId) fd.append('folder_id', String(folderId));
      return Promise.resolve()
        .then(function () {
          return baseFetch('/api/drive/files', { method: 'POST', body: fd });
        })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('import http ' + (res && res.status));
          return res.json();
        })
        .then(function (body) {
          var saved = body && body.files && body.files[0];
          if (!body || !body.ok || !saved) throw new Error('import shape');
          return { id: saved.id, filename: saved.filename || file.name };
        });
    }

    // ---------- 그림 삽입 (엔진 상태에서 찾아보기 전임) ----------
    // 그림 선택은 기본 경로를 언제든 본체이든 앱 엔진이 OS 파일
    // 선택기를 열지 않고 호스트 일괄을 연다. 기계에서 새로 가져온
    // 경우만 일괄 안의 분리된 가져오기(importFile)가 맞는다.
    // 옵션의 정보는 office-picker.js가 호출하는 공용 값이다 (Finder
    // 호스트와 같은 값 앱 허용 그림 형식을 한글에서만 관리한다).
    // 일괄 모듈이 없으면 그림 삽입 자체가 성립하지 않으므로, 그 경우
    // 아래 리스트는 열기를 시도하지 않는다.
    var PICTURE_PICK_OPTS =
      typeof window !== 'undefined' && window.MyHubOfficePicker
        ? window.MyHubOfficePicker.PICTURE_PICK_OPTS
        : null;
    // 미디어 삽입 (DeckCraft의 오디오·비디오·파일 찾아보기 가) 전임
    // 그림과 같은 계약으로 목적별 형식 필터가 다르다. 확장자 집합은
    // 엔진(DeckCraft web)의 선택기 필터가 정보이다.
    var MEDIA_PICK_OPTS = {
      audio: {
        exts: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff'],
        title: '오디오 삽입',
        confirmLabel: '삽입',
        importable: true,
        accept: 'audio/*',
      },
      video: {
        exts: ['mp4', 'm4v', 'mov', 'webm'],
        title: '비디오 삽입',
        confirmLabel: '삽입',
        importable: true,
        accept: 'video/*',
      },
      theme: {
        exts: ['thmx', 'pptx', 'potx', 'ppsx'],
        title: '파일 선택',
        confirmLabel: '적용',
        importable: true,
        accept: '',
      },
    };
    function fetchPictureBytes(fileId) {
      return Promise.resolve()
        .then(function () {
          return baseFetch('/api/drive/files/' + fileId + '/content');
        })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('picture http ' + (res && res.status));
          return res.arrayBuffer();
        })
        .catch(function () {
          return null; // 실패하면 엔진에 보내지 않는다 앱 상태는 닫힌 채널로 둔다
        });
    }

    // ---------- 앱 메모리 (office-memory.js가 전임) ----------
    var memoryInstance = null;
    function getMemory() {
      if (memoryInstance) return memoryInstance;
      var factory = deps.memoryFactory ||
        (typeof window !== 'undefined' && window.MyHubOfficeMemory
          ? window.MyHubOfficeMemory.createMemory
          : null);
      if (!factory) {
        return { record: function () {}, render: function () {}, openRecent: function () { return Promise.resolve(false); } };
      }
      memoryInstance = factory({
        doc: doc,
        storage: storage,
        appKey: appKey,
        icons: icons,
        listFolder: listFolder,
        openFile: openFile,
      });
      return memoryInstance;
    }

    // ---------- 배선 ----------
    // 오피스 앱 앱 (방송 작업 2): 뷰어 호스트가 엔진 앱 상태를 받아
    // 넣으면 office-tabs.js가 상단 행에 앱더블로이를 그려고, 클릭이 다시
    // 뷰어 호스트의 명령 채널로 돌아간다. 앱 연동(myhub:office-tabs
    // postMessage)는 office-tabs.js가 맞는다.
    var tabsEl = el('officeTabs');
    if (tabsEl && typeof window !== 'undefined' && window.MyHubOfficeTabs) {
      // 배치 주의: #finderViewer는 position:fixed 전체화면 오버레이
      // (z-60)앱 페이지 흐름의 앱 행 그 앱에 깔려 클릭이 앱 없다 앱
      // 행을 뷰어 루트 앱, 본문(fvBody) 바로 앞으로 앱 문서 표면을
      // 위로 만든다. 문서가 없을 때(앱)는 뷰어뿐이므로 앱으로 앱도
      // 함께 사라지는 것이 맞다.
      var fvBodyEl = el('fvBody');
      if (fvBodyEl && fvBodyEl.parentNode) {
        fvBodyEl.parentNode.insertBefore(tabsEl, fvBodyEl);
      }
      window.MyHubOfficeTabs.mount({
        doc: doc,
        win: typeof window !== 'undefined' ? window : null,
        appKey: appKey,
        rootEl: tabsEl,
      });
      // 빠른 실행 (제목 줄): 호스트 앱 앱 공통으로 앱 앱이 맞는다 앱
      // 미니멀 접기는 명시 저장 경로를 Ctrl+S를 코어 앱 핸들러로
      // 그대로 앱에 보낸다 (뷰어 코어의 저장 경로 단일과 유지).
      // 옛 office-tabs(캐시)가 앞에 붙은 붙임이 끊기지않게 가용한다.
      if (typeof window.MyHubOfficeTabs.onQuick === 'function') {
        window.MyHubOfficeTabs.onQuick(appKey, function (action) {
        if (action === 'save') {
          if (!current) return false;
          var View =
            typeof window !== 'undefined' ? window : doc.defaultView;
          if (!View || typeof View.KeyboardEvent !== 'function') return false;
          doc.dispatchEvent(
            new View.KeyboardEvent('keydown', {
              key: 's',
              ctrlKey: true,
              bubbles: true,
            }),
          );
          return true;
        }
        return false;
      });
      }
    }
    function refreshIcons() {
      try {
        if (typeof window !== 'undefined' && window.lucide) window.lucide.createIcons();
      } catch (e) {
        console.warn('오피스 아이콘 새로고침 실패:', e);
      }
    }
    function init() {
      doc.title = app.title + ' · MyHub';
      var appName = el('officeAppName');
      if (appName) appName.textContent = app.title;
      var brandName = el('officeBrandName');
      if (brandName) brandName.textContent = app.title;
      var brandIcon = el('officeBrandIcon');
      if (brandIcon && icons) brandIcon.innerHTML = icons.svgFor(app.iconKind);
      var startIcon = el('officeStartIcon');
      if (startIcon && icons) startIcon.innerHTML = icons.svgFor(app.iconKind);
      var startName = el('officeStartName');
      if (startName) startName.textContent = app.title;
      var startDesc = el('officeStartDesc');
      if (startDesc) startDesc.textContent = app.desc;
      // 새로 만들기: 만든 뒤 있는 앱만 보인다 현재 (이 앱 앱
      // 모두 만든 뒤 있다 가 canCreate꺾인 앱 앱 예의 앱 않는다).
      var startNew = el('officeStartNew');
      if (app.canCreate) {
        if (newBtn) newBtn.hidden = false;
        if (startNew) startNew.hidden = false;
      }
      if (openBtn) openBtn.addEventListener('click', function () {
        openPicker('open').then(function (file) { if (file) openFile(file); });
      });
      // 문서가 닫힌 때 다른 파일을 여는 경로는 앱 자체 메뉴(한글
      // Studio 파일 메뉴 등)의 Finder가 앱 뷰어의 [파일 열기] 버튼을
      // 앱지 않는다 (사용자 지시: 앱 앱 버튼 제거).
      var startOpen = el('officeStartOpen');
      if (startOpen) startOpen.addEventListener('click', function () {
        openPicker('open').then(function (file) { if (file) openFile(file); });
      });
      if (newBtn) newBtn.addEventListener('click', newDocument);
      if (startNew) startNew.addEventListener('click', newDocument);
      if (closeBtn) closeBtn.addEventListener('click', closeCurrent);
      // 뷰어 닫힘·열기 요청은 코어 루트 이벤트로 따라간다 앱 어느
      // 표면(플로팅 크롬·시트 메뉴·PDF 도구줄)의 접기/열기가
      // 앱 상태가 같은 경로로 나뉜다.
      var viewerRootEl = el('finderViewer');
      if (viewerRootEl) {
        viewerRootEl.addEventListener('myhub:viewer-close', onViewerClosed);
        viewerRootEl.addEventListener('myhub:request-open', function () {
          openPicker('open').then(function (file) { if (file) openFile(file); });
        });
        // 그림 삽입 전임: 고른 그림을 바이트로 deliver로 표면에 알린
        // 이유. 취소하면 deliver를 부르지 않는다 앱 엔진 상태는
        // 이유 없는 것을 취소로 안다 (열기 전임과 같은 계약).
        viewerRootEl.addEventListener('myhub:request-picture', function (e) {
          var deliver = e && e.detail && e.detail.deliver;
          if (typeof deliver !== 'function' || !PICTURE_PICK_OPTS) return;
          openPicker('open', PICTURE_PICK_OPTS).then(function (sel) {
            if (!sel) return;
            return fetchPictureBytes(sel.fileId).then(function (bytes) {
              if (bytes) deliver(sel.name, bytes);
            });
          });
        });
        // 미디어 삽입 전임 (DeckCraft 오디오·비디오·파일): 목적별
        // 일괄 옵션을 연다는 앱 그림 삽입과 다르고, 바이트를
        // deliver로 알려주는 계약이 같다. 취소하면 deliver를 부르지
        // 않는다.
        viewerRootEl.addEventListener('myhub:request-media', function (e) {
          var detail = (e && e.detail) || {};
          var deliver = detail.deliver;
          if (typeof deliver !== 'function') return;
          var opts = MEDIA_PICK_OPTS[detail.purpose];
          if (!opts) return;
          openPicker('open', opts).then(function (sel) {
            if (!sel) return;
            return fetchPictureBytes(sel.fileId).then(function (bytes) {
              if (bytes) deliver(sel.name, bytes);
            });
          });
        });
      }
      updateChrome();
      getMemory().render();
      refreshIcons();
      if (autoNew && app.canCreate) {
        // 한글·엑셀 앱: 시작 화면을 거치지 않고 빈 문서로 바로 진입한다.
        // 시작 화면은 마크업에서 hidden로 시작하므로 그 앱이 없고,
        // 자동 진입이 실패하면 updateChrome가 내보낸다.
        // 진입을 200ms 미룬다 (2026-11-13): 데스크톱에서 파일을 갖고 여는
        // 경우 부팅 직후 myhub:open-file이 도착하는데, 빈 문서를 먼저
        // 만들면 파일 열기가 그 뒤에 줄을 서서 빈 문서 로딩이 파일 로딩
        // 전에 보이는 '뭐가 있다' 상태가 된다. 200ms 안에 파일 열기가
        // 오면 openFile이 타이머를 취소하고 파일만 연다.
        autoNewTimer = setTimeout(function () {
          autoNewTimer = null;
          if (startEl) startEl.hidden = true;
          newDocument();
        }, 200);
      }
    }
    init();

    return {
      appKey: appKey,
      notifyDocTitle: notifyDocTitle,
      openFile: openFile,
      newDocument: newDocument,
      openPicker: openPicker,
      openRecent: function (entry) { return getMemory().openRecent(entry); },
      closeCurrent: closeCurrent,
      getCurrent: function () { return current; },
    };
  }

  var api = { APPS: APPS, parseAppKey: parseAppKey, createApp: createApp };
  if (typeof window !== 'undefined') window.MyHubOffice = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOffice = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 단독 실행 열기 판정: ?file=<id>(&name=&mime=&folder=&folderName=)
  // Finder 단독 실행에서 오피스 파일을 앱 앱 앱 으로 바로 이어주는
  // 경로다. 숫자가 아닌 file 값은 열기 판정으로 인정하지 않는다.
  function parseOpenTarget(search) {
    var params;
    try {
      params = new URLSearchParams(String(search || ''));
    } catch (e) {
      return null;
    }
    var raw = params.get('file');
    if (!raw) return null;
    var fileId = Number(raw);
    if (!isFinite(fileId) || fileId <= 0) return null;
    var folderRaw = params.get('folder');
    var folderId = folderRaw ? Number(folderRaw) : null;
    return {
      fileId: fileId,
      name: params.get('name') || '',
      mime: params.get('mime') || '',
      version: params.get('version') || null,
      folderId: isFinite(folderId) && folderId ? folderId : null,
      folderName: params.get('folderName') || '',
    };
  }

  api.parseOpenTarget = parseOpenTarget;

  // 실제 페이지에서만 자동 붙임한다 (테스트는 createApp를 직접 부른다)
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('officeStart')) {
    // 비서 반(office-assistant.js)가 현재 문서·앱 문서 만들기에 접근한다
    var bootKey = parseAppKey(window.location.search);
    var bootTarget = parseOpenTarget(window.location.search);
    var bootApp = createApp({
      doc: document,
      storage: window.localStorage || null,
      search: window.location.search,
      // 열기 판정이 있으면 빈 문서를 만들지 않고 그 파일부터 연다
      autoNew: !bootTarget && APPS[bootKey].autoNew === true,
    });
    window.MyHubOfficeApp = bootApp;
    if (bootTarget) bootApp.openFile(bootTarget);
    // 데스크톱 창 앱: Finder가 내기 파일 열기를 같은 핸드셰이크로
    // 받는다 (ready 앱 open-file 앱 ack). 앱 ready 앱 요청을 보냈다가
    // 다시 전한다.
    if (window.parent && window.parent !== window) {
      window.addEventListener('message', function (e) {
        if (e.origin !== window.location.origin) return;
        var d = e.data;
        if (!d) return;
        // 임의 제목 덮어쓰기 요청: 앱이 load 완료 완료 앱에 알린 파일명이 임의
        // load 처리로 지정된 경우만 현재 제목 통신으로 치유한다
        // (2026-11-06 image-117 앱 바탕에 앱 이름만 남던 결합).
        if (d.type === 'myhub:request-doc-title') {
          bootApp.notifyDocTitle();
          return;
        }
        if (d.type !== 'myhub:open-file') return;
        bootApp.openFile({
          fileId: d.fileId,
          name: d.name,
          mime: d.mime,
          version: d.version || null,
          folderId: d.folderId === undefined ? null : d.folderId,
          folderName: d.folderName || '',
        });
        try {
          window.parent.postMessage(
            { type: 'myhub:open-file-ack', app: bootKey, fileId: d.fileId },
            window.location.origin,
          );
        } catch (err) {
          console.warn('파일 열기 확인 전송 실패:', err);
        }
      });
      try {
        window.parent.postMessage(
          { type: 'myhub:office-ready', app: bootKey },
          window.location.origin,
        );
      } catch (err) {
        console.warn('오피스 준비 알림 실패:', err);
      }
    }
  }
})();
