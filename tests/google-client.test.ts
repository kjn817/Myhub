/**
 * Google API 클라이언트 테스트 — Gmail/Calendar 파싱 + 401/429 처리
 * 모의 fetch만 사용 — 실제 Google API 호출 없음.
 */
import {
  listGmailMessages,
  getGmailMessage,
  listCalendarEvents,
  createCalendarEvent,
  getGmailProfile,
} from '../src/services/google-client'

function b64url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; json: any }): typeof fetch {
  return (async (url: any, init?: any) =>
    new Response(JSON.stringify(handler(String(url), init).json), {
      status: handler(String(url), init).status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

const MESSAGE_FULL = {
  id: 'msg1',
  threadId: 'th1',
  snippet: '안녕하세요 스니펫',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'sender@example.com' },
      { name: 'Subject', value: '회의 일정 안내' },
      { name: 'Date', value: 'Mon, 26 Oct 2026 10:00:00 +0900' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('본문입니다. 카드번호 4111-1111-1111-1111 포함') } },
      { mimeType: 'text/html', body: { data: b64url('<p>html</p>') } },
    ],
  },
}

const gmailFetch = mockFetch((url) => {
  if (url.includes('/users/me/messages?') || url.includes('/users/me/messages&')) {
    return { status: 200, json: { messages: [{ id: 'msg1' }, { id: 'msg2' }] } }
  }
  if (url.includes('/messages/msg1')) return { status: 200, json: MESSAGE_FULL }
  if (url.includes('/messages/msg2')) {
    return {
      status: 200,
      json: {
        id: 'msg2',
        threadId: 'th2',
        snippet: '두 번째',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'a@b.com' },
            { name: 'Subject', value: '두번째 메일' },
          ],
          body: { data: b64url('두번째 본문') },
        },
      },
    }
  }
  if (url.includes('/users/me/profile')) {
    return { status: 200, json: { emailAddress: 'user@example.com', messagesTotal: 42 } }
  }
  return { status: 404, json: { error: 'not_found' } }
})

describe('Gmail', () => {
  test('목록 조회 — 헤더 파싱, text/plain 본문은 목록에 포함 안 함', async () => {
    const res = await listGmailMessages(gmailFetch, 'token')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toHaveLength(2)
    expect(res.data[0]).toMatchObject({ id: 'msg1', from: 'sender@example.com', subject: '회의 일정 안내' })
    expect(res.data[1].subject).toBe('두번째 메일')
  })

  test('단건 조회 — 본문 추출', async () => {
    const res = await getGmailMessage(gmailFetch, 'token', 'msg1', true)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.bodyText).toContain('본문입니다')
    expect(res.data.snippet).toBe('안녕하세요 스니펫')
  })

  test('단건 조회 withBody=false — 본문 비움', async () => {
    const res = await getGmailMessage(gmailFetch, 'token', 'msg1', false)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.bodyText).toBe('')
  })

  test('프로필 조회', async () => {
    const res = await getGmailProfile(gmailFetch, 'token')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.emailAddress).toBe('user@example.com')
  })

  test('401은 unauthorized로 구분', async () => {
    const fetchFn = mockFetch(() => ({ status: 401, json: { error: 'unauthorized' } }))
    const res = await listGmailMessages(fetchFn, 'bad-token')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.unauthorized).toBe(true)
  })

  test('429는 rate_limited, unauthorized=false', async () => {
    const fetchFn = mockFetch(() => ({ status: 429, json: {} }))
    const res = await listGmailMessages(fetchFn, 'token')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('rate_limited')
      expect(res.unauthorized).toBe(false)
    }
  })

  test('네트워크 실패는 network_error', async () => {
    const failing = (async () => { throw new Error('net') }) as unknown as typeof fetch
    const res = await listGmailMessages(failing, 'token')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('network_error')
  })
})

const calendarFetch = mockFetch((url, init) => {
  if (url.includes('/calendars/primary/events') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body))
    return {
      status: 200,
      json: { id: 'ev-new', summary: body.summary, start: body.start, end: body.end, status: 'confirmed' },
    }
  }
  if (url.includes('/calendars/primary/events')) {
    return {
      status: 200,
      json: {
        items: [
          {
            id: 'ev1',
            summary: '구글 회의',
            start: { dateTime: '2026-10-27T14:00:00+09:00' },
            end: { dateTime: '2026-10-27T15:00:00+09:00' },
            location: '강남',
            attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }],
            status: 'confirmed',
          },
          {
            id: 'ev2',
            summary: '종일 일정',
            start: { date: '2026-10-28' },
            end: { date: '2026-10-29' },
            status: 'confirmed',
          },
        ],
      },
    }
  }
  return { status: 404, json: {} }
})

describe('Calendar', () => {
  test('이벤트 목록 — dateTime·종일·참석자 수 파싱', async () => {
    const res = await listCalendarEvents(calendarFetch, 'token', {
      timeMin: '2026-10-27T00:00:00+09:00',
      timeMax: '2026-10-28T23:59:59+09:00',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toHaveLength(2)
    expect(res.data[0]).toMatchObject({ id: 'ev1', summary: '구글 회의', start: '2026-10-27T14:00:00+09:00', attendeeCount: 2 })
    expect(res.data[1].start).toBe('2026-10-28')
  })

  test('일정 생성 — 요청 본문에 Asia/Seoul 포함', async () => {
    let captured: any = null
    const fetchFn = mockFetch((url, init) => {
      captured = JSON.parse(String(init?.body))
      return { status: 200, json: { id: 'ev9', summary: captured.summary, start: captured.start, end: captured.end } }
    })
    const res = await createCalendarEvent(fetchFn, 'token', {
      summary: '새 회의',
      start: '2026-10-27T16:00:00',
      description: '설명',
    })
    expect(res.ok).toBe(true)
    expect(captured.start.timeZone).toBe('Asia/Seoul')
    expect(captured.description).toBe('설명')
  })

  test('빈 필드 방어 — 누락 시 기본값', async () => {
    const fetchFn = mockFetch(() => ({ status: 200, json: { items: [{}] } }))
    const res = await listCalendarEvents(fetchFn, 'token', { timeMin: 'x', timeMax: 'y' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data[0].summary).toBe('(제목 없음)')
      expect(res.data[0].attendeeCount).toBe(0)
    }
  })
})
