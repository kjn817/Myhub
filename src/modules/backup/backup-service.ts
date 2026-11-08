/**
 * 백업 서비스 — 암호화 키 파생·base64·첨부 실물 수집.
 * (backup/routes에서 분리)
 */

export const PBKDF2_ITERATIONS = 100000
export const SALT_LENGTH = 16
export const IV_LENGTH = 12

export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

const B64_CHUNK = 32768

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const parts: string[] = []
  for (let off = 0; off < bytes.byteLength; off += B64_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(off, off + B64_CHUNK)))
  }
  return btoa(parts.join(''))
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface BackupFileRow {
  id: number
  url?: string | null
  storage_key?: string | null
  filename?: string
  is_locked?: number | boolean
  size?: number
}

export interface AttachmentItem {
  file_id: number
  storage_key?: string | null
  filename?: string
  is_locked: number
  size: number
  sha256: string
  data_base64: string
}

export type FetchAttachmentResult =
  | { ok: true; items: AttachmentItem[]; missing: number[]; totalBytes: number }
  | { ok: false; fileId: number }

/**
 * 첨부 실물 수집 — 한 파일이라도 내려받지 못하면 전체를 실패로 돌려준다
 * (fail-closed: 일부가 빠진 "완전해 보이는" 백업을 만들지 않는다).
 * URL이 없는 행은 실물이 존재하지 않는 레거시 행이라 missing으로 기록한다.
 */
export async function fetchAttachmentItems(
  fileRows: BackupFileRow[],
  fetchFn: typeof fetch = fetch
): Promise<FetchAttachmentResult> {
  const items: AttachmentItem[] = []
  const missing: number[] = []
  let totalBytes = 0
  for (const row of fileRows) {
    if (!row.url) {
      missing.push(row.id)
      continue
    }
    let bytes: ArrayBuffer
    try {
      const resp = await fetchFn(row.url)
      if (!resp.ok) throw new Error(`status ${resp.status}`)
      bytes = await resp.arrayBuffer()
    } catch {
      return { ok: false, fileId: row.id }
    }
    items.push({
      file_id: row.id,
      storage_key: row.storage_key,
      filename: row.filename,
      is_locked: row.is_locked ? 1 : 0,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      data_base64: arrayBufferToBase64(bytes),
    })
    totalBytes += bytes.byteLength
  }
  return { ok: true, items, missing, totalBytes }
}
