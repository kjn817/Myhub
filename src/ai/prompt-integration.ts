/**
 * Phase 3D: Prompt Composer + TimeContext 통합
 *
 * - ai.prompt_v2 플래그로 새 프롬프트 on/off (기본값 false)
 * - 서버 시간 컨텍스트를 요청당 한 번만 생성
 * - capabilities/allowedTools는 서버 정책에서만 생성
 * - promptVersion을 답변에 연결 (D5)
 */

import { getSetting, PERSONAS } from '../services/ai'
import { composeSystemPrompt, PROMPT_VERSION } from './prompts/composer'
import {
  createServerTimeContext,
  isValidTimezone,
  type ServerTimeContext,
} from './time-context'
import { resolveDateExpression, resolveMultipleDates } from './date-resolver'
import { KST_TIME_ZONE } from '../lib/kst'
import { buildTimeContextSection, type TimeContext as CaliTimeContext } from './prompts/cali'
import { PERSONA_REGISTRY } from './persona-registry'
// 레거시 마커 도구는 privacy-guard에서 재사용 (중복 정의 방지)
export { getLegacyMarkerTools } from './legacy-privacy-guard'

export const LEGACY_PROMPT_VERSION = 'legacy'
export { PROMPT_VERSION }

export type PromptVersion = typeof LEGACY_PROMPT_VERSION | typeof PROMPT_VERSION

// ---------------------------------------------------------------------------
// D1: 기능 플래그
// ---------------------------------------------------------------------------

/**
 * ai.prompt_v2 플래그 확인
 * - 엄격한 문자열 비교 ('true'만 활성화)
 * - 사용자 요청 파라미터로 활성화 불가 (서버 설정만)
 * - 조회 실패 시 비활성화 (fail-closed)
 */
export async function isPromptV2Enabled(db: any): Promise<boolean> {
  try {
    const v = await getSetting(db, 'ai.prompt_v2')
    return v === 'true'
  } catch {
    return false
  }
}

