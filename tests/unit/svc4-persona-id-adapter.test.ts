/// <reference types="jest" />
import {
  LEGACY_TO_NEW,
  NEW_TO_LEGACY,
  legacyToNew,
  newToLegacy,
  isValidLegacyPersonaId,
  normalizeLegacyPersonaId,
  resolveClefRoute,
} from '../../src/services/persona-id-adapter';
import type { RouteResult } from '../../src/services/router';

describe('LEGACY_TO_NEW / NEW_TO_LEGACY 매핑', () => {
  test('기존 → 신규 매핑', () => {
    expect(LEGACY_TO_NEW.concierge).toBe('lumi');
    expect(LEGACY_TO_NEW.keeper).toBe('echo');
    expect(LEGACY_TO_NEW.builder).toBe('nova');
    expect(LEGACY_TO_NEW.scheduler).toBe('cali');
  });

  test('신규 → 기존 매핑', () => {
    expect(NEW_TO_LEGACY.lumi).toBe('concierge');
    expect(NEW_TO_LEGACY.echo).toBe('keeper');
    expect(NEW_TO_LEGACY.nova).toBe('builder');
    expect(NEW_TO_LEGACY.cali).toBe('scheduler');
  });

  test('왕복 변환 일관성', () => {
    for (const legacy of ['concierge', 'keeper', 'builder', 'scheduler'] as const) {
      const newId = LEGACY_TO_NEW[legacy];
      expect(NEW_TO_LEGACY[newId as keyof typeof NEW_TO_LEGACY]).toBe(legacy);
    }
  });
});

describe('legacyToNew', () => {
  test('유효한 기존 ID 변환', () => {
    expect(legacyToNew('concierge')).toBe('lumi');
    expect(legacyToNew('keeper')).toBe('echo');
    expect(legacyToNew('builder')).toBe('nova');
    expect(legacyToNew('scheduler')).toBe('cali');
  });

  test('알 수 없는 ID는 null', () => {
    expect(legacyToNew('lumi')).toBeNull();
    expect(legacyToNew('unknown')).toBeNull();
    expect(legacyToNew('')).toBeNull();
  });

  test('__proto__는 null을 반환함 (프로토타입 오염 방지)', () => {
    // 수정됨: hasOwnProperty로 프로토타입 체인 검사 방지
    expect(legacyToNew('__proto__')).toBe(null);
    expect(legacyToNew('constructor')).toBe(null);
  });
});

describe('newToLegacy', () => {
  test('유효한 신규 ID 변환', () => {
    expect(newToLegacy('lumi' as any)).toBe('concierge');
    expect(newToLegacy('echo' as any)).toBe('keeper');
    expect(newToLegacy('nova' as any)).toBe('builder');
    expect(newToLegacy('cali' as any)).toBe('scheduler');
  });
});

describe('isValidLegacyPersonaId', () => {
  test('유효한 ID는 true', () => {
    expect(isValidLegacyPersonaId('concierge')).toBe(true);
    expect(isValidLegacyPersonaId('keeper')).toBe(true);
    expect(isValidLegacyPersonaId('builder')).toBe(true);
    expect(isValidLegacyPersonaId('scheduler')).toBe(true);
  });

  test('무효한 값은 false', () => {
    expect(isValidLegacyPersonaId('lumi')).toBe(false);
    expect(isValidLegacyPersonaId('')).toBe(false);
    expect(isValidLegacyPersonaId(null)).toBe(false);
    expect(isValidLegacyPersonaId(undefined)).toBe(false);
    expect(isValidLegacyPersonaId(123)).toBe(false);
    expect(isValidLegacyPersonaId('CONCIERGE')).toBe(false);
  });
});

describe('normalizeLegacyPersonaId', () => {
  test('문자열이 아니면 null', () => {
    expect(normalizeLegacyPersonaId(null)).toBeNull();
    expect(normalizeLegacyPersonaId(undefined)).toBeNull();
    expect(normalizeLegacyPersonaId(123)).toBeNull();
    expect(normalizeLegacyPersonaId({})).toBeNull();
  });

  test('기존 ID는 그대로 반환', () => {
    expect(normalizeLegacyPersonaId('concierge')).toBe('concierge');
    expect(normalizeLegacyPersonaId('keeper')).toBe('keeper');
    expect(normalizeLegacyPersonaId('builder')).toBe('builder');
    expect(normalizeLegacyPersonaId('scheduler')).toBe('scheduler');
  });

  test('신규 ID는 기존 ID로 변환', () => {
    expect(normalizeLegacyPersonaId('lumi')).toBe('concierge');
    expect(normalizeLegacyPersonaId('echo')).toBe('keeper');
    expect(normalizeLegacyPersonaId('nova')).toBe('builder');
    expect(normalizeLegacyPersonaId('cali')).toBe('scheduler');
  });

  test('알 수 없는 문자열은 null', () => {
    expect(normalizeLegacyPersonaId('unknown')).toBeNull();
    expect(normalizeLegacyPersonaId('')).toBeNull();
  });

  test('프로토타입 오염 방지', () => {
    expect(normalizeLegacyPersonaId('__proto__')).toBeNull();
    expect(normalizeLegacyPersonaId('constructor')).toBeNull();
  });
});

describe('resolveClefRoute', () => {
  test('multiple_actions는 reply로 위임 거부', () => {
    const route = { persona: 'lumi', reason: 'multiple_actions' } as unknown as RouteResult;
    const result = resolveClefRoute(route);
    expect(result.kind).toBe('reply');
    if (result.kind === 'reply') {
      expect(result.reason).toBe('multiple_actions');
      expect(result.message).toContain('먼저 처리할 작업');
    }
  });

  test('persona가 없으면 reply (비서 지정 요청)', () => {
    const route = { persona: null, reason: 'unclear' } as unknown as RouteResult;
    const result = resolveClefRoute(route);
    expect(result.kind).toBe('reply');
    if (result.kind === 'reply') {
      expect(result.message).toContain('@루미');
    }
  });

  test('유효한 persona면 dispatch', () => {
    const route = { persona: 'lumi', reason: 'keyword:메모' } as unknown as RouteResult;
    const result = resolveClefRoute(route);
    expect(result).toEqual({
      kind: 'dispatch',
      primary: 'concierge',
      reason: 'keyword:메모',
    });
  });

  test('신규 ID도 dispatch로 정규화', () => {
    // lumi는 이미 normalizeLegacyPersonaId에서 concierge로 변환됨
    const route = { persona: 'nova', reason: 'mention:@노바' } as unknown as RouteResult;
    const result = resolveClefRoute(route);
    expect(result.kind).toBe('dispatch');
    if (result.kind === 'dispatch') {
      expect(result.primary).toBe('builder');
    }
  });

  test('무효한 persona면 reply (invalid_persona)', () => {
    const route = { persona: 'unknown_bot', reason: 'test' } as unknown as RouteResult;
    const result = resolveClefRoute(route);
    expect(result.kind).toBe('reply');
    if (result.kind === 'reply') {
      expect(result.reason).toBe('invalid_persona');
    }
  });

  test('레거시 ID도 dispatch', () => {
    const route = { persona: 'keeper', reason: 'test' } as unknown as RouteResult;
    const result = resolveClefRoute(route);
    expect(result.kind).toBe('dispatch');
    if (result.kind === 'dispatch') {
      expect(result.primary).toBe('keeper');
    }
  });
});
