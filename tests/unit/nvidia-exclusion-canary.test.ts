/// <reference types="jest" />
/**
 * NVIDIA 운영 경로 제외 카나리아 (2026-10-30)
 *
 * 성질: 어떤 비서·어떤 진입점·어떤 적대적 입력(핀 직접 지정, 운영에 남은
 * NVIDIA 오버라이드)에서도 NVIDIA가 선택되지 않는다.
 *
 * 카나리아 검증법: 이 파일의 단언은 라우팅의 세 층 중 하나라도 무너지면
 * 실패해야 한다 —
 *  ① 전문가 레지스트리 핀 (keeper가 workers-ai가 아니게 되돌리면 실패)
 *  ② MODELS 레지스트리 (NVIDIA 모델을 active로 되돌리면 실패)
 *  ③ 직접 호출 경로 가드 (studio-agent/generate-html의 차단이 사라지면 실패)
 * 실제 되돌리기 실험 결과는 작업 보고에 기록한다.
 *
 * 플러그인 보존 확인도 함께 한다: NVIDIA 플러그인 등록 자체는 남아 있어야
 * 한다 (삭제가 아니라 비활성이 결정 사항 — 가역성).
 */

import { MODELS, aiChat, __test, type TaskPolicy } from '../../src/services/ai';
import { getProvider, PERSONA_PROVIDER_PIN, resolvePersonaProvider } from '../../src/services/provider-registry';
import { EXPERTS } from '../../src/services/expert-registry';
import { runStudioAgent } from '../../src/services/studio-agent';
import { generateArtifactHtml } from '../../src/modules/artifact/generate-html';

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// ---------------------------------------------------------------------------
// Mock DB (호출 기록 포함)
// ---------------------------------------------------------------------------
function makeDb(settings: Record<string, string> = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    prepare: jest.fn((sql: string) => ({
      bind: jest.fn((...params: any[]) => ({
        first: jest.fn(async () => {
          if (sql.includes('ai_settings')) {
            const key = params[0];
            return settings[key] ? { value: settings[key] } : null;
          }
          return null;
        }),
        all: jest.fn(async () => ({ results: [] })),
        run: jest.fn(async () => {
          calls.push({ sql, params });
          return {};
        }),
      })),
    })),
  };
}

function geminiOk(text = 'gemini 답변') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
  } as any;
}

function groqOk(text = 'groq 답변') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }),
  } as any;
}

const PERSONA_CASES: Array<{ personaId: string; capability: TaskPolicy['capability'] }> = [
  { personaId: 'concierge', capability: 'chat' },
  { personaId: 'keeper', capability: 'summarize' },
  { personaId: 'builder', capability: 'code' },
  { personaId: 'scheduler', capability: 'schedule' },
];

function personaPolicy(personaId: string, capability: TaskPolicy['capability']): TaskPolicy {
  return {
    capability,
    privacy: 'external-ok',
    latency: 'interactive',
    quality: 'balanced',
    personaId,
    providerPin: resolvePersonaProvider(personaId),
    origin: 'interactive',
  } as TaskPolicy;
}

// ---------------------------------------------------------------------------
// 1층·2층: 레지스트리 전수
// ---------------------------------------------------------------------------
describe('레지스트리 전수 — NVIDIA 비활성 + 핀', () => {
  test('MODELS의 모든 nvidia 항목은 비활성이고, 플러그인은 보존돼 있다', () => {
    const nvidia = MODELS.filter((m) => m.provider === 'nvidia');
    expect(nvidia.length).toBeGreaterThan(0); // 삭제가 아니라 비활성 (가역성)
    for (const m of nvidia) {
      expect(m.status).not.toBe('active');
    }
    const plugin = getProvider('nvidia');
    expect(plugin).toBeDefined();
    expect(plugin!.listModels().map((m) => m.id).sort()).toEqual(nvidia.map((m) => m.id).sort());
    // 활성 모델 중 nvidia는 0개 — GET /models·selectModel이 볼 수 있는 집합
    expect(MODELS.filter((m) => m.status === 'active' && m.provider === 'nvidia')).toHaveLength(0);
  });

  test('전 비서 핀에 nvidia가 없고, 에코는 workers-ai다', () => {
    for (const { personaId } of PERSONA_CASES) {
      expect(resolvePersonaProvider(personaId)).not.toBe('nvidia');
    }
    expect(resolvePersonaProvider('keeper')).toBe('workers-ai');
    expect(Object.values(PERSONA_PROVIDER_PIN)).not.toContain('nvidia');
    for (const e of EXPERTS) {
      expect(e.provider).not.toBe('nvidia');
    }
    expect(EXPERTS.find((e) => e.legacyId === 'keeper')?.provider).toBe('workers-ai');
  });
});

