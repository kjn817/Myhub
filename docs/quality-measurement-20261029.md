# 품질 수치 동일 트리 재측정 — 2026-10-29

GPT 외부 평가의 지적 — "커버리지 99.70%와 뮤테이션 76.65%는 서로 다른 측정
트리·조건의 수치라 한 묶음으로 주장할 수 없다" — 에 답하기 위해, **단일
커밋에서 커버리지와 뮤테이션을 같은 날 연속으로 재측정**한 기록이다.

## 1. 측정 기준

| 항목 | 값 |
|---|---|
| 기준 커밋 | `e9d6726593972cbfc458407f2fef099c4a75671a` (브랜치 `fix/unlock-block-remove-ciphertext`) |
| 측정 일시 | 2026-10-29 22:33–23:21 KST (커버리지 22:33–22:36, 뮤테이션 Run A 22:36–22:48 · Run B 22:49–23:11 · Run C 23:10–23:21) |
| src/ 상태 | 커밋과 완전 일치 (`git status --porcelain -- src/` = 0건) |
| 테스트 측 상태 | HEAD 대비 미커밋 변경 존재 (아래 명시) — 측정 대상 코드(src/)가 아니라 테스트·측정 도구 측 |
| Stryker 버전 | 10.1.1 |

**테스트 측 미커밋 변경 (측정 시점 작업 트리 기준, 전부 테스트·도구 측):**

- `jest.config.js` — 플레이크 리포터 등록 (+3줄, Track A 작업). 테스트 수집·커버리지 산출 방식에는 영향 없음. 단, 이 리포터 덕에 실패 시 `reports/flake-failures.jsonl`에 자동 기록된다.
- `tests/jest-flake-reporter.test.js` (신규), `tests/runtime/e2e-scenarios.test.ts`·`tests/runtime/injection-scenarios.test.ts` (신규 — runtime은 vitest 담당이라 Jest 실행에는 미포함)
- 수정: `tests/integration/memory-0044-real.test.js`, `tests/integration/memory-consolidation-real.test.js`, `tests/unit/svc-fact-graph-cov.test.ts`, `tests/unit/svc3-memory-redesign.test.ts` (날짜 동적화 등 소규모 diff, 합계 +22/−8줄)

즉 커버리지 %의 분자·분모가 되는 **src/ 코드는 단일 커밋 e9d6726 그대로**이며,
테스트 스위트 총수는 HEAD 시점 공표치(257 스위트/5258개)보다 늘어난 상태
(259/5295)로 측정했다. 이 차이는 숨기지 않고 여기에 명시한다.

## 2. 커버리지 — 전수 실행

- 명령: `npx jest --coverage` (프로젝트 `jest.config.js` 그대로, `collectCoverageFrom: src/**/*.ts`, `index-inline.ts` 제외)
- 소요: 146.4초 (Jest 자체 보고), 실패 0

| 지표 | 수치 |
|---|---|
| Test Suites | **259 passed / 259** |
| Tests | **5295 passed / 5295** |
| Statements | **99.09%** |
| Branches | **95.06%** |
| Functions | **99.53%** |
| Lines | **99.47%** |

## 3. 뮤테이션 — Run A: 기존 기준선 범위 (과거 수치와 동일 범위)

- 명령: `npx stryker run` (`stryker.config.mjs` 무변경)
- 범위: `src/lib/news-summary.ts`, `src/lib/search-marker.ts`, `src/lib/citation-lock.ts`, `src/services/article-date.ts`, `src/services/news-sources.ts` (5개 파일)
- 테스트 풀: 위 파일을 직접 커버하는 단위 스위트 7개 (설정 파일에 고정), dry run 240개 테스트 통과
- 소요: 약 11.8분. 리포트: `reports/mutation/mutation-baseline-20261029.json`

| 결과 | 값 |
|---|---|
| 전체 뮤턴트 | 1,834 |
| Killed | 1,368 |
| Timeout | 17 |
| Survived | 413 |
| NoCoverage | 31 |
| RuntimeError | 5 |
| **뮤테이션 스코어** | **75.72%** (커버된 코드 기준 77.03%) |

파일별: citation-lock 86.36 · search-marker 87.50 · news-sources 76.84 · news-summary 73.75 · article-date 73.28

Survived 주요 패턴 (뮤테이터별): Regex 121 · ConditionalExpression 111 · StringLiteral 71 · EqualityOperator 25 · MethodExpression 25 · LogicalOperator 24 — 뉴스 날짜·URL 정규식의 세부 거동과 조건 경계가 단언으로 덜 고정돼 있다는 기존 감사 결론과 일치한다.

