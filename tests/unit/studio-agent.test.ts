/**
 * studio-agent.ts 100% 커버리지 목표 단위 테스트
 * - fetch 전역 mock으로 Gemini/Groq/NVIDIA API 응답 시뮬레이션
 * - 소스 수정 없이 테스트만으로 모든 분기 커버
 */
import { runStudioAgent } from '../../src/services/studio-agent';

// AbortSignal.timeout 폴리필 (Node <18 대비)
if (!(AbortSignal as any).timeout) {
  (AbortSignal as any).timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
}

const mockFetch = jest.fn();

function mockResp(status: number, ok: boolean, data: any) {
  return {
    ok,
    status,
    text: jest.fn().mockResolvedValue(typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

function geminiOk(parts: any[], extra: any = {}) {
  return mockResp(200, true, {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    responseId: 'r1',
    modelVersion: 'gemini-3.5-flash-lite',
    usageMetadata: { promptTokenCount: 10 },
    ...extra,
  });
}

function groqOk(message: any) {
  return mockResp(200, true, { choices: [{ message, finish_reason: 'tool_calls' }] });
}

function fc(name: string, args: any, id?: string) {
  return { functionCall: { name, args, ...(id ? { id } : {}) } };
}

function groqTc(name: string, args: any, id?: string, type = 'function') {
  return { ...(id ? { id } : {}), type, function: { name, arguments: JSON.stringify(args) } };
}

const INDEX_HTML = '<!DOCTYPE html><html><head><title>t</title></head><body><h1>hi</h1></body></html>';

function reqBody(callIndex: number) {
  return JSON.parse((mockFetch.mock.calls[callIndex] as any[])[1].body);
}

beforeEach(() => {
  mockFetch.mockReset();
  (global as any).fetch = mockFetch;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runStudioAgent - 키/초기화', () => {
  test('gemini 키 없음 → 에러 (turns 0)', async () => {
    const r = await runStudioAgent({}, 'hello');
    expect(r.ok).toBe(false);
    expect(r.turns).toBe(0);
    expect(r.error).toBe('gemini API 키 없음');
    expect(r.files).toEqual({});
  });

  test('알 수 없는 provider → 키 없음 에러 (prefixes[provider] || [] 분기)', async () => {
    const r = await runStudioAgent({}, 'hello', { provider: 'foo' as any });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('foo API 키 없음');
  });

  test('groq 키 없음 → 에러', async () => {
    const r = await runStudioAgent({}, 'hello', { provider: 'groq' });
    expect(r.error).toBe('groq API 키 없음');
  });

  test('nvidia provider → 진입점 거부 (2026-10-30: NVIDIA 운영 제외)', async () => {
    // 키가 있어도 거부된다 — 키 없음 에러보다 앞단에서 fail-closed
    const r = await runStudioAgent({ NVIDIA_API_KEY_1: 'n' }, 'hello', { provider: 'nvidia' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('PROVIDER_DISABLED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('model 옵션 전달 → URL에 반영', async () => {
    mockFetch.mockResolvedValueOnce(geminiOk([{ text: 'hi' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hello', { model: 'gemini-2.0-flash' });
    expect(r.ok).toBe(true);
    expect((mockFetch.mock.calls[0] as any[])[0]).toContain('gemini-2.0-flash');
  });
});

describe('runStudioAgent - gemini 기본 플로우', () => {
  test('대화 모드: 도구 호출 없이 텍스트만 → ok:true (chat)', async () => {
    mockFetch.mockResolvedValueOnce(geminiOk([{ text: '안녕하세요!' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hello', { jobId: 'j1' });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual({});
    expect(r.turns).toBe(1);
    expect(r.summary).toBe('안녕하세요!');
  });

  test('앱 생성 2턴 플로우 + toolConfig/isFirstCall 분기', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: 'index.html', content: INDEX_HTML }, 'f1')]))
      .mockResolvedValueOnce(geminiOk([{ text: '완성!' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, '앱 만들어줘', { jobId: 42 });
    expect(r.ok).toBe(true);
    expect(r.turns).toBe(2);
    expect(r.files['index.html']).toBe(INDEX_HTML);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]).toContain('create_file(path=index.html');
    expect(r.toolCalls![0]).toContain('ok=true');
    // 1턴째 toolConfig 강제, 2턴째 없음
    const b1 = reqBody(0);
    expect(b1.toolConfig.functionCallingConfig.mode).toBe('ANY');
    expect(b1.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['create_file']);
    const b2 = reqBody(1);
    expect(b2.toolConfig).toBeUndefined();
    // systemInstruction 포함 (geminiSystem truthy 분기)
    expect(b1.systemInstruction.parts[0].text.length).toBeGreaterThan(0);
    // 2턴째 contents에 rawContent 그대로 포함 (m.parts 분기)
    expect(b2.contents[1].parts[0].functionCall.name).toBe('create_file');
    expect(b2.contents[2].parts[0].functionResponse.name).toBe('create_file');
    expect(b2.contents[2].parts[0].functionResponse.id).toBe('f1');
  });

  test('관문 7: initialFiles + 1턴째 도구 0개 → 종료하지 않고 계속 (최소 2턴)', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([{ text: '생각 중...' }]))
      .mockResolvedValueOnce(geminiOk([{ text: '완료' }]));
    const r = await runStudioAgent(
      { GEMINI_API_KEY_1: 'k' },
      '수정해줘',
      { initialFiles: { 'index.html': INDEX_HTML } },
    );
    expect(r.turns).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.files['index.html']).toBe(INDEX_HTML);
  });

  test('관문 48: maxTurns 도달 시 루프 종료', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: 'a1.html', content: '<b>1</b>' }, 'f1')]))
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: 'a2.html', content: '<b>2</b>' }, 'f2')]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'go', { maxTurns: 2 });
    expect(r.turns).toBe(2);
    // index.html 없어서 검증 실패
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ARTIFACT_VALIDATION_FAILED');
    expect(r.error).toContain('INDEX_HTML_MISSING');
    expect(r.error).toContain('[도구호출:');
  });

  test('wall clock budget 초과 → 즉시 실패', async () => {
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'go', { wallClockBudgetMs: -1 });
    expect(r.ok).toBe(false);
    expect(r.turns).toBe(0);
    expect(r.error).toContain('AGENT_WALL_CLOCK_BUDGET');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('wallClockBudgetMs 명시 → 정상 진행', async () => {
    mockFetch.mockResolvedValueOnce(geminiOk([{ text: 'hi' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi', { wallClockBudgetMs: 60000 });
    expect(r.ok).toBe(true);
  });

  test('summary 500자 슬라이스 (최종 반환 경로)', async () => {
    const long = 'x'.repeat(900);
    mockFetch
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: 'index.html', content: INDEX_HTML }, 'f1')]))
      .mockResolvedValueOnce(geminiOk([{ text: long }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(true);
    expect(r.summary).toHaveLength(500);
  });

  test('대화 모드 summary는 슬라이스 안 함 (코드 동작 확인)', async () => {
    const long = 'y'.repeat(900);
    mockFetch.mockResolvedValueOnce(geminiOk([{ text: long }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.summary).toHaveLength(900);
  });
});

describe('callWithTools - 에러 처리', () => {
  test('429 → 즉시 중단 (503 아님)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResp(429, false, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }),
    );
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.turns).toBe(1);
    expect(r.error).toContain('[http:429:RESOURCE_EXHAUSTED]');
    expect(r.error).toContain('quota exceeded');
  });

  test('401 → providerCode HTTP_ERROR 폴백 아님 (message 있음)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResp(401, false, { error: { message: 'invalid key' } }),
    );
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.error).toContain('[http:401:HTTP_ERROR]');
    expect(r.error).toContain('invalid key');
  });

  test('500 + error.message 없음 → "HTTP 500" 폴백', async () => {
    mockFetch.mockResolvedValueOnce(mockResp(500, false, {}));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.error).toContain('[http:500:HTTP_ERROR]');
    expect(r.error).toContain('HTTP 500');
  });

  test('500 + error.code만 → providerCode는 code 사용', async () => {
    mockFetch.mockResolvedValueOnce(mockResp(500, false, { error: { code: 'INTERNAL' } }));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.error).toContain('[http:500:INTERNAL]');
  });

  test('관문 40: 503 → 키 로테이션 후 성공', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResp(503, false, { error: { message: 'overloaded' } }))
      .mockResolvedValueOnce(geminiOk([{ text: 'rotated ok' }]));
    const r = await runStudioAgent(
      { GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_3: 'k3' }, // _2 없음 → if(val) false 분기
      'hi',
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('rotated ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('503 전부 실패 → 에러 반환', async () => {
    mockFetch.mockResolvedValue(mockResp(503, false, {}));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('[http:503:HTTP_ERROR]');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('transport 실패 → TRANSPORT_FAILED + 키 마스킹', async () => {
    mockFetch.mockRejectedValueOnce(
      new Error('socket hang up key=sk-secret123&x=1 token AIzaSyD-abc_def123'),
    );
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('[transport:-:TRANSPORT_FAILED]');
    expect(r.error).not.toContain('sk-secret123');
    expect(r.error).not.toContain('AIzaSyD-abc_def123');
    expect(r.error).toContain('[REDACTED]');
  });

  test('긴 transport 에러 → 1000자 슬라이스', async () => {
    mockFetch.mockRejectedValueOnce(new Error('e'.repeat(2000)));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error!.length).toBeLessThanOrEqual(1000 + '[transport:-:TRANSPORT_FAILED] '.length);
  });

  test('JSON 파싱 실패 → INVALID_JSON', async () => {
    mockFetch.mockResolvedValueOnce(mockResp(200, true, 'this is not json{{{'));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('[parse:200:INVALID_JSON]');
  });

  test('res.text() reject → rawText 빈문자열 → INVALID_JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: jest.fn().mockRejectedValue(new Error('body gone')),
    });
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.error).toContain('[parse:200:INVALID_JSON]');
  });

  test('요청 직렬화 실패 → SERIALIZATION_FAILED', async () => {
    const spy = jest.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new Error('circular');
    });
    try {
      const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('[request:-:SERIALIZATION_FAILED]');
    } finally {
      spy.mockRestore();
    }
  });

  test('GeminiCallError 아닌 예외 → stageInfo 없음', async () => {
    // parts가 배열이 아니면 logGeminiDiagnostics catch 후 for...of에서 TypeError
    mockFetch.mockResolvedValueOnce(geminiOk(123 as any));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('[');
  });

  test('candidate 없음 (차단 응답) → toolCalls 0, 대화 모드', async () => {
    mockFetch.mockResolvedValueOnce(mockResp(200, true, { promptFeedback: { blockReason: 'SAFETY' } }));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(true); // 파일 없어서 대화 모드
    expect(r.turns).toBe(1);
    expect(r.summary).toBe('');
  });

  test('EDGE: candidate 없음 + initialFiles → rawContent undefined 시 push 건너뜀 (2026-10-17 수정됨)', async () => {
    // turn1: candidate 없음 → rawContent undefined → push 건너뛰고 정상 계속
    mockFetch.mockResolvedValue(mockResp(200, true, { promptFeedback: { blockReason: 'SAFETY' } }));
    const r = await runStudioAgent(
      { GEMINI_API_KEY_1: 'k' },
      'hi',
      { initialFiles: { 'index.html': INDEX_HTML }, maxTurns: 3 },
    );
    // 수정 후: TypeError 없이 정상 처리됨 (차단된 응답도 graceful하게 처리)
    expect(r.ok).toBe(true);
  });

  test('part 타입 other → partTypes에 other', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([{ text: 'a' }, { unknownField: 1 } as any, fc('create_file', { path: 'index.html', content: INDEX_HTML }, 'f1')]))
      .mockResolvedValueOnce(geminiOk([{ text: 'done' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'go');
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('done');
  });
});

