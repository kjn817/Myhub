# MCP SDK v2 정합성 + Tasks POC — 2026-10-28

> 작성: 트렌드 1순위 적용 트랙 1 (MCP SDK v2 + Tasks POC)
> 브랜치: `apply-trends-1-mcp-tasks` (기준 1da3477, 미병합·미배포)
> 근거 문서 정정 포함: `docs/provider-research-20261028-track2.md` §1–3의 "SDK 2.4.0이 Tasks를
> 런타임으로 제공한다"는 함의는 틀렸다. 아래 §2 참조.

## 0. 범위와 검증 방법

- **스테이징 없음 (사용자 지시 2026-10-28)**: POC 검증은 격리 환경에서만 했다 — 로컬 miniflare
  (vitest), 로컬 SQLite(Jest), 일회용 로컬 `wrangler dev --local` + 로컬 D1. 운영 Worker·운영
  D1에는 손대지 않았고, 이번 작업에서 배포도 하지 않았다 (병합·배포는 별도 결정).
- 검증 방법: 패키지 소스 직접 읽기 + Node 스크래치 프로브 + 공식 클라이언트 2.4.0 라이브 호출 +
  Inspector CLI 2.12.0 라이브 호출 + raw HTTP(curl) + Jest/miniflare 테스트.
- 이전 문서 `docs/mcp-server-20261028.md`는 당시 시점 기록이라 그대로 두고, 이 문서는 별도
  정합성 기록이다.

## 1. 설치된 SDK (실측)

| 패키지 | 버전 | 라이선스 |
|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 | Apache-2.0 |
| `@modelcontextprotocol/client` | 2.4.0 | Apache-2.0 |
| `@modelcontextprotocol/core` | 2.4.0 | Apache-2.0 |
| zod | 4.6.7 | — |

`package.json`에는 server·client만 있고 `@modelcontextprotocol/ext-tasks`는 **없다**.
`server/dist/ext/`와 `core/dist/ext/`에는 `skills`만 있고 tasks 런타임이 없다.

## 2. SDK 2.4.0 정합성 확인 결과

### 2.1 프로토콜 버전 협상

- `core/internal`: `LATEST_PROTOCOL_VERSION = "2025-11-25"`,
  `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05",
  "2024-10-07"]`, `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"`.
- **2026-07-28은 legacy 협상 목록에 없다.** 2026-07-28은 별개의 "modern era"로, 요청마다
  `_meta` 봉투(protocolVersion, clientInfo, clientCapabilities)와
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 헤더로 협상한다.
  클라이언트 쪽에 별도 `SUPPORTED_MODERN_PROTOCOL_VERSIONS = ["2026-07-28"]`가 있다.
- `server/discover`는 서버가 `capabilities.extensions`에 넣은 확장을 그대로 광고한다 (실측:
  `supportedVersions: ["2026-07-28"]`, extensions 포함, `resultType: 'complete'`).
- `tools/list` 기본 응답은 `ttlMs: 0`, `cacheScope: 'private'`이다 (SDK가 채우는 기본값).
  서버가 per-operation 캐시 힌트를 줄 수는 있으나 (`ServerOptions`), 이번 작업의 결정
  항목은 아니다 (`ttlMs` 미적용은 기존 한계로 유지).

### 2.2 공식 클라이언트 2.4.0의 2026-07-28 지원

실측 (`client.getNegotiatedProtocolVersion()`):

| 모드 | 협상 결과 |
|---|---|
| 기본값 (`versionNegotiation: 'legacy'`, 생략) | `2025-11-25` — 평문 2025 시퀀스, probe 없음 |
| `'auto'` | `2026-07-28` — `server/discover` probe 후 modern |
| `{ pin: '2026-07-28' }` | `2026-07-28` |

modern 경로에서 클라이언트는 `_meta` 봉투 + 3개 헤더를 보낸다. `getServerCapabilities()`로
서버의 extensions 광고를 읽을 수 있다.

