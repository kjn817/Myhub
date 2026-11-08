# CSP script-src 실태 조사·전략·단계 적용 (2026-11-01)

GPT 재평가 보안 지적 ③에 대한 답: "보안 헤더를 보완했지만 script-src 정책까지
적용했다는 근거가 없다 — 헤더 보완을 XSS 방어 완료로 판단하면 안 된다."

결론부터: **XSS 방어는 완료되지 않았다.** 이번에 한 일은 (1) 전 페이지 실태를
수치로 확정하고, (2) 깨지지 않는다고 증거로 확인된 범위 — 데스크톱 셸 1페이지
전면 enforce + 전 페이지 object/base/form 지시자 — 만 적용한 것이다.
나머지 11개 페이지는 여전히 인라인 스크립트 실행을 브라우저 정책으로 막지
못한다. 그 페이지들의 XSS 방어는 현재 DOMPurify 정제·esc() 이스케이프 같은
코드 수준 방어에 의존한다 (CSP는 최후 방어선이지 유일 방어선이 아니다).

- 조사 기준: HEAD `18fefc4` + 조사 시점 작업 트리. 단, 병행 트랙 1의 미커밋
  변경(`public/backup.html`·`public/js/step-up.js`·`scripts/static-assets.json`)이
  backup 페이지 수치에 포함돼 있다 (외부 스크립트 +1, 인라인 블록 수 불변).
- 배포: 이 문서를 포함한 변경은 **미배포**다. 코디네이터가 묶음 배포를 판단한다.
  따라서 아래 "적용"은 코드 기준이며 라이브 반영은 NOT TESTED다.

## 1. 현재 CSP 설정 지점 (조사 시점 코드 기준)

CSP를 설정하는 곳은 정확히 한 곳이다: `src/index.ts`의 정적 에셋 핸들러
(`app.get('/*')`, ASSETS 바인딩 서빙). `src/index-inline.ts`는
`deploy_full.py`가 `src/index.ts`에서 생성하는 파일이라 별도 설정 지점이 아니다.

| 대상 | CSP (조사 시점) | 비고 |
|---|---|---|
| `/login.html` | `LOGIN_CSP` 전면 정책 (아래) | 메타 태그로도 동일 정책 중복 선언 |
| 그 외 HTML | `frame-ancestors 'self'` 단독 | 2026-10-31 트랙 3에서 정적 핸들러 전반으로 확대된 상태 |
| 비HTML 에셋 | 없음 (nosniff만) | |
| API 응답 (JSON 등) | 없음 (일부 라우트가 Cache-Control만) | 이번 범위 밖 — §6 참조 |

`LOGIN_CSP` = `default-src 'none'; script-src 'self' https://unpkg.com;
style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self';
manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`

이력: 원래 로그인 페이지만 인라인 라우트에서 엄격 CSP를 받았고, 2026-10-31에
`frame-ancestors`·`X-Content-Type-Options: nosniff`·`Referrer-Policy: same-origin`이
정적 핸들러 전반으로 확대됐다 (커밋 2420523, `tests/unit/security-headers.test.ts`).
즉 "script-src 근거 없음"이라는 지적은 정확했다: 로그인 외 페이지에는
script-src 자체가 없었다.

## 2. 실태 전수 수치

측정 방법: `scripts/static-assets.json`의 HTML 14개 = `public/*.html` 14개와
전수 일치함을 대조한 뒤, 정규식 기반 정적 집계 (인라인 블록은 src 없는
`<script>`의 내용 길이·sha256까지 산출). 속성형 핸들러는 정적 마크업
(스크립트 블록 제거 후)과 템플릿 문자열 내 형태를 분리해 셌다.

### 2.1 페이지별

