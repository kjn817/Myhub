/// <reference types="jest" />
/**
 * fact-graph.ts 커버리지 보강 — linkFactGraph의 0056 미적용 DB 재시도 INSERT
 * (기존 tests/unit/svc-fact-graph-cov.test.ts는 upsert 실패·사실 INSERT 실패
 * 등을 다루지만, valid_from 컬럼이 없는 DB에서 재시도 INSERT로 연결을
 * 유지하는 성질은 미검증)
 *
 * 도달 불가로 기록하는 분기 (테스트 없음):
 * - getRelatedFacts의 fetchSupersededMatches catch (412행):
 *   fetchSupersededMatches가 내부에서 모든 예외를 잡아 []를 반환하므로
 *   이 catch는 실행될 수 없다 (svc-fact-graph-cov.test.ts 헤더에 동일 판정 기록됨).
 */
import { captureFacts } from '../../src/services/fact-graph'

interface FactDbOpts {
  /** valid_from 포함 INSERT를 실패시킨다 (0056 미적용 DB 흉내) */
  failValidFromInsert?: boolean
}

function makeFactDb(opts: FactDbOpts = {}) {
  const calls: string[] = []
  const entityIds = new Map<string, number>()
  let entitySeq = 100
  const db: any = {
    calls,
    prepare(sql: string) {
      return {
        _params: [] as any[],
        bind(...p: any[]) {
          this._params = p
          return this
        },
        async first() {
          if (sql.includes('SELECT id FROM memory_entities WHERE normalized = ?')) {
            const id = entityIds.get(this._params[0])
            return id === undefined ? null : { id }
          }
          return null
        },
        async all() {
          if (sql.includes('SELECT content FROM ai_memory_v2')) return { results: [] }
          return { results: [] }
        },
        async run() {
          calls.push(sql)
          if (sql.includes('INSERT OR IGNORE INTO memory_entities')) {
            const norm = this._params[1]
            if (!entityIds.has(norm)) entityIds.set(norm, entitySeq++)
            return { meta: { last_row_id: entityIds.get(norm), changes: 1 } }
          }
          if (sql.includes('INSERT INTO ai_memory_v2')) {
            return { meta: { last_row_id: 1, changes: 1 } }
          }
          if (sql.includes('INTO memory_fact_entities')) {
            if (opts.failValidFromInsert && sql.includes('valid_from')) {
              throw new Error('no such column: valid_from')
            }
            return { meta: { changes: 1 } }
          }
          return { meta: { last_row_id: 1, changes: 1 } }
        },
      }
    },
  }
  return db
}

describe('captureFacts — 0056 미적용 DB에서 valid_from 없이 재시도', () => {
  test('valid_from INSERT가 실패해도 재시도 INSERT로 엔티티 연결을 유지한다', async () => {
    const db = makeFactDb({ failValidFromInsert: true })
    // 따옴표 엔티티: extractEntities가 "서울시청"을 엔티티로 뽑는다
    const r = await captureFacts({ DB: db } as any, {
      text: 'x',
      facts: ['"서울시청"에서 일한다'],
    } as any)
    expect(r.ok).toBe(true)
    expect(r.created).toHaveLength(1)
    expect(r.entities).toEqual(['서울시청'])
    // valid_from 포함 시도 + valid_from 없는 재시도 둘 다 발행됐다
    expect(db.calls.some((s: string) => s.includes('memory_fact_entities') && s.includes('valid_from'))).toBe(true)
    expect(db.calls.some((s: string) => s.includes('memory_fact_entities') && !s.includes('valid_from'))).toBe(true)
  })

  test('0056 적용 DB에서는 재시도 없이 한 번만 INSERT한다 (대조군)', async () => {
    const db = makeFactDb({ failValidFromInsert: false })
    const r = await captureFacts({ DB: db } as any, {
      text: 'x',
      facts: ['"서울시청"에서 일한다'],
    } as any)
    expect(r.ok).toBe(true)
    expect(r.entities).toEqual(['서울시청'])
    const feCalls = db.calls.filter((s: string) => s.includes('memory_fact_entities'))
    expect(feCalls).toHaveLength(1)
    expect(feCalls[0]).toContain('valid_from')
  })
})
