/**
 * job-processor.ts 100% 커버리지 단위 테스트
 * - D1 모킹, studio-agent / generate-html / ai/routes 모킹
 * - crypto.subtle은 Node 내장 webcrypto 사용
 */
/// <reference types="jest" />
import {
  logJobEvent,
  processArtifactJob,
  claimJob,
  generateHtml,
  saveJobResult,
  markJobDone,
  markJobFailed,
} from '../../src/modules/artifact/job-processor'
import { runStudioAgent } from '../../src/services/studio-agent'
import { generateArtifactHtml } from '../../src/modules/artifact/generate-html'

jest.mock('../../src/services/studio-agent', () => ({
  runStudioAgent: jest.fn(),
}))
jest.mock('../../src/modules/artifact/generate-html', () => ({
  generateArtifactHtml: jest.fn(),
}))
jest.mock('../../src/modules/ai/routes', () => ({
  callSingleAssistant: jest.fn(),
}))

const mockRunStudioAgent = runStudioAgent as jest.Mock
const mockGenerateArtifactHtml = generateArtifactHtml as jest.Mock

// ---------- Mock D1 ----------
type Handler = (sql: string, params: any[], method: 'first' | 'all' | 'run') => any

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function makeDb(handler: Handler) {
  const calls: { sql: string; params: any[]; method: string }[] = []
  const db = {
    calls,
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          return {
            first: async () => {
              calls.push({ sql: norm(sql), params, method: 'first' })
              return handler(norm(sql), params, 'first')
            },
            all: async () => {
              calls.push({ sql: norm(sql), params, method: 'all' })
              return handler(norm(sql), params, 'all')
            },
            run: async () => {
              calls.push({ sql: norm(sql), params, method: 'run' })
              return handler(norm(sql), params, 'run')
            },
          }
        },
      }
    },
    batch: async (stmts: any[]) => {
      calls.push({ sql: '__BATCH__', params: stmts, method: 'batch' })
      return []
    },
  }
  return db
}

const okRun = (changes = 1, lastRowId = 1) => ({ meta: { changes, last_row_id: lastRowId } })
const mkEnv = (db: any) => ({ DB: db } as any)

const baseJob = (over: any = {}) => ({
  id: 1,
  kind: 'create',
  prompt: '계산기 앱 만들어줘',
  status: 'running',
  model: 'gemini-3.5-flash-lite',
  provider: 'gemini',
  artifact_id: null,
  base_html: null,
  lease_token: 'lease-1',
  created_at: '2026-10-17 00:00:00',
  ...over,
})

const agentOk = (files: Record<string, string> = { 'index.html': '<!DOCTYPE html><html><body>hi</body></html>' }, extra: any = {}) => ({
  ok: true,
  files,
  summary: '',
  ...extra,
})

beforeEach(() => {
  jest.resetAllMocks() // once 큐까지 초기화 (테스트 간 누수 방지)
})

// ============================================================
// logJobEvent
// ============================================================
describe('logJobEvent', () => {
  test('이벤트를 INSERT한다', async () => {
    const db = makeDb(() => okRun())
    const env = mkEnv(db)
    await logJobEvent(env, 7, 'job.started', { kind: 'create' })
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO artifact_job_events'))
    expect(ins).toBeDefined()
    expect(ins!.params[0]).toBe(7)
    expect(ins!.params[1]).toBe('job.started')
    expect(JSON.parse(ins!.params[2])).toEqual({ kind: 'create' })
  })

  test('DB 실패 시 무시한다 (catch)', async () => {
    const db = makeDb(() => { throw new Error('db down') })
    const env = mkEnv(db)
    await expect(logJobEvent(env, 7, 'x')).resolves.toBeUndefined()
  })

  test('payload 기본값은 {}', async () => {
    const db = makeDb(() => okRun())
    const env = mkEnv(db)
    await logJobEvent(env, 7, 'x')
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO artifact_job_events'))
    expect(JSON.parse(ins!.params[2])).toEqual({})
  })
})

// ============================================================
// processArtifactJob — claim
// ============================================================
describe('processArtifactJob / claim', () => {
  test('claim 실패 + job 없음 → notfound', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      return null // SELECT status → null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('notfound')
  })

  test('claim 실패 + done → done', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      if (sql.includes('SELECT status')) return { status: 'done' }
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
  })

  test('claim 실패 + failed → done', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      if (sql.includes('SELECT status')) return { status: 'failed' }
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
  })

  test('claim 실패 + running → busy', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      if (sql.includes('SELECT status')) return { status: 'running' }
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('busy')
  })

  test('claim 성공 후 job 조회 null → notfound', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return okRun(1)
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('notfound')
  })

  test('claim run의 meta가 undefined여도 동작 (?? 0)', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return {} // meta 없음
      if (sql.includes('SELECT status')) return { status: 'pending' }
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('busy')
  })
})

