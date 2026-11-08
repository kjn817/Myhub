# FC 전환·마커 엔진 퇴출 계획 (P2 트랙 3)

- 작성일: 2026-10-29
- 기준 커밋: `bdc3f1d` (브랜치 `fix/unlock-block-remove-ciphertext`)
- 성격: **조사·계획 문서 only.** 이 문서는 코드 변경을 포함하지 않으며, 아래 단계들은 각각 별도 승인·별도 트랙으로 실행한다.
- 조사 방법: 기준 커밋 소스의 정적 실측 (파일·줄 수·분기 위치·플래그 이름은 전부 코드에서 직접 확인). 운영 D1 조회·실모델 호출은 하지 않았다 — 운영 설정값이 필요한 항목은 §6에 "미확인"으로 명시한다.
- 배경: GPT 외부 평가가 "레거시 마커 엔진 + Function Calling(FC) 엔진 이중 공존"을 유지보수·회귀 테스트 비용의 기술 부채로 지적했다. 본 문서는 그 공존의 실측 규모를 확정하고, 전환 완료 판정 기준과 퇴출 순서를 정의한다.

---

## 1. 현황 실측

### 1.1 엔진은 "두 개"가 아니라 사실상 세 갈래다

조사 결과, 도구 실행 경로는 셋으로 갈라져 있다. 전환 계획은 이 셋을 구분하지 않으면 잘못된 대상을 퇴출시키게 된다.

| ID | 엔진 | 진입점 | 도달 조건 | 상태 |
|---|---|---|---|---|
| E1 | 레거시 마커 엔진 | `processToolMarkers()` (`src/modules/ai/routes.ts:184–943`, 약 759줄) + `callSingleAssistant()` 안의 `[SEARCH:]` 2차 호출 (`routes.ts:1266–1367`) | 모든 비서의 모든 운영 요청이 최종적으로 통과 | **운영 주력** |
| E2 | 운영 내장 FC | `aiChat()` 내부 FC 루프 (`src/services/ai.ts:786–990` 부근, 약 200줄) | `policy.personaId === 'keeper'` **이고** 모델 프로바이더가 `workers-ai` 또는 `nvidia`일 때만 (`ai.ts:795`의 `useFC` 게이트) | **운영 중 (에코 한정)** |
| E3 | 파일럿 Registry FC | `chatWithFunctionCalling()` (`src/ai/function-calling-route.ts`, 291줄) | 아래 §1.4의 4중 게이트를 전부 통과할 때만 | **운영 도달 불가 (스테이징 전용)** |

보조 사실:

- E2에는 순수 네이티브 FC만 있는 것이 아니다. 네이티브 `tool_calls`가 비어 있으면 모델 출력 텍스트에서 임베디드 JSON 도구 호출을 파싱하는 폴백(`extractEmbeddedToolCalls`, `src/ai/memo-fc-tools.ts:302`)을 탄다. 즉 E2 내부에도 텍스트 파싱 경로가 하나 더 숨어 있다.
- AI 스튜디오(`src/services/studio-agent.ts`, 666줄)는 별도의 네이티브 FC(`STUDIO_TOOLS`, `src/services/studio-tools.ts`)를 이미 사용 중이며 채팅 엔진 공존 문제와 무관하다. 이 계획의 퇴출 대상이 아니다.
- MCP 서버(`src/modules/mcp/`)의 도구는 읽기 전용 별도 경로로, 이 계획의 대상이 아니다.

### 1.2 비서별 프로바이더 핀 (단일 진실 원천 확인)

- 핀의 단일 원천은 `src/services/expert-registry.ts`의 `EXPERTS`이고, `src/services/provider-registry.ts`의 `PERSONA_PROVIDER_PIN`은 그 파생 뷰, `src/modules/ai/routes.ts:1021`의 `policy.providerPin = resolvePersonaProvider(personaId)`가 소비 지점이다. (`routes.ts`에 `PERSONA_PROVIDER`라는 이름의 상수는 현 커밋에 존재하지 않는다 — 과거 이름이다.)

| 비서 | ID | 핀 프로바이더 | 근거 |
|---|---|---|---|
| 루미 | concierge | gemini | expert-registry `provider: 'gemini'` |
| 에코 | keeper | nvidia | expert-registry `provider: 'nvidia'` |
| 노바 | builder | gemini | expert-registry `provider: 'gemini'` |
| 캘리 | scheduler | groq | expert-registry `provider: 'groq'` |

프로바이더 간 폴백은 없다 (핀 강제). 이 사실이 FC 전환의 핵심 제약이다: **비서별 FC 가능 여부는 그 비서의 핀 프로바이더가 네이티브 FC를 지원하는지로 결정된다.**

### 1.3 비서 × 도구 엔진 적용 상태

마커 허용 목록의 서버 측 단일 정의는 `src/ai/legacy-privacy-guard.ts`의 `LEGACY_MARKER_TOOLS`이며, 실행 시점 강제는 `processToolMarkers`의 `authorizeTool()`(위험 기반 승인 게이트 포함)가 담당한다.

