/// <reference types="jest" />
/**
 * Deadline 유틸 단위 테스트 (2026-10-26 트랙 A2)
 * - withTimeout: 시간 내 완료·타임아웃 reject·즉시 타임아웃·타이머 해제
 * - remainingMs: 남은 시간·음수 → 0
 */
import { remainingMs, withTimeout } from '../../src/lib/deadline'

describe('withTimeout', () => {
  it('시간 안에 끝나면 원본 값을 그대로 반환', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42)
  })

  it('시간을 넘기면 지정 메시지로 reject', async () => {
    await expect(withTimeout(new Promise(() => {}), 50, 'leg timeout')).rejects.toThrow('leg timeout')
  })

  it('원본이 reject되면 그 에러가 그대로 전파 (타임아웃 아님)', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom')
  })

  it('ms <= 0이면 즉시 타임아웃 (기다리지 않음)', async () => {
    const start = Date.now()
    await expect(withTimeout(new Promise(() => {}), 0, 'now')).rejects.toThrow('now')
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('hang promise도 예산 안에 끝나야 함 (signal 무시 mock 재현)', async () => {
    const start = Date.now()
    await expect(
      withTimeout(new Promise(() => {}), 100, 'hang'),
    ).rejects.toThrow('hang')
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

describe('remainingMs', () => {
  it('deadline까지 남은 시간을 반환', () => {
    expect(remainingMs(1000, 400)).toBe(600)
  })

  it('이미 지난 deadline이면 0', () => {
    expect(remainingMs(1000, 1500)).toBe(0)
    expect(remainingMs(1000, 1000)).toBe(0)
  })
})
