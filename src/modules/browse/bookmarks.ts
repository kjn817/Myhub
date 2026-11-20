/**
 * 브라우저 북마크·방문 기록 (src/modules/browse/bookmarks.ts).
 *
 * 브라우저 1단계 (2026-11-20): 즐겨찾기 6개 하드코딩과 최근 방문 6개
 * (localStorage)를 D1으로 옮겨 기기 간 동기·장기 보존을 한다.
 * 스키마는 마이그레이션 0080 (browser_bookmarks·browser_history).
 *
 * 인증: 전역 /api/* 미들웨어가 세션을 검사한다 (downloads.ts의
 * ORIGIN_SECRET 경로와 달리 이 라우트들은 allowlist에 없으므로
 * 세션 쿠키가 필수다). 라우트 단위 인증은 두지 않는다.
 *
 * 북마크: URL UNIQUE. GET이 비어 있으면 기존 하드코딩 6개를 pinned
 * 시드로 넣어 반환한다 (INSERT OR IGNORE — 동시 GET 경합에도 안전).
 * POST 중복 URL은 에러가 아니라 기존 행을 반환한다.
 *
 * 방문 기록: URL UNIQUE upsert — 재방문 시 visited_at만 갱신하고
 * 행을 늘리지 않는다. 삽입 뒤 1000개를 넘는 오래된 행을 지운다
 * (prune). 기록은 프론트가 fire-and-forget으로 보내므로 이 경로는
 * 동기 URL 검사만 한다 — DoH 조회는 이동 시 /navigate에서 이미
 * 했고, 방문마다 DoH를 부르면 기록이 느려진다.
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { validatePublicUrl, validatePublicUrlAsync } from './assistant-read'

/** 빈 테이블 시드 — 기존 하드코딩 즐겨찾기 6개와 동일하다. */
export const BOOKMARK_SEEDS: Array<{ url: string; title: string }> = [
  { url: 'https://www.naver.com', title: 'NAVER' },
  { url: 'https://www.google.com', title: 'Google' },
  { url: 'https://www.youtube.com', title: 'YouTube' },
  { url: 'https://chatgpt.com', title: 'ChatGPT' },
  { url: 'https://github.com', title: 'GitHub' },
  { url: 'https://ko.wikipedia.org', title: '위키백과' },
]

export const HISTORY_MAX_ROWS = 1000
export const HISTORY_DEFAULT_LIMIT = 100
export const HISTORY_MAX_LIMIT = 100
export const BOOKMARK_TITLE_MAX = 200

export interface BookmarkRow {
  id: number
  url: string
  title: string | null
  pinned: number
  position: number
  created_at: string
}

export interface HistoryRow {
  id: number
  url: string
  title: string | null
  visited_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function toBookmark(row: BookmarkRow) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    pinned: row.pinned === 1,
    position: row.position,
    created_at: row.created_at,
  }
}

async function listBookmarks(db: D1Database): Promise<BookmarkRow[]> {
  const r = await db
    .prepare(
      'SELECT id, url, title, pinned, position, created_at FROM browser_bookmarks ORDER BY pinned DESC, position ASC, id ASC',
    )
    .all<BookmarkRow>()
  return r.results ?? []
}

async function seedBookmarksIfEmpty(db: D1Database): Promise<void> {
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM browser_bookmarks')
    .first<{ n: number }>()
  if (count && count.n > 0) return
  const now = nowIso()
  for (let i = 0; i < BOOKMARK_SEEDS.length; i++) {
    const s = BOOKMARK_SEEDS[i]
    // POST 경로와 같은 정규화(new URL().toString())를 써야 시드와
    // 사용자 추가가 같은 URL로 인식돼 중복 행이 안 생긴다.
    let url = s.url
    try {
      url = new URL(s.url).toString()
    } catch {
      // 시드는 상수라 실패하지 않지만, 실패해도 원문으로 넣는다
    }
    await db
      .prepare(
        'INSERT OR IGNORE INTO browser_bookmarks (url, title, pinned, position, created_at) VALUES (?, ?, 1, ?, ?)',
      )
      .bind(url, s.title, i, now)
      .run()
  }
}

