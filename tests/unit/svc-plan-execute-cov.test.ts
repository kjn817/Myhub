/**
 * plan-execute 커버리지 보강 (그룹 D)
 * - runStepName, verifyStepResult 분기
 * - executePlan 인메모리 경로: 재시도·검증 실패·승인 스킵·진행 콜백
 * - executePlan env 경로(0049 기록): run 생성·체크포인트·종료 상태 기록,
 *   기록 실패가 실행을 막지 않음 (방어 catch 포함)
 * FakeD1은 agent_runs 테이블을 모르므로 이 파일 전용 최소 스텁을 쓴다.
 * 운영 DB에 닿지 않음.
 */
import {
  executePlan,
  verifyStepResult,
  runStepName,
  MAX_STEP_ATTEMPTS,
  MAX_CHECKPOINT_TEXT_LENGTH,
  type PlanStep,
} from '../../src/services/plan-execute'
import {
  createRun,
  saveCheckpoint,
  updateRunStatus,
} from '../../src/services/agent-run'

jest.mock('../../src/services/agent-run', () => {
  const actual = jest.requireActual('../../src/services/agent-run')
  return {
    ...actual,
    createRun: jest.fn((...args: any[]) => (actual as any).createRun(...args)),
    saveCheckpoint: jest.fn((...args: any[]) => (actual as any).saveCheckpoint(...args)),
    updateRunStatus: jest.fn((...args: any[]) => (actual as any).updateRunStatus(...args)),
  }
})

const mockCreateRun = createRun as jest.Mock
const mockSaveCheckpoint = saveCheckpoint as jest.Mock
const mockUpdateRunStatus = updateRunStatus as jest.Mock

type Row = Record<string, any>

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** agent_runs / agent_run_checkpoints만 아는 최소 D1 스텁 */
class RunD1 {
  tables: Record<string, Row[]> = { agent_runs: [], agent_run_checkpoints: [] }

  prepare(sql: string) {
    const q = norm(sql)
    const self = this
    return {
      bind(...args: any[]) {
        return {
          async run() {
            return { success: true, meta: self.run(q, args) }
          },
          async all<T = Row>() {
            return { success: true, results: self.all(q, args) as T[], meta: {} }
          },
          async first<T = Row>(): Promise<T | null> {
            const rows = self.all(q, args)
            return (rows[0] ?? null) as T | null
          },
        }
      },
    }
  }

  private run(q: string, args: any[]): Record<string, any> {
    if (q.startsWith('INSERT INTO agent_runs')) {
      this.tables.agent_runs.push({
        id: args[0],
        conversation_id: args[1],
        user_text: args[2],
        status: 'running',
        current_step: 0,
        total_steps: args[3],
        plan_json: args[4],
        error: null,
        created_at: args[5],
        updated_at: args[6],
      })
      return { changes: 1 }
    }
    if (q.startsWith('INSERT OR REPLACE INTO agent_run_checkpoints')) {
      const [runId, stepIndex, stepName, persona, stateJson, createdAt] = args
      const existing = this.tables.agent_run_checkpoints.find(
        (r) => r.run_id === runId && r.step_index === stepIndex,
      )
      if (existing) {
        Object.assign(existing, { step_name: stepName, persona, state_json: stateJson, created_at: createdAt })
      } else {
        this.tables.agent_run_checkpoints.push({
          run_id: runId,
          step_index: stepIndex,
          step_name: stepName,
          persona,
          state_json: stateJson,
          created_at: createdAt,
        })
      }
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE agent_runs SET current_step')) {
      const [currentStep, updatedAt, id] = args
      const row = this.tables.agent_runs.find((r) => r.id === id)
      if (!row) return { changes: 0 }
      row.current_step = currentStep
      row.updated_at = updatedAt
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE agent_runs SET status')) {
      const [status, error, updatedAt, id] = args
      const row = this.tables.agent_runs.find(
        (r) => r.id === id && r.status !== 'completed' && r.status !== 'cancelled',
      )
      if (!row) return { changes: 0 }
      row.status = status
      row.error = error
      row.updated_at = updatedAt
      return { changes: 1 }
    }
    return { changes: 0 }
  }

