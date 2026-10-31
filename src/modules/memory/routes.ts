import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  sanitizeMemoryContent,
  normalizeForDuplicate,
  buildMemoryPage,
  supersedeMemory,
  restoreMemory,
  markContradiction,
  createHandoff,
  claimHandoff,
} from '../../services/memory-service'
import {
  captureFacts,
  captureFactsFromMemo,
  closeFactTemporalEdges,
  getRelatedFacts,
  getFactNeighbors,
  reopenFactTemporalEdges,
} from '../../services/fact-graph'

const memoryApp = new Hono<{ Bindings: Env }>()

const VALID_CATEGORIES = ['general', 'preference', 'fact', 'schedule', 'work']
const MAX_CONTENT_LENGTH = 5000

// POST /api/memory - 기억 저장 (명시적 요청만)
memoryApp.post('/', async (c) => {
  const body = await c.req.json<{
    content?: string
    category?: string
    source_type?: string
    source_id?: number
    allow_ai_use?: boolean
    allow_provider_send?: boolean
  }>().catch(() => ({ content: undefined, category: undefined, source_type: undefined, source_id: undefined, allow_ai_use: undefined, allow_provider_send: undefined }))

  // 위생 처리 경계: 저장 전에 제어 문자·과도한 빈 줄을 정리한다
  // (maxLen+1로 잘라 길이 초과는 아래에서 400으로 거절 — 기존 동작 유지)
  const content = sanitizeMemoryContent(body.content || '', MAX_CONTENT_LENGTH + 1)
  if (!content) return c.json({ ok: false, error: 'content 필요' }, 400)
  if (content.length > MAX_CONTENT_LENGTH) {
    return c.json({ ok: false, error: '내용이 너무 깁니다' }, 400)
  }

  const category = body.category || 'general'
  if (!VALID_CATEGORIES.includes(category)) {
    return c.json({ ok: false, error: '유효하지 않은 category' }, 400)
  }

  // 중복 체크 (정확 일치)
  const existing = await c.env.DB.prepare(
    'SELECT id FROM ai_memory_v2 WHERE content = ? AND is_active = 1 LIMIT 1'
  ).bind(content).first()
  if (existing) {
    return c.json({ ok: false, error: 'duplicate', existing_id: (existing as any).id }, 409)
  }

  // near-duplicate 체크 (정규화 비교, zero-LLM 병합 — 대소문자·공백·구두점 차이만 있는 기억)
  const norm = normalizeForDuplicate(content)
  if (norm.length > 0) {
    const { results } = await c.env.DB.prepare(
      'SELECT id, content FROM ai_memory_v2 WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 200'
    ).bind().all()
    const nearDup = (results || []).find(
      (r: any) => normalizeForDuplicate(r.content) === norm
    )
    if (nearDup) {
      return c.json({ ok: false, error: 'near_duplicate', existing_id: (nearDup as any).id }, 409)
    }
  }

  const now = new Date().toISOString()
  // allow_ai_use, allow_provider_send는 기본 false (명시적 허용 필요)
  const allowAiUse = body.allow_ai_use === true ? 1 : 0
  const allowProviderSend = body.allow_provider_send === true ? 1 : 0
  const result = await c.env.DB.prepare(
    `INSERT INTO ai_memory_v2
     (content, category, created_by, source_type, source_id, consent_type, allow_ai_use, allow_provider_send, created_at, updated_at)
     VALUES (?, ?, 'user', ?, ?, 'explicit', ?, ?, ?, ?)`
  ).bind(content, category, body.source_type || null, body.source_id || null, allowAiUse, allowProviderSend, now, now).run()

  return c.json({ ok: true, id: result.meta.last_row_id })
})

