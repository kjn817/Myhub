/**
 * 로컬 D1 테스트 헬퍼 — Phase 1E-R
 *
 * better-sqlite3를 사용해 D1 API를 흉내냄.
 * 실제 SQLite UNIQUE 제약, 트랜잭션을 테스트.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

/**
 * D1 호환 DB 래퍼 생성
 */
function createLocalD1(dbPath = ':memory:') {
  const db = new Database(dbPath);

  // D1 prepared statement 래퍼
  function prepare(sql) {
    const stmt = db.prepare(sql);
    const wrapper = {
      _sql: sql,
      _params: [],
      bind(...p) {
        wrapper._params = p;
        return wrapper;
      },
      async first() {
        try {
          return stmt.get(...wrapper._params) || null;
        } catch (e) {
          throw e;
        }
      },
      async all() {
        try {
          return { results: stmt.all(...wrapper._params) };
        } catch (e) {
          throw e;
        }
      },
      async run() {
        try {
          const info = stmt.run(...wrapper._params);
          return {
            meta: {
              changes: info.changes,
              last_row_id: info.lastInsertRowid,
            }
          };
        } catch (e) {
          throw e;
        }
      }
    };
    return wrapper;
  }

  async function batch(statements) {
    // D1 batch는 트랜잭션으로 실행, 중간 실패 시 롤백
    const results = [];
    const txn = db.transaction(() => {
      for (const stmt of statements) {
        // stmt는 { _sql, _params } 형태 또는 prepare 결과
        let sql, params;
        if (stmt._sql) {
          sql = stmt._sql;
          params = stmt._params || [];
        } else {
          throw new Error('Invalid batch statement');
        }
        const prepared = db.prepare(sql);
        const info = prepared.run(...params);
        results.push({
          meta: {
            changes: info.changes,
            last_row_id: info.lastInsertRowid,
          }
        });
      }
    });
    try {
      txn();
      return results;
    } catch (e) {
      throw e;
    }
  }

  // batch용 statement 생성 헬퍼
  function batchStmt(sql, ...params) {
    return { _sql: sql, _params: params };
  }

  return {
    _db: db,
    prepare,
    batch,
    batchStmt,
    close() { db.close(); },
    // 테스트용: 테이블 생성
    exec(sql) { db.exec(sql); },
  };
}

/**
 * 테스트용 마이그레이션 적용
 */
function applyTestMigrations(d1) {
  // todos 테이블
  d1.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      due_at TEXT,
      priority INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // ai_tool_operations 테이블
  d1.exec(`
    CREATE TABLE IF NOT EXISTS ai_tool_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result_ref TEXT,
      error_code TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, operation_id)
    );
  `);
}

module.exports = { createLocalD1, applyTestMigrations };
