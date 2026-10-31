/**
 * cron-jobs / cron-tools 커버리지 보강 (그룹 D)
 * - runDueCronJobs: 파싱 불가 작업 스킵·선점 실패(claimed=false)·선점 UPDATE 예외·
 *   전달 실패 시 복원 UPDATE 예외
 * - dispatchCronToolCall: 4개 분기 + 알 수 없는 도구(null)
 * - executeCronCreate/List/Delete/Toggle: DB 예외 catch (실패 문장 반환)
 * FakeD1 사용 — 운영 DB에 닿지 않음. 선점·복원 실패는 FakeD1을 감싼
 * 래퍼 D1으로 시뮬레이션한다.
 */
import {
  createCronJob,
  listCronJobs,
  setCronJobEnabled,
  deleteCronJob,
  listDueCronJobs,
  runDueCronJobs,
  type CronJob,
} from '../src/services/cron-jobs'
import {
  dispatchCronToolCall,
  executeCronCreate,
  executeCronList,
  executeCronDelete,
  executeCronToggle,
  formatCronJob,
  parseCronCreateMarkers,
  parseCronListMarkers,
  parseCronDeleteMarkers,
  parseCronToggleMarkers,
} from '../src/services/cron-tools'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-25T07:00:00+09:00') // 일요일 07:00 KST
const LATER = new Date('2026-10-25T09:00:00+09:00') // 일요일 09:00 KST

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** 지정 접두사 SQL에서 prepare가 throw하는 D1 래퍼 (DB 예외 시뮬레이션) */
class ThrowingD1 {
  constructor(
    private fake: FakeD1,
    private prefixes: string[],
  ) {}
  prepare(sql: string) {
    const q = norm(sql)
    if (this.prefixes.some((p) => q.startsWith(p))) throw new Error('db down')
    return this.fake.prepare(sql)
  }
}

/** next_run_at 선점 UPDATE가 항상 changes:0을 반환 (다른 틱이 선점한 상황) */
class ClaimBlockingD1 {
  constructor(private fake: FakeD1) {}
  prepare(sql: string) {
    const q = norm(sql)
    const stmt = this.fake.prepare(sql)
    return {
      bind: (...args: any[]) => {
        const bound = stmt.bind(...args)
        if (q.startsWith('UPDATE user_cron_jobs SET next_run_at')) {
          return { ...bound, run: async () => ({ success: true, meta: { changes: 0 } }) }
        }
        return bound
      },
    }
  }
}

/** next_run_at UPDATE 1회차(선점)는 성공, 2회차(복원)는 throw */
class RestoreFailingD1 {
  private calls = 0
  constructor(private fake: FakeD1) {}
  prepare(sql: string) {
    const q = norm(sql)
    const stmt = this.fake.prepare(sql)
    return {
      bind: (...args: any[]) => {
        const bound = stmt.bind(...args)
        if (q.startsWith('UPDATE user_cron_jobs SET next_run_at')) {
          return {
            ...bound,
            run: async () => {
              this.calls++
              if (this.calls >= 2) throw new Error('restore down')
              return bound.run()
            },
          }
        }
        return bound
      },
    }
  }
}

function asDb(db: unknown): { DB: D1Database } {
  return { DB: db as unknown as D1Database }
}

/**
 * FakeD1을 감싸 meta·first·all 응답 모양을 바꾸는 래퍼
 * (D1 meta 누락·조회 null 같은 방어 분기 검증용 — 실제 DB 동작을 흉내낸다)
 */
class ShapedD1 {
  noMetaPrefixes: string[] = []
  nullFirstPrefixes: string[] = []
  nullAllPrefixes: string[] = []
  constructor(private fake: FakeD1) {}
  prepare(sql: string) {
    const q = norm(sql)
    const stmt = this.fake.prepare(sql)
    const noMeta = this.noMetaPrefixes.some((p) => q.startsWith(p))
    const nullFirst = this.nullFirstPrefixes.some((p) => q.startsWith(p))
    const nullAll = this.nullAllPrefixes.some((p) => q.startsWith(p))
    return {
      bind: (...args: any[]) => {
        const bound = stmt.bind(...args)
        return {
          run: async () => {
            const r: any = await bound.run()
            return noMeta ? { success: true } : r
          },
          all: async () => {
            if (nullAll) return { success: true, results: null, meta: {} }
            return bound.all()
          },
          first: async () => {
            if (nullFirst) return null
            return bound.first()
          },
        }
      },
    }
  }
}

