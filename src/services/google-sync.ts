/**
 * Google 동기화 — Cron pull (주기적 가져오기)
 *
 * 설계: docs/gmail-calendar-design.md §6
 * - Cloudflare Cron 트리거(5분 틱)에서 30분에 1회만 실행한다 (KV 마커로 간격 제어).
 * - 가져오는 것: 오늘~내일 캘린더 이벤트 수 + 읽지 않은 메일 수 (헤더만).
 *   본문 전문은 가져오지 않고, D1에는 건수·상태만 로그로 남긴다.
 * - 어떤 오류도 호출자를 깨지 않는다 (fail-soft).
 */

import { getValidAccessToken, type GoogleTokenEnv } from './google-tokens'
import { listCalendarEvents, listGmailMessages } from './google-client'
import { isGoogleWriteEnabled } from './google-oauth'
import { backfillUnsyncedSchedules } from './schedule-google-sync'

export const GOOGLE_SYNC_INTERVAL_MS = 30 * 60 * 1000
const SYNC_LAST_KEY = 'google:sync:last'

export interface GoogleSyncEnv extends GoogleTokenEnv {
  KV?: KVNamespace
}

export interface SyncResult {
  ran: boolean
  reason?: string
  calendarCount?: number
  unreadCount?: number
  backfill?: Awaited<ReturnType<typeof backfillUnsyncedSchedules>>
}

function toKstDateString(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function logSync(
  env: GoogleSyncEnv,
  kind: 'calendar' | 'gmail' | 'token_refresh',
  status: 'ok' | 'failed' | 'skipped',
  detail: string,
): Promise<void> {
  return recordGoogleSyncLog(env, kind, status, detail)
}

export async function recordGoogleSyncLog(
  env: GoogleSyncEnv,
  kind: 'calendar' | 'gmail' | 'token_refresh',
  status: 'ok' | 'failed' | 'skipped',
  detail: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO google_sync_log (provider, kind, status, detail) VALUES (?, ?, ?, ?)',
    )
      .bind('google', kind, status, detail.slice(0, 500))
      .run()
  } catch {
    // 로그 실패가 동기화를 깨지 않는다
  }
}

/** 마지막 동기화 마커 조회 — KV가 없으면 간격 제어를 건너뛴다. */
async function lastSyncAt(env: GoogleSyncEnv): Promise<number> {
  try {
    const raw = await env.KV?.get(SYNC_LAST_KEY)
    return raw ? Number(raw) || 0 : 0
  } catch {
    return 0
  }
}

async function markSync(env: GoogleSyncEnv, now: number): Promise<void> {
  try {
    await env.KV?.put(SYNC_LAST_KEY, String(now))
  } catch {
    // 마커 저장 실패는 무시 — 다음 틱에 다시 시도한다
  }
}

/**
 * 동기화 1회 실행.
 * - 미연동이면 { ran:false, reason:'not_connected' }.
 * - 간격(30분) 이내면 { ran:false, reason:'too_soon' }.
 * - 성공 시 마커를 갱신하고 로그를 남긴다.
 */
export async function syncGoogleNow(
  fetchFn: typeof fetch,
  env: GoogleSyncEnv,
  opts: { now?: number; force?: boolean } = {},
): Promise<SyncResult> {
  const now = opts.now ?? Date.now()
  const token = await getValidAccessToken(fetchFn, env)
  if (!token.ok) {
    const status = token.reason === 'not_connected' ? 'skipped' : 'failed'
    await logSync(
      env,
      'token_refresh',
      status,
      `reason=${token.reason}${token.reason === 'revoked' ? ' reauth_required=true' : ''}`,
    )
    return { ran: false, reason: token.reason === 'not_connected' ? 'not_connected' : token.reason }
  }
  if (!opts.force) {
    const last = await lastSyncAt(env)
    if (now - last < GOOGLE_SYNC_INTERVAL_MS) {
      return { ran: false, reason: 'too_soon' }
    }
  }

  const today = toKstDateString(new Date(now))
  const tomorrow = toKstDateString(new Date(now + 24 * 60 * 60 * 1000))
  let calendarCount = 0
  let unreadCount = 0

  const cal = await listCalendarEvents(fetchFn, token.accessToken, {
    timeMin: `${today}T00:00:00+09:00`,
    timeMax: `${tomorrow}T23:59:59+09:00`,
  })
  if (cal.ok) {
    calendarCount = cal.data.length
    await logSync(env, 'calendar', 'ok', `events=${calendarCount} from=${today} to=${tomorrow}`)
  } else {
    await logSync(env, 'calendar', 'failed', cal.error)
    return { ran: false, reason: 'api_error' }
  }

  const mail = await listGmailMessages(fetchFn, token.accessToken, { q: 'is:unread', maxResults: 10 })
  if (mail.ok) {
    unreadCount = mail.data.length
    await logSync(env, 'gmail', 'ok', `unread=${unreadCount}`)
  } else {
    await logSync(env, 'gmail', 'failed', mail.error)
    return { ran: false, reason: 'api_error' }
  }

  await markSync(env, now)
  const result: SyncResult = { ran: true, calendarCount, unreadCount }
  if (isGoogleWriteEnabled(env)) {
    try {
      const backfill = await backfillUnsyncedSchedules(fetchFn, env)
      if (backfill.scanned > 0) result.backfill = backfill
    } catch {
      await logSync(env, 'calendar', 'failed', 'op=backfill error=exception')
    }
  }
  return result
}

/** 마지막 동기화 로그 조회 (상태 API용). */
export async function getLastSyncLog(
  env: GoogleSyncEnv,
): Promise<Array<{ kind: string; status: string; detail: string; created_at: string }>> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT kind, status, detail, created_at FROM google_sync_log ORDER BY id DESC LIMIT 5',
    )
      .bind()
      .all()
    return (results || []) as Array<{ kind: string; status: string; detail: string; created_at: string }>
  } catch {
    return []
  }
}
