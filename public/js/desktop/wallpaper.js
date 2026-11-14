/* MyHub 데스크톱 배경화면 관리자 (wallpaper.js)
 *
 * 설계: docs/desktop-macos-redesign-20261101.md A단계 + 2026-11-02 개혁
 * - 배경은 '오늘의 사진' 하나로 남긴다. 그라데이션 프리셋은
 *   사용자가 최소로 하기로 판정했다 — 저장된 gradient 모드도
 *   loadPref가 'today'로 자동 소급한다.
 * - 로딩은 macOS 부팅 화면같이: 사진이 준비되기 앞에서는 그레이
 *   (#0b0b0f) 바탕 중앙의 JN 마크 + 가늘고 옅은 흰색 진행 바만 있고,
 *   사진이 로드하면 부팅 레이어도 부드럽게 사라진다. 선택은
 *   localStorage 'myhub.desktop.wallpaper.v1'에 저장한다.
 * - 이미지 로딩은 메타데이터 병렬이다 (2026-11-02 추가 지시 6):
 *   부팅 즉시 날짜를 붙인 이미지 URL(/api/desktop/wallpaper/image?v=
 *   <KST 날짜>)로 Image()를 시작하고, /today 메타데이터는 캡션 표시
 *   전용으로만 연다. 날짜가 붙은 URL은 그날 불변이라 서버가
 *   Cache-Control: max-age=86400, immutable로 내려준다.
 * - 사진은 동일 출처 프록시로만 가져온다 — 데스크톱 페이지의 CSP
 *   enforce(img-src 'self')가 외부 URL 직로딩을 차단한다. 이미지 로드
 *   실패 시에만 부팅 레이어를 유지한다 (대체).
 * 노출: window.MyHubDesktopWallpaper = { PREF_KEY, ENDPOINT,
 *        IMAGE_ENDPOINT, defaultPref, loadPref, savePref, captionText,
 *        kstDateString, imageUrlFor, barToneHex, createManager }
 */
