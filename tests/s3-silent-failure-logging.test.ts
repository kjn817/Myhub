/// <reference types="jest" />
/**
 * 3단계 관측 개선 — 조용히 누락되던 실패 지점의 로깅 성질 테스트.
 *
 * 성질: 아래 실패가 일어나면 (1) 동작은 그대로 유지되고 (반환값·fail-closed
 * 방향·ack 모두 불변) (2) 안정적인 태그의 console.warn이 정확히 발생한다.
 * 로그에는 에러 종류·(D1/JSON.parse 한정) 메시지와 식별자만 남고, 사용자
 * 요청 내용·도구 인자·개인정보는 찍지 않는다.
 *
 * 대상: S2-1 processToolMarkers / S2-2 recordCronRun·recordCronJobRun /
 * S2-8 버전 정리·studio 도구 인자 파싱·rotation census / fc-approval-gate
 * 세션 확인·대기 요청 생성 (후자는 :199 원문 확인 중 같은 함수에서 찾은
 * 동일 패턴). routes-otp.ts의 OTP 정리 실패는 현상 유지 (TTL 10분 소멸,
 * 로그할 식별자가 이메일뿐이라 진단 가치 없음 — 보고서 참조).
 * 카나리아: 각 로그 라인을 지우면 해당 테스트가 실패해야 한다.
 */

jest.mock('../src/services/ai', () => ({
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
  ],
}))

jest.mock('../src/services/memory-service', () => {
  const actual = jest.requireActual('../src/services/memory-service')
  return {
    formatMemoryContext: jest.fn(),
    extractSearchTerms: actual.extractSearchTerms,
    isMemoryV2Enabled: jest.fn(),
  }
})

jest.mock('../src/services/fact-graph', () => ({
  getRelatedFacts: jest.fn(),
}))

jest.mock('../src/ai/prompt-integration', () => ({
  isPromptV2Enabled: jest.fn(),
  isPromptV2EnabledForPersona: jest.fn(),
  createRequestTimeContext: jest.fn(),
  composeV2Prompt: jest.fn(),
  resolvePromptVersion: (v2Applied: boolean) => (v2Applied ? 'persona-v1' : 'legacy'),
  LEGACY_PROMPT_VERSION: 'legacy',
}))

