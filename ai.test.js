/**
 * MyHub AI 서비스 유닛 테스트
 * @jest-environment node
 *
 * src/services/ai.ts를 esbuild로 번들한 뒤 테스트한다.
 * 실행 전: npx esbuild src/services/ai.ts --bundle --format=cjs --platform=node --outfile=/tmp/ai-test-bundle.js
 */
const { execSync } = require('child_process');
const path = require('path');
const BUNDLE = path.join(__dirname, 'ai-bundle.cjs');
// 테스트 전 esbuild로 최신 소스를 번들
try {
  execSync('npx esbuild src/services/ai.ts --bundle --format=cjs --platform=node --outfile=' + BUNDLE, { cwd: __dirname, stdio: 'pipe' });
} catch {}
let ai = null;
try { ai = require(BUNDLE); } catch {}

// ---- D1 모킹 ----
function mockDB() {
  const settings = new Map();
  const usage = [];
  return {
    settings,
    usage,
    prepare(sql) {
      const self = this;
      return {
        _sql: sql,
        _params: [],
        bind(...params) {
          this._params = params;
          return this;
        },
        async first() {
          if (this._sql.includes('ai_settings')) {
            const v = settings.get(this._params[0]);
            return v ? { value: v } : null;
          }
          return null;
        },
        async run() {
          if (this._sql.includes('INSERT INTO ai_settings')) {
            settings.set(this._params[0], this._params[1]);
          } else if (this._sql.includes('INSERT INTO ai_usage')) {
            usage.push(this._params);
          }
          return {};
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

function mockEnv(keys = {}) {
  return {
    DB: mockDB(),
    ...keys,
  };
}

describe('ai.ts', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    // 번들 다시 로드 (모듈 상태 초기화: keyPools)
    delete require.cache[BUNDLE];
    ai = require(BUNDLE);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  if (!ai) {
    test('번들 로드 실패', () => { throw new Error('ai bundle not built'); });
    return;
  }

  describe('MODELS 레지스트리', () => {
    test('활성 모델이 9개 (gemini 3, groq 2, workers-ai 3, nvidia 1)', () => {
      // 2026-10-13: flash(non-lite) 전멸로 deprecated, lite 2종으로 교체, nvidia 추가
      const active = ai.MODELS.filter((m) => m.status === 'active');
      expect(active.length).toBe(9);
      expect(active.filter((m) => m.provider === 'gemini').length).toBe(3);
      expect(active.filter((m) => m.provider === 'groq').length).toBe(2);
      expect(active.filter((m) => m.provider === 'workers-ai').length).toBe(3);
      expect(active.filter((m) => m.provider === 'nvidia').length).toBe(1);
    });

    test('qwen은 제외됨 (function calling 불안정)', () => {
      const qwen = ai.MODELS.find((m) => m.id.includes('qwen'));
      expect(qwen).toBeUndefined();
    });

    test('단종된 모델이 없음', () => {
      const ids = ai.MODELS.map((m) => m.id);
      expect(ids).not.toContain('gemini-2.5-flash-lite');
      expect(ids).not.toContain('gemini-2.5-pro');
      expect(ids).not.toContain('@cf/meta/llama-3.1-8b-instruct');
    });

    test('llama-3.3-70b-versatile는 deprecated 상태', () => {
      const m = ai.MODELS.find((x) => x.id === 'llama-3.3-70b-versatile');
      expect(m).toBeDefined();
      expect(m.status).toBe('deprecated');
      // 활성 모델 목록에는 없어야 함
      const active = ai.MODELS.filter((x) => x.status === 'active');
      expect(active.find((x) => x.id === 'llama-3.3-70b-versatile')).toBeUndefined();
    });
  });

  describe('키 풀 (getPool/pickKey)', () => {
    test('환경변수에서 키 4개를 읽음', () => {
      const env = mockEnv({
        GEMINI_API_KEY_1: 'g1', GEMINI_API_KEY_2: 'g2',
        GEMINI_API_KEY_3: 'g3', GEMINI_API_KEY_4: 'g4',
      });
      const pool = ai.__test.getPool(env, 'gemini');
      expect(pool.length).toBe(4);
    });

    test('키가 없으면 빈 풀', () => {
      const env = mockEnv();
      const pool = ai.__test.getPool(env, 'groq');
      expect(pool.length).toBe(0);
      expect(ai.__test.pickKey(pool)).toBeNull();
    });

    test('쿨다운 중인 키는 제외', () => {
      const pool = [
        { key: 'a', cooledUntil: Date.now() + 60000, failures: 0 },
        { key: 'b', cooledUntil: 0, failures: 0 },
      ];
      const picked = ai.__test.pickKey(pool);
      expect(picked.key).toBe('b');
    });

    test('전부 쿨다운이면 null', () => {
      const pool = [{ key: 'a', cooledUntil: Date.now() + 60000, failures: 0 }];
      expect(ai.__test.pickKey(pool)).toBeNull();
    });
  });

  describe('모델 선택 (selectModel)', () => {
    test('privacy=private면 Workers AI만', async () => {
      const env = mockEnv();
      const m = await ai.__test.selectModel(env.DB, {
        capability: 'summarize', privacy: 'private', latency: 'interactive', quality: 'balanced',
      });
      expect(m.provider).toBe('workers-ai');
    });

    test('chat이면 gemini 우선 (Google Search 내장)', async () => {
      const env = mockEnv();
      const m = await ai.__test.selectModel(env.DB, {
        capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast',
      });
      expect(m.provider).toBe('gemini');
    });

    test('사용자 오버라이드가 있으면 그것을 사용', async () => {
      const env = mockEnv();
      await ai.setSetting(env.DB, 'model.chat', 'gemini-3.5-flash-lite');
      const m = await ai.__test.selectModel(env.DB, {
        capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast',
      });
      expect(m.id).toBe('gemini-3.5-flash-lite');
    });

    test('private인데 외부 모델 오버라이드는 무시', async () => {
      const env = mockEnv();
      await ai.setSetting(env.DB, 'model.summarize', 'gemini-3.8-flash');
      const m = await ai.__test.selectModel(env.DB, {
        capability: 'summarize', privacy: 'private', latency: 'interactive', quality: 'balanced',
      });
      expect(m.provider).toBe('workers-ai');
    });

    test('없는 모델 오버라이드는 무시', async () => {
      const env = mockEnv();
      await ai.setSetting(env.DB, 'model.chat', 'nonexistent-model');
      const m = await ai.__test.selectModel(env.DB, {
        capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast',
      });
      expect(m.id).not.toBe('nonexistent-model');
    });

    test('Gemini 2개 실패 후에는 다른 provider 선택', async () => {
      const env = mockEnv();
      const exclude = new Set(['gemini-3.8-flash', 'gemini-3.7-flash']);
      const m = await ai.__test.selectModel(env.DB, {
        capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'balanced',
      }, exclude);
      // 2개 실패 후에는 체인을 타지 않고 점수 기반으로 선택 (groq 또는 gemini-3.5)
      // gemini-3.5-flash가 체인에 있지만 geminiFailed>=2라 체인 로직 스킵
      expect(exclude.has(m.id)).toBe(false);
    });
  });

  describe('설정 (getSetting/setSetting)', () => {
    test('저장 후 조회', async () => {
      const env = mockEnv();
      await ai.setSetting(env.DB, 'budget.gemini', '1500');
      expect(await ai.getSetting(env.DB, 'budget.gemini')).toBe('1500');
    });

    test('없는 키는 null', async () => {
      const env = mockEnv();
      expect(await ai.getSetting(env.DB, 'nope')).toBeNull();
    });
  });

  describe('aiChat', () => {
    test('groq 호출 성공', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: '안녕!' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
      const env = mockEnv({ GROQ_API_KEY_1: 'test-key' });
      const r = await ai.aiChat(env,
        { capability: 'code', privacy: 'external-ok', latency: 'interactive', quality: 'fast' },
        [{ role: 'user', content: '안녕' }]);
      expect(r.text).toBe('안녕!');
      expect(r.provider).toBe('groq');
      expect(env.DB.usage.length).toBe(1);
      expect(env.DB.usage[0][6]).toBe('success');
    });

    test('429면 같은 provider 내 다음 모델로 폴백 (프로바이더 고정)', async () => {
      // 2026-10-13: 비서별 프로바이더 고정 — 폴백은 provider 내부에서만 발생
      // 3.5-flash-lite 429 → 3.1-flash-lite 성공 (다른 키 사용)
      global.fetch
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => '' })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '폴백 성공' }] } }],
            usageMetadata: {},
          }),
        });
      const env = mockEnv({ GEMINI_API_KEY_1: 'g1', GEMINI_API_KEY_2: 'g2' });
      const r = await ai.aiChat(env,
        { capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', providerPin: 'gemini' },
        [{ role: 'user', content: '안녕' }]);
      expect(r.text).toBe('폴백 성공');
      expect(r.provider).toBe('gemini');
      expect(r.model).toBe('gemini-3.1-flash-lite');
    });

    test('429가 아닌 실패도 같은 provider 내에서 폴백 (Gemini 체인: lite→lite)', async () => {
      const geminiFail = { ok: false, status: 500, text: async () => 'err' };
      const geminiSuccess = {
        ok: true, status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Gemini 성공' }] } }],
          usageMetadata: {},
        }),
      };
      global.fetch
        .mockResolvedValueOnce(geminiFail) // 3.5-flash-lite 실패
        .mockResolvedValueOnce(geminiSuccess); // 3.1-flash-lite 성공 (provider 전환 없음)
      const env = mockEnv({ GEMINI_API_KEY_1: 'g1', GEMINI_API_KEY_2: 'g2' });
      const r = await ai.aiChat(env,
        { capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', providerPin: 'gemini' },
        [{ role: 'user', content: 'hi' }]);
      expect(r.text).toBe('Gemini 성공');
      expect(r.provider).toBe('gemini');
      expect(r.model).toBe('gemini-3.1-flash-lite');
    });

    test('고정 provider의 모델이 전부 실패하면 에러 (타 provider로 우회 금지)', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'err' });
      const env = mockEnv({ GEMINI_API_KEY_1: 'g1', GROQ_API_KEY_1: 'q1' });
      await expect(ai.aiChat(env,
        { capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', providerPin: 'gemini' },
        [{ role: 'user', content: 'hi' }])).rejects.toThrow();
    });

    test('전부 실패하면 에러', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'err' });
      const env = mockEnv({ GEMINI_API_KEY_1: 'g1' });
      await expect(ai.aiChat(env,
        { capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast' },
        [{ role: 'user', content: 'hi' }])).rejects.toThrow();
    });

    test('긴 입력은 잘림', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      });
      const env = mockEnv({ GROQ_API_KEY_1: 'q1' });
      const long = 'x'.repeat(20000);
      await ai.aiChat(env,
        { capability: 'code', privacy: 'external-ok', latency: 'interactive', quality: 'fast', maxInputChars: 100 },
        [{ role: 'user', content: long }]);
      const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(sentBody.messages[0].content.length).toBeLessThan(200);
      expect(sentBody.messages[0].content).toContain('잘림');
    });

    test('gemini 형식 변환', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'gemini 응답' }] } }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
        }),
      });
      const env = mockEnv({ GEMINI_API_KEY_1: 'g1' });
      await ai.setSetting(env.DB, 'model.chat', 'gemini-2.5-flash');
      const r = await ai.aiChat(env,
        { capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast' },
        [
          { role: 'system', content: '시스템' },
          { role: 'user', content: '안녕' },
          { role: 'assistant', content: '이전 답' },
        ]);
      expect(r.text).toBe('gemini 응답');
      expect(r.provider).toBe('gemini');
      expect(r.inputTokens).toBe(8);
      // systemInstruction 분리 확인
      const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(sentBody.systemInstruction.parts[0].text).toBe('시스템');
      expect(sentBody.contents[0].role).toBe('user');
      expect(sentBody.contents[1].role).toBe('model');
    });

    test('workers-ai 호출', async () => {
      const env = mockEnv({
        AI: { run: jest.fn().mockResolvedValue({ response: 'workers 응답' }) },
      });
      const r = await ai.aiChat(env,
        { capability: 'summarize', privacy: 'private', latency: 'interactive', quality: 'balanced' },
        [{ role: 'user', content: '요약해줘' }]);
      expect(r.text).toBe('workers 응답');
      expect(r.provider).toBe('workers-ai');
    });

    test('workers-ai 바인딩 없으면 폴백 시도 후 실패', async () => {
      const env = mockEnv(); // AI 없음, 키도 없음
      await expect(ai.aiChat(env,
        { capability: 'summarize', privacy: 'private', latency: 'interactive', quality: 'balanced' },
        [{ role: 'user', content: 'hi' }])).rejects.toThrow();
    });
  });

  describe('PERSONAS', () => {
    test('4명 정의', () => {
      expect(ai.PERSONAS.length).toBe(4);
      const ids = ai.PERSONAS.map((p) => p.id);
      expect(ids).toEqual(['concierge', 'keeper', 'builder', 'scheduler']);
    });

    test('아바타 경로', () => {
      ai.PERSONAS.forEach((p) => {
        expect(p.avatar).toMatch(/^\/avatars\/\w+\.webp$/);
      });
    });
  });
});
