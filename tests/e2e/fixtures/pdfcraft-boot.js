// pdfcraft 부팅 프로브 본문 — 인라인 스크립트는 CSP에 막히므로 외부 파일로 둔다.
window.__log = [];
function log(msg) {
  window.__log.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
}
window.addEventListener('error', function (e) {
  log('WINDOW-ERROR ' + (e.message || e) + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
});
log('core=' + (typeof window.MyHubCraftPrefetchCore) + ' pdfcraft=' + (typeof window.MyHubFinderPdfCraft));
// 오피스 경로와 동일한 호스트 URL(chrome 파라미터 포함)로 부팅한다.
var host = window.MyHubFinderPdfCraft.createHost({
  parentEl: document.getElementById('host'),
  url: window.MyHubFinderPdfCraft.APP_URL_HOSTED,
  onBootProgress: function (p) {
    log('progress bytes=' + p.receivedBytes + ' files=' + p.filesDone + '/' + p.filesTotal + ' url=' + (p.currentUrl || '').split('/').pop() + ' attempt=' + p.attempt);
  },
  onReady: function (version) { log('READY version=' + version); },
  onFallback: function (reason) { log('FALLBACK reason=' + reason); },
  onDirty: function (d) { log('dirty=' + d); },
});
log('host=' + (host ? 'created frame.src=' + (host.frame && host.frame.src) : 'NULL'));
if (host) {
  setInterval(function () {
    log('tick ready=' + host.isReady() + ' frame.src=' + (host.frame.src || '').slice(0, 120));
  }, 10000);
}
