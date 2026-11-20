/// <reference types="jest" />
/**
 * 브라우저 북마크·방문 기록 API (2026-11-20, 브라우저 1단계).
 *
 * 실제 SQLite(local-d1 + 0080 실마이그레이션) + DoH fetch 스텁으로
 * 고정하는 성질:
 * - 빈 테이블 GET /bookmarks는 하드코딩 6개를 pinned 시드로 넣고,
 *   두 번 불러도 6개가 유지된다 (INSERT OR IGNORE).
 * - POST /bookmarks 중복 URL은 기존 행을 돌려보내고 행이 늘지 않는다.
 *   시드 URL과 POST 정규화 URL이 같은 행으로 인식된다.
 * - 잘못된 URL·내부 호스트·사설 IP로 해석되는 호스트는 400이다.
 * - PATCH·DELETE는 없는 id에 404, 잘못된 값에 400이다.
 * - 목록은 pinned 먼저, position 순이다.
 * - POST /history 재방문은 행을 늘리지 않고 visited_at만 갱신한다
 *   (upsert — plain INSERT로 바꾸면 UNIQUE 충돌로 이 테스트가 실패한다).
 * - 기록이 1000개를 넘으면 오래된 것부터 지워진다 (prune을 빼면
 *   이 테스트가 실패한다).
 * - 검색 q는 url·title을 찾고, LIKE 와일드카드(%·_)는 문자 그대로 본다.
 * - limit은 1~100으로 고정된다. DELETE /history는 전부 지운다.
 * 카나리아: upsert→INSERT·prune 제거 변이를 확인했다 (보고 참조).
 */
import * as fs from 'fs'
import * as path from 'path'
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const app = new Hono()
app.route('/api/browse', browseApp)

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0080_browser_bookmarks_history.sql'))
  return db
}

function envOf(db: any) {
  return { DB: db } as never
}

/** DoH 스텁: 기본은 공인 IP, map에 있는 호스트는 지정 IP를 돌려준다. */
function stubDohFetch(map: Record<string, string[]> = {}): void {
  global.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('dns-query')) {
      const parsed = new URL(u)
      const name = parsed.searchParams.get('name') ?? ''
      const type = parsed.searchParams.get('type')
      const ips = map[name] ?? ['93.184.216.34']
      const answers = ips
        .filter((ip) => (type === '1' ? ip.includes('.') : ip.includes(':')))
        .map((ip) => ({ name, type: Number(type), data: ip }))
      return { ok: true, status: 200, json: async () => ({ Status: 0, Answer: answers }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as typeof fetch
}

const realFetch = global.fetch
beforeEach(() => stubDohFetch())
afterEach(() => {
  global.fetch = realFetch
})

async function call(env: never, path: string, init: RequestInit = {}) {
  const res = await app.request(path, init, env)
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* ignore */
  }
  return { status: res.status, json }
}

// 테스트 셋업·검증은 래퍼 안의 raw better-sqlite3(_db)로 동기 접근한다 —
// 같은 SQLite 인스턴스이며, 라우트 코드는 D1 스타일 비동기 API를 쓴다.
function raw(db: any): any {
  return db._db
}

function countRows(db: any, table: string): number {
  return raw(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}

describe('GET /api/browse/bookmarks — 시드', () => {
  test('빈 테이블이면 하드코딩 6개를 pinned 시드로 넣고 순서대로 반환한다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const { status, json } = await call(env, '/api/browse/bookmarks')
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.bookmarks).toHaveLength(6)
    expect(json.bookmarks.map((b: any) => b.title)).toEqual([
      'NAVER',
      'Google',
      'YouTube',
      'ChatGPT',
      'GitHub',
      '위키백과',
    ])
    expect(json.bookmarks.every((b: any) => b.pinned === true)).toBe(true)
    expect(countRows(db, 'browser_bookmarks')).toBe(6)
  })

  test('두 번 불러도 시드가 중복되지 않는다', async () => {
    const db = makeDb()
    const env = envOf(db)
    await call(env, '/api/browse/bookmarks')
    const second = await call(env, '/api/browse/bookmarks')
    expect(second.json.bookmarks).toHaveLength(6)
    expect(countRows(db, 'browser_bookmarks')).toBe(6)
  })
})

