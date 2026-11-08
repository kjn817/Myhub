/**
 * 사용자 시나리오 E2E 팩 (트랙 D, 2026-10-29) — API/런타임(miniflare) 수준.
 *
 * GPT 외부 평가가 요구한 사용자 시나리오를 실행 가능한 회귀 테스트로 고정한다.
 * 브라우저 클릭이 필요한 잔여 항목은 docs/e2e-browser-checklist-20261029.md 참조
 * (전부 NOT TESTED(브라우저)).
 *
 * 시나리오:
 * 1. 로그인(PIN) → 메모 작성 → 로그아웃 → 재로그인 → 내용 유지
 * 2. 메모 잠금 → AI 검색·단건(요약 컨텍스트가 거치는 ai-access 계층)·MCP에서
 *    제외 + 저장 형태 ENC: + 해제 시 무손실 왕복
 * 3. AI 일정 생성 도구 경로(processToolMarkers) → 승인 전 0건, 승인 재실행 시
 *    정확한 일정 1건, 동일 마커 재실행에도 중복 0건
 *    (한계: 실제 모델 호출은 범위 밖 — 모델이 낸 마커를 받은 뒤의 도구 실행
 *    계층까지가 테스트 범위다. 모델 호출 자체는 라이브 평가 영역.)
 * 4. 삭제 승인 거부 → DB 행 수·상태 전후 동일
 *    (한계: 외부 발송(EMAIL_SEND 등)은 채팅 마커 실행 경로가 아직 없어
 *    decideToolExecution 단위 테스트(tests/tool-approval*.test.ts)가 커버하고,
 *    여기서는 실행 경로가 실재하는 삭제 도구로 종단 거부 동작을 고정한다.)
 *
 * 기존 커버와 중복하지 않는 범위:
 * - 인증 미들웨어·세션 검증 자체 → auth-middleware.test.ts
 * - 잠금 암호화 단위 동작(키 없음·멱등 등) → memo-lock-encryption.test.ts
 * - MCP 프로토콜·잠금 제외(평문 잠금 시드) → mcp-server.test.ts
 * - 승인 게이트 단위·better-sqlite3 통합 → tests/tool-approval*.test.ts,
 *   tests/integration/approval-chat-real.test.js
 * 이 파일은 "실제 API로 잠근(ENC:) 메모가 세 표면 모두에서 안 보이는가"와
 * "로그인부터 재로그인까지 사용자 흐름이 이어지는가" 같은 종단 조합만 본다.
 *
 * 운영 DB·운영 배포 없음. D1은 파일마다 격리된 로컬 SQLite, PIN·메모는
 * 전부 가상 데이터이다. 전체 워커 경로는 ENVIRONMENT=test라 getAuthEmail이
 * fail-closed(null)이므로, PIN 흐름(시나리오 1)만 auth+memo 서브앱을
 * ENVIRONMENT=development + 가상 허용 이메일 env로 마운트해 실행한다
 * (인증 라우트 자체는 실제 코드·실제 D1·실제 PBKDF2이다).
 */
import { env, exports } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { authApp } from '../../src/modules/auth/routes'
import { memoApp } from '../../src/modules/memo/routes'
import { processToolMarkers } from '../../src/modules/ai/routes'
import { executeMemoGet, executeMemoSearch } from '../../src/services/memo-tools'
import { resolveApprovalReply } from '../../src/services/approval-flow'
import { approvalScopeKey } from '../../src/services/tool-approval'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as {
  DB: D1Database
  KV: KVNamespace
  SESSION_SECRET: string
  MEMO_ENCRYPTION_KEY: string
}
const worker = exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }

const EMAIL = 'e2e-scenario@myhub.local'
const PIN = '482916' // 가상 테스트 PIN (운영 PIN 아님)
const MEMO_TEXT_1 = 'E2E 시나리오 일기 — 재로그인 뒤에도 남아 있어야 하는 가상 메모'
const SECRET_TEXT = 'E2E비밀문구 제타세븐9981 절대 노출 금지 가상 본문'
const SECRET_QUERY = '제타세븐9981'

async function mintToken(
  method: 'otp' | 'pin',
  version = 0,
  email: string = EMAIL,
): Promise<string> {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000
  // OTP 토큰은 "방금 본인확인한 세션" — oa 클레임(트랙 2 set-pin 10분 창)을 현재로 싣는다.
  const payload = JSON.stringify({ email, exp, method, v: version, ...(method === 'otp' ? { oa: Date.now() } : {}) })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(testEnv.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return btoa(payload) + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)))
}

