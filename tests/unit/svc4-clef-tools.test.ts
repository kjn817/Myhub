/// <reference types="jest" />
import { MODULE_TOOLS, planTools, validateToolResult } from '../../src/services/clef-tools';

function makeInvoker(response: any) {
  return jest.fn().mockResolvedValue(response);
}

describe('MODULE_TOOLS', () => {
  test('모듈별 도구 정의', () => {
    expect(MODULE_TOOLS.memo).toContain('memo_create');
    expect(MODULE_TOOLS.memo).toContain('memo_search');
    expect(MODULE_TOOLS.schedule).toContain('schedule_create');
    expect(MODULE_TOOLS.todo).toContain('todo_create');
    expect(MODULE_TOOLS.search).toContain('web_search');
    expect(MODULE_TOOLS.file).toContain('file_upload');
  });
});

describe('planTools', () => {
  test('도구 선택되면 tools에 포함', async () => {
    const invoke = makeInvoker({
      answers: {
        primary_tool: { choice: 'memo_search' },
        needs_second_tool: { noul: 0 },
      },
    });
    const result = await planTools(invoke as any, 'lumi', '메모 찾아줘');
    expect(result).not.toBeNull();
    expect(result!.tools).toEqual(['memo_search']);
    expect(result!.sequence).toBe('sequential');
    expect(result!.reason).toBe('clef_selected');
  });

  test('none 선택이면 빈 tools', async () => {
    const invoke = makeInvoker({
      answers: { primary_tool: { choice: 'none' } },
    });
    const result = await planTools(invoke as any, 'lumi', '안녕');
    expect(result).toEqual({ tools: [], sequence: 'sequential', reason: 'no_tool_needed' });
  });

  test('primary_tool이 없으면 빈 tools', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await planTools(invoke as any, 'lumi', '안녕');
    expect(result!.tools).toEqual([]);
    expect(result!.reason).toBe('no_tool_needed');
  });

  test('허용 도구가 없는 persona면 null', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await planTools(invoke as any, 'unknown_persona' as any, '해줘');
    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('lumi의 허용 도구로 criteria 구성', async () => {
    const invoke = makeInvoker({
      answers: { primary_tool: { choice: 'web_search' } },
    });
    await planTools(invoke as any, 'lumi', '검색해줘');
    const criteria = invoke.mock.calls[0][0].questions.primary_tool.criteria;
    expect(criteria.web_search).toBeDefined();
    expect(criteria.memo_search).toBeDefined();
    expect(criteria.none).toBeDefined();
    // lumi는 memo_create가 없음
    expect(criteria.memo_create).toBeUndefined();
  });

  test('cali의 허용 도구에 schedule/todo 포함', async () => {
    const invoke = makeInvoker({
      answers: { primary_tool: { choice: 'schedule_create' } },
    });
    await planTools(invoke as any, 'cali', '일정 등록해줘');
    const criteria = invoke.mock.calls[0][0].questions.primary_tool.criteria;
    expect(criteria.schedule_create).toBe('일정 등록');
    expect(criteria.todo_create).toBe('할 일 등록');
  });

  test('invoke 호출 인자에 allowed_tools 문자열 포함', async () => {
    const invoke = makeInvoker({
      answers: { primary_tool: { choice: 'web_search' } },
    });
    await planTools(invoke as any, 'nova', '검색');
    const state = invoke.mock.calls[0][0].state;
    expect(state.allowed_tools).toContain('web_search');
    expect(state.persona).toBe('nova');
  });
});

describe('validateToolResult', () => {
  test('yes면 sufficient=true', async () => {
    const invoke = makeInvoker({
      answers: { sufficient: { choice: 'yes' } },
    });
    const result = await validateToolResult(invoke as any, '질문', 'memo_search', { data: 'x' });
    expect(result.sufficient).toBe(true);
    expect(result.nextTool).toBeUndefined();
  });

  test('no면 sufficient=false', async () => {
    const invoke = makeInvoker({
      answers: { sufficient: { choice: 'no' } },
    });
    const result = await validateToolResult(invoke as any, '질문', 'memo_search', null);
    expect(result.sufficient).toBe(false);
  });

  test('choice가 없으면 sufficient=false', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await validateToolResult(invoke as any, '질문', 'tool', 'result');
    expect(result.sufficient).toBe(false);
  });

  test('문자열 결과가 아닌 객체도 처리', async () => {
    const invoke = makeInvoker({
      answers: { sufficient: { choice: 'yes' } },
    });
    await validateToolResult(invoke as any, '질문', 'tool', { a: 1, b: 2 });
    const state = invoke.mock.calls[0][0].state;
    expect(state.has_content).toBe(true);
    expect(state.result_length).toBeGreaterThan(0);
  });

  test('null 결과면 has_content=false', async () => {
    const invoke = makeInvoker({
      answers: { sufficient: { choice: 'no' } },
    });
    await validateToolResult(invoke as any, '질문', 'tool', null);
    const state = invoke.mock.calls[0][0].state;
    expect(state.has_content).toBe(false);
  });

  test('undefined 결과도 정상 처리 (빈 문자열로 처리)', async () => {
    // 수정됨: JSON.stringify(undefined) ?? '' 로 빈 문자열 처리
    const invoke = makeInvoker({
      answers: { sufficient: { choice: 'no' } },
    });
    const result = await validateToolResult(invoke as any, '질문', 'tool', undefined);
    expect(result.sufficient).toBe(false);
  });
});
