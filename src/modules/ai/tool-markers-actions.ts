// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 도구 마커 처리 (행동 계열): cron·일정·Google·할일·아티팩트 마커
import { parseScheduleMarkers, executeScheduleCreate, executeScheduleList, executeScheduleUpdate, executeScheduleDelete } from '../../services/schedule-tools'
import { parseArtifactMarkers, executeArtifactCreate, executeArtifactDelete, executeArtifactFromGithub } from '../../services/artifact-tools'
import { parseTodoMarkers, executeTodoAdd, executeTodoList, executeTodoDone, executeTodoUpdate, executeTodoDelete } from '../../services/todo-tools'
import { parseCronCreateMarkers, parseCronListMarkers, parseCronDeleteMarkers, parseCronToggleMarkers, executeCronCreate, executeCronList, executeCronDelete, executeCronToggle } from '../../services/cron-tools'
import { parseGoogleMarkers, executeGmailSearch, executeGmailGet, executeGcalList, executeGcalCreate, GOOGLE_NOT_CONNECTED_MESSAGE, GOOGLE_RECONNECT_MESSAGE } from '../../services/google-tools'
import { sanitizeToolOutput, sandboxToolOutput, wrapToolOutputForModel } from '../../lib/context-sandbox'
import type { ToolMarkerContext } from './tool-marker-context'