| 비서 | E1 마커로 실행되는 도구 | E2/E3 FC로 실행되는 도구 | 운영 실태 |
|---|---|---|---|
| 루미 (concierge, gemini) | 25종 전부: MEMO_SEARCH/GET/CREATE/UPDATE/DELETE, SCHEDULE_CREATE/LIST/UPDATE/DELETE, TODO_ADD/LIST/DONE/UPDATE/DELETE, CRON_CREATE/LIST/DELETE/TOGGLE, SEARCH, IMG, GITHUB, GMAIL_SEARCH/GET, GCAL_LIST/CREATE | 없음. E3 파일럿 대상이 루미이지만 §1.4 게이트 때문에 운영에서는 도달 불가. 레거시 `callGemini()`(`ai.ts:229`)에는 `tools` 파라미터 자체가 없어 E2 방식으로도 FC를 켤 수 없다 | **마커 100%** |
| 에코 (keeper, nvidia) | MEMO_* 5종, SEARCH, CRON_* 4종이 허용 목록에 남아 있고, `callSingleAssistant`는 aiChat 반환 후에도 `processToolMarkers`를 **무조건** 실행한다 (`routes.ts:1370`) | 메모 6종(`memo_create`, `memo_create_from_source`, `memo_search`, `memo_get`, `memo_delete`, `memo_ui_action`) + 자동화 4종(`cron_create`, `cron_list`, `cron_set_enabled`, `cron_delete`). 단, 스킬 매칭에서 도구가 없는 스킬(뉴스 등)이 선택되면 그 턴은 `fcTools`가 비어 마커 경로가 처리한다 (`ai.ts:791–796` 주석·코드) | **혼합**: FC가 주 경로이나 마커 후처리가 상시 병존. FC 결과 텍스트에 마커가 섞이면 마커도 실행될 수 있는 구조 |
| 노바 (builder, gemini) | SEARCH, GITHUB, IMG, ARTIFACT_CREATE/DELETE/FROM_GITHUB + 마커 없이 HTML을 출력하면 서버가 자동 감지해 초안 저장하는 별도 폴백 (`routes.ts:1379–1408`, `detectHtmlFromResponse`) | 없음 (루미와 같은 이유 — Gemini 레거시 호출에 tools 미전달) | **마커 100%** + HTML 자동감지 폴백 |
| 캘리 (scheduler, groq) | SCHEDULE_* 4종, TODO_* 5종, CRON_* 4종, SEARCH, GMAIL_SEARCH/GET, GCAL_LIST/CREATE | 없음. 레거시 `callGroq()`(`ai.ts:328`)는 `tools`를 받지 않으며, 코드 주석에 "Function calling은 안정성 확인 후 재활성화 (현재 기본 채팅만)"이라고 명시돼 있다 | **마커 100%** |

### 1.4 플래그 인벤토리 (이름·기본값·위치)

| 플래그 | 저장 위치 | 기본값/미설정 시 | 효과 범위 |
|---|---|---|---|
| `ai.engine` | D1 `ai_settings` | 값 없으면 legacy (`function-calling-route.ts:64`, 엄격 문자열 비교) | E3 진입 조건 중 하나. **E2(에코 FC)와는 무관** — 이름만 보면 전체 엔진 스위치로 오해하기 쉽다 |
| `ai.fc_test_approved` | D1 `ai_settings` | `'true'`가 아니면 E3 차단 (`function-calling-route.ts:69`) | E3 전용 |
| (환경 게이트) `ENVIRONMENT === 'staging'` | Worker env | 스테이징이 아니면 E3 무조건 차단 (`function-calling-route.ts:52–56`) | E3 전용. 운영에서는 나머지 플래그와 무관하게 도달 불가 |
| 파일럿 비서 상수 `PILOT_ASSISTANTS = ['concierge']` | 코드 상수 (`function-calling-route.ts:37`) | — | E3 대상은 루미만 |
| 파일럿 도구 상수 `PILOT_TOOLS = ['search_memo']` | 코드 상수 (`function-calling-route.ts:40`) | — | E3 도구는 `search_memo` 1종만 (레지스트리 등록도 이것만) |
| `ai.fc_provider` / `ai.fc_model` / `ai.fc_test_mock_error` / `ai.fc_test_no_tools` | D1 `ai_settings` | 미설정 시 비활성 | 전부 E3의 스테이징 내부 테스트용 오버라이드·오류 주입 |
| `ai.prompt_v2`, `ai.prompt_v2.<personaId>` | D1 `ai_settings` | `false` (fail-closed, `src/ai/prompt-integration.ts:40,54`) | **엔진 플래그가 아니다.** 프롬프트 합성 방식만 바꾼다. 단 v2 프롬프트에는 마커 지시가 없고, keeper에서는 서버 주도 메모 사전 검색(`routes.ts:1141`)이 붙는 등 엔진 거동과 간접 결합이 있다 |
| `CLEF_ROUTER_ENABLED` | Worker env | `false` (`routes.ts:1780`) | 비서 라우팅용. 엔진 전환과 무관 |
| `ai.emergency_disable` | D1 `ai_settings` | 미설정 시 전 비서 활성 (`routes.ts:1690`) | 비서 단위 긴급 차단. 퇴출 단계의 롤백 수단 후보 (§4) |

주목할 점: **E2(운영 에코 FC)에는 끄는 플래그가 없다.** `useFC`는 코드 게이트(`personaId` + 프로바이더)뿐이라, 에코 FC에 문제가 생기면 플래그 원복이 아니라 코드 수정·재배포가 필요하다. 퇴출 계획 §4의 단계 설계에서 이 비대칭을 해소해야 한다.

