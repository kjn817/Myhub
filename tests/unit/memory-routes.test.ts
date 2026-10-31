/**
 * src/modules/memory/routes.ts 100% 커버리지 단위 테스트
 * - D1 Mock (prepare/bind/first/all/run — 큐 기반 응답 + Error 큐잉으로 catch 분기)
 * - Hono app.request()로 HTTP 시뮬레이션
 * - 외부 서비스 의존성 없음 (Hono + Env.DB만 사용) → jest.mock 불필요
 *
 * 커버리지 노트:
 * - 이 모듈에는 인증/소유권(403) 분기가 존재하지 않음.
 *   src/index.ts의 전역 app.use 인증 미들웨어가 /api/* 전체를 로그인 필수로 강제하므로
 *   모듈 레벨에서는 userEmail을 참조하지 않는다. 따라서 403/401 분기는 소스에 없음.
 * - 도달 불가(dead) 코드는 없음 — 모든 분기가 HTTP 경로에서 도달 가능하다.
 */
/// <reference types="jest" />
import { Hono } from 'hono'

import memoryApp from '../../src/modules/memory/routes'

// ---------------- Mock D1 ----------------
class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []
  batchCalls: any[][] = []

  // D1 batch — 서비스의 supersedeMemory가 사용. 결과는 검사하지 않음.
  async batch(statements: any[]) {
    this.batchCalls.push(statements)
    return statements.map(() => ({ meta: { changes: 1, last_row_id: 1 } }))
  }

  prepare(sql: string) {
    const db = this
    const exec = (params: any[]) => {
      db.calls.push({ sql, params })
      return {
        first: async () => {
          const v = db.firstQueue.shift()
          if (v === undefined) return null
          if (v instanceof Error) throw v
          return v
        },
        all: async () => {
          const v = db.allQueue.shift()
          if (v === undefined) return { results: [] }
          if (v instanceof Error) throw v
          return { results: v }
        },
        run: async () => {
          const v = db.runQueue.shift()
          if (v === undefined) return { meta: { last_row_id: 1, changes: 1 } }
          if (v instanceof Error) throw v
          return v
        },
      }
    }
    return {
      bind: (...params: any[]) => exec(params),
      first: () => exec([]).first(),
      all: () => exec([]).all(),
      run: () => exec([]).run(),
    }
  }
}

