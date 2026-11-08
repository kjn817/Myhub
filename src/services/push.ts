/**
 * Web Push 발송 (RFC 8291 aes128gcm + RFC 8292 VAPID)
 *
 * VAPID 키 생성 — 사용자가 직접 한 번만 실행 (로컬 터미널):
 *
 *   node -e "const {generateKeyPairSync}=require('crypto');
 *     const k=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 *     console.log(JSON.stringify(k.privateKey.export({format:'jwk'})))"
 *
 * 출력된 JWK JSON 전체를 Worker secret에 등록:
 *   wrangler secret put VAPID_PRIVATE_KEY   (JWK JSON)
 *   wrangler secret put VAPID_SUBJECT        (예: mailto:kimjn00003@naver.com)
 *
 * 공개키는 GET /api/push/vapid-key 로 확인 (서버가 JWK에서 유도).
 * 개인키는 절대 클라이언트에 노출하지 않음.
 */

import type { Env } from '../types'

export interface PushSubscription {
  endpoint: string
  p256dh: string // base64url, UA 공개키 (65바이트 uncompressed)
  auth: string // base64url, auth secret (16바이트)
}

export interface PushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

// ---------- base64url ----------

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (b64.length % 4)) % 4
  const bin = atob(b64 + '='.repeat(pad))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}

// ---------- VAPID ----------

interface VapidKeys {
  privateKey: CryptoKey // ECDSA P-256 서명용
  publicUncompressedB64: string // 0x04||x||y 의 base64url (Authorization 헤더 k= 값)
}

let vapidCache: VapidKeys | null = null

async function getVapidKeys(env: Env): Promise<VapidKeys> {
  if (vapidCache) return vapidCache
  const jwkStr = env.VAPID_PRIVATE_KEY
  if (!jwkStr) throw new Error('vapid_not_configured')
  let jwk: JsonWebKey
  try {
    jwk = JSON.parse(jwkStr)
  } catch {
    throw new Error('vapid_key_invalid')
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error('vapid_key_invalid')
  }
  const privateKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  )
  const pubBytes = concat(new Uint8Array([0x04]), b64urlDecode(jwk.x), b64urlDecode(jwk.y))
  if (pubBytes.length !== 65) throw new Error('vapid_key_invalid')
  vapidCache = { privateKey, publicUncompressedB64: b64urlEncode(pubBytes) }
  return vapidCache
}

export async function getVapidPublicKey(env: Env): Promise<string> {
  return (await getVapidKeys(env)).publicUncompressedB64
}

// ECDSA raw 서명(R||S, 64바이트) → DER (JWT ES256 요구 형식)
function rawToDer(raw: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  if (raw.length !== 64) throw new Error('bad_signature')
  const r = raw.slice(0, 32)
  const s = raw.slice(32, 64)
  const encodeInt = (v: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> => {
    let i = 0
    while (i < v.length - 1 && v[i] === 0) i++
    let body = v.slice(i)
    if (body[0] & 0x80) body = concat(new Uint8Array([0x00]), body)
    return concat(new Uint8Array([0x02, body.length]), body)
  }
  const ri = encodeInt(r)
  const si = encodeInt(s)
  const seq = concat(ri, si)
  return concat(new Uint8Array([0x30, seq.length]), seq)
}

/** 테스트용 export */
export async function createVapidHeader(endpoint: string, env: Env): Promise<string> {
  const { privateKey, publicUncompressedB64 } = await getVapidKeys(env)
  const aud = new URL(endpoint).origin
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600 // 12시간 (최대 24시간)
  const sub = env.VAPID_SUBJECT || 'mailto:admin@localhost'
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ aud, exp, sub })))
  const data = new TextEncoder().encode(`${header}.${payload}`)
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data))
  const jwt = `${header}.${payload}.${b64urlEncode(rawToDer(rawSig))}`
  return `vapid t=${jwt}, k=${publicUncompressedB64}`
}

// ---------- 페이로드 암호화 (RFC 8291 aes128gcm + RFC 8188) ----------
//
// RFC 8291 §3.4 순서 (검증: Appendix A 테스트 벡터와 대조):
//   PRK_key = HMAC(auth_secret, ecdh_secret)
//   IKM     = HMAC(PRK_key, "WebPush: info"||0x00||ua_public||as_public||0x01)
//   PRK     = HMAC(salt, IKM)                      — salt는 랜덤 16바이트
//   CEK     = HMAC(PRK, "Content-Encoding: aes128gcm"||0x00||0x01)[0..15]  (16B)
//   NONCE   = HMAC(PRK, "Content-Encoding: nonce"||0x00||0x01)[0..11]      (12B)
//
// 와이어 형식 (RFC 8188 §2.1):
//   salt(16) || rs(4, BE) || idlen(1) || keyid(idlen) || ciphertext
//   - keyid = as_public (발신자 임시 ECDH 공개키, 65바이트) — 평문 전송
//   - plaintext = payload || 0x02 || 0x00*pad  → (rs - 16) 바이트로 패딩
//   - ciphertext = AES-128-GCM(CEK, NONCE, plaintext)  → (rs - 16) + 16 바이트

