/// <reference types="jest" />
/**
 * 키 로테이션 서비스 + 엔드포인트 테스트 (트랙 4)
 *
 * Mock이 아닌 실제 SQLite(전 마이그레이션 적용)에 대해 검증한다:
 * - dry-run은 쓰기 0건
 * - 전 항목 전환 후 새 키로만 열리고 구 키로는 안 열림 (4개 사용처 전수)
 * - 잘못된 현재 키/이질 암호문이 있으면 preflight에서 중단, 쓰기 0건
 * - 쓰기 중간 실패 시 전환분/미전환분이 각자 자기 키로 읽히는 혼합 상태,
 *   재실행으로 완주(멱등), 롤백으로 원형 복귀
 * - 엔드포인트: 무인증 401, step-up 없음 403, 키 검증 400
 *
 * 현행 계약 (11-07 번들 a2702ca4와 동일 — 11-01→11-07 보안 강화):
 * - 비-dry-run 실행은 사전 센서스(expectedCensus)가 필수다. 없으면
 *   stage:'preflight' + error:'census_required'로, 실제와 다르면
 *   'census_mismatch'로 쓰기 0건 중단한다 (실행 중 데이터가 바뀌는
 *   레이스에서 엉뚱한 집합을 전환하지 않기 위한 게이트).
 * - 엔드포인트 rotate는 새 키 확인 입력(newKeyConfirm)이 같은 값으로
 *   와야 한다. 없으면 400 KEY_CONFIRMATION_REQUIRED, 다르면
 *   400 KEY_CONFIRMATION_MISMATCH.
 */
import { Hono } from 'hono'
import { createTestDb } from '../mcp-d1'
import {
  decryptBytesWithKey,
  decryptContent,
  decryptContentWithKey,
  encryptBytes,
  encryptContent,
} from '../../src/services/crypto'
import { rotateEncryptionKey, type RotationDeps } from '../../src/services/key-rotation'
import { keyRotationApp } from '../../src/modules/key-rotation/routes'
import { hashPin } from '../../src/modules/auth/routes'

const OLD_KEY = 'old-test-key-material-0001'
const NEW_KEY = 'new-test-key-material-0002'
const THIRD_KEY = 'third-test-key-material-0003'

/** seedAll이 만드는 암호화 항목의 센서스 (전환 실행의 expectedCensus) */
const SEED_CENSUS = { memo_text: 1, memo_block: 1, google_token_row: 1, locked_file: 1 }

const PLAIN_MEMO = '비밀 메모 본문 🔐'
const PLAIN_BLOCK = '<p>블록 비밀</p>'
const PLAIN_ACCESS = 'ya29.test-access-token'
const PLAIN_REFRESH = '1//test-refresh-token'
const PLAIN_FILE = new TextEncoder().encode('첨부 파일 평문 바이트')

/** 가짜 Cloudinary 객체 저장소: url → 바이트. upload/fetch/destroy가 공유한다. */
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
      const publicId = `myhub/memo-encrypted/obj${seq}`
      const url = `https://files.test/${publicId}`
      store.set(url, await file.arrayBuffer())
      return { public_id: publicId, secure_url: url, resource_type: 'raw', bytes: 0 }
    }) as any,
    destroy: (async (_env: any, publicId: string) => {
      deps.destroyed.push(publicId)
      for (const url of [...store.keys()]) {
        if (url.endsWith(publicId)) store.delete(url)
      }
      return true
    }) as any,
  }
  return deps
}

async function seedAll(env: any, db: any, deps: ReturnType<typeof makeObjectStore>) {
  const encMemo = await encryptContent(env, PLAIN_MEMO)
  db.prepare("INSERT INTO memos (id, text, is_locked) VALUES (1, ?, 1)").run(encMemo)
  const encBlock = await encryptContent(env, PLAIN_BLOCK)
  db.prepare("INSERT INTO memos (id, text, locked_blocks) VALUES (2, '공개 본문', ?)")
    .run(JSON.stringify([{ id: 'blk_1', encrypted: encBlock }]))
  const encAccess = await encryptContent(env, PLAIN_ACCESS)
  const encRefresh = await encryptContent(env, PLAIN_REFRESH)
  db.prepare(
    "INSERT INTO google_integrations (provider, email, access_token, refresh_token, scope, expires_at, status) VALUES ('google', 't@example.com', ?, ?, 'scope', 0, 'active')",
  ).run(encAccess, encRefresh)
  const encFileBytes = await encryptBytes(env, PLAIN_FILE.buffer as ArrayBuffer)
  const url = 'https://files.test/myhub/memo-encrypted/seed1'
  deps.store.set(url, encFileBytes)
  db.prepare(
    "INSERT INTO files (id, memo_id, storage_key, filename, mime, size, url, resource_type, is_locked) VALUES (1, 1, 'myhub/memo-encrypted/seed1', 'a.txt', 'text/plain', ?, ?, 'raw', 1)",
  ).run(encFileBytes.byteLength, url)
  return { encMemo, encBlock, encAccess, encRefresh }
}

