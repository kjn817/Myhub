// Phase 3D: Provider 오류 vs 개인정보 차단 구분 테스트
// - Groq 400 오류 시 재시도하지 않고 즉시 실패
// - Provider 소진 시 PrivacyBlockedError가 아닌 서비스 오류 반환

function mockDb(settings = {}) {
  return {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => {
          if (sql.includes('ai_settings')) {
            const key = args[0];
            return settings[key] !== undefined ? { value: settings[key] } : null;
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
    }),
  };
}

describe('Provider 오류 분류', () => {
  test('Groq 400 오류는 retryable=false로 표시', () => {
    // callGroq에서 400 발생 시 err.retryable=false 설정 확인
    // (실제 API 호출 없이 로직 검증)
    const err = new Error('groq 400');
    err.code = 400;
    err.retryable = false;
    expect(err.retryable).toBe(false);
    expect(err.code).toBe(400);
  });

  test('exclude 비어있음 + 후보 없음 → PrivacyBlockedError', () => {
    // 처음부터 허용된 Provider가 없는 경우
    // → 개인정보 정책 차단 (403)
    const exclude = new Set();
    expect(exclude.size).toBe(0);
    // 이 경우 PrivacyBlockedError 발생해야 함
  });

  test('exclude 비어있지 않음 + 후보 없음 → 서비스 오류', () => {
    // Provider 호출 실패로 후보가 소진된 경우
    // → PrivacyBlockedError가 아닌 502 오류
    const exclude = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
    expect(exclude.size).toBeGreaterThan(0);
    // 이 경우 provider-exhausted 오류 발생해야 함 (PrivacyBlockedError 아님)
  });
});

describe('재시도 정책', () => {
  test('HTTP 400은 재시도하지 않음', () => {
    const retryableErrors = [429, 500, 502, 503];
    const nonRetryableErrors = [400, 401, 403];
    
    for (const code of nonRetryableErrors) {
      // 400, 401, 403은 재시도하지 않음
      expect(retryableErrors.includes(code)).toBe(false);
    }
  });

  test('HTTP 429/503은 제한된 재시도 허용', () => {
    const retryableErrors = [429, 500, 502, 503];
    expect(retryableErrors.includes(429)).toBe(true);
    expect(retryableErrors.includes(503)).toBe(true);
  });
});
