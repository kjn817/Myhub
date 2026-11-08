/**
 * 인용 잠금 (c트랙) — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0046을 순서대로
 * 적용하고, esbuild로 컴파일한 실제 서비스를 호출한다.
 * - 출처 필드: 기억 ID·카테고리·생성일·관련도(score)가 MemoryItem에 실리는지
 * - 대체 기억: supersede 후 FTS에서는 사라지고 LIKE로만 찾아져 대체 표시와 함께 전달되는지
 * - 모순 플래그: contradiction=true가 전달되고 포맷에 [모순 의심]이 붙는지
 * - 인용 검증 종단: 실제 ID로 validateMemoryCitations가 유효/지어낸 인용을 가르는지
 * - getRelatedFacts(FTS+그래프)도 대체 기억을 병합하는지
 *
 * 실행: npx jest tests/integration/memory-citation-lock-real.test.js
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const memPath = path.join(__dirname, '../../src/services/memory-service.ts');
const memJs = '/tmp/memory-service-citation-lock-test.cjs';
const graphPath = path.join(__dirname, '../../src/services/fact-graph.ts');
const graphJs = '/tmp/memory-fact-graph-citation-lock-test.cjs';
const lockPath = path.join(__dirname, '../../src/lib/citation-lock.ts');
const lockJs = '/tmp/citation-lock-test.cjs';
for (const [ts, js] of [[memPath, memJs], [graphPath, graphJs], [lockPath, lockJs]]) {
  try {
    execSync(`npx esbuild ${ts} --bundle --platform=node --format=cjs --outfile=${js}`, {
      stdio: 'pipe',
    });
  } catch (e) {
    console.error('TypeScript 컴파일 실패:', ts, e.message);
  }
}

const svc = require(memJs);
const graph = require(graphJs);
const lock = require(lockJs);

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

describe('인용 잠금 — 실제 SQLite', () => {
  let db;
  let d1;
  let newId; // 새 전화번호 기억
  let oldId; // 대체된 옛 전화번호 기억

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT)`);
    applyMigration(db, '0027_memory_v2.sql');
    applyMigration(db, '0028_memory_fts.sql');
    applyMigration(db, '0029_memory_consent.sql');
    applyMigration(db, '0044_memory_pages_aging.sql');
    applyMigration(db, '0046_mem0_fact_graph.sql');
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'true')`).run();

    const ins = db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send, created_at, updated_at)
       VALUES (?, 'fact', 1, 1, 1, ?, '2026-10-20T10:00:00Z')`
    );
    newId = Number(ins.run('사용자의 전화번호는 010-1111-2222이다', '2026-10-20T10:00:00Z').lastInsertRowid);
    oldId = Number(ins.run('사용자의 전화번호는 010-9999-8888이다', '2026-10-19T10:00:00Z').lastInsertRowid);
    // 옛 기억을 새 기억으로 대체 (is_active=0, superseded_by=newId)
    db.prepare(`UPDATE ai_memory_v2 SET is_active = 0, superseded_by = ?, updated_at = '2026-10-20T10:00:00Z' WHERE id = ?`).run(newId, oldId);
    // 모순 플래그 기억
    db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send, contradiction_flag, created_at, updated_at)
       VALUES ('사용자의 반려견 이름은 보라돌이다', 'fact', 1, 1, 1, 1, '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`
    ).run();
  });

  afterAll(() => {
    db.close();
  });

  test('대체된 기억은 FTS에서 사라진다 (트리거) — LIKE로만 찾음', () => {
    const fts = db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '전화번호는'`).all();
    expect(fts.map((r) => r.rowid)).toEqual([newId]);
    expect(fts.map((r) => r.rowid)).not.toContain(oldId);
  });

  test('getRelevantMemories — 활성 기억에 출처 필드 + 대체 기억이 뒤에 붙는다', async () => {
    const out = await svc.getRelevantMemories({ DB: d1 }, '전화번호는 뭐야?');
    const active = out.find((r) => r.id === newId);
    expect(active).toBeDefined();
    expect(active.category).toBe('fact');
    expect(active.createdAt).toBe('2026-10-20T10:00:00Z');
    expect(typeof active.score).toBe('number');
    expect(active.score).toBeGreaterThan(0);
    expect(active.superseded).toBe(false);

    const superseded = out.find((r) => r.id === oldId);
    expect(superseded).toBeDefined();
    expect(superseded.superseded).toBe(true);
    expect(superseded.supersededBy).toBe(newId);
    // 대체 기억은 활성 기억 뒤에 온다
    expect(out.indexOf(superseded)).toBeGreaterThan(out.indexOf(active));
  });

  test('citableMemoryIds — 대체 기억은 인용 불가', async () => {
    const out = await svc.getRelevantMemories({ DB: d1 }, '전화번호는 뭐야?');
    const citable = lock.citableMemoryIds(out);
    expect(citable).toContain(newId);
    expect(citable).not.toContain(oldId);
  });

  test('fetchSupersededMatches — 대체 기억만, 최대 2개', async () => {
    const out = await svc.fetchSupersededMatches({ DB: d1 }, '전화번호는 뭐야?');
    expect(out.map((r) => r.id)).toEqual([oldId]);
    expect(out[0].superseded).toBe(true);
    expect(out[0].supersededBy).toBe(newId);
    // 관련 없는 쿼리 → []
    expect(await svc.fetchSupersededMatches({ DB: d1 }, '전혀다른주제키워드')).toEqual([]);
  });

  test('모순 플래그 기억은 contradiction=true로 전달된다', async () => {
    const out = await svc.getRelevantMemories({ DB: d1 }, '반려견 이름은');
    const hit = out.find((r) => r.content.includes('보라돌'));
    expect(hit).toBeDefined();
    expect(hit.contradiction).toBe(true);
  });

  test('formatMemoryContext — 출처·대체 표시·모순 표시·인용 지시', async () => {
    const out = await svc.getRelevantMemories({ DB: d1 }, '전화번호는 뭐야?');
    const ctx = svc.formatMemoryContext(out);
    expect(ctx).toContain(`[기억 #${newId}|fact|2026-10-20|관련도`);
    expect(ctx).toContain(`[대체됨 → 기억 #${newId}]`);
    expect(ctx).toContain('[기억 #id] 형태로 인용할 것');
    expect(ctx).toContain('기록에 없습니다');
    // 대체된 옛 번호 내용은 전달되지만, 지시문은 새 기억 인용을 요구한다
    expect(ctx).toContain('010-9999-8888');

    const ctx2 = svc.formatMemoryContext(await svc.getRelevantMemories({ DB: d1 }, '반려견 이름은'));
    expect(ctx2).toContain('[모순 의심]');
  });

  test('getRelatedFacts — FTS+그래프 병합에도 대체 기억이 붙는다', async () => {
    const out = await graph.getRelatedFacts({ DB: d1 }, '전화번호는 뭐야?');
    const active = out.find((r) => r.id === newId);
    const superseded = out.find((r) => r.id === oldId);
    expect(active).toBeDefined();
    expect(superseded).toBeDefined();
    expect(superseded.superseded).toBe(true);
    expect(lock.citableMemoryIds(out)).not.toContain(oldId);
  });

  test('validateMemoryCitations 종단 — 실제 ID 기준', async () => {
    const out = await svc.getRelevantMemories({ DB: d1 }, '전화번호는 뭐야?');
    const allowed = lock.citableMemoryIds(out);
    // 유효 인용 유지
    const ok = lock.validateMemoryCitations(`전화번호는 010-1111-2222 [기억 #${newId}]입니다.`, allowed);
    expect(ok.ungrounded).toBe(false);
    expect(ok.validIds).toEqual([newId]);
    // 대체된 기억 인용 → 제거 + ungrounded
    const bad = lock.validateMemoryCitations(`옛 번호는 010-9999-8888 [기억 #${oldId}]입니다.`, allowed);
    expect(bad.removedIds).toEqual([oldId]);
    expect(bad.ungrounded).toBe(true);
    expect(bad.text).not.toContain(`[기억 #${oldId}]`);
  });

  test('검색 결과 없음 — 빈 배열 (abstain 게이트의 입력 조건)', async () => {
    const out = await svc.getRelevantMemories({ DB: d1 }, '전혀없는주제 쿼리문장');
    expect(out).toEqual([]);
    expect(svc.formatMemoryContext(out)).toBe('');
  });
});
