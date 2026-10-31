/**
 * Phase B (B1/B2/B3/B4/B5) 단위 테스트
 * - B1: POST /jobs modify → base_version_id + base_snapshot 저장
 * - B2: StudioWorkspace onMutation (file.stream 백엔드)
 * - B3: POST /:id/versions/files (파일 단위 저장)
 * - B4: GET /:id/active-job (소프트 파일 잠금)
 * - B5: saveJobResult 파일 병합 + 충돌 시 버전 분기
 * - 보안: POST /:id/versions 소유권 체크
 */
import { Hono } from 'hono'
import { artifactApp } from '../../src/modules/artifact/routes'
import { StudioWorkspace } from '../../src/services/studio-workspace'
import { saveJobResult } from '../../src/modules/artifact/job-processor'

// ---------------- Mock D1 (routes 테스트용) ----------------
class MockDb {
  firstQueue: any[] = []
  allQueue: any[] = []
  runQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []

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

  async batch(_stmts: any[]) { return [] }
}

function makeApp(opts: { userEmail?: string | null; db?: MockDb } = {}) {
  const db = opts.db ?? new MockDb()
  const sent: any[] = []
  const queue = { sent, send: async (m: any) => { sent.push(m) } }
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (opts.userEmail === undefined) (c as any).set('userEmail', 'test@example.com')
    else if (opts.userEmail !== null) (c as any).set('userEmail', opts.userEmail)
    await next()
  })
  app.route('/a', artifactApp)
  const env: any = { DB: db, ARTIFACT_QUEUE: queue }
  const json = (path: string, method: string, body?: any) =>
    app.request('/a' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
  return { db, queue, json }
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ============================================================
// B2: StudioWorkspace onMutation
// ============================================================
describe('B2: StudioWorkspace onMutation', () => {
  test('create_file → onMutation(path, content)', async () => {
    const ws = new StudioWorkspace()
    const calls: any[] = []
    ws.onMutation = (p, c) => calls.push([p, c])
    await ws.execute({ name: 'create_file', arguments: { path: 'a.html', content: '<h1>x</h1>' } })
    expect(calls).toEqual([['a.html', '<h1>x</h1>']])
  })

  test('edit_file → onMutation 호출', async () => {
    const ws = new StudioWorkspace({ 'a.html': '<h1>old</h1>' })
    const calls: any[] = []
    ws.onMutation = (p, c) => calls.push([p, c])
    await ws.execute({ name: 'edit_file', arguments: { path: 'a.html', old_string: 'old', new_string: 'new' } })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('a.html')
    expect(calls[0][1]).toContain('new')
  })

  test('delete_file → onMutation(path, null)', async () => {
    const ws = new StudioWorkspace({ 'a.html': 'x' })
    const calls: any[] = []
    ws.onMutation = (p, c) => calls.push([p, c])
    await ws.execute({ name: 'delete_file', arguments: { path: 'a.html' } })
    expect(calls).toEqual([['a.html', null]])
  })

  test('read_file/list_files → onMutation 미호출', async () => {
    const ws = new StudioWorkspace({ 'a.html': 'x' })
    const calls: any[] = []
    ws.onMutation = (p, c) => calls.push([p, c])
    await ws.execute({ name: 'read_file', arguments: { path: 'a.html' } })
    await ws.execute({ name: 'list_files', arguments: {} })
    expect(calls).toEqual([])
  })

  test('콜백 없으면 정상 동작 (하위 호환)', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: 'a.html', content: 'x' } })
    expect(r.ok).toBe(true)
  })

  test('edit_file 유연 매칭 → onMutation 호출', async () => {
    const ws = new StudioWorkspace({ 'a.html': '<h1>  old</h1>' })
    const calls: any[] = []
    ws.onMutation = (p, c) => calls.push([p, c])
    // 정확한 매칭 실패(공백 2개 vs 1개) → 공백 정규화 매칭 경로
    await ws.execute({ name: 'edit_file', arguments: { path: 'a.html', old_string: '<h1> old</h1>', new_string: '<h1>new</h1>' } })
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain('new')
  })

  test('apply_patch → onMutation 호출', async () => {
    const ws = new StudioWorkspace({ 'a.html': '<h1>old</h1>' })
    const calls: any[] = []
    ws.onMutation = (p, c) => calls.push([p, c])
    await ws.execute({ name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** Update File: a.html\n@@\n-<h1>old</h1>\n+<h1>new</h1>\n*** End Patch' } })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('a.html')
    expect(calls[0][1]).toContain('new')
  })
})

