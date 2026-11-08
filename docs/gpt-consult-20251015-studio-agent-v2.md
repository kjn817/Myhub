# GPT 자문 요청: AI 스튜디오 Function Calling 에이전트 디버깅 (2차)

## 개요

Codex/VSCode Copilot처럼 도구를 사용해 파일을 점진적으로 생성하는 AI 스튜디오 에이전트를 구현 중입니다.
1차 자문(2026-10-15)에서 받은 P0 수정사항을 모두 반영했지만 여전히 실패합니다.

## 환경

- Cloudflare Workers + TypeScript
- 모델: gemini-3.5-flash-lite (Gemini API, 직접 호출 + Deno Deploy 릴레이)
- 운영 URL: https://myhub.myhub-app.workers.dev/agent.html

## 확인된 사실

1. **Gemini API 키 정상**: 같은 키로 AI 채팅(루미)이 정상 응답함
2. **릴레이 정상**: 지역 제한(400 User location not supported) 발생 시 릴레이 경유
3. **에이전트만 실패**: "AI 호출 실패" 오류, 파일 생성 안 됨

## 1차 자문 반영 내용 (모두 적용됨)

### P0-1: REST 필드명
- `function_declarations` → `functionDeclarations` ✅
- `system_instruction` → `systemInstruction` ✅
- 첫 호출: `toolConfig: { functionCallingConfig: { mode: 'ANY' } }` ✅

### P0-2: 멀티턴 프로토콜
- Gemini: 원본 `candidate.content` 보존 → `functionResponse` Part로 결과 반환 ✅
- OpenAI: 원본 `assistant.tool_calls` 보존 → `role: 'tool'` + `tool_call_id` ✅
- Thought Signature 보존 (rawContent 그대로 push) ✅

### P0-3: 종료 판정
- 도구 호출 0건을 성공으로 오인하지 않음 ✅
- `validateArtifact()`: index.html 존재, DOCTYPE, 빈 파일 체크 ✅

### 진단 로그
- `STUDIO_GEMINI_RESPONSE` 이벤트 (candidate 수, finishReason, blockReason, partTypes 등) ✅

## 현재 코드

### studio-agent.ts (핵심)

```typescript
// Gemini 호출 부분
if (provider === 'gemini') {
  apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const geminiTools = [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }]
  const contents = messages.map(m => {
    if (m.parts) return m
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    }
  })
  body = {
    contents,
    tools: geminiTools,
    generationConfig: { temperature: 0.3 },
    ...(geminiSystem ? { systemInstruction: { parts: [{ text: geminiSystem }] } } : {}),
    ...(isFirstCall ? { toolConfig: { functionCallingConfig: { mode: 'ANY' } } } : {}),
  }
}
```

### 메시지 흐름 (Gemini)

1. 초기: `[{ role: 'user', content: userPrompt }]` (system은 systemInstruction으로 분리)
2. 첫 호출 후 도구 호출 있으면:
   - `messages.push(result.rawContent)` (원본 candidate.content)
   - `messages.push({ role: 'user', parts: [{ functionResponse: {...} }] })`
3. 반복

### 도구 정의 (studio-tools.ts)

5개 도구: create_file, edit_file, read_file, list_files, delete_file
형식: OpenAI Function Calling 형식 (`{ type: 'function', function: {...} }`)

## 증상

- Job 생성 → 즉시 실패 (1회 시도)
- 오류: "AI 호출 실패 (1회): ..." (구체적 원인은 D1에 truncated)
- 파일 생성 0개
- 진단 로그(`STUDIO_GEMINI_RESPONSE`)가 Worker 로그에 출력되는지 확인 불가

## 질문

1. 위 코드에서 Gemini Function Calling 프로토콜상 틀린 부분이 있나요?
2. `mode: 'ANY'`가 gemini-3.5-flash-lite에서 지원되나요?
3. `functionResponse`의 `id` 필드가 필요한가요? (현재는 있으면 포함)
4. 첫 메시지가 `{ role: 'user', content: ... }`인데 `parts` 변환 시 문제가 있나요?
5. 시스템 프롬프트를 `systemInstruction`으로 분리한 것이 맞나요?
6. 도구 정의의 `parameters`에 `type: 'object'`가 최상위에 필요한가요?

## 참고: 작동하는 채팅 코드 (Function Calling 없음)

```typescript
// src/services/ai.ts - 정상 작동
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
)
const data = await res.json()
const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') ?? ''
```

이 코드는 도구 없이 단순 텍스트 생성이라 정상 작동합니다.
차이점은 오직 Function Calling 관련 부분입니다.

## 요청

위 코드를 검토하고, Gemini Function Calling이 실패하는 원인을 찾아주세요.
가능하면 수정된 코드 조각을 제공해주세요.
