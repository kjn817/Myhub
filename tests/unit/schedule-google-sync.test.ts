/// <reference types="jest" />
/**
 * schedule-google-sync — 일정 Google 쓰기-스루 계약 테스트 (재구축, 2026-11-07, 신규 도출)
 *
 * 기록 근거 (2026-11-07, 커밋 a9aeda07): 쓰기-스루 조용한 실패의 2층 결함 —
 * ① 비서 도구 경로가 동기화를 호출하지 않음 ② 결정적 생성 본문에 id와 iCalUID를
 * 동시 지정해 Google API가 400으로 거부 (운영 google_sync_log에 10회 연속 기록).
 * 수정 후 관련 6스위트 143건 PASS·카나리아 실증.
 *
 * 핵심 불변조건: 생성 요청 본문에 iCalUID가 절대 들어가지 않는다. 쓰기 게이트가
 * 닫혀 있으면 네트워크를 절대 호출하지 않고 skipped로 정직하게 돌아온다.
 *
 * 범위 메모: 재구성된 모듈에서 toMarkedEventBody·sanitizeScheduleForGoogleSync·
 * toEventInput은 export되지 않은 내부 함수다 — 본문 성질은 createMarkedCalendarEvent의
 * 실제 요청 캡처로 검증하고, 정제(L3 토큰화) 성질은 export 없이는 단위 검증이
 * 불가능해 통합 단계 과제로 남긴다 (RECONSTRUCTION-TEST-MAP.md 참조).
 */
import {
  deterministicGoogleEventId,
  createMarkedCalendarEvent,
  callCalendarApi,
  type MarkedEventInput,
} from '../../src/services/schedule-google-events'
import {
  pushScheduleDetailed,
  removeScheduleDetailed,
  backfillUnsyncedSchedules,
} from '../../src/services/schedule-google-sync'

/** google_sync_log INSERT와 토큰 조회를 받는 최소 가짜 D1 */
function fakeDb() {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    }),
  }
}
const envNoWrite = () => ({ DB: fakeDb() }) as never

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const EVENT_INPUT = { summary: '팀 회의', start: '2026-11-08T10:00:00+09:00', end: '2026-11-08T11:00:00+09:00' }

/** createMarkedCalendarEvent의 실제 요청 본문을 캡처한다 */
async function captureCreate(input: MarkedEventInput = EVENT_INPUT, scheduleId = 7, deterministic = true) {
  let sentBody = ''
  let sentUrl = ''
  const fetchFn = async (url: string, init: { body: string }) => {
    sentUrl = url
    sentBody = init.body
    return jsonRes(200, { id: 'mh00007' })
  }
  const r = await createMarkedCalendarEvent(fetchFn as never, 'token', input, scheduleId, deterministic)
  return { r, body: JSON.parse(sentBody) as Record<string, any>, raw: sentBody, url: sentUrl }
}

describe('schedule-google-events — 마커 이벤트 생성 (H-06 회귀 가드)', () => {
  test('deterministicGoogleEventId는 mh+5자리 0채움이다', () => {
    expect(deterministicGoogleEventId(7)).toBe('mh00007')
    expect(deterministicGoogleEventId(123456)).toBe('mh123456')
  })

  test('생성 요청 본문에 iCalUID가 절대 없고, 마커 속성과 결정적 id가 실린다', async () => {
    const { r, body, raw } = await captureCreate()
    expect(r).toEqual({ ok: true, data: { id: 'mh00007' } })
    expect(raw).not.toContain('iCalUID')
    expect(body.id).toBe('mh00007')
    expect(body.extendedProperties.private.myhub_schedule_id).toBe('7')
  })

  test('end가 없으면 start와 동일하게 채우고 시간대는 Asia/Seoul이다', async () => {
    const { body } = await captureCreate({ summary: '회의', start: '2026-11-08T10:00:00+09:00' })
    expect(body.end.dateTime).toBe('2026-11-08T10:00:00+09:00')
    expect(body.start.timeZone).toBe('Asia/Seoul')
    expect(body.end.timeZone).toBe('Asia/Seoul')
  })

  test('deterministic이 아니면 본문에 id를 싣지 않는다 (서버 채번에 맡긴다)', async () => {
    const { body } = await captureCreate(EVENT_INPUT, 7, false)
    expect('id' in body).toBe(false)
    expect(body.extendedProperties.private.myhub_schedule_id).toBe('7')
  })
})

describe('callCalendarApi — 상태 매핑', () => {
  test('401→unauthorized, 429→rate_limited, 네트워크 예외→network_error, 204→ok/null', async () => {
    const f401 = async () => jsonRes(401, {})
    expect(await callCalendarApi(f401 as never, 't', 'https://x')).toMatchObject({ ok: false, error: 'unauthorized', unauthorized: true })
    const f429 = async () => jsonRes(429, {})
    expect(await callCalendarApi(f429 as never, 't', 'https://x')).toMatchObject({ ok: false, error: 'rate_limited' })
    const fThrow = async () => { throw new Error('down') }
    expect(await callCalendarApi(fThrow as never, 't', 'https://x')).toMatchObject({ ok: false, error: 'network_error' })
    const f204 = async () => ({ ok: true, status: 204, json: async () => null })
    expect(await callCalendarApi(f204 as never, 't', 'https://x', { method: 'DELETE' })).toEqual({ ok: true, data: null })
  })

  test('400은 google_api_error:400 형식으로 표면화된다 (조용한 실패 금지)', async () => {
    const f400 = async () => jsonRes(400, { error: { message: 'Invalid iCalUID value' } })
    const r = await callCalendarApi(f400 as never, 't', 'https://x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('google_api_error:400')
  })
})

describe('schedule-google-sync — 쓰기 게이트 (닫혀 있으면 네트워크 금지)', () => {
  test('push는 게이트가 닫혀 있으면 fetch 없이 skipped/write_disabled', async () => {
    let fetchCalled = false
    const fetchFn = async () => { fetchCalled = true; return jsonRes(200, {}) }
    const r = await pushScheduleDetailed(fetchFn as never, envNoWrite(), {
      id: 7, title: '회의', start_at: '2026-11-08T01:00:00Z', end_at: null, google_event_id: null,
    })
    expect(r).toEqual({ state: 'skipped', reason: 'write_disabled' })
    expect(fetchCalled).toBe(false)
  })

  test('remove: 구글 이벤트가 없으면 no_google_event, 게이트가 닫혀 있으면 write_disabled — 둘 다 fetch 없음', async () => {
    let fetchCalled = false
    const fetchFn = async () => { fetchCalled = true; return jsonRes(200, {}) }
    expect(
      await removeScheduleDetailed(fetchFn as never, envNoWrite(), { id: 7, google_event_id: null }),
    ).toEqual({ state: 'skipped', reason: 'no_google_event' })
    expect(
      await removeScheduleDetailed(fetchFn as never, envNoWrite(), { id: 7, google_event_id: 'evt-1' }),
    ).toEqual({ state: 'skipped', reason: 'write_disabled' })
    expect(fetchCalled).toBe(false)
  })

  test('backfill도 게이트가 닫혀 있으면 이유를 밝히고 네트워크를 호출하지 않는다', async () => {
    let fetchCalled = false
    const fetchFn = async () => { fetchCalled = true; return jsonRes(200, {}) }
    const r = await backfillUnsyncedSchedules(fetchFn as never, envNoWrite())
    expect(r.reason).toBe('write_disabled')
    expect(fetchCalled).toBe(false)
  })
})