// ============================================================
// B1: POST /jobs modify → 스냅샷 저장
// ============================================================
describe('B1: POST /jobs 스냅샷', () => {
  test('modify 작업 생성 시 base_version_id + base_snapshot 저장', async () => {
    const { db, json } = makeApp()
    // 관문 79(POST /jobs 소유권 확인) 이후: artifact 소유권 확인 first()가 가장 먼저
    // 실행되므로, 소유자 일치({id:7})를 큐 맨 앞에 둔다. 예전 픽스처는 이 항목이 없어
    // 소유권 확인이 null→403으로 막혀 잡 자체가 생성되지 않았다 (2026-10-30 교정).
    db.firstQueue.push({ id: 7 }) // 관문 79: artifact 소유권 확인 통과
    db.runQueue.push({ meta: { last_row_id: 5, changes: 1 } }) // INSERT job
    db.firstQueue.push({ draft_version_id: 10 }) // B1: draft 조회
    db.allQueue.push([{ file_path: 'index.html', content: '<html>base</html>' }]) // B1: 파일 목록
    db.runQueue.push({ meta: { changes: 1 } }) // B1: UPDATE base_*
    const res = await json('/jobs', 'POST', { kind: 'modify', artifact_id: 7, prompt: '버튼 파란색으로' })
    const j = await res.json()
    expect(res.status).toBe(202)
    expect(j.ok).toBe(true)
    const upd = db.calls.find(c => c.sql.includes('UPDATE artifact_jobs SET base_version_id'))
    expect(upd).toBeDefined()
    expect(upd!.params[0]).toBe(10)
    const snap = JSON.parse(upd!.params[1])
    expect(snap['index.html']).toBe(await sha256hex('<html>base</html>'))
    expect(upd!.params[2]).toBe(5)
  })

  test('create 작업에는 스냅샷 저장 안 함', async () => {
    const { db, json } = makeApp()
    db.runQueue.push({ meta: { last_row_id: 6, changes: 1 } }) // INSERT job
    db.runQueue.push({ meta: { last_row_id: 7, changes: 1 } }) // INSERT artifact
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE job artifact_id
    db.firstQueue.push(null) // dupMsg 없음
    db.runQueue.push({ meta: { changes: 1 } }) // INSERT chat
    const res = await json('/jobs', 'POST', { kind: 'create', prompt: '앱 만들어줘' })
    expect(res.status).toBe(202)
    const upd = db.calls.find(c => c.sql.includes('base_version_id'))
    expect(upd).toBeUndefined()
  })
})

