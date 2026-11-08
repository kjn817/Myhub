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
  encryptContentWithKey,
  decryptContentWithKey,
  encryptBytesWithKey,
  decryptBytesWithKey,
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

describe('키 지정 프리미티브 (로테이션 도구 전용 — 뮤테이션 NoCoverage 대응, 트랙 2)', () => {
  const KEY_A = b64('A'.repeat(32))
  const KEY_B = b64('B'.repeat(32))

  test('encryptContentWithKey는 ENC2: 마커를 달고, 같은 키로만 복호화된다', async () => {
    const ct = await encryptContentWithKey(KEY_A, 'rotation-target')
    expect(ct.startsWith('ENC2:')).toBe(true)
    expect(isEncrypted(ct)).toBe(true)
    await expect(decryptContentWithKey(KEY_A, ct)).resolves.toBe('rotation-target')
    await expect(decryptContentWithKey(KEY_B, ct)).rejects.toThrow()
  })

  test('decryptContentWithKey는 v1(ENC:) 암호문도 복호화한다 (세대 판별용)', async () => {
    const v1 = await encryptContent(envWith(KEY_A), 'legacy-text')
    expect(v1.startsWith('ENC:')).toBe(true)
    await expect(decryptContentWithKey(KEY_A, v1)).resolves.toBe('legacy-text')
  })

  test('encryptBytesWithKey는 v2 매직을 달고, decryptBytesWithKey로 왕복된다', async () => {
    const data = new TextEncoder().encode('byte-target').buffer as ArrayBuffer
    const enc = new Uint8Array(await encryptBytesWithKey(KEY_A, data))
    // v2 매직 'MYH2' (4바이트) 가 선두에 있어야 한다
    expect(String.fromCharCode(...enc.slice(0, 4))).toBe('MYH2')
    const dec = await decryptBytesWithKey(KEY_A, enc.buffer as ArrayBuffer)
    expect(new TextDecoder().decode(dec)).toBe('byte-target')
    await expect(decryptBytesWithKey(KEY_B, enc.buffer as ArrayBuffer)).rejects.toThrow()
  })

  test('decryptBytesWithKey는 v1 바이트(iv+ct, 매직 없음)도 복호화한다', async () => {
    const data = new TextEncoder().encode('legacy-bytes').buffer as ArrayBuffer
    const v1 = await encryptBytes(envWith(KEY_A), data)
    const dec = await decryptBytesWithKey(KEY_A, v1)
    expect(new TextDecoder().decode(dec)).toBe('legacy-bytes')
  })
})

describe('구 키 폴백 (전환 중 혼합 상태 — crypto.ts:201 생존 뮤턴트 대응, 트랙 2)', () => {
  const KEY_OLD = b64('O'.repeat(32))
  const KEY_NEW = b64('N'.repeat(32))

  test('현행 키로 못 열면 PREV 키로 복호화한다 (텍스트·바이트)', async () => {
    const ct = await encryptContent(envWith(KEY_OLD), 'mixed-state')
    const envMixed: any = { MEMO_ENCRYPTION_KEY: KEY_NEW, MEMO_ENCRYPTION_KEY_PREV: KEY_OLD }
    await expect(decryptContent(envMixed, ct)).resolves.toBe('mixed-state')

    const data = new TextEncoder().encode('mixed-bytes').buffer as ArrayBuffer
    const encBytes = await encryptBytes(envWith(KEY_OLD), data)
    const dec = await decryptBytes(envMixed, encBytes)
    expect(new TextDecoder().decode(dec)).toBe('mixed-bytes')
  })

  test('PREV가 없거나 틀리면 원래 오류가 그대로 던져진다', async () => {
    const ct = await encryptContent(envWith(KEY_OLD), 'mixed-state')
    await expect(decryptContent(envWith(KEY_NEW), ct)).rejects.toThrow()
    const envWrongPrev: any = { MEMO_ENCRYPTION_KEY: KEY_NEW, MEMO_ENCRYPTION_KEY_PREV: b64('X'.repeat(32)) }
    await expect(decryptContent(envWrongPrev, ct)).rejects.toThrow()
  })
})
