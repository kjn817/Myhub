/// <reference types="jest" />
/**
 * 트랙 7 — agent-framework 패턴: 코디네이터·핸드오프·체크포인팅
 * - src/services/agent-run.ts: run 생성·체크포인트 저장·재개·driveRun
 * - src/services/agent-handoff.ts: 형식 있는 핸드오프 기록
 * - src/services/orchestrator.ts: 협업 시 recordHandoff 훅
 *
 * 중단·재개 시나리오는 tests/integration/agent-run-0049-real.test.js에서
 * 실제 SQLite로 종단 검증한다. 여기서는 검증·SQL 형태·상태 전이를 단위로 검증한다.
 */
import {
  createRun,
  getRun,
  updateRunStatus,
  saveCheckpoint,
  loadLatestCheckpoint,
  resumeRun,
  driveRun,
  generateRunId,
  type RunPlan,
} from '../../src/services/agent-run'
import {
  buildCoordinatorHandoff,
  createStructuredHandoff,
  resolveStructuredHandoff,
  getStructuredHandoff,
} from '../../src/services/agent-handoff'
import { orchestrate, setRouter, type OrchestratorDeps } from '../../src/services/orchestrator'
import { KeywordRouter, type Router } from '../../src/services/legacy-router'

// ---------------- mock D1 (호출 기록 + first 결과 큐) ----------------

function makeDb(firstQueue: any[] = [], runChanges: number[] = []) {
  const calls: { sql: string; params: any[] }[] = []
  let runIdx = 0
  return {
    calls,
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          calls.push({ sql, params: this._params })
          return firstQueue.shift() ?? null
        },
        async all() {
          calls.push({ sql, params: this._params })
          return { results: [] }
        },
        async run() {
          calls.push({ sql, params: this._params })
          const changes = runChanges[runIdx++] ?? 1
          return { meta: { last_row_id: 31, changes } }
        },
      }
    },
  }
}

// ---------------- driveRun용 상태 저장 가짜 D1 ----------------