### 1.5 도구별 FC 등가물 존재 여부

| 도구군 | 마커 (E1) | FC 등가물 | 비고 |
|---|---|---|---|
| 메모 검색/조회 | MEMO_SEARCH, MEMO_GET | ✅ `memo_search`, `memo_get` (E2). 별도로 E3 레지스트리의 `search_memo`(`src/ai/tools/search-memo.ts`)도 같은 기능 — **같은 기능에 이름이 두 개** 존재 | 이름 통일 필요 |
| 메모 생성 | MEMO_CREATE | ✅ `memo_create`, `memo_create_from_source` (E2) | FC 쪽이 원문 보존형(`from_source`)까지 있어 상위 호환 |
| 메모 수정 | MEMO_UPDATE | ❌ 없음 | 의도적 부재: `memo-fc-tools.ts` 머리 주석 — "수정/꾸미기는 UI가 직접 처리 (LLM 경유하지 않음)". 퇴출 시 "등가물 불요"를 명시 결정으로 남겨야 함 |
| 메모 삭제 | MEMO_DELETE | ✅ `memo_delete` (E2, 확인 단계 반환) | |
| 메모 UI 동작 | (없음) | ✅ `memo_ui_action` (E2 전용) | 마커에는 없음. FC가 앞선 영역 |
| 자동화 | CRON_CREATE/LIST/DELETE/TOGGLE | ✅ `cron_create/list/set_enabled/delete` (E2) | TOGGLE ↔ set_enabled로 대응 |
| 일정 | SCHEDULE_CREATE/LIST/UPDATE/DELETE | ❌ 없음 | 캘리·루미 주력 도구인데 FC 전무 — 전환 최대 작업량 |
| 할일 | TODO_ADD/LIST/DONE/UPDATE/DELETE | ❌ 없음 (`src/ai/tools/test-todo-add.ts`의 `test_todo_add`는 테스트 전용 스캐폴드) | |
| 웹검색 | SEARCH (+ `callSingleAssistant`의 2차 호출·뉴스 소스 체인 포함) | ❌ 없음 | 단순 도구 1개가 아니라 "검색 → 결과 주입 → 2차 생성" 파이프라인 전체가 마커에 결합돼 있어 등가 설계가 가장 까다롭다 |
| 이미지 | IMG | ❌ 없음 | 실행이 아니라 프론트 렌더링용 수집(`routes.ts:396`)이라 FC 도구로 옮길지 자체가 설계 결정 |
| GitHub 검색 | GITHUB | ❌ 없음 | |
| Google | GMAIL_SEARCH/GET, GCAL_LIST/CREATE | ❌ 없음 | 쓰기(GCAL_CREATE)는 Google 쓰기 게이트와 연동 — FC화 시 승인 정책 재결합 필요 |
| 아티팩트 | ARTIFACT_CREATE/DELETE/FROM_GITHUB | ❌ 없음 | 노바는 마커 외에 HTML 자동감지 폴백까지 있어 3중 경로 |
| 비서 간 호출 | ASK (`[ASK:persona]…[/ASK]`, `routes.ts:355`, 최대 2단계) | ❌ 없음 | 도구가 아니라 오케스트레이션 메커니즘 — FC 도구로 만들지, 서버 라우팅으로 흡수할지 결정 필요 |

### 1.6 엔진 구성 요소 (파일·줄 수, 기준 커밋 실측)

**E1 마커 전용 (퇴출 시 제거 후보)**

| 파일 | 줄 수 | 비고 |
|---|---|---|
| `src/modules/ai/routes.ts`의 `processToolMarkers` | 약 759 (184–943) | 파싱→권한→승인→실행→치환이 한 함수에 집합. 파일 전체는 2,318줄 |
| `src/services/memo-tools.ts`의 `parse*` 함수 5종 | (파일 217 중 파서 부분) | `execute*`는 E2 디스패처가 재사용 — **파일째 삭제 불가** |
| `src/services/schedule-tools.ts`의 `parseScheduleMarkers` | (파일 252 중 파서 부분) | `execute*`는 유지 대상 |
| `src/services/todo-tools.ts`의 `parseTodoMarkers` | (파일 216 중 파서 부분) |〃 |
| `src/services/cron-tools.ts`의 `parse*` 4종 | (파일 213 중 파서 부분) | `dispatchCronToolCall`은 E2가 재사용 |
| `src/services/google-tools.ts`의 `parseGoogleMarkers` | (파일 224 중 파서 부분) | `execute*`는 유지 대상 |
| `src/services/artifact-tools.ts`의 `parseArtifactMarkers` | (파일 258 중 파서 부분) | `detectHtmlFromResponse` 등은 별도 판단 |
| `src/lib/search-marker.ts` | 45 | 비표준 검색 마커 정규화 (`normalizeSearchMarkers`) |
| `src/services/ai.ts`의 PERSONAS 시스템 프롬프트 내 마커 지시문 | 프롬프트 문자열 내 | 루미·노바·캘리 프롬프트가 마커 문법을 직접 가르친다. 에코 프롬프트만 "텍스트 마커를 출력하지 마"로 FC 전제 |
| `src/ai/legacy-privacy-guard.ts`의 `LEGACY_MARKER_TOOLS` | (파일 191 중 해당 부분) | 단, 같은 파일의 민감도 결정(`resolveRequestSensitivity` 등)은 엔진과 무관하게 유지 필요 — 분리 작업 선행 |

