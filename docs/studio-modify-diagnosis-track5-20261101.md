# AI 스튜디오 수정 실패 — 트랙 5 진단·수정 (2026-11-01)

대상: 브랜치 `fix/unlock-block-remove-ciphertext`, HEAD a8bd14a 기준 코드,
운영 라이브 c7d37b29. 배포는 하지 않았다 (코디네이터 판단 몫).

## 1. 이미 해소된 것 (기존 기록 — 현재 코드로 재확인)

| 기존 진단 (2026-10-15) | 상태 |
|---|---|
| 동기 직접 모드가 응답을 수 분간 블로킹 → 브라우저가 연결을 끊어 `Failed to fetch` | **해소**: `POST /jobs`는 큐 전송 후 202+jobId 즉시 반환 (c36a92d), 프론트는 `pollJob` 2.5초 폴링, 에이전트에 wall-clock 예산 추가 |
| 큐 경로에서 modify 버전 생성 누락 (saveJobResult가 데드코드) | **해소**: `processArtifactJob` modify 분기가 `saveJobResult` 호출 (8546371) |
| modify 멀티파일 저장 누락 | **해소**: B5 병합 파일까지 새 버전에 저장 (e8a19b6) |

modify 정상 경로는 실DB 테스트 T3로 현재도 동작함을 확인했다 (v2 생성+파일 저장).
즉 "수정하면 항상 실패"가 아니라, 아래 실패 모드들이 섞여 있었다.

## 2. 이번에 확정한 결함 3건 (전부 실DB 재현 → 수정 → 카나리아 확인)

재현·검증: `tests/integration/studio-job-save-real.test.ts` (better-sqlite3에
실제 마이그레이션 적용, `processArtifactJob`을 실제 SQL로 실행).
수정 전 3건 실패(T1·T2·T4), 수정 후 4건 전부 PASS. T3는 수정 전후 모두 PASS인 회귀 가드.
전체 Jest 577 스위트·11,477 테스트 전부 PASS (stryker 샌드박스 중복 포함),
`tsc --noEmit` PASS. (병행 실행 중 1회 관측된 flaky-e2e 실패는 재실행에서
재현되지 않았다 — 동시 실행 중이던 뮤테이션 샌드박스 간섭으로 기록만 한다.)

### D1. 사전 연결된 create 잡의 버전 생성 누락 (modify와 같은 §3의 형제 결함)
- `POST /jobs`는 프로젝트=대화 모델(d2bd861~)로 artifact를 먼저 만들고 job에
  연결하므로, 프로덕션 create 잡은 **항상** `artifact_id`가 채워져 있다.
- 그런데 `processArtifactJob` §3는 `!resultArtifactId`일 때만 버전·파일을 만들고,
  modify일 때만 `saveJobResult`를 불렀다. create+사전연결은 어느 분기에도
  걸리지 않아 **버전 0개·파일 0개로 잡만 done**이 됐다.
- 수정: create+사전연결 분기에서 `saveJobResult` create 경로에 위임
  (버전 존재 검사 포함 — 재시도 멱등성 유지) + 새 버전에 워크스페이스 파일 저장.

### D2. lease 형식 불일치 — 죽은 잡이 그날 내내 'running'에 갇힘
- `processArtifactJob`의 claim은 `lease_expires`에 ISO 문자열
  (`2026-..T..Z`)을 저장하고 `datetime('now')`(`2026-.. ..`)와 문자열 비교했다.
  같은 날짜에서는 `'T'(84) > ' '(32)`라 만료 판정이 영원히 거짓이 된다.
  (형식이 epoch인 `claimJob`은 큐 경로에서 쓰이지 않는다.)
- 결과: 실행 중 죽은 잡은 재획득 불가 → 큐 재시도는 `busy`만 받다가 소진,
  잡은 영구 running. 프론트 `pollJob`에는 전체 타임아웃이 없어 사용자는
  무한히 "작업 중"만 본다.
