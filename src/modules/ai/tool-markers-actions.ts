// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 도구 마커 처리 (행동 계열): cron·일정·Google·할일·아티팩트 마커
import { parseScheduleMarkers, executeScheduleCreate, executeScheduleList, executeScheduleUpdate, executeScheduleDelete, detectCorrectionIntent, findScheduleCorrectionCandidates } from '../../services/schedule-tools'
import { parseArtifactMarkers, executeArtifactCreate, executeArtifactDelete, executeArtifactFromGithub } from '../../services/artifact-tools'
import { parseTodoMarkers, executeTodoAdd, executeTodoList, executeTodoDone, executeTodoUpdate, executeTodoDelete } from '../../services/todo-tools'
import { parseCronCreateMarkers, parseCronListMarkers, parseCronDeleteMarkers, parseCronToggleMarkers, executeCronCreate, executeCronList, executeCronDelete, executeCronToggle } from '../../services/cron-tools'
import { parseGoogleMarkers, executeGmailSearch, executeGmailGet, executeGcalList, executeGcalCreate, GOOGLE_NOT_CONNECTED_MESSAGE, GOOGLE_RECONNECT_MESSAGE } from '../../services/google-tools'
import { sanitizeToolOutput, sandboxToolOutput, wrapToolOutputForModel } from '../../lib/context-sandbox'
import { recordMarkerToolExecution } from '../../services/tool-ledger'
import type { ToolMarkerContext } from './tool-marker-context'

/**
 * 게이트 단계 (B-L7 추출): authorizeTool을 호출하고, 거부되면 마커를
 * 게이트 메시지로 교체하고 승인 요청을 쌓는다. 모든 핸들러는 실행기를
 * 호출하기 전에 이 헬퍼를 거쳐야 한다 — tests/unit/tool-markers-gate.test.ts가
 * 핸들러 20개 전수에 대해 고정한다.
 */
async function authorizeMarkerTool(
  ctx: ToolMarkerContext,
  tool: string,
  args: unknown,
  markerFull: string,
  text: string,
): Promise<{ allowed: boolean; text: string }> {
  const gate = await ctx.authorizeTool(tool, args, markerFull)
  if (!gate.allowed) {
    text = text.replace(markerFull, gate.message)
    if (gate.request) ctx.approvalRequests.push(gate.request)
    return { allowed: false, text }
  }
  return { allowed: true, text }
}

type MarkerExecuteResult = { success: boolean; error?: string | null; data?: unknown }

/**
 * 실행+원장 단계 (B-L7 추출): 실행기를 호출하고 결과를 원장에 기록한다.
 * toLedger가 없으면 { success, error: res.error, resultData: res.data }를
 * 그대로 쓰고, 구글 계열처럼 원장 형태가 다른 핸들러는 toLedger로 명시한다.
 * args를 생략하면 원장 입력에 args 키 자체를 넣지 않는다 (CRON_LIST 선례).
 */
async function executeAndRecordMarkerTool<T extends MarkerExecuteResult>(
  ctx: ToolMarkerContext,
  spec: {
    toolName: string
    mode: 'read' | 'write'
    args?: unknown
    execute: () => Promise<T>
    toLedger?: (res: T) => { success: boolean; error?: unknown; resultData?: unknown }
  },
): Promise<{ res: T; ledger: Awaited<ReturnType<typeof recordMarkerToolExecution>> }> {
  const startedAt = Date.now()
  const res = await spec.execute()
  const entry = spec.toLedger
    ? spec.toLedger(res)
    : { success: res.success, error: res.error, resultData: res.data }
  const ledger = await recordMarkerToolExecution(ctx, {
    toolName: spec.toolName,
    mode: spec.mode,
    startedAt,
    success: entry.success,
    error: entry.error as string | null | undefined,
    ...(spec.args !== undefined ? { args: spec.args } : {}),
    resultData: entry.resultData,
  })
  return { res, ledger }
}