/** prepare가 Error가 아닌 문자열을 던지는 D1 (e?.message 폴백 분기용) */
class StringThrowingD1 {
  constructor(
    private fake: FakeD1,
    private prefixes: string[],
  ) {}
  prepare(sql: string) {
    const q = norm(sql)
    if (this.prefixes.some((p) => q.startsWith(p))) throw 'db down'
    return this.fake.prepare(sql)
  }
}

/** 파싱 불가한 nl_text를 가진 due 행을 직접 심음 (createCronJob으론 만들 수 없음) */
function seedUnparsableDueRow(fake: FakeD1) {
  fake.tables.user_cron_jobs.push({
    id: 99,
    action: 'generic',
    nl_text: '안녕하세요',
    cron_kst: '0 8 * * *',
    timezone: 'Asia/Seoul',
    next_run_at: '2026-10-24T23:00:00.000Z',
    enabled: 1,
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T00:00:00.000Z',
  })
}

describe('runDueCronJobs — 스킵·선점 실패 경로', () => {
  test('DB에 파싱 불가한 작업이 있으면 스킵하고 next_run_at을 건드리지 않음', async () => {
    const fake = new FakeD1()
    seedUnparsableDueRow(fake)
    const delivered: string[] = []
    const result = await runDueCronJobs(
      asDb(asD1(fake)),
      async (_job, text) => {
        delivered.push(text)
      },
      LATER,
    )
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 0, skipped: 1 })
    expect(delivered).toEqual([])
    expect(fake.tables.user_cron_jobs[0].next_run_at).toBe('2026-10-24T23:00:00.000Z')
  })

  test('파싱 불가 작업과 정상 작업이 섞이면 정상 작업만 실행', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW)
    seedUnparsableDueRow(fake)
    const delivered: CronJob[] = []
    const result = await runDueCronJobs(
      asDb(db),
      async (job) => {
        delivered.push(job)
      },
      LATER,
    )
    expect(result).toEqual({ checked: 2, delivered: 1, failed: 0, skipped: 1 })
    expect(delivered).toHaveLength(1)
    expect(delivered[0].action).toBe('morning-briefing')
  })

  test('선점 UPDATE가 예외를 던지면 failed로 집계하고 전달하지 않음', async () => {
    const fake = new FakeD1()
    await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', NOW)
    const throwing = new ThrowingD1(fake, ['UPDATE user_cron_jobs SET next_run_at'])
    const delivered: string[] = []
    const result = await runDueCronJobs(
      asDb(throwing),
      async (_job, text) => {
        delivered.push(text)
      },
      LATER,
    )
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 1, skipped: 0 })
    expect(delivered).toEqual([])
    // 선점 실패라 next_run_at은 그대로 — 다음 틱에 다시 due
    expect(fake.tables.user_cron_jobs[0].next_run_at).toBe('2026-10-24T23:00:00.000Z')
  })

  test('다른 틱이 이미 선점했으면(claimed=false) 스킵하고 전달하지 않음', async () => {
    const fake = new FakeD1()
    await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', NOW)
    const blocking = new ClaimBlockingD1(fake)
    const delivered: string[] = []
    const result = await runDueCronJobs(
      asDb(blocking),
      async (_job, text) => {
        delivered.push(text)
      },
      LATER,
    )
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 0, skipped: 1 })
    expect(delivered).toEqual([])
    expect(fake.tables.user_cron_jobs[0].next_run_at).toBe('2026-10-24T23:00:00.000Z')
  })

  test('전달 실패 후 next_run_at 복원마저 실패해도 failed로 집계하고 예외를 삼킴', async () => {
    const fake = new FakeD1()
    await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', NOW)
    const failing = new RestoreFailingD1(fake)
    const result = await runDueCronJobs(
      asDb(failing),
      async () => {
        throw new Error('push failed')
      },
      LATER,
    )
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 1, skipped: 0 })
    // 복원이 실패했으므로 선점된 다음 실행 시각이 그대로 남음 (다음 틱 선점은 그 기준)
    expect(fake.tables.user_cron_jobs[0].next_run_at).toBe('2026-10-25T23:00:00.000Z')
  })

  test('뉴스 요약기가 throw하면 failed + next_run_at 복원', async () => {    const fake = new FakeD1()
    const db = asD1(fake)
    await createCronJob(db, '매일 아침 8시에 뉴스 요약해서 푸시해줘', NOW)
    const before = fake.tables.user_cron_jobs[0].next_run_at
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: '오늘의 주요 뉴스 1',
            url: 'https://example.com/news1',
            highlights: ['핵심 내용 1'],
            publishedDate: new Date().toISOString(),
          },
        ],
      }),
    } as Response)
    try {
      const result = await runDueCronJobs(
        { DB: db, EXA_API_KEY: 'test-key' } as unknown as { DB: D1Database },
        async () => {},
        LATER,
        {
          newsSummarize: async () => {
            throw new Error('summarizer down')
          },
        },
      )
      expect(result).toEqual({ checked: 1, delivered: 0, failed: 1, skipped: 0 })
      expect(fake.tables.user_cron_jobs[0].next_run_at).toBe(before)
    } finally {
      jest.restoreAllMocks()
    }
  })
})

