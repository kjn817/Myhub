/// <reference types="jest" />
/**
 * 프로바이더 플러그인 레지스트리 테스트 (OpenClaw 패턴 이식 — 트랙 5)
 * - 기본 핀(루미=gemini, 에코=workers-ai, 노바=gemini, 캘리=groq) 증명
 *   (2026-10-30: 에코 nvidia → workers-ai — NVIDIA 운영 경로 제외)
 * - 4개 프로바이더 플러그인 등록 + 모델 목록 + 교체(swap) + fail-closed
 * - aiChat이 플러그인 경유로 디스패치됨을 가짜 플러그인으로 증명
 */

// privacy guard 모킹 (selectModel 민감도 분기 테스트용 — svc4-ai.test.ts와 동일 패턴)
jest.mock('../../src/ai/legacy-privacy-guard', () => {
  const actual = jest.requireActual('../../src/ai/legacy-privacy-guard');
  return {
    ...actual,
    checkProviderAllowed: jest.fn(),
    checkDataPolicy: jest.fn(),
    resolvePolicySensitivity: jest.fn(),
  };
});

// memo-tool-dispatcher 모킹 (keeper FC 경로 테스트용)
jest.mock('../../src/ai/memo-tool-dispatcher', () => ({
  dispatchToolCalls: jest.fn(),
}));

import {
  checkProviderAllowed,
  checkDataPolicy,
  resolvePolicySensitivity,
} from '../../src/ai/legacy-privacy-guard';
import {
  MODELS,
  aiChat,
  __test,
  type TaskPolicy,
} from '../../src/services/ai';
import {
  PERSONA_PROVIDER_PIN,
  resolvePersonaProvider,
  registerProvider,
  getProvider,
  listProviders,
  getProviderModels,
  unregisterProvider,
  type ProviderPlugin,
} from '../../src/services/provider-registry';

function makeMockDb(overrides: any = {}): any {
  const defaultAll = { results: [] };
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(overrides.first ?? null),
        all: jest.fn().mockResolvedValue(overrides.all ?? defaultAll),
        run: jest.fn().mockResolvedValue(overrides.run ?? {}),
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (checkProviderAllowed as jest.Mock).mockReturnValue({ allowed: true });
  (checkDataPolicy as jest.Mock).mockReturnValue({ allowed: true });
  (resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined);
});

