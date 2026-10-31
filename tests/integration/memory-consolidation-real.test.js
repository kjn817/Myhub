/**
 * d트랙 수면 통합 — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0046→0053을
 * 순서대로 적용하고, esbuild로 컴파일한 실제 src/services/memory-consolidation.ts
 * + src/scheduled.ts(handleSleepConsolidation)를 호출한다.
 * - 중복 병합: 생존자 1개만 활성, 나머지는 superseded_by (행 삭제 없음)
 * - 모순 표시: 변경 표지 + 공유 토큰 쌍에 contradiction_flag=1
 * - 오래된 기억 요약: cold/archived + summary 없음 → 첫 문장 요약 채움
 * - 감사 기록: memory_consolidation_log에 병합·모순·요약·실행 내역
 * - 스케줄: 03:00 KST에만 실행, 하루 1회 (마커), 그 외 시간은 건너뜀
 *
 * 실행: npx jest tests/integration/memory-consolidation-real.test.js
 *
 * 주의: D1 고유 동작은 표준 SQLite에서 재현되지 않는다. 이 테스트는 마이그레이션
 * SQL 유효성과 서비스 종단 동작을 검증한다. D1 실측은 운영 적용 단계에서 수행한다.
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

for (const [src, out] of [
  ['../../src/services/memory-consolidation.ts', '/tmp/memory-consolidation-dtrack-test.cjs'],
  ['../../src/scheduled.ts', '/tmp/memory-scheduled-dtrack-test.cjs'],
]) {
  try {
    execSync(`npx esbuild ${path.join(__dirname, src)} --bundle --platform=node --format=cjs --outfile=${out}`, {
      stdio: 'pipe',
    });
  } catch (e) {
    console.error('TypeScript 컴파일 실패:', src, e.message);
  }
}

const svc = require('/tmp/memory-consolidation-dtrack-test.cjs');
const scheduled = require('/tmp/memory-scheduled-dtrack-test.cjs');

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

const NOW = '2026-10-26T00:00:00.000Z';
const OLD = '2026-07-18T00:00:00.000Z'; // 100일 전

function insertMemory(db, content, over = {}) {
  const row = {
    category: 'fact',
    created_by: 'user',
    source_type: 'memo',
    source_id: null,
    allow_ai_use: 1,
    allow_provider_send: 1,
    summary: null,
    entities: null,
    access_count: 0,
    last_accessed_at: null,
    created_at: NOW,
    updated_at: NOW,
    is_active: 1,
    ...over,
  };
  const info = db.prepare(
    `INSERT INTO ai_memory_v2
     (content, category, created_by, source_type, source_id,
      allow_ai_use, allow_provider_send, summary, entities,
      access_count, last_accessed_at, created_at, updated_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    content, row.category, row.created_by, row.source_type, row.source_id,
    row.allow_ai_use, row.allow_provider_send, row.summary, row.entities,
    row.access_count, row.last_accessed_at, row.created_at, row.updated_at, row.is_active
  );
  return Number(info.lastInsertRowid);
}

describe('d트랙 수면 통합 (실제 SQLite)', () => {
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
    applyMigration(db, '0053_memory_reflection_consolidation.sql');
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
    db.prepare(`DELETE FROM memory_consolidation_log`).run();
    db.prepare(`DELETE FROM ai_settings WHERE key = 'memory.last_consolidation_date'`).run();
    db.prepare(`DELETE FROM ai_settings WHERE key = 'memory.llm_consolidation_enabled'`).run();
  });

  test('0053 적용 — memory_consolidation_log 테이블 존재', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    expect(tables).toContain('memory_consolidation_log');
  });

  test('중복 병합 — 생존자만 활성, 나머지는 대체 표시, 행 삭제 없음', async () => {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n;
    const id1 = insertMemory(db, 'Hello World', { updated_at: '2026-10-20T00:00:00.000Z' });
    const id2 = insertMemory(db, 'hello world!', { updated_at: '2026-10-25T00:00:00.000Z', access_count: 3 });
    const id3 = insertMemory(db, 'Hello  World', { updated_at: '2026-10-25T00:00:00.000Z', access_count: 5 });
    const id4 = insertMemory(db, '전혀 다른 내용입니다.');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n).toBe(before + 4);

    const stats = await svc.runSleepConsolidation({ DB: d1 }, {});
    expect(stats.ok).toBe(true);
    expect(stats.ran).toBe(true);
    expect(stats.merged).toBe(2);

    // 행 삭제 없음
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n).toBe(before + 4);
    // 생존자는 최신·접근 최다인 id3
    const survivor = db.prepare(`SELECT * FROM ai_memory_v2 WHERE id = ?`).get(id3);
    expect(survivor.is_active).toBe(1);
    expect(survivor.superseded_by).toBeNull();
    for (const id of [id1, id2]) {
      const row = db.prepare(`SELECT * FROM ai_memory_v2 WHERE id = ?`).get(id);
      expect(row.is_active).toBe(0);
      expect(row.superseded_by).toBe(id3);
    }
    // 무관한 기억은 그대로
    expect(db.prepare(`SELECT is_active FROM ai_memory_v2 WHERE id = ?`).get(id4).is_active).toBe(1);
    // 감사 기록
    const logs = db.prepare(`SELECT * FROM memory_consolidation_log WHERE action = 'merge'`).all();
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((l) => l.related_memory_id))).toEqual(new Set([id3]));
    expect(new Set(logs.map((l) => l.run_id))).toEqual(new Set([stats.runId]));
  });

  test('모순 표시 — 변경 쌍만 플래그, 표지 없는 유사 쌍은 그대로', async () => {
    const a = insertMemory(db, '팀 회의는 매주 월요일 10시에 열린다.');
    const b = insertMemory(db, '팀 회의 시간이 10시에서 11시로 변경됐다.');
    const c = insertMemory(db, '점심은 보통 12시에 먹는다.');
    const d = insertMemory(db, '저녁은 보통 7시에 먹는다.');

    const stats = await svc.runSleepConsolidation({ DB: d1 }, {});
    expect(stats.contradictions).toBe(1);
    expect(db.prepare(`SELECT contradiction_flag FROM ai_memory_v2 WHERE id = ?`).get(a).contradiction_flag).toBe(1);
    expect(db.prepare(`SELECT contradiction_flag FROM ai_memory_v2 WHERE id = ?`).get(b).contradiction_flag).toBe(1);
    expect(db.prepare(`SELECT contradiction_flag FROM ai_memory_v2 WHERE id = ?`).get(c).contradiction_flag).toBe(0);
    expect(db.prepare(`SELECT contradiction_flag FROM ai_memory_v2 WHERE id = ?`).get(d).contradiction_flag).toBe(0);
    const logs = db.prepare(`SELECT * FROM memory_consolidation_log WHERE action = 'contradiction'`).all();
    expect(logs).toHaveLength(1);
    expect([logs[0].memory_id, logs[0].related_memory_id].sort()).toEqual([a, b].sort());
  });

  test('오래된 기억 요약 — cold/archived만 채우고 hot은 그대로', async () => {
    const oldId = insertMemory(db, '작년에 이사한 집은 역에서 도보 5분 거리다. 주변에 공원이 있다.', { updated_at: OLD, created_at: OLD });
    // hot 기억은 실제 now 기준이어야 한다 — 기본값 NOW(고정 날짜)는 시간이 지나면
    // cold로 전이돼 요약 대상에 포함된다 (Track A 2026-10-29 동적 날짜로 교체)
    const nowIso = new Date().toISOString();
    const hotId = insertMemory(db, '오늘 점심은 김치찌개를 먹었다.', { created_at: nowIso, updated_at: nowIso });

    const stats = await svc.runSleepConsolidation({ DB: d1 }, {});
    expect(stats.summarized).toBe(1);
    const oldRow = db.prepare(`SELECT summary FROM ai_memory_v2 WHERE id = ?`).get(oldId);
    expect(oldRow.summary).toBe('작년에 이사한 집은 역에서 도보 5분 거리다.');
    expect(db.prepare(`SELECT summary FROM ai_memory_v2 WHERE id = ?`).get(hotId).summary).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_consolidation_log WHERE action = 'summarize'`).get().n).toBe(1);
  });

  test('이미 요약이 있는 오래된 기억은 건드리지 않음', async () => {
    insertMemory(db, '오래된 기억이다. 두 번째 문장이다.', { updated_at: OLD, created_at: OLD, summary: '기존 요약' });
    const stats = await svc.runSleepConsolidation({ DB: d1 }, {});
    expect(stats.summarized).toBe(0);
    expect(db.prepare(`SELECT summary FROM ai_memory_v2`).get().summary).toBe('기존 요약');
  });

  test('v2 플래그 OFF — 실행하지 않음', async () => {
    insertMemory(db, 'Hello World');
    db.prepare(`UPDATE ai_settings SET value = 'false' WHERE key = 'memory.v2_enabled'`).run();
    try {
      const stats = await svc.runSleepConsolidation({ DB: d1 }, {});
      expect(stats.ran).toBe(false);
      expect(stats.reason).toBe('disabled');
      expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_consolidation_log`).get().n).toBe(0);
    } finally {
      db.prepare(`UPDATE ai_settings SET value = 'true' WHERE key = 'memory.v2_enabled'`).run();
    }
  });

  test('LLM 플래그 OFF — llmSummarize를 호출하지 않음', async () => {
    insertMemory(db, '오래된 기억이다. 두 번째 문장이다.', { updated_at: OLD, created_at: OLD });
    let called = 0;
    const stats = await svc.runSleepConsolidation({ DB: d1 }, {
      llmSummarize: async () => { called++; return 'LLM 요약'; },
    });
    expect(called).toBe(0);
    expect(stats.summarized).toBe(1);
    expect(db.prepare(`SELECT summary FROM ai_memory_v2`).get().summary).toBe('오래된 기억이다.');
  });

  test('LLM 플래그 ON — llmSummarize 결과를 사용, 실패 시 결정적 폴백', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES ('memory.llm_consolidation_enabled', 'true', datetime('now'))`).run();
    const okId = insertMemory(db, '오래된 기억이다. 두 번째 문장이다.', { updated_at: OLD, created_at: OLD });
    const failId = insertMemory(db, '또 다른 오래된 기억이다. 두 번째 문장이다.', { updated_at: OLD, created_at: OLD });
    let n = 0;
    const stats = await svc.runSleepConsolidation({ DB: d1 }, {
      llmSummarize: async (text) => {
        n++;
        if (text.includes('또 다른')) throw new Error('llm boom');
        return 'LLM이 만든 요약이다.';
      },
    });
    expect(n).toBe(2);
    expect(stats.summarized).toBe(2);
    expect(db.prepare(`SELECT summary FROM ai_memory_v2 WHERE id = ?`).get(okId).summary).toBe('LLM이 만든 요약이다.');
    expect(db.prepare(`SELECT summary FROM ai_memory_v2 WHERE id = ?`).get(failId).summary).toBe('또 다른 오래된 기억이다.');
  });

  test('실행 내역 run 행에 통계 JSON이 남는다', async () => {
    insertMemory(db, 'Hello World');
    const stats = await svc.runSleepConsolidation({ DB: d1 }, {});
    const runLog = db.prepare(`SELECT * FROM memory_consolidation_log WHERE action = 'run'`).get();
    expect(runLog).toBeTruthy();
    expect(runLog.run_id).toBe(stats.runId);
    const detail = JSON.parse(runLog.detail);
    expect(detail.scanned).toBe(1);
    expect(detail.merged).toBe(0);
  });

  describe('handleSleepConsolidation 스케줄 연결', () => {
    test('03:00 KST 틱에 실행하고 같은 날 두 번째 틱은 건너뜀', async () => {
      insertMemory(db, 'Hello World');
      const first = await scheduled.handleSleepConsolidation({ DB: d1 }, new Date('2026-10-26T03:10:00+09:00'));
      expect(first.ran).toBe(true);
      expect(first.stats.merged).toBe(0);
      const second = await scheduled.handleSleepConsolidation({ DB: d1 }, new Date('2026-10-26T03:40:00+09:00'));
      expect(second.ran).toBe(false);
      expect(second.reason).toBe('already_ran_today');
      expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_consolidation_log WHERE action = 'run'`).get().n).toBe(1);
    });

    test('03:00 KST가 아니면 실행하지 않음', async () => {
      insertMemory(db, 'Hello World');
      const r = await scheduled.handleSleepConsolidation({ DB: d1 }, new Date('2026-10-26T10:00:00+09:00'));
      expect(r.ran).toBe(false);
      expect(r.reason).toBe('not_sleep_window');
      expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_consolidation_log`).get().n).toBe(0);
    });

    test('다음 날 03:00 KST에는 다시 실행', async () => {
      insertMemory(db, 'Hello World');
      await scheduled.handleSleepConsolidation({ DB: d1 }, new Date('2026-10-26T03:10:00+09:00'));
      const next = await scheduled.handleSleepConsolidation({ DB: d1 }, new Date('2026-10-27T03:05:00+09:00'));
      expect(next.ran).toBe(true);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_consolidation_log WHERE action = 'run'`).get().n).toBe(2);
    });
  });
});
