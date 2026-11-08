/// <reference types="jest" />
/**
 * memory-reflection.ts 커버리지 보강 (그룹 A) — reflectOnTask 종단
 * - 빈 입력 / v2 게이트 OFF·행 없음
 * - 결정적 추출 저장 (source_type=reflection, 동의 게이트 0, sourceId 전달)
 * - near-duplicate 스킵, 엔티티 연결
 * - LLM 성찰: 플래그 ON 사용·OFF 미호출·실패 폴백·단문 필터·10개 절단
 * - 사실 0개 → reflected:true, 빈 결과
 * - maxFacts 클램프 (100 → 10, 1 → 1, 0 → 기본 5)
 * - captureFacts DB 오류 (기존 목록 조회 실패 / 개별 INSERT 실패)
 *
 * 프로덕션 코드 수정 없음. MockD1은 reflectOnTask → captureFacts →
 * linkFactGraph가 실제로 발행하는 SQL만 처리한다.
 */
import { reflectOnTask } from '../../src/services/memory-reflection'

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

interface MemRow {
  id: number
  content: string
  category: string
  created_by: string
  source_type: string | null
  source_id: number | null
  allow_ai_use: number
  allow_provider_send: number
  summary: string | null
  entities: string | null
  access_count: number
  last_accessed_at: string | null
  updated_at: string
  contradiction_flag: number
  is_active: number
}

class MockD1 {
  settings = new Map<string, string>()
  memories: MemRow[] = []
  entities: Array<{ id: number; name: string; normalized: string }> = []
  factEntities: Array<{ fact_id: number; entity_id: number }> = []
  relations: Array<{ source_entity_id: number; target_entity_id: number; fact_id: number }> = []
  seq = { mem: 0, entity: 0 }
  failOn: Array<{ match: string; when?: (args: any[]) => boolean }> = []

  addMemory(over: Partial<MemRow> & { content: string }): MemRow {
    const row: MemRow = {
      id: ++this.seq.mem,
      category: 'fact',
      created_by: 'assistant',
      source_type: null,
      source_id: null,
      allow_ai_use: 0,
      allow_provider_send: 0,
      summary: null,
      entities: null,
      access_count: 0,
      last_accessed_at: null,
      updated_at: new Date().toISOString(),
      contradiction_flag: 0,
      is_active: 1,
      ...over,
    }
    this.memories.push(row)
    return row
  }

  prepare(sql: string) {
    const q = norm(sql)
    const self = this
    const stmt: any = {
      _sql: q,
      _params: [] as any[],
      bind(...p: any[]) {
        stmt._params = p
        return stmt
      },
      async first() {
        return self.first(q, stmt._params)
      },
      async all() {
        return { results: self.all(q, stmt._params) }
      },
      async run() {
        return { success: true, meta: self.run(q, stmt._params) }
      },
    }
    return stmt
  }

  async batch(statements: any[]) {
    return statements.map((s) => ({ meta: this.run(s._sql, s._params || []) }))
  }

  private failIf(q: string, args: any[]) {
    for (const f of this.failOn) {
      if (q.includes(f.match) && (!f.when || f.when(args))) {
        throw new Error(`mock db fail: ${f.match}`)
      }
    }
  }

  private first(q: string, args: any[]) {
    this.failIf(q, args)
    return this.all(q, args)[0] ?? null
  }

