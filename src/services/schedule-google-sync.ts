import type { GoogleTokenEnv } from './google-tokens';
import { getValidAccessToken, hasCalendarWriteScope } from './google-tokens';
import { isGoogleWriteEnabled } from './google-oauth';
import { TokenVault, classifyLevel } from './privacy-engine';
import { googleApiErrorDetail, isGoogleNotFoundError, updateCalendarEvent, deleteCalendarEvent } from './google-client';
import {
  CALENDAR_API_BASE,
  callCalendarApi,
  createMarkedCalendarEvent,
  deterministicGoogleEventId,
  type MarkedEventInput,
} from './schedule-google-events';
import { findMarkedCalendarEvent } from './schedule-google-events';

const BACKFILL_LIMIT = 100;

export interface ScheduleSyncRow {
  id: number;
  title: string;
  description?: string | null;
  location?: string | null;
  start_at: string;
  end_at?: string | null;
  recurrence_rule?: string | null;
  google_event_id?: string | null;
  google_sync_status?: string | null;
}

export type PushScheduleResult =
  | { state: 'created' | 'updated'; privacyRedacted?: string[] }
  | { state: 'skipped' | 'failed'; reason: string };

export type RemoveScheduleResult = { state: 'deleted' } | { state: 'skipped' | 'failed'; reason: string };

export interface BackfillResult {
  ran: boolean;
  scanned: number;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  skipped: number;
  reason?: string;
}

async function logSync(env: GoogleTokenEnv, status: string, detail: string): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO google_sync_log (provider, kind, status, detail) VALUES (?, ?, ?, ?)'
    ).bind('google', 'calendar', status, detail.slice(0, 500)).run();
  } catch {
    // 로그 기록 실패는 무시한다.
  }
}

async function markScheduleSyncStatus(env: GoogleTokenEnv, id: number, status: string, error?: string): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE schedules SET google_sync_status = ?, google_sync_last_error = ?, google_sync_updated_at = datetime('now') WHERE id = ?",
    )
      .bind(status, error ? error.slice(0, 300) : null, id)
      .run();
  } catch {
    // 상태 기록 실패는 무시한다.
  }
}

type WriteGate = { accessToken: string } | { reason: string };

async function passWriteGate(fetchFn: typeof fetch, env: GoogleTokenEnv): Promise<WriteGate> {
  if (!isGoogleWriteEnabled(env)) return { reason: 'write_disabled' };
  const token = await getValidAccessToken(fetchFn, env);
  if (!token.ok) return { reason: token.reason };
  if (!hasCalendarWriteScope(token.tokens)) return { reason: 'scope_missing' };
  return { accessToken: token.accessToken };
}

function toRfc3339(s: string): string {
  if (!s) return s;
  let out = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(out)) out += 'T00:00:00';
  else if (/T\d{2}:\d{2}$/.test(out)) out += ':00';
  if (!/([zZ]|[+-]\d{2}:\d{2})$/.test(out)) out += '+09:00';
  return out;
}

function sanitizeScheduleForGoogleSync(s: ScheduleSyncRow): {
  schedule: ScheduleSyncRow;
  redactedFields: string[];
  maxLevel: number;
} {
  const vault = new TokenVault();
  const redactedFields: string[] = [];
  let maxLevel = 0;
  const clean = (field: string, value: string | null | undefined): string | null | undefined => {
    if (!value) return value;
    const { level } = classifyLevel({ text: value });
    if (level > maxLevel) maxLevel = level;
    if (level < 3) return value;
    redactedFields.push(field);
    return vault.sanitize(value).text;
  };
  return {
    schedule: {
      ...s,
      title: clean('title', s.title) ?? s.title,
      description: clean('description', s.description),
      location: clean('location', s.location),
    },
    redactedFields,
    maxLevel,
  };
}

function toEventInput(s: ScheduleSyncRow): MarkedEventInput {
  return {
    summary: s.title,
    start: toRfc3339(s.start_at),
    end: toRfc3339(s.end_at || s.start_at),
    description: s.description || void 0,
    location: s.location || void 0,
    recurrence: s.recurrence_rule ? [`RRULE:${s.recurrence_rule}`] : void 0,
  };
}

