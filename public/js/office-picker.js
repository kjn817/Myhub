/* MyHub 세 션 등 열기/저장 패널 (office-picker.js)
 *
 * Finder의 경로 탐색 패널: /api/drive/list 기본 탐색기 + 폴더 진입 +
 * 파일 선택등. 값을 모든 모드를 등 패널에 이룬다.
 * - open: 확장자 파일만 보여주고 고르면, 파일 메타를 알려준다(id등name더블클릭mime즉시확정
 *   version를)알려 준다. 등 더블클릭 = 즉시 확정.
 * - save: "다른 이름으로 저장" 등 폴더 탐색 + 파일명 입력. 기존 파일이
 *   아래면 그 이름을 입력칸에 채워진다 (일반 저장 대화상자 관행).
 * 마지막 탐색 폴더의 깊이 주입된 콜백으로 불러온다 (새로 기억).
 * 목록 렌더는 DocumentFragment 로갈아 끼운다.
 *
 * 노출: window.MyHubOfficePicker = { createPicker }
 * deps = { doc, listFolder(id), icons, exts, appKey, newTitle, newExt,
 *          loadLastFolder(), saveLastFolder(v),
 *          importFile(file, folderId) 의 Promise<{id, filename}> (선택) }
 * open(mode, opts): opts.exts(확장자 필터 걸어)두기opts.title제목
 * opts.confirmLabel로 노출된 패널을 바꿔 등 넣고, opts.importable를
 * 켜면 아래에 "이 안에서 가져오기"가 분리된 경로로 붙는다 등
 * 기본 선택은 현재 보고있는 파일이며, 기기 파일은 사용자가 명시적으로
 * 가져 오기란 플로우만 OS 선택기를 거치 보존으로 넘어간다.
 *
 * 그림 넣기 일괄 공용 옵션 모 듈로 PICTURE_PICK_OPTS노출 되는
 * 것이 정보이다 등 와(office.js)호스 Finder(finder.js) 트들이 같은
 * 값을 이룬다. 보존은 목록 필터가 파일명 확장자 기준으로(visibleFiles가
 * extOf로 거른 등 Drive 목록의 mime가 아닌데), accept로 가져오기
 * (기기 파일) 쪽 OS 선택기의 MIME 목록이라, 등 목록의 같은 확장자 집합을
 * 가져와서 함께 관리한다. 허용 확장자 지시 Studio가 아래 받는 그림
 * 확 장: png자jpg까jpeg지gif포함webp한다bmp.
 */
