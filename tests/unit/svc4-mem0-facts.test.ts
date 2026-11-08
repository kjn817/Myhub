/// <reference types="jest" />
/**
 * 0046 mem0 패턴 이식 단위 테스트
 * - 순수 헬퍼: splitSentences / isFactSentence / scoreFactSentence /
 *   extractFacts / normalizeEntityName / extractEntities
 * - isLlmExtractEnabled (기본 OFF)
 * - captureFacts: 결정적 추출 + near-duplicate 제외 + 그래프 연결 + LLM 플래그
 * - captureFactsFromMemo: 잠긴 메모 거부 (본문 미조회) + 잠긴 블록 제거
 * - expandGraphFacts / getRelatedFacts: FTS + 1-hop 병합, 최대 5개, touch 1회
 * - getFactNeighbors: 공유 엔티티 순 정렬
 */
import {
  splitSentences,
  isFactSentence,
  scoreFactSentence,
  extractFacts,
  normalizeEntityName,
  extractEntities,
} from '../../src/services/fact-extract'
import {
  isLlmExtractEnabled,
  captureFacts,
  captureFactsFromMemo,
  expandGraphFacts,
  getRelatedFacts,
  getFactNeighbors,
} from '../../src/services/fact-graph'

// ---------------- 순수 헬퍼 ----------------

describe('splitSentences', () => {
  test('한글·영문 종결 부호 + 줄바꿈 기준', () => {
    expect(splitSentences('첫 문장입니다. 둘째 문장입니다! 셋째?')).toEqual([
      '첫 문장입니다.',
      '둘째 문장입니다!',
      '셋째?',
    ])
    expect(splitSentences('첫 줄\n둘째 줄')).toEqual(['첫 줄', '둘째 줄'])
  })
  test('빈 입력 → []', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })
})

describe('isFactSentence', () => {
  test('정상 사실 문장', () => {
    expect(isFactSentence('사용자는 등산을 좋아합니다.')).toBe(true)
    expect(isFactSentence('회의는 매주 월요일 10시입니다.')).toBe(true)
  })
  test('너무 짧거나 긴 문장 제외', () => {
    expect(isFactSentence('짧다')).toBe(false)
    expect(isFactSentence('x'.repeat(201))).toBe(false)
  })
  test('질문·URL·기호 위주·잠긴 블록 제외', () => {
    expect(isFactSentence('오늘 날씨가 어떤가요?')).toBe(false)
    expect(isFactSentence('https://example.com/very-long-path')).toBe(false)
    expect(isFactSentence('!!! ??? ...')).toBe(false)
    expect(isFactSentence('[LOCKED_BLOCK]')).toBe(false)
  })
})

describe('scoreFactSentence', () => {
  test('날짜 +2, 숫자 +1, 인용 +1, 적정 길이 +1', () => {
    expect(scoreFactSentence('회의는 2026-10-25 10시에 열립니다.')).toBeGreaterThanOrEqual(4)
    expect(scoreFactSentence('그냥 보통 길이의 문장입니다.')).toBe(1)
    expect(scoreFactSentence('짧다.')).toBe(0)
    expect(scoreFactSentence('"MyHub"는 개인 OS입니다.')).toBeGreaterThanOrEqual(2)
  })
})

describe('extractFacts', () => {
  test('질문 제외 + 중복 제거 + 최대 5개', () => {
    const text = [
      '사용자는 등산을 좋아합니다.',
      '오늘 날씨가 어떤가요?',
      '사용자는 등산을 좋아합니다.',
      '매주 월요일 10시에 회의가 있습니다.',
      '짧다',
      '점심은 12시에 먹습니다.',
      '저녁은 18시에 먹습니다.',
      '아침은 7시에 먹습니다.',
      '운동은 6시에 합니다.',
    ].join(' ')
    const out = extractFacts(text)
    expect(out).toHaveLength(5)
    expect(out).not.toContain('오늘 날씨가 어떤가요?')
    // 중복은 상한을 넓혀도 1번만 등장한다 (점수 1점짜리라 상한 5개에는 들지 못함)
    const wide = extractFacts(text, 10)
    expect(wide).toHaveLength(6)
    expect(wide.filter((f) => f === '사용자는 등산을 좋아합니다.')).toHaveLength(1)
  })
  test('날짜 포함 문장이 먼저 (점수순)', () => {
    const out = extractFacts('그냥 문장입니다. 회의는 2026-10-25에 있습니다.')
    expect(out[0]).toContain('2026-10-25')
  })
  test('maxFacts 상한', () => {
    const text = Array.from({ length: 8 }, (_, i) => `사실 ${i + 1}번 문장입니다.`).join(' ')
    expect(extractFacts(text, 3)).toHaveLength(3)
    expect(extractFacts(text, 99)).toHaveLength(8)
  })
  test('빈 입력 → []', () => {
    expect(extractFacts('')).toEqual([])
    expect(extractFacts('짧다')).toEqual([])
  })
})