- 수정: `claimJob`과 같은 unixepoch(초) 문자열로 통일하고
  `CAST(lease_expires AS INTEGER) <= unixepoch('now')`로 비교.
  기존 ISO 행은 CAST가 연도(2026)로 읽어 즉시 만료 판정되므로 이관 불필요.
  주의: 배포 직후 아직 running인 구형(ISO) 잡이 있으면 재획득될 수 있으나,
  결과 저장은 lease_token 검증을 거치므로 늦게 끝난 쪽은 `busy`로 버려진다.

### D3. modify 무변경의 가짜 성공 — "완료"인데 버전 이력에 없음
- 에이전트 결과가 기존 내용과 동일하면 `saveJobResult`가 해시 중복으로
  버전 생성을 건너뛰는데(version.skipped), `processArtifactJob`은 이를
  무시하고 잡을 `done`으로 표시했다. 사용자에게는 수정 완료로 보이고
  버전 이력에는 아무것도 남지 않아, 원래 증상("v2가 남지 않는다")과
  정확히 같은 모습이 된다.
- 에이전트가 도구를 하나도 쓰지 않아도 이 경로에 도달한다:
  `runStudioAgent`는 `initialFiles`가 있으면 도구 호출 0개×2턴을
  `ok:true`+기존 파일 그대로로 반환한다 (관문 7 테스트가 이 동작을 고정 중).
- 수정: 무변경이면 done으로 위장하지 않고
  `변경 사항이 없어 새 버전을 만들지 않았습니다…`를 사유로 `failed` 기록.
  버전 스킵 정책과 version.skipped 이벤트는 그대로 둔다.
  기존 단위 테스트 2건("동일 내용이면 done")을 새 동작으로 갱신했다.

## 3. 운영 데이터 (읽기 전용, 부분)

- D1 일일 행 읽기 한도(7500) 도달 전에 성공한 집계는 1건뿐이다:
  `artifact_jobs` — done: create 8·modify 10 / failed: create 27·modify 3 /
  pending: create 2. 이후 쿼리는 전부 7500으로 차단되어 실패 오류 분포,
  version.skipped 건수는 **미확인** (우회하지 않았다).
- create 실패 27건이 D1 수정과 같은 원인인지는 오류 접두사 분포를 봐야
  알 수 있다 — §5 실험 1.

## 4. 배제된 가설

- "큐 자체가 동작하지 않는다": 배제. modify 정상 경로 실DB 통과 + 운영
  done 잡 존재.
- "프론트 응답 형식 불일치(jobId)": 배제. 현재 routes는 `data:{jobId}`,
  프론트 `callAiJob`은 `jr.data.jobId`로 일치 (관문 32 반영 확인).
- "미리보기/생성은 별도 경로라 무관": 부분 배제. 미리보기는 버전 파일
  기반이라, 버전이 없는 잡 결과는 미리보기에도 나타나지 않는다 (§2-D1).

## 5. 남은 가설과 다음 실험 설계

### H-A. Gemini 첫 턴 `allowedFunctionNames: ['create_file']` 강제가 modify를 방해
- 근거: 시스템 프롬프트 예시와 modify 지시는 search/read→edit 순서인데,
  Gemini 첫 턴은 create_file만 허용된다. 단일 파일 앱은 전체 재작성으로
  우회될 수 있어, 실모델 행동을 측정하기 전에는 단정할 수 없다.
- 실험: 배포 후 라이브에서 단일 파일 앱 modify 5회 + 멀티파일 앱 modify 5회.
  `artifact_job_events`의 `agent.tool_calls` 첫 도구 분포와 성공(v+1 생성)
  비율을 기록한다. 첫 도구가 전부 create_file이고 멀티파일 성공률이
  유의하게 낮으면, modify에서만 첫 턴 제한을 푸는 수정을 검토한다.

