/// <reference types="jest" />

/**
 * FC 경로 결정적 확인 문구 회귀 테스트 (2026-10-30, promptfoo 라이브 게이트)
 *
 * 배경 — 2026-10-30 라이브 게이트 실측:
 * - 회귀 3: 메모는 실제로 생성됐으나 응답에 결정적 문구가 없었다.
 *   마커 경로는 서버가 치환하지만 FC 경로는 후속 호출에서 모델이
 *   결과를 바꿔 말했다. (문구 자체는 이후 세대 교체로 현행
 *   "메모를 생성했습니다." / "일정을 등록했습니다: <제목>" — 번들 대조.)
 * - 회귀 2: keeper 일정 등록 턴에 schedule_create 도구가 없었고,
 *   preflight(메모 전용 검증기)가 cron/schedule 도구를 "Unknown tool"로
 *   거부하는 잠재 결함 + NVIDIA 후속 가드의 과잉 차단(tool 역할 전체 차단)
 *   때문에 비메모 FC 도구 자체가 완주할 수 없었다.
 *
 * 이 파일은 aiChat(실제 코드) + 프로바이더 목킹으로 위 경로를 종단 검증한다.
 * 도구 실행(dispatchToolCalls)만 목킹한다 — 실행기의 실제 DB 동작은
 * ai-schedule-fc-tools.test.ts가 담당한다.
 */

// privacy guard 모킹 (svc4-ai.test.ts와 같은 방식 — selectModel 민감도 분기용)
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

// memo-tool-dispatcher 모킹 (FC 실행 결과는 테스트가 통제한다)
jest.mock('../../src/ai/memo-tool-dispatcher', () => ({
  dispatchToolCalls: jest.fn(),
}));

// 승인 게이트 (D1 정렬, 2026-10-31): 이 파일은 FC 루프의 결정적 문구·
// preflight·출처 게이트 성질을 본다. 승인 판정 자체는 fc-approval-gate
// 전용 스위트(tests/fc-approval-gate.test.ts)가 실제 저장소로 검증하므로,
// 여기서는 게이트를 allow로 고정한다. 출처 게이트(scheduled deny)는
// ai.ts 루프가 게이트보다 먼저 적용하므로 이 목킹과 무관하게 검증된다.
jest.mock('../../src/services/fc-approval-gate', () => {
  const actual = jest.requireActual('../../src/services/fc-approval-gate');
  return {
    ...actual,
    gateFCToolCall: jest.fn(async () => ({ action: 'allow', approvalTool: 'MEMO_CREATE' })),
  };
});

import { dispatchToolCalls } from '../../src/ai/memo-tool-dispatcher';
import { aiChat, type TaskPolicy } from '../../src/services/ai';
import {
  findMemoDerivedContentInMessages,
  assertNoMemoDerivedContentForNvidia,
  NvidiaMemoGuardError,
} from '../../src/services/nvidia-memo-guard';

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

function makeEnv(overrides: any = {}): any {
  return { DB: makeMockDb(), ...overrides };
}

const keeperWorkersPolicy: TaskPolicy = {
  capability: 'chat',
  privacy: 'external-ok',
  latency: 'interactive',
  quality: 'balanced',
  personaId: 'keeper',
  providerPin: 'workers-ai',
  // 대화형 채팅 턴을 대표하는 픽스처 (③-A: FC 쓰기 게이트가 origin을 본다)
  origin: 'interactive',
};

