/// <reference types="jest" />
/**
 * B-L7 게이트 핀: tool-markers-actions.ts의 20개 핸들러는 모두
 * authorizeTool 게이트를 거친 뒤에만 실행기를 호출한다. 게이트+실행
 * 패턴을 헬퍼로 추출해도 이 성질이 깨지지 않음을 고정한다.
 *
 * 핵심 성질 (핸들러 20개 전수):
 * ① 거부 시: authorizeTool이 기대한 도구명으로 호출되고, 실행기는
 *    호출되지 않으며, 원장 기록도 없고, 마커가 게이트 메시지로 교체된다.
 * ② 허용 시: 실행기가 1회 호출되고, 원장이 기대한 toolName/mode로 기록된다.
 * 카나리아: 어느 핸들러에서든 게이트 호출을 빼면 ①의 해당 케이스가 실패한다.
 */
import {
  processArtifactMarkers,
  processCronMarkers,
  processGoogleMarkers,
  processScheduleMarkers,
  processTodoMarkers,
} from '../../src/modules/ai/tool-markers-actions'
import type { ToolMarkerContext } from '../../src/modules/ai/tool-marker-context'

jest.mock('../../src/services/cron-tools', () => {
  const actual = jest.requireActual('../../src/services/cron-tools')
  return {
    ...actual,
    executeCronCreate: jest.fn(),
    executeCronList: jest.fn(),
    executeCronDelete: jest.fn(),
    executeCronToggle: jest.fn(),
  }
})
jest.mock('../../src/services/schedule-tools', () => {
  const actual = jest.requireActual('../../src/services/schedule-tools')
  return {
    ...actual,
    executeScheduleCreate: jest.fn(),
    executeScheduleList: jest.fn(),
    executeScheduleUpdate: jest.fn(),
    executeScheduleDelete: jest.fn(),
  }
})
jest.mock('../../src/services/google-tools', () => {
  const actual = jest.requireActual('../../src/services/google-tools')
  return {
    ...actual,
    executeGmailSearch: jest.fn(),
    executeGmailGet: jest.fn(),
    executeGcalList: jest.fn(),
    executeGcalCreate: jest.fn(),
  }
})
jest.mock('../../src/services/todo-tools', () => {
  const actual = jest.requireActual('../../src/services/todo-tools')
  return {
    ...actual,
    executeTodoAdd: jest.fn(),
    executeTodoList: jest.fn(),
    executeTodoDone: jest.fn(),
    executeTodoUpdate: jest.fn(),
    executeTodoDelete: jest.fn(),
  }
})
jest.mock('../../src/services/artifact-tools', () => {
  const actual = jest.requireActual('../../src/services/artifact-tools')
  return {
    ...actual,
    executeArtifactCreate: jest.fn(),
    executeArtifactDelete: jest.fn(),
    executeArtifactFromGithub: jest.fn(),
  }
})
jest.mock('../../src/services/tool-ledger', () => {
  const actual = jest.requireActual('../../src/services/tool-ledger')
  return {
    ...actual,
    recordMarkerToolExecution: jest.fn(async () => ({
      recorded: true,
      ledgerId: 1,
      runId: 'run-1',
      toolCallId: 'call-1',
    })),
  }
})

import * as cronTools from '../../src/services/cron-tools'
import * as scheduleTools from '../../src/services/schedule-tools'
import * as googleTools from '../../src/services/google-tools'
import * as todoTools from '../../src/services/todo-tools'
import * as artifactTools from '../../src/services/artifact-tools'
import { recordMarkerToolExecution } from '../../src/services/tool-ledger'

const mockRecord = recordMarkerToolExecution as jest.Mock
const exec = (fn: any) => fn as jest.Mock

type HandlerSpec = {
  name: string
  process: (ctx: ToolMarkerContext) => Promise<void>
  marker: string
  gateTool: string
  gateArgs: unknown
  executeFn: () => jest.Mock
  executeArgs: unknown[]
  executeResult: unknown
  ledgerTool: string
  ledgerMode: 'read' | 'write'
  ledgerArgs?: unknown
  successText: string
}

