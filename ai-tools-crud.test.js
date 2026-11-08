/**
 * AI 도구 CRUD 테스트: SCHEDULE_UPDATE/DELETE, TODO_UPDATE/DELETE
 * @jest-environment node
 *
 * 마커 파싱 + execute 함수 (mock D1)를 검증한다.
 */
const { execSync } = require('child_process');
const path = require('path');

const SCHED_BUNDLE = path.join(__dirname, 'sched-tools-bundle.cjs');
const TODO_BUNDLE = path.join(__dirname, 'todo-tools-bundle.cjs');

execSync(`npx esbuild src/services/schedule-tools.ts --bundle --format=cjs --platform=node --outfile=${SCHED_BUNDLE}`, { cwd: __dirname, stdio: 'pipe' });
execSync(`npx esbuild src/services/todo-tools.ts --bundle --format=cjs --platform=node --outfile=${TODO_BUNDLE}`, { cwd: __dirname, stdio: 'pipe' });

const sched = require('./sched-tools-bundle.cjs');
const todo = require('./todo-tools-bundle.cjs');

// ---- mock D1 ----
function makeMockDb(handlers) {
  const calls = [];
  return {
    calls,
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                run: async () => { calls.push({ sql, params }); return handlers.run(sql, params); },
                all: async () => { calls.push({ sql, params }); return handlers.all(sql, params); },
                first: async () => { calls.push({ sql, params }); return handlers.first(sql, params); },
              };
            },
          };
        },
      },
    },
  };
}

// ================= SCHEDULE =================
describe('parseScheduleMarkers: update/delete', () => {
  test('SCHEDULE_UPDATE 파싱', () => {
    const text = '[SCHEDULE_UPDATE]{"id": 3, "title": "새 제목"}[/SCHEDULE_UPDATE]';
    const markers = sched.parseScheduleMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('update');
    expect(markers[0].data.id).toBe(3);
    expect(markers[0].data.title).toBe('새 제목');
  });

  test('SCHEDULE_DELETE 파싱', () => {
    const text = '[SCHEDULE_DELETE]{"id": 7}[/SCHEDULE_DELETE]';
    const markers = sched.parseScheduleMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('delete');
    expect(markers[0].data.id).toBe(7);
  });

  test('id/title 없는 UPDATE/DELETE는 무시', () => {
    expect(sched.parseScheduleMarkers('[SCHEDULE_UPDATE]{"foo": "x"}[/SCHEDULE_UPDATE]')).toHaveLength(0);
    expect(sched.parseScheduleMarkers('[SCHEDULE_DELETE]{}[/SCHEDULE_DELETE]')).toHaveLength(0);
  });

  test('title 기반 UPDATE/DELETE 파싱', () => {
    expect(sched.parseScheduleMarkers('[SCHEDULE_UPDATE]{"title": "x"}[/SCHEDULE_UPDATE]')).toHaveLength(1);
    expect(sched.parseScheduleMarkers('[SCHEDULE_DELETE]{"title": "x"}[/SCHEDULE_DELETE]')).toHaveLength(1);
  });

  test('잘못된 JSON 무시', () => {
    expect(sched.parseScheduleMarkers('[SCHEDULE_UPDATE]{bad}[/SCHEDULE_UPDATE]')).toHaveLength(0);
    expect(sched.parseScheduleMarkers('[SCHEDULE_DELETE]{bad}[/SCHEDULE_DELETE]')).toHaveLength(0);
  });
});

