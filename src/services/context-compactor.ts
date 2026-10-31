/**
 * 세션 컨텍스트 축소 (순수, DB 의존성 없음)
 *
 * 긴 대화에서 오래된 도구 출력을 결정적 규칙으로 요약본으로 교체한다
 * (context-mode의 세션 메모리 지속 패턴을 LLM 없이 규칙으로 구현).
 *
 * 규칙:
 * - system 메시지는 절대 건드리지 않는다.
 * - 최근 keepRecent개 메시지는 그대로 둔다 (현재 턴의 문맥 보존).
 * - 총 문자 수가 budgetChars를 넘을 때만 축소한다 (넘지 않으면 그대로 반환).
 * - 오래된 user 메시지: 앞부분만 남기고 축소 표시를 붙인다.
 * - 오래된 assistant 메시지: 도구 출력 블록만 샌드박스 요약으로 교체하고,
 *   나머지 평문은 상한으로 절단한다. 도구 출력이 아닌 짧은 메시지는 그대로 둔다.
 *
 * 결정적이다: 같은 입력은 항상 같은 출력을 낸다 (시간·난수·LLM 없음).
 * 스키마 변경 없음 — 메시지 배열의 메모리 내 복사본만 변환한다.
 */

import { sandboxToolOutput, sanitizeToolOutput } from '../lib/context-sandbox'

export interface CompactableMessage {
  role: string
  content: string
  [key: string]: unknown
}

export interface CompactionStats {
  originalChars: number
  keptChars: number
  /** 요약본으로 교체한 도구 출력 블록 수 */
  replacedBlocks: number
  /** 내용이 바뀐 메시지 수 */
  changedMessages: number
  /** 예산 이하라 축소를 건너뛰었는지 */
  skipped: boolean
}

export interface CompactMessagesResult {
  messages: CompactableMessage[]
  stats: CompactionStats
}

export interface CompactOptions {
  /** 축소를 시작하는 총 문자 수. 기본값 12000 (≈3000 토큰) */
  budgetChars?: number
  /** 그대로 둘 최근 메시지 수 (system 제외). 기본값 6 */
  keepRecent?: number
  /** 오래된 user 메시지 상한 문자 수. 기본값 500 */
  maxOldUserChars?: number
  /** 오래된 assistant 메시지 평문 상한 문자 수. 기본값 800 */
  maxOldAssistantChars?: number
  /** 도구 출력 요약 시 관련 문장을 고르는 기준 질의 */
  query?: string
}

export const DEFAULT_CONTEXT_BUDGET_CHARS = 12000
export const DEFAULT_KEEP_RECENT = 6

const OLD_USER_TRUNC_SUFFIX = '\n… [이전 메시지 축소됨]'
const OLD_ASSISTANT_TRUNC_SUFFIX = '\n… [이전 응답 축소됨]'
const SUMMARIZED_BLOCK_PREFIX = '[요약된 도구 출력] '
/** 도구 출력 블록을 요약본으로 교체하는 기준 길이 (이하면 마커 중화만 적용). */
export const TOOL_BLOCK_SUMMARY_CHARS = 600

