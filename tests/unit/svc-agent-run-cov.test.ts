/// <reference types="jest" />
/**
 * 그룹 F 커버리지 보강 — src/services/agent-run.ts
 * - 기존 tests/unit/svc5-agent-run.test.ts에서 다루지 않은 미커버 라인:
 *   parsePlan 파싱 실패(107), 각 함수의 db_error catch(147/159/191/234/269),
 *   state 직렬화 실패(215), driveRun 체크포인트 저장 실패(370-371)
 * - 보강: validatePlan 분기(76/82/83-85), run_id 가드(153/174/205/244),
 *   updateRunStatus 경합 가드(178/188), saveCheckpoint 검증(209/210),
 *   resumeRun 실패 분기(295/298), driveRun 상태 전이 실패(344/376)
 */
import {
  createRun,
  getRun,
  updateRunStatus,
  saveCheckpoint,
  loadLatestCheckpoint,
  resumeRun,
  driveRun,
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

/** driveRun용 상태 저장 가짜 D1 (체크포인트 INSERT 실패 주입 가능) */
function makeStatefulDb(opts: { failCheckpointInsert?: boolean } = {}) {
  const runs = new Map<string, any>()
  const checkpoints = new Map<string, any>()
  const db = {
    runs,
    checkpoints,
    prepare(sql: string) {
      const stmt: any = {
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          const p = this._params
          if (sql.includes('SELECT * FROM agent_runs WHERE id')) {
            return runs.get(p[0]) ?? null
          }
          if (sql.includes('SELECT status FROM agent_runs')) {
            const r = runs.get(p[0])
            return r ? { status: r.status } : null
          }
          if (sql.includes('SELECT total_steps, status FROM agent_runs')) {
            const r = runs.get(p[0])
            return r ? { total_steps: r.total_steps, status: r.status } : null
          }
          if (sql.includes('SELECT * FROM agent_run_checkpoints')) {
            const rows = [...checkpoints.values()]
              .filter((c) => c.run_id === p[0])
              .sort((a, b) => b.step_index - a.step_index)
            return rows[0] ?? null
          }
          return null
        },
        async all() {
          return { results: [] }
        },
        async run() {
          const p = this._params
          if (sql.includes('INSERT INTO agent_runs')) {
            runs.set(p[0], {
              id: p[0], conversation_id: p[1], user_text: p[2], status: 'running',
              current_step: 0, total_steps: p[3], plan_json: p[4],
              error: null, created_at: p[5], updated_at: p[6],
            })
            return { meta: { last_row_id: 1, changes: 1 } }
          }
          if (sql.includes('INSERT OR REPLACE INTO agent_run_checkpoints')) {
            if (opts.failCheckpointInsert) throw new Error('checkpoint insert boom')
            checkpoints.set(`${p[0]}:${p[1]}`, {
              run_id: p[0], step_index: p[1], step_name: p[2],
              persona: p[3], state_json: p[4], created_at: p[5],
            })
            return { meta: { last_row_id: 1, changes: 1 } }
          }
          if (sql.includes('UPDATE agent_runs SET current_step')) {
            const r = runs.get(p[2])
            if (r) { r.current_step = p[0]; r.updated_at = p[1] }
            return { meta: { last_row_id: 0, changes: r ? 1 : 0 } }
          }
          if (sql.includes('UPDATE agent_runs SET status')) {
            const r = runs.get(p[3])
            if (r) { r.status = p[0]; r.error = p[1]; r.updated_at = p[2] }
            return { meta: { last_row_id: 0, changes: r ? 1 : 0 } }
          }
          return { meta: { last_row_id: 0, changes: 1 } }
        },
      }
      return stmt
    },
  }
  return db
}

const PLAN: RunPlan = {
  steps: [
    { name: 'research', persona: 'echo', objective: '관련 메모를 검색해서 요약한다' },
    { name: 'draft', persona: 'nova', objective: '요약 바탕으로 초안 코드를 작성한다' },
    { name: 'schedule', persona: 'cali', objective: '마감 일정을 등록하고 확인한다' },
  ],
}

function runRow(over: Record<string, any> = {}) {
  return {
    id: 'run_abc', conversation_id: 1, user_text: '요청', status: 'paused',
    current_step: 1, total_steps: 3, plan_json: JSON.stringify(PLAN),
    error: null, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z',
    ...over,
  }
}

// ---------------- parsePlan / rowToRun (107) ----------------

