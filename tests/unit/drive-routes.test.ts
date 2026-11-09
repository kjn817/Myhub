/// <reference types="jest" />
/**
 * src/modules/drive/routes.ts — 파인더 보관함 API 성질 테스트 (C3).
 *
 * 실제 SQLite(local-d1 + 0067 실마이그레이션) + 전역 fetch 목킹(Cloudinary
 * 경계)으로 고정하는 성질:
 * - 목록·최근·사용량·휴지통은 삭제된 항목을 숨기고, 파일 뷰의 version은
 *   storage_key와 일치한다 (낙관적 동시성 표식).
 * - 폴더/파일 CRUD와 이동은 순환·자기 참조를 거부하고, 잘못된 id·이름은
 *   400, 없는 대상은 404로 구분된다.
 * - 업로드/교체는 10MB 상한과 base_version 충돌(409)을 지키며, 교체 중
 *   원본이 사라지면 새 업로드를 정리하고 409로 돌아온다.
 * - 영구 삭제는 하위 트리 전체의 스토리지 파괴를 동반한다.
 * 카나리아: 충돌 검사나 상한을 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { driveApp } from '../../src/modules/drive/routes'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0067_drive_storage.sql'))
  return db
}

class FakeKV {
  deletes: string[] = []
  async get(): Promise<null> { return null }
  async put(): Promise<void> {}
  async delete(key: string): Promise<void> { this.deletes.push(key) }
}

interface FetchCall { url: string; method: string }
const realFetch = global.fetch
let fetchCalls: FetchCall[] = []
let uploadSeq = 0
let destroyResult: unknown = { result: 'ok' }
let onUpload: (() => void) | null = null
let contentHandler: ((url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>) | null = null

function stubFetch(): void {
  fetchCalls = []
  uploadSeq = 0
  destroyResult = { result: 'ok' }
  onUpload = null
  contentHandler = null
  global.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const u = String(url)
    fetchCalls.push({ url: u, method: init?.method ?? 'GET' })
    if (u.includes('/auto/upload')) {
      onUpload?.()
      uploadSeq += 1
      const form = init as unknown as { body?: FormData }
      const file = form.body?.get('file') as File | null
      return {
        ok: true, status: 200,
        json: async () => ({ public_id: `myhub/drive/up-${uploadSeq}`, secure_url: `https://cdn.example/up-${uploadSeq}`, resource_type: 'raw', bytes: file?.size ?? 0 }),
      }
    }
    if (u.includes('/destroy')) {
      return { ok: true, status: 200, json: async () => destroyResult }
    }
    if (contentHandler) return contentHandler(u, init)
    return { ok: false, status: 404, json: async () => ({}) }
  }) as typeof fetch
}

afterEach(() => { global.fetch = realFetch })
beforeEach(() => stubFetch())

function envOf(db: any, kv: FakeKV = new FakeKV()) {
  return {
    DB: db, KV: kv,
    CLOUDINARY_CLOUD_NAME: 'testcloud', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret',
  } as never
}

async function req(env: never, routePath: string, init: RequestInit = {}) {
  const res = await driveApp.request(routePath, init, env)
  let json: any = null
  try { json = await res.json() } catch { /* 리다이렉트 등 */ }
  return { status: res.status, json, headers: res.headers }
}
const get = (env: never, p: string) => req(env, p)
const postJson = (env: never, p: string, body: unknown) =>
  req(env, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const del = (env: never, p: string) => req(env, p, { method: 'DELETE' })

async function seedFolder(db: any, name: string, parentId: number | null = null, deleted = false): Promise<number> {
  const r = await db.prepare('INSERT INTO drive_folders (name, parent_id, deleted_at) VALUES (?, ?, ?)')
    .bind(name, parentId, deleted ? '2026-01-01T00:00:00Z' : null).run()
  return Number(r.meta.last_row_id)
}

async function seedFile(db: any, filename: string, folderId: number | null = null, opts: { deleted?: boolean; key?: string; size?: number } = {}): Promise<number> {
  const r = await db.prepare(
    'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(folderId, opts.key ?? `key/${filename}`, filename, 'text/plain', opts.size ?? 10, `https://cdn.example/${filename}`, 'raw', opts.deleted ? '2026-01-01T00:00:00Z' : null).run()
  return Number(r.meta.last_row_id)
}

async function folderRow(db: any, id: number) {
  return db.prepare('SELECT * FROM drive_folders WHERE id = ?').bind(id).first()
}
async function fileRow(db: any, id: number) {
  return db.prepare('SELECT * FROM drive_files WHERE id = ?').bind(id).first()
}

describe('/list·/recent·/usage — 조회 계약', () => {
  test('루트 목록은 루트 항목만, 파일 version은 storage_key와 같다', async () => {
    const db = makeDb()
    const docs = await seedFolder(db, '문서')
    await seedFolder(db, '하위', docs)
    await seedFile(db, '루트파일.txt', null, { key: 'key/root-v3' })
    await seedFile(db, '하위파일.txt', docs)
    await seedFile(db, '삭제파일.txt', null, { deleted: true })
    const r = await get(envOf(db), '/list')
    expect(r.status).toBe(200)
    expect(r.json.folder).toBeNull()
    expect(r.json.folders.map((f: any) => f.name)).toEqual(['문서'])
    expect(r.json.files.map((f: any) => f.filename)).toEqual(['루트파일.txt'])
    expect(r.json.files[0].version).toBe('key/root-v3')
    const sub = await get(envOf(db), `/list?folder=${docs}`)
    expect(sub.json.folder).toEqual({ id: docs, name: '문서', parent_id: null })
    expect(sub.json.folders.map((f: any) => f.name)).toEqual(['하위'])
    expect(sub.json.files.map((f: any) => f.filename)).toEqual(['하위파일.txt'])
    const root2 = await get(envOf(db), '/list?folder=root')
    expect(root2.status).toBe(200)
  })

  test('잘못된 folder 파라미터는 400, 없는·삭제된 폴더는 404', async () => {
    const db = makeDb()
    const trashed = await seedFolder(db, '버린', null, true)
    for (const bad of ['abc', '0', '-2', '1.5']) {
      const r = await get(envOf(db), `/list?folder=${bad}`)
      expect(r.status).toBe(400)
    }
    expect((await get(envOf(db), '/list?folder=9999')).status).toBe(404)
    expect((await get(envOf(db), `/list?folder=${trashed}`)).status).toBe(404)
  })

  test('/recent는 최신순 50건, 폴더명을 붙이고 삭제 파일을 숨긴다', async () => {
    const db = makeDb()
    const docs = await seedFolder(db, '문서')
    await seedFile(db, '예전.txt', docs)
    const latest = await seedFile(db, '최신.txt', null)
    await seedFile(db, '삭제.txt', null, { deleted: true })
    const r = await get(envOf(db), '/recent')
    expect(r.json.files.map((f: any) => f.id)).toEqual([latest, latest - 1])
    expect(r.json.files[1].folder_name).toBe('문서')
    expect(r.json.files[0].folder_name).toBeNull()
  })

  test('/usage는 삭제되지 않은 파일만 센다', async () => {
    const db = makeDb()
    await seedFile(db, 'a.txt', null, { size: 100 })
    await seedFile(db, 'b.txt', null, { size: 250 })
    await seedFile(db, 'c.txt', null, { size: 999, deleted: true })
    const r = await get(envOf(db), '/usage')
    expect(r.json).toEqual({ ok: true, files: 2, bytes: 350 })
  })

  test('/search 라우트: q 없으면 400, 있으면 검색 결과 형태를 돌려준다', async () => {
    const db = makeDb()
    await seedFile(db, '찾을파일.txt')
    expect((await get(envOf(db), '/search')).status).toBe(400)
    const r = await get(envOf(db), '/search?q=찾을')
    expect(r.status).toBe(200)
    expect(r.json.total).toBe(1)
    expect(r.json.files[0]).toMatchObject({ filename: '찾을파일.txt', deleted_at: null, version: 'key/찾을파일.txt' })
  })
})

describe('폴더 생성·이름변경·휴지통', () => {
  test('생성: 이름 없으면 400, 부모가 없거나 삭제됐으면 404, 정상 시 DB에 생긴다', async () => {
    const db = makeDb()
    const env = envOf(db)
    expect((await postJson(env, '/folders', { name: '  ' })).status).toBe(400)
    expect((await postJson(env, '/folders', { name: 'x', parent_id: 999 })).status).toBe(404)
    const trashed = await seedFolder(db, '버린', null, true)
    expect((await postJson(env, '/folders', { name: 'x', parent_id: trashed })).status).toBe(404)
    const ok = await postJson(env, '/folders', { name: '새 폴더' })
    expect(ok.status).toBe(200)
    const row = await folderRow(db, ok.json.id)
    expect(row.name).toBe('새 폴더')
    expect(row.parent_id).toBeNull()
  })

  test('이름변경: 빈 이름 400, 없는 폴더 404, 정상 시 이름이 바뀐다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFolder(db, '원래이름')
    expect((await postJson(env, `/folders/${id}/rename`, { name: '' })).status).toBe(400)
    expect((await postJson(env, '/folders/999/rename', { name: 'x' })).status).toBe(404)
    const r = await postJson(env, `/folders/${id}/rename`, { name: ' 바뀐이름 ' })
    expect(r.json).toEqual({ ok: true })
    expect((await folderRow(db, id)).name).toBe('바뀐이름')
  })

  test('휴지통/복원: 상태 전이와 already 플래그, 없는 폴더 404', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFolder(db, '대상')
    expect((await postJson(env, '/folders/999/trash', {})).status).toBe(404)
    expect((await postJson(env, `/folders/${id}/trash`, {})).json).toEqual({ ok: true })
    expect((await folderRow(db, id)).deleted_at).not.toBeNull()
    expect((await postJson(env, `/folders/${id}/trash`, {})).json).toEqual({ ok: true, already: true })
    expect((await postJson(env, `/folders/${id}/restore`, {})).json).toEqual({ ok: true })
    expect((await folderRow(db, id)).deleted_at).toBeNull()
    expect((await postJson(env, `/folders/${id}/restore`, {})).json).toEqual({ ok: true, already: true })
  })

  test('영구 삭제: 하위 트리의 파일 스토리지를 모두 파괴하고 행을 지운다', async () => {
    const db = makeDb()
    const kv = new FakeKV()
    const env = envOf(db, kv)
    const root = await seedFolder(db, '루트폴더')
    const child = await seedFolder(db, '자식', root)
    await seedFile(db, '깊은파일.txt', child)
    await seedFile(db, '얕은파일.txt', root)
    await seedFile(db, '밖파일.txt', null)
    const r = await del(env, `/folders/${root}`)
    expect(r.json).toEqual({ ok: true, files: 2, folders: 2 })
    expect(fetchCalls.filter((c) => c.url.includes('/destroy'))).toHaveLength(2)
    expect(await folderRow(db, root)).toBeNull()
    expect(await folderRow(db, child)).toBeNull()
    const left = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(left.n).toBe(1)
    expect(kv.deletes).toContain('system:stats')
    expect((await del(env, '/folders/999')).status).toBe(404)
  })
})

