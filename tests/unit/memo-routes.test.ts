/**
 * src/modules/memo/routes.ts 100% 커버리지 단위 테스트
 * - D1 Mock (prepare/bind/first/all/run/batch)
 * - KV Mock (delete with catch)
 * - Hono app.request()로 HTTP 시뮬레이션
 * - crypto/storage/events 모듈 mock
 */
/// <reference types="jest" />
import { Hono } from 'hono'

// ---------------- 모듈 mock (hoisted) ----------------
jest.mock('../../src/services/crypto', () => ({
  encryptContent: jest.fn(),
  decryptContent: jest.fn(),
  encryptBytes: jest.fn(),
  decryptBytes: jest.fn(),
  isEncrypted: jest.fn(),
}))
jest.mock('../../src/services/storage', () => ({
  storageUpload: jest.fn(),
  storageDestroy: jest.fn(),
  thumbUrl: jest.fn(),
}))
jest.mock('../../src/events', () => ({
  emit: jest.fn(),
}))

import { memoApp } from '../../src/modules/memo/routes'
import { hashPin } from '../../src/modules/auth/routes'
import {
  encryptContent,
  decryptContent,
  encryptBytes,
  decryptBytes,
  isEncrypted,
} from '../../src/services/crypto'
import { storageUpload, storageDestroy, thumbUrl } from '../../src/services/storage'
import { emit } from '../../src/events'

const mockEncryptContent = encryptContent as jest.Mock
const mockDecryptContent = decryptContent as jest.Mock
const mockEncryptBytes = encryptBytes as jest.Mock
const mockDecryptBytes = decryptBytes as jest.Mock
const mockIsEncrypted = isEncrypted as jest.Mock
const mockStorageUpload = storageUpload as jest.Mock
const mockStorageDestroy = storageDestroy as jest.Mock
const mockThumbUrl = thumbUrl as jest.Mock
const mockEmit = emit as jest.Mock

// ---------------- Mock D1 ----------------
class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
  batchQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []

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

  async batch(stmts: any[]) {
    const v = this.batchQueue.shift()
    if (v === undefined) return []
    if (v instanceof Error) throw v
    return v
  }
}

class MockKv {
  deleteCalls: string[] = []
  shouldThrow = false
  async delete(key: string) {
    this.deleteCalls.push(key)
    if (this.shouldThrow) throw new Error('kv down')
  }
}

function makeApp(opts: { db?: MockDb; kv?: MockKv; kvThrows?: boolean } = {}) {
  const db = opts.db ?? new MockDb()
  const kv = opts.kv ?? new MockKv()
  if (opts.kvThrows) kv.shouldThrow = true
  const app = new Hono()
  app.route('/a', memoApp)
  const env: any = { DB: db, KV: kv, CLOUDINARY_CLOUD_NAME: 'demo' }
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
  return { app, db, kv, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsEncrypted.mockReturnValue(false)
  mockEncryptContent.mockImplementation(async (_env: any, t: string) => 'ENC:' + t)
  mockDecryptContent.mockImplementation(async (_env: any, t: string) =>
    t.startsWith('ENC:') ? t.slice(4) : t
  )
  mockStorageUpload.mockResolvedValue({
    public_id: 'pid1',
    bytes: 100,
    secure_url: 'https://cdn/x',
    resource_type: 'image',
  })
  mockStorageDestroy.mockResolvedValue(undefined)
  mockThumbUrl.mockImplementation((cn: string, pid: string) => `https://thumb/${pid}`)
  mockEmit.mockResolvedValue(undefined)
})

// ---------------- GET /stats ----------------
describe('GET /stats', () => {
  test('통계 반환', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ n: 10 })
    db.firstQueue.push({ n: 5, s: 1234 })
    db.firstQueue.push({ n: 3 })
    const res = await json('/stats', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ memos: 10, files: 5, bytes: 1234, week: 3 })
  })

  test('null 결과 → 0 폴백', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    const res = await json('/stats', 'GET')
    const j = await body(res)
    expect(j).toEqual({ memos: 0, files: 0, bytes: 0, week: 0 })
  })
})

// ---------------- GET /tags ----------------
describe('GET /tags', () => {
  test('태그 목록', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { tag: 'work', n: 5 },
      { tag: 'idea', n: 2 },
    ])
    const res = await json('/tags', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toHaveLength(2)
    expect(j[0].tag).toBe('work')
  })
})

// ---------------- GET /calendar ----------------
describe('GET /calendar', () => {
  test('기본(현재 월) 조회', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ day: '2026-10-17', n: 2 }])
    const res = await json('/calendar', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toHaveLength(1)
    // bind에 start/end 전달 확인
    const call = db.calls[db.calls.length - 1]
    expect(call.params).toHaveLength(2)
  })

  test('y/m 쿼리 + 12월 경계', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    const res = await json('/calendar?y=2026&m=12', 'GET')
    expect(res.status).toBe(200)
    const call = db.calls[db.calls.length - 1]
    // P-3: KST 월 경계를 UTC 범위로 변환해 바인딩한다.
    // 2026-12-01 KST 00:00 = 2026-11-30 15:00 UTC, 2027-01-01 KST = 2026-12-31 15:00 UTC
    expect(call.params[0]).toBe('2026-11-30 15:00:00')
    expect(call.params[1]).toBe('2026-12-31 15:00:00')
    expect(call.sql).toContain('created_at >= ? AND created_at < ?')
    expect(call.sql).not.toContain("datetime(created_at, '+9 hours')")
  })
})

