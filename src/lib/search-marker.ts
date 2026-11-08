/**
 * 웹검색 마커 정규화 (순수 유틸, DB 의존성 없음)
 *
 * 표준 형식: [SEARCH: 검색어]
 *
 * 모델이 비표준 형식을 출력하면 서버 파서(콜론형만 인식)가 마커를
 * 실행하지 못하고 원문이 사용자에게 그대로 노출된다.
 * (2026-10-21 실측: 루미가 [SEARCH]오늘 아침 주요 뉴스[/SEARCH] 출력 → 누출)
 *
 * 다음 비표준 형식을 표준 형식으로 변환한다:
 * - [SEARCH]검색어[/SEARCH]
 * - [SEARCH]{"query": "검색어"}[/SEARCH]
 * - [WEB_SEARCH]{"query": "검색어"}[/WEB_SEARCH]
 *
 * 안전 규칙:
 * - 변환 대상은 SEARCH/WEB_SEARCH 블록만. 다른 도구 마커는 건드리지 않는다.
 * - 쿼리에 대괄호가 포함되면 변환하지 않는다 (마커 주입·깨진 마커 방지).
 * - 빈 쿼리는 변환하지 않는다.
 */
export function normalizeSearchMarkers(text: string): string {
  if (!text || !text.includes('[')) return text
  let out = text
  // JSON 블록형: [WEB_SEARCH]{"query": "..."}[/WEB_SEARCH], [SEARCH]{"query": "..."}[/SEARCH]
  out = out.replace(
    /\[(WEB_SEARCH|SEARCH)\]\s*\{\s*"query"\s*:\s*"([^"\[\]]+)"\s*\}\s*\[\/\1\]/gi,
    (_m, _tag, q: string) => `[SEARCH: ${String(q).trim()}]`,
  )
  // 평문 블록형: [SEARCH]검색어[/SEARCH]
  out = out.replace(
    /\[SEARCH\]\s*([^\[\]]+?)\s*\[\/SEARCH\]/gi,
    (_m, q: string) => {
      const query = String(q).trim()
      // JSON처럼 보이는 내용은 평문 쿼리로 취급하지 않음 (JSON 단계에서 처리 실패 시 원형 유지)
      if (!query || query.startsWith('{')) return _m
      return `[SEARCH: ${query}]`
    },
  )
  return out
}

/** 표준형(정규화 후) 텍스트에서 첫 번째 검색 쿼리를 추출한다. 없으면 null. */
export function extractSearchQuery(text: string): string | null {
  const m = normalizeSearchMarkers(text).match(/\[SEARCH:\s*([^\]]+)\]/i)
  return m ? m[1].trim() || null : null
}
