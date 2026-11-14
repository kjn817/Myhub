/**
 * MyHub Function Calling 엔진 — 공통 인터페이스 정의 (Phase 1A)
 *
 * 설계 원칙:
 * - 특정 LLM SDK에 직접 종속되지 않음
 * - Provider별 원본 이력은 Adapter 내부에서 보존 (공통 타입으로 강제 변환하지 않음)
 * - Gemini Thought Signature, Groq tool_call_id 등 손실 없이 유지
 *
 * 기존 코드와의 연결:
 * - ProviderId, ChatMessage, TaskPolicy, AIResult는 src/services/ai.ts에 정의됨
 * - 이 파일은 Function Calling 전용 공통 계약만 정의
 */

import type { ProviderId } from '../services/provider-registry'

// ---------------------------------------------------------------------------
// ToolDefinition — 도구의 정의
// ---------------------------------------------------------------------------

/**
 * 도구 정의. Tool Registry에 등록되는 단위.
 * JSON Schema와 Zod 스키마는 Registry에서 단일 정의로 관리 (Phase 1B).
 */
export type ToolDefinition = {
  /** 도구 이름 (예: 'search_memo') */
  name: string
  /** 도구에 대한 설명 (모델에게 전달) */
  description: string
  /** JSON Schema 형식의 인자 정의 */
  parameters: Record<string, unknown>
  /** 읽기 전용인지 쓰기인지 */
  mode: 'read' | 'write'
  /** 필요한 권한 (서버에서 검증) */
  requiredPermission?: string
}

// ---------------------------------------------------------------------------
// ToolCall — 모델이 요청한 도구 호출
// ---------------------------------------------------------------------------

/**
 * 모델이 요청한 도구 호출을 Provider와 무관하게 표현.
 * Groq의 문자열 JSON과 Gemini의 객체형 인자를 정규화한 결과.
 *
 * 주의: args가 파싱됐다는 것과 Zod 검증을 통과했다는 것은 다름.
 * 검증되지 않은 인자는 unknown으로 취급.
 */
export type ToolCall = {
  /** Provider의 원본 호출 ID (예: Groq tool_call_id) */
  id: string
  /** 실행할 도구 이름 */
  name: string
  /** 정규화된 인자 (검증 전이므로 unknown) */
  args: unknown
  /** 원본 Provider (디버깅용) */
  provider: ProviderId
  /**
   * 인자 파싱 실패 여부 (선택적).
   * Provider가 반환한 arguments JSON 파싱에 실패하면 true.
   * Runner가 Zod 검증 전에 확인하고 INVALID_ARGUMENTS 반환.
   */
  parseError?: boolean
}

// ---------------------------------------------------------------------------
// ToolResult — 도구 실행 결과
// ---------------------------------------------------------------------------

/**
 * 도구 실행 결과를 성공/실패로 구분.
 * 검색 결과 없음(정상)과 실행 실패를 구분하는 것이 핵심.
 */
export type ToolResult = {
  /** 대응되는 ToolCall의 ID */
  callId: string
  /** 도구 이름 */
  name: string
  output:
    | {
        ok: true
        /** 성공 시 반환 데이터 */
        data: unknown
      }
    | {
        ok: false
        /** 오류 코드 (예: 'INVALID_ARGUMENTS', 'DB_ERROR', 'TIMEOUT') */
        errorCode: string
        /** 사용자에게 안전한 오류 메시지 (민감 정보 제외) */
        message: string
      }
}

// ---------------------------------------------------------------------------
// TokenUsage — 토큰 사용량
// ---------------------------------------------------------------------------

/**
 * 토큰 사용량. Provider가 반환하지 않으면 estimated 또는 unavailable.
 */
export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  /** 사용량 출처 */
  source: 'provider' | 'estimated' | 'unavailable'
}

// ---------------------------------------------------------------------------
// ModelStep — LLM의 한 번의 응답
// ---------------------------------------------------------------------------

/**
 * LLM의 단일 응답. 텍스트, 도구 호출, 종료 이유, 사용량을 포함.
 * 복수 도구 호출을 지원.
 */
export type ModelStep = {
  /** 생성된 텍스트 (도구 호출만 있고 텍스트가 없을 수 있음) */
  text: string | null
  /** 요청된 도구 호출 목록 */
  toolCalls: ToolCall[]
  /** 종료 이유 */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error' | 'unknown'
  /** 토큰 사용량 (선택적) */
  usage?: TokenUsage
}

// ---------------------------------------------------------------------------
// ProviderError — Provider API 오류
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'RATE_LIMITED'      // 429
  | 'AUTH_ERROR'        // 401, 403
  | 'TIMEOUT'           // 타임아웃
  | 'SERVICE_UNAVAILABLE' // 503
  | 'INVALID_REQUEST'   // 400
  | 'UNKNOWN'

/**
 * Provider API 오류와 Tool 실행 오류를 구분.
 * 재시도 가능 여부를 판단할 수 있도록 설계.
 * 실제 Error 객체다 — 일반 객체를 던지면 `.toThrow()` 계열로 잡히지 않고
 * 스택 추적도 없어 FallbackController가 코드·메시지로만 읽어야 했다.
 */
export class ProviderError extends Error {
  code: ProviderErrorCode
  /** 재시도 가능 여부 */
  retryable: boolean
  /** 원본 Provider */
  provider: ProviderId
  /** Retry-After 헤더 값 (RATE_LIMITED인 경우) */
  retryAfterMs?: number