// ---------------- GET / (목록) ----------------
describe('GET / 목록', () => {
  test('검색 없이 전체 조회 + 페이지네이션', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 1, text: 'a', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 0 }])
    const res = await json('/?limit=10&offset=5', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toHaveLength(1)
    const call = db.calls[db.calls.length - 1]
    // limit/offset이 마지막 2개 파라미터
    expect(call.params.slice(-2)).toEqual([10, 5])
  })

  test('limit 상한 200', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    await json('/?limit=9999', 'GET')
    const call = db.calls[db.calls.length - 1]
    expect(call.params.slice(-2)[0]).toBe(200)
  })

  test('태그 필터', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    await json('/?tag=work', 'GET')
    const call = db.calls[db.calls.length - 1]
    expect(call.sql).toContain('JOIN memo_tags')
    expect(call.params).toContain('work')
  })

  test('날짜 필터', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    await json('/?date=2026-10-17', 'GET')
    const call = db.calls[db.calls.length - 1]
    // P-3: KST 날짜를 UTC 범위로 변환한다 (2026-10-17 KST = 10-16 15:00 ~ 10-17 15:00 UTC)
    expect(call.params).toContain('2026-10-16 15:00:00')
    expect(call.params).toContain('2026-10-17 15:00:00')
    expect(call.sql).toContain('m.created_at >= ? AND m.created_at < ?')
    expect(call.sql).not.toContain("date(m.created_at, '+9 hours')")
  })

  test('날짜 필터: 무효한 날짜는 매치 없음', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    await json('/?date=not-a-date', 'GET')
    const call = db.calls[db.calls.length - 1]
    // 구 date() 조건과 동일하게 어떤 행도 매치하지 않는다
    expect(call.sql).toContain('1 = 0')
  })

  test('FTS5 검색 성공', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 1, text: 'hello world', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 0 },
    ])
    db.allQueue.push([]) // LIKE 폴백
    const res = await json('/?q=hello', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toHaveLength(1)
    expect(db.calls[0].sql).toContain('MATCH')
  })

  test('FTS5 검색: 잠긴 메모 복호화', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    mockDecryptContent.mockResolvedValue('plain')
    db.allQueue.push([
      { id: 2, text: 'ENC:secret', created_at: 'x', is_locked: 1, sensitivity: 0, file_count: 0 },
    ])
    db.allQueue.push([])
    const res = await json('/?q=secret', 'GET')
    const j = await body(res)
    expect(j[0].text).toBe('plain')
  })

  test('FTS5 검색: 복호화 실패 → [복호화 실패]', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    mockDecryptContent.mockRejectedValue(new Error('no key'))
    db.allQueue.push([
      { id: 3, text: 'ENC:x', created_at: 'x', is_locked: 1, sensitivity: 0, file_count: 0 },
    ])
    db.allQueue.push([])
    const res = await json('/?q=x', 'GET')
    const j = await body(res)
    expect(j[0].text).toBe('[복호화 실패]')
  })

  test('FTS5 throw → trigram 폴백으로 진행 (LIKE 스킵)', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('fts fail'))
    db.allQueue.push([{ id: 5, text: 'fallback', created_at: 'x', file_count: 0 }])
    const res = await json('/?q=fallback', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(1)
    expect(j[0].id).toBe(5)
    // 두 번째 쿼리는 trigram 부분 검색 (3글자 이상이라 LIKE는 스킵)
    expect(db.calls[1].sql).toContain('memos_fts_tri')
    expect(db.calls.some((c) => c.sql.includes('REPLACE(m.text'))).toBe(false)
  })

  test('FTS5 + trigram throw → 파일명 빈 결과 → LIKE 폴백으로 진행', async () => {
    const { json, db } = makeApp()
    db.allQueue.push(new Error('fts fail'))
    db.allQueue.push(new Error('trigram fail'))
    db.allQueue.push([]) // 파일명 단계
    db.allQueue.push([{ id: 5, text: 'fallback', created_at: 'x', file_count: 0 }])
    const res = await json('/?q=fallback', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(1)
    expect(j[0].id).toBe(5)
    // 파일명 단계가 먼저 돌고 LIKE 폴백이 찾는다
    expect(db.calls[2].sql).toContain('filename LIKE')
    expect(db.calls[3].sql).toContain("REPLACE(m.text, ' ', '') LIKE")
  })

  test('trigram 단계: seen 중복 제외', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 7, text: 'dup', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 0 },
    ])
    db.allQueue.push([{ id: 8, text: 'dup2', created_at: 'x', file_count: 0 }])
    const res = await json('/?q=dup', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(2)
    // 두 번째 쿼리(trigram)에 NOT IN 포함
    expect(db.calls[1].sql).toContain('NOT IN')
  })

  test('trigram 부분검색: 3글자 이상은 LIKE 스킵', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([]) // FTS: 토큰 정확 일치 없음
    db.allQueue.push([
      { id: 1, text: '김치찌개', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 0 },
    ])
    const res = await json('/?q=김치찌개', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(1)
    expect(j[0].id).toBe(1)
    expect(db.calls[1].sql).toContain('memos_fts_tri')
    // LIKE 폴백 쿼리 자체가 실행되지 않음 (본문 전수 스캔 없음)
    expect(db.calls.some((c) => c.sql.includes('REPLACE(m.text'))).toBe(false)
  })

  test('짧은 검색어 LIKE 폴백: 2글자는 trigram 건너뛰고 LIKE 실행', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([]) // FTS
    db.allQueue.push([]) // 파일명
    db.allQueue.push([
      { id: 2, text: '대한민국', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 0 },
    ])
    const res = await json('/?q=한국', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(1)
    expect(j[0].id).toBe(2)
    // trigram 단계는 아예 실행되지 않음 (2글자는 trigram이 못 찾음)
    expect(db.calls.some((c) => c.sql.includes('memos_fts_tri'))).toBe(false)
    // LIKE 폴백은 공백 제거 LIKE를 포함한다
    expect(db.calls.some((c) => c.sql.includes("REPLACE(m.text, ' ', '') LIKE"))).toBe(true)
  })

  test('파일명 검색: trigram 빈 결과 후 filename LIKE로 찾음', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([]) // FTS
    db.allQueue.push([]) // trigram
    db.allQueue.push([
      { id: 3, text: '본문 무관', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 1 },
    ])
    const res = await json('/?q=계획서', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(1)
    expect(j[0].id).toBe(3)
    expect(db.calls[2].sql).toContain('filename LIKE')
    // trigram이 성공했으므로 LIKE 폴백은 스킵
    expect(db.calls.some((c) => c.sql.includes('REPLACE(m.text'))).toBe(false)
  })

  test('fileCount는 LEFT JOIN 집계 1회 (행별 상관 서브쿼리 없음)', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 1, text: 'hello', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 2 },
    ])
    db.allQueue.push([])
    db.allQueue.push([])
    await json('/?q=hello', 'GET')
    for (const call of db.calls) {
      expect(call.sql).toContain('LEFT JOIN (SELECT memo_id, COUNT(*) AS n FROM files GROUP BY memo_id)')
      expect(call.sql).not.toContain('(SELECT COUNT(*) FROM files f WHERE f.memo_id = m.id)')
    }
  })

  test('빈 검색어 토큰 → fq 빈 문자열 → LIKE만', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 9, text: 'x', created_at: 'x', file_count: 0 }])
    const res = await json('/?q=+++', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toHaveLength(1)
  })

  test('무검색 목록: 잠긴 메모는 복호화해서 반환 (원시 ENC: 노출 금지)', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.allQueue.push([
      { id: 2, text: 'ENC:secret', created_at: 'x', is_locked: 1, sensitivity: 0, file_count: 0 },
    ])
    const res = await json('/', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j[0].text).toBe('secret')
  })

  test('무검색 목록: 복호화 실패 → [복호화 실패] (원시 ENC: 노출 금지)', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    mockDecryptContent.mockRejectedValue(new Error('no key'))
    db.allQueue.push([
      { id: 3, text: 'ENC:x', created_at: 'x', is_locked: 1, sensitivity: 0, file_count: 0 },
    ])
    const res = await json('/', 'GET')
    const j = await body(res)
    expect(j[0].text).toBe('[복호화 실패]')
    expect(j[0].text).not.toContain('ENC:')
  })
})

