// mem0 패턴 이식 — 사실 추출·그래프 메모리 파이프라인 (0046, 임베딩 없음)
//
// mem0ai/mem0의 패턴만 이식한다 (mem0 코드 미사용):
// - 대화/메모에서 사실을 추출해 저장한다 (mem0의 add → extract)
// - 사실 노드 + 엔티티 노드 + 관계 간선으로 그래프를 유지한다 (mem0의 graph memory)
// - 검색 시 관련 사실만 주입한다 (mem0의 search → 최대 5개, 통째 주입 금지)
//
// 사실 저장소는 0044의 ai_memory_v2를 재사용·확장한다 (중복 구현 금지).
// - 사실 노드: ai_memory_v2 행 (category='fact', source_type/source_id로 출처 기록)
// - 엔티티 노드: memory_entities / 관계 간선: memory_relations / 연결: memory_fact_entities
// - 검색: 기존 ai_memory_fts(FTS5) + 융합 랭킹(fetchRankedMemories)을 재사용하고,
//   그래프는 1-hop 확장으로 관련 사실을 보강한다. 임베딩 없음.
// - 기본 경로는 zero-LLM (결정적 규칙). LLM 추출은 플래그 기본 OFF, 패턴만 준비.
// - 위생 처리 경계: sanitizeMemoryContent를 통과한 것만 저장하고, 잠긴 메모는
//   추출 자체를 거부한다 (기존 원칙 — 잠긴 메모는 모든 외부 AI 전송 경로에서 제외).
//   allow_ai_use/allow_provider_send는 캡처 시 기본 0 (명시적 허용 필요).

import {
  sanitizeMemoryContent,
  normalizeForDuplicate,
  extractSearchTerms,
  fusionScore,
  decayTier,
  parseEntities,
  fetchRankedMemories,
  isMemoryV2Enabled,
  touchMemories,
  fetchSupersededMatches,
  type MemoryItem,
  type MemoryTier,
} from './memory-service'
import {
  MAX_FACTS_PER_CAPTURE,
  extractFacts,
  extractEntities,
  normalizeEntityName,
} from './fact-extract'
import { sanitizeForAI } from './ai-access'

export const MAX_GRAPH_RESULTS = 5

// ---------------------------------------------------------------------------
// 캡처 (대화/메모 → 사실 추출 → ai_memory_v2 저장 → 그래프 연결)
// ---------------------------------------------------------------------------

export interface CaptureFactsInput {
  text: string
  sourceType?: string
  sourceId?: number
  createdBy?: 'user' | 'assistant'
  maxFacts?: number
  /** 이미 추출된 사실 목록 (주입 시 extractFacts/LLM 추출을 건너뛴다 — 성찰 경로용) */
  facts?: string[]
  /** LLM 추출기 (주입식). 플래그 memory.llm_extract_enabled='true'일 때만 사용. 기본 OFF. */
  llmExtract?: (text: string) => Promise<string[]>
}

export interface CaptureFactsResult {
  ok: boolean
  extraction?: 'deterministic' | 'llm'
  created?: Array<{ id: number; content: string }>
  skipped?: string[]
  entities?: string[]
  error?: string
}

/** LLM 추출 플래그 (기본 OFF). */
export async function isLlmExtractEnabled(env: any): Promise<boolean> {
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM ai_settings WHERE key = 'memory.llm_extract_enabled'"
    ).first()
    return !!flag && (flag as any).value === 'true'
  } catch {
    return false
  }
}

async function upsertEntity(env: any, name: string): Promise<number | null> {
  const normalized = normalizeEntityName(name)
  if (!normalized) return null
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO memory_entities (name, normalized) VALUES (?, ?)'
    ).bind(name, normalized).run()
    const row = await env.DB.prepare(
      'SELECT id FROM memory_entities WHERE normalized = ?'
    ).bind(normalized).first() as any
    return row ? Number(row.id) : null
  } catch {
    return null // 0046 미적용 DB에서는 그래프 연결만 건너뜀
  }
}

