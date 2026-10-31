// 스튜디오 멀티턴 에이전트 루프
// 도구 호출 → 실행 → 결과 반환 → 반복
import { STUDIO_TOOLS, STUDIO_AGENT_SYSTEM, type StudioToolCall } from './studio-tools'
import { StudioWorkspace, AwaitingInputSignal } from './studio-workspace'

export interface AgentLoopOptions {
  maxTurns?: number
  model?: string
  provider?: 'gemini' | 'groq' | 'nvidia'
  jobId?: string | number
  initialFiles?: Record<string, string> // GPT 자문: 수정 시 기존 파일 로드
  wallClockBudgetMs?: number // v2 수정: 에이전트 루프 전체 시간 예산 (기본 5분 — 사용자 기준 "5분 넘으면 의미없지")
  onFileWrite?: (path: string, content: string | null) => void // B2: 파일 쓰기 시 스트리밍 콜백
}

export interface AgentLoopResult {
  ok: boolean
  files: Record<string, string>
  turns: number
  summary: string
  error?: string
  toolCalls?: string[]  // 관문 28: 관측성용 도구 호출 히스토리
  awaitingInput?: boolean  // A1: ask_question으로 사용자 입력 대기 중
  pendingQuestions?: any[]  // A1: 사용자에게 전달할 질문 목록
}

// GPT 2차 자문: HTTP 호출 단계별 진단
type GeminiStage = "request" | "transport" | "http" | "parse" | "response";

class GeminiCallError extends Error {
  constructor(
    public readonly stage: GeminiStage,
    public readonly httpStatus: number | null,
    public readonly providerCode: string,
    message: string
  ) {
    super(message);
    this.name = "GeminiCallError";
  }
}

// A2: 컨텍스트 디스틸레이션 (vibesdk context-selector 패턴)
// 첫 메시지 + 최근 턴은 완전 보존, 오래된 턴은 텍스트 요약으로 축소 → 토큰 절감
export function distillMessages(messages: any[], isGemini: boolean): any[] {
  const KEEP_HEAD = 2  // 첫 프롬프트(+system) 보존
  const KEEP_TAIL = 6  // 최근 3턴(왕복) 보존
  if (messages.length <= KEEP_HEAD + KEEP_TAIL) return messages

  const head = messages.slice(0, KEEP_HEAD)
  const tail = messages.slice(-KEEP_TAIL)
  const middle = messages.slice(KEEP_HEAD, messages.length - KEEP_TAIL)

  if (isGemini) {
    // Gemini: 개별 메시지를 텍스트로 축소 (role 유지로 user/model 교대 보존)
    const out = middle.map((m: any) => {
      let text = ''
      if (m.parts && Array.isArray(m.parts)) {
        text = m.parts.map((p: any) => {
          if (typeof p.text === 'string' && p.text.trim()) return p.text
          if (p.functionCall) return `[도구:${p.functionCall.name}]`
          if (p.functionResponse) return `[결과:${p.functionResponse.name}]`
          return ''
        }).filter(Boolean).join(' ')
      } else if (typeof m.content === 'string') {
        text = m.content
      }
      text = text.slice(0, 1500).trim() || '(이전 내용 생략)'
      return { role: m.role === 'model' ? 'model' : 'user', parts: [{ text }] }
    })
    return [...head, ...out, ...tail]
  }
  // OpenAI 호환: assistant(tool_calls)+tool 쌍을 하나의 assistant 요약으로 병합
  // (tool 메시지만 남기면 "tool_calls 없는 tool 메시지" 오류 발생하므로)
  const out: any[] = []
  let i = 0
  while (i < middle.length) {
    const m = middle[i]
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const toolNames = m.tool_calls.map((t: any) => t.function?.name || '?').join(',')
      const summary = (typeof m.content === 'string' ? m.content : '').slice(0, 1000)
      let j = i + 1
      while (j < middle.length && middle[j].role === 'tool') j++
      out.push({ role: 'assistant', content: `[이전 작업: ${toolNames}] ${summary}`.slice(0, 1500) || '[이전 작업 생략]' })
      i = j
    } else if (m.role === 'tool') {
      i++ // 단독 tool 메시지는 건너뜀
    } else {
      const c = typeof m.content === 'string' ? m.content : ''
      out.push({ role: m.role, content: c.slice(0, 1500) || '[생략]' })
      i++
    }
  }
  return [...head, ...out, ...tail]
}

