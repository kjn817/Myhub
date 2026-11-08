# 테스트 커버리지 측정 — 2026-10-28

> 측정 전용 문서. 커버리지 숫자를 높이기 위한 작업은 하지 않았다.
> 브랜치 `apply/test-coverage`, HEAD `1da3477` (네이버 HUB 이관 병합본).

## 1. 측정 조건

- **설정 위치**: `package.json`에는 coverage 설정이 없다. `jest.config.js`에 있음.
  - `collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index-inline.ts']`
  - `coverageReporters: ['text']`, 임계값(thresholds) 없음.
- **실행 명령**: `npx jest --coverage --coverageReporters=text --coverageReporters=json-summary`
  (리포터만 CLI로 추가 — `json-summary`는 기계 판독용. `json` 리포터를 쓰지 않아
  `coverage/coverage-final.json`은 갱신되지 않고 이전 실행 잔재가 남아 있다 — §5 참조.)
- **결과**: Test Suites 246/246 passed, Tests **5141/5141 passed**, 소요 **428.5초**.
- **범위**: Jest만 측정. Vitest 런타임 테스트(`tests/runtime/`, 64건)와 Playwright E2E는
  `testPathIgnorePatterns`로 Jest에서 제외되어 이 수치에 포함되지 않는다.

## 2. 전수 수치

| 지표 | 커버리지 | covered / total |
|---|---|---|
| Lines | **99.00%** | 11,542 / 11,658 |
| Statements | **98.66%** | 12,887 / 13,062 |
| Branches | **94.62%** | 8,822 / 9,323 |
| Functions | **99.06%** | 1,691 / 1,707 |

- 측정 파일 139개 중 라인 100%인 파일 **121개**, 브랜치 90% 미만인 파일 **18개**.
- 미커버 라인 116줄, 미커버 브랜치 501개, 미커버 함수 16개.
- 해석: 핵심 로직은 거의 전부 실행되지만, 브랜치가 라인보다 4.4%p 낮다.
  격차는 대부분 **방어적 폴백·catch·옵션 분기**에 집중되어 있다 (아래 §3).

## 3. 파일별 최약 10곳 (검증되지 않은 성질 포함)

순서는 브랜치 커버리지 오름차순. "미검증"은 Jest 기준이며, 일부는 런타임 테스트·Inspector·라이브 검증으로
별도 확인된 항목이다 (각 항목에 명시).

### 1. `src/modules/mcp/routes.ts` — 라인 15.06% · 브랜치 0% · 함수 0% (0/9)

최대 격차. 모듈 import 시 최상위문만 실행되고 **Jest에서 단 하나의 함수도 호출되지 않았다**.
미커버 라인 60–108, 116–141, 151–167, 175–181, 187–198.

검증되지 않은 성질 (Jest 기준):
- `POST /api/mcp` 인증 매핑: 세션 쿠키 vs Bearer 토큰 우선순위, 둘 다 실패 시 401,
  속도 제한 초과 시 429 (`isMcpAuthRateLimited`의 IP별 20회/시간·전역 100회/시간).
- 속도 제한 인프라 장애 시 인증을 막지 않고 401로 진행하는 best-effort catch.
- 토큰 관리 핸들러 전체: 발급 상한 초과 시 400, 잘못된 ID 시 400, 폐기 대상 없음 시 404,
  각 500 경로, 에러 응답에 토큰 값이 포함되지 않는 성질.
- SDK 핸들러 내부 오류 시 토큰·요청 본문을 로그에 남기지 않고 500을 돌려주는 성질.

단, MCP 경로는 Jest가 아니라 **런타임 테스트(vitest 64건 중 MCP 29건)·Inspector CLI·라이브 배포 검증**으로
확인된 영역이다 (2026-10-28 병합 기록). Jest 커버리지 0%는 "미검증"이 아니라 "검증 계층이 다름"을 뜻한다.
Jest로 봉투(envelope)까지 검증할지, 현행 계층 분리를 유지할지는 별도 결정 사항.

### 2. `src/services/trace-viewer.ts` — 라인 80.76% · 브랜치 53.26% · 함수 100%

미커버 라인 79–89, 99–105, 241. 미커버 브랜치 43개로 전수 2위.

검증되지 않은 성질:
- `auditStatus` 매핑표: `executed`/`preview_shown`→ok, `denied`→denied,
  `expired`/`blocked`→blocked, 그 외→ok (0057 적용 전 행의 action 유추 경로).
- `toolRunStatus` 매핑표: `success`→ok, `cached`→cached, `blocked`→blocked,
  `error`→error, 그 외→ok.