**E2 운영 FC**

| 파일 | 줄 수 |
|---|---|
| `src/ai/memo-fc-tools.ts` (도구 정의 6종 + 검증 + 임베디드 파싱 폴백) | 347 |
| `src/ai/cron-fc-tools.ts` (도구 정의 4종 + 검증) | 106 |
| `src/ai/memo-tool-dispatcher.ts` (검증→정책 가드→실행) | 499 |
| `src/services/ai.ts` 내부 FC 루프 (루프·피드백·`FC_FINAL_RULES`) | 약 200 |
| `src/services/skill-registry.ts`의 도구 선택 부분 (턴별 스킬→FC 도구 집합) | (파일 443 중 해당 부분) |

**E3 파일럿 Registry FC (`src/ai/` 합계 6,854줄 중 대부분)**

| 파일 | 줄 수 |
|---|---|
| `src/ai/function-calling-route.ts` | 291 |
| `src/ai/runner.ts` (AgentRunner — E3의 FallbackController 경유로만 사용) | 434 |
| `src/ai/fallback-controller.ts` | 508 |
| `src/ai/model-router.ts` (민감도·FC 검증 모델 목록 — 단, 민감도 정책은 E1/E2도 재사용) | 521 |
| `src/ai/tools/registry.ts` + `search-memo.ts` + `write-guard.ts` | 226 + 126 + 295 |
| `src/ai/providers/{gemini,groq,workers-ai}.ts` (어댑터 3종) | 302 + 255 + 284 |
| `src/ai/run-logger.ts` (`ai_runs` 기록 — E3 전용 관측) | 285 |
| `src/ai/types.ts`, `src/ai/fc-test.ts` | 276, 64 |

**공유 실행층 (어느 엔진이 이겨도 남는다)**

`src/services/memo-tools.ts`·`schedule-tools.ts`·`todo-tools.ts`·`cron-tools.ts`·`google-tools.ts`·`artifact-tools.ts`의 `execute*` 함수들. E2 디스패처는 이미 `executeMemo*`와 `dispatchCronToolCall`을 재사용 중이다. 즉 **비즈니스 로직은 이미 공유돼 있고, 이중인 것은 "모델 출력 → 도구 호출" 변환층(파싱/스키마)과 정책 강제 지점뿐**이다. 퇴출 범위를 이 변환층으로 한정하는 것이 이 계획의 기본 전제다.

**고아 레지스트리 (참고)**: `src/services/tools.ts`(38줄) + `src/services/tools-builtin.ts`(162줄)의 `registerTool` 레지스트리는 등록 호출(`registerBuiltinTools()`)이 `ai.ts:31–32`에서 주석 처리돼 있어 사실상 죽은 코드다. `GET /api/ai/tools`(`routes.ts:1959`)가 이 빈 레지스트리를 읽는다. 엔진 퇴출과 별개로 정리 후보이며, "도구 레지스트리가 또 하나 있다"는 혼란 요인이라 여기서 기록해 둔다.

---

## 2. 이중 공존 비용의 실측 근거

### 2.1 테스트 비용

측정 방법: 테스트 파일에서 마커 계열 심볼(`processToolMarkers`, `parseMemo|parseSchedule|parseTodo|parseCron|parseGoogle|parseArtifact`) 또는 FC 계열 심볼(`MEMO_FC_TOOLS`, `CRON_FC_TOOLS`, `dispatchToolCall`, `shouldUseFunctionCalling`, `chatWithFunctionCalling`, `ToolRegistry`, `FallbackController`)을 참조하는 파일을 셈. 전체 테스트 파일은 311개(`*.test.ts|js`, node_modules 제외).

| 구분 | 파일 수 | 대표 파일 |
|---|---|---|
| 마커 계열만 | 18 | `tests/unit/svc3-memo-tools.test.ts`, `svc3-schedule-tools`, `svc3-todo-tools`, `fastcheck-markers`, `ai-tools.test.js`, `tool-permission.test.js` 등 |
| FC 계열만 | 15 | `tests/unit/ai-memo-fc-tools.test.ts`, `ai-memo-tool-dispatcher`, `ai-function-calling-route`, `ai-fallback-controller`, `ai-runner`, `ai-tools-registry`, `tests/cron-fc-tools.test.ts` 등 |
| **양쪽 모두** | **2** | `tests/unit/ai-routes.test.ts`, `tests/unit/ai-routes-cov.test.ts` — 라우트 통합 테스트가 양 엔진을 동시에 커버해야 함 |
| 합계 (엔진 관련) | 35 | 전체 311개 중 약 11% |

여기에 루트 `phase1b~phase3c.test.js` 계열(Phase 1~3 파일럿 검증)이 E3를, `phase3d*.test.js`가 프롬프트 v2와 마커의 결합을 추가로 다룬다. 새 도구를 하나 추가하면 마커 파서 테스트와 FC 스키마 테스트를 각각 작성해야 하고, 권한 정책을 바꾸면 `ai-routes` 통합 테스트 양쪽이 깨지는 구조다.

