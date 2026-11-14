/* MyHub 공용 파일 아이콘 (file-icons.js)
 *
 * 파일 종류별 아이콘은 자체 제작 SVG에서 (2026-11-02) 스마트 아이콘
 * 세트로 교체한다. 자릿수 오프셋은 더 이상 유지하지 않는다.
 *
 * 출처 (버전 고정):
 * - 모든 종류의 아트워크는 **Material Icon Theme v5.40.0**
 *   (npm material-icon-theme@5.40.0, upstream:
 *   github.com/material-extensions/vscode-material-icon-theme)의
 *   icons/ 원본 SVG를 그대로 넣은 것이다. 종류 매핑은 아래 ARTWORK의
 *   주석 참조.
 * - hangul만 세트에 없어 파생했다: 같은 세트 word 아이콘의 문서
 *   오른쪽을 서명 블루(#1b6ac9)로 바꾼 것 (MIT가 허용하는 변환)이고,
 *   '한글' 글자는 실제 폰트 글자를 추출한 것이다. 글리프 출처:
 *   **Noto Sans KR Bold** (Google, SIL Open Font License 1.1)의
 *   U+314E(ㅎ)를 opentype.js로 추출해 박스에 맞게 변환한 path
 *   (한글 로고의 실제 모양과 다르게 쓰던 것을 2026-11-02 교체;
 *   폰트 렌더링과 픽셀 단위로 일치 검증).
 * - 표시 오버레이 (MyHub 추가 변환, 아트워크 원본은 무변형):
 *   svgFor가 세트 아트워크를 흰 문서 페이지(PAGE_PATHS) 위에 얹고
 *   광택(gloss)을 넣는다 (macOS 스타일, 2026-11-02 사용자 지정).
 * - text만 원본 document.svg의 전체 캔버스 배경을 투명하게 제거한다
 *   (밝은 UI에서 배경 상자가 따로 보이지 않게 하는 변환임을 명시).
 *
 * 라이선스: Material Icon Theme의 MIT License.
 * Copyright (c) 2025 Material Extensions
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * 조사에서 제외한 세트 (참고):
 * - Simple Icons (CC0): 현 버전에서 Microsoft 브랜드 아이콘이 빠져
 *   excel/word/powerpoint 글리프가 없다.
 * - vscode-icons: 코드는 MIT이나 아이콘 자체가 CC BY-SA 4.0이라
 *   ShareAlike 조건 때문에 채택하지 않았다.
 *
 * 공유 (기존과 동일):
 * - kindFor({name, mime}): MIME 우선, 없으면 확장자.
 * - svgFor(kind): 종류별 SVG 문자열 (48×48 캔버스에 세트 원본의 중첩
 *   SVG로 배치). 같은 종류의 캐시가 동일 문자열.
 * - htmlFor({name, mime}): svgFor(kindFor(...)) 호출.
 * 노출: window.MyHubFileIcons = { kindFor, svgFor, htmlFor, KINDS }
 */
