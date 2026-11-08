/**
 * src/modules/briefing/routes.ts 100% 커버리지 단위 테스트
 * - GET /today 단일 라우트: 오늘 일정 + 미완료 할일 + 중요 메모 + AI 기억
 * - D1 Mock (prepare/bind/all) + Hono app.request()로 HTTP 시뮬레이션
 * - Intl.DateTimeFormat 모킹으로 todayStr의 `?.value ?? ''` 폴백 브랜치 커버
 * - 메모 목록의 `?? []`, `?.length ?? 0` 폴백은 results=null 큐잉으로 커버
 * - ai_memory_v2 부재는 Error 큐잉으로 catch 브랜치 커버
 *
 * 도달 불가 브랜치 (공개 표면 기준):
 * - todayStr/timezone, todayRange/timezone의 기본 파라미터(= 'Asia/Seoul'):
 *   모듈 내부의 유일한 호출 2곳(오늘 브리핑 핸들러)이 항상 'Asia/Seoul'을
 *   명시 전달하므로 기본값 분기는 HTTP 경로에서 절대 실행되지 않음.
 *   grep: "todayStr(" -> todayStr(timezone) 호출 1곳, todayRange(timezone) 호출 1곳.
 */
/// <reference types="jest" />
import { Hono } from 'hono'

import { briefingApp } from '../../src/modules/briefing/routes'

// ---------------- Mock D1 (tests/unit/memo-routes.test.ts 패턴) ----------------
class MockDb {
  allQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []

  prepare(sql: string) {
    const db = this
    const exec = (params: any[]) => {
      db.calls.push({ sql, params })
      return {
        all: async () => {
          const v = db.allQueue.shift()
          if (v === undefined) return { results: [] }
          if (v instanceof Error) throw v
          return { results: v }
        },
      }
    }
    return {
      bind: (...params: any[]) => exec(params),
      all: () => exec([]).all(),
    }
  }
}

function makeApp(db?: MockDb) {
  const d = db ?? new MockDb()
  const app = new Hono()
  app.route('/a', briefingApp)
  const env: any = { DB: d }
  const get = (path: string) => app.request('/a' + path, { method: 'GET' }, env)
  return { db: d, get }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

// 테스트 독립 계산: KST 오늘 날짜 (소스와 동일한 Intl 프리미티브 사용)
function kstToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year')!.value
  const m = parts.find((p) => p.type === 'month')!.value
  const d = parts.find((p) => p.type === 'day')!.value
  return `${y}-${m}-${d}`
}

function nextDayStr(today: string): string {
  const [y, m, d] = today.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const ny = next.getUTCFullYear()
  const nm = String(next.getUTCMonth() + 1).padStart(2, '0')
  const nd = String(next.getUTCDate()).padStart(2, '0')
  return `${ny}-${nm}-${nd}`
}

const scheduleRow = (id: number) => ({
  id,
  title: `일정${id}`,
  start_at: '2026-10-17T09:00:00',
  end_at: '2026-10-17T10:00:00',
  location: '회의실',
})

