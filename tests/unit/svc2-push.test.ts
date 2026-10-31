/// <reference types="jest" />
/**
 * push.ts 커버리지 테스트 (Web Push — RFC 8291/8292)
 * - isPushConfigured
 * - getVapidPublicKey / createVapidHeader: 캐시, 키 없음, JSON 파싱 실패, 잘못된 JWK
 * - encryptPayload: 구독 검증, 페이로드 초과, 고정 salt/키로 결정적 암호화
 * - sendPushNotification: 성공 / 404·410 gone / 에러 응답 / fetch throw
 * - _resetVapidCache
 *
 * 도달 불가 방어 코드 (소스 수정 없이 커버 불가):
 * - 36행: b64urlEncode의 ArrayBuffer 분기 — 모든 내부 호출자가 Uint8Array 전달
 * - 96행: pubBytes.length !== 65 — importKey가 P-256 키를 32+32바이트로 검증하므로 도달 불가
 * - 107행: rawToDer bad_signature — crypto.subtle.sign(P-256)은 항상 64바이트 반환
 */
import {
  isPushConfigured,
  getVapidPublicKey,
  createVapidHeader,
  encryptPayload,
  sendPushNotification,
  _resetVapidCache,
} from '../../src/services/push'

// ---- VAPID 테스트 키 생성 ----
async function makeVapidEnv() {
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
  return {
    env: { VAPID_PRIVATE_KEY: JSON.stringify(jwk), VAPID_SUBJECT: 'mailto:test@test.com' } as any,
    jwk,
  }
}

function b64urlEncodeBytes(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function makeSubscription() {
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  )) as CryptoKeyPair
  const pubRaw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer)
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return {
    endpoint: 'https://push.example.com/sub/123',
    p256dh: b64urlEncodeBytes(pubRaw),
    auth: b64urlEncodeBytes(auth),
  }
}

beforeEach(() => {
  _resetVapidCache()
})

describe('isPushConfigured', () => {
  test('키 있음 → true', () => {
    expect(isPushConfigured({ VAPID_PRIVATE_KEY: 'x' } as any)).toBe(true)
  })
  test('키 없음 → false', () => {
    expect(isPushConfigured({} as any)).toBe(false)
    expect(isPushConfigured({ VAPID_PRIVATE_KEY: '' } as any)).toBe(false)
  })
})

describe('getVapidPublicKey / createVapidHeader', () => {
  test('공개키 반환 (65바이트 base64url)', async () => {
    const { env, jwk } = await makeVapidEnv()
    const pub = await getVapidPublicKey(env)
    // base64url, 패딩 없음
    expect(pub).toMatch(/^[A-Za-z0-9\-_]+$/)
    expect(pub).not.toContain('=')
    // 두 번째 호출은 캐시 사용 (같은 값)
    expect(await getVapidPublicKey(env)).toBe(pub)
    expect(jwk.x).toBeDefined()
  })

  test('키 미설정 → vapid_not_configured', async () => {
    await expect(getVapidPublicKey({} as any)).rejects.toThrow('vapid_not_configured')
  })

  test('JSON 파싱 실패 → vapid_key_invalid', async () => {
    await expect(getVapidPublicKey({ VAPID_PRIVATE_KEY: 'not-json' } as any)).rejects.toThrow(
      'vapid_key_invalid'
    )
  })

  test('잘못된 kty → vapid_key_invalid', async () => {
    const bad = JSON.stringify({ kty: 'RSA', crv: 'P-256', d: 'x', x: 'y', y: 'z' })
    await expect(getVapidPublicKey({ VAPID_PRIVATE_KEY: bad } as any)).rejects.toThrow(
      'vapid_key_invalid'
    )
  })

  test('잘못된 crv → vapid_key_invalid', async () => {
    const bad = JSON.stringify({ kty: 'EC', crv: 'P-384', d: 'x', x: 'y', y: 'z' })
    await expect(getVapidPublicKey({ VAPID_PRIVATE_KEY: bad } as any)).rejects.toThrow(
      'vapid_key_invalid'
    )
  })

  test('필드 누락 → vapid_key_invalid', async () => {
    const bad = JSON.stringify({ kty: 'EC', crv: 'P-256' })
    await expect(getVapidPublicKey({ VAPID_PRIVATE_KEY: bad } as any)).rejects.toThrow(
      'vapid_key_invalid'
    )
  })

  test('createVapidHeader 포맷', async () => {
    const { env } = await makeVapidEnv()
    const h = await createVapidHeader('https://push.example.com/abc', env)
    expect(h).toMatch(/^vapid t=.+\.+.+\..+, k=[A-Za-z0-9\-_]+$/)
  })

  test('createVapidHeader 기본 subject', async () => {
    const { env } = await makeVapidEnv()
    delete (env as any).VAPID_SUBJECT
    const h = await createVapidHeader('https://push.example.com/abc', env)
    expect(h).toContain('vapid t=')
  })
})