describe('dispatchCronToolCall', () => {
  test('cron_create — 문자열이 아닌 text는 빈 문자열로 실행해 실패 반환', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    const res = await dispatchCronToolCall(env, 'cron_create', { text: 123 })
    expect(res!.success).toBe(false)
    expect(res!.error).toContain('시간 표현을 이해하지 못했어요')
    const ok = await dispatchCronToolCall(env, 'cron_create', {
      text: '  매일 아침 8시에 브리핑해줘  ',
    })
    expect(ok!.success).toBe(true)
    expect(ok!.data.action).toBe('morning-briefing')
  })

  test('cron_list / cron_set_enabled / cron_delete 위임', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    await executeCronCreate(env, '매일 아침 8시에 브리핑해줘')
    expect((await dispatchCronToolCall(env, 'cron_list', {}))!.data.jobs).toHaveLength(1)
    const toggled = await dispatchCronToolCall(env, 'cron_set_enabled', { id: 1, enabled: false })
    expect(toggled!.success).toBe(true)
    expect(toggled!.data.enabled).toBe(false)
    const deleted = await dispatchCronToolCall(env, 'cron_delete', { id: 1 })
    expect(deleted!.success).toBe(true)
    expect((await dispatchCronToolCall(env, 'cron_list', {}))!.data.jobs).toHaveLength(0)
  })

  test('알 수 없는 도구명은 null', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    expect(await dispatchCronToolCall(env, 'cron_nope', {})).toBeNull()
    expect(await dispatchCronToolCall(env, '', {})).toBeNull()
  })
})