describe('POST /api/browse/bookmarks', () => {
  test('새 북마크를 만들고 목록에 나타난다 (기본 pinned false)', async () => {
    const db = makeDb()
    const env = envOf(db)
    await call(env, '/api/browse/bookmarks')
    const { status, json } = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', title: '예시' }),
    })
    expect(status).toBe(201)
    expect(json.bookmark.url).toBe('https://example.com/')
    expect(json.bookmark.title).toBe('예시')
    expect(json.bookmark.pinned).toBe(false)
    const list = await call(env, '/api/browse/bookmarks')
    expect(list.json.bookmarks).toHaveLength(7)
  })

  test('중복 URL은 기존 행을 돌려보내고 행이 늘지 않는다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const first = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' }),
    })
    const second = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page', title: '다른 이름' }),
    })
    expect(second.status).toBe(200)
    expect(second.json.duplicate).toBe(true)
    expect(second.json.bookmark.id).toBe(first.json.bookmark.id)
    expect(countRows(db, 'browser_bookmarks')).toBe(1)
  })

  test('시드 URL을 다시 추가해도 시드 행과 중복되지 않는다 (정규화 일치)', async () => {
    const db = makeDb()
    const env = envOf(db)
    await call(env, '/api/browse/bookmarks')
    const dup = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.naver.com' }),
    })
    expect(dup.json.duplicate).toBe(true)
    expect(countRows(db, 'browser_bookmarks')).toBe(6)
  })

  test('잘못된 URL·내부 호스트는 400이다', async () => {
    const db = makeDb()
    const env = envOf(db)
    for (const bad of ['not a url', 'chrome://history', 'http://localhost:3000/x', 'ftp://example.com/x', '']) {
      const r = await call(env, '/api/browse/bookmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: bad }),
      })
      expect(r.status).toBe(400)
    }
    expect(countRows(db, 'browser_bookmarks')).toBe(0)
  })

  test('사설 IP로 해석되는 호스트는 400이다 (DoH 방어)', async () => {
    stubDohFetch({ 'evil.example': ['10.0.0.5'] })
    const db = makeDb()
    const env = envOf(db)
    const r = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil.example/' }),
    })
    expect(r.status).toBe(400)
    expect(countRows(db, 'browser_bookmarks')).toBe(0)
  })
})

