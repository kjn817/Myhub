/**
 * FC 도구 공통 실행 정책 — 트랙 3 통합 (2026-10-31, D4·D5 해소)
 *
 * 배경: docs/gate-policy-equivalence-20261030.md 불일치 D4·D5.
 * - D4: 비대화형 origin 쓰기 deny의 유일한 강제 지점이 ai.ts FC 루프의
 *   인라인 하드코딩 목록(7종)이었다. 디스패처를 직접 부르는 호출자는
 *   출처 게이트를 통째로 우회할 수 있었고, 신규 FC 쓰기 도구가 생기면
 *   목록 갱신 누락이 곧 무방비였다.
 * - D5: E2 디스패처에는 비서 개념 자체가 없어, 비서별 허용 목록은
 *   모델에게 도구를 "보여주지 않는" 제공(offering)으로만 서 있었다.
 *
 * 이 모듈이 FC 경로의 판정 단일 원천이다:
 * - 도구 위험 분류: 승인 도구명 매핑(FC_TO_APPROVAL_TOOL) + E1 위험
 *   분류표(classifyToolRisk) 재사용. 목록에 없는 신규 도구는
 *   'unknown'으로 deny-by-default가 된다 (이름 하드코딩 목록 폐지).
 * - 비서별 허용 집합: 스킬 레지스트리(SKILLS)의 personas×tools가
 *   단일 원천이다 — ai.ts 루프가 모델에게 제공하는 도구 집합과
 *   디스패처가 강제하는 집합이 같은 정의에서 나온다.
 * - 출처 게이트: 쓰기·파괴적 도구는 origin==='interactive'일 때만
 *   허용한다 (E1 decideToolExecution·E3 WriteExecutionGuard와 동일
 *   규칙, 미지정 포함 fail-closed).
 *
 * 강제 지점은 디스패처(memo-tool-dispatcher.ts)이며, ai.ts FC 루프는
 * 같은 판정 함수를 디스패치 전에 미리 적용해 거부 결과를 모델에게
 * 즉시 피드백한다 (판정 로직은 여기 한 곳뿐이다).
 *
 * 이 통합은 엔진 단일화(P2)의 전제 작업이다: E1(마커)은
 * decideToolExecution, E2(FC)는 이 모듈+디스패처로 판정이 모였으므로,
 * 단일화 때는 앞단 파서만 교체하면 정책은 그대로 유지된다.
 */

import { classifyToolRisk, type ToolRisk } from './tool-approval'
import { SKILLS } from './skill-registry'
import {
  normalizeLegacyPersonaId,
  type LegacyPersonaId,
} from './persona-id-adapter'
import type { ExecutionOrigin } from '../ai/types'

// ---------------------------------------------------------------------------
// 도구 이름 공간 — FC 도구명 ↔ 승인 도구명 (E1 분류표의 기준 이름)
// ---------------------------------------------------------------------------

/**
 * FC 도구명 → 승인 도구명. 이 표에 있는 도구만 쓰기·파괴적(승인 게이트
 * 대상)이다.
 * - memo_create_from_source는 E1에 대응 마커가 없어 MEMO_CREATE로 묶는다
 *   (같은 "메모 생성" 종류 — 세션 허용도 함께 적용된다).
 * - cron_set_enabled는 E1의 CRON_TOGGLE과 같은 동작이라 그 이름을 쓴다.
 * (2026-10-31 D1 정렬에서 fc-approval-gate.ts에 신설된 표를, 트랙 3에서
 *  공통 계층인 이 모듈로 승격했다. fc-approval-gate는 재노출한다.)
 */
export const FC_TO_APPROVAL_TOOL: Readonly<Record<string, string>> = {
  memo_create: 'MEMO_CREATE',
  memo_create_from_source: 'MEMO_CREATE',
  memo_update: 'MEMO_UPDATE',
  memo_delete: 'MEMO_DELETE',
  schedule_create: 'SCHEDULE_CREATE',
  cron_create: 'CRON_CREATE',
  cron_set_enabled: 'CRON_TOGGLE',
  cron_delete: 'CRON_DELETE',
}

/** 승인 게이트 대상 FC 쓰기 도구 목록 (FC_TO_APPROVAL_TOOL의 키) */
export const FC_APPROVAL_GATED_TOOLS: ReadonlyArray<string> = Object.keys(FC_TO_APPROVAL_TOOL)

/** FC 도구명 → 승인 도구명. 게이트 대상이 아니면 null (읽기·UI 도구). */
export function fcApprovalToolFor(fcToolName: unknown): string | null {
  if (typeof fcToolName !== 'string') return null
  return FC_TO_APPROVAL_TOOL[fcToolName] ?? null
}

/** 이 FC 호출이 승인 게이트 대상(쓰기·파괴적)인가 */
export function isFCApprovalGated(fcToolName: unknown): boolean {
  return fcApprovalToolFor(fcToolName) !== null
}

/**
 * FC 읽기 도구 (출처 무관 허용, 승인 불필요).
 * - memo_ui_action은 DB를 쓰지 않고 UI 요청(ui_pending)만 반환하는
 *   도구라 읽기 등급으로 분류한다 — 통합 전 인라인 게이트 목록에도
 *   없던(게이트되지 않던) 기존 동작과 같다.
 */
export const FC_READ_TOOLS: ReadonlyArray<string> = [
  'memo_search',
  'memo_get',
  'memo_ui_action',
  'cron_list',
]

