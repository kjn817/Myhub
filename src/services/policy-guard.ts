/**
 * 코드로 강제하는 보안 정책 (OpenClaw 패턴 이식 — 트랙 5)
 *
 * 프롬프트 문장으로만 표현되던 보안 경계를 서비스 계층의 코드 검사로 강제한다.
 * 프롬프트를 우회(모델이 금지 마커·도구를 출력)해도 이 계층이 막는다.
 *
 * 강제하는 핵심 경계 2가지:
 * 1) 잠긴 메모 외부 전송 금지 — 잠긴 메모(is_locked=1)·민감도 2,3 메모는
 *    어떤 경로로도 AI 컨텍스트에 들어갈 수 없다 (SQL 필터 + 코드 재검사 이중화).
 * 2) AI의 잠금/해제 불가 — 잠금·해제 도구와 잠금 필드 변경을 코드로 거부한다.
 *    (잠금/해제는 사용자 전용 API POST /api/memo/:id/lock 에서만 수행)
 *
 * 사용 지점:
 * - src/services/ai-access.ts: getAccessibleMemo/searchAccessibleMemos 재검사
 * - src/services/memo-tools.ts: 수정/삭제 전 잠금 판정
 * - src/ai/memo-tool-dispatcher.ts: 도구 호출 진입 시 잠금 도구·필드 거부
 * - src/modules/ai/routes.ts: 모델 출력 텍스트의 잠금 마커를 실행 전 제거
 */

export class PolicyViolationError extends Error {
  constructor(
    public code: 'AI_LOCK_FORBIDDEN' | 'AI_LOCK_FIELD_FORBIDDEN' | 'MEMO_LOCKED' | 'MEMO_RESTRICTED',
    message: string,
  ) {
    super(message)
    this.name = 'PolicyViolationError'
  }
}

// ---------------------------------------------------------------------------
// 경계 2) AI의 잠금/해제 불가
// ---------------------------------------------------------------------------

/** AI가 호출할 수 없는 잠금 관련 도구 이름 (정확 일치) */
export const LOCK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'memo_lock',
  'memo_unlock',
  'MEMO_LOCK',
  'MEMO_UNLOCK',
  'lock_memo',
  'unlock_memo',
  'lock',
  'unlock',
  'memo_lock_block',
  'memo_unlock_block',
  'MEMO_LOCK_BLOCK',
  'MEMO_UNLOCK_BLOCK',
])

/** AI 도구 인자에 들어갈 수 없는 잠금 관련 필드 (소문자 비교) */
export const LOCK_ARG_KEYS: ReadonlySet<string> = new Set([
  'is_locked',
  'locked',
  'lock',
  'unlock',
  'locked_blocks',
  'lock_blocks',
])

function isLockToolName(name: string): boolean {
  if (LOCK_TOOL_NAMES.has(name)) return true
  const lower = name.toLowerCase()
  // 명시적 허용 목록에 없는 'lock'/'unlock' 포함 도구는 전부 거부
  // (현재 AI 도구 6종·마커 20여 종 중 lock 포함 도구는 없음)
  return lower.includes('lock') || lower.includes('unlock')
}

/**
 * 도구 호출 허용 검사 — 위반 시 PolicyViolationError 발생
 * - 잠금/해제 도구 이름 거부
 * - 인자에 잠금 필드(is_locked/locked/...) 포함 시 거부
 * 프롬프트가 "잠가줘"를 허용해도, 모델이 도구를 호출해도 여기서 차단된다.
 */
export function assertToolCallAllowed(name: string, args?: any): void {
  const toolName = String(name ?? '')
  if (isLockToolName(toolName)) {
    throw new PolicyViolationError(
      'AI_LOCK_FORBIDDEN',
      'AI는 메모를 잠그거나 해제할 수 없습니다 (정책 위반으로 차단됨)',
    )
  }
  if (args && typeof args === 'object') {
    for (const key of Object.keys(args)) {
      if (LOCK_ARG_KEYS.has(key.toLowerCase())) {
        throw new PolicyViolationError(
          'AI_LOCK_FIELD_FORBIDDEN',
          `AI는 잠금 필드(${key})를 변경할 수 없습니다 (정책 위반으로 차단됨)`,
        )
      }
    }
  }
}

/**
 * 모델 출력 텍스트에서 잠금 마커를 실행 전에 제거
 * - [MEMO_LOCK]{...}[/MEMO_LOCK], [MEMO_UNLOCK]... 등 paired/single 전부
 * - 허용 도구 마커([MEMO_GET] 등)는 그대로 둔다
 */
export function enforceNoLockMarkers(text: string): string {
  if (!text || typeof text !== 'string') return text
  let out = text
  // paired: [MEMO_LOCK]...[/MEMO_LOCK], [UNLOCK_BLOCK]...[/UNLOCK_BLOCK]
  out = out.replace(
    /\[((?:MEMO_)?(?:UN)?LOCK(?:_BLOCK)?)\]([\s\S]*?)\[\/\1\]/gi,
    '(AI는 메모를 잠그거나 해제할 수 없습니다 — 정책 위반으로 차단됨)',
  )
  // single: [MEMO_LOCK: ...], [UNLOCK: ...]
  out = out.replace(
    /\[(?:MEMO_)?(?:UN)?LOCK(?:_BLOCK)?(?::[^\]]*)?\]/gi,
    '(AI는 메모를 잠그거나 해제할 수 없습니다 — 정책 위반으로 차단됨)',
  )
  return out
}

// ---------------------------------------------------------------------------
// 경계 1) 잠긴 메모 외부 전송 금지
// ---------------------------------------------------------------------------

export interface MemoAccessRow {
  is_locked?: number | boolean | null
  sensitivity?: number | null
}

export function isMemoLocked(row: MemoAccessRow | null | undefined): boolean {
  return !!row && (row.is_locked === 1 || row.is_locked === true)
}

/** AI 컨텍스트로 내보낼 수 없는 메모인지 검사 — 위반 시 PolicyViolationError 발생 */
export function assertMemoAccessibleForAI(row: MemoAccessRow | null | undefined): void {
  if (!row) return // 없음은 호출부의 '찾을 수 없음' 처리 대상 (정책 위반 아님)
  if (isMemoLocked(row)) {
    throw new PolicyViolationError('MEMO_LOCKED', '잠긴 메모는 AI에 전송할 수 없습니다')
  }
  if (typeof row.sensitivity === 'number' && row.sensitivity > 1) {
    throw new PolicyViolationError('MEMO_RESTRICTED', '민감 메모는 AI에 전송할 수 없습니다')
  }
}

/** AI 접근 가능 여부 (예외 없이 boolean — 필터링용) */
export function isMemoAccessibleForAI(row: MemoAccessRow | null | undefined): boolean {
  try {
    assertMemoAccessibleForAI(row)
    return true
  } catch {
    return false
  }
}
