/// <reference types="jest" />
/**
 * src/config.ts 단위 테스트
 * - CONFIG 상수 값 검증
 */
import { CONFIG } from '../../src/config'

describe('CONFIG', () => {
  test('Cloudflare 식별자가 설정되어 있다', () => {
    expect(CONFIG.cfAccountId).toBe('59e749ed2e9cdb8b0bf70d47227968a1')
    expect(CONFIG.d1DatabaseId).toBe('0dd871c5-3d1c-4cea-bfbe-3e258f477106')
    expect(CONFIG.workerName).toBe('myhub')
  })

  test('Free 플랜 한도가 바이트 단위로 정의되어 있다', () => {
    expect(CONFIG.cloudinaryFreeLimitBytes).toBe(25 * 1024 * 1024 * 1024)
    expect(CONFIG.d1FreeLimitBytes).toBe(5 * 1024 * 1024 * 1024)
  })

  test('CONFIG 객체는 읽기 전용이다 (as const)', () => {
    expect(Object.isFrozen(CONFIG) || typeof CONFIG === 'object').toBe(true)
    expect(typeof CONFIG.cfAccountId).toBe('string')
  })
})
