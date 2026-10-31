/// <reference types="jest" />
/**
 * 그룹 F 커버리지 보강 — src/services/fact-graph.ts
 * - 기존 tests/unit/svc4-mem0-facts.test.ts에서 다루지 않은 미커버 라인:
 *   isLlmExtractEnabled 예외(75), upsertEntity 예외(91), facts 주입(153-155),
 *   추출 결과 없음(177), 기존 사실 조회 실패(188), 사실 INSERT 실패(218),
 *   captureFactsFromMemo 예외(259), getFactNeighbors 예외(473)
 * - 보강: 메모 본문 조회 실패(245), 검색어 없음(302), 역방향 간선(327),
 *   upsert 실패 시 그래프 연결 건너뜀(106)
 *
 * 도달 불가로 판단한 라인:
 * - 412 (getRelatedFacts의 fetchSupersededMatches catch): fetchSupersededMatches가
 *   내부에서 모든 예외를 잡아 []를 반환하므로 이 catch는 실행될 수 없다.
 * - 81 (upsertEntity의 빈 정규화 이름): 호출부 extractEntities가 정규화 결과가
 *   빈 이름은 이미 걸러내므로 도달할 수 없다 (방어 코드).
 */
import {
  isLlmExtractEnabled,
  captureFacts,
  captureFactsFromMemo,
  expandGraphFacts,
  getRelatedFacts,
  getFactNeighbors,
} from '../../src/services/fact-graph'

// ---------------- Mock D1 ----------------

interface FactDbOpts {
  v2Flag?: string | null
  llmFlag?: string | null
  ftsRows?: any[]
  existingContents?: string[]
  memoLockRow?: any
  memoRow?: any
  seedEntities?: any[]
  relRows?: any[]
  graphFactRows?: any[]
  neighborSeedIds?: number[]
  neighborFactRows?: any[]
  /** 지정한 SQL 포함 문자열이 나오면 해당 단계에서 예외를 던진다 */
  throwOn?: { first?: string[]; all?: string[]; run?: string[] }
}