// ============================================================
// processArtifactJob — create 성공
// ============================================================
describe('processArtifactJob / create 성공', () => {
  function createDb(job: any, opts: any = {}) {
    return makeDb((sql, params, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: opts.dupArtifactId ?? null }
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: opts.maxV ?? 0 }] }
      if (sql.includes('artifact_versions WHERE artifact_id=? AND content_sha256=?')) return opts.existingVer ?? null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, opts.versionId ?? 11)
      if (sql.startsWith('INSERT INTO artifacts')) return okRun(1, opts.artifactId ?? 5)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.startsWith('UPDATE artifacts SET project_type')) {
        if (opts.projectTypeFail) throw new Error('no col')
        return okRun(1)
      }
      if (sql.includes('UPDATE artifact_jobs SET status=\'done\'')) return okRun(opts.doneChanges ?? 1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (sql.includes('SELECT value FROM ai_settings')) return opts.setting ?? null
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return opts.art ?? null
      if (sql.includes('SELECT file_path, content FROM artifact_files')) return { results: opts.files ?? [] }
      if (m === 'run') return okRun(1)
      return null
    })
  }

  test('기본 create 흐름 → done, 버전/아티팩트 생성', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob())
    const env = mkEnv(db)
    const r = await processArtifactJob(env, 1)
    expect(r).toBe('done')
    // job.started, file.changed, job.completed 이벤트
    const types = db.calls.filter((c) => c.sql.includes('artifact_job_events')).map((c) => c.params[1])
    expect(types).toContain('job.started')
    expect(types).toContain('file.changed')
    expect(types).toContain('job.completed')
    // 아티팩트/버전 INSERT
    expect(db.calls.some((c) => c.sql.startsWith('INSERT INTO artifacts'))).toBe(true)
    expect(db.calls.some((c) => c.sql.startsWith('INSERT INTO artifact_versions'))).toBe(true)
  })

  test('자동 검증 실패 시 1회 수리 후 저장한다 (studio-verify 배선, 번들 계약)', async () => {
    const broken = '<!DOCTYPE html><html><body><div id="a"></div><div id="a"></div></body></html>'
    const fixed = '<!DOCTYPE html><html><body><div id="a"></div><div id="b"></div></body></html>'
    mockRunStudioAgent
      .mockResolvedValueOnce(agentOk({ 'index.html': broken }))
      .mockResolvedValueOnce(agentOk({ 'index.html': fixed }))
    const db = createDb(baseJob())
    const env = mkEnv(db)
    const r = await processArtifactJob(env, 1)
    expect(r).toBe('done')
    // 본 실행 1회 + 수리 1회
    expect(mockRunStudioAgent).toHaveBeenCalledTimes(2)
    const events = db.calls
      .filter((c) => c.sql.includes('INSERT INTO artifact_job_events'))
      .map((c) => ({ type: c.params[1], payload: JSON.parse(c.params[2]) }))
    expect(events.map((e) => e.type)).toContain('job.repairing')
    const verified = events.find((e) => e.type === 'job.verified')
    expect(verified).toBeDefined()
    expect(verified!.payload.repaired).toBe(true)
    expect(verified!.payload.beforeScore).toBeLessThan(100)
    expect(verified!.payload.score).toBe(100)
    // 저장되는 결과 HTML은 수리본이다
    const done = db.calls.find((c) => c.sql.includes("UPDATE artifact_jobs SET status='done'"))
    expect(done!.params[0]).toContain('id="b"')
  })

  test('제목에서 접미사 제거 ("계산기 앱 만들어줘" → "계산기 앱")', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ prompt: '계산기 앱 만들어줘' }))
    await processArtifactJob(mkEnv(db), 1)
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO artifacts'))
    expect(ins!.params[0]).toBe('계산기 앱')
  })

  test('빈 프롬프트 → 제목 "새 프로젝트"', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ prompt: '' }))
    await processArtifactJob(mkEnv(db), 1)
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO artifacts'))
    expect(ins!.params[0]).toBe('새 프로젝트')
  })

  test('job.model 없으면 ai_settings 조회 — NVIDIA 설정값은 검증 실패로 잡이 중단된다', async () => {
    // 현행 계약: 전환 가드는 없고 validateModelProviderPair가 fail-closed로
    // 거부한다. 'nvidia/nemotron-3'은 레지스트리 미등록 → MODEL_NOT_REGISTERED.
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ model: null, provider: null }), { setting: { value: 'nvidia/nemotron-3' } })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(db.calls.some((c) => c.sql.includes("ai_settings WHERE key='model.code'"))).toBe(true)
    expect(r).toBe('failed')
    expect(mockRunStudioAgent).not.toHaveBeenCalled()
    const ev = db.calls.find((c) => c.sql.includes('artifact_job_events') && c.params[1] === 'model.validation_failed')
    expect(ev).toBeDefined()
    expect(JSON.parse(ev!.params[2]).error).toContain('MODEL_NOT_REGISTERED')
  })

  test('job에 provider=nvidia가 저장돼 있으면 검증 실패로 잡이 중단된다 (레거시 행)', async () => {
    // nemotron-3-ultra는 레지스트리에 status='evaluation'으로만 있어
    // MODEL_NOT_ACTIVE — 에이전트는 호출되지 않는다.
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' }))
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    expect(mockRunStudioAgent).not.toHaveBeenCalled()
    const ev = db.calls.find((c) => c.sql.includes('artifact_job_events') && c.params[1] === 'model.validation_failed')
    expect(ev).toBeDefined()
    const payload = JSON.parse(ev!.params[2])
    expect(payload.model).toBe('nvidia/nemotron-3-ultra-550b-a55b')
    expect(payload.error).toContain('MODEL_NOT_ACTIVE')
  })

  // (c) 정리(2026-11-08 최종 배치): 에이전트가 실제로 받은 옵션(해석된
  // 모델/프로바이더·initialFiles)을 캡처 저널로 단언한다 (mock 호출 단언 대체).
  test('setting도 없으면 기본 모델 gemini-3.5-flash-lite', async () => {
    const agentOpts: any[] = []
    mockRunStudioAgent.mockImplementation(async (...a: any[]) => { agentOpts.push(a[2]); return agentOk() })
    const db = createDb(baseJob({ model: null, provider: null }), { setting: null })
    await processArtifactJob(mkEnv(db), 1)
    expect(agentOpts).toHaveLength(1)
    expect(agentOpts[0]).toEqual(
      expect.objectContaining({ model: 'gemini-3.5-flash-lite', provider: 'gemini' })
    )
  })

  test('openai/gpt-oss 모델 → groq 프로바이더', async () => {
    const agentOpts: any[] = []
    mockRunStudioAgent.mockImplementation(async (...a: any[]) => { agentOpts.push(a[2]); return agentOk() })
    const db = createDb(baseJob({ model: 'openai/gpt-oss-120b', provider: null }))
    await processArtifactJob(mkEnv(db), 1)
    expect(agentOpts).toHaveLength(1)
    expect(agentOpts[0]).toEqual(
      expect.objectContaining({ model: 'openai/gpt-oss-120b', provider: 'groq' })
    )
  })

  test('meta/ 모델(nvidia 레지스트리·deprecated) → 검증 실패로 중단', async () => {
    // 프로바이더는 접두사가 아니라 레지스트리로 판정된다. meta/muse-glimmer는
    // nvidia 소속 deprecated라 active가 없어 MODEL_NOT_ACTIVE.
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ model: 'meta/muse-glimmer-30b', provider: null }))
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    expect(mockRunStudioAgent).not.toHaveBeenCalled()
    const ev = db.calls.find((c) => c.sql.includes('artifact_job_events') && c.params[1] === 'model.validation_failed')
    expect(ev).toBeDefined()
    expect(JSON.parse(ev!.params[2]).error).toContain('MODEL_NOT_ACTIVE')
  })

  test('google/ 모델(nvidia 레지스트리·deprecated) → 검증 실패로 중단', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ model: 'google/diffusiongemma-26b-a4b-it', provider: null }))
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    expect(mockRunStudioAgent).not.toHaveBeenCalled()
    const ev = db.calls.find((c) => c.sql.includes('artifact_job_events') && c.params[1] === 'model.validation_failed')
    expect(ev).toBeDefined()
    expect(JSON.parse(ev!.params[2]).error).toContain('MODEL_NOT_ACTIVE')
  })

  test('toolCalls가 있으면 agent.tool_calls 이벤트 기록', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk({ 'index.html': '<!DOCTYPE html><html></html>' }, { toolCalls: ['create_file', 'validate_files'] }))
    const db = createDb(baseJob())
    await processArtifactJob(mkEnv(db), 1)
    const ev = db.calls.find((c) => c.sql.includes('artifact_job_events') && c.params[1] === 'agent.tool_calls')
    expect(ev).toBeDefined()
    expect(JSON.parse(ev!.params[2]).calls).toEqual(['create_file', 'validate_files'])
  })

  test('중복 artifact_id가 있으면 재사용 (dup)', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob(), { dupArtifactId: 42 })
    await processArtifactJob(mkEnv(db), 1)
    // artifacts INSERT가 없어야 함
    expect(db.calls.some((c) => c.sql.startsWith('INSERT INTO artifacts '))).toBe(false)
    const done = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'done\''))
    expect(done!.params[1]).toBe(42) // bind(html, resultArtifactId, jobId, leaseToken)
  })

  test('doneUpdate changes=0 → busy (lease 상실)', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob(), { doneChanges: 0 })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('busy')
  })

  test('결과 저장 중 예외 → failed ("결과 저장 실패")', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) throw new Error('boom')
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect(fail!.params[0]).toContain('결과 저장 실패')
  })

  test('멀티파일 → saveWorkspaceToD1(batch) + project_type=multi', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk({
      'index.html': '<!DOCTYPE html><html></html>',
      'app.js': 'console.log(1)',
    }))
    const db = createDb(baseJob())
    await processArtifactJob(mkEnv(db), 1)
    expect(db.calls.some((c) => c.sql === '__BATCH__')).toBe(true)
    expect(db.calls.some((c) => c.sql.includes("project_type='multi'"))).toBe(true)
  })

  test('project_type 업데이트 실패해도 무시 (try/catch)', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk({
      'index.html': '<!DOCTYPE html><html></html>',
      'app.js': 'x',
    }))
    const db = createDb(baseJob(), { projectTypeFail: true })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
  })

  test('plan 요청이면 plan 스킬 참조 포함', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ prompt: '서비스 계획서 작성해줘' }))
    await processArtifactJob(mkEnv(db), 1)
    const sysCtx = mockRunStudioAgent.mock.calls[0][1] as string
    expect(sysCtx).toContain('계획 작성 참고')
  })

  test('kind=chat이면 스킬 참조 없음', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ kind: 'chat', prompt: '안녕' }))
    await processArtifactJob(mkEnv(db), 1)
    const sysCtx = mockRunStudioAgent.mock.calls[0][1] as string
    expect(sysCtx).not.toContain('참고용 스킬')
    expect(sysCtx).toContain('완료 전 체크')
  })

  test('modify + base_html이면 수정 템플릿 사용', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = createDb(baseJob({ kind: 'modify', artifact_id: 7, base_html: '<html>old</html>' }), {
      art: { draft_version_id: 10 }, files: [],
    })
    await processArtifactJob(mkEnv(db), 1)
    const sysCtx = mockRunStudioAgent.mock.calls[0][1] as string
    expect(sysCtx.startsWith('기존 프로젝트 수정:')).toBe(true)
  })
})