// ---------------- POST / (생성) ----------------
describe('POST / 생성', () => {
  test('JSON 본문으로 생성', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 42, changes: 1 } }) // INSERT memos
    db.runQueue.push({ meta: { last_row_id: 0, changes: 1 } }) // syncTags DELETE
    const res = await json('/', 'POST', { text: 'hello #work' })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.id).toBe(42)
    expect(j.files).toEqual([])
    expect(mockEmit).toHaveBeenCalledWith('memo.created', { id: 42 })
    // 태그 동기화: DELETE + batch INSERT
    expect(db.calls[1].sql).toContain('DELETE FROM memo_tags')
  })

  test('빈 텍스트 + 파일 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/', 'POST', { text: '   ' })
    expect(res.status).toBe(400)
    const j = await body(res)
    expect(j.error).toBe('empty')
  })

  test('JSON 파싱 실패 → 빈 객체 → 400', async () => {
    const { req } = makeApp()
    const res = await req('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
  })

  test('multipart: 텍스트 + 파일 업로드', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 7, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 0, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 99, changes: 1 } }) // INSERT files
    const fd = new FormData()
    fd.append('text', 'with file')
    fd.append('files', new File(['data'], 'a.png', { type: 'image/png' }))
    const res = await req('/', { method: 'POST', body: fd })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.files).toHaveLength(1)
    expect(j.files[0].filename).toBe('a.png')
    expect(mockStorageUpload).toHaveBeenCalled()
  })

  test('multipart: 크기 0 파일은 건너뜀', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 8, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 0, changes: 1 } })
    const fd = new FormData()
    fd.append('text', 'empty file')
    fd.append('files', new File([], 'empty.txt', { type: 'text/plain' }))
    const res = await req('/', { method: 'POST', body: fd })
    const j = await body(res)
    expect(j.files).toEqual([])
    expect(mockStorageUpload).not.toHaveBeenCalled()
  })

  test('multipart: File 아닌 값은 필터링', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 9, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 0, changes: 1 } })
    const fd = new FormData()
    fd.append('text', 'x')
    fd.append('files', 'just-a-string')
    const res = await req('/', { method: 'POST', body: fd })
    const j = await body(res)
    expect(j.files).toEqual([])
  })

  test('태그 없음 → batch 호출 안 함', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 11, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 0, changes: 1 } })
    const res = await json('/', 'POST', { text: 'no tags here' })
    expect(res.status).toBe(200)
    // batch가 호출되지 않았는지 — calls에 INSERT INTO memo_tags 없음
    const tagInserts = db.calls.filter((c) => c.sql.includes('INSERT INTO memo_tags'))
    expect(tagInserts).toHaveLength(0)
  })

  test('태그 추출: #한글 #abc_123 중복 제거', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 12, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 0, changes: 1 } })
    const res = await json('/', 'POST', { text: '#한글 #abc_123 #한글' })
    expect(res.status).toBe(200)
  })
})

// ---------------- GET /:id ----------------
describe('GET /:id', () => {
  test('정상 조회', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      id: 1,
      text: 'hello',
      created_at: 'c',
      updated_at: 'u',
      is_locked: 0,
      sensitivity: 0,
    })
    const res = await json('/1', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.memo.text).toBe('hello')
    expect(j.memo.content).toBe('hello')
  })

  test('INVALID_ID: 0', async () => {
    const { json } = makeApp()
    const res = await json('/0', 'GET')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('INVALID_ID')
  })

  test('INVALID_ID: 음수', async () => {
    const { json } = makeApp()
    const res = await json('/-5', 'GET')
    expect(res.status).toBe(400)
  })

  test('INVALID_ID: 소수', async () => {
    const { json } = makeApp()
    const res = await json('/1.5', 'GET')
    expect(res.status).toBe(400)
  })

  test('INVALID_ID: 문자열', async () => {
    const { json } = makeApp()
    const res = await json('/abc', 'GET')
    expect(res.status).toBe(400)
  })

  test('NOT_FOUND', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999', 'GET')
    expect(res.status).toBe(404)
    expect((await body(res)).error).toBe('NOT_FOUND')
  })

  test('잠긴 메모 → 소유자에게 복호화해서 반환 (원시 ENC: 노출 금지)', async () => {
    // 교체 사유: 구 기대값(404 위장)은 목록 FTS 분기의 소유자 복호화와
    // 모순됐다 — 같은 소유자 세션에서 목록으로는 본문이 보이는데 단건만
    // 404였다. 이 라우트는 전역 세션 인증 뒤의 소유자 전용 경로이고, AI
    // 차단은 ai-access.ts가 별도로 담당하므로 소유자 복호화로 통일한다.
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ id: 2, text: 'ENC:secret', created_at: 'c', updated_at: 'u', is_locked: 1, sensitivity: 0 })
    const res = await json('/2', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.memo.text).toBe('secret')
    expect(j.memo.content).toBe('secret')
    expect(j.memo.is_locked).toBe(1)
  })

  test('잠긴 메모 복호화 실패 → 플레이스홀더 (원시 ENC: 노출 금지)', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    mockDecryptContent.mockRejectedValue(new Error('no key'))
    db.firstQueue.push({ id: 2, text: 'ENC:secret', created_at: 'c', updated_at: 'u', is_locked: 1, sensitivity: 0 })
    const res = await json('/2', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.memo.text).toBe('[복호화 실패]')
    expect(j.memo.text).not.toContain('ENC:')
  })

  test('DB_ERROR → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('db down'))
    const res = await json('/1', 'GET')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('DB_ERROR')
  })
})

