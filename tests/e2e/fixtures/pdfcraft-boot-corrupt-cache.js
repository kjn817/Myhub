// pdfcraft 손상 캐시 부팅 프로브 — CacheStorage에 잘린 WASM 파트가
// 남아 있는 상태(사용자 실화면 2026-11-21)에서 부팅이 자가 복구되는지
// 확인한다. 매니페스트에서 파트 이름을 읽어(해시 하드코딩 금지) part0을
// 1MB짜리 0 바이트로 심은 뒤 호스트를 부팅한다. 검증이 없으면 잘린
// 파트가 조립돼 init이 조용히 죽고 45초 뒤 FALLBACK timeout만 뜬다.
window.__log = [];
function log(msg) {
  window.__log.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
}
window.addEventListener('error', function (e) {
  log('WINDOW-ERROR ' + (e.message || e) + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
});
(async function () {
  try {
    var man = await (await fetch('/vendor/pdfcraft/manifest.json')).json();
    var part0 = '/vendor/pdfcraft/' + man.wasmParts[0];
    var expected = man.wasmPartBytes && man.wasmPartBytes[0];
    log('manifest part0=' + part0 + ' expected=' + expected);
    var cache = await caches.open('myhub-pdfcraft-parts');
    await cache.put(new URL(part0, location.href).href, new Response(new Uint8Array(1000000)));
    log('SEEDED truncated part0 bytes=1000000 (expected ' + expected + ')');
  } catch (e) {
    log('SEED-FAILED ' + (e && e.message));
    return;
  }
  log('core=' + (typeof window.MyHubCraftPrefetchCore) + ' pdfcraft=' + (typeof window.MyHubFinderPdfCraft));
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
})();
