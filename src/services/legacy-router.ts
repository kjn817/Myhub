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

import { PERSONA_REGISTRY, isValidPersonaId as isRegistryValidPersonaId } from '../ai/persona-registry'

// 유효한 비서 ID 목록
export const VALID_PERSONA_IDS = Object.keys(PERSONA_REGISTRY)

export function isValidPersonaId(id: string): boolean {
  return isRegistryValidPersonaId(id)
}

/**
 * 키워드 기반 라우터 — 기존 chat.html routeMessage 로직의 서버 측 이식
 * 외부 의존성 없음, 결정적 동작
 */
export class KeywordRouter implements Router {
  private novaKw = ['코드', '만들어', '버그', '함수', '개발', '프로그램', '테트리스', '게임', '모듈', 'api']
  private echoKw = ['메모', '기억', '요약', '정리해', '잊지마', '기록']
  private caliKw = ['일정', '스케줄', '할일', '할 일', '약속', '예약', '캘린더', '리마인드', '미리알림', '치과', '병원', '회의']
  // 실시간 외부 정보 키워드 — "날씨 정리해줘" 같은 요청이 '정리해'/'요약'
  // 때문에 에코(메모)로 오분류되는 것을 막는다 (2026-11-16 날씨 조사).
  // '메모'/'기억'/'기록'처럼 메모 대상을 명시하는 키워드가 함께 있으면
  // 메모 요청으로 보고 예외를 적용하지 않는다 ("날씨 메모 정리해줘" → 에코).
  private realtimeKw = ['날씨', '뉴스', '주가', '주식', '가격', '환율', '환전', '시세', '코인', '비트코인', '기온', '미세먼지', '예보', '속보']
  private memoTargetKw = ['메모', '기억', '잊지마', '기록']

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
    const realtimeHits = this.realtimeKw.filter(k => t.includes(k))
    const hasMemoTarget = this.memoTargetKw.some(k => t.includes(k))
    // 실시간 외부 정보 질의: 메모 대상이 없으면 에코 후보에서 제외한다.
    const isRealtimeQuery = realtimeHits.length > 0 && !hasMemoTarget
    const matches = {
      builder: this.novaKw.filter(k => t.includes(k)),
      keeper: isRealtimeQuery ? [] : this.echoKw.filter(k => t.includes(k)),
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

    // 실시간 외부 정보 질의는 클라이언트 힌트보다 우선해 루미로 보낸다.
    // (프론트도 같은 예외를 적용하지만, 구 버전 캐시나 직접 호출이
    // 에코 힌트를 보낼 수 있으므로 서버가 최종 판정한다.)
    if (isRealtimeQuery) {
      return {
        primary: 'concierge',
        reason: `realtime:${realtimeHits.join(',')}`,
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