function makeApp(db?: MockDb) {
  const mock = db ?? new MockDb()
  const app = new Hono()
  app.route('/a', memoryApp)
  const env: any = { DB: mock }
  const req = (path: string, init?: RequestInit) => {
    const q = path.indexOf('?')
    const p = q >= 0 ? path.slice(0, q) : path
    const qs = q >= 0 ? path.slice(q) : ''
    return app.request('/a' + (p === '/' ? '' : p) + qs, init, env)
  }
  const json = (path: string, method: string, body?: any) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { app, db: mock, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

// ---------------- POST / (기억 저장) ----------------
describe('POST / 저장', () => {
  test('정상 저장 — 기본값(category=general, 동의=false, source=null)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null) // 중복 없음
    db.runQueue.push({ meta: { last_row_id: 7, changes: 1 } })
    const res = await json('/', 'POST', { content: '내일 10시 회의' })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true, id: 7 })
    // 중복 체크 쿼리
    expect(db.calls[0].sql).toContain('SELECT id FROM ai_memory_v2')
    expect(db.calls[0].params).toEqual(['내일 10시 회의'])
    // near-duplicate 체크 쿼리 (0044)
    expect(db.calls[1].sql).toContain('SELECT id, content FROM ai_memory_v2')
    // INSERT 바인딩: content, category, source_type, source_id, allow_ai_use, allow_provider_send, now, now
    // ('user', 'explicit'은 SQL 리터럴이라 바인딩에 없음)
    const ins = db.calls[2]
    expect(ins.sql).toContain('INSERT INTO ai_memory_v2')
    expect(ins.params[0]).toBe('내일 10시 회의')
    expect(ins.params[1]).toBe('general')
    expect(ins.params[2]).toBeNull() // source_type
    expect(ins.params[3]).toBeNull() // source_id
    expect(ins.params[4]).toBe(0) // allow_ai_use
    expect(ins.params[5]).toBe(0) // allow_provider_send
    expect(typeof ins.params[6]).toBe('string') // created_at
    expect(typeof ins.params[7]).toBe('string') // updated_at
  })

  test('명시적 동의 true + source 전달', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { last_row_id: 8, changes: 1 } })
    const res = await json('/', 'POST', {
      content: '기억',
      category: 'fact',
      source_type: 'chat',
      source_id: 9,
      allow_ai_use: true,
      allow_provider_send: true,
    })
    expect(res.status).toBe(200)
    const ins = db.calls[2]
    expect(ins.params[1]).toBe('fact')
    expect(ins.params[2]).toBe('chat')
    expect(ins.params[3]).toBe(9)
    expect(ins.params[4]).toBe(1)
    expect(ins.params[5]).toBe(1)
  })

  test('동의 명시적 false → 0 저장', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { last_row_id: 9, changes: 1 } })
    const res = await json('/', 'POST', {
      content: '기억2',
      allow_ai_use: false,
      allow_provider_send: false,
    })
    expect(res.status).toBe(200)
    const ins = db.calls[2]
    expect(ins.params[4]).toBe(0)
    expect(ins.params[5]).toBe(0)
  })

  test('content 누락 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/', 'POST', {})
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('content 필요')
  })

  test('content 공백만 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/', 'POST', { content: '   \n\t ' })
    expect(res.status).toBe(400)
  })

  test('content 5000자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/', 'POST', { content: 'a'.repeat(5001) })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('내용이 너무 깁니다')
  })

  test('content 정확히 5000자 → 통과 (경계)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { last_row_id: 10, changes: 1 } })
    const res = await json('/', 'POST', { content: 'a'.repeat(5000) })
    expect(res.status).toBe(200)
  })

  test('유효하지 않은 category → 400', async () => {
    const { json } = makeApp()
    const res = await json('/', 'POST', { content: 'x', category: 'nope' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('유효하지 않은 category')
  })

  test('유효 category 5종 모두 통과', async () => {
    for (const category of ['general', 'preference', 'fact', 'schedule', 'work']) {
      const { json, db } = makeApp()
      db.firstQueue.push(null)
      db.runQueue.push({ meta: { last_row_id: 1, changes: 1 } })
      const res = await json('/', 'POST', { content: 'x', category })
      expect(res.status).toBe(200)
      expect(db.calls[2].params[1]).toBe(category)
    }
  })

  test('중복 → 409 + existing_id', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 12 })
    const res = await json('/', 'POST', { content: '이미 있는 기억' })
    expect(res.status).toBe(409)
    const j = await body(res)
    expect(j).toEqual({ ok: false, error: 'duplicate', existing_id: 12 })
  })

  test('JSON 파싱 실패 → catch → 400', async () => {
    const { req } = makeApp()
    const res = await req('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('content 필요')
  })

  test('content 앞뒤 공백은 trim 후 저장', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { last_row_id: 11, changes: 1 } })
    const res = await json('/', 'POST', { content: '  앞뒤 공백  ' })
    expect(res.status).toBe(200)
    expect(db.calls[0].params).toEqual(['앞뒤 공백'])
    expect(db.calls[2].params[0]).toBe('앞뒤 공백')
  })
})