  private all(q: string, args: any[]): any[] {
    this.failIf(q, args)
    if (q.startsWith('SELECT value FROM ai_settings')) {
      const key = q.match(/key = '([^']+)'/)?.[1] || ''
      return this.settings.has(key) ? [{ value: this.settings.get(key) }] : []
    }
    if (q.startsWith('SELECT content FROM ai_memory_v2')) {
      return this.memories
        .filter((r) => r.is_active === 1)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, 200)
        .map((r) => ({ content: r.content }))
    }
    if (q.startsWith('SELECT id FROM memory_entities')) {
      const row = this.entities.find((e) => e.normalized === args[0])
      return row ? [{ id: row.id }] : []
    }
    return []
  }

  private run(q: string, args: any[]): Record<string, any> {
    this.failIf(q, args)
    if (q.startsWith('INSERT INTO ai_memory_v2')) {
      const id = ++this.seq.mem
      this.memories.push({
        id,
        content: args[0],
        category: 'fact',
        created_by: args[1],
        source_type: args[2],
        source_id: args[3],
        allow_ai_use: 0,
        allow_provider_send: 0,
        summary: null,
        entities: null,
        access_count: 0,
        last_accessed_at: null,
        updated_at: args[5],
        contradiction_flag: 0,
        is_active: 1,
      })
      return { last_row_id: id, changes: 1 }
    }
    if (q.startsWith('INSERT OR IGNORE INTO memory_entities')) {
      const normalized = args[1]
      if (this.entities.some((e) => e.normalized === normalized)) return { changes: 0 }
      this.entities.push({ id: ++this.seq.entity, name: args[0], normalized })
      return { changes: 1 }
    }
    if (q.startsWith('INSERT OR IGNORE INTO memory_fact_entities')) {
      if (!this.factEntities.some((f) => f.fact_id === args[0] && f.entity_id === args[1])) {
        this.factEntities.push({ fact_id: args[0], entity_id: args[1] })
      }
      return { changes: 1 }
    }
    if (q.startsWith('INSERT OR IGNORE INTO memory_relations')) {
      if (
        !this.relations.some(
          (r) => r.source_entity_id === args[0] && r.target_entity_id === args[1] && r.fact_id === args[2]
        )
      ) {
        this.relations.push({ source_entity_id: args[0], target_entity_id: args[1], fact_id: args[2] })
      }
      return { changes: 1 }
    }
    return { changes: 0 }
  }
}

function makeEnv() {
  const db = new MockD1()
  db.settings.set('memory.v2_enabled', 'true')
  return { db, env: { DB: db as any } }
}

const WEEKLY_MEETING = {
  taskType: 'memo_create',
  taskText: '매주 월요일 10시에 팀 회의가 있어. 메모해줘.',
  resultText: '메모를 생성했어.',
}

describe('reflectOnTask — 게이트·빈 입력', () => {
  test('빈 입력 — 저장하지 않고 reflected=false', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, { taskType: 'chat', taskText: '', resultText: '' })
    expect(r).toMatchObject({ ok: true, reflected: false, extraction: 'deterministic' })
    expect(r.created).toEqual([])
    expect(db.memories).toHaveLength(0)
  })

  test('v2 플래그 OFF — 저장하지 않고 reflected=false', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.v2_enabled', 'false')
    const r = await reflectOnTask(env, WEEKLY_MEETING)
    expect(r.reflected).toBe(false)
    expect(db.memories).toHaveLength(0)
  })

  test('v2 플래그 행 없음 — 저장하지 않고 reflected=false', async () => {
    const { db, env } = makeEnv()
    db.settings.delete('memory.v2_enabled')
    const r = await reflectOnTask(env, WEEKLY_MEETING)
    expect(r.reflected).toBe(false)
    expect(db.memories).toHaveLength(0)
  })

  test('사실이 추출되지 않는 입력 — reflected=true, 빈 결과', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, { taskType: 'chat', taskText: '?' })
    expect(r).toMatchObject({ ok: true, reflected: true, extraction: 'deterministic' })
    expect(r.created).toEqual([])
    expect(r.skipped).toEqual([])
    expect(db.memories).toHaveLength(0)
  })
})

