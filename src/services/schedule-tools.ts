/**
 * AI 스케줄 도구
 */

import { expandRecurrence, singleOccurrence } from './recurrence';
import { normalizeScheduleDateTime } from '../lib/datetime-format';
import {
  pushScheduleDetailed,
  removeScheduleDetailed,
  type PushScheduleResult,
  type RemoveScheduleResult,
  type ScheduleSyncRow,
} from './schedule-google-sync';

const GOOGLE_REASON_TEXT: Record<string, string> = {
  write_disabled: 'Google 쓰기 연동이 꺼져 있어요',
  not_connected: 'Google 계정이 연결돼 있지 않아요',
  revoked: 'Google 연결이 끊겨 있어요',
  refresh_failed: 'Google 인증을 갱신하지 못했어요',
  scope_missing: 'Google 캘린더 쓰기 권한이 없어요',
  api_error: 'Google 캘린더가 오류를 반환했어요',
  exception: '동기화 중 오류가 났어요',
};

type ScheduleGoogleResult = PushScheduleResult | RemoveScheduleResult;

function googleSyncNotice(google: ScheduleGoogleResult | null): string | null {
  if (!google) return null;
  if (google.state === 'created' || google.state === 'updated') {
    return 'Google 캘린더에도 반영했어요.';
  }
  if (google.state === 'deleted') {
    return 'Google 캘린더에서도 삭제했어요.';
  }
  if (google.state === 'skipped' || google.state === 'failed') {
    const reason = google.reason ? GOOGLE_REASON_TEXT[google.reason] || google.reason : '이유를 확인 중이에요';
    return `Google 캘린더에는 아직 반영되지 않았어요 (${reason}). MyHub 일정은 저장돼 있고, 자동으로 다시 시도합니다.`;
  }
  return null;
}

async function pushCreatedOrUpdated(env: any, row: ScheduleSyncRow): Promise<PushScheduleResult | null> {
  try {
    return await pushScheduleDetailed(fetch, env, row);
  } catch {
    return null;
  }
}