### H-B. wall-clock 예산 5분 vs 턴 예산 7×120초=14분의 불일치
- 근거: `job-processor`는 maxTurns 7(주석: lease 14분 내 보장)이지만
  `runStudioAgent` 기본 예산은 5분이라, 느린 modify는
  `AGENT_WALL_CLOCK_BUDGET`으로 실패한다. 사용자 기준("5분 넘으면
  의미없지")으로 의도된 값인지, 라이브 실패의 주범인지는 미측정.
- 실험: 한도 회복 후 읽기 전용으로 `artifact_jobs.error` 접두사와
  `artifact_job_events`의 `job.failed` 페이로드에서
  `AGENT_WALL_CLOCK_BUDGET` 건수·비율을 센다. modify 실패의 과반이면
  예산을 lease에 맞춰 올리는 것을, 소수면 현행 유지.

### H-C. 에이전트 무도구 종료의 빈도 (D3의 상류)
- D3 수정으로 무변경은 이제 `failed`+사유로 **관측 가능**해졌다.
- 실험: 배포 후 1주간 무변경 실패 건수와 전체 modify 건수 비율을 센다.
  비율이 높으면 관문 7의 "initialFiles+무도구=성공" 판정 자체를
  재검토한다 (대화 모드와 수정 모드의 분리).

### 공통 라이브 E2E (배포 후, 코디네이터/사용자 몫)
1. 기존 앱에 "버튼 색 변경" modify → v+1 생성·파일 트리·diff 표시 확인
2. 변경이 불가능한 요청(이미 파란 버튼에 "파랗게 해줘") → 무변경 실패
   메시지가 채팅에 표시되는지 확인
3. 3분 이상 걸리는 modify → `Failed to fetch` 없이 폴링으로 종단 도달 확인

## 6. NOT TESTED

- 실모델(Gemini) 라이브 호출을 동반한 종단 E2E — 이 트랙 범위 밖
  (배포 후 §5 절차로 수행).
- 운영 D1의 실패 오류 분포·이벤트 통계 — 7500 한도로 미확인.
- 브라우저 실동작 (VM에서 Chromium 불가) — 프론트 변경은 없으므로
  코드 계약 테스트로 대체했다.
- `pollJob` 무한 폴링 자체의 상한 추가 — D2로 stuck 빈도는 줄지만
  폴링 상한은 별도 과제로 남긴다.

## 7. 후속 — 실모델 E2E 성공률 측정 (2026-11-01, GPT 7.2 대응 트랙 4)

§6에서 NOT TESTED로 남긴 "실모델 라이브 종단 E2E"를 운영에서 수행했다.
방법: OTP 세션(테스트용)으로 POST /api/artifact/jobs에 throwaway 앱
생성→수정 사이클을 제출하고 잡 상태를 폴링·D1으로 대조. 모델은 운영
기본값(잡 제출 시 provider/model 미지정).

| 구분 | 시도 | done | failed | 비고 |
|---|---|---|---|---|
| create | 4 | 4 | 0 | 각 21-22초 (잡 161·163·165·167) |
| modify | 4 | 4 | 0 | 각 21초 (잡 162·164·166·168) |

- 내용 검증 (검증 사이클, 아티팩트 30): create 후 v1 1개
  (sha256 800f3829…, 10,326자) → modify 후 **v2 생성 + 해시 변경
  (7051f72c…) + 길이 변경(9,219자)** 을 D1 artifact_versions에서 직접
  확인 — §본문의 "무변경 가짜 성공" 패턴이 아님을 실물로 대조했다.
  나머지 3개 modify는 잡 상태 done·오류 없음까지 확인 (버전 대조는
  검증 사이클 1건으로 갈음).
- 실패 모드: 이번 표본(8잡)에서는 실패 0건. 과거 결함 3건(create 버전
  누락·lease 형식·무변경 가짜 성공)의 재현 없음.
- 정리: throwaway 아티팩트 7개(24-30 — 초기 경로 오기로 제출된 고아
  3개 포함)를 DELETE /api/artifact/:id로 전부 삭제 (각 200). 잡·버전·
  채팅은 삭제 핸들러의 batch로 함께 제거된다.
- 측정 중 발견한 사소한 사실 2건 (결함 아님): 모듈 마운트 경로는
  /api/artifacts가 아니라 /api/artifact(단수)이고, 잡 제출 응답의
  식별자는 data.jobId다. 측정 스크립트만 고쳐서 진행했다.
