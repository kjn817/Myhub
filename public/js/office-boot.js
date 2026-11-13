/* MyHub 오피스 부팅 로딩 문구 (office-boot.js) — Excel·한글 2020·
 * PowerPoint·PDF 공용. 부팅 로딩 화면(#officeBootLoading)에 앱별
 * 제목·문구를 넣는다.
 *
 * office.js가 아니라 이 파일이 맡는 이유: office.js는 무거운 포맷
 * 핸들러들 뒤에 로딩되므로, office.js init에서 문구를 바꾸면 일반
 * 문구("오피스")가 먼저 보였다가 바뀌는 깜빡임이 생긴다. 이 파일은
 * office.html의 부팅 섹션 바로 뒤에 동기 스크립트로 두어, 첫
 * 페인트 전에 앱별 문구가 들어가게 한다. 정적 마크업의 일반 문구는
 * 이 스크립트가 못 뜨는 경우의 폴백이다.
 *
 * 노출: window.MyHubOfficeBoot = { setBootText }
 */
(function () {
  'use strict';

  var TEXTS = {
    excel: { title: 'Excel', status: '시트 편집기를 불러오는 중' },
    hangul: { title: '한글 2020', status: '한글 편집기를 불러오는 중' },
    powerpoint: { title: 'PowerPoint', status: '프레젠테이션 편집기를 불러오는 중' },
    pdf: { title: 'PDF', status: 'PDF 뷰어를 불러오는 중' },
  };

  function parseAppKey(search) {
    var key = '';
    try {
      key = new URLSearchParams(String(search || '')).get('app') || '';
    } catch (e) {
      key = '';
    }
    return TEXTS[key] ? key : 'excel';
  }

  function setBootText(search, doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.getElementById) return;
    var t = TEXTS[parseAppKey(search)];
    var title = d.getElementById('officeBootTitle');
    if (title) title.textContent = t.title;
    var status = d.getElementById('officeBootStatus');
    if (status) status.textContent = t.status;
  }

  if (typeof window !== 'undefined') {
    window.MyHubOfficeBoot = { setBootText: setBootText };
    setBootText(window.location.search, document);
  }
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficeBoot = { setBootText: setBootText };
  if (typeof module !== 'undefined' && module.exports) module.exports = { setBootText: setBootText };
})();
