/**
 * RRULE 반복展開 유닛 테스트
 * @jest-environment node
 *
 * src/services/recurrence.ts를 esbuild로 번들한 뒤 테스트한다.
 */
const { execSync } = require('child_process');
const path = require('path');

const BUNDLE = path.join(__dirname, 'recurrence-bundle.cjs');
execSync(`npx esbuild src/services/recurrence.ts --bundle --format=cjs --platform=node --outfile=${BUNDLE}`, { cwd: __dirname, stdio: 'pipe' });

const { parseRRule, expandRecurrence, singleOccurrence } = require('./recurrence-bundle.cjs');

function sched(over = {}) {
  return {
    id: 1,
    title: '테스트',
    description: '',
    location: '',
    start_at: '2026-10-09T09:00',
    end_at: '2026-10-09T10:00',
    timezone: 'Asia/Seoul',
    recurrence_rule: null,
    status: 'active',
    created_at: '2026-10-09T00:00:00',
    updated_at: '2026-10-09T00:00:00',
    ...over,
  };
}

describe('parseRRule', () => {
  test('기본 DAILY', () => {
    expect(parseRRule('FREQ=DAILY')).toEqual({ freq: 'DAILY', byday: null, count: null, until: null });
  });
  test('WEEKLY + BYDAY', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toEqual({ freq: 'WEEKLY', byday: [1, 3, 5], count: null, until: null });
  });
  test('소문자/공백 허용', () => {
    const r = parseRRule('freq=weekly; byday=mo');
    expect(r && r.freq).toBe('WEEKLY');
    expect(r && r.byday).toEqual([1]);
  });
  test('COUNT / UNTIL', () => {
    const r = parseRRule('FREQ=DAILY;COUNT=5;UNTIL=20261031');
    expect(r && r.count).toBe(5);
    expect(r && r.until).toBe('2026-10-31');
  });
  test('UNTIL 시간형식', () => {
    const r = parseRRule('FREQ=DAILY;UNTIL=20261031T235959Z');
    expect(r && r.until).toBe('2026-10-31');
  });
  test('미지원 FREQ → null', () => {
    expect(parseRRule('FREQ=YEARLY')).toBe(null);
    expect(parseRRule('FREQ=HOURLY')).toBe(null);
  });
  test('빈/이상한 입력 → null', () => {
    expect(parseRRule(null)).toBe(null);
    expect(parseRRule('')).toBe(null);
    expect(parseRRule('hello')).toBe(null);
  });
  test('잘못된 BYDAY 무시', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=XX');
    expect(r && r.byday).toBe(null);
  });
  test('잘못된 COUNT 무시', () => {
    const r = parseRRule('FREQ=DAILY;COUNT=abc');
    expect(r && r.count).toBe(null);
    const r2 = parseRRule('FREQ=DAILY;COUNT=0');
    expect(r2 && r2.count).toBe(null);
  });
});

describe('expandRecurrence — 단건', () => {
  test('RRULE 없으면 원본 1건', () => {
    const out = expandRecurrence(sched(), '2026-10-01', '2026-10-31');
    expect(out).toHaveLength(1);
    expect(out[0].is_recurring).toBe(false);
    expect(out[0].original_id).toBe(1);
    expect(out[0].occurrence_date).toBe('2026-10-09');
    expect(out[0].start_at).toBe('2026-10-09T09:00');
  });
  test('파싱 실패 RRULE도 원본 1건', () => {
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=YEARLY' }), '2026-10-01', '2026-10-31');
    expect(out).toHaveLength(1);
    expect(out[0].is_recurring).toBe(false);
  });
  test('singleOccurrence 형태', () => {
    const o = singleOccurrence(sched());
    expect(o.is_recurring).toBe(false);
    expect(o.original_id).toBe(1);
    expect(o.occurrence_date).toBe('2026-10-09');
  });
});

describe('expandRecurrence — DAILY', () => {
  const daily = () => sched({ id: 7, recurrence_rule: 'FREQ=DAILY', start_at: '2026-10-09T09:00', end_at: '2026-10-09T10:30' });
  test('범위 내 매일 발생', () => {
    const out = expandRecurrence(daily(), '2026-10-09', '2026-10-11');
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
    expect(out.every((o) => o.is_recurring)).toBe(true);
    expect(out.every((o) => o.original_id === 7)).toBe(true);
  });
  test('시간 유지 + 종료일 하루짜리', () => {
    const out = expandRecurrence(daily(), '2026-10-10', '2026-10-10');
    expect(out).toHaveLength(1);
    expect(out[0].start_at).toBe('2026-10-10T09:00');
    expect(out[0].end_at).toBe('2026-10-10T10:30');
  });
  test('범위 밖은 제외', () => {
    const out = expandRecurrence(daily(), '2026-10-20', '2026-10-22');
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });
  test('COUNT 제한', () => {
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=DAILY;COUNT=3', start_at: '2026-10-09T09:00' }), '2026-10-01', '2026-12-31');
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
  });
  test('UNTIL 제한 (inclusive)', () => {
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=DAILY;UNTIL=20261010', start_at: '2026-10-09T09:00' }), '2026-10-01', '2026-12-31');
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-09', '2026-10-10']);
  });
  test('COUNT는 범위 밖 발생도 셈', () => {
    // COUNT=2 → 10/9, 10/10만 발생. 조회가 10/10부터여도 10/09는 포함 안 됨
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=DAILY;COUNT=2', start_at: '2026-10-09T09:00' }), '2026-10-10', '2026-12-31');
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-10']);
  });
  test('여러 날짜리 일정 duration 유지', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=DAILY', start_at: '2026-10-09T09:00', end_at: '2026-10-11T18:00' }),
      '2026-10-10', '2026-10-10'
    );
    expect(out[0].start_at).toBe('2026-10-10T09:00');
    expect(out[0].end_at).toBe('2026-10-12T18:00');
  });
});

