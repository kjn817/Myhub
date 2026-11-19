/// <reference types="jest" />
/**
 * POST /api/browse/downloads (+ /downloads/register) — 브라우저 다운로드
 * 수신 (2026-11-19).
 *
 * 실제 SQLite(local-d1 + 0067·0079 실마이그레이션) + 전역 fetch 목킹
 * (Cloudinary 경계)으로 고정하는 성질:
 * - ORIGIN_SECRET Bearer가 아니면 401, 시크릿 미설정 시 503으로 비활성화한다
 *   (열린 업로드 금지 — 전역 미들웨어를 우회하는 경로라 모듈 인증이 전부다).
 * - 받은 파일은 Finder '다운로드' 폴더에 들어가고, 폴더는 한 번만 만든다
 *   (두 번째 업로드도 같은 폴더를 재사용한다 — 이름 UNIQUE가 없어 매번
 *   만들면 중복이 쌓인다).
 * - 삭제된 '다운로드' 폴더가 있으면 복원해 쓰고 새로 만들지 않는다.
 * - 10MB 초과는 400으로 거부하고 Cloudinary·D1에 닿지 않는다.
 * - 빈 파일·파일 없음은 400이다.
 * - 등록(/register)은 오라클 행(storage='oracle', url NULL)을 만들고,
 *   같은 oracle_path 재등록은 duplicate로 돌려보내 행이 중복되지 않으며,
 *   휴지통에 있는 행은 복원하지 않는다.
 * 카나리아: 인증·폴더 재사용·상한·upsert를 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const app = new Hono()
app.route('/api/browse', browseApp)

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0067_drive_storage.sql'))
  db.exec(mig('0079_drive_oracle_storage.sql'))
  return db
}

class FakeKV {
  async get(): Promise<null> {
    return null
  }
  async put(): Promise<void> {}
  async delete(): Promise<void> {}
}

const realFetch = global.fetch
let fetchCalls: string[] = []
let uploadSeq = 0

function stubFetch(): void {
  fetchCalls = []
  uploadSeq = 0
  global.fetch = (async (url: unknown, init?: { method?: string; body?: FormData }) => {
    const u = String(url)
    fetchCalls.push(u)
    if (u.includes('/auto/upload')) {
      uploadSeq += 1
      const file = init?.body?.get('file') as File | null
      return {
        ok: true,
        status: 200,
        json: async () => ({
          public_id: `myhub/drive/dl-${uploadSeq}`,
          secure_url: `https://cdn.example/dl-${uploadSeq}`,
          resource_type: 'raw',
          bytes: file?.size ?? 0,
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as typeof fetch
}

afterEach(() => {
  global.fetch = realFetch
})
beforeEach(() => stubFetch())

// originSecret=null이면 키 자체를 빼서 '미설정'을 재현한다 — undefined를
// 넘기면 기본값이 채워져 503 케이스가 안 된다.
function envOf(db: any, originSecret: string | null = 'origin-secret-16') {
  const env: Record<string, unknown> = {
    DB: db,
    KV: new FakeKV(),
    CLOUDINARY_CLOUD_NAME: 'testcloud',
    CLOUDINARY_API_KEY: 'key',
    CLOUDINARY_API_SECRET: 'secret',
  }
  if (originSecret !== null) env.ORIGIN_SECRET = originSecret
  return env as never
}

function uploadForm(filename: string, content: string | Uint8Array): FormData {
  const form = new FormData()
  const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([content], { type: 'text/plain' })
  form.append('file', blob, filename)
  return form
}

async function postDownload(env: never, form: FormData, auth: string | null = 'Bearer origin-secret-16') {
  const headers: Record<string, string> = {}
  if (auth !== null) headers['authorization'] = auth
  const res = await app.request(
    '/api/browse/downloads',
    { method: 'POST', headers, body: form },
    env,
  )
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* ignore */
  }
  return { status: res.status, json }
}

async function foldersNamed(db: any, name: string) {
  return db
    .prepare('SELECT * FROM drive_folders WHERE name = ? AND parent_id IS NULL')
    .bind(name)
    .all()
}

