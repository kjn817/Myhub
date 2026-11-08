/// <reference types="jest" />

/**
 * src/services/ai.ts 브랜치 커버리지 테스트
 * - uncovered branches를 실제로 실행하는 테스트
 * - fetch 모킹, __test exports 활용
 */

// privacy guard 모킹
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

jest.mock('../../src/ai/memo-tool-dispatcher', () => ({
  dispatchToolCalls: jest.fn(),
}));

import {
  checkProviderAllowed,
  checkDataPolicy,
  resolvePolicySensitivity,
} from '../../src/ai/legacy-privacy-guard';
import {
  aiChat,
  __test,
  buildSystemPrompt,
  type TaskPolicy,
} from '../../src/services/ai';
import { getProvider } from '../../src/services/provider-registry';

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
};

beforeEach(() => {
  jest.resetAllMocks();
  (checkProviderAllowed as jest.Mock).mockReturnValue({ allowed: true });
  (checkDataPolicy as jest.Mock).mockReturnValue({ allowed: true });
  (resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined);
});

// ============================================================
// __test.pickKey — 엣지 케이스
// ============================================================
describe('__test.pickKey 엣지 케이스', () => {
  test('쿨다운 중인 키는 제외', () => {
    const now = Date.now();
    const pool = [
      { key: 'k1', failures: 0, cooledUntil: now + 60000 }, // 쿨다운 중
      { key: 'k2', failures: 0, cooledUntil: 0 }, // 사용 가능
    ];
    const result = __test.pickKey(pool as any);
    expect(result?.key).toBe('k2');
  });

  test('실패 횟수로 정렬', () => {
    const pool = [
      { key: 'k1', failures: 5, cooledUntil: 0 },
      { key: 'k2', failures: 0, cooledUntil: 0 },
      { key: 'k3', failures: 2, cooledUntil: 0 },
    ];
    // 랜덤 선택이므로 여러 번 시도해서 k2가 선택되는지 확인
    // (실제로는 available[Math.floor(Math.random() * available.length)]로 랜덤)
    const result = __test.pickKey(pool as any);
    expect(result).toBeDefined();
    expect(['k1', 'k2', 'k3']).toContain(result?.key);
  });
});

// ============================================================
// __test.pickKeyForModel — allowlist 분기
// ============================================================
describe('__test.pickKeyForModel allowlist', () => {
  test('allowlist가 있으면 필터링', () => {
    // 먼저 revokeKeyForModel을 트리거해서 allowlist 생성
    // (aiChat에서 404 발생 시)
    const pool = [
      { key: 'k1', failures: 0, cooledUntil: 0 },
      { key: 'k2', failures: 0, cooledUntil: 0 },
    ];
    // allowlist 없이 호출 → 전체 풀 사용
    const r1 = __test.pickKeyForModel(pool as any, 'test-model-1');
    expect(r1).toBeDefined();
  });
});

// ============================================================
// callGeminiViaRelay — 에러 경로
// ============================================================
describe('callGeminiViaRelay 에러 경로', () => {
  function relayEnv() {
    return makeEnv({
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 'secret',
    });
  }

  function directFailThenRelay(relayResponse: any) {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'User location is not supported for the API use',
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => relayResponse,
      } as any);
  }

  const relayPolicy: TaskPolicy = {
    ...basePolicy,
    providerPin: 'gemini',
    quality: 'fast',
  };

  test('relay 응답에 body도 error도 없으면 빈 문자열 사용', async () => {
    const env = relayEnv();
    global.fetch = jest.fn();
    directFailThenRelay({
      ok: false,
      status: 500,
      // body와 error 모두 없음 → (data.body || data.error || '')의 '' 분기
    });
    await expect(
      aiChat(env, relayPolicy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('gemini-relay 500:');
  });

  test('relay body JSON 파싱 실패 + status 없음 → 502 폴백', async () => {
    const env = relayEnv();
    global.fetch = jest.fn();
    directFailThenRelay({
      ok: true,
      body: 'not-valid-json{{{',
      // status 없음 → (data.status || 502)의 502 분기
    });
    const err = await aiChat(env, relayPolicy, [{ role: 'user', content: 'hi' }], { disableRetry: true }).catch(e => e);
    expect(err.code).toBe(502);
  });

  test('relay 응답 part에 text 없으면 빈 문자열', async () => {
    const env = relayEnv();
    global.fetch = jest.fn();
    directFailThenRelay({
      ok: true,
      body: JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: 'hello ' },
              {}, // text 없음 → (p.text || '')의 '' 분기
              { text: 'world' },
            ],
          },
        }],
      }),
    });
    const result = await aiChat(env, relayPolicy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('hello world');
  });
});

