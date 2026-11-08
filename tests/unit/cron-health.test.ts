/// <reference types="jest" />
/**
 * src/services/cron-health.ts — 크론 실행 원장과 dead-man 판정 성질 테스트.
 *
 * 핵심 성질: ① 같은 결과의 반복 기록은 히스토리를 부풀리지 않되
 * lastRunAt은 갱신한다 ② 연속 실패는 failed/partial/no_recipient에서만
 * 누적되고 ok에서 0으로 돌아간다 ③ 깨진 저장값은 빈 원장으로 fail-soft
 * ④ dead-man은 실행 침묵과 성공 기아를 임계 초과 시에만 올린다
 * ⑤ 리포트는 미실행 핸들러를 never_run으로 채우고 경고를 결정적으로 만든다.
 * 카나리아: nextConsecutive에서 partial을 실패로 세지 않거나
 * 히스토리 중복 제거 조건을 지우면 실패한다.
 */
import {
  CRON_HANDLERS,
  CRON_HEALTH_KEY,
  cronHandlerLabel,
  countPushSubscriptions,
  deadManSignalsFor,
  getCronHealth,
  readCronHealthStore,
  recordCronJobRun,
  recordCronRun,
  type CronHandlerHealth,
  type CronHealthStore,
} from '../../src/services/cron-health'

class SettingsDb {
  store = new Map<string, string>()
  subsCount: number | null = 0
  throwOnRead = false
  throwOnWrite = false
  prepare(sql: string) {
    const self = this
    return {
      bind: (...args: any[]) => ({
        first: async () => {
          if (sql.includes('FROM ai_settings')) {
            if (self.throwOnRead) throw new Error('read fail')
            const v = self.store.get(args[0])
            return v === undefined ? null : { value: v }
          }
          if (sql.includes('push_subscriptions')) {
            if (self.throwOnRead) throw new Error('read fail')
            return self.subsCount === null ? null : { n: self.subsCount }
          }
          return null
        },
        run: async () => {
          if (sql.includes('INSERT OR REPLACE INTO ai_settings')) {
            if (self.throwOnWrite) throw new Error('write fail')
            self.store.set(args[0], args[1])
          }
          return { success: true }
        },
      }),
    }
  }
  seed(store: CronHealthStore) {
    this.store.set(CRON_HEALTH_KEY, JSON.stringify(store))
  }
  asD1() {
    return this as unknown as D1Database
  }
}

const T0 = new Date('2026-11-08T00:00:00.000Z')
const hoursAgo = (h: number, base = T0) => new Date(base.getTime() - h * 3600_000)
const minsAgo = (m: number, base = T0) => new Date(base.getTime() - m * 60_000)

function handlerHealth(over: Partial<CronHandlerHealth> = {}): CronHandlerHealth {
  return {
    handler: 'schedule-push',
    status: 'ok',
    detail: '',
    counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    subscriptions: null,
    consecutiveFailures: 0,
    lastRunAt: T0.toISOString(),
    lastOkAt: T0.toISOString(),
    lastFailureAt: null,
    history: [],
    ...over,
  }
}

describe('cronHandlerLabel', () => {
  test('등록된 핸들러는 한국어 라벨, 미등록은 이름 그대로', () => {
    expect(cronHandlerLabel('schedule-push')).toBe('일정 알림')
    expect(cronHandlerLabel('decrypt-health')).toBe('복호화 건강 점검')
    expect(cronHandlerLabel('no-such')).toBe('no-such')
  })
})

