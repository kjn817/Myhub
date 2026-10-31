/**
 * agent-framework 패턴 — 형식 있는 코디네이터 핸드오프 기록 (트랙 7)
 *
 * 0044 memory_handoffs(claim-once, 기억 페이로드 인계)와 역할이 다르다.
 * agent_handoffs는 코디네이터가 비서 간 인계 시 남기는 감사 추적용 기록으로,
 * 요청·맥락·제약·기대 출력을 형식 있게 담는다. 수령 토큰이 없고 상태 전이
 * (pending → accepted/completed/rejected)로 해결한다. 필요 시
 * memory_handoff_id로 claim-once 인계와 연결만 한다 (소유권 로직은
 * memory-service에 그대로 둔다).
 */

export type HandoffStatus = 'pending' | 'accepted' | 'completed' | 'rejected'

export interface StructuredHandoffInput {
  /** 체크포인트 실행과 연결할 때만 지정 (없으면 독립 핸드오프) */
  runId?: string
  fromPersona: string
  toPersona: string
  /** 인계 요청 (원문, 최대 2000자) */
  request: string
  /** 인계 맥락 — 최소 정보만 (최대 10개, 각 500자) */
  context: string[]
  /** 제약 조건 (최대 10개, 각 200자) */
  constraints: string[]
  /** 기대 출력 (최대 1000자) */
  expectedOutput: string
  /** claim-once 기억 인계와 연결할 때만 지정 (memory_handoffs.id) */
  memoryHandoffId?: number
}

export interface StructuredHandoff extends StructuredHandoffInput {
  id: number
  status: HandoffStatus
  createdAt: string
  resolvedAt: string | null
}

function cleanLines(items: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(items)) return null
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') return null
    const t = item.trim()
    if (!t || t.length > maxLen) return null
    out.push(t)
    if (out.length > maxItems) return null
  }
  return out
}

// ---------------------------------------------------------------------------
// 형식 있는 코디네이터 핸드오프 기록 (agent_handoffs)
// ---------------------------------------------------------------------------

/** 주 담당 비서의 답변을 받아 협업자에게 넘길 형식 있는 핸드오프를 만든다 (순수 함수). */
export function buildCoordinatorHandoff(
  fromPersona: string,
  toPersona: string,
  request: string,
  primaryAnswer: string,
  constraints: string[] = []
): StructuredHandoffInput {
  return {
    fromPersona,
    toPersona,
    request: request.slice(0, 2000),
    context: [`[${fromPersona}의 답변]\n${(primaryAnswer || '').slice(0, 500)}`],
    constraints: constraints.slice(0, 10).map((c) => c.slice(0, 200)),
    expectedOutput: '주 담당 답변을 보완하는 추가 답변 (같은 내용 반복 금지)',
  }
}