### 2.3 Tasks — SDK 2.4.0에는 런타임이 없다 (트랙2 문서 정정)

- core 스키마는 있다 (`TaskSchema`, `TaskStatus` working/input_required/completed/failed/
  cancelled, `CreateTaskResult`, `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`,
  `ServerTasksCapabilitySchema`, `ToolExecutionSchema{taskSupport: required|optional|forbidden}`).
  그러나 각 항목에 **"@deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept
  importable for interoperability only"** 주석이 있다.
- Typed 메서드 표면(`request()`, `setRequestHandler()`, `ctx.mcpReq.send()`)에 task
  메서드가 없다. 2026-era 코덱은 `execution.taskSupport`와 `capabilities.tasks`를 와이어에서
  삭제한다.
- **프로브 실측**: bare SDK 핸들러에 올바른 헤더·봉투로 `tasks/get`을 보내면
  **404 / -32601 "Method not found"** (Mcp-Name 누락 시 400 / -32020).
  `tools/call` 핸들러가 flat `CreateTaskResult`를 반환하면 SDK가 `resultType: 'task'`로
  그대로 통과시킨다 (단, SDK가 `content: []`를 자동 추가하는 quirk 있음).
- **2026-07-28 Tasks는 공식 확장 `io.modelcontextprotocol/tasks`** (SEP-2663,
  repo `modelcontextprotocol/ext-tasks`, 스키마 2026-07-28 Stable,
  패키지 `@modelcontextprotocol/ext-tasks`):
  - `Task{taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs: number|null,
    pollIntervalMs?}`, `CreateTaskResult = Result & Task & {resultType: "task"}` (flat).
  - `tasks/get {taskId}` → `GetTaskResult` (completed는 `result`, failed는 `error` 포함).
  - `tasks/update {taskId, inputResponses}` → 빈 complete, `tasks/cancel {taskId}` → 빈 complete.
  - 알림 메서드 `notifications/tasks`. **`tasks/list`, `tasks/result`는 없다.**
  - 확장 capability는 `capabilities.extensions` 안의 빈 객체 `{}`. 클라이언트는
    capabilities에 한 번 선언하고, 서버는 호출별 opt-in 없이 태스크 핸들을 반환할 수 있다.
    태스크는 응답 전에 내구성 있게 저장해야 한다.
- **공식 클라이언트 2.4.0은 태스크 핸들을 소비할 수 없다.** 확장을 선언하고 modern으로 협상해도
  `callTool`이 태스크를 반환하는 도구에서 `UNSUPPORTED_RESULT_TYPE`
  ("Unsupported result type 'task' for tools/call")으로 실패한다. HTTP 캡처로 클라이언트가
  `_meta`에 `clientCapabilities.extensions`를 보내는 것까지 확인했으므로, 문제는 선언이 아니라
  핸들 소비 런타임 부재다. (SDK 코드상 2026-07-28 피어에 레거시 tasks 메서드를 보내면
  `MethodNotSupportedByProtocolVersion` — 직접 트리거한 관찰은 아님.)

## 3. Tasks POC (아침 브리핑 1건)

### 3.1 설계 (단순하게 — 책임 원칙)

- 브리핑 내용: `src/modules/briefing/service.ts`로 분리한 `buildTodayBriefing(db, date?)`
  (오늘 KST 일정 + 미완료 할 일 top 10 + 잠기지 않은·민감도 <2 메모 5건 + `allow_ai_use=1`
  기억 5건). 기존 `GET /api/briefing/today`는 같은 함수를 쓰도록 위임만 바꿈.
- 새 도구 `briefing.generate` (5번째, read-only, 입력 `{date?: YYYY-MM-DD}`):
  클라이언트 envelope에 Tasks 확장 선언이 있으면 태스크 핸들 반환, 없으면 동기 브리핑 반환
  (폴백 — §2.3의 spec 동작과 일치).