describe('recordCronRun — 원장 기록', () => {
  test('첫 실행이 핸들러 항목을 만들고 부분 counts는 0으로 채운다', async () => {
    const db = new SettingsDb()
    await recordCronRun({ DB: db.asD1() }, 'cron-jobs', {
      status: 'ok', detail: 'done', counts: { checked: 3 }, subscriptions: 2, at: T0,
    })
    const store = await readCronHealthStore(db.asD1())
    const h = store.handlers['cron-jobs']
    expect(h).toMatchObject({
      handler: 'cron-jobs', status: 'ok', detail: 'done',
      counts: { checked: 3, delivered: 0, failed: 0, skipped: 0 },
      subscriptions: 2, consecutiveFailures: 0,
      lastRunAt: T0.toISOString(), lastOkAt: T0.toISOString(), lastFailureAt: null,
    })
    expect(h.history).toHaveLength(1)
  })

  test('동일 결과 반복 기록은 히스토리를 늘리지 않지만 lastRunAt은 갱신한다', async () => {
    const db = new SettingsDb()
    const outcome = { status: 'ok', detail: 'same', counts: { checked: 1 } }
    await recordCronRun({ DB: db.asD1() }, 'cron-jobs', { ...outcome, at: T0 })
    const later = new Date(T0.getTime() + 5 * 60_000)
    await recordCronRun({ DB: db.asD1() }, 'cron-jobs', { ...outcome, at: later })
    const h = (await readCronHealthStore(db.asD1())).handlers['cron-jobs']
    expect(h.history).toHaveLength(1)
    expect(h.lastRunAt).toBe(later.toISOString())
    // counts가 달라지면 새 히스토리 항목이 쌓인다
    await recordCronRun({ DB: db.asD1() }, 'cron-jobs', { ...outcome, counts: { checked: 2 }, at: later })
    expect((await readCronHealthStore(db.asD1())).handlers['cron-jobs'].history).toHaveLength(2)
  })

  test('히스토리는 10개로 제한되고 오래된 것부터 버려진다', async () => {
    const db = new SettingsDb()
    for (let i = 0; i < 12; i++) {
      await recordCronRun({ DB: db.asD1() }, 'cron-jobs', {
        status: 'ok', detail: `run-${i}`, at: new Date(T0.getTime() + i * 60_000),
      })
    }
    const h = (await readCronHealthStore(db.asD1())).handlers['cron-jobs']
    expect(h.history).toHaveLength(10)
    expect(h.history[0].detail).toBe('run-2')
    expect(h.history[9].detail).toBe('run-11')
  })

  test('연속 실패는 failed/partial/no_recipient에서 누적되고 ok에서 초기화된다', async () => {
    const db = new SettingsDb()
    const run = (status: string, min: number) =>
      recordCronRun({ DB: db.asD1() }, 'google-sync', { status, at: new Date(T0.getTime() + min * 60_000) })
    await run('failed', 0)
    await run('partial', 1)
    await run('no_recipient', 2)
    let h = (await readCronHealthStore(db.asD1())).handlers['google-sync']
    expect(h.consecutiveFailures).toBe(3)
    expect(h.lastFailureAt).toBe(new Date(T0.getTime() + 2 * 60_000).toISOString())
    // 실패도 성공도 아닌 상태는 카운터를 유지한다
    await run('skipped', 3)
    h = (await readCronHealthStore(db.asD1())).handlers['google-sync']
    expect(h.consecutiveFailures).toBe(3)
    await run('ok', 4)
    h = (await readCronHealthStore(db.asD1())).handlers['google-sync']
    expect(h.consecutiveFailures).toBe(0)
    expect(h.lastOkAt).toBe(new Date(T0.getTime() + 4 * 60_000).toISOString())
    // lastFailureAt은 성공해도 지워지지 않는다
    expect(h.lastFailureAt).toBe(new Date(T0.getTime() + 2 * 60_000).toISOString())
  })

  test('detail은 300자로 잘리고, subscriptions는 미지정 시 이전 값을 유지한다', async () => {
    const db = new SettingsDb()
    await recordCronRun({ DB: db.asD1() }, 'log-prune', {
      status: 'ok', detail: 'x'.repeat(400), subscriptions: 5, at: T0,
    })
    await recordCronRun({ DB: db.asD1() }, 'log-prune', { status: 'ok', detail: 'short', at: T0 })
    const h = (await readCronHealthStore(db.asD1())).handlers['log-prune']
    expect(h.history[0].detail).toHaveLength(300)
    expect(h.subscriptions).toBe(5)
    await recordCronRun({ DB: db.asD1() }, 'log-prune', {
      status: 'ok', detail: 'short', subscriptions: null, at: T0,
    })
    expect((await readCronHealthStore(db.asD1())).handlers['log-prune'].subscriptions).toBeNull()
  })

  test('DB 쓰기가 실패해도 recordCronRun은 던지지 않는다 (fail-soft)', async () => {
    const db = new SettingsDb()
    db.throwOnWrite = true
    await expect(
      recordCronRun({ DB: db.asD1() }, 'cron-jobs', { status: 'ok', at: T0 }),
    ).resolves.toBeUndefined()
  })
})

