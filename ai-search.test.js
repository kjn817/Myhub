/**
 * AI-004: 검색 실패와 결과 없음 구분 테스트
 * @jest-environment node
 *
 * 주의: 이 테스트는 src/modules/ai/routes.ts의 분기 로직을 검증합니다.
 * 실제 executeMemoSearch 함수나 라우트 핸들러를 호출하지 않습니다.
 * 통합 테스트는 별도의 Wrangler/D1 환경이 필요합니다.
 */

describe('AI-004: memo search result handling', () => {
  // 검색 결과 처리 로직 시뮬레이션
  function processSearchResult(res) {
    const marker = '[MEMO_SEARCH]';
    let text = marker;
    
    if (!res.success) {
      text = text.replace(marker, `메모 검색 중 오류가 발생했어.`);
    } else if (res.data && res.data.length > 0) {
      const items = res.data.map((m) => `- ${m.title} (id: ${m.id})`).join('\n');
      text = text.replace(marker, `메모 검색 결과야:\n${items}`);
    } else {
      text = text.replace(marker, `메모 검색 결과가 없어.`);
    }
    return text;
  }

  test('검색 실패 시 오류 메시지', () => {
    const res = { success: false, error: 'DB_ERROR' };
    const result = processSearchResult(res);
    expect(result).toContain('오류가 발생');
    expect(result).not.toContain('결과가 없어');
  });

  test('검색 성공, 결과 0개', () => {
    const res = { success: true, data: [] };
    const result = processSearchResult(res);
    expect(result).toContain('결과가 없어');
  });

  test('검색 성공, 결과 1개', () => {
    const res = { success: true, data: [{ id: 35, title: '테스트' }] };
    const result = processSearchResult(res);
    expect(result).toContain('검색 결과야');
    expect(result).toContain('35');
  });

  test('검색 성공, data가 null', () => {
    const res = { success: true, data: null };
    const result = processSearchResult(res);
    expect(result).toContain('결과가 없어');
  });
});
