/// <reference types="jest" />
/**
 * memory-consolidation.ts 커버리지 보강 (그룹 A)
 * - isLlmConsolidationEnabled / getLastConsolidationDate / markConsolidationRun:
 *   ON·OFF·행 없음·조회/기록 실패
 * - runSleepConsolidation 종단 (인메모리 MockD1):
 *   v2 게이트, 스캔 조회 실패, batchLimit 클램프, 중복 병합 성공/실패,
 *   모순 쌍 스킵·플래그 실패, 요약(LLM 사용·단문 무시·200자 절단·실패 폴백·
 *   빈 요약·공백 요약·changes 0·UPDATE 실패), 감사 로그 실패 무시, run 행 기록
 *
 * 프로덕션 코드 수정 없음. MockD1은 이 파일의 서비스가 실제로 발행하는
 * SQL만 처리한다 (ai_settings / ai_memory_v2 / memory_consolidation_log).
 */
import {
  getLastConsolidationDate,
  isLlmConsolidationEnabled,
  markConsolidationRun,
  runSleepConsolidation,
} from '../../src/services/memory-consolidation'

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

interface MemRow {
  id: number
  content: string
  summary: string | null
  entities: string | null
  access_count: number
  last_accessed_at: string | null
  updated_at: string
  contradiction_flag: number
  is_active: number
  superseded_by: number | null
  supersedes: number | null
}

interface LogRow {
  run_id: string
  action: string
  memory_id: number | null
  related_memory_id: number | null
  detail: string
}

class MockD1 {
  settings = new Map<string, string>()
  memories: MemRow[] = []
  logs: LogRow[] = []
  seq = 0
  failOn: Array<{ match: string; when?: (args: any[]) => boolean }> = []
  changesZeroSummaryIds = new Set<number>()
  lastSelectLimit: number | null = null

  addMemory(over: Partial<MemRow> & { content: string }): MemRow {
    const row: MemRow = {
      id: ++this.seq,
      summary: null,
      entities: null,
      access_count: 0,
      last_accessed_at: null,
      updated_at: new Date().toISOString(),
      contradiction_flag: 0,
      is_active: 1,
      superseded_by: null,
      supersedes: null,
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
    const results = []
    for (const s of statements) {
      results.push({ meta: this.run(s._sql, s._params || []) })
    }
    return results
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
      // S2-5 수렴: 설정 조회는 바인드 파라미터(getSetting) — 키는 args[0]에서 읽는다.
      const key = q.includes('key = ?') ? String(args[0] ?? '') : q.match(/key = '([^']+)'/)?.[1] || ''
      return this.settings.has(key) ? [{ value: this.settings.get(key) }] : []
    }
    if (q.startsWith('SELECT id, content, summary')) {
      this.lastSelectLimit = args[0]
      return this.memories
        .filter((r) => r.is_active === 1)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, args[0])
        .map((r) => ({
          id: r.id,
          content: r.content,
          summary: r.summary,
          entities: r.entities,
          access_count: r.access_count,
          last_accessed_at: r.last_accessed_at,
          updated_at: r.updated_at,
          contradiction_flag: r.contradiction_flag,
        }))
    }
    return []
  }

  private run(q: string, args: any[]): Record<string, any> {
    this.failIf(q, args)
    if (q.startsWith('INSERT OR REPLACE INTO ai_settings')) {
      // markConsolidationRun: key는 SQL 리터럴, value는 bind 인자
      this.settings.set('memory.last_consolidation_date', args[0])
      return { changes: 1 }
    }
    if (q.startsWith('INSERT INTO memory_consolidation_log')) {
      this.logs.push({
        run_id: args[0],
        action: args[1],
        memory_id: args[2],
        related_memory_id: args[3],
        detail: args[4],
      })
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE ai_memory_v2 SET is_active = 0')) {
      const row = this.memories.find((r) => r.id === args[2])
      if (!row || row.is_active !== 1) return { changes: 0 }
      row.is_active = 0
      row.superseded_by = args[0]
      row.updated_at = args[1]
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE ai_memory_v2 SET supersedes')) {
      const row = this.memories.find((r) => r.id === args[2])
      if (!row || row.is_active !== 1) return { changes: 0 }
      row.supersedes = args[0]
      row.updated_at = args[1]
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE ai_memory_v2 SET contradiction_flag')) {
      const row = this.memories.find((r) => r.id === args[1])
      if (!row) return { changes: 0 }
      row.contradiction_flag = args[0]
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE ai_memory_v2 SET summary')) {
      const row = this.memories.find((r) => r.id === args[1])
      if (!row) return { changes: 0 }
      // 프로덕션 WHERE (summary IS NULL OR TRIM(summary) = '')와 동일 판정:
      // 공백만 있는 summary도 비어 있음으로 보고 채운다.
      if (row.summary !== null && row.summary.trim() !== '') return { changes: 0 }
      if (this.changesZeroSummaryIds.has(row.id)) return { changes: 0 }
      row.summary = args[0]
      return { changes: 1 }
    }
    return { changes: 0 }
  }
}

