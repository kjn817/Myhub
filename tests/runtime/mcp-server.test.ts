/**
 * MCP 서버 실런타임 테스트 (miniflare + 실제 D1 + 실제 SDK 핸들러).
 *
 * 트랙 1의 스크래치 테스트 10건을 정식 테스트로 옮기고 확장한 것이다.
 * Jest 테스트(tests/mcp-*.test.ts)가 executor·토큰 단위를 실제 SQLite로
 * 검증한다면, 이 파일은 HTTP 경계 전체를 검증한다:
 * - 모던(2026-07-28, _meta 봉투 + Mcp-* 헤더) / 레거시(2025-era, initialize)
 * - 인증 (PIN 세션 / Bearer MCP 토큰 / 미인증·오토큰·폐기 토큰 401)
 * - 토큰 관리 엔드포인트 (발급·목록·폐기·상한)
 * - 도구 5개 실데이터 호출 + 잠금 제외 (응답 전문 대조)
 * - SDK 자체 클라이언트(StreamableHTTPClientTransport) 왕복
 *
 * 운영 DB·운영 배포·OTP 라이브 호출 없음. D1은 파일마다 격리된 로컬 SQLite.
 */
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as { SESSION_SECRET: string }
const worker = exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }

const TEST_EMAIL = 'mcp-runtime@myhub.local'
const CAP_EMAIL = 'mcp-cap@myhub.local'

const MODERN_VERSION = '2026-07-28'
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
}

/** src/modules/auth/routes.ts createSession과 같은 형식의 세션 토큰을 만든다. */
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

/** SSE 본문에서 data: 행들을 JSON으로 파싱한다. */
function parseSse(text: string): any[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
}

let sessionCookie = ''
let mcpToken = ''

/** 모던(2026-07-28) 요청 — JSON-RPC + params._meta 봉투 + Mcp-* 헤더. */
async function modern(
  method: string,
  params: Record<string, unknown>,
  opts: {
    token?: string
    headers?: Record<string, string>
    headerVersion?: string
    metaVersion?: string
  } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.headers ?? {}),
  }
  if (!('MCP-Protocol-Version' in headers)) {
    headers['MCP-Protocol-Version'] = opts.headerVersion ?? MODERN_VERSION
  }
  if (!('Mcp-Method' in headers)) headers['Mcp-Method'] = method
  if (method === 'tools/call' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = String((params as any).name ?? '')
  }
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        ...MODERN_META,
        'io.modelcontextprotocol/protocolVersion': opts.metaVersion ?? MODERN_VERSION,
      },
    },
  }
  return fetchJson('/api/mcp', { method: 'POST', headers, body: JSON.stringify(body) })
}

