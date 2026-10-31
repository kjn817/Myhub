/// <reference types="jest" />
/**
 * src/services/todo-tools.ts 테스트
 * 마커 파서 + DB 실행 함수 5종
 */

import {
  parseTodoMarkers,
  executeTodoAdd,
  executeTodoList,
  executeTodoDone,
  executeTodoUpdate,
  executeTodoDelete,
} from '../../src/services/todo-tools';

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

describe('parseTodoMarkers', () => {
  test('TODO_ADD 파싱', () => {
    const r = parseTodoMarkers('[TODO_ADD]{"title": "buy milk"}[/TODO_ADD]');
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('add');
    expect(r[0].data.title).toBe('buy milk');
  });

  test('TODO_ADD는 title 필수', () => {
    expect(parseTodoMarkers('[TODO_ADD]{"x": 1}[/TODO_ADD]')).toEqual([]);
  });

  test('TODO_LIST 파싱 (data 없어도 됨)', () => {
    const r = parseTodoMarkers('[TODO_LIST]{}[/TODO_LIST]');
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('list');
  });

  test('TODO_DONE은 id 또는 title 필요', () => {
    expect(parseTodoMarkers('[TODO_DONE]{"id": 1}[/TODO_DONE]')[0].action).toBe('done');
    expect(parseTodoMarkers('[TODO_DONE]{"title": "x"}[/TODO_DONE]')[0].action).toBe('done');
    expect(parseTodoMarkers('[TODO_DONE]{}[/TODO_DONE]')).toEqual([]);
  });

  test('TODO_UPDATE는 id 또는 title 필요', () => {
    expect(parseTodoMarkers('[TODO_UPDATE]{"id": 2}[/TODO_UPDATE]')[0].action).toBe('update');
    expect(parseTodoMarkers('[TODO_UPDATE]{}[/TODO_UPDATE]')).toEqual([]);
  });

  test('TODO_DELETE는 id 또는 title 필요', () => {
    expect(parseTodoMarkers('[TODO_DELETE]{"id": 3}[/TODO_DELETE]')[0].action).toBe('delete');
    expect(parseTodoMarkers('[TODO_DELETE]{}[/TODO_DELETE]')).toEqual([]);
  });

  test('여러 액션을 순서대로 파싱', () => {
    const text = '[TODO_ADD]{"title": "a"}[/TODO_ADD][TODO_LIST]{}[/TODO_LIST]';
    const r = parseTodoMarkers(text);
    expect(r.map((x) => x.action)).toEqual(['add', 'list']);
  });

  test('JSON 파싱 실패 시 무시', () => {
    expect(parseTodoMarkers('[TODO_ADD]bad[/TODO_ADD]')).toEqual([]);
    expect(parseTodoMarkers('[TODO_LIST]bad[/TODO_LIST]')).toEqual([]);
    expect(parseTodoMarkers('[TODO_DONE]bad[/TODO_DONE]')).toEqual([]);
    expect(parseTodoMarkers('[TODO_UPDATE]bad[/TODO_UPDATE]')).toEqual([]);
    expect(parseTodoMarkers('[TODO_DELETE]bad[/TODO_DELETE]')).toEqual([]);
  });

  test('각 액션 최대 3개', () => {
    const text = '[TODO_ADD]{"title": "a"}[/TODO_ADD]'.repeat(5);
    expect(parseTodoMarkers(text).filter((x) => x.action === 'add')).toHaveLength(3);
  });

  test('LIST/DONE/UPDATE/DELETE도 최대 3개', () => {
    expect(parseTodoMarkers('[TODO_LIST]{}[/TODO_LIST]'.repeat(5)).filter((x) => x.action === 'list')).toHaveLength(3);
    expect(parseTodoMarkers('[TODO_DONE]{"id": 1}[/TODO_DONE]'.repeat(5)).filter((x) => x.action === 'done')).toHaveLength(3);
    expect(parseTodoMarkers('[TODO_UPDATE]{"id": 1}[/TODO_UPDATE]'.repeat(5)).filter((x) => x.action === 'update')).toHaveLength(3);
    expect(parseTodoMarkers('[TODO_DELETE]{"id": 1}[/TODO_DELETE]'.repeat(5)).filter((x) => x.action === 'delete')).toHaveLength(3);
  });

  test('마커 없으면 빈 배열', () => {
    expect(parseTodoMarkers('hello')).toEqual([]);
  });
});

describe('executeTodoAdd', () => {
  test('추가 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { last_row_id: 7 } } });
    const r = await executeTodoAdd(env, { title: 'test', due_at: '2026-10-18', priority: 2 });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(7);
  });

  test('기본값: due_at null, priority 1', async () => {
    const env = makeEnv();
    const stmt = mockPrepare(env, {});
    await executeTodoAdd(env, { title: 't' });
    expect(stmt.bind).toHaveBeenCalledWith('t', null, 1);
  });

  test('title 없으면 에러', async () => {
    const r = await executeTodoAdd(makeEnv(), {});
    expect(r.success).toBe(false);
    expect(r.error).toBe('제목 필요');
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await executeTodoAdd(env, { title: 't' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('할일 추가 실패');
  });
});

describe('executeTodoList', () => {
  test('조회 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 1, title: 'a' }] });
    const r = await executeTodoList(env, { status: 'done' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([{ id: 1, title: 'a' }]);
  });

  test('기본 status는 pending', async () => {
    const env = makeEnv();
    const stmt = mockPrepare(env, {});
    await executeTodoList(env, {});
    expect(stmt.bind).toHaveBeenCalledWith('pending');
  });

  test('results null이면 빈 배열', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue({ results: null }) }),
    });
    const r = await executeTodoList(env, {});
    expect(r.data).toEqual([]);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: new Error('db') });
    const r = await executeTodoList(env, {});
    expect(r.success).toBe(false);
    expect(r.error).toBe('할일 조회 실패');
  });
});

