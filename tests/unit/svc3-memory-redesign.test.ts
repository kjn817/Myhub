/// <reference types="jest" />
/**
 * 0044 장기 메모리 재설계 단위 테스트
 * - 순수 헬퍼: sanitize / normalize / extractCoreFact / decayTier / fusionScore /
 *   parseEntities / extractSearchTerms / buildFtsQuery
 * - getRelevantMemories: 융합 랭킹 + 접근 기록(touch) + LIKE 폴백 랭킹
 * - buildMemoryPage / supersedeMemory / restoreMemory / markContradiction
 * - createHandoff / claimHandoff (claim-once)
 * - formatMemoryContext: cold/archived는 요약 주입
 */
import {
  sanitizeMemoryContent,
  normalizeForDuplicate,
  extractCoreFact,
  decayTier,
  fusionScore,
  parseEntities,
  extractSearchTerms,
  buildFtsQuery,
  getRelevantMemories,
  formatMemoryContext,
  buildMemoryPage,
  supersedeMemory,
  restoreMemory,
  markContradiction,
  createHandoff,
  claimHandoff,
  generateClaimToken,
} from '../../src/services/memory-service'

describe('sanitizeMemoryContent', () => {
  test('제어 문자 제거 + 빈 줄 축소 + trim', () => {
    expect(sanitizeMemoryContent('a\x00b\x07c\n\n\n\nd  ')).toBe('abc\n\nd')
  })
  test('제어 문자 제거', () => {
    expect(sanitizeMemoryContent('a\x00b\x07c')).toBe('abc')
  })
  test('3개 이상 빈 줄 → 2개', () => {
    expect(sanitizeMemoryContent('a\n\n\n\nb')).toBe('a\n\nb')
  })
  test('탭·줄바꿈은 유지', () => {
    expect(sanitizeMemoryContent('a\tb\nc')).toBe('a\tb\nc')
  })
  test('maxLen 절단', () => {
    expect(sanitizeMemoryContent('abcdefgh', 3)).toBe('abc')
  })
  test('빈 입력 → 빈 문자열', () => {
    expect(sanitizeMemoryContent('')).toBe('')
    expect(sanitizeMemoryContent('   ')).toBe('')
  })
})

describe('normalizeForDuplicate', () => {
  test('대소문자·공백·구두점 무시', () => {
    expect(normalizeForDuplicate('내일 10시, 회의!')).toBe(normalizeForDuplicate('내일10시회의'))
    expect(normalizeForDuplicate('Hello World')).toBe('helloworld')
  })
  test('한글 유지', () => {
    expect(normalizeForDuplicate('김정남')).toBe('김정남')
  })
  test('빈 입력 → 빈 문자열', () => {
    expect(normalizeForDuplicate('')).toBe('')
  })
})

describe('extractCoreFact', () => {
  test('첫 문장 추출', () => {
    expect(extractCoreFact('첫 문장입니다. 둘째 문장입니다.')).toBe('첫 문장입니다.')
    expect(extractCoreFact('첫 줄\n둘째 줄')).toBe('첫 줄')
  })
  test('마침표 없으면 200자 절단', () => {
    const long = 'x'.repeat(300)
    expect(extractCoreFact(long)).toBe('x'.repeat(200))
  })
  test('빈 입력 → 빈 문자열', () => {
    expect(extractCoreFact('')).toBe('')
    expect(extractCoreFact('   ')).toBe('')
  })
})

describe('decayTier', () => {
  const NOW = Date.parse('2026-10-25T00:00:00Z')
  const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString()
  test('7일 이내 → hot', () => {
    expect(decayTier(0, daysAgo(0), NOW)).toBe('hot')
    expect(decayTier(0, daysAgo(7), NOW)).toBe('hot')
  })
  test('8~30일 → warm, 접근 5회 이상이면 hot 유지', () => {
    expect(decayTier(0, daysAgo(30), NOW)).toBe('warm')
    expect(decayTier(5, daysAgo(30), NOW)).toBe('hot')
    expect(decayTier(4, daysAgo(30), NOW)).toBe('warm')
  })
  test('31~90일 → cold, 접근 10회 이상이면 warm', () => {
    expect(decayTier(0, daysAgo(90), NOW)).toBe('cold')
    expect(decayTier(10, daysAgo(90), NOW)).toBe('warm')
    expect(decayTier(9, daysAgo(90), NOW)).toBe('cold')
  })
  test('90일 초과 → archived', () => {
    expect(decayTier(100, daysAgo(91), NOW)).toBe('archived')
  })
  test('활동 기록 없음 → archived', () => {
    expect(decayTier(0, null, NOW)).toBe('archived')
    expect(decayTier(0, undefined, NOW)).toBe('archived')
  })
})

