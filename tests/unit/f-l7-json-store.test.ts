/// <reference types="jest" />
/**
 * F-L7 json-store 공용 코어 단위 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - get/set이 기존 storeGet/storeSet과 동일하다: 빈 값·파싱 null·
 *   파싱 실패 시 fallback, storage 없음 시 fallback·no-op.
 * - warn 문구에 생성 시 받은 label이 들어간다 (두 호출처의 로그 문구가
 *   바뀌지 않는다).
 * - office-memory.js는 코어를 써서 최근 문서를 저장·복원한다
 *   (코어 경로의 실제 동작 증거).
 * - 코어가 없으면 office-memory는 null-storage와 동등하게 열화한다
 *   (던지지 않고 빈 목록을 낸다).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jsonStore = require('../../public/js/common/json-store.js')

class MemoryStorage {
  store: Record<string, string> = {}
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null
  }
  setItem(k: string, v: string): void {
    this.store[k] = String(v)
  }
}

describe('json-store core', () => {
  test('get/set이 JSON 왕복한다', () => {
    const storage = new MemoryStorage()
    const store = jsonStore.create(storage, '테스트 메모리')
    store.set('k', { a: 1 })
    expect(store.get('k', null)).toEqual({ a: 1 })
    expect(store.get('missing', 'fb')).toBe('fb')
  })

  test('파싱된 null·빈 값은 fallback이다', () => {
    const storage = new MemoryStorage()
    storage.setItem('n', 'null')
    storage.setItem('e', '')
    const store = jsonStore.create(storage, '테스트 메모리')
    expect(store.get('n', 'fb')).toBe('fb')
    expect(store.get('e', 'fb')).toBe('fb')
  })

  test('파싱 실패 시 warn 후 fallback, 쓰기 실패 시 warn 후 조용히 넘긴다', () => {
    const storage = new MemoryStorage()
    storage.setItem('bad', '{oops')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = jsonStore.create(storage, '테스트 메모리')
      expect(store.get('bad', 'fb')).toBe('fb')
      expect(warn).toHaveBeenCalledWith(
        '테스트 메모리 읽기 실패:',
        expect.anything(),
      )
      const throwing = {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota')
        },
      }
      const store2 = jsonStore.create(throwing, '테스트 메모리')
      expect(() => store2.set('k', 1)).not.toThrow()
      expect(warn).toHaveBeenCalledWith('테스트 메모리 쓰기 실패:', expect.anything())
    } finally {
      warn.mockRestore()
    }
  })

  test('storage가 null이면 get은 fallback, set은 no-op이다', () => {
    const store = jsonStore.create(null, '테스트 메모리')
    expect(store.get('k', 'fb')).toBe('fb')
    expect(() => store.set('k', 1)).not.toThrow()
  })
})

describe('office-memory.js의 json-store 위임', () => {
  test('record·loadRecents가 스토리지를 왕복한다', () => {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../public/js/common/json-store.js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const memory = require('../../public/js/office-memory.js')
    const storage = new MemoryStorage()
    const doc = { getElementById: () => null } as any
    const mem = memory.createMemory({ doc, storage, appKey: 'excel' })
    mem.record({ fileId: 5, name: 'a.xlsx', mime: '', folderId: null, folderName: '' })
    const recents = mem.loadRecents()
    expect(recents).toHaveLength(1)
    expect(recents[0].id).toBe(5)
    expect(storage.getItem('myhub.office.excel.recent.v1')).toContain('a.xlsx')
  })

  test('코어가 없어도 던지지 않고 빈 목록으로 열화한다', () => {
    jest.resetModules()
    // json-store를 require하지 않은 상태 — window/globalThis에 코어 없음
    const g = globalThis as any
    const saved = g.MyHubJsonStore
    delete g.MyHubJsonStore
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const memory = require('../../public/js/office-memory.js')
      const storage = new MemoryStorage()
      const doc = { getElementById: () => null } as any
      const mem = memory.createMemory({ doc, storage, appKey: 'excel' })
      expect(() => mem.record({ fileId: 5, name: 'a.xlsx' })).not.toThrow()
      expect(mem.loadRecents()).toEqual([])
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('json-store.js가 먼저 로드되어야 합니다'),
      )
    } finally {
      warn.mockRestore()
      if (saved !== undefined) g.MyHubJsonStore = saved
    }
  })

  test('office.js·office-memory.js에 로컬 storeGet/storeSet 본문이 없다', () => {
    for (const f of ['public/js/office.js', 'public/js/office-memory.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf-8')
      expect(src).not.toMatch(/function storeGet\(key, fallback\) \{/)
      expect(src).not.toMatch(/function storeSet\(key, value\) \{/)
      expect(src).toMatch(/MyHubJsonStore/)
      expect(src).toMatch(/var storeGet = store\.get;/)
      expect(src).toMatch(/var storeSet = store\.set;/)
    }
    const office = fs.readFileSync(path.join(ROOT, 'public/js/office.js'), 'utf-8')
    expect(office).toContain("jsonStoreCore.create(storage, '오피스 앱 메모리')")
    const memory = fs.readFileSync(path.join(ROOT, 'public/js/office-memory.js'), 'utf-8')
    expect(memory).toContain("jsonStoreCore.create(storage, '세션 등 메모리')")
  })

  test('office.html이 json-store를 office-memory보다 먼저 받는다', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/office.html'), 'utf-8')
    const core = html.indexOf('/js/common/json-store.js')
    const mem = html.indexOf('/js/office-memory.js')
    expect(core).toBeGreaterThan(-1)
    expect(mem).toBeGreaterThan(core)
  })

  test('json-store가 static-assets.json + DYNAMIC_ASSETS에 등록됐다', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts/static-assets.json'), 'utf-8'),
    )
    expect(manifest.files).toContain('/js/common/json-store.js')
    const assetUrl = fs.readFileSync(path.join(ROOT, 'public/js/asset-url.js'), 'utf-8')
    expect(assetUrl).toContain("'/js/common/json-store.js'")
  })
})
