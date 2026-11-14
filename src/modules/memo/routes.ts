/**
 * 메모 모듈 v3: 검색(FTS5) + 파일 첨부(Cloudinary)
 * 파일 본체는 공용 스토리지 서비스(src/services/storage.ts)에, 메타데이터만 D1에 저장.
 * 잠금·파일·AI 보조 라우트는 routes-lock·routes-files·routes-ai로 분리돼 있다.
 */

import { Hono } from 'hono'
import { encryptContent, decryptContent, isEncrypted } from '../../services/crypto'
import type { Env } from '../../types'
import { storageDestroy, storageUpload } from '../../services/storage'
import { emit } from '../../events'
import { kstDayToUtcRange } from '../../lib/kst-date'
import {
  extractMemoTitle,
  syncTags,
  saveFiles,
  ftsQuery,
  trigramQuery,
  isShortQuery,
  hasProtectedAccess,
  requireProtectedAccess,
} from './helpers'
import { registerMemoLockRoutes } from './routes-lock'
import { registerMemoFinderRoutes, registerMemoFileRoutes } from './routes-files'
import { registerMemoAiRoutes } from './routes-ai'

export { hasConfiguredPin, requireProtectedAccess, trigramQuery } from './helpers'

export const memoApp = new Hono<{ Bindings: Env }>()

interface MemoRow {
  id: number
  text: string
  created_at: string
  is_locked?: number
  sensitivity?: number
  title_hint?: string | null
  file_count: number
  /** 보호 게이트로 본문이 비워진 행 표시 (프론트가 상세 열람 시 step-up 흐름을 타게 한다) */
  body_protected?: number
  [key: string]: unknown
}

// 대시보드 위젯용 통계
memoApp.get('/tags', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT tag, COUNT(*) AS n FROM memo_tags GROUP BY tag ORDER BY n DESC, tag'
  ).all()
  return c.json(results)
})

memoApp.get('/calendar', async (c) => {
  const now = new Date()
  const y = Number(c.req.query('y')) || now.getFullYear()
  const m = Number(c.req.query('m')) || now.getMonth() + 1
  const mm = String(m).padStart(2, '0')
  const endM = m === 12 ? 1 : m + 1
  const endY = m === 12 ? y + 1 : y
  const start = `${y}-${mm}-01`
  const end = `${endY}-${String(endM).padStart(2, '0')}-01`
  const startUtc = kstDayToUtcRange(start)?.[0] ?? start
  const endUtc = kstDayToUtcRange(end)?.[0] ?? end
  const { results } = await c.env.DB.prepare(
    `SELECT date(created_at, '+9 hours') AS day, COUNT(*) AS n FROM memos
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`
  ).bind(startUtc, endUtc).all()
  return c.json(results)
})

