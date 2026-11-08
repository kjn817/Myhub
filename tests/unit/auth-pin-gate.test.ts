/**
 * auth/pin-lock-gate-stale-read (run-002 medium) 수정 + low 3건 검증
 * - PIN 잠금 게이트를 SELECT 판정이 아니라 PBKDF2 검증 전 조건부 UPDATE 선점으로
 *   원자화했는지 검증한다 (remediation: /verify :423 패턴과 동일).
 * - run-002 low auth/pin-failcount-no-decay: 만료된 잠금 뒤 fail_count 재시작.
 * - run-002 low auth/lockout-dos-verify-pin-residual (PIN 절반): 잠금 중에도 정답 PIN은 성공.
 * - run-003 low auth/pin-gate-failure-leaves-lock: 게이트 이후 예외 시 보상 UPDATE +
 *   손상된 salt/hash 사전 검증.
 * - 상태 저장 Mock D1: 단일 UPDATE 문을 원자적으로 적용한다 (D1/SQLite 의미 모델링).
 *   run() 본문에 await가 없어 호출 시점에 동기적으로 상태가 갱신되므로,
 *   Promise.all 버스트에서도 게이트 UPDATE들이 PBKDF2 전에 순서대로 직렬화된다.
 *   이는 실제 D1의 단일 문장 원자성과 같은 모델이다.
 * - 각 요청에 서로 다른 CF-Connecting-IP를 줘서 pinip 속도 제한(10회/시간/IP)이
 *   게이트 검증에 간섭하지 않게 한다 (run-002 재현과 동일한 조건).
 * - 속도 제한 UPSERT·세션 버전 조회는 Mock이 항상 허용(버전 0)으로 모델링한다.
 *   속도 제한 자체의 원자성은 tests/integration/auth-0051-real.test.js에서
 *   실제 SQLite로 검증한다.
 * - 한계 (p0-pin-lock-verify에서 명시): 이 Mock은 게이트 UPDATE의 의미를 JS로
 *   재구현하므로, 실제 SQL 문자열의 의미 회귀(예: 게이트 WHERE 조건 삭제)는
 *   이 파일에서 잡히지 않는다. 그 회귀는 실제 SQL을 실행하는
 *   tests/integration/auth-0051-real.test.js의 동시 버스트 테스트가 잡는다
 *   (카나리아로 확인됨). 반대로 핸들러가 게이트 실패(changes=0)를 무시하는
 *   회귀는 이 파일의 버스트 테스트가 잡는다 (카나리아로 확인됨).
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import { authApp, hashPin } from '../../src/modules/auth/routes'

type PinRow = {
  pin_hash: string
  pin_salt: string
  iterations: number
  fail_count: number
  locked_until: string | null
}

class StatefulMockDb {
  row: PinRow | null
  version = 0
  calls: { sql: string; params: any[] }[] = []
  /** 게이트 선점 UPDATE의 결과 기록 (true=changes 1 선점 성공, false=changes 0 차단) */
  gateOutcomes: boolean[] = []

  constructor(row: PinRow | null) {
    this.row = row ? { ...row } : null
  }

  prepare(sql: string) {
    const db = this
    return {
      bind: (...params: any[]) => ({
        first: async () => {
          db.calls.push({ sql, params })
          // 세션 버전 bump: UPDATE ... RETURNING version
          if (sql.includes('UPDATE session_versions SET version = version + 1')) {
            db.version += 1
            return { version: db.version }
          }
          if (sql.includes('SELECT version FROM session_versions')) {
            return { version: db.version }
          }
          if (!sql.includes('FROM auth_pins')) return null
          return db.row ? { ...db.row } : null
        },
        run: async () => {
          db.calls.push({ sql, params })
          // 속도 제한 UPSERT·세션 버전 INSERT: 항상 허용으로 모델링
          if (sql.includes('INSERT INTO rate_limits') || sql.includes('INSERT OR IGNORE INTO session_versions')) {
            return { meta: { changes: 1 } }
          }
          // 게이트 선점 UPDATE: 만료된 잠금 뒤 fail_count를 1로 재시작하는 CASE 식
          if (sql.includes('UPDATE auth_pins SET fail_count = CASE')) {
            if (!db.row) { db.gateOutcomes.push(false); return { meta: { changes: 0 } } }
            const nowIso: string = params[5]
            if (db.row.locked_until && db.row.locked_until > nowIso) {
              db.gateOutcomes.push(false)
              return { meta: { changes: 0 } }
            }
            const expired = db.row.locked_until !== null && db.row.locked_until <= nowIso
            const next = expired ? 1 : db.row.fail_count + 1
            db.row.fail_count = next
            if (next >= params[2]) {
              db.row.locked_until = new Date(Date.now() + 900_000).toISOString()
            } else if (expired) {
              db.row.locked_until = null
            }
            db.gateOutcomes.push(true)
            return { meta: { changes: 1 } }
          }
          // 성공 시 초기화 UPDATE
          if (sql.includes('UPDATE auth_pins SET fail_count = 0')) {
            if (db.row) {
              db.row.fail_count = 0
              db.row.locked_until = null
            }
            return { meta: { changes: 1 } }
          }
          // 보상 UPDATE: 선점한 실패 1회를 되돌린다
          if (sql.includes('MAX(fail_count - 1, 0)')) {
            if (db.row) {
              db.row.fail_count = Math.max(db.row.fail_count - 1, 0)
              if (db.row.fail_count < params[0]) db.row.locked_until = null
            }
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 1 } }
        },
      }),
    }
  }
}

