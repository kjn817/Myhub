/// <reference types="jest" />
/**
 * 키 로테이션 보안 성질 (2026-11-01 트랙 1 — GPT 6차 지적 대응)
 *
 * 검증 성질:
 * 1. 키 값 유출 방지: POST /api/key-rotation/* 로 보낸 newKey/rotatedKey가
 *    서버 로그(console.*)·응답 본문·DB(ai_error_log 포함)·암호문 저장소에
 *    평문으로 남지 않는다. 카나리아 키를 실제 엔드포인트에 흘려 전수 대조
 *    한다 — 라우트가 본문을 로그에 찍도록 바뀌면 이 테스트가 실패한다.
 * 2. 마스킹 라이브러리(src/lib/redact.ts): 민감 필드 이름은 값과 무관하게
 *    가려지고, 알려진 비밀 값은 문자열 중간에 섞여 있어도 지워진다.
 *    마스킹을 항등 함수로 깨면 단위 테스트가 실패한다 (카나리아).
 * 3. 로테이션 전용 step-up 신선도: PIN 입력 후 2분이 지난 창은 보호 메모
 *    공용 게이트(requireProtectedAccess)는 통과해도 로테이션은 거부된다.
 *    신선도 검사를 지우면 'stale' 케이스가 200이 돼 실패한다 (카나리아).
 *    다른 사용처의 게이트 판정은 변하지 않음을 함께 고정한다.
 */
import { Hono } from 'hono'
import { createTestDb } from '../mcp-d1'
import { encryptContent } from '../../src/services/crypto'
import { keyRotationApp, requireRotationStepUp, ROTATION_STEP_UP_MAX_AGE_MS } from '../../src/modules/key-rotation/routes'
import { requireProtectedAccess } from '../../src/modules/memo/routes'
import { hashPin, STEP_UP_TTL_MS } from '../../src/modules/auth/routes'
import { redactForLog, redactKnownSecrets, stringifyForLog, REDACTED } from '../../src/lib/redact'

const OLD_KEY = 'old-test-key-material-0001'
const CANARY_NEW = 'CANARY-NEW-KEY-9f27c1d4e8a04b6f'
const CANARY_THIRD = 'CANARY-THIRD-KEY-51aa09b3c7d24e88'
const PLAIN_MEMO = '비밀 메모 본문 🔐'
/** makeApp이 만드는 항목의 센서스 — 비-dry-run 실행의 expectedCensus (11-07 계약) */
const SEED_CENSUS = { memo_text: 1, memo_block: 0, google_token_row: 0, locked_file: 0 }

describe('redact — 로그 마스킹 라이브러리', () => {
  test('민감 필드 이름은 중첩·배열 안에서도 값과 무관하게 가려지고, 일반 필드는 보존되며, 원본은 불변이다', () => {
    const input = {
      mode: 'rotate',
      body: { newKey: CANARY_NEW, dryRun: true },
      list: [{ password: 'p@ss', note: 'keep-me' }, { rotatedKey: CANARY_THIRD }],
      headers: { Authorization: 'Bearer abc', 'x-api-key': 'k', 'Content-Type': 'application/json' },
      pin: '123456',
      count: 4,
    }
    const snapshot = JSON.stringify(input)
    const out: any = redactForLog(input)
    expect(out.body.newKey).toBe(REDACTED)
    expect(out.list[0].password).toBe(REDACTED)
    expect(out.list[0].note).toBe('keep-me')
    expect(out.list[1].rotatedKey).toBe(REDACTED)
    expect(out.headers.Authorization).toBe(REDACTED)
    expect(out.headers['x-api-key']).toBe(REDACTED)
    expect(out.headers['Content-Type']).toBe('application/json')
    expect(out.pin).toBe(REDACTED)
    expect(out.mode).toBe('rotate')
    expect(out.count).toBe(4)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(JSON.stringify(out)).not.toContain(CANARY_NEW)
    expect(JSON.stringify(out)).not.toContain(CANARY_THIRD)
  })

  test('알려진 비밀 값은 문자열 중간(예외 메시지 등)에 섞여 있어도 지워진다', () => {
    const msg = `decrypt failed for key ${CANARY_NEW} at stage preflight (${CANARY_NEW})`
    const out = redactKnownSecrets(msg, [CANARY_NEW])
    expect(out).not.toContain(CANARY_NEW)
    expect(out).toContain(REDACTED)
    // 짧은 값(오탐 방지 기준 미만)은 건드리지 않는다
    expect(redactKnownSecrets('abc abc', ['abc'])).toBe('abc abc')
  })

  test('stringifyForLog는 본문 모양 객체를 넣어도 카나리아를 남기지 않고, 순환 참조에서도 던지지 않는다', () => {
    const circ: any = { mode: 'rotate', newKey: CANARY_NEW }
    circ.self = circ
    const line = stringifyForLog(circ, [CANARY_NEW])
    expect(line).not.toContain(CANARY_NEW)
    expect(line).toContain('"mode":"rotate"')
    // 값 기준 스캔: 민감 이름이 아닌 필드에 값이 실려도 지워진다
    const line2 = stringifyForLog({ error: `boom ${CANARY_THIRD}` }, [CANARY_THIRD])
    expect(line2).not.toContain(CANARY_THIRD)
  })
})

