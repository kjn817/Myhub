# GPT 로그 분석 요청: E2E 3개 실행 문제 (2026-10-15)

## 테스트 개요

Clef-flash 라우터 E2E 테스트 (8개 시나리오) 결과:
- 라우팅 정확도: 7/8 (87.5%)
- 실행 문제: 3건 발견
- 운영 판단: 보류 (Flag를 false로 복구)

## 문제 1: 에코 응답 반환 문제 (P0)

### 증상
- 테스트 3: "지난 대화 내용을 요약해줘" → 에코로 정확히 라우팅됨
- 하지만 응답이 "요청을 전달했습니다" 한 문장만 표시
- 실제 요약 내용이 없음

- 테스트 8: "회의 등록하고 회의록도 요약해줘" → 에코로 라우팅됨
- 응답이 "요청을 전달했습니다" 한 문장만 표시
- 실제 회의 등록/요약 결과 없음

### 관련 코드 원문

**src/services/ai.ts (820행):**
```typescript
1. If a tool result has "status": "ui_pending", the UI action was REQUESTED but NOT confirmed. Say "요청을 전달했습니다" (request sent), NEVER "열렸습니다" or "닫혔습니다" (already done).
```

**src/services/ai.ts (815-830행):**
```typescript
{
  role: 'user' as const,
  content: `Tool results: ${JSON.stringify(results)}.

IMPORTANT RULES for your response:
1. If a tool result has "status": "ui_pending", the UI action was REQUESTED but NOT confirmed. Say "요청을 전달했습니다" (request sent), NEVER "열렸습니다" or "닫혔습니다" (already done).
2. If a tool result has "status": "confirmation_required", ask the user for confirmation. Do NOT say it was deleted.
3. If a tool result has "requiresConfirmation": true, ask "삭제하시겠습니까?" Do NOT say "삭제했습니다".
4. For memo_get results, summarize the content naturally.
5. NEVER invent a memo ID or content. Use only what the tools returned.

Please provide a natural Korean response to the user based on these results.`,
},
```

### 질문
1. 요약 요청이 왜 UI 액션 도구로 연결되었는가?
2. "요청을 전달했습니다"는 도구 실행 결과를 최종 응답으로 잘못 처리한 것인가?
3. 에코의 요약 결과가 생성되었는지, 생성되었다면 어디에서 유실되었는지?
4. `orchestrator.ts`에서 위임 완료 메시지를 최종 응답으로 취급하는 코드가 있는가?

---

## 문제 2: 노바 도구 권한 오류 (P0)

### 증상
- 테스트 7: "방금 만든 코드 수정해줘" → 노바로 정확히 라우팅됨 (문맥 유지 성공)
- 하지만 응답이 "(이 비서는 해당 도구를 사용할 권한이 없습니다)" 오류 문구로 표시
- 코드 수정 도구를 호출할 권한이 없어 실패

### 관련 코드 원문

**src/modules/ai/routes.ts (161행):**
```typescript
const VALID_PERSONAS = ['concierge', 'keeper', 'builder', 'scheduler']
```

**src/modules/ai/routes.ts (162-164행):**
```typescript
const effectivePersonaId = (originalPersonaId && VALID_PERSONAS.includes(originalPersonaId))
  ? originalPersonaId
  : null
const allowedTools = effectivePersonaId ? getLegacyMarkerTools(effectivePersonaId) : []
```

**src/modules/ai/routes.ts (174행):**
```typescript
return '(이 비서는 해당 도구를 사용할 권한이 없습니다)'
```

**src/modules/ai/routes.ts (165-178행):**
```typescript
// 허용되지 않은 마커는 실행 전에 제거 (권한 없음 메시지로 치환)
// 1) paired 마커: [TOOL]...[/TOOL]
const denyPattern = /\[((?:MEMO|SCHEDULE|TODO)(?:_[A-Z]+)?)\]([\s\S]*?)\[\/\1\]/gi
// 2) single 마커: [SEARCH: query], [IMG: prompt], [GITHUB: query]
const denySinglePattern = /\[(SEARCH|IMG|GITHUB):\s*([^\]]+)\]/gi
const denyReplacer = (full: string, tool: string) => {
  const toolUpper = String(tool).toUpperCase()
  if (!allowedTools.includes(toolUpper)) {
    return '(이 비서는 해당 도구를 사용할 권한이 없습니다)'
  }
  return full
}
```

### 분석
`VALID_PERSONAS`는 기존 ID만 포함: `['concierge', 'keeper', 'builder', 'scheduler']`