// ---------------- GET / (목록 + 검색) ----------------
describe('GET / 목록', () => {
  const row = {
    id: 1,
    content: '기억 내용',
    category: 'general',
    created_by: 'user',
    source_type: null,
    created_at: '2026-10-17T00:00:00.000Z',
    updated_at: '2026-10-17T00:00:00.000Z',
  }

  test('쿼리 없음 → 전체 목록', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.results).toHaveLength(1)
    expect(db.calls[0].sql).not.toContain('MATCH')
    expect(db.calls[0].sql).not.toContain('AND')
    expect(db.calls[0].params).toEqual([])
  })

  test('category 필터', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?category=work', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].sql).toContain('AND category = ?')
    expect(db.calls[0].params).toEqual(['work'])
  })

  test('짧은 q(1글자) → FTS 건너뛰고 LIKE만', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=a', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.search_type).toBeUndefined()
    expect(db.calls[0].sql).not.toContain('MATCH')
    expect(db.calls[0].sql).toContain('AND content LIKE ?')
    expect(db.calls[0].params).toEqual(['%a%'])
  })

  test('FTS 검색 성공 (search_type=fts)', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=hello', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.search_type).toBe('fts')
    expect(j.results).toHaveLength(1)
    expect(db.calls[0].sql).toContain('MATCH')
    expect(db.calls[0].sql).not.toContain('AND m.category')
    expect(db.calls[0].params).toEqual(['"hello"'])
  })

  test('FTS + category 결합', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=hello&category=fact', 'GET')
    expect(res.status).toBe(200)
    expect((await body(res)).search_type).toBe('fts')
    expect(db.calls[0].sql).toContain('AND m.category = ?')
    expect(db.calls[0].params).toEqual(['"hello"', 'fact'])
  })

  test('FTS 다중 토큰 → 공백 분리 후 AND 결합', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=hello  world', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].params).toEqual(['"hello" "world"'])
  })

  test('FTS 따옴표 이스케이프 (" → "")', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=%22ab%22', 'GET') // q = "ab"
    expect(res.status).toBe(200)
    // '"ab"' → 각 "를 ""로 → '""ab""' → 전체를 "..."로 감쌈 → '"""ab"""'
    expect(db.calls[0].params).toEqual(['"""ab"""'])
  })

  test('FTS throw → catch → LIKE 폴백', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('fts down'))
    db.allQueue.push([row])
    const res = await json('/?q=hello', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.search_type).toBeUndefined()
    expect(j.results).toHaveLength(1)
    // 두 번째 호출이 LIKE 폴백
    expect(db.calls[1].sql).not.toContain('MATCH')
    expect(db.calls[1].sql).toContain('AND content LIKE ?')
    expect(db.calls[1].params).toEqual(['%hello%'])
  })

  test('1글자 토큰만 있는 q → searchTerm 빈 문자열 → LIKE', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=a%20b', 'GET') // q = "a b" (길이 3 ≥ 2, 토큰은 1글자씩)
    expect(res.status).toBe(200)
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).not.toContain('MATCH')
    expect(db.calls[0].sql).toContain('AND content LIKE ?')
    expect(db.calls[0].params).toEqual(['%a b%'])
  })

  test('LIKE 특수문자 이스케이프 (%, _, \\)', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push([])
    await json('/?q=%25', 'GET') // %
    await json('/?q=_', 'GET') // _
    await json('/?q=%5C', 'GET') // \
    expect(db.calls[0].params).toEqual(['%\\%%'])
    expect(db.calls[1].params).toEqual(['%\\_%'])
    expect(db.calls[2].params).toEqual(['%\\\\%'])
  })

  test('LIKE + category 결합', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=a&category=work', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].sql).toContain('AND category = ?')
    expect(db.calls[0].sql).toContain('AND content LIKE ?')
    expect(db.calls[0].params).toEqual(['work', '%a%'])
  })

  test('q 빈 문자열 → 필터 없음', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    const res = await json('/?q=', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].params).toEqual([])
    expect(db.calls[0].sql).not.toContain('LIKE')
  })

  test('q 공백만 → trim 후 길이 0 → LIKE 폴백 분기 아님', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row])
    // q=" " → truthy지만 trim().length < 2 → FTS 스킵, LIKE는 q truthy라 적용
    const res = await json('/?q=%20', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].sql).toContain('AND content LIKE ?')
    expect(db.calls[0].params).toEqual(['% %'])
  })
})

