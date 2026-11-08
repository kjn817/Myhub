/**
 * MCP Tasks 확장 POC 실런타임 테스트 (miniflare + 실제 D1 + 실제 SDK 핸들러).
 *
 * Jest 테스트(tests/mcp-tasks.test.ts)가 스토어·디스패처·executor를
 * 실제 SQLite로 검증한다면, 이 파일은 HTTP 경계 전체를 검증한다:
 * - server/discover의 Tasks 확장 광고
 * - tools/call briefing.generate: 확장 선언 시 태스크 핸들, 미선언 시 동기 결과
 * - tasks/get 폴링 → 완료 결과 (지연 완료) + 잠금 제외 (응답 전문 대조)
 * - tasks/cancel·tasks/update·없는 태스크·만료 전제
 * - 가로채기 게이트: Mcp-Name 누락 시 SDK의 -32020을 그대로 받는다
 * - 공식 클라이언트 2.4.0: auto/pin은 모던 협상 + 태스크 핸들 소비 불가
 *   (UNSUPPORTED_RESULT_TYPE — 클라이언트 한계 핀), 기본값은 레거시 동기 결과
 *
 * 운영 DB·운영 배포·OTP 라이브 호출 없음. D1은 파일마다 격리된 로컬 SQLite.
 */
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

// 마이그레이션 전수 적용이 기본 hookTimeout(10초)을 넘길 수 있어 늘린다.
vi.setConfig({ hookTimeout: 60000 })

const testEnv = env as unknown as { SESSION_SECRET: string }
const worker = exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }

const TEST_EMAIL = 'mcp-tasks-runtime@myhub.local'
const OTHER_EMAIL = 'mcp-tasks-other@myhub.local'

const MODERN_VERSION = '2026-07-28'
const TASKS_EXT = 'io.modelcontextprotocol/tasks'

/** 오늘 날짜 (Asia/Seoul 기준) — 시드와 도구 인자에 같은 값을 쓴다. */
function todayKst(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year')?.value ?? ''
  const m = parts.find((p) => p.type === 'month')?.value ?? ''
  const d = parts.find((p) => p.type === 'day')?.value ?? ''
  return `${y}-${m}-${d}`
}

const TODAY = todayKst()
// '내일 회의' 시드용 — 하드코딩하면 그 날짜가 오늘이 되는 날 테스트가 깨진다 (2026-10-29 실증).
const TOMORROW = (() => {
  const d = new Date(`${TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
})()

async function mintSessionToken(email: string, secret: string): Promise<string> {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000
  const payload = JSON.stringify({ email, exp, method: 'pin', v: 0 })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

async function fetchJson(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await worker.default.fetch(new Request(`http://localhost${path}`, init))
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    // SSE 본문 등 JSON이 아닌 경우 text만 본다
  }
  return { status: res.status, body, text }
}

let sessionCookie = ''
let mcpToken = ''
let otherToken = ''

/** 모던(2026-07-28) 요청 — tasks 확장을 _meta clientCapabilities에 선언할 수 있다. */
async function modern(
  method: string,
  params: Record<string, unknown>,
  opts: { token?: string; declareTasks?: boolean; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': method,
    ...(opts.headers ?? {}),
  }
  if (method === 'tools/call' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = String((params as any).name ?? '')
  }
  if ((method === 'tasks/get' || method === 'tasks/update' || method === 'tasks/cancel') && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = String((params as any).taskId ?? '')
  }
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
        'io.modelcontextprotocol/clientCapabilities': opts.declareTasks
          ? { extensions: { [TASKS_EXT]: {} } }
          : {},
      },
    },
  }
  return fetchJson('/api/mcp', { method: 'POST', headers, body: JSON.stringify(body) })
}

/** briefing.generate를 태스크로 호출하고 핸들을 돌려준다. */
async function callBriefingAsTask(token: string) {
  const r = await modern(
    'tools/call',
    { name: 'briefing.generate', arguments: { date: TODAY } },
    { token, declareTasks: true },
  )
  expect(r.status).toBe(200)
  expect(r.body.result.resultType).toBe('task')
  expect(r.body.result.status).toBe('working')
  expect(typeof r.body.result.taskId).toBe('string')
  return r.body.result.taskId as string
}

