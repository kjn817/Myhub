/// <reference types="jest" />
/**
 * ai-access.ts 커버리지 테스트
 * - searchAccessibleMemos: FTS5 → 키워드 FTS 1회(OR 병합) → LIKE(원본 1회) → 빈결과, 에러
 * - getAccessibleMemo: 단건 조회 / 잠금·민감도 제외 / 에러
 * - sanitizeForAI: 잠금 블록 제거 / 시크릿 마스킹
 *
 * 내부 함수(escapeFts5Query, extractKeywords)는 export되지 않아
 * searchAccessibleMemos의 쿼리 바인딩을 통해 간접 검증.
 */
import {
  searchAccessibleMemos,
  getAccessibleMemo,
  sanitizeForAI,
} from '../../src/services/ai-access'

// ---- MockDb: SQL 패턴별 결과 큐 ----
function makeDb(handlers: Array<{ match: (sql: string, params: any[]) => boolean; result: any }>) {
  const calls: any[] = []
  const db = {
    calls,
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...params: any[]) {
          this._params = params
          return this
        },
        async all() {
          calls.push({ sql: this._sql, params: this._params, op: 'all' })
          for (const h of handlers) {
            if (h.match(this._sql, this._params)) return h.result
          }
          return { results: [] }
        },
        async first() {
          calls.push({ sql: this._sql, params: this._params, op: 'first' })
          for (const h of handlers) {
            if (h.match(this._sql, this._params)) return h.result
          }
          return null
        },
      }
    },
  }
  return db
}

const ftsHas = (results: any[]) => ({
  match: (sql: string) => sql.includes('memos_fts MATCH'),
  result: { results },
})
const likeHas = (results: any[]) => ({
  match: (sql: string) => sql.includes('text LIKE'),
  result: { results },
})

