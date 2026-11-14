/**
 * 에코(keeper) 메모 Function Calling 도구 정의
 * Workers AI Traditional Function Calling용
 *
 * 2026-10-13: P0 해결을 위한 구조 전환
 * - 기존 텍스트 마커([MEMO_CREATE] 등) 대신 정식 Function Calling 사용
 * - 모델은 도구 호출을 제안하고, 서버가 검증 후 실행
 *
 * 69차 (하이브리드 아키텍처):
 * - 핵심 메모 도구 4개 + memo_create(호환성) + memo_ui_action
 * - 수정/꾸미기는 UI가 직접 처리 (LLM 경유하지 않음)
 * - 열기/닫기/편집모드/서식모드는 memo_ui_action 하나로 통합
 */

import { validateFCArgsBase } from './fc-validate'

export interface FCToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>
    required: string[]
  }
}

export const MEMO_FC_TOOLS: FCToolDefinition[] = [
  {
    name: 'memo_create',
    description: 'Create a new memo with AI-generated content. Use ONLY when the user asks for a summary, rewrite, or new content generation. For direct dictation (user speaks the memo content), use memo_create_from_source instead.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The AI-generated content of the memo to create',
        },
        title: {
          type: 'string',
          description: 'Optional title for the memo',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'memo_create_from_source',
    description: 'Create a memo from the user\'s original message. Use when the user dictates memo content directly (e.g., "make a memo with content X"). Provide the exact text from the user\'s message as source_text. The server will verify it matches the original and save the original verbatim.',
    parameters: {
      type: 'object',
      properties: {
        source_text: {
          type: 'string',
          description: 'The exact memo content as it appears in the user\'s message. Must match the original verbatim.',
        },
        title: {
          type: 'string',
          description: 'Optional title for the memo',
        },
      },
      required: ['source_text'],
    },
  },
  {
    name: 'memo_search',
    description: 'Search the user\'s memos by keyword. Use when the user asks to find a memo.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memo_get',
    description: 'Get a specific memo by ID. Use after searching to read the full content. The content can then be summarized by the AI without a separate tool.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The memo ID',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memo_update',
    description: 'Replace the full text of an existing memo by ID. Use when the user asks to edit, rewrite, organize, or apply formatting to a memo. Always memo_get the current text first, then send the complete new text (title as the first line, markdown body). Locked memos and high-sensitivity memos cannot be updated — the server refuses. Hashtags (#tag) in the text are synced as the memo\'s tags.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The memo ID to update',
        },
        text: {
          type: 'string',
          description: 'The complete new memo text (markdown). Replaces the old text entirely.',
        },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'memo_delete',
    description: 'Delete a memo by ID. Use only when the user explicitly asks to delete. The server will require confirmation.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The memo ID to delete',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memo_ui_action',
    description: 'Request a UI action for a memo. The model suggests the action, the server validates the target memo, and the client executes it. Use for opening, closing, or entering edit/format mode.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The UI action to perform',
          enum: ['open', 'close', 'start_edit', 'start_format'],
        },
        memo_id: {
          type: 'number',
          description: 'The target memo ID',
        },
      },
      required: ['action', 'memo_id'],
    },
  },
]

/**
 * 도구 이름으로 정의 찾기
 */
export function getFCTool(name: string): FCToolDefinition | undefined {
  return MEMO_FC_TOOLS.find((t) => t.name === name)
}

/**
 * 도구 호출 인자 검증 (공용 코어 + 메모 도구 정의)
 */
export function validateFCArgs(toolName: string, args: any): { valid: boolean; error?: string } {
  return validateFCArgsBase(getFCTool, toolName, args)
}

// ---------------------------------------------------------------------------
// 프로바이더별 도구 형식 변환 (2026-10-26 정정, 2026-10-30 Workers AI 정정)
// - MEMO_FC_TOOLS는 {name, description, parameters} 평형식이다.
// - NVIDIA/Groq(OpenAI 호환)는 {type:'function', function:{...}} 래퍼를 요구하고,
//   Gemini 네이티브 FC는 functionDeclarations를 요구한다.
// - Workers AI도 OpenAI 래퍼 형식을 써야 한다 (2026-10-30 실측으로 확정):
//   mistral-small-3.1은 vLLM 서빙이라 평형식을 보내면 8007 검증 오류
//   ("tools.N.function: Field required")로 요청 자체가 거부되고,
//   qwen3-30b는 오류 없이 도구 호출이 <tool_call> 평문으로 새어 구조화
//   tool_calls가 비어 버린다. llama/granite는 양쪽 다 받지만 OpenAI
//   형식에서도 정상 동작함을 전 모델 실측으로 확인했다.
//   (구 주석의 "Workers AI는 평형식 그대로 받는다"는 llama 계열만 보고
//   내린 잘못된 일반화였다 — 운영 ai_error_log id 169~174가 증거.)
// - 게이트만 열고 형식을 안 맞추면 NVIDIA가 도구를 무시하거나 거부한다.
// ---------------------------------------------------------------------------

export type ToolFormatProvider = 'nvidia' | 'groq' | 'gemini' | 'workers-ai'

export function prepareToolsFor(provider: ToolFormatProvider, tools: FCToolDefinition[]): any[] {
  if (!tools) return tools
  switch (provider) {
    case 'nvidia':
    case 'groq':
    case 'workers-ai':
      return tools.map((t) => ({ type: 'function', function: t }))
    case 'gemini':
      // Gemini 네이티브 FC용 (이번 작업에서는 미연결 — 변환만 제공)
      return [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }]
    default:
      return tools
  }
}

