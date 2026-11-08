/// <reference types="jest" />
/**
 * src/modules/backup/status.ts — 백업 신선도 판정 성질 테스트.
 *
 * 핵심 성질: ① 정기 백업만 복원 가능으로 세고 드릴·테스트는 제외한다
 * ② stale 경계는 35일 초과(36일부터)다 ③ 깨진 기록은 조용히 버려지고
 * 유효한 기록만 남는다 ④ 기록은 최신 50건으로 잘린다.
 * 카나리아: stale 비교(>)를 (>=)로 바꾸거나 isValidRecord의 kind 검사를
 * 빼면 실패한다.
 */
import {
  buildBackupReminderText,
  buildFreshnessCheck,
  getBackupFreshnessCheck,
  getBackupStatus,
  listBackupRecords,
  normalizeBackupKind,
  recordBackupCreation,
  recordBackupFreshnessCheck,
  summarizeBackupStatus,
  type BackupRecord,
} from '../../src/modules/backup/status'
import type { Env } from '../../src/types'

function makeEnv(initialValue?: string) {
  const store = new Map<string, string>()
  if (initialValue !== undefined) store.set('backup.records.v1', initialValue)
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.startsWith('SELECT value FROM ai_settings')) {
                const v = store.get(String(args[0]))
                return v === undefined ? null : { value: v }
              }
              return null
            },
            async run() {
              if (sql.startsWith('INSERT OR REPLACE INTO ai_settings')) {
                store.set(String(args[0]), String(args[1]))
                return { meta: { changes: 1 } }
              }
              throw new Error(`unexpected sql: ${sql}`)
            },
          }
        },
      }
    },
  }
  return { env: { DB: db } as unknown as Env, store }
}

