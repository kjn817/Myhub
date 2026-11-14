// fetch JSON 응답 확정 공용 코어 — public/js/common/http-json.js
//
// desktop/drop-upload.js와 fonts.js가 공유하던 jsonOrThrow를 한 곳으로
// 모은다 (F-L8, 5-5). drop-upload.js 안의 인라인 복사(업로드 기본 문구)
// 까지 같은 함수로 합친다.
//
// 보존하는 계약:
// - res.json() 실패 시 본문을 null로 본다.
// - res.ok && body && body.ok면 본문을 그대로 반환한다.
// - 아니면 body.error가 있으면 그 문구로, 없으면 fallbackMsg로 던진다.
//   fallbackMsg 기본값은 '요청이 실패했습니다 (' + status + ')' —
//   기존 `.then(jsonOrThrow)` 호출이 그대로 동작한다. 업로드 경로는
//   '업로드에 실패했습니다 (' + status + ')'를 명시 인자로 넘긴다.
// - 코어가 없으면 소비처 래퍼가 호출 시점에 명확한 오류를 던진다.
(function () {
  'use strict';

  function jsonOrThrow(res, fallbackMsg) {
    return res
      .json()
      .catch(function () {
        return null;
      })
      .then(function (body) {
        if (res.ok && body && body.ok) return body;
        var msg =
          body && body.error
            ? String(body.error)
            : fallbackMsg !== undefined
              ? fallbackMsg
              : '요청이 실패했습니다 (' + res.status + ')';
        throw new Error(msg);
      });
  }

  var api = { jsonOrThrow: jsonOrThrow };
  if (typeof window !== 'undefined') window.MyHubHttpJson = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubHttpJson = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
