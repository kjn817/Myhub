/**
 * src/modules/ai/routes.ts 커버리지 보강 (그룹 B)
 * - 기존 ai-routes.test.ts가 다루지 않는 구간:
 *   authorizeTool 게이트 분기(251·276·298-299·323·341행),
 *   [CRON_*] 마커(589-599·607-618·624-631·636-647행),
 *   [GMAIL_*]/[GCAL_*] 마커(712-775행),
 *   스킬 힌트 주입(1109-1110행), 승인 응답 가로채기(1522-1590행)
 * - mock 구성은 기존 파일과 동일하게 유지하고, cron-tools / google-tools
 *   mock과 persona-id-adapter의 isValidLegacyPersonaId faithful mock만 추가한다.
 *   (기존 파일의 adapter mock에는 isValidLegacyPersonaId가 없어서
 *   skill-registry의 resolveSkillsForTurn이 throw하고 routes.ts의
 *   try/catch가 삼켜 1109-1110행이 실행되지 않았던 것이 미커버 원인)
 * - tool-approval / approval-flow / sandbox는 기존 파일과 마찬가지로
 *   실제 구현을 쓴다 (게이트·승인 저장소 동작을 그대로 검증).
 * - 프로덕션 코드 수정 없음.
 */
/// <reference types="jest" />
import { Hono } from 'hono'

// ---------------- 모듈 mock (hoisted) ----------------
jest.mock('../../src/services/ai', () => ({
  aiChat: jest.fn(),
  getSetting: jest.fn(),
  setSetting: jest.fn(),
  buildSystemPrompt: jest.fn(),
  PERSONAS: [
    { id: 'concierge', name: '루미', desc: '대표 비서', avatar: '/a/rumi.webp', capabilities: ['대화'] },
    { id: 'keeper', name: '에코', desc: '메모 비서', avatar: '/a/echo.webp', capabilities: ['요약'] },
    { id: 'builder', name: '노바', desc: '코드 비서', avatar: '/a/nova.webp', capabilities: ['코드'] },
    { id: 'scheduler', name: '캘리', desc: '일정 비서', avatar: '/a/cali.webp', capabilities: ['일정'] },
  ],
  MODELS: [
    { id: 'gemini-3.5-flash-lite', provider: 'gemini', quality: 'fast', status: 'active' },
    { id: 'gemini-3.1-flash-lite', provider: 'gemini', quality: 'fast', status: 'active' },
    { id: 'openai/gpt-oss-20b', provider: 'groq', quality: 'fast', status: 'active' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia', quality: 'high', status: 'active' },
    { id: 'gemini-old', provider: 'gemini', quality: 'fast', status: 'deprecated' },
  ],
}))

jest.mock('../../src/services/memory-service', () => {
  const actual = jest.requireActual('../../src/services/memory-service')
  return {
    formatMemoryContext: jest.fn(),
    extractSearchTerms: actual.extractSearchTerms,
    isMemoryV2Enabled: jest.fn(),
  }
})

jest.mock('../../src/services/fact-graph', () => ({
  getRelatedFacts: jest.fn(),
}))

jest.mock('../../src/ai/prompt-integration', () => ({
  isPromptV2Enabled: jest.fn(),
  isPromptV2EnabledForPersona: jest.fn(),
  createRequestTimeContext: jest.fn(),
  composeV2Prompt: jest.fn(),
  resolvePromptVersion: (v2Applied: boolean) => (v2Applied ? 'persona-v1' : 'legacy'),
  LEGACY_PROMPT_VERSION: 'legacy',
}))

jest.mock('../../src/ai/legacy-privacy-guard', () => {
  class PrivacyBlockedError extends Error {
    sensitivity: string
    reason: string
    constructor(message: string, sensitivity: string, reason: string) {
      super(message)
      this.name = 'PrivacyBlockedError'
      this.sensitivity = sensitivity
      this.reason = reason
    }
  }
  // 실제 src/ai/legacy-privacy-guard.ts LEGACY_MARKER_TOOLS와 동일 (faithful).
  // 주의: 기존 ai-routes.test.ts의 mock은 구버전이라 CRON_*·GMAIL_*·GCAL_*이
  // 빠져 있어, 이 도구들의 decideToolExecution이 전부 deny가 되어
  // CRON/Google 마커 실행 분기가 테스트에서 도달 불가했던 것이 미커버 원인이다.
  const LEGACY_MARKER_TOOLS: Record<string, string[]> = {
    concierge: [
      'MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'MEMO_UPDATE', 'MEMO_DELETE',
      'SCHEDULE_CREATE', 'SCHEDULE_LIST', 'SCHEDULE_UPDATE', 'SCHEDULE_DELETE',
      'TODO_ADD', 'TODO_LIST', 'TODO_DONE', 'TODO_UPDATE', 'TODO_DELETE',
      'CRON_CREATE', 'CRON_LIST', 'CRON_DELETE', 'CRON_TOGGLE',
      'SEARCH', 'IMG', 'GITHUB',
      'GMAIL_SEARCH', 'GMAIL_GET', 'GCAL_LIST', 'GCAL_CREATE',
    ],
    keeper: ['MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'MEMO_UPDATE', 'MEMO_DELETE', 'SEARCH', 'CRON_CREATE', 'CRON_LIST', 'CRON_DELETE', 'CRON_TOGGLE'],
    builder: ['SEARCH', 'GITHUB', 'IMG', 'ARTIFACT_CREATE', 'ARTIFACT_DELETE', 'ARTIFACT_FROM_GITHUB'],
    scheduler: [
      'SCHEDULE_CREATE', 'SCHEDULE_LIST', 'SCHEDULE_UPDATE', 'SCHEDULE_DELETE',
      'TODO_ADD', 'TODO_LIST', 'TODO_DONE', 'TODO_UPDATE', 'TODO_DELETE',
      'CRON_CREATE', 'CRON_LIST', 'CRON_DELETE', 'CRON_TOGGLE',
      'SEARCH',
      'GMAIL_SEARCH', 'GMAIL_GET', 'GCAL_LIST', 'GCAL_CREATE',
    ],
  }
  return {
    PrivacyBlockedError,
    getLegacyMarkerTools: (personaId: string) => LEGACY_MARKER_TOOLS[personaId] || LEGACY_MARKER_TOOLS.concierge,
    resolveRequestSensitivity: jest.fn(),
  }
})

jest.mock('../../src/services/orchestrator', () => ({
  orchestrate: jest.fn(),
}))

jest.mock('../../src/services/router', () => ({
  isValidPersonaId: jest.fn((id: unknown) => id === 'lumi' || id === 'echo' || id === 'nova' || id === 'cali'),
  CLEF_MODEL: 'clef-flash-test',
}))

jest.mock('../../src/services/memo-tools', () => ({
  parseMemoSearchMarkers: jest.fn(),
  parseMemoGetMarkers: jest.fn(),
  parseMemoCreateMarkers: jest.fn(),
  parseMemoUpdateMarkers: jest.fn(),
  parseMemoDeleteMarkers: jest.fn(),
  executeMemoSearch: jest.fn(),
  executeMemoGet: jest.fn(),
  executeMemoCreate: jest.fn(),
  executeMemoUpdate: jest.fn(),
  executeMemoDelete: jest.fn(),
}))

jest.mock('../../src/services/memo-response', () => ({
  processSearchMarker: jest.fn(),
}))

jest.mock('../../src/ai/function-calling-route', () => ({
  shouldUseFunctionCalling: jest.fn(),
  chatWithFunctionCalling: jest.fn(),
}))

jest.mock('../../src/services/schedule-tools', () => ({
  parseScheduleMarkers: jest.fn(),
  executeScheduleCreate: jest.fn(),
  executeScheduleList: jest.fn(),
  executeScheduleUpdate: jest.fn(),
  executeScheduleDelete: jest.fn(),
}))

jest.mock('../../src/services/artifact-tools', () => ({
  parseArtifactMarkers: jest.fn(),
  executeArtifactCreate: jest.fn(),
  executeArtifactDelete: jest.fn(),
  executeArtifactFromGithub: jest.fn(),
  detectHtmlFromResponse: jest.fn(),
  saveArtifactDraft: jest.fn(),
}))

jest.mock('../../src/services/todo-tools', () => ({
  parseTodoMarkers: jest.fn(),
  executeTodoAdd: jest.fn(),
  executeTodoList: jest.fn(),
  executeTodoDone: jest.fn(),
  executeTodoUpdate: jest.fn(),
  executeTodoDelete: jest.fn(),
}))

jest.mock('../../src/services/persona-id-adapter', () => ({
  normalizeLegacyPersonaId: jest.fn(),
  // 기존 파일 mock에는 없던 faithful 구현 — skill-registry가 사용한다.
  isValidLegacyPersonaId: jest.fn(),
}))

jest.mock('../../src/services/memo-context', () => ({
  getMemoContext: jest.fn(),
}))

jest.mock('../../src/services/ai-access', () => ({
  searchAccessibleMemos: jest.fn(),
}))

jest.mock('../../src/services/tools', () => ({
  getToolDefinitions: jest.fn(),
}))

jest.mock('../../src/services/cron-tools', () => ({
  parseCronCreateMarkers: jest.fn(),
  parseCronListMarkers: jest.fn(),
  parseCronDeleteMarkers: jest.fn(),
  parseCronToggleMarkers: jest.fn(),
  executeCronCreate: jest.fn(),
  executeCronList: jest.fn(),
  executeCronDelete: jest.fn(),
  executeCronToggle: jest.fn(),
}))

jest.mock('../../src/services/google-tools', () => ({
  parseGoogleMarkers: jest.fn(),
  executeGmailSearch: jest.fn(),
  executeGmailGet: jest.fn(),
  executeGcalList: jest.fn(),
  executeGcalCreate: jest.fn(),
  // 실제 google-tools.ts의 문장 그대로 (소스 기준 verbatim)
  GOOGLE_NOT_CONNECTED_MESSAGE:
    'Google 연동이 안 되어 있어요. 일정 화면 상단의 Google 연동에서 계정을 연결하면 Gmail·캘린더를 함께 볼 수 있어요.',
  GOOGLE_RECONNECT_MESSAGE:
    'Google 연동이 끊어졌어요. 일정 화면 상단의 Google 연동에서 계정을 다시 연결해 주세요.',
}))

jest.mock('../../src/modules/ai/feedback', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Hono } = require('hono')
  const feedbackApp = new Hono()
  feedbackApp.get('/ping', (c: any) => c.json({ ok: true, ping: true }))
  return { feedbackApp }
})