- 태스크 저장: 마이그레이션 **0061** `mcp_tasks` 테이블
  (task_id PK, email, tool, status CHECK 5종, params/result/error JSON, ttl_ms 기본 600000,
  poll_interval_ms 기본 500, created_at/updated_at, 인덱스 (email, created_at DESC)).
  핸들 반환 전에 INSERT한다 (spec의 내구성 규칙).
- `src/modules/mcp/tasks.ts`의 `handleTasksRequest`가 SDK 앞단에서 가로챈다
  (`routes.ts`의 `tryHandleTasksRequest`, 인증 401 이후·SDK 핸들러 이전):
  게이트 — method가 `tasks/get|update|cancel` + `MCP-Protocol-Version: 2026-07-28` +
  `Mcp-Method` + `Mcp-Name` == taskId + `_meta.protocolVersion 2026-07-28`.
  게이트 미통과면 SDK로 넘겨 SDK가 자체 -32020/-32602를 낸다.
- **지연 완료 (lazy completion)**: 첫 `tasks/get` 폴링 시점에 브리핑을 계산해 완료로 기록한다
  (조건부 `UPDATE ... WHERE status='working'`). 진짜 백그라운드 실행(Queue/Cron)이 아니다.
  이 한계는 운영 도입 전제 조건(§5)에 적었다.
- `tasks/update`는 항상 -32602 "task is not awaiting input" (input_required 상태가 존재하지
  않으므로). `tasks/cancel`은 협조적 취소, 완료된 태스크도 빈 complete로 ack. 만료
  (`now - createdAt > ttl`) 시 행 삭제 후 -32602 "task expired". 타인 태스크·미존재 태스크는
  -32602 "task not found". 응답에는 `_meta` serverInfo(`myhub`/`0.1.0`)와
  `resultType: 'complete'`를 넣는다. `notifications/tasks`는 보내지 않는다 (spec-optional).
- 보안 경계: 기존 도구와 동일 — 잠긴 메모·민감도 2 제외, 이메일 단위 격리. 카나리아로 검증했다
  (아래).

### 3.2 검증 결과 (전부 통과)

| 검증 | 결과 |
|---|---|
| Jest 관련 5개 스위트 (`mcp-tasks`·`mcp-tools`·`mcp-tokens`·`news-briefing`·`news-briefing-cov`, `--roots=tests,src` — 아래 환경 주의 참조) | **63/63** — mcp-tasks 17, mcp-tools 17 (도구 5개로 갱신), mcp-tokens 8, news-briefing 9, news-briefing-cov 12 |
| vitest miniflare `tests/runtime/mcp-tasks.test.ts` | **14/14** — discover 광고, tools/list에 briefing.generate·`execution`/`taskSupport` 없음, 태스크 핸들 vs 동기, 폴링(잠긴 문구 없음), 미존재 -32602, 타인 격리, 취소, update -32602, Mcp-Name 누락 → SDK -32020, 미인증 401, 공식 클라이언트 auto → 2026-07-28 + `UNSUPPORTED_RESULT_TYPE` 핀, 기본 legacy → 2025-11-25 + 동기 결과, `GET /api/briefing/today` == MCP 동기 결과 |
| vitest miniflare MCP 2개 파일 | **43/43** (mcp-tasks 14 + mcp-server 29) |
| vitest miniflare 전체 (`tests/runtime` 6개 파일) | **78/78** |
| `npx tsc --noEmit` | 클린 |
| Inspector CLI 2.12.0 (wrangler dev --local, 일회용 로컬 D1) | tools/list --strict 통과(도구 5개), tools/call memo.search 실데이터, briefing.generate 동기 결과(레거시 기본 + modern) |
| raw HTTP (curl, wrangler dev --local) | tools/call → task 핸들 → tasks/get 폴링 → completed, counts 일치, 잠긴 문구 없음 |
| 카나리아 | service.ts 잠금 필터 제거 → 폴링 완료 테스트 실패 (복원). getTaskRow 이메일 검사 제거 → 타인 태스크 테스트 실패 (복원) |