// ============================================================
// processArtifactJob — modify 성공 (인라인 버전 생성)
// ============================================================
describe('processArtifactJob / modify 성공', () => {
  function modifyDb(job: any, opts: any = {}) {
    return makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: null }
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return opts.art ?? { draft_version_id: 10 }
      if (sql.includes('SELECT file_path, content FROM artifact_files')) return { results: opts.initFiles ?? [] }
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 2 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 1 }] }
      if (sql.includes('artifact_versions WHERE artifact_id=? AND content_sha256=?')) return opts.existingVer ?? null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 21)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'done\'')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
  }

  test('modify → done (saveJobResult로 버전 생성)', async () => {
    // v2 수정 실패 근본 원인 수정: 큐 경로(processArtifactJob)에서 modify도
    // saveJobResult()를 호출해 새 버전을 생성한다 (이전에는 버전 INSERT가 없었음).
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = modifyDb(baseJob({ kind: 'modify', artifact_id: 7, base_html: '<html>old</html>' }))
    const env = mkEnv(db)
    const r = await processArtifactJob(env, 1)
    expect(r).toBe('done')
    // 버전 INSERT 있음 (version_no = 기존 max 1 + 1 = 2)
    const verInsert = db.calls.find((c) => c.sql.startsWith('INSERT INTO artifact_versions'))
    expect(verInsert).toBeDefined()
    expect(verInsert!.params[1]).toBe(2)
    // version.committed 이벤트 기록
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO artifact_job_events') && c.params[1] === 'version.committed')).toBe(true)
    // doneUpdate에는 artifact_id=7 전달
    const done = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'done\''))
    expect(done!.params[1]).toBe(7)
  })

  test('modify + 기존 파일 로드 → initialFiles 전달', async () => {
    const agentOpts: any[] = []
    mockRunStudioAgent.mockImplementation(async (...a: any[]) => { agentOpts.push(a[2]); return agentOk() })
    const db = modifyDb(baseJob({ kind: 'modify', artifact_id: 7, base_html: 'x' }), {
      initFiles: [{ file_path: 'index.html', content: '<html>old</html>' }],
    })
    await processArtifactJob(mkEnv(db), 1)
    expect(agentOpts).toHaveLength(1)
    expect(agentOpts[0].initialFiles).toEqual({ 'index.html': '<html>old</html>' })
  })

  test('modify + 파일 로드 실패해도 계속 (catch 무시)', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 7, base_html: 'x' })
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: null }
      if (sql.includes('SELECT draft_version_id FROM artifacts')) throw new Error('db fail')
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 0 }] }
      if (sql.includes('artifact_versions WHERE artifact_id=? AND content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 21)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'done\'')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
  })

  test('modify + draft_version_id 없음 → initialFiles 없음', async () => {
    const agentOpts: any[] = []
    mockRunStudioAgent.mockImplementation(async (...a: any[]) => { agentOpts.push(a[2]); return agentOk() })
    const db = modifyDb(baseJob({ kind: 'modify', artifact_id: 7, base_html: 'x' }), { art: null })
    await processArtifactJob(mkEnv(db), 1)
    expect(agentOpts).toHaveLength(1)
    expect(agentOpts[0].initialFiles).toBeUndefined()
  })

  test('modify + 빈 파일 목록 → initialFiles 없음', async () => {
    const agentOpts: any[] = []
    mockRunStudioAgent.mockImplementation(async (...a: any[]) => { agentOpts.push(a[2]); return agentOk() })
    const db = modifyDb(baseJob({ kind: 'modify', artifact_id: 7, base_html: 'x' }), {
      art: { draft_version_id: 10 }, initFiles: [],
    })
    await processArtifactJob(mkEnv(db), 1)
    expect(agentOpts).toHaveLength(1)
    expect(agentOpts[0].initialFiles).toBeUndefined()
  })

  test('modify + 동일 내용이면 버전 INSERT 없이 무변경 실패 (version.skipped, 트랙 5)', async () => {
    // 트랙 5 (2026-11-01): 동일 내용 스킵 자체는 유지하되, 잡을 done으로
    // 위장하면 "수정 완료인데 버전 이력에 없음"이 되므로 무변경 사유로
    // failed 기록한다 (실DB 검증: studio-job-save-real.test.ts T4).
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = modifyDb(baseJob({ kind: 'modify', artifact_id: 7, base_html: 'x' }), { existingVer: { id: 99 } })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    expect(db.calls.some((c) => c.sql.startsWith('INSERT INTO artifact_versions'))).toBe(false)
    const fail = db.calls.find((c) => c.sql.includes("UPDATE artifact_jobs SET status='failed'"))
    expect(fail!.params[0]).toContain('변경 사항이 없')
  })

  test('modify 경로에서 _agentFiles가 있으면 batch로 워크스페이스 저장', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk({
      'index.html': '<!DOCTYPE html><html></html>',
      'style.css': 'a{}',
    }))
    const db = modifyDb(baseJob({ kind: 'modify', artifact_id: 7, base_html: 'x' }))
    await processArtifactJob(mkEnv(db), 1)
    const batch = db.calls.find((c) => c.sql === '__BATCH__')
    expect(batch).toBeDefined()
    expect(batch!.params.length).toBe(2)
  })
})

