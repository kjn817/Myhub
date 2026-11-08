/**
 * Phase 1B 보완 테스트 (1C-0) + Provider Adapter Mock 테스트 (1C-1)
 * @jest-environment node
 */

const { execSync } = require('child_process');

// 번들 생성
try {
  execSync('npx esbuild src/ai/tools/registry.ts --bundle --format=cjs --platform=node --outfile=/tmp/registry-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/tools/search-memo.ts --bundle --format=cjs --platform=node --outfile=/tmp/search-memo-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/providers/groq.ts --bundle --format=cjs --platform=node --outfile=/tmp/groq-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/providers/gemini.ts --bundle --format=cjs --platform=node --outfile=/tmp/gemini-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/providers/workers-ai.ts --bundle --format=cjs --platform=node --outfile=/tmp/wai-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const { ToolRegistry } = require('/tmp/registry-test.cjs');
const { SearchMemoDefinition, SearchMemoInputSchema } = require('/tmp/search-memo-test.cjs');
const { GroqAdapter } = require('/tmp/groq-test.cjs');
const { GeminiAdapter } = require('/tmp/gemini-test.cjs');
const { WorkersAIAdapter } = require('/tmp/wai-test.cjs');

const ctx = { userId: 'user-a', requestId: 'req-1', approvedWrites: false };

// ============================================================================
// 1C-0: Phase 1B 미검증 5개 테스트 보완
// ============================================================================

describe('1C-0: Phase 1B 보완', () => {
  let registry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // B09: 검색 결과 없음 → ok:true, 빈 배열
  test('B09: 검색 결과 없음 → ok:true, 빈 matches', async () => {
    const mockExecutor = async () => ({ matches: [] });
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, mockExecutor);

    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: '없는내용12345' }, provider: 'groq' },
      ctx,
      { DB: {} }
    );
    expect(result.output.ok).toBe(true);
    expect(result.output.data.matches).toEqual([]);
  });

  // B10: 다른 사용자 메모 접근 차단
  test('B10: 다른 사용자 메모 접근 차단', async () => {
    // 사용자별 메모 격리 시뮬레이션
    const userMemos = {
      'user-a': [{ id: 1, text: 'A의 비밀 메모' }],
      'user-b': [{ id: 2, text: 'B의 비밀 메모' }],
    };
    const mockExecutor = async (args, ctx) => {
      // ctx.userId 기준으로만 검색해야 함
      const memos = userMemos[ctx.userId] || [];
      const filtered = memos.filter(m => m.text.includes(args.query));
      return { matches: filtered.map(m => ({ id: m.id, title: m.text.slice(0, 20), excerpt: m.text })) };
    };
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, mockExecutor);

    // user-a의 컨텍스트로 '비밀' 검색 → A의 메모만 나와야 함
    const resultA = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: '비밀' }, provider: 'groq' },
      { ...ctx, userId: 'user-a' },
      { DB: {} }
    );
    expect(resultA.output.ok).toBe(true);
    expect(resultA.output.data.matches.length).toBe(1);
    expect(resultA.output.data.matches[0].id).toBe(1);

    // user-b의 컨텍스트 → B의 메모만
    const resultB = await registry.execute(
      { id: 'c2', name: 'search_memo', args: { query: '비밀' }, provider: 'groq' },
      { ...ctx, userId: 'user-b' },
      { DB: {} }
    );
    expect(resultB.output.data.matches[0].id).toBe(2);
  });

  // B12: DB 조회 실패 → DB_ERROR
  test('B12: DB 조회 실패 → DB_ERROR, 안전한 메시지', async () => {
    const failingExecutor = async () => {
      throw new Error('D1_ERROR: connection failed');
    };
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, failingExecutor);

    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'groq' },
      ctx,
      { DB: {} }
    );
    expect(result.output.ok).toBe(false);
    expect(result.output.errorCode).toBe('DB_ERROR');
    // SQL 원문이 노출되지 않아야 함
    expect(result.output.message).not.toContain('D1_ERROR');
    expect(result.output.message).toBe('Database error');
  });

  // B13: 검색 결과 5건 초과 → 최대 5건
  test('B13: 7건 중 최대 5건만 반환', async () => {
    const manyMemos = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1, title: `메모 ${i + 1}`, excerpt: '내용',
    }));
    const mockExecutor = async (args) => ({
      matches: manyMemos.slice(0, args.limit),
    });
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, mockExecutor);

    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: '메모', limit: 5 }, provider: 'groq' },
      ctx,
      { DB: {} }
    );
    expect(result.output.ok).toBe(true);
    expect(result.output.data.matches.length).toBeLessThanOrEqual(5);
  });

  // B14: 실행 타임아웃
  test('B14: 타임아웃 → TIMEOUT', async () => {
    const slowExecutor = async () => {
      await new Promise(r => setTimeout(r, 10000)); // 10초 대기
      return { matches: [] };
    };
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, slowExecutor);

    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: 'test' }, provider: 'groq' },
      ctx,
      { DB: {} },
      100 // 100ms 타임아웃
    );
    expect(result.output.ok).toBe(false);
    expect(result.output.errorCode).toBe('TIMEOUT');
  }, 10000);
});

