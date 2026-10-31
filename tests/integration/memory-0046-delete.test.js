/**
 * mem0 사실 영구 삭제 — 실제 SQLite 통합 테스트
 *
 * 2026-10-25 라이브 검증 FAIL: 그래프 연결된 사실을
 * DELETE /api/memory/:id?permanent=true 로 삭제하면
 * FOREIGN KEY constraint failed 500이 났다 (memory_fact_entities /
 * memory_relations 행을 먼저 지우지 않았기 때문).
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0046을
 * 순서대로 적용하고, esbuild로 컴파일한 실제 src/modules/memory/routes.ts를
 * Hono app.request()로 호출한다. FK 강제(PRAGMA foreign_keys = ON)를 켜서
 * 운영 D1의 실패 모드를 재현한다.
 *
 * 실행: npx jest tests/integration/memory-0046-delete.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const routesPath = path.join(__dirname, '../../src/modules/memory/routes.ts');
const jsPath = '/tmp/memory-routes-0046-delete-test.cjs';
try {
  execSync(
    `npx esbuild ${routesPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`,
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message);
}
const memoryApp = require(jsPath).default;

const factGraphPath = path.join(__dirname, '../../src/services/fact-graph.ts');
const factJsPath = '/tmp/memory-fact-graph-0046-delete-test.cjs';
try {
  execSync(
    `npx esbuild ${factGraphPath} --bundle --platform=node --format=cjs --outfile=${factJsPath}`,
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message);
}
const factSvc = require(factJsPath);

function createD1Adapter(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    return {
      _sql: sql,
      _params: [],
      bind(...p) {
        this._params = p;
        return this;
      },
      async first() {
        return stmt.get(...this._params) || null;
      },
      async all() {
        return { results: stmt.all(...this._params) };
      },
      async run() {
        const info = stmt.run(...this._params);
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
      },
    };
  };
  return {
    prepare,
    async batch(statements) {
      const results = [];
      const txn = db.transaction(() => {
        for (const s of statements) {
          const info = db.prepare(s._sql).run(...(s._params || []));
          results.push({ meta: { changes: info.changes, last_row_id: info.lastInsertRowid } });
        }
      });
      txn();
      return results;
    },
  };
}

function applyMigration(db, name) {
  const sql = fs.readFileSync(path.join(__dirname, '../../migrations', name), 'utf8');
  db.exec(sql);
}

describe('그래프 연결된 사실의 영구 삭제 (실제 SQLite, FK 강제)', () => {
  let db;
  let d1;
  let app;

  beforeAll(() => {
    db = new Database(':memory:');
    // 운영 D1과 동일하게 FK를 강제한다 (기본값은 OFF — 이걸 켜야 500이 재현된다)
    db.pragma('foreign_keys = ON');
    d1 = createD1Adapter(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL DEFAULT '',
      is_locked INTEGER NOT NULL DEFAULT 0,
      locked_blocks TEXT
    )`);
    applyMigration(db, '0027_memory_v2.sql');
    applyMigration(db, '0028_memory_fts.sql');
    applyMigration(db, '0029_memory_consent.sql');
    applyMigration(db, '0044_memory_pages_aging.sql');
    applyMigration(db, '0046_mem0_fact_graph.sql');
    app = new Hono();
    app.route('/a', memoryApp);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    // FK 참조 순서: 자식(연결·간선) → 사실 → 엔티티
    db.prepare(`DELETE FROM memory_fact_entities`).run();
    db.prepare(`DELETE FROM memory_relations`).run();
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    db.prepare(`DELETE FROM ai_memory_fts`).run();
    db.prepare(`DELETE FROM memory_entities`).run();
    db.prepare(`DELETE FROM memos`).run();
  });

  async function captureLinkedFact() {
    const r = await factSvc.captureFacts({ DB: d1 }, {
      text: '사용자는 "MyHub"를 2026-10-25에 만들었다. D1을 쓴다.',
    });
    expect(r.ok).toBe(true);
    expect(r.created.length).toBeGreaterThanOrEqual(1);
    // 그래프 연결이 있는 사실 하나를 고른다
    const linked = db.prepare(
      `SELECT fact_id FROM memory_fact_entities GROUP BY fact_id ORDER BY fact_id LIMIT 1`,
    ).get();
    expect(linked).toBeTruthy();
    const factId = linked.fact_id;
    const linkCount = db.prepare(
      `SELECT COUNT(*) AS n FROM memory_fact_entities WHERE fact_id = ?`,
    ).get(factId).n;
    expect(linkCount).toBeGreaterThanOrEqual(1);
    return { factId, created: r.created };
  }

  test('재현 확인: 그래프 행이 남은 채 사실만 DELETE하면 FK 오류가 난다', () => {
    // 이 테스트는 하네스가 운영의 500 실패 모드를 재현함을 증명한다.
    // (구 코드가 하던 단일 DELETE가 FK 강제 하에서는 실패해야 한다)
    return captureLinkedFact().then(({ factId }) => {
      expect(() =>
        db.prepare(`DELETE FROM ai_memory_v2 WHERE id = ?`).run(factId),
      ).toThrow(/FOREIGN KEY/i);
    });
  });

  test('DELETE ?permanent=true → 200, 사실·연결·간선이 함께 정리된다', async () => {
    const { factId, created } = await captureLinkedFact();
    const edgeCount = db.prepare(
      `SELECT COUNT(*) AS n FROM memory_relations WHERE fact_id = ?`,
    ).get(factId).n;
    expect(edgeCount).toBeGreaterThanOrEqual(0);

    const res = await app.request(`/a/${factId}?permanent=true`, { method: 'DELETE' }, { DB: d1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, deleted: 'permanent' });

    // 사실 행 제거
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2 WHERE id = ?`).get(factId).n).toBe(0);
    // 연결 행 제거
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_fact_entities WHERE fact_id = ?`).get(factId).n).toBe(0);
    // 간선 행 제거
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_relations WHERE fact_id = ?`).get(factId).n).toBe(0);
    // 다른 사실은 그대로 남는다
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n;
    expect(remaining).toBe(created.length - 1);
    // 공유 엔티티 자체는 지우지 않는다 (다른 사실이 쓸 수 있음)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_entities`).get().n).toBeGreaterThan(0);
  });

  test('그래프 없는 사실의 영구 삭제도 200이다', async () => {
    // 그래프 연결이 없는 사실을 직접 삽입한다 — captureFacts 경유 시
    // 추출기가 엔티티를 만들면 '그래프 없는 사실'이 보장되지 않아
    // 예전에는 bare가 없을 때 expect(true)로 빈 통과를 했다.
    const info = db.prepare(
      `INSERT INTO ai_memory_v2 (content) VALUES ('사용자는 등산을 좋아합니다.')`,
    ).run();
    const bareId = info.lastInsertRowid;
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM memory_fact_entities WHERE fact_id = ?`).get(bareId).n,
    ).toBe(0);
    const res = await app.request(`/a/${bareId}?permanent=true`, { method: 'DELETE' }, { DB: d1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 'permanent' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2 WHERE id = ?`).get(bareId).n).toBe(0);
  });
});
