/// <reference types="jest" />
/**
 * 메모 잠금 경로 변이 테스트 대응 — 생존 변이가 가리킨 성질 검증.
 * memo-routes.test.ts와 같은 mock 패턴(D1 큐 mock + crypto/storage mock)을 쓴다.
 * - title_hint 3분기(잠금 시 생성·이미 암호화된 메모는 보존·해제 시 제거)는
 *   기존 스위트가 UPDATE 바인드를 단언하지 않아 놓쳤다 (ML-02·ML-03).
 * - 블록 제거 SQL의 조건(!=)은 큐 mock이 실행하지 않으므로 SQL 계약으로 고정한다 (ML-07).
 */
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

import { Hono } from 'hono'
import { memoApp } from '../../src/modules/memo/routes'
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
      first: async () => exec([]).first(),
      all: async () => exec([]).all(),
      run: async () => exec([]).run(),
    }
  }
}

class MockKv {
  async get() {
    return null
  }
  async put() {}
  async delete() {}
}

function makeApp() {
  const db = new MockDb()
  const app = new Hono()
  app.route('/a', memoApp)
  const env: any = { DB: db, KV: new MockKv(), CLOUDINARY_CLOUD_NAME: 'demo' }
  const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
  const json = (path: string, method: string, body?: any) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { db, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsEncrypted.mockImplementation((t: any) => typeof t === 'string' && t.startsWith('ENC:'))
  mockEncryptContent.mockImplementation(async (_env: any, t: string) => 'ENC:' + t)
  mockDecryptContent.mockImplementation(async (_env: any, t: string) =>
    t.startsWith('ENC:') ? t.slice(4) : t,
  )
  mockEncryptBytes.mockImplementation(async (_env: any, b: ArrayBuffer) => b)
  mockDecryptBytes.mockImplementation(async (_env: any, b: ArrayBuffer) => b)
  mockStorageUpload.mockResolvedValue({
    public_id: 'pid1',
    bytes: 100,
    secure_url: 'https://cdn/x',
    resource_type: 'image',
  })
  mockStorageDestroy.mockResolvedValue(undefined)
  mockThumbUrl.mockImplementation((_cn: string, pid: string) => `https://thumb/${pid}`)
  mockEmit.mockResolvedValue(undefined)
})

function lockUpdate(db: MockDb) {
  return db.calls.find((c) => c.sql.includes('UPDATE memos SET is_locked'))
}

describe('title_hint 3분기 (ML-02·ML-03)', () => {
  test('잠금(평문): 제목 힌트는 본문 첫 제목 줄에서 만들어져 함께 저장된다', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ text: '주간 회의\n본문 내용입니다', is_locked: 0, title_hint: null })
    const res = await json('/3/lock', 'POST', { locked: true })
    expect(res.status).toBe(200)
    const upd = lockUpdate(db)
    expect(upd).toBeDefined()
    expect(upd!.params[0]).toBe(1)
    expect(upd!.params[1]).toBe('ENC:주간 회의\n본문 내용입니다')
    expect(upd!.params[2]).toBe('주간 회의')
  })

  test('잠금(이미 암호화): 기존 제목 힌트를 그대로 보존한다', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ text: 'ENC:비밀', is_locked: 0, title_hint: '기존 제목' })
    const res = await json('/4/lock', 'POST', { locked: true })
    expect(res.status).toBe(200)
    const upd = lockUpdate(db)
    expect(upd).toBeDefined()
    expect(upd!.params[1]).toBe('ENC:비밀') // 재암호화 없음
    expect(upd!.params[2]).toBe('기존 제목')
  })

  test('해제: 제목 힌트는 제거(null)된다', async () => {
    const { json, db } = makeApp()
    // 1) 메모 조회, 2) checkUnlockPin의 PIN 행 조회 → 없음(면제)
    db.firstQueue.push({ text: 'ENC:비밀', is_locked: 1, title_hint: '주간 회의' }, null)
    const res = await json('/3/lock', 'POST', { locked: false })
    expect(res.status).toBe(200)
    const upd = lockUpdate(db)
    expect(upd).toBeDefined()
    expect(upd!.params[0]).toBe(0)
    expect(upd!.params[1]).toBe('비밀')
    expect(upd!.params[2]).toBeNull()
  })
})

describe('블록 해제 제거 SQL (ML-07)', () => {
  test('제거 쿼리는 대상 블록만 빼고 나머지를 남기는 조건(!=)이다', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(
      {
        locked_blocks: JSON.stringify([
          { id: 'blk_1', encrypted: 'ENC:a' },
          { id: 'blk_2', encrypted: 'ENC:b' },
        ]),
        text: '본문 [LOCKED_BLOCK:blk_1]',
      },
      null, // PIN 행 없음 → 면제
    )
    const res = await json('/1/unlock-block/blk_1', 'POST', {})
    expect(res.status).toBe(200)
    expect((await body(res)).html).toBe('a')
    const upd = db.calls.find((c) => c.sql.includes('json_group_array'))
    expect(upd).toBeDefined()
    expect(upd!.sql).toContain("json_extract(value, '$.id') != ?")
    expect(upd!.params).toEqual(['blk_1', '1'])
  })
})

describe('잠긴 첨부 콘텐츠 게이트 (ML-10)', () => {
  test('삭제된 파일(deleted_at 있음)은 잠기지 않았어도 404다', async () => {
    const { req, db } = makeApp()
    db.firstQueue.push({
      id: 1,
      filename: 'a.txt',
      url: 'https://cdn/x',
      is_locked: 0,
      deleted_at: '2026-01-01T00:00:00.000Z',
    })
    const res = await req('/files/1/content', { method: 'GET' })
    expect(res.status).toBe(404)
  })
})

describe('파일 잠금 원본 fetch 실패 (ML-12)', () => {
  test('원본 다운로드가 실패(ok=false)하면 암호화·업로드 없이 500이다', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({
      id: 1,
      filename: 'a.txt',
      url: 'https://cdn/orig',
      storage_key: 'oldkey',
      resource_type: 'raw',
      is_locked: 0,
      mime: 'text/plain',
    })
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    try {
      const res = await json('/files/1/lock', 'POST', { locked: true })
      expect(res.status).toBe(500)
      expect((await body(res)).error).toBe('encrypt_failed')
      expect(mockStorageUpload).not.toHaveBeenCalled()
    } finally {
      delete (global as any).fetch
    }
  })
})
