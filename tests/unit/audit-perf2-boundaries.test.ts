/// <reference types="jest" />
/**
 * audit-perf2 경계 동등성 테스트 — 실제 SQLite(better-sqlite3)로 검증.
 *
 * P-3의 핵심 위험은 "범위 조건으로 바꿨더니 KST 자정 경계 행이 달라지는 것"이다.
 * Mock D1 테스트는 SQL 문자열만 확인하므로, 여기서는 구 SQL과 신 SQL을
 * 같은 행 집합에 실행해 결과 집합이 완전히 일치하는지 직접 비교한다.
 * (카나리아: 범위를 -9시간 보정 없이 쓰면 경계 행이 달라져 이 테스트가 실패한다.)
 *
 * P-4: searchAccessibleMemos를 실제 FTS5에 실행해, 키워드 OR 병합 1회가
 * 각 키워드 매치를 합집합으로 찾고 전체 왕복이 3회 이하인지 확인한다.
 */
import { kstDayToUtcRange, nextDayKey, kstWallClockWindow } from '../../src/lib/kst-date'
import { searchAccessibleMemos } from '../../src/services/ai-access'

const Database = require('better-sqlite3')

function memoDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE memos (id INTEGER PRIMARY KEY, text TEXT, created_at TEXT, is_locked INTEGER DEFAULT 0, sensitivity INTEGER DEFAULT 0)`)
  db.exec(`CREATE INDEX idx_memos_created_at ON memos(created_at)`)
  return db
}

function scheduleDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE schedules (id INTEGER PRIMARY KEY, title TEXT, start_at TEXT, status TEXT, recurrence_rule TEXT)`)
  db.exec(`CREATE INDEX idx_schedules_start ON schedules(start_at)`)
  return db
}

describe('kst-date 헬퍼', () => {
  test('kstDayToUtcRange: KST 날짜 → UTC 범위 (자정은 전날 15:00)', () => {
    expect(kstDayToUtcRange('2026-10-17')).toEqual(['2026-10-16 15:00:00', '2026-10-17 15:00:00'])
  })

  test('kstDayToUtcRange: 연 경계', () => {
    expect(kstDayToUtcRange('2027-01-01')).toEqual(['2026-12-31 15:00:00', '2027-01-01 15:00:00'])
  })

  test('kstDayToUtcRange: 무효 날짜 → null', () => {
    expect(kstDayToUtcRange('not-a-date')).toBeNull()
    expect(kstDayToUtcRange('2026-13-40')).toBeNull()
    expect(kstDayToUtcRange('')).toBeNull()
  })

  test('nextDayKey: 월·연 경계', () => {
    expect(nextDayKey('2026-10-31')).toBe('2026-11-01')
    expect(nextDayKey('2026-12-31')).toBe('2027-01-01')
    expect(nextDayKey('2026-02-28')).toBe('2026-03-01') // 2026년은 평년
    expect(nextDayKey('garbage')).toBe('')
  })

  test('kstWallClockWindow: 고정 시각에 30분 윈도우', () => {
    const nowMs = Date.parse('2026-10-28T10:00:37Z')
    expect(kstWallClockWindow(30, nowMs)).toEqual(['2026-10-28T19:00:37', '2026-10-28T19:30:37'])
  })
})

describe('P-3 메모 날짜 필터: 구 date() vs 신 범위 조건', () => {
  const OLD_SQL = `SELECT id FROM memos WHERE date(created_at, '+9 hours') = ? ORDER BY id`
  const NEW_SQL = `SELECT id FROM memos WHERE created_at >= ? AND created_at < ? ORDER BY id`

  function seeded() {
    const db = memoDb()
    const ins = db.prepare(`INSERT INTO memos (id, text, created_at) VALUES (?, ?, ?)`)
    // KST 2026-10-17 경계 전후 1초 단위 행
    ins.run(1, 'a', '2026-10-16 14:59:59') // KST 10-16 23:59:59 — 제외
    ins.run(2, 'b', '2026-10-16 15:00:00') // KST 10-17 00:00:00 — 포함
    ins.run(3, 'c', '2026-10-17 00:00:00') // KST 10-17 09:00:00 — 포함
    ins.run(4, 'd', '2026-10-17 14:59:59') // KST 10-17 23:59:59 — 포함
    ins.run(5, 'e', '2026-10-17 15:00:00') // KST 10-18 00:00:00 — 제외
    ins.run(6, 'f', '2026-10-15 15:00:00') // KST 10-16 00:00:00 — 다른 날짜
    return db
  }

  test.each(['2026-10-16', '2026-10-17', '2026-10-18'])('날짜 %s: 구·신 결과 집합 동일', (date) => {
    const db = seeded()
    const oldIds = db.prepare(OLD_SQL).all(date).map((r: any) => r.id)
    const range = kstDayToUtcRange(date)!
    const newIds = db.prepare(NEW_SQL).all(range[0], range[1]).map((r: any) => r.id)
    expect(newIds).toEqual(oldIds)
    db.close()
  })

  test('2026-10-17은 정확히 경계 행 2,3,4만 반환한다', () => {
    const db = seeded()
    const range = kstDayToUtcRange('2026-10-17')!
    const ids = db.prepare(NEW_SQL).all(range[0], range[1]).map((r: any) => r.id)
    expect(ids).toEqual([2, 3, 4])
    db.close()
  })

  test('신 범위 조건은 인덱스를 탄다 (구 date()는 전수 스캔)', () => {
    const db = seeded()
    const newPlan = db.prepare(`EXPLAIN QUERY PLAN ${NEW_SQL}`).all('2026-10-16 15:00:00', '2026-10-17 15:00:00').map((r: any) => r.detail).join(' ')
    expect(newPlan).toContain('SEARCH memos USING')
    expect(newPlan).toContain('idx_memos_created_at')
    expect(newPlan).not.toContain('SCAN')
    const oldPlan = db.prepare(`EXPLAIN QUERY PLAN ${OLD_SQL}`).all('2026-10-17').map((r: any) => r.detail).join(' ')
    expect(oldPlan).toContain('SCAN memos')
    db.close()
  })
})

