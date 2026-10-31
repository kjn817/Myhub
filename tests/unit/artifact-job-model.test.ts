/**
 * 트랙 2 항목 2 — POST /jobs model 검증 회귀 테스트 (2026-10-30, 관문 82)
 *
 * 성질: model이 제공되면 실제 MODELS 레지스트리의 active 모델이어야 하고,
 * provider가 함께 제공되면 그 모델의 provider와 일치해야 한다. 위반 시
 * 잡을 만들지 않고(INSERT 없음·큐 전송 없음) 400을 반환한다.
 * model 미제공 경로는 기존과 동일하게 통과한다.
 *
 * MODELS는 mock이 아닌 실제 레지스트리를 쓴다 (routes.ts가 실제로 import하는 값).
 * UI 정상 경로 테스트는 public/agent.html의 modelTag <option> 값을 실제 파일에서
 * 추출하고, callAiJob의 provider 추론 규칙을 그대로 적용해 전수 검증한다 —
 * UI가 deprecated/미등록 모델을 보내기 시작하면 이 테스트가 실패한다.
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import { artifactApp } from '../../src/modules/artifact/routes'
import { MODELS } from '../../src/services/ai'

// ---------------- Mock D1 (artifact-routes.test.ts와 동일 패턴) ----------------
class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
  batchQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []
  batchCalls: any[][] = []

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
    this.batchCalls.push(stmts)
    const v = this.batchQueue.shift()
    if (v === undefined) return []
    if (v instanceof Error) throw v
    return v
  }
}

function makeQueue() {
  const sent: any[] = []
  return {
    sent,
    send: async (msg: any) => {
      sent.push(msg)
    },
  }
}

function makeApp() {
  const db = new MockDb()
  const queue = makeQueue()
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('userEmail', 'test@example.com')
    await next()
  })
  app.route('/a', artifactApp)
  const env: any = { DB: db, ARTIFACT_QUEUE: queue }
  const json = (p: string, method: string, body?: any) =>
    app.request('/a' + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
  return { db, queue, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

/** artifact_id 없는 create 잡이 성공하는 데 필요한 DB 응답 큐 (기존 테스트와 동일 순서) */
function primeSuccessfulCreate(db: MockDb) {
  db.runQueue.push({ meta: { last_row_id: 100 } }) // job INSERT
  db.runQueue.push({ meta: { last_row_id: 50 } }) // artifact INSERT
  db.runQueue.push({ meta: { changes: 1 } }) // job에 artifact_id 연결
  db.firstQueue.push(null) // 채팅 중복 없음
  db.runQueue.push({ meta: { changes: 1 } }) // 사용자 메시지 저장
}

function jobInserts(db: MockDb) {
  return db.calls.filter((c) => c.sql.includes('INSERT INTO artifact_jobs'))
}

const base = { kind: 'create', prompt: '앱 만들어줘' }

// 전제 고정: 테스트 데이터가 실제 레지스트리와 어긋나면 여기서 먼저 실패한다.
describe('전제: 실제 MODELS 레지스트리 상태', () => {
  test('거부 케이스 모델은 deprecated, 정상 케이스 모델은 active', () => {
    expect(MODELS.filter((m) => m.id === 'gemini-3.5-flash').every((m) => m.status === 'deprecated')).toBe(true)
    expect(MODELS.filter((m) => m.id === 'llama-3.3-70b-versatile').every((m) => m.status === 'deprecated')).toBe(true)
    expect(MODELS.find((m) => m.id === 'gemini-3.5-flash-lite')?.status).toBe('active')
  })

  test('openai/gpt-oss-20b는 groq만 active다 (2026-10-30: nvidia 항목은 deprecated — 중복 id)', () => {
    const active = MODELS.filter((m) => m.id === 'openai/gpt-oss-20b' && m.status === 'active').map((m) => m.provider)
    expect(active).toEqual(['groq'])
    const nvidiaEntry = MODELS.find((m) => m.id === 'openai/gpt-oss-20b' && m.provider === 'nvidia')
    expect(nvidiaEntry?.status).toBe('deprecated')
  })

  test('NVIDIA 모델은 전부 deprecated다 (2026-10-30 운영 제외 전제)', () => {
    const nvidia = MODELS.filter((m) => m.provider === 'nvidia')
    expect(nvidia.length).toBeGreaterThan(0)
    expect(nvidia.every((m) => m.status !== 'active')).toBe(true)
  })
})