/** 도구 출력 블록 시작을 알리는 줄 패턴 (processToolMarkers가 삽입하는 형태). */
const TOOL_BLOCK_PATTERNS: RegExp[] = [
  /^웹검색 \(/,
  /^메모 검색 결과/,
  /^GitHub 검색 \(/,
  /^\[자료 \d+\]/,
  /^일정 목록/,
  /^할일 목록/,
  /^메모:\s*$/m,
]

function isToolBlockStart(line: string): boolean {
  return TOOL_BLOCK_PATTERNS.some((re) => re.test(line))
}

export function totalChars(messages: CompactableMessage[]): number {
  return messages.reduce((sum, m) => sum + String(m.content || '').length, 0)
}

/**
 * 메시지 배열을 축소한다. 원본 배열·메시지 객체는 변경하지 않는다.
 */
export function compactMessages(
  messages: CompactableMessage[],
  opts: CompactOptions = {},
): CompactMessagesResult {
  const budgetChars = opts.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT
  const maxOldUserChars = opts.maxOldUserChars ?? 500
  const maxOldAssistantChars = opts.maxOldAssistantChars ?? 800
  const originalChars = totalChars(messages)
  const skippedResult = (): CompactMessagesResult => ({
    messages: messages.map((m) => ({ ...m })),
    stats: {
      originalChars,
      keptChars: originalChars,
      replacedBlocks: 0,
      changedMessages: 0,
      skipped: true,
    },
  })
  if (messages.length === 0 || originalChars <= budgetChars) return skippedResult()

  // system 메시지는 위치와 무관하게 보존, 나머지만 최근성 기준으로 나눈다.
  const nonSystemIdx: number[] = []
  messages.forEach((m, i) => {
    if (m.role !== 'system') nonSystemIdx.push(i)
  })
  const recentSet = new Set(nonSystemIdx.slice(-keepRecent))
  let replacedBlocks = 0
  let changedMessages = 0

  const compacted = messages.map((m, i) => {
    if (m.role === 'system' || recentSet.has(i)) return { ...m }
    const content = String(m.content || '')
    if (m.role === 'user') {
      if (content.length <= maxOldUserChars) return { ...m }
      changedMessages++
      return {
        ...m,
        content: content.slice(0, maxOldUserChars) + OLD_USER_TRUNC_SUFFIX,
      }
    }
    if (m.role === 'assistant') {
      const { text, replaced } = compactAssistantContent(content, maxOldAssistantChars, opts.query)
      if (replaced === 0 && text === content) return { ...m }
      replacedBlocks += replaced
      changedMessages++
      return { ...m, content: text }
    }
    return { ...m }
  })

  return {
    messages: compacted,
    stats: {
      originalChars,
      keptChars: totalChars(compacted),
      replacedBlocks,
      changedMessages,
      skipped: false,
    },
  }
}

/**
 * assistant 메시지 내용 축소: 도구 출력 블록은 샌드박스 요약으로 교체,
 * 나머지 평문은 상한으로 절단한다. 교체·절단이 없으면 원문을 그대로 돌려준다.
 */
export function compactAssistantContent(
  content: string,
  maxPlainChars: number,
  query?: string,
): { text: string; replaced: number } {
  if (!content) return { text: content, replaced: 0 }
  // 빈 줄 기준 블록 분리 (도구 출력은 보통 빈 줄로 구분된 덩어리다)
  const blocks = content.split(/\n\s*\n/)
  let replaced = 0
  const out: string[] = []
  for (const block of blocks) {
    const firstLine = block.split('\n')[0]?.trim() ?? ''
    if (isToolBlockStart(firstLine)) {
      if (block.length > TOOL_BLOCK_SUMMARY_CHARS) {
        // 긴 도구 출력만 요약본으로 교체 (짧으면 요약 표시가 오히려 길어진다)
        const sandboxed = sandboxToolOutput(block, {
          toolName: 'history',
          query,
          maxChars: TOOL_BLOCK_SUMMARY_CHARS,
        })
        out.push(SUMMARIZED_BLOCK_PREFIX + sandboxed.text)
        replaced++
      } else {
        // 짧은 블록은 그대로 두되 마커·삽입 지시만 중화
        // (이력 경유 프롬프트 인젝션 방지 — 모델 컨텍스트로 다시 들어가므로)
        out.push(sanitizeToolOutput(block))
      }
    } else if (block.length > maxPlainChars) {
      // 도구 출력이 섞여 있어도 평문 블록은 개별 상한을 넘지 않는다
      out.push(block.slice(0, maxPlainChars) + OLD_ASSISTANT_TRUNC_SUFFIX)
    } else {
      out.push(block)
    }
  }
  const text = out.join('\n\n')
  return { text, replaced }
}
