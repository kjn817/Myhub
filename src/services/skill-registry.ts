/**
 * 스킬 패키지 레지스트리 — 진짜 비서 프로그램 2단계 e트랙
 *
 * 기능을 작은 스킬 단위로 쪼개, 채팅 턴마다 필요한 스킬만 로드한다.
 * - Leon 패턴: 의도 → 스킬 모듈로 실행, 스킬은 작은 단위.
 * - Agent Zero의 자기-도구화(에이전트가 스킬을 만드는 것)는 이번 트랙 범위 밖 —
 *   스킬은 서버가 정의한 고정 목록이다 (신규 스킬 추가는 코드 변경으로만).
 *
 * 설계 원칙:
 * 1. 순수·결정적: DB·시간·난수·LLM 없음. 같은 입력은 항상 같은 스킬 집합.
 * 2. 지연 로딩: 의도에 맞는 스킬만 로드. FC 스킬은 도구 정의를,
 *    마커 스킬(일정·할일·뉴스)은 짧은 프롬프트 힌트만 주입한다.
 *    마커 경로는 그대로 processToolMarkers가 실행한다 (중복 구현 금지).
 * 3. 기본 동작 유지: 매칭되는 스킬이 없으면 비서 기본 스킬을 로드한다
 *    (keeper: 메모+자동화 — 기존 `[...MEMO_FC_TOOLS, ...CRON_FC_TOOLS]`와 동일).
 *    로드되는 스킬이 없어도(기본 스킬이 없는 비서) 채팅은 그대로 동작한다.
 * 4. 컨텍스트 예산: 스킬별 힌트 상한 + 턴 전체 상한. 초과 시 힌트 축소 후
 *    낮은 점수 스킬부터 통째 탈락. 도구 정의 자체는 잘라내지 않는다
 *    (스킬 중간에 도구를 빼면 스킬 계약이 깨지므로, 탈락은 스킬 단위).
 * 5. 잠금 경계: 스킬은 잠금/해제 도구를 절대 포함하지 않는다.
 *    실행 시점 강제(dispatch 시 policy-guard)는 그대로 유지된다.
 * 6. 권한 경계: 스킬의 personas는 getLegacyMarkerTools와 일치해야 한다
 *    (마커 도구가 없는 비서에게 해당 스킬을 로드하지 않음). 테스트가 강제한다.
 */

import { MEMO_FC_TOOLS, type FCToolDefinition } from '../ai/memo-fc-tools'
import { CRON_FC_TOOLS } from '../ai/cron-fc-tools'
import { SCHEDULE_FC_TOOLS } from '../ai/schedule-fc-tools'
import {
  isValidLegacyPersonaId,
  normalizeLegacyPersonaId,
  type LegacyPersonaId,
} from './persona-id-adapter'

/**
 * 비서 ID를 레거시 ID로 정규화한다.
 * - 이미 레거시 ID면 adapter를 호출하지 않고 그대로 쓴다.
 *   (호출 횟수가 테스트의 일회성 mock이나 호출 순서에 영향을 주지 않게 한다 —
 *    adapter 자체도 레거시 ID는 그대로 반환하므로 의미가 동일하다)
 * - 신규 ID(lumi/echo/…)일 때만 adapter로 변환한다.
 */
function toLegacyPersonaId(value: string | null | undefined): LegacyPersonaId | null {
  if (!value) return null
  if (isValidLegacyPersonaId(value)) return value
  return normalizeLegacyPersonaId(value)
}

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** 스킬 위험 등급 — b트랙 승인 게이트와 같은 분류 (read < write < destructive) */
export type SkillRisk = 'read' | 'write' | 'destructive'

