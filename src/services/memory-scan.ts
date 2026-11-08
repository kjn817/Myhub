import {
  normalizeForDuplicate,
  parseEntities,
  stripKoreanParticle,
} from './memory-service'

export interface ActiveMemoryRow {
  id: number
  content: string
  summary: string | null
  entities: string | null
  accessCount: number
  lastAccessedAt: string | null
  updatedAt: string | null
  contradictionFlag: number
}

export const CONSOLIDATION_PAGE_SIZE = 500
export const CONSOLIDATION_MAX_PAGES = 10000

export async function fetchAllActiveMemories(
  env: any,
  opts: { pageSize?: number; totalLimit?: number | null }
): Promise<{ rows: ActiveMemoryRow[]; pages: number }> {
  const pageSize = Math.min(Math.max(opts.pageSize || CONSOLIDATION_PAGE_SIZE, 1), 1000)
  const totalLimit = opts.totalLimit ?? null
  const rows: ActiveMemoryRow[] = []
  const seen = new Set<number>()
  let pages = 0
  let offset = 0
  while (pages < CONSOLIDATION_MAX_PAGES) {
    const want = totalLimit != null ? Math.min(pageSize, totalLimit - rows.length) : pageSize
    if (want <= 0) break
    const { results } = await env.DB.prepare(
      `SELECT id, content, summary, entities, access_count,
              last_accessed_at, updated_at, contradiction_flag
       FROM ai_memory_v2 WHERE is_active = 1
       ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
    ).bind(want, offset).all() as { results: any[] }
    pages++
    const page = results || []
    let fresh = 0
    for (const r of page) {
      const id = Number(r.id)
      if (seen.has(id)) continue
      seen.add(id)
      fresh++
      rows.push({
        id,
        content: String(r.content || ''),
        summary: r.summary != null ? String(r.summary) : null,
        entities: r.entities != null ? String(r.entities) : null,
        accessCount: Number(r.access_count ?? 0),
        lastAccessedAt: r.last_accessed_at ? String(r.last_accessed_at) : null,
        updatedAt: r.updated_at ? String(r.updated_at) : null,
        contradictionFlag: Number(r.contradiction_flag ?? 0),
      })
    }
    offset += page.length
    if (page.length < want) break
    if (fresh === 0) break
    if (totalLimit != null && rows.length >= totalLimit) break
  }
  return { rows, pages }
}

/** 내용 토큰 집합 (2글자 이상, 소문자, 조사 제거). 모순 판정의 교집합 입력. */
export function contentTokens(content: string): Set<string> {
  const tokens = (content || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((t) => t.length >= 2)
    .map((t) => stripKoreanParticle(t))
    .filter((t) => t.length >= 2)
  return new Set(tokens)
}

/**
 * 부정·변경 표지: 한쪽에만 있으면 "바뀌었다"는 신호.
 * 흔한 조사·어미('아니요' 등 단독 응답)는 제외하고, 사실 진술 속 표지만 본다.
 */
export const NEGATION_MARKERS = [
  '아니다', '아닌', '아님', '아니라', '취소', '변경', '바뀌', '그만', '중단',
  '더 이상', '틀렸', '잘못', '없어졌', '폐지',
]

export function hasNegationMarker(content: string): boolean {
  const text = content || ''
  return NEGATION_MARKERS.some((m) => text.includes(m))
}

export interface ContradictionFeatures {
  norm: string
  negation: boolean
  tokens: Set<string>
  entities: Set<string>
}

export function contradictionFeatures(
  row: Pick<ActiveMemoryRow, 'content' | 'entities'>
): ContradictionFeatures {
  return {
    norm: normalizeForDuplicate(row.content),
    negation: hasNegationMarker(row.content),
    tokens: contentTokens(row.content),
    entities: new Set(parseEntities(row.entities).map((e) => normalizeForDuplicate(e))),
  }
}

export function detectContradictionFromFeatures(
  fa: ContradictionFeatures,
  fb: ContradictionFeatures
): boolean {
  if (fa.norm === fb.norm) return false
  if (fa.negation === fb.negation) return false
  const minLen = Math.min(fa.tokens.size, fb.tokens.size)
  if (minLen === 0) return false
  let shared = 0
  for (const t of fa.tokens) if (fb.tokens.has(t)) shared++
  if (shared < 2) return false
  const overlap = shared / minLen
  let entityShared = false
  for (const e of fa.entities) if (e && fb.entities.has(e)) {
    entityShared = true
    break
  }
  if (entityShared) return overlap >= 0.25
  return overlap >= 0.4
}
