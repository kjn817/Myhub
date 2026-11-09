// 파인더 뷰어 플러그 모듈 등 DOCX (finder-format-doc.js)
// mammoth로 본문 HTML 미리보기만 제공한다 (편집 없음).
//
// 보안 (N-01, 2026-11-05): mammoth의 본문 텍스트는 이스케이프해서만
// 하이링크 대상(Target)를 검증하지 않고, 수신한 DOCX의
// `javascript:` 링크가 변환 HTML를 그대로 둔다. 정제 없이
// innerHTML로 넣으면 링크 클릭 등 번으로 같은 출처 스크립트 실행이
// 된다. 그래야 렌더 직전에 반드시 정제를 거친다:
//   1순위 등 자체 호스트 DOMPurify 3.4.17
//     (public/vendor/dompurify/3.4.17/purify.min.js, N-04 자체
//     호스)트만 뷰어 코어 loadLib로 지정 로딩이 이다. 설정된
//     채팅/메모 정제와 정합: 기본 프로필에 target 속성만 추가 허용
//     (메모 md.js와 동일).
//   2순위 등 DOMPurify를 모두 불러오는 내장 허용목록 정제로 강행한다
//     (fail-safe: 정제를 건너뛰고 원본을 꽂는 경로를 두지 않는다).
//     태그속성URL 스킴 전부 허용목록으로 다시 조립하므로
//     javascript:/vbscript:/data:(등) 스킴과 on* 속성을 함께 등
//     넣고, 위험한(data:image 등)의https 링크 같은 문서를 표시로
//     보존한다.
(function () {
  'use strict';
  var core = typeof window !== 'undefined' ? window.MyHubFinderViewer : null;
  if (!core) return;

  // 자체 내장 허용 목록 (DOMPurify 정제 불가의 강행 경로) 자체
  var ALLOWED_TAGS = {};
  (
    'a b blockquote br caption code dd div dl dt em h1 h2 h3 h4 h5 h6 ' +
    'hr i img li ol p pre s span strong sub sup table tbody td tfoot th ' +
    'thead tr u ul'
  )
    .split(' ')
    .forEach(function (t) {
      ALLOWED_TAGS[t] = true;
    });
  // 서브 트리 전체: 태그 내용까지/실행 표시 실행의 등 있는 결합
  var DROP_TAGS = {};
  (
    'script style iframe object embed form input button textarea select ' +
    'option link meta base title svg math template noscript frame frameset ' +
    'audio video source track canvas map area applet dialog'
  )
    .split(' ')
    .forEach(function (t) {
      DROP_TAGS[t] = true;
    });

  // URL 스킴검사 브라우저가: 스킴 판정에 섞어넣는 제어문자류를 제거하고
  // 해석하므로, 검사도 같은 방식으로 정제한 값으로 한다.
  function urlScheme(value) {
    var compact = String(value == null ? '' : value).replace(/[\u0000-\u0020\u007f]+/g, '');
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
    return m ? m[1].toLowerCase() : '';
  }
  function isSafeLinkHref(value) {
    var scheme = urlScheme(value);
    if (!scheme) return true; // 상대 경로#앵커//프로토콜 상대
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
  }
  function isSafeImgSrc(value) {
    var scheme = urlScheme(value);
    if (!scheme) return true;
    if (scheme === 'http' || scheme === 'https') return true;
    // mammoth 아래 이미지는 data:image/*;base64 형태뿐이다. 그 등
    // data:(text/html 는)어떤 경우 에도 허용하지 않는다.
    return /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml|x-emf|wmf);base64,/i.test(
      String(value).replace(/[\u0000-\u0020\u007f]+/g, ''),
    );
  }
  function isNumericAttr(value) {
    return /^\d+$/.test(String(value));
  }

  function copySafeAttrs(srcEl, dstEl, tag) {
    // 전역 허용: id(앵커 등 속성)만title등. class/style/on*은
    // 어떤 태그에서도 복사하지 않는다.
    if (srcEl.getAttribute('id')) dstEl.setAttribute('id', srcEl.getAttribute('id'));
    if (srcEl.getAttribute('title')) dstEl.setAttribute('title', srcEl.getAttribute('title'));
    if (tag === 'a') {
      var href = srcEl.getAttribute('href');
      if (href && isSafeLinkHref(href)) dstEl.setAttribute('href', href);
      var target = srcEl.getAttribute('target');
      if (target && /^_(blank|self|parent|top)$/.test(target)) {
        dstEl.setAttribute('target', target);
        if (target === '_blank') dstEl.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (tag === 'img') {
      var src = srcEl.getAttribute('src');
      if (src && isSafeImgSrc(src)) dstEl.setAttribute('src', src);
      if (srcEl.getAttribute('alt') != null) dstEl.setAttribute('alt', srcEl.getAttribute('alt'));
      if (isNumericAttr(srcEl.getAttribute('width'))) dstEl.setAttribute('width', srcEl.getAttribute('width'));
      if (isNumericAttr(srcEl.getAttribute('height'))) dstEl.setAttribute('height', srcEl.getAttribute('height'));
    } else if (tag === 'td' || tag === 'th') {
      if (isNumericAttr(srcEl.getAttribute('colspan'))) dstEl.setAttribute('colspan', srcEl.getAttribute('colspan'));
      if (isNumericAttr(srcEl.getAttribute('rowspan'))) dstEl.setAttribute('rowspan', srcEl.getAttribute('rowspan'));
    } else if (tag === 'ol') {
      if (isNumericAttr(srcEl.getAttribute('start'))) dstEl.setAttribute('start', srcEl.getAttribute('start'));
    } else if (tag === 'li') {
      if (isNumericAttr(srcEl.getAttribute('value'))) dstEl.setAttribute('value', srcEl.getAttribute('value'));
    }
  }

  function sanitizeWithAllowlist(html, docRef) {
    var docObj =
      docRef ||
      (typeof document !== 'undefined' ? document : null) ||
      (typeof window !== 'undefined' ? window.document : null);
    if (!docObj) return '';
    var sourceNodes;
    if (typeof DOMParser !== 'undefined') {
      // DOMParser 문서를 비활성(inert)라 파싱만으로 스크립트 실행에
      // 리소스 로딩이 일어나지 않는다.
      var parsed = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
      sourceNodes = parsed.body ? parsed.body.childNodes : [];
    } else if (docObj.createElement) {
      var tpl = docObj.createElement('template');
      tpl.innerHTML = String(html == null ? '' : html);
      sourceNodes = tpl.content ? tpl.content.childNodes : [];
    } else {
      return '';
    }
    var frag = docObj.createDocumentFragment();
    function rebuild(nodeList, parent) {
      Array.prototype.slice.call(nodeList).forEach(function (node) {
        if (node.nodeType === 3) {
          parent.appendChild(docObj.createTextNode(node.nodeValue));
          return;
        }
        if (node.nodeType !== 1) return; // 주석 대상 노드만
        var tag = String(node.tagName || '').toLowerCase();
        if (DROP_TAGS[tag]) return;
        if (!ALLOWED_TAGS[tag]) {
          rebuild(node.childNodes, parent); // 등 등 없는 태그는 끝까지만 떨어낸다
          return;
        }
        var el = docObj.createElement(tag);
        copySafeAttrs(node, el, tag);
        rebuild(node.childNodes, el);
        parent.appendChild(el);
      });
    }
    rebuild(sourceNodes, frag);
    var holder = docObj.createElement('div');
    holder.appendChild(frag);
    return holder.innerHTML;
  }

  /**
   * DOCX 변환 HTML 정제 등가 DOMPurify있으면 그 결과, 없으면 내장
   * 허용목록 정제를 낸다. 어느 경로도 정제하지 않은 원본을 반환하는
   * 경우가 없다 (DOMPurify가 없으면 허용목록 경로로 넘어간다).
   */
  function sanitizeDocxHtml(html, purify, docRef) {
    var raw = String(html == null ? '' : html);
    var p =
      purify && typeof purify.sanitize === 'function'
        ? purify
        : typeof window !== 'undefined' && window.DOMPurify && typeof window.DOMPurify.sanitize === 'function'
          ? window.DOMPurify
          : null;
    if (p) {
      try {
        // 채팅메모와/같은 라이브러리를 공유하는 정합, DOCX 미리보기 전용
        // 축소를 위한의: mammoth 출력인 HTML이므로등 svg/mathML 프로필
        // 경고(기본값 켜짐), 미리보기인 등 과 없는 등 컨트롤러 금지
        // 한다. target 허용은 메모 md.js와 동일.
        return p.sanitize(raw, {
          USE_PROFILES: { html: true },
          ADD_ATTR: ['target'],
          FORBID_TAGS: ['form', 'button', 'input', 'select', 'textarea', 'label', 'fieldset', 'datalist', 'output'],
        });
      } catch (e) {
        // 정제 실패 등 원본 대관는 금지 등 허용목록 경로로 강행한다
        console.warn('[finder-docx] DOMPurify 정제 실패 등 허용목록 정제로 강행', e);
      }
    }
    return sanitizeWithAllowlist(raw, docRef);
  }

  function resolvePurify(ctx) {
    if (
      typeof window !== 'undefined' &&
      window.DOMPurify &&
      typeof window.DOMPurify.sanitize === 'function'
    ) {
      return Promise.resolve(window.DOMPurify);
    }
    if (!ctx || typeof ctx.loadLib !== 'function') return Promise.resolve(null);
    return ctx
      .loadLib('purify')
      .then(function (p) {
        if (p && typeof p.sanitize === 'function') return p;
        if (
          typeof window !== 'undefined' &&
          window.DOMPurify &&
          typeof window.DOMPurify.sanitize === 'function'
        ) {
          return window.DOMPurify;
        }
        return null;
      })
      .catch(function () {
        return null; // 로드 실패 = 내장 정제로 강행 (원본 렌더 아님)
      });
  }

  function handleDocx(ctx) {
    return ctx
      .loadLib('mammoth')
      .then(function (mammoth) {
        return ctx.fetchContent('buffer').then(function (buf) {
          return mammoth.convertToHtml({ arrayBuffer: buf });
        });
      })
      .then(function (result) {
        return resolvePurify(ctx).then(function (purify) {
          if (!ctx.isCurrent()) return;
          ctx.setNote('워드 문서를 미리보기만 합니다');
          ctx.clearBody();
          var div = ctx.doc.createElement('div');
          div.className = 'fv-doc';
          div.innerHTML = sanitizeDocxHtml(result.value, purify, ctx.doc);
          ctx.body.appendChild(div);
        });
      });
  }

  core.registerFormat('docx', handleDocx);

  var api = { handleDocx: handleDocx, sanitizeDocxHtml: sanitizeDocxHtml };
  if (typeof window !== 'undefined') window.MyHubFinderFormatDoc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
