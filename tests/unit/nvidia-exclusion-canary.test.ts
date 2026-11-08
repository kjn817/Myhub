/// <reference types="jest" />
/**
 * NVIDIA 라우팅 경계 카나리아 (2026-10-30 제정, 2026-11-05 개정)
 *
 * 개정 사유: 2026-11-05 실측 판정으로 에코 비메모 턴에 NVIDIA가 채택됐다
 * ("어떤 경우에도 NVIDIA 선택 불가"라는 구 성질은 소멸). 현행 성질은
 * 경계다 —
 *  ① NVIDIA에 도달할 수 있는 비서는 에코(keeper)뿐이고, 그 경우도
 *     비메모 턴만이다 (메모 턴 차단은 nvidia-memo-guard 스위트 담당).
 *  ② 루미·노바·캘리의 정상 핀으로는 NVIDIA가 선택되지 않는다.
 *  ③ ai_settings 오버라이드는 핀의 프로바이더를 넘지 못한다.
 *  ④ aiChat을 거치지 않는 직접 경로(studio-agent/generate-html)와
 *     핀 없는 랭킹 호출은 여전히 NVIDIA를 거부한다.
 *  ⑤ NVIDIA 모델은 'active'가 아니라 'evaluation'으로만 존재하고
 *     플러그인 등록은 보존된다.
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

function nvidiaOk(text = 'nvidia 답변') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  } as any;
}

const PERSONA_CASES: Array<{ personaId: string; capability: TaskPolicy['capability'] }> = [
  { personaId: 'concierge', capability: 'chat' },
  // 에코의 NVIDIA 경로는 비메모 chat 턴이다. summarize 턴은 메모 도구
  // 스킬을 로드하는 메모 작업이라 workers-ai가 담당한다 (아래 별도 검증).
  { personaId: 'keeper', capability: 'chat' },
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
describe('레지스트리 전수 — NVIDIA 경계 + 핀', () => {
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

  test('nvidia 핀은 에코뿐이고, 에코의 메모 턴 핀은 workers-ai다', () => {
    // NVIDIA에 닿을 수 있는 비서는 keeper 하나뿐이다 (2026-11-05 채택 범위)
    for (const { personaId } of PERSONA_CASES) {
      if (personaId === 'keeper') continue;
      expect(resolvePersonaProvider(personaId)).not.toBe('nvidia');
    }
    for (const e of EXPERTS) {
      if (e.legacyId === 'keeper') continue;
      expect(e.provider).not.toBe('nvidia');
    }
    // 에코: 기본 핀 nvidia + 메모 턴 전용 핀 workers-ai (이중 구조)
    expect(resolvePersonaProvider('keeper')).toBe('nvidia');
    expect(PERSONA_PROVIDER_PIN.keeper).toBe('nvidia');
    const keeper = EXPERTS.find((e) => e.legacyId === 'keeper');
    expect(keeper?.provider).toBe('nvidia');
    expect(keeper?.memoTurnProvider).toBe('workers-ai');
  });
});

// ---------------------------------------------------------------------------
// selectModel 열거 — 정상 핀 + 적대적 입력
// ---------------------------------------------------------------------------
describe('selectModel 열거', () => {
  test('전 비서 정상 핀 → 선택 모델의 provider는 핀과 같고, nvidia는 에코뿐이다', async () => {
    for (const { personaId, capability } of PERSONA_CASES) {
      const m = await __test.selectModel(makeDb() as any, personaPolicy(personaId, capability));
      expect(m.provider).toBe(resolvePersonaProvider(personaId));
      if (personaId !== 'keeper') expect(m.provider).not.toBe('nvidia');
    }
    // 에코(비메모 기본 핀)에서는 nemotron이 실제로 선택된다 (채택의 긍정 검증)
    const keeperModel = await __test.selectModel(makeDb() as any, personaPolicy('keeper', 'summarize'));
    expect(keeperModel.provider).toBe('nvidia');
    expect(keeperModel.id).toContain('nemotron');
  });

  test('적대적: model.summarize=NVIDIA 오버라이드는 workers-ai 핀에서 안전하게 무시된다', async () => {
    // 오버라이드는 핀의 프로바이더를 넘지 못한다 — 에코 메모 턴(workers-ai 핀)
    // 설정에 NVIDIA 모델이 남아 있어도 workers-ai 안에서 선택된다.
    const db = makeDb({ 'model.summarize': 'nvidia/nemotron-3-ultra-550b-a55b' });
    const policy: TaskPolicy = { ...personaPolicy('keeper', 'summarize'), providerPin: 'workers-ai' };
    const m = await __test.selectModel(db as any, policy);
    expect(m.provider).toBe('workers-ai');
    expect(m.id).not.toContain('nvidia');
  });

  test('에코 메모 턴 1차 모델: model.summarize=qwen 오버라이드가 그대로 선택된다 (배포 시 적용될 값)', async () => {
    const db = makeDb({ 'model.summarize': '@cf/qwen/qwen3-30b-a3b-fp8' });
    const policy: TaskPolicy = { ...personaPolicy('keeper', 'summarize'), providerPin: 'workers-ai' };
    const m = await __test.selectModel(db as any, policy);
    expect(m.id).toBe('@cf/qwen/qwen3-30b-a3b-fp8');
    expect(m.provider).toBe('workers-ai');
  });

  test('Workers AI 내부 폴백 후보는 전부 workers-ai다 (핀 내 전수)', async () => {
    // 시도한 모델을 exclude로 누적하며 반복 선택 — 폴백 체인 전체 열거
    const tried = new Set<string>();
    const db = makeDb({ 'model.summarize': '@cf/qwen/qwen3-30b-a3b-fp8' });
    const policy: TaskPolicy = { ...personaPolicy('keeper', 'summarize'), providerPin: 'workers-ai' };
    for (let i = 0; i < 4; i++) {
      const m = await __test.selectModel(db as any, policy, tried);
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

  test('전 비서 aiChat: nvidia 도달은 에코 비메모 턴뿐이고, 에코 메모 턴은 workers-ai다', async () => {
    const fetchSpy = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) return geminiOk();
      if (u.includes('api.groq.com')) return groqOk();
      if (u === NVIDIA_URL) return nvidiaOk();
      throw new Error(`unexpected fetch: ${u}`);
    });
    global.fetch = fetchSpy as any;
    const mockAi = { run: jest.fn().mockResolvedValue({ response: 'workers-ai 답변', usage: { prompt_tokens: 30, completion_tokens: 10, neurons: 12 } }) };

    for (const { personaId, capability } of PERSONA_CASES) {
      const env = { DB: makeDb(), AI: mockAi, GEMINI_API_KEY_1: 'k', GROQ_API_KEY_1: 'k', NVIDIA_API_KEY_1: 'k' } as any;
      const before = fetchSpy.mock.calls.length;
      // 에코는 스킬 무매칭 입력이면 기본 스킬(메모 도구)이 로드돼 메모
      // 컨텍스트로 분류되는 fail-closed 구조라, 비메모 턴은 뉴스 스킬에
      // 매칭되는 입력으로 만든다.
      const content = personaId === 'keeper' ? '오늘 뉴스 알려줘' : '안녕';
      const result = await aiChat(env, personaPolicy(personaId, capability), [{ role: 'user', content }]);
      expect(result.provider).toBe(resolvePersonaProvider(personaId));
      const turnUrls = fetchSpy.mock.calls.slice(before).map((c: any[]) => String(c[0]));
      // NVIDIA 엔드포인트 호출은 에코 턴에서만 일어난다
      expect(turnUrls.some((u) => u === NVIDIA_URL)).toBe(personaId === 'keeper');
    }

    // 에코라도 메모 턴이면 workers-ai로 우회하고 NVIDIA fetch는 0건이다
    const env = { DB: makeDb(), AI: mockAi, GEMINI_API_KEY_1: 'k', GROQ_API_KEY_1: 'k', NVIDIA_API_KEY_1: 'k' } as any;
    const before = fetchSpy.mock.calls.length;
    const memoResult = await aiChat(env, personaPolicy('keeper', 'chat'), [{ role: 'user', content: '메모 찾아줘' }]);
    expect(memoResult.provider).toBe('workers-ai');
    const memoUrls = fetchSpy.mock.calls.slice(before).map((c: any[]) => String(c[0]));
    expect(memoUrls.some((u) => u === NVIDIA_URL)).toBe(false);
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
      // degraded는 workers-ai 핀(에코 메모 턴 구성)에서만 발동한다
      const policy: TaskPolicy = { ...personaPolicy('keeper', 'summarize'), providerPin: 'workers-ai' };
      const result = await aiChat(env, policy, [{ role: 'user', content: '메모 요약해줘' }]);
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
    const policy: TaskPolicy = { ...personaPolicy('keeper', 'summarize'), providerPin: 'workers-ai' };
    await expect(
      aiChat(env, policy, [{ role: 'user', content: '메모 요약해줘' }])
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
    const policy: TaskPolicy = { ...personaPolicy('keeper', 'summarize'), providerPin: 'workers-ai' };
    const result = await aiChat(env, policy, [{ role: 'user', content: '메모 요약해줘' }]);
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