### 2.2 분기 코드 위치 (엔진 선택이 갈라지는 지점)

1. `routes.ts:1655` — `/chat` 진입 시 `shouldUseFunctionCalling()` (E3 분기, 실패 시 조용히 legacy 진행).
2. `src/services/ai.ts:795` — `aiChat` 내부 `useFC` 게이트 (E2 분기, 플래그 없음).
3. `routes.ts:1370` — `callSingleAssistant`가 엔진과 무관하게 `processToolMarkers`를 후처리로 항상 실행 (E1 상시 병존).
4. `src/ai/prompt-integration.ts`의 `ComposeRequestOptions` — 프롬프트 합성이 `allowedTools`(FC)와 `legacyMarkerTools`(마커) 두 입력을 모두 받는 이중 인터페이스.
5. `src/services/skill-registry.ts` — 턴 의도→스킬→FC 도구 집합 결정이 에코 전용으로만 존재하고, 나머지 비서는 프롬프트 속 마커 지시가 같은 역할을 대신한다.

### 2.3 정책 강제가 두 곳에 있다

- E1: `processToolMarkers`의 `authorizeTool()` — 비서별 허용 목록 + 위험 기반 승인 게이트(읽기 허용/쓰기 승인/삭제·발송 필수 승인/잠금 거부) + dry-run 미리보기.
- E2: 디스패처의 `assertToolCallAllowed`(정책 가드, 잠금 거부)와 `preflightToolCalls`(스키마 검증), 삭제는 도구 자체의 확인 단계(`confirmation_required`).
- **두 경로의 승인 정책이 완전히 동등한지는 본 조사에서 확인하지 못했다** (§6). 동등성 보장 없이 한쪽을 퇴출시키면 승인 우회 또는 과잉 차단이 생긴다.

### 2.4 알려진 결함·제약 (기록 인용)

1. **에코 요약 도구 결과 전달 P0 (미해결로 기록됨)**: 프로젝트 상시 규칙에 "P0 에코 요약 도구 결과 전달(원인 후보 3가지 미확정 — requestId 추적 로그 확보 후 판별)"로 남아 있다. 코드에는 그 진단용 로그(`[echo.tool_execution]`, `[echo.response]`, `ai.ts:909, 965`)와, `ui_pending` 결과를 "열었습니다"로 단정하지 말라는 안전장치(`FC_FINAL_RULES`, `ai.ts:864` 부근 — 삭제 금지로 명시된 문구)가 공존한다. 이 결함은 E2의 "도구 결과 → 후속 호출 피드백" 구조에서 발생하며, 마커 경로에는 없는 종류의 결함이다.
2. **FC 게이트 누락 사고 이력**: `ai.ts:786` 주석 — "2026-10-26 P0 수정: keeper가 nvidia로 고정됐는데 useFC가 workers-ai만 허용해서 FC가 아예 안 켜졌음". 프로바이더 핀 변경과 FC 게이트가 별도 위치에 있어 생긴 공존형 결함.
3. **`dataChanged` 덮어씀 회귀**: `docs/GPT_REVIEW_62.md` — "FC 경로의 플래그가 마커 처리 코드에 의해 덮어씌워지던 버그 수정됨". §1.3의 "마커 후처리 상시 병존" 구조가 실제로 회귀를 만든 사례.
4. **마커 형식 흔들림 대응 패치 누적**: 모델이 `[WEB_SEARCH]{json}[/WEB_SEARCH]`, `[SEARCH]평문[/SEARCH]` 같은 비표준 형식을 출력할 때마다 정규화 코드가 쌓였다 (`routes.ts:432`, `search-marker.ts`, `callSingleAssistant`의 `normalizeSearchMarkers` 적용). 텍스트 문법 기반인 한 계속 쌓이는 종류의 비용.
5. **프로바이더별 FC 제약**: 캘리의 Groq는 FC가 "안정성 확인 후 재활성화" 상태로 꺼져 있고 (`ai.ts:329` 주석), 루미·노바의 Gemini 레거시 호출 경로는 `tools` 전달 자체가 없다. 반대로 E3 어댑터(`src/ai/providers/`)에는 Gemini·Groq 모두 FC 구현과 스테이징 검증 기록(`model-router.ts`의 `FC_VERIFIED_MODELS`: groq 모델 1종, `gemini-3.5-flash-lite`, 2026-10-10 staging-e2e)이 있으나, 이는 E3 전용 코드라 운영 경로와 연결돼 있지 않다.

---

## 3. FC 전환 완료 판정 기준

원칙: "전환 완료"는 선언이 아니라 아래 증거가 전부 모였을 때만 판정한다. 하나라도 비면 "부분 전환"으로 표기한다.

### 3.0 전제 — 관측 동등성 확보가 0번 기준이다

현재 구조화 실행 로그(`ai_runs`, 요청/실행 도구 수, 상태)는 E3 경로만 남긴다 (`run-logger.ts`). E1/E2 경로에는 엔진 식별자가 응답의 `engine: 'function_calling'`(E3 응답에만 존재) 외에 없고, 비서별·도구별 성공률을 뽑을 저장소가 없다. **따라서 현재 상태에서는 어떤 성공률 기준도 측정 자체가 불가능하다.** 전환 작업의 첫 단계는 기능이 아니라 관측이다 (§4 단계 0).

### 3.1 판정 기준표

