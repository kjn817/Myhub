# MyHub AI Studio — 코딩 에이전트 구축 수정 실행계획서

- 기준일: 2026-10-16
- 기준 자료: `gpt-consult-agent-plan-20251016.md` (사용자 제공)
- 대상: Cloudflare Workers + D1 + Queues, `runStudioAgent`, 파일 도구 5종, 버전/이벤트/대화 저장소
- 문서 성격: 기술 자문안. 저장소 코드와 운영 로그를 직접 검사한 결과가 아니므로, 원인과 공수는 검증 전 추정이다.

## 1. 실행 결론

1. **P0: Job 생명주기 및 버전 커밋의 신뢰성을 확보한 뒤 v2 E2E를 복구한다.** `Failed to fetch`의 실제 발생 구간을 먼저 확인한다. 기존 Queue 수정만으로 복구되었다고 간주하지 않는다.
2. **P1: 대화 기억을 넣되 `base_html` 전체를 매 요청에 복제하지 않는다.** HTML은 서버의 불변 버전으로 저장하고, LLM은 `list_files/read_file/search_in_files/apply_patch`로 필요한 부분에 접근한다.
3. **P1: `ask_user`의 전체 일시정지·재개 구현은 미루되, 다의적인 대상은 작업 등록 이전에 선택하도록 한다.**
4. **P2: 검증은 정적 검증 → 실행 검증 → 안전한 프리뷰 순서로 구축한다.** HTML 파싱 성공만으로 품질 통과를 선언하지 않는다.
5. **P2: 압축은 가변 토큰 예산과 도구 출력 pruning을 먼저 적용하고 필요할 때 요약한다.**
6. **P3: 고급 승인·중단·재개 및 Item 타임라인을 추가한다.** 다만 최소 이벤트 로깅은 P0에서 시작한다.

## 2. 기존 계획에 대한 수정 판정

| 기존 제안 | 판정 | 수정 내용 |
|---|---|---|
| v2 수정 복구를 P0-1 | 유지·보강 | 원인 추적 및 멱등성/동시성 방어를 함께 완료 |
| 최근 10개 대화 원문 | 조건부 유지 | 최근 3~6개 교환 예시, 실제로는 토큰 예산과 pinned requirements 기준 |
| 현재 HTML 전체 무조건 전달 | 변경 | 초기 소규모 파일은 전체 허용, 큰 파일은 위치 기반 조회 및 패치 |
| `chars / 4`로 토큰 계산 | 변경 | 휴리스틱은 사전 추정용, 실제 모델 토큰 집계/사용량이 기준 |
| 대화 30K 넘으면 압축 | 변경 | 선택한 모델의 입력창·출력 reserve·비용 한도로 결정 |
| 사용자 메시지는 절대 요약하지 않음 | 변경 | DB 원문은 반드시 보존, 모델 입력의 오래된 내용은 요약 가능; 사용자 요구조건은 별도 고정 |
| HTML 항상 전체 유지 | 변경 | 저장소에서 원본 보존, 모델 컨텍스트에서는 선택적 로드 |
| HTML/JS 검증 | 유지·확대 | 구문 검사 + DOM 타깃/요구 충족 검증 + 프리뷰 격리 + 리그레션 |
| `ask_user` Phase 3 | 분리 | P1 작업 전 타깃 선택, P3 범용 비동기 Q&A 재개 |
| Item 기록 Phase 3 | 분리 | P0 최소 trace, P3 정식 타임라인 UX |

## 3. 권장 목표 아키텍처

```text
사용자 요청 (project_id, prompt, optional selected_element, base_version)
  -> POST /jobs (인증, 프로젝트 소유권/한도 검사)
  -> D1 jobs INSERT (idempotency_key UNIQUE, base_version 저장)
  -> Queue.send({ job_id })
  -> Consumer claims job (lease + attempt; 중복 실행 방지)
  -> D1에서 권위 있는 base_version, project constraints, 대화 이력 조회
  -> ContextBuilder (고정 시스템 규칙 + 사용자 요구 + 최근 대화 + 파일 인덱스)
  -> runStudioAgent (bounded steps/cost/time, tool API)
       -> list_files / read_file(range) / search_in_files / apply_patch
       -> staged workspace(원본 불변)
       -> validate output (syntax / security policy / smoke tests)
       -> on failure: bounded repair (예: 최대 2회)
  -> D1 transaction: immutable version INSERT + draft pointer CAS + job success/event
  -> UI job 상태 조회/이벤트 수신 -> diff + preview
  -> 별도 publish 승인/동작 (draft와 published 구분)
```