describe('searchAccessibleMemos', () => {
  test('빈 쿼리 → []', async () => {
    const db = makeDb([])
    expect(await searchAccessibleMemos({ DB: db } as any, '   ')).toEqual([])
    expect(await searchAccessibleMemos({ DB: db } as any, '')).toEqual([])
  })

  test('1차 FTS5 히트', async () => {
    const db = makeDb([ftsHas([{ id: 1, snippet: '회의 내용\n두번째줄', sensitivity: 0 }])])
    const out = await searchAccessibleMemos({ DB: db } as any, '회의')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(1)
    expect(out[0].title).toBe('회의 내용')
  })

  test('FTS5 특수문자 이스케이프 (AND/따옴표)', async () => {
    const db = makeDb([ftsHas([]), likeHas([{ id: 2, snippet: 'x', sensitivity: 0 }])])
    // 쿼리에 FTS 특수문자가 있어도 에러 없이 LIKE 폴백까지 진행
    const out = await searchAccessibleMemos({ DB: db } as any, 'a AND "b" (c)')
    expect(out).toHaveLength(1)
    // FTS 바인딩이 이스케이프되었는지 확인
    const ftsCall = db.calls.find((c: any) => c.sql.includes('memos_fts MATCH'))
    expect(ftsCall.params[0]).toBe('"a" "AND" """b""" "(c)"')
  })

  test('1차 실패 → 키워드 FTS 재검색 히트', async () => {
    let ftsCount = 0
    const db = makeDb([
      {
        match: (sql: string) => sql.includes('memos_fts MATCH'),
        result: null as any, // 동적 처리 위해 아래에서 오버라이드
      },
    ])
    // 수동 핸들러: 첫 FTS는 빈 결과, 키워드 FTS는 히트
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      const origAll = stmt.all.bind(stmt)
      stmt.all = async () => {
        if (sql.includes('memos_fts MATCH')) {
          ftsCount++
          if (ftsCount === 1) return { results: [] }
          return { results: [{ id: 3, snippet: '키워드 히트', sensitivity: 0 }] }
        }
        return origAll()
      }
      return stmt
    }
    // '방금 만든 회의 준비 메모 찾아줘' → 키워드: 회의, 준비
    const out = await searchAccessibleMemos({ DB: db } as any, '방금 만든 회의 준비 메모 찾아줘')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(3)
  })

  test('FTS 전부 실패 → LIKE 히트', async () => {
    const db = makeDb([ftsHas([]), likeHas([{ id: 4, snippet: 'LIKE 결과', sensitivity: 0 }])])
    const out = await searchAccessibleMemos({ DB: db } as any, '없는키워드xyz')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(4)
  })

  test('키워드 FTS는 OR로 1회 병합된다 (P-4)', async () => {
    const db = makeDb([ftsHas([]), likeHas([])])
    // '방금 만든 회의 준비 메모 찾아줘' → 키워드: 회의, 준비
    await searchAccessibleMemos({ DB: db } as any, '방금 만든 회의 준비 메모 찾아줘')
    const ftsCalls = db.calls.filter((c: any) => c.sql.includes('memos_fts MATCH'))
    // 1차(원본 쿼리) + 2차(키워드 OR 병합) = 2회, 키워드별 순차 실행 없음
    expect(ftsCalls).toHaveLength(2)
    expect(ftsCalls[1].params[0]).toBe('"회의" OR "준비"')
  })

  test('전체 왕복은 최대 3회다 (P-4: FTS 2회 + LIKE 1회)', async () => {
    const db = makeDb([ftsHas([]), likeHas([])])
    const out = await searchAccessibleMemos({ DB: db } as any, '회의 준비 메모')
    expect(out).toEqual([])
    expect(db.calls).toHaveLength(3)
    const likeCalls = db.calls.filter((c: any) => c.sql.includes('text LIKE'))
    expect(likeCalls).toHaveLength(1)
    expect(likeCalls[0].params[0]).toBe('%회의 준비 메모%')
  })

  test('LIKE 실패 → 키워드 LIKE 없음, [] 반환 (P-4: 키워드 LIKE 제거)', async () => {
    const db = makeDb([ftsHas([]), likeHas([])])
    const out = await searchAccessibleMemos({ DB: db } as any, '회의 준비')
    expect(out).toEqual([])
    // LIKE는 원본 쿼리 1회만 실행된다
    const likeCalls = db.calls.filter((c: any) => c.sql.includes('text LIKE'))
    expect(likeCalls).toHaveLength(1)
  })

  test('키워드 FTS throw → catch 무시하고 LIKE로 진행', async () => {
    let ftsCount = 0
    const db = makeDb([likeHas([{ id: 8, snippet: 'like fallback', sensitivity: 0 }])])
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      const origAll = stmt.all.bind(stmt)
      stmt.all = async () => {
        if (sql.includes('memos_fts MATCH')) {
          ftsCount++
          if (ftsCount === 1) return { results: [] }
          throw new Error('fts boom') // 키워드 FTS 실패 → 빈 catch
        }
        return origAll()
      }
      return stmt
    }
    const out = await searchAccessibleMemos({ DB: db } as any, '회의 준비')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(8)
  })

  test('전부 실패 → []', async () => {
    const db = makeDb([ftsHas([]), likeHas([])])
    expect(await searchAccessibleMemos({ DB: db } as any, 'zzz')).toEqual([])
  })

  test('DB 에러 → []', async () => {
    const db = { prepare() { throw new Error('boom') } }
    expect(await searchAccessibleMemos({ DB: db } as any, '회의')).toEqual([])
  })

  test('키워드 추출 불가 쿼리 (불용어만) → LIKE만 시도', async () => {
    const db = makeDb([ftsHas([]), likeHas([])])
    // '메모 찾아줘' → 불용어 제거 후 키워드 없음
    const out = await searchAccessibleMemos({ DB: db } as any, '메모 찾아줘')
    expect(out).toEqual([])
    // FTS는 1차만 (원본 쿼리), 키워드 루프 없음
    const ftsCalls = db.calls.filter((c: any) => c.sql.includes('memos_fts MATCH'))
    expect(ftsCalls).toHaveLength(1)
  })

  test('제목 없음 → "제목 없음"', async () => {
    const db = makeDb([ftsHas([{ id: 6, snippet: '\n\n   \n', sensitivity: 0 }])])
    const out = await searchAccessibleMemos({ DB: db } as any, 'x')
    expect(out[0].title).toBe('제목 없음')
  })

  test('snippet 50자 초과 → 잘림', async () => {
    const long = '가'.repeat(100)
    const db = makeDb([ftsHas([{ id: 7, snippet: long, sensitivity: 0 }])])
    const out = await searchAccessibleMemos({ DB: db } as any, 'x')
    expect(out[0].title.length).toBe(50)
  })

  test('limit 전달', async () => {
    const db = makeDb([ftsHas([{ id: 1, snippet: 'a', sensitivity: 0 }])])
    await searchAccessibleMemos({ DB: db } as any, 'x', 10)
    const ftsCall = db.calls.find((c: any) => c.sql.includes('memos_fts MATCH'))
    expect(ftsCall.params[1]).toBe(10)
  })
})

