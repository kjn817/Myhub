/// <reference types="jest" />
/**
 * src/modules/memo/routes-files.ts — 파인더 파일 표면 + 잠긴 파일 삭제 게이트.
 * (메모 단위 첨부 목록·업로드·다운로드 리다이렉트는 memo-routes.test.ts가
 * 이미 다룬다. 여기는 그 스위트가 닿지 않은 영역만 본다.)
 *
 * 핵심 성질: ① 파인더 목록(/files·/files/trash)은 is_locked를 boolean으로
 * 바꾸고 휴지통 목록만 deleted_at을 싣는다 ② 휴지통 이동은 잠긴 파일을
 * 403 LOCKED로 막고, 이미 버려진 파일은 멱등하게 답하며, 성공 시에만
 * 통계를 무효화한다 ③ 잠긴 파일의 영구 삭제는 보호 게이트를 통과해야만
 * 스토리지 삭제에 닿고, PIN 미설정이면 면제 규칙대로 진행된다
 * ④ 정적 경로 /files가 /:id 상세에 삼켜지지 않는다.
 * 카나리아: trash의 잠금 검사를 지우거나 게이트 호출을 빼면 실패한다.
 */
import { Hono } from 'hono'

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
import { storageDestroy, storageUpload, thumbUrl } from '../../src/services/storage'
import { emit } from '../../src/events'

const mockStorageDestroy = storageDestroy as unknown as jest.Mock
const mockStorageUpload = storageUpload as unknown as jest.Mock
const mockThumbUrl = thumbUrl as unknown as jest.Mock
const mockEmit = emit as unknown as jest.Mock

class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
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

  async batch() {
    return []
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

function makeApp(opts: { kvThrows?: boolean } = {}) {
  const db = new MockDb()
  const kv = new MockKv()
  if (opts.kvThrows) kv.shouldThrow = true
  const app = new Hono()
  app.route('/a', memoApp)
  const env: any = { DB: db, KV: kv, CLOUDINARY_CLOUD_NAME: 'demo' }
  const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
  const json = (path: string, method: string) => req(path, { method })
  return { db, kv, env, req, json }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockStorageDestroy.mockResolvedValue(undefined)
  mockStorageUpload.mockResolvedValue({
    public_id: 'pid1',
    bytes: 100,
    secure_url: 'https://cdn/x',
    resource_type: 'image',
  })
  mockThumbUrl.mockImplementation((cn: string, pid: string) => `https://thumb/${pid}`)
  mockEmit.mockResolvedValue(undefined)
})

const FILE_ROW = {
  id: 11,
  memo_id: 5,
  memo_text: '메모 본문',
  filename: 'a.png',
  mime: 'image/png',
  size: 100,
  url: 'https://cdn/a.png',
  is_locked: 1,
  created_at: '2026-11-01T00:00:00Z',
}

// ---------------- GET /files (파인더 전체 파일) ----------------
describe('GET /files — 파인더 전체 파일 목록', () => {
  test('행 매핑: is_locked는 boolean으로, /:id 상세가 아닌 파일 목록이 답한다', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([FILE_ROW, { ...FILE_ROW, id: 12, is_locked: 0 }])
    const res = await json('/files', 'GET')
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual([
      {
        id: 11, memo_id: 5, memo_text: '메모 본문', filename: 'a.png', mime: 'image/png',
        size: 100, is_locked: true, url: 'https://cdn/a.png', created_at: '2026-11-01T00:00:00Z',
      },
      {
        id: 12, memo_id: 5, memo_text: '메모 본문', filename: 'a.png', mime: 'image/png',
        size: 100, is_locked: false, url: 'https://cdn/a.png', created_at: '2026-11-01T00:00:00Z',
      },
    ])
    expect(j[0]).not.toHaveProperty('deleted_at')
  })

  test('파일이 없으면 빈 배열', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    const res = await json('/files', 'GET')
    expect(await res.json()).toEqual([])
  })
})

// ---------------- GET /files/trash ----------------
describe('GET /files/trash — 휴지통 목록', () => {
  test('deleted_at을 포함해 매핑한다', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ ...FILE_ROW, is_locked: 0, deleted_at: '2026-11-05T00:00:00Z' }])
    const res = await json('/files/trash', 'GET')
    const j = await res.json()
    expect(j).toHaveLength(1)
    expect(j[0].deleted_at).toBe('2026-11-05T00:00:00Z')
    expect(j[0].is_locked).toBe(false)
  })
})

