# 품질 수치 최신 트리 재측정 — 2026-10-31 (측정 실패 기록)

2026-10-29 측정(`docs/quality-measurement-20261029.md`, 커밋 `e9d6726`) 이후
코드가 크게 늘어난 현재 HEAD에서, **이전과 같은 방식·같은 범주**로 커버리지와
뮤테이션을 재측정하려 한 시도와 그 실패 기록이다.

**결론부터: 이번 측정에서는 유효한 수치를 하나도 얻지 못했다.** 커버리지
실행이 이 VM의 쓰기 차단(EPERM)으로 두 번 모두 무효화됐고, 규칙("벌크 쓰기
EPERM이 재발하면 중단")에 따라 뮤테이션은 실행하지 않았다. 없는 수치를
지어내지 않으며, 이전 수치를 현재 수치처럼 인용해서도 안 된다.

> **후속 기록 (같은 날 저녁):** 환경 회복 후 §6 레시피대로 재개한 재측정이
> §8에서 완주했다. 현재 트리(`a2586f2`)의 유효 수치는 §8이 정본이며,
> §1–§7은 오후 실패 시도의 기록으로 그대로 보존한다.

## 1. 측정 기준 (시도 시점)

| 항목 | 값 |
|---|---|
| 기준 커밋 | `c1fda863543799b6845a1749b7e4f3532905e2dd` (브랜치 `fix/unlock-block-remove-ciphertext`) |
| 측정 일시 | 2026-10-31 16:44–16:48 KST |
| src/ 상태 | 커밋과 완전 일치 (`git status --porcelain -- src/` = 0건) |
| 측정 설정 | `jest.config.js`, `stryker.config.mjs`, `stryker.config.security.mjs`, `stryker.config.auth.mjs` 전부 무변경 (작업 트리 diff 0건). **설정 변경 없음** — 방법·범위는 이전 측정과 동일하게 유지했다 |
| Stryker 버전 | 10.1.1 (이전 측정과 동일) |
| 테스트 측 상태 | `tests/`에 미커밋 변경 없음 (`tests/__pycache__/` 무관 디렉터리 제외) |
| 병행 커밋 주의 | 측정 시작 시 HEAD는 `c1fda86`이었으나, 측정 도중 병행 작업의 커밋 `f76145c` (node_modules·__pycache__ git 추적 해제 + .gitignore)이 그 위에 쌓였다. 해당 커밋은 `src/`·`tests/`·측정 설정을 건드리지 않으며, 측정 전 구간에서 `src/` 무변경(0건)을 재확인했으므로 측정 대상 코드에는 영향이 없다 |

이전 측정과 동일하게 복제한 범위:

- 커버리지: `npx jest --coverage` (`collectCoverageFrom: src/**/*.ts`, `index-inline.ts` 제외)
- 뮤테이션 Run A (`npx stryker run`, `stryker.config.mjs`): `src/lib/news-summary.ts`, `src/lib/search-marker.ts`, `src/lib/citation-lock.ts`, `src/services/article-date.ts`, `src/services/news-sources.ts` (5개 파일)
- 뮤테이션 Run B (`npx stryker run stryker.config.security.mjs`): `src/services/crypto.ts`, `src/services/ai-access.ts`, `src/modules/memo/routes.ts`, `src/modules/mcp/{routes,server,tasks,tokens,tools}.ts` (8개 파일)
- 뮤테이션 Run C (`npx stryker run stryker.config.auth.mjs`): `src/modules/auth/routes.ts` (1개 파일)

## 2. 커버리지 — 시도 1: EPERM으로 즉시 중단 (무효)

- 일시: 2026-10-31 16:44:52–16:45:29 KST (37초)
- 명령: `npx jest --coverage` (출력을 `/tmp/coverage-20261031.log`로 리다이렉트)
- 결과: **exit 1, 결과 없음.** Jest 리포터가 stdout을 flush하는 지점에서
  `Error: EPERM: operation not permitted, write` (SyncWriteStream,
  `@jest/reporters`의 `flushBufferedOutput`)가 발생해 프로세스가 죽었다.
  테스트 결과·커버리지 표는 산출되지 않았다.

## 3. 커버리지 — 시도 2 (재시도 1회, 허용 한도 소진): EPERM으로 무효

- 일시: 2026-10-31 16:45:43–16:48:26 KST (벽시계 162.8초, Jest 자체 보고 161.66초)
- 명령: `npx jest --coverage` (파이프 경유로 실행 — 시도 1의 stdout 동기 쓰기 경로 회피 목적. 명령·설정 자체는 동일)
- 결과: **무효 (측정값으로 사용 불가).** 실행 중 쓰기 차단이 다시 내려와
  Jest transform 캐시 쓰기가 대량 실패했다:

  ```
  jest: failed to cache transform results in: /tmp/jest_0/jest-transform-cache-…/…
  Failure message: EPERM: operation not permitted, write
      at writeFileSync (node_modules/write-file-atomic/lib/index.js:223:10)
  ```

- Jest 요약 (이 실행의 원문 수치 — 커버리지 측정값이 아니다):
  - Test Suites: **131 failed, 153 passed, 284 total** — 실패 131개는 전부
    위 캐시 EPERM으로 "failed to run"인 스위트다. 제품 코드 실패로 읽으면 안 된다.
  - Tests: **8 failed, 2406 passed, 2414 total** — 전체 스위트의 절반가량이
    실행조차 못 했으므로 분모 자체가 부분 실행이다. 이 실행에서 보고된
    개별 테스트 실패 8건은 환경 오염과 분리할 수 없어 제품 결함으로
    기록하지 않는다 (캡처가 tail 출력뿐이라 건별 귀속도 불가능하다).
  - **커버리지 표(구문/브랜치/함수/라인)는 산출되지 않았다.**

- 부수 관찰: 전체 발견 스위트 수는 284개로, 이전 측정(259개)보다 늘었다는
  것만은 실행 발견 단계에서 확인된다. 테스트 총수는 이 실행으로는 확정할 수 없다.
- 시도 직후의 가벼운 쓰기 프로브(작은 파일 쓰기/읽기)는 정상이었다.
  즉 상시 쓰기 불가가 아니라, **지속적인 벌크 부하가 걸리면 쓰기 차단이
  내려오는 이 VM의 기존 패턴**(트랙 6 npm ci 증명에서 확정된 양상과 동일)이
  재현된 것이다.

## 4. 뮤테이션 — 미실행 (NOT RUN)

Run A·B·C **전부 실행하지 않았다.** 사유:

- 할당 규칙상 환경 실패 시 재시도는 1회까지이며, 커버리지에서 이미 그
  1회를 소진했고 EPERM이 재발했다. "벌크 쓰기 EPERM이 재발하면 중단하고
  그 지점을 보고"하라는 규칙에 따라 여기서 중단했다.
- Stryker는 `.stryker-tmp` 복사 + 뮤턴트별 Jest 반복 실행으로 커버리지
  전수 실행보다 훨씬 무거운 지속 쓰기 부하를 건다 (이전 측정 소요:
  Run A 약 11.8분 · Run B 약 21.4분 · Run C 약 11분). 같은 차단이
  내려오는 상태에서 시작하면 중도 무효화가 확실시돼, 부분 점수를
  만들지 않기 위해 시작 자체를 하지 않았다.
- **뮤테이션 점수는 "미측정"이다. 이전 점수를 현재 트리의 점수로
  인용하거나, 이번 시도를 PASS로 표기해서는 안 된다.**

## 5. 이전 수치와의 대조표

| 지표 | 이전 (커밋 `e9d6726`, 2026-10-29) | 현재 (커밋 `c1fda86`, 2026-10-31) |
|---|---|---|
| 커버리지 구문 | 99.09% | **측정 실패 — 값 없음** |
| 커버리지 브랜치 | 95.06% | **측정 실패 — 값 없음** |
| 커버리지 함수 | 99.53% | **측정 실패 — 값 없음** |
| 커버리지 라인 | 99.47% | **측정 실패 — 값 없음** |
| 뮤테이션 Run A (기준선 5파일) | 75.72% | **미실행** |
| 뮤테이션 Run B (보안 핵심 8파일) | 69.28% | **미실행** |
| 뮤테이션 Run C (auth/routes) | 69.20% | **미실행** |

비교 가능성: 방법·범위·설정은 이전과 동일하게 유지했으므로, 환경이
허용하는 상태에서 같은 명령을 다시 돌리면 그대로 비교 가능한 수치가
나온다. 이번에는 수치 자체가 없어 비교가 성립하지 않는다.

## 6. 재개 레시피

이 VM에서는 벌크 워크로드 자체가 쓰기 차단을 유발하는 패턴이 반복
확정돼 있다 (2026-10-31 트랙 6 npm ci 시도와 동일). 재측정은 다음
조건에서만 의미가 있다:

1. 새 세션/VM 재시작 직후, **첫 벌크 작업으로** 커버리지부터 실행할 것.
2. 그 세션에서 다른 벌크 작업(대규모 쓰기·빌드)을 병행하지 말 것.
3. 커버리지가 완주하면 같은 세션에서 Stryker Run A → B → C 순서로 실행할 것.
4. 재개 시 명령·범위는 §1 그대로 — 설정 변경 시 이 문서에 후속 기록할 것.

## 7. 정직성 표기 요약

- 커버리지: 시도 2회, 2회 모두 환경 EPERM으로 무효. **수치 없음.**
- 뮤테이션: **미실행.** 점수 없음.
- 이 문서의 어떤 숫자도 현재 트리(`c1fda86`)의 품질 수치로 인용할 수 없다.
  현재 인용 가능한 최신 유효 수치는 여전히 2026-10-29 측정
  (커밋 `e9d6726`)의 값이며, 인용 시 반드시 그 커밋을 붙여야 한다.

## 8. 후속 재측정 — 2026-10-31 저녁, 완주 (현재 정본)

§6 재개 레시피 그대로(새 세션에서 커버리지를 첫 벌크 작업으로, 병행 벌크
없음, 같은 세션에서 Stryker A → B → C) 재측정해 **전 구간 완주**했다.
방법·범위·설정은 §1 및 `docs/quality-measurement-20261029.md`와 동일하며
설정 파일은 무변경이다. 아래 수치는 전부 측정 원본(커버리지 로그,
Stryker JSON 리포트)에서 직접 확인한 값만 적는다.

### 8.1 측정 기준

| 항목 | 값 |
|---|---|
| 기준 커밋 | `a2586f2c60d46ed606221351ba9f0fc3bfeb46be` (브랜치 `fix/unlock-block-remove-ciphertext`) |
| 측정 일시 | 2026-10-31 20:48–21:30 KST (커버리지 20:48~, Run A 20:52–21:01 · Run B 21:02–21:20 · Run C 21:20–21:30) |
| src/·tests/·측정 설정 상태 | 측정 전·중·후 전부 커밋과 일치 (`git status --porcelain -- src/ tests/ jest.config.js stryker.config*.mjs` = 0건) |
| Stryker 버전 | 10.1.1 (이전 측정과 동일) |
| EPERM | 전 구간 **0건** (각 로그 grep 확인) |

환경 사고 2건은 숨기지 않고 기록한다:

1. 커버리지 완주·검증 직후 환경 리셋으로 `/tmp`가 비워지며 커버리지 원본
   로그 파일과, `/tmp`에 로그를 쓰던 Run A 첫 시도가 함께 소실됐다.
   커버리지 수치는 소실 **전** 원본 로그에서 직접 확인(grep)한 값이며,
   Run A 첫 시도는 리포트를 만들지 못해 부분 수치를 일절 쓰지 않고
   처음부터 다시 실행했다. 이후 로그·리포트는 전부 workspace
   (`.scratch/track2/`, gitignore 대상)에 보존했다.
2. Run C 실행 중 인증 테스트의 `api.resend.com` 접근에 대한 권한 카드가
   떠서 프로세스가 일시 대기했고, 사용자 승인 후 재개·완주했다
   (dry run 149개 통과는 카드 이전에 완료). 점수는 최종 JSON 리포트 기준.

### 8.2 커버리지 — 전수 실행

- 명령: `npx jest --coverage` (`collectCoverageFrom: src/**/*.ts`, `index-inline.ts` 제외)
- 소요: 179.408초 (Jest 자체 보고), exit 0, 실패 0

| 지표 | 수치 |
|---|---|
| Test Suites | **287 passed / 287** |
| Tests | **5733 passed / 5733** |
| Statements | **98.38%** |
| Branches | **93.61%** |
| Functions | **99.14%** |
| Lines | **98.86%** |

### 8.3 뮤테이션 — Run A: 기존 기준선 범위 (5파일)

- 명령: `npx stryker run` (`stryker.config.mjs` 무변경), dry run 240개 테스트 통과, 소요 8분 53초
- 리포트: `reports/mutation/mutation-baseline-20261031.json` (reports/는 gitignore — 이 문서가 영구 기록)

| 결과 | 값 |
|---|---|
| 전체 뮤턴트 | 1,834 |
| Killed | 1,377 |
| Timeout | 17 |
| Survived | 404 |
| NoCoverage | 31 |
| RuntimeError | 5 |
| **뮤테이션 스코어** | **76.22%** (커버된 코드 기준 77.53%) |

파일별: citation-lock 86.36 · search-marker 87.50 · news-sources 78.32 · news-summary 74.01 · article-date 73.28

Survived 주요 패턴 (뮤테이터별): Regex 119 · ConditionalExpression 110 · StringLiteral 64 · EqualityOperator 25 · MethodExpression 25 · LogicalOperator 25 — 이전 측정과 같은 양상(뉴스 날짜·URL 정규식 세부 거동, 조건 경계).

### 8.4 뮤테이션 — Run B: 보안 핵심 범위 (8파일)

- 명령: `npx stryker run stryker.config.security.mjs`, dry run 469개 테스트 통과 (이전 438 — 테스트 풀 성장), 소요 18분 29초
- 리포트: `reports/mutation/mutation-security-20261031.json`

| 결과 | 값 |
|---|---|
| 전체 뮤턴트 | 1,960 |
| Killed | 1,330 |
| Timeout | 4 |
| Survived | 485 |
| NoCoverage | 141 |
| Errors | 0 |
| **뮤테이션 스코어** | **68.06%** (커버된 코드 기준 73.34%) |

파일별 스코어:

| 파일 | 스코어 | Killed | Timeout | Survived | NoCoverage |
|---|---|---|---|---|---|
| src/services/crypto.ts | **65.56%** | 96 | 3 | 32 | 20 |
| src/services/ai-access.ts | 71.10% | 123 | 0 | 48 | 2 |
| src/modules/memo/routes.ts | 70.44% | 622 | 0 | 232 | 29 |
| src/modules/mcp/routes.ts | 65.26% | 139 | 0 | 24 | 50 |
| src/modules/mcp/server.ts | 60.71% | 17 | 0 | 10 | 1 |
| src/modules/mcp/tasks.ts | 65.52% | 171 | 0 | 58 | 32 |
| src/modules/mcp/tokens.ts | 81.67% | 48 | 1 | 9 | 2 |
| src/modules/mcp/tools.ts | 59.69% | 114 | 0 | 72 | 5 |

Survived 주요 패턴: StringLiteral 163 · ConditionalExpression 106 · Regex 33 · MethodExpression 32 · LogicalOperator 31 · ObjectLiteral 30.

**crypto.ts 하락에 대한 측정 사실 (결함 단정 아님):** 이전 측정에서
91.36%(2026-10-29 문서 파일별 표: Killed 71 · Survived 7 · NoCoverage 0)
였던 crypto.ts가 이번에는 뮤턴트 합계 151개(Killed 96 · Timeout 3 ·
Survived 32 · NoCoverage 20)로 늘었고 NoCoverage 0→20, Survived 7→32가 됐다.
그 사이 crypto.ts에는 키 로테이션(ENC2 세대 마커·구 키 폴백) 코드가
추가됐고, Run B의 Jest 풀(13개 스위트)은 그 신규 경로를 약하게 커버한다
(예: 구 키 폴백 조건 `crypto.ts:201`의 ConditionalExpression 뮤턴트 생존).
이 풀 기준의 수치이며, 로테이션 경로 전용 테스트 보강이 후속 후보이다.
제품 결함으로 확정하지 않는다.

### 8.5 뮤테이션 — Run C: 인증 범위 (1파일)

- 명령: `npx stryker run stryker.config.auth.mjs`, dry run 149개 테스트 통과 (이전 140), 소요 9분 37초
- 리포트: `reports/mutation/mutation-auth-20261031.json`

| 결과 | 값 |
|---|---|
| 전체 뮤턴트 | 999 |
| Killed | 623 |
| Timeout | 1 |
| Survived | 247 |
| NoCoverage | 128 |
| Errors | 0 |
| **뮤테이션 스코어** | **62.46%** (커버된 코드 기준 71.64%) |

Survived 주요 패턴: ConditionalExpression 66 · StringLiteral 54 · BooleanLiteral 36 · LogicalOperator 23 · ObjectLiteral 21.

하락의 구조: 이전 측정 이후 `auth/routes.ts`에 보호 메모 step-up(`su`
클레임)·OTP 세션 클레임(`oa`) 등 신규 코드가 들어와 뮤턴트가 789→999개로
늘었고, 풀(인증 전용 3개 스위트) 밖 통합·런타임 층에서만 닿는 경로가
NoCoverage 56→128로 커졌다. 이전 측정에서 명시한 것과 같은 구조적
한계이며, 기존 코드의 회귀로 읽지 않는다.

### 8.6 등가 뮤턴트 처리 기준

- 세 실행 모두 수동 등가 판정·제외(Ignored 지정)를 일절 하지 않았다.
  스코어는 Stryker 기본식 `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)`
  그대로이며, CompileError·RuntimeError만 분모에서 제외된다
  (Run A RuntimeError 5개, Run B·C 0개). 이전 측정과 동일 기준.

### 8.7 이전 측정과의 대조 — 트리가 다름을 명시

| 지표 | 이전 (`e9d6726`, 2026-10-29) | 현재 (`a2586f2`, 2026-10-31) | 차이 |
|---|---|---|---|
| 커버리지 구문 | 99.09% | **98.38%** | −0.71pt |
| 커버리지 브랜치 | 95.06% | **93.61%** | −1.45pt |
| 커버리지 함수 | 99.53% | **99.14%** | −0.39pt |
| 커버리지 라인 | 99.47% | **98.86%** | −0.61pt |
| Test Suites / Tests | 259 / 5,295 | **287 / 5,733** | +28 / +438 |
| 뮤테이션 Run A (기준선 5파일) | 75.72% | **76.22%** | +0.50pt |
| 뮤테이션 Run B (보안 핵심 8파일) | 69.28% | **68.06%** | −1.22pt |
| 뮤테이션 Run C (auth/routes) | 69.20% | **62.46%** | −6.74pt |

두 측정 사이 트리 변화(보호 메모 step-up, FC 승인 게이트 정렬, 키
로테이션 도구, 대화 목록 페이지네이션, `ai.ts` 분해 등)로 분모가 크게
늘었다. 커버리지·Run B·C의 하락은 신규 코드 구간의 커버율이 평균보다
낮은 데서 온 분모 효과로 읽는 것이 정확하고, 동일 범위가 그대로인
Run A는 오히려 상승했다. **인용 시 반드시 "커밋 `a2586f2`에서 커버리지
98.38/93.61/99.14/98.86, 뮤테이션 A 76.22% · B 68.06% · C 62.46%"처럼
커밋·범위를 붙일 것.**

### 8.8 플레이크·미검증 항목

- 커버리지 전수 실행(5,733개)에서 실패 0건 — 플레이크 없음.
  Stryker dry run도 A 240 · B 469 · C 149개 전부 통과.
- 미검증(이전 측정과 동일한 한계): `tests/runtime/`(vitest·miniflare)
  층의 커버는 Jest 커버리지와 Stryker 풀에 포함되지 않는다. MCP·auth의
  NoCoverage 일부는 이 층에서만 닿는 경로다.
- 이번 측정에서 제품 결함으로 확정된 테스트 실패는 없다. 발견 사항은
  §8.4의 crypto 로테이션 경로 커버 약화(측정 관찰)뿐이며, 추측 수정은
  하지 않았다.
## 9. 기준 커밋 90adef0 품질 측정 (2026-11-01, GPT 7.2 대응 트랙 2)

측정 트리: HEAD `90adef0` (트랙 1 백업 step-up·트랙 3 CSP·트랙 5 키 로테이션 UI
포함) + 본 절의 테스트 추가분(테스트 파일만 — 측정 대상 src는 HEAD와 동일).
이전 기준(a2586f2)과의 src 차이 전수: `src/index.ts`·
`src/modules/artifact/job-processor.ts`·`src/modules/backup/routes.ts` 3파일뿐.
뮤테이션 범위 A(5파일)·B(8파일)·C(auth/routes.ts)의 대상 파일은 전부 무변경 —
아래 뮤테이션 수치는 대상 파일 기준으로 여전히 유효하며, C는 동일 트리에서
재실행까지 마쳤다.

### 9.1 커버리지 (재실행, 내 실행 증거)

- 명령: `TZ=UTC npx jest --coverage` (전수)
- 결과: 296 스위트 / 5,782 테스트 전부 PASS
- 구문 98.38% · 브랜치 93.60% · 함수 99.15% · 라인 98.86%
  (a2586f2: 98.38 / 93.61 / 99.14 / 98.86 — 사실상 동일. 신규 코드인 백업
  step-up 게이트와 CSP 분기가 전용 테스트로 커버돼 전역 수치가 유지됐다.)

### 9.2 뮤테이션 Run C 재실행 (auth/routes.ts)

- 명령: `npx stryker run stryker.config.auth.mjs` (dry run 152개 테스트 —
  이전 149 + 본 절에서 추가한 경계 테스트 3), 리포트:
  `reports/mutation/mutation-auth-20261101.json`
- 결과: 전체 999 · Killed 633 · Timeout 5 · Survived 244 · NoCoverage 117 ·
  **스코어 63.86%** (커버 기준 72.34%) — a2586f2 측정(62.46%) 대비
  +1.40p. 상태가 바뀐 뮤턴트는 24개로, 9.3-(c)에서 겨냥한 두 경계
  뮤턴트(L776 `>=`→`>`, L828 `>`→`>=`)가 모두 Survived→Killed로
  전이했고, KV 폴백 함수(L775-798) 일대의 NoCoverage 11개가 커버로
  전환됐다. Timeout 1→5 증가는 병행 실행 부하 구간에서 발생한 것으로
  기록한다 (Timeout은 검출로 셈).

### 9.3 Run C 생존자 247 분류와 조치

뮤테이터별: ConditionalExpression 66 · StringLiteral 54 · BooleanLiteral 36 ·
LogicalOperator 23 · ObjectLiteral 21 · EqualityOperator 17 ·
BlockStatement 10 · Regex 6 · ArithmeticOperator 5 · 기타 9.

- (a) 방어 심층 — 조치 없음이 정직한 판정: 세션 발급 측 su/oa 포함 조건
  (L255-256)과 파싱 측 클레임 정규화(L292-303)의 생존자 다수. 토큰은
  SESSION_SECRET HMAC 서명 없이는 만들 수 없고, 서버 발급 경로는 경계값을
  만들지 않는다. 도달 불가능한 입력에 대한 단언은 연극 테스트가 되므로
  추가하지 않았다. 기존 정규화 기본 케이스는 auth-routes.test.ts가 이미 커버.
- (b) 저위험 세부 — 패턴 기록만: Resend 메일 경로의 오류 문자열·정규식,
  응답 본문의 세부 필드(String/Object/Boolean), 속도 제한 창 산술,
  만료 동률 시각 처리. 상태 코드·오류 코드로 검증되는 경로의 내부 세부다.
- (c) 실제 경계 성질 — 테스트 추가 + 수동 뮤테이션으로 Killed 실증:
  1. KV 폴백 잠금 경계 (L775-776): D1 카운터 미적용 환경에서 쓰는
     pinLoginKvFallback의 `failCount >= PIN_FAIL_LIMIT` 판정. 경계 테스트는
     풀 밖(coverage-final-cov)에만 있어 풀 기준 생존이었다.
     → auth-routes.test.ts에 추가: 카운터 정확히 5 → 올바른 PIN에도 429·
     세션 미발급 / 카운터 4 → 200·카운터 0 초기화.
  2. set-pin OTP 창 경계 (L828): `경과 > 10분`이면 거부 — 정확히
     600,000ms는 허용, 600,001ms는 OTP_WINDOW_EXPIRED를 고정.
  두 뮤턴트 모두 소스에 직접 변이를 넣어(>=→>, >→>=) 신규 테스트가
  실패함을 확인했다 (카나리아 실증). 코드 결함은 아니었고 테스트 배치의
  문제였다 — 운영 코드 무변경.
- NoCoverage 128: 풀(인증 3스위트) 밖 런타임·통합 층에서만 닿는 경로.
  §8.5에서 명시한 구조적 한계와 동일하며 신규 회귀가 아니다.

### 9.4 측정 위생 메모

재측정 과정에서 중간 복사본 1건이 이전 리포트를 그대로 옮긴 stale
사본이었던 것을 뮤턴트 단위 내용 대조로 발견해 폐기하고, 최종 수치는
리포트 내용(파일 수·뮤턴트 총계·상태 전이 24건)을 직접 대조해 확정했다.
점수만 인용하지 말고 리포트 원본의 내용 대조를 거칠 것 — 이번 측정의
교훈으로 남긴다.

### 9.5 Run B 재실행 — crypto 로테이션 경로 보강 효과

§8.4가 지목한 crypto.ts 하락분(NoCoverage 0→20, 신규 로테이션 코드의 풀
커버 부족)에 대해, 풀 파일인 tests/unit/svc-crypto.test.ts에 성질 테스트
6건을 추가했다: 키 지정 프리미티브 4건(ENC2 왕복·타 키 거부·v1 복호화·
바이트 v2 매직 왕복·v1 바이트 복호화)과 구 키 폴백 2건(텍스트·바이트
PREV 복호화, PREV 부재·오답 시 원래 오류 전파).

- 명령: `npx stryker run stryker.config.security.mjs` (dry run 475개
  테스트 — 이전 469 + 신규 6), 소요 23분 47초, 리포트:
  `reports/mutation/mutation-security-20261101.json`
- **Run B 전체: 68.06% → 69.69%** (Killed 1330→1360 · Survived 485→471 ·
  NoCoverage 141→123 · Timeout 4→6)
- **crypto.ts: 65.56% → 86.75%** (Killed 96→127 · Survived 32→18 ·
  NoCoverage 20→2). 상태 전이 33건이 전부 로테이션 프리미티브
  (L139-173)·구 키 판정(L52-55)·§8.4가 실명으로 지목한 구 키 폴백
  조건(L201)의 Killed 전환이다. 다른 파일은 mcp/routes의
  Killed→Timeout 1건을 빼고 전부 동일 — 개선이 crypto 한 곳에서만
  난 것이 대조로 확인된다.
- 남은 crypto 생존자 18건 중 신규로 커버만 된 L54 ConditionalExpression
  1건이 포함된다 (PREV 빈 문자열 경계 — 후속 후보로 기록).

### 9.6 Run A

재실행하지 않았다. A 범위 5파일은 a2586f2 이후 무변경이고 본 트랙의
테스트 추가도 그 파일들을 건드리지 않아, §8.3의 76.22%가 이 HEAD에서의
기록값이다. 재측정이 필요해지면 같은 명령으로 후속 측정한다.