/** LIKE 와일드카드(%·_·\)를 이스케이프한다 — 검색어가 패턴이 되면 안 된다. */
export function escapeLike(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

async function pruneHistory(db: D1Database): Promise<void> {
  // visited_at 동점(같은 ms에 두 번 기록)은 id로 끊는다 — 결정적이어야
  // prune이 매번 같은 집합을 남긴다.
  await db
    .prepare(
      'DELETE FROM browser_history WHERE id NOT IN (SELECT id FROM browser_history ORDER BY visited_at DESC, id DESC LIMIT ?)',
    )
    .bind(HISTORY_MAX_ROWS)
    .run()
}

export function registerBookmarkRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/bookmarks', async (c) => {
    try {
      await seedBookmarksIfEmpty(c.env.DB)
      const rows = await listBookmarks(c.env.DB)
      return c.json({ ok: true, bookmarks: rows.map(toBookmark) })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  app.post('/bookmarks', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const b = body as { url?: unknown; title?: unknown; pinned?: unknown }
    const rawUrl = typeof b.url === 'string' ? b.url.trim() : ''
    if (!rawUrl) return c.json({ ok: false, error: 'invalid_url' }, 400)
    const checked = await validatePublicUrlAsync(rawUrl)
    if (!checked.ok) return c.json({ ok: false, error: checked.error }, 400)
    const url = checked.url
    const title =
      typeof b.title === 'string' && b.title.trim()
        ? b.title.trim().slice(0, BOOKMARK_TITLE_MAX)
        : null
    const pinned = b.pinned === true ? 1 : 0
    try {
      const existing = await c.env.DB.prepare(
        'SELECT id, url, title, pinned, position, created_at FROM browser_bookmarks WHERE url = ?',
      )
        .bind(url)
        .first<BookmarkRow>()
      if (existing) {
        return c.json({ ok: true, bookmark: toBookmark(existing), duplicate: true })
      }
      const maxPos = await c.env.DB.prepare(
        'SELECT COALESCE(MAX(position), -1) AS m FROM browser_bookmarks',
      ).first<{ m: number }>()
      const position = (maxPos?.m ?? -1) + 1
      try {
        const r = await c.env.DB.prepare(
          'INSERT INTO browser_bookmarks (url, title, pinned, position, created_at) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(url, title, pinned, position, nowIso())
          .run()
        const row = await c.env.DB.prepare(
          'SELECT id, url, title, pinned, position, created_at FROM browser_bookmarks WHERE id = ?',
        )
          .bind(Number(r.meta.last_row_id))
          .first<BookmarkRow>()
        if (!row) return c.json({ ok: false, error: 'insert_failed' }, 500)
        return c.json({ ok: true, bookmark: toBookmark(row) }, 201)
      } catch {
        // 경합으로 UNIQUE에 걸리면 기존 행을 돌려준다 (중복 POST와 동일).
        const raced = await c.env.DB.prepare(
          'SELECT id, url, title, pinned, position, created_at FROM browser_bookmarks WHERE url = ?',
        )
          .bind(url)
          .first<BookmarkRow>()
        if (raced) {
          return c.json({ ok: true, bookmark: toBookmark(raced), duplicate: true })
        }
        throw new Error('insert_failed')
      }
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  app.patch('/bookmarks/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ ok: false, error: 'invalid_id' }, 400)
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const b = body as { title?: unknown; pinned?: unknown; position?: unknown }
    const sets: string[] = []
    const values: unknown[] = []
    if (b.title !== undefined) {
      if (b.title !== null && typeof b.title !== 'string') {
        return c.json({ ok: false, error: 'invalid_title' }, 400)
      }
      const title =
        typeof b.title === 'string' && b.title.trim()
          ? b.title.trim().slice(0, BOOKMARK_TITLE_MAX)
          : null
      sets.push('title = ?')
      values.push(title)
    }
    if (b.pinned !== undefined) {
      if (typeof b.pinned !== 'boolean') {
        return c.json({ ok: false, error: 'invalid_pinned' }, 400)
      }
      sets.push('pinned = ?')
      values.push(b.pinned ? 1 : 0)
    }
    if (b.position !== undefined) {
      if (typeof b.position !== 'number' || !Number.isInteger(b.position) || b.position < 0) {
        return c.json({ ok: false, error: 'invalid_position' }, 400)
      }
      sets.push('position = ?')
      values.push(b.position)
    }
    if (sets.length === 0) {
      return c.json({ ok: false, error: 'nothing_to_update' }, 400)
    }
    try {
      const existing = await c.env.DB.prepare(
        'SELECT id FROM browser_bookmarks WHERE id = ?',
      )
        .bind(id)
        .first<{ id: number }>()
      if (!existing) return c.json({ ok: false, error: 'not_found' }, 404)
      values.push(id)
      await c.env.DB.prepare(
        `UPDATE browser_bookmarks SET ${sets.join(', ')} WHERE id = ?`,
      )
        .bind(...values)
        .run()
      const row = await c.env.DB.prepare(
        'SELECT id, url, title, pinned, position, created_at FROM browser_bookmarks WHERE id = ?',
      )
        .bind(id)
        .first<BookmarkRow>()
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404)
      return c.json({ ok: true, bookmark: toBookmark(row) })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  app.delete('/bookmarks/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ ok: false, error: 'invalid_id' }, 400)
    }
    try {
      const r = await c.env.DB.prepare('DELETE FROM browser_bookmarks WHERE id = ?')
        .bind(id)
        .run()
      if ((r.meta.changes ?? 0) === 0) {
        return c.json({ ok: false, error: 'not_found' }, 404)
      }
      return c.json({ ok: true, deleted: id })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  app.get('/history', async (c) => {
    const qRaw = c.req.query('q') ?? ''
    const q = qRaw.trim()
    const limitRaw = Number(c.req.query('limit'))
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(HISTORY_MAX_LIMIT, Math.floor(limitRaw)))
      : HISTORY_DEFAULT_LIMIT
    try {
      let rows: HistoryRow[]
      if (q) {
        const like = `%${escapeLike(q)}%`
        const r = await c.env.DB.prepare(
          "SELECT id, url, title, visited_at FROM browser_history WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY visited_at DESC, id DESC LIMIT ?",
        )
          .bind(like, like, limit)
          .all<HistoryRow>()
        rows = r.results ?? []
      } else {
        const r = await c.env.DB.prepare(
          'SELECT id, url, title, visited_at FROM browser_history ORDER BY visited_at DESC, id DESC LIMIT ?',
        )
          .bind(limit)
          .all<HistoryRow>()
        rows = r.results ?? []
      }
      return c.json({ ok: true, history: rows })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  app.post('/history', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const b = body as { url?: unknown; title?: unknown }
    const rawUrl = typeof b.url === 'string' ? b.url.trim() : ''
    // 동기 검사만 한다 — DoH는 이동 시 /navigate에서 이미 했고,
    // 방문마다 조회하면 fire-and-forget 기록이 느려진다.
    const checked = validatePublicUrl(rawUrl)
    if (!checked.ok) return c.json({ ok: false, error: checked.error }, 400)
    const title =
      typeof b.title === 'string' && b.title.trim()
        ? b.title.trim().slice(0, BOOKMARK_TITLE_MAX)
        : null
    try {
      const r = await c.env.DB.prepare(
        'INSERT INTO browser_history (url, title, visited_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET title = COALESCE(excluded.title, browser_history.title), visited_at = excluded.visited_at',
      )
        .bind(checked.url, title, nowIso())
        .run()
      await pruneHistory(c.env.DB)
      const row = await c.env.DB.prepare(
        'SELECT id, url, title, visited_at FROM browser_history WHERE url = ?',
      )
        .bind(checked.url)
        .first<HistoryRow>()
      if (!row) return c.json({ ok: false, error: 'insert_failed' }, 500)
      return c.json({ ok: true, history: row, upserted: (r.meta.changes ?? 0) > 0 })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  app.delete('/history', async (c) => {
    try {
      const r = await c.env.DB.prepare('DELETE FROM browser_history').run()
      return c.json({ ok: true, deleted: r.meta.changes ?? 0 })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })
}