describe('POST /jobs: model 검증 거부 케이스', () => {
  test('MODELS에 없는 model → 400, 잡 INSERT 없음·큐 전송 없음', async () => {
    const { json, db, queue } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, provider: 'gemini', model: 'no-such-model-xyz' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('unknown model')
    expect(jobInserts(db)).toHaveLength(0)
    expect(queue.sent).toHaveLength(0)
  })

  test('deprecated model (gemini-3.5-flash) → 400, 잡을 만들지 않음', async () => {
    const { json, db, queue } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, provider: 'gemini', model: 'gemini-3.5-flash' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('not active')
    expect(jobInserts(db)).toHaveLength(0)
    expect(queue.sent).toHaveLength(0)
  })

  test('deprecated model (llama-3.3-70b-versatile, groq) → 400', async () => {
    const { json, db } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, provider: 'groq', model: 'llama-3.3-70b-versatile' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('not active')
    expect(jobInserts(db)).toHaveLength(0)
  })

  test('active model이지만 provider 불일치 → 400', async () => {
    const { json, db } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, provider: 'groq', model: 'gemini-3.5-flash-lite' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('model/provider mismatch')
    expect(jobInserts(db)).toHaveLength(0)
  })

  test('provider=nvidia는 관문 76에서 400 (2026-10-30: 유효 provider에서 제거)', async () => {
    const { json, db } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, provider: 'nvidia', model: 'openai/gpt-oss-20b' })
    expect(res.status).toBe(400)
    expect(jobInserts(db)).toHaveLength(0)
  })

  test('NVIDIA 모델(nvidia/nemotron-3-ultra-550b-a55b)은 비활성이라 400', async () => {
    const { json, db } = makeApp()
    const res = await json('/jobs', 'POST', { ...base, model: 'nvidia/nemotron-3-ultra-550b-a55b' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('not active')
    expect(jobInserts(db)).toHaveLength(0)
  })
})

describe('POST /jobs: model 검증 정상 케이스', () => {
  test('active model + 일치하는 provider → 202, 잡에 provider/model이 그대로 저장됨', async () => {
    const { json, db, queue } = makeApp()
    primeSuccessfulCreate(db)
    const res = await json('/jobs', 'POST', { ...base, provider: 'gemini', model: 'gemini-3.5-flash-lite' })
    expect(res.status).toBe(202)
    expect((await body(res)).data.jobId).toBe(100)
    const inserts = jobInserts(db)
    expect(inserts).toHaveLength(1)
    // INSERT 컬럼 순서: (kind, artifact_id, prompt, base_html, owner, client_request_id, provider, model)
    expect(inserts[0].params[6]).toBe('gemini')
    expect(inserts[0].params[7]).toBe('gemini-3.5-flash-lite')
    expect(queue.sent).toEqual([{ jobId: 100 }])
  })

  test('active model + provider 미제공 → 202 (provider 검사는 함께 제공된 경우만)', async () => {
    const { json, db } = makeApp()
    primeSuccessfulCreate(db)
    const res = await json('/jobs', 'POST', { ...base, model: 'openai/gpt-oss-120b' })
    expect(res.status).toBe(202)
  })

  test('model 미제공 → 202 (기존 경로 유지)', async () => {
    const { json, db } = makeApp()
    primeSuccessfulCreate(db)
    const res = await json('/jobs', 'POST', { ...base })
    expect(res.status).toBe(202)
  })

  test('중복 id 모델: openai/gpt-oss-20b는 groq로만 통과, nvidia는 400 (2026-10-30)', async () => {
    {
      const { json, db } = makeApp()
      primeSuccessfulCreate(db)
      const res = await json('/jobs', 'POST', { ...base, provider: 'groq', model: 'openai/gpt-oss-20b' })
      expect(res.status).toBe(202)
    }
    {
      const { json, db } = makeApp()
      const res = await json('/jobs', 'POST', { ...base, provider: 'nvidia', model: 'openai/gpt-oss-20b' })
      expect(res.status).toBe(400)
      expect(jobInserts(db)).toHaveLength(0)
    }
  })
})

describe('POST /jobs: agent.html UI 정상 경로 전수', () => {
  // agent.html callAiJob의 provider 추론 규칙 (public/agent.html 원문 그대로)
  function inferProvider(selectedModel: string): string {
    if (selectedModel.startsWith('openai/') && selectedModel.includes('gpt-oss')) return 'groq'
    if (
      selectedModel.startsWith('nvidia/') ||
      selectedModel.startsWith('meta/') ||
      selectedModel.startsWith('google/')
    ) {
      return 'nvidia'
    }
    return 'gemini'
  }

  function uiModelValues(): string[] {
    const html = fs.readFileSync(path.join(__dirname, '../../public/agent.html'), 'utf8')
    const start = html.indexOf('id="modelTag"')
    expect(start).toBeGreaterThan(-1)
    const selectBlock = html.slice(start, html.indexOf('</select>', start))
    const values = [...selectBlock.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])
    expect(values.length).toBeGreaterThan(0)
    return values
  }

  test('modelTag의 모든 option 값이 UI가 보내는 provider와 함께 검증을 통과한다', async () => {
    const values = uiModelValues()
    for (const model of values) {
      const { json, db } = makeApp()
      primeSuccessfulCreate(db)
      const res = await json('/jobs', 'POST', { ...base, provider: inferProvider(model), model })
      expect({ model, status: res.status }).toEqual({ model, status: 202 })
    }
  })
})
