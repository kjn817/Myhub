/**
 * ASK 마커 파싱 테스트 (비서 간 호출)
 * @jest-environment node
 */

describe('ASK marker parsing', () => {
  // routes.ts의 정규식과 동일
  const ASK_REGEX = /\[ASK:([a-z_]+)\]([\s\S]*?)\[\/ASK\]/gi;
  
  function parseAskMarkers(text) {
    const markers = [];
    let m;
    ASK_REGEX.lastIndex = 0;
    while ((m = ASK_REGEX.exec(text)) !== null) {
      markers.push({ personaId: m[1], question: m[2].trim() });
    }
    return markers;
  }
  
  test('기본 ASK 파싱', () => {
    const text = '안녕 [ASK:keeper]메모 찾아줘[/ASK] 고마워';
    const markers = parseAskMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].personaId).toBe('keeper');
    expect(markers[0].question).toBe('메모 찾아줘');
  });
  
  test('여러 ASK 파싱', () => {
    const text = '[ASK:keeper]메모[/ASK] 그리고 [ASK:builder]코드[/ASK]';
    const markers = parseAskMarkers(text);
    expect(markers).toHaveLength(2);
  });
  
  test('잘못된 형식 무시 (닫는 태그 없음)', () => {
    const text = '[ASK:keeper]메모 찾아줘';
    const markers = parseAskMarkers(text);
    expect(markers).toHaveLength(0);
  });
  
  test('빈 질문', () => {
    const text = '[ASK:scheduler][/ASK]';
    const markers = parseAskMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].question).toBe('');
  });
  
  test('최대 2개 제한 (구현에서 처리)', () => {
    const text = '[ASK:a]1[/ASK][ASK:b]2[/ASK][ASK:c]3[/ASK]';
    const markers = parseAskMarkers(text);
    // 파싱은 3개 되지만, 실행은 2개로 제한 (routes.ts에서 slice(0,2))
    expect(markers).toHaveLength(3);
    expect(markers.slice(0, 2)).toHaveLength(2);
  });
});
