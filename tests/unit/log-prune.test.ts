/// <reference types="jest" />
/**
 * src/services/log-prune.ts — 로그 보존 삭제 성질 테스트.
 *
 * 핵심 성질: ① 테이블 하나의 실패가 나머지를 막지 않는다(격리) ② 삭제
 * 상한에 닿으면 capped로 표시된다 ③ 총합은 성공한 삭제만 센다 ④ cutoff는
 * 보존 기간만큼 정확히 과거, DB 저장 형식(공백 구분·초 단위)이다.
 * 카나리아: capped 판정(>=)을 (>)로 바꾸거나 테이블별 try/catch를 없애면 실패한다.
 */
import {
  LOG_PRUNE_MARKER_KEY,
  LOG_PRUNE_POLICIES,
  PRUNE_BATCH_LIMIT,
  getLastPruneDate,
  markPruneRun,
  pruneCutoffIso,
  runLogPrune,
} from '../../src/services/log-prune'

interface DbBehavior {
  changes?: Record<string, number>
  throwFor?: Record<string, unknown>
  noMeta?: boolean
  rateLimitChanges?: number
  rateLimitThrow?: unknown
}

function makeDb(behavior: DbBehavior = {}) {
  const settings = new Map<string, string>()
  const binds: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          binds.push({ sql, args })
          return {
            async run() {
              const del = /DELETE FROM (\w+)/.exec(sql)
              if (del) {
                const table = del[1]
                if (table === 'rate_limits') {
                  if (behavior.rateLimitThrow !== undefined) throw behavior.rateLimitThrow
                  return { meta: { changes: behavior.rateLimitChanges ?? 0 } }
                }
                if (behavior.throwFor && table in behavior.throwFor) throw behavior.throwFor[table]
                if (behavior.noMeta) return {}
                return { meta: { changes: behavior.changes?.[table] ?? 0 } }
              }
              if (sql.startsWith('INSERT OR REPLACE INTO ai_settings')) {
                settings.set(String(args[0]), String(args[1]))
                return { meta: { changes: 1 } }
              }
              throw new Error(`unexpected sql: ${sql}`)
            },
            async first() {
              if (sql.startsWith('SELECT value FROM ai_settings')) {
                const v = settings.get(String(args[0]))
                return v === undefined ? null : { value: v }
              }
              return null
            },
          }
        },
      }
    },
  }
  return { db: { DB: db } as unknown as { DB: D1Database }, settings, binds }
}

const NOW = new Date('2026-11-08T04:00:00.000Z')

describe('pruneCutoffIso', () => {
  test('보존 기간만큼 과거를 DB 형식(공백·19자)으로 반환한다', () => {
    expect(pruneCutoffIso(NOW, 90)).toBe('2026-08-10 04:00:00')
    expect(pruneCutoffIso(NOW, 0)).toBe('2026-11-08 04:00:00')
    expect(pruneCutoffIso(NOW, 180)).toBe('2026-05-12 04:00:00')
  })
})

describe('LOG_PRUNE_POLICIES 계약', () => {
  test('테이블은 중복이 없고 ai_usage만 180일, 나머지는 90일이다', () => {
    const tables = LOG_PRUNE_POLICIES.map((p) => p.table)
    expect(new Set(tables).size).toBe(tables.length)
    for (const p of LOG_PRUNE_POLICIES) {
      expect(p.retentionDays).toBe(p.table === 'ai_usage' ? 180 : 90)
      expect(p.column).toBe('created_at')
    }
  })
})

