/**
 * 오케스트레이터 + 라우터 테스트
 * @jest-environment node
 *
 * src/services/router.ts, src/services/orchestrator.ts를 esbuild로 번들한 뒤 테스트.
 * src/modules/ai/routes.ts의 callSingleAssistant 입력 검증도 함께 테스트.
 */
const { execSync } = require('child_process');
const path = require('path');

const ORCH_BUNDLE = path.join(__dirname, 'orch-bundle.cjs');
const ROUTES_BUNDLE = path.join(__dirname, 'ai-routes-bundle.cjs');

execSync(
  `npx esbuild src/services/orchestrator.ts --bundle --format=cjs --platform=node --outfile=${ORCH_BUNDLE}`,
  { cwd: __dirname, stdio: 'pipe' }
);
execSync(
  `npx esbuild src/services/router.ts --bundle --format=cjs --platform=node --outfile=${path.join(__dirname, 'router-bundle.cjs')}`,
  { cwd: __dirname, stdio: 'pipe' }
);
execSync(
  `npx esbuild src/modules/ai/routes.ts --bundle --format=cjs --platform=node --external:hono --outfile=${ROUTES_BUNDLE}`,
  { cwd: __dirname, stdio: 'pipe' }
);

const { KeywordRouter, isValidPersonaId } = require('./router-bundle.cjs');
const { orchestrate, setRouter, getRouter } = require('./orch-bundle.cjs');
const routes = require('./ai-routes-bundle.cjs');

// ---- isValidPersonaId ----
describe('isValidPersonaId', () => {
  test('유효한 4개 ID', () => {
    for (const id of ['concierge', 'keeper', 'builder', 'scheduler']) {
      expect(isValidPersonaId(id)).toBe(true);
    }
  });
  test('무효한 ID 거부', () => {
    for (const id of ['', 'admin', 'laya', 'CONCIERGE', 'concierge ', 'null', undefined, null, 123]) {
      expect(isValidPersonaId(id)).toBe(false);
    }
  });
});

// ---- KeywordRouter.route ----
describe('KeywordRouter.route', () => {
  const router = new KeywordRouter();

  test('@멘션 우선 (이름)', async () => {
    const d = await router.route('@캘리 내일 일정 알려줘');
    expect(d.primary).toBe('scheduler');
    expect(d.confidence).toBe(1.0);
  });

  test('@멘션 우선 (영문 ID)', async () => {
    const d = await router.route('@builder 버그 고쳐줘');
    expect(d.primary).toBe('builder');
  });

  test('키워드: 일정 → scheduler', async () => {
    const d = await router.route('내일 오후 3시 치과 예약해줘');
    expect(d.primary).toBe('scheduler');
    expect(d.reason).toMatch(/^keyword:/);
  });

  test('키워드: 메모 → keeper', async () => {
    const d = await router.route('이 내용 메모에 정리해줘');
    expect(d.primary).toBe('keeper');
  });

  test('키워드: 코드 → builder', async () => {
    const d = await router.route('이 함수 버그 찾아줘');
    expect(d.primary).toBe('builder');
  });

  test('기본값: 루미', async () => {
    const d = await router.route('안녕, 오늘 날씨 어때?');
    expect(d.primary).toBe('concierge');
    expect(d.reason).toBe('default');
  });

  test('복합 업무: 2개 분야 → 협업자 지정', async () => {
    const d = await router.route('내일 회의 일정 잡고 회의 안건 코드로 정리해줘');
    expect(d.collaborator).toBeDefined();
    expect(d.primary).not.toBe(d.collaborator);
    expect(['builder', 'keeper', 'scheduler']).toContain(d.primary);
    expect(['builder', 'keeper', 'scheduler']).toContain(d.collaborator);
  });

  test('클라이언트 힌트 사용', async () => {
    const d = await router.route('뭐해?', { suggestedPersonaId: 'keeper' });
    expect(d.primary).toBe('keeper');
    expect(d.reason).toBe('client-hint');
  });

  test('무효한 힌트는 무시하고 기본값', async () => {
    const d = await router.route('뭐해?', { suggestedPersonaId: 'hacker' });
    expect(d.primary).toBe('concierge');
  });

  test('needsCollaboration: 사후 협업 없음', async () => {
    const r = await router.needsCollaboration('질문', '답변', 'concierge');
    expect(r.needed).toBe(false);
  });
});