describe('getAccessibleMemo', () => {
  test('정상 조회', async () => {
    const db = makeDb([
      {
        match: (sql: string) => sql.includes('FROM memos'),
        result: { id: 1, text: '첫줄\n본문', sensitivity: 0, locked_blocks: null },
      },
    ])
    const out = await getAccessibleMemo({ DB: db } as any, 1)
    expect(out).not.toBeNull()
    expect(out!.id).toBe(1)
    expect(out!.title).toBe('첫줄')
    expect(out!.content).toContain('본문')
  })

  test('잠금/민감도 조건 불일치 → null', async () => {
    const db = makeDb([])
    expect(await getAccessibleMemo({ DB: db } as any, 999)).toBeNull()
  })

  test('DB 에러 → null', async () => {
    const db = { prepare() { throw new Error('x') } }
    expect(await getAccessibleMemo({ DB: db } as any, 1)).toBeNull()
  })

  test('빈 텍스트 → 제목 없음', async () => {
    const db = makeDb([
      {
        match: (sql: string) => sql.includes('FROM memos'),
        result: { id: 2, text: '', sensitivity: 0, locked_blocks: null },
      },
    ])
    const out = await getAccessibleMemo({ DB: db } as any, 2)
    expect(out!.title).toBe('제목 없음')
  })
})

describe('sanitizeForAI', () => {
  // 참고: 203행의 catch → return '' 분기는 도달 불가 방어 코드.
  // String.replace는 정규식 실행 중 throw하지 않으므로 테스트로触发 불가.
  // (소스 수정 없이 커버 불가 — fail-closed 설계상 유지)
  test('일반 텍스트 그대로', () => {
    expect(sanitizeForAI('hello world')).toBe('hello world')
  })

  test('class="locked" span 제거', () => {
    const out = sanitizeForAI('<span class="locked">비밀</span> 공개')
    expect(out).not.toContain('비밀')
    expect(out).toContain('[LOCKED_BLOCK]')
    expect(out).toContain('공개')
  })

  test('data-locked="true" div 제거', () => {
    const out = sanitizeForAI('<div data-locked="true">숨김</div> 보임')
    expect(out).not.toContain('숨김')
    expect(out).toContain('[LOCKED_BLOCK]')
  })

  test('대소문자 무관', () => {
    const out = sanitizeForAI('<SPAN CLASS="LOCKED">X</SPAN>')
    expect(out).toContain('[LOCKED_BLOCK]')
  })

  test('lockedBlocksJson 인자 무시됨 (시그니처 유지)', () => {
    // 두 번째 인자는 현재 미사용이지만 시그니처상 존재
    expect(sanitizeForAI('abc', '{"a":1}')).toBe('abc')
  })
})