describe('runLogPrune', () => {
  test('정책 테이블 전체를 돌고 삭제 수·총합이 일치한다', async () => {
    const { db, binds } = makeDb({ changes: { google_sync_log: 10, ai_usage: 3 }, rateLimitChanges: 7 })
    const out = await runLogPrune(db, NOW)
    expect(out.tables).toHaveLength(LOG_PRUNE_POLICIES.length)
    expect(out.tables.map((t) => t.table)).toEqual(LOG_PRUNE_POLICIES.map((p) => p.table))
    expect(out.rateLimitsDeleted).toBe(7)
    expect(out.totalDeleted).toBe(20)
    expect(out.rateLimitsError).toBeUndefined()
    // 각 테이블 bind는 해당 보존 기간의 cutoff + 배치 상한이다
    const aiUsageBind = binds.find((b) => b.sql.includes('ai_usage'))
    expect(aiUsageBind?.args).toEqual(['2026-05-12 04:00:00', PRUNE_BATCH_LIMIT])
    const syncBind = binds.find((b) => b.sql.includes('google_sync_log'))
    expect(syncBind?.args).toEqual(['2026-08-10 04:00:00', PRUNE_BATCH_LIMIT])
  })

  test('배치 상한만큼 지워지면 capped=true', async () => {
    const { db } = makeDb({ changes: { clef_decision_log: PRUNE_BATCH_LIMIT } })
    const out = await runLogPrune(db, NOW)
    expect(out.tables.find((t) => t.table === 'clef_decision_log')?.capped).toBe(true)
    expect(out.tables.find((t) => t.table === 'google_sync_log')?.capped).toBe(false)
  })

  test('한 테이블이 실패해도 나머지는 계속되고 오류는 그 테이블에만 기록된다', async () => {
    const { db } = makeDb({
      changes: { google_sync_log: 5 },
      throwFor: { ai_error_log: new Error('no such table: ai_error_log') },
    })
    const out = await runLogPrune(db, NOW)
    const failed = out.tables.find((t) => t.table === 'ai_error_log')
    expect(failed).toMatchObject({ deleted: 0, capped: false, error: 'no such table: ai_error_log' })
    expect(out.tables.find((t) => t.table === 'google_sync_log')?.deleted).toBe(5)
    expect(out.totalDeleted).toBe(5)
  })

  test('오류 메시지는 200자로 절단되고, Error가 아닌 throw도 문자열화된다', async () => {
    const { db } = makeDb({
      throwFor: { ai_usage: new Error('x'.repeat(300)), google_sync_log: 'plain failure' },
    })
    const out = await runLogPrune(db, NOW)
    expect(out.tables.find((t) => t.table === 'ai_usage')?.error).toHaveLength(200)
    expect(out.tables.find((t) => t.table === 'google_sync_log')?.error).toBe('plain failure')
  })

  test('meta가 없으면 삭제 0으로 취급한다', async () => {
    const { db } = makeDb({ noMeta: true })
    const out = await runLogPrune(db, NOW)
    expect(out.tables.every((t) => t.deleted === 0 && !t.capped)).toBe(true)
  })

  test('rate_limits 삭제 실패는 rateLimitsError에만 남고 테이블 결과는 유지된다', async () => {
    const { db } = makeDb({ changes: { google_sync_log: 2 }, rateLimitThrow: new Error('rl down') })
    const out = await runLogPrune(db, NOW)
    expect(out.rateLimitsDeleted).toBe(0)
    expect(out.rateLimitsError).toBe('rl down')
    expect(out.totalDeleted).toBe(2)
  })
})

describe('마커 기록/조회', () => {
  test('markPruneRun → getLastPruneDate 왕복', async () => {
    const { db, settings } = makeDb()
    await markPruneRun(db, '2026-11-08')
    expect(settings.get(LOG_PRUNE_MARKER_KEY)).toBe('2026-11-08')
    await expect(getLastPruneDate(db)).resolves.toBe('2026-11-08')
  })

  test('마커가 없으면 null, DB 장애 시에도 null (fail-soft)', async () => {
    const { db } = makeDb()
    await expect(getLastPruneDate(db)).resolves.toBeNull()
    const broken = {
      DB: {
        prepare() {
          throw new Error('db gone')
        },
      } as unknown as D1Database,
    }
    await expect(getLastPruneDate(broken)).resolves.toBeNull()
  })
})