// [CRON_*] 마커 처리
export async function processCronMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, approvalRequests, authorizeTool, sanitizeInserted } = ctx
  let text = ctx.text
  // [CRON_*] → 반복 자동화 (자연어 cron)
  // - CRON_CREATE: 자연어 원문을 서버 파서가 결정적으로 변환해 저장
  // - CRON_LIST / CRON_DELETE / CRON_TOGGLE: 목록·삭제·켜기/끄기
  // - denyPattern(MEMO|SCHEDULE|TODO)에는 안 걸리므로 authorizeTool로
  //   실행 직전에 권한을 재확인한다 (builder 등 미허용 비서는 거부 메시지).
  const cronCreateMarkers = parseCronCreateMarkers(text)
  for (const marker of cronCreateMarkers) {
    const gate = await authorizeTool('CRON_CREATE', { text: marker.text }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeCronCreate(env, marker.text)
    if (res.success) {
      text = text.replace(marker.full, `자동화를 저장했어: ${res.data.description}`)
    } else {
      text = text.replace(marker.full, `자동화 저장 실패: ${res.error}`)
    }
  }
  // 파싱되지 않은 [CRON_CREATE] 마커는 원본 노출 방지 — 실패 안내로 대체
  text = text.replace(/\[CRON_CREATE\][\s\S]*?\[\/CRON_CREATE\]/gi, '자동화 저장에 실패했습니다. (형식을 이해하지 못했어요)')

  const cronListMarkers = parseCronListMarkers(text)
  for (const marker of cronListMarkers) {
    const gate = await authorizeTool('CRON_LIST', {}, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeCronList(env)
    if (res.success && res.data.jobs.length > 0) {
      const items = res.data.jobs.map((j: any) => `- ${sanitizeInserted(String(j.description || ''))}`).join('\n')
      text = text.replace(marker.full, `자동화 목록이야:\n${items}`)
    } else {
      text = text.replace(marker.full, `저장된 자동화가 없어.`)
    }
  }

  const cronDeleteMarkers = parseCronDeleteMarkers(text)
  for (const marker of cronDeleteMarkers) {
    const gate = await authorizeTool('CRON_DELETE', { id: marker.id }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeCronDelete(env, marker.id)
    text = text.replace(marker.full, res.success ? `자동화 #${marker.id}를 삭제했어.` : `자동화 삭제 실패: ${res.error}`)
  }

  const cronToggleMarkers = parseCronToggleMarkers(text)
  for (const marker of cronToggleMarkers) {
    const gate = await authorizeTool('CRON_TOGGLE', { id: marker.id, enabled: marker.enabled }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeCronToggle(env, marker.id, marker.enabled)
    if (res.success) {
      const state = res.data.enabled ? '켰어' : '껐어'
      text = text.replace(marker.full, `자동화를 ${state}: ${sanitizeInserted(String(res.data.description || ''))}`)
    } else {
      text = text.replace(marker.full, `자동화 변경 실패: ${res.error}`)
    }
  }
  ctx.text = text
}

// [SCHEDULE_*] 마커 처리
export async function processScheduleMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, toolResults, approvalRequests, authorizeTool } = ctx
  let text = ctx.text
  let dataChanged = ctx.dataChanged
  // [SCHEDULE_*] → 일정 도구
  const scheduleMarkers = parseScheduleMarkers(text)
  for (const marker of scheduleMarkers) {
    if (marker.action === 'create') {
      const gate = await authorizeTool('SCHEDULE_CREATE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      // AI 도구 경로(마커 포함)는 과거 start_at을 거부한다 (FC 경로와 동일 규칙)
      const res = await executeScheduleCreate(env, marker.data, { rejectPast: true })
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success ? `일정 등록했어: ${marker.data.title}` : `일정 등록에 실패했어.`)
    } else if (marker.action === 'list') {
      const gate = await authorizeTool('SCHEDULE_LIST', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeScheduleList(env, marker.data)
      if (res.success && res.data.length > 0) {
        const items = res.data.map((s: any) => {
          const dt = s.start_at ? String(s.start_at).replace('T', ' ').slice(5, 16) : ''
          // 일정 제목은 DB 데이터 — 안에 심어진 마커가 후속 파서에서 실행되지 않도록 정제
          return `- ${dt} ${sanitizeToolOutput(String(s.title || ''))}`
        }).join('\n')
        text = text.replace(marker.full, `일정 목록이야:\n${items}`)
      } else {
        text = text.replace(marker.full, `등록된 일정이 없어.`)
      }
    } else if (marker.action === 'update') {
      const gate = await authorizeTool('SCHEDULE_UPDATE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeScheduleUpdate(env, marker.data)
      if (res.success) dataChanged = true;
      toolResults.push({ success: res.success, toolName: 'schedule_update', error: res.error, candidates: (res as any).candidates })
      text = text.replace(marker.full, res.success ? `일정 수정했어.` : `일정 수정 실패: ${res.error}`)
    } else if (marker.action === 'delete') {
      const gate = await authorizeTool('SCHEDULE_DELETE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeScheduleDelete(env, marker.data)
      const label = marker.data.title || `id ${marker.data.id}`
      if (res.success) dataChanged = true;
      toolResults.push({ success: res.success, toolName: 'schedule_delete', error: res.error, candidates: (res as any).candidates })
      text = text.replace(marker.full, res.success ? `삭제했어.` : `삭제 실패: ${res.error}`)
    }
  }
  ctx.text = text
  ctx.dataChanged = dataChanged
}

// [GMAIL_*]/[GCAL_*] 마커 처리
export async function processGoogleMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, approvalRequests, authorizeTool } = ctx
  let text = ctx.text
  // [GMAIL_*]/[GCAL_*] → Google 연동 도구 (진짜 비서 3단계 g트랙)
  // - 미연동 시 안내 문장으로 교체하고 로컬 일정 조회에는 영향을 주지 않는다.
  // - GCAL_LIST는 로컬 일정 + Google 이벤트를 합쳐서 반환한다.
  const googleMarkers = parseGoogleMarkers(text)
  for (const marker of googleMarkers) {
    if (marker.action === 'gmail_search') {
      const gate = await authorizeTool('GMAIL_SEARCH', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeGmailSearch(env, marker.data)
      if (!res.success) {
        text = text.replace(marker.full, res.error === 'not_connected' ? GOOGLE_NOT_CONNECTED_MESSAGE : res.error === 'revoked' ? GOOGLE_RECONNECT_MESSAGE : '메일 검색에 실패했어.')
      } else if (res.data.length > 0) {
        const items = res.data.map((m: any) => `- ${sanitizeToolOutput(String(m.subject || '(제목 없음)'))} (${sanitizeToolOutput(String(m.from || ''))})`).join('\n')
        text = text.replace(marker.full, `찾은 메일이야:\n${items}`)
      } else {
        text = text.replace(marker.full, `관련 메일이 없어.`)
      }
    } else if (marker.action === 'gmail_get') {
      const gate = await authorizeTool('GMAIL_GET', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeGmailGet(env, marker.data)
      if (!res.success) {
        text = text.replace(marker.full, res.error === 'not_connected' ? GOOGLE_NOT_CONNECTED_MESSAGE : res.error === 'revoked' ? GOOGLE_RECONNECT_MESSAGE : '메일을 가져오지 못했어.')
      } else {
        const m = res.data
        text = text.replace(marker.full, `메일 내용이야:\n제목: ${sanitizeToolOutput(String(m.subject || ''))}\n보낸 사람: ${sanitizeToolOutput(String(m.from || ''))}\n${sanitizeToolOutput(String(m.body || m.snippet || ''))}`)
      }
    } else if (marker.action === 'gcal_list') {
      const gate = await authorizeTool('GCAL_LIST', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeGcalList(env, marker.data)
      if (res.data.length > 0) {
        const items = res.data.map((s: any) => {
          const dt = s.start_at ? String(s.start_at).replace('T', ' ').slice(5, 16) : ''
          const src = s.source === 'google' ? '[구글] ' : ''
          return `- ${dt} ${src}${sanitizeToolOutput(String(s.title || ''))}`
        }).join('\n')
        text = text.replace(marker.full, `일정 목록이야:\n${items}`)
      } else {
        text = text.replace(marker.full, `등록된 일정이 없어.`)
      }
    } else if (marker.action === 'gcal_create') {
      const gate = await authorizeTool('GCAL_CREATE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeGcalCreate(env, marker.data)
      if (!res.success) {
        text = text.replace(marker.full,
          res.error === 'not_connected' ? GOOGLE_NOT_CONNECTED_MESSAGE
          : res.error === 'revoked' ? GOOGLE_RECONNECT_MESSAGE
          : res.error === 'scope_missing' ? '구글 캘린더 쓰기 권한이 없어요. 설정에서 쓰기 권한으로 다시 연결해 주세요.'
          : '구글 캘린더 일정 등록에 실패했어.')
      } else {
        text = text.replace(marker.full, `구글 캘린더에 일정 등록했어: ${sanitizeToolOutput(String(res.data.summary || ''))}`)
      }
    }
  }
  ctx.text = text
}

// [TODO_*] 마커 처리
export async function processTodoMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, approvalRequests, authorizeTool } = ctx
  let text = ctx.text
  let dataChanged = ctx.dataChanged
  // [TODO_*] → 할일 도구
  const todoMarkers = parseTodoMarkers(text)
  for (const marker of todoMarkers) {
    if (marker.action === 'add') {
      const gate = await authorizeTool('TODO_ADD', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeTodoAdd(env, marker.data)
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success ? `할일 추가했어: ${marker.data.title}` : `할일 추가에 실패했어.`)
    } else if (marker.action === 'list') {
      const gate = await authorizeTool('TODO_LIST', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeTodoList(env, marker.data)
      if (res.success && res.data.length > 0) {
        // 할일 제목은 DB 데이터 — 안에 심어진 마커가 후속 파서에서 실행되지 않도록 정제
        const items = res.data.map((t: any) => `- [ ] ${sanitizeToolOutput(String(t.title || ''))} (id: ${t.id})`).join('\n')
        text = text.replace(marker.full, `할일 목록이야:\n${items}`)
      } else {
        text = text.replace(marker.full, `등록된 할일이 없어.`)
      }
    } else if (marker.action === 'done') {
      const gate = await authorizeTool('TODO_DONE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeTodoDone(env, marker.data)
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success ? `할일 완료했어.` : `처리 실패했어.`)
    } else if (marker.action === 'update') {
      const gate = await authorizeTool('TODO_UPDATE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeTodoUpdate(env, marker.data)
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success ? `할일 수정했어.` : `할일 수정 실패: ${res.error}`)
    } else if (marker.action === 'delete') {
      const gate = await authorizeTool('TODO_DELETE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeTodoDelete(env, marker.data)
      if (res.success) dataChanged = true;
      text = text.replace(marker.full, res.success ? `삭제했어.` : `삭제 실패: ${res.error}`)
    }
  }

  // 노바 아티팩트 마커 처리
  ctx.text = text
  ctx.dataChanged = dataChanged
}

// 아티팩트 마커 처리
export async function processArtifactMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, approvalRequests, authorizeTool } = ctx
  let text = ctx.text
  let dataChanged = ctx.dataChanged
  const artifactMarkers = parseArtifactMarkers(text)
  for (const marker of artifactMarkers) {
    if (marker.action === 'create') {
      const gate = await authorizeTool('ARTIFACT_CREATE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeArtifactCreate(env, marker.data)
      if (res.success) {
        dataChanged = true;
        text = text.replace(marker.full, `아티팩트 만들었어: ${marker.data.title} (홈화면에서 확인할 수 있어)`)
      } else {
        text = text.replace(marker.full, `아티팩트 생성 실패: ${res.error}`)
      }
    } else if (marker.action === 'delete') {
      const gate = await authorizeTool('ARTIFACT_DELETE', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeArtifactDelete(env, marker.data)
      if (res.success) {
        dataChanged = true;
        text = text.replace(marker.full, `아티팩트 삭제했어.`)
      } else {
        text = text.replace(marker.full, `삭제 실패: ${res.error}`)
      }
    } else if (marker.action === 'from_github') {
      const gate = await authorizeTool('ARTIFACT_FROM_GITHUB', marker.data, marker.full)
      if (!gate.allowed) {
        text = text.replace(marker.full, gate.message)
        if (gate.request) approvalRequests.push(gate.request)
        continue
      }
      const res = await executeArtifactFromGithub(env, marker.data)
      if (res.success) {
        dataChanged = true;
        text = text.replace(marker.full, `GitHub에서 가져왔어: ${res.data.title} (홈화면에서 확인해)`)
      } else {
        text = text.replace(marker.full, `가져오기 실패: ${res.error}`)
      }
    }
  }
  ctx.text = text
  ctx.dataChanged = dataChanged
}
