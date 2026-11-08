# 대형 파일 분리 계획 (2026-10-29)

AGENTS.md 파일 길이 규칙(단일 파일 500줄 이하 원칙)에 대한 잔여 대상 목록과 파일별 분리 계획이다.
이번 트랙(P2 트랙 2)에서 `src/modules/ai/routes.ts` (2,318줄 → 11개 파일, 전부 500줄 이하) 분리를 완료했고,
이 문서는 나머지 파일들의 계획이다. 실제 분리는 각 파일의 담당 트랙에서 기준선(Jest·런타임·tsc·madge)
동일성을 검증하며 진행한다.

## 실측 범위

- 기준: 커밋 `bdc3f1d`, `git ls-files` 추적 파일 중 `.ts/.js/.html/.py`, `node_modules/` 제외.
- **`public/*.html` 포함** (정적 페이지도 인라인 `<script>` 300줄 이하 권장 규칙의 대상).
- 기준 시점 500줄 초과: **62개** = 소스 18개 + 테스트 39개 + 생성물 5개.
  routes.ts 분리 후 잔여: **61개** = 소스 17개 + 테스트 39개 + 생성물 5개.

## 소스 파일 (17개) — 파일별 계획

| 파일 | 줄 수 | 분리 계획 | 위험도 |
|---|---|---|---|
| `src/services/ai.ts` | 1,384 | ① 타입·페르소나 정의(후반부 Persona·모델 메타) → `ai-types.ts` 성격 파일 ② 키 풀·키 선택(allowlist·라운드로빈) → `key-pool.ts` ③ 설정 조회/저장·stripThinking 등 순수 헬퍼 분리 ④ `aiChat` 본체와 모델 선택(selectModel)은 본 파일 유지. 이번 트랙 대상 2였으나 보류 — 아래 사유 참조. | **높음** — madge 순환 7건 중 5건이 이 파일을 경유. 분리 시 순환 재배열·초기화 순서 문제 가능. 단독 트랙으로 신중히 진행할 것. |
| `public/agent.html` | 2,258 | 인라인 `<script>`를 기능 단위(채팅 전송·렌더링·음성·설정)로 `public/js/agent-*.js` 분리, HTML은 구조만 유지. | 중 — 분리 후 `scripts/static-assets.json` (ASSETS 업로드 집합) 갱신 필수. 누락 시 배포본에서 스크립트 404. |
| `src/modules/artifact/routes.ts` | 1,020 | 라우트 그룹 분리: 조회/CRUD ↔ 생성·GitHub 가져오기 ↔ 초안(drafts). `artifactApp`에 서브앱 마운트(이번 ai/routes.ts의 admin-routes 방식 재사용). | 중 — 라우트 등록 순서와 경로 충돌(`/:id` vs `/drafts`) 순서 보존 필요. |
| `public/js/chat.js` | 971 | 메시지 렌더링 / 전송·스트리밍 / 음성·첨부 / 설정 패널로 파일 분리 (번들러 없음 — 로드 순서 명시 필요). | 중 — 전역 함수 참조가 많으면 분리 경계에서 깨지기 쉬움. 사용처 grep 선행. |
| `src/modules/auth/routes.ts` | 838 | ① 해시·검증(PBKDF2 비밀번호/PIN, 상수) → `auth-crypto.ts` ② OTP 발송·세션 버전 → `auth-session.ts` 성격 분리 ③ 라우트(request/verify/pin-login 등)는 routes.ts 유지. 이미 상수·함수 응집도가 높아 경계가 명확함. | 중 — 보안 경계 코드. 테스트(auth-routes 1,194줄 등)가 풍부해 검증 가능. |
| `deploy_full.py` | 753 | **분리 보류 권장.** 업로드→승격→검증→롤백이 한 스크립트 안에서 순차 실행되는 것이 안전장치(시크릿 가드·자동 롤백)의 전제. 모듈로 쪼개면 상태 전달 실수 위험만 커짐. 길이는 감수. | 높음 (분리 자체가 위험) — 현상 유지. |
| `src/modules/memo/routes.ts` | 752 | 조회계(목록·통계·태그·캘린더) ↔ 쓰기계(생성·수정·삭제) ↔ 잠금/암호화 관련 라우트로 분리, 서브앱 마운트. | 중 — 잠금 경로는 fail-closed 검증 테스트와 함께 이동할 것. |
| `src/services/studio-agent.ts` | 666 | 실행 루프(에이전트 런타임) ↔ 도구 실행 ↔ 결과 검증/포맷으로 분리. | 중 — 상태 객체 공유 범위를 먼저 확정할 것. |
| `src/modules/artifact/job-processor.ts` | 665 | 잡 상태 기계(대기·실행·완료 전이) ↔ 생성 단계 실행으로 분리. | 중 — 비동기 경계에서 상태 전이 순서 보존. |
| `src/services/memory-service.ts` | 643 | 순수 함수군(fusionScore·decayTier·검색어 추출·FTS 쿼리 빌더)은 의존성 없는 헬퍼 파일로, D1 접근 함수(touchMemories 등)는 본 파일 유지. | 낮음 — 순수 함수 비중이 커 경계가 깨끗함. 우선 후보. |
| `src/lib/news-summary.ts` | 633 | 날짜·신선도 판정(윈도우·URL 날짜 추출) ↔ 소스 검증·병합(validate·dedupe·merge)으로 분리. 둘 다 순수 함수 중심. | 낮음 — 우선 후보. |
| `public/schedule.html` | 632 | 인라인 `<script>` → `public/js/schedule.js` 분리. | 낮음~중 — static-assets.json 갱신 필요. |
| `public/todo.html` | 619 | 인라인 `<script>` → `public/js/todo.js` 분리. | 낮음~중 — static-assets.json 갱신 필요. |
| `src/services/news-sources.ts` | 616 | 소스별 fetcher(네이버·press-rss·Google News RSS·Tavily·Exa)를 `news-sources/` 하위 파일로, 체인 오케스트레이션(타임아웃·폴백 순서)은 본 파일 유지. | 낮음 — fetcher 간 독립성이 높음. 우선 후보. |
| `src/services/fact-graph.ts` | 581 | 그래프 구축/적재 ↔ 조회·확산(related facts 탐색)으로 분리. | 중 — 중간 자료구조(byFact/byId 맵) 공유 방식 확정 필요. |
| `src/ai/model-router.ts` | 521 | 정책 테이블(정적 데이터) ↔ 라우팅 결정 로직으로 분리. 500줄 경계 근접이라 우선순위 낮음. | 중 — madge 순환 1건(`legacy-privacy-guard > model-router > services/ai`) 경유. |
| `src/ai/fallback-controller.ts` | 508 | 경계 근접(508줄). 분리 실익이 작아 후순위 — 자연 증가로 600줄을 넘으면 상태 기계 ↔ 폴백 체인 실행으로 분리. | 낮음 — 후순위. |

