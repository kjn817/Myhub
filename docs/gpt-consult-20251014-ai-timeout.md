# GPT 자문 요청: AI 스튜디오 NVIDIA 타임아웃 문제 (2026-10-14 19:30)

## 현재 상황

### 해결된 것
1. **30초 waitUntil 문제**: Queue + Workflow로 해결
   - `POST /api/artifact/jobs` → D1에 job 생성 → Workflow 실행
   - Workflow: `nova-workflow` (wrangler로 정상 배포됨)
   - 프론트엔드는 D1 폴링으로 상태 확인

2. **P0 4건**: 모두 수정 완료
   - Lease 시각 비교 (unixepoch)
   - owner_email 격리
   - Workflow→Queue 폴백 제거
   - UNIQUE 제약으로 멱등성

3. **취소 API**: 구현 완료
4. **재시도 정책**: Queue 4회 × 내부 1회로 정리

### 현재 문제: "AI 타임아웃 (60초)"

**증상:**
- Workflow는 정상 실행됨
- AI 호출 단계에서 60초 타임아웃 발생
- 2회 시도 모두 동일하게 실패

**시도한 것:**
1. `callSingleAssistant(env, 'builder', ...)` → "no active model for policy" 오류
   - 원인: 복잡한 정책 시스템 (ModelRouter, sensitivity, providerPin)
   - `model.code = 'moonshotai/kimi-k3'` (nvidia provider, status=active)
   - `checkProviderAllowed('nvidia', 'general')`이 false를 반환하는 것으로 추정

2. 직접 NVIDIA API 호출로 우회 → 60초 타임아웃
   - `model.code`를 `poolside/laguna-xs-2.1`로 복원 (원래 동작하던 모델)
   - 여전히 타임아웃

**의문점:**
- NVIDIA API 키가 유효한가? (환경 변수 `NVIDIA_API_KEY_1`)
- `moonshotai/kimi-k3` 모델이 NVIDIA에서 실제로 동작하는가?
- `poolside/laguna-xs-2.1`도 타임아웃인 이유는?
- 60초 타임아웃이 너무 짧은가? (복잡한 HTML 생성에는 부족할 수 있음)

## 질문

1. NVIDIA API 타임아웃의 근본 원인은 무엇인가?
2. 60초 타임아웃을 늘려야 하는가? (Workflow는 최대 30분 실행 가능)
3. 복잡한 정책 시스템(ModelRouter)을 백그라운드 작업에서 우회하는 것이 맞는가?
4. 아니면 정책 시스템의 버그를 찾아서 수정해야 하는가?
