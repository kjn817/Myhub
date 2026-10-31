/// <reference types="jest" />
/**
 * src/services/memo-tools.ts 테스트
 * 마커 파서 5종 + DB 실행 함수 5종
 */

import {
  parseMemoSearchMarkers,
  parseMemoGetMarkers,
  parseMemoCreateMarkers,
  parseMemoUpdateMarkers,
  parseMemoDeleteMarkers,
  executeMemoSearch,
  executeMemoGet,
  executeMemoCreate,
  executeMemoUpdate,
  executeMemoDelete,
} from '../../src/services/memo-tools';

jest.mock('../../src/services/ai-access', () => ({
  searchAccessibleMemos: jest.fn(),
  getAccessibleMemo: jest.fn(),
}));

import { searchAccessibleMemos, getAccessibleMemo } from '../../src/services/ai-access';

// --- Mock DB 헬퍼 ---
function makeEnv(overrides: Record<string, any> = {}) {
  return {
    DB: {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          run: jest.fn().mockResolvedValue({ meta: { last_row_id: 42 } }),
          first: jest.fn().mockResolvedValue(null),
          all: jest.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    },
    ...overrides,
  };
}

function mockPrepare(env: any, impl: { first?: any; run?: any; all?: any }) {
  const stmt = {
    bind: jest.fn().mockReturnValue({
      first: jest.fn().mockImplementation(async () => {
        if (impl.first instanceof Error) throw impl.first;
        return typeof impl.first === 'function' ? impl.first() : impl.first ?? null;
      }),
      run: jest.fn().mockImplementation(async () => {
        if (impl.run instanceof Error) throw impl.run;
        return impl.run ?? { meta: { last_row_id: 1 } };
      }),
      all: jest.fn().mockResolvedValue({ results: impl.all ?? [] }),
    }),
  };
  env.DB.prepare = jest.fn().mockReturnValue(stmt);
  return stmt;
}

describe('parseMemoSearchMarkers', () => {
  test('정상 마커를 파싱한다', () => {
    const r = parseMemoSearchMarkers('[MEMO_SEARCH]{"query": "hello"}[/MEMO_SEARCH]');
    expect(r).toHaveLength(1);
    expect(r[0].query).toBe('hello');
    expect(r[0].full).toContain('[MEMO_SEARCH]');
  });

  test('query 200자로 잘린다', () => {
    const r = parseMemoSearchMarkers(`[MEMO_SEARCH]{"query": "${'x'.repeat(300)}"}[/MEMO_SEARCH]`);
    expect(r[0].query.length).toBe(200);
  });

  test('query 없으면 무시', () => {
    expect(parseMemoSearchMarkers('[MEMO_SEARCH]{"q": "x"}[/MEMO_SEARCH]')).toEqual([]);
  });

  test('query가 문자열이 아니면 무시', () => {
    expect(parseMemoSearchMarkers('[MEMO_SEARCH]{"query": 123}[/MEMO_SEARCH]')).toEqual([]);
  });

  test('JSON 파싱 실패 시 무시', () => {
    expect(parseMemoSearchMarkers('[MEMO_SEARCH]not json[/MEMO_SEARCH]')).toEqual([]);
  });

  test('최대 3개까지만 파싱', () => {
    const text = '[MEMO_SEARCH]{"query": "a"}[/MEMO_SEARCH]'.repeat(5);
    expect(parseMemoSearchMarkers(text)).toHaveLength(3);
  });

  test('대소문자 무시', () => {
    const r = parseMemoSearchMarkers('[memo_search]{"query": "x"}[/memo_search]');
    expect(r).toHaveLength(1);
  });

  test('마커 없으면 빈 배열', () => {
    expect(parseMemoSearchMarkers('plain text')).toEqual([]);
  });
});

describe('parseMemoGetMarkers', () => {
  test('정상 마커를 파싱한다', () => {
    const r = parseMemoGetMarkers('[MEMO_GET]{"id": 123}[/MEMO_GET]');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(123);
  });

  test('id가 정수가 아니면 무시', () => {
    expect(parseMemoGetMarkers('[MEMO_GET]{"id": 1.5}[/MEMO_GET]')).toEqual([]);
    expect(parseMemoGetMarkers('[MEMO_GET]{"id": "abc"}[/MEMO_GET]')).toEqual([]);
  });

  test('id 없으면 무시', () => {
    expect(parseMemoGetMarkers('[MEMO_GET]{}[/MEMO_GET]')).toEqual([]);
  });

  test('JSON 파싱 실패 시 무시', () => {
    expect(parseMemoGetMarkers('[MEMO_GET]xxx[/MEMO_GET]')).toEqual([]);
  });

  test('최대 3개', () => {
    expect(parseMemoGetMarkers('[MEMO_GET]{"id": 1}[/MEMO_GET]'.repeat(5))).toHaveLength(3);
  });
});

