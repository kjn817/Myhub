/**
 * AI 스튜디오 잡 저장 경로 실DB 검증 (트랙 5, 2026-11-01)
 *
 * better-sqlite3 인메모리 DB에 실제 마이그레이션을 적용하고
 * processArtifactJob을 실제 SQL로 실행한다 (mock DB의 SQL 패턴매칭으로는
 * 잡을 수 없는 저장 누락·lease 형식 불일치를 잡는 것이 목적).
 *
 * 검증 대상:
 *  T1. 사전 연결된 artifact_id를 가진 create 잡 — POST /jobs가 프로젝트=대화
 *      모델로 artifact를 먼저 만들고 job에 연결한다 (routes.ts). 이 경우에도
 *      v1 버전과 artifact_files가 생성돼야 한다.
 *  T2. lease가 만료된 running 잡의 재획득 — lease_expires에 ISO 문자열이
 *      저장된 기존 행도, 만료됐으면 다시 claim할 수 있어야 한다.
 *  T3. modify 정상 경로 (회귀 가드) — 새 버전 생성 + 파일 저장.
 *  T4. modify 무변경 — 에이전트 결과가 기존 내용과 동일하면 가짜 성공(done)으로
 *      끝내지 않고, 변경이 없었다는 사실을 실패 사유로 정직하게 남겨야 한다.
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { processArtifactJob } from '../../src/modules/artifact/job-processor'
import { runStudioAgent } from '../../src/services/studio-agent'

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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const MIGRATIONS = [
  '0032_artifacts.sql',
  '0033_artifact_status.sql',
  '0034_artifact_versions.sql',
  '0035_artifact_files.sql',
  '0035_artifact_jobs.sql',
  '0036_artifact_chats.sql',
  '0038_artifact_job_events.sql',
  '0039_artifact_jobs_indexes.sql',
  '0040_artifact_jobs_pending_state.sql',
  '0041_artifact_jobs_base_snapshot.sql',
  '0058_artifacts_owner_email.sql',
]

const OLD_HTML = '<!DOCTYPE html><html><head><title>t</title></head><body><button style="color:red">hi</button></body></html>'
const NEW_HTML = '<!DOCTYPE html><html><head><title>t</title></head><body><button style="color:blue">hi</button></body></html>'

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function freshDb() {
  const d1 = createLocalD1()
  const migDir = path.join(__dirname, '..', '..', 'migrations')
  for (const f of MIGRATIONS) {
    d1.exec(fs.readFileSync(path.join(migDir, f), 'utf-8'))
  }
  // job.model이 있으면 ai_settings를 조회하지 않지만, 안전하게 테이블만 둔다
  d1.exec(`CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT)`)
  return d1
}

function raw(d1: any, sql: string, ...params: any[]) {
  return d1._db.prepare(sql).get(...params)
}
function rawAll(d1: any, sql: string, ...params: any[]) {
  return d1._db.prepare(sql).all(...params)
}

const mkEnv = (d1: any) => ({ DB: d1, GEMINI_API_KEY_1: 'k' }) as any

function agentOk(files: Record<string, string>) {
  return { ok: true, files, turns: 2, summary: '완료', toolCalls: ['edit_file(path=index.html, ok=true)'] }
}

beforeEach(() => {
  mockRunStudioAgent.mockReset()
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('스튜디오 잡 저장 경로 (실DB)', () => {
  test('T1: 사전 연결된 artifact_id create 잡도 v1 버전+파일을 만든다', async () => {
    const d1 = freshDb()
    // routes.ts POST /jobs와 동일: 프로젝트(artifact)를 먼저 만들고 job에 연결
    const art = d1._db.prepare(
      `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email)
       VALUES ('계산기', 'chat', 'draft', '', 1, '', 'owner@test')`
    ).run()
    const artId = Number(art.lastInsertRowid)
    const job = d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, provider, model)
       VALUES ('create', ?, '계산기 앱 만들어줘', 'pending', 'owner@test', 'gemini', 'gemini-3.5-flash-lite')`
    ).run(artId)
    const jobId = Number(job.lastInsertRowid)

    mockRunStudioAgent.mockResolvedValue(agentOk({ 'index.html': OLD_HTML }))
    const outcome = await processArtifactJob(mkEnv(d1), jobId)

    expect(outcome).toBe('done')
    const versions = rawAll(d1, 'SELECT * FROM artifact_versions WHERE artifact_id=?', artId)
    expect(versions).toHaveLength(1)
    expect(versions[0].version_no).toBe(1)
    const artRow = raw(d1, 'SELECT draft_version_id FROM artifacts WHERE id=?', artId)
    expect(artRow.draft_version_id).toBe(versions[0].id)
    const files = rawAll(d1, 'SELECT * FROM artifact_files WHERE version_id=?', versions[0].id)
    expect(files).toHaveLength(1)
    expect(files[0].file_path).toBe('index.html')
    d1.close()
  })

  test('T2: ISO 형식 lease_expires가 만료된 running 잡을 재획득한다', async () => {
    const d1 = freshDb()
    const art = d1._db.prepare(
      `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email)
       VALUES ('앱', 'html', 'draft', '', 1, '', 'owner@test')`
    ).run()
    const artId = Number(art.lastInsertRowid)
    // 10분 전에 만료된 ISO lease (구 processArtifactJob이 쓰던 형식)
    const expiredIso = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const job = d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, provider, model, lease_token, lease_expires, attempts)
       VALUES ('modify', ?, '버튼 파랗게', 'running', 'owner@test', 'gemini', 'gemini-3.5-flash-lite', 'old-token', ?, 1)`
    ).run(artId, expiredIso)
    const jobId = Number(job.lastInsertRowid)
    // modify 프리로드용 v1
    const ver = d1._db.prepare(
      `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type)
       VALUES (?, 1, ?, ?, 'v1', 'nova')`
    ).run(artId, OLD_HTML, await sha256(OLD_HTML))
    d1._db.prepare('UPDATE artifacts SET draft_version_id=? WHERE id=?').run(Number(ver.lastInsertRowid), artId)
    d1._db.prepare(
      `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size) VALUES (?, 'index.html', ?, ?, ?)`
    ).run(Number(ver.lastInsertRowid), OLD_HTML, await sha256(OLD_HTML), OLD_HTML.length)
    // base 스냅샷 (routes가 modify 생성 시 저장)
    d1._db.prepare('UPDATE artifact_jobs SET base_version_id=?, base_snapshot=? WHERE id=?')
      .run(Number(ver.lastInsertRowid), JSON.stringify({ 'index.html': await sha256(OLD_HTML) }), jobId)

    mockRunStudioAgent.mockResolvedValue(agentOk({ 'index.html': NEW_HTML }))
    const outcome = await processArtifactJob(mkEnv(d1), jobId)

    expect(outcome).toBe('done') // busy로 버려지면 실패 (잡이 영구 running에 갇힘)
    const jobRow = raw(d1, 'SELECT status, attempts FROM artifact_jobs WHERE id=?', jobId)
    expect(jobRow.status).toBe('done')
    expect(jobRow.attempts).toBe(2)
    d1.close()
  })

  test('T3: modify 정상 경로 — v2 생성 + 파일 저장 (회귀 가드)', async () => {
    const d1 = freshDb()
    const art = d1._db.prepare(
      `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email)
       VALUES ('앱', 'html', 'draft', '', 1, '', 'owner@test')`
    ).run()
    const artId = Number(art.lastInsertRowid)
    const ver = d1._db.prepare(
      `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type)
       VALUES (?, 1, ?, ?, 'v1', 'nova')`
    ).run(artId, OLD_HTML, await sha256(OLD_HTML))
    const v1Id = Number(ver.lastInsertRowid)
    d1._db.prepare('UPDATE artifacts SET draft_version_id=? WHERE id=?').run(v1Id, artId)
    d1._db.prepare(
      `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size) VALUES (?, 'index.html', ?, ?, ?)`
    ).run(v1Id, OLD_HTML, await sha256(OLD_HTML), OLD_HTML.length)
    const job = d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, provider, model, base_version_id, base_snapshot)
       VALUES ('modify', ?, '버튼 파랗게 바꿔줘', 'pending', 'owner@test', 'gemini', 'gemini-3.5-flash-lite', ?, ?)`
    ).run(artId, v1Id, JSON.stringify({ 'index.html': await sha256(OLD_HTML) }))
    const jobId = Number(job.lastInsertRowid)

    mockRunStudioAgent.mockResolvedValue(agentOk({ 'index.html': NEW_HTML }))
    const outcome = await processArtifactJob(mkEnv(d1), jobId)

    expect(outcome).toBe('done')
    const versions = rawAll(d1, 'SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version_no', artId)
    expect(versions).toHaveLength(2)
    expect(versions[1].version_no).toBe(2)
    expect(versions[1].html_content).toBe(NEW_HTML)
    const files = rawAll(d1, 'SELECT * FROM artifact_files WHERE version_id=?', versions[1].id)
    expect(files).toHaveLength(1)
    expect(files[0].content).toBe(NEW_HTML)
    d1.close()
  })

  test('T4: modify 무변경 — 가짜 성공이 아니라 무변경으로 실패 기록', async () => {
    const d1 = freshDb()
    const art = d1._db.prepare(
      `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email)
       VALUES ('앱', 'html', 'draft', '', 1, '', 'owner@test')`
    ).run()
    const artId = Number(art.lastInsertRowid)
    const ver = d1._db.prepare(
      `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type)
       VALUES (?, 1, ?, ?, 'v1', 'nova')`
    ).run(artId, OLD_HTML, await sha256(OLD_HTML))
    const v1Id = Number(ver.lastInsertRowid)
    d1._db.prepare('UPDATE artifacts SET draft_version_id=? WHERE id=?').run(v1Id, artId)
    d1._db.prepare(
      `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size) VALUES (?, 'index.html', ?, ?, ?)`
    ).run(v1Id, OLD_HTML, await sha256(OLD_HTML), OLD_HTML.length)
    const job = d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, provider, model, base_version_id, base_snapshot)
       VALUES ('modify', ?, '버튼 파랗게 바꿔줘', 'pending', 'owner@test', 'gemini', 'gemini-3.5-flash-lite', ?, ?)`
    ).run(artId, v1Id, JSON.stringify({ 'index.html': await sha256(OLD_HTML) }))
    const jobId = Number(job.lastInsertRowid)

    // 에이전트가 아무것도 바꾸지 않은 파일을 그대로 반환 (도구 미호출/동일 재작성)
    mockRunStudioAgent.mockResolvedValue(agentOk({ 'index.html': OLD_HTML }))
    const outcome = await processArtifactJob(mkEnv(d1), jobId)

    // 버전이 안 생기는 것 자체는 중복 방지 정책이라 유지하되,
    // 잡은 성공으로 위장하지 말고 무변경 사유를 남겨야 한다
    const versions = rawAll(d1, 'SELECT * FROM artifact_versions WHERE artifact_id=?', artId)
    expect(versions).toHaveLength(1)
    expect(outcome).toBe('failed')
    const jobRow = raw(d1, 'SELECT status, error FROM artifact_jobs WHERE id=?', jobId)
    expect(jobRow.status).toBe('failed')
    expect(jobRow.error).toContain('변경 사항이 없')
    d1.close()
  })
})