class MockKv {
  store = new Map<string, string>()
  async get(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async put(key: string, value: string, opts?: any) {
    this.store.set(key, value)
  }
}

function makeApp(db: StatefulMockDb) {
  const kv = new MockKv()
  const app = new Hono()
  app.route('/a', authApp)
  const env: any = {
    DB: db,
    KV: kv,
    SESSION_SECRET: 'test-secret-1234567890',
    ENVIRONMENT: 'production',
    RESEND_API_KEY: 're_test_key',
  }
  const json = (path: string, method: string, body?: any, headers?: Record<string, string>) =>
    app.request('/a' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
  return { json, db, kv }
}

async function pinRow(pin: string, failCount = 0, lockedUntil: string | null = null): Promise<PinRow> {
  const h = await hashPin(pin)
  return { pin_hash: h.hashB64, pin_salt: h.saltB64, iterations: h.iterations, fail_count: failCount, locked_until: lockedUntil }
}

describe('PIN 잠금 게이트 선점 (run-002 medium auth/pin-lock-gate-stale-read)', () => {
  jest.setTimeout(30000)

  test('게이트 UPDATE가 만료 재시작 CASE를 단 원자 UPDATE다', async () => {
    const db = new StatefulMockDb(await pinRow('135790'))
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135791' }, { 'CF-Connecting-IP': '10.0.0.1' })
    expect(res.status).toBe(401)
    const gate = db.calls.find((c) => c.sql.includes('UPDATE auth_pins SET fail_count = CASE'))
    expect(gate).toBeDefined()
    expect(gate!.sql).toContain('locked_until <= ?')
    expect(gate!.sql).toContain("'+900 seconds'")
    expect(gate!.sql).toContain('THEN 1 ELSE fail_count + 1 END')
    // 실패 시 추가 증가 UPDATE는 없어야 한다 (게이트 선점이 유일한 증가)
    expect(db.calls.filter((c) => c.sql.includes('UPDATE auth_pins SET fail_count = CASE'))).toHaveLength(1)
    expect(db.row!.fail_count).toBe(1)
  })

  test('동시 오답 10개 → 401은 5개, 429는 5개, fail_count=5로 잠금', async () => {
    const db = new StatefulMockDb(await pinRow('135790'))
    const { json } = makeApp(db)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.0.1.${i + 1}` })),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(5)
    expect(db.row!.fail_count).toBe(5)
    expect(db.row!.locked_until).not.toBeNull()
    expect(new Date(db.row!.locked_until!).getTime()).toBeGreaterThan(Date.now())
  })

  test('동시 오답 20개 → 401은 5개, 429는 15개 (run-002 20-버스트 재현)', async () => {
    const db = new StatefulMockDb(await pinRow('135790'))
    const { json } = makeApp(db)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.0.2.${i + 1}` })),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(15)
    expect(db.row!.fail_count).toBe(5)
  })

  test('순차 오답 대조군 → 401×5 후 6번째 429, fail_count=5', async () => {
    const db = new StatefulMockDb(await pinRow('135790'))
    const { json } = makeApp(db)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': '10.0.3.1' })
      statuses.push(res.status)
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
    expect(db.row!.fail_count).toBe(5)
    expect(db.row!.locked_until).not.toBeNull()
  })