// ---------------- PUT /:id ----------------
describe('PUT /:id', () => {
  test('수정 성공 + 태그 동기화', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE
    db.runQueue.push({ meta: { changes: 1 } }) // syncTags DELETE
    const res = await json('/5', 'PUT', { text: 'new #tag' })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(mockEmit).toHaveBeenCalledWith('memo.updated', { id: 5 })
  })

  test('빈 텍스트 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5', 'PUT', { text: '  ' })
    expect(res.status).toBe(400)
  })

  test('JSON 파싱 실패 → 400', async () => {
    const { req } = makeApp()
    const res = await req('/5', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{{{',
    })
    expect(res.status).toBe(400)
  })

  test('잠긴 메모 수정 → 암호화해서 저장 (평문 덮어쓰기 금지)', async () => {
    // 카나리아: PUT이 is_locked를 보지 않고 평문을 저장하던 주원인 결함.
    // 잠금 인지 로직을 되돌리면 UPDATE 파라미터가 평문이 되어 실패한다.
    const { json, db } = makeApp()
    db.firstQueue.push({ is_locked: 1 })
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE
    db.runQueue.push({ meta: { changes: 1 } }) // syncTags DELETE
    const res = await json('/5', 'PUT', { text: 'edited secret' })
    expect(res.status).toBe(200)
    expect(mockEncryptContent).toHaveBeenCalled()
    const upd = db.calls.find((call) => call.sql.includes('UPDATE memos SET text'))
    expect(upd?.params[0]).toBe('ENC:edited secret')
  })

  test('잠긴 메모 수정: 암호화 실패 → 500 encrypt_failed + DB 불변', async () => {
    const { json, db } = makeApp()
    mockEncryptContent.mockRejectedValue(new Error('no key'))
    db.firstQueue.push({ is_locked: 1 })
    const res = await json('/5', 'PUT', { text: 'edited secret' })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('encrypt_failed')
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos SET text'))).toBe(false)
  })

  test('잠기지 않은 메모 수정 → 기존대로 평문 저장 (암호화 호출 없음)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5', 'PUT', { text: 'plain edit' })
    expect(res.status).toBe(200)
    expect(mockEncryptContent).not.toHaveBeenCalled()
    const upd = db.calls.find((call) => call.sql.includes('UPDATE memos SET text'))
    expect(upd?.params[0]).toBe('plain edit')
  })
})

// ---------------- POST /:id/lock ----------------
describe('POST /:id/lock', () => {
  test('잠금: 평문 → 암호화', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ text: 'plain', is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/3/lock', 'POST', { locked: true })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.is_locked).toBe(1)
    expect(mockEncryptContent).toHaveBeenCalled()
    // UPDATE에 암호화된 텍스트
    const upd = db.calls[db.calls.length - 1]
    expect(upd.params[1]).toBe('ENC:plain')
  })

  test('잠금: 이미 암호화된 텍스트는 재암호화 안 함', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ text: 'ENC:x', is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    await json('/4/lock', 'POST', { locked: true })
    expect(mockEncryptContent).not.toHaveBeenCalled()
  })

  test('잠금: 암호화 실패 → 500 encrypt_failed + DB 불변 (fail-closed)', async () => {
    // 카나리아: 구 결함(암호화 실패에도 is_locked=1·평문으로 UPDATE하고 200
    // 반환)을 정상으로 고정했던 테스트를 교체한다. fail-open으로 되돌리면
    // 이 테스트가 실패해야 한다.
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(false)
    mockEncryptContent.mockRejectedValue(new Error('no key'))
    db.firstQueue.push({ text: 'plain', is_locked: 0 })
    const res = await json('/6/lock', 'POST', { locked: true })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('encrypt_failed')
    // UPDATE가 실행되지 않았다 (SELECT 1건만)
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos SET is_locked'))).toBe(false)
  })

  test('잠금: 평문으로 남은 잠긴 메모에 재잠금 → 암호화 수행 (전환 경로)', async () => {
    // 구 fail-open 잔재: is_locked=1인데 본문이 평문. lock(true) 재호출이
    // 실제 암호화로 전환해야 한다 (운영 데이터 전환이 이 경로로 수행됨).
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(false)
    db.firstQueue.push({ text: 'plain-but-locked', is_locked: 1 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/6/lock', 'POST', { locked: true })
    expect(res.status).toBe(200)
    expect(mockEncryptContent).toHaveBeenCalled()
    const upd = db.calls[db.calls.length - 1]
    expect(upd.params[0]).toBe(1)
    expect(upd.params[1]).toBe('ENC:plain-but-locked')
  })

  test('해제: 암호문 → 복호화', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ text: 'ENC:secret', is_locked: 1 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/7/lock', 'POST', { locked: false })
    const j = await body(res)
    expect(j.is_locked).toBe(0)
    expect(mockDecryptContent).toHaveBeenCalled()
  })

  test('해제: 복호화 실패 → 500', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    mockDecryptContent.mockRejectedValue(new Error('bad key'))
    db.firstQueue.push({ text: 'ENC:x', is_locked: 1 })
    const res = await json('/8/lock', 'POST', { locked: false })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('decrypt_failed')
  })

  test('상태 변경 없음 → 암호화/복호화 스킵', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ text: 'plain', is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    await json('/9/lock', 'POST', { locked: false })
    expect(mockEncryptContent).not.toHaveBeenCalled()
    expect(mockDecryptContent).not.toHaveBeenCalled()
  })

  test('이미 잠김 + 잠금 요청 → 스킵', async () => {
    const { json, db } = makeApp()
    // 전제 교정: 본문이 'ENC:x'이면 isEncrypted는 실제로 true다. 구 테스트는
    // mock 설정을 빠뜨린 채 플래그 기반 스킵에 기대고 있었다 — 잠금 판단이
    // 본문 형태 기준으로 바뀌면서 mock도 실제 의미에 맞게 설정한다.
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ text: 'ENC:x', is_locked: 1 })
    db.runQueue.push({ meta: { changes: 1 } })
    await json('/10/lock', 'POST', { locked: true })
    expect(mockEncryptContent).not.toHaveBeenCalled()
  })

  test('메모 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999/lock', 'POST', { locked: true })
    expect(res.status).toBe(404)
  })

  test('locked falsy → 0', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ text: 't', is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/11/lock', 'POST', {})
    expect((await body(res)).is_locked).toBe(0)
  })
})

