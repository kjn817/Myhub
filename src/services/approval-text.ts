import { maskToolArgs } from './tool-approval'

function targetId(args: Record<string, unknown>): string | null {
  for (const key of [
    'id',
    'memoId',
    'scheduleId',
    'todoId',
    'cronId',
    'artifactId',
    'memo_id',
    'schedule_id',
    'todo_id',
    'cron_id',
    'artifact_id',
  ]) {
    const v = args[key]
    if (typeof v === 'number' && Number.isInteger(v)) return String(v)
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function textOf(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

export interface ToolActionDescription {
  summary: string
  reversible: boolean
  impact: string
}

export function describeToolAction(tool: string, maskedArgs: unknown): ToolActionDescription {
  const upper = String(tool).toUpperCase()
  const args: Record<string, unknown> = maskedArgs !== null && typeof maskedArgs === 'object' ? (maskedArgs as Record<string, unknown>) : {}
  const id = targetId(args)
  const title = textOf(args, ['title'])
  const text = textOf(args, ['text', 'content'])
  const preview = text ? ` "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"` : ''
  const titlePart = title ? ` "${title.slice(0, 50)}"` : ''
  switch (upper) {
    case 'MEMO_CREATE':
      return { summary: `메모 생성${preview}`, reversible: true, impact: '새 메모 1개가 만들어집니다. 필요 없으면 삭제할 수 있어요.' }
    case 'MEMO_UPDATE':
      return { summary: `메모 #${id ?? '?'} 수정${preview}`, reversible: false, impact: '메모 내용이 바뀝니다. 수정 전 내용은 복원되지 않아요.' }
    case 'MEMO_DELETE':
      return { summary: `메모 #${id ?? '?'} 삭제`, reversible: false, impact: '메모 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'SCHEDULE_CREATE':
      return { summary: `일정${titlePart} 등록`, reversible: true, impact: '새 일정 1개가 등록됩니다. 필요 없으면 삭제할 수 있어요.' }
    case 'SCHEDULE_UPDATE':
      return { summary: `일정 #${id ?? '?'} 수정`, reversible: false, impact: '일정 내용이 바뀝니다. 수정 전 내용은 복원되지 않아요.' }
    case 'SCHEDULE_DELETE':
      return { summary: `일정${titlePart || (id ? ` #${id}` : '')} 삭제`, reversible: false, impact: '일정 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'TODO_ADD':
      return { summary: `할 일${titlePart} 추가`, reversible: true, impact: '할 일 1개가 추가됩니다. 필요 없으면 삭제할 수 있어요.' }
    case 'TODO_DONE':
      return { summary: `할 일 #${id ?? '?'} 완료 처리`, reversible: true, impact: '할 일 1개가 완료로 바뀝니다. 다시 미완료로 되돌릴 수 있어요.' }
    case 'TODO_UPDATE':
      return { summary: `할 일 #${id ?? '?'} 수정`, reversible: false, impact: '할 일 내용이 바뀝니다. 수정 전 내용은 복원되지 않아요.' }
    case 'TODO_DELETE':
      return { summary: `할 일 #${id ?? '?'} 삭제`, reversible: false, impact: '할 일 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'ARTIFACT_CREATE':
      return { summary: `아티팩트${titlePart} 생성`, reversible: true, impact: '아티팩트 1개가 만들어집니다. 필요 없으면 삭제할 수 있어요.' }
    case 'ARTIFACT_DELETE':
      return { summary: `아티팩트 #${id ?? '?'} 삭제`, reversible: false, impact: '아티팩트 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'ARTIFACT_FROM_GITHUB':
      return { summary: 'GitHub에서 아티팩트 가져오기', reversible: true, impact: '아티팩트 1개가 만들어집니다. 필요 없으면 삭제할 수 있어요.' }
    case 'CRON_CREATE':
      return { summary: `자동화 저장${preview}`, reversible: true, impact: '반복 자동화 1개가 저장됩니다. 필요 없으면 끄거나 삭제할 수 있어요.' }
    case 'CRON_DELETE':
      return { summary: `자동화 #${id ?? '?'} 삭제`, reversible: false, impact: '자동화 1개가 영구히 삭제됩니다. 다시 만들려면 처음부터 저장해야 해요.' }
    case 'CRON_TOGGLE': {
      const enabled = args.enabled
      const verb = enabled === true ? '켜기' : enabled === false ? '끄기' : '켜기/끄기'
      return { summary: `자동화 #${id ?? '?'} ${verb}`, reversible: true, impact: '자동화가 켜지거나 꺼집니다. 언제든 다시 바꿀 수 있어요.' }
    }
    default:
      return { summary: `${upper} 실행`, reversible: false, impact: '이 작업의 영향을 확인하지 못했어요.' }
  }
}

export interface ApprovalRequestTextInput {
  summary: string
  userRequest?: string
  reversible: boolean
  impact: string
  dryRunPreview?: string
}

export function buildApprovalRequestText(input: ApprovalRequestTextInput): string {
  const lines = [
    '[승인이 필요해요]',
    `하려는 일: ${input.summary}`,
  ]
  if (input.userRequest) lines.push(`근거: "${input.userRequest}" 요청에 따라`)
  lines.push(
    input.reversible ? '되돌릴 수 있나요: 네, 되돌릴 수 있어요' : '되돌릴 수 있나요: 아니요, 되돌릴 수 없어요',
    `영향 범위: ${input.impact}`
  )
  if (input.dryRunPreview) lines.push('', input.dryRunPreview)
  lines.push(
    '',
    '답변으로 "승인해" / "거부해" / "이 세션 허용해"라고 보내주세요.',
    '(10분 안에 답하지 않으면 이 요청은 만료돼요)'
  )
  return lines.join('\n')
}

const APPROVE_EXACT = new Set([
  '승인',
  '승인해',
  '승인해줘',
  '승인합니다',
  '실행해',
  '실행해줘',
  '진행해',
  '진행해줘',
  '응',
  '어',
  '좋아',
  '좋아요',
  '오케이',
  'ok',
  'yes',
  '네',
  '예',
  '확인',
])

const DENY_EXACT = new Set([
  '거부',
  '거부해',
  '거부해줘',
  '하지마',
  '하지 마',
  '안 해',
  '안해',
  '취소',
  '취소해',
  '취소해줘',
  '중단',
  '그만',
  '싫어',
  '안 돼',
  '안돼',
  'no',
  '아니',
  '아니요',
  '하지 말아줘',
  '하지말아줘',
  '실행하지마',
  '실행하지 마',
])

const DELETE_VERB_EXACT = new Set(['삭제해', '삭제해줘', '지워', '지워줘', '지워버려'])

const SESSION_ALLOW_EXACT = new Set([
  '이 세션 허용해',
  '이 세션 허용',
  '이 세션 허용해줘',
  '이 세션 허용합니다',
  '세션 허용해',
  '세션 허용',
  '세션 허용해줘',
  '이 대화 허용해',
  '이 대화 허용',
  '대화 허용해',
  '대화 허용',
  '계속 허용해',
  '계속 허용',
  '계속 허용해줘',
  '이번 대화는 허용해',
  '이번 대화 허용해',
  '이번 대화 계속 허용해줘',
  '허용해줘 세션',
  '허용해 세션',
])

const SESSION_ALLOW_ANCHORED_RE = /^((이번\s+)?(이\s*)?(세션|대화)(\s*(에서는|에서|은|는|동안))?(\s*계속)?|계속)\s*허용(해|해줘|합니다|할게|할게요)?$/
const SESSION_DENY_RE = /(허용\s*(하지|안|못)|실행하지|하지\s*마|하지마|하지\s*말|안\s*돼|안돼|절대\s*\S{0,10}(하지|실행하지|안))/
const SESSION_NON_DECISION_RE = /(어떻게|무엇|뭐|왜|물어|여부|범위|인가|할까|되나|됐어|돼가)/

const CASUAL_APPROVE_EXACT = new Set([
  '응',
  '어',
  '좋아',
  '좋아요',
  '오케이',
  'ok',
  'yes',
  '네',
  '예',
  '확인',
])

type SessionAllowClassification = 'approve_session' | 'deny' | 'not-session-topic' | 'not-a-decision'

function classifySessionAllowReply(normalized: string): SessionAllowClassification {
  if (!normalized.includes('허용') || !/(세션|대화|계속)/.test(normalized)) {
    return 'not-session-topic'
  }
  if (SESSION_DENY_RE.test(normalized)) return 'deny'
  if (SESSION_NON_DECISION_RE.test(normalized)) return 'not-a-decision'
  if (SESSION_ALLOW_EXACT.has(normalized) || SESSION_ALLOW_ANCHORED_RE.test(normalized)) {
    return 'approve_session'
  }
  return 'not-a-decision'
}

function normalizeReply(text: string): string {
  return text.trim().replace(/[.!?~…\s]+$/u, '').trim().toLowerCase()
}

export function isCasualApprovalReply(text: unknown): boolean {
  if (typeof text !== 'string') return false
  return CASUAL_APPROVE_EXACT.has(normalizeReply(text))
}

export type ApprovalReplyKind = 'approve' | 'deny' | 'approve_session'

export function parseApprovalReply(text: unknown, pendingTool?: string | null): ApprovalReplyKind | null {
  if (typeof text !== 'string') return null
  const normalized = normalizeReply(text)
  if (!normalized) return null
  const session = classifySessionAllowReply(normalized)
  if (session === 'approve_session') return 'approve_session'
  if (session === 'deny') return 'deny'
  if (session === 'not-a-decision') return null
  if (APPROVE_EXACT.has(normalized)) return 'approve'
  if (DENY_EXACT.has(normalized)) return 'deny'
  if (DELETE_VERB_EXACT.has(normalized)) {
    const tool = (pendingTool || '').toUpperCase()
    if (tool.endsWith('_DELETE')) return 'approve'
    return null
  }
  return null
}

export function isPossibleApprovalReply(text: unknown): boolean {
  if (typeof text !== 'string') return false
  const normalized = normalizeReply(text)
  if (!normalized) return false
  const session = classifySessionAllowReply(normalized)
  if (session === 'approve_session' || session === 'deny') return true
  if (session === 'not-a-decision') return false
  return APPROVE_EXACT.has(normalized) || DENY_EXACT.has(normalized) || DELETE_VERB_EXACT.has(normalized)
}

export function describeMaskedToolAction(tool: string, args: unknown): ToolActionDescription {
  const { masked } = maskToolArgs(args)
  return describeToolAction(tool, masked)
}
