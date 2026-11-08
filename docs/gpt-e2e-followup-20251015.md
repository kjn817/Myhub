# GPT 자문 요청: E2E 3개 실행 문제 최종 정리 (2026-10-15)

## 현재 상태 요약

### 완료된 작업
- ✅ Clef-flash 라우터 구현 (GPT 수정본 적용)
- ✅ 실제 API 테스트 5건 전부 정확한 분류
- ✅ E2E 테스트 8건 중 7건 라우팅 정확 (87.5%)
- ✅ 노바 권한 오류 수정 완료 (운영 배포됨)
- ✅ Flag를 false로 복구 (안전 모드)

### 남은 문제 (2건)

---

## 문제 1: 에코 응답 반환 문제 (P0) - 미해결

### 증상
- "지난 대화 내용을 요약해줘" → 에코로 정확히 라우팅
- 응답이 "요청을 전달했습니다" 한 문장만 표시
- 실제 요약 내용 없음

### 추가 발견 사항

**1. 모델 불일치:**
E2E 테스트에서 에코가 사용한 모델: `llama-3.3-70b-instruct-fp8-fast` (Workers AI)
계획된 모델: `nvidia/nemotron-3-ultra-550b-a55b` (NVIDIA)

→ 에코의 모델 매핑이 아직 NVIDIA로 변경되지 않음. 이건 별도 작업 필요.

**2. Function Calling 활성화:**
```typescript
// src/services/ai.ts:772
const useFC = policy.personaId === 'keeper' && model.provider === 'workers-ai'
const tools = useFC ? MEMO_FC_TOOLS : undefined
```

에코(keeper)가 Workers AI를 사용하면 Function Calling이 자동으로 켜짐.

**3. "요청을 전달했습니다" 출처:**
```typescript
// src/services/ai.ts:820
1. If a tool result has "status": "ui_pending", the UI action was REQUESTED but NOT confirmed. Say "요청을 전달했습니다" (request sent), NEVER "열렸습니다" or "닫혔습니다" (already done).
```

이건 정상적인 안전장치. 문제는 왜 요약 요청이 `ui_pending`을 발생시켰는지.

### 가능한 원인 (GPT 1차 분석)
- 가설 A: 요약 요청이 UI 도구로 잘못 연결됨
- 가설 B: 실제 요약 결과가 중간에서 유실됨
- 가설 C: 요약할 자료가 모델에 전달되지 않음

### 질문
1. 위 세 가설 중 어느 것을 먼저 확인해야 하는가?
2. 운영 로그에서 어떤 지표를 보면 원인을 특정할 수 있는가?
3. 에코의 모델을 NVIDIA로 변경하는 것이 이 문제 해결에 도움이 되는가, 아니면 별개 문제인가?

---

## 문제 2: 노바 권한 오류 (P0) - 수정 완료

### 증상
- "방금 만든 코드 수정해줘" → 노바로 정확히 라우팅 (문맥 유지 성공)
- 응답이 "(이 비서는 해당 도구를 사용할 권한이 없습니다)" 오류로 표시

### 원인 (확정)
```typescript
// src/modules/ai/routes.ts:161 (수정 전)
const VALID_PERSONAS = ['concierge', 'keeper', 'builder', 'scheduler']
const effectivePersonaId = (originalPersonaId && VALID_PERSONAS.includes(originalPersonaId))
  ? originalPersonaId
  : null
// originalPersonaId='nova' → VALID_PERSONAS.includes('nova')=false → effectivePersonaId=null → allowedTools=[]
```

### 수정 내용 (운영 배포 완료)
```typescript
// src/services/persona-id-adapter.ts (신규 함수)
export function normalizeLegacyPersonaId(value: unknown): LegacyPersonaId | null {
  if (typeof value !== 'string') return null;
  if (LEGACY_IDS.has(value)) return value as LegacyPersonaId;
  if (Object.prototype.hasOwnProperty.call(NEW_TO_LEGACY, value)) {
    return NEW_TO_LEGACY[value as NewPersonaId];
  }
  return null;
}

// src/modules/ai/routes.ts (수정 후)
const { normalizeLegacyPersonaId } = await import('../../services/persona-id-adapter');
const effectivePersonaId = normalizeLegacyPersonaId(originalPersonaId);
const allowedTools = effectivePersonaId ? getLegacyMarkerTools(effectivePersonaId) : []
```

→ `nova` → `builder`로 정규화 후 권한 검사. 수정 완료 및 운영 배포됨.

### 질문
1. 이 수정으로 충분한가, 아니면 추가 검증이 필요한가?
2. `originalPersonaId`가 실제로 어디에서 설정되는지 확인이 필요한가?

---

## 문제 3: 복합 요청 감지 실패 (P1) - 미해결

### 증상
- "회의 등록하고 회의록도 요약해줘" → 에코 단독으로 라우팅
- 복합 요청으로 감지되지 않음 (작업 분리 안내 없음)

### 관련 코드
```typescript
// src/services/router.ts
if (result.multiple >= 0.8) {
  return { persona: null, source: 'fallback', reason: 'multiple_actions', confidence: result.top };
}
```

### 질문
1. 테스트 시 실제 `noul` 값은 얼마였는가? (로그 없음)
2. `persona: null`이 orchestrator에서 어떻게 처리되는가?
3. 현재 orchestrator 코드:
```typescript
if (!routeResult.persona) {
  throw new Error(`clef router returned null: ${routeResult.reason}`);
}
```
→ 이게 복합 요청을 오류로 처리해서 레거시 라우터로 폴백하는 원인이 아닌가?
4. GPT 권고대로 `multiple_actions`를 별도 분기로 처리해야 하는가?

---

## 아키텍처 현황

```
사용자 메시지
    ↓
[Clef-flash 라우터] src/services/router.ts
    ↓ routeMessage()
    ├─ persona: 'nova' (신규 ID)
    └─ source: 'clef'
    ↓
[ID 어댑터] src/services/persona-id-adapter.ts
    ↓ newToLegacy('nova') → 'builder'
    ↓ normalizeLegacyPersonaId('nova') → 'builder' (권한 검사용)
    ↓
[Orchestrator] src/services/orchestrator.ts
    ↓ decision.primary = 'builder'
    ↓ Feature Flag: CLEF_ROUTER_ENABLED=false (현재 비활성화)
    ↓
[Route Handler] src/modules/ai/routes.ts
    ↓ processToolMarkers(env, result, personaId)
    ↓ normalizeLegacyPersonaId()로 권한 검사 (수정 완료)
    ↓
[AI 호출] src/services/ai.ts
    ↓
사용자 응답
```

---

## 요청사항

1. **에코 문제**: 세 가설 중 우선 확인할 것과 구체적인 로그 지표를 알려주세요.
2. **노바 수정**: 현재 수정으로 충분한지, 아니면 `originalPersonaId` 출처 확인이 필요한지 판단해주세요.
3. **복합 요청**: `persona: null` 처리 방식을 어떻게 바꿔야 하는지 구체적인 코드를 제안해주세요.
4. **전체**: Flag를 다시 켜기 전에 반드시 해결해야 할 것과, 켠 후에 점진적으로 개선해도 되는 것을 구분해주세요.

---
*작성: 2026-10-15, Muse*
*상태: 노바 수정 완료, 에코/복합 요청 미해결, Flag=false 유지 중*
