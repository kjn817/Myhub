/* Finder 뷰어 포맷: 시트(xlsx/csv) — SheetJS로 읽어 표로 보여준다.
 *
 * 재구성 근거: 뷰어는 읽기 전용 격자 (편집은 오피스 엑셀 앱). 시트 탭 전환,
 * 앞부분 행만 렌더해 큰 파일에서도 버티게 한다. ownsChrome=true.
 */
(function () {
  'use strict';
  var V = window.FinderViewer;
  if (!V) return;

  var MAX_ROWS = 300;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  V.registerFormat('sheet', {
    render: function (body, file, ctx) {
      body.innerHTML = '<div class="fv-loading">시트를 읽는 중…</div>';
      if (!window.XLSX) {
        body.innerHTML = '<div class="fv-empty">시트 엔진을 불러오지 못했어요.</div>';
        return { canSave: false, ownsChrome: true };
      }
      return ctx.fetchRaw().then(function (buf) {
        var wb = window.XLSX.read(buf, { type: 'array' });
        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fv-sheet';
        var tabs = document.createElement('div');
        tabs.className = 'fv-sheet-tabs';
        var grid = document.createElement('div');
        grid.className = 'fv-sheet-grid';
        wrap.appendChild(tabs);
        wrap.appendChild(grid);
        body.appendChild(wrap);

        function showSheet(name) {
          var ws = wb.Sheets[name];
          var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
          var html = '<table>';
          rows.slice(0, MAX_ROWS).forEach(function (row, ri) {
            html += '<tr>';
            (row || []).forEach(function (cell) {
              html += (ri === 0 ? '<th>' : '<td>') + escapeHtml(cell == null ? '' : cell) + (ri === 0 ? '</th>' : '</td>');
            });
            html += '</tr>';
          });
          html += '</table>';
          if (rows.length > MAX_ROWS) {
            html += '<div class="fv-note">앞 ' + MAX_ROWS + '행만 보여줘요. 전체는 엑셀 앱에서 여세요.</div>';
          }
          grid.innerHTML = html;
          tabs.querySelectorAll('button').forEach(function (b) {
            b.classList.toggle('is-active', b.dataset.sheet === name);
          });
        }

        wb.SheetNames.forEach(function (name, i) {
          var b = document.createElement('button');
          b.type = 'button';
          b.dataset.sheet = name;
          b.textContent = name;
          b.addEventListener('click', function () { showSheet(name); });
          tabs.appendChild(b);
          if (i === 0) setTimeout(function () { showSheet(name); }, 0);
        });
        return { canSave: false, ownsChrome: true };
      });
    },
  });
})();
