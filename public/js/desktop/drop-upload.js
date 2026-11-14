/* MyHub 데스크톱 용 OS 파일 드롭 복사 (drop-upload.js)
 * PC 탐색기/파인더에서 파일을 끌어다 놓으면, 놓은 자리가 정하는 폴더로
 * 순차 업로드한다 (POST /api/drive/files 사용, 파일당 10MB 상한은
 * 백엔드와 동일하게 클라이언트에서도 먼저 거른다).
 * - 데스크톱: '바탕화면' 폴더 (createDriveDesktop의 보장) 와 resolveFolderId
 * - 파인더: 폴더 항목 위면 그 폴더, 아니면 현재 폴더 와 같은 자원을 공유한다
 *
 * 내부 드래그(아이콘·위젯·창 등 내부 포인터 이벤트 기반)는 간섭하지
 * 않도록 dataTransfer.types에 'Files'가 있을 때만 반응한다.
 *
 * 노출: window.MyHubDesktopDrop = { createDropUpload, createDriveDesktop,
 *        MAX_SIZE, hasFiles }
 * (browser-live.js와 같은 3줄 노출 및 단독 로드 계약 테스트 대상.)
 */
(function () {
  'use strict';

  var MAX_SIZE = 10 * 1024 * 1024;
  var UPLOAD_URL = '/api/drive/files';

  /** 기본 업로드: 파일 1개를 FormData로 POST한다. {ok:false,error}는 실패로 던진다. */
  function defaultUploadFile(file, folderId) {
    var fd = new FormData();
    fd.append('files', file);
    if (folderId !== null && folderId !== undefined) fd.append('folder_id', String(folderId));
    return fetch(UPLOAD_URL, { method: 'POST', body: fd }).then(function (res) {
      return jsonOrThrow(res, '업로드에 실패했습니다 (' + res.status + ')');
    });
  }

  /** fetch 응답을 {ok:true} 본문으로 확정하고, 아니면 서버 사유로 던진다 (http-json.js 공용 코어, F-L8). */
  function jsonOrThrow(res, fallbackMsg) {
    var core =
      (typeof window !== 'undefined' &&
        window.MyHubHttpJson &&
        window.MyHubHttpJson.jsonOrThrow) ||
      (typeof globalThis !== 'undefined' &&
        globalThis.MyHubHttpJson &&
        globalThis.MyHubHttpJson.jsonOrThrow) ||
      null;
    if (typeof core !== 'function') {
      throw new Error('[drop-upload.js] http-json.js가 먼저 로드되어야 합니다');
    }
    return core(res, fallbackMsg);
  }

  /**
   * 바탕화면 폴더('바탕화면')의 보장·목록·삭제와 및 데스크톱 드롭의
   * 목적지이자 바탕화면 파일 아이콘의 원본이다.
   * deps = { fetchFn?, folderName? } — fetchFn은 테스트 주입 지점.
   * - ensureFolderId: 루트 목록에서 이름이 정확히 같은 폴더를 찾아
   *   사용하고, 없으면 만든다. 휴지통에 있는 동명 폴더는 목록에
   *   나타나지 않으므로(백엔드가 제외) 새 폴더를 만드는 쪽으로 흐른다.
   *   동명 폴더가 여럿이면 목록 순서의 첫 번째를 쓴다.
   * - 성공한 id는 캐시한다. 실패하면 캐시를 비워 다음 시도에서 재시도.
   */
  function createDriveDesktop(deps) {
    deps = deps || {};
    var fetchFn =
      typeof deps.fetchFn === 'function'
        ? deps.fetchFn
        : function (url, opts) {
            return fetch(url, opts);
          };
    var folderName = deps.folderName || '바탕화면';
    var cachedId = null;
    var pending = null;

    function ensureFolderId() {
      if (cachedId !== null) return Promise.resolve(cachedId);
      if (pending) return pending;
      var p = fetchFn('/api/drive/list')
        .then(jsonOrThrow)
        .then(function (body) {
          var folders = (body && body.folders) || [];
          for (var i = 0; i < folders.length; i++) {
            if (folders[i] && folders[i].name === folderName) {
              cachedId = folders[i].id;
              return cachedId;
            }
          }
          return fetchFn('/api/drive/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: folderName, parent_id: null }),
          })
            .then(jsonOrThrow)
            .then(function (created) {
              cachedId = created.id;
              return cachedId;
            });
        });
      pending = p;
      var clear = function () {
        if (pending === p) pending = null;
      };
      p.then(clear, clear);
      return p;
    }

    function listFiles() {
      return ensureFolderId().then(function (id) {
        return fetchFn('/api/drive/list?folder=' + id)
          .then(jsonOrThrow)
          .then(function (body) {
            return { folderId: id, files: (body && body.files) || [] };
          });
      });
    }

    function trashFile(fileId) {
      return fetchFn('/api/drive/files/' + fileId + '/trash', { method: 'POST' }).then(jsonOrThrow);
    }

    return {
      ensureFolderId: ensureFolderId,
      listFiles: listFiles,
      trashFile: trashFile,
      folderName: folderName,
    };
  }

  /** OS 파일 드래그인지 를 types 배열/DOMStringList 양쪽 본다. */
  function hasFiles(dt) {
    if (!dt || !dt.types) return false;
    var types = dt.types;
    for (var i = 0; i < types.length; i++) {
      var t = typeof types.item === 'function' ? types.item(i) : types[i];
      if (t === 'Files') return true;
    }
    return false;
  }

  /**
   * drop의 dataTransfer에서 항목을 뽑는다.
   * 폴더는 webkitGetAsEntry로 구분해 { folder: 이름 }으로 알려준다
   * (폴더 File은 size 0·type ''이라 파일로 오인하면 "빈 파일"이 된다).
   */
  function collectDropItems(dt) {
    var out = [];
    var items = dt && dt.items;
    if (items && items.length) {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item || item.kind !== 'file') continue;
        var entry = null;
        if (typeof item.webkitGetAsEntry === 'function') {
          try {
            entry = item.webkitGetAsEntry();
          } catch (e) {
            entry = null;
          }
        }
        if (entry && entry.isDirectory) {
          out.push({ folder: entry.name || '폴더' });
          continue;
        }
        var f = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
        if (f) out.push({ file: f });
      }
      if (out.length) return out;
    }
    var files = (dt && dt.files) || [];
    for (var j = 0; j < files.length; j++) out.push({ file: files[j] });
    return out;
  }

  /**
   * deps: { doc, target?, uploadFile?, maxSize?, refreshIcons?,
   *         targetName?, overlay?, customNotify?,
   *         resolveFolderId?, highlightTarget?, shouldAccept?,
   *         onProgress?, onDone? }
   * - target: 드래그 리스너를 걸 노드 (기본 doc)
   * - uploadFile: (file, folderId) => Promise — 테스트 주입 지점
   * - targetName: 문구에 쓰는 목적지 이름 (기본 '보관함', 데스크톱은 '바탕화면')
   * - overlay: 'full'(기본, 전체 화면 안내) | 'none' (파인더 등 하이라이트만)
   * - customNotify: true면 내장 토스트 없이 onProgress/onDone 콜백만 쓴다
   * - resolveFolderId(e): drop 시점에 목적지 폴더 id를 정한다 (값/Promise).
   *   거부(Promise reject)하면 그 항목을 그 사유로 실패 고정한다.
   * - highlightTarget(e): 드래그 중 강조할 요소(폴더 항목)를 알려준다
   * - shouldAccept(): false면 받지 않는다 (파인더 내부 보기 등). 단,
   *   받지 않는 상태에서도 파일 드롭을 브라우저 기본 동작(파일을 열어
   *   페이지를 갈아치우는 것)만큼 막고, onRejectedDrop으로 알린다.
   * - onRejectedDrop(e): shouldAccept가 false인 상태에서 파일이
   *   drop하면 불린다 (호스트가 고지를 띄울 자리)
   * - onDone(summary): 배치가 끝난 뒤 항상 불린다 (토스트와 병행 가능)
   */
  function createDropUpload(deps) {
    deps = deps || {};
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('MyHubDesktopDrop: document가 필요합니다');
    var target = deps.target || doc;
    var uploadFile = typeof deps.uploadFile === 'function' ? deps.uploadFile : defaultUploadFile;
    var maxSize = typeof deps.maxSize === 'number' ? deps.maxSize : MAX_SIZE;
    var targetName = deps.targetName || '보관함';
    var overlayMode = deps.overlay === 'none' ? 'none' : 'full';
    var customNotify = !!deps.customNotify;

    var dragDepth = 0;
    var overlayEl = null;
    var toastEl = null;
    var toastTimer = null;
    var hotEl = null;

    // 업로드 배치: 진행 중 드롭이 또 오면 같은 배치로 합친다.
    var batch = null; // { total, ok, settled, failures: [{name, reason}] }
    var queue = []; // [{ file, folderId }]
    var running = false;

    function accepted() {
      return typeof deps.shouldAccept !== 'function' || !!deps.shouldAccept();
    }

    function setHot(el) {
      if (hotEl === el) return;
      if (hotEl) hotEl.classList.remove('dt-drop-target-hot');
      hotEl = el || null;
      if (hotEl) hotEl.classList.add('dt-drop-target-hot');
    }
    function syncHot(e) {
      if (typeof deps.highlightTarget !== 'function') return;
      var el = null;
      try {
        el = deps.highlightTarget(e) || null;
      } catch (err) {
        el = null;
      }
      setHot(el);
    }

    function ensureOverlay() {
      if (overlayEl) return overlayEl;
      overlayEl = doc.createElement('div');
      overlayEl.className = 'dt-drop-overlay';
      overlayEl.setAttribute('aria-hidden', 'true');
      var card = doc.createElement('div');
      card.className = 'dt-drop-card';
      var icon = doc.createElement('i');
      icon.setAttribute('data-lucide', 'upload-cloud');
      card.appendChild(icon);
      var text = doc.createElement('p');
      text.className = 'dt-drop-text';
      text.textContent = '놓으면 ' + targetName + '에 복사합니다';
      card.appendChild(text);
      overlayEl.appendChild(card);
      doc.body.appendChild(overlayEl);
      if (typeof deps.refreshIcons === 'function') deps.refreshIcons();
      return overlayEl;
    }
    function showOverlay() {
      if (overlayMode === 'none') return;
      ensureOverlay();
      overlayEl.style.display = '';
    }
    function hideOverlay() {
      if (overlayEl) overlayEl.style.display = 'none';
      setHot(null);
    }

    function ensureToast() {
      if (toastEl) return toastEl;
      toastEl = doc.createElement('div');
      toastEl.className = 'dt-drop-toast';
      toastEl.setAttribute('role', 'status');
      doc.body.appendChild(toastEl);
      return toastEl;
    }
    function showToast(build, hideMs) {
      var el = ensureToast();
      while (el.firstChild) el.removeChild(el.firstChild);
      build(el);
      el.classList.add('dt-drop-toast-show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        el.classList.remove('dt-drop-toast-show');
        toastTimer = null;
      }, hideMs);
    }
    function toastLine(el, text, cls) {
      var line = doc.createElement('div');
      if (cls) line.className = cls;
      line.textContent = text;
      el.appendChild(line);
    }

    function showProgress(file, doneCount, total) {
      if (typeof deps.onProgress === 'function') deps.onProgress(file, doneCount, total);
      if (customNotify) return;
      showToast(function (el) {
        toastLine(el, targetName + '에 복사 중… ' + file.name + ' (' + doneCount + '/' + total + ')');
      }, 60000);
    }

    function finishBatch() {
      var done = batch;
      batch = null;
      if (!done) return;
      if (typeof deps.onDone === 'function') {
        deps.onDone({ ok: done.ok, total: done.total, failures: done.failures.slice() });
      }
      if (customNotify) return;
      var failCount = done.failures.length;
      showToast(
        function (el) {
          if (!failCount) {
            toastLine(el, '파일 ' + done.ok + '개를 ' + targetName + '에 복사했습니다');
          } else if (done.ok > 0) {
            toastLine(el, '파일 ' + done.ok + '개를 ' + targetName + '에 복사했습니다 · ' + failCount + '개 실패');
          } else {
            toastLine(el, '복사에 실패했습니다');
          }
          var shown = done.failures.slice(0, 5);
          shown.forEach(function (f) {
            toastLine(el, f.name + ' — ' + f.reason, 'dt-drop-toast-fail');
          });
          if (failCount > shown.length) {
            toastLine(el, '외 ' + (failCount - shown.length) + '개 더 실패', 'dt-drop-toast-fail');
          }
        },
        failCount ? 9000 : 4000,
      );
    }

    function pump() {
      if (running) return;
      var entry = queue.shift();
      if (!entry) {
        finishBatch();
        return;
      }
      running = true;
      showProgress(entry.file, batch.settled + 1, batch.total);
      uploadFile(entry.file, entry.folderId).then(
        function () {
          batch.ok += 1;
          batch.settled += 1;
        },
        function (err) {
          batch.settled += 1;
          batch.failures.push({
            name: entry.file.name,
            reason: err && err.message ? String(err.message) : '업로드에 실패했습니다',
          });
        },
      ).then(function () {
        running = false;
        pump();
      });
    }

    /**
     * 드롭된 항목들을 배치에 넣고 사전 검증(폴더·초과·빈 파일)부터 분류한다.
     * folderId는 그 배치의 목적지 (null이면 보관함 루트).
     * preError가 있으면(목적지 폴더를 준비하지 못한 경우) 그 항목을
     * 그 사유로 실패 분류한다 — 엉뚱한 곳에 올린 것보다 실패가 정직하다.
     */
    function acceptItems(items, folderId, preError) {
      if (!items || !items.length) return;
      if (!batch) batch = { total: 0, ok: 0, settled: 0, failures: [] };
      items.forEach(function (it) {
        if (it.folder) {
          batch.total += 1;
          batch.settled += 1;
          batch.failures.push({ name: it.folder, reason: '폴더는 복사할 수 없습니다' });
          return;
        }
        var f = it.file;
        if (!f) return;
        batch.total += 1;
        if (preError) {
          batch.settled += 1;
          batch.failures.push({
            name: f.name,
            reason: preError && preError.message ? String(preError.message) : '목적지를 준비하지 못했습니다',
          });
          return;
        }
        if (f.size > maxSize) {
          batch.settled += 1;
          batch.failures.push({ name: f.name, reason: '10MB를 초과합니다' });
          return;
        }
        if (!f.size) {
          batch.settled += 1;
          batch.failures.push({ name: f.name, reason: '빈 파일입니다' });
          return;
        }
        queue.push({ file: f, folderId: folderId === undefined ? null : folderId });
      });
      if (batch.total === 0) {
        batch = null;
        return;
      }
      pump();
    }

    /** 받지 않는 상태의 드래그: 업로드는 하지 않지만, 기본 동작을
     *  막지 않으면 브라우저가 떨어진 파일을 열어 페이지가 사라진다.
     *  dropEffect 'none'으로 허용 불가 커서까지 맞춘다. */
    function guardRejectedDrag(e) {
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'none';
      } catch (err) {
        console.warn('dropEffect 설정 실패 (무시하고 계속):', err);
      }
    }

    function onDragEnter(e) {
      if (!hasFiles(e.dataTransfer)) return;
      if (!accepted()) {
        guardRejectedDrag(e);
        return;
      }
      e.preventDefault();
      dragDepth += 1;
      showOverlay();
      syncHot(e);
    }
    function onDragOver(e) {
      if (!hasFiles(e.dataTransfer)) return;
      if (!accepted()) {
        guardRejectedDrag(e);
        return;
      }
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch (err) {
        console.warn('dropEffect 설정 실패 (무시하고 계속):', err);
      }
      showOverlay();
      syncHot(e);
    }
    function onDragLeave(e) {
      if (!hasFiles(e.dataTransfer)) return;
      // 창 밖으로 완전히 나간 경우(relatedTarget 없음)는 카운터를 리셋한다
      if (!e.relatedTarget) {
        dragDepth = 0;
        hideOverlay();
        return;
      }
      dragDepth -= 1;
      if (dragDepth <= 0) {
        dragDepth = 0;
        hideOverlay();
      }
    }
    function onDrop(e) {
      if (!hasFiles(e.dataTransfer)) return;
      if (!accepted()) {
        // 받는 척 속이지도, 브라우저 기본 동작을 행하지도 않는다:
        // 기본 동작을 막고 호스트에 알려 고지를 맡긴다.
        e.preventDefault();
        if (typeof deps.onRejectedDrop === 'function') deps.onRejectedDrop(e);
        return;
      }
      e.preventDefault();
      dragDepth = 0;
      hideOverlay();
      var items = collectDropItems(e.dataTransfer);
      if (!items.length) return;
      if (typeof deps.resolveFolderId !== 'function') {
        acceptItems(items, null);
        return;
      }
      Promise.resolve()
        .then(function () {
          return deps.resolveFolderId(e);
        })
        .then(
          function (folderId) {
            acceptItems(items, folderId === undefined ? null : folderId);
          },
          function (err) {
            acceptItems(items, null, err);
          },
        );
    }

    target.addEventListener('dragenter', onDragEnter);
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('dragleave', onDragLeave);
    target.addEventListener('drop', onDrop);

    return {
      /** 테스트·디버깅용: 드롭 항목을 직접 넣는다 */
      acceptItems: acceptItems,
      isBusy: function () {
        return running || queue.length > 0;
      },
      destroy: function () {
        target.removeEventListener('dragenter', onDragEnter);
        target.removeEventListener('dragover', onDragOver);
        target.removeEventListener('dragleave', onDragLeave);
        target.removeEventListener('drop', onDrop);
        if (toastTimer) clearTimeout(toastTimer);
        setHot(null);
        if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        overlayEl = null;
        toastEl = null;
      },
    };
  }

  var api = {
    createDropUpload: createDropUpload,
    createDriveDesktop: createDriveDesktop,
    MAX_SIZE: MAX_SIZE,
    hasFiles: hasFiles,
  };
  if (typeof window !== 'undefined') window.MyHubDesktopDrop = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopDrop = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