// ---------------- 테스트 대상 import ----------------
import { aiApp, callSingleAssistant, processToolMarkers } from '../../src/modules/ai/routes'
import { aiChat, setSetting, buildSystemPrompt } from '../../src/services/ai'
import { formatMemoryContext, isMemoryV2Enabled } from '../../src/services/memory-service'
import { getRelatedFacts } from '../../src/services/fact-graph'
import {
  isPromptV2EnabledForPersona, createRequestTimeContext, composeV2Prompt,
} from '../../src/ai/prompt-integration'
import {
  resolveRequestSensitivity, PrivacyBlockedError, getLegacyMarkerTools,
} from '../../src/ai/legacy-privacy-guard'
import { orchestrate } from '../../src/services/orchestrator'
import { isValidPersonaId } from '../../src/services/router'
import {
  parseMemoSearchMarkers, parseMemoGetMarkers, parseMemoCreateMarkers,
  parseMemoUpdateMarkers, parseMemoDeleteMarkers, executeMemoSearch, executeMemoGet,
  executeMemoCreate, executeMemoUpdate, executeMemoDelete,
} from '../../src/services/memo-tools'
import { processSearchMarker } from '../../src/services/memo-response'
import { shouldUseFunctionCalling, chatWithFunctionCalling } from '../../src/ai/function-calling-route'
import {
  parseScheduleMarkers, executeScheduleCreate, executeScheduleList,
  executeScheduleUpdate, executeScheduleDelete,
} from '../../src/services/schedule-tools'
import {
  parseArtifactMarkers, executeArtifactCreate, executeArtifactDelete,
  executeArtifactFromGithub, detectHtmlFromResponse, saveArtifactDraft,
} from '../../src/services/artifact-tools'
import {
  parseTodoMarkers, executeTodoAdd, executeTodoList, executeTodoDone,
  executeTodoUpdate, executeTodoDelete,
} from '../../src/services/todo-tools'
import { normalizeLegacyPersonaId, isValidLegacyPersonaId } from '../../src/services/persona-id-adapter'
import { getMemoContext } from '../../src/services/memo-context'
import { searchAccessibleMemos } from '../../src/services/ai-access'
import { getToolDefinitions } from '../../src/services/tools'
import {
  parseCronCreateMarkers, parseCronListMarkers, parseCronDeleteMarkers,
  parseCronToggleMarkers, executeCronCreate, executeCronList,
  executeCronDelete, executeCronToggle,
} from '../../src/services/cron-tools'
import {
  parseGoogleMarkers, executeGmailSearch, executeGmailGet,
  executeGcalList, executeGcalCreate,
} from '../../src/services/google-tools'

const mockAiChat = aiChat as jest.Mock
const mockSetSetting = setSetting as jest.Mock
const mockBuildSystemPrompt = buildSystemPrompt as jest.Mock
const mockGetRelatedFacts = getRelatedFacts as jest.Mock
const mockFormatMemoryContext = formatMemoryContext as jest.Mock
const mockIsMemoryV2Enabled = isMemoryV2Enabled as jest.Mock
const mockIsPromptV2EnabledForPersona = isPromptV2EnabledForPersona as jest.Mock
const mockCreateRequestTimeContext = createRequestTimeContext as jest.Mock
const mockComposeV2Prompt = composeV2Prompt as jest.Mock
const mockResolveSensitivity = resolveRequestSensitivity as jest.Mock
const mockOrchestrate = orchestrate as jest.Mock
const mockIsValidPersonaId = isValidPersonaId as unknown as jest.Mock
const mockParseMemoSearchMarkers = parseMemoSearchMarkers as jest.Mock
const mockParseMemoGetMarkers = parseMemoGetMarkers as jest.Mock
const mockParseMemoCreateMarkers = parseMemoCreateMarkers as jest.Mock
const mockParseMemoUpdateMarkers = parseMemoUpdateMarkers as jest.Mock
const mockParseMemoDeleteMarkers = parseMemoDeleteMarkers as jest.Mock
const mockExecuteMemoSearch = executeMemoSearch as jest.Mock
const mockExecuteMemoGet = executeMemoGet as jest.Mock
const mockExecuteMemoCreate = executeMemoCreate as jest.Mock
const mockExecuteMemoUpdate = executeMemoUpdate as jest.Mock
const mockExecuteMemoDelete = executeMemoDelete as jest.Mock
const mockProcessSearchMarker = processSearchMarker as jest.Mock
const mockShouldUseFunctionCalling = shouldUseFunctionCalling as jest.Mock
const mockChatWithFunctionCalling = chatWithFunctionCalling as jest.Mock
const mockParseScheduleMarkers = parseScheduleMarkers as jest.Mock
const mockExecuteScheduleCreate = executeScheduleCreate as jest.Mock
const mockExecuteScheduleList = executeScheduleList as jest.Mock
const mockExecuteScheduleUpdate = executeScheduleUpdate as jest.Mock
const mockExecuteScheduleDelete = executeScheduleDelete as jest.Mock
const mockParseArtifactMarkers = parseArtifactMarkers as jest.Mock
const mockExecuteArtifactCreate = executeArtifactCreate as jest.Mock
const mockExecuteArtifactDelete = executeArtifactDelete as jest.Mock
const mockExecuteArtifactFromGithub = executeArtifactFromGithub as jest.Mock
const mockDetectHtmlFromResponse = detectHtmlFromResponse as jest.Mock
const mockSaveArtifactDraft = saveArtifactDraft as jest.Mock
const mockParseTodoMarkers = parseTodoMarkers as jest.Mock
const mockExecuteTodoAdd = executeTodoAdd as jest.Mock
const mockExecuteTodoList = executeTodoList as jest.Mock
const mockExecuteTodoDone = executeTodoDone as jest.Mock
const mockExecuteTodoUpdate = executeTodoUpdate as jest.Mock
const mockExecuteTodoDelete = executeTodoDelete as jest.Mock
const mockNormalizeLegacyPersonaId = normalizeLegacyPersonaId as jest.Mock
const mockIsValidLegacyPersonaId = isValidLegacyPersonaId as unknown as jest.Mock
const mockGetMemoContext = getMemoContext as jest.Mock
const mockSearchAccessibleMemos = searchAccessibleMemos as jest.Mock
const mockGetToolDefinitions = getToolDefinitions as jest.Mock
const mockParseCronCreateMarkers = parseCronCreateMarkers as jest.Mock
const mockParseCronListMarkers = parseCronListMarkers as jest.Mock
const mockParseCronDeleteMarkers = parseCronDeleteMarkers as jest.Mock
const mockParseCronToggleMarkers = parseCronToggleMarkers as jest.Mock
const mockExecuteCronCreate = executeCronCreate as jest.Mock
const mockExecuteCronList = executeCronList as jest.Mock
const mockExecuteCronDelete = executeCronDelete as jest.Mock
const mockExecuteCronToggle = executeCronToggle as jest.Mock
const mockParseGoogleMarkers = parseGoogleMarkers as jest.Mock
const mockExecuteGmailSearch = executeGmailSearch as jest.Mock
const mockExecuteGmailGet = executeGmailGet as jest.Mock
const mockExecuteGcalList = executeGcalList as jest.Mock
const mockExecuteGcalCreate = executeGcalCreate as jest.Mock

