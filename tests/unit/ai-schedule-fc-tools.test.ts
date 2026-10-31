/// <reference types="jest" />

/**
 * schedule_create FC 도구 — 정의·검증·디스패처 실행·스킬 매칭 (2026-10-30)
 *
 * 회귀 2의 도구 계층 검증:
 * - 도구 정의와 인자 검증 (schedule-fc-tools.ts)
 * - 디스패처가 실제로 schedules 테이블에 삽입하는지 (가짜 D1 어댑터로
 *   SQL·바인딩을 기록해 검증 — 실행기 executeScheduleCreate는 실제 코드)
 * - keeper 일정 "등록" 턴에만 스킬이 로드되는지 (조회 턴은 기존 영역 유지)
 */

import { SCHEDULE_FC_TOOLS, validateScheduleFCArgs } from '../../src/ai/schedule-fc-tools';
import { dispatchToolCall } from '../../src/ai/memo-tool-dispatcher';
import { resolveSkillsForTurn, matchSkills } from '../../src/services/skill-registry';

describe('SCHEDULE_FC_TOOLS 정의', () => {
  test('schedule_create 하나만 있고 필수 인자는 title·start_at이다', () => {
    expect(SCHEDULE_FC_TOOLS.map((t) => t.name)).toEqual(['schedule_create']);
    expect(SCHEDULE_FC_TOOLS[0].parameters.required).toEqual(['title', 'start_at']);
  });
});

describe('validateScheduleFCArgs', () => {
  const ok = { title: '회의', start_at: '2026-10-31T15:00:00' };

  test('정상 인자 통과', () => {
    expect(validateScheduleFCArgs('schedule_create', ok)).toEqual({ valid: true });
    expect(validateScheduleFCArgs('schedule_create', { ...ok, end_at: '2026-10-31T16:00:00' }))
      .toEqual({ valid: true });
  });

  test('알 수 없는 도구·필수 누락·형식 오류는 거부', () => {
    expect(validateScheduleFCArgs('schedule_delete', ok).valid).toBe(false);
    expect(validateScheduleFCArgs('schedule_create', { start_at: ok.start_at }).error)
      .toContain('title');
    expect(validateScheduleFCArgs('schedule_create', { title: '회의' }).error)
      .toContain('start_at');
    expect(validateScheduleFCArgs('schedule_create', { ...ok, title: '  ' }).valid).toBe(false);
    expect(validateScheduleFCArgs('schedule_create', { ...ok, start_at: '내일 오후 3시' }).valid)
      .toBe(false);
    expect(validateScheduleFCArgs('schedule_create', { ...ok, start_at: '2026-10-31 15:00' }).valid)
      .toBe(false);
    expect(validateScheduleFCArgs('schedule_create', { ...ok, end_at: '16:00' }).valid).toBe(false);
    expect(validateScheduleFCArgs('schedule_create', null).valid).toBe(false);
  });
});

/** SQL과 바인딩을 기록하는 가짜 D1 — executeScheduleCreate의 실제 동작 검증용 */
function makeRecordingDb(opts: { existing?: any } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const rec = { sql, params: [] as any[] };
        calls.push(rec);
        return {
          bind(...params: any[]) {
            rec.params = params;
            return this;
          },
          async first() {
            return opts.existing ?? null;
          },
          async run() {
            return { meta: { last_row_id: 42, changes: 1 } };
          },
        };
      },
    },
  };
  return { env, calls };
}

describe('dispatchToolCall — schedule_create 실제 실행', () => {
  test('schedules에 삽입하고 성공 결과를 돌려준다 (할일 연동 포함)', async () => {
    const { env, calls } = makeRecordingDb();
    const result = await dispatchToolCall(env, {
      name: 'schedule_create',
      arguments: { title: '[EVAL] eval 일정 테스트', start_at: '2026-10-31T15:00:00' },
    });
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('schedule_create');
    expect(result.data.id).toBe(42);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO schedules'));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain('[EVAL] eval 일정 테스트');
    expect(insert!.params).toContain('2026-10-31T15:00:00');
    // 일정-할일 연동 (executeScheduleCreate 기존 동작)
    const todoInsert = calls.find((c) => c.sql.includes('INSERT INTO todos'));
    expect(todoInsert).toBeDefined();
  });

  test('같은 제목+날짜 중복이면 실행기가 거부하고 디스패처가 실패로 전한다', async () => {
    const { env } = makeRecordingDb({
      existing: { id: 5, title: '[EVAL] eval 일정 테스트', start_at: '2026-10-31T15:00:00' },
    });
    const result = await dispatchToolCall(env, {
      name: 'schedule_create',
      arguments: { title: '[EVAL] eval 일정 테스트', start_at: '2026-10-31T15:00:00' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('중복 일정');
  });

  test('잘못된 start_at 형식은 DB에 닿기 전에 검증에서 거부된다', async () => {
    const { env, calls } = makeRecordingDb();
    const result = await dispatchToolCall(env, {
      name: 'schedule_create',
      arguments: { title: '회의', start_at: '내일 오후 3시' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('start_at');
    expect(calls).toHaveLength(0);
  });
});

describe('스킬 매칭 — keeper 일정 등록', () => {
  test('eval 문구 그대로: 일정 등록 턴에 schedule_create 도구가 로드된다', () => {
    const load = resolveSkillsForTurn({
      text: "내일 오후 3시에 '[EVAL] eval 일정 테스트' 일정을 등록해줘.",
      personaId: 'keeper',
    });
    expect(load.matchedIds).toContain('schedule-create');
    expect(load.tools.map((t) => t.name)).toEqual(['schedule_create']);
  });

  test('단순 일정 조회는 schedule-create가 매칭되지 않는다 (기존 위임 영역 유지)', () => {
    expect(matchSkills('내일 일정 알려줘', { personaId: 'keeper' }).map((m) => m.skill.id))
      .not.toContain('schedule-create');
    const load = resolveSkillsForTurn({ text: '내일 일정 알려줘', personaId: 'keeper' });
    expect(load.tools.map((t) => t.name)).not.toContain('schedule_create');
  });

  test('반복 자동화 요청은 schedule_create가 아니라 cron 영역이다', () => {
    const load = resolveSkillsForTurn({
      text: '매일 아침 8시에 뉴스 요약해서 푸시해줘',
      personaId: 'keeper',
    });
    expect(load.tools.map((t) => t.name)).not.toContain('schedule_create');
    expect(load.tools.map((t) => t.name)).toContain('cron_create');
  });

  test('scheduler에게는 schedule-create(FC)가 로드되지 않는다 (마커 경로 유지)', () => {
    const load = resolveSkillsForTurn({
      text: '내일 오후 3시에 회의 일정을 등록해줘',
      personaId: 'scheduler',
    });
    expect(load.tools.map((t) => t.name)).not.toContain('schedule_create');
    expect(load.matchedIds).toContain('schedule');
  });
});