describe('FC 경로 결정적 확인 문구 (회귀 2·3)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    (dispatchToolCalls as jest.Mock).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('회귀 3: memo_create 성공 시 모델이 바꿔 말해도 "메모를 생성했습니다"가 응답에 있다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "[EVAL] 라이브 eval 테스트 메모입니다."}' }],
        })
        // 라이브 실측에서 실제로 나온 바꿔 말한 문구
        .mockResolvedValueOnce({
          response: '"라이브 eval 테스트 메모" 제목의 메모가 성공적으로 생성되었습니다. 메모 ID는 214입니다.',
        }),
    };
    // 실제 디스패처의 반환 계약: 원장 기록 후 ledgerRecorded:true가 붙는다.
    // 이게 있어야 루프가 성공을 "원장 검증됨"으로 인정해 결정적 문구를 붙인다.
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_create', data: { id: 214 }, ledgerRecorded: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '[EVAL] 라이브 eval 테스트 메모입니다. 이 내용을 메모로 만들어줘.' },
    ]);
    // 현행 결정적 문구 (번들 대조): 원장 검증 + 숫자 id가 있을 때 서버가 앞에 붙인다
    expect(result.text).toContain('메모를 생성했습니다.');
    expect(result.text).not.toContain('실행 기록을 확인하지 못해');
    // 모델의 본문도 버려지지 않고 함께 남는다
    expect(result.text).toContain('성공적으로 생성되었습니다');
    expect((result as any).dataChanged).toBe(true);
  });

  test('회귀 3: 모델이 이미 결정적 문구를 냈으면 중복해서 붙이지 않는다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "메모 내용"}' }],
        })
        .mockResolvedValueOnce({ response: '메모를 생성했습니다.' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_create', data: { id: 214 }, ledgerRecorded: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ]);
    expect(result.text.match(/메모를 생성했습니다/g)).toHaveLength(1);
    expect(result.text).toBe('메모를 생성했습니다.');
  });

  test('회귀 3: 결과에 숫자 id가 없으면 문구를 지어내지 않는다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "메모 내용"}' }],
        })
        .mockResolvedValueOnce({ response: '생성했습니다.' }),
    };
    // 원장 검증은 됐지만 숫자 id가 없는 결과 — 서버가 문구를 지어내면 안 된다
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_create', ledgerRecorded: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ]);
    expect(result.text).toBe('생성했습니다.');
  });

  test('회귀 2: keeper 일정 등록 턴 — schedule_create가 실행되고 "일정을 등록했습니다: <제목>"이 응답에 있다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{
            name: 'schedule_create',
            arguments: '{"title": "[EVAL] eval 일정 테스트", "start_at": "2026-10-31T15:00:00"}',
          }],
        })
        .mockResolvedValueOnce({ response: '일정을 등록했습니다.' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'schedule_create', data: { id: 7, todo_id: 8 }, ledgerRecorded: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: "내일 오후 3시에 '[EVAL] eval 일정 테스트' 일정을 등록해줘." },
    ]);
    // 모델에게 실제로 schedule_create 도구가 부착됐어야 한다 (스킬 로드 증거)
    const firstCallTools = mockAi.run.mock.calls[0][1].tools || [];
    expect(firstCallTools.some((t: any) => (t.function?.name || t.name) === 'schedule_create')).toBe(true);
    // preflight가 schedule_create를 "Unknown tool"로 거부하면 dispatch 자체가 없다
    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    const dispatched = (dispatchToolCalls as jest.Mock).mock.calls[0][1];
    expect(dispatched[0].name).toBe('schedule_create');
    expect(dispatched[0].arguments.title).toBe('[EVAL] eval 일정 테스트');
    expect(result.text).toContain('일정을 등록했습니다: [EVAL] eval 일정 테스트');
    expect(result.text).not.toContain('실행 기록을 확인하지 못해');
    expect((result as any).dataChanged).toBe(true);
  });

  test('preflight 구제: cron_create도 "Unknown tool"로 거부되지 않고 실행된다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'cron_create', arguments: { text: '매일 아침 8시에 뉴스 요약해서 푸시해줘' } }],
        })
        .mockResolvedValueOnce({ response: '자동화를 저장했어.' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      // 번들 계약: 결정적 문구는 원장 기록(ledgerRecorded)이 검증된 결과에만 붙는다
      { success: true, toolName: 'cron_create', data: { id: 3 }, ledgerRecorded: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '매일 아침 8시에 뉴스 요약해서 푸시해줘' },
    ]);
    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    const dispatched = (dispatchToolCalls as jest.Mock).mock.calls[0][1];
    expect(dispatched[0].name).toBe('cron_create');
    expect(result.text).toBe('자동화를 저장했어.');
  });

  test('회귀 2 (Workers AI): schedule_create 후속 호출이 완주하고 결정적 문구가 붙는다', async () => {
    // 구 사양의 회귀 2는 NVIDIA FC 후속 호출이 메모 가드의 tool-역할 과잉
    // 차단에 막히지 않는지를 봤다. 2026-10-30 NVIDIA 운영 제외로 에코 FC는
    // workers-ai 전용이 됐으므로, 같은 완주 성질(1차 도구 호출 → 실행 →
    // 후속 호출 → 결정적 문구)을 현행 provider로 검증한다. 가드 자체의
    // 비메모 도구 결과 통과 성질은 nvidia-memo-guard 단위 테스트가 담당.
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{
            name: 'schedule_create',
            arguments: '{"title": "[EVAL] eval 일정 테스트", "start_at": "2026-10-31T15:00:00"}',
          }],
        })
        .mockResolvedValueOnce({ response: '등록 완료' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'schedule_create', data: { id: 7, todo_id: 8 }, ledgerRecorded: true },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: "내일 오후 3시에 '[EVAL] eval 일정 테스트' 일정을 등록해줘." },
    ]);
    expect(result.provider).toBe('workers-ai');
    // 1차 + 후속 = 2회 호출 (후속이 중단되면 1회에서 끝난다)
    expect(mockAi.run).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('일정을 등록했습니다: [EVAL] eval 일정 테스트');
  });
});

