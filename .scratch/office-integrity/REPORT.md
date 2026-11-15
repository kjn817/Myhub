# MyHub 오피스 무결성 검증 보고서 (폰트 + 원본 문서 보존)

- 검증일: 2026-11-15 (16:01~17:00 KST경, 로컬 하네스 실브라우저)
- 작업 트리: HEAD 714ca76 + 미커밋 변경 (한글 로더 에이전트 작업 중)
- 범위: 한글(HWPX)·엑셀(XLSX)·파워포인트(PPTX)·PDF 4개 앱
- 방법: playwright-core + 로컬 하네스 실브라우저, axis-E(2026-11-05) 픽스처 재사용 + 합성 폰트 픽스처 신규 작성
- **본 보고서는 검증만 다룬다. 발견된 결함은 수정하지 않았다** (과제 제약).

## 요약 판정

| 영역 | 판정 | 근거 |
|---|---|---|
| 라운드트립 무결성 (4앱) | **PASS 33/33** | 저장본 바이트 대조 전수 통과 (verify-saved.py) |
| 폰트 렌더링 (풀 폰트) | **PASS** | Excel/PPT/HWPX/PDF 전부 글리프 정상, tofu 없음 |
| kordoc HWPX 파싱 | **P0 FAIL** | 로더 계약 불일치로 readText가 레거시 폴백 (마커 247→2) |
| 사용자 폰트 엔진 푸시 | **P1 FAIL (비결정적)** | whenReady 4초 캡 + 재시도 없음, 4회 중 3회 누락 |
| PDF image-54 하얀 글씨 재현 | **NOT TESTED** | 가용 폰트 4종 전부 음성, 실제 PDF 필요 |
| 저장 파괴성 | **리스크 (설계)** | 덮어쓰기 시 구 버전 즉시 소실, 버전 이력 없음 |
| HWP Studio 사용자 폰트 | **미지원 (설계)** | Drive 사용자 폰트가 Studio에 도달하는 경로 없음 |

## 1. P0 — kordoc 파싱 전면 중단 (로더 계약 불일치)

**현상**: HWPX `readText`가 kordoc 마크다운을 받지 못하고 레거시 폴백(문단 열거)으로 떨어진다.
`table.hwpx` 기준 마커 **247개 중 2개만** 추출, md 길이 15자 (2026-11-05 축 E 실측은 247/247, 8,917자).
표가 많은 한글 문서(당직일지·공문 양식)를 비서가 거의 빈 문서로 읽는 상태다.

**원인 확정**: 재빌드된 `public/vendor/kordoc/kordoc.js`는 ESM 번들
(`scripts/build-kordoc.mjs:110`, `format: 'esm'`, 진입점이 `export { markdownToHwpx, parse }`)이라
`window.__kordoc`을 설정하지 않는다. 그런데 로더 2곳이 import 반환값을 버리고 전역만 읽는다.

- `public/js/finder-viewer.js:264-266` — `loadLib('kordoc')` → `window.__kordoc` (undefined)
- `public/js/office-assistant.js:316-320` — 동일 패턴 (메모→공문서 `markdownToHwpx` 경로도 동일 결함)

**엔진 자체는 정상**: ESM 네임스페이스 직접 import 시 `parse` 존재, `table.hwpx` 파싱 성공
(md 8,917자·마커 247/247 — 11-05 실측과 동일). **로더 계약만 어긋났다.**
수정안: 로더가 import 반환 네임스페이스의 `parse`/`markdownToHwpx`를 쓰게 한다 (한 줄급).
이 결함을 잡는 jest 테스트가 없다 (kordoc 언급 테스트는 gate-23·perf4-cleanup뿐, 로딩 계약 미검증).

증거: `probe-kordoc.cjs`(전역 부재 확인), `probe-kordoc-ns.cjs`(네임스페이스 정상 확인), `out/kordoc.json`.

**연계**: E-1(표 셀 치환)은 현행 트리에서 해결 확인됨
(`finder-format-hwp.js:1444` `replace_text` + 사후 검증, 실측 applied 1)이나,
`readText`가 표를 못 읽는 상태에서는 비서가 치환 대상을 찾지 못할 수 있다.

## 2. P1 — 사용자 폰트 엔진 푸시 레이스 (비결정적 누락)

**현상**: Drive '폰트' 폴더의 사용자 폰트가 GridCraft/DeckCraft 엔진에 닿는지가 실행마다 갈린다.
동일 조건 4회 실행 중 **3회는 풀 10종만 푸시(사용자 폰트 누락), 1회만 11종 푸시(사용자 폰트 포함)**.
누락된 세션에서는 엔진이 사용자 폰트를 끝까지 받지 못한다 (재시도 없음).