describe('기본 프로바이더 핀 (동작 불변)', () => {
  test('PERSONA_PROVIDER_PIN = 루미 gemini / 에코 workers-ai / 노바 gemini / 캘리 groq', () => {
    expect(PERSONA_PROVIDER_PIN).toEqual({
      concierge: 'gemini',
      keeper: 'workers-ai',
      builder: 'gemini',
      scheduler: 'groq',
    });
  });

  test('resolvePersonaProvider: 4개 비서 + 알 수 없는 비서는 concierge 핀으로 폴백', () => {
    expect(resolvePersonaProvider('concierge')).toBe('gemini');
    expect(resolvePersonaProvider('keeper')).toBe('workers-ai');
    expect(resolvePersonaProvider('builder')).toBe('gemini');
    expect(resolvePersonaProvider('scheduler')).toBe('groq');
    expect(resolvePersonaProvider('ghost')).toBe('gemini');
    expect(resolvePersonaProvider('')).toBe('gemini');
  });

  test('selectModel: 비서별 핀이 그대로 적용됨 (providerPin 경로)', async () => {
    const db = makeMockDb();
    const cases: Array<{ policy: TaskPolicy; expectProvider: string }> = [
      { policy: { capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', providerPin: 'gemini', personaId: 'concierge' }, expectProvider: 'gemini' },
      { policy: { capability: 'summarize', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', providerPin: 'workers-ai', personaId: 'keeper' }, expectProvider: 'workers-ai' },
      { policy: { capability: 'code', privacy: 'external-ok', latency: 'background', quality: 'high', providerPin: 'gemini', personaId: 'builder' }, expectProvider: 'gemini' },
      { policy: { capability: 'schedule', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', providerPin: 'groq', personaId: 'scheduler' }, expectProvider: 'groq' },
    ];
    for (const { policy, expectProvider } of cases) {
      const m = await __test.selectModel(db as any, policy);
      expect(m.provider).toBe(expectProvider);
    }
  });

  test('selectModel: builder는 gemini-3.5-flash-lite 기본 모델 유지', async () => {
    const db = makeMockDb();
    const m = await __test.selectModel(db as any, {
      capability: 'code', privacy: 'external-ok', latency: 'background', quality: 'high',
      providerPin: 'gemini', personaId: 'builder',
    });
    expect(m.id).toBe('gemini-3.5-flash-lite');
    expect(m.provider).toBe('gemini');
  });
});

describe('플러그인 레지스트리', () => {
  test('4개 프로바이더 전부 등록됨', () => {
    for (const id of ['gemini', 'groq', 'workers-ai', 'nvidia'] as const) {
      expect(getProvider(id)).toBeDefined();
      expect(getProvider(id)!.id).toBe(id);
    }
    expect(listProviders()).toHaveLength(4);
  });

  test('각 플러그인의 모델 목록은 해당 프로바이더의 MODELS와 일치', () => {
    for (const id of ['gemini', 'groq', 'workers-ai', 'nvidia'] as const) {
      const listed = getProviderModels(id).map((m) => m.id).sort();
      const expected = MODELS.filter((m) => m.provider === id).map((m) => m.id).sort();
      expect(listed).toEqual(expected);
      expect(listed.length).toBeGreaterThan(0);
    }
  });

  test('활성 모델은 전부 어떤 플러그인에서든 조회됨', () => {
    const allListed = new Set(listProviders().flatMap((p) => p.listModels()).map((m) => m.id));
    for (const m of MODELS.filter((x) => x.status === 'active')) {
      expect(allListed.has(m.id)).toBe(true);
    }
  });

  test('중복 등록은 거부 (replace 없으면 throw)', () => {
    const dup: ProviderPlugin = {
      id: 'gemini',
      displayName: '중복',
      listModels: () => [],
      call: async () => ({ text: '' }),
    };
    expect(() => registerProvider(dup)).toThrow(/already registered/);
  });

  test('replace로 플러그인 교체 가능 (갈아끼우기) 후 원복', () => {
    const orig = getProvider('groq')!;
    const fake: ProviderPlugin = {
      id: 'groq',
      displayName: '가짜 Groq',
      listModels: () => [],
      call: async () => ({ text: 'fake' }),
    };
    registerProvider(fake, { replace: true });
    expect(getProvider('groq')).toBe(fake);
    registerProvider(orig, { replace: true });
    expect(getProvider('groq')).toBe(orig);
  });
});

describe('aiChat 플러그인 경유 디스패치', () => {
  test('가짜 groq 플러그인이 호출됨 — aiChat은 레지스트리 경유로 동작', async () => {
    const orig = getProvider('groq')!;
    let captured: any = null;
    const fake: ProviderPlugin = {
      id: 'groq',
      displayName: '가짜 Groq',
      listModels: () => orig.listModels(),
      call: async (input) => {
        captured = input;
        return { text: '가짜 응답' };
      },
    };
    registerProvider(fake, { replace: true });
    try {
      const env: any = { DB: makeMockDb(), GROQ_API_KEY_1: 'test-groq-key' };
      const result = await aiChat(env, {
        capability: 'schedule', privacy: 'external-ok', latency: 'interactive',
        quality: 'balanced', providerPin: 'groq', personaId: 'scheduler',
      }, [{ role: 'user', content: '내일 일정 알려줘' }]);
      expect(result.text).toBe('가짜 응답');
      expect(result.provider).toBe('groq');
      expect(captured).not.toBeNull();
      expect(captured.key).toBe('test-groq-key');
      expect(captured.model).toBe(result.model);
    } finally {
      registerProvider(orig, { replace: true });
    }
  });

  test('미등록 프로바이더는 fail-closed (호출 시도 없이 throw)', async () => {
    const orig = getProvider('groq')!;
    unregisterProvider('groq');
    try {
      const env: any = { DB: makeMockDb(), GROQ_API_KEY_1: 'test-groq-key' };
      await expect(aiChat(env, {
        capability: 'schedule', privacy: 'external-ok', latency: 'interactive',
        quality: 'balanced', providerPin: 'groq', personaId: 'scheduler',
      }, [{ role: 'user', content: '내일 일정 알려줘' }])).rejects.toThrow(
        'provider plugin not registered: groq',
      );
    } finally {
      registerProvider(orig);
    }
  });
});
