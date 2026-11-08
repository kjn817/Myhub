/**
 * POC 쓰기 도구 `memo.create` — step-up 검증용 최소 구현.
 *
 * D1 `memos`에 직접 INSERT만 한다 (태그 동기화·파일·이벤트 제외).
 * 운영 쓰기 도구는 실제 메모 생성 경로 + 승인 게이트를 재사용해야 하며,
 * 이 스텁을 그대로 운영에 올리지 않는다 (설계 문서 §4).
 * POC 메모는 잠기지 않은 테스트용 메모만 쓴다.
 */

import { z } from 'zod'
import type { ToolDefinition, ExecutionContext } from '../../../src/ai/types'
import { toJsonSchema } from '../../../src/ai/tools/registry'

export const MemoCreateInputSchema = z
  .object({
    text: z.string().trim().min(1, 'text is required').max(2000, 'text too long'),
  })
  .strict()

export type MemoCreateInput = z.infer<typeof MemoCreateInputSchema>

export const MemoCreateDefinition: ToolDefinition = {
  name: 'memo.create',
  description:
    'Create a memo with the given text. Requires mcp:write scope (step-up). Returns the created memo id.',
  parameters: toJsonSchema(MemoCreateInputSchema),
  mode: 'write',
}

export type MemoCreateResult = { id: number }

export async function executeMemoCreate(
  args: MemoCreateInput,
  _ctx: ExecutionContext,
  env: { DB: D1Database }
): Promise<MemoCreateResult> {
  const r = await env.DB.prepare('INSERT INTO memos (text) VALUES (?)')
    .bind(args.text)
    .run()
  return { id: Number((r as any).meta?.last_row_id) }
}