function safeErrorMessage(message: string): string {
  return message
    .replace(/key=[^&\s]+/gi, "key=[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "[REDACTED]")
    .slice(0, 1000);
}

// A1: 도구 실행 래퍼 — ask_question 시그널을 포착해 루프 중단 신호로 변환
export async function execTool(
  workspace: StudioWorkspace,
  tc: StudioToolCall,
): Promise<{ result?: import('./studio-tools').StudioToolResult; awaitingInput?: boolean; questions?: any[] }> {
  try {
    const result = await workspace.execute(tc)
    return { result }
  } catch (e: any) {
    if (e instanceof AwaitingInputSignal || e?.name === 'AwaitingInputSignal') {
      return { awaitingInput: true, questions: (e as any).questions || [] }
    }
    throw e
  }
}

// A1: 사용자 입력 대기 시 루프를 중단하고 부분 결과를 반환
function awaitingInputResult(
  workspace: StudioWorkspace,
  turns: number,
  lastText: string,
  questions: any[] | undefined,
  toolCallHistory: string[],
): AgentLoopResult {
  return {
    ok: false,
    files: workspace.getFiles(),
    turns,
    summary: lastText,
    awaitingInput: true,
    pendingQuestions: questions || [],
    toolCalls: toolCallHistory,
  }
}

// Gemini/Groq/NVIDIA API 호출 (도구 포함)
async function callWithTools(
  env: any,
  provider: string,
  model: string,
  apiKey: string,
  messages: any[],
  geminiSystem?: string | null,
  isFirstCall?: boolean,
  options?: { jobId?: string | number },
): Promise<{ text: string; toolCalls: StudioToolCall[]; rawContent?: any; rawToolCalls?: any[] }> {
  let apiUrl: string
  let headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let body: any

  const tools = STUDIO_TOOLS

  if (provider === 'gemini') {
    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`
    // Gemini 도구 형식으로 변환 (공식 REST 규격: functionDeclarations)
    const geminiTools = [{
      functionDeclarations: tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }]
    // messages는 이미 Gemini 형식 (parts 포함) 또는 변환 필요
    const contents = messages.map(m => {
      if (m.parts) return m  // 이미 Gemini 형식
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '' }],
      }
    })
    body = {
      contents,
      tools: geminiTools,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,  // 커뮤니티: 도구 호출 JSON 잘림 방지
      },
      ...(geminiSystem ? { systemInstruction: { parts: [{ text: geminiSystem }] } } : {}),
      // GPT 지침: 첫 호출에서는 도구 호출 강제
      // 커뮤니티 발견: ANY만으로는 부족, allowedFunctionNames 필요
      ...(isFirstCall ? {
        toolConfig: {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: ['create_file'],
          }
        }
      } : {}),
    }
  } else {
    // Groq/NVIDIA (OpenAI 호환)
    apiUrl = provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://integrate.api.nvidia.com/v1/chat/completions'
    headers['Authorization'] = `Bearer ${apiKey}`
    body = {
      model,
      messages,
      tools,
      tool_choice: isFirstCall ? 'required' : 'auto',
      temperature: 0.3,
      max_tokens: 8192,  // 커뮤니티: 도구 호출 JSON 잘림 방지
    }
  }

  // GPT 2차 자문: HTTP 진단 로그 (요청 직전)
  const jobId = (options as any)?.jobId || 'unknown';
  let payload: string;
  try {
    payload = JSON.stringify(body);
  } catch {
    throw new GeminiCallError("request", null, "SERIALIZATION_FAILED", "요청 직렬화 실패");
  }

  console.log(JSON.stringify({
    event: "STUDIO_HTTP_START",
    jobId,
    route: "direct",
    provider,
    model,
    toolCount: provider === 'gemini'
      ? (body.tools?.[0]?.functionDeclarations?.length ?? 0)
      : (body.tools?.length ?? 0),
    requestBytes: new TextEncoder().encode(payload).byteLength,
  }));

  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(120000),
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "STUDIO_TRANSPORT_ERROR",
      jobId,
      provider,
      error: safeErrorMessage(message),
    }));
    throw new GeminiCallError("transport", null, "TRANSPORT_FAILED", safeErrorMessage(message));
  }

  // GPT 2차 자문: 응답 본문을 먼저 텍스트로 읽고 진단 로그
  const rawText = await res.text().catch(() => '');
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.error(JSON.stringify({
      event: "STUDIO_HTTP_RESULT",
      jobId,
      provider,
      httpStatus: res.status,
      parseError: true,
      rawLength: rawText.length,
    }));
    throw new GeminiCallError("parse", res.status, "INVALID_JSON", `JSON 파싱 실패 (length=${rawText.length})`);
  }

  // GPT 2차 자문: HTTP 결과 진단 로그
  console.log(JSON.stringify({
    event: "STUDIO_HTTP_RESULT",
    jobId,
    provider,
    route: "direct",
    httpStatus: res.status,
    providerStatus: data.error?.status ?? null,
    providerCode: data.error?.code ?? null,
    providerMessage: data.error?.message ? safeErrorMessage(data.error.message) : null,
    candidateCount: data.candidates?.length ?? (data.choices?.length ?? 0),
    finishReason: data.candidates?.[0]?.finishReason ?? data.choices?.[0]?.finish_reason ?? null,
    blockReason: data.promptFeedback?.blockReason ?? null,
  }));

  // Gemini 지역 제한 시 릴레이 시도 (지역 제한 오류만)
  if (!res.ok && provider === 'gemini' && res.status === 400) {
    const isLocationBlocked = (data.error?.message || '').includes('User location is not supported');
    if (isLocationBlocked && (env as any).GEMINI_RELAY_URL && (env as any).GEMINI_RELAY_SECRET) {
      console.log(JSON.stringify({
        event: "STUDIO_RELAY_ATTEMPT",
        jobId,
        reason: "location_blocked",
      }));
      // 릴레이 호출 (진단 로그 포함)
      const relayPayload = JSON.stringify({ model, key: apiKey, payload: body });
      console.log(JSON.stringify({
        event: "STUDIO_HTTP_START",
        jobId,
        route: "relay",
        provider,
        model,
        requestBytes: new TextEncoder().encode(relayPayload).byteLength,
      }));
      let relayRes: Response;
      try {
        relayRes = await fetch((env as any).GEMINI_RELAY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Relay-Key': (env as any).GEMINI_RELAY_SECRET,
          },
          body: relayPayload,
          signal: AbortSignal.timeout(120000),
        });
      } catch (error: any) {
        throw new GeminiCallError("transport", null, "RELAY_TRANSPORT_FAILED", safeErrorMessage(error.message));
      }
      const relayRaw = await relayRes.text().catch(() => '');
      let relayData: any;
      try {
        relayData = JSON.parse(relayRaw);
      } catch {
        throw new GeminiCallError("parse", relayRes.status, "RELAY_INVALID_JSON", "릴레이 응답 파싱 실패");
      }
      console.log(JSON.stringify({
        event: "STUDIO_HTTP_RESULT",
        jobId,
        route: "relay",
        httpStatus: relayRes.status,
        relayOk: relayData.ok ?? null,
      }));
      if (relayData.ok) {
        const gdata = typeof relayData.body === 'string' ? JSON.parse(relayData.body) : relayData.body;
        // 릴레이 응답으로 data 교체
        data = gdata;
        console.log(JSON.stringify({
          event: "STUDIO_RELAY_SUCCESS",
          jobId,
          candidateCount: data.candidates?.length ?? 0,
        }));
      } else {
        throw new GeminiCallError(
          "http",
          relayRes.status,
          "RELAY_FAILED",
          safeErrorMessage(relayData.body || relayData.error || '릴레이 실패')
        );
      }
    } else {
      // 지역 제한이 아닌 400 오류는 스키마 문제 - 전체 오류 보존
      throw new GeminiCallError(
        "http",
        res.status,
        String(data.error?.status ?? data.error?.code ?? "HTTP_ERROR"),
        safeErrorMessage(data.error?.message ?? `HTTP ${res.status}`)
      );
    }
  } else if (!res.ok) {
    throw new GeminiCallError(
      "http",
      res.status,
      String(data.error?.status ?? data.error?.code ?? "HTTP_ERROR"),
      safeErrorMessage(data.error?.message ?? `HTTP ${res.status}`)
    );
  }

  const toolCalls: StudioToolCall[] = []
  let text = ''
  let rawContent: any = undefined
  let rawToolCalls: any[] | undefined = undefined

  if (provider === 'gemini') {
    const candidate = data.candidates?.[0]
    // GPT 지침: 진단 로그
    logGeminiDiagnostics(data, res.status)
    rawContent = candidate?.content  // 원본 보존 (thoughtSignature 포함)
    const parts = candidate?.content?.parts || []
    for (const p of parts) {
      if (p.text) text += p.text
      if (p.functionCall) {
        const args = p.functionCall.args || {}
        // 진단: 도구 호출 인수 로깅
        console.log(JSON.stringify({
          event: "STUDIO_TOOL_CALL",
          jobId,
          toolName: p.functionCall.name,
          hasArgs: Object.keys(args).length > 0,
          argKeys: Object.keys(args),
          pathValue: args.path || null,
          contentLength: typeof args.content === 'string' ? args.content.length : null,
        }))
        toolCalls.push({
          name: p.functionCall.name,
          arguments: args,
          id: p.functionCall.id,
        } as any)
      }
    }
  } else {
    const msg = data.choices?.[0]?.message
    text = msg?.content || ''
    rawToolCalls = msg?.tool_calls || []
    for (const tc of rawToolCalls || []) {
      if (tc.type === 'function') {
        try {
          toolCalls.push({
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}'),
            id: tc.id,
          } as any)
        } catch {}
      }
    }
  }

  return { text, toolCalls, rawContent, rawToolCalls }
}

// GPT 지침: Gemini 진단 로그
function logGeminiDiagnostics(data: any, httpStatus: number) {
  try {
    const candidate = data.candidates?.[0]
    const parts = candidate?.content?.parts ?? []
    console.log(JSON.stringify({
      event: 'STUDIO_GEMINI_RESPONSE',
      httpStatus,
      responseId: data.responseId,
      modelVersion: data.modelVersion,
      candidateCount: data.candidates?.length ?? 0,
      finishReason: candidate?.finishReason ?? null,
      finishMessage: candidate?.finishMessage ?? null,
      blockReason: data.promptFeedback?.blockReason ?? null,
      partTypes: parts.map((p: any) =>
        p.functionCall ? 'functionCall' : p.text !== undefined ? 'text' : 'other'
      ),
      toolNames: parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall.name),
      usage: data.usageMetadata ?? null,
    }))
  } catch {}
}

// API 키 가져오기
function getApiKeys(env: any, provider: string): string[] {
  const prefixes: Record<string, string[]> = {
    gemini: ['GEMINI_API_KEY_1', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4'],
    groq: ['GROQ_API_KEY_1', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4'],
    nvidia: ['NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3'],
  }
  const keys: string[] = []
  for (const key of prefixes[provider] || []) {
    const val = (env as any)[key]
    if (val) keys.push(val)
  }
  return keys
}

// 멀티턴 에이전트 루프 실행
export async function runStudioAgent(
  env: any,
  userPrompt: string,
  options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns || 10
  const provider = options.provider || 'gemini'
  const model = options.model || 'gemini-3.5-flash-lite'

  // NVIDIA 운영 제외 (2026-10-30): 이 에이전트는 aiChat/selectModel을 거치지
  // 않는 직접 호출 경로라 레지스트리 비활성만으로는 막히지 않는다 — 진입점에서
  // fail-closed로 거부한다. 호출부의 NVIDIA 분기 코드는 보존하되 도달 불가.
  if (provider === 'nvidia') {
    return { ok: false, files: {}, turns: 0, summary: '', error: 'PROVIDER_DISABLED: nvidia는 운영 경로에서 제외됨' }
  }

  const apiKeys = getApiKeys(env, provider)
  if (apiKeys.length === 0) {
    return { ok: false, files: {}, turns: 0, summary: '', error: `${provider} API 키 없음` }
  }

  const workspace = new StudioWorkspace(options.initialFiles || {})
  // B2: 파일 쓰기 스트리밍 — 도구 실행 직후 file.stream 이벤트로 전달
  if (options.onFileWrite) {
    workspace.onMutation = options.onFileWrite
  }
  // GPT 자문: 수정 시 기존 파일을 워크스페이스에 로드 (생성자에서 처리됨)
  // GPT 지침: 프로바이더별 메시지 형식 분리
  const isGemini = provider === 'gemini'
  const messages: any[] = isGemini
    ? [{ role: 'user', content: userPrompt }]  // Gemini는 systemInstruction으로 분리
    : [
        { role: 'system', content: STUDIO_AGENT_SYSTEM },
        { role: 'user', content: userPrompt },
      ]
  // Gemini용 시스템 메시지 별도 보관
  const geminiSystem = isGemini ? STUDIO_AGENT_SYSTEM : null

  let turns = 0
  let lastText = ''
  let keyIndex = 0  // 커뮤니티: 503 시 키 로테이션
  const toolCallHistory: string[] = []  // 진단: 호출된 도구 기록
  // v2 'Failed to fetch' 수정: 턴당 타임아웃(120초)은 있어도 루프 전체 예산이 없어
  // 최악 10턴 × 120초 = 수십 분 블로킹 → 전송 계층 kill. 전체 예산 초과 시 정상 실패 반환.
  // 사용자 기준: "5분 넘으면 의미없지" (2026-10-15) → 기본 5분.
  const WALL_CLOCK_BUDGET_MS = options.wallClockBudgetMs || 5 * 60 * 1000
  const loopStart = Date.now()

  for (let i = 0; i < maxTurns; i++) {
    // 전체 시간 예산 체크 (턴 시작 전)
    if (Date.now() - loopStart > WALL_CLOCK_BUDGET_MS) {
      console.log(JSON.stringify({
        event: 'STUDIO_WALL_CLOCK_BUDGET',
        jobId: options.jobId || 'unknown',
        turns,
        elapsedMs: Date.now() - loopStart,
        budgetMs: WALL_CLOCK_BUDGET_MS,
      }))
      return {
        ok: false,
        files: workspace.getFiles(),
        turns,
        summary: lastText,
        error: `AGENT_WALL_CLOCK_BUDGET: 전체 시간 예산(${Math.round(WALL_CLOCK_BUDGET_MS / 60000)}분) 초과`,
      }
    }
    turns++
    let result
    let lastError: any = null
    // 키 로테이션: 503 발생 시 다음 키로 재시도
    for (let k = 0; k < apiKeys.length; k++) {
      const apiKey = apiKeys[(keyIndex + k) % apiKeys.length]
      try {
        // A2: 오래된 턴은 디스틸레이션해서 토큰 절감 (원본 messages는 그대로 유지)
        const distilled = distillMessages(messages, isGemini)
        result = await callWithTools(env, provider, model, apiKey, distilled, geminiSystem, i === 0, { jobId: options.jobId })
        // 성공하면 키 인덱스 업데이트
        keyIndex = (keyIndex + k) % apiKeys.length
        lastError = null
        break
      } catch (e: any) {
        lastError = e
        // 503이 아니면 즉시 중단 (다른 키로 재시도 무의미)
        const is503 = e instanceof GeminiCallError && e.httpStatus === 503
        if (!is503) break
        console.log(JSON.stringify({
          event: "STUDIO_KEY_ROTATION",
          jobId: options.jobId || 'unknown',
          keyIndex: (keyIndex + k) % apiKeys.length,
          reason: "503_unavailable",
        }))
        // 다음 키로 계속
      }
    }
    if (lastError) {
      const e = lastError
      const stageInfo = e instanceof GeminiCallError
        ? `[${e.stage}:${e.httpStatus ?? '-'}:${e.providerCode}] `
        : '';
      return { ok: false, files: workspace.getFiles(), turns, summary: lastText, error: stageInfo + e.message }
    }

    // lastError가 없으면 result는 반드시 할당됨
    const safeResult = result!
    lastText = safeResult.text

    // P0-3: 도구 호출 0건을 성공으로 오인하지 않음 - 산출물 검증 필요
    // 관문 7: 1턴째 조기 종료 방지 — 최소 2턴 보장
    if (safeResult.toolCalls.length === 0) {
      const files = workspace.getFiles()
      const hasFiles = Object.keys(files).length > 0
      if (hasFiles && turns >= 2) {
        // 파일이 있고 2턴 이상 → 완료로 간주하고 종료
        break
      }
      if (!hasFiles) {
        // 도구 호출 없이 텍스트만 반환 → 대화 모드로 처리 (실패 아님)
        // 사용자가 의견/피드백을 요청한 경우
        return {
          ok: true,
          files: {},
          turns,
          summary: lastText,
        }
      }
      // hasFiles && turns < 2 → 계속 진행 (에이전트가 더 만들 수 있음)
      // break하지 않고 루프 계속
    }

    // 도구 실행 및 정식 Function Response 생성 (GPT P0-2)
    if (isGemini) {
      // 원본 model 응답을 그대로 보존 (thoughtSignature 포함)
      // Gemini 차단 시 rawContent가 undefined일 수 있음 → 건너뜀
      if (safeResult.rawContent) {
        messages.push(safeResult.rawContent)
      }
      const toolResponseParts: any[] = []
      for (const tc of safeResult.toolCalls) {
        const exec = await execTool(workspace, tc)
        // A1: ask_question → 사용자 입력 대기, 루프 중단
        if (exec.awaitingInput) {
          return awaitingInputResult(workspace, turns, lastText, exec.questions, toolCallHistory)
        }
        const r = exec.result!
        // 진단: 도구 호출 기록
        const args = tc.arguments || {}
        toolCallHistory.push(`${tc.name}(path=${args.path || 'EMPTY'}, content_len=${typeof args.content === 'string' ? args.content.length : 'N/A'}, ok=${r.ok})`)
        toolResponseParts.push({
          functionResponse: {
            ...(tc.id ? { id: tc.id } : {}),
            name: tc.name,
            response: { result: r.ok ? r.output : `ERROR: ${r.error}` },
          },
        })
      }
      // 도구 결과를 정식 Function Response로 전달
      messages.push({ role: 'user', parts: toolResponseParts })
    } else {
      // OpenAI 호환: 원본 assistant 턴 보존 (tool_calls 포함)
      messages.push({
        role: 'assistant',
        content: safeResult.text || null,
        tool_calls: safeResult.rawToolCalls || [],
      })
      for (let idx = 0; idx < safeResult.toolCalls.length; idx++) {
        const tc = safeResult.toolCalls[idx]
        const rawTc = safeResult.rawToolCalls?.[idx]
        const exec = await execTool(workspace, tc)
        // A1: ask_question → 사용자 입력 대기, 루프 중단
        if (exec.awaitingInput) {
          return awaitingInputResult(workspace, turns, lastText, exec.questions, toolCallHistory)
        }
        const r = exec.result!
        // 진단: 도구 호출 기록
        const args = tc.arguments || {}
        toolCallHistory.push(`${tc.name}(path=${args.path || 'EMPTY'}, content_len=${typeof args.content === 'string' ? args.content.length : 'N/A'}, ok=${r.ok})`)
        messages.push({
          role: 'tool',
          tool_call_id: rawTc?.id || tc.id || `call_${idx}`,
          content: JSON.stringify(r.ok ? { output: r.output } : { error: r.error }),
        })
      }
    }
  }

  const files = workspace.getFiles()
  // P0-3: 산출물 검증
  const validation = validateArtifact(files)
  const ok = validation.ok

  // 진단: 도구 호출 히스토리를 오류에 포함
  const historyStr = toolCallHistory.length > 0 ? ` [도구호출: ${toolCallHistory.join(' | ')}]` : ' [도구호출 없음]'

  return {
    ok,
    files,
    turns,
    summary: lastText.slice(0, 500),
    error: ok ? undefined : `ARTIFACT_VALIDATION_FAILED: ${validation.errors.join(', ')}${historyStr}`,
    // 관문 28: 도구 호출 히스토리를 구조화하여 반환 (관측성)
    toolCalls: toolCallHistory,
  }
}

// P0-3: 산출물 검증 (GPT 지침)
function validateArtifact(files: Record<string, string>): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const html = files['index.html']
  if (typeof html !== 'string' || !html.trim()) {
    errors.push('INDEX_HTML_MISSING')
  } else {
    if (!/<!doctype\s+html/i.test(html)) errors.push('DOCTYPE_MISSING')
    if (!/<html\b/i.test(html)) errors.push('HTML_ROOT_MISSING')
  }
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string' || !content.trim()) {
      errors.push(`EMPTY_FILE:${path}`)
    }
  }
  return { ok: errors.length === 0, errors }
}
