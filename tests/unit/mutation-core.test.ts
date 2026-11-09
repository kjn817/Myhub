/// <reference types="jest" />
/**
 * 핵심 모듈 변이 테스트 대응 — 생존 변이가 가리킨 성질 검증.
 *
 * 각 describe에 대응 변이 ID를 명시한다. 여기서 검증하는 성질은 전부
 * "기존 스위트가 라운드트립·목 주도 mock으로만 봐서 놓친 것"이다:
 * - crypto 키 유도는 라운드트립이 아니라 독립 구현과의 상호운용으로 고정한다.
 * - 속도 제한 상한은 mock이 limit 인자를 읽는 상태형 fake로 검증한다
 *   (기존 mock은 호출 횟수만으로 차단을 흉내 내 limit 값 자체를 보지 않았다).
 * - 경계 성질(정확히 상한, 만료 순간)은 시각 주입으로 정확히 찌른다.
 */
import { Hono } from 'hono'
import { createTestDb } from '../mcp-d1'
import {
  encryptContent,
  decryptContent,
  decryptBytesWithKey,
  ciphertextFormat,
  isEncrypted,
} from '../../src/services/crypto'
import {
  hashPassword,
  verifyPassword,
  hasActiveStepUp,
  isValidB64,
  grantStepUp,
  createSession,
  verifySessionInfo,
  type SessionInfo,
} from '../../src/modules/auth/primitives'
import { authApp } from '../../src/modules/auth/routes'
import { maskAuthEmail } from '../../src/modules/auth/routes-otp'
import { STEP_UP_TTL_MS } from '../../src/modules/auth/primitives'
import {
  keyRotationApp,
  requireRotationStepUp,
  ROTATION_STEP_UP_MAX_AGE_MS,
} from '../../src/modules/key-rotation/routes'
import { hashPin } from '../../src/modules/auth/routes'
import { CONFIG } from '../../src/config'

// ============================================================
// crypto — 키 유도 상호운용 (CR-01 절단 길이, CR-02 해시, CR-03 패딩)
// 서비스와 무관하게 "문서화된 유도"를 여기서 독립 구현하고,
// 그 구현이 만든 암호문을 서비스가 열고, 서비스가 만든 것을 여기가 연다.
// ============================================================

function b64OfBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function bytesOfB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 문서화된 키 유도: base64면 디코드, 아니면 SHA-256. 32바이트로 0 패딩/절단. */
async function deriveKeyBytes(keyMaterial: string): Promise<Uint8Array> {
  let kb: Uint8Array
  try {
    kb = bytesOfB64(keyMaterial)
  } catch {
    kb = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial)))
  }
  if (kb.length < 32) {
    const padded = new Uint8Array(32)
    padded.set(kb)
    kb = padded
  } else if (kb.length > 32) {
    kb = kb.slice(0, 32)
  }
  return kb
}

async function manualEncryptText(keyMaterial: string, plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await deriveKeyBytes(keyMaterial), { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  const combined = new Uint8Array(iv.length + ct.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ct), iv.length)
  return 'ENC:' + b64OfBytes(combined)
}

async function manualDecryptText(keyMaterial: string, ciphertext: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await deriveKeyBytes(keyMaterial), { name: 'AES-GCM' }, false, ['decrypt'])
  const combined = bytesOfB64(ciphertext.slice('ENC:'.length))
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  )
  return new TextDecoder().decode(pt)
}

describe('crypto 키 유도 상호운용 (CR-01·CR-02·CR-03)', () => {
  const cases: Array<[string, string]> = [
    ['긴 키 (48바이트 base64 → 32 절단)', btoa('k'.repeat(48))],
    ['짧은 키 (10바이트 base64 → 0 패딩)', btoa('0123456789')],
    ['raw 문자열 키 (SHA-256 유도)', 'memo-key-2026!'],
  ]
  for (const [label, keyMaterial] of cases) {
    test(`${label}: 독립 구현 암호문을 서비스가 복호화한다`, async () => {
      const ct = await manualEncryptText(keyMaterial, '상호운용 검증 본문')
      await expect(decryptContent({ MEMO_ENCRYPTION_KEY: keyMaterial }, ct)).resolves.toBe('상호운용 검증 본문')
    })
    test(`${label}: 서비스 암호문을 독립 구현이 복호화한다`, async () => {
      const ct = await encryptContent({ MEMO_ENCRYPTION_KEY: keyMaterial }, '상호운용 검증 본문')
      await expect(manualDecryptText(keyMaterial, ct)).resolves.toBe('상호운용 검증 본문')
    })
  }
})