// ---------------- POST /files/:fileId/trash ----------------
describe('POST /files/:fileId/trash — 휴지통 이동', () => {
  test('없는 파일 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/files/999/trash', 'POST')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'not found' })
  })

  test('잠긴 파일 → 403 LOCKED, 상태 변경도 통계 무효화도 없다', async () => {
    const { json, db, kv } = makeApp()
    db.firstQueue.push({ is_locked: 1, deleted_at: null })
    const res = await json('/files/11/trash', 'POST')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'LOCKED' })
    expect(db.calls.some((c) => c.sql.includes('UPDATE files SET deleted_at'))).toBe(false)
    expect(kv.deleteCalls).toEqual([])
  })

  test('이미 버려진 파일 → 멱등하게 { ok: true, already: true }', async () => {
    const { json, db, kv } = makeApp()
    db.firstQueue.push({ is_locked: 0, deleted_at: '2026-11-05T00:00:00Z' })
    const res = await json('/files/11/trash', 'POST')
    expect(await res.json()).toEqual({ ok: true, already: true })
    expect(kv.deleteCalls).toEqual([])
  })

  test('성공 → { ok: true } + 통계 무효화 + 해당 파일만 갱신', async () => {
    const { json, db, kv } = makeApp()
    db.firstQueue.push({ is_locked: 0, deleted_at: null })
    const res = await json('/files/11/trash', 'POST')
    expect(await res.json()).toEqual({ ok: true })
    expect(kv.deleteCalls).toContain('system:stats')
    const upd = db.calls.find((c) => c.sql.includes('UPDATE files SET deleted_at'))
    expect(upd?.params).toEqual(['11'])
  })

  test('통계 무효화(KV)가 실패해도 이동은 성공으로 답한다', async () => {
    const { json, db } = makeApp({ kvThrows: true })
    db.firstQueue.push({ is_locked: 0, deleted_at: null })
    const res = await json('/files/11/trash', 'POST')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// ---------------- POST /files/:fileId/restore ----------------
describe('POST /files/:fileId/restore — 복원', () => {
  test('없는 파일 → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/files/999/restore', 'POST')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'not found' })
  })

  test('버려지지 않은 파일 → 멱등하게 { ok: true, already: true }', async () => {
    const { json, db, kv } = makeApp()
    db.firstQueue.push({ deleted_at: null })
    const res = await json('/files/11/restore', 'POST')
    expect(await res.json()).toEqual({ ok: true, already: true })
    expect(kv.deleteCalls).toEqual([])
  })

  test('복원 성공 → deleted_at을 NULL로 되돌리고 통계를 무효화한다', async () => {
    const { json, db, kv } = makeApp()
    db.firstQueue.push({ deleted_at: '2026-11-05T00:00:00Z' })
    const res = await json('/files/11/restore', 'POST')
    expect(await res.json()).toEqual({ ok: true })
    expect(kv.deleteCalls).toContain('system:stats')
    const upd = db.calls.find((c) => c.sql.includes('SET deleted_at = NULL'))
    expect(upd?.params).toEqual(['11'])
  })

  test('통계 무효화(KV)가 실패해도 복원은 성공으로 답한다', async () => {
    const { json, db } = makeApp({ kvThrows: true })
    db.firstQueue.push({ deleted_at: '2026-11-05T00:00:00Z' })
    const res = await json('/files/11/restore', 'POST')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// ---------------- POST /:id/files — 다중 파일 ----------------
describe('POST /:id/files — 다중 파일 업로드', () => {
  test('같은 필드로 여러 파일을 보내면 전부 저장된다 (배열 분기)', async () => {
    const { req, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 55, changes: 1 } })
    db.runQueue.push({ meta: { last_row_id: 56, changes: 1 } })
    const fd = new FormData()
    fd.append('files', new File(['x'], 'a.png', { type: 'image/png' }))
    fd.append('files', new File(['yy'], 'b.png', { type: 'image/png' }))
    const res = await req('/9/files', { method: 'POST', body: fd })
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.files).toEqual([
      { id: 55, filename: 'a.png', size: 100 },
      { id: 56, filename: 'b.png', size: 100 },
    ])
  })
})

// ---------------- GET /:id/files — mime 없는 행 ----------------
describe('GET /:id/files — mime이 없는 행', () => {
  test('mime이 NULL이면 thumb는 null이다', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      { id: 1, memo_id: 5, filename: 'x', mime: null, size: 1, is_locked: 0, url: 'https://cdn/x', storage_key: 'k', created_at: 'c' },
    ])
    const res = await json('/5/files', 'GET')
    const j = await res.json()
    expect(j[0].thumb).toBeNull()
    expect(mockThumbUrl).not.toHaveBeenCalled()
  })
})

// ---------------- DELETE /files/:fileId — 잠긴 파일 게이트 ----------------
describe('DELETE /files/:fileId — 잠긴 파일 보호 게이트', () => {
  test('PIN이 설정돼 있고 step-up이 없으면 403, 스토리지·DB 삭제에 닿지 않는다', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([{ storage_key: 'k9', resource_type: 'image', is_locked: 1 }])
    db.firstQueue.push({ pin_hash: 'h', pin_salt: 's', iterations: 1000 }) // auth_pins 행 = PIN 설정됨
    const res = await json('/files/9', 'DELETE')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'step_up_required', code: 'STEP_UP_REQUIRED' })
    expect(mockStorageDestroy).not.toHaveBeenCalled()
    expect(db.calls.some((c) => c.sql.includes('DELETE FROM files'))).toBe(false)
  })

  test('PIN 미설정이면 면제 규칙대로 잠긴 파일도 삭제가 진행된다', async () => {
    const { json, db, kv } = makeApp()
    db.allQueue.push([{ storage_key: 'k9', resource_type: 'image', is_locked: 1 }])
    // firstQueue 비어 있음 → auth_pins 행 없음 → 게이트 면제
    const res = await json('/files/9', 'DELETE')
    expect(await res.json()).toEqual({ ok: true })
    expect(mockStorageDestroy).toHaveBeenCalledWith(expect.anything(), 'k9', 'image')
    expect(mockEmit).toHaveBeenCalledWith('memo.deleted', { id: 9 })
    expect(kv.deleteCalls).toContain('system:stats')
  })
})
