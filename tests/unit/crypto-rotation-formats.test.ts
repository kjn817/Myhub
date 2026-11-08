/// <reference types="jest" />
/**
 * crypto.ts v2 포맷·전환 중 복호화 테스트 (트랙 4)
 * - ENC2:/MYH2 마커 세대 판별
 * - 키 지정 프리미티브의 v1/v2 상호 운용
 * - MEMO_ENCRYPTION_KEY_PREV 폴백: 혼합 상태(구 키 항목 + 신 키 항목)를
 *   한 환경에서 모두 읽을 수 있는가
 */
import {
  ciphertextFormat,
  decryptBytes,
  decryptBytesWithKey,
  decryptContent,
  decryptContentWithKey,
  encryptBytes,
  encryptBytesWithKey,
  encryptContent,
  encryptContentWithKey,
  isEncrypted,
} from '../../src/services/crypto'

const OLD_KEY = 'fmt-old-key-material-0001'
const NEW_KEY = 'fmt-new-key-material-0002'

describe('v2 포맷 마커', () => {
  test('encryptContentWithKey는 ENC2:를 만들고 양쪽 복호화가 된다', async () => {
    const ct = await encryptContentWithKey(NEW_KEY, '세대2 비밀')
    expect(ct.startsWith('ENC2:')).toBe(true)
    expect(ciphertextFormat(ct)).toBe('v2')
    expect(isEncrypted(ct)).toBe(true)
    expect(await decryptContentWithKey(NEW_KEY, ct)).toBe('세대2 비밀')
    expect(await decryptContent({ MEMO_ENCRYPTION_KEY: NEW_KEY }, ct)).toBe('세대2 비밀')
  })

  test('v1 암호문도 키 지정 복호화로 열린다 (세대 판별은 시도 복호화)', async () => {
    const ct = await encryptContent({ MEMO_ENCRYPTION_KEY: OLD_KEY }, '세대1 비밀')
    expect(ciphertextFormat(ct)).toBe('v1')
    expect(await decryptContentWithKey(OLD_KEY, ct)).toBe('세대1 비밀')
    await expect(decryptContentWithKey(NEW_KEY, ct)).rejects.toThrow()
  })

  test('ciphertextFormat: 평문·비문자열은 null', () => {
    expect(ciphertextFormat('그냥 텍스트')).toBeNull()
    expect(ciphertextFormat(42)).toBeNull()
    expect(ciphertextFormat(null)).toBeNull()
  })

  test('바이트 v2는 MYH2 매직을 달고, v1 바이트도 키 지정 복호화가 된다', async () => {
    const data = new TextEncoder().encode('바이너리').buffer as ArrayBuffer
    const v2 = await encryptBytesWithKey(NEW_KEY, data)
    expect(new TextDecoder().decode(v2.slice(0, 4))).toBe('MYH2')
    expect(new TextDecoder().decode(await decryptBytesWithKey(NEW_KEY, v2))).toBe('바이너리')

    const v1 = await encryptBytes({ MEMO_ENCRYPTION_KEY: OLD_KEY }, data)
    expect(new TextDecoder().decode(v1.slice(0, 4))).not.toBe('MYH2')
    expect(new TextDecoder().decode(await decryptBytesWithKey(OLD_KEY, v1))).toBe('바이너리')
    // 환경 복호화도 v2를 읽는다 (현행 키가 맞는 경우)
    expect(new TextDecoder().decode(await decryptBytes({ MEMO_ENCRYPTION_KEY: NEW_KEY }, v2))).toBe('바이너리')
  })
})

describe('MEMO_ENCRYPTION_KEY_PREV 폴백 (전환 중 혼합 상태)', () => {
  test('텍스트: 현행 키 실패 시 PREV로 읽는다', async () => {
    const ctNew = await encryptContentWithKey(NEW_KEY, '신 키 항목')
    const envMixed: any = { MEMO_ENCRYPTION_KEY: OLD_KEY, MEMO_ENCRYPTION_KEY_PREV: NEW_KEY }
    expect(await decryptContent(envMixed, ctNew)).toBe('신 키 항목')
    const ctOld = await encryptContent({ MEMO_ENCRYPTION_KEY: OLD_KEY }, '구 키 항목')
    expect(await decryptContent(envMixed, ctOld)).toBe('구 키 항목')
  })

  test('텍스트: PREV 없으면 신 키 항목은 실패한다 (폴백은 선택적)', async () => {
    const ctNew = await encryptContentWithKey(NEW_KEY, '신 키 항목')
    await expect(decryptContent({ MEMO_ENCRYPTION_KEY: OLD_KEY }, ctNew)).rejects.toThrow()
  })

  test('바이트: PREV 폴백으로 신 키 객체를 읽는다', async () => {
    const data = new TextEncoder().encode('신 키 첨부').buffer as ArrayBuffer
    const enc = await encryptBytesWithKey(NEW_KEY, data)
    const envMixed: any = { MEMO_ENCRYPTION_KEY: OLD_KEY, MEMO_ENCRYPTION_KEY_PREV: NEW_KEY }
    expect(new TextDecoder().decode(await decryptBytes(envMixed, enc))).toBe('신 키 첨부')
  })

  test('시크릿 교체 후 상태: 현행=신 키, PREV=구 키로 양쪽 다 읽힌다', async () => {
    const ctOld = await encryptContent({ MEMO_ENCRYPTION_KEY: OLD_KEY }, '미전환 항목')
    const ctNew = await encryptContentWithKey(NEW_KEY, '전환 항목')
    const envAfterSwap: any = { MEMO_ENCRYPTION_KEY: NEW_KEY, MEMO_ENCRYPTION_KEY_PREV: OLD_KEY }
    expect(await decryptContent(envAfterSwap, ctOld)).toBe('미전환 항목')
    expect(await decryptContent(envAfterSwap, ctNew)).toBe('전환 항목')
  })
})
