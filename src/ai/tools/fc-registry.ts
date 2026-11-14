/**
 * Function Calling 경로의 도구 레지스트리 팩토리 (S2-3, 2026-11-14).
 *
 * function-calling-route.ts 안에 있던 클로저를 공유 모듈로 뺀 것이다.
 * 실제 FC 경로와 디버그 엔드포인트(GET /api/ai/tools)가 같은 팩토리를
 * 읽으므로, 등록 도구 목록이 두 곳에서 어긋나지 않는다.
 *
 * 죽은 간이 레지스트리(src/services/tools.ts)와는 무관하다 — D2 결정
 * (2026-11-14)으로 tools-builtin이 삭제됐고, 간이 레지스트리를 되살리거나
 * 연결하지 않는다.
 */
import { ToolRegistry } from './registry'
import { SearchMemoDefinition, SearchMemoInputSchema, executeSearchMemo } from './search-memo'

export function createFCToolRegistry(db: D1Database): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(
    SearchMemoDefinition,
    SearchMemoInputSchema,
    async (args: unknown, ctx: any) => {
      const parsed = SearchMemoInputSchema.safeParse(args)
      if (!parsed.success) {
        return { ok: false as const, errorCode: 'INVALID_ARGUMENTS', message: 'Invalid arguments' }
      }
      const result = await executeSearchMemo(parsed.data, ctx, { DB: db })
      return { ok: true as const, data: result }
    },
  )
  return registry
}