// normalizeLegacyPersonaId의 실제 로직 (faithful)
function realNormalize(value: unknown): string | null {
  const LEGACY = new Set(['concierge', 'keeper', 'builder', 'scheduler'])
  const NEW_TO_LEGACY: Record<string, string> = {
    lumi: 'concierge', echo: 'keeper', nova: 'builder', cali: 'scheduler',
  }
  if (typeof value !== 'string') return null
  if (LEGACY.has(value)) return value
  if (Object.prototype.hasOwnProperty.call(NEW_TO_LEGACY, value)) return NEW_TO_LEGACY[value]
  return null
}

// isValidLegacyPersonaId의 실제 로직 (faithful)
function realIsValidLegacy(value: unknown): boolean {
  return value === 'concierge' || value === 'keeper' || value === 'builder' || value === 'scheduler'
}

// ---------------- Mock D1 ----------------
class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
  batchQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []

  prepare(sql: string) {
    const db = this
    const exec = (params: any[]) => {
      db.calls.push({ sql, params })
      return {
        first: async () => {
          const v = db.firstQueue.shift()
          if (v === undefined) return null
          if (v instanceof Error) throw v
          return v
        },
        all: async () => {
          const v = db.allQueue.shift()
          if (v === undefined) return { results: [] }
          if (v instanceof Error) throw v
          return { results: v }
        },
        run: async () => {
          const v = db.runQueue.shift()
          if (v === undefined) return { meta: { last_row_id: 1, changes: 1 } }
          if (v instanceof Error) throw v
          return v
        },
      }
    }
    return {
      bind: (...params: any[]) => exec(params),
      first: () => exec([]).first(),
      all: () => exec([]).all(),
      run: () => exec([]).run(),
    }
  }

  async batch(stmts: any[]) {
    const v = this.batchQueue.shift()
    if (v === undefined) return []
    if (v instanceof Error) throw v
    if (v && typeof v === 'object' && '__throwRaw' in v) throw (v as any).__throwRaw
    return v
  }
}

function makeApp(opts: { db?: MockDb; envExtra?: Record<string, any> } = {}) {
  const db = opts.db ?? new MockDb()
  const app = new Hono()
  app.route('/a', aiApp)
  const env: any = { DB: db, ENVIRONMENT: 'test', ...(opts.envExtra || {}) }
  const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
  const json = (path: string, method: string, body?: any) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { app, db, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

const realFetch = (global as any).fetch

beforeEach(() => {
  jest.resetAllMocks()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})

  mockNormalizeLegacyPersonaId.mockImplementation(realNormalize)
  mockIsValidLegacyPersonaId.mockImplementation(realIsValidLegacy)
  mockAiChat.mockResolvedValue({ text: '안녕', provider: 'gemini', model: 'gemini-3.5-flash-lite' })
  mockBuildSystemPrompt.mockImplementation((id: string) => `시스템:${id} {{TODAY_KO}} {{TODAY}}`)
  mockSetSetting.mockResolvedValue(undefined)
  mockIsPromptV2EnabledForPersona.mockResolvedValue(false)
  mockCreateRequestTimeContext.mockResolvedValue({})
  mockComposeV2Prompt.mockReturnValue({ prompt: 'v2프롬프트' })
  mockResolveSensitivity.mockReturnValue({ sensitivity: 'personal', reason: 'mock' })
  mockGetRelatedFacts.mockResolvedValue([])
  mockFormatMemoryContext.mockReturnValue('')
  mockIsMemoryV2Enabled.mockResolvedValue(false)
  mockShouldUseFunctionCalling.mockResolvedValue(false)
  mockChatWithFunctionCalling.mockResolvedValue({ ok: false, error: 'fc fail' })
  mockIsValidPersonaId.mockImplementation(
    (id: unknown) => id === 'lumi' || id === 'echo' || id === 'nova' || id === 'cali'
  )
  mockProcessSearchMarker.mockImplementation(
    (text: string, marker: any, res: any) => text.replace(marker.full, res && res.success ? '검색결과' : '검색실패')
  )
  mockGetMemoContext.mockResolvedValue(null)
  mockSearchAccessibleMemos.mockResolvedValue([])
  mockDetectHtmlFromResponse.mockReturnValue(null)
  mockSaveArtifactDraft.mockResolvedValue({ success: false })
  mockGetToolDefinitions.mockReturnValue([{ name: 'memo_search' }, { name: 'todo_add' }])

  for (const p of [
    mockParseMemoSearchMarkers, mockParseMemoGetMarkers, mockParseMemoCreateMarkers,
    mockParseMemoUpdateMarkers, mockParseMemoDeleteMarkers,
    mockParseScheduleMarkers, mockParseTodoMarkers, mockParseArtifactMarkers,
    mockParseCronCreateMarkers, mockParseCronListMarkers, mockParseCronDeleteMarkers,
    mockParseCronToggleMarkers, mockParseGoogleMarkers,
  ]) {
    p.mockReturnValue([])
  }
  mockExecuteMemoSearch.mockResolvedValue({ success: true, data: [{ id: 1, title: 't', snippet: 's' }] })
  mockExecuteMemoGet.mockResolvedValue({ success: true, data: { title: 'T', content: 'C' } })
  mockExecuteMemoCreate.mockResolvedValue({ success: true, data: { id: 9 } })
  mockExecuteMemoUpdate.mockResolvedValue({ success: true })
  mockExecuteMemoDelete.mockResolvedValue({ success: true })
  mockExecuteScheduleCreate.mockResolvedValue({ success: true })
  mockExecuteScheduleList.mockResolvedValue({ success: true, data: [] })
  mockExecuteScheduleUpdate.mockResolvedValue({ success: true })
  mockExecuteScheduleDelete.mockResolvedValue({ success: true })
  mockExecuteTodoAdd.mockResolvedValue({ success: true })
  mockExecuteTodoList.mockResolvedValue({ success: true, data: [] })
  mockExecuteTodoDone.mockResolvedValue({ success: true })
  mockExecuteTodoUpdate.mockResolvedValue({ success: true })
  mockExecuteTodoDelete.mockResolvedValue({ success: true })
  mockExecuteArtifactCreate.mockResolvedValue({ success: true })
  mockExecuteArtifactDelete.mockResolvedValue({ success: true })
  mockExecuteArtifactFromGithub.mockResolvedValue({ success: true, data: { title: 'gh-title' } })
  mockExecuteCronCreate.mockResolvedValue({ success: true, data: { description: '매일 아침 브리핑' } })
  mockExecuteCronList.mockResolvedValue({ success: true, data: { jobs: [] } })
  mockExecuteCronDelete.mockResolvedValue({ success: true })
  mockExecuteCronToggle.mockResolvedValue({ success: true, data: { enabled: true, description: '매일 아침 브리핑' } })
  mockExecuteGmailSearch.mockResolvedValue({ success: true, data: [] })
  mockExecuteGmailGet.mockResolvedValue({ success: true, data: { subject: '', from: '', body: '' } })
  mockExecuteGcalList.mockResolvedValue({ success: true, data: [] })
  mockExecuteGcalCreate.mockResolvedValue({ success: true, data: { summary: '' } })
})

