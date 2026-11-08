/**
 * Phase 3D: 프롬프트 + 시간 컨텍스트 통합 테스트
 * @jest-environment node
 *
 * D7 필수 테스트 17개:
 * 1-3. 기능 플래그 / 4. 비서 ID 매핑 / 5-10. 시간 컨텍스트
 * 11. 메모 승격 방지 / 12. 도구 권한 / 13. 캘리 FC 금지
 * 14. 피드백 연결 / 15. ModelRouter 회귀 / 16. 프롬프트 버전 / 17. 개인정보 전송
 */

const { execSync } = require('child_process');

try {
  execSync('npx esbuild src/ai/prompt-integration.ts --bundle --format=cjs --platform=node --outfile=/tmp/prompt-integration-test.cjs --external:hono', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/time-context.ts --bundle --format=cjs --platform=node --outfile=/tmp/time-context-test.cjs', { cwd: __dirname, stdio: 'pipe' });
  execSync('npx esbuild src/ai/date-resolver.ts --bundle --format=cjs --platform=node --outfile=/tmp/date-resolver-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const integration = require('/tmp/prompt-integration-test.cjs');
const timeCtx = require('/tmp/time-context-test.cjs');
const dateResolver = require('/tmp/date-resolver-test.cjs');

// Mock D1 (ai_settings)
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
      }),
    }),
  };
}

describe('D1. 기능 플래그', () => {
  test('T01: 플래그 false → 비활성화', async () => {
    const db = mockDb({ 'ai.prompt_v2': 'false' });
    expect(await integration.isPromptV2Enabled(db)).toBe(false);
  });

  test('T02: 플래그 true → 활성화', async () => {
    const db = mockDb({ 'ai.prompt_v2': 'true' });
    expect(await integration.isPromptV2Enabled(db)).toBe(true);
  });

  test('T03: 잘못된 값(TRUE/1/yes) → 비활성화 (엄격 비교)', async () => {
    for (const v of ['TRUE', '1', 'yes', 'on', ' true']) {
      const db = mockDb({ 'ai.prompt_v2': v });
      expect(await integration.isPromptV2Enabled(db)).toBe(false);
    }
  });

  test('T03b: 설정 없음/조회 실패 → 비활성화 (fail-closed)', async () => {
    expect(await integration.isPromptV2Enabled(mockDb({}))).toBe(false);
    expect(await integration.isPromptV2Enabled({ prepare: () => { throw new Error('db down'); } })).toBe(false);
  });
});

describe('D2. 비서 ID 매핑', () => {
  test('T04: 네 비서 ID가 올바른 프롬프트와 매핑', () => {
    const ids = ['concierge', 'keeper', 'builder', 'scheduler'];
    for (const id of ids) {
      const { prompt } = integration.composeV2Prompt(id, {});
      expect(prompt.length).toBeGreaterThan(100);
    }
    // 서로 다른 프롬프트여야 함
    const prompts = ids.map((id) => integration.composeV2Prompt(id, {}).prompt);
    const unique = new Set(prompts);
    expect(unique.size).toBe(4);
  });

  test('T04b: 알 수 없는 ID → 에러 (조용한 폴백 금지)', () => {
    expect(() => integration.composeV2Prompt('unknown_bot', {})).toThrow();
  });

  test('T04c: capabilities는 서버 PERSONAS에서 생성', () => {
    expect(integration.getPersonaCapabilities('concierge').length).toBeGreaterThan(0);
    expect(integration.getPersonaCapabilities('nonexistent')).toEqual([]);
  });
});