function cookieOf(res: Response): string {
  const set = res.headers.get('set-cookie') || ''
  const m = set.match(/myhub_session=([^;]+)/)
  if (!m) throw new Error('세션 쿠키가 발급되지 않았다')
  return `myhub_session=${m[1]}`
}

async function workerReq(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {}
  if (init.cookie) headers.Cookie = init.cookie
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await worker.default.fetch(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    }),
  )
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    /* 비 JSON 응답 */
  }
  return { status: res.status, body, text }
}

async function count(table: string): Promise<number> {
  const row = await testDb()
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>()
  return row?.n ?? -1
}

// ---------------------------------------------------------------------------
// 시나리오 1 — 서브앱 (auth + memo, development env로 getAuthEmail 활성화)
// ---------------------------------------------------------------------------
const devEnv = () => ({
  DB: testDb(),
  KV: testEnv.KV,
  SESSION_SECRET: testEnv.SESSION_SECRET,
  MEMO_ENCRYPTION_KEY: testEnv.MEMO_ENCRYPTION_KEY,
  CLOUDINARY_CLOUD_NAME: 'runtime-test',
  ENVIRONMENT: 'development',
  DEV_ALLOWED_EMAILS: EMAIL,
})
const subApp = new Hono()
subApp.route('/auth', authApp)
subApp.route('/memos', memoApp)

async function subReq(
  path: string,
  method: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; res: Response }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers.Cookie = opts.cookie
  const res = await subApp.request(
    path,
    {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    devEnv() as any,
  )
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* 본문 없음 */
  }
  return { status: res.status, body, res }
}

