/* MyHub 공용 폰트 저장소 로더 (fonts.js)
 *
 * 폰트 관 리는 UI별도 가 없다 Finder(Drive)의 '폴더' 자 체가
 * 관리 인터페이스다 (사용자 지정 2026-11-03). 실행 서브의 이름 등
 * 등모든 모듈이 그 폴더의 폰트 파일(.ttf/.otf/.woff/.woff2)를 읽어
 * FontFace로 자기 문서에 등록한다. 폴더가 없으면 만드는 것까지
 * 로더의 일이다 (데스크톱 '바탕화면' 폴더 보관과 같은 패턴).
 *
 * 파일명 규칙:
 * - 파일명에서 확장자를 뗀 이름이 곧 font-family 이름이다
 *   (등: '등.ttf' 임 '임', 'Pretendard.woff2' 임 'Pretendard').
 * - 이름뒤의 붙는 굵기 기울임으로 해석한다:
 *   -Bold/-B 등 700, -Italic/-I 등 italic, -BoldItalic 임 700 italic,
 *   -Light 등 300, -Medium 등 500, -SemiBold 임 600, -ExtraBold 임 800,
 *   -Black 등 900, -Thin 등 100, -Regular/-R 임 400.
 *   구(-, _, 분) 자 CamelCase 없는(NanumGothicBold)의 같은
 *   서로 해석한다. 붙은 뗀 나머지가 패밀리 이름이 된다.
 * - 같은 패밀리+굵기+기울임이 겹치면 목록 순서의 첫 파일만 쓴다.
 * - 깊은파일 폰트 아닌 파일은 건너뛰고 나머지는 계속 적용한다.
 *   실패한 결과는 errors에 남긴다 (실행 깊은 않는다).
 *
 * 노출: window.MyHubFonts = { FOLDER_NAME, FONT_EXTENSIONS,
 *   parseFontFileName, load, reload, whenReady, families, faces,
 *   POOL_FACES, loadPoolBytes, loadFontBytes }
 * POOL_FACES/loadPoolBytes는 실행 프로그램 내장 폰트를 모은 공용 풀
 * (public/fonts/)에이다 풀 엔진 바이너리 push 실행 Drive 페이지 위에
 * 병합한다 (아래 POOL_FACES 주석의 정보).
 * (file-icons.js와 같은 취지 노출 등 플랫폼 로드 규칙 테스트 지정.)
 * data-myhub-fonts-autoload 속성을 붙인 <script>로 올리면 로드 즉시
 * load()를 시작한다 (rhwp-studio처럼 호스트 코드가 없는 문서).
 */