// ---------------- PUT /:id (기억 수정) ----------------
describe('PUT /:id 수정', () => {
  test('content만 수정', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    const res = await json('/1', 'PUT', { content: '새 내용' })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    const upd = db.calls[1]
    expect(upd.sql).toContain('content = ?')
    expect(upd.sql).not.toContain('category = ?')
    expect(upd.params).toContain('새 내용')
    expect(upd.params[upd.params.length - 1]).toBe(1) // WHERE id = ?
  })

  test('category만 수정', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 2 })
    const res = await json('/2', 'PUT', { category: 'work' })
    expect(res.status).toBe(200)
    const upd = db.calls[1]
    expect(upd.sql).toContain('category = ?')
    expect(upd.sql).not.toContain('content = ?')
    expect(upd.params).toContain('work')
  })

  test('동의 필드 true → 1', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 3 })
    const res = await json('/3', 'PUT', { allow_ai_use: true, allow_provider_send: true })
    expect(res.status).toBe(200)
    const upd = db.calls[1]
    expect(upd.sql).toContain('allow_ai_use = ?')
    expect(upd.sql).toContain('allow_provider_send = ?')
    expect(upd.params.filter((p) => p === 1)).toHaveLength(2)
  })

  test('동의 필드 false → 0', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 4 })
    const res = await json('/4', 'PUT', { allow_ai_use: false, allow_provider_send: false })
    expect(res.status).toBe(200)
    const upd = db.calls[1]
    expect(upd.params.filter((p) => p === 0)).toHaveLength(2)
  })

  test('전체 필드 동시 수정', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 5 })
    const res = await json('/5', 'PUT', {
      content: '전체',
      category: 'fact',
      allow_ai_use: true,
      allow_provider_send: false,
    })
    expect(res.status).toBe(200)
    const upd = db.calls[1]
    expect(upd.sql).toContain('content = ?')
    expect(upd.sql).toContain('category = ?')
    expect(upd.sql).toContain('allow_ai_use = ?')
    expect(upd.sql).toContain('allow_provider_send = ?')
    // params 순서: now, content, category, 1, 0, id
    expect(upd.params.slice(1, 5)).toEqual(['전체', 'fact', 1, 0])
    expect(upd.params[5]).toBe(5)
  })

  test('빈 body → updated_at만 갱신', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 6 })
    const res = await json('/6', 'PUT', {})
    expect(res.status).toBe(200)
    const upd = db.calls[1]
    expect(upd.sql).toBe('UPDATE ai_memory_v2 SET updated_at = ? WHERE id = ?')
    expect(upd.params).toHaveLength(2)
  })

  test('content 빈 문자열 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/1', 'PUT', { content: '   ' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('content 필요')
  })

  test('content 5000자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/1', 'PUT', { content: 'b'.repeat(5001) })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('내용이 너무 깁니다')
  })

  test('content 5000자 경계 → 통과', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 7 })
    const res = await json('/7', 'PUT', { content: 'b'.repeat(5000) })
    expect(res.status).toBe(200)
  })

  test('유효하지 않은 category → 400', async () => {
    const { json } = makeApp()
    const res = await json('/1', 'PUT', { category: 'nope' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('유효하지 않은 category')
  })

  test('없는 ID → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999', 'PUT', { content: 'x' })
    expect(res.status).toBe(404)
    expect((await body(res)).error).toBe('not_found')
  })

  test('무효 ID → 400 (문자열/0/음수)', async () => {
    const { json } = makeApp()
    for (const id of ['abc', '0', '-5']) {
      const res = await json(`/${id}`, 'PUT', { content: 'x' })
      expect(res.status).toBe(400)
      expect(await body(res)).toEqual({ ok: false, error: '유효하지 않은 ID' })
    }
  })

  test('JSON 파싱 실패 → catch → updated_at만 갱신', async () => {
    const { req, db } = makeApp()
    db.firstQueue.push({ id: 8 })
    const res = await req('/8', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{{{',
    })
    expect(res.status).toBe(200)
    expect(db.calls[1].sql).toBe('UPDATE ai_memory_v2 SET updated_at = ? WHERE id = ?')
  })

  test('content 앞뒤 공백 trim 후 저장', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 9 })
    const res = await json('/9', 'PUT', { content: '  공백  ' })
    expect(res.status).toBe(200)
    expect(db.calls[1].params).toContain('공백')
  })
})

