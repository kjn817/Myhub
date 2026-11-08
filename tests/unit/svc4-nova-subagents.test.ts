/// <reference types="jest" />
import {
  MODEL_SUBAGENTS,
  recommendSubAgent,
  selectSubAgentByClef,
  planSubAgentWork,
} from '../../src/services/nova-subagents';

function makeInvoker(response: any) {
  return jest.fn().mockResolvedValue(response);
}

describe('MODEL_SUBAGENTS', () => {
  test('4개 서브에이전트 정의 (2026-10-30: nvidia-ultra 제거 — NVIDIA 운영 제외)', () => {
    expect(Object.keys(MODEL_SUBAGENTS)).toHaveLength(4);
    expect(MODEL_SUBAGENTS['gemini-flash']).toBeDefined();
    expect(MODEL_SUBAGENTS['gemini-pro']).toBeDefined();
    expect(MODEL_SUBAGENTS['groq-fast']).toBeDefined();
    expect((MODEL_SUBAGENTS as any)['nvidia-ultra']).toBeUndefined();
    expect(MODEL_SUBAGENTS['workers-llama']).toBeDefined();
    // 어떤 서브에이전트도 nvidia 프로바이더를 가리키지 않는다
    for (const agent of Object.values(MODEL_SUBAGENTS)) {
      expect(agent.provider).not.toBe('nvidia');
    }
  });

  test('각 에이전트 필수 필드', () => {
    for (const agent of Object.values(MODEL_SUBAGENTS)) {
      expect(agent.id).toBeDefined();
      expect(agent.name).toBeDefined();
      expect(agent.modelId).toBeDefined();
      expect(agent.provider).toBeDefined();
      expect(agent.strengths.length).toBeGreaterThan(0);
      expect(agent.bestFor.length).toBeGreaterThan(0);
      expect(agent.maxTokens).toBeGreaterThan(0);
    }
  });
});

describe('recommendSubAgent', () => {
  test('리뷰/검증/체크 → 빠른 모델', () => {
    expect(recommendSubAgent('코드 리뷰해줘')).toEqual(['groq-fast', 'gemini-flash']);
    expect(recommendSubAgent('문법 검증')).toEqual(['groq-fast', 'gemini-flash']);
    expect(recommendSubAgent('체크해줘')).toEqual(['groq-fast', 'gemini-flash']);
  });

  test('설계/아키텍처/문서 → 큰 모델', () => {
    expect(recommendSubAgent('아키텍처 설계')).toEqual(['gemini-pro', 'workers-llama']);
    expect(recommendSubAgent('설계해줘')).toEqual(['gemini-pro', 'workers-llama']);
    expect(recommendSubAgent('문서 작성')).toEqual(['gemini-pro', 'workers-llama']);
  });

  test('생성/만들 → 코드 생성 특화', () => {
    expect(recommendSubAgent('앱 생성해줘')).toEqual(['gemini-flash', 'gemini-pro']);
    expect(recommendSubAgent('만들어줘')).toEqual(['gemini-flash', 'gemini-pro']);
  });

  test('빠른/간단 → 속도 우선', () => {
    expect(recommendSubAgent('빠른 확인')).toEqual(['groq-fast', 'workers-llama']);
    expect(recommendSubAgent('간단한 작업')).toEqual(['groq-fast', 'workers-llama']);
  });

  test('기본값 → gemini-flash', () => {
    expect(recommendSubAgent('뭔가 해줘')).toEqual(['gemini-flash']);
    expect(recommendSubAgent('')).toEqual(['gemini-flash']);
  });

  test('대소문자 무시', () => {
    // toLowerCase 후 비교하므로 한글은 그대로, 영문 키워드는 소문자로
    expect(recommendSubAgent('리뷰')).toEqual(['groq-fast', 'gemini-flash']);
  });

  test('우선순위: 리뷰가 설계보다 먼저', () => {
    // '리뷰'와 '설계' 둘 다 포함되면 리뷰 분기가 먼저
    expect(recommendSubAgent('설계 리뷰해줘')[0]).toBe('groq-fast');
  });
});