// ---------------- GET /today ----------------
describe('GET /today', () => {
  test('정상: 일정·할일·메모·기억 반환 + date/timezone/counts', async () => {
    const { get, db } = makeApp()
    db.allQueue.push([scheduleRow(1), scheduleRow(2)])
    db.allQueue.push([{ id: 1, title: '할일', due_at: null, priority: 3 }])
    db.allQueue.push([{ id: 5, text: '메모 내용' }])
    db.allQueue.push([{ id: 9, content: '기억 내용' }])

    const res = await get('/today')
    const j = await body(res)
    const today = kstToday()
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.date).toBe(today)
    expect(j.timezone).toBe('Asia/Seoul')
    expect(j.schedules).toHaveLength(2)
    expect(j.schedules[0].title).toBe('일정1')
    expect(j.todos).toHaveLength(1)
    expect(j.memos).toHaveLength(1)
    expect(j.memories).toHaveLength(1)
    expect(j.counts).toEqual({ schedules: 2, todos: 1, memos: 1, memories: 1 })
  })

  test('SQL 검증: 일정 조회는 오늘 00:00~내일 00:00 범위로 바인딩', async () => {
    const { get, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push([])
    const res = await get('/today')
    expect(res.status).toBe(200)
    const call = db.calls[0]
    expect(call.sql).toContain('FROM schedules')
    expect(call.sql).toContain("status = 'active'")
    const today = kstToday()
    expect(call.params[0]).toBe(`${today}T00:00:00`)
    expect(call.params[1]).toBe(`${nextDayStr(today)}T00:00:00`)
  })

  test('SQL 검증: 할일/메모/기억 쿼리 + LIMIT', async () => {
    const { get, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push([])
    await get('/today')
    expect(db.calls[1].sql).toContain('FROM todos')
    expect(db.calls[1].sql).toContain('LIMIT 10')
    expect(db.calls[1].params).toHaveLength(0)
    expect(db.calls[2].sql).toContain('FROM memos')
    expect(db.calls[2].sql).toContain('sensitivity < 2')
    expect(db.calls[2].sql).toContain('LIMIT 5')
    expect(db.calls[3].sql).toContain('FROM ai_memory_v2')
    expect(db.calls[3].sql).toContain('allow_ai_use = 1')
    expect(db.calls[3].sql).toContain('LIMIT 5')
  })

  test('빈 결과 → 빈 배열 + counts 0', async () => {
    const { get } = makeApp()
    const res = await get('/today')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.schedules).toEqual([])
    expect(j.todos).toEqual([])
    expect(j.memos).toEqual([])
    expect(j.memories).toEqual([])
    expect(j.counts).toEqual({ schedules: 0, todos: 0, memos: 0, memories: 0 })
  })

  test('results null → ?? [] / ?.length ?? 0 폴백', async () => {
    const { get, db } = makeApp()
    db.allQueue.push(null) // schedules: { results: null }
    db.allQueue.push(null) // todos
    db.allQueue.push(null) // memos
    db.allQueue.push(null) // memories: memResult.results ?? []
    const res = await get('/today')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.schedules).toEqual([])
    expect(j.todos).toEqual([])
    expect(j.memos).toEqual([])
    expect(j.memories).toEqual([])
    expect(j.counts).toEqual({ schedules: 0, todos: 0, memos: 0, memories: 0 })
  })

  test('ai_memory_v2 테이블 없음(Error) → catch → memories []', async () => {
    const { get, db } = makeApp()
    db.allQueue.push([scheduleRow(1)])
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push(new Error('no such table: ai_memory_v2'))
    const res = await get('/today')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.schedules).toHaveLength(1)
    expect(j.memories).toEqual([])
    expect(j.counts.memories).toBe(0)
    expect(j.counts.schedules).toBe(1)
  })

  test('todayStr: Intl parts 전부 누락 → ?? "" 폴백 브랜치', async () => {
    // formatToParts가 빈 배열 반환: year/month/day의 find()?.value ?? '' 전부 실행
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      (() => ({
        formatToParts: () => [],
      })) as any
    )
    try {
      const { get, db } = makeApp()
      db.allQueue.push([])
      db.allQueue.push([])
      db.allQueue.push([])
      db.allQueue.push([])
      const res = await get('/today')
      const j = await body(res)
      expect(res.status).toBe(200)
      expect(j.date).toBe('--')
      // todayRange는 '--' 파싱 후에도 예외 없이 동작해야 함
      expect(j.counts).toEqual({ schedules: 0, todos: 0, memos: 0, memories: 0 })
    } finally {
      spy.mockRestore()
    }
  })

  test('todayStr: 정상 parts → ?.value 정상 브랜치 + 모킹 해제 확인', async () => {
    const { get, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push([])
    db.allQueue.push([])
    const res = await get('/today')
    const j = await body(res)
    expect(j.date).toBe(kstToday())
    expect(j.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
