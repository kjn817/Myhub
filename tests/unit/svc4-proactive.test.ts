/// <reference types="jest" />
import { getTodaySchedules, getUpcomingSchedules, generateMorningSummary } from '../../src/services/proactive';

// Mock D1 database
function makeMockDb(results: any[] = [], shouldThrow = false): any {
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockImplementation(async () => {
          if (shouldThrow) throw new Error('db error');
          return { results };
        }),
      }),
    }),
  };
}

describe('getTodaySchedules', () => {
  test('오늘 일정 반환', async () => {
    const rows = [{ id: 1, title: '회의', start_at: '2026-10-17T10:00:00' }];
    const db = makeMockDb(rows);
    const result = await getTodaySchedules({ DB: db as any });
    expect(result).toEqual(rows);
    expect(db.prepare).toHaveBeenCalled();
  });

  test('results가 null이면 빈 배열', async () => {
    const db = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          all: jest.fn().mockResolvedValue({ results: null }),
        }),
      }),
    };
    const result = await getTodaySchedules({ DB: db as any });
    expect(result).toEqual([]);
  });

  test('DB 오류 시 빈 배열 반환', async () => {
    const db = makeMockDb([], true);
    const result = await getTodaySchedules({ DB: db as any });
    expect(result).toEqual([]);
  });

  test('오늘 날짜로 쿼리 바인딩', async () => {
    const db = makeMockDb([]);
    const today = new Date().toISOString().split('T')[0];
    await getTodaySchedules({ DB: db as any });
    const bindMock = db.prepare.mock.results[0].value.bind;
    expect(bindMock).toHaveBeenCalledWith(today);
  });
});

describe('getUpcomingSchedules', () => {
  test('임박한 일정 반환', async () => {
    const rows = [{ id: 2, title: '점심', start_at: '2026-10-17T12:00:00' }];
    const db = makeMockDb(rows);
    const result = await getUpcomingSchedules({ DB: db as any });
    expect(result).toEqual(rows);
  });

  test('기본 minutes=30으로 바인딩', async () => {
    const db = makeMockDb([]);
    await getUpcomingSchedules({ DB: db as any });
    const bindMock = db.prepare.mock.results[0].value.bind;
    expect(bindMock).toHaveBeenCalledWith('+30 minutes');
  });

  test('커스텀 minutes로 바인딩', async () => {
    const db = makeMockDb([]);
    await getUpcomingSchedules({ DB: db }, 60);
    const bindMock = db.prepare.mock.results[0].value.bind;
    expect(bindMock).toHaveBeenCalledWith('+60 minutes');
  });

  test('DB 오류 시 빈 배열 반환', async () => {
    const db = makeMockDb([], true);
    const result = await getUpcomingSchedules({ DB: db as any });
    expect(result).toEqual([]);
  });

  test('results가 undefined면 빈 배열', async () => {
    const db = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          all: jest.fn().mockResolvedValue({}),
        }),
      }),
    };
    const result = await getUpcomingSchedules({ DB: db as any });
    expect(result).toEqual([]);
  });
});

describe('generateMorningSummary', () => {
  test('일정이 없으면 여유로운 하루 메시지', async () => {
    const db = makeMockDb([]);
    const result = await generateMorningSummary({ DB: db as any });
    expect(result).toBe('오늘 일정이 없습니다. 여유로운 하루 보내세요.');
  });

  test('일정이 있으면 개수와 목록 포함', async () => {
    const rows = [
      { id: 1, title: '아침 회의', start_at: '2026-10-17T09:00:00' },
      { id: 2, title: '점심 약속', start_at: '2026-10-17T12:30:00' },
    ];
    const db = makeMockDb(rows);
    const result = await generateMorningSummary({ DB: db as any });
    expect(result).toContain('오늘 일정 2개가 있습니다:');
    expect(result).toContain('1.');
    expect(result).toContain('아침 회의');
    expect(result).toContain('2.');
    expect(result).toContain('점심 약속');
  });

  test('start_at이 없으면 시간 없이 제목만', async () => {
    const rows = [{ id: 1, title: '종일 일정', start_at: null }];
    const db = makeMockDb(rows);
    const result = await generateMorningSummary({ DB: db as any });
    expect(result).toContain('종일 일정');
    expect(result).toContain('1.');
  });
});