describe('FC 출처 게이트 (Talorys ③-A) — aiChat FC 루프', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    (dispatchToolCalls as jest.Mock).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // 카나리아: 예약 출처에서 FC 쓰기 도구는 디스패처에 도달하면 안 된다.
  // ai.ts FC 루프의 origin 분기를 지우면 dispatch가 호출되어 실패한다.
  test('scheduled origin + memo_create → 디스패치 없이 non_interactive_origin 거부', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "예약 실행 메모"}' }],
        })
        .mockResolvedValueOnce({ response: '처리할 수 없습니다.' }),
    };
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, { ...keeperWorkersPolicy, origin: 'scheduled' }, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ]);
    expect(dispatchToolCalls).not.toHaveBeenCalled();
    const toolResults = (result as any).toolResults || [];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].success).toBe(false);
    expect(toolResults[0].error).toBe('non_interactive_origin');
    expect(result.text).not.toMatch(/메모를 생성했어 \(id:/);
  });

  test('origin 미지정 + schedule_create → 디스패치 없음 (fail-closed)', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{
            name: 'schedule_create',
            arguments: '{"title": "출처 없는 일정", "start_at": "2026-10-31T15:00:00"}',
          }],
        })
        .mockResolvedValueOnce({ response: '처리할 수 없습니다.' }),
    };
    const env = makeEnv({ AI: mockAi });
    const { origin: _omit, ...noOriginPolicy } = keeperWorkersPolicy;
    const result = await aiChat(env, noOriginPolicy, [
      { role: 'user', content: '일정 등록해줘.' },
    ]);
    expect(dispatchToolCalls).not.toHaveBeenCalled();
    const toolResults = (result as any).toolResults || [];
    expect(toolResults[0]?.error).toBe('non_interactive_origin');
  });

  test('scheduled origin + 읽기 도구(memo_search)는 현행대로 디스패치된다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_search', arguments: '{"query": "회의"}' }],
        })
        .mockResolvedValueOnce({ response: '검색 결과입니다.' }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_search', data: { memos: [] } },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, { ...keeperWorkersPolicy, origin: 'scheduled' }, [
      { role: 'user', content: '회의 메모 찾아줘.' },
    ]);
    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('검색 결과입니다.');
  });
});

describe('NVIDIA 후속 가드 — 메모 유래 판정 (단위)', () => {
  test('비메모 도구 결과(tool 역할)는 메모 유래가 아니다', () => {
    const msgs = [
      { role: 'tool', content: '{"success":true,"toolName":"cron_create","data":{"id":3}}' },
      { role: 'tool', content: '{"success":true,"toolName":"schedule_create","data":{"id":7}}' },
    ] as any;
    expect(findMemoDerivedContentInMessages(msgs)).toBeNull();
    expect(() => assertNoMemoDerivedContentForNvidia(msgs)).not.toThrow();
  });

  test('메모 도구 결과 JSON은 여전히 메모 유래로 잡힌다', () => {
    const msgs = [
      { role: 'tool', content: '{"success":true,"toolName":"memo_get","data":{"text":"메모 전문"}}' },
    ] as any;
    expect(findMemoDerivedContentInMessages(msgs)).toBe('memo-tool-result-json');
    expect(() => assertNoMemoDerivedContentForNvidia(msgs)).toThrow(NvidiaMemoGuardError);
  });

  test('서버 메모 주입 마커도 여전히 잡힌다', () => {
    const msgs = [{ role: 'user', content: '[서버 제공 참고자료 - 메모 검색 결과] 본문' }] as any;
    expect(findMemoDerivedContentInMessages(msgs)).toBe('memo-data-marker');
  });
});
