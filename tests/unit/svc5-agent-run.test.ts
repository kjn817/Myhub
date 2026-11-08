/// <reference types="jest" />
/**
 * 트랙 7 — agent-framework 패턴: 코디네이터·핸드오프·체크포인팅
 * - src/services/agent-run.ts: run 생성·상태 전이·체크포인트 저장
 * - src/services/agent-handoff.ts: 형식 있는 핸드오프 입력 빌더
 * - src/services/orchestrator.ts: 협업 시 recordHandoff 훅
 *
 * [재작성 기록 — 2026-11-08 배치 3]
 * - 구 driveRun/resumeRun/getRun/loadLatestCheckpoint 생명주기는 번들·현행
 *   어디에도 없다. 현행 실행은 plan-execute.executePlan의 단방향 실행이고
 *   체크포인트는 재개점이 아니라 실행 기록이다 → resumeRun(4건)·
 *   loadLatestCheckpoint(1건)·driveRun(5건) describe 삭제.
 * - 핸드오프 DB CRUD(createStructuredHandoff 등) describe 4건 삭제 —
 *   svc-agent-handoff-cov.test.ts의 삭제 기록과 동일 사유.
 * - orchestrate 훅 테스트는 구 setRouter 주입이 사라져, 내장 KeywordRouter가
 *   실제로 협업을 만드는 다중 도메인 문장으로 다시 썼다.
 */
import {
  createRun,
  updateRunStatus,
  saveCheckpoint,
  generateRunId,
  type RunPlan,
} from '../../src/services/agent-run'
import { buildCoordinatorHandoff } from '../../src/services/agent-handoff'
import { orchestrate, type OrchestratorDeps } from '../../src/services/orchestrator'

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

describe('orchestrate — recordHandoff 훅', () => {
  // 내장 KeywordRouter 기준: 메모(keeper) + 코드(builder) 키워드가 함께 있으면
  // builder가 주 담당, keeper가 협업자가 된다 (matchedIds 순서 builder→keeper→scheduler).
  const MULTI = '메모 요약하고 코드로 정리해줘'

  test('협업 시 형식 있는 핸드오프가 기록된다', async () => {
    const recordHandoff = jest.fn().mockResolvedValue(undefined)
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: '주 답변' })
      .mockResolvedValueOnce({ text: '보완 답변' })
    const deps: OrchestratorDeps = {
      callAssistant,
      recordHandoff,
      handoffConstraints: { keeper: ['요약은 원문 기반'] },
    }
    const result = await orchestrate(deps, MULTI, [{ role: 'user', content: MULTI }], 1)
    expect(result.participants).toEqual(['builder', 'keeper'])
    expect(recordHandoff).toHaveBeenCalledTimes(1)
    const h = recordHandoff.mock.calls[0][0]
    expect(h.fromPersona).toBe('builder')
    expect(h.toPersona).toBe('keeper')
    expect(h.request).toBe(MULTI)
    expect(h.context[0]).toContain('주 답변')
    expect(h.constraints).toEqual(['요약은 원문 기반'])
    expect(h.expectedOutput).toContain('보완')
  })

  test('기록 실패해도 협업은 계속된다', async () => {
    const recordHandoff = jest.fn().mockRejectedValue(new Error('db down'))
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: '주 답변' })
      .mockResolvedValueOnce({ text: '보완 답변' })
    const result = await orchestrate({ callAssistant, recordHandoff }, MULTI, [], 1)
    expect(result.text).toContain('보완 답변')
    expect(result.participants).toEqual(['builder', 'keeper'])
  })

  test('협업이 없으면 기록하지 않는다', async () => {
    // (c) 정리: 기록형 recordHandoff가 받은 인계 기록이 비어 있고,
    // 단일 응답 자체는 정상 반환됨을 단언한다.
    const recorded: any[] = []
    const recordHandoff = async (h: any) => { recorded.push(h) }
    const result = await orchestrate(
      { callAssistant: jest.fn().mockResolvedValue({ text: 'hi' }), recordHandoff },
      '메모 요약해줘',
      [],
      1,
    )
    expect(recorded).toEqual([])
    expect(result.text).toBe('hi')
  })

  test('recordHandoff 없으면 기존 동작 그대로', async () => {
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: '주 답변' })
      .mockResolvedValueOnce({ text: '보완 답변' })
    const result = await orchestrate({ callAssistant }, MULTI, [], 1)
    expect(result.participants).toEqual(['builder', 'keeper'])
  })
})
