/* MyHub 데스크톱 타일 공용 아이콘 타일 시스템 (tiles.js)
 *
 * 설계: docs/desktop-macos-redesign-20261101.md (사용자 검수 기준 1)
 * - 독·바탕화면 아이콘과·다는 목록과 같은 타일을 공유한다.
 * - 타일: 둥근 모서리(squircle 근사, 반경 24%) + 모듈별 파스텔 그라데이션
 *   + 흰색 Lucide 글리프 + 앱의 그림자. 이미지Apple 자산 사용 금지.
 * - 그라데이션 색은 desktop.css의 .dt-tile-<id> 클래스가 소유한다.
 * 노출: window.MyHubDesktopTiles = { TILE_DEFS, tileDef, glyphFor, createTile }
 */
(function () {
  'use strict';

  var TILE_DEFS = {
    finder: { glyph: 'folder', label: 'Finder' },
    browser: { glyph: 'globe', label: '브라우저' },
    excel: { glyph: 'table', label: 'Excel' },
    hangul: { glyph: 'file-text', label: '한글 2020' },
    powerpoint: { glyph: 'presentation', label: 'PowerPoint' },
    pdf: { glyph: 'file-text', label: 'PDF' },
    memo: { glyph: 'notebook-pen', label: '메모' },
    schedule: { glyph: 'calendar', label: '일정' },
    todo: { glyph: 'list-checks', label: '할 일' },
    chat: { glyph: 'message-circle', label: 'AI 채팅' },
    studio: { glyph: 'sparkles', label: 'AI 스튜디오' },
    backup: { glyph: 'archive', label: '백업' },
    mission: { glyph: 'layout-grid', label: '미션 컨트롤' },
    settings: { glyph: 'settings', label: '설정' },
    trash: { glyph: 'trash-2', label: '휴지통' },
  };

  /**
   * 동적 모듈(스튜디오 앱)의 글리프는 state.js MODULES가 소유한다.
   * 로드 순서에 의존하지 않도록 노출 시점에 lazy로 조회한다.
   */
  function dynamicModule(id) {
    var state = null;
    if (typeof window !== 'undefined' && window.MyHubDesktopState) state = window.MyHubDesktopState;
    else if (typeof globalThis !== 'undefined' && globalThis.MyHubDesktopState) state = globalThis.MyHubDesktopState;
    var mods = state && Array.isArray(state.MODULES) ? state.MODULES : [];
    for (var i = 0; i < mods.length; i++) {
      if (mods[i] && mods[i].id === id) return mods[i];
    }
    return null;
  }

  function tileDef(id) {
    if (TILE_DEFS[id]) return TILE_DEFS[id];
    var mod = dynamicModule(id);
    if (mod) return { glyph: mod.glyph || 'layout-grid', label: mod.title || id };
    return { glyph: 'layout-grid', label: id };
  }

  function glyphFor(id) {
    return tileDef(id).glyph;
  }

  /**
   * 동적으로 만든 타일의 <i data-lucide>를 실제 SVG로 바꾼다.
   * lucide.createIcons는 호출 시점의 DOM에 있는 것만 처리하므로, 타일을
   * 동적으로 추가한 직후 렌더 직후 반드시 불러야 한다 앱 이 호출이 없으면
   * 바탕화면 아이콘이 빈 타일로만 보이게 되고 있었다 (2026-11-01).
   */
  function refreshIcons() {
    try {
      if (typeof window !== 'undefined' && window.lucide) window.lucide.createIcons();
    } catch (e) {
      console.warn('데스크톱 아이콘 새로고침 실패:', e);
    }
  }

  // 오피스 앱 4종 + Finder의 뒷 앱 글리프가 아니라 실제 앱 아이콘
  // 같은 블롭을 타일(file-icons.js appTileFor)로 그린다 (사용자 지시
  // 2026-11-02~03). file-icons가 없으면 앱 TILE_DEFS의 Lucide 글리프로
  // 대체한다.
  var SVG_TILE_KINDS = { excel: 'excel', hangul: 'hangul', powerpoint: 'powerpoint', pdf: 'pdf', finder: 'finder', chat: 'chat', settings: 'settings', memo: 'memo', todo: 'todo', schedule: 'schedule', trash: 'trash', browser: 'browser', studio: 'studio' };

  function fileIconsApi() {
    if (typeof window !== 'undefined' && window.MyHubFileIcons) return window.MyHubFileIcons;
    if (typeof globalThis !== 'undefined' && globalThis.MyHubFileIcons) return globalThis.MyHubFileIcons;
    return null;
  }

  /** 타일 요소 1개를 만든다. 여기서는 CSS/호출측 스타일이 정한다. */
  function createTile(doc, id) {
    var def = tileDef(id);
    var tile = doc.createElement('span');
    tile.className = 'dt-tile dt-tile-' + id;
    tile.setAttribute('aria-hidden', 'true');
    var icons = SVG_TILE_KINDS[id] ? fileIconsApi() : null;
    if (icons) {
      tile.classList.add('dt-tile-svg');
      // 실행 타일은 문서의 파일 아이콘이 아니라 앱 타일형(appTileFor)
      // 으로 그린다 앱 파일은 파일답게, 앱은 앱답게 (2026-11-03 확정).
      // appTileFor가 없는 구 모듈이면 문서형으로 대체한다.
      tile.innerHTML =
        typeof icons.appTileFor === 'function'
          ? icons.appTileFor(SVG_TILE_KINDS[id])
          : icons.svgFor(SVG_TILE_KINDS[id]);
    } else {
      tile.innerHTML = '<i data-lucide="' + def.glyph + '"></i>';
    }
    return tile;
  }

  var api = {
    TILE_DEFS: TILE_DEFS,
    tileDef: tileDef,
    glyphFor: glyphFor,
    createTile: createTile,
    refreshIcons: refreshIcons,
  };
  if (typeof window !== 'undefined') window.MyHubDesktopTiles = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopTiles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