// GET /api/memory - 기억 목록 (FTS 검색 지원)
memoryApp.get('/', async (c) => {
  const category = c.req.query('category')
  const q = c.req.query('q')

  // FTS 검색 (2글자 이상)
  if (q && q.trim().length >= 2) {
    const searchTerm = q.trim().split(/\s+/).filter((t: string) => t.length >= 2)
      .map((t: string) => `"${t.replace(/"/g, '""')}"`).join(' ')
    if (searchTerm) {
      try {
        const { results } = await c.env.DB.prepare(
          `SELECT m.id, m.content, m.category, m.created_by, m.source_type, m.created_at, m.updated_at
           FROM ai_memory_fts fts
           JOIN ai_memory_v2 m ON m.id = fts.rowid
           WHERE ai_memory_fts MATCH ? AND m.is_active = 1
           ${category ? 'AND m.category = ?' : ''}
           ORDER BY m.updated_at DESC LIMIT 100`
        ).bind(...(category ? [searchTerm, category] : [searchTerm])).all()
        return c.json({ ok: true, results, search_type: 'fts' })
      } catch {
        // FTS 실패 시 LIKE 폴백
      }
    }
  }

  let sql = 'SELECT id, content, category, created_by, source_type, created_at, updated_at FROM ai_memory_v2 WHERE is_active = 1'
  const params: any[] = []
  if (category) {
    sql += ' AND category = ?'
    params.push(category)
  }
  if (q) {
    sql += ' AND content LIKE ?'
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`)
  }
  sql += ' ORDER BY updated_at DESC LIMIT 100'

  const { results } = await c.env.DB.prepare(sql).bind(...params).all()
  return c.json({ ok: true, results })
})

// PUT /api/memory/:id - 기억 수정
memoryApp.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (!id || id < 1) return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)

  const body = await c.req.json<{ content?: string; category?: string; allow_ai_use?: boolean; allow_provider_send?: boolean }>().catch(() => ({ content: undefined, category: undefined, allow_ai_use: undefined, allow_provider_send: undefined }))
  // 위생 처리 경계 (POST와 동일 — maxLen+1로 잘라 초과는 400으로 거절)
  const content = body.content === undefined
    ? undefined
    : sanitizeMemoryContent(body.content, MAX_CONTENT_LENGTH + 1)
  if (content !== undefined) {
    if (!content) return c.json({ ok: false, error: 'content 필요' }, 400)
    if (content.length > MAX_CONTENT_LENGTH) {
      return c.json({ ok: false, error: '내용이 너무 깁니다' }, 400)
    }
  }
  if (body.category && !VALID_CATEGORIES.includes(body.category)) {
    return c.json({ ok: false, error: '유효하지 않은 category' }, 400)
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM ai_memory_v2 WHERE id = ? AND is_active = 1'
  ).bind(id).first()
  if (!existing) return c.json({ ok: false, error: 'not_found' }, 404)

  const now = new Date().toISOString()
  const updates: string[] = ['updated_at = ?']
  const params: any[] = [now]
  if (content !== undefined) {
    updates.push('content = ?')
    params.push(content)
  }
  if (body.category) {
    updates.push('category = ?')
    params.push(body.category)
  }
  // 동의 필드 업데이트 (명시적으로 전달된 경우만)
  if (body.allow_ai_use !== undefined) {
    updates.push('allow_ai_use = ?')
    params.push(body.allow_ai_use === true ? 1 : 0)
  }
  if (body.allow_provider_send !== undefined) {
    updates.push('allow_provider_send = ?')
    params.push(body.allow_provider_send === true ? 1 : 0)
  }
  params.push(id)

  await c.env.DB.prepare(
    `UPDATE ai_memory_v2 SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...params).run()

  return c.json({ ok: true })
})

// DELETE /api/memory/:id - 기억 비활성화 (기본)
// ?permanent=true 시 영구 삭제
memoryApp.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (!id || id < 1) return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)

  const permanent = c.req.query('permanent') === 'true'
  const existing = await c.env.DB.prepare(
    'SELECT id FROM ai_memory_v2 WHERE id = ? AND is_active = 1'
  ).bind(id).first()
  if (!existing) return c.json({ ok: false, error: 'not_found' }, 404)

  if (permanent) {
    // 영구 삭제: 그래프 자식 행을 먼저 정리한 뒤 원본 제거
    // (memory_fact_entities.fact_id / memory_relations.fact_id가
    //  ai_memory_v2(id)를 참조하므로, 원본부터 지우면 FK 오류 500이 난다)
    await c.env.DB.prepare('DELETE FROM memory_fact_entities WHERE fact_id = ?').bind(id).run()
    await c.env.DB.prepare('DELETE FROM memory_relations WHERE fact_id = ?').bind(id).run()
    await c.env.DB.prepare('DELETE FROM ai_memory_v2 WHERE id = ?').bind(id).run()
    return c.json({ ok: true, deleted: 'permanent' })
  } else {
    // 비활성화
    const now = new Date().toISOString()
    await c.env.DB.prepare(
      'UPDATE ai_memory_v2 SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?'
    ).bind(now, now, id).run()
    return c.json({ ok: true, deleted: 'deactivated' })
  }
})