function oldDate(): string {
  return new Date(Date.now() - 100 * 86400000).toISOString() // 100일 전 → archived
}

function makeEnv() {
  const db = new MockD1()
  db.settings.set('memory.v2_enabled', 'true')
  return { db, env: { DB: db as any } }
}

describe('isLlmConsolidationEnabled', () => {
  test("'true' → true", async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_consolidation_enabled', 'true')
    expect(await isLlmConsolidationEnabled(env)).toBe(true)
  })
  test("'false' → false", async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_consolidation_enabled', 'false')
    expect(await isLlmConsolidationEnabled(env)).toBe(false)
  })
  test('행 없음 → false (기본 OFF)', async () => {
    const { env } = makeEnv()
    expect(await isLlmConsolidationEnabled(env)).toBe(false)
  })
  test('조회 실패 → false', async () => {
    const { db, env } = makeEnv()
    db.failOn.push({ match: 'SELECT value FROM ai_settings', when: (args) => args[0] === 'memory.llm_consolidation_enabled' })
    expect(await isLlmConsolidationEnabled(env)).toBe(false)
  })
})

describe('getLastConsolidationDate / markConsolidationRun', () => {
  test('마커가 있으면 날짜 반환', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.last_consolidation_date', '2026-10-26')
    expect(await getLastConsolidationDate(env)).toBe('2026-10-26')
  })
  test('마커 없음 → null', async () => {
    const { env } = makeEnv()
    expect(await getLastConsolidationDate(env)).toBeNull()
  })
  test('조회 실패 → null', async () => {
    const { db, env } = makeEnv()
    db.failOn.push({ match: 'SELECT value FROM ai_settings', when: (args) => args[0] === 'memory.last_consolidation_date' })
    expect(await getLastConsolidationDate(env)).toBeNull()
  })
  test('markConsolidationRun — 마커 기록', async () => {
    const { db, env } = makeEnv()
    await markConsolidationRun(env, '2026-10-26')
    expect(db.settings.get('memory.last_consolidation_date')).toBe('2026-10-26')
  })
  test('markConsolidationRun — 기록 실패해도 예외 없음', async () => {
    const { db, env } = makeEnv()
    db.failOn.push({ match: 'INSERT OR REPLACE INTO ai_settings' })
    await expect(markConsolidationRun(env, '2026-10-26')).resolves.toBeUndefined()
    expect(db.settings.has('memory.last_consolidation_date')).toBe(false)
  })
})

