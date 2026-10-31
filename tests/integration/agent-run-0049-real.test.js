/**
 * 0049 agent-framework 패턴 — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0049를
 * 순서대로 적용하고, esbuild로 컴파일한 실제 src/services/agent-run.ts와
 * agent-handoff.ts를 호출한다.
 * - run 생성·체크포인트 저장·재개 종단 동작
 * - 중단·재개 시나리오: 2단계 실패 → paused → 재개 시 실패 단계부터 이어하고
 *   완료 단계는 재실행하지 않음
 * - 형식 있는 핸드오프 생성·해결 + memory_handoffs 연결 검증
 *
 * 실행: npx jest tests/integration/agent-run-0049-real.test.js
 *
 * 주의: D1 고유 동작은 표준 SQLite에서 재현되지 않는다. 이 테스트는
 * 마이그레이션 SQL 유효성과 서비스 종단 동작을 검증한다. D1 실측은
 * 운영 적용 단계에서 수행한다.
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function bundle(tsName, outName) {
  const tsPath = path.join(__dirname, '../../src/services', tsName);
  const jsPath = path.join('/tmp', outName);
  try {
    execSync(`npx esbuild ${tsPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`, {
      stdio: 'pipe',
    });
  } catch (e) {
    console.error('TypeScript 컴파일 실패:', tsName, e.message);
  }
  return require(jsPath);
}

const runSvc = bundle('agent-run.ts', 'agent-run-0049-test.cjs');
const handoffSvc = bundle('agent-handoff.ts', 'agent-handoff-0049-test.cjs');

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

const PLAN = {
  steps: [
    { name: 'research', persona: 'echo', objective: '관련 메모를 검색해서 요약한다' },
    { name: 'draft', persona: 'nova', objective: '요약 바탕으로 초안 코드를 작성한다' },
    { name: 'schedule', persona: 'cali', objective: '마감 일정을 등록하고 확인한다' },
  ],
};

describe('0049 마이그레이션 + agent-run 서비스 (실제 SQLite)', () => {
  let db;
  let d1;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT)`);
    applyMigration(db, '0027_memory_v2.sql');
    applyMigration(db, '0028_memory_fts.sql');
    applyMigration(db, '0029_memory_consent.sql');
    applyMigration(db, '0044_memory_pages_aging.sql');
    applyMigration(db, '0049_agent_runs_checkpoints.sql');
  });

  afterAll(() => {
    db.close();
  });

  test('0049 적용 — 새 테이블·인덱스 존재', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    expect(tables).toContain('agent_runs');
    expect(tables).toContain('agent_run_checkpoints');
    expect(tables).toContain('agent_handoffs');
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r) => r.name);
    expect(idx).toContain('idx_checkpoints_run');
    expect(idx).toContain('idx_agent_handoffs_to');
  });

  test('run 생성 → 체크포인트 저장 → 재개 정보 일치', async () => {
    const env = { DB: d1 };
    const created = await runSvc.createRun(env, { conversationId: 3, userText: '복합 요청', plan: PLAN });
    expect(created.ok).toBe(true);
    const runId = created.runId;
    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(runId);
    expect(row.status).toBe('running');
    expect(row.total_steps).toBe(3);
    expect(row.current_step).toBe(0);

    const saved = await runSvc.saveCheckpoint(env, runId, {
      stepIndex: 0, stepName: 'research', persona: 'echo', state: { results: ['요약완료'] },
    });
    expect(saved.ok).toBe(true);
    expect(db.prepare(`SELECT current_step FROM agent_runs WHERE id = ?`).get(runId).current_step).toBe(1);

    const resumed = await runSvc.resumeRun(env, runId);
    expect(resumed.ok).toBe(true);
    expect(resumed.nextStepIndex).toBe(1);
    expect(resumed.remainingSteps.map((s) => s.name)).toEqual(['draft', 'schedule']);
    expect(resumed.state).toEqual({ results: ['요약완료'] });
  });

  test('중단·재개 시나리오 — 2단계 실패 후 paused, 재개 시 실패 단계부터 이어하고 완료 단계 재실행 안 함', async () => {
    const env = { DB: d1 };
    const created = await runSvc.createRun(env, { conversationId: 4, userText: '중단 테스트', plan: PLAN });
    const runId = created.runId;
    const calls = [];

    // 1차 실행: draft 단계에서 실패
    const first = await runSvc.driveRun(env, runId, async (step) => {
      calls.push(step.name);
      if (step.name === 'draft') throw new Error('모델 호출 실패');
      return `${step.name}-done`;
    });
    expect(first.ok).toBe(false);
    expect(first.nextStepIndex).toBe(1);
    expect(db.prepare(`SELECT status FROM agent_runs WHERE id = ?`).get(runId).status).toBe('paused');
    expect(db.prepare(`SELECT error FROM agent_runs WHERE id = ?`).get(runId).error).toContain('draft');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_run_checkpoints WHERE run_id = ?`).get(runId).n).toBe(1);

    // 2차 실행: 재개 — research 재실행 없이 draft부터 이어한다
    const second = await runSvc.driveRun(env, runId, async (step) => {
      calls.push(step.name);
      return `${step.name}-done`;
    });
    expect(second.ok).toBe(true);
    expect(second.completed).toBe(true);
    expect(calls).toEqual(['research', 'draft', 'draft', 'schedule']);
    expect(db.prepare(`SELECT status FROM agent_runs WHERE id = ?`).get(runId).status).toBe('completed');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_run_checkpoints WHERE run_id = ?`).get(runId).n).toBe(3);
    const last = db.prepare(
      `SELECT state_json FROM agent_run_checkpoints WHERE run_id = ? ORDER BY step_index DESC LIMIT 1`
    ).get(runId);
    expect(JSON.parse(last.state_json).results).toEqual(['research-done', 'draft-done', 'schedule-done']);

    // 3차 실행: 완료된 run은 재실행하지 않는다
    const third = await runSvc.driveRun(env, runId, async (step) => {
      calls.push(step.name);
      return 'again';
    });
    expect(third.ok).toBe(false); // resumeRun이 run_terminal로 거부
    expect(third.error).toBe('run_terminal');
    expect(calls).toEqual(['research', 'draft', 'draft', 'schedule']);
  });

  test('체크포인트 CHECK 제약 — 음수 step_index 거부', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO agent_run_checkpoints (run_id, step_index, step_name, persona, state_json) VALUES ('run_x', -1, 'a', 'echo', '{}')`
      ).run();
    }).toThrow();
  });

  test('형식 있는 핸드오프 — 생성·조회·해결 + memory_handoff 연결', async () => {
    const env = { DB: d1 };
    // claim-once 기억 인계 행을 직접 만들고 연결한다
    const mh = db.prepare(
      `INSERT INTO memory_handoffs (claim_token, from_persona, to_persona, payload, status, created_at, expires_at) VALUES ('tok-0049', 'echo', 'nova', '{"memory_ids":[1]}', 'pending', '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z')`
    ).run();
    const created = await handoffSvc.createStructuredHandoff(env, {
      fromPersona: 'echo',
      toPersona: 'nova',
      request: '요약 바탕으로 초안 코드 작성',
      context: ['[echo의 답변]\n요약 내용'],
      constraints: ['생성 코드는 실행 가능해야 함'],
      expectedOutput: '초안 코드',
      memoryHandoffId: Number(mh.lastInsertRowid),
    });
    expect(created.ok).toBe(true);
    const got = await handoffSvc.getStructuredHandoff(env, created.id);
    expect(got.ok).toBe(true);
    expect(got.handoff.status).toBe('pending');
    expect(got.handoff.memoryHandoffId).toBe(Number(mh.lastInsertRowid));
    expect(got.handoff.constraints).toEqual(['생성 코드는 실행 가능해야 함']);

    const resolved = await handoffSvc.resolveStructuredHandoff(env, created.id, 'completed');
    expect(resolved.ok).toBe(true);
    // 이미 해결된 핸드오프는 다시 바꿀 수 없다
    const again = await handoffSvc.resolveStructuredHandoff(env, created.id, 'rejected');
    expect(again.ok).toBe(false);
    expect(again.error).toBe('not_pending_or_not_found');
    expect((await handoffSvc.getStructuredHandoff(env, created.id)).handoff.status).toBe('completed');
  });

  test('형식 있는 핸드오프 — 없는 memory_handoff 연결 거부, from/to 같음 거부', async () => {
    const env = { DB: d1 };
    const badLink = await handoffSvc.createStructuredHandoff(env, {
      fromPersona: 'echo', toPersona: 'nova', request: 'r',
      context: [], constraints: [], expectedOutput: '', memoryHandoffId: 999999,
    });
    expect(badLink.ok).toBe(false);
    expect(badLink.error).toBe('memory_handoff_not_found');
    const samePersona = await handoffSvc.createStructuredHandoff(env, {
      fromPersona: 'echo', toPersona: 'echo', request: 'r',
      context: [], constraints: [], expectedOutput: '',
    });
    expect(samePersona.ok).toBe(false);
  });

  test('agent_handoffs CHECK 제약 — from/to 같으면 DB 레벨에서도 거부', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO agent_handoffs (from_persona, to_persona, request) VALUES ('echo', 'echo', 'r')`
      ).run();
    }).toThrow();
  });
});