describe('cron-tools — DB 예외 catch', () => {
  test('executeCronCreate: INSERT 예외 시 실패 문장 반환', async () => {
    const fake = new FakeD1()
    const env = { DB: new ThrowingD1(fake, ['INSERT INTO user_cron_jobs']) as unknown as D1Database }
    const res = await executeCronCreate(env, '매일 아침 8시에 브리핑해줘')
    expect(res).toEqual({ success: false, error: '자동화 저장 실패: db down' })
    expect(fake.tables.user_cron_jobs).toHaveLength(0)
  })

  test('executeCronList: 조회 예외 시 실패 문장 반환', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    await executeCronCreate(env, '매일 아침 8시에 브리핑해줘')
    const broken = {
      DB: new ThrowingD1(fake, [
        'SELECT * FROM user_cron_jobs ORDER BY created_at DESC',
      ]) as unknown as D1Database,
    }
    const res = await executeCronList(broken)
    expect(res).toEqual({ success: false, error: '자동화 목록 조회 실패: db down' })
  })

  test('executeCronDelete: 삭제 예외 시 실패 문장 반환', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    await executeCronCreate(env, '매일 아침 8시에 브리핑해줘')
    const broken = {
      DB: new ThrowingD1(fake, ['DELETE FROM user_cron_jobs']) as unknown as D1Database,
    }
    const res = await executeCronDelete(broken, 1)
    expect(res).toEqual({ success: false, error: '자동화 삭제 실패: db down' })
    expect(fake.tables.user_cron_jobs).toHaveLength(1)
  })

  test('executeCronToggle: 명시 enabled 경로의 UPDATE 예외 시 실패 문장 반환', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    await executeCronCreate(env, '매일 아침 8시에 브리핑해줘')
    const broken = {
      DB: new ThrowingD1(fake, [
        'UPDATE user_cron_jobs SET enabled',
      ]) as unknown as D1Database,
    }
    const res = await executeCronToggle(broken, 1, false)
    expect(res).toEqual({ success: false, error: '자동화 변경 실패: db down' })
  })

  test('executeCronToggle: 토글 조회(getCronJob) 예외 시 실패 문장 반환', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    await executeCronCreate(env, '매일 아침 8시에 브리핑해줘')
    const broken = {
      DB: new ThrowingD1(fake, [
        'SELECT * FROM user_cron_jobs WHERE id = ?',
      ]) as unknown as D1Database,
    }
    const res = await executeCronToggle(broken, 1, null)
    expect(res).toEqual({ success: false, error: '자동화 변경 실패: db down' })
  })

  test('formatCronJob: 파싱 불가한 nl_text는 원문을 설명으로 사용', async () => {
    const fake = new FakeD1()
    seedUnparsableDueRow(fake)
    const listed = await executeCronList({ DB: asD1(fake) })
    expect(listed.success).toBe(true)
    expect(listed.data.jobs[0].description).toBe('#99 안녕하세요 (켜짐)')
    const job = (await import('../src/services/cron-jobs')).getCronJob
    const row = await job(asD1(fake), 99)
    expect(formatCronJob(row!)).toBe('#99 안녕하세요 (켜짐)')
  })
})