| 페이지 | 인라인 script 블록 | 인라인 바이트 | 외부 script | 정적 마크업 핸들러 | `<style>` 블록 | style 속성 | innerHTML (페이지 내) |
|---|---:|---:|---:|---:|---:|---:|---:|
| agent.html | 1 | 77,914 | 6 | 21 | 1 | 31 | 52 |
| backup.html | 1 | 2,946 | 3 | 1 | 1 | 1 | 0 |
| briefing.html | 1 | 2,738 | 0 | 1 | 1 | 2 | 3 |
| chat.html | 1 | 1,131 | 6 | 0 | 0 | 4 | 0 |
| desktop.html | **0** | 0 | 5 | **0** | **0** | 1 | 0 |
| index.html | 1 | 11,648 | 1 | 0 | 1 | 5 | 8 |
| login.html | **0** | 0 | 2 | **0** | **0** | 0 | 0 |
| memo.html | 2 | 1,981 | 6 | 0 | 0 | 4 | 0 |
| memory.html | 1 | 3,854 | 2 | 6 | 1 | 5 | 3 |
| offline.html | 0 | 0 | 0 | 1 | 1 | 0 | 0 |
| schedule.html | 2 | 13,426 | 4 | 0 | 1 | 4 | 5 |
| search.html | 1 | 1,858 | 2 | 0 | 1 | 1 | 3 |
| todo.html | 2 | 13,754 | 3 | 0 | 1 | 1 | 2 |
| trace.html | 0 | 0 | 3 | 2 | 1 | 2 | 0 |
| **합계** | **13** | **131,250** | **43** | **32** | **9** | **61** | **76** |

### 2.2 핸들러의 두 종류 (CSP 판정이 다르다)

- **속성형 핸들러** (`onclick="..."` — 정적 마크업 + innerHTML 템플릿 문자열):
  HTML 파일 내 64곳 + 서빙 JS 템플릿 3곳 = **67곳**. CSP에 `'unsafe-inline'`이
  없으면 전부 차단된다. 페이지별로는 agent 49 (마크업 21 + 템플릿 28),
  memory 9, trace 3 (마크업 2 + trace.js 1), backup·briefing·offline·search 각 1,
  메모 번들 템플릿 2 (`onclick="window._deleteMemo(this)"`).
- **프로퍼티 할당** (`el.onclick = fn`): 서빙 JS 71곳 + 인라인 스크립트 17곳.
  외부 스크립트에서 프로퍼티로 거는 핸들러는 **CSP가 차단하지 않는다** —
  인벤토리에서 집행 방해 요인으로 세지 않는다.

### 2.3 동적 실행·주입 경로

| 패턴 | public/ 전체 | 비고 |
|---|---|---|
| `eval(` | 0 | |
| `new Function(` | 0 | 브라우저 코드 기준. 서버 측 `src/services/studio-workspace.ts`의 문법 검증용 1곳은 Worker 실행이라 CSP 범위 밖 |
| `document.write` | 0 | |
| `createElement('script')` | 0 | 동적 스크립트 태그 주입 없음 |
| `setAttribute('on…')` | 0 | |
| `innerHTML =` 할당 | 189곳 (인라인 76 + 서빙 JS 113) | CSP가 innerHTML 자체를 막지는 않는다. 단 innerHTML로 삽입된 속성형 핸들러·`<img onerror>` 등은 script-src가 있으면 차단되고, 삽입된 `<script>`는 원래 실행되지 않는다. XSS 싱크로서의 위험은 정책과 별개로 남는다 |
| iframe srcdoc 주입 | agent.html만 | 미리보기 iframe(`sandbox="allow-scripts"`)에 아티팩트 HTML + 검증용 콘솔 캡처 `<script>` 문자열을 srcdoc로 주입. srcdoc 문서는 부모 문서의 CSP를 상속하므로 **agent.html에 script-src를 걸면 아티팩트 미리보기(인라인 스크립트를 쓰는 단일 파일 앱)의 스크립트까지 막힐 수 있다** — 브라우저 실측은 NOT TESTED, agent enforce의 별도 블로커로 기록 |

### 2.4 외부 스크립트·스타일 출처

| 출처 | 사용처 | 버전 고정 | SRI |
|---|---|---|---|
| `https://unpkg.com` | lucide — 9개 페이지 | login만 `lucide@0.469.0` 고정, 나머지는 `lucide@latest` | login만 있음 |
| `https://cdnjs.cloudflare.com` | CodeMirror 5.65.2 (agent), marked 12.0.0·highlight.js 11.9.0 (chat), CodeMirror·highlight CSS | URL에 버전 고정 | 없음 |
| `https://cdn.jsdelivr.net` | DOMPurify (chat·memo), marked (memo) | 경로에 버전 없음 (`/npm/dompurify/dist/…`, `/npm/marked/…`) — 사실상 latest | 없음 |

