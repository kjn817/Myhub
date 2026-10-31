/**
 * 채팅용 cron 도구 실행 계층 테스트 — 마커 파싱 + 실행
 * FakeD1 사용 — 운영 DB에 닿지 않음.
 */
import {
  parseCronCreateMarkers,
  parseCronListMarkers,
  parseCronDeleteMarkers,
  parseCronToggleMarkers,
  executeCronCreate,
  executeCronList,
  executeCronDelete,
  executeCronToggle,
  formatCronJob,
} from '../src/services/cron-tools'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-25T07:00:00+09:00') // 일요일 07:00 KST

describe('마커 파싱', () => {
  test('[CRON_CREATE] — text 필수, 깨진 JSON 무시', () => {
    const markers = parseCronCreateMarkers(
      '[CRON_CREATE]{"text": "매일 아침 8시에 뉴스 요약해줘"}[/CRON_CREATE]',
    )
    expect(markers).toHaveLength(1)
    expect(markers[0].text).toBe('매일 아침 8시에 뉴스 요약해줘')
    expect(parseCronCreateMarkers('[CRON_CREATE]{broken[/CRON_CREATE]')).toHaveLength(0)
    expect(parseCronCreateMarkers('[CRON_CREATE]{"title": "x"}[/CRON_CREATE]')).toHaveLength(0)
  })

  test('[CRON_LIST] — 내용 없이 매칭', () => {
    expect(parseCronListMarkers('보여줘 [CRON_LIST][/CRON_LIST]')).toHaveLength(1)
    expect(parseCronListMarkers('마커 없음')).toHaveLength(0)
  })

  test('[CRON_DELETE] — id 정수만', () => {
    const markers = parseCronDeleteMarkers('[CRON_DELETE]{"id": 3}[/CRON_DELETE]')
    expect(markers).toEqual([{ full: '[CRON_DELETE]{"id": 3}[/CRON_DELETE]', id: 3 }])
    expect(parseCronDeleteMarkers('[CRON_DELETE]{"id": "3"}[/CRON_DELETE]')).toHaveLength(0)
  })

  test('[CRON_TOGGLE] — enabled 없으면 null(토글)', () => {
    const withFlag = parseCronToggleMarkers('[CRON_TOGGLE]{"id": 3, "enabled": false}[/CRON_TOGGLE]')
    expect(withFlag[0]).toMatchObject({ id: 3, enabled: false })
    const bare = parseCronToggleMarkers('[CRON_TOGGLE]{"id": 3}[/CRON_TOGGLE]')
    expect(bare[0]).toMatchObject({ id: 3, enabled: null })
  })
})

describe('실행', () => {
  test('생성 성공 시 확인 설명 반환, 파싱 실패 시 저장 안 함', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    const ok = await executeCronCreate(env, '매일 아침 8시에 뉴스 요약해서 푸시해줘')
    expect(ok.success).toBe(true)
    expect(ok.data.id).toBe(1)
    expect(ok.data.action).toBe('news-summary')
    expect(ok.data.description).toBe('매일 오전 8시에 뉴스 요약을 보내드릴게요.')
    expect(fake.tables.user_cron_jobs).toHaveLength(1)

    const bad = await executeCronCreate(env, '안녕하세요')
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('시간 표현을 이해하지 못했어요')
    expect(fake.tables.user_cron_jobs).toHaveLength(1)
  })

  test('목록·포맷', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    expect((await executeCronList(env)).data.jobs).toEqual([])
    const { createCronJob } = await import('../src/services/cron-jobs')
    const job = (await createCronJob(env.DB, '매일 아침 8시에 브리핑해줘', NOW))!
    const listed = await executeCronList(env)
    expect(listed.success).toBe(true)
    expect(listed.data.jobs).toHaveLength(1)
    expect(listed.data.jobs[0].description).toBe('#1 매일 오전 8시에 아침 브리핑을 보내드릴게요. (켜짐)')
    expect(formatCronJob(job)).toContain('#1')
    expect(formatCronJob(job)).toContain('켜짐')
  })

  test('삭제 — 있는 id만 성공', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    const { createCronJob } = await import('../src/services/cron-jobs')
    await createCronJob(env.DB, '매일 아침 8시에 브리핑해줘', NOW)
    expect((await executeCronDelete(env, 1)).success).toBe(true)
    expect((await executeCronDelete(env, 1)).success).toBe(false)
    expect(fake.tables.user_cron_jobs).toHaveLength(0)
  })

  test('토글 — 명시 on/off + 생략 시 반전', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    const { createCronJob } = await import('../src/services/cron-jobs')
    await createCronJob(env.DB, '매일 아침 8시에 브리핑해줘', NOW)

    const off = await executeCronToggle(env, 1, false)
    expect(off.success).toBe(true)
    expect(off.data.enabled).toBe(false)

    const flip = await executeCronToggle(env, 1, null)
    expect(flip.success).toBe(true)
    expect(flip.data.enabled).toBe(true)

    const missing = await executeCronToggle(env, 999, null)
    expect(missing.success).toBe(false)
  })
})