### 대상 2(`src/services/ai.ts`) 보류 사유

이번 트랙에서는 대상 1(routes.ts)의 검증에 집중하고 대상 2는 진행하지 않았다.
routes.ts 검증에서 상호 재귀([ASK:] 위임) 해소와 기준선 재측정 등 예상보다 큰 검증 비용이 들었고,
ai.ts는 순환 의존 7건 중 5건의 경유점이라 같은 순수 이동 방식이 그대로 적용되지 않는다
(키 풀·모델 선택·프로바이더 레지스트리의 초기화 순서가 얽혀 있음). 위 계획대로 단독 트랙에서
순환 구조를 먼저 정리한 뒤 분리하는 것이 안전하다.

## 테스트 파일 (39개) — 일괄 분리 비권장

500줄 초과 테스트 파일이 39개다 (최대: `tests/unit/ai-routes.test.ts` 3,508줄,
`tests/unit/coverage-final-cov.test.ts` 2,047줄, `tests/unit/svc4-ai.test.ts` 1,678줄 등).
테스트 파일은 프로덕션 코드와 달리 분리 실익이 작고, 잘못 나누면 mock 설정 중복·커버리지
집계 변화가 생긴다. 원칙:

- 분리 자체를 목적으로 나누지 않는다. 특정 describe 블록이 독립 실행 가치가 있을 때만 파일로 뗀다.
- 커버리지 보강용 파일(`*-cov.test.ts`)은 대상 소스 파일이 분리될 때 함께 재편한다.
- `editor.test.js` (726줄), `phase1d.test.js` (538줄) 등 루트 테스트도 같은 원칙.

