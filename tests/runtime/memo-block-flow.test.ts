/**
 * 블록 잠금 종단 흐름 실런타임 테스트 (트랙 D + 서버 근본 수정 D-1·D-2·D-3).
 *
 * Mock으로 검증 못 하는 것 — 실제 AES-GCM + 실제 D1에서:
 * - lock-block이 locked_blocks에 ENC: 암호문만 저장하는지 (평문 없음)
 * - D-3: 서버 lock-block이 본문의 평문을 [LOCKED_BLOCK:<id>] 마커로 원자
 *   치환하는지, 본문에 없는 html은 fail-closed(409 + DB 불변)인지
 * - 실제 클라이언트 순서(저장 PUT → lock-block → 마커 PUT 반영) 이후에는
 *   memos.text·FTS·소유자 검색·AI 접근 계층 어디에도 비밀 평문이 없는지
 * - 해제(PIN 미설정 상태)가 원문을 돌려주고 locked_blocks에서 제거하는지
 * - 첨부 잠금: 원본 바이트 → 암호화 업로드 → /content 복호화 서빙 왕복
 *   (fetch만 Cloudinary 경계에서 스텁, 암호화·D1은 실물)
 * - D-1: 잠금 시 구 평문 storage_key, 해제 시 .enc storage_key를
 *   Cloudinary destroy로 파괴하는지 (스텁 경계에서 호출 단언)
 * - D-2: GET /files/:fileId가 잠긴 파일은 /content로, 열린 파일은 원본
 *   URL로 302 리다이렉트하는지
 *
 * 운영 DB·배포 없음. D1은 파일마다 격리된 로컬 SQLite.
 */
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { memoApp } from '../../src/modules/memo/routes'
import { getAccessibleMemo, searchAccessibleMemos } from '../../src/services/ai-access'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as {
  DB: D1Database
  KV: KVNamespace
  CLOUDINARY_CLOUD_NAME: string
  CLOUDINARY_API_KEY: string
  CLOUDINARY_API_SECRET: string
  MEMO_ENCRYPTION_KEY: string
}

const app = new Hono()
app.route('/a', memoApp)

async function req(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: any; res: Response }> {
  // Hono 마운트: memoApp의 '/'는 '/a'와 정확히 대응한다 ('/a/?q='는 404).
  const fullPath = path === '/' ? '/a' : path.startsWith('/?') ? '/a' + path.slice(1) : `/a${path}`
  const res = await app.request(
    fullPath,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    testEnv as any,
  )
  let parsed: any = null
  try {
    parsed = await res.clone().json()
  } catch {
    /* JSON 아닌 응답 */
  }
  return { status: res.status, body: parsed, res }
}

const SECRET = '블록비밀-7f3a-열쇠'

