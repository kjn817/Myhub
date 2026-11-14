// 메뉴 항목 매핑 공용 코어 — public/js/common/menu-items.js
//
// desktop/windows.js의 mapOfficeMenuItems와 office-tabs.js의
// mapLocalMenuItems를 한 곳으로 모은다 (F-L11, 5-5). 두 사본은
// 선택 시 동작만 달랐다 (windows는 exec 콜백, office-tabs는
// menu-exec dispatch) — onSelect 콜백 인자로 합친다.
//
// 보존하는 계약:
// - null·비객체 노드는 건너뛰고, separator는 {separator:true}로,
//   label 없는 노드는 건너뛴다.
// - shortcut은 비어 있지 않은 문자열일 때만, checked는 boolean일
//   때만 복사한다.
// - children이 있으면 재귀하고, 없으면 path가 있을 때 onSelect를
//   부르는 onSelect 클로저를 단다 (path는 slice로 복사).
// - 코어가 없으면 소비처 래퍼가 호출 시점에 명확한 오류를 던진다
//   (메뉴 매핑은 호출 시점 동작이라 로드 시점에 죽이지 않는다).
(function () {
  'use strict';

  function mapMenuItems(nodes, onSelect) {
    var out = [];
    (Array.isArray(nodes) ? nodes : []).forEach(function (n) {
      if (!n || typeof n !== 'object') return;
      if (n.separator) {
        out.push({ separator: true });
        return;
      }
      if (typeof n.label !== 'string' || !n.label) return;
      var item = { label: n.label, disabled: !!n.disabled };
      if (typeof n.shortcut === 'string' && n.shortcut) {
        item.shortcut = n.shortcut;
      }
      if (typeof n.checked === 'boolean') {
        item.checked = n.checked;
      }
      if (Array.isArray(n.children) && n.children.length) {
        item.children = mapMenuItems(n.children, onSelect);
      } else if (Array.isArray(n.path)) {
        var p = n.path.slice();
        item.onSelect = function () {
          onSelect(p);
        };
      }
      out.push(item);
    });
    return out;
  }

  var api = { mapMenuItems: mapMenuItems };
  if (typeof window !== 'undefined') window.MyHubMenuItems = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubMenuItems = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
