/// <reference types="jest" />
/**
 * memory-consolidation.ts 커버리지 보강 — LLM 플래그 실패 시 결정적 폴백 (종단)
 * - isLlmConsolidationEnabled 단위 수준의 "조회 실패 → false"는 기존
 *   tests/unit/svc-memory-consolidation-cov.test.ts에서 다루지만,
 *   플래그 조회가 실패했을 때 runSleepConsolidation 전체가 LLM 없이
 *   결정적 요약으로 끝까지 굴러가는 성질은 미검증이었음.
 * - 플래그 OFF + LLM 주입 시에도 LLM이 호출되지 않는 성질도 함께 고정한다.
 *
 * 도달 불가로 기록하는 분기 (테스트 없음):
 * - runSleepConsolidation의 isMemoryV2Enabled try/catch → db_error:
 *   isMemoryV2Enabled가 내부에서 모든 예외를 잡아 false를 반환하므로
 *   이 catch에는 도달할 수 없다 (방어 코드).
 * - runSleepConsolidation의 isLlmConsolidationEnabled try/catch → useLlm=false:
 *   같은 이유로 catch에는 도달할 수 없다. 아래 테스트가 고정하는 것은
 *   플래그 함수가 false를 반환했을 때의 종단 폴백 동작이다.
 *   카나리아: 안쪽·바깥쪽 catch를 둘 다 제거하면 플래그 실패 테스트가
 *   실패한다 (이중 방어 — 한쪽만 제거해서는 테스트가 안 깨진다).
 */
import {
  runSleepConsolidation,
} from '../../src/services/memory-consolidation'
import { extractCoreFact } from '../../src/services/memory-service'

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const oldDate = () => new Date(Date.now() - 100 * 86400000).toISOString()

interface MemRow {
  id: number
  content: string
  summary: string | null
  updated_at: string
  access_count: number
}

function makeEnv(opts: { llmFlag: 'true' | 'false' | 'throw' }) {
  const memory: MemRow = {
    id: 1,
    content: '오래된 기억이다. 두 번째 문장이다.',
    summary: null,
    updated_at: oldDate(),
    access_count: 0,
  }
  const db: any = {
    memory,
    prepare(sql: string) {
      const q = norm(sql)
      return {
        _params: [] as any[],
        bind(...p: any[]) {
          this._params = p
          return this
        },
        async first() {
          // S2-5 수렴: 설정 조회는 바인드 파라미터(getSetting) — 키는 _params[0]에서 읽는다.
          if (q.startsWith('SELECT value FROM ai_settings')) {
            if (this._params[0] === 'memory.v2_enabled') return { value: 'true' }
            if (this._params[0] === 'memory.llm_consolidation_enabled') {
              if (opts.llmFlag === 'throw') throw new Error('flag lookup down')
              return { value: opts.llmFlag }
            }
            return null
          }
          return null
        },
        async all() {
          if (q.includes('FROM ai_memory_v2 WHERE is_active = 1')) {
            return {
              results: [
                {
                  id: memory.id,
                  content: memory.content,
                  summary: memory.summary,
                  entities: null,
                  access_count: memory.access_count,
                  last_accessed_at: null,
                  updated_at: memory.updated_at,
                  contradiction_flag: 0,
                },
              ],
            }
          }
          return { results: [] }
        },
        async run() {
          if (q.includes('UPDATE ai_memory_v2 SET summary')) {
            memory.summary = this._params[0]
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 1 } }
        },
      }
    },
  }
  return { db, env: { DB: db } as any }
}

describe('runSleepConsolidation — LLM 플래그 실패 시 결정적 요약 폴백', () => {
  test('플래그 조회가 DB 오류로 실패해도 통합은 돌고 LLM은 호출되지 않는다', async () => {
    const { db, env } = makeEnv({ llmFlag: 'throw' })
    const llmSummarize = jest.fn(async () => 'LLM이 만든 긴 요약 문장입니다')
    const stats = await runSleepConsolidation(env, { llmSummarize })
    expect(stats.ok).toBe(true)
    expect(stats.ran).toBe(true)
    expect(stats.summarized).toBe(1)
    expect(llmSummarize).not.toHaveBeenCalled()
    expect(db.memory.summary).toBe(extractCoreFact('오래된 기억이다. 두 번째 문장이다.'))
    expect(db.memory.summary).toBe('오래된 기억이다.')
  })

  test('플래그 OFF + LLM 주입 시에도 LLM은 호출되지 않고 결정적 요약을 쓴다', async () => {
    const { db, env } = makeEnv({ llmFlag: 'false' })
    const llmSummarize = jest.fn(async () => 'LLM이 만든 긴 요약 문장입니다')
    const stats = await runSleepConsolidation(env, { llmSummarize })
    expect(stats.ok).toBe(true)
    expect(stats.summarized).toBe(1)
    expect(llmSummarize).not.toHaveBeenCalled()
    expect(db.memory.summary).toBe('오래된 기억이다.')
  })
})