function snapshot(db: any) {
  return {
    memos: db.prepare('SELECT id, text, locked_blocks FROM memos ORDER BY id').all(),
    google: db.prepare('SELECT provider, access_token, refresh_token FROM google_integrations').all(),
    files: db.prepare('SELECT id, url, storage_key FROM files ORDER BY id').all(),
  }
}

describe('rotateEncryptionKey — 서비스', () => {
  test('dry-run: 전환 예정 건수만 보고하고 DB·객체는 불변', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    const before = snapshot(db)

    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, dryRun: true }, deps)
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.pending).toEqual({ memo_text: 1, memo_block: 1, google_token_row: 1, locked_file: 1 })
      expect(report.rotated).toEqual({ memo_text: 0, memo_block: 0, google_token_row: 0, locked_file: 0 })
    }
    expect(snapshot(db)).toEqual(before)
    expect(deps.destroyed).toEqual([])
  })

  test('실행: 4개 사용처 전부 새 키(ENC2/MYH2)로 전환되고 구 키로는 안 열린다', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)

    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: SEED_CENSUS }, deps)
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.rotated).toEqual({ memo_text: 1, memo_block: 1, google_token_row: 1, locked_file: 1 })
      expect(report.census).toEqual(SEED_CENSUS)
    }

    const memo1 = db.prepare('SELECT text FROM memos WHERE id = 1').get() as any
    expect(memo1.text.startsWith('ENC2:')).toBe(true)
    expect(await decryptContentWithKey(NEW_KEY, memo1.text)).toBe(PLAIN_MEMO)
    await expect(decryptContentWithKey(OLD_KEY, memo1.text)).rejects.toThrow()

    const memo2 = db.prepare('SELECT locked_blocks FROM memos WHERE id = 2').get() as any
    const blocks = JSON.parse(memo2.locked_blocks)
    expect(blocks[0].encrypted.startsWith('ENC2:')).toBe(true)
    expect(await decryptContentWithKey(NEW_KEY, blocks[0].encrypted)).toBe(PLAIN_BLOCK)

    const g = db.prepare('SELECT access_token, refresh_token FROM google_integrations').get() as any
    expect(await decryptContentWithKey(NEW_KEY, g.access_token)).toBe(PLAIN_ACCESS)
    expect(await decryptContentWithKey(NEW_KEY, g.refresh_token)).toBe(PLAIN_REFRESH)
    await expect(decryptContentWithKey(OLD_KEY, g.access_token)).rejects.toThrow()

    const f = db.prepare('SELECT url, storage_key FROM files WHERE id = 1').get() as any
    expect(f.storage_key).not.toBe('myhub/memo-encrypted/seed1')
    expect(deps.destroyed).toContain('myhub/memo-encrypted/seed1')
    const stored = deps.store.get(f.url)!
    expect(new TextDecoder().decode(stored.slice(0, 4))).toBe('MYH2')
    const plainFile = await decryptBytesWithKey(NEW_KEY, stored)
    expect(new TextDecoder().decode(plainFile)).toBe('첨부 파일 평문 바이트')
  })

  test('멱등: 같은 새 키로 재실행하면 전부 already로 건너뛴다', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: SEED_CENSUS }, deps)
    const mid = snapshot(db)

    const second = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: SEED_CENSUS }, deps)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.pending).toEqual({ memo_text: 0, memo_block: 0, google_token_row: 0, locked_file: 0 })
      expect(second.already).toEqual({ memo_text: 1, memo_block: 1, google_token_row: 1, locked_file: 1 })
      expect(second.rotated.memo_text).toBe(0)
    }
    expect(snapshot(db)).toEqual(mid)
  })

  test('preflight: 이질 키 암호문이 섞여 있으면 쓰기 0건으로 중단', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    const foreign = await encryptContent({ MEMO_ENCRYPTION_KEY: THIRD_KEY }, '남의 키 메모')
    db.prepare("INSERT INTO memos (id, text, is_locked) VALUES (3, ?, 1)").run(foreign)
    const before = snapshot(db)

    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.stage).toBe('preflight')
      expect(report.failures?.memo_text).toBe(1)
    }
    expect(snapshot(db)).toEqual(before)
  })

  test('preflight: 현재 키가 틀리면(전 항목 복호화 실패) 쓰기 0건', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    const before = snapshot(db)

    const wrongEnv: any = { DB: d1, MEMO_ENCRYPTION_KEY: THIRD_KEY }
    const report = await rotateEncryptionKey(wrongEnv, { mode: 'rotate', targetKeyMaterial: NEW_KEY }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) expect(report.stage).toBe('preflight')
    expect(snapshot(db)).toEqual(before)
  })

  test('중간 실패: 전환분은 새 키로, 미전환분은 구 키로 읽히는 혼합 상태 + 재실행 완주', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    // 두 번째 잠긴 파일 추가
    const enc2 = await encryptBytes(env, new TextEncoder().encode('두번째 파일').buffer as ArrayBuffer)
    const url2 = 'https://files.test/myhub/memo-encrypted/seed2'
    deps.store.set(url2, enc2)
    db.prepare(
      "INSERT INTO files (id, memo_id, storage_key, filename, size, url, resource_type, is_locked) VALUES (2, 1, 'myhub/memo-encrypted/seed2', 'b.txt', ?, ?, 'raw', 1)",
    ).run(enc2.byteLength, url2)

    // upload가 두 번째 호출에서 실패하도록 주입
    const realUpload = deps.upload as any
    let calls = 0
    deps.upload = (async (...a: any[]) => {
      calls++
      if (calls === 2) throw new Error('injected upload failure')
      return realUpload(...a)
    }) as any

    const census2Files = { ...SEED_CENSUS, locked_file: 2 }
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: census2Files }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.stage).toBe('write')
      expect(report.rotated?.locked_file).toBe(1)
    }
    // 혼합 상태: 파일1은 새 키, 파일2는 구 키로 열린다
    const f1 = db.prepare('SELECT url FROM files WHERE id = 1').get() as any
    const f2 = db.prepare('SELECT url FROM files WHERE id = 2').get() as any
    await expect(decryptBytesWithKey(NEW_KEY, deps.store.get(f1.url)!)).resolves.toBeTruthy()
    await expect(decryptBytesWithKey(OLD_KEY, deps.store.get(f2.url)!)).resolves.toBeTruthy()

    // 재실행(정상 upload)으로 완주
    deps.upload = realUpload
    const retry = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: census2Files }, deps)
    expect(retry.ok).toBe(true)
    if (retry.ok) {
      expect(retry.already.locked_file).toBe(1)
      expect(retry.rotated.locked_file).toBe(1)
    }
    const f2b = db.prepare('SELECT url FROM files WHERE id = 2').get() as any
    await expect(decryptBytesWithKey(NEW_KEY, deps.store.get(f2b.url)!)).resolves.toBeTruthy()
  })

  test('롤백: 로테이션 후 구 형식(v1)으로 원형 복귀해 현행 키로 읽힌다', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: SEED_CENSUS }, deps)

    const report = await rotateEncryptionKey(env, { mode: 'rollback', sourceKeyMaterial: NEW_KEY, expectedCensus: SEED_CENSUS }, deps)
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.rotated).toEqual({ memo_text: 1, memo_block: 1, google_token_row: 1, locked_file: 1 })
    }
    const memo1 = db.prepare('SELECT text FROM memos WHERE id = 1').get() as any
    expect(memo1.text.startsWith('ENC:')).toBe(true)
    expect(memo1.text.startsWith('ENC2:')).toBe(false)
    expect(await decryptContent(env, memo1.text)).toBe(PLAIN_MEMO)
    const f = db.prepare('SELECT url FROM files WHERE id = 1').get() as any
    const stored = deps.store.get(f.url)!
    expect(new TextDecoder().decode(stored.slice(0, 4))).not.toBe('MYH2')
    const plainFile = await decryptBytesWithKey(OLD_KEY, stored)
    expect(new TextDecoder().decode(plainFile)).toBe('첨부 파일 평문 바이트')
  })

  test('새 키가 현재 키와 같으면 거부', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: OLD_KEY }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) expect(report.error).toBe('new_key_same_as_current')
  })

  test('게이트: expectedCensus가 없으면 census_required로 preflight 중단, 쓰기 0건', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    const before = snapshot(db)

    // 현행 계약: dry-run이 아닌 실행은 사전 센서스 대조가 필수다.
    // 게이트가 없으면 이 호출이 그대로 회전을 완주해 버린다 (카나리아).
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.stage).toBe('preflight')
      expect(report.error).toBe('census_required')
      expect(report.census?.expected).toBeNull()
      expect(report.census?.live).toEqual(SEED_CENSUS)
    }
    expect(snapshot(db)).toEqual(before)
    expect(deps.destroyed).toEqual([])
  })

  test('게이트: expectedCensus가 실제와 다르면 census_mismatch로 중단, 쓰기 0건', async () => {
    const { db, d1 } = createTestDb()
    const deps = makeObjectStore()
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY }
    await seedAll(env, db, deps)
    const before = snapshot(db)

    const wrong = { ...SEED_CENSUS, locked_file: 7 }
    const report = await rotateEncryptionKey(env, { mode: 'rotate', targetKeyMaterial: NEW_KEY, expectedCensus: wrong }, deps)
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.stage).toBe('preflight')
      expect(report.error).toBe('census_mismatch')
      expect(report.census?.expected).toEqual(wrong)
      expect(report.census?.live).toEqual(SEED_CENSUS)
    }
    expect(snapshot(db)).toEqual(before)
    expect(deps.destroyed).toEqual([])
  })
})