script-src를 origin 단위로 열면 `@latest`·무버전 경로는 "그 origin이 내일
내려주는 임의 코드"까지 허용하게 된다. CSP 이전에 SRI·버전 고정이 선행돼야
한다는 뜻이다 (§6 다음 단계).

기타 런타임 출처 (전면 정책 설계 시 필요): 이미지 — 동일 출처 + Cloudinary
(`res.cloudinary.com`, API가 돌려주는 첨부·생성 이미지 URL), `data:`/`blob:`
(메모 에디터 붙여넣기). 연결 — 동일 출처 `/api/*` (전 페이지 fetch),
SW 등록은 schedule.html만 (`/sw.js`).

## 3. 전략 비교

### A. 해시 기반 (`script-src 'sha256-…'`)
- 실현 가능성: 인라인 블록 13개의 해시는 산출 완료 (조사 스크립트로 재현 가능).
  그러나 해시는 **인라인 블록만** 허용한다. 속성형 핸들러 67곳과 `<style>`
  블록 9개는 해시로 못 푼다 (핸들러는 별도 해시 문법이 있으나 innerHTML
  템플릿 내 핸들러는 대상이 아니다). 즉 해시만으로는 어떤 페이지도 enforce
  불가 — 핸들러 전수 추출이 선행 조건이다.
- 유지 비용: 인라인 블록을 한 글자만 고쳐도 해시가 바뀐다. CSP 상수는 Worker
  코드(`src/index.ts`)에 있고 인라인은 ASSETS로 따로 올라가므로, 수동 관리는
  "해시 갱신 누락 → 페이지 전체 사망" 사고와 직결된다. 자동화하려면
  `deploy_full.py`의 NODE_GEN 단계에서 스테이징된 HTML을 해시해 Worker
  소스에 주입하는 개조가 필요하다. 가장 큰 블록이 가장 자주 바뀌는
  agent.html(77,914B)이라 마찰이 최대인 페이지가 정확히 그 페이지다.
- 판정: **지금은 채택하지 않음.** 핸들러 추출이 끝난 페이지부터, 배포 자동화와
  함께 도입하는 것이 순서다.

### B. nonce 기반 (`script-src 'nonce-…'`)
- 실현 가능성: 정적 ASSETS 서빙이라 응답은 고정 파일이다. 요청별 nonce를
  넣으려면 Worker가 HTML 본문을 요청마다 다시 써야 한다 (문자열 치환 또는
  HTMLRewriter). HTML은 이미 `no-store`라 캐시 문제는 없지만, (1) ASSETS가
  준 본문을 Worker가 매 요청 가공하는 새 실패 지점이 생기고, (2) nonce도
  속성형 핸들러는 허용하지 못한다 — 핸들러 67곳은 nonce가 있어도 차단된다.
  (3) `deploy_full.py`의 `?v=` 버전 치환이 만든 스테이징 사본과 Worker 측
  재기록이 겹치면 디버깅 표면이 커진다.
- 판정: **채택하지 않음.** 비용은 해시보다 크고, 블로커(핸들러)는 그대로다.
  이 구조(정적 파일 + ASSETS)에서는 nonce의 이점이 발휘되지 않는다.

### C. `'unsafe-inline'` 유지 (= script-src를 아예 걸지 않음) + 다른 지시자 강화
- script-src에 `'unsafe-inline'`을 다는 것과 script-src를 안 다는 것은
  인라인 실행 관점에서 동등하다. 즉 현 상태는 이미 C이며, "CSP를 걸었다"고
  말할 수 있는 부분은 script 외 지시자뿐이다.
- 대신 안전하게 강화 가능한 지시자: 사용처 0건임을 전수 확인한
  `object-src 'none'`·`base-uri 'none'`·`form-action 'self'`
  (§2.3·인벤토리 테스트가 회귀를 잡는다). 효과는 실재하지만 범위가 좁다:
  플러그인 주입·`<base>` 하이재킹·폼 액션 탈취를 막을 뿐, 인라인 스크립트
  기반 XSS는 막지 못한다.
- 판정: **부분 채택** — 이번 단계 적용의 본체. 과장 없이 "script 외 표면만
  줄였다"고 기록한다.

