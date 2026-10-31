/**
 * 인증 미들웨어 실런타임 테스트 (트랙 C7, 2-7절).
 *
 * Jest mock이 검증하지 못하는 것 — 실제 workerd에서의 동작을 확인한다:
 * - `c.req.path.split('?')[0]` 경로 체크 (2026-10-16 `/login.html?v=xxx`
 *   리다이렉트 루프의 재발 방지 — 쿼리스트링이 붙어도 공개 경로는 공개,
 *   API는 401이어야 한다)
 * - HMAC 세션 토큰의 실제 검증 (WebCrypto subtle + D1 session_versions
 *   버전 대조 — fake-d1 mock으로는 검증되지 않는 경로)
 * - 미들웨어 401과 라우트 자체 401의 구분 (`/api/auth/me`는 미들웨어를
 *   통과해 라우트에서 401을 내야 한다)
 *
 * OTP·PIN 라이브 호출 없음. 토큰은 테스트 전용 SESSION_SECRET으로 직접
 * 민트한다 (createSession과 같은 HMAC-SHA256 형식).
 */
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyAllMigrations } from './helpers/apply-migrations'

const testEnv = env as unknown as { SESSION_SECRET: string }
// `exports.default.fetch`는 메서드로 호출해야 한다 — 변수로 떼어내면
// workerd에서 Illegal invocation이 된다.
const worker = exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }

const TEST_EMAIL = 'runtime-test@myhub.local'

/** src/modules/auth/routes.ts createSession과 같은 형식의 세션 토큰을 만든다. */
async function mintSessionToken(
  email: string,
  secret: string,
  opts: { exp?: number; version?: number } = {},
): Promise<string> {
  const exp = opts.exp ?? Date.now() + 30 * 24 * 60 * 60 * 1000
  const payload = JSON.stringify({ email, exp, method: 'pin', v: opts.version ?? 0 })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

async function call(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  // redirect: 'manual' — 워커가 내는 원 응답(302 Location 포함)을 그대로 봐야 한다.
  // follow(기본값)이면 / → /login.html → ... 체인을 따라가 버린다.
  return worker.default.fetch(
    new Request(`http://localhost${path}`, { headers, redirect: 'manual' }),
  )
}

describe('auth middleware (miniflare)', () => {
  beforeAll(async () => {
    // session_versions 테이블이 없으면 모든 세션이 fail-closed로 거부된다
    // (0051 배포 게이트) — 긍정 케이스를 위해 전체 마이그레이션을 적용한다.
    await applyAllMigrations()
  })

  it('공개 경로 /api/health는 쿠키 없이 200', async () => {
    const res = await call('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; app: string }
    expect(body.ok).toBe(true)
    expect(body.app).toBe('MyHub')
  })

  it('쿼리스트링이 붙은 공개 경로도 200 (/api/health?x=1)', async () => {
    const res = await call('/api/health?cache=bust')
    expect(res.status).toBe(200)
  })

  it('미인증 API 요청은 401 (미들웨어 거부)', async () => {
    const res = await call('/api/memos')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body).toEqual({ ok: false, error: '인증 필요' })
  })

  it('쿼리스트링이 붙은 미인증 API도 401 — 경로 체크가 ? 뒤를 떼는지 확인', async () => {
    // 2026-10-16 결함: split('?')[0] 없이 비교하면 /api/memos?v=1이
    // API가 아닌 페이지로 취급돼 302 리다이렉트 루프를 탔다.
    const res = await call('/api/memos?v=1')
    expect(res.status).toBe(401)
  })

  it('쿼리스트링이 붙은 /login.html은 미들웨어 302를 내지 않는다 (루프 재발 방지)', async () => {
    const res = await call('/login.html?v=123')
    // 2026-10-16 결함: 미들웨어가 /login.html?v=xxx를 공개 경로로 인식하지
    // 못하면 302 Location: /login.html을 내어 리다이렉트 루프를 탔다.
    // miniflare의 에셋 라우터는 .html → 확장자 없는 URL로 307 정규화를 해서
    // 200이 아니라 307 Location: /login이 온다 — 운영은 /login.html을 인라인
    // 라우트에서 직접 서빙하므로 200이다. 여기서 검증하는 것은 "미들웨어가
    // 통과시켰는가"이지 에셋 라우터의 정규화 동작이 아니다.
    expect(res.status).not.toBe(302)
    expect(res.headers.get('location')).not.toBe('/login.html')
  })

  it('쿼리스트링이 붙은 공개 에셋은 200으로 서빙된다 (/manifest.json?v=1)', async () => {
    const res = await call('/manifest.json?v=1')
    expect(res.status).toBe(200)
  })

  it('미인증 루트 요청은 /login.html로 302', async () => {
    const res = await call('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login.html')
  })

  it('/api/auth/me는 미들웨어를 통과해 라우트 자체에서 401 (미들웨어 401과 구분)', async () => {
    const res = await call('/api/auth/me')
    expect(res.status).toBe(401)
    // 미들웨어 401은 { ok:false, error:'인증 필요' }이고,
    // /me 라우트 401은 { ok:false }이다 — body로 통과 여부를 구분한다.
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ ok: false })
  })

  it('유효한 세션 쿠키면 보호 API가 200', async () => {
    const token = await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)
    const res = await call('/api/modules', `myhub_session=${token}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string }>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })

  it('유효한 세션으로 /api/auth/me는 200 + 이메일 반환', async () => {
    const token = await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)
    const res = await call('/api/auth/me', `myhub_session=${token}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; email: string; hasPin: boolean }
    expect(body.ok).toBe(true)
    expect(body.email).toBe(TEST_EMAIL)
    expect(body.hasPin).toBe(false)
  })

  it('서명이 변조된 토큰은 401', async () => {
    const token = await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)
    const [payload, sig] = token.split('.')
    const tampered = `${payload}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`
    const res = await call('/api/modules', `myhub_session=${tampered}`)
    expect(res.status).toBe(401)
  })

  it('만료된 토큰은 401', async () => {
    const token = await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET, {
      exp: Date.now() - 1000,
    })
    const res = await call('/api/modules', `myhub_session=${token}`)
    expect(res.status).toBe(401)
  })

  it('세션 버전이 D1 카운터와 다르면 401 (버전 대조)', async () => {
    // D1에 행이 없어 현재 버전은 0 — v:99 토큰은 거부돼야 한다.
    const token = await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET, { version: 99 })
    const res = await call('/api/modules', `myhub_session=${token}`)
    expect(res.status).toBe(401)
  })
})
