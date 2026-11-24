// 셸 크롬 프로브: 호스트 URL(chrome=nomodebar,noabsorb)로 엔진을
// 부팅해 빈 문서를 연다. 모드·메뉴 상태 보고를 로그에 남기고, 호스트
// 객체를 window.__pdfcraftHost로 노출해 Node 쪽이 모드 전환·메뉴
// 명령을 보낼 수 있게 한다.
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
  onModeState: function (mode) { log('MODE-STATE ' + mode); },
  onMenusState: function (menus) {
    log('MENUS-STATE ' + menus.map(function (m) { return m.id; }).join(','));
  },
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
window.__pdfcraftHost = host;
log('host=' + (host ? 'created' : 'NULL'));
