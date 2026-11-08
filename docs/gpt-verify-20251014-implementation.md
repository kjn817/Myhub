# GPT 검증 요청: MyHub AI 스튜디오 백그라운드 작업 구현 완료

## 구현 개요
GPT 권고(2026-10-14)에 따라 `waitUntil()` 30초 제한 문제를 해결하고,
장기 로드맵인 Workflows 다단계 에이전트까지 구현함.

## 1. 아키텍처

```
사용자: "계산기 앱 만들어줘"
    ↓
POST /api/artifact/jobs
    ↓
D1 artifact_jobs에 pending 생성
    ↓
Nova Workflow 실행 시도
    ↓ (실패 시)
Cloudflare Queue로 폴백 (myhub-artifact-jobs)
    ↓
Queue Consumer (최대 15분 실행)
    ↓
processArtifactJob()
    ↓
D1에 아티팩트/버전 저장, status='done'
    ↓
프론트엔드 폴링으로 결과 확인
```

## 2. 구현된 GPT 권고사항

### 2.1 AbortSignal 전파 ✅
**전파 경로:**
```
job-processor (60초 타임아웃)
  → callSingleAssistant(env, 'builder', messages, { signal })
    → aiChat(env, policy, messages, { ..., signal })
      → callNVIDIA(key, model, messages, tools, signal)
      → callGroq(key, model, messages, signal)
      → callGemini(env, key, model, messages, ..., signal)
        → callGeminiDirect(key, model, body, signal)
        → callGeminiViaRelay(env, key, model, body, signal)
      → callWorkersAI(env, model, messages, tools, signal)
```

**변경 파일:**
- `src/services/ai.ts`: 모든 provider 함수에 `signal?: AbortSignal` 파라미터 추가
  - signal이 없으면 기존 `AbortSignal.timeout(25000/30000)` 폴백 유지
  - signal이 있으면 외부에서 전달된 signal 사용
- `src/modules/ai/routes.ts`: `callSingleAssistant`에 `options.signal` 추가, `aiChat` 호출 시 전달
- `src/modules/artifact/job-processor.ts`: 60초 타임아웃의 AbortController 생성 후 전달

### 2.2 재시도 정책 통합 ✅
**변경 전:** Queue 3회 × 내부 3회 = 최대 9회 (중첩)
**변경 후:** Queue 3회 × 내부 2회 = 최대 6회

- Queue 레벨 (`wrangler.toml`): `max_retries = 3`
- 내부 (`job-processor.ts`): `maxTries = 2`
- Queue는 인프라 장애 시, 내부는 transient AI 오류 시 재시도

### 2.3 오류 분류 ✅
```typescript
// 429: Queue 재시도에 위임 (내부 즉시 중단)
if (code === 429) { lastErr = 'rate_limited (429)'; break; }

// 영구 오류: 재시도 무의미
if (code === 401 || code === 403 || /unknown_persona|empty|too_long/.test(msg)) {
  lastErr = `영구 오류: ${msg}`; break;
}

// 5xx: 재시도 대상
// 타임아웃: 재시도 대상
```

### 2.4 Lease 메커니즘 ✅
**D1 스키마 추가:**
```sql
ALTER TABLE artifact_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE artifact_jobs ADD COLUMN lease_expires TEXT;
```

**Claim 로직:**
```typescript
const leaseToken = crypto.randomUUID()
const leaseExpires = new Date(Date.now() + 14 * 60 * 1000).toISOString()
UPDATE artifact_jobs
SET status='running', lease_token=?, lease_expires=?
WHERE id=? AND (
  status='pending'
  OR (status='running' AND (lease_expires IS NULL OR lease_expires < datetime('now')))
)
```

**결과 저장 시 검증:**
```typescript
UPDATE artifact_jobs SET status='done', ...
WHERE id=? AND status='running' AND lease_token=?
-- lease를 잃으면 0 rows updated → 결과 버림
```

### 2.5 멱등성 ✅
- `saveJobResult`: 같은 jobId로 이미 생성된 아티팩트 확인 후 스킵
- 중복 버전 방지: `content_hash`로 기존 버전 확인
- Queue at-least-once 전달에도 동일 아티팩트 중복 생성 안 됨