describe('PATCH/DELETE /api/browse/bookmarks/:id', () => {
  async function seededOne(env: never) {
    const created = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    return created.json.bookmark.id as number
  }

  test('PATCH로 제목·pinned·position을 바꾸고 목록 순서에 반영된다', async () => {
    const db = makeDb()
    const env = envOf(db)
    await call(env, '/api/browse/bookmarks')
    const id = await seededOne(env)
    const patched = await call(env, `/api/browse/bookmarks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '바뀐 이름', pinned: true, position: 0 }),
    })
    expect(patched.status).toBe(200)
    expect(patched.json.bookmark.title).toBe('바뀐 이름')
    expect(patched.json.bookmark.pinned).toBe(true)
    // pinned이면서 position 0이면 position 1인 Google(id 2)보다 앞에 온다.
    // position 0인 행이 시드(NAVER, id 1)와 둘이라 타이브레이커(id)가
    // NAVER를 먼저 두므로, 맨 앞 두 자리에 두 행이 있는 것만 단언한다.
    const list = await call(env, '/api/browse/bookmarks')
    const ids = list.json.bookmarks.map((b: any) => b.id)
    expect(ids.indexOf(id)).toBeLessThan(ids.indexOf(2))
    expect(ids.slice(0, 2).sort((a: number, b: number) => a - b)).toEqual([1, id].sort((a: number, b: number) => a - b))
  })

  test('PATCH 없는 id는 404, 잘못된 값은 400이다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const missing = await call(env, '/api/browse/bookmarks/9999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(missing.status).toBe(404)
    const id = await seededOne(env)
    const badPos = await call(env, `/api/browse/bookmarks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ position: -1 }),
    })
    expect(badPos.status).toBe(400)
    const badPinned = await call(env, `/api/browse/bookmarks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: 'yes' }),
    })
    expect(badPinned.status).toBe(400)
    const empty = await call(env, `/api/browse/bookmarks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(empty.status).toBe(400)
  })

  test('DELETE는 행을 지우고, 없는 id는 404다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const id = await seededOne(env)
    const del = await call(env, `/api/browse/bookmarks/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(countRows(db, 'browser_bookmarks')).toBe(0)
    const again = await call(env, `/api/browse/bookmarks/${id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
  })

  test('목록은 pinned 먼저, position 순이다', async () => {
    const db = makeDb()
    const env = envOf(db)
    // pinned이 아닌 행 2개를 먼저 만들고, 나중에 하나를 pinned으로 올린다.
    const a = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://a.example/', title: 'A' }),
    })
    const b = await call(env, '/api/browse/bookmarks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://b.example/', title: 'B' }),
    })
    await call(env, `/api/browse/bookmarks/${b.json.bookmark.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    })
    const list = await call(env, '/api/browse/bookmarks')
    expect(list.json.bookmarks.map((x: any) => x.title)).toEqual(['B', 'A'])
    expect(a.json.bookmark.id).not.toBe(b.json.bookmark.id)
  })
})

describe('POST /api/browse/history — upsert', () => {
  test('재방문은 행을 늘리지 않고 visited_at만 갱신한다', async () => {
    const db = makeDb()
    const env = envOf(db)
    // 오래된 방문을 직접 심는다 — 재방문 뒤 시간이 바뀌는지 본다.
    raw(db)
      .prepare("INSERT INTO browser_history (url, title, visited_at) VALUES (?, ?, '2020-01-01T00:00:00.000Z')")
      .run('https://example.com/', '예시')
    const r = await call(env, '/api/browse/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/', title: '예시' }),
    })
    expect(r.status).toBe(200)
    expect(countRows(db, 'browser_history')).toBe(1)
    const row = raw(db).prepare('SELECT visited_at FROM browser_history WHERE url = ?').get('https://example.com/')
    expect(row.visited_at).not.toBe('2020-01-01T00:00:00.000Z')
    expect(new Date(row.visited_at).getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00.000Z').getTime())
  })

  test('같은 URL을 세 번 기록해도 행은 하나다', async () => {
    const db = makeDb()
    const env = envOf(db)
    for (let i = 0; i < 3; i++) {
      const r = await call(env, '/api/browse/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/' }),
      })
      expect(r.status).toBe(200)
    }
    expect(countRows(db, 'browser_history')).toBe(1)
  })

  test('잘못된 URL은 400이고 행이 안 생긴다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const r = await call(env, '/api/browse/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'chrome://history' }),
    })
    expect(r.status).toBe(400)
    expect(countRows(db, 'browser_history')).toBe(0)
  })
})

describe('POST /api/browse/history — prune', () => {
  test('1000개를 넘으면 오래된 것부터 지워 1000개가 유지된다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const insert = raw(db).prepare('INSERT INTO browser_history (url, title, visited_at) VALUES (?, ?, ?)')
    // 1005개를 1분 간격의 서로 다른 visited_at으로 심는다 (0번이 가장 오래됨).
    const base = Date.UTC(2026, 0, 1)
    for (let i = 0; i < 1005; i++) {
      insert.run(`https://h${i}.example/`, `H${i}`, new Date(base + i * 60000).toISOString())
    }
    expect(countRows(db, 'browser_history')).toBe(1005)
    const r = await call(env, '/api/browse/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://new.example/' }),
    })
    expect(r.status).toBe(200)
    expect(countRows(db, 'browser_history')).toBe(1000)
    // 1006개 중 가장 오래된 6개(h0~h5)가 잘리고, h6과 새 행은 남아 있다.
    for (let i = 0; i < 6; i++) {
      const gone = raw(db).prepare('SELECT COUNT(*) AS n FROM browser_history WHERE url = ?').get(`https://h${i}.example/`)
      expect(gone.n).toBe(0)
    }
    const kept = raw(db).prepare('SELECT COUNT(*) AS n FROM browser_history WHERE url = ?').get('https://h6.example/')
    expect(kept.n).toBe(1)
    const newest = raw(db).prepare('SELECT COUNT(*) AS n FROM browser_history WHERE url = ?').get('https://new.example/')
    expect(newest.n).toBe(1)
  })
})

