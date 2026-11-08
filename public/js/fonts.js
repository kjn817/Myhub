/* MyHub 오피스 폰트 — Drive '폰트' 폴더의 사용자 폰트를 전 엔진에 적용.
 *
 * 계약 (2026-11-03 실측 확정, 재구축에서 일부 소실됐다 복원):
 * - Drive 루트에서 이름이 정확히 '폰트'인 폴더를 찾고, 없으면 Drive API로
 *   자동 생성한다 (바탕화면 특수 폴더와 동일 패턴, 서버 변경 없음).
 * - 파일명(확장자 제거)이 family다. 단, -Bold·-Italic 같은 접미사는
 *   weight/style로 해석해 벗긴다 (이름 전체가 접미사 단어뿐이면 벗기지
 *   않는 보호 규칙 포함). 예: 'Pretendard-Bold' → family 'Pretendard', 700.
 * - 페이스는 FontFace API로 문서에 등록하고(기술자 포함), 엔진에는
 *   'gridcraft:fonts' / 'myhub:fonts'로 {family, weight, style, url} 목록을
 *   알린다 — 바이트 fetch·전달은 각 엔진 호스트가 담당한다.
 * - 파일별 실패는 격리하고, load 전체는 reject하지 않는다.
 *
 * 노출: window.MyHubFonts {ready, list, applyTo, parseFontName}
 */
(function () {
  'use strict';

  var userFonts = []; // {name(family), fileName, url, weight, style, user}

  var WEIGHTS = {
    thin: 100, extralight: 200, ultralight: 200, light: 300,
    regular: 400, normal: 400, book: 400,
    medium: 500, semibold: 600, demibold: 600,
    bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
  };

  /** 파일명(확장자 제외) → {family, weight, style}.
   * 접미사는 이름 끝의 Italic/Oblique(스타일)와 굵기 단어에서만 해석한다.
   * 이름 전체가 접미사 단어뿐이면 벗기지 않는다 (보호 규칙). */
  function parseFontName(base) {
    var name = String(base || '').trim();
    var out = { family: name, weight: 400, style: 'normal' };
    if (!name) return out;
    var rest = name;
    var styleM = /(Italic|Oblique)$/i.exec(rest);
    if (styleM && rest.length > styleM[1].length) {
      out.style = 'italic';
      rest = rest.slice(0, rest.length - styleM[1].length).replace(/[-_ ]+$/, '');
    }
    var wM = /((?:Extra|Ultra|Semi|Demi)?(?:Light|Regular|Normal|Book|Medium|Bold|Black|Heavy|Thin))$/i.exec(rest);
    if (wM) {
      var stem = rest.slice(0, rest.length - wM[1].length).replace(/[-_ ]+$/, '');
      if (stem) {
        var wv = WEIGHTS[wM[1].toLowerCase()];
        if (typeof wv === 'number') { out.weight = wv; rest = stem; }
      }
    }
    if (rest && rest !== name) out.family = rest;
    return out;
  }

  function jsonOrThrow(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

  function folderFiles(folderId) {
    // 서버 계약: tree 엔드포인트는 없고 목록은 /list. 파일명은 filename으로 온다.
    return fetch('/api/drive/list?folder=' + encodeURIComponent(folderId))
      .then(jsonOrThrow)
      .then(function (d) {
        var files = ((d && (d.data || d)) || {}).files || [];
        return files.map(function (f) { return Object.assign({}, f, { name: f.name || f.filename || '' }); });
      });
  }

  function createFontFolder() {
    return fetch('/api/drive/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '폰트', parent_id: null }),
    }).then(jsonOrThrow).then(function (d) {
      var payload = (d && (d.data || d)) || {};
      return payload.id || null;
    });
  }

  function findFontFolder() {
    return fetch('/api/drive/list?folder=root')
      .then(jsonOrThrow)
      .then(function (d) {
        var payload = (d && (d.data || d)) || {};
        var hit = (payload.folders || []).filter(function (f) { return f.name === '폰트'; })[0];
        if (hit) return hit.id;
        // 없으면 자동 생성 (원본 계약). 생성 실패 시에는 폰트 없음으로 진행.
        return createFontFolder().catch(function () { return null; });
      });
  }

  function isFontFile(name) {
    return /\.(woff2?|ttf|otf)$/i.test(name || '');
  }

  function registerFace(font) {
    if (!window.FontFace) return Promise.resolve();
    var face = new FontFace(font.name, 'url("' + font.url + '")', {
      weight: String(font.weight || 400),
      style: font.style || 'normal',
    });
    return face.load().then(function (loaded) {
      document.fonts.add(loaded);
    }).catch(function (e) { /* 등록 실패한 폰트만 건너뜀 */ console.warn('폰트 등록 실패 — 해당 폰트만 건너뜀:', e); });
  }

  var ready = findFontFolder()
    .then(function (folderId) {
      if (!folderId) return [];
      return folderFiles(folderId);
    })
    .then(function (files) {
      userFonts = files.filter(function (f) { return isFontFile(f.name); }).map(function (f) {
        var parsed = parseFontName(f.name.replace(/\.(woff2?|ttf|otf)$/i, ''));
        return {
          name: parsed.family,
          fileName: f.name,
          url: '/api/drive/files/' + encodeURIComponent(f.id) + '/content',
          weight: parsed.weight,
          style: parsed.style,
          user: true, // 사용자 폰트 우선
        };
      });
      return Promise.all(userFonts.map(registerFace));
    })
    .then(function () { return userFonts; })
    .catch(function () { return userFonts; });

  function list() { return userFonts.slice(); }

  /** 엔진 iframe에 폰트 목록을 푸시한다 (GridCraft 프로토콜). */
  function applyTo(frame) {
    return ready.then(function () {
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'gridcraft:fonts', fonts: userFonts }, window.location.origin);
        frame.contentWindow.postMessage({ type: 'myhub:fonts', fonts: userFonts }, window.location.origin);
      }
      return userFonts;
    });
  }

  var api = { ready: ready, list: list, applyTo: applyTo, parseFontName: parseFontName };
  if (typeof window !== 'undefined') window.MyHubFonts = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFonts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