const RECORD_SIZE = 4096

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource))
}

export interface EncryptOpts {
  salt?: Uint8Array // 테스트용 고정 salt (없으면 랜덤)
  ephPrivateKey?: CryptoKey // 테스트용 고정 임시키
  asPublic?: Uint8Array // ephPrivateKey와 쌍을 이루는 공개키 (65바이트)
}

/** 테스트용 export: 고정 salt/임시키로 암호화 (프로덕션은 opts 생략) */
export async function encryptPayload(
  sub: PushSubscription, payload: PushPayload, opts?: EncryptOpts
): Promise<{ body: Uint8Array }> {
  const uaPublic = b64urlDecode(sub.p256dh) // 구독자 공개키 (65바이트)
  const authSecret = b64urlDecode(sub.auth) // 16바이트
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('subscription_invalid')

  const salt = opts?.salt ?? crypto.getRandomValues(new Uint8Array(16))

  // 발신자 임시 ECDH 키쌍
  let ephPrivate: CryptoKey
  let asPublic: Uint8Array
  if (opts?.ephPrivateKey && opts?.asPublic) {
    ephPrivate = opts.ephPrivateKey
    asPublic = opts.asPublic
  } else {
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
    ephPrivate = eph.privateKey
    asPublic = new Uint8Array(await (crypto.subtle.exportKey as any)('raw', eph.publicKey)) // 65바이트
  }
  if (asPublic.length !== 65 || asPublic[0] !== 0x04) throw new Error('bad_ephemeral_key')

  // ECDH 공유 비밀
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )
  const ecdhSecret = new Uint8Array(
    await (crypto.subtle.deriveBits as any)({ name: 'ECDH', public: uaKey }, ephPrivate, 256)
  )

  const te = new TextEncoder()
  const one = new Uint8Array([0x01])
  const prkKey = await hmacSha256(authSecret, ecdhSecret)
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic, one)
  const ikm = await hmacSha256(prkKey, keyInfo)
  const prk = await hmacSha256(salt, ikm)
  const cek = (await hmacSha256(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), one))).slice(0, 16)
  const nonce = (await hmacSha256(prk, concat(te.encode('Content-Encoding: nonce\0'), one))).slice(0, 12)

  // plaintext = payload || 0x02 || pad → (rs - 16) 바이트
  const msg = te.encode(JSON.stringify(payload))
  const plainLen = RECORD_SIZE - 16
  const padLen = plainLen - msg.length - 1
  if (padLen < 0) throw new Error('payload_too_large')
  const plaintext = concat(msg, new Uint8Array([0x02]), new Uint8Array(padLen))

  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 }, aesKey, plaintext as BufferSource)
  )

  const body = concat(salt, u32be(RECORD_SIZE), new Uint8Array([asPublic.length]), asPublic, ct)
  return { body }
}

// ---------- 발송 ----------

export interface SendResult {
  ok: boolean
  status: number
  gone: boolean // 구독 만료 → DB에서 삭제해야 함
  error?: string
}

export async function sendPushNotification(
  env: Env, sub: PushSubscription, payload: PushPayload, ttlSeconds = 3600
): Promise<SendResult> {
  try {
    const vapid = await createVapidHeader(sub.endpoint, env)
    const { body } = await encryptPayload(sub, payload)
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Authorization': vapid,
        'TTL': String(ttlSeconds),
      },
      body: body as BufferSource,
    })
    // 404/410 = 구독 만료 → 삭제
    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, gone: true }
    }
    if (!res.ok) {
      return { ok: false, status: res.status, gone: false, error: (await res.text().catch(() => '')).slice(0, 120) }
    }
    return { ok: true, status: res.status, gone: false }
  } catch (e: any) {
    return { ok: false, status: 0, gone: false, error: String(e?.message || e).slice(0, 120) }
  }
}

export function isPushConfigured(env: Env): boolean {
  return !!env.VAPID_PRIVATE_KEY
}