describe('crypto 바이트 포맷 판별 (CR-10·CR-13)', () => {
  test('CR-10: IV가 MYH로 시작하는 v1 바이트도 v1으로 복호화된다 (매직은 4바이트 전수 대조)', async () => {
    const keyMaterial = btoa('0123456789abcdef0123456789abcdef')
    const key = await crypto.subtle.importKey('raw', await deriveKeyBytes(keyMaterial), { name: 'AES-GCM' }, false, ['encrypt'])
    const iv = new Uint8Array([0x4d, 0x59, 0x48, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]) // 'MYH' + 0x00 (4번째 바이트가 매직과 다름)
    const data = new TextEncoder().encode('v1 bytes payload')
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
    const combined = new Uint8Array(iv.length + ct.byteLength)
    combined.set(iv, 0)
    combined.set(new Uint8Array(ct), iv.length)
    const dec = await decryptBytesWithKey(keyMaterial, combined.buffer as ArrayBuffer)
    expect(new TextDecoder().decode(dec)).toBe('v1 bytes payload')
  })

  test('CR-13: ENC로 시작하지만 ENC:가 아닌 평문은 암호문으로 취급하지 않는다', async () => {
    expect(ciphertextFormat('ENC로 시작하는 평문 메모')).toBeNull()
    expect(isEncrypted('ENC로 시작하는 평문 메모')).toBe(false)
    await expect(
      decryptContent({ MEMO_ENCRYPTION_KEY: btoa('k'.repeat(32)) }, 'ENC로 시작하는 평문 메모'),
    ).resolves.toBe('ENC로 시작하는 평문 메모')
  })
})

// ============================================================
// auth primitives (AP-02·AP-09·AP-21·AP-22)
// ============================================================

describe('비밀번호 비교 전 바이트 대조 (AP-02)', () => {
  test('마지막 바이트만 다른 해시는 검증 실패한다', async () => {
    const { hashB64, saltB64 } = await hashPassword('correct horse', undefined, 1000)
    const bytes = bytesOfB64(hashB64)
    bytes[bytes.length - 1] ^= 0xff
    const tampered = b64OfBytes(bytes)
    await expect(
      verifyPassword('correct horse', { password_hash: tampered, password_salt: saltB64, iterations: 1000 }),
    ).resolves.toBe(false)
    // 대조군: 원본 해시는 통과
    await expect(
      verifyPassword('correct horse', { password_hash: hashB64, password_salt: saltB64, iterations: 1000 }),
    ).resolves.toBe(true)
  })
})

describe('step-up 활성 경계 (AP-09)', () => {
  const T = 1_700_000_000_000
  const info: SessionInfo = { email: 'a@b.c', method: 'pin', version: 0, suUntil: T, otpAt: null }
  test('만료 순간(suUntil == now)에는 비활성이다', () => {
    expect(hasActiveStepUp(info, T)).toBe(false)
  })
  test('만료 1ms 전에는 활성이다', () => {
    expect(hasActiveStepUp(info, T - 1)).toBe(true)
  })
})

