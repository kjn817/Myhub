/**
 * 관문 테스트 42: 파일 저장 배치 최적화 — 실제 SQLite + 실제 함수 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일을 better-sqlite3 인메모리 DB에 적용하고,
 * esbuild로 컴파일한 실제 src/services/studio-workspace.ts의
 * saveWorkspaceToD1을 호출한다.
 *
 * 검증하는 성질:
 * 1) 50개 파일을 한 번의 db.batch() 호출로 저장한다 (왕복 1회).
 *    저장된 모든 파일의 content·SHA-256·file_size가 정확하다.
 * 2) 원자성: batch 중간에 INSERT가 실패하면 어떤 파일도 저장되지 않는다.
 * 3) 멱등성(upsert): 같은 버전에 다시 저장하면 행이 늘지 않고 내용이 갱신된다.
 * 4) 빈 파일 집합이면 batch를 호출하지 않는다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const WS_TS = path.join(__dirname, '../src/services/studio-workspace.ts')
const WS_JS = '/tmp/studio-workspace-gate42-test.cjs'
try {
  execSync(`npx esbuild ${WS_TS} --bundle --platform=node --format=cjs --outfile=${WS_JS}`, { stdio: 'pipe' })
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message)
}
const { saveWorkspaceToD1 } = require(WS_JS)

const MIGRATIONS = [
  '0032_artifacts.sql',
  '0033_artifact_status.sql',
  '0034_artifact_versions.sql',
  '0035_artifact_files.sql',
]

function createD1Adapter(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql)
    return {
      _sql: sql,
      _params: [],
      bind(...p) { this._params = p; return this },
      async first() { return stmt.get(...this._params) || null },
      async all() { return { results: stmt.all(...this._params) } },
      async run() {
        const info = stmt.run(...this._params)
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
      },
    }
  }
  return {
    prepare,
    async batch(statements) {
      const results = []
      const txn = db.transaction(() => {
        for (const s of statements) {
          const info = db.prepare(s._sql).run(...(s._params || []))
          results.push({ meta: { changes: info.changes, last_row_id: info.lastInsertRowid } })
        }
      })
      txn()
      return results
    },
  }
}

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of MIGRATIONS) {
    db.exec(fs.readFileSync(path.join(__dirname, '../migrations', m), 'utf8'))
  }
  const artId = db.prepare(
    `INSERT INTO artifacts (title, type, status, description, row_revision, html_content)
     VALUES ('T', 'html', 'draft', '', 1, '<html/>')`
  ).run().lastInsertRowid
  const verId = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
     VALUES (?, 1, '<html/>', 'h1')`
  ).run(artId).lastInsertRowid
  return { db, d1: createD1Adapter(db), verId }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

describe('관문 42: 파일 저장 배치 (실제 SQLite + 실제 saveWorkspaceToD1)', () => {
  test('50개 파일이 1번의 batch로 저장되고 내용·해시·크기가 정확하다', async () => {
    const { db, d1, verId } = freshDb()
    try {
      let batchCalls = 0
      const origBatch = d1.batch.bind(d1)
      d1.batch = async (stmts) => {
        batchCalls++
        // batch에 들어간 문장 수가 파일 수와 같은지 (개별 run이 아니라 한 번에)
        expect(stmts.length).toBe(50)
        return origBatch(stmts)
      }
      const files = {}
      for (let i = 0; i < 50; i++) {
        files[`file${String(i).padStart(2, '0')}.txt`] = `content-${i}-` + 'x'.repeat(i)
      }

      await saveWorkspaceToD1(d1, verId, files)

      expect(batchCalls).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_files WHERE version_id=?').get(verId).n).toBe(50)
      for (const [p, content] of Object.entries(files)) {
        const row = db.prepare(
          'SELECT content, content_sha256 AS h, file_size AS s FROM artifact_files WHERE version_id=? AND file_path=?'
        ).get(verId, p)
        expect(row.content).toBe(content)
        expect(row.h).toBe(sha256(content))
        expect(row.s).toBe(Buffer.byteLength(content))
      }
    } finally {
      db.close()
    }
  })

  test('원자성: 중간 INSERT 실패 시 어떤 파일도 저장되지 않는다', async () => {
    const { db, d1, verId } = freshDb()
    try {
      // boom.txt 삽입에서 강제 실패시키는 트리거
      db.exec(`CREATE TRIGGER batch_fail BEFORE INSERT ON artifact_files
               WHEN NEW.file_path = 'boom.txt'
               BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)

      await expect(
        saveWorkspaceToD1(d1, verId, {
          'a.txt': 'aaa',
          'boom.txt': 'boom',
          'c.txt': 'ccc',
        })
      ).rejects.toThrow(/injected failure/)

      // 먼저 들어갈 a.txt까지 롤백되어 0건이어야 한다
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_files WHERE version_id=?').get(verId).n).toBe(0)
    } finally {
      db.close()
    }
  })

  test('upsert: 같은 버전 재저장 시 행이 늘지 않고 내용이 갱신된다', async () => {
    const { db, d1, verId } = freshDb()
    try {
      await saveWorkspaceToD1(d1, verId, { 'index.html': '<html>v1</html>', 'style.css': 'a{}' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_files WHERE version_id=?').get(verId).n).toBe(2)

      await saveWorkspaceToD1(d1, verId, { 'index.html': '<html>v2</html>', 'app.js': 'console.log(1)' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_files WHERE version_id=?').get(verId).n).toBe(3)
      const row = db.prepare(
        'SELECT content, content_sha256 AS h FROM artifact_files WHERE version_id=? AND file_path=?'
      ).get(verId, 'index.html')
      expect(row.content).toBe('<html>v2</html>')
      expect(row.h).toBe(sha256('<html>v2</html>'))
      expect(db.prepare('SELECT content FROM artifact_files WHERE version_id=? AND file_path=?').get(verId, 'style.css').content).toBe('a{}')
    } finally {
      db.close()
    }
  })

  test('빈 파일 집합이면 batch를 호출하지 않는다', async () => {
    const { db, d1, verId } = freshDb()
    try {
      let batchCalls = 0
      const origBatch = d1.batch.bind(d1)
      d1.batch = async (stmts) => {
        batchCalls++
        return origBatch(stmts)
      }
      await saveWorkspaceToD1(d1, verId, {})
      expect(batchCalls).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_files WHERE version_id=?').get(verId).n).toBe(0)
    } finally {
      db.close()
    }
  })
})