- `tests/runtime/mcp-server.test.ts`는 도구 5개로 갱신했고, `tests/mcp-tools.test.ts`의
  "정확히 4개" 단언도 의도된 변경에 맞춰 5개로 갱신했다 (전부 읽기 전용·쓰기 도구 없음이라는
  성질은 그대로 유지). `tests/mcp-d1.ts` 주석의 마이그레이션 수 62→63.
- **환경 주의 (2026-10-28 최종 검증 중 발견)**: 이 VM은 쓰기 한도가 있다 — 대용량 단일 쓰기
  (~5MB haste map 직렬화 등)가 `EPERM: operation not permitted, write`로 실패하고,
  `/tmp` 파일은 호출 사이에 사라지며, 120초 대기 후 예산이 회복된다. 증상: Jest haste-map
  persist 실패 → 스위트 실행 실패. 원인은 코드가 아니라 환경이다. 우회: `--roots=tests,src`
  로 haste 크롤 범위를 줄이고 `--cacheDirectory`를 홈 아래 지속 경로로 지정한다. 또한
  worktree `node_modules`의 msw 의존성(`@mswjs/interceptors`, `strict-event-emitter`,
  `until-async`, `headers-polyfill`, `@open-draft/*`)이 rsync에서 빠져 있어
  news-briefing 테스트가 타입 오류로 실패한 적이 있다 — 메인 worktree에서 rsync로 채워
  해결했다 (메인에서는 9/9 통과로 대조 확인). 토큰·스크래치 파일은 `/tmp`가 아니라 worktree
  안에 두었다가 삭제했다.
- 런타임 테스트에 `vi.setConfig({hookTimeout: 60000})` 추가 — `beforeAll` 마이그레이션 적용이
  기본 10s hookTimeout을 넘는다.
- **Inspector 웹 UI 클릭 검증은 미수행** (서브에이전트에 라이브 브라우저 없음 — 부모/사용자 몫,
  기존 한계 유지).

## 4. 클라이언트별 지원 매트릭스

| 클라이언트 | 프로토콜 | tools/list·tools/call | briefing.generate | Tasks |
|---|---|---|---|---|
| 공식 SDK 클라이언트 2.4.0 (기본, legacy) | 2025-11-25 | 동작 (도구 5개) | 동기 결과 | 미선언 → 동기 폴백 (정상) |
| 공식 SDK 클라이언트 2.4.0 (auto / pin) | 2026-07-28 | 동작 | 선언 시 태스크 핸들 **반환은** 되나 `callTool`에서 `UNSUPPORTED_RESULT_TYPE` 실패 | **핸들 소비 불가** |
| Inspector CLI 2.12.0 (번들 client 2.3.1, ext-tasks 0.2.2 동봉) | legacy 기본 / `--protocol-era modern` | 동작, `--strict` 통과 | 동기 결과 (Tasks 미선언 → 폴백, spec 정상 동작) | CLI에 tasks 메서드·광고 플래그 없음 (help에 "task" 없음) |
| raw HTTP (curl 등) | 2026-07-28 봉투 | 동작 | 태스크 핸들 → tasks/get 폴링 → completed (실증) | **전 흐름 동작** |
| Claude Code (Tasks 베타 — 트랙2 문서 2차 출처 주장) | — | 미확인 | 미확인 | 미확인 |
| Claude Desktop / VS Code 확장 / Goose / Postman / MCPJam / Cursor 등 | — | 미확인 | 미확인 | 미확인 |

미확인 항목은 추측하지 않고 그대로 적는다. Inspector가 ext-tasks 0.2.2 패키지를 동봉하지만 CLI가
쓰지 않으므로 "Inspector가 Tasks를 지원한다"고 적지 않는다.

## 5. 운영 도입 전제 조건

