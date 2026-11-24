// 탭-메뉴줄 연결 프로브: 엔진 부팅 후 빈 문서를 열어 문서 탭이
// 그려진 상태를 만든다. Node 쪽이 스크린샷을 찍어 픽셀 측정한다.
window.__log = [];
function log(msg) {
  window.__log.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
}
window.addEventListener('error', function (e) {
  log('WINDOW-ERROR ' + (e.message || e) + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
});
var host = window.MyHubFinderPdfCraft.createHost({
  parentEl: document.getElementById('host'),
  // 전체 레이아웃(APP_URL)으로 잰다 — 이 테스트는 모드바 행(탭 연결·
  // 하단 구분선·우측 아이콘)을 측정하는데, 오피스 호스트 URL은
  // 2026-11-22부터 모드바 행이 없다(nomodebar,noabsorb). 탭 틈 패치는
  // 두 레이아웃에 공통이다.
  url: window.MyHubFinderPdfCraft.APP_URL,
  onReady: function (version) {
    log('READY version=' + version);
    fetch('/templates/blank.pdf')
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) {
        var ok = host.open('probe-doc.pdf', buf);
        log('OPENED ok=' + ok);
      })
      .catch(function (e) { log('FETCH-FAIL ' + e.message); });
  },
  onFallback: function (reason) { log('FALLBACK reason=' + reason); },
  onDirty: function () {},
});
log('host=' + (host ? 'created' : 'NULL'));
