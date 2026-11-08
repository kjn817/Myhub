import { getSetting } from './ai-model-selection'
import { buildDecisionLogEntry, CLEF_THRESHOLDS, type ClefDecisionLogEntry } from './clef-engine'
import { detectWriteIntent } from './write-intent'

export const CLEF_G6_MODE_KEY = 'clef.g6_mode'
export const G6_GATE_VERSION = 'g6-gate-v1-20261106'

export const G6_GATE = {
  /** 평가셋 최소 규모 */
  minTotal: 120,
  minWrite: 60,
  minCompound: 25,
  minRead: 40,
  /** 안전 구간(G5와 같은 확률 문턱) 최소 포괄 표본 */
  minSafeBandN: 30,
  minSafeBandCompoundN: 10,
  /** 안전 구간 지표 하한·상한 */
  minRoutingAccuracy: 0.95,
  minWritePrecision: 0.95,
  minWriteRecall: 0.9,
  minCompoundRecall: 0.8,
  maxReadFalseWriteRate: 0.02,
  /** 하드 게이트 — 비율이 아니라 건수 0 */
  maxDestructiveBypass: 0,
  maxShadowDivergence: 0,
  /** 섀도 단계 최소 표본과 원장 연결률 하한 */
  minShadowSamples: 50,
  minLedgerLinkedRate: 0.99,
}

export const G6_SAFE_BAND = {
  top: CLEF_THRESHOLDS.g5Top,
  margin: CLEF_THRESHOLDS.g5Margin,
  compoundNoul: CLEF_THRESHOLDS.compoundNoul,
}

const DESTRUCTIVE_VERBS = /(삭제|취소|지워|지우|제거|회수|전부\s*지)/

export type ClefG6Mode = 'off' | 'shadow' | 'active'
export type G6Risk = 'read' | 'write' | 'destructive'

export async function getClefG6Mode(db: D1Database): Promise<ClefG6Mode> {
  const v = await getSetting(db, CLEF_G6_MODE_KEY)
  return v === 'shadow' || v === 'active' ? v : 'off'
}

export function parseClefG6Mode(raw: unknown): ClefG6Mode {
  return raw === 'shadow' || raw === 'active' ? raw : 'off'
}

export function deriveG6Risk(message: string): G6Risk {
  if (!detectWriteIntent(message)) return 'read'
  return DESTRUCTIVE_VERBS.test(message) ? 'destructive' : 'write'
}

export function g6ApprovalRequired(risk: G6Risk): boolean {
  return risk === 'write' || risk === 'destructive'
}

export interface G6JudgmentInput {
  top?: number
  margin?: number
  multiple?: number
  choice?: string | null
  message: string
  hasMention: boolean
  lockedPersona?: string | null
  risk?: G6Risk
}

export interface G6Judgment {
  eligible: boolean
  reasons: string[]
  isWrite: boolean
  isCompound: boolean
  risk: G6Risk
  inSafeBand: boolean
}

export function evaluateG6Judgment(input: G6JudgmentInput): G6Judgment {
  const reasons: string[] = []
  const isWrite = detectWriteIntent(input.message)
  const isCompound = input.multiple !== undefined && input.multiple >= G6_SAFE_BAND.compoundNoul
  const risk = input.risk ?? deriveG6Risk(input.message)
  const inSafeBand = input.top !== undefined && input.top >= G6_SAFE_BAND.top && input.margin !== undefined && input.margin >= G6_SAFE_BAND.margin
  if (input.top === undefined || input.top < G6_SAFE_BAND.top) reasons.push('top_below_safe')
  if (input.margin === undefined || input.margin < G6_SAFE_BAND.margin) reasons.push('margin_below_safe')
  if (!input.choice || input.choice === 'unclear') reasons.push('choice_unclear')
  if (input.hasMention) reasons.push('mention')
  if (input.lockedPersona) reasons.push('locked_persona')
  if (!isWrite && !isCompound) reasons.push('not_g6_scope')
  if (risk === 'destructive') reasons.push('destructive_requires_approval')
  return { eligible: reasons.length === 0, reasons, isWrite, isCompound, risk, inSafeBand }
}

export interface G6ServingDecision {
  servedPersona: string
  applied: boolean
  judgment: G6Judgment | null
  reason: string
}

export function resolveG6Serving(args: {
  mode: ClefG6Mode
  baselinePersona: string
  clefPersona: string | null
  gatePassed: boolean
  input: G6JudgmentInput
}): G6ServingDecision {
  if (args.mode === 'off') {
    return { servedPersona: args.baselinePersona, applied: false, judgment: null, reason: 'g6_off' }
  }
  const judgment = evaluateG6Judgment(args.input)
  if (args.mode === 'shadow') {
    return {
      servedPersona: args.baselinePersona,
      applied: false,
      judgment,
      reason: `g6_shadow:${judgment.eligible ? 'would_apply' : judgment.reasons.join(',')}`,
    }
  }
  if (!args.gatePassed) {
    return {
      servedPersona: args.baselinePersona,
      applied: false,
      judgment,
      reason: 'g6_active_gate_not_passed',
    }
  }
  if (!judgment.eligible || !args.clefPersona) {
    return {
      servedPersona: args.baselinePersona,
      applied: false,
      judgment,
      reason: `g6:${judgment.reasons.join(',') || 'no_clef_persona'}`,
    }
  }
  return { servedPersona: args.clefPersona, applied: true, judgment, reason: 'g6_applied' }
}

