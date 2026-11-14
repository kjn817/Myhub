// 파인더 뷰어 플러그인 모듈 — PDF (finder-format-pdf.js)
// 자체 호스 pdf.js generic 트한(public/pdf-viewer/, build-pdf-viewer.mjs뷰어
// 재생산)를 iframe로 프레임한다. 설정검 색스트림 레이어
// 주석 편집기이며 입력과 뷰어가 마감고, 길이 글루(myhub-glue.js)로
// postMessage 계약으로 saveDocument() 를 받아 코어 putContent
// (base_version)로만 보낸다. 페이지 조작회전(삭제)추출 pdf-lib병합를
// 실행 전에만 지연 로딩해 finder-pdf-ops.js 순수 함수로 수행한다 등 전부
// 같은 파일 계약(PUT/POST + version 증가)를 이룬다.
// 대관: 뷰어가 준비 호가를 죽인 실패 하면 사이(sandbox 버로 프레임)선택으로
// 강행한 내부 자체에 맞지 않는다. 경계 고정: 본문 그림 직접 편집할 등 하고
// (주석 쓰기인 경로) XFA 양식 제한한다. 10MB 초과한 상한을 먼저 알린다.
(function () {
  'use strict';
  var core = typeof window !== 'undefined' ? window.MyHubFinderViewer : null;
  if (!core) return;
  // Drive 파일 API 베이스 경로 (S5-4, 5-9) — constants.js 선행 로드.
  var constants =
    (typeof window !== 'undefined' && window.MyHubConstants) ||
    (typeof globalThis !== 'undefined' && globalThis.MyHubConstants) ||
    null;
  if (!constants) throw new Error('[finder-format-pdf.js] constants.js가 먼저 로드되어야 합니다');
  var pdfOps = typeof window !== 'undefined' ? window.MyHubFinderPdfOps : null;
  if (!pdfOps) return; // finder-pdf-ops.js가 먼저 로드돼야 한다
  // PdfCraft 브리지 호스트 (finder-pdfcraft.js) 가 없으면(구 로드 순서
  // 테스트로) pdf.js 실행맡으로 동작한다 (대관 보존).
  var pdfCraft = typeof window !== 'undefined' ? window.MyHubFinderPdfCraft : null;

  var ORIGIN =
    typeof window !== 'undefined' && window.location ? window.location.origin : '';
  var PDF_MIME = 'application/pdf';
  var SAVE_LIMIT = 10 * 1024 * 1024;
  var VIEWER_PAGE = '/pdf-viewer/web/viewer.html';
  var NOTE =
    '전용 뷰어등 찾기 돋보기 주석양식 입력은. 합니다 본문그림 직접 편집과 XFA 양식 제한합니다';

  // 테스트가 주요한 등 있는 다음만 (회사 경로의 기본값 그림으로)
  var internals = {
    readyTimeoutMs: 20000,
    saveTimeoutMs: 30000,
    libLoader: null, // null이 면 pdf-lib본다 지연 import
    pickerFactory: null, // null이면 window.MyHubOfficePicker 사용
  };

  // 동적 로딩 URL과 공용 헬퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 등 버전 없는 URL과 immutable 캐시를 고정할 등 있다).
  // 헬퍼가 없는 환경(테스트 등)에서는 원본 URL 그림이다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }
  var pdfLibPromise = null;
  function loadPdfLib() {
    if (internals.libLoader) return internals.libLoader();
    if (!pdfLibPromise) {
      pdfLibPromise = import(versionedAssetUrl('/vendor/pdf-lib/pdf-lib.esm.min.js')).catch(function (err) {
        pdfLibPromise = null; // 실패는 캐시하지 않는다
        throw err;
      });
    }
    return pdfLibPromise;
  }

  function buildViewerUrl(contentUrl) {
    return VIEWER_PAGE + '?file=' + encodeURIComponent(contentUrl);
  }

  function handlePdf(ctx) {
    // 쓰기인 텍스트 래스(rasterizeText)터화화 의 문서를 캔버스로
    // 그린 등 Drive '의' 폰트 등 록이 미리 시작해 본다.
    // load()의 reject하지 않는 계약이라 기다려 않게 걸어만 본다.
    var fonts = typeof window !== 'undefined' ? window.MyHubFonts : null;
    if (fonts && typeof fonts.load === 'function') fonts.load();
    if (!ctx.file.fileId && !ctx.file.bytes) {
      ctx.showMessage('PDF 문서가 없습니다. 보관함에 있는 PDF를 여세요.');
      return Promise.resolve();
    }
    mount(ctx);
    return Promise.resolve();
  }

  function mount(ctx) {
    var doc = ctx.doc;
    ctx.clearBody();
    ctx.body.classList.add('fv-fill');
    // 편집 값은 오프인 "저장할 바이트 테스 트가"있는가: 서버 파일
    // (fileId)숨기고, 템플릿 바이트로 등등 문서 면(bytes)편집 길이
    // 한다 (빈 문서의 첫 길이가 코어 createSave가 만든다). 이 뷰어
    // 프레임 문서를 받는 경로인 옆에 등 서버 파일의 content URL,
    // 바이트 문서의 appready 등 open-bytes 주어이다 (아래 hasServerFile).
    var hasServerFile = !!ctx.file.fileId;
    var editable = hasServerFile || !!ctx.file.bytes;
    var state = { ready: false, fellBack: false, dirty: false, page: 1, pages: 0, busy: false, saveWaiter: null, surface: 'viewer', craft: null, craftReady: false, viewerDead: false };

    // 차 반 흡수 (교정 파일 등, 캡처 image-145 + 스 트림 흡수
    // 앞의 파일): PdfCraft 모드 반(메뉴 등 + 모드 등 + 검색스트림
    // 등)의 문서 등 스트 림에 엔진이 그림이고 호스트가 하나에 값는
    // 등 메뉴의 등 상단바(office-tabs 메뉴 계약), 모드 담린 차 등 등
    // 행이 그림과, 문서 제목인 차 반 제목 하나로만 지정한다. 엔진의
    // chrome=nomodetabs,nomenubar,nomodebar,notabstrip URL로 이름
    // 등 행이 모두가 없다 (이 스트림의 이름붙어설정말로
    // 인클린된 호스트 메뉴가 파일한 등 등조건
    // docs/pdfcraft-tabstrip-absorb-prereg-20261106.md).
    // 모드 탭(모든 도구·편집·변환·전자 서명)은 호스트 탭 행에 게시하지 않는다
    // (2026-11-12 사용자 지적: 엔진 사이드바 패널 제목과 똑같이 중복된다).
    // 엔진 사이드바가 모드별 도구 목록을 보여주는 유일한 네비게이션이며,
    // 모드 탭을 빼면 탭 행은 메뉴만 남아 셸이 채택한 뒤에는 숨겨진다
    // (office-tabs render가 그릴 것이 없으면 행을 가린다). 메뉴는 상단바에
    // 그대로 남는다. MODE_TABS 상수는 엔진 모드 id 목록으로만 남긴다.
    var MODE_TABS = [
      { id: 'all', label: '모든 도구', kind: 'tab' },
      { id: 'edit', label: '편집', kind: 'tab' },
      { id: 'convert', label: '변환', kind: 'tab' },
      { id: 'sign', label: '전자 서명', kind: 'tab' },
    ];
    var tabsHost = !!(
      ctx.minimalChrome &&
      typeof window !== 'undefined' &&
      window.MyHubOfficeTabs
    );
    var lastMode = null;
    var lastMenus = null;
    function menuTabs() {
      if (!Array.isArray(lastMenus)) return [];
      var out = [];
      lastMenus.forEach(function (m) {
        if (!m || typeof m.id !== 'string' || typeof m.label !== 'string') return;
        out.push({ id: 'menu:' + m.id, label: m.label, kind: 'menu' });
      });
      return out;
    }
    var providedMenu = null;
    function shellMenuNodes(nodes, base) {
      var out = [];
      (Array.isArray(nodes) ? nodes : []).forEach(function (n) {
        if (!n || typeof n !== 'object') return;
        var path = base.concat(out.length);
        if (n.separator) {
          out.push({ separator: true, path: path });
          return;
        }
        if (typeof n.label !== 'string' || !n.label) return;
        var node = { label: n.label, disabled: !!n.disabled, path: path };
        if (typeof n.shortcut === 'string' && n.shortcut) {
          node.shortcut = n.shortcut;
        }
        if (typeof n.checked === 'boolean') node.checked = n.checked;
        if (Array.isArray(n.items) && n.items.length) {
          node.children = shellMenuNodes(n.items, path);
        } else if (typeof n.command === 'string' && n.command) {
          node.command = n.command;
          if (n.params && typeof n.params === 'object') node.params = n.params;
        }
        out.push(node);
      });
      return out;
    }
    function provideMenu(id, seq) {
      var api = typeof window !== 'undefined' ? window.MyHubOfficeTabs : null;
      if (!api || typeof api.provideMenuItems !== 'function') return;
      var engineId =
        typeof id === 'string' && id.indexOf('menu:') === 0 ? id.slice(5) : id;
      var menu = null;
      (Array.isArray(lastMenus) ? lastMenus : []).forEach(function (m) {
        if (m && m.id === engineId) menu = m;
      });
      var nodes = menu ? shellMenuNodes(menu.items, []) : [];
      providedMenu = { id: id, nodes: nodes };
      api.provideMenuItems('pdf', id, nodes, seq);
    }
    function execMenu(id, path) {
      if (!providedMenu || providedMenu.id !== id) return;
      if (!Array.isArray(path) || !path.length || !state.craft) return;
      var nodes = providedMenu.nodes;
      var node = null;
      for (var i = 0; i < path.length; i++) {
        node = nodes ? nodes[path[i]] : null;
        if (!node) return;
        nodes = node.children;
      }
      if (node && typeof node.command === 'string' && node.command) {
        state.craft.sendMenuCommand(node.command, node.params);
      }
    }
    function publishModeTabs() {
      if (!tabsHost || typeof window.MyHubOfficeTabs.setState !== 'function') return;
      if (state.surface !== 'craft' || !state.craft) {
        window.MyHubOfficeTabs.setState('pdf', null);
        return;
      }
      // 모드 탭은 게시하지 않는다 (엔진 사이드바와 중복 — 위 MODE_TABS 주석).
      // 메뉴 탭만 게시하면 셸이 채택한 뒤 탭 행은 그릴 것이 없어 숨겨진다.
      var menus = menuTabs();
      var tabs = menus.slice();
      window.MyHubOfficeTabs.setState('pdf', {
        tabs: tabs,
        activeId: null,
        collapsed: false,
        canCollapse: false,
        menuShell: menus.length > 0,
        menuLocal: menus.length > 0,
      });
    }
    // 차 반 인쇄 (교정 파일 등): 인쇄 엔진 메 뉴의 print.dialog
    // 명령을 어떻게 등 메뉴 명령 채널로 그림으로 실행한다. 편집기 실행은
    // 주인 공이라 본다 (뷰어 실행에서는 엔진 인쇄 경로가 없다).
    function publishPrintQuick() {
      if (!tabsHost || typeof window.MyHubOfficeTabs.setQuick !== 'function') return;
      var on = state.surface === 'craft' && state.craftReady && !!state.craft;
      window.MyHubOfficeTabs.setQuick('pdf', { print: on });
    }
    if (tabsHost && typeof window.MyHubOfficeTabs.onCommand === 'function') {
      window.MyHubOfficeTabs.onCommand('pdf', function (cmd) {
        if (!ctx.isCurrent() || !state.craft) return;
        if (cmd.type === 'select') {
          if (typeof cmd.id === 'string' && cmd.id.indexOf('menu:') === 0) return;
          state.craft.sendMode(cmd.id);
        } else if (cmd.type === 'menu-request') {
          provideMenu(cmd.id, cmd.seq);
        } else if (cmd.type === 'menu-exec') {
          execMenu(cmd.id, cmd.path);
        }
      });
      if (typeof window.MyHubOfficeTabs.onQuick === 'function')
        window.MyHubOfficeTabs.onQuick('pdf', function (action) {
        if (action !== 'print') return false;
        if (!ctx.isCurrent() || state.surface !== 'craft' || !state.craft) {
          return false;
        }
        return state.craft.sendMenuCommand('print.dialog');
      });
    }

    var tools = null;
    var stateEl = null;
    var panel = null;
    if (editable) {
      var minimal = !!ctx.minimalChrome;
      // 스튜(디오)미만의 에서는 호스트 도구를 만들지 않는다 등 PdfCraft가
      // 파일메뉴 페이지 도구회전(삭제정리)병합상태 표시를 전부 가지
      // 완성한 편집기이며, 호스트 [파일] 메뉴 ops를 중을
      // 보면 차 제목의 아래에 중첩 바꾼 앉힌 (사용자 지정 2026-11-03,
      // PPT와 같은 것). 길 PdfCraft 이가 실행(호)가를 Ctrl+S가
      // 마감고, 실행 편집기 하나로 고정한다 (뷰어의 로딩대관 전용).
      // Finder(의) 뷰어에서는 종전 도구 중이 그림으로 온다.
      if (!minimal) {
        tools = doc.createElement('div');
        // 페이지 작업이 바뀌면 작업인 너비를 온다 접근(보기) 실행에서는 온다.
        tools.className = 'fv-pdf-tools fv-foldable';
        stateEl = doc.createElement('span');
        stateEl.className = 'fv-pdf-state';
        stateEl.textContent = '불러오는 중';
        tools.appendChild(stateEl);
        [
          ['rotate', '페이지 회전'],
          ['delete', '페이지 삭제'],
          ['extract', '범위 추출'],
          ['merge', '다른 PDF와 병합'],
        ].forEach(function (pair) {
          var b = mkBtn(pair[1], function () {
            onOp(pair[0]);
          });
          b.className = 'fv-pdf-op';
          b.dataset.act = pair[0];
          tools.appendChild(b);
        });
        ctx.body.appendChild(tools);
      }
      panel = doc.createElement('div');
      panel.className = 'fv-pdf-panel';
      panel.hidden = true;
      ctx.body.appendChild(panel);
    }

    var frame = doc.createElement('iframe');
    frame.className = 'fv-frame fv-pdf-frame';
    frame.title = ctx.file.name;
    // 뷰어 깊이 같은 출처의 자체 페이지를 등 sheet.html와 같은 최소
    // 선택(스크립트 실행 + 같은 출처 자체의 로딩)를 필요하다.
    // allow-modals는 뷰어 자체 인쇄(window.print)를 필수 선택한다 등
    // 없으면 브라우저가 인쇄노출을 조용히 무시한다 의 (PdfCraft 프레임워크
    // 같은 기록 그림, 2026-11-06).
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
    frame.src = hasServerFile ? buildViewerUrl(ctx.contentUrl()) : VIEWER_PAGE;
    ctx.body.appendChild(frame);

    var readyTimer = setTimeout(function () {
      if (!state.ready && ctx.isCurrent()) fallback();
    }, internals.readyTimeoutMs);

    function postToViewer(type, payload, transfer) {
      if (!frame.contentWindow) return;
      var msg = { type: type };
      if (payload) Object.assign(msg, payload);
      frame.contentWindow.postMessage(msg, ORIGIN, transfer || []);
    }

    function updateStateLabel() {
      if (stateEl) {
        stateEl.textContent = state.pages > 0 ? state.page + ' / ' + state.pages + ' 페이지' : '불러오는 중';
      }
    }

    function onMessage(e) {
      if (e.origin !== ORIGIN) return;
      if (frame.contentWindow && e.source && e.source !== frame.contentWindow) return;
      if (!ctx.isCurrent()) {
        window.removeEventListener('message', onMessage);
        return;
      }
      if (state.fellBack) return; // 강행한 안에 뒤쭉 등 뷰어 호가를 무시한다
      var d = e.data || {};
      if (d.type === 'myhub-pdf:appready') {
        if (!hasServerFile) {
          // 바이트로 주요한 문서(서버 대변 없음)를 등 준비 안에 보낸다.
          // fetchContent가 복사본을 주요로 transfer를 넘어간 원본의 건다.
          ctx.fetchContent('buffer').then(function (buf) {
            if (ctx.isCurrent()) {
              postToViewer('myhub-pdf:open-bytes', { bytes: buf, filename: ctx.file.name }, [buf]);
            }
          });
        }
      } else if (d.type === 'myhub-pdf:ready') {
        state.ready = true;
        state.pages = d.pages || state.pages;
        clearTimeout(readyTimer);
        if (state.surface === 'viewer') ctx.setNote(NOTE);
        updateStateLabel();
      } else if (d.type === 'myhub-pdf:state') {
        state.page = d.page || state.page;
        state.pages = d.pages || state.pages;
        updateStateLabel();
      } else if (d.type === 'myhub-pdf:dirty') {
        state.dirty = !!d.dirty;
        if (state.dirty) {
          ctx.setStatus('담리지 않은 변경이 있습니다');
          ctx.markDirty(); // 저장 버튼 '에도 변경'있음 표시한다
        }
      } else if (d.type === 'myhub-pdf:saved' || d.type === 'myhub-pdf:save-error') {
        var waiter = state.saveWaiter;
        state.saveWaiter = null;
        if (waiter) waiter(d.type === 'myhub-pdf:saved' ? { ok: true, bytes: d.bytes } : { ok: false });
      } else if (d.type === 'myhub-pdf:shortcut-save') {
        if (editable && !state.fellBack) doSave();
      }
    }
    window.addEventListener('message', onMessage);

    // 뷰어 로드 실패 등 사이 버로 강행한 (내부 맞지 않는다).
    // 등 PdfCraft 세션이 내부 있는 동안 DOM를 건드려 않게 등
    // 편집기 실행은 명확한 뷰어 강행인 도구까지 건드려 등 한다.
    // 강행한 사실만 기억해 알고, 편집기까지 죽으면 그만 force로 강행한다.
    function fallback(force) {
      if (state.fellBack) return;
      if (state.craft && !force) {
        state.viewerDead = true;
        return;
      }
      state.fellBack = true;
      clearTimeout(readyTimer);
      if (tools) tools.remove();
      if (panel) panel.remove();
      if (ctx.saveBtn) ctx.saveBtn.hidden = true;
      ctx.setSaveHandler(function () {
        ctx.setStatus('기본 미리보기에서는 저장할 수 없습니다');
        return Promise.resolve(false);
      });
      var native = doc.createElement('iframe');
      native.className = 'fv-frame';
      // 사이버로 미리보기 스크립트 없이 표시만 (감사 D14과 동일)
      native.setAttribute('sandbox', '');
      native.src = ctx.contentUrl();
      frame.replaceWith(native);
      frame = native;
      ctx.setNote('전용 뷰어를 불러오지 못해 기본 미리보기로 표시합니다 (주석 조작등 합니다)');
    }

    // ---------- PdfCraft 편집기 실행 (finder-pdfcraft.js 브리지) ----------
    // 파일 실행 접이 모델: 실행 실행 전용 편집기(PdfCraft), 아래면
    // pdf.js 의뷰어는 (Finder처럼 접이가 없는 호스트에서만 하나가 있다)
    // 편집 기는 안에 ready전용이 확인된
    // 뒤에만 앞으로 나오고, 그 전에 pdf.js 실행 그림으로 보인다 등
    // ready가 실패 없으면(위치ailed) 편집기만 조용히 닮고 뷰어의
    // 온다 (대관 보존, 주요 화면 금지).
    var CRAFT_NOTE =
      '전용 편집기등 페이지 정리주석 양식 입력은 합니다. 본문 그림 직접 편집은 제한합니다';

    function wantCraft() {
      return editable && !!pdfCraft && !ctx.isFolded();
    }

    // 뷰어 프레 임을 아래로 display:none등 지지 않는다: pdf.js의
    // 레이아웃 없는 문서에서 페이지의 offsetParent가 null라, 문서
    // 숨긴이 실은때의 초기 스크롤이 라는 "offsetParent is not set -- cannot
    // scroll" 콘솔 오류를 맡번 남긴 (기록: 편집기 실행으로 전환한 등
    // 뒤쭉 생략 숨긴 에서). 포함 0높이로 작업 레이아웃 박스를 남기면
    // 내부 레이아웃 앉힌 그 오류가 수 않게, 선택하면 즉시 원래
    // 그림. visibility이다 와 함께 0높이 앉힌 그림지지 않게 한다.
    function parkViewerFrame() {
      frame.style.flex = '0 0 0px';
      frame.style.height = '0px';
      frame.style.minHeight = '0px';
      frame.style.visibility = 'hidden';
    }
    function unparkViewerFrame() {
      frame.style.flex = '';
      frame.style.height = '';
      frame.style.minHeight = '';
      frame.style.visibility = '';
    }

    function showCraft() {
      if (!state.craft) return;
      parkViewerFrame();
      state.craft.frame.style.display = '';
      state.surface = 'craft';
      ctx.setNote(CRAFT_NOTE);
      if (stateEl) stateEl.textContent = '전용 편집기';
      publishModeTabs();
      publishPrintQuick();
    }

    function showViewer() {
      if (state.craft) state.craft.frame.style.display = 'none';
      unparkViewerFrame();
      state.surface = 'viewer';
      updateStateLabel();
      publishModeTabs();
      publishPrintQuick();
    }

    function stopCraft() {
      if (!state.craft) return;
      state.craft.destroy();
      state.craft = null;
      state.craftReady = false;
      publishModeTabs();
      publishPrintQuick();
    }

    // 접근 상태로 파한 때의 공통 마감은: 편집기를 닮고 뷰어를 최신
    // 바이트로 다시 쏘았다 (편집기 길이가 얼굴 직후만 불편한).
    function settleBackToViewer() {
      stopCraft();
      showViewer();
      if (state.ready) postToViewer('myhub-pdf:reload');
    }

    function startCraft() {
      if (state.craft || !wantCraft()) return;
      var host = pdfCraft.createHost({
        doc: doc,
        win: window,
        parentEl: ctx.body,
        name: ctx.file.name,
        // 차 반 흡수 (교정 파일 등): 스튜디오 실행에서는 모드 바꾼 등
        // URL로 건다 등 메뉴의 등 상단바고, 모드 담린 차 등 등 행이
        // 파. Finder 일 하 URL(다 의 종전 를).
        url: tabsHost && pdfCraft.APP_URL_HOSTED ? pdfCraft.APP_URL_HOSTED : undefined,
        onModeState: function (mode) {
          if (!ctx.isCurrent()) return;
          lastMode = mode;
          publishModeTabs();
        },
        onMenusState: function (menus) {
          if (!ctx.isCurrent()) return;
          lastMenus = menus;
          publishModeTabs();
        },
        onRequestOpen: function () {
          // 엔진 자체 숨긴 위임: 고정 PDF의 호스트 숨긴 경로로
          // 다시 가져온 실행 계속까지 등 파일로 가져왔다 (시트의 같은
          // 계약). 취소하면 조용히 생략한.
          if (ctx.isCurrent()) ctx.requestOpen();
        },
        onReady: function () {
          if (!ctx.isCurrent()) {
            stopCraft();
            return;
          }
          state.craftReady = true;
          ctx.fetchContent('buffer').then(function (buf) {
            if (!ctx.isCurrent() || !state.craft) return;
            if (state.craft.open(ctx.file.name, buf)) showCraft();
          });
        },
        onDirty: function (dirty) {
          if (!ctx.isCurrent()) return;
          state.dirty = dirty;
          if (dirty) {
            ctx.setStatus('담리지 않은 변경이 있습니다');
            ctx.markDirty();
          } else if (ctx.isFolded() && state.surface === 'craft') {
            // 작업 등 동안 길이가 얼굴 dirty가 되다 등 미째 등 뷰어
            // 실행 전환은 지금 수행한다 (변경 취소 방식).
            settleBackToViewer();
          }
        },
        onSave: function (evt) {
          if (!ctx.isCurrent()) return;
          if (!evt || !evt.bytes) {
            ctx.setStatus('처음에 실패했습니다');
            return;
          }
          if (evt.bytes.byteLength > SAVE_LIMIT) {
            ctx.setStatus('10MB를 초과한 저장할 수 없습니다');
            return;
          }
          var blob = new Blob([evt.bytes], { type: PDF_MIME });
          var done = function (ok) {
            if (!ok) return;
            state.dirty = false;
            if (ctx.isFolded() && state.surface === 'craft') settleBackToViewer();
          };
          // 브리지가 saveAs를구동해 주요로 다른 이름 저장 흐름의 코어의
          // saveAsContent 흐름으로 보낸다 (시트의 같은 파일 계약).
          if (evt.saveAs && evt.name && evt.name !== ctx.file.name) {
            ctx.saveAsContent(blob, evt.name).then(done);
          } else {
            ctx.putContent(blob).then(done);
          }
        },
        onFallback: function () {
          if (!ctx.isCurrent()) return;
          var wasCraft = state.surface === 'craft';
          stopCraft();
          if (state.viewerDead) {
            fallback(true);
            return;
          }
          if (wasCraft) {
            showViewer();
            ctx.setNote('전용 편집기를 불러오지 못해 기본 뷰어로 표시합니다');
          }
          // 뷰 어가 처음 부터 등(ready 앉은 경우)위치인 조용히
          // 편집기만 답는다 등 보듯 화면을 방해하지 않는다.
        },
      });
      if (!host) return;
      state.craft = host;
      // 준비기 간까지 pdf.js 실행 주인공이다
      host.frame.style.display = 'none';
    }

    // 접이/펼치기에 실행 맞춘 (접근 호스트에서만 하나가 있다)
    function syncSurfaceToFold() {
      if (!ctx.isCurrent() || state.fellBack) return;
      if (ctx.isFolded()) {
        if (state.surface === 'craft' && !state.dirty) settleBackToViewer();
        // dirty인 동안 편집기 실행 유지하는 등 dirty가 등리 등
        // onDirty/onSave가 전환은 마감한다.
      } else if (state.surface === 'viewer') {
        if (state.dirty) {
          // 뷰어의 미세 변경을 먼저 저장해 편집기가 최신 바이트로
          // 이룬다. 길이가 실패하면 실행 반쯤 않고.
          doSave().then(function (ok) {
            if (ok && ctx.isCurrent() && !ctx.isFolded()) startCraft();
          });
        } else {
          startCraft();
        }
      }
    }
    if (ctx.chromeFold) ctx.onFoldChange(syncSurfaceToFold);

    function doSave() {
      if (state.surface === 'craft') {
        // 브리지나 호스트가 길이를 요청한 메시지가가 없는 등 길이
        // 편집기 앉힌 파일 동작인 pdfcraft:save로 올려 본다 만 실패한다.
        if (state.dirty) {
          ctx.setStatus('편집기 화면에서 저장하세요 (편집기의 파일 또는 Ctrl+S)');
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      }
      if (state.fellBack) {
        ctx.setStatus('기본 미리보기에서는 저장할 수 없습니다');
        return Promise.resolve(false);
      }
      if (!state.ready || !frame.contentWindow) {
        ctx.setStatus('뷰어가 아직 준비되지 않았습니다');
        return Promise.resolve(false);
      }
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          if (state.saveWaiter) {
            state.saveWaiter = null;
            ctx.setStatus('편집기 응답이 없습니다');
            resolve(false);
          }
        }, internals.saveTimeoutMs);
        state.saveWaiter = function (res) {
          clearTimeout(timer);
          if (!res.ok) {
            ctx.setStatus('처음에 실패했습니다');
            resolve(false);
            return;
          }
          var bytes = res.bytes;
          // 서버 400에 맞린 전에 상한을 먼저 알린다 (강제 경계 지정)
          if (bytes && bytes.byteLength > SAVE_LIMIT) {
            ctx.setStatus('10MB를 초과한 저장할 수 없습니다');
            resolve(false);
            return;
          }
          var blob = new Blob([bytes], { type: PDF_MIME });
          ctx.putContent(blob).then(function (ok) {
            if (ok) state.dirty = false;
            resolve(ok);
          });
        };
        postToViewer('myhub-pdf:request-save');
      });
    }

    if (editable) {
      if (ctx.saveBtn) ctx.saveBtn.hidden = false;
      ctx.setSaveHandler(doSave);
    }
    // 실행 실행(기본)에서는 전용 편집기를 백그라운드로 전용인 등
    // ready가 오면 showCraft가 실행 교체한다.
    startCraft();

    // ---------- 페이지 조작 ----------
    function closePanel() {
      if (!panel) return;
      panel.hidden = true;
      panel.innerHTML = '';
    }
    function mkBtn(text, onClick) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (onClick) b.addEventListener('click', onClick);
      return b;
    }

    function askConfirm(message) {
      return new Promise(function (resolve) {
        if (!panel) {
          resolve(false);
          return;
        }
        panel.innerHTML = '';
        var msg = doc.createElement('span');
        msg.className = 'fv-pdf-panel-msg';
        msg.textContent = message;
        panel.appendChild(msg);
        panel.appendChild(
          mkBtn('실행', function () {
            closePanel();
            resolve(ctx.isCurrent());
          }),
        );
        panel.appendChild(
          mkBtn('취소', function () {
            closePanel();
            resolve(false);
          }),
        );
        panel.hidden = false;
      });
    }

    // 조작인 담린 바이트가 기본이다 등 파일 등등 등 변경이 있으면 먼저 저장해 취하고, 얼굴 뷰어를 새로 앉는다.
    function runStoredOp(label, opFn, refetchOther) {
      if (state.busy) return Promise.resolve(false);
      state.busy = true;
      var chain = state.dirty ? doSave() : Promise.resolve(true);
      return chain
        .then(function (ok) {
          if (!ok || !ctx.isCurrent()) throw new Error('__abort');
          return ctx.fetchContent('buffer');
        })
        .then(function (buf) {
          return loadPdfLib().then(function (lib) {
            return refetchOther
              ? refetchOther().then(function (other) {
                  return opFn(lib, buf, other);
                })
              : opFn(lib, buf);
          });
        })
        .then(function (newBytes) {
          var blob = new Blob([newBytes], { type: PDF_MIME });
          if (blob.size > SAVE_LIMIT) {
            ctx.setStatus('10MB를 초과한 저장할 수 없습니다');
            return false;
          }
          return ctx.putContent(blob);
        })
        .then(function (ok) {
          state.busy = false;
          if (ok) {
            ctx.setStatus(label + ' 을 저장했습니다');
            if (state.surface === 'craft' && state.craft) {
              // 편집기 실행에서 최신 바이트로 다시 여는 것은 새로고침이다
              ctx.fetchContent('buffer').then(function (buf) {
                if (ctx.isCurrent() && state.craft) state.craft.open(ctx.file.name, buf);
              });
            } else {
              postToViewer('myhub-pdf:reload');
            }
          }
          return ok;
        })
        .catch(function (err) {
          state.busy = false;
          if (err && err.message === '__abort') return false;
          ctx.setStatus(label + '이 실패했습니다' + (err && err.message ? ': ' + err.message : ''));
          return false;
        });
    }

    // 파일 비서 세션 (office-assistant 연동) 파일
    // 지연 자체가 사용자의 명령대로 확인 단락 없이 기존 파일 경로
    // (runStoredOp)를 그림으로 이룬다. 쓰기인 텍스트는 한글 폰트를 pdf-lib가
    // 모든 그림진 캔버스의 등 PNG 와 overlayImage 회피로 앉는다 (내보내기 고정).
    function rasterizeText(text, sizePt, color) {
      var scale = 3;
      var cv = doc.createElement('canvas');
      var font = sizePt * scale + 'px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
      var g0 = cv.getContext('2d');
      g0.font = font;
      var w = Math.max(1, Math.ceil(g0.measureText(text).width));
      var h = Math.ceil(sizePt * scale * 1.5);
      cv.width = w;
      cv.height = h;
      var g = cv.getContext('2d');
      g.font = font;
      g.fillStyle = color || '#c81e1e';
      g.textBaseline = 'middle';
      g.fillText(text, 0, h / 2);
      return new Promise(function (resolve, reject) {
        cv.toBlob(function (blob) {
          if (!blob) {
            reject(new Error('텍스트 이미지 생성 실패'));
            return;
          }
          blob.arrayBuffer().then(function (ab) {
            resolve({ png: new Uint8Array(ab), widthPt: w / scale, heightPt: h / scale });
          }, reject);
        }, 'image/png');
      });
    }

    session = {
      kind: 'pdf',
      ctx: ctx,
      getState: function () {
        return { page: state.page, pageCount: state.pages };
      },
      applyOps: function (ops) {
        // 파일경계 값은 운영 (2026-11-07 행위 결정인 그날 수정): 비서
        // 연산의 담린 바이트를 기본으로 PUT 까지 값인
        // 경로인. 아래 상태에서 그 경로가 등록하지 않게도 종전이나
        // runStoredOp로 그림으로 넘어가, 미세 문서에서의 행동 첫 파일
        // 흐름(다른 이름 으로 파일)일괄 를 지정 중간에 취소하면
        // "쓰기인 파일 실패"는 뭐든 실패로만 그린다. 일괄을
        // 앞지 않고, 등 연산의 확신한 사용으로 정확하게 실패시킨.
        // - fileId 없: 음 담 리 를. 먼 저 한다.
        // - 대관(사이버로 미리보기): 편집 하단이 없다.
        // - 편집기(craft) 실행 + 미세 변경: 브리지가 호스트 파일의
        //   요청 하 단이(없어 파일 pdfcraft저장 request-save가
        //   없다) 편집기 변경을 담리와 취한 등 없다.
        var blocked = !ctx.file.fileId
          ? '문서가 아직 담리지 않았어요. 먼저 문서를 저장한 뒤에 지정해 주세요.'
          : state.fellBack
            ? '기본 미리보기에서는 문서를 고칠 수 없어요.'
            : state.surface === 'craft' && state.dirty
              ? '편집기에 담리지 않은 변경이 있어요. 편집기에서 먼저 저장한 뒤에 지정해 주세요.'
              : null;
        if (blocked) {
          return Promise.resolve({
            applied: 0,
            errors: (ops || []).map(function (_op, idx) {
              return { index: idx, message: blocked };
            }),
          });
        }
        var applied = 0;
        var errors = [];
        var chain = Promise.resolve();
        (ops || []).forEach(function (op, idx) {
          chain = chain.then(function () {
            if (op.type === 'rotate_page') {
              return runStoredOp('페이지 회전', function (lib, buf) {
                return pdfOps.rotatePage(lib, buf, op.page);
              }).then(function (ok) {
                if (ok) applied += 1;
                else errors.push({ index: idx, message: '회전 저장 실패' });
              });
            }
            if (op.type === 'delete_page') {
              return runStoredOp('페이지 삭제', function (lib, buf) {
                return pdfOps.deletePage(lib, buf, op.page);
              }).then(function (ok) {
                if (ok) applied += 1;
                else errors.push({ index: idx, message: '삭제 저장 실패' });
              });
            }
            if (op.type === 'extract_pages') {
              // 비서 경로인 일괄 없이 파일 이름으로 최상에 저장한
              var saveChain = state.dirty ? doSave() : Promise.resolve(true);
              return saveChain
                .then(function (ok) {
                  if (!ok) throw new Error('저장 실패');
                  return ctx.fetchContent('buffer');
                })
                .then(function (buf) {
                  return loadPdfLib().then(function (lib) {
                    return pdfOps.extractPages(lib, buf, op.from, op.to);
                  });
                })
                .then(function (newBytes) {
                  var fd = new FormData();
                  fd.append('files', new Blob([newBytes], { type: PDF_MIME }), derivedName(' (추출)'));
                  return ctx.fetchRaw(constants.DRIVE_FILES_API, { method: 'POST', body: fd });
                })
                .then(function (res) {
                  if (!res || !res.ok) throw new Error('추출본 저장 실패');
                  applied += 1;
                })
                .catch(function (err) {
                  errors.push({ index: idx, message: String((err && err.message) || err) });
                });
            }
            if (op.type === 'overlay_text') {
              return rasterizeText(op.text, op.size || 14, op.color)
                .then(function (img) {
                  return runStoredOp('텍스트 래스터화', function (lib, buf) {
                    return pdfOps.overlayImage(lib, buf, op.page, img.png, {
                      x: typeof op.x === 'number' ? op.x : 36,
                      y: typeof op.y === 'number' ? op.y : 36,
                      width: img.widthPt,
                      height: img.heightPt,
                    });
                  });
                })
                .then(function (ok) {
                  if (ok) applied += 1;
                  else errors.push({ index: idx, message: '래스터화 저장 실패' });
                })
                .catch(function (err) {
                  errors.push({ index: idx, message: String((err && err.message) || err) });
                });
            }
            errors.push({ index: idx, message: '지원하지 않는 연산: ' + op.type });
            return undefined;
          });
        });
        return chain.then(function () {
          return { applied: applied, errors: errors };
        });
      },
    };

    // 일괄을 마지막으로 만든 (이전 숨긴를 ctx 이로 방식). 같은 DOM리스너 겹쳐에 일괄을 자기 가 state없을 등 확정 취소가 no-op이라 안전하다.
    var picker = null;
    function getPicker() {
      var factory =
        internals.pickerFactory ||
        (typeof window !== 'undefined' && window.MyHubOfficePicker
          ? window.MyHubOfficePicker.createPicker
          : null);
      if (!factory || !doc.getElementById('officePicker')) return null;
      if (!picker) {
        picker = factory({
          doc: doc,
          icons: typeof window !== 'undefined' ? window.MyHubFileIcons || null : null,
          exts: ['pdf'],
          appKey: 'pdf',
          newTitle: '제목 없음.pdf',
          newExt: '.pdf',
          listFolder: function (id) {
            return ctx.fetchRaw('/api/drive/list' + (id ? '?folder=' + id : '')).then(function (res) {
              if (!res || !res.ok) throw new Error('list http ' + (res && res.status));
              return res.json();
            });
          },
        });
      }
      return picker;
    }

    function derivedName(suffix) {
      return ctx.file.name.replace(/\.pdf$/i, '') + suffix + '.pdf';
    }

    function onOp(act) {
      var readyNow = state.surface === 'craft' ? state.craftReady : state.ready;
      if (!readyNow || state.busy || state.fellBack) {
        if (!readyNow) ctx.setStatus('뷰어가 아직 준비되지 않았습니다');
        return;
      }
      if (act === 'rotate') {
        var page = state.page;
        askConfirm(page + '페이지를 90도 회전합니다').then(function (yes) {
          if (!yes) return;
          runStoredOp('페이지 회전', function (lib, buf) {
            return pdfOps.rotatePage(lib, buf, page);
          });
        });
      } else if (act === 'delete') {
        var dpage = state.page;
        if (state.pages <= 1) {
          ctx.setStatus('마지막 페이지는 삭제할 수 없습니다');
          return;
        }
        askConfirm(dpage + '페이지를 삭제합니다').then(function (yes) {
          if (!yes) return;
          runStoredOp('페이지 삭제', function (lib, buf) {
            return pdfOps.deletePage(lib, buf, dpage);
          });
        });
      } else if (act === 'extract') {
        openExtractPanel();
      } else if (act === 'merge') {
        openMerge();
      }
    }

    function openExtractPanel() {
      if (!panel) return;
      panel.innerHTML = '';
      var label = doc.createElement('span');
      label.className = 'fv-pdf-panel-msg';
      label.textContent = '추출한 페이지 범위';
      function rangeInput(value) {
        var input = doc.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = String(state.pages || 1);
        input.value = String(value);
        input.className = 'fv-pdf-range';
        return input;
      }
      var from = rangeInput(state.page || 1);
      var to = rangeInput(state.pages || state.page || 1);
      var tilde = doc.createElement('span');
      tilde.textContent = '~';
      var go = mkBtn('추출', function () {
        var f = Number(from.value);
        var t = Number(to.value);
        closePanel();
        if (!ctx.isCurrent() || state.busy) return;
        runExtract(f, t);
      });
      var cancel = mkBtn('취소', closePanel);
      [label, from, tilde, to, go, cancel].forEach(function (el) {
        panel.appendChild(el);
      });
      panel.hidden = false;
    }

    // 추출본은 파일이다 등 일괄이 있으면 이름 폴더를 정하고,
    // 없으면 보관함 최상에 파일 이름으로 POST한다 (기존 POST 계약).
    function runExtract(from, to) {
      state.busy = true;
      var chain = state.dirty ? doSave() : Promise.resolve(true);
      chain
        .then(function (ok) {
          if (!ok || !ctx.isCurrent()) throw new Error('__abort');
          return ctx.fetchContent('buffer');
        })
        .then(function (buf) {
          return loadPdfLib().then(function (lib) {
            return pdfOps.extractPages(lib, buf, from, to);
          });
        })
        .then(function (newBytes) {
          var picker = getPicker();
          var naming = picker
            ? picker.open('save', { initialName: derivedName(' (추출)') })
            : Promise.resolve(null);
          return naming.then(function (sel) {
            var fd = new FormData();
            var name = sel && sel.name ? sel.name : derivedName(' (추출)');
            fd.append('files', new Blob([newBytes], { type: PDF_MIME }), name);
            if (sel && sel.folderId) fd.append('folder_id', String(sel.folderId));
            if (picker && !sel) throw new Error('__abort'); // 일괄 취소는 조용히 생략한
            return ctx
              .fetchRaw(constants.DRIVE_FILES_API, { method: 'POST', body: fd })
              .then(function (res) {
                if (!res || !res.ok) throw new Error('create http ' + (res && res.status));
                ctx.setStatus('추출본을 저장했습니다: ' + name);
              });
          });
        })
        .catch(function (err) {
          if (!err || err.message !== '__abort') {
            ctx.setStatus('범위 추출이 실패했습니다' + (err && err.message ? ': ' + err.message : ''));
          }
        })
        .then(function () {
          state.busy = false;
        });
    }

    function openMerge() {
      var picker = getPicker();
      if (!picker) {
        ctx.setStatus('병합할 파일을 고정할 수 없습니다');
        return;
      }
      picker.open('open').then(function (sel) {
        if (!sel || !sel.fileId || !ctx.isCurrent()) return;
        if (sel.fileId === ctx.file.fileId) {
          ctx.setStatus('같은 파일을 병합할 수 없습니다');
          return;
        }
        askConfirm('"' + sel.name + '"의 페이지를 안에 붙였습니다').then(function (yes) {
          if (!yes) return;
          runStoredOp(
            'PDF 병합',
            function (lib, buf, other) {
              return pdfOps.mergePdfs(lib, buf, other);
            },
            function () {
              return ctx.fetchRaw(constants.DRIVE_FILES_API + '/' + sel.fileId + '/content').then(function (res) {
                if (!res || !res.ok) throw new Error('http ' + (res && res.status));
                return res.arrayBuffer();
              });
            },
          );
        });
      });
    }
  }

  // PDF 실행 자체 너비를([파일] 메뉴 중)에 가진다 등 코어 플로우
  // 에러리스트를 겹치지 않게 코어에 알린다 스튜디 (오에서만 하나가 있다)
  handlePdf.ownsChrome = true;
  core.registerFormat('pdf', handlePdf);

  // 전용 편집 PDF기를 불러 오지 (못했 습니다)
  var session = null;

  var api = {
    handlePdf: handlePdf,
    buildViewerUrl: buildViewerUrl,
    internals: internals,
    NOTE: NOTE,
    getSession: function () {
      return session && session.ctx.isCurrent() ? session : null;
    },
  };
  if (typeof window !== 'undefined') window.MyHubFinderFormatPdf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
