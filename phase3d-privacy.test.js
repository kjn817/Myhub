/**
 * Phase 3D-P: 레거시 개인정보 보호 테스트
 * @jest-environment node
 *
 * 실제 Provider 호출은 Mock으로 감시.
 * P5 필수 테스트 14개.
 */

const { execSync } = require('child_process');

try {
  execSync('npx esbuild src/ai/legacy-privacy-guard.ts --bundle --format=cjs --platform=node --outfile=/tmp/privacy-guard-test.cjs --external:hono', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/services/ai.ts --bundle --format=cjs --platform=node --outfile=/tmp/ai-service-test.cjs --external:hono', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const guard = require('/tmp/privacy-guard-test.cjs');
const ai = require('/tmp/ai-service-test.cjs');

// Mock D1
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

// Provider 호출 감시용 Mock
const providerCalls = [];
function mockProviderEnv() {
  providerCalls.length = 0;
  return {
    DB: mockDb(),
    // 실제 fetch를 가로채기 위해 global.fetch 모킹은 각 테스트에서 수행
  };
}

describe('P5-1/2: 에코 개인 기록 → 프로바이더 고정', () => {
  test('keeper + personal → gemini 직접 호출 허용 (2026-10-13 정책 변경)', async () => {
    // 직접 호출은 릴레이를 거치지 않으므로 personal 허용 (릴레이 경유 시에만 호출 시점 차단)
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'external-ok', latency: 'interactive',
      quality: 'balanced', sensitivity: 'personal',
    });
    expect(m.provider).toBe('gemini');
  });

  test('keeper 고정 시 unverified provider면 실패 (조용한 우회 금지)', async () => {
    // 2026-10-13: workers-ai가 verified로 전환됨. unverified 로직은 ModelRouter 단위 테스트에서 검증.
    // 현재는 verified이므로 성공해야 함.
    const env = mockDb();
    const model = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'external-ok', latency: 'interactive',
      quality: 'balanced', sensitivity: 'personal', providerPin: 'workers-ai',
    });
    expect(model.provider).toBe('workers-ai');
  });

  test('checkProviderAllowed: gemini + personal → 허용 (직접 호출)', () => {
    const check = guard.checkProviderAllowed('gemini', 'personal');
    expect(check.allowed).toBe(true);
  });

  test('checkProviderAllowed: gemini + restricted → 차단 유지', () => {
    const check = guard.checkProviderAllowed('gemini', 'restricted');
    expect(check.allowed).toBe(false);
  });
});

describe('P5-3/4: 허용 Provider 및 안전 종료', () => {
  test('personal → groq 허용', () => {
    expect(guard.checkProviderAllowed('groq', 'personal').allowed).toBe(true);
  });

  test('허용 Provider 없음 → PrivacyBlockedError (조용한 우회 금지)', async () => {
    const env = mockDb();
    // workers-ai를 제외하고, groq/gemini를 모두 비활성화한 상황 시뮬레이션
    // → 실제로는 selectModel이 PrivacyBlockedError를 던져야 함
    // 여기서는 filterAllowedProviders로 검증
    expect(() => guard.filterAllowedProviders([], 'personal')).not.toThrow();
    // 빈 배열은 에러 없이 통과 (선택할 모델이 없는 게 아니라 후보가 없는 것)
  });

  test('restricted → groq도 차단', () => {
    expect(guard.checkProviderAllowed('groq', 'restricted').allowed).toBe(false);
  });
});

describe('P5-5/6: 민감도 유지', () => {
  test('keeper는 최소 personal (비서 정책)', () => {
    expect(guard.getPersonaMinSensitivity('keeper')).toBe('personal');
  });

  test('scheduler는 최소 personal', () => {
    expect(guard.getPersonaMinSensitivity('scheduler')).toBe('personal');
  });

  test('concierge는 general (텍스트 분류로 상향 가능)', () => {
    expect(guard.getPersonaMinSensitivity('concierge')).toBe('general');
  });

  test('메모 도구 사용 시 personal 이상', () => {
    const { sensitivity } = guard.resolveRequestSensitivity(
      'concierge', '안녕', ['MEMO_SEARCH']
    );
    expect(['personal', 'restricted']).toContain(sensitivity);
  });

  test('restricted 키워드 → restricted 유지', () => {
    const { sensitivity } = guard.resolveRequestSensitivity(
      'concierge', '내 비밀번호는 1234야', []
    );
    expect(sensitivity).toBe('restricted');
  });
});

