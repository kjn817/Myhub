/* Finder 뷰어 포맷: 한글(hwp/hwpx) — kordoc 추출 우선, 실패 시 기존 추출 폴백.
 *
 * 재구성 근거: kordoc readText로 본문·표 구조를 읽고, 실패하면 서버의 기존
 * 추출 엔드포인트로 폴백한다. 뷰어에서는 읽기 전용 (편집은 오피스 한글 앱).
 * ownsChrome=true — 자체 표면을 쓴다.
 * kordoc 번들 배선 (2026-11-07 복구): 지연 로딩으로 /vendor/kordoc/kordoc.bundle.js
 * (ES 모듈)를 동적 import해 window.kordoc에 노출한다. 번들의 readText는
 * { markdown }을 반환하므로 문자열로 정규화해 감싼다.
 */
(function () {
  'use strict';
  var V = window.FinderViewer;
  if (!V) return;

  var KORDOC_URL = '/vendor/kordoc/kordoc.bundle.js';
  var kordocPromise = null;
  function loadKordoc() {
    var existing = window.kordoc || window.Kordoc;
    if (existing && typeof existing.readText === 'function') return Promise.resolve(existing);
    if (!kordocPromise) {
      kordocPromise = import(KORDOC_URL).then(function (mod) {
        var api = mod.default || mod;
        var wrapped = {
          readText: function (buf, name) {
            return Promise.resolve(api.readText(buf, name)).then(function (r) {
              return typeof r === 'string' ? r : (r && r.markdown) || '';
            });
          },
          markdownToHwpx: api.markdownToHwpx,
          parse: api.parse,
        };
        window.kordoc = wrapped;
        return wrapped;
      });
    }
    return kordocPromise;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  V.registerFormat('hwp', {
    render: function (body, file, ctx) {
      body.innerHTML = '<div class="fv-loading">한글 문서를 읽는 중…</div>';
      var viaKordoc = loadKordoc()
        .then(function (kordoc) {
          return ctx.fetchRaw().then(function (buf) { return kordoc.readText(buf, file.name); });
        });
      return viaKordoc
        .then(function (text) { return { text: text, source: 'kordoc' }; })
        .catch(function () {
          return ctx.fetchJson('/api/drive/files/' + encodeURIComponent(file.id) + '/text')
            .then(function (data) {
              var payload = (data && (data.data || data)) || {};
              return { text: payload.text || '', source: 'fallback' };
            });
        })
        .then(function (out) {
          body.innerHTML = '';
          var wrap = document.createElement('div');
          wrap.className = 'fv-doc fv-hwp';
          if (out.source === 'fallback') {
            var note = document.createElement('div');
            note.className = 'fv-note';
            note.textContent = '기본 추출로 읽었어요. 표 구조가 단순하게 보일 수 있어요.';
            wrap.appendChild(note);
          }
          var pre = document.createElement('div');
          pre.className = 'fv-doc-body';
          pre.innerHTML = escapeHtml(out.text || '').replace(/\n/g, '<br>');
          wrap.appendChild(pre);
          body.appendChild(wrap);
          return { canSave: false, ownsChrome: true };
        });
    },
  });
})();