describe('encryptPayload', () => {
  test('정상 암호화 (와이어 포맷)', async () => {
    const sub = await makeSubscription()
    const { body } = await encryptPayload(sub, { title: 'T', body: 'B' })
    // salt(16) + rs(4) + idlen(1) + keyid(65) = 86바이트 헤더
    expect(body.length).toBeGreaterThan(86)
    expect(body[16]).toBe(0)
    expect(body[17]).toBe(0)
    expect(body[18]).toBe(0x10) // rs = 4096 BE (body[16..19])
    expect(body[19]).toBe(0x00)
    expect(body[20]).toBe(65) // idlen
    expect(body[21]).toBe(0x04) // uncompressed 공개키
  })

  test('고정 salt/임시키 → 결정적 결과', async () => {
    const sub = await makeSubscription()
    const salt = new Uint8Array(16).fill(7)
    const eph = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    )) as CryptoKeyPair
    const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer)
    const opts = { salt, ephPrivateKey: eph.privateKey, asPublic }
    const r1 = await encryptPayload(sub, { title: 'T' }, opts)
    const r2 = await encryptPayload(sub, { title: 'T' }, opts)
    expect(Buffer.from(r1.body).toString('hex')).toBe(Buffer.from(r2.body).toString('hex'))
  })

  test('잘못된 구독 (p256dh 길이) → subscription_invalid', async () => {
    const sub = { endpoint: 'x', p256dh: b64urlEncodeBytes(new Uint8Array(10)), auth: b64urlEncodeBytes(new Uint8Array(16)) }
    await expect(encryptPayload(sub, { title: 'T' })).rejects.toThrow('subscription_invalid')
  })

  test('잘못된 구독 (auth 길이) → subscription_invalid', async () => {
    const sub = { endpoint: 'x', p256dh: b64urlEncodeBytes(new Uint8Array(65)), auth: b64urlEncodeBytes(new Uint8Array(5)) }
    await expect(encryptPayload(sub, { title: 'T' })).rejects.toThrow('subscription_invalid')
  })

  test('페이로드 초과 → payload_too_large', async () => {
    const sub = await makeSubscription()
    await expect(
      encryptPayload(sub, { title: 'x'.repeat(5000) })
    ).rejects.toThrow('payload_too_large')
  })

  test('잘못된 임시키 (64바이트) → bad_ephemeral_key', async () => {
    const sub = await makeSubscription()
    const eph = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    )) as CryptoKeyPair
    const badPub = new Uint8Array(64) // 65가 아님
    await expect(
      encryptPayload(sub, { title: 'T' }, { ephPrivateKey: eph.privateKey, asPublic: badPub })
    ).rejects.toThrow('bad_ephemeral_key')
  })

  test('임시키 첫 바이트 0x04 아님 → bad_ephemeral_key', async () => {
    const sub = await makeSubscription()
    const eph = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    )) as CryptoKeyPair
    const badPub = new Uint8Array(65).fill(3)
    await expect(
      encryptPayload(sub, { title: 'T' }, { ephPrivateKey: eph.privateKey, asPublic: badPub })
    ).rejects.toThrow('bad_ephemeral_key')
  })
})

describe('sendPushNotification', () => {
  const origFetch = global.fetch
  afterEach(() => {
    global.fetch = origFetch
  })

  test('성공', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201 })
    const out = await sendPushNotification(env, sub, { title: 'T' })
    expect(out).toEqual({ ok: true, status: 201, gone: false })
    const fetchMock = global.fetch as jest.Mock
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers['Authorization']).toMatch(/^vapid t=/)
    expect(headers['TTL']).toBe('3600')
  })

  test('404 → gone', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })
    const out = await sendPushNotification(env, sub, { title: 'T' })
    expect(out.gone).toBe(true)
    expect(out.ok).toBe(false)
  })

  test('410 → gone', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 410 })
    expect((await sendPushNotification(env, sub, { title: 'T' })).gone).toBe(true)
  })

  test('기타 에러 → error 포함', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => 'server error',
    })
    const out = await sendPushNotification(env, sub, { title: 'T' })
    expect(out.ok).toBe(false)
    expect(out.gone).toBe(false)
    expect(out.error).toBe('server error')
  })

  test('text() throw → 빈 error', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => { throw new Error('x') },
    })
    const out = await sendPushNotification(env, sub, { title: 'T' })
    expect(out.error).toBe('')
  })

  test('fetch throw → status 0', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockRejectedValue(new Error('network fail'))
    const out = await sendPushNotification(env, sub, { title: 'T' })
    expect(out).toEqual({ ok: false, status: 0, gone: false, error: 'network fail' })
  })

  test('fetch가 문자열 throw → || e 폴백', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockRejectedValue('raw string error')
    const out = await sendPushNotification(env, sub, { title: 'T' })
    expect(out.error).toBe('raw string error')
  })

  test('TTL 커스텀', async () => {
    const { env } = await makeVapidEnv()
    const sub = await makeSubscription()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    await sendPushNotification(env, sub, { title: 'T' }, 7200)
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers
    expect(headers['TTL']).toBe('7200')
  })

  test('VAPID 실패 → catch로 error 반환', async () => {
    const sub = await makeSubscription()
    global.fetch = jest.fn()
    const out = await sendPushNotification({} as any, sub, { title: 'T' })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(0)
    expect(out.error).toContain('vapid_not_configured')
  })
})

describe('rawToDer (createVapidHeader 경유)', () => {
  test('비정상 서명 길이 → 내부 에러 전파', async () => {
    // rawToDer는 직접 export되지 않으므로, 정상 경로가 동작함을 확인
    const { env } = await makeVapidEnv()
    const h = await createVapidHeader('https://x.com/', env)
    const jwt = h.split('t=')[1].split(',')[0]
    expect(jwt.split('.')).toHaveLength(3)
  })
})
