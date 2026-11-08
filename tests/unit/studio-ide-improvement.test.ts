/// <reference types="jest" />
/**
 * AI 스튜디오 IDE 개선 (Phase A) 단위 테스트
 * - A1: ask_question 도구 + AwaitingInputSignal + 에이전트 루프 중단
 * - A2: 컨텍스트 디스틸레이션
 * - A3/A4: 디자인 스킬 + modify 검증 게이트
 * - A5: unified diff
 */

import { unifiedDiff } from '../../src/lib/text-diff';
import { StudioWorkspace, AwaitingInputSignal } from '../../src/services/studio-workspace';
import { STUDIO_TOOLS } from '../../src/services/studio-tools';
import { STUDIO_SKILLS } from '../../src/services/studio-skills';

// AbortSignal.timeout 폴리필
if (!(AbortSignal as any).timeout) {
  (AbortSignal as any).timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
}

describe('A5: unifiedDiff', () => {
  test('동일 텍스트는 빈 문자열', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBe('');
  });

  test('한 줄 변경 diff 생성', () => {
    const d = unifiedDiff('line1\nold\nline3', 'line1\nnew\nline3', 'f.html');
    expect(d).toContain('--- f.html');
    expect(d).toContain('+++ f.html');
    expect(d).toContain('-old');
    expect(d).toContain('+new');
    expect(d).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  test('추가만 있는 경우', () => {
    const d = unifiedDiff('a', 'a\nb\nc', 'f.txt');
    expect(d).toContain('+b');
    expect(d).toContain('+c');
    expect(d).not.toMatch(/^-[^--]/m);
  });

  test('삭제만 있는 경우', () => {
    const d = unifiedDiff('a\nb\nc', 'a', 'f.txt');
    expect(d).toContain('-b');
    expect(d).toContain('-c');
  });

  test('문맥 줄 포함 (hunk 병합)', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const neu = old.replace('line5', 'CHANGED');
    const d = unifiedDiff(old, neu, 'f.txt', 3);
    // hunk는 변경점 주변만 포함
    expect(d).toContain('CHANGED');
    expect(d).toContain('line2'); // 문맥
    expect(d).not.toContain('line15'); // 먼 줄은 제외
  });

  test('빈 파일에서 생성', () => {
    const d = unifiedDiff('', 'hello', 'new.html');
    expect(d).toContain('+hello');
  });

  test('특수문자 이스케이프 없이 그대로 포함', () => {
    const d = unifiedDiff('<div>', '<span>', 'f.html');
    expect(d).toContain('-<div>');
    expect(d).toContain('+<span>');
  });
});

describe('A1: ask_question 도구', () => {
  test('STUDIO_TOOLS에 ask_question 정의됨', () => {
    const tool = STUDIO_TOOLS.find((t: any) => t.function.name === 'ask_question');
    expect(tool).toBeDefined();
    expect(tool!.function.parameters.required).toContain('questions');
  });

  test('workspace.execute가 AwaitingInputSignal을 던짐', async () => {
    const ws = new StudioWorkspace({});
    const questions = [{ id: 'q1', question: '어떤 색상?' }];
    await expect(
      ws.execute({ name: 'ask_question', arguments: { questions } })
    ).rejects.toThrow(AwaitingInputSignal);
  });

  test('AwaitingInputSignal에 질문이 담김 (최대 3개)', async () => {
    const ws = new StudioWorkspace({});
    const questions = [
      { id: 'q1', question: '1' },
      { id: 'q2', question: '2' },
      { id: 'q3', question: '3' },
      { id: 'q4', question: '4' },
    ];
    try {
      await ws.execute({ name: 'ask_question', arguments: { questions } });
      fail('던져야 함');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AwaitingInputSignal);
      expect(e.questions).toHaveLength(3);
    }
  });

  test('questions 없으면 에러 결과 반환 (시그널 아님)', async () => {
    const ws = new StudioWorkspace({});
    const r = await ws.execute({ name: 'ask_question', arguments: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('questions');
  });

  test('에이전트 루프가 ask_question에서 중단됨', async () => {
    const { runStudioAgent } = await import('../../src/services/studio-agent');
    const mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    // Gemini 응답: ask_question 도구 호출
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: '질문이 있습니다' },
              { functionCall: { name: 'ask_question', args: { questions: [{ id: 'color', question: '어떤 색?' }] } } },
            ],
          },
          finishReason: 'STOP',
        }],
      })),
    });
    const result = await runStudioAgent(
      { GEMINI_API_KEY_1: 'test-key' },
      '버튼 앱 만들어줘',
      { provider: 'gemini', model: 'gemini-3.5-flash-lite', maxTurns: 3 }
    );
    expect(result.awaitingInput).toBe(true);
    expect(result.pendingQuestions).toHaveLength(1);
    expect(result.pendingQuestions![0].id).toBe('color');
    // 부분 파일은 유지됨
    expect(result.files).toBeDefined();
    delete (global as any).fetch;
  });
});

