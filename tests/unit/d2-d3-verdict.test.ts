/**
 * 6단계 D2/D3 판정 핀 테스트.
 *
 * D2: 삭제된 10개 백엔드 파일이 존재하지 않고, 유지 판정된 2개(eval-runner·
 * eval-cases)가 존재한다.
 * D3: 삭제된 라우트가 실제로 응답하지 않는다 (Hono 404). 단 /api/memo/stats는
 * memoApp의 GET /:id 핸들러에 걸려 400 INVALID_ID가 된다 — 통계 페이로드가
 * 아니라는 점이 판정이다.
 * 유지 라우트(GET /api/ai/tools, POST /api/cron/)가 살아있음을 함께 확인해
 * "앱 자체가 깨져서 전부 404"인 경우를 배제한다.
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { Hono } from 'hono'
import { aiAdminApp } from '../../src/modules/ai/admin-routes'
import { googleApp } from '../../src/modules/google/routes'
import { memoApp } from '../../src/modules/memo/routes'
import { cronApp } from '../../src/modules/cron/routes'
import { modules } from '../../src/modules'
import { normalizeSearchLimit } from '../../src/lib/search-limit'

const ROOT = path.join(__dirname, '..', '..')
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel))

// ---------------- D2: 삭제 파일 부재 · 유지 파일 존재 ----------------
describe('D2 삭제 파일 부재', () => {
  const deleted = [
    'src/services/clef-decisions.ts',
    'src/services/clef-studio.ts',
    'src/services/clef-tools.ts',
    'src/services/nova-subagents.ts',
    'src/services/legacy-adapter.ts',
    'src/services/tools-builtin.ts',
    'src/ai/fc-test.ts',
    'src/ai/retry-policy.ts',
    'src/ai/tools/test-todo-add.ts',
    'src/ai/prompts/index.ts',
    'src/modules/search/routes.ts',
  ]
  test.each(deleted)('%s가 존재하지 않는다', (f) => {
    expect(exists(f)).toBe(false)
  })
})

describe('D2 유지 파일 존재', () => {
  test.each([
    'src/ai/eval-runner.ts',
    'src/ai/prompts/eval-cases.ts',
  ])('%s가 존재한다 (테스트 하네스)', (f) => {
    expect(exists(f)).toBe(true)
  })

  test('eval-runner가 live 프롬프트 합성을 실행한다', async () => {
    // 유지 근거: 하네스가 live 코드(composeV2Prompt)를 구동한다.
    const { runMockEval } = await import('../../src/ai/eval-runner')
    const results = runMockEval()
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.checks.some((c) => c.name === 'prompt_composed')).toBe(true)
    }
  })
})

// ---------------- D3: 삭제 라우트 404 ----------------
async function req(app: Hono<any>, path: string, init?: RequestInit) {
  const res = await app.request(path, init, { DB: {} } as any)
  return res
}

describe('D3 삭제 라우트 — ai admin', () => {
  test.each([
    ['GET', '/history'],
    ['POST', '/memory'],
    ['GET', '/memory'],
    ['DELETE', '/memory/somekey'],
    ['GET', '/debug/errors'],
  ])('%s %s → 404', async (method, p) => {
    const res = await req(aiAdminApp, p, { method })
    expect(res.status).toBe(404)
  })
})

describe('D3 삭제 라우트 — google', () => {
  test.each([
    ['GET', '/gmail/search?q=test'],
    ['GET', '/gmail/m1'],
    ['GET', '/calendar/events'],
    ['POST', '/calendar/events'],
  ])('%s %s → 404', async (method, p) => {
    const res = await req(googleApp, p, { method })
    expect(res.status).toBe(404)
  })
})

describe('D3 삭제 라우트 — cron', () => {
  test.each([
    ['GET', '/health'],
    ['GET', '/'],
    ['PATCH', '/1'],
    ['DELETE', '/1'],
  ])('%s %s → 404', async (method, p) => {
    const res = await req(cronApp, p, { method })
    expect(res.status).toBe(404)
  })
})

describe('D3 삭제 라우트 — memo/stats', () => {
  test('GET /stats는 통계가 아니라 400 INVALID_ID (/:id 핸들러 경유)', async () => {
    const res = await req(memoApp, '/stats', { method: 'GET' })
    expect(res.status).toBe(400)
    const j = (await res.json()) as any
    expect(j.error).toBe('INVALID_ID')
    expect(j).not.toHaveProperty('memos')
    expect(j).not.toHaveProperty('week')
  })
})

describe('D3 삭제 라우트 — search 모듈', () => {
  test('모듈 레지스트리에 search가 없다', () => {
    expect(modules.map((m) => m.id)).not.toContain('search')
  })
})

// ---------------- 유지 라우트 양성 대조 ----------------
describe('유지 라우트 양성 대조', () => {
  test('GET /api/ai/tools는 살아있다', async () => {
    const res = await req(aiAdminApp, '/tools', { method: 'GET' })
    expect(res.status).toBe(200)
    const j = (await res.json()) as any
    expect(j.ok).toBe(true)
    expect(j.tools).toContain('search_memo')
  })

  test('POST /api/cron/은 살아있다 (빈 본문 → 400 invalid_nl_text)', async () => {
    const res = await req(cronApp, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_nl_text')
  })
})

// ---------------- search-routes.test.ts에서 이관: normalizeSearchLimit ----------------
// 함수는 src/lib/search-limit.ts에 살아있고 unified-search가 사용한다.
describe('normalizeSearchLimit (search-routes에서 이관)', () => {
  test('undefined → 20', () => expect(normalizeSearchLimit(undefined)).toBe(20))
  test('null → 20', () => expect(normalizeSearchLimit(null)).toBe(20))
  test('빈 문자열 → 20', () => expect(normalizeSearchLimit('')).toBe(20))
  test('공백만 → 20', () => expect(normalizeSearchLimit('   ')).toBe(20))
  test('숫자 아닌 문자열 → 20', () => expect(normalizeSearchLimit('abc')).toBe(20))
  test('소수 → 20', () => expect(normalizeSearchLimit('1.5')).toBe(20))
  test('0 → 20', () => expect(normalizeSearchLimit('0')).toBe(20))
  test('음수 → 20', () => expect(normalizeSearchLimit('-3')).toBe(20))
  test('유효값 통과', () => {
    expect(normalizeSearchLimit('50')).toBe(50)
    expect(normalizeSearchLimit(30)).toBe(30)
    expect(normalizeSearchLimit('1')).toBe(1)
    expect(normalizeSearchLimit('100')).toBe(100)
    expect(normalizeSearchLimit('  42  ')).toBe(42)
  })
  test('100 초과 → 100', () => {
    expect(normalizeSearchLimit('150')).toBe(100)
    expect(normalizeSearchLimit(1000)).toBe(100)
  })
})
