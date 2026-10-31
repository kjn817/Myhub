/**
 * agent-handoff 커버리지 보강 (그룹 D)
 * - createStructuredHandoff: run/memory_handoff 연결 검증·db_error
 * - resolveStructuredHandoff: 원자적 pending 가드·db_error
 * - getStructuredHandoff: 성공 경로·깨진 JSON·db_error
 * - listRunHandoffs: 전체 함수 (기존 전수 미커버)
 * FakeD1은 agent_handoffs 테이블을 모르므로 이 파일 전용 최소 스텁을 쓴다.
 * 운영 DB에 닿지 않음.
 */
import {
  buildCoordinatorHandoff,
  createStructuredHandoff,
  resolveStructuredHandoff,
  getStructuredHandoff,
  listRunHandoffs,
  type StructuredHandoffInput,
} from '../../src/services/agent-handoff'

type Row = Record<string, any>

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** agent_handoffs / agent_runs / memory_handoffs만 아는 최소 D1 스텁 */
class HandoffD1 {
  tables: Record<string, Row[]> = {
    agent_runs: [],
    memory_handoffs: [],
    agent_handoffs: [],
  }
  private seq = 0
  /** 이 접두사로 시작하는 SQL에서 throw (db_error 경로용) */
  failOnPrefix: string | null = null
  /** run_id 목록 조회가 results:null을 반환 (|| [] 분기용) */
  nullListResults = false

  seedRun(id: string) {
    this.tables.agent_runs.push({ id })
  }
  seedMemoryHandoff(id: number) {
    this.tables.memory_handoffs.push({ id })
  }

  prepare(sql: string) {
    const q = norm(sql)
    const self = this
    const fail = () => {
      if (self.failOnPrefix && q.startsWith(self.failOnPrefix)) {
        throw new Error('db down')
      }
    }
    return {
      bind(...args: any[]) {
        return {
          async run() {
            fail()
            return { success: true, meta: self.run(q, args) }
          },
          async all<T = Row>() {
            fail()
            if (self.nullListResults && q.startsWith('SELECT * FROM agent_handoffs WHERE run_id = ?')) {
              return { success: true, results: null as unknown as T[], meta: {} }
            }
            return { success: true, results: self.all(q, args) as T[], meta: {} }
          },
          async first<T = Row>(): Promise<T | null> {
            fail()
            const rows = self.all(q, args)
            return (rows[0] ?? null) as T | null
          },
        }
      },
    }
  }

  private run(q: string, args: any[]): Record<string, any> {
    if (q.startsWith('INSERT INTO agent_handoffs')) {
      const id = ++this.seq
      this.tables.agent_handoffs.push({
        id,
        run_id: args[0],
        memory_handoff_id: args[1],
        from_persona: args[2],
        to_persona: args[3],
        request: args[4],
        context_json: args[5],
        constraints_json: args[6],
        expected_output: args[7],
        status: 'pending',
        created_at: args[8],
        resolved_at: null,
      })
      return { last_row_id: id, changes: 1 }
    }
    if (q.startsWith('UPDATE agent_handoffs SET status')) {
      const [status, resolvedAt, id] = args
      const row = this.tables.agent_handoffs.find((r) => r.id === id && r.status === 'pending')
      if (!row) return { changes: 0 }
      row.status = status
      row.resolved_at = resolvedAt
      return { changes: 1 }
    }
    return { changes: 0 }
  }

  private all(q: string, args: any[]): Row[] {
    if (q.startsWith('SELECT id FROM agent_runs WHERE id = ?')) {
      return this.tables.agent_runs.filter((r) => r.id === args[0])
    }
    if (q.startsWith('SELECT id FROM memory_handoffs WHERE id = ?')) {
      return this.tables.memory_handoffs.filter((r) => r.id === args[0])
    }
    if (q.startsWith('SELECT * FROM agent_handoffs WHERE id = ?')) {
      return this.tables.agent_handoffs.filter((r) => r.id === args[0])
    }
    if (q.startsWith('SELECT * FROM agent_handoffs WHERE run_id = ?')) {
      return [...this.tables.agent_handoffs]
        .filter((r) => r.run_id === args[0])
        .sort((a, b) => a.id - b.id)
    }
    return []
  }
}

function asD1(db: HandoffD1): any {
  return { DB: db }
}