// ---------------------------------------------------------------------------
// 도구 호출 정규화 + 임베디드 JSON 폴백 (2026-10-26 정정)
// - Nemotron 등 일부 모델은 tool_calls 대신 content에
//   {"tool":"MEMO_CREATE","arguments":{...}} JSON을 평문으로 뱉는다.
//   NVIDIA 문서가 직접 권장하는 방식대로 content에서 추출해 실행한다.
// - 마커형 대문자 도구명(MEMO_CREATE)은 FC 도구명(memo_create)으로 정규화한다.
// ---------------------------------------------------------------------------

/** 마커형 도구명 → FC 도구명 */
const MARKER_TOOL_ALIASES: Record<string, string> = {
  MEMO_CREATE: 'memo_create',
  MEMO_CREATE_FROM_SOURCE: 'memo_create_from_source',
  MEMO_SEARCH: 'memo_search',
  MEMO_GET: 'memo_get',
  MEMO_DELETE: 'memo_delete',
  MEMO_UI_ACTION: 'memo_ui_action',
  CRON_CREATE: 'cron_create',
  CRON_LIST: 'cron_list',
  CRON_SET_ENABLED: 'cron_set_enabled',
  CRON_DELETE: 'cron_delete',
}

export function normalizeFCToolName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed) return null
  return MARKER_TOOL_ALIASES[trimmed] || MARKER_TOOL_ALIASES[trimmed.toUpperCase()] || trimmed
}

export interface NormalizedToolCall {
  id?: string
  name: string
  arguments: any
  /** JSON 인자 파싱 실패 메시지 (있으면 preflight에서 거부됨) */
  parseError?: string
}

/**
 * 생(raw) 도구 호출 1건을 정규화한다.
 * - 이름: tc.name / tc.function.name / tc.tool (마커형 대문자 포함)
 * - 인자: 객체 그대로, 문자열이면 JSON 파싱 (실패 시 침묵하지 않고 parseError 기록)
 */
export function normalizeToolCall(tc: any, fallbackId?: string): NormalizedToolCall {
  const rawName = tc?.name ?? tc?.function?.name ?? tc?.tool
  const name = normalizeFCToolName(rawName) ?? ''
  let args: any = {}
  let parseError: string | undefined
  const rawArgs = tc?.arguments ?? tc?.function?.arguments
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      parseError = `Invalid JSON arguments for ${name || 'unknown tool'}: ${rawArgs.slice(0, 200)}`
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs
  }
  return {
    id: tc?.id ?? tc?.tool_call_id ?? fallbackId,
    name,
    arguments: args,
    parseError,
  }
}

/**
 * 실행 전 검증 (preflight).
 * - JSON 파싱 실패, 알 수 없는 도구, 필수 인자 누락은 실행하지 않고 거부한다.
 * - 거부된 호출은 오류 결과로 모델에게 피드백돼 1회 재시도 기회를 얻는다.
 * - 검증은 기존 validateFCArgs를 재사용한다 (중복 구현 금지).
 */
export function preflightToolCalls(calls: NormalizedToolCall[]): {
  valid: NormalizedToolCall[]
  rejected: Array<{ call: NormalizedToolCall; error: string }>
} {
  const valid: NormalizedToolCall[] = []
  const rejected: Array<{ call: NormalizedToolCall; error: string }> = []
  for (const call of calls) {
    if (call.parseError) {
      rejected.push({ call, error: call.parseError })
      continue
    }
    const v = validateFCArgs(call.name, call.arguments)
    if (!v.valid) {
      rejected.push({ call, error: v.error || 'Invalid tool call' })
    } else {
      valid.push(call)
    }
  }
  return { valid, rejected }
}

/**
 * content에 임베디드된 도구 호출 JSON을 추출한다.
 * - {"tool":"MEMO_CREATE","arguments":{...}} 또는 {"name":"memo_create","arguments":{...}}
 * - 코드펜스(```json) 안팎 모두 처리한다.
 * - 중첩 JSON까지 잡기 위해 균형 중괄호 스캔을 쓴다 (정규식만으로는 부족).
 * - 최대 3개 (dispatchToolCalls 턴당 상한과 동일).
 */
export function extractEmbeddedToolCalls(text: string): Array<{ name: string; arguments: any; id?: string }> {
  if (!text || typeof text !== 'string') return []
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (_m, code) => ` ${code} `)
  const results: Array<{ name: string; arguments: any }> = []
  const n = cleaned.length
  let i = 0
  while (i < n && results.length < 3) {
    const start = cleaned.indexOf('{', i)
    if (start === -1) break
    // 균형 스캔 (문자열·이스케이프 인식)
    let depth = 0
    let inString = false
    let escaped = false
    let j = start
    for (; j < n; j++) {
      const ch = cleaned[j]
      if (inString) {
        if (escaped) { escaped = false; continue }
        if (ch === '\\') { escaped = true; continue }
        if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) { j++; break }
      }
    }
    if (depth !== 0) break
    const candidate = cleaned.slice(start, j)
    i = j
    try {
      const parsed = JSON.parse(candidate)
      if (!parsed || typeof parsed !== 'object') continue
      const rawName = parsed.tool ?? parsed.name
      const name = normalizeFCToolName(rawName)
      if (!name) continue
      if (!('arguments' in parsed)) continue
      results.push({ name, arguments: parsed.arguments })
    } catch {
      // JSON이 아니면 무시하고 계속 스캔
    }
  }
  return results
}