memoApp.get('/', async (c) => {
  const q = c.req.query('q')?.trim() || ''
  const tag = c.req.query('tag')?.trim() || ''
  const date = c.req.query('date')?.trim() || ''
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit'))) || 50, 1), 200)
  const offset = Math.max(Math.floor(Number(c.req.query('offset'))) || 0, 0)
  const fileCountJoin = 'LEFT JOIN (SELECT memo_id, COUNT(*) AS n FROM files WHERE deleted_at IS NULL GROUP BY memo_id) fc ON fc.memo_id = m.id'
  const fileCountSelect = 'COALESCE(fc.n, 0) AS file_count'
  let join = ''
  const conds: string[] = []
  const params: unknown[] = []
  if (tag) {
    join += ' JOIN memo_tags t ON t.memo_id = m.id'
    conds.push('t.tag = ?')
    params.push(tag)
  }
  if (date) {
    const range = kstDayToUtcRange(date)
    if (range) {
      conds.push('m.created_at >= ? AND m.created_at < ?')
      params.push(range[0], range[1])
    } else {
      conds.push('1 = 0')
    }
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  let protectedOkCache: boolean | null = null
  const protectedOk = async (): Promise<boolean> => {
    if (protectedOkCache === null) protectedOkCache = await hasProtectedAccess(c)
    return protectedOkCache
  }
  const applyBodyGate = async (r: MemoRow): Promise<void> => {
    if (r.is_locked && isEncrypted(r.text)) {
      if (!(await protectedOk())) {
        r.text = r.title_hint || ''
        r.body_protected = 1
        return
      }
      try {
        r.text = await decryptContent(c.env, r.text)
      } catch {
        r.text = '[복호화 실패]'
      }
    }
  }
  if (q) {
    const out: MemoRow[] = []
    const seen = new Set<number>()
    const pushDecrypted = async (rows: MemoRow[]) => {
      for (const r of rows) {
        await applyBodyGate(r)
        out.push(r)
        seen.add(r.id)
      }
    }
    const pushRaw = pushDecrypted
    const notIn = () => (seen.size ? ` AND m.id NOT IN (${[...seen].map(() => '?').join(',')})` : '')
    const fq = ftsQuery(q)
    if (fq) {
      try {
        const { results } = await c.env.DB.prepare(
          `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, m.title_hint, ${fileCountSelect}
           FROM memos_fts fts JOIN memos m ON m.id = fts.rowid ${join} ${fileCountJoin}
           WHERE memos_fts MATCH ? ${where ? 'AND ' + conds.join(' AND ') : ''}
           ORDER BY rank LIMIT ? OFFSET ?`
        ).bind(fq, ...params, limit, offset).all<MemoRow>()
        await pushDecrypted(results)
      } catch {
        // FTS 실패 시 아래 폴백들이 담당
      }
    }
    const tq = trigramQuery(q)
    let trigramOk = false
    if (out.length < limit && tq) {
      try {
        const { results } = await c.env.DB.prepare(
          `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, m.title_hint, ${fileCountSelect}
           FROM memos_fts_tri tri JOIN memos m ON m.id = tri.rowid ${join} ${fileCountJoin}
           WHERE memos_fts_tri MATCH ? ${where ? 'AND ' + conds.join(' AND ') : ''}${notIn()}
           ORDER BY m.id DESC LIMIT ? OFFSET ?`
        ).bind(tq, ...params, ...[...seen], limit - out.length, offset).all<MemoRow>()
        trigramOk = true
        await pushRaw(results)
      } catch {
        // trigram 실패 시 LIKE 폴백이 담당
      }
    }
    if (out.length < limit) {
      const { results } = await c.env.DB.prepare(
        `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, m.title_hint, ${fileCountSelect}
         FROM memos m ${join} ${fileCountJoin}
         WHERE m.id IN (SELECT memo_id FROM files WHERE filename LIKE ? AND deleted_at IS NULL)
           AND m.is_locked = 0 AND m.sensitivity < 2
           ${where ? 'AND ' + conds.join(' AND ') : ''}${notIn()}
         ORDER BY m.id DESC LIMIT ? OFFSET ?`
      ).bind(`%${q}%`, ...params, ...[...seen], limit - out.length, offset).all<MemoRow>()
      await pushRaw(results)
    }
    if (out.length < limit && (isShortQuery(q) || !trigramOk)) {
      const nospace = q.replace(/\s+/g, '')
      const likeConds = [
        ...conds,
        'm.is_locked = 0',
        'm.sensitivity < 2',
        `(m.text LIKE ? OR REPLACE(m.text, ' ', '') LIKE ?)`,
      ]
      if (seen.size) likeConds.push(`m.id NOT IN (${[...seen].map(() => '?').join(',')})`)
      const { results } = await c.env.DB.prepare(
        `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, m.title_hint, ${fileCountSelect}
         FROM memos m ${join} ${fileCountJoin} WHERE ${likeConds.join(' AND ')}
         ORDER BY m.id DESC LIMIT ? OFFSET ?`
      ).bind(...params, `%${q}%`, `%${nospace}%`, ...[...seen], limit - out.length, offset).all<MemoRow>()
      await pushRaw(results)
    }
    return c.json(out)
  }
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, m.title_hint, ${fileCountSelect}
     FROM memos m ${join} ${fileCountJoin} ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<MemoRow>()
  for (const r of results) {
    await applyBodyGate(r)
  }
  return c.json(results)
})

memoApp.post('/', async (c) => {
  const contentType = c.req.header('content-type') || ''
  let text = ''
  let uploadFiles: File[] = []
  if (contentType.includes('multipart/form-data')) {
    // all: 같은 'files' 필드의 다중 파일을 배열로 받아야 한다 — 기본 파싱은
    // 마지막 값만 남겨 먼저 온 파일이 조용히 버려진다 (routes-files와 동일 결함).
    const body = await c.req.parseBody({ all: true })
    // text는 스칼라 필드: 중복 전송(계약 밖) 시 배열이 되므로 첫 값으로 정규화한다.
    const rawText = body['text']
    text = String((Array.isArray(rawText) ? rawText[0] : rawText) ?? '')
    const f = body['files']
    const arr = Array.isArray(f) ? f : f ? [f] : []
    uploadFiles = arr.filter((x): x is File => x instanceof File)
  } else {
    const json = await c.req.json().catch(() => ({})) as any
    text = json.text ?? ''
  }
  if (!text.trim() && !uploadFiles.length) return c.json({ error: 'empty' }, 400)
  const r = await c.env.DB.prepare('INSERT INTO memos (text) VALUES (?)').bind(text.trim()).run()
  const memoId = Number(r.meta.last_row_id)
  await syncTags(c.env.DB, memoId, text.trim())
  const saved = await saveFiles(c.env, memoId, uploadFiles)
  await emit('memo.created', { id: memoId })
  return c.json({ ok: true, id: memoId, files: saved })
})

registerMemoFinderRoutes(memoApp)
registerMemoAiRoutes(memoApp)

memoApp.get('/:id', async (c) => {
  const idParam = c.req.param('id')
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ ok: false, error: 'INVALID_ID' }, 400)
  }
  try {
    const memo = await c.env.DB.prepare(
      'SELECT id, text, created_at, is_locked, sensitivity, title_hint FROM memos WHERE id = ?'
    ).bind(id).first<any>()
    if (!memo) {
      return c.json({ ok: false, error: 'NOT_FOUND' }, 404)
    }
    if (memo.is_locked) {
      const gate = await requireProtectedAccess(c)
      if (!gate.ok) return c.json(gate.body, gate.status as any)
    }
    let ownerText: string = memo.text
    if (memo.is_locked && isEncrypted(memo.text)) {
      try {
        ownerText = await decryptContent(c.env, memo.text)
        if (!memo.title_hint) {
          const hint = extractMemoTitle(ownerText)
          if (hint) {
            c.env.DB.prepare('UPDATE memos SET title_hint = ? WHERE id = ? AND title_hint IS NULL')
              .bind(hint, memo.id).run().catch(() => {})
          }
        }
      } catch {
        ownerText = '[복호화 실패]'
      }
    }
    return c.json({
      ok: true,
      memo: {
        id: memo.id,
        text: ownerText,
        content: ownerText, // 하위 호환
        is_locked: memo.is_locked ? 1 : 0,
        created_at: memo.created_at,
        updated_at: memo.updated_at ?? null,
      },
    })
  } catch (e) {
    return c.json({ ok: false, error: 'DB_ERROR' }, 500)
  }
})

