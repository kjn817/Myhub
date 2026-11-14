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
