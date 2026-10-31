/**
 * src/modules/artifact/routes.ts 100% 커버리지 단위 테스트
 * - D1 Mock (prepare/bind/first/all/run/batch)
 * - Hono app.request()로 HTTP 시뮬레이션
 * - 인증 미들웨어 Mock (userEmail 주입)
 */
import { Hono } from 'hono'
import { artifactApp } from '../../src/modules/artifact/routes'

// ---------------- Mock D1 ----------------
class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
  batchQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []
  batchCalls: any[][] = []

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
      // bind 없이 직접 호출하는 쿼리 지원 (예: POST /chats/cleanup)
      first: () => exec([]).first(),
      all: () => exec([]).all(),
      run: () => exec([]).run(),
    }
  }

  async batch(stmts: any[]) {
    this.batchCalls.push(stmts)
    const v = this.batchQueue.shift()
    if (v === undefined) return []
    if (v instanceof Error) throw v
    return v
  }
}

function makeQueue(shouldThrow = false, emptyMessage = false) {
  const sent: any[] = []
  return {
    sent,
    send: async (msg: any) => {
      if (shouldThrow) throw emptyMessage ? new Error() : new Error('queue down')
      sent.push(msg)
    },
  }
}

function makeApp(opts: {
  userEmail?: string | null
  db?: MockDb
  queueThrows?: boolean
  queueEmptyMessage?: boolean
} = {}) {
  const db = opts.db ?? new MockDb()
  const queue = makeQueue(!!opts.queueThrows, !!opts.queueEmptyMessage)
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (opts.userEmail === undefined) (c as any).set('userEmail', 'test@example.com')
    else if (opts.userEmail !== null) (c as any).set('userEmail', opts.userEmail)
    await next()
  })
  app.route('/a', artifactApp)
  const env: any = { DB: db, ARTIFACT_QUEUE: queue }
  // '/' 경로는 trailing slash 없이 '/a'로 요청 (Hono 마운트 특성)
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
  return { app, db, queue, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

// ---------------- GET / ----------------
describe('GET /', () => {
  test('게시 목록 + 레거시 반환', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 1, title: 'A' }])
    db.allQueue.push([{ id: 2, title: 'B' }])
    const res = await json('/', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.data).toHaveLength(2)
  })
  test('results null → 빈 배열', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(null)
    db.allQueue.push(null)
    const res = await json('/', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data).toEqual([])
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('boom'))
    const res = await json('/', 'GET')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('게시된 프로젝트 목록 조회 실패')
  })
  test('limit/offset 클램핑', async () => {
    const { json, db } = makeApp()
    const res = await json('/?limit=500&offset=-3', 'GET')
    expect(res.status).toBe(200)
    // bind(limit, offset) → 100, 0
    expect(db.calls[0].params).toEqual([100, 0])
  })
})

// ---------------- GET /drafts ----------------
describe('GET /drafts', () => {
  test('초안 목록 반환', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 1, title: 'D' }])
    const res = await json('/drafts', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data).toHaveLength(1)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('boom'))
    const res = await json('/drafts', 'GET')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('임시저장 프로젝트 목록 조회 실패')
  })
})

// ---------------- GET /:id/versions ----------------
describe('GET /:id/versions', () => {
  test('버전 히스토리 반환', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 }) // ownerCheck
    db.allQueue.push([{ version_no: 2 }, { version_no: 1 }])
    db.firstQueue.push({ draft_version_id: 9, published_version_id: null })
    const res = await json('/5/versions', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.versions).toHaveLength(2)
    expect(j.data.draft_version_id).toBe(9)
    expect(j.data.published_version_id).toBeNull()
  })
  test('artifact null → null 반환', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.allQueue.push([])
    db.firstQueue.push(null)
    const res = await json('/5/versions', 'GET')
    const j = await body(res)
    expect(j.data.draft_version_id).toBeNull()
  })
  test('소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5/versions', 'GET')
    expect(res.status).toBe(403)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/versions', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /:id/versions/:versionNo/files ----------------
