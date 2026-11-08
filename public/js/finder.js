/* MyHub Finder — Drive 기반 파일 관리자 (v3).
 *
 * 재구성 근거 (D-15·D-22 최종 계약):
 * - 사이드바 = 즐겨찾기(최근 항목·바탕화면·동적 즐겨찾기·휴지통) + 위치(보관함
 *   + 사용량 캡션 "파일 N개 · X 사용 중", GET /api/drive/usage).
 * - 즐겨찾기 저장 'myhub.finder.favorites.v1' [{id,name}] — 폴더 우클릭 토글,
 *   사이드바 우클릭 제거, 이름 변경 추종, 사라진 폴더는 자동 정리.
 * - 전역 검색: 전체 보관함 대상, 결과에 소속 폴더 표시, 클릭 시 이동+선택.
 * - 목록: 열 헤더 정렬, 줄무늬 행, 파란 선택, 클릭 선택·더블클릭 열기,
 *   하단 바는 경로 + 상태('N개 중 M개 선택') 한 줄. 행 아이콘은 file-icons
 *   kind SVG 22px (틴트 배경 없음).
 * - 휴지통 보기: Drive 휴지통 + 바탕화면 아이콘 휴지통(kind 'icontrash') 통합.
 *   아이콘 항목 복원·삭제는 셸에 postMessage로 위임한다.
 * - 셸 핸드셰이크: 'myhub:finder-ready' 게시, 'myhub:open-view'/'myhub:open-file'
 *   수신 + ack. 창 도구는 'myhub:win-tools'로 제목줄에 게시한다.
 * - 오피스 파일 더블클릭은 해당 오피스 앱으로 연다.
 */
