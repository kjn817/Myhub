/**
 * F4 실런타임 테스트 (2026-11-07) — 오피스 저장 결함의 서버 계약 고정.
 *
 * 배경: 운영 QA 2차에서 Excel·한글 저장이 "미저장 표시만 사라지고 파일이
 * 생기지 않는" 결함이 확인됐다. 근본원인은 프론트 office-fetch.js의 신규
 * 생성 계약 위반이었다: 서버 POST /api/drive/files는 멀티파트 필드
 * **'files'**를 기대하는데 프론트가 'file'로 보내 400 {error:'empty'}를
 * 받고 있었다 (로컬 하네스의 관대한 스텁이 이를 통과시켰다). 이 테스트는
 * 실워커+실D1에서 양쪽 계약을 고정한다:
 * - 'file' 필드 POST → 400 {error:'empty'} (구 프론트 형태 — 회귀 감지)
 * - 'files' 필드 POST → 200 {ok, files:[{id, filename, size}]} + D1 행 생성
 *   (고친 프론트 office-fetch.js가 실제로 보내는 요청과 같은 형태)
 * - PUT /files/:id/content는 필드 'file'이 정본. 버전은 숫자 D1 version이
 *   아니라 storage_key(저장소 public_id)다 (fileView version: storage_key):
 *   현재 storage_key를 base_version으로 보내면 200 + 새 version, 낡은
 *   base_version이면 409 {error:'CONFLICT', file}
 * - GET /files/:id는 메타 JSON이 아니라 302 리다이렉트 (프론트 loadMeta가
 *   JSON을 기대하면 깨지는 이유 — 헤더 기반 로딩으로 바꾼 근거)
 * - 할 일 DELETE /api/todo/:id 계약 (서버 무죄 고정 — 삭제 무반응의 원인은
 *   프론트 confirm 게이트였고 f4-office-panel.test.ts가 그쪽을 고정한다)
 * - POST /api/ai/office/instruct 입력 검증 (app enum·instruction 필수)
 *
 * Cloudinary는 globalThis.fetch를 감싸 가짜 응답으로 교체한다 (워커와 같은
 * isolate에서 동작 — 실증된 방식). 운영 DB·운영 배포에는 닿지 않는다.
 */
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as { SESSION_SECRET: string }
const worker = exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }
const TEST_EMAIL = 'runtime-test@myhub.local'

async function mintSessionToken(email: string, secret: string): Promise<string> {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000
  const payload = JSON.stringify({ email, exp, method: 'pin', v: 0 })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

let cookie = ''
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (cookie) headers.set('Cookie', cookie)
  return worker.default.fetch(new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }))
}