describe('executeTodoDone', () => {
  test('ID로 완료 처리', async () => {
    const env = makeEnv();
    mockPrepare(env, {});
    const r = await executeTodoDone(env, { id: 5 });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 5 });
  });

  test('제목으로 조회해 단일 결과면 완료', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 3 }] });
    const r = await executeTodoDone(env, { title: 'milk' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(3);
  });

  test('제목 조회 결과 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [] });
    const r = await executeTodoDone(env, { title: '없음' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('제목 조회 결과 여러 개면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 1 }, { id: 2 }] });
    const r = await executeTodoDone(env, { title: 'milk' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('여러 할일');
  });

  test('results가 null이면 빈 배열로 처리', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: null }),
      }),
    });
    const r = await executeTodoDone(env, { title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('ID도 제목도 유효하지 않으면 에러', async () => {
    const r = await executeTodoDone(makeEnv(), {});
    expect(r.success).toBe(false);
    expect(r.error).toBe('유효한 할일 ID나 제목이 필요');
  });

  test('ID가 0이거나 음수면 에러', async () => {
    const r = await executeTodoDone(makeEnv(), { id: -1 });
    expect(r.success).toBe(false);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await executeTodoDone(env, { id: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('완료 처리 실패');
  });
});

describe('executeTodoUpdate', () => {
  test('ID로 수정 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 1 } });
    const r = await executeTodoUpdate(env, { id: 1, title: 'new title' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 1 });
  });

  test('제목으로 조회해 수정', async () => {
    const env = makeEnv();
    let call = 0;
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: call++ === 0 ? [{ id: 4 }] : [] }),
        first: jest.fn().mockResolvedValue({ id: 4 }),
        run: jest.fn().mockResolvedValue({}),
      }),
    });
    const r = await executeTodoUpdate(env, { title: 'milk', priority: 2 });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(4);
  });

  test('제목 조회 결과 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [] });
    const r = await executeTodoUpdate(env, { title: '없음', priority: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('제목 조회 결과 여러 개면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 1 }, { id: 2 }] });
    const r = await executeTodoUpdate(env, { title: 'x', priority: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('여러 할일');
  });

  test('results가 undefined면 빈 배열로 처리', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({}),
      }),
    });
    const r = await executeTodoUpdate(env, { title: 'x', priority: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('존재하지 않는 ID면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: null });
    const r = await executeTodoUpdate(env, { id: 999, title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('할일을 찾을 수 없음');
  });

  test('우선순위 범위 벗어나면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 1 } });
    const r = await executeTodoUpdate(env, { id: 1, priority: 5 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('우선순위');
  });

  test('우선순위 0도 허용', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 1 } });
    const r = await executeTodoUpdate(env, { id: 1, priority: 0 });
    expect(r.success).toBe(true);
  });

  test('변경 필드 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 1 } });
    const r = await executeTodoUpdate(env, { id: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('변경할 내용이 없음');
  });

  test('description, due_at 필드 수정', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { id: 1 } });
    const r = await executeTodoUpdate(env, { id: 1, description: 'd', due_at: '2026-10-20' });
    expect(r.success).toBe(true);
  });

  test('due_at 빈 값은 null로', async () => {
    const env = makeEnv();
    const stmt = mockPrepare(env, { first: { id: 1 } });
    await executeTodoUpdate(env, { id: 1, due_at: '' });
    // UPDATE용 bind 호출 (마지막 호출)에 null이 포함되어야 함
    const calls = stmt.bind.mock.calls;
    const updateCall = calls[calls.length - 1];
    expect(updateCall).toContain(null);
  });

  test('ID 유효하지 않으면 에러', async () => {
    const r = await executeTodoUpdate(makeEnv(), { priority: 1 });
    expect(r.success).toBe(false);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: new Error('db') });
    const r = await executeTodoUpdate(env, { id: 1, title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('할일 수정 실패');
  });
});

describe('executeTodoDelete', () => {
  test('ID로 삭제 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { changes: 1 } } });
    const r = await executeTodoDelete(env, { id: 5 });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 5, deleted: 1 });
  });

  test('삭제된 행 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { changes: 0 } } });
    const r = await executeTodoDelete(env, { id: 999 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('할일을 찾을 수 없음');
  });

  test('meta 없으면 changes 0으로 처리', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: {} });
    const r = await executeTodoDelete(env, { id: 999 });
    expect(r.success).toBe(false);
  });

  test('제목으로 조회해 단일 결과면 삭제', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 3, title: 'milk' }], run: { meta: { changes: 1 } } });
    const r = await executeTodoDelete(env, { title: 'milk' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(3);
  });

  test('제목 조회 결과 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [] });
    const r = await executeTodoDelete(env, { title: '없음' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('제목 조회 결과 여러 개면 후보 목록과 함께 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }] });
    const r = await executeTodoDelete(env, { title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('여러 할일');
    expect(r.error).toContain('id:1');
  });

  test('results가 null이면 빈 배열로 처리', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: null }),
        run: jest.fn().mockResolvedValue({ meta: { changes: 0 } }),
      }),
    });
    const r = await executeTodoDelete(env, { title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('ID 유효하지 않으면 에러', async () => {
    const r = await executeTodoDelete(makeEnv(), {});
    expect(r.success).toBe(false);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await executeTodoDelete(env, { id: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('할일 삭제 실패');
  });
});
