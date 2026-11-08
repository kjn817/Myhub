/**
 * 메모 대화 문맥 저장소 (65차)
 *
 * "방금 만든 메모", "그 메모" 같은 문맥 참조를 위해
 * 최근 성공한 도구 실행의 메모 ID를 D1에 저장합니다.
 *
 * Workers는 여러 isolate에서 실행되므로 메모리 상태가 아닌 D1을 사용합니다.
 */

export interface MemoContext {
  user_id: string
  conversation_id: string
  last_created_memo_id: number | null
  last_target_memo_id: number | null
  last_search_result_ids: number[]
  revision: number
  updated_at: string
  expires_at: string | null
}

const CONTEXT_TTL_HOURS = 24

/**
 * 문맥 조회
 */
export async function getMemoContext(
  env: any,
  userId: string,
  conversationId: string
): Promise<MemoContext | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT user_id, conversation_id, last_created_memo_id, last_target_memo_id,
              last_search_result_ids, revision, updated_at, expires_at
       FROM memo_conversation_context
       WHERE user_id = ? AND conversation_id = ?`
    ).bind(userId, conversationId).first()

    if (!row) return null

    // 만료 확인
    if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
      return null
    }

    return {
      user_id: row.user_id as string,
      conversation_id: row.conversation_id as string,
      last_created_memo_id: row.last_created_memo_id as number | null,
      last_target_memo_id: row.last_target_memo_id as number | null,
      last_search_result_ids: row.last_search_result_ids
        ? JSON.parse(row.last_search_result_ids as string)
        : [],
      revision: row.revision as number,
      updated_at: row.updated_at as string,
      expires_at: row.expires_at as string | null,
    }
  } catch {
    return null
  }
}

/**
 * 문맥 업데이트 (성공한 도구 실행 후에만 호출)
 *
 * @param updates - 업데이트할 필드 (last_created_memo_id 등)
 * @param expectedRevision - 동시성 제어용 (선택)
 */
export async function updateMemoContext(
  env: any,
  userId: string,
  conversationId: string,
  updates: {
    last_created_memo_id?: number | null
    last_target_memo_id?: number | null
    last_search_result_ids?: number[]
  },
  expectedRevision?: number
): Promise<boolean> {
  try {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + CONTEXT_TTL_HOURS * 3600 * 1000).toISOString()

    const existing = await getMemoContext(env, userId, conversationId)

    if (existing) {
      // 동시성 검사
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        return false
      }

      const newRevision = existing.revision + 1
      await env.DB.prepare(
        `UPDATE memo_conversation_context
         SET last_created_memo_id = COALESCE(?, last_created_memo_id),
             last_target_memo_id = COALESCE(?, last_target_memo_id),
             last_search_result_ids = COALESCE(?, last_search_result_ids),
             revision = ?,
             updated_at = ?,
             expires_at = ?
         WHERE user_id = ? AND conversation_id = ?`
      ).bind(
        updates.last_created_memo_id ?? null,
        updates.last_target_memo_id ?? null,
        updates.last_search_result_ids ? JSON.stringify(updates.last_search_result_ids) : null,
        newRevision,
        now,
        expiresAt,
        userId,
        conversationId
      ).run()
    } else {
      // 새로 생성
      await env.DB.prepare(
        `INSERT INTO memo_conversation_context
         (user_id, conversation_id, last_created_memo_id, last_target_memo_id,
          last_search_result_ids, revision, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(
        userId,
        conversationId,
        updates.last_created_memo_id ?? null,
        updates.last_target_memo_id ?? null,
        updates.last_search_result_ids ? JSON.stringify(updates.last_search_result_ids) : null,
        now,
        expiresAt
      ).run()
    }

    return true
  } catch {
    return false
  }
}

/**
 * 문맥에서 참조할 메모 ID 결정
 *
 * 우선순위:
 * 1. 명시된 ID (사용자가 직접 지정)
 * 2. UI에서 선택한 메모 (별도 전달)
 * 3. 최근 성공한 작업 대상
 * 4. 유일한 검색 결과
 */
export function resolveContextMemoId(
  ctx: MemoContext | null,
  explicitId?: number,
  uiSelectedId?: number
): number | null {
  // 1. 명시된 ID
  if (explicitId && typeof explicitId === 'number') {
    return explicitId
  }

  // 2. UI 선택
  if (uiSelectedId && typeof uiSelectedId === 'number') {
    return uiSelectedId
  }

  if (!ctx) return null

  // 3. 최근 작업 대상 (생성 > 타겟)
  if (ctx.last_created_memo_id) {
    return ctx.last_created_memo_id
  }
  if (ctx.last_target_memo_id) {
    return ctx.last_target_memo_id
  }

  // 4. 유일한 검색 결과
  if (ctx.last_search_result_ids.length === 1) {
    return ctx.last_search_result_ids[0]
  }

  return null
}