// ---------------- DELETE /:id (비활성화 / 영구 삭제) ----------------
describe('DELETE /:id', () => {
  test('기본 → 비활성화(deactivated)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    const res = await json('/1', 'DELETE')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true, deleted: 'deactivated' })
    const upd = db.calls[1]
    expect(upd.sql).toContain('is_active = 0')
    expect(upd.params).toHaveLength(3) // now, now, id
    expect(upd.params[2]).toBe(1)
  })

  test('?permanent=true → 영구 삭제 (그래프 자식 행 선삭제)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 2 })
    const res = await json('/2?permanent=true', 'DELETE')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true, deleted: 'permanent' })
    // FK 순서: 사실-엔티티 연결 → 관계 간선 → 원본 사실
    expect(db.calls[1].sql).toBe('DELETE FROM memory_fact_entities WHERE fact_id = ?')
    expect(db.calls[1].params).toEqual([2])
    expect(db.calls[2].sql).toBe('DELETE FROM memory_relations WHERE fact_id = ?')
    expect(db.calls[2].params).toEqual([2])
    expect(db.calls[3].sql).toBe('DELETE FROM ai_memory_v2 WHERE id = ?')
    expect(db.calls[3].params).toEqual([2])
  })

  test('?permanent=false → 비활성화', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 3 })
    const res = await json('/3?permanent=false', 'DELETE')
    expect((await body(res)).deleted).toBe('deactivated')
    expect(db.calls[1].sql).toContain('is_active = 0')
  })

  test('없는 ID → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999', 'DELETE')
    expect(res.status).toBe(404)
    expect((await body(res)).error).toBe('not_found')
  })

  test('무효 ID → 400 (문자열/0/음수)', async () => {
    const { json } = makeApp()
    for (const id of ['abc', '0', '-1']) {
      const res = await json(`/${id}`, 'DELETE')
      expect(res.status).toBe(400)
      expect(await body(res)).toEqual({ ok: false, error: '유효하지 않은 ID' })
    }
  })
})

// ---------------- 0044: near-duplicate / 요약 페이지 / 대체·복원·모순 / 핸드오프 ----------------
describe('POST / near-duplicate', () => {
  test('정규화 일치 → 409 near_duplicate', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null) // 정확 일치 없음
    db.allQueue.push([{ id: 5, content: '내일 10시 회의!' }]) // near-dup 후보
    const res = await json('/', 'POST', { content: '내일10시회의' })
    expect(res.status).toBe(409)
    expect(await body(res)).toEqual({ ok: false, error: 'near_duplicate', existing_id: 5 })
  })

  test('정규화 불일치 → 저장 진행', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    db.allQueue.push([{ id: 5, content: '전혀 다른 내용' }])
    db.runQueue.push({ meta: { last_row_id: 6, changes: 1 } })
    const res = await json('/', 'POST', { content: '새로운 기억' })
    expect(res.status).toBe(200)
  })

  test('제어 문자 포함 content → 위생 처리 후 저장', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    db.allQueue.push([])
    db.runQueue.push({ meta: { last_row_id: 6, changes: 1 } })
    const res = await json('/', 'POST', { content: '깨\x00끗한 기억' })
    expect(res.status).toBe(200)
    expect(db.calls[2].params[0]).toBe('깨끗한 기억')
  })
})

describe('POST /pages 요약 페이지', () => {
  test('정상 생성 — 핵심 사실 모음', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 1, content: '첫 문장입니다. 둘째 문장입니다.', summary: null },
      { id: 2, content: '다른 내용입니다.', summary: '저장된 요약' },
    ])
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } })
    const res = await json('/pages', 'POST', { title: '주간 요약', memory_ids: [1, 2] })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, id: 3 })
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO memory_pages'))
    expect(ins.params[1]).toContain('- 첫 문장입니다.')
    expect(ins.params[1]).toContain('- 저장된 요약')
  })

  test('제목 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/pages', 'POST', { title: '', memory_ids: [1] })
    expect(res.status).toBe(400)
  })

  test('원본 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    const res = await json('/pages', 'POST', { title: 't', memory_ids: [99] })
    expect(res.status).toBe(404)
  })
})