jest.mock('../src/ai/legacy-privacy-guard', () => {
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
  const LEGACY_MARKER_TOOLS: Record<string, string[]> = {
    concierge: ['MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'SCHEDULE_CREATE', 'TODO_ADD', 'SEARCH'],
    keeper: ['MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'MEMO_UPDATE', 'MEMO_DELETE', 'SEARCH'],
    builder: ['SEARCH', 'GITHUB', 'IMG', 'ARTIFACT_CREATE'],
    scheduler: ['SCHEDULE_CREATE', 'SCHEDULE_LIST', 'TODO_ADD', 'TODO_LIST', 'SEARCH'],
  }
  return {
    PrivacyBlockedError,
    getLegacyMarkerTools: (personaId: string) => LEGACY_MARKER_TOOLS[personaId] || LEGACY_MARKER_TOOLS.concierge,
    resolveRequestSensitivity: jest.fn(),
  }
})

jest.mock('../src/modules/ai/tool-markers', () => ({
  processToolMarkers: jest.fn(),
  registerAssistantCaller: jest.fn(),
}))

jest.mock('../src/modules/ai/memory-context-loader', () => ({
  loadLegacyMemoryContext: jest.fn(),
}))

import { callSingleAssistant } from '../src/modules/ai/assistant-call'
import { aiChat, buildSystemPrompt } from '../src/services/ai'
import { isMemoryV2Enabled } from '../src/services/memory-service'
import { getRelatedFacts } from '../src/services/fact-graph'
import { isPromptV2EnabledForPersona } from '../src/ai/prompt-integration'
import { resolveRequestSensitivity } from '../src/ai/legacy-privacy-guard'
import { processToolMarkers } from '../src/modules/ai/tool-markers'
import { loadLegacyMemoryContext } from '../src/modules/ai/memory-context-loader'
import { recordCronRun, recordCronJobRun, CRON_HEALTH_KEY } from '../src/services/cron-health'
import { saveJobResult } from '../src/modules/artifact/job-generation'
import { callWithTools } from '../src/services/studio-gemini-call'
import { computeRotationCensus } from '../src/services/key-rotation'
import { gateFCToolCall } from '../src/services/fc-approval-gate'
import { FakeD1 } from './fake-d1'

const mockAiChat = aiChat as jest.Mock
const mockBuildSystemPrompt = buildSystemPrompt as jest.Mock
const mockIsMemoryV2Enabled = isMemoryV2Enabled as jest.Mock
const mockGetRelatedFacts = getRelatedFacts as jest.Mock
const mockIsPromptV2EnabledForPersona = isPromptV2EnabledForPersona as jest.Mock
const mockResolveRequestSensitivity = resolveRequestSensitivity as jest.Mock
const mockProcessToolMarkers = processToolMarkers as jest.Mock
const mockLoadLegacyMemoryContext = loadLegacyMemoryContext as jest.Mock

let warnSpy: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

function warnedWith(tag: string) {
  return warnSpy.mock.calls.some((c) => c[0] === tag)
}

function warnedWithObject(tag: string, expected: Record<string, unknown>) {
  return warnSpy.mock.calls.some(
    (c) =>
      c[0] === tag &&
      typeof c[1] === 'object' &&
      c[1] !== null &&
      Object.entries(expected).every(([k, v]) => (c[1] as Record<string, unknown>)[k] === v),
  )
}

// ---------------------------------------------------------------------------
// S2-1 — processToolMarkers 실패 시 TOOL_MARKERS_FAILED 경고
// ---------------------------------------------------------------------------
describe('S2-1 — processToolMarkers 실패', () => {
  class SimpleDb {
    prepare() {
      return {
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: {} }),
        }),
      }
    }
  }

  function setupAssistant() {
    mockBuildSystemPrompt.mockReturnValue('system prompt')
    mockIsPromptV2EnabledForPersona.mockResolvedValue(false)
    mockResolveRequestSensitivity.mockReturnValue({ sensitivity: 'personal', reason: '' })
    // getLegacyMarkerTools는 목의 충실한 맵(concierge 목록)을 그대로 쓴다.
    mockGetRelatedFacts.mockResolvedValue([])
    mockIsMemoryV2Enabled.mockResolvedValue(false)
    mockLoadLegacyMemoryContext.mockResolvedValue('')
    mockAiChat.mockResolvedValue({ text: '안녕하세요', model: 'test-model', provider: 'test' })
  }

  test('마커 처리 실패해도 답변은 반환되고 경고가 남는다', async () => {
    setupAssistant()
    mockProcessToolMarkers.mockRejectedValue(new Error('marker boom'))
    const env: any = { DB: new SimpleDb(), ENVIRONMENT: 'test' }
    const result = await callSingleAssistant(env, 'concierge', [{ role: 'user', content: 'hi' }])
    expect(result.text).toBe('안녕하세요')
    expect(warnedWithObject('TOOL_MARKERS_FAILED', { personaId: 'concierge', errorType: 'Error' })).toBe(true)
  })

  test('마커 처리 성공 시 경고가 없다', async () => {
    setupAssistant()
    mockProcessToolMarkers.mockImplementation(async (_env: any, result: any) => result)
    const env: any = { DB: new SimpleDb(), ENVIRONMENT: 'test' }
    const result = await callSingleAssistant(env, 'concierge', [{ role: 'user', content: 'hi' }])
    expect(result.text).toBe('안녕하세요')
    expect(warnedWith('TOOL_MARKERS_FAILED')).toBe(false)
  })

  test('경고에는 도구 실행 결과가 포함되지 않는다 (종류만)', async () => {
    setupAssistant()
    // 도구 실행에서 사용자 내용이 담긴 메시지로 실패해도 로그에 새지 않는다.
    mockProcessToolMarkers.mockRejectedValue(new Error('메모 생성 실패: 비밀메모내용'))
    const env: any = { DB: new SimpleDb(), ENVIRONMENT: 'test' }
    await callSingleAssistant(env, 'concierge', [{ role: 'user', content: 'hi' }])
    const call = warnSpy.mock.calls.find((c) => c[0] === 'TOOL_MARKERS_FAILED')
    expect(call).toBeDefined()
    expect(JSON.stringify(call)).not.toContain('비밀메모내용')
    expect(JSON.stringify(call)).not.toContain('메모 생성 실패')
  })
})