### 2.6 Nova Workflows (장기 로드맵) ✅
**파일:** `src/modules/artifact/nova-workflow.ts`

**단계:**
1. `claim-job`: Lease 획득
2. `analyze-requirements`: 프롬프트 정제
3. `generate-html`: AI 호출 (retries: 3, timeout: 5분)
4. `validate-code`: HTML 구조·크기 검증
5. `save-result`: 아티팩트/버전 저장 (멱등성)
6. `mark-done`: 완료 표시

**특징:**
- 각 단계 상태가 Workflows에 자동 보존
- 실패 시 해당 단계부터 재시도
- Workflow 실패 시 Queue로 자동 폴백

**wrangler.toml:**
```toml
[[workflows]]
name = "nova-workflow"
binding = "NOVA_WORKFLOW"
class_name = "NovaWorkflow"
```

### 2.7 Durable Objects
GPT 판단("별도 필요성 없음")에 따라 미구현.
실시간 협업/세션 공유 필요 시 추가 예정.

## 3. 멈춘 작업 처리
- 4개의 `running` 작업을 `failed`로 정리 완료
- 해당 시간대에 생성된 아티팩트 0건 확인 (데이터 손실 없음)
- 사용자에게 재시도 안내

## 4. 검증 요청사항

### 4.1 아키텍처 검증
1. Workflow → Queue 폴백 구조가 적절한가?
2. Lease 14분 vs Queue 15분 제한의 여유가 충분한가?
3. 내부 2회 + Queue 3회 = 6회가 적절한가?

### 4.2 코드 검증
1. AbortSignal 전파 경로에 누락된 곳이 있는가?
   - 특히 `callGemini` → `callGeminiDirect`/`ViaRelay` 경로
   - `aiChat` 내 두 번째 호출 (followUpMessages)
2. Lease 토큰 검증 로직에 race condition이 있는가?
3. 멱등성 보장 로직에 빠진 케이스가 있는가?

### 4.3 엣지 케이스
1. Workflow 실행 중 Worker가 재시작되면?
2. Queue 메시지가 DLQ로 이동하는 조건은?
3. 사용자가 작업을 취소하려면 어떻게 해야 하는가? (현재 미구현)
4. 동일 프롬프트로 중복 요청 시 어떻게 되는가?

### 4.4 보안
1. 다른 사용자의 jobId를 추측하여 조회할 수 있는가?
   - 현재: 인증은 되지만 사용자별 격리 없음
2. Queue에 악의적인 jobId를 전송하면?
3. Workflow params의 prompt 길이 제한이 있는가?

## 5. 테스트 계획 (미실시)
GPT가 제시한 18개 테스트 중 핵심:
- [ ] AI 5초 응답 → 정상 완료
- [ ] AI 40초 응답 → Workflow에서 정상 처리
- [ ] AI 90초 응답 → Queue Consumer에서 처리
- [ ] 브라우저 종료 후 재접속 → 작업 이어받기
- [ ] Queue 메시지 중복 전달 → 아티팩트 1개만 생성
- [ ] 429 오류 → 재시도 후 성공

## 6. 변경 파일 목록
- `src/services/ai.ts`: AbortSignal 전파
- `src/modules/ai/routes.ts`: callSingleAssistant signal 지원
- `src/modules/artifact/job-processor.ts`: Lease, 재시도, 오류 분류, 단계별 함수
- `src/modules/artifact/nova-workflow.ts`: 신규 (Workflows 정의)
- `src/modules/artifact/routes.ts`: POST /jobs를 Workflow 트리거로 변경
- `src/types.ts`: ARTIFACT_QUEUE, NOVA_WORKFLOW 바인딩
- `src/index.ts`: queue 핸들러 + workflow export
- `wrangler.toml`: queues + workflows 설정
- `migrations/0035_artifact_jobs.sql`: lease 컬럼 추가
- `deploy_full.py`: esbuild --external:cloudflare:workers 추가

## 7. 커밋
- `224286d`: Cloudflare Queues로 백그라운드 작업 전환
- `c34b3d3`: GPT 권고사항 전체 구현 (AbortSignal, 재시도, 오류분류, Lease)
- `793ffdc`: Nova Workflows 다단계 에이전트 구현