describe('fusionScore', () => {
  test('FTS 관련 높을수록 점수 높음', () => {
    const a = fusionScore({ ftsRank: -10, ageDays: 0, accessCount: 0 })
    const b = fusionScore({ ftsRank: -1, ageDays: 0, accessCount: 0 })
    const c = fusionScore({ ftsRank: null, ageDays: 0, accessCount: 0 })
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })
  test('엔티티 일치 시 가산', () => {
    const a = fusionScore({ ftsRank: -5, entityMatches: 2, entityTotal: 2, ageDays: 0 })
    const b = fusionScore({ ftsRank: -5, entityMatches: 0, entityTotal: 2, ageDays: 0 })
    expect(a).toBeGreaterThan(b)
  })
  test('오래된 기억은 감점', () => {
    const a = fusionScore({ ftsRank: -5, ageDays: 0 })
    const b = fusionScore({ ftsRank: -5, ageDays: 365 })
    expect(a).toBeGreaterThan(b)
  })
  test('점수는 0~1 범위', () => {
    for (const s of [
      fusionScore({ ftsRank: -100, entityMatches: 10, entityTotal: 10, ageDays: 0, accessCount: 100 }),
      fusionScore({ ftsRank: 0, ageDays: 9999 }),
      fusionScore({}),
    ]) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe('parseEntities', () => {
  test('JSON 문자열 파싱', () => {
    expect(parseEntities('["a","b"]')).toEqual(['a', 'b'])
  })
  test('배열 그대로', () => {
    expect(parseEntities(['a', 1, 'b'])).toEqual(['a', 'b'])
  })
  test('잘못된 입력 → []', () => {
    expect(parseEntities('not json')).toEqual([])
    expect(parseEntities('{"a":1}')).toEqual([])
    expect(parseEntities(null)).toEqual([])
    expect(parseEntities('')).toEqual([])
  })
})

describe('extractSearchTerms / buildFtsQuery', () => {
  test('2글자 이상, 최대 5개', () => {
    expect(extractSearchTerms('a bb ccc dddd eeee ffff gggg')).toEqual(['bb', 'ccc', 'dddd', 'eeee', 'ffff'])
  })
  test('따옴표 이스케이프', () => {
    expect(buildFtsQuery('a"b 테스트')).toContain('""')
    expect(buildFtsQuery('테스트 쿼리')).toBe('"테스트" OR "쿼리"')
  })
  test('토큰은 OR로 결합한다 (다단어 질문 매칭)', () => {
    expect(buildFtsQuery('내 반려견 이름이 뭐야?')).toBe(
      '"반려견" OR "이름이" OR "이름"* OR "뭐야?"'
    )
  })
  test('조사 제거 어간은 접두사 검색으로 함께 넣는다', () => {
    expect(buildFtsQuery('이름이')).toBe('"이름이" OR "이름"*')
    expect(buildFtsQuery('보라돌이')).toBe('"보라돌이" OR "보라돌"*')
    expect(buildFtsQuery('갈색 푸들')).toBe('"갈색" OR "푸들"')
  })
  test('빈 쿼리 → 빈 문자열', () => {
    expect(buildFtsQuery('')).toBe('')
    expect(buildFtsQuery('a b')).toBe('')
  })
})

// ---------------- getRelevantMemories (융합 랭킹) ----------------

function makeDb(flagValue: any, ftsResults: any[] | 'throw', likeResults: any[] | 'throw' = [], supersededResults: any[] | 'throw' = []) {
  const batchCalls: any[][] = []
  return {
    batchCalls,
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
        async run() {
          return { meta: { last_row_id: 1, changes: 1 } }
        },
      }
    },
    async batch(stmts: any[]) {
      batchCalls.push(stmts)
      return stmts.map(() => ({ meta: { changes: 1, last_row_id: 1 } }))
    },
  }
}

describe('getRelevantMemories — 융합 랭킹', () => {
  test('FTS rank 음수 클수록 먼저 + score/tier 포함', async () => {
    // tier는 실제 now 기준 경과일로 판정되므로 고정 날짜를 쓰면 시간이 지나며 만료된다
    // (Track A 2026-10-29: +30일 시계 이동 탐지에서 적발 — 동적 날짜로 교체)
    const recent = new Date(Date.now() - 86400000).toISOString()
    const db = makeDb('true', [
      { id: 1, content: '낮은 관련', category: 'fact', fts_rank: -1, access_count: 0, updated_at: recent },
      { id: 2, content: '높은 관련', category: 'fact', fts_rank: -9, access_count: 0, updated_at: recent },
    ])
    const out = await getRelevantMemories({ DB: db } as any, '테스트 쿼리')
    expect(out.map((r) => r.id)).toEqual([2, 1])
    expect(out[0].score).toBeGreaterThan(out[1].score!)
    expect(out[0].tier).toBe('hot')
  })
  test('엔티티 일치 가산으로 순서 역전', async () => {
    const db = makeDb('true', [
      { id: 1, content: 'A', category: 'fact', fts_rank: -5, entities: '[]', access_count: 0, updated_at: '2026-10-25T00:00:00Z' },
      { id: 2, content: 'B', category: 'fact', fts_rank: -5, entities: '["테스트"]', access_count: 0, updated_at: '2026-10-25T00:00:00Z' },
    ])
    const out = await getRelevantMemories({ DB: db } as any, '테스트')
    expect(out[0].id).toBe(2)
  })
  test('후보 2배 조회 후 limit개만 반환 + touch(batch) 호출', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, content: `내용${i + 1}`, category: 'fact',
      fts_rank: -1, access_count: 0, updated_at: '2026-10-25T00:00:00Z',
    }))
    const db = makeDb('true', rows)
    const out = await getRelevantMemories({ DB: db } as any, '테스트 쿼리', 5)
    expect(out).toHaveLength(5)
    expect(db.batchCalls).toHaveLength(1)
    expect(db.batchCalls[0]).toHaveLength(5)
  })
  test('LIKE 폴백도 랭킹 적용', async () => {
    const db = makeDb('true', 'throw', [
      { id: 1, content: 'A', category: 'fact', access_count: 0, updated_at: '2026-10-25T00:00:00Z' },
      { id: 2, content: 'B', category: 'fact', access_count: 10, updated_at: '2026-10-25T00:00:00Z' },
    ])
    const out = await getRelevantMemories({ DB: db } as any, '테스트')
    expect(out).toHaveLength(2)
    // 접근 횟수가 많은 쪽이 먼저 (FTS 점수 없음 → 최신성·접근이 결정)
    expect(out[0].id).toBe(2)
  })
  test('플래그 OFF → [] (touch 없음)', async () => {
    const db = makeDb('false', [])
    expect(await getRelevantMemories({ DB: db } as any, '테스트')).toEqual([])
    expect(db.batchCalls).toHaveLength(0)
  })
})

