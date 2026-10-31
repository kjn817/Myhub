/**
 * Memo Target Resolver (81차)
 *
 * "방금 만든 메모", "그 메모" 같은 상대 참조를 서버에서 확정적인 메모 ID로 변환.
 *
 * 설계 원칙 (GPT 80차 자문):
 * - 모델은 작업 의도만 판단 (요약/열기/삭제 등)
 * - 서버가 대상 메모 ID를 확정 (D1 문맥 기반)
 * - 정규식으로 한국어 문자열 치환하지 않음
 * - Legacy/FC 경로가 공통으로 사용
 */

export type MemoTarget =
  | { kind: 'explicit_id'; memoId: number }
  | { kind: 'last_created' }
  | { kind: 'last_target' }
  | { kind: 'selected'; memoId?: number }

export interface MemoTargetContext {
  userId: string
  conversationId: string
  selectedMemoId?: number
}

export interface ResolvedMemoTarget {
  ok: boolean
  memoId?: number
  error?: string
}

/**
 * 메모 대상을 확정적인 ID로 변환
 *
 * 검증:
 * - 메모 존재 여부
 * - 잠금 상태 (잠긴 메모는 제외)
 * - (향후) 사용자 소유권
 */
export async function resolveMemoTarget(
  env: any,
  target: MemoTarget,
  context: MemoTargetContext
): Promise<ResolvedMemoTarget> {
  let memoId: number | null = null

  // 1. 대상 ID 결정
  if (target.kind === 'explicit_id') {
    memoId = target.memoId
  } else if (target.kind === 'selected' && target.memoId) {
    memoId = target.memoId
  } else if (target.kind === 'selected' && context.selectedMemoId) {
    memoId = context.selectedMemoId
  } else {
    // last_created / last_target: D1 문맥에서 조회
    try {
      const { getMemoContext } = await import('./memo-context')
      const memoCtx = await getMemoContext(env, context.userId, context.conversationId)
      if (target.kind === 'last_created') {
        memoId = memoCtx?.last_created_memo_id || null
      } else {
        // last_target (기본값)
        memoId = memoCtx?.last_target_memo_id || memoCtx?.last_created_memo_id || null
      }
    } catch {
      memoId = null
    }

    // 폴백: 문맥에 없으면 최근 생성 메모
    if (!memoId) {
      try {
        const recent = await env.DB.prepare(
          'SELECT id FROM memos WHERE is_locked = 0 ORDER BY id DESC LIMIT 1'
        ).first() as any
        if (recent?.id) memoId = recent.id
      } catch {
        memoId = null
      }
    }
  }

  if (!memoId || typeof memoId !== 'number') {
    return { ok: false, error: 'TARGET_NOT_FOUND' }
  }

  // 2. 메모 존재·잠금 검증
  try {
    const memo = await env.DB.prepare(
      'SELECT id, is_locked FROM memos WHERE id = ?'
    ).bind(memoId).first() as any
    if (!memo) {
      return { ok: false, error: 'MEMO_NOT_FOUND' }
    }
    if (memo.is_locked) {
      return { ok: false, error: 'MEMO_LOCKED' }
    }
  } catch {
    return { ok: false, error: 'DB_ERROR' }
  }

  return { ok: true, memoId }
}

/**
 * 자연어에서 MemoTarget 종류 추론 (서버 측, 정규식 최소화)
 *
 * 주의: 이것은 한국어 문자열 매칭이 아니라, 모델이 반환한
 * 구조화된 의도를 서버가 해석하는 용도. 모델이 "last_created"를
 * 반환하면 서버가 ID를 결정함.
 */
export function inferTargetKind(
  userText: string,
  explicitId?: number
): MemoTarget {
  if (explicitId && typeof explicitId === 'number') {
    return { kind: 'explicit_id', memoId: explicitId }
  }
  // 모델이 구조화된 참조를 반환하지 않은 경우의 폴백
  // 실제 운영에서는 모델이 target 종류를 명시하도록 프롬프트 개선
  return { kind: 'last_target' }
}
