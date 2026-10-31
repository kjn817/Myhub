/**
 * Plan & Execute 루프(f트랙) — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0027→0028→0029→0044→0049를
 * 순서대로 적용하고, esbuild로 컴파일한 실제 src/services/agent-team.ts를
 * 호출한다.
 * - 성공 경로: run 생성 → 단계별 체크포인트 → completed 상태가 DB에 남음
 * - 실패 경로: 재시도 2회 소진 후 중단, run은 failed, 실패 단계 체크포인트 없음
 * - 재시도 후 성공: attempts가 체크포인트 state에 남음
 *
 * 실행: npx jest tests/integration/agent-team-plan-execute-real.test.js
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

const teamSvc = bundle('agent-team.ts', 'agent-team-plan-execute-test.cjs');

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

const MESSAGES = [{ role: 'user', content: '메모 요약해줘 그리고 내일 일정 알려줘' }];
const REQUEST = '메모 요약해줘 그리고 내일 일정 알려줘';

describe('Plan & Execute — 0049 기록 연동 (실제 SQLite)', () => {
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

  test('성공 경로 — run 생성·단계별 체크포인트·completed 상태가 DB에 남음', async () => {
    const env = { DB: d1 };
    const deps = {
      env,
      callAssistant: async (personaId) =>
        ({ text: personaId === 'keeper' ? '에코 요약 답변입니다' : '캘리 일정 답변입니다' }),
    };
    const plan = await teamSvc.planTeam(REQUEST);
    expect(plan.needsTeam).toBe(true);
    const result = await teamSvc.runTeam(deps, plan, MESSAGES, 7);

    expect(result.runId).toBeTruthy();
    expect(result.progress).toEqual({ total: 2, completed: 2, skipped: 0, failed: 0, done: true });
    expect(result.stoppedEarly).toBe(false);

    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(result.runId);
    expect(row.status).toBe('completed');
    expect(row.total_steps).toBe(2);
    expect(row.current_step).toBe(2);
    expect(row.conversation_id).toBe(7);

    const cps = db
      .prepare(`SELECT * FROM agent_run_checkpoints WHERE run_id = ? ORDER BY step_index`)
      .all(result.runId);
    expect(cps).toHaveLength(2);
    expect(cps[0].step_name).toBe('step-0-keeper');
    expect(cps[0].persona).toBe('keeper');
    expect(cps[1].step_name).toBe('step-1-scheduler');
    const lastState = JSON.parse(cps[1].state_json);
    expect(lastState.results.map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(lastState.results.map((r) => r.attempts)).toEqual([1, 1]);
    expect(lastState.results[0].text).toContain('에코 요약 답변입니다');
    expect(lastState.results[1].text).toContain('캘리 일정 답변입니다');
  });

  test('실패 경로 — 3회 시도 후 중단, run은 failed, 실패 단계 체크포인트 없음', async () => {
    const calls = [];
    const deps = {
      env: { DB: d1 },
      callAssistant: async (personaId) => {
        calls.push(personaId);
        if (personaId === 'keeper') throw new Error('model down');
        return { text: '캘리 일정 답변입니다' };
      },
    };
    const plan = await teamSvc.planTeam(REQUEST);
    const result = await teamSvc.runTeam(deps, plan, MESSAGES, 8);

    expect(calls).toEqual(['keeper', 'keeper', 'keeper']); // 최초 1회 + 재시도 2회, scheduler 미호출
    expect(result.stoppedEarly).toBe(true);
    expect(result.progress).toEqual({ total: 2, completed: 0, skipped: 0, failed: 1, done: true });
    expect(result.text).toContain('계획 2개 중 0개 완료');
    expect(result.text).toContain('3회 시도 후에도 실패했습니다');
    expect(result.text).toContain('남은 1개 단계는 실행하지 않았습니다');

    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(result.runId);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('step 0');
    expect(row.error).toContain('model down');
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_run_checkpoints WHERE run_id = ?`)
      .get(result.runId).n;
    expect(n).toBe(0); // 실패한 단계는 체크포인트를 남기지 않음 (재개 시 해당 단계부터)
  });

  test('재시도 후 성공 — attempts가 체크포인트 state에 남고 run은 completed', async () => {
    let keeperCalls = 0;
    const deps = {
      env: { DB: d1 },
      callAssistant: async (personaId) => {
        if (personaId === 'keeper') {
          keeperCalls++;
          if (keeperCalls === 1) throw new Error('transient');
          return { text: '에코 요약 답변입니다' };
        }
        return { text: '캘리 일정 답변입니다' };
      },
    };
    const plan = await teamSvc.planTeam(REQUEST);
    const result = await teamSvc.runTeam(deps, plan, MESSAGES, 9);

    expect(result.progress.completed).toBe(2);
    expect(result.stepResults[0].attempts).toBe(2);
    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(result.runId);
    expect(row.status).toBe('completed');
    const cps = db
      .prepare(`SELECT * FROM agent_run_checkpoints WHERE run_id = ? ORDER BY step_index`)
      .all(result.runId);
    expect(cps).toHaveLength(2);
    const firstState = JSON.parse(cps[0].state_json);
    expect(firstState.results[0]).toMatchObject({ status: 'completed', attempts: 2 });
  });

  test('승인 스킵 — 스킵 단계도 체크포인트에 남고 run은 completed', async () => {
    const deps = {
      env: { DB: d1 },
      callAssistant: async () => ({ text: '캘리 일정 답변입니다' }),
    };
    const plan = await teamSvc.planTeam('메모 123 삭제해줘 그리고 내일 일정 알려줘');
    expect(plan.needsTeam).toBe(true);
    const result = await teamSvc.runTeam(deps, plan, MESSAGES, 10);

    expect(result.progress).toEqual({ total: 2, completed: 1, skipped: 1, failed: 0, done: true });
    expect(result.stoppedEarly).toBe(false);
    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(result.runId);
    expect(row.status).toBe('completed');
    const cps = db
      .prepare(`SELECT * FROM agent_run_checkpoints WHERE run_id = ? ORDER BY step_index`)
      .all(result.runId);
    expect(cps).toHaveLength(2);
    const lastState = JSON.parse(cps[1].state_json);
    expect(lastState.results.map((r) => r.status)).toEqual(['skipped', 'completed']);
  });
});