// Phase 3E: 비서별 v1 활성화 확인
// - ai.prompt_v2.<personaId>가 있으면 해당 값 사용 (예: ai.prompt_v2.keeper)
// - 없으면 전역 ai.prompt_v2 값 사용 (하위 호환)
// - 기본값 false (fail-closed)
export async function isPromptV2EnabledForPersona(db: any, personaId: string): Promise<boolean> {
  try {
    // 비서별 설정 우선 확인
    const personaKey = `ai.prompt_v2.${personaId}`
    const personaValue = await getSetting(db, personaKey)
    if (personaValue !== null && personaValue !== undefined) {
      return personaValue === 'true'
    }
    // 비서별 설정 없으면 전역 플래그 사용
    return await isPromptV2Enabled(db)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// D3: 서버 시간 컨텍스트
// ---------------------------------------------------------------------------

/**
 * cali 프롬프트용 TimeContext로 변환
 */
export function toCaliTimeContext(ctx: ServerTimeContext): CaliTimeContext {
  return {
    nowIso: ctx.nowIso,
    timezone: ctx.timezone,
    todayLocal: ctx.todayLocal,
    weekStart: ctx.weekStartLocal,
  }
}

/**
 * 요청 단위 시간 컨텍스트 생성
 *
 * 원칙:
 * 1. 기준 시각은 서버가 생성 (fixedEpochMs가 있으면 재사용 — Fallback용)
 * 2. ai.user_timezone 설정을 검증
 * 3. 설정이 없으면 Asia/Seoul
 * 4. 잘못된 시간대는 경고 로그 + Asia/Seoul (조용히 정상 취급 금지)
 */
export async function createRequestTimeContext(
  db: any,
  fixedEpochMs?: number
): Promise<ServerTimeContext> {
  let tz: string | undefined
  try {
    const configured = await getSetting(db, 'ai.user_timezone')
    if (configured) {
      if (isValidTimezone(configured)) {
        tz = configured
      } else {
        // D3.4: 잘못된 시간대를 조용히 정상값처럼 취급하지 않음 → 경고 로그
        console.warn(`[prompt] invalid user timezone "${configured}", falling back to Asia/Seoul`)
      }
    }
  } catch {
    // 설정 조회 실패 → 기본값
  }
  // 설정이 없거나 잘못됐으면 기본값 KST (설정 경로는 위에서만 결정한다)
  return createServerTimeContext(tz || KST_TIME_ZONE, fixedEpochMs)
}

// ---------------------------------------------------------------------------
// D2: Prompt Composer 연결
// ---------------------------------------------------------------------------
// LEGACY_MARKER_TOOLS와 getLegacyMarkerTools는 legacy-privacy-guard.ts에 정의
// (운영 최소 패치가 prompt-integration 없이 동작하도록 분리)

export function getPersonaCapabilities(personaId: string): string[] {
  return PERSONAS.find((p) => p.id === personaId)?.capabilities || []
}

export interface ComposeRequestOptions {
  /** FC 경로에서 전달하는 실제 허용 도구 (서버 정책) */
  allowedTools?: string[]
  /** 레거시 경로의 마커 도구 목록 (서버 정책) */
  legacyMarkerTools?: string[]
  /** 이미 생성된 시간 컨텍스트 (요청당 한 번만 생성하므로 전달) */
  timeContext?: ServerTimeContext
  /** 서버의 비서별 capabilities (PERSONAS 정의) */
  capabilities?: string[]
  /** Phase 3D-T: 날짜 해석용 마지막 사용자 메시지 (scheduler만 사용) */
  userMessage?: string
}

export interface ComposedPrompt {
  prompt: string
  version: PromptVersion
}

/**
 * 새 프롬프트 합성 (플래그 on일 때만 호출)
 *
 * - capabilities/allowedTools는 서버 정책에서만 가져옴
 * - 메모 본문 등 외부 콘텐츠를 시스템 지시 영역에 합치지 않음
 * - TimeContext 삽입: scheduler는 cali 프롬프트 내부, keeper는 뒤에 섹션으로
 *   (2026-10-30 — keeper FC 일정 등록의 날짜 해석에 필요)
 */
export function composeV2Prompt(
  personaId: string,
  opts: ComposeRequestOptions = {}
): ComposedPrompt {
  if (!PERSONA_REGISTRY[personaId]) {
    throw new Error(`unknown persona: ${personaId}`)
  }

  const tools = opts.allowedTools || opts.legacyMarkerTools || []

  // Phase 3D-T: scheduler·keeper의 상대 날짜를 서버에서 확정
  // - DateResolver가 해석에 성공하면 그 결과를 프롬프트에 포함
  // - LLM이 날짜를 다시 계산하지 않도록 명시
  // - 보안: 사용자 원문은 길이/문자 제한 후 포함 (프롬프트 인젝션 방지)
  // - 모호한 경우: 확정 블록 대신 확인 요청 지시 추가
  // - QF2: 다중 날짜 표현은 각각 해석
  // - keeper 포함 이유 (2026-10-30 라이브 게이트): keeper FC의
  //   schedule_create는 start_at의 상대 날짜 해석을 모델에 맡기는데,
  //   시간 컨텍스트가 scheduler에게만 주입돼 keeper는 "오늘"을 학습
  //   데이터 날짜(2025-08-10경)로 믿고 과거 일정을 등록했다.
  let dateBlock: string | undefined
  if ((personaId === 'scheduler' || personaId === 'keeper') && opts.userMessage && opts.timeContext) {
    const multiResults = resolveMultipleDates(opts.userMessage, opts.timeContext)
    const resolvedDates = multiResults.filter((r) => r.status === 'resolved' && r.dateLocal)
    
    if (resolvedDates.length >= 2) {
      // 다중 날짜: 각각 확정
      const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
      const lines = resolvedDates.map((r) => {
        const d = new Date(r.dateLocal! + 'T00:00:00Z')
        const weekdayKo = weekdays[d.getUTCDay()]
        const safeExpr = r.expression.slice(0, 20).replace(/[^가-힣0-9\s월화수목금토일주다음이번]/g, '').trim()
        return `- "${safeExpr}": ${r.dateLocal} (${weekdayKo})`
      })
      dateBlock =
        `[서버 확정 날짜 - 복수]\n` +
        lines.join('\n') + '\n' +
        `- 기준일: ${opts.timeContext.todayLocal} (${opts.timeContext.timezone})\n` +
        `- 위 확정일을 그대로 사용하세요. 다시 계산하지 마세요.`
    } else if (resolvedDates.length === 1) {
      const resolved = resolvedDates[0]
      const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
      const d = new Date(resolved.dateLocal! + 'T00:00:00Z')
      const weekdayKo = weekdays[d.getUTCDay()]
      const safeExpr = resolved.expression
        .slice(0, 30)
        .replace(/[^가-힣0-9\s월화수목금토일주다음이번지난다가오는]/g, '')
        .trim()
      dateBlock =
        `[서버 확정 날짜]\n` +
        `- 표현: "${safeExpr}"\n` +
        `- 확정일: ${resolved.dateLocal} (${weekdayKo})\n` +
        `- 기준일: ${opts.timeContext.todayLocal} (${opts.timeContext.timezone})\n` +
        `- 위 확정일을 그대로 사용하세요. 다시 계산하지 마세요.`
      // 다중 표현 감지되었으나 일부만 해석된 경우 경고
      if (multiResults.length > 1) {
        const unresolved = multiResults.filter((r) => r.status !== 'resolved')
        if (unresolved.length > 0) {
          dateBlock += `\n- 주의: "${unresolved.map((r) => r.expression).join(', ')}"는 해석하지 못했습니다. 임의로 날짜를 정하지 마세요.`
        }
      }
    } else {
      // 해석된 날짜 없음: 모호함 처리
      const hasAmbiguous = multiResults.some((r) => r.status === 'ambiguous')
      if (hasAmbiguous || multiResults.length > 0) {
        dateBlock =
          `[날짜 확인 필요]\n` +
          `- 사용자 메시지에 명확하지 않은 날짜 표현이 있습니다.\n` +
          `- 임의로 날짜를 확정하지 마세요.\n` +
          `- "어떤 날짜를 말씀하시는지 확인해주세요"와 같이 사용자에게 되물어보세요.`
      }
    }
  }

  const prompt = composeSystemPrompt({
    personaId,
    timeContext:
      personaId === 'scheduler' && opts.timeContext
        ? toCaliTimeContext(opts.timeContext)
        : undefined,
    capabilities: opts.capabilities,
    allowedTools: tools.length > 0 ? tools : undefined,
  })

  // keeper 시간 컨텍스트 (2026-10-30 라이브 게이트): composer는 scheduler
  // (cali)에게만 시간 섹션을 넣으므로, keeper는 같은 공용 빌더
  // (buildTimeContextSection)로 섹션을 뒤에 붙인다 — 조립 로직 중복 금지.
  // schedule_create 도구 설명이 "system context의 현재 날짜"를 전제하는데
  // 그 컨텍스트가 실제로 존재하게 하는 수정이다.
  const keeperTimeSection =
    personaId === 'keeper' && opts.timeContext
      ? buildTimeContextSection(toCaliTimeContext(opts.timeContext))
      : undefined

  // 서버 확정 날짜를 프롬프트 끝에 추가
  const sections = [prompt, keeperTimeSection, dateBlock].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  )
  const finalPrompt = sections.join('\n\n')

  return { prompt: finalPrompt, version: PROMPT_VERSION }
}

// ---------------------------------------------------------------------------
// D5: 프롬프트 버전 기록용 헬퍼
// ---------------------------------------------------------------------------

/**
 * 저장용 프롬프트 버전 결정
 * - v2가 실제로 적용된 답변에만 PROMPT_VERSION
 * - 그 외는 'legacy' (미적용을 persona-v1으로 잘못 기록 금지)
 */
export function resolvePromptVersion(v2Applied: boolean): PromptVersion {
  return v2Applied ? PROMPT_VERSION : LEGACY_PROMPT_VERSION
}