describe('callWithTools - gemini 지역 제한 릴레이', () => {
  const relayEnv = {
    GEMINI_API_KEY_1: 'k',
    GEMINI_RELAY_URL: 'https://relay.example.com/v1',
    GEMINI_RELAY_SECRET: 's3cr3t',
  };
  const blocked = () =>
    mockResp(400, false, { error: { message: 'User location is not supported for the API use', status: 'FAILED_PRECONDITION' } });

  test('릴레이 성공 (body 문자열)', async () => {
    mockFetch
      .mockResolvedValueOnce(blocked())
      .mockResolvedValueOnce(
        mockResp(200, true, {
          ok: true,
          body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'via relay' }] }, finishReason: 'STOP' }] }),
        }),
      );
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('via relay');
    const relayCall = mockFetch.mock.calls[1] as any[];
    expect(relayCall[0]).toBe('https://relay.example.com/v1');
    expect(relayCall[1].headers['X-Relay-Key']).toBe('s3cr3t');
  });

  test('릴레이 성공 (body 객체)', async () => {
    mockFetch
      .mockResolvedValueOnce(blocked())
      .mockResolvedValueOnce(
        mockResp(200, true, {
          ok: true,
          body: { candidates: [{ content: { parts: [{ text: 'obj' }] }, finishReason: 'STOP' }] },
        }),
      );
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('obj');
  });

  test('지역 제한 + 릴레이 env 없음 → 스키마 오류로 throw', async () => {
    mockFetch.mockResolvedValueOnce(blocked());
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('[http:400:FAILED_PRECONDITION]');
    expect(r.error).toContain('User location is not supported');
  });

  test('지역 제한 + relay secret 없음 → throw', async () => {
    mockFetch.mockResolvedValueOnce(blocked());
    const r = await runStudioAgent(
      { GEMINI_API_KEY_1: 'k', GEMINI_RELAY_URL: 'https://relay.example.com' },
      'hi',
    );
    expect(r.error).toContain('[http:400:FAILED_PRECONDITION]');
  });

  test('400이지만 지역 제한 아님 → 스키마 오류', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResp(400, false, { error: { message: 'invalid schema', status: 'INVALID_ARGUMENT' } }),
    );
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.error).toContain('[http:400:INVALID_ARGUMENT]');
    expect(mockFetch).toHaveBeenCalledTimes(1); // 릴레이 시도 안 함
  });

  test('릴레이 transport 실패 → RELAY_TRANSPORT_FAILED', async () => {
    mockFetch
      .mockResolvedValueOnce(blocked())
      .mockRejectedValueOnce(new Error('relay down'));
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.error).toContain('[transport:-:RELAY_TRANSPORT_FAILED]');
  });

  test('릴레이 JSON 파싱 실패 → RELAY_INVALID_JSON', async () => {
    mockFetch
      .mockResolvedValueOnce(blocked())
      .mockResolvedValueOnce(mockResp(200, true, 'not-json{{{'));
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.error).toContain('[parse:200:RELAY_INVALID_JSON]');
  });

  test('릴레이 ok:false + body → RELAY_FAILED (body 분기)', async () => {
    mockFetch
      .mockResolvedValueOnce(blocked())
      .mockResolvedValueOnce(mockResp(200, true, { ok: false, body: 'relay exploded' }));
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.error).toContain('[http:200:RELAY_FAILED]');
    expect(r.error).toContain('relay exploded');
  });

  test('릴레이 ok:false + error만 → RELAY_FAILED (error 분기)', async () => {
    mockFetch
      .mockResolvedValueOnce(blocked())
      .mockResolvedValueOnce(mockResp(200, true, { ok: false, error: 'bad gateway' }));
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.error).toContain('bad gateway');
  });

  test('릴레이 ok:false + 둘 다 없음 → "릴레이 실패"', async () => {
    mockFetch
      .mockResolvedValueOnce(blocked())
      .mockResolvedValueOnce(mockResp(200, true, { ok: false }));
    const r = await runStudioAgent(relayEnv, 'hi');
    expect(r.error).toContain('릴레이 실패');
  });
});