describe('recordCronJobRun', () => {
  test('작업 항목을 만들고 미지정 카운터는 이전 값을 유지한다', async () => {
    const db = new SettingsDb()
    await recordCronJobRun({ DB: db.asD1() }, 42, {
      status: 'failed', detail: 'boom', attempted: 3, delivered: 1, failed: 2, at: T0,
    })
    await recordCronJobRun({ DB: db.asD1() }, 42, { status: 'failed', detail: 'boom2', at: T0 })
    const job = (await readCronHealthStore(db.asD1())).jobs['42']
    expect(job).toMatchObject({
      jobId: 42, status: 'failed', detail: 'boom2',
      attempted: 3, delivered: 1, failed: 2, consecutiveFailures: 2,
    })
    await recordCronJobRun({ DB: db.asD1() }, 42, { status: 'ok', at: T0 })
    const after = (await readCronHealthStore(db.asD1())).jobs['42']
    expect(after.consecutiveFailures).toBe(0)
    expect(after.lastOkAt).toBe(T0.toISOString())
  })
})

describe('readCronHealthStore — 깨진 저장값 fail-soft', () => {
  test('저장값이 없으면 빈 원장', async () => {
    const db = new SettingsDb()
    await expect(readCronHealthStore(db.asD1())).resolves.toEqual({ version: 1, handlers: {}, jobs: {} })
  })

  test('JSON이 깨졌거나 형태가 틀리면 빈 원장', async () => {
    const db = new SettingsDb()
    db.store.set(CRON_HEALTH_KEY, '{broken')
    await expect(readCronHealthStore(db.asD1())).resolves.toEqual({ version: 1, handlers: {}, jobs: {} })
    db.store.set(CRON_HEALTH_KEY, JSON.stringify({ handlers: null, jobs: {} }))
    await expect(readCronHealthStore(db.asD1())).resolves.toEqual({ version: 1, handlers: {}, jobs: {} })
    db.store.set(CRON_HEALTH_KEY, JSON.stringify({ handlers: {}, jobs: null }))
    await expect(readCronHealthStore(db.asD1())).resolves.toEqual({ version: 1, handlers: {}, jobs: {} })
  })

  test('읽기가 던져도 빈 원장', async () => {
    const db = new SettingsDb()
    db.throwOnRead = true
    await expect(readCronHealthStore(db.asD1())).resolves.toEqual({ version: 1, handlers: {}, jobs: {} })
  })
})

describe('countPushSubscriptions', () => {
  test('행의 n을 돌려주고, 행이 없거나 실패하면 null', async () => {
    const db = new SettingsDb()
    db.subsCount = 7
    await expect(countPushSubscriptions(db.asD1())).resolves.toBe(7)
    db.subsCount = null
    await expect(countPushSubscriptions(db.asD1())).resolves.toBeNull()
    db.throwOnRead = true
    await expect(countPushSubscriptions(db.asD1())).resolves.toBeNull()
  })
})