export interface SkillDefinition {
  /** 고유 ID (URL·로그용, 소문자+하이픈) */
  id: string
  /** 한국어 이름 */
  name: string
  /** 한 줄 설명 (로그·문서용) */
  description: string
  /** 매칭 키워드 — 소문자 부분 일치 (한국어는 소문자 변환 무의미, 그대로 비교) */
  keywords: string[]
  /** 매칭 정규식 — 키워드로 잡히지 않는 표현 (키워드보다 높은 점수) */
  patterns?: RegExp[]
  /** 이 스킬이 노출하는 FC 도구 정의 (없으면 마커 전용 스킬) */
  tools: FCToolDefinition[]
  /** 마커 경로 도구명 (예: SCHEDULE_CREATE) — 힌트·권한 확인용 */
  markerTools: string[]
  /** 로드 시 시스템 프롬프트에 주입하는 짧은 지시 (예산 적용 대상) */
  promptHint: string
  /** 마커 경로(toolPath='marker')에서 promptHint 대신 주입하는 지시 */
  markerPromptHint?: string
  /** 이 스킬을 쓸 수 있는 비서(레거시 ID). 빈 배열이면 전체 비서 */
  personas: LegacyPersonaId[]
  /** 이 스킬이 주입하는 힌트 문자 상한 (기본 2000) */
  maxChars: number
  /** 위험 등급 */
  risk: SkillRisk
}

export interface SkillMatch {
  skill: SkillDefinition
  /** 키워드 +1/개, 패턴 +2/개 */
  score: number
}

export interface SkillLoadStats {
  /** 주입되는 스킬 내용 전체 문자 수 (힌트 + 도구 설명) */
  totalChars: number
  /** 보수적 토큰 추정치 (한글 1자 ≈ 1~2토큰 → 2자당 1토큰으로 계산) */
  estimatedTokens: number
  /** 힌트가 잘린 스킬 ID */
  truncatedSkills: string[]
  /** 전체 예산 초과로 탈락한 스킬 ID (낮은 점수부터) */
  droppedSkills: string[]
  /** 도구 정의만으로 스킬 예산을 넘긴 스킬 ID (힌트 0자로 축소됨) */
  overBudgetSkills: string[]
}

export interface SkillLoad {
  /** 로드된 스킬 (점수 내림차순, 동점이면 레지스트리 순서) */
  skills: SkillDefinition[]
  /** 로드된 스킬 ID */
  matchedIds: string[]
  /** 모델에 전달할 FC 도구 정의 (모든 로드 스킬의 합집합) */
  tools: FCToolDefinition[]
  /** 마커 경로 도구명 합집합 */
  markerTools: string[]
  /** 시스템 프롬프트에 붙일 섹션 (스킬이 없으면 빈 문자열) */
  promptSection: string
  stats: SkillLoadStats
}

export interface ResolveSkillsOptions {
  /** 마지막 사용자 메시지 원문 */
  text: string
  /** 비서 ID (레거시·신규 모두 허용, 알 수 없으면 전체 허용 스킬만) */
  personaId?: string | null
  /** 턴 전체 스킬 예산 문자 수 (기본 6000 ≈ 3000토큰) */
  totalBudgetChars?: number
  /** 도구 경로 (미지정 시 keeper='fc', 그 외='marker') */
  toolPath?: 'fc' | 'marker'
}

// ---------------------------------------------------------------------------
// 예산 상수
// ---------------------------------------------------------------------------

/** 턴 전체 스킬 예산 (문자) — 힌트 + 도구 설명 합산 기준
 *  (keeper 기본 로드 메모 2126자 + 자동화 1383자 + 힌트 ≈ 3740자이므로
 *   다중 스킬 턴까지 수용하도록 6000자로 잡는다 ≈ 3000토큰) */
export const DEFAULT_TOTAL_SKILL_BUDGET_CHARS = 6000
/** 힌트 축소 표시 */
export const SKILL_HINT_TRUNC_SUFFIX = '\n…(스킬 힌트 축소됨)'

/**
 * 보수적 토큰 추정치.
 * - 영문 기준 1토큰 ≈ 4자는 한글 텍스트에 과소평가가 된다.
 * - 한글은 1자 ≈ 1~2토큰이므로 2자당 1토큰으로 잡는다.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 2)
}

/** 도구 1건의 설명 분량 (이름 + 설명 + 파라미터 스키마) */
export function toolDefinitionChars(tool: FCToolDefinition): number {
  return (
    tool.name.length +
    tool.description.length +
    JSON.stringify(tool.parameters).length
  )
}

// ---------------------------------------------------------------------------
// 스킬 정의 — 경계는 기존 도구·마커 목록을 그대로 따른다
// ---------------------------------------------------------------------------