(function () {
  'use strict';

  var PREF_KEY = 'myhub.desktop.wallpaper.v1';
  var ENDPOINT = '/api/desktop/wallpaper/today';
  // 사진은 동일 출처 프록시로 받는다 (CSP img-src 'self' 때문)
  var IMAGE_ENDPOINT = '/api/desktop/wallpaper/image';

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** 로컬 시간대와 무관하게 KST(UTC+9) 날짜 문자열(YYYY-MM-DD)을 만든다. */
  function kstDateString(now) {
    var t = new Date((now || new Date()).getTime() + 9 * 60 * 60 * 1000);
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }

  /** 그 날짜의 사진 URL에 날짜를 캐시 무효화용 버전 쿼리로 붙인다. */
  function imageUrlFor(dateStr) {
    return IMAGE_ENDPOINT + '?v=' + dateStr;
  }

  /**
   * 배경 사진 상단의 평균색을 상단바 합성 색(#rrggbb)으로 바꾼다.
   * 데스크톱 상단바는 rgba(255,255,255,0.55) + blur saturate(1.6)이라
   * 배경색의 채도를 1.6배로 올린 뒤 흰색을 55% 섞은 색으로 보인다.
   * 설치된 PWA의 Window Controls Overlay 버튼은 meta theme-color
   * 합성으로만 바뀌므로, 계산한 색을 theme-color로 넣어 상단바를
   * 사진 톤에 맞춘다.
   */
  function barToneHex(r, g, b) {
    var avg = (r + g + b) / 3;
    function boost(v) { return Math.max(0, Math.min(255, avg + (v - avg) * 1.6)); }
    function mix(v) { return Math.round(255 * 0.55 + boost(v) * 0.45); }
    function hex(v) { return (v < 16 ? '0' : '') + v.toString(16); }
    return '#' + hex(mix(r)) + hex(mix(g)) + hex(mix(b));
  }

  function defaultPref() {
    return { mode: 'today' };
  }

  /**
   * 앱값을 'today'로 정규화해 알려준다. gradient 모드로 저장된 앱
   * 값도 자동으로 소급한다 (프리셋 폐지). 어떤 입력에도 throw하지 않는다.
   */
  function loadPref(storage) {
    var raw = null;
    try {
      raw = storage ? storage.getItem(PREF_KEY) : null;
    } catch (e) {
      return defaultPref();
    }
    if (!raw) return defaultPref();
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaultPref();
    } catch (e) {
      return defaultPref();
    }
    return defaultPref();
  }

  function savePref(storage, pref) {
    if (!storage) return;
    try {
      storage.setItem(PREF_KEY, JSON.stringify({ mode: 'today' }));
    } catch (e) {
      console.warn('배경 선택 저장 실패:', e);
    }
  }

  function captionText(wallpaper) {
    if (!wallpaper) return '';
    var parts = [];
    if (wallpaper.caption) parts.push(wallpaper.caption);
    if (wallpaper.credit) parts.push(wallpaper.credit);
    return parts.join(' · ');
  }

  /**
   * deps = { layer, caption, storage, fetchFn?, imageCtor? }
   * - layer: 배경을 거는 요소 (클래스·backgroundImage를 관리한다).
   *   사진은 레이어 자체의 배경이어야 미션 컨트롤이 배경을 읽어 간다.
   *   사진이 준비되기 전에는 레이어의 근검정 배경색(.dt-wallpaper)이
   *   그대로 보인다 — JN 마크+진행 막대의 부팅 레이어는 2026-11-13
   *   사용자 지시로 삭제했다 (MyHub 로딩 원형과 중첩된다는 지적).
   * - caption: 캡션 요소 (textContent와 hidden을 관리한다)
   * - 배경 선택 UI는 nav.js 설정 메뉴에 등록한다 (registerSettingsItems)
   */
  function createManager(deps) {
    deps = deps || {};
    var layer = deps.layer;
    if (!layer) throw new Error('createWallpaperManager: layer가 필요합니다');
    var caption = deps.caption || null;
    var storage = deps.storage || null;
    var fetchFn = deps.fetchFn || function (url) { return fetch(url); };
    var pref = loadPref(storage);
    var destroyed = false;
    var seq = 0; // 적용 순번: 늦게 끝난 이전 시도가 화면을 덮지 못하게 한다

    function applyPhoto(url) {
      layer.className = 'dt-wallpaper dt-wp-photo';
      layer.style.backgroundImage = 'url("' + url + '")';
    }

    // ---- 설치된 PWA 타이틀바 색 동기 (Window Controls Overlay) ----
    // WCO 버튼은 meta theme-color 합성으로만 바뀐다. 사진이
    // 바뀌면 상단 평균색으로 바 합성 색을 다시 계산해 넣고,
    // 전체화면 창이 있으면 바가 검정이므로 톤도 검정으로 맞춘다.
    var toneHex = null;
    var toneObserver = null;
    function themeDoc() {
      return layer.ownerDocument || (typeof document !== 'undefined' ? document : null);
    }
    function setThemeColor(hex) {
      var doc = themeDoc();
      if (!doc || !doc.querySelector) return;
      var meta = doc.querySelector('meta[name="theme-color"]');
      if (!meta && doc.head && doc.createElement) {
        meta = doc.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        doc.head.appendChild(meta);
      }
      if (meta) meta.setAttribute('content', hex);
      // WCO 모드에서는 상단바 배경이 같은 값을 합성으로 쓴다 (shell.css
      // .g-nav background: var(--titlebar-tone)) — 상단바가 같은 색으로 보인다.
      if (doc.documentElement && doc.documentElement.style) {
        doc.documentElement.style.setProperty('--titlebar-tone', hex);
      }
    }
    function applyTone() {
      var doc = themeDoc();
      var full = !!(doc && doc.body && doc.body.classList && doc.body.classList.contains('dt-fullscreen'));
      if (full) { setThemeColor('#000000'); return; }
      if (toneHex) setThemeColor(toneHex);
    }
    function syncToneFromImage(img) {
      try {
        var doc = themeDoc();
        if (!doc || !img.naturalWidth) return;
        var canvas = doc.createElement('canvas');
        canvas.width = 48; canvas.height = 48;
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 48, 48);
        var data = ctx.getImageData(0, 0, 48, 10).data; // 상단 10줄 = 상단바가 겹치는 영역
        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
        if (!n) return;
        toneHex = barToneHex(r / n, g / n, b / n);
        applyTone();
      } catch (e) {
        console.warn('타이틀바 톤 동기 실패 (기본 theme-color 유지):', e);
      }
    }
    function watchTone() {
      var doc = themeDoc();
      if (!doc || !doc.body || typeof MutationObserver === 'undefined') return;
      toneObserver = new MutationObserver(function () { applyTone(); });
      toneObserver.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    }
    watchTone();

    function probeImage(url, mySeq) {
      var ImageCtor = deps.imageCtor || (typeof Image !== 'undefined' ? Image : null);
      if (!ImageCtor) {
        applyPhoto(url);
        return;
      }
      var probe = new ImageCtor();
      probe.onload = function () {
        if (destroyed || mySeq !== seq) return;
        applyPhoto(url);
        syncToneFromImage(probe);
      };
      probe.onerror = function () {
        // 이미지 실패: 아무 표시도 하지 않는다 — 레이어의 근검정
        // 배경이 그대로 남는다 (부팅 레이어는 2026-11-13 삭제).
        if (destroyed || mySeq !== seq) return;
      };
      probe.src = url;
    }

    function applyToday() {
      var mySeq = ++seq;
      // 이미지부터 받기 시작한다 앱 메타데이터를 기다리지 않는다.
      var dateStr = kstDateString(new Date());
      probeImage(imageUrlFor(dateStr), mySeq);
      // 메타데이터는 캡션 전용으로 병렬 조회한다. 실패해도 사진 표시는
      // 계속하고, 캡션만 비어 있게 연다.
      return Promise.resolve()
        .then(function () { return fetchFn(ENDPOINT); })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('wallpaper http ' + (res && res.status));
          return res.json();
        })
        .then(function (body) {
          if (destroyed || mySeq !== seq) return;
          var wp = body && body.wallpaper;
          if (!wp) return;
          if (caption) {
            var text = captionText(wp);
            caption.textContent = text;
            caption.hidden = !text;
          }
          // 날짜가 다르면(자정 경계 앱) 그 날짜의 URL로 다시 받는다
          if (typeof wp.date === 'string' && wp.date && wp.date !== dateStr) {
            probeImage(imageUrlFor(wp.date), mySeq);
          }
        })
        .catch(function (e) {
          // 캡션 조회 실패는 사진 표시를 무관하다 앱 내어감이 앱을 남긴다
          console.warn('배경 캡션 조회 실패 (사진 표시는 계속):', e);
        });
    }

    function apply() {
      return applyToday();
    }

    function setPref(next) {
      void next; // 배경은 '오늘의 사진' 하나뿐 앱 어떤 입력도 today로 정규화
      pref = defaultPref();
      savePref(storage, pref);
      return apply();
    }

    // ---- 배경 선택은 상단바 설정 메뉴에서 처리한다. 프리셋이 자체의
    // 배경 그룹의 앱은 '오늘의 사진' 하나만 둔다.
    function registerSettingsItems() {
      var nav = typeof window !== 'undefined' ? window.MyHubNav : null;
      if (!nav || typeof nav.addSettingsItems !== 'function') return;
      nav.addSettingsItems([
        {
          id: 'wp-group',
          group: '배경',
          children: [
            {
              id: 'wp-today',
              label: '오늘의 사진',
              checked: function () { return true; },
              onSelect: function () { setPref({ mode: 'today' }); },
            },
          ],
        },
      ]);
    }
    registerSettingsItems();
    var ready = apply();

    return {
      getPref: function () { return { mode: pref.mode }; },
      setPref: setPref,
      refresh: apply,
      ready: ready,
      destroy: function () {
        destroyed = true;
        if (toneObserver) { toneObserver.disconnect(); toneObserver = null; }
      },
    };
  }

  var api = {
    PREF_KEY: PREF_KEY,
    ENDPOINT: ENDPOINT,
    IMAGE_ENDPOINT: IMAGE_ENDPOINT,
    defaultPref: defaultPref,
    loadPref: loadPref,
    savePref: savePref,
    captionText: captionText,
    kstDateString: kstDateString,
    imageUrlFor: imageUrlFor,
    barToneHex: barToneHex,
    createManager: createManager,
  };
  if (typeof window !== 'undefined') window.MyHubDesktopWallpaper = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopWallpaper = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