- 스팬 정렬 동률 처리: 종료 시각이 같을 때 LLM 스팬을 먼저 두는 tie-break (241행).

### 3. `src/lib/trace.ts` — 라인 79.16% · 브랜치 58.33% · 함수 100%

미커버 라인 30–36.

검증되지 않은 성질:
- `randomHexChars`의 폴백 경로: `crypto.getRandomValues`가 없을 때 `crypto.randomUUID`로
  대체하고, 둘 다 없을 때 `Math.random`으로 대체하는 성질. 주 경로(getRandomValues)만 실행된다.
  (Workers/Node에서는 주 경로만 타므로 실무 영향은 낮다.)

### 4. `src/modules/mcp/tools.ts` — 라인 97.87% · 브랜치 68.75% · 함수 100%

미커버 라인 106. 미커버 브랜치 10개.

검증되지 않은 성질:
- `memo.search` 트라이그램 폴백의 `catch → { matches: [] }`: FTS 조회 중 DB 오류가 발생하면
  예외를 던지지 않고 빈 결과를 돌려주는 성질. (잠금·민감도 필터 자체는 별도 테스트로 검증됨.)
- 나머지 브랜치 격차는 입력 스키마의 선택적 필드(from/to/status/limit 기본값) 분기.

### 5. `src/services/pptx-builder.ts` — 라인 100% · 브랜치 76.92% · 함수 100%

미커버 라인 83–87, 150–169, 219, 367, 443. 미커버 브랜치 9개.

검증되지 않은 성질:
- 차트 입력 검증 에러: 카테고리 빈 목록 시 throw, 계열 값 개수≠카테고리 개수 시 throw.
- 선택적 슬라이드 요소: 제목 슬라이드의 subtitle/meta 유무, 빈 목록 슬라이드의
  `emptyText` 폴백, 차트 관계(`slideRelsXml`의 hasChart 분기), 차트 슬라이드 분기.

### 6. `src/modules/mcp/tokens.ts` — 라인 97.22% · 브랜치 78.57% · 함수 100%

미커버 라인 122. 미커버 브랜치 3개.

검증되지 않은 성질:
- `verifyMcpToken`의 `last_used_at` 갱신 실패를 무시하고 인증된 행을 그대로 돌려주는 성질
  (갱신 실패가 인증 실패로 번지지 않음).

### 7. `src/lib/deadline.ts` — 라인 100% · 브랜치 83.33% · 함수 100%

미커버 라인 23. 미커버 브랜치 1개.

검증되지 않은 성질:
- `withTimeout`의 타이머 정리 가드(`if (timer !== undefined) clearTimeout(timer)`)의
  false 분기. 실제 실행에서는 타이머가 항상 설정되므로 도달 불가에 가까운 분기다.

### 8. `src/services/expert-registry.ts` — 라인 100% · 브랜치 83.33% · 함수 100%

미커버 라인 112, 161–166. 미커버 브랜치 3개.

검증되지 않은 성질:
- `getExpert`의 알 수 없는 ID → `null` 폴백 (`?? null`).
- `getBriefingOwner`/`getReminderOwner`의 소유자 없음 시 `EXPERTS[0]` 폴백
  (`?? EXPERTS[0]` — 소유 전문가가 한 명도 설정되지 않은 구성).

### 9. `src/services/memory-consolidation.ts` — 라인 98.52% · 브랜치 84.15% · 함수 100%

미커버 라인 270, 352. 미커버 브랜치 16개.

검증되지 않은 성질:
- 통합 플래그 조회 중 DB 오류 시 `{ ok: false, error: 'db_error' }`로 종료하는 성질 (270행).
- LLM 요약 플래그 조회 실패 시 `useLlm = false`로 조용히 폴백하는 성질 (352행).

### 10. `src/services/fact-graph.ts` — 라인 98.06% · 브랜치 85.94% · 함수 100%

미커버 라인 119–123, 509. 미커버 브랜치 26개로 전수 3위.

검증되지 않은 성질:
- 0056 미적용 DB(컬럼 없음)에서의 재시도: `valid_from` 포함 INSERT 실패 시 컬럼 없이
  재시도해 연결을 유지하는 성질 (119–123행).
- 대체된 기억 조회 실패 시 `superseded = []`로 폴백하는 성질 (509행).

## 4. 함수 커버리지 100% 미만인 파일 (6개)

