// 오피스 붙여넣기·바이트 정규화 공용 코어 — public/js/craft-clipboard.js
//
// finder-deckcraft·finder-format-slide·finder-format-sheet·
// sheet-gridcraft·finder-pdfcraft 5곳이 공유하던 붙여넣기 헬퍼
// (isFormFieldTarget·pasteImageFile·fileToBase64·normalizeBytes와
// PASTE_MAX_BYTES 상한)를 한 곳으로 모은다 (F-L2, 5-3).
// 이 파일을 먼저 받은 페이지에서만 소비처가 동작한다 — office.html·
// sheet.html은 정적 순서로, finder.js는 동적 import 체인으로 코어
// 선행을 보장한다. 코어가 없으면 소비처는 붙여넣기를 조용히 건너뛴다
// (붙여넣기 실패는 편집기 동작을 막지 않는다 — 엔진 자체의 텍스트
// 붙여넣기는 그대로 된다).
//
// 보존하는 계약:
// - pasteImageFile은 2인자본이 상위집합: deck/slide는 1인자로 부르고
//   sheet/grid는 skipTableHtml=true로 부른다. skipTableHtml이 falsy면
//   표 HTML 검사를 하지 않아 1인자본과 동일하다.
// - fileToBase64(file, ReaderCtor): deck/grid는 호출처에서 구한
//   ReaderCtor를 넘기고, slide/sheet는 1인자로 부르면 window.FileReader로
//   폴백한다 (원래 slide/sheet 본문이 하던 그대로).
// - PASTE_MAX_BYTES는 32MB (host.rs MAX_PICTURE_BYTES와 같은 상한).
//   gridcraft는 base64 길이 검사에도 쓴다 (Math.ceil(/3)*4+4).
// - normalizeBytes: ArrayBuffer는 그대로, 뷰는 자기 구간만 복사,
//   그 외(널 포함)는 null.
(function () {
  'use strict';

  var PASTE_MAX_BYTES = 32 * 1024 * 1024;

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
      var Ctor = ReaderCtor;
      if (!Ctor && typeof window !== 'undefined' && window.FileReader) {
        Ctor = window.FileReader;
      }
      if (!Ctor && typeof FileReader !== 'undefined') {
        Ctor = FileReader;
      }
      var reader = new Ctor();
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

  // save/open 메시지는 bytes가 ArrayBuffer가 내도, 뷰(Uint8Array 등)가
  // 내도 있다 — 뷰면 자기 구간만 정확히 복사해 ArrayBuffer로 정규화한다.
  function normalizeBytes(bytes) {
    if (!bytes) return null;
    if (bytes instanceof ArrayBuffer) return bytes;
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(bytes)) {
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice().buffer;
    }
    return null;
  }

  var api = {
    PASTE_MAX_BYTES: PASTE_MAX_BYTES,
    isFormFieldTarget: isFormFieldTarget,
    pasteImageFile: pasteImageFile,
    fileToBase64: fileToBase64,
    normalizeBytes: normalizeBytes,
  };
  if (typeof window !== 'undefined') window.MyHubCraftClipboard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
