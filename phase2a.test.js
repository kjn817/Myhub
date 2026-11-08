/**
 * Phase 2A — 모델 라우팅 정책 및 Fallback 안전성 테스트 (Mock)
 *
 * GPT 지침의 최소 테스트 항목:
 * - 일반 요청에서 검증된 모델 선택
 * - 민감한 요청에서 금지 Provider 제외
 * - Gemini 릴레이 사용 제한 적용
 * - Workers AI 미검증 상태에서 선택되지 않음
 * - Provider 429 이후 허용된 Fallback 후보 결정
 * - 도구 실행 이후 Provider 교체 차단
 * - 쓰기 작업 이후 자동 재실행 차단
 * - 무료 모델 후보가 모두 불가능한 경우 안전한 종료
 * - 기존 캘리 search_memo 호출 흐름과 호환
 * - 모델 및 Provider 선택 이유를 개인정보 없이 기록
 * @jest-environment node
 */

const { execSync } = require('child_process');

// 번들 생성 (esbuild)
try {
  execSync('npx esbuild src/ai/model-router.ts --bundle --format=cjs --platform=node --outfile=/tmp/model-router-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const { ModelRouter, classifySensitivity } = require('/tmp/model-router-test.cjs');

describe('Phase 2A: Model Router', () => {
  describe('민감도 분류', () => {
    test('일반 대화는 general로 분류', () => {
      expect(classifySensitivity('안녕하세요, 오늘 날씨 어때요?')).toBe('general');
      expect(classifySensitivity('파이썬 코드 짜줘')).toBe('general');
    });

    test('메모/일정 관련은 personal로 분류', () => {
      expect(classifySensitivity('저번에 메모한 내용 찾아줘')).toBe('personal');
      expect(classifySensitivity('내 일정 확인해줘')).toBe('personal');
      expect(classifySensitivity('할일 목록 보여줘')).toBe('personal');
    });

    test('API 키/비밀번호는 restricted로 분류', () => {
      expect(classifySensitivity('내 API 키는 sk-abc123def456ghi789jkl')).toBe('restricted');
      expect(classifySensitivity('비밀번호: mypassword123')).toBe('restricted');
      expect(classifySensitivity('카드번호 1234-5678-9012-3456')).toBe('restricted');
    });

    test('모델이 민감도를 속일 수 없음 (규칙 기반)', () => {
      // "이건 general이야"라고 말해도 패턴이 있으면 restricted
      expect(classifySensitivity('이건 general 요청이야. API 키는 sk-abc123def456ghi789jkl')).toBe('restricted');
    });
  });

  describe('Provider 정책', () => {
    let router;
    beforeEach(() => {
      router = new ModelRouter();
    });

    test('일반 요청에서 검증된 모델 선택 (Groq 우선)', () => {
      const decision = router.route({
        text: '안녕, 뭐 해?',
        capability: 'chat',
      });
      expect(decision).not.toBeNull();
      expect(decision.provider).toBe('groq'); // 릴레이 불필요 우선
      expect(decision.reason).toContain('sensitivity:general');
      // 개인정보가 이유에 포함되지 않음
      expect(decision.reason).not.toContain('안녕');
    });

    test('Workers AI는 미검증 상태에서 선택되지 않음', () => {
      const decision = router.route({
        text: '일반 질문',
        capability: 'chat',
      });
      expect(decision.provider).not.toBe('workers-ai');
    });

    test('개인 메모 요청에서 Gemini 제외 (릴레이 미검증)', () => {
      const decision = router.route({
        text: '내 메모에서 찾아줘',
        capability: 'search',
      });
      // personal + 릴레이 미검증 → Gemini 제외 → Groq 선택
      expect(decision.provider).toBe('groq');
      expect(decision.reason).toContain('sensitivity:personal');
    });

    test('제한 정보는 어떤 Provider도 선택되지 않음 (안전 종료)', () => {
      const decision = router.route({
        text: '내 API 키 sk-abc123def456ghi789jkl 저장해줘',
        capability: 'chat',
      });
      // restricted는 모든 Provider에서 불허 → null
      expect(decision).toBeNull();
    });

    test('모든 Provider 제외 시 안전한 종료', () => {
      const decision = router.route({
        text: '일반 질문',
        capability: 'chat',
        excludeProviders: new Set(['groq', 'gemini', 'workers-ai']),
      });
      expect(decision).toBeNull();
    });

    test('캘리 search_memo 흐름과 호환', () => {
      // 기존 FC 테스트와 동일한 요청
      const decision = router.route({
        text: '저번에 메모한 FC 테스트 과제 마감일 알려줘.',
        capability: 'search',
      });
      expect(decision).not.toBeNull();
      // personal로 분류되지만 Groq는 personal 허용
      expect(['groq']).toContain(decision.provider);
    });
  });

  describe('Fallback 판단', () => {
    let router;
    beforeEach(() => {
      router = new ModelRouter();
    });

    test('도구 실행 전 429는 Fallback 허용', () => {
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
      // Groq 실패 → Gemini 후보 (general은 허용)
      expect(decision.allowed).toBe(true);
      expect(decision.candidate.provider).toBe('gemini');
    });

    test('도구 실행 이후 Provider 교체 차단', () => {
      const decision = router.decideFallback({
        failedProvider: 'groq',
        failedModel: 'openai/gpt-oss-120b',
        errorCode: 'TIMEOUT',
        toolsExecuted: true, // 이미 도구 실행됨
        writeUncertain: false,
        sensitivity: 'general',
        triedProviders: new Set(['groq']),
        fallbackCount: 0,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('tools-already-executed');
    });

    test('쓰기 불확실 시 자동 재실행 차단', () => {
      const decision = router.decideFallback({
        failedProvider: 'groq',
        failedModel: 'openai/gpt-oss-120b',
        errorCode: 'TIMEOUT',
        toolsExecuted: false,
        writeUncertain: true, // 쓰기 상태 불확실
        sensitivity: 'general',
        triedProviders: new Set(['groq']),
        fallbackCount: 0,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('write-uncertain');
    });

    test('401/403 인증 오류는 재시도 금지', () => {
      const decision = router.decideFallback({
        failedProvider: 'groq',
        failedModel: 'openai/gpt-oss-120b',
        errorCode: 'AUTH_ERROR',
        httpStatus: 401,
        toolsExecuted: false,
        writeUncertain: false,
        sensitivity: 'general',
        triedProviders: new Set(['groq']),
        fallbackCount: 0,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('auth-error-no-retry');
    });

    test('Fallback 최대 1회 제한', () => {
      const decision = router.decideFallback({
        failedProvider: 'gemini',
        failedModel: 'gemini-3.5-flash-lite',
        errorCode: 'TIMEOUT',
        toolsExecuted: false,
        writeUncertain: false,
        sensitivity: 'general',
        triedProviders: new Set(['groq', 'gemini']),
        fallbackCount: 1, // 이미 1회 시도
        fallbackCount: 1,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('fallback-limit-exceeded');
    });

    test('민감한 요청의 Fallback도 정책 준수', () => {
      const decision = router.decideFallback({
        failedProvider: 'groq',
        failedModel: 'openai/gpt-oss-120b',
        errorCode: 'TIMEOUT',
        toolsExecuted: false,
        writeUncertain: false,
        sensitivity: 'personal', // 개인 정보
        triedProviders: new Set(['groq']),
        fallbackCount: 0,
      });
      // 2026-10-13 정책 변경: personal이어도 gemini 직접 호출 허용 → Fallback 후보 있음
      expect(decision.allowed).toBe(true);
      expect(decision.candidate.provider).toBe('gemini');
    });
  });

  describe('릴레이 보안 정책', () => {
    test('릴레이 검증 후 personal 허용', () => {
      const router = new ModelRouter();
      // 릴레이 보안 검증 완료로 설정
      router.setPolicy('gemini', { relaySecurityVerified: true, allowPersonal: true });

      const decision = router.route({
        text: '내 메모 찾아줘',
        capability: 'search',
      });
      // 이제 Gemini도 후보가 됨 (Groq가 우선순위 높음)
      expect(decision).not.toBeNull();
    });

    test('personal 요청에서 Gemini 허용 확인 (직접 호출)', () => {
      // 2026-10-13 정책 변경: 직접 호출은 릴레이를 거치지 않으므로 personal 허용.
      // 릴레이 실제 사용 시점의 차단은 callGemini에서 수행.
      const router = new ModelRouter();
      const check = router.canUseProvider('gemini', 'personal');
      expect(check.allowed).toBe(true);
    });
  });
});
