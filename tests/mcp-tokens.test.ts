/**
 * MCP 토큰 수명주기 테스트 (Jest + 실제 SQLite).
 *
 * hand-rolled mock이 아니라 better-sqlite3 인메모리 DB에 마이그레이션
 * 0060을 그대로 적용하고, 실제 WebCrypto SHA-256으로 검증한다:
 * - 발급 → 검증 왕복, 평문은 DB에 절대 저장되지 않음 (해시만)
 * - 폐기 → 검증 실패, 타인 토큰 폐기 불가, 상한 10개
 * - 해시는 결정적이고 SHA-256 알려진 벡터와 일치한다
 */
import { createHash } from 'crypto'
import {
  generateMcpToken,
  hashMcpToken,
  issueMcpToken,
  verifyMcpToken,
  listMcpTokens,
  revokeMcpToken,
  MAX_ACTIVE_MCP_TOKENS,
} from '../src/modules/mcp/tokens'
import { createTestDb } from './mcp-d1'

describe('MCP 토큰 (실제 SQLite + WebCrypto)', () => {
  it('generateMcpToken: mcp_ + base64url 43자, 매번 다르다', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const t = generateMcpToken()
      expect(t).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/)
      expect(t).toHaveLength(47)
      seen.add(t)
    }
    expect(seen.size).toBe(100)
  })

  it('hashMcpToken: 결정적 SHA-256 hex 64자, node crypto 벡터와 일치', async () => {
    const token = 'mcp_test_fixed_value_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const expected = createHash('sha256').update(token).digest('hex')
    expect(await hashMcpToken(token)).toBe(expected)
    expect(await hashMcpToken(token)).toBe(await hashMcpToken(token))
    expect(await hashMcpToken(token + 'x')).not.toBe(expected)
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
  })

  it('발급 → 검증 왕복, last_used_at이 갱신된다', async () => {
    const { db, d1 } = createTestDb()
    const issued = await issueMcpToken(d1, 'user@myhub.local', '테스트 토큰')
    expect(issued).not.toBeNull()
    expect(issued!.id).toBeGreaterThan(0)
    expect(issued!.token).toMatch(/^mcp_/)
    expect(issued!.label).toBe('테스트 토큰')
    expect(issued!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const verified = await verifyMcpToken(d1, issued!.token)
    expect(verified).toEqual({ id: issued!.id, email: 'user@myhub.local', label: '테스트 토큰' })

    const row = db
      .prepare('SELECT last_used_at FROM mcp_tokens WHERE id = ?')
      .get(issued!.id) as { last_used_at: string | null }
    expect(row.last_used_at).not.toBeNull()
  })

  it('평문 토큰은 DB 어디에도 저장되지 않는다 — 해시만 저장', async () => {
    const { db, d1 } = createTestDb()
    const issued = await issueMcpToken(d1, 'user@myhub.local', '평문 비노출')
    const row = db
      .prepare('SELECT * FROM mcp_tokens WHERE id = ?')
      .get(issued!.id) as Record<string, unknown>
    // 저장된 해시는 평문 토큰의 SHA-256과 일치한다
    expect(row.token_hash).toBe(await hashMcpToken(issued!.token))
    // 행 전체를 문자열로 만들어도 평문 토큰은 나오지 않는다
    expect(JSON.stringify(row)).not.toContain(issued!.token)
    expect(JSON.stringify(row)).not.toContain('mcp_')
  })

  it('잘못된 토큰·형식 오류는 전부 null (fail-closed)', async () => {
    const { d1 } = createTestDb()
    const issued = await issueMcpToken(d1, 'user@myhub.local', '기준 토큰')
    expect(issued).not.toBeNull()
    // 존재하지 않는 토큰
    expect(await verifyMcpToken(d1, generateMcpToken())).toBeNull()
    // mcp_ 접두사 없음
    expect(await verifyMcpToken(d1, 'not-a-token')).toBeNull()
    // 빈 문자열·공백
    expect(await verifyMcpToken(d1, '')).toBeNull()
    expect(await verifyMcpToken(d1, '   ')).toBeNull()
    // 평문 토큰의 일부만 (접두사 잘림)
    expect(await verifyMcpToken(d1, issued!.token.slice(0, 20))).toBeNull()
    // 해시 값을 그대로 Bearer로 보내도 안 된다
    expect(await verifyMcpToken(d1, (await hashMcpToken(issued!.token)) as string)).toBeNull()
  })

  it('폐기하면 검증이 실패하고, 목록에는 revoked_at이 찍힌다', async () => {
    const { d1 } = createTestDb()
    const a = await issueMcpToken(d1, 'user@myhub.local', 'A')
    const b = await issueMcpToken(d1, 'user@myhub.local', 'B')
    expect(await revokeMcpToken(d1, a!.id, 'user@myhub.local')).toBe(true)
    // 폐기된 토큰은 검증 실패
    expect(await verifyMcpToken(d1, a!.token)).toBeNull()
    // 살아있는 토큰은 그대로 검증된다
    expect(await verifyMcpToken(d1, b!.token)).not.toBeNull()
    // 두 번 폐기는 두 번째가 false (이미 폐기됨)
    expect(await revokeMcpToken(d1, a!.id, 'user@myhub.local')).toBe(false)
    // 없는 id 폐기는 false
    expect(await revokeMcpToken(d1, 99999, 'user@myhub.local')).toBe(false)
    // 타인 소유 토큰은 폐기 불가
    expect(await revokeMcpToken(d1, b!.id, 'other@myhub.local')).toBe(false)
    expect(await verifyMcpToken(d1, b!.token)).not.toBeNull()

    const list = await listMcpTokens(d1, 'user@myhub.local')
    expect(list).toHaveLength(2)
    const revokedRow = list.find((t) => t.id === a!.id)!
    expect(revokedRow.revoked_at).not.toBeNull()
    expect(list.find((t) => t.id === b!.id)!.revoked_at).toBeNull()
  })

  it('목록 응답에는 해시·토큰 값이 없다', async () => {
    const { d1 } = createTestDb()
    const issued = await issueMcpToken(d1, 'user@myhub.local', '목록 확인')
    const list = await listMcpTokens(d1, 'user@myhub.local')
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]).sort()).toEqual([
      'created_at',
      'id',
      'label',
      'last_used_at',
      'revoked_at',
    ])
    expect(JSON.stringify(list)).not.toContain(issued!.token)
    expect(JSON.stringify(list)).not.toContain(await hashMcpToken(issued!.token))
  })

  it('활성 토큰 상한 10개 — 11번째 발급은 null, 폐기 후 다시 발급된다', async () => {
    const { d1 } = createTestDb()
    expect(MAX_ACTIVE_MCP_TOKENS).toBe(10)
    const ids: number[] = []
    for (let i = 0; i < 10; i++) {
      const issued = await issueMcpToken(d1, 'user@myhub.local', `토큰 ${i}`)
      expect(issued).not.toBeNull()
      ids.push(issued!.id)
    }
    expect(await issueMcpToken(d1, 'user@myhub.local', '초과')).toBeNull()
    // 폐기한 자리는 다시 발급된다 (상한은 활성 기준)
    expect(await revokeMcpToken(d1, ids[0], 'user@myhub.local')).toBe(true)
    expect(await issueMcpToken(d1, 'user@myhub.local', '재발급')).not.toBeNull()
    // 다른 사용자의 상한은 별개
    expect(await issueMcpToken(d1, 'other@myhub.local', '타인')).not.toBeNull()
  })
})
