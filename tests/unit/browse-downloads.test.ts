/// <reference types="jest" />
/**
 * POST /api/browse/downloads — 브라우저 다운로드 수신 (2026-11-19).
 *
 * 실제 SQLite(local-d1 + 0067 실마이그레이션) + 전역 fetch 목킹(Cloudinary
 * 경계)으로 고정하는 성질:
 * - ORIGIN_SECRET Bearer가 아니면 401, 시크릿 미설정 시 503으로 비활성화한다
 *   (열린 업로드 금지 — 전역 미들웨어를 우회하는 경로라 모듈 인증이 전부다).
 * - 받은 파일은 Finder '다운로드' 폴더에 들어가고, 폴더는 한 번만 만든다
 *   (두 번째 업로드도 같은 폴더를 재사용한다 — 이름 UNIQUE가 없어 매번
 *   만들면 중복이 쌓인다).
 * - 삭제된 '다운로드' 폴더가 있으면 복원해 쓰고 새로 만들지 않는다.
 * - 10MB 초과는 400으로 거부하고 Cloudinary·D1에 닿지 않는다.
 * - 빈 파일·파일 없음은 400이다.
 * 카나리아: 인증·폴더 재사용·상한을 깨면 해당 테스트가 실패한다.
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
