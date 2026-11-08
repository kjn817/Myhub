/// <reference types="jest" />
/**
 * 그룹 F 커버리지 보강 — src/services/agent-run.ts (현행 표면 기준 재작성, 2026-11-08 배치 3)
 * - createRun validatePlan 분기·db_error
 * - updateRunStatus 경합 가드(changes 0/meta 없음 → run_terminal)·error 절단
 * - saveCheckpoint 검증(순환 참조 직렬화 실패 포함)·db_error
 *
 * [삭제 기록] getRun(5건)·loadLatestCheckpoint(5건)·resumeRun(3건)·driveRun(4건)
 * describe는 해당 읽기/재개/구동 API가 번들·현행 어디에도 없어 삭제한다 —
 * svc5-agent-run.test.ts의 삭제 기록과 동일 사유.
 */
import {
  createRun,
  updateRunStatus,
  saveCheckpoint,
  type RunPlan,
} from '../../src/services/agent-run'

// ---------------- mock D1 ----------------

/** first/all/run 중 지정한 것만 던지는 DB */
function makeThrowDb(throwOn: { first?: boolean; all?: boolean; run?: boolean } = {}) {
  const calls: { sql: string; params: any[] }[] = []
  return {
    calls,
    prepare(sql: string) {
      return {
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          calls.push({ sql, params: this._params })
          if (throwOn.first) throw new Error('db down')
          return null
        },
        async all() {
          calls.push({ sql, params: this._params })
          if (throwOn.all) throw new Error('db down')
          return { results: [] }
        },
        async run() {
          calls.push({ sql, params: this._params })
          if (throwOn.run) throw new Error('db down')
          return { meta: { last_row_id: 1, changes: 1 } }
        },
      }
    },
  }
}

/** first() 결과를 큐에서 꺼내며, Error 항목은 던지는 DB */
function makeQueueDb(firstQueue: any[] = [], runResults: any[] = []) {
  const calls: { sql: string; params: any[] }[] = []
  let runIdx = 0
  return {
    calls,
    prepare(sql: string) {
      return {
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          calls.push({ sql, params: this._params })
          const v = firstQueue.shift()
          if (v instanceof Error) throw v
          return v ?? null
        },
        async all() {
          calls.push({ sql, params: this._params })
          return { results: [] }
        },
        async run() {
          calls.push({ sql, params: this._params })
          return runResults[runIdx++] ?? { meta: { last_row_id: 31, changes: 1 } }
        },
      }
    },
  }
}

const PLAN: RunPlan = {
  steps: [
    { name: 'research', persona: 'echo', objective: '관련 메모를 검색해서 요약한다' },
    { name: 'draft', persona: 'nova', objective: '요약 바탕으로 초안 코드를 작성한다' },
    { name: 'schedule', persona: 'cali', objective: '마감 일정을 등록하고 확인한다' },
  ],
}

// ---------------- db_error catch ----------------

describe('db_error catch', () => {
  test('createRun INSERT 실패 → db_error', async () => {
    const db = makeThrowDb({ run: true })
    const r = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })
  test('updateRunStatus SELECT 실패 → db_error', async () => {
    const db = makeThrowDb({ first: true })
    expect(await updateRunStatus({ DB: db } as any, 'run_abc', 'paused')).toEqual({ ok: false, error: 'db_error' })
  })
  test('saveCheckpoint SELECT 실패 → db_error', async () => {
    const db = makeThrowDb({ first: true })
    const r = await saveCheckpoint({ DB: db } as any, 'run_abc', {
      stepIndex: 0, stepName: 'research', persona: 'echo', state: {},
    })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })
})

// ---------------- validatePlan 분기 ----------------