const SPECS: HandlerSpec[] = [
  {
    name: 'CRON_CREATE',
    process: processCronMarkers,
    marker: '[CRON_CREATE]{"text":"매일 아침 9시"}[/CRON_CREATE]',
    gateTool: 'CRON_CREATE',
    gateArgs: { text: '매일 아침 9시' },
    executeFn: () => exec(cronTools.executeCronCreate),
    executeArgs: [{}, '매일 아침 9시'],
    executeResult: { success: true, data: { description: '매일 9시 알림' } },
    ledgerTool: 'cron_create',
    ledgerMode: 'write',
    ledgerArgs: { text: '매일 아침 9시' },
    successText: '자동화를 저장했습니다: 매일 9시 알림',
  },
  {
    name: 'CRON_LIST',
    process: processCronMarkers,
    marker: '[CRON_LIST][/CRON_LIST]',
    gateTool: 'CRON_LIST',
    gateArgs: {},
    executeFn: () => exec(cronTools.executeCronList),
    executeArgs: [{}],
    executeResult: { success: true, data: { jobs: [] } },
    ledgerTool: 'cron_list',
    ledgerMode: 'read',
    successText: '저장된 자동화가 없습니다.',
  },
  {
    name: 'CRON_DELETE',
    process: processCronMarkers,
    marker: '[CRON_DELETE]{"id":3}[/CRON_DELETE]',
    gateTool: 'CRON_DELETE',
    gateArgs: { id: 3 },
    executeFn: () => exec(cronTools.executeCronDelete),
    executeArgs: [{}, 3],
    executeResult: { success: true },
    ledgerTool: 'cron_delete',
    ledgerMode: 'write',
    ledgerArgs: { id: 3 },
    successText: '자동화를 삭제했습니다.',
  },
  {
    name: 'CRON_TOGGLE',
    process: processCronMarkers,
    marker: '[CRON_TOGGLE]{"id":3,"enabled":true}[/CRON_TOGGLE]',
    gateTool: 'CRON_TOGGLE',
    gateArgs: { id: 3, enabled: true },
    executeFn: () => exec(cronTools.executeCronToggle),
    executeArgs: [{}, 3, true],
    executeResult: { success: true, data: { enabled: true, description: 'd' } },
    ledgerTool: 'cron_set_enabled',
    ledgerMode: 'write',
    ledgerArgs: { id: 3, enabled: true },
    successText: '자동화를 켰습니다',
  },
  {
    name: 'SCHEDULE_CREATE',
    process: processScheduleMarkers,
    marker: '[SCHEDULE_CREATE]{"title":"t"}[/SCHEDULE_CREATE]',
    gateTool: 'SCHEDULE_CREATE',
    gateArgs: { title: 't' },
    executeFn: () => exec(scheduleTools.executeScheduleCreate),
    executeArgs: [{}, { title: 't' }, { rejectPast: true }],
    executeResult: { success: true },
    ledgerTool: 'schedule_create',
    ledgerMode: 'write',
    ledgerArgs: { title: 't' },
    successText: '일정을 등록했습니다: t',
  },
  {
    name: 'SCHEDULE_LIST',
    process: processScheduleMarkers,
    marker: '[SCHEDULE_LIST]{}[/SCHEDULE_LIST]',
    gateTool: 'SCHEDULE_LIST',
    gateArgs: {},
    executeFn: () => exec(scheduleTools.executeScheduleList),
    executeArgs: [{}, {}],
    executeResult: { success: true, data: [] },
    ledgerTool: 'schedule_list',
    ledgerMode: 'read',
    ledgerArgs: {},
    successText: '등록된 일정이 없습니다.',
  },
  {
    name: 'SCHEDULE_UPDATE',
    process: processScheduleMarkers,
    marker: '[SCHEDULE_UPDATE]{"id":1}[/SCHEDULE_UPDATE]',
    gateTool: 'SCHEDULE_UPDATE',
    gateArgs: { id: 1 },
    executeFn: () => exec(scheduleTools.executeScheduleUpdate),
    executeArgs: [{}, { id: 1 }],
    executeResult: { success: true },
    ledgerTool: 'schedule_update',
    ledgerMode: 'write',
    ledgerArgs: { id: 1 },
    successText: '일정을 수정했습니다.',
  },
  {
    name: 'SCHEDULE_DELETE',
    process: processScheduleMarkers,
    marker: '[SCHEDULE_DELETE]{"id":1,"title":"t"}[/SCHEDULE_DELETE]',
    gateTool: 'SCHEDULE_DELETE',
    gateArgs: { id: 1, title: 't' },
    executeFn: () => exec(scheduleTools.executeScheduleDelete),
    executeArgs: [{}, { id: 1, title: 't' }],
    executeResult: { success: true },
    ledgerTool: 'schedule_delete',
    ledgerMode: 'write',
    ledgerArgs: { id: 1, title: 't' },
    successText: '삭제했습니다.',
  },
  {
    name: 'GMAIL_SEARCH',
    process: processGoogleMarkers,
    marker: '[GMAIL_SEARCH]{"q":"x"}[/GMAIL_SEARCH]',
    gateTool: 'GMAIL_SEARCH',
    gateArgs: { q: 'x' },
    executeFn: () => exec(googleTools.executeGmailSearch),
    executeArgs: [{}, { q: 'x' }],
    executeResult: { success: true, data: [] },
    ledgerTool: 'gmail_search',
    ledgerMode: 'read',
    ledgerArgs: { q: 'x' },
    successText: '관련 메일이 없습니다.',
  },
  {
    name: 'GMAIL_GET',
    process: processGoogleMarkers,
    marker: '[GMAIL_GET]{"id":"abc"}[/GMAIL_GET]',
    gateTool: 'GMAIL_GET',
    gateArgs: { id: 'abc' },
    executeFn: () => exec(googleTools.executeGmailGet),
    executeArgs: [{}, { id: 'abc' }],
    executeResult: { success: true, data: { subject: 's', from: 'f', body: 'b' } },
    ledgerTool: 'gmail_get',
    ledgerMode: 'read',
    ledgerArgs: { id: 'abc' },
    successText: '메일 내용입니다:',
  },
  {
    name: 'GCAL_LIST',
    process: processGoogleMarkers,
    marker: '[GCAL_LIST]{}[/GCAL_LIST]',
    gateTool: 'GCAL_LIST',
    gateArgs: { from: undefined, to: undefined },
    executeFn: () => exec(googleTools.executeGcalList),
    executeArgs: [{}, { from: undefined, to: undefined }],
    executeResult: { success: true, data: [] },
    ledgerTool: 'gcal_list',
    ledgerMode: 'read',
    ledgerArgs: { from: undefined, to: undefined },
    successText: '등록된 일정이 없습니다.',
  },
  {
    name: 'GCAL_CREATE',
    process: processGoogleMarkers,
    marker: '[GCAL_CREATE]{"title":"t"}[/GCAL_CREATE]',
    gateTool: 'GCAL_CREATE',
    gateArgs: { title: 't', start_at: undefined, end_at: undefined, description: undefined, location: undefined },
    executeFn: () => exec(googleTools.executeGcalCreate),
    executeArgs: [{}, { title: 't', start_at: undefined, end_at: undefined, description: undefined, location: undefined }],
    executeResult: { success: true, data: { summary: 't' } },
    ledgerTool: 'gcal_create',
    ledgerMode: 'write',
    ledgerArgs: { title: 't', start_at: undefined, end_at: undefined, description: undefined, location: undefined },
    successText: '구글 캘린더에 일정을 등록했습니다: t',
  },
  {
    name: 'TODO_ADD',
    process: processTodoMarkers,
    marker: '[TODO_ADD]{"title":"t"}[/TODO_ADD]',
    gateTool: 'TODO_ADD',
    gateArgs: { title: 't' },
    executeFn: () => exec(todoTools.executeTodoAdd),
    executeArgs: [{}, { title: 't' }],
    executeResult: { success: true },
    ledgerTool: 'todo_add',
    ledgerMode: 'write',
    ledgerArgs: { title: 't' },
    successText: '할일을 추가했습니다: t',
  },
  {
    name: 'TODO_LIST',
    process: processTodoMarkers,
    marker: '[TODO_LIST]{}[/TODO_LIST]',
    gateTool: 'TODO_LIST',
    gateArgs: {},
    executeFn: () => exec(todoTools.executeTodoList),
    executeArgs: [{}, {}],
    executeResult: { success: true, data: [] },
    ledgerTool: 'todo_list',
    ledgerMode: 'read',
    ledgerArgs: {},
    successText: '등록된 할일이 없습니다.',
  },
  {
    name: 'TODO_DONE',
    process: processTodoMarkers,
    marker: '[TODO_DONE]{"id":1}[/TODO_DONE]',
    gateTool: 'TODO_DONE',
    gateArgs: { id: 1 },
    executeFn: () => exec(todoTools.executeTodoDone),
    executeArgs: [{}, { id: 1 }],
    executeResult: { success: true },
    ledgerTool: 'todo_done',
    ledgerMode: 'write',
    ledgerArgs: { id: 1 },
    successText: '할일을 완료했습니다.',
  },
  {
    name: 'TODO_UPDATE',
    process: processTodoMarkers,
    marker: '[TODO_UPDATE]{"id":1}[/TODO_UPDATE]',
    gateTool: 'TODO_UPDATE',
    gateArgs: { id: 1 },
    executeFn: () => exec(todoTools.executeTodoUpdate),
    executeArgs: [{}, { id: 1 }],
    executeResult: { success: true },
    ledgerTool: 'todo_update',
    ledgerMode: 'write',
    ledgerArgs: { id: 1 },
    successText: '할일을 수정했습니다.',
  },
  {
    name: 'TODO_DELETE',
    process: processTodoMarkers,
    marker: '[TODO_DELETE]{"id":1}[/TODO_DELETE]',
    gateTool: 'TODO_DELETE',
    gateArgs: { id: 1 },
    executeFn: () => exec(todoTools.executeTodoDelete),
    executeArgs: [{}, { id: 1 }],
    executeResult: { success: true },
    ledgerTool: 'todo_delete',
    ledgerMode: 'write',
    ledgerArgs: { id: 1 },
    successText: '삭제했습니다.',
  },
  {
    name: 'ARTIFACT_CREATE',
    process: processArtifactMarkers,
    marker: '[ARTIFACT_CREATE]{"title":"t","html":"<p>x</p>"}[/ARTIFACT_CREATE]',
    gateTool: 'ARTIFACT_CREATE',
    gateArgs: { title: 't', html: '<p>x</p>' },
    executeFn: () => exec(artifactTools.executeArtifactCreate),
    executeArgs: [{}, { title: 't', html: '<p>x</p>' }],
    executeResult: { success: true },
    ledgerTool: 'artifact_create',
    ledgerMode: 'write',
    ledgerArgs: { title: 't', html: '<p>x</p>' },
    successText: '아티팩트를 만들었습니다: t',
  },
  {
    name: 'ARTIFACT_DELETE',
    process: processArtifactMarkers,
    marker: '[ARTIFACT_DELETE]{"id":7}[/ARTIFACT_DELETE]',
    gateTool: 'ARTIFACT_DELETE',
    gateArgs: { id: 7 },
    executeFn: () => exec(artifactTools.executeArtifactDelete),
    executeArgs: [{}, { id: 7 }],
    executeResult: { success: true },
    ledgerTool: 'artifact_delete',
    ledgerMode: 'write',
    ledgerArgs: { id: 7 },
    successText: '아티팩트를 삭제했습니다.',
  },
  {
    name: 'ARTIFACT_FROM_GITHUB',
    process: processArtifactMarkers,
    marker: '[ARTIFACT_FROM_GITHUB]{"repo":"a/b"}[/ARTIFACT_FROM_GITHUB]',
    gateTool: 'ARTIFACT_FROM_GITHUB',
    gateArgs: { repo: 'a/b' },
    executeFn: () => exec(artifactTools.executeArtifactFromGithub),
    executeArgs: [{}, { repo: 'a/b' }],
    executeResult: { success: true, data: { title: 'gh' } },
    ledgerTool: 'artifact_from_github',
    ledgerMode: 'write',
    ledgerArgs: { repo: 'a/b' },
    successText: 'GitHub에서 가져왔습니다: gh',
  },
]

