/// <reference types="jest" />

/**
 * NVIDIA 메모 가드 (트랙 1) — docs/nvidia-terms-review-20261029.md 판정의
 * 코드 강제 검증.
 *
 * 핵심 성질:
 * - 메모 컨텍스트가 실리거나 실릴 수 있는 keeper 요청에서는 NVIDIA
 *   엔드포인트(integrate.api.nvidia.com)로 fetch가 절대 나가지 않는다
 *   (FC 후속 호출 포함).
 * - 메모와 무관한 keeper 요청(뉴스 턴 등)은 NVIDIA를 유지한다.
 * - workers-ai 폴백이 실패해도 NVIDIA로 떨어지지 않는다.
 * - 라우팅을 우회한 NVIDIA 호출은 직전 가드가 중단한다.
 *
 * 카나리아: classifyMemoContext를 항상 false로 되돌리면 라우팅 테스트가
 * 실패해야 한다 (수동 확인 기록은 트랙 보고서 참조).
 */

// privacy guard 모킹 (svc4-ai.test.ts와 같은 방식 — 민감도 분기 결정성 확보)
jest.mock('../../src/ai/legacy-privacy-guard', () => {
  const actual = jest.requireActual('../../src/ai/legacy-privacy-guard');
  return {
    ...actual,
    checkProviderAllowed: jest.fn(),
    checkDataPolicy: jest.fn(),
    resolvePolicySensitivity: jest.fn(),
  };
});

// memo-tool-dispatcher 모킹 (FC 실행 결과는 테스트가 통제한다)
jest.mock('../../src/ai/memo-tool-dispatcher', () => ({
  dispatchToolCalls: jest.fn(),
}));

import { dispatchToolCalls } from '../../src/ai/memo-tool-dispatcher';
import {
  checkProviderAllowed,
  checkDataPolicy,
  resolvePolicySensitivity,
} from '../../src/ai/legacy-privacy-guard';
import { aiChat, type TaskPolicy, type ChatMessage } from '../../src/services/ai';
import {
  classifyMemoContext,
  resolveEffectivePolicy,
  findMemoContentInMessages,
  assertNoMemoContentForNvidia,
  NvidiaMemoGuardError,
  MEMO_TOOL_NAMES,
} from '../../src/services/nvidia-memo-guard';

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

function makeMockDb(overrides: any = {}): any {
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(overrides.first ?? null),
        all: jest.fn().mockResolvedValue(overrides.all ?? { results: [] }),
        run: jest.fn().mockResolvedValue(overrides.run ?? {}),
      }),
    }),
  };
}

function nvidiaOkResponse(text = 'NVIDIA 응답'): any {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  };
}

const keeperNvidiaPolicy: TaskPolicy = {
  capability: 'chat',
  privacy: 'external-ok',
  latency: 'interactive',
  quality: 'balanced',
  personaId: 'keeper',
  providerPin: 'nvidia',
};

