/**
 * 자연어 cron 작업 저장소 + 실행기 테스트 (Octop 트랙 4-3, 아침 브리핑 연결)
 * FakeD1 사용 — 운영 DB에 닿지 않음.
 */
import { createCronJob, listDueCronJobs, listCronJobs, getCronJob, setCronJobEnabled, deleteCronJob, runDueCronJobs, type CronJob } from '../src/services/cron-jobs'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-25T07:00:00+09:00') // 일요일 07:00 KST
const LATER = new Date('2026-10-25T09:00:00+09:00') // 일요일 09:00 KST

describe('createCronJob', () => {
  test('자연어 → 작업 저장, 다음 실행 시각 계산', async () => {
    const fake = new FakeD1()
    const job = await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', NOW)
    expect(job).not.toBeNull()
    expect(job!.action).toBe('morning-briefing')
    expect(job!.cronKst).toBe('0 8 * * *')
    expect(job!.timezone).toBe('Asia/Seoul')
    // 당일 08:00 KST = 2026-10-24T23:00Z
    expect(job!.nextRunAt).toBe('2026-10-24T23:00:00.000Z')
    expect(job!.enabled).toBe(1)
    expect(fake.tables.user_cron_jobs).toHaveLength(1)
  })

  test('파싱 실패 시 null, 저장 안 함', async () => {
    const fake = new FakeD1()
    expect(await createCronJob(asD1(fake), '안녕하세요', NOW)).toBeNull()
    expect(await createCronJob(asD1(fake), '브리핑해줘', NOW)).toBeNull()
    expect(fake.tables.user_cron_jobs).toHaveLength(0)
  })
})

describe('listDueCronJobs', () => {
  test('due인 작업만 반환', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW) // next 10/25 08:00 KST
    await createCronJob(db, '매일 저녁 7시에 브리핑해줘', NOW) // next 10/25 19:00 KST
    // 09:00 KST 기준으로는 아침 작업만 due
    const due = await listDueCronJobs(db, LATER)
    expect(due).toHaveLength(1)
    expect(due[0].cronKst).toBe('0 8 * * *')
  })
})

describe('runDueCronJobs', () => {
  test('due 브리핑 작업을 실행하고 다음 실행 시각으로 선점', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW)

    const delivered: Array<{ job: CronJob; text: string }> = []
    const result = await runDueCronJobs(
      { DB: db },
      async (job, text) => {
        delivered.push({ job, text })
      },
      LATER,
    )
    expect(result).toEqual({ checked: 1, delivered: 1, failed: 0, skipped: 0 })
    expect(delivered).toHaveLength(1)
    // 일정이 없어 규칙 기반 요약문이 전달됨
    expect(delivered[0].text).toContain('오늘 일정이 없습니다')
    // 다음 실행은 다음 날 08:00 KST
    const row = fake.tables.user_cron_jobs[0]
    expect(row.next_run_at).toBe('2026-10-25T23:00:00.000Z')

    // 같은 시각에 다시 실행하면 due가 없음 (중복 실행 방지)
    const second = await runDueCronJobs({ DB: db }, async () => {}, LATER)
    expect(second).toEqual({ checked: 0, delivered: 0, failed: 0, skipped: 0 })
  })

  test('전달 실패 시 next_run_at을 복원해 다음 틱에 재시도', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW)
    const before = fake.tables.user_cron_jobs[0].next_run_at

    const result = await runDueCronJobs(
      { DB: db },
      async () => {
        throw new Error('push failed')
      },
      LATER,
    )
    expect(result.failed).toBe(1)
    expect(result.delivered).toBe(0)
    expect(fake.tables.user_cron_jobs[0].next_run_at).toBe(before) // 복원됨

    // 다음 틱에 다시 due로 잡힘
    const retry = await runDueCronJobs({ DB: db }, async () => {}, LATER)
    expect(retry.delivered).toBe(1)
  })

  test('generic 액션은 확인 문장을 전달', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 스트레칭해줘', NOW) // 액션 키워드 없음 → generic
    const delivered: string[] = []
    await runDueCronJobs({ DB: db }, async (_job, text) => { delivered.push(text) }, LATER)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('매일 오전 8시에 알림을 보내드릴게요.')
  })

  test('DB 오류 시 조용히 종료 (fail-soft)', async () => {
    const broken = {
      prepare() {
        throw new Error('db down')
      },
    } as unknown as D1Database
    const result = await runDueCronJobs({ DB: broken }, async () => {}, LATER)
    expect(result).toEqual({ checked: 0, delivered: 0, failed: 0, skipped: 0 })
  })
})

