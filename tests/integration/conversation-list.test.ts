/// <reference types="jest" />
/**
 * GET /api/ai/conversations 페이지네이션·미리보기 계약 (실제 SQLite + Hono).
 *
 * 배경: 기준선(docs/desktop-performance-baseline-20261031.md)에서 대화 목록이
 * 316건·134,020B로 초기 API의 91%였다. 원인 2개 — 페이지네이션 부재와
 * last_msg 전문 전송(소비처는 40자 미리보기만 사용).
 *
 * 검증 성질:
 * - 기본 요청은 최근 50건만, 필드는 {id,title,updated_at,last_msg}뿐이다
 * - last_msg는 마지막 메시지의 첫 40자로 절단된다
 * - offset 이어보기로 중복 없이 전체에 도달하고, 끝에서는 hasMore=false다
 * - limit 상한(100)을 넘는 요청도 클램프된다
 * - 메시지가 없는 대화는 last_msg=null로 목록에 남는다
 * - 첫 페이지 JSON 바이트가 구 계약 대비 대폭 작다
 */
import { Hono } from 'hono'
import { aiAdminApp } from '../../src/modules/ai/admin-routes'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3')

function createD1Adapter(db: any) {
  const prepare = (sql: string) => {
    const stmt: any = {
      _sql: sql,
      _params: [] as any[],
      bind(...p: any[]) { stmt._params = p; return stmt },
      async first() { return db.prepare(sql).get(...stmt._params) || null },
      async all() { return { results: db.prepare(sql).all(...stmt._params) } },
      async run() {
        const info = db.prepare(sql).run(...stmt._params)
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
      },
    }
    return stmt
  }
  return {
    prepare,
    async batch(statements: any[]) {
      const results: any[] = []
      db.transaction(() => {
        for (const s of statements) {
          const info = db.prepare(s._sql).run(...(s._params || []))
          results.push({ meta: { changes: info.changes, last_row_id: info.lastInsertRowid } })
        }
      })()
      return results
    },
  }
}

const TOTAL = 120
const LONG_BODY = '긴본문내용입니다'.repeat(200) // 1,600자

describe('GET /conversations 계약 (실제 SQLite)', () => {
  let db: any; let app: any; let d1: any

  beforeAll(() => {
    db = new Database(':memory:')
    // migrations/0008_ai_chats.sql + 0010_ai_conversations.sql와 같은 형태
    db.exec(`CREATE TABLE ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '새 대화',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ai_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      model TEXT, created_at TEXT NOT NULL, conversation_id INTEGER);`)
    const insConv = db.prepare('INSERT INTO ai_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    const insChat = db.prepare('INSERT INTO ai_chats (persona_id, role, content, created_at, conversation_id) VALUES (?, ?, ?, ?, ?)')
    // id가 클수록 최신 (updated_at 단조 증가) — 정렬 기대값이 id 내림차순과 같다
    for (let i = 1; i <= TOTAL; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
      insConv.run(i, `대화 ${i}`, ts, ts)
      if (i === 7) continue // 7번은 메시지가 전혀 없는 대화
      // 더 오래된 메시지는 미리보기에 영향을 주면 안 된다 (먼저 삽입)
      insChat.run('concierge', 'user', '이전 질문', ts, i)
      // 마지막 메시지(id 최대)가 긴 본문인 대화
      insChat.run('keeper', 'assistant', `대화${i}답변 ` + LONG_BODY, ts, i)
    }
    d1 = createD1Adapter(db)
    app = new Hono()
    app.route('/', aiAdminApp)
  })
  afterAll(() => db.close())

  async function get(qs = '') {
    const res = await app.request('/conversations' + qs, { method: 'GET' }, { DB: d1 })
    return { status: res.status, body: await res.json() as any }
  }
  async function getRaw(qs = '') {
    const res = await app.request('/conversations' + qs, { method: 'GET' }, { DB: d1 })
    return res.text()
  }

  test('기본 요청: 최근 50건, hasMore·nextOffset, 필드 구성 고정', async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.conversations).toHaveLength(50)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
    expect(body.hasMore).toBe(true)
    expect(body.nextOffset).toBe(50)
    expect(body.conversations[0].id).toBe(TOTAL)
    expect(body.conversations[49].id).toBe(TOTAL - 49)
    for (const cv of body.conversations) {
      expect(Object.keys(cv).sort()).toEqual(['id', 'last_msg', 'title', 'updated_at'])
    }
  })

  test('last_msg는 마지막 메시지의 첫 40자로 절단된다', async () => {
    const { body } = await get('?limit=1')
    const expected = (`대화${TOTAL}답변 ` + LONG_BODY).slice(0, 40)
    expect(body.conversations[0].last_msg).toBe(expected)
    expect(body.conversations[0].last_msg.length).toBe(40)
  })

  test('이어보기 3페이지로 중복 없이 전체 120건에 도달한다', async () => {
    const seen: number[] = []
    let qs = ''
    let pages = 0
    for (;;) {
      const { body } = await get(qs)
      pages++
      for (const cv of body.conversations) {
        expect(seen).not.toContain(cv.id)
        seen.push(cv.id)
      }
      if (!body.hasMore) {
        expect(body.nextOffset).toBeNull()
        break
      }
      qs = `?limit=50&offset=${body.nextOffset}`
      expect(pages).toBeLessThan(10)
    }
    expect(pages).toBe(3)
    expect(seen).toHaveLength(TOTAL)
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1))
    expect(seen).toEqual([...seen].sort((a, b) => b - a))
  })

  test('경계: limit=1, 정확히 끝나는 페이지, 범위 밖 offset', async () => {
    const one = await get('?limit=1&offset=0')
    expect(one.body.conversations).toHaveLength(1)
    expect(one.body.hasMore).toBe(true)
    const lastPage = await get('?limit=50&offset=100')
    expect(lastPage.body.conversations).toHaveLength(20)
    expect(lastPage.body.hasMore).toBe(false)
    const beyond = await get('?limit=50&offset=120')
    expect(beyond.body.conversations).toEqual([])
    expect(beyond.body.hasMore).toBe(false)
  })

  test('limit 상한 클램프: limit=1000이어도 100건까지만', async () => {
    const { body } = await get('?limit=1000')
    expect(body.limit).toBe(100)
    expect(body.conversations).toHaveLength(100)
    expect(body.hasMore).toBe(true)
    expect(body.nextOffset).toBe(100)
  })

  test('메시지 없는 대화(id=7)는 last_msg=null로 포함된다', async () => {
    const { body } = await get('?limit=10&offset=110')
    const cv7 = body.conversations.find((cv: any) => cv.id === 7)
    expect(cv7).toBeDefined()
    expect(cv7.last_msg).toBeNull()
  })

  test('첫 페이지 바이트: 구 계약(전량+전문) 대비 대폭 축소', async () => {
    const raw = await getRaw()
    const bytes = Buffer.byteLength(raw, 'utf8')
    // 구 계약이면 120건 × 긴 본문(1,600자)이 실려 수십만 바이트가 된다.
    // 절단+50건 상한이면 제목·날짜·40자 미리보기뿐이라 15KB 미만이어야 한다.
    expect(bytes).toBeLessThan(15000)
  })
})
