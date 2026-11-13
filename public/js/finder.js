/* MyHub 파인더 (finder.js)
 *
 * iPhone '파일' 앱 같은 저장소 관리자 웹 페이지가 아니다 실제 보관함이다.
 * - 보관함(/api/drive): 폴더를 만들고 들어가고, 이름 바꾸고, 파일을
 *   올리고(작업·PDF한글· 이미지 등 무관), 놓고, 내보내기에 보낸다.
 * - 휴지통: 폴더째·파일째 복원하거나 영구 삭제한다 (폴더와 함께
 *   지워진 파일은 폴더부터 복원해야 한다).
 * - 메모·일정 같은 앱 데이터는 각 앱이 담당한다 — 여기는 순수 저장소.
 * - 검색은 자체 검색 입력(#finderQ)이 담당한다. 상단바에 창 제목과
 *   컨트롤과 중복되는 검색 요소를 넣지 않는다 (메모와 같은 규칙).
 * 노출: window.MyHubFinder = { normalizeFolder, normalizeFile,
 *        fmtDate, fmtSize, createApp }
 */
(function () {
  'use strict';

  function fmtDate(v) {
    if (!v) return '';
    return String(v).replace('T', ' ').slice(0, 16);
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, '') + 'KB';
    return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'MB';
  }

  /** 맥 Finder의 한국어 날짜: "2021. 4. 2. 오후 1:24" */
  function fmtDateKo(v) {
    if (!v) return '';
    var d = new Date(String(v).replace(' ', 'T'));
    if (isNaN(d.getTime())) return fmtDate(v);
    try {
      return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      }).format(d);
    } catch (e) {
      return fmtDate(v);
    }
  }

  /** 맥 Finder '종류' 열의 한국어 라벨 (확장자 우선, MIME 폴백). */
  function kindLabelFor(name, mime) {
    var ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    ext = ext ? ext[1] : '';
    var byExt = {
      jpg: 'JPEG 이미지', jpeg: 'JPEG 이미지', png: 'PNG 이미지', gif: 'GIF 이미지',
      webp: 'WebP 이미지', svg: 'SVG 이미지', heic: 'HEIF 이미지', bmp: 'BMP 이미지',
      pdf: 'PDF 문서', hwp: '한글 문서', hwpx: '한글 문서',
      xls: '스프레드시트', xlsx: '스프레드시트', csv: 'CSV',
      ppt: '프레젠테이션', pptx: '프레젠테이션',
      doc: 'Word 문서', docx: 'Word 문서',
      txt: '텍스트', md: '마크다운 문서', zip: 'ZIP 압축 파일',
      mp3: '오디오', wav: '오디오', m4a: '오디오', mp4: '비디오', mov: '비디오',
      json: 'JSON', js: 'JavaScript', html: 'HTML 문서',
    };
    if (byExt[ext]) return byExt[ext];
    mime = String(mime || '');
    if (mime.indexOf('image/') === 0) return '이미지';
    if (mime.indexOf('audio/') === 0) return '오디오';
    if (mime.indexOf('video/') === 0) return '비디오';
    if (mime.indexOf('text/') === 0) return '텍스트';
    if (ext) return ext.toUpperCase() + ' 파일';
    return '파일';
  }

  // 파일 아이콘 규칙은 file-icons.js(kindFor)가 단일 진실이다 (MIME
  // 우선 + 확장자 폴백 통합). 모듈이 없을 때만 아래 이름 폴백을 쓴다 —
  // 그 경우 옛 아이콘은 종전 Lucide 글리프로 강등한다.
  var KIND_GLYPH = {
    folder: 'folder', image: 'image', audio: 'file-audio', video: 'file-video',
    excel: 'file-spreadsheet', csv: 'file-spreadsheet', pdf: 'file-text',
    hangul: 'file-text', powerpoint: 'file-text', word: 'file-text',
    text: 'file-text', archive: 'file', code: 'file', file: 'file',
  };

  function fileIconsApi() {
    if (typeof window !== 'undefined' && window.MyHubFileIcons) return window.MyHubFileIcons;
    if (typeof globalThis !== 'undefined' && globalThis.MyHubFileIcons) return globalThis.MyHubFileIcons;
    return null;
  }

  function legacyKindFor(name, mime) {
    mime = String(mime || '');
    if (mime.indexOf('image/') === 0) return 'image';
    if (mime.indexOf('audio/') === 0) return 'audio';
    if (mime.indexOf('video/') === 0) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.indexOf('spreadsheet') >= 0 || mime.indexOf('ms-excel') >= 0) return 'excel';
    var ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    ext = ext ? ext[1] : '';
    if (['xls', 'xlsx'].indexOf(ext) >= 0) return 'excel';
    if (ext === 'csv') return 'csv';
    if (['hwp', 'hwpx'].indexOf(ext) >= 0) return 'hangul';
    if (['ppt', 'pptx'].indexOf(ext) >= 0) return 'powerpoint';
    if (['doc', 'docx'].indexOf(ext) >= 0) return 'word';
    if (ext === 'pdf') return 'pdf';
    return 'file';
  }

  function kindForFile(name, mime) {
    var icons = fileIconsApi();
    return icons ? icons.kindFor({ name: name, mime: mime }) : legacyKindFor(name, mime);
  }

  /** 앱 아이콘 두 내용: 브랜드 SVG가 본선, 없으면 Lucide 글리프. */
  function rowIconHtml(row) {
    var icons = fileIconsApi();
    if (icons && row.kind2) return icons.svgFor(row.kind2);
    return '<i data-lucide="' + row.icon + '"></i>';
  }

  function normalizeFolder(r) {
    return {
      key: 'folder-' + r.id,
      kind: 'folder',
      kind2: 'folder',
      folderId: r.id,
      name: r.name || '이름 없음',
      date: r.created_at || '',
      size: null,
      kindLabel: '폴더',
      icon: 'folder',
      meta: '폴더',
    };
  }

  function normalizeFile(r) {
    var kind2 = kindForFile(r.filename, r.mime);
    return {
      key: 'file-' + r.id,
      kind: 'file',
      kind2: kind2,
      fileId: r.id,
      folderId: r.folder_id === undefined ? null : r.folder_id,
      folderName: r.folder_name || null,
      mime: r.mime || '',
      // 뷰어 저장 시 base_version으로 보낸 현재 버전 식별 (3A 계약)
      version: r.version || null,
      name: r.filename || '이름 없음',
      date: r.created_at || '',
      size: Number(r.size) || 0,
      kindLabel: kindLabelFor(r.filename, r.mime),
      icon: KIND_GLYPH[kind2] || 'file',
      meta: fmtSize(r.size),
    };
  }

  function normalizeTrashFolder(r) {
    var row = normalizeFolder(r);
    row.key = 'tfolder-' + r.id;
    row.kind = 'tfolder';
    row.date = r.deleted_at || row.date;
    row.meta = '폴더 · 삭제 ' + fmtDate(r.deleted_at);
    return row;
  }

  function normalizeTrashFile(r) {
    var row = normalizeFile(r);
    row.key = 'tfile-' + r.id;
    row.kind = 'tfile';
    row.viaFolder = !!r.via_folder;
    row.date = r.deleted_at || row.date;
    row.meta = row.viaFolder
      ? '폴더와 함께 휴지통에 있음'
      : fmtSize(r.size) + ' · 삭제 ' + fmtDate(r.deleted_at);
    return row;
  }

  /** 바탕화면 아이콘 휴지통 항목 (데스크톱과 공유하는 localStorage 목록). */
  function normalizeIconTrash(entry) {
    return {
      key: 'icon-' + (entry.kind || 'icon') + '-' + entry.id,
      kind: 'icontrash',
      name: entry.label || entry.id,
      icon: 'app-window',
      kindLabel: '바탕화면 아이콘',
      kind2: null,
      date: entry.at ? new Date(entry.at).toISOString() : '',
      size: null,
      entry: { kind: entry.kind || 'icon', id: entry.id, label: entry.label || entry.id, at: entry.at || 0 },
    };
  }

  /**
   * ?folder=<id>&file=<id> (+선택 name/mime) 과 openFileTarget 입력.
   * 데스크톱 파일 아이콘쪽에서 바탕화면에서 특정 파일을 두 번 누르는 진입은
   * 놓고, postMessage 경로와 같은 모양으로 내린다. 숫자가 아니면 null.
   */
  function parseOpenTarget(search) {
    var params;
    try {
      params = new URLSearchParams(String(search || ''));
    } catch (e) {
      return null;
    }
    var folderId = Number(params.get('folder'));
    var fileId = Number(params.get('file'));
    if (!Number.isInteger(fileId) || fileId <= 0) return null;
    return {
      folderId: Number.isInteger(folderId) && folderId > 0 ? folderId : null,
      folderName: params.get('folderName') || '',
      fileId: fileId,
      name: params.get('name') || '',
      mime: params.get('mime') || '',
    };
  }

  // 오피스 파일은 Finder 안의 뷰어로 열고 전용 앱 에서 실행한다
  // (사용자 지시 2026-11-03: "여기에서 실행했으면"). 확장자 등 오피스
  // 앱 종류 매핑은 그 경계다. 전용 앱이 없는 형식(이미지·텍스트·
  // docx 등)은 null이라 종전대로 내 뷰어가 맡는다.
  var OFFICE_APP_BY_EXT = {
    xlsx: 'excel', xls: 'excel', csv: 'excel',
    hwp: 'hangul', hwpx: 'hangul',
    pptx: 'powerpoint', ppt: 'powerpoint',
    pdf: 'pdf',
  };
  function officeAppFor(row) {
    var name = String((row && row.name) || '');
    var dot = name.lastIndexOf('.');
    if (dot < 0) return null;
    return OFFICE_APP_BY_EXT[name.slice(dot + 1).toLowerCase()] || null;
  }

  /**
   * deps = { doc, fetchFn, openUrl, promptFn, confirmFn, prefetchEngines }
   * prefetchEngines(engines): 목록에 해당 확장자 파일이 보일 때 붙임
   * 코드가 엔진 자산을 프리패치를 시작할 때 거꾸로 불러 선택 이다.
   * 엔진 이름은 'gridcraft'|'deckcraft'이며, 같은 엔진은 두 번만 출력
   * 한 번만 부른다. 목록만 있었는데 전체 파일이 없으면 부르지 않는다.
   * doc에서 #finderList/#finderStatus/#finderTitle/#finderUploadBtn/
   * #finderNewFolderBtn/#finderFileInput/#finderPath/[data-view]/
   * #countDrive/#countTrash/#navQ/#finderQ를 찾는다 (없는 요소는 건너뜀).
   */
  function createApp(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var fetchFn =
      deps.fetchFn ||
      function (url, opts) {
        return fetch(url, opts);
      };
    var openUrl =
      typeof deps.openUrl === 'function'
        ? deps.openUrl
        : function (url) {
            window.open(url, '_blank');
          };
    var viewer = deps.viewer || null;
    var promptFn =
      typeof deps.promptFn === 'function'
        ? deps.promptFn
        : function (msg, def) {
            return window.prompt(msg, def);
          };
    var listEl = doc.getElementById('finderList');
    var statusEl = doc.getElementById('finderStatus');
    var selStatusEl = doc.getElementById('finderSelStatus');
    var titleEl = doc.getElementById('finderTitle');
    var uploadBtn = doc.getElementById('finderUploadBtn');
    var newFolderBtn = doc.getElementById('finderNewFolderBtn');
    var fileInput = doc.getElementById('finderFileInput');
    var pathEl = doc.getElementById('finderPath');
    var headEl = doc.getElementById('finderHead');
    var backBtn = doc.getElementById('finderBack');
    var fwdBtn = doc.getElementById('finderFwd');
    var modeListBtn = doc.getElementById('finderModeList');
    var modeGridBtn = doc.getElementById('finderModeGrid');
    var sortBtn = doc.getElementById('finderSortBtn');
    var sideFavoritesEl = doc.getElementById('sideFavorites');
    var sideUsageEl = doc.getElementById('sideUsage');
    var sideDesktopBtn = doc.getElementById('sideDesktop');
    var sideDocsBtn = doc.getElementById('sideDocs');
    var sideDownloadsBtn = doc.getElementById('sideDownloads');
    var confirmFn =
      typeof deps.confirmFn === 'function'
        ? deps.confirmFn
        : function (msg) {
            return window.confirm(msg);
          };
    var storage =
      deps.storage ||
      (typeof window !== 'undefined' ? window.localStorage : null);
    // 데스크톱 부모 창으로 위하는 알림 (앱 휴지통 연동). 단품 페이지면
    // 부모가 없어 아무 시도도 하지 않는다.
    var postToParent =
      typeof deps.postToParent === 'function'
        ? deps.postToParent
        : function (msg) {
            try {
              if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
                window.parent.postMessage(msg, window.location.origin);
              }
            } catch (e) {
              console.warn('부모 창 알림 실패:', e);
            }
          };
    // ---- 즐겨찾기 (사용자 폴더 등 localStorage에 {id, name}으로 유지) ----
    var FAV_KEY = 'myhub.finder.favorites.v1';
    // 바탕화면 아이콘 휴지통은 데스크톱(windows.js)과 같은 키를 공유한다
    var ICON_TRASH_KEY = 'myhub.desktop.trash.v1';
    function readStoredList(key) {
      try {
        var parsed = JSON.parse(storage ? storage.getItem(key) || 'null' : 'null');
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        console.warn('즐겨찾기 목록 읽기 실패:', e);
        return [];
      }
    }
    function loadFavorites() {
      return readStoredList(FAV_KEY)
        .filter(function (f) {
          return f && f.id !== null && f.id !== undefined;
        })
        .map(function (f) {
          return { id: f.id, name: String(f.name || '폴더') };
        });
    }
    function saveFavorites() {
      try {
        if (storage) storage.setItem(FAV_KEY, JSON.stringify(state.favorites));
      } catch (e) {
        console.warn('즐겨찾기 저장 실패:', e);
      }
    }
    function isFavorite(id) {
      return state.favorites.some(function (f) {
        return f.id === id;
      });
    }
    function toggleFavorite(folder) {
      if (isFavorite(folder.id)) {
        state.favorites = state.favorites.filter(function (f) {
          return f.id !== folder.id;
        });
        state.actionMsg = '즐겨찾기에서 제거했습니다';
      } else {
        state.favorites.push({ id: folder.id, name: folder.name });
        state.actionMsg = '즐겨찾기에 추가했습니다';
      }
      saveFavorites();
      render();
    }
    function readIconTrash() {
      return readStoredList(ICON_TRASH_KEY)
        .filter(function (en) {
          return en && en.id;
        })
        .map(function (en) {
          return { kind: en.kind || 'icon', id: en.id, label: en.label || en.id, at: en.at || 0 };
        });
    }

    // 응용 프로그램 보관함은 단독 실행 폴백 카탈로그 (데스크톱 state.js
    // MODULES와 같은 값 — 앱 식별에 부모가 실제 카탈로그를
    // myhub:apps로 내려주므로 이 목록은 단독 페이지 전용이다).
    var FALLBACK_APPS = [
      { id: 'browser', title: '브라우저', url: '/browser.html', glyph: 'globe' },
      { id: 'memo', title: '메모', url: '/memo.html', glyph: 'notebook-pen' },
      { id: 'schedule', title: '일정', url: '/schedule.html', glyph: 'calendar' },
      { id: 'todo', title: '할 일', url: '/todo.html', glyph: 'list-checks' },
      { id: 'chat', title: 'AI 채팅', url: '/chat.html', glyph: 'message-circle' },
      { id: 'studio', title: 'AI 스튜디오', url: '/agent.html', glyph: 'sparkles' },
      { id: 'backup', title: '백업', url: '/backup.html', glyph: 'archive' },
      { id: 'excel', title: 'Excel', url: '/office.html?app=excel', glyph: 'table' },
      { id: 'hangul', title: '한글 2020', url: '/office.html?app=hangul', glyph: 'file-text' },
      { id: 'powerpoint', title: 'PowerPoint', url: '/office.html?app=powerpoint', glyph: 'presentation' },
      { id: 'pdf', title: 'PDF', url: '/office.html?app=pdf', glyph: 'file-text' },
    ];
    // file-icons의 브랜드 타일이 있는 앱 (tiles.js SVG_TILE_KINDS와 동일)
    var APP_TILE_KINDS = {
      excel: 'excel', hangul: 'hangul', powerpoint: 'powerpoint', pdf: 'pdf',
      chat: 'chat', memo: 'memo', todo: 'todo', schedule: 'schedule',
      browser: 'browser', studio: 'studio',
    };

    var state = {
      view: 'drive',
      stack: [{ id: null, name: '보관함' }],
      listing: null,
      trashData: null,
      recentFiles: null,
      appsCatalog: null,
      appsRequested: false,
      sysFoldersEnsured: false,
      favorites: loadFavorites(),
      usage: null,
      iconTrash: readIconTrash(),
      loadError: false,
      filter: '',
      // 전역 검색 상태 (null = 검색 모드 아님). 검색어가 있으면 현재
      // 폴더 필터가 아닌 보관함 전체 검색 결과를 보여준다.
      search: null,
      selectedKey: null,
      selected: {},
      lastSelIndex: -1,
      sortKey: 'name',
      sortDir: 1,
      mode: 'list',
      history: [],
      hIndex: -1,
      rootFolders: null,
      actionMsg: '',
      armedKey: null,
      armTimer: null,
    };

    function refreshIcons() {
      try {
        if (typeof window !== 'undefined' && window.lucide) window.lucide.createIcons();
      } catch (e) {
        console.warn('파인더 아이콘 새로고침 실패:', e);
      }
    }

    function currentFolder() {
      return state.stack[state.stack.length - 1];
    }

    // 폴더 표기 통일 (사용자 지시 2026-11-06): 데스크톱 폴더의 설명
    // (데이터)는 '바탕화면'이지만 표기는 macOS 한국어 표기인
    // '데스크톱'으로 두 표면(사이드바·창 제목·경로 바·하위폴더 소속
    // 폴더)에서 하나로 통일한다. 설명 기본 동작(검색·이름변경·삭제)은
    // 두 함수를 거치지 않는다.
    function displayFolderName(name) {
      return name === '바탕화면' ? '데스크톱' : name;
    }

    function setCount(id, n) {
      var el = doc.getElementById(id);
      if (el) el.textContent = n === null || n === undefined ? '' : String(n);
    }

    // ---- 선택 (맥 방식: 클릭 선택, 더블클릭 열기, ⌘/Ctrl 토글, Shift 범위) ----
    function selectedRows(rows) {
      return (rows || []).filter(function (r) {
        return state.selected[r.key];
      });
    }
    function clearSelection() {
      state.selected = {};
      state.selectedKey = null;
      state.lastSelIndex = -1;
    }
    function selectRow(row, rows, ev) {
      var idx = rows.indexOf(row);
      if (ev && (ev.metaKey || ev.ctrlKey)) {
        if (state.selected[row.key]) delete state.selected[row.key];
        else state.selected[row.key] = true;
        state.lastSelIndex = idx;
      } else if (ev && ev.shiftKey && state.lastSelIndex >= 0) {
        var a = Math.min(state.lastSelIndex, idx);
        var b = Math.max(state.lastSelIndex, idx);
        state.selected = {};
        for (var i = a; i <= b; i++) state.selected[rows[i].key] = true;
      } else {
        state.selected = {};
        state.selected[row.key] = true;
        state.lastSelIndex = idx;
      }
      state.selectedKey = row.key;
    }

    // ---- 날짜 그룹 (맥 Finder 목록의 기간 묶음) ----
    // 앱 날짜('YYYY-MM-DD HH:mm:ss', 로컬)를 오늘 기준 버킷으로:
    // 오늘 / 어제 / 이전 7일 / 이전 30일 / 그보다 전 연 단위.
    function dateGroupLabel(dateStr) {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
      if (!m) return '날짜 없음';
      var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      var now = new Date();
      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
      if (diffDays <= 0) return '오늘';
      if (diffDays === 1) return '어제';
      if (diffDays <= 7) return '이전 7일';
      if (diffDays <= 30) return '이전 30일';
      if (day.getFullYear() === now.getFullYear()) return day.getMonth() + 1 + '월';
      return day.getFullYear() + '년 ' + (day.getMonth() + 1) + '월';
    }

    // ---- 정렬 (폴더 먼저, 그 안에선 기준 비교) ----
    function sortedRows(rows) {
      var dir = state.sortDir;
      var key = state.sortKey;
      function rank(r) {
        return r.kind === 'folder' || r.kind === 'tfolder' ? 0 : 1;
      }
      function val(r) {
        if (key === 'date') return r.date || '';
        if (key === 'size') return r.size === null || r.size === undefined ? -1 : r.size;
        if (key === 'kind') return r.kindLabel || '';
        return r.name || '';
      }
      return rows.slice().sort(function (x, y) {
        // 날짜 정렬은 맥 Finder처럼 폴더·파일을 앞에 날짜만으로 두
        // 날짜 그룹 헤더가 두 순서 앞에 붙는다.
        if (key !== 'date') {
          var rk = rank(x) - rank(y);
          if (rk) return rk;
        }
        var a = val(x);
        var b = val(y);
        var c =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b), 'ko');
        return c * dir;
      });
    }

    // ---- 이동 히스토리 (뒤로/앞으로) ----
    function stackSnapshot() {
      return state.stack.map(function (s) {
        return { id: s.id, name: s.name };
      });
    }
    function pushHistory() {
      state.history = state.history.slice(0, state.hIndex + 1);
      state.history.push(stackSnapshot());
      if (state.history.length > 50) state.history.shift();
      state.hIndex = state.history.length - 1;
    }
    function applyHistory() {
      var snap = state.history[state.hIndex];
      if (!snap) return;
      exitSearchMode();
      state.stack = snap.map(function (s) {
        return { id: s.id, name: s.name };
      });
      clearSelection();
      state.actionMsg = '';
      if (state.view !== 'drive') setViewSilent('drive');
      loadDrive();
    }
    function setViewSilent(view) {
      state.view = view;
      syncSidebarActive();
    }
    function goBack() {
      if (state.hIndex <= 0) return;
      state.hIndex -= 1;
      applyHistory();
    }
    function goFwd() {
      if (state.hIndex >= state.history.length - 1) return;
      state.hIndex += 1;
      applyHistory();
    }
    function navigateTo(stack) {
      exitSearchMode();
      state.stack = stack;
      clearSelection();
      state.actionMsg = '';
      if (state.view !== 'drive') setViewSilent('drive');
      pushHistory();
      loadDrive();
    }

    // ---- 컨텍스트 메뉴 (맥 Finder 스타일, finder 전용 격벽 구현) ----
    var ctxEl = null;
    function closeCtxMenu() {
      if (ctxEl && ctxEl.parentNode) ctxEl.parentNode.removeChild(ctxEl);
      ctxEl = null;
    }
    function openCtxMenu(x, y, items) {
      closeCtxMenu();
      var menu = doc.createElement('div');
      menu.className = 'finder-ctx';
      menu.setAttribute('role', 'menu');
      items.forEach(function (it) {
        if (it.sep) {
          var s = doc.createElement('div');
          s.className = 'finder-ctx-sep';
          menu.appendChild(s);
          return;
        }
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'finder-ctx-item' + (it.danger ? ' is-danger' : '');
        if (it.disabled) b.disabled = true;
        var label = doc.createElement('span');
        label.textContent = it.label;
        b.appendChild(label);
        if (it.checked) {
          var chk = doc.createElement('span');
          chk.className = 'finder-ctx-check';
          chk.textContent = '✓';
          b.appendChild(chk);
        }
        b.addEventListener('click', function () {
          closeCtxMenu();
          if (it.onSelect) it.onSelect();
        });
        menu.appendChild(b);
      });
      doc.body.appendChild(menu);
      var mw = menu.offsetWidth || 220;
      var mh = menu.offsetHeight || 200;
      var vw = doc.documentElement.clientWidth || 1024;
      var vh = doc.documentElement.clientHeight || 768;
      menu.style.left = Math.max(4, Math.min(x, vw - mw - 6)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, vh - mh - 6)) + 'px';
      ctxEl = menu;
      refreshIcons();
      return menu;
    }
    doc.addEventListener('pointerdown', function (e) {
      if (ctxEl && e.target !== ctxEl && !ctxEl.contains(e.target)) closeCtxMenu();
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCtxMenu();
    });

    // 전역 검색 결과 행: 일반 행 정규화에 소속 경로를 붙인다.
    // 경로를 클릭 시 그 위치로 이동(폴더열기)하는 별도 요인.
    function normalizeSearchFolder(r) {
      var row = normalizeFolder(r);
      row.path = r.path || [];
      row.pathLabel = pathLabelOf(row.path);
      return row;
    }
    function normalizeSearchFile(r) {
      var row = normalizeFile(r);
      row.path = r.path || [];
      row.pathLabel = pathLabelOf(row.path);
      if (!row.folderName && row.path.length) row.folderName = row.path[row.path.length - 1].name;
      return row;
    }
    function pathLabelOf(path) {
      var names = ['보관함'];
      (path || []).forEach(function (s) {
        names.push(displayFolderName(s.name));
      });
      return names.join(' · ');
    }

    function currentRows() {
      if (state.search) {
        if (state.search.loading || state.search.error) return [];
        return state.search.folders.map(normalizeSearchFolder)
          .concat(state.search.files.map(normalizeSearchFile));
      }
      if (state.view === 'trash') {
        if (!state.trashData) return null;
        var t = state.trashData.folders.map(normalizeTrashFolder);
        return t
          .concat(state.trashData.files.map(normalizeTrashFile))
          .concat(state.iconTrash.map(normalizeIconTrash));
      }
      if (state.view === 'recent') {
        if (!state.recentFiles) return null;
        return state.recentFiles.map(normalizeFile);
      }
      if (!state.listing) return null;
      var d = state.listing.folders.map(normalizeFolder);
      return d.concat(state.listing.files.map(normalizeFile));
    }

    function visibleRows(all) {
      // 전역 검색 결과는 서버가 내 매칭한 목록이라 다시 거르지 않는다
      if (state.search) return all;
      var q = state.filter.trim().toLowerCase();
      if (!q) return all;
      return all.filter(function (r) {
        return r.name.toLowerCase().indexOf(q) >= 0;
      });
    }

    function actButton(icon, act, label) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'finder-act';
      b.dataset.act = act;
      b.setAttribute('aria-label', label);
      b.innerHTML = '<i data-lucide="' + icon + '"></i>';
      return b;
    }

    function buildRow(row, rows) {
      var el = doc.createElement('div');
      el.className = 'finder-row' + (state.selected[row.key] ? ' is-selected' : '');
      el.dataset.key = row.key;
      el.dataset.kind = row.kind;
      if (row.kind === 'folder' || row.kind === 'tfolder') el.dataset.folderId = String(row.folderId);
      // 폴더 행은 드래그 이동의 목적지·놓기 가 된다
      if (row.kind === 'folder') {
        el.dataset.moveTarget = String(row.folderId);
        el.dataset.moveName = row.name;
      }
      // 파일·폴더 행은 파일이 폴더를 뽑아 둘 수 있다 (휴지통 행은 제외)
      if (row.kind === 'folder' || row.kind === 'file') {
        el.draggable = true;
        el.addEventListener('dragstart', function (ev) {
          onRowDragStart(ev, row, rows);
        });
        el.addEventListener('dragend', function () {
          onRowDragEnd();
        });
      }
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      var main = doc.createElement('span');
      main.className = 'finder-row-main';
      var ic = doc.createElement('span');
      ic.className = 'finder-row-icon';
      ic.innerHTML = rowIconHtml(row);
      main.appendChild(ic);
      var name = doc.createElement('span');
      name.className = 'finder-row-name';
      name.textContent = row.kind === 'folder' ? displayFolderName(row.name) : row.name;
      main.appendChild(name);
      // 전역 검색 결과 행은 소속 경로를 이름 아래에 보여준다
      if (row.pathLabel) {
        var path = doc.createElement('span');
        path.className = 'finder-row-path';
        path.textContent = row.pathLabel;
        main.appendChild(path);
      }
      el.appendChild(main);
      var date = doc.createElement('span');
      date.className = 'finder-cell finder-cell-date';
      date.textContent = row.date ? fmtDateKo(row.date) : '';
      el.appendChild(date);
      var size = doc.createElement('span');
      size.className = 'finder-cell finder-cell-size';
      size.textContent = row.size === null || row.size === undefined ? '--' : fmtSize(row.size);
      el.appendChild(size);
      var kind = doc.createElement('span');
      kind.className = 'finder-cell finder-cell-kind';
      kind.textContent = row.kindLabel || '';
      el.appendChild(kind);

      // 호버 액션 버튼은 폴더·파일 행에 넣지 않는다 (사용자 지시
      // 2026-11-06, image-121): 우클릭 메뉴와 중복되고 행을 지저분
      // 하게 만들던 그 두 동작을 우클릭 메뉴(openRowMenu)가 제공
      // 한다. 휴지통 행만 예외로 남긴다: 영구 삭제는 2단계 확인
      // 라벨("정말 삭제")을 버튼 자체로 놓고, 메뉴의 영구 삭제와
      // 같은 armed 상태를 거치므로 버튼을 빼면 확인 단계가 화면에
      // 보이지 않게 된다.
      if (
        row.kind === 'tfolder' ||
        row.kind === 'tfile' ||
        row.kind === 'icontrash'
      ) {
        var actions = doc.createElement('span');
        actions.className = 'finder-row-actions';
        function stop(fn) {
          return function (ev) {
            ev.stopPropagation();
            fn();
          };
        }
        function addAct(icon, act, label, fn) {
          var b = actButton(icon, act, label);
          b.addEventListener('click', stop(fn));
          actions.appendChild(b);
          return b;
        }
        if (row.kind === 'icontrash') {
          addAct('undo-2', 'restore', '복원', function () { restoreIconTrash(row); });
          var ipurge = actButton('trash-2', 'purge', '영구 삭제');
          if (state.armedKey === row.key) {
            ipurge.classList.add('is-armed');
            ipurge.innerHTML = '<span>정말 삭제</span>';
          }
          ipurge.addEventListener('click', stop(function () { purgeIconTrash(row); }));
          actions.appendChild(ipurge);
        } else {
          if (!row.viaFolder) {
            addAct('undo-2', 'restore', '복원', function () { restoreItem(row); });
          }
          var purge = actButton('trash-2', 'purge', '영구 삭제');
          if (state.armedKey === row.key) {
            purge.classList.add('is-armed');
            purge.innerHTML = '<span>정말 삭제</span>';
          }
          purge.addEventListener('click', stop(function () { purgeItem(row); }));
          actions.appendChild(purge);
        }
        el.appendChild(actions);
      }

      el.addEventListener('click', function (ev) {
        // 검색 결과는 일반 클릭은 그 항목이 있는 폴더로 이동해
        // 선택 상태로 보여준다 (수정된 클릭은 종전대로 다시 선택)
        if (
          state.search && row.path &&
          !(ev.metaKey || ev.ctrlKey || ev.shiftKey)
        ) {
          revealSearchRow(row);
          return;
        }
        selectRow(row, rows, ev);
        render();
      });
      el.addEventListener('dblclick', function () {
        openRow(row);
      });
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') openRow(row);
      });
      el.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (!state.selected[row.key]) {
          state.selected = {};
          state.selected[row.key] = true;
          state.selectedKey = row.key;
          render();
        }
        openRowMenu(row, rows, ev.clientX, ev.clientY);
      });
      return el;
    }

    function openRow(row) {
      if (row.kind === 'folder') {
        // 검색 결과 폴더는 현재 스택이 아닌 결과의 전체 경로로 진입
        if (state.search && row.path) {
          navigateTo(stackFromPath(row.path).concat([{ id: row.folderId, name: row.name }]));
          return;
        }
        descend(row);
      }
      else if (row.kind === 'file') openFile(row);
    }

    /** 선택한 행들(또는 지정한 행)을 한 번에 휴지통으로 보내고 reload는 한 번만. */
    function trashRows(targets) {
      var jobs = targets.map(function (row) {
        var url =
          row.kind === 'folder'
            ? '/api/drive/folders/' + row.folderId + '/trash'
            : '/api/drive/files/' + row.fileId + '/trash';
        return callApi(url, { method: 'POST' }).catch(function () {
          return null;
        });
      });
      return Promise.all(jobs).then(function () {
        state.trashData = null;
        clearSelection();
        state.actionMsg = '휴지통으로 보냈습니다';
        return reloadListing();
      });
    }

    function openRowMenu(row, rows, x, y) {
      var items = [];
      var sel = selectedRows(rows);
      var targets = sel.length > 1 && state.selected[row.key] ? sel : [row];
      if (row.kind === 'icontrash') {
        items.push({
          label: '복원',
          onSelect: function () { restoreIconTrash(row); },
        });
        items.push({
          label: '영구 삭제',
          danger: true,
          onSelect: function () { purgeIconTrashNow(row); },
        });
      } else if (state.view === 'trash') {
        if (!row.viaFolder) {
          items.push({
            label: '복원',
            onSelect: function () { restoreItem(row); },
          });
        }
        items.push({
          label: '영구 삭제',
          danger: true,
          onSelect: function () { purgeItem(row); },
        });
      } else if (row.kind === 'folder') {
        items.push({ label: '열기', onSelect: function () { descend(row); } });
        items.push({ label: '이름 변경…', onSelect: function () { renameFolder(row); } });
        items.push({
          label: isFavorite(row.folderId) ? '즐겨찾기에서 제거' : '즐겨찾기 추가',
          onSelect: function () {
            toggleFavorite({ id: row.folderId, name: row.name });
          },
        });
        items.push({ sep: true });
        items.push({
          label: '휴지통으로 이동',
          danger: true,
          onSelect: function () { trashRows(targets.filter(function (r) { return r.kind === 'folder' || r.kind === 'file'; })); },
        });
      } else if (row.kind === 'file') {
        items.push({ label: '열기', onSelect: function () { openFile(row); } });
        items.push({
          label: '다운로드',
          onSelect: function () { openUrl('/api/drive/files/' + row.fileId); },
        });
        // 이름 변경·휴지통 이동은 모든 뷰(최근 항목·검색 포함)에서
        // 제공한다 — 두 호버 버튼 제거(2026-11-06)는 전제로, 메뉴가
        // 동일한 경로가 될 때까지 뷰 조건으로 빠지면 기능이 사라진다.
        items.push({ label: '이름 변경…', onSelect: function () { renameFile(row); } });
        if (state.view === 'recent' && row.folderId) {
          items.push({
            label: '폴더로 이동',
            onSelect: function () {
              navigateTo([
                { id: null, name: '보관함' },
                { id: row.folderId, name: row.folderName || '폴더' },
              ]);
            },
          });
        }
        items.push({ sep: true });
        items.push({
          label: targets.length > 1 ? '선택 항목 ' + targets.length + '개 휴지통으로 이동' : '휴지통으로 이동',
          danger: true,
          onSelect: function () { trashRows(targets.filter(function (r) { return r.kind === 'file' || r.kind === 'folder'; })); },
        });
      }
      if (items.length) openCtxMenu(x, y, items);
    }

    function applySortKey(key) {
      if (state.sortKey === key) state.sortDir = state.sortDir * -1;
      else {
        state.sortKey = key;
        state.sortDir = key === 'date' ? -1 : 1;
      }
      render();
    }

    function sortMenuItems() {
      function item(key, label) {
        return {
          label: label,
          checked: state.sortKey === key,
          onSelect: function () {
            applySortKey(key);
          },
        };
      }
      return [
        item('name', '이름'),
        item('date', '수정일'),
        item('size', '크기'),
        item('kind', '종류'),
      ];
    }

    function openBackgroundMenu(x, y) {
      var items = [];
      if (state.view === 'drive') {
        items.push({ label: '새 폴더', onSelect: function () { createFolder(); } });
        items.push({
          label: '파일 올리기',
          onSelect: function () { if (fileInput) fileInput.click(); },
        });
        items.push({ sep: true });
        items = items.concat(sortMenuItems());
      } else if (state.view === 'trash') {
        items.push({
          label: '휴지통 비우기',
          danger: true,
          onSelect: function () { emptyTrashAll(); },
        });
      }
      if (items.length) openCtxMenu(x, y, items);
    }

    function emptyTrashAll() {
      var all = currentRows() || [];
      var targets = all.filter(function (r) {
        return (r.kind === 'tfolder' || r.kind === 'tfile') && !r.viaFolder;
      });
      var iconCount = state.iconTrash.length;
      if (!targets.length && !iconCount) return;
      // confirmFn은 동기 boolean을 내도, 커스텀 모달이 Promise를 내도
      // 있다 — Promise.resolve로 감싼 작업 같은 흐름으로 받는다.
      Promise.resolve(
        confirmFn('휴지통의 ' + (targets.length + iconCount) + '개 항목을 영구 삭제할까요? 되돌릴 수 없습니다.'),
      ).then(function (ok) {
        if (!ok) return;
        var chain = Promise.resolve();
        targets.forEach(function (row) {
          chain = chain.then(function () {
            var url =
              row.kind === 'tfolder'
                ? '/api/drive/folders/' + row.folderId
                : '/api/drive/files/' + row.fileId;
            return callApi(url, { method: 'DELETE' }).catch(function () {
              return null;
            });
          });
        });
        return chain.then(function () {
          if (iconCount) {
            postToParent({ type: 'myhub:icon-trash-purge-all' });
            state.iconTrash = [];
          }
          state.actionMsg = '휴지통을 비웠습니다';
          return loadTrash();
        });
      });
    }

    function renderHead() {
      if (!headEl) return;
      headEl.innerHTML = '';
      // 헤더는 목록 가로 스크롤과 동기화해 민다 (모바일 쪽 숨김 교정) —
      // 다시 그릴 때 현재 스크롤 위치 기준으로 transform을 맞춘다.
      headEl.style.transform = listEl && listEl.scrollLeft
        ? 'translateX(' + -listEl.scrollLeft + 'px)'
        : '';
      if (state.mode !== 'list' || state.view === 'apps') {
        headEl.hidden = true;
        return;
      }
      headEl.hidden = false;
      var cols = [
        { key: 'name', label: '이름', cls: 'finder-col-name' },
        { key: 'date', label: '수정일', cls: 'finder-col-date' },
        { key: 'size', label: '크기', cls: 'finder-col-size' },
        { key: 'kind', label: '종류', cls: 'finder-col-kind' },
      ];
      cols.forEach(function (col) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'finder-col ' + col.cls + (state.sortKey === col.key ? ' is-sorted' : '');
        b.dataset.sort = col.key;
        var label = doc.createElement('span');
        label.textContent = col.label;
        b.appendChild(label);
        if (state.sortKey === col.key) {
          var arrow = doc.createElement('span');
          arrow.className = 'finder-col-arrow';
          arrow.textContent = state.sortDir === 1 ? '▲' : '▼';
          b.appendChild(arrow);
        }
        b.addEventListener('click', function () {
          if (state.sortKey === col.key) state.sortDir = state.sortDir * -1;
          else {
            state.sortKey = col.key;
            state.sortDir = col.key === 'date' ? -1 : 1;
          }
          render();
        });
        headEl.appendChild(b);
      });
    }

    function renderPathbar() {
      if (!pathEl) return;
      pathEl.innerHTML = '';
      if (state.view !== 'drive') {
        pathEl.hidden = true;
        return;
      }
      pathEl.hidden = false;
      state.stack.forEach(function (crumb, i) {
        if (i > 0) {
          var sep = doc.createElement('span');
          sep.className = 'finder-crumb-sep';
          sep.textContent = '·';
          pathEl.appendChild(sep);
        }
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'finder-crumb' + (i === state.stack.length - 1 ? ' is-current' : '');
        // 경로 슬래시는 내부 드래그 이동의 목적지다 (프로토콜 표기)
        b.dataset.moveTarget = crumb.id === null ? 'root' : String(crumb.id);
        b.dataset.moveName = displayFolderName(crumb.name);
        var ic = doc.createElement('span');
        ic.className = 'finder-crumb-icon';
        ic.innerHTML = '<i data-lucide="' + (i === 0 ? 'hard-drive' : 'folder') + '"></i>';
        b.appendChild(ic);
        var label = doc.createElement('span');
        label.textContent = displayFolderName(crumb.name);
        b.appendChild(label);
        b.addEventListener('click', function () {
          if (i === state.stack.length - 1) return;
          navigateTo(state.stack.slice(0, i + 1));
        });
        pathEl.appendChild(b);
      });
    }

    // ---- 응용 프로그램 보관함 ----
    function appTileIconHtml(app) {
      var icons = fileIconsApi();
      var kind = APP_TILE_KINDS[app.id];
      if (icons && kind && typeof icons.appTileFor === 'function') {
        var svg = icons.appTileFor(kind);
        if (svg) return svg;
      }
      return '<i data-lucide="' + (app.glyph || 'layout-grid') + '"></i>';
    }

    function launchApp(app) {
      if (!app || !app.id) return;
      if (inShell) {
        // 데스크톱 창 때: 부모가 그 앱의 창을 연다.
        postToParent({ type: 'myhub:open-module', module: app.id });
      } else if (app.url) {
        navigateFn(app.url);
      }
    }

    function renderApps(listEl, apps) {
      apps.forEach(function (app) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'finder-app-tile';
        b.dataset.appId = app.id;
        var ic = doc.createElement('span');
        ic.className = 'finder-app-icon';
        ic.innerHTML = appTileIconHtml(app);
        var label = doc.createElement('span');
        label.className = 'finder-app-label';
        label.textContent = app.title || app.id;
        b.appendChild(ic);
        b.appendChild(label);
        b.addEventListener('dblclick', function () {
          launchApp(app);
        });
        b.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') launchApp(app);
        });
        listEl.appendChild(b);
      });
    }

    // 사이드바 선택 표시는 현재 위치 하나만이어야 한다 (사용자
    // 지시 2026-11-06, image-121: 바탕화면은 이었는데 보관함까지
    // 퍼졌다). 정적 항목의 규칙: 최근 항목·응용 프로그램·휴지통
    // 과 뷰어 앱, 보관함은 보관함 루트(현재 폴더가 루트)일 때만
    // 켜지고 앱 폴더 안에 있으면 그 폴더 항목(시스템 폴더·즐겨찾기,
    // renderSidebar 본문)만 켜진다.
    function syncSidebarActive() {
      Array.prototype.forEach.call(doc.querySelectorAll('[data-view]'), function (b) {
        var v = b.dataset.view;
        var on =
          v === 'drive'
            ? state.view === 'drive' && currentFolder().id === null
            : state.view === v;
        b.classList.toggle('is-active', on);
      });
    }

    function renderSidebar() {
      syncSidebarActive();
      // 기본 즐겨찾기 폴더 3종: 루트 목록에서 이름으로 찾는다.
      // 데스크톱 항목만 라벨이 '데스크톱'이고 폴더 설명은 '바탕화면'.
      [
        { btn: sideDesktopBtn, folderName: '바탕화면' },
        { btn: sideDocsBtn, folderName: '문서' },
        { btn: sideDownloadsBtn, folderName: '다운로드' },
      ].forEach(function (cfg) {
        if (!cfg.btn) return;
        var folder = (state.rootFolders || []).filter(function (f) {
          return f.name === cfg.folderName;
        })[0];
        cfg.btn.hidden = !folder;
        cfg.btn.dataset.folderId = folder ? String(folder.id) : '';
        // 시스템 폴더 항목은 내부 드래그 이동의 목적지다
        if (folder) {
          cfg.btn.dataset.moveTarget = String(folder.id);
          cfg.btn.dataset.moveName = displayFolderName(folder.name);
        } else {
          cfg.btn.removeAttribute('data-move-target');
          cfg.btn.removeAttribute('data-move-name');
        }
        cfg.btn.dataset.folderName = folder ? folder.name : '';
        cfg.btn.classList.toggle(
          'is-active',
          !!folder && state.view === 'drive' && currentFolder().id === folder.id,
        );
      });
      // 즐겨찾기 폴더: 루트 폴더 목록을 로드해 있으면 이름 변경을 따라간다
      if (sideFavoritesEl) {
        var dirty = false;
        (state.rootFolders || []).forEach(function (rf) {
          state.favorites.forEach(function (fav) {
            if (fav.id === rf.id && fav.name !== rf.name) {
              fav.name = rf.name;
              dirty = true;
            }
          });
        });
        if (dirty) saveFavorites();
        sideFavoritesEl.innerHTML = '';
        state.favorites.forEach(function (fav) {
          var b = doc.createElement('button');
          b.type = 'button';
          b.className =
            'finder-side-item' +
            (state.view === 'drive' && currentFolder().id === fav.id ? ' is-active' : '');
          b.dataset.favId = String(fav.id);
          b.dataset.moveTarget = String(fav.id);
          b.dataset.moveName = displayFolderName(fav.name);
          b.title = displayFolderName(fav.name);
          b.innerHTML = '<i data-lucide="folder"></i>';
          var label = doc.createElement('span');
          label.textContent = displayFolderName(fav.name);
          b.appendChild(label);
          b.addEventListener('click', function () {
            navigateTo([
              { id: null, name: '보관함' },
              { id: fav.id, name: fav.name },
            ]);
          });
          b.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            openCtxMenu(ev.clientX, ev.clientY, [
              {
                label: '즐겨찾기에서 제거',
                onSelect: function () {
                  toggleFavorite(fav);
                },
              },
            ]);
          });
          sideFavoritesEl.appendChild(b);
        });
      }
      // 위치(보관함 저장소) 캡션: 파일 수 · 사용자
      if (sideUsageEl) {
        sideUsageEl.textContent = state.usage
          ? '파일 ' + state.usage.files + '개 · ' + fmtSize(state.usage.bytes) + ' 사용 중'
          : '';
      }
    }

    // 목록에 보이는 파일로 전용 오피스 엔진을 판정한다 (프리패치
    // 적용). 뷰어 분류의 목적은 어디서 두 여기다 무조건 엔진 단위
    // (시트=GridCraft, 슬라이드=DeckCraft)만 본다.
    var PREFETCH_ENGINE_BY_EXT = { xlsx: 'gridcraft', xls: 'gridcraft', csv: 'gridcraft', pptx: 'deckcraft' };
    var prefetchedEngines = {};
    function notePrefetchEngines(rows) {
      if (typeof deps.prefetchEngines !== 'function') return;
      if (state.view === 'trash' || state.view === 'apps') return;
      var fresh = [];
      (rows || []).forEach(function (row) {
        if (!row || row.kind !== 'file' || !row.name) return;
        var dot = row.name.lastIndexOf('.');
        if (dot < 0) return;
        var engine = PREFETCH_ENGINE_BY_EXT[row.name.slice(dot + 1).toLowerCase()];
        if (engine && !prefetchedEngines[engine]) {
          prefetchedEngines[engine] = true;
          fresh.push(engine);
        }
      });
      if (fresh.length) deps.prefetchEngines(fresh);
    }

    // 창 바 호스트 (myhub:finder-toolbar 채널): 너비 채워지면 자체
    // 검색 행을 숨기고 컨트롤은 창 바가 그린다. 제목·앱 상태는 렌더
    // 따로 게시하고, 호스트 하위 요청(myhub:request-doc-title)는
    // 마지막 제목으로 보낸다 (load 순서 경합은 자기치유).
    var toolbarHosted = false;
    var lastTitle = null;
    // 임베드 판정: 실제 환경에서는 부모 창 신뢰가 필요하고, 테스트는
    // deps.embedded로 주입한다 (jsdom은 항상 단독 창이라 구분이 필요).
    var embeddedOverride = typeof deps.embedded === 'boolean' ? deps.embedded : null;
    function isEmbedded() {
      if (embeddedOverride !== null) return embeddedOverride;
      return typeof window !== 'undefined' && !!window.parent && window.parent !== window;
    }
    function publishDocTitle() {
      if (!isEmbedded()) return;
      // 창 제목은 운영 정본 '찾기 / 보관함' 형태다 (2026-11-11 앱 대조
      // 카탈로그): 보관함(drive) 보기에서는 '찾기 / '를 붙여 게시하고,
      // 페이지 안 제목(#finderTitle)은 폴더명 그대로 둔다.
      var name =
        state.view === 'drive' && lastTitle ? '찾기 / ' + lastTitle : lastTitle;
      postToParent({ type: 'myhub:doc-title', name: name, dirty: false });
    }
    function publishToolbar() {
      if (!isEmbedded()) return;
      postToParent({
        type: 'myhub:finder-toolbar',
        state: {
          canBack: state.hIndex > 0,
          canFwd: state.hIndex < state.history.length - 1,
          mode: state.mode,
          sortKey: state.sortKey,
          sortDir: state.sortDir,
          drive: state.view === 'drive' && !state.search,
          query: finderQ ? finderQ.value : state.search ? state.search.query : '',
        },
      });
    }
    function handleToolbarMessage(d) {
      if (!d) return false;
      if (d.type === 'myhub:finder-toolbar-adopt') {
        toolbarHosted = true;
        var barEl = doc.querySelector('.finder-toolbar');
        if (barEl) barEl.classList.add('myhub-hosted');
        return true;
      }
      if (d.type !== 'myhub:finder-toolbar-action') return false;
      switch (d.action) {
        case 'back': goBack(); break;
        case 'fwd': goFwd(); break;
        case 'mode-list': if (modeListBtn) modeListBtn.click(); break;
        case 'mode-grid': if (modeGridBtn) modeGridBtn.click(); break;
        case 'sort':
          openCtxMenu(
            typeof d.anchorX === 'number' ? d.anchorX : 0,
            typeof d.anchorY === 'number' ? d.anchorY : 40,
            sortMenuItems(),
          );
          break;
        case 'sort-by':
          if (['name', 'date', 'size', 'kind'].indexOf(d.key) >= 0) applySortKey(d.key);
          break;
        case 'new-folder': createFolder(); break;
        case 'upload': if (fileInput) fileInput.click(); break;
        case 'search': {
          var q = typeof d.value === 'string' ? d.value : '';
          if (finderQ) finderQ.value = q;
          setFilter(q);
          break;
        }
        default: return false;
      }
      return true;
    }

    function render() {
      var folderTitle = state.search
        ? '"' + state.search.query + '" 검색 결과'
        : state.view === 'trash'
          ? '휴지통'
          : state.view === 'recent'
            ? '최근 항목'
            : state.view === 'apps'
              ? '응용 프로그램'
              : displayFolderName(currentFolder().name);
      lastTitle = folderTitle;
      if (titleEl) {
        titleEl.textContent = folderTitle;
        // 데스크톱 창 안에서는 폴더명이 창 바(왼쪽 흐름)에 뜬다 — 내부
        // 폴더명(15px/700)을 빼서 행을 가볍게 한다. 단독 페이지에서는
        // 창 바가 없으므로 그대로 둔다 (통합 설계 스펙 Finder 2차).
        titleEl.style.display = isEmbedded() ? 'none' : '';
        publishDocTitle();
      }
      var inDrive = state.view === 'drive' && !state.search;
      if (uploadBtn) uploadBtn.hidden = !inDrive;
      if (newFolderBtn) newFolderBtn.hidden = !inDrive;
      if (backBtn) backBtn.disabled = state.hIndex <= 0;
      if (fwdBtn) fwdBtn.disabled = state.hIndex >= state.history.length - 1;
      if (modeListBtn) modeListBtn.classList.toggle('is-active', state.mode === 'list');
      if (modeGridBtn) modeGridBtn.classList.toggle('is-active', state.mode === 'grid');
      publishToolbar();
      renderHead();
      renderPathbar();
      renderSidebar();
      if (!listEl) return;
      listEl.innerHTML = '';
      listEl.classList.toggle('is-grid', state.mode === 'grid');
      listEl.classList.toggle('is-apps', state.view === 'apps');
      if (state.view === 'apps') {
        var apps = state.appsCatalog || FALLBACK_APPS;
        renderApps(listEl, apps);
        if (statusEl) {
          statusEl.textContent = state.actionMsg || apps.length + '개 응용 프로그램';
        }
        if (selStatusEl) selStatusEl.textContent = '응용 프로그램 선택';
        refreshIcons();
        return;
      }
      var all = currentRows();
      var rows = all ? sortedRows(visibleRows(all)) : [];
      // 날짜 정렬(목록 보기·보관함/최근)에서는 맥 Finder처럼 기간
      // 그룹 헤더를 두 사이즈 넣고, 그룹 안 행에만 번호를 균형해 준다.
      var groupByDate =
        !state.search &&
        state.mode === 'list' &&
        state.sortKey === 'date' &&
        (state.view === 'drive' || state.view === 'recent');
      listEl.classList.toggle('is-grouped', groupByDate);
      var lastGroup = null;
      var altFlip = false;
      rows.forEach(function (row) {
        if (groupByDate) {
          var g = dateGroupLabel(row.date);
          if (g !== lastGroup) {
            lastGroup = g;
            altFlip = false;
            var gh = doc.createElement('div');
            gh.className = 'finder-group-head';
            gh.textContent = g;
            listEl.appendChild(gh);
          }
        }
        var rowEl = buildRow(row, rows);
        if (groupByDate) {
          if (altFlip) rowEl.classList.add('is-alt');
          altFlip = !altFlip;
        }
        listEl.appendChild(rowEl);
      });
      if (selStatusEl) {
        // 하단 좌측 선택 표시 (운영 정본 '보관함 선택' — 오른쪽 'N개 항목'
        // 상태와 한 쌍, 2026-11-11 앱 대조 카탈로그). 선택이 있으면
        // 'N개 선택'으로 바뀐다.
        var selN = selectedRows(rows).length;
        var locName = state.search
          ? '검색 결과'
          : state.view === 'recent'
            ? '최근 항목'
            : state.view === 'trash'
              ? '휴지통'
              : displayFolderName(currentFolder().name);
        selStatusEl.textContent = selN > 0 ? selN + '개 선택' : locName + ' 선택';
      }
      if (statusEl) {
        if (state.search) {
          // 방금 두 동작은 고정(올리기 결과·이름 변경 등)가 검색 요약을
          // 뭉치면 사용자는 결과를 두 수 없다 — 다른 보관과 같은 규칙.
          if (state.actionMsg) statusEl.textContent = state.actionMsg;
          else if (state.search.loading) statusEl.textContent = '검색 중…';
          else if (state.search.error) statusEl.textContent = '검색에 실패했습니다';
          else if (!state.search.total) statusEl.textContent = '검색 결과가 없습니다';
          else {
            statusEl.textContent =
              '전체 보관함에서 ' + state.search.total + '개 찾음' +
              (state.search.truncated ? ' · 최근 ' + rows.length + '개만 표시' : '');
          }
        }
        else if (state.actionMsg) statusEl.textContent = state.actionMsg;
        else if (state.loadError) statusEl.textContent = '불러오지 못했습니다';
        else if (!all) statusEl.textContent = '불러오는 중…';
        else if (!all.length)
          statusEl.textContent = state.view === 'trash' ? '휴지통이 비어 있습니다' : '항목이 없습니다';
        else if (!rows.length) statusEl.textContent = '검색 결과가 없습니다';
        else {
          var selCount = selectedRows(rows).length;
          statusEl.textContent = selCount > 0
            ? rows.length + '개 중 ' + selCount + '개 선택'
            : rows.length + '개 항목';
        }
      }
      notePrefetchEngines(rows);
      refreshIcons();
    }

    function callApi(url, opts) {
      return Promise.resolve()
        .then(function () {
          return fetchFn(url, opts);
        })
        .then(function (res) {
          if (!res || !res.ok) {
            var e = new Error('http ' + (res && res.status));
            e.status = res && res.status;
            throw e;
          }
          return res;
        });
    }

    function callJson(url, opts) {
      return callApi(url, opts).then(function (res) {
        return res.json();
      });
    }

    function refreshUsage() {
      return callJson('/api/drive/usage')
        .then(function (body) {
          state.usage = { files: body.files || 0, bytes: body.bytes || 0 };
          renderSidebar();
          refreshIcons();
        })
        .catch(function () {
          return null; // 캡션은 불가 정보 등 실패해도 목록은 그대로 낸다
        });
    }

    function loadDrive() {
      var id = currentFolder().id;
      var url = id === null ? '/api/drive/list' : '/api/drive/list?folder=' + id;
      state.listing = null;
      state.loadError = false;
      render();
      return callJson(url)
        .then(function (body) {
          state.listing = { folders: body.folders || [], files: body.files || [] };
          if (currentFolder().id === null) state.rootFolders = state.listing.folders;
          setCount('countDrive', state.listing.folders.length + state.listing.files.length);
          render();
          refreshUsage();
          ensureSystemFolders();
        })
        .catch(function (err) {
          // 즐겨찾기 폴더가 삭제된 경우(404): 즐겨찾기에서 정리하고
          // 루트로 알린다. 네트워크 오류 등 그 땐 실패를 건드리지 않는다.
          if (err && err.status === 404 && id !== null && isFavorite(id)) {
            state.favorites = state.favorites.filter(function (f) {
              return f.id !== id;
            });
            saveFavorites();
            state.actionMsg = '삭제된 폴더를 즐겨찾기에서 제거했습니다';
            navigateTo([{ id: null, name: '보관함' }]);
            return;
          }
          state.loadError = true;
          state.listing = { folders: [], files: [] };
          render();
        });
    }

    // 기본 즐겨찾기 폴더(문서·다운로드)는 마커만 항상 있어야 한다 —
    // 루트 목록에 없으면 한 번만 만들어 다시 읽는다. 실패해도 목록은
    // 그대로 넣고 사이드바 항목만 한글 채로 둔다.
    function ensureSystemFolders() {
      if (state.sysFoldersEnsured || !state.rootFolders) return;
      state.sysFoldersEnsured = true;
      var missing = ['문서', '다운로드'].filter(function (name) {
        return !state.rootFolders.some(function (f) {
          return f.name === name;
        });
      });
      if (!missing.length) return;
      var chain = Promise.resolve();
      missing.forEach(function (name) {
        chain = chain.then(function () {
          return callJson('/api/drive/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, parent_id: null }),
          }).catch(function () {
            return null;
          });
        });
      });
      chain.then(function () {
        if (state.view === 'drive' && currentFolder().id === null) return loadDrive();
        return callJson('/api/drive/list')
          .then(function (body) {
            state.rootFolders = body.folders || [];
            renderSidebar();
            refreshIcons();
          })
          .catch(function () {
            return null;
          });
      });
    }

    function loadTrash() {
      state.trashData = null;
      state.iconTrash = readIconTrash();
      state.loadError = false;
      render();
      return callJson('/api/drive/trash')
        .then(function (body) {
          state.trashData = { folders: body.folders || [], files: body.files || [] };
          setCount('countTrash', state.trashData.folders.length + state.trashData.files.length);
          render();
        })
        .catch(function () {
          state.loadError = true;
          state.trashData = { folders: [], files: [] };
          render();
        });
    }

    function setView(view) {
      exitSearchMode();
      state.view = view;
      state.actionMsg = '';
      state.armedKey = null;
      clearSelection();
      syncSidebarActive();
      if (view === 'trash') return loadTrash();
      if (view === 'recent') return loadRecent();
      if (view === 'apps') {
        requestAppsCatalog();
        render();
        return Promise.resolve();
      }
      return loadDrive();
    }

    // 앱(데스크톱 창)면 부모에게 실제 앱 카탈로그를 요청한다 두
    // 높이 가린 뒤에서는 폴백 목록으로 그리고, 아니면 가라앉는다.
    function requestAppsCatalog() {
      if (state.appsCatalog || state.appsRequested) return;
      state.appsRequested = true;
      postToParent({ type: 'myhub:request-apps' });
    }

    function setAppsCatalog(apps) {
      if (!Array.isArray(apps) || !apps.length) return;
      state.appsCatalog = apps.filter(function (a) {
        return a && a.id && a.id !== 'finder';
      });
      if (state.view === 'apps') render();
    }

    function loadRecent() {
      state.recentFiles = null;
      state.loadError = false;
      render();
      return callJson('/api/drive/recent')
        .then(function (body) {
          state.recentFiles = body.files || [];
          render();
        })
        .catch(function () {
          state.loadError = true;
          state.recentFiles = [];
          render();
        });
    }

    function renameFile(row) {
      // promptFn은 동기 문자열을 내도, 커스텀 모달이 Promise를 내도
      // 있다 — 검증(취소·빈 값 같은 이름)무시 값이 빈 뒤에 둔다.
      Promise.resolve(promptFn('파일 이름', row.name)).then(function (answer) {
        if (answer === null || answer === undefined) return;
        var name = String(answer).trim();
        if (!name || name === row.name) return;
        callJson('/api/drive/files/' + row.fileId + '/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        })
          .then(function () {
            state.actionMsg = '이름을 바꿨습니다';
            return reloadListing();
          })
          .catch(function () {
            fail('이름 변경에 실패했습니다');
          });
      });
    }

    var navigateFn =
      typeof deps.navigateFn === 'function'
        ? deps.navigateFn
        : function (url) {
            window.location.href = url;
          };
    var inShell =
      typeof deps.inShell === 'boolean'
        ? deps.inShell
        : typeof window !== 'undefined' && !!window.parent && window.parent !== window;

    function openFile(row) {
      var appKey = officeAppFor(row);
      if (appKey) {
        if (inShell) {
          postToParent({
            type: 'myhub:open-in-app',
            app: appKey,
            fileId: row.fileId,
            name: row.name,
            mime: row.mime,
            version: row.version || null,
            folderId: row.folderId === undefined ? null : row.folderId,
            folderName: row.folderName || '',
          });
        } else {
          var q =
            '?app=' + encodeURIComponent(appKey) +
            '&file=' + encodeURIComponent(String(row.fileId)) +
            '&name=' + encodeURIComponent(row.name || '') +
            '&mime=' + encodeURIComponent(row.mime || '');
          if (row.version) q += '&version=' + encodeURIComponent(row.version);
          if (row.folderId) q += '&folder=' + encodeURIComponent(String(row.folderId));
          if (row.folderName) q += '&folderName=' + encodeURIComponent(row.folderName);
          navigateFn('/office.html' + q);
        }
        return;
      }
      if (viewer)
        viewer.open({
          fileId: row.fileId,
          name: row.name,
          mime: row.mime,
          version: row.version || null,
        });
      else openUrl('/api/drive/files/' + row.fileId);
    }

    function descend(row) {
      navigateTo(state.stack.concat([{ id: row.folderId, name: row.name }]));
    }

    function fail(msg) {
      state.actionMsg = msg;
      render();
    }

    function renameFolder(row) {
      Promise.resolve(promptFn('폴더 이름', row.name)).then(function (answer) {
        if (answer === null || answer === undefined) return;
        var name = String(answer).trim();
        if (!name || name === row.name) return;
        callJson('/api/drive/folders/' + row.folderId + '/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        })
          .then(function () {
            state.actionMsg = '이름을 바꿨습니다';
            return reloadListing();
          })
          .catch(function () {
            fail('이름 변경에 실패했습니다');
          });
      });
    }

    function createFolder() {
      Promise.resolve(promptFn('새 폴더 이름', '새 폴더')).then(function (answer) {
        if (answer === null || answer === undefined) return;
        var name = String(answer).trim();
        if (!name) return;
        callJson('/api/drive/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, parent_id: currentFolder().id }),
        })
          .then(function () {
            state.actionMsg = '폴더를 만들었습니다';
            return loadDrive();
          })
          .catch(function () {
            fail('폴더 만들기에 실패했습니다');
          });
      });
    }

    function restoreItem(row) {
      var url =
        row.kind === 'tfolder'
          ? '/api/drive/folders/' + row.folderId + '/restore'
          : '/api/drive/files/' + row.fileId + '/restore';
      callApi(url, { method: 'POST' })
        .then(function () {
          state.listing = null;
          state.actionMsg = '복원했습니다';
          return loadTrash();
        })
        .catch(function () {
          fail('복원에 실패했습니다');
        });
    }

    function purgeItem(row) {
      if (state.armedKey !== row.key) {
        state.armedKey = row.key;
        render();
        if (state.armTimer) clearTimeout(state.armTimer);
        state.armTimer = setTimeout(function () {
          state.armedKey = null;
          render();
        }, 3000);
        return;
      }
      state.armedKey = null;
      if (state.armTimer) clearTimeout(state.armTimer);
      var url =
        row.kind === 'tfolder' ? '/api/drive/folders/' + row.folderId : '/api/drive/files/' + row.fileId;
      callApi(url, { method: 'DELETE' })
        .then(function () {
          state.actionMsg = '영구 삭제했습니다';
          return loadTrash();
        })
        .catch(function () {
          fail('영구 삭제에 실패했습니다');
        });
    }

    // ---- 바탕화면 아이콘 휴지통 (오래된 관리자 데스크톱 부모가 준다) ----
    function dropIconTrashRow(row) {
      state.iconTrash = state.iconTrash.filter(function (en) {
        return !(
          en.kind === row.entry.kind && String(en.id) === String(row.entry.id)
        );
      });
      render();
    }
    function restoreIconTrash(row) {
      postToParent({ type: 'myhub:icon-trash-restore', entry: row.entry });
      state.actionMsg = '바탕화면으로 복원했습니다';
      dropIconTrashRow(row);
    }
    function purgeIconTrashNow(row) {
      postToParent({ type: 'myhub:icon-trash-purge', entry: row.entry });
      state.actionMsg = '영구 삭제했습니다';
      dropIconTrashRow(row);
    }
    function purgeIconTrash(row) {
      if (state.armedKey !== row.key) {
        state.armedKey = row.key;
        render();
        if (state.armTimer) clearTimeout(state.armTimer);
        state.armTimer = setTimeout(function () {
          state.armedKey = null;
          render();
        }, 3000);
        return;
      }
      state.armedKey = null;
      if (state.armTimer) clearTimeout(state.armTimer);
      purgeIconTrashNow(row);
    }

    function uploadFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      var fd = new FormData();
      if (currentFolder().id !== null) fd.append('folder_id', String(currentFolder().id));
      files.forEach(function (f) {
        fd.append('files', f);
      });
      state.actionMsg = '올리기 중…';
      render();
      callJson('/api/drive/files', { method: 'POST', body: fd })
        .then(function () {
          state.actionMsg = '파일 ' + files.length + '개를 올렸습니다';
          return loadDrive();
        })
        .catch(function () {
          fail('업로드에 실패했습니다 (파일은 10MB까지 가능합니다)');
        });
    }

    // ---- 전역 검색 (보관함 전체, 서버 /api/drive/search) ----
    // 검색어가 있으면 현재 폴더 필터가 아닌 전역 결과 모드로
    // 전환한다. 입력마다 디바운스하고, 늦게 도착한 두 응답은
    // seq로 버린다 (빠른 연속 입력에서 결과가 섞이지 않게).
    var searchTimer = null;
    var searchSeq = 0;
    function setFilter(q) {
      state.filter = String(q || '');
      var query = state.filter.trim();
      if (!query) {
        if (state.search) {
          state.search = null;
          searchSeq += 1;
        }
        render();
        return;
      }
      if (state.view !== 'drive') setViewSilent('drive');
      searchSeq += 1;
      var seq = searchSeq;
      // 두 검색어 판 마지막이다 — 이전 동작은 고정과 검색 요약이
      // 계속 가리지 않게 비운다 (검색 중 생긴 고정은 그 뒤에 붙인다).
      state.actionMsg = '';
      state.search = {
        query: query, loading: true, error: false,
        folders: [], files: [], total: 0, truncated: false,
      };
      clearSelection();
      render();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        fetchSearch(query, seq);
      }, 250);
    }

    function fetchSearch(query, seq) {
      return callJson('/api/drive/search?q=' + encodeURIComponent(query))
        .then(function (body) {
          if (seq !== searchSeq) return;
          state.search = {
            query: query, loading: false, error: false,
            folders: body.folders || [], files: body.files || [],
            total: body.total || 0, truncated: !!body.truncated,
          };
          render();
        })
        .catch(function () {
          if (seq !== searchSeq) return;
          state.search = {
            query: query, loading: false, error: true,
            folders: [], files: [], total: 0, truncated: false,
          };
          render();
        });
    }

    // 현재 화면 새로고침 (앱 동작 공용): 검색 모드면 같은 검색어로
    // 다시 조회해 결과가 맞지 않게 허고, 아니면 뷰별 목록을 다시 읽는다
    function reloadListing() {
      if (state.search) {
        searchSeq += 1;
        var q = state.search.query;
        state.search = {
          query: q, loading: true, error: false,
          folders: [], files: [], total: 0, truncated: false,
        };
        render();
        return fetchSearch(q, searchSeq);
      }
      return state.view === 'recent' ? loadRecent() : loadDrive();
    }

    // 검색 모드를 끝내고 입력값까지 비운다 (폴더 이동·뷰 전환 공용)
    function exitSearchMode() {
      if (!state.search && !state.filter) return;
      state.search = null;
      state.filter = '';
      searchSeq += 1;
      if (searchTimer) clearTimeout(searchTimer);
      if (navQ && navQ.value) navQ.value = '';
      if (finderQ && finderQ.value) finderQ.value = '';
    }

    // 검색 결과 행의 소속 위치 스택 (루트 + 경로 구간)
    function stackFromPath(path) {
      var stack = [{ id: null, name: '보관함' }];
      (path || []).forEach(function (s) {
        stack.push({ id: s.id, name: s.name });
      });
      return stack;
    }

    // 검색 결과 클릭: 그 항목이 있는 폴더로 이동해 선택 상태로 보여준다
    function revealSearchRow(row) {
      var key = row.key;
      exitSearchMode();
      navigateTo(stackFromPath(row.path));
      state.selected = {};
      state.selected[key] = true;
      state.selectedKey = key;
    }

    // 노바 파일 도구(uiAction) 진입점: 검색어를 stressful전역 검색
    // 화면으로 전환한다 (사용자가 직접 입력한 것과 같은 경로)
    function showSearch(query) {
      var q = String(query || '');
      if (navQ) navQ.value = q;
      if (finderQ) finderQ.value = q;
      setFilter(q);
      if (finderQ && typeof finderQ.focus === 'function') finderQ.focus();
    }

    // 노바 파일 도구(uiAction) 진입점: 파일 1개를 그 폴더에서 드래그한다
    function revealFile(fileId, folderId, path) {
      exitSearchMode();
      navigateTo(stackFromPath(path));
      var key = 'file-' + fileId;
      state.selected = {};
      state.selected[key] = true;
      state.selectedKey = key;
    }

    // 사이드바 '보관함' 항목은 내부 드래그 이동의 루트 목적지다
    Array.prototype.forEach.call(doc.querySelectorAll('[data-view="drive"]'), function (b) {
      b.dataset.moveTarget = 'root';
      b.dataset.moveName = '보관함';
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-view]'), function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.view === 'drive' && state.view === 'drive' && state.stack.length > 1) {
          navigateTo([{ id: null, name: '보관함' }]);
          return;
        }
        setView(b.dataset.view);
      });
    });
    // 기본 즐겨찾기 폴더(데스크톱·문서·다운로드): 버튼은 folderId가
    // 가리키는 루트 폴더로 이동한다. 이름은 폴더 설명을 낸다.
    function bindSystemFolderBtn(btn) {
      if (!btn) return;
      btn.addEventListener('click', function () {
        var id = Number(btn.dataset.folderId);
        if (!id) return;
        navigateTo([
          { id: null, name: '보관함' },
          { id: id, name: btn.dataset.folderName || '' },
        ]);
      });
    }
    bindSystemFolderBtn(sideDesktopBtn);
    bindSystemFolderBtn(sideDocsBtn);
    bindSystemFolderBtn(sideDownloadsBtn);
    if (backBtn) backBtn.addEventListener('click', goBack);
    if (fwdBtn) fwdBtn.addEventListener('click', goFwd);
    if (modeListBtn) {
      modeListBtn.addEventListener('click', function () {
        state.mode = 'list';
        render();
      });
    }
    if (modeGridBtn) {
      modeGridBtn.addEventListener('click', function () {
        state.mode = 'grid';
        render();
      });
    }
    if (sortBtn) {
      sortBtn.addEventListener('click', function () {
        var r = sortBtn.getBoundingClientRect();
        openCtxMenu(r.left, r.bottom + 4, sortMenuItems());
      });
    }
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        if (e.target === listEl) {
          clearSelection();
          render();
        }
      });
      listEl.addEventListener('contextmenu', function (e) {
        if (e.target === listEl) {
          e.preventDefault();
          openBackgroundMenu(e.clientX, e.clientY);
        }
      });
    }
    // 커럽 헤더는 목록 스크롤 컨테이너 밖에 있어, 가로 스크롤 두
    // 헤더만 제자리에서 남는다 — 스크롤만큼 헤더를 함께 민다 (모바일).
    if (listEl && headEl) {
      listEl.addEventListener('scroll', function () {
        headEl.style.transform = listEl.scrollLeft
          ? 'translateX(' + -listEl.scrollLeft + 'px)'
          : '';
      }, { passive: true });
    }
    if (newFolderBtn) newFolderBtn.addEventListener('click', createFolder);
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', function () {
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        var fl = fileInput.files;
        if (fl && fl.length) uploadFiles(fl);
        fileInput.value = '';
      });
    }
    var navQ = doc.getElementById('navQ');
    var finderQ = doc.getElementById('finderQ');
    function bindSearch(input, other) {
      if (!input) return;
      input.addEventListener('input', function () {
        if (other && other.value !== input.value) other.value = input.value;
        setFilter(input.value);
      });
    }
    bindSearch(navQ, finderQ);
    bindSearch(finderQ, navQ);

    // ---- 바탕화면에서 특정 파일 열기 (데스크톱 파일 아이콘·자료 진입점) ----
    var lastOpenTarget = { key: '', time: 0 };
    function openFileTarget(target) {
      if (!target || !target.fileId) return;
      // 같은 파일의 열기 중복 전달(즉시 전송 + ready 사전정보)는 한 번만 연다
      var key = target.folderId + ':' + target.fileId;
      var now = Date.now();
      if (lastOpenTarget.key === key && now - lastOpenTarget.time < 1000) return;
      lastOpenTarget = { key: key, time: now };
      state.stack = [{ id: null, name: '보관함' }];
      if (target.folderId) {
        state.stack.push({ id: target.folderId, name: target.folderName || '폴더' });
      }
      pushHistory();
      state.selectedKey = 'file-' + target.fileId;
      state.selected = {};
      state.selected[state.selectedKey] = true;
      var loaded = state.view !== 'drive' ? setView('drive') : loadDrive();
      // 목록이 도착하면 그 행의 버전 식별까지 있어 연다 (뷰어 저장 시
      // base_version 동기 토글은 걸리게). 행을 못 찾으면 전달받은
      // 정보만으로 연다 (버전 없는 구 저장소 백업·하위 호환으로 받는다).
      Promise.resolve(loaded).then(function () {
        var files = (state.listing && state.listing.files) || [];
        for (var i = 0; i < files.length; i++) {
          if (String(files[i].id) === String(target.fileId)) {
            openFile(normalizeFile(files[i]));
            return;
          }
        }
        openFile({ fileId: target.fileId, name: target.name || '', mime: target.mime || '' });
      });
    }

    // ---- 내부 드래그 이동: 행을 폴더로 파일이 뽑으면 move API로 보낸다 ----
    // 내부 파일 드롭(업로드)과는 DataTransfer 으로 명확히 가른다:
    // 내는 'Files', 는 아래 커스텀 만 남는다. getData는 drop
    // 전까지 읽을 수 없으므로 드래그 상태를 두 클로저가 잡고, 타입은
    // "여기서 시작된 드래그인가"를 판정자만 낸다. 목적지는 폴더 행과
    // 경로 슬래시·사이드바 폴더가 공유하는 data-move-target 식별이다.
    var MOVE_TYPE = 'application/x-myhub-finder-items';
    var dragItems = null; // [{ kind, id, name, from }] 형태 from: 현재 부모 폴더 id (null=루트)
    var moveHotEl = null;

    function setMoveHot(el) {
      if (moveHotEl === el) return;
      if (moveHotEl) moveHotEl.classList.remove('dt-drop-target-hot');
      moveHotEl = el || null;
      if (moveHotEl) moveHotEl.classList.add('dt-drop-target-hot');
    }

    function hasMoveType(dt) {
      if (!dt || !dt.types) return false;
      for (var i = 0; i < dt.types.length; i++) {
        var t = typeof dt.types.item === 'function' ? dt.types.item(i) : dt.types[i];
        if (t === MOVE_TYPE) return true;
      }
      return false;
    }

    function moveZoneOf(e) {
      var t = e && e.target;
      if (!t || typeof t.closest !== 'function') return null;
      var el = t.closest('[data-move-target]');
      if (!el) return null;
      var raw = el.getAttribute('data-move-target');
      if (raw === null || raw === '') return null;
      return {
        el: el,
        id: raw === 'root' ? null : Number(raw),
        name: el.getAttribute('data-move-name') || '폴더',
      };
    }

    /** 목적지 로 들어가는지 (클라이언트 1차 판정): 자기 자신 것
     *  위 아래 그 폴더에 있는 경우는 막는다. 즐겨찾기처럼 후보를
     *  모든 바깥 영역에 대한 하위 폴더 순환 여부는, 서버가 거부하고
     *  moveItemsTo가 고정으로 알려준다. */
    function moveTargetOk(targetId) {
      if (!dragItems || !dragItems.length) return false;
      for (var i = 0; i < dragItems.length; i++) {
        if (dragItems[i].kind === 'folder' && dragItems[i].id === targetId) return false;
      }
      return dragItems.some(function (it) {
        return it.from !== targetId;
      });
    }

    function onRowDragStart(ev, row, rows) {
      var targets = [row];
      if (state.selected[row.key]) {
        var sel = selectedRows(rows).filter(function (r) {
          return r.kind === 'folder' || r.kind === 'file';
        });
        if (sel.length > 1) targets = sel;
      }
      dragItems = targets.map(function (r) {
        return {
          kind: r.kind,
          id: r.kind === 'folder' ? r.folderId : r.fileId,
          name: r.name,
          from: r.kind === 'file' ? r.folderId : currentFolder().id,
        };
      });
      try {
        ev.dataTransfer.setData(
          MOVE_TYPE,
          JSON.stringify(
            dragItems.map(function (it) {
              return { kind: it.kind, id: it.id };
            }),
          ),
        );
        ev.dataTransfer.effectAllowed = 'move';
      } catch (err) {
        console.warn('드래그 데이터 설정 실패:', err);
      }
      targets.forEach(function (r) {
        var el = listEl ? listEl.querySelector('[data-key="' + r.key + '"]') : null;
        if (el) el.classList.add('is-dragging');
      });
    }

    function onRowDragEnd() {
      dragItems = null;
      setMoveHot(null);
      if (listEl) {
        Array.prototype.forEach.call(listEl.querySelectorAll('.is-dragging'), function (el) {
          el.classList.remove('is-dragging');
        });
      }
    }

    /** 이동 실행: 성공·실패를 무관하게 마지막에야 서버 상태로 목록을
     *  다시 읽는다 — 실패한 항목은 제 자리에 합쳐 보여주고 원상이다. */
    function moveItemsTo(items, zone) {
      var todo = items.filter(function (it) {
        return it.from !== zone.id;
      });
      if (!todo.length) {
        state.actionMsg = '이미 ' + zone.name + '에 있는 항목입니다';
        render();
        return;
      }
      var okCount = 0;
      var failReason = '';
      var chain = Promise.resolve();
      todo.forEach(function (it) {
        chain = chain.then(function () {
          var isFolder = it.kind === 'folder';
          var url = isFolder
            ? '/api/drive/folders/' + it.id + '/move'
            : '/api/drive/files/' + it.id + '/move';
          var payload = isFolder ? { parent_id: zone.id } : { folder_id: zone.id };
          return fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
            .then(function (res) {
              return res
                .json()
                .catch(function () {
                  return null;
                })
                .then(function (body) {
                  if (res.ok && body && body.ok) {
                    okCount += 1;
                    return;
                  }
                  var err = body && body.error ? String(body.error) : '';
                  if (err.indexOf('subfolder') >= 0 || err.indexOf('itself') >= 0) {
                    failReason = '폴더를 자기 하위 폴더로 둘 수 없습니다';
                  } else if (!failReason) {
                    failReason = '서버가 거부했습니다 (' + res.status + ')';
                  }
                });
            })
            .catch(function () {
              if (!failReason) failReason = '서버와 연결하지 못했습니다';
            });
        });
      });
      chain.then(function () {
        clearSelection();
        var failed = todo.length - okCount;
        if (okCount && !failed) {
          state.actionMsg = todo.length + '개 항목을 옮겼습니다 (' + zone.name + ')';
        } else if (okCount) {
          state.actionMsg =
            okCount + '개 옮겼습니다 · ' + failed + '개 실패' + (failReason ? ' (' + failReason + ')' : '');
        } else {
          state.actionMsg = '옮기지 못했습니다' + (failReason ? ' (' + failReason + ')' : '');
        }
        return state.view === 'recent' ? loadRecent() : loadDrive();
      });
    }

    doc.addEventListener('dragover', function (e) {
      if (!dragItems || !hasMoveType(e.dataTransfer)) return;
      var zone = moveZoneOf(e);
      if (!zone || !moveTargetOk(zone.id)) {
        setMoveHot(null);
        return;
      }
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'move';
      } catch (err) {
        console.warn('dropEffect 설정 실패 (무시하고 계속):', err);
      }
      setMoveHot(zone.el);
    });
    doc.addEventListener('dragleave', function (e) {
      if (!e.relatedTarget) setMoveHot(null);
    });
    doc.addEventListener('drop', function (e) {
      if (!dragItems || !hasMoveType(e.dataTransfer)) return;
      var zone = moveZoneOf(e);
      if (!zone || !moveTargetOk(zone.id)) return;
      e.preventDefault();
      var items = dragItems;
      setMoveHot(null);
      moveItemsTo(items, zone);
    });

    // ---- OS 파일 드롭: 닿는 자리가 목적지다 ----
    // 폴더 항목 위에 뽑으면 그 폴더로, 그 밖은 현재 폴더로 올라간다.
    // 업로드 두(분류·순서·진행)는 데스크톱과 같은 createDropUpload를
    // 공유하고, 알림만 파인더 상태 줄로 바꾼다. 휴지통·최근 항목
    // 보기에서는 받지 않고(shouldAccept), 는 파일을 여는
    // 기본 동작인 모듈이 막고 거부 사유는 onRejectedDrop로 고정한다.
    // 검색 결과에서는 폴더 만 받고 명시된,-드롭은 resolveFolderId가
    // 사유를 서면 거부한다 (현재 폴더가 화면에 보이지 않으므로).
    var dropManager = null;
    var dropApi =
      deps.dropApi || (typeof window !== 'undefined' ? window.MyHubDesktopDrop : null);
    if (dropApi && typeof dropApi.createDropUpload === 'function' && listEl) {
      var folderRowOf = function (e) {
        var t = e && e.target;
        var row = t && typeof t.closest === 'function' ? t.closest('.finder-row') : null;
        return row && row.dataset && row.dataset.kind === 'folder' ? row : null;
      };
      dropManager = dropApi.createDropUpload({
        doc: doc,
        overlay: 'none',
        customNotify: true,
        shouldAccept: function () {
          return state.view === 'drive';
        },
        onRejectedDrop: function () {
          state.actionMsg =
            state.view === 'trash'
              ? '휴지통에서는 파일을 올릴 수 없습니다'
              : '이 보관함에서는 파일을 올릴 수 없습니다 (보관함에서 올려 주세요)';
          render();
        },
        highlightTarget: function (e) {
          return folderRowOf(e);
        },
        resolveFolderId: function (e) {
          var row = folderRowOf(e);
          if (row && row.dataset.folderId) return Number(row.dataset.folderId);
          if (state.search) {
            // 검색 결과에서 "현재 폴더"는 화면에 보이지 않는다 — 배경에
            // 뽑으면 검색 위에 있던 폴더로 조용히 올라간 버린다. 폴더 외
            // 곳(명시적인 대상)만 허용하고, 그 밖은 사유를 서면 거부한다
            // (drop-upload은 두 항목 실패로 고정하는 경로).
            return Promise.reject(
              new Error('검색 결과에서는 폴더 위에 뽑거나, 검색을 끝낸 뒤에 올려 주세요'),
            );
          }
          return currentFolder().id;
        },
        uploadFile: function (file, folderId) {
          var fd = new FormData();
          fd.append('files', file);
          if (folderId !== null && folderId !== undefined) fd.append('folder_id', String(folderId));
          return fetchFn('/api/drive/files', { method: 'POST', body: fd }).then(function (res) {
            return res
              .json()
              .catch(function () {
                return null;
              })
              .then(function (body) {
                if (res.ok && body && body.ok) return body;
                throw new Error(
                  body && body.error ? String(body.error) : '업로드에 실패했습니다 (' + res.status + ')',
                );
              });
          });
        },
        onProgress: function (file, n, total) {
          state.actionMsg = '올리는 중… ' + file.name + ' (' + n + '/' + total + ')';
          render();
        },
        onDone: function (summary) {
          if (summary.ok > 0 && summary.failures.length) {
            state.actionMsg =
              '파일 ' + summary.ok + '개를 올렸습니다 · ' + summary.failures.length + '개 실패 (' +
              summary.failures[0].name + ' 외 ' + summary.failures[0].reason + ')';
          } else if (summary.ok > 0) {
            state.actionMsg = '파일 ' + summary.ok + '개를 올렸습니다';
          } else if (summary.failures.length) {
            state.actionMsg =
              '업로드에 실패했습니다 (' + summary.failures[0].name + ' 외 ' + summary.failures[0].reason + ')';
          }
          // 검색 모드에서는 같은 검색어로 다시 조회해 결과가 늦지
          // 않게 한다 (앱 동작와 같은 새로고침 계약).
          reloadListing();
        },
      });
    }

    // 창 상단 메뉴바 정의 (계약: js/desktop/windows.js 상단 주석).
    // 명령은 배경 우클릭 메뉴·검색과 같은 내부 동작을 사용하고,
    // 이동 메뉴는 두 클릭 사이드바 항목을 읽어 드롭다운 안에 렌더한다.
    // 항목 함수은 메뉴를 열 때 평가하므로 상태는 항상 최신이다.
    var menuWin =
      (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (menuWin) {
      menuWin.MyHubMenus = [
        {
          label: '파일',
          items: function () {
            return [
              {
                label: '새 폴더',
                disabled: state.view !== 'drive',
                run: function () {
                  createFolder();
                },
              },
              {
                label: '파일 올리기',
                disabled: state.view !== 'drive',
                run: function () {
                  if (fileInput) fileInput.click();
                },
              },
              {
                // 창 검색 메뉴에도 명령이 있어야 한다 (HIG 정합).
                // 창 바 호스트 중이면 두 필드를 이동으로 알리고, 아니면
                // 자체 검색 입력에 포커스한다.
                label: '검색',
                run: function () {
                  if (toolbarHosted) {
                    postToParent({ type: 'myhub:finder-toolbar-focus-search' });
                  } else if (finderQ) {
                    finderQ.focus();
                  }
                },
              },
              { separator: true },
              {
                label: '휴지통 비우기',
                danger: true,
                disabled: state.view !== 'trash',
                run: function () {
                  emptyTrashAll();
                },
              },
            ];
          },
        },
        {
          label: '보기',
          items: function () {
            var items = [
              {
                label: '목록으로 보기',
                checked: state.mode === 'list',
                run: function () {
                  if (modeListBtn) modeListBtn.click();
                },
              },
              {
                label: '아이콘으로 보기',
                checked: state.mode === 'grid',
                run: function () {
                  if (modeGridBtn) modeGridBtn.click();
                },
              },
              { separator: true },
            ];
            sortMenuItems().forEach(function (it) {
              items.push({ label: it.label, checked: it.checked, run: it.onSelect });
            });
            items.push({ separator: true });
            items.push({
              label: '오름차순',
              checked: state.sortDir === 1,
              run: function () {
                state.sortDir = 1;
                render();
              },
            });
            items.push({
              label: '내림차순',
              checked: state.sortDir === -1,
              run: function () {
                state.sortDir = -1;
                render();
              },
            });
            return items;
          },
        },
        {
          label: '이동',
          items: function () {
            var items = [
              {
                label: '뒤로',
                disabled: state.hIndex <= 0,
                run: function () {
                  goBack();
                },
              },
              {
                label: '앞으로',
                disabled: state.hIndex >= state.history.length - 1,
                run: function () {
                  goFwd();
                },
              },
              { separator: true },
            ];
            Array.prototype.forEach.call(
              doc.querySelectorAll('.finder-side-item'),
              function (b) {
                if (b.hidden) return;
                var label = b.getAttribute('title') || (b.textContent || '').trim();
                if (!label) return;
                items.push({
                  label: label,
                  run: function () {
                    b.click();
                  },
                });
              },
            );
            return items;
          },
        },
        // 도움말: 운영 정본 상단바 [파일·보기·이동·도움말]의 4번째 메뉴였으나
        // 항목 내용이 원본 자료 어디에도 없어 미회수 — 빈 라벨만 게시돼
        // 눌러도 아무 일도 안 하던 것을 2026-11-12 사용자 결정으로 제거한다
        // (게시하는 메뉴는 전부 실동작해야 한다).
      ];
    }

    return {
      loadDrive: loadDrive,
      setView: setView,
      setAppsCatalog: setAppsCatalog,
      setFilter: setFilter,
      showSearch: showSearch,
      revealFile: revealFile,
      openFileTarget: openFileTarget,
      dropManager: dropManager,
      toggleFavorite: toggleFavorite,
      handleToolbarMessage: handleToolbarMessage,
      republishDocTitle: publishDocTitle,
      refreshIconTrash: function () {
        state.iconTrash = readIconTrash();
        if (state.view === 'trash') render();
      },
      getState: function () {
        return {
          view: state.view,
          favorites: state.favorites.map(function (f) {
            return { id: f.id, name: f.name };
          }),
          usage: state.usage,
          iconTrashCount: state.iconTrash.length,
          stack: state.stack.map(function (s) {
            return { id: s.id, name: s.name };
          }),
          filter: state.filter,
          search: state.search
            ? { query: state.search.query, total: state.search.total, loading: state.search.loading }
            : null,
          selectedCount: Object.keys(state.selected).length,
          sortKey: state.sortKey,
          sortDir: state.sortDir,
          mode: state.mode,
          canBack: state.hIndex > 0,
          canFwd: state.hIndex < state.history.length - 1,
        };
      },
      ready: loadDrive().then(function () {
        if (!state.history.length) pushHistory();
      }),
    };
  }

  var api = {
    normalizeFolder: normalizeFolder,
    normalizeFile: normalizeFile,
    officeAppFor: officeAppFor,
    kindLabelFor: kindLabelFor,
    fmtDateKo: fmtDateKo,
    fmtDate: fmtDate,
    fmtSize: fmtSize,
    parseOpenTarget: parseOpenTarget,
    createApp: createApp,
  };
  if (typeof window !== 'undefined') window.MyHubFinder = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFinder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined' && document.getElementById('finderList')) {
    var savedHook = { fn: null };
    var bootViewer = null;

    // ━ 뷰어 파일 계약을 호스트 쪽 (한글 Studio embed그림 삽입) ━
    // 뷰어 코어는 열기·그림 요청을 루트 이벤트로 알리기만 한다 —
    // 실제 다이얼로그는 호스트가 연다 (오피스의 office.js와 같은 계약).
    // Finder의 공용 다이얼(office-picker.js 등 finder.html의 내부
    // 넣는다)를 자기 호스트이스로 만들지 않는다. 다이얼은 처음 필요할
    // 때만 만든다.
    var hostPicker = null;
    function getHostPicker() {
      if (hostPicker) return hostPicker;
      var factory =
        typeof window !== 'undefined' && window.MyHubOfficePicker
          ? window.MyHubOfficePicker.createPicker
          : null;
      if (!factory || !document.getElementById('officePicker')) return null;
      hostPicker = factory({
        doc: document,
        icons: typeof window !== 'undefined' ? window.MyHubFileIcons || null : null,
        exts: [],
        appKey: 'finder',
        newTitle: '제목 없음',
        newExt: '',
        listFolder: function (id) {
          return fetch('/api/drive/list' + (id ? '?folder=' + id : '')).then(function (res) {
            if (!res || !res.ok) throw new Error('list http ' + (res && res.status));
            return res.json();
          });
        },
        loadLastFolder: function () {
          try {
            var raw = window.localStorage.getItem('myhub.finder.pickerFolder.v1');
            return raw ? JSON.parse(raw) : null;
          } catch (e) {
            return null;
          }
        },
        saveLastFolder: function (v) {
          try {
            if (v) window.localStorage.setItem('myhub.finder.pickerFolder.v1', JSON.stringify(v));
            else window.localStorage.removeItem('myhub.finder.pickerFolder.v1');
          } catch (e) {
            // 기억 실패는 다이얼 동작을 막지 않는다
            console.warn('다이얼 폴더 기억 실패(무시):', e);
          }
        },
        // 다이얼은 "새 기기에서 가져오기": 기기 파일을 보관함 폴더에
        // 올린다 (오피스와 같은 POST 계약 — 가져오기는 분리된 경로).
        importFile: function (file, folderId) {
          var fd = new FormData();
          fd.append('files', file, file.name);
          if (folderId) fd.append('folder_id', String(folderId));
          return fetch('/api/drive/files', { method: 'POST', body: fd })
            .then(function (res) {
              if (!res || !res.ok) throw new Error('import http ' + (res && res.status));
              return res.json();
            })
            .then(function (body) {
              var saved = body && body.files && body.files[0];
              if (!body || !body.ok || !saved) throw new Error('import shape');
              return { id: saved.id, filename: saved.filename || file.name };
            });
        },
      });
      return hostPicker;
    }

    // 다른 이름으로 다이얼 문서 첫 저장의 생성 흐름 (뷰어 코어의
    // createSave 계약): 이름·폴더는 공용 다이얼이 정하고, 생성 뒤에
    // 파일 객체는 실제 id·이름을 넣는다. 한글 Studio는 다른
    // 이름으로 저장 바인딩은 언제든 HWPX며, 이름이 확장자가 없거나
    // .hwp면 .hwpx로 맞춘다 (오피스 한글 앱과 같은 규칙 — 이름과
    // 형식은 동기한 파일을 생기지 않게). version 넣기는 최선
    // 노력이다: 실패해도 저장은 성공하고 다음 저장 base_version
    // 없는 PUT를 쓴다 (office createSaveFlow와 같은 계약).
    function finderCreateSave(blob, file, ctx) {
      var picker = getHostPicker();
      if (!picker) {
        ctx.setStatus('여기서는 다른 이름으로 저장할 수 없습니다');
        return Promise.resolve(false);
      }
      return picker.open('save', { initialName: file.name }).then(function (sel) {
        if (!sel) {
          ctx.setStatus('저장을 취소했습니다');
          return false;
        }
        var name = sel.name;
        if (file.kind === 'hwp' || file.kind === 'hwpx') {
          var m = /\.([a-z0-9]+)$/i.exec(name);
          if (!m) name += '.hwpx';
          else if (m[1].toLowerCase() === 'hwp') {
            name = name.slice(0, name.length - m[1].length) + 'hwpx';
          }
        }
        var fd = new FormData();
        fd.append('files', blob, name);
        if (sel.folderId) fd.append('folder_id', String(sel.folderId));
        return fetch('/api/drive/files', { method: 'POST', body: fd })
          .then(function (res) {
            if (!res || !res.ok) throw new Error('create http ' + (res && res.status));
            return res.json();
          })
          .then(function (body) {
            var saved = body && body.files && body.files[0];
            if (!body || !body.ok || !saved) throw new Error('create shape');
            file.fileId = saved.id;
            file.name = name;
            file.version = null;
            var nameEl = document.getElementById('fvName');
            if (nameEl) nameEl.textContent = name;
            return fetch('/api/drive/list' + (sel.folderId ? '?folder=' + sel.folderId : ''))
              .then(function (res) {
                return res && res.ok ? res.json() : null;
              })
              .then(function (listing) {
                var row = ((listing && listing.files) || []).filter(function (f) {
                  return f.id === saved.id;
                })[0];
                if (row) file.version = row.version || null;
              })
              .catch(function (e) {
                // 넣기 실패는 저장 성공과 섞이지 않는다
                console.warn('저장 뒤 파일 정보 넣기 실패(무시):', e);
              })
              .then(function () {
                return true;
              });
          })
          .catch(function () {
            ctx.setStatus('저장에 실패했습니다');
            return false;
          });
      });
    }

    // ━ 커스텀 다이얼로그 (다이얼로그 prompt/confirm 교체) ━
    // 이름 변경·새 폴더는 입력 모달로, 휴지통 비우기는 확인 모달로
    // 연다. 계약은 다이얼로그와 같다: prompt는 확인 뒤 문자열 을
    // null, confirm은 true/false. 두 두 Promise를 알려주며 호출은
    // 직접화해 모달은 겹치지 않는다. DOM은 처음 볼 때만 만든다.
    function createFinderDialogs() {
      var backdrop = null;
      var titleEl = null;
      var msgEl = null;
      var inputEl = null;
      var okBtn = null;
      var cancelBtn = null;
      var settleCurrent = null;
      var lastFocus = null;
      var queue = Promise.resolve();

      function build() {
        backdrop = document.createElement('div');
        backdrop.className = 'finder-dialog-backdrop';
        backdrop.hidden = true;
        var panel = document.createElement('div');
        panel.className = 'finder-dialog';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        titleEl = document.createElement('strong');
        titleEl.className = 'finder-dialog-title';
        msgEl = document.createElement('p');
        msgEl.className = 'finder-dialog-msg';
        inputEl = document.createElement('input');
        inputEl.className = 'finder-dialog-input';
        inputEl.type = 'text';
        inputEl.setAttribute('autocomplete', 'off');
        var foot = document.createElement('div');
        foot.className = 'finder-dialog-foot';
        cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'finder-dialog-btn';
        cancelBtn.textContent = '취소';
        okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'finder-dialog-btn is-primary';
        okBtn.textContent = '확인';
        foot.appendChild(cancelBtn);
        foot.appendChild(okBtn);
        panel.appendChild(titleEl);
        panel.appendChild(msgEl);
        panel.appendChild(inputEl);
        panel.appendChild(foot);
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        cancelBtn.addEventListener('click', function () {
          close(false);
        });
        okBtn.addEventListener('click', function () {
          close(true);
        });
        backdrop.addEventListener('mousedown', function (e) {
          if (e.target === backdrop) close(false);
        });
        backdrop.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            e.preventDefault();
            close(false);
          } else if (e.key === 'Enter' && e.target === inputEl) {
            e.preventDefault();
            close(true);
          }
        });
      }

      function close(accepted) {
        if (!settleCurrent) return;
        var settle = settleCurrent;
        settleCurrent = null;
        backdrop.hidden = true;
        if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
        settle(accepted);
      }

      function show(spec) {
        return new Promise(function (resolve) {
          if (!backdrop) build();
          lastFocus = document.activeElement;
          titleEl.textContent = spec.title || '';
          titleEl.hidden = !spec.title;
          msgEl.textContent = spec.message || '';
          msgEl.hidden = !spec.message;
          inputEl.hidden = !spec.input;
          okBtn.classList.toggle('is-danger', !!spec.danger);
          settleCurrent = function (accepted) {
            if (!accepted) resolve(spec.input ? null : false);
            else resolve(spec.input ? inputEl.value : true);
          };
          if (spec.input) inputEl.value = spec.def || '';
          backdrop.hidden = false;
          if (spec.input) {
            inputEl.focus();
            inputEl.select();
          } else {
            // 위험 확인는 순수로 Enter가 눌려도 실행하지 않게 취소 쪽에 둔다
            cancelBtn.focus();
          }
        });
      }

      function enqueue(spec) {
        var run = queue.then(function () {
          return show(spec);
        });
        // 두 자체는 실패로 알리지 않게 한다 (show는 항상 resolve한다)
        queue = run.then(function () { return undefined; });
        return run;
      }

      return {
        promptDialog: function (label, def) {
          return enqueue({ title: label, input: true, def: def });
        },
        confirmDialog: function (message) {
          return enqueue({ title: '휴지통 비우기', message: message, danger: true });
        },
      };
    }
    var bootDialogs = createFinderDialogs();

    // ━ 형식 모듈 지연 로드 ━
    // finder.html은 형식 모듈을 정적으로 넣지 않는다 — 파일이 실제로
    // 열 때 뷰어 코어의 ensureFormat 훅이 이 로더로 해당 모듈만
    // import한다 (목록만 열면 벤더·형식 요청이 0건이다). 모듈은
    // 평가하며 registerFormat으로 등록하는데, 로드 시점에 정제
    // 전역의 캡처하는 모듈이 있어 순서가 계약이다: pptx는 deckcraft
    // 호스트가 먼저, pdf는 pdf-ops·pdfcraft 호스트가 먼저다.
    var FORMAT_MODULE_URLS = {
      text: ['/js/finder-format-text.js'],
      csv: ['/js/finder-format-text.js'],
      hwp: ['/js/finder-format-hwp.js'],
      hwpx: ['/js/finder-format-hwp.js'],
      xlsx: ['/js/finder-format-sheet.js'],
      xls: ['/js/finder-format-sheet.js'],
      pptx: ['/js/craft-prefetch-core.js', '/js/finder-deckcraft.js', '/js/finder-format-slide.js'],
      docx: ['/js/finder-format-doc.js'],
      pdf: ['/js/finder-pdf-ops.js', '/js/craft-prefetch-core.js', '/js/finder-pdfcraft.js', '/js/finder-format-pdf.js'],
    };
    // 동적 로딩 URL은 공용 핼퍼(asset-url.js)가 배포 버전을 붙인다
    // (N-06 — 버전 없는 URL은 immutable 캐시가 고정할 수 있다).
    // 핼퍼가 없는 환경(테스트 등)에서는 원본 URL 그대로이다.
    function versionedAssetUrl(url) {
      var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
      return typeof h === 'function' ? h(url) : url;
    }
    var formatModuleLoading = {};
    function loadFormatModule(url) {
      if (!formatModuleLoading[url]) formatModuleLoading[url] = import(versionedAssetUrl(url));
      return formatModuleLoading[url];
    }
    function ensureFormatModules(kind) {
      var urls = FORMAT_MODULE_URLS[kind];
      if (!urls) return Promise.resolve();
      var chain = Promise.resolve();
      urls.forEach(function (url) {
        chain = chain.then(function () {
          return loadFormatModule(url);
        });
      });
      return chain;
    }
    // 지연 로더를 밖에서도 검증·사용할 수 있게 붙여 둔다
    if (typeof window !== 'undefined' && window.MyHubFinder) {
      window.MyHubFinder.ensureFormatModules = ensureFormatModules;
    }

    // ━ 엔진 프리패치 (목록의 파일이 보일 때만) ━
    // 목록에 시트·슬라이드 파일이 실제로 렌더될 때만 해당 엔진을
    // 프리패치 모듈을 불러 캐시를 데운다 (모듈은 유효 시간을 받는다).
    // 그런 파일이 없으면 어떤 벤더 요청도 하지 않는다.
    var PREFETCH_MODULE_URLS = {
      gridcraft: '/js/gridcraft-prefetch.js',
      deckcraft: '/js/deckcraft-prefetch.js',
    };
    // 프리패치 래퍼는 공용 코어(craft-prefetch-core.js) 위에서 돈다 —
    // 동적 import도 코어를 먼저 받아야 래퍼의 자동 부팅이 동작한다.
    // 코어 import는 모듈 맵이 중복을 막아 두 엔진이 나눠 받아도 한 번만
    // 실행된다.
    var PREFETCH_CORE_URL = '/js/craft-prefetch-core.js';
    function startEnginePrefetch(engines) {
      engines.forEach(function (engine) {
        var url = PREFETCH_MODULE_URLS[engine];
        if (!url) return;
        import(versionedAssetUrl(PREFETCH_CORE_URL))
          .then(function () {
            return import(versionedAssetUrl(url));
          })
          .catch(function () {
            return null; // 프리패치는 최적화일 뿐 — 실패해도 열기 경로는 무관하다
          });
      });
    }

    if (typeof window !== 'undefined' && window.MyHubFinderViewer) {
      bootViewer = window.MyHubFinderViewer.createViewer({
        doc: document,
        // 한글 Studio 파일 계약: Finder에서도 Studio를 embed로
        // 열고 메뉴 확장은 배선한다 (자체 열기·저장이 OS로 있는
        // 경로 차단). 뷰어 자체 설계는 Finder 그대로이다.
        studioEmbed: true,
        createSave: finderCreateSave,
        ensureFormat: ensureFormatModules,
        onSaved: function () {
          if (savedHook.fn) savedHook.fn();
        },
      });
    }

    // 뷰어 루트 이벤트의 호스트 수신부 (오피스 office.js와 같은 배선)
    if (bootViewer) {
      var viewerRootEl = document.getElementById('finderViewer');
      if (viewerRootEl) {
        // 열기 신호: 다이얼로 고른 파일을 뷰어로 연다 (형식 판정은
        // 뷰어 코어의 분류가 맡는다).
        viewerRootEl.addEventListener('myhub:request-open', function () {
          var picker = getHostPicker();
          if (!picker) return;
          picker.open('open').then(function (sel) {
            if (!sel) return;
            bootViewer.open({
              fileId: sel.fileId,
              name: sel.name,
              mime: sel.mime || '',
              version: sel.version || null,
            });
          });
        });
        // 그림 삽입 귀결: 고른 그림을 바인딩 deliver로 서면에
        // 알려준다. 취소·실패면 deliver를 부르지 않는다 (무응답
        // 취소 계약). 옵션은 office-picker.js와 공용 정보를 낸다 —
        // 오피스와 Finder가 같은 그림 형식을 본다.
        viewerRootEl.addEventListener('myhub:request-picture', function (e) {
          var deliver = e && e.detail && e.detail.deliver;
          if (typeof deliver !== 'function') return;
          var picOpts =
            typeof window !== 'undefined' && window.MyHubOfficePicker
              ? window.MyHubOfficePicker.PICTURE_PICK_OPTS
              : null;
          var picker = getHostPicker();
          if (!picker || !picOpts) return;
          picker.open('open', picOpts).then(function (sel) {
            if (!sel) return;
            return fetch('/api/drive/files/' + sel.fileId + '/content')
              .then(function (res) {
                if (!res || !res.ok) throw new Error('picture http ' + (res && res.status));
                return res.arrayBuffer();
              })
              .then(function (bytes) {
                if (bytes) deliver(sel.name, bytes);
              })
              .catch(function (e) {
                // 실패하면 서면에 보내지 않는다 — 삽입 쪽에 값이
                // 없는 것을 취소로 낸다.
                console.warn('그림 전달 실패 — 취소로 처리:', e);
              });
          });
        });
      }
    }
    var bootApp = createApp({
      doc: document,
      viewer: bootViewer,
      promptFn: bootDialogs.promptDialog,
      confirmFn: bootDialogs.confirmDialog,
      prefetchEngines: startEnginePrefetch,
    });
    // 비서 도구 브리지·노바 서면은 현재 폴더 조회·목록 새로고침을 낸다
    if (typeof window !== 'undefined') window.MyHubFinderApp = bootApp;
    // 비서 진입(uiAction 브리지)는 Finder 진입의 두 노바의 파일
    // 검색 도구 결과를 실제 화면에 표시한다 (assistant-widget.js가
    // window.openPane을 부르는 것과 같은 계약).
    if (typeof window !== 'undefined') {
      window.myhubFinderSearch = function (query) {
        bootApp.showSearch(query);
      };
      window.myhubFinderReveal = function (fileId, folderId, path) {
        bootApp.revealFile(fileId, folderId, path);
      };
    }
    savedHook.fn = function () {
      bootApp.loadDrive();
    };

    // 특정 파일 열기 진입점: 단독 페이지면 쿼리(?folder=&file=)를,
    // 데스크톱 창 안이면 부모에게 postMessage 핸드셰이크 낸다.
    // 부모는 열기를 요청하고, 파인더는 ready로 준비를 알리고
    // open-file을 처리한 뒤 ack를 알려준다 (전달 유실·중복 방지).
    var bootTarget = parseOpenTarget(typeof location !== 'undefined' ? location.search : '');
    if (bootTarget) bootApp.openFileTarget(bootTarget);
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.addEventListener('message', function (e) {
        if (e.origin !== window.location.origin) return;
        var d = e.data;
        if (!d) return;
        // 응용 프로그램 보관함: 부모가 내려준 실제 앱 카탈로그를
        if (d.type === 'myhub:apps') {
          bootApp.setAppsCatalog(d.apps);
          return;
        }
        // 두 휴지통 클릭 뒤: 부모가 특정 보관함을 이라고 요청한다
        if (d.type === 'myhub:open-view') {
          if (d.view === 'drive' || d.view === 'recent' || d.view === 'trash') {
            bootApp.setView(d.view);
            try {
              window.parent.postMessage(
                { type: 'myhub:open-view-ack', view: d.view },
                window.location.origin,
              );
            } catch (err) {
              console.warn('보관함 열기 확인 전송 실패:', err);
            }
          }
          return;
        }
        // 데스크톱 쪽에서는 아이콘 휴지통이 바뀌면 열린 휴지통 보관함을 맞춘다
        if (d.type === 'myhub:icon-trash-changed') {
          bootApp.refreshIconTrash();
          return;
        }
        // 창 바 두 호스트: 채워진 뒤의 창 바 컨트롤의 동작 귀결
        if (d.type === 'myhub:finder-toolbar-adopt' || d.type === 'myhub:finder-toolbar-action') {
          bootApp.handleToolbarMessage(d);
          return;
        }
        // 호스트 제목 하귀는 요청 (load 순서 경합은 자기치유)
        if (d.type === 'myhub:request-doc-title') {
          bootApp.republishDocTitle();
          return;
        }
        if (d.type !== 'myhub:open-file') return;
        bootApp.openFileTarget({
          folderId: d.folderId,
          folderName: d.folderName,
          fileId: d.fileId,
          name: d.name,
          mime: d.mime,
        });
        try {
          window.parent.postMessage(
            { type: 'myhub:open-file-ack', fileId: d.fileId },
            window.location.origin,
          );
        } catch (err) {
          console.warn('파일 열기 확인 전송 실패:', err);
        }
      });
      try {
        window.parent.postMessage({ type: 'myhub:finder-ready' }, window.location.origin);
      } catch (err) {
        console.warn('파인더 준비 알림 실패:', err);
      }
    }
  }
})();
