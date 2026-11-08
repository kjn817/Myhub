/**
 * Phase 1F 테스트 — 실행 로그 및 사용량 (F01-F20)
 * @jest-environment node
 */

const { execSync } = require('child_process');

// 번들 생성
try {
  execSync('npx esbuild src/ai/run-logger.ts --bundle --format=cjs --platform=node --outfile=/tmp/run-logger-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/runner.ts --bundle --format=cjs --platform=node --outfile=/tmp/runner-f-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/tools/registry.ts --bundle --format=cjs --platform=node --outfile=/tmp/registry-f-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/tools/search-memo.ts --bundle --format=cjs --platform=node --outfile=/tmp/search-memo-f-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const { D1RunLogger, NoopLogger, generateRunId } = require('/tmp/run-logger-test.cjs');
const { AgentRunner, DEFAULT_BUDGET } = require('/tmp/runner-f-test.cjs');
const { ToolRegistry } = require('/tmp/registry-f-test.cjs');
const { SearchMemoDefinition, SearchMemoInputSchema } = require('/tmp/search-memo-f-test.cjs');
const { createLocalD1 } = require('./tests/helpers/local-d1.cjs');

function applyLogMigrations(d1) {
  d1.exec(`
    CREATE TABLE IF NOT EXISTS ai_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      model_calls INTEGER DEFAULT 0,
      requested_tool_calls INTEGER DEFAULT 0,
      executed_tool_calls INTEGER DEFAULT 0,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      usage_source TEXT,
      elapsed_ms INTEGER,
      error_code TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      capability TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      outcome TEXT NOT NULL,
      run_id TEXT,
      call_index INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_tool_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      error_code TEXT,
      cache_hit INTEGER DEFAULT 0,
      operation_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(run_id, tool_call_id)
    );
  `);
}

function createMockSession(responses) {
  let idx = 0;
  return {
    provider: 'mock', modelId: 'mock-model',
    async next() {
      if (idx >= responses.length) throw new Error('No more responses');
      return responses[idx++];
    },
    appendToolResults() {},
  };
}

function createRegistry() {
  const r = new ToolRegistry();
  r.register(SearchMemoDefinition, SearchMemoInputSchema, async () => ({ matches: [] }));
  return r;
}

const ctx = { userId: 'user1', requestId: 'req-1', approvedWrites: false };

describe('Phase 1F: 실행 로그', () => {
  let d1, logger;

  beforeEach(() => {
    d1 = createLocalD1();
    applyLogMigrations(d1);
    logger = new D1RunLogger({ db: d1 });
  });

  afterEach(() => d1.close());

  // F01: 정상 Run 시작 기록
  test('F01: Run 시작 기록', async () => {
    const runId = generateRunId();
    await logger.onRunStart({ runId, requestId: 'req-1', userId: 'user1', provider: 'mock', model: 'test' });
    const row = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(row).not.toBeNull();
    expect(row.status).toBe('running');
    expect(row.user_id).toBe('user1');
  });

  // F02: 도구 없는 단일 모델 호출
  test('F02: Runner와 Logger 통합 (도구 없음)', async () => {
    const session = createMockSession([
      { text: '안녕', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, source: 'provider' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });
    expect(result.status).toBe('completed');

    // ai_runs에 기록됨
    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.status).toBe('completed');
    expect(run.model_calls).toBe(1);

    // ai_usage에 기록됨
    const usage = await d1.prepare('SELECT * FROM ai_usage').all();
    expect(usage.results.length).toBe(1);
    expect(usage.results[0].input_tokens).toBe(10);
  });

  // F03: 3회 모델 호출 사용량 집계
  test('F03: 3회 호출 사용량 합산', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 20, source: 'provider' } },
      { text: null, toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { inputTokens: 150, outputTokens: 30, source: 'provider' } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 200, outputTokens: 40, source: 'provider' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });
    expect(result.totalInputTokens).toBe(450);
    expect(result.totalOutputTokens).toBe(90);

    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.total_input_tokens).toBe(450);
    expect(run.model_calls).toBe(3);
  });

  // F04: 단일 도구 실행 기록
  test('F04: 도구 실행 로그', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });

    const tools = await d1.prepare('SELECT * FROM ai_tool_runs WHERE run_id = ?').bind(runId).all();
    expect(tools.results.length).toBe(1);
    expect(tools.results[0].tool_name).toBe('search_memo');
    expect(tools.results[0].status).toBe('success');
  });

  // F06: requested vs executed 구분
  test('F06: 요청 5개, 실행 4개 기록', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [1,2,3,4,5].map(i => ({ id: `c${i}`, name: 'search_memo', args: { query: `q${i}` }, provider: 'mock' })),
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });
    expect(result.requestedToolCalls).toBe(5);
    expect(result.executedToolCalls).toBe(4);

    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.requested_tool_calls).toBe(5);
    expect(run.executed_tool_calls).toBe(4);
  });

  // F07: 읽기 캐시 히트 기록
  test('F07: 캐시 히트 로그', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'same' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: null, toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'same' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });

    const tools = await d1.prepare("SELECT * FROM ai_tool_runs WHERE run_id = ? ORDER BY tool_call_id").bind(runId).all();
    expect(tools.results.length).toBe(2);
    expect(tools.results[1].cache_hit).toBe(1);
    expect(tools.results[1].status).toBe('cached');
  });

  // F09: usage 없는 경우 추정값
  test('F09: usage 없음 → estimated 기록', async () => {
    const session = createMockSession([
      { text: '답변', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    session.estimateInputTokens = () => 300;
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: [],
      requestId: 'req-1', logger, runId,
    });
    expect(result.usageSource).toBe('estimated');

    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.usage_source).toBe('estimated');
  });

  // F11: Provider 429 기록
  test('F11: 429 오류 로그', async () => {
    const session = {
      provider: 'mock', modelId: 'test',
      async next() { throw { code: 'RATE_LIMITED', provider: 'mock', message: 'Rate limited' }; },
      appendToolResults() {},
    };
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: [],
      requestId: 'req-1', logger, runId,
    });
    expect(result.status).toBe('provider_error');

    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.status).toBe('provider_error');
    expect(run.error_code).toBe('RATE_LIMITED');
  });

  // F13: Run 취소 기록
  test('F13: 취소 로그', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = createMockSession([
      { text: '답변', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: [],
      requestId: 'req-1', logger, runId, abortSignal: controller.signal,
    });
    expect(result.status).toBe('cancelled');

    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.status).toBe('cancelled');
  });

  // F15: 중복 로그 방지 (UNIQUE)
  test('F15: 동일 run_id 중복 INSERT 방지', async () => {
    const runId = generateRunId();
    await logger.onRunStart({ runId, requestId: 'req-1', userId: 'user1', provider: 'mock', model: 'test' });
    // 두 번째 시작은 UNIQUE 위반으로 무시됨 (에러 없이)
    await logger.onRunStart({ runId, requestId: 'req-1', userId: 'user1', provider: 'mock', model: 'test' });

    const rows = await d1.prepare('SELECT COUNT(*) as c FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(rows.c).toBe(1);
  });

  // F16: userId별 로그 격리
  test('F16: 사용자별 로그 조회', async () => {
    const runId1 = generateRunId();
    const runId2 = generateRunId();
    await logger.onRunStart({ runId: runId1, requestId: 'r1', userId: 'user1', provider: 'mock', model: 'test' });
    await logger.onRunStart({ runId: runId2, requestId: 'r2', userId: 'user2', provider: 'mock', model: 'test' });

    const u1 = await d1.prepare('SELECT * FROM ai_runs WHERE user_id = ?').bind('user1').all();
    expect(u1.results.length).toBe(1);
    expect(u1.results[0].run_id).toBe(runId1);
  });

  // F17: 민감 정보 미기록 (로그에 인자 원문 없음)
  test('F17: 도구 로그에 인자 원문 없음', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: '민감한 검색어' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });

    const tools = await d1.prepare('SELECT * FROM ai_tool_runs WHERE run_id = ?').bind(runId).all();
    const logStr = JSON.stringify(tools.results[0]);
    expect(logStr).not.toContain('민감한 검색어');
  });

  // F18: 로그 실패 시 업무 결과 유지
  test('F18: Logger 실패해도 Runner 결과 정상', async () => {
    const failingLogger = {
      async onRunStart() { throw new Error('DB down'); },
      async onModelCall() { throw new Error('DB down'); },
      async onToolCall() { throw new Error('DB down'); },
      async onRunFinish() { throw new Error('DB down'); },
    };
    const session = createMockSession([
      { text: '답변', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: [],
      requestId: 'req-1', logger: failingLogger,
    });
    // 로그 실패해도 실행 결과는 정상
    expect(result.status).toBe('completed');
    expect(result.text).toBe('답변');
  });

  // F20: Runner 집계와 로그 일치
  test('F20: 집계 일치', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { inputTokens: 50, outputTokens: 10, source: 'provider' } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 60, outputTokens: 15, source: 'provider' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });

    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.model_calls).toBe(result.modelCalls);
    expect(run.total_input_tokens).toBe(result.totalInputTokens);
    expect(run.total_output_tokens).toBe(result.totalOutputTokens);
    expect(run.executed_tool_calls).toBe(result.executedToolCalls);
  });

  // F05: 복수 도구 실행 로그
  test('F05: 복수 도구 로그', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [
          { id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' },
          { id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' },
        ],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });
    const tools = await d1.prepare('SELECT * FROM ai_tool_runs WHERE run_id = ?').bind(runId).all();
    expect(tools.results.length).toBe(2);
  });

  // F08: Provider usage 실제값 기록
  test('F08: Provider 실제 usage 기록', async () => {
    const session = createMockSession([
      { text: '답변', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 123, outputTokens: 45, source: 'provider' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: [],
      requestId: 'req-1', logger, runId,
    });
    const usage = await d1.prepare('SELECT * FROM ai_usage WHERE run_id = ?').bind(runId).all();
    expect(usage.results.length).toBe(1);
    expect(usage.results[0].input_tokens).toBe(123);
    expect(usage.results[0].output_tokens).toBe(45);
    expect(usage.results[0].capability).toBe('function_calling');
  });

  // F10: 실제값과 추정값 혼합
  test('F10: 혼합 usage → mixed', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 20, source: 'provider' } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    session.estimateInputTokens = () => 200;
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });
    expect(result.usageSource).toBe('mixed');
    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.usage_source).toBe('mixed');
  });

  // F12: 도구 오류 기록
  test('F12: 도구 오류 로그', async () => {
    const registry = new ToolRegistry();
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, async () => {
      throw new Error('D1 failed');
    });
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    await runner.run({
      session, registry, ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });
    const tools = await d1.prepare("SELECT * FROM ai_tool_runs WHERE run_id = ?").bind(runId).all();
    expect(tools.results[0].status).toBe('error');
    expect(tools.results[0].error_code).toBe('DB_ERROR');
  });

  // F14: 예산 초과 종료 기록
  test('F14: 예산 초과 로그', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: null, toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: null, toolCalls: [{ id: 'c3', name: 'search_memo', args: { query: 'c' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const runId = generateRunId();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1 },
      budget: { ...DEFAULT_BUDGET }, allowedTools: ['search_memo'],
      requestId: 'req-1', logger, runId,
    });
    expect(result.status).toBe('budget_exceeded');
    const run = await d1.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first();
    expect(run.status).toBe('budget_exceeded');
  });

  // F19: 원장과 관측 로그 분리
  test('F19: ai_tool_runs 실패해도 업무 영향 없음', async () => {
    // ai_tool_runs 테이블이 없어도 실행은 정상
    const d1NoLog = createLocalD1();
    d1NoLog.exec(`CREATE TABLE ai_runs (run_id TEXT UNIQUE, request_id TEXT, user_id TEXT, provider TEXT, model TEXT, status TEXT DEFAULT 'running', created_at TEXT);`);
    d1NoLog.exec(`CREATE TABLE ai_usage (id INTEGER PRIMARY KEY, provider TEXT, model TEXT, capability TEXT, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, outcome TEXT, created_at TEXT);`);
    // ai_tool_runs 테이블 없음
    const noLogLogger = new D1RunLogger({ db: d1NoLog });
    const session = createMockSession([
      { text: '답변', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run({
      session, registry: createRegistry(), ctx, env: { DB: d1NoLog },
      budget: { ...DEFAULT_BUDGET }, allowedTools: [],
      requestId: 'req-1', logger: noLogLogger,
    });
    expect(result.status).toBe('completed');
    d1NoLog.close();
  });
});
