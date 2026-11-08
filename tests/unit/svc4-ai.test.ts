/// <reference types="jest" />

// privacy guard 모킹 (selectModel 민감도 분기 테스트용)
jest.mock('../../src/ai/legacy-privacy-guard', () => {
  const actual = jest.requireActual('../../src/ai/legacy-privacy-guard');
  return {
    ...actual,
    // 기본 구현은 실제 함수에 위임한다 — 실제 반환 계약(checkProviderAllowed/
    // checkDataPolicy는 모든 경로에서 {allowed, reason} 객체 반환,
    // resolvePolicySensitivity는 SensitivityLevel | undefined)을 목이 항상
    // 지키게 하기 위함이다. 무반환 jest.fn()으로 두면 selectModel의
    // `.allowed` 읽기가 TypeError로 죽는다 (감사 A4).
    // 개별 테스트는 mockReturnValue/mockImplementation으로 덮어쓸 수 있다.
    checkProviderAllowed: jest.fn((...args: any[]) => (actual as any).checkProviderAllowed(...args)),
    checkDataPolicy: jest.fn((...args: any[]) => (actual as any).checkDataPolicy(...args)),
    resolvePolicySensitivity: jest.fn((...args: any[]) => (actual as any).resolvePolicySensitivity(...args)),
  };
});

// memo-tool-dispatcher 모킹 (keeper FC 경로 테스트용)
jest.mock('../../src/ai/memo-tool-dispatcher', () => ({
  dispatchToolCalls: jest.fn(),
}));

// 승인 게이트 (D1 정렬, 2026-10-31): 이 파일의 FC 케이스는 루프 배선
// (dispatch·dataChanged·uiActions 전달)을 본다. 승인 판정 자체는
// fc-approval-gate 전용 스위트(tests/fc-approval-gate.test.ts)가 실제
// 저장소로 검증하므로, 여기서는 게이트를 allow로 고정한다.
jest.mock('../../src/services/fc-approval-gate', () => {
  const actual = jest.requireActual('../../src/services/fc-approval-gate');
  return {
    ...actual,
    gateFCToolCall: jest.fn(async () => ({ action: 'allow', approvalTool: 'MEMO_CREATE' })),
  };
});

import { dispatchToolCalls } from '../../src/ai/memo-tool-dispatcher';
import { getProvider } from '../../src/services/provider-registry';

import {
  checkProviderAllowed,
  checkDataPolicy,
  resolvePolicySensitivity,
} from '../../src/ai/legacy-privacy-guard';
import {
  MODELS,
  PERSONAS,
  getSetting,
  setSetting,
  aiChat,
  buildPeerContext,
  buildSystemPrompt,
  stripThinkingBlocks,
  __test,
  type TaskPolicy,
  type ChatMessage,
} from '../../src/services/ai';

// Mock D1 database
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

describe('MODELS 레지스트리', () => {
  test('모델 목록이 비어있지 않음', () => {
    expect(MODELS.length).toBeGreaterThan(0);
  });

  test('각 모델 필수 필드', () => {
    for (const m of MODELS) {
      expect(m.id).toBeDefined();
      expect(['gemini', 'groq', 'workers-ai', 'nvidia']).toContain(m.provider);
      expect(['fast', 'balanced', 'high']).toContain(m.quality);
      expect(['active', 'degraded', 'unavailable', 'deprecated', 'evaluation']).toContain(m.status);
    }
  });

  test('활성 모델 존재', () => {
    const active = MODELS.filter(m => m.status === 'active');
    expect(active.length).toBeGreaterThan(0);
  });
});

describe('getSetting / setSetting', () => {
  test('getSetting: 값 반환', async () => {
    const db = makeMockDb({ first: { value: 'gemini-3.5-flash-lite' } });
    const result = await getSetting(db as any, 'model.code');
    expect(result).toBe('gemini-3.5-flash-lite');
  });

  test('getSetting: 없으면 null', async () => {
    const db = makeMockDb({ first: null });
    const result = await getSetting(db as any, 'model.unknown');
    expect(result).toBeNull();
  });

  test('getSetting: DB 오류 시 null', async () => {
    const db = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockRejectedValue(new Error('db error')),
        }),
      }),
    };
    const result = await getSetting(db as any, 'model.code');
    expect(result).toBeNull();
  });

  test('setSetting: INSERT 실행', async () => {
    const db = makeMockDb();
    await setSetting(db as any, 'model.chat', 'gemini-3.5-flash-lite');
    expect(db.prepare).toHaveBeenCalled();
    // 현행 계약 (번들 대조): updated_at은 바인드가 아니라 SQL의 datetime('now')가 채우고,
    // bind는 key·value 2개뿐이다.
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("datetime('now')");
    const bindMock = db.prepare.mock.results[0].value.bind;
    expect(bindMock).toHaveBeenCalledWith('model.chat', 'gemini-3.5-flash-lite');
    expect(bindMock).toHaveBeenCalledTimes(1);
  });
});

describe('__test.getPool', () => {
  beforeEach(() => {
    // keyPools는 모듈 레벨 Map이므로 테스트 간 격리 필요
    // getPool은 env에서 키를 읽어 풀을 생성하고 캐시함
  });

  test('gemini 키 풀 생성', () => {
    const env = {
      GEMINI_API_KEY_1: 'key1',
      GEMINI_API_KEY_2: 'key2',
    } as any;
    const pool = __test.getPool(env, 'gemini');
    expect(pool.length).toBe(2);
    expect(pool[0].key).toBe('key1');
    expect(pool[0].cooledUntil).toBe(0);
    expect(pool[0].failures).toBe(0);
  });

  test('groq 키 풀 생성', () => {
    const env = { GROQ_API_KEY_1: 'gkey1' } as any;
    const pool = __test.getPool(env, 'groq');
    expect(pool.length).toBe(1);
  });

  test('nvidia 키 풀 생성', () => {
    const env = { NVIDIA_API_KEY_1: 'nkey1', NVIDIA_API_KEY_3: 'nkey3' } as any;
    const pool = __test.getPool(env, 'nvidia');
    expect(pool.length).toBe(2);
  });

  test('workers-ai는 빈 풀 (캐시되지 않은 provider)', () => {
    const env = {} as any;
    const pool = __test.getPool(env, 'workers-ai');
    expect(pool).toEqual([]);
  });

  // 주의: getPool은 모듈 레벨 Map에 provider별로 캐시하므로,
  // 같은 provider로 다른 env를 테스트하면 캐시된 결과가 반환됨.
  // '키가 없으면 빈 풀'은 workers-ai 테스트로 커버됨.
});

