/**
 * Google API 클라이언트 — Gmail 읽기 + Calendar 읽기/생성
 *
 * 설계: docs/gmail-calendar-design.md §7
 * - 읽기부터 구현한다. 쓰기는 캘린더 일정 생성만 있으며 scope 결정을 거친다.
 * - fetch는 주입 가능 (테스트에서 모의 Google API 사용 — 실제 호출 없음).
 * - 401이 오면 호출부가 토큰 갱신을 시도하도록 `unauthorized`로 구분해 반환한다.
 * - 응답 파싱은 방어적으로: 필드 누락 시 빈 값으로 처리하고 예외를 던지지 않는다.
 */

import { KST_TIME_ZONE } from '../lib/kst'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1'
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'

export interface GmailMessageSummary {
  id: string
  threadId: string
  from: string
  subject: string
  date: string
  snippet: string
}

export interface GmailMessage extends GmailMessageSummary {
  bodyText: string
}

export interface CalendarEvent {
  id: string
  summary: string
  description: string
  start: string
  end: string
  location: string
  attendeeCount: number
  status: string
}

export type GoogleApiFailure = { ok: false; error: string; unauthorized: boolean; apiMessage?: string }

export type GoogleApiResult<T> =
  | { ok: true; data: T }
  | GoogleApiFailure

/**
 * 실패 판별 타입 가드 — jest(ts-jest, strict:false)에서는 판별자 narrowing이
 * 동작하지 않아 `!res.ok`만으로는 실패 분기로 좁혀지지 않으므로, 가드로 명시한다
 * (프로젝트 tsc strict:true와 jest 양쪽에서 통과 — /tmp 재현으로 확인).
 */
function isApiFailure<T>(res: GoogleApiResult<T>): res is GoogleApiFailure {
  return !res.ok
}

export async function extractGoogleApiMessage(res: Response): Promise<string | undefined> {
  try {
    const body: any = await res.json()
    const msg = body?.error?.message
    if (typeof msg === 'string' && msg) return msg.replace(/[\r\n]+/g, ' ').slice(0, 160)
  } catch {
  }
  return undefined
}

export function googleApiErrorDetail(res: GoogleApiResult<unknown>): string {
  if (res.ok) return 'error=unknown'
  return res.apiMessage ? `error=${res.error} msg=${res.apiMessage}` : `error=${res.error}`
}

/**
 * callApi 결과 매핑 (B-L9, 5-7) — 실패면 그대로 반환, 성공이면 data를 변환한다.
 * 실패 객체는 재구성하지 않고 그대로 돌려준다: 기존에 일부 호출처가
 * { error, unauthorized }로 재구성해 apiMessage를 떨어뜨렸는데, 호출처가
 * 실패 시 error만 읽으므로 관측 동작은 동일하고 상세는 보존된다.
 */
function mapApiResult<T, U>(res: GoogleApiResult<T>, map: (data: T) => U): GoogleApiResult<U> {
  if (isApiFailure(res)) return res
  return { ok: true, data: map(res.data) }
}

async function callApi<T>(
  fetchFn: typeof fetch,
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<GoogleApiResult<T>> {
  let res: Response
  try {
    res = await fetchFn(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
    })
  } catch {
    return { ok: false, error: 'network_error', unauthorized: false }
  }
  if (res.status === 401) return { ok: false, error: 'unauthorized', unauthorized: true }
  if (res.status === 429) return { ok: false, error: 'rate_limited', unauthorized: false }
  if (res.status === 204) return { ok: true, data: undefined as T }
  if (!res.ok) {
    const apiMessage = await extractGoogleApiMessage(res)
    return { ok: false, error: `google_api_error:${res.status}`, unauthorized: false, ...(apiMessage ? { apiMessage } : {}) }
  }
  try {
    const data = (await res.json()) as T
    return { ok: true, data }
  } catch {
    return { ok: false, error: 'invalid_json', unauthorized: false }
  }
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return found?.value ?? ''
}

