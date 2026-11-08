/// <reference types="jest" />
import { toLegacyRouterDecision, type RouterDecision } from '../../src/services/legacy-adapter';
import type { RouteResult } from '../../src/services/router';

describe('toLegacyRouterDecision', () => {
  test('persona가 없으면 null 반환', () => {
    const route = { persona: null, reason: 'unclear' } as unknown as RouteResult;
    expect(toLegacyRouterDecision(route)).toBeNull();
  });

  test('persona가 undefined면 null 반환', () => {
    const route = { reason: 'unclear' } as unknown as RouteResult;
    expect(toLegacyRouterDecision(route)).toBeNull();
  });

  test('persona가 있으면 primary, reason 반환', () => {
    const route = { persona: 'lumi', reason: 'keyword:메모', confidence: 0.9 } as unknown as RouteResult;
    const result = toLegacyRouterDecision(route);
    expect(result).toEqual({
      primary: 'lumi',
      reason: 'keyword:메모',
      confidence: 0.9,
    });
  });

  test('confidence가 undefined면 confidence 필드 생략', () => {
    const route = { persona: 'cali', reason: 'default' } as unknown as RouteResult;
    const result = toLegacyRouterDecision(route);
    expect(result).toEqual({
      primary: 'cali',
      reason: 'default',
    });
    expect(result).not.toHaveProperty('confidence');
  });

  test('confidence가 0이어도 포함됨', () => {
    const route = { persona: 'nova', reason: 'mention:@노바', confidence: 0 } as unknown as RouteResult;
    const result = toLegacyRouterDecision(route);
    expect(result).toEqual({
      primary: 'nova',
      reason: 'mention:@노바',
      confidence: 0,
    });
  });

  test('collaborator는 포함되지 않음 (RouterDecision 타입에 없음)', () => {
    const route = { persona: 'lumi', reason: 'x', collaborator: 'echo' } as unknown as RouteResult;
    const result = toLegacyRouterDecision(route) as RouterDecision;
    expect(result).not.toHaveProperty('collaborator');
    expect(result.primary).toBe('lumi');
  });
});