// ---------------- POST /:id/lock-block ----------------
describe('POST /:id/lock-block', () => {
  test('블록 잠금 성공', async () => {
    const { json, db } = makeApp()
    // D-3: 잠금은 본문에 포함된 html에 대해서만 성립한다 (fail-closed)
    db.firstQueue.push({ id: 1, text: '앞 <b>secret</b> 뒤', locked_blocks: '[]' })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/1/lock-block', 'POST', { html: '<b>secret</b>' })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.blockId).toMatch(/^blk_/)
    expect(mockEncryptContent).toHaveBeenCalled()
    // D-3: 같은 UPDATE가 본문의 html을 마커로 치환한다 (replace + instr 가드)
    const upd = db.calls.find((call) => call.sql.includes('UPDATE memos'))
    expect(upd).toBeDefined()
    expect(upd!.sql).toContain('replace(text, ?, ?)')
    expect(upd!.sql).toContain('instr(text, ?) > 0')
    expect(upd!.params[1]).toBe('<b>secret</b>')
    expect(upd!.params[2]).toBe(`[LOCKED_BLOCK:${j.blockId}]`)
  })

  test('D-3: html이 본문에 없으면 409 + DB 불변 (평문이 남는 잠금 금지)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, text: '전혀 다른 본문', locked_blocks: '[]' })
    const res = await json('/1/lock-block', 'POST', { html: '<b>secret</b>' })
    const j = await body(res)
    expect(res.status).toBe(409)
    expect(j.error).toBe('block_not_in_text')
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos'))).toBe(false)
  })

  test('빈 html → 400', async () => {
    const { json } = makeApp()
    const res = await json('/1/lock-block', 'POST', { html: '' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('empty_html')
  })

  test('html 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/1/lock-block', 'POST', {})
    expect(res.status).toBe(400)
  })

  test('메모 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999/lock-block', 'POST', { html: '<b>x</b>' })
    expect(res.status).toBe(404)
    expect((await body(res)).error).toBe('memo_not_found')
  })

  test('locked_blocks 컬럼 없음 → migration_needed 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(new Error('no such column'))
    const res = await json('/1/lock-block', 'POST', { html: '<b>x</b>' })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('migration_needed')
  })

  test('json_insert 실패 → migration_needed 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, text: '<b>x</b>', locked_blocks: '[]' })
    db.runQueue.push(new Error('json_insert fail'))
    const res = await json('/1/lock-block', 'POST', { html: '<b>x</b>' })
    expect(res.status).toBe(500)
  })

  test('changes=0 → memo_not_found 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, text: '<b>x</b>', locked_blocks: '[]' })
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/1/lock-block', 'POST', { html: '<b>x</b>' })
    expect(res.status).toBe(404)
  })

  test('meta undefined → changes 0 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, text: '<b>x</b>', locked_blocks: '[]' })
    db.runQueue.push({})
    const res = await json('/1/lock-block', 'POST', { html: '<b>x</b>' })
    expect(res.status).toBe(404)
  })

  test('암호화 throw → encrypt_failed 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, locked_blocks: '[]' })
    mockEncryptContent.mockRejectedValue(new Error('enc fail'))
    const res = await json('/1/lock-block', 'POST', { html: '<b>x</b>' })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('encrypt_failed')
  })
})

// ---------------- POST /:id/unlock-block/:blockId ----------------
describe('POST /:id/unlock-block/:blockId', () => {
  test('블록 해제 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:html' }]),
    })
    const res = await json('/1/unlock-block/blk_1', 'POST')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.html).toBe('html')
  })

  test('블록 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ locked_blocks: '[]' })
    const res = await json('/1/unlock-block/nope', 'POST')
    expect(res.status).toBe(404)
  })

  test('locked_blocks 깨진 JSON → 빈 배열 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ locked_blocks: 'not-json' })
    const res = await json('/1/unlock-block/x', 'POST')
    expect(res.status).toBe(404)
  })

  test('memo 없음 → locked_blocks null → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999/unlock-block/x', 'POST')
    expect(res.status).toBe(404)
  })

  test('복호화 실패 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:x' }]),
    })
    mockDecryptContent.mockRejectedValue(new Error('bad'))
    const res = await json('/1/unlock-block/blk_1', 'POST')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('decrypt_failed')
  })

  test('해제 성공 → locked_blocks에서 해당 블록 제거 UPDATE 실행', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([
        { id: 'blk_1', encrypted: 'ENC:a' },
        { id: 'blk_2', encrypted: 'ENC:b' },
      ]),
    })
    const res = await json('/1/unlock-block/blk_1', 'POST')
    expect(res.status).toBe(200)
    const updates = db.calls.filter((c) => c.sql.includes('UPDATE memos'))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toContain('json_group_array')
    // 바인드 순서: 제거할 blockId, 메모 id
    expect(updates[0].params).toEqual(['blk_1', '1'])
  })

  test('복호화 실패 → DB 쓰기 없음 (암호문 보존)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:x' }]),
    })
    mockDecryptContent.mockRejectedValue(new Error('bad'))
    const res = await json('/1/unlock-block/blk_1', 'POST')
    expect(res.status).toBe(500)
    const updates = db.calls.filter((c) => c.sql.includes('UPDATE memos'))
    expect(updates).toHaveLength(0)
  })

  test('제거 UPDATE 실패 → 평문은 반환 + warning', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:html' }]),
    })
    db.runQueue.push(new Error('d1 down'))
    const res = await json('/1/unlock-block/blk_1', 'POST')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.html).toBe('html')
    expect(j.warning).toBe('unlock_pending')
  })
})

// ---------------- POST /files/:fileId/lock ----------------
describe('POST /files/:fileId/lock', () => {
  const fileRow = {
    id: 1,
    filename: 'a.png',
    mime: 'image/png',
    url: 'https://cdn/a.png',
    is_locked: 0,
  }

  test('파일 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/files/999/lock', 'POST', { locked: true })
    expect(res.status).toBe(404)
  })

  test('파일 잠금: 다운로드→암호화→업로드', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow })
    db.runQueue.push({ meta: { changes: 1 } })
    const fetchMock = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    ;(global as any).fetch = fetchMock
    mockEncryptBytes.mockResolvedValue(new ArrayBuffer(8))
    const res = await json('/files/1/lock', 'POST', { locked: true })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.is_locked).toBe(1)
    expect(mockEncryptBytes).toHaveBeenCalled()
    delete (global as any).fetch
  })

  test('파일 잠금: 암호화 실패 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockEncryptBytes.mockRejectedValue(new Error('enc fail'))
    const res = await json('/files/1/lock', 'POST', { locked: true })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('encrypt_failed')
    delete (global as any).fetch
  })

  test('파일 해제: 복호화→업로드', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow, is_locked: 1 })
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockDecryptBytes.mockResolvedValue(new ArrayBuffer(8))
    const res = await json('/files/1/lock', 'POST', { locked: false })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.is_locked).toBe(0)
    delete (global as any).fetch
  })

  test('파일 해제: 복호화 실패 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow, is_locked: 1 })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockDecryptBytes.mockRejectedValue(new Error('dec fail'))
    const res = await json('/files/1/lock', 'POST', { locked: false })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('decrypt_failed')
    delete (global as any).fetch
  })

  test('상태 변경 없음 → 스킵', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow, is_locked: 0 })
    const res = await json('/files/1/lock', 'POST', { locked: false })
    expect((await body(res)).ok).toBe(true)
    expect(mockEncryptBytes).not.toHaveBeenCalled()
  })

  test('D-1 잠금: DB 교체 후 구 storage_key를 destroy 한다', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow, storage_key: 'old-key', resource_type: 'raw' })
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockEncryptBytes.mockResolvedValue(new ArrayBuffer(8))
    const res = await json('/files/1/lock', 'POST', { locked: true })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.warning).toBeUndefined()
    expect(mockStorageDestroy).toHaveBeenCalledWith(expect.anything(), 'old-key', 'raw')
    delete (global as any).fetch
  })

  test('D-1 해제: DB 교체 후 .enc storage_key를 destroy 한다', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow, is_locked: 1, storage_key: 'enc-key', resource_type: 'raw' })
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockDecryptBytes.mockResolvedValue(new ArrayBuffer(8))
    const res = await json('/files/1/lock', 'POST', { locked: false })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(mockStorageDestroy).toHaveBeenCalledWith(expect.anything(), 'enc-key', 'raw')
    delete (global as any).fetch
  })

  test('D-1 destroy 실패 → 잠금은 성공 유지 + warning 표면화 (침묵 금지)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow, storage_key: 'old-key', resource_type: 'raw' })
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockEncryptBytes.mockResolvedValue(new ArrayBuffer(8))
    mockStorageDestroy.mockRejectedValueOnce(new Error('cloudinary down'))
    const res = await json('/files/1/lock', 'POST', { locked: true })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.is_locked).toBe(1)
    expect(j.warning).toBe('storage_cleanup_failed')
    delete (global as any).fetch
  })

  test('D-1 destroy가 false 반환 → warning 표면화', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ ...fileRow, storage_key: 'old-key', resource_type: 'raw' })
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockEncryptBytes.mockResolvedValue(new ArrayBuffer(8))
    mockStorageDestroy.mockResolvedValueOnce(false)
    const res = await json('/files/1/lock', 'POST', { locked: true })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.warning).toBe('storage_cleanup_failed')
    delete (global as any).fetch
  })
})

