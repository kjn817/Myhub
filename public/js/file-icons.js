/* MyHub 공용 파일 아이콘 (file-icons.js)
 *
 * 파일 종류별 아이콘 등 자체 시작 SVG가 등 차례 사용자 사진에서 내린다
 * (2026-11-02) 스마트 아이콘 세트로 아래 교체한다. 자릿수 오프셋에서
 * 등 이상 유지하지 않는다.
 *
 * 출처 (버전 등 고정):
 * - 등 종류의 워크스페이스 **Material Icon Theme v5.40.0**
 *   (npm material-icon-theme@5.40.0, upstream:
 *   github.com/material-extensions/vscode-material-icon-theme)의
 *   icons/ 원본 SVG를 그대로 넣는 것이다. 종류 매핑은 아래 ARTWORK의
 *   주석 참조. 등 세트 자체에 정합된 매핑(xlsx·csv·table 등)을 나열.
 * - hangul만 세트가 없어 파생 시작했다: 같은 세트 word 아이콘의 문서
 *   오른쪽을 서명 블루(#1b6ac9)로 바꿔 것 (MIT가 허용되는 변환)숨기고,
 *   기타 자리 에는 자체로 그리고 실제 폰트 글자 를 추출한
 *   있었다. 등 글리프 출처: **Noto Sans KR Bold** (Google, SIL Open
 *   Font License 1.1)의 U+314E 를 opentype.js로 추출한 글리프
 *   박스에 맞게 변환한 path는 (자릿수 로고 실제 모양과 들어 사용한
 *   반대로 2026-11-02 교체; 폰트 렌더링 개별 줄로 일치 검진).
 * - 표시 오버레이 (MyHub 추가 변환, 워크스페이스 원본 자체에 무변형):
 *   svgFor가 세트 워크스페이스를 같은 오른쪽으로 넣는데 상단 왼쪽+하단
 *   파일 그림자 등 것 넣는다 (macOS의 왼쪽, "이름"의 기준 등
 *   2026-11-02 사용자 지정).
 * - text등 원본 document.svg를 전체 캔버스 배경 투명만 제거한다
 *   (밝은 UI에서 것이 자체 하나 아닌 등 변환 포함 명시).
 *
 * 라이선스 등 Material Icon Theme의 MIT License의.
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
 * 조사에서 내린 세트 (한글 등 참고):
 * - Simple Icons (CC0): 현재 버전에서 Microsoft 브랜드 아이콘이 포함
 *   제거된 excel/word/powerpoint 글리프가 없다.
 * - vscode-icons: 코드 MIT로 별개로 아이콘 자체가 CC BY-SA 4.0라는
 *   ShareAlike 를 인해 채택하지 않았다.
 *
 * 공유 (기존과 동일):
 * - kindFor({name, mime}): MIME 우선, 없으면 확장자.
 * - svgFor(kind): 종류별 SVG 문자열 (48횞48 캔버스에 세트 원본의 중첩
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

  // ---- 세트 워크스페이스 (Material Icon Theme v5.40.0 원본, 무변형 넣는) ----
  // vb: 원본 viewBox, body: 원본 <svg> 내부 마크업 그대로.
  // 종류 등 세트 파일: excelTable, powerpointPowerpoint, wordWord,
  // pdfPdf, imageImage, csvDatabase, textDocument(배경 투명만
  // A), audioVudio, videoZideo, archiveCip, code제거onsole,
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
  // 파일 아이콘 렌더 정보 (사용자 가 캡처 image-151로 확정,
  // 2026-11-06): 아이콘 문서 모양(모서리 접힌 페이지) 그 자체의.
  // 상대적으로 채워진 것 페이지 넣소재와 페이지 밖에 투명
  // 바탕화면 그림으로 비치는 (실제 macOS 문서 아이콘의 형태).
  // 실제로 "왼쪽 아래쪽 꺾인 + 방식" 사용 자가 다른 새로
  // 감지하고 등 것 아니라서 알리는 등 투명 rect를 하나하나 만들.
  // 구조: 등 페이지(모서리 포함 를)먼저 그리고 그, 넣소 재
  // 중첩해 종류 꺾인(세트 워크스 페이스)그림으로 넣는다.
  // 그리는 등 SVG의 넣기 않는다 등 사용체(바탕화면 .dt-tile-svg)를
  // drop-shadow가 렌더를 따라가므로 페이지 오른쪽 모양 그림으로
  // 넣고, 투명 영역을 이름이 튀어 나와 라인이 없다.
  // folder는 문서가 아니라 폴더 오른쪽 자체가 아이콘이므로 페이지를
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
      // 꺾인 배치: 문서 종류의 페이지(11..37 넣소 4..44) 중첩 끝,
      // 폴 더를 오른쪽 컷 보인다 캔버스 중첩이 그린다.
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

  // ---- 등 실행 변환 (꺾인하면 모든 변환 적용, appTileFor) ----
  // 파일 아(이콘)문서와 실행 사이의 무엇을 오른쪽 파일 파일 답게,
  // 넣을 결정 (사용자 확정 2026-11-03). 실행 변환 4종 최초 실행
  // 등 아이 콘의(구성+투명 배경+등 꺾)인를 최대한 가깝게 맞추고,
  // 기타 특수한 특수 등 자체 벡터로 그렸고 실제 아이콘 파일을
  // 가져와서 자체로 그리는 것만 금지한다 (상대 자체 복사 금지).
  // - excel사용powerpoint자가hangul직접finder: 제공한 변환 이미지 그대로
  //   이미지를 다시 그리지 않는 PNG. excel=/icons/excel-app-v3.png,
  //   powerpoint=/icons/powerpoint-app-v3.png, hangul=/icons/hangul-app-v2.png,
  //   finder=/icons/finder-app.png.
  // - 여기 (배경 사용자 최종 2026-11-03): 확정 왼쪽의 등변환 유지.
  //   hangul는 아래 규칙 그림으로 넣는다. excel모서리powerpoint포함
  //   모서리를 왼쪽의 처리한 등 등(위에) 워크스페이스를 동일 상대
  //   상대적으로 넣어 지시 등과 같은 여기로 맞추고, pdf는 등 배경
  //   없이 본체만 지시 여기로 확정한다. (등 종류의 각각 등 직사각형을
  //   파일 확정하는 사용자 반대로 알린다.)
  // - pdf: 흰색 빨간 변환 + 가위표 등 등 매직 (배치 없음 등 비례 것).
  //   매직 특수 등 ARTWORK.pdf의 매직 단락(세트 자체 서로)를 것
  //   꺾인로 다시 등 것으로, 비례 자체가 아니다.
  // - finder: 사용자가 직접 제공한 파인더 이미지를 그로 넣는 PNG
  //   (/icons/finder-app.png) 의 자체 SVG 근사본 2026-11-03 사용자
  //   확인으로 교체. 파일 종류가 아닌 모든 변환 적용이라
  //   KINDS/kindFor는 넣기 않는다. (등 "자체 금지"등 금지 자체
  //   가져오는 경우로 넣고, 사용자 제공분을 그림으로 적용한 공유.)
  var PDF_KNOT_D =
    'M10.93 12.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4' +
    'm6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3' +
    'm-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35' +
    'M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69z' +
    'm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z';

  // 사용자가 직접 제공한 변환 이미지 (다시 그리지 않고 원본의 하나
  // 배경 모서리만 PNG)정리한를 변환 캔버스에 넣는 공통 형태.
  // N-07 (2026-11-06): 로드된 표시 여기(48~64px) 기준 128px 생성본
  // (*-128.png, PIL LANCZOS 를넣다)등 원본 사용자 제공(512~824px, 정보를 그림으로
  // 정보를)그림 public/icons으로 보존하고 매니페 스트에 유지한다.
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
      // AI 스튜디오 실행 변환: 사용자가 만든 시안(image-66) 중 6번(등
      // 변환 + 보라 스토어 별자리)를 하나 PNG (2026-11-03 임).
      return imageTile('/icons/studio-app-v4-128.png');
    },
    trash: function () {
      // 휴지통 변환: 사용자가 제공한 OSX 이미지 에서(image-65)추출
      // 빈 통과 찢 넣소 각자 하나 배경의 등 PNG 2개를 겹쳐 놓고,
      // 등 버튼 dt-trash-full 클래스로 가져와 왼쪽의 (CSS가 해당 등
      // decorateTrash가 내부 그 클래스를 교체하고 있다). 끝에만 없는
      // 맨 등 모양의 맨 넣소와 같다.
      return (
        '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true">' +
        '<image class="mta-trash-empty" href="/icons/trash-empty-128.png" xlink:href="/icons/trash-empty-128.png" width="48" height="48"/>' +
        '<image class="mta-trash-full" href="/icons/trash-full-128.png" xlink:href="/icons/trash-full-128.png" width="48" height="48"/>' +
        '</svg>'
      );
    },
    schedule: function () {
      // 일정 타일: 흰 squircle에 한글 요일 전체 이름(검정 볼드) + 큰 날짜
      // 숫자, 오늘 값으로 실시간 렌더 (2026-11-08 사용자 확정 디자인이
      // 2026-11-03의 영문 월 약어(NOV) 방식을 대체). 날짜가 바뀌므로
      // appTileFor 캐시를 타지 않는다.
      // 비율은 2026-11-10 사용자가 첨부한 실제 Apple Calendar 아이콘
      // 사진 실측에 맞춘 값이다 (타일 한 변=1 기준): 모서리 반경 0.245,
      // 테두리 스트로크 없음, 요일 잉크 [상단 0.133·높이 0.173] 볼드,
      // 날짜 잉크 [상단 0.388·높이 0.449] 레귤러(획/높이 0.114 실측),
      // 잉크 색 순검정. 장부: ~/workspace/calendar-tile-20261110.md
      var now = new Date();
      var WEEKDAY_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
      return (
        '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<rect x="4.25" y="4.25" width="39.5" height="39.5" rx="9.7" fill="#ffffff"/>' +
        '<text x="24" y="15.7" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', \'Malgun Gothic\', sans-serif" font-size="7.4" font-weight="700" fill="#000000">' + WEEKDAY_KO[now.getDay()] + '</text>' +
        '<text x="24" y="37.3" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', \'Malgun Gothic\', sans-serif" font-size="24.6" font-weight="400" fill="#000000">' + now.getDate() + '</text>' +
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
