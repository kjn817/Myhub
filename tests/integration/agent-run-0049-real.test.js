/**
 * 0049 agent-framework 패턴 — 실제 SQLite 통합 테스트
 * (현행 표면 기준 재작성 — 2026-11-08 배치 3)
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0049를
 * 순서대로 적용하고, esbuild로 컴파일한 실제 src/services/agent-run.ts와
 * plan-execute.ts를 호출한다.
 * - run 생성·체크포인트 저장의 DB 기록 상태
 * - executePlan 종단: 전 단계 실행 → agent_runs completed + 체크포인트 3개
 * - 실패 시나리오: 재시도 소진 → 중단, agent_runs failed + 완료 단계 체크포인트만
 *
 * [삭제 기록] 구 resumeRun/driveRun 재개 종단 시나리오와 핸드오프 CRUD 종단
 * 2건은 해당 API가 번들·현행 어디에도 없어 삭제한다. 현행 체크포인트는
 * 재개점이 아니라 executePlan의 실행 기록이다.
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
const planExecSvc = bundle('plan-execute.ts', 'plan-execute-0049-test.cjs');

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

const TEAM_STEPS = [
  { index: 0, personaId: 'keeper', clause: '메모 요약', expectedOutcome: '요약', verify: { kind: 'min_length', min: 2 }, needsApproval: false },
  { index: 1, personaId: 'builder', clause: '초안 작성', expectedOutcome: '초안', verify: { kind: 'min_length', min: 2 }, needsApproval: false },
  { index: 2, personaId: 'scheduler', clause: '일정 등록', expectedOutcome: '일정', verify: { kind: 'min_length', min: 2 }, needsApproval: false },
];

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

  test('run 생성 → 체크포인트 저장 → 기록 상태 일치 (current_step·체크포인트 행)', async () => {
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
    const cp = db.prepare(`SELECT * FROM agent_run_checkpoints WHERE run_id = ?`).get(runId);
    expect(cp.step_index).toBe(0);
    expect(JSON.parse(cp.state_json)).toEqual({ results: ['요약완료'] });
  });

  test('executePlan 종단 — 전 단계 성공 시 completed + 체크포인트 3개 기록', async () => {
    const env = { DB: d1 };
    const seen = [];
    const result = await planExecSvc.executePlan(
      {
        env,
        runMeta: { conversationId: 4, userText: '복합 요청' },
        runStep: async (step) => {
          seen.push(step.personaId);
          return `${step.clause}-done`;
        },
      },
      TEAM_STEPS,
    );
    expect(result.stoppedEarly).toBe(false);
    expect(result.progress).toEqual({ total: 3, completed: 3, skipped: 0, failed: 0, done: true });
    expect(seen).toEqual(['keeper', 'builder', 'scheduler']);
    expect(result.runId).toBeTruthy();
    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(result.runId);
    expect(row.status).toBe('completed');
    expect(row.current_step).toBe(3);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM agent_run_checkpoints WHERE run_id = ?`).get(result.runId).n,
    ).toBe(3);
    const last = db.prepare(
      `SELECT state_json FROM agent_run_checkpoints WHERE run_id = ? ORDER BY step_index DESC LIMIT 1`,
    ).get(result.runId);
    expect(JSON.parse(last.state_json).results.map((r) => r.status)).toEqual([
      'completed', 'completed', 'completed',
    ]);
  });

  test('executePlan 실패 — 재시도 소진 시 중단, failed 기록 + 완료 단계 체크포인트만', async () => {
    const env = { DB: d1 };
    let builderCalls = 0;
    const result = await planExecSvc.executePlan(
      {
        env,
        runMeta: { conversationId: 5, userText: '실패 테스트' },
        runStep: async (step) => {
          if (step.personaId === 'builder') {
            builderCalls += 1;
            throw new Error('모델 호출 실패');
          }
          return `${step.clause}-done`;
        },
      },
      TEAM_STEPS,
    );
    expect(result.stoppedEarly).toBe(true);
    expect(builderCalls).toBe(planExecSvc.MAX_STEP_ATTEMPTS); // 최초 1회 + 재시도
    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(result.runId);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('모델 호출 실패');
    // 완료된 1단계 체크포인트만 남고, scheduler 단계는 실행되지 않았다
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM agent_run_checkpoints WHERE run_id = ?`).get(result.runId).n,
    ).toBe(1);
    expect(result.participants).toEqual(['keeper']);
  });

  test('체크포인트 CHECK 제약 — 음수 step_index 거부', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO agent_run_checkpoints (run_id, step_index, step_name, persona, state_json) VALUES ('run_x', -1, 'a', 'echo', '{}')`
      ).run();
    }).toThrow();
  });

  test('agent_handoffs CHECK 제약 — from/to 같으면 DB 레벨에서도 거부', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO agent_handoffs (from_persona, to_persona, request) VALUES ('echo', 'echo', 'r')`
      ).run();
    }).toThrow();
  });
});