describe('block lock composed flow (miniflare, real crypto + real D1)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
    // 이 파일의 DB는 격리돼 있지만, 해제 성공 경로는 PIN 미설정 전제다.
    await testDb().prepare('DELETE FROM auth_pins').run()
  })

  it('저장 → lock-block(서버 원자 치환) → 마커 PUT 이후 본문·검색·AI 어디에도 비밀 평문이 없다', async () => {
    const r = await testDb()
      .prepare('INSERT INTO memos (text) VALUES (?)')
      .bind(`공개 앞부분 ${SECRET} 공개 뒷부분`)
      .run()
    const id = Number(r.meta.last_row_id)

    // 0) 실제 클라이언트 순서 1 — 저장: 편집기 직렬화 결과를 먼저 PUT해
    // 서버 본문과 편집 상태를 일치시킨다 (toolbar.js의 저장 → 잠금 순서).
    const save = await req(`/${id}`, 'PUT', {
      text: `공개 앞부분 ${SECRET} 공개 뒷부분`,
    })
    expect(save.status).toBe(200)

    // 1) 실제 클라이언트 순서 2 — 블록 잠금: locked_blocks에는 암호문만,
    // 그리고 D-3로 서버가 본문의 평문을 마커로 이미 치환해 둔다
    // (클라이언트 PUT을 기다리지 않는다).
    const lock = await req(`/${id}/lock-block`, 'POST', { html: SECRET })
    expect(lock.status).toBe(200)
    const blockId = lock.body.blockId as string
    expect(blockId).toMatch(/^blk_/)
    const rawLocked = await testDb()
      .prepare('SELECT text, locked_blocks FROM memos WHERE id = ?')
      .bind(id)
      .first<{ text: string; locked_blocks: string }>()
    expect(rawLocked?.locked_blocks).toContain('ENC:')
    expect(rawLocked?.locked_blocks).not.toContain(SECRET)
    expect(rawLocked?.text).not.toContain(SECRET)
    expect(rawLocked?.text).toBe(`공개 앞부분 [LOCKED_BLOCK:${blockId}] 공개 뒷부분`)

    // 2) 실제 클라이언트 순서 3 — 마커 반영 PUT: 편집기 플레이스홀더를
    // 직렬화한 텍스트(마커 포함)를 PUT한다. 서버 치환 결과와 동일해야 한다.
    const put = await req(`/${id}`, 'PUT', {
      text: `공개 앞부분 [LOCKED_BLOCK:${blockId}] 공개 뒷부분`,
    })
    expect(put.status).toBe(200)
    const raw = await testDb()
      .prepare('SELECT text FROM memos WHERE id = ?')
      .bind(id)
      .first<{ text: string }>()
    expect(raw?.text).not.toContain(SECRET)
    expect(raw?.text).toContain(`[LOCKED_BLOCK:${blockId}]`)

    // 2.5) FTS 인덱스 직접 확인: 비밀 토큰으로 MATCH 해도 0건이어야 한다
    const ftsHit = await testDb()
      .prepare('SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?')
      .bind(`"${SECRET}"`)
      .all()
    expect(ftsHit.results).toHaveLength(0)

    // 3) 소유자 검색: 비밀 문자열로는 이 메모가 본문째 나오지 않는다
    const search = await req(`/?q=${encodeURIComponent(SECRET)}`, 'GET')
    expect(search.status).toBe(200)
    expect(JSON.stringify(search.body)).not.toContain(SECRET)

    // 4) AI 접근 계층: 단건·검색 모두 비밀 미포함
    const accessible = await getAccessibleMemo(testEnv as any, id)
    expect(accessible).not.toBeNull()
    expect(accessible?.content).not.toContain(SECRET)
    expect(accessible?.content).toContain('공개 앞부분')
    const aiSearch = await searchAccessibleMemos(testEnv as any, SECRET, 5)
    for (const hit of aiSearch) {
      expect(hit.snippet).not.toContain(SECRET)
      expect(hit.title).not.toContain(SECRET)
    }

    // 5) 해제 (PIN 미설정 → 면제 정책): 원문 반환 + locked_blocks에서 제거
    const unlock = await req(`/${id}/unlock-block/${blockId}`, 'POST', {})
    expect(unlock.status).toBe(200)
    expect(unlock.body.html).toBe(SECRET)
    const after = await testDb()
      .prepare('SELECT locked_blocks FROM memos WHERE id = ?')
      .bind(id)
      .first<{ locked_blocks: string }>()
    expect(after?.locked_blocks || '').not.toContain(blockId)
  })

  it('lock-block 빈 html → 400, 없는 메모 → 404 (fail-closed 유지)', async () => {
    const empty = await req('/1/lock-block', 'POST', { html: '' })
    expect(empty.status).toBe(400)
    const missing = await req('/999999/lock-block', 'POST', { html: 'x' })
    expect(missing.status).toBe(404)
  })

  it('D-3: html이 본문에 없으면 409 + text·locked_blocks 모두 불변', async () => {
    const r = await testDb()
      .prepare('INSERT INTO memos (text) VALUES (?)')
      .bind('본문에 없는 비밀을 잠그려는 메모')
      .run()
    const id = Number(r.meta.last_row_id)

    const res = await req(`/${id}/lock-block`, 'POST', { html: SECRET })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('block_not_in_text')

    const raw = await testDb()
      .prepare('SELECT text, locked_blocks FROM memos WHERE id = ?')
      .bind(id)
      .first<{ text: string; locked_blocks: string | null }>()
    expect(raw?.text).toBe('본문에 없는 비밀을 잠그려는 메모')
    expect(raw?.locked_blocks ?? '[]').toBe('[]')
  })

  it('D-3: 본문에 여러 번 나오는 html은 전부 마커로 치환된다', async () => {
    const r = await testDb()
      .prepare('INSERT INTO memos (text) VALUES (?)')
      .bind(`${SECRET} 중간 ${SECRET}`)
      .run()
    const id = Number(r.meta.last_row_id)

    const lock = await req(`/${id}/lock-block`, 'POST', { html: SECRET })
    expect(lock.status).toBe(200)
    const raw = await testDb()
      .prepare('SELECT text FROM memos WHERE id = ?')
      .bind(id)
      .first<{ text: string }>()
    expect(raw?.text).not.toContain(SECRET)
    expect(raw?.text).toBe(
      `[LOCKED_BLOCK:${lock.body.blockId}] 중간 [LOCKED_BLOCK:${lock.body.blockId}]`,
    )
  })
})

