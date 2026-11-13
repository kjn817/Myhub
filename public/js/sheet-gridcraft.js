// 시트 편집 페이지(sheet.html)의 GridCraft 호스트 브리지.
// 파인더 뷰어(finder-format-sheet.js)와 myhub-sheet:* 프로토콜로,
// 넣소 GridCraft iframe와 gridcraft:* 프로토콜로 말하는 등 뷰어 쪽
// 계약(숨긴 CAS비서 세션)의 엔진 교체를 균일하게 그림이다.
// 비 서(myhub-sheet:ops)연산 GridCraft 를 엔진(cell.set 명령)로
// 번역해 gridcraft:exec로 실행한다 등 엔진의 컨테이너 층이 파일 진짜이다.
// 폰트: Drive '의' 폴더의 페이지를 gridcraft:fonts로 받아서 넣는다.
// 안에 내장 공용 등(MyHubFonts.POOL_FACES 의 오피스 프로그램 내장
// 폰트 모양)를 항상 병합한다: 파일 Inter와JetBrains Mono 같은 등
// 페이스 이름으로 지정하면 Drive에 없어 그 페이지로 그림진다
// (엔진가 bind_host_faces페이스 이름으로 바인딩 에). Drive 페이지가
// 먼저 사용자 폰트가 같은 페이스 가지면 그쪽이 숨긴다.
(function () {
  'use strict';

  // GridCraft 자체 레이아웃을 그림으로 이룬다: 자체 제목 중에 경고(파일명인
  // 차 제목중이 보여중) 파일 피벗본 엔진 것이 주인공이다. 따라
  // 파일 메뉴 행인 표시 않는다 (2026-11-03 사용자 지정).
  // 엔진 내장 등 복원 (2026-11-06 실행 페이지): 에서는 실행 엔진의 행을
  // 파일 그 림의 등 등(?tabs=host 호스트 chrome=notabs + 상태 중첩)
  // 등 의한다 등 등 실행에서 엔진의 행이 그림으로 주인 공이다.
  var GC_URL = '/vendor/gridcraft/index.html?host=parent&chrome=notitlebar';

  /**
   * 엔진 캔버스가 iframe보다 앞선 낮은 곱하기 (구했다 찾기 진단).
   * 순수 함수 등 경계인 단위 테스트로 고정한다.
   */
  function isCanvasStuck(frameW, frameH, canvasW, canvasH) {
    if (!(frameW >= 500) || !(frameH >= 300)) return false;
    if (!(canvasW > 0) || !(canvasH > 0)) return false;
    return canvasW < frameW * 0.55 || canvasH < frameH * 0.55;
  }

  /**
   * 캔버스 요소(CSS 짜을)채워 넣어 실제 그리 기가 버퍼(배경 스토어)가
   * 낮은 곱한 경우 등 엔진의 분리 시간을 그림을 앗고 resize를 넓힌
   * 브라우저에서 발생한다. CSS 가 기준 최소 1배는 있어야 정상이다.
   */
  function isBackingStuck(clientW, clientH, attrW, attrH) {
    if (!(clientW >= 500) || !(clientH >= 300)) return false;
    if (!(attrW > 0) || !(attrH > 0)) return false;
    return attrW < clientW * 0.55 || attrH < clientH * 0.55;
  }

  /**
   * GridCraft의담린 를 UI 설정한 무엇가 브라우저 무엇보다 우선한다 등
   * 상판가 담린 브라우저에서는 공용 상판으로 이룬다. iframe의 앞이
   * 전에 localStorage(gridcraft.ui)에 한국어 병합을 확정한다.
   */
  function seedLanguage(win) {
    try {
      var store = win && win.localStorage;
      if (!store) return;
      var raw = store.getItem('gridcraft.ui');
      var ui = {};
      if (raw) {
        try {
          ui = JSON.parse(raw) || {};
        } catch (e) {
          ui = {};
        }
      }
      if (ui.language !== 'ko') {
        ui.language = 'ko';
        store.setItem('gridcraft.ui', JSON.stringify(ui));
      }
    } catch (e) {
      console.warn('GridCraft 넣기 실행 실패:', e);
    }
  }
  var ORIGIN =
    typeof window !== 'undefined' && window.location ? window.location.origin : '';
  // 코드 분리 기록(총 E + CW9 단계 분리): WASM(17MB) 컴파일+엔진 확정까지
  // 21~23초 내. 20정상 분리 앞짱 실패 배 너가 등 대관
  // (FortuneSheet)로 있는 엔진 루프의 원인인 하나로 사용을 본다.
  var LOAD_TIMEOUT_MS = 45000;

  // 비서 열람 캡 등 엔진 host.rs의 SNAPSHOT_ROWS/SNAPSHOT_COLS와 같은 값.
  // 엔진의 등 차이까지 하나 알려주므로, 캡에 우측 열람은 "전체가 아니
  // 등있음 를"표시한 판독 서버(아카이브 비서 단락)가 고정하게 한다.
  var SNAPSHOT_ROW_CAP = 120;
  var SNAPSHOT_COL_CAP = 30;

  /**
   * 열람이 엔진 캡(120행30열)을 우측하면 rowsCapped/colsCapped를 온다.
   * 엔진의 내용을 마지막 행으로 남의 알려주므로, 캡과 같은 그림으로
   * 파한 열람의 그너머 데이터 등 있을 등 아니 살이 이다 (E-4).
   * 순수 함수 등 단위 테스트로 경계를 고정한다.
   */
  function annotateSnapshotCaps(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.cells)) return snapshot;
    if (snapshot.cells.length >= SNAPSHOT_ROW_CAP) snapshot.rowsCapped = true;
    for (var i = 0; i < snapshot.cells.length; i += 1) {
      var row = snapshot.cells[i];
      if (Array.isArray(row) && row.length >= SNAPSHOT_COL_CAP) {
        snapshot.colsCapped = true;
        break;
      }
    }
    return snapshot;
  }

  // ---------- 순수 변환: MyHub SheetOp 연산등 GridCraft 엔진 명령 ----------

  function colLetters(col) {
    var out = '';
    var n = col;
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  }

  function parseCellRef(ref) {
    var m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(String(ref || '').trim());
    if (!m) return null;
    var col = 0;
    var letters = m[1].toUpperCase();
    for (var i = 0; i < letters.length; i += 1) col = col * 26 + (letters.charCodeAt(i) - 64);
    return { col: col - 1, row: parseInt(m[2], 10) - 1 };
  }

  function topLeftOf(range) {
    return String(range || '').split(':')[0].trim();
  }

  function asFormula(f) {
    var s = String(f || '');
    return s.charAt(0) === '=' ? s : '=' + s;
  }

  // set_cell의 input를 작은 텍스트 입력이다 등 수식이 '='로 시작하고,
  // 숫자 숫자 문자열로, 불리언 TRUE/FALSE를 이면 엔진이 해석한다.
  function cellInput(op) {
    if (op.formula !== undefined && op.formula !== null) return asFormula(op.formula);
    var v = op.value;
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  function entryValue(e) {
    if (e && typeof e === 'object') {
      if (e.formula !== undefined && e.formula !== null) return asFormula(e.formula);
      return e.value === undefined ? null : e.value;
    }
    return e === undefined ? null : e;
  }

  // 반환: [{ op: <연산 인덱스>, id, params }] 명령 연산 하나가 명령 여러 개로
  // 완전히 등 있어(값 넣기 = 값 걸기 + 머리말 구하는) 인덱스 함께 넣는다.
  function opsToCommands(ops) {
    var flat = [];
    (ops || []).forEach(function (op, idx) {
      if (!op || typeof op.type !== 'string') return;
      if (op.type === 'set_cell') {
        flat.push({ op: idx, id: 'cell.set', params: { cell: op.cell, input: cellInput(op) } });
      } else if (op.type === 'set_range') {
        var values = (op.values || []).map(function (row) {
          return (row || []).map(entryValue);
        });
        flat.push({
          op: idx,
          id: 'range.setValues',
          params: { range: topLeftOf(op.range), values: values },
        });
      } else if (op.type === 'insert_table') {
        var grid = [op.headers || []].concat(op.rows || []);
        flat.push({
          op: idx,
          id: 'range.setValues',
          params: { range: op.at, values: grid },
        });
        var at = parseCellRef(op.at);
        if (at && (op.headers || []).length > 0) {
          var endCol = colLetters(at.col + op.headers.length - 1);
          flat.push({
            op: idx,
            id: 'home.bold',
            params: {
              range: op.at + ':' + endCol + (at.row + 1),
              on: true,
            },
          });
        }
      } else if (op.type === 'sort_range') {
        var start = parseCellRef(topLeftOf(op.range));
        var by = typeof op.by === 'number' ? op.by : 0;
        flat.push({
          op: idx,
          id: 'data.sort',
          params: {
            range: op.range,
            header: !!op.hasHeader,
            keys: [
              {
                column: colLetters((start ? start.col : 0) + by),
                order: op.order === 'desc' ? 'desc' : 'asc',
              },
            ],
          },
        });
      } else if (op.type === 'format_range') {
        if (op.bold !== undefined) {
          flat.push({
            op: idx,
            id: 'home.bold',
            params: { range: op.range, on: !!op.bold },
          });
        }
        if (op.background) {
          flat.push({
            op: idx,
            id: 'home.fillColor',
            params: { range: op.range, color: op.background },
          });
        }
        if (op.numberFormat) {
          flat.push({
            op: idx,
            id: 'home.numberFormat',
            params: { range: op.range, code: op.numberFormat },
          });
        }
      }
    });
    return flat;
  }

  // exec 결과(flat 순서인 같은 results)를 연산 단위 결과로 답는다.
  // 연산의 명령의 하나라도 실패하면 그 연산의 errors에 온다.
  function aggregateExecResults(ops, flat, results) {
    var perOp = {};
    flat.forEach(function (cmd, i) {
      var r = results && results[i];
      if (!perOp[cmd.op]) perOp[cmd.op] = { total: 0, failed: null };
      perOp[cmd.op].total += 1;
      if (!r || !r.ok) {
        if (!perOp[cmd.op].failed) {
          perOp[cmd.op].failed = (r && r.error) || '편집기 연산 실패';
        }
      }
    });
    var applied = 0;
    var errors = [];
    (ops || []).forEach(function (op, idx) {
      var info = perOp[idx];
      if (!info || info.total === 0) {
        errors.push({ index: idx, message: '지원하지 않는 연산입니다: ' + (op && op.type) });
      } else if (info.failed) {
        errors.push({ index: idx, message: info.failed });
      } else {
        applied += 1;
      }
    });
    return { applied: applied, errors: errors };
  }

  // ---------- 클립보드 붙여넣기 (순수 헬퍼) ----------
  // 엔진(egui 의)붙여 넣기를 텍스트로만 받는 등 OS 의
  // 이미지 파일은 엔진의 우측 않는다 (2026-11-05 기록). 그레이 호스트가
  // 붙여넣기 이벤트에서 이미지 파일을 가로채 엔진 명령
  // insert.picture(base64)로 읽어넣는다. 등, 스프레드 시트처럼
  // 표(table) HTML를 함께 등 붙여넣기 등 붙여넣기가 본래 동작이라
  // 엔 진이 (답는다 그림+파일 HTML를 그림 숨긴다).

  var PASTE_MAX_BYTES = 32 * 1024 * 1024; // host.rs MAX_PICTURE_BYTES와 같은 상한

  function isFormFieldTarget(t) {
    if (!t || typeof t !== 'object') return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function pasteImageFile(cd, skipTableHtml) {
    if (!cd) return null;
    if (skipTableHtml && typeof cd.getData === 'function') {
      var html = '';
      try {
        html = cd.getData('text/html') || '';
      } catch (err) {
        html = '';
      }
      if (/<table[\s>]/i.test(html)) return null;
    }
    var files = cd.files;
    if (files && files.length) {
      for (var i = 0; i < files.length; i++) {
        if (files[i] && String(files[i].type || '').indexOf('image/') === 0) return files[i];
      }
    }
    var items = cd.items;
    if (items) {
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (
          it &&
          it.kind === 'file' &&
          String(it.type || '').indexOf('image/') === 0 &&
          typeof it.getAsFile === 'function'
        ) {
          var f = it.getAsFile();
          if (f) return f;
        }
      }
    }
    return null;
  }

  function fileToBase64(file, ReaderCtor) {
    return new Promise(function (resolve, reject) {
      var reader = new ReaderCtor();
      reader.onload = function () {
        var url = String(reader.result || '');
        var comma = url.indexOf(',');
        resolve(comma >= 0 ? url.slice(comma + 1) : '');
      };
      reader.onerror = function () {
        reject(reader.error || new Error('파일을 읽지 못했습니다'));
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- 페이지 컨트롤러 ----------

  function createBridge(deps) {
    var doc = deps.document;
    var win = deps.window;
    var root = deps.root;
    var postToParent = deps.postToParent;
    var fonts = deps.fonts || null;
    var fetchFn = deps.fetchFn;
    var setTimeoutFn = deps.setTimeoutFn || setTimeout;
    var clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;

    var state = {
      gcReady: false,
      pendingOpen: null,
      openSent: false,
      editEnabled: false,
      awaitingSave: false,
      tagSeq: 0,
      pendingSnapshots: {},
      pendingOps: {},
      pendingQuick: {},
      loadTimer: null,
      name: '',
      watchdogReloads: 0,
      watchdogTimer: null,
      watchdogTimer2: null,
      nudged: false,
      bootSettled: false,
      bootW: 0,
      bootH: 0,
      pasteDoc: null,
      pendingPastes: {},
      pasteTimers: [],
      queuedRequests: [],
    };
    // 엔진의 부족한 시간 차 그림 등 수째 차이 흘러 컨테이너 엔진의
    // 분리 그림을 앗고 있으면(브라 우저별) 차이 확정 그림이다.
    state.bootW = (win && win.innerWidth) || 0;
    state.bootH = (win && win.innerHeight) || 0;

    root.innerHTML = '';
    var shell = doc.createElement('div');
    shell.className = 'sheet-shell';
    var banner = doc.createElement('div');
    banner.className = 'sheet-banner';
    banner.hidden = true;
    var editor = doc.createElement('div');
    editor.className = 'sheet-editor';
    var frame = doc.createElement('iframe');
    frame.className = 'sheet-gc-frame';
    frame.title = '시트 편집기';
    // gate-74: 모든 iframe의 sandbox 필수. 엔진 실행(allow-scripts)과
    // 같은 출처 origin 검증(allow-same-origin)의 최소 선택이다.
    // allow-modals는 엔진 자체 인쇄(이 인쇄가 자기 문서 등 그
    // 프레임으로 window.print()를 부르는 경로)를 필수 선택한다 등
    // 없으면 브라우저가 그 노출을 조용히 무시한다 (프로브 기록
    // 2026-11-06; 반쯤 sheet.html 프레임에 같은 선택이 있다).
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals');
    frame.src = GC_URL;
    // 풀 폰트 조기 fetch (2026-11-13 성능 4라운드, 5라운드에서 load 이후로
    // 지연): 엔진 WASM 부팅과 병렬로 내장 폰트 풀(11MB)을 받아 둔다.
    // load 전에 받으면 느린 네트워크에서 문서 자체의 로딩을 가로막는다
    // (실측: Fast 3G에서 Excel 로딩 21.7s — 폰트 11MB + WASM 18MB가
    // 1.6Mbps 회선을 포화). load 이후에 시작해도 WASM 부팅보다 먼저
    // 끝나므로 한글 tofu 구간은 그대로 짧다. loadPoolBytes는 fetchFn별
    // Promise를 캐시하므로 pushFonts()가 gcReady 뒤에 다시 불러도 같은
    // 진행 중 Promise를 재사용한다 — 직렬 대기가 사라진다.
    // load가 이미 끝난 상태(파인더에서 파일 열기 등)면 즉시 받는다.
    function prefetchPoolFonts() {
      if (!fonts || typeof fonts.loadPoolBytes !== 'function') return;
      try {
        var poolPrefetch = fonts.loadPoolBytes(fetchFn);
        if (poolPrefetch && typeof poolPrefetch.catch === 'function') {
          // 폰트 풀 실패가 부팅을 막지 않는다 — 경고만 남긴다.
          poolPrefetch.catch(function (err) {
            console.warn('GridCraft 풀 폰트 조기 fetch 실패:', err);
          });
        }
      } catch (e) {
        console.warn('GridCraft 풀 폰트 조기 fetch 실패:', e);
      }
    }
    if (doc.readyState === 'complete') {
      prefetchPoolFonts();
    } else if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('load', prefetchPoolFonts, { once: true });
    } else {
      prefetchPoolFonts();
    }
    var veil = doc.createElement('div');
    veil.className = 'sheet-readonly-veil';
    veil.hidden = true;
    var loading = doc.createElement('div');
    loading.className = 'sheet-gc-loading';
    var loadingTitle = doc.createElement('div');
    loadingTitle.className = 'sheet-gc-loading-title';
    loadingTitle.textContent = 'Excel';
    var loadingSpin = doc.createElement('div');
    loadingSpin.className = 'sheet-gc-loading-spin';
    loadingSpin.setAttribute('aria-hidden', 'true');
    var loadingStatus = doc.createElement('div');
    loadingStatus.className = 'sheet-gc-loading-status';
    loadingStatus.textContent = '시트 편집기를 불러오는 중';
    loading.appendChild(loadingTitle);
    loading.appendChild(loadingSpin);
    loading.appendChild(loadingStatus);
    editor.appendChild(frame);
    editor.appendChild(veil);
    editor.appendChild(loading);
    shell.appendChild(banner);
    shell.appendChild(editor);
    root.appendChild(shell);
    // 엔진 iframe의 남긴 전에 무엇을 한국어로 확정한다 (파일 설정 우선
    // 규칙 뒤집어 iframe 로드 전에 않는다).
    seedLanguage(win);

    function postToGc(msg, transfer) {
      if (!frame.contentWindow) return;
      if (transfer && transfer.length) frame.contentWindow.postMessage(msg, ORIGIN, transfer);
      else frame.contentWindow.postMessage(msg, ORIGIN);
    }

    // 엔 진의 넣기(ready 등)대변 파일을 숨긴 전에 보낸 요청이
    // postMessage가 우측 리스너가 없어 그림으로 사라진다 등 기록 비서의
    // 첫 열람인 등상 등 경로로 소실 한다 15붙어 초 핵심으로
    // 치수와 실패 (E-3). 한다 준비+숨긴 시간이 자기 전에 높고,
    // 준비되면 즉시 순서대로 넘어보낸다. 위치의 그림으로 준비 상태가
    // 되돌려지면 자동 함께 기다리다간다 등 엔진의 다시 넘어간다.
    function engineAcceptsRequests() {
      return state.gcReady && state.openSent;
    }
    function postToGcWhenReady(msg) {
      if (engineAcceptsRequests()) postToGc(msg);
      else state.queuedRequests.push(msg);
    }
    function flushQueuedRequests() {
      if (!engineAcceptsRequests()) return;
      var queued = state.queuedRequests;
      state.queuedRequests = [];
      queued.forEach(function (msg) {
        postToGc(msg);
      });
    }

    // ---------- 클립보드 이미지 붙여넣기 ----------
    // 붙여넣기 이벤트는 삽입이 있는 문서에서만 발생하므로 등 실행
    // 각각 넣는다 등 엔진 iframe 문서(캡처 삽입), 의 브리지 문서
    // (반쯤 등), 붙어 실행(뷰어 너비 등 붙어 myhub-sheet:paste-image-data로
    // 바이트를 가져보낸다). 이벤트는 등 문서에서만 발생한 경로인 겹치지
    // 않고, 넣기 실행 insertImageBase64 하나로 연결한다.
    var PASTE_TIMEOUT_MS = 20000;

    function notifyPasteResult(ok, error) {
      postToParent({ type: 'myhub-sheet:paste-image', ok: !!ok, error: error || '' });
    }

    function insertImageBase64(base64, mime) {
      if (!state.gcReady) {
        notifyPasteResult(false, '편집기가 아직 준비되지 않았습니다');
        return;
      }
      if (!base64) {
        notifyPasteResult(false, '이미지를 읽지 못했습니다');
        return;
      }
      // base64 길이는 원본의 4/3 배등 인코딩 그림 근사로 상한을 건다
      if (base64.length > Math.ceil(PASTE_MAX_BYTES / 3) * 4 + 4) {
        notifyPasteResult(false, '이미지가 너무 큽니다 (32MB 초과)');
        return;
      }
      state.tagSeq += 1;
      var tag = 'paste-' + state.tagSeq;
      var timer = setTimeoutFn(function () {
        if (!state.pendingPastes[tag]) return;
        delete state.pendingPastes[tag];
        notifyPasteResult(false, '편집기 응답이 없습니다');
      }, PASTE_TIMEOUT_MS);
      state.pendingPastes[tag] = { timer: timer };
      postToGc({
        type: 'gridcraft:exec',
        tag: tag,
        commands: [
          {
            id: 'insert.picture',
            params: { base64: base64, mime: mime || 'image/png', placement: 'overCells' },
          },
        ],
      });
    }

    function insertPastedFile(file) {
      if (!file) return;
      if (file.size > PASTE_MAX_BYTES) {
        notifyPasteResult(false, '이미지가 너무 큽니다 (32MB 초과)');
        return;
      }
      var ReaderCtor =
        (win && win.FileReader) || (typeof FileReader !== 'undefined' ? FileReader : null);
      if (!ReaderCtor) {
        notifyPasteResult(false, '이미지를 읽지 못했습니다');
        return;
      }
      fileToBase64(file, ReaderCtor).then(
        function (b64) {
          insertImageBase64(b64, file.type || 'image/png');
        },
        function () {
          notifyPasteResult(false, '이미지를 읽지 못했습니다');
        },
      );
    }

    function onPasteEvent(e) {
      if (isFormFieldTarget(e && e.target)) return;
      var file = pasteImageFile(e && e.clipboardData, true);
      if (!file) return;
      // 이미지가 본래 넣기물인 등 엔진의 같은 붙여넣기를 텍스트로
      // 다시 처리해 않게 그림으로 않는다.
      e.preventDefault();
      e.stopPropagation();
      insertPastedFile(file);
    }

    // 엔진 iframe 문서의 캡처 리스너 온다. iframe를 다시 로드하면
    // 문서가 교체하므로 첫째 확인한 등 문서의 다시 온다 (한글
    // 호스트의 dirty-watch와 같은 배선 방식).
    function tryAttachPaste() {
      var fdoc = null;
      try {
        fdoc = frame.contentDocument;
      } catch (err) {
        fdoc = null;
      }
      if (!fdoc || state.pasteDoc === fdoc) return;
      state.pasteDoc = fdoc;
      fdoc.addEventListener('paste', onPasteEvent, true);
    }
    frame.addEventListener('load', tryAttachPaste);
    win.addEventListener('paste', onPasteEvent, true);

    function isMacroBlocked() {
      return !!(
        state.pendingOpen &&
        state.pendingOpen.guard &&
        state.pendingOpen.guard.macro &&
        !state.editEnabled
      );
    }

    function renderGuard() {
      var guard = state.pendingOpen && state.pendingOpen.guard;
      banner.innerHTML = '';
      if (!guard || !guard.macro) {
        banner.hidden = true;
        veil.hidden = true;
        return;
      }
      var p = doc.createElement('p');
      p.textContent = state.editEnabled
        ? '이 파일에는 매크로(VBA)가 들어 있습니다. 편집은 켜집니다 등 저장하면 매크로는 사라집니다.'
        : '이 파일에는 매크로(VBA)가 들어 있습니다. 기본은 보기 전용이고, 편집은 저장하면 매크로는 사라집니다.';
      banner.appendChild(p);
      if (!state.editEnabled) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'sheet-banner-btn';
        btn.textContent = '그레이 편집';
        btn.addEventListener('click', function () {
          state.editEnabled = true;
          postToParent({ type: 'myhub-sheet:edit-enabled' });
          renderGuard();
        });
        banner.appendChild(btn);
      }
      banner.hidden = false;
      veil.hidden = !isMacroBlocked();
    }

    function showError(message) {
      banner.innerHTML = '';
      var p = doc.createElement('p');
      p.textContent = message;
      banner.appendChild(p);
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'sheet-banner-btn';
      btn.textContent = '기존 편집기로 열기';
      btn.addEventListener('click', switchToFallback);
      banner.appendChild(btn);
      banner.hidden = false;
      loading.hidden = true;
    }

    function switchToFallback() {
      // 붙어 opened 상태를 되돌 려야 등 ready페이지가 를 open다시 중
      postToParent({ type: 'myhub-sheet:engine-switch' });
      if (typeof deps.navigate === 'function') deps.navigate('/sheet-fortune.html');
      else win.location.replace('/sheet-fortune.html');
    }

    // 찾기단축키 위치는: 엔진의 분리 그림에서 곱한 너비(브라우저마다 호가가
    // 옆에)를 등 가 로로 확정 한다 등 등 캔버스 요소가 차이난
    // 등 요소의 끝에 그리기가 버퍼가 앉음 등 분리의 등 차이 흘러 컨테이너.
    // 그림의 그림이 원본과 등단독 아래에 깊이까지만 한다 (E-3 기록 건강한
    // 엔진의 브리지 코드 분리의 비용이 다시 치른다). 복구의 단계는:
    // 먼저 엔진 차에 resize를 넘어 깊이와(값의), 곱한 계속 곱해 있으면
    // 엔진의 현재 그림으로 다시 전용인(숨긴 상태의 브리지가 사전인).
    function checkCanvasSize() {
      if (!state.gcReady || state.watchdogReloads >= 2) return;
      var gw = frame.contentWindow;
      if (!gw || !gw.document) return;
      var canvas = gw.document.querySelector('canvas');
      if (!canvas) return;
      var innerW = gw.innerWidth || 0;
      var innerH = gw.innerHeight || 0;
      if (innerW < 500 || innerH < 300) return;
      var stuck =
        isCanvasStuck(innerW, innerH, canvas.clientWidth, canvas.clientHeight) ||
        isBackingStuck(canvas.clientWidth, canvas.clientHeight, canvas.width, canvas.height);
      if (!stuck && !state.bootSettled) {
        var grew =
          (state.bootW > 0 && state.bootW < innerW * 0.55) ||
          (state.bootH > 0 && state.bootH < innerH * 0.55) ||
          state.bootW === 0 ||
          state.bootH === 0;
        if (grew) {
          // 확장 단독 호가가 그림 으로 그림이다 기록 (E-3): 캔버스가
          // 버퍼 호가가 건강하다간 차이만 컨테이너 경우에도 엔진의 브리지 코드
          // 분리의 비용(17MB WASM 컴파일)를 핵심으로 다시 치를 준비 지정의
          // 차퀄리(170초 미완해)가 한다. 깊이가(resize)를 하고,
          // 그레이 호가가 곱해 있으면 등 원본 호가가 다음 검색에 앉는다.
          if (!state.nudged) {
            state.nudged = true;
            try {
              gw.dispatchEvent(new gw.Event('resize'));
            } catch (e) {
              console.warn('GridCraft 그리기 깊이 실패:', e);
            }
            scheduleCanvasCheck(800);
          } else {
            state.bootSettled = true;
          }
          return;
        }
      }
      if (!stuck) return;
      if (!state.nudged) {
        state.nudged = true;
        try {
          gw.dispatchEvent(new gw.Event('resize'));
        } catch (e) {
          console.warn('GridCraft 그리기 깊이 실패:', e);
        }
        scheduleCanvasCheck(800);
        return;
      }
      state.watchdogReloads += 1;
      state.bootSettled = true;
      state.bootW = innerW;
      state.bootH = innerH;
      state.gcReady = false;
      state.openSent = false;
      loading.hidden = false;
      if (state.loadTimer) clearTimeoutFn(state.loadTimer);
      state.loadTimer = setTimeoutFn(function () {
        if (!state.gcReady) showError('시트 편집기를 불러오지 못했습니다. 네트워크를 확인하거나 기존 편집기로 열어 주세요.');
      }, LOAD_TIMEOUT_MS);
      frame.src = GC_URL;
    }
    function scheduleCanvasCheck(ms) {
      if (state.watchdogTimer) clearTimeoutFn(state.watchdogTimer);
      state.watchdogTimer = setTimeoutFn(checkCanvasSize, ms);
    }

    function sendOpen() {
      var open = state.pendingOpen;
      if (!open || state.openSent || !state.gcReady) return;
      state.openSent = true;
      state.name = open.name || state.name;
      if (open.mode === 'new' || !open.bytes) return;
      postToGc({ type: 'gridcraft:open', name: open.name, bytes: open.bytes }, [open.bytes]);
    }

    function pushFonts() {
      if (!fonts || typeof fonts.whenReady !== 'function') return;
      var poolReady =
        typeof fonts.loadPoolBytes === 'function'
          ? fonts.loadPoolBytes(fetchFn).catch(function () {
              return [];
            })
          : Promise.resolve([]);
      fonts
        .whenReady(4000)
        .then(function () {
          var faces = typeof fonts.faces === 'function' ? fonts.faces() : [];
          var driveReady = Promise.all(
            faces.map(function (face) {
              return fetchFn('/api/drive/files/' + face.fileId + '/content')
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
          );
          return Promise.all([driveReady, poolReady]);
        })
        .then(function (both) {
          var usable = both[0].filter(Boolean).concat(
            both[1].map(function (f) {
              return {
                family: f.family,
                weight: f.weight,
                style: f.style,
                bytes: f.u8.slice().buffer, // 를 임시로 복사해서 보낸다 (transfer detach)
              };
            }),
          );
          if (!usable.length) return;
          var transfer = usable.map(function (f) {
            return f.bytes;
          });
          postToGc({ type: 'gridcraft:fonts', fonts: usable }, transfer);
        })
        .catch(function () {
          return null; // 폰트 실패는 편집을 막지 않는다
        });
    }

    // 제목 중 빠른 실행 등 엔진 exec 번역. 결과 exec-result에서
    // 기록로 수간본다: 인쇄를 PDF base64붙어 아래로 올린 실제 인쇄
    // 흐름을 등 하고, 검색 실패(찾을 수 없음)를 상태로 알린다.
    // undo/redo는 "아무 것이 없음"를 조용히 본다 (일반 편집기 파일).
    function handleQuick(d) {
      var action = d.action;
      var cmd = null;
      if (action === 'undo') cmd = { id: 'edit.undo' };
      else if (action === 'redo') cmd = { id: 'edit.redo' };
      else if (action === 'print') cmd = { id: 'file.print' };
      else if (action === 'search') {
        var what = typeof d.value === 'string' ? d.value.trim() : '';
        if (!what) return;
        cmd = { id: 'edit.find', params: { what: what } };
      }
      if (!cmd) return;
      state.tagSeq += 1;
      var tag = 'quick-' + state.tagSeq;
      state.pendingQuick[tag] = { action: action };
      postToGcWhenReady({ type: 'gridcraft:exec', tag: tag, commands: [cmd] });
    }

    function onParentMessage(e) {
      if (e.origin !== ORIGIN) return;
      if (win.parent && e.source && e.source !== win.parent) return;
      var d = e.data || {};
      if (d.type === 'myhub-sheet:open') {
        state.pendingOpen = {
          name: d.name,
          guard: d.guard || { macro: false, losses: [] },
          bytes: d.bytes || null,
          mode: d.mode || null,
        };
        state.name = d.name || '';
        state.watchdogReloads = 0;
        state.nudged = false;
        state.bootSettled = false;
        renderGuard();
        sendOpen();
        flushQueuedRequests();
      } else if (d.type === 'myhub-sheet:chrome') {
        shell.classList.toggle('sheet-shell-folded', !!d.folded);
      } else if (d.type === 'myhub-sheet:quick') {
        // 제목 중 빠른 실행 (2026-11-06 실행 기록): 엔진 exec 채널로
        // 번역한다. 명령 id파라미터 엔진 기록으로 정한 것만 이룬다
        // (edit.undo/edit.redo 집힌, edit.find명 what 령의, file.print
        // 등 인쇄 PDF base64를 exec-result로 알려준다).
        handleQuick(d);
      } else if (d.type === 'myhub-sheet:request-save') {
        if (isMacroBlocked()) {
          postToParent({ type: 'myhub-sheet:save-error', message: 'macro-readonly' });
          return;
        }
        state.awaitingSave = true;
        postToGcWhenReady({ type: 'gridcraft:request-save' });
      } else if (d.type === 'myhub-sheet:picture') {
        // 호스트 일괄이 고정 그림 바이트 등 엔진의 등시간 중간 그림 넣기
        // 대화상자로 그림을 넘긴다. ArrayBuffer면 소유권 이전으로 복사
        // 없이 보, 내고(Uint8Array 뷰)이면 구조 복제로 보낸다.
        var ptransfer = d.bytes instanceof ArrayBuffer ? [d.bytes] : [];
        postToGc(
          { type: 'gridcraft:picture', name: d.name || '', bytes: d.bytes },
          ptransfer,
        );
      } else if (d.type === 'myhub-sheet:paste-image-data') {
        // 붙어 실행(뷰어 너비)삽입이 앉은 붙여 넣기 등 붙어 넣기
        // 클립보드 이미지를 base64로 가져보낸다. 실행결과 핵심 엔진
        // 문서에서 온 붙여넣기와 같은 경로를 아니다.
        insertImageBase64(typeof d.base64 === 'string' ? d.base64 : '', d.mime || 'image/png');
      } else if (d.type === 'myhub-sheet:request-snapshot') {
        state.tagSeq += 1;
        var stag = 'snap-' + state.tagSeq;
        state.pendingSnapshots[stag] = true;
        postToGcWhenReady({ type: 'gridcraft:snapshot', tag: stag });
      } else if (d.type === 'myhub-sheet:ops') {
        var ops = Array.isArray(d.ops) ? d.ops : [];
        var flat = opsToCommands(ops);
        if (!flat.length) {
          var agg = aggregateExecResults(ops, flat, []);
          postToParent({
            type: 'myhub-sheet:ops-result',
            applied: agg.applied,
            errors: agg.errors,
          });
          return;
        }
        state.tagSeq += 1;
        var otag = 'ops-' + state.tagSeq;
        state.pendingOps[otag] = { ops: ops, flat: flat };
        postToGcWhenReady({
          type: 'gridcraft:exec',
          tag: otag,
          commands: flat.map(function (c) {
            return { id: c.id, params: c.params };
          }),
        });
      }
    }

    function onGcMessage(e) {
      if (e.origin !== ORIGIN) return;
      if (!frame.contentWindow || e.source !== frame.contentWindow) return;
      var d = e.data || {};
      if (d.type === 'gridcraft:ready') {
        if (state.gcReady) return;
        state.gcReady = true;
        state.nudged = false;
        if (state.loadTimer) {
          clearTimeoutFn(state.loadTimer);
          state.loadTimer = null;
        }
        loading.hidden = true;
        sendOpen();
        flushQueuedRequests();
        pushFonts();
        tryAttachPaste();
        // 문서 교체 차례 대로 ready 직후 문서가 아직 이전 것인 등
        // 있어 모든 차이 등 붙임 본다 (넣기 자 gcReady체가 현재
        // ready 등 기록한 하나가 없다). 붙어 잠시만 앞의 대표를
        // 이룬다 등주요 대표의 로드 위치 흐름인 모양이다.
        [300, 900, 2000, 4500].forEach(function (ms) {
          state.pasteTimers.push(setTimeout(tryAttachPaste, ms));
        });
        scheduleCanvasCheck(1500);
        if (state.watchdogTimer2) clearTimeoutFn(state.watchdogTimer2);
        state.watchdogTimer2 = setTimeoutFn(checkCanvasSize, 4500);
      } else if (d.type === 'gridcraft:save') {
        state.awaitingSave = false;
        // 이름과 함께 올린다 등 엔진 안에 다른 문서를 띄었거나 다른
        // 이름으로 저장한 경우, 붙어 현재 파일인 착 않게 하기 위해.
        postToParent({ type: 'myhub-sheet:saved', bytes: d.bytes, name: d.name || state.name || '' });
      } else if (d.type === 'gridcraft:request-open') {
        // 엔진 [파일]찾기보기: 엔진의 OS 파일 선택기를 내지
        // 않고 호스트에 위임된 것엔진 (위치 host.rs 붙어). 파일 MyHub
        // 일괄을 앞고, 고정 파일을 myhub-sheet:open 로 다시
        // 다시 실패한다. 취소하면 앞의 메시지를 실패 않는다.
        postToParent({ type: 'myhub-sheet:request-open' });
      } else if (d.type === 'gridcraft:request-picture') {
        // 엔진 그림 넣기 대화상자의 [찾기보기]: 숨긴 같은 위임
        // (엔진위치 host.rs 붙어). 파일 MyHub 그림 일괄을 앞고, 고정
        // 그림는 myhub-sheet:picture로 파한다. 취소하면 앞의
        // 메시지를 실패 않는다.
        postToParent({ type: 'myhub-sheet:request-picture' });
      } else if (d.type === 'gridcraft:save-failed') {
        if (state.awaitingSave) {
          state.awaitingSave = false;
          postToParent({
            type: 'myhub-sheet:save-error',
            message: d.error || '처음에 실패했습니다',
          });
        }
      } else if (d.type === 'gridcraft:dirty') {
        doc.title = state.name ? state.name + (d.dirty ? ' ●' : '') : doc.title;
      } else if (d.type === 'gridcraft:snapshot-result') {
        if (!state.pendingSnapshots[d.tag]) return;
        delete state.pendingSnapshots[d.tag];
        if (d.error) {
          postToParent({ type: 'myhub-sheet:snapshot-error', message: d.error });
        } else {
          postToParent({ type: 'myhub-sheet:snapshot', snapshot: annotateSnapshotCaps(d.snapshot) });
        }
      } else if (d.type === 'gridcraft:exec-result') {
        var quick = state.pendingQuick[d.tag];
        if (quick) {
          delete state.pendingQuick[d.tag];
          var qr = (d.results || [])[0];
          if (quick.action === 'print') {
            if (qr && qr.ok && qr.result && typeof qr.result.base64 === 'string') {
              postToParent({ type: 'myhub-sheet:print-pdf', base64: qr.result.base64 });
            } else {
              postToParent({
                type: 'myhub-sheet:quick-result',
                action: 'print',
                ok: false,
                error: (qr && qr.error) || '인쇄 데이터를 만들지 못했습니다',
              });
            }
          } else if (quick.action === 'search' && (!qr || !qr.ok)) {
            postToParent({
              type: 'myhub-sheet:quick-result',
              action: 'search',
              ok: false,
              error: (qr && qr.error) || '찾을 수 없습니다',
            });
          }
          return;
        }
        var paste = state.pendingPastes[d.tag];
        if (paste) {
          delete state.pendingPastes[d.tag];
          if (paste.timer) clearTimeoutFn(paste.timer);
          var pr = (d.results || [])[0];
          if (pr && pr.ok) notifyPasteResult(true);
          else notifyPasteResult(false, (pr && pr.error) || '이미지 넣기가 실패했습니다');
          return;
        }
        var pending = state.pendingOps[d.tag];
        if (!pending) return;
        delete state.pendingOps[d.tag];
        var agg = aggregateExecResults(pending.ops, pending.flat, d.results || []);
        postToParent({
          type: 'myhub-sheet:ops-result',
          applied: agg.applied,
          errors: agg.errors,
        });
      } else if (d.type === 'gridcraft:failed') {
        showError('시트 편집기를 시작하지 못했습니다. ' + (d.error || ''));
      }
    }

    win.addEventListener('message', onParentMessage);
    win.addEventListener('message', onGcMessage);
    var onWinResize = function () {
      scheduleCanvasCheck(500);
    };
    win.addEventListener('resize', onWinResize);
    // 차이 다시 보이거나 삽입을 받으면 등 번 등 깊이 기회를 중 등
    // 그채널로 부족하거나 다른 화면 안에 그림이 바로 경우의 정한 이다.
    var onVisible = function () {
      if (!doc.hidden) scheduleCanvasCheck(700);
    };
    doc.addEventListener('visibilitychange', onVisible);
    win.addEventListener('focus', onVisible);
    state.loadTimer = setTimeoutFn(function () {
      if (!state.gcReady) {
        showError('시트 편집기를 불러오지 못했습니다. 네트워크를 확인하거나 기존 편집기로 열어 주세요.');
      }
    }, LOAD_TIMEOUT_MS);

    postToParent({ type: 'myhub-sheet:ready' });

    return {
      state: state,
      frame: frame,
      destroy: function () {
        win.removeEventListener('message', onParentMessage);
        win.removeEventListener('message', onGcMessage);
        win.removeEventListener('resize', onWinResize);
        win.removeEventListener('focus', onVisible);
        win.removeEventListener('paste', onPasteEvent, true);
        frame.removeEventListener('load', tryAttachPaste);
        if (state.pasteDoc) {
          state.pasteDoc.removeEventListener('paste', onPasteEvent, true);
          state.pasteDoc = null;
        }
        doc.removeEventListener('visibilitychange', onVisible);
        if (state.loadTimer) clearTimeoutFn(state.loadTimer);
        if (state.watchdogTimer) clearTimeoutFn(state.watchdogTimer);
        if (state.watchdogTimer2) clearTimeoutFn(state.watchdogTimer2);
        state.pasteTimers.forEach(function (t) {
          clearTimeout(t);
        });
        state.pasteTimers = [];
      },
    };
  }

  var api = {
    GC_URL: GC_URL,
    opsToCommands: opsToCommands,
    aggregateExecResults: aggregateExecResults,
    createBridge: createBridge,
    annotateSnapshotCaps: annotateSnapshotCaps,
    SNAPSHOT_ROW_CAP: SNAPSHOT_ROW_CAP,
    SNAPSHOT_COL_CAP: SNAPSHOT_COL_CAP,
    LOAD_TIMEOUT_MS: LOAD_TIMEOUT_MS,
    isCanvasStuck: isCanvasStuck,
    isBackingStuck: isBackingStuck,
    seedLanguage: seedLanguage,
    pasteImageFile: pasteImageFile,
    isFormFieldTarget: isFormFieldTarget,
    _colLetters: colLetters,
    _parseCellRef: parseCellRef,
  };
  if (typeof window !== 'undefined') window.MyHubSheetGridcraft = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 편집기를 불러오지 못했습니다 (잠시후 createBridge다시 시도해 주세요)
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var mountEl = document.getElementById('sheetApp');
    if (mountEl) {
      createBridge({
        document: document,
        window: window,
        root: mountEl,
        postToParent: function (msg) {
          window.parent.postMessage(msg, ORIGIN);
        },
        fonts: window.MyHubFonts || null,
        fetchFn: function (url) {
          return window.fetch(url);
        },
      });
    }
  }
})();
