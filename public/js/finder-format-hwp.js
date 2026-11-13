// 파인더 뷰어 플러그 모듈 등 HWP/HWPX (finder-format-hwp.js)
// 보기: 벡터 @rhwp/core 0.8.7(public/vendor/rhwp)만한 지정 로딩해
//       페이지를 SVG로 렌더한다. measureTextWidth 호스트 함수
//       Canvas 2D로 주입한다 (게이트 1에서 검증한 규칙).
// 편집: rhwp-studio 자체 호스(/rhwp-studio/)트만 @rhwp/editor SDK로
//       프레임한다. 저장 등 내보낸 바이트를 코어 putContent(base_version)
//       로 올린다.
// 대관: rhwp 로딩 렌더가 HWPX실패하면 의기존 JSZip 본문 추출
//       미리보기로, HWP는 안내 문구로 강행한다 (기능이 아예 않는다).
// 삭제된 고정 배너를 두지 않는다 (사용자 지정 2026-11-02로 아래 제거 등
// 번호 폰트와 휴먼르미체트고딕 없어 줄바꿈등 문제 등 있다
// 사실 자체의 docs에만 남긴다).
(function () {
  'use strict';
  var core = typeof window !== 'undefined' ? window.MyHubFinderViewer : null;
  if (!core) return;

  // 동적 로딩 URL과 공용 헬퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 등 버전 없는 URL과 immutable 캐시를 고정할 등 있다).
  // 헬퍼가 없는 환경(테스트 등)에서는 원본 URL 그림이다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }

  var ORIGIN =
    typeof window !== 'undefined' && window.location ? window.location.origin : '';

  var rhwpReady = null; // 초기화된 @rhwp/core 모듈 Promise (성공 시에만 유지)
  var kordocReady = null; // 초기화된 kordoc 모듈 Promise (성공 시에만 유지)

  function installMeasureTextWidth() {
    if (typeof globalThis === 'undefined') return;
    if (typeof globalThis.measureTextWidth === 'function') return;
    var canvas = document.createElement('canvas');
    var g = canvas.getContext && canvas.getContext('2d');
    if (!g) return;
    var lastFont = null;
    globalThis.measureTextWidth = function (font, text) {
      if (font !== lastFont) {
        g.font = font;
        lastFont = font;
      }
      return g.measureText(text).width;
    };
  }

  function loadRhwp(ctx) {
    if (rhwpReady) return rhwpReady;
    var p = ctx
      .loadLib('rhwp')
      .then(function (mod) {
        if (!mod || typeof mod.default !== 'function' || typeof mod.HwpDocument !== 'function') {
          throw new Error('rhwp 모듈 형태가 올바르지 않습니다');
        }
        installMeasureTextWidth();
        return fetch(versionedAssetUrl('/vendor/rhwp/rhwp_bg.wasm'))
          .then(function (res) {
            if (!res || !res.ok) throw new Error('rhwp wasm를 불러오지 못했습니다');
            return res.arrayBuffer();
          })
          .then(function (wasmBytes) {
            // 바이트를 직접 씌워도 .wasm MIME기본 지지 않는다
            return mod.default({ module_or_path: wasmBytes }).then(function () {
              return mod;
            });
          });
      })
      .catch(function (err) {
        if (rhwpReady === p) rhwpReady = null; // 실패는 캐시하지 않는다
        throw err;
      });
    rhwpReady = p;
    return p;
  }

  // kordoc(문서 파싱 엔진, public/vendor/kordoc 의 scripts/build-kordoc.mjs가
  // 브라우저 배치를 재생산한): 비서 세션의 텍스트 추출 전용이다.
  // 렌더 편집 경로는 rhwp기존가 그대로 만든다.
  function loadKordoc(ctx) {
    if (kordocReady) return kordocReady;
    var p = ctx
      .loadLib('kordoc')
      .then(function (mod) {
        if (!mod || typeof mod.parse !== 'function') {
          throw new Error('kordoc 모듈 형태가 올바르지 않습니다');
        }
        return mod;
      })
      .catch(function (err) {
        if (kordocReady === p) kordocReady = null; // 실패는 캐시하지 않는다
        throw err;
      });
    kordocReady = p;
    return p;
  }

  function destroyEditor(state) {
    if (state.editor && typeof state.editor.destroy === 'function') {
      try {
        state.editor.destroy();
      } catch (e) {
        state.editor = null;
      }
    }
    state.editor = null;
    if (state.dirtyWatch && state.dirtyWatch.timers) {
      state.dirtyWatch.timers.forEach(function (t) {
        clearTimeout(t);
      });
      state.dirtyWatch.timers = [];
    }
    if (state.menuWire && state.menuWire.timers) {
      state.menuWire.timers.forEach(function (t) {
        clearTimeout(t);
      });
      state.menuWire.timers = [];
    }
    if (state.menuHostWire && state.menuHostWire.timers) {
      state.menuHostWire.timers.forEach(function (t) {
        clearTimeout(t);
      });
      state.menuHostWire.timers = [];
    }
    // 편집기가 사라지면 실행 상단 메뉴 행동도 비운다 (저장 작업 2).
    // window가 없는 테스트 환경에서는 조용히 지정한다.
    if (typeof window !== 'undefined' && window.MyHubOfficeTabs) {
      window.MyHubOfficeTabs.setState('hangul', null);
      window.MyHubOfficeTabs.setQuick('hangul', {
        undo: false,
        redo: false,
        print: false,
        search: false,
      });
    }
  }

  // Studio사용한 타이핑 호스 트에 알림 이벤트가 없다
  // (onDocumentChanged의 파이프 적용 전용). iframe와 같은 출처의
  // 편집 문서에 입력 이벤 트를 직접 best-effort넣는 "로 변경"있음
  // 코어 저장 버튼을 표시한다 등 모두 붙으면 상태 표시만 비워 뿐이다.
  function attachDirtyWatch(ctx, state, container) {
    state.dirtyWatch = { doc: null, timers: [] };
    var tryAttach = function () {
      if (!ctx.isCurrent() || state.destroyed) return;
      var frame = container.querySelector('iframe');
      if (!frame || !frame.contentDocument) return;
      var fdoc = frame.contentDocument;
      if (state.dirtyWatch.doc === fdoc) return;
      state.dirtyWatch.doc = fdoc;
      var onKey = function (e) {
        var k = e && e.key;
        if (
          typeof k === 'string' &&
          (k.length === 1 || k === 'Backspace' || k === 'Delete' || k === 'Enter' || k === 'Tab')
        ) {
          ctx.markDirty();
        }
      };
      fdoc.addEventListener('keydown', onKey, true);
      // keydown로끝나지 않게 (2026-11-03 분리한다): 기록한글 IME 입력
      // 조합 중 keydown가 key인 'Process'등 조 건에 걸리지 않고,
      // insertText구성 입력 대상 등 이벤트 자체가 없다. 실제 텍스트가
      // 실패하면 모든 경로로 beforeinput/input우회 하므로 등 수를
      // 함께 본다 등 변경 작업이 등 붙으면 사용자는 길이가 필요하니
      // 등 등 없다.
      var onInput = function () {
        ctx.markDirty();
      };
      fdoc.addEventListener('beforeinput', onInput, true);
      fdoc.addEventListener('input', onInput, true);
      fdoc.addEventListener('paste', function () {
        ctx.markDirty();
      });
      fdoc.addEventListener('cut', function () {
        ctx.markDirty();
      });
    };
    // iframe의 load가 아직도 않고 캡처 단계에서만큼 허용이
    container.addEventListener('load', tryAttach, true);
    tryAttach();
    [300, 900, 2000, 4500].forEach(function (ms) {
      state.dirtyWatch.timers.push(setTimeout(tryAttach, ms));
    });
  }

  // 저장 성공 등 Studio 쪽 dirty자동복구 초안을 해제한다 (SDK 계약).
  // 실패해도 길이가 내부 복사로 throw하지 않고 상태에만 남긴다.
  function notifySavedBestEffort(ctx, state) {
    try {
      if (state.editor && typeof state.editor.notifySaved === 'function') {
        Promise.resolve(state.editor.notifySaved(ctx.file.name)).catch(function (e) {
          state.notifySavedError = String((e && e.message) || e);
        });
      }
    } catch (e) {
      state.notifySavedError = String((e && e.message) || e);
    }
  }

  // Studio 파일 규칙이 켜진 호스트에서는 (embed + 메뉴 확장 배선 조건)
  function studioEmbedOn(ctx) {
    return !!(ctx.minimalChrome || ctx.studioEmbed);
  }

  function wireStudioFileMenu(ctx, state, container) {
    if (!studioEmbedOn(ctx)) return;
    if (state.menuWireFor === container) return;
    state.menuWireFor = container;
    state.menuWiredOk = false;
    state.menuWire = { timers: [] };
    var tryWire = function () {
      if (!ctx.isCurrent()) return;
      var frame = container.querySelector('iframe');
      var win = frame && frame.contentWindow;
      if (!win) return;
      try {
        installPrintOpenShim(win);
        if (win.__myhubFileMenuOk) {
          if (!state.menuWiredOk) {
            state.menuWiredOk = true;
            state.menuWire.timers.forEach(function (t) {
              clearTimeout(t);
            });
            state.menuWire.timers = [];
          }
          return;
        }
        state.menuWiredOk = false;
        var ext = win.__myhubFileMenu;
        if (ext && typeof ext.enable === 'function') ext.enable();
      } catch (e) {
        state.menuWireError = String((e && e.message) || e);
      }
    };
    container.addEventListener('load', tryWire, true);
    tryWire();
    [300, 900, 2000, 4500].forEach(function (ms) {
      state.menuWire.timers.push(setTimeout(tryWire, ms));
    });
  }

  function listenFileActions(ctx, state) {
    if (!studioEmbedOn(ctx) || state.fileActionListening) return;
    state.fileActionListening = true;
    var onMessage = function (e) {
      if (!ctx.isCurrent()) {
        window.removeEventListener('message', onMessage);
        return;
      }
      if (e.origin !== ORIGIN) return;
      var frame = state.editorContainer
        ? state.editorContainer.querySelector('iframe')
        : null;
      if (!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
      var d = e.data || {};
      if (d.type === 'myhub-hwp:request-picture') {
        ctx.requestPicture(function (name, bytes) {
          if (!ctx.isCurrent() || !frame.contentWindow || !bytes) return;
          var transfer = bytes instanceof ArrayBuffer ? [bytes] : [];
          frame.contentWindow.postMessage(
            { type: 'myhub-hwp:picture', name: name || '', bytes: bytes },
            ORIGIN,
            transfer,
          );
        });
        return;
      }
      if (d.type === 'myhub-hwp:find-result') {
        if (d.ok === false && d.reason === 'not-found') {
          ctx.setStatus('문서에서 찾을 수 없습니다');
        }
        return;
      }
      if (d.type !== 'myhub-hwp:file-action') return;
      if (d.action === 'open') ctx.requestOpen();
      else if (d.action === 'save' && typeof state.saveViaEditor === 'function') {
        state.saveViaEditor();
      } else if (
        d.action === 'save-as' &&
        typeof state.saveAsViaEditor === 'function'
      ) {
        state.saveAsViaEditor();
      }
    };
    window.addEventListener('message', onMessage);
  }

  function menuHostOn(ctx) {
    return !!(
      ctx.minimalChrome &&
      typeof window !== 'undefined' &&
      window.MyHubOfficeTabs
    );
  }

  function wireMenuHost(ctx, state, container) {
    if (!menuHostOn(ctx)) return;
    if (state.menuHostWireFor === container) return;
    state.menuHostWireFor = container;
    state.menuHostWire = { timers: [] };
    var tryWire = function () {
      if (!ctx.isCurrent()) return;
      var frame = container.querySelector('iframe');
      var win = frame && frame.contentWindow;
      if (!win) return;
      try {
        if (win.__myhubMenuHostOk) {
          state.menuHostWire.timers.forEach(function (t) {
            clearTimeout(t);
          });
          state.menuHostWire.timers = [];
          if (state.shellAdopted) forwardShellAdopted(state, container);
          return;
        }
        var ext = win.__myhubMenuHost;
        if (ext && typeof ext.enable === 'function') ext.enable();
      } catch (e) {
        state.menuHostWireError = String((e && e.message) || e);
      }
    };
    container.addEventListener('load', tryWire, true);
    tryWire();
    [300, 900, 2000, 4500].forEach(function (ms) {
      state.menuHostWire.timers.push(setTimeout(tryWire, ms));
    });
  }

  function listenMenuHost(ctx, state) {
    if (!menuHostOn(ctx) || state.menuHostListening) return;
    state.menuHostListening = true;
    var onMessage = function (e) {
      if (!ctx.isCurrent()) {
        window.removeEventListener('message', onMessage);
        return;
      }
      if (e.origin !== ORIGIN) return;
      var frame = state.editorContainer
        ? state.editorContainer.querySelector('iframe')
        : null;
      if (!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
      var d = e.data || {};
      if (d.type === 'myhub-hwp:menu-items') {
        if (state.qaPending && d.seq === state.qaPending.seq) {
          state.qaPending.finish(d.items);
          return;
        }
        if (window.MyHubOfficeTabs) {
          window.MyHubOfficeTabs.provideMenuItems(
            'hangul',
            d.id,
            d.items,
            d.seq,
          );
        }
        return;
      }
      if (d.type !== 'myhub-hwp:menus') return;
      state.menuHostLast = {
        menus: Array.isArray(d.menus) ? d.menus : [],
        open: typeof d.open === 'string' ? d.open : null,
        toolbox:
          d.toolbox && typeof d.toolbox.expanded === 'boolean'
            ? { expanded: d.toolbox.expanded }
            : null,
        shellMenu: !!d.shellMenu,
      };
      pushMenuHostState(state);
    };
    window.addEventListener('message', onMessage);
  }

  function pushMenuHostState(state) {
    if (!window.MyHubOfficeTabs) return;
    var last = state.menuHostLast || { menus: [], open: null, toolbox: null };
    window.MyHubOfficeTabs.setState('hangul', {
      tabs: last.menus.map(function (m) {
        return { id: m.id, label: m.label, kind: 'menu' };
      }),
      activeId: last.shellMenu
        ? null
        : typeof last.open === 'string'
          ? last.open
          : null,
      collapsed: last.toolbox ? !last.toolbox.expanded : false,
      canCollapse: !!state.shellAdopted,
      menuShell: !!last.shellMenu,
    });
    if (last.menus && last.menus.length) {
      window.MyHubOfficeTabs.setQuick('hangul', {
        undo: true,
        redo: true,
        print: true,
        search: true,
      });
    }
  }

  function forwardShellAdopted(state, container) {
    var holder = container || state.editorContainer;
    var frame = holder ? holder.querySelector('iframe') : null;
    var win = frame && frame.contentWindow;
    if (!win) return;
    try {
      var ext = win.__myhubMenuHost;
      if (ext && typeof ext.setShellAdopted === 'function') {
        ext.setShellAdopted();
      } else {
        win.postMessage(
          { type: 'myhub-hwp:menu-shell', adopted: true },
          ORIGIN,
        );
      }
    } catch (e) {
      state.menuHostWireError = String((e && e.message) || e);
    }
  }

  function listenShellAdopt(ctx, state) {
    if (!menuHostOn(ctx) || state.shellAdoptListening) return;
    state.shellAdoptListening = true;
    var onMessage = function (e) {
      if (!ctx.isCurrent()) {
        window.removeEventListener('message', onMessage);
        return;
      }
      if (e.origin !== ORIGIN) return;
      if (e.source !== window.parent) return;
      var d = e.data || {};
      if (d.type !== 'myhub:office-tabs-adopt') return;
      if (state.shellAdopted) return;
      state.shellAdopted = true;
      forwardShellAdopted(state);
      pushMenuHostState(state);
    };
    window.addEventListener('message', onMessage);
  }

  function registerMenuHostCommand(ctx, state) {
    if (!menuHostOn(ctx)) return;
    window.MyHubOfficeTabs.onCommand('hangul', function (cmd) {
      if (!ctx.isCurrent()) return;
      var frame = state.editorContainer
        ? state.editorContainer.querySelector('iframe')
        : null;
      if (!frame || !frame.contentWindow) return;
      if (cmd.type === 'toggle-collapse') {
        frame.contentWindow.postMessage(
          { type: 'myhub-hwp:menu-toggle-toolbox' },
          ORIGIN,
        );
        return;
      }
      if (cmd.type === 'menu-request') {
        frame.contentWindow.postMessage(
          { type: 'myhub-hwp:menu-items-request', id: cmd.id, seq: cmd.seq },
          ORIGIN,
        );
        return;
      }
      if (cmd.type === 'menu-exec') {
        frame.contentWindow.postMessage(
          { type: 'myhub-hwp:menu-exec', id: cmd.id, path: cmd.path },
          ORIGIN,
        );
        return;
      }
      if (cmd.type !== 'select') return;
      var x = 0;
      if (cmd.anchorEl && typeof cmd.anchorEl.getBoundingClientRect === 'function') {
        var fr = frame.getBoundingClientRect();
        x = Math.max(
          0,
          Math.round(cmd.anchorEl.getBoundingClientRect().left - fr.left),
        );
      }
      frame.contentWindow.postMessage(
        { type: 'myhub-hwp:menu-open', id: cmd.id, x: x },
        ORIGIN,
      );
    });
    registerQuickHost(ctx, state);
  }

  var qaSeq = 0;
  function findMenuItemByLabel(items, labels) {
    if (!Array.isArray(items)) return null;
    for (var i = 0; i < items.length; i++) {
      var n = items[i];
      if (!n || typeof n !== 'object') continue;
      if (
        typeof n.label === 'string' &&
        labels.indexOf(n.label.replace(/\s+/g, '')) >= 0 &&
        Array.isArray(n.path)
      ) {
        return n;
      }
      var hit = findMenuItemByLabel(n.children, labels);
      if (hit) return hit;
    }
    return null;
  }
  function qaMenuExec(ctx, state, menuLabel, itemLabels) {
    var menus = (state.menuHostLast && state.menuHostLast.menus) || [];
    var menu = null;
    menus.forEach(function (m) {
      if (m.label === menuLabel) menu = m;
    });
    var frame = state.editorContainer
      ? state.editorContainer.querySelector('iframe')
      : null;
    if (!menu || !frame || !frame.contentWindow) return false;
    var seq = 'qa-' + ++qaSeq + '-' + Date.now();
    var timer = setTimeout(function () {
      if (state.qaPending && state.qaPending.seq === seq) {
        state.qaPending = null;
      }
    }, 2500);
    state.qaPending = {
      seq: seq,
      finish: function (items) {
        clearTimeout(timer);
        state.qaPending = null;
        if (!ctx.isCurrent()) return;
        var item = findMenuItemByLabel(items, itemLabels);
        if (!item) return;
        var fr = state.editorContainer
          ? state.editorContainer.querySelector('iframe')
          : null;
        if (!fr || !fr.contentWindow) return;
        fr.contentWindow.postMessage(
          { type: 'myhub-hwp:menu-exec', id: menu.id, path: item.path },
          ORIGIN,
        );
      },
    };
    frame.contentWindow.postMessage(
      { type: 'myhub-hwp:menu-items-request', id: menu.id, seq: seq },
      ORIGIN,
    );
    return true;
  }
  function isPrintSurfaceUrl(url, baseHref) {
    if (typeof url !== 'string' || !url) return false;
    try {
      var u = new URL(url, baseHref || 'http://localhost/');
      return /\/print\.html$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }
  function installPrintOpenShim(win) {
    if (!win || win.__myhubPrintOpenShimmed) return false;
    if (typeof win.open !== 'function') return false;
    var nativeOpen = win.open;
    win.__myhubPrintOpenShimmed = true;
    win.open = function (url, target, features) {
      var slot = null;
      try {
        slot = win.__myhubPreopenedPrintWindow || null;
      } catch (e) {
        slot = null;
      }
      if (slot && isPrintSurfaceUrl(url, win.location && win.location.href)) {
        try {
          win.__myhubPreopenedPrintWindow = null;
        } catch (e) {
          win.__myhubPrintShimError = String((e && e.message) || e);
        }
        var usable = false;
        try {
          usable = !slot.closed;
        } catch (e) {
          usable = false;
        }
        if (usable) {
          try {
            var want = new URL(url, win.location.href).href;
            if (slot.location && slot.location.href !== want) {
              slot.location.href = want;
            }
          } catch (e) {
            win.__myhubPrintShimError = String((e && e.message) || e);
          }
          return slot;
        }
      }
      return nativeOpen.call(win, url, target, features);
    };
    return true;
  }
  function transferPreopenedPrintWindow(state) {
    var pre = null;
    try {
      pre = window.__myhubPreopenedPrintWindow || null;
    } catch (e) {
      pre = null;
    }
    if (!pre) return false;
    try {
      window.__myhubPreopenedPrintWindow = null;
    } catch (e) {
      state.printReserveError = String((e && e.message) || e);
    }
    var frame = state.editorContainer
      ? state.editorContainer.querySelector('iframe')
      : null;
    var win = frame && frame.contentWindow;
    if (!win) {
      try {
        if (!pre.closed) pre.close();
      } catch (e) {
        state.printReserveError = String((e && e.message) || e);
      }
      return false;
    }
    installPrintOpenShim(win);
    try {
      win.__myhubPreopenedPrintWindow = pre;
    } catch (e) {
      return false;
    }
    setTimeout(function () {
      var left = null;
      try {
        left = win.__myhubPreopenedPrintWindow;
      } catch (e) {
        left = null;
      }
      if (left === pre) {
        try {
          win.__myhubPreopenedPrintWindow = null;
        } catch (e) {
          win.__myhubPrintShimError = String((e && e.message) || e);
        }
        try {
          if (!pre.closed) pre.close();
        } catch (e) {
          win.__myhubPrintShimError = String((e && e.message) || e);
        }
      }
    }, 8000);
    return true;
  }
  function runStudioFind(ctx, state, value) {
    var query = typeof value === 'string' ? value.trim() : '';
    if (!query) return false;
    var frame = state.editorContainer
      ? state.editorContainer.querySelector('iframe')
      : null;
    if (!frame || !frame.contentWindow) return false;
    var win = frame.contentWindow;
    try {
      var ext = win.__myhubFind;
      if (ext && typeof ext.search === 'function') {
        var res = ext.search(query);
        if (res && res.ok === false && res.reason === 'unavailable') {
          return false;
        }
        return true;
      }
    } catch (e) {
      state.findWireError = String((e && e.message) || e);
    }
    try {
      win.postMessage({ type: 'myhub-hwp:find', query: query }, ORIGIN);
      return true;
    } catch (e) {
      return false;
    }
  }
  function registerQuickHost(ctx, state) {
    if (!menuHostOn(ctx)) return;
    window.MyHubOfficeTabs.onQuick('hangul', function (action, value) {
      if (!ctx.isCurrent()) return false;
      if (action === 'search') return runStudioFind(ctx, state, value);
      var labels =
        action === 'undo'
          ? ['되돌리기', '실행취소']
          : action === 'redo'
            ? ['다시실행']
            : action === 'print'
              ? ['서식']
              : null;
      if (!labels) return false;
      var menuLabel = action === 'print' ? '파일' : '편집';
      if (action === 'print') transferPreopenedPrintWindow(state);
      return qaMenuExec(ctx, state, menuLabel, labels);
    });
  }

  function toolsEl(ctx, state) {
    var bar = ctx.doc.createElement('div');
    bar.className = 'fv-hwp-tools';
    var viewBtn = ctx.doc.createElement('button');
    viewBtn.type = 'button';
    viewBtn.textContent = '보기';
    viewBtn.addEventListener('click', function () {
      if (!ctx.isCurrent()) return;
      destroyEditor(state);
      renderView(ctx, state).catch(function () {
        if (ctx.isCurrent()) fallbackPreview(ctx, state);
      });
    });
    bar.appendChild(viewBtn);
    var editBtn = ctx.doc.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '편집';
    editBtn.addEventListener('click', function () {
      if (!ctx.isCurrent()) return;
      openEditor(ctx, state).catch(function () {
        if (ctx.isCurrent()) ctx.setStatus('편집기를 내지 못했습니다');
      });
    });
    bar.appendChild(editBtn);
    return bar;
  }

  function fontsReady() {
    var fonts = typeof window !== 'undefined' ? window.MyHubFonts : null;
    if (!fonts || typeof fonts.whenReady !== 'function') return Promise.resolve(null);
    return fonts.whenReady(2500).catch(function () {
      return null;
    });
  }

  function cleanSvgHolder(holder) {
    if (!holder || !holder.querySelectorAll) return;
    var drop = holder.querySelectorAll(
      'script, foreignObject, iframe, object, embed, form, ' +
        'animate, animateMotion, animateTransform, set, handler, listener',
    );
    Array.prototype.forEach.call(drop, function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    var all = holder.querySelectorAll('*');
    Array.prototype.forEach.call(all, function (el) {
      if (!el.attributes) return;
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = String(attr.name || '').toLowerCase();
        var value = String(attr.value || '')
          .replace(/[ - ]+/g, '')
          .toLowerCase();
        if (name.indexOf('on') === 0) {
          el.removeAttribute(attr.name);
        } else if (
          (name === 'href' || name === 'xlink:href') &&
          (value.indexOf('javascript:') === 0 ||
            value.indexOf('vbscript:') === 0 ||
            value.indexOf('data:') === 0)
        ) {
          el.removeAttribute(attr.name);
        }
      });
    });
  }

  function renderView(ctx, state) {
    return fontsReady().then(function () {
      if (!ctx.isCurrent()) return undefined;
      return renderViewLoaded(ctx, state);
    });
  }

  function renderViewLoaded(ctx, state) {
    return loadRhwp(ctx).then(function (mod) {
      if (!ctx.isCurrent()) return;
      var doc = new mod.HwpDocument(new Uint8Array(state.buf));
      var pages = doc.pageCount();
      ctx.clearBody();
      if (!ctx.chromeFold) ctx.body.appendChild(toolsEl(ctx, state));
      var wrap = ctx.doc.createElement('div');
      wrap.className = 'fv-hwp-pages';
      var holders = [];
      for (var i = 0; i < pages; i++) {
        var holder = ctx.doc.createElement('div');
        holder.className = 'fv-hwp-page';
        holder.dataset.page = String(i);
        wrap.appendChild(holder);
        holders.push(holder);
      }
      ctx.body.appendChild(wrap);
      ctx.setNote('한글 문서 쪽 ' + pages + '페이지');
      state.surface = 'view';
      setupLazyPages(ctx, state, doc, holders);
    });
  }

  function setupLazyPages(ctx, state, doc, holders) {
    if (state.lazyIo) {
      state.lazyIo.disconnect();
      state.lazyIo = null;
    }
    var rendered = {};
    var aspectFixed = false;
    function renderOne(i) {
      if (rendered[i] || !ctx.isCurrent()) return;
      rendered[i] = true;
      var holder = holders[i];
      holder.innerHTML = doc.renderPageSvg(i);
      cleanSvgHolder(holder);
      holder.style.aspectRatio = '';
      if (!aspectFixed) {
        aspectFixed = true;
        var svg = holder.querySelector ? holder.querySelector('svg') : null;
        var vb = svg ? String(svg.getAttribute('viewBox') || '').split(/\s+/) : [];
        if (vb.length === 4) {
          var ratio = Number(vb[2]) / Number(vb[3]);
          if (ratio > 0) {
            holders.forEach(function (h) {
              if (!h.querySelector || !h.querySelector('svg')) h.style.aspectRatio = String(ratio);
            });
          }
        }
      }
    }
    if (!holders.length) return;
    renderOne(0);
    if (typeof IntersectionObserver === 'undefined') {
      for (var i = 1; i < holders.length; i++) renderOne(i);
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          renderOne(Number(en.target.dataset.page));
        });
      },
      { root: ctx.body, rootMargin: '400px 0px' },
    );
    state.lazyIo = io;
    for (var j = 1; j < holders.length; j++) io.observe(holders[j]);
  }

  // 편집기 부팅 중 로딩 화면 (시트·데스크톱 부팅과 같은 구성: 앱 이름 +
  // 파란 스피너 + 상태 문구). 스튜디오가 뜨기 전까지 흰 빈 페이지만
  // 보이는 것을 막는다 (2026-11-13 사용자 지적).
  function buildLoadingEl(doc, title, status) {
    var el = doc.createElement('div');
    el.className = 'fv-hwp-loading';
    var titleEl = doc.createElement('div');
    titleEl.className = 'fv-hwp-loading-title';
    titleEl.textContent = title;
    var spin = doc.createElement('div');
    spin.className = 'fv-hwp-loading-spin';
    spin.setAttribute('aria-hidden', 'true');
    var statusEl = doc.createElement('div');
    statusEl.className = 'fv-hwp-loading-status';
    statusEl.textContent = status;
    el.appendChild(titleEl);
    el.appendChild(spin);
    el.appendChild(statusEl);
    return el;
  }

  function openEditor(ctx, state) {
    var loading = null;
    var removeLoading = function () {
      if (loading && loading.parentNode) loading.parentNode.removeChild(loading);
      loading = null;
    };
    // 로딩 화면을 SDK 로드 전에 먼저 띄운다 (2026-11-13): loadLib이 끝날
    // 때까지 빈 화면이 보이는 틈이 있었고, 오피스 진행 막대와 원형 로딩이
    // 겹쳐 보였다. 다운로드가 끝나는 'parse' 시점에 막대가 사라지고 로딩
    // 화면이 이어받는다. 실패 시 제거는 아래 .catch가 맡는다.
    destroyEditor(state);
    ctx.clearBody();
    ctx.body.classList.add('fv-fill');
    if (!ctx.chromeFold) ctx.body.appendChild(toolsEl(ctx, state));
    var container = ctx.doc.createElement('div');
    container.className = 'fv-hwp-editor';
    ctx.body.appendChild(container);
    loading = buildLoadingEl(ctx.doc, '한글 2020', '한글 편집기를 불러오는 중');
    container.appendChild(loading);
    return ctx.loadLib('rhwpEditor').then(function (sdk) {
      if (!ctx.isCurrent()) {
        removeLoading();
        return;
      }
      if (!sdk || typeof sdk.createEditor !== 'function') {
        throw new Error('편집기 SDK 형태가 올바르지 않습니다');
      }
      return Promise.resolve(
        sdk.createEditor(container, {
          studioUrl: studioEmbedOn(ctx)
            ? '/rhwp-studio/index.html?chrome=embed'
            : '/rhwp-studio/index.html',
        }),
      ).then(function (editor) {
        if (!ctx.isCurrent()) {
          if (editor && typeof editor.destroy === 'function') editor.destroy();
          removeLoading();
          return;
        }
        state.editor = editor;
        state.editorContainer = container;
        return editor.loadFile(state.buf, ctx.file.name).then(function () {
          if (!ctx.isCurrent()) {
            removeLoading();
            return;
          }
          removeLoading();
          state.surface = 'editor';
          if (ctx.saveBtn) ctx.saveBtn.hidden = false;
          attachDirtyWatch(ctx, state, container);
          var saveViaEditor = function () {
            var exporter =
              ctx.file.kind === 'hwpx' ? editor.exportHwpx : editor.exportHwp;
            return exporter
              .call(editor)
              .then(function (bytes) {
                return ctx.putContent(
                  new Blob([bytes], { type: 'application/octet-stream' }),
                );
              })
              .then(function (ok) {
                if (ok) notifySavedBestEffort(ctx, state);
                return ok;
              });
          };
          state.saveViaEditor = saveViaEditor;
          var saveAsViaEditor = function () {
            return editor
              .exportHwpx()
              .then(function (bytes) {
                return ctx.saveAsContent(
                  new Blob([bytes], { type: 'application/octet-stream' }),
                  ctx.file.name,
                );
              })
              .then(function (ok) {
                if (ok) notifySavedBestEffort(ctx, state);
                return ok;
              });
          };
          state.saveAsViaEditor = saveAsViaEditor;
          ctx.setSaveHandler(saveViaEditor);
          wireStudioFileMenu(ctx, state, container);
          listenFileActions(ctx, state);
          wireMenuHost(ctx, state, container);
          listenMenuHost(ctx, state);
          listenShellAdopt(ctx, state);
              ctx.setNote('한글 문서 쪽 편집 중');
        });
      });
    }).catch(function (err) {
      // 부팅 실패 시에도 로딩 화면이 남지 않게 한다 (호출부의
      // renderView 폴백이 빈 몸통에서 시작한다).
      removeLoading();
      throw err;
    });
  }

  function exportEditorBytes(ctx, state) {
    if (!state.editor) return Promise.resolve(null);
    var exporter = ctx.file.kind === 'hwpx' ? state.editor.exportHwpx : state.editor.exportHwp;
    if (typeof exporter !== 'function') return Promise.resolve(null);
    return Promise.resolve(exporter.call(state.editor)).then(function (bytes) {
      if (!bytes) return null;
      var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    });
  }
  function currentViewPage(ctx) {
    var holders = ctx.body.querySelectorAll('.fv-hwp-page');
    if (!holders.length) return 0;
    var bodyTop = ctx.body.getBoundingClientRect().top;
    var page = 0;
    for (var i = 0; i < holders.length; i++) {
      if (holders[i].getBoundingClientRect().top <= bodyTop + 24) page = i;
      else break;
    }
    return page;
  }
  function scrollToViewPage(ctx, page) {
    var holders = ctx.body.querySelectorAll('.fv-hwp-page');
    var holder = holders && holders[page];
    if (!holder) return;
    var delta =
      holder.getBoundingClientRect().top - ctx.body.getBoundingClientRect().top;
    ctx.body.scrollTop += delta;
  }
  function switchToView(ctx, state) {
    state.switching = true;
    return exportEditorBytes(ctx, state)
      .then(function (bytes) {
        if (bytes) state.buf = bytes;
      })
      .catch(function (err) {
        state.switchError = String((err && err.message) || err);
      })
      .then(function () {
        if (!ctx.isCurrent()) return;
        destroyEditor(state);
        return renderView(ctx, state)
          .then(function () {
            if (!ctx.isCurrent()) return;
            if ((state.viewPage || 0) > 0) scrollToViewPage(ctx, state.viewPage);
            else ctx.body.scrollTop = 0;
          })
          .catch(function () {
            if (ctx.isCurrent()) return fallbackPreview(ctx, state);
            return undefined;
          });
      })
      .then(function () {
        state.switching = false;
      });
  }
  function switchToEditor(ctx, state) {
    state.switching = true;
    if (state.surface === 'view') state.viewPage = currentViewPage(ctx);
    return openEditor(ctx, state)
      .catch(function () {
        if (!ctx.isCurrent()) return;
        ctx.setStatus('편집기를 내지 못했습니다');
        destroyEditor(state);
        return renderView(ctx, state).catch(function () {
          if (ctx.isCurrent()) return fallbackPreview(ctx, state);
          return undefined;
        });
      })
      .then(function () {
        state.switching = false;
      });
  }
  function watchFold(ctx, state) {
    if (!ctx.chromeFold || state.foldWatch) return;
    state.foldWatch = true;
    ctx.onFoldChange(function (folded) {
      if (!ctx.isCurrent() || state.switching) return;
      if (folded && state.surface === 'editor') switchToView(ctx, state);
      else if (!folded && (state.surface === 'view' || state.surface === 'preview')) {
        switchToEditor(ctx, state);
      }
    });
  }

  function fallbackPreview(ctx, state) {
    if (ctx.file.kind !== 'hwpx') {
      state.surface = 'preview';
      ctx.showMessage('구형 한글(hwp) 파일은 미리보기가 안 됩니다. 가져와서 한글 편집기로 여세요.');
      return Promise.resolve();
    }
    return ctx
      .loadLib('jszip')
      .then(function (JSZip) {
        return JSZip.loadAsync(state.buf);
      })
      .then(function (zip) {
        var names = Object.keys(zip.files)
          .filter(function (n) {
            return /Contents\/section\d+\.xml$/.test(n);
          })
          .sort(function (a, b) {
            var na = Number((a.match(/section(\d+)\.xml$/) || [])[1] || 0);
            var nb = Number((b.match(/section(\d+)\.xml$/) || [])[1] || 0);
            return na - nb;
          });
        if (!names.length) throw new Error('no sections');
        return Promise.all(
          names.map(function (n) {
            return zip.files[n].async('text');
          }),
        );
      })
      .then(function (xmls) {
        if (!ctx.isCurrent()) return;
        state.surface = 'preview';
        ctx.setNote('한글 문서를 본문 미리보기만 합니다');
        ctx.clearBody();
        var pre = ctx.doc.createElement('pre');
        pre.className = 'fv-pre';
        pre.textContent = xmls.map(core.extractHwpxText).join('\n');
        ctx.body.appendChild(pre);
      });
  }

  function handleHwp(ctx) {
    var state = {
      editor: null,
      buf: null,
      lazyIo: null,
      surface: '',
      switching: false,
      viewPage: 0,
      foldWatch: false,
    };
    session = buildSession(ctx, state);
    registerMenuHostCommand(ctx, state);
    if (ctx.chromeFold) watchFold(ctx, state);
    if (!ctx.file.fileId) {
      return ctx.fetchContent('buffer').then(function (buf) {
        if (!ctx.isCurrent()) return;
        state.buf = buf;
        return openEditor(ctx, state);
      });
    }
    return ctx.fetchContent('buffer').then(function (buf) {
      if (!ctx.isCurrent()) return;
      state.buf = buf;
      if (ctx.chromeFold) {
        return openEditor(ctx, state).catch(function () {
          if (!ctx.isCurrent()) return;
          destroyEditor(state);
          return renderView(ctx, state).catch(function () {
            if (!ctx.isCurrent()) return;
            return fallbackPreview(ctx, state);
          });
        });
      }
      return renderView(ctx, state).catch(function () {
        if (!ctx.isCurrent()) return;
        destroyEditor(state);
        return fallbackPreview(ctx, state);
      });
    });
  }

  handleHwp.ownsChrome = true;
  core.registerFormat('hwp', handleHwp);
  core.registerFormat('hwpx', handleHwp);

  var session = null;

  function coreResultOk(ret) {
    if (typeof ret !== 'string') return true;
    var parsed = null;
    try {
      parsed = JSON.parse(ret);
    } catch (e) {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed.ok === true;
    return !/error|fail/i.test(ret);
  }

  function appendPara(document2, text) {
    var sec = document2.getSectionCount() - 1;
    var pc = document2.getParagraphCount(sec);
    var last = Math.max(pc - 1, 0);
    var len = document2.getParagraphLength(sec, last);
    if (len === 0) {
      var r0 = document2.insertText(sec, last, 0, text);
      if (!coreResultOk(r0)) throw new Error('문단 넣기 실패');
      return;
    }
    var r1 = document2.insertParagraph(sec, last);
    if (!coreResultOk(r1)) throw new Error('표 만 들기 실패');
    var r2 = document2.insertText(sec, last + 1, 0, text);
    if (!coreResultOk(r2)) throw new Error('문단 넣기 실패');
  }

  function buildSession(ctx, state) {
    function readTextLegacy() {
      return loadRhwp(ctx).then(function (mod) {
        var document2 = new mod.HwpDocument(new Uint8Array(state.buf));
        var paragraphs = [];
        var secCount = document2.getSectionCount ? document2.getSectionCount() : 1;
        for (var s = 0; s < secCount; s++) {
          var pc = document2.getParagraphCount(s);
          for (var p = 0; p < pc && paragraphs.length < 200; p++) {
            var len = document2.getParagraphLength(s, p);
            var text = len > 0 ? document2.getTextRange(s, p, 0, len) : '';
            paragraphs.push(String(text || ''));
          }
        }
        return { paragraphs: paragraphs };
      });
    }
    return {
      kind: 'hwp',
      ctx: ctx,
      readText: function () {
        return loadKordoc(ctx)
          .then(function (mod) {
            return mod.parse(new Uint8Array(state.buf));
          })
          .then(function (r) {
            if (!r || r.success !== true || typeof r.markdown !== 'string') {
              throw new Error('kordoc 파싱에 실패했습니다');
            }
            return { markdown: r.markdown };
          })
          .catch(function () {
            return readTextLegacy();
          });
      },
      applyOps: function (ops) {
        return loadRhwp(ctx).then(function (mod) {
          var getBytes = state.editor
            ? (ctx.file.kind === 'hwpx' ? state.editor.exportHwpx : state.editor.exportHwp).call(
                state.editor,
              )
            : Promise.resolve(state.buf);
          return Promise.resolve(getBytes).then(function (bytes) {
            var document2 = new mod.HwpDocument(new Uint8Array(bytes));
            var applied = 0;
            var errors = [];
            (ops || []).forEach(function (op, idx) {
              try {
                if (op.type === 'append_paragraphs') {
                  (op.paragraphs || []).forEach(function (t) {
                    appendPara(document2, t);
                  });
                } else if (op.type === 'replace_text') {
                  var matches = [];
                  try {
                    matches = JSON.parse(document2.searchAllText(op.find, true, true)) || [];
                  } catch (e) {
                    matches = [];
                  }
                  var m0 = matches.length ? matches[0] : null;
                  if (!m0) throw new Error('찾을 문자열이 문서에 없습니다: ' + op.find);
                  if (m0.cellContext) {
                    var cc = m0.cellContext;
                    var cr = document2.replaceTextInCellDeferredPagination(
                      m0.sec,
                      cc.parentPara,
                      cc.ctrlIdx,
                      cc.cellIdx,
                      cc.cellPara,
                      m0.charOffset,
                      op.find.length,
                      op.replace,
                    );
                    if (!coreResultOk(cr)) throw new Error('치환 실패');
                    var cellLen = document2.getCellParagraphLength(
                      m0.sec,
                      cc.parentPara,
                      cc.ctrlIdx,
                      cc.cellIdx,
                      cc.cellPara,
                    );
                    var after = String(
                      document2.getTextInCell(
                        m0.sec,
                        cc.parentPara,
                        cc.ctrlIdx,
                        cc.cellIdx,
                        cc.cellPara,
                        0,
                        cellLen,
                      ) || '',
                    );
                    if (after.indexOf(op.replace) < 0) throw new Error('치환 실패');
                  } else {
                    var br = document2.replaceText(m0.sec, m0.para, m0.charOffset, op.find.length, op.replace);
                    if (!coreResultOk(br)) throw new Error('치환 실패');
                  }
                } else if (op.type === 'insert_table') {
                  var sec2 = document2.getSectionCount() - 1;
                  var pc2 = document2.getParagraphCount(sec2);
                  var lastPara = Math.max(pc2 - 1, 0);
                  var lastLen = document2.getParagraphLength(sec2, lastPara);
                  var grid = [op.headers].concat(op.rows || []);
                  var ctRaw = document2.createTable(sec2, lastPara, lastLen, grid.length, op.headers.length);
                  var ctInfo = null;
                  try {
                    ctInfo = JSON.parse(ctRaw);
                  } catch (e) {
                    ctInfo = null;
                  }
                  if (!ctInfo || ctInfo.ok !== true) throw new Error('표 만들기 실패');
                  grid.forEach(function (rowVals, ri) {
                    (rowVals || []).forEach(function (val, ci) {
                      if (val === '' || val === null || val === undefined) return;
                      var ir = document2.insertTextInCell(
                        sec2,
                        ctInfo.paraIdx,
                        ctInfo.controlIdx,
                        ri * op.headers.length + ci,
                        0,
                        0,
                        String(val),
                      );
                      if (!coreResultOk(ir)) throw new Error('표 셀 입력 실패 (' + ri + ',' + ci + ')');
                    });
                  });
                } else {
                  throw new Error('지원하지 않는 연산: ' + op.type);
                }
                applied += 1;
              } catch (err) {
                errors.push({ index: idx, message: String((err && err.message) || err) });
              }
            });
            if (applied === 0) return { applied: 0, errors: errors };
            var out =
              ctx.file.kind === 'hwpx' ? document2.exportHwpx() : document2.exportHwp();
            var outBuf = out.buffer ? out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) : out;
            if (state.editor) {
              return state.editor.loadFile(outBuf, ctx.file.name).then(function () {
                state.buf = outBuf;
                ctx.markDirty();
                return { applied: applied, errors: errors };
              });
            }
            state.buf = outBuf;
            return ctx
              .putContent(new Blob([outBuf], { type: 'application/octet-stream' }))
              .then(function (ok) {
                if (!ok) {
                  errors.push({ index: -1, message: '처음에 실패했습니다' });
                  return { applied: 0, errors: errors };
                }
                return renderView(ctx, state)
                  .catch(function () {
                    ctx.setStatus('저장하지 미리보기를 새로 그리지 못했습니다');
                  })
                  .then(function () {
                    return { applied: applied, errors: errors };
                  });
              });
          });
        });
      },
    };
  }

  var api = {
    handleHwp: handleHwp,
    cleanSvgHolder: cleanSvgHolder,
    printReserve: {
      installOpenShim: installPrintOpenShim,
      isPrintSurfaceUrl: isPrintSurfaceUrl,
    },
    getSession: function () {
      return session && session.ctx.isCurrent() ? session : null;
    },
  };
  if (typeof window !== 'undefined') window.MyHubFinderFormatHwp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