export function parseScheduleMarkers(text: string): Array<{ full: string; action: string; data: any }> {
  const results: Array<{ full: string; action: string; data: any }> = [];
  
  // [SCHEDULE_CREATE]{...}[/SCHEDULE_CREATE]
  const createRe = /\[SCHEDULE_CREATE\]([\s\S]*?)\[\/SCHEDULE_CREATE\]/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.title) {
        results.push({ full: m[0], action: 'create', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }
  
  // [SCHEDULE_LIST]{...}[/SCHEDULE_LIST]
  const listRe = /\[SCHEDULE_LIST\]([\s\S]*?)\[\/SCHEDULE_LIST\]/gi;
  while ((m = listRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      results.push({ full: m[0], action: 'list', data });
    } catch {}
    if (results.length >= 3) break;
  }

  // [SCHEDULE_UPDATE]{...}[/SCHEDULE_UPDATE]
  const updateRe = /\[SCHEDULE_UPDATE\]([\s\S]*?)\[\/SCHEDULE_UPDATE\]/gi;
  while ((m = updateRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: 'update', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }

  // [SCHEDULE_DELETE]{...}[/SCHEDULE_DELETE]
  const deleteRe = /\[SCHEDULE_DELETE\]([\s\S]*?)\[\/SCHEDULE_DELETE\]/gi;
  while ((m = deleteRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: 'delete', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }

  return results;
}

/**
 * start_at(로컬 ISO, 오프셋 없으면 Asia/Seoul로 해석)을 epoch ms로 변환한다.
 * 파싱할 수 없으면 null — 호출자가 기존 동작을 유지할지 판단한다.
 */
export function parseScheduleStartMs(start_at: unknown): number | null {
  if (typeof start_at !== 'string' || !start_at.trim()) return null;
  const s = start_at.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const ms = Date.parse(hasZone ? s : `${s}+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

export interface ScheduleCreateOptions {
  /**
   * AI 도구 경로(FC 디스패처·마커 후처리) 전용: 과거 start_at을 거부한다.
   * - 신규 일정이 과거로 등록되는 것은 어떤 경우에도 오답이라, 모델이 오류를
   *   보고 재시도할 수 있게 실행 전에 돌려준다 (2026-10-30 라이브 게이트:
   *   keeper가 "오늘"을 2025년으로 믿고 2025-08-11 일정을 실제 등록함).
   * - UI 직접 등록(routes.ts)은 이 실행기를 쓰지 않으므로 영향이 없고,
   *   기본값은 기존 호출자·테스트의 동작을 유지한다.
   */
  rejectPast?: boolean;
  /** 테스트용 기준 시각 주입 (기본 Date.now()) */
  nowMs?: number;
}

export async function executeScheduleCreate(env: any, data: any, opts?: ScheduleCreateOptions): Promise<any> {
  try {
    const { title, start_at, end_at, description, location, create_todo } = data;
    if (!title || !start_at) {
      return { success: false, error: '제목과 시작 시간이 필요' };
    }
    // 과거 시각 거부 (AI 도구 경로 한정 — 위 ScheduleCreateOptions 참조)
    if (opts?.rejectPast) {
      const startMs = parseScheduleStartMs(start_at);
      const nowMs = opts.nowMs ?? Date.now();
      if (startMs !== null && startMs < nowMs) {
        return {
          success: false,
          error: `과거 시각으로는 새 일정을 등록할 수 없습니다 (start_at: ${start_at}). 상대 날짜 표현("내일" 등)은 오늘 날짜 기준으로 다시 계산해서 재시도하세요.`,
        };
      }
    }
    // 중복 체크: 같은 제목 + 같은 날짜에 이미 일정이 있는지 확인
    const startDate = start_at.split('T')[0];
    const existing = await env.DB.prepare(
      `SELECT id, title, start_at FROM schedules
       WHERE title = ? AND substr(start_at, 1, 10) = ? AND status = 'active'
       LIMIT 1`
    ).bind(title.trim(), startDate).first();
    if (existing) {
      return {
        success: false,
        error: `중복 일정: "${title}" 일정이 ${startDate}에 이미 있습니다.`,
        duplicate: true,
        existingId: existing.id,
      };
    }
    const result = await env.DB.prepare(
      `INSERT INTO schedules (title, description, location, start_at, end_at, timezone, status)
       VALUES (?, ?, ?, ?, ?, 'Asia/Seoul', 'active')`
    ).bind(
      title,
      description || '',
      location || '',
      // M-11: 오프셋 명시 ISO로 정규화해 저장 (lib/datetime-format.ts)
      normalizeScheduleDateTime(start_at),
      end_at ? normalizeScheduleDateTime(end_at) : null
    ).run();
    const scheduleId = result.meta.last_row_id;
    
    // 일정-할일 연동: 할일도 자동 생성 (create_todo가 false가 아닐 때)
    let todoId = null;
    if (create_todo !== false) {
      try {
        const todoResult = await env.DB.prepare(
          `INSERT INTO todos (title, due_at, status) VALUES (?, ?, 'pending')`
        ).bind(`[일정] ${title}`, start_at.split('T')[0]).run();
        todoId = todoResult.meta.last_row_id;
      } catch (e) {
        console.error('Todo auto-creation failed:', e);
        // 할일 생성 실패해도 일정은 성공으로 처리
      }
    }
    
    const google = await pushCreatedOrUpdated(env, {
      id: scheduleId,
      title,
      description: description || '',
      location: location || '',
      start_at: normalizeScheduleDateTime(start_at) as string,
      end_at: end_at ? (normalizeScheduleDateTime(end_at) as string) : null,
      recurrence_rule: null,
      google_event_id: null,
    });
    return {
      success: true,
      data: { id: scheduleId, todo_id: todoId },
      google,
      googleNotice: googleSyncNotice(google),
    };
  } catch (e) {
    return { success: false, error: '일정 생성 실패' };
  }
}

export function detectCorrectionIntent(text: unknown): boolean {
  const t = String(text || '');
  return /(정정|아니라|아니고|아니,|아니\s|틀렸|잘못|오타|바꿔|고쳐|수정해)/.test(t);
}

function titleEditDistance(a: unknown, b: unknown): number {
  const x = Array.from(String(a || ''));
  const y = Array.from(String(b || ''));
  const dp = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cur = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[y.length];
}

export async function findScheduleCorrectionCandidates(
  env: any,
  data: any,
): Promise<Array<{ id: number; title: string; start_at: string }>> {
  const title = String(data?.title || '').trim();
  const startDate = String(data?.start_at || '').split('T')[0];
  if (!title || !startDate || !env?.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, start_at FROM schedules
       WHERE substr(start_at, 1, 10) = ? AND status = 'active' ORDER BY start_at ASC LIMIT 10`
    ).bind(startDate).all();
    return (results || [])
      .filter((r: any) => {
        const existing = String(r.title || '').trim();
        if (!existing || existing === title) return false;
        return titleEditDistance(existing, title) <= 2 || existing.includes(title) || title.includes(existing);
      })
      .map((r: any) => ({ id: r.id, title: r.title, start_at: r.start_at }));
  } catch {
    return [];
  }
}

export async function executeScheduleList(env: any, data: any): Promise<any> {
  try {
    const from = data.from || new Date().toISOString().split('T')[0];
    const to = data.to || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const COLS = `id, title, description, location, start_at, end_at, timezone, recurrence_rule, status, created_at, updated_at`;
    // 단건 일정
    const { results: singles } = await env.DB.prepare(
      `SELECT ${COLS}
       FROM schedules
       WHERE (recurrence_rule IS NULL OR recurrence_rule = '')
         AND date(start_at) BETWEEN date(?) AND date(?) AND status = 'active'
       ORDER BY start_at ASC LIMIT 20`
    ).bind(from, to).all();
    // 반복 일정: 시작일이 범위 끝 이전인 것을 가져와展開
    const { results: recurring } = await env.DB.prepare(
      `SELECT ${COLS}
       FROM schedules
       WHERE recurrence_rule IS NOT NULL AND recurrence_rule != ''
         AND substr(start_at, 1, 10) <= ? AND status = 'active'
       ORDER BY start_at ASC`
    ).bind(to).all();
    const expanded = [
      ...(singles || []).map((r: any) => singleOccurrence(r)),
      ...(recurring || []).flatMap((r: any) => expandRecurrence(r, from, to)),
    ];
    expanded.sort((a: any, b: any) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0));
    const out = expanded.slice(0, 20).map((s: any) => ({
      id: s.id,
      title: s.title,
      start_at: s.start_at,
      end_at: s.end_at,
      location: s.location,
      is_recurring: s.is_recurring,
      occurrence_date: s.occurrence_date,
    }));
    return { success: true, data: out };
  } catch (e) {
    return { success: false, error: '일정 조회 실패' };
  }
}

export async function executeScheduleUpdate(env: any, data: any): Promise<any> {
  try {
    let id = Number(data.id);
    // ID가 없고 title이 있으면 제목으로 조회
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const titleQuery = String(data.title).trim();
      const found = await env.DB.prepare(
        'SELECT id, title, start_at FROM schedules WHERE title LIKE ? AND status = ? ORDER BY start_at DESC LIMIT 5'
      ).bind(`%${titleQuery}%`, 'active').all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" 일정을 찾을 수 없음` };
      }
      if (rows.length > 1) {
        return {
          success: false,
          error: 'multiple_candidates',
          candidates: rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            start_at: r.start_at,
          })),
          message: `여러 일정이 발견됨. 수정할 일정을 선택해주세요.`,
        };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: '유효한 일정 ID나 제목이 필요' };
    }
    // 존재 확인
    const existing = await env.DB.prepare('SELECT id FROM schedules WHERE id = ?').bind(id).first();
    if (!existing) {
      return { success: false, error: '일정을 찾을 수 없음' };
    }
    const fields: string[] = [];
    const params: any[] = [];
    const allowed: Record<string, string> = {
      title: 'title',
      new_title: 'title',
      start_at: 'start_at',
      end_at: 'end_at',
      location: 'location',
      description: 'description',
      recurrence_rule: 'recurrence_rule',
      status: 'status',
    };
    for (const key of Object.keys(allowed)) {
      if (data[key] !== undefined && data[key] !== null) {
        fields.push(`${allowed[key]} = ?`);
        params.push(
          key === 'start_at' || key === 'end_at' ? normalizeScheduleDateTime(data[key]) : data[key]
        );
      }
    }
    if (fields.length === 0) {
      return { success: false, error: '변경할 내용이 없음' };
    }
    fields.push(`updated_at = datetime('now')`);
    await env.DB.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).bind(...params, id).run();
    let google: PushScheduleResult | null = null;
    try {
      const row = await env.DB.prepare(
        'SELECT id, title, description, location, start_at, end_at, recurrence_rule, google_event_id FROM schedules WHERE id = ?'
      ).bind(id).first();
      if (row) google = await pushCreatedOrUpdated(env, row);
    } catch {
    }
    return { success: true, data: { id }, google, googleNotice: googleSyncNotice(google) };
  } catch (e) {
    return { success: false, error: '일정 수정 실패' };
  }
}