## 4. 뮤테이션 — Run B: 보안 핵심 범위 (신규 측정)

- 명령: `npx stryker run stryker.config.security.mjs` — **이번 측정을 위해 신규 추가한 측정 도구 설정** (소스 코드 변경 아님). Stryker 10에서는 설정 파일을 위치 인자로 전달한다 (기존 auth 설정 주석의 `--config` 표기는 현행 CLI에서 동작하지 않음을 실측으로 확인).
- 범위 (8개 파일): `src/services/crypto.ts`, `src/services/ai-access.ts`, `src/modules/memo/routes.ts`, `src/modules/mcp/{routes,server,tasks,tokens,tools}.ts`
- 제외 범위: 인증 `src/modules/auth/routes.ts`는 Run C(기존 전용 설정)로 별도 측정. 그 외 src/ 전체는 이번 범위 밖.
- 테스트 풀: 위 파일을 직접 import하는 Jest 스위트 13개, dry run 438개 테스트 통과
- 소요: 약 21.4분. 리포트: `reports/mutation/mutation-security-20261029.json`

| 결과 | 값 |
|---|---|
| 전체 뮤턴트 | 1,683 |
| Killed | 1,162 |
| Timeout | 4 |
| Survived | 423 |
| NoCoverage | 94 |
| Errors | 0 |
| **뮤테이션 스코어** | **69.28%** (커버된 코드 기준 73.38%) |

파일별 스코어:

| 파일 | 스코어 | Killed | Survived | NoCoverage |
|---|---|---|---|---|
| src/services/crypto.ts | **91.36%** | 71 | 7 | 0 |
| src/modules/mcp/tokens.ts | 81.67% | 48 | 9 | 2 |
| src/services/ai-access.ts | 71.10% | 123 | 48 | 2 |
| src/modules/memo/routes.ts | 70.75% | 479 | 196 | 2 |
| src/modules/mcp/tasks.ts | 65.52% | 171 | 58 | 32 |
| src/modules/mcp/routes.ts | 65.26% | 139 | 24 | 50 |
| src/modules/mcp/server.ts | 62.96% | 17 | 9 | 1 |
| src/modules/mcp/tools.ts | 59.69% | 114 | 72 | 5 |

**해석 시 주의 (스코어를 낮추는 구조적 요인):**

- NoCoverage 94개 중 82개가 `mcp/routes.ts`(50)와 `mcp/tasks.ts`(32)에 몰려 있다. 해당 경로의 실질 커버는 `tests/runtime/`(vitest·miniflare) 스위트가 담당하는데, Stryker의 Jest 러너로는 실행할 수 없어 풀에 넣지 못했다. 즉 MCP의 낮은 수치는 "테스트 부재"가 아니라 "이 측정 도구가 닿지 않는 테스트 층"을 포함한다. lines 기준으로는 routes 124–205행, tasks 197–357행 구간에 집중.
- Survived 뮤테이터 분포: StringLiteral 157 (에러 메시지 등 문자열 상수 미단언이 다수) · ConditionalExpression 75 · Regex 33 · MethodExpression 31 · ObjectLiteral 28 · LogicalOperator 25 · EqualityOperator 18.
- crypto Survived 7개는 대부분 키 길이 경계(`length < 32` ↔ `<=`/`>=`)와 바이트 루프 경계다. 운영 키가 고정 32바이트라는 전제에서는 등가에 가깝지만, 임의 길이 입력에 대해 엄밀히 등가는 아니므로 등가로 단정하지 않는다.

## 5. 뮤테이션 — Run C: 인증 범위 (기존 전용 설정)

- 명령: `npx stryker run stryker.config.auth.mjs` (기존 설정 무변경 — 단, 설정 파일 상단 주석의 실행 예시 `--config` 플래그는 Stryker 10 CLI에서 동작하지 않아 위치 인자로 실행했다)
- 범위: `src/modules/auth/routes.ts` 1개 파일 (PIN 로그인·OTP·세션·속도 제한)
- 테스트 풀: 인증 전용 스위트 3개 (`auth-pin-gate`, `auth-routes`, `auth-low-fixes`), dry run 140개 테스트 통과
- 소요: 약 11분. 리포트: `reports/mutation/mutation-auth-20261029.json`

| 결과 | 값 |
|---|---|
| 전체 뮤턴트 | 789 |
| Killed | 545 |
| Timeout | 1 |
| Survived | 187 |
| NoCoverage | 56 |
| Errors | 0 |
| **뮤테이션 스코어** | **69.20%** (커버된 코드 기준 74.49%) |