/** 레거시(2025-era) JSON-RPC 요청 — Accept 헤더 필수. */
async function legacy(body: Record<string, unknown>, token?: string) {
  return fetchJson('/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('MCP 서버 (miniflare)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)

    const db = testDb()
    // 메모 시드 (트리거가 memos_fts + memos_fts_tri를 채운다)
    const memo = (text: string, locked: number, sens: number) =>
      db.prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)').bind(text, locked, sens).run()
    await memo('서울 여행 계획 메모', 0, 0) // 1
    await memo('김치찌개 레시피와 장보기 목록', 0, 0) // 2
    await memo('잠긴메모고유문구 알파베타감마', 1, 0) // 3 잠김
    await memo('민감메모고유문구 델타엡실론', 0, 2) // 4 민감도 2
    await memo('테니스 동호회 모임 안내', 0, 0) // 5

    const sched = (title: string, start: string, status: string) =>
      db
        .prepare('INSERT INTO schedules (title, description, location, start_at, end_at, status) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(title, '', '', start, null, status)
        .run()
    await sched('팀 회의', '2026-10-28T10:00', 'active') // 1
    await sched('치과 예약', '2026-10-29T14:00', 'active') // 2
    await sched('취소된 약속', '2026-10-28T15:00', 'cancelled') // 3
    await sched('지난주 회의', '2026-10-20T10:00', 'active') // 4 범위 밖

    const todo = (title: string, status: string) =>
      db
        .prepare('INSERT INTO todos (title, description, due_at, priority, status) VALUES (?, ?, ?, ?, ?)')
        .bind(title, '', null, 1, status)
        .run()
    await todo('우유 사기', 'pending') // 1
    await todo('보고서 제출', 'done') // 2
    await todo('운동하기', 'pending') // 3

    // 장기 기억 v2 + 동의 게이트
    await db
      .prepare("INSERT INTO ai_settings (key, value, updated_at) VALUES ('memory.v2_enabled', 'true', datetime('now'))")
      .run()
    await db
      .prepare(
        'INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('사용자는 테니스를 좋아한다', 'general', 1, 1, 1)
      .run() // 1 활성·동의
    await db
      .prepare(
        'INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active, superseded_by) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('사용자는 수영을 좋아한다', 'general', 1, 1, 0, 1)
      .run() // 2 대체됨 → 1
    await db
      .prepare(
        'INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('사용자는 테니스를 비밀리에 좋아한다', 'general', 0, 1, 1)
      .run() // 3 동의 없음

    // 세션 발급 → 토큰 발급 (실제 토큰 관리 엔드포인트 경유)
    sessionCookie = `myhub_session=${await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)}`
    const issued = await fetchJson('/api/mcp/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ label: '런타임 테스트' }),
    })
    expect(issued.status).toBe(201)
    expect(issued.body.token).toMatch(/^mcp_/)
    mcpToken = issued.body.token as string
  })

  // -------------------------------------------------------------------------
  describe('토큰 관리 (PIN 세션 전용)', () => {
    it('세션 없이 발급하면 401', async () => {
      const r = await fetchJson('/api/mcp/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'x' }),
      })
      expect(r.status).toBe(401)
    })

    it('목록에는 토큰 값·해시가 없고, 폐기 후 revoked_at이 찍힌다', async () => {
      const list1 = await fetchJson('/api/mcp/tokens', {
        headers: { Cookie: sessionCookie },
      })
      expect(list1.status).toBe(200)
      expect(list1.body.tokens).toHaveLength(1)
      expect(list1.body.tokens[0].label).toBe('런타임 테스트')
      expect(JSON.stringify(list1.body)).not.toContain(mcpToken)
      expect(JSON.stringify(list1.body)).not.toContain('token_hash')

      // 별도 토큰을 발급해 폐기한다 (메인 토큰은 뒤 테스트에서 계속 쓴다)
      const extra = await fetchJson('/api/mcp/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ label: '폐기 대상' }),
      })
      expect(extra.status).toBe(201)
      const del = await fetchJson(`/api/mcp/tokens/${extra.body.id}`, {
        method: 'DELETE',
        headers: { Cookie: sessionCookie },
      })
      expect(del.status).toBe(200)
      const delAgain = await fetchJson(`/api/mcp/tokens/${extra.body.id}`, {
        method: 'DELETE',
        headers: { Cookie: sessionCookie },
      })
      expect(delAgain.status).toBe(404)
      const list2 = await fetchJson('/api/mcp/tokens', { headers: { Cookie: sessionCookie } })
      const revoked = list2.body.tokens.find((t: any) => t.id === extra.body.id)
      expect(revoked.revoked_at).not.toBeNull()
      // 폐기된 토큰으로는 MCP 호출이 401이다
      const call = await modern('tools/list', {}, { token: extra.body.token })
      expect(call.status).toBe(401)
    })

    it('잘못된 id 폐기는 400, 없는 id 폐기는 404', async () => {
      const bad = await fetchJson('/api/mcp/tokens/abc', {
        method: 'DELETE',
        headers: { Cookie: sessionCookie },
      })
      expect(bad.status).toBe(400)
      const missing = await fetchJson('/api/mcp/tokens/999999', {
        method: 'DELETE',
        headers: { Cookie: sessionCookie },
      })
      expect(missing.status).toBe(404)
    })

    it('활성 토큰 상한 10개 — 11번째 발급은 400 (별도 이메일)', async () => {
      const capCookie = `myhub_session=${await mintSessionToken(CAP_EMAIL, testEnv.SESSION_SECRET)}`
      for (let i = 0; i < 10; i++) {
        const r = await fetchJson('/api/mcp/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: capCookie },
          body: JSON.stringify({ label: `cap-${i}` }),
        })
        expect(r.status).toBe(201)
      }
      const over = await fetchJson('/api/mcp/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: capCookie },
        body: JSON.stringify({ label: 'cap-over' }),
      })
      expect(over.status).toBe(400)
      expect(over.body.error).toContain('10개')
    })
  })

  // -------------------------------------------------------------------------
  describe('인증 거부 (POST /api/mcp)', () => {
    it('자격 증명 없음 → 401', async () => {
      const r = await modern('tools/list', {})
      expect(r.status).toBe(401)
      expect(r.body).toEqual({ ok: false, error: '인증 필요' })
    })

    it('존재하지 않는 Bearer 토큰 → 401', async () => {
      const r = await modern('tools/list', {}, { token: 'mcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
      expect(r.status).toBe(401)
    })

    it('mcp_ 접두사 없는 Bearer → 401', async () => {
      const r = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: 'Bearer not-a-mcp-token',
          'MCP-Protocol-Version': MODERN_VERSION,
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: MODERN_META },
        }),
      })
      expect(r.status).toBe(401)
    })

    it('유효한 PIN 세션 쿠키만으로도 200 (Bearer 없어도 된다)', async () => {
      const r = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: sessionCookie,
          'MCP-Protocol-Version': MODERN_VERSION,
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: MODERN_META },
        }),
      })
      expect(r.status).toBe(200)
      expect(r.body.result.tools).toHaveLength(5)
    })
  })

  // -------------------------------------------------------------------------
  describe('모던 프로토콜 (2026-07-28, initialize 없이 tools/list 직접 호출)', () => {
    it('tools/list: 도구 5개 + 스키마 + readOnlyHint, 쓰기 도구 없음', async () => {
      const r = await modern('tools/list', {}, { token: mcpToken })
      expect(r.status).toBe(200)
      const tools = r.body.result.tools
      expect(tools.map((t: any) => t.name).sort()).toEqual([
        'briefing.generate',
        'memo.search',
        'memory.search',
        'schedule.list',
        'todo.list',
      ])
      for (const t of tools) {
        expect(t.annotations).toEqual({ readOnlyHint: true })
        expect(t.inputSchema.type).toBe('object')
        expect(typeof t.description).toBe('string')
      }
      expect(tools.find((t: any) => t.name === 'memo.search').inputSchema.properties.query).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 120,
      })
      // SDK가 다는 기본 캐시 힌트: 구현이 ttlMs를 정하지 않아 0이다.
      // (docs/mcp-server-20261028.md §7-3 — 적정 TTL은 후속 결정 사항)
      expect(r.body.result.ttlMs).toBe(0)
      expect(r.body.result.cacheScope).toBe('private')
      expect(r.body.result.resultType).toBe('complete')
    })

    it('tools/call memo.search: 실데이터 반환 + content와 structuredContent 일치', async () => {
      const r = await modern(
        'tools/call',
        { name: 'memo.search', arguments: { query: '서울' } },
        { token: mcpToken },
      )
      expect(r.status).toBe(200)
      expect(r.body.result.structuredContent.matches.map((m: any) => m.id)).toEqual([1])
      expect(JSON.parse(r.body.result.content[0].text)).toEqual(r.body.result.structuredContent)
      expect(r.body.result.content[0].type).toBe('text')
    })

    it('tools/call memo.search: 잠긴 메모만 매칭되는 질의는 빈 결과', async () => {
      const r = await modern(
        'tools/call',
        { name: 'memo.search', arguments: { query: '잠긴메모고유문구' } },
        { token: mcpToken },
      )
      expect(r.status).toBe(200)
      expect(r.body.result.structuredContent.matches).toEqual([])
      expect(r.text).not.toContain('잠긴메모고유문구')
      expect(r.text).not.toContain('알파베타감마')
    })

    it('tools/call memo.search: 민감도 2 메모만 매칭되는 질의는 빈 결과', async () => {
      const r = await modern(
        'tools/call',
        { name: 'memo.search', arguments: { query: '민감메모고유문구' } },
        { token: mcpToken },
      )
      expect(r.body.result.structuredContent.matches).toEqual([])
      expect(r.text).not.toContain('민감메모고유문구')
      expect(r.text).not.toContain('델타엡실론')
    })

    it('tools/call memo.search: trigram 부분 검색이 동작한다', async () => {
      const r = await modern(
        'tools/call',
        { name: 'memo.search', arguments: { query: '여행계' } },
        { token: mcpToken },
      )
      expect(r.body.result.structuredContent.matches.map((m: any) => m.id)).toEqual([1])
    })

    it('tools/call schedule.list: 날짜 범위 + 상태 필터', async () => {
      const r = await modern(
        'tools/call',
        { name: 'schedule.list', arguments: { from: '2026-10-28', to: '2026-10-29' } },
        { token: mcpToken },
      )
      expect(r.body.result.structuredContent.schedules.map((s: any) => s.id).sort()).toEqual([1, 2, 3])
      const cancelled = await modern(
        'tools/call',
        { name: 'schedule.list', arguments: { from: '2026-10-28', to: '2026-10-29', status: 'cancelled' } },
        { token: mcpToken },
      )
      expect(cancelled.body.result.structuredContent.schedules.map((s: any) => s.id)).toEqual([3])
    })

    it('tools/call todo.list: pending/done/all', async () => {
      const pending = await modern(
        'tools/call',
        { name: 'todo.list', arguments: { status: 'pending' } },
        { token: mcpToken },
      )
      expect(pending.body.result.structuredContent.todos.map((x: any) => x.id).sort()).toEqual([1, 3])
      const all = await modern(
        'tools/call',
        { name: 'todo.list', arguments: { status: 'all' } },
        { token: mcpToken },
      )
      expect(all.body.result.structuredContent.todos.map((x: any) => x.id).sort()).toEqual([1, 2, 3])
    })

    it('tools/call memory.search: 동의 기억은 citable, 대체 기억은 인용 불가', async () => {
      const active = await modern(
        'tools/call',
        { name: 'memory.search', arguments: { query: '테니스를' } },
        { token: mcpToken },
      )
      const mems = active.body.result.structuredContent.memories
      const found = mems.find((m: any) => m.content.includes('테니스를 좋아한다'))
      expect(found).toBeDefined()
      expect(found.citable).toBe(true)
      expect(found.superseded).toBe(false)
      expect(JSON.stringify(mems)).not.toContain('비밀리에')

      const sup = await modern(
        'tools/call',
        { name: 'memory.search', arguments: { query: '수영을' } },
        { token: mcpToken },
      )
      const old = sup.body.result.structuredContent.memories.find((m: any) =>
        m.content.includes('수영을 좋아한다'),
      )
      expect(old).toBeDefined()
      expect(old.superseded).toBe(true)
      expect(old.citable).toBe(false)
      expect(old.superseded_by).toBe(1)
    })

    it('tools/call 미지 도구 → JSON-RPC 오류', async () => {
      const r = await modern(
        'tools/call',
        { name: 'memo.delete', arguments: {} },
        { token: mcpToken },
      )
      expect(r.status).toBe(200)
      expect(r.body.error).toBeDefined()
      expect(r.body.error.code).toBe(-32602)
    })

    it('tools/call 잘못된 인자 → 오류 (빈 query)', async () => {
      const r = await modern(
        'tools/call',
        { name: 'memo.search', arguments: { query: '' } },
        { token: mcpToken },
      )
      expect(r.status).toBe(200)
      // SDK가 Zod 검증 실패를 결과 오류로 돌려준다 (isError + JSON-RPC error 아님)
      expect(r.body.result.isError).toBe(true)
      expect(r.body.result.content[0].text).toMatch(/query/i)
    })

    it('MCP-Protocol-Version 헤더 누락 → 400 -32020', async () => {
      const r = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${mcpToken}`,
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: MODERN_META },
        }),
      })
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe(-32020)
    })

    it('Mcp-Method 헤더 누락 → 400 -32020', async () => {
      const r = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${mcpToken}`,
          'MCP-Protocol-Version': MODERN_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: MODERN_META },
        }),
      })
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe(-32020)
    })

    it('tools/call에서 Mcp-Name 누락·불일치 → 400 -32020', async () => {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memo.search', arguments: { query: '서울' }, _meta: MODERN_META },
      }
      const base = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${mcpToken}`,
        'MCP-Protocol-Version': MODERN_VERSION,
        'Mcp-Method': 'tools/call',
      }
      const missing = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: base,
        body: JSON.stringify(body),
      })
      expect(missing.status).toBe(400)
      expect(missing.body.error.code).toBe(-32020)
      const mismatch = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: { ...base, 'Mcp-Name': 'todo.list' },
        body: JSON.stringify(body),
      })
      expect(mismatch.status).toBe(400)
      expect(mismatch.body.error.code).toBe(-32020)
    })

    it('헤더·본문 버전 불일치 → 400 -32020', async () => {
      const r = await modern(
        'tools/list',
        {},
        { token: mcpToken, headerVersion: '2026-07-28', metaVersion: '2025-06-18' },
      )
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe(-32020)
      expect(r.body.error.message).toContain('disagree')
    })

    it('모던 경로가 모르는 버전 → 400 -32022 (지원 버전은 2026-07-28뿐)', async () => {
      const r = await modern(
        'tools/list',
        {},
        { token: mcpToken, headerVersion: '2025-06-18', metaVersion: '2025-06-18' },
      )
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe(-32022)
      expect(r.body.error.data.supported).toEqual(['2026-07-28'])
      // 구 버전은 레거시 initialize 핸드셰이크 경로로 와야 한다 (아래 레거시 절)
    })

    it('_meta 봉투 누락 → 400 -32602', async () => {
      const r = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${mcpToken}`,
          'MCP-Protocol-Version': MODERN_VERSION,
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe(-32602)
    })
  })

  // -------------------------------------------------------------------------
  describe('레거시 프로토콜 (2025-era, initialize 핸드셰이크)', () => {
    it('initialize → 200 SSE, 서버 정보 반환', async () => {
      const r = await legacy(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'runtime-test', version: '0.0.1' },
          },
        },
        mcpToken,
      )
      expect(r.status).toBe(200)
      const msgs = parseSse(r.text)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].result.protocolVersion).toBe('2025-06-18')
      expect(msgs[0].result.serverInfo).toEqual({ name: 'myhub', version: '0.1.0' })
      expect(msgs[0].result.capabilities.tools).toBeDefined()
    })

    it('initialize 없이 tools/list 직접 호출도 200 (stateless)', async () => {
      const r = await legacy({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, mcpToken)
      expect(r.status).toBe(200)
      const msgs = parseSse(r.text)
      expect(msgs[0].result.tools.map((t: any) => t.name).sort()).toEqual([
        'briefing.generate',
        'memo.search',
        'memory.search',
        'schedule.list',
        'todo.list',
      ])
    })

    it('레거시 tools/call memo.search → 실데이터', async () => {
      const r = await legacy(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'memo.search', arguments: { query: '서울' } },
        },
        mcpToken,
      )
      expect(r.status).toBe(200)
      const msgs = parseSse(r.text)
      expect(msgs[0].result.structuredContent.matches.map((m: any) => m.id)).toEqual([1])
    })

    it('Accept 헤더 없으면 406 (레거시 경로는 SSE 수신 동의를 요구)', async () => {
      const r = await fetchJson('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      })
      expect(r.status).toBe(406)
      expect(r.body.error.code).toBe(-32000)
    })
  })

  // -------------------------------------------------------------------------
  describe('SDK 클라이언트 왕복 (StreamableHTTPClientTransport)', () => {
    it('Client.connect → listTools → 4개 도구 callTool 왕복', async () => {
      const seenProtocolVersions: string[] = []
      const workerFetch = (async (input: any, init?: any) => {
        const req = input instanceof Request ? input : new Request(input, init)
        const v = req.headers.get('mcp-protocol-version')
        if (v) seenProtocolVersions.push(v)
        return worker.default.fetch(req)
      }) as typeof fetch

      const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
        fetch: workerFetch,
        requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
      })
      const client = new Client({ name: 'mcp-runtime-test', version: '0.0.1' }, { capabilities: {} })
      try {
        await client.connect(transport)
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name).sort()).toEqual([
          'briefing.generate',
          'memo.search',
          'memory.search',
          'schedule.list',
          'todo.list',
        ])
        for (const t of tools.tools) expect(t.annotations?.readOnlyHint).toBe(true)

        const memo = await client.callTool({ name: 'memo.search', arguments: { query: '서울' } })
        expect((memo.structuredContent as any).matches.map((m: any) => m.id)).toEqual([1])

        const sched = await client.callTool({
          name: 'schedule.list',
          arguments: { from: '2026-10-28', to: '2026-10-29' },
        })
        expect((sched.structuredContent as any).schedules.map((s: any) => s.id).sort()).toEqual([1, 2, 3])

        const todo = await client.callTool({ name: 'todo.list', arguments: { status: 'pending' } })
        expect((todo.structuredContent as any).todos.map((x: any) => x.id).sort()).toEqual([1, 3])

        const mem = await client.callTool({ name: 'memory.search', arguments: { query: '테니스를' } })
        const found = (mem.structuredContent as any).memories.find((m: any) =>
          m.content.includes('테니스를 좋아한다'),
        )
        expect(found).toBeDefined()
        expect(found.citable).toBe(true)
      } finally {
        await client.close()
      }

      // SDK 클라이언트 2.4.0이 실제로 협상한 프로토콜 버전 (기록용 단언):
      // 2.4.0의 LATEST는 2025-11-25라 모던(2026-07-28) 봉투가 아니라
      // 레거시 initialize 핸드셰이크를 쓴다. 서버가 둘 다 받는다는 증거이다.
      expect(seenProtocolVersions.length).toBeGreaterThan(0)
      expect(seenProtocolVersions[0]).toBe('2025-11-25')
    })
  })
})