// ---------------- GET /files/:fileId/content ----------------
describe('GET /files/:fileId/content', () => {
  test('파일 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/files/999/content', 'GET')
    expect(res.status).toBe(404)
  })

  test('잠긴 파일: 복호화 후 서빙', async () => {
    const { req, db } = makeApp()
    db.firstQueue.push({
      id: 1,
      filename: 'a.png',
      mime: 'image/png',
      url: 'https://cdn/enc',
      is_locked: 1,
    })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(4),
    })
    mockDecryptBytes.mockResolvedValue(new ArrayBuffer(4))
    const res = await req('/files/1/content', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    delete (global as any).fetch
  })

  test('잠긴 파일: 복호화 실패 → 500', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, url: 'https://cdn/enc', is_locked: 1, mime: 'image/png', filename: 'a' })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(4),
    })
    mockDecryptBytes.mockRejectedValue(new Error('bad'))
    const res = await json('/files/1/content', 'GET')
    expect(res.status).toBe(500)
    delete (global as any).fetch
  })

  test('잠기지 않은 파일 → 302 리다이렉트', async () => {
    const { req, db } = makeApp()
    db.firstQueue.push({ id: 2, url: 'https://cdn/plain', is_locked: 0 })
    const res = await req('/files/2/content', { method: 'GET' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://cdn/plain')
  })
})

// ---------------- POST /:id/sensitivity ----------------
describe('POST /:id/sensitivity', () => {
  test('정상 설정', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5/sensitivity', 'POST', { sensitivity: 2 })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.sensitivity).toBe(2)
  })

  test('상한 3', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5/sensitivity', 'POST', { sensitivity: 99 })
    expect((await body(res)).sensitivity).toBe(3)
  })

  test('하한 0', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5/sensitivity', 'POST', { sensitivity: -5 })
    expect((await body(res)).sensitivity).toBe(0)
  })

  test('기본값 1', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5/sensitivity', 'POST', {})
    expect((await body(res)).sensitivity).toBe(1)
  })

  test('JSON 파싱 실패 → 기본값', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await req('/5/sensitivity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{{{',
    })
    expect((await body(res)).sensitivity).toBe(1)
  })
})

// ---------------- DELETE /:id ----------------
describe('DELETE /:id', () => {
  test('삭제 성공: 파일·태그·메모 + KV 무효화 + 이벤트', async () => {
    const { json, db, kv } = makeApp()
    db.allQueue.push([{ storage_key: 'k1', resource_type: 'image' }])
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/7', 'DELETE')
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(mockStorageDestroy).toHaveBeenCalledWith(expect.anything(), 'k1', 'image')
    expect(kv.deleteCalls).toContain('system:stats')
    expect(mockEmit).toHaveBeenCalledWith('memo.deleted', { id: 7 })
  })

  test('KV 실패해도 무시', async () => {
    const { json, db } = makeApp({ kvThrows: true })
    db.allQueue.push([])
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/8', 'DELETE')
    expect((await body(res)).ok).toBe(true)
  })
})

// ---------------- GET /:id/files ----------------
describe('GET /:id/files', () => {
  test('파일 목록 + 썸네일', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      {
        id: 1,
        memo_id: 5,
        filename: 'a.png',
        mime: 'image/png',
        size: 100,
        is_locked: 0,
        url: 'https://cdn/a.png',
        storage_key: 'k1',
        created_at: 'c',
      },
      {
        id: 2,
        memo_id: 5,
        filename: 'b.pdf',
        mime: 'application/pdf',
        size: 200,
        is_locked: 1,
        url: 'https://cdn/b.pdf',
        storage_key: 'k2',
        created_at: 'c',
      },
    ])
    const res = await json('/5/files', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(2)
    expect(j[0].thumb).toBe('https://thumb/k1')
    expect(j[1].thumb).toBeNull()
    expect(j[1].is_locked).toBe(true)
    expect(mockThumbUrl).toHaveBeenCalledWith('demo', 'k1')
  })

  test('이미지 아님/URL 없음 → thumb null', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 3, memo_id: 5, filename: 'c.txt', mime: 'text/plain', size: 10, is_locked: 0, url: 'https://cdn/c', storage_key: 'k3', created_at: 'c' },
    ])
    const res = await json('/5/files', 'GET')
    const j = await body(res)
    expect(j[0].thumb).toBeNull()
  })
})

// ---------------- POST /:id/files ----------------
describe('POST /:id/files', () => {
  test('파일 추가 성공 + KV 무효화', async () => {
    const { req, db, kv } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 55, changes: 1 } })
    const fd = new FormData()
    fd.append('files', new File(['x'], 'n.png', { type: 'image/png' }))
    const res = await req('/9/files', { method: 'POST', body: fd })
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.files).toHaveLength(1)
    expect(kv.deleteCalls).toContain('system:stats')
  })

  test('파일 없음 → 400', async () => {
    const { req } = makeApp()
    const fd = new FormData()
    const res = await req('/9/files', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
  })

  test('10MB 초과 → 400', async () => {
    const { req } = makeApp()
    const big = new File([new ArrayBuffer(10 * 1024 * 1024 + 1)], 'big.bin')
    const fd = new FormData()
    fd.append('files', big)
    const res = await req('/9/files', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
    const j = await body(res)
    expect(j.error).toContain('10MB')
  })

  test('saveFiles throw → 500', async () => {
    const { req, db } = makeApp()
    mockStorageUpload.mockRejectedValueOnce(new Error('upload boom'))
    const fd = new FormData()
    fd.append('files', new File(['x'], 'n.png', { type: 'image/png' }))
    const res = await req('/9/files', { method: 'POST', body: fd })
    expect(res.status).toBe(500)
    const j = await body(res)
    expect(j.ok).toBe(false)
    expect(j.error).toContain('upload boom')
  })
})

