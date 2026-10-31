/**
 * D1 마이그레이션 + 실런타임 SQLite 의미 테스트 (트랙 C7, 2-7절).
 *
 * Jest의 fake-d1 mock이 검증하지 못하는 것 — 실제 SQLite(D1 로컬)에서의
 * 동작을 확인한다:
 * - `migrations/*.sql` 전부가 순서대로 적용되는지 (운영 D1 적용 절차와
 *   같은 파일, 같은 순서 — 운영 DB에는 닿지 않는다)
 * - 핵심 테이블·인덱스가 실제로 만들어지는지
 * - 2026-10-13 FTS5 결함의 재발 방지: 메모 DELETE가 D1에서 SQLITE_ERROR를
 *   내던 content= 외부 콘텐츠 테이블이 아니라, 일반 FTS5 + 트리거
 *   (`DELETE ... WHERE rowid = ?`) 구조에서 삭제가 정상 동작하는지
 * - 0051 원자 카운터: `UPDATE ... RETURNING` 기반 bumpSessionVersion이
 *   실제 D1에서 원자적으로 증가하는지 (KV race 대체 경로)
 * - 0039 회귀 (2026-10-27 수정): artifact_jobs 컬럼·인덱스가 실제로
 *   만들어지고 AI 스튜디오 작업 생성 INSERT가 동작하는지. 수정 전에는
 *   여기서 'no such column: owner_email'으로 체인이 멈췄음 — 이 테스트가
 *   그 결함을 핀으로 박아두던 것을 회귀 테스트로 바꾼 것이다.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyAllMigrations, migrationFileNames, testDb, type MigrationResult } from './helpers/apply-migrations'
import { bumpSessionVersion, getSessionVersion } from '../../src/modules/auth/routes'

const CORE_TABLES = [
  'memos',
  'memos_fts',
  'files',
  'otp_codes',
  'ai_usage',
  'auth_pins',
  'session_versions',
  'rate_limits',
  'tool_approval_requests',
  'memory_consolidation_log',
  'artifact_jobs',
]

describe('D1 migrations (miniflare)', () => {
  let result: MigrationResult = { applied: [], failed: [] }

  beforeAll(async () => {
    result = await applyAllMigrations()
  })

  it('마이그레이션 파일이 전부 적용된다 (실패 0건)', async () => {
    // 2026-10-27: 0039 결함 수정으로 실패 핀을 제거함. 실패가 1건이라도
    // 있으면 이 테스트가 잡는다 — "알려진 결함"으로 핀을 박아두지 말 것.
    // 2026-10-27: 마지막 마이그레이션 하드코딩(0057)을 제거 — 디렉토리에서
    // 읽은 마지막 파일을 동적으로 기대한다 (0059가 와도 안 깨지게).
    // 의도는 그대로: 체인이 디스크의 마지막 파일까지 끝까지 적용되는지.
    const files = migrationFileNames()
    expect(result.failed).toHaveLength(0)
    expect(result.applied.length).toBe(files.length)
    expect(result.applied[0]).toBe(files[0])
    expect(result.applied[result.applied.length - 1]).toBe(files[files.length - 1])
  })

  it('0039 회귀: artifact_jobs 컬럼·인덱스가 실제로 만들어진다 (2026-10-27)', async () => {
    const db = testDb()
    // 컬럼 4개 (0039 수정 전에는 어떤 마이그레이션도 추가하지 않았음)
    const cols = await db
      .prepare("SELECT name FROM pragma_table_info('artifact_jobs')")
      .all<{ name: string }>()
    const names = new Set((cols.results || []).map((r) => r.name))
    for (const c of ['owner_email', 'client_request_id', 'provider', 'model']) {
      expect(names.has(c)).toBe(true)
    }
    // 인덱스 3개 (운영 D1과 동일)
    for (const idx of ['uq_jobs_client_req', 'idx_artifact_jobs_idempotency', 'idx_artifact_jobs_artifact']) {
      const row = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .bind(idx)
        .first<{ name: string }>()
      expect(row?.name).toBe(idx)
    }
    // 실제 작업 생성 INSERT (src/modules/artifact/routes.ts:684와 동일 컬럼)
    const inserted = await db
      .prepare(
        "INSERT INTO artifact_jobs (kind, artifact_id, prompt, base_html, status, owner_email, client_request_id, provider, model) " +
          "VALUES ('create', NULL, 'runtime 0039 회귀', NULL, 'pending', 'runtime-test@myhub.local', 'req-runtime-0039', 'gemini', 'gemini-3.5-flash-lite') RETURNING id",
      )
      .first<{ id: number }>()
    expect(inserted?.id).toBeGreaterThan(0)
    // 멱등성 SELECT가 기존 job을 반환한다
    const found = await db
      .prepare('SELECT id, status FROM artifact_jobs WHERE owner_email = ? AND client_request_id = ?')
      .bind('runtime-test@myhub.local', 'req-runtime-0039')
      .first<{ id: number; status: string }>()
    expect(found?.id).toBe(inserted!.id)
    expect(found?.status).toBe('pending')
    // 같은 키 중복 INSERT는 유니크 인덱스가 거부한다
    let rejected = false
    try {
      await db
        .prepare(
          "INSERT INTO artifact_jobs (kind, prompt, status, owner_email, client_request_id) " +
            "VALUES ('create', '중복', 'pending', 'runtime-test@myhub.local', 'req-runtime-0039')",
        )
        .run()
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    // client_request_id가 NULL이면 부분 인덱스라 2건도 들어간다
    await db
      .prepare("INSERT INTO artifact_jobs (kind, prompt, status, owner_email, client_request_id) VALUES ('create', 'n1', 'pending', 'runtime-test@myhub.local', NULL)")
      .run()
    await db
      .prepare("INSERT INTO artifact_jobs (kind, prompt, status, owner_email, client_request_id) VALUES ('create', 'n2', 'pending', 'runtime-test@myhub.local', NULL)")
      .run()
  })

  it('핵심 테이블이 실제로 만들어진다', async () => {
    const db = testDb()
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()
    const names = new Set((rows.results || []).map((r) => r.name))
    for (const t of CORE_TABLES) {
      expect(names.has(t)).toBe(true)
    }
  })

  it('0065: ai_usage에 engine·persona 컬럼이 있고 귀속 라운드트립이 동작한다', async () => {
    const db = testDb()
    const cols = await db
      .prepare("SELECT name FROM pragma_table_info('ai_usage')")
      .all<{ name: string }>()
    const names = new Set((cols.results || []).map((r) => r.name))
    expect(names.has('engine')).toBe(true)
    expect(names.has('persona')).toBe(true)
    // 귀속 있는 행: 기록한 engine·persona가 그대로 읽힌다
    await db
      .prepare(
        "INSERT INTO ai_usage (provider, model, capability, latency_ms, outcome, engine, persona, created_at) VALUES ('workers-ai', 'm-attribution', 'summarize', 12, 'success', 'builtin-fc', 'keeper', datetime('now'))",
      )
      .run()
    const tagged = await db
      .prepare("SELECT engine, persona FROM ai_usage WHERE model = 'm-attribution'")
      .first<{ engine: string; persona: string }>()
    expect(tagged?.engine).toBe('builtin-fc')
    expect(tagged?.persona).toBe('keeper')
    // 귀속 없는 행(기존 행·비서 맥락 없는 호출)은 NULL=unknown으로 남는다
    await db
      .prepare(
        "INSERT INTO ai_usage (provider, model, capability, latency_ms, outcome, created_at) VALUES ('gemini', 'm-legacy', 'chat', 7, 'success', datetime('now'))",
      )
      .run()
    const legacy = await db
      .prepare('SELECT engine, persona FROM ai_usage WHERE model = \'m-legacy\'')
      .first<{ engine: string | null; persona: string | null }>()
    expect(legacy?.engine).toBeNull()
    expect(legacy?.persona).toBeNull()
  })

  it('메모 INSERT → SELECT 라운드트립이 실제 D1에서 동작한다', async () => {
    const db = testDb()
    const inserted = await db
      .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, 0, 1) RETURNING id')
      .bind('miniflare 라운드트립 메모')
      .first<{ id: number }>()
    expect(inserted?.id).toBeGreaterThan(0)
    const row = await db
      .prepare('SELECT text, is_locked FROM memos WHERE id = ?')
      .bind(inserted!.id)
      .first<{ text: string; is_locked: number }>()
    expect(row?.text).toBe('miniflare 라운드트립 메모')
    expect(row?.is_locked).toBe(0)
  })

  it('FTS5: 메모 삭제가 인덱스를 깨뜨리지 않고 정리한다 (0030 재발 방지)', async () => {
    const db = testDb()
    // ASCII 전용 마커 — FTS5 unicode61 토크나이저 경계 조건을 피한다.
    const marker = 'zzftsdeletecheck'
    const inserted = await db
      .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, 0, 1) RETURNING id')
      .bind(`FTS 삭제 검증 ${marker}`)
      .first<{ id: number }>()
    const id = inserted!.id
    // 트리거가 FTS 인덱스에 넣었는지 확인
    const before = await db
      .prepare('SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?')
      .bind(marker)
      .first<{ rowid: number }>()
    expect(before?.rowid).toBe(id)
    // 구 content= 테이블에서는 이 DELETE가 SQLITE_ERROR/CORRUPT를 냈다.
    // 일반 FTS5 + DELETE ... WHERE rowid = ? 트리거에서는 정상 동작해야 한다.
    await db.prepare('DELETE FROM memos WHERE id = ?').bind(id).run()
    const gone = await db
      .prepare('SELECT text FROM memos WHERE id = ?')
      .bind(id)
      .first<{ text: string }>()
    expect(gone).toBeNull()
    const after = await db
      .prepare('SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?')
      .bind(marker)
      .first<{ rowid: number }>()
    expect(after).toBeNull()
  })

  it('잠긴 메모는 FTS 인덱스에 들어가지 않는다 (0030 의도)', async () => {
    const db = testDb()
    const marker = 'zzftslockedcheck'
    const inserted = await db
      .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, 1, 1) RETURNING id')
      .bind(`잠긴 메모 ${marker}`)
      .first<{ id: number }>()
    const hit = await db
      .prepare('SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?')
      .bind(marker)
      .first<{ rowid: number }>()
    expect(hit).toBeNull()
    await db.prepare('DELETE FROM memos WHERE id = ?').bind(inserted!.id).run()
  })

  it('FTS5: ai_memory_v2 UPDATE가 인덱스를 깨뜨리지 않는다 (0028 결함·0044 수정 실증)', async () => {
    const db = testDb()
    // 0028은 content='ai_memory_v2' 외부 콘텐츠 + 'delete' 특수 명령 구조라
    // 실제 D1에서 UPDATE 시 SQLITE_ERROR를 냈다 (memos 0030 결함과 동일 부류,
    // 2026-10-13 운영 실측). 0044가 0030과 같은 방식(일반 FTS5 +
    // DELETE ... WHERE rowid = ?)으로 이미 교체했는지 구조부터 확인한다.
    // 한계 (2026-10-28 실증): 로컬 miniflare는 구 구조에서도 UPDATE/DELETE가
    // 성공한다 — 알려진 결함 구조(0002+0026 메모) 대조 실험에서도 에러가
    // 안 났다. 즉 miniflare는 원본 D1 결함을 재현하지 못하므로, 이 테스트는
    // 0044 구조 고정 + 기능 동작을 핀으로 박는 회귀 테스트이며, 실제 D1
    // 실패 자체의 재현은 아니다.
    const ddl = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_memory_fts'")
      .first<{ sql: string }>()
    expect(ddl?.sql).toContain('fts5(content)')
    expect(ddl?.sql).not.toContain("content='ai_memory_v2'")
    // 활성 행 INSERT → 인덱싱 확인
    const markerOld = 'zzmemupdateold'
    const markerNew = 'zzmemupdatenew'
    const inserted = await db
      .prepare('INSERT INTO ai_memory_v2 (content) VALUES (?) RETURNING id')
      .bind(`기억 원문 ${markerOld}`)
      .first<{ id: number }>()
    const id = inserted!.id
    const before = await db
      .prepare('SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH ?')
      .bind(markerOld)
      .first<{ rowid: number }>()
    expect(before?.rowid).toBe(id)
    // 활성 행 UPDATE — 구 0028 트리거에서는 'delete' 특수 명령이 D1에서
    // SQLITE_ERROR를 냈다. touchMemories/supersede/restoreMemory가 모두
    // 이 경로를 탄다 (memory-service.ts).
    await db
      .prepare('UPDATE ai_memory_v2 SET content = ? WHERE id = ?')
      .bind(`기억 수정 ${markerNew}`, id)
      .run()
    const goneOld = await db
      .prepare('SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH ?')
      .bind(markerOld)
      .first<{ rowid: number }>()
    expect(goneOld).toBeNull()
    const hitNew = await db
      .prepare('SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH ?')
      .bind(markerNew)
      .first<{ rowid: number }>()
    expect(hitNew?.rowid).toBe(id)
    // supersede 경로: is_active=0 UPDATE도 정상이고 인덱스에서 빠진다.
    await db.prepare('UPDATE ai_memory_v2 SET is_active = 0 WHERE id = ?').bind(id).run()
    const goneNew = await db
      .prepare('SELECT rowid FROM ai_memory_fts WHERE ai_memory_fts MATCH ?')
      .bind(markerNew)
      .first<{ rowid: number }>()
    expect(goneNew).toBeNull()
    // DELETE도 정상 동작한다.
    await db.prepare('DELETE FROM ai_memory_v2 WHERE id = ?').bind(id).run()
    const goneRow = await db
      .prepare('SELECT content FROM ai_memory_v2 WHERE id = ?')
      .bind(id)
      .first<{ content: string }>()
    expect(goneRow).toBeNull()
  })

  it('0051 원자 카운터: bumpSessionVersion이 실제 D1에서 1씩 증가한다', async () => {
    const db = testDb()
    const email = 'runtime-test@myhub.local'
    expect(await getSessionVersion({ DB: db }, email)).toBe(0)
    expect(await bumpSessionVersion({ DB: db }, email)).toBe(1)
    expect(await bumpSessionVersion({ DB: db }, email)).toBe(2)
    expect(await getSessionVersion({ DB: db }, email)).toBe(2)
  })
})