afterEach(() => {
  ;(global as any).fetch = realFetch
  jest.restoreAllMocks()
})

// processToolMarkers 직접 호출 헬퍼 (마커 경로만 검증, aiChat·대화방 경유 없음)
const pm = async (personaId: string, text: string, options?: any, db?: MockDb) => {
  const d = db ?? new MockDb()
  return processToolMarkers({ DB: d } as any, { text }, personaId, options)
}

const CRON_CREATE_F = '[CRON_CREATE]{"text":"매일 아침 8시에 브리핑해줘"}[/CRON_CREATE]'
const CRON_LIST_F = '[CRON_LIST]{}[/CRON_LIST]'
const CRON_DELETE_F = '[CRON_DELETE]{"id":5}[/CRON_DELETE]'
const CRON_TOGGLE_F = '[CRON_TOGGLE]{"id":3,"enabled":true}[/CRON_TOGGLE]'
const GMAIL_SEARCH_F = '[GMAIL_SEARCH]{"q":"회의"}[/GMAIL_SEARCH]'
const GMAIL_GET_F = '[GMAIL_GET]{"id":"msg-1"}[/GMAIL_GET]'
const GCAL_LIST_F = '[GCAL_LIST]{"from":"2026-10-26","to":"2026-10-27"}[/GCAL_LIST]'
const GCAL_CREATE_F = '[GCAL_CREATE]{"title":"회의","start_at":"2026-10-26T10:00:00"}[/GCAL_CREATE]'

// ---------------- authorizeTool 게이트 분기 ----------------
describe('processToolMarkers authorizeTool 게이트', () => {
  test('유효하지 않은 비서 → deny-by-default (251행 분기)', async () => {
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('ghost', CRON_CREATE_F)
    expect(r.text).toContain('(이 비서는 CRON_CREATE 도구를 사용할 권한이 없습니다)')
    expect(mockExecuteCronCreate).not.toHaveBeenCalled()
  })

  test('대화 ID 없음 → 승인 요청을 만들지 않고 채팅 재요청 안내 (276-279행)', async () => {
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('concierge', CRON_CREATE_F)
    expect(r.text).toContain('(이 작업은 승인이 필요해서 실행하지 않았어. 채팅에서 다시 요청해줘)')
    expect(mockExecuteCronCreate).not.toHaveBeenCalled()
    expect(r.approvalRequests).toBeUndefined()
  })

  test('대화 ID는 있지만 DB 없음 → 같은 안내 (276행 !env.DB 조건)', async () => {
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await processToolMarkers({} as any, { text: CRON_CREATE_F }, 'concierge', { conversationId: 7 })
    expect(r.text).toContain('(이 작업은 승인이 필요해서 실행하지 않았어. 채팅에서 다시 요청해줘)')
    expect(mockExecuteCronCreate).not.toHaveBeenCalled()
  })

  test('"이 세션 허용" 기록이 있으면 승인 없이 실행한다 (290행)', async () => {
    const db = new MockDb()
    // findSessionAllowance → findLatestApproval이 승인 행을 돌려줌
    db.firstQueue.push({
      id: 1, personaId: 'concierge', tool: 'CRON_CREATE', scopeKey: 'SESSION:7:CRON_CREATE',
      decision: 'approved', expiresAt: null, createdAt: '2026-10-26T00:00:00.000Z',
    })
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('concierge', CRON_CREATE_F, { conversationId: 7 }, db)
    expect(mockExecuteCronCreate).toHaveBeenCalledWith(expect.anything(), '매일 아침 8시에 브리핑해줘')
    expect(r.text).toContain('자동화를 저장했어: 매일 아침 브리핑')
  })

  test('세션 허용 조회 실패 → ask로 진행해 승인 요청을 만든다 (291-293행 catch)', async () => {
    const db = new MockDb()
    db.firstQueue.push(new Error('db down')) // findSessionAllowance throw
    db.firstQueue.push(null) // findPendingByScope → 없음
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('concierge', CRON_CREATE_F, { conversationId: 7, userRequest: '매일 아침 브리핑해줘' }, db)
    expect(r.text).toContain('[승인이 필요해요]')
    expect(r.text).toContain('[실행 전 미리보기')
    expect(r.approvalRequests).toHaveLength(1)
    expect(r.approvalRequests?.[0].tool).toBe('CRON_CREATE')
    expect(mockExecuteCronCreate).not.toHaveBeenCalled()
  })

  test('이미 대기 중인 동일 범위 요청이 있으면 재사용한다 (298-299행)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 허용 없음
    db.firstQueue.push({
      id: 42, personaId: 'concierge', conversationId: 7, tool: 'CRON_CREATE', scopeKey: 'CRON_CREATE',
      markerText: CRON_CREATE_F, summary: '자동화 저장 "매일 아침 8시에 브리핑해줘"',
      userRequest: '매일 아침 브리핑해줘', reversible: true,
      impact: '반복 자동화 1개가 저장됩니다. 필요 없으면 끄거나 삭제할 수 있어요.',
      status: 'pending', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    })
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('concierge', CRON_CREATE_F, { conversationId: 7 }, db)
    expect(r.text).toContain('[승인이 필요해요]')
    expect(r.text).toContain('자동화 저장')
    expect(r.approvalRequests).toHaveLength(1)
    expect(r.approvalRequests?.[0].id).toBe(42)
    expect(mockExecuteCronCreate).not.toHaveBeenCalled()
    // 새로 만들지 않음 (INSERT INTO tool_approval_requests 없음)
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO tool_approval_requests'))).toHaveLength(0)
  })

  test('dry-run 미리보기 실패 → 미리보기 없이 승인 요청을 만든다 (323행)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 허용 없음
    db.firstQueue.push(null) // 대기 요청 없음
    db.firstQueue.push(new Error('dry-run db down')) // buildDryRunPreview의 user_cron_jobs 조회 throw
    mockParseCronDeleteMarkers.mockReturnValueOnce([{ full: CRON_DELETE_F, id: 5 }])
    const r = await pm('concierge', CRON_DELETE_F, { conversationId: 7 }, db)
    expect(r.text).toContain('[승인이 필요해요]')
    expect(r.text).toContain('자동화 #5 삭제')
    expect(r.text).not.toContain('[실행 전 미리보기')
    expect(r.approvalRequests).toHaveLength(1)
    expect(r.approvalRequests?.[0].tool).toBe('CRON_DELETE')
  })

  test('대기 요청 조회 throw → 승인 요청 생성 실패 안내 (341행)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 허용 없음
    db.firstQueue.push(new Error('db down')) // findPendingByScope throw
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('concierge', CRON_CREATE_F, { conversationId: 7 }, db)
    expect(r.text).toContain('(승인 요청을 만들지 못했어. 실행하지 않았어)')
    expect(r.approvalRequests).toBeUndefined()
    expect(mockExecuteCronCreate).not.toHaveBeenCalled()
  })

  test('대기 요청 INSERT 실패 → 승인 요청 생성 실패 안내 (341행, createPending 경로)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 허용 없음
    db.firstQueue.push(null) // 대기 요청 없음
    db.runQueue.push({ meta: { last_row_id: 3, changes: 1 } }) // 감사 기록(preview_shown) 성공
    db.runQueue.push(new Error('insert fail')) // createPending throw
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('concierge', CRON_CREATE_F, { conversationId: 7 }, db)
    expect(r.text).toContain('(승인 요청을 만들지 못했어. 실행하지 않았어)')
    expect(r.approvalRequests).toBeUndefined()
    expect(mockExecuteCronCreate).not.toHaveBeenCalled()
  })
})