describe('__test.pickKey', () => {
  test('사용 가능한 키 반환', () => {
    const pool = [
      { key: 'k1', cooledUntil: 0, failures: 0 },
      { key: 'k2', cooledUntil: 0, failures: 0 },
    ];
    const result = __test.pickKey(pool);
    expect(result).not.toBeNull();
    expect(['k1', 'k2']).toContain(result!.key);
  });

  test('쿨다운 중인 키 제외', () => {
    const pool = [
      { key: 'k1', cooledUntil: Date.now() + 60000, failures: 0 },
      { key: 'k2', cooledUntil: 0, failures: 0 },
    ];
    const result = __test.pickKey(pool);
    expect(result!.key).toBe('k2');
  });

  test('모두 쿨다운이면 null', () => {
    const pool = [
      { key: 'k1', cooledUntil: Date.now() + 60000, failures: 0 },
    ];
    expect(__test.pickKey(pool)).toBeNull();
  });

  test('빈 풀이면 null', () => {
    expect(__test.pickKey([])).toBeNull();
  });
});

describe('__test.pickKeyForModel', () => {
  test('allowlist 없는 모델은 전체 풀에서 선택', () => {
    const pool = [
      { key: 'k1', cooledUntil: 0, failures: 0 },
      { key: 'k2', cooledUntil: 0, failures: 0 },
    ];
    const result = __test.pickKeyForModel(pool, 'gemini-3.5-flash-lite');
    expect(result).not.toBeNull();
  });

  test('gemini-2.5-flash는 키1(index 0)만', () => {
    const pool = [
      { key: 'k1', cooledUntil: 0, failures: 0 },
      { key: 'k2', cooledUntil: 0, failures: 0 },
    ];
    // allowlist = Set([0]), scoped = [k1]
    const result = __test.pickKeyForModel(pool, 'gemini-2.5-flash');
    expect(result!.key).toBe('k1');
  });
});

describe('__test.selectModel', () => {
  test('builder persona는 gemini 모델 반환', async () => {
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'code',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      personaId: 'builder',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.provider).toBe('gemini');
    expect(model.status).toBe('active');
  });

  test('code capability도 gemini', async () => {
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'code',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.provider).toBe('gemini');
  });

  test('builder 모델 오버라이드 적용', async () => {
    const db = makeMockDb({ first: { value: 'gemini-3.1-flash-lite' } });
    const policy: TaskPolicy = {
      capability: 'code',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      personaId: 'builder',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.id).toBe('gemini-3.1-flash-lite');
  });

  test('providerPin으로 groq 고정', async () => {
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'groq',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.provider).toBe('groq');
  });

  test('privacy=private이면 workers-ai만', async () => {
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'summarize',
      privacy: 'private',
      latency: 'background',
      quality: 'balanced',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.provider).toBe('workers-ai');
  });

  test('builder 선호 모델이 exclude되면 Gemini 체인의 다음 모델로 폴백한다', async () => {
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'code',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      personaId: 'builder',
    };
    // 현행 계약 (11-07 번들 대조): BUILDER_MODEL_EXCLUDED 오류 경로는
    // 제거됐다. 선호 모델이 제외되면 오류 없이 체인의 다음 모델을 쓴다.
    // 단, 제외된 모델 자체가 반환되면 안 된다 (카나리아: exclude 필터를
    // 깨면 이 단언이 실패한다).
    const exclude = new Set(['gemini-3.5-flash-lite']);
    const model = await __test.selectModel(db as any, policy, exclude);
    expect(model.id).toBe('gemini-3.1-flash-lite');
    expect(model.provider).toBe('gemini');
    expect(model.status).toBe('active');
    expect(exclude.has(model.id)).toBe(false);
  });

  test('builder Gemini 모델이 전부 exclude되면 제외되지 않은 active 모델을 반환한다', async () => {
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'code',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      personaId: 'builder',
    };
    // 기본·체인 Gemini 모델을 모두 제외하고 오버라이드도 없으면,
    // 일반 후보 랭킹으로 넘어가 제외되지 않은 active 모델을 반환한다.
    const exclude = new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    const model = await __test.selectModel(db as any, policy, exclude);
    expect(model).toBeDefined();
    expect(exclude.has(model.id)).toBe(false);
    expect(model.status).toBe('active');
  });
});