// ---------------- GET /files/:fileId ----------------
describe('GET /files/:fileId', () => {
  test('302 리다이렉트', async () => {
    const { req, db } = makeApp()
    db.allQueue.push([{ url: 'https://cdn/f' }])
    const res = await req('/files/3', { method: 'GET' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://cdn/f')
  })

  test('D-2 잠긴 파일 → 암호문 URL이 아니라 /content로 302', async () => {
    const { req, db } = makeApp()
    db.allQueue.push([{ url: 'https://cdn/f.enc', is_locked: 1 }])
    const res = await req('/files/3', { method: 'GET' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/api/memo/files/3/content')
  })

  test('URL 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ url: null }])
    const res = await json('/files/3', 'GET')
    expect(res.status).toBe(404)
  })

  test('행 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    const res = await json('/files/3', 'GET')
    expect(res.status).toBe(404)
  })
})

// ---------------- DELETE /files/:fileId ----------------
describe('DELETE /files/:fileId', () => {
  test('삭제 성공', async () => {
    const { json, db, kv } = makeApp()
    db.allQueue.push([{ storage_key: 'k9', resource_type: 'image' }])
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/files/9', 'DELETE')
    expect((await body(res)).ok).toBe(true)
    expect(mockStorageDestroy).toHaveBeenCalledWith(expect.anything(), 'k9', 'image')
    expect(kv.deleteCalls).toContain('system:stats')
  })

  test('파일 없음 → 404', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    const res = await json('/files/999', 'DELETE')
    expect(res.status).toBe(404)
  })
})

// ---------------- 추가 브랜치 커버 ----------------
describe('추가 브랜치', () => {
  test('FTS: 따옴표만 있는 검색어 → fq 빈 문자열 → LIKE만', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ id: 1, text: 'x', created_at: 'x', file_count: 0 }])
    const res = await json('/?q=%22%22%22', 'GET') // """
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j).toHaveLength(1)
    // FTS MATCH 쿼리가 실행되지 않음
    expect(db.calls[0].sql).not.toContain('MATCH')
  })

  test('FTS + 태그 필터: where AND 결합', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 1, text: 'hello', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 0 },
    ])
    db.allQueue.push([])
    const res = await json('/?q=hello&tag=work', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].sql).toContain('AND t.tag = ?')
  })

  test('FTS 결과가 limit 채움 → LIKE 스킵', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 1, text: 'a', created_at: 'x', is_locked: 0, sensitivity: 0, file_count: 0 },
    ])
    const res = await json('/?q=a&limit=1', 'GET')
    const j = await body(res)
    expect(j).toHaveLength(1)
    expect(db.calls).toHaveLength(1) // LIKE 쿼리 없음
  })

  test('POST content-type 없음 → JSON 파싱 시도', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 20, changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    // body 없이 전송 → undici가 content-type을 자동 설정하지 않음 → || '' 분기
    const res = await req('/', { method: 'POST' })
    // body가 없으므로 JSON 파싱 실패 → text='' → 400
    expect(res.status).toBe(400)
  })

  test('multipart: files 필드 없음 → 빈 배열', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 23, changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const fd = new FormData()
    fd.append('text', 'no files field')
    const res = await req('/', { method: 'POST', body: fd })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.files).toEqual([])
  })

  test('multipart: 파일 mime은 문자열로 저장 (방어적 || null 분기는 HTTP 경로에서 도달 불가)', async () => {
    // Hono multipart 파서가 File.type을 항상 문자열로 정규화하므로
    // f.type || null 의 null 분기는 HTTP 경로에서 도달 불가 (방어 코드)
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 21, changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 100, changes: 1 } })
    const fd = new FormData()
    fd.append('text', 'x')
    fd.append('files', new File(['d'], 'a.bin', { type: '' }))
    const res = await req('/', { method: 'POST', body: fd })
    expect(res.status).toBe(200)
    const insertCall = db.calls.find((c) => c.sql.includes('INSERT INTO files'))
    expect(insertCall).toBeDefined()
    expect(typeof insertCall!.params[3]).toBe('string')
  })

  test('multipart: 여러 파일 → 배열 분기', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 22, changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 101, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 102, changes: 1 } })
    const fd = new FormData()
    fd.append('text', 'multi')
    fd.append('files', new File(['a'], 'a.txt', { type: 'text/plain' }))
    fd.append('files', new File(['b'], 'b.txt', { type: 'text/plain' }))
    const res = await req('/', { method: 'POST', body: fd })
    const j = await body(res)
    expect(j.files.length).toBeGreaterThanOrEqual(1)
  })

  test('POST /:id/files: 여러 파일 → 배열 분기', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 103, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 104, changes: 1 } })
    const fd = new FormData()
    fd.append('files', new File(['a'], 'a.txt', { type: 'text/plain' }))
    fd.append('files', new File(['b'], 'b.txt', { type: 'text/plain' }))
    const res = await req('/9/files', { method: 'POST', body: fd })
    const j = await body(res)
    expect(j.ok).toBe(true)
  })

  test('lock 해제: 암호화되지 않은 텍스트(is_locked=1) → 복호화 스킵', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(false)
    db.firstQueue.push({ text: 'plain', is_locked: 1 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/13/lock', 'POST', { locked: false })
    expect((await body(res)).ok).toBe(true)
    expect(mockDecryptContent).not.toHaveBeenCalled()
  })

  test('파일 해제: mime 없음 → octet-stream 폴백', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, filename: 'a', mime: null, url: 'https://cdn/e', is_locked: 1 })
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockDecryptBytes.mockResolvedValue(new ArrayBuffer(8))
    const res = await json('/files/1/lock', 'POST', { locked: false })
    expect((await body(res)).ok).toBe(true)
    delete (global as any).fetch
  })

  test('파일 서빙: mime 없음 → octet-stream', async () => {
    const { req, db } = makeApp()
    db.firstQueue.push({ id: 1, filename: 'a', mime: null, url: 'https://cdn/e', is_locked: 1 })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(4),
    })
    mockDecryptBytes.mockResolvedValue(new ArrayBuffer(4))
    const res = await req('/files/1/content', { method: 'GET' })
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    delete (global as any).fetch
  })
})