describe('POST /api/key-rotation — 엔드포인트 게이트', () => {
  async function makeApp(opts: { stepUp?: boolean; withPin?: boolean; environment?: string } = {}) {
    const { db, d1 } = createTestDb()
    if (opts.withPin) {
      const { hashB64, saltB64, iterations } = await hashPin('135790')
      db.prepare("INSERT INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')")
        .run('admin@example.com', hashB64, saltB64, iterations)
    }
    const encMemo = await encryptContent({ MEMO_ENCRYPTION_KEY: OLD_KEY }, PLAIN_MEMO)
    db.prepare("INSERT INTO memos (id, text, is_locked) VALUES (1, ?, 1)").run(encMemo)
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('userEmail', 'admin@example.com')
      if (opts.stepUp) (c as any).set('stepUpUntil', Date.now() + 5 * 60 * 1000)
      await next()
    })
    app.route('/kr', keyRotationApp)
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY, ENVIRONMENT: opts.environment ?? 'staging' }
    const post = (path: string, body: any) =>
      app.request('/kr' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, env)
    return { post, db }
  }

  test('step-up 창 + PIN 설정 상태 → dry-run 200, 쓰기 없음', async () => {
    const { post, db } = await makeApp({ stepUp: true, withPin: true })
    const res = await post('/rotate', { newKey: NEW_KEY, newKeyConfirm: NEW_KEY, dryRun: true })
    expect(res.status).toBe(200)
    const j = await res.json() as any
    expect(j.pending.memo_text).toBe(1)
    const memo = db.prepare('SELECT text FROM memos WHERE id = 1').get() as any
    expect(memo.text.startsWith('ENC2:')).toBe(false)
  })

  test('게이트: newKeyConfirm이 없으면 400 KEY_CONFIRMATION_REQUIRED, 쓰기 없음', async () => {
    const { post, db } = await makeApp({ stepUp: true, withPin: true })
    const res = await post('/rotate', { newKey: NEW_KEY, dryRun: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBe('KEY_CONFIRMATION_REQUIRED')
    const memo = db.prepare('SELECT text FROM memos WHERE id = 1').get() as any
    expect(memo.text.startsWith('ENC2:')).toBe(false)
  })

  test('게이트: newKeyConfirm이 새 키와 다르면 400 KEY_CONFIRMATION_MISMATCH', async () => {
    const { post } = await makeApp({ stepUp: true, withPin: true })
    const res = await post('/rotate', { newKey: NEW_KEY, newKeyConfirm: THIRD_KEY, dryRun: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBe('KEY_CONFIRMATION_MISMATCH')
  })

  test('PIN 설정 + step-up 창 없음 → 403 STEP_UP_REQUIRED', async () => {
    const { post } = await makeApp({ withPin: true })
    const res = await post('/rotate', { newKey: NEW_KEY, dryRun: true })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).code).toBe('STEP_UP_REQUIRED')
  })

  test('새 키가 짧으면 400', async () => {
    const { post } = await makeApp({ stepUp: true, withPin: true })
    const res = await post('/rotate', { newKey: 'short' })
    expect(res.status).toBe(400)
  })

  test('미지 ENVIRONMENT → 403 (fail-closed)', async () => {
    const { post } = await makeApp({ stepUp: true, environment: 'dev-typo' })
    const res = await post('/rotate', { newKey: NEW_KEY, dryRun: true })
    expect(res.status).toBe(403)
  })

  test('응답에 키 값이 포함되지 않는다', async () => {
    const { post } = await makeApp({ stepUp: true, withPin: true })
    const res = await post('/rotate', { newKey: NEW_KEY, dryRun: true })
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain(NEW_KEY)
    expect(raw).not.toContain(PLAIN_MEMO)
  })
})
