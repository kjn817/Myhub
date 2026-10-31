/// <reference types="jest" />
/**
 * src/services/orchestrator.ts 테스트
 * 비서 오케스트레이션 (라우팅, 협업, 종합, 로깅)
 *
 * 참고: 101행과 178행의 `.catch(() => {})` 빈 콜백은 branch 커버리지에서
 * 미커버로 표시되나, 실제로는 "log 실패해도 무시" 테스트들로 실행됨.
 * Istanbul이 빈 화살표 함수를 별도 브랜치로 집계하는 측정 한계.
 */

import {
  orchestrate,
  setRouter,
  getRouter,
  type OrchestratorDeps,
} from '../../src/services/orchestrator';
import { KeywordRouter, type Router, type RouterDecision } from '../../src/services/legacy-router';

jest.mock('../../src/services/router', () => ({
  routeMessage: jest.fn(),
}));

jest.mock('../../src/services/persona-id-adapter', () => ({
  resolveClefRoute: jest.fn(),
}));

import { routeMessage } from '../../src/services/router';
import { resolveClefRoute } from '../../src/services/persona-id-adapter';

const makeDeps = (overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  callAssistant: jest.fn().mockResolvedValue({ text: 'hello' }),
  ...overrides,
});

// Router mock 헬퍼 (needsCollaboration 포함)
const mockRouter = (decision: RouterDecision): Router => ({
  route: async () => decision,
  needsCollaboration: async () => ({ needed: false, reason: 'test' }),
});

describe('setRouter / getRouter', () => {
  test('기본 라우터는 KeywordRouter', () => {
    // 다른 테스트에서 변경했을 수 있으므로 리셋
    setRouter(new KeywordRouter());
    expect(getRouter()).toBeInstanceOf(KeywordRouter);
  });

  test('setRouter로 교체 가능', () => {
    const custom: Router = {
      route: async () => ({ primary: 'keeper', reason: 'test', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: 'test' }),
    };
    setRouter(custom);
    expect(getRouter()).toBe(custom);
    // 복원
    setRouter(new KeywordRouter());
  });
});

describe('orchestrate - 기본 흐름', () => {
  beforeEach(() => {
    setRouter(new KeywordRouter());
  });

  test('주 담당 비서 호출 후 응답 반환', async () => {
    const callAssistant = jest.fn().mockResolvedValue({ text: '안녕하세요' });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, '안녕', [{ role: 'user', content: '안녕' }], 1);
    expect(result.text).toBe('안녕하세요');
    expect(result.participants).toHaveLength(1);
    expect(result.responses).toHaveLength(1);
    expect(callAssistant).toHaveBeenCalledTimes(1);
  });

  test('suggestedPersonaId가 라우터에 전달된다', async () => {
    const route = jest.fn().mockResolvedValue({ primary: 'keeper', reason: 'suggested', confidence: 0.9 });
    setRouter({ route, needsCollaboration: async () => ({ needed: false, reason: "test" }) } as Router);
    const deps = makeDeps();
    await orchestrate(deps, 'test', [], 1, 'keeper');
    expect(route).toHaveBeenCalledWith('test', { suggestedPersonaId: 'keeper' });
  });

  test('로그 함수가 호출된다', async () => {
    const log = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ log });
    await orchestrate(deps, 'hello world', [], 42);
    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0];
    expect(entry.conversationId).toBe(42);
    expect(entry.success).toBe(true);
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry.participants.length).toBeGreaterThan(0);
  });

  test('userText는 500자로 잘려서 로그에 기록', async () => {
    const log = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ log });
    await orchestrate(deps, 'x'.repeat(1000), [], 1);
    expect(log.mock.calls[0][0].userText.length).toBe(500);
  });

  test('log 실패해도 무시된다', async () => {
    const log = jest.fn().mockRejectedValue(new Error('log fail'));
    const deps = makeDeps({ log });
    const result = await orchestrate(deps, 'hi', [], 1);
    expect(result.text).toBeDefined();
  });

  test('log 없으면 스킵', async () => {
    const deps = makeDeps({ log: undefined });
    const result = await orchestrate(deps, 'hi', [], 1);
    expect(result.text).toBeDefined();
  });
});