describe('getRun — plan_json 파싱 실패 시 빈 계획으로 복원 (107)', () => {
  test('손상된 plan_json → plan.steps []', async () => {
    const db = makeQueueDb([runRow({ plan_json: '{broken' })])
    const r = await getRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.run?.plan).toEqual({ steps: [] })
  })
  test('steps 없는 JSON → 빈 계획', async () => {
    const db = makeQueueDb([runRow({ plan_json: '{}' })])
    const r = await getRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.run?.plan).toEqual({ steps: [] })
  })
  test('user_text 없음 → 빈 문자열', async () => {
    const db = makeQueueDb([runRow({ user_text: null })])
    const r = await getRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.run?.userText).toBe('')
  })
  test('run_id 없음 → run_id 필요 (153)', async () => {
    const db = makeQueueDb()
    expect((await getRun({ DB: db } as any, '   ')).error).toBe('run_id 필요')
    expect(db.calls).toHaveLength(0)
  })
})

// ---------------- db_error catch (147/159/191/234/269) ----------------

describe('db_error catch', () => {
  test('createRun INSERT 실패 → db_error (147)', async () => {
    const db = makeThrowDb({ run: true })
    const r = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })
  test('getRun SELECT 실패 → db_error (159)', async () => {
    const db = makeThrowDb({ first: true })
    expect(await getRun({ DB: db } as any, 'run_abc')).toEqual({ ok: false, error: 'db_error' })
  })
  test('updateRunStatus SELECT 실패 → db_error (191)', async () => {
    const db = makeThrowDb({ first: true })
    expect(await updateRunStatus({ DB: db } as any, 'run_abc', 'paused')).toEqual({ ok: false, error: 'db_error' })
  })
  test('saveCheckpoint SELECT 실패 → db_error (234)', async () => {
    const db = makeThrowDb({ first: true })
    const r = await saveCheckpoint({ DB: db } as any, 'run_abc', {
      stepIndex: 0, stepName: 'research', persona: 'echo', state: {},
    })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })
  test('loadLatestCheckpoint SELECT 실패 → db_error (269)', async () => {
    const db = makeThrowDb({ first: true })
    expect(await loadLatestCheckpoint({ DB: db } as any, 'run_abc')).toEqual({ ok: false, error: 'db_error' })
  })
})

// ---------------- validatePlan 분기 (76/82/83-85) ----------------

describe('createRun — validatePlan 분기', () => {
  test('plan이 객체가 아님 / steps가 배열이 아님 → plan.steps 필요 (76)', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, { conversationId: 1, plan: null as any })).error).toBe('plan.steps 필요')
    expect((await createRun({ DB: db } as any, { conversationId: 1, plan: { steps: 'x' } as any })).error).toBe('plan.steps 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('단계가 객체가 아님 → 단계 형식 오류 (82)', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, {
      conversationId: 1, plan: { steps: ['not-a-record'] as any },
    })).error).toBe('단계 형식 오류')
  })
  test('name/persona가 문자열이 아님 → 빈 값으로 취급돼 검증 실패 (83-85)', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: 123, persona: 'echo', objective: '목표를 충분히 길게 적는다' } as any] },
    })).error).toBe('단계 name/persona/objective 필요')
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: 'x', persona: 456, objective: '목표를 충분히 길게 적는다' } as any] },
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

// ---------------- updateRunStatus 경합 가드 (174/178/188) ----------------

