export function generateClaimToken(): string {
  const rand = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `${Date.now().toString(36)}-${rand()}${rand()}-${rand()}${rand()}`
}

export interface HandoffInput {
  fromPersona: string
  toPersona: string
  memoryIds: number[]
  summary?: string
  /** 유효 시간(분). 기본 60, 최대 1440. */
  ttlMinutes?: number
}

/** 인계 생성 — 토큰을 아는 비서만 1회 수령할 수 있다. */
export async function createHandoff(
  env: any,
  input: HandoffInput
): Promise<{ ok: boolean; id?: number; claimToken?: string; error?: string }> {
  const from = (input.fromPersona || '').trim()
  const to = (input.toPersona || '').trim()
  if (!from || !to) return { ok: false, error: 'persona 필요' }
  const ids = [...new Set((input.memoryIds || []).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20)
  if (!ids.length) return { ok: false, error: 'memory_ids 필요' }
  const ttl = Math.min(Math.max(input.ttlMinutes ?? 60, 1), 24 * 60)
  try {
    const now = new Date()
    const expires = new Date(now.getTime() + ttl * 60000).toISOString()
    const token = generateClaimToken()
    const payload = JSON.stringify({ memory_ids: ids, summary: (input.summary || '').slice(0, 1000) })
    const result = await env.DB.prepare(
      `INSERT INTO memory_handoffs (claim_token, from_persona, to_persona, payload, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(token, from, to, payload, now.toISOString(), expires).run()
    return { ok: true, id: result.meta.last_row_id, claimToken: token }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

/**
 * 인계 수령 — 원자적 claim: status='pending' + 미 만료인 행만 claimed로 바꾼다.
 * 이미 수령됐거나 만료됐으면 changes=0이라 실패한다 (두 번째 수령 불가).
 */
export async function claimHandoff(
  env: any,
  token: string
): Promise<{
  ok: boolean
  payload?: { memory_ids: number[]; summary: string }
  fromPersona?: string
  toPersona?: string
  error?: string
}> {
  const t = (token || '').trim()
  if (!t) return { ok: false, error: 'token 필요' }
  try {
    const now = new Date().toISOString()
    const claimed = await env.DB.prepare(
      `UPDATE memory_handoffs SET status = 'claimed', claimed_at = ? WHERE claim_token = ? AND status = 'pending' AND expires_at > ?`
    ).bind(now, t, now).run()
    if (!claimed.meta || claimed.meta.changes !== 1) {
      return { ok: false, error: 'already_claimed_or_expired' }
    }
    const row = await env.DB.prepare(
      'SELECT from_persona, to_persona, payload FROM memory_handoffs WHERE claim_token = ?'
    ).bind(t).first() as any
    if (!row) return { ok: false, error: 'not_found' }
    let payload: any = {}
    try {
      payload = JSON.parse(row.payload || '{}')
    } catch {
      payload = {}
    }
    return {
      ok: true,
      payload: {
        memory_ids: Array.isArray(payload.memory_ids) ? payload.memory_ids : [],
        summary: typeof payload.summary === 'string' ? payload.summary : '',
      },
      fromPersona: row.from_persona,
      toPersona: row.to_persona,
    }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}