describe('파일 업로드·조회·교체', () => {
  function uploadForm(files: File[], folderId?: string) {
    const form = new FormData()
    if (folderId !== undefined) form.append('folder_id', folderId)
    for (const f of files) form.append('files', f)
    return form
  }

  test('업로드: 스토리지 결과가 DB 행이 되고 응답에 담긴다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const form = uploadForm([new File(['hello'], '안녕.txt', { type: 'text/plain' })])
    const r = await req(env, '/files', { method: 'POST', body: form })
    expect(r.status).toBe(200)
    expect(r.json.files).toEqual([{ id: expect.any(Number), filename: '안녕.txt', size: 5 }])
    const row = await fileRow(db, r.json.files[0].id)
    expect(row.storage_key).toBe('myhub/drive/up-1')
    expect(row.url).toBe('https://cdn.example/up-1')
    expect(row.mime).toBe('text/plain')
    expect(row.size).toBe(5)
  })

  test('업로드 경계: 파일 없음 400, 0바이트는 건너뜀, 폴더 오류 구분', async () => {
    const db = makeDb()
    const env = envOf(db)
    const empty = await req(env, '/files', { method: 'POST', body: uploadForm([]) })
    expect(empty.status).toBe(400)
    expect(empty.json.error).toBe('empty')

    const zero = await req(env, '/files', { method: 'POST', body: uploadForm([new File([], '빈.txt')]) })
    expect(zero.status).toBe(200)
    expect(zero.json.files).toEqual([])

    const badFolder = await req(env, '/files', { method: 'POST', body: uploadForm([new File(['x'], 'a.txt')], 'abc') })
    expect(badFolder.status).toBe(400)
    const noFolder = await req(env, '/files', { method: 'POST', body: uploadForm([new File(['x'], 'a.txt')], '999') })
    expect(noFolder.status).toBe(404)
  })

  // 회귀: parseBody 기본 파싱은 중복 'files' 키에서 마지막 값만 남긴다.
  // 핸들러의 배열 순회·전 파일 검증이 있어도 도달할 수 없어 앞 파일이
  // 조용히 버려졌던 결함의 재현·고정.
  test('업로드: 파일 2개 + 폴더 지정 — 둘 다 그 폴더에 저장된다 (중복 키 소실 회귀)', async () => {
    const db = makeDb()
    const env = envOf(db)
    const folderId = await seedFolder(db, '대상 폴더')
    const r = await req(env, '/files', {
      method: 'POST',
      body: uploadForm([new File(['x'], 'a.txt'), new File(['yy'], 'b.txt')], String(folderId)),
    })
    expect(r.status).toBe(200)
    expect(r.json.files.map((f: any) => f.filename)).toEqual(['a.txt', 'b.txt'])
    const { results } = await db.prepare('SELECT filename, folder_id FROM drive_files ORDER BY id').all()
    expect(results).toEqual([
      { filename: 'a.txt', folder_id: folderId },
      { filename: 'b.txt', folder_id: folderId },
    ])
  })

  test('업로드: 파일 2개 폴더 미지정 — 둘 다 루트(folder_id NULL)에 저장된다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const r = await req(env, '/files', {
      method: 'POST',
      body: uploadForm([new File(['x'], 'a.txt'), new File(['yy'], 'b.txt')]),
    })
    expect(r.status).toBe(200)
    expect(r.json.files).toHaveLength(2)
    const { results } = await db.prepare('SELECT folder_id FROM drive_files ORDER BY id').all()
    expect(results).toEqual([{ folder_id: null }, { folder_id: null }])
  })

  // 스칼라 정규화 계약: folder_id는 단일 값 필드다. 중복 전송(계약 밖 입력)에서는
  // 첫 값을 쓰는 것으로 고정한다 — 배열이 Number()로 NaN이 되어 폴더 지정이
  // 깨지는 일이 없어야 한다.
  test('업로드: folder_id 중복 전송 시 첫 값을 쓴다 (스칼라 정규화 계약)', async () => {
    const db = makeDb()
    const env = envOf(db)
    const folderId = await seedFolder(db, '첫 값 폴더')
    const form = new FormData()
    form.append('files', new File(['x'], 'a.txt'))
    form.append('folder_id', String(folderId))
    form.append('folder_id', 'root')
    const r = await req(env, '/files', { method: 'POST', body: form })
    expect(r.status).toBe(200)
    const row = await fileRow(db, r.json.files[0].id)
    expect(row.folder_id).toBe(folderId)
  })

  test('업로드 10MB 초과는 어떤 파일도 저장하지 않고 400', async () => {
    const db = makeDb()
    const env = envOf(db)
    const big = new File(['x'.repeat(10 * 1024 * 1024 + 1)], '큰파일.bin')
    const form = uploadForm([new File(['ok'], '작은.txt'), big])
    const r = await req(env, '/files', { method: 'POST', body: form })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('10MB')
    const left = await db.prepare('SELECT COUNT(*) AS n FROM drive_files').first()
    expect(left.n).toBe(0)
    expect(fetchCalls.filter((c) => c.url.includes('/auto/upload'))).toHaveLength(0)
  })

  test('업로드 중 스토리지 실패는 500으로 표면화된다', async () => {
    const db = makeDb()
    const env = envOf(db)
    contentHandler = null
    global.fetch = (async () => ({ ok: false, status: 502, text: async () => 'bad', json: async () => ({}) })) as unknown as typeof fetch
    const r = await req(env, '/files', { method: 'POST', body: uploadForm([new File(['x'], 'a.txt')]) })
    expect(r.status).toBe(500)
    expect(r.json.ok).toBe(false)
  })

  test('GET /files/:id는 저장된 URL로 302, 없으면 404', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '바로가기.txt')
    const r = await get(env, `/files/${id}`)
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(new URL('https://cdn.example/바로가기.txt').toString())
    expect((await get(env, '/files/999')).status).toBe(404)
  })

  test('GET /files/:id/content는 본문과 다운로드 헤더를 중계한다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '문서 파일.txt')
    contentHandler = async () => new Response('파일 본문', { status: 200 })
    const r = await driveApp.request(`/files/${id}/content`, {}, env)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('파일 본문')
    expect(r.headers.get('content-type')).toBe('text/plain')
    expect(r.headers.get('content-disposition')).toContain(encodeURIComponent('문서 파일.txt'))
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
  })

  test('content Range 요청은 206과 구간 헤더를 그대로 중계하고, 위쪽 실패는 502', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '영상.mp4')
    contentHandler = async (_u, init) => {
      expect(init?.headers?.Range).toBe('bytes=10-19')
      return new Response('0123456789', { status: 206, headers: { 'Content-Range': 'bytes 10-19/100', 'Content-Length': '10' } })
    }
    const r = await driveApp.request(`/files/${id}/content`, { headers: { Range: 'bytes=10-19' } }, env)
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(r.headers.get('content-length')).toBe('10')
    contentHandler = async () => new Response('err', { status: 500 })
    const fail = await get(env, `/files/${id}/content`)
    expect(fail.status).toBe(502)
    expect((await get(env, '/files/999/content')).status).toBe(404)
  })

  test('PUT 교체: version이 새 키로 바뀌고 이전 스토리지는 파괴된다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '교체.txt', null, { key: 'key/old' })
    const form = new FormData()
    form.append('file', new File(['new-body'], 'ignored-name.txt', { type: 'text/plain' }))
    form.append('base_version', 'key/old')
    const r = await req(env, `/files/${id}/content`, { method: 'PUT', body: form })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, size: 8, version: 'myhub/drive/up-1' })
    const row = await fileRow(db, id)
    expect(row.storage_key).toBe('myhub/drive/up-1')
    expect(row.filename).toBe('교체.txt') // 원래 파일명 유지
    expect(fetchCalls.filter((c) => c.url.includes('/destroy'))).toHaveLength(1)
  })

  test('PUT 충돌: base_version이 다르면 409와 현재 파일 뷰를 돌려주고 저장하지 않는다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '충돌.txt', null, { key: 'key/current' })
    const form = new FormData()
    form.append('file', new File(['x'], 'x.txt'))
    form.append('base_version', 'key/stale')
    const r = await req(env, `/files/${id}/content`, { method: 'PUT', body: form })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('CONFLICT')
    expect(r.json.file.version).toBe('key/current')
    expect(fetchCalls.filter((c) => c.url.includes('/auto/upload'))).toHaveLength(0)
    expect((await fileRow(db, id)).storage_key).toBe('key/current')
  })

  test('PUT 경계: 없는 파일 404, 파일 없음 400, 10MB 초과 400', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '대상.txt')
    const noFile = await req(env, `/files/${id}/content`, { method: 'PUT', body: new FormData() })
    expect(noFile.status).toBe(400)
    const form = new FormData()
    form.append('file', new File(['x'], 'x.txt'))
    expect((await req(env, '/files/999/content', { method: 'PUT', body: form })).status).toBe(404)
    const bigForm = new FormData()
    bigForm.append('file', new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'big.bin'))
    const big = await req(env, `/files/${id}/content`, { method: 'PUT', body: bigForm })
    expect(big.status).toBe(400)
    expect(big.json.error).toContain('10MB')
  })

  test('PUT: 업로드 후 DB 갱신이 실패하면 새 업로드를 정리하고 500', async () => {
    const db = makeDb()
    const id = await seedFile(db, '실패.txt', null, { key: 'key/keep' })
    const wrapped = {
      ...db,
      prepare: (sql: string) => {
        if (sql.startsWith('UPDATE drive_files SET storage_key')) throw new Error('db locked')
        return db.prepare(sql)
      },
    }
    const form = new FormData()
    form.append('file', new File(['data'], 'data.txt'))
    const r = await req(envOf(wrapped), `/files/${id}/content`, { method: 'PUT', body: form })
    expect(r.status).toBe(500)
    expect(fetchCalls.filter((c) => c.url.includes('/auto/upload'))).toHaveLength(1)
    expect(fetchCalls.filter((c) => c.url.includes('/destroy'))).toHaveLength(1)
    expect((await fileRow(db, id)).storage_key).toBe('key/keep')
  })

  test('PUT 도중 원본 행이 사라지면 새 업로드를 정리하고 409 (경합 표면화)', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '경합.txt', null, { key: 'key/race' })
    onUpload = () => {
      // 업로드가 진행되는 사이 다른 경로가 원본 행을 지운 상황을 재현한다
      void db.prepare('DELETE FROM drive_files WHERE id = ?').bind(id).run()
    }
    const form = new FormData()
    form.append('file', new File(['data'], 'data.txt'))
    form.append('base_version', 'key/race')
    const r = await req(env, `/files/${id}/content`, { method: 'PUT', body: form })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('CONFLICT')
    expect(r.json.file).toBeNull()
    // 새 업로드 1회 + 그 정리 destroy 1회
    expect(fetchCalls.filter((c) => c.url.includes('/auto/upload'))).toHaveLength(1)
    expect(fetchCalls.filter((c) => c.url.includes('/destroy'))).toHaveLength(1)
  })
})

