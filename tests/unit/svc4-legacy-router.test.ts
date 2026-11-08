/// <reference types="jest" />
import { KeywordRouter, isValidPersonaId, VALID_PERSONA_IDS } from '../../src/services/legacy-router';

describe('VALID_PERSONA_IDS', () => {
  test('4개 ID 포함', () => {
    expect(VALID_PERSONA_IDS).toContain('concierge');
    expect(VALID_PERSONA_IDS).toContain('keeper');
    expect(VALID_PERSONA_IDS).toContain('builder');
    expect(VALID_PERSONA_IDS).toContain('scheduler');
    expect(VALID_PERSONA_IDS).toHaveLength(4);
  });
});

describe('isValidPersonaId', () => {
  test('유효한 ID는 true', () => {
    expect(isValidPersonaId('concierge')).toBe(true);
    expect(isValidPersonaId('keeper')).toBe(true);
    expect(isValidPersonaId('builder')).toBe(true);
    expect(isValidPersonaId('scheduler')).toBe(true);
  });

  test('무효한 ID는 false', () => {
    expect(isValidPersonaId('lumi')).toBe(false);
    expect(isValidPersonaId('')).toBe(false);
    expect(isValidPersonaId('CONCIERGE')).toBe(false);
  });
});

describe('KeywordRouter.route', () => {
  const router = new KeywordRouter();

  test('@멘션: 루미 → concierge', async () => {
    const r = await router.route('@루미 안녕');
    expect(r.primary).toBe('concierge');
    expect(r.reason).toBe('mention:@루미');
    expect(r.confidence).toBe(1.0);
  });

  test('@멘션: 에코 → keeper', async () => {
    const r = await router.route('@에코 메모 찾아줘');
    expect(r.primary).toBe('keeper');
  });

  test('@멘션: 노바 → builder', async () => {
    const r = await router.route('@노바 코드 만들어줘');
    expect(r.primary).toBe('builder');
  });

  test('@멘션: 캘리 → scheduler', async () => {
    const r = await router.route('@캘리 내일 일정');
    expect(r.primary).toBe('scheduler');
  });

  test('@멘션: 영문 ID도 동작', async () => {
    const r = await router.route('@keeper 메모');
    expect(r.primary).toBe('keeper');
    const r2 = await router.route('@builder 코드');
    expect(r2.primary).toBe('builder');
  });

  test('@멘션: 알 수 없는 이름은 키워드 라우팅으로 폴백', async () => {
    const r = await router.route('@누구야 코드 만들어줘');
    // @누구야는 매핑에 없으므로 키워드 '코드' → builder
    expect(r.primary).toBe('builder');
  });

  test('키워드: 코드 → builder', async () => {
    const r = await router.route('테트리스 게임 만들어줘');
    expect(r.primary).toBe('builder');
    expect(r.reason).toContain('keyword:');
    expect(r.confidence).toBe(0.9);
  });

  test('키워드: 메모 → keeper', async () => {
    const r = await router.route('어제 메모 요약해줘');
    expect(r.primary).toBe('keeper');
  });

  test('키워드: 일정 → scheduler', async () => {
    const r = await router.route('내일 회의 일정 알려줘');
    expect(r.primary).toBe('scheduler');
  });

  test('복합: 2개 분야 키워드 → 협업', async () => {
    const r = await router.route('메모 요약하고 내일 일정도 알려줘');
    expect(r.collaborator).toBeDefined();
    expect(r.reason).toContain('multi-domain:');
    expect(r.confidence).toBe(0.8);
  });

  test('복합: 코드+메모 → builder primary, keeper collaborator', async () => {
    const r = await router.route('코드 만들어줘 그리고 메모 정리해줘');
    expect(r.primary).toBe('builder');
    expect(r.collaborator).toBe('keeper');
  });

  test('클라이언트 힌트 사용', async () => {
    const r = await router.route('안녕하세요', { suggestedPersonaId: 'keeper' });
    expect(r.primary).toBe('keeper');
    expect(r.reason).toBe('client-hint');
    expect(r.confidence).toBe(0.6);
  });

  test('클라이언트 힌트가 무효하면 기본값', async () => {
    const r = await router.route('안녕하세요', { suggestedPersonaId: 'invalid' });
    expect(r.primary).toBe('concierge');
    expect(r.reason).toBe('default');
  });

  test('아무 키워드 없으면 기본 concierge', async () => {
    const r = await router.route('안녕하세요 반갑습니다');
    expect(r.primary).toBe('concierge');
    expect(r.reason).toBe('default');
    expect(r.confidence).toBe(0.5);
  });

  test('대소문자 무시 (toLowerCase)', async () => {
    const r = await router.route('API 문서 만들어줘');
    expect(r.primary).toBe('builder');
  });
});

describe('KeywordRouter.needsCollaboration', () => {
  const router = new KeywordRouter();

  test('항상 needed=false 반환', async () => {
    const r = await router.needsCollaboration('text', 'answer', 'concierge');
    expect(r.needed).toBe(false);
    expect(r.reason).toContain('keyword-router');
    expect(r.collaborator).toBeUndefined();
  });
});