describe('GET /:id/versions/:versionNo/files', () => {
  test('파일 목록 반환', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push({ id: 9 })
    db.allQueue.push([{ file_path: 'index.html' }])
    const res = await json('/5/versions/2/files', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data).toHaveLength(1)
  })
  test('소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5/versions/2/files', 'GET')
    expect(res.status).toBe(403)
  })
  test('버전 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push(null)
    const res = await json('/5/versions/99/files', 'GET')
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/versions/2/files', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /:id/versions/:fromNo/diff/:toNo ----------------
describe('GET diff', () => {
  test('added/deleted/modified/unchanged', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 }) // ownerCheck
    // from v1
    db.firstQueue.push({ id: 10 })
    db.allQueue.push([
      { file_path: 'a.html', content: 'line1\nline2' },
      { file_path: 'del.html', content: 'gone' },
      { file_path: 'same.html', content: 'same' },
    ])
    // to v2
    db.firstQueue.push({ id: 11 })
    db.allQueue.push([
      { file_path: 'a.html', content: 'line1\nline2\nline3' },
      { file_path: 'new.html', content: 'hello\nworld' },
      { file_path: 'same.html', content: 'same' },
    ])
    const res = await json('/5/versions/1/diff/2', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    const types = j.data.changes.map((c: any) => c.type).sort()
    expect(types).toEqual(['added', 'deleted', 'modified'])
    expect(j.data.from).toBe(1)
    expect(j.data.to).toBe(2)
  })
  test('양쪽 버전 없음 → 빈 changes', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    const res = await json('/5/versions/1/diff/2', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.changes).toEqual([])
  })
  test('소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5/versions/1/diff/2', 'GET')
    expect(res.status).toBe(403)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/versions/1/diff/2', 'GET')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('Diff 실패')
  })
})

// ---------------- GET /:id/versions/:versionNo ----------------
describe('GET /:id/versions/:versionNo', () => {
  test('버전 상세 반환', async () => {
    const { json, db } = makeApp()
    // 소유권 SELECT가 먼저, 버전 SELECT가 다음 — 실제 호출 순서대로 큐에 넣는다
    // (files 핸들러 테스트와 동일 관례). 소유권 우선은 의도된 계약이다:
    // 타인에게는 없는 버전도 403을 반환해 존재 여부를 노출하지 않는다 (gate-61 실DB 고정).
    db.firstQueue.push({ id: 5 }) // ownerCheck
    db.firstQueue.push({ id: 3, version_no: 1 })
    const res = await json('/5/versions/1', 'GET')
    expect((await body(res)).ok).toBe(true)
  })
  test('버전은 있는데 소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null) // ownerCheck 실패 → 버전 존재 여부와 무관하게 403
    const res = await json('/5/versions/1', 'GET')
    expect(res.status).toBe(403)
  })
  test('버전 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 5 }) // ownerCheck 통과 (소유자)
    db.firstQueue.push(null) // 버전 없음 → 404
    const res = await json('/5/versions/99', 'GET')
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/versions/1', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /:id/versions ----------------
describe('POST /:id/versions', () => {
  const html = '<!DOCTYPE html><html><body>hi</body></html>'
  test('새 버전 생성 (maxRow null → v1)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, row_revision: 1, draft_version_id: null })
    db.firstQueue.push(null) // maxRow
    db.runQueue.push({ meta: { last_row_id: 11 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5/versions', 'POST', { html_content: html })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.version_no).toBe(1)
    expect(j.data.version_id).toBe(11)
  })
  test('max_no 있으면 +1', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, row_revision: 2, draft_version_id: 7 })
    db.firstQueue.push({ max_no: 5 })
    const res = await json('/5/versions', 'POST', { html_content: html, row_revision: 2 })
    const j = await body(res)
    expect(j.data.version_no).toBe(6)
  })
  test('html_content 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5/versions', 'POST', {})
    expect(res.status).toBe(400)
  })
  test('html_content 문자열 아님 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5/versions', 'POST', { html_content: 123 })
    expect(res.status).toBe(400)
  })
  test('2MB 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5/versions', 'POST', { html_content: 'x'.repeat(2 * 1024 * 1024 + 1) })
    expect(res.status).toBe(400)
  })
  test('아티팩트 없음/타인 소유 → 403 (존재 여부 노출 방지)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5/versions', 'POST', { html_content: html })
    expect(res.status).toBe(403)
  })
  test('row_revision 충돌 → 409', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, row_revision: 3, draft_version_id: null })
    const res = await json('/5/versions', 'POST', { html_content: html, row_revision: 5 })
    expect(res.status).toBe(409)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/versions', 'POST', { html_content: html })
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /:id/versions/:versionNo/publish ----------------
describe('POST publish version', () => {
  test('게시 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push({ id: 9 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5/versions/2/publish', 'POST', {})
    expect((await body(res)).ok).toBe(true)
  })
  test('소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5/versions/2/publish', 'POST', {})
    expect(res.status).toBe(403)
  })
  test('버전 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push(null)
    const res = await json('/5/versions/99/publish', 'POST', {})
    expect(res.status).toBe(404)
  })
  test('업데이트 0건 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push({ id: 9 })
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/5/versions/2/publish', 'POST', {})
    expect(res.status).toBe(404)
  })
  test('meta 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push({ id: 9 })
    db.runQueue.push({})
    const res = await json('/5/versions/2/publish', 'POST', {})
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/versions/2/publish', 'POST', {})
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /:id/rollback/:versionNo ----------------
describe('POST rollback', () => {
  test('롤백 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push({ id: 9 })
    const res = await json('/5/rollback/1', 'POST', {})
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.rolled_back_to).toBe(1)
  })
  test('소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5/rollback/1', 'POST', {})
    expect(res.status).toBe(403)
  })
  test('버전 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push(null)
    const res = await json('/5/rollback/99', 'POST', {})
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/rollback/1', 'POST', {})
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /:id/publish ----------------
describe('POST /:id/publish (legacy)', () => {
  test('draft_version 있음 → 경로 A', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ draft_version_id: 9 })
    const res = await json('/5/publish', 'POST', {})
    expect((await body(res)).ok).toBe(true)
  })
  test('draft_version 없음 → 경로 B', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ draft_version_id: null })
    const res = await json('/5/publish', 'POST', {})
    expect((await body(res)).ok).toBe(true)
  })
  test('초안 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5/publish', 'POST', {})
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/5/publish', 'POST', {})
    expect(res.status).toBe(500)
  })
})

