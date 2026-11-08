/// <reference types="jest" />
/**
 * src/services/schedule-tools.ts 성질 테스트 (3차 배치).
 * svc3와 겹치지 않는 영역: Google 동기화 상태→고지 문구 매핑 전 분기,
 * 삭제 시 Google 삭제 선행 보장, 정정 후보 탐색(편집거리·포함 관계),
 * 정정 의도·시작 시각 파싱 경계, rejectPast의 파싱 불가 관용.
 * 카나리아: googleSyncNotice의 상태 매핑을 지우면 고지 단언이,
 * 삭제의 Google 선행 검사를 지우면 "DELETE 미실행" 단언이 실패한다.
 */
import {
  parseScheduleStartMs,
  detectCorrectionIntent,
  findScheduleCorrectionCandidates,
  executeScheduleCreate,
  executeScheduleUpdate,
  executeScheduleDelete,
} from '../../src/services/schedule-tools'
import { pushScheduleDetailed, removeScheduleDetailed } from '../../src/services/schedule-google-sync'

jest.mock('../../src/services/schedule-google-sync', () => ({
  pushScheduleDetailed: jest.fn(),
  removeScheduleDetailed: jest.fn(),
}))

const mockPush = pushScheduleDetailed as jest.Mock
const mockRemove = removeScheduleDetailed as jest.Mock

/** SQL 종류별로 first/run/all 동작을 정하는 env */
function makeEnv(opts: {
  dup?: any
  firstQueue?: any[]
  allResults?: any
  changes?: number
  throwOnGoogleLink?: boolean
} = {}) {
  const sqls: string[] = []
  const binds: any[][] = []
  const firstQueue = [...(opts.firstQueue ?? [])]
  const env: any = {
    DB: {
      prepare(sql: string) {
        sqls.push(sql)
        const stmt: any = {
          bind(...args: any[]) {
            binds.push(args)
            return stmt
          },
          first: async () => {
            if (sql.includes('SELECT google_event_id')) {
              if (opts.throwOnGoogleLink) throw new Error('link query down')
              return firstQueue.length ? firstQueue.shift() : null
            }
            if (sql.includes('FROM schedules') && sql.includes('title = ?')) return opts.dup ?? null
            if (firstQueue.length) return firstQueue.shift()
            if (sql.includes('SELECT id FROM schedules')) return { id: 1 }
            return null
          },
          run: async () => ({
            meta: {
              last_row_id: sql.includes('INSERT INTO todos') ? 22 : 11,
              changes: opts.changes ?? 1,
            },
          }),
          all: async () => ({ results: opts.allResults ?? [] }),
        }
        return stmt
      },
    },
  }
  return { env, sqls, binds }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPush.mockResolvedValue(null)
  mockRemove.mockResolvedValue(null)
})

describe('Google 동기화 고지 — 상태 매핑 (생성 경로)', () => {
  const create = (env: any, data: any = { title: '회의', start_at: '2027-01-05T10:00', create_todo: false }) =>
    executeScheduleCreate(env, data)

  test('created/updated면 반영 고지, google 객체가 그대로 실린다', async () => {
    for (const state of ['created', 'updated']) {
      mockPush.mockResolvedValue({ state })
      const { env } = makeEnv()
      const r = await create(env)
      expect(r.success).toBe(true)
      expect(r.google).toEqual({ state })
      expect(r.googleNotice).toBe('Google 캘린더에도 반영했어요.')
    }
  })

  test('skipped/failed면 알려진 사유는 한국어로, 모르는 사유는 원문으로 보여준다', async () => {
    mockPush.mockResolvedValue({ state: 'skipped', reason: 'not_connected' })
    const r1 = await create(makeEnv().env)
    expect(r1.googleNotice).toContain('Google 계정이 연결돼 있지 않아요')

    mockPush.mockResolvedValue({ state: 'failed', reason: 'weird_reason' })
    const r2 = await create(makeEnv().env)
    expect(r2.googleNotice).toContain('(weird_reason)')
    expect(r2.googleNotice).toContain('MyHub 일정은 저장돼 있고')
  })

  test('사유가 없으면 확인 중 문구, 동기화 자체가 던지면 고지 없음(로컬 성공 유지)', async () => {
    mockPush.mockResolvedValue({ state: 'failed' })
    const r1 = await create(makeEnv().env)
    expect(r1.googleNotice).toContain('이유를 확인 중이에요')

    mockPush.mockRejectedValue(new Error('sync exploded'))
    const r2 = await create(makeEnv().env)
    expect(r2.success).toBe(true)
    expect(r2.google).toBeNull()
    expect(r2.googleNotice).toBeNull()
  })

  test('알 수 없는 상태 값이면 고지를 만들지 않는다', async () => {
    mockPush.mockResolvedValue({ state: 'archived' })
    const r = await create(makeEnv().env)
    expect(r.googleNotice).toBeNull()
  })

  test('end_at이 있으면 정규화돼 저장·동기화에 실리고, 없으면 null이다', async () => {
    const withEnd = makeEnv()
    await create(withEnd.env, { title: '회의', start_at: '2027-01-05T10:00', end_at: '2027-01-05T11:00', create_todo: false })
    const insertBind = withEnd.binds.find((b) => b.length === 5)
    expect(insertBind?.[4]).not.toBeNull()
    expect(mockPush.mock.calls[0][2].end_at).not.toBeNull()

    jest.clearAllMocks()
    mockPush.mockResolvedValue(null)
    const noEnd = makeEnv()
    await create(noEnd.env)
    const insertBind2 = noEnd.binds.find((b) => b.length === 5)
    expect(insertBind2?.[4]).toBeNull()
    expect(mockPush.mock.calls[0][2].end_at).toBeNull()
  })
})