function baseInput(over: Partial<StructuredHandoffInput> = {}): StructuredHandoffInput {
  return {
    fromPersona: 'keeper',
    toPersona: 'scheduler',
    request: '내일 일정 알려줘',
    context: ['메모 요약 결과'],
    constraints: ['잠긴 메모 제외'],
    expectedOutput: '내일 일정 목록',
    ...over,
  }
}

describe('buildCoordinatorHandoff', () => {
  test('주 담당 답변을 맥락으로 담은 입력 생성 + 길이 제한 절단', () => {
    const h = buildCoordinatorHandoff(
      'keeper',
      'scheduler',
      'x'.repeat(2500),
      'y'.repeat(800),
      ['a'.repeat(300), ...Array.from({ length: 12 }, (_, i) => `제약${i}`)],
    )
    expect(h.fromPersona).toBe('keeper')
    expect(h.toPersona).toBe('scheduler')
    expect(h.request).toHaveLength(2000)
    expect(h.context).toHaveLength(1)
    expect(h.context[0]).toContain('[keeper의 답변]')
    expect(h.context[0]).toHaveLength('[keeper의 답변]\n'.length + 500)
    expect(h.constraints).toHaveLength(10)
    expect(h.constraints[0]).toHaveLength(200)
    expect(h.expectedOutput).toContain('주 담당 답변을 보완')
  })

  test('빈 답변·기본 제약', () => {
    const h = buildCoordinatorHandoff('a', 'b', '요청', '')
    expect(h.context).toEqual(['[a의 답변]\n'])
    expect(h.constraints).toEqual([])
  })
})

describe('createStructuredHandoff — 검증', () => {
  test('persona 누락·동일·request 누락·과다', async () => {
    const env = asD1(new HandoffD1())
    expect(await createStructuredHandoff(env, baseInput({ fromPersona: '  ' }))).toEqual({
      ok: false,
      error: 'persona 필요',
    })
    expect(await createStructuredHandoff(env, baseInput({ toPersona: '' }))).toEqual({
      ok: false,
      error: 'persona 필요',
    })
    // undefined 필드도 || '' 폴백으로 같은 검증에 걸림
    expect(
      await createStructuredHandoff(env, {
        ...baseInput(),
        fromPersona: undefined as unknown as string,
      }),
    ).toEqual({ ok: false, error: 'persona 필요' })
    expect(
      await createStructuredHandoff(env, {
        ...baseInput(),
        request: undefined as unknown as string,
      }),
    ).toEqual({ ok: false, error: 'request 필요' })
    expect(await createStructuredHandoff(env, baseInput({ fromPersona: 'x', toPersona: 'x' }))).toEqual({
      ok: false,
      error: 'from/to가 같음',
    })
    expect(await createStructuredHandoff(env, baseInput({ request: '   ' }))).toEqual({
      ok: false,
      error: 'request 필요',
    })
    expect(await createStructuredHandoff(env, baseInput({ request: 'r'.repeat(2001) }))).toEqual({
      ok: false,
      error: 'request 과다 (2000자 초과)',
    })
  })

  test('context 형식 오류 — 비배열·비문자열·빈 문자열·500자 초과·11개 초과', async () => {
    const env = asD1(new HandoffD1())
    const bad = (context: any) =>
      createStructuredHandoff(env, baseInput({ context }))
    expect(await bad('문자열')).toEqual({ ok: false, error: 'context 형식 오류 (최대 10개·각 500자)' })
    expect(await bad(['ok', 123])).toEqual({ ok: false, error: 'context 형식 오류 (최대 10개·각 500자)' })
    expect(await bad(['  '])).toEqual({ ok: false, error: 'context 형식 오류 (최대 10개·각 500자)' })
    expect(await bad(['x'.repeat(501)])).toEqual({ ok: false, error: 'context 형식 오류 (최대 10개·각 500자)' })
    expect(await bad(Array.from({ length: 11 }, () => 'c'))).toEqual({
      ok: false,
      error: 'context 형식 오류 (최대 10개·각 500자)',
    })
    // 경계: 10개·500자는 통과
    const ok = await createStructuredHandoff(
      env,
      baseInput({ context: Array.from({ length: 10 }, () => 'x'.repeat(500)) }),
    )
    expect(ok.ok).toBe(true)
  })

  test('constraints 형식 오류 — 비배열·200자 초과·11개 초과', async () => {
    const env = asD1(new HandoffD1())
    const bad = (constraints: any) =>
      createStructuredHandoff(env, baseInput({ constraints }))
    expect(await bad(null)).toEqual({ ok: false, error: 'constraints 형식 오류 (최대 10개·각 200자)' })
    expect(await bad(['x'.repeat(201)])).toEqual({
      ok: false,
      error: 'constraints 형식 오류 (최대 10개·각 200자)',
    })
    expect(await bad(Array.from({ length: 11 }, () => 'c'))).toEqual({
      ok: false,
      error: 'constraints 형식 오류 (최대 10개·각 200자)',
    })
  })
})

