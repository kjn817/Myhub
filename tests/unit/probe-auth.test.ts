/// <reference types="jest" />
/**
 * 프로브 전용 토큰 인증 (src/modules/auth/probe.ts) 단위 테스트.
 *
 * 판정 행렬 — 허용 범위는 POST /api/ai/chat 딱 하나다. 이 범위가 넓어지면
 * (메서드·경로 제한 완화) 아래 테스트가 실패해야 한다 (카나리아).
 */
import { probeAuth } from '../../src/modules/auth/probe'

const TOKEN = 'probe-token-for-tests-0123456789abcdef'
const env = { PROBE_TOKEN: TOKEN } as any

describe('probeAuth', () => {
  test('유효한 토큰 + POST /api/ai/chat → ok', () => {
    expect(probeAuth(env, 'POST', '/api/ai/chat', `Bearer ${TOKEN}`)).toBe('ok')
  })

  test('Bearer 대소문자·토큰 앞뒤 공백은 허용한다', () => {
    expect(probeAuth(env, 'POST', '/api/ai/chat', `bearer  ${TOKEN} `)).toBe('ok')
  })

  test('GET /api/ai/chat에는 무효다 (메서드 제한)', () => {
    expect(probeAuth(env, 'GET', '/api/ai/chat', `Bearer ${TOKEN}`)).toBe('unauthorized')
  })

  test('POST /api/ai/orchestrate에는 무효다 (경로 제한)', () => {
    expect(probeAuth(env, 'POST', '/api/ai/orchestrate', `Bearer ${TOKEN}`)).toBe('unauthorized')
  })

  test('POST /api/memos에는 무효다 (경로 제한)', () => {
    expect(probeAuth(env, 'POST', '/api/memos', `Bearer ${TOKEN}`)).toBe('unauthorized')
  })

  test('쿼리스트링이 붙은 경로에는 무효다 (정확 일치)', () => {
    expect(probeAuth(env, 'POST', '/api/ai/chat?x=1', `Bearer ${TOKEN}`)).toBe('unauthorized')
  })

  test('틀린 토큰은 무효다', () => {
    expect(probeAuth(env, 'POST', '/api/ai/chat', 'Bearer wrong-token')).toBe('unauthorized')
  })

  test('한 글자만 다른 토큰은 무효다 (상수 시간 비교)', () => {
    const offByOne = TOKEN.slice(0, -1) + (TOKEN.endsWith('f') ? 'e' : 'f')
    expect(probeAuth(env, 'POST', '/api/ai/chat', `Bearer ${offByOne}`)).toBe('unauthorized')
  })

  test('헤더 없음·Bearer 아님은 무효다', () => {
    expect(probeAuth(env, 'POST', '/api/ai/chat', null)).toBe('unauthorized')
    expect(probeAuth(env, 'POST', '/api/ai/chat', undefined)).toBe('unauthorized')
    expect(probeAuth(env, 'POST', '/api/ai/chat', TOKEN)).toBe('unauthorized')
    expect(probeAuth(env, 'POST', '/api/ai/chat', 'Basic abc')).toBe('unauthorized')
  })

  test('PROBE_TOKEN 미설정 시 비활성화 (fail-closed)', () => {
    expect(probeAuth({} as any, 'POST', '/api/ai/chat', `Bearer ${TOKEN}`)).toBe('disabled')
    expect(probeAuth({ PROBE_TOKEN: '' } as any, 'POST', '/api/ai/chat', `Bearer ${TOKEN}`)).toBe('disabled')
  })
})
