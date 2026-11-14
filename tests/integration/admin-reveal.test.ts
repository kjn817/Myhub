/// <reference types="jest" />
/**
 * admin-routes 복호 반영 계약 (실제 SQLite + Hono) — F3에서 운영 번들
 * 대조로 복원한 revealTextOrPlaceholder 적용을 고정한다.
 *
 * 배경: 저장 암호화(storage-protection)가 켜진 상태에서 /room-history·
 * /conversations가 DB 원문을 그대로 돌려주면, 암호문이 UI에 노출되고
 * 대화 목록 미리보기는 암호문을 잘라 복호 자체가 깨진다.
 * 운영 번들은 두 라우트 모두 복호(실패 시 플레이스홀더)를 거친다.
 * (/history는 D3 결정(2026-11-14)으로 삭제 — 같은 복호 속성은
 * /room-history 테스트가 고정한다.)
 *
 * 검증 성질:
 * - 암호화된 마지막 메시지의 last_msg는 "복호 후" 40자로 절단된다
 * - /room-history의 content는 복호된 평문이다
 * - 복호할 수 없는 암호문은 원문 대신 플레이스홀더가 된다
 * - 평문 메시지는 그대로 통과한다
 * 카나리아: admin-routes에서 reveal 적용을 되돌리면 전부 실패한다.
 */
import { Hono } from 'hono'
import { aiAdminApp } from '../../src/modules/ai/admin-routes'
import { encryptContent } from '../../src/services/crypto'
import { DECRYPT_FAILED_PLACEHOLDER } from '../../src/services/storage-protection'

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
  return { prepare, async batch() { return [] } }
}

// 32바이트 키 재료 (base64) — 테스트 전용
const KEY_MATERIAL = Buffer.alloc(32, 7).toString('base64')
const PLAIN_LONG = '암호화된 답변 본문입니다. '.repeat(10) // 130자

describe('admin-routes 복호 반영 (운영 번들 계약)', () => {
  let db: any; let app: any; let env: any

  beforeAll(async () => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '새 대화',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ai_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      model TEXT, created_at TEXT NOT NULL, conversation_id INTEGER);`)
    const cipher = await encryptContent({ MEMO_ENCRYPTION_KEY: KEY_MATERIAL }, PLAIN_LONG)
    expect(cipher.startsWith('ENC')).toBe(true)
    // 복호 불가 암호문: 형식은 맞지만 중간을 훼손
    const tampered = cipher.slice(0, 20) + (cipher[20] === 'A' ? 'B' : 'A') + cipher.slice(21)

    const insConv = db.prepare('INSERT INTO ai_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    const insChat = db.prepare('INSERT INTO ai_chats (persona_id, role, content, created_at, conversation_id) VALUES (?, ?, ?, ?, ?)')
    const ts = new Date(Date.UTC(2026, 10, 7)).toISOString()
    insConv.run(1, '암호화 대화', ts, ts)
    insChat.run('keeper', 'user', '평문 질문', ts, 1)
    insChat.run('keeper', 'assistant', cipher, ts, 1)
    insConv.run(2, '훼손 대화', ts, ts)
    insChat.run('keeper', 'assistant', tampered, ts, 2)

    app = new Hono()
    app.route('/', aiAdminApp)
    env = { DB: createD1Adapter(db), MEMO_ENCRYPTION_KEY: KEY_MATERIAL }
  })
  afterAll(() => db.close())

  async function get(path: string) {
    const res = await app.request(path, { method: 'GET' }, env)
    return { status: res.status, body: await res.json() as any }
  }

  test('/conversations: last_msg는 복호 후 40자로 절단된다', async () => {
    const { status, body } = await get('/conversations')
    expect(status).toBe(200)
    const conv1 = body.conversations.find((c: any) => c.id === 1)
    expect(conv1.last_msg).toBe(PLAIN_LONG.slice(0, 40))
    expect(conv1.last_msg).not.toContain('ENC')
  })

  test('/conversations: 복호 불가 암호문은 플레이스홀더 미리보기가 된다', async () => {
    const { body } = await get('/conversations')
    const conv2 = body.conversations.find((c: any) => c.id === 2)
    expect(conv2.last_msg).toBe(DECRYPT_FAILED_PLACEHOLDER.slice(0, 40))
  })

  test('/room-history: content가 복호된다', async () => {
    const { body } = await get('/room-history?conversationId=1')
    const contents = body.messages.map((m: any) => m.content)
    expect(contents).toContain(PLAIN_LONG)
    for (const c of contents) expect(c.startsWith('ENC')).toBe(false)
  })
})
