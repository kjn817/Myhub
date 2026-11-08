/**
 * NVIDIA 메모 가드 — 트랙 1 (2026-10-30)
 *
 * 근거: docs/nvidia-terms-review-20261029.md
 * - NVIDIA API Trial Terms §2.6(a)·§4.3은 기밀정보·개인정보 포함을 금지하고,
 *   §3.3(iv)는 입출력(User/Generated Content)의 제품·모델 개선 목적 수집을
 *   고지한다 ("학습에 쓰지 않는다"는 약속은 원문에 없다).
 * - 에코(keeper)는 providerPin='nvidia' 고정이라, 메모 전문이 도구 결과로
 *   실리는 세션이 그대로 NVIDIA Trial 경로로 나가는 구간이 있었다.
 *
 * 이 모듈은 두 겹으로 막는다 (fail-closed — 분류가 불확실하면 NVIDIA 금지):
 * 1. 라우팅 가드 (classifyMemoContext + resolveEffectivePolicy):
 *    구조적 신호만으로 결정적으로 분류한다. 메모 컨텍스트가 있거나 있을 수
 *    있는 keeper 요청은 effective providerPin을 'workers-ai'로 바꿔
 *    selectModel의 scopedModels가 NVIDIA를 후보에서 원천 제외하게 한다
 *    (오버라이드·폴백도 전부 workers-ai 안에서만 돈다).
 * 2. 호출 직전 가드 (assertNoMemoContentForNvidia):
 *    NVIDIA plugin.call 직전에 messages를 한 번 더 검사한다. 라우팅이
 *    정상이면 도달할 수 없어야 하며, 도달하면 그 자체가 버그이므로
 *    전송하지 않고 예외로 중단한다.
 *
 * 잠긴 메모·sensitivity≥2는 기존 ai-access 경계가 이미 원천 차단하므로
 * 이 가드의 대상이 아니다 (경계 무변경). 대상은 경계를 통과한
 * sensitivity≤1 메모와 개인 사실(기억) 컨텍스트다.
 *
 * 역할 재판정 (2026-10-30, NVIDIA 운영 경로 완전 제외 이후):
 * 에코 핀이 workers-ai로 바뀌고 NVIDIA 모델 전부가 레지스트리에서
 * 비활성(deprecated)이 되면서, 정상 라우팅으로는 이 가드가 동작할 일이
 * 없어졌다. 그래도 삭제하지 않고 dormant 방어로 유지한다 — 근거:
 * 1. 재활성화 침묵 회귀 방지: 누군가 NVIDIA 모델 status를 되돌리거나
 *    providerPin='nvidia'를 직접 넘기는 호출자가 생기면, 이 가드가 있어야
 *    메모 컨텍스트 턴이 조용히 NVIDIA로 되돌아가지 않는다. 가드를 지우면
 *    재활성화 = 약관 위반 경로의 무방비 복원이 된다.
 * 2. 새 라우팅과의 충돌 없음: resolveEffectivePolicy는 핀이 nvidia일 때만
 *    동작하고, keeper의 현 핀(workers-ai)에서는 rerouted=false로 즉시
 *    반환한다. 호출 직전 assert 2종도
 *    model.provider==='nvidia'일 때만 실행된다 (ai.ts). 즉 현 라우팅에서
 *    이 모듈은 분류 계산 외에 어떤 동작도 바꾸지 않는다.
 * 3. 비용: 분류는 구조적 신호만 보는 순수 함수라 유지 비용이 사실상 없다.
 * 따라서 "복잡하게 만들지 말 것" 원칙에 따라 삭제도, 확장도 하지 않는다.
 */

import { MEMO_FC_TOOLS, normalizeFCToolName } from '../ai/memo-fc-tools'
import type { ChatMessage, TaskPolicy } from './ai-types'
import { detectPii } from './privacy-engine'

/** 메모 FC 도구 이름 집합 (skill-registry가 노출하는 메모 도구와 동일 원천) */
export const MEMO_TOOL_NAMES: ReadonlySet<string> = new Set(MEMO_FC_TOOLS.map((t) => t.name))

/** assistant-call이 메모 검색 결과를 주입할 때 쓰는 서버 생성 접두사 */
export const MEMO_DATA_MARKER = '[서버 제공 참고자료'

export type NvidiaGuardReason =
  | 'memo-fc-tools' // 이번 턴 FC 도구 집합에 메모 도구가 포함됨
  | 'memo-data-injected' // 호출자가 메모 데이터를 메시지에 주입했음 (policy 플래그)
  | 'memory-context-injected' // 호출자가 장기 기억(개인 사실)을 주입했음 (policy 플래그)
  | 'tool-role-message' // 메시지에 도구 결과(role 'tool')가 이미 포함됨
  | 'memo-data-marker' // 메시지에 서버 메모 주입 마커가 포함됨
  | 'personal-data-detected' // 메시지 본문에서 level≥2 개인정보가 탐지됨