describe('orchestrate - 라우터 폴백', () => {
  beforeEach(() => {
    setRouter(new KeywordRouter());
  });

  test('라우터 throw 시 기본값으로 폴백', async () => {
    setRouter({
      route: async () => {
        throw new Error('router down');
      },
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps();
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.primaryId).toBe('concierge');
    expect(result.decision.reason).toBe('router-fallback');
  });

  test('라우터 폴백 시 유효한 suggestedPersonaId 사용', async () => {
    setRouter({
      route: async () => {
        throw new Error('down');
      },
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps();
    const result = await orchestrate(deps, 'test', [], 1, 'keeper');
    expect(result.primaryId).toBe('keeper');
  });

  test('라우터 폴백 시 무효한 suggestedPersonaId는 concierge', async () => {
    setRouter({
      route: async () => {
        throw new Error('down');
      },
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps();
    const result = await orchestrate(deps, 'test', [], 1, 'invalid-id');
    expect(result.primaryId).toBe('concierge');
  });

  test('잘못된 primary ID는 throw 후 폴백', async () => {
    setRouter({
      route: async () => ({ primary: 'hacker', reason: 'x', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps();
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.primaryId).toBe('concierge');
    expect(result.decision.reason).toBe('router-fallback');
  });

  test('잘못된 collaborator는 제거된다', async () => {
    const callAssistant = jest.fn().mockResolvedValue({ text: 'resp' });
    setRouter({
      route: async () => ({ primary: 'concierge', collaborator: 'hacker', reason: 'x', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.participants).toEqual(['concierge']);
    expect(callAssistant).toHaveBeenCalledTimes(1);
  });

  test('collaborator가 primary와 같으면 제거', async () => {
    const callAssistant = jest.fn().mockResolvedValue({ text: 'resp' });
    setRouter({
      route: async () => ({ primary: 'concierge', collaborator: 'concierge', reason: 'x', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.participants).toEqual(['concierge']);
    expect(callAssistant).toHaveBeenCalledTimes(1);
  });
});

describe('orchestrate - 협업', () => {
  beforeEach(() => {
    setRouter(new KeywordRouter());
  });

  test('collaborator가 있으면 2명 호출', async () => {
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: 'primary answer' })
      .mockResolvedValueOnce({ text: 'collab addition' });
    setRouter({
      route: async () => ({ primary: 'concierge', collaborator: 'keeper', reason: 'x', confidence: 0.8 }),
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, 'test', [{ role: 'user', content: 'q' }], 1);
    expect(callAssistant).toHaveBeenCalledTimes(2);
    expect(result.participants).toEqual(['concierge', 'keeper']);
    expect(result.responses).toHaveLength(2);
    // 협업 메시지에 주 담당 답변이 포함되는지
    const collabMessages = callAssistant.mock.calls[1][1];
    expect(collabMessages[collabMessages.length - 1].content).toContain('primary answer');
  });

  test('협업 답변은 합쳐진다', async () => {
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: 'A' })
      .mockResolvedValueOnce({ text: 'B' });
    setRouter({
      route: async () => ({ primary: 'concierge', collaborator: 'keeper', reason: 'x', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.text).toBe('A\n\nB');
  });

  test('협업 실패 시 주 담당 답변만 사용', async () => {
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: 'primary only' })
      .mockRejectedValueOnce(new Error('collab down'));
    setRouter({
      route: async () => ({ primary: 'concierge', collaborator: 'keeper', reason: 'x', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: "test" }),
    });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.text).toBe('primary only');
    expect(result.participants).toEqual(['concierge']);
  });

  test('단일 응답은 그대로 반환', async () => {
    const callAssistant = jest.fn().mockResolvedValue({ text: 'solo' });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, 'hi', [], 1);
    expect(result.text).toBe('solo');
  });
});

describe('orchestrate - 에러 처리', () => {
  beforeEach(() => {
    setRouter(new KeywordRouter());
  });

  test('callAssistant 실패 시 throw하고 로그에 에러 기록', async () => {
    const log = jest.fn().mockResolvedValue(undefined);
    const callAssistant = jest.fn().mockRejectedValue(new Error('assistant down'));
    const deps = makeDeps({ callAssistant, log });
    await expect(orchestrate(deps, 'test', [], 1)).rejects.toThrow('assistant down');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].success).toBe(false);
    expect(log.mock.calls[0][0].error).toBe('assistant down');
  });

  test('에러 로그 실패해도 throw는 유지', async () => {
    const log = jest.fn().mockRejectedValue(new Error('log fail'));
    const callAssistant = jest.fn().mockRejectedValue(new Error('boom'));
    const deps = makeDeps({ callAssistant, log });
    await expect(orchestrate(deps, 'test', [], 1)).rejects.toThrow('boom');
  });

  test('에러 메시지가 없으면 unknown', async () => {
    const log = jest.fn().mockResolvedValue(undefined);
    const callAssistant = jest.fn().mockRejectedValue('string error');
    const deps = makeDeps({ callAssistant, log });
    await expect(orchestrate(deps, 'test', [], 1)).rejects.toBe('string error');
    expect(log.mock.calls[0][0].error).toBe('unknown');
  });
});

describe('orchestrate - Clef 라우터', () => {
  beforeEach(() => {
    setRouter(new KeywordRouter());
    jest.clearAllMocks();
  });

  test('useClefRouter 없이 clefInvoker만 있으면 레거시 라우터 사용', async () => {
    const route = jest.fn().mockResolvedValue({ primary: 'keeper', reason: 'kw', confidence: 0.5 });
    setRouter({ route, needsCollaboration: async () => ({ needed: false, reason: "test" }) } as Router);
    const deps = makeDeps({ clefInvoker: jest.fn() });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(route).toHaveBeenCalled();
    expect(result.primaryId).toBe('keeper');
  });

  test('useClefRouter=true + clefInvoker 있으면 Clef 라우터 사용 (reply outcome)', async () => {
    (routeMessage as jest.Mock).mockResolvedValue({ confidence: 0.3 });
    (resolveClefRoute as jest.Mock).mockReturnValue({
      kind: 'reply',
      reason: 'low-confidence',
      message: '안내 메시지입니다',
    });
    const log = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      useClefRouter: true,
      clefInvoker: jest.fn(),
      log,
    });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.text).toBe('안내 메시지입니다');
    expect(result.participants).toEqual([]);
    expect(result.primaryId).toBe('concierge');
    expect(result.responses).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  test('Clef 라우터 reply 시 log 실패해도 무시', async () => {
    (routeMessage as jest.Mock).mockResolvedValue({ confidence: 0.3 });
    (resolveClefRoute as jest.Mock).mockReturnValue({
      kind: 'reply',
      reason: 'x',
      message: 'msg',
    });
    const log = jest.fn().mockRejectedValue(new Error('log fail'));
    const deps = makeDeps({ useClefRouter: true, clefInvoker: jest.fn(), log });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.text).toBe('msg');
  });

  test('Clef 라우터 dispatch outcome이면 정상 진행', async () => {
    (routeMessage as jest.Mock).mockResolvedValue({ confidence: 0.9 });
    (resolveClefRoute as jest.Mock).mockReturnValue({
      kind: 'dispatch',
      primary: 'keeper',
      reason: 'test-reason',
    });
    const callAssistant = jest.fn().mockResolvedValue({ text: 'keeper answer' });
    const deps = makeDeps({ useClefRouter: true, clefInvoker: jest.fn(), callAssistant });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.primaryId).toBe('keeper');
    expect(result.decision.reason).toBe('clef:test-reason');
    expect(result.decision.confidence).toBe(0.9);
    expect(callAssistant).toHaveBeenCalled();
  });

  test('Clef 라우터 dispatch 시 confidence 없으면 0', async () => {
    (routeMessage as jest.Mock).mockResolvedValue({});
    (resolveClefRoute as jest.Mock).mockReturnValue({
      kind: 'dispatch',
      primary: 'keeper',
      reason: 'r',
    });
    const deps = makeDeps({ useClefRouter: true, clefInvoker: jest.fn() });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.decision.confidence).toBe(0);
  });
});
