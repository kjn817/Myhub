/// <reference types="jest" />
/**
 * mcp/routes.ts 커버리지 보강 — Jest에서 미호출이던 영역
 * (런타임 테스트·Inspector CLI·라이브 검증으로 확인된 MCP 동작은 흉내내지 않고,
 * Jest에서만 검증 가능한 새로운 성질을 다룬다)
 * - authenticateMcpRequest: 세션 우선순위·Bearer 폴백·401 매핑 전 단계
 * - POST / 미인증: 401 / 속도제한 429 / 속도제한 인프라 장애 시에도 401 (best-effort)
 * - 에러 응답에 토큰 값 비노출
 * - 토큰 관리 3개 핸들러: 상한 400·무효 ID 400·not_found 404·DB 오류 500
 * - 인증된 POST / (SDK 핸들러 경유)는 여기서 다루지 않는다 — Inspector CLI·
 *   라이브 검증이 이미 커버하고, Jest에서 흉내만 내는 연극이 되기 때문이다.
 */
import { authenticateMcpRequest, mcpApp } from '../../src/modules/mcp/routes'
import {
  getAuthEmail,
  verifySessionForEnv,
  checkRateLimit,
  checkRateLimitForIp,
  getClientIp,
} from '../../src/modules/auth/routes'
import {
  issueMcpToken,
  verifyMcpToken,
  listMcpTokens,
  revokeMcpToken,
  MAX_ACTIVE_MCP_TOKENS,
} from '../../src/modules/mcp/tokens'

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

const mockedVerifySession = verifySessionForEnv as unknown as jest.Mock
const mockedVerifyToken = verifyMcpToken as unknown as jest.Mock
const mockedCheckIp = checkRateLimitForIp as unknown as jest.Mock
const mockedCheckGlobal = checkRateLimit as unknown as jest.Mock
const mockedIssue = issueMcpToken as unknown as jest.Mock
const mockedList = listMcpTokens as unknown as jest.Mock
const mockedRevoke = revokeMcpToken as unknown as jest.Mock

const ENV = { DB: {} } as any

function fakeCtx(headers: Record<string, string>) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    env: ENV,
  } as any
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(getAuthEmail as unknown as jest.Mock).mockReturnValue('user@example.com')
  ;(getClientIp as unknown as jest.Mock).mockReturnValue('1.2.3.4')
  mockedCheckIp.mockResolvedValue(false)
  mockedCheckGlobal.mockResolvedValue(false)
})

// ---------------- authenticateMcpRequest ----------------

describe('authenticateMcpRequest — 세션 vs Bearer', () => {
  test('유효한 세션 쿠키가 있으면 세션 방식으로 인증한다', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    const auth = await authenticateMcpRequest(
      fakeCtx({ Cookie: 'myhub_session=SESS123' }),
    )
    expect(auth).toEqual({ email: 'user@example.com', method: 'session', credential: 'SESS123' })
    expect(mockedVerifySession).toHaveBeenCalledWith(ENV, 'SESS123', 'user@example.com')
  })

  test('세션과 Bearer가 둘 다 유효하면 세션이 우선하고 토큰 검증은 호출되지 않는다', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedVerifyToken.mockResolvedValue({ id: 1, email: 'user@example.com', label: 't' })
    const auth = await authenticateMcpRequest(
      fakeCtx({ Cookie: 'myhub_session=SESS123', Authorization: 'Bearer mcp_abc' }),
    )
    expect(auth?.method).toBe('session')
    expect(mockedVerifyToken).not.toHaveBeenCalled()
  })

  test('세션이 무효하면 Bearer 토큰으로 폴백한다', async () => {
    mockedVerifySession.mockResolvedValue(null)
    mockedVerifyToken.mockResolvedValue({ id: 2, email: 'user@example.com', label: 't' })
    const auth = await authenticateMcpRequest(
      fakeCtx({ Cookie: 'myhub_session=BAD', Authorization: 'Bearer mcp_abc' }),
    )
    expect(auth).toEqual({ email: 'user@example.com', method: 'token', credential: 'mcp_abc' })
  })

  test('쿠키에 다른 값이 섞여 있어도 myhub_session만 추출한다', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    const auth = await authenticateMcpRequest(
      fakeCtx({ Cookie: 'other=1; myhub_session=SESS9; x=2' }),
    )
    expect(auth?.credential).toBe('SESS9')
  })

  test('Bearer 값의 앞뒤 공백을 제거해 검증한다', async () => {
    mockedVerifyToken.mockResolvedValue({ id: 2, email: 'user@example.com', label: 't' })
    const auth = await authenticateMcpRequest(
      fakeCtx({ Authorization: 'Bearer   mcp_abc   ' }),
    )
    expect(mockedVerifyToken).toHaveBeenCalledWith(ENV.DB, 'mcp_abc')
    expect(auth?.credential).toBe('mcp_abc')
  })

  test('자격 증명이 없거나 둘 다 무효하면 null (호출자가 401로 매핑)', async () => {
    mockedVerifySession.mockResolvedValue(null)
    mockedVerifyToken.mockResolvedValue(null)
    expect(
      await authenticateMcpRequest(fakeCtx({ Authorization: 'Bearer mcp_nope' })),
    ).toBeNull()
    expect(await authenticateMcpRequest(fakeCtx({}))).toBeNull()
  })
})

// ---------------- POST / 미인증 → 401/429 ----------------

