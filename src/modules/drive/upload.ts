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

/**
 * 확장자로 MIME을 추정한다 — 오라클 저장소 파일은 Cloudinary 업로드
 * 응답이 없어 mime을 알 방법이 없으므로 등록 시점에 파일명으로 추정한다.
 * 모르는 확장자는 null (내용 서빙이 application/octet-stream으로 폴백).
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  hwp: 'application/x-hwp',
  hwpx: 'application/vnd.hancom.hwpx',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  pdf: 'application/pdf',
  zip: 'application/zip',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
}

export function mimeFromFilename(filename: string): string | null {
  const m = /\.([^.]+)$/.exec(filename.trim().toLowerCase())
  if (!m) return null
  return MIME_BY_EXTENSION[m[1]] ?? null
}

/**
 * 오라클 파일의 버전 토큰 — storage_key에 들어가는 낙관적 동시성 표식.
 * Cloudinary 파일은 public_id가 저장마다 바뀌듯, 오라클 파일은 이 토큰이
 * 저장마다 바뀐다. 시각 + 난수를 섞어 같은 밀리초의 연속 저장도 구분한다.
 */
export function nextOracleVersion(oraclePath: string): string {
  const rand = Math.random().toString(16).slice(2, 8)
  return `oracle:${oraclePath}#${Date.now()}-${rand}`
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