주의: NoCoverage 56개는 풀에 넣지 않은 통합 스위트(`tests/integration/auth-0051-real.test.js` 등)와 런타임 층에서만 닿는 경로를 포함한다 — Run B의 MCP와 같은 구조적 한계다. Survived 주요 패턴: ConditionalExpression 46 · StringLiteral 46 · BooleanLiteral 29 · ObjectLiteral 18 · LogicalOperator 13.

## 6. 등가 뮤턴트 처리 기준

- 세 실행 모두 **수동 등가 판정·제외(Ignored 지정)를 일절 하지 않았다.** 스코어는 Stryker 기본식 `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)` 그대로이며, CompileError·RuntimeError만 분모에서 제외된다 (Run A RuntimeError 5개, Run B·C 0개).
- 따라서 본 수치는 등가 뮤턴트를 걸러낸 "조정 스코어"가 아니라 **보수적 원점수**다. 과거 감사 문서가 "등가 제외 실질 ~79.5~82.6%"라고 덧붙였던 조정 추정은 이번 측정에서는 적용하지 않았다.

## 7. 과거 수치와의 차이 — 정직한 대조

| 수치 | 값 | 측정 조건 |
|---|---|---|
| 커버리지 (과거 공표) | 구문 99.36 · 브랜치 95.36 · 함수 99.58 · 라인 99.70 | 브랜치 `apply/test-coverage` @d7db145 트리 (2026-10-29 오전) |
| **커버리지 (이번)** | **구문 99.09 · 브랜치 95.06 · 함수 99.53 · 라인 99.47** | 커밋 e9d6726, 전수 259 스위트/5295 테스트 |
| 뮤테이션 (최초 기준선) | 72.25% | 5개 파일 부분 실행 (2026-10-27~28 시점 트리) |
| 뮤테이션 (킬 테스트 후) | 76.65% | 별도 트랙이 같은 5개 파일 범위로 테스트를 추가한 뒤 측정한 값 (당시 트리) |
| **뮤테이션 Run A (이번)** | **75.72%** | **동일 5개 파일·동일 설정**, 커밋 e9d6726 |
| **뮤테이션 Run B (이번)** | **69.28%** | **신규 보안 핵심 8개 파일** — 과거에 측정한 적 없는 범위라 과거 수치와 직접 비교 불가 |
| **뮤테이션 Run C (이번)** | **69.20%** | 인증 1개 파일 (`auth/routes.ts`), 기존 전용 설정 — 과거에 완주 측정한 적 없는 범위 |

차이의 이유:

- 커버리지가 소폭 하락한 것은 회귀가 아니라 **분모(코드량)의 성장**이다. d7db145 이후 P0(잠금 fail-closed 등)·P1·P2·MCP Tasks 병합으로 src/가 늘었고, 늘어난 코드의 커버율이 전체 평균보다 약간 낮다.
- Run A 75.72% vs 과거 76.65% (−0.93pt): 동일 범위·동일 설정이지만 코드가 변했다 (news-sources에 press-rss 체인 추가 등). 같은 잣대로 같은 날 재면 이 값이다.
- **결론: 앞으로 MyHub의 품질 수치는 "커밋 e9d6726에서 커버리지 99.09/95.06/99.53/99.47, 뮤테이션은 기준선 범위 75.72% · 보안 범위 69.28% · 인증 범위 69.20%"처럼 커밋·범위를 붙여서만 인용한다.**

## 8. 플레이크

- 커버리지 전수 실행(5295개)에서 **실패 0건** — 플레이크 없음. `reports/flake-failures.jsonl`은 생성되지 않았다.
- Stryker Run A·B·C의 dry run(초기 무변형 실행)도 각각 240·438·140개 테스트 전부 통과했다.
- 단, Stryker 실행 중에는 뮤턴트에 의한 의도적 실패가 대량 발생하므로 플레이크 판정 대상이 아니다. 이번 측정 구간에서 이름·조건을 남길 플레이크는 발생하지 않았다 (과거 미특정 플레이크 1건은 이번 실행에서 재현되지 않았다는 뜻이며, 소멸을 단정하지 않는다).

## 9. 재현 방법

```bash
git rev-parse HEAD   # e9d6726593972cbfc458407f2fef099c4a75671a 확인
npx jest --coverage
npx stryker run                                # Run A (stryker.config.mjs)
npx stryker run stryker.config.security.mjs    # Run B (신규 설정)
npx stryker run stryker.config.auth.mjs        # Run C
```

원시 리포트: `reports/mutation/mutation-baseline-20261029.json`, `reports/mutation/mutation-security-20261029.json`, `reports/mutation/mutation-auth-20261029.json` (reports/는 .gitignore 대상 — 이 문서가 수치의 영구 기록이다.)