describe('formatMemoryContext — 요약 주입', () => {
  test('cold/archived는 summary 주입 + 티어 태그', () => {
    const out = formatMemoryContext([
      { id: 1, content: '원문 긴 내용', category: 'fact', tier: 'cold', summary: '핵심 요약' },
      { id: 2, content: '따끈한 내용', category: 'fact', tier: 'hot' },
      { id: 3, content: '보관 원문', category: 'fact', tier: 'archived', summary: '보관 요약' },
    ])
    expect(out).toContain('1. [기억 #1|fact|cold] 핵심 요약')
    expect(out).not.toContain('원문 긴 내용')
    expect(out).toContain('2. [기억 #2|fact] 따끈한 내용')
    expect(out).toContain('3. [기억 #3|fact|archived] 보관 요약')
  })
  test('summary 없으면 원문 사용', () => {
    const out = formatMemoryContext([
      { id: 1, content: '원문', category: 'fact', tier: 'cold' },
    ])
    expect(out).toContain('1. [기억 #1|fact|cold] 원문')
  })
  test('티어 없는 기존 항목은 기존 포맷 유지', () => {
    const out = formatMemoryContext([{ id: 1, content: 'x', category: 'c' }])
    expect(out).toContain('1. [기억 #1|c] x')
  })
})

