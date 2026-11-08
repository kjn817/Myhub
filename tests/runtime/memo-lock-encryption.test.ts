/**
 * 메모 잠금 암호화 실런타임 테스트 (fix: 잠긴 메모 평문 저장 결함).
 *
 * Mock으로는 검증하지 못하는 것 — 실제 AES-GCM crypto + 실제 D1에서의
 * 종단 동작:
 * - POST /:id/lock이 본문을 실제로 ENC: 암호문으로 저장하는지 (fail-closed)
 * - 소유자 PUT이 잠긴 메모를 평문으로 덮어쓰지 않는지 (주원인 결함)
 * - 키 없는 환경에서 잠금·수정이 500 + DB 불변인지
 * - 재잠금 멱등성 (이중 암호화 없음)과 평문 잠긴 메모의 전환·해제 안전판
 * - 소유자 읽기 경로(목록 무검색·단건)가 복호화된 본문을 내리는지
 *
 * 운영 DB·운영 배포 없음. D1은 테스트 파일마다 격리된 로컬 SQLite이고
 * 키는 vitest.config.ts의 테스트 전용 MEMO_ENCRYPTION_KEY이다.
 */
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { memoApp } from '../../src/modules/memo/routes'
import { hashPin } from '../../src/modules/auth/routes'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as {
  DB: D1Database
  KV: KVNamespace
  CLOUDINARY_CLOUD_NAME: string
  MEMO_ENCRYPTION_KEY: string
}

/** 키 없는 환경 — 암호화/복호화가 반드시 실패해야 하는 조건. */
const noKeyEnv = () => ({
  DB: testDb(),
  KV: testEnv.KV,
  CLOUDINARY_CLOUD_NAME: 'runtime-test',
})

const app = new Hono()
app.route('/a', memoApp)

