/// <reference types="jest" />
/**
 * src/services/workflow.ts 단위 테스트 — n8n 패턴 엔진
 * - 실제 SQLite(better-sqlite3 기반 local-d1)에 마이그레이션 0050 SQL을 적용해
 *   멱등성·실행 기록을 실측한다. D1 고유 동작이 아닌 표준 SQL만 검증한다.
 * - 재시도는 sleep을 주입해 실제 대기 없이 지연 값을 기록한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  runWorkflow,
  computeBackoffMs,
  STALE_RUNNING_MS,
  TRUNCATED_JSON_MARKER,
  type WorkflowDefinition,
  type WorkflowState,
} from '../../src/services/workflow'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const MIGRATION_0050 = fs.readFileSync(
  path.join(__dirname, '../../migrations/0050_workflow_runs.sql'),
  'utf8'
)

function makeDb(withTables = true): any {
  const d1 = createLocalD1()
  if (withTables) d1.exec(MIGRATION_0050)
  return d1
}

function envWith(db: any): any {
  return { DB: db }
}

function def(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'test-wf',
    name: '테스트 워크플로',
    version: 1,
    trigger: { type: 'manual' },
    nodes: [
      { id: 'a', name: 'A', run: async () => ({ a: 1 }) },
      { id: 'b', name: 'B', run: async ({ state }) => ({ b: (state.a as number) + 1 }) },
    ],
    ...over,
  }
}

function countRows(db: any, sql: string): number {
  return (db._db.prepare(sql).get() as any)?.n ?? 0
}

function queryAll(db: any, sql: string): any[] {
  return db._db.prepare(sql).all()
}

describe('computeBackoffMs', () => {
  test('지수 증가 + 상한', () => {
    const p = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250, multiplier: 2 }
    expect(computeBackoffMs(p, 1)).toBe(100)
    expect(computeBackoffMs(p, 2)).toBe(200)
    expect(computeBackoffMs(p, 3)).toBe(250) // 400 → 상한 250
    expect(computeBackoffMs(p, 4)).toBe(250)
  })
  test('multiplier 기본값 2', () => {
    const p = { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 10000 }
    expect(computeBackoffMs(p, 2)).toBe(100)
  })
  test('STALE_RUNNING_MS는 15분', () => {
    expect(STALE_RUNNING_MS).toBe(15 * 60 * 1000)
  })
})

describe('기본 실행', () => {
  test('노드 순차 실행 + 상태 병합', async () => {
    const db = makeDb()
    const r = await runWorkflow(def(), { env: envWith(db), input: { x: 9 }, idempotencyKey: 'k1' })
    expect(r.status).toBe('completed')
    expect(r.output).toEqual({ x: 9, a: 1, b: 2 })
    expect(r.attempts).toBe(2)
    expect(r.runId).not.toBeNull()
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_runs')).toBe(1)
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_run_steps')).toBe(2)
    const run = queryAll(db, 'SELECT * FROM workflow_runs')[0]
    expect(run.status).toBe('completed')
    expect(run.workflow_id).toBe('test-wf')
    expect(run.idempotency_key).toBe('k1')
  })

  test('void 반환 노드는 상태를 바꾸지 않는다', async () => {
    const db = makeDb()
    const d = def({
      nodes: [{ id: 'v', name: 'V', run: async () => {} }],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: { x: 1 } })
    expect(r.status).toBe('completed')
    expect(r.output).toEqual({ x: 1 })
  })

  test('db:null이면 기록 없이 실행만 한다', async () => {
    const r = await runWorkflow(def(), { env: envWith(makeDb()), db: null, input: {} })
    expect(r.status).toBe('completed')
    expect(r.runId).toBeNull()
    expect(r.output).toEqual({ a: 1, b: 2 })
  })
})

describe('정의 검증', () => {
  test('nodes 비어 있음 → throw', async () => {
    await expect(
      runWorkflow(def({ nodes: [] }), { env: envWith(makeDb()) })
    ).rejects.toThrow('nodes 비어 있음')
  })
  test('node id 중복 → throw', async () => {
    const d = def({
      nodes: [
        { id: 'x', name: 'X', run: async () => ({}) },
        { id: 'x', name: 'X2', run: async () => ({}) },
      ],
    })
    await expect(runWorkflow(d, { env: envWith(makeDb()) })).rejects.toThrow('id 중복')
  })
  test('cron 트리거에 cron식 없음 → throw', async () => {
    const d = def({ trigger: { type: 'cron', cron: '' } })
    await expect(runWorkflow(d, { env: envWith(makeDb()) })).rejects.toThrow('cron식 없음')
  })
})

describe('입력·출력 스키마', () => {
  test('requires 누락 → 실패, 이후 노드 미실행', async () => {
    const db = makeDb()
    const bRun = jest.fn(async () => ({ b: 1 }))
    const d = def({
      nodes: [
        { id: 'a', name: 'A', run: async () => ({}) },
        { id: 'b', name: 'B', requires: ['nope'], run: bRun },
      ],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {} })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/입력 누락: nope/)
    expect(bRun).not.toHaveBeenCalled()
    const steps = queryAll(db, 'SELECT node_id, status FROM workflow_run_steps ORDER BY id')
    expect(steps).toEqual([
      { node_id: 'a', status: 'completed' },
      { node_id: 'b', status: 'failed' },
    ])
  })

  test('produces 누락 → 실패', async () => {
    const db = makeDb()
    const d = def({
      nodes: [{ id: 'a', name: 'A', produces: ['must'], run: async () => ({ other: 1 }) }],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {} })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/출력 누락: must/)
  })

  test('비객체 출력 → 실패', async () => {
    const db = makeDb()
    const d = def({
      nodes: [{ id: 'a', name: 'A', run: async () => 42 as unknown as WorkflowState }],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {} })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/출력이 객체가 아님/)
  })
})

describe('when (조건부 스킵)', () => {
  test('when=false 노드는 건너뛰고 스킵 기록을 남긴다', async () => {
    const db = makeDb()
    const bRun = jest.fn(async () => ({ b: 1 }))
    const d = def({
      nodes: [
        { id: 'a', name: 'A', run: async () => ({ flag: false }) },
        { id: 'b', name: 'B', when: (s) => s.flag === true, run: bRun },
      ],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {} })
    expect(r.status).toBe('completed')
    expect(r.output).toEqual({ flag: false })
    expect(bRun).not.toHaveBeenCalled()
    const steps = queryAll(db, 'SELECT node_id, status, attempt FROM workflow_run_steps ORDER BY id')
    expect(steps).toEqual([
      { node_id: 'a', status: 'completed', attempt: 1 },
      { node_id: 'b', status: 'skipped', attempt: 0 },
    ])
  })

  test('when 조건이 던지면 노드 실패로 처리하고 실행을 중단한다', async () => {
    const db = makeDb()
    const d = def({
      nodes: [
        { id: 'a', name: 'A', run: async () => ({}) },
        {
          id: 'b',
          name: 'B',
          when: () => {
            throw new Error('when boom')
          },
          run: async () => ({}),
        },
      ],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {} })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/when 조건 오류: when boom/)
  })
})

describe('재시도 (지수 백오프)', () => {
  test('2회 실패 후 성공 — 지연 [100, 200], attempts=3', async () => {
    const db = makeDb()
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }
    let calls = 0
    const d = def({
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10000, multiplier: 2 },
      nodes: [
        {
          id: 'flaky',
          name: 'Flaky',
          run: async () => {
            calls++
            if (calls < 3) throw new Error('일시 오류')
            return { ok: true }
          },
        },
      ],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {}, sleep })
    expect(r.status).toBe('completed')
    expect(r.output.ok).toBe(true)
    expect(r.attempts).toBe(3)
    expect(calls).toBe(3)
    expect(delays).toEqual([100, 200])
  })

  test('재시도 소진 → failed, 에러 기록', async () => {
    const db = makeDb()
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }
    const d = def({
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10000, multiplier: 2 },
      nodes: [{ id: 'bad', name: 'Bad', run: async () => {
        throw new Error('계속 실패')
      } }],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {}, idempotencyKey: 'fail1', sleep })
    expect(r.status).toBe('failed')
    expect(r.error).toBe('계속 실패')
    expect(r.attempts).toBe(3)
    expect(delays).toEqual([100, 200])
    const run = queryAll(db, 'SELECT status, error, attempts FROM workflow_runs')[0]
    expect(run).toEqual({ status: 'failed', error: '계속 실패', attempts: 3 })
    const step = queryAll(db, 'SELECT status, attempt, error FROM workflow_run_steps')[0]
    expect(step).toEqual({ status: 'failed', attempt: 3, error: '계속 실패' })
  })

  test('백오프 상한 적용', async () => {
    const db = makeDb()
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }
    const d = def({
      retry: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 1500, multiplier: 10 },
      nodes: [{ id: 'bad', name: 'Bad', run: async () => {
        throw new Error('x')
      } }],
    })
    await runWorkflow(d, { env: envWith(db), input: {}, sleep })
    expect(delays).toEqual([1000, 1500, 1500])
  })

  test('노드별 retry가 워크플로 기본값을 덮어쓴다', async () => {
    const db = makeDb()
    let calls = 0
    const d = def({
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      nodes: [
        {
          id: 'n',
          name: 'N',
          retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 5 },
          run: async () => {
            calls++
            if (calls < 3) throw new Error('flaky')
            return { ok: true }
          },
        },
      ],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {}, sleep: async () => {} })
    expect(r.status).toBe('completed')
    expect(calls).toBe(3)
  })

  test('정책 생략 시 재시도 없음 (1회 시도)', async () => {
    const db = makeDb()
    let calls = 0
    const d = def({
      nodes: [{ id: 'n', name: 'N', run: async () => {
        calls++
        throw new Error('once')
      } }],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {} })
    expect(r.status).toBe('failed')
    expect(calls).toBe(1)
    expect(r.attempts).toBe(1)
  })
})

describe('continueOnError', () => {
  test('실패 노드를 넘기고 계속 진행, 에러를 상태에 남긴다', async () => {
    const db = makeDb()
    const d = def({
      nodes: [
        {
          id: 'flaky',
          name: 'Flaky',
          continueOnError: true,
          run: async () => {
            throw new Error('boom')
          },
        },
        { id: 'next', name: 'Next', run: async ({ state }) => ({ after: state['flakyError'] }) },
      ],
    })
    const r = await runWorkflow(d, { env: envWith(db), input: {} })
    expect(r.status).toBe('completed')
    expect(r.output['flakyError']).toBe('boom')
    expect(r.output.after).toBe('boom')
    const steps = queryAll(db, 'SELECT node_id, status FROM workflow_run_steps ORDER BY id')
    expect(steps).toEqual([
      { node_id: 'flaky', status: 'failed' },
      { node_id: 'next', status: 'completed' },
    ])
  })
})

describe('멱등성', () => {
  test('같은 키 재실행 → duplicate, 노드 미실행, 저장된 출력 반환', async () => {
    const db = makeDb()
    const nodeFn = jest.fn(async () => ({ v: 42 }))
    const d = def({ nodes: [{ id: 'only', name: 'Only', run: nodeFn }] })
    const env = envWith(db)
    const r1 = await runWorkflow(d, { env, input: { in: 1 }, idempotencyKey: 'dup1' })
    expect(r1.status).toBe('completed')
    const r2 = await runWorkflow(d, { env, input: { in: 999 }, idempotencyKey: 'dup1' })
    expect(r2.status).toBe('duplicate')
    expect(r2.output).toEqual({ in: 1, v: 42 })
    expect(r2.runId).toBe(r1.runId)
    expect(nodeFn).toHaveBeenCalledTimes(1)
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_runs')).toBe(1)
  })

  test('4000자 초과 출력 → 절단 마킹된 유효 JSON 저장, duplicate 조회 시 {}가 아닌 마커 반환', async () => {
    // 결함 2 수정: 구 truncateJson은 JSON을 중간에서 잘라 저장했고,
    // duplicate 조회 시 JSON.parse 실패로 원래 출력 대신 {}가 반환됐다.
    // 이제는 절단 사실을 명시한 유효 JSON을 저장한다.
    const db = makeDb()
    const nodeFn = jest.fn(async () => ({ big: 'x'.repeat(5000) }))
    const d = def({ nodes: [{ id: 'big', name: 'Big', run: nodeFn }] })
    const env = envWith(db)
    const r1 = await runWorkflow(d, { env, input: {}, idempotencyKey: 'big1' })
    expect(r1.status).toBe('completed')
    const stored = queryAll(db, 'SELECT output_json FROM workflow_runs')[0].output_json as string
    expect(stored.length).toBeLessThanOrEqual(4000)
    const parsed = JSON.parse(stored)
    expect(parsed[TRUNCATED_JSON_MARKER]).toBe(true)
    expect(typeof parsed.preview).toBe('string')
    expect(parsed.preview.length).toBeGreaterThan(0)
    const r2 = await runWorkflow(d, { env, input: {}, idempotencyKey: 'big1' })
    expect(r2.status).toBe('duplicate')
    expect(r2.output).toEqual(parsed)
    expect(r2.output).not.toEqual({})
    expect(nodeFn).toHaveBeenCalledTimes(1)
  })

  test('4000자 이하 출력은 그대로 저장 (절단 마커 없음)', async () => {
    const db = makeDb()
    const d = def({ nodes: [{ id: 'only', name: 'Only', run: async () => ({ v: 42 }) }] })
    const r1 = await runWorkflow(d, { env: envWith(db), input: { in: 1 }, idempotencyKey: 'small1' })
    expect(r1.status).toBe('completed')
    const stored = queryAll(db, 'SELECT output_json FROM workflow_runs')[0].output_json as string
    expect(JSON.parse(stored)).toEqual({ in: 1, v: 42 })
    expect(JSON.parse(stored)[TRUNCATED_JSON_MARKER]).toBeUndefined()
  })

  test('다른 키는 재실행한다', async () => {
    const db = makeDb()
    const nodeFn = jest.fn(async () => ({}))
    const d = def({ nodes: [{ id: 'only', name: 'Only', run: nodeFn }] })
    const env = envWith(db)
    await runWorkflow(d, { env, input: {}, idempotencyKey: 'k-a' })
    const r2 = await runWorkflow(d, { env, input: {}, idempotencyKey: 'k-b' })
    expect(r2.status).toBe('completed')
    expect(nodeFn).toHaveBeenCalledTimes(2)
  })

  test('실패한 실행도 같은 키로 재실행하지 않는다', async () => {
    const db = makeDb()
    const nodeFn = jest.fn(async () => {
      throw new Error('fail once')
    })
    const d = def({ nodes: [{ id: 'only', name: 'Only', run: nodeFn }] })
    const env = envWith(db)
    const r1 = await runWorkflow(d, { env, input: {}, idempotencyKey: 'k-fail' })
    expect(r1.status).toBe('failed')
    const r2 = await runWorkflow(d, { env, input: {}, idempotencyKey: 'k-fail' })
    expect(r2.status).toBe('duplicate')
    expect(nodeFn).toHaveBeenCalledTimes(1)
  })

  test('fresh running 행 → duplicate (동시 실행 방지)', async () => {
    const db = makeDb()
    db._db.prepare(
      `INSERT INTO workflow_runs (workflow_id, idempotency_key, trigger_type, status)
       VALUES ('test-wf', 'k-run', 'manual', 'running')`
    ).run()
    const nodeFn = jest.fn(async () => ({}))
    const d = def({ nodes: [{ id: 'only', name: 'Only', run: nodeFn }] })
    const r = await runWorkflow(d, { env: envWith(db), input: {}, idempotencyKey: 'k-run' })
    expect(r.status).toBe('duplicate')
    expect(nodeFn).not.toHaveBeenCalled()
  })

  test('stale running 행(15분 경과) → 재실행 허용', async () => {
    const db = makeDb()
    db._db.prepare(
      `INSERT INTO workflow_runs (workflow_id, idempotency_key, trigger_type, status, started_at)
       VALUES ('test-wf', 'k-stale', 'manual', 'running', datetime('now', '-20 minutes'))`
    ).run()
    const nodeFn = jest.fn(async () => ({ done: true }))
    const d = def({ nodes: [{ id: 'only', name: 'Only', run: nodeFn }] })
    const r = await runWorkflow(d, { env: envWith(db), input: {}, idempotencyKey: 'k-stale' })
    expect(r.status).toBe('completed')
    expect(r.output.done).toBe(true)
    expect(nodeFn).toHaveBeenCalledTimes(1)
    const row = queryAll(db, "SELECT status FROM workflow_runs WHERE idempotency_key='k-stale'")[0]
    expect(row.status).toBe('completed')
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_runs')).toBe(1)
  })
})

describe('기록 테이블 없음 (best-effort)', () => {
  test('0050 미적용 DB에서도 실행은 완료된다', async () => {
    const db = makeDb(false)
    const r = await runWorkflow(def(), { env: envWith(db), input: {}, idempotencyKey: 'k-no-table' })
    expect(r.status).toBe('completed')
    expect(r.output).toEqual({ a: 1, b: 2 })
    expect(r.runId).toBeNull()
  })
})
