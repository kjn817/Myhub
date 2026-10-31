/**
 * src/modules/ai/feedback.ts 단위 테스트
 * - Mock D1 (prepare/bind/first/all/run 큐 기반)
 * - Hono app.request()로 HTTP 시뮬레이션, /a 에 마운트
 * - userEmail은 마운트 전 미들웨어로 주입 (미들웨어 생략 → 401 분기)
 *
 * 커버리지 대상:
 *   PUT /                    — 403(invalid-origin), 401, 400(입력 검증 5종),
 *                              404(메시지 검증 2종), INSERT/UPDATE/UPSERT/UNIQUE 재시도/500
 *   DELETE /:messageId        — 403, 401, 400, 성공(멱등)
 *   GET /:messageId           — 401, 400, 조회 있음/없음
 *   GET /stats/:personaId     — 401, 400(invalid-persona), 통계/사유 집계, 0건
 * 내부 함수(checkOrigin/getUserId/validateMessage)는 라우트 경유로 커버.
 *
 * 데드코드(소스 미수정, 문서화용):
 *   - MAX_BODY_SIZE 상수: 선언만 되고 사용되지 않음
 *   - checkOrigin의 `c.req.header('Host') || ''`: 테스트 요청의 Host는 항상 존재
 *   - validateMessage의 userId 파라미터: 소유권 검사가 주석으로만 있고 실제 미사용
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import { feedbackApp } from '../../src/modules/ai/feedback'

// ---------------- Mock D1 (큐 기반) ----------------
class MockDb {
  queue: any[] = []
  prepares: string[] = []
  prepare(sql: string) {
    this.prepares.push(sql)
    const db = this
    const next = () => {
      const v = db.queue.shift()
      // 문자열 큐 항목은 throw 값으로 취급 (e.message 없는 throw 경로 커버용)
      if (v instanceof Error || typeof v === 'string') throw v
      return v
    }
    return {
      bind: (..._params: any[]) => ({
        first: async () => next() ?? null,
        all: async () => next() ?? { results: [] },
        run: async () => next() ?? { success: true, meta: {} },
      }),
    }
  }
}

function makeApp(opts: { db?: MockDb; userEmail?: any } = {}) {
  const db = opts.db ?? new MockDb()
  const app = new Hono()
  // userEmail === undefined 이면 미들웨어를 달지 않아 401 분기 검증
  if (opts.userEmail !== undefined) {
    const email = opts.userEmail
    app.use('*', async (c, next) => {
      ;(c as any).set('userEmail', email)
      await next()
    })
  }
  app.route('/a', feedbackApp)
  const env: any = { DB: db }
  const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
  return { db, req }
}

const putJson = (
  t: ReturnType<typeof makeApp>,
  body: any,
  headers: Record<string, string> = {}
) =>
  t.req('', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const assistantMsg = { id: 5, role: 'assistant', persona_id: 'concierge', conversation_id: 1 }

// Hono 테스트 요청의 Host 헤더는 기본 undefined → 일치 케이스는 Host 명시
const EVIL_ORIGIN = 'https://evil.example.com'

// ============================================================
// PUT / — CSRF Origin 검사
// ============================================================
describe('PUT / — Origin 검사', () => {
  test('Origin/Referer 없으면 허용 (400으로 진행, 403 아님)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await putJson(t, {})
    expect(res.status).toBe(400) // invalid-message-id — Origin 통과 증거
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('일치하는 Origin이면 허용 (Host 명시)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    // Hono 테스트 요청의 Host 헤더는 기본 undefined이므로 명시 설정
    const res = await putJson(t, {}, { Host: 'myhost.example', Origin: 'http://myhost.example' })
    expect(res.status).toBe(400) // invalid-message-id — Origin 통과 증거
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('불일치 Origin이면 403 invalid-origin', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await putJson(t, {}, { Origin: EVIL_ORIGIN })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('invalid-origin')
  })

  test('파싱 불가 Origin이면 403 (checkUrl catch 분기)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await putJson(t, {}, { Origin: 'not a url' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('invalid-origin')
  })

  test('Origin 없이 일치하는 Referer만 있으면 허용 (Host 명시)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await putJson(
      t,
      {},
      { Host: 'myhost.example', Referer: 'http://myhost.example/chat.html' }
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('Origin 없이 불일치 Referer면 403', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await putJson(t, {}, { Referer: EVIL_ORIGIN + '/x' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('invalid-origin')
  })
})

// ============================================================
// PUT / — 인증
// ============================================================
describe('PUT / — 인증', () => {
  test('userEmail 없으면 401 unauthorized', async () => {
    const t = makeApp() // 미들웨어 없음
    const res = await putJson(t, { messageId: 1, value: 'like' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  test('userEmail이 문자열이 아니면 401 (getUserId typeof 분기)', async () => {
    const t = makeApp({ userEmail: 123 as any })
    const res = await putJson(t, { messageId: 1, value: 'like' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })
})

// ============================================================
// PUT / — 입력 검증
// ============================================================
describe('PUT / — 입력 검증', () => {
  const setup = () => makeApp({ userEmail: 'u@example.com' })

  test('본문 없으면 invalid-message-id', async () => {
    const res = await putJson(setup(), {})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('messageId가 숫자가 아니면 invalid-message-id', async () => {
    const res = await putJson(setup(), { messageId: 'abc', value: 'like' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('JSON 파싱 실패 시 invalid-message-id (json catch 분기)', async () => {
    const t = setup()
    const res = await t.req('', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken json',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('value가 like/dislike가 아니면 invalid-value', async () => {
    const res = await putJson(setup(), { messageId: 5, value: 'love' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-value')
  })

  test('value 누락도 invalid-value', async () => {
    const res = await putJson(setup(), { messageId: 5 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-value')
  })

  test('알 수 없는 reasonCode면 invalid-reason', async () => {
    const res = await putJson(setup(), { messageId: 5, value: 'dislike', reasonCode: 'bogus' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-reason')
  })

  test('like에 reasonCode가 있으면 reason-only-for-dislike', async () => {
    const res = await putJson(setup(), { messageId: 5, value: 'like', reasonCode: 'other' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('reason-only-for-dislike')
  })
})

// ============================================================
// PUT / — 메시지 검증
// ============================================================
describe('PUT / — 메시지 검증', () => {
  test('메시지 없으면 404 message-not-found', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(null) // validateMessage: msg 없음
    const res = await putJson(t, { messageId: 999, value: 'like' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('message-not-found')
  })

  test('assistant 메시지가 아니면 404 not-assistant-message', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push({ id: 6, role: 'user', persona_id: null, conversation_id: 1 })
    const res = await putJson(t, { messageId: 6, value: 'like' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not-assistant-message')
  })
})

// ============================================================
// PUT / — UPSERT (등록/변경/동시성)
// ============================================================
describe('PUT / — UPSERT', () => {
  test('신규 like 등록 성공 (reason_code null)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(assistantMsg, null, { success: true }) // msg, existing 없음, INSERT
    const res = await putJson(t, { messageId: 5, value: 'like' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, messageId: 5, value: 'like' })
    // INSERT 문이 실행됐는지 확인
    expect(t.db.prepares.some((s) => s.startsWith('INSERT INTO ai_feedback'))).toBe(true)
  })

  test('신규 dislike + 유효한 reasonCode 등록 성공', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(assistantMsg, null, { success: true })
    const res = await putJson(t, { messageId: 5, value: 'dislike', reasonCode: 'inaccurate' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, messageId: 5, value: 'dislike' })
  })

  test('기존 피드백 있으면 UPDATE (멱등 변경)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(assistantMsg, { id: 7 }, { success: true }) // msg, existing 있음, UPDATE
    const res = await putJson(t, { messageId: 5, value: 'dislike', reasonCode: 'too_long' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, messageId: 5, value: 'dislike' })
    expect(t.db.prepares.some((s) => s.startsWith('UPDATE ai_feedback SET value'))).toBe(true)
  })

  test('기존 피드백을 reasonCode 없이 변경 (UPDATE의 reasonCode || null falsy 분기)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(assistantMsg, { id: 7 }, { success: true }) // msg, existing 있음, UPDATE
    const res = await putJson(t, { messageId: 5, value: 'like' }) // reasonCode 없음
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, messageId: 5, value: 'like' })
  })

  test('동시 요청 UNIQUE 위반 시 UPDATE로 재시도 (멱등 보장)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(
      assistantMsg,
      null, // existing 없음 → INSERT 시도
      new Error('UNIQUE constraint failed: ai_feedback.user_id, ai_feedback.message_id'),
      { success: true } // 재시도 UPDATE
    )
    const res = await putJson(t, { messageId: 5, value: 'like' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, messageId: 5, value: 'like' })
    // INSERT 1회 + UPDATE 1회 (WHERE user_id AND message_id 형태)
    expect(
      t.db.prepares.filter((s) => s.startsWith('UPDATE ai_feedback SET value')).length
    ).toBe(1)
  })

  test('INSERT 실패(UNIQUE 아님)는 500으로 전파', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(assistantMsg, null, new Error('disk I/O error'))
    const res = await putJson(t, { messageId: 5, value: 'like' })
    expect(res.status).toBe(500)
  })

  test('message 없는 throw 값도 재throw (e.message?.includes falsy 분기)', async () => {
    // Hono는 Error가 아닌 throw 값을 500으로 바꾸지 않고 호출자에게 그대로 전파함.
    // 라우트의 catch에서 e.message?.includes('UNIQUE') → undefined → falsy → throw e 경로 커버.
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(assistantMsg, null, 'STRING_ERROR')
    await expect(putJson(t, { messageId: 5, value: 'like' })).rejects.toBe('STRING_ERROR')
  })
})

// ============================================================
// DELETE /:messageId — 피드백 취소
// ============================================================
describe('DELETE /:messageId', () => {
  test('불일치 Origin이면 403', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await t.req('/42', { method: 'DELETE', headers: { Origin: EVIL_ORIGIN } })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('invalid-origin')
  })

  test('미인증이면 401', async () => {
    const t = makeApp()
    const res = await t.req('/42', { method: 'DELETE' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  test('messageId가 숫자가 아니면 400', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await t.req('/abc', { method: 'DELETE' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('정상 취소 (존재하지 않아도 멱등 성공)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push({ success: true, meta: { changes: 0 } })
    const res = await t.req('/42', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, messageId: 42, cancelled: true })
    expect(t.db.prepares.some((s) => s.startsWith('DELETE FROM ai_feedback'))).toBe(true)
  })
})

// ============================================================
// GET /:messageId — 내 피드백 조회
// ============================================================
describe('GET /:messageId', () => {
  test('미인증이면 401', async () => {
    const t = makeApp()
    const res = await t.req('/42')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  test('messageId가 숫자가 아니면 400', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await t.req('/abc')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-message-id')
  })

  test('피드백 있음 → value/reasonCode 반환', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push({ value: 'dislike', reason_code: 'too_short' })
    const res = await t.req('/42')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      messageId: 42,
      feedback: { value: 'dislike', reasonCode: 'too_short' },
    })
  })

  test('피드백 없음 → feedback null', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(null)
    const res = await t.req('/42')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, messageId: 42, feedback: null })
  })
})

// ============================================================
// GET /stats/:personaId — 비서별 통계
// ============================================================
describe('GET /stats/:personaId', () => {
  test('미인증이면 401', async () => {
    const t = makeApp()
    const res = await t.req('/stats/concierge')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  test('알 수 없는 persona면 400 invalid-persona', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await t.req('/stats/bogus')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-persona')
  })

  test('__proto__도 400 (프로토타입 오염 방지 확인)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    const res = await t.req('/stats/__proto__')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-persona')
  })

  test('통계 + 사유 집계 정상 반환', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(
      { total: 10, likes: 7, dislikes: 3 }, // stats .first()
      { results: [{ reason_code: 'inaccurate', cnt: 2 }, { reason_code: 'other', cnt: 1 }] } // reasons .all()
    )
    const res = await t.req('/stats/concierge')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      personaId: 'concierge',
      displayName: '루미',
      total: 10,
      likes: 7,
      dislikes: 3,
      likeRate: 0.7,
      reasons: [
        { code: 'inaccurate', count: 2 },
        { code: 'other', count: 1 },
      ],
    })
  })

  test('통계 0건이면 likeRate null, reasons 빈 배열', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push(null, null) // stats null, reasons null
    const res = await t.req('/stats/keeper')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(0)
    expect(body.likes).toBe(0)
    expect(body.dislikes).toBe(0)
    expect(body.likeRate).toBeNull()
    expect(body.reasons).toEqual([])
    expect(body.displayName).toBe('에코')
  })

  test('reasons 결과가 truthy지만 results가 없으면 빈 배열 (|| [] 분기)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push({ total: 2, likes: 1, dislikes: 1 }, {}) // reasons.all()이 results 없는 객체 반환
    const res = await t.req('/stats/concierge')
    expect(res.status).toBe(200)
    expect((await res.json()).reasons).toEqual([])
  })

  test('stats 경로가 :messageId 라우트보다 우선 매칭됨 (스태틱 우선)', async () => {
    const t = makeApp({ userEmail: 'u@example.com' })
    t.db.queue.push({ total: 1, likes: 1, dislikes: 0 }, { results: [] })
    const res = await t.req('/stats/builder')
    // :messageId 라우트에 걸렸다면 invalid-message-id 400이 나옴
    expect(res.status).toBe(200)
    expect((await res.json()).personaId).toBe('builder')
  })
})