// ---- orchestrate ----
describe('orchestrate', () => {
  // 각 테스트마다 라우터 리셋
  beforeEach(() => setRouter(new KeywordRouter()));
  afterEach(() => setRouter(new KeywordRouter()));

  const msgs = [{ role: 'user', content: '안녕' }];

  test('단일 비서: 1명 참여, 텍스트 반환', async () => {
    const calls = [];
    const result = await orchestrate(
      {
        callAssistant: async (pid, m) => {
          calls.push(pid);
          return { text: `${pid} 응답` };
        },
      },
      '안녕, 오늘 날씨 어때?',
      msgs,
      1
    );
    expect(result.primaryId).toBe('concierge');
    expect(result.participants).toEqual(['concierge']);
    expect(result.text).toBe('concierge 응답');
    expect(calls).toEqual(['concierge']);
    expect(result.responses).toHaveLength(1);
  });

  test('복합 업무: 협업자 추가 호출 (최대 1명)', async () => {
    const calls = [];
    const result = await orchestrate(
      {
        callAssistant: async (pid, m) => {
          calls.push({ pid, msgCount: m.length });
          return { text: `${pid} 응답` };
        },
      },
      '내일 회의 일정 잡고 안건 코드로 정리해줘',
      msgs,
      1
    );
    expect(result.participants).toHaveLength(2);
    expect(calls).toHaveLength(2);
    // 협업자에게는 주 담당 답변이 컨텍스트로 전달됨 (메시지 1개 추가)
    expect(calls[1].msgCount).toBe(msgs.length + 1);
    // 답변 종합: 두 응답이 모두 포함
    expect(result.text).toContain('응답');
  });

  test('협업자 실패 → 주 담당 답변만 사용', async () => {
    let callCount = 0;
    const result = await orchestrate(
      {
        callAssistant: async (pid) => {
          callCount++;
          if (callCount > 1) throw new Error('collab down'); // 두 번째(협업자) 호출만 실패
          return { text: '주 담당 응답' };
        },
      },
      '내일 회의 일정 잡고 안건 코드로 정리해줘',
      msgs,
      1
    );
    // 라우팅은 복합으로 잡히지만 협업 실패 시 조용히 폴백
    expect(callCount).toBe(2); // 시도 자체는 함
    expect(result.participants).toHaveLength(1);
    expect(result.text).toBe('주 담당 응답');
  });

  test('라우터 실패 → 기본값 폴백', async () => {
    setRouter({
      route: async () => { throw new Error('router exploded'); },
      needsCollaboration: async () => ({ needed: false, reason: 'x' }),
    });
    const result = await orchestrate(
      { callAssistant: async (pid) => ({ text: `${pid} ok` }) },
      '무슨 말인지 모르겠는 입력',
      msgs,
      1,
      'keeper' // 힌트가 있으면 힌트로 폴백
    );
    expect(result.primaryId).toBe('keeper');
    expect(result.decision.reason).toBe('router-fallback');
  });

  test('라우터 실패 + 힌트 없음 → concierge', async () => {
    setRouter({
      route: async () => { throw new Error('router exploded'); },
      needsCollaboration: async () => ({ needed: false, reason: 'x' }),
    });
    const result = await orchestrate(
      { callAssistant: async (pid) => ({ text: 'ok' }) },
      'hello',
      msgs,
      1
    );
    expect(result.primaryId).toBe('concierge');
  });

  test('무효한 primary ID → 폴백', async () => {
    setRouter({
      route: async () => ({ primary: 'hacker', reason: 'evil', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: 'x' }),
    });
    const result = await orchestrate(
      { callAssistant: async (pid) => ({ text: 'ok' }) },
      'hello',
      msgs,
      1
    );
    expect(result.primaryId).toBe('concierge');
  });

  test('무효한 collaborator ID → 제거하고 단독 진행', async () => {
    setRouter({
      route: async () => ({ primary: 'concierge', collaborator: 'hacker', reason: 'evil', confidence: 1 }),
      needsCollaboration: async () => ({ needed: false, reason: 'x' }),
    });
    const calls = [];
    const result = await orchestrate(
      {
        callAssistant: async (pid) => {
          calls.push(pid);
          return { text: 'ok' };
        },
      },
      'hello',
      msgs,
      1
    );
    expect(calls).toEqual(['concierge']);
    expect(result.participants).toEqual(['concierge']);
  });

  test('주 담당 호출 실패 → 에러 전파 (502 처리용)', async () => {
    await expect(
      orchestrate(
        {
          callAssistant: async () => { throw new Error('AI down'); },
        },
        '안녕',
        msgs,
        1
      )
    ).rejects.toThrow('AI down');
  });

  test('log 콜백 호출됨', async () => {
    const logs = [];
    await orchestrate(
      {
        callAssistant: async (pid) => ({ text: 'ok' }),
        log: async (entry) => { logs.push(entry); },
      },
      '안녕',
      msgs,
      42
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].conversationId).toBe(42);
    expect(logs[0].success).toBe(true);
    expect(logs[0].participants).toEqual(['concierge']);
  });
});

// ---- callSingleAssistant 입력 검증 (routes.ts) ----
describe('callSingleAssistant 입력 검증', () => {
  const fakeEnv = { DB: { prepare: () => { throw new Error('no db'); } } };

  test('unknown persona → AssistantInputError(unknown_persona)', async () => {
    await expect(routes.callSingleAssistant(fakeEnv, 'hacker', [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ name: 'AssistantInputError', code: 'unknown_persona' });
  });

  test('빈 메시지 → AssistantInputError(empty)', async () => {
    await expect(routes.callSingleAssistant(fakeEnv, 'concierge', []))
      .rejects.toMatchObject({ code: 'empty' });
    await expect(routes.callSingleAssistant(fakeEnv, 'concierge', [{ role: 'user', content: '   ' }]))
      .rejects.toMatchObject({ code: 'empty' });
  });

  test('8000자 초과 → AssistantInputError(too_long)', async () => {
    const long = 'a'.repeat(8001);
    await expect(routes.callSingleAssistant(fakeEnv, 'concierge', [{ role: 'user', content: long }]))
      .rejects.toMatchObject({ code: 'too_long' });
  });
});
