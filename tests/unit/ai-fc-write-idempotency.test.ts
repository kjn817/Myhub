/// <reference types="jest" />

/**
 * FC 메모 중복 생성 회귀 테스트 (2026-10-30 라이브 게이트 잔여 결함 2)
 *
 * 운영 실측으로 확정한 원인 체인 (promptfoo-20261030-020057, ai_chats 769/770):
 * 1. keeper 메모 턴은 NVIDIA 가드로 Workers AI로 우회된다.
 * 2. mistral 1차 시도가 memo_create를 실행해 메모 1건이 생성됐다.
 * 3. FC 후속 호출이 [.., tool, user(FC_FINAL_RULES)] 형태라 mistral(vLLM)이
 *    8007 "Unexpected role 'user' after role 'tool'"로 거부했다
 *    (ai_error_log id 179, ai_usage id 1060 failed → 1061 qwen success).
 * 4. 시도 전체가 실패로 올라가 qwen 폴백이 처음부터 다시 실행되면서
 *    memo_create를 재실행 — 재생성된(잘린) 변형으로 메모 2건째가 생겼다.
 *
 * 수정 (src/services/ai.ts):
 * - buildFCFollowUpMessages: tool 뒤에는 user를 붙이지 않고 규칙을
 *   system 메시지에 합친다 (8007 자체를 제거).
 * - 쓰기 성공 뒤 후속 호출이 실패해도 시도 전체를 실패로 올리지 않고
 *   결정적 확인 문구로 마감한다 (폴백 재실행 차단).
 * - fcWriteSignature 멱등성: 같은 턴에서 이미 성공한 동일 생성 호출은
 *   라운드·시도가 바뀌어도 재실행하지 않는다.
 *
 * 도구 실행(dispatchToolCalls)만 목킹한다 — ai-fc-deterministic-phrases와
 * 같은 방식. 실행기의 실제 DB 동작은 별도 스위트가 담당한다.
 */

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

// 승인 게이트 (D1 정렬, 2026-10-31): 이 파일은 FC 루프의 멱등성 성질을
// 본다. 승인 판정 자체는 fc-approval-gate 전용 스위트(tests/fc-approval-
// gate.test.ts)가 실제 저장소로 검증하므로, 여기서는 게이트를 allow로
// 고정해 "승인된 쓰기" 조건에서 루프 성질만 분리 검증한다.
jest.mock('../../src/services/fc-approval-gate', () => {
  const actual = jest.requireActual('../../src/services/fc-approval-gate');
  return {
    ...actual,
    gateFCToolCall: jest.fn(async () => ({ action: 'allow', approvalTool: 'MEMO_CREATE' })),
  };
});

import { dispatchToolCalls } from '../../src/ai/memo-tool-dispatcher';
import {
  aiChat,
  buildFCFollowUpMessages,
  fcWriteSignature,
  type TaskPolicy,
} from '../../src/services/ai';

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

const MEMO_TOOL_CALL = {
  response: '',
  tool_calls: [
    { name: 'memo_create', arguments: '{"text": "라이브 eval 테스트 메모입니다."}' },
  ],
};

beforeEach(() => {
  (dispatchToolCalls as jest.Mock).mockReset();
  // 실제 디스패처는 실행 결과를 원장에 기록한 뒤 ledgerRecorded:true를
  // 붙여 돌려준다 — 성공 결과의 현행 반환 계약이다. 이 필드가 없으면
  // 루프가 "원장 미검증 성공"으로 판정해 결정적 확인 문구 대신 확인
  // 불가 고지를 붙인다 (감사 A4의 반환 형태 계약).
  (dispatchToolCalls as jest.Mock).mockResolvedValue([
    { success: true, toolName: 'memo_create', data: { id: 216 }, ledgerRecorded: true },
  ]);
});

describe('buildFCFollowUpMessages — tool 뒤 user 금지', () => {
  test('마지막이 tool이면 규칙이 system에 합쳐지고 user가 뒤에 붙지 않는다', () => {
    const msgs: any[] = [
      { role: 'system', content: '시스템 프롬프트' },
      { role: 'user', content: '메모 만들어줘' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"success":true}' },
    ];
    const out = buildFCFollowUpMessages(msgs, 'FINAL_RULES');
    // 역할 순서 위반이 없어야 한다
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].role === 'tool' && out[i].role === 'user').toBe(false);
    }
    expect(out[out.length - 1].role).toBe('tool');
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('시스템 프롬프트');
    expect(out[0].content).toContain('FINAL_RULES');
    // 원본 배열은 변형하지 않는다
    expect(msgs[0].content).toBe('시스템 프롬프트');
  });

  test('system이 없으면 규칙을 담은 system을 앞에 세운다', () => {
    const out = buildFCFollowUpMessages(
      [
        { role: 'user', content: '메모 만들어줘' },
        { role: 'tool', tool_call_id: 'c1', content: '{}' },
      ] as any,
      'FINAL_RULES'
    );
    expect(out[0]).toEqual({ role: 'system', content: 'FINAL_RULES' });
    expect(out[out.length - 1].role).toBe('tool');
  });

  test('마지막이 tool이 아니면 기존처럼 user로 붙인다', () => {
    const out = buildFCFollowUpMessages(
      [{ role: 'user', content: '안녕' }] as any,
      'FINAL_RULES'
    );
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'FINAL_RULES' });
  });
});