// ---------------- [CRON_*] 마커 ----------------
describe('[CRON_*] 마커', () => {
  test('[CRON_CREATE] 승인됨 → 성공/실패 문장', async () => {
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    mockExecuteCronCreate.mockResolvedValueOnce({ success: true, data: { description: '매일 아침 8시 브리핑' } })
    const r1 = await pm('concierge', CRON_CREATE_F, { approvedScopeKeys: new Set(['CRON_CREATE']) })
    expect(r1.text).toContain('자동화를 저장했어: 매일 아침 8시 브리핑')

    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    mockExecuteCronCreate.mockResolvedValueOnce({ success: false, error: '시간 표현을 이해하지 못했어' })
    const r2 = await pm('concierge', CRON_CREATE_F, { approvedScopeKeys: new Set(['CRON_CREATE']) })
    expect(r2.text).toContain('자동화 저장 실패: 시간 표현을 이해하지 못했어')
  })

  test('[CRON_CREATE] 승인 없음 + 대화 ID → dry-run 미리보기 포함 승인 요청', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    mockParseCronCreateMarkers.mockReturnValueOnce([{ full: CRON_CREATE_F, text: '매일 아침 8시에 브리핑해줘' }])
    const r = await pm('concierge', CRON_CREATE_F, { conversationId: 7, userRequest: '매일 아침 브리핑해줘' }, db)
    expect(r.text).toContain('[승인이 필요해요]')
    expect(r.text).toContain('자동화 저장')
    // CRON_CREATE 미리보기는 DB 조회 없이 만들어진다
    expect(r.text).toContain('[실행 전 미리보기')
    expect(r.text).toContain('매일 아침 8시에 브리핑해줘')
    expect(r.approvalRequests).toHaveLength(1)
    expect(r.approvalRequests?.[0].reversible).toBe(true)
  })

  test('[CRON_LIST] 목록 있음/없음/실패', async () => {
    mockParseCronListMarkers.mockReturnValueOnce([{ full: CRON_LIST_F }])
    mockExecuteCronList.mockResolvedValueOnce({
      success: true, data: { jobs: [{ description: '아침 브리핑' }, { description: '주간 요약' }] },
    })
    const r1 = await pm('concierge', CRON_LIST_F)
    expect(r1.text).toContain('자동화 목록이야:\n- 아침 브리핑\n- 주간 요약')

    mockParseCronListMarkers.mockReturnValueOnce([{ full: CRON_LIST_F }])
    mockExecuteCronList.mockResolvedValueOnce({ success: true, data: { jobs: [] } })
    const r2 = await pm('concierge', CRON_LIST_F)
    expect(r2.text).toContain('저장된 자동화가 없어.')

    mockParseCronListMarkers.mockReturnValueOnce([{ full: CRON_LIST_F }])
    mockExecuteCronList.mockResolvedValueOnce({ success: false })
    const r3 = await pm('concierge', CRON_LIST_F)
    expect(r3.text).toContain('저장된 자동화가 없어.')
  })

  test('[CRON_DELETE] 성공/실패', async () => {
    mockParseCronDeleteMarkers.mockReturnValueOnce([{ full: CRON_DELETE_F, id: 5 }])
    mockExecuteCronDelete.mockResolvedValueOnce({ success: true })
    const r1 = await pm('concierge', CRON_DELETE_F, { approvedScopeKeys: new Set(['CRON_DELETE:5']) })
    expect(r1.text).toContain('자동화 #5를 삭제했어.')

    mockParseCronDeleteMarkers.mockReturnValueOnce([{ full: CRON_DELETE_F, id: 5 }])
    mockExecuteCronDelete.mockResolvedValueOnce({ success: false, error: '없는 자동화야' })
    const r2 = await pm('concierge', CRON_DELETE_F, { approvedScopeKeys: new Set(['CRON_DELETE:5']) })
    expect(r2.text).toContain('자동화 삭제 실패: 없는 자동화야')
  })

  test('[CRON_TOGGLE] 켜기/끄기/실패', async () => {
    mockParseCronToggleMarkers.mockReturnValueOnce([{ full: CRON_TOGGLE_F, id: 3, enabled: true }])
    mockExecuteCronToggle.mockResolvedValueOnce({ success: true, data: { enabled: true, description: '아침 브리핑' } })
    const r1 = await pm('concierge', CRON_TOGGLE_F, { approvedScopeKeys: new Set(['CRON_TOGGLE:3']) })
    expect(r1.text).toContain('자동화를 켰어: 아침 브리핑')

    const offF = '[CRON_TOGGLE]{"id":3,"enabled":false}[/CRON_TOGGLE]'
    mockParseCronToggleMarkers.mockReturnValueOnce([{ full: offF, id: 3, enabled: false }])
    mockExecuteCronToggle.mockResolvedValueOnce({ success: true, data: { enabled: false, description: '아침 브리핑' } })
    const r2 = await pm('concierge', offF, { approvedScopeKeys: new Set(['CRON_TOGGLE:3']) })
    expect(r2.text).toContain('자동화를 껐어: 아침 브리핑')

    mockParseCronToggleMarkers.mockReturnValueOnce([{ full: CRON_TOGGLE_F, id: 3, enabled: true }])
    mockExecuteCronToggle.mockResolvedValueOnce({ success: false, error: 'e' })
    const r3 = await pm('concierge', CRON_TOGGLE_F, { approvedScopeKeys: new Set(['CRON_TOGGLE:3']) })
    expect(r3.text).toContain('자동화 변경 실패: e')
  })

  test('[CRON_TOGGLE] 승인 없음 → 승인 요청 (파괴적 아님·쓰기 등급)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    db.firstQueue.push({ id: 3, nl_text: '아침 브리핑', cron_kst: '0 8 * * *', enabled: 1 }) // dry-run 대상 조회
    mockParseCronToggleMarkers.mockReturnValueOnce([{ full: CRON_TOGGLE_F, id: 3, enabled: true }])
    const r = await pm('concierge', CRON_TOGGLE_F, { conversationId: 7 }, db)
    expect(r.text).toContain('[승인이 필요해요]')
    expect(r.text).toContain('자동화 #3 켜기')
    expect(r.approvalRequests).toHaveLength(1)
    expect(r.approvalRequests?.[0].tool).toBe('CRON_TOGGLE')
    expect(mockExecuteCronToggle).not.toHaveBeenCalled()
  })
})