// ============================================================
// processArtifactJob — 대화 모드 / Markdown 전용 / 검증
// ============================================================
describe('processArtifactJob / 대화·검증', () => {
  function baseDb(job: any) {
    return makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
      if (sql.includes('INSERT INTO artifact_chats')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
  }

  test('대화 모드: 파일 없이 summary만 → done + 채팅 저장 (관문 9)', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({ ok: true, files: {}, summary: '좋은 의견이에요' })
    const db = baseDb(baseJob({ artifact_id: 7 }))
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
    const chat = db.calls.find((c) => c.sql.includes('INSERT INTO artifact_chats'))
    expect(chat).toBeDefined()
    expect(chat!.params[0]).toBe(7)
    expect(chat!.params[1]).toBe('p7') // 관문 9: p${artifactId}
    expect(chat!.params[2]).toBe('좋은 의견이에요')
    expect(chat!.params).toHaveLength(3) // (artifact_id, session_key, content), who는 SQL 고정
  })

  test('대화 모드: artifact_id 없으면 채팅 저장 안 함', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({ ok: true, files: {}, summary: '의견' })
    const db = baseDb(baseJob({ artifact_id: null }))
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO artifact_chats'))).toBe(false)
  })

  test('대화 모드: summary 5000자로 자름', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({ ok: true, files: {}, summary: 'a'.repeat(6000) })
    const db = baseDb(baseJob({ artifact_id: 7 }))
    await processArtifactJob(mkEnv(db), 1)
    const chat = db.calls.find((c) => c.sql.includes('INSERT INTO artifact_chats'))
    expect((chat!.params[2] as string).length).toBe(5000)
  })

  test('관문 11: HTML 없이 파일만 → 플레이스홀더로 진행', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({ ok: true, files: { 'plan.md': '# 계획' }, summary: '' })
    const db = makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: null }
      if (sql.startsWith('INSERT INTO artifacts')) return okRun(1, 5)
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 11)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'done\'')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
    const done = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'done\''))
    expect(done!.params[0]).toContain('non-html artifact: plan.md')
  })

  test('HTML도 파일도 없으면 ARTIFACT_VALIDATION_FAILED', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({ ok: true, files: {}, summary: '' })
    const db = baseDb(baseJob())
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect(fail!.params[0]).toContain('ARTIFACT_VALIDATION_FAILED')
  })

  test('관문 38: HTML 2MB 초과 시 저장 차단됨 (2026-10-17 수정됨)', async () => {
    // 수정 후: 2MB 초과 시 html을 비워서 저장 경로에 진입하지 않음 → failed 반환
    mockRunStudioAgent.mockResolvedValueOnce(agentOk({ 'index.html': '<!DOCTYPE html><html>' + 'x'.repeat(3 * 1024 * 1024) + '</html>' }))
    const db = baseDb(baseJob())
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    // 저장되지 않아야 함
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO artifacts'))).toBe(false)
  })

  test('getPreviewHtml 비어있으면 files의 첫 html 사용 (폴백)', async () => {
    // index.html 없이 a.html만 있으면 getPreviewHtml()='' → 폴백 경로
    mockRunStudioAgent.mockResolvedValueOnce(agentOk({ 'a.html': '<!DOCTYPE html><html><body>x</body></html>' }))
    const db = makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: null }
      if (sql.startsWith('INSERT INTO artifacts')) return okRun(1, 5)
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 11)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'done\'')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('done')
  })
})

