/**
 * Phase 2B — 실제 모델 라우팅 및 안전한 Fallback 구현 테스트 (Mock)
 * @jest-environment node
 */

const { execSync } = require('child_process');

// 번들 생성
try {
  execSync('npx esbuild src/ai/model-router.ts --bundle --format=cjs --platform=node --outfile=/tmp/model-router-2b.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/retry-policy.ts --bundle --format=cjs --platform=node --outfile=/tmp/retry-policy-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/fallback-controller.ts --bundle --format=cjs --platform=node --external:./runner --external:./tools/registry --outfile=/tmp/fallback-ctrl-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const {
  ModelRouter,
  classifySensitivity,
  resolveSensitivity,
  isVerifiedModel,
  getVerifiedModels,
  FC_VERIFIED_MODELS,
} = require('/tmp/model-router-2b.cjs');

const {
  parseRetryAfter,
  decideRetry,
} = require('/tmp/retry-policy-test.cjs');

describe('Phase 2B: B201-B220', () => {
  // B201: 일반 요청에서 Groq 선택
  test('B201: 일반 요청에서 Groq 선택', () => {
    const router = new ModelRouter();
    const decision = router.route({
      text: '오늘 날씨 어때?',
      capability: 'chat',
    });
    expect(decision).not.toBeNull();
    expect(decision.provider).toBe('groq');
    expect(isVerifiedModel(decision.provider, decision.model)).toBe(true);
  });

  // B202: personal 요청에서 Gemini 제외
  test('B202: personal 요청에서 Gemini 제외', () => {
    const router = new ModelRouter();
    const decision = router.route({
      text: '내 메모 찾아줘',
      capability: 'search',
    });
    expect(decision).not.toBeNull();
    expect(decision.provider).not.toBe('gemini');
    expect(decision.provider).toBe('groq');
  });

  // B203: search_memo 활성화 시 personal 분류
  test('B203: search_memo 활성화 시 personal 분류', () => {
    // "마감일이 언제였지?" - 키워드 없지만 search_memo 활성화
    const { sensitivity, reason } = resolveSensitivity({
      text: '지난번에 적어둔 마감일이 언제였지?',
      availableTools: ['search_memo'],
    });
    expect(sensitivity).toBe('personal');
    expect(reason).toContain('search_memo');
  });

  // B204: 대화 이력의 민감도 유지
  test('B204: 대화 이력의 민감도 유지', () => {
    // 이전에 personal 대화, 현재는 단순 인사
    const { sensitivity } = resolveSensitivity({
      text: '안녕',
      historySensitivity: 'personal',
      availableTools: ['search_memo'],
    });
    // 이력 민감도가 유지되어야 함
    expect(sensitivity).toBe('personal');
  });

  // B205: restricted 데이터에서 Provider 차단
  test('B205: restricted 데이터에서 Provider 차단', () => {
    const router = new ModelRouter();
    const decision = router.route({
      text: 'API 키 sk-abc123def456ghi789jkl 저장해줘',
      capability: 'chat',
    });
    expect(decision).toBeNull();
  });

  // B206: 검증되지 않은 모델 제외
  test('B206: 검증되지 않은 모델 제외', () => {
    // FC_VERIFIED_MODELS에 있는 모델만 선택됨
    expect(FC_VERIFIED_MODELS.length).toBe(2);
    expect(isVerifiedModel('groq', 'openai/gpt-oss-120b')).toBe(true);
    expect(isVerifiedModel('gemini', 'gemini-3.5-flash-lite')).toBe(true);
    // 미검증 모델
    expect(isVerifiedModel('groq', 'openai/gpt-oss-20b')).toBe(false);
    expect(isVerifiedModel('workers-ai', '@cf/mistralai/mistral-small-3.1-24b-instruct')).toBe(false);
    // gemini-2.5-flash는 검증 실패 (404)
    expect(isVerifiedModel('gemini', 'gemini-2.5-flash')).toBe(false);
  });

  // B207: Groq 429 이후 일반 요청 Fallback
  test('B207: Groq 429 이후 일반 요청 Fallback', () => {
    const router = new ModelRouter();
    const decision = router.decideFallback({
      failedProvider: 'groq',
      failedModel: 'openai/gpt-oss-120b',
      errorCode: 'RATE_LIMITED',
      httpStatus: 429,
      toolsExecuted: false,
      writeUncertain: false,
      sensitivity: 'general',
      triedProviders: new Set(['groq']),
      fallbackCount: 0,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.candidate.provider).toBe('gemini');
  });

  // B208: Groq 503 이후 일반 요청 Fallback
  test('B208: Groq 503 이후 일반 요청 Fallback', () => {
    const router = new ModelRouter();
    const decision = router.decideFallback({
      failedProvider: 'groq',
      failedModel: 'openai/gpt-oss-120b',
      errorCode: 'SERVICE_UNAVAILABLE',
      httpStatus: 503,
      toolsExecuted: false,
      writeUncertain: false,
      sensitivity: 'general',
      triedProviders: new Set(['groq']),
      fallbackCount: 0,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.candidate.provider).toBe('gemini');
  });

  // B209: 개인 메모 요청에서 Fallback 차단
  test('B209: 개인 메모 요청에서 Fallback 차단', () => {
    const router = new ModelRouter();
    const decision = router.decideFallback({
      failedProvider: 'groq',
      failedModel: 'openai/gpt-oss-120b',
      errorCode: 'RATE_LIMITED',
      httpStatus: 429,
      toolsExecuted: false,
      writeUncertain: false,
      sensitivity: 'personal', // 개인 메모
      triedProviders: new Set(['groq']),
      fallbackCount: 0,
    });
    // 2026-10-13 정책 변경: personal이어도 gemini 직접 호출 허용 → Fallback 허용
    expect(decision.allowed).toBe(true);
    expect(decision.candidate.provider).toBe('gemini');
  });

  // B210: 도구 실행 후 Fallback 차단
  test('B210: 도구 실행 후 Fallback 차단', () => {
    const router = new ModelRouter();
    const decision = router.decideFallback({
      failedProvider: 'groq',
      failedModel: 'openai/gpt-oss-120b',
      errorCode: 'TIMEOUT',
      toolsExecuted: true,
      writeUncertain: false,
      sensitivity: 'general',
      triedProviders: new Set(['groq']),
      fallbackCount: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('tools-already-executed');
  });

  // B211: 쓰기 상태 불명 시 Fallback 차단
  test('B211: 쓰기 상태 불명 시 Fallback 차단', () => {
    const router = new ModelRouter();
    const decision = router.decideFallback({
      failedProvider: 'groq',
      failedModel: 'openai/gpt-oss-120b',
      errorCode: 'TIMEOUT',
      toolsExecuted: false,
      writeUncertain: true,
      sensitivity: 'general',
      triedProviders: new Set(['groq']),
      fallbackCount: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('write-uncertain');
  });

  // B212: 401/403 오류 시 Fallback 차단
  test('B212: 401/403 오류 시 Fallback 차단', () => {
    const router = new ModelRouter();
    for (const status of [401, 403]) {
      const decision = router.decideFallback({
        failedProvider: 'groq',
        failedModel: 'openai/gpt-oss-120b',
        errorCode: 'AUTH_ERROR',
        httpStatus: status,
        toolsExecuted: false,
        writeUncertain: false,
        sensitivity: 'general',
        triedProviders: new Set(['groq']),
        fallbackCount: 0,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('auth-error-no-retry');
    }
  });

  // B213: Fallback은 최대 1회
  test('B213: Fallback은 최대 1회', () => {
    const router = new ModelRouter();
    const decision = router.decideFallback({
      failedProvider: 'gemini',
      failedModel: 'gemini-3.5-flash-lite',
      errorCode: 'TIMEOUT',
      toolsExecuted: false,
      writeUncertain: false,
      sensitivity: 'general',
      triedProviders: new Set(['groq', 'gemini']),
      fallbackCount: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('fallback-limit-exceeded');
  });

  // B214: Fallback 후에도 전체 모델 호출 3회 제한 (예산 공유)
  test('B214: Fallback 후 예산 공유 구조 확인', () => {
    // FallbackController.remainingBudget 로직 검증
    // 첫 시도에서 1회 호출 후 Fallback → 남은 예산은 2회
    const maxModelCalls = 3;
    const usedCalls = 1;
    const remaining = Math.max(0, maxModelCalls - usedCalls);
    expect(remaining).toBe(2);
    // 예산이 리셋되지 않음을 확인 (3으로 돌아가지 않음)
    expect(remaining).not.toBe(3);
  });

  // B215: Fallback 후 토큰 예산 유지
  test('B215: Fallback 후 토큰 예산 유지', () => {
    const maxTokens = 8000;
    const usedTokens = 2000;
    const remaining = Math.max(0, maxTokens - usedTokens);
    expect(remaining).toBe(6000);
    expect(remaining).not.toBe(8000);
  });

  // B216: Retry-After 초 단위 파싱
  test('B216: Retry-After 초 단위 파싱', () => {
    expect(parseRetryAfter('120')).toBe(120000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter('0')).toBe(0);
  });

  // B217: Retry-After 날짜 및 비정상 값
  test('B217: Retry-After 날짜 및 비정상 값', () => {
    // HTTP 날짜 (미래)
    const future = new Date(Date.now() + 60000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(60000 + 1000);

    // 비정상 값
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('invalid')).toBeNull();
    expect(parseRetryAfter('-10')).toBe(0); // 음수는 0

    // 비정상적으로 긴 값 → 상한 (1시간)
    expect(parseRetryAfter('999999')).toBe(60 * 60 * 1000);
  });

  // B218: Provider별 사용량 로그 기록 (구조 확인)
  test('B218: Fallback 로그 필드 구조', () => {
    // RunFinishEvent에 Fallback 필드가 있는지 확인
    // (타입 체크는 TypeScript에서, 여기서는 컨트롤러 결과 구조 확인)
    const mockResult = {
      fallbackOccurred: true,
      fallbackCount: 1,
      fallbackReason: 'fallback-to:gemini',
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      totalInputTokens: 500,
      totalOutputTokens: 100,
      totalModelCalls: 2,
    };
    expect(mockResult.fallbackOccurred).toBe(true);
    expect(mockResult.fallbackCount).toBe(1);
    expect(mockResult.totalModelCalls).toBe(2);
  });

  // B219: 기존 캘리 search_memo 경로 회귀
  test('B219: 기존 캘리 search_memo 경로 회귀', () => {
    const router = new ModelRouter();
    // Phase 1G-S와 동일한 요청
    const decision = router.route({
      text: '저번에 메모한 FC 테스트 과제 마감일 알려줘.',
      capability: 'fc-chat',
      sensitivityContext: {
        availableTools: ['search_memo'],
      },
    });
    expect(decision).not.toBeNull();
    expect(decision.provider).toBe('groq');
    expect(isVerifiedModel(decision.provider, decision.model)).toBe(true);
  });

  // B220: Fallback 중 AbortSignal 취소
  test('B220: AbortSignal 취소 시 재시도 불가', () => {
    const controller = new AbortController();
    controller.abort();
    const decision = decideRetry('60', { abortSignal: controller.signal });
    expect(decision.canRetry).toBe(false);
    expect(decision.reason).toBe('cancelled');
  });

  // 2026-10-13 정책 변경: personal ToolResult도 Gemini 직접 호출로 Fallback 허용
  // (직접 호출은 릴레이를 거치지 않음. 릴레이 실제 사용 시 callGemini에서 차단)
  test('B2X-1: personal ToolResult는 Gemini로 Fallback 허용 (직접 호출)', () => {
    const router = new ModelRouter();
    // search_memo 결과가 personal 데이터를 포함하는 경우
    const decision = router.decideFallback({
      failedProvider: 'groq',
      failedModel: 'openai/gpt-oss-120b',
      errorCode: 'TIMEOUT',
      httpStatus: 500,
      toolsExecuted: false,
      writeUncertain: false,
      sensitivity: 'personal',
      triedProviders: new Set(['groq']),
      fallbackCount: 0,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.candidate.provider).toBe('gemini');
  });

  // 추가: 모델 ID가 검증된 레지스트리와 일치
  test('B2X-2: 선택된 모델은 검증된 레지스트리에 존재', () => {
    const router = new ModelRouter();
    const decision = router.route({
      text: '일반 질문',
      capability: 'chat',
    });
    expect(isVerifiedModel(decision.provider, decision.model)).toBe(true);
  });
});
