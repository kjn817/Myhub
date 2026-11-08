/* MyHub 파일 아이콘 — 문서(페이지) 형태 렌더 (D-32 정본, 2026-11-06 정정)
 *
 * 원칙: 파일 아이콘을 네모 타일로 감싸지 않는다. 접힌 모서리가 있는
 * 문서(페이지) 모양 안쪽만 흰색으로 채우고, 모양 밖은 투명하게 둬서
 * 바탕화면이 비치게 한다. 종류 심볼은 페이지 안쪽에 얹는다.
 * 앱 타일(APP_TILES)은 별도 체계: 사용자 제공 이미지 우선, 실패 시 SVG 폴백.
 *
 * 아이콘 글리프 계열: Material Icon Theme 5.40.0 (MIT License)
 *   Copyright (c) 2018-2024 Material Icons authors (Philipp Kief and contributors)
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *   (버전 핀: material-icon-theme@5.40.0 — 종류 판정·색 규약만 차용, 경로는 자체 그림)
 *
 * 노출: window.MyHubFileIcons + module.exports (Node/테스트)
 */
(function () {
  'use strict';

  // 확장자 → kind (kind 14종)
  var EXT_KIND = {
    xls: 'excel', xlsx: 'excel', xlsm: 'excel', xlsb: 'excel',
    csv: 'csv',
    hwp: 'hangul', hwpx: 'hangul',
    ppt: 'powerpoint', pptx: 'powerpoint', pps: 'powerpoint', ppsx: 'powerpoint',
    pdf: 'pdf',
    doc: 'word', docx: 'word', rtf: 'word', odt: 'word',
    txt: 'text', log: 'text',
    md: 'markdown', markdown: 'markdown',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
    svg: 'image', bmp: 'image', heic: 'image', avif: 'image',
    mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio',
    mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
    zip: 'archive', tar: 'archive', gz: 'archive', '7z': 'archive', rar: 'archive',
  };

  var MIME_KIND = [
    [/spreadsheet|excel/, 'excel'],
    [/presentation|powerpoint/, 'powerpoint'],
    [/wordprocessing|msword/, 'word'],
    [/pdf/, 'pdf'],
    [/image\//, 'image'],
    [/audio\//, 'audio'],
    [/video\//, 'video'],
    [/zip|archive|compressed/, 'archive'],
    [/text\/plain/, 'text'],
    [/markdown/, 'markdown'],
  ];

  // kind별 심볼 색·문자 (페이지 안쪽에 얹는 종류 심볼)
  var KIND_STYLE = {
    excel: { color: '#1d7044', mark: 'X' },
    csv: { color: '#1d7044', mark: 'db' },
    hangul: { color: '#1b5fc4', mark: 'ㅎ' },
    powerpoint: { color: '#c7501f', mark: 'P' },
    pdf: { color: '#d13239', mark: 'PDF' },
    word: { color: '#2b579a', mark: 'W' },
    text: { color: '#5b6470', mark: '≡' },
    markdown: { color: '#5b6470', mark: 'M↓' },
    image: { color: '#7a5af8', mark: 'img' },
    audio: { color: '#b54708', mark: '♪' },
    video: { color: '#6941c6', mark: '▶' },
    archive: { color: '#8a6d3b', mark: 'zip' },
    folder: { color: '#e8a13a', mark: '' },
    file: { color: '#8a8f98', mark: '' },
  };

  function extOf(name) {
    if (!name || typeof name !== 'string') return '';
    var dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toLowerCase();
  }

  /** 파일 메타({name, mime, kind?, isFolder}) → kind 문자열 */
  function kindFor(file) {
    if (!file) return 'file';
    if (file.isFolder || file.kind === 'folder') return 'folder';
    if (file.kind && KIND_STYLE[file.kind]) return file.kind;
    var ext = extOf(file.name || file.filename || '');
    if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
    var mime = (file.mime || file.mimeType || '').toLowerCase();
    for (var i = 0; i < MIME_KIND.length; i++) {
      if (MIME_KIND[i][0].test(mime)) return MIME_KIND[i][1];
    }
    return 'file';
  }

  // 페이지 형태: 바깥 투명, 안쪽 흰색, 접힌 모서리. 48x48 기준.
  function pagePath() {
    return 'M15 3h13l11 11v29a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z';
  }
  function foldPath() {
    return 'M28 3l11 11H31a3 3 0 0 1-3-3V3z';
  }

  var svgCache = {};

  function svgFor(kind) {
    if (svgCache[kind]) return svgCache[kind];
    var st = KIND_STYLE[kind] || KIND_STYLE.file;
    var inner;
    if (kind === 'folder') {
      inner = '<path d="M6 14a3 3 0 0 1 3-3h9l3 4h18a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V14z" fill="#f5c86e" stroke="#dda83e" stroke-width="1"/>' +
        '<path d="M6 20h36v15a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V20z" fill="#ffd98f"/>';
      svgCache[kind] = '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + inner + '</svg>';
      return svgCache[kind];
    }
    var mark = '';
    if (st.mark === 'db') {
      mark = '<g fill="none" stroke="' + st.color + '" stroke-width="2"><ellipse cx="24" cy="26" rx="7" ry="3.2"/><path d="M17 26v8c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2v-8"/><path d="M17 30c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2"/></g>';
    } else if (st.mark === 'img') {
      mark = '<g fill="none" stroke="' + st.color + '" stroke-width="2"><rect x="17" y="21" width="14" height="12" rx="1.5"/><circle cx="21.5" cy="25.5" r="1.6" fill="' + st.color + '" stroke="none"/><path d="M17 31l4.5-4.5 3 3L28 26l3 3.5"/></g>';
    } else if (st.mark) {
      var size = st.mark.length > 2 ? 8.5 : 13;
      mark = '<text x="24" y="33" text-anchor="middle" font-family="' +
        (kind === 'hangul' ? '"Noto Sans KR",sans-serif' : '-apple-system,sans-serif') +
        '" font-weight="700" font-size="' + size + '" fill="' + st.color + '">' + st.mark + '</text>';
    }
    var ruled = (kind === 'text' || kind === 'word' || kind === 'markdown')
      ? '<g stroke="#d4d8de" stroke-width="1.6"><path d="M18 17h12"/><path d="M18 21h12"/></g>' : '';
    svgCache[kind] =
      '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="' + pagePath() + '" fill="#ffffff" stroke="#c9ced6" stroke-width="1.2"/>' +
      '<path d="' + foldPath() + '" fill="#eceff3" stroke="#c9ced6" stroke-width="1.2"/>' +
      ruled + mark + '</svg>';
    return svgCache[kind];
  }

  function htmlFor(file) {
    return svgFor(kindFor(file));
  }

  /* ---- 앱 타일 (APP_TILES) ----
   * 사용자 제공 이미지가 정본인 타일은 image로 두고, 로드 실패 시
   * fallbackKind의 문서형 SVG(없으면 글리프)로 폴백한다. 이미지 9종은
   * 2026-11-08 사용자 재공급으로 public/icons/에 복원 완료. 일정은
   * 동적 달력 타일(calendar)이 확정 디자인이라 전용 이미지가 없다.
   * PDF는 원본 시대부터 자체 제작 SVG 타일(빨강 타일+흰 매듭)이 정본이라
   * type 'svg'로 두고 pdfTileSvg()가 렌더한다 — PNG 파일은 원본에 없었다.
   * 마감: 이미지는 타일 박스를 꽉 채우는 full-bleed가 정본이라 런타임
   * 축소 배율 같은 보정을 두지 않는다 (2026-11-08 사용자 지시). */
  var MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  var APP_TILES = {
    finder: { type: 'image', src: '/icons/finder-app.png', label: 'Finder' },
    browser: { type: 'image', src: '/icons/browser-app-v4.png', label: '브라우저' },
    studio: { type: 'image', src: '/icons/studio-app-v4.png', label: 'AI 스튜디오' },
    memo: { type: 'image', src: '/icons/memo-app-v3.png', label: '메모' },
    todo: { type: 'image', src: '/icons/todo-app.png', label: '할 일' },
    excel: { type: 'image', src: '/icons/excel-app-v3.png', label: 'Excel', fallbackKind: 'excel' },
    hangul: { type: 'image', src: '/icons/hangul-app-v2.png', label: '한글 2020', fallbackKind: 'hangul' },
    powerpoint: { type: 'image', src: '/icons/powerpoint-app-v3.png', label: 'PowerPoint', fallbackKind: 'powerpoint' },
    pdf: { type: 'svg', label: 'PDF' },
    chat: { type: 'image', src: '/icons/chat-app-v2.png', label: 'AI 채팅' },
    settings: { type: 'image', src: '/icons/settings-app-v3.png', label: '설정' },
    trash: { type: 'image', src: '/icons/trash-empty.png', fullSrc: '/icons/trash-full.png', label: '휴지통' },
    schedule: { type: 'calendar', label: '일정' },
  };

  /* 달력 타일 (2026-11-08 사용자 확정 디자인으로 교체): 흰 squircle 위에
   * 한글 요일 전체 이름(검정 볼드) + 큰 날짜 숫자(검정 볼드)를 오늘 값으로
   * 실시간 렌더한다. 도형 크기는 이미지 아이콘 아트워크 충전율(실측 선형
   * 0.82)에 맞춰 39.5/48로 잡는다 — 48을 꽉 채우면 다른 아이콘보다 커
   * 보이고, 예전 38×36(0.79×0.75)은 작아 보였다. */
  var WEEKDAY_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

  function calendarTileSvg(date) {
    var d = date || new Date();
    return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<rect x="4.25" y="4.25" width="39.5" height="39.5" rx="9" fill="#ffffff" stroke="#d4d8de"/>' +
      '<text x="24" y="16.7" text-anchor="middle" font-family="-apple-system,sans-serif" font-weight="800" font-size="8.5" fill="#111418">' + WEEKDAY_KO[d.getDay()] + '</text>' +
      '<text x="24" y="36.8" text-anchor="middle" font-family="-apple-system,sans-serif" font-weight="800" font-size="26" fill="#111418">' + d.getDate() + '</text></svg>';
  }

  /* PDF 앱 타일 (자체 제작 SVG — 빨강 타일+흰 매듭).
   * ★ 바이트 원본 아님 — 기록 기반 재구성: 원본 SVG 코드는 소실 사고로
   * 남아 있지 않고, 형태 기록만으로 다시 그렸다. 근거 (2026-11-03 일일
   * 로그): "PDF는 빨강 타일+흰 매듭" (커밋 80b5a9c0), 최종 확정은 "흰
   * 배경 없이 빨간 라운드 본체만 한글 크기로 확대" (커밋 9a1444b5) —
   * 본체가 38/48(79%)이라 작았던 것을 한글 아트워크 충전율(실측 선형
   * 0.82)에 맞춰 달력 타일과 같은 39.5/48 규격으로 확대한 형태다.
   * 빨강은 같은 모듈의 원본 기록에 남은 유일한 PDF 레드 #ec1c24를 쓴다.
   * 기록에 없는 장식(문자·그라데이션·광택)은 넣지 않는다. */
  function pdfTileSvg() {
    return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<rect x="4.25" y="4.25" width="39.5" height="39.5" rx="9" fill="#ec1c24"/>' +
      '<path d="M24 26.5C19.5 19 13 19.3 13 24C13 28.7 19.5 29 24 26.5C28.5 29 35 28.7 35 24C35 19.3 28.5 19 24 26.5Z" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  }

  var api = {
    EXT_KIND: EXT_KIND,
    KIND_STYLE: KIND_STYLE,
    MONTH_ABBR: MONTH_ABBR,
    WEEKDAY_KO: WEEKDAY_KO,
    APP_TILES: APP_TILES,
    kindFor: kindFor,
    svgFor: svgFor,
    htmlFor: htmlFor,
    calendarTileSvg: calendarTileSvg,
    pdfTileSvg: pdfTileSvg,
  };

  if (typeof window !== 'undefined') window.MyHubFileIcons = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFileIcons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