## 생성물 (5개) — 분리 대상 아님

- `dist/index.js` (2,255줄) — 빌드 산출물.
- `public/js/memo-bundle.js` (3,000줄) — 번들 산출물. 원본 소스를 분리하면 자동으로 짧아진다.
- `coverage/lcov-report/*.html` 3개 (888·567·525줄) — 커버리지 리포트 산출물.

## 진행 순서 제안

1. 낮음 위험·순수 함수 중심: `news-sources.ts` → `news-summary.ts` → `memory-service.ts`
2. 정적 페이지 인라인 스크립트: `todo.html` → `schedule.html` → `agent.html` (static-assets.json 동시 갱신)
3. 모듈 라우트: `auth/routes.ts` → `memo/routes.ts` → `artifact/routes.ts`
4. 단독 트랙 (순환 정리 선행): `model-router.ts` → `services/ai.ts`
5. 보류 유지: `deploy_full.py`, `fallback-controller.ts`


## 후속 기록 — 트랙 D: ai.ts 분해 (2026-10-31)

기준: 브랜치 `fix/unlock-block-remove-ciphertext`, 분해 전 HEAD 2311455.

### 분해 결과 (순수 이동만 — 로직·시그니처·순서 변경 없음)

`src/services/ai.ts`: **1,863줄 → 835줄** (−1,028줄). 이동한 블록은 전부 re-export로
기존 import 경로(`services/ai`)를 유지한다. diff 순수성 검증: 구 ai.ts와
(신 ai.ts + 신규 파일 7개)의 비어 있지 않은 줄 집합을 대조해, 사라진 줄이
섹션 헤더 주석과 `export` 접두사가 붙은 동일 선언뿐임을 확인했다.

| 신규 파일 | 줄 수 | 책임 (이동 원본) |
|---|---|---|
| `src/services/ai-personas.ts` | 272 | Persona·PERSONAS·buildPeerContext·buildSystemPrompt |
| `src/services/ai-provider-calls.ts` | 277 | callGemini(+Direct/Relay)·callGroq·callNVIDIA·callWorkersAI·stripThinkingBlocks 등 |
| `src/services/ai-model-selection.ts` | 195 | getSetting·setSetting·GEMINI_CHAIN·selectModel |
| `src/services/ai-types.ts` | 122 | ChatMessage·TaskPolicy·AIResult·UsageEngine·UsageRecord·ModelDef |
| `src/services/ai-key-pool.ts` | 75 | KeyState·키 풀·모델별 키 allowlist·pickKey 계열 |
| `src/services/ai-fc-helpers.ts` | 71 | AI_CHAT_TOTAL_TIMEOUT_MS·buildFCFollowUpMessages·fcWriteSignature·FC_WRITE_TOOL_NAMES |
| `src/services/ai-models.ts` | 48 | MODELS 레지스트리 |

