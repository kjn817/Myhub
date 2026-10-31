/**
 * src/modules/schedule/routes.ts 100% 커버리지 단위 테스트
 * - D1 Mock (prepare/bind/first/all/run)
 * - Hono app.request()로 HTTP 시뮬레이션
 * - 실제 recurrence 함수 사용 (순수 함수, 부작용 없음)
 * - events.emit은 spy로 검증 (리스너 없으면 no-op)
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import { scheduleApp } from '../../src/modules/schedule/routes'
import * as events from '../../src/events'

// ---------------- Mock D1 ----------------
class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []

  prepare(sql: string) {
    const db = this
    const exec = (params: any[]) => {
      db.calls.push({ sql, params })
      return {
        first: async () => {
          const v = db.firstQueue.shift()
          if (v === undefined) return null
          if (v instanceof Error) throw v
          return v
        },
        all: async () => {
          const v = db.allQueue.shift()
          if (v === undefined) return { results: [] }
          if (v instanceof Error) throw v
          return { results: v }
        },
        run: async () => {
          const v = db.runQueue.shift()
          if (v === undefined) return { meta: { last_row_id: 7, changes: 1 } }
          if (v instanceof Error) throw v
          return v
        },
      }
    }
    return {
      bind: (...params: any[]) => exec(params),
      first: () => exec([]).first(),
      all: () => exec([]).all(),
      run: () => exec([]).run(),
    }
  }
}

function row(over: Record<string, any> = {}) {
  return {
    id: 1,
    title: '회의',
    description: '',
    location: '',
    start_at: '2026-10-20T10:00',
    end_at: null,
    timezone: 'Asia/Seoul',
    recurrence_rule: null,
    status: 'active',
    created_at: '2026-10-17',
    updated_at: '2026-10-17',
    ...over,
  }
}

function makeApp(db?: MockDb) {
  const d = db ?? new MockDb()
  const app = new Hono()
  app.route('/s', scheduleApp)
  const env: any = { DB: d }
  const req = (path: string, init?: RequestInit) => app.request('/s' + path, init, env)
  const json = (path: string, method: string, body?: any, rawBody?: string) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    })
  return { app, db: d, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

let emitSpy: jest.SpyInstance
beforeEach(() => {
  emitSpy = jest.spyOn(events, 'emit').mockResolvedValue(undefined)
})
afterEach(() => {
  emitSpy.mockRestore()
})

// ---------------- GET /list ----------------
describe('GET /list', () => {
  test('기본: 쿼리 없음 → 단건+반복 조회 후 병합 정렬', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([row({ id: 2, start_at: '2026-10-22T09:00' })]) // singles
    db.allQueue.push([row({ id: 1, start_at: '2026-10-20T10:00' })]) // recurring (규칙 없음 → 1건)
    const res = await json('/list', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.schedules).toHaveLength(2)
    // 정렬 확인 (start_at 오름차순)
    expect(j.schedules[0].id).toBe(1)
    expect(j.schedules[1].id).toBe(2)
    expect(j.schedules[0].is_recurring).toBe(false)
  })

  test('from/to 유효 → 날짜 필터가 SQL에 포함', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    const res = await json('/list?from=2026-10-01&to=2026-10-31', 'GET')
    expect(res.status).toBe(200)
    const singlesSql = db.calls[0].sql
    // P-3: substr() 대신 start_at 문자열 범위 비교 (인덱스 사용)
    expect(singlesSql).toContain('start_at >= ?')
    expect(singlesSql).toContain('start_at < ?')
    expect(singlesSql).not.toContain('substr(start_at')
    expect(db.calls[0].params).toContain('2026-10-01T00:00')
    // to 당일 23:59까지 포함 → 다음 날 00:00 미만
    expect(db.calls[0].params).toContain('2026-11-01T00:00')
    // §6 #7: 반복 일정 조회에 LIMIT이 붙는다
    expect(db.calls[1].sql).toContain('LIMIT ?')
    expect(db.calls[1].params[db.calls[1].params.length - 1]).toBe(1000)
  })

  test('status=active → 양쪽 쿼리에 status 필터', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    const res = await json('/list?status=active', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].sql).toContain('status = ?')
    expect(db.calls[0].params).toContain('active')
    expect(db.calls[1].sql).toContain('status = ?')
    expect(db.calls[1].params).toContain('active')
  })

  test('status 무효값 → 필터 없음', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    const res = await json('/list?status=bogus', 'GET')
    expect(res.status).toBe(200)
    expect(db.calls[0].sql).not.toContain('status = ?')
    expect(db.calls[1].sql).not.toContain('status = ?')
  })

  test('limit 클램프: 1000 → 500', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    await json('/list?limit=1000', 'GET')
    const params = db.calls[0].params
    expect(params[params.length - 1]).toBe(500)
  })

  test('limit 무효값 → 100', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    await json('/list?limit=abc', 'GET')
    const params = db.calls[0].params
    expect(params[params.length - 1]).toBe(100)
  })

  test('limit=0 → 100 (0 || 100)', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    await json('/list?limit=0', 'GET')
    const params = db.calls[0].params
    expect(params[params.length - 1]).toBe(100)
  })

  test('반복 일정展開: DAILY 규칙이 기간 내 발생으로 펼쳐짐', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([]) // singles 없음
    db.allQueue.push([
      row({ id: 9, start_at: '2026-10-20T09:00', recurrence_rule: 'FREQ=DAILY;COUNT=3' }),
    ])
    const res = await json('/list?from=2026-10-20&to=2026-10-22', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.schedules).toHaveLength(3)
    expect(j.schedules[0].is_recurring).toBe(true)
    expect(j.schedules[0].original_id).toBe(9)
    expect(j.schedules[0].occurrence_date).toBe('2026-10-20')
    expect(j.schedules[2].occurrence_date).toBe('2026-10-22')
  })

  test('to 무효 → effTo는 effFrom+90일, 반복 쿼리 파라미터에 반영', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    await json('/list?from=2026-10-01&to=xyz', 'GET')
    // 반복 쿼리의 첫 파라미터가 effTo+1일 00:00 (P-3: start_at < nextDay(effTo))
    const d = new Date('2026-10-01T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 90)
    const effTo = d.toISOString().slice(0, 10)
    const nd = new Date(`${effTo}T00:00:00Z`)
    nd.setUTCDate(nd.getUTCDate() + 1)
    const expected = nd.toISOString().slice(0, 10) + 'T00:00'
    expect(db.calls[1].params[0]).toBe(expected)
  })

  test('from 무효 → effFrom은 오늘', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([])
    db.allQueue.push([])
    await json('/list?to=2026-12-31', 'GET')
    const today = new Date().toISOString().slice(0, 10)
    // 반복 쿼리: start_at < nextDay(effTo) (P-3: effTo=2026-12-31 → 2027-01-01T00:00)
    expect(db.calls[1].params[0]).toBe('2027-01-01T00:00')
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('limit 슬라이스: 결과 초과 시 잘림', async () => {
    const { json, db } = makeApp()
    const many = Array.from({ length: 5 }, (_, i) =>
      row({ id: i + 1, start_at: `2026-10-2${i}T10:00` })
    )
    db.allQueue.push(many)
    db.allQueue.push([])
    const res = await json('/list?limit=3', 'GET')
    const j = await body(res)
    expect(j.schedules).toHaveLength(3)
  })

  test('정렬: 동일 start_at (동등 분기)', async () => {
    const { json, db } = makeApp()
    db.allQueue.push([
      row({ id: 1, start_at: '2026-10-20T10:00' }),
      row({ id: 2, start_at: '2026-10-20T10:00' }),
    ])
    db.allQueue.push([])
    const res = await json('/list', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.schedules).toHaveLength(2)
  })
})

// ---------------- GET /:id ----------------
describe('GET /:id', () => {
  test('invalid_id (문자열) → 400', async () => {
    const { json } = makeApp()
    const res = await json('/abc', 'GET')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('invalid_id')
  })

  test('invalid_id (소수) → 400', async () => {
    const { json } = makeApp()
    const res = await json('/1.5', 'GET')
    expect(res.status).toBe(400)
  })

  test('not_found → 404', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(null)
    const res = await json('/999', 'GET')
    expect(res.status).toBe(404)
    expect((await body(res)).error).toBe('not_found')
  })

  test('정상 조회 → 200', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push(row({ id: 5, title: '점심' }))
    const res = await json('/5', 'GET')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.schedule.title).toBe('점심')
  })
})

// ---------------- POST /create ----------------
describe('POST /create', () => {
  const valid = { title: '회의', start_at: '2026-10-20T10:00' }

  test('JSON 파싱 실패 → title_required 400', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', undefined, '{invalid json')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('title_required')
  })

  test('title 없음 → 400 title_required', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', { start_at: '2026-10-20T10:00' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('title_required')
  })

  test('title 공백만 → 400 title_required', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', { title: '   ', start_at: '2026-10-20T10:00' })
    expect(res.status).toBe(400)
  })

  test('title 201자 → 400 title_too_long', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', { title: 'a'.repeat(201), start_at: '2026-10-20T10:00' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('title_too_long')
  })

  test('title 200자 → 통과', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } })
    const res = await json('/create', 'POST', { title: 'a'.repeat(200), start_at: '2026-10-20T10:00' })
    expect(res.status).toBe(200)
  })

  test('start_at 누락 → 400 start_at_invalid', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', { title: 'x' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('start_at_invalid')
  })

  test('start_at 형식 오류 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', { title: 'x', start_at: '내일 10시' })
    expect(res.status).toBe(400)
  })

  test('start_at 날짜만 허용', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } })
    const res = await json('/create', 'POST', { title: 'x', start_at: '2026-10-20' })
    expect(res.status).toBe(200)
  })

  test('end_at 형식 오류 → 400 end_at_invalid', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', { ...valid, end_at: 'bad' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('end_at_invalid')
  })

  test('end_at 빈 문자열 → null로 저장', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } })
    const res = await json('/create', 'POST', { ...valid, end_at: '' })
    expect(res.status).toBe(200)
    const params = db.calls[0].params
    expect(params[4]).toBeNull() // end_at
  })

  test('end_at < start_at → 400 end_before_start', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', {
      ...valid,
      start_at: '2026-10-20T10:00',
      end_at: '2026-10-20T09:00',
    })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('end_before_start')
  })

  test('status 무효 → 400 status_invalid', async () => {
    const { json } = makeApp()
    const res = await json('/create', 'POST', { ...valid, status: 'weird' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('status_invalid')
  })

  test('UNTIL 무효 날짜 → 400 recurrence_until_invalid (결함 3 수정)', async () => {
    const { json, db } = makeApp()
    const res = await json('/create', 'POST', {
      ...valid,
      recurrence_rule: 'FREQ=DAILY;UNTIL=20261340',
    })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('recurrence_until_invalid')
    expect(db.calls).toHaveLength(0) // 저장 전에 거부 — INSERT 미실행
  })

  test('RRULE 파싱 불가 → 400 recurrence_rule_invalid', async () => {
    const { json, db } = makeApp()
    const res = await json('/create', 'POST', { ...valid, recurrence_rule: 'FREQ=HOURLY' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('recurrence_rule_invalid')
    expect(db.calls).toHaveLength(0)
  })

  test('UNTIL 유효 날짜 → 200 저장', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } })
    const res = await json('/create', 'POST', {
      ...valid,
      recurrence_rule: 'FREQ=DAILY;UNTIL=20240229',
    })
    expect(res.status).toBe(200)
    expect(db.calls).toHaveLength(1)
  })

  test.each(['active', 'cancelled', 'done'] as const)('status=%s 허용', async (status) => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } })
    const res = await json('/create', 'POST', { ...valid, status })
    expect(res.status).toBe(200)
  })

  test('정상 생성 → id 반환 + emit 호출', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 42, changes: 1 } })
    const res = await json('/create', 'POST', {
      title: '  회의  ',
      description: 'd'.repeat(3000),
      location: 'l'.repeat(300),
      start_at: '2026-10-20T10:00',
      end_at: '2026-10-20T11:00',
      timezone: 't'.repeat(100),
      recurrence_rule: 'FREQ=DAILY;COUNT=3',
      status: 'active',
    })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.id).toBe(42)
    expect(emitSpy).toHaveBeenCalledWith('schedule.created', { id: 42 })
    // trim/slice 검증
    const p = db.calls[0].params
    expect(p[0]).toBe('회의')
    expect((p[1] as string).length).toBe(2000)
    expect((p[2] as string).length).toBe(200)
    expect((p[5] as string).length).toBe(50)
    expect(p[6]).toBe('FREQ=DAILY;COUNT=3')
  })

  test('200자 초과 유효 RRULE → 200자로 잘라 저장', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } })
    const longRule = 'FREQ=DAILY;COUNT=' + '9'.repeat(250)
    const res = await json('/create', 'POST', { ...valid, recurrence_rule: longRule })
    expect(res.status).toBe(200)
    const p = db.calls[0].params
    expect((p[6] as string).length).toBe(200)
    expect((p[6] as string).startsWith('FREQ=DAILY;COUNT=')).toBe(true)
  })

  test('기본값: timezone Asia/Seoul, status active, recurrence null', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 1, changes: 1 } })
    await json('/create', 'POST', valid)
    const p = db.calls[0].params
    expect(p[5]).toBe('Asia/Seoul')
    expect(p[6]).toBeNull()
    expect(p[7]).toBe('active')
  })
})

// ---------------- PUT /:id ----------------
describe('PUT /:id', () => {
  const valid = { title: '수정', start_at: '2026-10-21T10:00' }

  test('invalid_id → 400', async () => {
    const { json } = makeApp()
    const res = await json('/xyz', 'PUT', valid)
    expect(res.status).toBe(400)
  })

  test('검증 실패 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5', 'PUT', { title: '', start_at: '2026-10-21T10:00' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('title_required')
  })

  test('JSON 파싱 실패 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5', 'PUT', undefined, 'not json{')
    expect(res.status).toBe(400)
  })

  test('not_found (changes=0) → 404', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/5', 'PUT', valid)
    expect(res.status).toBe(404)
    expect((await body(res)).error).toBe('not_found')
    expect(emitSpy).not.toHaveBeenCalled()
  })

  test('정상 수정 → emit 호출', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5', 'PUT', valid)
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(emitSpy).toHaveBeenCalledWith('schedule.updated', { id: 5 })
    // id가 마지막 바인드 파라미터
    const p = db.calls[0].params
    expect(p[p.length - 1]).toBe(5)
  })
})

// ---------------- DELETE /:id ----------------
describe('DELETE /:id', () => {
  test('invalid_id → 400', async () => {
    const { json } = makeApp()
    const res = await json('/zzz', 'DELETE')
    expect(res.status).toBe(400)
  })

  test('not_found → 404 (리마인더 삭제 후)', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 1 } }) // reminders
    db.runQueue.push({ meta: { changes: 0 } }) // schedules
    const res = await json('/5', 'DELETE')
    expect(res.status).toBe(404)
    expect(db.calls[0].sql).toContain('DELETE FROM reminders')
    expect(emitSpy).not.toHaveBeenCalled()
  })

  test('정상 삭제 → 리마인더 먼저 삭제 + emit', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { changes: 3 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const res = await json('/5', 'DELETE')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(db.calls[0].sql).toContain('DELETE FROM reminders')
    expect(db.calls[1].sql).toContain('DELETE FROM schedules')
    expect(emitSpy).toHaveBeenCalledWith('schedule.deleted', { id: 5 })
  })
})

// ---------------- POST /:id/reminders ----------------
describe('POST /:id/reminders', () => {
  test('invalid_id → 400', async () => {
    const { json } = makeApp()
    const res = await json('/nope/reminders', 'POST', { remind_at: '2026-10-20T09:00' })
    expect(res.status).toBe(400)
  })

  test('remind_at 누락 → 400 remind_at_invalid', async () => {
    const { json } = makeApp()
    const res = await json('/5/reminders', 'POST', {})
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('remind_at_invalid')
  })

  test('remind_at 형식 오류 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/5/reminders', 'POST', { remind_at: 'tomorrow' })
    expect(res.status).toBe(400)
  })

  test('JSON 파싱 실패 → remind_at_invalid', async () => {
    const { json } = makeApp()
    const res = await json('/5/reminders', 'POST', undefined, '{{{')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('remind_at_invalid')
  })

  test('정상 등록 → 기본 dedupe_key 사용', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 11, changes: 1 } })
    const res = await json('/5/reminders', 'POST', { remind_at: '2026-10-20T09:00' })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.id).toBe(11)
    const p = db.calls[0].params
    expect(p[0]).toBe(5)
    expect(p[1]).toBe('2026-10-20T09:00')
    expect(p[2]).toBe('sched:5:2026-10-20T09:00')
  })

  test('dedupe_key 지정 → 200자로 슬라이스', async () => {
    const { json, db } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 1, changes: 1 } })
    const res = await json('/5/reminders', 'POST', {
      remind_at: '2026-10-20T09:00',
      dedupe_key: 'k'.repeat(300),
    })
    expect(res.status).toBe(200)
    expect((db.calls[0].params[2] as string).length).toBe(200)
  })

  test('중복 → 409 duplicate', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('UNIQUE constraint failed'))
    const res = await json('/5/reminders', 'POST', { remind_at: '2026-10-20T09:00' })
    expect(res.status).toBe(409)
    expect((await body(res)).error).toBe('duplicate')
  })
})