describe('createStructuredHandoff — 연결 검증·저장', () => {
  test('최소 입력 저장 성공: pending·JSON 직렬화·expectedOutput 1000자 절단', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const res = await createStructuredHandoff(
      env,
      baseInput({ expectedOutput: 'e'.repeat(1500) }),
    )
    expect(res).toEqual({ ok: true, id: 1 })
    const row = db.tables.agent_handoffs[0]
    expect(row.status).toBe('pending')
    expect(row.run_id).toBeNull()
    expect(row.memory_handoff_id).toBeNull()
    expect(JSON.parse(row.context_json)).toEqual(['메모 요약 결과'])
    expect(JSON.parse(row.constraints_json)).toEqual(['잠긴 메모 제외'])
    expect(row.expected_output).toHaveLength(1000)
    expect(row.created_at).toBeTruthy()
  })

  test('expectedOutput 미지정 시 빈 문자열로 저장', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const res = await createStructuredHandoff(env, {
      ...baseInput(),
      expectedOutput: undefined as unknown as string,
    })
    expect(res.ok).toBe(true)
    expect(db.tables.agent_handoffs[0].expected_output).toBe('')
  })

  test('runId 연결 — 없는 run이면 저장 안 함, 있는 run이면 저장', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    expect(await createStructuredHandoff(env, baseInput({ runId: 'run_missing' }))).toEqual({
      ok: false,
      error: 'run_not_found',
    })
    expect(db.tables.agent_handoffs).toHaveLength(0)
    db.seedRun('run_1')
    const res = await createStructuredHandoff(env, baseInput({ runId: 'run_1' }))
    expect(res.ok).toBe(true)
    expect(db.tables.agent_handoffs[0].run_id).toBe('run_1')
  })

  test('memoryHandoffId 검증 — 형식 오류·없는 인계·있는 인계', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    for (const bad of [0, -3, 1.5]) {
      expect(
        await createStructuredHandoff(env, baseInput({ memoryHandoffId: bad })),
      ).toEqual({ ok: false, error: 'memory_handoff_id 오류' })
    }
    expect(
      await createStructuredHandoff(env, baseInput({ memoryHandoffId: 42 })),
    ).toEqual({ ok: false, error: 'memory_handoff_not_found' })
    expect(db.tables.agent_handoffs).toHaveLength(0)
    db.seedMemoryHandoff(42)
    const res = await createStructuredHandoff(env, baseInput({ memoryHandoffId: 42 }))
    expect(res.ok).toBe(true)
    expect(db.tables.agent_handoffs[0].memory_handoff_id).toBe(42)
  })

  test('DB 오류 시 db_error (INSERT 실패)', async () => {
    const db = new HandoffD1()
    db.failOnPrefix = 'INSERT INTO agent_handoffs'
    const env = asD1(db)
    expect(await createStructuredHandoff(env, baseInput())).toEqual({
      ok: false,
      error: 'db_error',
    })
  })
})

