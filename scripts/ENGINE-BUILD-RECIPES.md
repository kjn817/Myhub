# 엔진 빌드 레시피 (2026-11-07 복구 재구성)

2026-11-07 소실 사고로 `scripts/build-*.mjs` 원본과 `.scratch` 엔진 트리가 사라졌다.
아래는 일일 로그·보존 번들(j06-preservation)·재빌드 실측으로 확정한 레시피 정본이다.
재빌드 스크립트 보존본은 이 디렉터리의 `build-*.mjs`/`build-*.js`다.

## 공통: crafts (gridcraft·deckcraft·pdfcraft)

- 업스트림: github.com/storytold/* 공개 저장소 클론 위에
  `~/workspace/j06-preservation/`의 패치 번들을 fetch해 핀 커밋으로 복원한다.
  - gridcraft: 패치 9커밋 + 미커밋 워크트리 패치 1건, base 7bb397a3..a5772e98
  - pdfcraft: 패치 6커밋, 빌드 핀 ca64a31c (ca64a31c6ccc61d326970cc576e00043671d3f57)
  - deckcraft: 패치 29커밋, 핀 61528c50
- 빌드: trunk 0.21.14 `trunk build --release` (앱 디렉터리에서). 산출 dist를
  `public/vendor/<engine>/`에 배치하고 해시 파일명은 index.html 상대 참조로 정합시킨다.

### gridcraft 크기 오버라이드 (확정 레시피 — 필수)

- 업스트림 기본 release 프로파일(opt-level=3)로는 WASM이 25,698,385B가 나와
  Cloudflare 자산 한도·로딩에 부적합했다.
- 재빌드 시 환경변수 오버라이드를 반드시 건다:
  - `CARGO_PROFILE_RELEASE_OPT_LEVEL=s`
  - `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`
- 이 오버라이드로 산출된 WASM: 17,259,748B 수준 (2026-11-07 재빌드 해시
  `gridcraft-web-93a069811b43d70f_bg.wasm`). 해시가 바뀌면 매니페스트와
  벤더 테스트 핀도 함께 갱신한다.

### pdfcraft 패키징

- 25MB 단일 파일 한도 때문에 raw WASM을 `.wasm.part0`/`.wasm.part1` 2조각으로
  쪼개고, 커스텀 셸(index.html)+로더(loader.js)가 fetch로 이어 붙여 부팅한다.
  (Worker가 Content-Encoding을 직접 찍는 방식은 엣지 재인코딩 사고로 전면 제거됨 —
  AGENTS.md 교훈 참조.)
- 패키징 스크립트: `scripts/build-pdfcraft-package.mjs`
  (`node build-pdfcraft-package.mjs <outdir>`, 스크립트 옆에 `pdfcraft/dist/web/`가
  있는 레이아웃에서 실행). manifest.json에 wasmParts와 sourceCommit을 기록한다.

## rhwp-studio (한글 편집기)

- 공개 소스 edwardkim/rhwp v0.8.7 + npm `@rhwp/core@0.8.7`의 pkg 사용.
- 환경변수 `RHWP_DISABLE_EXTERNAL_WEBFONTS=1`, 빌드 타깃 `build:no-hwpctrl`,
  `--base=/rhwp-studio/`로 빌드해 산출물 전량(57개 수준)을 `public/rhwp-studio/`에 배치.
- 서비스워커 파일군은 배포 산출물에서 제외한다 (확정 설계).
- Finder HWP 보기용 코어는 별도: `public/vendor/rhwp/`(rhwp.js + rhwp_bg.wasm),
  SDK는 `public/vendor/rhwp-editor/`에 npm 패키지 파일을 그대로 배치.

## kordoc (한글 문서 판독 번들)

- npm `kordoc@4.24.39` + dist 패치 1곳: readZipEntry의 nodeStream 경로를
  `file.async('uint8array')` + 상한 가드로 교체 (`scripts/build-kordoc-patch-dist.mjs`).
- 진입점 `scripts/build-kordoc-entry.js` (readText·markdownToHwpx·parse export),
  번들러 `scripts/build-kordoc.mjs` (esbuild, ESM, browser, 스텁 플러그인 +
  Buffer inject `build-kordoc-buffer-shim.js`).
- 산출 `kordoc.bundle.js`를 `public/vendor/kordoc/kordoc.bundle.js`로 복사한다.
- 산출 가드: 번들에 markdownToHwpx 존재 + 무패치 nodeStream 호출 잔존 금지.
- 클라이언트 배선: Finder 뷰어는 `public/js/finder-format-hwp.js`가 동적 import로
  지연 로딩해 `window.kordoc`에 노출(readText는 {markdown} → 문자열 정규화),
  오피스 비서는 markdownToHwpx를 사용한다.

## pdf-viewer (pdf.js)

- pdf.js v6.5.438 dist를 `public/pdf-viewer/`에 배치하되 로케일은 ko·en-US만
  남기고 다듬는다. 나머지는 dist 표준 구조 그대로.

## FortuneSheet (Excel 폴백)

- npm `@fortune-sheet/react@^1.0.4` + react/react-dom 18.3.1.
- 진입점 `scripts/build-fortune-entry.js`를 esbuild로 번들해
  `public/vendor/fortune/fortune.js` + `fortune.css`를 만든다.
  (2026-11-07 재빌드본은 운영본과 바이트가 다를 수 있는 기능 동등 재구성본이다.)

### fortune 한국어 로케일 (2026-11-11 복원)
- 절차: ① 기준 빌드(위 fortune 절)로 트리 해시 832a818f… 재현 확인 → ② `scripts/fortune-ko/apply-ko-locale.mjs`로 @fortune-sheet/core dist에 ko 로케일 등록(en deep-walk + `scripts/fortune-ko/ko-locale-map.json` 934항목 치환, 키 패리티 기계 대조) → ③ 재빌드 → ④ `scripts/fortune-ko/patch-image-titles.mjs`로 이미지 도구 하드코딩 제목 4종(자르기·원본 복원·삭제·확대/축소 설정) 패치(개수 단언 포함).
- 최종 산출 해시: ab6054f9… (5,945,563B에서 제목 패치로 소폭 변동). 원본의 자체 번역 자산은 소실 확정 — 재번역본이며 원본 바이트와는 상이(기능·UI 동등 복원).
- functionlist(함수 설명)는 원본 기준대로 영어 유지.
