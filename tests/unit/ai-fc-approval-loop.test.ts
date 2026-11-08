/// <reference types="jest" />

/**
 * aiChat FC 루프 × 승인 게이트 통합 테스트 (D1 정렬, 2026-10-31)
 *
 * 성질: 에코 FC 쓰기 호출은 디스패치 전에 승인 게이트를 거친다.
 * - 승인 전: dispatchToolCalls 0회 + approvalRequests 1건 + 최종 응답에
 *   E1과 같은 승인 문안 + 모델 피드백은 approval_required 상태.
 * - 모델이 다음 라운드에서 같은 호출을 반복해도 대기 요청은 재사용되고
 *   실행은 여전히 0회다 (승인 대기가 멱등성 캐시에 들어가지 않음).
 * - 세션 허용이 있으면 게이트를 통과해 기존처럼 디스패치된다.
 * - 비대화형 origin은 기존 인라인 게이트가 먼저 deny한다 (변화 없음).
 * - 읽기 도구는 게이트 없이 디스패치된다.
 *
 * 게이트·승인 저장소는 실제 코드 + FakeD1이고, 디스패처와 프로바이더만
 * 목킹한다 (디스패처의 실제 DB 동작은 fc-approval-gate.test.ts가 담당).
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

import { dispatchToolCalls } from '../../src/ai/memo-tool-dispatcher';
import { aiChat, type TaskPolicy } from '../../src/services/ai';
import { ToolApprovalStore } from '../../src/services/tool-approval';
import { FakeD1 } from '../fake-d1';

const CONV_ID = '7';

/** 승인 테이블은 FakeD1(실제 SQL 의미), 나머지는 aiChat용 제네릭 스텁 */
function makeHybridDb(fake: FakeD1): any {
  return {
    prepare: jest.fn().mockImplementation((sql: string) => {
      if (
        typeof sql === 'string' &&
        (sql.includes('tool_approvals') || sql.includes('tool_approval_requests'))
      ) {
        return fake.prepare(sql);
      }
      return {
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue(null),
          all: jest.fn().mockResolvedValue({ results: [] }),
          run: jest.fn().mockResolvedValue({}),
        }),
      };
    }),
  };
}

const keeperWorkersPolicy: TaskPolicy = {
  capability: 'chat',
  privacy: 'external-ok',
  latency: 'interactive',
  quality: 'balanced',
  personaId: 'keeper',
  providerPin: 'workers-ai',
  origin: 'interactive',
};

const MEMO_TOOL_CALL = {
  response: '',
  tool_calls: [
    { name: 'memo_create', arguments: '{"text": "승인 게이트 루프 테스트 메모"}' },
  ],
};

beforeEach(() => {
  (dispatchToolCalls as jest.Mock).mockReset();
  // 실제 디스패처(memo-tool-dispatcher)는 실행 결과를 원장에 기록한 뒤
  // ledgerRecorded:true를 붙여 돌려준다 — 성공 결과의 현행 반환 계약이다.
  // 이 필드가 없으면 루프가 "원장 미검증 성공"으로 판정해 확인 문구 대신
  // 확인 불가 고지를 붙인다 (감사 A4의 반환 형태 계약).
  (dispatchToolCalls as jest.Mock).mockResolvedValue([
    { success: true, toolName: 'memo_create', data: { id: 216 }, ledgerRecorded: true },
  ]);
});