describe('executeScheduleCreate — rejectPast 경계', () => {
  test('과거 시각은 DB에 닿기 전에 거부된다', async () => {
    const { env, sqls } = makeEnv()
    const r = await executeScheduleCreate(env,
      { title: '과거 회의', start_at: '2020-01-01T10:00' },
      { rejectPast: true, nowMs: Date.parse('2026-11-08T00:00:00Z') })
    expect(r.success).toBe(false)
    expect(r.error).toContain('과거 시각으로는 새 일정을 등록할 수 없습니다')
    expect(sqls).toEqual([])
  })

  test('파싱할 수 없는 start_at은 rejectPast에서도 기존 경로(중복 검사)로 진행한다', async () => {
    const { env } = makeEnv()
    const r = await executeScheduleCreate(env,
      { title: '이상한 값', start_at: '언젠가', create_todo: false },
      { rejectPast: true, nowMs: Date.parse('2026-11-08T00:00:00Z') })
    expect(r.success).toBe(true)
  })
})

describe('executeScheduleDelete — Google 삭제 선행 보장', () => {
  test('Google 이벤트가 있고 삭제가 완료되면 로컬도 지우고 삭제 고지를 낸다', async () => {
    mockRemove.mockResolvedValue({ state: 'deleted' })
    const { env, sqls } = makeEnv({ firstQueue: [{ google_event_id: 'evt-1' }] })
    const r = await executeScheduleDelete(env, { id: 5 })
    expect(r.success).toBe(true)
    expect(r.googleNotice).toBe('Google 캘린더에서도 삭제했어요.')
    expect(sqls.some((s) => s.includes('DELETE FROM schedules'))).toBe(true)
  })

  test('Google 삭제가 끝나지 않으면 로컬 DELETE는 실행되지 않는다', async () => {
    mockRemove.mockResolvedValue({ state: 'failed', reason: 'api_error' })
    const { env, sqls } = makeEnv({ firstQueue: [{ google_event_id: 'evt-1' }] })
    const r = await executeScheduleDelete(env, { id: 5 })
    expect(r.success).toBe(false)
    expect(r.data.deletePending).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE FROM schedules'))).toBe(false)
  })

  test('Google 삭제 호출 자체가 던져도 exception 상태로 막고 로컬은 유지한다', async () => {
    mockRemove.mockRejectedValue(new Error('google down'))
    const { env, sqls } = makeEnv({ firstQueue: [{ google_event_id: 'evt-1' }] })
    const r = await executeScheduleDelete(env, { id: 5 })
    expect(r.success).toBe(false)
    expect(r.google).toEqual({ state: 'failed', reason: 'exception' })
    expect(sqls.some((s) => s.includes('DELETE FROM schedules'))).toBe(false)
  })

  test('연결 정보 조회가 실패하거나 이벤트가 없으면 Google 없이 로컬만 지운다', async () => {
    const thrown = makeEnv({ throwOnGoogleLink: true })
    const r1 = await executeScheduleDelete(thrown.env, { id: 5 })
    expect(r1.success).toBe(true)
    expect(r1.google).toBeNull()
    expect(r1.googleNotice).toBeNull()
    expect(mockRemove).not.toHaveBeenCalled()
  })
})

