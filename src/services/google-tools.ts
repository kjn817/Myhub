/**
 * Google 연동 AI 도구 — 마커 파싱 + 실행
 *
 * 마커:
 * - [GMAIL_SEARCH]{"q": "검색어"}[/GMAIL_SEARCH] — 메일 검색 (읽기)
 * - [GMAIL_GET]{"id": "..."}[/GMAIL_GET] — 메일 단건 조회 (읽기)
 * - [GCAL_LIST]{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}[/GCAL_LIST] — 캘린더 조회 (읽기)
 * - [GCAL_CREATE]{"title": "...", "start_at": "..."}[/GCAL_CREATE] — 캘린더 일정 생성 (쓰기)
 *
 * 규칙:
 * - 토큰이 없으면 안내 문장을 반환하고 기존 로컬 기능에는 영향을 주지 않는다.
 * - GCAL_LIST는 로컬 일정 + Google 이벤트를 합쳐서 반환한다 (출처를 구분해 표시).
 * - 모든 반환 데이터는 google-privacy sanitize를 거친다.
 * - GCAL_CREATE는 쓰기 도구 — authorizeTool 게이트를 거치고, scope에
 *   calendar.events가 없으면 scope_missing으로 거부한다 (설계 §3 결정 필요).
 */

import {
  getValidAccessToken,
  hasCalendarWriteScope,
  hasGmailSendScope,
  type GoogleTokenEnv,
} from './google-tokens'
import {
  listGmailMessages,
  getGmailMessage,
  listCalendarEvents,
  createCalendarEvent,
  sendGmailMessage,
  type GmailSendInput,
} from './google-client'
import { isGoogleWriteEnabled } from './google-oauth'
import {
  sanitizeGmailListForAI,
  sanitizeGmailMessageForAI,
  sanitizeCalendarListForAI,
} from './google-privacy'
import { executeScheduleList } from './schedule-tools'
import { parseJsonMarkers } from '../lib/markers'

export const GOOGLE_NOT_CONNECTED_MESSAGE =
  'Google 연동이 안 되어 있어요. 설정 메뉴의 Google 연동에서 계정을 연결하면 Gmail·캘린더를 함께 볼 수 있어요.'

export const GOOGLE_RECONNECT_MESSAGE =
  'Google 연동이 끊어졌어요. 설정 메뉴의 Google 연동에서 계정을 다시 연결해 주세요.'

export type GoogleMarker =
  | { full: string; action: 'gmail_search'; data: { q?: string } }
  | { full: string; action: 'gmail_get'; data: { id?: string } }
  | { full: string; action: 'gcal_list'; data: { from?: string; to?: string } }
  | { full: string; action: 'gcal_create'; data: { title?: string; start_at?: string; end_at?: string; description?: string; location?: string } }

function parseMarker(
  text: string,
  name: string,
): Array<{ full: string; data: Record<string, unknown> }> {
  const re = new RegExp(`\\[${name}\\]([\\s\\S]*?)\\[\\/${name}\\]`, 'gi')
  return parseJsonMarkers(
    text,
    re,
    (data, full) =>
      data && typeof data === 'object' ? { full, data: data as Record<string, unknown> } : null,
    3,
  )
}

export function parseGoogleMarkers(text: string): GoogleMarker[] {
  const out: GoogleMarker[] = []
  for (const { full, data } of parseMarker(text, 'GMAIL_SEARCH')) {
    out.push({ full, action: 'gmail_search', data: { q: typeof data.q === 'string' ? data.q : undefined } })
  }
  for (const { full, data } of parseMarker(text, 'GMAIL_GET')) {
    if (typeof data.id === 'string' && data.id) out.push({ full, action: 'gmail_get', data: { id: data.id } })
  }
  for (const { full, data } of parseMarker(text, 'GCAL_LIST')) {
    out.push({
      full,
      action: 'gcal_list',
      data: {
        from: typeof data.from === 'string' ? data.from : undefined,
        to: typeof data.to === 'string' ? data.to : undefined,
      },
    })
  }
  for (const { full, data } of parseMarker(text, 'GCAL_CREATE')) {
    if (typeof data.title === 'string' && data.title.trim()) {
      out.push({
        full,
        action: 'gcal_create',
        data: {
          title: data.title,
          start_at: typeof data.start_at === 'string' ? data.start_at : undefined,
          end_at: typeof data.end_at === 'string' ? data.end_at : undefined,
          description: typeof data.description === 'string' ? data.description : undefined,
          location: typeof data.location === 'string' ? data.location : undefined,
        },
      })
    }
  }
  return out
}

export interface GoogleToolEnv extends GoogleTokenEnv {
  DB: D1Database
}

type ToolResult<T> =
  | { success: true; data: T }
  | {
      success: false
      error:
        | 'not_connected'
        | 'revoked'
        | 'refresh_failed'
        | 'api_error'
        | 'scope_missing'
        | 'invalid_input'
        | 'write_disabled'
    }