(function () {
  'use strict';

  // Drive 파일 API 베이스 경로 (S5-4, 5-9) — constants.js 선행 로드.
  var constants =
    (typeof window !== 'undefined' && window.MyHubConstants) ||
    (typeof globalThis !== 'undefined' && globalThis.MyHubConstants) ||
    null;
  if (!constants) throw new Error('[fonts.js] constants.js가 먼저 로드되어야 합니다');

  var FOLDER_NAME = '폰트';
  var FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2'];
  var LIST_URL = '/api/drive/list';
  var FOLDERS_URL = '/api/drive/folders';
  var CONTENT_URL = constants.DRIVE_FILES_API + '/';

  // 붙은 선택 등 (긴 것 으로 것 ExtraBold등 Bold로 나눠 등 된다)
  var WEIGHT_TOKENS = [
    ['extralight', 200],
    ['ultralight', 200],
    ['semibold', 600],
    ['demibold', 600],
    ['extrabold', 800],
    ['regular', 400],
    ['normal', 400],
    ['medium', 500],
    ['light', 300],
    ['black', 900],
    ['heavy', 900],
    ['bold', 700],
    ['thin', 100],
    ['book', 400],
  ];
  var STYLE_TOKENS = ['italic', 'oblique'];

  function lower(s) {
    return String(s).toLowerCase();
  }

  /**
   * 파일명 등 { family, weight, style } | null (폰트 파일이 아니면 null).
   * 순수 함수 등 상위 테스트의 중점.
   */
  function parseFontFileName(filename) {
    var name = String(filename || '');
    var dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    var ext = lower(name.slice(dot + 1));
    if (FONT_EXTENSIONS.indexOf(ext) === -1) return null;
    var stem = name.slice(0, dot);
    var weight = 400;
    var style = 'normal';
    var weightSet = false;
    var styleSet = false;

    // 이름 전 체가 붙은 단(Bold, ExtraBold, BoldItalic어면)
    // 떨어지지 않는 등 원래 폰트 이름을 경우를 지정한다.
    var compact = lower(stem).replace(/[-_\s]+/g, '');
    if (isSuffixWord(compact)) {
      return { family: stem, weight: 400, style: 'normal' };
    }

    // 규칙 붙은 최대 2개까지 떨어낸다 (등: -BoldItalic, -Bold -Italic).
    for (var round = 0; round < 2; round += 1) {
      var low = lower(stem);
      var consumed = false;

      // 1) 구분 자로 분리해 (선택-Bold, 등_Italic, 등 Bold)
      var sep = /[-_\s]+([a-z]+)$/.exec(low);
      if (sep) {
        var tok = sep[1];
        var w = weightOf(tok);
        if (!weightSet && w !== null) {
          weight = w;
          weightSet = true;
          consumed = true;
        } else if (!styleSet && STYLE_TOKENS.indexOf(tok) !== -1) {
          style = 'italic';
          styleSet = true;
          consumed = true;
        } else if (!weightSet && tok === 'b') {
          weight = 700;
          weightSet = true;
          consumed = true;
        } else if (!styleSet && tok === 'i') {
          style = 'italic';
          styleSet = true;
          consumed = true;
        } else if (!weightSet && tok === 'r') {
          weight = 400;
          weightSet = true;
          consumed = true;
        }
        if (consumed) {
          stem = stem.slice(0, stem.length - sep[0].length);
          continue;
        }
      }

      // 2) CamelCase로 붙 은 (규칙othicBold, 등oldItalic)
      var camel = camelSuffix(low);
      if (camel) {
        if (camel.weight !== null && !weightSet) {
          weight = camel.weight;
          weightSet = true;
          consumed = true;
        }
        if (camel.style && !styleSet) {
          style = 'italic';
          styleSet = true;
          consumed = true;
        }
        if (consumed) {
          // '-BoldItalic'처럼 구분자 뒤에 붙은 결합형태 구분자까지 정리
          stem = stem.slice(0, stem.length - camel.len).replace(/[-_\s]+$/, '');
          continue;
        }
      }
      break;
    }

    var family = stem.replace(/\s+$/, '');
    if (!family) return null;
    return { family: family, weight: weight, style: style };
  }

  function isSuffixWord(compactLow) {
    if (weightOf(compactLow) !== null) return true;
    if (STYLE_TOKENS.indexOf(compactLow) !== -1) return true;
    return (
      compactLow === 'bolditalic' || compactLow === 'italicbold' || compactLow === 'boldoblique'
    );
  }

  function weightOf(tok) {
    for (var i = 0; i < WEIGHT_TOKENS.length; i += 1) {
      if (WEIGHT_TOKENS[i][0] === tok) return WEIGHT_TOKENS[i][1];
    }
    return null;
  }

  // 구분자 없이 붙은 규칙 단어. 결합(BoldItalic)형태 먼저 본다.
  function camelSuffix(low) {
    var combos = [
      ['bolditalic', 700, true],
      ['italicbold', 700, true],
      ['boldoblique', 700, true],
    ];
    var i;
    var word;
    for (i = 0; i < combos.length; i += 1) {
      word = combos[i][0];
      if (low.length > word.length && low.slice(-word.length) === word) {
        return { len: word.length, weight: combos[i][1], style: combos[i][2] };
      }
    }
    for (i = 0; i < WEIGHT_TOKENS.length; i += 1) {
      word = WEIGHT_TOKENS[i][0];
      if (word.length >= 4 && low.length > word.length && low.slice(-word.length) === word) {
        return { len: word.length, weight: WEIGHT_TOKENS[i][1], style: false };
      }
    }
    for (i = 0; i < STYLE_TOKENS.length; i += 1) {
      word = STYLE_TOKENS[i];
      if (low.length > word.length && low.slice(-word.length) === word) {
        return { len: word.length, weight: null, style: true };
      }
    }
    return null;
  }

  /** fetch 응답을 {ok:true} 본문으로 확정하고, 아니면 서버 사유로 수집한다 (http-json.js 공용 코어, F-L8). */
  function jsonOrThrow(res, fallbackMsg) {
    var core =
      (typeof window !== 'undefined' &&
        window.MyHubHttpJson &&
        window.MyHubHttpJson.jsonOrThrow) ||
      (typeof globalThis !== 'undefined' &&
        globalThis.MyHubHttpJson &&
        globalThis.MyHubHttpJson.jsonOrThrow) ||
      null;
    if (typeof core !== 'function') {
      throw new Error('[fonts.js] http-json.js가 먼저 로드되어야 합니다');
    }
    return core(res, fallbackMsg);
  }

  var state = {
    promise: null, // 진행 중이 거나 load() Promise (생긴 결과만 유지)
    result: null, // 마지막 결과 { folderId, families, faces, errors }
  };

  /**
   * '폴더를' 보관 하고 폰트를 등록한다. 안내 reject하지 않는 등
   * 실패는 result.errors에 빈 families로 보고한다.
   * deps = { fetchFn?, FontFaceCtor?, fontSet? } 전체 테스트 주입 지난.
   */
  function load(deps) {
    if (state.promise && !deps) return state.promise;
    var p = runLoad(deps || {}).then(
      function (result) {
        state.result = result;
        return result;
      },
      function (err) {
        // runLoad는 reject하지 않는 것이 규칙이며, 방어적으로 같은
        // 결과 형태로 바꿔 (낸다 실행 폰트 플랫폼 깊으면 등낸다).
        var result = {
          folderId: null,
          families: [],
          faces: [],
          errors: [{ filename: null, message: String((err && err.message) || err) }],
        };
        state.result = result;
        return result;
      },
    );
    if (!deps) state.promise = p;
    return p;
  }

  function reload(deps) {
    state.promise = null;
    return load(deps);
  }

  /** load()에 상한을 건다 등 에러 Drive가 실행 렌더를 막지 않게. */
  function whenReady(timeoutMs, deps) {
    var ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 2500;
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(state.result); // 아직도 null 면 노출자는 대관으로 진행
      }, ms);
      load(deps).then(function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  function runLoad(deps) {
    var fetchFn =
      typeof deps.fetchFn === 'function'
        ? deps.fetchFn
        : function (url, opts) {
            return fetch(url, opts);
          };
    var FaceCtor =
      typeof deps.FontFaceCtor === 'function'
        ? deps.FontFaceCtor
        : typeof FontFace !== 'undefined'
          ? FontFace
          : null;
    var fontSet =
      deps.fontSet ||
      (typeof document !== 'undefined' && document.fonts ? document.fonts : null);
    var errors = [];
    if (!FaceCtor || !fontSet || typeof fontSet.add !== 'function') {
      errors.push({ filename: null, message: 'FontFace를 등 등 없는 환경입니다' });
      return Promise.resolve({ folderId: null, families: [], faces: [], errors: errors });
    }

    return ensureFolderId(fetchFn)
      .then(function (folderId) {
        return fetchFn(LIST_URL + '?folder=' + folderId)
          .then(jsonOrThrow)
          .then(function (body) {
            return { folderId: folderId, files: (body && body.files) || [] };
          });
      })
      .then(function (listed) {
        var targets = [];
        var seen = {};
        listed.files.forEach(function (f) {
          if (!f || typeof f.id !== 'number') return;
          var parsed = parseFontFileName(f.filename);
          if (!parsed) return; // 폰트 아닌 파일은 조용히 제외 (폴더의 다른 용도를 막지 않는다)
          var key = parsed.family + '|' + parsed.weight + '|' + parsed.style;
          if (seen[key]) return;
          seen[key] = true;
          targets.push({ file: f, parsed: parsed });
        });
        var faces = [];
        // 파일은 하나씩 순서대로 등 실패가 등 파일은 막지 않게 각각 감싼다.
        var chain = Promise.resolve();
        targets.forEach(function (t) {
          chain = chain.then(function () {
            return registerOne(fetchFn, FaceCtor, fontSet, t).then(
              function (face) {
                faces.push(face);
              },
              function (err) {
                errors.push({
                  filename: t.file.filename,
                  message: String((err && err.message) || err),
                });
              },
            );
          });
        });
        return chain.then(function () {
          var families = [];
          faces.forEach(function (face) {
            if (families.indexOf(face.family) === -1) families.push(face.family);
          });
          families.sort();
          return { folderId: listed.folderId, families: families, faces: faces, errors: errors };
        });
      })
      .catch(function (err) {
        errors.push({ filename: null, message: String((err && err.message) || err) });
        return { folderId: null, families: [], faces: [], errors: errors };
      });
  }

  /** '폴더' 보관 등 루트 목록 에서 찾고, 없으면 만든다 (바탕화면 폴더와 같은 패턴). */
  function ensureFolderId(fetchFn) {
    return fetchFn(LIST_URL)
      .then(jsonOrThrow)
      .then(function (body) {
        var folders = (body && body.folders) || [];
        for (var i = 0; i < folders.length; i += 1) {
          if (folders[i] && folders[i].name === FOLDER_NAME) return folders[i].id;
        }
        return fetchFn(FOLDERS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: FOLDER_NAME, parent_id: null }),
        })
          .then(jsonOrThrow)
          .then(function (created) {
            return created.id;
          });
      });
  }

  function registerOne(fetchFn, FaceCtor, fontSet, target) {
    var file = target.file;
    var parsed = target.parsed;
    return fetchFn(CONTENT_URL + file.id + '/content')
      .then(function (res) {
        if (!res || !res.ok) {
          throw new Error('폰트 파일을 받지 못했습니다 (' + (res ? res.status : 'no response') + ')');
        }
        return res.arrayBuffer();
      })
      .then(function (buf) {
        var face = new FaceCtor(parsed.family, buf, {
          weight: String(parsed.weight),
          style: parsed.style,
          display: 'swap',
        });
        return face.load().then(function (loaded) {
          fontSet.add(loaded || face);
          return {
            family: parsed.family,
            weight: parsed.weight,
            style: parsed.style,
            filename: file.filename,
            fileId: file.id,
          };
        });
      });
  }

  function families() {
    return state.result ? state.result.families.slice() : [];
  }

  function faces() {
    return state.result ? state.result.faces.slice() : [];
  }

  /* 내장 공용 폰트 풀 (public/fonts/, 전부 SIL OFL 1.1 원본 무손실)
   *
   * 각 엔진이 가져다 쓰는 폰트를 모은 것이다:
   * - Inter 400/500/600/700 + Italic 400 — 본문 폰트. DeckCraft(craft-fonts
   *   카탈로그)·PdfCraft(assets/fonts)가 내장하는 것과 같은 본문 폰트.
   *   다만 DeckCraft 빌드는 craft-fonts 없이 만들면 Inter가 비어
   *   있었다. 대조: Regular/SemiBold/Bold/Italic이 craft-fonts
   *   매니페스트의 SHA-256과 일치함을 확인한다 (2026-11-05).
   * - JetBrains Mono 400, Dancing Script 400 — PdfCraft 내장분.
   * - BIZ UDPGothic 400 — DeckCraft craft-fonts 카탈로그의 일본어
   *   폰트 (카탈로그가 Regular만 있는 upstream 사정에 따라 Bold를
   *   위에서 제외).
   * - NanumGothic 400/700 — 한글 대체 폰트 (2026-11-05 DeckCraft .notdef
   *   수정본).
   * 라이선스 텍스트는 각 폰트 풀 *-OFL.txt가 제공한다.
   *
   * 적용 방식: 바이너리 엔진(DeckCraft·GridCraft)에 Drive '폰트' 폴더
   * 파일과 함께 보내, 사용자 폰트가 있으면 사용자 폰트가 우선하고,
   * 파일 나머지를 풀이 메운다.
   * 순서: 라틴 전용 폰트를 한글 폰트보다 앞에 넣는다 — 커버리지가 겹치는
   * 동안은 Inter가 우선한다.
   */
  var POOL_FACES = [
    { family: 'Inter', weight: 400, style: 'normal', url: '/fonts/Inter-Regular.ttf' },
    { family: 'Inter', weight: 400, style: 'italic', url: '/fonts/Inter-Italic.ttf' },
    { family: 'Inter', weight: 500, style: 'normal', url: '/fonts/Inter-Medium.ttf' },
    { family: 'Inter', weight: 600, style: 'normal', url: '/fonts/Inter-SemiBold.ttf' },
    { family: 'Inter', weight: 700, style: 'normal', url: '/fonts/Inter-Bold.ttf' },
    { family: 'JetBrains Mono', weight: 400, style: 'normal', url: '/fonts/JetBrainsMono-Regular.ttf' },
    { family: 'Dancing Script', weight: 400, style: 'normal', url: '/fonts/DancingScript.ttf' },
    { family: 'BIZ UDPGothic', weight: 400, style: 'normal', url: '/fonts/BIZUDPGothic-Regular.ttf' },
    { family: 'NanumGothic', weight: 400, style: 'normal', url: '/fonts/NanumGothic-Regular.ttf' },
    { family: 'NanumGothic', weight: 700, style: 'normal', url: '/fonts/NanumGothic-Bold.ttf' },
  ];

  // fetchFn 상위로 등 번만 받는 등 바이너리 캐시. Uint8Array로 열고
  // 있다가 보낸 플랫폼이 노출자 복사본 이다 등 postMessage transfer가
  // 원본이 detach로 캐시를 그림으로 넘기면 등 번짐 전송이 빈
  // 끝에 둔다 (DeckCraft 대관 로더와 같은 규칙).
  // 동적 로딩 URL과 공용 헬퍼(asset-url.js)가 배포 버전을 붙인다
  // (N-06 등 버전 없는 URL과 immutable 캐시를 고정할 등 있다).
  // 헬퍼가 없는 환경(테스트 등)에서는 원본 URL 그림이다.
  function versionedAssetUrl(url) {
    var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
    return typeof h === 'function' ? h(url) : url;
  }
  // 폰트 목록을 병렬로 받아 {family, weight, style, u8} 배열로 낸다
  // (F-L10 공용 본문 — loadPoolBytes와 deckcraft의 loadFallbackFonts가
  // 공유한다. 실패한 항목은 null로 남겨 나머지를 막지 않는다).
  function loadFontBytes(fetchFn, specs, label) {
    return Promise.all(
      specs.map(function (spec) {
        return Promise.resolve()
          .then(function () {
            return fetchFn(versionedAssetUrl(spec.url));
          })
          .then(function (res) {
            if (!res || !res.ok) throw new Error(label + ' font http ' + (res && res.status));
            return res.arrayBuffer();
          })
          .then(function (buf) {
            return {
              family: spec.family,
              weight: spec.weight,
              style: spec.style,
              u8: new Uint8Array(buf),
            };
          })
          .catch(function () {
            return null; // 개발 등 폰트 실패한 나머지를 막지 않는다
          });
      }),
    );
  }
  var poolCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function loadPoolBytes(fetchFn) {
    if (typeof fetchFn !== 'function') return Promise.resolve([]);
    if (poolCache) {
      var hit = poolCache.get(fetchFn);
      if (hit) return hit;
    }
    var p = loadFontBytes(fetchFn, POOL_FACES, 'pool').then(function (list) {
      return list.filter(Boolean);
    });
    if (poolCache) poolCache.set(fetchFn, p);
    return p;
  }

  var api = {
    FOLDER_NAME: FOLDER_NAME,
    FONT_EXTENSIONS: FONT_EXTENSIONS,
    parseFontFileName: parseFontFileName,
    load: load,
    reload: reload,
    whenReady: whenReady,
    families: families,
    faces: faces,
    POOL_FACES: POOL_FACES,
    loadPoolBytes: loadPoolBytes,
    loadFontBytes: loadFontBytes,
  };
  if (typeof window !== 'undefined') window.MyHubFonts = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFonts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // autoload: 호 스트 코드가 없는(rhwp-studio 문서)등 정적 태그로
  // 올린 때만 동작한다. 일반 실행 자기 시점에 load()를 부른다.
  if (typeof document !== 'undefined' && document.currentScript) {
    var tag = document.currentScript;
    if (tag.hasAttribute && tag.hasAttribute('data-myhub-fonts-autoload')) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          load();
        });
      } else {
        load();
      }
    }
  }
})();
