/// <reference types="jest" />
/**
 * unified-search.ts 커버리지 테스트
 * - normalizeSearchLimit: 기본값/상한/무효값
 * - unifiedSearch: 빈 쿼리/200자 초과, 메모 FTS→LIKE, chat/schedule/todo, types 필터, 정렬
 */
import { normalizeSearchLimit, unifiedSearch } from '../../src/services/unified-search'

function makeDb(handlers: Record<string, any[] | 'throw'>) {
  return {
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async all() {
          for (const [key, val] of Object.entries(handlers)) {
            if (sql.includes(key)) {
              if (val === 'throw') throw new Error('db boom')
              return { results: val }
            }
          }
          return { results: [] }
        },
      }
    },
  }
}

describe('normalizeSearchLimit', () => {
  test('undefined/null/빈문자열 → 20', () => {
    expect(normalizeSearchLimit(undefined)).toBe(20)
    expect(normalizeSearchLimit(null)).toBe(20)
    expect(normalizeSearchLimit('')).toBe(20)
    expect(normalizeSearchLimit('   ')).toBe(20)
  })
  test('정상값', () => {
    expect(normalizeSearchLimit(10)).toBe(10)
    expect(normalizeSearchLimit('30')).toBe(30)
  })
  test('상한 100', () => {
    expect(normalizeSearchLimit(500)).toBe(100)
    expect(normalizeSearchLimit(100)).toBe(100)
  })
  test('무효값 → 20', () => {
    expect(normalizeSearchLimit(0)).toBe(20)
    expect(normalizeSearchLimit(-5)).toBe(20)
    expect(normalizeSearchLimit(1.5)).toBe(20)
    expect(normalizeSearchLimit('abc')).toBe(20)
    expect(normalizeSearchLimit(NaN)).toBe(20)
    expect(normalizeSearchLimit(Infinity)).toBe(20)
  })
})

