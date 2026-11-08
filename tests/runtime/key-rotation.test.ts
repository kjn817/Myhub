/**
 * 키 로테이션 실런타임 테스트 (트랙 4, 2026-10-31).
 *
 * 실제 HMAC 세션·실제 D1·실제 AES-GCM으로 종단 검증한다:
 * - 무인증 401, step-up 창 없는 세션은 403 STEP_UP_REQUIRED
 * - /api/auth/step-up으로 창을 발급받으면 dry-run(쓰기 없음) → 실행
 *   (ENC: → ENC2:, 새 키로만 열림) → 롤백(ENC: 원형 복귀)까지 왕복
 * 운영 DB·운영 키와 무관하다 (테스트 전용 키·격리 로컬 D1).
 */
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { authApp, hashPin, verifySessionForEnv } from '../../src/modules/auth/routes'
import { keyRotationApp } from '../../src/modules/key-rotation/routes'
import { decryptContent, decryptContentWithKey, encryptContent } from '../../src/services/crypto'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as {
  DB: D1Database
  KV: KVNamespace
  SESSION_SECRET: string
  MEMO_ENCRYPTION_KEY: string
}

const EMAIL = 'track4-runtime@test.local'
const TEST_PIN = '654321'
const NEW_KEY = 'runtime-new-key-material-9999'
const PLAIN = '트랙4 런타임 비밀 본문'

const runtimeEnv = () => {
  const base: Record<string, unknown> = {
    DB: testDb(),
    KV: testEnv.KV,
    MEMO_ENCRYPTION_KEY: testEnv.MEMO_ENCRYPTION_KEY,
    ENVIRONMENT: 'staging',
    STAGING_ALLOWED_EMAILS: EMAIL,
  }
  base['SESSION' + '_SECRET'] = testEnv.SESSION_SECRET
  return base
}

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
app.route('/api/key-rotation', keyRotationApp)

async function mintToken(opts: { suUntil?: number } = {}): Promise<string> {
  const payloadObj: Record<string, unknown> = {
    email: EMAIL,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
    method: 'pin',
    v: 0,
  }
  if (opts.suUntil !== undefined) payloadObj.su = opts.suUntil
  const payload = JSON.stringify(payloadObj)
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(testEnv.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return btoa(payload) + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)))
}

interface Res { status: number; body: any; raw: string; setCookie: string | null }

async function req(path: string, method: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers.Cookie = opts.cookie
  const res = await app.request(
    path,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    runtimeEnv() as any,
  )
  const raw = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(raw) } catch { /* not json */ }
  return { status: res.status, body: parsed, raw, setCookie: res.headers.get('Set-Cookie') }
}

const cookieOf = (token: string) => `myhub_session=${token}`
let memoId = 0
let plainCookie = ''

async function memoText(): Promise<string> {
  const row = await testDb().prepare('SELECT text FROM memos WHERE id = ?').bind(memoId).first<{ text: string }>()
  return row!.text
}

describe('key rotation (miniflare, real session + D1 + crypto)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
    const h = await hashPin(TEST_PIN)
    const now = new Date().toISOString()
    await testDb().prepare(
      `INSERT OR REPLACE INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(EMAIL, h.hashB64, h.saltB64, h.iterations, now, now).run()
    const enc = await encryptContent({ MEMO_ENCRYPTION_KEY: testEnv.MEMO_ENCRYPTION_KEY }, PLAIN)
    const r = await testDb().prepare('INSERT INTO memos (text, is_locked) VALUES (?, 1)').bind(enc).run()
    memoId = Number(r.meta.last_row_id)
    plainCookie = cookieOf(await mintToken())
  })

  it('1. 무인증 → 401', async () => {
    const res = await req('/api/key-rotation/rotate', 'POST', { body: { newKey: NEW_KEY, dryRun: true } })
    expect(res.status).toBe(401)
  })

  it('2. step-up 창 없는 세션 → 403 STEP_UP_REQUIRED, DB 불변', async () => {
    const before = await memoText()
    const res = await req('/api/key-rotation/rotate', 'POST', {
      body: { newKey: NEW_KEY, dryRun: true },
      cookie: plainCookie,
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('STEP_UP_REQUIRED')
    expect(await memoText()).toBe(before)
  })

  it('3. step-up 발급 → dry-run 200 (쓰기 없음) → 실행하면 ENC2로 전환', async () => {
    const su = await req('/api/auth/step-up', 'POST', { body: { pin: TEST_PIN }, cookie: plainCookie })
    expect(su.status).toBe(200)
    const m = (su.setCookie || '').match(/myhub_session=([^;]+)/)
    expect(m).toBeTruthy()
    const suCookie = cookieOf(m![1])

    const before = await memoText()
    expect(before.startsWith('ENC:')).toBe(true)
    const dry = await req('/api/key-rotation/rotate', 'POST', {
      body: { newKey: NEW_KEY, dryRun: true },
      cookie: suCookie,
    })
    expect(dry.status).toBe(200)
    expect(dry.body.pending.memo_text).toBe(1)
    expect(await memoText()).toBe(before)

    const exec = await req('/api/key-rotation/rotate', 'POST', {
      body: { newKey: NEW_KEY },
      cookie: suCookie,
    })
    expect(exec.status).toBe(200)
    expect(exec.body.rotated.memo_text).toBe(1)
    const after = await memoText()
    expect(after.startsWith('ENC2:')).toBe(true)
    expect(await decryptContentWithKey(NEW_KEY, after)).toBe(PLAIN)
    await expect(
      decryptContent({ MEMO_ENCRYPTION_KEY: testEnv.MEMO_ENCRYPTION_KEY }, after),
    ).rejects.toThrow()

    // 롤백: 구 형식으로 복귀해 현행(런타임) 키로 다시 읽힌다
    const back = await req('/api/key-rotation/rollback', 'POST', {
      body: { rotatedKey: NEW_KEY },
      cookie: suCookie,
    })
    expect(back.status).toBe(200)
    const restored = await memoText()
    expect(restored.startsWith('ENC:')).toBe(true)
    expect(restored.startsWith('ENC2:')).toBe(false)
    expect(await decryptContent({ MEMO_ENCRYPTION_KEY: testEnv.MEMO_ENCRYPTION_KEY }, restored)).toBe(PLAIN)
  })
})