async function req(
  path: string,
  method: string,
  body?: unknown,
  envOverride?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(
    `/a${path === '/' ? '' : path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    (envOverride ?? testEnv) as any,
  )
  let parsed: any = null
  try {
    parsed = await res.json()
  } catch {
    /* 본문 없는 응답 */
  }
  return { status: res.status, body: parsed }
}

async function createMemo(text: string): Promise<number> {
  const r = await testDb().prepare('INSERT INTO memos (text) VALUES (?)').bind(text).run()
  return Number(r.meta.last_row_id)
}

async function rawRow(id: number): Promise<{ text: string; is_locked: number }> {
  const row = await testDb()
    .prepare('SELECT text, is_locked FROM memos WHERE id = ?')
    .bind(id)
    .first<{ text: string; is_locked: number }>()
  if (!row) throw new Error(`memo ${id} missing`)
  return row
}

describe('memo lock encryption (miniflare, real crypto + real D1)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
  })

  it('1. POST /lock 후 원시 저장값이 ENC:로 시작한다', async () => {
    const id = await createMemo('잠금 대상 비밀 메모')
    const res = await req(`/${id}/lock`, 'POST', { locked: true })
    expect(res.status).toBe(200)
    expect(res.body.is_locked).toBe(1)
    const raw = await rawRow(id)
    expect(raw.is_locked).toBe(1)
    expect(raw.text.startsWith('ENC:')).toBe(true)
    expect(raw.text).not.toContain('잠금 대상 비밀 메모')
  })

  it('2. lock → PUT(평문) → 원시값은 여전히 ENC:, 해제하면 PUT한 본문이 복원된다', async () => {
    const id = await createMemo('원본 비밀')
    await req(`/${id}/lock`, 'POST', { locked: true })

    const put = await req(`/${id}`, 'PUT', { text: '수정된 비밀 본문' })
    expect(put.status).toBe(200)

    const rawAfterPut = await rawRow(id)
    expect(rawAfterPut.is_locked).toBe(1)
    expect(rawAfterPut.text.startsWith('ENC:')).toBe(true)
    expect(rawAfterPut.text).not.toContain('수정된 비밀 본문')

    const unlock = await req(`/${id}/lock`, 'POST', { locked: false })
    expect(unlock.status).toBe(200)
    const rawAfterUnlock = await rawRow(id)
    expect(rawAfterUnlock.is_locked).toBe(0)
    expect(rawAfterUnlock.text).toBe('수정된 비밀 본문')
  })

  it('3. 키 없음 환경에서 POST /lock → 500 + is_locked·text 불변', async () => {
    const id = await createMemo('키 없음 잠금 시도')
    const res = await req(`/${id}/lock`, 'POST', { locked: true }, noKeyEnv())
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('encrypt_failed')
    const raw = await rawRow(id)
    expect(raw.is_locked).toBe(0)
    expect(raw.text).toBe('키 없음 잠금 시도')
  })

  it('4. 잠긴 메모에 PUT 시 키 없음 → 500 + 불변', async () => {
    const id = await createMemo('보호된 원본')
    await req(`/${id}/lock`, 'POST', { locked: true })
    const before = await rawRow(id)
    expect(before.text.startsWith('ENC:')).toBe(true)

    const res = await req(`/${id}`, 'PUT', { text: '덮어쓰기 시도' }, noKeyEnv())
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('encrypt_failed')

    const after = await rawRow(id)
    expect(after.is_locked).toBe(1)
    expect(after.text).toBe(before.text)
    // 키 있는 환경에서 해제하면 원본이 그대로 복원된다 (덮어쓰기 미발생 증명)
    await req(`/${id}/lock`, 'POST', { locked: false })
    expect((await rawRow(id)).text).toBe('보호된 원본')
  })

  it('5. 이미 암호화된 메모에 lock 재호출 → 이중 암호화 없음', async () => {
    const id = await createMemo('멱등성 확인 메모')
    await req(`/${id}/lock`, 'POST', { locked: true })
    const first = await rawRow(id)

    const again = await req(`/${id}/lock`, 'POST', { locked: true })
    expect(again.status).toBe(200)
    const second = await rawRow(id)
    // 재암호화했다면 IV가 달라져 암호문이 달라진다 — 동일해야 멱등이다.
    expect(second.text).toBe(first.text)

    await req(`/${id}/lock`, 'POST', { locked: false })
    expect((await rawRow(id)).text).toBe('멱등성 확인 메모')
  })

  it('5b. 평문으로 남은 잠긴 메모(구 fail-open 잔재)에 lock 재호출 → 암호문으로 전환된다', async () => {
    const id = await createMemo('평문 잔재 메모')
    // 구 결함 상태를 직접 재현: 플래그만 1, 본문은 평문
    await testDb().prepare('UPDATE memos SET is_locked = 1 WHERE id = ?').bind(id).run()
    expect((await rawRow(id)).text).toBe('평문 잔재 메모')

    const res = await req(`/${id}/lock`, 'POST', { locked: true })
    expect(res.status).toBe(200)
    const raw = await rawRow(id)
    expect(raw.is_locked).toBe(1)
    expect(raw.text.startsWith('ENC:')).toBe(true)

    await req(`/${id}/lock`, 'POST', { locked: false })
    expect((await rawRow(id)).text).toBe('평문 잔재 메모')
  })

  it('5c. 평문인 잠긴 메모의 해제는 패스스루로 성공한다 (전환 안전판)', async () => {
    const id = await createMemo('평문 잠금 해제 대상')
    await testDb().prepare('UPDATE memos SET is_locked = 1 WHERE id = ?').bind(id).run()
    const res = await req(`/${id}/lock`, 'POST', { locked: false })
    expect(res.status).toBe(200)
    const raw = await rawRow(id)
    expect(raw.is_locked).toBe(0)
    expect(raw.text).toBe('평문 잠금 해제 대상')
  })

  it('6. 소유자 목록(무검색)·단건 조회에서 잠긴 메모 본문이 복호화되어 내려온다', async () => {
    const id = await createMemo('소유자 조회용 비밀')
    await req(`/${id}/lock`, 'POST', { locked: true })
    expect((await rawRow(id)).text.startsWith('ENC:')).toBe(true)

    const list = await req('/', 'GET')
    expect(list.status).toBe(200)
    const row = (list.body as any[]).find((r) => r.id === id)
    expect(row).toBeDefined()
    expect(row.text).toBe('소유자 조회용 비밀')
    expect(row.text).not.toContain('ENC:')

    const single = await req(`/${id}`, 'GET')
    expect(single.status).toBe(200)
    expect(single.body.memo.text).toBe('소유자 조회용 비밀')
    expect(single.body.memo.content).toBe('소유자 조회용 비밀')
  })

  it('6b. 복호화할 수 없는 환경의 소유자 조회는 원시 ENC: 대신 플레이스홀더를 내린다', async () => {
    const id = await createMemo('복호화 실패 대상')
    await req(`/${id}/lock`, 'POST', { locked: true })

    const list = await req('/', 'GET', undefined, noKeyEnv())
    const row = (list.body as any[]).find((r) => r.id === id)
    expect(row.text).toBe('[복호화 실패]')
    expect(row.text).not.toContain('ENC:')

    const single = await req(`/${id}`, 'GET', undefined, noKeyEnv())
    expect(single.body.memo.text).toBe('[복호화 실패]')
  })

  it('7. 잠기지 않은 메모의 PUT은 기존대로 평문 저장된다', async () => {
    const id = await createMemo('일반 메모')
    const res = await req(`/${id}`, 'PUT', { text: '일반 수정 본문' })
    expect(res.status).toBe(200)
    const raw = await rawRow(id)
    expect(raw.is_locked).toBe(0)
    expect(raw.text).toBe('일반 수정 본문')
  })

  // ---- 잠금 해제 step-up (PIN 재인증, 2026-10-29) ----
  // 테스트 전용 PIN으로 auth_pins 행을 만들고 지운다 (실제 PIN 아님).
  const STEPUP_PIN = '246810'
  async function setTestPin() {
    const { hashB64, saltB64, iterations } = await hashPin(STEPUP_PIN)
    const now = new Date().toISOString()
    await testDb()
      .prepare(
        `INSERT OR REPLACE INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind('stepup-runtime@test', hashB64, saltB64, iterations, now, now)
      .run()
  }
  async function clearTestPin() {
    await testDb().prepare('DELETE FROM auth_pins').run()
  }

  it('8. PIN 설정 시 해제: PIN 없음→403·틀린 PIN→403 (상태 불변), 맞는 PIN→해제', async () => {
    const id = await createMemo('step-up 보호 메모')
    await req(`/${id}/lock`, 'POST', { locked: true })
    const lockedRaw = await rawRow(id)
    expect(lockedRaw.text.startsWith('ENC:')).toBe(true)
    await setTestPin()
    try {
      const noPin = await req(`/${id}/lock`, 'POST', { locked: false })
      expect(noPin.status).toBe(403)
      expect(noPin.body.code).toBe('PIN_REQUIRED')
      expect(await rawRow(id)).toEqual(lockedRaw)

      const wrong = await req(`/${id}/lock`, 'POST', { locked: false, pin: '000000' })
      expect(wrong.status).toBe(403)
      expect(wrong.body.code).toBe('PIN_INVALID')
      expect(await rawRow(id)).toEqual(lockedRaw)

      const ok = await req(`/${id}/lock`, 'POST', { locked: false, pin: STEPUP_PIN })
      expect(ok.status).toBe(200)
      const raw = await rawRow(id)
      expect(raw.is_locked).toBe(0)
      expect(raw.text).toBe('step-up 보호 메모')
    } finally {
      await clearTestPin()
    }
  })

  it('9. PIN 설정 시에도 잠금은 PIN 없이 성공한다 (비대칭)', async () => {
    const id = await createMemo('step-up 잠금 대상')
    await setTestPin()
    try {
      const res = await req(`/${id}/lock`, 'POST', { locked: true })
      expect(res.status).toBe(200)
      expect((await rawRow(id)).text.startsWith('ENC:')).toBe(true)
    } finally {
      await clearTestPin()
    }
  })

  it('10. PIN 미설정 시 해제는 PIN 없이 성공한다 (lockout 방지 정책)', async () => {
    await clearTestPin()
    const id = await createMemo('PIN 미설정 해제 메모')
    await req(`/${id}/lock`, 'POST', { locked: true })
    const res = await req(`/${id}/lock`, 'POST', { locked: false })
    expect(res.status).toBe(200)
    expect((await rawRow(id)).text).toBe('PIN 미설정 해제 메모')
  })

  it('11. 블록 해제 step-up: PIN 없음→403 (블록 보존), 맞는 PIN→200 html', async () => {
    // D-3 (2026-10-30): lock-block은 본문에 포함된 html만 잠글 수 있다
    // (fail-closed) — 메모 본문에 대상 html을 포함시켜 둔다.
    const id = await createMemo('블록 step-up 메모 <b>블록 비밀</b>')
    const lock = await req(`/${id}/lock-block`, 'POST', { html: '<b>블록 비밀</b>' })
    expect(lock.status).toBe(200)
    const blockId = lock.body.blockId as string
    await setTestPin()
    try {
      const noPin = await req(`/${id}/unlock-block/${blockId}`, 'POST')
      expect(noPin.status).toBe(403)
      expect(noPin.body.code).toBe('PIN_REQUIRED')
      const still = await testDb()
        .prepare('SELECT locked_blocks FROM memos WHERE id = ?')
        .bind(id)
        .first<{ locked_blocks: string }>()
      expect(still?.locked_blocks).toContain(blockId)

      const ok = await req(`/${id}/unlock-block/${blockId}`, 'POST', { pin: STEPUP_PIN })
      expect(ok.status).toBe(200)
      expect(ok.body.html).toBe('<b>블록 비밀</b>')
    } finally {
      await clearTestPin()
    }
  })

  // ---- 트랙 C 추가 (2026-10-30): 해제 fail-closed + 파일 해제 게이트 ----

  it('12. 손상된 암호문의 해제 → 500 decrypt_failed + 행 불변 (평문 폴백 없음)', async () => {
    await clearTestPin()
    const id = await createMemo('손상 암호문 메모')
    // ENC: 접두는 있으나 GCM 인증이 깨지는 값 (유효 base64, 무효 페이로드)
    const corrupt = 'ENC:' + btoa('corrupt-payload-0123456789abcdef')
    await testDb()
      .prepare('UPDATE memos SET text = ?, is_locked = 1 WHERE id = ?')
      .bind(corrupt, id)
      .run()
    const res = await req(`/${id}/lock`, 'POST', { locked: false })
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('decrypt_failed')
    const raw = await rawRow(id)
    expect(raw.is_locked).toBe(1)
    expect(raw.text).toBe(corrupt)
  })

  it('13. 키 없음 환경에서 해제 → 500 + 암호문·잠금 불변', async () => {
    await clearTestPin()
    const id = await createMemo('키 없음 해제 시도')
    await req(`/${id}/lock`, 'POST', { locked: true })
    const before = await rawRow(id)
    expect(before.text.startsWith('ENC:')).toBe(true)

    const res = await req(`/${id}/lock`, 'POST', { locked: false }, noKeyEnv())
    expect(res.status).toBe(500)
    expect(await rawRow(id)).toEqual(before)
  })

  it('14. 평문 잔재 잠긴 메모에 PUT → 새 본문이 ENC:로 저장되고 해제로 복원된다', async () => {
    await clearTestPin()
    const id = await createMemo('잔재 원본')
    await testDb().prepare('UPDATE memos SET is_locked = 1 WHERE id = ?').bind(id).run()

    const put = await req(`/${id}`, 'PUT', { text: '잔재 위 새 본문' })
    expect(put.status).toBe(200)
    const raw = await rawRow(id)
    expect(raw.is_locked).toBe(1)
    expect(raw.text.startsWith('ENC:')).toBe(true)
    expect(raw.text).not.toContain('잔재 위 새 본문')

    const unlock = await req(`/${id}/lock`, 'POST', { locked: false })
    expect(unlock.status).toBe(200)
    expect((await rawRow(id)).text).toBe('잔재 위 새 본문')
  })

  async function createLockedFile(memoId: number): Promise<number> {
    const r = await testDb()
      .prepare(
        `INSERT INTO files (memo_id, storage_key, filename, mime, size, url, resource_type, is_locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(memoId, `trackc/test-${memoId}.enc`, 'secret.txt.enc', 'application/octet-stream', 32,
        'https://nonexistent.invalid/secret.enc', 'raw')
      .run()
    return Number(r.meta.last_row_id)
  }
  async function rawFile(id: number): Promise<{ is_locked: number; url: string }> {
    const row = await testDb()
      .prepare('SELECT is_locked, url FROM files WHERE id = ?')
      .bind(id)
      .first<{ is_locked: number; url: string }>()
    if (!row) throw new Error(`file ${id} missing`)
    return row
  }

  it('15. 파일 해제 step-up: PIN 없음·오답 → 403 + 파일 불변, 맞는 PIN → 게이트 통과(다운로드 실패 500·여전히 잠김)', async () => {
    const memoId = await createMemo('파일 step-up 메모')
    const fileId = await createLockedFile(memoId)
    const before = await rawFile(fileId)
    await setTestPin()
    try {
      const noPin = await req(`/files/${fileId}/lock`, 'POST', { locked: false })
      expect(noPin.status).toBe(403)
      expect(noPin.body.code).toBe('PIN_REQUIRED')
      expect(await rawFile(fileId)).toEqual(before)

      const wrong = await req(`/files/${fileId}/lock`, 'POST', { locked: false, pin: '000000' })
      expect(wrong.status).toBe(403)
      expect(wrong.body.code).toBe('PIN_INVALID')
      expect(await rawFile(fileId)).toEqual(before)

      // 맞는 PIN: 게이트를 통과해 실제 해제 절차(다운로드)에 진입한다.
      // 도달 불가 URL이라 복호화 단계에서 500이 되지만, 그 경우에도
      // 파일은 잠긴 채로 남아야 한다 (평문 폴백·플래그 해제 금지).
      const okPin = await req(`/files/${fileId}/lock`, 'POST', { locked: false, pin: STEPUP_PIN })
      expect(okPin.status).toBe(500)
      expect(okPin.body.error).toBe('decrypt_failed')
      expect(await rawFile(fileId)).toEqual(before)
    } finally {
      await clearTestPin()
    }
  })

  it('16. 파일 해제: PIN 미설정 계정은 게이트 면제 (403이 아니라 해제 절차로 진입)', async () => {
    await clearTestPin()
    const memoId = await createMemo('파일 면제 메모')
    const fileId = await createLockedFile(memoId)
    const res = await req(`/files/${fileId}/lock`, 'POST', { locked: false })
    // 면제 → 게이트를 통과하므로 403이 아니라 다운로드 실패 500이어야 한다.
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('decrypt_failed')
    expect((await rawFile(fileId)).is_locked).toBe(1)
  })

  it('17. 블록 해제 복호화 실패 → 500 + locked_blocks 불변 (암호문 보존)', async () => {
    // D-3: lock-block fail-closed — 본문에 대상 html을 포함시켜 둔다.
    const id = await createMemo('블록 복호화 실패 메모 <i>깨질 블록</i>')
    const lock = await req(`/${id}/lock-block`, 'POST', { html: '<i>깨질 블록</i>' })
    expect(lock.status).toBe(200)
    const blockId = lock.body.blockId as string
    // 저장된 암호문을 손상시켜 복호화를 실패하게 만든다
    const row = await testDb()
      .prepare('SELECT locked_blocks FROM memos WHERE id = ?')
      .bind(id)
      .first<{ locked_blocks: string }>()
    const blocks = JSON.parse(row!.locked_blocks)
    blocks[0].encrypted = 'ENC:' + btoa('corrupt-block-payload-0123456789')
    const corrupted = JSON.stringify(blocks)
    await testDb()
      .prepare('UPDATE memos SET locked_blocks = ? WHERE id = ?')
      .bind(corrupted, id)
      .run()

    await setTestPin()
    try {
      const res = await req(`/${id}/unlock-block/${blockId}`, 'POST', { pin: STEPUP_PIN })
      expect(res.status).toBe(500)
      expect(res.body.error).toBe('decrypt_failed')
      const after = await testDb()
        .prepare('SELECT locked_blocks FROM memos WHERE id = ?')
        .bind(id)
        .first<{ locked_blocks: string }>()
      expect(after?.locked_blocks).toBe(corrupted)
    } finally {
      await clearTestPin()
    }
  })

  it('18. lock-block 키 없음 → 500 + locked_blocks 불변', async () => {
    const id = await createMemo('블록 잠금 fail-closed 메모')
    const res = await req(`/${id}/lock-block`, 'POST', { html: '<b>x</b>' }, noKeyEnv())
    expect(res.status).toBe(500)
    const row = await testDb()
      .prepare('SELECT locked_blocks FROM memos WHERE id = ?')
      .bind(id)
      .first<{ locked_blocks: string | null }>()
    expect(row?.locked_blocks ?? '[]').toBe('[]')
  })
})
