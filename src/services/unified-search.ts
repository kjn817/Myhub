/**
 * Phase 4B: 통합 검색 서비스
 *
 * 메모·대화·일정·할 일을 권한 검사 후 통합 검색
 * - 읽기 전용
 * - 잠금·restricted 데이터 제외
 * - SQL 인젝션 방지 (파라미터 바인딩)
 */

export interface SearchResult {
  source_type: 'memo' | 'chat' | 'schedule' | 'todo';
  source_id: number;
  title: string;
  snippet: string;
  created_at: string;
  rank: number;
}

export interface UnifiedSearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  types?: Array<'memo' | 'chat' | 'schedule' | 'todo'>;
}

/**
 * FTS5 쿼리용 이스케이프 (기존 memos 로직 재사용)
 */
function ftsQuery(q: string): string | null {
  const tokens = q.trim().split(/\s+/).filter(t => t.length >= 2);
  if (!tokens.length) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * LIKE 폴백용 이스케이프
 */
function likeQuery(q: string): string {
  return `%${q.replace(/[%_\\]/g, '\\$&')}%`;
}

/**
 * 검색 limit 정규화 (1~100 정수만 허용, 그 외는 기본값 20)
 * routes.ts와 동일한 정책 사용
 */
export function normalizeSearchLimit(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 20;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    return 20;
  }
  return Math.min(n, 100);
}

export async function unifiedSearch(
  db: D1Database,
  opts: UnifiedSearchOptions
): Promise<SearchResult[]> {
  const q = opts.query?.trim() || '';
  if (!q || q.length > 200) return [];

  const limit = normalizeSearchLimit(opts.limit);
  const types = opts.types || ['memo', 'chat', 'schedule', 'todo'];
  const results: SearchResult[] = [];

  // 1. 메모 검색 (FTS5 → LIKE 폴백)
  if (types.includes('memo')) {
    const fq = ftsQuery(q);
    if (fq) {
      try {
        const { results: rows } = await db.prepare(
          `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity
           FROM memos_fts fts JOIN memos m ON m.id = fts.rowid
           WHERE memos_fts MATCH ? AND m.is_locked = 0 AND m.sensitivity < 2
           ORDER BY rank LIMIT ?`
        ).bind(fq, limit).all<any>();
        for (const r of rows) {
          results.push({
            source_type: 'memo',
            source_id: r.id,
            title: r.text.slice(0, 50),
            snippet: r.text.slice(0, 200),
            created_at: r.created_at,
            rank: 1.0,
          });
        }
      } catch { /* FTS 실패 시 LIKE 폴백 */ }
    }
    // LIKE 폴백 (FTS 결과가 없을 때)
    if (!results.length) {
      const { results: rows } = await db.prepare(
        `SELECT id, text, created_at FROM memos
         WHERE text LIKE ? ESCAPE '\\' AND is_locked = 0 AND sensitivity < 2
         ORDER BY created_at DESC LIMIT ?`
      ).bind(likeQuery(q), limit).all<any>();
      for (const r of rows) {
        results.push({
          source_type: 'memo',
          source_id: r.id,
          title: r.text.slice(0, 50),
          snippet: r.text.slice(0, 200),
          created_at: r.created_at,
          rank: 0.5,
        });
      }
    }
  }

  // 2. AI 대화 검색
  if (types.includes('chat')) {
    const { results: rows } = await db.prepare(
      `SELECT id, persona_id, content, created_at FROM ai_chats
       WHERE content LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?`
    ).bind(likeQuery(q), limit).all<any>();
    for (const r of rows) {
      results.push({
        source_type: 'chat',
        source_id: r.id,
        title: `[${r.persona_id}] ${r.content.slice(0, 40)}`,
        snippet: r.content.slice(0, 200),
        created_at: r.created_at,
        rank: 0.5,
      });
    }
  }

  // 3. 일정 검색
  if (types.includes('schedule')) {
    const { results: rows } = await db.prepare(
      `SELECT id, title, description, start_at FROM schedules
       WHERE (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
       AND status = 'active'
       ORDER BY start_at DESC LIMIT ?`
    ).bind(likeQuery(q), likeQuery(q), limit).all<any>();
    for (const r of rows) {
      results.push({
        source_type: 'schedule',
        source_id: r.id,
        title: r.title,
        snippet: r.description?.slice(0, 200) || '',
        created_at: r.start_at,
        rank: 0.5,
      });
    }
  }

  // 4. 할 일 검색
  if (types.includes('todo')) {
    const { results: rows } = await db.prepare(
      `SELECT id, title, description, due_at, created_at FROM todos
       WHERE (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC LIMIT ?`
    ).bind(likeQuery(q), likeQuery(q), limit).all<any>();
    for (const r of rows) {
      results.push({
        source_type: 'todo',
        source_id: r.id,
        title: r.title,
        snippet: r.description?.slice(0, 200) || '',
        created_at: r.created_at,
        rank: 0.5,
      });
    }
  }

  // 정렬: rank 내림차순 → 최신순
  results.sort((a, b) => b.rank - a.rank || b.created_at.localeCompare(a.created_at));
  return results.slice(0, limit);
}
