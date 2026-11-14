// Drive 파일 생성/조회 공용 코어 — public/js/common/drive-io.js
//
// finder.js와 office.js가 공유하던 "다른 이름으로 저장" POST 플로우를
// 한 곳으로 모은다 (F-L5, 5-5).
//
// 보존하는 계약:
// - uploadDriveFile은 FormData(files 파트 + folder_id) POST
//   /api/drive/files 후 saved(files[0])를 확정한다. 오류 문구는
//   label로 갈린다 ('create http'/'create shape' vs 'import http'/
//   'import shape'). fetchFn은 호출처가 그대로 넘긴다 (finder의 bare
//   fetch, office의 baseFetch) — 코어는 Promise로 감싸지 않는다
//   (호출처의 체인이 동기 throw를 이미 rejection으로 바꾼다).
// - resolveDriveFileVersion은 목록에서 행을 찾아 version 또는 null을
//   낸다. 목록 조회 자체의 실패는 전파한다 — finder의 warn·office의
//   adoptError 처리는 호출처 catch가 유지한다.
// - 코어가 없으면 소비처는 호출 시점에 명확한 오류를 던진다. 저장
//   호출처의 catch가 이를 '저장에 실패했습니다'로 받아 이미 설계된
//   실패 경로를 탄다.
(function () {
  'use strict';

  function uploadDriveFile(fetchFn, blob, name, folderId, label) {
    var fd = new FormData();
    fd.append('files', blob, name);
    if (folderId) fd.append('folder_id', String(folderId));
    return fetchFn('/api/drive/files', { method: 'POST', body: fd })
      .then(function (res) {
        if (!res || !res.ok) throw new Error(label + ' http ' + (res && res.status));
        return res.json();
      })
      .then(function (body) {
        var saved = body && body.files && body.files[0];
        if (!body || !body.ok || !saved) throw new Error(label + ' shape');
        return saved;
      });
  }

  function resolveDriveFileVersion(listFn, folderId, fileId) {
    return listFn(folderId).then(function (listing) {
      var row = ((listing && listing.files) || []).filter(function (f) {
        return f.id === fileId;
      })[0];
      return row ? row.version || null : null;
    });
  }

  var api = {
    uploadDriveFile: uploadDriveFile,
    resolveDriveFileVersion: resolveDriveFileVersion,
  };
  if (typeof window !== 'undefined') window.MyHubDriveIo = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDriveIo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
