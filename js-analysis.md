# memo.html 인라인 JS 리팩토링 분석

분석일: 2026-10-09
대상: `~/workspace/myhub/public/memo.html` 99~2866줄 (인라인 `<script>`, 2,768줄)
목표: 500줄 이하 모듈로 분리 (MyHub 코드 헌법 준수)

---

## 1. 전체 구조

인라인 스크립트는 번호 매겨진 섹션으로 구성되어 있으나 **선언 순서가 뒤섞여 있음**이 가장 큰 문제다.

| 섹션 | 상대 줄 | HTML 절대 줄 | 내용 | 크기 |
|------|---------|-------------|------|------|
| 1. 유틸 | 62~129 | 160~227 | esc, fmtDate, 파일 유틸 등 | ~68줄 |
| 3. HTML↔MD | 130~355 | 228~453 | 마크다운 직렬화/파싱 | ~226줄 |
| 4. 작성(컴포저) | 356~570 | 454~668 | 새 메모 작성기, 업로드 | ~215줄 |
| 5. 필터 | 571~594 | 669~692 | 활성 필터 렌더 | ~24줄 |
| 6. 태그 | 595~628 | 693~726 | 태그 로드/UI | ~34줄 |
| 7. 달력 | 629~684 | 727~782 | 달력 렌더 | ~56줄 |
| 9. 인라인 수정 | 685~772 | 783~870 | startEdit (구 편집 진입점) | ~88줄 |
| 10. 이미지 도구 | 773~889 | 871~987 | 이미지 복사/도구바 | ~117줄 |
| 11. 라이트박스 | 890~958 | 988~1056 | 이미지 라이트박스 + 전역 키바인딩 | ~69줄 |
| **11. 시작 (init)** | 959~1264 | 1057~1362 | **initCal(), load() 등 실행 코드** | ~306줄 |
| 2. WYSIWYG 에디터 | 1265~2128 | 1363~2226 | wireEditor, 툴바 (가장 큼) | ~864줄 |
| 8. 목록(타임라인) | 2129~2768 | 2227~2866 | load, renderRows, pane | ~640줄 |

**치명적 구조 문제**: "11. 시작" init 실행 코드(상대 959줄)가 에디터(1265줄)와 목록(2129줄) **함수 정의보다 앞에** 있다.
함수 선언은 호이스팅되어 호출 자체는 되지만, `let`/`const` 상태 변수는 TDZ(Temporal Dead Zone)에 걸린다.
실제로 발생한 장애:
- `cachedMemos` (2026-10-09 수정): init보다 뒤에 선언 → 목록 블랭크
- `lastFilterSig` (2026-10-09 수정): 동일 원인 → 초기 로드 실패

### 1.1 최상위 실행 코드 (init 외에도 산재)

함수 선언 사이에 최상위 실행문이 끼어 있다:
- 상대 357줄: `const composerEditor = wireEditor($('composerRich'), ...)` — 평가 시점에 wireEditor 실행
- 상대 928~950줄: 라이트박스 이벤트 바인딩 (`$('lb-close').onclick = ...` 등)
- 상대 960~965줄: `initCal(); updateLayoutMode(); loadTags(); load();`
- 상대 1313줄: `document.addEventListener('mousedown', ...)` (툴바 팝업용)
- 상대 2768줄(마지막): `$('q').addEventListener('input', ...)` (검색 디바운스)

### 1.2 최상위 상태 변수 (상대 줄 번호)

```
2   const $ = (id) => document.getElementById(id);
3   let cachedMemos = [];
4   let lastFilterSig = '';
5   let searchTimer = null;
6   const memoTexts = {};
7   const memoFileMap = {};
8   const memoCache = {};
9   let activeTag = '', activeDate = '';
10  let selectedIds = [];
13  const mqDesktop = window.matchMedia('(min-width: 1024px)');
14  const isDesktop = () => mqDesktop.matches;
48  const PAGE_SIZE = 10;
49  let page = 0;
97  const IMG_EXTS = [...];
357 const composerEditor = wireEditor(...);  // 즉시 실행!
358 let composerTitle = '';
620 let tagbarOpen = false;
630 let calY = 0, calM = 0;
803 let imgToolsBar = null;
804 let imgToolsTimer = null;
891 let lbImages = [], lbIndex = 0, lbZoom = 1;
1302 const PALETTE = [...];      // 에디터 색상
1303 const HIGHLIGHTS = [...];
1304 const SIZES = [...];
1990 let imgResize = null;
```