// ---------------------------------------------------------------------------
// selectModel 열거 — 정상 핀 + 적대적 입력
// ---------------------------------------------------------------------------
describe('selectModel 열거', () => {
  test('전 비서 정상 핀 → 선택 모델의 provider는 nvidia가 아니다', async () => {
    for (const { personaId, capability } of PERSONA_CASES) {
      const m = await __test.selectModel(makeDb() as any, personaPolicy(personaId, capability));
      expect(m.provider).not.toBe('nvidia');
      expect(m.provider).toBe(resolvePersonaProvider(personaId));
    }
  });

  test('적대적: 핀을 nvidia로 직접 지정해도 어떤 capability에서도 nvidia가 선택되지 않는다', async () => {
    for (const capability of ['chat', 'summarize', 'code', 'schedule'] as const) {
      const policy: TaskPolicy = {
        capability, privacy: 'external-ok', latency: 'interactive', quality: 'balanced',
        providerPin: 'nvidia',
      };
      let selected: any = null;
      let threw = false;
      try {
        selected = await __test.selectModel(makeDb() as any, policy);
      } catch {
        threw = true;
      }
      // 거부되거나(정상), builder 직접 경로처럼 다른 provider로 귀결될 뿐,
      // nvidia 모델이 반환되는 경우는 없다.
      if (!threw) expect(selected.provider).not.toBe('nvidia');
      expect(threw || selected.provider !== 'nvidia').toBe(true);
    }
  });

  test('적대적: 운영에 남은 model.summarize=NVIDIA 오버라이드는 workers-ai 핀에서 안전하게 무시된다', async () => {
    const db = makeDb({ 'model.summarize': 'nvidia/nemotron-3-ultra-550b-a55b' });
    const m = await __test.selectModel(db as any, personaPolicy('keeper', 'summarize'));
    expect(m.provider).toBe('workers-ai');
    expect(m.id).not.toContain('nvidia');
  });

  test('에코 1차 모델: model.summarize=qwen 오버라이드가 그대로 선택된다 (배포 시 적용될 값)', async () => {
    const db = makeDb({ 'model.summarize': '@cf/qwen/qwen3-30b-a3b-fp8' });
    const m = await __test.selectModel(db as any, personaPolicy('keeper', 'summarize'));
    expect(m.id).toBe('@cf/qwen/qwen3-30b-a3b-fp8');
    expect(m.provider).toBe('workers-ai');
  });

  test('Workers AI 내부 폴백 후보는 전부 workers-ai다 (핀 내 전수)', async () => {
    // 시도한 모델을 exclude로 누적하며 반복 선택 — 폴백 체인 전체 열거
    const tried = new Set<string>();
    const db = makeDb({ 'model.summarize': '@cf/qwen/qwen3-30b-a3b-fp8' });
    for (let i = 0; i < 4; i++) {
      const m = await __test.selectModel(db as any, personaPolicy('keeper', 'summarize'), tried);
      expect(m.provider).toBe('workers-ai');
      tried.add(m.id);
    }
  });
});