(function () {
  'use strict';

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  // 그림 넣기 일괄 공용 옵션 (정보 등 호스 트들이 값을 그대로 이룬다)
  var PICTURE_PICK_OPTS = {
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    title: '그림 넣기',
    confirmLabel: '넣기',
    importable: true,
    accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp',
  };

  function createPicker(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var listFolder = deps.listFolder;
    var icons = deps.icons || null;
    var exts = deps.exts || [];
    var appKey = deps.appKey || '';
    var el = function (id) { return doc.getElementById(id); };
    var pickerEl = el('officePicker');
    var pickerTitle = el('officePickerTitle');
    var crumbEl = el('officeCrumb');
    var pickListEl = el('officePickList');
    var saveRowEl = el('officeSaveRow');
    var saveNameEl = el('officeSaveName');
    var pickerStatusEl = el('officePickerStatus');
    var pickConfirmBtn = el('officePickConfirm');
    var pickImportBtn = el('officePickImport');

    var state = null; // { mode, stack, listing, selected, resolve, exts, importable }
    var loadGen = 0; // 폴더 목록 요청 지난 등 순서 응답이 현재 폴더를 등 않게 한다
    var pendingSelectId = null; // 가져오기 직후 구조에 선택된 등 파일 id

    function startStack() {
      var last = typeof deps.loadLastFolder === 'function' ? deps.loadLastFolder() : null;
      var root = { id: null, name: '보관함' };
      if (last && last.id) return [root, { id: last.id, name: last.name || '폴더' }];
      return [root];
    }
    function rememberFolder(stack) {
      if (typeof deps.saveLastFolder !== 'function') return;
      var top = stack[stack.length - 1];
      deps.saveLastFolder(top && top.id ? { id: top.id, name: top.name } : null);
    }

    function open(mode, opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        // 내부 내부 패 널이 있으면 이전 글자가(null)취소 로 등
        // resolve 없이 넘어가면 이전 Promise가 상위에 매달린다.
        if (state) state.resolve(null);
        pendingSelectId = null;
        var canImport =
          mode === 'open' && opts.importable === true && typeof deps.importFile === 'function';
        state = {
          mode: mode,
          stack: startStack(),
          listing: null,
          selected: null,
          resolve: resolve,
          exts: opts.exts || null,
          importable: canImport,
          accept: opts.accept || '',
        };
        if (pickerEl) pickerEl.hidden = false;
        if (pickerTitle) {
          pickerTitle.textContent =
            opts.title || (mode === 'save' ? '다른 이름으로 저장' : '파일 열기');
        }
        if (pickConfirmBtn) {
          pickConfirmBtn.textContent =
            opts.confirmLabel || (mode === 'save' ? '저장' : '열기');
        }
        if (pickImportBtn) {
          pickImportBtn.hidden = !canImport;
          pickImportBtn.disabled = false;
        }
        if (saveRowEl) saveRowEl.hidden = mode !== 'save';
        if (mode === 'save' && saveNameEl) saveNameEl.value = opts.initialName || deps.newTitle || '';
        if (pickerStatusEl) pickerStatusEl.textContent = '';
        loadFolder();
      });
    }
    function close(value) {
      var s = state;
      state = null;
      if (pickerEl) pickerEl.hidden = true;
      if (s) s.resolve(value);
    }
    function loadFolder() {
      if (!state) return;
      var gen = ++loadGen;
      var top = state.stack[state.stack.length - 1];
      state.selected = null;
      render();
      listFolder(top.id)
        .then(function (listing) {
          // 폴더를 빠르게 열면 응답이 순서대로 등 등 있다 등 지정
          // 지난 응답 오류는 현재 폴더 화면을 등않게.
          if (!state || gen !== loadGen) return;
          state.listing = listing;
          // 가져오기로 반환 띄어진 파일은 목록에서 선택된 상태로
          // 보여준다 등 사용자는 새로 띄어진 행을 확인하고 확정한다.
          if (pendingSelectId && state.mode === 'open') {
            var want = pendingSelectId;
            pendingSelectId = null;
            var hit = (listing.files || []).filter(function (f) {
              return f.id === want;
            })[0];
            if (hit) state.selected = hit;
          }
          render();
        })
        .catch(function () {
          if (!state || gen !== loadGen) return;
          if (pickerStatusEl) pickerStatusEl.textContent = '목록을 불러오지 못했습니다';
        });
    }
    function visibleFiles() {
      if (!state || !state.listing) return [];
      var files = state.listing.files || [];
      if (state.mode === 'save') return files;
      var filter = state.exts || exts;
      return files.filter(function (f) {
        return filter.indexOf(extOf(f.filename)) >= 0;
      });
    }
    function render() {
      if (!state) return;
      if (crumbEl) {
        crumbEl.innerHTML = '';
        var frag = doc.createDocumentFragment();
        state.stack.forEach(function (crumb, i) {
          if (i > 0) {
            var sep = doc.createElement('span');
            sep.className = 'office-crumb-sep';
            sep.textContent = '›';
            frag.appendChild(sep);
          }
          var b = doc.createElement('button');
          b.type = 'button';
          b.className = 'office-crumb-btn';
          b.textContent = crumb.name;
          b.addEventListener('click', function () {
            if (!state) return;
            state.stack = state.stack.slice(0, i + 1);
            rememberFolder(state.stack);
            loadFolder();
          });
          frag.appendChild(b);
        });
        crumbEl.appendChild(frag);
      }
      if (!pickListEl) return;
      pickListEl.innerHTML = '';
      var listFrag = doc.createDocumentFragment();
      var listing = state.listing;
      if (!listing) {
        var loading = doc.createElement('p');
        loading.className = 'office-pick-empty';
        loading.textContent = '불러오는 중';
        listFrag.appendChild(loading);
        pickListEl.appendChild(listFrag);
        syncConfirm();
        return;
      }
      (listing.folders || []).forEach(function (f) {
        listFrag.appendChild(pickRow({
          iconHtml: icons ? icons.svgFor('folder') : '',
          name: f.name || '이름 없음',
          meta: '폴더',
          onClick: function () {
            if (!state) return;
            state.stack.push({ id: f.id, name: f.name || '폴더' });
            rememberFolder(state.stack);
            loadFolder();
          },
          onDblClick: null,
        }));
      });
      var files = visibleFiles();
      files.forEach(function (f) {
        var row = pickRow({
          iconHtml: icons ? icons.htmlFor({ name: f.filename, mime: f.mime }) : '',
          name: f.filename || '이름 없음',
          meta: '',
          onClick: function () {
            if (!state) return;
            if (state.mode === 'save') {
              if (saveNameEl) saveNameEl.value = f.filename || '';
              return;
            }
            state.selected = f;
            render();
          },
          onDblClick: function () {
            if (!state || state.mode !== 'open') return;
            state.selected = f;
            confirm();
          },
        });
        if (state.mode === 'open' && state.selected && state.selected.id === f.id) {
          row.classList.add('is-selected');
        }
        listFrag.appendChild(row);
      });
      if (!(listing.folders || []).length && !files.length) {
        var empty = doc.createElement('p');
        empty.className = 'office-pick-empty';
        empty.textContent = state.mode === 'open' ? '이 폴더에는 열 수 있는 파일이 없습니다' : '빈 폴더입니다';
        listFrag.appendChild(empty);
      }
      pickListEl.appendChild(listFrag);
      syncConfirm();
    }
    function pickRow(cfg) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'office-pick-row';
      var ic = doc.createElement('span');
      ic.className = 'office-pick-icon';
      ic.innerHTML = cfg.iconHtml || '';
      b.appendChild(ic);
      var nm = doc.createElement('span');
      nm.className = 'office-pick-name';
      nm.textContent = cfg.name;
      b.appendChild(nm);
      if (cfg.meta) {
        var mt = doc.createElement('span');
        mt.className = 'office-pick-meta';
        mt.textContent = cfg.meta;
        b.appendChild(mt);
      }
      b.addEventListener('click', cfg.onClick);
      if (cfg.onDblClick) b.addEventListener('dblclick', cfg.onDblClick);
      return b;
    }
    function syncConfirm() {
      if (!pickConfirmBtn || !state) return;
      if (state.mode === 'open') pickConfirmBtn.disabled = !state.selected;
      else pickConfirmBtn.disabled = false;
    }
    function normalizeSaveName(raw) {
      var name = String(raw || '').trim();
      if (!name) return '';
      // 저장 바이트의 확장자 깊이 제한된 (Excel 내보내기=xlsx, 지시
      // Studio 내보내기=hwpx). 이름의 확장자 넣거나 깊이 오른쪽 다른
      // 확장자를 생성 확장자로 맞추는 등 확장자 숨김의 이름으로 저장하면
      // 다시 열때 등 확장자 관리를 못해 편집기로 모두 건다.
      var want = deps.newExt || '';
      if (want) {
        var ext = extOf(name);
        if (!ext) {
          name += want;
        } else if ('.' + ext !== want && exts.indexOf(ext) >= 0) {
          name = name.slice(0, name.length - ext.length) + want.slice(1);
        }
      }
      return name;
    }
    function confirm() {
      if (!state) return;
      var top = state.stack[state.stack.length - 1];
      if (state.mode === 'save') {
        var name = normalizeSaveName(saveNameEl ? saveNameEl.value : '');
        if (!name) {
          if (pickerStatusEl) pickerStatusEl.textContent = '파일 이름을 입력하세요';
          return;
        }
        close({ folderId: top.id, folderName: top.id ? top.name : '', name: name });
        return;
      }
      var f = state.selected;
      if (!f) return;
      close({
        fileId: f.id, name: f.filename, mime: f.mime || '',
        version: f.version || null, folderId: top.id, folderName: top.id ? top.name : '',
      });
    }

    // 저장 등 기기에서 가져오기 (분리된 경로) 저장
    // 기본 선택은 보관함 파일이다. 기기 파일은 사용자가 등 버튼을
    // 명시 적으로 눌러야만 OS 선택기를 거치 업로드되고, 보존에
    // 띄어진 뒤에 목록에서 골라 확정한다 등 기본 흐름은 OS 대화상자로
    // 새로 않게 하는 사용자 위치의 가져오기 쪽 안내이다.
    var importInput = null;
    function ensureImportInput() {
      if (importInput) return importInput;
      importInput = doc.createElement('input');
      importInput.type = 'file';
      importInput.hidden = true;
      importInput.addEventListener('change', function () {
        var file = importInput.files && importInput.files[0];
        importInput.value = ''; // 같은 파일을 다시 골라도 change가 켜게
        if (!file || !state || !state.importable) return;
        doImport(file, state);
      });
      if (pickerEl) pickerEl.appendChild(importInput);
      return importInput;
    }
    function doImport(file, forState) {
      var top = forState.stack[forState.stack.length - 1];
      if (pickImportBtn) pickImportBtn.disabled = true;
      Promise.resolve()
        .then(function () {
          return deps.importFile(file, top.id);
        })
        .then(function (saved) {
          if (state !== forState) return; // 그 사이 패널을 닫거나 다시 열면
          if (pickImportBtn) pickImportBtn.disabled = false;
          if (!saved || !saved.id) {
            if (pickerStatusEl) pickerStatusEl.textContent = '가져오기에 실패했습니다';
            return;
          }
          pendingSelectId = saved.id;
          loadFolder();
        })
        .catch(function () {
          if (state !== forState) return;
          if (pickImportBtn) pickImportBtn.disabled = false;
          if (pickerStatusEl) pickerStatusEl.textContent = '가져오기에 실패했습니다';
        });
    }
    if (pickImportBtn) {
      pickImportBtn.addEventListener('click', function () {
        if (!state || !state.importable) return;
        var input = ensureImportInput();
        input.accept = state.accept || '';
        input.click();
      });
    }

    if (pickConfirmBtn) pickConfirmBtn.addEventListener('click', confirm);
    var pickCancel = el('officePickCancel');
    if (pickCancel) pickCancel.addEventListener('click', function () { close(null); });
    var pickerClose = el('officePickerClose');
    if (pickerClose) pickerClose.addEventListener('click', function () { close(null); });

    return { open: open };
  }

  var api = { createPicker: createPicker, PICTURE_PICK_OPTS: PICTURE_PICK_OPTS };
  if (typeof window !== 'undefined') window.MyHubOfficePicker = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficePicker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