// ---------------- [GMAIL_*]/[GCAL_*] 마커 ----------------
describe('[GMAIL_*]/[GCAL_*] 마커', () => {
  test('[GMAIL_SEARCH] 미연동/연동 끊김/기타 실패', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_SEARCH_F, action: 'gmail_search', data: { q: '회의' } }])
    mockExecuteGmailSearch.mockResolvedValueOnce({ success: false, error: 'not_connected' })
    const r1 = await pm('concierge', GMAIL_SEARCH_F)
    expect(r1.text).toContain('Google 연동이 안 되어 있어요')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_SEARCH_F, action: 'gmail_search', data: { q: '회의' } }])
    mockExecuteGmailSearch.mockResolvedValueOnce({ success: false, error: 'revoked' })
    const r2 = await pm('concierge', GMAIL_SEARCH_F)
    expect(r2.text).toContain('Google 연동이 끊어졌어요')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_SEARCH_F, action: 'gmail_search', data: { q: '회의' } }])
    mockExecuteGmailSearch.mockResolvedValueOnce({ success: false, error: 'boom' })
    const r3 = await pm('concierge', GMAIL_SEARCH_F)
    expect(r3.text).toContain('메일 검색에 실패했어.')
  })

  test('[GMAIL_SEARCH] 결과 있음/없음 (제목 없음 폴백 포함)', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_SEARCH_F, action: 'gmail_search', data: { q: '회의' } }])
    mockExecuteGmailSearch.mockResolvedValueOnce({
      success: true,
      data: [
        { subject: null, from: 'a@x.com' },
        { subject: '회의 안내', from: 'boss@x.com' },
      ],
    })
    const r1 = await pm('concierge', GMAIL_SEARCH_F)
    expect(r1.text).toContain('찾은 메일이야:\n- (제목 없음) (a@x.com)\n- 회의 안내 (boss@x.com)')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_SEARCH_F, action: 'gmail_search', data: { q: '회의' } }])
    mockExecuteGmailSearch.mockResolvedValueOnce({ success: true, data: [] })
    const r2 = await pm('concierge', GMAIL_SEARCH_F)
    expect(r2.text).toContain('관련 메일이 없어.')
  })

  test('[GMAIL_GET] 실패 분기 + 성공 (본문·스니펫 폴백)', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_GET_F, action: 'gmail_get', data: { id: 'msg-1' } }])
    mockExecuteGmailGet.mockResolvedValueOnce({ success: false, error: 'not_connected' })
    expect((await pm('concierge', GMAIL_GET_F)).text).toContain('Google 연동이 안 되어 있어요')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_GET_F, action: 'gmail_get', data: { id: 'msg-1' } }])
    mockExecuteGmailGet.mockResolvedValueOnce({ success: false, error: 'revoked' })
    expect((await pm('concierge', GMAIL_GET_F)).text).toContain('Google 연동이 끊어졌어요')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_GET_F, action: 'gmail_get', data: { id: 'msg-1' } }])
    mockExecuteGmailGet.mockResolvedValueOnce({ success: false, error: 'boom' })
    expect((await pm('concierge', GMAIL_GET_F)).text).toContain('메일을 가져오지 못했어.')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_GET_F, action: 'gmail_get', data: { id: 'msg-1' } }])
    mockExecuteGmailGet.mockResolvedValueOnce({
      success: true, data: { subject: '주간 보고', from: 'boss@x.com', body: '본문 내용' },
    })
    const r4 = await pm('concierge', GMAIL_GET_F)
    expect(r4.text).toContain('메일 내용이야:\n제목: 주간 보고\n보낸 사람: boss@x.com\n본문 내용')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_GET_F, action: 'gmail_get', data: { id: 'msg-1' } }])
    mockExecuteGmailGet.mockResolvedValueOnce({
      success: true, data: { subject: '제목만', from: '', body: null, snippet: '스니펫 요약' },
    })
    const r5 = await pm('concierge', GMAIL_GET_F)
    expect(r5.text).toContain('스니펫 요약')
  })

  test('[GCAL_LIST] 구글/로컬 혼합 목록 + 비어있음', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_LIST_F, action: 'gcal_list', data: {} }])
    mockExecuteGcalList.mockResolvedValueOnce({
      success: true,
      data: [
        { start_at: '2026-10-17T10:00:00', source: 'google', title: '회의' },
        { start_at: null, source: 'local', title: '팀 점심' },
      ],
    })
    const r1 = await pm('concierge', GCAL_LIST_F)
    expect(r1.text).toContain('일정 목록이야:\n- 10-17 10:00 [구글] 회의\n-  팀 점심')

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_LIST_F, action: 'gcal_list', data: {} }])
    mockExecuteGcalList.mockResolvedValueOnce({ success: true, data: [] })
    const r2 = await pm('concierge', GCAL_LIST_F)
    expect(r2.text).toContain('등록된 일정이 없어.')
  })

  test('[GCAL_CREATE] 성공/실패 분기 (쓰기라 일회성 승인 필요)', async () => {
    const approved = { approvedScopeKeys: new Set(['GCAL_CREATE']) }
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_CREATE_F, action: 'gcal_create', data: { title: '회의' } }])
    mockExecuteGcalCreate.mockResolvedValueOnce({ success: true, data: { summary: '회의' } })
    const r1 = await pm('concierge', GCAL_CREATE_F, approved)
    expect(r1.text).toContain('구글 캘린더에 일정 등록했어: 회의')

    for (const [error, expected] of [
      ['not_connected', 'Google 연동이 안 되어 있어요'],
      ['revoked', 'Google 연동이 끊어졌어요'],
      ['scope_missing', '구글 캘린더 쓰기 권한이 없어요'],
      ['boom', '구글 캘린더 일정 등록에 실패했어.'],
    ] as const) {
      mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_CREATE_F, action: 'gcal_create', data: { title: '회의' } }])
      mockExecuteGcalCreate.mockResolvedValueOnce({ success: false, error })
      const r = await pm('concierge', GCAL_CREATE_F, approved)
      expect(r.text).toContain(expected)
    }
  })

  test('[GCAL_CREATE] 승인 없음 → 승인 요청 (실행 안 함)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_CREATE_F, action: 'gcal_create', data: { title: '회의' } }])
    const r = await pm('concierge', GCAL_CREATE_F, { conversationId: 7 }, db)
    expect(r.text).toContain('[승인이 필요해요]')
    expect(mockExecuteGcalCreate).not.toHaveBeenCalled()
  })

  test('builder는 Google 도구가 없어 실행기 수준에서 거부된다', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_SEARCH_F, action: 'gmail_search', data: { q: '회의' } }])
    const r = await pm('builder', GMAIL_SEARCH_F)
    expect(r.text).toContain('(이 비서는 GMAIL_SEARCH 도구를 사용할 권한이 없습니다)')
    expect(mockExecuteGmailSearch).not.toHaveBeenCalled()
  })

  test('builder는 CRON_LIST·GMAIL_GET·GCAL_LIST도 권한이 없어 거부된다 (609-611·731-733·745-747행)', async () => {
    mockParseCronListMarkers.mockReturnValueOnce([{ full: CRON_LIST_F }])
    const r1 = await pm('builder', CRON_LIST_F)
    expect(r1.text).toContain('(이 비서는 CRON_LIST 도구를 사용할 권한이 없습니다)')
    expect(mockExecuteCronList).not.toHaveBeenCalled()

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_GET_F, action: 'gmail_get', data: { id: 'msg-1' } }])
    const r2 = await pm('builder', GMAIL_GET_F)
    expect(r2.text).toContain('(이 비서는 GMAIL_GET 도구를 사용할 권한이 없습니다)')
    expect(mockExecuteGmailGet).not.toHaveBeenCalled()

    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_LIST_F, action: 'gcal_list', data: {} }])
    const r3 = await pm('builder', GCAL_LIST_F)
    expect(r3.text).toContain('(이 비서는 GCAL_LIST 도구를 사용할 권한이 없습니다)')
    expect(mockExecuteGcalList).not.toHaveBeenCalled()
  })
})

// ---------------- 스킬 힌트 주입 (1109-1110행) ----------------
describe('callSingleAssistant 스킬 힌트 주입', () => {
  const envOf = (db?: MockDb): any => ({ DB: db ?? new MockDb(), ENVIRONMENT: 'test' })

  test('keeper 기본 스킬(메모+자동화) 힌트가 시스템 프롬프트에 주입된다', async () => {
    await callSingleAssistant(envOf(), 'keeper', [{ role: 'user', content: 'hi' }])
    const system = mockAiChat.mock.calls[0][2][0].content as string
    expect(system).toContain('[활성 스킬: 메모, 자동화]')
    expect(system).toContain('메모 도구(memo_create/memo_search')
  })

  test('의도 매칭 스킬(메모) 힌트가 주입된다', async () => {
    await callSingleAssistant(envOf(), 'concierge', [{ role: 'user', content: '메모 찾아줘' }])
    const system = mockAiChat.mock.calls[0][2][0].content as string
    expect(system).toContain('[활성 스킬: 메모]')
  })

  test('기본 스킬이 없는 비서는 힌트 없이 진행한다 (1109행 false 분기)', async () => {
    await callSingleAssistant(envOf(), 'builder', [{ role: 'user', content: 'hi' }])
    const system = mockAiChat.mock.calls[0][2][0].content as string
    expect(system).not.toContain('[활성 스킬:')
  })
})

