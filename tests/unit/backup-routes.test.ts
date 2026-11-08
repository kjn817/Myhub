/**
 * src/modules/backup/routes.ts 100% 커버리지 단위 테스트
 * - Mock D1 (prepare/batch만 사용)
 * - Hono app.request()로 HTTP 시뮬레이션
 * - userEmail은 마운트 전 미들웨어로 주입 (401 분기는 미들웨어 생략으로 검증)
 * - WebCrypto는 Node 24 내장 crypto 사용 (PBKDF2 100k + AES-256-GCM 실암호화 검증)
 *
 * 커버리지 대상:
 *   POST /encrypted — 403(staging 차단), 401(미인증), 400(암호 검증),
 *                     413(10MB 초과), 500(batch 실패), 성공 시 복호화 라운드트립 검증
 *   POST /          — 403, 401, 500, 성공(평문 백업)
 * 데드코드: 없음. 모든 분기가 HTTP 경로에서 도달 가능.
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import backupApp, { BACKUP_TABLES } from '../../src/modules/backup/routes'

// ---------------- Mock D1 (backup 라우트는 prepare/batch만 사용) ----------------
class MockDb {
  batchQueue: any[] = []
  calls: string[] = []
  prepares: string[] = []

  prepare(sql: string) {
    const db = this
    db.prepares.push(sql)
    return {
      bind: (..._params: any[]) => {
        db.calls.push(sql)
        return {}
      },
    }
  }

  async batch(stmts: any[]) {
    this.calls.push(`batch:${stmts.length}`)
    const v = this.batchQueue.shift()
    if (v === undefined) return []
    if (v instanceof Error) throw v
    return v
  }
}

// 목 batch 결과는 코드가 읽는 테이블 수와 같아야 한다 (실제 D1 batch는
// 문장 수만큼 결과를 돌려준다). 개수 자체의 핀은 backup-scope와 아래
// 리터럴 단언(35)이 맡는다.
const TABLE_COUNT = BACKUP_TABLES.length

/** BACKUP_TABLES 전체분의 batch 결과 생성. rowsByIndex[i] = 해당 테이블 행 배열 */
function makeBatchResults(rowsByIndex: Record<number, any[]> = {}) {
  const results: any[] = []
  for (let i = 0; i < TABLE_COUNT; i++) {
    results.push({ results: rowsByIndex[i] ?? [] })
  }
  return results
}

function makeApp(opts: {
  db?: MockDb
  environment?: string
  userEmail?: string | null
} = {}) {
  const db = opts.db ?? new MockDb()
  const app = new Hono()
  // 인증 주입: userEmail === null 이면 미들웨어를 달지 않아 401 분기 검증
  if (opts.userEmail !== null) {
    const email = opts.userEmail ?? 'test@example.com'
    app.use('*', async (c, next) => {
      ;(c as any).set('userEmail', email)
      await next()
    })
  }
  app.route('/a', backupApp)
  const env: any = { DB: db }
  if (opts.environment !== undefined) env.ENVIRONMENT = opts.environment
  const req = (path: string, init?: RequestInit) => {
    const q = path.indexOf('?')
    const p = q >= 0 ? path.slice(0, q) : path
    const qs = q >= 0 ? path.slice(q) : ''
    return app.request('/a' + (p === '/' ? '' : p) + qs, init, env)
  }
  const json = (path: string, method: string, body?: any) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { app, db, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

/** 테스트 측 복호화: 서버가 만든 encrypted 백업이 실제로 복호 가능한지 검증 */
async function decryptBackup(encrypted: any, password: string): Promise<any> {
  const enc = new TextEncoder()
  const b64ToBytes = (s: string) => {
    const bin = atob(s)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }
  const salt = b64ToBytes(encrypted.salt)
  const iv = b64ToBytes(encrypted.iv)
  const ct = b64ToBytes(encrypted.ciphertext)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: encrypted.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct.buffer)
  return JSON.parse(new TextDecoder().decode(plain))
}

// ---------------- POST /encrypted: 403/401 분기 ----------------
describe('POST /encrypted — 환경 차단·인증', () => {
  test('ENVIRONMENT 미설정 → 403 (fail-closed)', async () => {
    const { json } = makeApp({})
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(403)
    expect((await body(res)).error).toContain('사용할 수 없는 환경')
  })

  test('ENVIRONMENT=production → 200 (암호화 백업은 운영 허용, P0)', async () => {
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults({ 0: [{ id: 1 }] }))
    const { json } = makeApp({ environment: 'production', db })
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(200)
    expect((await body(res)).total_rows).toBe(1)
  })

  test('ENVIRONMENT 미지 값 → 403 (fail-closed)', async () => {
    const { json } = makeApp({ environment: 'dev-typo' })
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(403)
  })

  test('userEmail 없음 → 401', async () => {
    const { json } = makeApp({ environment: 'staging', userEmail: null })
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(401)
    expect((await body(res)).error).toBe('인증 필요')
  })
})