describe('executeScheduleUpdate', () => {
  function dbWithSchedule(exists) {
    return makeMockDb({
      run: () => ({ meta: { changes: 1 } }),
      all: () => ({ results: [] }),
      first: (sql) => (sql.includes('SELECT id FROM schedules') ? (exists ? { id: 3 } : null) : null),
    });
  }

  test('정상: 선택 필드만 업데이트', async () => {
    const { env, calls } = dbWithSchedule(true);
    const res = await sched.executeScheduleUpdate(env, { id: 3, title: '새 제목', location: '강남' });
    expect(res.success).toBe(true);
    expect(res.data.id).toBe(3);
    const updateCall = calls.find(c => c.sql.startsWith('UPDATE schedules'));
    expect(updateCall.sql).toContain('title = ?');
    expect(updateCall.sql).toContain('location = ?');
    expect(updateCall.sql).not.toContain('start_at = ?');
  });

  test('존재하지 않는 id → 에러', async () => {
    const { env } = dbWithSchedule(false);
    const res = await sched.executeScheduleUpdate(env, { id: 999, title: 'x' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('일정을 찾을 수 없음');
  });

  test('id 없음 → 에러', async () => {
    const { env } = dbWithSchedule(true);
    expect((await sched.executeScheduleUpdate(env, {})).success).toBe(false);
    expect((await sched.executeScheduleUpdate(env, { id: 0, title: 'x' })).success).toBe(false);
    expect((await sched.executeScheduleUpdate(env, { id: 'abc', title: 'x' })).success).toBe(false);
  });

  test('변경 필드 없음 → 에러', async () => {
    const { env } = dbWithSchedule(true);
    const res = await sched.executeScheduleUpdate(env, { id: 3 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('변경할 내용이 없음');
  });
});

describe('executeScheduleDelete', () => {
  test('정상: 삭제된 행 수 반환', async () => {
    const { env } = makeMockDb({
      run: () => ({ meta: { changes: 1 } }),
      all: () => ({ results: [] }),
      first: () => null,
    });
    const res = await sched.executeScheduleDelete(env, { id: 5 });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ id: 5, deleted: 1 });
  });

  test('없는 id → 에러', async () => {
    const { env } = makeMockDb({
      run: () => ({ meta: { changes: 0 } }),
      all: () => ({ results: [] }),
      first: () => null,
    });
    const res = await sched.executeScheduleDelete(env, { id: 999 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('일정을 찾을 수 없음');
  });

  test('id 없음/무효 → 에러', async () => {
    const { env } = makeMockDb({ run: () => ({}), all: () => ({}), first: () => null });
    expect((await sched.executeScheduleDelete(env, {})).success).toBe(false);
    expect((await sched.executeScheduleDelete(env, { id: -1 })).success).toBe(false);
  });
});

// ================= TODO =================
describe('parseTodoMarkers: update/delete', () => {
  test('TODO_UPDATE 파싱', () => {
    const text = '[TODO_UPDATE]{"id": 2, "priority": 2}[/TODO_UPDATE]';
    const markers = todo.parseTodoMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('update');
    expect(markers[0].data.priority).toBe(2);
  });

  test('TODO_DELETE 파싱', () => {
    const text = '[TODO_DELETE]{"id": 4}[/TODO_DELETE]';
    const markers = todo.parseTodoMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('delete');
  });

  test('id/title 없는 UPDATE/DELETE는 무시', () => {
    expect(todo.parseTodoMarkers('[TODO_UPDATE]{"foo": "x"}[/TODO_UPDATE]')).toHaveLength(0);
    expect(todo.parseTodoMarkers('[TODO_DELETE]{}[/TODO_DELETE]')).toHaveLength(0);
  });
});

describe('executeTodoUpdate', () => {
  function dbWithTodo(exists) {
    return makeMockDb({
      run: () => ({ meta: { changes: 1 } }),
      all: () => ({ results: [] }),
      first: (sql) => (sql.includes('SELECT id FROM todos') ? (exists ? { id: 2 } : null) : null),
    });
  }

  test('정상: title/description/priority 업데이트', async () => {
    const { env, calls } = dbWithTodo(true);
    const res = await todo.executeTodoUpdate(env, { id: 2, title: '새 할일', priority: 0 });
    expect(res.success).toBe(true);
    const updateCall = calls.find(c => c.sql.startsWith('UPDATE todos'));
    expect(updateCall.sql).toContain('title = ?');
    expect(updateCall.sql).toContain('priority = ?');
    // priority 0도 정상 반영 (|| 1 버그 회피)
    expect(updateCall.params).toContain(0);
  });

  test('없는 id → 에러', async () => {
    const { env } = dbWithTodo(false);
    const res = await todo.executeTodoUpdate(env, { id: 999, title: 'x' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('할일을 찾을 수 없음');
  });

  test('잘못된 priority → 에러', async () => {
    const { env } = dbWithTodo(true);
    const res = await todo.executeTodoUpdate(env, { id: 2, priority: 5 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('우선순위는 0~2 사이');
  });

  test('변경 필드 없음 → 에러', async () => {
    const { env } = dbWithTodo(true);
    const res = await todo.executeTodoUpdate(env, { id: 2 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('변경할 내용이 없음');
  });

  test('id 무효 → 에러', async () => {
    const { env } = dbWithTodo(true);
    expect((await todo.executeTodoUpdate(env, { id: 'x' })).success).toBe(false);
  });
});

describe('executeTodoDelete', () => {
  test('정상 삭제', async () => {
    const { env } = makeMockDb({
      run: () => ({ meta: { changes: 1 } }),
      all: () => ({ results: [] }),
      first: () => null,
    });
    const res = await todo.executeTodoDelete(env, { id: 4 });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ id: 4, deleted: 1 });
  });

  test('없는 id → 에러', async () => {
    const { env } = makeMockDb({
      run: () => ({ meta: { changes: 0 } }),
      all: () => ({ results: [] }),
      first: () => null,
    });
    const res = await todo.executeTodoDelete(env, { id: 999 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('할일을 찾을 수 없음');
  });
});
