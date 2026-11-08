/**
 * 0046 mem0 패턴 이식 — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0046을 순서대로
 * 적용하고, esbuild로 컴파일한 실제 src/services/fact-graph.ts를 호출한다.
 * - 사실 추출·저장·그래프 연결 종단 동작 (ai_memory_v2 + 0046 3개 테이블)
 * - 잠긴 메모 거부 + 잠긴 블록 제거
 * - FTS5 + 그래프 1-hop 병합 검색 (최대 5개, touch)
 *
 * 실행: npx jest tests/integration/memory-0046-real.test.js
 *
 * 주의: D1 고유 동작은 표준 SQLite에서 재현되지 않는다. 이 테스트는 마이그레이션
 * SQL 유효성과 서비스 종단 동작을 검증한다. D1 실측은 운영 적용 단계에서 수행한다.
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const tsPath = path.join(__dirname, '../../src/services/fact-graph.ts');
const jsPath = '/tmp/memory-fact-graph-0046-test.cjs';
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

describe('0046 마이그레이션 + 사실·그래프 파이프라인 (실제 SQLite)', () => {
  let db;
  let d1;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT)`);
    // captureFactsFromMemo가 읽는 최소 memos 스키마 (실제 0001/0013의 부분집합)
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
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'true')`).run();
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

  test('0046 적용 — 3개 테이블 + UNIQUE/CHECK 존재', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    for (const t of ['memory_entities', 'memory_relations', 'memory_fact_entities']) {
      expect(tables).toContain(t);
    }
    const relSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memory_relations'`).get().sql;
    expect(relSql).toContain('UNIQUE (source_entity_id, target_entity_id, relation)');
    expect(relSql).toContain("CHECK (relation IN ('related_to'))");
    const entSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memory_entities'`).get().sql;
    expect(entSql).toContain('normalized TEXT NOT NULL UNIQUE');
  });

  test('captureFacts 종단 — 사실 저장 + 엔티티 + 연결 + 간선', async () => {
    const r = await svc.captureFacts({ DB: d1 }, {
      text: '사용자는 "MyHub"를 2026-10-25에 만들었다. D1을 쓴다.',
    });
    expect(r.ok).toBe(true);
    expect(r.extraction).toBe('deterministic');
    expect(r.created).toHaveLength(2);

    // 사실 행: category=fact, 동의 기본 0
    const facts = db.prepare(`SELECT content, category, allow_ai_use, allow_provider_send, source_type FROM ai_memory_v2`).all();
    expect(facts).toHaveLength(2);
    for (const f of facts) {
      expect(f.category).toBe('fact');
      expect(f.allow_ai_use).toBe(0);
      expect(f.allow_provider_send).toBe(0);
    }
    // FTS 인덱스에도 들어감 (트리거)
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH 'MyHub'`).all()).toHaveLength(1);

    // 엔티티: MyHub, 2026-10-25, D1 (정규화 UNIQUE)
    const entities = db.prepare(`SELECT name, normalized FROM memory_entities ORDER BY name`).all();
    expect(entities.map((e) => e.name)).toEqual(expect.arrayContaining(['MyHub', '2026-10-25', 'D1']));
    const dup = db.prepare(`SELECT COUNT(*) AS n FROM memory_entities WHERE normalized = 'myhub'`).get();
    expect(dup.n).toBe(1);

    // 사실↔엔티티 연결
    const links = db.prepare(`SELECT COUNT(*) AS n FROM memory_fact_entities`).get();
    expect(links.n).toBeGreaterThanOrEqual(3);
    // 같은 사실의 엔티티 쌍 간선 (MyHub—2026-10-25)
    const edges = db.prepare(`SELECT COUNT(*) AS n FROM memory_relations WHERE relation = 'related_to'`).get();
    expect(edges.n).toBeGreaterThanOrEqual(1);
  });

  test('captureFacts — near-duplicate 재캡처 시 skipped, 행 증가 없음', async () => {
    const text = '사용자는 등산을 좋아합니다. 매주 월요일 10시에 회의가 있습니다.';
    const r1 = await svc.captureFacts({ DB: d1 }, { text });
    expect(r1.created).toHaveLength(2);
    const r2 = await svc.captureFacts({ DB: d1 }, { text });
    expect(r2.created).toHaveLength(0);
    expect(r2.skipped).toHaveLength(2);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n).toBe(2);
  });

  test('captureFactsFromMemo — 잠긴 메모는 locked, 행 생성 없음', async () => {
    const id = db.prepare(`INSERT INTO memos (text, is_locked) VALUES ('비밀 사실 문장입니다.', 1)`).run().lastInsertRowid;
    const r = await svc.captureFactsFromMemo({ DB: d1 }, Number(id));
    expect(r).toEqual({ ok: false, error: 'locked' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_memory_v2`).get().n).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_entities`).get().n).toBe(0);
  });

  test('captureFactsFromMemo — 잠긴 블록 제거 후 캡처 (비밀 내용 미저장)', async () => {
    const id = db.prepare(
      `INSERT INTO memos (text, is_locked) VALUES (?, 0)`
    ).run('공개 사실 문장입니다. <span class="locked">비밀카드번호 1234</span> 다른 공개 문장입니다.').lastInsertRowid;
    const r = await svc.captureFactsFromMemo({ DB: d1 }, Number(id));
    expect(r.ok).toBe(true);
    const contents = db.prepare(`SELECT content FROM ai_memory_v2`).all().map((x) => x.content).join(' ');
    expect(contents).not.toContain('비밀카드번호');
    expect(contents).not.toContain('1234');
    expect(contents).toContain('공개 사실 문장입니다.');
    expect(r.created).toHaveLength(2);
  });

  test('LLM 플래그 OFF — 주입된 추출기가 던져도 결정적 경로로 성공', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.llm_extract_enabled', 'false')`).run();
    const boom = async () => { throw new Error('llm down'); };
    const r = await svc.captureFacts({ DB: d1 }, {
      text: '결정적 사실 문장입니다.',
      llmExtract: boom,
    });
    expect(r.ok).toBe(true);
    expect(r.extraction).toBe('deterministic');
    expect(r.created).toHaveLength(1);
  });

  test('getRelatedFacts 종단 — FTS에 없는 그래프 이웃 사실까지 포함, 최대 5개, touch', async () => {
    const ins = db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send, updated_at)
       VALUES (?, 'fact', 1, 1, 1, '2026-10-25T00:00:00Z')`
    );
    // FTS 히트 행 (내용에 '등산' 포함)
    ins.run('등산 취미 기록');
    // FTS 미히트 행 — 내용에 '등산' 없음, 그래프로만 연결됨
    const graphOnlyId = Number(ins.run('장비 목록 정리').lastInsertRowid);
    // 동의 없는 행 — 제외돼야 함
    db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send)
       VALUES ('등산 비밀 기록', 'fact', 1, 0, 0)`
    ).run();
    // 엔티티 '등산' + 그래프 전용 사실 연결
    const entId = Number(db.prepare(`INSERT INTO memory_entities (name, normalized) VALUES ('등산', '등산')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO memory_fact_entities (fact_id, entity_id) VALUES (?, ?)`).run(graphOnlyId, entId);
    // FTS 히트 행도 같은 엔티티에 연결 (직접 매칭)
    const ftsId = db.prepare(`SELECT id FROM ai_memory_v2 WHERE content = '등산 취미 기록'`).get().id;
    db.prepare(`INSERT INTO memory_fact_entities (fact_id, entity_id) VALUES (?, ?)`).run(ftsId, entId);

    const out = await svc.getRelatedFacts({ DB: d1 }, '등산');
    const contents = out.map((r) => r.content);
    expect(contents).toContain('등산 취미 기록');
    expect(contents).toContain('장비 목록 정리'); // FTS 미히트지만 그래프로 회수
    expect(contents).not.toContain('등산 비밀 기록');
    expect(out.length).toBeLessThanOrEqual(5);
    // touch: 반환된 행의 access_count 1 증가, 동의 없는 행은 0 유지
    const touched = db.prepare(`SELECT access_count FROM ai_memory_v2 WHERE content = '장비 목록 정리'`).get();
    expect(touched.access_count).toBe(1);
    const untouched = db.prepare(`SELECT access_count FROM ai_memory_v2 WHERE content = '등산 비밀 기록'`).get();
    expect(untouched.access_count).toBe(0);
  });

  test('getFactNeighbors 종단 — 공유 엔티티 이웃 조회', async () => {
    const ins = db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send, updated_at)
       VALUES (?, 'fact', 1, 1, 1, '2026-10-25T00:00:00Z')`
    );
    const seedId = Number(ins.run('기준 사실 내용').lastInsertRowid);
    const n1 = Number(ins.run('이웃 사실 하나').lastInsertRowid);
    const n2 = Number(ins.run('이웃 사실 둘').lastInsertRowid);
    const e1 = Number(db.prepare(`INSERT INTO memory_entities (name, normalized) VALUES ('엔티티일', '엔티티일')`).run().lastInsertRowid);
    const e2 = Number(db.prepare(`INSERT INTO memory_entities (name, normalized) VALUES ('엔티티이', '엔티티이')`).run().lastInsertRowid);
    const link = db.prepare(`INSERT INTO memory_fact_entities (fact_id, entity_id) VALUES (?, ?)`);
    link.run(seedId, e1);
    link.run(seedId, e2);
    link.run(n1, e1);
    link.run(n2, e1);
    link.run(n2, e2);

    const out = await svc.getFactNeighbors({ DB: d1 }, seedId);
    expect(out.map((r) => r.id)).toEqual([n2, n1]); // 공유 2개가 먼저
    expect(out[0].score).toBe(1);
  });

  test('getRelatedFacts — 플래그 OFF면 빈 배열', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'false')`).run();
    expect(await svc.getRelatedFacts({ DB: d1 }, '등산')).toEqual([]);
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'true')`).run();
  });
});