  private all(q: string, args: any[]): Row[] {
    if (q.startsWith('SELECT status FROM agent_runs WHERE id = ?')) {
      return this.tables.agent_runs.filter((r) => r.id === args[0])
    }
    if (q.startsWith('SELECT total_steps, status FROM agent_runs WHERE id = ?')) {
      return this.tables.agent_runs.filter((r) => r.id === args[0])
    }
    return []
  }
}

function asD1(db: RunD1): any {
  return { DB: db }
}

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    index: 0,
    personaId: 'keeper',
    clause: '메모를 요약해줘',
    expectedOutcome: '메모 요약',
    verify: { kind: 'non_empty' },
    needsApproval: false,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('runStepName / verifyStepResult', () => {
  test('runStepName 형식', () => {
    expect(runStepName(step({ index: 2, personaId: 'scheduler' }))).toBe('step-2-scheduler')
  })

  test('non_empty: 빈·공백 거부, 내용 통과', () => {
    const s = step({ verify: { kind: 'non_empty' } })
    expect(verifyStepResult(s, '')).toEqual({ ok: false, reason: 'empty_result' })
    expect(verifyStepResult(s, '   ')).toEqual({ ok: false, reason: 'empty_result' })
    expect(verifyStepResult(s, '답변')).toEqual({ ok: true })
  })

  test('min_length: 경계값 — min과 같으면 통과, 한 글자 모자라면 실패 사유에 길이 포함', () => {
    const s = step({ verify: { kind: 'min_length', min: 5 } })
    expect(verifyStepResult(s, '1234')).toEqual({ ok: false, reason: 'too_short:4<5' })
    expect(verifyStepResult(s, '12345')).toEqual({ ok: true })
    expect(verifyStepResult(s, '  12345  ')).toEqual({ ok: true }) // trim 후 판정
  })

  test('contains_any: 대소문자 무시·빈 키워드 무시·미포함 시 실패', () => {
    const s = step({ verify: { kind: 'contains_any', keywords: ['일정', 'SCHEDULE'] } })
    expect(verifyStepResult(s, '내일 schedule 알려줘')).toEqual({ ok: true })
    expect(verifyStepResult(s, '내일 일정 알려줘')).toEqual({ ok: true })
    expect(verifyStepResult(s, '관련 내용 없음')).toEqual({
      ok: false,
      reason: 'missing_expected_content',
    })
    const emptyKw = step({ verify: { kind: 'contains_any', keywords: ['', '  '] } })
    expect(verifyStepResult(emptyKw, '아무 내용')).toEqual({
      ok: false,
      reason: 'missing_expected_content',
    })
  })
})