// ---------------- 잠금 해제 step-up (PIN 재인증) ----------------
// 카나리아 대상: routes.ts의 checkUnlockPin 검증. 검증을 제거하면
// 'PIN 없이 해제 → 403' 테스트들이 200을 받아 실패해야 한다.
describe('잠금 해제 step-up (PIN)', () => {
  const TEST_PIN = '135790' // 테스트 전용 PIN (실제 사용자 PIN 아님)
  let pinRow: { pin_hash: string; pin_salt: string; iterations: number }

  beforeAll(async () => {
    const { hashB64, saltB64, iterations } = await hashPin(TEST_PIN)
    pinRow = { pin_hash: hashB64, pin_salt: saltB64, iterations }
  })

  test('메모 해제: PIN 행 있음 + PIN 없음 → 403 PIN_REQUIRED + 상태 불변', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ text: 'ENC:secret', is_locked: 1 }) // 메모
    db.firstQueue.push(pinRow) // auth_pins
    const res = await json('/7/lock', 'POST', { locked: false })
    const j = await body(res)
    expect(res.status).toBe(403)
    expect(j.code).toBe('PIN_REQUIRED')
    expect(mockDecryptContent).not.toHaveBeenCalled()
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos SET is_locked'))).toBe(false)
  })

  test('메모 해제: 틀린 PIN → 403 PIN_INVALID + 상태 불변', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ text: 'ENC:secret', is_locked: 1 })
    db.firstQueue.push(pinRow)
    const res = await json('/7/lock', 'POST', { locked: false, pin: '000000' })
    const j = await body(res)
    expect(res.status).toBe(403)
    expect(j.code).toBe('PIN_INVALID')
    expect(mockDecryptContent).not.toHaveBeenCalled()
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos SET is_locked'))).toBe(false)
  })

  test('메모 해제: 맞는 PIN → 200 + 복호화·UPDATE 실행', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ text: 'ENC:secret', is_locked: 1 })
    db.firstQueue.push(pinRow)
    const res = await json('/7/lock', 'POST', { locked: false, pin: TEST_PIN })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.is_locked).toBe(0)
    expect(mockDecryptContent).toHaveBeenCalled()
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos SET is_locked'))).toBe(true)
  })

  test('메모 잠금: PIN 행이 있어도 PIN 없이 성공 + auth_pins 조회 없음', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ text: 'plain', is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/3/lock', 'POST', { locked: true })
    expect(res.status).toBe(200)
    expect((await body(res)).is_locked).toBe(1)
    expect(db.calls.some((call) => call.sql.includes('auth_pins'))).toBe(false)
  })

  test('메모 해제: PIN 미설정(auth_pins 행 없음) → PIN 없이 허용 (lockout 방지 정책)', async () => {
    const { json, db } = makeApp()
    mockIsEncrypted.mockReturnValue(true)
    db.firstQueue.push({ text: 'ENC:secret', is_locked: 1 })
    db.firstQueue.push(null) // auth_pins 행 없음
    const res = await json('/7/lock', 'POST', { locked: false })
    expect(res.status).toBe(200)
    expect((await body(res)).is_locked).toBe(0)
  })

  test('메모 해제: 이미 해제된 메모의 무동작 해제 → step-up 없음', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ text: 'plain', is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/9/lock', 'POST', { locked: false })
    expect(res.status).toBe(200)
    expect(db.calls.some((call) => call.sql.includes('auth_pins'))).toBe(false)
  })

  test('블록 해제: PIN 없음 → 403 PIN_REQUIRED + locked_blocks 불변', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:html' }]),
    })
    db.firstQueue.push(pinRow)
    const res = await json('/1/unlock-block/blk_1', 'POST')
    const j = await body(res)
    expect(res.status).toBe(403)
    expect(j.code).toBe('PIN_REQUIRED')
    expect(j.html).toBeUndefined()
    expect(mockDecryptContent).not.toHaveBeenCalled()
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos'))).toBe(false)
  })

  test('블록 해제: 틀린 PIN → 403 PIN_INVALID + 불변', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:html' }]),
    })
    db.firstQueue.push(pinRow)
    const res = await json('/1/unlock-block/blk_1', 'POST', { pin: '000000' })
    expect(res.status).toBe(403)
    expect((await body(res)).code).toBe('PIN_INVALID')
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos'))).toBe(false)
  })

  test('블록 해제: 맞는 PIN → 200 + html 반환 + 제거 UPDATE', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:html' }]),
    })
    db.firstQueue.push(pinRow)
    const res = await json('/1/unlock-block/blk_1', 'POST', { pin: TEST_PIN })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.html).toBe('html')
    expect(db.calls.some((call) => call.sql.includes('UPDATE memos'))).toBe(true)
  })

  test('블록 해제: PIN 미설정 → PIN 없이 허용', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      locked_blocks: JSON.stringify([{ id: 'blk_1', encrypted: 'ENC:html' }]),
    })
    db.firstQueue.push(null)
    const res = await json('/1/unlock-block/blk_1', 'POST')
    expect(res.status).toBe(200)
    expect((await body(res)).html).toBe('html')
  })

  test('파일 해제: PIN 없음 → 403 PIN_REQUIRED + 복호화·다운로드 없음', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, filename: 'a.png', mime: 'image/png', url: 'https://cdn/e', is_locked: 1 })
    db.firstQueue.push(pinRow)
    const fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
    const res = await json('/files/1/lock', 'POST', { locked: false })
    const j = await body(res)
    expect(res.status).toBe(403)
    expect(j.code).toBe('PIN_REQUIRED')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockDecryptBytes).not.toHaveBeenCalled()
    delete (global as any).fetch
  })

  test('파일 해제: 맞는 PIN → 200 해제 성공', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, filename: 'a.png', mime: 'image/png', url: 'https://cdn/e', is_locked: 1 })
    db.firstQueue.push(pinRow)
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockDecryptBytes.mockResolvedValue(new ArrayBuffer(8))
    const res = await json('/files/1/lock', 'POST', { locked: false, pin: TEST_PIN })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.is_locked).toBe(0)
    expect(mockDecryptBytes).toHaveBeenCalled()
    delete (global as any).fetch
  })

  test('파일 잠금: PIN 행이 있어도 PIN 없이 성공 + auth_pins 조회 없음', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ id: 1, filename: 'a.png', mime: 'image/png', url: 'https://cdn/a', is_locked: 0 })
    db.runQueue.push({ meta: { changes: 1 } })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    mockEncryptBytes.mockResolvedValue(new ArrayBuffer(8))
    const res = await json('/files/1/lock', 'POST', { locked: true })
    expect(res.status).toBe(200)
    expect(db.calls.some((call) => call.sql.includes('auth_pins'))).toBe(false)
    delete (global as any).fetch
  })
})