memoApp.put('/:id', async (c) => {
  const id = c.req.param('id')
  const json = await c.req.json().catch(() => ({})) as any
  const text = (json.text ?? '').trim()
  if (!text) return c.json({ error: 'empty' }, 400)
  const existing = await c.env.DB.prepare('SELECT is_locked FROM memos WHERE id = ?').bind(id).first<{ is_locked: number }>()
  if (existing?.is_locked) {
    const gate = await requireProtectedAccess(c)
    if (!gate.ok) return c.json(gate.body, gate.status as any)
  }
  let storedText = text
  if (existing?.is_locked) {
    try {
      storedText = await encryptContent(c.env, text)
    } catch (e) {
      console.error('Memo update encryption failed:', e)
      return c.json({ error: 'encrypt_failed' }, 500)
    }
    await c.env.DB.prepare('UPDATE memos SET text = ?, title_hint = ? WHERE id = ?')
      .bind(storedText, extractMemoTitle(text) || null, id).run()
  } else {
    await c.env.DB.prepare('UPDATE memos SET text = ? WHERE id = ?').bind(storedText, id).run()
  }
  await syncTags(c.env.DB, Number(id), text)
  await emit('memo.updated', { id: Number(id) })
  return c.json({ ok: true })
})

registerMemoLockRoutes(memoApp)

// 메모 민감도 설정
memoApp.post('/:id/sensitivity', async (c) => {
  const id = c.req.param('id')
  const json = await c.req.json().catch(() => ({})) as any
  const s = Math.max(0, Math.min(3, json.sensitivity ?? 1))
  await c.env.DB.prepare('UPDATE memos SET sensitivity = ? WHERE id = ?').bind(s, id).run()
  return c.json({ ok: true, sensitivity: s })
})

memoApp.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const memoRow = await c.env.DB.prepare('SELECT is_locked FROM memos WHERE id = ?').bind(id).first<{ is_locked: number }>()
  if (memoRow?.is_locked) {
    const gate = await requireProtectedAccess(c)
    if (!gate.ok) return c.json(gate.body, gate.status as any)
  }
  const { results } = await c.env.DB.prepare(
    'SELECT storage_key, resource_type FROM files WHERE memo_id = ? AND url IS NOT NULL'
  ).bind(id).all<{ storage_key: string; resource_type: string }>()
  await Promise.all(results.map((r) => storageDestroy(c.env, r.storage_key, r.resource_type)))
  await c.env.DB.prepare('DELETE FROM files WHERE memo_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM memo_tags WHERE memo_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM memos WHERE id = ?').bind(id).run()
  await c.env.KV.delete('system:stats').catch(() => {})
  await emit('memo.deleted', { id: Number(id) })
  return c.json({ ok: true })
})

registerMemoFileRoutes(memoApp)