ai.ts에 남은 것: import·re-export 배선, logUsage, aiChat 본체(FC 루프 포함),
프로바이더 플러그인 등록, `__test`. **aiChat 본체는 더 쪼개지 않았다** — FC 루프를
빼려면 실행 컨텍스트(정책·키 상태·누적 결과)를 묶은 객체를 새로 설계해야 해서
"순수 이동" 범위를 벗어난다. 500줄 이하 도달은 aiChat 분해 설계가 별도로 필요하며,
다음 순서로는 ① logUsage → `ai-usage-log.ts` (약 56줄, 잎 이동 가능)
② FC 루프의 라운드 처리만 컨텍스트 타입을 도입해 추출 (동작 변경 위험 — 단독 트랙)
순을 권장한다.

### 순환 의존성 (madge --circular --extensions ts src)

- 분해 전: **9건**, 그중 8건이 ai.ts 경유. 단 대부분은 상대 모듈이
  `import type`으로 ai.ts의 타입만 참조하는 type-only 역방향 가장자리였고,
  실제 런타임 순환은 news-briefing의 동적 `import('./ai')` 1건뿐이었다.
- 조치: 타입을 잎 모듈(ai-types.ts)로 옮기고, type-only import 6곳을 진짜
  소유자로 재배선했다 (provider-registry·nvidia-memo-guard → ai-types,
  expert-registry·model-router·legacy-privacy-guard·ai/types → provider-registry).
  전부 타입 전용이라 런타임 동작 무변경.
- 분해 후: **7건**, ai.ts 경유는 동적 import 순환 1건
  (`ai.ts > memo-tool-dispatcher > cron-tools > cron-jobs > news-briefing > ai.ts`,
  기존재·지연 로딩이라 유지)만 남았다. 나머지는 type-only 삼각
  (provider-registry ↔ ai-types ↔ ai/types)과 ai.ts 무관 기존 순환
  (citation-lock/memory-service, run-logger/runner)이다.

### 검증

- tsc: 분해 전후 모두 PASS.
- Jest 전수: 분해 전 287 suites / 5,733 tests PASS → 분해 후 동일
  **287 suites / 5,733 tests PASS**. (중간 1회 실행에서 suite 5개가 테스트 실패
  0건으로 실행 중단된 환경 플레이크가 있었고, 재실행에서 전수 PASS로 확정.)
- 런타임(vitest/miniflare): **NOT TESTED** — workerd SQLite 쓰기 오류
  (SQLITE_IOERR_WRITE)로 환경이 차단됨. 코드 계층 도달 전 실패라 분해와 무관.

### 남은 500줄 초과 파일 (23개, 2026-10-31 실측 — src·public의 .ts/.js/.html)

| 파일 | 줄 수 |
|---|---|
| `public/js/memo-bundle.js` | 3,309 (생성물 — 원본 분리 시 자동 축소) |
| `public/agent.html` | 2,249 |
| `src/modules/artifact/routes.ts` | 1,083 |
| `src/modules/memo/routes.ts` | 1,014 |
| `public/js/chat.js` | 1,002 |
| `src/modules/auth/routes.ts` | 987 |
| `src/services/ai.ts` | 835 (본 트랙으로 1,863 → 835) |
| `src/modules/artifact/job-processor.ts` | 688 |
| `src/services/studio-agent.ts` | 673 |
| `src/services/memory-service.ts` | 643 |
| `src/lib/news-summary.ts` | 633 |
| `public/schedule.html` | 632 |
| `public/js/memo/pane.js` | 631 |
| `public/todo.html` | 619 |
| `src/services/news-sources.ts` | 616 |
| `src/services/approval-flow.ts` | 615 |
| `src/ai/memo-tool-dispatcher.ts` | 587 |
| `src/services/fact-graph.ts` | 581 |
| `src/modules/ai/assistant-call.ts` | 544 |
| `src/ai/model-router.ts` | 521 |
| `src/ai/fallback-controller.ts` | 516 |
| `public/js/memo/editor-core.js` | 505 |
| `public/js/memo/toolbar.js` | 501 |

권장 순서는 본문 "진행 순서 제안"을 유지하되, ai.ts 잔여분(835줄)은 위
①→② 순으로 별도 트랙에서 진행한다.