describe('GET /pages 목록', () => {
  test('카테고리 필터 포함 조회', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 1, title: 'p', body: 'b', category: 'fact' }])
    const res = await json('/pages?category=fact', 'GET')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.results).toHaveLength(1)
    expect(db.calls[0].sql).toContain('FROM memory_pages')
    expect(db.calls[0].params).toEqual(['fact'])
  })
})

describe('POST /:id/supersede 대체', () => {
  test('정상 대체 → batch 2건 + 구 사실 시간 엣지 닫기 (0056)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 }, { id: 2 })
    const res = await json('/1/supersede', 'POST', { superseded_by: 2 })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    expect(db.batchCalls).toHaveLength(1)
    expect(db.batchCalls[0]).toHaveLength(2)
    expect(db.calls.some((c) => c.sql.includes('UPDATE memory_fact_entities SET valid_until = ?'))).toBe(true)
  })

  test('같은 ID → 400', async () => {
    const { json } = makeApp()
    const res = await json('/1/supersede', 'POST', { superseded_by: 1 })
    expect(res.status).toBe(400)
  })

  test('구 기억 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/1/supersede', 'POST', { superseded_by: 2 })
    expect(res.status).toBe(404)
  })

  test('신 기억 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 }, null)
    const res = await json('/1/supersede', 'POST', { superseded_by: 2 })
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/restore 복원', () => {
  test('정상 복원 + 닫힌 시간 엣지 다시 열기 (0056)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.runQueue.push({ meta: { last_row_id: 1, changes: 1 } })
    const res = await json('/1/restore', 'POST')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    expect(db.calls[1].sql).toContain('SET is_active = 1, superseded_by = NULL')
    expect(db.calls.some((c) => c.sql.includes('UPDATE memory_fact_entities SET valid_until = NULL'))).toBe(true)
  })

  test('없는 ID → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999/restore', 'POST')
    expect(res.status).toBe(404)
  })

  test('무효 ID → 400', async () => {
    const { json } = makeApp()
    const res = await json('/abc/restore', 'POST')
    expect(res.status).toBe(400)
  })
})

describe('POST /:id/contradiction 모순 플래그', () => {
  test('flag=true → 1 저장', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    const res = await json('/1/contradiction', 'POST', { flag: true })
    expect(res.status).toBe(200)
    expect(db.calls[1].params).toEqual([1, 1])
  })

  test('flag 생략 → false(0) 저장', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    const res = await json('/1/contradiction', 'POST', {})
    expect(res.status).toBe(200)
    expect(db.calls[1].params).toEqual([0, 1])
  })

  test('없는 ID → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/1/contradiction', 'POST', { flag: true })
    expect(res.status).toBe(404)
  })
})

describe('POST /handoffs + claim', () => {
  test('인계 생성 → claim_token 반환', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 4, changes: 1 } })
    const res = await json('/handoffs', 'POST', {
      from_persona: 'lumi', to_persona: 'echo', memory_ids: [1, 2], summary: '요약',
    })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.id).toBe(4)
    expect(typeof j.claim_token).toBe('string')
  })

  test('인계 생성 — persona 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/handoffs', 'POST', { from_persona: '', to_persona: 'echo', memory_ids: [1] })
    expect(res.status).toBe(400)
  })

  test('수령 성공 → payload 반환', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 1, changes: 1 } })
    db.firstQueue.push({
      from_persona: 'lumi',
      to_persona: 'echo',
      payload: JSON.stringify({ memory_ids: [1], summary: '인계 요약' }),
    })
    const res = await json('/handoffs/tok-1/claim', 'POST')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.payload).toEqual({ memory_ids: [1], summary: '인계 요약' })
    expect(j.from_persona).toBe('lumi')
  })

  test('이미 수령됨 → 409', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 1, changes: 0 } })
    const res = await json('/handoffs/tok-1/claim', 'POST')
    expect(res.status).toBe(409)
    expect((await body(res)).error).toBe('already_claimed_or_expired')
  })
})

