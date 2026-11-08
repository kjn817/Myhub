/**
 * 메모 첨부 파일 라우트 — 파인더 표면(전체 파일·휴지통)과 메모별 첨부
 * 목록·업로드·다운로드·삭제. 잠긴 첨부의 삭제는 보호 게이트를 거친다.
 */

import type { Hono } from 'hono'
import type { Env } from '../../types'
import { storageDestroy, storageUpload, thumbUrl } from '../../services/storage'
import { emit } from '../../events'
import { requireProtectedAccess, saveFiles } from './helpers'

/** 파인더가 메모 첨부를 보관함처럼 다루는 표면 */
export function registerMemoFinderRoutes(memoApp: Hono<{ Bindings: Env }>): void {
  memoApp.get('/files', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT f.id, f.memo_id, f.filename, f.mime, f.size, f.url, f.is_locked, f.created_at,
              SUBSTR(m.text, 1, 120) AS memo_text
         FROM files f JOIN memos m ON m.id = f.memo_id
        WHERE f.deleted_at IS NULL AND f.url IS NOT NULL
        ORDER BY f.id DESC LIMIT 200`
    ).all<any>()
    return c.json(
      results.map((f) => ({
        id: f.id,
        memo_id: f.memo_id,
        memo_text: f.memo_text,
        filename: f.filename,
        mime: f.mime,
        size: f.size,
        is_locked: !!f.is_locked,
        url: f.url,
        created_at: f.created_at,
      }))
    )
  })

  memoApp.get('/files/trash', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT f.id, f.memo_id, f.filename, f.mime, f.size, f.url, f.is_locked, f.created_at, f.deleted_at,
              SUBSTR(m.text, 1, 120) AS memo_text
         FROM files f JOIN memos m ON m.id = f.memo_id
        WHERE f.deleted_at IS NOT NULL
        ORDER BY f.deleted_at DESC LIMIT 200`
    ).all<any>()
    return c.json(
      results.map((f) => ({
        id: f.id,
        memo_id: f.memo_id,
        memo_text: f.memo_text,
        filename: f.filename,
        mime: f.mime,
        size: f.size,
        is_locked: !!f.is_locked,
        url: f.url,
        created_at: f.created_at,
        deleted_at: f.deleted_at,
      }))
    )
  })

  memoApp.post('/files/:fileId/trash', async (c) => {
    const fileId = c.req.param('fileId')
    const row = await c.env.DB.prepare('SELECT is_locked, deleted_at FROM files WHERE id = ?').bind(fileId).first<any>()
    if (!row) return c.json({ ok: false, error: 'not found' }, 404)
    if (row.is_locked) return c.json({ ok: false, error: 'LOCKED' }, 403)
    if (row.deleted_at) return c.json({ ok: true, already: true })
    await c.env.DB.prepare("UPDATE files SET deleted_at = datetime('now') WHERE id = ?").bind(fileId).run()
    await c.env.KV.delete('system:stats').catch(() => {})
    return c.json({ ok: true })
  })

  memoApp.post('/files/:fileId/restore', async (c) => {
    const fileId = c.req.param('fileId')
    const row = await c.env.DB.prepare('SELECT deleted_at FROM files WHERE id = ?').bind(fileId).first<any>()
    if (!row) return c.json({ ok: false, error: 'not found' }, 404)
    if (!row.deleted_at) return c.json({ ok: true, already: true })
    await c.env.DB.prepare('UPDATE files SET deleted_at = NULL WHERE id = ?').bind(fileId).run()
    await c.env.KV.delete('system:stats').catch(() => {})
    return c.json({ ok: true })
  })
}

/** 메모 단위 첨부 라우트 */
export function registerMemoFileRoutes(memoApp: Hono<{ Bindings: Env }>): void {
  memoApp.get('/:id/files', async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT id, memo_id, storage_key, filename, mime, size, url, resource_type, created_at, is_locked FROM files WHERE memo_id = ? AND url IS NOT NULL AND deleted_at IS NULL ORDER BY id'
    ).bind(c.req.param('id')).all<any>()
    return c.json(
      results.map((f) => ({
        id: f.id,
        memo_id: f.memo_id,
        filename: f.filename,
        mime: f.mime,
        size: f.size,
        is_locked: !!f.is_locked,
        url: f.url,
        thumb: f.mime?.startsWith('image/') && f.url ? thumbUrl(c.env.CLOUDINARY_CLOUD_NAME, f.storage_key) : null,
        created_at: f.created_at,
      }))
    )
  })

  memoApp.post('/:id/files', async (c) => {
    const memoId = Number(c.req.param('id'))
    const body = await c.req.parseBody()
    const f = body['files']
    const arr = Array.isArray(f) ? f : f ? [f] : []
    const uploadFiles = arr.filter((x): x is File => x instanceof File)
    if (!uploadFiles.length) return c.json({ error: 'empty' }, 400)
    const MAX_SIZE = 10 * 1024 * 1024
    for (const uf of uploadFiles) {
      if (uf.size > MAX_SIZE) {
        return c.json({ ok: false, error: `"${uf.name}"은 10MB를 초과해서 업로드할 수 없어요` }, 400)
      }
    }
    try {
      const saved = await saveFiles(c.env, memoId, uploadFiles)
      await c.env.KV.delete('system:stats').catch(() => {})
      return c.json({ ok: true, files: saved })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  memoApp.get('/files/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    const { results } = await c.env.DB.prepare('SELECT url, is_locked FROM files WHERE id = ? AND deleted_at IS NULL').bind(fileId).all<any>()
    const row = results[0]
    if (!row?.url) return c.json({ error: 'not found' }, 404)
    if (row.is_locked) {
      return new Response(null, {
        status: 302,
        headers: { Location: `/api/memo/files/${fileId}/content` },
      })
    }
    return Response.redirect(row.url, 302)
  })

  memoApp.delete('/files/:fileId', async (c) => {
    const fileId = c.req.param('fileId')
    const { results } = await c.env.DB.prepare(
      'SELECT storage_key, resource_type, is_locked FROM files WHERE id = ? AND url IS NOT NULL'
    ).bind(fileId).all<any>()
    const row = results[0]
    if (!row) return c.json({ error: 'not found' }, 404)
    if (row.is_locked) {
      const gate = await requireProtectedAccess(c)
      if (!gate.ok) return c.json(gate.body, gate.status as any)
    }
    await storageDestroy(c.env, row.storage_key, row.resource_type)
    await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run()
    await c.env.KV.delete('system:stats').catch(() => {})
    await emit('memo.deleted', { id: Number(fileId) })
    return c.json({ ok: true })
  })
}