describe('isValidB64 기대 길이 계약 (AP-22)', () => {
  const b64OfLen = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(0x61)))
  test('길이가 맞는 base64만 통과한다', () => {
    expect(isValidB64(b64OfLen(16), 16)).toBe(true)
    expect(isValidB64(b64OfLen(32), 32)).toBe(true)
    expect(isValidB64(b64OfLen(16))).toBe(true)
  })
  test('유효한 base64라도 기대 길이가 다르면 거부한다 (손상 행 분리)', () => {
    expect(isValidB64(b64OfLen(8), 16)).toBe(false)
    expect(isValidB64(b64OfLen(16), 32)).toBe(false)
  })
  test('base64가 아닌 값·빈 값·비문자열은 거부한다', () => {
    expect(isValidB64('not!base64', 16)).toBe(false)
    expect(isValidB64('', 16)).toBe(false)
    expect(isValidB64(123 as any, 16)).toBe(false)
    expect(isValidB64(null as any, 16)).toBe(false)
  })
})

describe('grantStepUp 발급 토큰 보존 (AP-21)', () => {
  test('OTP 세션에 step-up을 실으면 method·버전·OTP 확인 시각이 보존된다', async () => {
    const secret = 'grant-step-up-secret'
    const email = 'owner@example.com'
    const otpAt = Date.now()
    const token0 = await createSession(email, secret, 'otp', 0, { otpAt })
    const db = {
      prepare(_sql: string) {
        return {
          bind: (..._params: any[]) => ({
            first: async () => ({ version: 0 }),
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }
      },
    }
    const headers: Record<string, string> = {}
    const c: any = {
      req: { header: (n: string) => (n === 'Cookie' ? `myhub_session=${token0}` : undefined) },
      env: { DB: db, SESSION_SECRET: secret },
      header: (k: string, v: string) => {
        headers[k] = v
      },
    }
    await expect(grantStepUp(c)).resolves.toBe(true)
    const m = (headers['Set-Cookie'] || '').match(/myhub_session=([^;]+)/)
    expect(m).not.toBeNull()
    const info = await verifySessionInfo(m![1], secret)
    expect(info).not.toBeNull()
    expect(info!.method).toBe('otp')
    expect(info!.version).toBe(0)
    expect(info!.otpAt).toBe(otpAt)
    expect(info!.suUntil).not.toBeNull()
    expect(info!.suUntil! - Date.now()).toBeLessThanOrEqual(STEP_UP_TTL_MS + 5000)
    expect(info!.suUntil! - Date.now()).toBeGreaterThan(0)
  })
})

// ============================================================
// 이메일 마스킹 형식 (RO-03)
// ============================================================

describe('maskAuthEmail 형식 (RO-03)', () => {
  test('로컬 앞 2자만 남기고 나머지를 가린다', () => {
    expect(maskAuthEmail('kimjn00003@naver.com')).toBe('ki********@naver.com')
    expect(maskAuthEmail('abcde@x.com')).toBe('ab***@x.com')
  })
  test('짧은 로컬도 최소 1개의 *가 붙는다', () => {
    expect(maskAuthEmail('ab@x.com')).toBe('ab*@x.com')
    expect(maskAuthEmail('a@x.com')).toBe('a*@x.com')
  })
  test('@가 없으면 빈 문자열', () => {
    expect(maskAuthEmail('no-at-sign')).toBe('')
  })
})

// ============================================================
// 속도 제한 상한 값 자체의 집행 (RP-04·RP-05·RO-05)
// limit을 bind 파라미터에서 읽는 상태형 fake — 상한 숫자가 바뀌면 동작이 달라진다.
// ============================================================

class RateLimitDb {
  buckets = new Map<string, { count: number; exp: number }>()
  prepare(sql: string) {
    const db = this
    return {
      bind: (...params: any[]) => ({
        first: async () => null, // auth_pins·otp_codes 행 없음
        run: async () => {
          if (sql.includes('INSERT INTO rate_limits')) {
            const key = params[0] as string
            const expMs = Date.parse(params[1])
            const nowMs = Date.parse(params[2])
            const limit = params[6] as number
            const cur = db.buckets.get(key)
            if (!cur || cur.exp <= nowMs) {
              db.buckets.set(key, { count: 1, exp: expMs })
              return { meta: { changes: 1 } }
            }
            if (cur.count < limit) {
              cur.count += 1
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          return { meta: { changes: 1 } }
        },
      }),
    }
  }
}

describe('pin-login 속도 제한 상한 (RP-04·RP-05)', () => {
  const env = () => ({ DB: new RateLimitDb(), SESSION_SECRET: 'rl-secret', ENVIRONMENT: 'production' }) as any
  const attempt = (e: any, ip: string) =>
    authApp.request(
      '/pin-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ pin: '123456' }),
      },
      e,
    )

  test('RP-04: 같은 IP 10회까지는 통과(401), 11번째는 429', async () => {
    const e = env()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await attempt(e, '1.2.3.4')).status)
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(401))
    expect(statuses[10]).toBe(429)
  })

  test('RP-05: IP가 달라도 전역 100회를 넘으면 101번째는 429', async () => {
    const e = env()
    let last = 0
    for (let i = 1; i <= 101; i++) {
      last = (await attempt(e, `10.0.0.${i}`)).status
      if (i === 100) expect(last).toBe(401)
    }
    expect(last).toBe(429)
  })
})