(function () {
  'use strict';

  var KINDS = [
    'excel', 'hangul', 'powerpoint', 'word', 'pdf', 'image', 'csv',
    'text', 'audio', 'video', 'archive', 'code', 'folder', 'file',
  ];

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function kindFor(input) {
    input = input || {};
    if (input.kind && KINDS.indexOf(input.kind) >= 0) return input.kind;
    if (input.folder === true) return 'folder';
    var mime = String(input.mime || '').toLowerCase();
    var ext = extOf(input.name);
    if (mime.indexOf('image/') === 0) return 'image';
    if (mime.indexOf('audio/') === 0) return 'audio';
    if (mime.indexOf('video/') === 0) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'text/csv') return 'csv';
    if (mime.indexOf('hwp') >= 0) return 'hangul';
    if (mime.indexOf('spreadsheet') >= 0 || mime.indexOf('ms-excel') >= 0) return 'excel';
    if (mime.indexOf('presentation') >= 0 || mime.indexOf('ms-powerpoint') >= 0) return 'powerpoint';
    if (mime.indexOf('wordprocessing') >= 0 || mime.indexOf('ms-word') >= 0 || mime.indexOf('msword') >= 0) return 'word';
    if (['xls', 'xlsx'].indexOf(ext) >= 0) return 'excel';
    if (ext === 'csv') return 'csv';
    if (['hwp', 'hwpx'].indexOf(ext) >= 0) return 'hangul';
    if (['ppt', 'pptx'].indexOf(ext) >= 0) return 'powerpoint';
    if (['doc', 'docx'].indexOf(ext) >= 0) return 'word';
    if (ext === 'pdf') return 'pdf';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].indexOf(ext) >= 0) return 'image';
    if (['mp3', 'wav', 'm4a', 'flac', 'ogg'].indexOf(ext) >= 0) return 'audio';
    if (['mp4', 'mov', 'webm', 'mkv', 'avi'].indexOf(ext) >= 0) return 'video';
    if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(ext) >= 0) return 'archive';
    if (['txt', 'md', 'markdown', 'log'].indexOf(ext) >= 0) return 'text';
    if (['js', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'xml', 'yml', 'yaml', 'py'].indexOf(ext) >= 0) return 'code';
    return 'file';
  }

  // ---- 세트 워크스페이스 (Material Icon Theme v5.40.0 원본, 무변형으로 넣는) ----
  // vb: 원본 viewBox, body: 원본 <svg> 내부 마크업 그대로.
  // 종류별 세트 파일: excelTable, powerpointPowerpoint, wordWord,
  // pdfPdf, imageImage, csvDatabase, textDocument(배경 투명),
  // audioAudio, videoVideo, archiveZip, codeConsole,
  // folderFolder, fileFile.
  var ARTWORK = {
    excel: {
      vb: '0 0 24 24',
      body: '<path fill="#8bc34a" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zm4 7.5h-4v2h1l-2 1.67L10 13h1v-2H7v2h1l3 2.5L8 18H7v2h4v-2h-1l2-1.67L14 18h-1v2h4v-2h-1l-3-2.5 3-2.5h1z"/>',
    },
    powerpoint: {
      vb: '0 0 24 24',
      body: '<path fill="#e64a19" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM8 11v2h1v6H8v1h4v-1h-1v-2h2a3 3 0 0 0 3-3 3 3 0 0 0-3-3zm5 2a1 1 0 0 1 1 1 1 1 0 0 1-1 1h-2v-2z"/>',
    },
    word: {
      vb: '0 0 24 24',
      body: '<path fill="#01579b" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM7 13l1.5 7h2l1.5-3 1.5 3h2l1.5-7h1v-2h-4v2h1l-.9 4.2L13 15h-2l-1.1 2.2L9 13h1v-2H6v2z"/>',
    },
    pdf: {
      vb: '0 0 24 24',
      body: '<path fill="#ef5350" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z"/>',
    },
    image: {
      vb: '0 0 16 16',
      body: '<path fill="#26a69a" d="M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9"/>',
    },
    csv: {
      vb: '0 0 32 32',
      body: '<path fill="#ffca28" d="M16 24c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-8c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-12C10.477 4 6 4.895 6 6v4c0 1.1 4.475 2 10 2s10-.9 10-2V6c0-1.105-4.477-2-10-2"/>',
    },
    text: {
      vb: '0 0 24 24',
      body: '<path fill="#42a5f5" d="M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z"/>',
    },
    audio: {
      vb: '0 0 32 32',
      body: '<path fill="#ef5350" d="M16 2a14 14 0 1 0 14 14A14 14 0 0 0 16 2m6 10h-4v8a4 4 0 1 1-4-4 3.96 3.96 0 0 1 2 .555V8h6Z"/>',
    },
    video: {
      vb: '0 0 32 32',
      body: '<path fill="#ff9800" d="m24 6 2 6h-4l-2-6h-3l2 6h-4l-2-6h-3l2 6H8L6 6H5a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3V6Z"/>',
    },
    archive: {
      vb: '0 0 24 24',
      body: '<path fill="#afb42b" d="M14 17h-2v-2h-2v-2h2v2h2m0-6h-2v2h2v2h-2v-2h-2V9h2V7h-2V5h2v2h2m5-4H5c-1.11 0-2 .89-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2"/>',
    },
    code: {
      vb: '0 0 16 16',
      body: '<path fill="#ff7043" d="M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z"/>',
    },
    folder: {
      vb: '0 0 16 16',
      body: '<path d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232" fill="#90a4ae" />',
    },
    file: {
      vb: '0 0 16 16',
      body: '<path d="m8.668 6h3.6641l-3.6641-3.668v3.668m-4.668-4.668h5.332l4 4v8c0 0.73828-0.59375 1.3359-1.332 1.3359h-8c-0.73828 0-1.332-0.59766-1.332-1.3359v-10.664c0-0.74219 0.59375-1.3359 1.332-1.3359m3.332 1.3359h-3.332v10.664h8v-6h-4.668z" fill="#90a4ae" />',
    },
  };

  // hangul (파생): word 워드 아이콘의 문서(오른쪽 모서리 포함)을 서명
  // 블루로 바꿨고, W 자리에 등 로고 그린다 등. 는 path자릿수 인
  // 아니라 Noto Sans KR Bold (SIL OFL 1.1) U+314E의 실제 글자를
  // 추출하고 변환한. 것이다: 변환폰트 bbox (157,80)-(768,711), upm 1000
  // 등 24 그리드 박스 x[6.4,17.6]등y[10.9,20.1]등 종횡비 유지 맞춘
  // (scale 0.01458). 단락 4가로획: 세로획 등 빈 공간 과
  // 세로로 등 폰트를 nonzero winding 그대로 채워진 뜻이 룹다.
  var HANGUL_GLYPH_D =
    'M7.55 14.14L7.55 12.56L16.45 12.56L16.45 14.14L7.55 14.14Z' +
    'M12.02 14.84L12.02 14.84Q13.04 14.84 13.84 15.17Q14.65 15.51 15.1 16.11Q15.55 16.7 15.55 17.48L15.55 17.48Q15.55 18.25 15.1 18.85Q14.65 19.44 13.84 19.77Q13.04 20.1 12.02 20.1L12.02 20.1Q11.02 20.1 10.21 19.77Q9.4 19.44 8.94 18.85Q8.48 18.25 8.48 17.48L8.48 17.48Q8.48 16.7 8.94 16.11Q9.4 15.51 10.2 15.17Q11 14.84 12.02 14.84Z' +
    'M12.02 16.45L12.02 16.45Q11.58 16.45 11.23 16.57Q10.87 16.69 10.67 16.91Q10.46 17.13 10.46 17.48L10.46 17.48Q10.46 17.81 10.67 18.04Q10.87 18.26 11.23 18.37Q11.58 18.48 12.02 18.48L12.02 18.48Q12.47 18.48 12.82 18.37Q13.17 18.26 13.37 18.04Q13.57 17.81 13.57 17.48L13.57 17.48Q13.57 17.13 13.37 16.91Q13.17 16.69 12.82 16.57Q12.47 16.45 12.02 16.45Z' +
    'M11.06 13.95L11.06 10.9L13 10.9L13 13.95L11.06 13.95Z';
  ARTWORK.hangul = {
    vb: '0 0 24 24',
    body:
      '<path fill="#1b6ac9" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5z"/>' +
      '<path fill="#ffffff" d="' + HANGUL_GLYPH_D + '"/>',
  };

  // 넣는데 왼쪽 오버 (macOS레이, "워크스"페이스 접힌): 종이 쪽을
  // 모양의 그림자 채워진로 등 번 등 그려 넣는다. 오른쪽 원본과
  // 완전히 겹쳐 투명 영역의 번트 라인 넣고, 종류를 가리지 않고 같은
  // 결 과로. 넣는다 아래 쪽이 붙었다 아래쪽 끝에 위치
  // 남은 파일과 깊이 감만 준다.
  function glossDefs(kind) {
    return (
      '<defs><linearGradient id="mhg-' + kind + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>' +
      '<stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>' +
      '<stop offset="0.78" stop-color="#000000" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#000000" stop-opacity="0.07"/>' +
      '</linearGradient></defs>'
    );
  }
  function glossBody(kind, body) {
    return body
      .replace(/fill="(?!none")[^"]*"/g, 'fill="url(#mhg-' + kind + ')"')
      .replace(/stroke="[^"]*"/g, 'stroke="url(#mhg-' + kind + ')"');
  }

  // 세트 원본의 종류마다 viewBox가 달라(16/24/32) 48 캔버스에 중첩
  // SVG로 배치한 사용체의 표시 크기를 균일하게 통일한다.
  // 파일 아이콘 렌더 규칙 (사용자 캡처 image-151로 확정,
  // 2026-11-06): 아이콘은 문서 모양(모서리 접힌 페이지) 그 자체다.
  // 흰색은 페이지 안쪽만 채우고 페이지 밖은 투명하게 해 바탕화면이
  // 비치게 한다 (실제 macOS 문서 아이콘의 형태). 구조: 흰 페이지
  // (모서리 접힘 포함)를 먼저 그리고 그 안에 종류별 아트워크(세트
  // 원본)를 중첩해 넣는다. 그리는 SVG에 배경을 넣지 않는다 —
  // 사용처(바탕화면 .dt-tile-svg)의 drop-shadow가 렌더를 따라가므로
  // 페이지 모양 그대로 그림자를 만들고, 투명 영역에는 라인이 없다.
  // folder는 문서가 아니라 폴더 모양 자체가 아이콘이므로 페이지를
  // 감싸지 않는다.
  var PAGE_D = 'M14 4H28L37 13V41a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z';
  var FOLD_D = 'M28 4v6a3 3 0 0 0 3 3h6Z';
  var PAGE_PATHS =
    '<path d="' + PAGE_D + '" fill="#ffffff" stroke="rgba(15,23,42,0.16)"/>' +
    '<path d="' + FOLD_D + '" fill="#dde4ec" stroke="rgba(15,23,42,0.16)"/>';
  var cache = {};
  function svgFor(kind) {
    if (!ARTWORK[kind]) kind = 'file';
    if (!cache[kind]) {
      var a = ARTWORK[kind];
      var isFolder = kind === 'folder';
      // 겹침 배치: 문서 종류는 페이지 안에 작게(19px) 중첩하고,
      // 폴더는 크게(32px) 그린다.
      var sx = isFolder ? 8 : 14.5;
      var sy = isFolder ? 8 : 15;
      var ss = isFolder ? 32 : 19;
      cache[kind] =
        '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        (isFolder ? '' : PAGE_PATHS) +
        '<svg viewBox="' + a.vb + '" x="' + sx + '" y="' + sy +
        '" width="' + ss + '" height="' + ss + '">' +
        glossDefs(kind) +
        a.body +
        '<g pointer-events="none">' + glossBody(kind, a.body) + '</g>' +
        '</svg></svg>';
    }
    return cache[kind];
  }

  function htmlFor(input) {
    return svgFor(kindFor(input));
  }

  // ---- 앱 타일 변환 (appTileFor) ----
  // 파일 아이콘과 앱 타일은 별개다 — 앱 타일은 실제 앱 아이콘에
  // 최대한 가깝게 맞추는 것이 결정 (사용자 확정 2026-11-03).
  // 실제 아이콘 파일을 가져와서 그대로 쓰는 것만 허용하고, 자체로
  // 다시 그리는 것은 금지한다 (자체 복사 금지).
  // - excel·powerpoint·hangul·finder: 제공된 이미지를 그대로 쓰는
  //   PNG (다시 그리지 않는다). excel=/icons/excel-app-v3.png,
  //   powerpoint=/icons/powerpoint-app-v3.png, hangul=/icons/hangul-app-v2.png,
  //   finder=/icons/finder-app.png.
  // - pdf: 흰 배경 + 빨간 본체 + 매듭 경로(PDF_KNOT_D)를
  //   ARTWORK.pdf에서 그대로 가져와 쓴다 (별도 비율 조정 없음).
  // - finder: 사용자가 직접 제공한 파인더 이미지를 그대로 넣는 PNG
  //   (/icons/finder-app.png). 파일 종류가 아니므로 KINDS/kindFor는
  //   거치지 않는다.
  var PDF_KNOT_D =
    'M10.93 12.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4' +
    'm6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3' +
    'm-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35' +
    'M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69z' +
    'm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z';

  // 사용자가 직접 제공한 앱 타일 이미지 (다시 그리지 않고 원본
  // 그대로 PNG를 캔버스에 넣는 공통 형태).
  // N-07 (2026-11-06): 표시 크기(48~64px) 기준 128px 생성본
  // (*-128.png, PIL LANCZOS 리샘플)을 쓰고, 원본 사용자 제공분
  // (512~824px)은 public/icons에 보존하고 매니페스트에 유지한다.
  function imageTile(src) {
    return (
      '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true">' +
      '<image href="' + src + '" xlink:href="' + src + '" width="48" height="48"/>' +
      '</svg>'
    );
  }

  var APP_TILES = {
    excel: function () {
      // 사용자 제공 이미지(image.jpeg: 투명 배경 600x600, 밴드 변환 임 +
      // X 를)왼쪽의 등 등 모서 리를 하나 로 PNG 나의 크기가 지시
      // 지시 등과 겹치고 워크스페이스 구조도 원본 그림이다.
      return imageTile('/icons/excel-app-v3-128.png');
    },
    powerpoint: function () {
      // 사용자 제공 고해상도 파일(3840px RGBA, 투명 배경)를 왼쪽의 등
      // 등(600x600) 위에 동일 상대(x0.13333, 본체 등 512px)로 하나
      // PNG 의 나의 크기가 지시 등과 같다.
      return imageTile('/icons/powerpoint-app-v3-128.png');
    },
    hangul: function () {
      // 지시 실행 사이의 사용자가 직접 만든 이미지(image-49: 플랫 밴드
      // 변환 + 등 본인, 시작 문를)그림 으로 넣다 다시 그리지 않는다 임계.
      // 원본에서 왼쪽의 변환 영역만 하나 모서리 투명 처리한 PNG
      // (/icons/hangul-app-v2.png, 741x740 를)변환 캔버스에 넣는다 끝부분.
      return imageTile('/icons/hangul-app-v2-128.png');
    },
    finder: function () {
      // Finder 실행 변환: 사용자가 직접 제공한 파인더 이미지
      // (image-51, 824x824 를 그림)으로 넣는다 등 자체 근사본 SVG
      // 근사본 사용자 확인으로 교체한 (2026-11-03).
      return imageTile('/icons/finder-app-128.png');
    },
    chat: function () {
      // AI 채팅 실행 변환: 사용자가 제공한 메시지 아이콘(image-59)이미지
      // 말풍선 가위표 'AI'를 아이콘 도형으로 하나 PNG (2026-11-03
      // 사용자 지정). 등블루 라인이 없이 그림으로 넣는다.
      return imageTile('/icons/chat-app-v2-128.png');
    },
    settings: function () {
      // 설정 실행 변환: 사용자가 직접 제공한 설정 아이콘(image-60)이미지
      // 그림 으로 (2026-11-03 넣는다 원본의). 스쿼클 이미지
      // 캔버스 0.805의 파인더 기준(1.000)로 하나 채운 다 v2.
      return imageTile('/icons/settings-app-v3-128.png');
    },
    memo: function () {
      // 메모 실행 변환: 사용자가 직접 제공한 메모 아이콘(image-61)이미지
      // 그림 으로 (2026-11-03 넣는다 원본). 스쿼클 임
      // 0.805를 파인더 기준(1.000)로 하나 채운 v2.
      return imageTile('/icons/memo-app-v3-128.png');
    },
    todo: function () {
      // 등 등 실행 변환: 사용자가 직접 제공한 등 등 아이콘(image-63,
      // 스쿼클 1.000라는 파인더 기준 그림으로)를 넣는다 (2026-11-03).
      return imageTile('/icons/todo-app-128.png');
    },
    browser: function () {
      // 브라우저 실행 변환: 사용자가 만든 시안(image-66) 중번 2단(하나의
      // 남은 변환 + 화살 표형태 지구를)하나 이미지 PNG (2026-11-03
      // 사용자 선택).
      return imageTile('/icons/browser-app-v4-128.png');
    },
    studio: function () {
      // AI 스튜디오 앱 타일: 사용자가 만든 시안(image-66) 중 6번을
      // 하나의 PNG로 쓴다 (2026-11-03).
      return imageTile('/icons/studio-app-v4-128.png');
    },
    trash: function () {
      // 휴지통 타일: 사용자가 제공한 OSX 이미지(image-65)에서 추출한
      // 빈 휴지통·찬 휴지통 PNG 2개를 겹쳐 놓고, CSS 클래스
      // dt-trash-full로 어느 쪽을 보일지 가른다 (decorateTrash가
      // 내부에서 그 클래스를 교체한다).
      return (
        '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true">' +
        '<image class="mta-trash-empty" href="/icons/trash-empty-128.png" xlink:href="/icons/trash-empty-128.png" width="48" height="48"/>' +
        '<image class="mta-trash-full" href="/icons/trash-full-128.png" xlink:href="/icons/trash-full-128.png" width="48" height="48"/>' +
        '</svg>'
      );
    },
    schedule: function () {
      // 일정 타일: 흰 squircle에 한글 요일 전체 이름(검정) + 큰 날짜
      // 숫자, 오늘 값으로 실시간 렌더 (2026-11-08 사용자 확정 디자인이
      // 2026-11-03의 영문 월 약어(NOV) 방식을 대체). 날짜가 바뀌므로
      // appTileFor 캐시를 타지 않는다.
      // 새로 만든 타일이라 이전 운영(사고직전)의 NOV 타일로 되돌리지 않는다
      // (2026-11-12 사용자 지시). 사용자가 "다른 앱과 동일하게"라 지적해
      // 2026-11-12에 전체를 키웠다: 흰 타일을 39.5(0.82 정렬)에서 다른 앱
      // 타일과 같은 full-bleed 48로, 글자도 같은 비율(48/39.5)로 키워
      // 요일 10.3·날짜 31.6으로. 반경은 다른 앱 타일 실측(PNG
      // 코너 0.25)과 맞춰 rx 12로 했다. 스트로크 없음·순검정 유지.
      // 2026-11-12 진짜 맥 대조(사용자 지적): 진짜 맥 독 일정 아이콘은
      // 요일·날짜 둘 다 볼드가 아니라 일반 굵기라, 800 볼드를 400으로
      // 바꿨다 (실측: 진짜 맥 날짜 획 중간값 3px 대 MyHub 800 굵기 5px).
      // 같은 날 두 번째 지적("메모·할 일과 비교해도 너무 튀어")의 원인도
      // 실측으로 확인했다: 진짜 맥 타일은 위 254 → 아래 235의 세로
      // 그라데이션이고 메모·할 일 PNG의 흰색도 246~250인데, MyHub 타일만
      // 순백(#fff) 평면이라 어두운 배경화면 위에서 유독 튀었다. 그래서
      // 타일에 진짜 맥과 같은 위 #fff → 아래 #ebebeb 그라데이션을 넣었다
      // (pdf 타일의 mta-pdf-bg 패턴과 동일). 스트로크는 넣지 않는다.
      // 같은 날 세 번째 지적("애플 비율·간격·글씨를 그대로 못하냐")에
      // 진짜 맥 독 아이콘(60px)을 픽셀 실측해 치수를 맞췄다: 요일 글자
      // 높이 0.183·위 여백 0.133, 날짜 글자 높이 0.450·위 0.400·아래
      // 여백 0.150, 요일-날짜 간격 0.083 (타일 높이 대비). MyHub는
      // 요일이 크고 날짜가 크며 간격이 절반(0.05)이어서 답답해 보였다.
      // 요일 10.3→9.7·날짜 31.6→30.5·날짜 기준선 39.6→40.8로 교정했다.
      // 같은 날 네 번째 지적("거의 유사해졌는데 요일이 살짝 볼드하게
      // 좀더 잘보이도록 뚜렷하게"): 9.7px 요일은 400 굵기에서 잘 안
      // 보여 요일만 600(semibold)으로 올렸다. 날짜는 400 유지.
      // 같은 날 다섯 번째 지적("여전히 맥과 좀달라: 더 볼드하고
      // 튀어나온 느낌, 1-2 간격이 더 좁아, 더 둥근 폰트, 백색이
      // 아주 살짝 쩅해"): 진짜 맥 실측(side-by-side)으로 원인을
      // 확인했다. ① 진짜 맥 글자색은 순검정이 아니라 RGB 39~40
      // (#282828) — MyHub 순검정 #000이 대비를 높여 볼드하고
      // 튀어나와 보였다. 글자색을 #282828로 바꿨다. ② 진짜 맥
      // 날짜 획 비율 0.062 대 MyHub 400 굵기 0.083 — 날짜를 300
      // (light)으로 낮췄다 (얇은 획이 1-2 사이 시각 간격도 넓힌다).
      // ③ 더 둥근 폰트: 날짜 폰트 스택 맨 앞에 ui-rounded를 넣어
      // 맥에서는 SF Rounded를 쓰게 했다 (미지원 브라우저는
      // -apple-system으로 폴백). ④ 1-2 간격: 날짜에
      // letter-spacing 1을 넣어 애플의 0.070 간격에 맞췄다.
      // ⑤ 백색 쩅함: 글자색 완화가 주 처방이고, 그라데이션도
      // #fff→#ebebeb에서 #fafafa→#e9e9e9로 살짝 낮췄다.
      // 같은 날 여섯 번째 지적("많이 유사해졌어. 글씨가 좀 잘 안
      // 보이거든 픽셀 높여주고, 요일은 더 볼드하게, 날짜도 살짝
      // 더 볼드하게 너무 얇아"): 가독성 우선으로 키웠다. 요일
      // 9.7→10.5·600→700, 날짜 30.5→32·300→400. 날짜 400은
      // #282828 색상 + SF Rounded과 함께라 이전의 순검정 400보다
      // 부드럽다. 기준선(요일 15.1·날짜 40.8)은 유지 — 글자가
      // 커져 요일-날짜 간격이 4.3px에서 3.3px로 좁아지지만 답답한
      // 수준은 아니다.
      // 같은 날 일곱 번째 지적("일자 사이 간격은 왜 또 떨어졌어
      // 둥글한 일자로 해야지. 스타일은 그대로 일자 사이간격
      // 더줄이고 둥글하게"): 사용자 맥 스크린샷(image-21) 실측에서
      // 1-2 간격이 0.188(9px)로 애플 0.070(3.4px)의 2.7배였다 —
      // letter-spacing 1 + 32px 확대가 간격을 벌린 것이다.
      // 다섯 번째 지적의 "간격이 더좁아"는 맥 간격이 좁다는
      // 뜻이었고, 나는 반대로 읽어 넓혔던 것이다 (오독 정정).
      // 수정: letter-spacing을 없애고, 두 자리 날짜는 두 번째
      // 자릿수를 <tspan dx="-5">로 당겨 간격을 ~4px로 좁혔다.
      // 음수 letter-spacing은 text-anchor 중심을 어긋나게 해서
      // 쓰지 않는다 (dx는 advance에 포함돼 중심이 유지된다).
      // 둥글게: 날짜 폰트 스택 맨 앞에 "SF Pro Rounded"을 명시해
      // ui-rounded과 함께 SF Rounded를 확실히 타게 했다.
      // 같은 날 여덟 번째 지적 묶음(사용자, 진짜 맥 클로즈업
      // image-22 + 현 MyHub image-23 대조): "너무붙였자나·폰트
      // 자체를 둥그렇게·요일 1.2배 볼드하게·웹에서 검색해봐·
      // 살짝 그림자같은게 있고 숫자2도 살짝 다르자나·애플폰트를
      // 구해야해?·우리껀 목요일 수평도 넓네". 두 이미지를 동일
      // 방법으로 실측한 결과: ① 1-2 간격 맥 0.080 대 MyHub 0.045 —
      // dx=-5가 너무 붙인 것이다. dx=-3으로 되돌려 간격 ~0.09로.
      // ② 요일 너비 맥 0.537 대 MyHub 0.659(23% 넓음), 요일 내
      // 자간 맥 0.011/0.016 대 MyHub 0.023/0.023 — 요일을 9.0으로
      // 줄이고 letter-spacing -0.5로 자간을 좁혔다. ③ 요일 굵기
      // 700→800 (사용자 요청 1.2배). ④ 글자색: 맥 실측 RGB 7~9
      // (거의 순검정) — 이전 side-by-side 실측 RGB 39~40은 업스케일
      // 왜곡이었다. #282828에서 #0a0a0a로 되돌렸다. ⑤ 그림자:
      // 맥은 날짜 아래 1~4px 띠가 배경보다 8포인트 어둡다(227 대
      // 235) — 텍스트에 은은한 드롭 섀도우가 있다. feDropShadow
      // (dy 1·blur 1·opacity 0.12)를 요일·날짜에 걸었다.
      // ⑥ 폰트: 웹 검색 결과 ui-rounded은 Safari 전용이고 Chrome은
      // 미지원, macOS Safari도 SF Pro로 폴백한다. "SF Pro Rounded"
      // 직접 지정도 웹에서 동작하지 않는다. 진짜 맥 아이콘의 "2"를
      // 보면 말단이 평평한 일반 SF라 Rounded 변형이 아니다.
      // 애플 폰트를 구할 필요 없이 맥에 있는 SF(-apple-system)를
      // 그대로 쓰면 된다 — 차이는 폰트가 아니라 굵기·간격·색상·
      // 그림자였다. "SF Pro Rounded"·ui-rounded 지정은 제거했다.
      // Nunito 등 둥근 웹폰트도 맥과 달라지므로 쓰지 않는다.
      // 같은 날 아홉 번째 지적(사용자, "2" 클로즈업 image-24):
      // "2가 좀 다르던데? 맥은 이렇게 꺾이지않고 쭉떨어지는데
      // 글씨자체가 틀려. 요일은 픽셀이 부족한지 명확하게 안보이는데
      // 고품질로 개선". 맥 "2" 하단(image-22 크롭)은 대각선이
      // 곡선으로 부드럽게 밑변에 이어지는데, 우리 "2"는 꺾인
      // 모서리(Helvetica/Arial식)다 — -apple-system이 SF로 안 풀리고
      // sans-serif(Helvetica)로 떨어진 것이다. SF는 광학 사이징이
      // 있어 20pt 이상은 SF Pro Display, 미만은 SF Pro Text를
      // 쓴다. 날짜(32px)에는 "SF Pro Display"를, 요일(9px)에는
      // "SF Pro Text"를 스택 맨 앞에 명시해 Display/Text 변형을
      // 확실히 타게 했다 (system-ui·-apple-system은 폴백으로 유지).
      // 요일 흐릿함의 원인은 feDropShadow 필터 — 필터가 텍스트를
      // 래스터화해서 Retina에서 뿌옇게 보인다. 필터를 없애고
      // 그림자를 벡터 복제 텍스트(1px 아래·불투명도 0.05)로 바꿔
      // 그림자는 유지하면서 선명도를 되돌렸다.
      // 같은 날 열 번째 지적(사용자): "해결안되었는데? 그리고
      // 목요일이랑 12사이에 여백도 띄워지 너무 붙어있어".
      // "SF Pro Display" 명시가 사용자 맥 Chrome에서 SF로 안 풀리고
      // 여전히 Helvetica로 떨어졌다 (웹에서는 SF를 이름으로 부를 수
      // 없고, system-ui·-apple-system도 이 환경에서 안 먹힌다).
      // SF 자체 호스팅은 라이선스 위반이라, SF와 가장 가까운 OFL
      // 폰트 Inter를 자체 호스팅해 날짜에 쓴다 (desktop.css의
      // @font-face, /fonts/inter-400.woff2 latin 서브셋 23KB).
      // Inter의 "2"는 SF처럼 대각선이 곡선으로 부드럽게 이어진다.
      // 요일-날짜 간격: 요일 기준선 15.1→13.6으로 올려 간격을
      // ~3.3px→~4.8px로 벌렸다 (맥 4.0px보다 살짝 넓게).
      // 같은 날 열한 번째 지적(사용자, image-25): "오맞아 근데
      // 날짜1이랑 2사이 간격을 살짝 벌려주기만하면 딱좋을거같아.
      // 12를 폰트크기를 아주 살짝 작게하고 간격을 좀만벌리면
      // 딱일거같은데. 그리고 목요일이 명확하게 보이도록 못하나?
      // 뭉게진거같아". Inter 2는 맞다고 확인됨. 수정: 날짜 32→31
      // (아주 살짝 작게 — 하네스 실측 높이 0.484로 맥과 일치),
      // dx -3→-2 (간격 1px 벌림). 요일 뭉게짐은 800 굵기 + 1px
      // 그림자가 9px 작은 글자에서 획을 뭉개는 것이다 — 요일 굵기
      // 800→700으로 낮추고 요일 그림자를 없앴다 (날짜 그림자는
      // 크기가 커서 유지). 요일 크기 9.0·자간 -0.5·기준선 13.6 유지.
      // 장부: ~/workspace/calendar-tile-20261110.md
      var now = new Date();
      var WEEKDAY_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
      var dateStr = String(now.getDate());
      // 두 자리 날짜는 두 번째 자릿수를 dx로 당겨 자릿수 간격을 좁힌다.
      var dateInner = dateStr.length === 2
        ? dateStr[0] + '<tspan dx="-2">' + dateStr[1] + '</tspan>'
        : dateStr;
      var weekdayStr = WEEKDAY_KO[now.getDay()];
      return (
        '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<defs><linearGradient id="mta-cal-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fafafa"/><stop offset="1" stop-color="#e9e9e9"/></linearGradient></defs>' +
        '<rect x="0" y="0" width="48" height="48" rx="12" fill="url(#mta-cal-bg)"/>' +
        '<text x="24" y="13.6" text-anchor="middle" font-family="\'SF Pro Text\', system-ui, -apple-system, BlinkMacSystemFont, \'Segoe UI\', \'Malgun Gothic\', sans-serif" font-size="9.0" font-weight="700" letter-spacing="-0.5" fill="#0a0a0a">' + weekdayStr + '</text>' +
        '<text x="24" y="41.8" text-anchor="middle" font-family="\'Inter\', \'SF Pro Display\', system-ui, -apple-system, BlinkMacSystemFont, \'Segoe UI\', \'Malgun Gothic\', sans-serif" font-size="31" font-weight="400" fill="#000000" opacity="0.05">' + dateInner + '</text>' +
        '<text x="24" y="40.8" text-anchor="middle" font-family="\'Inter\', \'SF Pro Display\', system-ui, -apple-system, BlinkMacSystemFont, \'Segoe UI\', \'Malgun Gothic\', sans-serif" font-size="31" font-weight="400" fill="#0a0a0a">' + dateInner + '</text>' +
        '</svg>'
      );
    },
    pdf: function () {
      return (
        '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<defs><linearGradient id="mta-pdf-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2544a"/><stop offset="1" stop-color="#d92315"/></linearGradient></defs>' +
        // 크기 (사용자 최종 확정 2026-11-03): 등 배경 없이, 왼쪽의 본체만
        // 지시 변환 여기의 맞추어 동일 확정한다. 지시 사이의 캔버스에 꽂아
        // 채우는 비율(본체 1.000)라는 본체 박스 (5,5,38,38) 등
        // (0,0,48,48)로 매핑한다 (x1.26316, 잘리그림자프 없음).
        '<g transform="translate(-6.3158,-6.3158) scale(1.26316)">' +
        '<rect x="5" y="5" width="38" height="38" rx="8" fill="url(#mta-pdf-bg)"/>' +
        '<rect x="5" y="5" width="38" height="17" rx="8" fill="#ffffff" opacity="0.08"/>' +
        '<g transform="translate(1.15,-0.6) scale(1.85)"><path fill="#ffffff" d="' + PDF_KNOT_D + '"/></g>' +
        '</g>' +
        '</svg>'
      );
    },
  };
  var appCache = {};
  function appTileFor(kind) {
    if (!APP_TILES[kind]) return svgFor(kind);
    if (kind === 'schedule') return APP_TILES[kind](); // 날짜 사이를 캐시하지 않는다
    if (!appCache[kind]) appCache[kind] = APP_TILES[kind]();
    return appCache[kind];
  }

  var api = { KINDS: KINDS, kindFor: kindFor, svgFor: svgFor, htmlFor: htmlFor, appTileFor: appTileFor };
  if (typeof window !== 'undefined') window.MyHubFileIcons = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFileIcons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