describe('expandRecurrence — WEEKLY', () => {
  test('BYDAY 월/수/금', () => {
    // 2026-10-09는 금요일
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', start_at: '2026-10-09T09:00' }),
      '2026-10-09', '2026-10-18'
    );
    expect(out.map((o) => o.occurrence_date)).toEqual([
      '2026-10-09', // 금
      '2026-10-12', // 월
      '2026-10-14', // 수
      '2026-10-16', // 금
    ]);
  });
  test('BYDAY 없으면 시작 요일 반복', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=WEEKLY', start_at: '2026-10-09T09:00' }), // 금
      '2026-10-09', '2026-10-31'
    );
    expect(out.map((o) => o.occurrence_date)).toEqual([
      '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30',
    ]);
  });
  test('DTSTART 요일이 BYDAY에 없어도 첫 발생은 규칙대로 (10/9 금 제외)', () => {
    // 시작일이 목요일인데 BYDAY=MO → 첫 발생은 다음 월요일
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', start_at: '2026-10-08T09:00' }), // 10/8 목
      '2026-10-01', '2026-10-20'
    );
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-12', '2026-10-19']);
  });
  test('WEEKLY + COUNT', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=2', start_at: '2026-10-06T09:00' }), // 10/6 화
      '2026-10-01', '2026-11-30'
    );
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-06', '2026-10-13']);
  });
});

describe('expandRecurrence — MONTHLY', () => {
  test('매월 같은 날짜', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=MONTHLY', start_at: '2026-10-15T09:00' }),
      '2026-10-01', '2027-01-31'
    );
    expect(out.map((o) => o.occurrence_date)).toEqual([
      '2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15',
    ]);
  });
  test('31일 시작 → 없는 달 스킵', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=MONTHLY', start_at: '2026-10-31T09:00' }),
      '2026-10-01', '2027-03-31'
    );
    // 11월(30일), 2027-02월(28일) 스킵
    expect(out.map((o) => o.occurrence_date)).toEqual([
      '2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31',
    ]);
  });
  test('MONTHLY + UNTIL', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=MONTHLY;UNTIL=20261201', start_at: '2026-10-15T09:00' }),
      '2026-10-01', '2027-06-30'
    );
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-15', '2026-11-15']);
  });
});

describe('expandRecurrence — 엣지 케이스', () => {
  test('잘못된 범위는 원본 1건', () => {
    const s = sched({ recurrence_rule: 'FREQ=DAILY' });
    expect(expandRecurrence(s, 'xxx', '2026-10-31')).toHaveLength(1);
    expect(expandRecurrence(s, '2026-11-01', '2026-10-01')).toHaveLength(1);
  });
  test('잘못된 start_at은 원본 1건', () => {
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=DAILY', start_at: 'not-a-date' }), '2026-10-01', '2026-10-31');
    expect(out).toHaveLength(1);
  });
  test('날짜만 있는 start_at', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=DAILY', start_at: '2026-10-09', end_at: null }),
      '2026-10-09', '2026-10-10'
    );
    expect(out.map((o) => o.start_at)).toEqual(['2026-10-09', '2026-10-10']);
    expect(out[0].end_at).toBe(null);
  });
  test('종료일 없는 일정', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', start_at: '2026-10-12T09:00', end_at: null }),
      '2026-10-12', '2026-10-12'
    );
    expect(out).toHaveLength(1);
    expect(out[0].end_at).toBe(null);
  });
  test('from 이전 시작 + UNTIL 과거 → 빈 배열', () => {
    const out = expandRecurrence(
      sched({ recurrence_rule: 'FREQ=DAILY;UNTIL=20260101', start_at: '2025-12-01T09:00' }),
      '2026-10-01', '2026-10-31'
    );
    expect(out).toHaveLength(0);
  });
  test('무한 반복도 안전 상한 내에서 종료', () => {
    const t0 = Date.now();
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=DAILY', start_at: '2026-10-09T09:00' }), '2026-10-09', '2030-12-31');
    expect(Date.now() - t0).toBeLessThan(2000);
    // 약 3년 상한
    expect(out.length).toBeLessThan(1200);
    expect(out.length).toBeGreaterThan(1000);
  });
});
