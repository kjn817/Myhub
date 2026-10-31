/**
 * AI-002 테스트용 Worker - 로컬 전용
 * 실제 searchAccessibleMemos와 executeMemoSearch를 테스트
 * 
 * 이 파일은 로컬 테스트용이며 스테이징/운영에 배포하지 않음
 */
import { searchAccessibleMemos } from '../../src/services/ai-access';
import { executeMemoSearch } from '../../src/services/memo-tools';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/test/search') {
      const query = url.searchParams.get('q') || '팔팔차테스트';
      
      try {
        // 실제 함수 호출
        const direct = await searchAccessibleMemos(env, query, 5);
        const wrapped = await executeMemoSearch(env, query);
        
        return Response.json({
          query,
          direct: {
            count: direct.length,
            ids: direct.map((m: any) => m.id),
          },
          wrapped: {
            success: wrapped.success,
            count: wrapped.data?.length || 0,
            ids: wrapped.data?.map((m: any) => m.id) || [],
          },
        });
      } catch (e: any) {
        return Response.json({ error: e.message }, 500);
      }
    }
    
    return Response.json({ error: 'not found' }, 404);
  }
};
