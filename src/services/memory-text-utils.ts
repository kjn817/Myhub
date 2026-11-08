export type MemoryTier = 'hot' | 'warm' | 'cold' | 'archived'

/** 위생 처리 경계: 제어 문자 제거, 과도한 빈 줄 축소, 길이 제한. */
export function sanitizeMemoryContent(content: string, maxLen: number = 5000): string {
  const cleaned = (content || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.slice(0, maxLen)
}

/** near-duplicate 판정용 정규화: 소문자 + 문자/숫자만 남김. */
export function normalizeForDuplicate(content: string): string {
  return (content || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** zero-LLM 압축: 첫 문장(또는 첫 줄)을 핵심 사실로 추출. */
export function extractCoreFact(content: string, maxLen: number = 200): string {
  const text = (content || '').trim()
  if (!text) return ''
  const firstLine = text.split('\n')[0].trim()
  const m = firstLine.match(/^[^.!?\n]{1,200}?[.!?]/)
  const core = m ? m[0] : firstLine.slice(0, maxLen)
  return core.trim()
}

/**
 * 접근 가중 감쇠 티어.
 * - lastActivityAt이 없으면 Infinity(접근 기록 없음)로 취급 — 호출자는
 *   last_accessed_at || updated_at을 넘겨 신규 기억이 archived가 되지 않게 한다.
 */
export function decayTier(
  accessCount: number,
  lastActivityAt: string | null | undefined,
  nowMs: number = Date.now()
): MemoryTier {
  const last = lastActivityAt ? Date.parse(lastActivityAt) : NaN
  const ageDays = Number.isFinite(last) ? Math.max(0, (nowMs - last) / 86400000) : Infinity
  if (ageDays <= 7) return 'hot'
  if (ageDays <= 30) return accessCount >= 5 ? 'hot' : 'warm'
  if (ageDays <= 90) return accessCount >= 10 ? 'warm' : 'cold'
  return 'archived'
}

export interface FusionInput {
  /** FTS5 bm25() — 음수, 더 음수일수록 관련 높음. null이면 FTS 점수 없음. */
  ftsRank?: number | null
  entityMatches?: number
  entityTotal?: number
  /** 마지막 활동으로부터 경과 일수 */
  ageDays?: number
  accessCount?: number
}

/** 융합 랭킹 점수 (0~1): FTS 0.55 + 엔티티 0.25 + 최신성 0.15 + 접근 0.05 */
export function fusionScore(input: FusionInput): number {
  // 유한수가 아닌 입력(NaN·Infinity·null)은 "신호 없음" 기본값으로 소독한다.
  // 소독 없이는 NaN이 점수 전체로 전파되어 정렬이 깨지고, 음수 entityMatches는
  // 점수를 0 아래로 떨어뜨렸다 (fast-check 반례).
  const finite = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const rank = finite(input.ftsRank)
  const fts = Math.max(0, Math.min(1, -rank / 10))
  const total = finite(input.entityTotal)
  const entity = total > 0 ? Math.max(0, Math.min(1, finite(input.entityMatches) / total)) : 0
  const recency = 1 / (1 + Math.max(0, finite(input.ageDays)) / 30)
  const access = Math.min(1, Math.max(0, finite(input.accessCount)) / 5)
  return 0.55 * fts + 0.25 * entity + 0.15 * recency + 0.05 * access
}

/** entities 컬럼(JSON 문자열 또는 배열)을 문자열 배열로 파싱. 실패 시 []. */
export function parseEntities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((e): e is string => typeof e === 'string')
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}

/** 검색 토큰 추출 (2글자 이상, 최대 5개). */
export function extractSearchTerms(query: string): string[] {
  return (query || '').trim().split(/\s+/).filter((t) => t.length >= 2).slice(0, 5)
}

/** 한국어 조사 (긴 것부터 — '에서'를 '에'보다 먼저 떼야 함). */
const KOREAN_PARTICLES = [
  '에서', '에게', '한테', '으로', '부터', '까지', '하고', '이랑', '처럼', '보다',
  '마저', '조차', '이라도', '라도', '은', '는', '이', '가', '을', '를', '의',
  '에', '로', '와', '과', '도', '만', '나', '야', '아', '며',
]

/** 토큰 끝의 조사를 떼어 어간을 반환한다. 어간이 2글자 미만이면 원본 유지. */
export function stripKoreanParticle(token: string): string {
  for (const p of KOREAN_PARTICLES) {
    if (token.length > p.length + 1 && token.endsWith(p)) {
      return token.slice(0, -p.length)
    }
  }
  return token
}

/**
 * FTS5 MATCH용 쿼리 문자열 (따옴표 이스케이프).
 * - 토큰은 OR로 결합한다 (AND면 "내 반려견 이름이 뭐야?" 같은 자연스러운
 *   질문이 토큰 하나라도 안 맞는 순간 통째로 실패했음).
 * - 각 토큰은 원본 + 조사 제거 어간의 접두사 검색을 함께 넣는다.
 *   FTS5는 토큰 단위 정확 일치라 "이름"만으로는 "이름은" 토큰을 못 찾고,
 *   `"이름"*` 접두사 검색이어야 "이름은/이름이"와 매칭된다.
 * - 잡음은 융합 랭킹(bm25 + 엔티티 + 최신성 + 접근) + 최대 5개 제한이 거른다.
 */
export function buildFtsQuery(query: string): string {
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`
  const groups = extractSearchTerms(query).flatMap((t) => {
    const stripped = stripKoreanParticle(t)
    return stripped !== t ? [escape(t), `${escape(stripped)}*`] : [escape(t)]
  })
  return groups.join(' OR ')
}
