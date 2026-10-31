/**
 * d트랙 성찰 — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0046을 순서대로
 * 적용하고, esbuild로 컴파일한 실제 src/services/memory-reflection.ts를 호출한다.
 * - 작업 완료 후 요청+결과에서 배운 사실을 source_type='reflection'으로 저장
 * - near-duplicate 재성찰은 저장하지 않음 (captureFacts 재사용)
 * - v2 플래그 OFF면 저장하지 않음 / LLM 플래그 OFF면 LLM 성찰기를 호출하지 않음
 * - [LOCKED_BLOCK] 문장은 저장하지 않음
 *
 * 실행: npx jest tests/integration/memory-reflection-real.test.js
 *
 * 주의: D1 고유 동작은 표준 SQLite에서 재현되지 않는다. 이 테스트는 마이그레이션
 * SQL 유효성과 서비스 종단 동작을 검증한다. D1 실측은 운영 적용 단계에서 수행한다.
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const tsPath = path.join(__dirname, '../../src/services/memory-reflection.ts');
const jsPath = '/tmp/memory-reflection-dtrack-test.cjs';
try {
  execSync(`npx esbuild ${tsPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`, {
    stdio: 'pipe',
  });
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message);
}

const svc = require(jsPath);

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

describe('d트랙 성찰 (실제 SQLite)', () => {
  let db;
  let d1;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
    applyMigration(db, '0027_memory_v2.sql');
    applyMigration(db, '0028_memory_fts.sql');
    applyMigration(db, '0029_memory_consent.sql');
    applyMigration(db, '0044_memory_pages_aging.sql');
    applyMigration(db, '0046_mem0_fact_graph.sql');
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES ('memory.v2_enabled', 'true', datetime('now'))`).run();
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    db.prepare(`DELETE FROM memory_fact_entities`).run();
    db.prepare(`DELETE FROM memory_relations`).run();
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    db.prepare(`DELETE FROM ai_memory_fts`).run();
    db.prepare(`DELETE FROM memory_entities`).run();
    db.prepare(`DELETE FROM ai_settings WHERE key = 'memory.llm_reflection_enabled'`).run();
  });

  test('성찰 저장 — source_type=reflection, 동의 게이트 기본 0', async () => {
    const r = await svc.reflectOnTask({ DB: d1 }, {
      taskType: 'memo_create',
      taskText: '매주 월요일 10시에 팀 회의가 있어. 메모해줘.',
      resultText: '메모를 생성했어.',
      persona: 'keeper',
    });
    expect(r.ok).toBe(true);
    expect(r.reflected).toBe(true);
    expect(r.extraction).toBe('deterministic');
    expect(r.created.length).toBeGreaterThan(0);
    const rows = db.prepare(`SELECT * FROM ai_memory_v2`).all();
    expect(rows.length).toBe(r.created.length);
    for (const row of rows) {
      expect(row.source_type).toBe('reflection');
      expect(row.category).toBe('fact');
      expect(row.created_by).toBe('assistant');
      expect(row.allow_ai_use).toBe(0);
      expect(row.allow_provider_send).toBe(0);
    }
  });

  test('같은 작업 재성찰 — near-duplicate는 저장하지 않음', async () => {
    const input = {
      taskType: 'memo_create',
      taskText: '매주 월요일 10시에 팀 회의가 있어. 메모해줘.',
      resultText: '메모를 생성했어.',
    };
    const first = await svc.reflectOnTask({ DB: d1 }, input);
    expect(first.created.length).toBeGreaterThan(0);
    const second = await svc.reflectOnTask({ DB: d1 }, input);
    expect(second.reflected).toBe(true);
    expect(second.created).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n).toBe(first.created.length);
  });

  test('v2 플래그 OFF — 저장하지 않고 reflected=false', async () => {
    db.prepare(`UPDATE ai_settings SET value = 'false' WHERE key = 'memory.v2_enabled'`).run();
    try {
      const r = await svc.reflectOnTask({ DB: d1 }, {
        taskType: 'chat',
        taskText: '내일 10시에 회의가 있어.',
        resultText: '알겠어.',
      });
      expect(r.reflected).toBe(false);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n).toBe(0);
    } finally {
      db.prepare(`UPDATE ai_settings SET value = 'true' WHERE key = 'memory.v2_enabled'`).run();
    }
  });

  test('빈 입력 — 저장하지 않고 reflected=false', async () => {
    const r = await svc.reflectOnTask({ DB: d1 }, { taskType: 'chat', taskText: '', resultText: '' });
    expect(r.reflected).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n).toBe(0);
  });

  test('LLM 플래그 OFF — llmReflect를 호출하지 않고 결정적 추출 사용', async () => {
    let called = 0;
    const r = await svc.reflectOnTask({ DB: d1 }, {
      taskType: 'summary',
      taskText: '이번 주 일정을 요약해줘.',
      resultText: '월요일 10시에 팀 회의가 있습니다.',
      llmReflect: async () => { called++; return ['LLM이 만든 사실입니다.']; },
    });
    expect(called).toBe(0);
    expect(r.extraction).toBe('deterministic');
    const rows = db.prepare(`SELECT content FROM ai_memory_v2`).all();
    expect(rows.some((row) => row.content.includes('LLM이 만든 사실'))).toBe(false);
  });

  test('LLM 플래그 ON — llmReflect 결과를 저장하고 extraction=llm', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES ('memory.llm_reflection_enabled', 'true', datetime('now'))`).run();
    const r = await svc.reflectOnTask({ DB: d1 }, {
      taskType: 'summary',
      taskText: '이번 주 일정을 요약해줘.',
      resultText: '월요일 10시에 팀 회의가 있습니다.',
      llmReflect: async () => ['사용자는 월요일 오전 회의를 선호한다.'],
    });
    expect(r.extraction).toBe('llm');
    expect(r.created.length).toBe(1);
    expect(r.created[0].content).toBe('사용자는 월요일 오전 회의를 선호한다.');
    expect(db.prepare(`SELECT source_type FROM ai_memory_v2`).get().source_type).toBe('reflection');
  });

  test('LLM 성찰 실패 — 결정적 추출로 폴백', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES ('memory.llm_reflection_enabled', 'true', datetime('now'))`).run();
    const r = await svc.reflectOnTask({ DB: d1 }, {
      taskType: 'chat',
      taskText: '매주 금요일 18시에 운동을 해.',
      resultText: '알겠어.',
      llmReflect: async () => { throw new Error('llm boom'); },
    });
    expect(r.ok).toBe(true);
    expect(r.extraction).toBe('deterministic');
    expect(r.created.length).toBeGreaterThan(0);
  });

  test('[LOCKED_BLOCK] 문장은 사실로 저장하지 않음', async () => {
    const r = await svc.reflectOnTask({ DB: d1 }, {
      taskType: 'chat',
      taskText: '메모를 찾아줘.',
      resultText: '찾았어. [LOCKED_BLOCK] 내일 10시에 회의가 있어.',
    });
    expect(r.ok).toBe(true);
    const rows = db.prepare(`SELECT content FROM ai_memory_v2`).all();
    expect(rows.some((row) => row.content.includes('LOCKED_BLOCK'))).toBe(false);
    expect(rows.some((row) => row.content.includes('내일 10시에 회의가 있어'))).toBe(true);
  });
});
