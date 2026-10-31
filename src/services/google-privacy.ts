/**
 * 연동 데이터 개인정보 경계 — AI 전송 전 정제
 *
 * 설계: docs/gmail-calendar-design.md §5
 * - 잠긴 메모의 차단 원칙을 메일·일정에도 적용한다.
 * - 메일·일정은 기본적으로 민감 정보로 취급한다.
 * - 모든 AI 전송 경로는 이 파일의 sanitize 함수만 통한다 (우회 금지).
 * - 첨부파일은 절대 전송하지 않는다. 참석자 이메일은 보내지 않고 수만 전달한다.
 */

import { maskSecrets } from './secret-mask'
import type { GmailMessage, GmailMessageSummary, CalendarEvent } from './google-client'

// AI 전송 시 메일 본문 최대 길이 (넘으면 자른다)
export const AI_MAIL_BODY_MAX_CHARS = 2000
export const AI_EVENT_DESC_MAX_CHARS = 500
// 검색은 전체 스캔이 아니라 질의·기간으로 제한하고 최대 10건까지만 AI에 넘긴다
export const AI_MAX_ITEMS = 10

export interface SanitizedGmailMessage {
  id: string
  from: string
  subject: string
  date: string
  snippet: string
  body: string
  maskedCount: number
}

export interface SanitizedCalendarEvent {
  id: string
  summary: string
  start: string
  end: string
  location: string
  description: string
  attendeeCount: number
  maskedCount: number
}

function mask(text: string): { masked: string; count: number } {
  return maskSecrets(text || '')
}

/** Gmail 메시지 AI 전송용 정제 — 본문 절단 + 시크릿 마스킹. 첨부파일은 포함하지 않는다. */
export function sanitizeGmailMessageForAI(
  msg: GmailMessage | GmailMessageSummary,
  opts: { withBody?: boolean } = {},
): SanitizedGmailMessage {
  const bodyRaw = 'bodyText' in msg && opts.withBody !== false ? msg.bodyText || '' : ''
  const body = bodyRaw.slice(0, AI_MAIL_BODY_MAX_CHARS)
  const from = mask(msg.from)
  const subject = mask(msg.subject)
  const snippet = mask(msg.snippet)
  const bodyMasked = mask(body)
  return {
    id: msg.id,
    from: from.masked,
    subject: subject.masked,
    date: msg.date,
    snippet: snippet.masked,
    body: bodyMasked.masked,
    maskedCount: from.count + subject.count + snippet.count + bodyMasked.count,
  }
}

/**
 * 캘린더 이벤트 AI 전송용 정제.
 * - 참석자 이메일 주소는 보내지 않는다 (attendeeCount만).
 * - 설명은 500자로 절단 + 마스킹.
 */
export function sanitizeCalendarEventForAI(ev: CalendarEvent): SanitizedCalendarEvent {
  const summary = mask(ev.summary)
  const location = mask(ev.location)
  const description = mask((ev.description || '').slice(0, AI_EVENT_DESC_MAX_CHARS))
  return {
    id: ev.id,
    summary: summary.masked,
    start: ev.start,
    end: ev.end,
    location: location.masked,
    description: description.masked,
    attendeeCount: ev.attendeeCount,
    maskedCount: summary.count + location.count + description.count,
  }
}

/** AI 전송용 목록 정제 — 최대 AI_MAX_ITEMS건까지만 넘긴다. */
export function sanitizeGmailListForAI(
  messages: Array<GmailMessage | GmailMessageSummary>,
): SanitizedGmailMessage[] {
  return messages.slice(0, AI_MAX_ITEMS).map((m) => sanitizeGmailMessageForAI(m))
}

export function sanitizeCalendarListForAI(events: CalendarEvent[]): SanitizedCalendarEvent[] {
  return events.slice(0, AI_MAX_ITEMS).map((e) => sanitizeCalendarEventForAI(e))
}
