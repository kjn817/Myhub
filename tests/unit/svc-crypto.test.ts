/// <reference types="jest" />
/**
 * crypto.ts 커버리지 테스트 (AES-GCM 메모 암호화 — SECURITY CRITICAL)
 * - 키 유도: base64 / raw문자열(SHA-256) / 짧은키 패딩 / 긴키 절단 / 32바이트 정확
 * - encrypt/decrypt 라운드트립 (문자열/바이트)
 * - 미암호화 텍스트 패스스루, ENC: prefix 판별
 * - 키 미설정 에러, 변조된 ciphertext 거부
 */
import {
  encryptContent,
  decryptContent,
  isEncrypted,
  encryptBytes,
  decryptBytes,
} from '../../src/services/crypto'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const envWith = (key: string) => ({ MEMO_ENCRYPTION_KEY: key })

describe('getKey 분기 (encrypt 경유)', () => {
  test('키 미설정 → 에러', async () => {
    await expect(encryptContent({}, 'x')).rejects.toThrow('MEMO_ENCRYPTION_KEY not configured')
    await expect(encryptContent({ MEMO_ENCRYPTION_KEY: '' }, 'x')).rejects.toThrow(
      'MEMO_ENCRYPTION_KEY not configured',
    )
  })

  test('base64 키 (32바이트 정확)', async () => {
    const env = envWith(b64('k'.repeat(32)))
    const ct = await encryptContent(env, 'hello')
    expect(await decryptContent(env, ct)).toBe('hello')
  })

  test('base64 짧은 키 → 0 패딩', async () => {
    const env = envWith(b64('0123456789')) // 10바이트
    const ct = await encryptContent(env, 'short key test')
    expect(await decryptContent(env, ct)).toBe('short key test')
  })

  test('base64 긴 키 → 32바이트 절단', async () => {
    const env = envWith(b64('k'.repeat(48))) // 48바이트
    const ct = await encryptContent(env, 'long key test')
    expect(await decryptContent(env, ct)).toBe('long key test')
  })

  test('raw 문자열 키 → SHA-256 유도 (atob throw)', async () => {
    // 'a'는 atob에서 InvalidCharacterError → catch → SHA-256 분기
    const env = envWith('a')
    const ct = await encryptContent(env, 'raw key test')
    expect(await decryptContent(env, ct)).toBe('raw key test')
  })

  test('raw 문자열 키가 달라도 각각 복호화 가능', async () => {
    const e1 = envWith('abcde')
    const e2 = envWith('fghij')
    const c1 = await encryptContent(e1, 'secret')
    // 다른 키로는 복호화 실패 (AES-GCM 인증 태그 불일치)
    await expect(decryptContent(e2, c1)).rejects.toThrow()
  })
})

