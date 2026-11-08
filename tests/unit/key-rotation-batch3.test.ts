/// <reference types="jest" />
/**
 * src/services/key-rotation.ts 성질 테스트 (3차 배치 — 실제 SQLite).
 * key-rotation.test.ts와 겹치지 않는 영역: 키 재료 결측 게이트, 센서스의
 * 손상/비배열/평문 행 처리, preflight의 종류별 실패 집계(파일 다운로드·
 * 블록), 단일 토큰만 암호화된 Google 행의 회전, 혼합 상태 블록 그룹의
 * 부분 회전, 구 객체 파괴 실패 시 경고, 파일 CAS 충돌 시 새 객체 정리.
 * 카나리아: classifyText의 목표 키 폴백을 지우면 혼합 블록 단언이,
 * CAS 충돌 시 destroy 정리를 지우면 정리 호출 단언이 실패한다.
 */
import { createTestDb } from '../mcp-d1'
import { encryptContent, decryptContentWithKey } from '../../src/services/crypto'
import { rotateEncryptionKey, computeRotationCensus, type RotationDeps } from '../../src/services/key-rotation'
import { encryptBytes } from '../../src/services/crypto'

const OLD_KEY = 'batch3-old-key-material-01'
const NEW_KEY = 'batch3-new-key-material-02'
const THIRD_KEY = 'batch3-third-key-material-03'

function makeObjectStore() {
  const store = new Map<string, ArrayBuffer>()
  let seq = 0
  const deps: RotationDeps & { store: Map<string, ArrayBuffer>; destroyed: string[] } = {
    store,
    destroyed: [] as string[],
    fetchFn: (async (url: any) => {
      const bytes = store.get(String(url))
      if (!bytes) return new Response('not found', { status: 404 })
      return new Response(bytes, { status: 200 })
    }) as any,
    upload: (async (_env: any, file: File) => {
      seq++
      const publicId = `myhub/memo-encrypted/b3obj${seq}`
      const url = `https://files.test/${publicId}`
      store.set(url, await file.arrayBuffer())
      return { public_id: publicId, secure_url: url, resource_type: 'raw', bytes: 0 }
    }) as any,
    destroy: (async (_env: any, publicId: string) => {
      deps.destroyed.push(publicId)
      return true
    }) as any,
  }
  return deps
}

describe('키 재료 게이트', () => {
  test('현재 키가 없으면 current_key_not_configured로 중단한다', async () => {
    const { d1 } = createTestDb()
    const report = await rotateEncryptionKey({ DB: d1 } as any, { mode: 'rotate', targetKeyMaterial: NEW_KEY, dryRun: true }, makeObjectStore())
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.stage).toBe('preflight')
      expect(report.error).toBe('current_key_not_configured')
    }
  })

  test('rotate에 새 키가 없거나 rollback에 출발 키가 없으면 key_material_missing이다', async () => {
    const { d1 } = createTestDb()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const r1 = await rotateEncryptionKey(env, { mode: 'rotate', dryRun: true }, makeObjectStore())
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe('key_material_missing')
    const r2 = await rotateEncryptionKey(env, { mode: 'rollback', dryRun: true }, makeObjectStore())
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe('key_material_missing')
  })
})

describe('computeRotationCensus — 손상·평문 행 처리', () => {
  test('깨진 JSON·비배열·비문자열 encrypted는 세지 않고, 평문 토큰 행도 세지 않는다', async () => {
    const { db, d1 } = createTestDb()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const encText = await encryptContent(env, '암호 본문')
    const encBlock = await encryptContent(env, '블록 비밀')
    db.prepare("INSERT INTO memos (id, text, locked_blocks) VALUES (1, '공개 본문', '깨진 json')").run()
    db.prepare("INSERT INTO memos (id, text, locked_blocks) VALUES (2, ?, ?)").run(encText, '{"not":"array"}')
    db.prepare("INSERT INTO memos (id, text, locked_blocks) VALUES (3, '공개', ?)")
      .run(JSON.stringify([null, { encrypted: 123 }, { encrypted: '평문' }, { id: 'b1', encrypted: encBlock }]))
    db.prepare("INSERT INTO google_integrations (provider, email, access_token, refresh_token, scope, expires_at, status) VALUES ('google', 'a@x', 'plain-access', 'plain-refresh', 's', 0, 'active')").run()
    const census = await computeRotationCensus(env)
    expect(census).toEqual({ memo_text: 1, memo_block: 1, google_token_row: 0, locked_file: 0 })
  })

  test('빈 DB의 센서스는 전부 0이다', async () => {
    const { d1 } = createTestDb()
    const census = await computeRotationCensus({ DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY } as any)
    expect(census).toEqual({ memo_text: 0, memo_block: 0, google_token_row: 0, locked_file: 0 })
  })
})