export interface MemoContextClassification {
  hasMemoContext: boolean
  reasons: NvidiaGuardReason[]
}

type MessageLike = Pick<ChatMessage, 'role' | 'content' | 'tool_calls'>

/**
 * 진입부 분류 — 구조적 신호만으로 결정적으로 판정한다 (내용 휴리스틱 없음).
 *
 * 신호:
 * ① fcToolNames에 메모 도구가 하나라도 포함 — 이번 턴에 모델이 메모를
 *    읽을 수 있으면, FC 후속 호출에서 메모 전문이 같은 모델로 재전송된다.
 *    keeper 기본 스킬(메모+자동화)이 로드되는 무매칭 턴도 여기에 걸린다
 *    ("포함할 수 있는" 경우까지 fail-closed).
 * ② policy.memoDataInjected — assistant-call의 memoDataMessage(서버 사전
 *    검색 주입)처럼 호출자가 메모 데이터를 직접 넣은 경우.
 * ③ policy.memoryContextInjected — ai_memory 사실·v2 기억 주입. 메모 본문은
 *    아니지만 §4.3의 "식별 가능한 개인에 관한 정보" 그 자체라 같은
 *    제외 대상으로 본다 (fail-closed 기본값).
 * ④ messages에 role 'tool' 메시지가 있음 — 이전 도구 실행 결과가 이미
 *    컨텍스트에 실려 있는 경우 (FC 이력 등).
 * ⑤ messages에 MEMO_DATA_MARKER가 있음 — 플래그를 세우지 않은 직접
 *    호출자가 메모 주입 메시지를 만든 경우의 구조적 탐지.
 *
 * 주의: '[최근 메모 문맥]'·'[기억하고 있는 사용자 정보]' 문자열은 keeper
 * 시스템 프롬프트·스킬 힌트 본문에도 등장하므로 마커로 쓰지 않는다 —
 * 그 경로는 ②③의 명시 플래그로만 판정한다 (오탐 방지).
 */
export function classifyMemoContext(input: {
  policy: TaskPolicy
  messages: readonly MessageLike[]
  fcToolNames?: readonly string[]
}): MemoContextClassification {
  const reasons: NvidiaGuardReason[] = []
  const fcToolNames = input.fcToolNames ?? []
  if (fcToolNames.some((name) => MEMO_TOOL_NAMES.has(name))) {
    reasons.push('memo-fc-tools')
  }
  if (input.policy.memoDataInjected) reasons.push('memo-data-injected')
  if (input.policy.memoryContextInjected) reasons.push('memory-context-injected')
  let hasToolRole = false
  let hasMarker = false
  for (const m of input.messages) {
    if (m.role === 'tool') hasToolRole = true
    if (typeof m.content === 'string' && m.content.includes(MEMO_DATA_MARKER)) hasMarker = true
  }
  if (hasToolRole) reasons.push('tool-role-message')
  if (hasMarker) reasons.push('memo-data-marker')
  return { hasMemoContext: reasons.length > 0, reasons }
}

/**
 * 메시지 본문에서 level≥2 개인정보(개인 사실)를 탐지한다.
 * system 메시지는 제외한다(시스템 프롬프트의 일반 서술 오탐 방지).
 * 탐지된 유형 목록을 돌려주고, 없으면 null.
 */
export function findPersonalDataInMessages(
  messages: readonly MessageLike[],
): { types: string[] } | null {
  const types = new Set<string>()
  for (const m of messages) {
    if (m.role === 'system') continue
    if (typeof m.content !== 'string' || !m.content) continue
    for (const f of detectPii(m.content)) {
      if (f.level >= 2) types.add(f.type)
    }
  }
  return types.size > 0 ? { types: [...types].sort() } : null
}

/**
 * 분류 결과에 개인정보 탐지 신호를 합친다. 개인정보가 탐지되면
 * 메모 컨텍스트가 있는 것으로 간주한다(fail-closed).
 */
export function withPersonalDataSignal(
  classification: MemoContextClassification,
  messages: readonly MessageLike[],
): MemoContextClassification {
  if (!findPersonalDataInMessages(messages)) return classification
  if (classification.reasons.includes('personal-data-detected')) return classification
  return { hasMemoContext: true, reasons: [...classification.reasons, 'personal-data-detected'] }
}

