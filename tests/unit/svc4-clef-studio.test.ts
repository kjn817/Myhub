/// <reference types="jest" />
import { planBuild, validateGeneratedCode } from '../../src/services/clef-studio';

function makeInvoker(response: any) {
  return jest.fn().mockResolvedValue(response);
}

describe('planBuild', () => {
  test('simple + 템플릿 매칭', async () => {
    const invoke = makeInvoker({
      answers: {
        complexity: { choice: 'simple' },
        template_match: { choice: 'calculator' },
        file_structure: { choice: 'single' },
      },
    });
    const result = await planBuild(invoke as any, '계산기 만들어줘');
    expect(result.complexity).toBe('simple');
    expect(result.templateMatch).toBe('calculator');
    expect(result.estimatedFiles).toEqual(['index.html']);
    expect(result.steps).toEqual([
      '템플릿 로드 중',
      '사용자 요청에 맞게 커스터마이징',
      '최종 검증',
    ]);
  });

  test('template none이면 null', async () => {
    const invoke = makeInvoker({
      answers: {
        complexity: { choice: 'medium' },
        template_match: { choice: 'none' },
        file_structure: { choice: 'single' },
      },
    });
    const result = await planBuild(invoke as any, '뭔가 만들어줘');
    expect(result.templateMatch).toBeNull();
  });

  test('template_match가 undefined면 null이 아닌 steps는 complexity 기준', async () => {
    const invoke = makeInvoker({
      answers: {
        complexity: { choice: 'complex' },
        file_structure: { choice: 'multi' },
      },
    });
    const result = await planBuild(invoke as any, '게임 만들어줘');
    expect(result.complexity).toBe('complex');
    expect(result.templateMatch).toBeUndefined();
    expect(result.estimatedFiles).toEqual(['index.html', 'style.css', 'app.js']);
    // templateMatch가 falsy이므로 complexity별 steps
    expect(result.steps).toContain('요구사항 분석');
  });

  test('simple + 템플릿 없음 → simple steps', async () => {
    const invoke = makeInvoker({
      answers: {
        complexity: { choice: 'simple' },
        template_match: { choice: 'none' },
        file_structure: { choice: 'single' },
      },
    });
    const result = await planBuild(invoke as any, '타이머');
    expect(result.steps).toEqual([
      'HTML 구조 생성',
      '스타일 적용',
      '기능 구현',
    ]);
  });

  test('medium 기본 steps', async () => {
    const invoke = makeInvoker({
      answers: {
        complexity: { choice: 'medium' },
        template_match: { choice: 'none' },
        file_structure: { choice: 'single' },
      },
    });
    const result = await planBuild(invoke as any, '투두리스트');
    expect(result.steps).toEqual([
      'HTML 구조 생성',
      'CSS 스타일링',
      'JavaScript 기능 구현',
      '최종 검증',
    ]);
  });

  test('complex steps', async () => {
    const invoke = makeInvoker({
      answers: {
        complexity: { choice: 'complex' },
        template_match: { choice: 'none' },
        file_structure: { choice: 'multi' },
      },
    });
    const result = await planBuild(invoke as any, '대시보드');
    expect(result.steps).toHaveLength(6);
    expect(result.steps[0]).toBe('요구사항 분석');
  });

  test('answers가 비어있으면 기본값 medium/single', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await planBuild(invoke as any, '뭔가');
    expect(result.complexity).toBe('medium');
    expect(result.estimatedFiles).toEqual(['index.html']);
  });

  test('invoke 호출 인자 검증', async () => {
    const invoke = makeInvoker({ answers: {} });
    await planBuild(invoke as any, '테스트 요청');
    const arg = invoke.mock.calls[0][0];
    expect(arg.model).toBe('clef-flash');
    expect(arg.state.current_message).toBe('테스트 요청');
    expect(arg.questions.complexity).toBeDefined();
    expect(arg.questions.template_match).toBeDefined();
    expect(arg.questions.file_structure).toBeDefined();
  });
});

describe('validateGeneratedCode', () => {
  test('complete면 valid=true', async () => {
    const invoke = makeInvoker({
      answers: { completeness: { choice: 'complete' } },
    });
    const result = await validateGeneratedCode(invoke as any, '계산기', '<html></html>');
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('incomplete면 valid=false, issues 포함', async () => {
    const invoke = makeInvoker({
      answers: { completeness: { choice: 'incomplete' } },
    });
    const result = await validateGeneratedCode(invoke as any, '계산기', '<html>');
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['incomplete']);
  });

  test('broken이면 valid=false', async () => {
    const invoke = makeInvoker({
      answers: { completeness: { choice: 'broken' } },
    });
    const result = await validateGeneratedCode(invoke as any, '게임', '깨진 내용');
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['broken']);
  });

  test('choice가 없으면 valid=false, issues=[unknown]', async () => {
    const invoke = makeInvoker({ answers: {} });
    const result = await validateGeneratedCode(invoke as any, '앱', '<html></html>');
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['unknown']);
  });

  test('state에 html 분석 정보 포함', async () => {
    const invoke = makeInvoker({ answers: { completeness: { choice: 'complete' } } });
    const html = '<html><style></style><script></script></html>';
    await validateGeneratedCode(invoke as any, '앱', html);
    const state = invoke.mock.calls[0][0].state;
    expect(state.html_length).toBe(html.length);
    expect(state.has_script).toBe(true);
    expect(state.has_style).toBe(true);
  });

  test('script/style 없으면 false', async () => {
    const invoke = makeInvoker({ answers: { completeness: { choice: 'complete' } } });
    await validateGeneratedCode(invoke as any, '앱', '<html></html>');
    const state = invoke.mock.calls[0][0].state;
    expect(state.has_script).toBe(false);
    expect(state.has_style).toBe(false);
  });
});