describe('deadManSignalsFor', () => {
  test('임계 미등록 핸들러·미실행 핸들러는 신호가 없다', () => {
    expect(deadManSignalsFor(handlerHealth({ handler: 'unknown-x' }), T0)).toEqual([])
    expect(deadManSignalsFor(handlerHealth({ lastRunAt: null }), T0)).toEqual([])
  })

  test('실행 침묵이 30분을 넘으면 run_silence, 이내면 무신호', () => {
    const silent = deadManSignalsFor(handlerHealth({ lastRunAt: minsAgo(31).toISOString() }), T0)
    expect(silent).toHaveLength(1)
    expect(silent[0]).toMatchObject({ handler: 'schedule-push', kind: 'run_silence' })
    expect(silent[0].detail).toContain('31분')
    expect(deadManSignalsFor(handlerHealth({ lastRunAt: minsAgo(29).toISOString() }), T0)).toEqual([])
  })

  test('실패 상태 + 마지막 성공이 임계(26h)보다 오래면 success_starvation', () => {
    const starved = deadManSignalsFor(
      handlerHealth({ status: 'failed', lastRunAt: T0.toISOString(), lastOkAt: hoursAgo(27).toISOString() }),
      T0,
    )
    expect(starved).toEqual([
      expect.objectContaining({ kind: 'success_starvation', handler: 'schedule-push' }),
    ])
    expect(starved[0].detail).toContain('27시간')
    // 임계 이내면 무신호
    expect(
      deadManSignalsFor(
        handlerHealth({ status: 'failed', lastRunAt: T0.toISOString(), lastOkAt: hoursAgo(25).toISOString() }),
        T0,
      ),
    ).toEqual([])
    // 성공 상태에서는 lastOkAt이 오래돼도 기아 신호를 올리지 않는다
    expect(
      deadManSignalsFor(handlerHealth({ status: 'ok', lastOkAt: hoursAgo(100).toISOString() }), T0),
    ).toEqual([])
  })

  test('lastOkAt이 없으면 히스토리 첫 항목을 기아 기준으로 쓴다', () => {
    const h = handlerHealth({
      status: 'partial',
      lastRunAt: T0.toISOString(),
      lastOkAt: null,
      history: [{
        at: hoursAgo(30).toISOString(), status: 'failed', detail: '',
        checked: 0, delivered: 0, failed: 1, skipped: 0,
      }],
    })
    expect(deadManSignalsFor(h, T0).map((s) => s.kind)).toEqual(['success_starvation'])
    // 기준 자체가 없으면 기아 신호 없음
    expect(deadManSignalsFor(handlerHealth({ status: 'failed', lastOkAt: null, history: [] }), T0)).toEqual([])
  })

  test('침묵과 기아가 동시에 성립하면 두 신호 모두', () => {
    const h = handlerHealth({
      status: 'failed',
      lastRunAt: minsAgo(45).toISOString(),
      lastOkAt: hoursAgo(30).toISOString(),
    })
    expect(deadManSignalsFor(h, T0).map((s) => s.kind)).toEqual(['run_silence', 'success_starvation'])
  })

  test('파싱 불가한 시각은 신호를 만들지 않는다', () => {
    const h = handlerHealth({ status: 'failed', lastRunAt: 'not-a-date', lastOkAt: 'also-bad' })
    expect(deadManSignalsFor(h, T0)).toEqual([])
  })

  test('핸들러별 임계: 주간 핸들러(log-prune)는 성공 기아 임계가 8일이다', () => {
    const base = { handler: 'log-prune', status: 'failed', lastRunAt: T0.toISOString() }
    expect(deadManSignalsFor(handlerHealth({ ...base, lastOkAt: hoursAgo(30).toISOString() }), T0)).toEqual([])
    expect(
      deadManSignalsFor(handlerHealth({ ...base, lastOkAt: hoursAgo(9 * 24).toISOString() }), T0)
        .map((s) => s.kind),
    ).toEqual(['success_starvation'])
  })
})