describe('resolveStructuredHandoff', () => {
  test('id·status 검증', async () => {
    const env = asD1(new HandoffD1())
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(await resolveStructuredHandoff(env, bad, 'accepted')).toEqual({
        ok: false,
        error: 'id 필요',
      })
    }
    expect(
      await resolveStructuredHandoff(env, 1, 'pending' as never),
    ).toEqual({ ok: false, error: 'status 값 오류' })
    expect(await resolveStructuredHandoff(env, 1, 'bogus' as never)).toEqual({
      ok: false,
      error: 'status 값 오류',
    })
  })

  test('pending만 전이: 성공 후 재해결·없는 id는 not_pending_or_not_found', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const { id } = await createStructuredHandoff(env, baseInput())
    expect(await resolveStructuredHandoff(env, 999, 'accepted')).toEqual({
      ok: false,
      error: 'not_pending_or_not_found',
    })
    expect(await resolveStructuredHandoff(env, id!, 'accepted')).toEqual({ ok: true })
    expect(db.tables.agent_handoffs[0].status).toBe('accepted')
    expect(db.tables.agent_handoffs[0].resolved_at).toBeTruthy()
    // 이미 해결됨 — 다시 바꾸지 않음 (원자적 가드)
    expect(await resolveStructuredHandoff(env, id!, 'completed')).toEqual({
      ok: false,
      error: 'not_pending_or_not_found',
    })
    expect(db.tables.agent_handoffs[0].status).toBe('accepted')
  })

  test('completed·rejected 전이', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const a = await createStructuredHandoff(env, baseInput())
    const b = await createStructuredHandoff(env, baseInput({ request: '두번째 요청' }))
    expect(await resolveStructuredHandoff(env, a.id!, 'completed')).toEqual({ ok: true })
    expect(await resolveStructuredHandoff(env, b.id!, 'rejected')).toEqual({ ok: true })
    expect(db.tables.agent_handoffs.map((r) => r.status)).toEqual(['completed', 'rejected'])
  })

  test('DB 오류 시 db_error (UPDATE 실패)', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const { id } = await createStructuredHandoff(env, baseInput())
    db.failOnPrefix = 'UPDATE agent_handoffs SET status'
    expect(await resolveStructuredHandoff(env, id!, 'accepted')).toEqual({
      ok: false,
      error: 'db_error',
    })
  })
})

describe('getStructuredHandoff', () => {
  test('id 검증·없는 핸드오프', async () => {
    const env = asD1(new HandoffD1())
    expect(await getStructuredHandoff(env, 0)).toEqual({ ok: false, error: 'id 필요' })
    expect(await getStructuredHandoff(env, 7)).toEqual({
      ok: false,
      error: 'handoff_not_found',
    })
  })

  test('저장된 핸드오프 조회: 필드 매핑·run/memory 연결·해결 상태', async () => {
    const db = new HandoffD1()
    db.seedRun('run_9')
    db.seedMemoryHandoff(5)
    const env = asD1(db)
    const { id } = await createStructuredHandoff(
      env,
      baseInput({ runId: 'run_9', memoryHandoffId: 5 }),
    )
    const got = await getStructuredHandoff(env, id!)
    expect(got.ok).toBe(true)
    expect(got.handoff).toMatchObject({
      id: id!,
      runId: 'run_9',
      memoryHandoffId: 5,
      fromPersona: 'keeper',
      toPersona: 'scheduler',
      request: '내일 일정 알려줘',
      context: ['메모 요약 결과'],
      constraints: ['잠긴 메모 제외'],
      expectedOutput: '내일 일정 목록',
      status: 'pending',
      resolvedAt: null,
    })
    expect(got.handoff!.createdAt).toBeTruthy()
    await resolveStructuredHandoff(env, id!, 'completed')
    const after = await getStructuredHandoff(env, id!)
    expect(after.handoff!.status).toBe('completed')
    expect(after.handoff!.resolvedAt).toBeTruthy()
  })

  test('연결 없는 핸드오프는 runId·memoryHandoffId undefined', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const { id } = await createStructuredHandoff(env, baseInput())
    const got = await getStructuredHandoff(env, id!)
    expect(got.handoff!.runId).toBeUndefined()
    expect(got.handoff!.memoryHandoffId).toBeUndefined()
  })

  test('깨진 JSON은 기본값 [] 유지 (비배열 JSON도 마찬가지)', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const { id } = await createStructuredHandoff(env, baseInput())
    const row = db.tables.agent_handoffs[0]
    row.context_json = '{깨진 json'
    row.constraints_json = '"배열이 아님"'
    const got = await getStructuredHandoff(env, id!)
    expect(got.ok).toBe(true)
    expect(got.handoff!.context).toEqual([])
    expect(got.handoff!.constraints).toEqual([])
  })

  test('JSON 필드·expected_output이 비어 있으면 || 폴백으로 기본값', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const { id } = await createStructuredHandoff(env, baseInput())
    const row = db.tables.agent_handoffs[0]
    row.context_json = null
    row.constraints_json = ''
    row.expected_output = ''
    const got = await getStructuredHandoff(env, id!)
    expect(got.ok).toBe(true)
    expect(got.handoff!.context).toEqual([])
    expect(got.handoff!.constraints).toEqual([])
    expect(got.handoff!.expectedOutput).toBe('')
  })

  test('context가 유효한 비배열 JSON이면 기본값 유지', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const { id } = await createStructuredHandoff(env, baseInput())
    db.tables.agent_handoffs[0].context_json = '"문자열"'
    const got = await getStructuredHandoff(env, id!)
    expect(got.handoff!.context).toEqual([])
    expect(got.handoff!.constraints).toEqual(['잠긴 메모 제외'])
  })

  test('DB 오류 시 db_error (SELECT 실패)', async () => {
    const db = new HandoffD1()
    const env = asD1(db)
    const { id } = await createStructuredHandoff(env, baseInput())
    db.failOnPrefix = 'SELECT * FROM agent_handoffs WHERE id = ?'
    expect(await getStructuredHandoff(env, id!)).toEqual({
      ok: false,
      error: 'db_error',
    })
  })
})

