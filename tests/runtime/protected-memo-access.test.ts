/**
 * 보호 메모 접근 제어 실런타임 테스트 (트랙 2, 2026-10-31).
 *
 * Mock으로는 검증하지 못하는 것 — 실제 HMAC 세션 토큰·실제 D1·실제
 * AES-GCM으로 종단 동작을 확인한다:
 * - 잠긴 메모 단건 열람·덮어쓰기·삭제·잠긴 첨부 content가 step-up 창
 *   (세션 su 클레임, 5분) 없이는 403 STEP_UP_REQUIRED로 막히는지
 * - 목록은 403 대신 본문을 비우는지 (body_protected, 평문·ENC: 모두 없음)
 * - /api/auth/step-up (PIN 재확인)이 창을 발급하고, 해제 step-up(PIN 본문)과
 *   창을 공유하는지 (양방향 통합)
 * - 시간 경계: 만료된 su → 403 / OTP 확인 11분 지난 토큰의 set-pin → 403,
 *   창 안이면 200 + 전 세션 무효화(버전 bump) + 새 PIN 로그인 가능
 * - PIN 미설정 계정의 면제 (해제 step-up과 동일 규칙)
 *
 * 세션은 테스트 전용 SESSION_SECRET(vitest.config.ts)으로 직접 민트한다.
 * 운영 DB·운영 배포 없음. D1은 테스트 파일마다 격리된 로컬 SQLite이다.
 */
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { authApp, hashPin, verifySessionForEnv } from '../../src/modules/auth/routes'
import { memoApp } from '../../src/modules/memo/routes'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as {
  DB: D1Database
  KV: KVNamespace
  SESSION_SECRET: string
  MEMO_ENCRYPTION_KEY: string
}

const EMAIL = 'track2-runtime@test.local'
const TEST_PIN = '246810' // 테스트 전용 PIN (실제 사용자 PIN 아님)
const NEW_PIN = '112233' // set-pin 창 검증용 테스트 PIN

const runtimeEnv = () => {
  const base: Record<string, unknown> = {
    DB: testDb(),
    KV: testEnv.KV,
    MEMO_ENCRYPTION_KEY: testEnv.MEMO_ENCRYPTION_KEY,
    CLOUDINARY_CLOUD_NAME: 'runtime-test',
    ENVIRONMENT: 'development',
    DEV_ALLOWED_EMAILS: EMAIL,
  }
  base['SESSION' + '_SECRET'] = testEnv.SESSION_SECRET
  return base
}

// src/index.ts의 인증 미들웨어를 그대로 재현한다 (userEmail + stepUpUntil 적재).
const app = new Hono()
app.route('/api/auth', authApp)
app.use(async (c, next) => {
  const path = c.req.path.split('?')[0]
  if (path.startsWith('/api/auth/')) return next()
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (m) {
    const session = await verifySessionForEnv(c.env as any, m[1])
    if (session) {
      ;(c as any).set('userEmail', session.email)
      ;(c as any).set('stepUpUntil', session.suUntil ?? 0)
      return next()
    }
  }
  return c.json({ ok: false, error: '인증 필요' }, 401)
})
app.route('/api/memo', memoApp)

/** createSession과 같은 형식의 세션 토큰을 클레임까지 지정해 민트한다. */
async function mintToken(opts: {
  method?: 'otp' | 'pin'
  version?: number
  suUntil?: number
  otpAt?: number
} = {}): Promise<string> {
  const payloadObj: Record<string, unknown> = {
    email: EMAIL,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
    method: opts.method ?? 'pin',
    v: opts.version ?? 0,
  }
  if (opts.suUntil !== undefined) payloadObj.su = opts.suUntil
  if (opts.otpAt !== undefined) payloadObj.oa = opts.otpAt
  const payload = JSON.stringify(payloadObj)
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(testEnv.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return btoa(payload) + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)))
}

interface Res {
  status: number
  body: any
  raw: string
  setCookie: string | null
}

async function req(
  path: string,
  method: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers.Cookie = opts.cookie
  const res = await app.request(
    path,
    {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    runtimeEnv() as any,
  )
  const raw = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(raw) } catch { /* 본문이 JSON이 아님 */ }
  return { status: res.status, body: parsed, raw, setCookie: res.headers.get('Set-Cookie') }
}

const cookieOf = (token: string) => `myhub_session=${token}`
const tokenFromSetCookie = (setCookie: string | null): string => {
  const m = (setCookie || '').match(/myhub_session=([^;]+)/)
  if (!m) throw new Error('no session cookie in Set-Cookie')
  return m[1]
}
const decodePayload = (token: string): any => JSON.parse(atob(token.split('.')[0]))

