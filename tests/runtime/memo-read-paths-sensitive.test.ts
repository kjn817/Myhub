/**
 * 민감 데이터 읽기 경로 검증 — 트랙 A (2026-10-30).
 *
 * 기존 스위트가 다루지 않는 읽기 경계만 검증한다:
 * - 잠금/민감도 전이(transition)가 FTS(memos_fts)·trigram(memos_fts_tri)
 *   인덱스에서 행을 실제로 제거하는지 (INSERT 시점 제외만으로는 부족 —
 *   평문으로 인덱싱된 뒤 잠그는 경우가 실제 사고 경로다)
 * - 소유자 q-검색의 전 단계(FTS→trigram→파일명→짧은 LIKE)가 잠긴·기밀
 *   메모 본문을 내지 않는지, 어떤 단계에서도 원시 ENC:가 새지 않는지
 * - 통합 검색(unifiedSearch)이 잠금·기밀을 제외하는지 (실제 D1)
 * - 암호화 백업: 전송 페이로드에 어떤 메모 본문 평문도 없고, 복호화한
 *   안쪽에서도 잠긴 행은 ENC: 형태인지
 *
 * 운영 DB·운영 배포 없음. D1은 테스트 파일마다 격리된 로컬 SQLite이다.
 */
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { memoApp } from '../../src/modules/memo/routes'
import backupApp from '../../src/modules/backup/routes'
import { unifiedSearch } from '../../src/services/unified-search'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as {
  DB: D1Database
  KV: KVNamespace
  CLOUDINARY_CLOUD_NAME: string
  MEMO_ENCRYPTION_KEY: string
}

const app = new Hono()
app.route('/a', memoApp)

async function req(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(
    `/a${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    testEnv as any,
  )
  let parsed: any = null
  try {
    parsed = await res.json()
  } catch { /* 본문 없음 */ }
  return { status: res.status, body: parsed }
}

async function createMemo(text: string): Promise<number> {
  const r = await testDb().prepare('INSERT INTO memos (text) VALUES (?)').bind(text).run()
  return Number(r.meta.last_row_id)
}

async function ftsRowCount(table: 'memos_fts' | 'memos_fts_tri', id: number): Promise<number> {
  const row = await testDb()
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE rowid = ?`)
    .bind(id)
    .first<{ n: number }>()
  return row?.n ?? -1
}

const searchIds = async (q: string): Promise<{ ids: number[]; raw: string }> => {
  const res = await app.request(`/a?q=${encodeURIComponent(q)}`, { method: 'GET' }, testEnv as any)
  expect(res.status).toBe(200)
  const body = (await res.json()) as any[]
  return { ids: body.map((x) => x.id), raw: JSON.stringify(body) }
}

