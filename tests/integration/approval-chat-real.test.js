/**
 * 채팅 승인 게이트 — 실제 SQLite + Hono 인프로세스 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 실제 마이그레이션을 적용하고, esbuild로 컴파일한
 * 실제 src/modules/ai/routes.ts를 Hono app.request()로 호출한다.
 * 모델 호출은 하지 않는다 — 승인 응답("승인해" 등)은 모델 호출 전에 가로채므로,
 * 대기 요청 생성은 processToolMarkers를 직접 호출해 만든다.
 *
 * 실행: npx jest tests/integration/approval-chat-real.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const routesPath = path.join(__dirname, '../../src/modules/ai/routes.ts');
const jsPath = '/tmp/ai-routes-approval-chat-real-test.cjs';
try {
  execSync(
    `npx esbuild ${routesPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`,
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message);
}
const { aiApp, processToolMarkers } = require(jsPath);

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

describe('채팅 승인 게이트 (실제 SQLite + Hono)', () => {
  let db;
  let d1;
  let app;
  const env = () => ({ DB: d1 });

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    applyMigration(db, '0001_init.sql');
    // 0004: memo_tags — 메모 삭제/생성 실행 경로(executeMemoDelete의
    // DELETE FROM memo_tags, syncTags)가 닿는 테이블. 없으면 실행이
    // SqliteError로 "삭제 실패/생성 실패"가 된다 (픽스처 부분집합 누락).
    applyMigration(db, '0004_memo_tags.sql');
    applyMigration(db, '0008_ai_chats.sql');
    applyMigration(db, '0009_ai_settings.sql');
    applyMigration(db, '0010_ai_conversations.sql');
    // 0013은 files 테이블도 건드리므로 최소 스텁을 먼저 만든다
    db.exec('CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    applyMigration(db, '0013_memo_lock.sql');
    // 0020: ai_tool_operations — 원장이 쓰기 실행과 함께 INSERT하는 멱등성
    // 원장 테이블. 없으면 recordToolExecution이 경고를 남긴다.
    applyMigration(db, '0020_ai_tool_operations.sql');
    // 0021: ai_runs/ai_tool_runs — 도구 실행 원장(tool-ledger)이 INSERT하는
    // 테이블. 이게 없으면 원장 기록이 SqliteError로 실패해 승인 실행 전체가
    // "생성 실패/삭제 실패"로 끝난다 (감사 B2 — 픽스처 마이그레이션 누락).
    applyMigration(db, '0021_ai_run_logs.sql');
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

  beforeEach(() => {
    db.exec('DELETE FROM tool_approval_requests');
    db.exec('DELETE FROM tool_approvals');
    db.exec('DELETE FROM ai_chats');
    db.exec('DELETE FROM memos');
    db.exec('DELETE FROM ai_conversations');
    db.prepare("INSERT INTO ai_conversations (id, title, created_at, updated_at) VALUES (1, '테스트 대화', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO memos (id, text, is_locked, sensitivity) VALUES (1, '삭제 대상 메모', 0, 0)").run();
    db.prepare("INSERT INTO memos (id, text, is_locked, sensitivity) VALUES (2, '보관 메모', 0, 0)").run();
  });

  async function postChat(content) {
    const res = await app.request(
      '/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: 'concierge',
          conversationId: 1,
          messages: [{ role: 'user', content }],
        }),
      },
      env(),
    );
    return { status: res.status, body: await res.json() };
  }

  function memoExists(id) {
    return !!db.prepare('SELECT 1 FROM memos WHERE id = ?').get(id);
  }

  function memoCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM memos').get().n;
  }

  function pendingCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM tool_approval_requests WHERE status = 'pending'").get().n;
  }

  test('파괴적 도구: 승인 없으면 실행 안 하고 대기 요청 생성', async () => {
    const result = await processToolMarkers(
      env(),
      { text: '[MEMO_DELETE]{"id":1}[/MEMO_DELETE]' },
      'concierge',
      { conversationId: 1, userRequest: '그 메모 삭제해줘' },
    );
    expect(result.text).toContain('승인이 필요해요');
    expect(result.text).toContain('메모 #1 삭제');
    expect(result.text).toContain('되돌릴 수 없어요');
    expect(result.text).toContain('그 메모 삭제해줘');
    expect(result.approvalRequests).toHaveLength(1);
    expect(result.approvalRequests[0].tool).toBe('MEMO_DELETE');
    expect(memoExists(1)).toBe(true);
    expect(pendingCount()).toBe(1);
    const row = db.prepare('SELECT * FROM tool_approval_requests').get();
    expect(row.marker_text).toBe('[MEMO_DELETE]{"id":1}[/MEMO_DELETE]');
    expect(row.status).toBe('pending');
  });

  test('승인 → 실행 + 감사 기록 (Hono /chat)', async () => {
    await processToolMarkers(
      env(),
      { text: '[MEMO_DELETE]{"id":1}[/MEMO_DELETE]' },
      'concierge',
      { conversationId: 1, userRequest: '그 메모 삭제해줘' },
    );
    const { status, body } = await postChat('승인해');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.approvalResolved).toBe('approved');
    expect(body.text).toContain('메모를 삭제했습니다');
    expect(memoExists(1)).toBe(false);
    expect(memoExists(2)).toBe(true);
    // 도구 실행 원장에 성공 기록이 실제로 남는다 (원장 INSERT 실패가
    // 실행 성공 판정을 뒤집던 결함의 회귀 방지)
    const ledgerRows = db.prepare("SELECT tool_name, status FROM ai_tool_runs WHERE status = 'success'").all();
    expect(ledgerRows.length).toBeGreaterThanOrEqual(1);
    expect(ledgerRows.some((r) => /MEMO/i.test(r.tool_name))).toBe(true);
    const audit = db.prepare("SELECT * FROM tool_approvals WHERE scope_key = 'MEMO_DELETE:1'").get();
    expect(audit.decision).toBe('approved');
    expect(db.prepare("SELECT status FROM tool_approval_requests").get().status).toBe('approved');
  });

  test('0063: 승인 실행 후 executed_at·execution_result가 행에 남는다', async () => {
    await processToolMarkers(
      env(),
      { text: '[MEMO_DELETE]{"id":1}[/MEMO_DELETE]' },
      'concierge',
      { conversationId: 1, userRequest: '그 메모 삭제해줘' },
    );
    const { status, body } = await postChat('승인해');
    expect(status).toBe(200);
    expect(body.approvalResolved).toBe('approved');
    expect(memoExists(1)).toBe(false);
    const row = db.prepare('SELECT executed_at, execution_result FROM tool_approval_requests').get();
    expect(row.executed_at).not.toBeNull();
    expect(row.execution_result).toContain('삭제');
  });

  test('거부 → 미실행 + 감사 기록 denied', async () => {
    await processToolMarkers(
      env(),
      { text: '[MEMO_DELETE]{"id":2}[/MEMO_DELETE]' },
      'concierge',
      { conversationId: 1, userRequest: '보관 메모 삭제해줘' },
    );
    const { status, body } = await postChat('거부해');
    expect(status).toBe(200);
    expect(body.approvalResolved).toBe('denied');
    // 번들 계약: 승인 응답 문구는 격식체 (ai/routes 원문)
    expect(body.text).toContain('알겠습니다. 실행하지 않았습니다.');
    expect(memoExists(2)).toBe(true);
    const audit = db.prepare("SELECT * FROM tool_approvals WHERE scope_key = 'MEMO_DELETE:2'").get();
    expect(audit.decision).toBe('denied');
  });

  test('쓰기 도구도 기본 승인 필요 → 세션 허용 후에는 재승인 없이 실행', async () => {
    // 1) MEMO_CREATE는 승인 없이 실행되지 않음
    const before = memoCount();
    const first = await processToolMarkers(
      env(),
      { text: '[MEMO_CREATE]{"text":"세션 허용 테스트"}[/MEMO_CREATE]' },
      'concierge',
      { conversationId: 1, userRequest: '메모 만들어줘' },
    );
    expect(first.text).toContain('승인이 필요해요');
    expect(memoCount()).toBe(before);

    // 2) "이 세션 허용해" → 실행 + 세션 허용 기록
    const { body } = await postChat('이 세션 허용해');
    expect(body.approvalResolved).toBe('approved_session');
    expect(body.text).toContain('이 세션 동안');
    expect(memoCount()).toBe(before + 1);
    const session = db.prepare("SELECT * FROM tool_approvals WHERE scope_key = 'SESSION:1:MEMO_CREATE'").get();
    expect(session.decision).toBe('approved');

    // 3) 같은 대화에서 같은 종류의 도구는 재승인 없이 즉시 실행
    const second = await processToolMarkers(
      env(),
      { text: '[MEMO_CREATE]{"text":"두 번째 메모"}[/MEMO_CREATE]' },
      'concierge',
      { conversationId: 1, userRequest: '메모 또 만들어줘' },
    );
    expect(second.text).toContain('메모를 생성했습니다');
    expect(second.approvalRequests).toBeUndefined();
    expect(memoCount()).toBe(before + 2);
  });

  test('타임아웃: 만료된 요청에 승인하면 미실행 + 만료 안내', async () => {
    await processToolMarkers(
      env(),
      { text: '[MEMO_DELETE]{"id":2}[/MEMO_DELETE]' },
      'concierge',
      { conversationId: 1, userRequest: '보관 메모 삭제해줘' },
    );
    db.prepare(
      "UPDATE tool_approval_requests SET expires_at = '2020-01-01T00:00:00Z' WHERE status = 'pending'",
    ).run();
    const { status, body } = await postChat('승인해');
    expect(status).toBe(200);
    expect(body.approvalResolved).toBe('expired');
    expect(body.text).toContain('승인 요청이 만료됐습니다 (10분 경과)');
    expect(memoExists(2)).toBe(true);
    expect(db.prepare("SELECT status FROM tool_approval_requests").get().status).toBe('expired');
  });

  test('대기 요청이 없을 때 "승인해"는 일반 채팅으로 흘러감 (승인 해결 아님)', async () => {
    const { status, body } = await postChat('승인해');
    // 모델 호출로 진행되므로 승인 해결 필드가 없고, 키가 없어 502로 실패한다
    expect(body.approvalResolved).toBeUndefined();
    expect(status).toBe(502);
  });
});