const NOW = new Date('2026-11-08T00:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString()
const rec = (createdAt: string, kind: BackupRecord['kind'] = 'regular', extra: Partial<BackupRecord> = {}): BackupRecord => ({
  createdAt,
  kind,
  totalRows: 100,
  tableCount: 12,
  attachmentsIncluded: true,
  ...extra,
})

describe('normalizeBackupKind', () => {
  test.each([
    ['drill', 'drill'],
    ['test', 'test'],
    ['regular', 'regular'],
    ['REGULAR', 'regular'],
    [undefined, 'regular'],
    [null, 'regular'],
    [42, 'regular'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeBackupKind(input)).toBe(expected)
  })
})

describe('summarizeBackupStatus', () => {
  test('기록이 없으면 exists=false, stale=true', () => {
    expect(summarizeBackupStatus([], NOW)).toEqual({
      exists: false,
      latestAt: null,
      ageDays: null,
      stale: true,
      regularCount: 0,
      excludedCount: 0,
      totalRecords: 0,
    })
  })

  test('드릴·테스트만 있으면 정기 백업 없음으로 센다', () => {
    const s = summarizeBackupStatus([rec(daysAgo(1), 'drill'), rec(daysAgo(0), 'test')], NOW)
    expect(s.exists).toBe(false)
    expect(s.regularCount).toBe(0)
    expect(s.excludedCount).toBe(2)
    expect(s.stale).toBe(true)
  })

  test('최신 정기 백업 기준으로 ageDays(내림)와 stale(35일 초과)을 판정한다', () => {
    const s = summarizeBackupStatus([rec(daysAgo(40)), rec(daysAgo(10)), rec(daysAgo(1), 'drill')], NOW)
    expect(s.latestAt).toBe(daysAgo(10))
    expect(s.ageDays).toBe(10)
    expect(s.stale).toBe(false)
    expect(s.regularCount).toBe(2)
    expect(summarizeBackupStatus([rec(daysAgo(35))], NOW).stale).toBe(false)
    expect(summarizeBackupStatus([rec(daysAgo(36))], NOW).stale).toBe(true)
  })

  test('미래 시각의 백업은 ageDays 0으로 고정된다', () => {
    const s = summarizeBackupStatus([rec(daysAgo(-3))], NOW)
    expect(s.ageDays).toBe(0)
    expect(s.stale).toBe(false)
  })
})

describe('buildBackupReminderText — 상태별 문구 분기', () => {
  test('백업 없음 / 오래됨 / 최신 세 갈래가 서로 다른 안내를 낸다', () => {
    const none = buildBackupReminderText(summarizeBackupStatus([], NOW))
    expect(none).toContain('아직 없습니다')
    const stale = buildBackupReminderText(summarizeBackupStatus([rec(daysAgo(40))], NOW))
    expect(stale).toContain('40일 전')
    expect(stale).toContain('오래됐습니다')
    const fresh = buildBackupReminderText(summarizeBackupStatus([rec(daysAgo(2))], NOW))
    expect(fresh).toContain('최신 상태입니다')
  })
})

describe('listBackupRecords — 저장값 검증', () => {
  test('행이 없거나 JSON이 깨졌거나 배열이 아니면 빈 배열', async () => {
    await expect(listBackupRecords(makeEnv().env)).resolves.toEqual([])
    await expect(listBackupRecords(makeEnv('{oops').env)).resolves.toEqual([])
    await expect(listBackupRecords(makeEnv('{"a":1}').env)).resolves.toEqual([])
  })

  test('형식이 깨진 기록은 버려지고 유효한 것만 남는다', async () => {
    const good = rec(daysAgo(1))
    const bads = [
      { ...good, createdAt: 'not-a-date' },
      { ...good, kind: 'weird' },
      { ...good, totalRows: '100' },
      { ...good, attachmentsIncluded: 'yes' },
      { createdAt: daysAgo(1) }, // 필수 필드 누락
      null,
      'junk',
    ]
    const { env } = makeEnv(JSON.stringify([good, ...bads]))
    await expect(listBackupRecords(env)).resolves.toEqual([good])
  })
})

describe('recordBackupCreation / getBackupStatus', () => {
  test('기록이 쌓이고 kind는 정규화되며 상태에 반영된다', async () => {
    const { env, store } = makeEnv()
    await expect(
      recordBackupCreation(env, { createdAt: daysAgo(3), kind: 'weird', totalRows: 5, tableCount: 2, attachmentsIncluded: false }),
    ).resolves.toBe(true)
    const stored = JSON.parse(store.get('backup.records.v1')!)
    expect(stored[0]).toMatchObject({ createdAt: daysAgo(3), kind: 'regular', totalRows: 5 })
    const { status, records } = await getBackupStatus(env, NOW)
    expect(records).toHaveLength(1)
    expect(status.ageDays).toBe(3)
  })

  test('createdAt을 생략하면 현재 시각이 ISO로 채워진다', async () => {
    const { env, store } = makeEnv()
    await recordBackupCreation(env, { totalRows: 1, tableCount: 1, attachmentsIncluded: true })
    const stored = JSON.parse(store.get('backup.records.v1')!)
    expect(Number.isNaN(Date.parse(stored[0].createdAt))).toBe(false)
  })

  test('기록은 최신 50건으로 잘린다 (오래된 것부터 버려진다)', async () => {
    const seed = Array.from({ length: 50 }, (_, i) => rec(daysAgo(100 - i)))
    const { env, store } = makeEnv(JSON.stringify(seed))
    await recordBackupCreation(env, { createdAt: daysAgo(0), totalRows: 1, tableCount: 1, attachmentsIncluded: true })
    const stored = JSON.parse(store.get('backup.records.v1')!)
    expect(stored).toHaveLength(50)
    expect(stored[0].createdAt).toBe(daysAgo(99))
    expect(stored[49].createdAt).toBe(daysAgo(0))
  })
})

describe('freshness check', () => {
  test('latestAttachmentsIncluded는 최신 "정기" 백업 기준이다 (더 최신 드릴에 속지 않는다)', () => {
    const check = buildFreshnessCheck(
      [rec(daysAgo(5), 'regular', { attachmentsIncluded: false }), rec(daysAgo(1), 'drill', { attachmentsIncluded: true })],
      NOW,
    )
    expect(check.latestAttachmentsIncluded).toBe(false)
    expect(check.regularCount).toBe(1)
    expect(check.checkedAt).toBe(NOW.toISOString())
  })

  test('정기 백업이 없으면 latestAttachmentsIncluded는 null', () => {
    expect(buildFreshnessCheck([rec(daysAgo(1), 'test')], NOW).latestAttachmentsIncluded).toBeNull()
  })

  test('record→get 왕복, 손상된 저장값은 null', async () => {
    const { env, store } = makeEnv(JSON.stringify([rec(daysAgo(2))]))
    const check = await recordBackupFreshnessCheck(env, NOW)
    await expect(getBackupFreshnessCheck(env)).resolves.toEqual(check)
    store.set('backup.freshness.v1', '{"nope":true}')
    await expect(getBackupFreshnessCheck(env)).resolves.toBeNull()
    store.set('backup.freshness.v1', '{broken')
    await expect(getBackupFreshnessCheck(env)).resolves.toBeNull()
  })
})