export function buildG6DecisionLogEntry(p: {
  traceId: string
  specHash: string
  optionOrder: string[]
  message: string
  choice: string | null
  top: number | null
  margin: number | null
  judgment: G6Judgment
  decision: G6ServingDecision
  mode: ClefG6Mode
  ledgerTraceId?: string | null
}): ClefDecisionLogEntry {
  const modeLabel = p.mode === 'shadow' ? 'g6_shadow' : 'g6_active'
  const ledger = p.ledgerTraceId ? `ledger:${p.ledgerTraceId};` : 'ledger:none;'
  const reason = `${ledger}${p.decision.reason};risk=${p.judgment.risk};write=${p.judgment.isWrite ? 1 : 0};compound=${p.judgment.isCompound ? 1 : 0}`
  return buildDecisionLogEntry({
    traceId: p.traceId,
    kind: 'g6_routing',
    specHash: p.specHash,
    optionOrder: p.optionOrder,
    message: p.message,
    choice: p.choice,
    probabilitiesJson: null,
    top: p.top,
    margin: p.margin,
    applied: p.decision.applied,
    servedPersona: p.decision.servedPersona,
    mode: modeLabel,
    reason,
  })
}

export async function recordG6DecisionLog(p: {
  mode: ClefG6Mode
  recordDecision?: (entry: ClefDecisionLogEntry) => Promise<unknown>
  baselinePersona: string
  clefPersona: string | null
  traceId: string
  specHash: string
  optionOrder: string[]
  message: string
  choice: string | null
  top: number | null
  margin: number | null
  multiple?: number
  hasMention: boolean
  lockedPersona?: string | null
  ledgerTraceId?: string | null
}): Promise<G6ServingDecision | null> {
  if (p.mode === 'off' || !p.recordDecision) return null
  const decision = resolveG6Serving({
    mode: p.mode,
    baselinePersona: p.baselinePersona,
    clefPersona: p.clefPersona,
    gatePassed: false,
    input: {
      top: p.top ?? undefined,
      margin: p.margin ?? undefined,
      multiple: p.multiple,
      choice: p.choice,
      message: p.message,
      hasMention: p.hasMention,
      lockedPersona: p.lockedPersona ?? null,
    },
  })
  if (!decision.judgment) return decision
  await p.recordDecision(
    buildG6DecisionLogEntry({
      traceId: p.traceId,
      specHash: p.specHash,
      optionOrder: p.optionOrder,
      message: p.message,
      choice: p.choice,
      top: p.top,
      margin: p.margin,
      judgment: decision.judgment,
      decision,
      mode: p.mode,
      ledgerTraceId: p.ledgerTraceId ?? null,
    })
  ).catch(() => {})
  return decision
}

export function extractLedgerTraceId(reason: string | null | undefined): string | null {
  if (!reason) return null
  const m = reason.match(/ledger:([^;]+)/)
  if (!m || m[1] === 'none') return null
  return m[1]
}

function ge(v: number | null, min: number): boolean {
  return v !== null && v >= min
}

function le(v: number | null, max: number): boolean {
  return v !== null && v <= max
}

export interface G6ActivationMetrics {
  total: number
  writeN: number
  compoundN: number
  readN: number
  safeBandN: number
  safeBandCompoundN: number
  safeBandRoutingAccuracy: number | null
  writePrecision: number | null
  writeRecall: number | null
  compoundRecall: number | null
  readFalseWriteRate: number | null
  destructiveBypassCount: number
  shadowDivergenceCount: number
  shadowSamples: number
  ledgerLinkedRate: number | null
}

export function judgeG6Activation(metrics: G6ActivationMetrics) {
  const checks = {
    total_sample: metrics.total >= G6_GATE.minTotal,
    write_sample: metrics.writeN >= G6_GATE.minWrite,
    compound_sample: metrics.compoundN >= G6_GATE.minCompound,
    read_sample: metrics.readN >= G6_GATE.minRead,
    safe_band_sample: metrics.safeBandN >= G6_GATE.minSafeBandN,
    safe_band_compound_sample: metrics.safeBandCompoundN >= G6_GATE.minSafeBandCompoundN,
    routing_accuracy: ge(metrics.safeBandRoutingAccuracy, G6_GATE.minRoutingAccuracy),
    write_precision: ge(metrics.writePrecision, G6_GATE.minWritePrecision),
    write_recall: ge(metrics.writeRecall, G6_GATE.minWriteRecall),
    compound_recall: ge(metrics.compoundRecall, G6_GATE.minCompoundRecall),
    read_false_write_rate: le(metrics.readFalseWriteRate, G6_GATE.maxReadFalseWriteRate),
    destructive_bypass_zero: metrics.destructiveBypassCount <= G6_GATE.maxDestructiveBypass,
    shadow_divergence_zero: metrics.shadowDivergenceCount <= G6_GATE.maxShadowDivergence,
    shadow_samples: metrics.shadowSamples >= G6_GATE.minShadowSamples,
    ledger_linked_rate: ge(metrics.ledgerLinkedRate, G6_GATE.minLedgerLinkedRate),
  }
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k)
  return { pass: failures.length === 0, gateVersion: G6_GATE_VERSION, checks, failures, metrics }
}
