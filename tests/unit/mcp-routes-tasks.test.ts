/// <reference types="jest" />
/**
 * src/modules/mcp/routes.ts — 인증 통과 후의 POST / 분기와 토큰 라벨 기본값.
 * (미인증 401/429와 토큰 관리의 기본 경로는 mcp-routes-cov.test.ts가
 * 다룬다. 여기는 그 스위트가 명시적으로 제외한 인증 후 영역만 본다.)
 *
 * 핵심 성질: ① well-formed한 tasks/* 요청은 SDK가 아니라 tasks
 * 디스패처가 답하고, 디스패처가 답을 만들지 못하면 SDK로 넘어간다
 * ② 본문이 JSON이 아니거나 method가 없으면 가로채지 않고 SDK의
 * 오류 처리에 맡긴다 ③ SDK가 던지면 500 일반 오류로 감싸고 자격
 * 증명은 응답에 남지 않는다 ④ 토큰 라벨은 문자열이 아니거나 비면
 * 'MCP 토큰'으로 대체된다.
 * 카나리아: 가로채기 조건(isWellFormedTasksRequest)을 무시하거나
 * SDK 폴백을 지우면 실패한다.
 */
import { authenticateMcpRequest, mcpApp } from '../../src/modules/mcp/routes'
import { getAuthEmail, verifySessionForEnv } from '../../src/modules/auth/routes'
import { issueMcpToken } from '../../src/modules/mcp/tokens'
import { handleTasksRequest, isWellFormedTasksRequest } from '../../src/modules/mcp/tasks'
import { buildMcpServer } from '../../src/modules/mcp/server'
import { createMcpHandler } from '@modelcontextprotocol/server'

jest.mock('../../src/modules/auth/routes', () => ({
  getAuthEmail: jest.fn(() => 'user@example.com'),
  verifySessionForEnv: jest.fn(),
  checkRateLimit: jest.fn(),
  checkRateLimitForIp: jest.fn(),
  getClientIp: jest.fn(() => '1.2.3.4'),
}))
jest.mock('../../src/modules/mcp/tokens', () => ({
  issueMcpToken: jest.fn(),
  verifyMcpToken: jest.fn(),
  listMcpTokens: jest.fn(),
  revokeMcpToken: jest.fn(),
  MAX_ACTIVE_MCP_TOKENS: 10,
}))
jest.mock('../../src/modules/mcp/tasks', () => ({
  handleTasksRequest: jest.fn(),
  isWellFormedTasksRequest: jest.fn(),
}))
jest.mock('../../src/modules/mcp/server', () => ({
  buildMcpServer: jest.fn(() => ({})),
}))
jest.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: jest.fn(),
}))

const mockedVerifySession = verifySessionForEnv as unknown as jest.Mock
const mockedIssue = issueMcpToken as unknown as jest.Mock
const mockedHandleTasks = handleTasksRequest as unknown as jest.Mock
const mockedWellFormed = isWellFormedTasksRequest as unknown as jest.Mock
const mockedCreateHandler = createMcpHandler as unknown as jest.Mock
const mockedBuildServer = buildMcpServer as unknown as jest.Mock
const sdkFetch = jest.fn()
let capturedFactory: ((ctx: { authInfo?: unknown }) => unknown) | null = null

const ENV = { DB: { __db: true } } as any
const COOKIE = { Cookie: 'myhub_session=SESS123' }