describe('GET /api/browse/history — 검색·limit', () => {
  function seedHistory(db: any) {
    const rows: Array<[string, string, string]> = [
      ['https://news.example/politics', '정치 뉴스', '2026-11-20T10:00:00.000Z'],
      ['https://news.example/sports', '스포츠 뉴스', '2026-11-20T11:00:00.000Z'],
      ['https://a_b.example/', '밑줄', '2026-11-20T12:00:00.000Z'],
      ['https://axb.example/', '엑스', '2026-11-20T13:00:00.000Z'],
    ]
    const insert = raw(db).prepare('INSERT INTO browser_history (url, title, visited_at) VALUES (?, ?, ?)')
    for (const [url, title, at] of rows) {
      insert.run(url, title, at)
    }
  }

  test('기본 목록은 visited_at 내림차순이다', async () => {
    const db = makeDb()
    const env = envOf(db)
    seedHistory(db)
    const { json } = await call(env, '/api/browse/history')
    expect(json.history.map((h: any) => h.title)).toEqual(['엑스', '밑줄', '스포츠 뉴스', '정치 뉴스'])
  })

  test('q는 url·title을 찾는다', async () => {
    const db = makeDb()
    const env = envOf(db)
    seedHistory(db)
    const byTitle = await call(env, '/api/browse/history?q=' + encodeURIComponent('스포츠'))
    expect(byTitle.json.history.map((h: any) => h.title)).toEqual(['스포츠 뉴스'])
    const byUrl = await call(env, '/api/browse/history?q=' + encodeURIComponent('news.example/politics'))
    expect(byUrl.json.history.map((h: any) => h.title)).toEqual(['정치 뉴스'])
  })

  test('q의 밑줄은 와일드카드가 아니라 문자 그대로 본다', async () => {
    const db = makeDb()
    const env = envOf(db)
    seedHistory(db)
    // '_'를 이스케이프하지 않으면 'a_b'가 'axb'에도 매칭된다.
    const { json } = await call(env, '/api/browse/history?q=' + encodeURIComponent('a_b'))
    expect(json.history.map((h: any) => h.title)).toEqual(['밑줄'])
  })

  test('limit은 1~100으로 고정된다', async () => {
    const db = makeDb()
    const env = envOf(db)
    const insert = raw(db).prepare('INSERT INTO browser_history (url, title, visited_at) VALUES (?, ?, ?)')
    for (let i = 0; i < 105; i++) {
      insert.run(`https://l${i}.example/`, `L${i}`, `2026-11-20T${String(i % 24).padStart(2, '0')}:00:00.000Z`)
    }
    const two = await call(env, '/api/browse/history?limit=2')
    expect(two.json.history).toHaveLength(2)
    const zero = await call(env, '/api/browse/history?limit=0')
    expect(zero.json.history).toHaveLength(1)
    const huge = await call(env, '/api/browse/history?limit=500')
    expect(huge.json.history).toHaveLength(100)
    const bad = await call(env, '/api/browse/history?limit=abc')
    expect(bad.json.history).toHaveLength(100)
  })
})

describe('DELETE /api/browse/history', () => {
  test('전체를 지우고 삭제 개수를 돌려준다', async () => {
    const db = makeDb()
    const env = envOf(db)
    await call(env, '/api/browse/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://a.example/' }),
    })
    await call(env, '/api/browse/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://b.example/' }),
    })
    const del = await call(env, '/api/browse/history', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(del.json.deleted).toBe(2)
    expect(countRows(db, 'browser_history')).toBe(0)
  })
})
