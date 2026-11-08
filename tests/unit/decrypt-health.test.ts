/// <reference types="jest" />
/**
 * src/services/decrypt-health.ts — 복호화 건전성 점검 집계 성질 테스트.
 *
 * crypto 자체가 아니라 "암호문만 세고, 성공/실패를 버킷별로 정확히
 * 집계하며, 깨진 locked_blocks JSON은 실패 1건으로 세는" 집계 계약을
 * 검증한다 (crypto·census는 경계에서 mock — 두 모듈은 자체 테스트가 있다).
 * 카나리아: tryDecrypt의 실패 집계(failed++)를 빼거나 locked_blocks 파싱
 * 실패의 total 증가를 빼면 실패한다.
 */
jest.mock('../../src/services/crypto', () => ({
  isEncrypted: (v: unknown) => typeof v === 'string' && v.startsWith('ENC'),
  decryptContent: async (_env: unknown, ct: string) => {
    if (ct.includes('BAD')) throw new Error('decrypt failed')
    return 'plain'
  },
}))
jest.mock('../../src/services/key-rotation', () => ({
  computeRotationCensus: async () => ({ locked_file: 7 }),
}))

import {
  DECRYPT_HEALTH_KEY,
  DECRYPT_HEALTH_MARKER_KEY,
  getLastDecryptHealthDate,
  markDecryptHealthRun,
  recordDecryptHealth,
  runDecryptHealthCheck,
  type DecryptHealthEnv,
} from '../../src/services/decrypt-health'

interface FakeOpts {
  memos?: Array<{ text: string; locked_blocks: string | null }>
  google?: Array<{ access_token: string; refresh_token: string }>
  memosNoResults?: boolean
}

function fakeEnv(opts: FakeOpts = {}) {
  const settings = new Map<string, string>()
  const binds: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        async all() {
          if (sql.includes('FROM memos')) {
            return opts.memosNoResults ? {} : { results: opts.memos ?? [] }
          }
          if (sql.includes('FROM google_integrations')) return { results: opts.google ?? [] }
          return { results: [] }
        },
        bind(...args: unknown[]) {
          binds.push({ sql, args })
          return {
            async run() {
              if (sql.startsWith('INSERT OR REPLACE INTO ai_settings')) {
                settings.set(String(args[0]), String(args[1]))
              }
              return { meta: { changes: 1 } }
            },
            async first() {
              if (sql.startsWith('SELECT value FROM ai_settings')) {
                const v = settings.get(String(args[0]))
                return v === undefined ? null : { value: v }
              }
              return null
            },
          }
        },
      }
    },
  }
  return { env: { DB: db } as unknown as DecryptHealthEnv, settings, binds }
}

const NOW = new Date('2026-11-08T04:00:00.000Z')

describe('runDecryptHealthCheck — 버킷 집계', () => {
  test('암호화된 메모 본문만 세고 성공/실패를 가른다', async () => {
    const { env } = fakeEnv({
      memos: [
        { text: 'ENC-good', locked_blocks: null },
        { text: 'ENC-BAD', locked_blocks: null },
        { text: '평문 메모', locked_blocks: null },
      ],
    })
    const report = await runDecryptHealthCheck(env, NOW)
    expect(report.memoText).toEqual({ total: 2, ok: 1, failed: 1 })
    expect(report.ok).toBe(false)
    expect(report.totalChecked).toBe(2)
    expect(report.totalFailed).toBe(1)
    expect(report.at).toBe(NOW.toISOString())
    expect(report.lockedFiles).toEqual({ total: 7, checked: false })
  })

  test('전부 복호화되면 ok=true', async () => {
    const { env } = fakeEnv({ memos: [{ text: 'ENC-a', locked_blocks: '[]' }] })
    const report = await runDecryptHealthCheck(env, NOW)
    expect(report.ok).toBe(true)
    expect(report.totalFailed).toBe(0)
  })

  test('잠긴 블록: 암호화된 블록만 세고, 형식이 아닌 항목은 무시한다', async () => {
    const blocks = JSON.stringify([
      { encrypted: 'ENC-ok' },
      { encrypted: 'ENC-BAD' },
      { encrypted: '평문' },
      { encrypted: 42 },
      {},
      null,
    ])
    const { env } = fakeEnv({ memos: [{ text: '평문', locked_blocks: blocks }] })
    const report = await runDecryptHealthCheck(env, NOW)
    expect(report.memoBlock).toEqual({ total: 2, ok: 1, failed: 1 })
  })

  test('locked_blocks JSON이 깨지면 실패 1건으로 센다', async () => {
    const { env } = fakeEnv({ memos: [{ text: '평문', locked_blocks: '{oops' }] })
    const report = await runDecryptHealthCheck(env, NOW)
    expect(report.memoBlock).toEqual({ total: 1, ok: 0, failed: 1 })
  })

  test('locked_blocks가 배열이 아닌 JSON이면 세지도 실패로도 치지 않는다', async () => {
    const { env } = fakeEnv({ memos: [{ text: '평문', locked_blocks: '{"a":1}' }] })
    const report = await runDecryptHealthCheck(env, NOW)
    expect(report.memoBlock).toEqual({ total: 0, ok: 0, failed: 0 })
  })

  test('구글 토큰은 access/refresh 버킷이 분리되고 빈 값·평문은 건너뛴다', async () => {
    const { env } = fakeEnv({
      google: [
        { access_token: 'ENC-ok', refresh_token: 'ENC-BAD' },
        { access_token: '', refresh_token: '평문토큰' },
      ],
    })
    const report = await runDecryptHealthCheck(env, NOW)
    expect(report.googleAccess).toEqual({ total: 1, ok: 1, failed: 0 })
    expect(report.googleRefresh).toEqual({ total: 1, ok: 0, failed: 1 })
    expect(report.totalChecked).toBe(2)
  })

  test('all()의 results가 없으면 빈 결과로 취급한다', async () => {
    const { env } = fakeEnv({ memosNoResults: true })
    const report = await runDecryptHealthCheck(env, NOW)
    expect(report.totalChecked).toBe(0)
    expect(report.ok).toBe(true)
  })
})

describe('기록/마커', () => {
  test('recordDecryptHealth는 보고서를 건강 키에 JSON으로 저장한다', async () => {
    const { env, settings } = fakeEnv()
    const report = await runDecryptHealthCheck(env, NOW)
    await recordDecryptHealth(env, report)
    expect(JSON.parse(settings.get(DECRYPT_HEALTH_KEY)!)).toEqual(report)
  })

  test('markDecryptHealthRun → getLastDecryptHealthDate 왕복, 없으면 null', async () => {
    const { env, settings } = fakeEnv()
    await expect(getLastDecryptHealthDate(env)).resolves.toBeNull()
    await markDecryptHealthRun(env, '2026-11-08')
    expect(settings.get(DECRYPT_HEALTH_MARKER_KEY)).toBe('2026-11-08')
    await expect(getLastDecryptHealthDate(env)).resolves.toBe('2026-11-08')
  })

  test('DB 장애 시 getLastDecryptHealthDate는 null (fail-soft)', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('db gone')
        },
      },
    } as unknown as DecryptHealthEnv
    await expect(getLastDecryptHealthDate(env)).resolves.toBeNull()
  })
})