### D. 페이지별 파일럿 enforce (인라인 없는 페이지만 전면 정책)
- 후보 판정: login은 이미 enforce 중. desktop은 인라인 0·핸들러 0·style
  블록 0으로 **유일하게 추가 가능한 페이지**. trace는 마크업 핸들러 2 +
  trace.js 템플릿 핸들러 1 + `<style>` 블록 1로 탈락, offline은 핸들러 1 +
  `<style>` 블록 1로 탈락 (둘 다 소규모 추출 후 후속 파일럿 가능).
- 판정: **desktop 채택** (§4).

## 4. 단계 적용 (이번 변경)

`src/index.ts` 정적 핸들러에 상수 2개를 추가했다.

1. **전 페이지 (login·desktop 제외) — 후보 C**:
   `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`
   (기존 `frame-ancestors 'self'`를 대체·확장. script-src는 걸지 않는다.)
2. **`/desktop.html` 파일럿 enforce — 후보 B(D)**:
   `default-src 'none'; script-src 'self' https://unpkg.com;
   script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline';
   img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self';
   manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none';
   frame-ancestors 'self'`
   - 근거: desktop.html + 로드 JS 4개(nav·desktop 3종) 속성형 핸들러 문자열
     0건, 인라인 블록 0, `<style>` 블록 0 (인벤토리 테스트로 고정).
   - `style-src-attr 'unsafe-inline'` 단 하나 남은 완화: 정적 style 속성
     1곳(헤더 로고 `<img style="height:26px;…">`) 때문이다. `<style>` 요소와
     외부 스타일은 `style-src-elem 'self'`로 막혀 있다. JS의
     `el.style.xxx =` 프로퍼티 대입은 원래 CSP 대상이 아니다.
   - `frame-src 'self'`: 모듈 페이지를 동일 출처 iframe으로 띄우는 셸 구조상 필수.
   - 창 안 페이지들은 각자 자기 헤더를 받으므로 파일럿의 영향을 받지 않는다.
3. **`/login.html`**: 변경 없음 (기존 전면 정책 유지).

### 적용하지 않은 것

- **후보 A (Report-Only)**: 적용하지 않았다. 수집 엔드포인트가 없으면 위반은
  사용자 브라우저 콘솔에만 남는데, 단일 사용자 시스템에서 콘솔을 상시 감시하는
  운영 루프가 없어 실효가 거의 없다. 더구나 알려진 위반(인라인 13+핸들러 67)이
  매 페이지뷰 쏟아져 콘솔 신호가 노이즈에 묻힌다. 자체 `/api` 수집 엔드포인트는
  브라우저 리포트가 인증 쿠키 없이 도착하는 특성상 무인증 POST 표면 +
  스팸성 쓰기 비용 설계가 먼저 필요해, 이번 범위를 넘는다 (§6).
- **전 페이지 enforce**: 근거 수치 그대로 불가. 인라인 블록 13개·속성형
  핸들러 67곳·`<style>` 블록 9개 중 하나라도 남으면 해당 페이지가 깨진다.
  agent는 srcdoc 상속 문제까지 겹친다.

## 5. 검증

- `tests/unit/security-headers.test.ts` 확장: 일반 페이지 지시자 집합 +
  script-src 부재(걸면 깨지는 성질), desktop 파일럿의 지시자·
  script 계열 `'unsafe-inline'`/`'unsafe-eval'` 부재를 앱 실물 fetch로 검증.
- `tests/unit/csp-inventory.test.ts` 신규: desktop 파일럿 전제(인라인 0 등)가
  깨지면 실패하는 카나리아, public/ 전체 eval·new Function·document.write·
  동적 script 주입·object/base/form 태그 0건, 인라인 잔존 페이지 목록 고정
  (전부 0이 되면 enforce 재검토 신호).
- 실행 결과 (2026-11-01 로컬): `tsc --noEmit` 통과. 대상 2스위트 11/11 PASS
  (security-headers 5 + csp-inventory 6). 관련 기존 스위트 회귀 없음:
  core-index·auth-low-fixes·static-assets 74/74 PASS.
- 카나리아: desktop.html에 인라인 `<script>`를 임시 추가하면 csp-inventory
  2건이 실패함을 확인하고 원복했다 (파일럿 전제가 깨지면 테스트가 잡는다).
- NOT TESTED: 라이브(미배포), 실제 브라우저에서의 desktop 렌더링·iframe 창
  열기·lucide 로드 (VM 제약으로 브라우저 E2E 불가 — 배포 후 코디네이터 QA 필요),
  srcdoc CSP 상속의 브라우저 실동작.