beforeAll(async () => {
  const result = await applyAllMigrations()
  expect(result.failed).toHaveLength(0)
  const token = await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)
  cookie = `myhub_session=${token}`

  // Cloudinary만 가짜 응답으로 교체 (그 외 fetch는 그대로 통과).
  // 업로드할 때마다 public_id가 증가한다 — storage_key가 버전이라 실제
  // Cloudinary처럼 매 저장 새 실물이 생기는 상황을 재현한다.
  // GET /content는 저장소 URL을 서버가 직접 fetch해 스트리밍하므로
  // res.cloudinary.com GET도 가짜 바이트로 답한다.
  const realFetch = globalThis.fetch.bind(globalThis)
  let uploadSeq = 0
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.includes('api.cloudinary.com')) {
      uploadSeq += 1
      const pid = `myhub/f4-test-${uploadSeq}`
      return new Response(JSON.stringify({
        public_id: pid,
        secure_url: `https://res.cloudinary.com/test/raw/upload/${pid}`,
        resource_type: 'raw',
        bytes: 5,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('res.cloudinary.com')) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch
})

describe('F4: 오피스 신규 저장 계약 (office-fetch.js가 보내는 실제 요청)', () => {
  it("구 프론트 형태('file' 필드) POST는 400 empty — 결함 재현 고정", async () => {
    const form = new FormData()
    form.append('file', new Blob(['PK\x03\x04x'], { type: 'application/octet-stream' }), '구형식.xlsx')
    const res = await call('/api/drive/files', { method: 'POST', body: form })
    expect(res.status).toBe(400)
    const body = await res.json() as { error?: string }
    expect(body.error).toBe('empty')
  })

  it("'files' 필드 POST는 200 + files[0] + D1 행 생성 (Excel·한글 저장 경로)", async () => {
    const form = new FormData()
    form.append('files', new Blob(['PK\x03\x04hello'], { type: 'application/octet-stream' }), '분기보고.xlsx')
    const res = await call('/api/drive/files', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; files: Array<{ id: number; filename: string; size: number }> }
    expect(body.ok).toBe(true)
    expect(body.files).toHaveLength(1)
    expect(body.files[0].filename).toBe('분기보고.xlsx')
    expect(typeof body.files[0].id).toBe('number')

    const db = testDb()
    const row = await db.prepare('SELECT filename, storage_key, deleted_at FROM drive_files WHERE id = ?')
      .bind(body.files[0].id).first<{ filename: string; storage_key: string; deleted_at: string | null }>()
    expect(row?.filename).toBe('분기보고.xlsx')
    expect(row?.storage_key).toContain('myhub/f4-test-')
    expect(row?.deleted_at).toBeNull()
    // 버전(=storage_key)은 /recent fileView로 조회된다 (createFile 정규화 근거)
    const recent = await (await call('/api/drive/recent')).json() as {
      files: Array<{ id: number; version: string }>
    }
    const view = recent.files.find((f) => f.id === body.files[0].id)
    expect(view?.version).toBe(row?.storage_key)
  })

  it('PUT content(필드 file, base_version=storage_key)는 새 버전을 주고, 낡은 base_version은 409 CONFLICT', async () => {
    const form = new FormData()
    form.append('files', new Blob(['v1'], { type: 'application/octet-stream' }), '버전문서.hwpx')
    const created = await (await call('/api/drive/files', { method: 'POST', body: form })).json() as {
      files: Array<{ id: number }>
    }
    const id = created.files[0].id
    const db = testDb()
    const row = await db.prepare('SELECT storage_key FROM drive_files WHERE id = ?')
      .bind(id).first<{ storage_key: string }>()
    const v1 = row?.storage_key
    expect(v1).toBeTruthy()

    const put1 = new FormData()
    put1.append('file', new Blob(['v2'], { type: 'application/octet-stream' }), '버전문서.hwpx')
    put1.append('base_version', String(v1))
    const res1 = await call(`/api/drive/files/${id}/content`, { method: 'PUT', body: put1 })
    expect(res1.status).toBe(200)
    const body1 = await res1.json() as { ok: boolean; version: string }
    expect(body1.ok).toBe(true)
    expect(body1.version).toBeTruthy()
    expect(body1.version).not.toBe(v1)

    const put2 = new FormData()
    put2.append('file', new Blob(['v3'], { type: 'application/octet-stream' }), '버전문서.hwpx')
    put2.append('base_version', String(v1))
    const res2 = await call(`/api/drive/files/${id}/content`, { method: 'PUT', body: put2 })
    expect(res2.status).toBe(409)
    const body2 = await res2.json() as { error?: string; file?: { version: string } }
    expect(body2.error).toBe('CONFLICT')
    expect(body2.file?.version).toBe(body1.version)
  })

  it('GET /files/:id는 302 리다이렉트다 (loadMeta가 JSON을 읽으면 깨지는 근거)', async () => {
    const form = new FormData()
    form.append('files', new Blob(['x'], { type: 'application/pdf' }), '메타.pdf')
    const created = await (await call('/api/drive/files', { method: 'POST', body: form })).json() as {
      files: Array<{ id: number }>
    }
    const res = await call(`/api/drive/files/${created.files[0].id}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('cloudinary')
  })

  it('GET content는 Content-Disposition에 파일명을 싣는다 (새 loadMeta 근거)', async () => {
    const form = new FormData()
    form.append('files', new Blob(['x'], { type: 'application/pdf' }), '한글 이름.pdf')
    const created = await (await call('/api/drive/files', { method: 'POST', body: form })).json() as {
      files: Array<{ id: number }>
    }
    const res = await call(`/api/drive/files/${created.files[0].id}/content`)
    expect(res.status).toBe(200)
    const cd = res.headers.get('Content-Disposition') || ''
    expect(cd).toContain("filename*=UTF-8''")
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1].split(';')[0])).toBe('한글 이름.pdf')
  })
})

describe('F4: 할 일 삭제·오피스 instruct 서버 계약', () => {
  it('DELETE /api/todo/:id는 행을 지운다 (서버 무죄 — 프론트 게이트가 범인)', async () => {
    const created = await call('/api/todo/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'F4 삭제 계약' }),
    })
    expect(created.status).toBe(200)
    const body = await created.json() as { id?: number; todo?: { id: number } }
    const id = body.id ?? body.todo?.id
    expect(typeof id).toBe('number')
    const del = await call(`/api/todo/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const db = testDb()
    const row = await db.prepare('SELECT id FROM todos WHERE id = ?').bind(id).first()
    expect(row).toBeNull()
  })

  it('POST /api/ai/office/instruct 입력 검증: 잘못된 app·빈 instruction은 400', async () => {
    const bad1 = await call('/api/ai/office/instruct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'word', fileName: 'a.docx', instruction: '고쳐줘' }),
    })
    expect(bad1.status).toBe(400)
    const bad2 = await call('/api/ai/office/instruct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'excel', fileName: 'a.xlsx', instruction: '  ' }),
    })
    expect(bad2.status).toBe(400)
    const bad2Body = await bad2.json() as { error?: string }
    expect(bad2Body.error).toBe('instruction_required')
  })
})