describe('fcWriteSignature', () => {
  test('같은 생성 호출은 공백·NFC 차이에도 같은 서명이다', () => {
    const a = fcWriteSignature('memo_create', { text: '  메모 내용  ' });
    const b = fcWriteSignature('memo_create', { text: '메모 내용' });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test('다른 내용이면 다른 서명, 읽기 도구는 대상이 아니다', () => {
    expect(fcWriteSignature('memo_create', { text: 'a' })).not.toBe(
      fcWriteSignature('memo_create', { text: 'b' })
    );
    expect(fcWriteSignature('memo_search', { query: 'a' })).toBeNull();
    expect(fcWriteSignature('memo_delete', { id: 1 })).toBeNull();
    expect(fcWriteSignature('memo_create', { text: '   ' })).toBeNull();
    expect(
      fcWriteSignature('schedule_create', { title: '회의', start_at: '2026-10-31T15:00:00' })
    ).toBe('schedule_create:회의|2026-10-31T15:00:00');
  });
});

describe('aiChat FC — 중복 생성 방지 (라이브 체인 재현)', () => {
  test('후속 호출 메시지에 user-after-tool이 없고, 실행은 1회다', async () => {
    const seenMessages: any[][] = [];
    const mockAi = {
      run: jest
        .fn()
        .mockImplementation(async (_model: string, params: any) => {
          seenMessages.push(params.messages);
          if (seenMessages.length === 1) return MEMO_TOOL_CALL;
          return { response: '메모가 성공적으로 생성되었습니다. 메모 ID: 216' };
        }),
    };
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '[EVAL] 라이브 eval 테스트 메모입니다. 이 내용을 메모로 만들어줘.' },
    ]);
    expect((dispatchToolCalls as jest.Mock).mock.calls.length).toBe(1);
    expect(result.text).toContain('메모를 생성했습니다.');
    expect(result.text).not.toContain('실행 기록을 확인하지 못해');
    // 후속 호출(2번째)의 역할 순서를 실측 형태로 검증한다
    const followUp = seenMessages[1];
    expect(followUp).toBeDefined();
    for (let i = 1; i < followUp.length; i++) {
      expect(followUp[i - 1].role === 'tool' && followUp[i].role === 'user').toBe(false);
    }
    const systemMsgs = followUp.filter((m: any) => m.role === 'system');
    expect(systemMsgs.some((m: any) => String(m.content).includes('IMPORTANT RULES'))).toBe(true);
  });

  test('모델이 다음 라운드에서 같은 memo_create를 반복해도 재실행하지 않는다', async () => {
    const mockAi = {
      run: jest
        .fn()
        .mockResolvedValueOnce(MEMO_TOOL_CALL)
        // 후속 호출에서 모델이 같은 도구 호출을 또 낸다 (중복의 한 형태)
        .mockResolvedValueOnce(MEMO_TOOL_CALL)
        .mockResolvedValueOnce({ response: '메모가 성공적으로 생성되었습니다. 메모 ID: 216' }),
    };
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '[EVAL] 라이브 eval 테스트 메모입니다. 이 내용을 메모로 만들어줘.' },
    ]);
    expect((dispatchToolCalls as jest.Mock).mock.calls.length).toBe(1);
    expect(result.text).toContain('메모를 생성했습니다.');
    expect((result as any).dataChanged).toBe(true);
  });

  test('쓰기 성공 뒤 후속 호출이 실패하면 폴백 재실행 없이 결정적 문구로 마감한다', async () => {
    let callCount = 0;
    const mockAi = {
      run: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return MEMO_TOOL_CALL;
        // 라이브 실측의 mistral 8007을 포함해 어떤 후속 실패든 재현한다.
        // 폴백 시도가 시작되면 추가 호출이 발생해 여기서 다시 던져진다 —
        // 수정 전 코드에서는 aiChat 전체가 실패로 끝나는 것이 카나리아다.
        throw new Error("8007: Unexpected role 'user' after role 'tool'");
      }),
    };
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '[EVAL] 라이브 eval 테스트 메모입니다. 이 내용을 메모로 만들어줘.' },
    ]);
    expect(result.text).toContain('메모를 생성했습니다.');
    expect(result.text).not.toContain('실행 기록을 확인하지 못해');
    expect((dispatchToolCalls as jest.Mock).mock.calls.length).toBe(1);
    // 폴백 시도로 넘어가지 않았으므로 모델 호출은 최초+후속 2회뿐이다
    expect(callCount).toBe(2);
    expect((result as any).dataChanged).toBe(true);
  });

  test('쓰기 성공이 없는 후속 실패는 기존대로 폴백한다 (읽기 전용 턴 보호)', async () => {
    let callCount = 0;
    const mockAi = {
      run: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            response: '',
            tool_calls: [{ name: 'memo_search', arguments: '{"query": "회의"}' }],
          };
        }
        if (callCount === 2) throw new Error('followup boom');
        // 폴백 모델의 응답
        return { response: '검색 결과를 정리했어.' };
      }),
    };
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_search', data: [] },
    ]);
    const env = makeEnv({ AI: mockAi });
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '회의 메모 찾아줘' },
    ]);
    expect(result.text).toContain('검색 결과를 정리했어');
    expect(callCount).toBe(3);
  });
});