describe('MCP Tasks 확장 POC (miniflare)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)

    const db = testDb()
    const memo = (text: string, locked: number, sens: number) =>
      db.prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)').bind(text, locked, sens).run()
    await memo('서울 여행 계획 메모', 0, 0) // 1
    await memo('잠긴브리핑고유문구 알파베타감마', 1, 0) // 2 잠김
    await memo('민감브리핑고유문구 델타엡실론', 0, 2) // 3 민감도 2

    await db
      .prepare('INSERT INTO schedules (title, description, location, start_at, end_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('팀 회의', '', '', `${TODAY}T10:00`, null, 'active')
      .run()
    await db
      .prepare('INSERT INTO schedules (title, description, location, start_at, end_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('내일 회의', '', '', `${TOMORROW}T10:00`, null, 'active')
      .run()

    await db
      .prepare('INSERT INTO todos (title, description, due_at, priority, status) VALUES (?, ?, ?, ?, ?)')
      .bind('우유 사기', '', null, 1, 'pending')
      .run()

    await db
      .prepare(
        'INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('사용자는 아침에 커피를 마신다', 'general', 1, 1, 1)
      .run()
    await db
      .prepare(
        'INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('사용자는 비밀리에 야식을 먹는다', 'general', 0, 1, 1)
      .run()

    sessionCookie = `myhub_session=${await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)}`
    const issued = await fetchJson('/api/mcp/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ label: '태스크 런타임 테스트' }),
    })
    expect(issued.status).toBe(201)
    mcpToken = issued.body.token as string

    const otherCookie = `myhub_session=${await mintSessionToken(OTHER_EMAIL, testEnv.SESSION_SECRET)}`
    const otherIssued = await fetchJson('/api/mcp/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: otherCookie },
      body: JSON.stringify({ label: '타인 토큰' }),
    })
    expect(otherIssued.status).toBe(201)
    otherToken = otherIssued.body.token as string
  })

  describe('server/discover + tools/list', () => {
    it('discover가 Tasks 확장을 광고하고 supportedVersions는 2026-07-28뿐이다', async () => {
      const r = await modern('server/discover', {}, { token: mcpToken })
      expect(r.status).toBe(200)
      expect(r.body.result.supportedVersions).toEqual(['2026-07-28'])
      expect(r.body.result.capabilities.extensions).toEqual({ [TASKS_EXT]: {} })
      expect(r.body.result.capabilities.tools).toBeDefined()
    })

    it('tools/list에 briefing.generate가 있고 execution.taskSupport는 없다 (2026 코덱 삭제 필드)', async () => {
      const r = await modern('tools/list', {}, { token: mcpToken })
      expect(r.status).toBe(200)
      const tool = r.body.result.tools.find((t: any) => t.name === 'briefing.generate')
      expect(tool).toBeDefined()
      expect(tool.annotations).toEqual({ readOnlyHint: true })
      expect(tool.execution).toBeUndefined()
      expect(JSON.stringify(r.body)).not.toContain('taskSupport')
    })
  })

  describe('tools/call briefing.generate', () => {
    it('확장 선언 시 태스크 핸들을 반환한다 (resultType task)', async () => {
      const r = await modern(
        'tools/call',
        { name: 'briefing.generate', arguments: { date: TODAY } },
        { token: mcpToken, declareTasks: true },
      )
      expect(r.status).toBe(200)
      expect(r.body.result.resultType).toBe('task')
      expect(r.body.result.status).toBe('working')
      expect(r.body.result.taskId).toMatch(/^task-/)
      expect(r.body.result.ttlMs).toBe(600000)
      expect(typeof r.body.result.pollIntervalMs).toBe('number')
      // 핸들에는 브리핑 내용이 없다 (폴링으로 가져간다)
      expect(JSON.stringify(r.body)).not.toContain('팀 회의')
    })

    it('확장 미선언 시 같은 브리핑을 동기 결과로 낸다', async () => {
      const r = await modern(
        'tools/call',
        { name: 'briefing.generate', arguments: { date: TODAY } },
        { token: mcpToken },
      )
      expect(r.status).toBe(200)
      expect(r.body.result.resultType).toBe('complete')
      expect(r.body.result.structuredContent.counts).toEqual({ schedules: 1, todos: 1, memos: 1, memories: 1 })
      expect(r.body.result.structuredContent.schedules[0].title).toBe('팀 회의')
      expect(r.text).not.toContain('잠긴브리핑고유문구')
      expect(r.text).not.toContain('비밀리에')
    })
  })

  describe('tasks/get·cancel·update', () => {
    it('폴링하면 완료 결과를 받는다 — 잠긴 메모·미동의 기억 없음', async () => {
      const taskId = await callBriefingAsTask(mcpToken)
      const r = await modern('tasks/get', { taskId }, { token: mcpToken })
      expect(r.status).toBe(200)
      expect(r.body.result.resultType).toBe('complete')
      expect(r.body.result.status).toBe('completed')
      expect(r.body.result.taskId).toBe(taskId)
      const callResult = r.body.result.result
      expect(callResult.structuredContent.counts).toEqual({ schedules: 1, todos: 1, memos: 1, memories: 1 })
      expect(callResult.structuredContent.schedules[0].title).toBe('팀 회의')
      expect(JSON.parse(callResult.content[0].text)).toEqual(callResult.structuredContent)
      expect(r.text).not.toContain('잠긴브리핑고유문구')
      expect(r.text).not.toContain('알파베타감마')
      expect(r.text).not.toContain('민감브리핑고유문구')
      expect(r.text).not.toContain('비밀리에')
      // 두 번째 폴링은 저장된 결과를 그대로 낸다
      const second = await modern('tasks/get', { taskId }, { token: mcpToken })
      expect(second.body.result.status).toBe('completed')
      expect(second.body.result.result).toEqual(callResult)
    })

    it('없는 태스크 조회는 -32602', async () => {
      const r = await modern('tasks/get', { taskId: 'task-nope' }, { token: mcpToken })
      expect(r.status).toBe(200)
      expect(r.body.error.code).toBe(-32602)
      expect(r.body.error.message).toBe('task not found')
    })

    it('남의 태스크는 조회·취소할 수 없다', async () => {
      const taskId = await callBriefingAsTask(mcpToken)
      const get = await modern('tasks/get', { taskId }, { token: otherToken })
      expect(get.body.error.code).toBe(-32602)
      const cancel = await modern('tasks/cancel', { taskId }, { token: otherToken })
      expect(cancel.body.error.code).toBe(-32602)
      // 본인 조회는 여전히 된다
      const mine = await modern('tasks/get', { taskId }, { token: mcpToken })
      expect(mine.body.result.status).toBe('completed')
    })

    it('취소한 태스크는 cancelled로 남는다', async () => {
      const taskId = await callBriefingAsTask(mcpToken)
      const cancel = await modern('tasks/cancel', { taskId }, { token: mcpToken })
      expect(cancel.status).toBe(200)
      expect(cancel.body.result.resultType).toBe('complete')
      const after = await modern('tasks/get', { taskId }, { token: mcpToken })
      expect(after.body.result.status).toBe('cancelled')
      expect(after.body.result.result).toBeUndefined()
    })

    it('tasks/update는 -32602 (input_required 없음)', async () => {
      const taskId = await callBriefingAsTask(mcpToken)
      const r = await modern('tasks/update', { taskId, inputResponses: {} }, { token: mcpToken })
      expect(r.status).toBe(200)
      expect(r.body.error.code).toBe(-32602)
      expect(r.body.error.message).toBe('task is not awaiting input')
    })

    it('Mcp-Name 누락 시 SDK의 -32020을 그대로 받는다 (게이트 폴백)', async () => {
      const taskId = await callBriefingAsTask(mcpToken)
      const r = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${mcpToken}`,
          'MCP-Protocol-Version': MODERN_VERSION,
          'Mcp-Method': 'tasks/get',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: {
            taskId,
            // 봉투는 완전하게 (protocolVersion + clientCapabilities) — 그래야
            // SDK가 봉투 검증을 통과하고 헤더 단계(-32020)까지 간다.
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe(-32020)
    })

    it('미인증 tasks/get은 401 (가로채기 전 인증 게이트)', async () => {
      const r = await modern('tasks/get', { taskId: 'task-nope' })
      expect(r.status).toBe(401)
    })
  })

  describe('브리핑 HTTP 라우트 (리팩터 회귀)', () => {
    it('GET /api/briefing/today가 MCP 동기 결과와 같은 브리핑을 낸다', async () => {
      const http = await fetchJson('/api/briefing/today', { headers: { Cookie: sessionCookie } })
      expect(http.status).toBe(200)
      expect(http.body.ok).toBe(true)
      expect(http.body.counts).toEqual({ schedules: 1, todos: 1, memos: 1, memories: 1 })
      expect(http.body.schedules[0].title).toBe('팀 회의')
      expect(http.text).not.toContain('잠긴브리핑고유문구')
      expect(http.text).not.toContain('비밀리에')

      const mcp = await modern(
        'tools/call',
        { name: 'briefing.generate', arguments: { date: TODAY } },
        { token: mcpToken },
      )
      expect(mcp.body.result.structuredContent.counts).toEqual(http.body.counts)
      expect(mcp.body.result.structuredContent.schedules).toEqual(http.body.schedules)
      expect(mcp.body.result.structuredContent.todos).toEqual(http.body.todos)
      expect(mcp.body.result.structuredContent.memos).toEqual(http.body.memos)
      expect(mcp.body.result.structuredContent.memories).toEqual(http.body.memories)
    })
  })

  describe('공식 클라이언트 2.4.0', () => {
    function workerFetch(input: any, init?: any) {
      const req = input instanceof Request ? input : new Request(input, init)
      return worker.default.fetch(req)
    }

    it('auto 협상 → 모던 2026-07-28, 태스크 핸들은 소비 불가 (UNSUPPORTED_RESULT_TYPE)', async () => {
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
        fetch: workerFetch as typeof fetch,
        requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
      })
      const client = new Client(
        { name: 'mcp-tasks-runtime-test', version: '0.0.1' },
        {
          capabilities: { extensions: { [TASKS_EXT]: {} } },
          versionNegotiation: { mode: 'auto' },
        },
      )
      try {
        await client.connect(transport)
        expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
        expect(client.getServerCapabilities()?.extensions).toEqual({ [TASKS_EXT]: {} })
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).toContain('briefing.generate')
        // 일반 도구는 그대로 동작한다
        const memo = await client.callTool({ name: 'memo.search', arguments: { query: '서울' } })
        expect((memo.structuredContent as any).matches.map((m: any) => m.id)).toEqual([1])
        // 태스크 핸들은 클라이언트가 소비하지 못한다 — 공식 클라이언트 2.4.0의 한계
        await expect(
          client.callTool({ name: 'briefing.generate', arguments: { date: TODAY } }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_RESULT_TYPE' })
      } finally {
        await client.close()
      }
    })

    it('기본값(레거시) 협상 → briefing.generate는 동기 결과로 온다', async () => {
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
        fetch: workerFetch as typeof fetch,
        requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
      })
      const client = new Client({ name: 'mcp-tasks-runtime-test', version: '0.0.1' }, { capabilities: {} })
      try {
        await client.connect(transport)
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25')
        const res = await client.callTool({ name: 'briefing.generate', arguments: { date: TODAY } })
        expect((res.structuredContent as any).counts).toEqual({ schedules: 1, todos: 1, memos: 1, memories: 1 })
      } finally {
        await client.close()
      }
    })
  })
})