// ---------------- PATCH /:id ----------------
describe('PATCH /:id', () => {
  test('메타데이터 수정 성공', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5', 'PATCH', { title: '새 제목', description: '설명', icon_key: 'star' })
    expect((await body(res)).ok).toBe(true)
  })
  test('제목 200자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5', 'PATCH', { title: 'x'.repeat(201) })
    expect(res.status).toBe(400)
  })
  test('설명 1000자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5', 'PATCH', { description: 'x'.repeat(1001) })
    expect(res.status).toBe(400)
  })
  test('icon_key 50자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5', 'PATCH', { icon_key: 'x'.repeat(51) })
    expect(res.status).toBe(400)
  })
  test('수정 항목 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5', 'PATCH', {})
    expect(res.status).toBe(400)
  })
  test('0건 변경 → 404', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/5', 'PATCH', { title: 'x' })
    expect(res.status).toBe(404)
  })
  test('meta 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({})
    const res = await json('/5', 'PATCH', { title: 'x' })
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('boom'))
    const res = await json('/5', 'PATCH', { title: 'x' })
    expect(res.status).toBe(500)
  })
})

// ---------------- DELETE /:id ----------------
describe('DELETE /:id', () => {
  test('삭제 성공 (batch 8개)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    const res = await json('/5', 'DELETE')
    expect((await body(res)).ok).toBe(true)
    expect(db.batchCalls).toHaveLength(1)
    // 8개: 부모 링크 해제 UPDATE 1개 + 관련 데이터 삭제 7개. 부모 링크 해제는
    // parent_version_id ON DELETE RESTRICT 때문에 버전 삭제 전 필수이다 (2026-10-27 추가).
    expect(db.batchCalls[0]).toHaveLength(8)
  })
  test('없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/5', 'DELETE')
    expect(res.status).toBe(404)
  })
  test('batch 에러 → 500 (메시지 포함)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.batchQueue.push(new Error('batch fail'))
    const res = await json('/5', 'DELETE')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toContain('batch fail')
  })
})

