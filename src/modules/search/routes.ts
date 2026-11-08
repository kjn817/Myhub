import { Hono } from 'hono'
import type { Env } from '../../types'
import { normalizeSearchLimit } from '../../lib/search-limit'
import { unifiedSearch } from '../../services/unified-search'

export { normalizeSearchLimit } from '../../lib/search-limit'

// Phase 4B: 통합 검색 모듈
// 메모·대화·일정·할 일을 권한 검사 후 통합 검색

export const searchApp = new Hono<{ Bindings: Env }>()

searchApp.get('/', async (c) => {
  const q = c.req.query('q')?.trim() || ''
  if (!q) {
    return c.json({ ok: false, error: 'query required' }, 400)
  }
  if (q.length > 200) {
    return c.json({ ok: false, error: 'query too long' }, 400)
  }

  const raw = c.req.query('limit');
  const limit = normalizeSearchLimit(raw);
  const typesParam = c.req.query('types')?.trim() || ''
  const types = typesParam
    ? typesParam.split(',').filter((t): t is 'memo'|'chat'|'schedule'|'todo' =>
        ['memo', 'chat', 'schedule', 'todo'].includes(t))
    : undefined

  try {
    const results = await unifiedSearch(c.env.DB, { query: q, limit, types })
    return c.json({ ok: true, results, count: results.length })
  } catch (e) {
    return c.json({ ok: false, error: 'search failed' }, 500)
  }
})
