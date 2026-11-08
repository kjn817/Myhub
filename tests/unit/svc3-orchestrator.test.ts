/// <reference types="jest" />
/**
 * src/services/orchestrator.ts 테스트 (현행 표면 기준 재작성 — 2026-11-08 배치 3)
 * 비서 오케스트레이션 (라우팅, 협업, 종합, 로깅)
 *
 * 구 setRouter/getRouter 주입 표면은 번들·현행 어디에도 없다. 현행
 * orchestrate는 내장 KeywordRouter 싱글턴을 쓰므로, 라우팅 거동은 실제
 * 키워드 문장·@멘션·client hint(suggestedPersonaId)로 검증하고, 라우터
 * 실패 폴백은 Clef 경로(routeMessage reject)로 검증한다.
 *
 * [삭제 기록]
 * - 'setRouter / getRouter' describe(2건): 주입 API 자체가 소멸.
 * - '잘못된 collaborator는 제거된다'·'collaborator가 primary와 같으면 제거':
 *   결정을 주입할 표면이 없어 해당 검증 분기에 도달할 방법이 없다.
 */

import {
  orchestrate,
  type OrchestratorDeps,
} from '../../src/services/orchestrator';

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

// 내장 KeywordRouter 기준 다중 도메인 문장 (builder 주 담당 + keeper 협업)
const MULTI = '메모 요약하고 코드로 정리해줘';

describe('orchestrate - 기본 흐름', () => {
  test('주 담당 비서 호출 후 응답 반환', async () => {
    const callAssistant = jest.fn().mockResolvedValue({ text: '안녕하세요' });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, '안녕', [{ role: 'user', content: '안녕' }], 1);
    expect(result.text).toBe('안녕하세요');
    expect(result.participants).toHaveLength(1);
    expect(result.responses).toHaveLength(1);
    expect(callAssistant).toHaveBeenCalledTimes(1);
  });

  test('suggestedPersonaId는 키워드 없을 때 client hint로 쓰인다', async () => {
    const deps = makeDeps();
    const result = await orchestrate(deps, 'test', [], 1, 'keeper');
    expect(result.primaryId).toBe('keeper');
    expect(result.decision.reason).toBe('client-hint');
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

describe('orchestrate - 라우터 폴백 (Clef 경로 실패로 주입)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const clefDeps = (overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps =>
    makeDeps({ useClefRouter: true, clefInvoker: jest.fn(), ...overrides });

  test('라우터 throw 시 기본값으로 폴백', async () => {
    (routeMessage as jest.Mock).mockRejectedValue(new Error('router down'));
    const result = await orchestrate(clefDeps(), 'test', [], 1);
    expect(result.primaryId).toBe('concierge');
    expect(result.decision.reason).toBe('router-fallback');
  });

  test('라우터 폴백 시 유효한 suggestedPersonaId 사용', async () => {
    (routeMessage as jest.Mock).mockRejectedValue(new Error('down'));
    const result = await orchestrate(clefDeps(), 'test', [], 1, 'keeper');
    expect(result.primaryId).toBe('keeper');
  });

  test('라우터 폴백 시 무효한 suggestedPersonaId는 concierge', async () => {
    (routeMessage as jest.Mock).mockRejectedValue(new Error('down'));
    const result = await orchestrate(clefDeps(), 'test', [], 1, 'invalid-id');
    expect(result.primaryId).toBe('concierge');
  });

  test('잘못된 primary ID는 throw 후 폴백', async () => {
    // source='rule'은 G5 판정 게이트 면제 — 결정 검증 분기에 직접 도달한다
    (routeMessage as jest.Mock).mockResolvedValue({ source: 'rule', confidence: 1 });
    (resolveClefRoute as jest.Mock).mockReturnValue({
      kind: 'dispatch',
      primary: 'hacker',
      reason: 'x',
    });
    const result = await orchestrate(clefDeps(), 'test', [], 1);
    expect(result.primaryId).toBe('concierge');
    expect(result.decision.reason).toBe('router-fallback');
  });
});

describe('orchestrate - 협업', () => {
  test('collaborator가 있으면 2명 호출', async () => {
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: 'primary answer' })
      .mockResolvedValueOnce({ text: 'collab addition' });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, MULTI, [{ role: 'user', content: 'q' }], 1);
    expect(callAssistant).toHaveBeenCalledTimes(2);
    expect(result.participants).toEqual(['builder', 'keeper']);
    expect(result.responses).toHaveLength(2);
    // 협업 메시지에 주 담당 답변이 포함되는지
    const collabMessages = callAssistant.mock.calls[1][1];
    expect(collabMessages[collabMessages.length - 1].content).toContain('primary answer');
  });

  test('협업 답변은 합쳐진다', async () => {
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: 'A' })
      .mockResolvedValueOnce({ text: 'B' });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, MULTI, [], 1);
    expect(result.text).toBe('A\n\nB');
  });

  test('협업 실패 시 주 담당 답변만 사용', async () => {
    const callAssistant = jest.fn()
      .mockResolvedValueOnce({ text: 'primary only' })
      .mockRejectedValueOnce(new Error('collab down'));
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, MULTI, [], 1);
    expect(result.text).toBe('primary only');
    expect(result.participants).toEqual(['builder']);
  });

  test('단일 응답은 그대로 반환', async () => {
    const callAssistant = jest.fn().mockResolvedValue({ text: 'solo' });
    const deps = makeDeps({ callAssistant });
    const result = await orchestrate(deps, 'hi', [], 1);
    expect(result.text).toBe('solo');
  });
});

describe('orchestrate - 에러 처리', () => {
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
    jest.clearAllMocks();
  });

  test('useClefRouter 없이 clefInvoker만 있으면 레거시 라우터 사용', async () => {
    const deps = makeDeps({ clefInvoker: jest.fn() });
    const result = await orchestrate(deps, '메모 찾아줘', [], 1);
    expect(routeMessage).not.toHaveBeenCalled();
    expect(result.primaryId).toBe('keeper'); // KeywordRouter 키워드 매칭
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

  test('Clef 라우터 dispatch outcome이면 정상 진행 (G5 게이트 통과 조건)', async () => {
    (routeMessage as jest.Mock).mockResolvedValue({ confidence: 0.9, margin: 0.6 });
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

  test('Clef 라우터 dispatch 시 confidence 없으면 0 (rule 출처 — 게이트 면제)', async () => {
    (routeMessage as jest.Mock).mockResolvedValue({ source: 'rule' });
    (resolveClefRoute as jest.Mock).mockReturnValue({
      kind: 'dispatch',
      primary: 'keeper',
      reason: 'r',
    });
    const deps = makeDeps({ useClefRouter: true, clefInvoker: jest.fn() });
    const result = await orchestrate(deps, 'test', [], 1);
    expect(result.primaryId).toBe('keeper');
    expect(result.decision.confidence).toBe(0);
  });
});