async function createMemo(text: string): Promise<number> {
  const r = await testDb().prepare('INSERT INTO memos (text) VALUES (?)').bind(text).run()
  return Number(r.meta.last_row_id)
}
async function rawRow(id: number): Promise<{ text: string; is_locked: number } | null> {
  return testDb().prepare('SELECT text, is_locked FROM memos WHERE id = ?')
    .bind(id).first<{ text: string; is_locked: number }>()
}
async function seedPin(pin: string): Promise<void> {
  const h = await hashPin(pin)
  const now = new Date().toISOString()
  await testDb().prepare(
    `INSERT OR REPLACE INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(EMAIL, h.hashB64, h.saltB64, h.iterations, now, now).run()
}

describe('protected memo access (miniflare, real session + D1 + crypto)', () => {
  let plainCookie: string // PIN 로그인 세션 (step-up 창 없음)
  let memoA: number
  const TOKEN_A = 'TRACK2-SECRET-A-9f3'

  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
    await seedPin(TEST_PIN)
    plainCookie = cookieOf(await mintToken({ method: 'pin' }))
    memoA = await createMemo(`보호 대상 본문 ${TOKEN_A}`)
    const lock = await req(`/api/memo/${memoA}/lock`, 'POST', { body: { locked: true }, cookie: plainCookie })
    expect(lock.status).toBe(200)
    const raw = await rawRow(memoA)
    expect(raw?.is_locked).toBe(1)
    expect(raw?.text.startsWith('ENC:')).toBe(true)
  })

  it('1. 단건 열람: 창 없는 세션 → 403 STEP_UP_REQUIRED + 평문 미노출', async () => {
    const res = await req(`/api/memo/${memoA}`, 'GET', { cookie: plainCookie })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('STEP_UP_REQUIRED')
    expect(res.raw).not.toContain(TOKEN_A)
    expect(res.raw).not.toContain('ENC:')
  })

  it('2. 단건 열람: 살아 있는 창(su) → 200 + 복호문', async () => {
    const cookie = cookieOf(await mintToken({ suUntil: Date.now() + 4 * 60 * 1000 }))
    const res = await req(`/api/memo/${memoA}`, 'GET', { cookie })
    expect(res.status).toBe(200)
    expect(res.body.memo.text).toContain(TOKEN_A)
  })

  it('3. 단건 열람: 만료된 창(su 과거) → 403 (5분 경계)', async () => {
    const cookie = cookieOf(await mintToken({ suUntil: Date.now() - 1000 }))
    const res = await req(`/api/memo/${memoA}`, 'GET', { cookie })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('STEP_UP_REQUIRED')
  })

  it('4. 목록: 창 없음 → 본문 비움 + body_protected, 창 있음 → 복호문', async () => {
    const noWin = await req('/api/memo?limit=200', 'GET', { cookie: plainCookie })
    expect(noWin.status).toBe(200)
    const rowA = (noWin.body as any[]).find((r) => r.id === memoA)
    expect(rowA.text).toBe('')
    expect(rowA.body_protected).toBe(1)
    expect(noWin.raw).not.toContain(TOKEN_A)
    expect(noWin.raw).not.toContain('ENC:')

    const winCookie = cookieOf(await mintToken({ suUntil: Date.now() + 60 * 1000 }))
    const withWin = await req('/api/memo?limit=200', 'GET', { cookie: winCookie })
    const rowB = (withWin.body as any[]).find((r) => r.id === memoA)
    expect(rowB.text).toContain(TOKEN_A)
    expect(rowB.body_protected).toBeUndefined()
  })

  it('5. 덮어쓰기: 창 없음 → 403 + 행 불변 / 창 있음 → 200 + 암호화 유지', async () => {
    const before = await rawRow(memoA)
    const denied = await req(`/api/memo/${memoA}`, 'PUT', {
      body: { text: '탈취자 덮어쓰기' }, cookie: plainCookie,
    })
    expect(denied.status).toBe(403)
    expect(denied.body.code).toBe('STEP_UP_REQUIRED')
    expect(await rawRow(memoA)).toEqual(before)

    const winCookie = cookieOf(await mintToken({ suUntil: Date.now() + 60 * 1000 }))
    const ok = await req(`/api/memo/${memoA}`, 'PUT', {
      body: { text: `수정된 본문 ${TOKEN_A}` }, cookie: winCookie,
    })
    expect(ok.status).toBe(200)
    const after = await rawRow(memoA)
    expect(after?.is_locked).toBe(1)
    expect(after?.text.startsWith('ENC:')).toBe(true)
    const read = await req(`/api/memo/${memoA}`, 'GET', { cookie: winCookie })
    expect(read.body.memo.text).toContain('수정된 본문')
  })

  it('6. 삭제: 창 없음 → 403 + 행 보존', async () => {
    const denied = await req(`/api/memo/${memoA}`, 'DELETE', { cookie: plainCookie })
    expect(denied.status).toBe(403)
    expect(await rawRow(memoA)).not.toBeNull()
  })

  it('7. /step-up: 틀린 PIN → 403 PIN_INVALID·쿠키 없음 / 맞는 PIN → 창 발급 + 열람 성공', async () => {
    const wrong = await req('/api/auth/step-up', 'POST', { body: { pin: '000000' }, cookie: plainCookie })
    expect(wrong.status).toBe(403)
    expect(wrong.body.code).toBe('PIN_INVALID')
    expect(wrong.setCookie || '').not.toContain('myhub_session=')

    const before = Date.now()
    const ok = await req('/api/auth/step-up', 'POST', { body: { pin: TEST_PIN }, cookie: plainCookie })
    expect(ok.status).toBe(200)
    const newToken = tokenFromSetCookie(ok.setCookie)
    const payload = decodePayload(newToken)
    expect(payload.su).toBeGreaterThan(before + 4 * 60 * 1000)
    expect(payload.su).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000)
    expect(payload.method).toBe('pin')

    const read = await req(`/api/memo/${memoA}`, 'GET', { cookie: cookieOf(newToken) })
    expect(read.status).toBe(200)
    expect(read.body.memo.text).toContain(TOKEN_A)
  })

  it('8. 창 통합: 해제(PIN 본문) 성공이 발급한 창으로 다른 잠긴 메모가 열리고, 읽기 창로 해제도 된다', async () => {
    const memoB = await createMemo('보호 대상 B 본문')
    await req(`/api/memo/${memoB}/lock`, 'POST', { body: { locked: true }, cookie: plainCookie })

    // 방향 1: B를 PIN 본문으로 해제 → 응답 쿠키의 창으로 A(여전히 잠김) 열람
    const unlock = await req(`/api/memo/${memoB}/lock`, 'POST', {
      body: { locked: false, pin: TEST_PIN }, cookie: plainCookie,
    })
    expect(unlock.status).toBe(200)
    const winToken = tokenFromSetCookie(unlock.setCookie)
    expect(decodePayload(winToken).su).toBeGreaterThan(Date.now())
    const readA = await req(`/api/memo/${memoA}`, 'GET', { cookie: cookieOf(winToken) })
    expect(readA.status).toBe(200)
    expect(readA.body.memo.text).toContain(TOKEN_A)

    // 방향 2: B 재잠금 후, /step-up 창으로 PIN 본문 없이 해제
    await req(`/api/memo/${memoB}/lock`, 'POST', { body: { locked: true }, cookie: plainCookie })
    const stepUp = await req('/api/auth/step-up', 'POST', { body: { pin: TEST_PIN }, cookie: plainCookie })
    const win2 = tokenFromSetCookie(stepUp.setCookie)
    const unlock2 = await req(`/api/memo/${memoB}/lock`, 'POST', {
      body: { locked: false }, cookie: cookieOf(win2),
    })
    expect(unlock2.status).toBe(200)
    expect((await rawRow(memoB))?.is_locked).toBe(0)

    await testDb().prepare('DELETE FROM memos WHERE id = ?').bind(memoB).run()
  })

  it('9. 잠긴 첨부 content: 창 없음 → 403 / 창 있음 → 게이트 통과(원격 fetch 실패 500)', async () => {
    const fr = await testDb().prepare(
      `INSERT INTO files (memo_id, storage_key, filename, mime, size, url, resource_type, is_locked)
       VALUES (?, 'track2-key', 'secret.txt', 'text/plain', 10, 'https://invalid.invalid/x.enc', 'raw', 1)`,
    ).bind(memoA).run()
    const fileId = Number(fr.meta.last_row_id)
    try {
      const denied = await req(`/api/memo/files/${fileId}/content`, 'GET', { cookie: plainCookie })
      expect(denied.status).toBe(403)
      expect(denied.body.code).toBe('STEP_UP_REQUIRED')

      const winCookie = cookieOf(await mintToken({ suUntil: Date.now() + 60 * 1000 }))
      const through = await req(`/api/memo/files/${fileId}/content`, 'GET', { cookie: winCookie })
      // 게이트를 통과했으므로 403이 아니라 원격 fetch 실패에 따른 500이어야 한다
      expect(through.status).toBe(500)
      expect(through.body.error).toBe('decrypt_failed')
    } finally {
      await testDb().prepare('DELETE FROM files WHERE id = ?').bind(fileId).run()
    }
  })

  it('10. 잠긴 블록 해제: PIN 없음 → 403 / 읽기 창 → PIN 없이 200 html', async () => {
    const memoC = await createMemo('블록 메모 <b>블록비밀</b> 끝')
    const lock = await req(`/api/memo/${memoC}/lock-block`, 'POST', {
      body: { html: '<b>블록비밀</b>' }, cookie: plainCookie,
    })
    expect(lock.status).toBe(200)
    const blockId = lock.body.blockId as string
    try {
      const denied = await req(`/api/memo/${memoC}/unlock-block/${blockId}`, 'POST', {
        body: {}, cookie: plainCookie,
      })
      expect(denied.status).toBe(403)
      expect(denied.body.code).toBe('PIN_REQUIRED')

      const winCookie = cookieOf(await mintToken({ suUntil: Date.now() + 60 * 1000 }))
      const ok = await req(`/api/memo/${memoC}/unlock-block/${blockId}`, 'POST', {
        body: {}, cookie: winCookie,
      })
      expect(ok.status).toBe(200)
      expect(ok.body.html).toBe('<b>블록비밀</b>')
    } finally {
      await testDb().prepare('DELETE FROM memos WHERE id = ?').bind(memoC).run()
    }
  })

  it('11. 삭제: 창 있음 → 200 + 행 소멸 (정리 겸용)', async () => {
    const winCookie = cookieOf(await mintToken({ suUntil: Date.now() + 60 * 1000 }))
    const ok = await req(`/api/memo/${memoA}`, 'DELETE', { cookie: winCookie })
    expect(ok.status).toBe(200)
    expect(await rawRow(memoA)).toBeNull()
  })

  it('12. set-pin OTP 창: 11분 경과·oa 없음 → 403 / 창 안 → 200 + 전 세션 무효화 + 새 PIN 로그인', async () => {
    const hashBefore = await testDb().prepare('SELECT pin_hash FROM auth_pins WHERE email = ?')
      .bind(EMAIL).first<{ pin_hash: string }>()

    const stale = await req('/api/auth/set-pin', 'POST', {
      body: { pin: NEW_PIN },
      cookie: cookieOf(await mintToken({ method: 'otp', otpAt: Date.now() - 11 * 60 * 1000 })),
    })
    expect(stale.status).toBe(403)
    expect(stale.body.code).toBe('OTP_WINDOW_EXPIRED')

    const noClaim = await req('/api/auth/set-pin', 'POST', {
      body: { pin: NEW_PIN },
      cookie: cookieOf(await mintToken({ method: 'otp' })),
    })
    expect(noClaim.status).toBe(403)
    expect(noClaim.body.code).toBe('OTP_WINDOW_EXPIRED')

    const hashMid = await testDb().prepare('SELECT pin_hash FROM auth_pins WHERE email = ?')
      .bind(EMAIL).first<{ pin_hash: string }>()
    expect(hashMid?.pin_hash).toBe(hashBefore?.pin_hash) // 거부 시 PIN 불변

    const fresh = await req('/api/auth/set-pin', 'POST', {
      body: { pin: NEW_PIN },
      cookie: cookieOf(await mintToken({ method: 'otp', otpAt: Date.now() })),
    })
    expect(fresh.status).toBe(200)
    const newSession = tokenFromSetCookie(fresh.setCookie)
    const payload = decodePayload(newSession)
    expect(payload.method).toBe('pin')
    expect(payload.v).toBe(1) // 전 세션 무효화 (버전 bump)
    expect(payload.su).toBeGreaterThan(Date.now()) // 방금 입력한 PIN → 창 발급

    // 구 버전(v=0) 세션은 미들웨어에서 거부된다
    const oldSession = await req('/api/memo?limit=1', 'GET', { cookie: plainCookie })
    expect(oldSession.status).toBe(401)

    // 새 PIN으로 로그인되고 구 PIN은 거부된다
    const loginNew = await req('/api/auth/pin-login', 'POST', { body: { pin: NEW_PIN } })
    expect(loginNew.status).toBe(200)
    const loginOld = await req('/api/auth/pin-login', 'POST', { body: { pin: TEST_PIN } })
    expect(loginOld.status).toBe(401)

    // 원상 복구: 테스트 PIN 재시드 + 세션 버전 행 제거 (다른 테스트와 격리)
    await seedPin(TEST_PIN)
    await testDb().prepare('DELETE FROM session_versions WHERE email = ?').bind(EMAIL).run()
  })

  it('13. PIN 미설정 면제: auth_pins가 없으면 창 없이도 잠긴 메모 열람 가능', async () => {
    await testDb().prepare('DELETE FROM auth_pins').run()
    const memoD = await createMemo('면제 대상 본문')
    const lock = await req(`/api/memo/${memoD}/lock`, 'POST', { body: { locked: true }, cookie: plainCookie })
    expect(lock.status).toBe(200)
    const read = await req(`/api/memo/${memoD}`, 'GET', { cookie: plainCookie })
    expect(read.status).toBe(200)
    expect(read.body.memo.text).toContain('면제 대상 본문')
    await testDb().prepare('DELETE FROM memos WHERE id = ?').bind(memoD).run()
  })
})