**원인 확정**:
- `public/js/sheet-gridcraft.js:714-730` `pushFonts()`와 `public/js/finder-deckcraft.js:527-565`의
  `driveFaces()`가 둘 다 `fonts.whenReady(4000)`으로 사용자 폰트 로딩을 최대 4초만 기다린다.
- `public/js/fonts.js:259-275` `whenReady`는 타임아웃 시 당시 `state.result`(미완료면 null)로 resolve한다.
- `load()`는 Drive LIST ×2 + 폰트 바이트 fetch + `FontFace.load()` 체인이라 하네스 환경에서 5~12초 소요
  (133KB 소형 폰트도 동일 — 폰트 크기가 병목이 아님, 엔진 부팅과의 CPU 경합 + 체인 자체가 느림).
- 타임아웃이 이기면 `faces()`가 빈 배열이 되어 풀만 푸시되고, `pushFonts()`는 엔진 ready 시 1회만 호출되어
  나중에 로딩이 끝나도 다시 보내지 않는다.
- 대조 실증: `probe-font-timing.cjs` — faces()가 6.7초에 채워진 실행에서는 푸시에 사용자 폰트 포함(순서 1번,
  사용자 우선 설계 확인), 5.1초 시점에도 빈 실행에서는 풀만 푸시.

**영향**: 폰트 드롭다운에는 사용자 폰트가 뜨고(FontFaceSet에는 등록됨) 셀에도 지정되지만,
엔진은 대체 폰트(나눔고딕/Inter)로 렌더링한다 — 조용한 불일치. 문서 바이트는 안 깨진다
(폰트 이름은 저장됨). 카페 와이파이처럼 Drive fetch가 느린 환경에서는 누락 확률이 더 높아진다.

**수정 방향(제안, 미수정)**: `whenReady` 타임아웃 후에도 로딩 완료 시점에 `pushFonts()`를 한 번 더 호출하거나,
타임아웃을 늘리고 엔진에 폰트 추가 푸시 메시지를 보내는 재시도 경로를 둔다.

증거: `probe-office-fonts.cjs`, `probe-font-timing.cjs`, `out/office-fonts-excel.json`·`out/office-fonts-ppt.json`.

## 3. 라운드트립 무결성 — 33/33 PASS

각 앱에서 실제 문서를 열고 → 편집하고 → 저장(Ctrl+S 캡처)하고 → 저장본 바이트를 대조했다.

| 앱 | 열기 | 편집 | 저장본 | 대조 |
|---|---|---|---|---|
| XLSX | 2,716ms | D3 1234→1500, applied 1, E3 재계산 1.5 | 5,983B (11-05와 동일) | 15/15 PASS |
| PPTX | 1,747ms | text.replace applied 1 (18.1s 소요) | 25,632B (11-05와 동일) | 7/7 PASS |
| HWPX | 4,008ms | 표 셀·본문 치환 applied 1씩 | 17,568B | 7/7 PASS |
| PDF | 3,084ms | 1페이지 90도 회전 applied 1 | 2,185B | 4/4 PASS |

대조 항목: XLSX(편집 반영·수식 4종·병합·채움·굵게·숫자형식·제2시트·원본값),
PPTX(슬라이드 수·크기·도형 수·편집 반영·구문 소멸),
HWPX(마커 245개=247−2치환·치환 반영 2건·구문 소멸 2건·표 3개·엔트리 손실 없음),
PDF(페이지 수·회전[90,0]·텍스트 레이어 보존).
HWPX 저장본은 원본 대비 `Preview/PrvImage.png` 1개가 추가될 뿐 손실 없음 (Studio export 정상 동작, 11-05 저장본과 엔트리 집합 동일).

증거: `probe-roundtrip.cjs`, `verify-saved.py`, `out/roundtrip-*.json`, `out/saved.*`.

**참고**: 구 save-bridge 하네스는 현행 트리에서 동작 안 함 (`myhub:engine-ready` → `myhub:office-ready`로 변경,
`public/js/office.js:907`). 본 검증은 Finder 표면 + 세션 API 방식과 office.html 직접 방식을 썼다.
E-5(DeckCraft 네이티브 포맷 오저장)는 해결 확인됨 — `finder-deckcraft.js:52-111` `sniffDeckFormat` +
`finder-format-slide.js:1012-1045` `onSave`가 바이트 형식을 검사해 불일치 시 저장 거부.

## 4. 폰트 렌더링 — PASS (풀 폰트 기준)

폰트 픽스처(나눔고딕·맑은 고딕·함초롬돋움 셀/문단 포함)를 실브라우저로 열어 스크린샷 + 글리프 분석기로 검증했다.

