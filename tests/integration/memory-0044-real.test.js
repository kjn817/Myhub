/**
 * 0044 장기 메모리 재설계 — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044를 순서대로 적용하고,
 * esbuild로 컴파일한 실제 src/services/memory-service.ts를 호출한다.
 * - FTS 재구성(0030 패턴): 트리거가 DELETE ... WHERE rowid = ? 로 동작하는지
 * - 요약 페이지 / 대체·복원 / 핸드오프 claim-once 종단 동작
 *
 * 실행: npx jest tests/integration/memory-0044-real.test.js
 *
 * 주의: D1 고유 동작(content= 테이블 CREATE 시 전체 자동 인덱싱, 'delete' 특수
 * 명령의 SQLITE_ERROR)은 표준 SQLite에서 재현되지 않는다. 이 테스트는 마이그레이션
 * SQL 유효성과 0030 패턴의 동작을 검증한다. D1 실측은 운영 적용 단계에서 수행한다.
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const tsPath = path.join(__dirname, '../../src/services/memory-service.ts');
const jsPath = '/tmp/memory-service-0044-test.cjs';
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

describe('0044 마이그레이션 + 메모리 서비스 (실제 SQLite)', () => {
  let db;
  let d1;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    // ai_settings (플래그용 — 0001과 동일 형태의 최소 스키마)
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT)`);
    applyMigration(db, '0027_memory_v2.sql');
    applyMigration(db, '0028_memory_fts.sql');
    applyMigration(db, '0029_memory_consent.sql');
    applyMigration(db, '0044_memory_pages_aging.sql');
  });

  afterAll(() => {
    db.close();
  });

  test('0044 적용 — 새 컬럼·테이블 존재', () => {
    const cols = db.prepare(`PRAGMA table_info(ai_memory_v2)`).all().map((r) => r.name);
    for (const c of ['access_count', 'last_accessed_at', 'superseded_by', 'supersedes', 'contradiction_flag', 'summary', 'entities']) {
      expect(cols).toContain(c);
    }
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    expect(tables).toContain('memory_pages');
    expect(tables).toContain('memory_handoffs');
  });

  test('ai_memory_fts는 일반 FTS5 (content= 없음)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name='ai_memory_fts'`).get();
    expect(row.sql).toContain('USING fts5(content)');
    expect(row.sql).not.toContain("content=");
  });

  test('FTS 트리거 — INSERT/UPDATE/DELETE 시 인덱스 동기화', () => {
    const ins = db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send) VALUES (?, 'fact', 1, 1, 1)`
    );
    const id = ins.run('사과바나나 테스트 기억').lastInsertRowid;
    // 활성 → MATCH 히트
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '사과바나나'`).all()).toHaveLength(1);
    // 비활성화 → MATCH에서 사라짐 (UPDATE 트리거의 DELETE ... WHERE rowid)
    db.prepare(`UPDATE ai_memory_v2 SET is_active = 0 WHERE id = ?`).run(id);
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '사과바나나'`).all()).toHaveLength(0);
    // 재활성화 → 다시 히트
    db.prepare(`UPDATE ai_memory_v2 SET is_active = 1 WHERE id = ?`).run(id);
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '사과바나나'`).all()).toHaveLength(1);
    // 내용 변경 → 새 내용으로 검색됨
    db.prepare(`UPDATE ai_memory_v2 SET content = '포도키위 변경 기억' WHERE id = ?`).run(id);
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '사과바나나'`).all()).toHaveLength(0);
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '포도키위'`).all()).toHaveLength(1);
    // 삭제 → 인덱스에서 제거 (DELETE 트리거)
    db.prepare(`DELETE FROM ai_memory_v2 WHERE id = ?`).run(id);
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '포도키위'`).all()).toHaveLength(0);
    // 비활성 삽입 → 인덱싱 안 됨
    db.prepare(`INSERT INTO ai_memory_v2 (content, category, is_active) VALUES ('비활성기억', 'fact', 0)`).run();
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '비활성기억'`).all()).toHaveLength(0);
  });

  test('getRelevantMemories — FTS 검색 + 융합 랭킹 + touch', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'true')`).run();
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    db.prepare(`DELETE FROM ai_memory_fts`).run();
    // updated_at은 tier(실제 now 기준 경과일) 판정에 쓰이므로 동적 날짜를 쓴다
    // (Track A 2026-10-29: 고정 '2026-10-25'는 7일이 지나면 hot→warm으로 만료됨)
    const recent = new Date(Date.now() - 86400000).toISOString();
    const ins = db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send, entities, updated_at)
       VALUES (?, 'fact', 1, 1, 1, ?, ?)`
    );
    ins.run('등산 취미 기록', '["등산"]', recent);
    // FTS는 OR 결합 (2026-10-26) — 두 행 모두 '등산'·'취미' 토큰을 포함해 히트한다
    ins.run('등산 취미 장비 목록', '[]', recent);
    // 동의 없는 기억은 제외돼야 함
    db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send)
       VALUES ('등산 비밀 기록', 'fact', 1, 0, 0)`
    ).run();

    const out = await svc.getRelevantMemories({ DB: d1 }, '등산 취미');
    expect(out).toHaveLength(2);
    // 엔티티 일치가 있는 쪽이 먼저
    expect(out[0].content).toContain('등산 취미 기록');
    expect(out[0].score).toBeGreaterThan(0);
    expect(out[0].tier).toBe('hot');
    // touch: 반환된 기억의 access_count가 1 증가
    const touched = db.prepare(`SELECT access_count, last_accessed_at FROM ai_memory_v2 WHERE content LIKE '등산 취미%'`).get();
    expect(touched.access_count).toBe(1);
    expect(touched.last_accessed_at).not.toBeNull();
    // 동의 없는 기억은 touch되지 않음
    const untouched = db.prepare(`SELECT access_count FROM ai_memory_v2 WHERE content = '등산 비밀 기록'`).get();
    expect(untouched.access_count).toBe(0);
  });

  test('getRelevantMemories — 다단어 자연어 질문도 OR + 조사 분리로 매칭 (2026-10-26)', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'true')`).run();
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    db.prepare(`DELETE FROM ai_memory_fts`).run();
    const ins = db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send, entities, updated_at)
       VALUES (?, 'fact', 1, 1, 1, ?, '2026-10-25T00:00:00Z')`
    );
    ins.run('내 반려견 이름은 보라돌이', '["보라돌이"]');
    ins.run('갈색 푸들 산책 기록', '["푸들"]');
    ins.run('등산 취미 기록', '["등산"]');

    // "내 반려견 이름이 뭐야?" — 조사 분리 + OR로 '반려견'/'이름' 토큰이 히트
    const out1 = await svc.getRelevantMemories({ DB: d1 }, '내 반려견 이름이 뭐야?');
    expect(out1.map((r) => r.content)).toContain('내 반려견 이름은 보라돌이');

    // 단일어
    const out2 = await svc.getRelevantMemories({ DB: d1 }, '보라돌이');
    expect(out2.map((r) => r.content)).toContain('내 반려견 이름은 보라돌이');

    // "갈색 푸들" — 두 토큰 중 하나라도 히트 (OR), 최대 5개 제한 유지
    const out3 = await svc.getRelevantMemories({ DB: d1 }, '갈색 푸들');
    expect(out3.map((r) => r.content)).toContain('갈색 푸들 산책 기록');
    expect(out3.length).toBeLessThanOrEqual(5);

    // 관련 없는 질문은 빈 배열 (잡음이 랭킹을 무너뜨리지 않음)
    const out4 = await svc.getRelevantMemories({ DB: d1 }, '양자역학 교양서');
    expect(out4).toEqual([]);
  });

  test('getRelevantMemories — 플래그 OFF면 빈 배열', async () => {
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'false')`).run();
    expect(await svc.getRelevantMemories({ DB: d1 }, '등산')).toEqual([]);
    db.prepare(`INSERT OR REPLACE INTO ai_settings (key, value) VALUES ('memory.v2_enabled', 'true')`).run();
  });

  test('buildMemoryPage — 핵심 사실 페이지 생성', async () => {
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    db.prepare(`DELETE FROM memory_pages`).run();
    const ins = db.prepare(`INSERT INTO ai_memory_v2 (content, category, is_active) VALUES (?, 'fact', 1)`);
    const id1 = ins.run('첫 번째 사실입니다. 부가 설명입니다.').lastInsertRowid;
    const id2 = ins.run('두 번째 사실입니다.').lastInsertRowid;
    const r = await svc.buildMemoryPage({ DB: d1 }, { title: '테스트 페이지', memoryIds: [Number(id1), Number(id2)] });
    expect(r.ok).toBe(true);
    const page = db.prepare(`SELECT title, body, source_ids FROM memory_pages WHERE id = ?`).get(r.id);
    expect(page.title).toBe('테스트 페이지');
    expect(page.body).toContain('- 첫 번째 사실입니다.');
    expect(page.body).toContain('- 두 번째 사실입니다.');
    expect(page.body).not.toContain('부가 설명');
    expect(JSON.parse(page.source_ids)).toEqual([Number(id1), Number(id2)]);
  });

  test('supersede → restore 라운드트립', async () => {
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    const ins = db.prepare(`INSERT INTO ai_memory_v2 (content, category, is_active) VALUES (?, 'fact', 1)`);
    const oldId = Number(ins.run('오래된 기억').lastInsertRowid);
    const newId = Number(ins.run('새로운 기억').lastInsertRowid);
    const s = await svc.supersedeMemory({ DB: d1 }, oldId, newId);
    expect(s.ok).toBe(true);
    const old = db.prepare(`SELECT is_active, superseded_by FROM ai_memory_v2 WHERE id = ?`).get(oldId);
    expect(old.is_active).toBe(0);
    expect(old.superseded_by).toBe(newId);
    const next = db.prepare(`SELECT supersedes FROM ai_memory_v2 WHERE id = ?`).get(newId);
    expect(next.supersedes).toBe(oldId);
    // 대체된 기억은 FTS에서 사라짐
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '오래된'`).all()).toHaveLength(0);
    // 복원
    const r = await svc.restoreMemory({ DB: d1 }, oldId);
    expect(r.ok).toBe(true);
    const restored = db.prepare(`SELECT is_active, superseded_by FROM ai_memory_v2 WHERE id = ?`).get(oldId);
    expect(restored.is_active).toBe(1);
    expect(restored.superseded_by).toBeNull();
    expect(db.prepare(`SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH '오래된'`).all()).toHaveLength(1);
  });

  test('markContradiction — 플래그 설정/해제', async () => {
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    const id = Number(db.prepare(`INSERT INTO ai_memory_v2 (content, category, is_active) VALUES ('모순 기억', 'fact', 1)`).run().lastInsertRowid);
    await svc.markContradiction({ DB: d1 }, id, true);
    expect(db.prepare(`SELECT contradiction_flag FROM ai_memory_v2 WHERE id = ?`).get(id).contradiction_flag).toBe(1);
    await svc.markContradiction({ DB: d1 }, id, false);
    expect(db.prepare(`SELECT contradiction_flag FROM ai_memory_v2 WHERE id = ?`).get(id).contradiction_flag).toBe(0);
  });

  test('핸드오프 claim-once — 두 번째 수령 실패', async () => {
    db.prepare(`DELETE FROM memory_handoffs`).run();
    const created = await svc.createHandoff({ DB: d1 }, {
      fromPersona: 'lumi', toPersona: 'echo', memoryIds: [1, 2], summary: '인계',
    });
    expect(created.ok).toBe(true);
    const first = await svc.claimHandoff({ DB: d1 }, created.claimToken);
    expect(first.ok).toBe(true);
    expect(first.payload.memory_ids).toEqual([1, 2]);
    expect(first.fromPersona).toBe('lumi');
    const second = await svc.claimHandoff({ DB: d1 }, created.claimToken);
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already_claimed_or_expired');
    const row = db.prepare(`SELECT status FROM memory_handoffs WHERE claim_token = ?`).get(created.claimToken);
    expect(row.status).toBe('claimed');
  });

  test('핸드오프 만료 — expires_at 지난 토큰은 수령 불가', async () => {
    db.prepare(`DELETE FROM memory_handoffs`).run();
    const created = await svc.createHandoff({ DB: d1 }, {
      fromPersona: 'lumi', toPersona: 'echo', memoryIds: [1], ttlMinutes: 60,
    });
    // 만료 시간을 과거로 조작
    db.prepare(`UPDATE memory_handoffs SET expires_at = '2000-01-01T00:00:00Z' WHERE claim_token = ?`).run(created.claimToken);
    const r = await svc.claimHandoff({ DB: d1 }, created.claimToken);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('already_claimed_or_expired');
  });

  test('formatMemoryContext — 식은 기억은 요약 주입 (실제 데이터)', async () => {
    db.prepare(`DELETE FROM ai_memory_v2`).run();
    db.prepare(
      `INSERT INTO ai_memory_v2 (content, category, is_active, allow_ai_use, allow_provider_send, summary, updated_at)
       VALUES ('오래된 원문 내용입니다.', 'fact', 1, 1, 1, '오래된 핵심 요약', '2025-01-01T00:00:00Z')`
    ).run();
    const out = await svc.getRelevantMemories({ DB: d1 }, '오래된 원문');
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('archived');
    const ctx = svc.formatMemoryContext(out);
    expect(ctx).toContain('오래된 핵심 요약');
    expect(ctx).not.toContain('오래된 원문 내용입니다.');
    expect(ctx).toContain('|archived');
  });
});