// ---------------- POST /chats ----------------
describe('POST /chats', () => {
  test('저장 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null) // dup 없음
    const res = await json('/chats', 'POST', { who: 'user', content: 'hi' })
    expect((await body(res)).ok).toBe(true)
  })
  test('who/content 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/chats', 'POST', { who: 'user' })
    expect(res.status).toBe(400)
  })
  test('중복 → deduped', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 9 })
    const res = await json('/chats', 'POST', { who: 'user', content: 'hi' })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.deduped).toBe(true)
  })
  test('artifact 소유권 통과', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 }) // ownerCheck
    db.firstQueue.push(null) // dup
    const res = await json('/chats', 'POST', { artifact_id: 5, who: 'user', content: 'hi' })
    expect((await body(res)).ok).toBe(true)
  })
  test('artifact 소유권 실패 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/chats', 'POST', { artifact_id: 5, who: 'user', content: 'hi' })
    expect(res.status).toBe(403)
  })
  test('긴 content 2000자 슬라이스', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/chats', 'POST', { who: 'user', content: 'x'.repeat(3000) })
    expect((await body(res)).ok).toBe(true)
    expect(db.calls[1].params[3]).toHaveLength(2000)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/chats', 'POST', { who: 'user', content: 'hi' })
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /chats/migrate ----------------
describe('POST /chats/migrate', () => {
  test('이관 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    const res = await json('/chats/migrate', 'POST', { from_session: 'abc', to_artifact_id: 5 })
    expect((await body(res)).ok).toBe(true)
    expect(db.calls[1].params[1]).toBe('p5')
    // 관문 80: UPDATE는 고아 채팅(artifact_id IS NULL)만 대상으로 해야 한다.
    // 실제 행 이동 여부는 실DB 게이트 테스트(gate-track-a)가 검증하고,
    // 여기서는 SQL 조건 자체가 빠지면 실패하도록 고정한다.
    expect(db.calls[1].sql).toContain('artifact_id IS NULL')
  })
  test('파라미터 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/chats/migrate', 'POST', {})
    expect(res.status).toBe(400)
  })
  test('소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/chats/migrate', 'POST', { from_session: 'abc', to_artifact_id: 5 })
    expect(res.status).toBe(403)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/chats/migrate', 'POST', { from_session: 'abc', to_artifact_id: 5 })
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /chats ----------------
describe('GET /chats', () => {
  test('필터 없음 → 400 (전체 조회 차단)', async () => {
    const { json } = makeApp()
    // 관문 64 계약 변경 (S 배치): 필터 없이 호출하면 전체 채팅이 노출되므로
    // session_key/artifact_id 중 하나를 강제한다. 이전의 전체 조회 단언은
    // 취약한 동작을 고정하던 것이므로 새 계약(400)에 맞게 교체한다.
    const res = await json('/chats', 'GET')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toMatch(/session_key 또는 artifact_id/)
  })
  test('artifact_id 소유권 통과', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.allQueue.push([])
    const res = await json('/chats?artifact_id=5', 'GET')
    expect((await body(res)).ok).toBe(true)
  })
  test('artifact_id 소유권 실패 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/chats?artifact_id=5', 'GET')
    expect(res.status).toBe(403)
  })
  test('session_key p형식 소유권 통과', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 5 })
    db.allQueue.push([])
    const res = await json('/chats?session_key=p5', 'GET')
    expect((await body(res)).ok).toBe(true)
  })
  test('session_key p형식 소유권 실패 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/chats?session_key=p5', 'GET')
    expect(res.status).toBe(403)
  })
  test('session_key=p (aid 0) → 체크 스킵', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    const res = await json('/chats?session_key=p', 'GET')
    expect((await body(res)).ok).toBe(true)
  })
  test('session_key 일반형식', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    const res = await json('/chats?session_key=abc', 'GET')
    expect((await body(res)).ok).toBe(true)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('boom'))
    // 필터 없는 호출은 DB에 닿기 전에 400이므로, 필터 있는 요청으로 500 경로를 검증한다.
    const res = await json('/chats?session_key=abc', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /search ----------------
describe('GET /search', () => {
  test('검색 성공', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 1, title: 'A' }])
    db.allQueue.push([{ snippet: 'hi' }])
    const res = await json('/search?q=test', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.projects).toHaveLength(1)
  })
  test('q 없음 → 빈 결과', async () => {
    const { json } = makeApp()
    const res = await json('/search', 'GET')
    const j = await body(res)
    expect(j.data.projects).toEqual([])
  })
  test('공백 q → 빈 결과', async () => {
    const { json } = makeApp()
    const res = await json('/search?q=%20%20', 'GET')
    expect((await body(res)).data.chats).toEqual([])
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('boom'))
    const res = await json('/search?q=test', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- POST / ----------------
describe('POST / (artifact 생성)', () => {
  test('생성 성공', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 10 } })
    db.runQueue.push({ meta: { last_row_id: 20 } })
    const res = await json('/', 'POST', { title: 'T', html_content: '<html>' })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.id).toBe(10)
    expect(j.data.version_no).toBe(1)
  })
  test('title 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/', 'POST', { html_content: '<html>' })
    expect(res.status).toBe(400)
  })
  test('html_content 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/', 'POST', { title: 'T' })
    expect(res.status).toBe(400)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('boom'))
    const res = await json('/', 'POST', { title: 'T', html_content: '<html>' })
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /jobs ----------------
describe('POST /jobs', () => {
  const base = { kind: 'create', prompt: '앱 만들어줘' }
  test('작업 생성 성공 (새 프로젝트)', async () => {
    const { json, db, queue } = makeApp()
    db.firstQueue.push(null) // client_request_id 없음 → 스킵 (없으므로 first 호출 안 됨)
    db.runQueue.push({ meta: { last_row_id: 100 } }) // job insert
    db.runQueue.push({ meta: { last_row_id: 50 } }) // artifact insert
    db.runQueue.push({ meta: { changes: 1 } }) // job update
    db.firstQueue.push(null) // dupMsg 없음
    db.runQueue.push({ meta: { changes: 1 } }) // chat insert
    const res = await json('/jobs', 'POST', base)
    expect(res.status).toBe(202)
    const j = await body(res)
    expect(j.data.jobId).toBe(100)
    expect(queue.sent).toHaveLength(1)
    expect(queue.sent[0]).toEqual({ jobId: 100 })
  })
  test('artifact_id 지정 → 프로젝트 생성 스킵', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 5 }) // 관문 79: artifact 소유권 확인 통과
    db.runQueue.push({ meta: { last_row_id: 101 } })
    const res = await json('/jobs', 'POST', { ...base, artifact_id: 5 })
    expect(res.status).toBe(202)
    expect((await body(res)).data.jobId).toBe(101)
  })
  test('관문 79: 타인 artifact_id → 403, 잡 INSERT 없음·큐 전송 없음', async () => {
    const { json, db, queue } = makeApp()
    db.firstQueue.push(null) // 소유권 확인 실패
    const res = await json('/jobs', 'POST', { ...base, kind: 'modify', artifact_id: 5 })
    expect(res.status).toBe(403)
    expect((await body(res)).error).toBe('권한 없음')
    // 잡이 생성되지 않았음을 호출 기록으로 확인 (INSERT 자체가 없어야 한다)
    expect(db.calls.some(c => c.sql.includes('INSERT INTO artifact_jobs'))).toBe(false)
    expect(queue.sent).toHaveLength(0)
  })
  test('관문 79: 존재하지 않는 artifact_id → 403 (소유권 확인과 동일 경로)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/jobs', 'POST', { ...base, artifact_id: 999 })
    expect(res.status).toBe(403)
  })
  test('멱등성 → deduped 202', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 77, status: 'pending' })
    const res = await json('/jobs', 'POST', { ...base, client_request_id: 'req-1' })
    expect(res.status).toBe(202)
    const j = await body(res)
    expect(j.data.jobId).toBe(77)
    expect(j.data.deduped).toBe(true)
  })
  test('채팅 중복 → insert 스킵', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 100 } })
    db.runQueue.push({ meta: { last_row_id: 50 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push({ id: 9 }) // dupMsg 있음
    const res = await json('/jobs', 'POST', base)
    expect(res.status).toBe(202)
  })
  test('큐 전송 실패 → 500', async () => {
    const { json, db } = makeApp({ queueThrows: true })
    db.runQueue.push({ meta: { last_row_id: 100 } })
    db.runQueue.push({ meta: { last_row_id: 50 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } }) // failed 업데이트
    const res = await json('/jobs', 'POST', base)
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('큐 전송 실패')
  })
  test('prompt 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { kind: 'create' })
    expect(res.status).toBe(400)
  })
  test('prompt 10000자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { prompt: 'x'.repeat(10001) })
    expect(res.status).toBe(400)
  })
  test('잘못된 provider → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, provider: 'openai' })
    expect(res.status).toBe(400)
  })
  test('유효한 provider 통과', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 1 } })
    db.runQueue.push({ meta: { last_row_id: 2 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    for (const p of ['gemini', 'groq']) {
      const res = await json('/jobs', 'POST', { ...base, provider: p })
      expect(res.status).toBe(202)
    }
  })
  test('provider=nvidia → 400 (2026-10-30: NVIDIA 운영 제외)', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, provider: 'nvidia' })
    expect(res.status).toBe(400)
  })
  test('base_html 2MB 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, base_html: 'x'.repeat(2 * 1024 * 1024 + 1) })
    expect(res.status).toBe(400)
  })
  test('model 100자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, model: 'x'.repeat(101) })
    expect(res.status).toBe(400)
  })
  test('잘못된 kind → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, kind: 'delete' })
    expect(res.status).toBe(400)
  })
  test('kind modify 통과', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 5 }) // 관문 79: artifact 소유권 확인 통과
    db.runQueue.push({ meta: { last_row_id: 1 } })
    const res = await json('/jobs', 'POST', { ...base, kind: 'modify', artifact_id: 5 })
    expect(res.status).toBe(202)
  })
  test('kind 없음 → create 기본값', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 1 } })
    db.runQueue.push({ meta: { last_row_id: 2 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/jobs', 'POST', { prompt: 'hi' })
    expect(res.status).toBe(202)
    expect(db.calls[0].params[0]).toBe('create')
  })
  test('긴 prompt → 제목 슬라이스', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 1 } })
    db.runQueue.push({ meta: { last_row_id: 2 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/jobs', 'POST', { prompt: '계산서 만들어줘 부탁해' })
    expect(res.status).toBe(202)
    // title에서 접미사 제거 확인
    expect(db.calls[1].params[0]).toBe('계산서')
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('boom'))
    const res = await json('/jobs', 'POST', base)
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /jobs/:id ----------------
describe('GET /jobs/:id', () => {
  test('작업 조회 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, status: 'done' })
    const res = await json('/jobs/1', 'GET')
    expect((await body(res)).ok).toBe(true)
  })
  test('없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/jobs/1', 'GET')
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/jobs/1', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /jobs/:id/events ----------------
describe('GET /jobs/:id/events', () => {
  test('이벤트 조회 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.allQueue.push([{ id: 1, event_type: 'start' }])
    const res = await json('/jobs/1/events', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data).toHaveLength(1)
  })
  test('since 파라미터', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.allQueue.push([])
    const res = await json('/jobs/1/events?since=10', 'GET')
    expect((await body(res)).ok).toBe(true)
    expect(db.calls[1].params[1]).toBe(10)
  })
  test('소유권 없음 → 403', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/jobs/1/events', 'GET')
    expect(res.status).toBe(403)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/jobs/1/events', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /jobs ----------------
describe('GET /jobs', () => {
  test('작업 목록 조회', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 1 }])
    const res = await json('/jobs', 'GET')
    expect((await body(res)).ok).toBe(true)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('boom'))
    const res = await json('/jobs', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- GET /:id ----------------
describe('GET /:id', () => {
  test('상세 조회 (html 포함)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, title: 'T', html_content: '<html>' })
    const res = await json('/1', 'GET')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.html_content).toBe('<html>')
  })
  test('html 없음 → 레거시 조회', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, title: 'T', html_content: null })
    db.firstQueue.push({ html_content: '<legacy>' })
    const res = await json('/1', 'GET')
    expect((await body(res)).data.html_content).toBe('<legacy>')
  })
  test('레거시도 없음 → 빈 문자열', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, title: 'T', html_content: null })
    db.firstQueue.push(null)
    const res = await json('/1', 'GET')
    expect((await body(res)).data.html_content).toBe('')
  })
  test('없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/1', 'GET')
    expect(res.status).toBe(404)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/1', 'GET')
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /jobs/:id/seen ----------------
describe('POST /jobs/:id/seen', () => {
  test('확인 처리 성공', async () => {
    const { json } = makeApp()
    const res = await json('/jobs/1/seen', 'POST', {})
    expect((await body(res)).ok).toBe(true)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('boom'))
    const res = await json('/jobs/1/seen', 'POST', {})
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /model ----------------
describe('POST /model', () => {
  test('모델 변경 성공 (레지스트리 활성 모델)', async () => {
    const { json } = makeApp()
    const res = await json('/model', 'POST', { model: 'gemini-3.5-flash-lite' })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.model).toBe('gemini-3.5-flash-lite')
  })
  test('NVIDIA 모델 → 400 (2026-10-30: 비활성 모델 거부)', async () => {
    const { json } = makeApp()
    const res = await json('/model', 'POST', { model: 'nvidia/nemotron-3-ultra-550b-a55b' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('not active')
  })
  test('허용 안 된 모델 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/model', 'POST', { model: 'gpt-4' })
    expect(res.status).toBe(400)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('boom'))
    const res = await json('/model', 'POST', { model: 'openai/gpt-oss-20b' })
    expect(res.status).toBe(500)
  })
})

// ---------------- POST /jobs/:id/cancel ----------------
describe('POST /jobs/:id/cancel', () => {
  test('취소 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ status: 'running' })
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect((await body(res)).ok).toBe(true)
  })
  test('작업 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect(res.status).toBe(404)
  })
  test('이미 완료 → 400', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ status: 'done' })
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect(res.status).toBe(400)
  })
  test('이미 실패 → 400', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ status: 'failed' })
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect(res.status).toBe(400)
  })
  test('관문 81: awaiting_input 취소 → 성공 + UPDATE 대상에 awaiting_input 포함', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ status: 'awaiting_input' })
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect((await body(res)).ok).toBe(true)
    const upd = db.calls.find(c => c.sql.includes("status='failed'"))
    expect(upd).toBeDefined()
    expect(upd!.sql).toContain('awaiting_input')
  })
  test('관문 81: UPDATE 0건 변경 (경합으로 상태 전이) → 거짓 성공 금지, 400', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ status: 'pending' })
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect(res.status).toBe(400)
    expect((await body(res)).ok).toBe(false)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('boom'))
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect(res.status).toBe(500)
  })
})

