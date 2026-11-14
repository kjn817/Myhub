// JSON 스토리지 공용 코어 — public/js/common/json-store.js
//
// office.js와 office-memory.js가 공유하던 storeGet/storeSet을 한 곳으로
// 모은다 (F-L7, 5-5). 두 사본은 warn 문구의 라벨만 달랐다.
//
// 보존하는 계약:
// - get(key, fallback): storage가 없으면 fallback, 빈 값이면 fallback,
//   파싱된 null/undefined면 fallback, 파싱 실패 시 warn 후 fallback.
// - set(key, value): storage가 없으면 no-op, 직렬화·쓰기 실패 시 warn.
// - warn 문구는 생성 시 받은 label을 쓴다 ('오피스 앱 메모리' /
//   '세션 등 메모리') — 로그 문구가 바뀌지 않는다.
// - 코어가 없으면 소비처는 null-storage와 동등한 스텁으로 열화한다
//   (최근 문서·최근 폴더는 비치명 기능이라 페이지를 죽이지 않는다).
(function () {
  'use strict';

  function create(storage, label) {
    return {
      get: function (key, fallback) {
        if (!storage) return fallback;
        try {
          var raw = storage.getItem(key);
          if (!raw) return fallback;
          var parsed = JSON.parse(raw);
          return parsed === null || parsed === undefined ? fallback : parsed;
        } catch (e) {
          console.warn(label + ' 읽기 실패:', e);
          return fallback;
        }
      },
      set: function (key, value) {
        if (!storage) return;
        try {
          storage.setItem(key, JSON.stringify(value));
        } catch (e) {
          console.warn(label + ' 쓰기 실패:', e);
        }
      },
    };
  }

  var api = { create: create };
  if (typeof window !== 'undefined') window.MyHubJsonStore = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubJsonStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
