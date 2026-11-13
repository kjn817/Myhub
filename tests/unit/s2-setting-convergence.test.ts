/// <reference types="jest" />
/**
 * S2-5 수렴 핀: ai_settings 조회는 바인드 파라미터 방식(getSetting)으로만 한다.
 * 문자열 보간(readSettingValue)은 제거됐다 — 키가 SQL 문자열에 들어가면 안 된다.
 *
 * 핵심 성질 (호출부 5곳 전수):
 * ① 발행 SQL은 'SELECT value FROM ai_settings WHERE key = ?'이고 키는 bind 인자다.
 * ② SQL 문자열 안에 키 리터럴이 포함되지 않는다 (보간 회귀 방지).
 * ③ 조회 실패 시 플래그는 false, 날짜 마커는 null이다 (기존 fail 의미 유지).
 * 카나리아: 어느 호출부든 보간 방식으로 되돌리면 ①·②가 실패한다.
 */
import { isLlmExtractEnabled } from '../../src/services/fact-graph'
import { getLastConsolidationDate, isLlmConsolidationEnabled } from '../../src/services/memory-consolidation'
import { isLlmReflectionEnabled } from '../../src/services/memory-reflection'
import { isMemoryV2Enabled } from '../../src/services/memory-service'

function recordingDb(value: string | null | 'throw') {
  const calls: { sql: string; params: any[] }[] = []
  const db = {
    prepare(sql: string) {
      const stmt: any = {
        bind(...p: any[]) {
          calls.push({ sql, params: p })
          return stmt
        },
        async first() {
          if (value === 'throw') throw new Error('db down')
          return value === null ? null : { value }
        },
      }
      return stmt
    },
  }
  return { calls, db: db as any }
}

const BOOLEAN_FLAGS: Array<{
  name: string
  key: string
  fn: (env: any) => Promise<boolean>
}> = [
  { name: 'isMemoryV2Enabled', key: 'memory.v2_enabled', fn: isMemoryV2Enabled },
  { name: 'isLlmExtractEnabled', key: 'memory.llm_extract_enabled', fn: isLlmExtractEnabled },
  { name: 'isLlmConsolidationEnabled', key: 'memory.llm_consolidation_enabled', fn: isLlmConsolidationEnabled },
  { name: 'isLlmReflectionEnabled', key: 'memory.llm_reflection_enabled', fn: isLlmReflectionEnabled },
]

describe('S2-5: ai_settings 조회는 바인드 파라미터만 쓴다', () => {
  test.each(BOOLEAN_FLAGS)('$name: key = ? 바인드 조회, 키 리터럴이 SQL에 없다', async ({ key, fn }) => {
    const { calls, db } = recordingDb('true')
    expect(await fn({ DB: db })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT value FROM ai_settings WHERE key = ?')
    expect(calls[0].params).toEqual([key])
    expect(calls[0].sql).not.toContain(key)
  })

  test.each(BOOLEAN_FLAGS)('$name: 조회 실패 → false', async ({ fn }) => {
    const { db } = recordingDb('throw')
    expect(await fn({ DB: db })).toBe(false)
  })

  test('getLastConsolidationDate: key = ? 바인드 조회로 날짜 반환', async () => {
    const { calls, db } = recordingDb('2026-10-26')
    expect(await getLastConsolidationDate({ DB: db })).toBe('2026-10-26')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT value FROM ai_settings WHERE key = ?')
    expect(calls[0].params).toEqual(['memory.last_consolidation_date'])
    expect(calls[0].sql).not.toContain('memory.last_consolidation_date')
  })

  test('getLastConsolidationDate: 조회 실패 → null, 행 없음 → null', async () => {
    const throwing = recordingDb('throw')
    expect(await getLastConsolidationDate({ DB: throwing.db })).toBeNull()
    const missing = recordingDb(null)
    expect(await getLastConsolidationDate({ DB: missing.db })).toBeNull()
  })
})