// ---------------- A1: POST /jobs/:id/answer ----------------
describe('POST /jobs/:id/answer', () => {
  const pendingJob = () => ({
    id: 1,
    status: 'awaiting_input',
    owner_email: 'test@example.com',
    pending_state: JSON.stringify({
      questions: [{ id: 'color', question: '어떤 색?' }],
      answers: [],
      files: {},
    }),
  })

  test('답변 성공 → pending + 큐 전송', async () => {
    const { json, db, queue } = makeApp()
    db.firstQueue.push(pendingJob())
    const res = await json('/jobs/1/answer', 'POST', {
      answers: [{ id: 'color', answer: '파란색' }],
    })
    const b = await body(res)
    expect(res.status).toBe(202)
    expect(b.ok).toBe(true)
    expect(queue.sent).toHaveLength(1)
    expect(queue.sent[0]).toEqual({ jobId: 1 })
    // status=pending으로 업데이트됐는지
    const updateCall = db.calls.find(c => c.sql.includes("SET status='pending'"))
    expect(updateCall).toBeDefined()
  })

  test('작업 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/jobs/1/answer', 'POST', { answers: [{ id: 'a', answer: 'b' }] })
    expect(res.status).toBe(404)
  })

  test('대기 중이 아님 → 400', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, status: 'running', owner_email: 'test@example.com' })
    const res = await json('/jobs/1/answer', 'POST', { answers: [{ id: 'a', answer: 'b' }] })
    expect(res.status).toBe(400)
  })

  test('answers 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs/1/answer', 'POST', {})
    expect(res.status).toBe(400)
  })

  test('잘못된 answer 형식 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs/1/answer', 'POST', { answers: [{ id: 123 }] })
    expect(res.status).toBe(400)
  })

  test('질문 ID와 안 맞는 답변 → 400', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(pendingJob())
    const res = await json('/jobs/1/answer', 'POST', { answers: [{ id: 'wrong', answer: 'x' }] })
    expect(res.status).toBe(400)
  })

  test('답변 길이 제한 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/jobs/1/answer', 'POST', {
      answers: [{ id: 'color', answer: 'x'.repeat(2001) }],
    })
    expect(res.status).toBe(400)
  })

  test('다른 사용자 job → 404', async () => {
    const { json, db } = makeApp({ userEmail: 'other@example.com' })
    db.firstQueue.push(null) // owner_email 불일치로 조회 실패
    const res = await json('/jobs/1/answer', 'POST', { answers: [{ id: 'a', answer: 'b' }] })
    expect(res.status).toBe(404)
  })
})