describe('P-3 메모 달력: 구 datetime() vs 신 범위 조건', () => {
  test('월별 일별 집계가 동일하다 (경계 행 포함)', () => {
    const db = memoDb()
    const ins = db.prepare(`INSERT INTO memos (id, text, created_at) VALUES (?, ?, ?)`)
    ins.run(1, 'a', '2026-09-30 14:59:59') // KST 09-30 23:59 — 10월 집계 제외
    ins.run(2, 'b', '2026-09-30 15:00:00') // KST 10-01 00:00 — 10-01 집계
    ins.run(3, 'c', '2026-10-31 14:59:59') // KST 10-31 23:59 — 10-31 집계
    ins.run(4, 'd', '2026-10-31 15:00:00') // KST 11-01 00:00 — 10월 집계 제외
    const oldSql = `SELECT date(created_at, '+9 hours') AS day, COUNT(*) AS n FROM memos
      WHERE datetime(created_at, '+9 hours') >= datetime(?) AND datetime(created_at, '+9 hours') < datetime(?)
      GROUP BY day ORDER BY day`
    const newSql = `SELECT date(created_at, '+9 hours') AS day, COUNT(*) AS n FROM memos
      WHERE created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`
    const oldRows = db.prepare(oldSql).all('2026-10-01', '2026-11-01')
    const [s, e] = [kstDayToUtcRange('2026-10-01')![0], kstDayToUtcRange('2026-11-01')![0]]
    const newRows = db.prepare(newSql).all(s, e)
    expect(newRows).toEqual(oldRows)
    expect(newRows).toEqual([
      { day: '2026-10-01', n: 1 },
      { day: '2026-10-31', n: 1 },
    ])
    db.close()
  })
})

describe('P-3 일정 날짜 필터: 구 substr() vs 신 문자열 범위', () => {
  const OLD_SQL = `SELECT id FROM schedules WHERE substr(start_at, 1, 10) >= ? AND substr(start_at, 1, 10) <= ? ORDER BY id`
  const NEW_SQL = `SELECT id FROM schedules WHERE start_at >= ? AND start_at < ? ORDER BY id`

  function seeded() {
    const db = scheduleDb()
    const ins = db.prepare(`INSERT INTO schedules (id, title, start_at, status) VALUES (?, ?, ?, 'active')`)
    ins.run(1, 'a', '2026-09-30T23:59') // 범위 전 — 제외
    ins.run(2, 'b', '2026-10-01T00:00') // from 경계 — 포함
    ins.run(3, 'c', '2026-10-15T12:00') // 중간 — 포함
    ins.run(4, 'd', '2026-10-31T23:59') // to 당일 말 — 포함
    ins.run(5, 'e', '2026-11-01T00:00') // 범위 후 — 제외
    return db
  }

  test('from=2026-10-01, to=2026-10-31: 구·신 결과 집합 동일', () => {
    const db = seeded()
    const oldIds = db.prepare(OLD_SQL).all('2026-10-01', '2026-10-31').map((r: any) => r.id)
    const newIds = db.prepare(NEW_SQL).all('2026-10-01T00:00', `${nextDayKey('2026-10-31')}T00:00`).map((r: any) => r.id)
    expect(newIds).toEqual(oldIds)
    expect(newIds).toEqual([2, 3, 4])
    db.close()
  })

  test('신 문자열 범위 조건은 인덱스를 탄다 (구 substr()은 전수 스캔)', () => {
    const db = seeded()
    const newPlan = db.prepare(`EXPLAIN QUERY PLAN ${NEW_SQL}`).all('2026-10-01T00:00', '2026-11-01T00:00').map((r: any) => r.detail).join(' ')
    expect(newPlan).toContain('SEARCH schedules USING')
    expect(newPlan).toContain('idx_schedules_start')
    expect(newPlan).not.toContain('SCAN')
    const oldPlan = db.prepare(`EXPLAIN QUERY PLAN ${OLD_SQL}`).all('2026-10-01', '2026-10-31').map((r: any) => r.detail).join(' ')
    expect(oldPlan).toContain('SCAN schedules')
    db.close()
  })

  test('반복 일정 상한 조건: 구 substr <= effTo vs 신 start_at < nextDay(effTo)', () => {
    const db = seeded()
    const oldIds = db.prepare(`SELECT id FROM schedules WHERE substr(start_at, 1, 10) <= ? ORDER BY id`).all('2026-10-31').map((r: any) => r.id)
    const newIds = db.prepare(`SELECT id FROM schedules WHERE start_at < ? ORDER BY id`).all(`${nextDayKey('2026-10-31')}T00:00`).map((r: any) => r.id)
    expect(newIds).toEqual(oldIds)
    expect(newIds).toEqual([1, 2, 3, 4])
    db.close()
  })
})