describe('runStudioAgent - groq/nvidia (OpenAI 호환)', () => {
  test('groq URL + tool_choice required→auto + assistant 메시지 보존', async () => {
    mockFetch
      .mockResolvedValueOnce(
        groqOk({ content: '', tool_calls: [groqTc('create_file', { path: 'index.html', content: INDEX_HTML }, 'call_1')] }),
      )
      .mockResolvedValueOnce(groqOk({ content: 'done', tool_calls: [] }));
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'g' }, '앱 만들어줘', { provider: 'groq' });
    expect(r.ok).toBe(true);
    expect(r.turns).toBe(2);
    expect(r.files['index.html']).toBe(INDEX_HTML);
    const call0 = mockFetch.mock.calls[0] as any[];
    expect(call0[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(call0[1].headers['Authorization']).toBe('Bearer g');
    expect(reqBody(0).tool_choice).toBe('required');
    expect(reqBody(1).tool_choice).toBe('auto');
    // system 메시지 포함 (비-gemini 분기)
    expect(reqBody(0).messages[0].role).toBe('system');
    // assistant 턴 보존 (tool_calls 포함) — messages: [system, user, assistant, tool]
    expect(reqBody(1).messages[2].role).toBe('assistant');
    expect(reqBody(1).messages[2].tool_calls[0].id).toBe('call_1');
    // tool 역할 메시지 (tool_call_id = rawTc.id)
    expect(reqBody(1).messages[3].role).toBe('tool');
    expect(reqBody(1).messages[3].tool_call_id).toBe('call_1');
  });

  test('nvidia URL로 절대 나가지 않는다 (2026-10-30: 직접 호출 경로 차단)', async () => {
    const r = await runStudioAgent({ NVIDIA_API_KEY_1: 'n' }, 'hi', { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('PROVIDER_DISABLED');
    const urls = mockFetch.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u.includes('integrate.api.nvidia.com'))).toBe(false);
  });

  test('tool_call type이 function 아님 → 스킵', async () => {
    mockFetch
      .mockResolvedValueOnce(
        groqOk({ content: '', tool_calls: [{ id: 'x1', type: 'custom', function: { name: 'create_file', arguments: '{}' } }] }),
      )
      .mockResolvedValueOnce(groqOk({ content: 'done', tool_calls: [] }));
    const r = await runStudioAgent(
      { GROQ_API_KEY_1: 'g' },
      'hi',
      { provider: 'groq', initialFiles: { 'index.html': INDEX_HTML } },
    );
    expect(r.turns).toBe(2);
    expect(r.ok).toBe(true);
  });

  test('tool_call arguments JSON 파싱 실패 → 스킵 (catch{})', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'x1', type: 'function', function: { name: 'x', arguments: '{bad json' } }] } }] }),
      ),
    });
    // 두 번째 호출: 대화 모드
    mockFetch.mockResolvedValueOnce(groqOk({ content: 'hi', tool_calls: [] }));
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'g' }, 'hi', { provider: 'groq' });
    expect(r.ok).toBe(true);
    expect(r.turns).toBe(1); // 파싱 실패 → toolCalls 0 → 파일 없음 → 대화 모드
    expect(r.summary).toBe('');
  });

  test('tool_call id 없음 → tool_call_id 폴백 call_<idx>', async () => {
    mockFetch
      .mockResolvedValueOnce(
        groqOk({ content: '', tool_calls: [groqTc('create_file', { path: 'index.html', content: INDEX_HTML })] }),
      )
      .mockResolvedValueOnce(groqOk({ content: 'done', tool_calls: [] }));
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'g' }, 'go', { provider: 'groq' });
    expect(r.ok).toBe(true);
    expect(reqBody(1).messages[3].tool_call_id).toBe('call_0');
  });

  test('groq content 비어있음 → content null', async () => {
    mockFetch
      .mockResolvedValueOnce(
        groqOk({ content: '', tool_calls: [groqTc('create_file', { path: 'index.html', content: INDEX_HTML }, 'c1')] }),
      )
      .mockResolvedValueOnce(groqOk({ content: 'ok', tool_calls: [] }));
    await runStudioAgent({ GROQ_API_KEY_1: 'g' }, 'go', { provider: 'groq' });
    expect(reqBody(1).messages[2].content).toBeNull();
  });

  test('groq 도구 실패 + 검증 실패 → 도구 호출 히스토리 기록됨', async () => {
    mockFetch.mockResolvedValueOnce(
      groqOk({ content: '', tool_calls: [groqTc('create_file', { path: '../evil', content: 'x' }, 'c1')] }),
    );
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'g' }, 'go', { provider: 'groq', maxTurns: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('INDEX_HTML_MISSING');
    // A1: OpenAI 경로도 도구 호출 히스토리 기록 (관측성 개선)
    expect(r.error).toContain('[도구호출: create_file(path=../evil');
    expect(r.toolCalls).toHaveLength(1);
  });

  test('groq 500 → 릴레이 시도 안 함 (provider gemini 아님)', async () => {
    mockFetch.mockResolvedValueOnce(mockResp(500, false, { error: { message: 'User location is not supported' } }));
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'g' }, 'hi', { provider: 'groq' });
    expect(r.error).toContain('[http:500:HTTP_ERROR]');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('runStudioAgent - gemini 도구 호출 엣지', () => {
  test('도구 실패 → functionResponse ERROR + id 없음 분기', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: '../evil', content: 'x' })])) // id 없음
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: 'index.html', content: INDEX_HTML }, 'f2')]))
      .mockResolvedValueOnce(geminiOk([{ text: 'done' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'go');
    expect(r.ok).toBe(true);
    expect(r.turns).toBe(3);
    // 첫 도구 실패 → ERROR 응답, id 없으면 functionResponse에 id 없음
    const b2 = reqBody(1);
    const fr = b2.contents[2].parts[0].functionResponse;
    expect(fr.response.result).toContain('ERROR');
    expect(fr.id).toBeUndefined();
    expect(r.toolCalls![0]).toContain('ok=false');
  });

  test('args 없음 → path EMPTY, content N/A (validate_files 호출)', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([
        fc('validate_files', {}),
        fc('create_file', { path: 'index.html', content: INDEX_HTML }, 'f2'),
      ]))
      .mockResolvedValueOnce(geminiOk([{ text: 'checked' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'go');
    expect(r.ok).toBe(true);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls![0]).toContain('validate_files(path=EMPTY');
    expect(r.toolCalls![0]).toContain('content_len=N/A');
  });

  test('functionCall args undefined → {} 폴백', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([{ functionCall: { name: 'validate_files' } }]))
      .mockResolvedValueOnce(geminiOk([{ text: 'ok' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'go');
    expect(r.ok).toBe(true);
  });
});