| 파일 | 함수 | 비고 |
|---|---|---|
| `src/modules/mcp/routes.ts` | 0% (0/9) | §3-1 참조 — Jest 미호출, 런타임·Inspector로 검증 |
| `src/modules/mcp/server.ts` | 0% (0/2) | `buildMcpServer` 미호출 — 도구 등록·SDK 서버 조립이 Jest 미검증. 도구 본체는 `tools.ts` 직접 테스트로 검증됨 |
| `src/services/agent-run.ts` | 87.5% (14/16) | 라인 100%·브랜치 95.39% — 미호출 함수 2개는 확인 필요 (후속) |
| `src/services/google-tools.ts` | 90% (9/10) | 라인 100%·브랜치 100% — 미호출 함수 1개 확인 필요 (후속) |
| `src/modules/artifact/job-processor.ts` | 96% (24/25) | 라인 100%·브랜치 94.42% — 미호출 함수 1개 확인 필요 (후속) |
| `src/modules/ai/routes.ts` | 99.03% (103/104) | 라인 99.43%·브랜치 93.23% — 미호출 함수 1개 확인 필요 (후속) |

## 5. 환경·측정 시 주의사항

- **node_modules 복구**: worktree의 node_modules는 git 추적분만 있어 `ts-jest`가
  `Cannot find module './config/config-set'`으로 깨져 있었다. `npm install --ignore-scripts`를
  2회 시도했으나 둘 다 `ENOTEMPTY` rename 오류(esbuild → workerd-linux-64 순)로 중단되고
  ts-jest가 불완전한 채로 남았다. 결국 메인 worktree의 node_modules를
  `rsync -a --ignore-existing`으로 채워 복구했고, 단일 스위트 44/44 통과로 확인했다.
  npm install이 건드린 추적분 266개 파일은 `git checkout -- node_modules`로 원복했고,
  커밋에는 본 문서만 포함된다. (다음 측정 때도 npm install 대신 rsync 방식을 쓸 것.)
- **coverage-final.json 잔재**: 이번 실행은 `json` 리포터 없이 돌려 `coverage-final.json`이
  갱신되지 않았다. 현재 파일은 이전 실행 잔재로, 단 1개 파일(메인 worktree 경로)만 담고 있어
  신뢰할 수 없다. 파일별 수치는 `coverage-summary.json` + text 리포트를 기준으로 했다.
  `coverage/`는 git 추적 대상이며, 이번 실행 결과는 기존 커밋 내용과 동일해 변경분이 없다.
- **Stryker 기준선과의 관계**: 아래 §6 참조.

## 6. Stryker — 미실행 (사유 기록)

이번 트랙에서는 **Stryker를 재실행하지 않았다.**

- **사유 1 — 시간·메모리**: 전체 Jest만 428.5초가 걸렸다. 기본 설정(`stryker.config.mjs`)은
  5개 파일 × 7개 스위트를 mutant마다 perTest 분석으로 돌리며, 설정 파일 자체에
  "8GB 공유 VM에서 TypeScript 체커 워커가 OOM으로 조용히 죽었다"는 기록이 있다.
  뮤테이션 재실행은 수십 분 단위 + OOM 위험이 있어, 측정 트랙의 범위를 벗어난다.
- **사유 2 — 기준선 비교로 충분**: 기존 기준선 **76.65% (2026-10-28)** 와 비교하는 것으로 갈음한다.
  단, 기준선 리포트 파일(`reports/mutation/`)은 이 worktree에 없고, 76.65%라는 수치는
  태스크 전달값으로만 확인된다. worktree 내에서 검증 가능한 기준선 산출물이 없다는 점을 기록한다.
- **주의 — 기준선 stale 가능성**: 기준선 이후 HEAD `1da3477`에서 네이버 HUB 이관이 병합되며
  Stryker 스코프 5개 파일 중 하나인 `src/services/news-sources.ts`가 바뀌었다
  (구 `openapi.naver.com` → `naverapihub.apigw.ntruss.com` + HUB 헤더).
  따라서 76.65%는 HUB 이관 이전 코드 기준이며, **새 HUB 호출 경로는 뮤테이션으로 검증된 적이 없다.**
  후속 조치로 `news-sources.ts` 단일 파일 스코프의 Stryker 재실행을 권장한다
  (설정 파일에 이미 스코프를 좁히는 방식이 문서화되어 있음).
- **참고**: Stryker 스코프 5개 파일의 Jest 커버리지는 이번 측정에서 다음과 같다
  (news-summary 라인 98%·브랜치 91.24%, search-marker 100%/100%,
  citation-lock 100%/97.36%, article-date 100%/89.14%, news-sources 100%/88.43%).
  라인 커버리지가 높다고 뮤테이션 스코어가 높다는 뜻은 아니다 — HUB 경로의 뮤턴트 생존 여부는
  재실행으로만 확인할 수 있다.
