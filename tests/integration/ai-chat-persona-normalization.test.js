/**
 * /api/ai/chat personaId 정규화 회귀 테스트 (2026-10-30, promptfoo 게이트 회귀 1)
 *
 * 라이브 실측: personaId 'echo'(신규 ID)를 보내면 400 "unknown persona"였다.
 * PERSONAS·정책·권한은 레거시 ID(keeper 등) 기준인데 /chat 진입 경로가
 * 신규 ID를 정규화하지 않았다. 오케스트레이터 게이트·승인 가로채기·
 * processToolMarkers는 이미 normalizeLegacyPersonaId를 쓰고 있었다.
 *
 * 실제 SQLite + esbuild로 컴파일한 실제 routes.ts를 Hono app.request()로
 * 호출한다 (approval-chat-real.test.js와 같은 방식). 모델 키가 없는 환경이라
 * 정규화를 통과한 요청은 모델 호출 단계에서 502로 실패하는 것이 정상이다 —
 * 이 테스트의 단언은 "400 unknown persona가 아니다"와, 반대로 진짜로
 * 알 수 없는 ID는 여전히 400으로 거부된다(deny-by-default)는 것이다.
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const routesPath = path.join(__dirname, '../../src/modules/ai/routes.ts');
const jsPath = '/tmp/ai-routes-persona-normalization-test.cjs';
try {
  execSync(
    `npx esbuild ${routesPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`,
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message);
}
const { aiApp } = require(jsPath);

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

describe('/api/ai/chat personaId 정규화 (실제 SQLite + Hono)', () => {
  let db;
  let d1;
  let app;
  const env = () => ({ DB: d1 });

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    applyMigration(db, '0001_init.sql');
    applyMigration(db, '0008_ai_chats.sql');
    applyMigration(db, '0009_ai_settings.sql');
    applyMigration(db, '0010_ai_conversations.sql');
    db.exec('CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    applyMigration(db, '0013_memo_lock.sql');
    applyMigration(db, '0025_prompt_version.sql');
    applyMigration(db, '0047_octop_teams_cron_approvals.sql');
    applyMigration(db, '0052_tool_approval_requests.sql');
    applyMigration(db, '0063_tool_approval_executed.sql');
    app = new Hono();
    app.route('/', aiApp);
  });

  afterAll(() => {
    db.close();
  });

  async function postChat(personaId, content = '안녕') {
    const res = await app.request(
      '/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId,
          messages: [{ role: 'user', content }],
        }),
      },
      env(),
    );
    return { status: res.status, body: await res.json() };
  }

  test("회귀 1: 신규 ID 'echo'는 unknown persona로 거부되지 않는다", async () => {
    const { status, body } = await postChat('echo', '오늘 한국 주요 뉴스 알려줘');
    expect(body.error).not.toBe('unknown persona');
    expect(status).not.toBe(400);
    // 키 없는 테스트 환경에서는 모델 호출 단계에서 실패한다 (정규화 통과 증거)
    expect(status).toBe(502);
  });

  test("신규 ID 'lumi'·'nova'·'cali'도 같은 방식으로 수용된다", async () => {
    for (const personaId of ['lumi', 'nova', 'cali']) {
      const { status, body } = await postChat(personaId);
      expect(body.error).not.toBe('unknown persona');
      expect(status).toBe(502);
    }
  });

  test('레거시 ID keeper는 기존과 동일하게 동작한다 (대조군)', async () => {
    const { status, body } = await postChat('keeper');
    expect(body.error).not.toBe('unknown persona');
    expect(status).toBe(502);
  });

  test('알 수 없는 ID는 여전히 400 unknown persona로 거부된다 (deny-by-default)', async () => {
    const { status, body } = await postChat('no-such-persona');
    expect(status).toBe(400);
    expect(body.error).toBe('unknown persona');
  });
});
