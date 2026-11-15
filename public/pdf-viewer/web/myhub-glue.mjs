// MyHub 글루 — pdf.js 뷰어와 MyHub 호스트(finder-format-pdf.js) 사이의
// postMessage 계약을 잇는다. 2026-11-07 소실 사고로 사라져 2026-11-15에
// 재건했다. viewer.html이 viewer.mjs 뒤에 이 파일을 모듈로 로드한다.
// viewer.html을 pdf.js upstream으로 다시 가져오면 이 <script> 태그를
// 다시 넣어야 한다 (viewer.html 안의 주석 참조).
//
// 계약 (호스트가 기대하는 메시지):
//   뷰어→호스트: myhub-pdf:appready / myhub-pdf:ready {pages} /
//     myhub-pdf:state {page, pages} / myhub-pdf:dirty {dirty} /
//     myhub-pdf:saved {bytes} / myhub-pdf:save-error /
//     myhub-pdf:shortcut-save
//   호스트→뷰어: myhub-pdf:open-bytes {bytes, filename} / myhub-pdf:reload /
//     myhub-pdf:request-save
//
// 이 글루가 없으면 호스트는 ready를 절대 받지 못해 20초 타이머가
// 항상 발동하고, 대체 화면(샌드박스 iframe)으로 바뀌어 크롬이 PDF를
// 차단한다 ("Chrome에서 차단한 페이지입니다" — 2026-11-15 사용자 보고).
(function () {
  'use strict';
  var ORIGIN = window.location.origin;
  var embedded = window.parent && window.parent !== window;

  function post(msg, transfer) {
    if (!embedded) return;
    try {
      window.parent.postMessage(msg, ORIGIN, transfer || []);
    } catch (err) {
      // postMessage 실패는 조용히 무시한다 (호스트가 이미 닫힌 경우).
    }
  }

  function currentPages(app) {
    try {
      return app.pagesCount || 0;
    } catch (err) {
      return 0;
    }
  }
  function currentPage(app) {
    try {
      return app.page || 1;
    } catch (err) {
      return 1;
    }
  }

  // 주석 변경 추적: 뷰어 자체도 onSetModified/onResetModified를
  // 쓰므로(_initializeAnnotationStorageCallbacks) 덮지 않고 체인한다.
  // 문서마다 annotationStorage가 새로 만들어지므로 문서 로드 때마다
  // 다시 묶는다 (스토리지 객체에 플래그를 달아 이중 래핑을 막는다).
  function wireDirty(app) {
    var doc;
    try {
      doc = app.pdfDocument;
    } catch (err) {
      return;
    }
    if (!doc || !doc.annotationStorage) return;
    var storage = doc.annotationStorage;
    if (storage.__myhubWrapped) return;
    storage.__myhubWrapped = true;
    var prevSet = storage.onSetModified;
    var prevReset = storage.onResetModified;
    storage.onSetModified = function () {
      if (typeof prevSet === 'function') prevSet();
      post({ type: 'myhub-pdf:dirty', dirty: true });
    };
    storage.onResetModified = function () {
      if (typeof prevReset === 'function') prevReset();
      post({ type: 'myhub-pdf:dirty', dirty: false });
    };
  }

  function onDocumentLoaded(app) {
    wireDirty(app);
    post({ type: 'myhub-pdf:ready', pages: currentPages(app) });
    post({ type: 'myhub-pdf:state', page: currentPage(app), pages: currentPages(app) });
  }

  function wireApp(app) {
    // 호스트→뷰어 메시지 (같은 출처의 부모만).
    window.addEventListener('message', function (e) {
      if (e.origin !== ORIGIN) return;
      if (!embedded || e.source !== window.parent) return;
      var d = e.data || {};
      if (d.type === 'myhub-pdf:open-bytes') {
        if (!d.bytes) return;
        try {
          var data = d.bytes instanceof Uint8Array ? d.bytes : new Uint8Array(d.bytes);
          app.open({ data: data, filename: d.filename || 'document.pdf' });
        } catch (err) {
          // open 실패는 뷰어 자체 오류 UI에 맡긴다.
        }
      } else if (d.type === 'myhub-pdf:reload') {
        // 서버 파일은 ?file= URL을 다시 열어 최신 바이트를 받는다.
        var file = null;
        try {
          file = new URLSearchParams(window.location.search).get('file');
        } catch (err) {
          file = null;
        }
        if (file) {
          try {
            app.open({ url: file });
          } catch (err) {
            // open 실패는 뷰어 자체 오류 UI에 맡긴다.
          }
        }
      } else if (d.type === 'myhub-pdf:request-save') {
        var doc = null;
        try {
          doc = app.pdfDocument;
        } catch (err) {
          doc = null;
        }
        if (!doc || typeof doc.saveDocument !== 'function') {
          post({ type: 'myhub-pdf:save-error' });
          return;
        }
        doc
          .saveDocument()
          .then(function (bytes) {
            // slice()로 정확히 맞는 크기의 버퍼를 만들어 전송한다
            // (원본 버퍼가 더 클 수 있다).
            var buf = bytes.slice().buffer;
            post({ type: 'myhub-pdf:saved', bytes: buf }, [buf]);
          })
          .catch(function () {
            post({ type: 'myhub-pdf:save-error' });
          });
      }
    });

    // Ctrl/Cmd+S는 호스트 저장으로 라우팅한다 (임베드된 경우만 —
    // 단독으로 열린 뷰어에서는 뷰어 자체 저장을 건드리지 않는다).
    if (embedded) {
      window.addEventListener(
        'keydown',
        function (e) {
          if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
          if (e.key !== 's' && e.key !== 'S') return;
          e.preventDefault();
          e.stopPropagation();
          post({ type: 'myhub-pdf:shortcut-save' });
        },
        true,
      );
    }

    var bus = null;
    try {
      bus = app.eventBus;
    } catch (err) {
      bus = null;
    }
    if (bus && typeof bus.on === 'function') {
      bus.on('documentloaded', function () {
        onDocumentLoaded(app);
      });
      bus.on('pagechanging', function (evt) {
        var page = evt && evt.pageNumber ? evt.pageNumber : currentPage(app);
        post({ type: 'myhub-pdf:state', page: page, pages: currentPages(app) });
      });
    }

    // 앱 초기화 완료를 호스트에 알린다 (바이트 문서는 이 신호를
    // 받고 open-bytes를 보낸다).
    post({ type: 'myhub-pdf:appready' });

    // 글루가 늦게 붙어 documentloaded를 놓친 경우: 이미 문서가
    // 열려 있으면 ready를 바로 보낸다.
    var alreadyLoaded = false;
    try {
      alreadyLoaded = !!app.pdfDocument;
    } catch (err) {
      alreadyLoaded = false;
    }
    if (alreadyLoaded) onDocumentLoaded(app);
  }

  function boot() {
    var app = window.PDFViewerApplication;
    if (!app) {
      // viewer.mjs가 아직 평가되지 않은 경우 잠깐 기다린다
      // (모듈 실행 순서상 정상 경로에서는 이미 존재한다).
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        app = window.PDFViewerApplication;
        if (app || tries >= 100) {
          clearInterval(timer);
          if (app) waitInit(app);
        }
      }, 100);
      return;
    }
    waitInit(app);
  }

  function waitInit(app) {
    var p = null;
    try {
      p = app.initializedPromise;
    } catch (err) {
      p = null;
    }
    if (p && typeof p.then === 'function') {
      p.then(function () {
        wireApp(app);
      }).catch(function () {
        // 초기화 실패 시에도 와이어링을 시도한다 (부분 동작).
        wireApp(app);
      });
    } else {
      wireApp(app);
    }
  }

  boot();
})();