describe('OTP 요청 IP별 상한 (RO-05)', () => {
  test('같은 IP 5회까지 발송, 6번째는 429', async () => {
    const e: any = {
      DB: new RateLimitDb(),
      SESSION_SECRET: 'rl-secret',
      ENVIRONMENT: 'development',
      DEV_ALLOWED_EMAILS: 'owner@example.com',
      TEST_MAIL_TRANSPORT: '1',
    }
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await authApp.request(
        '/request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '5.6.7.8' },
          body: JSON.stringify({}),
        },
        e,
      )
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 5)).toEqual(new Array(5).fill(200))
    expect(statuses[5]).toBe(429)
  })
})

// ============================================================
// set-pin method 집행 분리 (RP-06)
// pin 토큰이 신선한 oa 클레임까지 실으면, method 검사가 유일한 거부 사유가 된다.
// ============================================================

class QueueDb {
  firstQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []
  prepare(sql: string) {
    const db = this
    return {
      bind: (...params: any[]) => ({
        first: async () => {
          db.calls.push({ sql, params })
          const v = db.firstQueue.shift()
          if (v === undefined) return null
          if (v instanceof Error) throw v
          return v
        },
        run: async () => {
          db.calls.push({ sql, params })
          return { meta: { changes: 1 } }
        },
      }),
    }
  }
}

describe('set-pin은 method로 거부한다 (RP-06)', () => {
  test('신선한 oa를 실은 PIN 세션 토큰도 method 사유로 403이다', async () => {
    const secret = 'set-pin-method-secret'
    const email = CONFIG.productionEmail
    const token = await createSession(email, secret, 'pin', 0, { otpAt: Date.now() })
    const db = new QueueDb()
    db.firstQueue.push({ version: 0 }) // session_versions 조회
    const res = await authApp.request(
      '/set-pin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `myhub_session=${token}` },
        body: JSON.stringify({ pin: '654321' }),
      },
      { DB: db, SESSION_SECRET: secret, ENVIRONMENT: 'production' } as any,
    )
    expect(res.status).toBe(403)
    const j = (await res.json()) as any
    expect(j.error).toContain('인증코드로 로그인한 세션에서만')
    expect(j.code).not.toBe('OTP_WINDOW_EXPIRED')
    // PIN 교체 쓰기가 일어나지 않았다
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO auth_pins'))).toBe(false)
  })
})