describe('encryptContent/decryptContent', () => {
  const env = () => envWith(b64('k'.repeat(32)))

  test('라운드트립 (한글/이모지 포함)', async () => {
    const e = env()
    const pt = '안녕하세요 🔐 메모 내용입니다\n여러 줄'
    const ct = await encryptContent(e, pt)
    expect(ct.startsWith('ENC:')).toBe(true)
    expect(await decryptContent(e, ct)).toBe(pt)
  })

  test('빈 문자열 라운드트립', async () => {
    const e = env()
    const ct = await encryptContent(e, '')
    expect(await decryptContent(e, ct)).toBe('')
  })

  test('같은 평문도 매번 다른 암호문 (랜덤 IV)', async () => {
    const e = env()
    const c1 = await encryptContent(e, 'same')
    const c2 = await encryptContent(e, 'same')
    expect(c1).not.toBe(c2)
  })

  test('ENC: 없는 텍스트는 그대로 반환 (패스스루)', async () => {
    const e = env()
    expect(await decryptContent(e, 'plain text')).toBe('plain text')
    expect(await decryptContent(e, '')).toBe('')
  })

  test('변조된 ciphertext → 복호화 실패', async () => {
    const e = env()
    const ct = await encryptContent(e, 'data')
    // 첫 base64 문자 변조 — 첫 quantum은 완전하므로 디코딩 바이트가
    // 반드시 바뀐다 (IV 첫 바이트 변경 → GCM 인증 실패).
    // (기존: 마지막 문자 변조는 base64 패딩 비트만 건드릴 때가 있어
    // 디코딩 결과가 그대로가 돼 ~1/16 확률로 플레이크 — 전체 실행에서 발견)
    const body = ct.slice(4) // 'ENC:' 제거
    const tampered = 'ENC:' + (body[0] === 'A' ? 'B' : 'A') + body.slice(1)
    await expect(decryptContent(e, tampered)).rejects.toThrow()
  })

  test('잘못된 base64 → 실패', async () => {
    const e = env()
    await expect(decryptContent(e, 'ENC:!!!')).rejects.toThrow()
  })

  test('IV보다 짧은 데이터 → 실패', async () => {
    const e = env()
    await expect(decryptContent(e, 'ENC:' + b64('short'))).rejects.toThrow()
  })

  test('다른 키로 복호화 → 실패', async () => {
    const ct = await encryptContent(envWith(b64('a'.repeat(32))), 'x')
    await expect(decryptContent(envWith(b64('b'.repeat(32))), ct)).rejects.toThrow()
  })
})

describe('isEncrypted', () => {
  test('ENC: prefix → true', () => {
    expect(isEncrypted('ENC:abc')).toBe(true)
    expect(isEncrypted('ENC:')).toBe(true)
  })

  test('일반 텍스트 → false', () => {
    expect(isEncrypted('hello')).toBe(false)
    expect(isEncrypted('')).toBe(false)
    expect(isEncrypted('enc:abc')).toBe(false) // 대소문자 구분
  })

  test('비문자열 → false', () => {
    expect(isEncrypted(123 as any)).toBe(false)
    expect(isEncrypted(null as any)).toBe(false)
    expect(isEncrypted(undefined as any)).toBe(false)
  })
})

describe('encryptBytes/decryptBytes', () => {
  const env = () => envWith(b64('k'.repeat(32)))

  test('바이트 라운드트립', async () => {
    const e = env()
    const data = new TextEncoder().encode('바이너리 데이터').buffer as ArrayBuffer
    const enc = await encryptBytes(e, data)
    const dec = await decryptBytes(e, enc)
    expect(new TextDecoder().decode(dec)).toBe('바이너리 데이터')
  })

  test('빈 버퍼 라운드트립', async () => {
    const e = env()
    const enc = await encryptBytes(e, new ArrayBuffer(0))
    // iv 12바이트 + 0바이트 평문 + GCM 태그 16바이트 = 28
    expect(enc.byteLength).toBe(28)
    const dec = await decryptBytes(e, enc)
    expect(dec.byteLength).toBe(0)
  })

  test('출력 형식: iv(12) + 암호문', async () => {
    const e = env()
    const data = new TextEncoder().encode('1234567890').buffer as ArrayBuffer
    const enc = await encryptBytes(e, data)
    // AES-GCM: 평문 10바이트 + 태그 16바이트 + IV 12바이트
    expect(enc.byteLength).toBe(12 + 10 + 16)
  })

  test('변조된 바이트 → 복호화 실패', async () => {
    const e = env()
    const data = new TextEncoder().encode('x').buffer as ArrayBuffer
    const enc = new Uint8Array(await encryptBytes(e, data))
    enc[enc.length - 1] ^= 0xff
    await expect(decryptBytes(e, enc.buffer as ArrayBuffer)).rejects.toThrow()
  })

  test('키 미설정 → 에러', async () => {
    await expect(encryptBytes({}, new ArrayBuffer(1))).rejects.toThrow('MEMO_ENCRYPTION_KEY not configured')
    await expect(decryptBytes({}, new ArrayBuffer(20))).rejects.toThrow('MEMO_ENCRYPTION_KEY not configured')
  })
})
