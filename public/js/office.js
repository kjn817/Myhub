/* MyHub 오피스 호스트 — 앱 라우팅·파일 메뉴·접기·제목 채널.
 *
 * 재구성 근거:
 * - 시작 화면은 hidden 기본값 (깜빡임 차단). app 지정 시 autoNew로 편집기 직행,
 *   PPT·PDF도 빈 문서 직행 (PDF는 templates/blank.pdf를 새 문서로 연다).
 * - 열기·저장은 각 앱의 [파일] 메뉴 안에서만. 파일명은 셸 창 제목줄에 게시하고
 *   수정 시 주황 점을 함께 알린다 ('myhub:doc-title' + dirty).
 * - 단일 표면 접기 모델: 상단 영역을 접으면 뷰어, 펼치면 에디터. 접기 셰브론은
 *   메뉴 줄의 가장 우측 끝에 혼자 둔다 (2026-11-03 06:52 정본).
 * - 탭(홈·삽입…)은 엔진 내장 탭이 정본 — 셸·호스트가 탭 행을 만들지 않는다.
 * - 인쇄 (D-23): 시스템 인쇄 즉시 실행, 다운로드 경로 없음. 한글은 클릭 시점에
 *   창을 먼저 확보해 팝업 차단을 피한다.
 * - 최근 파일 최대 8개 (로컬, office-memory).
 * - Finder 열기 핸드셰이크: 'myhub:open-file' 수신 → 적용 후 ack.
 */