---

## 2. 함수 목록 (82개, 크기순 상위)

| 함수 | 줄 수 | 모듈 후보 |
|------|------|----------|
| buildToolbarButtons | 299 | toolbar |
| wireEditor | 244 | editor |
| openPane | 213 | pane |
| updateMemoFiles | 110 | list |
| renderPaneFiles | 128 | pane |
| wireTableTools | 125 | editor |
| startEdit | 88 | pane |
| openLinkDialog | 82 | toolbar |
| showImgTools | 83 | imgtools |
| mdBlockConvert | 70 | toolbar |
| openTablePicker | 68 | toolbar |
| showImgResize | 65 | editor |
| cleanupOrphanFiles | 58 | api |
| savePane | 53 | pane |
| renderCal | 50 | calendar |
| uploadPendings | 46 | api |
| blockNodeToMd | 41 | md |
| inlineNodeToMd | 41 | md |
| load | 41 | list |
| mdInlineConvert | 40 | toolbar |
| handleEditorFiles | 37 | editor |
| wrapSelectionStyle | 36 | toolbar |
| renderRows | 35 | list |
| editComposerTitle | 33 | composer |
| updateToolbarActive | 30 | toolbar |
| mdToEditable | 27 | md |
| listToMd | 26 | md |
| renderBodyHtml | 26 | md |

나머지 54개는 25줄 이하.

### 2.1 데드코드 후보
- `extractTags` (6줄): 정의만 있고 호출이 전혀 없음. 삭제 검토.
- `editComposerTitle` (33줄): 다른 함수가 호출하지 않음. HTML 인라인 핸들러에서 호출되는지 확인 필요.
- `startEdit` (88줄): 구 편집 진입점. 현재 `openPane`이 실제 사용 중. 호출처 없으면 삭제 검토. (단, `data-act="edit"` 핸들러 경유 가능성 있어 육안 확인 필요)

### 2.2 디자인 원칙 위반
- `updateMemoFiles`: 이모지 `📎` 사용 → Lucide `paperclip` SVG로 교체 필요.

---

## 3. 의존성 분석

### 3.1 허브 함수 (가장 많이 호출됨)
`esc`(13회), `refreshIcons`(12회), `load`(6회), `hideImgTools`(6회), `hideImgResize`(6회),
`updatePanesVisibility`(5회), `execCmd`(5회), `restoreSel`(5회)

### 3.2 모듈 간 의존성 (순환 있음)

```
core     -> filter, calendar
utils    -> (없음)
md       -> utils
api      -> utils, filter, list
composer -> (없음)
filter   -> utils, calendar, list, api
calendar -> utils, list
list     -> core, filter, utils, md, imgtools, lightbox, pane
pane     -> utils, md, api, imgtools, editor, list, core, calendar, lightbox
toolbar  -> utils, editor
editor   -> imgtools, toolbar, utils
lightbox -> (없음)
imgtools -> utils, lightbox, editor
```

**순환 의존성 존재** (예: `core → filter → calendar → list → core`).
이는 ES 모듈 정적 import로 그대로 옮기면 순환 import 문제가 된다.

### 3.3 상태 변수 응집도
- `memoFileMap`: 6개 함수 (startEdit, load, updateMemoFiles, openPane, renderPaneFiles, savePane)
- `memoCache`: 5개 함수
- `selectedIds`: 5개 함수 (PC 다중선택)
- `isDesktop`: 5개 함수
- `activeTag`: 4개 함수 / `activeDate`: 3개 함수

---

## 4. 모듈 분리 제안

**핵심 전략**: ES 모듈 import/export가 아니라 **파일 분리 + esbuild 번들(concat 순서 보장)**.
이유:
1. 순환 의존성이 있어 정적 import로 분리하면 동작이 깨진다.
2. 함수 선언 호이스팅 덕분에 **유일한 순서 제약은 (a) 상태 선언이 실행 코드보다 먼저, (b) 실행 코드(init)가 맨 마지막**이다.
3. deploy_full.py가 이미 esbuild를 사용하므로 번들 단계 추가가 자연스럽다.
4. 각 소스 파일은 500줄 이하로 헌법을 만족하고, 번들 결과물은 자동생성 파일로 예외 처리.

