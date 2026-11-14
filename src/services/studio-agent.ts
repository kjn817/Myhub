// 스튜디오 멀티턴 에이전트 루프
// 도구 호출 → 실행 → 결과 반환 → 반복
import { STUDIO_AGENT_SYSTEM, type StudioToolCall } from './studio-tools'
import { StudioWorkspace, AwaitingInputSignal } from './studio-workspace'
import { callWithTools, GeminiCallError } from './studio-gemini-call'
import { getLegacyMarkerTools, resolveRequestSensitivity } from '../ai/legacy-privacy-guard'
import { DEFAULT_MODEL_ID, defaultModelForProvider, validateModelProviderPair } from './ai-models'
import { getPool } from './ai-key-pool'
import { isQuotaError } from './clef-engine'

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

// 멀티턴 에이전트 루프 실행
export async function runStudioAgent(
  env: any,
  userPrompt: string,
  options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns || 10
  const provider = options.provider || 'gemini'
  const model = options.model || defaultModelForProvider(provider)?.id || DEFAULT_MODEL_ID

  // NVIDIA 운영 제외 (2026-10-30): 이 에이전트는 aiChat/selectModel을 거치지
  // 않는 직접 호출 경로라 레지스트리 비활성만으로는 막히지 않는다 — 진입점에서
  // fail-closed로 거부한다. 호출부의 NVIDIA 분기 코드는 보존하되 도달 불가.
  if (provider === 'nvidia') {
    return { ok: false, files: {}, turns: 0, summary: '', error: 'PROVIDER_DISABLED: nvidia는 운영 경로에서 제외됨' }
  }

  const pair = validateModelProviderPair(model, provider, { allowedProviders: ['gemini', 'groq'] })
  if (!pair.ok) {
    const knownProvider = ['gemini', 'groq', 'workers-ai'].includes(provider)
    if (pair.code !== 'MODEL_PROVIDER_MISMATCH' || knownProvider) {
      return { ok: false, files: {}, turns: 0, summary: '', error: pair.error }
    }
  }

  let gateSensitivity: string | undefined
  try {
    gateSensitivity = resolveRequestSensitivity('builder', userPrompt, getLegacyMarkerTools('builder')).sensitivity
  } catch {
    gateSensitivity = 'personal'
  }

  const keyPool = getPool(env, provider)
  if (keyPool.length === 0) {
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
    // 키 로테이션: 503/429 발생 시 다음 키로 재시도
    for (let k = 0; k < keyPool.length; k++) {
      const ks = keyPool[(keyIndex + k) % keyPool.length]
      if (ks.cooledUntil > Date.now()) continue
      try {
        // A2: 오래된 턴은 디스틸레이션해서 토큰 절감 (원본 messages는 그대로 유지)
        const distilled = distillMessages(messages, isGemini)
        result = await callWithTools(env, provider, model, ks.key, distilled, geminiSystem, i === 0, { jobId: options.jobId, sensitivity: gateSensitivity })
        ks.failures = 0
        // 성공하면 키 인덱스 업데이트
        keyIndex = (keyIndex + k) % keyPool.length
        lastError = null
        break
      } catch (e: any) {
        lastError = e
        const status = e instanceof GeminiCallError ? e.httpStatus : null
        const is503 = status === 503
        const is429 = status === 429
        // 503/429가 아니면 즉시 중단 (다른 키로 재시도 무의미)
        if (!is503 && !is429) break
        if (is429) {
          ks.failures++
          ks.cooledUntil = Date.now() + 60000
        }
        console.log(JSON.stringify({
          event: 'STUDIO_KEY_ROTATION',
          jobId: options.jobId || 'unknown',
          keyIndex: (keyIndex + k) % keyPool.length,
          reason: is429 ? (isQuotaError(e) ? '429_quota_exhausted' : '429_rate_limited') : '503_unavailable',
        }))
        // 다음 키로 계속
      }
    }
    if (!lastError && !result) {
      return {
        ok: false,
        files: workspace.getFiles(),
        turns,
        summary: lastText,
        error: '모든 API 키가 쿨다운 중입니다 (429 rate limit)',
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
