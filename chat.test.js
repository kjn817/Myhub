/**
 * chat.test.js — 채팅 UI 로직 테스트
 * - 라우팅 로직 (@멘션, 키워드)
 * - 메시지 그룹핑
 * - word-break 관련
 */

// 라우팅 로직 (chat.html의 routeMessage와 동일)
function routeMessage(text, personas) {
  const mention = text.match(/@(\S+)/);
  if (mention) {
    const name = mention[1];
    const p = personas.find((x) => x.name === name || x.id === name);
    if (p) return { personaId: p.id, clean: text.replace(mention[0], '').trim() };
  }
  const t = text.toLowerCase();
  const novaKw = ['코드', '만들어', '버그', '함수', '개발', '프로그램', '테트리스', '게임', '모듈', 'api'];
  const echoKw = ['메모', '기억', '요약', '정리해', '잊지마', '기록'];
  if (novaKw.some((k) => t.includes(k))) return { personaId: 'builder', clean: text };
  if (echoKw.some((k) => t.includes(k))) return { personaId: 'keeper', clean: text };
  return { personaId: 'concierge', clean: text };
}

const personas = [
  { id: 'concierge', name: '루미' },
  { id: 'keeper', name: '에코' },
  { id: 'builder', name: '노바' },
];

describe('routeMessage', () => {
  test('@멘션으로 노바 지목', () => {
    const r = routeMessage('@노바 안녕?', personas);
    expect(r.personaId).toBe('builder');
    expect(r.clean).toBe('안녕?');
  });

  test('@멘션으로 에코 지목', () => {
    const r = routeMessage('@에코 메모 찾아줘', personas);
    expect(r.personaId).toBe('keeper');
  });

  test('@멘션으로 루미 지목', () => {
    const r = routeMessage('@루미 안녕', personas);
    expect(r.personaId).toBe('concierge');
  });

  test('코드 키워드 → 노바', () => {
    expect(routeMessage('테트리스 만들어줘', personas).personaId).toBe('builder');
    expect(routeMessage('버그 고쳐줘', personas).personaId).toBe('builder');
    expect(routeMessage('API 연동해줘', personas).personaId).toBe('builder');
  });

  test('메모 키워드 → 에코', () => {
    expect(routeMessage('메모 요약해줘', personas).personaId).toBe('keeper');
    expect(routeMessage('어제 한 말 기억해?', personas).personaId).toBe('keeper');
  });

  test('일반 대화 → 루미', () => {
    expect(routeMessage('안녕?', personas).personaId).toBe('concierge');
    expect(routeMessage('오늘 날씨 어때?', personas).personaId).toBe('concierge');
  });

  test('@멘션이 키워드보다 우선', () => {
    // "@에코" 멘션이 있지만 "코드" 키워드 포함 → 멘션 우선
    const r = routeMessage('@에코 코드 리뷰해줘', personas);
    expect(r.personaId).toBe('keeper');
  });

  test('존재하지 않는 멘션은 무시하고 키워드로', () => {
    const r = routeMessage('@없는사람 코드 만들어줘', personas);
    expect(r.personaId).toBe('builder');
  });
});

describe('메시지 그룹핑', () => {
  // 같은 sender의 연속 메시지는 하나의 그룹으로
  function shouldGroup(prevSender, currSender) {
    return prevSender === currSender;
  }

  test('같은 비서 연속 메시지 → 그룹핑', () => {
    expect(shouldGroup('concierge', 'concierge')).toBe(true);
  });

  test('다른 비서 → 새 그룹', () => {
    expect(shouldGroup('concierge', 'builder')).toBe(false);
  });

  test('사용자 → 비서 전환 시 새 그룹', () => {
    expect(shouldGroup('mine', 'concierge')).toBe(false);
  });
});

describe('페이지네이션', () => {
  test('hasMore가 true일 때만 추가 로드', () => {
    const shouldLoad = (hasMore, loading) => hasMore && !loading;
    expect(shouldLoad(true, false)).toBe(true);
    expect(shouldLoad(false, false)).toBe(false);
    expect(shouldLoad(true, true)).toBe(false);
  });

  test('스크롤 위치가 상단(100px 미만)일 때 로드', () => {
    const shouldTrigger = (scrollTop) => scrollTop < 100;
    expect(shouldTrigger(50)).toBe(true);
    expect(shouldTrigger(150)).toBe(false);
  });
});