function makeStatefulDb() {
  const runs = new Map<string, any>()
  const checkpoints = new Map<string, any>() // key: runId:stepIndex
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
          if (sql.includes('SELECT id FROM agent_runs')) {
            return runs.get(p[0]) ? { id: p[0] } : null
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

describe('generateRunId', () => {
  test('run_ 접두 + 유일성', () => {
    const a = generateRunId()
    const b = generateRunId()
    expect(a.startsWith('run_')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('createRun', () => {
  test('생성 — INSERT SQL + plan 직렬화', async () => {
    const db = makeDb()
    const r = await createRun({ DB: db } as any, { conversationId: 7, userText: '복합 요청', plan: PLAN })
    expect(r.ok).toBe(true)
    expect(r.runId).toMatch(/^run_/)
    const ins = db.calls[0]
    expect(ins.sql).toContain('INSERT INTO agent_runs')
    expect(ins.params[1]).toBe(7)
    expect(ins.params[3]).toBe(3) // total_steps
    expect(JSON.parse(ins.params[4])).toEqual({ steps: PLAN.steps })
  })
  test('검증 — conversation_id/plan 오류 시 DB 미호출', async () => {
    const db = makeDb()
    expect((await createRun({ DB: db } as any, { conversationId: 0, plan: PLAN })).ok).toBe(false)
    expect((await createRun({ DB: db } as any, { conversationId: 1, plan: { steps: [] } })).ok).toBe(false)
    expect((await createRun({ DB: db } as any, { conversationId: 1, plan: { steps: Array(21).fill(PLAN.steps[0]) } })).ok).toBe(false)
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [PLAN.steps[0], PLAN.steps[0]] },
    })).ok).toBe(false) // 단계 이름 중복
    expect((await createRun({ DB: db } as any, {
      conversationId: 1,
      plan: { steps: [{ name: 'x', persona: 'echo', objective: '' }] },
    })).ok).toBe(false) // objective 없음
    expect(db.calls).toHaveLength(0)
  })
})

describe('saveCheckpoint', () => {
  test('저장 — INSERT OR REPLACE + run current_step 갱신', async () => {
    const db = makeDb([{ total_steps: 3, status: 'running' }])
    const r = await saveCheckpoint({ DB: db } as any, 'run_abc', {
      stepIndex: 0, stepName: 'research', persona: 'echo', state: { results: ['요약'] },
    })
    expect(r.ok).toBe(true)
    expect(db.calls[0].sql).toContain('SELECT total_steps, status FROM agent_runs')
    expect(db.calls[1].sql).toContain('INSERT OR REPLACE INTO agent_run_checkpoints')
    expect(db.calls[1].params[1]).toBe(0)
    expect(JSON.parse(db.calls[1].params[4])).toEqual({ results: ['요약'] })
    expect(db.calls[2].sql).toContain('UPDATE agent_runs SET current_step')
    expect(db.calls[2].params[0]).toBe(1) // 다음 단계
  })
  test('검증 — run 없음 / 범위 초과 / 종단 상태 / state 과다', async () => {
    expect((await saveCheckpoint({ DB: makeDb([null]) } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('run_not_found')
    expect((await saveCheckpoint({ DB: makeDb([{ total_steps: 1, status: 'running' }]) } as any, 'run_x', {
      stepIndex: 1, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('step_out_of_range')
    expect((await saveCheckpoint({ DB: makeDb([{ total_steps: 3, status: 'completed' }]) } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('run_terminal')
    expect((await saveCheckpoint({ DB: makeDb() } as any, 'run_x', {
      stepIndex: 0, stepName: 'a', persona: 'echo', state: { big: 'x'.repeat(100_001) },
    })).error).toBe('state 과다 (100KB 초과)')
    expect((await saveCheckpoint({ DB: makeDb() } as any, 'run_x', {
      stepIndex: -1, stepName: 'a', persona: 'echo', state: {},
    })).error).toBe('step_index 오류')
  })
})

describe('resumeRun', () => {
  const runRow = {
    id: 'run_abc', conversation_id: 1, user_text: '요청', status: 'paused',
    current_step: 1, total_steps: 3, plan_json: JSON.stringify(PLAN),
    error: 'step 1 실패', created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z',
  }
  test('체크포인트 없음 → 0번 단계부터', async () => {
    const db = makeDb([runRow, null])
    const r = await resumeRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.nextStepIndex).toBe(0)
    expect(r.remainingSteps).toHaveLength(3)
    expect(r.state).toEqual({})
  })
  test('체크포인트 있음 → 다음 단계부터, 완료 단계는 제외', async () => {
    const cp = {
      run_id: 'run_abc', step_index: 0, step_name: 'research', persona: 'echo',
      state_json: JSON.stringify({ results: ['요약'] }), created_at: '2026-10-25T00:00:00Z',
    }
    const db = makeDb([runRow, cp])
    const r = await resumeRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.nextStepIndex).toBe(1)
    expect(r.remainingSteps?.map((s) => s.name)).toEqual(['draft', 'schedule'])
    expect(r.state).toEqual({ results: ['요약'] })
  })
  test('완료된 실행은 재개 불가', async () => {
    const db = makeDb([{ ...runRow, status: 'completed' }])
    const r = await resumeRun({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('run_terminal')
  })
  test('실행 없음 → run_not_found', async () => {
    const db = makeDb([null])
    const r = await resumeRun({ DB: db } as any, 'run_nope')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('run_not_found')
  })
})

describe('updateRunStatus', () => {
  test('paused → running 전이 가능', async () => {
    const db = makeDb([{ status: 'paused' }])
    expect((await updateRunStatus({ DB: db } as any, 'run_abc', 'running')).ok).toBe(true)
    expect(db.calls[1].sql).toContain('UPDATE agent_runs SET status')
    expect(db.calls[1].params[0]).toBe('running')
  })
  test('종단 상태에서는 전이 불가', async () => {
    const db = makeDb([{ status: 'completed' }])
    const r = await updateRunStatus({ DB: db } as any, 'run_abc', 'running')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('run_terminal')
    expect(db.calls).toHaveLength(1) // SELECT만, UPDATE 미호출
  })
  test('잘못된 status 값 거부', async () => {
    const db = makeDb()
    expect((await updateRunStatus({ DB: db } as any, 'run_abc', 'bogus' as any)).ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
})

describe('loadLatestCheckpoint', () => {
  test('state JSON 파싱 실패 → 빈 객체로 복원', async () => {
    const db = makeDb([{
      run_id: 'run_abc', step_index: 0, step_name: 'research', persona: 'echo',
      state_json: '{broken', created_at: '2026-10-25T00:00:00Z',
    }])
    const r = await loadLatestCheckpoint({ DB: db } as any, 'run_abc')
    expect(r.ok).toBe(true)
    expect(r.checkpoint?.state).toEqual({})
  })
})

describe('driveRun — 상태 저장 가짜 D1', () => {
  test('전체 성공 — 3단계 실행 후 completed, 체크포인트 3개', async () => {
    const db = makeStatefulDb()
    const created = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    expect(created.ok).toBe(true)
    const seen: string[] = []
    const r = await driveRun({ DB: db } as any, created.runId!, async (step) => {
      seen.push(step.name)
      return `${step.name}-done`
    })
    expect(r.ok).toBe(true)
    expect(r.completed).toBe(true)
    expect(r.nextStepIndex).toBe(3)
    expect(seen).toEqual(['research', 'draft', 'schedule'])
    expect(db.checkpoints.size).toBe(3)
    const run = db.runs.get(created.runId!)
    expect(run.status).toBe('completed')
    expect(run.current_step).toBe(3)
    const last = db.checkpoints.get(`${created.runId!}:2`)
    expect(JSON.parse(last.state_json).results).toEqual(['research-done', 'draft-done', 'schedule-done'])
  })

  test('중단·재개 — 2단계 실패 후 paused, 재개 시 실패 단계부터 이어하고 완료 단계는 재실행 안 함', async () => {
    const db = makeStatefulDb()
    const created = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    const runId = created.runId!
    const calls: string[] = []
    // 1차: 2단계(draft)에서 실패
    const first = await driveRun({ DB: db } as any, runId, async (step) => {
      calls.push(step.name)
      if (step.name === 'draft') throw new Error('모델 호출 실패')
      return `${step.name}-done`
    })
    expect(first.ok).toBe(false)
    expect(first.completed).toBe(false)
    expect(first.nextStepIndex).toBe(1)
    expect(first.error).toBe('모델 호출 실패')
    expect(db.runs.get(runId).status).toBe('paused')
    expect(db.checkpoints.size).toBe(1) // research만 저장됨
    // 2차: 재개 — research는 다시 실행하지 않고 draft부터 이어한다
    const second = await driveRun({ DB: db } as any, runId, async (step) => {
      calls.push(step.name)
      return `${step.name}-done`
    })
    expect(second.ok).toBe(true)
    expect(second.completed).toBe(true)
    expect(calls).toEqual(['research', 'draft', 'draft', 'schedule'])
    expect(db.runs.get(runId).status).toBe('completed')
    const last = db.checkpoints.get(`${runId}:2`)
    expect(JSON.parse(last.state_json).results).toEqual(['research-done', 'draft-done', 'schedule-done'])
  })

  test('완료된 실행을 다시 drive하면 run_terminal로 거부되고 재실행 없음', async () => {
    const db = makeStatefulDb()
    const created = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    const runId = created.runId!
    let n = 0
    await driveRun({ DB: db } as any, runId, async () => { n++; return 'ok' })
    expect(n).toBe(3)
    const again = await driveRun({ DB: db } as any, runId, async () => { n++; return 'ok' })
    expect(again.ok).toBe(false)
    expect(again.error).toBe('run_terminal')
    expect(n).toBe(3) // 재실행 없음
  })

  test('plan 손상 시 실행하지 않고 plan_mismatch 반환', async () => {
    const db = makeStatefulDb()
    const created = await createRun({ DB: db } as any, { conversationId: 1, plan: PLAN })
    const runId = created.runId!
    // plan_json을 손상시킨다 (total_steps=3인데 steps 1개)
    db.runs.get(runId).plan_json = JSON.stringify({ steps: [PLAN.steps[0]] })
    let n = 0
    const r = await driveRun({ DB: db } as any, runId, async () => { n++; return 'ok' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('plan_mismatch')
    expect(n).toBe(0)
  })

  test('없는 실행 → run_not_found', async () => {
    const db = makeStatefulDb()
    const r = await driveRun({ DB: db } as any, 'run_nope', async () => 'x')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('run_not_found')
  })
})

describe('buildCoordinatorHandoff', () => {
  test('요청·맥락·제약·기대 출력이 형식 있게 담긴다', () => {
    const h = buildCoordinatorHandoff('concierge', 'keeper', '메모 요약해줘', '주 답변입니다', ['요약은 원문 기반'])
    expect(h.fromPersona).toBe('concierge')
    expect(h.toPersona).toBe('keeper')
    expect(h.request).toBe('메모 요약해줘')
    expect(h.context).toHaveLength(1)
    expect(h.context[0]).toContain('주 답변입니다')
    expect(h.constraints).toEqual(['요약은 원문 기반'])
    expect(h.expectedOutput).toContain('보완')
  })
  test('긴 답변은 맥락에서 500자로 절단', () => {
    const h = buildCoordinatorHandoff('concierge', 'keeper', '요청', 'x'.repeat(1000))
    expect(h.context[0].length).toBeLessThanOrEqual('[concierge의 답변]\n'.length + 500)
  })
})

describe('createStructuredHandoff', () => {
  test('생성 — INSERT SQL + JSON 직렬화', async () => {
    const db = makeDb()
    const r = await createStructuredHandoff({ DB: db } as any, {
      fromPersona: 'concierge', toPersona: 'keeper', request: '메모 요약해줘',
      context: ['주 답변'], constraints: ['원문 기반'], expectedOutput: '요약문',
    })
    expect(r.ok).toBe(true)
    expect(r.id).toBe(31)
    const ins = db.calls[0]
    expect(ins.sql).toContain('INSERT INTO agent_handoffs')
    expect(ins.params[2]).toBe('concierge')
    expect(ins.params[3]).toBe('keeper')
    expect(JSON.parse(ins.params[5])).toEqual(['주 답변'])
    expect(JSON.parse(ins.params[6])).toEqual(['원문 기반'])
  })
  test('검증 — from/to 같음, request 없음, context 과다 시 DB 미호출', async () => {
    const db = makeDb()
    const base = {
      fromPersona: 'concierge', toPersona: 'keeper', request: '요청',
      context: [] as string[], constraints: [] as string[], expectedOutput: '출력',
    }
    expect((await createStructuredHandoff({ DB: db } as any, { ...base, toPersona: 'concierge' })).error).toBe('from/to가 같음')
    expect((await createStructuredHandoff({ DB: db } as any, { ...base, request: '  ' })).error).toBe('request 필요')
    expect((await createStructuredHandoff({ DB: db } as any, { ...base, context: Array(11).fill('x') })).error)
      .toContain('context 형식 오류')
    expect((await createStructuredHandoff({ DB: db } as any, { ...base, constraints: ['x'.repeat(201)] })).error)
      .toContain('constraints 형식 오류')
    expect(db.calls).toHaveLength(0)
  })
  test('연결 대상 검증 — 없는 run / 없는 memory_handoff면 거부', async () => {
    const db1 = makeDb([null])
    expect((await createStructuredHandoff({ DB: db1 } as any, {
      fromPersona: 'a', toPersona: 'b', request: 'r', context: [], constraints: [], expectedOutput: '',
      runId: 'run_nope',
    })).error).toBe('run_not_found')
    const db2 = makeDb([null])
    expect((await createStructuredHandoff({ DB: db2 } as any, {
      fromPersona: 'a', toPersona: 'b', request: 'r', context: [], constraints: [], expectedOutput: '',
      memoryHandoffId: 999,
    })).error).toBe('memory_handoff_not_found')
  })
})

describe('resolveStructuredHandoff', () => {
  test('pending → completed 1회 성공, 2회째는 거부', async () => {
    const db1 = makeDb([], [1])
    expect((await resolveStructuredHandoff({ DB: db1 } as any, 5, 'completed')).ok).toBe(true)
    expect(db1.calls[0].sql).toContain("status = 'pending'")
    const db2 = makeDb([], [0])
    expect((await resolveStructuredHandoff({ DB: db2 } as any, 5, 'completed')).error).toBe('not_pending_or_not_found')
  })
  test('pending으로의 전이·잘못된 status 거부', async () => {
    const db = makeDb()
    expect((await resolveStructuredHandoff({ DB: db } as any, 5, 'pending' as any)).ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
})

describe('getStructuredHandoff', () => {
  test('JSON 파싱 실패 시 빈 배열로 복원', async () => {
    const db = makeDb([{
      id: 5, run_id: null, memory_handoff_id: null, from_persona: 'a', to_persona: 'b',
      request: 'r', context_json: '{broken', constraints_json: '[', expected_output: '',
      status: 'pending', created_at: '2026-10-25T00:00:00Z', resolved_at: null,
    }])
    const r = await getStructuredHandoff({ DB: db } as any, 5)
    expect(r.ok).toBe(true)
    expect(r.handoff?.context).toEqual([])
    expect(r.handoff?.constraints).toEqual([])
  })
})

describe('orchestrate — recordHandoff 훅', () => {
  beforeEach(() => {
    setRouter(new KeywordRouter())
  })
  const mockRouter = (decision: any): Router => ({
    route: async () => decision,
    needsCollaboration: async () => ({ needed: false, reason: 'test' }),
  })

  test('협업 시 형식 있는 핸드오프가 기록된다', async () => {
    setRouter(mockRouter({ primary: 'concierge', collaborator: 'keeper', reason: 'test', confidence: 1 }))
    const recordHandoff = jest.fn().mockResolvedValue(undefined)
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: '주 답변' })
      .mockResolvedValueOnce({ text: '보완 답변' })
    const deps: OrchestratorDeps = {
      callAssistant,
      recordHandoff,
      handoffConstraints: { keeper: ['요약은 원문 기반'] },
    }
    const result = await orchestrate(deps, '메모 요약해줘', [{ role: 'user', content: '메모 요약해줘' }], 1)
    expect(result.participants).toEqual(['concierge', 'keeper'])
    expect(recordHandoff).toHaveBeenCalledTimes(1)
    const h = recordHandoff.mock.calls[0][0]
    expect(h.fromPersona).toBe('concierge')
    expect(h.toPersona).toBe('keeper')
    expect(h.request).toBe('메모 요약해줘')
    expect(h.context[0]).toContain('주 답변')
    expect(h.constraints).toEqual(['요약은 원문 기반'])
    expect(h.expectedOutput).toContain('보완')
  })

  test('기록 실패해도 협업은 계속된다', async () => {
    setRouter(mockRouter({ primary: 'concierge', collaborator: 'keeper', reason: 'test', confidence: 1 }))
    const recordHandoff = jest.fn().mockRejectedValue(new Error('db down'))
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: '주 답변' })
      .mockResolvedValueOnce({ text: '보완 답변' })
    const result = await orchestrate({ callAssistant, recordHandoff }, '요청', [], 1)
    expect(result.text).toContain('보완 답변')
    expect(result.participants).toEqual(['concierge', 'keeper'])
  })

  test('협업이 없으면 기록하지 않는다', async () => {
    setRouter(mockRouter({ primary: 'concierge', reason: 'test', confidence: 1 }))
    const recordHandoff = jest.fn().mockResolvedValue(undefined)
    await orchestrate({ callAssistant: jest.fn().mockResolvedValue({ text: 'hi' }), recordHandoff }, '안녕', [], 1)
    expect(recordHandoff).not.toHaveBeenCalled()
  })

  test('recordHandoff 없으면 기존 동작 그대로', async () => {
    setRouter(mockRouter({ primary: 'concierge', collaborator: 'keeper', reason: 'test', confidence: 1 }))
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: '주 답변' })
      .mockResolvedValueOnce({ text: '보완 답변' })
    const result = await orchestrate({ callAssistant }, '요청', [], 1)
    expect(result.participants).toEqual(['concierge', 'keeper'])
  })
})
