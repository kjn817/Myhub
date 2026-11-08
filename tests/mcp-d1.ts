/**
 * MCP Jest 테스트용 실제 SQLite D1 어댑터.
 *
 * hand-rolled fake(mock)가 아니다 — better-sqlite3 인메모리 DB에
 * `migrations/*.sql` 전수(63개)를 그대로 적용하고, D1Database와 같은
 * prepare/bind/first/all/run 인터페이스를 제공한다. FTS5·trigram·트리거가
 * 실제 SQLite에서 동작하므로, 잠금 제외 같은 보안 경계가 진짜 SQL
 * 경로로 검증된다 (런타임 miniflare 테스트와 같은 DB 의미).
 *
 * 운영 DB에 닿지 않는다. 파일마다 새 인메모리 DB를 만든다.
 */
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'

export type TestDb = {
  /** 원본 better-sqlite3 핸들 (행 직접 확인·시드용) */
  db: Database.Database
  /** D1Database 모양 어댑터 (서비스 코드에 주입) */
  d1: D1Database
}

export function createTestDb(): TestDb {
  const db = new Database(':memory:')
  const dir = path.join(__dirname, '..', 'migrations')
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  }

  const wrap = (stmt: Database.Statement) => ({
    bind(...args: unknown[]) {
      return {
        async first<T = unknown>(): Promise<T | null> {
          const row = stmt.get(...args) as T | undefined
          return row ?? null
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          return { results: stmt.all(...args) as T[] }
        },
        async run(): Promise<{ meta: { last_row_id: number; changes: number } }> {
          const info = stmt.run(...args)
          return {
            meta: {
              last_row_id: Number(info.lastInsertRowid),
              changes: info.changes,
            },
          }
        },
      }
    },
    // 바인딩 없이 바로 first/all/run을 부르는 호출처도 있다
    // (예: memory-service의 isMemoryV2Enabled).
    async first<T = unknown>(): Promise<T | null> {
      const row = stmt.get() as T | undefined
      return row ?? null
    },
    async all<T = unknown>(): Promise<{ results: T[] }> {
      return { results: stmt.all() as T[] }
    },
    async run(): Promise<{ meta: { last_row_id: number; changes: number } }> {
      const info = stmt.run()
      return { meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } }
    },
  })

  const d1 = {
    prepare(sql: string) {
      return wrap(db.prepare(sql))
    },
    async exec(sql: string) {
      db.exec(sql)
    },
  } as unknown as D1Database

  return { db, d1 }
}

/** INSERT 후 last_insert_rowid. */
export function lastId(db: Database.Database): number {
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}