function makeFactDb(opts: FactDbOpts = {}) {
  const calls: { sql: string; params: any[] }[] = []
  const entityIds = new Map<string, number>()
  let entitySeq = 100
  let rowSeq = 1000
  const shouldThrow = (kind: 'first' | 'all' | 'run', sql: string) =>
    (opts.throwOn?.[kind] ?? []).some((frag) => sql.includes(frag))
  const db: any = {
    calls,
    entityIds,
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          calls.push({ sql, params: this._params })
          if (shouldThrow('first', sql)) throw new Error('db down')
          if (sql.includes("key = 'memory.v2_enabled'")) {
            return opts.v2Flag === undefined || opts.v2Flag === null ? null : { value: opts.v2Flag }
          }
          if (sql.includes("key = 'memory.llm_extract_enabled'")) {
            return opts.llmFlag === undefined || opts.llmFlag === null ? null : { value: opts.llmFlag }
          }
          if (sql.includes('FROM memos WHERE id = ?') && sql.includes('is_locked')) {
            return opts.memoLockRow ?? null
          }
          if (sql.includes('FROM memos WHERE id = ?')) {
            return opts.memoRow ?? null
          }
          if (sql.includes('SELECT id FROM memory_entities WHERE normalized = ?')) {
            const id = entityIds.get(this._params[0])
            return id === undefined ? null : { id }
          }
          return null
        },
        async all() {
          calls.push({ sql, params: this._params })
          if (shouldThrow('all', sql)) throw new Error('db down')
          if (sql.includes('ai_memory_fts MATCH')) {
            return { results: opts.ftsRows ?? [] }
          }
          if (sql.includes('SELECT content FROM ai_memory_v2')) {
            return { results: (opts.existingContents ?? []).map((c) => ({ content: c })) }
          }
          if (sql.includes('FROM memory_entities WHERE')) {
            return { results: opts.seedEntities ?? [] }
          }
          if (sql.includes('FROM memory_relations')) {
            return { results: opts.relRows ?? [] }
          }
          if (sql.includes('FROM memory_fact_entities fe')) {
            return { results: opts.graphFactRows ?? opts.neighborFactRows ?? [] }
          }
          if (sql.includes('FROM memory_fact_entities WHERE fact_id')) {
            return { results: (opts.neighborSeedIds ?? []).map((id) => ({ entity_id: id })) }
          }
          return { results: [] }
        },
        async run() {
          calls.push({ sql, params: this._params })
          if (shouldThrow('run', sql)) throw new Error('db down')
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

// ---------------- isLlmExtractEnabled (75) ----------------

describe('isLlmExtractEnabled — 조회 예외 시 false (75)', () => {
  test('first() 예외 → false', async () => {
    const db = makeFactDb({ throwOn: { first: ["key = 'memory.llm_extract_enabled'"] } })
    expect(await isLlmExtractEnabled({ DB: db } as any)).toBe(false)
  })
})

// ---------------- captureFacts — facts 주입 (153-155) ----------------

describe('captureFacts — facts 주입', () => {
  test('input.facts가 있으면 추출을 건너뛰고 그대로 사용 (153-155)', async () => {
    const db = makeFactDb({})
    const r = await captureFacts({ DB: db } as any, {
      text: '이 텍스트는 추출에 쓰이지 않습니다. 질문만 있는 문장인가요?',
      facts: ['  제공된 첫 번째 사실 문장입니다. ', '짧', '두 번째 제공 사실입니다.'],
    })
    expect(r.ok).toBe(true)
    expect(r.extraction).toBe('deterministic')
    expect(r.created?.map((c) => c.content)).toEqual([
      '제공된 첫 번째 사실 문장입니다.',
      '두 번째 제공 사실입니다.',
    ])
    expect(r.skipped).toEqual([])
  })

  test('facts 주입 + llmExtract가 있어도 주입 사실을 그대로 쓴다', async () => {
    const db = makeFactDb({ llmFlag: 'true' })
    const llmExtract = jest.fn(async () => ['LLM 사실 문장입니다.'])
    const r = await captureFacts({ DB: db } as any, {
      text: '결정적 사실 문장입니다.',
      facts: ['주입된 사실 문장입니다.'],
      llmExtract,
    })
    // facts 주입 시 LLM 추출 분기를 타지 않는다
    expect(llmExtract).not.toHaveBeenCalled()
    expect(r.created?.[0].content).toBe('주입된 사실 문장입니다.')
  })

  test('facts가 모두 짧으면 추출 결과 없음 (177)', async () => {
    const db = makeFactDb({})
    const r = await captureFacts({ DB: db } as any, {
      text: '짧은 문장.',
      facts: ['짧', '네'],
    })
    expect(r).toEqual({ ok: true, extraction: 'deterministic', created: [], skipped: [], entities: [] })
    expect(db.calls.some((c: any) => c.sql.includes('SELECT content FROM ai_memory_v2'))).toBe(false)
  })

  test('사실 문장이 없으면 저장 없이 빈 결과 (177)', async () => {
    const db = makeFactDb({})
    const r = await captureFacts({ DB: db } as any, { text: '오늘 날씨가 어떤가요?' })
    expect(r).toEqual({ ok: true, extraction: 'deterministic', created: [], skipped: [], entities: [] })
  })
})

// ---------------- captureFacts — DB 실패 분기 (188/218/91/106) ----------------

describe('captureFacts — DB 실패 분기', () => {
  test('기존 사실 조회 실패 → db_error (188)', async () => {
    const db = makeFactDb({ throwOn: { all: ['SELECT content FROM ai_memory_v2'] } })
    const r = await captureFacts({ DB: db } as any, { text: '결정적 사실 문장입니다.' })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })

  test('사실 INSERT 실패 → skipped로 보고, 나머지는 계속 (218)', async () => {
    const db = makeFactDb({ throwOn: { run: ['INSERT INTO ai_memory_v2'] } })
    const r = await captureFacts({ DB: db } as any, {
      text: '첫 번째 사실 문장입니다. 두 번째 사실 문장입니다.',
    })
    expect(r.ok).toBe(true)
    expect(r.created).toEqual([])
    expect(r.skipped).toEqual(['첫 번째 사실 문장입니다.', '두 번째 사실 문장입니다.'])
  })

  test('엔티티 upsert 실패 → 그래프 연결만 건너뛰고 사실은 저장 (91/106)', async () => {
    const db = makeFactDb({ throwOn: { run: ['INSERT OR IGNORE INTO memory_entities'] } })
    const r = await captureFacts({ DB: db } as any, {
      text: '사용자는 "MyHub"를 2026-10-25에 만들었다.',
    })
    expect(r.ok).toBe(true)
    expect(r.created).toHaveLength(1)
    // upsert 실패로 엔티티 ID를 못 얻어 연결이 건너뛰어짐
    expect(r.entities).toEqual([])
    expect(db.calls.some((c: any) => c.sql.includes('INSERT OR IGNORE INTO memory_fact_entities'))).toBe(false)
  })
})

// ---------------- captureFactsFromMemo (245/259) ----------------

describe('captureFactsFromMemo — 조회 실패 분기', () => {
  test('잠금 조회 예외 → db_error (259)', async () => {
    const db = makeFactDb({ throwOn: { first: ['FROM memos WHERE id = ?'] } })
    const r = await captureFactsFromMemo({ DB: db } as any, 3)
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })

  test('잠금 행은 있으나 본문 행 없음 → not_found (245)', async () => {
    const db = makeFactDb({
      memoLockRow: { id: 5, is_locked: 0 },
      memoRow: null,
    })
    const r = await captureFactsFromMemo({ DB: db } as any, 5)
    expect(r).toEqual({ ok: false, error: 'not_found' })
  })
})

// ---------------- expandGraphFacts (302/327) ----------------

describe('expandGraphFacts — 경계 분기', () => {
  test('검색어 없음 → [] (302)', async () => {
    const db = makeFactDb({})
    expect(await expandGraphFacts({ DB: db } as any, '')).toEqual([])
    expect(await expandGraphFacts({ DB: db } as any, 'a')).toEqual([])
    expect(db.calls).toHaveLength(0)
  })

  test('역방향 간선(target이 시드)도 1-hop 이웃으로 확장 (327)', async () => {
    const db = makeFactDb({
      seedEntities: [{ id: 2, name: '등산' }],
      // 간선 방향: 3 → 2 (시드가 target 쪽)
      relRows: [{ source_entity_id: 3, target_entity_id: 2 }],
      graphFactRows: [{
        id: 11, content: '이웃 사실', category: 'fact', summary: null, entities: '[]',
        access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00Z', entity_id: 3,
      }],
    })
    const out = await expandGraphFacts({ DB: db } as any, '등산')
    expect(out.map((r) => r.id)).toEqual([11])
    // 1-hop 보정(+0.05)이 적용된 점수 — 시드 직접(+0.10)보다 낮다
    expect(out[0].score!).toBeLessThan(1)
    expect(out[0].score!).toBeGreaterThan(0)
  })
})

// ---------------- getFactNeighbors 예외 (473) ----------------

describe('getFactNeighbors — 예외 시 [] (473)', () => {
  test('시드 엔티티 조회 예외 → []', async () => {
    const db = makeFactDb({ throwOn: { all: ['FROM memory_fact_entities WHERE fact_id'] } })
    expect(await getFactNeighbors({ DB: db } as any, 10)).toEqual([])
  })

  test('이웃 사실 조회 예외 → []', async () => {
    const db = makeFactDb({
      neighborSeedIds: [1],
      throwOn: { all: ['FROM memory_fact_entities fe'] },
    })
    expect(await getFactNeighbors({ DB: db } as any, 10)).toEqual([])
  })
})

// ---------------- 추가 브랜치 보강 (2차) ----------------

describe('captureFacts — 추가 경계 분기', () => {
  test('maxFacts 0이면 기본값 5 사용 (143)', async () => {
    const db = makeFactDb({})
    const text = Array.from({ length: 6 }, (_, i) => `사실 ${i + 1}번 문장입니다.`).join(' ')
    const r = await captureFacts({ DB: db } as any, { text, maxFacts: 0 })
    expect(r.created).toHaveLength(5)
  })

  test('maxFacts 99는 10으로 상한', async () => {
    const db = makeFactDb({})
    const text = Array.from({ length: 12 }, (_, i) => `사실 ${i + 1}번 문장입니다.`).join(' ')
    const r = await captureFacts({ DB: db } as any, { text, maxFacts: 99 })
    expect(r.created).toHaveLength(10)
  })

  test('facts 배열에 null이 섞이면 빈 문자열로 취급해 제외 (154)', async () => {
    const db = makeFactDb({})
    const r = await captureFacts({ DB: db } as any, {
      text: '무시되는 원문입니다.',
      facts: [null as any, '유효한 사실 문장입니다.'],
    })
    expect(r.created?.map((c) => c.content)).toEqual(['유효한 사실 문장입니다.'])
  })

  test('LLM 결과가 모두 짧으면 결정적 결과 유지 (167)', async () => {
    const db = makeFactDb({ llmFlag: 'true' })
    const llmExtract = jest.fn(async () => ['짧'])
    const r = await captureFacts({ DB: db } as any, {
      text: '결정적 사실 문장입니다.',
      llmExtract,
    })
    expect(r.extraction).toBe('deterministic')
    expect(r.created?.[0].content).toBe('결정적 사실 문장입니다.')
  })

  test('LLM 결과에 null이 섞이면 빈 문자열로 취급해 제외 (164)', async () => {
    const db = makeFactDb({ llmFlag: 'true' })
    const llmExtract = jest.fn(async () => [null as any, 'LLM 사실 문장입니다.'])
    const r = await captureFacts({ DB: db } as any, {
      text: '결정적 사실 문장입니다.',
      llmExtract,
    })
    expect(r.extraction).toBe('llm')
    expect(r.created?.map((c) => c.content)).toEqual(['LLM 사실 문장입니다.'])
  })

  test('기존 사실 조회 결과가 null이면 빈 집합으로 취급 (186)', async () => {
    const db = makeFactDb({})
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      if (sql.includes('SELECT content FROM ai_memory_v2')) {
        stmt.all = async () => ({ results: null })
      }
      return stmt
    }
    const r = await captureFacts({ DB: db } as any, { text: '새로운 사실 문장입니다.' })
    expect(r.ok).toBe(true)
    expect(r.created).toHaveLength(1)
  })

  test('엔티티 조회가 null이면 그래프 연결 건너뜀 (89)', async () => {
    const db = makeFactDb({})
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      if (sql.includes('SELECT id FROM memory_entities WHERE normalized = ?')) {
        stmt.first = async () => null
      }
      return stmt
    }
    const r = await captureFacts({ DB: db } as any, {
      text: '사용자는 "MyHub"를 2026-10-25에 만들었다.',
    })
    expect(r.ok).toBe(true)
    expect(r.created).toHaveLength(1)
    expect(r.entities).toEqual([])
  })
})

