/**
 * AI-004: 검색 응답 조립 공유 모듈
 * 
 * 프로덕션 라우트(src/modules/ai/routes.ts)와 테스트 Worker가
 * 동일한 함수를 사용하도록 분리.
 */

/**
 * 검색 마커를 실제 검색 결과로 교체
 * 
 * @param text - 원본 텍스트 (AI 모델 출력)
 * @param marker - 검색 마커 {full, query}
 * @param searchResult - executeMemoSearch 결과 {success, data}
 * @param sanitizeFn - 삽입 데이터 정제 함수
 * @returns 처리된 텍스트
 */
export function processSearchMarker(
  text: string,
  marker: { full: string; query: string },
  searchResult: { success: boolean; data?: Array<{ id: number; title: string; snippet: string }> },
  sanitizeFn: (s: string) => string
): string {
  if (!searchResult.success) {
    // 검색 실행 실패: 결과 없음과 구분
    return text.replace(marker.full, `메모 검색 중 오류가 발생했어.`);
  }
  
  if (searchResult.data && searchResult.data.length > 0) {
    const items = searchResult.data
      .map((m) => `- ${m.title} (id: ${m.id})\n  ${m.snippet}`)
      .join('\n');
    const resultText = `메모 검색 결과야:\n${sanitizeFn(items)}`;
    
    // AI-004: 검색 상태 문장을 서버 결과로 대체
    // 패턴: "검색 결과가 없...", "찾은 메모가 없...", "메모가 없..." 등
    const markerPos = text.indexOf(marker.full);
    if (markerPos >= 0) {
      const searchStart = Math.max(0, markerPos - 100);
      const beforeText = text.substring(searchStart, markerPos);
      const statusPattern = /([^.!?]*((검색\s*결과가?\s*없)|(찾은\s*메모가?\s*없)|(메모가?\s*없))[^.!?]*[.!?])\s*$/;
      const match = beforeText.match(statusPattern);
      if (match) {
        const fullMatchStart = searchStart + (match.index || 0);
        return text.substring(0, fullMatchStart) + 
               resultText + 
               text.substring(markerPos + marker.full.length);
      }
    }
    return text.replace(marker.full, resultText);
  }
  
  // 검색 성공, 결과 0개
  return text.replace(marker.full, `메모 검색 결과가 없어.`);
}