export async function createStructuredHandoff(
  env: any,
  input: StructuredHandoffInput
): Promise<{ ok: boolean; id?: number; error?: string }> {
  const from = (input.fromPersona || '').trim()
  const to = (input.toPersona || '').trim()
  if (!from || !to) return { ok: false, error: 'persona 필요' }
  if (from === to) return { ok: false, error: 'from/to가 같음' }
  const request = (input.request || '').trim()
  if (!request) return { ok: false, error: 'request 필요' }
  if (request.length > 2000) return { ok: false, error: 'request 과다 (2000자 초과)' }
  const context = cleanLines(input.context, 10, 500)
  if (context === null) return { ok: false, error: 'context 형식 오류 (최대 10개·각 500자)' }
  const constraints = cleanLines(input.constraints, 10, 200)
  if (constraints === null) return { ok: false, error: 'constraints 형식 오류 (최대 10개·각 200자)' }
  const expectedOutput = (input.expectedOutput || '').trim().slice(0, 1000)
  try {
    // 연결 대상이 있으면 존재부터 확인한다 (없는 run/인계에 기록을 남기지 않음).
    if (input.runId) {
      const run = await env.DB.prepare(`SELECT id FROM agent_runs WHERE id = ?`).bind(input.runId).first()
      if (!run) return { ok: false, error: 'run_not_found' }
    }
    if (input.memoryHandoffId !== undefined) {
      if (!Number.isInteger(input.memoryHandoffId) || input.memoryHandoffId <= 0) {
        return { ok: false, error: 'memory_handoff_id 오류' }
      }
      const mh = await env.DB.prepare(`SELECT id FROM memory_handoffs WHERE id = ?`).bind(input.memoryHandoffId).first()
      if (!mh) return { ok: false, error: 'memory_handoff_not_found' }
    }
    const now = new Date().toISOString()
    const result = await env.DB.prepare(
      `INSERT INTO agent_handoffs (run_id, memory_handoff_id, from_persona, to_persona, request, context_json, constraints_json, expected_output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(
      input.runId ?? null,
      input.memoryHandoffId ?? null,
      from,
      to,
      request,
      JSON.stringify(context),
      JSON.stringify(constraints),
      expectedOutput,
      now
    ).run()
    return { ok: true, id: result.meta.last_row_id }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

/**
 * 핸드오프 해결 — pending인 행만 전이한다 (원자적 가드: 이미 해결된
 * 핸드오프를 다시 바꾸지 않는다).
 */
export async function resolveStructuredHandoff(
  env: any,
  id: number,
  status: Exclude<HandoffStatus, 'pending'>
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id 필요' }
  if (status !== 'accepted' && status !== 'completed' && status !== 'rejected') {
    return { ok: false, error: 'status 값 오류' }
  }
  try {
    const now = new Date().toISOString()
    const changed = await env.DB.prepare(
      `UPDATE agent_handoffs SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`
    ).bind(status, now, id).run()
    if (!changed.meta || changed.meta.changes !== 1) {
      return { ok: false, error: 'not_pending_or_not_found' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

export async function getStructuredHandoff(
  env: any,
  id: number
): Promise<{ ok: boolean; handoff?: StructuredHandoff; error?: string }> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id 필요' }
  try {
    const row = await env.DB.prepare(`SELECT * FROM agent_handoffs WHERE id = ?`).bind(id).first() as any
    if (!row) return { ok: false, error: 'handoff_not_found' }
    let context: string[] = []
    let constraints: string[] = []
    try {
      const c = JSON.parse(row.context_json || '[]')
      if (Array.isArray(c)) context = c
    } catch { /* 기본값 유지 */ }
    try {
      const c = JSON.parse(row.constraints_json || '[]')
      if (Array.isArray(c)) constraints = c
    } catch { /* 기본값 유지 */ }
    return {
      ok: true,
      handoff: {
        id: row.id,
        runId: row.run_id ?? undefined,
        memoryHandoffId: row.memory_handoff_id ?? undefined,
        fromPersona: row.from_persona,
        toPersona: row.to_persona,
        request: row.request,
        context,
        constraints,
        expectedOutput: row.expected_output || '',
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? null,
      },
    }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

/** 한 실행에 연결된 핸드오프 기록 (코디네이터 감사 추적용). */
export async function listRunHandoffs(
  env: any,
  runId: string
): Promise<{ ok: boolean; handoffs?: StructuredHandoff[]; error?: string }> {
  const id = (runId || '').trim()
  if (!id) return { ok: false, error: 'run_id 필요' }
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM agent_handoffs WHERE run_id = ? ORDER BY id ASC`
    ).bind(id).all() as any
    const rows = res.results || []
    const handoffs: StructuredHandoff[] = rows.map((row: any) => {
      let context: string[] = []
      let constraints: string[] = []
      try {
        const c = JSON.parse(row.context_json || '[]')
        if (Array.isArray(c)) context = c
      } catch { /* 기본값 유지 */ }
      try {
        const c = JSON.parse(row.constraints_json || '[]')
        if (Array.isArray(c)) constraints = c
      } catch { /* 기본값 유지 */ }
      return {
        id: row.id,
        runId: row.run_id ?? undefined,
        memoryHandoffId: row.memory_handoff_id ?? undefined,
        fromPersona: row.from_persona,
        toPersona: row.to_persona,
        request: row.request,
        context,
        constraints,
        expectedOutput: row.expected_output || '',
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? null,
      }
    })
    return { ok: true, handoffs }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}