/**
 * 라우팅 결정: 메모 컨텍스트가 있는 NVIDIA행 요청의 effective policy를
 * 만든다. 대상은 providerPin이 'nvidia'로 명시된 요청뿐이다 —
 * 다른 프로바이더로 고정된 비서(gemini/groq)는 NVIDIA 약관과 무관하므로
 * 건드리지 않는다. 판정은 핀 기준으로만 한다 (2026-11-05 핀 축소 확정:
 * personaId만으로 대상을 넓히지 않는다 — 핀이 없는 요청은 이 가드의
 * 대상이 아니며, 실제 NVIDIA행 여부는 핀이 결정한다).
 */
export function resolveEffectivePolicy(
  policy: TaskPolicy,
  classification: MemoContextClassification,
): { policy: TaskPolicy; rerouted: boolean } {
  if (!classification.hasMemoContext) return { policy, rerouted: false }
  const targetsNvidia = policy.providerPin === 'nvidia'
  if (!targetsNvidia) return { policy, rerouted: false }
  return { policy: { ...policy, providerPin: 'workers-ai' }, rerouted: true }
}

// ---------------------------------------------------------------------------
// 호출 직전 가드 (이중 방어)
// ---------------------------------------------------------------------------

export class NvidiaMemoGuardError extends Error {
  readonly code = 'NVIDIA_MEMO_GUARD_BLOCKED'
  /** aiChat 폴백 체인이 재시도하지 않도록 한다 — 다른 NVIDIA 모델도 같은 이유로 막힌다 */
  readonly retryable = false
  readonly reason: string
  constructor(reason: string) {
    super(`NVIDIA memo guard blocked the call: ${reason}`)
    this.name = 'NvidiaMemoGuardError'
    this.reason = reason
  }
}

/**
 * 도구 결과 JSON이 일반 텍스트 메시지에 박혀 있는 형태 (대화 이력에 남은
 * dispatcher 결과, 임베디드 도구 호출 등). 진입부 분류는 구조 신호만 보므로
 * 이 휴리스틱 탐지는 호출 직전 가드 전용이다 — 두 겹이 서로 독립이어야
 * 한쪽이 뚫려도 다른 쪽이 잡는다.
 */
const MEMO_TOOL_JSON_PATTERNS: ReadonlyArray<RegExp> = [
  /"toolName"\s*:\s*"(?:memo_|MEMO_)/,
  /"tool_name"\s*:\s*"(?:memo_|MEMO_)/,
  /"tool"\s*:\s*"(?:MEMO_|memo_)/,
  /"name"\s*:\s*"(?:memo_|MEMO_)/,
]

/** 구조적 JSON 탐지에서 도구 이름으로 인정하는 키 집합 */
const TOOL_NAME_KEYS: ReadonlySet<string> = new Set(['toolName', 'tool_name', 'tool', 'name'])

function isMemoToolNameValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = normalizeFCToolName(value)
  return normalized !== null && MEMO_TOOL_NAMES.has(normalized)
}

function unescapeJsonLike(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
}

/**
 * 임의의 값(파싱된 JSON·tool_calls 등)을 재귀 탐색해, 도구 이름 키에
 * 메모 도구 이름이 실려 있으면 true. 문자열 안에 JSON이 박혀 있으면
 * 파싱해서 다시 탐색한다 (이중 인코딩된 이력 대응, 깊이 6 제한).
 */
function valueHasMemoToolReference(value: unknown, depth: number): boolean {
  if (value == null || depth > 6) return false
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        return valueHasMemoToolReference(JSON.parse(trimmed), depth + 1)
      } catch {
        return false
      }
    }
    return false
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueHasMemoToolReference(item, depth + 1))
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (TOOL_NAME_KEYS.has(key) && isMemoToolNameValue(v)) return true
      if (valueHasMemoToolReference(v, depth + 1)) return true
    }
  }
  return false
}

