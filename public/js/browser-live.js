/* MyHub 브라우저 라이브 세션 — 원격 브라우저(Browser Run) 단일 경로.
 *
 * 재구성 근거 (D-20·D-16 최종): 프록시·리더는 폐지됐고 실제 원격 브라우저
 * 하나만 남았다. 세션은 POST /api/browse/live-session {url}로 열고
 * (http/https만, 2048자 이하), 새 주소를 열 때는 기존 세션 반납(DELETE)이
 * 완료된 뒤에 새 세션을 시작한다. 무료 한도는 하루 10분·1회 2분·09:00 KST
 * 리셋 — 남은 시간은 서버 응답을 기준으로 정직하게 표시한다.
 *
 * 노출: window.MyHubBrowserLive = { createLive }
 * createLive({frame, onState, fetchFn}) → {start(url), stop(), state()}
 * onState(state, detail): idle | starting | live | ended | error
 */
(function () {
  'use strict';

  var MAX_URL_LEN = 2048;
  var SESSION_LIMIT_SEC = 120; // 1회 2분 (서버 응답이 우선)

  function validateUrl(raw) {
    var url = String(raw || '').trim();
    if (!url) return { error: '주소를 입력해 주세요.' };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
    if (url.length > MAX_URL_LEN) return { error: '주소가 너무 길어요.' };
    var parsed;
    try { parsed = new URL(url); } catch (e) { return { error: '주소 형식이 올바르지 않아요.' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'http/https 주소만 열 수 있어요.' };
    }
    return { url: parsed.href };
  }

  function createLive(deps) {
    var frame = deps.frame;
    var onState = typeof deps.onState === 'function' ? deps.onState : function () {};
    var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var session = null; // {id, url, viewUrl, expiresAt, limitSec}
    var timer = null;
    var state = 'idle';

    function setState(next, detail) {
      state = next;
      onState(next, detail || {});
    }

    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    function startCountdown() {
      stopTimer();
      timer = setInterval(function () {
        if (!session) { stopTimer(); return; }
        var remain = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
        onState('live', { remainSec: remain, url: session.url });
        if (remain <= 0) {
          var ended = session;
          session = null;
          stopTimer();
          release(ended.id);
          setState('ended', { reason: 'time', url: ended.url });
        }
      }, 500);
    }

    function release(id) {
      if (!id || !fetchFn) return Promise.resolve();
      return fetchFn('/api/browse/live-session/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {}, function () {});
    }

    function start(rawUrl) {
      var checked = validateUrl(rawUrl);
      if (checked.error) {
        setState('error', { message: checked.error });
        return Promise.resolve(false);
      }
      var previous = session;
      session = null;
      stopTimer();
      setState('starting', { url: checked.url });
      // 새 세션은 반납 완료 후에만 시작한다
      var releaseStep = previous ? release(previous.id) : Promise.resolve();
      return releaseStep.then(function () {
        return fetchFn('/api/browse/live-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: checked.url }),
        });
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      }).then(function (res) {
        var payload = (res.data && (res.data.data || res.data)) || {};
        if (!res.ok) {
          var msg = res.status === 429
            ? '오늘의 무료 사용량(10분)을 다 썼어요. 내일 09:00에 초기화돼요.'
            : '세션을 시작하지 못했어요. (' + res.status + ')';
          setState('error', { message: (payload && payload.message) || msg });
          return false;
        }
        var limitSec = typeof payload.limitSec === 'number' ? payload.limitSec : SESSION_LIMIT_SEC;
        var expiresAt = payload.expiresAt ? new Date(payload.expiresAt).getTime() : Date.now() + limitSec * 1000;
        session = {
          id: payload.id || payload.sessionId || null,
          url: checked.url,
          viewUrl: payload.viewUrl || payload.liveUrl || payload.url || null,
          expiresAt: expiresAt,
          limitSec: limitSec,
        };
        if (frame && session.viewUrl) frame.src = session.viewUrl;
        setState('live', { remainSec: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)), url: session.url });
        startCountdown();
        return true;
      }).catch(function (e) {
        console.debug('라이브 세션 실패:', e);
        setState('error', { message: '세션을 시작하지 못했어요.' });
        return false;
      });
    }

    function stop() {
      var current = session;
      session = null;
      stopTimer();
      if (frame) frame.src = 'about:blank';
      setState('idle', {});
      return current ? release(current.id) : Promise.resolve();
    }

    // 페이지가 닫히면 세션을 반납한다
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', function () {
        if (session && session.id && navigator.sendBeacon) {
          // sendBeacon은 DELETE를 못 보내므로 서버가 만료로 회수하게 둔다
          session = null;
          stopTimer();
        }
      });
    }

    return {
      start: start,
      stop: stop,
      state: function () { return state; },
      session: function () { return session ? Object.assign({}, session) : null; },
    };
  }

  var api = { createLive: createLive, validateUrl: validateUrl, SESSION_LIMIT_SEC: SESSION_LIMIT_SEC };
  if (typeof window !== 'undefined') window.MyHubBrowserLive = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubBrowserLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
