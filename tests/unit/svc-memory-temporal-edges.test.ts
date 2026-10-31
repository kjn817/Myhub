/// <reference types="jest" />
/**
 * 시간 엣지 (Graphiti 패턴, 0056) + memora 대조 엣지 케이스 단위 테스트
 * - normalizeEntityName: 조사 제거 해소 (아내는/아내가 → 아내)
 * - resolveSupersedeLeaf: 대체 체인 해소 (선형·단일·없음·사이클·끊긴 포인터)
 * - close/reopen/getFactTemporalEdges: 시간 엣지 닫기·다시 열기·조회
 * - runSleepConsolidation 병합 시 패자의 시간 엣지를 닫는지 (memora 대조:
 *   memora는 supersedes 간선으로 계보를 남기고, 우리는 valid_until로 닫는다)
 * - memora 엣지 케이스:
 *   a. 동일 사실 재흡수 — 활성 중복은 스킵, 대체된 사실과 같은 내용은
 *      새 행으로 생성 (memora도 live leaf 기준으로만 dedup한다)
 *   b. 대체 체인 — A→B→C 해소 시 리프 C 반환
 *   c. 복원 — 닫힌 엣지를 다시 열면 그래프에서 다시 보인다
 */
import { normalizeEntityName } from '../../src/services/fact-extract'
import { resolveSupersedeLeaf } from '../../src/services/memory-service'
import {
  closeFactTemporalEdges,
  getFactTemporalEdges,
  reopenFactTemporalEdges,
  captureFacts,
  expandGraphFacts,
} from '../../src/services/fact-graph'
import { runSleepConsolidation } from '../../src/services/memory-consolidation'

// ---------------------------------------------------------------------------
// normalizeEntityName — 조사 제거 해소
// ---------------------------------------------------------------------------

