/// <reference types="jest" />
/**
 * provider-data-policy — 프로바이더 데이터 사용 정책 정렬 키 테스트 (재구축, 2026-11-07)
 *
 * 소실된 원본: tests/unit/provider-data-policy.test.ts (8건, 카나리아 확인済 — 2026-11-05 기록).
 * 재작성 근거: 운영 번들(.recovery/live-bundle)의 provider-allocation.ts 실물과
 * ai-model-selection.ts의 rank() 소비 공식 `s += (2 - dataUseRank(provider)) * 1e3`.
 *
 * 지키는 성질: 민감한 요청의 할당 정렬에서 "학습에 쓰지 않는(no-train)" 프로바이더가
 * "쓸 수 있는(may-use)" 프로바이더보다 항상 앞에 오고, 분류되지 않은 프로바이더는
 * 가장 뒤(최저 신뢰)로 간다. 정책표가 바뀌면(예: gemini를 no-train으로 오기) 실패해야 한다.
 */
import { PROVIDER_DATA_USE, dataUseRank } from '../../src/services/provider-allocation'

describe('PROVIDER_DATA_USE 정책표', () => {
  test('groq는 no-train이다 (ZDR 확인된 유일한 캘리 경로)', () => {
    expect(PROVIDER_DATA_USE.groq).toBe('no-train')
  })

  test('workers-ai는 no-train이다', () => {
    expect(PROVIDER_DATA_USE['workers-ai']).toBe('no-train')
  })

  test('gemini는 may-use다 (무료 티어 데이터 사용 가능 — 릴레이 경유 시에도 유지)', () => {
    expect(PROVIDER_DATA_USE.gemini).toBe('may-use')
  })

  test('nvidia는 may-use다 (그래서 개인 데이터는 NVIDIA로 보내지 않는 별도 가드가 필요하다)', () => {
    expect(PROVIDER_DATA_USE.nvidia).toBe('may-use')
  })

  test('정책표는 알려진 4개 프로바이더만 분류한다 — 미분류 프로바이더 추가 시 이 테스트가 실패해 명시 분류를 강제한다', () => {
    expect(Object.keys(PROVIDER_DATA_USE).sort()).toEqual(['gemini', 'groq', 'nvidia', 'workers-ai'])
  })
})

describe('dataUseRank 정렬 키', () => {
  test('no-train은 0, may-use는 1 — no-train이 항상 엄격히 앞선다', () => {
    expect(dataUseRank('groq')).toBe(0)
    expect(dataUseRank('workers-ai')).toBe(0)
    expect(dataUseRank('gemini')).toBe(1)
    expect(dataUseRank('nvidia')).toBe(1)
    expect(dataUseRank('groq')).toBeLessThan(dataUseRank('gemini'))
  })

  test('분류되지 않은 프로바이더는 2 — 어느 분류된 프로바이더보다도 뒤다 (fail-closed 방향)', () => {
    expect(dataUseRank('openai')).toBe(2)
    expect(dataUseRank('')).toBe(2)
    for (const p of Object.keys(PROVIDER_DATA_USE)) {
      expect(dataUseRank('openai')).toBeGreaterThan(dataUseRank(p))
    }
  })

  test('정렬 키 합성: 민감 요청 점수 (2 - rank) * 1000 기준 내림차순 정렬하면 no-train → may-use → 미분류 순이 된다', () => {
    // ai-model-selection rank()의 실제 소비 공식과 같은 합성을 검증한다.
    const candidates = ['nvidia', 'unknown-x', 'gemini', 'groq', 'workers-ai']
    const sorted = [...candidates].sort((a, b) => (2 - dataUseRank(b)) * 1000 - (2 - dataUseRank(a)) * 1000)
    const rankSeq = sorted.map((p) => dataUseRank(p))
    expect(rankSeq).toEqual([...rankSeq].sort((x, y) => x - y))
    expect(sorted[sorted.length - 1]).toBe('unknown-x')
    expect(new Set(sorted.slice(0, 2))).toEqual(new Set(['groq', 'workers-ai']))
  })
})