// ---------------- POST /chat 승인 응답 가로채기 (1522-1590행) ----------------
describe('POST /chat 승인 응답 가로채기', () => {
  const MEMO_F = '[MEMO_CREATE]{"text":"hello"}[/MEMO_CREATE]'
  const pendingRow = (over: any = {}) => ({
    id: 42,
    personaId: 'concierge',
    conversationId: 7,
    tool: 'MEMO_CREATE',
    scopeKey: 'MEMO_CREATE',
    markerText: MEMO_F,
    summary: '메모 생성 "hello"',
    userRequest: '메모 만들어줘',
    reversible: true,
    impact: '새 메모 1개가 만들어집니다. 필요 없으면 삭제할 수 있어요.',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    ...over,
  })

  test('"승인해" → 저장된 마커 재실행 + approval 응답', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ 1: 1 }) // 대화 존재
    db.firstQueue.push(pendingRow()) // 대기 요청
    mockParseMemoCreateMarkers.mockReturnValueOnce([{ full: MEMO_F, text: 'hello' }])
    db.batchQueue.push([{ meta: { last_row_id: 1 } }, { meta: { last_row_id: 2 } }]) // saveChatHistory
    const res = await json('/chat', 'POST', {
      personaId: 'concierge', conversationId: 7,
      messages: [{ role: 'user', content: '승인해' }],
    })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.provider).toBe('approval')
    expect(j.model).toBe('approval')
    expect(j.approvalResolved).toBe('approved')
    expect(j.text).toContain('메모를 생성했어 (id: 9).')
    expect(j.messageId).toBe(2)
    expect(mockAiChat).not.toHaveBeenCalled()
    expect(mockExecuteMemoCreate).toHaveBeenCalled()
    // 감사 기록(단건 승인 + 실행)이 남음
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO tool_approvals'))).toHaveLength(1)
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO tool_execution_audit'))).toHaveLength(1)
  })

  test('"거부해" → 실행하지 않고 거부 응답', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ 1: 1 })
    db.firstQueue.push(pendingRow())
    db.batchQueue.push([{ meta: { last_row_id: 1 } }, { meta: { last_row_id: 2 } }])
    const res = await json('/chat', 'POST', {
      personaId: 'concierge', conversationId: 7,
      messages: [{ role: 'user', content: '거부해' }],
    })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.approvalResolved).toBe('denied')
    expect(j.text).toContain('알겠어, 실행하지 않았어. (메모 생성 "hello")')
    expect(mockAiChat).not.toHaveBeenCalled()
    expect(mockExecuteMemoCreate).not.toHaveBeenCalled()
  })

  test('만료된 대기 요청 → 만료 응답 (재실행 안 함)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ 1: 1 })
    db.firstQueue.push(pendingRow({ expiresAt: new Date(Date.now() - 600000).toISOString() }))
    db.batchQueue.push([{ meta: { last_row_id: 1 } }, { meta: { last_row_id: 2 } }])
    const res = await json('/chat', 'POST', {
      personaId: 'concierge', conversationId: 7,
      messages: [{ role: 'user', content: '승인해' }],
    })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.approvalResolved).toBe('expired')
    expect(j.text).toContain('승인 요청이 만료됐어 (10분 지남). 다시 요청해주면 새로 확인할게. (메모 생성 "hello")')
    expect(mockAiChat).not.toHaveBeenCalled()
    expect(mockExecuteMemoCreate).not.toHaveBeenCalled()
    // 만료 마킹 UPDATE가 발행됨
    expect(db.calls.filter((c) => c.sql.includes("SET status = 'expired'"))).toHaveLength(1)
  })

  test('"이 세션 허용해" → 재실행 + 세션 허용 문구', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ 1: 1 })
    db.firstQueue.push(pendingRow())
    mockParseMemoCreateMarkers.mockReturnValueOnce([{ full: MEMO_F, text: 'hello' }])
    db.batchQueue.push([{ meta: { last_row_id: 1 } }, { meta: { last_row_id: 2 } }])
    const res = await json('/chat', 'POST', {
      personaId: 'concierge', conversationId: 7,
      messages: [{ role: 'user', content: '이 세션 허용해' }],
    })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.approvalResolved).toBe('approved_session')
    expect(j.text).toContain('이 세션 동안 같은 종류의 작업은 다시 묻지 않을게.')
    expect(j.text).toContain('메모를 생성했어 (id: 9).')
    expect(mockExecuteMemoCreate).toHaveBeenCalled()
    // 단건 승인 + 세션 허용 2건의 tool_approvals 기록
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO tool_approvals'))).toHaveLength(2)
  })

  test('승인 조회 중 DB 오류 → 경고 로그 후 일반 채팅으로 진행 (1590-1592행 catch)', async () => {
    const { json, db } = makeApp()
    db.firstQueue.push({ 1: 1 }) // 대화 존재
    db.firstQueue.push(new Error('db down')) // findNewestPending throw → 가로채기 실패
    const res = await json('/chat', 'POST', {
      personaId: 'concierge', conversationId: 7,
      messages: [{ role: 'user', content: '승인해' }],
    })
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.text).toBe('안녕') // 일반 채팅으로 진행됨
    expect(j.approvalResolved).toBeUndefined()
    expect(mockAiChat).toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      'approval reply handling failed, continuing to chat:', 'db down',
    )
  })
})

/**
 * 도달 불가로 판명한 코드 (소스 수정 없이 문서화만):
 * - routes.ts 268행 lock_forbidden 분기: authorizeTool의 모든 호출 지점이
 *   리터럴 도구명(MEMO, CRON, SCHEDULE, GMAIL, GCAL, TODO, ARTIFACT 계열)만
 *   전달하고, 그 중 'LOCK'을 포함하는 이름이 없어 decideToolExecution이
 *   lock_forbidden을 반환할 수 없다. 잠금 마커는 그 이전에
 *   enforceNoLockMarkers(policy-guard)가 치환하므로 파서에도 도달하지 않는다.
 *   향후 LOCK 도구가 추가되면 그때 커버 가능하다.
 */

// ---------------- 승인 요청 전달 (gate.request true 분기) ----------------
describe('승인 요청이 만들어지면 approvalRequests에 담긴다', () => {
  // 쓰기/파괴적 마커는 ask 흐름에서 pending을 만들고, 게이트는 request를
  // 함께 돌려준다. 마커별 루프의 `if (gate.request) approvalRequests.push(...)`
  // true 분기를 각 도구마다 검증한다 (MEMO_CREATE·CRON_*은 앞 describe에서 검증).
  const askDb = () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 허용 없음
    db.firstQueue.push(null) // 대기 요청 없음
    return db
  }

  test('[MEMO_UPDATE]/[MEMO_DELETE] 승인 요청', async () => {
    const F1 = '[MEMO_UPDATE]{"id":1,"text":"t"}[/MEMO_UPDATE]'
    mockParseMemoUpdateMarkers.mockReturnValueOnce([{ full: F1, id: 1, text: 't' }])
    const r1 = await pm('concierge', F1, { conversationId: 7 }, askDb())
    expect(r1.approvalRequests).toHaveLength(1)
    expect(r1.approvalRequests?.[0].tool).toBe('MEMO_UPDATE')
    expect(mockExecuteMemoUpdate).not.toHaveBeenCalled()

    const F2 = '[MEMO_DELETE]{"id":2}[/MEMO_DELETE]'
    mockParseMemoDeleteMarkers.mockReturnValueOnce([{ full: F2, id: 2 }])
    const r2 = await pm('concierge', F2, { conversationId: 7 }, askDb())
    expect(r2.approvalRequests).toHaveLength(1)
    expect(r2.approvalRequests?.[0].tool).toBe('MEMO_DELETE')
    expect(mockExecuteMemoDelete).not.toHaveBeenCalled()
  })

  test('[SCHEDULE_CREATE]/[SCHEDULE_UPDATE]/[SCHEDULE_DELETE] 승인 요청', async () => {
    const cases: Array<{ full: string; action: string; data: any; tool: string }> = [
      { full: '[SCHEDULE_CREATE]{"title":"회의"}[/SCHEDULE_CREATE]', action: 'create', data: { title: '회의' }, tool: 'SCHEDULE_CREATE' },
      { full: '[SCHEDULE_UPDATE]{"id":1}[/SCHEDULE_UPDATE]', action: 'update', data: { id: 1 }, tool: 'SCHEDULE_UPDATE' },
      { full: '[SCHEDULE_DELETE]{"id":5}[/SCHEDULE_DELETE]', action: 'delete', data: { id: 5 }, tool: 'SCHEDULE_DELETE' },
    ]
    for (const c of cases) {
      mockParseScheduleMarkers.mockReturnValueOnce([{ full: c.full, action: c.action, data: c.data }])
      const r = await pm('scheduler', c.full, { conversationId: 7 }, askDb())
      expect(r.approvalRequests).toHaveLength(1)
      expect(r.approvalRequests?.[0].tool).toBe(c.tool)
    }
    expect(mockExecuteScheduleCreate).not.toHaveBeenCalled()
    expect(mockExecuteScheduleUpdate).not.toHaveBeenCalled()
    expect(mockExecuteScheduleDelete).not.toHaveBeenCalled()
  })

  test('[TODO_ADD]/[TODO_DONE]/[TODO_UPDATE]/[TODO_DELETE] 승인 요청', async () => {
    const cases: Array<{ full: string; action: string; data: any; tool: string }> = [
      { full: '[TODO_ADD]{"title":"장보기"}[/TODO_ADD]', action: 'add', data: { title: '장보기' }, tool: 'TODO_ADD' },
      { full: '[TODO_DONE]{"id":1}[/TODO_DONE]', action: 'done', data: { id: 1 }, tool: 'TODO_DONE' },
      { full: '[TODO_UPDATE]{"id":1,"title":"청소"}[/TODO_UPDATE]', action: 'update', data: { id: 1, title: '청소' }, tool: 'TODO_UPDATE' },
      { full: '[TODO_DELETE]{"id":1}[/TODO_DELETE]', action: 'delete', data: { id: 1 }, tool: 'TODO_DELETE' },
    ]
    for (const c of cases) {
      mockParseTodoMarkers.mockReturnValueOnce([{ full: c.full, action: c.action, data: c.data }])
      const r = await pm('scheduler', c.full, { conversationId: 7 }, askDb())
      expect(r.approvalRequests).toHaveLength(1)
      expect(r.approvalRequests?.[0].tool).toBe(c.tool)
    }
    expect(mockExecuteTodoAdd).not.toHaveBeenCalled()
    expect(mockExecuteTodoDone).not.toHaveBeenCalled()
    expect(mockExecuteTodoUpdate).not.toHaveBeenCalled()
    expect(mockExecuteTodoDelete).not.toHaveBeenCalled()
  })

  test('[ARTIFACT_CREATE]/[ARTIFACT_DELETE]/[ARTIFACT_FROM_GITHUB] 승인 요청', async () => {
    const cases: Array<{ full: string; action: string; data: any; tool: string }> = [
      { full: '[ARTIFACT_CREATE]{"title":"앱"}[/ARTIFACT_CREATE]', action: 'create', data: { title: '앱' }, tool: 'ARTIFACT_CREATE' },
      { full: '[ARTIFACT_DELETE]{"id":4}[/ARTIFACT_DELETE]', action: 'delete', data: { id: 4 }, tool: 'ARTIFACT_DELETE' },
      { full: '[ARTIFACT_FROM_GITHUB]{"repo":"owner/repo"}[/ARTIFACT_FROM_GITHUB]', action: 'from_github', data: { repo: 'owner/repo' }, tool: 'ARTIFACT_FROM_GITHUB' },
    ]
    for (const c of cases) {
      mockParseArtifactMarkers.mockReturnValueOnce([{ full: c.full, action: c.action, data: c.data }])
      const r = await pm('builder', c.full, { conversationId: 7 }, askDb())
      expect(r.approvalRequests).toHaveLength(1)
      expect(r.approvalRequests?.[0].tool).toBe(c.tool)
    }
    expect(mockExecuteArtifactCreate).not.toHaveBeenCalled()
    expect(mockExecuteArtifactDelete).not.toHaveBeenCalled()
    expect(mockExecuteArtifactFromGithub).not.toHaveBeenCalled()
  })
})