describe('normalizeEntityName — 조사 제거 해소 (Graphiti 엔티티 해소 1단계)', () => {
  test('끝 조사 제거로 같은 엔티티로 모인다', () => {
    expect(normalizeEntityName('아내는')).toBe('아내')
    expect(normalizeEntityName('아내가')).toBe('아내')
    expect(normalizeEntityName('아내를')).toBe('아내')
    expect(normalizeEntityName('서울에서')).toBe('서울')
    expect(normalizeEntityName('보라돌이는')).toBe('보라돌이')
  })
  test('기존 동작 유지 (소문자 + 문자/숫자만, 날짜 유지)', () => {
    expect(normalizeEntityName('MyHub')).toBe('myhub')
    expect(normalizeEntityName('10월 25일')).toBe('10월25일')
  })
  test('KNOWN LIMITATION: 이름 자체가 조사 글자로 끝나면 과도 제거', () => {
    // "보라돌이"는 이름의 일부인 '이'까지 떼어 "보라돌"이 된다.
    // 같은 입력은 항상 같은 normalized라 해소 일관성은 유지되나,
    // "보라돌"이라는 다른 엔티티와 충돌할 수 있다 (비교 메모 참조).
    expect(normalizeEntityName('보라돌이')).toBe('보라돌')
  })
  test('빈 입력 → 빈 문자열', () => {
    expect(normalizeEntityName('')).toBe('')
    expect(normalizeEntityName('   ')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// resolveSupersedeLeaf — 대체 체인 해소
// ---------------------------------------------------------------------------

describe('resolveSupersedeLeaf — 대체 체인 해소 (memora _resolve_latest 패턴)', () => {
  test('선형 체인 A→B→C → 리프 C', () => {
    const rows = [
      { id: 1, superseded_by: 2 },
      { id: 2, superseded_by: 3 },
      { id: 3, superseded_by: null },
    ]
    expect(resolveSupersedeLeaf(rows, 1)).toBe(3)
    expect(resolveSupersedeLeaf(rows, 2)).toBe(3)
    expect(resolveSupersedeLeaf(rows, 3)).toBe(3)
  })
  test('대체되지 않은 단일 기억 → 자기 자신', () => {
    expect(resolveSupersedeLeaf([{ id: 7, superseded_by: null }], 7)).toBe(7)
  })
  test('목록에 없는 시작 id → null', () => {
    expect(resolveSupersedeLeaf([{ id: 1, superseded_by: null }], 99)).toBeNull()
  })
  test('사이클 A→B→A → 방문 집합 중 가장 큰 id (결정적 폴백)', () => {
    const rows = [
      { id: 1, superseded_by: 2 },
      { id: 2, superseded_by: 1 },
    ]
    expect(resolveSupersedeLeaf(rows, 1)).toBe(2)
    expect(resolveSupersedeLeaf(rows, 2)).toBe(2)
  })
  test('끊긴 포인터 (가리키는 행이 목록에 없음) → 끊긴 지점이 리프', () => {
    const rows = [{ id: 1, superseded_by: 42 }]
    expect(resolveSupersedeLeaf(rows, 1)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 시간 엣지 닫기/열기/조회 — 인메모리 MockD1
// ---------------------------------------------------------------------------

interface EdgeRow {
  fact_id: number
  entity_id: number
  valid_from: string | null
  valid_until: string | null
}

class EdgeDb {
  edges: EdgeRow[] = []
  calls: string[] = []

  seed(factId: number, entityId: number, validFrom = '2026-10-20T00:00:00.000Z') {
    this.edges.push({ fact_id: factId, entity_id: entityId, valid_from: validFrom, valid_until: null })
  }

  prepare(sql: string) {
    const q = sql.replace(/\s+/g, ' ').trim()
    const self = this
    const stmt: any = {
      _sql: q,
      _params: [] as any[],
      bind(...p: any[]) { stmt._params = p; return stmt },
      async all() {
        self.calls.push(q)
        if (q.startsWith('SELECT entity_id, valid_from, valid_until FROM memory_fact_entities')) {
          return { results: self.edges.filter((e) => e.fact_id === stmt._params[0]) }
        }
        return { results: [] }
      },
      async run() {
        self.calls.push(q)
        if (q.startsWith('UPDATE memory_fact_entities SET valid_until = ? WHERE fact_id = ?')) {
          let n = 0
          for (const e of self.edges) {
            if (e.fact_id === stmt._params[1] && e.valid_until === null) {
              e.valid_until = stmt._params[0]
              n++
            }
          }
          return { meta: { changes: n } }
        }
        if (q.startsWith('UPDATE memory_fact_entities SET valid_until = NULL')) {
          let n = 0
          for (const e of self.edges) {
            if (e.fact_id === stmt._params[0] && e.valid_until !== null) {
              e.valid_until = null
              n++
            }
          }
          return { meta: { changes: n } }
        }
        return { meta: { changes: 0 } }
      },
    }
    return stmt
  }
}

describe('close/reopen/getFactTemporalEdges', () => {
  test('닫기 → 조회 시 valid_until이 채워진다 (열린 연결만 닫는다)', async () => {
    const db = new EdgeDb()
    db.seed(1, 10)
    db.seed(1, 11)
    const r = await closeFactTemporalEdges({ DB: db } as any, 1, '2026-10-26T07:00:00.000Z')
    expect(r).toEqual({ ok: true, closed: 2 })
    const edges = await getFactTemporalEdges({ DB: db } as any, 1)
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => e.validUntil === '2026-10-26T07:00:00.000Z')).toBe(true)
    expect(edges.every((e) => e.validFrom === '2026-10-20T00:00:00.000Z')).toBe(true)
  })
  test('닫기는 멱등 — 두 번째 닫기는 closed 0', async () => {
    const db = new EdgeDb()
    db.seed(1, 10)
    await closeFactTemporalEdges({ DB: db } as any, 1, '2026-10-26T07:00:00.000Z')
    const r2 = await closeFactTemporalEdges({ DB: db } as any, 1, '2026-10-26T08:00:00.000Z')
    expect(r2).toEqual({ ok: true, closed: 0 })
    const edges = await getFactTemporalEdges({ DB: db } as any, 1)
    expect(edges[0].validUntil).toBe('2026-10-26T07:00:00.000Z') // 첫 닫기 시각 유지
  })
  test('복원(다시 열기) → valid_until이 NULL로 돌아오고 valid_from은 유지', async () => {
    const db = new EdgeDb()
    db.seed(1, 10)
    await closeFactTemporalEdges({ DB: db } as any, 1, '2026-10-26T07:00:00.000Z')
    const r = await reopenFactTemporalEdges({ DB: db } as any, 1)
    expect(r).toEqual({ ok: true, reopened: 1 })
    const edges = await getFactTemporalEdges({ DB: db } as any, 1)
    expect(edges[0].validUntil).toBeNull()
    expect(edges[0].validFrom).toBe('2026-10-20T00:00:00.000Z')
  })
  test('무효 id → ok:false, 조회 → []', async () => {
    const db = new EdgeDb()
    expect(await closeFactTemporalEdges({ DB: db } as any, 0)).toEqual({ ok: false, closed: 0 })
    expect(await reopenFactTemporalEdges({ DB: db } as any, -1)).toEqual({ ok: false, reopened: 0 })
    expect(await getFactTemporalEdges({ DB: db } as any, 0)).toEqual([])
    expect(await getFactTemporalEdges({ DB: db } as any, 999)).toEqual([])
  })
  test('DB 예외(0056 미적용) → fail-soft', async () => {
    const throwing = { prepare: () => { throw new Error('no such column: valid_until') } }
    expect(await closeFactTemporalEdges({ DB: throwing } as any, 1)).toEqual({ ok: false, closed: 0 })
    expect(await reopenFactTemporalEdges({ DB: throwing } as any, 1)).toEqual({ ok: false, reopened: 0 })
    expect(await getFactTemporalEdges({ DB: throwing } as any, 1)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runSleepConsolidation 병합 시 시간 엣지 닫기
// ---------------------------------------------------------------------------

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

class ConsolidationDb {
  settings = new Map<string, string>([['memory.v2_enabled', 'true']])
  memories: MemRow[] = []
  edges: EdgeRow[] = []
  closedFactIds: number[] = []
  logs: Array<{ action: string; detail: string }> = []
  seq = 0

  addMemory(over: Partial<MemRow> & { content: string }): MemRow {
    const row: MemRow = {
      id: ++this.seq,
      summary: '요약 있음',
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
    const q = sql.replace(/\s+/g, ' ').trim()
    const self = this
    const stmt: any = {
      _sql: q,
      _params: [] as any[],
      bind(...p: any[]) { stmt._params = p; return stmt },
      async first() {
        if (q.startsWith('SELECT value FROM ai_settings')) {
          const key = q.match(/key = '([^']+)'/)?.[1] || ''
          return self.settings.has(key) ? { value: self.settings.get(key) } : null
        }
        return null
      },
      async all() {
        if (q.startsWith('SELECT id, content, summary')) {
          return {
            results: self.memories
              .filter((r) => r.is_active === 1)
              .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
              .slice(0, stmt._params[0])
              .map((r) => ({
                id: r.id, content: r.content, summary: r.summary, entities: r.entities,
                access_count: r.access_count, last_accessed_at: r.last_accessed_at,
                updated_at: r.updated_at, contradiction_flag: r.contradiction_flag,
              })),
          }
        }
        return { results: [] }
      },
      async run() {
        if (q.startsWith('INSERT INTO memory_consolidation_log')) {
          self.logs.push({ action: stmt._params[1], detail: stmt._params[4] })
          return { meta: { changes: 1 } }
        }
        if (q.startsWith('UPDATE memory_fact_entities SET valid_until = ?')) {
          self.closedFactIds.push(stmt._params[1])
          return { meta: { changes: 1 } }
        }
        return { meta: { changes: 0 } }
      },
    }
    return stmt
  }

  async batch(statements: any[]) {
    for (const s of statements) {
      const q = s._sql as string
      const p = s._params as any[]
      if (q.startsWith('UPDATE ai_memory_v2 SET is_active = 0')) {
        const row = this.memories.find((r) => r.id === p[2])
        if (row) { row.is_active = 0; row.superseded_by = p[0] }
      }
      if (q.startsWith('UPDATE ai_memory_v2 SET supersedes')) {
        const row = this.memories.find((r) => r.id === p[2])
        if (row) row.supersedes = p[0]
      }
    }
    return statements.map(() => ({ meta: { changes: 1 } }))
  }
}

describe('runSleepConsolidation — 병합 시 시간 엣지 닫기', () => {
  test('중복 병합된 패자의 시간 엣지가 닫히고 감사 로그에 남는다', async () => {
    const db = new ConsolidationDb()
    db.addMemory({ id: 1, content: 'Hello World', updated_at: '2026-10-20T00:00:00.000Z' })
    db.addMemory({ id: 2, content: 'hello world!', updated_at: '2026-10-25T00:00:00.000Z' })
    db.seq = 2
    const stats = await runSleepConsolidation({ DB: db } as any)
    expect(stats.merged).toBe(1)
    expect(db.closedFactIds).toEqual([1]) // 패자 #1의 엣지 닫힘, 생존자 #2는 안 닫힘
    const mergeLog = db.logs.find((l) => l.action === 'merge')
    expect(mergeLog?.detail).toContain('시간 엣지 1건 닫힘')
  })
  test('닫기 실패(0056 미적용)에도 병합은 성공하고 skipped로 세지 않는다', async () => {
    const db = new ConsolidationDb()
    // valid_until UPDATE를 실패하게 만든다: prepare를 가로채 예외 발생
    const origPrepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const stmt: any = origPrepare(sql)
      if (sql.includes('memory_fact_entities')) {
        stmt.run = async () => { throw new Error('no such column: valid_until') }
      }
      return stmt
    }) as any
    db.addMemory({ id: 1, content: 'Hello World', updated_at: '2026-10-20T00:00:00.000Z' })
    db.addMemory({ id: 2, content: 'hello world!', updated_at: '2026-10-25T00:00:00.000Z' })
    db.seq = 2
    const stats = await runSleepConsolidation({ DB: db } as any)
    expect(stats.merged).toBe(1)
    expect(stats.skipped).toBe(0)
    const mergeLog = db.logs.find((l) => l.action === 'merge')
    expect(mergeLog?.detail).toContain('시간 엣지 닫기 미적용')
  })
})

// ---------------------------------------------------------------------------
// expandGraphFacts — 0056 시간 필터 + 0046-only DB 레거시 폴백
// (memory-0046-real 통합 테스트 회귀: 0056 미적용 DB에서도 그래프 확장이
//  동작해야 한다 — 필터 쿼리 실패 시 필터 없이 재시도)
// ---------------------------------------------------------------------------

describe('expandGraphFacts — 시간 필터 + 레거시 폴백', () => {
  const graphRow = (id: number, content: string, entityId: number) => ({
    id, content, category: 'fact', summary: null, entities: null,
    access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00.000Z',
    created_at: '2026-10-25T00:00:00.000Z', is_active: 1, superseded_by: null,
    supersedes: null, contradiction_flag: 0, source_type: null, source_id: null,
    entity_id: entityId,
  })

  function makeGraphDb(throwTemporal: boolean) {
    const queries: string[] = []
    const db: any = {
      queries,
      prepare(sql: string) {
        return {
          _params: [] as any[],
          bind(...p: any[]) { this._params = p; return this },
          async all() {
            queries.push(sql)
            if (sql.includes('FROM memory_entities WHERE')) {
              return { results: [{ id: 1, name: '등산' }] }
            }
            if (sql.includes('FROM memory_relations')) return { results: [] }
            if (sql.includes('FROM memory_fact_entities fe')) {
              if (throwTemporal && sql.includes('valid_until')) {
                throw new Error('no such column: valid_until')
              }
              return { results: [graphRow(2, '장비 목록 정리', 1)] }
            }
            return { results: [] }
          },
        }
      },
    }
    return db
  }

  test('0056 DB: 시간 필터 쿼리로 그래프 이웃을 회수한다', async () => {
    const db = makeGraphDb(false)
    const out = await expandGraphFacts({ DB: db } as any, '등산')
    expect(out.map((r) => r.content)).toContain('장비 목록 정리')
    expect(db.queries.some((q: string) => q.includes('fe.valid_until IS NULL'))).toBe(true)
  })
  test('0046-only DB: 필터 쿼리 실패 시 필터 없이 재시도해 회수한다', async () => {
    const db = makeGraphDb(true)
    const out = await expandGraphFacts({ DB: db } as any, '등산')
    expect(out.map((r) => r.content)).toContain('장비 목록 정리')
    const graphQueries = db.queries.filter((q: string) => q.includes('FROM memory_fact_entities fe'))
    expect(graphQueries).toHaveLength(2)
    expect(graphQueries[0]).toContain('fe.valid_until IS NULL')
    expect(graphQueries[1]).not.toContain('valid_until')
  })
})

// ---------------------------------------------------------------------------
// memora 엣지 케이스 a: 동일 사실 재흡수
// ---------------------------------------------------------------------------

describe('captureFacts — 동일 사실 재흡수 (memora dedup 대조)', () => {
  function makeCaptureDb(activeContents: string[]) {
    const calls: string[] = []
    let rowSeq = 1000
    const entityIds = new Map<string, number>()
    let entitySeq = 100
    const db: any = {
      calls,
      prepare(sql: string) {
        return {
          _sql: sql,
          _params: [] as any[],
          bind(...p: any[]) { this._params = p; return this },
          async first() {
            calls.push(sql)
            if (sql.includes('SELECT id FROM memory_entities WHERE normalized = ?')) {
              const id = entityIds.get(this._params[0])
              return id === undefined ? null : { id }
            }
            return null
          },
          async all() {
            calls.push(sql)
            if (sql.includes('SELECT content FROM ai_memory_v2')) {
              return { results: activeContents.map((c) => ({ content: c })) }
            }
            return { results: [] }
          },
          async run() {
            calls.push(sql)
            if (sql.includes('INSERT OR IGNORE INTO memory_entities')) {
              const norm = this._params[1]
              if (!entityIds.has(norm)) entityIds.set(norm, entitySeq++)
              return { meta: { last_row_id: entityIds.get(norm), changes: 1 } }
            }
            if (sql.includes('INSERT INTO ai_memory_v2')) {
              return { meta: { last_row_id: rowSeq++, changes: 1 } }
            }
            return { meta: { last_row_id: 1, changes: 1 } }
          },
        }
      },
    }
    return db
  }

  test('활성 중복은 스킵 (memora의 0.85 이상 auto-skip과 같은 역할, 결정적 버전)', async () => {
    const db = makeCaptureDb(['사용자는 "MyHub"를 좋아합니다.'])
    const r = await captureFacts({ DB: db } as any, {
      text: '사용자는 "MyHub"를 좋아합니다.',
    })
    expect(r.created).toEqual([])
    expect(r.skipped).toContain('사용자는 "MyHub"를 좋아합니다.')
  })
  test('대체된 사실과 같은 내용은 새 행으로 생성된다 (memora: live leaf만 dedup 대상)', async () => {
    // 대체된 행은 활성 목록에 없으므로 dedup 대상이 아니다 — 옛 내용이
    // 새 행으로 돌아오고, 옛 행은 superseded 상태로 계보에 남는다.
    // (memora는 삭제된 내용만 tombstone으로 막는다. 대체된 내용은 막지 않는다.)
    const db = makeCaptureDb([]) // 활성 목록에 없음 = 이미 대체됨
    const r = await captureFacts({ DB: db } as any, {
      text: '사용자는 "MyHub"를 좋아합니다.',
    })
    expect(r.created).toHaveLength(1)
    expect(r.created?.[0].content).toBe('사용자는 "MyHub"를 좋아합니다.')
    expect(r.skipped).toEqual([])
  })
})
