import { extractGoogleApiMessage } from './google-client';
import { KST_TIME_ZONE } from '../lib/kst';

export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_SCHEDULE_PROP = 'myhub_schedule_id';

export interface CalendarApiData {
  id?: unknown;
  status?: unknown;
  items?: unknown;
  nextPageToken?: unknown;
  [key: string]: unknown;
}

export type CalendarApiResult<T = CalendarApiData> =
  | { ok: true; data: T }
  | { ok: false; error: string; unauthorized: boolean; apiMessage?: string };

export interface MarkedEventInput {
  summary: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
  recurrence?: string[];
}

export function deterministicGoogleEventId(scheduleId: number): string {
  return `mh${String(scheduleId).padStart(5, '0')}`;
}

export async function callCalendarApi(
  fetchFn: typeof fetch,
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<CalendarApiResult<any>> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...((init?.headers as Record<string, string> | undefined) || {}),
      },
    });
  } catch {
    return { ok: false, error: 'network_error', unauthorized: false };
  }
  if (res.status === 401) return { ok: false, error: 'unauthorized', unauthorized: true };
  if (res.status === 429) return { ok: false, error: 'rate_limited', unauthorized: false };
  if (res.status === 204) return { ok: true, data: null };
  if (!res.ok) {
    const apiMessage = await extractGoogleApiMessage(res);
    return { ok: false, error: `google_api_error:${res.status}`, unauthorized: false, ...(apiMessage ? { apiMessage } : {}) };
  }
  try {
    return { ok: true, data: (await res.json()) as CalendarApiData };
  } catch {
    return { ok: false, error: 'invalid_json', unauthorized: false };
  }
}

interface MarkedEventResource {
  id?: unknown;
  status?: unknown;
  extendedProperties?: { private?: Record<string, string> };
}

export async function findMarkedCalendarEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  scheduleId: number,
): Promise<CalendarApiResult<string | null>> {
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${CALENDAR_API_BASE}/calendars/primary/events`);
    url.searchParams.set('privateExtendedProperty', `${GOOGLE_SCHEDULE_PROP}=${scheduleId}`);
    url.searchParams.set('showDeleted', 'false');
    url.searchParams.set('maxResults', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await callCalendarApi(fetchFn, accessToken, url.toString());
    if (!res.ok) return res;
    const items = (Array.isArray(res.data?.items) ? res.data.items : []) as MarkedEventResource[];
    const hit = items.find(
      (it) =>
        it &&
        typeof it.id === 'string' &&
        it.id.length > 0 &&
        it.status !== 'cancelled' &&
        it.extendedProperties?.private?.[GOOGLE_SCHEDULE_PROP] === String(scheduleId),
    );
    if (hit) return { ok: true, data: String(hit.id) };
    pageToken = typeof res.data?.nextPageToken === 'string' ? res.data.nextPageToken : void 0;
    if (!pageToken) break;
  }
  return { ok: true, data: null };
}

function toMarkedEventBody(
  input: MarkedEventInput,
  scheduleId: number,
  deterministic: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.summary,
    start: { dateTime: input.start, timeZone: KST_TIME_ZONE },
    end: { dateTime: input.end || input.start, timeZone: KST_TIME_ZONE },
    extendedProperties: { private: { [GOOGLE_SCHEDULE_PROP]: String(scheduleId) } },
  };
  if (deterministic) {
    body.id = deterministicGoogleEventId(scheduleId);
  }
  if (input.description) body.description = input.description;
  if (input.location) body.location = input.location;
  if (input.recurrence && input.recurrence.length > 0) body.recurrence = input.recurrence;
  return body;
}

export async function createMarkedCalendarEvent(
  fetchFn: typeof fetch,
  accessToken: string,
  input: MarkedEventInput,
  scheduleId: number,
  deterministic: boolean,
): Promise<CalendarApiResult<{ id: string }>> {
  const res = await callCalendarApi(
    fetchFn,
    accessToken,
    `${CALENDAR_API_BASE}/calendars/primary/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toMarkedEventBody(input, scheduleId, deterministic))
    }
  );
  if (!res.ok) return res;
  const id = String(res.data?.id ?? '');
  if (!id) return { ok: false, error: 'invalid_response', unauthorized: false };
  return { ok: true, data: { id } };
}
