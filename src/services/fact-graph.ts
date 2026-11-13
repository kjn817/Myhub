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
} from './memory-service'
import {
  MAX_FACTS_PER_CAPTURE,
  extractFacts,
  extractEntities,
  normalizeEntityName,
} from './fact-extract'
import { sanitizeForAI } from './ai-access'
import { readBooleanSetting } from '../lib/d1-setting'

export { expandGraphFacts, getFactNeighbors, getRelatedFacts } from './fact-graph-expand'
export { closeFactTemporalEdges, reopenFactTemporalEdges } from './fact-temporal-edges'

const DEDUP_PAGE_SIZE = 200

/** LLM 추출 플래그 (기본 OFF). */
export async function isLlmExtractEnabled(env: any): Promise<boolean> {
  return readBooleanSetting(env.DB, 'memory.llm_extract_enabled')
}

async function loadAllActiveNorms(env: any): Promise<Set<string>> {
  const norms = new Set<string>()
  let offset = 0
  for (let page = 0; page < 10000; page++) {
    const { results } = await env.DB.prepare(
      'SELECT content FROM ai_memory_v2 WHERE is_active = 1 ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    ).bind(DEDUP_PAGE_SIZE, offset).all() as { results: any[] }
    const list = results || []
    let fresh = 0
    for (const r of list) {
      const n = normalizeForDuplicate(String((r as any).content || ''))
      if (!norms.has(n)) {
        norms.add(n)
        fresh++
      }
    }
    offset += list.length
    if (list.length < DEDUP_PAGE_SIZE) break
    if (fresh === 0) break
  }
  return norms
}

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

  let existingNorms = new Set<string>()
  try {
    existingNorms = await loadAllActiveNorms(env)
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