// ---------------- POST /chats/cleanup ----------------
describe('POST /chats/cleanup', () => {
  test('정리 성공', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 5 } })
    const res = await json('/chats/cleanup', 'POST', {})
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.data.deleted).toBe(5)
  })
  test('meta 없음 → 0', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({})
    const res = await json('/chats/cleanup', 'POST', {})
    expect((await body(res)).data.deleted).toBe(0)
  })
  test('DB 에러 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('boom'))
    const res = await json('/chats/cleanup', 'POST', {})
    expect(res.status).toBe(500)
  })
})

// ---------------- 브랜치 커버리지 보완 ----------------
describe('branch coverage', () => {
  test('GET /:id/versions versions null', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.allQueue.push(null)
    db.firstQueue.push({ draft_version_id: 1, published_version_id: null })
    const j = await body(await json('/5/versions', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data.versions).toEqual([])
  })
  test('GET files results null', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push({ id: 9 })
    db.allQueue.push(null)
    const j = await body(await json('/5/versions/2/files', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data).toEqual([])
  })
  test('diff getFiles results null', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.firstQueue.push({ id: 10 })
    db.allQueue.push(null)
    db.firstQueue.push(null)
    const j = await body(await json('/5/versions/1/diff/2', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data.changes).toEqual([])
  })
  test('GET /jobs/:id/events results null', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1 })
    db.allQueue.push(null)
    const j = await body(await json('/jobs/1/events', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data).toEqual([])
  })
  test('GET /jobs results null', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(null)
    const j = await body(await json('/jobs', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data).toEqual([])
  })
  test('GET /drafts results null', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(null)
    const j = await body(await json('/drafts', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data).toEqual([])
  })
  test('GET /chats results null', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(null)
    // 필터 없는 호출은 400이므로 필터 있는 요청으로 results null 경로를 검증한다.
    const j = await body(await json('/chats?session_key=abc', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data).toEqual([])
  })
  test('GET /search results null', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(null)
    db.allQueue.push(null)
    const j = await body(await json('/search?q=x', 'GET'))
    expect(j.ok).toBe(true)
    expect(j.data.projects).toEqual([])
    expect(j.data.chats).toEqual([])
  })
  test('POST /jobs client_request_id 있지만 기존 없음', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null) // existing 없음
    db.runQueue.push({ meta: { last_row_id: 100 } })
    db.runQueue.push({ meta: { last_row_id: 50 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/jobs', 'POST', { prompt: 'hi', client_request_id: 'req-2' })
    expect(res.status).toBe(202)
    expect((await body(res)).data.deduped).toBeUndefined()
  })
  test('POST /jobs 제목 폴백 (새 대화)', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 100 } })
    db.runQueue.push({ meta: { last_row_id: 50 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/jobs', 'POST', { prompt: ' 해줘' })
    expect(res.status).toBe(202)
    expect(db.calls[1].params[0]).toBe('새 대화')
  })
  test('POST /jobs 큐 에러 메시지 없음 → unknown', async () => {
    const { json, db } = makeApp({ queueThrows: true, queueEmptyMessage: true })
    db.runQueue.push({ meta: { last_row_id: 100 } })
    db.runQueue.push({ meta: { last_row_id: 50 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/jobs', 'POST', { prompt: 'hi' })
    expect(res.status).toBe(500)
    // bind('큐 전송 실패: ' + 'unknown'...)
    expect(db.calls[db.calls.length - 1].params[0]).toContain('unknown')
  })
})
