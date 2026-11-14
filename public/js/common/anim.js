// 데스크톱 애니메이션·위치 공용 코어 — public/js/common/anim.js
//
// desktop/desktop-icons.js와 desktop/widgets.js가 공유하던 raf·
// cancelRaf·getPositions 스냅샷을 한 곳으로 모은다 (F-L13, 5-5).
//
// 보존하는 계약:
// - raf는 requestAnimationFrame이 있으면 쓰고, 없으면 setTimeout 0으로
//   폴백한다. cancelRaf는 짝을 맞춰 취소한다.
// - copyPositions는 {id: {x, y}} 맵을 새 객체로 복사한다 (원본 참조를
//   내보내지 않는다).
// - 코어가 없으면 소비처 래퍼가 호출 시점에 명확한 오류를 던진다
//   (드래그 루프 동작이라 로드 시점에 죽이지 않는다).
(function () {
  'use strict';

  function raf(fn) {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
      return window.requestAnimationFrame(fn);
    return setTimeout(fn, 0);
  }

  function cancelRaf(id) {
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function')
      window.cancelAnimationFrame(id);
    else clearTimeout(id);
  }

  function copyPositions(positions) {
    var out = {};
    Object.keys(positions).forEach(function (k) {
      out[k] = { x: positions[k].x, y: positions[k].y };
    });
    return out;
  }

  var api = { raf: raf, cancelRaf: cancelRaf, copyPositions: copyPositions };
  if (typeof window !== 'undefined') window.MyHubAnim = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubAnim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
