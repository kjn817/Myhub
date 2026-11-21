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
  url: window.MyHubFinderPdfCraft.APP_URL_HOSTED,
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
