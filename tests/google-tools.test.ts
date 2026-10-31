/**
 * Google AI 도구 테스트 — 마커 파싱·실행·미연동 안내·로컬+구글 일정 합치기
 * FakeD1 + 모의 fetch 사용 — 운영 DB·실제 Google API에 닿지 않음.
 */
import {
  parseGoogleMarkers,
  executeGmailSearch,
  executeGmailGet,
  executeGcalList,
  executeGcalCreate,
  GOOGLE_NOT_CONNECTED_MESSAGE,
} from '../src/services/google-tools'
import { saveGoogleTokens } from '../src/services/google-tokens'
import { FakeD1, asD1 } from './fake-d1'

const KEY = 'test-google-encryption-key'
const READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly'
const WRITE_SCOPE = `${READONLY_SCOPE} https://www.googleapis.com/auth/calendar.events`

function b64url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeEnv() {
  const fake = new FakeD1()
  const env: any = {
    DB: asD1(fake),
    MEMO_ENCRYPTION_KEY: KEY,
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csec',
  }
  return { fake, env }
}

async function seedConnected(env: any, scope: string = READONLY_SCOPE) {
  await saveGoogleTokens(env, {
    email: 'user@example.com',
    accessToken: 'at-valid',
    refreshToken: 'rt-1',
    scope,
    expiresIn: 3600,
  })
}

function googleFetch(): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/gmail/v1/users/me/messages?')) {
      return new Response(JSON.stringify({ messages: [{ id: 'msg1' }] }), { status: 200 })
    }
    if (u.includes('/gmail/v1/users/me/messages/msg1')) {
      return new Response(
        JSON.stringify({
          id: 'msg1',
          threadId: 't',
          snippet: '스니펫',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'boss@company.com' },
              { name: 'Subject', value: '내일 회의' },
              { name: 'Date', value: 'Mon, 26 Oct 2026' },
            ],
            body: { data: b64url('내일 10시 회의입니다.') },
          },
        }),
        { status: 200 },
      )
    }
    if (u.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return new Response(
        JSON.stringify({ id: 'ev-new', summary: body.summary, start: body.start, end: body.end }),
        { status: 200 },
      )
    }
    if (u.includes('/calendar/v3/calendars/primary/events')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'ev1',
              summary: '구글 회의',
              start: { dateTime: '2026-10-27T14:00:00+09:00' },
              end: { dateTime: '2026-10-27T15:00:00+09:00' },
              location: '강남',
              attendees: [{ email: 'a@x.com' }],
              status: 'confirmed',
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
  }) as unknown as typeof fetch
}

describe('마커 파싱', () => {
  test('4종 마커 파싱', () => {
    const markers = parseGoogleMarkers(
      '[GMAIL_SEARCH]{"q": "회의"}[/GMAIL_SEARCH] ' +
        '[GMAIL_GET]{"id": "msg1"}[/GMAIL_GET] ' +
        '[GCAL_LIST]{"from": "2026-10-27", "to": "2026-10-27"}[/GCAL_LIST] ' +
        '[GCAL_CREATE]{"title": "치과", "start_at": "2026-10-27T15:00:00"}[/GCAL_CREATE]',
    )
    expect(markers).toHaveLength(4)
    expect(markers.map((m) => m.action)).toEqual(['gmail_search', 'gmail_get', 'gcal_list', 'gcal_create'])
  })

  test('깨진 JSON·필수 필드 없음은 무시', () => {
    expect(parseGoogleMarkers('[GMAIL_SEARCH]{broken[/GMAIL_SEARCH]')).toHaveLength(0)
    expect(parseGoogleMarkers('[GMAIL_GET]{}[/GMAIL_GET]')).toHaveLength(0)
    expect(parseGoogleMarkers('[GCAL_CREATE]{"start_at": "2026-10-27T15:00:00"}[/GCAL_CREATE]')).toHaveLength(0)
    expect(parseGoogleMarkers('마커 없음')).toHaveLength(0)
  })

  test('최대 3개까지만', () => {
    const text = '[GMAIL_SEARCH]{"q": "a"}[/GMAIL_SEARCH]'.repeat(5)
    expect(parseGoogleMarkers(text)).toHaveLength(3)
  })
})