describe('runSleepConsolidation — 게이트·조회', () => {
  test('v2 플래그 OFF — 실행하지 않음', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.v2_enabled', 'false')
    db.addMemory({ content: 'Hello World' })
    const stats = await runSleepConsolidation(env)
    expect(stats).toMatchObject({ ok: true, ran: false, reason: 'disabled' })
    expect(db.logs).toHaveLength(0)
  })

  test('v2 플래그 행 없음 — 실행하지 않음', async () => {
    const { db, env } = makeEnv()
    db.settings.delete('memory.v2_enabled')
    const stats = await runSleepConsolidation(env)
    expect(stats.ran).toBe(false)
    expect(stats.reason).toBe('disabled')
  })

  test('스캔 조회 실패 — ok:false, error db_error', async () => {
    const { db, env } = makeEnv()
    db.failOn.push({ match: 'SELECT id, content, summary' })
    const stats = await runSleepConsolidation(env)
    expect(stats).toMatchObject({ ok: false, ran: false, error: 'db_error' })
  })

  test('batchLimit 클램프 — 5000 → 1000, 음수 → 1, 0 → 기본 500', async () => {
    const { db, env } = makeEnv()
    db.addMemory({ content: '기억 하나다.' })
    await runSleepConsolidation(env, { batchLimit: 5000 })
    expect(db.lastSelectLimit).toBe(1000)
    await runSleepConsolidation(env, { batchLimit: -3 })
    expect(db.lastSelectLimit).toBe(1)
    await runSleepConsolidation(env, { batchLimit: 0 })
    expect(db.lastSelectLimit).toBe(500)
  })

  test('batchLimit 2 — 2개까지만 스캔 (run 행 scanned=2)', async () => {
    const { db, env } = makeEnv()
    db.addMemory({ content: '첫 번째 기억이다.' })
    db.addMemory({ content: '두 번째 기억이다.' })
    db.addMemory({ content: '세 번째 기억이다.' })
    const stats = await runSleepConsolidation(env, { batchLimit: 2 })
    expect(stats.ok).toBe(true)
    const runLog = db.logs.find((l) => l.action === 'run')
    expect(runLog).toBeTruthy()
    expect(JSON.parse(runLog!.detail).scanned).toBe(2)
  })
})

describe('runSleepConsolidation — 중복 병합', () => {
  test('병합 실패(supersede DB 오류) — skipped 증가, 행은 활성 유지', async () => {
    const { db, env } = makeEnv()
    const id1 = db.addMemory({ content: 'Hello World', updated_at: '2026-10-20T00:00:00.000Z' }).id
    db.addMemory({ content: 'hello world!', updated_at: '2026-10-25T00:00:00.000Z' })
    db.failOn.push({ match: 'UPDATE ai_memory_v2 SET is_active = 0' })
    const stats = await runSleepConsolidation(env)
    expect(stats.merged).toBe(0)
    expect(stats.skipped).toBe(1)
    expect(db.memories.find((r) => r.id === id1)!.is_active).toBe(1)
    expect(db.logs.filter((l) => l.action === 'merge')).toHaveLength(0)
  })

  test('대체된 기억은 요약 단계에서 제외된다', async () => {
    const { db, env } = makeEnv()
    // 비생존자(id1)는 오래됐고 요약이 없어도 병합 후 요약 대상이 되면 안 됨
    const id1 = db.addMemory({
      content: '오래된 중복 기억이다. 두 번째 문장이다.',
      updated_at: oldDate(),
    }).id
    db.addMemory({ content: '오래된 중복 기억이다. 두 번째 문장이다.' })
    const stats = await runSleepConsolidation(env)
    expect(stats.merged).toBe(1)
    expect(stats.summarized).toBe(0)
    expect(db.memories.find((r) => r.id === id1)!.summary).toBeNull()
  })
})

