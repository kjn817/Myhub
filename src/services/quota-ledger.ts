export const WORKERS_AI_DAILY_NEURON_LIMIT = 10000

export interface QuotaUsageRow {
  provider?: string | null
  model?: string | null
  neurons?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  created_at?: string | null
}

export interface QuotaWindow {
  startUtc: string
  resetAtUtc: string
}

export interface QuotaWallet {
  provider: string
  model: string | null
  unit: 'neurons' | 'tokens'
  calls: number
  used: number
  limit: number | null
  remaining: number | null
  resetAt: string | null
  note: string
}

export interface QuotaLedger {
  window: QuotaWindow
  wallets: QuotaWallet[]
  notes: string[]
}

export function quotaWindowFor(now: Date): QuotaWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const reset = new Date(start.getTime() + 24 * 3600 * 1000)
  return { startUtc: start.toISOString(), resetAtUtc: reset.toISOString() }
}

export function isInWindow(createdAt: string | null | undefined, windowStartDate: string): boolean {
  return typeof createdAt === 'string' && createdAt.slice(0, 10) === windowStartDate
}

export function buildQuotaLedger(rows: QuotaUsageRow[], now: Date = new Date()): QuotaLedger {
  const window = quotaWindowFor(now)
  const windowDate = window.startUtc.slice(0, 10)
  const today = rows.filter((r) => isInWindow(r.created_at, windowDate))
  const wallets: QuotaWallet[] = []
  const waRows = today.filter((r) => (r.provider ?? '') === 'workers-ai')
  const waNeurons = waRows.reduce((sum, r) => sum + (typeof r.neurons === 'number' && Number.isFinite(r.neurons) ? r.neurons : 0), 0)
  wallets.push({
    provider: 'workers-ai',
    model: null,
    unit: 'neurons',
    calls: waRows.length,
    used: Math.round(waNeurons * 1000) / 1000,
    limit: WORKERS_AI_DAILY_NEURON_LIMIT,
    remaining: Math.max(0, Math.round((WORKERS_AI_DAILY_NEURON_LIMIT - waNeurons) * 1000) / 1000),
    resetAt: window.resetAtUtc,
    note: '계정 공유 지갑 — 전 모델(qwen·mistral·clef-flash 등) 합산. 00:00 UTC(09:00 KST) 리셋.',
  })
  const byModel = new Map<string, { provider: string; model: string; calls: number; tokens: number }>()
  for (const r of today) {
    const provider = (r.provider ?? '').trim() || 'unknown'
    if (provider === 'workers-ai') continue
    const model = (r.model ?? '').trim() || 'unknown'
    const key = `${provider}\0${model}`
    const entry = byModel.get(key) ?? { provider, model, calls: 0, tokens: 0 }
    entry.calls += 1
    entry.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0)
    byModel.set(key, entry)
  }
  for (const e of [...byModel.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))) {
    wallets.push({
      provider: e.provider,
      model: e.model,
      unit: 'tokens',
      calls: e.calls,
      used: e.tokens,
      limit: null,
      remaining: null,
      resetAt: null,
      note: '일일 한도 미확인(공식 공개 표 없음) — 잔량을 추정으로 만들지 않는다.',
    })
  }
  return {
    window,
    wallets,
    notes: [
      'Workers AI 뉴런은 ai_usage 기록분 합산이다. 음성 STT/TTS 뉴런은 KV 건수 카운터로 별도 계측돼 이 원장에 없으므로, workers-ai 사용량은 실제 소비의 하한이다.',
      'Gemini·Groq·NVIDIA의 일일 한도는 코드·공식 표로 확정할 수 없어 limit/remaining을 null로 둔다 (axis-g §3.4 미확인 판정 유지).',
    ],
  }
}
