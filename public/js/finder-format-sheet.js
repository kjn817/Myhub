// 파인더 뷰어 플러그 모듈 등 시트 (finder-format-sheet.js)
// xlsx: SheetJS 그리드로 전용 편집 페이지(sheet.html)로 교체한다
//       (감시의전체 D1 조직도 SheetJS 차트 이미지 마크대로
//       파싱하는 문제). 편집 페이지가 GridCraft 엔진 넣소 iframe로
//       넣고(js/sheet-gridcraft.js가 프로토콜 버전), 시작에 실패하면
//       FortuneSheet 대관 페이지(sheet-fortune.html)로 교체한다 등
//       어느 쪽이든 등 모듈과의 myhub-sheet:* 계약은 같다. 파인더는
//       iframe로 프레 postMessage(origin 임하고)로 바이트를
//       주요받으면, 길이가 코어 putContent(base_version)로만 보낸다.
// 자체 값은: 숨긴 전에 zip 항목을 검사해 마크다운같은미지가 있으면
//       편 집기 상단(sheet.html 배너 의)그 대로 함께 보낸다.
//       마크다운 파일은 기본 보기 전용이고, 편집기에서 "그레이 편집"의
//       플러그(edit-enabled 가) 길이가 활성화된다.
// 편집 실행 엔진 자체 넣소재 주인공이다 (2026-11-03): GridCraft가
// 자체 파일 기록 으로 숨기고, 길이가 myhub-sheet:saved로 올라온다.
// file-action(의)구 형 대관(FortuneSheet) 실행
// 자체 [메뉴] 중에만 올라 온다.
// xls: 구형 BIFF가 ExcelJS읽지 못해 기존 보기 SheetJS 전용 경 로를
//       유지한다 (아래 저장 불가능).
(function () {
  'use strict';
  var core = typeof window !== 'undefined' ? window.MyHubFinderViewer : null;
  if (!core) return;

  var XLSX_MIME =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var ORIGIN =
    typeof window !== 'undefined' && window.location ? window.location.origin : '';

  // zip 항목 목록에서 편집 파일 등 사라진 등 있는 요소를 확정한다
  function inspectXlsxLosses(entryNames) {
    var macro = false;
    var chart = false;
    var media = false;
    (entryNames || []).forEach(function (n) {
      var name = String(n).toLowerCase();
      if (name === 'xl/vbaproject.bin') macro = true;
      else if (name.indexOf('xl/charts/') === 0) chart = true;
      else if (name.indexOf('xl/media/') === 0) media = true;
    });
    var losses = [];
    if (chart) losses.push('李⑦듃');
    if (media) losses.push('이미지');
    return { macro: macro, losses: losses };
  }

  // ---------- 클립보드 이미지 붙여넣기 (실행 삽입 경로) ----------
  // 붙여넣기가 삽입이 있는 문서에서만 발생한다. 엔진 iframe의
  // 삽입이 있으면 브리지(sheet-gridcraft.js)가 엔진 문서에서 직접
  // 가로채고, 뷰어 너비를 등 등 실행 삽입이 있으면 거기에 읽어
  // base64로 브리지에 가져보낸다 (myhub-sheet:paste-image-data).
  // 확정 규칙은 브리지와 같다: 표(table) HTML를 함께 등 붙여넣기를
  // 표 붙여넣기가 본래 동작이라 가로채지 않는다.
  // 헬퍼 본문은 공용 코어(craft-clipboard.js)가 맡는다 — 코어는
  // 이 파일보다 먼저 받아야 한다 (office.html 정적 순서·finder.js
  // 동적 import 체인). 코어가 없으면 붙여넣기는 조용히 건너뛴다.
  var clipboardCore =
    typeof window !== 'undefined' ? window.MyHubCraftClipboard : null;
  if (!clipboardCore && typeof console !== 'undefined' && console.warn) {
    console.warn('[finder-format-sheet] 코어(craft-clipboard.js)가 없어 붙여넣기가 동작하지 않습니다');
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

  function handleXlsx(ctx) {
    // 빈 문서(office "새로 만들기"): 받은 바이트가 없는 등 빈 워크북으로
    // 편집기를 숨기고, 첫 길이가 코어를 createSave 아래 생성해 만든다.
    if (!ctx.file.fileId) {
      mountSheet(ctx, null, { macro: false, losses: [] }, true);
      return Promise.resolve();
    }
    return ctx.fetchContent('buffer').then(function (buf) {
      if (!ctx.isCurrent()) return;
      return ctx
        .loadLib('jszip')
        .then(function (JSZip) {
          return JSZip.loadAsync(buf);
        })
        .then(function (zip) {
          if (!ctx.isCurrent()) return;
          var guard = inspectXlsxLosses(Object.keys(zip.files));
          mountSheet(ctx, buf, guard, false);
        });
    });
  }

  // 서식을 PDF(base64)를 통해 iframe로 이어 서식 대화상자에
  // 전달 한다 (제목 중 서식 오른쪽 경로). blob URL로 인쇄가
  // 실패한 시간을 갖고 파손한다. 어떤 단계가 실패해도 조용히 죽인
  // 않고 상태로 알린다.
  function printPdfBase64(ctx, base64) {
    // base64 → 바이트 변환만 여기서 하고, iframe 인쇄 본문은 뷰어
    // 공용 코어(MyHubFinderViewer.printPdfBytes, F-L15)가 맡는다.
    var fail = function () {
      ctx.setStatus('서식을 시작하지 못했습니다');
    };
    try {
      if (!base64 || typeof base64 !== 'string') throw new Error('empty');
      var bin = atob(base64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var core =
        (typeof window !== 'undefined' &&
          window.MyHubFinderViewer &&
          window.MyHubFinderViewer.printPdfBytes) ||
        (typeof globalThis !== 'undefined' &&
          globalThis.MyHubFinderViewer &&
          globalThis.MyHubFinderViewer.printPdfBytes) ||
        null;
      if (typeof core !== 'function') throw new Error('viewer print core missing');
      core(ctx.doc, bytes, fail);
    } catch (e) {
      fail();
    }
  }

  function mountSheet(ctx, buf, guard, isNew) {
    ctx.clearBody();
    ctx.body.classList.add('fv-fill');
    var frame = ctx.doc.createElement('iframe');
    frame.className = 'fv-sheet-frame';
    frame.title = ctx.file.name;
    // 시트 편집 깊이 같은 출 처의 자체. 페이지 실행(allow-scripts)과
    // 같은 출처 자체의 로딩origin 검증 통과(allow-same-origin)가 모두
    // 필요한 등 등 선택을 최소로 (gate-74). allow-modals인쇄 엔진 자체
    // 서식(GridCraft 가 자기 문서 에서 window.print()를 부르는
    // 경로)를 필수 선택한다 등 없으면 브라우저가 그 노출을 조용히
    // 무시 (한다 프로브 2026-11-06). 기록 창 바에 서식의 등 실행
    // 프레임으로 직접 내부로 등 선택과 균일하게 동작한다.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
    // 엔진 내장 등 복원 (2026-11-06 실행 페): 이지 에서는
    // 엔진(GridCraft)의 자체 등 피벗본을 그대로 이룬다. 따라 만든
    // 등 등 호스트(?tabs=host 엔진 를 경고 실행의 파일 그림 으로
    // 파일 작업 2 방식을)에 의한다. Finder 와 실행해 건다.
    var officeSurface = !!(
      ctx.minimalChrome &&
      typeof window !== 'undefined' &&
      window.MyHubOfficeTabs
    );
    frame.src = '/sheet.html';
    ctx.body.appendChild(frame);

    var state = {
      opened: false,
      editEnabled: !guard.macro,
      saveWaiter: null,
      snapshotWaiter: null,
      opsWaiter: null,
      bridgeReadyPromise: null,
      bridgeReadyResolve: null,
    };
    // 브리지(sheet.html)가 myhub-sheet:ready를 보내기 전에 등 프레임으로
    // 보낸 postMessage중 첫 리스너가 없어 사라진다 (E-3 기록: 세션
    // 마지막 직후첫 리스너 등 행에 소실한다 비서). 파일 경로도
    // ready를 기다린 뒤에만 메시지를 보낸다. 엔진 교체(engine-switch)로
    // 브리지가 다시 패널 등 ready를 기다리므로도 다시 다시 건다.
    function armBridgeReady() {
      state.bridgeReadyPromise = new Promise(function (resolve) {
        state.bridgeReadyResolve = resolve;
      });
    }
    armBridgeReady();
    function markBridgeReady() {
      if (state.bridgeReadyResolve) {
        var resolve = state.bridgeReadyResolve;
        state.bridgeReadyResolve = null;
        resolve();
      }
    }
    // 제 목 중 빠 (2026-11-06 른 실행): 정보 등 제목
    // undo/redo/print/search는 엔진 exec 채널로 동작하는 등 확정된
    // 엔진 기록으로 확정한다 (edit.undo/edit.redo먼저 접힌 명령,
    // edit.find는 what 파라미터로 이룬 등 이동, file.print는
    // 서식를 PDF알려 준다). 브리지(sheet-gridcraft.js)가
    // myhub-sheet:quick를 받아 exec로 번역한다. 가용된 문서가
    // 내부 등(ready)로 올린다. 마지막으로 교체하면 isCurrent 새로운
    // 캐시로 무효화된다.
    if (officeSurface) {
      window.MyHubOfficeTabs.onQuick('excel', function (action, value) {
        if (!ctx.isCurrent() || !frame.contentWindow) return false;
        if (['undo', 'redo', 'print', 'search'].indexOf(action) < 0) return false;
        frame.contentWindow.postMessage(
          { type: 'myhub-sheet:quick', action: action, value: typeof value === 'string' ? value : '' },
          ORIGIN,
        );
        return true;
      });
    }

    // 상단 메뉴 게시 안 함 (2026-11-12 사용자 지적·실브라우저 실증):
    // 운영 정본 메뉴 8종[파일·편집·보기·삽입·데이터·도구·자동화·설정]은
    // 항목 내용이 원본 자료 어디에도 없어 미회수라 menu-request에 빈
    // 항목으로 답했고, 클릭해도 드롭다운이 열리지 않는 죽은 메뉴였다.
    // 게시하는 메뉴는 전부 실동작해야 한다는 원칙에 따라 메뉴 자체를
    // 올리지 않는다 (빈 메뉴를 게시하지 않는다 — 2026-11-12 정리 1차의
    // 빈 메뉴 6종 제거와 같은 방식). 파일 열기·저장은 제목줄 빠른
    // 실행(저장 등)과 엔진 자체 리본의 파일 탭이 맡는다. 항목 내용이
    // 회수되면 그때 메뉴를 다시 게시한다.

    // 파일 실행 접근: 아래 시트 넣소재 리본/아래 영역(.fortune-workarea)
    // 등 함께 모서리 등 엔진을 그림으로 알고 chrome만 남긴다.
    function postChrome() {
      if (frame.contentWindow) {
        frame.contentWindow.postMessage(
          { type: 'myhub-sheet:chrome', folded: ctx.isFolded() },
          ORIGIN,
        );
      }
    }
    if (ctx.chromeFold) ctx.onFoldChange(postChrome);

    // 비서 세션 등록 등 office-assistant가 현재 문서를 열람/계산에 요청한다.
    session = {
      kind: 'sheet',
      ctx: ctx,
      snapshot: function () {
        return new Promise(function (resolve, reject) {
          if (!frame.contentWindow) {
            reject(new Error('편집기가 아직 준비되지 않았습니다'));
            return;
          }
          // 코드 분리 기록 21~23초 + 브리지 등등 시간까지 포함해야 한다 등
          // 15초내 정상 분리 중간 엔진의 파일 첫 열람인 등 시간
          // 초과로 죽었다 (E-3). 브리지 ready 대기 + 브리지 쪽 자기
          // 분리 중 요청이 붙으면 주요로, 등 상한은 진짜 무응답만 가른다.
          var timer = setTimeout(function () {
            if (state.snapshotWaiter) {
              state.snapshotWaiter = null;
            }
            reject(new Error('편집기 응답이 없습니다'));
          }, 60000);
          state.bridgeReadyPromise.then(function () {
            if (!frame.contentWindow) {
              clearTimeout(timer);
              reject(new Error('편집기가 아직 준비되지 않았습니다'));
              return;
            }
            state.snapshotWaiter = {
              resolve: function (v) {
                clearTimeout(timer);
                resolve(v);
              },
              reject: function (e) {
                clearTimeout(timer);
                reject(e);
              },
            };
            frame.contentWindow.postMessage({ type: 'myhub-sheet:request-snapshot' }, ORIGIN);
          });
        });
      },
      applyOps: function (ops) {
        return new Promise(function (resolve, reject) {
          if (!frame.contentWindow) {
            reject(new Error('편집기가 아직 준비되지 않았습니다'));
            return;
          }
          // 열람과 같은 이유 등 분리 등 시간까지 무응답으로 실패해 않게
          var timer = setTimeout(function () {
            if (state.opsWaiter) {
              state.opsWaiter = null;
              resolve({ applied: 0, errors: [{ index: -1, message: '편집기 응답이 없습니다' }] });
            }
          }, 45000);
          state.bridgeReadyPromise.then(function () {
            if (!frame.contentWindow) {
              clearTimeout(timer);
              resolve({ applied: 0, errors: [{ index: -1, message: '편집기가 아직 준비되지 않았습니다' }] });
              return;
            }
            state.opsWaiter = {
              resolve: function (v) {
                clearTimeout(timer);
                resolve(v);
              },
            };
            frame.contentWindow.postMessage({ type: 'myhub-sheet:ops', ops: ops }, ORIGIN);
          });
        });
      },
    };

    // [메뉴와] 단축키 코어 파일 명령을 공유 하는 실행 경로
    function saveViaEditor() {
      if (guard.macro && !state.editEnabled) {
        ctx.setStatus('마크다운이 있는 보기 전용입니다. 편집기에서 "그레이 편집"를 눌러 주세요');
        return Promise.resolve(false);
      }
      if (!frame.contentWindow) return Promise.resolve(false);
      return new Promise(function (resolve) {
        state.saveWaiter = function (ok) {
          resolve(ok);
        };
        // 브리지 ready 등 길이가 메시 지가가 우측 않고 사라진다 ready를
        // 기다려 보낸다 (아래 30초 상한은 전체를 감싼다).
        state.bridgeReadyPromise.then(function () {
          if (frame.contentWindow) {
            frame.contentWindow.postMessage({ type: 'myhub-sheet:request-save' }, ORIGIN);
          }
        });
        // 자릿수 응답하지 않으면(로드 실패 등) 무한 대기하지 않는
        setTimeout(function () {
          if (state.saveWaiter) {
            state.saveWaiter = null;
            ctx.setStatus('편집기 응답이 없습니다');
            resolve(false);
          }
        }, 30000);
      });
    }

    function onMessage(e) {
      if (e.origin !== ORIGIN) return;
      if (frame.contentWindow && e.source && e.source !== frame.contentWindow) return;
      if (!ctx.isCurrent()) {
        window.removeEventListener('message', onMessage);
        return;
      }
      var d = e.data || {};
      if (d.type === 'myhub-sheet:ready') {
        markBridgeReady();
        if (state.opened) return;
        state.opened = true;
        postChrome();
        // 제목 중 빠른 실행 가: 용성 엔진이 넣고 문서가 내부
        // 시점 undo/redo/print/search부분이 동작하는.
        if (officeSurface) {
          window.MyHubOfficeTabs.setQuick('excel', {
            undo: true,
            redo: true,
            print: true,
            search: true,
          });
        }
        if (isNew) {
          frame.contentWindow.postMessage(
            {
              type: 'myhub-sheet:open',
              name: ctx.file.name,
              guard: guard,
              mode: 'new',
            },
            ORIGIN,
          );
        } else {
          frame.contentWindow.postMessage(
            {
              type: 'myhub-sheet:open',
              name: ctx.file.name,
              guard: guard,
              bytes: buf,
            },
            ORIGIN,
            [buf],
          );
        }
      } else if (d.type === 'myhub-sheet:request-open') {
        // GridCraft 자체 [파일]찾기보기가 호스트로 위임된 것.
        // 일괄 에서 고정 파일을의 openFile 로 다시 가져온 파일
        // 계속까지 등 파일로 가져왔다. 취소하면 조용히 생략한.
        ctx.requestOpen();
      } else if (d.type === 'myhub-sheet:print-pdf') {
        // 제목 중 인쇄: 엔진이 만든 를 PDF통해 프레 임으로
        // 이어 인쇄 대화 상자에 전달한다. 실패하면 상태로 알린다.
        printPdfBase64(ctx, d.base64);
      } else if (d.type === 'myhub-sheet:quick-result') {
        // 제목중 빠른 실행의 실패 피드백 결과 (모두 찾기 인쇄 실패)
        if (!d.ok) {
          ctx.setStatus(
            d.action === 'search'
              ? '문서에서 찾을 수 없습니다'
              : d.error || '요청을 처리하지 못했습니다',
          );
        }
      } else if (d.type === 'myhub-sheet:paste-image') {
        // 클립보드 이미지 붙여넣기 결과 등 성공한 넣기 그림 화면에
        // 보이므로 조용히 알고, 실패만 사용자에게 알린다.
        if (!d.ok) ctx.setStatus('붙여넣기 이미지를 넣지 못했습니다');
      } else if (d.type === 'myhub-sheet:request-picture') {
        // GridCraft 그림 넣기 대화상자의 [찾기보기]가 호스트로 위임된
        // 것. 일괄에서 고정 그림 바이트는 deliver 콜백으로 등 프레임에
        // 되돌려진다. 취소하면 콜백이 오지 않아 조용히 생략한.
        ctx.requestPicture(function (name, bytes) {
          if (!ctx.isCurrent() || !frame.contentWindow || !bytes) return;
          var transfer = bytes instanceof ArrayBuffer ? [bytes] : [];
          frame.contentWindow.postMessage(
            { type: 'myhub-sheet:picture', name: name || '', bytes: bytes },
            ORIGIN,
            transfer,
          );
        });
      } else if (d.type === 'myhub-sheet:file-action') {
        // 대관(FortuneSheet) 실행 자체 [메뉴] 파일단축기로
        if (d.action === 'open') ctx.requestOpen();
        else if (d.action === 'save') saveViaEditor();
        else if (d.action === 'toggle-fold') ctx.setFolded(!ctx.isFolded());
        else if (d.action === 'close') ctx.closeViewer();
      } else if (d.type === 'myhub-sheet:edit-enabled') {
        state.editEnabled = true;
      } else if (d.type === 'myhub-sheet:engine-switch') {
        // 편집 페이지가 대관 페이지로 교체한다 등 등 페이지가 ready를
        // 보내면 open를 다시 줘야 한다.
        state.opened = false;
        armBridgeReady();
      } else if (d.type === 'myhub-sheet:snapshot') {
        var sw = state.snapshotWaiter;
        state.snapshotWaiter = null;
        if (sw) sw.resolve(d.snapshot);
      } else if (d.type === 'myhub-sheet:snapshot-error') {
        var sw2 = state.snapshotWaiter;
        state.snapshotWaiter = null;
        if (sw2) sw2.reject(new Error(d.message || '열람 실패'));
      } else if (d.type === 'myhub-sheet:ops-result') {
        var ow = state.opsWaiter;
        state.opsWaiter = null;
        if (ow) ow.resolve({ applied: d.applied || 0, errors: d.errors || [] });
      } else if (d.type === 'myhub-sheet:open-error') {
        ctx.showMessage('시트 파일을 내지 못했습니다');
      } else if (d.type === 'myhub-sheet:saved') {
        var waiter = state.saveWaiter;
        state.saveWaiter = null;
        var blob = new Blob([d.bytes], { type: XLSX_MIME });
        if (!waiter && d.name && ctx.file.name && d.name !== ctx.file.name) {
          // 엔진 안에 다른 문서를 띄었거나 다른 이름으로 저장한
          // 경우 등 지금 내부 파일이 넘어가면 열려진 파일이 맞지진다.
          // 다른 이름으로 저장 흐름으로 보내고, 호스트가 그 흐름을
          // 제공하지 않으면(Finder) 에 않고 안내만 남긴다.
          ctx.saveAsContent(blob, d.name);
        } else if (waiter) {
          ctx.putContent(blob).then(function (ok) {
            waiter(ok);
          });
        } else {
          // 등 안에 직접 아래 저장(Ctrl+S) 등 요청 시간자가 없어
          // 사용자의 저장 행동을 브리지 않고 그대로 반영한다.
          ctx.putContent(blob);
        }
      } else if (d.type === 'myhub-sheet:save-error') {
        var w2 = state.saveWaiter;
        state.saveWaiter = null;
        if (d.message === 'macro-readonly') {
          ctx.setStatus('마크다운이 있는 보기 전용입니다. 편집기에서 "그레이 편집"를 눌러 주세요');
        } else {
          ctx.setStatus('처음에 실패했습니다');
        }
        if (w2) w2(false);
      }
    }
    window.addEventListener('message', onMessage);

    // 실행 삽입 붙여넣기: 등 실행 문서에서 발생한 붙여넣기를 이미지
    // 파일을 읽어 브리지로 가져보낸다. 마지막으로 교체하면 캐시로
    // 해제한다 (onMessage와 같은 파일 규칙).
    var onWindowPaste = function (e) {
      if (!ctx.isCurrent()) {
        window.removeEventListener('paste', onWindowPaste, true);
        return;
      }
      if (isFormFieldTarget(e && e.target)) return;
      var f = pasteImageFile(e && e.clipboardData, true);
      if (!f) return;
      e.preventDefault();
      if (f.size > PASTE_MAX_BYTES) {
        ctx.setStatus('붙여넣기 이미지를 넣지 못했습니다');
        return;
      }
      fileToBase64(f).then(
        function (b64) {
          if (!ctx.isCurrent() || !frame.contentWindow) return;
          frame.contentWindow.postMessage(
            {
              type: 'myhub-sheet:paste-image-data',
              name: f.name || 'clipboard.png',
              mime: f.type || 'image/png',
              base64: b64,
            },
            ORIGIN,
          );
        },
        function () {
          if (ctx.isCurrent()) ctx.setStatus('붙여넣기 이미지를 넣지 못했습니다');
        },
      );
    };
    window.addEventListener('paste', onWindowPaste, true);

    if (ctx.saveBtn) ctx.saveBtn.hidden = false;
    ctx.setSaveHandler(saveViaEditor);
    if (guard.macro) {
      ctx.setNote('마크다운이 있는 파일 등 편집기에서 보기 전용으로 대변한다');
    }
    if (isNew) {
      ctx.setNote('등 워크북 등 저장할 등 위치의 이름을 정합한다');
    }
  }

  // 구형 xls: SheetJS첫 시 트만 보기 전용 표시 (기존 동작 유지)
  function handleXls(ctx) {
    return ctx.loadLib('xlsx').then(function (XLSX) {
      if (!ctx.isCurrent()) return;
      return ctx.fetchContent('buffer').then(function (buf) {
        if (!ctx.isCurrent()) return;
        var wb = XLSX.read(buf, { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
        // 표 시 상 한을("안내 200문구")처음 와 200같은 (감사 D13)
        var rows = aoa.slice(0, 200);
        var width = 0;
        rows.forEach(function (r) {
          width = Math.max(width, r.length);
        });
        width = Math.min(Math.max(width, 1), 40);
        var view = rows.map(function (r) {
          var copy = r.slice(0, width);
          while (copy.length < width) copy.push('');
          return copy;
        });
        var note = '구형 xls는 보기만 합니다 (xlsx로 저장하면 편집할 수 있어요)';
        if (aoa.length > 200) note += ' 처음 행만 200표시 등 그 아래 행은 그림으로 유지 합니다';
        ctx.setNote(note);
        ctx.clearBody();
        ctx.body.appendChild(
          ctx.buildGrid(view, function (r, c, value) {
            view[r][c] = value;
          }),
        );
      });
    });
  }

  // 시트 실행 자체 너비를([파일] 메뉴 중)에 가진다 등 코어 플로우
  // 에러리스트를 겹치지 않게 코어에 알린다 (세션에서만 하나가 있다)
  handleXlsx.ownsChrome = true;
  core.registerFormat('xlsx', handleXlsx);
  core.registerFormat('xls', handleXls);

  // 현재 내부 시트와 비서 세션 (마지막 교체, 문서가 닫히면 무효)
  var session = null;

  var api = {
    handleXlsx: handleXlsx,
    handleXls: handleXls,
    inspectXlsxLosses: inspectXlsxLosses,
    pasteImageFile: pasteImageFile,
    isFormFieldTarget: isFormFieldTarget,
    getSession: function () {
      return session && session.ctx.isCurrent() ? session : null;
    },
  };
  if (typeof window !== 'undefined') window.MyHubFinderFormatSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
