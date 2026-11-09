// 오프라인 대관 페이지 배선 등 CSP enforce를 위해 onclick 속성을
// addEventListener로 전환 (2026-11-01). sw.js가 offline.html과 함께 프리캐시한다.
document.getElementById('retryBtn').addEventListener('click', function () {
  location.reload();
});