// ============================================================
// B5: saveJobResult 병합 + 버전 분기
// ============================================================
describe('B5: saveJobResult 병합/분기', () => {
  const BASE_HTML = '<!DOCTYPE html><html><body><button>빨강</button></body></html>'
  const AGENT_HTML = '<!DOCTYPE html><html><body><button>파랑</button></body></html>'
  const USER_HTML = '<!DOCTYPE html><html><body><button>초록</button></body></html>'

  function b5Db(opts: {
    job: any
    currentFiles: Record<string, string>
    draftVersionId?: number | null
    existingVer?: any
    maxV?: number
  }) {
    const events: any[] = []
    const inserts: any[] = []
    const calls: any[] = []
    const db = {
      calls,
      prepare(sql: string) {
        const n = sql.replace(/\s+/g, ' ').trim()
        return {
          bind(...params: any[]) {
            calls.push({ sql: n, params })
            return {
              first: async () => {
                if (n.includes('SELECT * FROM artifact_jobs WHERE id=?')) return opts.job
                if (n.includes('SELECT draft_version_id, row_revision FROM artifacts')) {
                  return { draft_version_id: opts.draftVersionId ?? 11, row_revision: 3 }
                }
                if (n.includes('SELECT html_content FROM artifact_versions WHERE id=?')) {
                  return { html_content: BASE_HTML }
                }
                if (n.includes('SELECT MAX(version_no)')) return { m: opts.maxV ?? 2 }
                if (n.includes('artifact_versions WHERE artifact_id=? AND content_sha256=?')) {
                  return opts.existingVer ?? null
                }
                if (n.includes('SELECT published_version_id FROM artifacts')) return { published_version_id: 0 }
                return null
              },
              all: async () => {
                if (n.includes('SELECT file_path, content FROM artifact_files WHERE version_id=?')) {
                  return { results: Object.entries(opts.currentFiles).map(([file_path, content]) => ({ file_path, content })) }
                }
                if (n.includes('SELECT MAX(version_no)')) return { results: [{ m: opts.maxV ?? 2 }] }
                return { results: [] }
              },
              run: async () => {
                if (n.startsWith('INSERT INTO artifact_versions')) {
                  inserts.push({ sql: n, params })
                  return { meta: { last_row_id: 31, changes: 1 } }
                }
                if (n.includes('INSERT INTO artifact_job_events')) {
                  events.push({ type: params[1], payload: JSON.parse(params[2]) })
                  return { meta: { changes: 1 } }
                }
                return { meta: { changes: 1, last_row_id: 1 } }
              },
            }
          },
        }
      },
      async batch(_s: any[]) { return [] },
    }
    return { db, events, inserts, calls }
  }

  async function b5Snapshot(files: Record<string, string>) {
    const snap: Record<string, string> = {}
    for (const [p, c] of Object.entries(files)) snap[p] = await sha256hex(c)
    return JSON.stringify(snap)
  }

  test('충돌 없음 → 정상 버전, parent_version_id=base', async () => {
    const snap = await b5Snapshot({ 'index.html': BASE_HTML })
    const { db, inserts, events } = b5Db({
      job: { id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00', base_version_id: 10, base_snapshot: snap },
      currentFiles: { 'index.html': BASE_HTML },
    })
    const r = await saveJobResult({ DB: db } as any, 1, AGENT_HTML, 't', 'modify', '파란색으로',
      7, { agentFiles: { 'index.html': AGENT_HTML } })
    expect(r.versionCreated).toBe(true)
    expect(r.conflicts).toEqual([])
    expect(r.branched).toBe(false)
    expect(r.mergedFiles!['index.html']).toBe(AGENT_HTML)
    // parent_version_id가 base_version_id로 기록됨
    const ins = inserts[0]
    expect(ins.params[2]).toBe(10)
    expect(events.some(e => e.type === 'version.branch')).toBe(false)
    expect(events.some(e => e.type === 'version.committed')).toBe(true)
  })

  test('같은 파일 충돌 → version.branch 이벤트 + 에이전트 버전 분기 저장', async () => {
    const snap = await b5Snapshot({ 'index.html': BASE_HTML })
    const { db, events } = b5Db({
      job: { id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00', base_version_id: 10, base_snapshot: snap },
      currentFiles: { 'index.html': USER_HTML }, // 사용자가 초록으로 바꿈
    })
    const r = await saveJobResult({ DB: db } as any, 1, AGENT_HTML, 't', 'modify', '파란색으로',
      7, { agentFiles: { 'index.html': AGENT_HTML } })
    expect(r.versionCreated).toBe(true)
    expect(r.conflicts).toEqual(['index.html'])
    expect(r.branched).toBe(true)
    const branch = events.find(e => e.type === 'version.branch')
    expect(branch).toBeDefined()
    expect(branch.payload.conflicts).toEqual(['index.html'])
    expect(branch.payload.base_version_id).toBe(10)
  })

  test('에이전트가 안 건드린 사용자 파일은 보존됨', async () => {
    const snap = await b5Snapshot({ 'index.html': BASE_HTML })
    const { db } = b5Db({
      job: { id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00', base_version_id: 10, base_snapshot: snap },
      currentFiles: { 'index.html': BASE_HTML, 'notes.txt': '사용자 메모' },
    })
    const r = await saveJobResult({ DB: db } as any, 1, AGENT_HTML, 't', 'modify', '파란색으로',
      7, { agentFiles: { 'index.html': AGENT_HTML } })
    expect(r.mergedFiles!['notes.txt']).toBe('사용자 메모')
    expect(r.mergedFiles!['index.html']).toBe(AGENT_HTML)
  })

  test('에이전트가 삭제한 파일은 병합에서 제거', async () => {
    const snap = await b5Snapshot({ 'index.html': BASE_HTML, 'old.js': 'console.log(1)' })
    const { db } = b5Db({
      job: { id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00', base_version_id: 10, base_snapshot: snap },
      currentFiles: { 'index.html': BASE_HTML, 'old.js': 'console.log(1)' },
    })
    const r = await saveJobResult({ DB: db } as any, 1, AGENT_HTML, 't', 'modify', '파란색으로',
      7, { agentFiles: { 'index.html': AGENT_HTML } }) // old.js 없음 = 삭제
    expect(r.mergedFiles!['old.js']).toBeUndefined()
  })

  test('파일 행 없으면 html_content에서 합성 (구버전/수동 편집)', async () => {
    const snap = await b5Snapshot({ 'index.html': BASE_HTML })
    const { db } = b5Db({
      job: { id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00', base_version_id: 10, base_snapshot: snap },
      currentFiles: {}, // 파일 행 없음 → html_content 폴백
    })
    const r = await saveJobResult({ DB: db } as any, 1, AGENT_HTML, 't', 'modify', '파란색으로',
      7, { agentFiles: { 'index.html': AGENT_HTML } })
    expect(r.versionCreated).toBe(true)
    // 합성된 index.html(BASE_HTML) 위에 에이전트 수정이 덮어씌워짐
    expect(r.mergedFiles!['index.html']).toBe(AGENT_HTML)
  })

  test('스냅샷 없는 구버전 Job → CONCURRENT_MODIFY 유지 (관문 43 폴백)', async () => {    const { db } = b5Db({
      job: { id: 1, artifact_id: 7, lease_token: 't', created_at: '2026-10-17 10:00:00' },
      currentFiles: { 'index.html': BASE_HTML },
    })
    // concurrent 체크: created_at > job.created_at → 버전 있음
    const db2 = {
      ...db,
      prepare(sql: string) {
        const inner = (db.prepare as any)(sql)
        return {
          bind(...params: any[]) {
            const b = inner.bind(...params)
            const origFirst = b.first
            b.first = async () => {
              const n = sql.replace(/\s+/g, ' ').trim()
              if (n.includes('artifact_versions WHERE artifact_id=? AND created_at > ?')) return { id: 99 }
              return origFirst()
            }
            return b
          },
        }
      },
    }
    await expect(saveJobResult({ DB: db2 } as any, 1, AGENT_HTML, 't', 'modify', '파란색으로', 7))
      .rejects.toThrow('CONCURRENT_MODIFY')
  })
})

// ============================================================
// B3: POST /:id/versions/files
// ============================================================
describe('B3: POST /:id/versions/files', () => {
  test('파일 단위 저장 → 새 버전 + 파일 병합', async () => {
    const { db, json } = makeApp()
    db.firstQueue.push({ id: 7, row_revision: 3, draft_version_id: 11 }) // 소유권 ok
    db.allQueue.push([{ file_path: 'index.html', content: '<html>old</html>' }]) // 현재 파일
    db.firstQueue.push({ max_no: 2 }) // MAX(version_no)
    db.runQueue.push({ meta: { last_row_id: 31, changes: 1 } }) // INSERT version
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE artifacts
    const res = await json('/7/versions/files', 'POST', {
      files: { 'index.html': '<!DOCTYPE html><html><body>new</body></html>' },
      change_note: '테스트',
    })
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.data.version_no).toBe(3)
  })

  test('소유권 없음 → 403', async () => {
    const { json } = makeApp({ userEmail: 'other@example.com' })
    // MockDb 기본: first() → null (firstQueue 비어있음)
    const res = await json('/7/versions/files', 'POST', { files: { 'a.html': 'x' } })
    expect(res.status).toBe(403)
  })

  test('잘못된 경로 → 400', async () => {
    const { db, json } = makeApp()
    db.firstQueue.push({ id: 7, row_revision: 3, draft_version_id: 11 })
    const res = await json('/7/versions/files', 'POST', { files: { '../evil': 'x' } })
    expect(res.status).toBe(400)
  })

  test('files 비어있음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/9/versions/files', 'POST', { files: {} })
    expect(res.status).toBe(400)
  })
})

// ============================================================
// B4: GET /:id/active-job
// ============================================================
describe('B4: GET /:id/active-job', () => {
  test('진행 중 작업 있음 → job 정보 반환', async () => {
    const { db, json } = makeApp()
    db.firstQueue.push({ id: 7 }) // 소유권 ok
    db.firstQueue.push({ id: 3, kind: 'modify', status: 'running' })
    const res = await json('/7/active-job', 'GET')
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.data.job_id).toBe(3)
    expect(j.data.status).toBe('running')
  })

  test('진행 중 작업 없음 → null', async () => {
    const { db, json } = makeApp()
    db.firstQueue.push({ id: 7 })
    db.firstQueue.push(null)
    const res = await json('/7/active-job', 'GET')
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.data).toBeNull()
  })

  test('소유권 없음 → 403', async () => {
    const { json } = makeApp({ userEmail: 'other@example.com' })
    const res = await json('/7/active-job', 'GET')
    expect(res.status).toBe(403)
  })
})

// ============================================================
// 보안: POST /:id/versions 소유권 체크
// ============================================================
describe('보안: POST /:id/versions 소유권', () => {
  test('타인 아티팩트 → 403', async () => {
    const { json } = makeApp({ userEmail: 'other@example.com' })
    const res = await json('/7/versions', 'POST', { html_content: '<html>x</html>' })
    expect(res.status).toBe(403)
    const j = await res.json()
    expect(j.ok).toBe(false)
  })
})
