/**
 * 트랙 2 항목 1 — POST /settings 모델 status 검증 회귀 테스트 (2026-10-30)
 *
 * 성질: capabilityProvider 맵에 있는 키(model.chat/summarize/code/schedule)로
 * status가 'active'가 아닌 모델을 저장하려 하면 400으로 거부되고 DB에 쓰지 않는다.
 * 기존 동작(unknown model 400 · provider 불일치 400 · 빈 값 DELETE)은 유지된다.
 *
 * MODELS는 mock이 아닌 실제 레지스트리(src/services/ai)를 쓴다 — 실제 deprecated
 * 항목(gemini-3.5-flash 등)이 거부되는지가 이 테스트의 핵심이기 때문이다.
 * admin-routes의 주변 모듈(검색·트레이스)만 격리용으로 mock한다.
 */
/// <reference types="jest" />
import { Hono } from 'hono'

jest.mock('../../src/lib/news-summary', () => ({
  buildSearchFollowUpPrompt: jest.fn(),
  validateItemSources: jest.fn(),
  dedupeSources: jest.fn(),
  filterFreshSources: jest.fn(),
  isNewsQuery: jest.fn(() => false),
  resolveNewsIntent: jest.fn(),
  noFreshNewsText: jest.fn(),
  mergeSearchSources: jest.fn(),
}))

jest.mock('../../src/lib/trace', () => ({
  newRootTrace: jest.fn(),
  childSpan: jest.fn(),
  isValidTraceId: jest.fn(() => false),
}))

jest.mock('../../src/services/trace-viewer', () => ({
  listRecentTraces: jest.fn(async () => []),
  getTraceSpans: jest.fn(async () => []),
}))

jest.mock('../../src/modules/ai/web-search', () => ({
  externalWebSearch: jest.fn(async () => []),
}))

import { aiAdminApp } from '../../src/modules/ai/admin-routes'
import { MODELS } from '../../src/services/ai'

// ---------------- Mock D1 (ai-routes.test.ts와 동일 패턴) ----------------
class MockDb {
  calls: { sql: string; params: any[] }[] = []

  prepare(sql: string) {
    const db = this
    const exec = (params: any[]) => {
      db.calls.push({ sql, params })
      return {
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { last_row_id: 1, changes: 1 } }),
      }
    }
    return {
      bind: (...params: any[]) => exec(params),
      first: () => exec([]).first(),
      all: () => exec([]).all(),
      run: () => exec([]).run(),
    }
  }

  async batch() {
    return []
  }
}

function makeApp() {
  const db = new MockDb()
  const app = new Hono()
  app.route('/a', aiAdminApp)
  const env: any = { DB: db, ENVIRONMENT: 'test' }
  const json = (path: string, method: string, body?: any) =>
    app.request('/a' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
  return { db, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

function settingsWrites(db: MockDb) {
  return db.calls.filter((c) => c.sql.includes('INSERT INTO ai_settings'))
}

// 전제 고정: 테스트 데이터가 실제 레지스트리와 어긋나면 여기서 먼저 실패한다.
describe('전제: 실제 MODELS 레지스트리 상태', () => {
  test('거부 케이스에 쓰는 모델은 실제로 deprecated다', () => {
    for (const id of ['gemini-3.5-flash', 'gemini-3.8-flash', 'llama-3.3-70b-versatile']) {
      const entries = MODELS.filter((m) => m.id === id)
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.every((m) => m.status === 'deprecated')).toBe(true)
    }
  })

  test('정상 케이스에 쓰는 모델은 실제로 active다', () => {
    expect(MODELS.find((m) => m.id === 'gemini-3.5-flash-lite')?.status).toBe('active')
    expect(MODELS.find((m) => m.id === '@cf/qwen/qwen3-30b-a3b-fp8')?.status).toBe('active')
  })

  test('NVIDIA 모델은 전부 active가 아니다 (2026-11-05 판정: nemotron은 evaluation으로 부활, deprecated 아님)', () => {
    const nvidia = MODELS.filter((m) => m.provider === 'nvidia')
    expect(nvidia.length).toBeGreaterThan(0)
    expect(nvidia.every((m) => m.status !== 'active')).toBe(true)
    expect(MODELS.find((m) => m.id === 'nvidia/nemotron-3-ultra-550b-a55b')?.status).toBe('evaluation')
  })
})

describe('POST /settings: 비활성 모델 거부', () => {
  test('model.chat + deprecated gemini 모델 → 400, DB에 쓰지 않음', async () => {
    const { json, db } = makeApp()
    const res = await json('/settings', 'POST', { key: 'model.chat', value: 'gemini-3.5-flash' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('not active')
    expect(settingsWrites(db)).toHaveLength(0)
  })

  test('model.code + deprecated gemini 모델 → 400', async () => {
    const { json, db } = makeApp()
    const res = await json('/settings', 'POST', { key: 'model.code', value: 'gemini-3.8-flash' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('not active')
    expect(settingsWrites(db)).toHaveLength(0)
  })

  test('model.schedule + deprecated groq 모델 → 400 (provider는 일치해도 status로 거부)', async () => {
    const { json, db } = makeApp()
    const res = await json('/settings', 'POST', { key: 'model.schedule', value: 'llama-3.3-70b-versatile' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('not active')
    expect(settingsWrites(db)).toHaveLength(0)
  })
})

describe('POST /settings: 기존 동작 유지', () => {
  test('model.chat + active gemini 모델 → 200, 설정이 실제로 저장됨', async () => {
    const { json, db } = makeApp()
    const res = await json('/settings', 'POST', { key: 'model.chat', value: 'gemini-3.5-flash-lite' })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    const writes = settingsWrites(db)
    expect(writes).toHaveLength(1)
    expect(writes[0].params[0]).toBe('model.chat')
    expect(writes[0].params[1]).toBe('gemini-3.5-flash-lite')
  })

  test('model.summarize + active workers-ai 모델(qwen3-30b) → 200', async () => {
    const { json } = makeApp()
    const res = await json('/settings', 'POST', {
      key: 'model.summarize',
      value: '@cf/qwen/qwen3-30b-a3b-fp8',
    })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
  })

  test('model.summarize + nvidia 모델 → 400, DB에 쓰지 않음 (2026-10-30: NVIDIA 저장 차단)', async () => {
    const { json, db } = makeApp()
    const res = await json('/settings', 'POST', {
      key: 'model.summarize',
      value: 'nvidia/nemotron-3-ultra-550b-a55b',
    })
    expect(res.status).toBe(400)
    expect(settingsWrites(db)).toHaveLength(0)
  })

  test('unknown model → 400 (기존)', async () => {
    const { json } = makeApp()
    const res = await json('/settings', 'POST', { key: 'model.chat', value: 'no-such-model' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('unknown model')
  })

  test('provider 불일치 (active groq 모델을 model.chat에) → 400 (기존)', async () => {
    const { json } = makeApp()
    const res = await json('/settings', 'POST', { key: 'model.chat', value: 'openai/gpt-oss-120b' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('provider fixed to gemini')
  })

  test('빈 값 → DELETE 경로 유지 (status 검증 없이 삭제)', async () => {
    const { json, db } = makeApp()
    const res = await json('/settings', 'POST', { key: 'model.chat', value: '' })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    expect(db.calls.some((c) => c.sql.includes('DELETE FROM ai_settings'))).toBe(true)
    expect(settingsWrites(db)).toHaveLength(0)
  })
})
