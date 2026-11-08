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

export function parseExplicitMemoId(userText: string): number | null {
  const t = String(userText || '')
  const patterns = [
    /메모\s*(?:ID|아이디|번호)?\s*[:：#]?\s*(\d{1,10})\s*번/i,
    /메모\s*(?:ID|아이디)\s*[:：]?\s*(\d{1,10})/i,
    /메모\s*#\s*(\d{1,10})/,
    /(\d{1,10})\s*번\s*메모/,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n > 0) return n
    }
  }
  return null
}

export function extractMemoKeywords(text: string): string[] {
  let t = String(text || '')
  t = t.replace(/메모\s*(?:ID|아이디|번호)?\s*[:：#]?\s*\d{1,10}\s*번?/gi, ' ')
  t = t.replace(/\d{1,10}\s*번\s*메모/g, ' ')
  t = t.replace(/메모\s*#\s*\d{1,10}/g, ' ')
  for (const phrase of MEMO_QUERY_SCAFFOLDING) {
    t = t.split(phrase).join(' ')
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of t.replace(/[?!.,·"“”'‘’「」()<>]/g, ' ').split(/\s+/)) {
    let token = raw.trim()
    // 끝 조사 제거 (번들 계약: '도' 포함 — 강원도→강원으로 분리되는 것이 원본 동작).
    if (token.length > 2) token = token.replace(/(은|는|이|가|을|를|의|에|와|과|도|만)$/, '')
    if (token.length < 2) continue
    if (MEMO_ACTION_TOKENS.has(token)) continue
    if (MEMO_SCAFFOLD_TOKENS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= 3) break
  }
  return out
}

export interface MemoToolResultDetail {
  terms?: string[]
  memoId?: number | null
}

export function memoToolResultText(code: string, detail?: MemoToolResultDetail): string {
  switch (code) {
    case 'SEARCH_EMPTY': {
      const terms = (detail?.terms || []).filter(Boolean)
      return terms.length > 0
        ? `검색어 ${terms.map((x) => `"${x}"`).join(', ')}(으)로 접근 가능한 메모를 찾지 못했습니다.`
        : '접근 가능한 메모를 찾지 못했습니다.'
    }
    case 'MEMO_NOT_FOUND':
      return detail?.memoId != null
        ? `메모 ID ${detail.memoId}를 찾지 못했습니다. 존재하지 않거나 접근할 수 없는 메모입니다.`
        : '지정한 메모를 찾지 못했습니다. 존재하지 않거나 접근할 수 없는 메모입니다.'
    case 'MEMO_LOCKED':
      return detail?.memoId != null
        ? `메모 ID ${detail.memoId}는 잠겨 있어 내용을 확인할 수 없습니다.`
        : '지정한 메모는 잠겨 있어 내용을 확인할 수 없습니다.'
    case 'TARGET_NOT_FOUND':
      return '대상 메모를 특정하지 못했습니다.'
    case 'SEARCH_ERROR':
    case 'DB_ERROR':
      return '메모 검색 중 오류가 발생했습니다.'
    default:
      return '메모 검색 결과를 확인하지 못했습니다.'
  }
}

export function buildMemoSearchToolResultMessage(code: string, detail?: MemoToolResultDetail): string {
  return `[서버 제공 도구 결과 - 메모 검색]
결과 코드: ${code}
${memoToolResultText(code, detail)}

위 도구 결과만을 근거로 답하세요. 검색하지 않은 메모가 있다고 단정하거나, 도구 결과에 없는 실패 사유(입력 형식·내용 부족 등)를 만들어내지 마세요. 답변에는 어떤 검색어로 찾았는지 명시하세요.`
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

const MEMO_QUERY_SCAFFOLDING = [
  '내 메모에서', '메모 중에', '메모 중', '메모에서', '메모를', '메모가', '메모',
  '방금 만든', '방금', '포함된', '들어 있는', '들어있는', '포함한', '요약해줘',
  '정리해줘', '찾아줘', '검색해줘', '보여줘', '알려줘', '열어줘', '작성해줘',
  '생성해줘', '만들어줘', '추가해줘', '저장해줘', '요약해', '정리해', '검색해',
  '보여', '알려', '열어', '있나요', '있어', '있나', '있니', '에서', '해줘',
  '해주세요', '주세요', '줘',
]

const MEMO_SCAFFOLD_TOKENS = new Set(['대한', '에게', '관련', '관련된'])

const MEMO_ACTION_TOKENS = new Set(['요약', '정리', '검색', '찾기', '열기'])