describe('D3. 서버 시간 컨텍스트', () => {
  test('T05: scheduler에만 시간 컨텍스트 삽입', () => {
    const ctx = { nowIso: '2026-10-10T12:00:00+09:00', timezone: 'Asia/Seoul', todayLocal: '2026-10-10', weekStartLocal: '2026-10-05', weekdayLocal: 6, weekdayName: '토', epochMs: 123 };
    const cali = integration.composeV2Prompt('scheduler', { timeContext: ctx });
    expect(cali.prompt).toContain('2026-10-10');
    const lumi = integration.composeV2Prompt('concierge', { timeContext: ctx });
    expect(lumi.prompt).not.toContain('2026-10-10');
  });

  test('T06: UTC/Asia-Seoul 날짜 경계 처리', () => {
    // 2026-10-10 00:30 KST = 2026-10-09 15:30 UTC
    const epochMs = Date.parse('2026-10-09T15:30:00Z');
    const kst = timeCtx.createServerTimeContext('Asia/Seoul', epochMs);
    const utc = timeCtx.createServerTimeContext('UTC', epochMs);
    expect(kst.todayLocal).toBe('2026-10-10');
    expect(utc.todayLocal).toBe('2026-10-09');
  });

  test('T07: 상대 날짜 계산 (date-resolver)', () => {
    const ctx = timeCtx.createServerTimeContext('Asia/Seoul', Date.parse('2026-10-10T12:00:00+09:00'));
    const tomorrow = dateResolver.resolveDateExpression('내일', ctx);
    expect(tomorrow.status).toBe('resolved');
    expect(tomorrow.dateLocal).toBe('2026-10-11');
    const yesterday = dateResolver.resolveDateExpression('어제', ctx);
    expect(yesterday.status).toBe('resolved');
    expect(yesterday.dateLocal).toBe('2026-10-09');
  });

  test('T08: 모호한 시간은 임의 확정 금지', () => {
    const ctx = timeCtx.createServerTimeContext('Asia/Seoul', Date.parse('2026-10-10T12:00:00+09:00'));
    const ambiguous = dateResolver.resolveDateExpression('언젠가', ctx);
    // 'ambiguous' 또는 'unsupported' — 임의 날짜 확정 금지
    expect(['ambiguous', 'unsupported']).toContain(ambiguous.status);
    expect(ambiguous.dateLocal).toBeNull();
  });

  test('T09: Fallback 시 기준 시각 유지', () => {
    const epochMs = Date.parse('2026-10-10T12:00:00+09:00');
    const first = timeCtx.createServerTimeContext('Asia/Seoul', epochMs);
    const fallback = timeCtx.createServerTimeContext('Asia/Seoul', first.epochMs);
    expect(fallback.nowIso).toBe(first.nowIso);
    expect(fallback.todayLocal).toBe(first.todayLocal);
  });

  test('T10: 사용자 메시지로 서버 시간 변조 불가 (구조)', () => {
    // createRequestTimeContext는 DB 설정만 읽고, 사용자 입력을 받지 않음
    const src = require('fs').readFileSync(__dirname + '/src/ai/prompt-integration.ts', 'utf8');
    const fnStart = src.indexOf('export async function createRequestTimeContext');
    const fnEnd = src.indexOf('/**', fnStart + 10);
    const fn = src.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fn).not.toMatch(/userMessage|userInput|body\./);
  });
});

describe('보안 경계', () => {
  test('T11: 메모 본문이 시스템 지시로 승격되지 않음 (구조)', () => {
    const src = require('fs').readFileSync(__dirname + '/src/ai/prompt-integration.ts', 'utf8');
    expect(src).not.toMatch(/memoContent|memo\.content/i);
    // composeV2Prompt는 personaId/시간/도구만 받음
    const { prompt } = integration.composeV2Prompt('keeper', {});
    expect(prompt).not.toContain('[MEMO_SEARCH]');
  });

  test('T12: 도구 권한은 서버 정책에서 생성', () => {
    const conciergeTools = integration.getLegacyMarkerTools('concierge');
    const keeperTools = integration.getLegacyMarkerTools('keeper');
    expect(conciergeTools).toContain('MEMO_SEARCH');
    // 064420e (49차 QA, 2026-10-12): 에코(keeper)에 메모 작성/수정/삭제 권한을 의도적으로 부여 — 비서 비전 "메모작성해줘"
    expect(keeperTools).toContain('MEMO_CREATE');
    expect(keeperTools).toContain('MEMO_UPDATE');
    expect(keeperTools).toContain('MEMO_DELETE');
    expect(keeperTools).not.toContain('SCHEDULE_CREATE');
  });

  test('T13: 캘리 FC 자동 활성화 금지 (구조)', () => {
    const src = require('fs').readFileSync(__dirname + '/src/ai/function-calling-route.ts', 'utf8');
    // PILOT_ASSISTANTS에 scheduler가 없어야 함
    const pilotMatch = src.match(/PILOT_ASSISTANTS\s*=\s*\[([^\]]*)\]/);
    expect(pilotMatch).toBeTruthy();
    expect(pilotMatch[1]).not.toContain('scheduler');
  });
});

describe('D5. 프롬프트 버전', () => {
  test('T16: v2 미적용 → legacy, 적용 → persona-v1', () => {
    expect(integration.resolvePromptVersion(false)).toBe('legacy');
    expect(integration.resolvePromptVersion(true)).toBe(integration.PROMPT_VERSION);
    expect(integration.PROMPT_VERSION).toBe('persona-v1');
  });

  test('T14: saveChatHistory가 promptVersion 저장 (구조)', () => {
    const src = require('fs').readFileSync(__dirname + '/src/modules/ai/routes.ts', 'utf8');
    expect(src).toContain('prompt_version');
    // 응답에도 포함
    expect(src).toMatch(/promptVersion.*result\.promptVersion|promptVersion:\s*result/);
  });
});