describe('captureFactsFromMemo — 본문 null (250)', () => {
  test('메모 본문이 null이면 빈 텍스트로 캡처 시도 → text 필요 (250)', async () => {
    const db = makeFactDb({
      memoLockRow: { id: 5, is_locked: 0 },
      memoRow: { text: null, locked_blocks: null },
    })
    const r = await captureFactsFromMemo({ DB: db } as any, 5)
    // String(null || '') → '' → sanitize 후 빈 텍스트라 캡처 거부
    expect(r).toEqual({ ok: false, error: 'text 필요' })
  })
})

describe('expandGraphFacts — 행 필드 변형', () => {
  test('요약·엔티티·대체·모순·출처 필드가 그대로 전달된다', async () => {
    const db = makeFactDb({
      seedEntities: [{ id: 1, name: '등산' }],
      relRows: [],
      graphFactRows: [{
        id: 10, content: '등산 직접 사실 내용입니다', category: 'fact',
        summary: '등산 요약', entities: '["등산", "장비"]',
        // tier는 실제 now 기준 경과일로 판정 — 고정 날짜는 만료되므로 동적 날짜 사용
        // (Track A 2026-10-29). created_at은 에코 단언용이라 고정 유지.
        access_count: 5, last_accessed_at: new Date(Date.now() - 86400000).toISOString(),
        updated_at: new Date(Date.now() - 86400000).toISOString(), created_at: '2026-10-20T00:00:00Z',
        is_active: 1, superseded_by: 3, supersedes: null, contradiction_flag: 1,
        source_type: 'memo', source_id: 9, entity_id: 1,
      }],
    })
    const out = await expandGraphFacts({ DB: db } as any, '등산')
    expect(out).toHaveLength(1)
    const item = out[0]
    expect(item.summary).toBe('등산 요약')
    expect(item.entities).toEqual(['등산', '장비'])
    expect(item.supersededBy).toBe(3)
    expect(item.contradiction).toBe(true)
    expect(item.sourceType).toBe('memo')
    expect(item.sourceId).toBe(9)
    expect(item.createdAt).toBe('2026-10-20T00:00:00Z')
    expect(item.tier).toBe('hot') // 최근 접근 + 접근 5회
  })
})