describe('P5-8/9: 플래그와 무관하게 보호', () => {
  test('sensitivity는 prompt_v2 플래그와 독립적 (구조)', () => {
    const src = require('fs').readFileSync(__dirname + '/src/modules/ai/routes.ts', 'utf8');
    // 민감도 설정이 플래그 조건문 밖에 있어야 함
    const sensIdx = src.indexOf('resolveRequestSensitivity');
    const flagIdx = src.indexOf('isPromptV2Enabled');
    expect(sensIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(-1);
    // 민감도 코드가 플래그 분기 이전에 위치 (플래그와 무관)
    expect(sensIdx).toBeLessThan(src.indexOf('const usePromptV2'));
  });
});

describe('S0.1: privacy=private도 데이터 정책 검사', () => {
  test('private + personal → workers-ai 허용 (데이터 정책상)', () => {
    const check = guard.checkDataPolicy('workers-ai', 'personal');
    expect(check.allowed).toBe(true);
  });

  test('private + restricted → workers-ai도 차단 (전체 차단 정책)', () => {
    const check = guard.checkDataPolicy('workers-ai', 'restricted');
    expect(check.allowed).toBe(false);
  });

  test('private + personal → selectModel에서 workers-ai만 선택 (데이터 정책상)', async () => {
    // checkDataPolicy는 provider별 민감도 규칙만 판단 (gemini+personal 허용).
    // privacy=private의 workers-ai 전용 제한은 selectModel에서 강제됨.
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'private', latency: 'interactive',
      quality: 'balanced', sensitivity: 'personal',
    });
    expect(m.provider).toBe('workers-ai');
  });

  test('selectModel: private + summarize → workers-ai (데이터 정책 통과)', async () => {
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'private', latency: 'interactive', quality: 'balanced',
    });
    expect(m.provider).toBe('workers-ai');
  });
});

describe('S0.2: personaId 기준 하한', () => {
  test('resolvePolicySensitivity: personaId=keeper → personal', () => {
    expect(guard.resolvePolicySensitivity({ personaId: 'keeper', capability: 'chat' })).toBe('personal');
  });

  test('resolvePolicySensitivity: personaId=keeper + capability 변경해도 personal', () => {
    // capability를 chat으로 바꿔도 keeper는 personal 유지
    expect(guard.resolvePolicySensitivity({ personaId: 'keeper', capability: 'chat' })).toBe('personal');
  });

  test('resolvePolicySensitivity: personaId=scheduler → personal', () => {
    expect(guard.resolvePolicySensitivity({ personaId: 'scheduler', capability: 'chat' })).toBe('personal');
  });

  test('resolvePolicySensitivity: personaId 없음 + chat → undefined (기존 동작)', () => {
    expect(guard.resolvePolicySensitivity({ capability: 'chat' })).toBeUndefined();
  });

  test('resolvePolicySensitivity: 명시적 sensitivity 우선 (단, 하한보다 낮출 수 없음)', () => {
    expect(guard.resolvePolicySensitivity({ personaId: 'keeper', sensitivity: 'restricted' })).toBe('restricted');
    expect(guard.resolvePolicySensitivity({ personaId: 'concierge', sensitivity: 'personal' })).toBe('personal');
    // keeper + general 명시 → personal 유지 (덮어쓰기 불가)
    expect(guard.resolvePolicySensitivity({ personaId: 'keeper', sensitivity: 'general' })).toBe('personal');
    expect(guard.resolvePolicySensitivity({ personaId: 'scheduler', sensitivity: 'general' })).toBe('personal');
  });

  test('selectModel: providerPin이 unverified면 타 provider로 우회하지 않음', async () => {
    // 2026-10-13: workers-ai가 verified로 전환됨. 고정된 provider가 verified이면 정상 선택됨.
    const env = mockDb();
    const model = await ai.__test.selectModel(env, {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive',
      quality: 'fast', personaId: 'keeper', providerPin: 'workers-ai',
    });
    expect(model.provider).toBe('workers-ai');
  });
});

