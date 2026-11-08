/**
 * 오피스 AI 라우트 — 패널 비서 지시/메모 기반 생성/메일 초안·발송/폴더 정리.
 * (ai/routes에서 분리. 서비스 로직은 services/office-ai·office-ops·google-tools.)
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  instructOfficeAi,
  searchMemosForOffice,
  planFromMemo,
  planDocMarkdown,
  draftMailWithAi,
  proposeOrganize,
  type OfficeChatFn,
} from '../../services/office-ai'
import { signApproval, verifyApproval } from '../../services/office-ops'
import { executeGmailSend } from '../../services/google-tools'

export interface OfficeAiDeps {
  fetchFn?: typeof fetch
  chat?: OfficeChatFn
}

export function createOfficeAiApp(deps: OfficeAiDeps = {}) {
  const app = new Hono<{ Bindings: Env }>()
  const fetchFn = deps.fetchFn || fetch

  app.post('/instruct', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const kind = body.app
    if (kind !== 'excel' && kind !== 'hangul' && kind !== 'pdf' && kind !== 'slide') {
      return c.json({ ok: false, error: 'bad app' }, 400)
    }
    try {
      const result = await instructOfficeAi(
        c.env,
        {
          app: kind,
          fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 200) : '',
          instruction: String(body.instruction || ''),
          snapshot: body.snapshot,
        },
        deps.chat
      )
      return c.json({ ok: true, ...result })
    } catch (e: any) {
      if (e?.message === 'instruction_required') {
        return c.json({ ok: false, error: 'instruction_required' }, 400)
      }
      return c.json({ ok: false, error: 'ai_failed' }, 502)
    }
  })

  app.get('/memos', async (c) => {
    const q = c.req.query('q') || ''
    const results = await searchMemosForOffice(c.env, q)
    return c.json({ ok: true, memos: results })
  })

  app.post('/from-memo', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const memoId = Number(body.memoId)
    const target = body.target === 'excel' ? 'excel' : body.target === 'hangul' ? 'hangul' : null
    if (!Number.isInteger(memoId) || memoId <= 0 || !target) {
      return c.json({ ok: false, error: 'bad input' }, 400)
    }
    try {
      const plan = await planFromMemo(c.env, { memoId, target }, deps.chat)
      return c.json({ ok: true, ...plan })
    } catch (e: any) {
      if (e?.message === 'memo_not_found') {
        return c.json({ ok: false, error: 'memo_not_found' }, 404)
      }
      return c.json({ ok: false, error: 'ai_failed' }, 502)
    }
  })

  app.post('/from-memo-doc', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const memoId = Number(body.memoId)
    if (!Number.isInteger(memoId) || memoId <= 0) {
      return c.json({ ok: false, error: 'bad input' }, 400)
    }
    try {
      const doc = await planDocMarkdown(c.env, { memoId }, deps.chat)
      return c.json({ ok: true, ...doc })
    } catch (e: any) {
      if (e?.message === 'memo_not_found') {
        return c.json({ ok: false, error: 'memo_not_found' }, 404)
      }
      return c.json({ ok: false, error: 'ai_failed' }, 502)
    }
  })

  app.post('/mail/draft', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const fileId = Number.isInteger(body.fileId) ? Number(body.fileId) : null
    let fileName = ''
    if (fileId) {
      const row = await c.env.DB.prepare(
        'SELECT filename FROM drive_files WHERE id = ? AND deleted_at IS NULL'
      ).bind(fileId).first<{ filename: string }>()
      if (!row) return c.json({ ok: false, error: 'file_not_found' }, 404)
      fileName = row.filename
    }
    try {
      const draft = await draftMailWithAi(
        c.env,
        {
          to: String(body.to || ''),
          fileName,
          memoId: Number.isInteger(body.memoId) ? Number(body.memoId) : undefined,
          note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
        },
        deps.chat
      )
      const token = await signApproval(c.env.SESSION_SECRET, { draft, fileId })
      return c.json({ ok: true, draft, fileId, token })
    } catch (e: any) {
      if (e?.message === 'bad_recipient') return c.json({ ok: false, error: 'bad_recipient' }, 400)
      if (e?.message === 'memo_not_found') return c.json({ ok: false, error: 'memo_not_found' }, 404)
      return c.json({ ok: false, error: 'ai_failed' }, 502)
    }
  })

  app.post('/mail/send', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const draft = body.draft
    const fileId = Number.isInteger(body.fileId) ? Number(body.fileId) : null
    if (!draft || body.confirm !== true || typeof body.token !== 'string') {
      return c.json({ ok: false, error: 'approval_required' }, 403)
    }
    const verified = await verifyApproval(
      c.env.SESSION_SECRET,
      { draft: { to: draft.to, subject: draft.subject, body: draft.body }, fileId },
      body.token
    )
    if (!verified) return c.json({ ok: false, error: 'approval_mismatch' }, 403)
    let attachment: { filename: string; mime: string; bytes: Uint8Array } | undefined
    if (fileId) {
      const row = await c.env.DB.prepare(
        'SELECT filename, mime, url FROM drive_files WHERE id = ? AND deleted_at IS NULL'
      ).bind(fileId).first<{ filename: string; mime: string | null; url: string | null }>()
      if (!row?.url) return c.json({ ok: false, error: 'file_not_found' }, 404)
      const up = await fetchFn(row.url)
      if (!up.ok) return c.json({ ok: false, error: 'attachment_failed' }, 502)
      attachment = {
        filename: row.filename,
        mime: row.mime || 'application/octet-stream',
        bytes: new Uint8Array(await up.arrayBuffer()),
      }
    }
    const result = await executeGmailSend(
      c.env,
      { to: String(draft.to), subject: String(draft.subject), body: String(draft.body), attachment },
      fetchFn
    )
    if (!result.success) {
      const status = result.error === 'invalid_input' ? 400 : 403
      return c.json({ ok: false, error: result.error }, status as 400 | 403)
    }
    return c.json({ ok: true, id: result.data.id })
  })

  app.post('/organize/plan', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const folderId = body.folderId === null || body.folderId === undefined ? null : Number(body.folderId)
    if (folderId !== null && (!Number.isInteger(folderId) || folderId <= 0)) {
      return c.json({ ok: false, error: 'bad folder' }, 400)
    }
    const fileSql = folderId === null
      ? 'SELECT id, folder_id, filename, size FROM drive_files WHERE folder_id IS NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 100'
      : 'SELECT id, folder_id, filename, size FROM drive_files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 100'
    const files = folderId === null
      ? (await c.env.DB.prepare(fileSql).all<{ id: number; folder_id: number | null; filename: string; size: number }>()).results
      : (await c.env.DB.prepare(fileSql).bind(folderId).all<{ id: number; folder_id: number | null; filename: string; size: number }>()).results
    const { results: folders } = await c.env.DB.prepare(
      'SELECT id, name FROM drive_folders WHERE deleted_at IS NULL ORDER BY name'
    ).all<{ id: number; name: string }>()
    const fileInfos = files.map((f) => ({
      id: f.id,
      filename: f.filename,
      folderId: f.folder_id ?? null,
      size: f.size,
    }))
    try {
      const { plan, errors } = await proposeOrganize(c.env, { files: fileInfos, folders }, deps.chat)
      const secret = c.env.SESSION_SECRET
      const signed = await Promise.all(
        plan.map(async (entry) => ({
          ...entry,
          token: await signApproval(secret, { folderId, entry }),
        }))
      )
      return c.json({ ok: true, plan: signed, errors, files: fileInfos, folders })
    } catch {
      return c.json({ ok: false, error: 'ai_failed' }, 502)
    }
  })

  app.post('/organize/apply', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const folderId = body.folderId === undefined ? null : body.folderId
    const rawPlan = Array.isArray(body.plan) ? body.plan : null
    if (!rawPlan || body.confirm !== true) {
      return c.json({ ok: false, error: 'approval_required' }, 403)
    }
    const plan: Array<Record<string, any>> = []
    for (const raw of rawPlan.slice(0, 100)) {
      const { token, ...entry } = raw || {}
      if (typeof token !== 'string') continue
      if (await verifyApproval(c.env.SESSION_SECRET, { folderId, entry }, token)) plan.push(entry)
    }
    if (plan.length === 0) return c.json({ ok: false, error: 'approval_mismatch' }, 403)
    const applied: Array<Record<string, unknown>> = []
    const errors: string[] = []
    for (const item of plan) {
      const fileId = Number(item?.fileId)
      if (!Number.isInteger(fileId)) continue
      const row = await c.env.DB.prepare(
        'SELECT id, filename, folder_id FROM drive_files WHERE id = ? AND deleted_at IS NULL'
      ).bind(fileId).first<{ id: number; filename: string; folder_id: number | null }>()
      if (!row) {
        errors.push(`파일 ${fileId}를 찾을 수 없음`)
        continue
      }
      try {
        if (typeof item.newName === 'string' && item.newName.trim() && item.newName !== row.filename) {
          await c.env.DB.prepare('UPDATE drive_files SET filename = ? WHERE id = ?').bind(item.newName.trim().slice(0, 200), fileId).run()
        }
        if (item.toFolderId !== undefined && item.toFolderId !== row.folder_id) {
          if (item.toFolderId !== null) {
            const folder = await c.env.DB.prepare(
              'SELECT id FROM drive_folders WHERE id = ? AND deleted_at IS NULL'
            ).bind(item.toFolderId).first()
            if (!folder) {
              errors.push(`${row.filename}: 대상 폴더가 없음`)
              continue
            }
          }
          await c.env.DB.prepare('UPDATE drive_files SET folder_id = ? WHERE id = ?').bind(item.toFolderId, fileId).run()
        }
        applied.push({ fileId, newName: item.newName, toFolderId: item.toFolderId })
      } catch {
        errors.push(`${row.filename}: 변경 실패`)
      }
    }
    return c.json({ ok: true, applied, errors })
  })

  return app
}

export const officeAiApp = createOfficeAiApp()
