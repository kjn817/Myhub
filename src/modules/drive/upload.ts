/**
 * Drive 파일 저장 공용 경로 (src/modules/drive/upload.ts).
 *
 * Finder 업로드(POST /files)와 브라우저 다운로드 수신(POST /api/browse/downloads)이
 * 같은 저장 절차를 쓴다 — Cloudinary 본문 업로드 + drive_files 행 삽입.
 * 한 곳만 고치면 양쪽이 같이 바뀐다 (2026-11-19 추출).
 */
import type { Env } from '../../types'
import { storageUpload } from '../../services/storage'

export interface SavedDriveFile {
  id: number
  filename: string
  size: number
}

/** 파일 하나를 Cloudinary에 올리고 drive_files 행을 만든다. */
export async function saveDriveFile(
  env: Env,
  file: File,
  folderId: number | null,
): Promise<SavedDriveFile> {
  const up = await storageUpload(env, file, 'myhub/drive')
  const r = await env.DB.prepare(
    'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(folderId, up.public_id, file.name, file.type || null, up.bytes, up.secure_url, up.resource_type)
    .run()
  return { id: Number(r.meta.last_row_id), filename: file.name, size: up.bytes }
}