  test('정답 PIN은 게이트를 통과하고 fail_count를 0으로 초기화한다', async () => {
    const db = new StatefulMockDb(await pinRow('135790', 2, null))
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.0.4.1' })
    expect(res.status).toBe(200)
    expect(db.row!.fail_count).toBe(0)
    expect(db.row!.locked_until).toBeNull()
    // 초기화됐으므로 다시 5회 오답까지 401, 6번째 429
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = await json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.0.4.${i + 2}` })
      statuses.push(r.status)
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
  })

  test('fail_count=4에서 정답 → 200, 잠금 없이 fail_count=0 (게이트 선점분 초기화)', async () => {
    const db = new StatefulMockDb(await pinRow('135790', 4, null))
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.0.5.1' })
    expect(res.status).toBe(200)
    // 게이트가 fail_count를 5로 올리며 잠금을 걸었다가 성공 초기화가 풀어야 한다
    expect(db.row!.fail_count).toBe(0)
    expect(db.row!.locked_until).toBeNull()
  })

  test('이미 잠긴 상태 + 오답 → 429, 게이트 UPDATE도 실행 안 함', async () => {
    const lockedUntil = new Date(Date.now() + 900_000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, lockedUntil))
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': '10.0.6.1' })
    expect(res.status).toBe(429)
    expect(db.calls.filter((c) => c.sql.includes('UPDATE auth_pins'))).toHaveLength(0)
    expect(db.row!.fail_count).toBe(5)
  })

  test('이미 잠긴 상태 + 정답 PIN → 200, 잠금 해제 (lockout-dos 수정)', async () => {
    const lockedUntil = new Date(Date.now() + 900_000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, lockedUntil))
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.0.6.2' })
    expect(res.status).toBe(200)
    expect(db.row!.fail_count).toBe(0)
    expect(db.row!.locked_until).toBeNull()
  })

  test('버스트 후 잠금: 오답은 429, 정답은 200 (소진 DoS 불가)', async () => {
    const db = new StatefulMockDb(await pinRow('135790'))
    const { json } = makeApp(db)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.0.7.${i + 1}` })),
    )
    expect(db.row!.locked_until).not.toBeNull()
    const wrongAfter = await json('/pin-login', 'POST', { pin: '000001' }, { 'CF-Connecting-IP': '10.0.7.99' })
    expect(wrongAfter.status).toBe(429)
    const rightAfter = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.0.7.100' })
    expect(rightAfter.status).toBe(200)
    expect(db.row!.fail_count).toBe(0)
  })
})

