/**
 * Phase 1B 테스트 — Tool Registry + search_memo
 * @jest-environment node
 *
 * 실행 전: npx esbuild src/ai/tools/registry.ts --bundle --format=cjs --platform=node --external:zod --outfile=/tmp/registry-test.cjs
 * 실행 전: npx esbuild src/ai/tools/search-memo.ts --bundle --format=cjs --platform=node --external:zod --outfile=/tmp/search-memo-test.cjs
 */

const { execSync } = require('child_process');
const path = require('path');

// 번들 생성 (zod 포함)
try {
  execSync('npx esbuild src/ai/tools/registry.ts --bundle --format=cjs --platform=node --outfile=/tmp/registry-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/tools/search-memo.ts --bundle --format=cjs --platform=node --outfile=/tmp/search-memo-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const { ToolRegistry } = require('/tmp/registry-test.cjs');
const { SearchMemoDefinition, SearchMemoInputSchema } = require('/tmp/search-memo-test.cjs');

const ctx = {
  userId: 'test-user',
  requestId: 'test-req-1',
  approvedWrites: false,
};

function createMockDB() {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

describe('Phase 1B: Tool Registry', () => {
  let registry;

  beforeEach(() => {
    registry = new ToolRegistry();
    // Mock executor (DB 없이)
    const mockExecutor = async (args) => ({ matches: [] });
    registry.register(SearchMemoDefinition, SearchMemoInputSchema, mockExecutor);
  });

  test('B01: search_memo 등록 성공', () => {
    const tool = registry.get('search_memo');
    expect(tool).toBeDefined();
    expect(tool.definition.name).toBe('search_memo');
  });

  test('B02: 중복 등록 거부', () => {
    expect(() =>
      registry.register(SearchMemoDefinition, SearchMemoInputSchema, async () => ({}))
    ).toThrow('already registered');
  });

  test('B03: 존재하지 않는 도구 → UNKNOWN_TOOL', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'nonexistent', args: {}, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(false);
    expect(result.output.errorCode).toBe('UNKNOWN_TOOL');
  });

  test('B04: query 없음 → INVALID_ARGUMENTS', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: {}, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(false);
    expect(result.output.errorCode).toBe('INVALID_ARGUMENTS');
  });

  test('B04b: query 공백 → INVALID_ARGUMENTS', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: '   ' }, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(false);
  });

  test('B05: query 121자 → INVALID_ARGUMENTS', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: 'a'.repeat(121) }, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(false);
    expect(result.output.errorCode).toBe('INVALID_ARGUMENTS');
  });

  test('B06: limit 기본값 3', () => {
    const parsed = SearchMemoInputSchema.parse({ query: 'test' });
    expect(parsed.limit).toBe(3);
  });

  test('B07: limit 0 → INVALID_ARGUMENTS', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: 'test', limit: 0 }, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(false);
  });

  test('B07b: limit 6 → INVALID_ARGUMENTS', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: 'test', limit: 6 }, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(false);
  });

  test('B08: 정상 호출 → ok:true', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: '과제' }, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(true);
    expect(result.callId).toBe('c1');
  });

  test('B11: 추가 필드(userId) → INVALID_ARGUMENTS', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'search_memo', args: { query: 'test', userId: 'hacker' }, provider: 'groq' },
      ctx,
      { DB: createMockDB() }
    );
    expect(result.output.ok).toBe(false);
    expect(result.output.errorCode).toBe('INVALID_ARGUMENTS');
  });

  test('Registry list: Executor 미노출', () => {
    const list = registry.list();
    expect(list.length).toBe(1);
    expect(list[0].executor).toBeUndefined();
    expect(list[0].name).toBe('search_memo');
  });

  test('Registry list 필터', () => {
    expect(registry.list(['search_memo']).length).toBe(1);
    expect(registry.list(['nonexistent']).length).toBe(0);
  });
});

describe('Phase 1B: Zod 스키마', () => {
  test('정상 입력', () => {
    const r = SearchMemoInputSchema.parse({ query: '과제 마감일', limit: 3 });
    expect(r.query).toBe('과제 마감일');
  });

  test('trim 적용', () => {
    const r = SearchMemoInputSchema.parse({ query: '  과제  ' });
    expect(r.query).toBe('과제');
  });
});
