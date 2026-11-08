/// <reference types="jest" />
/**
 * 암호화 백업의 첨부 실물 포함 테스트 (트랙 4)
 * - 기본 포함: 바이트가 base64+sha256으로 봉투 안에 들어가고 복호로 검증
 * - fail-closed: 다운로드 실패 시 백업 전체 중단(502), 추정 초과 시 413
 * - includeAttachments:false 명시 시 included:false로 구분 기록
 * - URL 없는 행은 missing_file_ids에 명시
 */
import { Hono } from 'hono'
import backupApp, { BACKUP_TABLES } from '../../src/modules/backup/routes'

class MockDb {
  batchQueue: any[] = []
  prepare(_sql: string) {
    return { bind: (..._p: any[]) => ({}) }
  }
  async batch(stmts: any[]) {
    const v = this.batchQueue.shift()
    if (v instanceof Error) throw v
    return v ?? []
  }
}

// 목 batch 결과는 BACKUP_TABLES 전체분이어야 한다 (개수 핀은 backup-scope)
const TABLE_COUNT = BACKUP_TABLES.length
const FILES_IDX = BACKUP_TABLES.indexOf('files')

function makeBatchResults(rowsByIndex: Record<number, any[]> = {}) {
  const results: any[] = []
  for (let i = 0; i < TABLE_COUNT; i++) results.push({ results: rowsByIndex[i] ?? [] })
  return results
}

function makeApp(db: MockDb) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('userEmail', 'test@example.com')
    await next()
  })
  app.route('/a', backupApp)
  const env: any = { DB: db, ENVIRONMENT: 'staging' }
  return (body: any) =>
    app.request('/a/encrypted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env)
}

async function decryptBackup(encrypted: any, password: string): Promise<any> {
  const enc = new TextEncoder()
  const b64ToBytes = (s: string) => {
    const bin = atob(s)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(encrypted.salt), iterations: encrypted.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(encrypted.iv) },
    key,
    b64ToBytes(encrypted.ciphertext).buffer as ArrayBuffer,
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

const FILE_BYTES = new TextEncoder().encode('첨부 실물 바이트 — xlsx 흉내')
const fileRow = {
  id: 92,
  memo_id: 128,
  storage_key: 'myhub/memo/file1',
  filename: 'report.xlsx',
  mime: 'application/octet-stream',
  size: FILE_BYTES.byteLength,
  url: 'https://res.cloudinary.test/file1',
  resource_type: 'raw',
  is_locked: 0,
  created_at: '2026-10-01 00:00:00',
}

describe('POST /encrypted — 첨부 실물', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('기본 포함: 복호하면 첨부 바이트·해시가 원본과 일치', async () => {
    globalThis.fetch = (async () => new Response(FILE_BYTES, { status: 200 })) as any
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults({ [FILES_IDX]: [fileRow] }))
    const post = makeApp(db)
    const res = await post({ password: 'password123' })
    expect(res.status).toBe(200)
    const j = await res.json() as any
    expect(j.attachments_included).toBe(true)
    expect(j.attachment_count).toBe(1)
    expect(j.attachment_bytes).toBe(FILE_BYTES.byteLength)

    const plain = await decryptBackup(j, 'password123')
    expect(plain.version).toBe(6)
    expect(plain.attachments.included).toBe(true)
    const item = plain.attachments.items[0]
    expect(item.file_id).toBe(92)
    const decoded = Uint8Array.from(atob(item.data_base64), (ch) => ch.charCodeAt(0))
    expect(new TextDecoder().decode(decoded)).toBe('첨부 실물 바이트 — xlsx 흉내')
    const digest = await crypto.subtle.digest('SHA-256', decoded.buffer as ArrayBuffer)
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(item.sha256).toBe(hex)
  })

  test('다운로드 실패 → 502로 백업 전체 중단 (부분 백업 없음)', async () => {
    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as any
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults({ [FILES_IDX]: [fileRow] }))
    const post = makeApp(db)
    const res = await post({ password: 'password123' })
    expect(res.status).toBe(502)
    const j = await res.json() as any
    expect(j.code).toBe('attachment_fetch_failed')
    expect(j.file_id).toBe(92)
    expect(j.ciphertext).toBeUndefined()
  })

  test('추정 크기 초과 → 다운로드 전에 413 (fail-closed)', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response(FILE_BYTES, { status: 200 })
    }) as any
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults({ [FILES_IDX]: [{ ...fileRow, size: 9 * 1024 * 1024 }] }))
    const post = makeApp(db)
    const res = await post({ password: 'password123' })
    expect(res.status).toBe(413)
    expect(((await res.json()) as any).code).toBe('attachments_too_large')
    expect(fetchCalled).toBe(false)
  })

  test('includeAttachments:false → 봉투에 included:false가 남는다', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response(FILE_BYTES, { status: 200 })
    }) as any
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults({ [FILES_IDX]: [fileRow] }))
    const post = makeApp(db)
    const res = await post({ password: 'password123', includeAttachments: false })
    expect(res.status).toBe(200)
    const j = await res.json() as any
    expect(j.attachments_included).toBe(false)
    expect(fetchCalled).toBe(false)
    const plain = await decryptBackup(j, 'password123')
    expect(plain.attachments.included).toBe(false)
    expect(plain.attachments.items).toEqual([])
  })

  test('URL 없는 행은 missing_file_ids에 명시되고 백업은 성공', async () => {
    globalThis.fetch = (async () => new Response(FILE_BYTES, { status: 200 })) as any
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults({ [FILES_IDX]: [{ ...fileRow, id: 77, url: null }] }))
    const post = makeApp(db)
    const res = await post({ password: 'password123' })
    expect(res.status).toBe(200)
    const plain = await decryptBackup(await res.json(), 'password123')
    expect(plain.attachments.missing_file_ids).toEqual([77])
    expect(plain.attachments.count).toBe(0)
  })
})
