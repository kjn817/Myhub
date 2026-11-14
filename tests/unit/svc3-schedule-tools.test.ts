/// <reference types="jest" />
/**
 * src/services/schedule-tools.ts 테스트
 * 마커 파서 + DB 실행 함수 4종
 */

import {
  parseScheduleMarkers,
  executeScheduleCreate,
  executeScheduleList,
  executeScheduleUpdate,
  executeScheduleDelete,
} from '../../src/services/schedule-tools';

function mockPrepare(env: any, impl: { first?: any; run?: any; all?: any }) {
  const stmt = {
    bind: jest.fn().mockReturnValue({
      first: jest.fn().mockImplementation(async () => {
        if (impl.first instanceof Error) throw impl.first;
        return typeof impl.first === 'function' ? impl.first() : impl.first ?? null;
      }),
      run: jest.fn().mockImplementation(async () => {
        if (impl.run instanceof Error) throw impl.run;
        return impl.run ?? { meta: { last_row_id: 1, changes: 1 } };
      }),
      all: jest.fn().mockImplementation(async () => {
        if (impl.all instanceof Error) throw impl.all;
        return { results: impl.all ?? [] };
      }),
    }),
  };
  env.DB.prepare = jest.fn().mockReturnValue(stmt);
  return stmt;
}

const makeEnv = () => ({ DB: { prepare: jest.fn() } });

describe('parseScheduleMarkers', () => {
  test('SCHEDULE_CREATE 파싱', () => {
    const r = parseScheduleMarkers('[SCHEDULE_CREATE]{"title": "meeting", "start_at": "2026-10-18T10:00"}[/SCHEDULE_CREATE]');
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('create');
    expect(r[0].data.title).toBe('meeting');
  });

  test('SCHEDULE_CREATE는 title 필수', () => {
    expect(parseScheduleMarkers('[SCHEDULE_CREATE]{"start_at": "x"}[/SCHEDULE_CREATE]')).toEqual([]);
  });

  test('SCHEDULE_LIST 파싱', () => {
    const r = parseScheduleMarkers('[SCHEDULE_LIST]{"from": "2026-10-18"}[/SCHEDULE_LIST]');
    expect(r[0].action).toBe('list');
  });

  test('SCHEDULE_UPDATE는 id 또는 title 필요', () => {
    expect(parseScheduleMarkers('[SCHEDULE_UPDATE]{"id": 1}[/SCHEDULE_UPDATE]')[0].action).toBe('update');
    expect(parseScheduleMarkers('[SCHEDULE_UPDATE]{"title": "x"}[/SCHEDULE_UPDATE]')[0].action).toBe('update');
    expect(parseScheduleMarkers('[SCHEDULE_UPDATE]{}[/SCHEDULE_UPDATE]')).toEqual([]);
  });

  test('SCHEDULE_DELETE는 id 또는 title 필요', () => {
    expect(parseScheduleMarkers('[SCHEDULE_DELETE]{"id": 1}[/SCHEDULE_DELETE]')[0].action).toBe('delete');
    expect(parseScheduleMarkers('[SCHEDULE_DELETE]{}[/SCHEDULE_DELETE]')).toEqual([]);
  });

  test('JSON 파싱 실패 시 무시', () => {
    expect(parseScheduleMarkers('[SCHEDULE_CREATE]bad[/SCHEDULE_CREATE]')).toEqual([]);
    expect(parseScheduleMarkers('[SCHEDULE_LIST]bad[/SCHEDULE_LIST]')).toEqual([]);
    expect(parseScheduleMarkers('[SCHEDULE_UPDATE]bad[/SCHEDULE_UPDATE]')).toEqual([]);
    expect(parseScheduleMarkers('[SCHEDULE_DELETE]bad[/SCHEDULE_DELETE]')).toEqual([]);
  });

  test('각 액션 최대 3개', () => {
    expect(parseScheduleMarkers('[SCHEDULE_CREATE]{"title": "a"}[/SCHEDULE_CREATE]'.repeat(5)).filter((x) => x.action === 'create')).toHaveLength(3);
    expect(parseScheduleMarkers('[SCHEDULE_LIST]{}[/SCHEDULE_LIST]'.repeat(5)).filter((x) => x.action === 'list')).toHaveLength(3);
    expect(parseScheduleMarkers('[SCHEDULE_UPDATE]{"id": 1}[/SCHEDULE_UPDATE]'.repeat(5)).filter((x) => x.action === 'update')).toHaveLength(3);
    expect(parseScheduleMarkers('[SCHEDULE_DELETE]{"id": 1}[/SCHEDULE_DELETE]'.repeat(5)).filter((x) => x.action === 'delete')).toHaveLength(3);
  });

  test('마커 없으면 빈 배열', () => {
    expect(parseScheduleMarkers('hello')).toEqual([]);
  });
});