describe('createRun — validatePlan 분기', () => {
  test('plan이 객체가 아님 / steps가 배열이 아님 → plan.steps 필요', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, { conversationId: 1, plan: null as any })).error).toBe('plan.steps 필요')
    expect((await createRun({ DB: db } as any, { conversationId: 1, plan: { steps: 'x' } as any })).error).toBe('plan.steps 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('단계가 객체가 아님 → 단계 형식 오류', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, {
      conversationId: 1, plan: { steps: ['not-a-record'] as any },
    })).error).toBe('단계 형식 오류')
  })
  test('name/persona/objective가 문자열이 아님 → 빈 값으로 취급돼 검증 실패', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: 123, persona: 'echo', objective: '목표를 충분히 길게 적는다' } as any] },
    })).error).toBe('단계 name/persona/objective 필요')
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: 'x', persona: 456, objective: '목표를 충분히 길게 적는다' } as any] },
    })).error).toBe('단계 name/persona/objective 필요')
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: 'x', persona: 'echo', objective: 123 } as any] },
    })).error).toBe('단계 name/persona/objective 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('공백만 있는 필드는 trim 후 빈 값으로 검증 실패', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: '   ', persona: 'echo', objective: '목표를 충분히 길게 적는다' }] },
    })).error).toBe('단계 name/persona/objective 필요')
  })
})

// ---------------- updateRunStatus 경합 가드 ----------------

describe('updateRunStatus — 경합 가드', () => {
  test('run_id 없음 → run_id 필요', async () => {
    const db = makeQueueDb()
    expect((await updateRunStatus({ DB: db } as any, '', 'paused')).error).toBe('run_id 필요')
    expect((await updateRunStatus({ DB: db } as any, undefined as any, 'paused')).error).toBe('run_id 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('없는 실행 → run_not_found', async () => {
    const db = makeQueueDb([null])
    expect(await updateRunStatus({ DB: db } as any, 'run_nope', 'paused')).toEqual({ ok: false, error: 'run_not_found' })
  })
  test('UPDATE changes 0 (SELECT와 UPDATE 사이 종단 전이) → run_terminal', async () => {
    const db = makeQueueDb([{ status: 'running' }], [{ meta: { last_row_id: 0, changes: 0 } }])
    const r = await updateRunStatus({ DB: db } as any, 'run_abc', 'paused')
    expect(r).toEqual({ ok: false, error: 'run_terminal' })
  })
  test('UPDATE meta 없음 → run_terminal', async () => {
    const db = makeQueueDb([{ status: 'running' }], [{}])
    const r = await updateRunStatus({ DB: db } as any, 'run_abc', 'paused')
    expect(r).toEqual({ ok: false, error: 'run_terminal' })
  })
  test('error 메시지 1000자 절단 후 저장', async () => {
    const db = makeQueueDb([{ status: 'running' }])
    const r = await updateRunStatus({ DB: db } as any, 'run_abc', 'failed', 'e'.repeat(1500))
    expect(r.ok).toBe(true)
    expect((db.calls[1].params[1] as string).length).toBe(1000)
  })
})

// ---------------- saveCheckpoint 검증 ----------------

describe('saveCheckpoint — 검증·직렬화', () => {
  test('run_id 없음 → run_id 필요', async () => {
    const db = makeQueueDb()
    expect((await saveCheckpoint({ DB: db } as any, '', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('run_id 필요')
    expect((await saveCheckpoint({ DB: db } as any, null as any, {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('run_id 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('stepName/persona 없음 → step_name/persona 필요', async () => {
    const db = makeQueueDb()
    expect((await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: '  ', persona: 'echo', state: {},
    })).error).toBe('step_name/persona 필요')
    expect((await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: '', state: {},
    })).error).toBe('step_name/persona 필요')
    expect((await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: null as any, persona: 'echo', state: {},
    })).error).toBe('step_name/persona 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('state가 배열이면 객체 아님 → state는 객체 필요', async () => {
    const db = makeQueueDb()
    expect((await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: [] as any,
    })).error).toBe('state는 객체 필요')
  })
  test('순환 참조 state → state 직렬화 실패, DB 미호출', async () => {
    const db = makeQueueDb()
    const circular: any = { results: [] }
    circular.self = circular
    const r = await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: circular,
    })
    expect(r).toEqual({ ok: false, error: 'state 직렬화 실패' })
    expect(db.calls).toHaveLength(0)
  })
})