describe('POST /api/browse/downloads', () => {
  test('올바른 Bearer면 파일이 다운로드 폴더에 들어가고 폴더는 한 번만 만든다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const r1 = await postDownload(env, uploadForm('a.pdf', 'pdf-bytes'))
    expect(r1.status).toBe(200)
    expect(r1.json.ok).toBe(true)
    expect(r1.json.file.filename).toBe('a.pdf')
    const folderId = r1.json.folderId as number
    expect(typeof folderId).toBe('number')
    const r2 = await postDownload(env, uploadForm('b.txt', 'text-bytes'))
    expect(r2.status).toBe(200)
    expect(r2.json.folderId).toBe(folderId)
    const folders = await foldersNamed(db, '다운로드')
    expect(folders.results).toHaveLength(1)
    expect(folders.results[0].deleted_at).toBeNull()
    const files = await db
      .prepare('SELECT filename, folder_id FROM drive_files ORDER BY id')
      .all()
    expect(files.results).toEqual([
      { filename: 'a.pdf', folder_id: folderId },
      { filename: 'b.txt', folder_id: folderId },
    ])
    expect(fetchCalls.filter((u) => u.includes('/auto/upload'))).toHaveLength(2)
  })

  test('삭제된 다운로드 폴더가 있으면 복원해 쓰고 새로 만들지 않는다', async () => {
    const db = makeDb()
    const seed = await db
      .prepare("INSERT INTO drive_folders (name, parent_id, deleted_at) VALUES ('다운로드', NULL, '2026-01-01T00:00:00Z')")
      .run()
    const oldId = Number(seed.meta.last_row_id)
    const r = await postDownload(envOf(db), uploadForm('c.txt', 'c'))
    expect(r.status).toBe(200)
    expect(r.json.folderId).toBe(oldId)
    const folders = await foldersNamed(db, '다운로드')
    expect(folders.results).toHaveLength(1)
    expect(folders.results[0].deleted_at).toBeNull()
  })

  test('Bearer가 틀리거나 없으면 401, 시크릿 미설정이면 503', async () => {
    const db = makeDb()
    const env = envOf(db)
    const wrong = await postDownload(env, uploadForm('a.txt', 'a'), 'Bearer wrong-secret-16')
    expect(wrong.status).toBe(401)
    const missing = await postDownload(env, uploadForm('a.txt', 'a'), null)
    expect(missing.status).toBe(401)
    const disabled = await postDownload(envOf(db, null), uploadForm('a.txt', 'a'))
    expect(disabled.status).toBe(503)
    expect(fetchCalls.filter((u) => u.includes('/auto/upload'))).toHaveLength(0)
    const files = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(files?.n).toBe(0)
  })

  test('10MB 초과는 400이고 Cloudinary·D1에 닿지 않는다', async () => {
    const db = makeDb()
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    const r = await postDownload(envOf(db), uploadForm('big.bin', big))
    expect(r.status).toBe(400)
    expect(fetchCalls.filter((u) => u.includes('/auto/upload'))).toHaveLength(0)
    const files = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(files?.n).toBe(0)
  })

  test('빈 파일·파일 없음은 400이다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const empty = await postDownload(env, uploadForm('empty.txt', ''))
    expect(empty.status).toBe(400)
    const noFile = await postDownload(env, new FormData())
    expect(noFile.status).toBe(400)
    expect(fetchCalls.filter((u) => u.includes('/auto/upload'))).toHaveLength(0)
  })
})

async function postRegister(
  env: never,
  payload: unknown,
  auth: string | null = 'Bearer origin-secret-16',
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth !== null) headers['authorization'] = auth
  const res = await app.request(
    '/api/browse/downloads/register',
    { method: 'POST', headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    env,
  )
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* ignore */
  }
  return { status: res.status, json }
}