// ---------------- POST /encrypted: 400 암호 검증 ----------------
describe('POST /encrypted — 암호 검증 400', () => {
  test('JSON 파싱 실패 → 400', async () => {
    const { req } = makeApp({ environment: 'staging' })
    const res = await req('/encrypted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('최소 8자')
  })

  test('body 없이 전송 → 400', async () => {
    const { json } = makeApp({ environment: 'staging' })
    const res = await json('/encrypted', 'POST')
    expect(res.status).toBe(400)
  })

  test('password 필드 없음 → 400', async () => {
    const { json } = makeApp({ environment: 'staging' })
    const res = await json('/encrypted', 'POST', {})
    expect(res.status).toBe(400)
  })

  test('password가 문자열 아님(숫자) → 400', async () => {
    const { json } = makeApp({ environment: 'staging' })
    const res = await json('/encrypted', 'POST', { password: 123456789 })
    expect(res.status).toBe(400)
  })

  test('password 7자 → 400', async () => {
    const { json } = makeApp({ environment: 'staging' })
    const res = await json('/encrypted', 'POST', { password: '1234567' })
    expect(res.status).toBe(400)
  })

  test('빈 문자열 → 400', async () => {
    const { json } = makeApp({ environment: 'staging' })
    const res = await json('/encrypted', 'POST', { password: '' })
    expect(res.status).toBe(400)
  })
})

// ---------------- POST /encrypted: 성공 ----------------
describe('POST /encrypted — 성공', () => {
  test('정확히 8자 암호로 암호화 백업 생성 + 헤더 검증', async () => {
    const { json } = makeApp({ environment: 'staging', db: (() => {
      const db = new MockDb()
      db.batchQueue.push(makeBatchResults({ 0: [{ id: 1, text: 'hello' }], 2: [{ id: 7 }] }))
      return db
    })() })
    const res = await json('/encrypted', 'POST', { password: '12345678' })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.format_version).toBe(1)
    expect(j.algorithm).toBe('AES-256-GCM')
    expect(j.kdf).toBe('PBKDF2-SHA256')
    expect(j.iterations).toBe(100000)
    expect(j.table_count).toBe(35)
    expect(j.total_rows).toBe(2)
    expect(j.salt).toBeTruthy()
    expect(j.iv).toBeTruthy()
    expect(j.ciphertext).toBeTruthy()
    // salt 16바이트, iv 12바이트 base64 디코드 검증
    expect(atob(j.salt).length).toBe(16)
    expect(atob(j.iv).length).toBe(12)
    // 평문 데이터 미포함
    expect(j.tables).toBeUndefined()
    // 캐시 방지 헤더
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(res.headers.get('Pragma')).toBe('no-cache')
    expect(res.headers.get('Content-Disposition')).toContain(
      'myhub-backup-encrypted.json'
    )
  })

  test('암호화 라운드트립: 서버 암호문을 테스트 키로 복호 → 평문 구조 검증', async () => {
    const db = new MockDb()
    db.batchQueue.push(
      makeBatchResults({
        0: [{ id: 1, text: '한글 메모 🎉' }],
        3: [{ id: 9, title: 'todo' }],
      })
    )
    const { json } = makeApp({ environment: 'staging', db })
    const password = 'correct-horse-battery'
    const res = await json('/encrypted', 'POST', { password })
    expect(res.status).toBe(200)
    const plain = await decryptBackup(await body(res), password)
    expect(plain.version).toBe(6)
    expect(plain.method).toBe('db.batch-transaction')
    expect(plain.tables.memos.rows[0].text).toBe('한글 메모 🎉')
    expect(plain.tables.todos.rows[0].title).toBe('todo')
    expect(plain.integrity.table_count).toBe(35)
    expect(plain.integrity.total_rows).toBe(2)
    expect(typeof plain.integrity.duration_ms).toBe('number')
  })

  test('잘못된 암호로는 복호 불가', async () => {
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults({ 0: [{ id: 1 }] }))
    const { json } = makeApp({ environment: 'staging', db })
    const res = await json('/encrypted', 'POST', { password: 'right-password' })
    const j = await body(res)
    await expect(decryptBackup(j, 'wrong-password')).rejects.toThrow()
  })

  test('result.results 없음 → 빈 배열 폴백 (|| [] 분기)', async () => {
    const db = new MockDb()
    const results: any[] = []
    for (let i = 0; i < TABLE_COUNT; i++) results.push({}) // results 필드 없음
    results[0] = { results: [{ id: 1 }] }
    db.batchQueue.push(results)
    const { json } = makeApp({ environment: 'staging', db })
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(200)
    expect((await body(res)).total_rows).toBe(1)
  })

  test('백업 크기 10MB 초과 → 413', async () => {
    const db = new MockDb()
    const big = 'x'.repeat(11 * 1024 * 1024) // 11MB
    db.batchQueue.push(makeBatchResults({ 0: [{ id: 1, data: big }] }))
    const { json } = makeApp({ environment: 'staging', db })
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(413)
    const j = await body(res)
    expect(j.error).toContain('너무 큽니다')
    expect(j.size).toBeGreaterThan(10 * 1024 * 1024)
    expect(j.max_size).toBe(10 * 1024 * 1024)
  })

  test('batch 실패 → 500 (내부 오류 정보 미노출)', async () => {
    const db = new MockDb()
    db.batchQueue.push(new Error('db down'))
    const { json } = makeApp({ environment: 'staging', db })
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('백업 실패')
  })
})

