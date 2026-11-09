/* 파인더 뷰어 용 PDF 페이지 조작 순수 함수 (finder-pdf-ops.js)
 *
 * pdf-lib를 주입받아 바이트만 다룬다 (DOM· 없음 — node 테스트
 * 가능). 페이지 조작(회전·삭제·추출·병합)은 한 규칙을 전부 여기에
 * 둔다: 페이지 번호 서면은 1-based (뷰어·사용자 표기와 일치)이고
 * 0-based 변환은 이 파일 안에서만 일어난다.
 *
 * 노출: window.MyHubFinderPdfOps = { pageCount, rotatePage,
 *        deletePage, extractPages, mergePdfs, overlayImage } (+ module.exports)
 *
 * 본문 텍스트 넣기는 순환 경로(캔버스): pdf-lib의 표준 글꼴은 Latin만
 * 그릴 수 있어 한글은 직접 못 찍는다. 그래서 텍스트를 캔버스로 그려
 * PNG로 만든 뒤 overlayImage로 붙인다 (워터마크 검색·날짜는 이 서면에 둔다
 * 비서 답변에서 그 한계를 밝힌다). 좌표는 좌상단 원점·사인 단위.
 */
(function () {
  'use strict';

  function toBytes(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) {
      return new Uint8Array(bytes);
    }
    if (bytes && bytes.buffer) return new Uint8Array(bytes.buffer);
    throw new Error('PDF 바이트가 올바르지 않습니다');
  }

  function checkPage(count, page) {
    if (!Number.isInteger(page) || page < 1 || page > count) {
      throw new Error('페이지 범위를 벗어났습니다 (1~' + count + ')');
    }
  }

  function pageCount(lib, bytes) {
    return lib.PDFDocument.load(toBytes(bytes)).then(function (doc) {
      return doc.getPageCount();
    });
  }

  // 현재 회전값에 90도 더한다 (0→90→180→270→0)
  function rotatePage(lib, bytes, page) {
    return lib.PDFDocument.load(toBytes(bytes)).then(function (doc) {
      var count = doc.getPageCount();
      checkPage(count, page);
      var target = doc.getPage(page - 1);
      var next = (target.getRotation().angle + 90) % 360;
      target.setRotation(lib.degrees(next));
      return doc.save();
    });
  }

  function deletePage(lib, bytes, page) {
    return lib.PDFDocument.load(toBytes(bytes)).then(function (doc) {
      var count = doc.getPageCount();
      checkPage(count, page);
      if (count <= 1) throw new Error('마지막 페이지는 삭제할 수 없습니다');
      doc.removePage(page - 1);
      return doc.save();
    });
  }

  // from~to (1-based, 양끝 포함)만 뽑아 새 문서를 만든다
  function extractPages(lib, bytes, from, to) {
    return lib.PDFDocument.load(toBytes(bytes)).then(function (src) {
      var count = src.getPageCount();
      checkPage(count, from);
      checkPage(count, to);
      if (from > to) throw new Error('추출 범위가 올바르지 않습니다');
      return lib.PDFDocument.create().then(function (out) {
        var indices = [];
        for (var i = from - 1; i <= to - 1; i++) indices.push(i);
        return out.copyPages(src, indices).then(function (pages) {
          pages.forEach(function (p) {
            out.addPage(p);
          });
          return out.save();
        });
      });
    });
  }

  // other의 두 페이지를 base 뒤에 붙인다
  function mergePdfs(lib, baseBytes, otherBytes) {
    return lib.PDFDocument.load(toBytes(baseBytes)).then(function (base) {
      return lib.PDFDocument.load(toBytes(otherBytes)).then(function (other) {
        var indices = [];
        for (var i = 0; i < other.getPageCount(); i++) indices.push(i);
        return base.copyPages(other, indices).then(function (pages) {
          pages.forEach(function (p) {
            base.addPage(p);
          });
          return base.save();
        });
      });
    });
  }

  // PNG 이미지를 page(1-based) 위에 붙인다. x·y는 페이지 좌상단 원점·사인 단위.
  // pdf-lib 좌표(좌하단)로 변환하는 것은 여기서만 일어난다.
  function overlayImage(lib, bytes, page, pngBytes, opts) {
    return lib.PDFDocument.load(toBytes(bytes)).then(function (doc) {
      var count = doc.getPageCount();
      checkPage(count, page);
      var target = doc.getPage(page - 1);
      var size = target.getSize();
      var w = opts && opts.width;
      var h = opts && opts.height;
      if (!(w > 0) || !(h > 0)) throw new Error('캔버스 크기가 올바르지 않습니다');
      var x = opts && typeof opts.x === 'number' ? opts.x : 0;
      var yTop = opts && typeof opts.y === 'number' ? opts.y : 0;
      return doc.embedPng(toBytes(pngBytes)).then(function (img) {
        target.drawImage(img, { x: x, y: size.height - yTop - h, width: w, height: h });
        return doc.save();
      });
    });
  }

  var api = {
    pageCount: pageCount,
    rotatePage: rotatePage,
    deletePage: deletePage,
    extractPages: extractPages,
    mergePdfs: mergePdfs,
    overlayImage: overlayImage,
  };
  if (typeof window !== 'undefined') window.MyHubFinderPdfOps = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFinderPdfOps = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
