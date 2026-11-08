import { newSpanId, newTraceId } from '../lib/trace'
import { UNATTRIBUTED } from './ai-types'

export const CLEF_USAGE_MODEL = '@cf/cloudflare/clef-flash'
export const CLEF_NEURONS_PER_MILLION_INPUT_TOKENS = 3455

const ACCOUNTED_KEY = Symbol.for('myhub.clefUsageAccounted')

const QUESTION_PURPOSE: Record<string, string> = {
  assistant: 'router',
  multiple_actions: 'compound',
  needs_history: 'history',
  tool: 'tool',
  quality: 'quality',
  urgency: 'urgency',
  complexity: 'tier',
}

export type ClefUsagePurpose = string

export interface ClefUsageEntry {
  purpose: ClefUsagePurpose
  request: unknown
  persona?: string
  latencyMs: number
  outcome: string
  raw?: unknown
}

type AccountableFn = ((...args: never[]) => unknown) & { [key: symbol]: unknown }

export function markClefUsageAccounted<T extends (...args: never[]) => unknown>(fn: T): T {
  (fn as unknown as AccountableFn)[ACCOUNTED_KEY] = true
  return fn
}

export function isClefUsageAccounted(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as AccountableFn)[ACCOUNTED_KEY] === true
}

export function inferClefPurpose(request: any): ClefUsagePurpose {
  const q = request?.questions
  if (!q || typeof q !== 'object') return 'classify'
  const keys = Object.keys(q)
  if (keys.includes('assistant')) return 'router'
  if (keys.includes('template_match') || keys.includes('file_structure')) return 'studio-plan'
  if (keys.includes('completeness')) return 'studio-validate'
  if (keys.includes('primary_tool')) return 'tool-plan'
  if (keys.includes('sufficient')) return 'tool-validate'
  if (keys.includes('subagent')) return 'subagent'
  for (const k of keys) if (QUESTION_PURPOSE[k]) return QUESTION_PURPOSE[k]
  return 'classify'
}

export function inferClefPurposeFromSpecIds(specIds: string[]): ClefUsagePurpose {
  if (specIds.includes('assistant')) return 'router'
  for (const id of specIds) if (QUESTION_PURPOSE[id]) return QUESTION_PURPOSE[id]
  return 'classify'
}

export function extractClefPersona(request: any): string | undefined {
  const p = request?.state?.persona
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

export function estimateClefInputTokens(request: unknown): number {
  let text = ''
  try {
    text = JSON.stringify(request) ?? ''
  } catch {
    text = ''
  }
  if (!text) return 0
  const korean = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length
  const rest = text.length - korean
  return Math.max(1, Math.ceil(korean * 1.3 + rest / 4))
}

export function neuronsForInputTokens(inputTokens: number): number {
  return Math.round(inputTokens * CLEF_NEURONS_PER_MILLION_INPUT_TOKENS / 1e6 * 1e3) / 1e3
}

export function resolveClefUsage(request: unknown, raw: any): { inputTokens: number; outputTokens: number | null; neurons: number } {
  const u = raw?.usage
  if (u && typeof u === 'object') {
    const reportedIn = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : typeof u.input_tokens === 'number' ? u.input_tokens : undefined
    const reportedOut = typeof u.completion_tokens === 'number' ? u.completion_tokens : typeof u.output_tokens === 'number' ? u.output_tokens : null
    if (typeof u.neurons === 'number' && Number.isFinite(u.neurons)) {
      return { inputTokens: reportedIn ?? estimateClefInputTokens(request), outputTokens: reportedOut, neurons: u.neurons }
    }
    if (reportedIn !== undefined) {
      return { inputTokens: reportedIn, outputTokens: reportedOut, neurons: neuronsForInputTokens(reportedIn) }
    }
  }
  const est = estimateClefInputTokens(request)
  return { inputTokens: est, outputTokens: null, neurons: neuronsForInputTokens(est) }
}

export async function recordClefUsage(db: D1Database, entry: ClefUsageEntry): Promise<boolean> {
  const { inputTokens, outputTokens, neurons } = resolveClefUsage(entry.request, entry.raw)
  const traceId = newTraceId()
  const spanId = newSpanId()
  const createdAt = new Date().toISOString()
  const capability = `clef:${entry.purpose}`
  const persona = entry.persona ?? UNATTRIBUTED
  const insert = async (sql: string, params: unknown[]) => {
    await db.prepare(sql).bind(...params).run()
  }
  try {
    await insert(
      'INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, neurons, outcome, trace_id, span_id, parent_span_id, prompt_version, created_at, engine, persona, run_id, call_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['workers-ai', CLEF_USAGE_MODEL, capability, Math.max(0, Math.round(entry.latencyMs)), inputTokens, outputTokens, neurons, entry.outcome, traceId, spanId, null, null, createdAt, UNATTRIBUTED, persona, null, null]
    )
    return true
  } catch {
    try {
      await insert(
        'INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, neurons, outcome, trace_id, span_id, parent_span_id, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['workers-ai', CLEF_USAGE_MODEL, capability, Math.max(0, Math.round(entry.latencyMs)), inputTokens, outputTokens, neurons, entry.outcome, traceId, spanId, null, null, createdAt]
      )
      return true
    } catch {
      try {
        await insert(
          'INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, outcome, trace_id, span_id, parent_span_id, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['workers-ai', CLEF_USAGE_MODEL, capability, Math.max(0, Math.round(entry.latencyMs)), inputTokens, outputTokens, entry.outcome, traceId, spanId, null, null, createdAt]
        )
        return true
      } catch (e) {
        console.error(`[clef-usage] ai_usage 기록 실패 (capability=${capability}, outcome=${entry.outcome}):`, e instanceof Error ? e.message : String(e))
        return false
      }
    }
  }
}