describe('selectSubAgentByClef', () => {
  test('유효한 choice면 해당 에이전트 반환', async () => {
    const invoke = makeInvoker({ answers: { subagent: { choice: 'groq-fast' } } });
    const result = await selectSubAgentByClef(invoke as any, '코드 리뷰해줘');
    expect(result).toBe('groq-fast');
  });

  test('무효한 choice면 규칙 기반 폴백', async () => {
    const invoke = makeInvoker({ answers: { subagent: { choice: 'invalid-agent' } } });
    const result = await selectSubAgentByClef(invoke as any, '코드 리뷰해줘');
    expect(result).toBe('groq-fast'); // recommendSubAgent('코드 리뷰해줘')[0]
  });

  test('choice가 없으면 규칙 기반 폴백', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await selectSubAgentByClef(invoke as any, '문서 작성해줘');
    expect(result).toBe('gemini-pro');
  });

  test('Clef가 제거된 nvidia-ultra를 골라도 선택되지 않고 규칙 기반으로 폴백', async () => {
    const invoke = makeInvoker({ answers: { subagent: { choice: 'nvidia-ultra' } } });
    const result = await selectSubAgentByClef(invoke as any, '문서 작성해줘');
    expect(result).toBe('gemini-pro');
  });

  test('answers가 없으면 규칙 기반 폴백', async () => {
    const invoke = makeInvoker(null);
    const result = await selectSubAgentByClef(invoke as any, '앱 만들어줘');
    expect(result).toBe('gemini-flash');
  });

  test('invoke 호출 인자 검증', async () => {
    const invoke = makeInvoker({ answers: { subagent: { choice: 'gemini-flash' } } });
    await selectSubAgentByClef(invoke as any, '테스트 작업');
    const arg = invoke.mock.calls[0][0];
    expect(arg.model).toBe('clef-flash');
    expect(arg.state.current_message).toBe('테스트 작업');
    expect(arg.questions.subagent.criteria['gemini-flash']).toBeDefined();
    expect(arg.questions.subagent.criteria['groq-fast']).toBeDefined();
    expect(arg.questions.subagent.criteria['nvidia-ultra']).toBeUndefined(); // 2026-10-30: 선택지에서 제거
    expect(arg.questions.subagent.criteria['workers-llama']).toBeDefined();
  });
});

describe('planSubAgentWork', () => {
  test('서브태스크별 플랜 생성', () => {
    const tasks = [
      { type: '코드 리뷰', description: '리뷰해줘' },
      { type: '문서 작성', description: '문서 써줘' },
    ];
    const result = planSubAgentWork('메인 목표', tasks, 'req-123');
    expect(result).toHaveLength(2);

    expect(result[0].agentId).toBe('groq-fast');
    expect(result[0].priority).toBe(0);
    expect(result[0].manifest.objective).toBe('리뷰해줘');
    expect(result[0].manifest.parentRequestId).toBe('req-123-sub-0');

    expect(result[1].agentId).toBe('gemini-pro');
    expect(result[1].priority).toBe(1);
    expect(result[1].manifest.parentRequestId).toBe('req-123-sub-1');
  });

  test('manifest에 에이전트 정보 포함', () => {
    const result = planSubAgentWork('목표', [{ type: '생성', description: '만들어줘' }], 'req-1');
    const manifest = result[0].manifest;
    expect(manifest.constraints).toContain('서브에이전트: 플래시 (gemini-3.5-flash-lite)');
    expect(manifest.constraints).toContain('최대 토큰: 8000');
    expect(manifest.maxTokens).toBe(8000);
    expect(manifest.context).toEqual({ mainObjective: '목표', taskType: '생성' });
    expect(manifest.allowedTools).toEqual([]);
  });

  test('빈 서브태스크면 빈 배열', () => {
    const result = planSubAgentWork('목표', [], 'req-1');
    expect(result).toEqual([]);
  });
});