// ---------------- 요약 페이지 / 대체 / 복원 / 모순 ----------------

function makeServiceDb(allResults: any[] = [], firstResult: any = null) {
  const calls: { sql: string; params: any[] }[] = []
  const runResults: any[] = []
  const db: any = {
    calls,
    runQueue: runResults,
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          calls.push({ sql, params: this._params })
          return firstResult
        },
        async all() {
          calls.push({ sql, params: this._params })
          return { results: allResults }
        },
        async run() {
          calls.push({ sql, params: this._params })
          const v = runResults.shift()
          if (v !== undefined) return v
          return { meta: { last_row_id: 11, changes: 1 } }
        },
      }
    },
    async batch(stmts: any[]) {
      calls.push({ sql: '[batch]', params: stmts.map((s: any) => s._params) })
      return stmts.map(() => ({ meta: { changes: 1, last_row_id: 1 } }))
    },
  }
  return db
}

describe('buildMemoryPage', () => {
  test('원본 핵심 사실로 페이지 생성', async () => {
    const db = makeServiceDb([
      { id: 1, content: '첫 문장입니다. 둘째 문장입니다.', summary: null },
      { id: 2, content: '다른 내용입니다.', summary: '저장된 요약' },
    ])
    const r = await buildMemoryPage({ DB: db } as any, { title: '주간 요약', memoryIds: [1, 2] })
    expect(r.ok).toBe(true)
    expect(r.id).toBe(11)
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO memory_pages'))
    expect(ins.params[0]).toBe('주간 요약')
    expect(ins.params[1]).toContain('- 첫 문장입니다.')
    expect(ins.params[1]).toContain('- 저장된 요약')
    expect(ins.params[3]).toBe('[1,2]')
  })
  test('제목 없음 → 에러', async () => {
    const db = makeServiceDb([])
    expect((await buildMemoryPage({ DB: db } as any, { title: '  ', memoryIds: [1] })).ok).toBe(false)
  })
  test('memoryIds 없음 → 에러', async () => {
    const db = makeServiceDb([])
    expect((await buildMemoryPage({ DB: db } as any, { title: 't', memoryIds: [] })).ok).toBe(false)
  })
  test('원본 없음 → not_found', async () => {
    const db = makeServiceDb([])
    const r = await buildMemoryPage({ DB: db } as any, { title: 't', memoryIds: [99] })
    expect(r).toEqual({ ok: false, error: 'not_found' })
  })
  test('중복 ID 제거 + 20개 상한', async () => {
    const db = makeServiceDb([{ id: 1, content: 'x', summary: null }])
    await buildMemoryPage({ DB: db } as any, { title: 't', memoryIds: [1, 1, 1] })
    const sel = db.calls.find((c) => c.sql.includes('FROM ai_memory_v2 WHERE id IN'))
    expect(sel.params).toEqual([1])
  })
})

describe('supersedeMemory / restoreMemory / markContradiction', () => {
  test('대체 — batch 2건', async () => {
    const db = makeServiceDb([])
    const r = await supersedeMemory({ DB: db } as any, 1, 2)
    expect(r.ok).toBe(true)
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).toBe('[batch]')
    const batchParams = db.calls[0].params as any[][]
    expect(batchParams[0][0]).toBe(2) // superseded_by
    expect(batchParams[0][2]).toBe(1) // old id
    expect(batchParams[1][0]).toBe(1) // supersedes
    expect(batchParams[1][2]).toBe(2) // new id
  })
  test('대체 — 잘못된 ID', async () => {
    const db = makeServiceDb([])
    expect((await supersedeMemory({ DB: db } as any, 1, 1)).ok).toBe(false)
    expect((await supersedeMemory({ DB: db } as any, 0, 2)).ok).toBe(false)
    expect((await supersedeMemory({ DB: db } as any, 1, NaN)).ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
  test('복원 — is_active=1 + superseded_by NULL', async () => {
    const db = makeServiceDb([])
    const r = await restoreMemory({ DB: db } as any, 5)
    expect(r.ok).toBe(true)
    const upd = db.calls[0]
    expect(upd.sql).toContain('SET is_active = 1, superseded_by = NULL')
    expect(upd.params[1]).toBe(5)
  })
  test('복원 — 잘못된 ID', async () => {
    const db = makeServiceDb([])
    expect((await restoreMemory({ DB: db } as any, 0)).ok).toBe(false)
  })
  test('모순 플래그 설정/해제', async () => {
    const db = makeServiceDb([])
    await markContradiction({ DB: db } as any, 3, true)
    expect(db.calls[0].params).toEqual([1, 3])
    await markContradiction({ DB: db } as any, 3, false)
    expect(db.calls[1].params).toEqual([0, 3])
  })
})

// ---------------- 핸드오프 (claim-once) ----------------

describe('generateClaimToken', () => {
  test('형식 + 유일성', () => {
    const a = generateClaimToken()
    const b = generateClaimToken()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(8)
    expect(a).not.toBe(b)
  })
})

function makeHandoffDb(runChanges: number[], firstRow: any) {
  const calls: { sql: string; params: any[] }[] = []
  let runIdx = 0
  return {
    calls,
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          calls.push({ sql, params: this._params })
          return firstRow
        },
        async all() {
          calls.push({ sql, params: this._params })
          return { results: [] }
        },
        async run() {
          calls.push({ sql, params: this._params })
          const changes = runChanges[runIdx++] ?? 1
          return { meta: { last_row_id: 21, changes } }
        },
      }
    },
  }
}