describe('E2E 시나리오 팩 (miniflare)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
  })

  describe('시나리오 1: PIN 로그인 → 메모 작성 → 재로그인 → 내용 유지', () => {
    let memoId = 0
    let firstPinCookie = ''

    it('1a. OTP 세션으로 PIN 설정 → /me에서 hasPin=true', async () => {
      const otpCookie = `myhub_session=${await mintToken('otp', 0)}`
      const set = await subReq('/auth/set-pin', 'POST', { cookie: otpCookie, body: { pin: PIN } })
      expect(set.status).toBe(200)
      expect(set.body.ok).toBe(true)
      // set-pin은 세션 버전을 올리고 새 PIN 세션을 발급한다
      firstPinCookie = cookieOf(set.res)
      const me = await subReq('/auth/me', 'GET', { cookie: firstPinCookie })
      expect(me.status).toBe(200)
      expect(me.body.email).toBe(EMAIL)
      expect(me.body.hasPin).toBe(true)
    })

    it('1b. PIN 로그인으로 새 세션 발급 → 메모 작성 → 단건 조회 내용 일치', async () => {
      const login = await subReq('/auth/pin-login', 'POST', { body: { pin: PIN } })
      expect(login.status).toBe(200)
      expect(login.body.ok).toBe(true)
      const cookie = cookieOf(login.res)

      const created = await subReq('/memos', 'POST', { cookie, body: { text: MEMO_TEXT_1 } })
      expect(created.status).toBe(200)
      memoId = created.body.id
      expect(memoId).toBeGreaterThan(0)

      const single = await subReq(`/memos/${memoId}`, 'GET', { cookie })
      expect(single.status).toBe(200)
      expect(single.body.memo.text).toBe(MEMO_TEXT_1)
    })

    it('1c. 로그아웃하면 구 세션은 무효, PIN 재로그인 뒤에도 메모가 그대로 조회된다', async () => {
      const out = await subReq('/auth/logout', 'POST', { cookie: firstPinCookie })
      expect(out.status).toBe(200)
      const meAfter = await subReq('/auth/me', 'GET', { cookie: firstPinCookie })
      expect(meAfter.status).toBe(401) // 버전 bump로 구 세션 무효화

      const relogin = await subReq('/auth/pin-login', 'POST', { body: { pin: PIN } })
      expect(relogin.status).toBe(200)
      const cookie = cookieOf(relogin.res)
      const single = await subReq(`/memos/${memoId}`, 'GET', { cookie })
      expect(single.status).toBe(200)
      expect(single.body.memo.text).toBe(MEMO_TEXT_1)
    })
  })

  describe('시나리오 2: 잠긴 메모가 AI·MCP 어디에도 안 보이고 무손실로 풀린다', () => {
    let memoId = 0
    let cookie = ''

    it('2a. 전체 워커로 메모 생성 + 잠금 → 원시 저장값은 ENC:, 소유자 조회는 복호화된다', async () => {
      // 시나리오 1이 같은 DB에서 세션 버전을 올렸으므로 별도 이메일을 쓴다
      cookie = `myhub_session=${await mintToken('pin', 0, 'e2e-lock@myhub.local')}`
      const created = await workerReq('/api/memo', {
        method: 'POST',
        cookie,
        body: { text: SECRET_TEXT },
      })
      expect(created.status).toBe(200)
      memoId = created.body.id

      const lock = await workerReq(`/api/memo/${memoId}/lock`, {
        method: 'POST',
        cookie,
        body: { locked: true },
      })
      expect(lock.status).toBe(200)

      const raw = await testDb()
        .prepare('SELECT text, is_locked FROM memos WHERE id = ?')
        .bind(memoId)
        .first<{ text: string; is_locked: number }>()
      expect(raw?.is_locked).toBe(1)
      expect(raw?.text.startsWith('ENC:')).toBe(true)
      expect(raw?.text).not.toContain('제타세븐9981')

      // 소유자 경로는 복호화된 원문을 본다 (AI 경계와 구분되는 지점)
      const owner = await workerReq(`/api/memo/${memoId}`, { cookie })
      expect(owner.status).toBe(200)
      expect(owner.body.memo.text).toBe(SECRET_TEXT)
    })

    it('2b. AI 메모 검색·단건(ai-access 계층) 결과에 평문이 없다', async () => {
      const envArg = { DB: testDb() }
      const search = await executeMemoSearch(envArg, SECRET_QUERY)
      expect(search.success).toBe(true)
      expect(search.data).toEqual([])
      expect(JSON.stringify(search)).not.toContain('제타세븐9981')

      const got = await executeMemoGet(envArg, memoId)
      expect(got.success).toBe(false) // 잠긴 메모는 존재 자체를 숨긴다
      expect(JSON.stringify(got)).not.toContain('제타세븐9981')
    })

    it('2c. MCP memo.search 응답 전문에 평문이 없다', async () => {
      // MCP는 모던 봉투에 Mcp-* 헤더가 필요하다 — workerReq에 헤더를 얹는다
      const res = await worker.default.fetch(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Cookie: cookie,
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': 'memo.search',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'memo.search',
              arguments: { query: SECRET_QUERY },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
      )
      const text = await res.text()
      expect(res.status).toBe(200)
      const body = JSON.parse(text)
      expect(body.result.structuredContent.matches).toEqual([])
      expect(text).not.toContain('제타세븐9981')
      expect(text).not.toContain('ENC:')
    })

    it('2d. 잠금 해제 → 원시 저장값이 원문과 정확히 일치한다 (무손실 왕복)', async () => {
      const unlock = await workerReq(`/api/memo/${memoId}/lock`, {
        method: 'POST',
        cookie,
        body: { locked: false },
      })
      expect(unlock.status).toBe(200)
      const raw = await testDb()
        .prepare('SELECT text, is_locked FROM memos WHERE id = ?')
        .bind(memoId)
        .first<{ text: string; is_locked: number }>()
      expect(raw?.is_locked).toBe(0)
      expect(raw?.text).toBe(SECRET_TEXT)
      // 해제 뒤에는 AI 검색에도 다시 잡힌다 (왕복이 실제로 풀렸다는 대조군)
      const search = await executeMemoSearch({ DB: testDb() }, SECRET_QUERY)
      expect(search.success).toBe(true)
      expect((search.data as any[]).map((r) => r.id)).toContain(memoId)
    })
  })

  describe('시나리오 3: AI 일정 생성 도구 경로 — 승인 후 정확히 1건', () => {
    const markerData = {
      title: 'E2E 가상 일정 치과 검진',
      start_at: '2026-11-05T15:00',
      end_at: '2026-11-05T16:00',
    }
    const markerText =
      `[SCHEDULE_CREATE]${JSON.stringify(markerData)}[/SCHEDULE_CREATE]`
    const CONV = 9101

    it('3a. 승인 없이 도구 경로를 실행하면 일정 0건 + 승인 대기 1건', async () => {
      const before = await count('schedules')
      const out = await processToolMarkers(
        { DB: testDb() },
        { text: `일정을 잡을게. ${markerText}` },
        'scheduler',
        { conversationId: CONV, userRequest: '치과 검진 일정 잡아줘' },
      )
      expect(await count('schedules')).toBe(before)
      expect(out.approvalRequests).toHaveLength(1)
      expect(out.approvalRequests[0].tool).toBe('SCHEDULE_CREATE')
      expect(out.text).not.toContain('일정 등록했어')
    })

    it('3b. 승인된 범위로 재실행하면 의도한 일정이 정확히 1건 생긴다', async () => {
      const before = await count('schedules')
      const out = await processToolMarkers(
        { DB: testDb() },
        { text: markerText },
        'scheduler',
        {
          conversationId: CONV,
          approvedScopeKeys: new Set([approvalScopeKey('SCHEDULE_CREATE', markerData)]),
        },
      )
      expect(out.text).toContain('일정 등록했어')
      expect(await count('schedules')).toBe(before + 1)
      const rows = await testDb()
        .prepare(
          `SELECT title, start_at, end_at, status FROM schedules WHERE title = ?`,
        )
        .bind(markerData.title)
        .all<{ title: string; start_at: string; end_at: string; status: string }>()
      expect(rows.results).toHaveLength(1)
      expect(rows.results[0]).toMatchObject({
        title: markerData.title,
        start_at: markerData.start_at,
        end_at: markerData.end_at,
        status: 'active',
      })
    })

    it('3c. 같은 마커를 승인으로 또 실행해도 중복 방지로 여전히 1건', async () => {
      const before = await count('schedules')
      const out = await processToolMarkers(
        { DB: testDb() },
        { text: markerText },
        'scheduler',
        {
          conversationId: CONV,
          approvedScopeKeys: new Set([approvalScopeKey('SCHEDULE_CREATE', markerData)]),
        },
      )
      expect(out.text).toContain('일정 등록에 실패했어')
      expect(await count('schedules')).toBe(before)
      const rows = await testDb()
        .prepare('SELECT COUNT(*) AS n FROM schedules WHERE title = ?')
        .bind(markerData.title)
        .first<{ n: number }>()
      expect(rows?.n).toBe(1)
    })
  })

  describe('시나리오 4: 삭제 승인 거부 → 변경 0건', () => {
    const CONV = 9102
    let targetId = 0
    let snapshot: Record<string, number> = {}

    it('4a. 승인 없이 삭제 마커를 실행하면 대기 요청만 생기고 대상·행 수가 그대로다', async () => {
      const ins = await testDb()
        .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, 0, 0)')
        .bind('E2E 삭제 거부 대상 가상 메모')
        .run()
      targetId = Number(ins.meta.last_row_id)
      snapshot = {
        memos: await count('memos'),
        schedules: await count('schedules'),
        todos: await count('todos'),
      }
      const out = await processToolMarkers(
        { DB: testDb() },
        { text: `[MEMO_DELETE]${JSON.stringify({ id: targetId })}[/MEMO_DELETE]` },
        'concierge',
        { conversationId: CONV, userRequest: '그 메모 지워줘' },
      )
      expect(out.approvalRequests).toHaveLength(1)
      expect(out.approvalRequests[0].tool).toBe('MEMO_DELETE')
      const still = await testDb()
        .prepare('SELECT id FROM memos WHERE id = ?')
        .bind(targetId)
        .first()
      expect(still).not.toBeNull()
      expect(await count('memos')).toBe(snapshot.memos)
    })

    it('4b. 사용자가 거부하면 요청은 denied로 닫히고 DB는 전후 동일하다', async () => {
      const res = await resolveApprovalReply(testDb(), {
        conversationId: CONV,
        personaId: 'concierge',
        reply: '거부해',
      })
      expect(res.status).toBe('denied')
      expect(res.request?.tool).toBe('MEMO_DELETE')

      const reqRow = await testDb()
        .prepare('SELECT status FROM tool_approval_requests WHERE id = ?')
        .bind(res.request!.id)
        .first<{ status: string }>()
      expect(reqRow?.status).toBe('denied')
      const audit = await testDb()
        .prepare(
          `SELECT decision FROM tool_approvals WHERE tool = 'MEMO_DELETE' ORDER BY id DESC LIMIT 1`,
        )
        .first<{ decision: string }>()
      expect(audit?.decision).toBe('denied')

      const still = await testDb()
        .prepare('SELECT text FROM memos WHERE id = ?')
        .bind(targetId)
        .first<{ text: string }>()
      expect(still?.text).toBe('E2E 삭제 거부 대상 가상 메모')
      expect(await count('memos')).toBe(snapshot.memos)
      expect(await count('schedules')).toBe(snapshot.schedules)
      expect(await count('todos')).toBe(snapshot.todos)
    })
  })
})
