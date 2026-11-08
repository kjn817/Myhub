/**
 * F2 복구 트랙 실런타임 테스트 (2026-11-07) — 운영 QA 실패 4건의 서버 계약 고정.
 *
 * 배경: 재구축본 운영 QA에서 Finder 목록·채팅 전송·일정 렌더링·스튜디오
 * 삭제/게시가 실패했다. 원인은 전부 프론트-서버 계약 불일치였다:
 * - Finder 프론트가 존재하지 않는 GET /api/drive/tree를 호출 (서버 계약은
 *   /list·/recent·/trash 분리). 아래 테스트는 실제 라우트가 그 계약대로
 *   동작하고 /tree는 없음을 고정한다 — 프론트가 다시 /tree를 부르면
 *   f2-frontend.test.ts의 계약 검사가, 서버가 계약을 바꾸면 이 테스트가 잡는다.
 * - 일정·아티팩트 서버 라우트는 원래 정상이었다 (대조군으로 고정).
 * - /schedule.html·/chat.html은 enforce CSP(script-src 'self') 대상인데
 *   재구축본이 인라인 스크립트·CDN 스크립트를 넣어 운영에서 페이지 전체가
 *   죽었다. 서빙 HTML이 그 계약(인라인 0·외부 출처 0)을 지키는지 고정한다.
 *
 * 운영 DB에는 닿지 않는다 (파일마다 격리된 로컬 SQLite).
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

  const db = testDb()
  // Drive 시드: 루트 파일 1, 폴더 1 + 폴더 안 파일 1, 휴지통 파일 1
  const folder = await db.prepare('INSERT INTO drive_folders (name, parent_id) VALUES (?, NULL)').bind('업무').run()
  const folderId = Number(folder.meta.last_row_id)
  await db.prepare(
    'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type) VALUES (NULL, ?, ?, ?, ?, ?, ?)'
  ).bind('sk-root', '루트문서.pdf', 'application/pdf', 2048, 'https://example.com/root.pdf', 'raw').run()
  await db.prepare(
    'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(folderId, 'sk-in', '폴더문서.xlsx', 'application/octet-stream', 1024, 'https://example.com/in.xlsx', 'raw').run()
  await db.prepare(
    "INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type, deleted_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).bind('sk-trash', '버린파일.txt', 'text/plain', 128, 'https://example.com/t.txt', 'raw').run()

  // 아티팩트 시드 (삭제·게시 대조군): 소유자는 세션 이메일과 같아야 한다
  const art = await db.prepare(
    "INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES (?, 'html', 'draft', '', 1, ?, ?)"
  ).bind('F2 테스트 프로젝트', '<html></html>', TEST_EMAIL).run()
  const artId = Number(art.meta.last_row_id)
  const ver = await db.prepare(
    "INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type) VALUES (?, 1, ?, ?, 'v1', 'nova')"
  ).bind(artId, '<html></html>', 'deadbeef').run()
  await db.prepare('UPDATE artifacts SET draft_version_id = ? WHERE id = ?').bind(Number(ver.meta.last_row_id), artId).run()
  ;(globalThis as any).__f2ArtId = artId
})

describe('F2-1 Drive 목록 계약 (Finder)', () => {
  it('GET /api/drive/list — 루트 목록에 폴더·파일이 filename으로 온다', async () => {
    const res = await call('/api/drive/list')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.folders.map((f: any) => f.name)).toContain('업무')
    const names = body.files.map((f: any) => f.filename)
    expect(names).toContain('루트문서.pdf')
    expect(names).not.toContain('버린파일.txt') // 휴지통 파일은 목록에서 제외
  })

  it('GET /api/drive/list?folder=<id> — 폴더 안 파일이 온다', async () => {
    const root = (await (await call('/api/drive/list')).json()) as any
    const folderId = root.folders[0].id
    const res = await call(`/api/drive/list?folder=${folderId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.folder.name).toBe('업무')
    expect(body.files.map((f: any) => f.filename)).toEqual(['폴더문서.xlsx'])
  })

  it('GET /api/drive/recent·/trash·/usage 가 각각 동작한다', async () => {
    const recent = (await (await call('/api/drive/recent')).json()) as any
    expect(recent.ok).toBe(true)
    expect(recent.files.some((f: any) => f.filename === '폴더문서.xlsx' && f.folder_name === '업무')).toBe(true)

    const trashRes = await call('/api/drive/trash')
    expect(trashRes.status).toBe(200)
    const trash = (await trashRes.json()) as any
    expect(trash.files.map((f: any) => f.filename)).toContain('버린파일.txt')
    expect(trash.files.find((f: any) => f.filename === '버린파일.txt').via_folder).toBe(false)

    const usage = (await (await call('/api/drive/usage')).json()) as any
    expect(usage).toMatchObject({ ok: true, files: 2, bytes: 3072 })
  })

  it('GET /api/drive/tree 는 존재하지 않는다 (프론트가 부르면 404)', async () => {
    const res = await call('/api/drive/tree?folder=root')
    expect(res.status).toBe(404)
  })

  it('이름 변경은 POST /files/:id/rename 이고 PATCH 방식은 없다', async () => {
    const root = (await (await call('/api/drive/list')).json()) as any
    const fileId = root.files[0].id
    const patch = await call(`/api/drive/files/${fileId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x.pdf' }),
    })
    expect([404, 405]).toContain(patch.status)
    const post = await call(`/api/drive/files/${fileId}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '바꾼이름.pdf' }),
    })
    expect(post.status).toBe(200)
    const after = (await (await call('/api/drive/list')).json()) as any
    expect(after.files.map((f: any) => f.filename)).toContain('바꾼이름.pdf')
  })
})

describe('F2-3 일정 서버 계약 (대조군 — 서버는 정상이었다)', () => {
  it('POST /create → GET /list 왕복이 된다', async () => {
    const create = await call('/api/schedule/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'F2 QA 일정', start_at: '2026-11-07T22:00', end_at: '2026-11-07T23:00' }),
    })
    expect(create.status).toBe(200)
    const created = (await create.json()) as any
    expect(created.ok).toBe(true)
    expect(typeof created.id).toBe('number')

    const list = (await (await call('/api/schedule/list?from=2026-11-01&to=2026-11-30&status=active&limit=500')).json()) as any
    expect(list.ok).toBe(true)
    expect(list.schedules.some((s: any) => s.id === created.id && s.title === 'F2 QA 일정')).toBe(true)
  })
})

describe('F2-4 아티팩트 삭제·게시 서버 계약 (대조군 — 서버는 정상이었다)', () => {
  it('POST /:id/publish 후 DELETE /:id 가 실제로 지운다', async () => {
    const artId = (globalThis as any).__f2ArtId as number
    const pub = await call(`/api/artifact/${artId}/publish`, { method: 'POST' })
    expect(pub.status).toBe(200)
    expect(((await pub.json()) as any).ok).toBe(true)

    const del = await call(`/api/artifact/${artId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(((await del.json()) as any).ok).toBe(true)

    const after = await call(`/api/artifact/${artId}`)
    expect(after.status).toBe(404)
  })
})

describe('F2-2·F2-3 enforce CSP 페이지의 스크립트 계약', () => {
  // 인라인 <script>(src 없음) 또는 외부 출처 script가 있으면 운영 브라우저가
  // 실행을 차단해 페이지가 통째로 죽는다 — 재구축 회귀의 직접 원인.
  const INLINE_OR_EXTERNAL = /<script(?![^>]*\bsrc\s*=\s*["']\/)[^>]*>/i
  for (const page of ['/schedule.html', '/chat.html']) {
    it(`${page}: enforce CSP 유지 + 인라인·외부 스크립트 0`, async () => {
      // CSP는 워커가 .html 경로에 붙이는 첫 응답에서 확인한다.
      // (miniflare 에셋 워커는 htmlHandling을 이 플러그인 경로에서 반영하지
      // 못해 307을 내므로, 본문은 Location을 한 번 따라가 받아 확인한다.
      // 운영은 deploy의 html_handling='none'으로 200 직행이다.)
      const res = await call(page)
      expect([200, 307]).toContain(res.status)
      const csp = res.headers.get('Content-Security-Policy') || ''
      // script-src 지시자만 떼어 본다 (style-src-attr 'unsafe-inline'은 별개로 정당)
      const scriptSrc = (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) || '')
      expect(scriptSrc).toContain("'self'")
      expect(scriptSrc).not.toContain("'unsafe-inline'")
      let html: string
      if (res.status === 307) {
        const loc = res.headers.get('Location')
        expect(loc).toBeTruthy()
        const followed = await call(loc as string)
        expect(followed.status).toBe(200)
        html = await followed.text()
      } else {
        html = await res.text()
      }
      expect(html).not.toMatch(INLINE_OR_EXTERNAL)
    })
  }

  it('/chat.html 이 참조하는 로컬 벤더 스크립트가 실제로 서빙된다', async () => {
    for (const src of ['/vendor/marked.umd.js', '/vendor/highlight.min.js', '/vendor/purify.min.js']) {
      const res = await call(src)
      expect(res.status).toBe(200)
    }
    const sched = await call('/js/schedule.js')
    expect(sched.status).toBe(200)
  })
})