describe('runSleepConsolidation — 모순 표시', () => {
  const pair = (db: MockD1) => {
    db.addMemory({ content: '팀 회의는 매주 월요일 10시에 열린다.' })
    db.addMemory({ content: '팀 회의 시간이 10시에서 11시로 변경됐다.' })
  }

  test('양쪽 모두 이미 플래그됨 — 건너뜀 (contradictions 0)', async () => {
    const { db, env } = makeEnv()
    pair(db)
    for (const r of db.memories) r.contradiction_flag = 1
    const stats = await runSleepConsolidation(env)
    expect(stats.contradictions).toBe(0)
    expect(db.logs.filter((l) => l.action === 'contradiction')).toHaveLength(0)
  })

  test('한쪽 플래그만 있음 — 반대쪽까지 플래그하고 1건으로 집계', async () => {
    const { db, env } = makeEnv()
    pair(db)
    db.memories[0].contradiction_flag = 1
    const stats = await runSleepConsolidation(env)
    expect(stats.contradictions).toBe(1)
    expect(db.memories.every((r) => r.contradiction_flag === 1)).toBe(true)
  })

  test('markContradiction 실패 — skipped 증가, 성공한 쪽만 플래그', async () => {
    const { db, env } = makeEnv()
    pair(db)
    const bId = db.memories[1].id
    db.failOn.push({
      match: 'UPDATE ai_memory_v2 SET contradiction_flag',
      when: (args) => args[1] === bId,
    })
    const stats = await runSleepConsolidation(env)
    expect(stats.contradictions).toBe(0)
    expect(stats.skipped).toBe(1)
    expect(db.memories[0].contradiction_flag).toBe(1)
    expect(db.memories[1].contradiction_flag).toBe(0)
    expect(db.logs.filter((l) => l.action === 'contradiction')).toHaveLength(0)
  })
})