export async function processCronMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, sanitizeInserted } = ctx;
  let text = ctx.text;
  const cronCreateMarkers = parseCronCreateMarkers(text);
  for (const marker of cronCreateMarkers) {
    const gated = await authorizeMarkerTool(ctx, 'CRON_CREATE', { text: marker.text }, marker.full, text);
    text = gated.text;
    if (!gated.allowed) continue;
    const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
      toolName: 'cron_create',
      mode: 'write',
      args: { text: marker.text },
      execute: () => executeCronCreate(env, marker.text),
    });
    if (res.success && ledger.recorded) {
      text = text.replace(marker.full, `자동화를 저장했습니다: ${res.data.description}`);
    } else if (res.success) {
      text = text.replace(marker.full, `자동화 저장을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 자동화 목록에서 확인해 주세요.`);
    } else {
      text = text.replace(marker.full, `자동화 저장 실패: ${res.error}`);
    }
  }
  text = text.replace(/\[CRON_CREATE\][\s\S]*?\[\/CRON_CREATE\]/gi, '자동화 저장에 실패했습니다. (형식을 이해하지 못했습니다)');
  const cronListMarkers = parseCronListMarkers(text);
  for (const marker of cronListMarkers) {
    const gated = await authorizeMarkerTool(ctx, 'CRON_LIST', {}, marker.full, text);
    text = gated.text;
    if (!gated.allowed) continue;
    const { res } = await executeAndRecordMarkerTool(ctx, {
      toolName: 'cron_list',
      mode: 'read',
      execute: () => executeCronList(env),
    });
    if (res.success && res.data.jobs.length > 0) {
      const items = res.data.jobs.map((j: any) => `- ${sanitizeInserted(String(j.description || ''))}`).join("\n");
      text = text.replace(marker.full, `자동화 목록입니다:
${items}`);
    } else {
      text = text.replace(marker.full, `저장된 자동화가 없습니다.`);
    }
  }
  const cronDeleteMarkers = parseCronDeleteMarkers(text);
  for (const marker of cronDeleteMarkers) {
    const gated = await authorizeMarkerTool(ctx, 'CRON_DELETE', { id: marker.id }, marker.full, text);
    text = gated.text;
    if (!gated.allowed) continue;
    const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
      toolName: 'cron_delete',
      mode: 'write',
      args: { id: marker.id },
      execute: () => executeCronDelete(env, marker.id),
    });
    text = text.replace(marker.full, res.success && ledger.recorded ? `자동화를 삭제했습니다.` : res.success ? `자동화 #${marker.id} 삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 자동화 목록에서 확인해 주세요.` : `자동화 삭제 실패: ${res.error}`);
  }
  const cronToggleMarkers = parseCronToggleMarkers(text);
  for (const marker of cronToggleMarkers) {
    const gated = await authorizeMarkerTool(ctx, 'CRON_TOGGLE', { id: marker.id, enabled: marker.enabled }, marker.full, text);
    text = gated.text;
    if (!gated.allowed) continue;
    const { res } = await executeAndRecordMarkerTool(ctx, {
      toolName: 'cron_set_enabled',
      mode: 'write',
      args: { id: marker.id, enabled: marker.enabled },
      execute: () => executeCronToggle(env, marker.id, marker.enabled),
    });
    if (res.success) {
      const state = res.data.enabled ? '켰습니다' : '껐습니다';
      text = text.replace(marker.full, `자동화를 ${state}: ${sanitizeInserted(String(res.data.description || ''))}`);
    } else {
      text = text.replace(marker.full, `자동화 변경 실패: ${res.error}`);
    }
  }
  ctx.text = text;
}
export async function processScheduleMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, toolResults } = ctx;
  let text = ctx.text;
  let dataChanged = ctx.dataChanged;
  const scheduleMarkers = parseScheduleMarkers(text);
  for (const marker of scheduleMarkers) {
    if (marker.action === 'create') {
      const gated = await authorizeMarkerTool(ctx, 'SCHEDULE_CREATE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      if (detectCorrectionIntent(ctx.userRequest)) {
        const candidates = await findScheduleCorrectionCandidates(env, marker.data);
        if (candidates.length > 0) {
          const c = candidates[0];
          const when = String(c.start_at || '').replace('T', ' ').slice(5, 16);
          toolResults.push({ success: false, toolName: 'schedule_create', error: 'correction_candidate', candidates });
          text = text.replace(
            marker.full,
            `기존 일정 "${c.title}" (${when})이(가) 있습니다. 새 일정을 만들지 않고 이 일정의 제목을 "${marker.data.title}"(으)로 고칠까요? 확인해 주시면 기존 일정을 수정하겠습니다.`
          );
          continue;
        }
      }
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'schedule_create',
        mode: 'write',
        args: marker.data,
        execute: () => executeScheduleCreate(env, marker.data, { rejectPast: true }),
      });
      if (res.success) dataChanged = true;
      const createNotice = res.success && res.googleNotice ? ` ${res.googleNotice}` : '';
      text = text.replace(marker.full, res.success && ledger.recorded ? `일정을 등록했습니다: ${marker.data.title}${createNotice}` : res.success ? `일정 등록을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 일정 목록에서 확인해 주세요.` : `일정 등록에 실패했습니다.`);
    } else if (marker.action === 'list') {
      const gated = await authorizeMarkerTool(ctx, 'SCHEDULE_LIST', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'schedule_list',
        mode: 'read',
        args: marker.data,
        execute: () => executeScheduleList(env, marker.data),
      });
      if (res.success && res.data.length > 0) {
        const items = res.data.map((s: any) => {
          const dt = s.start_at ? String(s.start_at).replace('T', ' ').slice(5, 16) : '';
          return `- ${dt} ${sanitizeToolOutput(String(s.title || ''))}`;
        }).join("\n");
        text = text.replace(marker.full, `일정 목록입니다:
${items}`);
      } else {
        text = text.replace(marker.full, `등록된 일정이 없습니다.`);
      }
    } else if (marker.action === 'update') {
      const gated = await authorizeMarkerTool(ctx, 'SCHEDULE_UPDATE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'schedule_update',
        mode: 'write',
        args: marker.data,
        execute: () => executeScheduleUpdate(env, marker.data),
      });
      if (res.success) dataChanged = true;
      toolResults.push({ success: res.success, toolName: 'schedule_update', error: res.error, candidates: res.candidates, ledgerId: ledger.ledgerId, ledgerRecorded: ledger.recorded });
      const updateNotice = res.success && res.googleNotice ? ` ${res.googleNotice}` : '';
      text = text.replace(marker.full, res.success && ledger.recorded ? `일정을 수정했습니다.${updateNotice}` : res.success ? `일정 수정을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 일정에서 확인해 주세요.` : `일정 수정 실패: ${res.error}`);
    } else if (marker.action === 'delete') {
      const gated = await authorizeMarkerTool(ctx, 'SCHEDULE_DELETE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'schedule_delete',
        mode: 'write',
        args: marker.data,
        execute: () => executeScheduleDelete(env, marker.data),
      });
      const label = marker.data.title || `id ${marker.data.id}`;
      if (res.success) dataChanged = true;
      toolResults.push({ success: res.success, toolName: 'schedule_delete', error: res.error, candidates: res.candidates, ledgerId: ledger.ledgerId, ledgerRecorded: ledger.recorded });
      const deleteNotice = res.success && res.googleNotice ? ` ${res.googleNotice}` : '';
      text = text.replace(marker.full, res.success && ledger.recorded ? `삭제했습니다.${deleteNotice}` : res.success ? `삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 일정에서 확인해 주세요.` : `삭제 실패: ${res.error}`);
    }
  }
  ctx.text = text;
  ctx.dataChanged = dataChanged;
}
export async function processGoogleMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env } = ctx;
  let text = ctx.text;
  const googleMarkers = parseGoogleMarkers(text);
  for (const marker of googleMarkers) {
    if (marker.action === 'gmail_search') {
      const gated = await authorizeMarkerTool(ctx, 'GMAIL_SEARCH', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'gmail_search',
        mode: 'read',
        args: marker.data,
        execute: () => executeGmailSearch(env, marker.data),
        toLedger: (r) => ({
          success: r.success,
          error: r.success ? undefined : String(r.error || 'error'),
          resultData: r.success ? r.data : undefined,
        }),
      });
      if (!res.success) {
        text = text.replace(marker.full, res.error === 'not_connected' ? GOOGLE_NOT_CONNECTED_MESSAGE : res.error === 'revoked' ? GOOGLE_RECONNECT_MESSAGE : '메일 검색에 실패했습니다.');
      } else if (res.data.length > 0) {
        const items = res.data.map((m) => `- ${sanitizeToolOutput(String(m.subject || '(제목 없음)'))} (${sanitizeToolOutput(String(m.from || ''))})`).join("\n");
        text = text.replace(marker.full, `찾은 메일입니다:
${items}`);
      } else {
        text = text.replace(marker.full, `관련 메일이 없습니다.`);
      }
    } else if (marker.action === 'gmail_get') {
      const gated = await authorizeMarkerTool(ctx, 'GMAIL_GET', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'gmail_get',
        mode: 'read',
        args: marker.data,
        execute: () => executeGmailGet(env, marker.data),
        toLedger: (r) => ({
          success: r.success,
          error: r.success ? undefined : String(r.error || 'error'),
          resultData: r.success ? r.data : undefined,
        }),
      });
      if (!res.success) {
        text = text.replace(marker.full, res.error === 'not_connected' ? GOOGLE_NOT_CONNECTED_MESSAGE : res.error === 'revoked' ? GOOGLE_RECONNECT_MESSAGE : '메일을 가져오지 못했습니다.');
      } else {
        const m = res.data;
        text = text.replace(marker.full, `메일 내용입니다:
제목: ${sanitizeToolOutput(String(m.subject || ''))}
보낸 사람: ${sanitizeToolOutput(String(m.from || ''))}
${sanitizeToolOutput(String(m.body || m.snippet || ''))}`);
      }
    } else if (marker.action === 'gcal_list') {
      const gated = await authorizeMarkerTool(ctx, 'GCAL_LIST', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'gcal_list',
        mode: 'read',
        args: marker.data,
        execute: () => executeGcalList(env, marker.data),
        toLedger: (r) => ({
          success: !!r.success,
          error: r.success ? undefined : String(r.error || 'error'),
          resultData: r.data,
        }),
      });
      if (res.data.length > 0) {
        const items = res.data.map((s) => {
          const dt = s.start_at ? String(s.start_at).replace('T', ' ').slice(5, 16) : '';
          const src = s.source === 'google' ? '[구글] ' : '';
          return `- ${dt} ${src}${sanitizeToolOutput(String(s.title || ''))}`;
        }).join("\n");
        text = text.replace(marker.full, `일정 목록입니다:
${items}`);
      } else {
        text = text.replace(marker.full, `등록된 일정이 없습니다.`);
      }
    } else if (marker.action === 'gcal_create') {
      const gated = await authorizeMarkerTool(ctx, 'GCAL_CREATE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'gcal_create',
        mode: 'write',
        args: marker.data,
        execute: () => executeGcalCreate(env, marker.data),
        toLedger: (r) => ({
          success: r.success,
          error: r.success ? undefined : String(r.error || 'error'),
          resultData: r.success ? r.data : undefined,
        }),
      });
      if (!res.success) {
        text = text.replace(
          marker.full,
          res.error === 'not_connected' ? GOOGLE_NOT_CONNECTED_MESSAGE : res.error === 'revoked' ? GOOGLE_RECONNECT_MESSAGE : res.error === 'scope_missing' ? '구글 캘린더 쓰기 권한이 없어요. 설정에서 쓰기 권한으로 다시 연결해 주세요.' : '구글 캘린더 일정 등록에 실패했습니다.'
        );
      } else if (ledger.recorded) {
        text = text.replace(marker.full, `구글 캘린더에 일정을 등록했습니다: ${sanitizeToolOutput(String(res.data.summary || ''))}`);
      } else {
        text = text.replace(marker.full, `구글 캘린더 일정 등록을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 구글 캘린더에서 확인해 주세요.`);
      }
    }
  }
  ctx.text = text;
}
export async function processTodoMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env } = ctx;
  let text = ctx.text;
  let dataChanged = ctx.dataChanged;
  const todoMarkers = parseTodoMarkers(text);
  for (const marker of todoMarkers) {
    if (marker.action === 'add') {
      const gated = await authorizeMarkerTool(ctx, 'TODO_ADD', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'todo_add',
        mode: 'write',
        args: marker.data,
        execute: () => executeTodoAdd(env, marker.data),
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `할일을 추가했습니다: ${marker.data.title}` : res.success ? `할일 추가를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `할일 추가에 실패했습니다.`);
    } else if (marker.action === 'list') {
      const gated = await authorizeMarkerTool(ctx, 'TODO_LIST', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'todo_list',
        mode: 'read',
        args: marker.data,
        execute: () => executeTodoList(env, marker.data),
      });
      if (res.success && res.data.length > 0) {
        const items = res.data.map((t: any) => `- [ ] ${sanitizeToolOutput(String(t.title || ''))}`).join("\n");
        text = text.replace(marker.full, `할일 목록입니다:
${items}`);
      } else {
        text = text.replace(marker.full, `등록된 할일이 없습니다.`);
      }
    } else if (marker.action === 'done') {
      const gated = await authorizeMarkerTool(ctx, 'TODO_DONE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'todo_done',
        mode: 'write',
        args: marker.data,
        execute: () => executeTodoDone(env, marker.data),
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `할일을 완료했습니다.` : res.success ? `할일 완료를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `처리에 실패했습니다.`);
    } else if (marker.action === 'update') {
      const gated = await authorizeMarkerTool(ctx, 'TODO_UPDATE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'todo_update',
        mode: 'write',
        args: marker.data,
        execute: () => executeTodoUpdate(env, marker.data),
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `할일을 수정했습니다.` : res.success ? `할일 수정을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `할일 수정 실패: ${res.error}`);
    } else if (marker.action === 'delete') {
      const gated = await authorizeMarkerTool(ctx, 'TODO_DELETE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'todo_delete',
        mode: 'write',
        args: marker.data,
        execute: () => executeTodoDelete(env, marker.data),
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `삭제했습니다.` : res.success ? `삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `삭제 실패: ${res.error}`);
    }
  }
  ctx.text = text;
  ctx.dataChanged = dataChanged;
}
export async function processArtifactMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env } = ctx;
  let text = ctx.text;
  let dataChanged = ctx.dataChanged;
  const artifactMarkers = parseArtifactMarkers(text);
  for (const marker of artifactMarkers) {
    if (marker.action === 'create') {
      const gated = await authorizeMarkerTool(ctx, 'ARTIFACT_CREATE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'artifact_create',
        mode: 'write',
        args: marker.data,
        execute: () => executeArtifactCreate(env, marker.data),
      });
      if (res.success) dataChanged = true;
      if (res.success && ledger.recorded) {
        text = text.replace(marker.full, `아티팩트를 만들었습니다: ${marker.data.title} (홈화면에서 확인할 수 있습니다)`);
      } else if (res.success) {
        text = text.replace(marker.full, `아티팩트 생성을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 홈화면에서 확인해 주세요.`);
      } else {
        text = text.replace(marker.full, `아티팩트 생성 실패: ${res.error}`);
      }
    } else if (marker.action === 'delete') {
      const gated = await authorizeMarkerTool(ctx, 'ARTIFACT_DELETE', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'artifact_delete',
        mode: 'write',
        args: marker.data,
        execute: () => executeArtifactDelete(env, marker.data),
      });
      if (res.success) dataChanged = true;
      if (res.success && ledger.recorded) {
        text = text.replace(marker.full, `아티팩트를 삭제했습니다.`);
      } else if (res.success) {
        text = text.replace(marker.full, `아티팩트 삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 홈화면에서 확인해 주세요.`);
      } else {
        text = text.replace(marker.full, `삭제 실패: ${res.error}`);
      }
    } else if (marker.action === 'from_github') {
      const gated = await authorizeMarkerTool(ctx, 'ARTIFACT_FROM_GITHUB', marker.data, marker.full, text);
      text = gated.text;
      if (!gated.allowed) continue;
      const { res, ledger } = await executeAndRecordMarkerTool(ctx, {
        toolName: 'artifact_from_github',
        mode: 'write',
        args: marker.data,
        execute: () => executeArtifactFromGithub(env, marker.data),
      });
      if (res.success) dataChanged = true;
      if (res.success && ledger.recorded) {
        text = text.replace(marker.full, `GitHub에서 가져왔습니다: ${res.data.title} (홈화면에서 확인할 수 있습니다)`);
      } else if (res.success) {
        text = text.replace(marker.full, `GitHub 가져오기를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 홈화면에서 확인해 주세요.`);
      } else {
        text = text.replace(marker.full, `가져오기 실패: ${res.error}`);
      }
    }
  }
  ctx.text = text;
  ctx.dataChanged = dataChanged;
}
