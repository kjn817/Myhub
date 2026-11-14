// 프론트 공용 상수 — public/js/common/constants.js
//
// 여러 페이지·모듈에 흩어져 있던 하드코딩 상수를 한 곳으로 모은다 (S5-4, 5-9).
// - KST_TIME_ZONE: 프론트 KST 고정 타임존 (백엔드 src/lib/kst.ts의
//   KST_TIME_ZONE과 같은 값 — 프론트는 백엔드 모듈을 import할 수 없어
//   별도 상수다. 값이 바뀌면 양쪽을 함께 바꿀 것).
// - MAX_UPLOAD_BYTES: 메모 첨부 1건 상한 10MB (Cloudinary 무료 플랜 정책).
//   데스크톱 드롭 업로드(Drive 상한)는 도메인이 달라 이 상수를 쓰지 않는다.
// - DEFAULT_VIEWPORT: 뷰포트 폴백 (window.innerWidth/Height가 0일 때).
// - DRIVE_FILES_API: Drive 파일 API 베이스 경로 ('/content'·'/trash' 등의
//   접미사는 호출처가 붙인다).
//
// 로딩: 소비처보다 먼저 받아야 한다 — desktop·finder·office·sheet·
// sheet-fortune·memo.html이 정적 태그 순서로 선행을 보장한다. 코어가
// 없으면 소비처는 로드 시점에 명확한 오류를 낸다 (5-4/5-5 계약).
(function () {
  'use strict';

  var api = {
    KST_TIME_ZONE: 'Asia/Seoul',
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    DEFAULT_VIEWPORT: { w: 1024, h: 768 },
    DRIVE_FILES_API: '/api/drive/files',
  };
  if (typeof window !== 'undefined') window.MyHubConstants = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubConstants = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