// ---------------- POST / (평문 백업) ----------------
describe('POST / — 평문 백업', () => {
  test('ENVIRONMENT 미설정 → 403 (fail-closed)', async () => {
    const { json } = makeApp({})
    const res = await json('/', 'POST')
    expect(res.status).toBe(403)
  })

  test('ENVIRONMENT=production → 403', async () => {
    const { json } = makeApp({ environment: 'production' })
    const res = await json('/', 'POST')
    expect(res.status).toBe(403)
  })

  test('userEmail 없음 → 401', async () => {
    const { json } = makeApp({ environment: 'staging', userEmail: null })
    const res = await json('/', 'POST')
    expect(res.status).toBe(401)
    expect((await body(res)).error).toBe('인증 필요')
  })

  test('평문 백업 성공: 구조·무결성·헤더 검증', async () => {
    const db = new MockDb()
    db.batchQueue.push(
      makeBatchResults({
        0: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }],
        4: [{ id: 5, filename: 'f.png' }],
      })
    )
    const { json } = makeApp({ environment: 'staging', db })
    const res = await json('/', 'POST')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.version).toBe(3)
    expect(j.method).toBe('db.batch-transaction')
    expect(j.created_at).toBeTruthy()
    expect(Object.keys(j.tables)).toHaveLength(35)
    expect(j.tables.memos.row_count).toBe(2)
    expect(j.tables.memos.rows).toHaveLength(2)
    expect(j.tables.files.row_count).toBe(1)
    expect(j.tables.schedules.row_count).toBe(0)
    expect(j.integrity.table_count).toBe(35)
    expect(j.integrity.total_rows).toBe(3)
    expect(typeof j.integrity.duration_ms).toBe('number')
    // 캐시 방지 헤더 (평문은 Content-Disposition 없음)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(res.headers.get('Pragma')).toBe('no-cache')
    expect(res.headers.get('Content-Disposition')).toBeNull()
  })

  test('35개 테이블 whitelist 순서대로 SELECT * 로 조회', async () => {
    const db = new MockDb()
    db.batchQueue.push(makeBatchResults())
    const { json } = makeApp({ environment: 'staging', db })
    await json('/', 'POST')
    // step-up 게이트(트랙 1)가 auth_pins를 먼저 조회하므로, 백업 테이블
    // 조회(SELECT * FROM ...)만 추려 순서·집합을 검증한다.
    expect(db.calls).toContain('batch:35')
    // 조회 목록은 BACKUP_TABLES의 순서·집합 그대로여야 한다 (목록 자체의
    // 내용 핀은 backup-scope 테스트가 맡는다).
    expect(db.prepares.filter((s) => s.startsWith('SELECT * FROM'))).toEqual(
      BACKUP_TABLES.map((t) => `SELECT * FROM ${t}`)
    )
  })

  test('auth_pins는 평문·암호화 백업 모두에 포함되지 않는다 (오프라인 PIN 추측 차단)', async () => {
    // 카나리아: auth_pins를 BACKUP_TABLES에 다시 넣으면 아래 단언이 전부 깨진다
    // (조회 목록에 나타나고, tables 키에 생기고, table_count가 36이 된다).
    const dbPlain = new MockDb()
    dbPlain.batchQueue.push(makeBatchResults())
    const plainCtx = makeApp({ environment: 'staging', db: dbPlain })
    const resPlain = await plainCtx.json('/', 'POST')
    expect(resPlain.status).toBe(200)
    const jPlain = await body(resPlain)
    expect(jPlain.tables.auth_pins).toBeUndefined()
    expect(Object.keys(jPlain.tables)).not.toContain('auth_pins')
    expect(dbPlain.prepares).not.toContain('SELECT * FROM auth_pins')

    const dbEnc = new MockDb()
    dbEnc.batchQueue.push(makeBatchResults())
    const encCtx = makeApp({ environment: 'staging', db: dbEnc })
    const resEnc = await encCtx.json('/encrypted', 'POST', { password: 'password123' })
    expect(resEnc.status).toBe(200)
    const decrypted = await decryptBackup(await body(resEnc), 'password123')
    expect(decrypted.tables.auth_pins).toBeUndefined()
    expect(Object.keys(decrypted.tables)).not.toContain('auth_pins')
    expect(dbEnc.prepares).not.toContain('SELECT * FROM auth_pins')
  })

  test('result.results 없음 → 빈 배열 폴백 (|| [] 분기)', async () => {
    const db = new MockDb()
    const results: any[] = []
    for (let i = 0; i < TABLE_COUNT; i++) results.push({}) // results 필드 없음
    results[BACKUP_TABLES.indexOf('reminders')] = { results: [{ id: 1 }] }
    db.batchQueue.push(results)
    const { json } = makeApp({ environment: 'staging', db })
    const res = await json('/', 'POST')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.integrity.total_rows).toBe(1)
    expect(j.tables.reminders.row_count).toBe(1)
  })

  test('batch 실패 → 500', async () => {
    const db = new MockDb()
    db.batchQueue.push(new Error('d1 error'))
    const { json } = makeApp({ environment: 'staging', db })
    const res = await json('/', 'POST')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('백업 실패')
  })
})