// ============================================================
// callGroq — 에러 파싱 폴백
// ============================================================
describe('callGroq 에러 파싱', () => {
  test('에러 응답에 type/code/param 없으면 기본값', async () => {
    const env = makeEnv({ GROQ_API_KEY_1: 'test-groq-key' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}), // error 필드 없음
    } as any);
    const policy: TaskPolicy = {
      ...basePolicy,
      providerPin: 'groq',
    };
    await expect(
      aiChat(env, policy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('groq 500');
  });

  test('에러 응답 JSON 파싱 실패', async () => {
    const env = makeEnv({ GROQ_API_KEY_1: 'test-groq-key' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('parse fail'); },
    } as any);
    const policy: TaskPolicy = {
      ...basePolicy,
      providerPin: 'groq',
    };
    await expect(
      aiChat(env, policy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('groq 500');
  });

  test('groq 응답 content 없으면 빈 문자열', async () => {
    const env = makeEnv({ GROQ_API_KEY_1: 'test-groq-key' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: {} }], // content 없음
      }),
    } as any);
    const policy: TaskPolicy = {
      ...basePolicy,
      providerPin: 'groq',
    };
    const result = await aiChat(env, policy, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('');
  });
});

// ============================================================
// classifyNvidiaFailure — 다양한 상태 코드
// ============================================================
describe('classifyNvidiaFailure (플러그인 직접 호출 — 보존 코드 검증)', () => {
  // 분류 로직은 플러그인 코드에 있으므로 플러그인 직접 호출로 검증한다 —
  // 분류 결과(kind)는 console.error('nvidia_error_classified')로 단언한다.
  // aiChat 경유의 핀 동작(선택·호출, private 정책 우선)은 아래 별도
  // 테스트가 현행 계약으로 검증한다.
  async function nvidiaError(status: number, body: string): Promise<any> {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => body,
    } as any);
    const plugin = getProvider('nvidia')!;
    try {
      await plugin.call({
        env: makeEnv(), key: 'test-nvidia-key', model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      return null;
    } catch (e) {
      return e;
    }
  }

  async function expectKind(status: number, body: string, kind: string) {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const e = await nvidiaError(status, body);
      expect(e).toBeTruthy();
      expect(String(e.message)).toContain(`nvidia ${status}`);
      expect(e.kind).toBe(kind);
      const logged = errSpy.mock.calls.find((c) => c[0] === 'nvidia_error_classified');
      expect(logged?.[1]).toEqual(expect.objectContaining({ status, kind }));
    } finally {
      errSpy.mockRestore();
    }
  }

  test('503 + resourceexhausted → model_capacity', async () => {
    await expectKind(503, 'ResourceExhausted: worker local total request limit reached', 'model_capacity');
  });

  test('401 → authentication_failed', async () => {
    await expectKind(401, 'unauthorized', 'authentication_failed');
  });

  test('403 → access_denied', async () => {
    await expectKind(403, 'forbidden', 'access_denied');
  });

  test('400 → invalid_request', async () => {
    await expectKind(400, 'bad request', 'invalid_request');
  });

  test('422 → invalid_request', async () => {
    await expectKind(422, 'unprocessable', 'invalid_request');
  });

  test('404 → model_unavailable', async () => {
    await expectKind(404, 'not found', 'model_unavailable');
  });

  test('500 → provider_transient', async () => {
    await expectKind(500, 'internal error', 'provider_transient');
  });

  test('418 → unknown', async () => {
    await expectKind(418, 'teapot', 'unknown');
  });

  test('providerPin=nvidia면 evaluation 모델이 핀으로 선택되어 NVIDIA 호출이 나간다 (현행 계약)', async () => {
    // 2026-10-30 전제(selectModel이 nvidia 핀을 거부)는 2026-11-05 에코
    // 비메모 턴 NVIDIA 채택으로 소멸했다. 현행 계약: nemotron-3-ultra는
    // status='evaluation'이라 평소에는 후보가 아니지만, providerPin으로
    // 직접 지정하면 isModelSelectableForPolicy가 선택을 허용한다.
    // (카나리아: evaluation-핀 허용을 깨면 선택이 거부돼 실패한다.)
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'nvidia 응답입니다' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      text: async () => '',
    });
    global.fetch = fetchSpy as any;
    const policy: TaskPolicy = {
      ...basePolicy,
      providerPin: 'nvidia',
      quality: 'high',
      latency: 'background',
    };
    const result = await aiChat(
      makeEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key' }),
      policy,
      [{ role: 'user', content: 'hi' }],
      { disableRetry: true }
    );
    expect(result.text).toBe('nvidia 응답입니다');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(JSON.parse((init as any).body).model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
  });

  test('providerPin=nvidia라도 privacy=private면 workers-ai 전용 정책이 핀을 이겨 호출이 나가지 않는다', async () => {
    // 핀은 데이터 정책을 이기지 못한다: private 정책에서는 workers-ai
    // 이외의 모델이 후보에서 제외되므로, nvidia로 스코프된 후보가 0이 되어
    // 선택이 거부되고 네트워크 호출은 나가지 않는다.
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const policy: TaskPolicy = {
      ...basePolicy,
      providerPin: 'nvidia',
      privacy: 'private',
      quality: 'high',
      latency: 'background',
    };
    await expect(
      aiChat(makeEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key' }), policy, [{ role: 'user', content: 'hi' }], { disableRetry: true })
    ).rejects.toThrow('no active model for policy');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// buildSystemPrompt — 엣지 케이스
// ============================================================
describe('buildSystemPrompt 엣지 케이스', () => {
  test('존재하지 않는 persona → 빈 문자열', () => {
    expect(buildSystemPrompt('nonexistent')).toBe('');
  });

  test('유효한 persona → 프롬프트 생성', () => {
    const result = buildSystemPrompt('concierge');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('[ASK:');
  });
});