describe('reflectOnTask — 결정적 추출 저장', () => {
  test('요청+결과 문장이 source_type=reflection, 동의 게이트 0으로 저장된다', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, WEEKLY_MEETING)
    expect(r.ok).toBe(true)
    expect(r.reflected).toBe(true)
    expect(r.extraction).toBe('deterministic')
    // taskText는 두 문장('...있어.' + '메모해줘.')이라 사실 3개가 추출된다
    // (점수순: 시간 포함 문장 → 결과 문장 → '메모해줘.')
    expect(r.created).toHaveLength(3)
    expect(r.created.map((c) => c.content)).toEqual([
      '요청 [memo_create]: 매주 월요일 10시에 팀 회의가 있어.',
      '결과 [memo_create]: 메모를 생성했어.',
      '메모해줘.',
    ])
    expect(db.memories).toHaveLength(3)
    for (const row of db.memories) {
      expect(row.source_type).toBe('reflection')
      expect(row.category).toBe('fact')
      expect(row.created_by).toBe('assistant')
      expect(row.allow_ai_use).toBe(0)
      expect(row.allow_provider_send).toBe(0)
    }
  })

  test('sourceId가 저장 행에 전달된다', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, { ...WEEKLY_MEETING, sourceId: 42 })
    expect(r.ok).toBe(true)
    expect(db.memories.every((row) => row.source_id === 42)).toBe(true)
  })

  test('near-duplicate 재성찰 — 이미 있는 사실은 skipped, 나머지만 저장', async () => {
    const { db, env } = makeEnv()
    db.addMemory({ content: '요청 [memo_create]: 매주 월요일 10시에 팀 회의가 있어.' })
    const r = await reflectOnTask(env, WEEKLY_MEETING)
    expect(r.reflected).toBe(true)
    expect(r.created).toHaveLength(2)
    expect(r.created.map((c) => c.content)).toEqual([
      '결과 [memo_create]: 메모를 생성했어.',
      '메모해줘.',
    ])
    expect(r.skipped).toEqual(['요청 [memo_create]: 매주 월요일 10시에 팀 회의가 있어.'])
    expect(db.memories).toHaveLength(3)
  })

  test('인용 엔티티가 그래프에 연결된다', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, {
      taskType: 'chat',
      taskText: '사용자는 "MyHub" 서비스를 매일 사용한다.',
      resultText: '알겠어.',
    })
    expect(r.ok).toBe(true)
    expect(r.entities).toContain('MyHub')
    expect(db.entities.map((e) => e.name)).toContain('MyHub')
    expect(db.factEntities.length).toBeGreaterThan(0)
  })
})