describe('createHandoff / claimHandoff', () => {
  test('생성 — 토큰 반환 + pending 삽입', async () => {
    const db = makeHandoffDb([1], null)
    const r = await createHandoff({ DB: db } as any, {
      fromPersona: 'lumi', toPersona: 'echo', memoryIds: [1, 2], summary: '인계 요약',
    })
    expect(r.ok).toBe(true)
    expect(r.id).toBe(21)
    expect(typeof r.claimToken).toBe('string')
    const ins = db.calls[0]
    expect(ins.sql).toContain('INSERT INTO memory_handoffs')
    expect(typeof ins.params[0]).toBe('string') // claim_token
    expect(ins.params[1]).toBe('lumi')
    expect(ins.params[2]).toBe('echo')
    expect(JSON.parse(ins.params[3])).toEqual({ memory_ids: [1, 2], summary: '인계 요약' })
    // 'pending'은 SQL 리터럴이라 바인딩에 없음 — params[4]=created_at, params[5]=expires_at
    expect(Date.parse(ins.params[5])).toBeGreaterThan(Date.parse(ins.params[4]))
  })
  test('생성 — persona/memoryIds 없으면 에러', async () => {
    const db = makeHandoffDb([1], null)
    expect((await createHandoff({ DB: db } as any, { fromPersona: '', toPersona: 'echo', memoryIds: [1] })).ok).toBe(false)
    expect((await createHandoff({ DB: db } as any, { fromPersona: 'lumi', toPersona: 'echo', memoryIds: [] })).ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
  test('수령 — 1회 성공, 2회째는 409 상당 에러', async () => {
    const row = {
      from_persona: 'lumi',
      to_persona: 'echo',
      payload: JSON.stringify({ memory_ids: [1, 2], summary: '인계 요약' }),
    }
    // 첫 수령: UPDATE changes=1 → 성공
    const db1 = makeHandoffDb([1], row)
    const r1 = await claimHandoff({ DB: db1 } as any, 'tok-abc')
    expect(r1.ok).toBe(true)
    expect(r1.payload).toEqual({ memory_ids: [1, 2], summary: '인계 요약' })
    expect(r1.fromPersona).toBe('lumi')
    expect(r1.toPersona).toBe('echo')
    // 두 번째 수령: UPDATE changes=0 → 이미 수령됨
    const db2 = makeHandoffDb([0], row)
    const r2 = await claimHandoff({ DB: db2 } as any, 'tok-abc')
    expect(r2.ok).toBe(false)
    expect(r2.error).toBe('already_claimed_or_expired')
  })
  test('수령 — 토큰 없음 → 에러', async () => {
    const db = makeHandoffDb([1], null)
    expect((await claimHandoff({ DB: db } as any, '')).ok).toBe(false)
    expect((await claimHandoff({ DB: db } as any, '   ')).ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
  test('수령 — payload 파싱 실패 시 빈 payload로 성공', async () => {
    const db = makeHandoffDb([1], { from_persona: 'a', to_persona: 'b', payload: '{broken' })
    const r = await claimHandoff({ DB: db } as any, 'tok-x')
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({ memory_ids: [], summary: '' })
  })
})