// POST /api/memory/extract - 텍스트에서 사실 추출·저장 (mem0 패턴, zero-LLM 기본)
// LLM 추출기는 HTTP로 노출하지 않는다 — 플래그 OFF가 기본이며 패턴만 준비됨.
memoryApp.post('/extract', async (c) => {
  const body = await c.req.json<{
    text?: string
    source_type?: string
    source_id?: number
    created_by?: 'user' | 'assistant'
  }>().catch(() => ({ text: undefined, source_type: undefined, source_id: undefined, created_by: undefined }))
  const r = await captureFacts(c.env, {
    text: body.text || '',
    sourceType: body.source_type,
    sourceId: body.source_id,
    createdBy: body.created_by,
  })
  if (!r.ok) return c.json({ ok: false, error: r.error }, 400)
  return c.json({
    ok: true,
    extraction: r.extraction,
    created: r.created,
    skipped: r.skipped,
    entities: r.entities,
  })
})

// POST /api/memory/memos/:id/capture - 메모에서 사실 캡처 (잠긴 메모 거부)
memoryApp.post('/memos/:id/capture', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (!id || id < 1) return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)
  const r = await captureFactsFromMemo(c.env, id)
  if (!r.ok) {
    const status = r.error === 'not_found' ? 404 : r.error === 'locked' ? 403 : 400
    return c.json({ ok: false, error: r.error }, status)
  }
  return c.json({
    ok: true,
    extraction: r.extraction,
    created: r.created,
    skipped: r.skipped,
    entities: r.entities,
  })
})

// GET /api/memory/graph/related - 그래프 인식 관련 사실 검색 (FTS5 + 1-hop, 최대 5개)
// (':id/related'보다 먼저 등록 — Hono는 등록 순서대로 매칭한다)
memoryApp.get('/graph/related', async (c) => {
  const q = c.req.query('q') || ''
  const limitRaw = parseInt(c.req.query('limit') || '5', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 5) : 5
  const results = await getRelatedFacts(c.env, q, limit)
  return c.json({ ok: true, results, search_type: 'graph_fts' })
})

// GET /api/memory/:id/related - 같은 엔티티를 공유하는 이웃 사실
memoryApp.get('/:id/related', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (!id || id < 1) return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)
  const limitRaw = parseInt(c.req.query('limit') || '5', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 5) : 5
  const results = await getFactNeighbors(c.env, id, limit)
  return c.json({ ok: true, results })
})

// POST /api/memory/pages - 요약 페이지 생성 (원본 기억들의 핵심 사실 모음, zero-LLM)
memoryApp.post('/pages', async (c) => {
  const body = await c.req.json<{
    title?: string
    category?: string
    memory_ids?: number[]
  }>().catch(() => ({ title: undefined, category: undefined, memory_ids: undefined }))
  const r = await buildMemoryPage(c.env, {
    title: body.title || '',
    category: body.category,
    memoryIds: body.memory_ids || [],
  })
  if (!r.ok) {
    return c.json({ ok: false, error: r.error }, r.error === 'not_found' ? 404 : 400)
  }
  return c.json({ ok: true, id: r.id })
})

// GET /api/memory/pages - 요약 페이지 목록
memoryApp.get('/pages', async (c) => {
  const category = c.req.query('category')
  let sql = 'SELECT id, title, body, category, source_ids, created_at, updated_at FROM memory_pages WHERE is_active = 1'
  const params: any[] = []
  if (category) {
    sql += ' AND category = ?'
    params.push(category)
  }
  sql += ' ORDER BY updated_at DESC LIMIT 100'
  const { results } = await c.env.DB.prepare(sql).bind(...params).all()
  return c.json({ ok: true, results })
})