describe('unifiedSearch', () => {
  test('빈 쿼리 → []', async () => {
    const db = makeDb({})
    expect(await unifiedSearch(db as any, { query: '' })).toEqual([])
    expect(await unifiedSearch(db as any, { query: '   ' })).toEqual([])
    expect(await unifiedSearch(db as any, {} as any)).toEqual([])
  })

  test('200자 초과 → []', async () => {
    const db = makeDb({})
    expect(await unifiedSearch(db as any, { query: 'x'.repeat(201) })).toEqual([])
  })

  test('메모 FTS 히트 (rank 1.0)', async () => {
    const db = makeDb({
      'memos_fts MATCH': [{ id: 1, text: '회의 내용입니다', created_at: '2026-10-17', is_locked: 0, sensitivity: 0 }],
    })
    const out = await unifiedSearch(db as any, { query: '회의', types: ['memo'] })
    expect(out).toHaveLength(1)
    expect(out[0].source_type).toBe('memo')
    expect(out[0].rank).toBe(1.0)
    expect(out[0].title).toBe('회의 내용입니다'.slice(0, 50))
  })

  test('메모 FTS throw → LIKE 폴백 (rank 0.5)', async () => {
    const db = makeDb({
      'memos_fts MATCH': 'throw',
      'FROM memos': [{ id: 2, text: 'like 결과', created_at: '2026-10-16' }],
    })
    const out = await unifiedSearch(db as any, { query: '회의', types: ['memo'] })
    expect(out).toHaveLength(1)
    expect(out[0].rank).toBe(0.5)
    expect(out[0].source_id).toBe(2)
  })

  test('FTS 토큰 없음(1글자) → LIKE 직접', async () => {
    const db = makeDb({
      'FROM memos': [{ id: 3, text: '가', created_at: '2026-10-15' }],
    })
    const out = await unifiedSearch(db as any, { query: '가', types: ['memo'] })
    expect(out).toHaveLength(1)
  })

  test('chat 검색', async () => {
    const db = makeDb({
      'FROM ai_chats': [{ id: 10, persona_id: 'lumi', content: '안녕하세요 반갑습니다', created_at: '2026-10-17' }],
    })
    const out = await unifiedSearch(db as any, { query: '안녕', types: ['chat'] })
    expect(out).toHaveLength(1)
    expect(out[0].source_type).toBe('chat')
    expect(out[0].title).toContain('[lumi]')
  })

  test('todo description 빈문자열/긴설명', async () => {
    const db = makeDb({
      'FROM todos': [
        { id: 31, title: 't1', description: '', due_at: null, created_at: '2026-10-17' },
        { id: 32, title: 't2', description: 'z'.repeat(300), due_at: null, created_at: '2026-10-17' },
      ],
    })
    const out = await unifiedSearch(db as any, { query: '할일', types: ['todo'] })
    expect(out.find((r) => r.source_id === 31)!.snippet).toBe('')
    expect(out.find((r) => r.source_id === 32)!.snippet.length).toBe(200)
  })

  test('schedule description 있음', async () => {
    const db = makeDb({
      'FROM schedules': [{ id: 20, title: '회의', description: null, start_at: '2026-10-18' }],
    })
    const out = await unifiedSearch(db as any, { query: '회의', types: ['schedule'] })
    expect(out).toHaveLength(1)
    expect(out[0].snippet).toBe('')
    expect(out[0].created_at).toBe('2026-10-18')
  })

  test('todo 검색', async () => {
    const db = makeDb({
      'FROM todos': [{ id: 30, title: '할일', description: '설명', due_at: '2026-10-19', created_at: '2026-10-17' }],
    })
    const out = await unifiedSearch(db as any, { query: '할일', types: ['todo'] })
    expect(out).toHaveLength(1)
    expect(out[0].source_type).toBe('todo')
  })

  test('types 미지정 → 전체 4종', async () => {
    const db = makeDb({
      'memos_fts MATCH': [{ id: 1, text: 't', created_at: '2026-10-17', is_locked: 0, sensitivity: 0 }],
      'FROM ai_chats': [{ id: 2, persona_id: 'p', content: 'c', created_at: '2026-10-17' }],
      'FROM schedules': [{ id: 3, title: 't', description: 'd', start_at: '2026-10-17' }],
      'FROM todos': [{ id: 4, title: 't', description: 'd', due_at: null, created_at: '2026-10-17' }],
    })
    const out = await unifiedSearch(db as any, { query: '테스트' })
    const types = out.map((r) => r.source_type)
    expect(types).toContain('memo')
    expect(types).toContain('chat')
    expect(types).toContain('schedule')
    expect(types).toContain('todo')
  })

  test('정렬: rank 우선, 동점이면 최신순', async () => {
    const db = makeDb({
      'memos_fts MATCH': [
        { id: 1, text: 'a', created_at: '2026-10-15', is_locked: 0, sensitivity: 0 },
      ],
      'FROM ai_chats': [
        { id: 2, persona_id: 'p', content: 'b', created_at: '2026-10-17' },
        { id: 3, persona_id: 'p', content: 'c', created_at: '2026-10-16' },
      ],
    })
    const out = await unifiedSearch(db as any, { query: '테스트' })
    // memo rank 1.0이 맨 앞
    expect(out[0].source_type).toBe('memo')
    // chat끼리는 최신순
    expect(out[1].source_id).toBe(2)
    expect(out[2].source_id).toBe(3)
  })

  test('limit 적용', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i, persona_id: 'p', content: `c${i}`, created_at: '2026-10-17',
    }))
    const db = makeDb({ 'FROM ai_chats': rows })
    const out = await unifiedSearch(db as any, { query: '테스트', types: ['chat'], limit: 3 })
    expect(out).toHaveLength(3)
  })

  test('LIKE 이스케이프 (%, _, \\)', async () => {
    const db = makeDb({ 'FROM ai_chats': [] })
    let boundPattern = ''
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      const origBind = stmt.bind.bind(stmt)
      stmt.bind = (...p: any[]) => { boundPattern = p[0]; return origBind(...p) }
      return stmt
    }
    await unifiedSearch(db as any, { query: '100%_test\\', types: ['chat'] })
    expect(boundPattern).toBe('%100\\%\\_test\\\\%')
  })

  test('메모 snippet 200자 절단', async () => {
    const long = 'x'.repeat(500)
    const db = makeDb({
      'memos_fts MATCH': [{ id: 1, text: long, created_at: '2026-10-17', is_locked: 0, sensitivity: 0 }],
    })
    const out = await unifiedSearch(db as any, { query: '테스트', types: ['memo'] })
    expect(out[0].snippet.length).toBe(200)
    expect(out[0].title.length).toBe(50)
  })
})