describe('POST /api/browse/downloads/register', () => {
  test('오라클 행을 만들고 확장자로 mime을 추정한다', async () => {
    const db = makeDb()
    const r = await postRegister(envOf(db), {
      name: '보고서.hwp',
      size: 20 * 1024 * 1024,
      oraclePath: '보고서.hwp',
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.file.filename).toBe('보고서.hwp')
    expect(r.json.file.size).toBe(20 * 1024 * 1024)
    const row = await db
      .prepare('SELECT * FROM drive_files WHERE id = ?')
      .bind(r.json.file.id)
      .first()
    expect(row.storage).toBe('oracle')
    expect(row.oracle_path).toBe('보고서.hwp')
    expect(row.url).toBeNull()
    expect(row.mime).toBe('application/x-hwp')
    expect(row.folder_id).toBe(r.json.folderId)
    expect(String(row.storage_key)).toMatch(/^oracle:보고서\.hwp#/)
    // Cloudinary에는 닿지 않는다 — 바이트가 아니라 메타데이터만 등록한다.
    expect(fetchCalls.filter((u) => u.includes('/auto/upload'))).toHaveLength(0)
    const folders = await foldersNamed(db, '다운로드')
    expect(folders.results).toHaveLength(1)
  })

  test('같은 oracle_path 재등록은 duplicate로 돌려보내고 행이 늘지 않는다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const payload = { name: 'big.zip', size: 15 * 1024 * 1024, oraclePath: 'big.zip' }
    const r1 = await postRegister(env, payload)
    expect(r1.status).toBe(200)
    expect(r1.json.duplicate).toBeUndefined()
    const r2 = await postRegister(env, payload)
    expect(r2.status).toBe(200)
    expect(r2.json.ok).toBe(true)
    expect(r2.json.duplicate).toBe(true)
    expect(r2.json.file.id).toBe(r1.json.file.id)
    const count = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(count?.n).toBe(1)
  })

  test('휴지통에 있는 행은 복원하지 않고 trashed로 알린다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const payload = { name: 'old.bin', size: 12 * 1024 * 1024, oraclePath: 'old.bin' }
    const r1 = await postRegister(env, payload)
    expect(r1.status).toBe(200)
    await db
      .prepare("UPDATE drive_files SET deleted_at = datetime('now') WHERE id = ?")
      .bind(r1.json.file.id)
      .run()
    const r2 = await postRegister(env, payload)
    expect(r2.status).toBe(200)
    expect(r2.json.duplicate).toBe(true)
    expect(r2.json.trashed).toBe(true)
    const row = await db
      .prepare('SELECT deleted_at FROM drive_files WHERE id = ?')
      .bind(r1.json.file.id)
      .first()
    expect(row?.deleted_at).not.toBeNull()
    const count = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(count?.n).toBe(1)
  })

  test('Bearer가 틀리거나 없으면 401, 시크릿 미설정이면 503', async () => {
    const db = makeDb()
    const env = envOf(db)
    const payload = { name: 'x.bin', size: 11 * 1024 * 1024, oraclePath: 'x.bin' }
    const wrong = await postRegister(env, payload, 'Bearer wrong-secret-16')
    expect(wrong.status).toBe(401)
    const missing = await postRegister(env, payload, null)
    expect(missing.status).toBe(401)
    const disabled = await postRegister(envOf(db, null), payload)
    expect(disabled.status).toBe(503)
    const count = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(count?.n).toBe(0)
  })

  test('잘못된 본문은 400이고 행을 만들지 않는다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const bad = [
      { name: 'x.bin', size: 11, oraclePath: '../x.bin' },
      { name: 'x.bin', size: 11, oraclePath: 'sub/x.bin' },
      { name: 'x.bin', size: 11, oraclePath: 'x\\bin' },
      { name: '', size: 11, oraclePath: 'x.bin' },
      { name: 'a/b.bin', size: 11, oraclePath: 'b.bin' },
      { name: 'x.bin', size: 0, oraclePath: 'x.bin' },
      { name: 'x.bin', size: -5, oraclePath: 'x.bin' },
      { name: 'x.bin', size: 11.5, oraclePath: 'x.bin' },
      { name: 'x.bin', size: 11 },
      'not-json{',
    ]
    for (const payload of bad) {
      const r = await postRegister(env, payload)
      expect(r.status).toBe(400)
    }
    const count = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(count?.n).toBe(0)
  })

  test('모르는 확장자는 mime null, 명시 mime은 그대로 쓴다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const r1 = await postRegister(env, { name: 'data.xyz', size: 11, oraclePath: 'data.xyz' })
    expect(r1.status).toBe(200)
    const row1 = await db.prepare('SELECT mime FROM drive_files WHERE id = ?').bind(r1.json.file.id).first()
    expect(row1?.mime).toBeNull()
    const r2 = await postRegister(env, {
      name: 'data.xyz',
      size: 12,
      oraclePath: 'data2.xyz',
      mime: 'application/x-custom',
    })
    expect(r2.status).toBe(200)
    const row2 = await db.prepare('SELECT mime FROM drive_files WHERE id = ?').bind(r2.json.file.id).first()
    expect(row2?.mime).toBe('application/x-custom')
  })
})