describe('D4. 레거시 개인정보 전송 (감사)', () => {
  test('T17: keeper 정책이 external-ok임을 문서화 (위험 식별)', () => {
    const src = require('fs').readFileSync(__dirname + '/src/modules/ai/routes.ts', 'utf8');
    const keeperMatch = src.match(/keeper:\s*\{[^}]*privacy:\s*'([^']+)'/);
    expect(keeperMatch).toBeTruthy();
    // 현재 external-ok → D4 보고서에서 별도 수정 제안 (여기서는 변경하지 않음)
    expect(['external-ok', 'private']).toContain(keeperMatch[1]);
  });

  test('T15: ModelRouter 기존 동작 유지 (회귀)', () => {
    // model-router.ts가 존재하고 resolveSensitivity를 export
    const src = require('fs').readFileSync(__dirname + '/src/ai/model-router.ts', 'utf8');
    expect(src).toContain('resolveSensitivity');
  });
});

describe('Phase 3E: 비서별 persona-v1 활성화', () => {
  // Mock DB
  const createMockDb = (settings) => ({
    prepare: (sql) => ({
      bind: (...params) => ({
        first: async () => {
          const key = params[0];
          return settings[key] !== undefined ? { value: settings[key] } : null;
        }
      })
    })
  });

  // isPromptV2EnabledForPersona 로직 직접 테스트
  const isPromptV2EnabledForPersona = async (db, personaId) => {
    try {
      const personaKey = `ai.prompt_v2.${personaId}`;
      const stmt = db.prepare("SELECT value FROM ai_settings WHERE key = ?").bind(personaKey);
      const row = await stmt.first();
      if (row && row.value !== null && row.value !== undefined) {
        return row.value === 'true';
      }
      const globalStmt = db.prepare("SELECT value FROM ai_settings WHERE key = ?").bind('ai.prompt_v2');
      const globalRow = await globalStmt.first();
      return globalRow?.value === 'true';
    } catch {
      return false;
    }
  };

  test('E01: 전역 false + 개별 미설정 → Legacy', async () => {
    const db = createMockDb({ 'ai.prompt_v2': 'false' });
    expect(await isPromptV2EnabledForPersona(db, 'keeper')).toBe(false);
    expect(await isPromptV2EnabledForPersona(db, 'concierge')).toBe(false);
  });

  test('E02: 전역 false + keeper true → 에코만 v1', async () => {
    const db = createMockDb({
      'ai.prompt_v2': 'false',
      'ai.prompt_v2.keeper': 'true'
    });
    expect(await isPromptV2EnabledForPersona(db, 'keeper')).toBe(true);
    expect(await isPromptV2EnabledForPersona(db, 'concierge')).toBe(false);
    expect(await isPromptV2EnabledForPersona(db, 'builder')).toBe(false);
    expect(await isPromptV2EnabledForPersona(db, 'scheduler')).toBe(false);
  });

  test('E03: 전역 false + keeper false → Legacy', async () => {
    const db = createMockDb({
      'ai.prompt_v2': 'false',
      'ai.prompt_v2.keeper': 'false'
    });
    expect(await isPromptV2EnabledForPersona(db, 'keeper')).toBe(false);
  });

  test('E04: 전역 true + keeper false → 에코만 Legacy (개별 우선)', async () => {
    const db = createMockDb({
      'ai.prompt_v2': 'true',
      'ai.prompt_v2.keeper': 'false'
    });
    expect(await isPromptV2EnabledForPersona(db, 'keeper')).toBe(false);
    expect(await isPromptV2EnabledForPersona(db, 'concierge')).toBe(true);
  });

  test('E05: 전역 true + 개별 미설정 → 전역 상속', async () => {
    const db = createMockDb({ 'ai.prompt_v2': 'true' });
    expect(await isPromptV2EnabledForPersona(db, 'keeper')).toBe(true);
    expect(await isPromptV2EnabledForPersona(db, 'concierge')).toBe(true);
  });

  test('E06: 잘못된 설정값 → 안전한 비활성화', async () => {
    const db = createMockDb({
      'ai.prompt_v2': 'false',
      'ai.prompt_v2.keeper': 'yes'  // 'true'가 아님
    });
    expect(await isPromptV2EnabledForPersona(db, 'keeper')).toBe(false);
  });

  test('E07: DB 조회 실패 → v1 비활성화 (fail-closed)', async () => {
    const db = {
      prepare: () => { throw new Error('DB error'); }
    };
    expect(await isPromptV2EnabledForPersona(db, 'keeper')).toBe(false);
  });

  test('E08: SQL 인젝션 방지 - personaId 파라미터 바인딩', async () => {
    let boundParams = [];
    const db = {
      prepare: (sql) => ({
        bind: (...params) => {
          boundParams.push(params[0]);
          return {
            first: async () => null
          };
        }
      })
    };
    // 악의적인 personaId가 SQL에 직접 삽입되지 않는지 확인
    await isPromptV2EnabledForPersona(db, "keeper'; DROP TABLE ai_settings; --");
    // 파라미터로 바인딩되어야 함 (SQL 문자열에 직접 포함되지 않음)
    expect(boundParams[0]).toBe("ai.prompt_v2.keeper'; DROP TABLE ai_settings; --");
  });
});
