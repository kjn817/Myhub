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
 * 업로드와 동일하다.
 *
 * 하이브리드 저장소 (2026-11-19): 10MB를 넘는 파일은 사이드카가 올리지
 * 않고 오라클 /downloads에 그대로 두며, POST /downloads/register로
 * 메타데이터만 등록한다 (storage='oracle', url NULL). 실물은 내용 요청
 * 때 Worker가 사이드카에서 가져온다 (services/oracle-files.ts).
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { secretsEqual } from '../../services/channel-gateway'
import { isFlatFilename } from '../../services/oracle-files'
import { mimeFromFilename, nextOracleVersion, saveDriveFile } from '../drive/upload'

export const DOWNLOAD_FOLDER_NAME = '다운로드'
export const DOWNLOAD_MAX_SIZE = 10 * 1024 * 1024

/** ORIGIN_SECRET Bearer 인증 — 두 다운로드 경로가 공유한다. */
function checkOriginSecret(c: {
  env: Env
  req: { header: (name: string) => string | undefined }
  json: (body: unknown, status?: number) => Response
}): Response | null {
  const configured = c.env.ORIGIN_SECRET
  if (!configured) return c.json({ ok: false, error: 'disabled' }, 503)
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')
  if (!m || !secretsEqual(m[1].trim(), configured)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  return null
}

/**
 * '다운로드' 폴더 찾기 — 삭제된 게 있으면 복원해 쓰고, 없으면 만든다
 * (drive_folders에 이름 UNIQUE가 없어 매번 만들면 중복이 쌓인다).
 */
async function ensureDownloadFolder(db: D1Database): Promise<number> {
  const existing = await db
    .prepare('SELECT id, deleted_at FROM drive_folders WHERE name = ? AND parent_id IS NULL')
    .bind(DOWNLOAD_FOLDER_NAME)
    .first<{ id: number; deleted_at: string | null }>()
  if (existing) {
    if (existing.deleted_at) {
      await db
        .prepare('UPDATE drive_folders SET deleted_at = NULL WHERE id = ?')
        .bind(existing.id)
        .run()
    }
    return existing.id
  }
  const r = await db
    .prepare('INSERT INTO drive_folders (name, parent_id) VALUES (?, NULL)')
    .bind(DOWNLOAD_FOLDER_NAME)
    .run()
  return Number(r.meta.last_row_id)
}

export function registerDownloadRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post('/downloads', async (c) => {
    const denied = checkOriginSecret(c)
    if (denied) return denied
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
    const folderId = await ensureDownloadFolder(c.env.DB)
    try {
      const saved = await saveDriveFile(c.env, file, folderId)
      await c.env.KV.delete('system:stats').catch(() => {})
      return c.json({ ok: true, file: saved, folderId })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })

  // 오라클 저장소 파일 등록 (2026-11-19 하이브리드 저장소):
  // 10MB를 넘는 다운로드는 사이드카가 올리지 않고 오라클 /downloads에
  // 그대로 두며, 메타데이터만 여기로 등록해 Finder에 나타나게 한다.
  // 실물은 Worker가 내용 요청 때 사이드카에서 스트리밍으로 가져온다.
  // oracle_path 기준 upsert다 — 사이드카 재시작 후 재등록해도 행이
  // 중복되지 않는다. 휴지통에 있는 행은 복원하지 않는다 (사용자가 버린
  // 파일을 감시가 되살리면 안 된다).
  app.post('/downloads/register', async (c) => {
    const denied = checkOriginSecret(c)
    if (denied) return denied
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const b = body as { name?: unknown; size?: unknown; oraclePath?: unknown; mime?: unknown }
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const size = b.size
    const oraclePath = b.oraclePath
    if (
      !name ||
      name.length > 200 ||
      name.includes('/') ||
      name.includes('\\') ||
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size <= 0 ||
      !isFlatFilename(oraclePath)
    ) {
      return c.json({ ok: false, error: 'invalid_body' }, 400)
    }
    const folderId = await ensureDownloadFolder(c.env.DB)
    const existing = await c.env.DB.prepare(
      'SELECT id, filename, size, deleted_at FROM drive_files WHERE oracle_path = ? AND storage = ?',
    )
      .bind(oraclePath, 'oracle')
      .first<{ id: number; filename: string; size: number; deleted_at: string | null }>()
    if (existing) {
      return c.json({
        ok: true,
        file: { id: existing.id, filename: existing.filename, size: existing.size },
        folderId,
        duplicate: true,
        ...(existing.deleted_at ? { trashed: true } : {}),
      })
    }
    const mime =
      typeof b.mime === 'string' && b.mime ? b.mime : mimeFromFilename(name)
    try {
      const r = await c.env.DB.prepare(
        'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type, storage, oracle_path) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
      )
        .bind(folderId, nextOracleVersion(oraclePath), name, mime, size, 'raw', 'oracle', oraclePath)
        .run()
      await c.env.KV.delete('system:stats').catch(() => {})
      return c.json({
        ok: true,
        file: { id: Number(r.meta.last_row_id), filename: name, size },
        folderId,
      })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })
}