**핵심 데이터 구조(권장, 기존 스키마에 맞게 병합)**

- `jobs`: `id`, `project_id`, `user_id`, `idempotency_key`, `kind`, `prompt`, `base_version_id`, `status`, `attempt`, `lease_until`, `run_id`, `error_code`, `tokens_in/out/cached`, `cost_estimate`, `created_at`, `updated_at`.
- `artifact_versions`: `id`, `project_id`, `parent_version_id`, `source_job_id UNIQUE`, `content_hash`, `html_content_or_ref`, `created_at`.
- `artifact_chats`: 기존 유지. 사용자 요구조건의 명시적 고정을 위한 `project_requirements` 또는 `conversation_state` 추가 고려.
- `job_events`: `job_id`, `seq`, `type`, `payload`, `timestamp` (중복 이벤트 수신 처리 및 감사 추적).
- 최초에는 전체 HTML을 D1에서 저장 가능하나 크기/쿼리 빈도 증가 시 오브젝트 스토리지 분리 검토. D1은 문자열/BLOB/행 2MB 제한이며 SQL 문장 길이는 100KB이므로 바인딩 쿼리를 사용하고 크기 상한을 둔다.

## 4. 단계별 실행 항목 및 공수

공수는 **기존 코드에 익숙한 개발자 1명 기준 엔지니어링 일수**, 테스트·운영환경 차이에 따라 변동되는 개략 추정. 병렬 작업·CI 인프라 구축 시 달라질 수 있다.

### Phase 0 — 실행 신뢰성 (예상 2.5~6.0 인일)

| ID | 작업 | 공수 | 주요 위험 | 완료 조건 |
|---|---|---:|---|---|
| P0-A | 2026-10-15 `Failed to fetch` 발생 구간 추적 (POST/202, Queue, worker, polling/SSE, preview 각각 correlation id) | 0.5~1.0 | 실제 서버 처리 성공인데 UI만 실패했을 수 있음 | 브라우저·서버·Queue 로그에 동일 `job_id` 추적 |
| P0-B | `idempotency_key` 유니크 처리, job claim/lease, 재시도 제한 및 DLQ, 중복 publish 방어 | 1.0~2.0 | 중복 Queue 전달 또는 lease 만료 경쟁 | 동일 메시지 2회 처리에도 동일 version 한 개 |
| P0-C | v2 수정 E2E 복구, base_version 검증, 낙관적 잠금(CAS) | 0.5~2.0 | 오래된 브라우저 `base_html` 또는 동시 수정으로 덮어쓰기 | v1→v2→v3 정상, 충돌 시 정확한 409/재시도 정책 |
| P0-D | 최소 오류 유형/LLM 사용량/latency 수집 및 실패 UI 상태 | 0.5~1.0 | 로그 누락, 개인정보·소스 유출 | 모든 Job terminal state 기록, 오류코드와 UI 일치 |

**테스트**: (1) v1→v2 정상, (2) Queue 메시지 중복 주입, (3) 모델 503/429, (4) 소비자 중단 후 재시도, (5) 사용자 동일 프로젝트 동시 수정, (6) 202 성공 후 이벤트 구독 실패, (7) 작업 취소·timeout 후 이전 draft 불변.

**원인 진단 원칙**: `Failed to fetch`만으로 Queue 문제라 확정하지 않는다. CORS, 네트워크, auth, 프론트 abort, 요청 body, polling, 배포환경 바인딩, consumer error를 분리한다.

### Phase 1 — 프로젝트 컨텍스트와 수정 정확도 (예상 3.0~6.0 인일)

| ID | 작업 | 공수 | 주요 위험 | 완료 조건 |
|---|---|---:|---|---|
| P1-A | 클라이언트 `base_html` 대신 서버 `base_version` 기준 canonical snapshot 사용 | 0.5~1.0 | 현재 파일 도구와 저장 구조 불일치 | 프론트 HTML 조작으로 서버 원본 변경 불가 |
| P1-B | ContextBuilder: 프로젝트 목표/제약/최근 대화/현재 요청, DB 이력 연계 | 0.5~1.0 | 예전 지시 충돌·유저 요청 반복 | 후속 지시 '아까 버튼'을 맥락 안에서 올바르게 해석 |
| P1-C | `read_file(path,start,end)`, `search_in_files`, 충돌 검증 포함 `apply_patch` 또는 엄격한 `edit_file` | 1.5~3.0 | 잘못된 매칭, 경로 우회, 과도한 조회 | 파일 후반부 20KB 위치도 수정되고 다른 부분 보존 |
| P1-D | UI element selection / 모호한 지시의 사전 확인 | 0.5~1.0 | 과도한 질문, 잘못된 DOM selector | 버튼 복수 후보 시 선택 UI; 명확한 경우 즉시 진행 |