describe('normalizeEntityName', () => {
  test('소문자 + 문자/숫자만', () => {
    expect(normalizeEntityName('MyHub')).toBe('myhub')
    expect(normalizeEntityName('10월 25일')).toBe('10월25일')
  })
})

describe('extractEntities', () => {
  test('인용·날짜·약어 추출', () => {
    const out = extractEntities('사용자는 "MyHub"를 2026-10-25에 만들었고 D1과 API를 쓴다.')
    expect(out).toContain('MyHub')
    expect(out).toContain('2026-10-25')
    expect(out).toContain('D1')
    expect(out).toContain('API')
  })
  test('첫 글자만 대문자인 일반 단어 제외', () => {
    const out = extractEntities('The user likes coffee every day.')
    expect(out).not.toContain('The')
  })
  test('중복 제거 + 순서 유지', () => {
    const out = extractEntities('"AB"와 "AB"와 "CD"를 봤다.')
    expect(out).toEqual(['AB', 'CD'])
  })
  test('시간 토큰', () => {
    expect(extractEntities('회의는 10월 25일 10시 30분입니다.')).toContain('10월25일')
    expect(extractEntities('회의는 10시 30분입니다.')).toContain('10시30분')
  })
})

// ---------------- Mock D1 ----------------

interface FactDbOpts {
  v2Flag?: string | null
  llmFlag?: string | null
  ftsRows?: any[] | 'throw'
  likeRows?: any[]
  existingContents?: string[]
  memoLockRow?: any
  memoRow?: any
  seedEntities?: any[]
  relRows?: any[]
  graphFactRows?: any[]
  neighborSeedIds?: number[]
  neighborFactRows?: any[]
}