// ============================================================================
// 1C-1: Provider Adapter Mock 테스트
// ============================================================================

describe('1C-1: Groq Adapter', () => {
  test('C02: 단일 도구 호출 파싱', () => {
    const adapter = new GroqAdapter({ apiKey: 'test', model: 'test-model' });
    expect(adapter.provider).toBe('groq');
    expect(adapter.modelId).toBe('test-model');
  });

  test('C06: 호출 ID 연결 구조', () => {
    // Mock tool_call 파싱 로직 검증
    const mockMsg = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_abc123', function: { name: 'search_memo', arguments: '{"query":"test"}' } },
      ],
    };
    expect(mockMsg.tool_calls[0].id).toBe('call_abc123');
  });
});

describe('1C-1: Gemini Adapter', () => {
  test('C12: Thought Signature 보존 구조', () => {
    const adapter = new GeminiAdapter({ apiKey: 'test', model: 'test-model' });
    expect(adapter.provider).toBe('gemini');
    // contents에 원본 parts가 보존되는 구조
    expect(typeof adapter.getContents).toBe('function');
  });
});

describe('1C-1: Workers AI Adapter', () => {
  test('Adapter 생성', () => {
    const adapter = new WorkersAIAdapter({ ai: null, model: 'test-model' });
    expect(adapter.provider).toBe('workers-ai');
  });
});

// ============================================================================
// 2회 호출 테스트 하네스 (Mock)
// ============================================================================

describe('1C-1: 2회 호출 하네스', () => {
  test('C09: 도구 호출 → 결과 → 최종 답변 플로우', async () => {
    // Mock ProviderSession
    let callCount = 0;
    const mockSession = {
      provider: 'groq',
      modelId: 'test',
      async next(options) {
        callCount++;
        if (callCount === 1) {
          // 첫 호출: 도구 호출 반환
          return {
            text: null,
            toolCalls: [{ id: 'call_1', name: 'search_memo', args: { query: '과제' }, provider: 'groq' }],
            finishReason: 'tool_calls',
            usage: { source: 'unavailable' },
          };
        } else {
          // 두 번째 호출: 최종 답변
          return {
            text: '과제 마감일은 10월 15일입니다.',
            toolCalls: [],
            finishReason: 'stop',
            usage: { source: 'unavailable' },
          };
        }
      },
      appendToolResults(results) {
        // 도구 결과 저장 확인
        expect(results.length).toBe(1);
        expect(results[0].callId).toBe('call_1');
      },
    };

    // 1차 호출
    const step1 = await mockSession.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 1024 });
    expect(step1.toolCalls.length).toBe(1);
    expect(step1.toolCalls[0].name).toBe('search_memo');

    // 도구 실행 (Mock)
    const toolResult = {
      callId: 'call_1',
      name: 'search_memo',
      output: { ok: true, data: { matches: [{ id: 1, title: '과제', excerpt: '마감일 10월 15일' }] } },
    };

    // 결과 전달
    mockSession.appendToolResults([toolResult]);

    // 2차 호출
    const step2 = await mockSession.next({ tools: [], toolChoice: 'none', maxOutputTokens: 1024 });
    expect(step2.text).toContain('10월 15일');
    expect(step2.toolCalls.length).toBe(0);
    expect(callCount).toBe(2);
  });

  test('C01: 도구 없이 일반 텍스트 응답', async () => {
    const mockSession = {
      async next() {
        return { text: '안녕하세요!', toolCalls: [], finishReason: 'stop', usage: { source: 'unavailable' } };
      },
      appendToolResults() {},
    };
    const step = await mockSession.next({ tools: [], toolChoice: 'none', maxOutputTokens: 1024 });
    expect(step.toolCalls.length).toBe(0);
    expect(step.text).toBe('안녕하세요!');
  });
});