// POST /api/memory/:id/supersede - 기억 대체 (삭제가 아닌 계보, 복원 가능)
memoryApp.post('/:id/supersede', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  const body = await c.req.json<{ superseded_by?: number }>().catch(() => ({ superseded_by: undefined }))
  const newId = body.superseded_by
  if (!id || id < 1 || !Number.isInteger(newId) || (newId as number) < 1 || newId === id) {
    return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)
  }
  const targetId = newId as number
  const old = await c.env.DB.prepare(
    'SELECT id FROM ai_memory_v2 WHERE id = ? AND is_active = 1'
  ).bind(id).first()
  if (!old) return c.json({ ok: false, error: 'not_found' }, 404)
  const next = await c.env.DB.prepare(
    'SELECT id FROM ai_memory_v2 WHERE id = ? AND is_active = 1'
  ).bind(targetId).first()
  if (!next) return c.json({ ok: false, error: 'not_found' }, 404)
  const r = await supersedeMemory(c.env, id, targetId)
  if (!r.ok) return c.json({ ok: false, error: r.error }, 500)
  // 0056: 새 사실이 오면 구 사실의 시간 엣지를 닫는다 (Graphiti 시간 엣지 규칙).
  // 닫기 실패(0056 미적용 DB)는 대체 자체를 실패로 만들지 않는다 (best-effort).
  await closeFactTemporalEdges(c.env, id)
  return c.json({ ok: true })
})

// POST /api/memory/:id/restore - 대체·비활성화된 기억 복원
memoryApp.post('/:id/restore', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (!id || id < 1) return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)
  const existing = await c.env.DB.prepare(
    'SELECT id FROM ai_memory_v2 WHERE id = ?'
  ).bind(id).first()
  if (!existing) return c.json({ ok: false, error: 'not_found' }, 404)
  const r = await restoreMemory(c.env, id)
  if (!r.ok) return c.json({ ok: false, error: r.error }, 500)
  // 0056: 복원된 사실의 닫혔던 시간 엣지를 다시 연다 (memora에는 없는
  // MyHub 전용 "제자리 복원" — 대체자도 살아 있으면 두 버전이 동시에
  // 유효한 분기가 되므로 비교 메모의 KNOWN GAP을 볼 것).
  await reopenFactTemporalEdges(c.env, id)
  return c.json({ ok: true })
})

// POST /api/memory/:id/contradiction - 모순 플래그 설정/해제
memoryApp.post('/:id/contradiction', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (!id || id < 1) return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)
  const body = await c.req.json<{ flag?: boolean }>().catch(() => ({ flag: undefined }))
  const existing = await c.env.DB.prepare(
    'SELECT id FROM ai_memory_v2 WHERE id = ? AND is_active = 1'
  ).bind(id).first()
  if (!existing) return c.json({ ok: false, error: 'not_found' }, 404)
  const r = await markContradiction(c.env, id, body.flag === true)
  if (!r.ok) return c.json({ ok: false, error: r.error }, 500)
  return c.json({ ok: true })
})

// POST /api/memory/handoffs - 비서 간 인계 생성 (claim-once)
memoryApp.post('/handoffs', async (c) => {
  const body = await c.req.json<{
    from_persona?: string
    to_persona?: string
    memory_ids?: number[]
    summary?: string
    ttl_minutes?: number
  }>().catch(() => ({
    from_persona: undefined, to_persona: undefined,
    memory_ids: undefined, summary: undefined, ttl_minutes: undefined,
  }))
  const r = await createHandoff(c.env, {
    fromPersona: body.from_persona || '',
    toPersona: body.to_persona || '',
    memoryIds: body.memory_ids || [],
    summary: body.summary,
    ttlMinutes: body.ttl_minutes,
  })
  if (!r.ok) return c.json({ ok: false, error: r.error }, 400)
  return c.json({ ok: true, id: r.id, claim_token: r.claimToken })
})

// POST /api/memory/handoffs/:token/claim - 인계 1회 수령 (두 번째 수령 불가)
memoryApp.post('/handoffs/:token/claim', async (c) => {
  const token = c.req.param('token')
  const r = await claimHandoff(c.env, token)
  if (!r.ok) {
    return c.json(
      { ok: false, error: r.error },
      r.error === 'already_claimed_or_expired' ? 409 : 400
    )
  }
  return c.json({ ok: true, payload: r.payload, from_persona: r.fromPersona, to_persona: r.toPersona })
})

export default memoryApp