describe('listRunHandoffs', () => {
  test('run_id 누락', async () => {
    const env = asD1(new HandoffD1())
    expect(await listRunHandoffs(env, '')).toEqual({ ok: false, error: 'run_id 필요' })
    expect(await listRunHandoffs(env, '   ')).toEqual({ ok: false, error: 'run_id 필요' })
  })

  test('연결된 핸드오프를 id 오름차순으로 반환 (없는 run은 빈 목록)', async () => {
    const db = new HandoffD1()
    db.seedRun('run_a')
    db.seedRun('run_b')
    const env = asD1(db)
    await createStructuredHandoff(env, baseInput({ runId: 'run_a', request: '첫번째' }))
    await createStructuredHandoff(env, baseInput({ runId: 'run_b', request: '다른 run' }))
    await createStructuredHandoff(env, baseInput({ runId: 'run_a', request: '두번째' }))
    await createStructuredHandoff(env, baseInput({ request: '독립 핸드오프' }))

    const listed = await listRunHandoffs(env, 'run_a')
    expect(listed.ok).toBe(true)
    expect(listed.handoffs!.map((h) => h.request)).toEqual(['첫번째', '두번째'])
    expect(listed.handoffs!.map((h) => h.id)).toEqual([1, 3])
    expect(listed.handoffs![0]).toMatchObject({
      runId: 'run_a',
      status: 'pending',
      context: ['메모 요약 결과'],
    })
    expect(await listRunHandoffs(env, 'run_없는')).toEqual({ ok: true, handoffs: [] })
  })

  test('깨진 JSON 행도 기본값으로 반환', async () => {
    const db = new HandoffD1()
    db.seedRun('run_a')
    const env = asD1(db)
    await createStructuredHandoff(env, baseInput({ runId: 'run_a' }))
    db.tables.agent_handoffs[0].context_json = 'not json'
    db.tables.agent_handoffs[0].constraints_json = '123'
    const listed = await listRunHandoffs(env, 'run_a')
    expect(listed.handoffs![0].context).toEqual([])
    expect(listed.handoffs![0].constraints).toEqual([])
  })

  test('JSON 필드·expected_output이 비어 있는 행도 폴백으로 반환', async () => {
    const db = new HandoffD1()
    db.seedRun('run_a')
    const env = asD1(db)
    await createStructuredHandoff(env, baseInput({ runId: 'run_a' }))
    await createStructuredHandoff(env, baseInput({ runId: 'run_a', request: '두번째' }))
    db.tables.agent_handoffs[0].context_json = null
    db.tables.agent_handoffs[0].constraints_json = ''
    db.tables.agent_handoffs[0].expected_output = ''
    db.tables.agent_handoffs[1].context_json = '"문자열"'
    const listed = await listRunHandoffs(env, 'run_a')
    expect(listed.handoffs![0].context).toEqual([])
    expect(listed.handoffs![0].constraints).toEqual([])
    expect(listed.handoffs![0].expectedOutput).toBe('')
    expect(listed.handoffs![1].context).toEqual([])
  })

  test('results가 null이면 빈 목록 반환', async () => {
    const db = new HandoffD1()
    db.seedRun('run_a')
    const env = asD1(db)
    await createStructuredHandoff(env, baseInput({ runId: 'run_a' }))
    db.nullListResults = true
    expect(await listRunHandoffs(env, 'run_a')).toEqual({ ok: true, handoffs: [] })
  })

  test('DB 오류 시 db_error', async () => {
    const db = new HandoffD1()
    db.seedRun('run_a')
    const env = asD1(db)
    await createStructuredHandoff(env, baseInput({ runId: 'run_a' }))
    db.failOnPrefix = 'SELECT * FROM agent_handoffs WHERE run_id = ?'
    expect(await listRunHandoffs(env, 'run_a')).toEqual({
      ok: false,
      error: 'db_error',
    })
  })
})
