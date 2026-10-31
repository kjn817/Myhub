/// <reference types="jest" />
import {
  decomposeCompoundRequest,
  selectTool,
  checkResponseQuality,
  classifyUrgency,
  selectModelTier,
} from '../../src/services/clef-decisions';

// Mock ClefInvoker
function makeInvoker(response: any) {
  return jest.fn().mockResolvedValue(response);
}

describe('decomposeCompoundRequest', () => {
  test('현재는 null 반환 (TODO 상태)', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await decomposeCompoundRequest(invoke as any, 'A하고 B해줘');
    expect(result).toBeNull();
    expect(invoke).toHaveBeenCalled();
  });

  test('invoke 호출 인자 검증', async () => {
    const invoke = makeInvoker({ answers: {} });
    await decomposeCompoundRequest(invoke as any, '테스트 메시지');
    const callArg = invoke.mock.calls[0][0];
    expect(callArg.model).toBe('clef-flash');
    expect(callArg.state.current_message).toBe('테스트 메시지');
    expect(callArg.questions.task_count).toBeDefined();
    expect(callArg.questions.tasks).toBeDefined();
  });
});

describe('selectTool', () => {
  test('choice가 있으면 해당 도구 반환', async () => {
    const invoke = makeInvoker({ answers: { tool: { choice: 'memo_search' } } });
    const result = await selectTool(invoke as any, 'lumi', '메모 찾아줘');
    expect(result).toBe('memo_search');
  });

  test('choice가 없으면 null', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await selectTool(invoke as any, 'lumi', '안녕');
    expect(result).toBeNull();
  });

  test('answers가 없으면 null', async () => {
    const invoke = makeInvoker(null);
    const result = await selectTool(invoke as any, 'lumi', '안녕');
    expect(result).toBeNull();
  });

  test('invoke 호출 인자에 persona 포함', async () => {
    const invoke = makeInvoker({ answers: { tool: { choice: 'web_search' } } });
    await selectTool(invoke as any, 'nova', '검색해줘');
    const callArg = invoke.mock.calls[0][0];
    expect(callArg.state.persona).toBe('nova');
    expect(callArg.questions.tool.criteria.web_search).toBeDefined();
  });

  test('모든 도구 criteria 포함', async () => {
    const invoke = makeInvoker({ answers: { tool: { choice: 'code_gen' } } });
    await selectTool(invoke as any, 'nova', '코드 만들어줘');
    const criteria = invoke.mock.calls[0][0].questions.tool.criteria;
    expect(criteria.memo_search).toBeDefined();
    expect(criteria.web_search).toBeDefined();
    expect(criteria.summarize).toBeDefined();
    expect(criteria.code_gen).toBeDefined();
    expect(criteria.code_fix).toBeDefined();
    expect(criteria.schedule_create).toBeDefined();
    expect(criteria.schedule_read).toBeDefined();
  });
});

describe('checkResponseQuality', () => {
  test('good choice면 good=true', async () => {
    const invoke = makeInvoker({
      answers: { quality: { choice: 'good', probabilities: { good: 0.95 } } },
    });
    const result = await checkResponseQuality(invoke as any, '질문', '답변');
    expect(result.good).toBe(true);
    expect(result.confidence).toBe(0.95);
  });

  test('poor choice면 good=false', async () => {
    const invoke = makeInvoker({
      answers: { quality: { choice: 'poor', probabilities: { good: 0.1 } } },
    });
    const result = await checkResponseQuality(invoke as any, '질문', '답변');
    expect(result.good).toBe(false);
    expect(result.confidence).toBe(0.1);
  });

  test('probabilities가 없으면 confidence=0', async () => {
    const invoke = makeInvoker({ answers: { quality: { choice: 'good' } } });
    const result = await checkResponseQuality(invoke as any, '질문', '답변');
    expect(result.good).toBe(true);
    expect(result.confidence).toBe(0);
  });

  test('answers가 없으면 good=false', async () => {
    const invoke = makeInvoker({});
    const result = await checkResponseQuality(invoke as any, '질문', '답변');
    expect(result.good).toBe(false);
    expect(result.confidence).toBe(0);
  });

  test('긴 응답은 2000자로 잘림', async () => {
    const invoke = makeInvoker({ answers: { quality: { choice: 'good' } } });
    const longResponse = 'a'.repeat(5000);
    await checkResponseQuality(invoke as any, '질문', longResponse);
    const state = invoke.mock.calls[0][0].state;
    expect(state.generated_response.length).toBe(2000);
  });
});

describe('classifyUrgency', () => {
  test('urgent 반환', async () => {
    const invoke = makeInvoker({ answers: { urgency: { choice: 'urgent' } } });
    expect(await classifyUrgency(invoke as any, '빨리 해줘')).toBe('urgent');
  });

  test('normal 반환', async () => {
    const invoke = makeInvoker({ answers: { urgency: { choice: 'normal' } } });
    expect(await classifyUrgency(invoke as any, '해줘')).toBe('normal');
  });

  test('low 반환', async () => {
    const invoke = makeInvoker({ answers: { urgency: { choice: 'low' } } });
    expect(await classifyUrgency(invoke as any, '천천히 해줘')).toBe('low');
  });

  test('choice가 없으면 normal 기본값', async () => {
    const invoke = makeInvoker({ answers: {} });
    expect(await classifyUrgency(invoke as any, '해줘')).toBe('normal');
  });

  test('answers가 없으면 normal 기본값', async () => {
    const invoke = makeInvoker(null);
    expect(await classifyUrgency(invoke as any, '해줘')).toBe('normal');
  });
});

describe('selectModelTier', () => {
  test('fast 반환', async () => {
    const invoke = makeInvoker({ answers: { complexity: { choice: 'fast' } } });
    expect(await selectModelTier(invoke as any, '안녕')).toBe('fast');
  });

  test('high 반환', async () => {
    const invoke = makeInvoker({ answers: { complexity: { choice: 'high' } } });
    expect(await selectModelTier(invoke as any, '복잡한 코드 분석해줘')).toBe('high');
  });

  test('balanced 명시적 choice', async () => {
    const invoke = makeInvoker({ answers: { complexity: { choice: 'balanced' } } });
    expect(await selectModelTier(invoke as any, '설명해줘')).toBe('balanced');
  });

  test('choice가 없으면 balanced 기본값', async () => {
    const invoke = makeInvoker({ answers: {} });
    expect(await selectModelTier(invoke as any, '해줘')).toBe('balanced');
  });

  test('answers가 없으면 balanced 기본값', async () => {
    const invoke = makeInvoker(null);
    expect(await selectModelTier(invoke as any, '해줘')).toBe('balanced');
  });

  test('알 수 없는 choice면 balanced', async () => {
    const invoke = makeInvoker({ answers: { complexity: { choice: 'unknown' } } });
    expect(await selectModelTier(invoke as any, '해줘')).toBe('balanced');
  });
});
