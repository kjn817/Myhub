import { buildRouteContext } from './orchestrator'
import type { ClefRouterMode } from './clef-mode'
import type { LegacyPersonaId } from './persona-id-adapter'
import type { TeamDeps, TeamPlan } from './agent-team'

const OPTION_ORDER = ['chat', 'summarize', 'code', 'schedule', 'unclear']

export interface TeamClefOutcome {
  consulted: boolean
  applied: boolean
  mode: ClefRouterMode
  choice: string | null
  top: number | null
  margin: number | null
  reason: string | null
  gateReasons: string[]
  source: string | null
}

export interface TeamClefConsultResult {
  outcome: TeamClefOutcome
  primaryOverride: { primary: LegacyPersonaId; confidence: number } | null
}

function notConsulted(mode: ClefRouterMode, reason: string | null = null): TeamClefConsultResult {
  return {
    outcome: {
      consulted: false,
      applied: false,
      mode,
      choice: null,
      top: null,
      margin: null,
      reason,
      gateReasons: [],
      source: null,
    },
    primaryOverride: null,
  }
}

export async function consultClefForTeamPlan(
  deps: TeamDeps,
  plan: TeamPlan,
  userText: string,
  messages: any[],
): Promise<TeamClefConsultResult> {
  const clefMode = deps.clefMode ?? (deps.useClefRouter ? 'active' : 'off')
  if (clefMode === 'off' || !deps.clefInvoker || !userText.trim() || plan.steps.length === 0) {
    return notConsulted(clefMode)
  }
  try {
    const { routeMessage } = await import('./router')
    const { resolveClefRoute, normalizeLegacyPersonaId } = await import('./persona-id-adapter')
    const { evaluateG5Gate, hasMention, buildDecisionLogEntry } = await import('./clef-engine')
    const routeCtx = buildRouteContext(messages, userText, deps.routeContext)
    const routeResult = await routeMessage(deps.clefInvoker as never, userText, routeCtx)
    const outcome = resolveClefRoute(routeResult, { message: userText })
    const planPrimary = plan.steps[0]?.personaId ?? 'concierge'
    const top = routeResult.confidence ?? null
    const margin = routeResult.margin ?? null
    const choice = routeResult.persona ?? null
    const source = routeResult.source ?? null
    let applied = false
    let reason: string
    let gateReasons: string[] = []
    let primaryOverride: TeamClefConsultResult['primaryOverride'] = null
    if (clefMode === 'shadow') {
      reason = `team:shadow:${routeResult.reason ?? outcome.reason}`
    } else if (outcome.kind === 'reply') {
      reason = `team:clef_reply:${outcome.reason}`
    } else {
      const isClefJudgment = !(source === 'explicit' || source === 'rule' || source === 'fallback')
      const gate = isClefJudgment ? evaluateG5Gate({
        top: routeResult.confidence,
        margin: routeResult.margin,
        multiple: routeResult.multiple,
        message: userText,
        hasMention: hasMention(userText),
        lockedPersona: (routeCtx.lockedPersona as string | undefined) ?? null,
      }) : { apply: true, reasons: [] as string[] }
      gateReasons = gate.reasons
      if (!gate.apply) {
        reason = `team:g5:${gate.reasons.join(',')}`
      } else {
        const clefLegacy = normalizeLegacyPersonaId(outcome.primary)
        if (clefLegacy && plan.steps.some((s) => s.personaId === clefLegacy)) {
          applied = true
          primaryOverride = {
            primary: clefLegacy,
            confidence: routeResult.confidence ?? 0,
          }
          reason = isClefJudgment ? `team:clef_applied:${outcome.reason}` : `team:exempt-${source}:${outcome.reason}`
        } else {
          reason = `team:clef_outside_plan:${outcome.reason}`
        }
      }
    }
    if (deps.recordDecision) {
      await deps.recordDecision(
        buildDecisionLogEntry({
          traceId: routeResult.traceId ?? `team-${Date.now()}`,
          kind: 'team_routing',
          specHash: routeResult.specHash ?? 'unknown',
          optionOrder: OPTION_ORDER,
          message: userText,
          choice,
          probabilitiesJson: routeResult.probabilities ? JSON.stringify(routeResult.probabilities) : null,
          top,
          margin,
          applied,
          servedPersona: applied && primaryOverride ? primaryOverride.primary : planPrimary,
          mode: clefMode,
          reason,
        })
      ).catch(() => {})
    }
    const g6Mode = deps.g6Mode ?? 'off'
    if (g6Mode !== 'off' && deps.recordDecision) {
      const { recordG6DecisionLog } = await import('./clef-g6')
      await recordG6DecisionLog({
        recordDecision: deps.recordDecision,
        mode: g6Mode,
        baselinePersona: applied && primaryOverride ? primaryOverride.primary : planPrimary,
        clefPersona: outcome.kind === 'dispatch' ? normalizeLegacyPersonaId(outcome.primary) : null,
        traceId: routeResult.traceId ?? `g6-team-${Date.now()}`,
        specHash: routeResult.specHash ?? 'unknown',
        optionOrder: OPTION_ORDER,
        message: userText,
        choice,
        top,
        margin,
        multiple: routeResult.multiple,
        hasMention: hasMention(userText),
        lockedPersona: typeof routeCtx.lockedPersona === 'string' ? routeCtx.lockedPersona : null,
        ledgerTraceId: routeResult.traceId ?? null,
      })
    }
    return {
      outcome: {
        consulted: true,
        applied,
        mode: clefMode,
        choice,
        top,
        margin,
        reason,
        gateReasons,
        source,
      },
      primaryOverride,
    }
  } catch (e: any) {
    return notConsulted(clefMode, `clef_error:${e?.message ?? 'unknown'}`)
  }
}