describe('executeScheduleCreate', () => {
  test('생성 성공 (할일 자동 생성 포함)', async () => {
    const env = makeEnv();
    let callCount = 0;
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => {
      callCount++;
      return {
        bind: jest.fn().mockReturnValue({
          // 첫 번째: 중복 체크 (없음), 두 번째: INSERT schedule, 세 번째: INSERT todo
          first: jest.fn().mockResolvedValue(null),
          run: jest.fn().mockResolvedValue({ meta: { last_row_id: callCount === 2 ? 10 : 20 } }),
        }),
      };
    });
    const r = await executeScheduleCreate(env, { title: 'meeting', start_at: '2026-10-18T10:00:00' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(10);
    expect(r.data.todo_id).toBe(20);
  });

  test('title 또는 start_at 없으면 에러', async () => {
    expect((await executeScheduleCreate(makeEnv(), { title: 'x' })).success).toBe(false);
    expect((await executeScheduleCreate(makeEnv(), { start_at: 'x' })).success).toBe(false);
    expect((await executeScheduleCreate(makeEnv(), {})).error).toBe('제목과 시작 시간이 필요');
  });

  test('중복 일정이면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 5, title: 'meeting', start_at: '2026-10-18T10:00' } });
    const r = await executeScheduleCreate(env, { title: 'meeting', start_at: '2026-10-18T10:00:00' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('중복 일정');
    expect(r.duplicate).toBe(true);
    expect(r.existingId).toBe(5);
  });

  test('create_todo=false면 할일 생성 안 함', async () => {
    const env = makeEnv();
    const sqls: string[] = [];
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => {
      sqls.push(sql);
      return {
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue(null),
          run: jest.fn().mockResolvedValue({ meta: { last_row_id: 10 } }),
        }),
      };
    });
    const r = await executeScheduleCreate(env, { title: 'm', start_at: '2026-10-18T10:00', create_todo: false });
    expect(r.success).toBe(true);
    expect(r.data.todo_id).toBeNull();
    // 중복 체크 + 일정 INSERT + Google 쓰기-스루 로그 — todos INSERT는 없다
    expect(sqls.some((s) => s.includes('INSERT INTO todos'))).toBe(false);
    expect(sqls.filter((s) => s.includes('INSERT INTO schedules'))).toHaveLength(1);
    expect(sqls.some((s) => s.includes('INSERT INTO google_sync_log'))).toBe(true);
  });

  test('할일 생성 실패해도 일정은 성공', async () => {
    const env = makeEnv();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let callIdx = 0;
    env.DB.prepare = jest.fn().mockImplementation(() => {
      callIdx++;
      return {
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue(null),
          run: jest.fn().mockImplementation(async () => {
            if (callIdx === 3) throw new Error('todo fail');
            return { meta: { last_row_id: 10 } };
          }),
        }),
      };
    });
    const r = await executeScheduleCreate(env, { title: 'm', start_at: '2026-10-18T10:00' });
    expect(r.success).toBe(true);
    expect(r.data.todo_id).toBeNull();
    consoleSpy.mockRestore();
  });

  test('description/location 기본값', async () => {
    const env = makeEnv();
    const stmt = mockPrepare(env, { first: null, run: { meta: { last_row_id: 1 } } });
    // create_todo=false로 할일 생성 스킵
    await executeScheduleCreate(env, { title: 'm', start_at: '2026-10-18T10:00', create_todo: false });
    // INSERT 바인딩 확인 (title, description='', location='', start_at, end_at=null, timezone)
    const insertCall = stmt.bind.mock.calls.find((c: any[]) => c.length === 6);
    expect(insertCall[1]).toBe('');
    expect(insertCall[2]).toBe('');
    expect(insertCall[4]).toBeNull();
    expect(insertCall[5]).toBe('Asia/Seoul');
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: new Error('db') });
    const r = await executeScheduleCreate(env, { title: 'm', start_at: '2026-10-18T10:00' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('일정 생성 실패');
  });
});