describe('cron job 관리 (목록·활성화/비활성화·삭제)', () => {
  test('목록은 최신 순, 토글·삭제 동작', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    const first = (await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW))!
    const second = (await createCronJob(db, '매일 저녁 7시에 뉴스 요약해줘', NOW))!

    const listed = await listCronJobs(db)
    expect(listed.map((j) => j.id)).toEqual([second.id, first.id])

    // 비활성화하면 due 목록에서 제외
    const disabled = await setCronJobEnabled(db, first.id, false)
    expect(disabled).not.toBeNull()
    expect(disabled!.enabled).toBe(0)
    expect(await listDueCronJobs(db, LATER)).toHaveLength(0)

    // 다시 활성화하면 due로 복귀
    const enabled = await setCronJobEnabled(db, first.id, true)
    expect(enabled!.enabled).toBe(1)
    expect(await listDueCronJobs(db, LATER)).toHaveLength(1)

    // 삭제
    expect(await deleteCronJob(db, second.id)).toBe(true)
    expect(await getCronJob(db, second.id)).toBeNull()
    expect((await listCronJobs(db)).map((j) => j.id)).toEqual([first.id])

    // 없는 id는 null/false
    expect(await setCronJobEnabled(db, 9999, false)).toBeNull()
    expect(await deleteCronJob(db, 9999)).toBe(false)
    expect(await getCronJob(db, 9999)).toBeNull()
  })
})

describe('runDueCronJobs — 뉴스 요약', () => {
  const exaFixture = {
    results: [
      {
        title: '오늘의 주요 뉴스 1',
        url: 'https://example.com/news1',
        highlights: ['핵심 내용 1'],
        publishedDate: new Date().toISOString(),
      },
      {
        title: '오늘의 주요 뉴스 2',
        url: 'https://example.com/news2',
        highlights: ['핵심 내용 2'],
        publishedDate: new Date().toISOString(),
      },
    ],
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('뉴스 요약 작업을 실행해 요약문을 전달', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 뉴스 요약해서 푸시해줘', NOW)

    jest.spyOn(global, 'fetch').mockImplementation(async (url: string) => {
      const u = String(url)
      // 체인용 라우팅 목 (2026-10-26 트랙 A2 — Exa 단계 기사 날짜 직접 검증):
      // Exa JSON / RSS 빈 피드 / 기사 페이지는 신선한 메타 날짜의 HTML.
      if (u.includes('api.exa.ai')) {
        return { ok: true, json: async () => exaFixture } as Response
      }
      if (u.includes('news.google.com')) {
        return { ok: true, text: async () => '<rss version="2.0"><channel></channel></rss>' } as Response
      }
      return {
        ok: true,
        text: async () =>
          `<html><head><meta property="article:published_time" content="${new Date().toISOString()}"></head></html>`,
      } as Response
    })

    const delivered: string[] = []
    const result = await runDueCronJobs(
      { DB: db, EXA_API_KEY: 'test-key' } as unknown as { DB: D1Database },
      async (_job, text) => {
        delivered.push(text)
      },
      LATER,
      {
        newsSummarize: async (items) =>
          items.map((it, i) => `${i + 1}. ${it.title} — [출처](${it.url})`).join('\n'),
      },
    )
    expect(result).toEqual({ checked: 1, delivered: 1, failed: 0, skipped: 0 })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('오늘의 주요 뉴스 1')
    expect(delivered[0]).toContain('https://example.com/news1')
  })

  test('Exa 검색 실패 시 next_run_at 복원 후 다음 틱 재시도', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 뉴스 요약해서 푸시해줘', NOW)
    const before = fake.tables.user_cron_jobs[0].next_run_at

    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response)

    const result = await runDueCronJobs(
      { DB: db, EXA_API_KEY: 'test-key' } as unknown as { DB: D1Database },
      async () => {},
      LATER,
      { newsSummarize: async () => '요약' },
    )
    expect(result.failed).toBe(1)
    expect(result.delivered).toBe(0)
    expect(fake.tables.user_cron_jobs[0].next_run_at).toBe(before)
  })

  test('키 미설정 + RSS도 비면 실패로 처리해 다음 틱 재시도 (체인 결과 없음은 일시적 실패 — 2026-10-26)', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 뉴스 요약해서 푸시해줘', NOW)
    const before = fake.tables.user_cron_jobs[0].next_run_at

    // 키가 없어도 RSS는 시도되므로 빈 피드를 목으로 준다
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '<rss version="2.0"><channel></channel></rss>',
    } as Response)

    const delivered: string[] = []
    const result = await runDueCronJobs(
      { DB: db },
      async (_job, text) => {
        delivered.push(text)
      },
      LATER,
      { newsSummarize: async () => '요약' },
    )
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 1, skipped: 0 })
    expect(delivered).toHaveLength(0)
    // 다음 실행으로 복원됨 (재시도 루프가 아니라 다음 틱 재시도)
    expect(fake.tables.user_cron_jobs[0].next_run_at).toBe(before)
  })
})
