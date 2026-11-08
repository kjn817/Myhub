/* MyHub 버전 가드 — 배포 후 구 셸이 남는 문제를 막는다 (D-18 부속).
 *
 * 재구성 근거: 서버 버전과 이 페이지가 로드한 버전이 다르면 세션당 1회만
 * 자동 새로고침한다 (무한 새로고침 방지: 본 버전에 대한 새로고침 기록을
 * sessionStorage에 남긴다).
 */
(function () {
  'use strict';

  var SEEN_KEY = 'myhub.versionGuard.seen.v1';

  function loadedVersion() {
    var meta = document.querySelector('meta[name="myhub-version"]');
    return meta ? meta.getAttribute('content') : null;
  }

  function check() {
    var mine = loadedVersion();
    if (!mine) return;
    fetch('/api/version', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var payload = data && (data.data || data);
        var server = payload && (payload.version || payload.build);
        if (!server || server === mine) return;
        var seen = null;
        try { seen = sessionStorage.getItem(SEEN_KEY); } catch (e) { seen = null; }
        if (seen === server) return; // 이 버전에 대해서는 이미 한 번 새로고침했다
        try { sessionStorage.setItem(SEEN_KEY, server); } catch (e) { console.debug('버전 가드 기록 실패:', e); }
        location.reload();
      })
      .catch(function (e) { console.warn('버전 확인 실패 — 새로고침 없이 계속한다:', e); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