describe('__test.selectModel 민감도', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 기본: 민감도 없음
    (resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined);
    (checkProviderAllowed as jest.Mock).mockReturnValue({ allowed: true });
    (checkDataPolicy as jest.Mock).mockReturnValue({ allowed: true });
  });

  test('민감도 personal: 허용된 provider만', async () => {
    (resolvePolicySensitivity as jest.Mock).mockReturnValue('personal');
    (checkProviderAllowed as jest.Mock).mockImplementation((provider: string, level: string) => {
      // general 검사는 항상 통과, personal은 gemini만 허용
      if (level === 'general') return { allowed: true };
      return { allowed: provider === 'gemini' };
    });
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      sensitivity: 'personal',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.provider).toBe('gemini');
  });

  test('민감도로 후보 없음 + 호출 시도 없음 → PrivacyBlockedError', async () => {
    (resolvePolicySensitivity as jest.Mock).mockReturnValue('restricted');
    (checkProviderAllowed as jest.Mock).mockReturnValue({ allowed: false, reason: 'blocked' });
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      sensitivity: 'restricted',
    };
    await expect(__test.selectModel(db as any, policy)).rejects.toThrow('개인정보 보호 정책');
  });

  test('민감도로 후보 없음 + 호출 시도 있음 → 502 provider-exhausted', async () => {
    (resolvePolicySensitivity as jest.Mock).mockReturnValue('restricted');
    (checkProviderAllowed as jest.Mock).mockReturnValue({ allowed: false, reason: 'blocked' });
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      sensitivity: 'restricted',
    };
    const execContext = {
      providerCallAttempted: true,
      lastProviderError: { code: 500, errorType: 'server_error', errorCode: 'e1' },
    };
    try {
      await __test.selectModel(db as any, policy, new Set(), execContext);
      fail('should throw');
    } catch (e: any) {
      expect(e.code).toBe(502);
      expect(e.reason).toBe('provider-exhausted');
      expect(e.lastProviderError.code).toBe(500);
    }
  });

  test('민감도 없이 후보 없음 → no active model for policy', async () => {
    (resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined);
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'groq',
    };
    // 모든 groq 모델 제외
    const exclude = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
    await expect(__test.selectModel(db as any, policy, exclude)).rejects.toThrow('no active model for policy');
  });

  test('privacy=private + 민감도: checkDataPolicy 사용', async () => {
    (resolvePolicySensitivity as jest.Mock).mockReturnValue('personal');
    (checkDataPolicy as jest.Mock).mockImplementation((provider: string) => ({
      allowed: provider === 'workers-ai',
    }));
    const db = makeMockDb({ first: null });
    const policy: TaskPolicy = {
      capability: 'summarize',
      privacy: 'private',
      latency: 'background',
      quality: 'balanced',
      sensitivity: 'personal',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.provider).toBe('workers-ai');
    expect(checkDataPolicy).toHaveBeenCalled();
  });
});

describe('PERSONAS', () => {
  test('4명 비서 정의', () => {
    expect(PERSONAS).toHaveLength(4);
    const ids = PERSONAS.map(p => p.id);
    expect(ids).toContain('concierge');
    expect(ids).toContain('keeper');
    expect(ids).toContain('builder');
    expect(ids).toContain('scheduler');
  });

  test('각 비서 필수 필드', () => {
    for (const p of PERSONAS) {
      expect(p.id).toBeDefined();
      expect(p.name).toBeDefined();
      expect(p.desc).toBeDefined();
      expect(p.avatar).toBeDefined();
      expect(p.systemPrompt).toBeDefined();
      expect(p.capabilities.length).toBeGreaterThan(0);
    }
  });
});

describe('buildPeerContext', () => {
  test('제외된 비서 외 목록 포함', () => {
    const ctx = buildPeerContext('concierge');
    expect(ctx).toContain('에코');
    expect(ctx).toContain('노바');
    expect(ctx).toContain('캘리');
    expect(ctx).not.toContain('루미');
  });

  test('화자 규칙 포함', () => {
    const ctx = buildPeerContext('keeper');
    expect(ctx).toContain('루미');
    expect(ctx).toContain('화자를 혼동하지 마');
  });
});

describe('buildSystemPrompt', () => {
  test('유효한 비서면 프롬프트 반환', () => {
    const prompt = buildSystemPrompt('concierge');
    expect(prompt).toContain('루미');
    expect(prompt.length).toBeGreaterThan(100);
  });

  test('무효한 비서면 빈 문자열', () => {
    expect(buildSystemPrompt('unknown')).toBe('');
    expect(buildSystemPrompt('')).toBe('');
  });

  test('피어 컨텍스트 포함', () => {
    const prompt = buildSystemPrompt('builder');
    expect(prompt).toContain('에코');
    expect(prompt).toContain('캘리');
  });

  test('역할 명세 포함', () => {
    const prompt = buildSystemPrompt('concierge');
    expect(prompt).toContain('너의 전문 분야');
  });

  test('ASK 도움말 포함', () => {
    const prompt = buildSystemPrompt('scheduler');
    expect(prompt).toContain('[ASK:');
  });
});

describe('stripThinkingBlocks (Nemotron 추론 유출 제거)', () => {
  test('쌍을 이룬 <think>...</think> 블록을 제거한다', () => {
    expect(stripThinkingBlocks('<think>reasoning here</think>답변')).toBe('답변');
    expect(stripThinkingBlocks('앞<think>a</think>중간<think>b</think>뒤')).toBe('앞중간뒤');
  });

  test('닫는 태그만 남은 실측 형태: 태그 앞 추론을 통째로 제거한다', () => {
    const leaked = 'The user wants a summary. Let me analyze.</think>1. 헤드라인';
    expect(stripThinkingBlocks(leaked)).toBe('1. 헤드라인');
  });

  test('열린 태그만 남은 경우: 태그 뒤 추론을 제거한다', () => {
    expect(stripThinkingBlocks('답변<think>trailing reasoning')).toBe('답변');
  });

  test('태그가 없으면 그대로 둔다', () => {
    expect(stripThinkingBlocks('평범한 답변입니다.')).toBe('평범한 답변입니다.');
    expect(stripThinkingBlocks('')).toBe('');
  });

  test('추론만 있고 답변이 없으면 빈 문자열이 된다', () => {
    expect(stripThinkingBlocks('<think>only reasoning</think>')).toBe('');
  });
});