// ---------------- 담당 범위 내 || 폴백 분기 ----------------
describe('CRON·Google 마커 빈 값 폴백', () => {
  test('[CRON_LIST] 설명 없는 자동화 → 빈 항목으로 표시 (615행)', async () => {
    mockParseCronListMarkers.mockReturnValueOnce([{ full: CRON_LIST_F }])
    mockExecuteCronList.mockResolvedValueOnce({ success: true, data: { jobs: [{ description: undefined }] } })
    const r = await pm('concierge', CRON_LIST_F)
    expect(r.text).toContain('자동화 목록이야:\n- ')
  })

  test('[CRON_TOGGLE] 설명 없는 결과 → 상태만 표시 (645행)', async () => {
    mockParseCronToggleMarkers.mockReturnValueOnce([{ full: CRON_TOGGLE_F, id: 3, enabled: true }])
    mockExecuteCronToggle.mockResolvedValueOnce({ success: true, data: { enabled: true } })
    const r = await pm('concierge', CRON_TOGGLE_F, { approvedScopeKeys: new Set(['CRON_TOGGLE:3']) })
    expect(r.text).toContain('자동화를 켰어:')
  })

  test('[GMAIL_SEARCH] 보낸 사람 없음 → 빈 괄호 (723행)', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_SEARCH_F, action: 'gmail_search', data: { q: '회의' } }])
    mockExecuteGmailSearch.mockResolvedValueOnce({ success: true, data: [{ subject: '제목', from: null }] })
    const r = await pm('concierge', GMAIL_SEARCH_F)
    expect(r.text).toContain('- 제목 ()')
  })

  test('[GMAIL_GET] 제목·본문·스니펫 전부 없음 → 빈 필드 (740행)', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GMAIL_GET_F, action: 'gmail_get', data: { id: 'msg-1' } }])
    mockExecuteGmailGet.mockResolvedValueOnce({
      success: true, data: { subject: null, from: null, body: null, snippet: null },
    })
    const r = await pm('concierge', GMAIL_GET_F)
    expect(r.text).toContain('메일 내용이야:\n제목: \n보낸 사람: \n')
  })

  test('[GCAL_LIST] 제목 없음 → 빈 제목 (754행)', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_LIST_F, action: 'gcal_list', data: {} }])
    mockExecuteGcalList.mockResolvedValueOnce({
      success: true,
      data: [{ start_at: '2026-10-17T10:00:00', source: 'google', title: null }],
    })
    const r = await pm('concierge', GCAL_LIST_F)
    expect(r.text).toContain('- 10-17 10:00 [구글] ')
  })

  test('[GCAL_CREATE] 요약 없음 → 빈 요약 (775행)', async () => {
    mockParseGoogleMarkers.mockReturnValueOnce([{ full: GCAL_CREATE_F, action: 'gcal_create', data: { title: '회의' } }])
    mockExecuteGcalCreate.mockResolvedValueOnce({ success: true, data: {} })
    const r = await pm('concierge', GCAL_CREATE_F, { approvedScopeKeys: new Set(['GCAL_CREATE']) })
    expect(r.text).toContain('구글 캘린더에 일정 등록했어: ')
  })
})

// ---------------- [SEARCH:] sources/text 일치 (2026-10-26 실측) ----------------
describe('processToolMarkers [SEARCH:] sources/text 일치', () => {
  test('2차 호출 sources가 남은 채 두 번째 [SEARCH:]가 텍스트를 갈아엎으면 sources도 따라간다', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    ;(global as any).fetch = jest.fn(async (url: string) => {
      if (String(url).includes('news.google.com')) {
        return { ok: true, text: async () => '<rss version="2.0"><channel></channel></rss>' }
      }
      if (String(url).includes('api.exa.ai')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              { title: '신선한 뉴스1', url: 'https://fresh.example.com/1', publishedDate: oneHourAgo },
              { title: '신선한 뉴스2', url: 'https://fresh.example.com/2', publishedDate: twoHoursAgo },
            ],
          }),
        }
      }
      // Exa 단계 기사 날짜 직접 검증용 fixture HTML (신선 — 2026-10-26 트랙 A2)
      if (String(url).includes('fresh.example.com')) {
        return {
          ok: true,
          text: async () =>
            `<html><head><meta property="article:published_time" content="${new Date().toISOString()}"></head></html>`,
        }
      }
      throw new Error('unexpected ' + url)
    })
    const db = new MockDb()
    // 2차 호출이 설정한 오래된 sources + 두 번째 [SEARCH:] 마커가 남은 텍스트
    // (2026-10-26 실측: 최종 텍스트는 신선한 연합뉴스 링크인데 sources[]는
    // 체인 1의 오래된 것이라 불일치했음)
    const staleSources = [
      { title: '오래된1', url: 'https://old.example.com/1' },
      { title: '오래된2', url: 'https://old.example.com/2' },
    ]
    const r = await processToolMarkers(
      { DB: db, EXA_API_KEY: 'ex' } as any,
      { text: '요약 [SEARCH: 오늘 한국 주요 뉴스]', sources: staleSources },
      'keeper',
      {},
    )
    expect(r.text).not.toContain('[SEARCH:')
    expect(r.text).toContain('https://fresh.example.com/1')
    expect(r.text).toContain('https://fresh.example.com/2')
    expect(r.text).not.toContain('https://old.example.com/1')
    expect(r.text).not.toContain('https://old.example.com/2')
    // sources는 최종 텍스트에 실제 표시된 링크와 일치해야 한다
    expect(r.sources).toEqual([
      { title: '신선한 뉴스1', url: 'https://fresh.example.com/1' },
      { title: '신선한 뉴스2', url: 'https://fresh.example.com/2' },
    ])
  })

  test('[SEARCH:] 치환이 없으면 기존 sources를 그대로 유지한다', async () => {
    const sources = [{ title: '기존', url: 'https://example.com/1' }]
    const r = await processToolMarkers(
      { DB: new MockDb() } as any,
      { text: '그냥 답변 https://example.com/1', sources },
      'keeper',
      {},
    )
    expect(r.sources).toEqual(sources)
  })
})
