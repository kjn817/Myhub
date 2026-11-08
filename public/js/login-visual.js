/* 로그인 페이지 시각 보조 (login-visual.js) — 순수 표시 전용.
 *
 * 인증 흐름·검증은 전부 login.js가 담당하고, 이 파일은 건드리지 않는다.
 * 하는 일은 하나뿐이다: 오류(.error.show)가 뜨면 카드에 가벼운 흔들림
 * (.shake)을 한 번 준다 (macOS 로그인 실패 제스처). 상태 변경·전송은
 * 일절 하지 않는다.
 *
 * PIN 진행 표시는 입력창 자체의 마스킹 점이 맡는다 — 별도 점 행
 * (pin-dots)을 두면 같은 상태가 두 번 그려져 중복으로 보인다
 * (사용자 지적 2026-11-03으로 제거).
 */
(function () {
  'use strict';

  var card = document.querySelector('.card');
  if (card && typeof MutationObserver !== 'undefined') {
    var errors = document.querySelectorAll('.error');
    for (var i = 0; i < errors.length; i++) {
      (function (err) {
        new MutationObserver(function () {
          if (!err.classList.contains('show')) return;
          card.classList.remove('shake');
          void card.offsetWidth; // 애니메이션 재시작
          card.classList.add('shake');
        }).observe(err, { attributes: true, attributeFilter: ['class'] });
      })(errors[i]);
    }
  }
})();