describe('executePlan — 인메모리 경로', () => {
  test('빈 계획: 실행 없이 done 진행 반환, runId null', async () => {
    const progress: any[] = []
    const result = await executePlan(
      { runStep: async () => 'x', onProgress: (p) => void progress.push(p) },
      [],
    )
    expect(result).toMatchObject({
      executions: [],
      responses: [],
      runId: null,
      stoppedEarly: false,
      failureReason: null,
    })
    expect(result.progress).toEqual({ total: 0, completed: 0, skipped: 0, failed: 0, done: true })
    expect(progress).toEqual([])
  })

  test('검증 실패 후 재시도 성공: attempts 누적·priorTexts 전달', async () => {
    const calls: Array<{ index: number; prior: string }> = []
    let n = 0
    const result = await executePlan(
      {
        runStep: async (s, index, priorTexts) => {
          calls.push({ index, prior: priorTexts })
          n++
          if (n <= 2) return 'x' // min_length 5 미달 → 검증 실패
          return '충분히 긴 답변'
        },
      },
      [
        step({ index: 0, verify: { kind: 'min_length', min: 5 } }),
        step({ index: 1, personaId: 'scheduler', clause: '내일 일정 알려줘' }),
      ],
    )
    expect(result.executions[0]).toMatchObject({ status: 'completed', attempts: 3 })
    expect(result.executions[1]).toMatchObject({ status: 'completed', attempts: 1 })
    expect(result.responses).toHaveLength(2)
    expect(result.participants).toEqual(['keeper', 'scheduler'])
    expect(result.stoppedEarly).toBe(false)
    // 두 번째 단계에는 첫 단계 결과가 [persona] 형태로 전달됨
    expect(calls[3].prior).toContain('[keeper]\n충분히 긴 답변')
    expect(result.progress.done).toBe(true)
  })

  test('예외 2회 후 성공: attempts=3, 재시도 소진 전 완료', async () => {
    let n = 0
    const result = await executePlan(
      {
        runStep: async () => {
          n++
          if (n < 3) throw new Error('transient')
          return '복구된 답변'
        },
      },
      [step()],
    )
    expect(result.executions[0]).toMatchObject({ status: 'completed', attempts: 3 })
    expect(result.responses[0].text).toBe('복구된 답변')
  })

  test('재시도 소진(최대 3회) 후 중단: 남은 단계 미실행·실패 사유 기록', async () => {
    const calls: string[] = []
    const result = await executePlan(
      {
        runStep: async (s) => {
          calls.push(s.personaId)
          throw new Error('model down')
        },
      },
      [step({ index: 0 }), step({ index: 1, personaId: 'scheduler' })],
    )
    expect(calls).toEqual(['keeper', 'keeper', 'keeper']) // 최초 1회 + 재시도 2회
    expect(result.stoppedEarly).toBe(true)
    expect(result.failureReason).toBe('model down')
    expect(result.executions).toHaveLength(1)
    expect(result.executions[0]).toMatchObject({ status: 'failed', attempts: MAX_STEP_ATTEMPTS })
    expect(result.progress).toEqual({ total: 2, completed: 0, skipped: 0, failed: 1, done: true })
    expect(result.responses).toEqual([])
  })

  test('검증 실패 소진 시 failureReason은 verify_failed:...', async () => {
    const result = await executePlan(
      { runStep: async () => '짧' },
      [step({ verify: { kind: 'min_length', min: 5 } })],
    )
    expect(result.stoppedEarly).toBe(true)
    expect(result.failureReason).toBe('verify_failed:too_short:1<5')
  })

  test('예외 메시지가 없으면 unknown으로 기록', async () => {
    const result = await executePlan(
      { runStep: async () => { throw new Error() } },
      [step()],
    )
    expect(result.failureReason).toBe('unknown')
  })

  test('승인 없는 파괴적 단계는 스킵하고 계속 (approvalChecker 없음)', async () => {
    const calls: string[] = []
    const result = await executePlan(
      { runStep: async (s) => { calls.push(s.personaId); return '완료 답변' } },
      [
        step({ index: 0, needsApproval: true, clause: '메모 1 삭제해줘' }),
        step({ index: 1, personaId: 'scheduler' }),
      ],
    )
    expect(calls).toEqual(['scheduler'])
    expect(result.executions[0]).toMatchObject({ status: 'skipped', attempts: 0, reason: 'approval_required' })
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toBe('approval_required')
    expect(result.executions[1].status).toBe('completed')
    expect(result.stoppedEarly).toBe(false)
    expect(result.progress).toEqual({ total: 2, completed: 1, skipped: 1, failed: 0, done: true })
  })

  test('approvalChecker가 throw하면 승인 거부로 스킵', async () => {
    const result = await executePlan(
      {
        runStep: async () => '완료 답변',
        approvalChecker: async () => { throw new Error('checker down') },
      },
      [step({ needsApproval: true })],
    )
    expect(result.executions[0]).toMatchObject({ status: 'skipped', reason: 'approval_required' })
    expect(result.stoppedEarly).toBe(false)
  })

  test('approvalChecker가 false면 스킵, true면 실행', async () => {
    const denied = await executePlan(
      {
        runStep: async () => '완료 답변',
        approvalChecker: () => false,
      },
      [step({ needsApproval: true })],
    )
    expect(denied.executions[0].status).toBe('skipped')
    const allowed = await executePlan(
      {
        runStep: async () => '완료 답변',
        approvalChecker: () => true,
      },
      [step({ needsApproval: true })],
    )
    expect(allowed.executions[0].status).toBe('completed')
  })

  test('onProgress는 단계 경계마다 호출되고, 콜백 실패는 실행을 막지 않음', async () => {
    const seen: any[] = []
    const result = await executePlan(
      {
        runStep: async () => '완료 답변',
        onProgress: (p) => {
          seen.push({ ...p })
          if (seen.length === 1) throw new Error('progress listener down')
        },
      },
      [step({ index: 0 }), step({ index: 1, personaId: 'scheduler' })],
    )
    expect(result.executions.map((e) => e.status)).toEqual(['completed', 'completed'])
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ total: 2, completed: 1, skipped: 0, failed: 0, done: false })
    expect(seen[1]).toEqual({ total: 2, completed: 2, skipped: 0, failed: 0, done: true })
  })
})

