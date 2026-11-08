import {
  decayTier,
  extractSearchTerms,
  fetchRankedMemories,
  fetchSupersededMatches,
  fusionScore,
  isMemoryV2Enabled,
  parseEntities,
  touchMemories,
  type MemoryItem,
  type MemoryTier,
} from './memory-service'

export const MAX_GRAPH_RESULTS = 5

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
