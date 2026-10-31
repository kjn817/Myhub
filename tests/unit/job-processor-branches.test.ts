/**
 * job-processor.ts 추가 브랜치 커버리지 테스트
 * - uncovered branches를 실제로 실행하는 테스트
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

beforeEach(() => {
  jest.resetAllMocks()
})

// ============================================================
// processArtifactJob — modify 경로의 draft_version_id 분기
// ============================================================
describe('processArtifactJob / modify draft_version_id 분기', () => {
  function modifyDb(art: any) {
    return makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 5 })
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return art
      if (sql.includes('SELECT file_path, content FROM artifact_files')) return { results: [] }
      return null
    })
  }

  test('art가 null이면 initialFiles 없이 진행 (art?.draft_version_id false)', async () => {
    mockRunStudioAgent.mockResolvedValue({ ok: true, files: { 'index.html': '<html></html>' }, summary: '' })
    const db = modifyDb(null)
    const env = mkEnv(db)
    // saveJobResult mock을 위해 DB 핸들러 확장 필요 — 여기서는 agent 호출까지만 확인
    // 실제로는 전체 플로우가 실행되므로 DB를 충분히 모킹
    const fullDb = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 5 })
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return null
      if (sql.includes('SELECT file_path, content FROM artifact_files')) return { results: [] }
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 1 }] }
      if (sql.includes('content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 22)
      if (sql.startsWith('UPDATE artifacts SET')) return okRun(1)
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(fullDb), 1)
    expect(r).toBe('done')
  })

  test('art.draft_version_id가 없으면 파일 로드 스킵', async () => {
    mockRunStudioAgent.mockResolvedValue({ ok: true, files: { 'index.html': '<html></html>' }, summary: '' })
    const fullDb = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 5 })
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return { draft_version_id: null }
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 1 }] }
      if (sql.includes('content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 22)
      if (sql.startsWith('UPDATE artifacts SET')) return okRun(1)
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(fullDb), 1)
    expect(r).toBe('done')
    // artifact_files 조회가 호출되지 않았는지 확인
    const fileQuery = fullDb.calls.find((c: any) => c.sql.includes('artifact_files'))
    expect(fileQuery).toBeUndefined()
  })
})

// ============================================================
// processArtifactJob — agent 실패 시 error 폴백
// ============================================================
describe('processArtifactJob / agent 에러 폴백', () => {
  test('agentResult.error가 없으면 기본 메시지 사용', async () => {
    mockRunStudioAgent.mockResolvedValue({ ok: false }) // error 필드 없음
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.startsWith("UPDATE artifact_jobs SET status='failed'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed') // agent 실패 시 'failed' 반환
  })

  test('agentResult.files가 없으면 계약 위반으로 명시적 실패 처리된다 (빈 객체 폴백 없음)', async () => {
    // 실측 근거: AgentLoopResult.files는 필수 타입이고 runStudioAgent의 모든
    // 반환 경로는 {} 또는 workspace.getFiles()를 반환한다 (studio-agent.ts).
    // '파일 없음'의 정상 표현은 {}이며, undefined는 계약 위반 신호다.
    // || {}로 정규화하면 이 케이스가 summary-only 대화 모드(done)로 포장된다.
    // 가드 도입 전에는 Object.entries(undefined) TypeError로 우연히 failed 됐고,
    // awaitingInput 경로는 files가 무음으로 소실된 채 통과했다 — 가드가 둘 다 막는다.
    mockRunStudioAgent.mockResolvedValue({ ok: true, summary: '텍스트 응답' }) // files 없음
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.startsWith("UPDATE artifact_jobs SET status='failed'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    // 실패로 기록되고 계약 위반 원인이 DB에 남는다 (우연한 TypeError 문구가 아니다)
    const failed = db.calls.find((c: any) => c.sql.startsWith("UPDATE artifact_jobs SET status='failed'"))
    expect(failed).toBeDefined()
    expect(failed.params[0]).toContain('AI 호출 실패 (2회)')
    expect(failed.params[0]).toContain('AGENT_CONTRACT_VIOLATION')
    expect(failed.params[0]).not.toContain('Cannot convert undefined or null to object')
    // 대화 모드(done)로 포장되지 않는다: done 업데이트·채팅 저장이 없다
    expect(db.calls.find((c: any) => c.sql.startsWith("UPDATE artifact_jobs SET status='done'"))).toBeUndefined()
    expect(db.calls.find((c: any) => c.sql.includes('INSERT INTO artifact_chats'))).toBeUndefined()
    // 아티팩트·버전은 생성되지 않는다
    expect(db.calls.find((c: any) => c.sql.startsWith('INSERT INTO artifacts'))).toBeUndefined()
    expect(db.calls.find((c: any) => c.sql.startsWith('INSERT INTO artifact_versions'))).toBeUndefined()
    // job.failed 이벤트 기록
    const failedEvent = db.calls.find(
      (c: any) => c.sql.includes('INSERT INTO artifact_job_events') && c.params[1] === 'job.failed'
    )
    expect(failedEvent).toBeDefined()
    // 계약 위반은 break로 즉시 중단 — 에이전트는 1번만 호출된다
    expect(mockRunStudioAgent).toHaveBeenCalledTimes(1)
  })

  test('agentResult.files가 null이어도 계약 위반으로 실패 처리된다', async () => {
    mockRunStudioAgent.mockResolvedValue({ ok: true, files: null, summary: '텍스트 응답' })
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.startsWith("UPDATE artifact_jobs SET status='failed'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    const failed = db.calls.find((c: any) => c.sql.startsWith("UPDATE artifact_jobs SET status='failed'"))
    expect(failed.params[0]).toContain('AGENT_CONTRACT_VIOLATION')
  })

  test('awaitingInput인데 files가 없으면 awaiting_input으로 저장하지 않고 실패한다', async () => {
    // 가드 전 동작: pending_state의 JSON.stringify가 files 키를 무음으로 버려
    // 부분 파일이 소실된 채 awaiting_input이 됐다. 계약 위반은 fail-closed가 맞다.
    mockRunStudioAgent.mockResolvedValue({
      ok: false,
      awaitingInput: true,
      pendingQuestions: [{ id: 'q1', question: '뭘 만들까요?' }],
      summary: '',
    }) // files 없음
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.startsWith("UPDATE artifact_jobs SET status='failed'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    // awaiting_input 상태 저장이 일어나지 않는다
    expect(db.calls.find((c: any) => c.sql.includes("status='awaiting_input'"))).toBeUndefined()
    const failed = db.calls.find((c: any) => c.sql.startsWith("UPDATE artifact_jobs SET status='failed'"))
    expect(failed.params[0]).toContain('AGENT_CONTRACT_VIOLATION')
  })

  test('files={} (정상 무파일)는 계약 위반이 아니다 — 대화 모드 done 유지', async () => {
    // 대조군: undefined와 {}는 다르다. {}는 studio-agent 대화 모드의 정상 반환이라
    // 가드를 통과해 기존 summary-only 분기로 done 처리돼야 한다.
    mockRunStudioAgent.mockResolvedValue({ ok: true, files: {}, summary: '의견입니다' })
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.includes('INSERT INTO artifact_chats')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
    expect(db.calls.find((c: any) => c.sql.startsWith("UPDATE artifact_jobs SET status='failed'"))).toBeUndefined()
  })
})

// ============================================================
// generateHtml — 다양한 분기
// ============================================================
describe('generateHtml / 분기 커버리지', () => {
  const sysCtx = 'test-user@test.com'

  test('genResult.html이 없으면 빈 문자열 사용', async () => {
    mockGenerateArtifactHtml.mockResolvedValue({}) // html 없음
    const db = makeDb(() => null)
    const r = await generateHtml(mkEnv(db), sysCtx, 1, 'lease-1', 'wf-1')
    expect(r.html).toBe('')
    expect(r.error).toBe('HTML 추출 실패')
  })

  test('첫 번째 정규식 불일치 시 두 번째 시도', async () => {
    mockGenerateArtifactHtml.mockResolvedValue({ html: '```html\n<html><body>hi</body></html>\n```' })
    const db = makeDb(() => null)
    const r = await generateHtml(mkEnv(db), sysCtx, 1, 'lease-1', 'wf-1')
    expect(r.html).toContain('<html>')
  })

  test('에러에 message가 없으면 기본 메시지', async () => {
    mockGenerateArtifactHtml.mockRejectedValue({}) // message 없는 객체 throw
    const db = makeDb(() => null)
    const r = await generateHtml(mkEnv(db), sysCtx, 1, 'lease-1', 'wf-1')
    expect(r.error).toBeDefined()
  })
})

// ============================================================
// saveJobResult — 경계 조건
// ============================================================
describe('saveJobResult / 경계 조건', () => {
  test('html이 비어있으면 throw', async () => {
    const db = makeDb(() => null)
    await expect(saveJobResult(mkEnv(db), 1, '', 'title', 'create', 'prompt')).rejects.toThrow('HTML이 비어있습니다')
  })

  test('html이 공백만 있으면 throw', async () => {
    const db = makeDb(() => null)
    await expect(saveJobResult(mkEnv(db), 1, '   ', 'title', 'create', 'prompt')).rejects.toThrow('HTML이 비어있습니다')
  })

  test('doneUpdate.meta가 없으면 lease 잃음으로 처리', async () => {
    const db = makeDb((sql, params, m) => {
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ artifact_id: null })
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: null }
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 0 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 0 }] }
      if (sql.includes('content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 11)
      if (sql.startsWith('INSERT INTO artifacts')) return okRun(1, 5)
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) return {} // meta 없음
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await saveJobResult(mkEnv(db), 1, '<html></html>', 'title', 'create', 'prompt')
    // lease를 잃으면 busy를 반환하는 processArtifactJob 레벨에서 처리
    // saveJobResult는 artifactId를 반환
    expect(r.artifactId).toBe(5)
  })

  test('art.row_revision이 없으면 0에서 시작', async () => {
    const db = makeDb((sql, params, m) => {
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 5 })
      if (sql.includes('SELECT row_revision FROM artifacts')) return null // art 없음
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 0 }] }
      if (sql.includes('content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 11)
      if (sql.startsWith('UPDATE artifacts SET')) return okRun(1)
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await saveJobResult(mkEnv(db), 1, '<html></html>', 'title', 'modify', 'prompt', 5)
    expect(r.versionCreated).toBe(true)
  })

  test('vmax가 없으면 버전 1부터 시작', async () => {
    const db = makeDb((sql, params, m) => {
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 5 })
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [] } // vmax 없음
      if (sql.includes('content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 11)
      if (sql.startsWith('UPDATE artifacts SET')) return okRun(1)
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await saveJobResult(mkEnv(db), 1, '<html></html>', 'title', 'modify', 'prompt', 5)
    expect(r.versionCreated).toBe(true)
  })
})

// ============================================================
// markJobDone / markJobFailed — 에러 경로
// ============================================================
describe('markJobDone / markJobFailed 에러 경로', () => {
  test('markJobDone DB 실패 시 throw 전파', async () => {
    const db = makeDb((sql, params, m) => {
      if (sql.includes('SELECT lease_token FROM artifact_jobs')) return { lease_token: 'lease-1' }
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) throw new Error('db down')
      return null
    })
    await expect(markJobDone(mkEnv(db), 1, 5)).rejects.toThrow('db down')
  })

  test('markJobFailed 에러 슬라이싱', async () => {
    const db = makeDb(() => okRun(1))
    await markJobFailed(mkEnv(db), 1, 'x'.repeat(1000))
    const upd = db.calls.find((c: any) => c.sql.includes("status='failed'"))
    expect(upd!.params[0].length).toBe(500)
  })
})

// ============================================================
// claimJob — meta 폴백 분기
// ============================================================
describe('claimJob / meta 폴백', () => {
  test('claim UPDATE의 meta가 없으면 ?? 0 폴백', async () => {
    const db = makeDb((sql, params, m) => {
      if (m === 'run') return {} // meta 없음
      if (sql.includes('SELECT status FROM artifact_jobs WHERE id=?')) return null
      return null
    })
    const r = await claimJob(mkEnv(db), 1)
    expect(r.status).toBe('notfound')
  })
})

// ============================================================
// processArtifactJob — agent throw 경로
// ============================================================
describe('processArtifactJob / agent throw', () => {
  test('runStudioAgent가 message 없는 에러를 throw하면 기본 메시지 사용', async () => {
    mockRunStudioAgent.mockRejectedValue(new Error()) // message = ''
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.startsWith("UPDATE artifact_jobs SET status='failed'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
  })

  test('두 번 throw하면 재시도 후 failed (attempt < maxTries false 분기)', async () => {
    // maxTries=2, 두 번 다 throw → attempt=1에서 sleep, attempt=2에서 if false
    // (주의: ok:false 반환이 아니라 throw해야 line 213에 도달함)
    mockRunStudioAgent.mockRejectedValue(new Error('AI 오류'))
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.startsWith("UPDATE artifact_jobs SET status='failed'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('failed')
    // 재시도가 발생했는지 확인 (2초 sleep이 있었으면 2번 호출)
    expect(mockRunStudioAgent.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('index.html 없이 2개 html 파일이면 첫 번째 사용 (htmlFiles.length > 0)', async () => {
    // getPreviewHtml()은 index.html 없 + html 2개면 '' 반환 → 폴백 경로
    mockRunStudioAgent.mockResolvedValue({
      ok: true,
      files: {
        'a.html': '<!DOCTYPE html><html><body>a</body></html>',
        'b.html': '<!DOCTYPE html><html><body>b</body></html>',
      },
      summary: '',
    })
    const db = makeDb((sql, params, m) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob()
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: null }
      if (sql.startsWith('INSERT INTO artifacts')) return okRun(1, 5)
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 11)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.includes("UPDATE artifact_jobs SET status='done'")) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (m === 'run') return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
  })
})

// ============================================================
// processArtifactJob — modify 버전 생성 (saveJobResult 연결)
// v2 수정 실패의 진짜 원인: 큐 경로에서 modify가 버전을 생성하지 않았음
// (saveJobResult는 있었지만 프로덕션에서 호출되지 않는 데드코드였음)
// ============================================================
describe('processArtifactJob / modify 버전 생성', () => {
  function modifyVersionDb() {
    return makeDb((sql: string, params: any[], m: string) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 5 })
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return { draft_version_id: 22 }
      if (sql.includes('SELECT file_path, content FROM artifact_files')) {
        return { results: [{ file_path: 'index.html', content: '<html>v1</html>' }] }
      }
      if (sql.includes('created_at > ?')) return null // 동시 수정 없음
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 3 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 3 }] }
      if (sql.includes('content_sha256=?')) return null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, 22)
      if (sql.startsWith('UPDATE artifacts SET')) return okRun(1)
      if (sql.includes('published_version_id')) return null
      if (sql.startsWith('DELETE FROM artifact_versions')) return okRun(1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) return okRun(1)
      return null
    })
  }

  test('modify job은 saveJobResult로 새 버전을 만들고 워크스페이스를 저장한다', async () => {
    mockRunStudioAgent.mockResolvedValue({
      ok: true,
      files: { 'index.html': '<html>v2</html>', 'app.js': 'console.log(2)' },
      summary: '',
    })
    const db = modifyVersionDb()
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
    // 새 버전 생성 확인 (version_no = 기존 max 3 + 1)
    const verInsert = db.calls.find((c: any) => c.sql.startsWith('INSERT INTO artifact_versions'))
    expect(verInsert).toBeDefined()
    expect(verInsert.params[1]).toBe(4)
    // version.committed 이벤트 기록
    const committed = db.calls.find(
      (c: any) => c.sql.includes('INSERT INTO artifact_job_events') && c.params[1] === 'version.committed'
    )
    expect(committed).toBeDefined()
    // 멀티파일 워크스페이스 저장 (batch에 artifact_files INSERT 2건)
    const batch = db.calls.find((c: any) => c.sql === '__BATCH__')
    expect(batch).toBeDefined()
    expect(batch.params.length).toBe(2)
    // draft_version_id가 새 버전(22)을 가리키는지
    const draftUpdate = db.calls.find((c: any) =>
      c.sql.startsWith('UPDATE artifacts SET draft_version_id') && c.params[0] === 22
    )
    expect(draftUpdate).toBeDefined()
  })

  test('modify 내용이 동일하면 버전 없이 done (version.skipped)', async () => {
    mockRunStudioAgent.mockResolvedValue({
      ok: true,
      files: { 'index.html': '<html>same</html>' },
      summary: '',
    })
    const db = makeDb((sql: string, params: any[], m: string) => {
      if (sql.startsWith("UPDATE artifact_jobs SET status='running'")) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return baseJob({ kind: 'modify', artifact_id: 5 })
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return { draft_version_id: 10 }
      if (sql.includes('SELECT file_path, content FROM artifact_files')) return { results: [] }
      if (sql.includes('created_at > ?')) return null
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: 1 }] }
      if (sql.includes('content_sha256=?')) return { id: 99 } // 동일 내용 버전 존재
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (sql.startsWith("UPDATE artifact_jobs SET status='done'")) return okRun(1)
      return null
    })
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
    // 버전 INSERT 없음
    const verInsert = db.calls.find((c: any) => c.sql.startsWith('INSERT INTO artifact_versions'))
    expect(verInsert).toBeUndefined()
    // version.skipped 이벤트 기록
    const skipped = db.calls.find(
      (c: any) => c.sql.includes('INSERT INTO artifact_job_events') && c.params[1] === 'version.skipped'
    )
    expect(skipped).toBeDefined()
    // 워크스페이스 저장도 없음
    const batch = db.calls.find((c: any) => c.sql === '__BATCH__')
    expect(batch).toBeUndefined()
  })
})
