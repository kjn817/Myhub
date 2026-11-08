/* MyHub 오피스 공용 파일 입출력 — Drive 파일 로드·저장 (버전 동시성 포함).
 *
 * 서버 계약 (번들·src/modules/drive/routes.ts 대조로 확정한 정본):
 * - 신규 생성: POST /api/drive/files, 폼 필드는 'files'(복수). 응답은
 *   { ok, files: [{ id, filename, size }] } (버전 없음) — 호출자가 기대하는
 *   {id, name, version}으로 여기서 정규화한다. 버전은 /recent fileView에서
 *   조회한다. (F4: 재구축본이 'file' 필드로 보내 서버가 400 'empty'로
 *   거부 → 새 문서 저장이 조용히 사라지던 결함의 근본원인.)
 * - 덮어쓰기: PUT /api/drive/files/:id/content, 폼 필드는 'file'(단수) +
 *   base_version. 응답 { ok, size, version }. 버전은 숫자가 아니라
 *   storage_key(저장소 public_id)다 — 서버 fileView가 version: storage_key로
 *   내보내고, base_version이 현재 storage_key와 다르면 409 {error:'CONFLICT'}.
 * - 메타 조회용 JSON 엔드포인트는 없다: GET /files/:id는 원본 URL로 302.
 *   이름은 GET /content 응답의 Content-Disposition에서 읽는다 (버전 헤더는
 *   없어 열기 직후 version은 null — 첫 PUT은 검사를 건너뛰고 응답에서
 *   새 버전을 받는다).
 *
 * 노출: window.MyHubOfficeFetch
 */
(function () {
  'use strict';

  function contentUrl(id) {
    return '/api/drive/files/' + encodeURIComponent(id) + '/content';
  }

  function nameFromDisposition(r) {
    var cd = r.headers.get('Content-Disposition') || '';
    var m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    var m2 = /filename="?([^";]+)"?/i.exec(cd);
    return m2 ? m2[1] : null;
  }

  function loadFile(id) {
    return fetch(contentUrl(id)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var version = r.headers.get('x-file-version') || null;
      var name = nameFromDisposition(r);
      return r.blob().then(function (blob) { return { blob: blob, version: version, name: name }; });
    });
  }

  /* 메타는 content 응답 헤더로만 읽는다 (본문은 취소 — 대용량 파일 전체를
   * 내려받지 않기 위해). 실패하면 던져 호출자가 폴백하게 한다. */
  function loadMeta(id) {
    return fetch(contentUrl(id)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var meta = {
        name: nameFromDisposition(r),
        version: r.headers.get('x-file-version') || null,
      };
      if (r.body && typeof r.body.cancel === 'function') {
        r.body.cancel().catch(function (e) { console.warn('[office] 스트림 취소 실패 (이미 끝난 스트림)', e); });
      }
      return meta;
    });
  }

  /** 저장: {ok:true, version} | {conflict:true} */
  function saveFile(id, blob, baseVersion, name) {
    var form = new FormData();
    form.append('file', blob, name || 'file');
    if (baseVersion) form.append('base_version', String(baseVersion));
    return fetch(contentUrl(id), { method: 'PUT', body: form }).then(function (r) {
      if (r.status === 409) return { conflict: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().then(function (d) {
        var payload = (d && (d.data || d)) || {};
        return { ok: true, version: payload.version || null };
      });
    });
  }

  /** 신규 생성: 서버 응답 files[0]을 {id, name, version}으로 정규화한다.
   * 생성 응답에는 버전이 없어 /recent fileView에서 storage_key 버전을
   * 조회한다 (못 찾으면 null — PUT이 base_version 검사를 건너뛴다). */
  function createFile(name, blob, folderId) {
    var form = new FormData();
    form.append('files', blob, name);
    if (folderId) form.append('folder_id', folderId);
    return fetch('/api/drive/files', { method: 'POST', body: form })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var payload = (d && (d.data || d)) || {};
        var first = Array.isArray(payload.files) ? payload.files[0] : null;
        if (!first || typeof first.id !== 'number') throw new Error('create response malformed');
        var created = { id: first.id, name: first.filename || name, version: null };
        return fetch('/api/drive/recent')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (rd) {
            var files = (rd && (rd.files || (rd.data && rd.data.files))) || [];
            for (var i = 0; i < files.length; i++) {
              if (files[i].id === created.id && files[i].version) {
                created.version = files[i].version;
                break;
              }
            }
            return created;
          })
          .catch(function () { return created; });
      });
  }

  var api = { contentUrl: contentUrl, loadFile: loadFile, loadMeta: loadMeta, saveFile: saveFile, createFile: createFile };
  if (typeof window !== 'undefined') window.MyHubOfficeFetch = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficeFetch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