// ============================================================
// processArtifactJob — 에이전트 에러 분기 + 폴백 (관문 40)
// ============================================================
describe('processArtifactJob / 에러·폴백', () => {
  function failDb(job: any) {
    return makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'failed\'')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
  }

  test('agent !ok → 즉시 중단 후 failed', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({ ok: false, files: {}, error: '모델 오류' })
    const db = failDb(baseJob())
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    expect(mockRunStudioAgent).toHaveBeenCalledTimes(1) // break로 1회만
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect(fail!.params[0]).toContain('모델 오류')
  })

  test('429 → rate_limited, 재시도 없이 failed', async () => {
    const e: any = new Error('too many')
    e.code = 429
    mockRunStudioAgent.mockRejectedValueOnce(e)
    const db = failDb(baseJob())
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    expect(mockRunStudioAgent).toHaveBeenCalledTimes(1)
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect(fail!.params[0]).toContain('rate_limited (429)')
  })

  test('401 → 영구 오류로 중단', async () => {
    const e: any = new Error('unauthorized')
    e.code = 401
    mockRunStudioAgent.mockRejectedValueOnce(e)
    const db = failDb(baseJob())
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect(fail!.params[0]).toContain('영구 오류')
  })

  test('unknown_persona 메시지 → 영구 오류로 중단', async () => {
    mockRunStudioAgent.mockRejectedValueOnce(new Error('unknown_persona: xxx'))
    const db = failDb(baseJob())
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    expect(mockRunStudioAgent).toHaveBeenCalledTimes(1)
  })

  test('AbortError → AI 타임아웃', async () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    mockRunStudioAgent.mockRejectedValueOnce(e)
    const db = failDb(baseJob())
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect(fail!.params[0]).toContain('AI 타임아웃 (180초)')
  })

  test('AI_TIMEOUT 메시지 → AI 타임아웃', async () => {
    mockRunStudioAgent.mockRejectedValueOnce(new Error('AI_TIMEOUT reached'))
    const db = failDb(baseJob())
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect(fail!.params[0]).toContain('AI 타임아웃 (180초)')
  })

  test('일반 에러 → 2차 시도(폴백) 후 성공', async () => {
    // 폴백 검증은 허용 프로바이더 모델로 수행한다 (nvidia 잡은 검증 단계에서
    // 중단돼 폴백 경로 자체에 도달하지 않음 — 위 검증 실패 테스트들 참조)
    mockRunStudioAgent.mockRejectedValueOnce(new Error('weird failure'))
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = failDb(baseJob({ model: 'openai/gpt-oss-120b', provider: 'groq' }))
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
    expect(mockRunStudioAgent).toHaveBeenCalledTimes(2)
  }, 15000)

  test('관문 40: 5xx → 2차 시도에서 폴백 모델 + model.fallback 이벤트', async () => {
    const e: any = new Error('internal')
    e.code = 500
    mockRunStudioAgent.mockRejectedValueOnce(e)
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = makeDb((sql, _p, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ model: 'openai/gpt-oss-120b', provider: 'groq' })
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: null }
      if (sql.startsWith('INSERT INTO artifacts')) return okRun(1, 5)
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 11)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'done\'')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
    const fb = db.calls.find((c) => c.sql.includes('artifact_job_events') && c.params[1] === 'model.fallback')
    expect(fb).toBeDefined()
    const payload = JSON.parse(fb!.params[2])
    expect(payload.from).toBe('openai/gpt-oss-120b')
    expect(payload.to).toBe('gemini-3.5-flash-lite')
    // 2차 호출은 폴백 모델
    expect(mockRunStudioAgent.mock.calls[1][2]).toEqual(expect.objectContaining({ model: 'gemini-3.5-flash-lite', provider: 'gemini' }))
  }, 15000)

  test('관문 40: 이미 폴백 모델인데 실패 → break 후 failed', async () => {
    const e: any = new Error('internal')
    e.code = 500
    mockRunStudioAgent.mockRejectedValueOnce(e) // 1차 실패 (5xx)
    const db = failDb(baseJob({ model: 'gemini-3.5-flash-lite', provider: 'gemini' }))
    expect(await processArtifactJob(mkEnv(db), 1)).toBe('failed')
    expect(mockRunStudioAgent).toHaveBeenCalledTimes(1) // 2차 진입 후 break
  }, 15000)

  test('실패 메시지는 500자로 자름', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({ ok: false, files: {}, error: 'z'.repeat(1000) })
    const db = failDb(baseJob())
    await processArtifactJob(mkEnv(db), 1)
    const fail = db.calls.find((c) => c.sql.includes('UPDATE artifact_jobs SET status=\'failed\''))
    expect((fail!.params[0] as string).length).toBeLessThanOrEqual(500)
  })
})