### 4.1 제안 모듈 (public/js/memo/ 아래)

| # | 파일 | 내용 | 예상 줄 수 |
|---|------|------|-----------|
| 1 | `state.js` | `$`, 모든 `let`/`const` 상태 선언 (위 1.2 전체). 실행 코드 없음 | ~60 |
| 2 | `utils.js` | esc, fmtSize, fmtDate, highlight, fileIcon, isImage, markerIds, parseMarkerAlt, refreshIcons, toast | ~110 |
| 3 | `md-convert.js` | escMd, escapeBlockStart, inlineNodeToMd, inlineToMd, listToMd, blockOrInline, tableToMd, blockNodeToMd, serializeEditor, editorIsEmpty, applyTableWidths, mdToEditable, renderBodyHtml | ~230 |
| 4 | `api.js` | loadTags, uploadPendings, uploadWithProgress, showUploadProgress, updateUploadProgress, hideUploadProgress, applyFileIds, markerFileIds, cleanupOrphanFiles | ~170 |
| 5 | `composer.js` | makeTitleLabel, renderComposerTitle, editComposerTitle(데드코드면 삭제), composerEditor 초기화 | ~120 |
| 6 | `filter.js` | renderActiveFilters, syncTagUI, setTagbar | ~60 |
| 7 | `calendar.js` | initCal, renderCal | ~60 |
| 8 | `list.js` | load, updateMemoFiles, renderCards, rowTitle, renderRows, renderPager, syncRowSelection, selectMemo | ~230 |
| 9 | `pane.js` | openPane, closePane, closeAllPanes, savePane, renderPaneFiles, startEdit(데드코드면 삭제) | ~400 |
| 10 | `editor-toolbar.js` | PALETTE/HIGHLIGHTS/SIZES + buildToolbarButtons, execCmd, wrapSelectionStyle, closePops, openTablePicker, openLinkDialog, insertTableRc, mdBlockConvert, mdInlineConvert, updateToolbarActive | ~460 |
| 11 | `editor-core.js` | wireEditor, wireTableTools, hideImgResize, showImgResize, restoreSel, handleEditorFiles, refreshOtherFiles | ~450 |
| 12 | `lightbox.js` | setZoom, openLightboxFromCard, renderLb, closeLightbox, lbNav + 라이트박스 이벤트 바인딩 | ~110 |
| 13 | `imgtools.js` | copyImageToClipboard, hideImgTools, showImgTools | ~110 |
| 14 | `layout.js` | updatePanesVisibility, updateLayoutMode | ~40 |
| 15 | `init.js` | 전역 키바인딩, 검색 input 바인딩, `initCal(); updateLayoutMode(); loadTags(); load();` — **반드시 마지막** | ~60 |

**주의**: `editor-toolbar.js`(460줄)와 `editor-core.js`(450줄)가 500줄에 근접. `buildToolbarButtons`(299줄) 내부의 색상 팔레트/표 선택 UI를 별도 `editor-popups.js`로 빼면 300줄대로 낮출 수 있다(선택).

### 4.2 번들 순서 (esbuild concat / IIFE)

```
state.js → utils.js → md-convert.js → api.js → composer.js → filter.js
→ calendar.js → layout.js → lightbox.js → imgtools.js
→ editor-toolbar.js → editor-core.js → list.js → pane.js → init.js
```

규칙:
1. `state.js`가 맨 처음 (모든 `let`/`const`가 실행 코드보다 먼저 평가).
2. `init.js`가 맨 마지막 (DOM 바인딩 + `load()` 호출).
3. 중간 순서는 무관 (함수 선언 호이스팅).
4. `composer.js`의 `wireEditor(...)` 즉시 실행 호출은 `editor-core.js` **이후**에 평가되어야 함 → composer.js를 editor-core.js 뒤로 배치하거나, init.js로 이동 권장.

### 4.3 대안: 네임스페이스 객체 패턴

번들 없이 `<script src>` 여러 개로 로드하려면 실행 순서가 보장되지 않으므로,
`window.MemoApp = {}` 네임스페이스에 등록하고 `init.js`에서 `MemoApp.init()`을 호출하는 패턴도 가능.
단, 전역 오염과 타이핑이 번들 방식보다 불리.

---