describe('preflight — 종류별 실패 집계와 무해한 행', () => {
  test('파일 다운로드 실패는 locked_file 실패로 집계되고 쓰기는 없다', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    db.prepare("INSERT INTO memos (id, text) VALUES (1, '공개')").run()
    db.prepare("INSERT INTO files (id, memo_id, storage_key, filename, mime, size, url, resource_type, is_locked) VALUES (1, 1, 'k1', 'a.txt', 'text/plain', 3, 'https://files.test/없는객체', 'raw', 1)").run()
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, dryRun: true }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.stage).toBe('preflight')
      expect(report.error).toBe('preflight_decrypt_failed')
      expect(report.failures).toEqual({ locked_file: 1 })
    }
  })

  test('이질 키로 암호화된 블록은 memo_block 실패로 집계된다', async () => {
    const { db, d1 } = createTestDb()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const foreign = await encryptContent({ MEMO_ENCRYPTION_KEY: THIRD_KEY }, '남의 블록')
    db.prepare("INSERT INTO memos (id, text, locked_blocks) VALUES (1, '공개', ?)").run(JSON.stringify([{ id: 'b1', encrypted: foreign }]))
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, dryRun: true }, makeObjectStore())
    expect(report.ok).toBe(false)
    if (!report.ok) expect(report.failures).toEqual({ memo_block: 1 })
  })

  test('평문뿐인 Google 행과 깨진 locked_blocks는 회전을 막지 않는다', async () => {
    const { db, d1 } = createTestDb()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const encText = await encryptContent(env, '본문')
    db.prepare("INSERT INTO memos (id, text, locked_blocks) VALUES (1, ?, '깨진 json')").run(encText)
    db.prepare("INSERT INTO google_integrations (provider, email, access_token, refresh_token, scope, expires_at, status) VALUES ('google', 'a@x', 'plain', 'plain2', 's', 0, 'active')").run()
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, dryRun: true }, makeObjectStore())
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.pending).toEqual({ memo_text: 1, memo_block: 0, google_token_row: 0, locked_file: 0 })
    }
  })
})

