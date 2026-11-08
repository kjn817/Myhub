/* MyHub 오피스 파일 선택기 — 보관함에서 열 파일 고르기 (picker.css 계약).
 *
 * 재구성 근거: 열기·저장은 각 앱의 [파일] 메뉴 안에서만 하며, 보관함 탐색은
 * 이 공용 선택기가 맡는다 (Finder에도 같은 css가 배선돼 있다).
 *
 * 노출: window.MyHubOfficePicker.openPicker({title}) → Promise<file|null>
 */
(function () {
  'use strict';

  // 서버 계약 (src/modules/drive/routes.ts): tree 엔드포인트는 없고 목록은
  // /list 하나다. 파일 항목은 filename으로 오므로 name을 함께 채워 돌려준다.
  function tree(folder) {
    return fetch('/api/drive/list?folder=' + encodeURIComponent(folder || 'root'))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        d = (d && (d.data || d)) || {};
        return {
          folders: d.folders || [],
          files: (d.files || []).map(function (f) {
            return Object.assign({}, f, { name: f.name || f.filename || '' });
          }),
        };
      });
  }

  function openPicker(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'myhub-picker-overlay is-open';
      overlay.innerHTML =
        '<div class="myhub-picker" role="dialog" aria-modal="true">' +
        '<div class="myhub-picker-head"><span>' + (opts.title || '파일 열기') + '</span>' +
        '<div class="spacer"></div>' +
        '<button type="button" class="myhub-picker-close" aria-label="닫기"><i data-lucide="x"></i></button></div>' +
        '<div class="myhub-picker-path"></div>' +
        '<div class="myhub-picker-list"></div>' +
        '<div class="myhub-picker-foot"><button type="button" class="myhub-picker-cancel">취소</button></div>' +
        '</div>';
      document.body.appendChild(overlay);
      if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('선택기 아이콘 실패:', e); } }

      var listEl = overlay.querySelector('.myhub-picker-list');
      var pathEl = overlay.querySelector('.myhub-picker-path');
      var stack = [{ id: 'root', name: '보관함' }];

      function done(file) {
        overlay.remove();
        resolve(file || null);
      }

      function render() {
        var current = stack[stack.length - 1];
        pathEl.textContent = stack.map(function (s) { return s.name; }).join(' › ');
        listEl.innerHTML = '<div class="myhub-picker-empty">불러오는 중…</div>';
        tree(current.id).then(function (d) {
          listEl.innerHTML = '';
          if (stack.length > 1) {
            var up = document.createElement('button');
            up.type = 'button';
            up.className = 'myhub-picker-row';
            up.innerHTML = '<i data-lucide="corner-up-left"></i><span>상위 폴더</span>';
            up.addEventListener('click', function () { stack.pop(); render(); });
            listEl.appendChild(up);
          }
          (d.folders || []).forEach(function (f) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'myhub-picker-row';
            row.innerHTML = '<i data-lucide="folder"></i><span></span>';
            row.querySelector('span').textContent = f.name;
            row.addEventListener('click', function () {
              stack.push({ id: f.id, name: f.name });
              render();
            });
            listEl.appendChild(row);
          });
          (d.files || []).forEach(function (f) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'myhub-picker-row';
            var icon = window.MyHubFileIcons ? window.MyHubFileIcons.htmlFor(f, 20) : '<i data-lucide="file"></i>';
            row.innerHTML = icon + '<span></span>';
            row.querySelector('span').textContent = f.name;
            row.addEventListener('click', function () { done(f); });
            listEl.appendChild(row);
          });
          if (!listEl.children.length) {
            listEl.innerHTML = '<div class="myhub-picker-empty">비어 있어요.</div>';
          }
          if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('선택기 아이콘 실패:', e); } }
        }).catch(function () {
          listEl.innerHTML = '<div class="myhub-picker-empty">불러오지 못했어요.</div>';
        });
      }

      overlay.querySelector('.myhub-picker-close').addEventListener('click', function () { done(null); });
      overlay.querySelector('.myhub-picker-cancel').addEventListener('click', function () { done(null); });
      overlay.addEventListener('click', function (ev) { if (ev.target === overlay) done(null); });
      render();
    });
  }

  var api = { openPicker: openPicker };
  if (typeof window !== 'undefined') window.MyHubOfficePicker = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficePicker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
