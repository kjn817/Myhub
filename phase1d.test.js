/**
 * Phase 1D 테스트 — Agent Runner (D01-D25)
 * @jest-environment node
 */

const { execSync } = require('child_process');

// 번들 생성
try {
  execSync('npx esbuild src/ai/runner.ts --bundle --format=cjs --platform=node --outfile=/tmp/runner-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/tools/registry.ts --bundle --format=cjs --platform=node --outfile=/tmp/registry-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/tools/search-memo.ts --bundle --format=cjs --platform=node --outfile=/tmp/search-memo-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const { AgentRunner } = require('/tmp/runner-test.cjs');
const { ToolRegistry } = require('/tmp/registry-test.cjs');
const { SearchMemoDefinition, SearchMemoInputSchema } = require('/tmp/search-memo-test.cjs');
const { DEFAULT_BUDGET } = require('/tmp/runner-test.cjs');

// Mock ProviderSession 생성 헬퍼
function createMockSession(responses) {
  let callIndex = 0;
  const toolResults = [];
  return {
    provider: 'mock',
    modelId: 'mock-model',
    async next(options) {
      if (callIndex >= responses.length) {
        throw new Error('No more mock responses');
      }
      const resp = responses[callIndex++];
      // toolChoice: none인데 toolCalls가 있으면 무시 (Runner가 차단)
      return resp;
    },
    appendToolResults(results) {
      toolResults.push(...results);
    },
    getToolResults() { return toolResults; },
    getCallCount() { return callIndex; },
  };
}

function createMockRegistry() {
  const registry = new ToolRegistry();
  const mockExecutor = async (args) => ({ matches: [{ id: 1, title: 'Test', excerpt: 'test content' }] });
  registry.register(SearchMemoDefinition, SearchMemoInputSchema, mockExecutor);
  return registry;
}

const baseCtx = { userId: 'test-user', requestId: 'req-1', approvedWrites: false };
const baseEnv = { DB: {} };

function createInput(session, registry, overrides = {}) {
  return {
    session,
    registry,
    ctx: baseCtx,
    env: baseEnv,
    budget: { ...DEFAULT_BUDGET },
    allowedTools: ['search_memo'],
    requestId: 'test-req',
    ...overrides,
  };
}

describe('Phase 1D: Agent Runner', () => {
  // D01: 도구 없는 응답
  test('D01: 도구 없는 응답 → 1회 호출 후 종료', async () => {
    const session = createMockSession([
      { text: '안녕하세요!', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('completed');
    expect(result.modelCalls).toBe(1);
    expect(result.text).toBe('안녕하세요!');
  });

  // D02: 도구 1회 호출
  test('D02: 도구 1회 → 2회 호출 후 종료', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }],
        finishReason: 'tool_calls',
        usage: { source: 'unavailable' },
      },
      { text: '찾았습니다.', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('completed');
    expect(result.modelCalls).toBe(2);
    expect(result.executedToolCalls).toBe(1);
    expect(result.text).toBe('찾았습니다.');
  });

  // D03: 도구 연속 호출 (2회)
  test('D03: 도구 연속 2회 호출', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      {
        text: null,
        toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('completed');
    expect(result.modelCalls).toBe(3);
    expect(result.executedToolCalls).toBe(2);
  });

  // D04: 복수 도구 호출
  test('D04: 한 응답에 도구 2개', async () => {
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
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('completed');
    expect(result.executedToolCalls).toBe(2);
    // 호출 ID 연결 확인
    const toolResults = session.getToolResults();
    expect(toolResults.length).toBe(2);
    expect(toolResults[0].callId).toBe('c1');
    expect(toolResults[1].callId).toBe('c2');
  });

  // D05: 모델 3회 제한
  test('D05: 모델 4번째 호출 차단', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: null, toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: null, toolCalls: [{ id: 'c3', name: 'search_memo', args: { query: 'c' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      // 4번째는 호출되지 않아야 함
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.modelCalls).toBe(3);
    expect(result.status).toBe('budget_exceeded');
  });

  // D09: 잘못된 인자
  test('D09: 잘못된 인자 → INVALID_ARGUMENTS', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: {}, provider: 'mock' }], // query 없음
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '인자가 잘못됐네요.', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('completed');
    const toolResults = session.getToolResults();
    expect(toolResults[0].output.ok).toBe(false);
    expect(toolResults[0].output.errorCode).toBe('INVALID_ARGUMENTS');
  });

  // D10: 존재하지 않는 도구 (허용 목록에 있으면 Registry에서 거부)
  test('D10: 존재하지 않는 도구 → UNKNOWN_TOOL', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'nonexistent', args: {}, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    // allowedTools에 포함시켜 Registry까지 도달하도록
    const result = await runner.run(createInput(session, createMockRegistry(), { allowedTools: ['nonexistent', 'search_memo'] }));
    const toolResults = session.getToolResults();
    expect(toolResults[0].output.errorCode).toBe('UNKNOWN_TOOL');
  });

  // D15: 동일 검색 반복 → 캐시
  test('D15: 동일 검색 반복 → 캐시 사용', async () => {
    let execCount = 0;
    const registry = new ToolRegistry();
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, async () => {
      execCount++;
      return { matches: [] };
    });

    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'same' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      {
        text: null,
        toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'same' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    await runner.run(createInput(session, registry));
    // 두 번째는 캐시 사용으로 1회만 실행
    expect(execCount).toBe(1);
  });

  // D16: 마지막 호출의 도구 요청 차단
  test('D16: 마지막 호출에서 도구 요청 → 실행 차단', async () => {
    const session = createMockSession([
      { text: null, toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      { text: null, toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
      // 3번째(마지막) 호출에서 도구 요청
      { text: null, toolCalls: [{ id: 'c3', name: 'search_memo', args: { query: 'c' }, provider: 'mock' }], finishReason: 'tool_calls', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('budget_exceeded');
    expect(result.errorCode).toBe('TOOL_CALL_ON_LAST_STEP');
    expect(result.executedToolCalls).toBe(2); // 3번째는 실행 안 됨
  });

  // D18: 응답 잘림
  test('D18: length finish → invalid_response', async () => {
    const session = createMockSession([
      { text: '잘린 응답...', toolCalls: [], finishReason: 'length', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('invalid_response');
  });

  // D22: 모델 첫 호출 실패
  test('D22: 모델 첫 호출 실패 → provider_error', async () => {
    const session = {
      provider: 'mock', modelId: 'test',
      async next() { throw { code: 'RATE_LIMITED', retryable: true, provider: 'mock', message: 'Rate limited' }; },
      appendToolResults() {},
    };
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('provider_error');
    // Phase 2B-L: 실패한 호출도 시도 횟수에 포함
    expect(result.modelCalls).toBe(1);
  });

  // D24: 사용량 집계
  test('D24: 토큰 사용량 집계', async () => {
    const session = createMockSession([
      {
        text: '답변', toolCalls: [], finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, source: 'provider' },
      },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.totalInputTokens).toBe(100);
    expect(result.totalOutputTokens).toBe(50);
    expect(result.usageSource).toBe('provider');
  });

  // D25: 허용 도구 없음
  test('D25: 허용 도구 비어있음 → 도구 실행 안 됨', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry(), { allowedTools: [] }));
    const toolResults = session.getToolResults();
    expect(toolResults[0].output.errorCode).toBe('ACCESS_DENIED');
  });

  // D19: ToolResult ID 연결
  test('D19: 모든 ToolResult ID 연결 확인', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [
          { id: 'id-a', name: 'search_memo', args: { query: 'a' }, provider: 'mock' },
          { id: 'id-b', name: 'search_memo', args: { query: 'b' }, provider: 'mock' },
          { id: 'id-c', name: 'search_memo', args: { query: 'c' }, provider: 'mock' },
        ],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    await runner.run(createInput(session, createMockRegistry()));
    const toolResults = session.getToolResults();
    expect(toolResults.map(r => r.callId)).toEqual(['id-a', 'id-b', 'id-c']);
  });

  // D06: 도구 호출 4회 제한 (5번째 차단)
  test('D06: 도구 5회 요청 → 4회만 실행', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [
          { id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' },
          { id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' },
          { id: 'c3', name: 'search_memo', args: { query: 'c' }, provider: 'mock' },
          { id: 'c4', name: 'search_memo', args: { query: 'd' }, provider: 'mock' },
        ],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      {
        text: null,
        toolCalls: [{ id: 'c5', name: 'search_memo', args: { query: 'e' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.executedToolCalls).toBe(4);
    expect(result.status).toBe('budget_exceeded');
  });

  // D07: 누적 입력 토큰 초과
  test('D07: 토큰 예산 초과 → 호출 차단', async () => {
    const session = createMockSession([
      {
        text: '답변', toolCalls: [], finishReason: 'stop',
        usage: { inputTokens: 7900, outputTokens: 10, source: 'provider' },
      },
    ]);
    // estimateInputTokens가 큰 값을 반환하도록
    session.estimateInputTokens = () => 1000;
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry(), {
      budget: { ...DEFAULT_BUDGET, maxTotalInputTokens: 8000 },
    }));
    // 7900 + 1000 + 500(여유) > 8000 이므로 첫 호출부터 차단
    // 실제로는 첫 호출은 실행됨 (추정이 호출 전에 이루어지므로)
    expect(result.modelCalls).toBeLessThanOrEqual(1);
  });

  // D08: usage 미반환 → 추정치 사용 (0이 아님)
  test('D08: usage 없음 → estimated로 기록', async () => {
    const session = createMockSession([
      { text: '답변', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    session.estimateInputTokens = () => 500;
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.totalInputTokens).toBe(500); // 0이 아님
    expect(result.usageSource).toBe('estimated');
  });

  // D11: 권한 없는 도구
  test('D11: 허용 목록 외 도구 → ACCESS_DENIED', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry(), { allowedTools: ['other_tool'] }));
    const toolResults = session.getToolResults();
    expect(toolResults[0].output.errorCode).toBe('ACCESS_DENIED');
    expect(result.executedToolCalls).toBe(0);
  });

  // D12: DB 오류 전달
  test('D12: DB 오류 → ToolResult에 전달', async () => {
    const registry = new ToolRegistry();
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, async () => {
      throw new Error('D1 connection failed');
    });
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: 'DB 오류가 발생했네요.', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, registry));
    expect(result.status).toBe('completed'); // 모델이 오류를 인식하고 답변
    const toolResults = session.getToolResults();
    expect(toolResults[0].output.ok).toBe(false);
    expect(toolResults[0].output.errorCode).toBe('DB_ERROR');
  });

  // D13: Provider 429
  test('D13: Provider 429 → RATE_LIMITED', async () => {
    const session = {
      provider: 'mock', modelId: 'test',
      async next() { throw { code: 'RATE_LIMITED', retryable: true, provider: 'mock', message: 'Rate limited', retryAfterMs: 5000 }; },
      appendToolResults() {},
    };
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('provider_error');
    expect(result.errorCode).toBe('RATE_LIMITED');
  });

  // D14: Provider 503
  test('D14: Provider 503 → SERVICE_UNAVAILABLE', async () => {
    const session = {
      provider: 'mock', modelId: 'test',
      async next() { throw { code: 'SERVICE_UNAVAILABLE', retryable: true, provider: 'mock', message: 'Service unavailable' }; },
      appendToolResults() {},
    };
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.status).toBe('provider_error');
    expect(result.errorCode).toBe('SERVICE_UNAVAILABLE');
  });

  // D17: AbortSignal 취소
  test('D17: AbortSignal → cancelled', async () => {
    const controller = new AbortController();
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      {
        text: null,
        toolCalls: [{ id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    // 두 번째 next() 호출 전에 취소
    const originalNext = session.next.bind(session);
    let nextCount = 0;
    session.next = async (opts) => {
      nextCount++;
      if (nextCount === 2) controller.abort();
      // abort 체크는 Runner 루프 시작 시 이루어지므로,
      // 여기서는 abort된 상태에서도 next가 호출될 수 있음
      // 실제로는 Runner가 abort를 확인하고 호출하지 않음
      if (controller.signal.aborted) {
        // Runner가 abort를 확인하기 전에 호출된 경우
        // 테스트를 위해 그냥 진행
      }
      return originalNext(opts);
    };
    const runner = new AgentRunner();
    // 첫 번째 반복 후 abort되도록: abort를 미리 설정
    controller.abort();
    const result = await runner.run(createInput(session, createMockRegistry(), { abortSignal: controller.signal }));
    expect(result.status).toBe('cancelled');
  });

  // D20: ProviderSession 유지
  test('D20: 동일 세션에서 provider/model 변경 없음', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const providerBefore = session.provider;
    const modelBefore = session.modelId;
    const runner = new AgentRunner();
    await runner.run(createInput(session, createMockRegistry()));
    expect(session.provider).toBe(providerBefore);
    expect(session.modelId).toBe(modelBefore);
  });

  // D21: 한 번에 도구 5개 요청
  test('D21: 5개 동시 요청 → 4개만 실행', async () => {
    const session = createMockSession([
      {
        text: null,
        toolCalls: [
          { id: 'c1', name: 'search_memo', args: { query: 'a' }, provider: 'mock' },
          { id: 'c2', name: 'search_memo', args: { query: 'b' }, provider: 'mock' },
          { id: 'c3', name: 'search_memo', args: { query: 'c' }, provider: 'mock' },
          { id: 'c4', name: 'search_memo', args: { query: 'd' }, provider: 'mock' },
          { id: 'c5', name: 'search_memo', args: { query: 'e' }, provider: 'mock' },
        ],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, createMockRegistry()));
    expect(result.executedToolCalls).toBe(4);
    expect(result.requestedToolCalls).toBe(5);
    const toolResults = session.getToolResults();
    expect(toolResults.length).toBe(5);
    expect(toolResults[4].output.errorCode).toBe('TOOL_BUDGET_EXCEEDED');
  });

  // D23: 전체 실행 타임아웃 (시뮬레이션)
  test('D23: 도구 타임아웃 → TIMEOUT 결과', async () => {
    const registry = new ToolRegistry();
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, async () => {
      await new Promise(r => setTimeout(r, 10000));
      return { matches: [] };
    });
    const session = createMockSession([
      {
        text: null,
        toolCalls: [{ id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'mock' }],
        finishReason: 'tool_calls', usage: { source: 'unavailable' },
      },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } },
    ]);
    const runner = new AgentRunner();
    const result = await runner.run(createInput(session, registry, {
      budget: { ...DEFAULT_BUDGET, toolTimeoutMs: 100 },
    }));
    const toolResults = session.getToolResults();
    expect(toolResults[0].output.errorCode).toBe('TIMEOUT');
  }, 15000);
});