export async function pushScheduleDetailed(fetchFn: typeof fetch, env: GoogleTokenEnv, s: ScheduleSyncRow): Promise<PushScheduleResult> {
  try {
    const gate = await passWriteGate(fetchFn, env);
    if ('reason' in gate) {
      await logSync(env, 'skipped', `schedule=${s.id} op=push reason=${gate.reason}`);
      if (s.google_event_id) await markScheduleSyncStatus(env, s.id, 'pending', gate.reason);
      return { state: 'skipped', reason: gate.reason };
    }
    const { schedule: syncTarget, redactedFields } = sanitizeScheduleForGoogleSync(s);
    const privacyNote = redactedFields.length > 0 ? ` privacy=l3_redacted:${redactedFields.join('+')}` : '';
    const input = toEventInput(syncTarget);
    if (s.google_event_id) {
      const upd = await updateCalendarEvent(fetchFn, gate.accessToken, s.google_event_id, input);
      if (upd.ok) {
        await markScheduleSyncStatus(env, s.id, 'synced');
        await logSync(env, 'ok', `schedule=${s.id} op=update google_event=${s.google_event_id}${privacyNote}`);
        return redactedFields.length > 0 ? { state: 'updated', privacyRedacted: redactedFields } : { state: 'updated' };
      }
      if (!isGoogleNotFoundError(upd)) {
        await markScheduleSyncStatus(env, s.id, 'failed', upd.error);
        await logSync(env, 'failed', `schedule=${s.id} op=update ${googleApiErrorDetail(upd)}`);
        return { state: 'failed', reason: 'api_error' };
      }
    }
    const found = await findMarkedCalendarEvent(fetchFn, gate.accessToken, s.id);
    if (!found.ok) {
      await markScheduleSyncStatus(env, s.id, 'failed', found.error);
      await logSync(env, 'failed', `schedule=${s.id} op=create_lookup ${googleApiErrorDetail(found)}`);
      return { state: 'failed', reason: 'api_error' };
    }
    let linkedEventId = found.data;
    let recovered = found.data !== null;
    if (linkedEventId) {
      const upd = await updateCalendarEvent(fetchFn, gate.accessToken, linkedEventId, input);
      if (!upd.ok && !isGoogleNotFoundError(upd)) {
        await markScheduleSyncStatus(env, s.id, 'failed', upd.error);
        await logSync(env, 'failed', `schedule=${s.id} op=recover ${googleApiErrorDetail(upd)}`);
        return { state: 'failed', reason: 'api_error' };
      }
      if (!upd.ok) {
        linkedEventId = null;
        recovered = false;
      }
    }
    if (!linkedEventId) {
      const created = await createMarkedCalendarEvent(fetchFn, gate.accessToken, input, s.id, true);
      if (!created.ok && created.error === 'google_api_error:409') {
        const detId = deterministicGoogleEventId(s.id);
        const existing = await callCalendarApi(
          fetchFn,
          gate.accessToken,
          `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(detId)}`,
        );
        if (existing.ok && existing.data?.id && existing.data.status !== 'cancelled') {
          const upd = await updateCalendarEvent(fetchFn, gate.accessToken, String(existing.data.id), input);
          if (upd.ok) {
            linkedEventId = String(existing.data.id);
            recovered = true;
          } else if (!isGoogleNotFoundError(upd)) {
            await markScheduleSyncStatus(env, s.id, 'failed', upd.error);
            await logSync(env, 'failed', `schedule=${s.id} op=recover ${googleApiErrorDetail(upd)}`);
            return { state: 'failed', reason: 'api_error' };
          }
        }
        if (!linkedEventId) {
          const retry = await createMarkedCalendarEvent(fetchFn, gate.accessToken, input, s.id, false);
          if (!retry.ok) {
            await markScheduleSyncStatus(env, s.id, 'failed', retry.error);
            await logSync(env, 'failed', `schedule=${s.id} op=create ${googleApiErrorDetail(retry)}`);
            return { state: 'failed', reason: 'api_error' };
          }
          linkedEventId = retry.data.id;
        }
      } else if (!created.ok) {
        await markScheduleSyncStatus(env, s.id, 'failed', created.error);
        await logSync(env, 'failed', `schedule=${s.id} op=create ${googleApiErrorDetail(created)}`);
        return { state: 'failed', reason: 'api_error' };
      } else {
        linkedEventId = created.data.id;
      }
    }
    try {
      await env.DB.prepare(
        "UPDATE schedules SET google_event_id = ?, google_sync_status = 'synced', google_sync_last_error = NULL, google_sync_updated_at = datetime('now') WHERE id = ?",
      )
        .bind(linkedEventId, s.id)
        .run();
    } catch {
      await env.DB.prepare('UPDATE schedules SET google_event_id = ? WHERE id = ?').bind(linkedEventId, s.id).run();
    }
    await logSync(
      env,
      'ok',
      `schedule=${s.id} op=${recovered ? 'recover' : 'create'} google_event=${linkedEventId}${privacyNote}`
    );
    return redactedFields.length > 0 ? { state: 'created', privacyRedacted: redactedFields } : { state: 'created' };
  } catch {
    await markScheduleSyncStatus(env, s.id, 'failed', 'exception');
    await logSync(env, 'failed', `schedule=${s.id} op=push error=exception`);
    return { state: 'failed', reason: 'exception' };
  }
}

