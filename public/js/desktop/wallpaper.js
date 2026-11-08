/* MyHub 데스크톱 배경화면 — 오늘의 사진 (Bing) 단일 경로.
 *
 * 재구성 근거 (2026-11-02 최종): 그라데이션 프리셋·설정 항목 전면 폐지 —
 * loadPref는 어떤 저장값도 {mode:'today'}로 정규화한다. 부팅 즉시 날짜 버전
 * URL(?v=<KST 날짜>)로 Image() 프로브를 걸고, /today(캡션)는 병렬로만 받는다
 * (메타데이터가 늦어도 사진이 먼저 뜬다). 동일 출처 프록시
 * /api/desktop/wallpaper/image 경유 (CSP img-src 'self' 때문 — 외부 직로딩 금지).
 * 프로브 실패 시 그라데이션 폴백. 준비되면 크로스페이드로 교체한다.
 *
 * 노출: window.MyHubDesktopWallpaper + module.exports
 */
(function () {
  'use strict';

  var PREF_KEY = 'myhub.desktop.wallpaper.v1';

  function loadPref(storage) {
    // 저장값과 무관하게 오늘의 사진으로 정규화한다 (프리셋 폐지).
    try { storage.getItem(PREF_KEY); } catch (e) { console.debug('배경 저장값 확인 실패:', e); }
    return { mode: 'today' };
  }

  function kstDateString(now) {
    var d = now || new Date();
    var kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    var m = String(kst.getUTCMonth() + 1).padStart(2, '0');
    var day = String(kst.getUTCDate()).padStart(2, '0');
    return kst.getUTCFullYear() + m + day;
  }

  function imageUrl(now) {
    return '/api/desktop/wallpaper/image?v=' + kstDateString(now);
  }

  function createWallpaper(deps) {
    var layer = deps.layer;
    var doc = layer.ownerDocument;
    var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);

    function setBackground(url) {
      var img = doc.createElement('div');
      img.className = 'dt-wallpaper-img';
      img.style.backgroundImage = 'url("' + url + '")';
      layer.appendChild(img);
      // 크로스페이드: 다음 프레임에 클래스 부여
      var raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : function (fn) { fn(); };
      raf(function () { img.classList.add('is-ready'); });
      var old = layer.querySelectorAll('.dt-wallpaper-img');
      for (var i = 0; i < old.length - 1; i++) {
        (function (node) { setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 700); })(old[i]);
      }
    }

    function start() {
      var url = imageUrl(new Date());
      var probe = new Image();
      probe.onload = function () { setBackground(url); };
      probe.onerror = function () {
        layer.classList.add('dt-wallpaper-fallback');
      };
      probe.src = url;
      if (fetchFn && deps.captionEl) {
        fetchFn('/api/desktop/wallpaper/today')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            var payload = data && (data.data || data);
            if (payload && payload.caption) deps.captionEl.textContent = payload.caption;
          })
          .catch(function (e) { /* 캡션은 장식 — 실패해도 표면은 계속 */ console.warn('배경 캡션 로드 실패:', e); });
      }
    }

    return { start: start };
  }

  var api = {
    PREF_KEY: PREF_KEY,
    loadPref: loadPref,
    kstDateString: kstDateString,
    imageUrl: imageUrl,
    createWallpaper: createWallpaper,
  };

  if (typeof window !== 'undefined') window.MyHubDesktopWallpaper = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopWallpaper = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