describe('파일 이름변경·이동·휴지통·삭제', () => {
  test('파일 이름변경: 경로 구분자·과길이·빈 이름은 400, 없는 파일 404', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seedFile(db, '원래.txt')
    for (const bad of ['', 'a/b', 'a\\b', 'x'.repeat(201)]) {
      expect((await postJson(env, `/files/${id}/rename`, { name: bad })).status).toBe(400)
    }
    expect((await postJson(env, '/files/999/rename', { name: 'ok.txt' })).status).toBe(404)
    expect((await postJson(env, `/files/${id}/rename`, { name: '새이름.txt' })).json).toEqual({ ok: true })
    expect((await fileRow(db, id)).filename).toBe('새이름.txt')
  })

  test('폴더 이동: 자기 자신·자손으로는 못 가고, 루트로는 갈 수 있다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const a = await seedFolder(db, '에이')
    const b = await seedFolder(db, '비', a)
    const c = await seedFolder(db, '씨', b)
    expect((await postJson(env, `/folders/${a}/move`, { parent_id: a })).json.error).toBe('cannot move into itself')
    const intoChild = await postJson(env, `/folders/${a}/move`, { parent_id: c })
    expect(intoChild.status).toBe(400)
    expect(intoChild.json.error).toBe('cannot move into subfolder')
    expect((await postJson(env, `/folders/${a}/move`, { parent_id: 999 })).status).toBe(404)
    expect((await postJson(env, '/folders/999/move', { parent_id: null })).status).toBe(404)
    expect((await postJson(env, `/folders/${'x'}/move`, { parent_id: null })).status).toBe(400)
    const ok = await postJson(env, `/folders/${c}/move`, { parent_id: null })
    expect(ok.json).toEqual({ ok: true })
    expect((await folderRow(db, c)).parent_id).toBeNull()
    const under = await postJson(env, `/folders/${c}/move`, { parent_id: a })
    expect(under.json).toEqual({ ok: true })
    expect((await folderRow(db, c)).parent_id).toBe(a)
  })

  test('파일 이동: 폴더 검증 후 folder_id가 바뀐다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const folder = await seedFolder(db, '대상폴더')
    const id = await seedFile(db, '이동.txt')
    expect((await postJson(env, `/files/${id}/move`, { folder_id: 'x' })).status).toBe(400)
    expect((await postJson(env, `/files/${id}/move`, { folder_id: 999 })).status).toBe(404)
    expect((await postJson(env, '/files/999/move', { folder_id: folder })).status).toBe(404)
    expect((await postJson(env, `/files/${id}/move`, { folder_id: folder })).json).toEqual({ ok: true })
    expect((await fileRow(db, id)).folder_id).toBe(folder)
    expect((await postJson(env, `/files/${id}/move`, { folder_id: null })).json).toEqual({ ok: true })
    expect((await fileRow(db, id)).folder_id).toBeNull()
  })

  test('파일 휴지통/복원 전이와, 삭제된 폴더 안 파일 복원 거부(409)', async () => {
    const db = makeDb()
    const env = envOf(db)
    const folder = await seedFolder(db, '폴더')
    const inFolder = await seedFile(db, '안파일.txt', folder)
    const solo = await seedFile(db, '독립.txt')
    expect((await postJson(env, '/files/999/trash', {})).status).toBe(404)
    expect((await postJson(env, `/files/${solo}/trash`, {})).json).toEqual({ ok: true })
    expect((await fileRow(db, solo)).deleted_at).not.toBeNull()
    expect((await postJson(env, `/files/${solo}/trash`, {})).json).toEqual({ ok: true, already: true })
    expect((await postJson(env, `/files/${solo}/restore`, {})).json).toEqual({ ok: true })
    expect((await fileRow(db, solo)).deleted_at).toBeNull()
    // 폴더만 휴지통에 있고 파일은 멀쩡하면 복원 경로는 409로 막는다
    await postJson(env, `/folders/${folder}/trash`, {})
    const blocked = await postJson(env, `/files/${inFolder}/restore`, {})
    expect(blocked.status).toBe(409)
    expect(blocked.json.error).toBe('IN_TRASHED_FOLDER')
    // 폴더가 살아 있고 파일도 멀쩡하면 already:true
    const liveFolder = await seedFolder(db, '생존폴더')
    const liveFile = await seedFile(db, '생존파일.txt', liveFolder)
    expect((await postJson(env, `/files/${liveFile}/restore`, {})).json).toEqual({ ok: true, already: true })
  })

  test('파일 영구 삭제: 스토리지 파괴 후 행이 사라진다', async () => {
    const db = makeDb()
    const kv = new FakeKV()
    const env = envOf(db, kv)
    const id = await seedFile(db, '지울.txt')
    expect((await del(env, '/files/999')).status).toBe(404)
    const r = await del(env, `/files/${id}`)
    expect(r.json).toEqual({ ok: true })
    expect(await fileRow(db, id)).toBeNull()
    expect(fetchCalls.filter((c) => c.url.includes('/destroy'))).toHaveLength(1)
    expect(kv.deletes).toContain('system:stats')
  })

  test('/trash: 삭제 폴더·자체 삭제 파일·폴더 경유 파일이 구분되어 온다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const folder = await seedFolder(db, '버린폴더', null, true)
    const via = await seedFile(db, '경유.txt', folder)
    const own = await seedFile(db, '자체.txt', null, { deleted: true })
    await seedFile(db, '정상.txt', null)
    const r = await get(env, '/trash')
    expect(r.json.folders.map((f: any) => f.id)).toEqual([folder])
    const byId = new Map(r.json.files.map((f: any) => [f.id, f]))
    expect(byId.get(via).via_folder).toBe(true)
    expect(byId.get(own).via_folder).toBe(false)
    expect(r.json.files).toHaveLength(2)
  })
})
