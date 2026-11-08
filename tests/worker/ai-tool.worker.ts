/**
 * AI-002 도구 연결 통합 테스트 - 로컬 전용
 * 실제 parseMemoSearchMarkers + executeMemoSearch + 응답 포맷팅 테스트
 */
import { parseMemoSearchMarkers, executeMemoSearch } from '../../src/services/memo-tools';
import { processSearchMarker } from '../../src/services/memo-response';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/test/tool') {
      const testId = url.searchParams.get('id') || 'AI-TOOL-01';
      
      // 테스트 케이스별 AI 출력 시뮬레이션
      const testCases: Record<string, string> = {
        'AI-TOOL-01': '메모를 찾아볼게. [MEMO_SEARCH]{"query":"팔팔차테스트"}[/MEMO_SEARCH]',
        'AI-TOOL-02': '찾아볼게요. [MEMO_SEARCH]{"query":"팔팔차테스트 메모 찾아줘"}[/MEMO_SEARCH]',
        'AI-TOOL-03': '검색해볼게. [MEMO_SEARCH]{"query":"존재하지않는키워드999"}[/MEMO_SEARCH]',
        'AI-TOOL-04': '잘못된 JSON [MEMO_SEARCH]{invalid json[/MEMO_SEARCH]',
        'AI-TOOL-05': '마커 없음, 일반 텍스트만',
        'AI-TOOL-06': '두 개 검색 [MEMO_SEARCH]{"query":"팔팔차테스트"}[/MEMO_SEARCH] 그리고 [MEMO_SEARCH]{"query":"다른키워드"}[/MEMO_SEARCH]',
        'AI-TOOL-07': '검색 결과 확인 [MEMO_SEARCH]{"query":"팔팔차테스트"}[/MEMO_SEARCH]',
        'AI-TOOL-08': '잠금 테스트 [MEMO_SEARCH]{"query":"팔팔차테스트"}[/MEMO_SEARCH]',
        'AI-TOOL-09': '특수문자 [MEMO_SEARCH]{"query":"팔팔차!@#"}[/MEMO_SEARCH]',
        'AI-TOOL-10': '빈 쿼리 [MEMO_SEARCH]{"query":""}[/MEMO_SEARCH]',
        // AI-004 CASE C~F
        'CASE-C': '검색 결과가 없어. [MEMO_SEARCH]{"query":"팔팔차테스트"}[/MEMO_SEARCH] 확인해볼게.',
        'CASE-D': '오류 테스트 [MEMO_SEARCH]{"query":"\\u0000"}[/MEMO_SEARCH]',
        'CASE-E': '첫번째 [MEMO_SEARCH]{"query":"팔팔차테스트"}[/MEMO_SEARCH] 두번째 [MEMO_SEARCH]{"query":"없는키워드"}[/MEMO_SEARCH]',
      };
      
      const aiOutput = testCases[testId] || testCases['AI-TOOL-01'];
      
      try {
        // 1. 마커 파싱 (실제 함수)
        const markers = parseMemoSearchMarkers(aiOutput);
        
        // 2. 각 마커에 대해 검색 실행 (실제 함수 + 프로덕션 로직)
        let resultText = aiOutput;
        const sanitizeFn = (s: string) => s;
        for (const marker of markers) {
          const res = await executeMemoSearch(env, marker.query);
          // 프로덕션과 동일한 공유 함수 사용
          resultText = processSearchMarker(resultText, marker, res, sanitizeFn);
        }
        
        return Response.json({
          testId,
          aiOutput: aiOutput.substring(0, 100),
          markersFound: markers.length,
          queries: markers.map(m => m.query),
          finalResponse: resultText.substring(0, 200),
        });
      } catch (e: any) {
        return Response.json({ testId, error: e.message }, 500);
      }
    }
    
    return Response.json({ error: 'not found' }, 404);
  }
};