describe('runSleepConsolidation — 오래된 기억 요약', () => {
  test('공백 요약("   ")은 채워진다 — WHERE가 TRIM(summary) = \'\'로 판정해 가드와 일치', async () => {
    // 결함 1 수정: JS 가드(`summary.trim()`)는 공백을 비어 있음으로 보는데
    // 구 SQL WHERE(summary IS NULL OR summary='')는 공백 행에 안 맞아
    // 매 실행마다 요약 시도를 하고 changes 0으로 조용히 넘어갔다.
    // TRIM 조건으로 가드와 WHERE의 "비어 있음" 판정을 일치시켰다.
    const { db, env } = makeEnv()
    const row = db.addMemory({
      content: '오래된 기억이다. 두 번째 문장이다.',
      updated_at: oldDate(),
      summary: '   ',
    })
    const stats = await runSleepConsolidation(env)
    expect(stats.summarized).toBe(1)
    expect(stats.skipped).toBe(0)
    expect(db.memories.find((r) => r.id === row.id)!.summary).toBe('오래된 기억이다.')
    expect(db.logs.filter((l) => l.action === 'summarize')).toHaveLength(1)
  })

  test('공백 요약 채운 뒤 두 번째 실행은 재시도하지 않는다', async () => {
    const { db, env } = makeEnv()
    db.addMemory({
      content: '오래된 기억이다. 두 번째 문장이다.',
      updated_at: oldDate(),
      summary: '   ',
    })
    await runSleepConsolidation(env)
    const stats2 = await runSleepConsolidation(env)
    expect(stats2.summarized).toBe(0)
    expect(stats2.skipped).toBe(0)
  })

  test('내용이 빈 기억 — extractCoreFact이 빈 문자열이면 skipped', async () => {
    const { db, env } = makeEnv()
    db.addMemory({ content: '', updated_at: oldDate() })
    const stats = await runSleepConsolidation(env)
    expect(stats.summarized).toBe(0)
    expect(stats.skipped).toBe(1)
  })

  test('요약 UPDATE가 changes 0 — summarized·skipped 모두 증가하지 않음', async () => {
    const { db, env } = makeEnv()
    const row = db.addMemory({
      content: '오래된 기억이다. 두 번째 문장이다.',
      updated_at: oldDate(),
    })
    db.changesZeroSummaryIds.add(row.id)
    const stats = await runSleepConsolidation(env)
    expect(stats.summarized).toBe(0)
    expect(stats.skipped).toBe(0)
    expect(db.memories.find((r) => r.id === row.id)!.summary).toBeNull()
    expect(db.logs.filter((l) => l.action === 'summarize')).toHaveLength(0)
  })

  test('요약 UPDATE 실패 — skipped 증가', async () => {
    const { db, env } = makeEnv()
    db.addMemory({ content: '오래된 기억이다. 두 번째 문장이다.', updated_at: oldDate() })
    db.failOn.push({ match: 'UPDATE ai_memory_v2 SET summary' })
    const stats = await runSleepConsolidation(env)
    expect(stats.summarized).toBe(0)
    expect(stats.skipped).toBe(1)
  })

  test('요약 채우기가 updated_at을 바꾸지 않음', async () => {
    const { db, env } = makeEnv()
    const at = oldDate()
    const row = db.addMemory({
      content: '오래된 기억이다. 두 번째 문장이다.',
      updated_at: at,
    })
    await runSleepConsolidation(env)
    expect(db.memories.find((r) => r.id === row.id)!.updated_at).toBe(at)
  })

  test('LLM 요약이 5글자 미만 — 결정적 요약 유지', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_consolidation_enabled', 'true')
    const row = db.addMemory({
      content: '오래된 기억이다. 두 번째 문장이다.',
      updated_at: oldDate(),
    })
    const stats = await runSleepConsolidation(env, {
      llmSummarize: async () => '짧다',
    })
    expect(stats.summarized).toBe(1)
    expect(db.memories.find((r) => r.id === row.id)!.summary).toBe('오래된 기억이다.')
  })

  test('LLM 요약이 200자 초과 — 200자로 절단', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_consolidation_enabled', 'true')
    const row = db.addMemory({
      content: '오래된 기억이다. 두 번째 문장이다.',
      updated_at: oldDate(),
    })
    const stats = await runSleepConsolidation(env, {
      llmSummarize: async () => '요'.repeat(250),
    })
    expect(stats.summarized).toBe(1)
    const summary = db.memories.find((r) => r.id === row.id)!.summary!
    expect(summary).toHaveLength(200)
    expect(summary).toBe('요'.repeat(200))
  })

  test('LLM 요약 공백만 반환 — 결정적 요약 유지', async () => {
    const { db, env } = makeEnv()
    db.settings.set('memory.llm_consolidation_enabled', 'true')
    const row = db.addMemory({
      content: '오래된 기억이다. 두 번째 문장이다.',
      updated_at: oldDate(),
    })
    await runSleepConsolidation(env, { llmSummarize: async () => '   ' })
    expect(db.memories.find((r) => r.id === row.id)!.summary).toBe('오래된 기억이다.')
  })
})

describe('runSleepConsolidation — 감사 로그', () => {
  test('감사 로그 INSERT 실패 — 통합은 계속되고 통계는 정상', async () => {
    const { db, env } = makeEnv()
    db.addMemory({ content: 'Hello World', updated_at: '2026-10-20T00:00:00.000Z' })
    db.addMemory({ content: 'hello world!', updated_at: '2026-10-25T00:00:00.000Z' })
    db.failOn.push({ match: 'INSERT INTO memory_consolidation_log' })
    const stats = await runSleepConsolidation(env)
    expect(stats).toMatchObject({ ok: true, ran: true, merged: 1 })
    expect(db.logs).toHaveLength(0)
  })

  test('run 행에 통계 JSON이 남는다', async () => {
    const { db, env } = makeEnv()
    db.addMemory({ content: 'Hello World' })
    const stats = await runSleepConsolidation(env)
    const runLog = db.logs.find((l) => l.action === 'run')
    expect(runLog).toBeTruthy()
    expect(runLog!.run_id).toBe(stats.runId)
    expect(JSON.parse(runLog!.detail)).toMatchObject({
      merged: 0,
      contradictions: 0,
      summarized: 0,
      skipped: 0,
      scanned: 1,
    })
  })
})