function toKstDateString(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 메일 검색 — 질의가 없으면 읽지 않은 메일만 본다. */
export async function executeGmailSearch(
  env: GoogleToolEnv,
  data: { q?: string },
  fetchFn: typeof fetch = fetch,
): Promise<ToolResult<ReturnType<typeof sanitizeGmailListForAI>>> {
  const token = await getValidAccessToken(fetchFn, env)
  if (!token.ok) return { success: false, error: token.reason }
  const q = (data.q || '').trim()
  const res = await listGmailMessages(fetchFn, token.accessToken, { q: q || 'is:unread' })
  if (!res.ok) {
    if (res.unauthorized) return { success: false, error: 'revoked' }
    return { success: false, error: 'api_error' }
  }
  return { success: true, data: sanitizeGmailListForAI(res.data) }
}

/** 메일 단건 조회 — 본문 포함 (절단·마스킹 적용). */
export async function executeGmailGet(
  env: GoogleToolEnv,
  data: { id?: string },
  fetchFn: typeof fetch = fetch,
): Promise<ToolResult<ReturnType<typeof sanitizeGmailMessageForAI>>> {
  if (!data.id) return { success: false, error: 'invalid_input' }
  const token = await getValidAccessToken(fetchFn, env)
  if (!token.ok) return { success: false, error: token.reason }
  const res = await getGmailMessage(fetchFn, token.accessToken, data.id, true)
  if (!res.ok) {
    if (res.unauthorized) return { success: false, error: 'revoked' }
    return { success: false, error: 'api_error' }
  }
  return { success: true, data: sanitizeGmailMessageForAI(res.data) }
}

export interface MergedScheduleItem {
  source: 'local' | 'google'
  title: string
  start_at: string
  end_at: string | null
  location: string
}

/**
 * 일정 조회 — 로컬 일정 + Google 캘린더 이벤트를 합쳐서 시간순으로 반환한다.
 * - 미연동 시 로컬 일정만 반환한다 (기존 기능 영향 없음).
 * - Google API 실패 시에도 로컬 일정은 반환한다 (fail-soft).
 * - 두 출처는 합치지 않는다 (제목·시간이 같아도 별개 행).
 */
export async function executeGcalList(
  env: GoogleToolEnv,
  data: { from?: string; to?: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ success: true; data: MergedScheduleItem[]; googleConnected: boolean; error?: string }> {
  const today = toKstDateString(new Date())
  const from = data.from || today
  const to = data.to || from
  const local = await executeScheduleList(env, { from, to }).catch(() => ({ success: false, data: [] }))
  const items: MergedScheduleItem[] = (local.success ? local.data : []).map((s: any) => ({
    source: 'local' as const,
    title: String(s.title || ''),
    start_at: String(s.start_at || ''),
    end_at: s.end_at ? String(s.end_at) : null,
    location: String(s.location || ''),
  }))

  const token = await getValidAccessToken(fetchFn, env)
  if (!token.ok) {
    return { success: true, data: items, googleConnected: false }
  }
  const res = await listCalendarEvents(fetchFn, token.accessToken, {
    timeMin: `${from}T00:00:00+09:00`,
    timeMax: `${to}T23:59:59+09:00`,
  })
  if (!res.ok) {
    return { success: true, data: items, googleConnected: true }
  }
  const sanitized = sanitizeCalendarListForAI(res.data)
  for (const ev of sanitized) {
    items.push({
      source: 'google',
      title: ev.summary,
      start_at: ev.start,
      end_at: ev.end || null,
      location: ev.location,
    })
  }
  items.sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0))
  return { success: true, data: items, googleConnected: true }
}

export async function executeGmailSend(
  env: GoogleToolEnv,
  data: GmailSendInput,
  fetchFn: typeof fetch = fetch,
): Promise<ToolResult<{ id: string }>> {
  if (!data.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.to) || !data.subject || !data.body) {
    return { success: false, error: 'invalid_input' }
  }
  if (!isGoogleWriteEnabled(env)) return { success: false, error: 'write_disabled' }
  const token = await getValidAccessToken(fetchFn, env)
  if (!token.ok) return { success: false, error: token.reason }
  if (!hasGmailSendScope(token.tokens)) return { success: false, error: 'scope_missing' }
  const res = await sendGmailMessage(fetchFn, token.accessToken, data)
  if (!res.ok) {
    if (res.unauthorized) return { success: false, error: 'revoked' }
    return { success: false, error: 'api_error' }
  }
  return { success: true, data: { id: res.data.id } }
}

/** 캘린더 일정 생성 — 쓰기 scope가 없으면 scope_missing으로 거부한다. */
export async function executeGcalCreate(
  env: GoogleToolEnv,
  data: { title?: string; start_at?: string; end_at?: string; description?: string; location?: string },
  fetchFn: typeof fetch = fetch,
): Promise<ToolResult<{ id: string; summary: string; start: string }>> {
  const title = (data.title || '').trim()
  if (!title || !data.start_at) return { success: false, error: 'invalid_input' }
  const token = await getValidAccessToken(fetchFn, env)
  if (!token.ok) return { success: false, error: token.reason }
  if (!hasCalendarWriteScope(token.tokens)) return { success: false, error: 'scope_missing' }
  const res = await createCalendarEvent(fetchFn, token.accessToken, {
    summary: title,
    start: data.start_at,
    end: data.end_at,
    description: data.description,
    location: data.location,
  })
  if (!res.ok) {
    if (res.unauthorized) return { success: false, error: 'revoked' }
    return { success: false, error: 'api_error' }
  }
  return { success: true, data: { id: res.data.id, summary: res.data.summary, start: res.data.start } }
}