describe('executeScheduleList', () => {
  test('조회 성공 (단건 + 반복)', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => ({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({
          results: sql.includes('recurrence_rule IS NULL')
            ? [{ id: 1, title: 'single', start_at: '2026-10-18T10:00:00', end_at: null, location: '', recurrence_rule: null }]
            : [],
        }),
      }),
    }));
    const r = await executeScheduleList(env, { from: '2026-10-18', to: '2026-10-25' });
    expect(r.success).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].title).toBe('single');
  });

  test('from/to 기본값 (오늘~7일 후)', async () => {
    const env = makeEnv();
    mockPrepare(env, {});
    const r = await executeScheduleList(env, {});
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  test('반복 일정展開', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => ({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({
          results: sql.includes('recurrence_rule IS NULL')
            ? []
            : [{ id: 2, title: 'daily', start_at: '2026-10-18T09:00:00', end_at: null, location: '', recurrence_rule: 'FREQ=DAILY;COUNT=3' }],
        }),
      }),
    }));
    const r = await executeScheduleList(env, { from: '2026-10-18', to: '2026-10-25' });
    expect(r.success).toBe(true);
    expect(r.data.length).toBe(3); // COUNT=3
    expect(r.data[0].is_recurring).toBe(true);
  });

  test('정렬 확인', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => ({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({
          results: sql.includes('recurrence_rule IS NULL')
            ? [
                { id: 2, title: 'later', start_at: '2026-10-19T10:00:00', end_at: null, location: '', recurrence_rule: null },
                { id: 1, title: 'earlier', start_at: '2026-10-18T10:00:00', end_at: null, location: '', recurrence_rule: null },
              ]
            : [],
        }),
      }),
    }));
    const r = await executeScheduleList(env, { from: '2026-10-18', to: '2026-10-25' });
    expect(r.data[0].title).toBe('earlier');
    expect(r.data[1].title).toBe('later');
  });

  test('최대 20개로 제한', async () => {
    const env = makeEnv();
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: i, title: `t${i}`, start_at: `2026-10-18T${String(i).padStart(2, '0')}:00:00`, end_at: null, location: '', recurrence_rule: null,
    }));
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => ({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: sql.includes('recurrence_rule IS NULL') ? many : [] }),
      }),
    }));
    const r = await executeScheduleList(env, { from: '2026-10-18', to: '2026-10-25' });
    expect(r.data.length).toBeLessThanOrEqual(20);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: new Error('db') });
    const r = await executeScheduleList(env, {});
    expect(r.success).toBe(false);
    expect(r.error).toBe('일정 조회 실패');
  });

  test('results가 null이면 빈 배열로 처리 (|| [] 폴백)', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: null }),
      }),
    });
    const r = await executeScheduleList(env, { from: '2026-10-18', to: '2026-10-25' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  test('동일 start_at 정렬 동등 분기', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => ({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({
          results: sql.includes('recurrence_rule IS NULL')
            ? [
                { id: 1, title: 'a', start_at: '2026-10-18T10:00:00', end_at: null, location: '', recurrence_rule: null },
                { id: 2, title: 'b', start_at: '2026-10-18T10:00:00', end_at: null, location: '', recurrence_rule: null },
              ]
            : [],
        }),
      }),
    }));
    const r = await executeScheduleList(env, { from: '2026-10-18', to: '2026-10-25' });
    expect(r.success).toBe(true);
    expect(r.data).toHaveLength(2);
  });
});