| # | 기준 | 측정 방법 | 완료 조건 |
|---|---|---|---|
| C1 | 도구 등가성 | §1.5 표의 도구군별 대조 + 자동 테스트 | 마커 전용 도구 전부에 FC 등가물이 있거나, "등가물 불요" 결정이 문서로 남은 도구(MEMO_UPDATE 등)만 제외. 특히 일정·할일·웹검색 파이프라인·Google·아티팩트·ASK의 처리 방침이 전부 결정돼 있을 것 |
| C2 | 비서별 작업 성공률 | 평가셋: `src/ai/prompts/eval-cases.ts`의 비서당 10개·총 40개 케이스를 FC 경로로 실행하는 정기 평가 + §3.0 관측으로 집계한 실사용 성공률(도구 실행 성공/턴) | FC 성공률이 전환 전 마커 기준선(단계 0에서 2주 측정) 대비 비열등(하락폭 ≤ 사전에 정한 마진, 제안: 2%p)이고, 평가셋은 비서별 전 케이스 통과 또는 실패 케이스 전부에 원인 기록 |
| C3 | 핀 프로바이더 FC 실측 | 비서별 핀 모델로 네이티브 FC 실호출 검증 (스테이징 또는 일회용 격리 환경) | 4개 비서 전부에서 "도구 호출 → 실행 → 결과 피드백 → 최종 응답" 1왕복 성공 증거. 특히 Groq(캘리)는 현재 FC 비활성 사유("안정성")가 해소됐는지를 명시 판정 |
| C4 | 안전 동등성 | 카나리아 테스트: 잠긴 메모 조회 시도, 민감도 2 메모 외부 전송 시도, 승인 없는 삭제 시도, 메모 내용 속 심어진 도구 호출(인젝션) | FC 경로에서 전부 차단되고, 마커 경로의 현행 카나리아와 동일 결과. 승인 게이트 동등성(§2.3)이 테스트로 고정될 것 |
| C5 | 마커 잔존 0 | 단계 3의 마커 검출 로깅 (실행 없이 검출만) | 관측 기간(§4) 동안 전 비서 모델 출력에서 마커 패턴 검출 0건, 또는 검출돼도 사용자 영향 0 + 원인이 프롬프트 잔재로 특정돼 제거됨 |
| C6 | 회귀 없음 | 전체 Jest + tsc + runtime 테스트, 배포 후 라이브 QA (프로젝트 QA 규칙) | 기존 판정 기준 그대로 PASS. 엔진 관련 테스트 35개 파일이 FC 기준으로 재편돼도 총 검증 범위가 줄지 않을 것 |

### 3.2 측정 불가능하다고 명시하는 항목

- **응답 품질의 주관적 동등성** (말투·요약 품질이 마커 시절과 "같은 느낌"인지): 자동 측정 불가. eval-cases의 정성 채점 + 사용자 표본 확인으로 대체하되, 판정 근거에는 "표본 수동 평가"라고 명시한다.
- **장기 모델 드리프트** (프로바이더 모델 업데이트로 FC 호출 양식이 서서히 깨지는 현상): 사전 측정 불가. 전환 후에도 C2 평가셋 정기 실행을 상시 운영 항목으로 남기는 것으로 대응한다.
- **운영 트래픽 통계의 유의성**: 단일 사용자 시스템이라 표본이 작아 성공률 차이의 통계적 유의성 검정은 사실상 불가능하다. 백분율 기준(C2)은 절대 기준이 아니라 "기준선 대비 명백한 하락이 없는가"의 경보선으로만 쓴다.

---

## 4. 마커 경로 퇴출 단계 설계

각 단계는 전제 조건을 충족해야만 시작하고, 단계마다 롤백 지점을 가진다. 배포가 필요한 단계는 프로젝트 규칙대로 개발 → 테스트 완료 → 운영 직접 배포(`deploy_full.py production`) → 배포 후 QA 순서를 따른다. 아래 플래그 이름 중 신규 제안은 "제안"으로 표기한다 — 기존 플래그 재사용은 §1.4의 혼란(`ai.engine`이 E3 전용인 점) 때문에 피한다.

### 단계 0 — 관측 동등성 (기능 변경 없음)

- 내용: E1/E2 경로에도 엔진 식별자·도구 실행 결과(도구명, 성공 여부)를 구조화 로그로 남긴다. `ai_runs` 확장 또는 `ai_usage`에 엔진 컬럼 추가 중 택1 (마이그레이션이 필요하면 별도 승인).
- 관측 지표 확정: 비서별·도구별 실행 횟수/성공률, 승인 요청 건수, 마커 검출 건수.
- 전제: 없음 (읽기 전용 집계부터 시작 가능).
- 산출물: 마커 기준선 — 전 비서 2주간 도구 성공률 (C2의 비교 기준).
- 롤백: 로깅 추가의 제거 (기능 롤백 불요).

### 단계 1 — 도구 등가물 구현 (코드 작업, 별도 트랙들)