1. **마이그레이션 0061을 운영 D1에 단독 적용** (0060과 같은 절차 — 지정 파일만 단독 적용,
   운영 DB 일괄 변경 금지 원칙 유지). 적용 전 Time Travel bookmark 확보 등 기존 운영 D1
   안전 규칙을 따른다.
2. **배포는 `deploy_full.py production` 한 줄** (이번 작업에서 배포 안 함 — 병합·배포 별도 결정).
   `keep_bindings` 포함 등 배포 스크립트 내장 가드가 그대로 적용된다.
3. **진짜 비동기 실행이 필요하면 Queue/Cron 연동이 선행**돼야 한다. 현재 POC는 폴링 시점 계산
   (lazy completion)이라 장시간 작업(스튜디오 생성 등)의 태스크로는 쓰면 안 된다. 짧은
   브리핑·조회성 도구에 한해 현 설계로도 동작한다.
4. **공식 클라이언트 2.4.0으로는 Tasks를 소비할 수 없다.** 운영에서 Tasks를 의존하려면
   ext-tasks 기반 클라이언트, raw HTTP 클라이언트, 또는 Claude Code 베타 같은 확인된
   클라이언트가 필요하다. SDK에 ext-tasks 런타임이 들어오는지 추적할 것.
5. **`tasks/update` / `input_required`**는 사람이 입력해야 하는 도구가 생길 때만 추가한다.
   지금은 필요 없다.
6. **`notifications/tasks`**는 spec-optional이라 폴링으로 충분하다. 필요 시 추가.
7. **`ttlMs` 캐시 힌트 결정은 별도 항목** (본 작업 범위 밖 — 기존 한계 유지).
8. **Inspector 웹 UI 클릭 검증**은 부모/사용자 몫으로 남는다.

## 6. 알려진 SDK quirk·주의점

- `tools/call`이 `CreateTaskResult`를 반환하면 SDK가 `content: []`를 자동 추가한다.
  (클라이언트가 `content`만 보는 레거시 경로에서 빈 결과로 보일 수 있음 — 동기 폴백이 있는
  이유이기도 하다.)
- 레거시 클라이언트는 태스크 핸들을 "성공"처럼 받지만 `resultType`이 벗겨져 빈 content의
  일반 결과로 보인다 (degraded). 폴백 설계가 이를 흡수한다.
- `_meta`에 `clientCapabilities`가 없으면 SDK가 봉투 단계에서 -32602를 먼저 낸다
  (tasks 게이트보다 앞선다 — 런타임 테스트 수정 과정에서 확인).
- `McpServer`에는 `registerCapabilities` 메서드가 없다. capabilities는 생성자 옵션으로 넣는다.
  도구 핸들러의 envelope은 `ctx.mcpReq.envelope`에서 읽는다 (키
  `io.modelcontextprotocol/clientCapabilities`, 타입은 `{}`라 캐스트 필요).
- `src/index-inline.ts`는 `src/index.ts`보다 오래된 사본이다 (`/api/mcp` allowlist 없음).
  Inspector 검증 때는 `wrangler.toml`의 `main`을 일시적으로 `src/index.ts`로 바꿔
  `wrangler dev --local`을 띄웠고, 검증 후 원복했다 (git diff 없음).

## 7. 변경 파일

- 신규: `migrations/0061_mcp_tasks.sql`, `src/modules/mcp/tasks.ts`,
  `src/modules/briefing/service.ts`, `tests/mcp-tasks.test.ts`,
  `tests/runtime/mcp-tasks.test.ts`
- 수정: `src/modules/mcp/tools.ts` (도구 5개), `src/modules/mcp/server.ts` (extensions 광고),
  `src/modules/mcp/routes.ts` (tasks 가로채기), `src/modules/briefing/routes.ts` (service 위임),
  `src/ai/types.ts` (`ExecutionContext.mcpTasksExtension?`), `tests/mcp-d1.ts`,
  `tests/runtime/mcp-server.test.ts`