async function linkFactGraph(
  env: any,
  factId: number,
  factContent: string,
  nowIso?: string
): Promise<string[]> {
  const names = extractEntities(factContent)
  if (!names.length) return []
  const ids: number[] = []
  const linkedNames: string[] = []
  const validFrom = nowIso || new Date().toISOString()
  for (const name of names) {
    const id = await upsertEntity(env, name)
    if (id === null) continue
    ids.push(id)
    try {
      // 0056: 연결 생성 시각을 valid_from으로 기록한다 (열린 구간 시작).
      await env.DB.prepare(
        'INSERT OR IGNORE INTO memory_fact_entities (fact_id, entity_id, valid_from) VALUES (?, ?, ?)'
      ).bind(factId, id, validFrom).run()
      linkedNames.push(name)
    } catch {
      // 0056 미적용 DB(컬럼 없음)에서는 valid_from 없이 재시도 — 연결은 유지
      // (0046만 적용된 DB에서도 그래프가 동작해야 한다).
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO memory_fact_entities (fact_id, entity_id) VALUES (?, ?)'
        ).bind(factId, id).run()
        linkedNames.push(name)
      } catch { /* 연결 실패는 무시 */ }
    }
  }
  // 같은 사실에서 함께 등장한 엔티티 쌍 → related_to 간선 (id 순으로 방향 고정)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = Math.min(ids[i], ids[j])
      const b = Math.max(ids[i], ids[j])
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO memory_relations
           (source_entity_id, target_entity_id, relation, fact_id) VALUES (?, ?, 'related_to', ?)`
        ).bind(a, b, factId).run()
      } catch { /* 간선 실패는 무시 */ }
    }
  }
  return linkedNames
}

export interface TemporalEdge {
  entityId: number
  validFrom: string | null
  validUntil: string | null
}

/**
 * 사실의 시간 엣지 조회 (0056): 해당 사실의 모든 엔티티 연결 + 유효 기간.
 * 0056 미적용 DB에서는 [] 반환 (fail-soft).
 */
export async function getFactTemporalEdges(env: any, factId: number): Promise<TemporalEdge[]> {
  if (!Number.isInteger(factId) || factId < 1) return []
  try {
    const { results } = await env.DB.prepare(
      'SELECT entity_id, valid_from, valid_until FROM memory_fact_entities WHERE fact_id = ?'
    ).bind(factId).all() as { results: any[] }
    return (results || []).map((r: any) => ({
      entityId: Number(r.entity_id),
      validFrom: r.valid_from ? String(r.valid_from) : null,
      validUntil: r.valid_until ? String(r.valid_until) : null,
    }))
  } catch {
    return []
  }
}

/**
 * 시간 엣지 닫기 — Graphiti 시간 엣지 규칙 (0056):
 * 새 사실이 기존 사실을 대체하면, 기존 사실의 엔티티 연결 유효 기간을
 * 닫는다 (valid_until = 대체 시각). 열린 연결(valid_until IS NULL)만 닫고,
 * 이미 닫힌 연결은 건드리지 않는다 (멱등 — 재실행해도 changes 0).
 * - 0056 미적용 DB에서는 UPDATE가 실패해 { ok: false } 반환 (fail-soft).
 * - 호출: memory-consolidation 중복 병합 + POST /:id/supersede.
 */
export async function closeFactTemporalEdges(
  env: any,
  factId: number,
  nowIso?: string
): Promise<{ ok: boolean; closed: number }> {
  if (!Number.isInteger(factId) || factId < 1) return { ok: false, closed: 0 }
  try {
    const res = await env.DB.prepare(
      'UPDATE memory_fact_entities SET valid_until = ? WHERE fact_id = ? AND valid_until IS NULL'
    ).bind(nowIso || new Date().toISOString(), factId).run()
    return { ok: true, closed: Number(res.meta?.changes ?? 0) }
  } catch {
    return { ok: false, closed: 0 }
  }
}

/**
 * 시간 엣지 다시 열기 — 복원(POST /:id/restore) 전용:
 * 복원된 사실의 닫혔던 연결을 다시 유효하게 한다 (valid_until = NULL).
 * valid_from은 건드리지 않는다 (원래 연결 생성 시각 유지).
 * - memora에는 이런 "제자리 복원"이 없다 (삭제된 내용은 tombstone이 막고,
 *   대체된 내용은 새 행으로만 돌아온다). MyHub restore는 명시적 사용자
 *   행위라 재개를 허용하되, 대체자도 살아 있으면 두 버전이 동시에
 *   유효한 분기(fork)가 된다 — 비교 메모(docs/memora-compare-20261026.md) 참조.
 */
export async function reopenFactTemporalEdges(
  env: any,
  factId: number
): Promise<{ ok: boolean; reopened: number }> {
  if (!Number.isInteger(factId) || factId < 1) return { ok: false, reopened: 0 }
  try {
    const res = await env.DB.prepare(
      'UPDATE memory_fact_entities SET valid_until = NULL WHERE fact_id = ? AND valid_until IS NOT NULL'
    ).bind(factId).run()
    return { ok: true, reopened: Number(res.meta?.changes ?? 0) }
  } catch {
    return { ok: false, reopened: 0 }
  }
}

/**
 * 텍스트에서 사실을 추출해 ai_memory_v2에 저장하고 그래프를 연결한다.
 * - 기본 경로는 zero-LLM (결정적 규칙). LLM 추출기는 플래그 ON일 때만 사용하고,
 *   실패하면 결정적 경로로 폴백한다.
 * - 캡처된 사실은 allow_ai_use/allow_provider_send 기본 0 — 외부 전송은
 *   사용자가 명시적으로 허용한 사실만 가능하다 (0044 동의 게이트 유지).
 * - near-duplicate는 저장하지 않고 skipped로 보고한다.
 */
export async function captureFacts(
  env: any,
  input: CaptureFactsInput
): Promise<CaptureFactsResult> {
  const clean = sanitizeMemoryContent(input.text || '', 5000)
  if (!clean) return { ok: false, error: 'text 필요' }
  const maxFacts = Math.min(Math.max(input.maxFacts || MAX_FACTS_PER_CAPTURE, 1), 10)
  const createdBy = input.createdBy === 'user' ? 'user' : 'assistant'

  // 추출: 기본 결정적, LLM은 플래그 ON + 추출기 주입 시에만.
  // facts가 주입되면 추출을 건너뛰고 그대로 사용한다 (성찰 경로).
  let extraction: 'deterministic' | 'llm' = 'deterministic'
  let facts: string[]
  if (Array.isArray(input.facts)) {
    facts = input.facts
      .map((f) => sanitizeMemoryContent(String(f || ''), 200).trim())
      .filter((f) => f.length >= 5)
      .slice(0, maxFacts)
  } else {
    facts = extractFacts(clean, maxFacts)
  }
  if (!input.facts && input.llmExtract) {
    try {
      if (await isLlmExtractEnabled(env)) {
        const llmFacts = (await input.llmExtract(clean))
          .map((f) => sanitizeMemoryContent(String(f || ''), 200).trim())
          .filter((f) => f.length >= 5)
          .slice(0, maxFacts)
        if (llmFacts.length > 0) {
          facts = llmFacts
          extraction = 'llm'
        }
      }
    } catch {
      // LLM 추출 실패 시 결정적 결과 유지 (폴백)
    }
  }
  if (!facts.length) {
    return { ok: true, extraction, created: [], skipped: [], entities: [] }
  }

  // near-duplicate 판정용 기존 사실 목록 (활성 200개)
  let existingNorms = new Set<string>()
  try {
    const { results } = await env.DB.prepare(
      'SELECT content FROM ai_memory_v2 WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 200'
    ).all() as { results: any[] }
    existingNorms = new Set((results || []).map((r: any) => normalizeForDuplicate(String(r.content || ''))))
  } catch {
    return { ok: false, error: 'db_error' }
  }

  const created: Array<{ id: number; content: string }> = []
  const skipped: string[] = []
  const entityNames: string[] = []
  const seenInput = new Set<string>()
  const now = new Date().toISOString()
  for (const fact of facts) {
    const norm = normalizeForDuplicate(fact)
    if (seenInput.has(norm) || existingNorms.has(norm)) {
      skipped.push(fact)
      continue
    }
    seenInput.add(norm)
    try {
      const result = await env.DB.prepare(
        `INSERT INTO ai_memory_v2
         (content, category, created_by, source_type, source_id, consent_type,
          allow_ai_use, allow_provider_send, created_at, updated_at)
         VALUES (?, 'fact', ?, ?, ?, 'explicit', 0, 0, ?, ?)`
      ).bind(fact, createdBy, input.sourceType || null, input.sourceId || null, now, now).run()
      const id = Number(result.meta.last_row_id)
      created.push({ id, content: fact })
      existingNorms.add(norm)
      const names = await linkFactGraph(env, id, fact, now)
      for (const n of names) {
        if (!entityNames.includes(n)) entityNames.push(n)
      }
    } catch {
      skipped.push(fact)
    }
  }
  return { ok: true, extraction, created, skipped, entities: entityNames }
}

/**
 * 메모에서 사실 캡처 — 잠긴 메모는 추출 자체를 거부한다.
 * is_locked 확인 쿼리와 본문 조회 쿼리를 분리해, 잠긴 메모의 본문을
 * 읽지 않고도 거부할 수 있게 한다 (위생 처리 경계).
 */
export async function captureFactsFromMemo(
  env: any,
  memoId: number
): Promise<CaptureFactsResult> {
  if (!Number.isInteger(memoId) || memoId < 1) {
    return { ok: false, error: 'invalid_id' }
  }
  try {
    const lockRow = await env.DB.prepare(
      'SELECT id, is_locked FROM memos WHERE id = ?'
    ).bind(memoId).first() as any
    if (!lockRow) return { ok: false, error: 'not_found' }
    if (lockRow.is_locked === 1) return { ok: false, error: 'locked' }
    const memo = await env.DB.prepare(
      'SELECT text, locked_blocks FROM memos WHERE id = ?'
    ).bind(memoId).first() as any
    if (!memo) return { ok: false, error: 'not_found' }
    // 잠긴 블록 제거 (HTML locked span) 후 결정적 추출
    // sanitizeForAI는 잠긴 블록을 '[LOCKED_BLOCK]' 자리표시자로 바꾸는데, 이를
    // 문장 경계('. ')로 치환해야 뒤따르는 공개 문장이 같은 문장에 붙어 통째로
    // 버려지지 않는다. 자리표시자 자체는 isFactSentence가 제외한다.
    const clean = sanitizeForAI(String(memo.text || ''), memo.locked_blocks)
      .replace(/\[LOCKED_BLOCK\]/g, '. ')
    return captureFacts(env, {
      text: clean,
      sourceType: 'memo',
      sourceId: memoId,
      createdBy: 'assistant',
    })
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

// ---------------------------------------------------------------------------
// 검색 주입 — FTS5 + 그래프 1-hop 확장 (최대 5개, 통째 주입 금지)
// ---------------------------------------------------------------------------

function toMemoryItem(row: any, score: number): MemoryItem {
  const lastActivity: string | null = row.last_accessed_at || row.updated_at || null
  const ageDays = lastActivity
    ? Math.max(0, (Date.now() - Date.parse(lastActivity)) / 86400000)
    : 0
  const tier: MemoryTier = decayTier(row.access_count ?? 0, lastActivity, Date.now())
  const entities = parseEntities(row.entities)
  return {
    id: row.id,
    content: String(row.content || '').slice(0, 200),
    category: row.category,
    summary: row.summary ? String(row.summary).slice(0, 200) : undefined,
    entities: entities.length ? entities : undefined,
    tier,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    superseded: row.is_active === 0,
    supersededBy: row.superseded_by != null ? Number(row.superseded_by) : undefined,
    contradiction: row.contradiction_flag === 1,
    sourceType: row.source_type ? String(row.source_type) : undefined,
    sourceId: row.source_id != null ? Number(row.source_id) : undefined,
    score,
  }
}

/**
 * 그래프 1-hop 확장: 쿼리 토큰과 일치하는 엔티티 → 연결된 사실(직접, +0.10)
 * → 관계 간선으로 이어진 이웃 엔티티의 사실(1-hop, +0.05).
 * 0046 미적용 DB에서는 예외가 나며 호출자가 FTS 결과만 사용한다.
 */
export async function expandGraphFacts(
  env: any,
  query: string,
  limit: number = MAX_GRAPH_RESULTS
): Promise<MemoryItem[]> {
  const terms = extractSearchTerms(query)
  if (!terms.length) return []
  const maxLimit = Math.min(limit, MAX_GRAPH_RESULTS)

  // 시드 엔티티: 이름에 쿼리 토큰 포함 (ESCAPE '\' — %/_ 이스케이프 유효화)
  const likeConds = terms.map(() => "name LIKE ? ESCAPE '\\'").join(' OR ')
  const likeParams = terms.map((t) => `%${t.replace(/[%_\\]/g, '\\$&')}%`)
  const { results: seedRows } = await env.DB.prepare(
    `SELECT id, name FROM memory_entities WHERE ${likeConds} LIMIT 20`
  ).bind(...likeParams).all() as { results: any[] }
  const seedIds = (seedRows || []).map((r: any) => Number(r.id)).filter((n) => n > 0)
  if (!seedIds.length) return []
  const seedSet = new Set(seedIds)

  // 1-hop 이웃 엔티티 (양방향 간선)
  const seedPlaceholders = seedIds.map(() => '?').join(',')
  const { results: relRows } = await env.DB.prepare(
    `SELECT source_entity_id, target_entity_id FROM memory_relations
     WHERE is_active = 1 AND (source_entity_id IN (${seedPlaceholders})
       OR target_entity_id IN (${seedPlaceholders})) LIMIT 100`
  ).bind(...seedIds, ...seedIds).all() as { results: any[] }
  const neighborIds = new Set<number>()
  for (const r of relRows || []) {
    const a = Number((r as any).source_entity_id)
    const b = Number((r as any).target_entity_id)
    if (seedSet.has(a) && !seedSet.has(b)) neighborIds.add(b)
    if (seedSet.has(b) && !seedSet.has(a)) neighborIds.add(a)
  }
  const allEntityIds = [...seedIds, ...[...neighborIds].slice(0, 20)]
  const entityPlaceholders = allEntityIds.map(() => '?').join(',')

  // 엔티티에 연결된 사실 (동의 게이트 포함)
  // 0056: fe.valid_until IS NULL — 대체되어 닫힌 시간 엣지는 확장하지 않는다.
  // 0056 미적용 DB에서는 컬럼이 없어 예외 → 필터 없이 재시도 (레거시 폴백 —
  // 0046만 적용된 DB에서도 그래프 확장이 동작해야 한다. 두 번 다 실패하면
  // 예외가 전파돼 getRelatedFacts의 fail-soft로 FTS만 사용한다).
  const graphFactsSql = (withTemporal: boolean) => `SELECT m.id, m.content, m.category, m.summary, m.entities,
            m.access_count, m.last_accessed_at, m.updated_at, m.created_at,
            m.is_active, m.superseded_by, m.supersedes, m.contradiction_flag,
            m.source_type, m.source_id, fe.entity_id
     FROM memory_fact_entities fe
     JOIN ai_memory_v2 m ON m.id = fe.fact_id
     WHERE fe.entity_id IN (${entityPlaceholders})
       ${withTemporal ? 'AND fe.valid_until IS NULL' : ''}
       AND m.is_active = 1
       AND m.allow_ai_use = 1
       AND m.allow_provider_send = 1`
  let factRows: any[]
  try {
    ;({ results: factRows } = await env.DB.prepare(graphFactsSql(true))
      .bind(...allEntityIds).all() as { results: any[] })
  } catch {
    ;({ results: factRows } = await env.DB.prepare(graphFactsSql(false))
      .bind(...allEntityIds).all() as { results: any[] })
  }

  // 사실별 매칭 엔티티 수 + hop 계산
  const byFact = new Map<number, { row: any; matched: number; hop: number }>()
  for (const r of factRows || []) {
    const entry = byFact.get(r.id) || { row: r, matched: 0, hop: 1 }
    entry.matched += 1
    if (seedSet.has(Number(r.entity_id))) entry.hop = 0
    byFact.set(r.id, entry)
  }
  const ranked = [...byFact.values()].map(({ row, matched, hop }) => {
    const lastActivity: string | null = row.last_accessed_at || row.updated_at || null
    const ageDays = lastActivity
      ? Math.max(0, (Date.now() - Date.parse(lastActivity)) / 86400000)
      : 0
    const base = fusionScore({
      ftsRank: null,
      entityMatches: matched,
      entityTotal: seedIds.length,
      ageDays,
      accessCount: row.access_count ?? 0,
    })
    const score = Math.min(1, base + (hop === 0 ? 0.1 : 0.05))
    return toMemoryItem(row, score)
  })
  ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return ranked.slice(0, maxLimit * 2)
}

/**
 * 그래프 인식 관련 사실 검색 — FTS5 융합 랭킹 + 그래프 1-hop 확장 병합.
 * - 최대 5개, 중복 제거(높은 점수 유지), 최종 선택 후 접근 기록 1회(touch)
 * - 플래그 memory.v2_enabled OFF면 [] (0044와 동일 게이트)
 * - 그래프 테이블 부재(0046 미적용) 시 FTS 결과만 사용 (fail-soft)
 */
export async function getRelatedFacts(
  env: any,
  query: string,
  limit: number = MAX_GRAPH_RESULTS
): Promise<MemoryItem[]> {
  const maxLimit = Math.min(limit, MAX_GRAPH_RESULTS)
  // 마스터 게이트: 플래그 OFF면 FTS도 그래프도 동작하지 않는다
  // (fetchRankedMemories도 내부 확인하지만, 그래프 확장은 자체 게이트가 없어 여기서 차단)
  if (!(await isMemoryV2Enabled(env))) {
    return []
  }
  const ftsRanked = await fetchRankedMemories(env, query, maxLimit)
  let graphRanked: MemoryItem[] = []
  try {
    graphRanked = await expandGraphFacts(env, query, maxLimit)
  } catch {
    graphRanked = [] // 0046 미적용 등 그래프 실패 시 FTS만 사용
  }
  const byId = new Map<number, MemoryItem>()
  for (const item of [...ftsRanked, ...graphRanked]) {
    const prev = byId.get(item.id)
    if (!prev || (item.score ?? 0) > (prev.score ?? 0)) byId.set(item.id, item)
  }
  const picked = [...byId.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxLimit)
  await touchMemories(env, picked.map((r) => r.id))
  // 대체된 기억: 활성 기억과 별도로 최대 2개까지, 대체 표시와 함께 전달한다.
  // (인용 불가 — citableMemoryIds가 제외한다. 접근 기록도 남기지 않는다)
  let superseded: MemoryItem[] = []
  try {
    superseded = await fetchSupersededMatches(env, query)
  } catch {
    superseded = []
  }
  return [...picked, ...superseded]
}

// ---------------------------------------------------------------------------
// 사실 이웃 조회 — 같은 엔티티를 공유하는 사실 (그래프 읽기 API)
// ---------------------------------------------------------------------------

/**
 * 주어진 사실과 엔티티를 공유하는 이웃 사실 목록.
 * 공유 엔티티 수 → 최신 순. 동의 게이트(allow_ai_use/allow_provider_send) 적용.
 * 0046 미적용 DB에서는 [] 반환.
 */
export async function getFactNeighbors(
  env: any,
  factId: number,
  limit: number = MAX_GRAPH_RESULTS
): Promise<MemoryItem[]> {
  if (!Number.isInteger(factId) || factId < 1) return []
  const maxLimit = Math.min(limit, MAX_GRAPH_RESULTS)
  try {
    const { results: seedRows } = await env.DB.prepare(
      'SELECT entity_id FROM memory_fact_entities WHERE fact_id = ? LIMIT 20'
    ).bind(factId).all() as { results: any[] }
    const seedIds = (seedRows || []).map((r: any) => Number(r.entity_id)).filter((n) => n > 0)
    if (!seedIds.length) return []
    const placeholders = seedIds.map(() => '?').join(',')
    // 0056 미적용 DB에서는 valid_until 필터가 예외 → 필터 없이 재시도
    // (레거시 폴백 — expandGraphFacts와 동일 패턴).
    const neighborSql = (withTemporal: boolean) => `SELECT m.id, m.content, m.category, m.summary, m.entities,
              m.access_count, m.last_accessed_at, m.updated_at, m.created_at,
              m.is_active, m.superseded_by, m.supersedes, m.contradiction_flag,
              m.source_type, m.source_id, fe.entity_id
       FROM memory_fact_entities fe
       JOIN ai_memory_v2 m ON m.id = fe.fact_id
       WHERE fe.entity_id IN (${placeholders})
         AND fe.fact_id <> ?
         ${withTemporal ? 'AND fe.valid_until IS NULL' : ''}
         AND m.is_active = 1
         AND m.allow_ai_use = 1
         AND m.allow_provider_send = 1`
    let factRows: any[]
    try {
      ;({ results: factRows } = await env.DB.prepare(neighborSql(true))
        .bind(...seedIds, factId).all() as { results: any[] })
    } catch {
      ;({ results: factRows } = await env.DB.prepare(neighborSql(false))
        .bind(...seedIds, factId).all() as { results: any[] })
    }
    const byFact = new Map<number, { row: any; shared: number }>()
    for (const r of factRows || []) {
      const entry = byFact.get(r.id) || { row: r, shared: 0 }
      entry.shared += 1
      byFact.set(r.id, entry)
    }
    const ranked = [...byFact.values()]
      .map(({ row, shared }) => toMemoryItem(row, shared / Math.max(1, seedIds.length)))
      .sort((a, b) => {
        const byScore = (b.score ?? 0) - (a.score ?? 0)
        if (byScore !== 0) return byScore
        // 동점 시 최신 순 — toMemoryItem은 updated_at을 버리므로 원본 행으로 비교
        const aRow = byFact.get(a.id)!.row
        const bRow = byFact.get(b.id)!.row
        return String(bRow.updated_at || '').localeCompare(String(aRow.updated_at || ''))
      })
      .slice(0, maxLimit)
    await touchMemories(env, ranked.map((r) => r.id))
    return ranked
  } catch {
    return []
  }
}
