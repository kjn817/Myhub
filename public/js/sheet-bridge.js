(function () {
  'use strict';
  var frame = document.getElementById('sheetEngine');
  var banner = document.getElementById('sheetBanner');
  var veil = document.getElementById('sheetVeil');
  var fail = document.getElementById('sheetFail');
  var params = new URLSearchParams(location.search);
  var fileId = params.get('file');
  var ready = false;

  var adapter = window.MyHubSheetGridcraft.attach({ engineFrame: frame });

  function engineSrc() {
    // host=parent가 없으면 GridCraft 브리지가 켜지지 않아 ready·열기·저장
    // 프로토콜이 전부 동작하지 않는다 (엔진 host.rs의 활성화 조건).
    // 주의: 배포 시 versioner가 이 파일 본문의 에셋 리터럴에 ?v=<태그>를
    // 붙이므로, base에 이미 쿼리가 있을 수 있다. 문자열 결합으로 '?'를
    // 또 붙이면 host 파라미터가 v 값에 삼켜져 브리지가 죽는다 (운영 실측
    // 사고) — 반드시 URL로 파싱해 파라미터를 병합한다.
    var url = new URL('/vendor/gridcraft/index.html', location.origin);
    url.searchParams.set('host', 'parent');
    if (fileId) url.searchParams.set('file', fileId);
    else url.searchParams.set('new', '1');
    return url.pathname + url.search;
  }

  function deliverFile() {
    if (!fileId || !window.MyHubOfficeFetch) return;
    window.MyHubOfficeFetch.loadFile(fileId).then(function (out) {
      return out.blob.arrayBuffer().then(function (buf) { return { buf: buf, name: out.name || '문서.xlsx' }; });
    }).then(function (f) {
      if (frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'gridcraft:open', name: f.name, bytes: f.buf }, location.origin, [f.buf]);
      }
    }).catch(function (e) { console.warn('파일 전달 실패:', e); });
  }

  function checkLosses() {
    if (!fileId || !window.MyHubOfficeFetch) return;
    window.MyHubOfficeFetch.loadFile(fileId).then(function (out) {
      return out.blob.arrayBuffer();
    }).then(function (buf) {
      return window.MyHubSheetGridcraft.inspectXlsxLosses(buf);
    }).then(function (loss) {
      var notes = [];
      if (loss.macro) notes.push('매크로가 있는 문서라 보기 전용으로 열려요.');
      if (loss.charts) notes.push('차트 ' + loss.charts + '개는 편집 엔진에서 보존되지 않을 수 있어요.');
      if (loss.media) notes.push('이미지 ' + loss.media + '개가 포함돼 있어요.');
      if (notes.length) {
        banner.textContent = notes.join(' ');
        banner.style.display = '';
      }
      if (loss.readOnly) {
        veil.textContent = '보기 전용';
        veil.style.display = '';
      }
    }).catch(function (e) { /* 손실 검사는 고지용 — 실패해도 열기는 계속 */ console.warn('손실 검사 실패 — 열기는 계속한다:', e); });
  }

  function postToParent(msg) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, location.origin);
    }
  }

  function bufToBase64(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  function mimeForFileName(name) {
    var n = String(name || '').toLowerCase();
    if (n.slice(-4) === '.pdf') return 'application/pdf';
    if (n.slice(-4) === '.csv') return 'text/csv';
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  /* 엔진은 fonts-request를 보내지 않으므로(content 타입에 없음) ready 시점에
   * 호스트가 먼저 폰트를 민다. 페이스 바이트가 있어야 엔진이 등록하므로
   * fonts.js의 {name, url} 목록을 실제 바이트로 채워 gridcraft:fonts로 보낸다. */
  var fontsPushed = false;
  function pushFonts() {
    if (fontsPushed) return;
    fontsPushed = true;
    if (!window.MyHubFonts || !window.MyHubFonts.ready) return;
    window.MyHubFonts.ready.then(function () {
      var list = window.MyHubFonts.list() || [];
      return Promise.all(list.map(function (f) {
        return fetch(f.url).then(function (r) { return r.arrayBuffer(); }).then(function (bytes) {
          return { family: f.name, name: f.name, bytes: bytes };
        }).catch(function () { return null; });
      }));
    }).then(function (entries) {
      var fonts = entries.filter(Boolean);
      if (fonts.length) adapter.postFonts(fonts);
    }).catch(function (e) { console.warn('[sheet] 폰트 전달 실패 — 폰트 없이도 엔진은 동작한다', e); });
  }

  /* 엔진(GridCraft iframe) → 호스트 창(office.html) 번역.
   * 엔진 규약 정본: apps/gridcraft-web/src/host.rs (outbound 캡처 표) */
  window.addEventListener('message', function (ev) {
    if (ev.origin !== location.origin) return;
    if (ev.source !== frame.contentWindow) return;
    var d = ev.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'gridcraft:ready') {
      ready = true;
      fail.style.display = 'none';
      postToParent({ type: 'myhub:engine-ready', app: 'excel' });
      pushFonts();
      deliverFile();
    } else if (d.type === 'gridcraft:save') {
      /* 저장 요청 응답이든 엔진 자체 Save든 .xlsx 바이트는 호스트 규약
       * (myhub:office-export)으로 올려 보낸다. office.js는 저장 요청 대기
       * 중일 때만 소비한다. */
      if (d.bytes) {
        postToParent({
          type: 'myhub:office-export',
          data: bufToBase64(d.bytes),
          mime: mimeForFileName(d.name),
          name: d.name || undefined,
        });
      }
    } else if (d.type === 'gridcraft:save-failed') {
      postToParent({ type: 'myhub:office-export', error: String(d.error || '엔진 저장 실패') });
    } else if (d.type === 'gridcraft:dirty') {
      postToParent({ type: 'myhub:office-dirty', dirty: !!d.dirty });
    } else if (d.type === 'gridcraft:request-open') {
      postToParent({ type: 'myhub:engine-request-open' });
    } else if (d.type === 'gridcraft:failed') {
      fail.style.display = 'block';
    }
  });

  /* 호스트 창(office.html) → 엔진 번역 */
  window.addEventListener('message', function (ev) {
    if (ev.origin !== location.origin) return;
    if (!window.parent || window.parent === window || ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'myhub:office-save-request') {
      if (frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'gridcraft:request-save' }, location.origin);
      }
    } else if (d.type === 'myhub:office-op') {
      adapter.sendAction(d.action || {});
    } else if (d.type === 'myhub:sheet-exec' && typeof d.reqId === 'number' && Array.isArray(d.commands)) {
      /* 패널 세션(스냅샷 조회·연산 적용 확인)이 결과를 기다리는 exec 채널.
       * 결과는 reqId를 그대로 실어 되돌린다. */
      adapter.exec(d.commands).then(function (results) {
        postToParent({ type: 'myhub:sheet-exec-result', reqId: d.reqId, results: results });
      }).catch(function (e) {
        postToParent({ type: 'myhub:sheet-exec-result', reqId: d.reqId, error: String((e && e.message) || e) });
      });
    }
    /* myhub:office-print·myhub:office-fold는 엔진 메시지 대응이 없다
     * (인쇄는 엔진 자체 UI, 접기는 호스트 크롬 동작) — 번역하지 않는다. */
  });

  frame.src = engineSrc();
  setTimeout(function () {
    if (!ready) {
      fail.style.display = 'block';
    }
  }, 8000);
  checkLosses();
  var link = document.getElementById('sheetFallbackLink');
  if (link && fileId) link.href = '/sheet-fortune.html?file=' + encodeURIComponent(fileId);
})();