// ---------------------------------------------------------------------------
// aiChat 열거 — 전 비서 실호출 (mock)
// ---------------------------------------------------------------------------
describe('aiChat 열거 — 전 비서', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('전 비서 aiChat 결과가 nvidia가 아니고, NVIDIA 엔드포인트로 fetch가 나가지 않는다', async () => {
    const fetchSpy = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) return geminiOk();
      if (u.includes('api.groq.com')) return groqOk();
      throw new Error(`unexpected fetch: ${u}`);
    });
    global.fetch = fetchSpy as any;
    const mockAi = { run: jest.fn().mockResolvedValue({ response: 'workers-ai 답변', usage: { prompt_tokens: 30, completion_tokens: 10, neurons: 12 } }) };

    for (const { personaId, capability } of PERSONA_CASES) {
      const env = { DB: makeDb(), AI: mockAi, GEMINI_API_KEY_1: 'k', GROQ_API_KEY_1: 'k', NVIDIA_API_KEY_1: 'k' } as any;
      const result = await aiChat(env, personaPolicy(personaId, capability), [{ role: 'user', content: '안녕' }]);
      expect(result.provider).not.toBe('nvidia');
      expect(result.provider).toBe(resolvePersonaProvider(personaId));
    }
    const urls = fetchSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u === NVIDIA_URL)).toBe(false);
  });

  test('적대적: aiChat에 핀 nvidia를 직접 넘기면 전 비서 모두 거부되고 fetch 0건', async () => {
    const fetchSpy = jest.fn(async () => geminiOk());
    global.fetch = fetchSpy as any;
    const mockAi = { run: jest.fn().mockResolvedValue({ response: 'x' }) };
    for (const { personaId, capability } of PERSONA_CASES) {
      const env = { DB: makeDb(), AI: mockAi, NVIDIA_API_KEY_1: 'k', GEMINI_API_KEY_1: 'k' } as any;
      const policy = { ...personaPolicy(personaId, capability), providerPin: 'nvidia' as const };
      let threw = false;
      let result: any = null;
      try {
        result = await aiChat(env, policy, [{ role: 'user', content: '안녕' }]);
      } catch {
        threw = true;
      }
      expect(threw || result.provider !== 'nvidia').toBe(true);
      if (result) expect(result.provider).not.toBe('nvidia');
    }
    const urls = fetchSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u === NVIDIA_URL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 직접 호출 경로 (aiChat을 거치지 않는 진입점)
// ---------------------------------------------------------------------------
describe('직접 호출 경로 차단', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('스튜디오 에이전트: provider=nvidia는 진입점에서 거부, fetch 0건', async () => {
    const fetchSpy = jest.fn(async () => groqOk());
    global.fetch = fetchSpy as any;
    const r = await runStudioAgent({ NVIDIA_API_KEY_1: 'k' }, '앱 만들어줘', { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('PROVIDER_DISABLED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('아티팩트 HTML 생성: model.code=NVIDIA 설정은 레지스트리 비활성으로 거부', async () => {
    const db = makeDb({ 'model.code': 'nvidia/nemotron-3-ultra-550b-a55b' });
    // generate-html은 ai_settings를 bind 없이 prepare().first()로 읽는다
    (db.prepare as jest.Mock).mockImplementation((sql: string) => ({
      first: jest.fn(async () => (sql.includes('ai_settings') ? { value: 'nvidia/nemotron-3-ultra-550b-a55b' } : null)),
      bind: jest.fn((...params: any[]) => ({
        first: jest.fn(async () => null),
        all: jest.fn(async () => ({ results: [] })),
        run: jest.fn(async () => ({})),
      })),
    }));
    const fetchSpy = jest.fn(async () => groqOk());
    global.fetch = fetchSpy as any;
    await expect(
      generateArtifactHtml({ DB: db, NVIDIA_API_KEY_1: 'k' } as any, 1, 'lease', 'wf', 'sys', 'user')
    ).rejects.toThrow('MODEL_NOT_ACTIVE');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('뉴스 요약(cron 경로): persona 없는 summarize 호출도 nvidia로 나가지 않는다', async () => {
    // news-briefing.summarizeNewsWithModel이 aiChat에 넘기는 정책 그대로 —
    // 핀 없는 capability 호출이 랭킹으로 nvidia를 집는지도 함께 검증한다.
    const fetchSpy = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) return geminiOk('뉴스 요약');
      if (u.includes('api.groq.com')) return groqOk('뉴스 요약');
      throw new Error(`unexpected fetch: ${u}`);
    });
    global.fetch = fetchSpy as any;
    const mockAi = { run: jest.fn().mockResolvedValue({ response: '뉴스 요약', usage: { prompt_tokens: 50, completion_tokens: 20, neurons: 20 } }) };
    const env = { DB: makeDb(), AI: mockAi, GEMINI_API_KEY_1: 'k', GROQ_API_KEY_1: 'k', NVIDIA_API_KEY_1: 'k' } as any;
    const policy: TaskPolicy = {
      capability: 'summarize', privacy: 'external-ok', latency: 'background', quality: 'balanced',
      origin: 'scheduled',
    };
    const result = await aiChat(env, policy, [
      { role: 'system', content: '뉴스 요약 비서' },
      { role: 'user', content: '기사 목록' },
    ]);
    expect(result.provider).not.toBe('nvidia');
    const urls = fetchSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u === NVIDIA_URL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Workers AI 뉴런 소진 degraded 폴백
// ---------------------------------------------------------------------------
describe('뉴런 소진 degraded 폴백 (Workers AI → Gemini lite 1회)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('4006 소진 시 핀을 풀고 gemini-3.5-flash-lite로 1회 재시도해 성공한다', async () => {
    const fetchSpy = jest.fn(async () => geminiOk('degraded 답변'));
    global.fetch = fetchSpy as any;
    const mockAi = { run: jest.fn().mockRejectedValue(new Error('4006: daily free allocation exhausted')) };
    const env = { DB: makeDb(), AI: mockAi, GEMINI_API_KEY_1: 'k' } as any;
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const result = await aiChat(env, personaPolicy('keeper', 'summarize'), [{ role: 'user', content: '뉴스 알려줘' }]);
      expect(result.provider).toBe('gemini');
      expect(result.model).toBe('gemini-3.5-flash-lite');
      expect(result.text).toBe('degraded 답변');
      // degraded 전환은 정확히 1회 — gemini 호출도 1회만
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const log = infoSpy.mock.calls.find((c) => c[0] === 'workers_ai_quota_degraded');
      expect(log).toBeDefined();
      expect(log?.[1]).toEqual(expect.objectContaining({ fromProvider: 'workers-ai', toProvider: 'gemini', fc: false }));
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('workers-ai 핀이 아닌 요청의 4006은 degraded 없이 즉시 quotaExhausted로 중단', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: false, status: 400,
      text: async () => 'daily free allocation exhausted 4006',
      json: async () => ({}),
    } as any));
    global.fetch = fetchSpy as any;
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast',
      personaId: 'concierge', providerPin: 'gemini',
    };
    const env = { DB: makeDb(), GEMINI_API_KEY_1: 'k' } as any;
    let caught: any;
    try {
      await aiChat(env, policy, [{ role: 'user', content: '안녕' }]);
    } catch (e) {
      caught = e;
    }
    expect(caught?.quotaExhausted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('degraded 재시도도 실패하면 무한 재시도 없이 종료한다 (gemini 호출 1회)', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: false, status: 429, text: async () => 'rate limited',
      json: async () => ({}),
    } as any));
    global.fetch = fetchSpy as any;
    const mockAi = { run: jest.fn().mockRejectedValue(new Error('used up your daily free allocation (4006)')) };
    const env = { DB: makeDb(), AI: mockAi, GEMINI_API_KEY_1: 'k' } as any;
    await expect(
      aiChat(env, personaPolicy('keeper', 'summarize'), [{ role: 'user', content: '뉴스 알려줘' }])
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

});

// ---------------------------------------------------------------------------
// Workers AI 사용량 기록 (토큰·뉴런 패스스루)
// ---------------------------------------------------------------------------
describe('Workers AI usage 기록', () => {
  test('ai.run 응답 usage가 결과와 ai_usage 원장에 토큰·뉴런으로 남는다', async () => {
    const db = makeDb();
    const mockAi = {
      run: jest.fn().mockResolvedValue({
        response: '요약 완료',
        usage: { prompt_tokens: 100, completion_tokens: 20, neurons: 24.5 },
      }),
    };
    const env = { DB: db, AI: mockAi } as any;
    const result = await aiChat(env, personaPolicy('keeper', 'summarize'), [{ role: 'user', content: '뉴스 알려줘' }]);
    expect(result.provider).toBe('workers-ai');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    expect(result.neurons).toBe(24.5);
    const usageInsert = db.calls.find((c) => c.sql.includes('INSERT INTO ai_usage'));
    expect(usageInsert).toBeDefined();
    expect(usageInsert!.params).toContain(100);
    expect(usageInsert!.params).toContain(20);
    expect(usageInsert!.params).toContain(24.5);
  });
});