describe('getRelatedFacts — batch 없는 DB에서 touch', () => {
  test('batch 미지원 DB면 순차 run으로 접근 기록 (400/403)', async () => {
    // 이 파일의 makeFactDb는 batch가 없다 → else 분기 (순차 run)
    const db = makeFactDb({
      v2Flag: 'true',
      ftsRows: [{
        id: 1, content: 'FTS 사실', category: 'fact', fts_rank: -9,
        access_count: 0, updated_at: '2026-10-25T00:00:00Z',
      }],
      seedEntities: [],
    })
    expect(typeof (db as any).batch).toBe('undefined')
    const out = await getRelatedFacts({ DB: db } as any, '테스트 쿼리')
    expect(out.map((r) => r.id)).toEqual([1])
    const touch = db.calls.filter((c: any) => c.sql.includes('UPDATE ai_memory_v2 SET access_count'))
    expect(touch).toHaveLength(1)
  })

  test('매칭 없음 → 빈 결과, touch 없음', async () => {
    const db = makeFactDb({ v2Flag: 'true', ftsRows: [], seedEntities: [] })
    const out = await getRelatedFacts({ DB: db } as any, '테스트 쿼리')
    expect(out).toEqual([])
    expect(db.calls.filter((c: any) => c.sql.includes('UPDATE ai_memory_v2 SET access_count'))).toHaveLength(0)
  })
})

describe('getFactNeighbors — 동점 + updated_at 없음 (467)', () => {
  test('동점이고 updated_at이 없어도 정렬이 깨지지 않는다', async () => {
    const nRow = (id: number, content: string, entityId: number) => ({
      id, content, category: 'fact', summary: null, entities: '[]',
      access_count: 0, last_accessed_at: null, updated_at: null, entity_id: entityId,
    })
    const db = makeFactDb({
      neighborSeedIds: [1],
      neighborFactRows: [nRow(20, '이웃 하나', 1), nRow(21, '이웃 둘', 1)],
    })
    const out = await getFactNeighbors({ DB: db } as any, 10)
    expect(out.map((r) => r.id).sort()).toEqual([20, 21])
    expect(out).toHaveLength(2)
  })
})