describe('sensitive read paths (miniflare, real D1 + real crypto)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
  })

  it('1. 잠금 전이: 평문 인덱싱된 메모를 잠그면 FTS·trigram에서 사라지고, 해제하면 돌아온다', async () => {
    const id = await createMemo('자물쇠전이토큰 회의 준비')
    expect(await ftsRowCount('memos_fts', id)).toBe(1)
    expect(await ftsRowCount('memos_fts_tri', id)).toBe(1)

    const lock = await req(`/${id}/lock`, 'POST', { locked: true })
    expect(lock.status).toBe(200)
    expect(await ftsRowCount('memos_fts', id)).toBe(0)
    expect(await ftsRowCount('memos_fts_tri', id)).toBe(0)
    const { ids } = await searchIds('자물쇠전이토큰')
    expect(ids).not.toContain(id)

    const unlock = await req(`/${id}/lock`, 'POST', { locked: false })
    expect(unlock.status).toBe(200)
    expect(await ftsRowCount('memos_fts', id)).toBe(1)
    expect(await ftsRowCount('memos_fts_tri', id)).toBe(1)
  })

  it('2. 민감도 전이: sensitivity를 2로 올리면 FTS·trigram에서 사라진다', async () => {
    const id = await createMemo('민감도전이토큰 대외비 초안')
    expect(await ftsRowCount('memos_fts', id)).toBe(1)
    const res = await req(`/${id}/sensitivity`, 'POST', { sensitivity: 2 })
    expect(res.status).toBe(200)
    expect(await ftsRowCount('memos_fts', id)).toBe(0)
    expect(await ftsRowCount('memos_fts_tri', id)).toBe(0)
    const { ids } = await searchIds('민감도전이토큰')
    expect(ids).not.toContain(id)
  })

  it('3. 소유자 q-검색: 잠긴 메모는 긴 검색어(FTS/trigram)·짧은 검색어(LIKE) 모두에서 나오지 않고 ENC:도 새지 않는다', async () => {
    const id = await createMemo('꿀밤장부토큰 본문 비밀')
    await req(`/${id}/lock`, 'POST', { locked: true })
    const raw = await testDb().prepare('SELECT text FROM memos WHERE id = ?').bind(id).first<{ text: string }>()
    expect(raw?.text.startsWith('ENC:')).toBe(true)

    for (const q of ['꿀밤장부토큰', '꿀밤', '꿀']) {
      const { ids, raw: rawJson } = await searchIds(q)
      expect(ids).not.toContain(id)
      expect(rawJson).not.toContain('ENC:')
      expect(rawJson).not.toContain('꿀밤장부토큰')
    }
  })

  it('4. 파일명 검색 단계: 잠긴·기밀 메모는 파일명이 일치해도 본문이 검색 결과에 실리지 않는다', async () => {
    const db = testDb()
    const openId = await createMemo('공개 첨부 보유 메모')
    const lockedId = await createMemo('잠금 첨부 보유 메모')
    await req(`/${lockedId}/lock`, 'POST', { locked: true })
    const secretId = await createMemo('기밀 첨부 보유 메모')
    await req(`/${secretId}/sensitivity`, 'POST', { sensitivity: 2 })

    // 파일명은 어떤 메모 본문에도 없는 문자열 — 파일명 단계로만 찾을 수 있다
    await db.prepare("INSERT INTO files (memo_id, storage_key, filename) VALUES (?, 'k-open', '공개첨부문서.pdf')").bind(openId).run()
    await db.prepare("INSERT INTO files (memo_id, storage_key, filename) VALUES (?, 'k-lock', '잠금첨부문서.pdf')").bind(lockedId).run()
    await db.prepare("INSERT INTO files (memo_id, storage_key, filename) VALUES (?, 'k-sec', '기밀첨부문서.pdf')").bind(secretId).run()

    const open = await searchIds('공개첨부')
    expect(open.ids).toContain(openId) // 대조군: 공개 메모는 파일명으로 찾힌다

    const locked = await searchIds('잠금첨부')
    expect(locked.ids).not.toContain(lockedId)
    expect(locked.raw).not.toContain('잠금 첨부 보유 메모')

    const secret = await searchIds('기밀첨부')
    expect(secret.ids).not.toContain(secretId)
    expect(secret.raw).not.toContain('기밀 첨부 보유 메모')
  })

  it('5. 통합 검색: 잠긴·기밀 메모는 제외, 공개 메모만 반환', async () => {
    const openId = await createMemo('통합검색토큰 공개 본문')
    const lockedId = await createMemo('통합검색토큰 잠금 본문')
    await req(`/${lockedId}/lock`, 'POST', { locked: true })
    const secretId = await createMemo('통합검색토큰 기밀 본문')
    await req(`/${secretId}/sensitivity`, 'POST', { sensitivity: 2 })

    const results = await unifiedSearch(testDb(), { query: '통합검색토큰', limit: 20, types: ['memo'] })
    const memoIds = results.filter((r) => r.source_type === 'memo').map((r) => r.source_id)
    expect(memoIds).toContain(openId)
    expect(memoIds).not.toContain(lockedId)
    expect(memoIds).not.toContain(secretId)
    expect(JSON.stringify(results)).not.toContain('잠금 본문')
    expect(JSON.stringify(results)).not.toContain('기밀 본문')
  })

  it('6. 암호화 백업: 와이어 페이로드에 본문 평문이 없고, 복호화한 안쪽의 잠긴 행은 ENC:다', async () => {
    const secretPlain = '백업검증비밀본문토큰'
    const lockedId = await createMemo(secretPlain)
    await req(`/${lockedId}/lock`, 'POST', { locked: true })
    const openPlain = '백업검증공개본문토큰'
    await createMemo(openPlain)

    const bapp = new Hono()
    bapp.use('*', async (c, next) => {
      ;(c as any).set('userEmail', 'readpath-test@example.com')
      await next()
    })
    bapp.route('/b', backupApp)
    const backupEnv = { DB: testDb(), ENVIRONMENT: 'production' }
    const res = await bapp.request(
      '/b/encrypted',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'readpath-backup-pw' }),
      },
      backupEnv as any,
    )
    expect(res.status).toBe(200)
    const wire = await res.text()
    // 와이어에는 어떤 메모 본문도 평문으로 없어야 한다 (잠긴 것·공개된 것 모두)
    expect(wire).not.toContain(secretPlain)
    expect(wire).not.toContain(openPlain)
    const payload = JSON.parse(wire)
    expect(typeof payload.ciphertext).toBe('string')

    // 사용자 비밀번호로 복호화해 안쪽 구조를 검증한다 (백업 복원 경로와 동일 파라미터)
    const salt = Uint8Array.from(atob(payload.salt), (ch) => ch.charCodeAt(0))
    const iv = Uint8Array.from(atob(payload.iv), (ch) => ch.charCodeAt(0))
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode('readpath-backup-pw'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: payload.iterations, hash: 'SHA-256' },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    )
    const ct = Uint8Array.from(atob(payload.ciphertext), (ch) => ch.charCodeAt(0))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    const inner = JSON.parse(new TextDecoder().decode(pt))
    const rows = inner.tables.memos.rows as any[]
    const lockedRow = rows.find((r) => r.id === lockedId)
    expect(lockedRow).toBeDefined()
    expect(String(lockedRow.text).startsWith('ENC:')).toBe(true)
    expect(String(lockedRow.text)).not.toContain(secretPlain)
    const openRow = rows.find((r) => String(r.text).includes(openPlain))
    expect(openRow).toBeDefined() // 대조군: 공개 메모는 안쪽에 평문으로 존재 (백업의 정상 동작)
  })

  it('7. 단건 조회 가드: 없는 메모 404, 잘못된 id 400', async () => {
    const missing = await req('/99999999')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('NOT_FOUND')
    const invalid = await req('/abc')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe('INVALID_ID')
    const zero = await req('/0')
    expect(zero.status).toBe(400)
  })
})