// ---------------- 백업 발급 step-up 게이트 (트랙 1, GPT 재평가 P0-3) ----------------
// 카나리아 대상: routes.ts의 requireProtectedAccess 집행. 두 핸들러에서
// 게이트를 제거하면 '창 없음 → 403 + batch 미호출' 테스트들이 200을 받아
// 실패해야 한다 (실제 카나리아로 확인함 — 보고 참조).
// MockDb(기본)는 bind().first가 없어 게이트가 면제로 떨어지므로(기존 테스트
// 전제가 그것), 여기서는 auth_pins 조회를 실제로 흉내 내는 전용 DB를 쓴다.
describe('백업 발급 step-up 게이트', () => {
  const PIN_ROW = { pin_hash: 'aGFzaA==', pin_salt: 'c2FsdA==', iterations: 100000 }

  class GateDb {
    batchQueue: any[] = []
    batchCalls = 0
    pinRow: any
    constructor(pinRow: any) {
      this.pinRow = pinRow
    }
    prepare(sql: string) {
      const db = this
      if (sql.includes('auth_pins')) {
        return {
          bind: (..._p: any[]) => ({
            first: async () => db.pinRow,
          }),
          first: async () => db.pinRow,
        }
      }
      // 백업 테이블 조회용 statement 자리표시자
      return { bind: (..._p: any[]) => ({}) }
    }
    async batch(stmts: any[]) {
      this.batchCalls++
      const v = this.batchQueue.shift()
      if (v === undefined) return []
      if (v instanceof Error) throw v
      return v
    }
  }

  function makeGateApp(opts: { pinRow: any; stepUpUntil?: number; environment?: string }) {
    const db = new GateDb(opts.pinRow)
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('userEmail', 'test@example.com')
      if (opts.stepUpUntil !== undefined) (c as any).set('stepUpUntil', opts.stepUpUntil)
      await next()
    })
    app.route('/a', backupApp)
    const env: any = { DB: db, ENVIRONMENT: opts.environment ?? 'staging' }
    const json = (path: string, method: string, bodyArg?: any) =>
      app.request('/a' + (path === '/' ? '' : path), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: bodyArg === undefined ? undefined : JSON.stringify(bodyArg),
      }, env)
    return { json, db }
  }

  test('암호화 발급: PIN 설정 + step-up 창 없음 → 403 STEP_UP_REQUIRED + 데이터 읽기 없음', async () => {
    const { json, db } = makeGateApp({ pinRow: PIN_ROW })
    db.batchQueue.push(makeBatchResults({ 0: [{ id: 1 }] }))
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(403)
    const j = await body(res)
    expect(j.code).toBe('STEP_UP_REQUIRED')
    expect(j.ok).toBe(false)
    // 게이트가 데이터 읽기 전에 막았음을 증명 (batch 미호출, 봉투 미발급)
    expect(db.batchCalls).toBe(0)
    expect(j.ciphertext).toBeUndefined()
  })

  test('암호화 발급: 만료된 step-up 창 → 403', async () => {
    const { json, db } = makeGateApp({ pinRow: PIN_ROW, stepUpUntil: Date.now() - 1000 })
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(403)
    expect((await body(res)).code).toBe('STEP_UP_REQUIRED')
    expect(db.batchCalls).toBe(0)
  })

  test('암호화 발급: 유효한 step-up 창 → 200 + 봉투 형식·포함 테이블 무변경', async () => {
    const { json, db } = makeGateApp({ pinRow: PIN_ROW, stepUpUntil: Date.now() + 5 * 60 * 1000 })
    db.batchQueue.push(makeBatchResults({ 0: [{ id: 1, text: 'hello' }] }))
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.format_version).toBe(1)
    expect(j.algorithm).toBe('AES-256-GCM')
    expect(j.kdf).toBe('PBKDF2-SHA256')
    expect(j.table_count).toBe(35)
    expect(j.total_rows).toBe(1)
    const plain = await decryptBackup(j, 'password123')
    expect(Object.keys(plain.tables)).toHaveLength(35)
    expect(plain.tables.memos.rows[0].text).toBe('hello')
    expect(plain.tables.auth_pins).toBeUndefined()
  })

  test('암호화 발급: PIN 미설정 → 면제 (창 없어도 200, lockout 방지)', async () => {
    const { json, db } = makeGateApp({ pinRow: null })
    db.batchQueue.push(makeBatchResults({ 0: [{ id: 1 }] }))
    const res = await json('/encrypted', 'POST', { password: 'password123' })
    expect(res.status).toBe(200)
    expect((await body(res)).total_rows).toBe(1)
  })

  test('평문 발급: PIN 설정 + step-up 창 없음 → 403 STEP_UP_REQUIRED + 데이터 읽기 없음', async () => {
    const { json, db } = makeGateApp({ pinRow: PIN_ROW })
    db.batchQueue.push(makeBatchResults())
    const res = await json('/', 'POST')
    expect(res.status).toBe(403)
    expect((await body(res)).code).toBe('STEP_UP_REQUIRED')
    expect(db.batchCalls).toBe(0)
  })

  test('평문 발급: 유효한 step-up 창 → 200 + 구조 무변경', async () => {
    const { json, db } = makeGateApp({ pinRow: PIN_ROW, stepUpUntil: Date.now() + 5 * 60 * 1000 })
    db.batchQueue.push(makeBatchResults({ 0: [{ id: 1, text: 'a' }] }))
    const res = await json('/', 'POST')
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.version).toBe(3)
    expect(Object.keys(j.tables)).toHaveLength(35)
    expect(j.integrity.total_rows).toBe(1)
  })
})