describe('PIN 카운터 만료 재시작 (run-002 low auth/pin-failcount-no-decay)', () => {
  jest.setTimeout(30000)

  test('잠금 만료 후 오답 1개 → fail_count가 1로 재시작, 잠금 없음', async () => {
    const expired = new Date(Date.now() - 1000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, expired))
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': '10.0.8.1' })
    expect(res.status).toBe(401)
    expect(db.row!.fail_count).toBe(1)
    expect(db.row!.locked_until).toBeNull()
  })

  test('잠금 만료 후 오답 5개 → 401×5 후 6번째 429 (재연장 불가 확인)', async () => {
    const expired = new Date(Date.now() - 1000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, expired))
    const { json } = makeApp(db)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = await json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.0.8.${i + 2}` })
      statuses.push(r.status)
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
    expect(db.row!.fail_count).toBe(5)
  })

  test('잠금 만료 직후 정답 → 200 + fail_count=0', async () => {
    const expired = new Date(Date.now() - 1000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, expired))
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.0.8.20' })
    expect(res.status).toBe(200)
    expect(db.row!.fail_count).toBe(0)
    expect(db.row!.locked_until).toBeNull()
  })
})

describe('게이트 선점 후 예외 보상 (run-003 low auth/pin-gate-failure-leaves-lock)', () => {
  test('손상된 salt 행 → 게이트 선점 없이 500, fail_count·잠금 불변', async () => {
    const row = await pinRow('135790', 4, null)
    row.pin_salt = '!!!not-base64!!!'
    const db = new StatefulMockDb(row)
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.0.9.1' })
    expect(res.status).toBe(500)
    expect(db.calls.filter((c) => c.sql.includes('UPDATE auth_pins'))).toHaveLength(0)
    expect(db.row!.fail_count).toBe(4)
    expect(db.row!.locked_until).toBeNull()
  })

  test('손상된 hash 행 → 게이트 선점 없이 500', async () => {
    const row = await pinRow('135790', 0, null)
    row.pin_hash = '%%bad%%'
    const db = new StatefulMockDb(row)
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.0.9.2' })
    expect(res.status).toBe(500)
    expect(db.calls.filter((c) => c.sql.includes('UPDATE auth_pins'))).toHaveLength(0)
  })
})

describe('PIN 잠금 게이트 — 경계·동시성 확장 (p0-pin-lock-verify)', () => {
  jest.setTimeout(30000)

  test('동시 버스트 fail_count=3에서 시작 → 401 정확히 2, 429 8, 게이트 선점 성공 2회만', async () => {
    const db = new StatefulMockDb(await pinRow('135790', 3, null))
    const { json } = makeApp(db)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.1.1.${i + 1}` })),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(2)
    expect(statuses.filter((s) => s === 429)).toHaveLength(8)
    // 게이트를 통과한(검증까지 간) 요청 = 401 개수와 정확히 일치해야 한다.
    // 429 응답은 게이트 changes=0 → 검증 없이 반환된 것이다.
    expect(db.gateOutcomes.filter(Boolean)).toHaveLength(2)
    expect(db.gateOutcomes.filter((o) => !o)).toHaveLength(8)
    expect(db.row!.fail_count).toBe(5)
    expect(db.row!.locked_until).not.toBeNull()
  })

  test('동시 버스트 fail_count=4에서 시작 → 401 정확히 1, 429 9 (경계값)', async () => {
    const db = new StatefulMockDb(await pinRow('135790', 4, null))
    const { json } = makeApp(db)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.1.2.${i + 1}` })),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(1)
    expect(statuses.filter((s) => s === 429)).toHaveLength(9)
    expect(db.gateOutcomes.filter(Boolean)).toHaveLength(1)
    expect(db.row!.fail_count).toBe(5)
    expect(db.row!.locked_until).not.toBeNull()
  })

  test('잠금 만료 직후 동시 버스트 10 → 재시작 후에도 401은 5개만, 새 잠금이 걸린다', async () => {
    const expired = new Date(Date.now() - 1000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, expired))
    const { json } = makeApp(db)
    const before = Date.now()
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.1.3.${i + 1}` })),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(5)
    expect(db.gateOutcomes.filter(Boolean)).toHaveLength(5)
    expect(db.row!.fail_count).toBe(5)
    // 새 잠금은 지금부터 대략 +15분 — 만료된 옛 잠금이 그대로 남은 것이 아니어야 한다
    const lockedMs = new Date(db.row!.locked_until!).getTime()
    expect(lockedMs).toBeGreaterThan(before)
    expect(lockedMs).toBeLessThanOrEqual(Date.now() + 900_000 + 5000)
  })

  test('잠금 중 동시 오답 버스트 10 → 전부 429, fail_count·locked_until 완전 불변', async () => {
    const lockedUntil = new Date(Date.now() + 900_000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, lockedUntil))
    const { json } = makeApp(db)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.1.4.${i + 1}` })),
    )
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(429))
    expect(db.row!.fail_count).toBe(5)
    // 문자열까지 동일 — 잠금이 연장되거나 다시 걸리지 않았다
    expect(db.row!.locked_until).toBe(lockedUntil)
    expect(db.calls.filter((c) => c.sql.includes('UPDATE auth_pins'))).toHaveLength(0)
  })

  test('버스트로 잠금된 뒤 추가 오답 3개 → 429이고 locked_until이 연장되지 않는다', async () => {
    const db = new StatefulMockDb(await pinRow('135790'))
    const { json } = makeApp(db)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.1.5.${i + 1}` })),
    )
    const lockedUntil = db.row!.locked_until
    expect(lockedUntil).not.toBeNull()
    for (let i = 0; i < 3; i++) {
      const r = await json('/pin-login', 'POST', { pin: '000001' }, { 'CF-Connecting-IP': `10.1.5.${20 + i}` })
      expect(r.status).toBe(429)
    }
    expect(db.row!.fail_count).toBe(5)
    expect(db.row!.locked_until).toBe(lockedUntil)
  })

  test('동시 오답 3 (상한 미만) → 전부 401·fail_count=3·잠금 없음, 이어서 정답 → 200·0 초기화', async () => {
    const db = new StatefulMockDb(await pinRow('135790'))
    const { json } = makeApp(db)
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.1.6.${i + 1}` })),
    )
    expect(results.map((r) => r.status)).toEqual([401, 401, 401])
    expect(db.row!.fail_count).toBe(3)
    expect(db.row!.locked_until).toBeNull()
    const ok = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.1.6.10' })
    expect(ok.status).toBe(200)
    expect(db.row!.fail_count).toBe(0)
    expect(db.row!.locked_until).toBeNull()
  })
})
