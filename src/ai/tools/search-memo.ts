/**
 * search_memo 도구 — Phase 1B
 *
 * 인증된 사용자의 메모에서 관련 내용을 검색.
 * 기존 searchAccessibleMemos (src/services/ai-access.ts) 로직 재사용.
 *
 * 보안:
 * - is_locked=1 제외 (AI 접근 불가)
 * - sensitivity 2,3 제외 (외부 AI 전송 불가)
 * - 시크릿 마스킹 적용
 */

import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { searchAccessibleMemos, getAccessibleMemo } from '../../services/ai-access'

// ---------------------------------------------------------------------------
// 입력 스키마
// ---------------------------------------------------------------------------

export const SearchMemoInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1, 'query is required')
      .max(120, 'query too long'),
    limit: z.number().int().min(1).max(5).default(3),
  })
  .strict() // 추가 필드 거부

export type SearchMemoInput = z.infer<typeof SearchMemoInputSchema>

// ---------------------------------------------------------------------------
// 도구 정의
// ---------------------------------------------------------------------------

export const SearchMemoDefinition: ToolDefinition = {
  name: 'search_memo',
  description:
    'Search the authenticated user\'s memos for relevant content. Returns matching memos with title, excerpt, and date.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (1-120 characters)',
        minLength: 1,
        maxLength: 120,
      },
      limit: {
        type: 'number',
        description: 'Maximum results (1-5, default 3)',
        minimum: 1,
        maximum: 5,
        default: 3,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  mode: 'read',
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type SearchMemoResult = {
  matches: Array<{
    id: number
    title: string
    excerpt: string
  }>
}

/**
 * search_memo 실행.
 * - query, limit은 Zod 검증 완료된 값
 * - userId는 ExecutionContext에서 (현재 단일 사용자 시스템이므로 미사용, 향후 확장용)
 * - DB 검색은 searchAccessibleMemos 재사용 (잠금/민감도/마스킹 처리됨)
 */
export async function executeSearchMemo(
  args: SearchMemoInput,
  ctx: { userId: string },
  env: { DB: D1Database }
): Promise<SearchMemoResult> {
  // 77차: "방금 만든" 같은 상대 참조는 최근 메모로 해석.
  // P1-1 (2026-10-28): 과거에는 여기서 원문을 직접 SELECT해 반환해
  // 민감도·마스킹 경계를 통째로 우회했다. 이제는 ID만 조회하고 본문은
  // getAccessibleMemo 경유로 가져온다 (is_locked=0, sensitivity<=1,
  // 잠긴 블록 제거, 시크릿 마스킹 — 레거시 executeMemoGet과 동일 수준).
  // 접근 불가(민감도 2·잠금)면 존재 여부를 숨기고 일반 검색으로 폴백한다.
  const query = args.query || ''
  if (query.includes('방금') || query.includes('그 메모') || query.includes('이 메모')) {
    try {
      const recent = await env.DB.prepare(
        `SELECT id FROM memos WHERE is_locked = 0 ORDER BY id DESC LIMIT 1`
      ).first() as any
      if (recent?.id) {
        const memo = await getAccessibleMemo(env, recent.id)
        if (memo) {
          return {
            matches: [{
              id: memo.id,
              title: memo.title || '(제목 없음)',
              excerpt: memo.content.slice(0, 200),
            }]
          }
        }
      }
    } catch { /* 폴백 */ }
  }

  // 기존 AI 접근 계층 재사용 (잠금, 민감도, 마스킹 처리)
  const results = await searchAccessibleMemos(env, args.query, args.limit)

  // 결과 변환 (필요한 필드만)
  const matches = results.map((r: any) => ({
    id: r.id,
    title: r.title || '(제목 없음)',
    excerpt: (r.snippet || '').slice(0, 200),
  }))

  return { matches }
}
