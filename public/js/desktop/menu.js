/* MyHub 공용 우클릭 메뉴 — 데스크톱 아이콘·독·Finder가 함께 쓴다.
 *
 * 재구성 근거: 2026-11-02 공용 우클릭 메뉴 신설 — 아이콘(열기·독에 추가·
 * 휴지통으로 이동, 다중 선택 시 전체), 독(열기·제거/고정, Finder 제거 불가).
 * 공용 컴포넌트 클래스·ID는 myhub- 접두사 규칙을 따른다.
 *
 * 노출: window.MyHubDesktopMenu + module.exports
 */
(function () {
  'use strict';

  var openMenuEl = null;

  function close() {
    if (openMenuEl && openMenuEl.parentNode) openMenuEl.parentNode.removeChild(openMenuEl);
    openMenuEl = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onDocDown(ev) {
    if (openMenuEl && !openMenuEl.contains(ev.target)) close();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') close();
  }

  /**
   * 메뉴를 연다. items: [{label, danger?, disabled?, onSelect}]
   * 위치는 뷰포트 안에 들어오도록 보정한다.
   */
  function show(opts) {
    close();
    var doc = (opts && opts.document) || document;
    var menu = doc.createElement('div');
    menu.className = 'myhub-context-menu';
    menu.setAttribute('role', 'menu');
    (opts.items || []).forEach(function (item) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'myhub-context-item' + (item.danger ? ' myhub-context-item-danger' : '');
      btn.textContent = item.label;
      btn.disabled = !!item.disabled;
      btn.addEventListener('click', function () {
        close();
        if (typeof item.onSelect === 'function') item.onSelect();
      });
      menu.appendChild(btn);
    });
    doc.body.appendChild(menu);
    var mw = menu.offsetWidth || 200;
    var mh = menu.offsetHeight || 40;
    var x = Math.min(opts.x, window.innerWidth - mw - 8);
    var y = Math.min(opts.y, window.innerHeight - mh - 8);
    menu.style.left = Math.max(4, x) + 'px';
    menu.style.top = Math.max(4, y) + 'px';
    openMenuEl = menu;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    return menu;
  }

  var api = { show: show, close: close };

  if (typeof window !== 'undefined') window.MyHubDesktopMenu = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopMenu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