describe('validateArtifact 분기', () => {
  async function twoTurn(files: Array<{ path: string; content: string }>) {
    const parts = files.map((f, i) => fc('create_file', { path: f.path, content: f.content }, `f${i}`));
    mockFetch
      .mockResolvedValueOnce(geminiOk(parts))
      .mockResolvedValueOnce(geminiOk([{ text: 'done' }]));
    return runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'go');
  }

  test('DOCTYPE 없음 → DOCTYPE_MISSING', async () => {
    const r = await twoTurn([{ path: 'index.html', content: '<html><body></body></html>' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('DOCTYPE_MISSING');
    expect(r.error).not.toContain('HTML_ROOT_MISSING');
  });

  test('html 루트 없음 → HTML_ROOT_MISSING', async () => {
    const r = await twoTurn([{ path: 'index.html', content: '<!DOCTYPE html><body></body>' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('HTML_ROOT_MISSING');
  });

  test('빈 파일 → EMPTY_FILE', async () => {
    const r = await twoTurn([
      { path: 'index.html', content: INDEX_HTML },
      { path: 'empty.txt', content: '' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('EMPTY_FILE:empty.txt');
  });

  test('정상 → ok:true, error undefined', async () => {
    const r = await twoTurn([{ path: 'index.html', content: INDEX_HTML }]);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });
});

describe('추가 분기 커버리지', () => {
  test('빈 userPrompt → m.content || "" 우측 분기', async () => {
    mockFetch.mockResolvedValueOnce(geminiOk([{ text: 'hi' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, '');
    expect(r.ok).toBe(true);
    const b = reqBody(0);
    expect(b.contents[0].parts[0].text).toBe('');
  });

  test('fetch가 Error 아닌 값으로 reject → String(error)', async () => {
    mockFetch.mockRejectedValueOnce('plain string failure' as any);
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('[transport:-:TRANSPORT_FAILED]');
    expect(r.error).toContain('plain string failure');
  });

  test('gemini 400 + error 없음 → (message || "") 우측 분기', async () => {
    mockFetch.mockResolvedValueOnce(mockResp(400, false, {}));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hi');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('[http:400:HTTP_ERROR]');
  });

  test('릴레이 res.text() reject → catch 콜백', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResp(400, false, { error: { message: 'User location is not supported for the API use' } }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: jest.fn().mockRejectedValue(new Error('gone')),
      });
    const r = await runStudioAgent({
      GEMINI_API_KEY_1: 'k',
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 's',
    }, 'hi');
    expect(r.error).toContain('[parse:200:RELAY_INVALID_JSON]');
  });

  test('릴레이 응답 {} → relayData.ok ?? null 우측 + "릴레이 실패"', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResp(400, false, { error: { message: 'User location is not supported for the API use' } }),
      )
      .mockResolvedValueOnce(mockResp(200, true, {}));
    const r = await runStudioAgent({
      GEMINI_API_KEY_1: 'k',
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 's',
    }, 'hi');
    expect(r.error).toContain('[http:200:RELAY_FAILED]');
    expect(r.error).toContain('릴레이 실패');
  });

  test('릴레이 성공 but candidates 없음 → ?? 0 우측 분기', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResp(400, false, { error: { message: 'User location is not supported for the API use' } }),
      )
      .mockResolvedValueOnce(mockResp(200, true, { ok: true, body: { note: 'empty' } }));
    const r = await runStudioAgent({
      GEMINI_API_KEY_1: 'k',
      GEMINI_RELAY_URL: 'https://relay.example.com',
      GEMINI_RELAY_SECRET: 's',
    }, 'hi');
    expect(r.ok).toBe(true); // toolCalls 0, 파일 없음 → 대화 모드
    expect(r.summary).toBe('');
  });

  test('groq tool_calls 없음 → msg?.tool_calls || [] 우측 분기', async () => {
    mockFetch.mockResolvedValueOnce(groqOk({ content: 'hello' }));
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'g' }, 'hi', { provider: 'groq' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('hello');
  });

  test('groq function.arguments 없음 → || "{}" 우측 분기', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'create_file' } }] } }],
        })),
      })
      .mockResolvedValueOnce(groqOk({ content: 'done' }));
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'g' }, 'hi', { provider: 'groq' });
    expect(r.ok).toBe(true); // arguments {} → create_file 실패(경로 없음) → 파일 없음 → 대화 모드
    expect(r.summary).toBe('done');
  });
});