export async function removeScheduleDetailed(
  fetchFn: typeof fetch,
  env: GoogleTokenEnv,
  s: Pick<ScheduleSyncRow, 'id' | 'google_event_id'>,
): Promise<RemoveScheduleResult> {
  if (!s.google_event_id) return { state: 'skipped', reason: 'no_google_event' };
  try {
    const gate = await passWriteGate(fetchFn, env);
    if ('reason' in gate) {
      await logSync(env, 'skipped', `schedule=${s.id} op=delete reason=${gate.reason}`);
      await markScheduleSyncStatus(env, s.id, 'delete_pending', gate.reason);
      return { state: 'skipped', reason: gate.reason };
    }
    const res = await deleteCalendarEvent(fetchFn, gate.accessToken, s.google_event_id);
    if (res.ok || isGoogleNotFoundError(res)) {
      await logSync(env, 'ok', `schedule=${s.id} op=delete google_event=${s.google_event_id}`);
      return { state: 'deleted' };
    }
    await markScheduleSyncStatus(env, s.id, 'delete_pending', res.error);
    await logSync(env, 'failed', `schedule=${s.id} op=delete ${googleApiErrorDetail(res)}`);
    return { state: 'failed', reason: 'api_error' };
  } catch {
    await markScheduleSyncStatus(env, s.id, 'delete_pending', 'exception');
    await logSync(env, 'failed', `schedule=${s.id} op=delete error=exception`);
    return { state: 'failed', reason: 'exception' };
  }
}

export async function backfillUnsyncedSchedules(
  fetchFn: typeof fetch,
  env: GoogleTokenEnv,
  opts: { limit?: number } = {},
): Promise<BackfillResult> {
  const base: BackfillResult = {
    ran: false,
    scanned: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
  };
  const gate = await passWriteGate(fetchFn, env).catch((): WriteGate => ({ reason: 'refresh_failed' }));
  if ('reason' in gate) {
    await logSync(env, 'skipped', `op=backfill reason=${gate.reason}`);
    return { ...base, reason: gate.reason };
  }
  const limit = Math.min(Math.max(opts.limit ?? BACKFILL_LIMIT, 1), BACKFILL_LIMIT);
  let rows: ScheduleSyncRow[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id, title, description, location, start_at, end_at, recurrence_rule, google_event_id, google_sync_status
       FROM schedules
       WHERE google_event_id IS NULL OR google_sync_status IN ('pending', 'failed', 'delete_pending')
       ORDER BY start_at ASC LIMIT ?`,
    )
      .bind(limit)
      .all();
    rows = (r.results || []) as unknown as ScheduleSyncRow[];
  } catch {
    try {
      const r = await env.DB.prepare(
        `SELECT id, title, description, location, start_at, end_at, recurrence_rule, google_event_id
         FROM schedules WHERE google_event_id IS NULL ORDER BY start_at ASC LIMIT ?`,
      )
        .bind(limit)
        .all();
      rows = (r.results || []) as unknown as ScheduleSyncRow[];
    } catch {
      return { ...base, reason: 'query_failed' };
    }
  }
  const out: BackfillResult = { ...base, ran: true, scanned: rows.length };
  for (const row of rows) {
    if (row.google_sync_status === 'delete_pending') {
      const del = await removeScheduleDetailed(fetchFn, env, row);
      if (del.state === 'deleted') {
        try {
          await env.DB.prepare('DELETE FROM reminders WHERE schedule_id = ?').bind(row.id).run();
          await env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(row.id).run();
          out.deleted++;
        } catch {
          out.failed++;
        }
      } else if (del.state === 'skipped') out.skipped++;
      else out.failed++;
      continue;
    }
    const pushed = await pushScheduleDetailed(fetchFn, env, row);
    if (pushed.state === 'created') out.created++;
    else if (pushed.state === 'updated') out.updated++;
    else if (pushed.state === 'skipped') out.skipped++;
    else out.failed++;
  }
  await logSync(
    env,
    out.failed > 0 ? 'failed' : 'ok',
    `op=backfill scanned=${out.scanned} created=${out.created} updated=${out.updated} deleted=${out.deleted} failed=${out.failed} skipped=${out.skipped}`,
  );
  return out;
}

export async function getScheduleSyncCounts(
  env: GoogleTokenEnv,
): Promise<{ pending: number; failed: number; deletePending: number; unsynced: number } | null> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT google_sync_status AS st, COUNT(*) AS n FROM schedules GROUP BY google_sync_status'
    ).bind().all();
    const by = new Map<string, number>((results || []).map((r) => [r.st as string, Number(r.n) || 0] as [string, number]));
    const pending = by.get('pending') || 0;
    const failed = by.get('failed') || 0;
    const deletePending = by.get('delete_pending') || 0;
    return { pending, failed, deletePending, unsynced: pending + failed + deletePending };
  } catch {
    return null;
  }
}