describe('쓰기 경로 — 부분 상태와 실패 정리', () => {
  test('Google 행: access만 암호화돼 있으면 그것만 회전하고 평문 refresh는 그대로 둔다', async () => {
    const { db, d1 } = createTestDb()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const encAccess = await encryptContent(env, 'access-secret')
    db.prepare("INSERT INTO google_integrations (provider, email, access_token, refresh_token, scope, expires_at, status) VALUES ('google', 'a@x', ?, 'plain-refresh', 's', 0, 'active')").run(encAccess)
    const census = { memo_text: 0, memo_block: 0, google_token_row: 1, locked_file: 0 }
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: census }, makeObjectStore())
    expect(report.ok).toBe(true)
    const row = db.prepare('SELECT access_token, refresh_token FROM google_integrations').get() as any
    expect(await decryptContentWithKey(NEW_KEY, row.access_token)).toBe('access-secret')
    expect(row.refresh_token).toBe('plain-refresh')
  })

  test('블록 그룹: 이미 새 키인 블록은 건드리지 않고 옛 키 블록만 회전한다', async () => {
    const { db, d1 } = createTestDb()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const encOld = await encryptContent(env, '옛 블록')
    const encNew = await encryptContent({ MEMO_ENCRYPTION_KEY: NEW_KEY }, '새 블록')
    db.prepare("INSERT INTO memos (id, text, locked_blocks) VALUES (1, '공개', ?)")
      .run(JSON.stringify([{ id: 'a', encrypted: encOld }, { id: 'b', encrypted: encNew }]))
    const census = { memo_text: 0, memo_block: 2, google_token_row: 0, locked_file: 0 }
    const dry = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, dryRun: true }, makeObjectStore())
    expect(dry.ok).toBe(true)
    if (dry.ok) {
      expect(dry.pending.memo_block).toBe(1)
      expect(dry.already.memo_block).toBe(1)
    }
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: census }, makeObjectStore())
    expect(report.ok).toBe(true)
    if (report.ok) expect(report.rotated.memo_block).toBe(1)
    const blocks = JSON.parse((db.prepare('SELECT locked_blocks FROM memos WHERE id = 1').get() as any).locked_blocks)
    expect(blocks[1].encrypted).toBe(encNew) // 이미 새 키였던 블록은 바이트 그대로
    expect(await decryptContentWithKey(NEW_KEY, blocks[0].encrypted)).toBe('옛 블록')
    expect(await decryptContentWithKey(NEW_KEY, blocks[1].encrypted)).toBe('새 블록')
  })

  test('구 객체 파괴에 실패하면 경고만 남기고 회전은 성공으로 보고한다', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const encFile = await encryptBytes(env, new TextEncoder().encode('파일 평문').buffer as ArrayBuffer)
    const url = 'https://files.test/myhub/memo-encrypted/seed9'
    deps.store.set(url, encFile)
    db.prepare("INSERT INTO memos (id, text) VALUES (1, '공개')").run()
    db.prepare("INSERT INTO files (id, memo_id, storage_key, filename, mime, size, url, resource_type, is_locked) VALUES (1, 1, 'myhub/memo-encrypted/seed9', 'a.txt', 'text/plain', ?, ?, 'raw', 1)").run(encFile.byteLength, url)
    deps.destroy = (async () => false) as any
    const census = { memo_text: 0, memo_block: 0, google_token_row: 0, locked_file: 1 }
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: census }, deps)
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.rotated.locked_file).toBe(1)
      expect(report.warnings).toEqual(['old_object_destroy_failed:file:1'])
    }
  })

  test('파일 포인터 CAS가 충돌하면 방금 올린 새 객체를 정리하고 write 실패로 보고한다', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    const encFile = await encryptBytes(env, new TextEncoder().encode('파일 평문').buffer as ArrayBuffer)
    const url = 'https://files.test/myhub/memo-encrypted/seed7'
    deps.store.set(url, encFile)
    db.prepare("INSERT INTO memos (id, text) VALUES (1, '공개')").run()
    db.prepare("INSERT INTO files (id, memo_id, storage_key, filename, mime, size, url, resource_type, is_locked) VALUES (1, 1, 'myhub/memo-encrypted/seed7', 'a.txt', 'text/plain', ?, ?, 'raw', 1)").run(encFile.byteLength, url)
    // 업로드 도중 다른 경로가 파일 행을 바꿔 CAS를 깨뜨리는 상황을 재현한다
    const realUpload = deps.upload as any
    deps.upload = (async (...a: any[]) => {
      const up = await realUpload(...a)
      db.prepare("UPDATE files SET storage_key = 'someone-else' WHERE id = 1").run()
      return up
    }) as any
    const census = { memo_text: 0, memo_block: 0, google_token_row: 0, locked_file: 1 }
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: census }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.stage).toBe('write')
      expect(report.error).toBe('cas_conflict:locked_file')
      expect(report.rotated?.locked_file).toBe(0)
    }
    // 새 객체(고아)가 정리됐고, 파일 행은 남의 포인터를 그대로 가리킨다
    expect(deps.destroyed).toHaveLength(1)
    expect(deps.destroyed[0]).toContain('b3obj')
    const row = db.prepare('SELECT storage_key FROM files WHERE id = 1').get() as any
    expect(row.storage_key).toBe('someone-else')
  })
})
