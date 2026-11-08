/* MyHub Finder 뷰어 코어 — 포맷 모듈 레지스트리.
 *
 * 재구성 근거: finder-viewer.js 코어 + registerFormat(kind, handler) 포맷 모듈
 * (text·hwp·sheet·slide·doc·pdf). DOM 계약: #finderViewer/#fvName/#fvSave/
 * #fvBody, 플로팅 클러스터 #fvChrome은 ownsChrome=true 포맷에서 숨긴다.
 * 저장은 createSave — base_version을 함께 보내고 409는 충돌로 안내한다.
 * ctx는 fetchRaw(원본 바이트)·fetchText·fetchJson·save를 제공한다.
 *
 * 노출: window.FinderViewer
 */
(function () {
  'use strict';

  var formats = {}; // kind → handler

  function registerFormat(kind, handler) {
    formats[kind] = handler;
  }

  function kindOf(file) {
    var name = String((file && file.name) || '').toLowerCase();
    var mime = String((file && file.mime) || file && file.mime_type || '').toLowerCase();
    function ext(suffix) { return name.endsWith(suffix); }
    if (ext('.pdf') || mime === 'application/pdf') return 'pdf';
    if (ext('.hwp') || ext('.hwpx')) return 'hwp';
    if (ext('.xlsx') || ext('.xls') || ext('.csv')) return 'sheet';
    if (ext('.pptx') || ext('.ppt')) return 'slide';
    if (ext('.docx') || ext('.doc')) return 'doc';
    if (mime.indexOf('image/') === 0) return 'image';
    if (mime.indexOf('text/') === 0 || ext('.txt') || ext('.md') || ext('.json')) return 'text';
    return 'unknown';
  }

  function contentUrl(file) {
    return '/api/drive/files/' + encodeURIComponent(file.id) + '/content';
  }

  /**
   * 저장 헬퍼: 파일을 다시 올리며 base_version으로 낙관적 동시성을 건다.
   * 409면 {conflict:true}를 돌려주고, 호출자가 사용자에게 안내한다.
   */
  function createSave(file) {
    var baseVersion = file.version || file.updated_at || null;
    return function save(blob) {
      var form = new FormData();
      form.append('file', blob, file.name);
      if (baseVersion) form.append('base_version', String(baseVersion));
      return fetch(contentUrl(file), { method: 'PUT', body: form })
        .then(function (r) {
          if (r.status === 409) return { conflict: true };
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json().then(function (data) {
            var payload = (data && (data.data || data)) || {};
            if (payload.version) baseVersion = payload.version;
            return { ok: true, version: baseVersion };
          });
        });
    };
  }

  function makeCtx(file) {
    return {
      file: file,
      contentUrl: contentUrl(file),
      fetchRaw: function () {
        return fetch(contentUrl(file)).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        });
      },
      fetchText: function () {
        return fetch(contentUrl(file)).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        });
      },
      fetchJson: function (url) {
        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        });
      },
      save: createSave(file),
    };
  }

  function createViewer(deps) {
    deps = deps || {};
    var rootEl = deps.root || document.getElementById('finderViewer');
    if (!rootEl) return null;
    var nameEl = rootEl.querySelector('#fvName');
    var saveBtn = rootEl.querySelector('#fvSave');
    var bodyEl = rootEl.querySelector('#fvBody');
    var chromeEl = rootEl.querySelector('#fvChrome');
    var closeBtn = rootEl.querySelector('#fvClose');
    var current = null; // {file, handler, result}

    function setChromeVisible(visible) {
      if (chromeEl) chromeEl.style.display = visible ? '' : 'none';
    }

    function close() {
      rootEl.classList.remove('is-open');
      if (current && current.result && typeof current.result.dispose === 'function') {
        try { current.result.dispose(); } catch (e) { console.debug('뷰어 정리 실패:', e); }
      }
      current = null;
      if (bodyEl) bodyEl.innerHTML = '';
      if (typeof deps.onClose === 'function') deps.onClose();
    }

    function open(file) {
      var kind = kindOf(file);
      var handler = formats[kind];
      if (nameEl) nameEl.textContent = file.name || '';
      rootEl.classList.add('is-open');
      if (saveBtn) saveBtn.style.display = 'none';
      setChromeVisible(true);
      if (bodyEl) bodyEl.innerHTML = '<div class="fv-loading">불러오는 중…</div>';
      if (!handler) {
        if (bodyEl) {
          bodyEl.innerHTML = '<div class="fv-empty">이 형식은 미리보기를 지원하지 않아요.<br>' +
            '<a href="' + contentUrl(file) + '" download>파일 내려받기</a></div>';
        }
        current = { file: file, handler: null, result: null };
        return Promise.resolve(false);
      }
      var ctx = makeCtx(file);
      var rendered;
      try {
        rendered = handler.render(bodyEl, file, ctx);
      } catch (e) {
        rendered = Promise.reject(e);
      }
      return Promise.resolve(rendered).then(function (result) {
        result = result || {};
        current = { file: file, handler: handler, result: result };
        setChromeVisible(!result.ownsChrome);
        if (result.canSave && typeof result.save === 'function' && saveBtn) {
          saveBtn.style.display = '';
          saveBtn.onclick = function () {
            saveBtn.disabled = true;
            Promise.resolve(result.save()).then(function (out) {
              if (out && out.conflict) {
                window.alert('다른 곳에서 먼저 바뀐 파일이에요. 새로고침 후 다시 시도해 주세요. (409)');
              }
            }).catch(function () {
              window.alert('저장에 실패했어요.');
            }).finally(function () { saveBtn.disabled = false; });
          };
        }
        return true;
      }).catch(function (e) {
        console.debug('뷰어 렌더 실패:', e);
        if (bodyEl) bodyEl.innerHTML = '<div class="fv-empty">파일을 열지 못했어요.</div>';
        return false;
      });
    }

    if (closeBtn) closeBtn.addEventListener('click', close);
    rootEl.addEventListener('click', function (ev) {
      if (ev.target === rootEl) close();
    });

    return {
      open: open,
      close: close,
      isOpen: function () { return rootEl.classList.contains('is-open'); },
      currentFile: function () { return current ? current.file : null; },
    };
  }

  var api = {
    registerFormat: registerFormat,
    kindOf: kindOf,
    contentUrl: contentUrl,
    createSave: createSave,
    createViewer: createViewer,
    formats: formats,
  };

  if (typeof window !== 'undefined') window.FinderViewer = api;
  if (typeof globalThis !== 'undefined') globalThis.FinderViewer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
