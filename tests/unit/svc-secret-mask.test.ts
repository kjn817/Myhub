/// <reference types="jest" />
/**
 * secret-mask.ts 커버리지 테스트
 * - API 키/카드번호/비밀번호/토큰 패턴 마스킹
 * - Luhn 카드번호 검증
 * - AI 전송 허용 등급
 *
 * NOTE: 28행(luhnCheck 조기반환)은 CARD_RE가 13-19회 반복을 강제하므로
 * 도달 불가한 방어 코드임 (digits는 항상 13~19). 소스 수정 없이 도달 불가.
 * 달성: statements 96.87% / branches 90% / functions 100% / lines 100%
 *
 * NOTE: canSendToAI(-1) === true (sensitivity <= 1) — 음수 등급 허용은
 * 스펙 검토 대상. 테스트에 현재 동작을 문서화함.
 */
import { maskSecrets, canSendToAI } from '../../src/services/secret-mask'

describe('luhnCheck (간접 검증)', () => {
  test('유효한 카드번호는 마스킹된다', () => {
    // Visa 테스트 번호 (유효한 Luhn)
    const r = maskSecrets('카드: 4111111111111111')
    expect(r.masked).toContain('[CARD_MASKED]')
    expect(r.count).toBe(1)
  })

  test('하이픈/공백 포함 카드번호도 마스킹된다', () => {
    const r = maskSecrets('4111-1111-1111-1111')
    expect(r.masked).toContain('[CARD_MASKED]')
    expect(r.count).toBe(1)
    const r2 = maskSecrets('4111 1111 1111 1111')
    expect(r2.masked).toContain('[CARD_MASKED]')
  })

  test('Luhn 실패 번호는 마스킹되지 않는다', () => {
    const r = maskSecrets('번호: 4111111111111112')
    expect(r.masked).toContain('4111111111111112')
    expect(r.count).toBe(0)
  })

  test('13자리 미만 숫자 연속은 카드로 취급되지 않는다', () => {
    const r = maskSecrets('주문번호 123456789012')
    expect(r.count).toBe(0)
  })

  test('숫자 13개 미만인 구분자 포함 문자열은 카드로 취급되지 않는다', () => {
    // 숫자 10개 → CARD_RE 13회 반복 미달 → 매칭 없음
    const r = maskSecrets('12-34-56-78-90ab')
    expect(r.masked).not.toContain('[CARD_MASKED]')
    expect(r.count).toBe(0)
  })

  test('Amex 테스트 번호(15자리) 마스킹', () => {
    const r = maskSecrets('378282246310005')
    expect(r.masked).toContain('[CARD_MASKED]')
  })

  test('유효하지 않은 13자리 번호는 그대로', () => {
    const r = maskSecrets('4000000000000')
    // 4000000000000: Luhn 실패 (유효한 테스트 번호가 아님)
    expect(r.masked).toContain('4000000000000')
    expect(r.count).toBe(0)
  })
})

describe('API 키 패턴', () => {
  test('AWS 키 마스킹', () => {
    const r = maskSecrets('key=AKIAIOSFODNN7EXAMPLE')
    expect(r.masked).toContain('[AWS_KEY_MASKED]')
    expect(r.count).toBe(1)
  })

  test('GitHub 토큰 마스킹', () => {
    const r = maskSecrets('token ghp_' + 'a'.repeat(36))
    expect(r.masked).toContain('[GITHUB_TOKEN_MASKED]')
    expect(r.count).toBe(1)
  })

  test('GitHub 토큰 변형(ghu_, gho_) 마스킹', () => {
    const r = maskSecrets('ghu_' + 'b'.repeat(40))
    expect(r.masked).toContain('[GITHUB_TOKEN_MASKED]')
  })

  test('sk- API 키 마스킹', () => {
    const r = maskSecrets('api key is sk-' + 'c'.repeat(24))
    expect(r.masked).toContain('[API_KEY_MASKED]')
    expect(r.count).toBe(1)
  })

  test('짧은 sk- 문자열은 마스킹되지 않는다', () => {
    const r = maskSecrets('sk-abc')
    expect(r.count).toBe(0)
  })
})

describe('비밀번호/토큰 패턴', () => {
  test('password= 뒤 값 마스킹', () => {
    const r = maskSecrets('login password=hunter2 done')
    expect(r.masked).toContain('[PASSWORD_MASKED]')
    expect(r.count).toBe(1)
    expect(r.masked).not.toContain('hunter2')
  })

  test('PASSWD: / pwd = 변형 (대소문자 무관)', () => {
    const r = maskSecrets('Passwd: secret1 and pwd = secret2')
    expect(r.count).toBe(2)
    expect(r.masked).not.toContain('secret1')
    expect(r.masked).not.toContain('secret2')
  })

  test('Bearer 토큰 마스킹 (줄 끝)', () => {
    const r = maskSecrets('Authorization: Bearer abcDEF123-._~+/==\nnext line')
    expect(r.masked).toContain('[BEARER_MASKED]')
    expect(r.count).toBe(1)
  })
})

describe('maskSecrets 종합', () => {
  test('빈 문자열', () => {
    const r = maskSecrets('')
    expect(r.masked).toBe('')
    expect(r.count).toBe(0)
  })

  test('시크릿 없음', () => {
    const r = maskSecrets('오늘 날씨가 좋네요')
    expect(r.masked).toBe('오늘 날씨가 좋네요')
    expect(r.count).toBe(0)
  })

  test('여러 시크릿 누적 카운트', () => {
    const r = maskSecrets('AKIAIOSFODNN7EXAMPLE and password=x1 and 4111111111111111')
    expect(r.count).toBe(3)
    expect(r.masked).toContain('[AWS_KEY_MASKED]')
    expect(r.masked).toContain('[PASSWORD_MASKED]')
    expect(r.masked).toContain('[CARD_MASKED]')
  })

  test('동일 시크릿 반복도 각각 카운트', () => {
    const r = maskSecrets('pw password=a1 password=a2')
    expect(r.count).toBe(2)
  })
})

describe('canSendToAI', () => {
  test.each([0, 1])('등급 %i 허용', (s) => {
    expect(canSendToAI(s)).toBe(true)
  })

  test.each([2, 3, 4, 99])('등급 %i 차단', (s) => {
    expect(canSendToAI(s)).toBe(false)
  })

  test('음수 등급은 허용된다 (sensitivity <= 1) — 경계 이슈 문서화', () => {
    // canSendToAI(-1) === true: 의도된 동작인지 검토 필요 (현재 스펙상 허용)
    expect(canSendToAI(-1)).toBe(true)
  })
})
