/* Finder 뷰어 포맷: 슬라이드(pptx) — JSZip으로 풀어 슬라이드별 텍스트를 보여준다.
 *
 * 재구성 근거: 뷰어는 슬라이드 텍스트 확인용 (편집은 오피스 파워포인트 앱).
 * ownsChrome=true.
 */
(function () {
  'use strict';
  var V = window.FinderViewer;
  if (!V) return;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function slideTexts(xml) {
    var texts = [];
    var re = /<a:t>([^<]*)<\/a:t>/g;
    var m;
    while ((m = re.exec(xml)) !== null) texts.push(m[1]);
    return texts;
  }

  V.registerFormat('slide', {
    render: function (body, file, ctx) {
      body.innerHTML = '<div class="fv-loading">슬라이드를 읽는 중…</div>';
      if (!window.JSZip) {
        body.innerHTML = '<div class="fv-empty">슬라이드 엔진을 불러오지 못했어요.</div>';
        return { canSave: false, ownsChrome: true };
      }
      return ctx.fetchRaw().then(function (buf) {
        return window.JSZip.loadAsync(buf);
      }).then(function (zip) {
        var names = Object.keys(zip.files)
          .filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
          .sort(function (a, b) {
            return Number(a.match(/slide(\d+)\.xml/)[1]) - Number(b.match(/slide(\d+)\.xml/)[1]);
          });
        return Promise.all(names.map(function (n) { return zip.files[n].async('string'); }))
          .then(function (xmls) {
            body.innerHTML = '';
            var wrap = document.createElement('div');
            wrap.className = 'fv-slides';
            xmls.forEach(function (xml, i) {
              var card = document.createElement('section');
              card.className = 'fv-slide';
              var texts = slideTexts(xml);
              card.innerHTML = '<div class="fv-slide-no">' + (i + 1) + '</div>' +
                texts.map(function (t) { return '<p>' + escapeHtml(t) + '</p>'; }).join('');
              wrap.appendChild(card);
            });
            if (!xmls.length) {
              wrap.innerHTML = '<div class="fv-empty">슬라이드를 찾지 못했어요.</div>';
            }
            body.appendChild(wrap);
            return { canSave: false, ownsChrome: true };
          });
      });
    },
  });
})();