describe('cron-jobs — 방어 분기 (meta 누락·조회 null·기본 인자)', () => {
  test('createCronJob: now가 유효하지 않으면 nextRunAt null로 저장', async () => {
    const fake = new FakeD1()
    const job = await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', new Date(NaN))
    expect(job).not.toBeNull()
    expect(job!.nextRunAt).toBeNull()
    expect(job!.action).toBe('morning-briefing')
  })

  test('createCronJob: INSERT 응답에 meta가 없으면 insert 실패 예외', async () => {
    const fake = new FakeD1()
    const shaped = new ShapedD1(fake)
    shaped.noMetaPrefixes = ['INSERT INTO user_cron_jobs']
    await expect(
      createCronJob(shaped as unknown as D1Database, '매일 아침 8시에 브리핑해줘', NOW),
    ).rejects.toThrow('cron job insert failed')
  })

  test('createCronJob: INSERT 후 재조회가 null이면 insert 실패 예외', async () => {
    const fake = new FakeD1()
    const shaped = new ShapedD1(fake)
    shaped.nullFirstPrefixes = ['SELECT * FROM user_cron_jobs WHERE id = ?']
    await expect(
      createCronJob(shaped as unknown as D1Database, '매일 아침 8시에 브리핑해줘', NOW),
    ).rejects.toThrow('cron job insert failed')
    expect(fake.tables.user_cron_jobs).toHaveLength(1) // INSERT 자체는 수행됨
  })

  test('listCronJobs: results가 null이면 빈 목록', async () => {
    const fake = new FakeD1()
    await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', NOW)
    const shaped = new ShapedD1(fake)
    shaped.nullAllPrefixes = ['SELECT * FROM user_cron_jobs ORDER BY created_at DESC']
    expect(await listCronJobs(shaped as unknown as D1Database)).toEqual([])
  })

  test('setCronJobEnabled: UPDATE 응답에 meta가 없으면 null 반환', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    const job = (await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW))!
    const shaped = new ShapedD1(fake)
    shaped.noMetaPrefixes = ['UPDATE user_cron_jobs SET enabled']
    expect(
      await setCronJobEnabled(shaped as unknown as D1Database, job.id, false),
    ).toBeNull()
  })

  test('deleteCronJob: DELETE 응답에 meta가 없으면 false 반환', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    const job = (await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW))!
    const shaped = new ShapedD1(fake)
    shaped.noMetaPrefixes = ['DELETE FROM user_cron_jobs']
    expect(await deleteCronJob(shaped as unknown as D1Database, job.id)).toBe(false)
  })

  test('listDueCronJobs: results가 null이면 빈 목록', async () => {
    const fake = new FakeD1()
    await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', NOW)
    const shaped = new ShapedD1(fake)
    shaped.nullAllPrefixes = ['SELECT * FROM user_cron_jobs WHERE enabled']
    expect(await listDueCronJobs(shaped as unknown as D1Database, LATER)).toEqual([])
  })

  test('advanceNextRun: UPDATE 응답에 meta가 없으면 미선점으로 스킵', async () => {
    const fake = new FakeD1()
    await createCronJob(asD1(fake), '매일 아침 8시에 브리핑해줘', NOW)
    const shaped = new ShapedD1(fake)
    shaped.noMetaPrefixes = ['UPDATE user_cron_jobs SET next_run_at']
    const result = await runDueCronJobs(
      asDb(shaped),
      async () => {},
      LATER,
    )
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 0, skipped: 1 })
  })

  test('runDueCronJobs: now 생략 시 기본값(현재 시각) 사용', async () => {
    const fake = new FakeD1()
    const result = await runDueCronJobs(asDb(asD1(fake)), async () => {})
    expect(result).toEqual({ checked: 0, delivered: 0, failed: 0, skipped: 0 })
  })
})