function base64urlDecodeToText(input: string): string {
  if (!input) return ''
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(normalized)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

/** Gmail 메시지 payload에서 text/plain 본문을 추출한다 (없으면 snippet으로 대체). */
function extractBodyText(payload: any): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return base64urlDecodeToText(payload.body.data)
  }
  const parts: any[] = payload.parts || []
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return base64urlDecodeToText(part.body.data)
    }
  }
  for (const part of parts) {
    if (part.parts) {
      const nested = extractBodyText(part)
      if (nested) return nested
    }
  }
  return ''
}

function toSummary(raw: any): GmailMessageSummary {
  const headers: Array<{ name: string; value: string }> = raw?.payload?.headers || []
  return {
    id: String(raw?.id ?? ''),
    threadId: String(raw?.threadId ?? ''),
    from: headerValue(headers, 'From'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    snippet: String(raw?.snippet ?? ''),
  }
}

/** Gmail 프로필 조회 — 연동 계정 이메일 확인용. */
export async function getGmailProfile(
  fetchFn: typeof fetch,
  accessToken: string,
): Promise<GoogleApiResult<{ emailAddress: string; messagesTotal: number }>> {
  return callApi<{ emailAddress: string; messagesTotal: number }>(
    fetchFn,
    `${GMAIL_BASE}/users/me/profile`,
    accessToken,
  )
}

/** Gmail 메시지 목록 (헤더+스니펫). 본문은 포함하지 않는다. */
export async function listGmailMessages(
  fetchFn: typeof fetch,
  accessToken: string,
  opts: { q?: string; maxResults?: number } = {},
): Promise<GoogleApiResult<GmailMessageSummary[]>> {
  const max = Math.min(Math.max(opts.maxResults ?? 10, 1), 10) // 전체 스캔 방지 — 최대 10건
  const url = new URL(`${GMAIL_BASE}/users/me/messages`)
  if (opts.q) url.searchParams.set('q', opts.q)
  url.searchParams.set('maxResults', String(max))
  const list = await callApi<{ messages?: Array<{ id: string }> }>(fetchFn, url.toString(), accessToken)
  if (isApiFailure(list)) return list
  const ids = (list.data.messages || []).map((m) => m.id)
  const out: GmailMessageSummary[] = []
  for (const id of ids) {
    const one = await getGmailMessage(fetchFn, accessToken, id, false)
    if (one.ok) out.push(one.data)
  }
  return { ok: true, data: out }
}

/** Gmail 메시지 단건 조회. withBody=false면 본문을 비워 반환한다. */
export async function getGmailMessage(
  fetchFn: typeof fetch,
  accessToken: string,
  messageId: string,
  withBody = true,
): Promise<GoogleApiResult<GmailMessage>> {
  const url = `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  const raw = await callApi<any>(fetchFn, url, accessToken)
  return mapApiResult(raw, (data) => {
    const summary = toSummary(data)
    const bodyText = withBody ? extractBodyText(data?.payload) || summary.snippet : ''
    return { ...summary, bodyText }
  })
}

/** Google 캘린더 이벤트 목록 (기간 지정). */
export async function listCalendarEvents(
  fetchFn: typeof fetch,
  accessToken: string,
  opts: { timeMin: string; timeMax: string; maxResults?: number },
): Promise<GoogleApiResult<CalendarEvent[]>> {
  const max = Math.min(Math.max(opts.maxResults ?? 50, 1), 100)
  const url = new URL(`${CALENDAR_BASE}/calendars/primary/events`)
  url.searchParams.set('timeMin', opts.timeMin)
  url.searchParams.set('timeMax', opts.timeMax)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', String(max))
  const res = await callApi<{ items?: any[] }>(fetchFn, url.toString(), accessToken)
  return mapApiResult(res, (data) => (data.items || []).map(toCalendarEvent))
}

function toCalendarEvent(raw: any): CalendarEvent {
  const start = raw?.start?.dateTime || raw?.start?.date || ''
  const end = raw?.end?.dateTime || raw?.end?.date || ''
  return {
    id: String(raw?.id ?? ''),
    summary: String(raw?.summary ?? '(제목 없음)'),
    description: String(raw?.description ?? ''),
    start,
    end,
    location: String(raw?.location ?? ''),
    attendeeCount: Array.isArray(raw?.attendees) ? raw.attendees.length : 0,
    status: String(raw?.status ?? ''),
  }
}

export interface GmailSendAttachment {
  filename: string
  mime?: string
  bytes: Uint8Array
}

export interface GmailSendInput {
  to: string
  subject: string
  body: string
  attachment?: GmailSendAttachment
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 32768
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function base64UrlEncodeText(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(value))}?=`
}

function buildGmailRaw(input: GmailSendInput): string {
  const boundary = 'myhub_boundary_7f3a9c'
  const lines: string[] = [
    `To: ${input.to}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    'MIME-Version: 1.0',
  ]
  if (input.attachment) {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64', '')
    lines.push(bytesToBase64(new TextEncoder().encode(input.body)))
    lines.push(`--${boundary}`)
    lines.push(`Content-Type: ${input.attachment.mime || 'application/octet-stream'}`)
    lines.push('Content-Transfer-Encoding: base64')
    lines.push(
      `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(input.attachment.filename)}`,
      '',
    )
    lines.push(bytesToBase64(input.attachment.bytes))
    lines.push(`--${boundary}--`)
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64', '')
    lines.push(bytesToBase64(new TextEncoder().encode(input.body)))
  }
  return base64UrlEncodeText(lines.join('\r\n'))
}

export async function sendGmailMessage(
  fetchFn: typeof fetch,
  accessToken: string,
  input: GmailSendInput,
): Promise<GoogleApiResult<{ id: string }>> {
  const res = await callApi<{ id: string }>(
    fetchFn,
    `${GMAIL_BASE}/users/me/messages/send`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: buildGmailRaw(input) }),
    },
  )
  return res
}

export interface CalendarEventInput {
  summary: string
  start: string
  end?: string
  description?: string
  location?: string
  recurrence?: string[]
}

function toCalendarEventBody(input: CalendarEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.summary,
    start: { dateTime: input.start, timeZone: KST_TIME_ZONE },
    end: { dateTime: input.end || input.start, timeZone: KST_TIME_ZONE },
  }
  if (input.description) body.description = input.description
  if (input.location) body.location = input.location
  if (input.recurrence && input.recurrence.length > 0) body.recurrence = input.recurrence
  return body
}

export function isGoogleNotFoundError(res: GoogleApiResult<unknown>): boolean {
  return !res.ok && (res.error === 'google_api_error:404' || res.error === 'google_api_error:410')
}

/**
 * Google 캘린더 일정 생성.
 * 호출 전 반드시 scope에 calendar.events가 있는지 확인할 것 (google-tokens.hasCalendarWriteScope).
 */
export async function createCalendarEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  input: CalendarEventInput,
): Promise<GoogleApiResult<CalendarEvent>> {
  const url = `${CALENDAR_BASE}/calendars/primary/events`
  const res = await callApi<any>(fetchFn, url, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toCalendarEventBody(input)),
  })
  return mapApiResult(res, toCalendarEvent)
}

export async function updateCalendarEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  eventId: string,
  input: CalendarEventInput,
): Promise<GoogleApiResult<CalendarEvent>> {
  const url = `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`
  const res = await callApi<any>(fetchFn, url, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toCalendarEventBody(input)),
  })
  return mapApiResult(res, toCalendarEvent)
}

export async function deleteCalendarEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  eventId: string,
): Promise<GoogleApiResult<{ deleted: boolean }>> {
  const url = `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`
  const res = await callApi<any>(fetchFn, url, accessToken, { method: 'DELETE' })
  return mapApiResult(res, () => ({ deleted: true }))
}