// ============================================================
// claimJob
// ============================================================
describe('claimJob', () => {
  test('claim 성공 → claimed + leaseToken', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return okRun(1)
      return null
    })
    const r = await claimJob(mkEnv(db), 1)
    expect(r.status).toBe('claimed')
    if (r.status === 'claimed') expect(typeof r.leaseToken).toBe('string')
    // lease 토큰 저장 UPDATE 호출됨
    expect(db.calls.some((c) => c.sql.includes('SET lease_token=? WHERE id=?'))).toBe(true)
  })

  test('job 없음 → notfound', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      return null
    })
    expect((await claimJob(mkEnv(db), 1)).status).toBe('notfound')
  })

  test('done 상태 → notfound', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      if (sql.includes('SELECT status')) return { status: 'done' }
      return null
    })
    expect((await claimJob(mkEnv(db), 1)).status).toBe('notfound')
  })

  test('failed 상태 → notfound', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      if (sql.includes('SELECT status')) return { status: 'failed' }
      return null
    })
    expect((await claimJob(mkEnv(db), 1)).status).toBe('notfound')
  })

  test('running 상태 → busy', async () => {
    const db = makeDb((sql, _p, m) => {
      if (m === 'run') return { meta: { changes: 0 } }
      if (sql.includes('SELECT status')) return { status: 'running' }
      return null
    })
    expect((await claimJob(mkEnv(db), 1)).status).toBe('busy')
  })
})

// ============================================================
// generateHtml
// ============================================================
describe('generateHtml', () => {
  const env = {} as any

  test('jobId 0 → INVALID_JOB_ID', async () => {
    await expect(generateHtml(env, 'ctx', 0, 't', 'w')).rejects.toThrow('INVALID_JOB_ID')
  })

  test('jobId 음수 → INVALID_JOB_ID', async () => {
    await expect(generateHtml(env, 'ctx', -1, 't', 'w')).rejects.toThrow('INVALID_JOB_ID')
  })

  test('leaseToken 없음 → MISSING_JOB_LEASE', async () => {
    await expect(generateHtml(env, 'ctx', 1, '', 'w')).rejects.toThrow('MISSING_JOB_LEASE')
  })

  test('workflowInstanceId 없음 → MISSING_WORKFLOW_ID', async () => {
    await expect(generateHtml(env, 'ctx', 1, 't', '')).rejects.toThrow('MISSING_WORKFLOW_ID')
  })

  test('[ARTIFACT_CREATE] JSON 파싱 성공', async () => {
    mockGenerateArtifactHtml.mockResolvedValueOnce({
      html: '[ARTIFACT_CREATE]{"html":"<html>H</html>","title":"T"}[/ARTIFACT_CREATE]',
      model: 'm', keySlot: 1,
    })
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.html).toBe('<html>H</html>')
    expect(r.title).toBe('T')
    expect(r.error).toBeUndefined()
  })

  test('[ARTIFACT_CREATE] JSON에 html 없으면 원문 사용', async () => {
    mockGenerateArtifactHtml.mockResolvedValueOnce({
      html: '[ARTIFACT_CREATE]{"title":"T"}[/ARTIFACT_CREATE]',
      model: 'm', keySlot: 1,
    })
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.html).toBe('{"title":"T"}') // j.html falsy → m[1]
    expect(r.title).toBe('T') // j.title || ''
  })

  test('[ARTIFACT_CREATE] JSON 파싱 실패 → 원문 사용', async () => {
    mockGenerateArtifactHtml.mockResolvedValueOnce({
      html: '[ARTIFACT_CREATE]not json[/ARTIFACT_CREATE]',
      model: 'm', keySlot: 1,
    })
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.html).toBe('not json')
  })

  test('```html 블록 추출', async () => {
    mockGenerateArtifactHtml.mockResolvedValueOnce({
      html: '설명\n```html\n<html>B</html>\n```',
      model: 'm', keySlot: 1,
    })
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.html).toBe('<html>B</html>\n') // 정규식이 ``` 전까지 캡처
  })

  test('<html 포함 텍스트 그대로 사용', async () => {
    mockGenerateArtifactHtml.mockResolvedValueOnce({
      html: '<!DOCTYPE html><html>C</html>',
      model: 'm', keySlot: 1,
    })
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.html).toContain('<html>C</html>')
  })

  test('HTML 없으면 error 반환', async () => {
    mockGenerateArtifactHtml.mockResolvedValueOnce({ html: '그냥 텍스트', model: 'm', keySlot: 1 })
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.html).toBe('')
    expect(r.error).toBe('HTML 추출 실패')
  })

  test('AbortError → AI 타임아웃', async () => {
    const e = new Error('x')
    e.name = 'AbortError'
    mockGenerateArtifactHtml.mockRejectedValueOnce(e)
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.error).toBe('AI 타임아웃 (180초)')
  })

  test('AI_TIMEOUT 메시지 → AI 타임아웃', async () => {
    mockGenerateArtifactHtml.mockRejectedValueOnce(new Error('AI_TIMEOUT!'))
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.error).toBe('AI 타임아웃 (180초)')
  })

  test('429 → rate_limited', async () => {
    const e: any = new Error('limit')
    e.code = 429
    mockGenerateArtifactHtml.mockRejectedValueOnce(e)
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.error).toBe('rate_limited (429)')
  })

  test('403 → 영구 오류', async () => {
    const e: any = new Error('forbidden')
    e.code = 403
    mockGenerateArtifactHtml.mockRejectedValueOnce(e)
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.error).toContain('영구 오류')
  })

  test('too_long 메시지 → 영구 오류', async () => {
    mockGenerateArtifactHtml.mockRejectedValueOnce(new Error('prompt too_long!!!'))
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.error).toContain('영구 오류')
  })

  test('일반 에러 → 메시지 저장', async () => {
    mockGenerateArtifactHtml.mockRejectedValueOnce(new Error('boom'))
    const r = await generateHtml(env, 'ctx', 1, 't', 'w')
    expect(r.error).toBe('boom')
  })
})

