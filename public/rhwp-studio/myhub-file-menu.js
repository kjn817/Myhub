/* rhwp 스튜디오 × MyHub 파일 메뉴 배선.
 *
 * 재구성 근거: 한글 스튜디오의 [파일] 메뉴에 '보관함에서 열기'와 '보관함에
 * 저장'을 배선한다. 중복 셰브론 삽입 로직은 최종 상태에서 제거됨 — 접기
 * 셰브론은 호스트(office.html) 메뉴 줄 우측 끝이 유일한 자리다.
 * handleHwp.ownsChrome=true — Finder 뷰어에서 한글은 자체 표면을 쓴다.
 *
 * 스튜디오가 window.MyHubFileMenuBridge = {openPicker, save}를 제공하거나,
 * 없으면 부모(office.html)의 오피스 프로토콜로 위임한다.
 */
(function () {
  'use strict';

  function delegate(type, payload) {
    if (window.MyHubFileMenuBridge && typeof window.MyHubFileMenuBridge[type] === 'function') {
      return window.MyHubFileMenuBridge[type](payload);
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'myhub:file-menu', action: type, payload: payload || null }, window.location.origin);
    }
    return null;
  }

  function wireFileMenu() {
    var menu = document.querySelector('[data-menu="file"], .file-menu, #fileMenu');
    if (!menu || menu.dataset.myhubWired === '1') return;
    menu.dataset.myhubWired = '1';

    function addItem(label, action) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'myhub-file-menu-item';
      item.textContent = label;
      item.addEventListener('click', function () { delegate(action); });
      menu.appendChild(item);
    }

    addItem('보관함에서 열기', 'openPicker');
    addItem('보관함에 저장', 'save');
  }

  var handleHwp = {
    ownsChrome: true,
    wireFileMenu: wireFileMenu,
    openFromVault: function () { return delegate('openPicker'); },
    saveToVault: function (payload) { return delegate('save', payload); },
  };

  if (typeof window !== 'undefined') window.MyHubHwpFileMenu = handleHwp;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireFileMenu);
  } else {
    wireFileMenu();
  }
})();