function postMcp(body: string) {
  return mcpApp.request(
    'http://localhost/',
    { method: 'POST', headers: { ...COOKIE, 'Content-Type': 'application/json' }, body },
    ENV,
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
  mockedWellFormed.mockReturnValue(false)
  mockedHandleTasks.mockResolvedValue(null)
  sdkFetch.mockResolvedValue(
    new Response(JSON.stringify({ sdk: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
  capturedFactory = null
  mockedCreateHandler.mockImplementation((factory: typeof capturedFactory) => {
    capturedFactory = factory
    return { fetch: sdkFetch }
  })
  mockedBuildServer.mockReturnValue({ __server: true })
})

describe('POST / — tasks 가로채기', () => {
  test('well-formed tasks/get은 디스패처가 답하고 SDK는 타지 않는다', async () => {
    mockedWellFormed.mockReturnValue(true)
    const payload = { jsonrpc: '2.0', id: 7, result: { task: { taskId: 't1', status: 'working' } } }
    mockedHandleTasks.mockResolvedValue(payload)
    const res = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tasks/get', params: { taskId: 't1' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toEqual(payload)
    expect(mockedHandleTasks).toHaveBeenCalledWith(ENV.DB, 'user@example.com', 'tasks/get', { taskId: 't1' }, 7)
    expect(sdkFetch).not.toHaveBeenCalled()
  })

  test('문자열 id도 그대로 디스패처에 전달된다', async () => {
    mockedWellFormed.mockReturnValue(true)
    mockedHandleTasks.mockResolvedValue({ jsonrpc: '2.0', id: 'req-9', result: {} })
    await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 'req-9', method: 'tasks/get', params: {} }))
    expect(mockedHandleTasks).toHaveBeenCalledWith(ENV.DB, 'user@example.com', 'tasks/get', {}, 'req-9')
  })

  test('id가 없으면 null로 전달된다', async () => {
    mockedWellFormed.mockReturnValue(true)
    mockedHandleTasks.mockResolvedValue({ jsonrpc: '2.0', result: {} })
    await postMcp(JSON.stringify({ jsonrpc: '2.0', method: 'tasks/get', params: {} }))
    expect(mockedHandleTasks).toHaveBeenCalledWith(ENV.DB, 'user@example.com', 'tasks/get', {}, null)
  })

  test('tasks 메서드여도 well-formed가 아니면 SDK로 넘어간다', async () => {
    mockedWellFormed.mockReturnValue(false)
    const res = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} }))
    expect(await res.json()).toEqual({ sdk: true })
    expect(mockedHandleTasks).not.toHaveBeenCalled()
  })

  test('디스패처가 답을 만들지 못하면(null) SDK로 넘어간다', async () => {
    mockedWellFormed.mockReturnValue(true)
    mockedHandleTasks.mockResolvedValue(null)
    const res = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: {} }))
    expect(await res.json()).toEqual({ sdk: true })
  })

  test('본문이 JSON이 아니면 가로채지 않고 SDK로 넘어간다', async () => {
    const res = await postMcp('this is not json')
    expect(await res.json()).toEqual({ sdk: true })
    expect(mockedWellFormed).not.toHaveBeenCalled()
  })

  test('method가 없는 JSON은 가로채지 않는다', async () => {
    const res = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1 }))
    expect(await res.json()).toEqual({ sdk: true })
    expect(mockedWellFormed).not.toHaveBeenCalled()
  })

  test.each(['null', '123', '"text"'])('JSON 스칼라 본문(%s)은 가로채지 않고 SDK로 넘긴다', async (raw) => {
    // null 본문에서 method를 읽으면 TypeError가 난다 — typeof 가드가
    // 가로채기를 건너뛰어 SDK 자신의 오류 처리에 맡기는 것이 계약이다.
    const res = await postMcp(raw)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sdk: true })
    expect(mockedWellFormed).not.toHaveBeenCalled()
  })

  test('일반 메서드(initialize 등)는 SDK 핸들러가 답한다', async () => {
    const res = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(await res.json()).toEqual({ sdk: true })
    expect(sdkFetch).toHaveBeenCalled()
  })
})

describe('POST / — SDK 서버 팩토리의 신원 결정', () => {
  test('authInfo.clientId가 있으면 그 신원으로 서버를 짓는다', async () => {
    await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(capturedFactory).not.toBeNull()
    const built = capturedFactory!({ authInfo: { token: 't', clientId: 'client-42', scopes: ['mcp:read'] } })
    expect(mockedBuildServer).toHaveBeenCalledWith(ENV, 'client-42')
    expect(built).toEqual({ __server: true })
  })

  test('clientId가 없으면 인증된 이메일로 폴백한다', async () => {
    await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    capturedFactory!({ authInfo: { token: 't', scopes: ['mcp:read'] } })
    expect(mockedBuildServer).toHaveBeenCalledWith(ENV, 'user@example.com')
    capturedFactory!({})
    expect(mockedBuildServer).toHaveBeenCalledWith(ENV, 'user@example.com')
  })
})

describe('POST / — SDK 실패', () => {
  test('SDK가 던지면 500 일반 오류, 세션 값은 응답에 남지 않는다', async () => {
    sdkFetch.mockRejectedValue(new Error('sdk boom SESS123'))
    const res = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'MCP 요청 처리 실패' })
    expect(text).not.toContain('SESS123')
  })
})

describe('authenticateMcpRequest — 허용 이메일 미설정', () => {
  test('getAuthEmail이 빈 값이면 허용 이메일을 undefined로 넘겨 세션 검증을 위임한다', async () => {
    ;(getAuthEmail as unknown as jest.Mock).mockReturnValueOnce('')
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    const auth = await authenticateMcpRequest({
      req: { header: (name: string) => (name === 'Cookie' ? 'myhub_session=SESS123' : undefined) },
      env: ENV,
    } as any)
    expect(auth?.method).toBe('session')
    expect(mockedVerifySession).toHaveBeenCalledWith(ENV, 'SESS123', undefined)
  })
})

describe('POST /tokens — 라벨 기본값', () => {
  const postTokens = (body: string) =>
    mcpApp.request(
      'http://localhost/tokens',
      { method: 'POST', headers: { ...COOKIE, 'Content-Type': 'application/json' }, body },
      ENV,
    )

  beforeEach(() => {
    mockedIssue.mockImplementation(async (_db: any, _email: string, label: string) => ({
      id: 1, token: 'mcp_x', label, created_at: 't',
    }))
  })

  test.each([
    ['라벨이 숫자', JSON.stringify({ label: 123 })],
    ['라벨 없음', JSON.stringify({})],
    ['라벨이 공백뿐', JSON.stringify({ label: '   ' })],
    ['본문이 JSON이 아님', '{{{'],
  ])('%s이면 기본 라벨 MCP 토큰으로 발급된다', async (_label, body) => {
    const res = await postTokens(body)
    expect(res.status).toBe(201)
    expect((await res.json()).label).toBe('MCP 토큰')
  })

  test('허용 이메일 미설정이어도 세션 검증 위임으로 발급이 진행된다 (requireSession)', async () => {
    ;(getAuthEmail as unknown as jest.Mock).mockReturnValueOnce('')
    const res = await postTokens(JSON.stringify({ label: 'x' }))
    expect(res.status).toBe(201)
    expect(mockedVerifySession).toHaveBeenCalledWith(ENV, 'SESS123', undefined)
  })
})
