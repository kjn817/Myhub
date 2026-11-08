/* MyHub 데스크톱 공용 타일 — 독·바탕화면·런처가 함께 쓰는 타일 공장.
 *
 * 재구성 근거: squircle 타일 + 파스텔 그라데이션 + 흰 Lucide 글리프 (2026-11-01),
 * 동적 생성 직후 refreshIcons()로 createIcons 갱신 (빈 타일 사고의 근본 수정),
 * 일정은 한글 요일+날짜 실시간 달력 타일 (2026-11-08 사용자 확정 디자인).
 *
 * 렌더 우선순위 (2026-11-08, 사용자 재공급 앱 아이콘 복원):
 * 1) schedule: 동적 달력 타일 (전용 분기 — 항상 최우선)
 * 2) APP_TILES svg 항목(pdf): 자체 제작 SVG 타일 (빨강 타일+흰 매듭,
 *    dt-tile-svg) — 원본 시대부터 PNG가 아니라 SVG가 정본
 * 3) APP_TILES image 항목: 사용자 제공 앱 PNG를 img로 렌더 (원본 정본, dt-tile-image)
 *    - img 로드 실패 시: SVG 종류(excel·hangul·powerpoint)는 file-icons
 *      문서형 SVG(dt-tile-svg)로, 그 외는 그라데이션+글리프(dt-tile-img-fallback)로 폴백
 * 4) APP_TILES image가 없는 오피스 종류(noImage 등): file-icons SVG (dt-tile-svg)
 * 5) 그 외: 그라데이션 + Lucide 글리프
 *
 * 마감 계약 (2026-11-08 사용자 지시로 정정): 이미지 타일은 full-bleed —
 * PNG가 타일 박스를 꽉 채우고 타일 배경(회색 판)·클립·런타임 축소를
 * 두지 않는다. 글리프 타일은 자체 그라데이션이 박스를 채우는 게 정본이다.
 *
 * 노출: window.MyHubDesktopTiles + module.exports
 */