## 6. 남은 것·다음 단계

1. **핸들러·인라인 추출 (페이지 단위)**: trace (핸들러 3·style 블록 1) →
   offline (핸들러 1·style 1) → backup·briefing·search (각 인라인 1·핸들러 1)
   순으로 작게 끊어 외부 파일화하고, 끝난 페이지부터 파일럿 명단에 올린다.
   큰 페이지(chat·memo·schedule·todo·index·memory·agent)는 인라인 블록 자체가
   본체 로직이라 별도 작업 단위다.
2. **CDN 고정**: lucide `@latest`와 jsdelivr 무버전 경로를 버전 고정 + SRI로
   교체 (login이 이미 한 방식). script-src origin 허용의 전제 조건.
3. **수집 엔드포인트 설계 후 Report-Only**: 무인증 리포트 수신·요약 저장·
   남용 상한을 설계한 뒤, 추출이 끝난 페이지부터 report-only → enforce 순.
4. **agent srcdoc**: 미리보기 iframe의 CSP 상속 동작을 브라우저로 실측하고,
   필요하면 미리보기 전용 정책(예: 별도 경로 서빙)을 분리 설계한다.
5. **API 응답 헤더**: API JSON 응답에는 CSP가 없다. 클릭재킹·스니핑 관점에서는
   nosniff가 이미 전 에셋에 붙지만 API는 ASSETS 경로가 아니라 별도 확인이
   필요하다 (이번 범위 밖, 미조사로 남긴다).

## 부록: 인라인 블록 sha256 (해시 전략 검토용 실측)

| 페이지 | sha256 (base64) |
|---|---|
| agent.html | `1g8SHzwOylu6/EZRd0V1XohzCLSPHIoo6d70J6YOHaE=` |
| backup.html | `7ekASdbgoTVY8SPAI6gleGkT498tIJ9imL2veUO24IA=` |
| briefing.html | `HLDfL0FvTnv3haYtEm18xWjTNNn2C0vSo89XuIM1Tjw=` |
| chat.html | `SGuj1PPZE9/DsDrraVeM08apWLRhx1e6Zs8Lllh8/oY=` |
| index.html | `3zZh1pOg2UF9/gg7hHB1G4J2a6t4/W2deLfIlvY8Esc=` |
| memo.html (1) | `Oep0Jmoo3eRnide185ifs/NGNzdFwualgunFzD+rzg4=` |
| memo.html (2) | `MAimttMA1bX3cqcSRhB8pfi1LwYJLaqeqfhawMOCdHo=` |
| memory.html | `RVPkZiLkpNUFxiw51fv/JGJFseks//jLjD9sifm2QyI=` |
| schedule.html (1) | `msED7/kkr6qzCzWKLExS6jQcqO11hX7tlExpGOdbYtk=` |
| schedule.html (2) | `h3iW0dkXYRIkc4M0TAEawU8t5+xcEkShKQCWZoJiICk=` |
| search.html | `AJVOTl68eG58hTFG09aIq2foFkURwJYQ7itwo3vOgag=` |
| todo.html (1) | `TbjVEin/nqB5tQknv2o0hepxrHG5Og6NENr3Vzhsb4I=` |
| todo.html (2) | `YT2galTuRfUk2MVoUfBf0ZHSQkIfou4MNCLuMXDg6Po=` |

## 후기 — 배포·라이브 확인 (2026-11-01, 코디네이터)

본문의 "미배포" 표기는 이후 배포로 해소됐다. 트랙 1·5와 묶음 배포
(운영 4310f486, 이후 재확인 2eb40d35 — DEPLOY VERIFY PASS)에 본 문서의
CSP 변경(src/index.ts 3단 정책)이 포함됐고, 인증 세션으로 라이브
헤더를 직접 대조했다: /login.html → LOGIN_CSP 전문, /desktop.html →
DESKTOP_CSP 전문(script-src 'self' https://unpkg.com, script-src-attr
'none' 포함), /memo.html·/backup.html·/key-rotation.html →
GENERAL_HTML_CSP(object-src 'none' 등). 전 페이지 script-src enforce가
불가한 근거(인라인 블록·핸들러 실측)와 다음 단계는 본문 판정 그대로다.
