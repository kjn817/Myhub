/**
 * 백업 발급 step-up 게이트 검증 (GPT 7.2 재평가 P0-3)
 *
 * 검증하는 성질: PIN이 설정된 계정에서는 유효 세션만으로 백업을 발급할 수
 * 없고, 발급 전에 데이터 읽기(batch)가 일어나지 않아야 한다. step-up 창
 * (stepUpUntil)이 살아 있을 때만 발급되며, PIN 미설정 계정은 면제된다
 * (lockout 방지 — 보호 메모 게이트와 같은 집행점 requireProtectedAccess).
 *
 * 카나리아: src/modules/backup/routes.ts의 게이트 2곳 중 하나라도 제거하면
 * 해당 엔드포인트의 403 케이스가 200으로 바뀌어 이 파일이 실패한다.
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import backupApp, { BACKUP_TABLES } from '../../src/modules/backup/routes'

const TABLE_COUNT = BACKUP_TABLES.length

class FakeDb {
  batchCalls = 0
  pinRow: any
  constructor(pinRow: any) {
    this.pinRow = pinRow
  }
  prepare(sql: string) {
    const db = this
    return {
      bind: (..._params: any[]) => ({
        first: async () => (sql.includes('FROM auth_pins') ? db.pinRow : null),
      }),
      first: async () => (sql.includes('FROM auth_pins') ? db.pinRow : null),
    }
  }
  async batch(stmts: any[]) {
    this.batchCalls++
    return stmts.map(() => ({ results: [] }))
  }
}

const PIN_ROW = { pin_hash: 'deadbeef', pin_salt: 'cafe', iterations: 100000 }

function makeApp(opts: { pinRow: any; stepUpUntil?: number; environment?: string }) {
  const db = new FakeDb(opts.pinRow)
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('userEmail', 'owner@example.com')
    if (opts.stepUpUntil !== undefined) (c as any).set('stepUpUntil', opts.stepUpUntil)
    await next()
  })
  app.route('/api/backup', backupApp)
  // 암호화 발급은 production 허용, 평문 발급은 staging 전용 — 기본은 production
  const env: any = { DB: db, ENVIRONMENT: opts.environment ?? 'production' }
  const post = (path: string, body: any) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env)
  return { db, post }
}

describe('백업 발급 step-up 게이트', () => {
  test('PIN 설정 + step-up 창 없음: POST /encrypted → 403 STEP_UP_REQUIRED, 데이터 읽기가 일어나지 않는다', async () => {
    const { db, post } = makeApp({ pinRow: PIN_ROW })
    const res = await post('/api/backup/encrypted', { password: '12341234' })
    expect(res.status).toBe(403)
    const j: any = await res.json()
    expect(j.code).toBe('STEP_UP_REQUIRED')
    expect(db.batchCalls).toBe(0)
  })

  test('PIN 설정 + step-up 창 없음: POST / (평문) → 403 STEP_UP_REQUIRED, 데이터 읽기가 일어나지 않는다', async () => {
    const { db, post } = makeApp({ pinRow: PIN_ROW, environment: 'staging' })
    const res = await post('/api/backup', {})
    expect(res.status).toBe(403)
    const j: any = await res.json()
    expect(j.code).toBe('STEP_UP_REQUIRED')
    expect(db.batchCalls).toBe(0)
  })

  test('PIN 설정 + 만료된 step-up 창: POST /encrypted → 403', async () => {
    const { post } = makeApp({ pinRow: PIN_ROW, stepUpUntil: Date.now() - 1000 })
    const res = await post('/api/backup/encrypted', { password: '12341234' })
    expect(res.status).toBe(403)
    const j: any = await res.json()
    expect(j.code).toBe('STEP_UP_REQUIRED')
  })

  test('PIN 설정 + 유효한 step-up 창: POST /encrypted → 200, 봉투 형식 무변경', async () => {
    const { db, post } = makeApp({ pinRow: PIN_ROW, stepUpUntil: Date.now() + 5 * 60 * 1000 })
    const res = await post('/api/backup/encrypted', { password: '12341234' })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.format_version).toBe(1)
    expect(j.algorithm).toBe('AES-256-GCM')
    expect(typeof j.ciphertext).toBe('string')
    expect(j.table_count).toBe(TABLE_COUNT)
    expect(db.batchCalls).toBeGreaterThan(0)
  })

  test('PIN 미설정: step-up 창이 없어도 POST /encrypted → 200 (면제, lockout 방지)', async () => {
    const { post } = makeApp({ pinRow: null })
    const res = await post('/api/backup/encrypted', { password: '12341234' })
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.format_version).toBe(1)
  })
})