describe('getCronHealth', () => {
  const envFor = (db: SettingsDb, vapid?: string) =>
    ({ DB: db.asD1(), ...(vapid ? { VAPID_PRIVATE_KEY: vapid } : {}) }) as any

  test('빈 원장: 전 핸들러 never_run, 경고 없음, healthy', async () => {
    const db = new SettingsDb()
    db.subsCount = null
    const report = await getCronHealth(envFor(db), T0)
    expect(report.healthy).toBe(true)
    expect(report.alerts).toEqual([])
    expect(report.handlers).toHaveLength(CRON_HANDLERS.length)
    expect(report.handlers.every((h) => h.status === 'never_run')).toBe(true)
    expect(report.handlers[0].detail).toBe('아직 실행 기록이 없습니다')
    expect(report.jobs).toEqual([])
    expect(report.push).toEqual({ configured: false, subscriptions: null })
    expect(report.generatedAt).toBe(T0.toISOString())
  })

  test('Push가 설정됐는데 구독이 0이면 경고를 올린다', async () => {
    const db = new SettingsDb()
    db.subsCount = 0
    const report = await getCronHealth(envFor(db, 'key'), T0)
    expect(report.healthy).toBe(false)
    expect(report.alerts.some((a) => a.includes('Push 구독이 0건'))).toBe(true)
    db.subsCount = 3
    const ok = await getCronHealth(envFor(db, 'key'), T0)
    expect(ok.alerts.some((a) => a.includes('Push 구독이 0건'))).toBe(false)
  })

  test('실패·무수신·연속 실패 경고와 작업 경고를 라벨과 함께 만든다', async () => {
    const db = new SettingsDb()
    db.subsCount = null
    db.seed({
      version: 1,
      handlers: {
        'schedule-push': handlerHealth({ handler: 'schedule-push', status: 'failed', detail: 'timeout' }),
        'cron-jobs': handlerHealth({ handler: 'cron-jobs', status: 'no_recipient', detail: '' }),
        'google-sync': handlerHealth({ handler: 'google-sync', status: 'ok', consecutiveFailures: 3 }),
      },
      jobs: {
        '9': {
          jobId: 9, status: 'failed', detail: 'bad', attempted: 1, delivered: 0, failed: 1,
          consecutiveFailures: 3, lastRunAt: T0.toISOString(), lastOkAt: null,
        },
        '3': {
          jobId: 3, status: 'ok', detail: '', attempted: 1, delivered: 1, failed: 0,
          consecutiveFailures: 0, lastRunAt: T0.toISOString(), lastOkAt: T0.toISOString(),
        },
      },
    })
    const report = await getCronHealth(envFor(db), T0)
    expect(report.alerts).toContain('일정 알림 마지막 실행이 실패했습니다: timeout')
    expect(report.alerts.some((a) => a.includes('자연어 크론') && a.includes('전달 대상'))).toBe(true)
    expect(report.alerts.some((a) => a.includes('Google 동기화') && a.includes('3회 연속'))).toBe(true)
    expect(report.alerts).toContain('크론 작업 #9이(가) 3회 연속 실패 중입니다: bad')
    // 작업은 jobId 오름차순
    expect(report.jobs.map((j) => j.jobId)).toEqual([3, 9])
    expect(report.healthy).toBe(false)
  })

  test('실패 detail이 비어 있으면 콜론 없이 경고한다', async () => {
    const db = new SettingsDb()
    db.subsCount = null
    db.seed({
      version: 1,
      handlers: { 'cron-jobs': handlerHealth({ handler: 'cron-jobs', status: 'failed', detail: '' }) },
      jobs: {},
    })
    const report = await getCronHealth(envFor(db), T0)
    expect(report.alerts).toContain('자연어 크론 마지막 실행이 실패했습니다')
  })

  test('dead-man 신호는 deadMan 목록과 경고 양쪽에 들어간다', async () => {
    const db = new SettingsDb()
    db.subsCount = null
    db.seed({
      version: 1,
      handlers: {
        'schedule-push': handlerHealth({
          handler: 'schedule-push', status: 'ok',
          lastRunAt: minsAgo(90).toISOString(), lastOkAt: minsAgo(90).toISOString(),
        }),
      },
      jobs: {},
    })
    const report = await getCronHealth(envFor(db), T0)
    expect(report.deadMan).toHaveLength(1)
    expect(report.deadMan[0].kind).toBe('run_silence')
    expect(report.alerts).toContain(report.deadMan[0].detail)
    expect(report.healthy).toBe(false)
  })
})