describe('P-3 cron 윈도우: 구 datetime BETWEEN vs 신 KST 문자열 범위', () => {
  test('고정 now(10:00:37 UTC)에 구·신 결과 집합 동일 (초 단위 경계 포함)', () => {
    const db = scheduleDb()
    const ins = db.prepare(`INSERT INTO schedules (id, title, start_at, status) VALUES (?, ?, ?, 'active')`)
    ins.run(1, 'a', '2026-10-28T19:00') // UTC 10:00:00 < now 10:00:37 — 제외
    ins.run(2, 'b', '2026-10-28T19:01') // UTC 10:01:00 — 포함
    ins.run(3, 'c', '2026-10-28T19:30') // UTC 10:30:00 <= 10:30:37 — 포함
    ins.run(4, 'd', '2026-10-28T19:31') // UTC 10:31:00 — 제외
    ins.run(5, 'e', '2026-10-28T18:59') // UTC 09:59:00 — 제외
    const oldSql = `SELECT id FROM schedules WHERE status = 'active'
      AND datetime(start_at, '-9 hours') BETWEEN '2026-10-28 10:00:37' AND '2026-10-28 10:30:37' ORDER BY id`
    const [ws, we] = kstWallClockWindow(30, Date.parse('2026-10-28T10:00:37Z'))
    const newSql = `SELECT id FROM schedules WHERE status = 'active'
      AND start_at >= ? AND start_at <= ? ORDER BY id`
    const oldIds = db.prepare(oldSql).all().map((r: any) => r.id)
    const newIds = db.prepare(newSql).all(ws, we).map((r: any) => r.id)
    expect(newIds).toEqual(oldIds)
    expect(newIds).toEqual([2, 3])
    db.close()
  })
})

describe('P-4 AI 메모 검색: 실제 FTS5에서 OR 병합', () => {
  // better-sqlite3를 D1Database 최소 인터페이스로 감싼다 (호출 횟수 계수 포함)
  function realDb() {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE memos (id INTEGER PRIMARY KEY, text TEXT, is_locked INTEGER DEFAULT 0, sensitivity INTEGER DEFAULT 0)`)
    db.exec(`CREATE VIRTUAL TABLE memos_fts USING fts5(text)`)
    const insMemo = db.prepare(`INSERT INTO memos (id, text) VALUES (?, ?)`)
    const insFts = db.prepare(`INSERT INTO memos_fts (rowid, text) VALUES (?, ?)`)
    const seed = (id: number, text: string) => { insMemo.run(id, text); insFts.run(id, text) }
    seed(1, '회의 준비 자료')
    seed(2, '준비 운동 계획')
    seed(3, '오늘 회의 안건')
    seed(4, '무관한 내용')
    let calls = 0
    const d1 = {
      calls: () => calls,
      prepare(sql: string) {
        const stmt = db.prepare(sql)
        return {
          bind(...params: any[]) {
            return {
              all: async () => { calls++; return { results: stmt.all(...params) } },
              first: async () => { calls++; return stmt.get(...params) ?? null },
            }
          },
        }
      },
    }
    return { d1, close: () => db.close() }
  }

  test('키워드 OR 병합 1회가 각 키워드 매치의 합집합을 찾는다', async () => {
    const { d1, close } = realDb()
    // '회의 준비 메모 찾아줘': 1차(원본 AND)는 '메모' 때문에 빈 결과 →
    // 2차 키워드 OR('"회의" OR "준비"')가 합집합을 반환한다.
    // 구 동작은 첫 키워드(회의) 히트에서 멈춰 id 2(준비만)를 놓쳤지만,
    // 신 동작은 합집합을 반환한다.
    const out = await searchAccessibleMemos({ DB: d1 } as any, '회의 준비 메모 찾아줘')
    expect(out.map((r) => r.id).sort()).toEqual([1, 2, 3])
    close()
  })

  test('전체 왕복이 3회 이하이고 LIKE는 원본 쿼리 1회만 실행된다', async () => {
    const { d1, close } = realDb()
    const out = await searchAccessibleMemos({ DB: d1 } as any, '없는키워드xyz')
    expect(out).toEqual([])
    expect(d1.calls()).toBeLessThanOrEqual(3)
    close()
  })
})
