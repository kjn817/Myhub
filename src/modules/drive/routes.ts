/**
 * 파인더(파일 보관함) API — 폴더·파일 CRUD, 휴지통, 전역 검색.
 * 1세그먼트 정적 경로(/list·/recent·/search·/usage·/trash)는 파라미터
 * 경로보다 먼저 등록한다 (D-22 라우팅 순서).
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import { storageUpload, storageDestroy } from '../../services/storage'
import { searchDriveItems } from './search'

export const driveApp = new Hono<{ Bindings: Env }>()

const MAX_SIZE = 10 * 1024 * 1024

interface DriveFileRow {
  id: number
  folder_id: number | null
  storage_key: string
  filename: string
  mime: string | null
  size: number
  url: string | null
  resource_type: string
  created_at: string
  deleted_at: string | null
  [key: string]: unknown
}

interface DriveFolderRow {
  id: number
  name: string
  parent_id: number | null
  created_at: string
  deleted_at: string | null
}

function fileView(f: DriveFileRow) {
  return {
    id: f.id,
    folder_id: f.folder_id,
    filename: f.filename,
    mime: f.mime,
    size: f.size,
    url: f.url,
    created_at: f.created_at,
    deleted_at: f.deleted_at ?? null,
    // 낙관적 동시성 표식 (D3): storage_key는 저장할 때마다 새 실물로
    // 교체되므로 그 자체가 버전이다. 클라이언트는 PUT 때 base_version으로
    // 되돌려 보내고, 서버는 현재 값과 다르면 409로 거부한다.
    version: f.storage_key,
  }
}

async function getFolder(db: D1Database, id: number): Promise<DriveFolderRow | null> {
  return db.prepare('SELECT id, name, parent_id, created_at, deleted_at FROM drive_folders WHERE id = ?').bind(id).first<DriveFolderRow>()
}

driveApp.get('/list', async (c) => {
  const raw = c.req.query('folder')
  const folderId = raw === undefined || raw === '' || raw === 'root' ? null : Number(raw)
  if (folderId !== null && (!Number.isInteger(folderId) || folderId <= 0)) {
    return c.json({ ok: false, error: 'bad folder' }, 400)
  }
  let current: DriveFolderRow | null = null
  if (folderId !== null) {
    current = await getFolder(c.env.DB, folderId)
    if (!current || current.deleted_at) return c.json({ ok: false, error: 'folder not found' }, 404)
  }
  const folderSql = folderId === null
    ? 'SELECT id, name, parent_id, created_at FROM drive_folders WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY name'
    : 'SELECT id, name, parent_id, created_at FROM drive_folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY name'
  const fileSql = folderId === null
    ? 'SELECT * FROM drive_files WHERE folder_id IS NULL AND deleted_at IS NULL ORDER BY id DESC'
    : 'SELECT * FROM drive_files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY id DESC'
  const folders = folderId === null
    ? (await c.env.DB.prepare(folderSql).all<DriveFolderRow>()).results
    : (await c.env.DB.prepare(folderSql).bind(folderId).all<DriveFolderRow>()).results
  const files = folderId === null
    ? (await c.env.DB.prepare(fileSql).all<DriveFileRow>()).results
    : (await c.env.DB.prepare(fileSql).bind(folderId).all<DriveFileRow>()).results
  return c.json({
    ok: true,
    folder: current ? { id: current.id, name: current.name, parent_id: current.parent_id } : null,
    folders: folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parent_id, created_at: f.created_at })),
    files: files.map(fileView),
  })
})

driveApp.get('/recent', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.*, fo.name AS folder_name FROM drive_files f
     LEFT JOIN drive_folders fo ON fo.id = f.folder_id
     WHERE f.deleted_at IS NULL ORDER BY f.id DESC LIMIT 50`
  ).all<DriveFileRow & { folder_name: string | null }>()
  return c.json({
    ok: true,
    files: results.map((f) => ({ ...fileView(f), folder_name: f.folder_name ?? null })),
  })
})

driveApp.get('/search', async (c) => {
  const q = String(c.req.query('q') || '').trim()
  if (!q) return c.json({ ok: false, error: 'query required' }, 400)
  const rawLimit = Number(c.req.query('limit'))
  const res = await searchDriveItems(c.env.DB, q, Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined)
  return c.json({
    ok: true,
    query: res.query,
    total: res.total,
    truncated: res.truncated,
    folders: res.folders,
    files: res.files.map((f) => ({
      id: f.id,
      folder_id: f.folder_id,
      filename: f.filename,
      mime: f.mime,
      size: f.size,
      url: f.url,
      created_at: f.created_at,
      deleted_at: null,
      version: f.version,
      folder_name: f.folder_name,
      path: f.path,
    })),
  })
})

driveApp.get('/usage', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM drive_files WHERE deleted_at IS NULL'
  ).first<{ n: number; s: number }>()
  return c.json({ ok: true, files: row?.n ?? 0, bytes: row?.s ?? 0 })
})

driveApp.post('/folders', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const name = String(body.name || '').trim()
  if (!name) return c.json({ ok: false, error: 'name required' }, 400)
  const parentId = body.parent_id === undefined || body.parent_id === null ? null : Number(body.parent_id)
  if (parentId !== null) {
    const parent = await getFolder(c.env.DB, parentId)
    if (!parent || parent.deleted_at) return c.json({ ok: false, error: 'parent not found' }, 404)
  }
  const r = await c.env.DB.prepare('INSERT INTO drive_folders (name, parent_id) VALUES (?, ?)').bind(name, parentId).run()
  return c.json({ ok: true, id: Number(r.meta.last_row_id) })
})

driveApp.post('/folders/:id/rename', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({})) as any
  const name = String(body.name || '').trim()
  if (!name) return c.json({ ok: false, error: 'name required' }, 400)
  const folder = await getFolder(c.env.DB, id)
  if (!folder || folder.deleted_at) return c.json({ ok: false, error: 'folder not found' }, 404)
  await c.env.DB.prepare('UPDATE drive_folders SET name = ? WHERE id = ?').bind(name, id).run()
  return c.json({ ok: true })
})

driveApp.post('/folders/:id/trash', async (c) => {
  const id = Number(c.req.param('id'))
  const folder = await getFolder(c.env.DB, id)
  if (!folder) return c.json({ ok: false, error: 'folder not found' }, 404)
  if (folder.deleted_at) return c.json({ ok: true, already: true })
  await c.env.DB.prepare("UPDATE drive_folders SET deleted_at = datetime('now') WHERE id = ?").bind(id).run()
  return c.json({ ok: true })
})

driveApp.post('/folders/:id/restore', async (c) => {
  const id = Number(c.req.param('id'))
  const folder = await getFolder(c.env.DB, id)
  if (!folder) return c.json({ ok: false, error: 'folder not found' }, 404)
  if (!folder.deleted_at) return c.json({ ok: true, already: true })
  await c.env.DB.prepare('UPDATE drive_folders SET deleted_at = NULL WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

async function collectFolderIds(db: D1Database, rootId: number): Promise<number[]> {
  const ids = [rootId]
  let frontier = [rootId]
  while (frontier.length) {
    const ph = frontier.map(() => '?').join(',')
    const { results } = await db.prepare(`SELECT id FROM drive_folders WHERE parent_id IN (${ph})`).bind(...frontier).all<{ id: number }>()
    const next = results.map((r) => r.id).filter((id) => !ids.includes(id))
    if (!next.length) break
    ids.push(...next)
    frontier = next
  }
  return ids
}

driveApp.delete('/folders/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const folder = await getFolder(c.env.DB, id)
  if (!folder) return c.json({ ok: false, error: 'folder not found' }, 404)
  const ids = await collectFolderIds(c.env.DB, id)
  const ph = ids.map(() => '?').join(',')
  const { results: files } = await c.env.DB.prepare(
    `SELECT storage_key, resource_type FROM drive_files WHERE folder_id IN (${ph})`
  ).bind(...ids).all<{ storage_key: string; resource_type: string }>()
  for (const f of files) {
    await storageDestroy(c.env, f.storage_key, f.resource_type)
  }
  await c.env.DB.prepare(`DELETE FROM drive_files WHERE folder_id IN (${ph})`).bind(...ids).run()
  await c.env.DB.prepare(`DELETE FROM drive_folders WHERE id IN (${ph})`).bind(...ids).run()
  await c.env.KV.delete('system:stats').catch(() => {})
  return c.json({ ok: true, files: files.length, folders: ids.length })
})

driveApp.post('/files', async (c) => {
  // all: 같은 'files' 필드의 다중 파일을 배열로 받아야 한다 — 기본 파싱은
  // 마지막 값만 남겨 먼저 온 파일이 조용히 버려진다 (메모 첨부와 동일 결함).
  const body = await c.req.parseBody({ all: true })
  // folder_id는 스칼라 필드: 중복 전송(계약 밖) 시 배열이 되므로 첫 값으로 정규화한다.
  const rawFolderField = body['folder_id']
  const rawFolder = Array.isArray(rawFolderField) ? rawFolderField[0] : rawFolderField
  const folderId = rawFolder === undefined || rawFolder === '' || rawFolder === 'root' ? null : Number(rawFolder)
  if (folderId !== null) {
    if (!Number.isInteger(folderId) || folderId <= 0) return c.json({ ok: false, error: 'bad folder' }, 400)
    const folder = await getFolder(c.env.DB, folderId)
    if (!folder || folder.deleted_at) return c.json({ ok: false, error: 'folder not found' }, 404)
  }
  const f = body['files']
  const arr = Array.isArray(f) ? f : f ? [f] : []
  const uploadFiles = arr.filter((x): x is File => x instanceof File)
  if (!uploadFiles.length) return c.json({ ok: false, error: 'empty' }, 400)
  for (const uf of uploadFiles) {
    if (uf.size > MAX_SIZE) {
      return c.json({ ok: false, error: `"${uf.name}"은 10MB를 초과해서 업로드할 수 없어요` }, 400)
    }
  }
  try {
    const saved: Array<{ id: number; filename: string; size: number }> = []
    for (const uf of uploadFiles) {
      if (!uf.size) continue
      const up = await storageUpload(c.env, uf, 'myhub/drive')
      const r = await c.env.DB.prepare(
        'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(folderId, up.public_id, uf.name, uf.type || null, up.bytes, up.secure_url, up.resource_type).run()
      saved.push({ id: Number(r.meta.last_row_id), filename: uf.name, size: up.bytes })
    }
    await c.env.KV.delete('system:stats').catch(() => {})
    return c.json({ ok: true, files: saved })
  } catch (e) {
    return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
  }
})

driveApp.get('/files/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT url FROM drive_files WHERE id = ? AND deleted_at IS NULL').bind(c.req.param('id')).first<{ url: string | null }>()
  if (!row?.url) return c.json({ ok: false, error: 'not found' }, 404)
  return Response.redirect(row.url, 302)
})

driveApp.get('/files/:id/content', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT url, filename, mime FROM drive_files WHERE id = ? AND deleted_at IS NULL'
  ).bind(c.req.param('id')).first<{ url: string | null; filename: string; mime: string | null }>()
  if (!row?.url) return c.json({ ok: false, error: 'not found' }, 404)
  const range = c.req.header('Range')
  const up = await fetch(row.url, range ? { headers: { Range: range } } : undefined)
  if (!up.ok) return c.json({ ok: false, error: 'upstream failed' }, 502)
  const headers = new Headers()
  headers.set('Content-Type', row.mime || 'application/octet-stream')
  headers.set(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`
  )
  headers.set('Cache-Control', 'no-store')
  headers.set('Accept-Ranges', 'bytes')
  if (up.status === 206) {
    const contentRange = up.headers.get('Content-Range')
    const contentLength = up.headers.get('Content-Length')
    if (contentRange) headers.set('Content-Range', contentRange)
    if (contentLength) headers.set('Content-Length', contentLength)
    return new Response(up.body, { status: 206, headers })
  }
  return new Response(up.body, { status: 200, headers })
})

driveApp.put('/files/:id/content', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    'SELECT * FROM drive_files WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first<DriveFileRow>()
  if (!row) return c.json({ ok: false, error: 'not found' }, 404)
  const body = await c.req.parseBody()
  const f = body['file']
  const file = Array.isArray(f) ? f[0] : f
  if (!(file instanceof File)) return c.json({ ok: false, error: 'empty' }, 400)
  if (file.size > MAX_SIZE) {
    return c.json({ ok: false, error: '10MB를 초과해서 저장할 수 없어요' }, 400)
  }
  const baseVersion = typeof body['base_version'] === 'string' ? body['base_version'] : null
  if (baseVersion !== null && baseVersion !== row.storage_key) {
    return c.json({ ok: false, error: 'CONFLICT', file: fileView(row) }, 409)
  }
  let uploaded: Awaited<ReturnType<typeof storageUpload>> | null = null
  try {
    const named = new File([file], row.filename, { type: file.type })
    const up = await storageUpload(c.env, named, 'myhub/drive')
    uploaded = up
    const upd = await c.env.DB.prepare(
      'UPDATE drive_files SET storage_key = ?, size = ?, url = ?, resource_type = ?, mime = ? WHERE id = ? AND storage_key = ?'
    ).bind(up.public_id, up.bytes, up.secure_url, up.resource_type, file.type || null, id, row.storage_key).run()
    if (!upd.meta.changes) {
      await storageDestroy(c.env, up.public_id, up.resource_type)
      uploaded = null
      const now = await c.env.DB.prepare('SELECT * FROM drive_files WHERE id = ?').bind(id).first<DriveFileRow>()
      return c.json({ ok: false, error: 'CONFLICT', file: now ? fileView(now) : null }, 409)
    }
    uploaded = null
    await storageDestroy(c.env, row.storage_key, row.resource_type)
    await c.env.KV.delete('system:stats').catch(() => {})
    return c.json({ ok: true, size: up.bytes, version: up.public_id })
  } catch (e) {
    if (uploaded) await storageDestroy(c.env, uploaded.public_id, uploaded.resource_type)
    return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
  }
})

driveApp.post('/files/:id/rename', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({})) as any
  const name = String(body.name || '').trim()
  if (!name || /[/\\]/.test(name) || name.length > 200) {
    return c.json({ ok: false, error: 'bad name' }, 400)
  }
  const row = await c.env.DB.prepare('SELECT id FROM drive_files WHERE id = ? AND deleted_at IS NULL').bind(id).first()
  if (!row) return c.json({ ok: false, error: 'not found' }, 404)
  await c.env.DB.prepare('UPDATE drive_files SET filename = ? WHERE id = ?').bind(name, id).run()
  return c.json({ ok: true })
})

driveApp.post('/folders/:id/move', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'bad folder' }, 400)
  const body = await c.req.json().catch(() => ({})) as any
  const parentId = body.parent_id === undefined || body.parent_id === null ? null : Number(body.parent_id)
  const folder = await getFolder(c.env.DB, id)
  if (!folder || folder.deleted_at) return c.json({ ok: false, error: 'not found' }, 404)
  if (parentId !== null) {
    if (!Number.isInteger(parentId) || parentId <= 0) return c.json({ ok: false, error: 'bad folder' }, 400)
    if (parentId === id) return c.json({ ok: false, error: 'cannot move into itself' }, 400)
    const target = await getFolder(c.env.DB, parentId)
    if (!target || target.deleted_at) return c.json({ ok: false, error: 'folder not found' }, 404)
    let cur: DriveFolderRow | null = target
    for (let depth = 0; cur && cur.parent_id !== null && depth < 100; depth++) {
      if (cur.parent_id === id) return c.json({ ok: false, error: 'cannot move into subfolder' }, 400)
      cur = await getFolder(c.env.DB, cur.parent_id)
    }
  }
  await c.env.DB.prepare('UPDATE drive_folders SET parent_id = ? WHERE id = ?').bind(parentId, id).run()
  return c.json({ ok: true })
})

driveApp.post('/files/:id/move', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({})) as any
  const folderId = body.folder_id === undefined || body.folder_id === null ? null : Number(body.folder_id)
  if (folderId !== null) {
    if (!Number.isInteger(folderId) || folderId <= 0) return c.json({ ok: false, error: 'bad folder' }, 400)
    const folder = await getFolder(c.env.DB, folderId)
    if (!folder || folder.deleted_at) return c.json({ ok: false, error: 'folder not found' }, 404)
  }
  const row = await c.env.DB.prepare('SELECT id FROM drive_files WHERE id = ? AND deleted_at IS NULL').bind(id).first()
  if (!row) return c.json({ ok: false, error: 'not found' }, 404)
  await c.env.DB.prepare('UPDATE drive_files SET folder_id = ? WHERE id = ?').bind(folderId, id).run()
  return c.json({ ok: true })
})

driveApp.post('/files/:id/trash', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT deleted_at FROM drive_files WHERE id = ?').bind(id).first<{ deleted_at: string | null }>()
  if (!row) return c.json({ ok: false, error: 'not found' }, 404)
  if (row.deleted_at) return c.json({ ok: true, already: true })
  await c.env.DB.prepare("UPDATE drive_files SET deleted_at = datetime('now') WHERE id = ?").bind(id).run()
  return c.json({ ok: true })
})

driveApp.post('/files/:id/restore', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT folder_id, deleted_at FROM drive_files WHERE id = ?').bind(id).first<{ folder_id: number | null; deleted_at: string | null }>()
  if (!row) return c.json({ ok: false, error: 'not found' }, 404)
  if (!row.deleted_at) {
    if (row.folder_id !== null) {
      const folder = await getFolder(c.env.DB, row.folder_id)
      if (folder?.deleted_at) return c.json({ ok: false, error: 'IN_TRASHED_FOLDER' }, 409)
    }
    return c.json({ ok: true, already: true })
  }
  await c.env.DB.prepare('UPDATE drive_files SET deleted_at = NULL WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

driveApp.delete('/files/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT storage_key, resource_type FROM drive_files WHERE id = ?').bind(id).first<{ storage_key: string; resource_type: string }>()
  if (!row) return c.json({ ok: false, error: 'not found' }, 404)
  await storageDestroy(c.env, row.storage_key, row.resource_type)
  await c.env.DB.prepare('DELETE FROM drive_files WHERE id = ?').bind(id).run()
  await c.env.KV.delete('system:stats').catch(() => {})
  return c.json({ ok: true })
})

driveApp.get('/trash', async (c) => {
  const { results: folders } = await c.env.DB.prepare(
    'SELECT id, name, parent_id, created_at, deleted_at FROM drive_folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all<DriveFolderRow>()
  const { results: ownFiles } = await c.env.DB.prepare(
    'SELECT * FROM drive_files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all<DriveFileRow>()
  let viaFiles: DriveFileRow[] = []
  if (folders.length) {
    const ph = folders.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM drive_files WHERE deleted_at IS NULL AND folder_id IN (${ph}) ORDER BY id DESC`
    ).bind(...folders.map((f) => f.id)).all<DriveFileRow>()
    viaFiles = results
  }
  return c.json({
    ok: true,
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parent_id: f.parent_id,
      created_at: f.created_at,
      deleted_at: f.deleted_at ?? null,
    })),
    files: [
      ...ownFiles.map((f) => ({ ...fileView(f), via_folder: false })),
      ...viaFiles.map((f) => ({ ...fileView(f), via_folder: true })),
    ],
  })
})
