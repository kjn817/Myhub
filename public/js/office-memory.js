/* MyHub 세션 등 등 메 모리 (office-memory.js)
 *
 * 깊이 기억하는 것 (전부 localStorage, 서버 정보 없음):
 * - 최 근: 파 일 8새로 (id최대mime개version이름). 시간
 *   화면 목록에서 등 번에 다시 건다. 남긴 version이 약한 등 두어,
 *   다시 등 여는 폴더를 구조해 최신 version로 건다.
 * - 이어 열기: 마지막 파일의 시작 화면은 시안만 낸다 (편집기
 *   자동으로 띄우지 않는다).
 *
 * 노출: window.MyHubOfficeMemory = { createMemory }
 * deps = { doc, storage, appKey, icons, listFolder(id),
 *          openFile(file) -> Promise }
 */
(function () {
  'use strict';

  function fmtWhen(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getMonth() + 1 + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function createMemory(deps) {
    deps = deps || {};
    var doc = deps.doc || document;
    var storage = deps.storage || null;
    var icons = deps.icons || null;
    var appKey = deps.appKey || '';
    var K_RECENT = 'myhub.office.' + appKey + '.recent.v1';
    var K_LAST = 'myhub.office.' + appKey + '.lastFile.v1';
    var el = function (id) { return doc.getElementById(id); };

    function storeGet(key, fallback) {
      if (!storage) return fallback;
      try {
        var raw = storage.getItem(key);
        if (!raw) return fallback;
        var parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch (e) {
        console.warn('세션 등 메모리 읽기 실패:', e);
        return fallback;
      }
    }
    function storeSet(key, value) {
      if (!storage) return;
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('세션 등 메모리 쓰기 실패:', e);
      }
    }

    function loadRecents() {
      var list = storeGet(K_RECENT, []);
      return Array.isArray(list) ? list.filter(function (r) { return r && r.id; }) : [];
    }
    function record(file) {
      if (!file || !file.fileId) return;
      var entry = {
        id: file.fileId, name: file.name, mime: file.mime || '',
        version: file.version || null,
        folderId: file.folderId === undefined ? null : file.folderId,
        folderName: file.folderName || '',
        at: Date.now(),
      };
      var list = loadRecents().filter(function (r) { return r.id !== entry.id; });
      list.unshift(entry);
      storeSet(K_RECENT, list.slice(0, 8));
      storeSet(K_LAST, entry);
      render();
    }
    function forget(id) {
      storeSet(K_RECENT, loadRecents().filter(function (r) { return r.id !== id; }));
      var last = storeGet(K_LAST, null);
      if (last && last.id === id) storeSet(K_LAST, null);
      render();
    }

    function openRecent(entry) {
      if (!entry) return Promise.resolve(false);
      // 남긴 version이 약한 등 두어 폴더를 다시 조회해 최신
      // version로 건다 (내용 캐시 대조도 등 version 기준이다).
      return deps
        .listFolder(entry.folderId)
        .then(function (listing) {
          var row = (listing.files || []).filter(function (f) { return f.id === entry.id; })[0];
          if (!row) {
            forget(entry.id);
            return false;
          }
          return deps.openFile({
            fileId: row.id, name: row.filename, mime: row.mime || '',
            version: row.version || null,
            folderId: entry.folderId, folderName: entry.folderName || '',
          });
        })
        .catch(function () { return false; });
    }

    function recentRow(entry) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'office-recent-row';
      var ic = doc.createElement('span');
      ic.className = 'office-recent-icon';
      ic.innerHTML = icons ? icons.htmlFor({ name: entry.name, mime: entry.mime }) : '';
      b.appendChild(ic);
      var nm = doc.createElement('span');
      nm.className = 'office-recent-name';
      nm.textContent = entry.name;
      b.appendChild(nm);
      var mt = doc.createElement('span');
      mt.className = 'office-recent-meta';
      mt.textContent = (entry.folderName ? entry.folderName + ' 쨌 ' : '') + fmtWhen(entry.at);
      b.appendChild(mt);
      b.addEventListener('click', function () { openRecent(entry); });
      return b;
    }
    function renderRecents() {
      var wrap = el('officeRecentWrap');
      var list = el('officeRecent');
      if (!wrap || !list) return;
      var recents = loadRecents();
      wrap.hidden = !recents.length;
      list.innerHTML = '';
      var frag = doc.createDocumentFragment();
      recents.forEach(function (entry) { frag.appendChild(recentRow(entry)); });
      list.appendChild(frag);
    }
    function renderResume() {
      var wrap = el('officeResume');
      var btn = el('officeResumeBtn');
      if (!wrap || !btn) return;
      var last = storeGet(K_LAST, null);
      wrap.hidden = !last;
      if (last) {
        btn.textContent = last.name;
        btn.onclick = function () { openRecent(last); };
      }
    }
    function render() {
      renderRecents();
      renderResume();
    }

    return { record: record, forget: forget, openRecent: openRecent, render: render, loadRecents: loadRecents };
  }

  var api = { createMemory: createMemory };
  if (typeof window !== 'undefined') window.MyHubOfficeMemory = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficeMemory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
