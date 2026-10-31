/**
 * src/ai/retry-policy.ts 단위 테스트
 */
/// <reference types="jest" />
import { parseRetryAfter, decideRetry } from '../../src/ai/retry-policy'

describe('parseRetryAfter', () => {
  test('null/undefined/빈값 → null', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('   ')).toBeNull()
  })

  test('비문자열 → null', () => {
    expect(parseRetryAfter(123 as any)).toBeNull()
    expect(parseRetryAfter({} as any)).toBeNull()
  })

  test('정수 초 → ms', () => {
    expect(parseRetryAfter('120')).toBe(120000)
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter('1')).toBe(1000)
  })

  test('소수 초 → ms (내림)', () => {
    expect(parseRetryAfter('1.5')).toBe(1500)
    expect(parseRetryAfter('0.1')).toBe(100)
    // 1.999초 → 1999ms (floor)
    expect(parseRetryAfter('1.999')).toBe(1999)
  })

  test('음수 → 0', () => {
    expect(parseRetryAfter('-5')).toBe(0)
    expect(parseRetryAfter('-0.5')).toBe(0)
  })

  test('공백 포함 숫자', () => {
    expect(parseRetryAfter('  30  ')).toBe(30000)
  })

  test('1시간 초과 → 상한 1시간', () => {
    expect(parseRetryAfter('7200')).toBe(3600000) // 2시간 → 1시간
    expect(parseRetryAfter('3600')).toBe(3600000) // 정확히 1시간
    expect(parseRetryAfter('3601')).toBe(3600000) // 1시간 초과
  })

  test('HTTP 날짜 (미래) → 남은 시간', () => {
    const future = new Date(Date.now() + 60000).toUTCString()
    const result = parseRetryAfter(future)
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(0)
    expect(result!).toBeLessThanOrEqual(60000)
  })

  test('HTTP 날짜 (과거) → 0', () => {
    const past = new Date(Date.now() - 60000).toUTCString()
    expect(parseRetryAfter(past)).toBe(0)
  })

  test('HTTP 날짜 (1시간 초과 미래) → 상한', () => {
    const farFuture = new Date(Date.now() + 2 * 3600000).toUTCString()
    expect(parseRetryAfter(farFuture)).toBe(3600000)
  })

  test('파싱 불가 문자열 → null', () => {
    expect(parseRetryAfter('not-a-date')).toBeNull()
    expect(parseRetryAfter('abc123')).toBeNull()
  })

  test('Infinity → null (isFinite 체크)', () => {
    expect(parseRetryAfter('Infinity')).toBeNull()
  })

  test('NaN 문자열 → null', () => {
    // Number('NaN')은 NaN → isNaN 체크
    expect(parseRetryAfter('NaN')).toBeNull()
  })
})

describe('decideRetry', () => {
  test('abortSignal aborted → cancelled', () => {
    const controller = new AbortController()
    controller.abort()
    const d = decideRetry('10', { abortSignal: controller.signal })
    expect(d.canRetry).toBe(false)
    expect(d.waitMs).toBe(0)
    expect(d.reason).toBe('cancelled')
    expect(d.retryAt).toBeUndefined()
  })

  test('abortSignal 없음 → 정상 진행', () => {
    const d = decideRetry('5', {})
    expect(d.canRetry).toBe(true)
  })

  test('파싱 불가 → 재시도 불가', () => {
    const d = decideRetry('invalid', {})
    expect(d.canRetry).toBe(false)
    expect(d.waitMs).toBe(0)
    expect(d.reason).toBe('retry-after-unparseable')
  })

  test('null 헤더 → 재시도 불가', () => {
    const d = decideRetry(null, {})
    expect(d.canRetry).toBe(false)
    expect(d.reason).toBe('retry-after-unparseable')
  })

  test('짧은 지연 (30초 이하) → 대기 가능', () => {
    const d = decideRetry('10', {})
    expect(d.canRetry).toBe(true)
    expect(d.waitMs).toBe(10000)
    expect(d.retryAt).toBeDefined()
    expect(d.reason).toBe('short-delay')
  })

  test('정확히 30초 → short-delay', () => {
    const d = decideRetry('30', {})
    expect(d.canRetry).toBe(true)
    expect(d.reason).toBe('short-delay')
  })

  test('30초 초과 → 종료 (long-delay-terminate)', () => {
    const d = decideRetry('60', { maxTotalMs: 120000 })
    expect(d.canRetry).toBe(false)
    expect(d.waitMs).toBe(0)
    expect(d.retryAt).toBeDefined()
    expect(d.reason).toBe('long-delay-terminate')
  })

  test('대기 시간이 예산 초과 → wait-exceeds-budget', () => {
    const d = decideRetry('50', { elapsedMs: 40000, maxTotalMs: 60000 })
    // waitMs=50000, remaining=20000 → 초과
    expect(d.canRetry).toBe(false)
    expect(d.waitMs).toBe(0)
    expect(d.retryAt).toBeDefined()
    expect(d.reason).toBe('wait-exceeds-budget')
  })

  test('대기 시간이 예산 내 → short-delay', () => {
    const d = decideRetry('10', { elapsedMs: 40000, maxTotalMs: 60000 })
    // waitMs=10000, remaining=20000 → 가능
    expect(d.canRetry).toBe(true)
    expect(d.reason).toBe('short-delay')
  })

  test('기본 maxTotalMs 60초', () => {
    // elapsedMs 없이 50초 대기 → remaining 60초 → 가능하지만 long-delay
    const d = decideRetry('50', {})
    expect(d.canRetry).toBe(false)
    expect(d.reason).toBe('long-delay-terminate')
  })

  test('elapsedMs 기본값 0', () => {
    const d = decideRetry('5', { maxTotalMs: 60000 })
    expect(d.canRetry).toBe(true)
  })

  test('waitMs 0 → short-delay (즉시 재시도)', () => {
    const d = decideRetry('0', {})
    expect(d.canRetry).toBe(true)
    expect(d.waitMs).toBe(0)
    expect(d.reason).toBe('short-delay')
  })

  test('과거 날짜 → waitMs 0 → short-delay', () => {
    const past = new Date(Date.now() - 1000).toUTCString()
    const d = decideRetry(past, {})
    expect(d.canRetry).toBe(true)
    expect(d.waitMs).toBe(0)
  })

  test('options 생략 → 기본값 사용', () => {
    const d = decideRetry('5')
    expect(d.canRetry).toBe(true)
    expect(d.waitMs).toBe(5000)
  })
})
