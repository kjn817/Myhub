/* Finder 뷰어 포맷: 워드(docx) — mammoth로 HTML 변환해 보여준다 (읽기 전용). */
(function () {
  'use strict';
  var V = window.FinderViewer;
  if (!V) return;

  V.registerFormat('doc', {
    render: function (body, file, ctx) {
      body.innerHTML = '<div class="fv-loading">문서를 읽는 중…</div>';
      if (!window.mammoth) {
        body.innerHTML = '<div class="fv-empty">문서 엔진을 불러오지 못했어요.</div>';
        return { canSave: false };
      }
      return ctx.fetchRaw().then(function (buf) {
        return window.mammoth.convertToHtml({ arrayBuffer: buf });
      }).then(function (out) {
        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fv-doc';
        wrap.innerHTML = out.value || '<div class="fv-empty">본문이 비어 있어요.</div>';
        body.appendChild(wrap);
        return { canSave: false };
      });
    },
  });
})();