describe('updateRunStatus — 경합 가드', () => {
  test('run_id 없음 → run_id 필요 (174)', async () => {
    const db = makeQueueDb()
    expect((await updateRunStatus({ DB: db } as any, '', 'paused')).error).toBe('run_id 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('없는 실행 → run_not_found (178)', async () => {
    const db = makeQueueDb([null])
    expect(await updateRunStatus({ DB: db } as any, 'run_nope', 'paused')).toEqual({ ok: false, error: 'run_not_found' })
  })
  test('UPDATE changes 0 (SELECT와 UPDATE 사이 종단 전이) → run_terminal (188)', async () => {
    const db = makeQueueDb([{ status: 'running' }], [{ meta: { last_row_id: 0, changes: 0 } }])
    const r = await updateRunStatus({ DB: db } as any, 'run_abc', 'paused')
    expect(r).toEqual({ ok: false, error: 'run_terminal' })
  })
  test('UPDATE meta 없음 → run_terminal (188)', async () => {
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

// ---------------- saveCheckpoint 검증 (205/209/210/215) ----------------

describe('saveCheckpoint — 검증·직렬화', () => {
  test('run_id 없음 → run_id 필요 (205)', async () => {
    const db = makeQueueDb()
    expect((await saveCheckpoint({ DB: db } as any, '', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('run_id 필요')
  })
  test('stepName/persona 없음 → step_name/persona 필요 (209)', async () => {
    const db = makeQueueDb()
    expect((await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: '  ', persona: 'echo', state: {},
    })).error).toBe('step_name/persona 필요')
    expect((await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: '', state: {},
    })).error).toBe('step_name/persona 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('state가 배열이면 객체 아님 → state는 객체 필요 (210)', async () => {
    const db = makeQueueDb()
    expect((await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: [] as any,
    })).error).toBe('state는 객체 필요')
  })
  test('순환 참조 state → state 직렬화 실패, DB 미호출 (215)', async () => {
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

// ---------------- loadLatestCheckpoint 가드 (244) ----------------

describe('loadLatestCheckpoint — 가드', () => {
  test('run_id 없음 → run_id 필요 (244)', async () => {
    const db = makeQueueDb()
    expect((await loadLatestCheckpoint({ DB: db } as any, '  ')).error).toBe('run_id 필요')
    expect(db.calls).toHaveLength(0)
  })
  test('체크포인트 없음 → checkpoint null', async () => {
    const db = makeQueueDb([null])
    const r = await loadLatestCheckpoint({ DB: db } as any, 'run_abc')
    expect(r).toEqual({ ok: true, checkpoint: null })
  })
  test('state_json이 객체가 아니면 빈 객체로 복원', async () => {
    const db = makeQueueDb([{
      run_id: 'run_abc', step_index: 0, step_name: 'research', persona: 'echo',
      state_json: '[1,2]', created_at: '2026-10-25T00:00:00Z',
    }])
    const r = await loadLatestCheckpoint({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.checkpoint?.state).toEqual({})
  })
})

// ---------------- resumeRun 실패 분기 (295/298) ----------------

describe('resumeRun — 실패 분기', () => {
  test('체크포인트 조회 실패 → db_error (295)', async () => {
    const db = makeQueueDb([runRow(), new Error('db down')])
    const r = await resumeRun({ DB: db } as any, 'run_abc')
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })
  test('체크포인트가 전체 단계를 초과 → checkpoint_out_of_range (298)', async () => {
    const cp = {
      run_id: 'run_abc', step_index: 3, step_name: 'schedule', persona: 'cali',
      state_json: JSON.stringify({ results: ['a', 'b', 'c'] }), created_at: '2026-10-25T00:00:00Z',
    }
    const db = makeQueueDb([runRow(), cp])
    const r = await resumeRun({ DB: db } as any, 'run_abc')
    expect(r).toEqual({ ok: false, error: 'checkpoint_out_of_range' })
  })
  test('체크포인트가 마지막 단계 → 남은 단계 없음, 재개 성공', async () => {
    const cp = {
      run_id: 'run_abc', step_index: 2, step_name: 'schedule', persona: 'cali',
      state_json: JSON.stringify({ results: ['a', 'b', 'c'] }), created_at: '2026-10-25T00:00:00Z',
    }
    const db = makeQueueDb([runRow(), cp])
    const r = await resumeRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.nextStepIndex).toBe(3)
    expect(r.remainingSteps).toEqual([])
  })
})

// ---------------- driveRun 실패 분기 (344/370-371/376) ----------------

describe('driveRun — 상태 전이·체크포인트 실패', () => {
  test('체크포인트 저장 실패 → paused로 남기고 중단, 실패 단계부터 재개 가능 (370-371)', async () => {
    const db = makeStatefulDb({ failCheckpointInsert: true })
    const created = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    expect(created.ok).toBe(true)
    const runId = created.runId!
    const seen: string[] = []
    const r = await driveRun({ DB: db } as any, runId, async (step) => {
      seen.push(step.name)
      return `${step.name}-done`
    })
    expect(r.ok).toBe(false)
    expect(r.completed).toBe(false)
    expect(r.nextStepIndex).toBe(0)
    // saveCheckpoint 내부 catch가 원본 예외를 db_error로 바꿔 반환한다
    expect(r.error).toBe('db_error')
    expect(seen).toEqual(['research']) // 1단계는 실행됐으나 저장 실패로 중단
    expect(db.runs.get(runId).status).toBe('paused')
    expect(db.runs.get(runId).error).toContain('checkpoint 저장 실패')
    expect(db.checkpoints.size).toBe(0)
  })

  test('paused → running 전이 실패 시 실행하지 않음 (344)', async () => {
    // SELECT status는 paused, UPDATE는 changes 0 → updateRunStatus가 run_terminal 반환
    const db = makeQueueDb(
      [runRow({ status: 'paused' }), null, { status: 'paused' }],
      [{ meta: { last_row_id: 0, changes: 0 } }],
    )
    let n = 0
    const r = await driveRun({ DB: db } as any, 'run_abc', async () => { n++; return 'ok' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('run_terminal')
    expect(r.nextStepIndex).toBe(0)
    expect(n).toBe(0)
  })

  test('모든 단계 완료 후 completed 전이 실패 → 실패 보고 (376)', async () => {
    const db = {
      prepare(sql: string) {
        const stmt: any = {
          _params: [] as any[],
          bind(...p: any[]) { this._params = p; return this },
          async first() {
            const p = this._params
            if (sql.includes('SELECT * FROM agent_runs WHERE id')) return runRow({ status: 'running' })
            if (sql.includes('SELECT status FROM agent_runs')) return { status: 'running' }
            if (sql.includes('SELECT total_steps, status FROM agent_runs')) return { total_steps: 3, status: 'running' }
            if (sql.includes('SELECT * FROM agent_run_checkpoints')) return null
            return null
          },
          async all() { return { results: [] } },
          async run() {
            const p = this._params
            // 최종 completed 전이만 실패시킨다 (파라미터의 status 값으로 구분)
            if (sql.includes('UPDATE agent_runs SET status') && p[0] === 'completed') {
              return { meta: { last_row_id: 0, changes: 0 } }
            }
            return { meta: { last_row_id: 1, changes: 1 } }
          },
        }
        return stmt
      },
    }
    let n = 0
    const r = await driveRun({ DB: db } as any, 'run_abc', async () => { n++; return 'ok' })
    expect(n).toBe(3) // 3단계는 모두 실행됨
    expect(r.ok).toBe(false)
    expect(r.completed).toBe(false)
    expect(r.nextStepIndex).toBe(3)
    expect(r.error).toBe('run_terminal')
  })
})

// ---------------- 추가 브랜치 보강 (2차) ----------------

describe('createRun — validatePlan 추가 분기', () => {
  test('objective가 문자열이 아님 → 빈 값으로 취급 (85)', async () => {
    const db = makeQueueDb()
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: 'x', persona: 'echo', objective: 123 } as any] },
    })).error).toBe('단계 name/persona/objective 필요')
  })
})

describe('getRun — plan_json 경계', () => {
  test("plan_json 빈 문자열 → '{}'로 파싱해 빈 계획 (102)", async () => {
    const db = makeQueueDb([runRow({ plan_json: '' })])
    const r = await getRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.run?.plan).toEqual({ steps: [] })
  })
})

describe('run_id 가드 — null/undefined 입력', () => {
  test('getRun/updateRunStatus/saveCheckpoint/loadLatestCheckpoint (152/207/243/252)', async () => {
    const db = makeQueueDb()
    expect((await getRun({ DB: db } as any, null as any)).error).toBe('run_id 필요')
    expect((await updateRunStatus({ DB: db } as any, undefined as any, 'paused')).error).toBe('run_id 필요')
    expect((await saveCheckpoint({ DB: db } as any, null as any, {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('run_id 필요')
    expect((await loadLatestCheckpoint({ DB: db } as any, undefined as any)).error).toBe('run_id 필요')
    expect(db.calls).toHaveLength(0)
  })
})

describe('driveRun — 메시지 없는 예외 (357)', () => {
  test('단계가 메시지 없는 값으로 실패하면 step_failed로 보고', async () => {
    const db = makeStatefulDb()
    const created = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    const runId = created.runId!
    const r = await driveRun({ DB: db } as any, runId, async () => {
      // Error가 아닌 값 throw — e?.message가 없어 'step_failed'로 폴백
      throw { code: 'boom' }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('step_failed')
    expect(r.nextStepIndex).toBe(0)
    expect(db.runs.get(runId).status).toBe('paused')
    expect(db.runs.get(runId).error).toContain('step_failed')
  })
})

// ---------------- 추가 브랜치 보강 (3차) ----------------

describe('saveCheckpoint — stepName null (207)', () => {
  test('stepName이 null이면 빈 값으로 취급', async () => {
    const db = makeQueueDb()
    const r = await saveCheckpoint({ DB: db } as any, 'run_x', {
      stepIndex: 0, stepName: null as any, persona: 'echo', state: {},
    })
    expect(r).toEqual({ ok: false, error: 'step_name/persona 필요' })
    expect(db.calls).toHaveLength(0)
  })
})

describe('loadLatestCheckpoint — state_json null (252)', () => {
  test('state_json이 null이면 빈 객체로 복원', async () => {
    const db = makeQueueDb([{
      run_id: 'run_abc', step_index: 0, step_name: 'research', persona: 'echo',
      state_json: null, created_at: '2026-10-25T00:00:00Z',
    }])
    const r = await loadLatestCheckpoint({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.checkpoint?.state).toEqual({})
  })
})
