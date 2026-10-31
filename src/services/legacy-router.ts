/**
 * 라우터 인터페이스 — 사용자 요청을 담당 비서에게 배정
 *
 * 나중에 무료 의사결정 API(라야 등)를 연결할 수 있도록 인터페이스만 분리.
 * 현재는 키워드 기반 구현 사용. 외부 API 의존성 없음.
 */

export interface RouteContext {
  /** 이전 대화 요약 (있으면) */
  historySummary?: string
  /** 클라이언트가 제안한 비서 ID (힌트) */
  suggestedPersonaId?: string
}

export interface RouterDecision {
  /** 주 담당 비서 ID */
  primary: string
  /** 협업이 필요한 추가 비서 ID (최대 1명) */
  collaborator?: string
  /** 선택 이유 (로깅용) */
  reason: string
  /** 신뢰도 0-1 */
  confidence: number
}

export interface Router {
  route(text: string, ctx?: RouteContext): Promise<RouterDecision>
  /** 협업이 필요한지 판단 */
  needsCollaboration(text: string, primaryAnswer: string, primaryId: string): Promise<{ needed: boolean; collaborator?: string; reason: string }>
}

// 유효한 비서 ID 목록
export const VALID_PERSONA_IDS = ['concierge', 'keeper', 'builder', 'scheduler'] as const

export function isValidPersonaId(id: string): boolean {
  return (VALID_PERSONA_IDS as readonly string[]).includes(id)
}

/**
 * 키워드 기반 라우터 — 기존 chat.html routeMessage 로직의 서버 측 이식
 * 외부 의존성 없음, 결정적 동작
 */
export class KeywordRouter implements Router {
  private novaKw = ['코드', '만들어', '버그', '함수', '개발', '프로그램', '테트리스', '게임', '모듈', 'api']
  private echoKw = ['메모', '기억', '요약', '정리해', '잊지마', '기록']
  private caliKw = ['일정', '스케줄', '할일', '할 일', '약속', '예약', '캘린더', '리마인드', '미리알림', '치과', '병원', '회의']

  async route(text: string, ctx?: RouteContext): Promise<RouterDecision> {
    // @멘션 우선
    const mention = text.match(/@(\S+)/)
    if (mention) {
      const name = mention[1]
      const idMap: Record<string, string> = {
        '루미': 'concierge', 'concierge': 'concierge',
        '에코': 'keeper', 'keeper': 'keeper',
        '노바': 'builder', 'builder': 'builder',
        '캘리': 'scheduler', 'scheduler': 'scheduler',
      }
      const id = idMap[name]
      if (id && isValidPersonaId(id)) {
        return { primary: id, reason: `mention:@${name}`, confidence: 1.0 }
      }
    }

    const t = text.toLowerCase()
    const matches = {
      builder: this.novaKw.filter(k => t.includes(k)),
      keeper: this.echoKw.filter(k => t.includes(k)),
      scheduler: this.caliKw.filter(k => t.includes(k)),
    }

    // 복합 업무 감지: 2개 이상 분야의 키워드가 있으면 협업 후보
    const matchedIds = (Object.keys(matches) as Array<keyof typeof matches>)
      .filter(id => matches[id].length > 0)

    if (matchedIds.length >= 2) {
      // 첫 번째를 주 담당, 두 번째를 협업자로
      const [primary, collaborator] = matchedIds
      return {
        primary,
        collaborator,
        reason: `multi-domain:${matchedIds.join('+')}`,
        confidence: 0.8,
      }
    }

    if (matchedIds.length === 1) {
      return {
        primary: matchedIds[0],
        reason: `keyword:${matches[matchedIds[0]].join(',')}`,
        confidence: 0.9,
      }
    }

    // 클라이언트 힌트 사용
    if (ctx?.suggestedPersonaId && isValidPersonaId(ctx.suggestedPersonaId)) {
      return {
        primary: ctx.suggestedPersonaId,
        reason: 'client-hint',
        confidence: 0.6,
      }
    }

    // 기본: 루미
    return { primary: 'concierge', reason: 'default', confidence: 0.5 }
  }

  async needsCollaboration(
    _text: string,
    _primaryAnswer: string,
    _primaryId: string
  ): Promise<{ needed: boolean; collaborator?: string; reason: string }> {
    // 키워드 라우터는 1차 라우팅 시점에 이미 협업을 결정하므로,
    // 사후 협업 판단은 하지 않음 (불필요한 호출 방지)
    return { needed: false, reason: 'keyword-router: decided at route time' }
  }
}
