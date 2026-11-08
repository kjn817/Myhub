# GPT 자문 요청: AI 스튜디오 에이전트 도구 호출 실패

## 1. 배경과 목표

MyHub AI 스튜디오(`/agent.html`)는 사용자가 자연어로 요청하면 AI가 HTML 앱을 생성하는 기능입니다.

**기존 방식 (문제 있음):**
- 단일 프롬프트로 AI에게 "HTML만 출력해"라고 요청
- AI 응답에서 HTML 추출 시도 (정규식 파싱)
- 추출 실패 시 빈 응답 → D1 NOT NULL 오류

**목표 (Codex/VSCode Copilot급):**
- AI가 Function Calling 도구를 사용해 점진적으로 앱 생성
- `create_file`, `edit_file`, `read_file`, `list_files`, `delete_file` 도구 제공
- 멀티턴 루프: 도구 호출 → 실행 → 결과 반환 → 반복 (최대 10턴)

## 2. 현재 구현 상태

### 2.1 파일 구조

```
src/services/studio-tools.ts      # 도구 정의 (OpenAI FC 형식)
src/services/studio-workspace.ts  # 작업 공간 (메모리 + D1 artifact_files)
src/services/studio-agent.ts      # 멀티턴 에이전트 루프
src/modules/artifact/job-processor.ts  # processArtifactJob에서 runStudioAgent 호출
```

### 2.2 도구 정의 (studio-tools.ts)

```typescript
export const STUDIO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: '프로젝트에 새 파일을 생성합니다. 이미 존재하는 경로면 덮어씁니다.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '파일 경로 (예: index.html, style.css, app.js)' },
          content: { type: 'string', description: '파일 전체 내용' },
        },
        required: ['path', 'content'],
      },
    },
  },
  // edit_file, read_file, list_files, delete_file 동일 패턴
]

export const STUDIO_AGENT_SYSTEM = `당신은 노바, AI 스튜디오의 코딩 어시스턴트입니다.

도구를 사용해 점진적으로 앱을 만드세요:
1. 먼저 필요한 파일들을 create_file로 생성
2. 필요하면 edit_file로 수정
3. 완성되면 사용자에게 요약 설명

규칙:
- 한 번에 하나의 작업에 집중
- HTML 파일은 완전한 문서로 (<!DOCTYPE html> 포함)
- CSS/JS는 별도 파일로 분리 가능
- index.html이 진입점이어야 함
- 설명은 간결하게, 코드는 도구로만 생성`
```

### 2.3 에이전트 루프 (studio-agent.ts)

```typescript
export async function runStudioAgent(env, userPrompt, options = {}) {
  const maxTurns = options.maxTurns || 10
  const provider = options.provider || 'gemini'  // D1 model.code에서 읽음
  const model = options.model || 'gemini-3.5-flash-lite'

  const workspace = new StudioWorkspace()
  const messages = [
    { role: 'system', content: STUDIO_AGENT_SYSTEM },
    { role: 'user', content: userPrompt },
  ]

  for (let i = 0; i < maxTurns; i++) {
    const result = await callWithTools(env, provider, model, apiKey, messages)
    // 도구 호출이 없으면 완료
    if (result.toolCalls.length === 0) break
    // 도구 실행
    for (const tc of result.toolCalls) {
      const r = await workspace.execute(tc)
      // 결과를 메시지에 추가
    }
    messages.push({ role: 'assistant', content: result.text })
    messages.push({ role: 'user', content: `도구 실행 결과:\n...` })
  }
  return { ok, files: workspace.getFiles(), turns, summary }
}
```

### 2.4 API 호출 (provider별 분기)

**Gemini:**
```typescript
const geminiTools = [{
  function_declarations: tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  })),
}]
const systemMsg = messages.find(m => m.role === 'system')
const contents = messages
  .filter(m => m.role !== 'system')
  .map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
body = {
  contents,
  tools: geminiTools,
  generationConfig: { temperature: 0.3 },
  ...(systemMsg ? { system_instruction: { parts: [{ text: systemMsg.content }] } } : {}),
}
```

**Groq/NVIDIA (OpenAI 호환):**
```typescript
body = { model, messages, tools, tool_choice: 'auto', temperature: 0.3 }
```