describe('/step-up 재발급 토큰의 method 보존 (AR-01)', () => {
  test('OTP 세션으로 step-up하면 새 토큰도 otp method다', async () => {
    const secret = 'step-up-method-secret'
    const email = CONFIG.productionEmail
    const { hashB64, saltB64, iterations } = await hashPin('123456')
    const token = await createSession(email, secret, 'otp', 0, { otpAt: Date.now() })
    const db = new QueueDb()
    db.firstQueue.push({ version: 0 }) // session_versions
    db.firstQueue.push({ pin_hash: hashB64, pin_salt: saltB64, iterations }) // auth_pins
    const res = await authApp.request(
      '/step-up',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `myhub_session=${token}` },
        body: JSON.stringify({ pin: '123456' }),
      },
      { DB: db, SESSION_SECRET: secret, ENVIRONMENT: 'production' } as any,
    )
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('Set-Cookie') || ''
    const m = setCookie.match(/myhub_session=([^;]+)/)
    expect(m).not.toBeNull()
    const info = await verifySessionInfo(m![1], secret)
    expect(info).not.toBeNull()
    expect(info!.method).toBe('otp')
    expect(info!.version).toBe(0)
    expect(info!.suUntil).not.toBeNull()
    expect(info!.suUntil! - Date.now()).toBeLessThanOrEqual(STEP_UP_TTL_MS + 5000)
  })
})

// ============================================================
// 키 로테이션 엔드포인트 (KR-01·02·08·09·10·11·13·14, KR-03·04 신선도)
// ============================================================

const KR_OLD_KEY = 'old-test-key-material-0001'
const KR_NEW_KEY = 'new-test-key-material-0002'

async function makeKrApp(opts: { withPin?: boolean; stepUp?: boolean; environment?: string; withUser?: boolean } = {}) {
  const { db, d1 } = createTestDb()
  if (opts.withPin !== false) {
    const { hashB64, saltB64, iterations } = await hashPin('135790')
    db.prepare("INSERT INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')")
      .run('admin@example.com', hashB64, saltB64, iterations)
  }
  const encMemo = await encryptContent({ MEMO_ENCRYPTION_KEY: KR_OLD_KEY }, '비밀 메모 본문')
  db.prepare('INSERT INTO memos (id, text, is_locked) VALUES (1, ?, 1)').run(encMemo)
  const app = new Hono()
  if (opts.withUser !== false) {
    app.use('*', async (c, next) => {
      ;(c as any).set('userEmail', 'admin@example.com')
      if (opts.stepUp) (c as any).set('stepUpUntil', Date.now() + STEP_UP_TTL_MS)
      await next()
    })
  }
  app.route('/kr', keyRotationApp)
  const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: KR_OLD_KEY, ENVIRONMENT: opts.environment ?? 'staging' }
  const post = (path: string, body: any) =>
    app.request('/kr' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env)
  return { post, db, app, env }
}