Clef-flash 라우터가 `nova` (신규 ID)를 반환하면:
1. `VALID_PERSONAS.includes('nova')` → false
2. `effectivePersonaId` → null
3. `allowedTools` → [] (빈 배열)
4. 모든 도구 마커가 "(이 비서는 해당 도구를 사용할 권한이 없습니다)"로 치환됨

### 질문
1. `originalPersonaId`가 어디에서 설정되는가? (orchestrator의 변환된 ID인가, 원본인가?)
2. `newToLegacy('nova')` → `'builder'` 변환이 이 코드 경로에 적용되는가?
3. 아니면 `VALID_PERSONAS`에 신규 ID를 추가해야 하는가?
4. 권한 검사가 신규 ID를 인식하지 못하는 다른 곳이 있는가?

---

## 문제 3: 복합 요청 감지 실패 (P1)

### 증상
- 테스트 8: "회의 등록하고 회의록도 요약해줘"
- 일정 등록(캘리 영역) + 회의록 요약(에코 영역)의 복합 요청
- 에코 단독으로 라우팅됨 (작업 분리 안내 없음)
- `multiple_actions` noul 값이 0.8 이상이었는지 확인 필요

### 관련 코드 원문

**src/services/router.ts (readAnswer 함수):**
```typescript
function readAnswer(raw: unknown):
  | { category: Exclude<Category, 'unclear'> | 'unclear'; top: number; second: number; multiple: number }
  | null {
  if (!isRecord(raw) || !isRecord(raw.answers)) return null;
  const assistant = raw.answers.assistant;
  const multi = raw.answers.multiple_actions;
  if (!isRecord(assistant) || assistant.type !== 'choice' || !isRecord(multi) || multi.type !== 'noul') return null;
  if (typeof assistant.choice !== 'string' || !isCategory(assistant.choice)) return null;
  if (!isRecord(assistant.probabilities) || !isProbability(multi.noul)) return null;
  // ...
  return { category, top, second: entries[1][1], multiple: multi.noul };
}
```

**src/services/router.ts (classifyIntent 함수):**
```typescript
const result = readAnswer(response);
if (!result) return fallback(message, context, 'invalid_response');
if (result.multiple >= 0.8) {
  return { persona: null, source: 'fallback', reason: 'multiple_actions', confidence: result.top };
}
```

### 질문
1. 테스트 8의 실제 `noul` 값은 얼마였는가? (0.8 미만인가, 이상인가?)
2. 만약 0.8 이상이었다면, `persona: null` 결과가 orchestrator에 어떻게 전달되었는가?
3. `orchestrator.ts`에서 `persona: null`을 어떻게 처리하는가? (현재 코드는 `throw new Error`로 폴백하는데, 이게 맞는가?)
4. 복합 요청 감지 시 사용자에게 작업 분리를 안내하는 UI가 있는가?

---

## 전체 아키텍처 흐름

```
사용자 메시지
    ↓
[Clef-flash 라우터] (src/services/router.ts)
    ↓ routeMessage()
    ├─ persona: 'nova' (신규 ID)
    └─ source: 'clef'
    ↓
[ID 어댑터] (src/services/persona-id-adapter.ts)
    ↓ newToLegacy('nova') → 'builder'
    ↓
[Orchestrator] (src/services/orchestrator.ts)
    ↓ decision.primary = 'builder'
    ↓
[Route Handler] (src/modules/ai/routes.ts)
    ↓ originalPersonaId = ??? ('nova'인가 'builder'인가?)
    ↓ VALID_PERSONAS 체크
    ↓ getLegacyMarkerTools()
    ↓ 도구 권한 필터링
    ↓
[AI 호출] (src/services/ai.ts)
    ↓
사용자 응답
```

### 핵심 질문
위 흐름에서 `originalPersonaId`가 설정되는 지점은 어디인가?
orchestrator의 변환된 ID('builder')가 route handler까지 전달되는가,
아니면 원본 신규 ID('nova')가 그대로 전달되는가?

---

## 요청사항

1. 세 문제의 근본 원인을 로그 기반으로 특정해주세요.
2. 각 문제의 수정 우선순위와 구체적인 수정 방법을 제안해주세요.
3. 특히 문제 2 (노바 권한)는 `VALID_PERSONAS` 수정 vs ID 변환 위치 수정 중 어느 것이 올바른지 판단해주세요.
4. 문제 1 (에코 응답)의 경우, 실제 운영 로그에서 확인할 수 있는 지표를 알려주세요.

---
*작성: 2026-10-15, Muse*
*기반: E2E 테스트 결과 (브라우저 실측)*