describe('aiChat FC 루프 승인 게이트 (D1 정렬)', () => {
  test('승인 전: 쓰기 0건 + 승인 프롬프트가 응답·메타데이터에 실린다', async () => {
    const fake = new FakeD1();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce(MEMO_TOOL_CALL)
        .mockResolvedValueOnce({ response: '승인 요청을 보냈어. 아직 실행되지 않았어.' }),
    };
    const env: any = { DB: makeHybridDb(fake), AI: mockAi };
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ], { conversationId: CONV_ID, userId: 'default' });

    // 실행 0건
    expect(dispatchToolCalls).not.toHaveBeenCalled();
    expect((result as any).dataChanged).toBeFalsy();
    // 승인 프롬프트 (E1과 같은 형태)가 최종 응답에 있다
    expect(result.text).toContain('[승인이 필요해요]');
    expect(result.text).toContain('"승인해"');
    expect(result.text).not.toMatch(/메모를 생성했어 \(id:/);
    // 프론트 카드용 메타데이터
    const reqs = (result as any).approvalRequests || [];
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tool).toBe('MEMO_CREATE');
    // 모델 피드백은 approval_required 상태다
    const toolResults = (result as any).toolResults || [];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].success).toBe(false);
    expect(toolResults[0].error).toBe('approval_required');
    expect(toolResults[0].data.status).toBe('approval_required');
    // 후속 호출의 tool 메시지에도 같은 상태가 전달됐다
    const followUpMsgs = mockAi.run.mock.calls[1][1].messages;
    const toolMsg = followUpMsgs.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('approval_required');
    // 대기 요청이 실제로 저장됐다
    expect(fake.tables.tool_approval_requests).toHaveLength(1);
    expect(fake.tables.tool_approval_requests[0].status).toBe('pending');
  });

  test('모델이 다음 라운드에서 같은 쓰기를 반복해도 실행 0건 + 대기 요청 재사용', async () => {
    const fake = new FakeD1();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce(MEMO_TOOL_CALL)
        .mockResolvedValueOnce(MEMO_TOOL_CALL) // 모델이 같은 호출 반복
        .mockResolvedValueOnce({ response: '승인을 기다리고 있어.' }),
    };
    const env: any = { DB: makeHybridDb(fake), AI: mockAi };
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ], { conversationId: CONV_ID, userId: 'default' });

    expect(dispatchToolCalls).not.toHaveBeenCalled();
    // 승인 대기가 "실행됨"으로 캐시되지 않았다: 두 라운드 모두 게이트에서
    // 막혔고, 대기 요청은 1건만 존재한다 (scope 재사용).
    expect(fake.tables.tool_approval_requests).toHaveLength(1);
    const reqs = (result as any).approvalRequests || [];
    expect(reqs).toHaveLength(1);
    const toolResults = (result as any).toolResults || [];
    expect(toolResults).toHaveLength(2);
    expect(toolResults.every((r: any) => r.error === 'approval_required')).toBe(true);
  });

  test('세션 허용이 있으면 재승인 없이 디스패치된다 (기존 실행 경로 유지)', async () => {
    const fake = new FakeD1();
    const db = makeHybridDb(fake);
    await new ToolApprovalStore(db).recordSessionAllowance('keeper', 'MEMO_CREATE', Number(CONV_ID));
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce(MEMO_TOOL_CALL)
        .mockResolvedValueOnce({ response: '메모가 성공적으로 생성되었습니다.' }),
    };
    const env: any = { DB: db, AI: mockAi };
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ], { conversationId: CONV_ID, userId: 'default' });

    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    // 원장 검증된 쓰기 성공 → 서버의 결정적 확인 문구가 붙고,
    // 확인 불가 고지는 붙지 않는다 (현행 문구 계약, 번들 대조 확인)
    expect(result.text).toContain('메모를 생성했습니다.');
    expect(result.text).not.toContain('실행 기록을 확인하지 못해');
    expect((result as any).dataChanged).toBe(true);
    expect((result as any).approvalRequests || []).toHaveLength(0);
    expect(fake.tables.tool_approval_requests).toHaveLength(0);
  });

  test('비대화형 origin: 승인 요청 없이 non_interactive_origin deny (기존 유지)', async () => {
    const fake = new FakeD1();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce(MEMO_TOOL_CALL)
        .mockResolvedValueOnce({ response: '처리할 수 없습니다.' }),
    };
    const env: any = { DB: makeHybridDb(fake), AI: mockAi };
    const result = await aiChat(env, { ...keeperWorkersPolicy, origin: 'scheduled' }, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ], { conversationId: CONV_ID, userId: 'default' });

    expect(dispatchToolCalls).not.toHaveBeenCalled();
    const toolResults = (result as any).toolResults || [];
    expect(toolResults[0].error).toBe('non_interactive_origin');
    expect((result as any).approvalRequests || []).toHaveLength(0);
    expect(fake.tables.tool_approval_requests).toHaveLength(0);
  });

  test('읽기 도구(memo_search)는 게이트 없이 디스패치된다', async () => {
    const fake = new FakeD1();
    (dispatchToolCalls as jest.Mock).mockResolvedValue([
      { success: true, toolName: 'memo_search', data: [] },
    ]);
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_search', arguments: '{"query": "회의"}' }],
        })
        .mockResolvedValueOnce({ response: '검색 결과를 정리했어.' }),
    };
    const env: any = { DB: makeHybridDb(fake), AI: mockAi };
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '회의 메모 찾아줘' },
    ], { conversationId: CONV_ID, userId: 'default' });

    expect(dispatchToolCalls).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('검색 결과를 정리했어.');
    expect(fake.tables.tool_approval_requests).toHaveLength(0);
  });

  test('대화 ID가 없는 턴의 쓰기는 pending 없이 차단된다 (fail-closed)', async () => {
    const fake = new FakeD1();
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce(MEMO_TOOL_CALL)
        .mockResolvedValueOnce({ response: '승인이 필요해요.' }),
    };
    const env: any = { DB: makeHybridDb(fake), AI: mockAi };
    const result = await aiChat(env, keeperWorkersPolicy, [
      { role: 'user', content: '이 내용을 메모로 만들어줘.' },
    ]); // conversationId 없음

    expect(dispatchToolCalls).not.toHaveBeenCalled();
    const toolResults = (result as any).toolResults || [];
    expect(toolResults[0].error).toBe('approval_required');
    expect(fake.tables.tool_approval_requests).toHaveLength(0);
    expect(result.text).toContain('이 작업은 승인이 필요해 실행하지 않았습니다');
  });
});
