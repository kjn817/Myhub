/* Finder 뷰어 포맷: 텍스트 — 보고 바로 고쳐 저장할 수 있다. */
(function () {
  'use strict';
  var V = window.FinderViewer;
  if (!V) return;

  V.registerFormat('text', {
    render: function (body, file, ctx) {
      return ctx.fetchText().then(function (text) {
        body.innerHTML = '';
        var area = document.createElement('textarea');
        area.className = 'fv-text';
        area.value = text;
        area.spellcheck = false;
        body.appendChild(area);
        return {
          canSave: true,
          save: function () {
            return ctx.save(new Blob([area.value], { type: 'text/plain;charset=utf-8' }));
          },
        };
      });
    },
  });

  V.registerFormat('image', {
    render: function (body, file, ctx) {
      body.innerHTML = '';
      var img = document.createElement('img');
      img.className = 'fv-image';
      img.alt = file.name || '';
      img.src = ctx.contentUrl;
      body.appendChild(img);
      return { canSave: false };
    },
  });
})();
