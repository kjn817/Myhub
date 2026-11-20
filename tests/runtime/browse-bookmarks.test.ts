/**
 * 브라우저 북마크·방문 기록 실런타임 테스트 (2026-11-20, 브라우저 1단계).
 *
 * miniflare(실제 workerd 런타임)에서 전체 Worker를 통과해 검증한다:
 * - 0080 마이그레이션이 전수 적용 집합 안에서 깨끗이 적용된다
 *   (applyAllMigrations failed 0 — 실패하면 여기서 잡힌다).
 * - 인증된 GET /api/browse/bookmarks가 시드 6개를 돌려준다.
 * - 인증된 POST /bookmarks·POST /history·GET /history가 실제 D1에서
 *   동작한다 (POST 북마크는 DoH 조회를 건너뛰는 공인 IP 리터럴 URL로
 *   해서 miniflare egress 의존성을 없앤다).
 * - 미인증 요청은 401이다 (전역 세션 미들웨어 경계).
 *
 * 운영 DB에는 닿지 않는다 (파일마다 격리된 로컬 SQLite).
 */
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyAllMigrations } from './helpers/apply-migrations'

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
async function call(path: string, init: RequestInit = {}, authed = true): Promise<Response> {
  const headers = new Headers(init.headers)
  if (authed && cookie) headers.set('Cookie', cookie)
  return worker.default.fetch(new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }))
}

beforeAll(async () => {
  const result = await applyAllMigrations()
  expect(result.failed).toHaveLength(0)
  const token = await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)
  cookie = `myhub_session=${token}`
})

describe('브라우저 북마크·방문 기록 (실런타임)', () => {
  it('GET /api/browse/bookmarks — 인증 시 시드 6개, 미인증 시 401', async () => {
    const res = await call('/api/browse/bookmarks')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.bookmarks).toHaveLength(6)
    expect(body.bookmarks.map((b: any) => b.title)).toEqual([
      'NAVER',
      'Google',
      'YouTube',
      'ChatGPT',
      'GitHub',
      '위키백과',
    ])
    const anon = await call('/api/browse/bookmarks', {}, false)
    expect(anon.status).toBe(401)
  })

  it('POST /bookmarks → GET 목록에 나타나고, POST /history → GET /history에 남는다', async () => {
    // 공인 IP 리터럴 URL은 DoH 조회를 건너뛰어 miniflare에서 결정적이다.
    const created = await call('/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://93.184.216.34/', title: 'IP 북마크' }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as any
    expect(createdBody.bookmark.title).toBe('IP 북마크')
    const list = await call('/api/browse/bookmarks')
    const listBody = (await list.json()) as any
    expect(listBody.bookmarks).toHaveLength(7)

    const hist = await call('/api/browse/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://93.184.216.34/docs', title: 'IP 문서' }),
    })
    expect(hist.status).toBe(200)
    const histList = await call('/api/browse/history')
    const histBody = (await histList.json()) as any
    expect(histBody.history.map((h: any) => h.url)).toContain('https://93.184.216.34/docs')
  })
})