/** 텍스트에서 균형 잡힌 {...} 조각을 최대 20개까지 추출한다 (문자열 내부 중괄호 무시) */
function extractJsonObjectFragments(text: string): string[] {
  const fragments: string[] = []
  const n = text.length
  let i = 0
  while (i < n && fragments.length < 20) {
    const start = text.indexOf('{', i)
    if (start === -1) break
    let depth = 0
    let inString = false
    let escaped = false
    let j = start
    for (; j < n; j++) {
      const ch = text[j]
      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    if (depth !== 0) break
    fragments.push(text.slice(start, j))
    i = start + 1
  }
  return fragments
}

/**
 * 문자열 본문에 메모 도구 결과 JSON이 실려 있는지 — 정규식 패턴(원문과
 * \uXXXX 이스케이프 해제본 양쪽) + JSON 파싱 기반 구조 탐지(이력에
 * 텍스트로 남은 도구 결과·조각난 JSON까지).
 */
function contentHasMemoToolJson(content: string): boolean {
  const variants = content.includes('\\') ? [content, unescapeJsonLike(content)] : [content]
  for (const variant of variants) {
    for (const pattern of MEMO_TOOL_JSON_PATTERNS) {
      if (pattern.test(variant)) return true
    }
  }
  const trimmed = content.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    try {
      if (valueHasMemoToolReference(JSON.parse(trimmed), 0)) return true
    } catch {
    }
  }
  for (const fragment of extractJsonObjectFragments(content)) {
    try {
      if (valueHasMemoToolReference(JSON.parse(fragment), 0)) return true
    } catch {
    }
  }
  return false
}

/** 메시지 1건에 메모 도구 참조가 있는지 — 문자열 본문·구조화 본문·tool_calls 전부 */
function messageHasMemoToolJson(m: MessageLike): boolean {
  if (typeof m.content === 'string') {
    if (m.content && contentHasMemoToolJson(m.content)) return true
  } else if (m.content != null) {
    if (valueHasMemoToolReference(m.content, 0)) return true
  }
  if (m.tool_calls !== undefined && valueHasMemoToolReference(m.tool_calls, 0)) return true
  return false
}

/** messages에서 메모 유래 내용을 찾으면 사유 문자열, 없으면 null */
export function findMemoContentInMessages(messages: readonly MessageLike[]): string | null {
  for (const m of messages) {
    if (m.role === 'tool') return 'tool-role-message'
    const content = typeof m.content === 'string' ? m.content : ''
    if (content.includes(MEMO_DATA_MARKER)) return 'memo-data-marker'
    if (messageHasMemoToolJson(m)) return 'memo-tool-result-json'
  }
  if (findPersonalDataInMessages(messages)) return 'personal-data-detected'
  return null
}

/**
 * NVIDIA 호출 직전 최종 검사. 메모 유래 내용이 있으면 전송하지 않고
 * NvidiaMemoGuardError로 중단한다 (fail-closed).
 */
export function assertNoMemoContentForNvidia(messages: readonly MessageLike[]): void {
  const found = findMemoContentInMessages(messages)
  if (found) throw new NvidiaMemoGuardError(found)
}

/**
 * FC 후속 호출 전용 검사 — "메모 유래 내용"만 찾는다.
 *
 * findMemoContentInMessages와의 차이: tool 역할이라는 이유만으로는
 * 차단하지 않는다. 진입부 분류(classifyMemoContext)가 이미 메모 도구
 * 부착 턴을 workers-ai로 돌리므로, NVIDIA에 도달한 FC 턴에 부착된 도구는
 * 메모 도구가 아니다. 그런데도 후속 호출 직전 검사가 tool 역할 전체를
 * 막으면 cron_create·schedule_create 같은 비메모 도구의 실행 결과가
 * NVIDIA로 돌아가지 못해 FC 루프가 항상 중단된다 (2026-10-30 실측으로
 * 확인된 과잉 차단 — cron FC가 NVIDIA에서 완주 불가였다).
 *
 * 이 검사가 잡는 것:
 * - 서버 메모 주입 마커(MEMO_DATA_MARKER)가 실린 메시지
 * - 도구 결과 JSON에 메모 도구(toolName "memo_*")가 찍힌 경우 — 부착되지
 *   않은 메모 도구를 모델이 지어내 호출한 경우(preflight는 레지스트리
 *   전체로 검증하므로 실행될 수 있다)가 바로 이 경우다.
 * tool 메시지의 본문도 같은 패턴으로 검사한다 (역할만으로 판단하지 않음).
 */
export function findMemoDerivedContentInMessages(messages: readonly MessageLike[]): string | null {
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : ''
    if (content.includes(MEMO_DATA_MARKER)) return 'memo-data-marker'
    if (messageHasMemoToolJson(m)) return 'memo-tool-result-json'
  }
  if (findPersonalDataInMessages(messages)) return 'personal-data-detected'
  return null
}

/**
 * FC 후속 호출 직전 검사. 메모 유래 내용이 실려 있으면 전송하지 않는다.
 * 비메모 도구 결과(cron·schedule 등)는 통과시킨다.
 */
export function assertNoMemoDerivedContentForNvidia(messages: readonly MessageLike[]): void {
  const found = findMemoDerivedContentInMessages(messages)
  if (found) throw new NvidiaMemoGuardError(found)
}
