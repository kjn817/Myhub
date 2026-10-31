/**
 * MCP 읽기 도구 5개 — Plan & Execute 도구 정의와 같은 모양
 * (Zod 스키마 + ToolDefinition + ToolExecutor)으로 만든다.
 *
 * - 스키마 → JSON Schema 변환은 src/ai/tools/registry.ts의 toJsonSchema를
 *   그대로 쓴다 (MCP의 inputSchema와 ToolDefinition.parameters가 같은
 *   Zod 스키마에서 나온다 — Plan & Execute가 나중에 이 정의를 그대로
 *   ToolRegistry에 등록해 재사용할 수 있다).
 * - Executor 시그니처는 registry의 ToolExecutor와 동일하다.
 * - 도구 이름은 MCP 스펙이 허용하는 점 표기(`memo.search` — 스펙은
 *   `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`을 허용한다. 단, OpenAI API
 *   브릿지처럼 `^[A-Za-z0-9_-]+$`만 받는 호스트에서는 거부될 수 있다 —
 *   그 경우 snake_case로 바꾸는 것이 후속 결정 사항이다).
 * - 전부 읽기 전용이다 (mode: 'read', MCP annotations readOnlyHint).
 *   쓰기 도구는 만들지 않는다 — 승인 게이트 뒤에 두는 것은 후속 작업.
 *
 * 보안 경계 (서버 단에서 강제 — 클라이언트 선의에 의존하지 않음):
 * - memo.search: searchAccessibleMemos 재사용 (is_locked=1·민감도 2,3 제외,
 *   시크릿 마스킹) + trigram 단계에도 같은 필터를 SQL·코드로 이중 적용.
 * - memory.search: getRelevantMemories 재사용 (v2 플래그·동의 게이트
 *   allow_ai_use/allow_provider_send·인용 잠금 — 대체된 기억은
 *   citable=false로 표시해 사실로 인용 불가).
 */

import { z } from 'zod'
import type { ToolDefinition, ExecutionContext } from '../../ai/types'
import { toJsonSchema } from '../../ai/tools/registry'
import { searchAccessibleMemos } from '../../services/ai-access'
import { maskSecrets } from '../../services/secret-mask'
import { isMemoAccessibleForAI } from '../../services/policy-guard'
import { trigramQuery } from '../memo/routes'
import { listSchedules } from '../schedule/routes'
import { listTodos } from '../todo/routes'
import { getRelevantMemories } from '../../services/memory-service'
import { buildTodayBriefing } from '../briefing/service'
import { createTask, type TaskHandle } from './tasks'

// ---------------------------------------------------------------------------
// memo.search
// ---------------------------------------------------------------------------

