/// <reference types="jest" />
/**
 * mcp/tools.ts 커버리지 보강 — executeMemoSearch의 trigram 폴백
 * (기존 tests/mcp-tools.test.ts는 실제 FTS·trigram 성공 경로만 다루고,
 * 0059 미적용 DB 등 trigram 조회 실패 시 빈 결과로 폴백하는 성질은 미검증)
 */
import { executeMemoSearch } from '../../src/modules/mcp/tools'

jest.mock('../../src/services/ai-access', () => ({
  searchAccessibleMemos: jest.fn().mockResolvedValue([]),
}))

const CTX = { userId: 'u', requestId: 'r', approvedWrites: false } as any

describe('executeMemoSearch — trigram 폴백', () => {
  test('trigram 조회가 DB 오류로 실패하면 예외 없이 빈 결과를 반환한다', async () => {
    const throwingDb = {
      prepare() {
        throw new Error('no such table: memos_fts_tri')
      },
    }
    // '서울여행'은 공백 제거 후 4글자라 trigramQuery가 질의를 만든다
    const r = await executeMemoSearch({ query: '서울여행', limit: 5 }, CTX, { DB: throwingDb } as any)
    expect(r).toEqual({ matches: [] })
  })

  test('짧은 질의(3글자 미만)는 trigram 단계에 진입하지 않고 빈 결과를 반환한다', async () => {
    const prepare = jest.fn(() => {
      throw new Error('호출되면 안 된다')
    })
    const r = await executeMemoSearch({ query: 'ab', limit: 5 }, CTX, { DB: { prepare } } as any)
    expect(r).toEqual({ matches: [] })
    expect(prepare).not.toHaveBeenCalled()
  })
})