describe('executePlan — env 경로 (0049 기록)', () => {
  test('성공: run 생성·단계별 체크포인트·completed 상태 기록', async () => {
    const db = new RunD1()
    const env = asD1(db)
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 7, userText: '메모 요약해줘 그리고 내일 일정 알려줘' },
        runStep: async (s) => (s.personaId === 'keeper' ? '에코 요약 답변입니다' : '캘리 일정 답변입니다'),
      },
      [
        step({ index: 0 }),
        step({ index: 1, personaId: 'scheduler', clause: '내일 일정 알려줘' }),
      ],
    )
    expect(result.runId).toBeTruthy()
    expect(result.stoppedEarly).toBe(false)
    const run = db.tables.agent_runs[0]
    expect(run.status).toBe('completed')
    expect(run.total_steps).toBe(2)
    expect(run.current_step).toBe(2)
    expect(run.conversation_id).toBe(7)
    expect(JSON.parse(run.plan_json).steps.map((s: any) => s.name)).toEqual([
      'step-0-keeper',
      'step-1-scheduler',
    ])
    expect(db.tables.agent_run_checkpoints).toHaveLength(2)
    const last = JSON.parse(db.tables.agent_run_checkpoints[1].state_json)
    expect(last.results.map((r: any) => r.status)).toEqual(['completed', 'completed'])
    expect(last.results.map((r: any) => r.attempts)).toEqual([1, 1])
    expect(last.results[0].text).toContain('에코 요약 답변입니다')
    expect(mockCreateRun).toHaveBeenCalledTimes(1)
    expect(mockSaveCheckpoint).toHaveBeenCalledTimes(2)
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(env, result.runId, 'completed')
  })

  test('실패: 재시도 소진 후 중단, run은 failed, 실패 단계 체크포인트 없음', async () => {
    const db = new RunD1()
    const env = asD1(db)
    const calls: string[] = []
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 8, userText: '메모 요약해줘' },
        runStep: async (s) => {
          calls.push(s.personaId)
          if (s.personaId === 'keeper') throw new Error('model down')
          return '캘리 일정 답변입니다'
        },
      },
      [
        step({ index: 0 }),
        step({ index: 1, personaId: 'scheduler' }),
      ],
    )
    expect(calls).toEqual(['keeper', 'keeper', 'keeper'])
    expect(result.runId).toBeTruthy()
    expect(result.stoppedEarly).toBe(true)
    expect(result.failureReason).toBe('model down')
    const run = db.tables.agent_runs[0]
    expect(run.status).toBe('failed')
    expect(run.error).toContain('step 0 실패')
    expect(run.error).toContain('model down')
    expect(db.tables.agent_run_checkpoints).toHaveLength(0)
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      env,
      result.runId,
      'failed',
      expect.stringContaining('step 0 실패'),
    )
  })

  test('승인 스킵 단계도 체크포인트에 남고 run은 completed', async () => {
    const db = new RunD1()
    const env = asD1(db)
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 9, userText: '메모 삭제 후 일정 알려줘' },
        runStep: async () => '캘리 일정 답변입니다',
      },
      [
        step({ index: 0, needsApproval: true, clause: '메모 1 삭제해줘' }),
        step({ index: 1, personaId: 'scheduler' }),
      ],
    )
    expect(result.stoppedEarly).toBe(false)
    expect(db.tables.agent_runs[0].status).toBe('completed')
    expect(db.tables.agent_run_checkpoints).toHaveLength(2)
    const last = JSON.parse(db.tables.agent_run_checkpoints[1].state_json)
    expect(last.results.map((r: any) => r.status)).toEqual(['skipped', 'completed'])
    expect(last.results[0]).toMatchObject({ attempts: 0, reason: 'approval_required' })
  })

  test('체크포인트 state의 단계 결과 텍스트는 2000자로 절단', async () => {
    const db = new RunD1()
    const env = asD1(db)
    const longText = '가'.repeat(2500)
    await executePlan(
      {
        env,
        runMeta: { conversationId: 10, userText: '긴 답변 요청' },
        runStep: async () => longText,
      },
      [step()],
    )
    const state = JSON.parse(db.tables.agent_run_checkpoints[0].state_json)
    expect(state.results[0].text).toHaveLength(MAX_CHECKPOINT_TEXT_LENGTH)
    expect(state.results[0].text).toBe('가'.repeat(2000))
  })

  test('runMeta 없으면 기록 없이 인메모리 실행 (runId null)', async () => {
    const db = new RunD1()
    const env = asD1(db)
    const result = await executePlan(
      { env, runStep: async () => '완료 답변' },
      [step()],
    )
    expect(result.runId).toBeNull()
    expect(result.executions[0].status).toBe('completed')
    expect(db.tables.agent_runs).toHaveLength(0)
    expect(mockCreateRun).not.toHaveBeenCalled()
  })

  test('빈 단계 목록이면 run을 만들지 않음', async () => {
    const db = new RunD1()
    const env = asD1(db)
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 11, userText: '빈 계획' },
        runStep: async () => '완료 답변',
      },
      [],
    )
    expect(result.runId).toBeNull()
    expect(mockCreateRun).not.toHaveBeenCalled()
  })

  test('createRun이 ok:false면 인메모리로 계속 실행', async () => {
    const db = new RunD1()
    const env = asD1(db)
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 0, userText: '잘못된 대화 ID' }, // createRun 검증 실패
        runStep: async () => '완료 답변',
      },
      [step()],
    )
    expect(result.runId).toBeNull()
    expect(result.executions[0].status).toBe('completed')
    expect(db.tables.agent_runs).toHaveLength(0)
  })

  test('createRun이 throw해도 실행을 막지 않음', async () => {
    const db = new RunD1()
    const env = asD1(db)
    mockCreateRun.mockRejectedValueOnce(new Error('run store down'))
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 12, userText: '기록 실패 상황' },
        runStep: async () => '완료 답변',
      },
      [step()],
    )
    expect(result.runId).toBeNull()
    expect(result.executions[0].status).toBe('completed')
  })

  test('체크포인트 저장 실패가 실행을 막지 않음', async () => {
    const db = new RunD1()
    const env = asD1(db)
    mockSaveCheckpoint.mockRejectedValueOnce(new Error('checkpoint store down'))
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 13, userText: '체크포인트 실패 상황' },
        runStep: async () => '완료 답변',
      },
      [step()],
    )
    expect(result.executions[0].status).toBe('completed')
    expect(result.runId).toBeTruthy()
    expect(db.tables.agent_runs[0].status).toBe('completed')
  })

  test('종료 상태 기록 실패가 결과 반환을 막지 않음', async () => {
    const db = new RunD1()
    const env = asD1(db)
    mockUpdateRunStatus.mockRejectedValueOnce(new Error('status store down'))
    const result = await executePlan(
      {
        env,
        runMeta: { conversationId: 14, userText: '종료 기록 실패 상황' },
        runStep: async () => '완료 답변',
      },
      [step()],
    )
    expect(result.executions[0].status).toBe('completed')
    expect(result.runId).toBeTruthy()
    expect(result.stoppedEarly).toBe(false)
  })
})