- 내용: §1.5의 ❌ 항목 — 일정·할일 FC 도구, 웹검색 파이프라인의 FC 설계(검색 도구 + 결과 주입 방식), Google 도구, 아티팩트 도구, ASK의 대체(서버 라우팅 또는 FC 도구)를 구현한다. E2 디스패처 패턴(정의→검증→정책 가드→공유 `execute*` 재사용)을 표준으로 한다.
- 함께 할 결정: `search_memo`(E3) vs `memo_search`(E2) 이름 통일, MEMO_UPDATE "등가물 불요" 명시 결정, IMG의 FC화 여부.
- 전제: 단계 0의 기준선 확보. 승인 게이트 동등성 설계(§2.3)가 이 단계에 포함돼야 한다.
- 롤백: 신규 도구는 기존 경로에 영향이 없으므로 커밋 단위 revert로 충분.

### 단계 2 — 비서별 FC 기본화 (플래그 신설 제안)

- 내용: 비서별 엔진 플래그(제안: `ai.engine_v2.<personaId>` = `fc|marker`, D1 `ai_settings`, 기본값 marker)를 신설하고, E2 게이트와 E3 게이트를 이 플래그 아래로 통합한다. 순서 제안과 근거:
  1. **에코**: 이미 FC 주력. 플래그로 끌 수 있게 만드는 것(§1.4 비대칭 해소)이 목적이며 거동 변화 최소.
  2. **캘리**: 도구군이 일정·할일로 좁고 평가셋이 있으나, Groq FC 안정성 판정(C3)이 선행 조건.
  3. **루미**: 도구 25종으로 가장 넓어 일정·할일·Google 등가가 전부 필요. 단 E3 파일럿의 `search_memo` 검증 자산을 재사용할 수 있다.
  4. **노바**: 아티팩트 HTML 자동감지 폴백까지 얽혀 있어 마지막.
- 전제: 해당 비서의 C1·C3·C4 충족.
- 롤백 지점: 플래그 1건 원복 (`marker`로 되돌리면 즉시 기존 경로). 이 단계까지는 코드 제거가 없어 롤백이 설정 변경으로 끝난다.

### 단계 3 — 마커 비활성화 (shadow 모드)

- 내용: 전 비서 FC 기본화가 끝나면, `processToolMarkers`를 "실행하지 않고 검출만 하는" shadow 모드로 전환한다 (제안 플래그: `ai.marker_mode` = `active|shadow|off`, 기본값 active). shadow에서는 마커 패턴을 검출해 로그만 남기고, 텍스트에서는 마커를 제거해 사용자에게 원문이 노출되지 않게 한다. `[SEARCH:]` 2차 호출도 같은 모드를 따른다.
- 관측 항목: 마커 검출 건수(비서별·도구별), FC 도구 성공률의 단계 0 기준선 대비 변화, 승인 요청 건수 변화, 오류율, 사용자 신고.
- 관측 기간 제안: 최소 2주 **그리고** 비서별 최소 100턴 (단일 사용자 트래픽이라 기간만으로는 표본 부족 가능 — §3.2의 한계 명시). 검출 0건이 아니면 기간을 연장하고 원인을 제거한 뒤 다시 센다.
- 전제: C2·C5의 측정 체계가 단계 0에서 동작 중일 것.
- 롤백 지점: `ai.marker_mode=active` 원복 한 번으로 마커 실행 복구.

### 단계 4 — 코드 제거 (파일·함수 단위 순서)

shadow 관측을 통과한 뒤에만 시작한다. 순서는 "프롬프트 → 후처리 → 파서 → 정책 분리" 순으로, 각 항을 개별 커밋으로 나눠 어느 지점에서든 revert 가능하게 한다.

1. PERSONAS 시스템 프롬프트에서 마커 지시문 제거 (`src/services/ai.ts`) — 모델이 마커를 배울 경로를 먼저 끊는다. 프롬프트 v2 합성 경로(`prompt-integration`)의 `legacyMarkerTools` 입력도 함께 정리.
2. `processToolMarkers` 본체와 `callSingleAssistant`의 `[SEARCH:]` 2차 호출 제거 (`src/modules/ai/routes.ts`) — 약 759줄 + 약 100줄.
3. 파서만 제거, 실행기는 유지: `parseMemo*` 5종, `parseScheduleMarkers`, `parseTodoMarkers`, `parseCron*` 4종, `parseGoogleMarkers`, `parseArtifactMarkers` (각 `src/services/*-tools.ts`). 같은 파일의 `execute*`는 FC 디스패처가 쓰므로 남긴다.
4. `src/lib/search-marker.ts` 제거 (정규화 대상이 사라짐).
5. `LEGACY_MARKER_TOOLS`를 민감도 판정 전용 구조로 축소·개명 (`src/ai/legacy-privacy-guard.ts`) — 민감도 결정 로직은 엔진과 무관하게 유지되므로, 도구 목록과 민감도 정책을 분리하는 것이 이 항의 본질이다.
6. E3 잔재 정리 여부 결정: E3가 단계 2에서 통합 엔진으로 흡수됐으면 `function-calling-route.ts`의 스테이징 게이트·테스트 오버라이드(`ai.fc_*`)를 제거하고, 흡수되지 않았으면 E3 자체의 존폐를 별도 결정한다. 어느 쪽이든 `ai.engine` 플래그는 마지막에 폐기한다 (이름 혼란의 원천).
7. (별개 정리) 고아 레지스트리 `src/services/tools.ts` + `tools-builtin.ts`와 빈 응답을 내는 `GET /api/ai/tools`의 존폐 결정.

