/// <reference types="jest" />
/**
 * mcp/tokens.ts 커버리지 보강 — verifyMcpToken의 last_used_at best-effort 갱신
 * (기존 tests/mcp-tokens.test.ts는 갱신 성공 왕복만 다루고, 갱신 실패 시
 * 인증이 유지되는 성질은 미검증)
 */
import { verifyMcpToken } from '../../src/modules/mcp/tokens'

function makeTokenDb(opts: { updateThrows: boolean }): any {
  return {
    updateAttempted: false,
    prepare(sql: string) {
      const self = this as any
      return {
        bind(..._p: any[]) {
          return this
        },
        async first() {
          if (sql.includes('FROM mcp_tokens WHERE token_hash')) {
            return { id: 7, email: 'user@example.com', label: '테스트 토큰' }
          }
          return null
        },
        async run() {
          if (sql.includes('SET last_used_at')) {
            self.updateAttempted = true
            if (opts.updateThrows) throw new Error('db down')
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
      }
    },
  }
}

describe('verifyMcpToken — last_used_at 갱신 실패를 무시하고 인증 성공 유지', () => {
  test('UPDATE가 던져도 토큰 검증은 성공한다', async () => {
    const db = makeTokenDb({ updateThrows: true })
    const row = await verifyMcpToken(db, 'mcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(row).toEqual({ id: 7, email: 'user@example.com', label: '테스트 토큰' })
    expect(db.updateAttempted).toBe(true) // 갱신을 시도하긴 했다
  })

  test('UPDATE가 성공하면 같은 결과가 나온다 (대조군)', async () => {
    const db = makeTokenDb({ updateThrows: false })
    const row = await verifyMcpToken(db, 'mcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(row).toEqual({ id: 7, email: 'user@example.com', label: '테스트 토큰' })
    expect(db.updateAttempted).toBe(true)
  })
})
