/// <reference types="jest" />
/**
 * src/modules/artifact/generate-html.ts 100% 커버리지 테스트
 * - D1, fetch, setTimeout, console을 모킹하여 실제 코드를 실행
 * - src/services/ai는 MODELS 레지스트리만 필요하므로 모듈 mock (Workers 타입 의존성 회피)
 *
 * 커버리지: statements 100%, functions 100%, lines 100%, branches 98.94%.
 * 미커버 단일 브랜치(304행 `String(rawContent || '')`의 `|| ''`)는 도달 불가 코드임:
 * 301행 `choice?.message?.content || choice?.text || ''`의 마지막 `|| ''` 때문에
 * 304행에 도달하는 non-string rawContent는 항상 truthy이며(gemini 경로는 join으로 항상 string),
 * 따라서 `|| ''`의 우측 분기는 실행될 수 없음. 소스 수정 없이는 커버 불가.
 */
import { generateArtifactHtml } from '../../src/modules/artifact/generate-html';

jest.mock('../../src/services/ai', () => ({
  MODELS: [
    { id: 'gemini-3.5-flash-lite', provider: 'gemini', quality: 'fast', status: 'active' },
    { id: 'gemini-3.8-flash', provider: 'gemini', quality: 'high', status: 'deprecated' },
    { id: 'openai/gpt-oss-20b', provider: 'groq', quality: 'fast', status: 'active' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia', quality: 'high', status: 'active' },
    { id: '@cf/meta/llama-3.2-1b-instruct', provider: 'workers-ai', quality: 'fast', status: 'active' },
  ],
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------
interface DbOpts {
  settingValue?: string | null; // undefined → 'gemini-3.5-flash-lite', null → 행 없음
  reserve?: { provider_attempt_id: string } | null; // undefined → 성공
  dispatchChanges?: number; // undefined → 1
  dispatchMetaUndefined?: boolean;
  updateRejects?: boolean; // outer catch의 failed UPDATE를 reject 시킴
}

function makeDb(opts: DbOpts = {}) {
  const updateCalls: string[] = [];
  const firstFor = async (sql: string): Promise<any> => {
    if (/FROM ai_settings/.test(sql)) {
      const v =
        opts.settingValue === undefined ? 'gemini-3.5-flash-lite' : opts.settingValue;
      return v === null ? null : { value: v };
    }
    if (/INSERT OR IGNORE INTO job_provider_attempts/.test(sql)) {
      return opts.reserve === undefined
        ? { provider_attempt_id: 'attempt-1' }
        : opts.reserve;
    }
    return null;
  };
  const runFor = async (sql: string): Promise<any> => {
    if (/SET state='dispatching'/.test(sql)) {
      const meta = opts.dispatchMetaUndefined
        ? undefined
        : { changes: opts.dispatchChanges ?? 1 };
      return { meta };
    }
    if (/SET state='completed'/.test(sql)) {
      updateCalls.push('completed');
      return {};
    }
    if (/SET state='failed'/.test(sql)) {
      const isHttpStatus = /http_status=\?/.test(sql);
      updateCalls.push(isHttpStatus ? 'failed-http' : 'failed-catch');
      if (opts.updateRejects && !isHttpStatus) throw new Error('db down');
      return {};
    }
    return {};
  };
  // ai_settings 조회는 .bind() 없이 prepare().first() 직접 호출에 유의
  const db = {
    prepare: jest.fn((sql: string) => {
      const stmt: any = {
        bind: jest.fn((..._args: any[]) => stmt),
        first: () => firstFor(sql),
        run: () => runFor(sql),
      };
      return stmt;
    }),
  };
  return { db, updateCalls };
}

const baseArgs = (signal?: AbortSignal) =>
  [1, 'lease-1', 'wf-1', 'system prompt', 'user prompt', signal] as const;

function geminiEnv(db: any, extra: Record<string, any> = {}) {
  return { DB: db, GEMINI_API_KEY_1: 'gkey1', ...extra } as any;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
const geminiOk = (text: string, finishReason = 'STOP') =>
  new Response(
    JSON.stringify({
      candidates: [{ finishReason, content: { parts: [{ text }] } }],
      usageMetadata: {},
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

const groqOk = (content: any, finish_reason = 'stop') =>
  new Response(
    JSON.stringify({ choices: [{ finish_reason, message: { content } }], usage: {} }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

const nvidiaOk = (content: any, finish_reason = 'stop') =>
  new Response(
    JSON.stringify({ choices: [{ finish_reason, message: { content } }], usage: {} }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

// ---------------------------------------------------------------------------
// Global mocks
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  // 재시도 대기(5s)를 즉시 처리
  jest
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((cb: (...a: any[]) => void) => {
      cb();
      return 0 as any;
    }) as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function mockFetch(impl: (url: string, init?: any) => any) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(impl as any);
}

// ---------------------------------------------------------------------------
// 1. 컨텍스트 검증
// ---------------------------------------------------------------------------
describe('컨텍스트 검증', () => {
  test.each([[0], [-5], [1.5], [NaN]])('INVALID_JOB_CONTEXT (jobId=%s)', async (jobId) => {
    const { db } = makeDb();
    await expect(
      generateArtifactHtml(geminiEnv(db), jobId as number, 'lease', 'wf', 's', 'u')
    ).rejects.toThrow('INVALID_JOB_CONTEXT');
  });

  test('MISSING_EXECUTION_CONTEXT: leaseToken 없음', async () => {
    const { db } = makeDb();
    await expect(
      generateArtifactHtml(geminiEnv(db), 1, '', 'wf', 's', 'u')
    ).rejects.toThrow('MISSING_EXECUTION_CONTEXT');
  });

  test('MISSING_EXECUTION_CONTEXT: workflowInstanceId 없음', async () => {
    const { db } = makeDb();
    await expect(
      generateArtifactHtml(geminiEnv(db), 1, 'lease', '', 's', 'u')
    ).rejects.toThrow('MISSING_EXECUTION_CONTEXT');
  });

  test('이미 abort된 signal이면 즉시 실패', async () => {
    const { db } = makeDb();
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs(AbortSignal.abort()))
    ).rejects.toThrow();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('abort되지 않은 signal이면 정상 진행', async () => {
    const { db, updateCalls } = makeDb();
    const fetchMock = mockFetch(async () => geminiOk('<html>ok</html>'));
    const r = await generateArtifactHtml(
      geminiEnv(db),
      ...baseArgs(new AbortController().signal)
    );
    expect(r.html).toBe('<html>ok</html>');
    expect(updateCalls).toContain('completed');
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. 모델 결정 / 정책 검증
// ---------------------------------------------------------------------------
describe('모델 정책 검증', () => {
  test('설정 없으면 gemini-3.5-flash-lite 기본값', async () => {
    const { db } = makeDb({ settingValue: null });
    mockFetch(async () => geminiOk('<html>1</html>'));
    const r = await generateArtifactHtml(geminiEnv(db), ...baseArgs());
    expect(r.model).toBe('gemini-3.5-flash-lite');
  });

  test('MODEL_NOT_REGISTERED', async () => {
    const { db } = makeDb({ settingValue: 'no-such-model' });
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('MODEL_NOT_REGISTERED: no-such-model');
  });

  test('MODEL_NOT_ACTIVE (deprecated)', async () => {
    const { db } = makeDb({ settingValue: 'gemini-3.8-flash' });
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('MODEL_NOT_ACTIVE: gemini-3.8-flash');
  });

  test('MODEL_PROVIDER_MISMATCH (workers-ai)', async () => {
    const { db } = makeDb({ settingValue: '@cf/meta/llama-3.2-1b-instruct' });
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow(/MODEL_PROVIDER_MISMATCH/);
  });
});

// ---------------------------------------------------------------------------
// 3. 예약 / dispatch
// ---------------------------------------------------------------------------
describe('D1 원자적 예약', () => {
  test('PROVIDER_ATTEMPT_ALREADY_RESERVED', async () => {
    const { db } = makeDb({ reserve: null });
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('PROVIDER_ATTEMPT_ALREADY_RESERVED');
  });

  test('PROVIDER_DISPATCH_NOT_ALLOWED (changes=0)', async () => {
    const { db } = makeDb({ dispatchChanges: 0 });
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('PROVIDER_DISPATCH_NOT_ALLOWED');
  });

  test('PROVIDER_DISPATCH_NOT_ALLOWED (meta undefined → ?? 0)', async () => {
    const { db } = makeDb({ dispatchMetaUndefined: true });
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('PROVIDER_DISPATCH_NOT_ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// 4. API 키 로드
// ---------------------------------------------------------------------------
describe('API 키', () => {
  test('NO_GEMINI_KEYS', async () => {
    const { db } = makeDb();
    await expect(
      generateArtifactHtml({ DB: db } as any, ...baseArgs())
    ).rejects.toThrow('NO_GEMINI_KEYS');
  });

  test('NO_GROQ_KEYS', async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    await expect(
      generateArtifactHtml({ DB: db } as any, ...baseArgs())
    ).rejects.toThrow('NO_GROQ_KEYS');
  });

  test('nvidia 모델 → MODEL_PROVIDER_MISMATCH (2026-10-30: 허용 provider에서 제외)', async () => {
    // 이 파일의 mock 레지스트리는 nvidia를 active로 두므로, status 검사가
    // 아니라 provider 허용 목록이 거부하는지를 검증한다 (운영 레지스트리에서는
    // 비활성이라 MODEL_NOT_ACTIVE가 먼저 걸리는 이중 차단).
    const { db } = makeDb({ settingValue: 'nvidia/nemotron-3-ultra-550b-a55b' });
    const fetchMock = mockFetch(async () => { throw new Error('fetch must not be called'); });
    await expect(
      generateArtifactHtml({ DB: db, NVIDIA_API_KEY_1: 'n1' } as any, ...baseArgs())
    ).rejects.toThrow('MODEL_PROVIDER_MISMATCH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('키 1~4번 중 있는 것만 수집 (빈 슬롯 건너뜀)', async () => {
    const { db } = makeDb();
    // _2번만 비어 있음
    const env = geminiEnv(db, { GEMINI_API_KEY_2: undefined, GEMINI_API_KEY_3: 'gkey3' });
    mockFetch(async () => geminiOk('<html>k</html>'));
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>k</html>');
  });
});

// ---------------------------------------------------------------------------
// 5. 프로바이더별 성공
// ---------------------------------------------------------------------------
describe('프로바이더별 성공', () => {
  test('gemini 성공: 올바른 URL/바디', async () => {
    const { db, updateCalls } = makeDb();
    const fetchMock = mockFetch(async (url: string, init: any) => {
      expect(url).toContain('generativelanguage.googleapis.com');
      expect(url).toContain('gemini-3.5-flash-lite');
      const body = JSON.parse(init.body);
      expect(body.system_instruction.parts[0].text).toBe('system prompt');
      expect(body.contents[0].parts[0].text).toBe('user prompt');
      return geminiOk('<html>gemini</html>');
    });
    const r = await generateArtifactHtml(geminiEnv(db), ...baseArgs());
    expect(r).toEqual({ html: '<html>gemini</html>', model: 'gemini-3.5-flash-lite', keySlot: 0 });
    expect(updateCalls).toContain('completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('groq 성공: Bearer 헤더 + chat completions', async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    const env = { DB: db, GROQ_API_KEY_1: 'q1' } as any;
    const fetchMock = mockFetch(async (url: string, init: any) => {
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(init.headers['Authorization']).toBe('Bearer q1');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('openai/gpt-oss-20b');
      expect(body.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
      return groqOk('<html>groq</html>');
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r).toEqual({ html: '<html>groq</html>', model: 'openai/gpt-oss-20b', keySlot: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('nvidia로는 절대 호출되지 않는다 (2026-10-30: 직접 fetch 경로 차단)', async () => {
    const { db } = makeDb({ settingValue: 'nvidia/nemotron-3-ultra-550b-a55b' });
    const env = { DB: db, NVIDIA_API_KEY_1: 'n1' } as any;
    const fetchMock = mockFetch(async () => nvidiaOk('<html>nvidia</html>'));
    await expect(generateArtifactHtml(env, ...baseArgs())).rejects.toThrow('MODEL_PROVIDER_MISMATCH');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. 400/403 영구 실패 + 키 로테이션
// ---------------------------------------------------------------------------
describe('영구 실패와 키 로테이션', () => {
  test('gemini 400 → 다음 키로 성공 (keySlot=1)', async () => {
    const { db } = makeDb();
    const env = geminiEnv(db, { GEMINI_API_KEY_2: 'gkey2' });
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return calls === 1
        ? new Response('{"error":"bad"}', { status: 400 })
        : geminiOk('<html>k2</html>');
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.keySlot).toBe(1);
    expect(r.html).toBe('<html>k2</html>');
    expect(calls).toBe(2);
  });

  test('영구 실패 키는 건너뜀 (while 루프)', async () => {
    const { db } = makeDb();
    // 키 3개: 1번 400(영구실패), 2/3번 503, 4번째 시도에서 1번 건너뛰고 2번으로 성공
    const env = geminiEnv(db, { GEMINI_API_KEY_2: 'g2', GEMINI_API_KEY_3: 'g3' });
    let n = 0;
    mockFetch(async (_url: string, init: any) => {
      n++;
      if (n === 1) return new Response('bad', { status: 400 });
      if (n === 2 || n === 3) return new Response('busy', { status: 503 });
      return geminiOk('<html>ok3</html>');
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>ok3</html>');
    // attempt=3 → keySlot=3%3=0(영구실패) → while로 건너뛰고 keySlot=1 → 성공
    expect(r.keySlot).toBe(1);
    expect(n).toBe(4);
  });

  test('모든 키 영구 실패 → 처음부터 재시도 (skipCount >= keys.length)', async () => {
    const { db } = makeDb();
    const env = geminiEnv(db, { GEMINI_API_KEY_2: 'g2' });
    let n = 0;
    mockFetch(async () => {
      n++;
      // 처음 2번은 400, 그 다음부터 성공
      return n <= 2 ? new Response('bad', { status: 400 }) : geminiOk('<html>retry</html>');
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>retry</html>');
    expect(n).toBe(3);
  });

  test('gemini 403 → 릴레이 없이 영구 실패 처리', async () => {
    const { db, updateCalls } = makeDb();
    const env = geminiEnv(db, { GEMINI_RELAY_URL: 'https://relay/x', GEMINI_RELAY_SECRET: 's' });
    const fetchMock = mockFetch(async () => new Response('forbidden', { status: 403 }));
    await expect(generateArtifactHtml(env, ...baseArgs())).rejects.toThrow(
      'gemini fetch failed after retries'
    );
    // 릴레이 URL로는 호출되지 않음
    expect(fetchMock.mock.calls.every(([u]: any[]) => !String(u).includes('relay'))).toBe(true);
    expect(updateCalls).not.toContain('completed');
  });

  test('groq 400 → 릴레이 없이 영구 실패', async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    const env = { DB: db, GROQ_API_KEY_1: 'q1' } as any;
    let n = 0;
    mockFetch(async () => {
      n++;
      return n === 1 ? new Response('bad', { status: 400 }) : groqOk('<html>q</html>');
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>q</html>');
  });
});

// ---------------------------------------------------------------------------
// 7. Gemini 릴레이
// ---------------------------------------------------------------------------
describe('Gemini 지역 제한 릴레이', () => {
  const locationBody = JSON.stringify({
    error: { message: 'User location is not supported for the API use' },
  });
  const relayEnv = (db: any) =>
    geminiEnv(db, { GEMINI_RELAY_URL: 'https://relay.example/r', GEMINI_RELAY_SECRET: 'rs' });

  test('릴레이 성공 (body가 문자열)', async () => {
    const { db, updateCalls } = makeDb();
    const env = relayEnv(db);
    mockFetch(async (url: string, init: any) => {
      if (String(url).includes('relay.example')) {
        expect(init.headers['X-Relay-Key']).toBe('rs');
        return new Response(
          JSON.stringify({ ok: true, body: JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<html>relay</html>' }] } }] }) }),
          { status: 200 }
        );
      }
      return new Response(locationBody, { status: 400 });
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>relay</html>');
    expect(updateCalls).toContain('completed');
  });

  test('릴레이 성공 (body가 객체)', async () => {
    const { db } = makeDb();
    const env = relayEnv(db);
    mockFetch(async (url: string) => {
      if (String(url).includes('relay.example')) {
        return new Response(
          JSON.stringify({ ok: true, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<html>robj</html>' }] } }] } }),
          { status: 200 }
        );
      }
      return new Response(locationBody, { status: 400 });
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>robj</html>');
  });

  test('릴레이 ok=false → 영구 실패로 계속', async () => {
    const { db } = makeDb();
    const env = relayEnv(db);
    let n = 0;
    mockFetch(async (url: string) => {
      if (String(url).includes('relay.example')) {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
      n++;
      return n === 1 ? new Response(locationBody, { status: 400 }) : geminiOk('<html>after</html>');
    });
    // 키가 1개뿐이라 영구실패 후 재시도 → 두 번째 호출 성공
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>after</html>');
  });

  test('릴레이 fetch 예외 → 영구 실패로 계속', async () => {
    const { db } = makeDb();
    const env = relayEnv(db);
    let n = 0;
    mockFetch(async (url: string) => {
      if (String(url).includes('relay.example')) throw new Error('relay down');
      n++;
      return n === 1 ? new Response(locationBody, { status: 400 }) : geminiOk('<html>r2</html>');
    });
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>r2</html>');
  });

  test('릴레이 환경변수 없음 → 릴레이 시도 안 함', async () => {
    const { db } = makeDb();
    const fetchMock = mockFetch(async () => new Response(locationBody, { status: 400 }));
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('gemini fetch failed after retries');
    expect(fetchMock).toHaveBeenCalledTimes(13); // 0..12
  });

  test('400 응답의 text()가 reject → 빈 문자열로 처리', async () => {
    const { db } = makeDb();
    const badRes = { status: 400, text: async () => { throw new Error('x'); } };
    let n = 0;
    mockFetch(async () => {
      n++;
      return (n === 1 ? badRes : geminiOk('<html>t</html>')) as any;
    });
    const r = await generateArtifactHtml(geminiEnv(db), ...baseArgs());
    expect(r.html).toBe('<html>t</html>');
  });

  test('gemini 400 (지역 제한 아님) → 릴레이 없이 영구 실패', async () => {
    const { db } = makeDb();
    const env = relayEnv(db);
    const fetchMock = mockFetch(async (url: string) => {
      // 릴레이로 가지 않아야 함
      return new Response('{"error":{"message":"invalid key"}}', { status: 400 });
    });
    await expect(generateArtifactHtml(env, ...baseArgs())).rejects.toThrow(
      'gemini fetch failed after retries'
    );
    expect(fetchMock.mock.calls.every(([u]: any[]) => !String(u).includes('relay.example'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. 429 / 5xx / 재시도 소진
// ---------------------------------------------------------------------------
describe('재시도', () => {
  test('429 → 다음 시도로 성공', async () => {
    const { db } = makeDb();
    let n = 0;
    mockFetch(async () => {
      n++;
      return n === 1 ? new Response('rl', { status: 429 }) : geminiOk('<html>rl2</html>');
    });
    const r = await generateArtifactHtml(geminiEnv(db), ...baseArgs());
    expect(r.html).toBe('<html>rl2</html>');
    expect(n).toBe(2);
  });

  test('503 연속 → 3회 후 일시적 실패 표시, 13회 후 소진', async () => {
    const { db } = makeDb();
    const fetchMock = mockFetch(async () => new Response('overloaded', { status: 503 }));
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('gemini fetch failed after retries');
    expect(fetchMock).toHaveBeenCalledTimes(13); // attempt 0..12
  });

  test('fetch 자체가 throw → 루프 밖이므로 failed 기록 없이 즉시 throw', async () => {
    const { db, updateCalls } = makeDb();
    mockFetch(async () => {
      throw new Error('network down');
    });
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('network down');
    // inner catch에서 바로 rethrow → outer catch(실패 기록)를 거치지 않음
    expect(updateCalls).toEqual([]);
  });

  test('outer catch의 failed UPDATE가 reject → .catch(()=>{}) 로 무시', async () => {
    // outer catch에 도달하는 경로(EMPTY_RESPONSE) + UPDATE 실패
    const { db, updateCalls } = makeDb({ updateRejects: true });
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('EMPTY_RESPONSE');
    // push는 run() reject 전에 기록됨 → .catch(()=>{})가 호출되어 무시됨
    expect(updateCalls).toEqual(['failed-catch']);
  });
});

// ---------------------------------------------------------------------------
// 9. 응답 본문 검증
// ---------------------------------------------------------------------------
describe('응답 본문 검증', () => {
  test('200이지만 resourceexhausted 본문 → failed 기록 후 throw', async () => {
    const { db, updateCalls } = makeDb();
    mockFetch(async () => new Response('{"error":"RESOURCEEXHAUSTED quota exceeded"}', { status: 200 }));
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow(/gemini 200/);
    expect(updateCalls).toContain('failed-http');
    expect(updateCalls).not.toContain('completed');
  });

  test('200 + worker local total request limit 본문 → failed', async () => {
    const { db, updateCalls } = makeDb();
    mockFetch(
      async () => new Response('{"error": "worker local total request limit hit"}', { status: 200 })
    );
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow(/gemini 200/);
    expect(updateCalls).toContain('failed-http');
  });

  test('!res.ok (302) → failed 기록 후 throw', async () => {
    const { db, updateCalls } = makeDb();
    mockFetch(async () => new Response('', { status: 302 }));
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('gemini 302: ');
    expect(updateCalls).toContain('failed-http');
  });

  test('200 + invalid JSON → gemini invalid JSON response', async () => {
    const { db, updateCalls } = makeDb();
    mockFetch(async () => new Response('not-json{{{', { status: 200 }));
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('gemini invalid JSON response');
    expect(updateCalls).toContain('failed-catch');
  });

  test('res.text()가 reject → 빈 본문으로 처리', async () => {
    const { db } = makeDb();
    const badRes = { status: 200, ok: true, text: async () => { throw new Error('x'); } };
    mockFetch(async () => badRes as any);
    // 빈 본문 → JSON 파싱 실패
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('gemini invalid JSON response');
  });
});

// ---------------------------------------------------------------------------
// 10. 콘텐츠 파싱
// ---------------------------------------------------------------------------
describe('콘텐츠 파싱', () => {
  test('gemini: candidates 없음 → EMPTY_RESPONSE', async () => {
    const { db } = makeDb();
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow(/EMPTY_RESPONSE: model=gemini-3.5-flash-lite, provider=gemini/);
  });

  test('gemini: parts 없음 → EMPTY_RESPONSE', async () => {
    const { db } = makeDb();
    mockFetch(
      async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP' }] }), { status: 200 })
    );
    await expect(
      generateArtifactHtml(geminiEnv(db), ...baseArgs())
    ).rejects.toThrow('EMPTY_RESPONSE');
  });

  test('groq: choices 없음 → EMPTY_RESPONSE', async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    const env = { DB: db, GROQ_API_KEY_1: 'q1' } as any;
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(generateArtifactHtml(env, ...baseArgs())).rejects.toThrow(
      /EMPTY_RESPONSE: model=openai\/gpt-oss-20b, provider=groq/
    );
  });

  test('groq: choice.text 폴백 (message.content 없음)', async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    const env = { DB: db, GROQ_API_KEY_1: 'q1' } as any;
    mockFetch(
      async () => new Response(JSON.stringify({ choices: [{ text: '<html>txt</html>' }] }), { status: 200 })
    );
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>txt</html>');
  });

  test('groq: content가 문자열이 아니면 String() 변환', async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    const env = { DB: db, GROQ_API_KEY_1: 'q1' } as any;
    mockFetch(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 12345 } }] }), { status: 200 })
    );
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('12345');
  });

  test('groq: choice에 message/text 모두 없음 → 빈 문자열 → EMPTY_RESPONSE', async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    const env = { DB: db, GROQ_API_KEY_1: 'q1' } as any;
    mockFetch(
      async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 })
    );
    await expect(generateArtifactHtml(env, ...baseArgs())).rejects.toThrow('EMPTY_RESPONSE');
  });

  test('gemini MAX_TOKENS → 경고 후 성공', async () => {
    const { db } = makeDb();
    const logSpy = console.log as jest.Mock;
    mockFetch(async () => geminiOk('<html>cut</html>', 'MAX_TOKENS'));
    const r = await generateArtifactHtml(geminiEnv(db), ...baseArgs());
    expect(r.html).toBe('<html>cut</html>');
    expect(logSpy.mock.calls.some(([m]: any[]) => String(m).includes('WARNING: output truncated'))).toBe(true);
  });

  test("groq finish_reason 'length' → 경고 후 성공", async () => {
    const { db } = makeDb({ settingValue: 'openai/gpt-oss-20b' });
    const env = { DB: db, GROQ_API_KEY_1: 'q1' } as any;
    const logSpy = console.log as jest.Mock;
    mockFetch(async () => groqOk('<html>len</html>', 'length'));
    const r = await generateArtifactHtml(env, ...baseArgs());
    expect(r.html).toBe('<html>len</html>');
    expect(logSpy.mock.calls.some(([m]: any[]) => String(m).includes('WARNING: output truncated'))).toBe(true);
  });

  test('gemini 여러 parts 연결', async () => {
    const { db } = makeDb();
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<html>' }, { text: '</html>' }, {}] } }],
          }),
          { status: 200 }
        )
    );
    const r = await generateArtifactHtml(geminiEnv(db), ...baseArgs());
    expect(r.html).toBe('<html></html>');
  });
});