- 삭제: 스크래치 프로브·Inspector 서버 스크립트·임시 토큰 전부 제거. worktree `node_modules`
  부족분은 메인 worktree에서 rsync로 채웠고(git 무시됨), `.bin` 심링크는 제거했다.

## 8. Claude Code 에이전트 루프 (벤더 클라이언트) 항목 종결 — 2026-10-31

> 이 절은 **종결(closure) 기록**이다. 실행 검증의 PASS 기록이 아니다.
> 실행하지 않은 것을 PASS로 적지 않는다 — 아래 구분을 그대로 유지한다.

### 8.1 증명된 것 (서버 측)

- 서버 측 MCP Tasks 상호운용은 공식 MCP SDK 클라이언트로 실증됐다
  (본 문서 §2~§4, 2026-10-28 작성분 + 2026-10-29 전수 실증 — 확정 전제로 사용,
  이 종결 작업에서 재검증하지 않았다).
  범위: 프로토콜 협상 (2026-07-28, `server/discover` modern 협상 포함),
  태스크 핸들 반환 (`briefing.generate`), `tasks/get` 폴링 → completed,
  `tasks/cancel`, Tasks 미선언 클라이언트에 대한 동기 폴백.
- 단, 그 실증에서 공식 SDK 클라이언트 2.4.0 자체는 태스크 핸들을 소비하지
  못했다 (§2.3·§4: `callTool`에서 `UNSUPPORTED_RESULT_TYPE`). 즉 증명된 것은
  "MyHub 서버가 스펙대로 핸들을 내고 폴링·취소에 답한다"까지이며,
  벤더 클라이언트의 소비 동작은 포함되지 않는다.

### 8.2 남은 것 (미실행 — PASS 아님)

- **벤더 클라이언트(Claude Code)가 MCP Tasks를 실제로 어떻게 구동하는가는
  실행으로 확인하지 못했다.** 이 VM 환경에는 `claude` CLI가 없고 Anthropic
  자격증명도 없어, 이쪽이 통제하는 어떤 환경에서도 실제 Claude Code
  클라이언트 실행은 불가능하다 (종결 시점 확정 사실).
- 따라서 §4 매트릭스의 Claude Code 행 "미확인"은, 실행 관점에서는 2026-10-31
  현재도 그대로다. 아래 §8.3은 공개 문서 대조이지 실행 확인이 아니다.

### 8.3 공개 자료 확인 결과 (확인일: 2026-10-31)

**Anthropic 공식 문서에서 직접 확인한 것**

- 출처: Claude Code 공식 문서 "Connect Claude Code to tools via MCP",
  절 "MCP tasks that run on the server"
  (`https://code.claude.com/docs/en/mcp`, 2026-10-31 열람).
  - Claude Code는 MCP tasks extension으로 서버가 돌리는 긴 작업을 지원한다:
    도구 호출은 서버가 작업을 수락하면 반환되고, Claude Code가
    `tasks/get`으로 상태를 폴링하며, 원격 서버의 태스크는 세션 종료 후에도
    계속되고 같은 세션을 resume하면 다시 추적한다.
  - 성립 조건 (전부 동시): 서버가 tasks 지원 + HTTP·stdio·claude.ai
    connector 서버가 프로토콜 리비전 **2026-07-28**로 연결
    (`MCP_SDK_GENERATION=v1`·legacy 협상은 제외) + 세션이 feature flag를
    가져옴 (Amazon Bedrock 같은 서드파티 프로바이더·telemetry/flag off는
    제외) + **v2.1.304 이상**에서 터미널 CLI·Agent SDK·GitHub Actions
    세션 (VS Code 확장·데스크톱 앱에는 없음) + 메인 대화에서의 호출
    (subagent 호출 제외) + one-shot `claude -p` 실행은 대상 아님.
  - 서버 구현자를 위한 계약도 같은 절에 명시돼 있다: 2026-07-28 연결에서
    각 요청은 `params._meta["io.modelcontextprotocol/clientCapabilities"]`의
    `extensions` 아래 `"io.modelcontextprotocol/tasks": {}`를 싣고,
    태스크 응답은 `resultType: "task"` + `taskId`(≤128 printable ASCII,
    공백 없음)·`status`·`createdAt`·`lastUpdatedAt`·`ttlMs`(null 허용)
    필수, `pollIntervalMs`는 250~30,000으로 clamp (없으면 2,000).
    `tasks/get` 응답은 `resultType: "complete"`를 요구하고,
    `input_required`는 `tasks/update`로 답하며 (`elicitation/create`는
    대화형 터미널 세션에서만), 정지는 `tasks/cancel`로 보낸다.
    **`tasks/result`·`tasks/list`·`notifications/tasks`는 쓰지 않는다.**
  - 문서 대조 소견 (실행 아님): 이 계약은 본 문서 §3의 MyHub 구현과
    방향이 일치한다 — 확장 선언 키, flat 태스크 핸들, `tasks/get|update|cancel`
    만 구현하고 `tasks/list|result`가 없으며 알림을 보내지 않는 점.
    MyHub의 `tasks/update`가 항상 -32602를 내는 것은 `input_required`
    상태가 없는 도구(`briefing.generate`)에서는 닿지 않는 경로다.
