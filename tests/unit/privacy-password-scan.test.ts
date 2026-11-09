/// <reference types="jest" />
/**
 * src/services/privacy-password-scan.ts — 비밀번호 값 검증·공백 분리 스캔 성질.
 *
 * passwordValueOk의 핵심은 "비밀번호 안내 문구(변경하세요 등)를 값으로
 * 오인하지 않는 것"과 "실제 비밀값은 통과시키는 것"의 경계다.
 * scanSpacedPassword는 "공백으로 쪼갠 비밀"만 잡고, 한국어 토큰·따옴표·
 * 줄바꿈이 끼면 연결이 끊긴 것으로 본다.
 * 카나리아: PW_GUIDANCE_VERB_RE의 '변경'을 지우거나 토큰 상한(8)을 바꾸면 실패한다.
 */
import { passwordValueOk, scanSpacedPassword } from '../../src/services/privacy-password-scan'

describe('passwordValueOk', () => {
  test('안내성 종결 표현(입니다·관리하세요 등)은 값이 아니다', () => {
    expect(passwordValueOk('입니다', '비밀번호는 입니다')).toBe(false)
    expect(passwordValueOk('관리하세요', '비밀번호 관리하세요')).toBe(false)
    expect(passwordValueOk('변경', '비밀번호 변경')).toBe(false)
  })

  test('순수 한글 부사형 어미(하게/적으로)는 값이 아니다', () => {
    expect(passwordValueOk('조심하게', '비밀번호는 조심하게')).toBe(false)
    expect(passwordValueOk('정기적으로', '비밀번호는 정기적으로')).toBe(false)
  })

  test('안내 명사로 시작하는 순수 한글은 값이 아니다', () => {
    expect(passwordValueOk('보안정책', '비밀번호 보안정책')).toBe(false)
    expect(passwordValueOk('안전수칙', '비밀번호 안전수칙')).toBe(false)
  })

  test('값 뒤에 안내 동사가 이어지면 값이 아니다', () => {
    expect(passwordValueOk('홍길동', '비밀번호는 홍길동 변경하세요')).toBe(false)
    expect(passwordValueOk('홍길동', '비밀번호는 홍길동 보관하세요')).toBe(false)
  })

  test('실제 비밀값은 통과한다', () => {
    expect(passwordValueOk('mysecret99', '비밀번호는 mysecret99 입니다')).toBe(true)
    expect(passwordValueOk('홍길동', '비밀번호는 홍길동 입니다')).toBe(true)
    expect(passwordValueOk('P@ssw0rd!', 'password: P@ssw0rd!')).toBe(true)
  })

  test('앞뒤 공백은 trim 후 판정한다', () => {
    expect(passwordValueOk('  입니다  ', 'ctx')).toBe(false)
    expect(passwordValueOk('  abc123  ', 'ctx')).toBe(true)
  })
})

describe('scanSpacedPassword', () => {
  test('공백으로 쪼갠 비밀번호를 하나의 구간으로 잡는다', () => {
    const text = '비밀번호: ab cd 12'
    const out = scanSpacedPassword(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'PASSWORD', level: 3 })
    expect(text.slice(out[0].start, out[0].end)).toBe('ab cd 12')
  })

  test('토큰이 하나뿐이면(쪼개지지 않았으면) 이 스캐너는 잡지 않는다', () => {
    expect(scanSpacedPassword('비밀번호: abcd1234')).toEqual([])
  })

  test('숫자도 기호도 없는 알파벳 토큰만으로는 잡지 않는다', () => {
    expect(scanSpacedPassword('비밀번호: ab cd ef')).toEqual([])
  })

  test('한국어 토큰이 끼면 연결이 끊긴다', () => {
    expect(scanSpacedPassword('비밀번호: ab 한글 cd12')).toEqual([])
  })

  test('따옴표가 있는 토큰이 끼면 연결이 끊긴다', () => {
    expect(scanSpacedPassword("비밀번호: ab 'cd12' ef")).toEqual([])
  })

  test('토큰 사이의 줄바꿈도 공백으로 취급해 연결이 유지된다 (2026-11-09 누출 사냥에서 계약 변경)', () => {
    const text = '비밀번호: ab\ncd12'
    const out = scanSpacedPassword(text)
    expect(out).toHaveLength(1)
    expect(text.slice(out[0].start, out[0].end)).toBe('ab\ncd12')
  })

  test('끝의 문장부호는 구간에서 제외된다', () => {
    const text = '비밀번호: ab, cd12.'
    const out = scanSpacedPassword(text)
    expect(out).toHaveLength(1)
    expect(text.slice(out[0].start, out[0].end)).toBe('ab, cd12')
  })

  test('토큰은 최대 32개까지만 하나의 구간으로 묶는다 (상한 8→32, 2026-11-09 누출 사냥에서 계약 변경)', () => {
    const toks = Array.from({ length: 33 }, (_, i) => `t${i}`)
    const text = `비밀번호: ${toks.join(' ')}`
    const out = scanSpacedPassword(text)
    expect(out).toHaveLength(1)
    expect(text.slice(out[0].start, out[0].end)).toBe(toks.slice(0, 32).join(' '))
  })

  test('합쳐도 4자 미만이면 잡지 않는다', () => {
    expect(scanSpacedPassword('비밀번호: a 1')).toEqual([])
  })

  test('키워드가 없으면 잡지 않는다', () => {
    expect(scanSpacedPassword('그냥 ab cd 12 문장')).toEqual([])
  })
})