describe('POST / — 미인증 요청의 401/429 매핑', () => {
  test('자격 증명 없음 → 401 인증 필요', async () => {
    const res = await mcpApp.request('http://localhost/', { method: 'POST', body: '{}' }, ENV)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: '인증 필요' })
  })

  test('IP 속도제한 초과 → 429', async () => {
    mockedCheckIp.mockResolvedValue(true)
    const res = await mcpApp.request('http://localhost/', { method: 'POST', body: '{}' }, ENV)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ ok: false, error: '너무 많은 요청. 1시간 후 다시 시도하세요.' })
  })

  test('전역 속도제한 초과 → 429', async () => {
    mockedCheckGlobal.mockResolvedValue(true)
    const res = await mcpApp.request('http://localhost/', { method: 'POST', body: '{}' }, ENV)
    expect(res.status).toBe(429)
  })

  test('속도제한 인프라가 던져도 401로 진행한다 (best-effort, 인증을 막지 않음)', async () => {
    mockedCheckIp.mockRejectedValue(new Error('rate_limits 테이블 없음'))
    const res = await mcpApp.request('http://localhost/', { method: 'POST', body: '{}' }, ENV)
    expect(res.status).toBe(401)
  })

  test('401 응답 본문에 제시한 Bearer 토큰 값이 노출되지 않는다', async () => {
    const res = await mcpApp.request(
      'http://localhost/',
      { method: 'POST', headers: { Authorization: 'Bearer mcp_SECRETXYZ123' }, body: '{}' },
      ENV,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('SECRETXYZ123')
  })
})

// ---------------- POST /tokens ----------------

describe('POST /tokens — 토큰 발급', () => {
  const postTokens = (body: unknown, cookie = 'myhub_session=SESS123') =>
    mcpApp.request(
      'http://localhost/tokens',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body),
      },
      ENV,
    )

  test('세션 없음 → 401', async () => {
    mockedVerifySession.mockResolvedValue(null)
    const res = await postTokens({ label: 'x' }, '')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: '로그인이 필요합니다.' })
    expect(mockedIssue).not.toHaveBeenCalled()
  })

  test('발급 성공 → 201, 평문 토큰은 이 응답에서만 나온다', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedIssue.mockResolvedValue({ id: 3, token: 'mcp_issued', label: '내 토큰', created_at: '2026-10-28T00:00:00.000Z' })
    const res = await postTokens({ label: '  내 토큰  ' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      ok: true, id: 3, token: 'mcp_issued', label: '내 토큰', created_at: '2026-10-28T00:00:00.000Z',
    })
    expect(mockedIssue).toHaveBeenCalledWith(ENV.DB, 'user@example.com', '내 토큰')
  })

  test('label이 100자를 넘으면 100자로 자른다', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedIssue.mockResolvedValue({ id: 3, token: 'mcp_x', label: 'a'.repeat(100), created_at: 't' })
    await postTokens({ label: 'a'.repeat(150) })
    expect(mockedIssue).toHaveBeenCalledWith(ENV.DB, 'user@example.com', 'a'.repeat(100))
  })

  test('상한 도달(issueMcpToken null) → 400, 상한 숫자가 메시지에 나온다', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedIssue.mockResolvedValue(null)
    const res = await postTokens({ label: 'x' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain(String(MAX_ACTIVE_MCP_TOKENS))
  })

  test('DB 오류 → 500, 토큰 값은 응답에 없다', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedIssue.mockRejectedValue(new Error('db down'))
    const res = await postTokens({ label: 'x' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: '토큰 발급 실패' })
  })
})

// ---------------- GET /tokens ----------------

describe('GET /tokens — 토큰 목록', () => {
  test('세션 없음 → 401', async () => {
    mockedVerifySession.mockResolvedValue(null)
    const res = await mcpApp.request('http://localhost/tokens', { headers: { Cookie: '' } }, ENV)
    expect(res.status).toBe(401)
  })

  test('목록 반환 → 200', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedList.mockResolvedValue([{ id: 1, label: 'a', created_at: 't', last_used_at: null, revoked_at: null }])
    const res = await mcpApp.request(
      'http://localhost/tokens',
      { headers: { Cookie: 'myhub_session=SESS123' } },
      ENV,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      tokens: [{ id: 1, label: 'a', created_at: 't', last_used_at: null, revoked_at: null }],
    })
    expect(mockedList).toHaveBeenCalledWith(ENV.DB, 'user@example.com')
  })

  test('DB 오류 → 500', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedList.mockRejectedValue(new Error('db down'))
    const res = await mcpApp.request(
      'http://localhost/tokens',
      { headers: { Cookie: 'myhub_session=SESS123' } },
      ENV,
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: '토큰 목록 조회 실패' })
  })
})

// ---------------- DELETE /tokens/:id ----------------

describe('DELETE /tokens/:id — 토큰 폐기', () => {
  const del = (id: string, cookie = 'myhub_session=SESS123') =>
    mcpApp.request(`http://localhost/tokens/${id}`, { method: 'DELETE', headers: { Cookie: cookie } }, ENV)

  test('세션 없음 → 401', async () => {
    mockedVerifySession.mockResolvedValue(null)
    const res = await del('1', '')
    expect(res.status).toBe(401)
  })

  test.each(['abc', '0', '-5', '1.5'])('무효한 ID(%s) → 400', async (id) => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    const res = await del(id)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: '유효하지 않은 ID' })
    expect(mockedRevoke).not.toHaveBeenCalled()
  })

  test('없는 토큰 → 404 not_found', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedRevoke.mockResolvedValue(false)
    const res = await del('99')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' })
    expect(mockedRevoke).toHaveBeenCalledWith(ENV.DB, 99, 'user@example.com')
  })

  test('폐기 성공 → 200', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedRevoke.mockResolvedValue(true)
    const res = await del('7')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('DB 오류 → 500', async () => {
    mockedVerifySession.mockResolvedValue({ email: 'user@example.com' })
    mockedRevoke.mockRejectedValue(new Error('db down'))
    const res = await del('7')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: '토큰 폐기 실패' })
  })
})