**응답 파싱:**

Gemini:
```typescript
const candidate = data.candidates?.[0]
const parts = candidate?.content?.parts || []
for (const p of parts) {
  if (p.text) text += p.text
  if (p.functionCall) {
    toolCalls.push({ name: p.functionCall.name, arguments: p.functionCall.args || {} })
  }
}
```

OpenAI:
```typescript
const msg = data.choices?.[0]?.message
text = msg?.content || ''
for (const tc of msg?.tool_calls || []) {
  if (tc.type === 'function') {
    toolCalls.push({ name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') })
  }
}
```

## 3. 문제 증상

### 3.1 에이전트가 도구를 호출하지 않음

- `runStudioAgent` 실행 시 AI가 `create_file` 등을 호출하지 않음
- `result.toolCalls.length === 0`으로 즉시 루프 종료
- `workspace.getFiles()`가 빈 객체 반환
- 결과: "파일이 생성되지 않았습니다" 오류

### 3.2 폴백도 실패

에이전트 실패 시 기존 `generateArtifactHtml`로 폴백하지만:
- API는 HTTP 200 성공
- 그러나 `rawContent`가 빈 문자열
- `EMPTY_RESPONSE` 오류 또는 빈 HTML로 D1 NOT NULL 오류

### 3.3 테스트 환경

- 모델: `gemini-3.5-flash-lite` (D1 `model.code`)
- UI에서 모델 선택 가능 (Gemini 3개, Groq 2개, NVIDIA 7개)
- 직접 모드 (`?direct=1`): Workflow 우회, 동기 실행

## 4. 기존 코드베이스의 FC 사용 현황

메모 FC (`src/ai/memo-fc-tools.ts`)는 Workers AI 전용으로 설계됨:
```typescript
// 주석: "Workers AI Traditional Function Calling용"
export const MEMO_FC_TOOLS: FCToolDefinition[] = [...]
```

`src/services/ai.ts`의 `callNVIDIA`는 tools 파라미터를 받음 (line 382):
```typescript
async function callNVIDIA(key, model, messages, tools?, signal?): Promise<{ text; toolCalls?; ... }> {
  if (tools && tools.length > 0) {
    body.tools = tools
  }
  // ...
  toolCalls: msg?.tool_calls || undefined,
}
```

즉, NVIDIA/Groq는 OpenAI 형식 FC를 지원하는 코드가 이미 있음.

## 5. GPT에게 질문

### Q1. Gemini 도구 호출 형식이 맞는가?

위 2.4의 Gemini `function_declarations` 형식과 `system_instruction` 분리가 정확한가?
특히 `contents`에서 system 메시지를 제외하고 `system_instruction`으로 분리한 부분이 맞는가?

### Q2. AI가 도구를 호출하지 않는 일반적인 원인은?

- 시스템 프롬프트가 약한가? (현재: "도구를 사용해 점진적으로 앱을 만드세요")
- `tool_choice: 'auto'`가 문제인가? `tool_choice: 'required'`를 써야 하나?
- Temperature 0.3이 너무 낮은가?
- 도구 설명이 불충분한가?

### Q3. 빈 응답의 원인은?

HTTP 200인데 `candidates[0].content.parts`가 비어있는 경우:
- 모델이 응답을 거부한 건가?
- Safety filter에 걸린 건가?
- 프롬프트가 너무 긴가? (현재 sysCtx는 수백 자 수준)

### Q4. 아키텍처 조언

현재 설계:
1. `processArtifactJob` → `runStudioAgent` → 최대 10턴 루프
2. 실패 시 `generateArtifactHtml` 폴백

더 나은 구조가 있는가? 예를 들어:
- 폴백을 없애고 에이전트만으로 가야 하는가?
- 스트리밍으로 도구 호출을 실시간 표시해야 하는가?
- 별도 Queue/Workflow로 분리해야 하는가? (현재는 동기 실행)

### Q5. 모델별 권장사항

사용 가능한 모델:
- Gemini: gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-2.5-flash
- Groq: openai/gpt-oss-120b, openai/gpt-oss-20b
- NVIDIA: nemotron-3-ultra-550b 등 7개

도구 기반 코드 생성에 가장 적합한 모델은? (FC 안정성 기준)
