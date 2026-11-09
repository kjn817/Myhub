/// <reference types="jest" />
/**
 * 로테이션 전용 step-up 게이트(requireRotationStepUp) 자체 계약 — KR-07 대응.
 *
 * 엔드포인트 경로에서는 공용 게이트(requireProtectedAccess)가 먼저 같은
 * stepUpUntil을 검사하므로, 신선도 게이트 안의 유효성 검사는 합성상
 * 백스톱이 된다. 공용 게이트를 통과한 것으로 고정(mock)하고 게이트 자체만
 * 떼어 검증한다: stepUpUntil이 없거나 숫자가 아니거나 NaN이면 거부해야 한다.
 */
jest.mock('../../src/modules/memo/routes', () => ({
  requireProtectedAccess: jest.fn(async () => ({ ok: true })),
  hasConfiguredPin: jest.fn(async () => true),
}))

import { requireRotationStepUp } from '../../src/modules/key-rotation/routes'
import { STEP_UP_TTL_MS } from '../../src/modules/auth/primitives'

function fakeC(stepUpUntil: any) {
  return {
    env: {},
    get: (k: string) => (k === 'stepUpUntil' ? stepUpUntil : undefined),
  } as any
}

describe('requireRotationStepUp 자체 유효성 검사 (KR-07)', () => {
  test('stepUpUntil이 없으면 403 STEP_UP_REQUIRED', async () => {
    const gate = await requireRotationStepUp(fakeC(undefined))
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.status).toBe(403)
      expect(gate.body.code).toBe('STEP_UP_REQUIRED')
    }
  })

  test('stepUpUntil이 숫자가 아니면 403', async () => {
    const gate = await requireRotationStepUp(fakeC('soon'))
    expect(gate.ok).toBe(false)
  })

  test('stepUpUntil이 NaN이면 403', async () => {
    const gate = await requireRotationStepUp(fakeC(NaN))
    expect(gate.ok).toBe(false)
  })

  test('stepUpUntil이 0이면 403', async () => {
    const gate = await requireRotationStepUp(fakeC(0))
    expect(gate.ok).toBe(false)
  })

  test('방금 발급된 stepUpUntil은 통과한다 (대조군)', async () => {
    const gate = await requireRotationStepUp(fakeC(Date.now() + STEP_UP_TTL_MS))
    expect(gate.ok).toBe(true)
  })
})