// ============================================================
// saveJobResult
// ============================================================
describe('saveJobResult', () => {
  const HTML = '<!DOCTYPE html><html><body>hi</body></html>'

  test('빈 HTML → throw', async () => {
    const db = makeDb(() => null)
    await expect(saveJobResult(mkEnv(db), 1, '', 't', 'create', 'p')).rejects.toThrow('비어있습니다')
  })

  test('공백 HTML → throw', async () => {
    const db = makeDb(() => null)
    await expect(saveJobResult(mkEnv(db), 1, '   ', 't', 'create', 'p')).rejects.toThrow('비어있습니다')
  })

  describe('modify', () => {
    function modDb(job: any, opts: any = {}) {
      return makeDb((sql, _p, m) => {
        if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
        if (sql.includes('artifact_versions WHERE artifact_id=? AND created_at > ?')) return opts.concurrent ?? null
        if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
        if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: opts.maxV ?? 1 }] }
        if (sql.includes('artifact_versions WHERE artifact_id=? AND content_sha256=?')) return opts.existingVer ?? null
        if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 31)
        if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
        if (sql.includes('SELECT published_version_id FROM artifacts')) return { published_version_id: opts.pubId ?? 0 }
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

    test('artifact_id 없으면 MODIFY_ARTIFACT_ID_REQUIRED', async () => {
      const db = modDb({ id: 1, artifact_id: null, lease_token: 't', created_at: '2026-01-01' })
      await expect(saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', 'p')).rejects.toThrow('MODIFY_ARTIFACT_ID_REQUIRED')
    })

    test('관문 43: 동시 수정 감지 → CONCURRENT_MODIFY', async () => {
      const db = modDb({ id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00' }, { concurrent: { id: 99 } })
      await expect(saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', 'p')).rejects.toThrow('CONCURRENT_MODIFY')
    })

    test('job.created_at 없으면 동시성 체크 스킵', async () => {
      const db = modDb({ id: 1, artifact_id: 7, lease_token: 't', created_at: null })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', 'p')
      expect(r.versionCreated).toBe(true)
      expect(db.calls.some((c) => c.sql.includes('created_at > ?'))).toBe(false)
    })

    test('새 버전 생성 → versionCreated=true + version.committed', async () => {
      const db = modDb({ id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00' })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', '프롬프트')
      // B5: 반환에 병합 정보 추가됨 (스냅샷 없으면 충돌 없음)
      expect(r).toEqual({ artifactId: 7, versionCreated: true, mergedFiles: {}, mergedHtml: HTML, conflicts: [], branched: false })
      const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO artifact_versions'))
      expect(ins!.params[0]).toBe(7)
      expect(ins!.params[1]).toBe(2) // maxV+1
      const ev = db.calls.find((c) => c.params[1] === 'version.committed')
      expect(JSON.parse(ev!.params[2])).toEqual(expect.objectContaining({ artifact_id: 7, version_no: 2 }))
    })

    test('동일 내용 → version.skipped + noChange=true', async () => {
      const db = modDb({ id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00' }, { existingVer: { id: 5 } })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', 'p')
      expect(r).toEqual({ artifactId: 7, versionCreated: false, noChange: true })
      const ev = db.calls.find((c) => c.params[1] === 'version.skipped')
      expect(JSON.parse(ev!.params[2]).reason).toBe('identical_content')
    })

    test('버전 정리 실패해도 무시 (관문 72 try/catch)', async () => {
      const db = modDb({ id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00' }, { cleanupFail: true })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', 'p')
      expect(r.versionCreated).toBe(true)
    })

    test('artifactId 파라미터로 전달 가능', async () => {
      const db = modDb({ id: 1, artifact_id: null, lease_token: 't', created_at: '2026-10-17 10:00:00' })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', 'p', 9)
      expect(r.artifactId).toBe(9)
    })

    test('job 자체가 null이면 TypeError (방어 없음 — 문서화)', async () => {
      const db = modDb(null)
      // (job as any).created_at 에서 null 접근 → TypeError
      await expect(saveJobResult(mkEnv(db), 1, HTML, 't', 'modify', 'p', 9)).rejects.toThrow()
    })
  })

  describe('create', () => {
    function createDb(job: any, opts: any = {}) {
      return makeDb((sql, _p, m) => {
        if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
        if (sql.includes('artifact_versions WHERE artifact_id=? LIMIT 1')) return opts.verExists ?? null
        if (sql.startsWith('INSERT INTO artifacts')) {
          if (opts.insertFail) throw opts.insertFail
          return okRun(1, opts.newId ?? 50)
        }
        if (sql.includes('SELECT id FROM artifacts WHERE source_job_id=?')) return opts.srcExisting ?? null
        if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 51)
        if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
        if (sql.includes('UPDATE artifact_jobs SET artifact_id')) return okRun(1)
        if (m === 'run') return okRun(1)
        return null
      })
    }

    test('관문 1: 버전 있으면 중복 반환', async () => {
      const db = createDb({ id: 1, artifact_id: 7, lease_token: 't' }, { verExists: { id: 1 } })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'create', 'p')
      expect(r).toEqual({ artifactId: 7, versionCreated: false })
      expect(db.calls.some((c) => c.sql.startsWith('INSERT INTO artifact_versions'))).toBe(false)
    })

    test('관문 1: 사전 연결 artifact에 버전 없으면 생성', async () => {
      const db = createDb({ id: 1, artifact_id: 7, lease_token: 't' }, { verExists: null })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'create', 'p')
      expect(r.versionCreated).toBe(true)
      expect(db.calls.some((c) => c.sql.startsWith('INSERT INTO artifact_versions'))).toBe(true)
    })

    test('새 artifact 생성 → INSERT + v1', async () => {
      const db = createDb({ id: 1, artifact_id: null, lease_token: 't' })
      const r = await saveJobResult(mkEnv(db), 1, HTML, '', 'create', '프롬프트 텍스트')
      expect(r.artifactId).toBe(50)
      expect(r.versionCreated).toBe(true)
      const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO artifacts'))
      expect(ins!.params[0]).toBe('프롬프트 텍스트'.slice(0, 30)) // title 폴백
    })

    test('UNIQUE 위반 → 기존 artifact 재사용', async () => {
      const db = createDb(
        { id: 1, artifact_id: null, lease_token: 't' },
        { insertFail: new Error('UNIQUE constraint failed'), srcExisting: { id: 77 } }
      )
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'create', 'p')
      expect(r.artifactId).toBe(77)
    })

    test('UNIQUE 위반인데 기존 조회 null → rethrow', async () => {
      const db = createDb(
        { id: 1, artifact_id: null, lease_token: 't' },
        { insertFail: new Error('UNIQUE constraint failed'), srcExisting: null }
      )
      await expect(saveJobResult(mkEnv(db), 1, HTML, 't', 'create', 'p')).rejects.toThrow('UNIQUE')
    })

    test('UNIQUE 아닌 에러 → throw', async () => {
      const db = createDb(
        { id: 1, artifact_id: null, lease_token: 't' },
        { insertFail: new Error('disk full') }
      )
      await expect(saveJobResult(mkEnv(db), 1, HTML, 't', 'create', 'p')).rejects.toThrow('disk full')
    })

    test('artifactId 파라미터가 있으면 그대로 사용', async () => {
      const db = createDb({ id: 1, artifact_id: null, lease_token: 't' })
      const r = await saveJobResult(mkEnv(db), 1, HTML, 't', 'create', 'p', 88)
      expect(r.artifactId).toBe(88)
    })
  })
})

// ============================================================
// markJobDone / markJobFailed
// ============================================================
describe('markJobDone', () => {
  test('lease_token으로 done 처리', async () => {
    const db = makeDb((sql, _p, m) => {
      if (sql.includes('SELECT lease_token FROM artifact_jobs')) return { lease_token: 'tok-1' }
      if (m === 'run') return okRun(1)
      return null
    })
    await markJobDone(mkEnv(db), 1, 5)
    const upd = db.calls.find((c) => c.sql.includes('SET status=\'done\''))
    expect(upd!.params).toEqual([5, 1, 'tok-1'])
  })

  test('job null이어도 동작 (lease_token undefined)', async () => {
    const db = makeDb((sql, _p, m) => {
      if (sql.includes('SELECT lease_token FROM artifact_jobs')) return null
      if (m === 'run') return okRun(1)
      return null
    })
    await expect(markJobDone(mkEnv(db), 1, null)).resolves.toBeUndefined()
    const upd = db.calls.find((c) => c.sql.includes('SET status=\'done\''))
    expect(upd!.params[2]).toBeUndefined()
  })
})

describe('markJobFailed', () => {
  test('error 500자로 자름', async () => {
    const db = makeDb(() => okRun(1))
    await markJobFailed(mkEnv(db), 1, 'e'.repeat(1000))
    const upd = db.calls.find((c) => c.sql.includes('SET status=\'failed\''))
    expect((upd!.params[0] as string).length).toBe(500)
    expect(upd!.params[1]).toBe(1)
  })
})

// ============================================================
// A1: ask_question → awaiting_input → answer → resume
describe('processArtifactJob / awaiting_input', () => {
  function awaitingDb(job: any) {
    return makeDb((sql, params, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET pending_state=NULL')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'awaiting_input\'')) return okRun(1)
      if (sql.includes('SELECT value FROM ai_settings')) return null
      if (m === 'run') return okRun(1)
      return null
    })
  }

  test('ask_question → awaiting_input 상태 저장 후 반환', async () => {
    mockRunStudioAgent.mockResolvedValueOnce({
      ok: false,
      files: { 'index.html': '<html>partial</html>' },
      turns: 2,
      summary: '',
      awaitingInput: true,
      pendingQuestions: [{ id: 'color', question: '어떤 색?' }],
    })
    const db = awaitingDb(baseJob())
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('awaiting_input')
    // pending_state에 질문+부분 파일 저장
    const upd = db.calls.find((c) => c.sql.includes("status='awaiting_input'"))
    expect(upd).toBeDefined()
    const ps = JSON.parse(upd!.params[0])
    expect(ps.questions).toHaveLength(1)
    expect(ps.files['index.html']).toContain('partial')
    // 이벤트 기록
    const types = db.calls.filter((c) => c.sql.includes('artifact_job_events')).map((c) => c.params[1])
    expect(types).toContain('job.awaiting_input')
  })

  test('answer 후 재개 → Q&A가 프롬프트에 주입됨', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const job = baseJob({
      pending_state: JSON.stringify({
        questions: [{ id: 'color', question: '어떤 색?' }],
        answers: [{ id: 'color', answer: '파란색' }],
        files: { 'index.html': '<html>partial</html>' },
      }),
    })
    const db = awaitingDb(job)
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
    // 에이전트 호출 시 Q&A가 프롬프트에 포함됨
    const callArgs = mockRunStudioAgent.mock.calls[0]
    expect(callArgs[1]).toContain('파란색')
    expect(callArgs[1]).toContain('어떤 색?')
    // 부분 파일이 initialFiles로 전달됨
    expect(callArgs[2].initialFiles['index.html']).toContain('partial')
    // pending_state 정리됨
    expect(db.calls.some((c) => c.sql.includes('UPDATE artifact_jobs SET pending_state=NULL'))).toBe(true)
    // 재개 이벤트
    const types = db.calls.filter((c) => c.sql.includes('artifact_job_events')).map((c) => c.params[1])
    expect(types).toContain('job.resumed')
  })

  test('pending_state 파싱 실패 → 무시하고 진행', async () => {
    mockRunStudioAgent.mockResolvedValueOnce(agentOk())
    const db = awaitingDb(baseJob({ pending_state: 'not-json{{{' }))
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
  })
})