// ---------------- 0046 mem0 패턴: 사실 추출·그래프 라우트 ----------------
describe('POST /extract 사실 추출', () => {
  test('정상 추출 — 결정적 경로, 동의 기본 0', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([]) // near-duplicate 없음
    db.runQueue.push({ meta: { last_row_id: 11, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 12, changes: 1 } })
    const res = await json('/extract', 'POST', { text: '결정적 사실 문장입니다. 다른 사실 문장입니다.' })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.extraction).toBe('deterministic')
    expect(j.created).toHaveLength(2)
    expect(j.created[0].id).toBe(11)
    // INSERT SQL에 동의 기본 0 리터럴 포함
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO ai_memory_v2'))
    expect(ins.sql).toContain('0, 0')
  })
  test('빈 텍스트 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/extract', 'POST', { text: '   ' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('text 필요')
  })
})

describe('POST /memos/:id/capture 메모 캡처', () => {
  test('잠긴 메모 → 403 locked', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 3, is_locked: 1 })
    const res = await json('/memos/3/capture', 'POST')
    expect(res.status).toBe(403)
    expect((await body(res)).error).toBe('locked')
    expect(db.calls.some((c) => c.sql.includes('INSERT'))).toBe(false)
  })
  test('없는 메모 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/memos/99/capture', 'POST')
    expect(res.status).toBe(404)
  })
  test('잘못된 ID → 400', async () => {
    const { json } = makeApp()
    const res = await json('/memos/abc/capture', 'POST')
    expect(res.status).toBe(400)
  })
  test('잠금 해제 메모 → 캡처 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 5, is_locked: 0 })
    db.firstQueue.push({ text: '공개 사실 문장입니다. 다른 공개 문장입니다.', locked_blocks: null })
    db.allQueue.push([]) // near-duplicate 없음
    db.runQueue.push({ meta: { last_row_id: 21, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 22, changes: 1 } })
    const res = await json('/memos/5/capture', 'POST')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.created).toHaveLength(2)
  })
})

describe('GET /graph/related 그래프 인식 검색', () => {
  test('FTS 결과 반환 + search_type=graph_fts', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ value: 'true' }) // memory.v2_enabled
    db.allQueue.push([
      { id: 1, content: '테스트 사실', category: 'fact', fts_rank: -5, access_count: 0, updated_at: '2026-10-25T00:00:00Z' },
    ])
    db.allQueue.push([]) // 시드 엔티티 없음
    const res = await json('/graph/related?q=테스트', 'GET')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.search_type).toBe('graph_fts')
    expect(j.results).toHaveLength(1)
    expect(j.results[0].content).toBe('테스트 사실')
    expect(db.batchCalls).toHaveLength(1) // touch 1회
  })
  test('쿼리 없음 → 빈 배열', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ value: 'true' })
    const res = await json('/graph/related', 'GET')
    expect(res.status).toBe(200)
    expect((await body(res)).results).toEqual([])
  })
})

describe('GET /:id/related 이웃 사실', () => {
  test('공유 엔티티 순으로 반환', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ entity_id: 1 }, { entity_id: 2 }]) // 시드 엔티티
    const row = (id: number, content: string, entityId: number) => ({
      id, content, category: 'fact', summary: null, entities: '[]',
      access_count: 0, last_accessed_at: null, updated_at: '2026-10-25T00:00:00Z', entity_id: entityId,
    })
    db.allQueue.push([row(20, '이웃 하나', 1), row(21, '이웃 둘', 1), row(21, '이웃 둘', 2)])
    const res = await json('/10/related', 'GET')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.results.map((r: any) => r.id)).toEqual([21, 20])
  })
  test('잘못된 ID → 400', async () => {
    const { json } = makeApp()
    const res = await json('/abc/related', 'GET')
    expect(res.status).toBe(400)
  })
})
