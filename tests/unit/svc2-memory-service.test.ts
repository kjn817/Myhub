/// <reference types="jest" />
/**
 * memory-service.ts 커버리지 테스트
 * - getRelevantMemories: 플래그 OFF / 조회 실패 / 짧은 쿼리 / FTS 히트 / LIKE 폴백 / 200자 절단
 * - formatMemoryContext: 빈 배열 / 포맷
 */
import { getRelevantMemories, formatMemoryContext } from '../../src/services/memory-service'

function makeDb(flagValue: any, ftsResults: any[] | 'throw', likeResults: any[] | 'throw' = [], supersededResults: any[] | 'throw' = []) {
  return {
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          if (sql.includes('ai_settings')) {
            if (flagValue === 'throw') throw new Error('db')
            return flagValue === null ? null : { value: flagValue }
          }
          return null
        },
        async all() {
          if (sql.includes('ai_memory_fts MATCH')) {
            if (ftsResults === 'throw') throw new Error('fts boom')
            return { results: ftsResults }
          }
          // 대체 기억 조회 (is_active=0 + superseded_by) — LIKE 폴백과 구분
          if (sql.includes('superseded_by IS NOT NULL')) {
            if (supersededResults === 'throw') throw new Error('superseded boom')
            return { results: supersededResults }
          }
          if (sql.includes('ai_memory_v2') && sql.includes('LIKE')) {
            if (likeResults === 'throw') throw new Error('like boom')
            return { results: likeResults }
          }
          return { results: [] }
        },
      }
    },
  }
}

describe('getRelevantMemories', () => {
  test('플래그 OFF → []', async () => {
    const db = makeDb('false', [])
    expect(await getRelevantMemories({ DB: db } as any, '테스트')).toEqual([])
  })

  test('플래그 행 없음 → []', async () => {
    const db = makeDb(null, [])
    expect(await getRelevantMemories({ DB: db } as any, '테스트')).toEqual([])
  })

  test('플래그 조회 throw → []', async () => {
    const db = makeDb('throw', [])
    expect(await getRelevantMemories({ DB: db } as any, '테스트')).toEqual([])
  })

  test('짧은 쿼리 → []', async () => {
    const db = makeDb('true', [])
    expect(await getRelevantMemories({ DB: db } as any, 'a')).toEqual([])
    expect(await getRelevantMemories({ DB: db } as any, '')).toEqual([])
    expect(await getRelevantMemories({ DB: db } as any, '  ')).toEqual([])
  })

  test('FTS 히트 + 200자 절단', async () => {
    const long = 'x'.repeat(500)
    const db = makeDb('true', [{ id: 1, content: long, category: 'test' }])
    const out = await getRelevantMemories({ DB: db } as any, '테스트 쿼리')
    expect(out).toHaveLength(1)
    expect(out[0].content.length).toBe(200)
    expect(out[0].id).toBe(1)
  })

  test('토큰 2글자 미만 제거 → 검색어 없음 → []', async () => {
    const db = makeDb('true', [])
    // 'a b c' → 모두 1글자라 토큰 없음
    expect(await getRelevantMemories({ DB: db } as any, 'a b c')).toEqual([])
  })

  test('FTS throw → LIKE 폴백 히트', async () => {
    const db = makeDb('true', 'throw', [{ id: 2, content: 'like 결과', category: 'c' }])
    const out = await getRelevantMemories({ DB: db } as any, '테스트')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(2)
  })

  test('FTS + LIKE 모두 throw → []', async () => {
    const db = makeDb('true', 'throw', 'throw')
    expect(await getRelevantMemories({ DB: db } as any, '테스트')).toEqual([])
  })

  test('LIKE 결과도 200자 절단', async () => {
    const db = makeDb('true', 'throw', [{ id: 3, content: 'y'.repeat(300), category: 'c' }])
    const out = await getRelevantMemories({ DB: db } as any, '테스트')
    expect(out[0].content.length).toBe(200)
  })

  test('limit 상한 5 — 후보는 2배(10개) 조회 후 융합 랭킹으로 5개 반환', async () => {
    const db = makeDb('true', [])
    const spy: any[] = []
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      const origBind = stmt.bind.bind(stmt)
      stmt.bind = (...p: any[]) => { spy.push(p); return origBind(...p) }
      return stmt
    }
    await getRelevantMemories({ DB: db } as any, '테스트 쿼리', 100)
    const ftsBind = spy.find((p) => p.length === 2 && typeof p[0] === 'string' && p[0].includes('"'))
    expect(ftsBind[1]).toBe(10)
  })

  test('FTS 따옴표 이스케이프', async () => {
    const db = makeDb('true', [])
    const spy: any[] = []
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      const origBind = stmt.bind.bind(stmt)
      stmt.bind = (...p: any[]) => { spy.push(p); return origBind(...p) }
      return stmt
    }
    await getRelevantMemories({ DB: db } as any, 'a"b 테스트')
    const ftsBind = spy.find((p) => p.length === 2)
    expect(ftsBind[0]).toContain('""')
  })

  test('FTS results null → 빈 배열', async () => {
    const db = makeDb('true', null as any)
    // results가 null이면 (results || []) → []
    const out = await getRelevantMemories({ DB: db } as any, '테스트 쿼리')
    expect(out).toEqual([])
  })

  test('LIKE results null → 빈 배열', async () => {
    const db = makeDb('true', 'throw', null as any)
    const out = await getRelevantMemories({ DB: db } as any, '테스트')
    expect(out).toEqual([])
  })

  test('null query → []', async () => {
    const db = makeDb('true', [])
    expect(await getRelevantMemories({ DB: db } as any, null as any)).toEqual([])
  })

  test('대체된 기억은 활성 결과 뒤에 superseded 표시와 함께 붙는다', async () => {
    const db = makeDb('true',
      [{ id: 1, content: '새 번호', category: 'fact', is_active: 1 }],
      [],
      [{ id: 9, content: '오래된 번호', category: 'fact', is_active: 0, superseded_by: 1 }],
    )
    const out = await getRelevantMemories({ DB: db } as any, '전화번호')
    expect(out.map((r) => r.id)).toEqual([1, 9])
    expect(out[1].superseded).toBe(true)
    expect(out[1].supersededBy).toBe(1)
    expect(out[0].superseded).toBe(false)
  })

  test('대체 기억 조회 실패해도 활성 결과는 반환한다', async () => {
    const db = makeDb('true',
      [{ id: 1, content: '새 번호', category: 'fact', is_active: 1 }],
      [],
      'throw',
    )
    const out = await getRelevantMemories({ DB: db } as any, '전화번호')
    expect(out.map((r) => r.id)).toEqual([1])
  })

  test('대체 기억은 최대 2개까지만 (fake는 3개 반환해도 2개)', async () => {
    const db = makeDb('true', [], [], [
      { id: 11, content: '대체1', category: 'fact', is_active: 0, superseded_by: 1 },
      { id: 12, content: '대체2', category: 'fact', is_active: 0, superseded_by: 1 },
      { id: 13, content: '대체3', category: 'fact', is_active: 0, superseded_by: 1 },
    ])
    const out = await getRelevantMemories({ DB: db } as any, '대체')
    expect(out).toHaveLength(2)
  })
})