function makeCtx(
  text: string,
  authorizeTool: ToolMarkerContext['authorizeTool'],
): ToolMarkerContext {
  return {
    env: {},
    text,
    images: [],
    uiActions: [],
    dataChanged: false,
    toolResults: [],
    approvalRequests: [],
    searchReplacementSources: [],
    authorizeTool,
    sanitizeInserted: (s: string) => s,
    denyExecution: () => ({ success: false, error: 'denied' }),
    userRequest: '일정 만들어줘',
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('B-L7 게이트 핀 — 핸들러 20개 전수', () => {
  test('핀 대상이 20개 핸들러 전부인지 확인한다', () => {
    expect(SPECS).toHaveLength(20)
    expect(new Set(SPECS.map((s) => s.gateTool)).size).toBe(20)
  })

  test.each(SPECS)('$name: 거부 시 게이트를 호출하고 실행기는 호출하지 않는다', async (spec) => {
    const authorizeTool = jest.fn(async () => ({
      allowed: false,
      message: 'GATE_DENIED',
      request: { id: 'req-1' } as any,
    }))
    const ctx = makeCtx(`앞 ${spec.marker} 뒤`, authorizeTool)
    await spec.process(ctx)
    expect(authorizeTool).toHaveBeenCalledTimes(1)
    expect(authorizeTool).toHaveBeenCalledWith(spec.gateTool, spec.gateArgs, spec.marker)
    expect(spec.executeFn()).not.toHaveBeenCalled()
    expect(mockRecord).not.toHaveBeenCalled()
    expect(ctx.text).toContain('GATE_DENIED')
    expect(ctx.text).not.toContain(spec.marker)
    expect(ctx.approvalRequests).toHaveLength(1)
  })

  test.each(SPECS)('$name: 허용 시 실행 1회 + 원장 기록(toolName/mode)', async (spec) => {
    const authorizeTool = jest.fn(async () => ({ allowed: true, message: '' }))
    spec.executeFn().mockResolvedValueOnce(spec.executeResult)
    const ctx = makeCtx(`앞 ${spec.marker} 뒤`, authorizeTool)
    await spec.process(ctx)
    expect(authorizeTool).toHaveBeenCalledTimes(1)
    expect(authorizeTool).toHaveBeenCalledWith(spec.gateTool, spec.gateArgs, spec.marker)
    expect(spec.executeFn()).toHaveBeenCalledTimes(1)
    expect(spec.executeFn()).toHaveBeenCalledWith(...spec.executeArgs)
    expect(mockRecord).toHaveBeenCalledTimes(1)
    const [, ledgerInput] = mockRecord.mock.calls[0]
    expect(ledgerInput.toolName).toBe(spec.ledgerTool)
    expect(ledgerInput.mode).toBe(spec.ledgerMode)
    expect(ledgerInput.success).toBe(true)
    if (spec.ledgerArgs !== undefined) {
      expect(ledgerInput.args).toEqual(spec.ledgerArgs)
    }
    expect(ctx.text).toContain(spec.successText)
    expect(ctx.text).not.toContain(spec.marker)
  })
})