describe('executeScheduleUpdate — 동기화 행 유무', () => {
  test('수정 후 행을 다시 읽어 동기화하면 반영 고지가 붙는다 (start_at/end_at 정규화 포함)', async () => {
    mockPush.mockResolvedValue({ state: 'updated' })
    const row = { id: 1, title: '새 제목', start_at: '2027-01-05T10:00', end_at: null, google_event_id: 'evt' }
    const { env } = makeEnv({ firstQueue: [{ id: 1 }, row] })
    const r = await executeScheduleUpdate(env, { id: 1, title: '새 제목', start_at: '2027-01-05T10:00', end_at: '2027-01-05T11:00' })
    expect(r.success).toBe(true)
    expect(r.googleNotice).toBe('Google 캘린더에도 반영했어요.')
    expect(mockPush).toHaveBeenCalledWith(expect.anything(), env, row)
  })

  test('수정 후 행이 사라졌으면 동기화 없이 성공한다', async () => {
    const { env } = makeEnv({ firstQueue: [{ id: 1 }, null] })
    const r = await executeScheduleUpdate(env, { id: 1, location: '서울' })
    expect(r.success).toBe(true)
    expect(r.google).toBeNull()
    expect(r.googleNotice).toBeNull()
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe('findScheduleCorrectionCandidates — 정정 후보 필터', () => {
  const rows = [
    { id: 1, title: '회의록', start_at: '2026-11-09T10:00' },
    { id: 2, title: '회의로', start_at: '2026-11-09T11:00' },
    { id: 3, title: '', start_at: '2026-11-09T12:00' },
    { id: 4, title: null, start_at: '2026-11-09T13:00' },
    { id: 5, title: '전혀다른제목입니다', start_at: '2026-11-09T14:00' },
    { id: 6, title: '주간 회의록 정리', start_at: '2026-11-09T15:00' },
  ]

  test('동일 제목은 제외하고, 편집거리 2 이내와 포함 관계만 후보로 남긴다', async () => {
    const { env } = makeEnv({ allResults: rows })
    const found = await findScheduleCorrectionCandidates(env, { title: '회의록', start_at: '2026-11-09T09:00' })
    expect(found.map((f) => f.id)).toEqual([2, 6])
  })

  test('입력 결측·DB 없음·조회 실패·결과 null은 모두 빈 후보', async () => {
    const { env } = makeEnv({ allResults: rows })
    expect(await findScheduleCorrectionCandidates(env, {})).toEqual([])
    expect(await findScheduleCorrectionCandidates(env, { title: '회의록' })).toEqual([])
    expect(await findScheduleCorrectionCandidates(null, { title: '회의록', start_at: '2026-11-09' })).toEqual([])
    expect(await findScheduleCorrectionCandidates({}, { title: '회의록', start_at: '2026-11-09' })).toEqual([])
    const broken: any = { DB: { prepare() { throw new Error('db down') } } }
    expect(await findScheduleCorrectionCandidates(broken, { title: '회의록', start_at: '2026-11-09' })).toEqual([])
    const { env: nullEnv } = makeEnv({ allResults: null })
    expect(await findScheduleCorrectionCandidates(nullEnv, { title: '회의록', start_at: '2026-11-09' })).toEqual([])
  })
})

describe('detectCorrectionIntent / parseScheduleStartMs — 순수 경계', () => {
  test('정정 신호어가 하나라도 있으면 true, 없거나 비문자열이면 false', () => {
    for (const t of ['정정해줘', '그게 아니라 이거야', '아니고 저거', '아니, 잠깐', '아니 그건', '틀렸어', '잘못 넣었어', '오타 났어', '바꿔줘', '고쳐줘', '수정해줘']) {
      expect(detectCorrectionIntent(t)).toBe(true)
    }
    expect(detectCorrectionIntent('새 일정 등록해줘')).toBe(false)
    expect(detectCorrectionIntent(null)).toBe(false)
    expect(detectCorrectionIntent(undefined)).toBe(false)
    expect(detectCorrectionIntent(123)).toBe(false)
  })

  test('오프셋 없는 값은 KST로 해석하고, 깨진 값은 null이다', () => {
    expect(parseScheduleStartMs('2026-11-09T10:00')).toBe(Date.parse('2026-11-09T10:00+09:00'))
    expect(parseScheduleStartMs('2026-11-09T10:00Z')).toBe(Date.parse('2026-11-09T10:00Z'))
    expect(parseScheduleStartMs('2026-11-09T10:00+09:00')).toBe(Date.parse('2026-11-09T10:00+09:00'))
    expect(parseScheduleStartMs('2026-11-09T10:00+0900')).toBe(Date.parse('2026-11-09T10:00+0900'))
    expect(parseScheduleStartMs('날짜아님')).toBeNull()
    expect(parseScheduleStartMs('')).toBeNull()
    expect(parseScheduleStartMs('   ')).toBeNull()
    expect(parseScheduleStartMs(123)).toBeNull()
    expect(parseScheduleStartMs(null)).toBeNull()
  })
})