describe('cron-tools 마커 파서 — 개수 제한·형식 분기', () => {
  test('마커 3개면 2개까지만 수집 (create·list·delete·toggle 공통)', () => {
    const three =
      '[CRON_CREATE]{"text": "매일 아침 8시에 브리핑해줘"}[/CRON_CREATE]' +
      '[CRON_CREATE]{"text": "매일 저녁 7시에 뉴스 요약해줘"}[/CRON_CREATE]' +
      '[CRON_CREATE]{"text": "매일 밤 10시에 브리핑해줘"}[/CRON_CREATE]'
    expect(parseCronCreateMarkers(three)).toHaveLength(2)
    expect(parseCronListMarkers('[CRON_LIST][/CRON_LIST][CRON_LIST][/CRON_LIST][CRON_LIST][/CRON_LIST]')).toHaveLength(2)
    expect(
      parseCronDeleteMarkers(
        '[CRON_DELETE]{"id": 1}[/CRON_DELETE][CRON_DELETE]{"id": 2}[/CRON_DELETE][CRON_DELETE]{"id": 3}[/CRON_DELETE]',
      ),
    ).toHaveLength(2)
    expect(
      parseCronToggleMarkers(
        '[CRON_TOGGLE]{"id": 1}[/CRON_TOGGLE][CRON_TOGGLE]{"id": 2}[/CRON_TOGGLE][CRON_TOGGLE]{"id": 3}[/CRON_TOGGLE]',
      ),
    ).toHaveLength(2)
  })

  test('[CRON_CREATE] — text 500자 절단·공백 text 무시·비문자열 text 무시', () => {
    const long = parseCronCreateMarkers(
      `[CRON_CREATE]{"text": "${'가'.repeat(600)}"}[/CRON_CREATE]`,
    )
    expect(long).toHaveLength(1)
    expect(long[0].text).toHaveLength(500)
    expect(parseCronCreateMarkers('[CRON_CREATE]{"text": "   "}[/CRON_CREATE]')).toHaveLength(0)
    expect(parseCronCreateMarkers('[CRON_CREATE]{"text": 123}[/CRON_CREATE]')).toHaveLength(0)
  })

  test('[CRON_DELETE]/[CRON_TOGGLE] — id 0·누락·비정수 무시', () => {
    expect(parseCronDeleteMarkers('[CRON_DELETE]{"id": 0}[/CRON_DELETE]')).toHaveLength(0)
    expect(parseCronDeleteMarkers('[CRON_DELETE]{}[/CRON_DELETE]')).toHaveLength(0)
    expect(parseCronDeleteMarkers('[CRON_DELETE]{"id": 1.5}[/CRON_DELETE]')).toHaveLength(0)
    expect(parseCronDeleteMarkers('[CRON_DELETE]{broken[/CRON_DELETE]')).toHaveLength(0)
    expect(parseCronToggleMarkers('[CRON_TOGGLE]{"id": 0}[/CRON_TOGGLE]')).toHaveLength(0)
    expect(parseCronToggleMarkers('[CRON_TOGGLE]{broken[/CRON_TOGGLE]')).toHaveLength(0)
  })

  test('[CRON_TOGGLE] — enabled가 boolean이 아니면 null(토글)', () => {
    const markers = parseCronToggleMarkers('[CRON_TOGGLE]{"id": 3, "enabled": "yes"}[/CRON_TOGGLE]')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ id: 3, enabled: null })
    const num = parseCronToggleMarkers('[CRON_TOGGLE]{"id": 3, "enabled": 1}[/CRON_TOGGLE]')
    expect(num[0]).toMatchObject({ id: 3, enabled: null })
  })
})

describe('cron-tools — DB 예외 catch (문자열 throw → message 폴백)', () => {
  test('executeCronCreate: 문자열 예외도 실패 문장으로 변환', async () => {
    const fake = new FakeD1()
    const env = { DB: new StringThrowingD1(fake, ['INSERT INTO user_cron_jobs']) as unknown as D1Database }
    expect(await executeCronCreate(env, '매일 아침 8시에 브리핑해줘')).toEqual({
      success: false,
      error: '자동화 저장 실패: db down',
    })
  })

  test('executeCronList: 문자열 예외도 실패 문장으로 변환', async () => {
    const fake = new FakeD1()
    const env = {
      DB: new StringThrowingD1(fake, [
        'SELECT * FROM user_cron_jobs ORDER BY created_at DESC',
      ]) as unknown as D1Database,
    }
    expect(await executeCronList(env)).toEqual({
      success: false,
      error: '자동화 목록 조회 실패: db down',
    })
  })

  test('executeCronDelete: 문자열 예외도 실패 문장으로 변환', async () => {
    const fake = new FakeD1()
    const env = {
      DB: new StringThrowingD1(fake, ['DELETE FROM user_cron_jobs']) as unknown as D1Database,
    }
    expect(await executeCronDelete(env, 1)).toEqual({
      success: false,
      error: '자동화 삭제 실패: db down',
    })
  })

  test('executeCronToggle: 문자열 예외도 실패 문장으로 변환', async () => {
    const fake = new FakeD1()
    const env = {
      DB: new StringThrowingD1(fake, [
        'UPDATE user_cron_jobs SET enabled',
      ]) as unknown as D1Database,
    }
    expect(await executeCronToggle(env, 1, false)).toEqual({
      success: false,
      error: '자동화 변경 실패: db down',
    })
  })

  test('executeCronToggle: 명시 enabled로 없는 id를 바꾸면 찾을 수 없음', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    expect(await executeCronToggle(env, 999, false)).toEqual({
      success: false,
      error: '자동화 #999를 찾을 수 없어요.',
    })
  })
})