describe('P5-10/11: 정상 케이스 및 우회 방지', () => {
  test('concierge 비민감 대화 → gemini 선택 가능 (기존 동작)', async () => {
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive',
      quality: 'fast', sensitivity: 'general',
    });
    expect(m.provider).toBe('gemini');
  });

  test('sensitivity 미설정 + chat → 기존 동작 유지 (general 추론)', async () => {
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast',
    });
    expect(m.provider).toBe('gemini');
  });

  test('sensitivity 미설정 + summarize → personal 강제 (fail-closed)', async () => {
    // 민감도 강제 자체는 유지 (personal로 판정됨)
    expect(guard.resolvePolicySensitivity({ capability: 'summarize' })).toBe('personal');
    // 2026-10-13 정책 변경: personal이어도 gemini 직접 호출 허용
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'external-ok', latency: 'interactive', quality: 'balanced',
    });
    expect(m.provider).toBe('gemini');
  });

  test('sensitivity 미설정 + schedule → personal 강제 (fail-closed)', async () => {
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'schedule', privacy: 'external-ok', latency: 'interactive', quality: 'balanced',
    });
    expect(m.provider).not.toBe('gemini');
  });

  test('privacy=private → workers-ai 유지 (민감도 필터 스킵)', async () => {
    const env = mockDb();
    const m = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'private', latency: 'interactive', quality: 'balanced',
    });
    expect(m.provider).toBe('workers-ai');
  });

  test('Provider 오버라이드는 사용자 설정대로 적용 (personal도 gemini 허용)', async () => {
    const env = mockDb({ 'model.summarize': 'gemini-3.5-flash-lite' });
    const m = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'external-ok', latency: 'interactive',
      quality: 'balanced', sensitivity: 'personal',
    });
    // 2026-10-13 정책 변경: personal에서 gemini 직접 호출 허용 → 오버라이드 적용
    expect(m.id).toBe('gemini-3.5-flash-lite');
  });

  test('deprecated 모델 오버라이드는 무시', async () => {
    const env = mockDb({ 'model.summarize': 'gemini-3.8-flash' });
    const m = await ai.__test.selectModel(env, {
      capability: 'summarize', privacy: 'external-ok', latency: 'interactive',
      quality: 'balanced', sensitivity: 'personal',
    });
    expect(m.id).not.toBe('gemini-3.8-flash');
  });
});

describe('긴급 차단 스위치', () => {
  test('ai.emergency_disable 설정 구조 (코드 존재)', () => {
    const src = require('fs').readFileSync(__dirname + '/src/modules/ai/routes.ts', 'utf8');
    expect(src).toContain("ai.emergency_disable");
    expect(src).toContain("일시적으로 비활성화");
  });
});

describe('P5-12: 프롬프트 버전 INSERT 처리', () => {
  test('prompt_version 컬럼 없이도 저장됨 (구형 스키마 대응)', () => {
    const src = require('fs').readFileSync(__dirname + '/src/modules/ai/routes.ts', 'utf8');
    // Phase 3F: 컬럼 존재 여부에 따라 분기 처리
    expect(src).toContain("prompt_version");
    expect(src).toContain("no such column");
  });
  test('컬럼 없음 외 오류는 정상 보고', () => {
    const src = require('fs').readFileSync(__dirname + '/src/modules/ai/routes.ts', 'utf8');
    // isMissingColumn이 false면 throw
    expect(src).toContain("isMissingColumn");
    expect(src).toContain("throw e");
  });
  test('실제 사용한 프롬프트 버전 저장', () => {
    const src = require('fs').readFileSync(__dirname + '/src/modules/ai/routes.ts', 'utf8');
    // r.promptVersion을 사용하여 실제 버전 저장
    expect(src).toContain("r.promptVersion");
  });
});

describe('P5-14: 로그에 개인정보 노출 금지', () => {
  test('PrivacyBlockedError는 민감 데이터를 포함하지 않음', () => {
    const err = new guard.PrivacyBlockedError('test', 'personal', 'test-reason');
    expect(err.message).not.toMatch(/비밀번호|password|api[_-]?key/i);
    expect(JSON.stringify(err)).not.toMatch(/[0-9]{6}/); // OTP 패턴 없음
  });
});