(function () {
  'use strict';

  // 모듈 id → 그라데이션·글리프 정의 (색은 desktop.css의 .dt-tile-<id>가 소유하는
  // 구조였으나, 재구성본은 타일 정의가 그라데이션을 함께 들고 있는다 —
  // CSS 변수 --tile-a/--tile-b로 주입해 두 표면이 같은 값을 쓰게 한다.)
  var TILE_DEFS = {
    finder: { glyph: 'folder', a: '#8ecdf7', b: '#4a9eda' },
    memo: { glyph: 'notebook-pen', a: '#ffe08a', b: '#f5b93f' },
    schedule: { glyph: 'calendar', a: '#ffb3ab', b: '#f2604d' },
    todo: { glyph: 'list-checks', a: '#a5d8ff', b: '#4a9eda' },
    chat: { glyph: 'messages-square', a: '#b2f2bb', b: '#51b06a' },
    browser: { glyph: 'compass', a: '#a5d8ff', b: '#3b82c4' },
    studio: { glyph: 'sparkles', a: '#d0bfff', b: '#8366d6' },
    backup: { glyph: 'archive', a: '#ced4da', b: '#868e96' },
    settings: { glyph: 'settings', a: '#ced4da', b: '#868e96' },
    mission: { glyph: 'layout-dashboard', a: '#ffc9c9', b: '#e0655f' },
    trash: { glyph: 'trash-2', a: '#e9ecef', b: '#adb5bd' },
  };

  var SVG_TILE_KINDS = { excel: 'excel', hangul: 'hangul', powerpoint: 'powerpoint', pdf: 'pdf' };

  function fileIcons() {
    return typeof window !== 'undefined' ? window.MyHubFileIcons : null;
  }

  function refreshIcons(root) {
    if (typeof window === 'undefined' || !window.lucide) return;
    try { window.lucide.createIcons(root ? { root: root } : undefined); }
    catch (e) {
      try { window.lucide.createIcons(); } catch (e2) { console.debug('타일 아이콘 갱신 실패:', e2); }
    }
  }

  /**
   * 타일 요소 생성. 반환: <span class="dt-tile dt-tile-<id>">…</span>
   * - schedule: 동적 달력 SVG (한글 요일 + 오늘 날짜) — 전용 분기, 항상 최우선
   * - APP_TILES svg 항목(pdf): 자체 제작 SVG 타일 (dt-tile-svg)
   * - APP_TILES image 항목: img (사용자 제공 앱 아이콘). 로드 실패 시 SVG
   *   종류는 file-icons SVG(dt-tile-svg)로, 그 외는 글리프로 폴백
   * - APP_TILES image가 없는 오피스 종류: file-icons SVG (dt-tile-svg)
   * - 그 외: 그라데이션 + Lucide 글리프
   */
  function createTile(moduleId, opts) {
    opts = opts || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    var span = doc.createElement('span');
    span.className = 'dt-tile dt-tile-' + moduleId;
    var fi = fileIcons();

    if (moduleId === 'schedule' && fi) {
      span.classList.add('dt-tile-svg');
      span.innerHTML = fi.calendarTileSvg(new Date());
      return span;
    }
    var appTile = fi && fi.APP_TILES ? fi.APP_TILES[moduleId] : null;
    if (appTile && appTile.type === 'svg' && fi && typeof fi.pdfTileSvg === 'function') {
      span.classList.add('dt-tile-svg');
      span.innerHTML = fi.pdfTileSvg();
      return span;
    }
    if (appTile && appTile.type === 'image' && !opts.noImage) {
      span.classList.add('dt-tile-image');
      var img = doc.createElement('img');
      // 휴지통: 찬 상태(opts.trashFull)면 fullSrc 변형본을 쓴다 (dock이 전달)
      img.src = opts.trashFull && appTile.fullSrc ? appTile.fullSrc : appTile.src;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', function () {
        span.innerHTML = '';
        fillImageFallback(span, moduleId, fi, appTile);
      });
      span.appendChild(img);
      return span;
    }
    if (SVG_TILE_KINDS[moduleId] && fi) {
      span.classList.add('dt-tile-svg');
      span.innerHTML = fi.svgFor(SVG_TILE_KINDS[moduleId]);
      return span;
    }
    var def = TILE_DEFS[moduleId] || { glyph: 'layout-grid', a: '#ced4da', b: '#868e96' };
    span.style.setProperty('--tile-a', def.a);
    span.style.setProperty('--tile-b', def.b);
    fillGlyph(span, moduleId, def);
    return span;
  }

  // img 로드 실패 폴백: fallbackKind/SVG 종류가 있으면 문서형 SVG(dt-tile-svg)로,
  // 없으면 그라데이션 + Lucide 글리프(dt-tile-img-fallback)로 되돌린다.
  function fillImageFallback(span, moduleId, fi, appTile) {
    span.classList.remove('dt-tile-image');
    var kind = (appTile && appTile.fallbackKind) || SVG_TILE_KINDS[moduleId];
    if (kind && fi) {
      span.classList.add('dt-tile-svg');
      span.innerHTML = fi.svgFor(kind);
      return;
    }
    span.classList.add('dt-tile-img-fallback');
    var fdef = TILE_DEFS[moduleId] || { a: '#ced4da', b: '#868e96' };
    span.style.setProperty('--tile-a', fdef.a);
    span.style.setProperty('--tile-b', fdef.b);
    fillGlyph(span, moduleId);
    refreshIcons(span);
  }

  function fillGlyph(span, moduleId, def) {
    def = def || TILE_DEFS[moduleId] || { glyph: 'layout-grid' };
    var i = span.ownerDocument.createElement('i');
    i.setAttribute('data-lucide', def.glyph);
    span.appendChild(i);
  }

  var api = {
    TILE_DEFS: TILE_DEFS,
    createTile: createTile,
    refreshIcons: refreshIcons,
  };

  if (typeof window !== 'undefined') window.MyHubDesktopTiles = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopTiles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