/** 디스패처가 실행할 수 있는 FC 도구 전체 (읽기 + 쓰기·파괴적) */
export const FC_TOOL_NAMES: ReadonlyArray<string> = [
  ...FC_READ_TOOLS,
  ...FC_APPROVAL_GATED_TOOLS,
]

/**
 * FC 도구의 위험 등급 — E1 분류표를 공유한다.
 * 승인 도구명으로 매핑되는 도구는 그 분류를, 읽기 목록은 'read'를,
 * 어느 쪽에도 없는 이름은 'unknown'(deny-by-default)을 돌려준다.
 * 신규 FC 도구는 FC_TO_APPROVAL_TOOL 또는 FC_READ_TOOLS 중 한 곳에
 * 등록해야만 실행 가능해진다 — 등록 누락은 조용한 허용이 아니라 거부다.
 */
export function classifyFCToolRisk(fcToolName: unknown): ToolRisk {
  const approvalTool = fcApprovalToolFor(fcToolName)
  if (approvalTool) return classifyToolRisk(approvalTool)
  if (typeof fcToolName === 'string' && FC_READ_TOOLS.includes(fcToolName)) return 'read'
  return 'unknown'
}

/** 쓰기·파괴적 FC 도구인가 (출처 게이트·승인 게이트의 대상 판정) */
export function isFCWriteTool(fcToolName: unknown): boolean {
  const risk = classifyFCToolRisk(fcToolName)
  return risk === 'write' || risk === 'destructive'
}

// ---------------------------------------------------------------------------
// 비서별 허용 집합 (D5) — 스킬 레지스트리가 단일 원천
// ---------------------------------------------------------------------------

/**
 * 비서가 FC로 실행할 수 있는 도구 집합.
 * SKILLS에서 해당 비서를 personas에 포함한 스킬들의 FC 도구 합집합이다
 * (personas가 빈 스킬은 전 비서 허용이나 FC 도구가 없어 영향 없음).
 * ai.ts 루프가 턴마다 모델에게 "제공"하는 도구도 같은 SKILLS에서
 * 나오므로, 제공 집합 ⊇ 강제 집합 관계가 정의상 성립한다.
 * 알 수 없는 비서 ID면 null (deny-by-default).
 */
export function getPersonaFCTools(personaId: unknown): string[] | null {
  const legacy: LegacyPersonaId | null = normalizeLegacyPersonaId(personaId)
  if (!legacy) return null
  const tools = new Set<string>()
  for (const skill of SKILLS) {
    if (skill.personas.length > 0 && !skill.personas.includes(legacy)) continue
    for (const tool of skill.tools) tools.add(tool.name)
  }
  return [...tools]
}

// ---------------------------------------------------------------------------
// 공통 디스패치 판정 (D4 출처 게이트 + D5 비서 강제)
// ---------------------------------------------------------------------------

export type FCDispatchDenyReason =
  | 'unknown_persona'
  | 'tool_not_allowed'
  | 'tool_unclassified'
  | 'non_interactive_origin'

export type FCDispatchPolicyResult =
  | { allowed: true; personaId: LegacyPersonaId; risk: ToolRisk }
  | { allowed: false; reason: FCDispatchDenyReason }

export interface FCDispatchPolicyInput {
  /** FC 도구명 (소문자) */
  toolName: unknown
  /**
   * 실행 비서 (레거시·신규 ID 모두 허용, 정규화해서 판정).
   * 미지정 시 'keeper'로 간주한다 — FC 디스패처는 keeper 전용으로
   * 도입됐고(useFC 게이트), 운영 호출자(ai.ts 루프·승인 실행)는
   * 전원 비서를 명시한다. 미지정 기본값은 그 이전부터 디스패처를
   * 직접 호출해 온 내부 호출자(단위 테스트 포함)와의 호환용이며,
   * 새 호출자는 반드시 명시해야 한다.
   */
  personaId?: unknown
  /**
   * 실행 출처 (Talorys ③-A). 쓰기·파괴적 도구는 'interactive'만
   * 허용하고 미지정은 fail-closed로 deny한다 (E1·E3와 동일 규칙).
   * 읽기는 출처와 무관하게 허용한다 (MCP 읽기 전용 등 기존 동작 유지).
   */
  origin?: ExecutionOrigin
}

/**
 * 디스패치 직전 공통 판정. 순서 (E1 decideToolExecution과 같은 배열):
 * 비서 유효성 → 비서별 허용 목록 → 위험 분류 → 출처 게이트.
 * 잠금/해제 도구 차단은 이 판정보다 앞단에서 policy-guard가 담당한다.
 */
export function checkFCDispatchPolicy(input: FCDispatchPolicyInput): FCDispatchPolicyResult {
  const toolName = typeof input.toolName === 'string' ? input.toolName : ''
  const personaId = normalizeLegacyPersonaId(input.personaId ?? 'keeper')
  if (!personaId) return { allowed: false, reason: 'unknown_persona' }

  const allowedTools = getPersonaFCTools(personaId)
  if (!allowedTools) return { allowed: false, reason: 'unknown_persona' }
  if (!toolName || !allowedTools.includes(toolName)) {
    return { allowed: false, reason: 'tool_not_allowed' }
  }

  const risk = classifyFCToolRisk(toolName)
  if (risk === 'unknown') return { allowed: false, reason: 'tool_unclassified' }

  if ((risk === 'write' || risk === 'destructive') && input.origin !== 'interactive') {
    return { allowed: false, reason: 'non_interactive_origin' }
  }

  return { allowed: true, personaId, risk }
}