// ---------------------------------------------------------------------------
// S2-2 — cron health 기록 실패 시 경고
// ---------------------------------------------------------------------------
describe('S2-2 — cron health 기록 실패', () => {
  class SettingsDb {
    store = new Map<string, string>()
    throwOnWrite = false
    prepare(sql: string) {
      const self = this
      return {
        bind: (...args: any[]) => ({
          first: async () => {
            if (sql.includes('FROM ai_settings')) {
              const v = self.store.get(args[0])
              return v === undefined ? null : { value: v }
            }
            return null
          },
          run: async () => {
            if (sql.includes('INSERT OR REPLACE INTO ai_settings')) {
              if (self.throwOnWrite) throw new Error('write fail')
              self.store.set(args[0], args[1])
            }
            return { success: true }
          },
        }),
      }
    }
    asD1() {
      return this as unknown as D1Database
    }
  }

  test('recordCronRun 쓰기 실패 시 경고가 남고 throw하지 않는다', async () => {
    const db = new SettingsDb()
    db.throwOnWrite = true
    await expect(
      recordCronRun({ DB: db.asD1() }, 'schedule-push', { status: 'ok', counts: { checked: 1, delivered: 1, failed: 0, skipped: 0 } }),
    ).resolves.toBeUndefined()
    expect(warnedWithObject('CRON_HEALTH_RECORD_FAILED', { handler: 'schedule-push', errorType: 'Error' })).toBe(true)
  })

  test('recordCronJobRun 쓰기 실패 시 경고가 남고 throw하지 않는다', async () => {
    const db = new SettingsDb()
    db.throwOnWrite = true
    await expect(
      recordCronJobRun({ DB: db.asD1() }, 42, { status: 'failed', detail: 'boom' }),
    ).resolves.toBeUndefined()
    expect(warnedWithObject('CRON_JOB_RUN_RECORD_FAILED', { jobId: 42, errorType: 'Error' })).toBe(true)
  })

  test('기록 성공 시 경고가 없다', async () => {
    const db = new SettingsDb()
    await recordCronRun({ DB: db.asD1() }, 'schedule-push', { status: 'ok' })
    await recordCronJobRun({ DB: db.asD1() }, 42, { status: 'ok' })
    expect(db.store.has(CRON_HEALTH_KEY)).toBe(true)
    expect(warnedWith('CRON_HEALTH_RECORD_FAILED')).toBe(false)
    expect(warnedWith('CRON_JOB_RUN_RECORD_FAILED')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S2-8 — 버전 정리 실패 시 경고 (동작은 그대로: 버전 생성 유지)
// ---------------------------------------------------------------------------
describe('S2-8 — artifact 버전 정리 실패', () => {
  type Handler = (sql: string, params: any[], method: 'first' | 'all' | 'run') => any
  function norm(sql: string) {
    return sql.replace(/\s+/g, ' ').trim()
  }
  function makeDb(handler: Handler) {
    return {
      prepare(sql: string) {
        return {
          bind(...params: any[]) {
            return {
              first: async () => handler(norm(sql), params, 'first'),
              all: async () => handler(norm(sql), params, 'all'),
              run: async () => handler(norm(sql), params, 'run'),
            }
          },
        }
      },
      batch: async () => [],
    }
  }
  const okRun = (changes = 1, lastRowId = 1) => ({ meta: { changes, last_row_id: lastRowId } })
  const HTML = '<!DOCTYPE html><html><body>hi</body></html>'

  function modDb(job: any, opts: any = {}) {
    return makeDb((sql, _p, m) => {
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
      if (sql.includes('artifact_versions WHERE artifact_id=? AND created_at > ?')) return null
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 1 }] }
      if (sql.includes('artifact_versions WHERE artifact_id=? AND content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 31)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.includes('SELECT published_version_id FROM artifacts')) return { published_version_id: 0 }
      if (sql.startsWith('DELETE FROM artifact_versions')) {
        if (opts.cleanupFail) throw new Error('del fail')
        return okRun(3)
      }
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET artifact_id')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
  }

  test('정리 실패해도 버전은 생성되고 경고가 남는다', async () => {
    const db = modDb({ id: 1, artifact_id: 7, lease_token: 't', created_at: null }, { cleanupFail: true })
    const r = await saveJobResult({ DB: db } as any, 1, HTML, 't', 'modify', 'p')
    expect(r.versionCreated).toBe(true)
    expect(r.artifactId).toBe(7)
    expect(warnedWithObject('ARTIFACT_VERSION_PRUNE_FAILED', { artifactId: 7, errorType: 'Error' })).toBe(true)
  })

  test('정리 성공 시 경고가 없다', async () => {
    const db = modDb({ id: 1, artifact_id: 7, lease_token: 't', created_at: null })
    const r = await saveJobResult({ DB: db } as any, 1, HTML, 't', 'modify', 'p')
    expect(r.versionCreated).toBe(true)
    expect(warnedWith('ARTIFACT_VERSION_PRUNE_FAILED')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S2-8 — studio 도구 인자 파싱 실패 시 경고 (해당 호출만 누락)
// ---------------------------------------------------------------------------
describe('S2-8 — studio 도구 인자 파싱 실패', () => {
  test('깨진 인자의 호출만 빠지고 경고에 도구명이 남는다', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'done',
                tool_calls: [
                  { type: 'function', id: 'call_1', function: { name: 'create_file', arguments: '{"path":"a.html","content":"x"}' } },
                  { type: 'function', id: 'call_2', function: { name: 'edit_file', arguments: '{invalid json' } },
                ],
              },
            },
          ],
        }),
    } as any)
    try {
      const r = await callWithTools({} as any, 'groq', 'llama-test', 'k', [{ role: 'user', content: 'hi' }])
      expect(r.toolCalls.map((tc: any) => tc.name)).toEqual(['create_file'])
      expect(warnedWithObject('STUDIO_TOOL_ARGS_PARSE_FAILED', { toolName: 'edit_file', errorType: 'SyntaxError' })).toBe(true)
      const call = warnSpy.mock.calls.find((c) => c[0] === 'STUDIO_TOOL_ARGS_PARSE_FAILED')
      expect(JSON.stringify(call)).not.toContain('{invalid json')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// S2-8 — rotation census 행 파싱 실패 시 경고 (집계는 계속)
// ---------------------------------------------------------------------------
describe('S2-8 — rotation census 행 파싱 실패', () => {
  function censusDb(memoRows: any[]) {
    // computeRotationCensus는 bind 없이 .all()/.first()를 직접 호출한다.
    return {
      prepare(sql: string) {
        const methods = {
          first: async () => {
            if (sql.includes('FROM files')) return { n: 0 }
            return null
          },
          all: async () => {
            if (sql.includes('FROM memos')) return { results: memoRows }
            if (sql.includes('FROM google_integrations')) return { results: [] }
            return { results: [] }
          },
          run: async () => ({ meta: {} }),
        }
        return { bind: () => methods, ...methods }
      },
    }
  }

  test('깨진 locked_blocks 행은 건너뛰고 경고가 남는다', async () => {
    const db = censusDb([
      { text: 'plain note', locked_blocks: '[]' },
      { text: 'plain note 2', locked_blocks: '{invalid json' },
    ])
    const census = await computeRotationCensus({ DB: db } as any)
    expect(census.memo_block).toBe(0)
    expect(warnedWithObject('ROTATION_CENSUS_ROW_SKIPPED', { errorType: 'SyntaxError' })).toBe(true)
    expect(warnSpy.mock.calls.filter((c) => c[0] === 'ROTATION_CENSUS_ROW_SKIPPED')).toHaveLength(1)
  })

  test('행이 전부 유효하면 경고가 없다', async () => {
    const db = censusDb([{ text: 'plain note', locked_blocks: '[]' }])
    await computeRotationCensus({ DB: db } as any)
    expect(warnedWith('ROTATION_CENSUS_ROW_SKIPPED')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// fc-approval-gate — 세션 확인·대기 요청 실패 시 경고 (fail-closed 유지)
// ---------------------------------------------------------------------------
describe('fc-approval-gate — 세션 확인·대기 요청 실패', () => {
  const NOW = new Date('2026-10-31T04:00:00Z')

  // FakeD1을 감싸 특정 SQL에서만 throw하는 선택적 장애 DB
  function selectiveDb(shouldThrow: (sql: string) => boolean) {
    const fake = new FakeD1()
    return {
      fake,
      prepare(sql: string) {
        if (!shouldThrow(sql)) return fake.prepare(sql)
        return {
          bind: () => ({
            first: async () => {
              throw new Error('db down')
            },
            all: async () => {
              throw new Error('db down')
            },
            run: async () => {
              throw new Error('db down')
            },
          }),
        }
      },
      batch: async (stmts: any[]) => {
        const results: any[] = []
        for (const s of stmts) results.push(await s.run())
        return results
      },
    }
  }

  function gateInput(db: any) {
    return {
      db: db as any,
      personaId: 'keeper',
      conversationId: 1,
      toolName: 'memo_create',
      args: { text: '승인 게이트 테스트 메모' },
      userRequest: '이 내용 메모로 만들어줘',
      origin: 'interactive' as const,
      now: NOW,
    }
  }

  test(':199 세션 확인 실패 시 ask로 진행하고 경고가 남는다 (allow가 아님)', async () => {
    const db = selectiveDb((sql) => sql.includes('FROM tool_approvals'))
    const outcome = await gateFCToolCall(gateInput(db))
    expect(outcome.action).toBe('ask')
    expect(warnedWithObject('FC_SESSION_CHECK_FAILED', {
      personaId: 'keeper',
      approvalTool: 'MEMO_CREATE',
      conversationId: 1,
      errorType: 'Error',
    })).toBe(true)
    // 대기 요청이 실제로 만들어져 ask 흐름이 끝까지 갔는지 확인
    expect(db.fake.tables.tool_approval_requests).toHaveLength(1)
  })

  test('세션 확인 성공 시 경고가 없고 ask로 간다', async () => {
    const db = selectiveDb(() => false)
    const outcome = await gateFCToolCall(gateInput(db))
    expect(outcome.action).toBe('ask')
    expect(warnedWith('FC_SESSION_CHECK_FAILED')).toBe(false)
    expect(warnedWith('FC_APPROVAL_REQUEST_FAILED')).toBe(false)
  })

  test(':241 대기 요청 생성 실패 시 blocked가 되고 경고가 남는다', async () => {
    const db = selectiveDb((sql) => sql.includes('tool_approval_requests'))
    const outcome = await gateFCToolCall(gateInput(db))
    expect(outcome.action).toBe('blocked')
    expect((outcome as any).error).toBe('approval_required')
    expect(warnedWithObject('FC_APPROVAL_REQUEST_FAILED', {
      personaId: 'keeper',
      approvalTool: 'MEMO_CREATE',
      conversationId: 1,
      errorType: 'Error',
    })).toBe(true)
    // 세션 확인은 성공했으므로 :199 경고는 없어야 한다
    expect(warnedWith('FC_SESSION_CHECK_FAILED')).toBe(false)
  })
})