describe('키 로테이션 엔드포인트 — 키 값 유출 전수 대조 + 신선도', () => {
  async function makeApp(opts: { withPin?: boolean; stepUpUntil?: number | null } = {}) {
    const { db, d1 } = createTestDb()
    if (opts.withPin !== false) {
      const { hashB64, saltB64, iterations } = await hashPin('135790')
      db.prepare("INSERT INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')")
        .run('admin@example.com', hashB64, saltB64, iterations)
    }
    const encMemo = await encryptContent({ MEMO_ENCRYPTION_KEY: OLD_KEY }, PLAIN_MEMO)
    db.prepare("INSERT INTO memos (id, text, is_locked) VALUES (1, ?, 1)").run(encMemo)
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('userEmail', 'admin@example.com')
      if (opts.stepUpUntil) (c as any).set('stepUpUntil', opts.stepUpUntil)
      await next()
    })
    app.route('/kr', keyRotationApp)
    const env: any = { DB: d1, MEMO_ENCRYPTION_KEY: OLD_KEY, ENVIRONMENT: 'staging' }
    const post = (path: string, body: any) =>
      app.request('/kr' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, env)
    return { post, db, d1 }
  }

  test('dry-run·실행·롤백·preflight 실패 전 경로에서 카나리아 키가 로그·응답·DB 어디에도 남지 않는다', async () => {
    const { post, db } = await makeApp({ stepUpUntil: Date.now() + STEP_UP_TTL_MS })
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const bodies: string[] = []
    try {
      const r1 = await post('/rotate', { newKey: CANARY_NEW, newKeyConfirm: CANARY_NEW, dryRun: true })
      bodies.push(await r1.text())
      expect(r1.status).toBe(200)
      const r2 = await post('/rotate', { newKey: CANARY_NEW, newKeyConfirm: CANARY_NEW, dryRun: false, expectedCensus: SEED_CENSUS })
      bodies.push(await r2.text())
      expect(r2.status).toBe(200)
      // 전환 완료 상태에서 제3의 키로 다시 돌리면 preflight 실패(409) 경로
      const r3 = await post('/rotate', { newKey: CANARY_THIRD, newKeyConfirm: CANARY_THIRD, dryRun: false, expectedCensus: SEED_CENSUS })
      bodies.push(await r3.text())
      expect(r3.status).toBe(409)
      const r4 = await post('/rollback', { rotatedKey: CANARY_NEW, dryRun: false, expectedCensus: SEED_CENSUS })
      bodies.push(await r4.text())
      expect(r4.status).toBe(200)
    } finally {
      const logged = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n')
      logSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore()
      // 로그: 로테이션 로그가 실제로 찍혔는지(빈 대조가 아닌지)부터 확인
      expect(logged).toContain('[KeyRotation]')
      expect(logged).not.toContain(CANARY_NEW)
      expect(logged).not.toContain(CANARY_THIRD)
    }
    for (const b of bodies) {
      expect(b).not.toContain(CANARY_NEW)
      expect(b).not.toContain(CANARY_THIRD)
      expect(b).not.toContain(PLAIN_MEMO)
    }
    // DB: 암호문 저장소와 오류 로그 테이블에 평문 키가 없다
    const memo = db.prepare('SELECT text FROM memos WHERE id = 1').get() as any
    expect(memo.text).not.toContain(CANARY_NEW)
    const errCount = db.prepare("SELECT COUNT(*) AS n FROM ai_error_log WHERE error LIKE '%CANARY%'").get() as any
    expect(errCount.n).toBe(0)
  })

  test('신선한 창(방금 발급)은 실행을 허용한다', async () => {
    const { post } = await makeApp({ stepUpUntil: Date.now() + STEP_UP_TTL_MS })
    const res = await post('/rotate', { newKey: CANARY_NEW, newKeyConfirm: CANARY_NEW, dryRun: true })
    expect(res.status).toBe(200)
  })

  test('창은 살아 있지만 발급 4분 경과 → 로테이션은 403 STEP_UP_REQUIRED (공용 게이트는 통과 — 영향 분리 카나리아)', async () => {
    const staleUntil = Date.now() + 1 * 60 * 1000 // 발급 4분 전, 만료까지 1분
    const { post, d1 } = await makeApp({ stepUpUntil: staleUntil })
    const res = await post('/rotate', { newKey: CANARY_NEW, newKeyConfirm: CANARY_NEW, dryRun: true })
    expect(res.status).toBe(403)
    const j = (await res.json()) as any
    expect(j.code).toBe('STEP_UP_REQUIRED')
    expect(j.error).toBe('step_up_fresh_required')
    // 같은 컨텍스트로 공용 게이트(보호 메모·백업 사용처)는 여전히 통과한다 —
    // 신선도는 로테이션 전용으로 분리돼 있다.
    const fakeC: any = {
      env: { DB: d1 },
      get: (k: string) => (k === 'userEmail' ? 'admin@example.com' : k === 'stepUpUntil' ? staleUntil : undefined),
    }
    expect((await requireProtectedAccess(fakeC)).ok).toBe(true)
    expect((await requireRotationStepUp(fakeC)).ok).toBe(false)
  })

  test('신선도 경계: 상한 1초 전은 허용, 1초 초과하면 거부 (시각 주입)', async () => {
    // 공용 게이트는 실제 시계로 창 만료를 보므로 발급 시각은 실제 now 기준,
    // 경계는 requireRotationStepUp의 now 주입으로 ±1초 여유를 두고 판정한다.
    const { d1 } = await makeApp({})
    const issuedAt = Date.now()
    const fakeC: any = {
      env: { DB: d1 },
      get: (k: string) =>
        k === 'userEmail' ? 'admin@example.com' : k === 'stepUpUntil' ? issuedAt + STEP_UP_TTL_MS : undefined,
    }
    expect((await requireRotationStepUp(fakeC, issuedAt + ROTATION_STEP_UP_MAX_AGE_MS - 1000)).ok).toBe(true)
    expect((await requireRotationStepUp(fakeC, issuedAt + ROTATION_STEP_UP_MAX_AGE_MS + 1000)).ok).toBe(false)
  })

  test('건수 필드(google_token_row 등)는 이름에 token이 있어도 마스킹되지 않는다 (로그 가독성 오탐 방지)', () => {
    const out: any = redactForLog({ rotated: { memo_text: 4, google_token_row: 1 }, token_count: 2 })
    expect(out.rotated.google_token_row).toBe(1)
    expect(out.token_count).toBe(2)
  })

  test('PIN 미설정 계정은 신선도 검사도 면제된다 (기존 lockout 방지 정책 유지)', async () => {
    const { post } = await makeApp({ withPin: false, stepUpUntil: null })
    const res = await post('/rotate', { newKey: CANARY_NEW, newKeyConfirm: CANARY_NEW, dryRun: true })
    expect(res.status).toBe(200)
  })
})