(function () {
  'use strict';

  var FAV_KEY = 'myhub.finder.favorites.v1';
  var ICON_TRASH_KEY = 'myhub.desktop.trash.v1';

  // 서버 계약 (src/modules/drive/routes.ts): 통합 tree 엔드포인트는 없다.
  // 목록=/list, 최근=/recent, 휴지통=/trash 로 나뉘어 있고, 파일 항목은
  // filename/created_at 필드로 온다 — 화면이 쓰는 name/updated_at으로 맞춘다.
  function normFolder(f) {
    return Object.assign({}, f, { updated_at: f.updated_at || f.created_at || null });
  }
  function normFile(f) {
    return Object.assign({}, f, {
      name: f.name || f.filename || '',
      updated_at: f.updated_at || f.created_at || null,
    });
  }
  function normList(d) {
    d = (d && (d.data || d)) || {};
    return {
      folder: d.folder || null,
      folders: (d.folders || []).map(normFolder),
      files: (d.files || []).map(normFile),
    };
  }

  var api = {
    tree: function (folder) {
      var url;
      if (folder === 'recent') url = '/api/drive/recent';
      else if (folder === 'trash') url = '/api/drive/trash';
      else url = '/api/drive/list?folder=' + encodeURIComponent(folder || 'root');
      return fetch(url)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(normList);
    },
    usage: function () {
      return fetch('/api/drive/usage')
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { return (d && (d.data || d)) || {}; });
    },
    search: function (q) {
      return fetch('/api/drive/search?q=' + encodeURIComponent(q))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { return (d && (d.data || d)) || {}; });
    },
    createFolder: function (name, parentId) {
      return fetch('/api/drive/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, parent_id: parentId }),
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    },
    upload: function (file, folderId) {
      var form = new FormData();
      form.append('files', file);
      if (folderId && folderId !== 'root') form.append('folder_id', folderId);
      return fetch('/api/drive/files', { method: 'POST', body: form })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    },
    renameFile: function (id, name) {
      return fetch('/api/drive/files/' + encodeURIComponent(id) + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
    renameFolder: function (id, name) {
      return fetch('/api/drive/folders/' + encodeURIComponent(id) + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
    trashFile: function (id) {
      return fetch('/api/drive/files/' + encodeURIComponent(id) + '/trash', { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
    trashFolder: function (id) {
      return fetch('/api/drive/folders/' + encodeURIComponent(id) + '/trash', { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
    restoreFile: function (id) {
      return fetch('/api/drive/files/' + encodeURIComponent(id) + '/restore', { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
    restoreFolder: function (id) {
      return fetch('/api/drive/folders/' + encodeURIComponent(id) + '/restore', { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
    deleteFile: function (id) {
      return fetch('/api/drive/files/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
    deleteFolder: function (id) {
      return fetch('/api/drive/folders/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },
  };

  var state = {
    view: 'folder', // folder | trash | recent | desktop | search
    folderId: 'root',
    folderName: '보관함',
    path: [{ id: 'root', name: '보관함' }],
    history: [],
    future: [],
    folders: [],
    files: [],
    iconTrash: [],
    selected: {}, // id → true
    sort: { key: 'name', dir: 1 },
    displayMode: 'list', // list | grid (보기 방식 토글)
    query: '',
  };

  var els = {};
  var viewer = null;

  function $(id) { return document.getElementById(id); }
  function bridge() { return window.MyHubBridge || null; }
  function postToShell(msg) { var b = bridge(); if (b) b.post(msg); }

  function fmtSize(n) {
    if (typeof n !== 'number') return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  }

  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  function kindLabel(item) {
    if (item.isFolder) return '폴더';
    var V = window.FinderViewer;
    var kind = V ? V.kindOf(item) : 'unknown';
    return { pdf: 'PDF', hwp: '한글 문서', sheet: '스프레드시트', slide: '프레젠테이션', doc: '워드 문서', image: '이미지', text: '텍스트', unknown: '파일' }[kind] || '파일';
  }

  function officeAppOf(file) {
    var V = window.FinderViewer;
    var kind = V ? V.kindOf(file) : 'unknown';
    return { sheet: 'excel', slide: 'powerpoint', hwp: 'hangul', doc: 'hangul', pdf: 'pdf' }[kind] || null;
  }

  /* ---------- 즐겨찾기 ---------- */

  function loadFavorites() {
    try {
      var raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(function (f) { return f && f.id && f.name; }) : [];
    } catch (e) { return []; }
  }
  function saveFavorites(favs) { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); }
  function isFavorite(id) { return loadFavorites().some(function (f) { return f.id === id; }); }
  function toggleFavorite(folder) {
    var favs = loadFavorites();
    if (isFavorite(folder.id)) favs = favs.filter(function (f) { return f.id !== folder.id; });
    else favs.push({ id: folder.id, name: folder.name });
    saveFavorites(favs);
    renderSidebar();
  }

  /* ---------- 데이터 로드 ---------- */

  function loadCurrent() {
    if (state.view === 'trash') return loadTrashView();
    if (state.view === 'search') return loadSearch(state.query);
    if (state.view === 'desktop') {
      state.folders = [];
      state.files = loadIconTrash().map(function (it) {
        return { id: 'icon:' + it.id, name: it.name || it.id, isDesktopIcon: true, iconItem: it };
      });
      render();
      return Promise.resolve();
    }
    if (state.view === 'recent') {
      return api.tree('recent').then(function (d) {
        state.folders = [];
        state.files = d.files || [];
        render();
      }).catch(showError);
    }
    return api.tree(state.folderId).then(function (d) {
      state.folders = (d.folders || []).map(function (f) {
        return { id: f.id, name: f.name, isFolder: true, updated_at: f.updated_at };
      });
      state.files = d.files || [];
      followFavoriteRenames();
      render();
    }).catch(function (e) {
      // 사라진 폴더를 열고 있으면 즐겨찾기에서 정리하고 보관함으로 돌아간다
      pruneFavorite(state.folderId);
      showError(e);
    });
  }

  function followFavoriteRenames() {
    var favs = loadFavorites();
    var changed = false;
    favs.forEach(function (fav) {
      var match = state.folders.filter(function (f) { return f.id === fav.id; })[0];
      if (match && match.name !== fav.name) { fav.name = match.name; changed = true; }
    });
    if (changed) { saveFavorites(favs); renderSidebar(); }
  }

  function pruneFavorite(id) {
    var favs = loadFavorites().filter(function (f) { return f.id !== id; });
    saveFavorites(favs);
    renderSidebar();
  }

  function loadTrashView() {
    state.iconTrash = loadIconTrash();
    return api.tree('trash').then(function (d) {
      state.folders = (d.folders || []).map(function (f) {
        return { id: f.id, name: f.name, isFolder: true, inTrash: true, updated_at: f.updated_at };
      });
      state.files = (d.files || []).map(function (f) {
        return Object.assign({}, f, { inTrash: true });
      });
      render();
    }).catch(showError);
  }

  function loadIconTrash() {
    try {
      var raw = JSON.parse(localStorage.getItem(ICON_TRASH_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }

  function loadSearch(q) {
    return api.search(q).then(function (d) {
      state.folders = [];
      state.files = (d.files || d.results || []).map(function (f) {
        return Object.assign({}, f, { folderLabel: f.folder_name || f.folderName || f.path || '' });
      });
      render();
    }).catch(showError);
  }

  function showError(e) {
    console.debug('Finder 로드 실패:', e);
    if (els.list) {
      els.list.innerHTML = '<div class="finder-empty">불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.</div>';
    }
  }

  /* ---------- 렌더 ---------- */

  function allRows() {
    var rows = state.folders.concat(state.files);
    if (state.view === 'trash') {
      rows = rows.concat(state.iconTrash.map(function (it) {
        return { id: 'icontrash:' + it.id, name: it.name || it.id, kind: 'icontrash', iconItem: it, inTrash: true };
      }));
    }
    var key = state.sort.key, dir = state.sort.dir;
    rows.sort(function (a, b) {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      var va, vb;
      if (key === 'size') { va = a.size || 0; vb = b.size || 0; }
      else if (key === 'date') { va = a.updated_at || ''; vb = b.updated_at || ''; }
      else if (key === 'kind') { va = kindLabel(a); vb = kindLabel(b); }
      else { va = a.name || ''; vb = b.name || ''; }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return rows;
  }

  function render() {
    renderList();
    renderStatus();
    publishTitle();
  }

  function renderList() {
    var rows = allRows();
    if (state.displayMode === 'grid') { renderGrid(rows); return; }
    var html = '<table class="finder-table"><thead><tr>' +
      th('name', '이름') + th('date', '수정일') + th('size', '크기') + th('kind', '종류') +
      (state.view === 'search' ? '<th>위치</th>' : '') +
      '</tr></thead><tbody>';
    if (!rows.length) {
      html += '<tr class="finder-row-empty"><td colspan="5"><div class="finder-empty">' +
        (state.view === 'trash' ? '휴지통이 비어 있어요.' : '이 폴더는 비어 있어요.') + '</div></td></tr>';
    }
    rows.forEach(function (item) {
      var id = item.id;
      var iconHtml;
      if (item.isFolder) iconHtml = '<i data-lucide="folder" class="finder-row-icon finder-row-icon-folder"></i>';
      else if (item.kind === 'icontrash') iconHtml = '<i data-lucide="app-window" class="finder-row-icon"></i>';
      else if (window.MyHubFileIcons) iconHtml = window.MyHubFileIcons.htmlFor(item, 22);
      else iconHtml = '<i data-lucide="file" class="finder-row-icon"></i>';
      html += '<tr class="finder-row' + (state.selected[id] ? ' is-selected' : '') + '" data-id="' +
        escapeAttr(id) + '" data-kind="' + (item.isFolder ? 'folder' : (item.kind || 'file')) + '">' +
        '<td class="finder-cell-name">' + iconHtml + '<span>' + escapeHtml(item.name || '') + '</span></td>' +
        '<td>' + fmtDate(item.updated_at) + '</td>' +
        '<td>' + (item.isFolder ? '' : fmtSize(item.size)) + '</td>' +
        '<td>' + kindLabel(item) + '</td>' +
        (state.view === 'search' ? '<td class="finder-cell-loc">' + escapeHtml(item.folderLabel || '') + '</td>' : '') +
        '</tr>';
    });
    html += '</tbody></table>';
    els.list.innerHTML = html;
    if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('Finder 아이콘 실패:', e); } }
    bindRows(rows);
  }

  function renderGrid(rows) {
    if (!rows.length) {
      els.list.innerHTML = '<div class="finder-empty">' +
        (state.view === 'trash' ? '휴지통이 비어 있어요.' : '이 폴더는 비어 있어요.') + '</div>';
      return;
    }
    var html = '<div class="finder-grid">';
    rows.forEach(function (item) {
      var iconHtml;
      if (item.isFolder) iconHtml = '<i data-lucide="folder" class="finder-grid-icon finder-row-icon-folder"></i>';
      else if (item.kind === 'icontrash') iconHtml = '<i data-lucide="app-window" class="finder-grid-icon"></i>';
      else if (window.MyHubFileIcons) iconHtml = window.MyHubFileIcons.htmlFor(item);
      else iconHtml = '<i data-lucide="file" class="finder-grid-icon"></i>';
      html += '<button type="button" class="finder-grid-item' + (state.selected[item.id] ? ' is-selected' : '') +
        '" data-id="' + escapeAttr(item.id) + '">' +
        '<span class="finder-grid-icon-wrap">' + iconHtml + '</span>' +
        '<span class="finder-grid-name">' + escapeHtml(item.name || '') + '</span></button>';
    });
    html += '</div>';
    els.list.innerHTML = html;
    if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('Finder 격자 아이콘 실패:', e); } }
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    els.list.querySelectorAll('.finder-grid-item').forEach(function (btn) {
      var item = byId[btn.dataset.id];
      if (!item) return;
      btn.addEventListener('click', function (ev) { selectRow(item, ev); });
      btn.addEventListener('dblclick', function () { openItem(item); });
      btn.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (!state.selected[item.id]) selectRow(item, {});
        showContextMenu(item, ev.clientX, ev.clientY);
      });
    });
  }

  function th(key, label) {
    var arrow = state.sort.key === key ? (state.sort.dir === 1 ? ' ↑' : ' ↓') : '';
    return '<th data-sort="' + key + '">' + label + arrow + '</th>';
  }

  function bindRows(rows) {
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    els.list.querySelectorAll('.finder-row').forEach(function (tr) {
      var item = byId[tr.dataset.id];
      if (!item) return;
      tr.addEventListener('click', function (ev) { selectRow(item, ev); });
      tr.addEventListener('dblclick', function () { openItem(item); });
      tr.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (!state.selected[item.id]) selectRow(item, {});
        showContextMenu(item, ev.clientX, ev.clientY);
      });
    });
    els.list.querySelectorAll('th[data-sort]').forEach(function (thEl) {
      thEl.addEventListener('click', function () {
        var key = thEl.dataset.sort;
        if (state.sort.key === key) state.sort.dir *= -1;
        else state.sort = { key: key, dir: 1 };
        renderList();
      });
    });
  }

  function selectRow(item, ev) {
    if (ev && (ev.metaKey || ev.ctrlKey)) {
      state.selected[item.id] = !state.selected[item.id];
      if (!state.selected[item.id]) delete state.selected[item.id];
    } else if (ev && ev.shiftKey) {
      state.selected[item.id] = true;
    } else {
      state.selected = {};
      state.selected[item.id] = true;
    }
    renderList();
    renderStatus();
  }

  function selectedItems() {
    return allRows().filter(function (r) { return state.selected[r.id]; });
  }

  function renderStatus() {
    var total = allRows().length;
    var sel = Object.keys(state.selected).length;
    els.status.textContent = sel > 0 ? total + '개 중 ' + sel + '개 선택' : total + '개 항목';
    if (els.statusPath) {
      els.statusPath.textContent = state.view === 'trash' ? '휴지통'
        : state.view === 'search' ? '검색 결과'
        : state.view === 'recent' ? '최근 항목'
        : state.view === 'desktop' ? '바탕화면'
        : state.folderName;
    }
    var badge = $('sideRootBadge');
    if (badge) {
      var atRoot = state.view === 'folder' && (!state.folderId || state.folderId === 'root');
      if (atRoot) { badge.textContent = String(total); badge.hidden = total === 0; }
    }
    var pathHtml = state.path.map(function (p, i) {
      return '<button type="button" data-path="' + escapeAttr(p.id) + '"' +
        (i === state.path.length - 1 ? ' class="is-current"' : '') + '>' + escapeHtml(p.name) + '</button>';
    }).join('<span class="finder-path-sep">›</span>');
    if (state.view === 'trash') pathHtml = '<span class="is-current">휴지통</span>';
    if (state.view === 'search') pathHtml = '<span class="is-current">“' + escapeHtml(state.query) + '” 검색 결과</span>';
    els.path.innerHTML = pathHtml;
    els.path.querySelectorAll('button[data-path]').forEach(function (b) {
      b.addEventListener('click', function () { navigateTo(b.dataset.path); });
    });
    var emptyBtn = $('finderEmptyTrash');
    if (emptyBtn) {
      var driveCount = state.folders.length + state.files.length;
      emptyBtn.style.display = state.view === 'trash' && (state.iconTrash.length > 0 || driveCount > 0) ? '' : 'none';
    }
  }

  function renderSidebar() {
    var favs = loadFavorites();
    var favHtml = favs.map(function (f) {
      return '<button type="button" class="finder-side-item" data-fav="' + escapeAttr(f.id) +
        '" data-name="' + escapeAttr(f.name) + '"><i data-lucide="folder"></i><span>' +
        escapeHtml(f.name) + '</span></button>';
    }).join('');
    els.favorites.innerHTML = favHtml;
    els.favorites.querySelectorAll('[data-fav]').forEach(function (b) {
      b.addEventListener('click', function () {
        navigateTo(b.dataset.fav, b.dataset.name);
      });
      b.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (window.confirm('즐겨찾기에서 제거할까요?')) {
          pruneFavorite(b.dataset.fav);
        }
      });
    });
    if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('사이드바 아이콘 실패:', e); } }
    api.usage().then(function (u) {
      if (els.usage) {
        els.usage.textContent = '파일 ' + (u.files || 0) + '개 · ' + fmtSize(u.bytes || 0) + ' 사용 중';
      }
    }).catch(function (e) { /* 사용량 캡션은 장식 */ console.warn('사용량 표시 실패:', e); });
  }

  function publishTitle() {
    var b = bridge();
    if (!b) return;
    var name = state.view === 'trash' ? '휴지통'
      : state.view === 'search' ? '검색 결과'
      : state.folderName;
    b.setTitle(name);
  }

  /* ---------- 이동·열기 ---------- */

  function navigateTo(folderId, name) {
    state.history.push({ folderId: state.folderId, folderName: state.folderName, path: state.path.slice(), view: state.view });
    state.future = [];
    state.view = 'folder';
    state.folderId = folderId;
    state.folderName = name || folderNameFromPath(folderId) || '폴더';
    var idx = state.path.findIndex(function (p) { return p.id === folderId; });
    if (idx >= 0) state.path = state.path.slice(0, idx + 1);
    else state.path = state.path.concat([{ id: folderId, name: state.folderName }]);
    state.selected = {};
    loadCurrent();
    markSidebarActive();
  }

  function folderNameFromPath(id) {
    var hit = state.path.filter(function (p) { return p.id === id; })[0];
    return hit ? hit.name : null;
  }

  function goBack() {
    var prev = state.history.pop();
    if (!prev) return;
    state.future.push({ folderId: state.folderId, folderName: state.folderName, path: state.path.slice(), view: state.view });
    state.folderId = prev.folderId;
    state.folderName = prev.folderName;
    state.path = prev.path;
    state.view = prev.view || 'folder';
    state.selected = {};
    loadCurrent();
    markSidebarActive();
  }

  function goForward() {
    var next = state.future.pop();
    if (!next) return;
    state.history.push({ folderId: state.folderId, folderName: state.folderName, path: state.path.slice(), view: state.view });
    state.folderId = next.folderId;
    state.folderName = next.folderName;
    state.path = next.path;
    state.view = next.view || 'folder';
    state.selected = {};
    loadCurrent();
    markSidebarActive();
  }

  function setView(view) {
    state.view = view;
    state.selected = {};
    if (view === 'folder') { state.folderId = 'root'; state.folderName = '보관함'; state.path = [{ id: 'root', name: '보관함' }]; }
    loadCurrent();
    markSidebarActive();
  }

  function markSidebarActive() {
    document.querySelectorAll('.finder-side-item[data-view]').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === state.view);
    });
    var rootBtn = $('sideRoot');
    if (rootBtn) rootBtn.classList.toggle('is-active', state.view === 'folder');
  }

  function openItem(item) {
    if (item.isFolder) {
      if (state.view === 'trash') return;
      navigateTo(item.id, item.name);
      return;
    }
    if (item.isDesktopIcon) return;
    if (item.kind === 'icontrash') return;
    if (item.folderLabel !== undefined && state.view === 'search' && item.folder_id) {
      // 검색 결과: 소속 폴더로 이동해 파일을 선택한다
      var folderId = item.folder_id;
      var fileId = item.id;
      navigateTo(folderId, item.folder_name || '폴더');
      setTimeout(function () {
        state.selected = {};
        state.selected[fileId] = true;
        renderList();
        renderStatus();
      }, 350);
      return;
    }
    var app = officeAppOf(item);
    if (app) {
      postToShell({ type: 'myhub:open-in-app', app: app, file: { id: item.id, name: item.name } });
      if (!document.documentElement.classList.contains('myhub-embedded')) {
        window.location.href = '/office.html?app=' + app + '&file=' + encodeURIComponent(item.id);
      }
      return;
    }
    if (viewer) viewer.open(item);
  }

  /* ---------- 우클릭 메뉴 ---------- */

  var menuEl = null;
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    document.removeEventListener('pointerdown', onMenuDocDown, true);
  }
  function onMenuDocDown(ev) { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); }

  function showContextMenu(item, x, y) {
    closeMenu();
    var items = [];
    if (state.view === 'trash') {
      items.push({ label: '복원', onSelect: function () { restoreItem(item); } });
      items.push({ label: '삭제', danger: true, onSelect: function () { purgeItem(item); } });
    } else {
      items.push({ label: '열기', onSelect: function () { openItem(item); } });
      if (!item.isFolder) {
        items.push({ label: '미리 보기', onSelect: function () { if (viewer) viewer.open(item); } });
      }
      if (item.isFolder) {
        items.push({
          label: isFavorite(item.id) ? '즐겨찾기에서 제거' : '즐겨찾기 추가',
          onSelect: function () { toggleFavorite(item); },
        });
      }
      items.push({ label: '이름 변경', onSelect: function () { renameItem(item); } });
      items.push({ label: '휴지통으로 이동', danger: true, onSelect: function () { trashSelected(); } });
    }
    openMenuAt(items, x, y);
  }

  function openMenuAt(items, x, y) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'myhub-context-menu';
    items.forEach(function (mi) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'myhub-context-item' + (mi.danger ? ' myhub-context-item-danger' : '');
      b.textContent = mi.label;
      b.addEventListener('click', function () { closeMenu(); mi.onSelect(); });
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    menuEl.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - items.length * 36 - 16) + 'px';
    document.addEventListener('pointerdown', onMenuDocDown, true);
  }

  function showSortMenu(x, y) {
    var keys = [
      { key: 'name', label: '이름' },
      { key: 'date', label: '수정일' },
      { key: 'size', label: '크기' },
      { key: 'kind', label: '종류' },
    ];
    var items = keys.map(function (k) {
      return {
        label: (state.sort.key === k.key ? '✓ ' : '　') + k.label,
        onSelect: function () {
          if (state.sort.key === k.key) state.sort.dir *= -1;
          else state.sort = { key: k.key, dir: 1 };
          renderList();
        },
      };
    });
    items.push({
      label: (state.sort.dir === 1 ? '✓ ' : '　') + '오름차순',
      onSelect: function () { state.sort.dir = 1; renderList(); },
    });
    items.push({
      label: (state.sort.dir === -1 ? '✓ ' : '　') + '내림차순',
      onSelect: function () { state.sort.dir = -1; renderList(); },
    });
    openMenuAt(items, x, y);
  }

  function renameItem(item) {
    var name = window.prompt('새 이름', item.name || '');
    if (!name || name === item.name) return;
    var p = item.isFolder ? api.renameFolder(item.id, name) : api.renameFile(item.id, name);
    p.then(function () {
      if (item.isFolder && isFavorite(item.id)) {
        var favs = loadFavorites();
        favs.forEach(function (f) { if (f.id === item.id) f.name = name; });
        saveFavorites(favs);
        renderSidebar();
      }
      loadCurrent();
    }).catch(function () { window.alert('이름을 바꾸지 못했어요.'); });
  }

  function trashSelected() {
    var targets = selectedItems();
    var chain = Promise.resolve();
    targets.forEach(function (item) {
      chain = chain.then(function () {
        return item.isFolder ? api.trashFolder(item.id) : api.trashFile(item.id);
      });
    });
    chain.then(function () { state.selected = {}; loadCurrent(); })
      .catch(function () { window.alert('휴지통으로 옮기지 못했어요.'); });
  }

  function restoreItem(item) {
    if (item.kind === 'icontrash') {
      postToShell({ type: 'myhub:icon-trash-restore', id: item.iconItem.id });
      setTimeout(loadCurrent, 350);
      return;
    }
    var p = item.isFolder ? api.restoreFolder(item.id) : api.restoreFile(item.id);
    p.then(loadCurrent).catch(function () { window.alert('복원하지 못했어요.'); });
  }

  function purgeItem(item) {
    if (!window.confirm('완전히 삭제할까요? 되돌릴 수 없어요.')) return;
    if (item.kind === 'icontrash') {
      postToShell({ type: 'myhub:icon-trash-purge', id: item.iconItem.id });
      setTimeout(loadCurrent, 350);
      return;
    }
    var p = item.isFolder ? api.deleteFolder(item.id) : api.deleteFile(item.id);
    p.then(loadCurrent).catch(function () { window.alert('삭제하지 못했어요.'); });
  }

  function emptyTrash() {
    if (!window.confirm('휴지통을 비울까요? 되돌릴 수 없어요.')) return;
    var chain = Promise.resolve();
    state.folders.forEach(function (f) {
      chain = chain.then(function () { return api.deleteFolder(f.id); });
    });
    state.files.filter(function (f) { return !f.deleted_via_folder; }).forEach(function (f) {
      chain = chain.then(function () { return api.deleteFile(f.id); });
    });
    state.iconTrash.forEach(function (it) {
      postToShell({ type: 'myhub:icon-trash-purge', id: it.id });
    });
    chain.then(function () { setTimeout(loadCurrent, 350); })
      .catch(function () { window.alert('휴지통을 비우지 못했어요.'); });
  }

  /* ---------- 셸 메시지 ---------- */

  window.addEventListener('message', function (ev) {
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'myhub:open-view' && d.view === 'trash') {
      setView('trash');
      postToShell({ type: 'myhub:open-view-ack' });
    } else if (d.type === 'myhub:open-file' && d.file) {
      if (d.file.folder_id) navigateTo(d.file.folder_id, d.file.folder_name || '폴더');
      state.selected = {};
      state.selected[d.file.id] = true;
      setTimeout(function () { renderList(); renderStatus(); }, 350);
      postToShell({ type: 'myhub:open-file-ack' });
    } else if (d.type === 'myhub:icon-trash-changed') {
      if (state.view === 'trash') loadCurrent();
    }
  });

  function newFolder() {
    if (state.view !== 'folder') return;
    var name = window.prompt('새 폴더 이름', '새 폴더');
    if (!name) return;
    api.createFolder(name, state.folderId).then(loadCurrent)
      .catch(function () { window.alert('폴더를 만들지 못했어요.'); });
  }

  /* ---------- 초기화 ---------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function init() {
    els = {
      list: $('finderList'),
      status: $('finderStatus'),
      statusPath: $('finderStatusPath'),
      path: $('finderPath'),
      favorites: $('sideFavorites'),
      usage: $('sideUsage'),
      search: $('finderSearch'),
      toolbarSearch: $('finderToolbarSearch'),
    };
    viewer = window.FinderViewer ? window.FinderViewer.createViewer({}) : null;

    document.querySelectorAll('.finder-side-item[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });
    var backBtn = $('finderBack');
    if (backBtn) backBtn.addEventListener('click', goBack);
    var fwdBtn = $('finderFwd');
    if (fwdBtn) fwdBtn.addEventListener('click', goForward);
    var nfBtn = $('finderNewFolderBtn');
    if (nfBtn) nfBtn.addEventListener('click', newFolder);
    var upBtn = $('finderUploadBtn');
    if (upBtn) upBtn.addEventListener('click', function () { var fi = $('finderFileInput'); if (fi) fi.click(); });
    var rootBtn = $('sideRoot');
    if (rootBtn) rootBtn.addEventListener('click', function () { setView('folder'); });

    var searchTimer = null;
    function runSearch(raw) {
      clearTimeout(searchTimer);
      var q = (raw || '').trim();
      searchTimer = setTimeout(function () {
        if (!q) { if (state.view === 'search') setView('folder'); return; }
        state.view = 'search';
        state.query = q;
        state.selected = {};
        loadSearch(q);
        markSidebarActive();
      }, 250);
    }
    if (els.search) els.search.addEventListener('input', function () { runSearch(els.search.value); });
    if (els.toolbarSearch) els.toolbarSearch.addEventListener('input', function () { runSearch(els.toolbarSearch.value); });
    var searchBtn = $('finderSearchBtn');
    var searchWrap = $('finderToolbarSearchWrap');
    if (searchBtn && searchWrap) {
      searchBtn.addEventListener('click', function () {
        var show = searchWrap.hidden;
        searchWrap.hidden = !show;
        if (show && els.toolbarSearch) { els.toolbarSearch.focus(); els.toolbarSearch.select(); }
      });
    }
    var listBtn = $('finderViewList');
    var gridBtn = $('finderViewGrid');
    function setDisplayMode(mode) {
      state.displayMode = mode;
      if (listBtn) listBtn.classList.toggle('is-active', mode === 'list');
      if (gridBtn) gridBtn.classList.toggle('is-active', mode === 'grid');
      renderList();
    }
    if (listBtn) listBtn.addEventListener('click', function () { setDisplayMode('list'); });
    if (gridBtn) gridBtn.addEventListener('click', function () { setDisplayMode('grid'); });
    var sortBtn = $('finderSortBtn');
    if (sortBtn) sortBtn.addEventListener('click', function () {
      var r = sortBtn.getBoundingClientRect();
      showSortMenu(r.left, r.bottom + 4);
    });
    var newBtn2 = $('finderNewBtn');
    if (newBtn2) newBtn2.addEventListener('click', newFolder);
    var upBtn2 = $('finderUpBtn');
    if (upBtn2) upBtn2.addEventListener('click', function () { var fi = $('finderFileInput'); if (fi) fi.click(); });

    var emptyBtn = $('finderEmptyTrash');
    if (emptyBtn) emptyBtn.addEventListener('click', emptyTrash);

    var fileInput = $('finderFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var files = Array.prototype.slice.call(fileInput.files || []);
        var chain = Promise.resolve();
        files.forEach(function (f) {
          chain = chain.then(function () { return api.upload(f, state.folderId); });
        });
        chain.then(loadCurrent).catch(function () { window.alert('업로드에 실패했어요.'); });
        fileInput.value = '';
      });
    }

    var main = $('finderMain');
    if (main) {
      main.addEventListener('dragover', function (ev) { ev.preventDefault(); main.classList.add('is-dragover'); });
      main.addEventListener('dragleave', function () { main.classList.remove('is-dragover'); });
      main.addEventListener('drop', function (ev) {
        ev.preventDefault();
        main.classList.remove('is-dragover');
        var files = Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []);
        var chain = Promise.resolve();
        files.forEach(function (f) {
          chain = chain.then(function () { return api.upload(f, state.folderId); });
        });
        chain.then(loadCurrent).catch(function () { window.alert('업로드에 실패했어요.'); });
      });
    }

    renderSidebar();
    loadCurrent().then(function () {
      seedDefaultFavorites();
      postToShell({ type: 'myhub:finder-ready' });
    });
  }

  /* 즐겨찾기 미설정 시 시스템 폴더 4개를 기본 즐겨찾기로 심는다 (원본 구성). */
  function seedDefaultFavorites() {
    var stored = null;
    try { stored = localStorage.getItem(FAV_KEY); } catch (e) { stored = null; }
    if (stored !== null) return;
    var names = ['응용 프로그램', '데스크탑', '문서', '다운로드'];
    var favs = state.folders
      .filter(function (f) { return names.indexOf(f.name) >= 0; })
      .sort(function (a, b) { return names.indexOf(a.name) - names.indexOf(b.name); })
      .map(function (f) { return { id: f.id, name: f.name }; });
    if (favs.length) { saveFavorites(favs); renderSidebar(); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