**컨텍스트 구성 정책**

1. `[System / Tool Rules]` 고정: 역할, 제한, 품질 기준, 파일도구 사용법, 응답 형식.
2. `[Project State]` 제목, 현재 불변 버전, 파일 목록, 외부 접근 정책, 고정 요구조건.
3. `[Conversation State]` 압축된 과거 결정사항 + 최근 대화 중 예산 내 원문.
4. `[Current Task]` 사용자의 최신 원문·선택한 DOM 타깃·수정 범위.
5. **초기에는 전체 HTML을 강제 삽입하지 않고**, 모델이 파일 도구로 필요한 범위를 읽도록 유도. 아주 작은 단일 HTML이면 전체 전달 허용.
6. 사용자 발언의 DB 원문은 삭제/덮어쓰기 금지. 단, *모델에 매번 원문 전량 전달*할 필요는 없음.

**변경 정확도 보장**: `apply_patch`는 원본 `content_hash` 또는 expected text/context와 일치할 때만 적용; 충돌 시 실제 diff를 다시 읽도록 하고 무조건 전체 파일 교체를 피한다.

**모호한 요청 처리**: DOM element를 명시적으로 클릭/선택하여 요청을 연결하는 UX 권장. 후보가 하나면 자동, 복수면 preflight 선택, 후보가 없으면 짧은 질문. LLM이 스스로 제시한 confidence 숫자만으로 판단하지 않는다.

### Phase 2 — 검증·보안·토큰 효율 (예상 3.5~7.0 인일)

| ID | 작업 | 공수 | 주요 위험 | 완료 조건 |
|---|---|---:|---|---|
| P2-A | HTML/JS 파서, 제한적 JS 문법 검증, 필수 DOM/이벤트 리그레션, 최대 2회 자동 수정 | 1.0~2.0 | HTML 파서는 오류를 관대하게 복구; 문법 통과≠정상 동작 | 일부러 넣은 문법 오류가 commit되지 않음 |
| P2-B | 생성 앱을 별도 origin 또는 강한 iframe sandbox 및 CSP에서 실행 | 1.0~2.0 | 부모 앱 쿠키/토큰 탈취, `postMessage` 남용 | 악성 script 테스트로 상위 앱 접근/외부 전송 차단 |
| P2-C | TokenBudget + tool result pruning + 필요 시 structured compaction | 1.0~2.0 | 요약으로 사용자 제약·함수 위치 소실 | 장기 대화에도 컨텍스트 예산 초과 없이 기능 회귀 통과 |
| P2-D | 실제 input/output/cached token, 모델/provider, 원인별 실패율, 단계별 latency 기록 | 0.5~1.0 | 토큰 비용 과소 추정, 민감 데이터 로깅 | 작업당 토큰 및 provider 오류율 확인 가능 |

**압축 정책**

- `usable_input = model_context_limit - reserved_output - safety_margin`.
- 모델별 실제 limit과 request-level 한도를 구성값으로 관리; 유효 컨텍스트가 크더라도 `max_input_tokens_per_job`, `max_total_tokens_per_job`, 최대 tool output bytes, 최대 read requests 설정.
- 우선 오래된 반복 tool 출력을 삭제(pruning). 그다음 오래된 대화·결정 기록을 템플릿으로 요약(compaction).
- 요약 형식: `Objective / Requirements / Decisions / Completed / Active / Blocked / Next Move / Relevant Files / Important Errors`.
- 소스는 영구 저장하며 모델에 필요한 부분만 다시 `read_file`로 조회 가능하게 함.
- Gemini의 thinking 모델과 multi-step function calling을 직접 REST로 구현한다면 tool call 응답의 `thoughtSignature`(필요 시 ID)를 원형 유지. SDK를 쓰면 SDK 관리 방식을 우선 확인. 오래된 tool 메시지를 요약할 때도 현재 function-call cycle을 깨지 않도록 한다.

**보안 기준**