describe('키로테이션 새 키 길이 경계 (KR-01·KR-02)', () => {
  test('15자 키는 최소 길이 미달로 400이다', async () => {
    const { post } = await makeKrApp({ stepUp: true })
    const key = 'k'.repeat(15)
    const res = await post('/rotate', { newKey: key, newKeyConfirm: key, dryRun: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toContain('최소 16자')
  })
  test('정확히 16자 키는 길이 게이트를 통과한다', async () => {
    const { post } = await makeKrApp({ stepUp: true })
    const key = 'k'.repeat(16)
    const res = await post('/rotate', { newKey: key, newKeyConfirm: key, dryRun: true })
    expect(res.status).toBe(200)
  })
})

describe('키로테이션 확인 입력·센서스 검증 (KR-08·KR-09·KR-10)', () => {
  test('KR-10: 빈 문자열 확인 입력은 KEY_CONFIRMATION_REQUIRED다 (MISMATCH가 아니다)', async () => {
    const { post } = await makeKrApp({ stepUp: true })
    const res = await post('/rotate', { newKey: KR_NEW_KEY, newKeyConfirm: '', dryRun: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBe('KEY_CONFIRMATION_REQUIRED')
  })
  test('KR-08: 소수 센서스는 검증 불가로 취급해 census_required가 된다', async () => {
    const { post } = await makeKrApp({ stepUp: true })
    const res = await post('/rotate', {
      newKey: KR_NEW_KEY,
      newKeyConfirm: KR_NEW_KEY,
      dryRun: false,
      expectedCensus: { memo_text: 0.5, memo_block: 0, google_token_row: 0, locked_file: 0 },
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe('census_required')
  })
  test('KR-09: 음수 센서스는 검증 불가로 취급해 census_required가 된다', async () => {
    const { post } = await makeKrApp({ stepUp: true })
    const res = await post('/rotate', {
      newKey: KR_NEW_KEY,
      newKeyConfirm: KR_NEW_KEY,
      dryRun: false,
      expectedCensus: { memo_text: -1, memo_block: -1, google_token_row: -1, locked_file: -1 },
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe('census_required')
  })
})

describe('키로테이션 환경·인증 게이트 (KR-11·KR-14)', () => {
  test('KR-11: production 환경에서도 게이트를 통과한다', async () => {
    const { post } = await makeKrApp({ stepUp: true, environment: 'production' })
    const res = await post('/rotate', { newKey: KR_NEW_KEY, newKeyConfirm: KR_NEW_KEY, dryRun: true })
    expect(res.status).toBe(200)
  })
  test('KR-14: userEmail이 없는 요청은 401이다', async () => {
    const { app, env } = await makeKrApp({ withUser: false })
    const res = await app.request('/kr/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newKey: KR_NEW_KEY, newKeyConfirm: KR_NEW_KEY, dryRun: true }),
    }, env)
    expect(res.status).toBe(401)
  })
})

describe('키로테이션 dryRun 엄격 판정 (KR-13)', () => {
  const CENSUS = { memo_text: 1, memo_block: 0, google_token_row: 0, locked_file: 0 }
  test('dryRun: true면 쓰기가 없다 (대조군)', async () => {
    const { post, db } = await makeKrApp({ stepUp: true })
    const res = await post('/rotate', { newKey: KR_NEW_KEY, newKeyConfirm: KR_NEW_KEY, dryRun: true, expectedCensus: CENSUS })
    expect(res.status).toBe(200)
    const memo = db.prepare('SELECT text FROM memos WHERE id = 1').get() as any
    expect(memo.text.startsWith('ENC2:')).toBe(false)
  })
  test('dryRun: 1(숫자)은 dry-run이 아니다 — 실제 회전이 수행된다', async () => {
    const { post, db } = await makeKrApp({ stepUp: true })
    const res = await post('/rotate', { newKey: KR_NEW_KEY, newKeyConfirm: KR_NEW_KEY, dryRun: 1, expectedCensus: CENSUS })
    expect(res.status).toBe(200)
    const memo = db.prepare('SELECT text FROM memos WHERE id = 1').get() as any
    expect(memo.text.startsWith('ENC2:')).toBe(true)
  })
})

describe('키로테이션 신선도 경계 — 하드코딩 경과 시간 (KR-03·KR-04)', () => {
  async function fakeCtx() {
    const { d1 } = createTestDb()
    const { hashB64, saltB64, iterations } = await hashPin('135790')
    d1.prepare("INSERT INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')")
      .bind('admin@example.com', hashB64, saltB64, iterations).run()
    const issuedAt = Date.now()
    const fakeC: any = {
      env: { DB: d1 },
      get: (k: string) =>
        k === 'userEmail' ? 'admin@example.com' : k === 'stepUpUntil' ? issuedAt + STEP_UP_TTL_MS : undefined,
    }
    return { fakeC, issuedAt }
  }
  test('KR-04: 발급 3분 경과한 step-up은 거부된다 (상한 2분)', async () => {
    const { fakeC, issuedAt } = await fakeCtx()
    expect((await requireRotationStepUp(fakeC, issuedAt + 3 * 60 * 1000)).ok).toBe(false)
  })
  test('KR-03: 발급 후 정확히 상한(2분) 시점까지는 허용된다', async () => {
    const { fakeC, issuedAt } = await fakeCtx()
    expect((await requireRotationStepUp(fakeC, issuedAt + ROTATION_STEP_UP_MAX_AGE_MS)).ok).toBe(true)
  })
  test('발급 1분 경과한 step-up은 허용된다 (대조군)', async () => {
    const { fakeC, issuedAt } = await fakeCtx()
    expect((await requireRotationStepUp(fakeC, issuedAt + 60 * 1000)).ok).toBe(true)
  })
})
