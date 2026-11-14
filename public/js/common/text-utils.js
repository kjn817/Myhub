// 텍스트 유틸 공용 코어 — public/js/common/text-utils.js
//
// memo/utils.js·schedule.js·todo.js·trace.js·chat.js 5곳이 공유하던
// esc(HTML 이스케이프)와 friendlyError(서버 오류 문구 변환)를 한 곳으로
// 모은다 (F-L3, 5-4). fmtSize/fmtDate는 표시 형식이 달라 의도된 차이로
// 남긴다 — 이 파일에 넣지 않는다.
//
// 로딩: 이 파일을 먼저 받은 서면에서만 소비처가 동작한다 — schedule·
// todo·chat·trace·memo.html이 정적 태그 순서로 선행을 보장한다. 코어가
// 없으면 소비처는 로드 시점에 명확한 오류를 낸다 (이스케이프는 생략할
// 수 없는 동작이라 조용히 건너뛰지 않는다).
//
// 보존하는 계약:
// - esc는 5문자 버전(& < > " ') — memo본만 4자였는데 5자로 올린다
//   ('가 &#39;로 바뀌는 것은 HTML 표시가 동일해 동작 변경이 아니다).
//   null/undefined는 ''로, 숫자 0은 '0'으로 (4개 사본의 다수 동작).
// - friendlyError는 풀 패턴 버전: 위임(window.friendlyErrorMessage)
//   + fail-safe(http_\d{3}·서버 오류 (NNN)·snake_case·SNAKE_CASE·
//   ALL-CAPS 2자 이상, trim, input.message 폴백). chat본에만 없던
//   패턴·trim·message 폴백을 채운다.
// - 위임 분기는 5-4에서 유지한다 — 제거는 6단계 D5에서 이 파일 한 곳에만
//   적용한다 (error-messages.js 파일은 없어서 fail-safe가 실제로 탄다).
(function () {
  'use strict';

  var ESC_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, function (c) {
      return ESC_MAP[c];
    });
  }

  // I-09 (2026-11-05): 서버 오류는 공통 오류 문구 맵
  // (public/js/common/error-messages.js의 friendlyErrorMessage)를 거쳐
  // 표시한다 — 원시 코드(decrypt_failed·"서버 오류 (500)" 등)는 화면에
  // 내지 않고 콘솔로만 남긴다. 맵 스크립트가 없을 때도 원시 코드 패턴을
  // 걸러내고 폴백 문구를 낸다 (fail-safe).
  function friendlyError(input, fallback) {
    var fn =
      typeof window !== 'undefined' ? window.friendlyErrorMessage : undefined;
    if (typeof fn === 'function') {
      try {
        return fn(input, fallback);
      } catch (e) {
        console.warn('오류 문구 변환 실패:', e);
      }
    }
    var raw = '';
    if (typeof input === 'string') raw = input;
    else if (input && typeof input === 'object') {
      raw =
        (input.error && typeof input.error === 'object'
          ? input.error.code || input.error.message || ''
          : '') ||
        (typeof input.error === 'string' ? input.error : '') ||
        input.code ||
        input.message ||
        '';
    }
    if (typeof raw === 'string' && raw) {
      var t = raw.trim();
      if (
        /^http_\d{3}$/i.test(t) ||
        /^서버 오류\s*\(\d{3}\)$/.test(t) ||
        /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t) ||
        /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(t) ||
        /^[A-Z]{2,}$/.test(t)
      ) {
        console.warn('[MyHub] 오류 코드:', t);
        return fallback;
      }
      return raw;
    }
    return fallback;
  }

  var api = {
    esc: esc,
    friendlyError: friendlyError,
  };
  if (typeof window !== 'undefined') window.MyHubTextUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