export const SKILLS: ReadonlyArray<SkillDefinition> = [
  {
    id: 'memo',
    name: '메모',
    description: '메모 작성·검색·조회·삭제·UI 동작 (에코 FC 도구)',
    keywords: ['메모', '기록', '기억해'],
    patterns: [/메모.*(삭제|수정|요약|정리|불러)/],
    tools: MEMO_FC_TOOLS,
    markerTools: ['MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'MEMO_UPDATE', 'MEMO_DELETE'],
    promptHint:
      '메모 도구(memo_create/memo_search/memo_get/memo_update/memo_delete/memo_ui_action)가 로드됨. ' +
      '메모 작성·검색·열기·수정 요청에만 사용해. 직접 받아쓰기는 memo_create_from_source를 써.',
    markerPromptHint:
      '메모 도구(마커): 검색 [MEMO_SEARCH]{"query": "검색어"}[/MEMO_SEARCH], 조회 [MEMO_GET]{"id": 번호}[/MEMO_GET], ' +
      '작성 [MEMO_CREATE]{"text": "내용"}[/MEMO_CREATE], 수정 [MEMO_UPDATE]{"id": 번호, "text": "새 내용"}[/MEMO_UPDATE], ' +
      '삭제 [MEMO_DELETE]{"id": 번호}[/MEMO_DELETE]. Function Calling 도구명은 쓰지 말고 위 마커 문법으로만 출력해.',
    personas: ['concierge', 'keeper'],
    maxChars: 3000, // 도구 정의만 2126자 — 힌트 여유 포함
    risk: 'destructive',
  },
  {
    id: 'schedule',
    name: '일정',
    description: '일정 조회·등록·변경·삭제 (마커 경로)',
    keywords: ['일정', '스케줄', '약속', '미팅', '회의'],
    patterns: [/언제.*(약속|일정|미팅)/],
    tools: [],
    markerTools: ['SCHEDULE_CREATE', 'SCHEDULE_LIST', 'SCHEDULE_UPDATE', 'SCHEDULE_DELETE'],
    promptHint:
      '일정 도구(마커): 등록 [SCHEDULE_CREATE]{"title": "제목", "start_at": "YYYY-MM-DDTHH:MM:SS"}[/SCHEDULE_CREATE], ' +
      '조회 [SCHEDULE_LIST]{"from": "YYYY-MM-DD"}[/SCHEDULE_LIST], 수정 [SCHEDULE_UPDATE], 삭제 [SCHEDULE_DELETE]. ' +
      '마커만 출력하고 자연어 설명을 함께 출력하지 마.',
    personas: ['concierge', 'scheduler'],
    maxChars: 1200,
    risk: 'write',
  },
  {
    id: 'schedule-create',
    name: '일정 등록',
    description: '단일 일정 등록 (에코 FC 도구 — 조회·수정·삭제는 캘리 영역)',
    // 키워드 없이 패턴(등록 의도)으로만 매칭한다 — 단순 일정 조회
    // ("내일 일정 알려줘")는 이 스킬이 아니라 기존 위임 영역으로 남긴다.
    keywords: [],
    patterns: [/일정.*(등록|추가|만들|잡아|생성)/, /(등록|추가|만들).*일정/],
    tools: SCHEDULE_FC_TOOLS,
    markerTools: [],
    promptHint:
      '일정 등록 도구(schedule_create)가 로드됨. 한 번만 열리는 단일 일정 등록에만 사용해. ' +
      '제목(title)과 시작 시각(start_at, YYYY-MM-DDTHH:MM:SS)을 인자로 넣어. ' +
      '매일/매주 반복되는 자동화는 cron 도구를 써.',
    personas: ['keeper'],
    maxChars: 1500,
    risk: 'write',
  },
  {
    id: 'google',
    name: 'Google 연동',
    description: 'Gmail 검색·조회, Google 캘린더 조회·등록 (OAuth 연동 시, 마커 경로)',
    keywords: ['구글', '지메일', 'gmail', '메일', '캘린더'],
    patterns: [/구글.*(캘린더|메일|일정)/, /지메일.*(찾|검색|보여)/],
    tools: [],
    markerTools: ['GMAIL_SEARCH', 'GMAIL_GET', 'GCAL_LIST', 'GCAL_CREATE'],
    promptHint:
      'Google 연동 도구(마커): 메일 검색 [GMAIL_SEARCH]{"q": "검색어"}[/GMAIL_SEARCH], ' +
      '캘린더 조회 [GCAL_LIST]{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}[/GCAL_LIST], ' +
      '캘린더 등록 [GCAL_CREATE]{"title": "제목", "start_at": "YYYY-MM-DDTHH:MM:SS"}[/GCAL_CREATE]. ' +
      '미연동이면 안내 문장이 돌아오니 그대로 전해. 마커만 출력하고 자연어 설명을 함께 출력하지 마.',
    personas: ['concierge', 'scheduler'],
    maxChars: 1200,
    risk: 'read',
  },
  {
    id: 'todo',
    name: '할일',
    description: '할일 추가·조회·완료·수정·삭제 (마커 경로)',
    keywords: ['할일', '할 일', '투두', '해야 할', '해야할'],
    patterns: [/할\s?일.*(추가|완료|삭제|보여|조회)/],
    tools: [],
    markerTools: ['TODO_ADD', 'TODO_LIST', 'TODO_DONE', 'TODO_UPDATE', 'TODO_DELETE'],
    promptHint:
      '할일 도구(마커): 추가 [TODO_ADD]{"title": "할일"}[/TODO_ADD], 조회 [TODO_LIST]{}[/TODO_LIST], ' +
      '완료 [TODO_DONE]{"title": "할일"}[/TODO_DONE], 수정 [TODO_UPDATE], 삭제 [TODO_DELETE]. 마커만 출력해.',
    personas: ['concierge', 'scheduler'],
    maxChars: 1200,
    risk: 'write',
  },
  {
    id: 'automation',
    name: '자동화',
    description: '반복 자동화 저장·목록·켜기/끄기·삭제 (에코 FC 도구)',
    keywords: ['자동화', '매일', '매주', '반복'],
    patterns: [/매\s?[일주월시간분]\s/, /매시간/, /주기적/],
    tools: CRON_FC_TOOLS,
    markerTools: ['CRON_CREATE', 'CRON_LIST', 'CRON_DELETE', 'CRON_TOGGLE'],
    promptHint:
      '자동화 도구(cron_create/cron_list/cron_set_enabled/cron_delete)가 로드됨. ' +
      '"매일/매주" 같은 반복 요청에만 사용해. 시간 표현이 없으면 도구를 부르지 말고 언제인지 물어봐.',
    markerPromptHint:
      '자동화 도구(마커): 저장 [CRON_CREATE]{"text": "사용자 요청 원문 그대로"}[/CRON_CREATE], 목록 [CRON_LIST][/CRON_LIST], ' +
      '켜기/끄기 [CRON_TOGGLE]{"id": 번호, "enabled": true 또는 false}[/CRON_TOGGLE], 삭제 [CRON_DELETE]{"id": 번호}[/CRON_DELETE]. ' +
      '"매일/매주" 같은 반복 요청에만 사용해. 시간 표현이 없으면 마커를 출력하지 말고 언제인지 물어봐.',
    personas: ['concierge', 'keeper', 'scheduler'],
    maxChars: 2000,
    risk: 'destructive',
  },
  {
    id: 'memory',
    name: '기억',
    description: '장기 기억 조회·활용 (서버 주입 기억, 도구 없음)',
    keywords: ['기억하고', '기억나', '까먹', '잊지', '알고 있'],
    patterns: [/내\s?(생일|이름|취향|주소|전화)/],
    tools: [],
    markerTools: [],
    promptHint:
      '서버가 주입한 [기억하고 있는 사용자 정보]가 있으면 대화에 자연스럽게 활용해. 없는 정보를 지어내지 마.',
    personas: [],
    maxChars: 600,
    risk: 'read',
  },
  {
    id: 'news',
    name: '뉴스',
    description: '최신 뉴스·정보 웹검색 (마커 경로)',
    keywords: ['뉴스', '속보', '브리핑', '소식', '최신 정보'],
    patterns: [/오늘.*(뉴스|소식|이슈)/, /최신.*(뉴스|소식|정보)/],
    tools: [],
    markerTools: ['SEARCH'],
    promptHint:
      '최신 정보가 필요하면 [SEARCH: 검색어] 형식으로 웹검색을 요청해. [SEARCH]...[/SEARCH] 블록 형식은 쓰지 마.',
    personas: [],
    maxChars: 600,
    risk: 'read',
  },
]

/** 비서 기본 스킬 — 매칭되는 스킬이 없을 때 로드 (기존 동작 유지용) */
export const DEFAULT_SKILLS_BY_PERSONA: Record<string, string[]> = {
  keeper: ['memo', 'automation'],
  concierge: [],
  builder: [],
  scheduler: [],
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

export function getSkill(id: string): SkillDefinition | undefined {
  return SKILLS.find((s) => s.id === id)
}

/**
 * 스킬 정의 자체 검증 — 잠금/해제 도구가 스킬에 섞이지 않았는지 확인한다.
 * - 실행 시점 강제(policy-guard)와 별개로, 정의 단계에서 한 번 더 막는다.
 * - 모듈 로드 시 1회 실행되며, 위반 시 예외를 던져 배포 전에 드러난다.
 */
export function validateSkillDefinitions(skills: ReadonlyArray<SkillDefinition> = SKILLS): void {
  for (const skill of skills) {
    const names = [
      ...skill.tools.map((t) => t.name),
      ...skill.markerTools,
    ]
    for (const name of names) {
      if (/LOCK|UNLOCK/i.test(name)) {
        throw new Error(`Skill "${skill.id}" must not contain lock tool: ${name}`)
      }
    }
  }
  const toolNames = skills.flatMap((s) => s.tools.map((t) => t.name))
  const dupes = toolNames.filter((n, i) => toolNames.indexOf(n) !== i)
  if (dupes.length > 0) {
    throw new Error(`Duplicate FC tool names across skills: ${[...new Set(dupes)].join(', ')}`)
  }
}

validateSkillDefinitions()

// ---------------------------------------------------------------------------
// 매칭 — 의도/키워드 기반, 결정적
// ---------------------------------------------------------------------------

/**
 * 텍스트와 비서에 맞는 스킬을 점수순으로 반환한다.
 * - 키워드 1점/개(중복 키워드는 1회만), 패턴 2점/개.
 * - personas가 비어 있지 않은 스킬은 해당 비서에게만 매칭된다.
 *   (알 수 없는 비서는 전체 허용 스킬만 받는다 — deny-by-default와 같은 방향)
 * - 동점은 레지스트리 순서(위에서 정의한 순서)를 유지한다 (정렬 안정성).
 */
export function matchSkills(
  text: string,
  opts?: { personaId?: string | null },
): SkillMatch[] {
  const normalized = typeof text === 'string' ? text.toLowerCase() : ''
  if (!normalized.trim()) return []
  const legacyPersona = opts?.personaId ? toLegacyPersonaId(opts.personaId) : null

  const scored: SkillMatch[] = []
  for (const skill of SKILLS) {
    if (skill.personas.length > 0) {
      if (!legacyPersona || !skill.personas.includes(legacyPersona)) continue
    }
    let score = 0
    for (const keyword of skill.keywords) {
      if (keyword && normalized.includes(keyword.toLowerCase())) score += 1
    }
    for (const pattern of skill.patterns ?? []) {
      // 전역 플래그가 있는 정규식의 lastIndex 오염 방지
      pattern.lastIndex = 0
      if (pattern.test(normalized)) score += 2
    }
    if (score > 0) scored.push({ skill, score })
  }
  // 점수 내림차순, 동점은 레지스트리 순서 (Array.sort는 안정 정렬)
  return scored.sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------------------
// 예산 적용 + 로드 결과 조립
// ---------------------------------------------------------------------------

function truncateHint(hint: string, maxChars: number): { hint: string; truncated: boolean } {
  if (hint.length <= maxChars) return { hint, truncated: false }
  const cut = Math.max(0, maxChars - SKILL_HINT_TRUNC_SUFFIX.length)
  return { hint: hint.slice(0, cut) + SKILL_HINT_TRUNC_SUFFIX, truncated: true }
}

/**
 * 매칭된 스킬들에 예산을 적용해 최종 로드 결과를 만든다.
 * - 스킬별: 힌트를 maxChars로 자른다 (도구 설명이 이미 예산을 넘기면 힌트는 0자).
 * - 전체: 합산이 totalBudgetChars를 넘기면 낮은 점수 스킬부터 통째 탈락.
 *   단, 최고 점수 스킬 1개는 항상 남긴다 (턴이 스킬 없이 비는 것 방지).
 */
export function buildSkillLoad(
  matches: SkillMatch[],
  totalBudgetChars: number = DEFAULT_TOTAL_SKILL_BUDGET_CHARS,
  toolPath: 'fc' | 'marker' = 'fc',
): SkillLoad {
  // 1) 스킬별 힌트 예산
  type PreparedSkill = { match: SkillMatch; hint: string; chars: number; toolChars: number; hintTruncated: boolean }
  const prepared: PreparedSkill[] = matches.map(({ skill, score }) => {
    const toolChars = toolPath === 'fc' ? skill.tools.reduce((sum, t) => sum + toolDefinitionChars(t), 0) : 0
    const hintBudget = Math.max(0, skill.maxChars - toolChars)
    const rawHint = toolPath === 'marker' && skill.markerPromptHint ? skill.markerPromptHint : skill.promptHint
    const { hint, truncated } = truncateHint(rawHint, hintBudget)
    return { match: { skill, score }, hint, chars: hint.length + toolChars, toolChars, hintTruncated: truncated }
  })

  // 2) 전체 예산 — 낮은 점수부터 탈락 (최고 점수 1개는 유지)
  const droppedSkills: string[] = []
  const kept: PreparedSkill[] = [...prepared]
  let totalChars = kept.reduce((sum, p) => sum + p.chars, 0)
  while (kept.length > 1 && totalChars > totalBudgetChars) {
    const dropped = kept.pop()!
    droppedSkills.push(dropped.match.skill.id)
    totalChars -= dropped.chars
  }

  // 통계는 최종 유지 스킬 기준으로만 보고한다 (탈락 스킬은 droppedSkills에만)
  const truncatedSkills = kept.filter((p) => p.hintTruncated).map((p) => p.match.skill.id)
  const overBudgetSkills = kept
    .filter((p) => p.toolChars > p.match.skill.maxChars)
    .map((p) => p.match.skill.id)

  const skills = kept.map((p) => p.match.skill)
  const tools = toolPath === 'fc' ? kept.flatMap((p) => p.match.skill.tools) : []
  const markerTools = [...new Set(kept.flatMap((p) => p.match.skill.markerTools))]

  const promptSection =
    kept.length === 0
      ? ''
      : '[활성 스킬: ' +
        skills.map((s) => s.name).join(', ') +
        ']\n' +
        kept.map((p) => `- ${p.match.skill.name}: ${p.hint}`).join('\n')

  return {
    skills,
    matchedIds: skills.map((s) => s.id),
    tools,
    markerTools,
    promptSection,
    stats: {
      totalChars,
      estimatedTokens: estimateTokens(totalChars),
      truncatedSkills,
      droppedSkills,
      overBudgetSkills,
    },
  }
}

// ---------------------------------------------------------------------------
// 턴 진입점 — 채팅 경로(ai.ts / routes.ts)가 함께 쓰는 유일한 함수
// ---------------------------------------------------------------------------

/**
 * 한 채팅 턴에 로드할 스킬을 결정한다.
 * - 의도 매칭 → 없으면 비서 기본 스킬(keeper: 메모+자동화) → 예산 적용.
 * - 기본 스킬이 없는 비서는 매칭이 없으면 빈 로드(기본 동작 유지).
 */
export function resolveSkillsForTurn(opts: ResolveSkillsOptions): SkillLoad {
  const totalBudget = opts.totalBudgetChars ?? DEFAULT_TOTAL_SKILL_BUDGET_CHARS
  const legacyPersona = opts.personaId ? toLegacyPersonaId(opts.personaId) : null
  const toolPath = opts.toolPath ?? (legacyPersona === 'keeper' ? 'fc' : 'marker')
  const matches = matchSkills(opts.text, { personaId: opts.personaId ?? null })
  if (matches.length > 0) {
    return buildSkillLoad(matches, totalBudget, toolPath)
  }
  const defaultIds = (legacyPersona && DEFAULT_SKILLS_BY_PERSONA[legacyPersona]) || []
  const defaults: SkillMatch[] = defaultIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillDefinition => Boolean(s))
    .map((skill) => ({ skill, score: 0 }))
  return buildSkillLoad(defaults, totalBudget, toolPath)
}