describe('미연동 동작', () => {
  test('Gmail 검색 — not_connected', async () => {
    const { env } = makeEnv()
    const res = await executeGmailSearch(env, { q: '회의' }, googleFetch())
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toBe('not_connected')
  })

  test('GCAL_LIST — 미연동이면 로컬 일정만 반환 (기존 기능 영향 없음)', async () => {
    const { fake, env } = makeEnv()
    fake.tables.schedules.push({
      id: 1,
      title: '로컬 회의',
      description: '',
      location: '',
      start_at: '2026-10-27T10:00',
      end_at: '2026-10-27T11:00',
      timezone: 'Asia/Seoul',
      recurrence_rule: null,
      status: 'active',
      created_at: '',
      updated_at: '',
    })
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, googleFetch())
    expect(res.success).toBe(true)
    expect(res.googleConnected).toBe(false)
    expect(res.data).toHaveLength(1)
    expect(res.data[0]).toMatchObject({ source: 'local', title: '로컬 회의' })
  })

  test('GCAL_CREATE 미연동 — not_connected', async () => {
    const { env } = makeEnv()
    const res = await executeGcalCreate(env, { title: '치과', start_at: '2026-10-27T15:00:00' }, googleFetch())
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toBe('not_connected')
  })

  test('안내 문장 상수 존재', () => {
    expect(GOOGLE_NOT_CONNECTED_MESSAGE).toContain('Google 연동')
  })
})

describe('연동 시 실행', () => {
  test('Gmail 검색 — 정제된 결과 반환', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res = await executeGmailSearch(env, { q: '회의' }, googleFetch())
    expect(res.success).toBe(true)
    if (!res.success) return
    expect(res.data).toHaveLength(1)
    expect(res.data[0]).toMatchObject({ id: 'msg1', subject: '내일 회의' })
  })

  test('Gmail 단건 — 본문 포함', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res = await executeGmailGet(env, { id: 'msg1' }, googleFetch())
    expect(res.success).toBe(true)
    if (res.success) expect(res.data.body).toContain('내일 10시 회의입니다')
  })

  test('GCAL_LIST — 로컬 + 구글 합쳐서 시간순', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    fake.tables.schedules.push({
      id: 1,
      title: '로컬 회의',
      description: '',
      location: '',
      start_at: '2026-10-27T10:00',
      end_at: '2026-10-27T11:00',
      timezone: 'Asia/Seoul',
      recurrence_rule: null,
      status: 'active',
      created_at: '',
      updated_at: '',
    })
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, googleFetch())
    expect(res.success).toBe(true)
    expect(res.googleConnected).toBe(true)
    expect(res.data).toHaveLength(2)
    expect(res.data[0]).toMatchObject({ source: 'local', title: '로컬 회의' })
    expect(res.data[1]).toMatchObject({ source: 'google', title: '구글 회의' })
  })

  test('GCAL_LIST — Google API 실패 시에도 로컬 일정 반환 (fail-soft)', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    fake.tables.schedules.push({
      id: 1,
      title: '로컬 회의',
      description: '',
      location: '',
      start_at: '2026-10-27T10:00',
      end_at: '2026-10-27T11:00',
      timezone: 'Asia/Seoul',
      recurrence_rule: null,
      status: 'active',
      created_at: '',
      updated_at: '',
    })
    const failing = (async () => new Response(JSON.stringify({}), { status: 500 })) as unknown as typeof fetch
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, failing)
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(1)
    expect(res.data[0].source).toBe('local')
  })

  test('GCAL_CREATE — 읽기 전용 scope면 scope_missing', async () => {
    const { env } = makeEnv()
    await seedConnected(env, READONLY_SCOPE)
    const res = await executeGcalCreate(env, { title: '치과', start_at: '2026-10-27T15:00:00' }, googleFetch())
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toBe('scope_missing')
  })

  test('GCAL_CREATE — 쓰기 scope면 생성 성공', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    const res = await executeGcalCreate(env, { title: '치과', start_at: '2026-10-27T15:00:00' }, googleFetch())
    expect(res.success).toBe(true)
    if (res.success) expect(res.data.summary).toBe('치과')
  })

  test('GCAL_CREATE — 제목·시작 없음은 invalid_input', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    const res = await executeGcalCreate(env, {}, googleFetch())
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toBe('invalid_input')
  })
})
