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

export async function processCronMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, approvalRequests, authorizeTool, sanitizeInserted } = ctx;
  let text = ctx.text;
  const cronCreateMarkers = parseCronCreateMarkers(text);
  for (const marker of cronCreateMarkers) {
    const gate = await authorizeTool('CRON_CREATE', { text: marker.text }, marker.full);
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message);
      if (gate.request) approvalRequests.push(gate.request);
      continue;
    }
    const ledgerStartedAt = Date.now();
    const res = await executeCronCreate(env, marker.text);
    const ledger = await recordMarkerToolExecution(ctx, {
      toolName: 'cron_create',
      mode: 'write',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { text: marker.text },
      resultData: res.data
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
    const gate = await authorizeTool('CRON_LIST', {}, marker.full);
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message);
      if (gate.request) approvalRequests.push(gate.request);
      continue;
    }
    const ledgerStartedAt = Date.now();
    const res = await executeCronList(env);
    await recordMarkerToolExecution(ctx, {
      toolName: 'cron_list',
      mode: 'read',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      resultData: res.data
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
    const gate = await authorizeTool('CRON_DELETE', { id: marker.id }, marker.full);
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message);
      if (gate.request) approvalRequests.push(gate.request);
      continue;
    }
    const ledgerStartedAt = Date.now();
    const res = await executeCronDelete(env, marker.id);
    const ledger = await recordMarkerToolExecution(ctx, {
      toolName: 'cron_delete',
      mode: 'write',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { id: marker.id },
      resultData: res.data
    });
    text = text.replace(marker.full, res.success && ledger.recorded ? `자동화를 삭제했습니다.` : res.success ? `자동화 #${marker.id} 삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 자동화 목록에서 확인해 주세요.` : `자동화 삭제 실패: ${res.error}`);
  }
  const cronToggleMarkers = parseCronToggleMarkers(text);
  for (const marker of cronToggleMarkers) {
    const gate = await authorizeTool('CRON_TOGGLE', { id: marker.id, enabled: marker.enabled }, marker.full);
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message);
      if (gate.request) approvalRequests.push(gate.request);
      continue;
    }
    const ledgerStartedAt = Date.now();
    const res = await executeCronToggle(env, marker.id, marker.enabled);
    await recordMarkerToolExecution(ctx, {
      toolName: 'cron_set_enabled',
      mode: 'write',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { id: marker.id, enabled: marker.enabled },
      resultData: res.data
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
  const { env, toolResults, approvalRequests, authorizeTool } = ctx;
  let text = ctx.text;
  let dataChanged = ctx.dataChanged;
  const scheduleMarkers = parseScheduleMarkers(text);
  for (const marker of scheduleMarkers) {
    if (marker.action === 'create') {
      const gate = await authorizeTool('SCHEDULE_CREATE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
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
      const ledgerStartedAt = Date.now();
      const res = await executeScheduleCreate(env, marker.data, { rejectPast: true });
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'schedule_create',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
      });
      if (res.success) dataChanged = true;
      const createNotice = res.success && res.googleNotice ? ` ${res.googleNotice}` : '';
      text = text.replace(marker.full, res.success && ledger.recorded ? `일정을 등록했습니다: ${marker.data.title}${createNotice}` : res.success ? `일정 등록을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 일정 목록에서 확인해 주세요.` : `일정 등록에 실패했습니다.`);
    } else if (marker.action === 'list') {
      const gate = await authorizeTool('SCHEDULE_LIST', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeScheduleList(env, marker.data);
      await recordMarkerToolExecution(ctx, {
        toolName: 'schedule_list',
        mode: 'read',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
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
      const gate = await authorizeTool('SCHEDULE_UPDATE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeScheduleUpdate(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'schedule_update',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
      });
      if (res.success) dataChanged = true;
      toolResults.push({ success: res.success, toolName: 'schedule_update', error: res.error, candidates: res.candidates, ledgerId: ledger.ledgerId, ledgerRecorded: ledger.recorded });
      const updateNotice = res.success && res.googleNotice ? ` ${res.googleNotice}` : '';
      text = text.replace(marker.full, res.success && ledger.recorded ? `일정을 수정했습니다.${updateNotice}` : res.success ? `일정 수정을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 일정에서 확인해 주세요.` : `일정 수정 실패: ${res.error}`);
    } else if (marker.action === 'delete') {
      const gate = await authorizeTool('SCHEDULE_DELETE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeScheduleDelete(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'schedule_delete',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
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
  const { env, approvalRequests, authorizeTool } = ctx;
  let text = ctx.text;
  const googleMarkers = parseGoogleMarkers(text);
  for (const marker of googleMarkers) {
    if (marker.action === 'gmail_search') {
      const gate = await authorizeTool('GMAIL_SEARCH', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeGmailSearch(env, marker.data);
      await recordMarkerToolExecution(ctx, {
        toolName: 'gmail_search',
        mode: 'read',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.success ? void 0 : String(res.error || 'error'),
        args: marker.data,
        resultData: res.success ? res.data : void 0
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
      const gate = await authorizeTool('GMAIL_GET', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeGmailGet(env, marker.data);
      await recordMarkerToolExecution(ctx, {
        toolName: 'gmail_get',
        mode: 'read',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.success ? void 0 : String(res.error || 'error'),
        args: marker.data,
        resultData: res.success ? res.data : void 0
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
      const gate = await authorizeTool('GCAL_LIST', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeGcalList(env, marker.data);
      await recordMarkerToolExecution(ctx, {
        toolName: 'gcal_list',
        mode: 'read',
        startedAt: ledgerStartedAt,
        success: !!res.success,
        error: res.success ? void 0 : String(res.error || 'error'),
        args: marker.data,
        resultData: res.data
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
      const gate = await authorizeTool('GCAL_CREATE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeGcalCreate(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'gcal_create',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.success ? void 0 : String(res.error || 'error'),
        args: marker.data,
        resultData: res.success ? res.data : void 0
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
  const { env, approvalRequests, authorizeTool } = ctx;
  let text = ctx.text;
  let dataChanged = ctx.dataChanged;
  const todoMarkers = parseTodoMarkers(text);
  for (const marker of todoMarkers) {
    if (marker.action === 'add') {
      const gate = await authorizeTool('TODO_ADD', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeTodoAdd(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'todo_add',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `할일을 추가했습니다: ${marker.data.title}` : res.success ? `할일 추가를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `할일 추가에 실패했습니다.`);
    } else if (marker.action === 'list') {
      const gate = await authorizeTool('TODO_LIST', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeTodoList(env, marker.data);
      await recordMarkerToolExecution(ctx, {
        toolName: 'todo_list',
        mode: 'read',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
      });
      if (res.success && res.data.length > 0) {
        const items = res.data.map((t: any) => `- [ ] ${sanitizeToolOutput(String(t.title || ''))}`).join("\n");
        text = text.replace(marker.full, `할일 목록입니다:
${items}`);
      } else {
        text = text.replace(marker.full, `등록된 할일이 없습니다.`);
      }
    } else if (marker.action === 'done') {
      const gate = await authorizeTool('TODO_DONE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeTodoDone(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'todo_done',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `할일을 완료했습니다.` : res.success ? `할일 완료를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `처리에 실패했습니다.`);
    } else if (marker.action === 'update') {
      const gate = await authorizeTool('TODO_UPDATE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeTodoUpdate(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'todo_update',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `할일을 수정했습니다.` : res.success ? `할일 수정을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `할일 수정 실패: ${res.error}`);
    } else if (marker.action === 'delete') {
      const gate = await authorizeTool('TODO_DELETE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeTodoDelete(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'todo_delete',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
      });
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success && ledger.recorded ? `삭제했습니다.` : res.success ? `삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 할일 목록에서 확인해 주세요.` : `삭제 실패: ${res.error}`);
    }
  }
  ctx.text = text;
  ctx.dataChanged = dataChanged;
}
export async function processArtifactMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, approvalRequests, authorizeTool } = ctx;
  let text = ctx.text;
  let dataChanged = ctx.dataChanged;
  const artifactMarkers = parseArtifactMarkers(text);
  for (const marker of artifactMarkers) {
    if (marker.action === 'create') {
      const gate = await authorizeTool('ARTIFACT_CREATE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeArtifactCreate(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'artifact_create',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
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
      const gate = await authorizeTool('ARTIFACT_DELETE', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeArtifactDelete(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'artifact_delete',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
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
      const gate = await authorizeTool('ARTIFACT_FROM_GITHUB', marker.data, marker.full);
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message);
        if (gate.request) approvalRequests.push(gate.request);
        continue;
      }
      const ledgerStartedAt = Date.now();
      const res = await executeArtifactFromGithub(env, marker.data);
      const ledger = await recordMarkerToolExecution(ctx, {
        toolName: 'artifact_from_github',
        mode: 'write',
        startedAt: ledgerStartedAt,
        success: res.success,
        error: res.error,
        args: marker.data,
        resultData: res.data
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