export const MemoSearchInputSchema = z
  .object({
    query: z.string().trim().min(1, 'query is required').max(120, 'query too long'),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict()

export type MemoSearchInput = z.infer<typeof MemoSearchInputSchema>

export const MemoSearchDefinition: ToolDefinition = {
  name: 'memo.search',
  description:
    'Search the authenticated user\'s memos for relevant content. Locked memos and highly sensitive memos are never returned. Returns matching memos with id, title, and excerpt.',
  parameters: toJsonSchema(MemoSearchInputSchema),
  mode: 'read',
}

export type MemoSearchResult = {
  matches: Array<{ id: number; title: string; excerpt: string }>
}

function shapeMemoMatch(row: { id: number; title?: string; snippet: string }): {
  id: number
  title: string
  excerpt: string
} {
  const { masked } = maskSecrets(row.snippet || '')
  const title =
    row.title ||
    (masked.split('\n').find((l: string) => l.trim()) || '').slice(0, 50) ||
    '제목 없음'
  return { id: row.id, title, excerpt: masked.slice(0, 200) }
}

export async function executeMemoSearch(
  args: MemoSearchInput,
  _ctx: ExecutionContext,
  env: { DB: D1Database }
): Promise<MemoSearchResult> {
  // 1차: 기존 AI 접근 계층 (FTS5 → 키워드 FTS → LIKE, 잠금·민감도·마스킹 포함).
  // search_memo 도구의 "방금 만든" 상대 참조 해석은 채팅 UX용이라 MCP에서는 제외한다.
  const results = await searchAccessibleMemos(env, args.query, args.limit)
  if (results.length > 0) {
    return { matches: results.map((r) => shapeMemoMatch(r)) }
  }

  // 2차: trigram 부분 검색 (memos_fts_tri, 마이그레이션 0059).
  // - ai-access의 pinned 왕복 상한(최대 3회)을 건드리지 않기 위해
  //   searchAccessibleMemos를 바꾸지 않고 MCP 도구 안에서만 추가한다.
  // - 메모 모듈의 UI 검색과 달리 잠긴 메모·민감도 2,3은 SQL에서 먼저
  //   제외하고, isMemoAccessibleForAI로 코드에서 한 번 더 검사한다.
  // - 0059 미적용 DB에서는 테이블이 없어 throw → 빈 결과로 폴백한다.
  const tq = trigramQuery(args.query)
  if (!tq) return { matches: [] }
  try {
    const { results: tri } = await env.DB.prepare(
      `SELECT m.id, substr(m.text, 1, 500) as snippet, m.sensitivity, m.is_locked
       FROM memos_fts_tri tri JOIN memos m ON m.id = tri.rowid
       WHERE memos_fts_tri MATCH ? AND m.is_locked = 0 AND m.sensitivity <= 1
       ORDER BY m.id DESC LIMIT ?`
    )
      .bind(tq, args.limit)
      .all<{ id: number; snippet: string; sensitivity: number; is_locked: number }>()
    const matches = (tri || []).filter((r) => isMemoAccessibleForAI(r)).map((r) => shapeMemoMatch(r))
    return { matches }
  } catch {
    return { matches: [] }
  }
}

// ---------------------------------------------------------------------------
// schedule.list
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const ScheduleListInputSchema = z
  .object({
    from: z.string().regex(DATE_RE, 'from must be YYYY-MM-DD').optional(),
    to: z.string().regex(DATE_RE, 'to must be YYYY-MM-DD').optional(),
    status: z.enum(['active', 'cancelled', 'done']).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()

export type ScheduleListInput = z.infer<typeof ScheduleListInputSchema>

export const ScheduleListDefinition: ToolDefinition = {
  name: 'schedule.list',
  description:
    'List the authenticated user\'s schedules in a date range (YYYY-MM-DD). Recurring schedules are expanded into occurrences within the range. Returns schedules with id, title, start/end time, location, status, and recurrence info.',
  parameters: toJsonSchema(ScheduleListInputSchema),
  mode: 'read',
}

export type ScheduleListResult = {
  schedules: Array<{
    id: number
    title: string
    description: string
    location: string
    start_at: string
    end_at: string | null
    status: string
    is_recurring: boolean
    original_id: number
    occurrence_date: string
  }>
}

export async function executeScheduleList(
  args: ScheduleListInput,
  _ctx: ExecutionContext,
  env: { DB: D1Database }
): Promise<ScheduleListResult> {
  // GET /api/schedule/list와 같은 조회 (반복 일정 전개 포함).
  const rows = await listSchedules(env.DB, {
    from: args.from,
    to: args.to,
    status: args.status,
    limit: args.limit,
  })
  return {
    schedules: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: (r.description || '').slice(0, 200),
      location: r.location || '',
      start_at: r.start_at,
      end_at: r.end_at,
      status: r.status,
      is_recurring: r.is_recurring,
      original_id: r.original_id,
      occurrence_date: r.occurrence_date,
    })),
  }
}

// ---------------------------------------------------------------------------
// todo.list
// ---------------------------------------------------------------------------

export const TodoListInputSchema = z
  .object({
    status: z.enum(['pending', 'done', 'all']).default('pending'),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()

export type TodoListInput = z.infer<typeof TodoListInputSchema>

export const TodoListDefinition: ToolDefinition = {
  name: 'todo.list',
  description:
    'List the authenticated user\'s todos by status (pending, done, or all). Returns todos with id, title, description, due date, priority, and status.',
  parameters: toJsonSchema(TodoListInputSchema),
  mode: 'read',
}

export type TodoListResult = {
  todos: Array<{
    id: number
    title: string
    description: string
    due_at: string | null
    priority: number
    status: string
    sort_order: number
    created_at: string
    updated_at: string
  }>
}

export async function executeTodoList(
  args: TodoListInput,
  _ctx: ExecutionContext,
  env: { DB: D1Database }
): Promise<TodoListResult> {
  // GET /api/todo/list와 같은 조회.
  const rows = await listTodos(env.DB, { status: args.status, limit: args.limit })
  return {
    todos: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: (r.description || '').slice(0, 500),
      due_at: r.due_at,
      priority: r.priority,
      status: r.status,
      sort_order: r.sort_order,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  }
}

// ---------------------------------------------------------------------------
// memory.search
// ---------------------------------------------------------------------------

export const MemorySearchInputSchema = z
  .object({
    query: z.string().trim().min(2, 'query must be at least 2 characters').max(120, 'query too long'),
    limit: z.number().int().min(1).max(5).default(5),
  })
  .strict()

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>

export const MemorySearchDefinition: ToolDefinition = {
  name: 'memory.search',
  description:
    'Search the authenticated user\'s long-term memories (v2). Only memories the user allowed for AI use and external transfer are returned. Superseded memories are marked superseded and are NOT citable as facts. Returns memories with id, content, category, and citation flags.',
  parameters: toJsonSchema(MemorySearchInputSchema),
  mode: 'read',
}

export type MemorySearchResult = {
  memories: Array<{
    id: number
    content: string
    category: string
    created_at: string | null
    score: number | null
    superseded: boolean
    superseded_by: number | null
    contradiction: boolean
    /** 사실로 인용 가능한가 — 대체된 기억은 false (v2 인용 잠금). */
    citable: boolean
  }>
}

export async function executeMemorySearch(
  args: MemorySearchInput,
  _ctx: ExecutionContext,
  env: { DB: D1Database }
): Promise<MemorySearchResult> {
  // 장기 메모리 v2 검색과 같은 경로 (플래그·동의 게이트·인용 잠금 포함).
  // getRelevantMemories는 반환된 활성 기억의 접근 기록(touch)을 남긴다 —
  // AI 조회와 같은 "사용" 의미로 MCP 조회에도 적용된다.
  const items = await getRelevantMemories(env as any, args.query, args.limit)
  return {
    memories: items.map((m) => {
      // 식은 기억(cold/archived)은 원문 대신 압축 요약을 쓴다
      // (formatMemoryContext와 같은 원칙).
      const content =
        (m.tier === 'cold' || m.tier === 'archived') && m.summary ? m.summary : m.content
      return {
        id: m.id,
        content: (content || '').slice(0, 1000),
        category: m.category,
        created_at: m.createdAt ? String(m.createdAt) : null,
        score: typeof m.score === 'number' ? m.score : null,
        superseded: m.superseded === true,
        superseded_by: m.supersededBy ?? null,
        contradiction: m.contradiction === true,
        citable: m.superseded !== true,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// briefing.generate — Tasks 확장 POC 도구 (아침 브리핑 1건)
//
// - 클라이언트가 Tasks 확장(io.modelcontextprotocol/tasks)을 선언하면
//   태스크 핸들(resultType:'task')을 반환하고, tasks/get 폴링으로 결과를 낸다.
// - 선언하지 않으면(레거시 era 포함) 같은 브리핑을 동기 결과로 낸다.
// - 브리핑 내용은 GET /api/briefing/today와 같은 함수(buildTodayBriefing)라
//   잠금·민감도·동의 필터가 동일하다. 태스크 결과에도 잠긴 메모는 없다.
// ---------------------------------------------------------------------------

export const BriefingGenerateInputSchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
  })
  .strict()

export type BriefingGenerateInput = z.infer<typeof BriefingGenerateInputSchema>

export const BriefingGenerateDefinition: ToolDefinition = {
  name: 'briefing.generate',
  description:
    'Generate the daily briefing for a date (YYYY-MM-DD, default today): today\'s schedules, pending todos, recent unlocked memos, and consented memories. When the client declares the MCP Tasks extension (io.modelcontextprotocol/tasks), returns a task handle instead of the briefing; poll it with tasks/get. Otherwise returns the briefing directly.',
  parameters: toJsonSchema(BriefingGenerateInputSchema),
  mode: 'read',
}

export type BriefingGenerateResult =
  | Awaited<ReturnType<typeof buildTodayBriefing>>
  | TaskHandle

export async function executeBriefingGenerate(
  args: BriefingGenerateInput,
  ctx: ExecutionContext,
  env: { DB: D1Database },
): Promise<BriefingGenerateResult> {
  // Tasks 확장을 선언한 클라이언트에만 태스크 핸들을 반환한다 (스펙 규칙).
  if (ctx.mcpTasksExtension) {
    return createTask(env.DB, ctx.userId, 'briefing.generate', { date: args.date })
  }
  return buildTodayBriefing(env.DB, args.date)
}

// ---------------------------------------------------------------------------
// MCP 도구 등록부 — Plan & Execute 재사용 지점
// ---------------------------------------------------------------------------

export type McpToolEntry = {
  definition: ToolDefinition
  schema: z.ZodType
  /**
   * Zod 검증이 끝난 인자를 받는 typed executor. 호출 전 검증은 호출자가
   * 담당한다 — MCP에서는 SDK가 inputSchema로 검증하고, Plan & Execute에서
   * 재사용할 때는 function-calling-route.ts의 search_memo 래퍼와 같은
   * 방식(schema.safeParse → typed executor)으로 등록한다.
   * (registry의 ToolExecutor는 args: unknown을 받으므로, 래퍼 없이
   * 직접 등록하지 않는다 — 기존 search_memo와 같은 재사용 계약이다.)
   */
  executor: (
    args: any,
    ctx: ExecutionContext,
    env: { DB: D1Database }
  ) => Promise<unknown>
}

/**
 * MCP 도구 5개. McpServer 등록(server.ts)과 Plan & Execute의
 * ToolRegistry 등록이 같은 배열을 쓴다.
 */
export const MCP_TOOLS: McpToolEntry[] = [
  { definition: MemoSearchDefinition, schema: MemoSearchInputSchema, executor: executeMemoSearch },
  { definition: ScheduleListDefinition, schema: ScheduleListInputSchema, executor: executeScheduleList },
  { definition: TodoListDefinition, schema: TodoListInputSchema, executor: executeTodoList },
  { definition: MemorySearchDefinition, schema: MemorySearchInputSchema, executor: executeMemorySearch },
  { definition: BriefingGenerateDefinition, schema: BriefingGenerateInputSchema, executor: executeBriefingGenerate },
]