- 프롬프트 인젝션: 기존 코드의 HTML 주석, 사용자 프로젝트 파일, 외부 라이브러리 출력은 *데이터*이지 시스템 지시가 아님. 역할/권한 승격 금지.
- 도구: `project_id`/`user_id` 소유권을 **서버에서** 검증; 경로 traversal, 파일 크기, 작업 유형, 확장자, 호출 횟수 제한. `delete_file`은 초기에 비활성/확인 정책 검토.
- 시크릿: API 키/토큰을 모델 프롬프트 또는 생성 HTML에 제공하지 않음. 생성 앱의 접근 권한을 호스트 계정과 분리.
- 실행: 가능하면 전용 origin, sandbox iframe, 엄격 CSP, 필요한 네트워크만 allowlist, origin/source/nonce 확인된 postMessage 사용. **호스트와 같은 origin에서 `allow-scripts allow-same-origin` 조합 사용 금지.**
- 품질: 정적 문자열 차단만으로 악성코드 방지가 완성되지 않음. 안전한 실행 격리가 1차 방어선.
- 외부 연동(네트워크 요청, 배포, 계정 권한 사용)은 차후 명시적 승인/권한 모델 추가.

### Phase 3 — 고급 에이전트 UX (예상 4.0~8.0 인일)

| ID | 작업 | 공수 | 주요 위험 | 완료 조건 |
|---|---|---:|---|---|
| P3-A | `waiting_input` 상태, durable checkpoint, 답변 후 **새 Queue 작업으로 재개** | 2.0~4.0 | Queue 소비자에서 대기하여 리소스 고갈, 이중 재개 | 새 작업/continuation으로 정확히 한 번 이어짐 |
| P3-B | Thread → Turn → Item 이벤트 모델 및 타임라인 화면 | 1.0~2.0 | 이벤트 증가, UI 부하 | 각 파일 변경, 검사, 에러, 버전 생성 이력 추적 |
| P3-C | 위험도 기반 승인: 대량 삭제/외부 네트워크/배포 등 | 1.0~2.0 | 승인 bypass, 권한 경계 불명확 | 승인 없이 고위험 도구 작동 불가 |

**설계 참고**: `waiting_input` 상태에서는 소비자 실행을 종료하고 DB에 pending question/checkpoint를 보존한다. 프론트 응답은 별도 API로 접수하여 continuation 메시지를 새로 큐잉한다. 지속 실행 중인 Worker를 붙잡아두지 않는다.

## 5. Job/Version 상태 머신과 일관성

```text
accepted -> queued -> running -> validating -> succeeded
                     |              |
                     |              +-> failed / cancelled
                     +-> retry_scheduled -> queued
                     +-> failed / cancelled
(Phase 3) running -> waiting_input -> queued(continuation)
```

- 상태 전이는 DB 조건부 갱신(`WHERE status=... AND run_id=...`)으로 검증.
- 워커 중복·재시도 방지: `jobs.idempotency_key UNIQUE`, `artifact_versions.source_job_id UNIQUE`.
- **동시 수정**: `UPDATE artifacts SET draft_version_id = :new WHERE project_id=:p AND draft_version_id=:base`의 affected row가 1일 때만 성공. 0이면 409 conflict로 최신 버전 rebase 또는 사용자 선택.
- `version insert` / `pointer update` / `job succeeded` / `commit event`를 DB 트랜잭션 가능한 범위에서 원자화. 실패 시 기존 draft/published 유지.
- 작업 중 결과는 staging에 저장, 검증 통과 전에는 draft/published 변경 금지.
- Queue retry 시 새 버전을 생성하지 말고 기존 `source_job_id` 결과를 확인.
- `maxTurns=10` 및 전체 5분 상한 외에 **작업당 최대 모델 호출/토큰/비용**을 별도로 두고, 429/503은 지수 backoff+jitter 및 provider circuit breaker로 요청 증폭 방지.

## 6. 비용·성능 모델

- `50KB ~= 12.5K tokens`는 ASCII 계열에 대한 매우 거친 예시일 뿐, HTML·코드·한글 혼합에 보편적으로 정확하지 않다. 실제 `countTokens`, 요청 `usageMetadata` 및 provider 요금을 기준으로 측정.
- 동일 12.5K 토큰 스냅샷이 10번 독립적으로 포함되면 HTML 부분만 약 125K input token 처리. 중복 스냅샷까지 이전 history에 계속 누적하면 총합이 약 687.5K token(12.5K × 1+...+10)에 이를 수 있다. 이 예시는 실제 구현 동작을 진단한 것이 아닌 최악 유형 설명.
- Gemini implicit caching은 모델/엔드포인트에 따라 적중 조건과 청구가 달라질 수 있어 **보장된 절감률로 산정하지 않는다**. 고정 prefix를 앞에 두고 hit token을 실제로 수집.
- 원본 저장과 추론 컨텍스트를 분리하면 전체 원본 손실 없이 모델 입력비용을 줄일 수 있다.