  constructor(opts: {
    code: ProviderErrorCode
    retryable: boolean
    provider: ProviderId
    message: string
    retryAfterMs?: number
  }) {
    super(opts.message)
    this.name = 'ProviderError'
    this.code = opts.code
    this.retryable = opts.retryable
    this.provider = opts.provider
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

// ---------------------------------------------------------------------------
// ProviderSession — Provider별 세션 인터페이스
// ---------------------------------------------------------------------------

/**
 * Provider별 대화 세션. 원본 이력을 내부에서 보존.
 *
 * 중요:
 * - Gemini Adapter는 Thought Signature를 내부에 유지
 * - Groq Adapter는 OpenAI 형식 메시지 배열 유지
 * - Workers AI Adapter는 선택한 API 형식에 맞는 이력 유지
 *
 * 공통 인터페이스에 Provider 전용 필드를 노출하지 않음.
 */
export interface ProviderSession {
  /**
   * 다음 LLM 응답 생성.
   * tools가 비어있거나 toolChoice가 'none'이면 도구 호출 없이 텍스트만 생성.
   */
  next(options: {
    tools: ToolDefinition[]
    toolChoice: 'auto' | 'none'
    maxOutputTokens: number
    /** 시스템 프롬프트 (첫 호출 시) */
    systemPrompt?: string
  }): Promise<ModelStep>

  /**
   * 도구 실행 결과를 Provider 원본 형식으로 이력에 추가.
   * 각 Adapter가 자신의 형식으로 변환하여 저장.
   */
  appendToolResults(results: ToolResult[]): void

  /**
   * 다음 호출의 예상 입력 토큰 수 (선택적).
   * 구현하지 않으면 Runner가 보수적 추정 사용.
   * 실제 전송할 메시지를 기준으로 계산해야 함.
   */
  estimateInputTokens?(options: {
    tools: ToolDefinition[]
    toolChoice: 'auto' | 'none'
    maxOutputTokens: number
    systemPrompt?: string
  }): number | null

  /** 현재 Provider ID */
  readonly provider: ProviderId

  /** 현재 모델 ID */
  readonly modelId: string
}

// ---------------------------------------------------------------------------
// Budget — 요청당 예산
// ---------------------------------------------------------------------------

/**
 * 사용자 요청당 적용되는 예산.
 * 8,000 토큰 = 요청당 누적 입력 상한 (앱 정책값).
 */
export type Budget = {
  /** 최대 LLM 호출 횟수 */
  maxModelCalls: number
  /** 최대 도구 호출 횟수 */
  maxToolCalls: number
  /** 누적 입력 토큰 상한 */
  maxTotalInputTokens: number
  /** 호출당 최대 출력 토큰 */
  maxOutputTokensPerCall: number
  /** 도구 결과 최대 문자 수 */
  maxToolResultChars: number
  /** 도구 실행 타임아웃 (ms) */
  toolTimeoutMs: number
}

/** Phase 1 초기 권장 예산 — 총 입력 토큰 기본 상한 (S5-4, 5-9). */
export const DEFAULT_MAX_TOTAL_INPUT_TOKENS = 8000

/** Phase 1 초기 권장 예산 */
export const DEFAULT_BUDGET: Budget = {
  maxModelCalls: 3,
  maxToolCalls: 4,
  maxTotalInputTokens: DEFAULT_MAX_TOTAL_INPUT_TOKENS,
  maxOutputTokensPerCall: 1024,
  maxToolResultChars: 1500,
  toolTimeoutMs: 5000,
}

// ---------------------------------------------------------------------------
// ExecutionContext — 도구 실행 컨텍스트
// ---------------------------------------------------------------------------

/**
 * 실행 출처 (Talorys ③-A, docs/talorys-patterns-20261029.md §4.3.1).
 * 예약·백그라운드 실행이 대화 세션의 도구 권한을 상속하지 않게 하는 판정축.
 * 생성 지점에서 명시한다: 채팅 라우트='interactive', MCP 서버='mcp',
 * 예약 경로='scheduled', 채널 게이트웨이='channel'.
 * 미지정은 쓰기 판정에 한해 비대화형으로 취급한다 (fail-closed —
 * decideToolExecution·WriteExecutionGuard가 강제).
 */
export type ExecutionOrigin = 'interactive' | 'scheduled' | 'mcp' | 'channel'

/**
 * 도구 실행 시 전달되는 컨텍스트.
 * 사용자 ID는 모델 인자가 아닌 서버 세션에서 가져옴.
 */
export type ExecutionContext = {
  /** 인증된 사용자 ID */
  userId: string
  /** 요청 식별자 (멱등성 키 생성용) */
  requestId: string
  /** 쓰기 작업 승인 여부 */
  approvedWrites: boolean
  /** 실행 출처 — 쓰기·파괴적 도구는 'interactive'에서만 실행 가능 */
  origin?: ExecutionOrigin
  /** 데이터 민감도 (Phase 2에서 사용) */
  dataSensitivity?: 'general' | 'personal' | 'highly_sensitive'
  /**
   * MCP 요청이 Tasks 확장(io.modelcontextprotocol/tasks)을 선언했는가.
   * MCP 도구에서만 쓴다 — 선언했을 때만 태스크 핸들을 반환한다.
   */
  mcpTasksExtension?: boolean
}
