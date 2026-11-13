/**
 * AI 응답 후처리 — 실행 원장으로 검증되지 않은 성공 주장을 완화하고,
 * 잔류 도구 마커·중간 진행형 답변을 정리한다.
 */

export type SuccessDomain = 'memo' | 'schedule' | 'todo' | 'cron' | 'artifact' | 'file'

export interface ToolExecutionSummary {
  success?: boolean
  ledgerRecorded?: boolean
  toolName?: string
}

const DOMAIN_PATTERNS: Array<{ domain: SuccessDomain; re: RegExp }> = [
  { domain: 'memo', re: /메모/ },
  { domain: 'schedule', re: /일정|캘린더/ },
  { domain: 'todo', re: /할\s?일/ },
  { domain: 'cron', re: /자동화/ },
  { domain: 'artifact', re: /아티팩트/ },
  { domain: 'file', re: /파일/ },
]

const COMPLETION_RE = /(생성|등록|추가|수정|삭제|완료|저장|만들|지웠|지우|보냈|전송)(했|하였|됐|되었|하셨|했습|했어|했어요|했습니다|하였습니다|되었습니다|했음|함(?=[.!?。\s]|$))/
const NON_CLAIM_RE = /(방법|하려면|하시면|하면\s|할\s?수\s?있|하세요|해\s?주세요|해\s?주면|예를\s?들어|라는|이라고|문구|표시됩|과정|기능|버튼|예정|할게|하겠|합니다만\s?아직|아직\s)/

export const UNVERIFIED_CLAIM_NOTICE = '(확인 불가) 해당 작업이 실행됐다는 기록을 확인하지 못했습니다. 목록에서 직접 확인해 주세요.'
export const DANGLING_PROGRESS_NOTICE = '(이 턴에서 실행된 작업은 없습니다. 필요하시면 다시 요청해 주세요.)'
const PROGRESS_ENDING_RE = /(확인하고 있습니다|확인 중입니다|처리하고 있습니다|조회하고 있습니다)\.?$/
const MARKER_NAME = '(?:MEMO|SCHEDULE|TODO|CRON|GMAIL|GCAL|ARTIFACT)(?:_[A-Z]+)?|PAGE|FILE_SEARCH|SEARCH|WEB_SEARCH|IMG|GITHUB|ASK'
export const RESIDUAL_MARKER_NOTICE = '요청 형식을 이해하지 못해 실행하지 못했습니다.'

export function successDomainForTool(toolName: string | undefined): SuccessDomain | null {
  const n = String(toolName || '')
  if (n.startsWith('memo_')) return 'memo'
  if (n.startsWith('schedule_') || n.startsWith('gcal_')) return 'schedule'
  if (n.startsWith('todo_')) return 'todo'
  if (n.startsWith('cron_')) return 'cron'
  if (n.startsWith('artifact_')) return 'artifact'
  return null
}

export function splitSentences(text: string): string[] {
  return String(text || '').split(/(?<=[.!?。…])\s+|\n+/)
}

function mapSentences(text: string, fn: (sentence: string) => string): string {
  const parts = String(text || '').split(/((?<=[.!?。…])\s+|\n+)/)
  return parts.map((part, i) => (i % 2 === 0 ? fn(part) : part)).join('')
}

export function guardUnverifiedSuccessClaims(
  text: string,
  executions: ToolExecutionSummary[]
): { text: string; softened: Array<{ domain: SuccessDomain; sentence: string }> } {
  const src = String(text || '')
  if (!src) return { text: src, softened: [] }
  const verifiedDomains = new Set<SuccessDomain>()
  for (const r of Array.isArray(executions) ? executions : []) {
    if (r && r.success === true && r.ledgerRecorded === true) {
      const d = successDomainForTool(r.toolName)
      if (d) verifiedDomains.add(d)
    }
  }
  const softened: Array<{ domain: SuccessDomain; sentence: string }> = []
  const out = mapSentences(src, (sentence) => {
    if (!COMPLETION_RE.test(sentence) || NON_CLAIM_RE.test(sentence)) return sentence
    for (const { domain, re } of DOMAIN_PATTERNS) {
      if (re.test(sentence)) {
        if (verifiedDomains.has(domain)) return sentence
        softened.push({ domain, sentence })
        return UNVERIFIED_CLAIM_NOTICE
      }
    }
    return sentence
  })
  return {
    text: out.replace(new RegExp(`(${escapeRegExp(UNVERIFIED_CLAIM_NOTICE)}[\\s]*)+`, 'g'), `${UNVERIFIED_CLAIM_NOTICE}\n`).trimEnd(),
    softened,
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function flagDanglingProgressEnding(
  text: string,
  executions: unknown[]
): { text: string; flagged: boolean } {
  const src = String(text || '')
  const trimmed = src.trim()
  const hasExecution = Array.isArray(executions) && executions.length > 0
  if (hasExecution || trimmed.length > 60 || !PROGRESS_ENDING_RE.test(trimmed)) {
    return { text: src, flagged: false }
  }
  return { text: `${trimmed}\n${DANGLING_PROGRESS_NOTICE}`, flagged: true }
}

export function stripResidualToolMarkers(text: string): { text: string; removed: number } {
  let removed = 0
  let out = String(text || '')
  const count = (re: RegExp) => {
    out = out.replace(re, () => {
      removed++
      return RESIDUAL_MARKER_NOTICE
    })
  }
  count(new RegExp(`\\[(${MARKER_NAME})(?::[^\\]]*)?\\][\\s\\S]*?\\[\\/\\1\\]`, 'gi'))
  count(new RegExp(`\\[(?:${MARKER_NAME})(?::[^\\]]*)?\\]\\s*\\{[^{}]*\\}`, 'gi'))
  count(new RegExp(`\\[(?:${MARKER_NAME}):[^\\]]*\\]`, 'gi'))
  out = out.replace(new RegExp(`\\[\\/?(?:${MARKER_NAME})(?::[^\\]]*)?\\]`, 'gi'), () => {
    removed++
    return ''
  })
  out = out.replace(new RegExp(`(${escapeRegExp(RESIDUAL_MARKER_NOTICE)}\\s*){2,}`, 'g'), `${RESIDUAL_MARKER_NOTICE}\n`)
  return { text: out, removed }
}

export function lockedMemoCountSignal(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  return `[사실 신호] 잠긴 메모가 ${Math.floor(count)}건 있어 내용을 확인할 수 없습니다. 해당 주제의 메모가 없다고 단정하지 말고, 잠긴 메모 ${Math.floor(count)}건은 확인하지 못했다고 답하세요.`
}