- 전제: 단계 3 관측 통과 + C6 회귀 검증.
- 롤백 지점: 이 단계부터는 설정 롤백이 불가능하다. 커밋 단위 revert + 재배포가 롤백이며, 그래서 제거를 7개 커밋으로 쪼개는 것이다. 제거 완료 후 최소 1개 배포 주기는 직전 단계 코드를 git 이력에서 즉시 복구 가능한 상태로 둔다.

### 단계 요약

| 단계 | 내용 | 전제 | 롤백 |
|---|---|---|---|
| 0 | 관측 동등성 + 기준선 측정 | 없음 | 로깅 제거 |
| 1 | FC 등가 도구 구현 | 단계 0 | 커밋 revert |
| 2 | 비서별 FC 기본화 (에코→캘리→루미→노바) | 비서별 C1·C3·C4 | 플래그 원복 |
| 3 | 마커 shadow 모드 + 관측 | C2·C5 체계 동작 | 플래그 원복 |
| 4 | 코드 제거 (7개 커밋) | 단계 3 통과 + C6 | 커밋 revert + 재배포 |

---

## 5. 리스크 메모

- **승인 게이트 우회 위험**: 단계 2에서 FC 경로가 마커 경로의 위험 기반 승인(쓰기 승인·삭제 필수 승인·dry-run)을 완전히 재현하지 못하면, 전환 자체가 보안 회귀다. C4를 단계 2의 하드 게이트로 둔다.
- **검색 파이프라인 회귀 위험**: 뉴스 신선도는 `[SEARCH:]` 2차 호출과 소스 체인(네이버→RSS→Tavily→Exa), 날짜 하드 필터가 결합된 결과다. FC 도구로 단순 치환하면 신선도 검증 로직이 빠질 수 있다 — 단계 1의 웹검색 설계에서 이 결합을 명시적으로 재현해야 한다.
- **프로바이더 핀과의 충돌**: FC 전환은 핀 변경을 전제하지 않는다. 핀 모델이 FC를 못 하면(캘리/Groq 사례) 전환이 아니라 "핀 유지 + FC 안정화"가 먼저다. 핀 변경은 사용자 결정 사항으로 분리한다.
- **프롬프트 v2와의 결합**: v2 프롬프트는 이미 마커 지시가 없는 방향으로 설계돼 있으나 전 비서 기본값이 legacy 프롬프트다. 엔진 전환과 프롬프트 전환을 같은 단계에서 동시에 하면 회귀 원인 분리가 불가능해진다 — 단계 2는 프롬프트 버전을 고정한 채 엔진만 바꾼다.

---

## 6. 미확인 항목 (추측으로 채우지 않음)

| 항목 | 왜 미확인인가 | 확인 방법 |
|---|---|---|
| 운영 D1의 `ai.engine`, `ai.fc_test_approved`, `ai.prompt_v2*`, `ai.emergency_disable` 현재값 | 이 트랙은 D1 조회를 하지 않는 조건으로 조사함. 코드상 기본값만 확인했다 | 운영 D1 `ai_settings` 조회 (읽기 전용, 별도 승인) |
| 운영 Worker의 `ENVIRONMENT` 값 | 코드 게이트(`!== 'staging'`이면 E3 차단)만 확인. 운영이 staging이 아니라는 것은 운영 방식상 자명해 보이나 실측하지 않았다 | Worker 설정 확인 |
| 비서별·도구별 실사용 성공률 수치 | §3.0대로 현재 계측 자체가 없다 | 단계 0 실시 후 산출 |
| E2 디스패처와 E1 승인 게이트의 정책 동등성 | 코드 구조가 다르다는 것까지만 확인했고, 케이스별 대조 테스트는 수행하지 않았다 | 단계 1에서 동등성 테스트 작성 |
| E2 임베디드 JSON 폴백(`extractEmbeddedToolCalls`)의 실제 발동 빈도 | 로그 집계가 없어 코드 존재만 확인 | 단계 0 관측 항목에 추가 |
| GPT 외부 평가 원문에서 이중 엔진을 지적한 정확한 문구·위치 | 배경 설명으로 전달받은 사실이며, 평가 원문을 이 트랙에서 직접 대조하지 않았다 | `docs/GPT_REVIEW_*` 계열 대조 (참고: `docs/GPT_REVIEW_NOVA_ARTIFACT.md`에 "현재 노바는 legacy 마커 방식, 에코는 FC 사용 중"이라는 전제 문구는 확인됨) |

---

## 부록. 조사 근거 파일 목록

- 엔진 분기: `src/modules/ai/routes.ts` (2,318줄), `src/services/ai.ts` (1,384줄), `src/ai/function-calling-route.ts` (291줄)
- 도구 정의: `src/ai/memo-fc-tools.ts`, `src/ai/cron-fc-tools.ts`, `src/ai/tools/search-memo.ts`, `src/ai/legacy-privacy-guard.ts`
- 실행층: `src/ai/memo-tool-dispatcher.ts`, `src/services/{memo,schedule,todo,cron,google,artifact}-tools.ts`
- 정책·라우팅: `src/services/{expert-registry,provider-registry,skill-registry,tool-approval}.ts`, `src/ai/{model-router,prompt-integration}.ts`
- 평가셋: `src/ai/prompts/eval-cases.ts` (비서당 10개, 총 40개)
