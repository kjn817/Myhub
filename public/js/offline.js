/* MyHub 오프라인 폴백 동작 — 다시 시도 버튼 + 온라인 복귀 시 자동 새로고침. */
(function () {
  'use strict';

  var btn = document.getElementById('offlineRetry');
  if (btn) {
    btn.addEventListener('click', function () { location.reload(); });
  }
  window.addEventListener('online', function () { location.reload(); });
})();