(function () {
  'use strict';

  var APPS = {
    excel: { title: 'Excel', engine: '/sheet.html', newName: '제목 없음.xlsx' },
    hangul: { title: '한글', engine: '/rhwp-studio/index.html', newName: '제목 없음.hwpx' },
    powerpoint: { title: 'PowerPoint', engine: '/vendor/deckcraft/index.html', newName: '제목 없음.pptx' },
    pdf: { title: 'PDF', engine: '/vendor/pdfcraft/index.html', newName: '새 문서.pdf' },
  };

  var state = {
    app: null,
    file: null, // {id, name, version}
    dirty: false,
    folded: false,
    engineReady: false,
    pendingFile: null,
    engineLoadedFor: null, // 벤더 엔진 iframe에 이미 실린 앱 (재로드 방지)
  };

  /* 벤더 엔진(deckcraft·pdfcraft)을 직접 임베드하는 앱인지.
   * 이 엔진들은 ?file= 파라미터가 아니라 ready 이후 postMessage로 파일을
   * 받고(deckcraft:open/pdfcraft:open), 저장도 각자 프로토콜로 회신한다.
   * 규약 정본: engine-rebuild/crafts/{deckcraft,pdfcraft}의 host 브리지. */
  function isVendorApp() {
    return state.app === 'powerpoint' || state.app === 'pdf';
  }

  var vendorSaveRequested = false; // 저장 요청 대기 중이면 비요청 저장 핸들러가 양보
  var vendorOpSeq = 0;

  var els = {};
  var F = window.MyHubOfficeFetch;
  var M = window.MyHubOfficeMemory;

  function $(id) { return document.getElementById(id); }
  function bridge() { return window.MyHubBridge || null; }

  function publishTitle() {
    var b = bridge();
    if (!b) return;
    var name = state.file ? state.file.name : (APPS[state.app] ? APPS[state.app].newName : '오피스');
    b.post({ type: 'myhub:doc-title', title: name, dirty: state.dirty });
    if (els.docName) els.docName.textContent = name;
  }

  function engineUrl() {
    var cfg = APPS[state.app];
    var base = cfg.engine;
    var sep = base.indexOf('?') >= 0 ? '&' : '?';
    if (base.indexOf('/vendor/') === 0) {
      // 벤더 엔진(PPT·PDF)은 ?host=parent로만 부팅한다. 파일은 ready 이후
      // postMessage로 전달한다 — ?file=<id>를 붙이면 deckcraft는 무시하고
      // pdfcraft는 그 문자열을 URL로 fetch하려다 실패하므로 붙이지 않는다.
      // Excel은 sheet.html 래퍼가 자체적으로 host=parent를 붙인다.
      return base + sep + 'host=parent';
    }
    if (state.file && state.file.id) return base + sep + 'file=' + encodeURIComponent(state.file.id);
    return base + sep + 'new=1';
  }

  function loadEngine() {
    if (isVendorApp() && state.engineLoadedFor === state.app) {
      // 같은 벤더 엔진이 이미 떠 있으면 재로드하지 않고 파일만 다시 전달한다.
      if (state.engineReady) deliverVendorFile();
      return;
    }
    if (state.app === 'hangul' && hwp.editor) {
      // 이미 연결된 스튜디오에는 파일만 다시 전달한다 (벤더 앱과 같은 정책).
      hwpDeliverFile();
      return;
    }
    if (state.app !== 'hangul') hwpTeardown();
    state.engineLoadedFor = state.app;
    state.engineReady = false;
    vendorFontsPushed = false;
    els.engine.src = engineUrl();
    if (state.app === 'hangul') hwpConnect();
    clearTimeout(loadEngine._timer);
    loadEngine._timer = setTimeout(function () {
      if (!state.engineReady && els.engineFail) els.engineFail.style.display = '';
    }, 8000);
  }

  /* ---------- 한글(rhwp-studio) 호스트 브리지 ----------
   * 스튜디오는 postMessage로 ready를 보내지 않는다. 임베드 프로토콜
   * (vendor/rhwp-editor의 EditorTransport — rhwp-connect 핸드셰이크 →
   * rhwp-connected, 이후 RPC)이 유일한 준비·열기·저장 경로다. 재구축
   * 초기본에는 이 연결 자체가 없어 준비 신호가 영원히 오지 않았고,
   * 저장은 스튜디오가 듣지 않는 myhub:office-save-request로 빠져 있었다. */
  var hwp = { transport: null, editor: null, connecting: false, offChanged: null };

  function hwpTeardown() {
    if (hwp.offChanged) { try { hwp.offChanged(); } catch (e) { console.warn('[office] offChanged 해제 실패 (이미 해제됨)', e); } hwp.offChanged = null; }
    if (hwp.transport) { try { hwp.transport.destroy(); } catch (e) { console.warn('[office] transport 파괴 실패 (이미 파괴됨)', e); } }
    hwp.transport = null;
    hwp.editor = null;
    hwp.connecting = false;
  }

  function hwpMarkReady() {
    state.engineReady = true;
    flushReadyWaiters();
    if (els.engineFail) els.engineFail.style.display = 'none';
    if (state.pendingFile) {
      var f = state.pendingFile;
      state.pendingFile = null;
      setFile(f);
    }
  }

  function hwpDeliverFile() {
    if (!hwp.editor || !state.file || !state.file.id || !F) return;
    var targetId = state.file.id;
    var targetName = state.file.name;
    F.loadFile(targetId).then(function (out) {
      return out.blob.arrayBuffer();
    }).then(function (buf) {
      if (!hwp.editor || !state.file || state.file.id !== targetId) return null;
      return hwp.editor.loadFile(buf, targetName, { skipUnsavedGuard: true }).then(function () {
        state.dirty = false;
        publishTitle();
      });
    }).catch(function (e) { console.warn('한글 파일 전달 실패:', e); });
  }

  function hwpConnect() {
    if (hwp.connecting || hwp.editor) return;
    hwp.connecting = true;
    var frame = els.engine;
    var studioUrl = frame.src;
    function attempt(n) {
      return Promise.all([
        import('/vendor/rhwp-editor/transport.js'),
        import('/vendor/rhwp-editor/index.js'),
      ]).then(function (mods) {
        var transport = new mods[0].EditorTransport(frame, studioUrl, { handshakeTimeoutMs: 4000 });
        hwp.transport = transport;
        return transport.connect().then(function () {
          var editor = new mods[1].RhwpEditor(frame, transport);
          return editor._waitReady().then(function () { return editor; });
        });
      }).catch(function (e) {
        if (hwp.transport) { try { hwp.transport.destroy(); } catch (err) { console.warn('[office] 재시도 전 transport 정리 실패', err); } hwp.transport = null; }
        if (n >= 4) throw e;
        return new Promise(function (r) { setTimeout(r, 700); }).then(function () { return attempt(n + 1); });
      });
    }
    function start() {
      attempt(0).then(function (editor) {
        hwp.editor = editor;
        hwp.connecting = false;
        try {
          hwp.offChanged = editor.onDocumentChanged(function () {
            if (!state.dirty) { state.dirty = true; publishTitle(); }
          });
        } catch (e) { console.warn('[office] 변경 이벤트 구독 실패 — dirty는 저장 흐름으로만 관리', e); }
        hwpMarkReady();
        hwpDeliverFile();
      }).catch(function (e) {
        hwp.connecting = false;
        console.warn('한글 엔진 연결 실패:', e);
      });
    }
    // createEditor와 같은 순서: iframe load 뒤에 핸드셰이크한다.
    // 스튜디오 리스너가 서기 전에 보낸 connect 메시지는 유실된다.
    if (frame.contentDocument && frame.contentDocument.readyState === 'complete') start();
    else frame.addEventListener('load', start, { once: true });
  }

  var PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  var PDF_MIME = 'application/pdf';

  function bufToBase64(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  /* 벤더 엔진에 현재 파일을 연다 (ready 이후에만 의미가 있다).
   * 기존 파일: 보관함 바이트를 deckcraft:open/pdfcraft:open으로 전달.
   * 새 PDF: 빈 템플릿 바이트를 열어 편집 시작점으로 삼는다.
   * 새 PPT: host 모드의 빈 프레젠테이션이 시작점이라 보낼 것이 없다. */
  function deliverVendorFile() {
    if (!isVendorApp()) return;
    var frame = els.engine;
    if (!frame || !frame.contentWindow) return;
    var openType = state.app === 'powerpoint' ? 'deckcraft:open' : 'pdfcraft:open';
    if (state.file && state.file.id) {
      if (!F) return;
      var targetId = state.file.id;
      var targetName = state.file.name;
      F.loadFile(targetId).then(function (out) {
        return out.blob.arrayBuffer();
      }).then(function (buf) {
        if (frame.contentWindow && state.file && state.file.id === targetId) {
          frame.contentWindow.postMessage({ type: openType, name: targetName, bytes: buf }, window.location.origin, [buf]);
        }
      }).catch(function (e) { console.warn('파일 전달 실패:', e); });
    } else if (state.app === 'pdf') {
      fetch('/templates/blank.pdf').then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage({ type: openType, name: APPS.pdf.newName, bytes: buf }, window.location.origin, [buf]);
        }
      }).catch(function (e) { console.warn('빈 PDF 전달 실패:', e); });
    }
  }

  /* DeckCraft 웹 빌드는 CJK 폰트를 내장하지 않는다 — 한국어 글리프는
   * 호스트가 Drive '폰트' 폴더의 폰트 바이트를 deckcraft:fonts로 밀 때만
   * 그려진다 (엔진 fonts 크레이트·host.rs 규약). 재구축 초기본에는 이
   * 푸시가 없어 문서 한글이 전부 .notdef(네모)로 깨졌다. PdfCraft는
   * fonts 규약이 없어 대상이 아니다. */
  var vendorFontsPushed = false;
  function pushVendorFonts() {
    if (vendorFontsPushed || state.app !== 'powerpoint') return;
    vendorFontsPushed = true;
    if (!window.MyHubFonts || !window.MyHubFonts.ready) return;
    window.MyHubFonts.ready.then(function () {
      var list = window.MyHubFonts.list() || [];
      return Promise.all(list.map(function (f) {
        return fetch(f.url).then(function (r) { return r.arrayBuffer(); }).then(function (bytes) {
          return { family: f.name, weight: f.weight, style: f.style, bytes: bytes };
        }).catch(function () { return null; });
      }));
    }).then(function (entries) {
      var fonts = entries.filter(Boolean);
      var frame = els.engine;
      if (fonts.length && frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'deckcraft:fonts', fonts: fonts }, window.location.origin);
      }
    }).catch(function (e) { console.warn('[office] 폰트 전달 실패 — 폰트 없이도 엔진은 동작한다', e); });
  }

  /* 폰트 적용 뒤에는 이미 그려진 플레이스홀더가 남을 수 있어, 프레임을
   * 300ms 캡했다 풀어 재레이아웃을 유도한다 (Finder 표면 실측 해법). */
  function nudgeEngineRelayout() {
    var frame = els.engine;
    if (!frame) return;
    frame.style.maxWidth = 'calc(100% - 1px)';
    frame.style.maxHeight = 'calc(100% - 1px)';
    setTimeout(function () {
      frame.style.maxWidth = '';
      frame.style.maxHeight = '';
    }, 300);
  }

  function setFile(file, opts) {
    opts = opts || {};
    state.file = file;
    state.dirty = false;
    if (file && file.id && M) {
      M.pushRecent(localStorage, { id: file.id, name: file.name, app: state.app });
    }
    publishTitle();
    if (!opts.skipEngine) loadEngine();
  }

  function newDocument() {
    setFile({ id: null, name: APPS[state.app].newName, version: null });
  }

  function openFromPicker() {
    if (!window.MyHubOfficePicker) return;
    window.MyHubOfficePicker.openPicker({ title: '보관함에서 열기' }).then(function (file) {
      if (file) setFile({ id: file.id, name: file.name, version: file.version || null });
    });
  }

  function base64ToBlob(b64, type) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
  }

  function requestEngineExport() {
    if (state.app === 'powerpoint') return requestVendorExport('deckcraft');
    if (state.app === 'pdf') return requestVendorExport('pdfcraft');
    if (state.app === 'hangul') {
      // 스튜디오는 RPC로만 내보낸다 (exportHwp/exportHwpx).
      if (!hwp.editor) return Promise.reject(new Error('엔진 준비 안 됨'));
      var isHwp = !!state.file && /\.hwp$/i.test(state.file.name || '');
      var exporting = isHwp ? hwp.editor.exportHwp() : hwp.editor.exportHwpx();
      return exporting.then(function (bytes) {
        return {
          data: bufToBase64(bytes),
          mime: isHwp ? 'application/octet-stream' : 'application/vnd.hancom.hwpx',
        };
      });
    }
    return new Promise(function (resolve, reject) {
      var frame = els.engine;
      if (!frame || !frame.contentWindow) { reject(new Error('엔진 없음')); return; }
      var timer = setTimeout(function () {
        window.removeEventListener('message', onMsg);
        reject(new Error('엔진 응답 없음'));
      }, 15000);
      function onMsg(ev) {
        if (ev.origin !== window.location.origin) return;
        if (ev.source !== frame.contentWindow) return;
        var d = ev.data;
        if (d && d.type === 'myhub:office-export') {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          if (d.error) reject(new Error(d.error));
          else resolve(d);
        }
      }
      window.addEventListener('message', onMsg);
      frame.contentWindow.postMessage({ type: 'myhub:office-save-request' }, window.location.origin);
    });
  }

  /* 벤더 엔진 저장 왕복.
   * - deckcraft: deckcraft:request-save → deckcraft:save {name, bytes: ArrayBuffer}
   *   | deckcraft:save-failed {error}
   * - pdfcraft: request-save 수신 규약이 없다. 대신 메뉴 명령
   *   pdfcraft:menu-command {command: 'file.save'}를 보내면 앱의 저장
   *   명령이 실행돼 pdfcraft:save {name, bytes}가 돌아온다. */
  function requestVendorExport(kind) {
    return new Promise(function (resolve, reject) {
      var frame = els.engine;
      if (!frame || !frame.contentWindow) { reject(new Error('엔진 없음')); return; }
      var saveType = kind + ':save';
      var failType = kind + ':save-failed';
      vendorSaveRequested = true;
      var timer = setTimeout(function () { cleanup(); reject(new Error('엔진 응답 없음')); }, 15000);
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        vendorSaveRequested = false;
      }
      function onMsg(ev) {
        if (ev.origin !== window.location.origin) return;
        if (ev.source !== frame.contentWindow) return;
        var d = ev.data;
        if (!d) return;
        if (d.type === saveType && d.bytes) {
          cleanup();
          resolve({
            data: bufToBase64(d.bytes),
            mime: kind === 'pdfcraft' ? PDF_MIME : PPTX_MIME,
            name: d.name,
          });
        } else if (d.type === failType) {
          cleanup();
          reject(new Error(d.error || '엔진 저장 실패'));
        }
      }
      window.addEventListener('message', onMsg);
      if (kind === 'deckcraft') {
        frame.contentWindow.postMessage({ type: 'deckcraft:request-save' }, window.location.origin);
      } else {
        frame.contentWindow.postMessage({ type: 'pdfcraft:menu-command', command: 'file.save' }, window.location.origin);
      }
    });
  }

  /* 엔진 안에서 사용자가 직접 저장했을 때 오는 비요청 저장분도 보관함에
   * 반영한다. 단, 엔진의 내보내기(PDF·이미지 등)는 문서 파일과 확장자가
   * 달라 이 경로로 덮지 않는다 — host 모드에서 내보내기는 별도 소비자가 없다. */
  function persistUnsolicitedSave(d) {
    if (!F || !d.bytes) return;
    var isPpt = state.app === 'powerpoint';
    var name = String(d.name || '');
    var extOk = isPpt ? /\.(pptx|deckcraft)$/i.test(name) : /\.pdf$/i.test(name);
    if (!extOk) return;
    var blob = new Blob([d.bytes], { type: isPpt ? PPTX_MIME : PDF_MIME });
    if (state.file && state.file.id) {
      F.saveFile(state.file.id, blob, state.file.version, state.file.name).then(function (out) {
        if (out && !out.conflict) {
          state.file.version = out.version;
          state.dirty = false;
          publishTitle();
        }
      }).catch(function (e) { console.warn('엔진 자체 저장 반영 실패:', e); });
    } else {
      F.createFile(state.file ? state.file.name : name, blob).then(function (created) {
        setFile({ id: created.id, name: created.name || name, version: created.version || null }, { skipEngine: true });
        state.dirty = false;
        publishTitle();
      }).catch(function (e) { console.warn('엔진 자체 저장 반영 실패:', e); });
    }
  }

  /* 한글: 보관함 저장이 확정된 뒤 스튜디오에 통지해 dirty·자동복구
   * 드래프트를 정리한다 (notify-saved-v1). 실패해도 저장은 이미 끝났다. */
  function afterSaveNotify(name) {
    if (state.app === 'hangul' && hwp.editor) {
      hwp.editor.notifySaved(name).catch(function (e) { console.debug('스튜디오 저장 통지 실패:', e); });
    }
  }

  function save(saveAs) {
    return requestEngineExport().then(function (exp) {
      var blob = base64ToBlob(exp.data, exp.mime);
      var name = state.file ? state.file.name : APPS[state.app].newName;
      if (saveAs) {
        var asked = window.prompt('다른 이름으로 저장', name);
        if (!asked) return { skipped: true };
        name = asked;
      }
      if (state.file && state.file.id && !saveAs) {
        return F.saveFile(state.file.id, blob, state.file.version, name).then(function (out) {
          if (out.conflict) {
            window.alert('다른 곳에서 먼저 바뀐 파일이에요. 새로고침 후 다시 시도해 주세요. (409)');
            return out;
          }
          state.file.version = out.version;
          state.dirty = false;
          publishTitle();
          afterSaveNotify(name);
          return out;
        });
      }
      return F.createFile(name, blob).then(function (created) {
        setFile({ id: created.id, name: created.name || name, version: created.version || null }, { skipEngine: true });
        state.dirty = false;
        publishTitle();
        afterSaveNotify(name);
        return { ok: true };
      });
    }).catch(function (e) {
      console.debug('저장 실패:', e);
      window.alert('저장에 실패했어요.');
      return { ok: false };
    });
  }

  function printDoc() {
    if (state.app === 'hangul') {
      // 클릭 시점에 창을 먼저 확보한다 (팝업 차단 회피)
      var w = window.open('about:blank', '_blank');
      var url = '/rhwp-studio/print.html' + (state.file && state.file.id ? '?file=' + encodeURIComponent(state.file.id) : '?new=1');
      if (w) w.location.href = url;
      else window.alert('팝업이 차단됐어요. 팝업을 허용한 뒤 다시 시도해 주세요.');
      return;
    }
    var frame = els.engine;
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: 'myhub:office-print' }, window.location.origin);
      try { frame.contentWindow.focus(); } catch (e) { console.debug('인쇄 포커스 실패:', e); }
    }
  }

  function toggleFold() {
    state.folded = !state.folded;
    document.body.classList.toggle('office-folded', state.folded);
    if (els.foldBtn) {
      els.foldBtn.innerHTML = '<i data-lucide="' + (state.folded ? 'chevron-down' : 'chevron-up') + '"></i>';
      if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('셰브론 갱신 실패:', e); } }
    }
    var frame = els.engine;
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: 'myhub:office-fold', folded: state.folded }, window.location.origin);
    }
    var b = bridge();
    if (b) {
      b.declareContext();
      b.post({ type: 'myhub:win-chevron', label: state.folded ? '도구 펼치기' : '도구 접기' });
    }
  }

  /* 창 제목줄 도구 게시: 셰브론(접기) + 좌측 저장·인쇄·실행취소·다시실행 + 우측 문서 내 검색 */
  function publishWinTools() {
    var b = bridge();
    if (!b) return;
    b.post({ type: 'myhub:win-chevron', label: state.folded ? '도구 펼치기' : '도구 접기' });
    b.post({
      type: 'myhub:win-tools-left',
      tools: [
        { id: 'save', icon: 'save', title: '저장' },
        { id: 'print', icon: 'printer', title: '인쇄' },
        { id: 'undo', icon: 'undo-2', title: '실행 취소' },
        { id: 'redo', icon: 'redo-2', title: '다시 실행' },
      ],
    });
    b.post({
      type: 'myhub:win-tools',
      tools: [{ id: 'search', icon: 'search', label: '문서 내 검색', title: '문서 내 검색' }],
    });
  }

  function sendEngineOp(action) {
    if (isVendorApp()) { translateVendorAction(action); return; }
    var frame = els.engine;
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: 'myhub:office-op', action: action }, window.location.origin);
    }
  }

  function vendorExec(commands) {
    var frame = els.engine;
    if (frame && frame.contentWindow) {
      vendorOpSeq += 1;
      frame.contentWindow.postMessage(
        { type: 'deckcraft:exec', tag: 'myhub-op-' + vendorOpSeq, commands: commands },
        window.location.origin
      );
    }
  }

  function vendorMenuCommand(command, params) {
    var frame = els.engine;
    if (frame && frame.contentWindow) {
      var msg = { type: 'pdfcraft:menu-command', command: command };
      if (params) msg.params = params;
      frame.contentWindow.postMessage(msg, window.location.origin);
    }
  }

  /* 비서 패널·호스트 도구 연산을 벤더 엔진 규약으로 번역한다.
   * - PowerPoint: SlideOp({id, params})는 deckcraft 명령 id와 동형이라
   *   deckcraft:exec로 그대로 보낸다. 단 'slide' 파라미터는 엔진 명령에
   *   없어(현재 슬라이드 기준) 떼어 낸다. undo/redo는 exec의 edit.*로,
   *   find는 exec 대응 명령이 없어 보내지 않는다.
   * - PDF: undo/redo/find와 페이지 연산은 pdfcraft:menu-command로 보낸다.
   *   페이지 연산은 메뉴 명령이 현재 페이지/선택 기준이라 page 파라미터는
   *   참고로만 실어 보낸다. overlay_text는 대응 메뉴 명령이 없어 제외. */
  function translateVendorAction(action) {
    if (!action || typeof action !== 'object') return;
    var ops = Array.isArray(action.ops) ? action.ops : [action];
    if (state.app === 'powerpoint') {
      var commands = [];
      ops.forEach(function (op) {
        if (!op || typeof op !== 'object') return;
        if (op.op === 'undo') commands.push({ id: 'edit.undo', params: {} });
        else if (op.op === 'redo') commands.push({ id: 'edit.redo', params: {} });
        else if (op.op === 'find') { /* deckcraft exec에 find 명령 없음 */ }
        else if (typeof op.id === 'string') {
          var params = {};
          var src = op.params || {};
          Object.keys(src).forEach(function (k) { if (k !== 'slide') params[k] = src[k]; });
          commands.push({ id: op.id, params: params });
        }
      });
      if (commands.length) vendorExec(commands);
    } else if (state.app === 'pdf') {
      ops.forEach(function (op) {
        if (!op || typeof op !== 'object') return;
        if (op.op === 'undo') vendorMenuCommand('edit.undo');
        else if (op.op === 'redo') vendorMenuCommand('edit.redo');
        else if (op.op === 'find') vendorMenuCommand('edit.find');
        else if (op.type === 'rotate_page') vendorMenuCommand('page.rotate', { page: op.page });
        else if (op.type === 'delete_page') vendorMenuCommand('page.delete', { page: op.page });
        else if (op.type === 'extract_pages') vendorMenuCommand('page.extract', { from: op.from, to: op.to });
      });
    }
  }

  /* ---------- 파일·편집 메뉴 ---------- */

  var openMenuEl = null;
  var openMenuBackdrop = null;
  var openMenuAnchor = null;
  function closeMenus() {
    if (openMenuEl && openMenuEl.parentNode) openMenuEl.parentNode.removeChild(openMenuEl);
    if (openMenuBackdrop && openMenuBackdrop.parentNode) openMenuBackdrop.parentNode.removeChild(openMenuBackdrop);
    openMenuEl = null;
    openMenuBackdrop = null;
    openMenuAnchor = null;
    document.removeEventListener('pointerdown', onMenuDown, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onMenuDown(ev) {
    // 배경막이 있으면 닫힘은 배경막의 click이 담당한다 (pointerdown에서
    // 먼저 닫으면 click이 앵커로 재타기팅돼 메뉴가 다시 열리는 문제가 있다).
    if (!openMenuEl || openMenuBackdrop) return;
    if (!openMenuEl.contains(ev.target)) closeMenus();
  }
  function onMenuKey(ev) { if (ev.key === 'Escape') closeMenus(); }

  function showMenu(anchor, items) {
    closeMenus();
    var menu = document.createElement('div');
    menu.className = 'myhub-menu';
    items.forEach(function (item) {
      if (item.separator) {
        var sep = document.createElement('div');
        sep.className = 'myhub-menu-sep';
        menu.appendChild(sep);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'myhub-menu-item';
      b.textContent = item.label;
      b.disabled = !!item.disabled;
      b.addEventListener('click', function () { closeMenus(); if (item.onSelect) item.onSelect(); });
      menu.appendChild(b);
    });
    // 배경막: 엔진 iframe 위를 포함한 전면을 덮어, iframe 영역 클릭도
    // 부모 문서가 받아 닫을 수 있게 한다 (iframe은 부모로 이벤트를
    // 전파하지 않아 pointerdown 감지만으로는 그 영역이 누락된다).
    var backdrop = document.createElement('div');
    backdrop.className = 'myhub-menu-backdrop';
    backdrop.addEventListener('click', function () { closeMenus(); });
    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
    var r = anchor.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    openMenuEl = menu;
    openMenuBackdrop = backdrop;
    openMenuAnchor = anchor;
    document.addEventListener('pointerdown', onMenuDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  function fileMenuItems() {
    var items = [
      { label: '새로 만들기', onSelect: newDocument },
      { label: '보관함에서 열기', onSelect: openFromPicker },
      { separator: true },
      { label: '저장', onSelect: function () { save(false); } },
      { label: '다른 이름으로 저장', onSelect: function () { save(true); } },
      { separator: true },
      { label: '인쇄', onSelect: printDoc },
    ];
    var recents = M ? M.loadRecents(localStorage) : [];
    if (recents.length) {
      items.push({ separator: true });
      recents.forEach(function (r) {
        items.push({
          label: '최근: ' + r.name,
          onSelect: function () {
            if (r.app && r.app !== state.app) {
              window.location.href = '/office.html?app=' + r.app + '&file=' + encodeURIComponent(r.id);
            } else {
              setFile({ id: r.id, name: r.name, version: null });
            }
          },
        });
      });
    }
    return items;
  }

  function editMenuItems() {
    function send(action) { sendEngineOp(action); }
    return [
      { label: '실행 취소', onSelect: function () { send({ op: 'undo' }); } },
      { label: '다시 실행', onSelect: function () { send({ op: 'redo' }); } },
      { separator: true },
      { label: '문서 내 검색', onSelect: function () { send({ op: 'find' }); } },
    ];
  }

  /* ---------- 엔진·셸 메시지 ---------- */

  window.addEventListener('message', function (ev) {
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || typeof d.type !== 'string') return;
    var fromEngine = els.engine && ev.source === els.engine.contentWindow;
    if (fromEngine && (d.type === 'myhub:engine-ready' || d.type === 'deckcraft:ready' || d.type === 'pdfcraft:ready')) {
      state.engineReady = true;
      flushReadyWaiters();
      if (els.engineFail) els.engineFail.style.display = 'none';
      if (d.type === 'deckcraft:ready') pushVendorFonts();
      if (state.app === 'pdf') {
        var b = bridge();
        if (b) b.post({ type: 'myhub:pdf-ready' });
      }
      if (state.pendingFile) {
        var f = state.pendingFile;
        state.pendingFile = null;
        setFile(f);
      } else if (isVendorApp()) {
        deliverVendorFile();
      }
    } else if (fromEngine && d.type === 'myhub:office-dirty') {
      state.dirty = !!d.dirty;
      publishTitle();
    } else if (fromEngine && d.type === 'deckcraft:fonts-applied') {
      if (d.faces > 0) nudgeEngineRelayout();
    } else if (fromEngine && (d.type === 'deckcraft:dirty' || d.type === 'pdfcraft:dirty')) {
      state.dirty = !!d.dirty;
      publishTitle();
    } else if (fromEngine && (d.type === 'deckcraft:save' || d.type === 'pdfcraft:save')) {
      // 저장 요청 대기 중이면 requestVendorExport가 소비한다. 그 외는
      // 엔진 안에서 직접 저장한 것이므로 보관함에 반영한다.
      if (!vendorSaveRequested) persistUnsolicitedSave(d);
    } else if (d.type === 'myhub:open-file' && d.file && ev.source === window.parent) {
      state.pendingFile = { id: d.file.id, name: d.file.name, version: null };
      if (state.engineReady || !state.app) {
        var pf = state.pendingFile;
        state.pendingFile = null;
        setFile(pf);
      }
      var bb = bridge();
      if (bb) bb.post({ type: 'myhub:open-file-ack' });
    } else if (d.type === 'myhub:win-chevron-click' && ev.source === window.parent) {
      toggleFold();
    } else if (d.type === 'myhub:win-tool' && ev.source === window.parent) {
      if (d.id === 'save') save(false);
      else if (d.id === 'print') printDoc();
      else if (d.id === 'undo') sendEngineOp({ op: 'undo' });
      else if (d.id === 'redo') sendEngineOp({ op: 'redo' });
      else if (d.id === 'search') sendEngineOp({ op: 'find' });
    } else if (d.type === 'myhub:pdf-save' && ev.source === window.parent) {
      // Finder 뷰어의 저장 위임: 엔진 내보내기를 받아 뷰어에 결과를 돌려준다
      requestEngineExport().then(function (exp) {
        var blob = base64ToBlob(exp.data, exp.mime);
        if (!state.file || !state.file.id) return { skipped: true };
        return F.saveFile(state.file.id, blob, state.file.version, state.file.name);
      }).then(function (out) {
        var b2 = bridge();
        if (b2) b2.post({ type: 'myhub:pdf-save-result', conflict: !!(out && out.conflict) });
      }).catch(function () {
        var b3 = bridge();
        if (b3) b3.post({ type: 'myhub:pdf-save-result', conflict: false });
      });
    }
  });

  /* ---------- 시작 ---------- */

  function showStart() {
    if (els.start) els.start.style.display = '';
    if (els.surface) els.surface.style.display = 'none';
    var grid = $('officeStartGrid');
    if (grid) {
      grid.innerHTML = '';
      Object.keys(APPS).forEach(function (key) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'office-start-card';
        b.textContent = APPS[key].title;
        b.addEventListener('click', function () {
          window.location.href = '/office.html?app=' + key;
        });
        grid.appendChild(b);
      });
    }
  }

  /* ---------- 비서 (노바 패널 + 앱 세션) ----------
   * 패널·instruct 흐름은 office-assistant.js가, 문서 스냅샷·연산 적용은
   * office-sessions.js가 맡는다. 여기서는 둘을 잇는 host를 제공한다. */
  var readyWaiters = [];
  function flushReadyWaiters() {
    var waiters = readyWaiters.splice(0, readyWaiters.length);
    waiters.forEach(function (resolve) { resolve(); });
  }
  function whenEngineReady() {
    if (state.engineReady) return Promise.resolve();
    return new Promise(function (resolve) { readyWaiters.push(resolve); });
  }

  function wireAssistant() {
    if (!window.MyHubOfficeAssistant || !window.MyHubOfficeSessions) return;
    var host = {
      app: state.app,
      getState: function () {
        return {
          app: state.app,
          fileName: state.file ? state.file.name : (APPS[state.app] ? APPS[state.app].newName : '문서'),
          fileId: state.file ? state.file.id : null,
          dirty: state.dirty,
        };
      },
      getFile: function () { return state.file; },
      isDirty: function () { return state.dirty; },
      engineFrame: function () { return els.engine; },
      officeFetch: function () { return F; },
      hwpEditor: function () { return hwp.editor; },
      setFileVersion: function (v) { if (state.file) state.file.version = v; },
      markDirty: function () { state.dirty = true; publishTitle(); },
      reloadFile: function () { loadEngine(); },
      openFile: function (id, name) {
        setFile({ id: id, name: name, version: null });
        state.dirty = false;
        loadEngine();
        publishTitle();
        return whenEngineReady();
      },
      newDocument: function () { newDocument(); return Promise.resolve(); },
      whenEngineReady: whenEngineReady,
      setDocName: function (name) {
        if (state.file) state.file.name = name;
        publishTitle();
      },
      kordoc: function () {
        return import('/vendor/kordoc/kordoc.bundle.js').then(function (mod) {
          return mod.default || mod;
        });
      },
    };
    var session = window.MyHubOfficeSessions.create(host);
    window.MyHubOfficeAssistant.attach({ host: host, session: session });
  }

  function init() {
    els = {
      engine: $('officeEngine'),
      engineFail: $('officeEngineFail'),
      start: $('officeStart'),
      surface: $('officeSurface'),
      docName: $('officeDocName'),
      foldBtn: $('officeFoldBtn'),
    };
    var params = new URLSearchParams(window.location.search);
    state.app = params.get('app');
    var fileId = params.get('file');

    var fileBtn = $('officeFileBtn');
    if (fileBtn) fileBtn.addEventListener('click', function () { showMenu(fileBtn, fileMenuItems()); });
    var editBtn = $('officeEditBtn');
    if (editBtn) editBtn.addEventListener('click', function () { showMenu(editBtn, editMenuItems()); });
    if (els.foldBtn) els.foldBtn.addEventListener('click', toggleFold);

    wireAssistant();

    /* 벤더 앱의 비서 패널 연산은 office-assistant가 그대로 흘리는
     * myhub:office-op를 엔진이 듣지 못한다. 브리지에 번역 핸들러를 따로
     * 걸어 deckcraft:exec / pdfcraft:menu-command로 직접 보낸다.
     * (Excel은 sheet.html이 myhub:office-op를 받아 번역하므로 제외.) */
    var bb0 = bridge();
    if (bb0 && (state.app === 'powerpoint' || state.app === 'pdf')) {
      bb0.onUiAction(function (action) { translateVendorAction(action); });
    }

    if (!state.app || !APPS[state.app]) {
      showStart();
      return;
    }
    publishWinTools();
    if (M) M.setLastApp(localStorage, state.app);
    if (els.start) els.start.style.display = 'none'; // 시작 화면은 hidden 기본값
    if (fileId) {
      if (F) {
        F.loadMeta(fileId).then(function (meta) {
          setFile({ id: fileId, name: meta.name || '문서', version: meta.version || null });
        }).catch(function () {
          setFile({ id: fileId, name: '문서', version: null });
        });
      } else {
        setFile({ id: fileId, name: '문서', version: null });
      }
    } else {
      newDocument(); // autoNew: 편집기 직행
    }
    publishTitle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