describe('executeScheduleUpdate', () => {
  test('ID로 수정 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 1 } });
    const r = await executeScheduleUpdate(env, { id: 1, title: 'new' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 1 });
  });

  test('new_title도 title로 매핑', async () => {
    const env = makeEnv();
    const stmt = mockPrepare(env, { first: { id: 1 } });
    await executeScheduleUpdate(env, { id: 1, new_title: 'renamed' });
    // 마지막 prepare는 Google 쓰기-스루 로그일 수 있어 UPDATE 문을 직접 찾는다
    const sql = env.DB.prepare.mock.calls.map((c: any[]) => c[0]).find((s: string) => s.includes('UPDATE schedules'));
    expect(sql).toBeDefined();
    expect(sql).toContain('title = ?');
    const updateBind = stmt.bind.mock.calls.find((args: any[]) => args.includes('renamed'));
    expect(updateBind).toBeDefined();
  });

  test('제목으로 조회해 단일 결과면 수정', async () => {
    const env = makeEnv();
    let call = 0;
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: call++ === 0 ? [{ id: 4, title: 'm', start_at: '2026-10-18' }] : [] }),
        first: jest.fn().mockResolvedValue({ id: 4 }),
        run: jest.fn().mockResolvedValue({}),
      }),
    });
    const r = await executeScheduleUpdate(env, { title: 'm', location: 'seoul' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(4);
  });

  test('제목 조회 결과 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [] });
    const r = await executeScheduleUpdate(env, { title: '없음', location: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('제목 조회 결과 여러 개면 후보 목록 반환', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 1, title: 'a', start_at: 's1' }, { id: 2, title: 'b', start_at: 's2' }] });
    const r = await executeScheduleUpdate(env, { title: 'x', location: 'y' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('multiple_candidates');
    expect(r.candidates).toHaveLength(2);
  });

  test('results가 null이면 빈 배열로 처리', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: null }),
      }),
    });
    const r = await executeScheduleUpdate(env, { title: 'x', location: 'y' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('존재하지 않는 ID면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: null });
    const r = await executeScheduleUpdate(env, { id: 999, title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('일정을 찾을 수 없음');
  });

  test('변경 필드 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 1 } });
    const r = await executeScheduleUpdate(env, { id: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('변경할 내용이 없음');
  });

  test('ID 유효하지 않으면 에러', async () => {
    const r = await executeScheduleUpdate(makeEnv(), { location: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('유효한 일정 ID나 제목이 필요');
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: new Error('db') });
    const r = await executeScheduleUpdate(env, { id: 1, title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('일정 수정 실패');
  });
});

describe('executeScheduleDelete', () => {
  test('ID로 삭제 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { changes: 1 } } });
    const r = await executeScheduleDelete(env, { id: 5 });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 5, deleted: 1 });
  });

  test('삭제된 행 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { changes: 0 } } });
    const r = await executeScheduleDelete(env, { id: 999 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('일정을 찾을 수 없음');
  });

  test('meta 없으면 changes 0', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: {} });
    const r = await executeScheduleDelete(env, { id: 999 });
    expect(r.success).toBe(false);
  });

  test('제목으로 조회해 단일 결과면 삭제', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 3, title: 'm', start_at: 's' }], run: { meta: { changes: 1 } } });
    const r = await executeScheduleDelete(env, { title: 'm' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(3);
  });

  test('제목 조회 결과 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [] });
    const r = await executeScheduleDelete(env, { title: '없음' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('제목 조회 결과 여러 개면 후보 목록 반환', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 1, title: 'a', start_at: 's1' }, { id: 2, title: 'b', start_at: 's2' }] });
    const r = await executeScheduleDelete(env, { title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('multiple_candidates');
    expect(r.candidates).toHaveLength(2);
  });

  test('results가 null이면 빈 배열로 처리', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: null }),
      }),
    });
    const r = await executeScheduleDelete(env, { title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('ID 유효하지 않으면 에러', async () => {
    const r = await executeScheduleDelete(makeEnv(), {});
    expect(r.success).toBe(false);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await executeScheduleDelete(env, { id: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('일정 삭제 실패');
  });
});