describe('parseMemoCreateMarkers', () => {
  test('정상 마커를 파싱한다', () => {
    const r = parseMemoCreateMarkers('[MEMO_CREATE]{"text": "hello"}[/MEMO_CREATE]');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('hello');
  });

  test('text 10000자로 잘린다', () => {
    const r = parseMemoCreateMarkers(`[MEMO_CREATE]{"text": "${'y'.repeat(11000)}"}[/MEMO_CREATE]`);
    expect(r[0].text.length).toBe(10000);
  });

  test('text 없으면 무시', () => {
    expect(parseMemoCreateMarkers('[MEMO_CREATE]{}[/MEMO_CREATE]')).toEqual([]);
  });

  test('최대 2개', () => {
    expect(parseMemoCreateMarkers('[MEMO_CREATE]{"text": "a"}[/MEMO_CREATE]'.repeat(4))).toHaveLength(2);
  });

  test('JSON 파싱 실패 시 무시', () => {
    expect(parseMemoCreateMarkers('[MEMO_CREATE]bad[/MEMO_CREATE]')).toEqual([]);
  });

  test('title+content 형식을 파싱한다 (루미 출력 형식)', () => {
    const r = parseMemoCreateMarkers('[MEMO_CREATE]{"title": "오늘 할 일", "content": "우유 사기"}[/MEMO_CREATE]');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('오늘 할 일\n\n우유 사기');
  });

  test('content만 있어도 파싱한다', () => {
    const r = parseMemoCreateMarkers('[MEMO_CREATE]{"content": "내용만 있음"}[/MEMO_CREATE]');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('내용만 있음');
  });

  test('text와 title이 함께 있으면 제목을 앞에 붙인다', () => {
    const r = parseMemoCreateMarkers('[MEMO_CREATE]{"title": "제목", "text": "본문"}[/MEMO_CREATE]');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('제목\n\n본문');
  });

  test('content가 비어 있으면 무시', () => {
    expect(parseMemoCreateMarkers('[MEMO_CREATE]{"title": "제목만", "content": "   "}[/MEMO_CREATE]')).toEqual([]);
    expect(parseMemoCreateMarkers('[MEMO_CREATE]{"title": "제목만"}[/MEMO_CREATE]')).toEqual([]);
  });
});

describe('parseMemoUpdateMarkers', () => {
  test('정상 마커를 파싱한다', () => {
    const r = parseMemoUpdateMarkers('[MEMO_UPDATE]{"id": 5, "text": "new"}[/MEMO_UPDATE]');
    expect(r[0].id).toBe(5);
    expect(r[0].text).toBe('new');
  });

  test('id를 Number로 변환', () => {
    const r = parseMemoUpdateMarkers('[MEMO_UPDATE]{"id": "7", "text": "t"}[/MEMO_UPDATE]');
    expect(r[0].id).toBe(7);
  });

  test('text 10000자로 잘린다', () => {
    const r = parseMemoUpdateMarkers(`[MEMO_UPDATE]{"id": 1, "text": "${'z'.repeat(12000)}"}[/MEMO_UPDATE]`);
    expect(r[0].text.length).toBe(10000);
  });

  test('id나 text 없으면 무시', () => {
    expect(parseMemoUpdateMarkers('[MEMO_UPDATE]{"id": 1}[/MEMO_UPDATE]')).toEqual([]);
    expect(parseMemoUpdateMarkers('[MEMO_UPDATE]{"text": "t"}[/MEMO_UPDATE]')).toEqual([]);
  });

  test('최대 2개', () => {
    expect(parseMemoUpdateMarkers('[MEMO_UPDATE]{"id": 1, "text": "a"}[/MEMO_UPDATE]'.repeat(4))).toHaveLength(2);
  });
});