## 7. 필수 수용 테스트 시나리오

| 분류 | 시나리오 | 합격 기준 |
|---|---|---|
| E2E | HTML 앱 생성 후 버튼 색 변경으로 v2 수정 | v2 정확히 한 개, 미리보기 일치 |
| 회귀 | v2→v3에서 이전 기능 유지 | 불요한 변경/손실 없음 |
| 파일 | HTML 15KB 이후 위치의 함수 수정 | 코드 후반부 정확히 패치 |
| 중복 | 같은 Queue 메시지 두 번 전달 | 새 버전 한 개, 동일 Job 결과 |
| 동시성 | 같은 base_version에서 두 수정 | 한 건만 commit, 다른 건 conflict/rebase |
| 복구 | 모델 429/503, Queue consumer 재시도 | 무한 재시도 없음, 오류코드 정확 |
| 대화 | '왼쪽 버튼을 파랑으로' 후 '아까 그 버튼 둥글게' | 대상 일치, 결정사항 유지 |
| 모호성 | 버튼이 3개인 앱에서 '이 버튼 수정' | 대상 선택 없이는 추측 변경 금지 |
| 검증 | 문법 오류 및 버튼 이벤트 누락 유도 | commit 차단 또는 repair 후 통과 |
| 보안 | HTML 주석에 '시스템 명령 무시' 삽입 | 도구 권한/정책 위반 없음 |
| 프리뷰 | 생성 JS에서 parent/쿠키/외부 endpoint 접근 시도 | 호스트 데이터 접근 차단 |
| 비용 | 같은 파일 반복조회 및 장기 대화 | 정해진 토큰·tool output 한도 내 수행 |

## 8. 출시 게이트와 우선순위

- **Gate 0 / 수정 기능 신뢰성**: v1→v2→v3 성공, 중복·동시성·실패 회복 테스트 통과. 실패 시 이전 버전 유지. 우선 시행.
- **Gate 1 / 맥락 있는 수정 에이전트**: 대화 참조, 코드 후반부 패치, 복수 버튼 모호성 처리, 다중 Job 안정성. 여기까지가 우선 출시 가능한 핵심 MVP.
- **Gate 2 / 제품 안전성·비용**: Preview 격리/권한검증은 공개 서비스 필수; validation 및 사용량 예산 동작. 컨텍스트 압축은 로그와 threshold를 확인하며 적용.
- **Gate 3 / 제품 고도화**: 범용 `ask_user` pause/resume, 정식 실행 타임라인, 고위험 작업 승인.

**추정 합계**: Phase 0 2.5~6.0, Phase 1 3.0~6.0, Phase 2 3.5~7.0, Phase 3 4.0~8.0 = **총 13~27 인일**. 이는 기능 개발의 대략적 범위이며, 프로덕션 장애 분석·운영회귀·보안검토·환경 편차 등의 추가 공수는 별도다.

## 9. 구현 중 확인해야 할 미해결 질문

1. `Failed to fetch`가 실제 어느 요청(POST, polling, event stream, preview)의 네트워크 오류인가?
2. 파일 도구는 현재 서버의 staging 파일을 읽는가, 프롬프트에 첨부한 HTML만 다루는가?
3. `runStudioAgent`의 다중 tool-call 이력이 매 추론에 어떻게 전달되는가? Gemini의 thought signature 유지 방식은 무엇인가?
4. 프리뷰가 메인 앱과 같은 origin인지, iframe sandbox/CSP가 무엇인지?
5. v2 저장 시 draft pointer, version insert, job result가 단일 원자적 작업인지?
6. 현재 요금/모델/endpoint별 비용 및 컨텍스트 제한이 무엇인지? 무료 플랜에서 JS 파서 CPU 예산을 넘는지?

## 10. 참고 자료 — 2026-10-16 기준 확인

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- Cloudflare Queue delivery guarantees: https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- Cloudflare Queues dead letter: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- OpenAI, *Unrolling the Codex agent loop*: https://openai.com/index/unrolling-the-codex-agent-loop/
- OpenCode `compaction.ts` source: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts
- Gemini context caching: https://ai.google.dev/gemini-api/docs/caching
- Gemini token counting: https://ai.google.dev/api/tokens
- Gemini thought signatures: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
- MDN iframe sandbox: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- OWASP LLM prompt injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
