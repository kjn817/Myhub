/**
 * 자동화 REST API 테스트 — Hono 앱 인프로세스 호출
 * FakeD1 사용 — 운영 DB에 닿지 않음. 인증 미들웨어는 전역(index.ts)이라
 * 모듈 단위 테스트에서는 다루지 않는다 (NOT TESTED: 실서버 인증 경유).
 */
import { cronApp } from '../src/modules/cron/routes'
import { FakeD1, asD1 } from './fake-d1'

async function call(
  fake: FakeD1,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await cronApp.request(path, init, { DB: asD1(fake) } as any)
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('GET / — 목록', () => {
  test('빈 목록', async () => {
    const fake = new FakeD1()
    const { status, body } = await call(fake, '/')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.jobs).toEqual([])
  })
})

describe('POST / — 생성', () => {
  test('자연어로 생성, 설명 포함', async () => {
    const fake = new FakeD1()
    const { status, body } = await call(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nl_text: '매일 아침 8시에 뉴스 요약해서 푸시해줘' }),
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.job.action).toBe('news-summary')
    expect(body.job.cron_kst).toBe('0 8 * * *')
    expect(body.job.enabled).toBe(true)
    expect(body.job.description).toBe('매일 오전 8시에 뉴스 요약을 보내드릴게요.')
    expect(body.job.next_run_at).toBeTruthy()
  })

  test('파싱 실패 시 400 parse_failed, 저장 안 함', async () => {
    const fake = new FakeD1()
    const { status, body } = await call(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nl_text: '안녕하세요' }),
    })
    expect(status).toBe(400)
    expect(body.error).toBe('parse_failed')
    expect(fake.tables.user_cron_jobs).toHaveLength(0)
  })

  test('nl_text 누락·초과 시 400', async () => {
    const fake = new FakeD1()
    const empty = await call(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(empty.status).toBe(400)
    expect(empty.body.error).toBe('invalid_nl_text')
  })
})

describe('PATCH /:id — 활성화/비활성화', () => {
  test('끄기·켜기', async () => {
    const fake = new FakeD1()
    const created = await call(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nl_text: '매일 아침 8시에 브리핑해줘' }),
    })
    const id = created.body.job.id as number

    const off = await call(fake, `/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(off.status).toBe(200)
    expect(off.body.job.enabled).toBe(false)

    const on = await call(fake, `/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(on.status).toBe(200)
    expect(on.body.job.enabled).toBe(true)
  })

  test('없는 id 404, enabled 타입 오류 400, id 형식 오류 400', async () => {
    const fake = new FakeD1()
    const missing = await call(fake, '/999', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(missing.status).toBe(404)
    const badType = await call(fake, '/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'no' }),
    })
    expect(badType.status).toBe(400)
    const badId = await call(fake, '/abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(badId.status).toBe(400)
  })
})

describe('DELETE /:id — 삭제', () => {
  test('삭제 후 목록에서 사라짐, 재삭제 404', async () => {
    const fake = new FakeD1()
    const created = await call(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nl_text: '매일 아침 8시에 브리핑해줘' }),
    })
    const id = created.body.job.id as number

    const deleted = await call(fake, `/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.id).toBe(id)

    const again = await call(fake, `/${id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)

    const listed = await call(fake, '/')
    expect(listed.body.jobs).toEqual([])
  })
})