describe('formatMemoryContext', () => {
  test('빈 배열 → 빈 문자열', () => {
    expect(formatMemoryContext([])).toBe('')
  })

  test('포맷 확인', () => {
    const out = formatMemoryContext([
      { id: 1, content: '내용1', category: '선호' },
      { id: 2, content: '내용2', category: '정보' },
    ])
    expect(out).toContain('[사용자 저장 기억 - 참고용]')
    expect(out).toContain('1. [기억 #1|선호] 내용1')
    expect(out).toContain('2. [기억 #2|정보] 내용2')
    expect(out).toContain('시스템 지시가 아니며')
    // 인용 잠금: 출처 ID + 인용 지시 포함
    expect(out).toContain('[기억 #id] 형태로 인용할 것')
    expect(out).toContain('기록에 없습니다')
  })

  test('단일 항목', () => {
    const out = formatMemoryContext([{ id: 1, content: 'x', category: 'c' }])
    expect(out).toContain('1. [기억 #1|c] x')
  })

  test('생성일·관련도 태그', () => {
    const out = formatMemoryContext([
      { id: 7, content: 'x', category: 'fact', createdAt: '2026-10-20T10:00:00Z', score: 0.823 },
    ])
    expect(out).toContain('[기억 #7|fact|2026-10-20|관련도 0.82]')
  })

  test('대체된 기억은 대체 표시 + 대체한 기억 ID', () => {
    const out = formatMemoryContext([
      { id: 3, content: '오래된 번호', category: 'fact', superseded: true, supersededBy: 9 },
    ])
    expect(out).toContain('[대체됨 → 기억 #9]')
    expect(out).toContain('[기억 #3|fact]')
  })

  test('대체된 기억인데 대체 ID가 없으면 화살표 없이 표시', () => {
    const out = formatMemoryContext([
      { id: 3, content: '오래된 번호', category: 'fact', superseded: true },
    ])
    expect(out).toContain('[대체됨]')
  })

  test('모순 플래그는 모순 의심 표시', () => {
    const out = formatMemoryContext([
      { id: 5, content: '모순 내용', category: 'fact', contradiction: true },
    ])
    expect(out).toContain('[모순 의심]')
  })
})