- 출처: Claude Code 공식 변경 로그
  (`https://code.claude.com/docs/en/changelog`, 2026-10-31 열람).
  v2.1.304 (2026-10-19) 항목 자체는 확인했으나, 펼쳐진 변경 로그 텍스트에서
  MCP Tasks 도입을 명시한 항목은 특정하지 못했다. 변경 로그만으로는
  이 기능의 도입 근거로 삼지 않는다.

**2차 출처가 전하는 것 (공식 문서 원문과 구분해서 기록)**

- 복수의 2차 출처가 "공식 문서 기준 public beta, v2.1.304 (2026-10-19)
  이상 필요"로 전하고, 2026-10-22 AGNTCon/MCPCon 키노트와
  2026-10-23 Anthropic 개발자 채널 발표를 출시 기록으로 든다:
  `https://pasqualepillitteri.it/en/news/26723/mcp-tasks-claude-code-long-jobs-run-in-background`,
  `https://upstash.com/blog/claude-code-mcp-tasks`,
  `https://forkast.news/claude-ships-mcp-tasks-and-elicitations-in-claude-code-durable-agent-workflows-narrow-launch/`,
  `https://www.orchestriai.com/blog/claude-code-mcp-tasks-long-running-tools-approvals`
  (전부 2026-10-31 검색으로 확인).
- 주의: 위 "public beta" 표기는 2차 출처들의 전언이다. §8.3에서 직접 열람한
  공식 MCP 문서 본문에서는 해당 절에 beta 표기를 확인하지 못했다 —
  beta 여부는 전언으로만 남기고, 공식 확인 범위는 "지원 사실과 조건·계약"까지로
  한정한다.

### 8.4 판정

> **MyHub 측 검증 완료로 종결 — 실클라이언트 확인은 Anthropic 로그인 환경이 생길 때의 참고 항목**

- 근거: 서버 측은 공식 SDK로 실증 완료 (§8.1), 벤더 클라이언트 측은
  공식 문서로 지원 사실·버전·조건·서버 계약이 확인돼 MyHub 구현과의
  문서 대조까지 마쳤다 (§8.3). 남은 것은 실행 환경 부재로 인한
  미실행 1건뿐이며, 그것은 MyHub 측 결함이나 미구현이 아니다.
- 이 종결은 "Claude Code 실행 PASS"가 아니다. Anthropic 로그인 환경
  (Claude Code v2.1.304 이상 + feature flag가 닿는 세션)이 생기면,
  참고 항목으로서 `briefing.generate`의 태스크 핸들 → 폴링 → 완료를
  실제 클라이언트로 1회 확인하면 된다. 그 전까지 이 항목을 미검증
  PASS로 승격하지 않는다.