function makeFactDb(opts: FactDbOpts = {}) {
  const calls: { sql: string; params: any[] }[] = []
  const batchCalls: any[][] = []
  const entityIds = new Map<string, number>()
  let entitySeq = 100
  let rowSeq = 1000
  const db: any = {
    calls,
    batchCalls,
    entityIds,
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          calls.push({ sql, params: this._params })
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
          if (sql.includes('ai_memory_fts MATCH')) {
            if (opts.ftsRows === 'throw') throw new Error('fts boom')
            return { results: opts.ftsRows ?? [] }
          }
          if (sql.includes('FROM ai_memory_v2') && sql.includes('LIKE')) {
            return { results: opts.likeRows ?? [] }
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
    async batch(stmts: any[]) {
      batchCalls.push(stmts)
      return stmts.map(() => ({ meta: { changes: 1, last_row_id: 1 } }))
    },
  }
  return db
}

const ftsRow = (id: number, content: string, ftsRank = -5) => ({
  id, content, category: 'fact', fts_rank: ftsRank,
  access_count: 0, updated_at: '2026-10-25T00:00:00Z',
})

// ---------------- isLlmExtractEnabled ----------------

describe('isLlmExtractEnabled — 기본 OFF', () => {
  test("플래그 'true' → true", async () => {
    expect(await isLlmExtractEnabled({ DB: makeFactDb({ llmFlag: 'true' }) } as any)).toBe(true)
  })
  test("플래그 없음/'false' → false", async () => {
    expect(await isLlmExtractEnabled({ DB: makeFactDb({}) } as any)).toBe(false)
    expect(await isLlmExtractEnabled({ DB: makeFactDb({ llmFlag: 'false' }) } as any)).toBe(false)
  })
})

// ---------------- captureFacts ----------------

describe('captureFacts — 결정적 추출 + 저장 + 그래프 연결', () => {
  test('사실 저장 + 동의 기본 0 + 엔티티/간선 연결', async () => {
    const db = makeFactDb({})
    const r = await captureFacts({ DB: db } as any, {
      text: '사용자는 "MyHub"를 2026-10-25에 만들었다. D1을 쓴다.',
    })
    expect(r.ok).toBe(true)
    expect(r.extraction).toBe('deterministic')
    expect(r.created).toHaveLength(2)
    // 동의 기본 0 — INSERT SQL 리터럴에 0, 0 명시 (바인딩 아님)
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO ai_memory_v2'))
    expect(ins).toBeDefined()
    expect(ins.sql).toContain('0, 0')
    expect(ins.sql).toContain("VALUES (?, 'fact'")
    // 엔티티 upsert + 연결 + 간선
    expect(db.calls.some((c) => c.sql.includes('INSERT OR IGNORE INTO memory_entities'))).toBe(true)
    expect(db.calls.some((c) => c.sql.includes('INSERT OR IGNORE INTO memory_fact_entities'))).toBe(true)
    expect(db.calls.some((c) => c.sql.includes('INSERT OR IGNORE INTO memory_relations'))).toBe(true)
    expect(r.entities).toContain('MyHub')
  })
  test('near-duplicate는 skipped (저장 안 함)', async () => {
    const db = makeFactDb({ existingContents: ['사용자는 등산을 좋아합니다'] })
    const r = await captureFacts({ DB: db } as any, {
      text: '사용자는 등산을 좋아합니다. 새로운 사실 문장입니다.',
    })
    expect(r.created).toHaveLength(1)
    expect(r.created![0].content).toBe('새로운 사실 문장입니다.')
    expect(r.skipped).toEqual(['사용자는 등산을 좋아합니다.'])
  })
  test('빈 텍스트 → 에러', async () => {
    const db = makeFactDb({})
    expect((await captureFacts({ DB: db } as any, { text: '   ' })).ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
  test('LLM 플래그 OFF면 llmExtract 주입돼도 호출 안 함', async () => {
    const db = makeFactDb({ llmFlag: 'false' })
    const llmExtract = jest.fn(async () => ['LLM 사실 문장입니다.'])
    const r = await captureFacts({ DB: db } as any, {
      text: '결정적 사실 문장입니다.',
      llmExtract,
    })
    expect(llmExtract).not.toHaveBeenCalled()
    expect(r.extraction).toBe('deterministic')
    expect(r.created![0].content).toBe('결정적 사실 문장입니다.')
  })
  test("LLM 플래그 ON이면 llmExtract 사용 (extraction='llm')", async () => {
    const db = makeFactDb({ llmFlag: 'true' })
    const llmExtract = jest.fn(async () => ['LLM 사실 문장입니다.'])
    const r = await captureFacts({ DB: db } as any, {
      text: '결정적 사실 문장입니다.',
      llmExtract,
    })
    expect(llmExtract).toHaveBeenCalledTimes(1)
    expect(r.extraction).toBe('llm')
    expect(r.created![0].content).toBe('LLM 사실 문장입니다.')
  })
  test('LLM 추출 실패 시 결정적 경로로 폴백', async () => {
    const db = makeFactDb({ llmFlag: 'true' })
    const llmExtract = jest.fn(async () => { throw new Error('llm down') })
    const r = await captureFacts({ DB: db } as any, {
      text: '결정적 사실 문장입니다.',
      llmExtract,
    })
    expect(r.extraction).toBe('deterministic')
    expect(r.created![0].content).toBe('결정적 사실 문장입니다.')
  })
  test('created_by=user 전달 + source 기록', async () => {
    const db = makeFactDb({})
    await captureFacts({ DB: db } as any, {
      text: '사용자 직접 저장 사실입니다.',
      createdBy: 'user',
      sourceType: 'conversation',
      sourceId: 7,
    })
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO ai_memory_v2'))
    expect(ins.params).toContain('user')
    expect(ins.params).toContain('conversation')
    expect(ins.params).toContain(7)
  })
})

// ---------------- captureFactsFromMemo ----------------

describe('captureFactsFromMemo — 잠긴 메모 경계', () => {
  test('잠긴 메모 → locked, 본문 조회 쿼리 없음', async () => {
    const db = makeFactDb({ memoLockRow: { id: 3, is_locked: 1 } })
    const r = await captureFactsFromMemo({ DB: db } as any, 3)
    expect(r).toEqual({ ok: false, error: 'locked' })
    // is_locked 확인 SELECT만 1회 — 본문 SELECT 없음, INSERT 없음
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).toContain('is_locked')
    expect(db.calls.some((c) => c.sql.includes('INSERT'))).toBe(false)
  })
  test('없는 메모 → not_found', async () => {
    const db = makeFactDb({ memoLockRow: null })
    expect(await captureFactsFromMemo({ DB: db } as any, 99)).toEqual({ ok: false, error: 'not_found' })
  })
  test('잘못된 ID → invalid_id (DB 조회 없음)', async () => {
    const db = makeFactDb({})
    expect((await captureFactsFromMemo({ DB: db } as any, 0)).ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
  test('잠금 해제 메모 → 잠긴 블록 제거 후 캡처 (비밀 내용 미포함)', async () => {
    const db = makeFactDb({
      memoLockRow: { id: 5, is_locked: 0 },
      memoRow: {
        text: '공개 사실 문장입니다. <span class="locked">비밀카드번호 1234</span> 다른 공개 문장입니다.',
        locked_blocks: null,
      },
    })
    const r = await captureFactsFromMemo({ DB: db } as any, 5)
    expect(r.ok).toBe(true)
    const inserted = db.calls
      .filter((c) => c.sql.includes('INSERT INTO ai_memory_v2'))
      .map((c) => c.params[0] as string)
    expect(inserted.join(' ')).not.toContain('비밀카드번호')
    expect(inserted.join(' ')).not.toContain('1234')
    expect(inserted.join(' ')).toContain('공개 사실 문장입니다.')
  })
})

// ---------------- expandGraphFacts / getRelatedFacts ----------------

describe('expandGraphFacts — 1-hop 확장', () => {
  const graphRows = (id: number, content: string, entityId: number) => ({
    id, content, category: 'fact', summary: null, entities: '[]',
    access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00Z', entity_id: entityId,
  })
  test('시드 엔티티 사실은 직접(+0.10), 이웃 엔티티 사실은 1-hop(+0.05)', async () => {
    const db = makeFactDb({
      seedEntities: [{ id: 1, name: '등산' }],
      relRows: [{ source_entity_id: 1, target_entity_id: 2 }],
      graphFactRows: [
        graphRows(10, '등산 직접 사실', 1),
        graphRows(11, '장비 이웃 사실', 2),
      ],
    })
    const out = await expandGraphFacts({ DB: db } as any, '등산')
    expect(out.map((r) => r.id)).toEqual([10, 11])
    expect(out[0].score!).toBeGreaterThan(out[1].score!)
  })
  test('시드 엔티티 없음 → []', async () => {
    const db = makeFactDb({ seedEntities: [] })
    expect(await expandGraphFacts({ DB: db } as any, '등산')).toEqual([])
  })
  test('동의 없는 사실은 그래프에서도 제외 (SQL 게이트)', async () => {
    const db = makeFactDb({
      seedEntities: [{ id: 1, name: '등산' }],
      relRows: [],
      graphFactRows: [graphRows(10, '등산 사실', 1)],
    })
    await expandGraphFacts({ DB: db } as any, '등산')
    const q = db.calls.find((c) => c.sql.includes('FROM memory_fact_entities fe'))
    expect(q.sql).toContain('allow_ai_use = 1')
    expect(q.sql).toContain('allow_provider_send = 1')
  })
})

describe('getRelatedFacts — FTS + 그래프 병합', () => {
  test('FTS에만 있는 사실 + 그래프에만 있는 사실 병합, 최대 5개', async () => {
    const db = makeFactDb({
      v2Flag: 'true',
      ftsRows: [ftsRow(1, 'FTS 사실', -9), ftsRow(2, '공통 사실', -5)],
      seedEntities: [{ id: 1, name: '공통' }],
      relRows: [],
      graphFactRows: [{
        id: 2, content: '공통 사실', category: 'fact', summary: null, entities: '[]',
        access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00Z', entity_id: 1,
      }, {
        id: 3, content: '그래프 전용 사실', category: 'fact', summary: null, entities: '[]',
        access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00Z', entity_id: 1,
      }],
    })
    const out = await getRelatedFacts({ DB: db } as any, '공통 테스트')
    expect(out.map((r) => r.id).sort()).toEqual([1, 2, 3])
    expect(out).toHaveLength(3)
    // 중복 id 2는 1개로 합쳐짐
    expect(out.filter((r) => r.id === 2)).toHaveLength(1)
    // 최종 선택 1회만 touch (batch 1회)
    expect(db.batchCalls).toHaveLength(1)
    expect(db.batchCalls[0]).toHaveLength(3)
  })
  test('상한 5개 — FTS 10개 후보 중 5개만', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ftsRow(i + 1, `사실${i + 1}`, -1))
    const db = makeFactDb({ v2Flag: 'true', ftsRows: rows, seedEntities: [] })
    const out = await getRelatedFacts({ DB: db } as any, '테스트 쿼리')
    expect(out).toHaveLength(5)
  })
  test('플래그 OFF → [] (touch 없음)', async () => {
    const db = makeFactDb({ v2Flag: 'false', ftsRows: [ftsRow(1, 'x')] })
    expect(await getRelatedFacts({ DB: db } as any, '테스트')).toEqual([])
    expect(db.batchCalls).toHaveLength(0)
  })
  test('플래그 OFF면 그래프 시드 있어도 [] (게이트 우회 없음)', async () => {
    const db = makeFactDb({
      v2Flag: 'false',
      ftsRows: [ftsRow(1, 'FTS 사실', -5)],
      seedEntities: [{ id: 1, name: '테스트' }],
      graphFactRows: [{
        id: 9, content: '그래프 사실', category: 'fact', summary: null, entities: '[]',
        access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00Z', entity_id: 1,
      }],
    })
    expect(await getRelatedFacts({ DB: db } as any, '테스트')).toEqual([])
    expect(db.batchCalls).toHaveLength(0)
    // 그래프 조회 쿼리 자체가 나가지 않음 (플래그 확인 SELECT만)
    expect(db.calls.some((c) => c.sql.includes('FROM memory_entities'))).toBe(false)
    expect(db.calls.some((c) => c.sql.includes('ai_memory_fts MATCH'))).toBe(false)
  })
  test('그래프 테이블 부재(예외) 시 FTS 결과만 사용', async () => {
    const db = makeFactDb({ v2Flag: 'true', ftsRows: [ftsRow(1, 'FTS 사실', -5)] })
    // expandGraphFacts가 던지도록: seedEntities 조회를 실패하게 만든다
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      if (sql.includes('FROM memory_entities WHERE')) {
        const origAll = stmt.all.bind(stmt)
        stmt.all = async () => { throw new Error('no such table: memory_entities') }
        return stmt
      }
      return stmt
    }
    const out = await getRelatedFacts({ DB: db } as any, '테스트')
    expect(out.map((r) => r.id)).toEqual([1])
  })
})

// ---------------- getFactNeighbors ----------------

describe('getFactNeighbors — 공유 엔티티 이웃', () => {
  const nRow = (id: number, content: string, entityId: number) => ({
    id, content, category: 'fact', summary: null, entities: '[]',
    access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00Z', entity_id: entityId,
  })
  test('공유 엔티티 많은 이웃이 먼저, 자기 자신 제외', async () => {
    const db = makeFactDb({
      neighborSeedIds: [1, 2],
      neighborFactRows: [
        nRow(20, '이웃 하나', 1),
        nRow(21, '이웃 둘', 1),
        nRow(21, '이웃 둘', 2),
      ],
    })
    const out = await getFactNeighbors({ DB: db } as any, 10)
    expect(out.map((r) => r.id)).toEqual([21, 20])
    expect(out[0].score).toBe(1) // 2/2 공유
    expect(out[1].score).toBe(0.5) // 1/2 공유
    expect(db.batchCalls).toHaveLength(1) // touch
  })
  test('잘못된 ID → []', async () => {
    const db = makeFactDb({})
    expect(await getFactNeighbors({ DB: db } as any, 0)).toEqual([])
    expect(db.calls).toHaveLength(0)
  })
  test('연결된 엔티티 없음 → []', async () => {
    const db = makeFactDb({ neighborSeedIds: [] })
    expect(await getFactNeighbors({ DB: db } as any, 10)).toEqual([])
  })
  test('동점 시 최신 이웃이 먼저', async () => {
    const db = makeFactDb({
      neighborSeedIds: [1],
      neighborFactRows: [
        { ...nRow(20, '오래된 이웃', 1), updated_at: '2026-10-20T00:00:00Z' },
        { ...nRow(21, '최신 이웃', 1), updated_at: '2026-10-25T00:00:00Z' },
      ],
    })
    const out = await getFactNeighbors({ DB: db } as any, 10)
    expect(out.map((r) => r.id)).toEqual([21, 20])
  })
  test('동의 게이트 포함', async () => {
    const db = makeFactDb({
      neighborSeedIds: [1],
      neighborFactRows: [nRow(20, '이웃', 1)],
    })
    await getFactNeighbors({ DB: db } as any, 10)
    const q = db.calls.find((c) => c.sql.includes('FROM memory_fact_entities fe'))
    expect(q.sql).toContain('allow_ai_use = 1')
    expect(q.sql).toContain('fe.fact_id <> ?')
  })
})