| 앱 | 결과 | 비고 |
|---|---|---|
| Excel | PASS, 글리프 21개 중 의심 0 | 나눔고딕 Bold 렌더 확인(리본에 NanumGothic 16pt·Bold 표시). 맑은 고딕·함초롬돋움은 대체 폰트로 정상 렌더, tofu 없음 |
| PPT | PASS, 글리프 49개 중 의심 1건(오탐) | 제목·본문·숫자 전부 선명. 의심 1건은 '문' 글자의 ㅁ(자연스러운 속 빈 사각형)을 분석기가 오탐 — 확대 확인 결과 획이 온전히 채워짐 |
| HWPX Studio | PASS, 글리프 38개 중 의심 0 | 제목·본문 3문단 전부 정상. Studio 번들 폰트(36종 WOFF2·22.6MB) 사용 |
| PDF | PASS (4종 폰트 전부) | 아래 5절 참조 |

- 폰트 풀 푸시 확인: `gridcraft:fonts`·`deckcraft:fonts` 메시지에 POOL_FACES 10종 전부 포함
  (Inter 5·JetBrains Mono·Dancing Script·BIZ UDPGothic·NanumGothic 400/700).
- 풀에 없는 폰트(맑은 고딕·함초롬돋움/바탕)는 대체 폰트로 렌더링되며 깨지지 않는다.
- 분석기 한계: 작은 글리프(20px급)에서 ㅁ·ㅇ·ㅂ·ㅍ 같은 자연 속 빈 자소를 오탐할 수 있다.
  image-54 결함 서명(상단 10~15% fill 누락 + 가로 절단 경계)과는 구분된다 — 의심 건은 반드시 확대 육안 확인.

증거: `probe-office-fonts.cjs`, `make-fixtures.py`, `fixtures/font-*`,
`shots/office-font-{excel,ppt,hangul}.png` (+ crop·suspect 확대본), `out/office-fonts-*.json`.

## 5. PDF image-54 하얀 글씨 — 재현 불가 (NOT TESTED, 실제 파일 필요)

- 결함 서명 정밀 규명: 글자 상단 끝(~10~15%)에 흰 사각형이 있고 테두리만 남음 (fill 누락 + stroke 잔존).
  분석기 v3로 image-54는 17/21 글리프 의심 판정, 기존 양호 샷은 전부 OK — 판별기 검증됨.
- 재현 시도 전부 음성: 나눔고딕 Bold/Regular 임베드(TTF) × dsf 1/2, Noto Sans CJK KR Bold(CFF) × dsf 1/2,
  맑은 고딕 비임베드(Type0/CIDFontType2, pdf.js 대체 폰트 렌더링) 전부 OK.
- **실제 문서 폰트 가설은 가용 폰트로는 재현 불가 — 실제 PDF 파일 없이는 NOT TESTED로 남는다.**
- 부수 발견 (pdf-lib 함정): `PDFDict.withContext(ctx, map)`·`PDFArray.withContext(ctx, [...])`는
  2번째 인자를 무시하고 빈 컨테이너를 만든다 — `.set()`/`.push()`로 채워야 한다.
  이 때문에 첫 비임베드 테스트 PDF는 DescendantFonts가 비어 pdf.js가 빈 렌더를 냈다.

증거: `probe-pdf-glyph.cjs`, `probe-pdf-noto-rerun.cjs`, `probe-pdf-p2-rerun.cjs`, `probe-pdf-p2-diag.cjs`,
`analyze-glyph.py`, `fixtures/font-pdf.pdf`·`fixtures/noto-pdf.pdf`, `shots/pdf-*.png`,
`pdf-glyph-manifest.json`. 테스트 PDF 생성기: `~/workspace/pdf-test-scratch/make-font-pdf.mjs`·`make-noto-pdf.mjs`.

## 6. 저장 파괴성 — 리스크 (설계 확인)

`src/modules/drive/routes.ts` PUT `/files/:id/content`: 새 바이트 업로드 → D1 `storage_key` 교체 →
**구 스토리지 즉시 `storageDestroy`** (구 버전 소실). 백업·버전 이력·버전용 휴지통 없음.
낙관적 동시성만 존재 (`base_version` 검사 + `UPDATE... WHERE storage_key = ?` 원자적 교체, 409 CONFLICT).
저장 크기 상한 10MB. **결함 있는 export가 저장되면 원본 복구 불가** — 본 검증의 라운드트립이
전수 PASS인 상태에서는 잠재 리스크이나, export 경로 결함(P0 kordoc 같은)이 저장 경로와 결합하면
실질 피해로 이어질 수 있다.

## 7. HWP Studio 사용자 폰트 — 미지원 (설계)

- Studio는 자체 번들 폰트 36종(`public/rhwp-studio/fonts/`, 22.6MB WOFF2)을 쓴다.
  저작권 폰트(함초롬돋움/바탕·HY·MS 폰트)는 Git 미포함이며 FONTS.md에 폴백 대체가 문서화돼 있다
  (함초롬돋움 → Pretendard 또는 시스템 산세리프).
