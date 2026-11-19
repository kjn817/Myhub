/**
 * 브라우저 다운로드 수신 (src/modules/browse/downloads.ts).
 *
 * 원격 Chromium에서 받은 파일이 MyHub Finder로 들어오는 경로 (2026-11-19).
 * 사이드카가 /downloads를 폴링해 완료된 파일을 multipart로 올린다.
 *
 * 인증: 사이드카는 세션 쿠키를 못 보내므로 ORIGIN_SECRET Bearer로 인증한다
 * (Craft 릴레이 relayAuth와 같은 패턴). 전역 미들웨어 allowlist에
 * /api/browse/downloads가 등록돼 있어 세션 검사 없이 여기로 온다.
 * ORIGIN_SECRET 미설정 시 503으로 비활성화한다 (열린 업로드 금지).
 *
 * 저장: Finder '다운로드' 폴더(없으면 생성, 삭제된 게 있으면 복원)에
 * drive 저장 공용 경로(saveDriveFile)로 넣는다. 상한 10MB는 Finder
 * 업로드와 동일하다 (초과는 사이드카가 올리지도 않는다).
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { secretsEqual } from '../../services/channel-gateway'
import { saveDriveFile } from '../drive/upload'

export const DOWNLOAD_FOLDER_NAME = '다운로드'
export const DOWNLOAD_MAX_SIZE = 10 * 1024 * 1024

export function registerDownloadRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post('/downloads', async (c) => {
    const configured = c.env.ORIGIN_SECRET
    if (!configured) return c.json({ ok: false, error: 'disabled' }, 503)
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')
    if (!m || !secretsEqual(m[1].trim(), configured)) {
      return c.json({ ok: false, error: 'unauthorized' }, 401)
    }
    let file: File | null = null
    try {
      const body = await c.req.parseBody()
      const f = body['file']
      file = f instanceof File ? f : null
    } catch {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    if (!file || !file.size) return c.json({ ok: false, error: 'empty' }, 400)
    if (file.size > DOWNLOAD_MAX_SIZE) {
      return c.json({ ok: false, error: 'too large' }, 400)
    }
    // '다운로드' 폴더 찾기 — 삭제된 게 있으면 복원해 쓰고, 없으면 만든다
    // (drive_folders에 이름 UNIQUE가 없어 매번 만들면 중복이 쌓인다).
    const existing = await c.env.DB.prepare(
      'SELECT id, deleted_at FROM drive_folders WHERE name = ? AND parent_id IS NULL',
    )
      .bind(DOWNLOAD_FOLDER_NAME)
      .first<{ id: number; deleted_at: string | null }>()
    let folderId: number
    if (existing) {
      folderId = existing.id
      if (existing.deleted_at) {
        await c.env.DB.prepare('UPDATE drive_folders SET deleted_at = NULL WHERE id = ?')
          .bind(folderId)
          .run()
      }
    } else {
      const r = await c.env.DB.prepare('INSERT INTO drive_folders (name, parent_id) VALUES (?, NULL)')
        .bind(DOWNLOAD_FOLDER_NAME)
        .run()
      folderId = Number(r.meta.last_row_id)
    }
    try {
      const saved = await saveDriveFile(c.env, file, folderId)
      await c.env.KV.delete('system:stats').catch(() => {})
      return c.json({ ok: true, file: saved, folderId })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })
}