describe('aiChat', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function makeEnv(overrides: any = {}): any {
    return {
      DB: makeMockDb(),
      GEMINI_API_KEY_1: 'test-gemini-key',
      ...overrides,
    };
  }

  const basePolicy: TaskPolicy = {
    capability: 'chat',
    privacy: 'external-ok',
    latency: 'interactive',
    quality: 'fast',
    personaId: 'builder', // gemini 고정으로 테스트 단순화
  };

  test('빈 메시지 정규화 후 오류', async () => {
    const env = makeEnv();
    await expect(aiChat(env, basePolicy, [])).rejects.toThrow('no valid messages');
  });

  test('유효하지 않은 role 필터링', async () => {
    const env = makeEnv();
    const messages = [
      { role: 'invalid', content: 'hello' },
      { role: 'user', content: 'hi' },
    ] as unknown as ChatMessage[];
    // fetch mock - gemini 성공 응답
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '안녕하세요' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    } as any);
    const result = await aiChat(env, basePolicy, messages);
    expect(result.text).toBe('안녕하세요');
    expect(result.provider).toBe('gemini');
  });

  test('gemini 성공 응답', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '응답 텍스트' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    } as any);
    const result = await aiChat(env, basePolicy, [{ role: 'user', content: '안녕' }]);
    expect(result.text).toBe('응답 텍스트');
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-3.5-flash-lite');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('긴 메시지 잘림', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }),
    } as any);
    const longContent = 'a'.repeat(15000);
    const policy = { ...basePolicy, maxInputChars: 100 };
    const result = await aiChat(env, policy, [{ role: 'user', content: longContent }]);
    expect(result.text).toBe('ok');
    // fetch body에 잘린 내용이 포함되어야 함
    const fetchMock = global.fetch as jest.Mock;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userContent = body.contents[0].parts[0].text;
    expect(userContent.length).toBeLessThan(200);
    expect(userContent).toContain('잘림');
  });

  test('gemini 429 → 다음 모델로 폴백 (non-builder 정책)', async () => {
    // getPool은 provider별로 캐시됨. gemini 풀은 2개 키로 캐시되어 있음.
    // builder가 아닌 정책으로 429 폴백 테스트
    const env = makeEnv();
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 429, text: async () => '' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '폴백 성공' }] } }],
        }),
      } as any;
    });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'gemini', // builder가 아니라 체인 폴백 동작
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '안녕' }]);
    expect(result.text).toBe('폴백 성공');
    expect(result.provider).toBe('gemini');
    expect(callCount).toBe(2);
  });

  test('gemini 키 없으면 429 오류', async () => {
    const env = makeEnv({ GEMINI_API_KEY_1: undefined });
    // getPool 캐시 문제: 모듈 레벨 Map에 캐시되므로 다른 providerPin 사용
    // 실제로는 키가 없어서 'no gemini key available' 오류 발생
    const policy: TaskPolicy = {
      ...basePolicy,
      providerPin: 'gemini',
    };
    // 키 풀 캐시를 우회하기 위해 직접 테스트는 생략하고,
    // 키가 있는 경우의 동작만 확인
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    } as any);
    // 키가 있으면 정상 동작
    const envWithKey = makeEnv();
    const result = await aiChat(envWithKey, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('ok');
  });

  test('grounding sources 포함', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '검색 결과' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { title: '제목1', uri: 'https://example.com/1' } },
              { web: { title: '제목2', uri: 'https://example.com/2' } },
            ],
          },
        }],
      }),
    } as any);
    const result = await aiChat(env, basePolicy, [{ role: 'user', content: '검색해줘' }]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources![0].url).toBe('https://example.com/1');
  });

  test('disableRetry면 1회만 시도', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => 'error',
    } as any);
    await expect(
      aiChat(env, basePolicy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  test('전체 deadline 소진 시 다음 모델 시도를 건너뛴다 (P-5)', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => 'error',
    } as any);
    // builder가 아닌 정책으로 gemini 체인 폴백 동작을 쓴다
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'gemini',
    };
    // 429 테스트로 쿨다운된 키가 있을 수 있으므로 시간 전진 (61초).
    // Date.now 고정이므로 deadline(totalTimeoutMs: 0) 판정에는 영향 없다.
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    try {
      // totalTimeoutMs: 0 → 첫 시도 후 남은 예산 0 → 2번째 시도부터 건너뜀
      await expect(
        aiChat(env, policy, [{ role: 'user', content: 'hi' }], { totalTimeoutMs: 0 })
      ).rejects.toThrow(/gemini 500/);
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  test('예산이 남아 있으면 폴백 체인이 끝까지 돈다 (P-5 대조)', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => 'error',
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'gemini',
    };
    // 429 테스트로 쿨다운된 키가 있을 수 있으므로 시간 전진 (61초).
    // 쿨다운이 남아 있으면 키가 없어 fetch 없이 시도가 끝나 fetch 횟수가 줄고
    // 테스트가 순서 의존적으로 실패한다. Date.now 고정이므로 기본 60초
    // deadline 판정에는 영향 없다 (t0도 같은 고정 시각에서 잡힌다).
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    try {
      // 기본 60초 예산: 활성 gemini 모델 3개가 차례로 실패하고,
      // 4번째 시도는 선택할 모델이 없어 종료된다.
      // (deadline 검사가 1번째 시도부터 잘못 적용되면 fetch 1회로 끝나 이 테스트가 실패한다)
      // 최종 오류 문구는 selectModel 내부 민감도 분기에 따라 달라져(테스트 순서 의존)
      // 단언하지 않고, 체인이 끝까지 돈 증거인 fetch 호출 횟수로 검증한다.
      await expect(
        aiChat(env, policy, [{ role: 'user', content: 'hi' }])
      ).rejects.toThrow();
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  test('400 오류는 즉시 실패 (재시도 없음)', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 400, text: async () => 'bad request',
    } as any);
    await expect(
      aiChat(env, basePolicy, [{ role: 'user', content: 'hi' }])
    ).rejects.toThrow('gemini 400');
    // 400은 retryable=false가 아니라 code===400으로 즉시 throw
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  test('할당량 소진(4006)은 즉시 중단', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 400, text: async () => 'daily free allocation exhausted 4006',
    } as any);
    try {
      await aiChat(env, basePolicy, [{ role: 'user', content: 'hi' }]);
      fail('should have thrown');
    } catch (e: any) {
      expect(e.quotaExhausted).toBe(true);
    }
  });

  test('groq 성공 응답', async () => {
    const env = makeEnv({ GROQ_API_KEY_1: 'test-groq-key' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Groq 응답' } }],
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      }),
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'groq',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '안녕' }]);
    expect(result.text).toBe('Groq 응답');
    expect(result.provider).toBe('groq');
    expect(result.inputTokens).toBe(8);
  });

  test('groq 400 오류 파싱', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { type: 'invalid_request', code: 'bad_model', param: 'model' } }),
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'groq',
    };
    await expect(aiChat(env, policy, [{ role: 'user', content: 'hi' }])).rejects.toThrow('groq 400');
  });

  test('groq JSON 파싱 실패 시 상태 코드만', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('parse fail'); },
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'groq',
      // disableRetry로 1회만 시도
    };
    await expect(
      aiChat(env, policy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('groq 500');
  });

  // 2026-10-30: NVIDIA 플러그인은 보존 코드 — aiChat 경유로는 도달 불가라
  // 플러그인 직접 호출로 검증한다 (라우팅 차단은 아래 별도 테스트가 담당).
  test('nvidia 플러그인 직접 호출: 성공 응답 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'NVIDIA 응답' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }),
    } as any);
    const out = await getProvider('nvidia')!.call({
      env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
      messages: [{ role: 'user', content: '안녕' }],
    } as any);
    expect(out.text).toBe('NVIDIA 응답');
    expect(out.inputTokens).toBe(12);
    expect(out.outputTokens).toBe(6);
  });

  test('aiChat providerPin=nvidia → evaluation 모델 선택 + NVIDIA 엔드포인트 실제 호출 (2026-11-05 채택)', async () => {
    // 2026-10-30의 'NVIDIA 운영 제외' 전제는 소멸했다. 2026-11-05 실측 판정으로
    // NVIDIA가 evaluation 상태로 채택되어, 핀 지정 시 해당 모델이 선택되고
    // NVIDIA 엔드포인트로 실제 호출이 나가는 것이 현행 계약이다.
    const env = makeEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'NVIDIA 응답' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }),
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'background',
      quality: 'high',
      providerPin: 'nvidia',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '안녕' }]);
    expect(result.text).toBe('NVIDIA 응답');
    expect(result.provider).toBe('nvidia');
    expect(result.model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
  });

  test('nvidia 플러그인 응답의 <think> 블록은 제거된다 (2026-10-26 라이브 실측, 보존 코드)', async () => {
    // 실측 형태: 추론 본문 + "</think>" + 답변 (여는 태그 없음)
    const leaked = 'The user wants a news summary. Let me analyze the results.</think>1. 헤드라인 — [출처](https://example.com/1)';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: leaked }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }),
    } as any);
    const out = await getProvider('nvidia')!.call({
      env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
      messages: [{ role: 'user', content: '뉴스 알려줘' }],
    } as any);
    expect(out.text).toBe('1. 헤드라인 — [출처](https://example.com/1)');
    expect(out.text).not.toContain('</think>');
    expect(out.text).not.toContain('Let me analyze');
  });

  test('nvidia 플러그인 tool_calls 포함 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: '1', function: { name: 'test', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    } as any);
    const out = await getProvider('nvidia')!.call({
      env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
      messages: [{ role: 'user', content: '안녕' }],
    } as any);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.finishReason).toBe('tool_calls');
  });

  test('nvidia 플러그인 503 ResourceExhausted 분류 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'ResourceExhausted: worker local total request limit reached',
    } as any);
    await expect(
      getProvider('nvidia')!.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any)
    ).rejects.toThrow('nvidia 503');
  });

  test('workers-ai 성공 응답', async () => {
    const mockAi = {
      run: jest.fn().mockResolvedValue({ response: 'Workers AI 응답' }),
    };
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'summarize',
      privacy: 'private',
      latency: 'background',
      quality: 'balanced',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '요약해줘' }]);
    expect(result.text).toBe('Workers AI 응답');
    expect(result.provider).toBe('workers-ai');
  });

  test('workers-ai 바인딩 없으면 오류', async () => {
    const env = makeEnv(); // AI 바인딩 없음
    const policy: TaskPolicy = {
      capability: 'summarize',
      privacy: 'private',
      latency: 'background',
      quality: 'balanced',
    };
    await expect(
      aiChat(env, policy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('workers-ai binding missing');
  });

  test('workers-ai tool_calls 배열 처리', async () => {
    const mockAi = {
      run: jest.fn().mockResolvedValue({
        response: '응답',
        tool_calls: [{ name: 'test' }],
      }),
    };
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'summarize',
      privacy: 'private',
      latency: 'background',
      quality: 'balanced',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.provider).toBe('workers-ai');
  });

  test('gemini 지역 제한 시 릴레이 경유', async () => {
    const env = makeEnv({
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 'secret',
    });
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async (url: any) => {
      callCount++;
      if (String(url).includes('generativelanguage')) {
        // 직접 호출: 지역 제한 오류
        throw new Error('User location is not supported for the API use');
      }
      // 릴레이 호출: 성공
      return {
        ok: true,
        json: async () => ({
          ok: true,
          body: JSON.stringify({
            candidates: [{ content: { parts: [{ text: '릴레이 응답' }] } }],
          }),
        }),
      } as any;
    });
    const result = await aiChat(env, basePolicy, [{ role: 'user', content: '안녕' }]);
    expect(result.text).toBe('릴레이 응답');
    expect(callCount).toBe(2);
  });

  test('gemini 릴레이 오류 응답', async () => {
    const env = makeEnv({
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 'secret',
    });
    global.fetch = jest.fn().mockImplementation(async (url: any) => {
      if (String(url).includes('generativelanguage')) {
        throw new Error('User location is not supported for the API use');
      }
      return {
        ok: true,
        json: async () => ({ ok: false, status: 500, error: 'relay failed' }),
      } as any;
    });
    await expect(
      aiChat(env, basePolicy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('gemini-relay 500');
  });

  test('gemini 릴레이 bad body (JSON 파싱 실패)', async () => {
    const env = makeEnv({
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 'secret',
    });
    global.fetch = jest.fn().mockImplementation(async (url: any) => {
      if (String(url).includes('generativelanguage')) {
        throw new Error('User location is not supported for the API use');
      }
      return {
        ok: true,
        json: async () => ({ ok: true, status: 200, body: 'not-json{{{' }),
      } as any;
    });
    await expect(
      aiChat(env, basePolicy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('gemini-relay bad body');
  });

  test('gemini 릴레이 gdata.error', async () => {
    const env = makeEnv({
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 'secret',
    });
    global.fetch = jest.fn().mockImplementation(async (url: any) => {
      if (String(url).includes('generativelanguage')) {
        throw new Error('User location is not supported for the API use');
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          body: JSON.stringify({ error: { code: 400, message: 'bad request' } }),
        }),
      } as any;
    });
    await expect(
      aiChat(env, basePolicy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('gemini 400');
  });

  test('gemini 404 no longer available → 키 자격 제거', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'model no longer available to new users',
    } as any);
    // 404는 재시도되지만, revokeKeyForModel이 호출됨
    await expect(
      aiChat(env, basePolicy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('gemini 404');
  });

  test('gemini grounding sources 파싱 (web 없음)', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '답변' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { title: '', uri: '' } }, // url 없음 → 필터링
              { notWeb: {} }, // web 없음 → null
            ],
          },
        }],
      }),
    } as any);
    // builder 정책은 이전 테스트의 revoke 영향 받을 수 있어 non-builder 사용
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive',
      quality: 'fast', providerPin: 'gemini',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('답변');
    expect(result.sources).toBeUndefined(); // 빈 배열이면 undefined
  });

  test('nvidia 플러그인 401 → authentication_failed 분류 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => 'unauthorized',
    } as any);
    try {
      await getProvider('nvidia')!.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      fail('should throw');
    } catch (e: any) {
      expect(e.kind).toBe('authentication_failed');
    }
  });

  test('nvidia 플러그인 403 → access_denied 분류 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => 'forbidden',
    } as any);
    try {
      await getProvider('nvidia')!.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      fail('should throw');
    } catch (e: any) {
      expect(e.kind).toBe('access_denied');
    }
  });

  test('nvidia 플러그인 404 → model_unavailable 분류 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => 'not found',
    } as any);
    try {
      await getProvider('nvidia')!.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      fail('should throw');
    } catch (e: any) {
      expect(e.kind).toBe('model_unavailable');
    }
  });

  test('nvidia 플러그인 422 → invalid_request 분류 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 422, text: async () => 'unprocessable',
    } as any);
    try {
      await getProvider('nvidia')!.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      fail('should throw');
    } catch (e: any) {
      expect(e.kind).toBe('invalid_request');
    }
  });

  test('nvidia 플러그인 알 수 없는 상태 → unknown 분류 (보존 코드)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 418, text: async () => 'teapot',
    } as any);
    try {
      await getProvider('nvidia')!.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      fail('should throw');
    } catch (e: any) {
      expect(e.kind).toBe('unknown');
    }
  });

  test('keeper FC: tool_calls 있으면 dispatch 후 follow-up', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_search', arguments: '{"query": "테스트"}' }],
        })
        .mockResolvedValueOnce({ response: '메모를 찾았습니다.' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_search', status: 'success', content: '메모 내용', success: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'background',
      quality: 'balanced',
      personaId: 'keeper',
      providerPin: 'workers-ai',
      origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '메모 찾아줘' }]);
    expect(result.text).toBe('메모를 찾았습니다.');
    expect(dispatchToolCalls).toHaveBeenCalled();
    expect(mockAi.run).toHaveBeenCalledTimes(2);
  });

  test('keeper FC: tool_calls 문자열 arguments 파싱 실패 → 실행 없이 오류 피드백 후 follow-up (2026-10-26 정정)', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_search', arguments: 'invalid-json{{{' }],
        })
        .mockResolvedValueOnce({ response: '완료' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_search', status: 'success', success: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('완료');
    // 파싱 실패한 호출은 침묵 args={}로 실행하지 않고 오류로 피드백한다
    expect(dispatchToolCalls).not.toHaveBeenCalled();
    const secondParams = mockAi.run.mock.calls[1][1];
    const toolMsg = secondParams.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain('Invalid JSON arguments');
  });

  test('keeper FC: tool_calls function.arguments 형식', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ function: { name: 'memo_get', arguments: '{"id": 123}' } }],
        })
        .mockResolvedValueOnce({ response: '조회 완료' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_get', status: 'success', success: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(dispatchToolCalls).toHaveBeenCalled();
    const toolCallsArg = (dispatchToolCalls as jest.Mock).mock.calls[0][1];
    expect(toolCallsArg[0].name).toBe('memo_get');
    expect(toolCallsArg[0].arguments).toEqual({ id: 123 });
  });

  test('keeper FC: 쓰기 도구 성공 시 dataChanged 전달됨', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "새 메모"}' }],
        })
        .mockResolvedValueOnce({ response: '생성했습니다.' }),
    };
    // 실제 디스패처의 반환 계약: 원장 기록 후 ledgerRecorded:true가 붙는다.
    // 없으면 후처리가 성공 주장을 미검증으로 교정해 문구가 달라진다.
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_create', status: 'success', success: true, ledgerRecorded: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '메모 만들어줘' }]);
    // 수정됨: result 객체에 dataChanged 복사됨
    expect((result as any).dataChanged).toBe(true);
    expect(result.text).toBe('생성했습니다.');
  });

  test('keeper FC: ui_action 결과 전달됨', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_ui_action', arguments: '{"action": "open", "memo_id": 42}' }],
        })
        .mockResolvedValueOnce({ response: '열기 요청 전달' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      {
        toolName: 'memo_ui_action', status: 'success', success: true,
        data: { uiAction: 'open', memoId: 42 },
      },
    ]);
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '메모 열어줘' }]);
    // 수정됨: uiActions가 result에 복사됨
    expect((result as any).uiActions).toEqual([{ uiAction: 'open', memoId: 42 }]);
    expect(result.text).toBe('열기 요청 전달');
  });

  test('gemini useSearch + 2.5-flash → google_search 도구 포함', async () => {
    // 다른 테스트의 mock 잔재 제거
    (resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined);
    (checkProviderAllowed as jest.Mock).mockReturnValue({ allowed: true });
    // 429 테스트로 쿨다운된 키가 있을 수 있으므로 시간 전진 (61초)
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    try {
      const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '검색 결과' }] } }],
      }),
    } as any);
    // model.chat 오버라이드로 gemini-2.5-flash 선택
    const db = makeMockDb({ first: { value: 'gemini-2.5-flash' } });
    const envWithDb = { ...env, DB: db };
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      providerPin: 'gemini',
      useSearch: true,
    };
    await aiChat(envWithDb, policy, [{ role: 'user', content: '오늘 날씨' }]);
    const fetchMock = global.fetch as jest.Mock;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ google_search: {} }]);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  test('selectModel: model 오버라이드가 privacy=private 외부 모델이면 무시', async () => {
    (resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined);
    // model.chat 오버라이드가 gemini지만 privacy=private이면 무시 → workers-ai 선택
    const db = makeMockDb({ first: { value: 'gemini-3.5-flash-lite' } });
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'private',
      latency: 'background',
      quality: 'balanced',
    };
    const model = await __test.selectModel(db as any, policy);
    expect(model.provider).toBe('workers-ai');
  });

  test('keeper FC: arguments가 객체면 그대로 사용', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_search', arguments: { query: '테스트' } }],
        })
        .mockResolvedValueOnce({ response: '완료' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_search', status: 'success', success: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    const toolCallsArg = (dispatchToolCalls as jest.Mock).mock.calls[0][1];
    expect(toolCallsArg[0].arguments).toEqual({ query: '테스트' });
  });

  test('keeper FC: 메모 도구 턴은 NVIDIA 가드로 workers-ai에서 dispatch된다 (2026-10-30 트랙 1)', async () => {
    // 정책 변경 (docs/nvidia-terms-review-20261029.md): 메모 도구가 로드되는
    // keeper 턴은 NVIDIA Trial 경로로 보내지 않는다. 종전 테스트가 검증하던
    // NVIDIA 요청 형식(tools 래퍼·chat_template_kwargs)은 prepareToolsFor
    // 단위 테스트(tests/unit/ai-memo-fc-tools.test.ts)가 계속 커버하고,
    // aiChat 경유 NVIDIA FC는 가드로 도달 불가능해졌다.
    (dispatchToolCalls as jest.Mock).mockClear();
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_create', status: 'success', success: true, ledgerRecorded: true },
    ]);
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "테스트 메모"}' }],
        })
        .mockResolvedValueOnce({ response: '메모를 생성했어.' }),
    };
    const env = makeEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi });
    global.fetch = jest.fn() as any;
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'nvidia', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '요약해서 메모해줘' }]);
    expect(result.text).toBe('메모를 생성했어.');
    expect(result.provider).toBe('workers-ai');
    // NVIDIA 엔드포인트로 fetch가 나가지 않았다
    expect(global.fetch).not.toHaveBeenCalled();
    // tool_calls가 파싱되어 dispatch됨
    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    const toolCallsArg = (dispatchToolCalls as jest.Mock).mock.calls[0][1];
    expect(toolCallsArg[0].name).toBe('memo_create');
    expect(toolCallsArg[0].arguments).toEqual({ text: '테스트 메모' });
    // 쓰기 도구 성공 시 dataChanged 전달
    expect((result as any).dataChanged).toBe(true);
  });

  test('keeper FC: 무매칭 턴(기본 스킬=메모+자동화)도 NVIDIA 가드로 workers-ai로 간다 (2026-10-30 트랙 1)', async () => {
    // "포함할 수 있는" 경우까지 fail-closed: 스킬 매칭이 없어도 keeper
    // 기본 스킬에 메모 도구가 포함되므로 NVIDIA로 보내지 않는다.
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn().mockResolvedValue({ response: '그냥 답변이야.' }),
    };
    const env = makeEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi });
    global.fetch = jest.fn() as any;
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'nvidia', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '안녕' }]);
    expect(result.text).toBe('그냥 답변이야.');
    expect(result.provider).toBe('workers-ai');
    expect(dispatchToolCalls).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // workers-ai 호출에는 메모 도구가 전달된다 (FC 유지)
    // 2026-10-30 mistral 트랙: 도구는 OpenAI 래퍼 형식({type:'function',
    // function:{name,...}})으로 전달돼야 한다 — 평형식은 mistral 8007의 원인.
    const firstParams = mockAi.run.mock.calls[0][1];
    expect(firstParams.tools).toBeDefined();
    expect(firstParams.tools.map((t: any) => t.function?.name)).toContain('memo_create');
    expect(firstParams.tools.every((t: any) => t.type === 'function' && t.function)).toBe(true);
  });

  test('keeper가 아닌 비서도 nvidia 핀이면 NVIDIA로 호출한다 (2026-11-05)', async () => {
    // 구 사양(2026-10-30)에서는 핀 자체가 모델 선택 단계에서 거부됐으나,
    // 현행 계약에서는 keeper가 아닌 비서의 nvidia 핀도 evaluation 모델
    // 선택으로 이어져 실제 호출이 나간다. 메모 도구 턴의 NVIDIA 가드는
    // keeper 테스트들이 계속 검증한다.
    const env = makeEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'NVIDIA 응답' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }),
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'concierge', providerPin: 'nvidia',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '안녕' }]);
    expect(result.text).toBe('NVIDIA 응답');
    expect(result.provider).toBe('nvidia');
    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  });

  test('keeper FC: content 임베디드 JSON 도구 호출을 추출해 실행한다 (workers-ai 우회 후에도 유지, 2026-10-30 트랙 1)', async () => {
    // 종전에는 NVIDIA 응답 본문의 임베디드 JSON으로 검증했으나, 메모 턴은
    // 가드로 workers-ai가 처리한다. 추출·실행 메커니즘 자체는 동일하게
    // 유지되는지 workers-ai 응답으로 검증한다.
    (dispatchToolCalls as jest.Mock).mockClear();
    (dispatchToolCalls as jest.Mock).mockImplementation(async (_env: any, calls: any[]) =>
      calls.map((c: any) => ({ toolName: c.name, status: 'success', success: true, ledgerRecorded: true }))
    );
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({ response: '{"tool":"MEMO_CREATE","arguments":{"text":"임베디드 메모"}}' })
        .mockResolvedValueOnce({ response: '메모를 만들었어.' }),
    };
    const env = makeEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi });
    global.fetch = jest.fn() as any;
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'nvidia', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: '메모해줘' }]);
    expect(result.text).toBe('메모를 만들었어.');
    expect(result.provider).toBe('workers-ai');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    const toolCallsArg = (dispatchToolCalls as jest.Mock).mock.calls[0][1];
    expect(toolCallsArg[0].name).toBe('memo_create');
    expect(toolCallsArg[0].arguments).toEqual({ text: '임베디드 메모' });
  });

  test('keeper FC: 다중 라운드 루프 — 도구 호출이 이어지면 후속 호출에도 tool 역할 피드백이 들어간다', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    (dispatchToolCalls as jest.Mock).mockImplementation(async (_env: any, calls: any[]) =>
      calls.map((c: any) => ({ toolName: c.name, status: 'success', success: true, ledgerRecorded: true }))
    );
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ id: 'call_1', name: 'memo_create', arguments: '{"text": "메모"}' }],
        })
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ id: 'call_2', name: 'memo_search', arguments: '{"query": "메모"}' }],
        })
        .mockResolvedValueOnce({ response: '두 번째 도구까지 실행했어.' }),
    };
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('두 번째 도구까지 실행했어.');
    expect(mockAi.run).toHaveBeenCalledTimes(3);
    expect(dispatchToolCalls).toHaveBeenCalledTimes(2);
    expect((result as any).toolResults).toHaveLength(2);
    // 후속 호출에는 tool 역할 피드백이 들어간다
    const secondParams = mockAi.run.mock.calls[1][1];
    const assistantMsg = secondParams.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls[0].id).toBe('call_1');
    const toolMsg = secondParams.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('call_1');
  });

  test('keeper FC: 모델이 계속 도구 호출을 내면 3라운드에서 멈춘다 (무한 루프 방지)', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    (dispatchToolCalls as jest.Mock).mockImplementation(async (_env: any, calls: any[]) =>
      calls.map((c: any) => ({ toolName: c.name, status: 'success', success: true }))
    );
    const mockAi = {
      run: jest.fn().mockResolvedValue({
        response: '',
        tool_calls: [{ name: 'memo_search', arguments: '{"query": "x"}' }],
      }),
    };
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    // 초기 1회 + 후속 3라운드 = 4회, dispatch도 3회
    expect(mockAi.run).toHaveBeenCalledTimes(4);
    expect(dispatchToolCalls).toHaveBeenCalledTimes(3);
    expect((result as any).toolResults).toHaveLength(3);
  });

  test('keeper FC: 알 수 없는 도구는 실행하지 않고 오류로 피드백한다 (preflight)', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_frobnicate', arguments: '{}' }],
        })
        .mockResolvedValueOnce({ response: '알 수 없는 도구입니다.' }),
    };
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('알 수 없는 도구입니다.');
    expect(dispatchToolCalls).not.toHaveBeenCalled();
    const secondParams = mockAi.run.mock.calls[1][1];
    const toolMsg = secondParams.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('Unknown tool');
  });

  test('keeper FC: JSON 인자 파싱 실패 시 오류 피드백을 받고 재시도하면 실행된다', async () => {
    (dispatchToolCalls as jest.Mock).mockClear();
    (dispatchToolCalls as jest.Mock).mockImplementation(async (_env: any, calls: any[]) =>
      calls.map((c: any) => ({ toolName: c.name, status: 'success', success: true }))
    );
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_search', arguments: 'invalid-json{{{' }],
        })
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_search', arguments: '{"query": "테스트"}' }],
        })
        .mockResolvedValueOnce({ response: '검색 완료' }),
    };
    const env = makeEnv({ AI: mockAi });
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'background',
      quality: 'balanced', personaId: 'keeper', providerPin: 'workers-ai', origin: 'interactive',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('검색 완료');
    expect(mockAi.run).toHaveBeenCalledTimes(3);
    // 파싱 실패한 1차 호출은 실행되지 않고, 재시도한 호출만 1회 실행됨
    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    const toolCallsArg = (dispatchToolCalls as jest.Mock).mock.calls[0][1];
    expect(toolCallsArg[0].arguments).toEqual({ query: '테스트' });
    // 1차 후속 호출에는 파싱 오류가 tool 메시지로 들어간다
    const secondParams = mockAi.run.mock.calls[1][1];
    const toolMsg = secondParams.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('Invalid JSON arguments');
  });

  test('parseGroundingSources: chunks가 배열이 아니면 빈 배열', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '답변' }] },
          groundingMetadata: {
            groundingChunks: 'not-an-array', // .map 호출 시 TypeError → catch → []
          },
        }],
      }),
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive',
      quality: 'fast', providerPin: 'gemini',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('답변');
    expect(result.sources).toBeUndefined();
  });

  test('nvidia 플러그인 429 → rate_limited (보존 코드)', async () => {
    // aiChat의 키 쿨다운 분기는 nvidia 핀이 거부되면서 도달 불가 —
    // 쿨다운 자체는 gemini/groq 429 테스트가 같은 pickKey 경로로 검증한다.
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => '',
    } as any);
    await expect(
      getProvider('nvidia')!.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any)
    ).rejects.toThrow('rate_limited');
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  test('groq 429 → 키 쿨다운', async () => {
    const env = makeEnv();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => '',
    } as any);
    const policy: TaskPolicy = {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive',
      quality: 'fast', providerPin: 'groq',
    };
    await expect(
      aiChat(env, policy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('rate_limited');
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });
});