describe('reflectOnTask — LLM 성찰', () => {
  test('플래그 ON — llmReflect 결과를 저장하고 extraction=llm', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_reflection_enabled', 'true')
    const r = await reflectOnTask(env, {
      ...WEEKLY_MEETING,
      llmReflect: async () => [
        '사용자는 월요일 오전 회의를 선호한다.',
        '사용자는 저녁 운동을 좋아한다.',
      ],
    })
    expect(r.extraction).toBe('llm')
    expect(r.created).toHaveLength(2)
    expect(r.created.map((c) => c.content)).toEqual([
      '사용자는 월요일 오전 회의를 선호한다.',
      '사용자는 저녁 운동을 좋아한다.',
    ])
    expect(db.memories.map((m) => m.content)).toEqual([
      '사용자는 월요일 오전 회의를 선호한다.',
      '사용자는 저녁 운동을 좋아한다.',
    ])
  })

  test('플래그 OFF — llmReflect를 호출하지 않고 결정적 추출 사용', async () => {
    const { db, env } = makeEnv()
    let called = 0
    const r = await reflectOnTask(env, {
      ...WEEKLY_MEETING,
      llmReflect: async () => {
        called++
        return ['LLM이 만든 사실입니다.']
      },
    })
    expect(called).toBe(0)
    expect(r.extraction).toBe('deterministic')
    expect(r.created.map((c) => c.content)).not.toContain('LLM이 만든 사실입니다.')
  })

  test('LLM 성찰 실패 — 결정적 추출로 폴백', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_reflection_enabled', 'true')
    const r = await reflectOnTask(env, {
      ...WEEKLY_MEETING,
      llmReflect: async () => {
        throw new Error('llm boom')
      },
    })
    expect(r.ok).toBe(true)
    expect(r.extraction).toBe('deterministic')
    expect(r.created.length).toBeGreaterThan(0)
  })

  test('LLM 결과가 모두 5글자 미만 — 결정적 추출 유지', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_reflection_enabled', 'true')
    const r = await reflectOnTask(env, {
      ...WEEKLY_MEETING,
      llmReflect: async () => ['짧다', 'ab', '  '],
    })
    expect(r.extraction).toBe('deterministic')
    expect(r.created).toHaveLength(3)
    expect(r.created[0].content).toContain('매주 월요일 10시')
  })

  test('LLM 결과가 10개 초과 — 10개로 절단', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_reflection_enabled', 'true')
    const facts = Array.from(
      { length: 12 },
      (_, i) => `LLM이 배운 ${i + 1}번째 사실 문장이다.`
    )
    const r = await reflectOnTask(env, {
      ...WEEKLY_MEETING,
      llmReflect: async () => facts,
    })
    expect(r.extraction).toBe('llm')
    expect(r.created).toHaveLength(10)
    expect(db.memories).toHaveLength(10)
  })

  test('LLM 결과가 빈 배열 — 결정적 추출 유지', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_reflection_enabled', 'true')
    const r = await reflectOnTask(env, {
      ...WEEKLY_MEETING,
      llmReflect: async () => [],
    })
    expect(r.extraction).toBe('deterministic')
    expect(r.created).toHaveLength(3)
  })
})

describe('reflectOnTask — maxFacts 클램프', () => {
  const ordinals = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한', '열두']
  const manyFactsInput = {
    taskType: 'chat',
    taskText: ordinals.map((o) => `${o} 번째로 매주 월요일 10시에 회의가 있어.`).join(' '),
  }

  test('maxFacts 100 → 10개까지만 추출·저장', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, { ...manyFactsInput, maxFacts: 100 })
    expect(r.created).toHaveLength(10)
    expect(db.memories).toHaveLength(10)
  })

  test('maxFacts 1 → 1개만 저장', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, { ...manyFactsInput, maxFacts: 1 })
    expect(r.created).toHaveLength(1)
    expect(r.created[0].content).toContain('첫 번째로')
  })

  test('maxFacts 0 → 기본 5개 저장', async () => {
    const { db, env } = makeEnv()
    const r = await reflectOnTask(env, { ...manyFactsInput, maxFacts: 0 })
    expect(r.created).toHaveLength(5)
  })
})

describe('reflectOnTask — captureFacts DB 오류', () => {
  test('기존 사실 목록 조회 실패 — ok:false, error db_error', async () => {
    const { db, env } = makeEnv()
    db.failOn.push({ match: 'SELECT content FROM ai_memory_v2' })
    const r = await reflectOnTask(env, WEEKLY_MEETING)
    expect(r).toMatchObject({ ok: false, reflected: true, error: 'db_error' })
    // captureFacts가 { ok:false, error }만 반환하므로 created 필드 자체가 없다
    expect(r.created).toBeUndefined()
  })

  test('개별 INSERT 실패 — 해당 사실만 skipped, 나머지는 저장', async () => {
    const { db, env } = makeEnv()
    db.failOn.push({
      match: 'INSERT INTO ai_memory_v2',
      when: (args) => args[0] === '결과 [memo_create]: 메모를 생성했어.',
    })
    const r = await reflectOnTask(env, WEEKLY_MEETING)
    expect(r.ok).toBe(true)
    expect(r.created).toHaveLength(2)
    expect(r.created[0].content).toContain('매주 월요일 10시')
    expect(r.skipped).toEqual(['결과 [memo_create]: 메모를 생성했어.'])
    expect(db.memories).toHaveLength(2)
  })
})