describe('attachment lock round-trip (fetch stub at Cloudinary boundary only)', () => {
  const PLAIN = '첨부 원본 바이트-9c2e'
  let capturedEncrypted: ArrayBuffer | null = null
  let capturedPlain: ArrayBuffer | null = null
  // D-1: destroy 호출 기록 (public_id + URL에서 파싱한 resource_type)
  let destroyCalls: Array<{ public_id: string; resource_type: string }> = []
  // files.storage_key UNIQUE 대응: 업로드마다 고유 키/URL을 발급한다
  // (파일 DB는 파일 내 테스트가 공유하므로 stubFetch에서 리셋하지 않는다)
  let uploadSeq = 0
  let lastEncKey = ''
  let lastEncUrl = ''
  let lastPlainKey = ''
  let lastPlainUrl = ''
  const realFetch = globalThis.fetch

  function stubFetch() {
    capturedEncrypted = null
    capturedPlain = null
    destroyCalls = []
    ;(globalThis as any).fetch = async (input: any, init?: any) => {
      const url = String(input)
      if (url.includes('api.cloudinary.com') && url.includes('/destroy')) {
        destroyCalls.push({
          public_id: String(init.body.get('public_id')),
          resource_type: url.split('/').slice(-2)[0],
        })
        return new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('api.cloudinary.com')) {
        const file = init.body.get('file') as File
        const bytes = await file.arrayBuffer()
        const folder = String(init.body.get('folder') || '')
        const n = ++uploadSeq
        if (folder === 'myhub/memo-encrypted') {
          capturedEncrypted = bytes
          lastEncKey = `myhub/memo-encrypted/test-enc-${n}`
          lastEncUrl = `https://files.test/enc-${n}.bin`
          return new Response(
            JSON.stringify({
              public_id: lastEncKey,
              secure_url: lastEncUrl,
              resource_type: 'raw',
              bytes: bytes.byteLength,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // 해제 시 복호문 재업로드
        capturedPlain = bytes
        lastPlainKey = `myhub/memo/reuploaded-${n}`
        lastPlainUrl = `https://files.test/reuploaded-${n}.txt`
        return new Response(
          JSON.stringify({
            public_id: lastPlainKey,
            secure_url: lastPlainUrl,
            resource_type: 'raw',
            bytes: bytes.byteLength,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === 'https://files.test/orig.txt') {
        return new Response(new TextEncoder().encode(PLAIN), { status: 200 })
      }
      if (url.startsWith('https://files.test/enc-') && url.endsWith('.bin')) {
        if (!capturedEncrypted) throw new Error('no encrypted capture')
        return new Response(capturedEncrypted, { status: 200 })
      }
      if (url.startsWith('https://files.test/reuploaded-')) {
        if (!capturedPlain) throw new Error('no plain capture')
        return new Response(capturedPlain, { status: 200 })
      }
      throw new Error('unexpected fetch: ' + url)
    }
  }

  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
  })

  let fileSeq = 0
  async function insertFile(memoText: string): Promise<{ fileId: number; origKey: string }> {
    // files.storage_key는 UNIQUE — 테스트마다 고유한 원본 키를 쓴다
    const origKey = `myhub/memo/orig-${++fileSeq}`
    const mr = await testDb().prepare('INSERT INTO memos (text) VALUES (?)').bind(memoText).run()
    const memoId = Number(mr.meta.last_row_id)
    const fr = await testDb()
      .prepare(
        'INSERT INTO files (memo_id, storage_key, filename, mime, size, url, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(memoId, origKey, 'orig.txt', 'text/plain', PLAIN.length, 'https://files.test/orig.txt', 'raw')
      .run()
    return { fileId: Number(fr.meta.last_row_id), origKey }
  }

  it('파일 잠금 → 업로드 바이트는 암호문, /content는 원본으로 복호화된다', async () => {
    const { fileId } = await insertFile('첨부 메모')

    stubFetch()
    const lock = await req(`/files/${fileId}/lock`, 'POST', { locked: true })
    expect(lock.status).toBe(200)
    expect(lock.body.is_locked).toBe(1)

    // 업로드된 바이트는 원본과 다르고(암호문), IV(12) + 태그(16)만큼 길다
    expect(capturedEncrypted).not.toBeNull()
    const encText = new TextDecoder().decode(capturedEncrypted!)
    expect(encText).not.toContain(PLAIN)
    expect(capturedEncrypted!.byteLength).toBeGreaterThan(new TextEncoder().encode(PLAIN).byteLength)

    const row = await testDb()
      .prepare('SELECT is_locked, url FROM files WHERE id = ?')
      .bind(fileId)
      .first<{ is_locked: number; url: string }>()
    expect(row?.is_locked).toBe(1)
    expect(row?.url).toBe(lastEncUrl)

    // 소유자 복호화 서빙
    const content = await req(`/files/${fileId}/content`, 'GET')
    expect(content.status).toBe(200)
    expect(await content.res.text()).toBe(PLAIN)
  })

  it('D-1: 잠금 시 구 평문 키를, 해제 시 .enc 키를 destroy 한다', async () => {
    const { fileId, origKey } = await insertFile('첨부 D-1 메모')

    stubFetch()
    const lock = await req(`/files/${fileId}/lock`, 'POST', { locked: true })
    expect(lock.status).toBe(200)
    expect(lock.body.warning).toBeUndefined()
    // 잠금 전 평문 객체가 파괴돼야 구 URL로 접근할 수 없다
    expect(destroyCalls).toEqual([{ public_id: origKey, resource_type: 'raw' }])

    const unlock = await req(`/files/${fileId}/lock`, 'POST', { locked: false })
    expect(unlock.status).toBe(200)
    expect(unlock.body.is_locked).toBe(0)
    expect(unlock.body.warning).toBeUndefined()
    // 해제 후에는 암호문 객체(.enc 키)도 고아로 남기지 않는다
    expect(destroyCalls).toEqual([
      { public_id: origKey, resource_type: 'raw' },
      { public_id: lastEncKey, resource_type: 'raw' },
    ])

    const row = await testDb()
      .prepare('SELECT is_locked, url, storage_key FROM files WHERE id = ?')
      .bind(fileId)
      .first<{ is_locked: number; url: string; storage_key: string }>()
    expect(row?.is_locked).toBe(0)
    expect(row?.url).toBe(lastPlainUrl)
    expect(row?.storage_key).toBe(lastPlainKey)
    // 재업로드된 바이트는 원본과 동일하다 (복호화 왕복)
    expect(new TextDecoder().decode(capturedPlain!)).toBe(PLAIN)
  })

  it('D-2: 잠긴 파일 GET은 /content로, 열린 파일 GET은 원본 URL로 302', async () => {
    const { fileId } = await insertFile('첨부 D-2 메모')

    stubFetch()
    const lock = await req(`/files/${fileId}/lock`, 'POST', { locked: true })
    expect(lock.status).toBe(200)

    const lockedGet = await req(`/files/${fileId}`, 'GET')
    expect(lockedGet.status).toBe(302)
    expect(lockedGet.res.headers.get('Location')).toBe(`/api/memo/files/${fileId}/content`)

    const unlock = await req(`/files/${fileId}/lock`, 'POST', { locked: false })
    expect(unlock.status).toBe(200)

    const openGet = await req(`/files/${fileId}`, 'GET')
    expect(openGet.status).toBe(302)
    expect(openGet.res.headers.get('Location')).toBe(lastPlainUrl)
  })
})