describe('A3/A4: 스킬', () => {
  test('design 스킬 존재 (라이트 테마)', () => {
    expect(STUDIO_SKILLS.design).toBeDefined();
    expect(STUDIO_SKILLS.design.content).toContain('라이트');
    expect(STUDIO_SKILLS.design.content).toContain('다크 모드 금지');
  });

  test('modify 스킬에 확인 단계 포함', () => {
    expect(STUDIO_SKILLS.modify.content).toContain('read_file로 수정된 부분을 다시 읽어');
  });
});

describe('A2: distillMessages', () => {
  test('짧은 대화는 그대로 반환', async () => {
    const { distillMessages } = await import('../../src/services/studio-agent');
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'model', parts: [{ text: 'hello' }] }];
    expect(distillMessages(msgs, true)).toBe(msgs);
  });

  test('Gemini: 오래된 턴의 tool-call이 텍스트로 축소됨', async () => {
    const { distillMessages } = await import('../../src/services/studio-agent');
    const msgs: any[] = [{ role: 'user', content: 'prompt' }];
    // 10턴 분량 추가 (각 턴: model functionCall + user functionResponse)
    for (let t = 0; t < 10; t++) {
      msgs.push({ role: 'model', parts: [{ functionCall: { name: 'create_file', args: { path: `f${t}.html` } } }] });
      msgs.push({ role: 'user', parts: [{ functionResponse: { name: 'create_file', response: { result: 'ok' } } }] });
    }
    const out = distillMessages(msgs, true);
    // Gemini는 1:1 매핑이라 길이는 그대로, 내용이 디스틸레이션됨
    expect(out.length).toBe(msgs.length);
    // head/tail은 원본 유지
    expect(out[0]).toBe(msgs[0]);
    expect(out[out.length - 1]).toBe(msgs[msgs.length - 1]);
    // 중간은 텍스트 요약 (functionCall/functionResponse 없음)
    const mid = out.slice(2, out.length - 6);
    for (const m of mid) {
      const texts = (m.parts || []).map((p: any) => JSON.stringify(p)).join('');
      expect(texts).not.toContain('functionCall');
      expect(texts).not.toContain('functionResponse');
    }
    // 디스틸레이션으로 토큰 감소 확인 (원본 대비 짧아짐)
    const origLen = JSON.stringify(msgs).length;
    const newLen = JSON.stringify(out).length;
    expect(newLen).toBeLessThan(origLen);
    // role 교대 유지 (user/model)
    for (const m of out) {
      expect(['user', 'model']).toContain(m.role);
    }
  });

  test('OpenAI: assistant+tool 쌍이 하나로 병합됨', async () => {
    const { distillMessages } = await import('../../src/services/studio-agent');
    const msgs: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'prompt' },
    ];
    for (let t = 0; t < 8; t++) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${t}`, function: { name: 'create_file', arguments: '{}' } }] });
      msgs.push({ role: 'tool', tool_call_id: `c${t}`, content: '{"output":"ok"}' });
    }
    const out = distillMessages(msgs, false);
    expect(out.length).toBeLessThan(msgs.length);
    // tool 역할 메시지가 중간에 단독으로 남지 않음
    const mid = out.slice(2, out.length - 6);
    for (const m of mid) {
      expect(m.role).not.toBe('tool');
      if (m.role === 'assistant') {
        expect(m.tool_calls).toBeUndefined();
      }
    }
  });

  test('Gemini: parts 없는 content 메시지도 축소됨', async () => {
    const { distillMessages } = await import('../../src/services/studio-agent');
    const msgs: any[] = [{ role: 'user', content: 'prompt' }];
    for (let t = 0; t < 10; t++) {
      msgs.push({ role: 'user', content: `옛날 메시지 ${t} ` + 'x'.repeat(2000) });
    }
    const out = distillMessages(msgs, true);
    const mid = out.slice(2, out.length - 6);
    for (const m of mid) {
      expect(m.parts[0].text.length).toBeLessThanOrEqual(1500);
    }
  });

  test('OpenAI: 중간 일반 메시지도 축소됨', async () => {
    const { distillMessages } = await import('../../src/services/studio-agent');
    const msgs: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'prompt' },
    ];
    for (let t = 0; t < 10; t++) {
      msgs.push({ role: 'user', content: `질문 ${t} ` + 'y'.repeat(2000) });
    }
    const out = distillMessages(msgs, false);
    const mid = out.slice(2, out.length - 6);
    for (const m of mid) {
      expect(m.content.length).toBeLessThanOrEqual(1500);
    }
  });

  test('execTool: 일반 에러는 다시 던짐', async () => {
    const { execTool } = await import('../../src/services/studio-agent');
    const boom = new Error('boom');
    const fakeWs = { execute: async () => { throw boom; } } as any;
    await expect(execTool(fakeWs, { name: 'x', arguments: {} })).rejects.toBe(boom);
  });

  test('Groq 경로에서도 ask_question 중단됨', async () => {
    const { runStudioAgent } = await import('../../src/services/studio-agent');
    const mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'ask_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '?' }] }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })),
    });
    const result = await runStudioAgent(
      { GROQ_API_KEY_1: 'g' },
      '앱 만들어줘',
      { provider: 'groq', model: 'openai/gpt-oss-120b', maxTurns: 2 }
    );
    expect(result.awaitingInput).toBe(true);
    expect(result.pendingQuestions).toHaveLength(1);
    delete (global as any).fetch;
  });
});
