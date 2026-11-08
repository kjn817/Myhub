/// <reference types="jest" />
/**
 * clef-g5-gate — Clef 라우터 G5 안전 게이트 테스트 (재구축, 2026-11-07, 신규 도출)
 *
 * 근거: 운영 번들(.recovery/live-bundle)의 clef-engine.ts 실물 —
 * evaluateG5Gate와 CLEF_THRESHOLDS(clef-thresholds-v2-20261105).
 * G5는 "안전 구간(top≥0.90·margin≥0.40·비복합·쓰기 의도 없음·멘션 없음·잠긴 비서 아님)
 * 에서만 자동 적용"이라는 운영 계약(ai_settings clef.router_mode='active')의 집행 지점이다.
 * 경계값(0.90·0.40·0.80)은 포함/배제 방향까지 고정한다 — 임계값을 낮추면 이 스위트가 실패해야 한다.
 *
 * 상태: clef-engine이 아직 재구성 전이라 모듈 도착 후 실행된다 (clef-mode는 재구성 완료).
 */
import {
  evaluateG5Gate,
  hasMention,
  CLEF_THRESHOLDS,
  CLEF_THRESHOLD_VERSION,
} from '../../src/services/clef-engine'
import { getClefRouterMode, CLEF_ROUTER_MODE_KEY } from '../../src/services/clef-mode'

// lockedPersona는 boolean이 아니라 "잠긴 비서가 후보에 있으면 그 비서의 id"다
// (호출자가 잠금 여부를 판정해 넘긴다 — 게이트는 truthy 여부만 본다).
const SAFE = {
  top: 0.95,
  margin: 0.5,
  multiple: 0.3,
  message: '오늘 날씨 어때?',
  hasMention: false,
  lockedPersona: null,
}

describe('evaluateG5Gate — 안전 구간 판정', () => {
  test('전부 안전하면 apply=true, reasons는 비어 있다', () => {
    expect(evaluateG5Gate(SAFE)).toEqual({ apply: true, reasons: [] })
  })

  test('top이 0.90 미만이면 top_below_safe', () => {
    const r = evaluateG5Gate({ ...SAFE, top: 0.89 })
    expect(r.apply).toBe(false)
    expect(r.reasons).toEqual(['top_below_safe'])
  })

  test('top이 정확히 0.90이면 경계 통과', () => {
    expect(evaluateG5Gate({ ...SAFE, top: 0.9 }).apply).toBe(true)
  })

  test('top이 없으면(판정 불능) top_below_safe — 불확실하면 적용하지 않는다', () => {
    const { top: _drop, ...noTop } = SAFE
    expect(evaluateG5Gate(noTop).reasons).toContain('top_below_safe')
  })

  test('margin이 0.40 미만이면 margin_below_safe, 정확히 0.40이면 통과', () => {
    expect(evaluateG5Gate({ ...SAFE, margin: 0.39 }).reasons).toEqual(['margin_below_safe'])
    expect(evaluateG5Gate({ ...SAFE, margin: 0.4 }).apply).toBe(true)
  })

  test('복합 판정 확률(multiple)이 0.80 이상이면 compound — 경계 포함', () => {
    expect(evaluateG5Gate({ ...SAFE, multiple: 0.8 }).reasons).toEqual(['compound'])
    expect(evaluateG5Gate({ ...SAFE, multiple: 0.79 }).apply).toBe(true)
    const { multiple: _drop, ...noMultiple } = SAFE
    expect(evaluateG5Gate(noMultiple).apply).toBe(true)
  })

  test('쓰기 의도가 있는 메시지는 적용 제외 (write_intent)', () => {
    const r = evaluateG5Gate({ ...SAFE, message: '내일 회의 일정 등록해줘' })
    expect(r.apply).toBe(false)
    expect(r.reasons).toEqual(['write_intent'])
  })

  test('읽기 전용 질문은 쓰기 의도로 오판하지 않는다', () => {
    expect(evaluateG5Gate({ ...SAFE, message: '내일 회의 일정 알려줘' }).apply).toBe(true)
  })

  test('멘션이 있으면 mention, 잠긴 비서가 후보면 locked_persona', () => {
    expect(evaluateG5Gate({ ...SAFE, hasMention: true }).reasons).toEqual(['mention'])
    expect(evaluateG5Gate({ ...SAFE, lockedPersona: 'echo' }).reasons).toEqual(['locked_persona'])
  })

  test('복수 위반은 전부 누적된다 (하나라도 숨기지 않는다)', () => {
    const r = evaluateG5Gate({
      top: 0.5, margin: 0.1, multiple: 0.9,
      message: '메모 삭제해줘', hasMention: true, lockedPersona: 'echo',
    })
    expect(r.apply).toBe(false)
    expect(new Set(r.reasons)).toEqual(new Set([
      'top_below_safe', 'margin_below_safe', 'compound', 'write_intent', 'mention', 'locked_persona',
    ]))
  })
})

describe('CLEF_THRESHOLDS — 임계값 핀', () => {
  test('G5 안전 구간 임계값과 버전이 고정돼 있다', () => {
    expect(CLEF_THRESHOLDS.g5Top).toBe(0.9)
    expect(CLEF_THRESHOLDS.g5Margin).toBe(0.4)
    expect(CLEF_THRESHOLDS.compoundNoul).toBe(0.8)
    expect(CLEF_THRESHOLD_VERSION).toBe('clef-thresholds-v2-20261105')
  })
})

describe('hasMention — 비서 멘션 탐지', () => {
  test('@에코·@calli 같은 멘션을 잡는다', () => {
    expect(hasMention('@에코 이거 확인해줘')).toBe(true)
    expect(hasMention('@calli 일정 봐줘')).toBe(true)
  })

  test('멘션 없는 일반 문장의 비서 이름은 멘션이 아니다', () => {
    expect(hasMention('에코가 어제 정리한 메모 보여줘')).toBe(false)
    expect(hasMention('echo chamber 효과 설명해줘')).toBe(false)
  })
})

describe('getClefRouterMode — ai_settings 해석', () => {
  const dbWith = (value: string | null) => ({
    prepare: (_sql: string) => ({
      bind: (_key: string) => ({
        first: async () => (value === null ? null : { value }),
      }),
    }),
  })

  test("키 이름은 'clef.router_mode'이고, 저장값 active/shadow만 인정한다", async () => {
    expect(CLEF_ROUTER_MODE_KEY).toBe('clef.router_mode')
    await expect(getClefRouterMode(dbWith('active') as never)).resolves.toBe('active')
    await expect(getClefRouterMode(dbWith('shadow') as never)).resolves.toBe('shadow')
  })

  test('미설정·알 수 없는 값은 off로 떨어진다 (기본은 비활성)', async () => {
    await expect(getClefRouterMode(dbWith(null) as never)).resolves.toBe('off')
    await expect(getClefRouterMode(dbWith('ACTIVE') as never)).resolves.toBe('off')
    await expect(getClefRouterMode(dbWith('on') as never)).resolves.toBe('off')
  })
})