beforeEach(() => {
  (resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined);
  (checkProviderAllowed as jest.Mock).mockReturnValue({ allowed: true });
  (checkDataPolicy as jest.Mock).mockReturnValue({ allowed: true });
  (dispatchToolCalls as jest.Mock).mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 분류 (구조적 신호)
// ---------------------------------------------------------------------------

describe('classifyMemoContext', () => {
  const cleanMessages: ChatMessage[] = [{ role: 'user', content: '오늘 뉴스 알려줘' }];

  test('메모 FC 도구가 포함되면 memo 컨텍스트로 분류한다', () => {
    const c = classifyMemoContext({
      policy: keeperNvidiaPolicy,
      messages: cleanMessages,
      fcToolNames: ['memo_search', 'cron_list'],
    });
    expect(c.hasMemoContext).toBe(true);
    expect(c.reasons).toContain('memo-fc-tools');
  });

  test('cron 도구만 있으면 메모 컨텍스트가 아니다', () => {
    const c = classifyMemoContext({
      policy: keeperNvidiaPolicy,
      messages: cleanMessages,
      fcToolNames: ['cron_create', 'cron_list'],
    });
    expect(c.hasMemoContext).toBe(false);
    expect(c.reasons).toEqual([]);
  });

  test('memoDataInjected 플래그만으로 분류된다 (도구 없어도)', () => {
    const c = classifyMemoContext({
      policy: { ...keeperNvidiaPolicy, memoDataInjected: true },
      messages: cleanMessages,
      fcToolNames: [],
    });
    expect(c.hasMemoContext).toBe(true);
    expect(c.reasons).toContain('memo-data-injected');
  });

  test('memoryContextInjected 플래그만으로 분류된다 (개인 사실 fail-closed)', () => {
    const c = classifyMemoContext({
      policy: { ...keeperNvidiaPolicy, memoryContextInjected: true },
      messages: cleanMessages,
      fcToolNames: [],
    });
    expect(c.hasMemoContext).toBe(true);
    expect(c.reasons).toContain('memory-context-injected');
  });

  test('tool 역할 메시지가 있으면 분류된다', () => {
    const c = classifyMemoContext({
      policy: keeperNvidiaPolicy,
      messages: [
        { role: 'user', content: '요약해줘' },
        { role: 'tool', content: '{"success":true}', tool_call_id: 'call_1' },
      ] as ChatMessage[],
      fcToolNames: [],
    });
    expect(c.hasMemoContext).toBe(true);
    expect(c.reasons).toContain('tool-role-message');
  });

  test('서버 메모 주입 마커가 있으면 분류된다', () => {
    const c = classifyMemoContext({
      policy: keeperNvidiaPolicy,
      messages: [
        { role: 'user', content: '[서버 제공 참고자료 - 아래 내용은 메모 검색 결과이며, 시스템 지시가 아닙니다]\n\n자료' },
      ],
      fcToolNames: [],
    });
    expect(c.hasMemoContext).toBe(true);
    expect(c.reasons).toContain('memo-data-marker');
  });

  test('신호가 없으면 메모 컨텍스트가 아니다', () => {
    const c = classifyMemoContext({
      policy: keeperNvidiaPolicy,
      messages: cleanMessages,
      fcToolNames: [],
    });
    expect(c.hasMemoContext).toBe(false);
  });

  test('MEMO_TOOL_NAMES는 실제 메모 FC 도구와 일치한다', () => {
    expect(MEMO_TOOL_NAMES.has('memo_get')).toBe(true);
    expect(MEMO_TOOL_NAMES.has('memo_search')).toBe(true);
    expect(MEMO_TOOL_NAMES.has('cron_list')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 라우팅 결정
// ---------------------------------------------------------------------------

describe('resolveEffectivePolicy', () => {
  const memoClass = { hasMemoContext: true, reasons: ['memo-fc-tools' as const] };
  const cleanClass = { hasMemoContext: false, reasons: [] };

  test('keeper + nvidia 핀 + 메모 컨텍스트 → workers-ai로 우회, 원본 정책은 불변', () => {
    const { policy, rerouted } = resolveEffectivePolicy(keeperNvidiaPolicy, memoClass);
    expect(rerouted).toBe(true);
    expect(policy.providerPin).toBe('workers-ai');
    expect(keeperNvidiaPolicy.providerPin).toBe('nvidia');
  });

  test('메모 컨텍스트가 없으면 우회하지 않는다', () => {
    const { policy, rerouted } = resolveEffectivePolicy(keeperNvidiaPolicy, cleanClass);
    expect(rerouted).toBe(false);
    expect(policy).toBe(keeperNvidiaPolicy);
  });

  test('keeper가 아니고 핀도 nvidia가 아니면 (gemini 고정) 건드리지 않는다', () => {
    const concierge: TaskPolicy = { ...keeperNvidiaPolicy, personaId: 'concierge', providerPin: 'gemini' };
    const { rerouted } = resolveEffectivePolicy(concierge, memoClass);
    expect(rerouted).toBe(false);
  });

  test('keeper라도 핀이 nvidia가 아니면 건드리지 않는다 (2026-11-05 핀 기준 축소 — 판정은 핀만으로, 번들 계약)', () => {
    const noPin: TaskPolicy = { capability: 'summarize', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', personaId: 'keeper' };
    const { policy, rerouted } = resolveEffectivePolicy(noPin, memoClass);
    expect(rerouted).toBe(false);
    expect(policy).toBe(noPin);
  });
});

// ---------------------------------------------------------------------------
// 호출 직전 가드 (단독)
// ---------------------------------------------------------------------------

describe('assertNoMemoContentForNvidia / findMemoContentInMessages', () => {
  test('tool 역할 메시지가 있으면 차단한다', () => {
    const msgs = [{ role: 'tool', content: '{"success":true,"toolName":"memo_get"}' }] as any;
    expect(findMemoContentInMessages(msgs)).toBe('tool-role-message');
    expect(() => assertNoMemoContentForNvidia(msgs)).toThrow(NvidiaMemoGuardError);
  });

  test('메모 주입 마커가 있으면 차단한다', () => {
    const msgs = [{ role: 'user', content: '[서버 제공 참고자료 - 메모 검색 결과] 본문' }] as any;
    expect(findMemoContentInMessages(msgs)).toBe('memo-data-marker');
    expect(() => assertNoMemoContentForNvidia(msgs)).toThrow(NvidiaMemoGuardError);
  });

  test('이력에 남은 메모 도구 결과 JSON이 있으면 차단한다 (휴리스틱 2차 방어)', () => {
    const msgs = [
      { role: 'assistant', content: '{"toolName":"memo_get","data":{"text":"메모 전문"}}' },
      { role: 'user', content: '오늘 뉴스 알려줘' },
    ] as any;
    expect(findMemoContentInMessages(msgs)).toBe('memo-tool-result-json');
    expect(() => assertNoMemoContentForNvidia(msgs)).toThrow(NvidiaMemoGuardError);
  });

  test('깨끗한 메시지는 통과한다', () => {
    const msgs = [
      { role: 'system', content: '너는 비서야' },
      { role: 'user', content: '오늘 뉴스 알려줘' },
    ] as any;
    expect(findMemoContentInMessages(msgs)).toBeNull();
    expect(() => assertNoMemoContentForNvidia(msgs)).not.toThrow();
  });

  test('가드 오류는 retryable=false + 전용 코드 (폴백 체인 즉시 중단용)', () => {
    try {
      assertNoMemoContentForNvidia([{ role: 'tool', content: 'x' }] as any);
      fail('should throw');
    } catch (e: any) {
      expect(e.code).toBe('NVIDIA_MEMO_GUARD_BLOCKED');
      expect(e.retryable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// aiChat 통합 — 라우팅
// ---------------------------------------------------------------------------

describe('aiChat NVIDIA 가드 (통합)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function fetchSpy(impl?: any): jest.Mock {
    const spy = jest.fn(impl ?? (async () => nvidiaOkResponse()));
    global.fetch = spy as any;
    return spy;
  }

  function nvidiaCalls(spy: jest.Mock): any[] {
    return spy.mock.calls.filter((c) => String(c[0]).includes('integrate.api.nvidia.com'));
  }

  test('keeper 메모 턴: FC 후속 호출(메모 전문 포함)까지 NVIDIA로 나가지 않는다', async () => {
    const fetch = fetchSpy();
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_get', data: { id: 42, text: '일반 메모 전문 — 차량 담당 회의 정리' } },
    ]);
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_get', arguments: { id: 42 } }],
        })
        .mockResolvedValueOnce({ response: '메모를 요약했어.' }),
    };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;

    const result = await aiChat(env, keeperNvidiaPolicy, [
      { role: 'user', content: '차량담당 메모 요약해줘' },
    ]);

    expect(result.text).toBe('메모를 요약했어.');
    expect(result.provider).toBe('workers-ai');
    // NVIDIA 엔드포인트로 fetch가 절대 나가지 않았다
    expect(nvidiaCalls(fetch)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    // 메모 전문은 workers-ai 후속 호출에만 실렸다
    expect(mockAi.run).toHaveBeenCalledTimes(2);
    const followUpMessages = mockAi.run.mock.calls[1][1].messages;
    const toolMsg = followUpMessages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain('차량 담당 회의 정리');
    // 관측 로그: 사유는 남고 내용은 남지 않는다
    const rerouteLog = infoSpy.mock.calls.find((c) => c[0] === 'nvidia_guard_reroute');
    expect(rerouteLog).toBeDefined();
    expect(JSON.stringify(rerouteLog)).toContain('memo-fc-tools');
    expect(JSON.stringify(rerouteLog)).not.toContain('차량 담당');
  });

  test('keeper + memoDataInjected 플래그: 도구가 뉴스뿐이어도 우회된다 (서버 사전 검색 주입)', async () => {
    const fetch = fetchSpy();
    const mockAi = { run: jest.fn().mockResolvedValue({ response: '자료 기반 답변' }) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;
    const policy: TaskPolicy = { ...keeperNvidiaPolicy, memoDataInjected: true };

    const result = await aiChat(env, policy, [{ role: 'user', content: '오늘 뉴스 알려줘' }]);

    expect(result.provider).toBe('workers-ai');
    expect(nvidiaCalls(fetch)).toHaveLength(0);
  });

  test('keeper + memoryContextInjected 플래그: 개인 사실 주입 턴도 우회된다', async () => {
    const fetch = fetchSpy();
    const mockAi = { run: jest.fn().mockResolvedValue({ response: '기억 기반 답변' }) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;
    const policy: TaskPolicy = { ...keeperNvidiaPolicy, memoryContextInjected: true };

    const result = await aiChat(env, policy, [{ role: 'user', content: '오늘 뉴스 알려줘' }]);

    expect(result.provider).toBe('workers-ai');
    expect(nvidiaCalls(fetch)).toHaveLength(0);
  });

  test('ai_settings 오버라이드가 NVIDIA 모델을 가리켜도 우회 후에는 선택되지 않는다', async () => {
    const fetch = fetchSpy();
    const mockAi = { run: jest.fn().mockResolvedValue({ response: '요약 완료' }) };
    // model.summarize 오버라이드 = NVIDIA 모델 (운영의 model.summarize=nvidia 상태 재현)
    const db = makeMockDb({ first: { value: 'nvidia/nemotron-3-ultra-550b-a55b' } });
    const env = { DB: db, NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;
    const policy: TaskPolicy = { ...keeperNvidiaPolicy, capability: 'summarize' };

    const result = await aiChat(env, policy, [{ role: 'user', content: '메모 찾아줘' }]);

    expect(result.provider).toBe('workers-ai');
    expect(result.model).not.toContain('nvidia');
    expect(nvidiaCalls(fetch)).toHaveLength(0);
  });

  test('메모 무관 keeper 뉴스 턴은 NVIDIA로 처리된다 (2026-11-05 채택)', async () => {
    // 2026-11-05 실측 판정: 에코 비메모 턴은 NVIDIA가 담당한다. 메모 가드는
    // 메모 컨텍스트 턴만 workers-ai로 우회하고 뉴스 같은 비메모 턴은 막지
    // 않는다 (이 파일의 다른 테스트들이 메모 턴 우회를 계속 검증한다).
    const fetch = fetchSpy(async () => nvidiaOkResponse('오늘 뉴스 요약'));
    const mockAi = { run: jest.fn().mockResolvedValue({ response: 'workers 응답' }) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;

    const result = await aiChat(env, keeperNvidiaPolicy, [{ role: 'user', content: '오늘 뉴스 알려줘' }]);

    expect(result.provider).toBe('nvidia');
    expect(result.model).toContain('nemotron');
    expect(result.text).toBe('오늘 뉴스 요약');
    expect(nvidiaCalls(fetch)).toHaveLength(1);
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  test('폴백 우회 불가: workers-ai가 계속 실패해도 NVIDIA로 떨어지지 않는다', async () => {
    const fetch = fetchSpy();
    const mockAi = { run: jest.fn().mockRejectedValue(new Error('workers-ai down')) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;

    await expect(
      aiChat(env, keeperNvidiaPolicy, [{ role: 'user', content: '메모 찾아줘' }])
    ).rejects.toThrow('workers-ai down');

    // 시도 횟수만큼 workers-ai 안에서만 폴백했고 NVIDIA fetch는 0건
    expect(mockAi.run).toHaveBeenCalledTimes(4);
    expect(nvidiaCalls(fetch)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// aiChat 통합 — 턴 일관성 (skillText)
// 라이브 QA 발견: 에코 뉴스 턴의 [SEARCH:] 후속 호출은 합성 프롬프트가
// 마지막 user 메시지라, 마지막 user 텍스트 기준으로 스킬을 결정하면
// 뉴스 스킬에 매칭되지 않고 keeper 기본 스킬(메모+자동화)로 떨어져
// ① 가드가 workers-ai로 우회하고 ② 메모 도구까지 부착됐다.
// 수정: policy.skillText(턴 원본 사용자 텍스트)로 가드 분류와 FC 도구
// 결정을 모두 고정한다.
// 카나리아: aiChat이 skillText를 무시하고 마지막 user 텍스트를 쓰도록
// 되돌리면 아래 첫 케이스(NVIDIA 유지)가 실패해야 한다.
// ---------------------------------------------------------------------------

describe('aiChat 턴 일관성 (skillText)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function fetchSpy(impl?: any): jest.Mock {
    const spy = jest.fn(impl ?? (async () => nvidiaOkResponse()));
    global.fetch = spy as any;
    return spy;
  }

  function nvidiaCalls(spy: jest.Mock): any[] {
    return spy.mock.calls.filter((c) => String(c[0]).includes('integrate.api.nvidia.com'));
  }

  // 합성 검색 후속 프롬프트를 본뜬 텍스트: 스킬 키워드(뉴스·메모·일정·
  // 자동화 등)를 하나도 포함하지 않아, 단독으로 resolveSkillsForTurn에
  // 넣으면 매칭이 없어 keeper 기본 스킬(메모+자동화)로 떨어진다.
  const SYNTHETIC_SEARCH_PROMPT =
    '위 웹검색 결과를 바탕으로 답변을 완성해줘. 검색 결과: ' +
    '1. 기사 제목\n   URL: https://example.com/a\n   내용: 기사 본문 발췌';

  test('skillText=뉴스 의도 + 합성 검색 프롬프트여도 NVIDIA를 유지한다 (턴 분류 고정)', async () => {
    // skillText가 턴 분류를 뉴스로 고정하므로, 마지막 user 메시지가 합성
    // 프롬프트여도 keeper 기본 스킬(메모)로 떨어지지 않는다.
    // 카나리아: skillText를 무시하고 마지막 user 텍스트로 분류하면 합성
    // 프롬프트가 메모로 분류돼 workers-ai로 우회하고 이 테스트가 실패한다.
    const fetch = fetchSpy(async () => nvidiaOkResponse('뉴스 최종 답변'));
    const mockAi = { run: jest.fn().mockResolvedValue({ response: 'workers 응답' }) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;
    const policy: TaskPolicy = { ...keeperNvidiaPolicy, skillText: '오늘 뉴스 알려줘' };

    const result = await aiChat(env, policy, [
      { role: 'system', content: '너는 비서야' },
      { role: 'user', content: '오늘 뉴스 알려줘' },
      { role: 'assistant', content: '[SEARCH: 테스트 주제]' },
      { role: 'user', content: SYNTHETIC_SEARCH_PROMPT },
    ]);

    expect(result.provider).toBe('nvidia');
    expect(result.text).toBe('뉴스 최종 답변');
    expect(nvidiaCalls(fetch).length).toBeGreaterThan(0);
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  test('skillText=메모 의도 + 합성 후속 메시지여도 workers-ai 우회 유지 + 메모 도구 부착', async () => {
    const fetch = fetchSpy();
    const mockAi = { run: jest.fn().mockResolvedValue({ response: '메모 기반 답변' }) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;
    const policy: TaskPolicy = { ...keeperNvidiaPolicy, skillText: '차량담당 메모 요약해줘' };

    const result = await aiChat(env, policy, [
      { role: 'user', content: '차량담당 메모 요약해줘' },
      { role: 'assistant', content: '[SEARCH: 테스트 주제]' },
      { role: 'user', content: SYNTHETIC_SEARCH_PROMPT },
    ]);

    expect(result.provider).toBe('workers-ai');
    expect(result.text).toBe('메모 기반 답변');
    expect(nvidiaCalls(fetch)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    // 턴 도구 집합은 메모로 고정된다 (workers-ai 첫 호출에 메모 도구 부착)
    expect(mockAi.run).toHaveBeenCalled();
    const firstParams = mockAi.run.mock.calls[0][1];
    // 도구는 OpenAI 래퍼 형식으로 전달된다 (2026-10-30 mistral 트랙 — 평형식은 8007 원인)
    const toolNames = (firstParams.tools || []).map((t: any) => t.function?.name);
    expect(toolNames).toContain('memo_get');
  });

  test('skillText=뉴스여도 memoDataInjected 플래그가 있으면 우회 유지 (독립 신호)', async () => {
    const fetch = fetchSpy();
    const mockAi = { run: jest.fn().mockResolvedValue({ response: '자료 기반 답변' }) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;
    const policy: TaskPolicy = {
      ...keeperNvidiaPolicy,
      skillText: '오늘 뉴스 알려줘',
      memoDataInjected: true,
    };

    const result = await aiChat(env, policy, [
      { role: 'user', content: '오늘 뉴스 알려줘' },
      { role: 'assistant', content: '[SEARCH: 테스트 주제]' },
      { role: 'user', content: SYNTHETIC_SEARCH_PROMPT },
    ]);

    expect(result.provider).toBe('workers-ai');
    expect(nvidiaCalls(fetch)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// aiChat 통합 — 호출 직전 가드 (라우팅 우회 강제)
// ---------------------------------------------------------------------------

describe('aiChat 호출 직전 가드 (통합)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('이력에 메모 도구 결과 JSON이 남은 NVIDIA 호출은 호출 직전 가드가 중단한다', async () => {
    const fetch = jest.fn(async () => nvidiaOkResponse());
    global.fetch = fetch as any;
    const mockAi = { run: jest.fn().mockResolvedValue({ response: 'workers 응답' }) };
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key', AI: mockAi } as any;

    // 진입부 분류(구조 신호)로는 잡히지 않는 형태: assistant 이력 속 JSON.
    // 마지막 사용자 메시지는 뉴스 턴이라 FC 메모 도구 신호도 없다.
    // 진입부 우회는 일어나지 않지만, 모델 호출 직전 가드
    // (assertNoMemoContentForNvidia)가 이력 전체를 스캔해 차단한다.
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '{"toolName":"memo_get","data":{"text":"이전 턴 메모 전문"}}' },
      { role: 'user', content: '오늘 뉴스 알려줘' },
    ];

    let caught: any;
    try {
      await aiChat(env, keeperNvidiaPolicy, messages);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NvidiaMemoGuardError);
    expect(String(caught?.message)).toContain('NVIDIA memo guard blocked the call');
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  test('NVIDIA 턴에서는 FC 루프가 열리지 않는다: 도구가 부착·실행되지 않고 1회 호출로 완주한다', async () => {
    // 현행 구조: FC(useFC)는 workers-ai 전용이라 NVIDIA 호출에는 도구가
    // 붙지 않고 도구 실행·후속 호출 자체가 일어나지 않는다. 따라서 메모
    // 도구가 NVIDIA 경로에서 실행될 경로는 구조적으로 없다.
    // (후속 호출 가드 assertNoMemoDerivedContentForNvidia는 이중 방어로
    // 코드에 남아 있고, 그 단위 검증은 assert 함수 테스트가 담당한다.)
    const fetch = jest.fn(async () => nvidiaOkResponse());
    global.fetch = fetch as any;
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_get', data: { id: 42, text: '메모 전문 — 후속 호출로 나가면 안 됨' } },
    ]);
    const env = { DB: makeMockDb(), NVIDIA_API_KEY_1: 'test-nvidia-key' } as any;

    const result = await aiChat(env, keeperNvidiaPolicy, [{ role: 'user', content: '오늘 뉴스 알려줘' }]);

    expect(result.provider).toBe('nvidia');
    expect(fetch).toHaveBeenCalledTimes(1);
    // 도구 미부착: NVIDIA 요청 본문에 tools 키가 없다
    const sentBody = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    expect(sentBody.tools).toBeUndefined();
    expect(dispatchToolCalls).not.toHaveBeenCalled();
  });
});