export async function executeScheduleDelete(env: any, data: any): Promise<any> {
  try {
    let id = Number(data.id);
    // ID가 없고 title이 있으면 제목으로 조회
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const titleQuery = String(data.title).trim();
      const found = await env.DB.prepare(
        'SELECT id, title, start_at FROM schedules WHERE title LIKE ? AND status = ? ORDER BY start_at DESC LIMIT 5'
      ).bind(`%${titleQuery}%`, 'active').all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" 일정을 찾을 수 없음` };
      }
      if (rows.length > 1) {
        // 후보 목록 반환 (프론트엔드에서 버튼으로 표시)
        return {
          success: false,
          error: 'multiple_candidates',
          candidates: rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            start_at: r.start_at,
          })),
          message: `여러 일정이 발견됨. 삭제할 일정을 선택해주세요.`,
        };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: '유효한 일정 ID나 제목이 필요' };
    }
    let linkRow: any = null;
    try {
      linkRow = await env.DB.prepare('SELECT google_event_id FROM schedules WHERE id = ?').bind(id).first();
    } catch {
    }
    let google: RemoveScheduleResult | null = null;
    if (linkRow?.google_event_id) {
      try {
        google = await removeScheduleDetailed(fetch, env, { id, google_event_id: linkRow.google_event_id });
      } catch {
        google = { state: 'failed', reason: 'exception' };
      }
      if (google.state !== 'deleted') {
        return {
          success: false,
          error: 'Google 캘린더 삭제가 끝나지 않아 로컬 일정도 아직 지우지 않았어요. 자동으로 다시 시도합니다.',
          google,
          googleNotice: 'Google 캘린더 삭제가 끝나지 않아 로컬 일정도 아직 지우지 않았어요. 자동으로 다시 시도합니다.',
          data: { id, deletePending: true },
        };
      }
    }
    const result = await env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(id).run();
    const deleted = result.meta?.changes ?? 0;
    if (deleted === 0) {
      return { success: false, error: '일정을 찾을 수 없음' };
    }
    return {
      success: true,
      data: { id, deleted },
      google,
      googleNotice: google ? googleSyncNotice(google) : null,
    };
  } catch (e) {
    return { success: false, error: '일정 삭제 실패' };
  }
}