- 호스트(`finder-format-hwp.js`)는 Studio에 폰트를 푸시하지 않는다. 유일한 폰트 코드는
  뷰어 렌더 게이트 `fontsReady()` (`whenReady(2500)`, 2.5초 캡)뿐이며, 뷰어는 DOM 기반이라
  늦게 로딩된 폰트가 자동 적용된다(자가 치유).
- `fonts/user/` 슬롯은 함초롬 WOFF2 수동 배치 전용이고 2026-11-02 실측에서 NOT VERIFIED.
- **결론: "사용자 폰트 우선"은 Excel/PPT 엔진에만 적용되는 설계이며(2절 레이스 포함),
  HWP Studio 에디터에는 Drive 사용자 폰트가 닿지 않는다.** 문서에 사용자 폰트가 지정돼 있어도
  Studio는 번들 폴백으로 렌더링한다. 문서 바이트는 보존된다(폰트 이름 유지).

## 8. 알려진 잔존과 대조

- **Excel '값 입력' i18n**: gridcraft WASM에 '값 입력' 문자열 없음(MISSING 확인). 다른 한국어 UI 문자열은
  전부 존재. JS 번들에는 한국어 문자열 자체가 없음(카탈로그는 WASM 내장). **무결성 영향 없음**
  (UI 라벨 누락일 뿐, 문서 바이트와 무관). 어느 UI에 떠야 하는지는 미확인.
- **kordoc 재빌드 바이트**: 1절 P0 결함이 곧 이것 — 재빌드 번들 자체는 동작하나 로더 계약 불일치로 미사용 상태.

## 9. 관찰 사항 (결함 아님)

- **gridcraft 루트 404 3건**: 하네스에서 `gridcraft-web-*.js`·`snippets/.../inline0.js`·`gridcraft-web-*_bg.wasm`이
  서버 루트에서 404를 냈다. 엔진은 정상 부팅·동작하므로 하네스 경로 매핑 문제로 보이며 제품 결함으로 단정하지 않는다.
  다만 운영 ASSETS 서빙 경로와 대조해 볼 가치는 있다.
- **PPT 편집 18.1초**: roundtrip PPT `text.replace`가 18.1초 소요 (동작은 함). 성능 이슈로 별도 트랙에서 볼 것.
- **분석기 ㅁ 오탐**: 4절 참조 — 작은 글리프의 자연 속 빈 자소를 오탐한다. 의심 건은 확대 육안 확인 필수.

## 10. 증거 파일 일람 (전부 `.scratch/office-integrity/` 아래)

- 프로브: `probe-roundtrip.cjs`, `probe-office-fonts.cjs`, `probe-font-timing.cjs`,
  `probe-kordoc.cjs`, `probe-kordoc-ns.cjs`, `probe-pdf-glyph.cjs`, `probe-pdf-noto-rerun.cjs`,
  `probe-pdf-p2-rerun.cjs`, `probe-pdf-p2-diag.cjs`
- 분석·대조: `analyze-glyph.py`, `verify-saved.py`, `make-fixtures.py`
- 픽스처: `fixtures/font-xlsx.xlsx`, `fixtures/font-pptx.pptx`, `fixtures/font-hwpx.hwpx`,
  `fixtures/font-pdf.pdf`, `fixtures/noto-pdf.pdf`, `fixtures/TestUserFont-small.ttf`
- 결과: `out/*.json`, `out/saved.{xlsx,pptx,hwpx,pdf}`, `shots/*.png`, `pdf-glyph-manifest.json`
- axis-E 픽스처 재사용: `~/workspace/analysis2-20261105/axis-e/fixtures/` (roundtrip.xlsx/pptx, table.hwpx, form.pdf)

## 11. 수정 제안 요약 (우선순위순, 미수정)

1. **P0 kordoc 로더**: `finder-viewer.js:264-266`·`office-assistant.js:316-320`이 import 반환 네임스페이스를 쓰게 한다.
   로딩 계약 jest 테스트를 추가한다 (ESM 번들이 전역을 설정하지 않는다는 성질을 핀다).
2. **P1 사용자 폰트 푸시**: `whenReady` 타임아웃 후 로딩 완료 시 `pushFonts()` 재호출, 또는 타임아웃 상향 +
   엔진에 폰트 추가 푸시. Excel·PPT·HWP 뷰어 3곳 모두 같은 패턴(`whenReady(4000/4000/2500)`)이라 공용 수정이 바람직하다.
3. **리스크 완화(장기)**: 저장 시 구 버전 보존(버전 이력 또는 휴지통) — P0 같은 export 결함과 결합 시 원본 소실을 막는다.
4. **HWP Studio 사용자 폰트**: Drive 사용자 폰트를 Studio에 전달하는 경로가 필요하면 별도 설계가 필요하다
   (현재는 번들 폰트만). 사용자 폰트 우선 원칙의 적용 범위를 명시할 것.