describe('gemini 메시지 변환 엣지', () => {
  test("role 'assistant' (parts 없음) → 'model' 변환 분기", async () => {
    // turn1: content에 parts가 없고 role이 assistant → rawContent push → turn2에서 변환
    mockFetch
      .mockResolvedValueOnce(
        mockResp(200, true, {
          candidates: [{ content: { role: 'assistant' }, finishReason: 'STOP' }],
        }),
      )
      .mockResolvedValueOnce(geminiOk([{ text: 'done' }]));
    const r = await runStudioAgent(
      { GEMINI_API_KEY_1: 'k' },
      'hi',
      { initialFiles: { 'index.html': INDEX_HTML } },
    );
    expect(r.turns).toBe(2);
    expect(r.ok).toBe(true);
    const b2 = reqBody(1);
    // messages[1] = rawContent {role:'assistant'} → 변환되어 role 'model'
    expect(b2.contents[1].role).toBe('model');
    expect(b2.contents[1].parts).toEqual([{ text: '' }]);
  });
});

describe('B2: onFileWrite 스트리밍 콜백', () => {
  test('파일 쓰기 도구 실행 시 onFileWrite 호출', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: 'index.html', content: INDEX_HTML })]))
      .mockResolvedValueOnce(geminiOk([{ text: 'done' }]));
    const writes: any[] = [];
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'make app', {
      onFileWrite: (p, c) => writes.push([p, c]),
    });
    expect(r.ok).toBe(true);
    expect(writes).toEqual([['index.html', INDEX_HTML]]);
  });

  test('onFileWrite 없으면 정상 동작 (하위 호환)', async () => {
    mockFetch
      .mockResolvedValueOnce(geminiOk([fc('create_file', { path: 'index.html', content: INDEX_HTML })]))
      .mockResolvedValueOnce(geminiOk([{ text: 'done' }]));
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'make app');
    expect(r.ok).toBe(true);
    expect(r.files['index.html']).toBe(INDEX_HTML);
  });
});