## 5. 분리 시 주의할 점

### 5.1 Temporal Dead Zone (가장 중요)
- 2026-10-09에 두 차례 실제 장애 발생 (`cachedMemos`, `lastFilterSig`).
- 원칙: **모든 `let`/`const`는 `state.js`에 모아 파일 최상단에서 선언**.
- `const composerEditor = wireEditor(...)` 같은 "선언과 동시에 실행" 코드는 `state.js`에 두지 말고 `init.js`로 이동.
- 검증 방법: 분리 후 `npx esbuild --bundle` 결과물에서 `initCal();` / `load();` 호출보다 앞에 `let` 선언이 없는지 정규식으로 검사.

### 5.2 실행 순서
- 현재 init 실행 코드가 파일 중간(상대 959줄)에 있다. 분리 시 반드시 `init.js`로 이동하고 번들 마지막에 배치.
- `document.addEventListener('mousedown', ...)` (상대 1313줄, 툴바 팝업용)과 `$('q')` 검색 바인딩(상대 2768줄)도 `init.js`로 이동.
- 라이트박스 바인딩(상대 928~950줄)은 `lightbox.js` 하단에 두되, `state.js` 이후에 평가되도록 순서 보장.

### 5.3 암묵적 전역 의존
- 모든 함수가 전역 스코프를 공유한다고 가정하고 작성됨. ES 모듈로 전환 시 `import` 누락이 런타임 `ReferenceError`가 되므로, **번들(concat) 방식을 권장**.
- `window.marked`, `window.DOMPurify`, `window.lucide` (CDN 전역)에 의존. 번들에 포함하지 말고 외부 스크립트로 유지.

### 5.4 테스트 전략
1. 분리 전: 현재 `memo.html` 인라인 JS를 esbuild로 파싱해 기준 AST/함수 목록 스냅샷 저장.
2. 분리 후: 번들 결과물의 함수 목록이 기준과 일치하는지 diff.
3. Jest DOM 테스트: `load()` 렌더링 경로에 `renderRows`/`renderCards` 단위 테스트 추가 (현재 없음).
4. 브라우저 QA: 데스크톱 초기 로드(목록 표시), 모바일 초기 로드(카드 표시), 저장 후 즉시 반영.

### 5.5 헌법 관련 판단
- 번들 결과물(`memo.bundle.js`)은 자동생성 파일로 500줄 예외 적용.
- 소스 모듈 15개 모두 500줄 이하. `editor-toolbar.js`/`editor-core.js`는 450~460줄로 여유가 적으므로, 추후 팝업 UI 분리를 권장.
- `extractTags` 데드코드는 분리 과정에서 삭제.
- `updateMemoFiles`의 `📎` 이모지를 Lucide SVG로 교체 (디자인 원칙).

### 5.6 deploy_full.py 연동
- 현재 정적 파일 수동 등록 방식은 하위 폴더 자산을 자동 발견하지 못함 (2026-10-09 장애 원인 중 하나).
- `public/` 재귀 탐색 기반 manifest 자동 생성으로 일반화 필요.
- `public/js/memo/*.js` → esbuild 번들 → `memo.bundle.js` → 인라인 또는 정적 서빙 중 선택.
  - 인라인 유지 시: HTML 내 `<script>` 교체 지점에 번들 삽입.
  - 정적 서빙 시: `/js/memo.bundle.js` 등록 + 캐시 무효화 고려.

---

## 6. 예상 공수 및 순서

1. 데드코드 확정 (`extractTags`, `editComposerTitle`, `startEdit` 호출처 육안 확인) — 30분
2. 15개 모듈 파일로 물리적 분리 (복붙 + 섹션 재배치) — 2시간
3. `state.js`/`init.js` 경계 정리 + 번들 순서 확정 — 1시간
4. esbuild 번들 + deploy_full.py 연동 — 1시간
5. Jest 스냅샷 diff + DOM 테스트 추가 — 1.5시간
6. 브라우저 QA (데스크톱/모바일 초기 로드, 저장, 검색) — 1시간

**다음 에이전트에게**: 이 문서는 분석 전용이다. 실제 분리는 별도 작업으로 진행하고,
반드시 "한 모듈씩 분리 → 번들 → 테스트" 순서로 점진적으로 진행할 것. (2026-10-09의 빅뱅 분리 실패 교훈)