describe('parseMemoDeleteMarkers', () => {
  test('정상 마커를 파싱한다', () => {
    const r = parseMemoDeleteMarkers('[MEMO_DELETE]{"id": 9}[/MEMO_DELETE]');
    expect(r[0].id).toBe(9);
  });

  test('id 없으면 무시', () => {
    expect(parseMemoDeleteMarkers('[MEMO_DELETE]{}[/MEMO_DELETE]')).toEqual([]);
  });

  test('최대 2개', () => {
    expect(parseMemoDeleteMarkers('[MEMO_DELETE]{"id": 1}[/MEMO_DELETE]'.repeat(4))).toHaveLength(2);
  });

  test('JSON 파싱 실패 시 무시', () => {
    expect(parseMemoDeleteMarkers('[MEMO_DELETE]oops[/MEMO_DELETE]')).toEqual([]);
  });
});

describe('executeMemoSearch', () => {
  beforeEach(() => jest.clearAllMocks());

  test('검색 성공', async () => {
    (searchAccessibleMemos as jest.Mock).mockResolvedValue([{ id: 1 }]);
    const r = await executeMemoSearch({}, 'query');
    expect(r.success).toBe(true);
    expect(r.data).toEqual([{ id: 1 }]);
    expect(searchAccessibleMemos).toHaveBeenCalledWith({}, 'query', 5);
  });

  test('검색 실패 시 에러', async () => {
    (searchAccessibleMemos as jest.Mock).mockRejectedValue(new Error('db down'));
    const r = await executeMemoSearch({}, 'query');
    expect(r.success).toBe(false);
    expect(r.error).toBe('검색 실패');
  });
});

describe('executeMemoGet', () => {
  beforeEach(() => jest.clearAllMocks());

  test('조회 성공', async () => {
    (getAccessibleMemo as jest.Mock).mockResolvedValue({ id: 5, text: 'hi' });
    const r = await executeMemoGet({}, 5);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 5, text: 'hi' });
  });

  test('메모 없으면 에러', async () => {
    (getAccessibleMemo as jest.Mock).mockResolvedValue(null);
    const r = await executeMemoGet({}, 999);
    expect(r.success).toBe(false);
    expect(r.error).toBe('메모를 찾을 수 없음');
  });

  test('예외 시 에러', async () => {
    (getAccessibleMemo as jest.Mock).mockRejectedValue(new Error('x'));
    const r = await executeMemoGet({}, 1);
    expect(r.success).toBe(false);
    expect(r.error).toBe('조회 실패');
  });
});

describe('executeMemoCreate', () => {
  test('생성 성공 (is_locked=0, sensitivity=0)', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { last_row_id: 42 } } });
    const r = await executeMemoCreate(env, 'new memo');
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 42 });
    const sql = env.DB.prepare.mock.calls[0][0];
    expect(sql).toContain('is_locked');
    expect(sql).toContain('sensitivity');
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await executeMemoCreate(env, 'x');
    expect(r.success).toBe(false);
    expect(r.error).toBe('생성 실패');
  });
});

describe('executeMemoUpdate', () => {
  test('수정 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { is_locked: 0 }, run: {} });
    const r = await executeMemoUpdate(env, 1, 'updated');
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 1 });
  });

  test('메모 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: null });
    const r = await executeMemoUpdate(env, 999, 'x');
    expect(r.success).toBe(false);
    expect(r.error).toBe('메모를 찾을 수 없음');
  });

  test('잠긴 메모는 수정 불가', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { is_locked: 1 } });
    const r = await executeMemoUpdate(env, 1, 'x');
    expect(r.success).toBe(false);
    expect(r.error).toBe('잠긴 메모는 수정할 수 없습니다');
  });

  test('DB 예외 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: new Error('db') });
    const r = await executeMemoUpdate(env, 1, 'x');
    expect(r.success).toBe(false);
    expect(r.error).toBe('수정 실패');
  });
});

describe('executeMemoDelete', () => {
  test('삭제 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { is_locked: 0 }, run: {} });
    const r = await executeMemoDelete(env, 1);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 1 });
  });

  test('메모 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: null });
    const r = await executeMemoDelete(env, 999);
    expect(r.success).toBe(false);
    expect(r.error).toBe('메모를 찾을 수 없음');
  });

  test('잠긴 메모는 삭제 불가', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: { is_locked: 1 } });
    const r = await executeMemoDelete(env, 1);
    expect(r.success).toBe(false);
    expect(r.error).toBe('잠긴 메모는 삭제할 수 없습니다');
  });

  test('DB 예외 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { first: new Error('db') });
    const r = await executeMemoDelete(env, 1);
    expect(r.success).toBe(false);
    expect(r.error).toBe('삭제 실패');
  });
});
